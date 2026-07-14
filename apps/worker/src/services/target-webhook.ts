import type { LineClient } from '@line-crm/line-sdk';
import type { WebhookEvent, TextEventMessage, GroupSource, RoomSource } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  getLineTargetByLineTargetId,
  upsertLineTarget,
  setLineTargetActive,
  logTargetMessage,
  createNotification,
} from '@line-crm/db';

// Re-fetch a group's display name from the summary API at most this often, so a
// rename is picked up on a later message without hitting the API every message.
const NAME_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Group/room ("target") webhook イベント処理。
 *
 * routes/webhook.ts は upstream 変更が集中する hotspot なので、group 処理の
 * 本体はこの service に隔離し、webhook.ts 側には source 判定と 1 回の関数
 * 呼び出しだけを置く（private→OSS 同期の競合面積を抑えるため）。
 *
 * - join: target を登録（グループ名は summary API から best-effort 取得）
 * - leave: target を is_active=0 にする
 * - message: target を登録/更新し、発言者プロフィール付きで
 *   target_messages_log に記録する
 *
 * 自動返信・シナリオは 1:1 friend 専用のまま（P0 スコープ外）。
 */
export async function handleTargetEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null,
  workerUrl?: string,
  r2?: R2Bucket,
): Promise<void> {
  const source = event.source as GroupSource | RoomSource;
  const targetType = source.type;
  const lineTargetId = source.type === 'group' ? source.groupId : source.roomId;
  if (!lineTargetId) return;

  if (event.type === 'leave') {
    // Snapshot before the transition so we can tell whether this leave actually
    // deactivates a currently-active target (redelivered leaves find it already
    // inactive → no duplicate notification).
    const before = await getLineTargetByLineTargetId(db, lineTargetId);
    // event.timestamp guards against out-of-order redelivery; an unregistered
    // target gets an inactive tombstone row so a later stale join cannot
    // register it as active (see setLineTargetActive)
    await setLineTargetActive(db, {
      targetType,
      lineTargetId,
      isActive: false,
      eventTimestamp: event.timestamp,
      lineAccountId,
    });

    // Notify sales when the bot is removed from a target linked to a customer —
    // otherwise no one notices the conversation channel is gone. Only fire on a
    // real active→inactive transition of a linked target.
    const transitioned =
      before?.is_active === 1 &&
      (before.membership_updated_at == null || before.membership_updated_at <= event.timestamp);
    if (transitioned && before) {
      let meta: Record<string, unknown> = {};
      try {
        meta = before.metadata ? (JSON.parse(before.metadata) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      if (typeof meta.salesCustomerPageId === 'string' && meta.salesCustomerPageId) {
        try {
          await createNotification(db, {
            eventType: 'line_target_left',
            title: 'グループ/複数人トークから退出しました',
            body: `公式アカウントが「${before.display_name ?? lineTargetId}」から外れました。担当顧客に紐付いているため、必要なら再招待してください。`,
            channel: 'dashboard',
            metadata: JSON.stringify({
              targetType,
              lineTargetId,
              lineAccountId,
              salesCustomerPageId: meta.salesCustomerPageId,
              salesDealPageId: meta.salesDealPageId ?? null,
            }),
          });
        } catch (err) {
          // Best-effort: a notification failure must not fail webhook processing.
          console.error(`[target] leave notification failed for ${lineTargetId}:`, err);
        }
      }
    }
    console.log(`[target] leave ${targetType}=${lineTargetId}`);
    return;
  }

  if (event.type !== 'join' && event.type !== 'message') return;

  // Register/refresh the target. The group summary fetch is best-effort: run
  // it on join and whenever the stored display name is still unknown. Rooms
  // have no summary API — they keep a null name (API layer serves a fallback).
  const existing = await getLineTargetByLineTargetId(db, lineTargetId);
  let displayName: string | null = null;
  let pictureUrl: string | null = null;
  let nameRefreshedAt: number | undefined;
  // Refresh the group name on join, when it is still unknown, or when the last
  // fetch is stale (the group may have been renamed). Rooms have no summary API.
  const nameStale =
    existing?.name_refreshed_at == null ||
    event.timestamp - existing.name_refreshed_at > NAME_REFRESH_INTERVAL_MS;
  if (targetType === 'group' && (event.type === 'join' || !existing?.display_name || nameStale)) {
    try {
      const summary = await lineClient.getGroupSummary(lineTargetId);
      displayName = summary.groupName ?? null;
      pictureUrl = summary.pictureUrl ?? null;
      nameRefreshedAt = event.timestamp;
    } catch (err) {
      console.error(`[target] group summary fetch failed for ${lineTargetId}:`, err);
    }
  }
  const target = await upsertLineTarget(db, {
    targetType,
    lineTargetId,
    displayName,
    pictureUrl,
    lineAccountId,
    nameRefreshedAt,
  });

  if (event.type === 'join') {
    // Reactivation is timestamp-guarded: a stale join redelivered after a
    // newer leave must not flip a left target back to active. Messages never
    // reactivate (upsertLineTarget does not touch is_active).
    await setLineTargetActive(db, {
      targetType,
      lineTargetId,
      isActive: true,
      eventTimestamp: event.timestamp,
      lineAccountId,
    });
    console.log(`[target] join ${targetType}=${lineTargetId} name=${target.display_name ?? 'unknown'}`);
    return;
  }

  // Attribute the incoming message to the member who sent it (best-effort:
  // member profile is only readable when the user has added/consented to the
  // official account — otherwise we keep the LINE user id alone).
  const senderUserId = source.userId ?? null;
  let senderDisplayName: string | null = null;
  if (senderUserId) {
    try {
      const profile =
        targetType === 'group'
          ? await lineClient.getGroupMemberProfile(lineTargetId, senderUserId)
          : await lineClient.getRoomMemberProfile(lineTargetId, senderUserId);
      senderDisplayName = profile.displayName ?? null;
    } catch {
      // profile unavailable — log with user id only
    }
  }

  const msg = event.message as {
    id: string;
    type: string;
    text?: string;
    fileName?: string;
    title?: string;
    packageId?: string | number;
    stickerId?: string | number;
    stickerResourceType?: string | number;
  };

  let content: string;
  if (msg.type === 'text') {
    content = (event.message as TextEventMessage).text;
  } else {
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    content = labels[msg.type] ?? `[${msg.type}]`;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) content = JSON.stringify(stickerContent);
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const { fetchAndStoreIncomingImage } = await import('./incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: msg.id,
      });
      if (refs) content = JSON.stringify(refs);
    }
  }

  await logTargetMessage(db, {
    targetId: target.id,
    direction: 'incoming',
    messageType: msg.type,
    content,
    senderLineUserId: senderUserId,
    senderDisplayName,
    source: 'user',
    lineAccountId,
    // LINE redelivers webhook events; the message id dedupes repeat deliveries
    lineMessageId: msg.id,
    // real occurrence time — delayed/redelivered webhooks must not reorder
    // the conversation
    occurredAt: event.timestamp,
  });
}
