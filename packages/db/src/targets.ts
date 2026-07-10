import { jstNow, toJstString } from './utils.js';

/**
 * LINE group/room conversation target (migration 047).
 *
 * A "target" is a send/receive destination that is not a 1:1 friend: a LINE
 * group or a multi-person room. Rows are registered when the official account
 * joins (join event) or when a message occurs in the group/room. `metadata`
 * is a JSON TEXT column mirroring friends.metadata so external integrations
 * (e.g. sales-harness `sales*` link fields) work identically for friends and
 * group targets.
 */
export interface LineTarget {
  id: string;
  target_type: 'group' | 'room';
  line_target_id: string;
  display_name: string | null;
  picture_url: string | null;
  is_active: number;
  line_account_id: string | null;
  metadata: string | null;
  last_message_at: string | null;
  /**
   * LINE event.timestamp (ms epoch) of the last join/leave applied. Guards
   * membership transitions against out-of-order webhook redelivery: a stale
   * join must not reactivate a target the bot has since left.
   */
  membership_updated_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface TargetMessage {
  id: string;
  target_id: string;
  direction: 'incoming' | 'outgoing';
  message_type: string;
  content: string;
  sender_line_user_id: string | null;
  sender_display_name: string | null;
  source: string | null;
  line_account_id: string | null;
  sender_staff_id: string | null;
  sender_name: string | null;
  sender_icon_url: string | null;
  line_message_id: string | null;
  created_at: string;
}

export async function getLineTargetById(
  db: D1Database,
  id: string,
): Promise<LineTarget | null> {
  return db
    .prepare(`SELECT * FROM line_targets WHERE id = ?`)
    .bind(id)
    .first<LineTarget>();
}

export async function getLineTargetByLineTargetId(
  db: D1Database,
  lineTargetId: string,
): Promise<LineTarget | null> {
  return db
    .prepare(`SELECT * FROM line_targets WHERE line_target_id = ?`)
    .bind(lineTargetId)
    .first<LineTarget>();
}

export interface ListLineTargetsOptions {
  targetType?: 'group' | 'room';
  lineAccountId?: string;
  includeInactive?: boolean;
  /**
   * Exact-match filters on JSON metadata keys, e.g.
   * { salesCustomerPageId: 'notion-page-1' }. Enables the reverse lookup
   * "all targets linked to this customer/deal" — the same contract as the
   * ?metadata.key=value filter on GET /api/friends.
   */
  metadataFilters?: Record<string, string>;
  limit?: number;
  offset?: number;
}

export async function listLineTargets(
  db: D1Database,
  opts: ListLineTargetsOptions = {},
): Promise<{ items: LineTarget[]; total: number }> {
  const { targetType, lineAccountId, includeInactive = false, metadataFilters, limit = 50, offset = 0 } = opts;

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (targetType) {
    conditions.push('target_type = ?');
    binds.push(targetType);
  }
  if (lineAccountId) {
    conditions.push('line_account_id = ?');
    binds.push(lineAccountId);
  }
  if (!includeInactive) {
    conditions.push('is_active = 1');
  }
  for (const [key, value] of Object.entries(metadataFilters ?? {})) {
    conditions.push(`json_extract(metadata, '$.' || ?) = ?`);
    binds.push(key, value);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await db
    .prepare(
      `SELECT * FROM line_targets ${where}
       ORDER BY COALESCE(last_message_at, updated_at) DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<LineTarget>();

  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM line_targets ${where}`)
    .bind(...binds)
    .first<{ total: number }>();

  return { items: result.results, total: countRow?.total ?? 0 };
}

export interface UpsertLineTargetInput {
  targetType: 'group' | 'room';
  lineTargetId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  lineAccountId?: string | null;
}

/**
 * Insert or refresh a group/room target. Existing display_name/picture_url
 * are only overwritten when the input provides a non-null value (group summary
 * fetches are best-effort and must not blank out a previously known name).
 *
 * Single atomic statement: concurrent webhooks for the same unregistered
 * target must not race a SELECT→INSERT pair — the loser's INSERT would hit
 * the line_target_id UNIQUE constraint and drop its event.
 *
 * Deliberately does NOT touch is_active on existing rows: membership is
 * driven by join/leave events via setLineTargetActive, and a redelivered
 * message from before a leave must not reactivate a left target.
 */
export async function upsertLineTarget(
  db: D1Database,
  input: UpsertLineTargetInput,
): Promise<LineTarget> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, display_name, picture_url, is_active, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(line_target_id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, line_targets.display_name),
         picture_url = COALESCE(excluded.picture_url, line_targets.picture_url),
         line_account_id = COALESCE(excluded.line_account_id, line_targets.line_account_id),
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      input.targetType,
      input.lineTargetId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.lineAccountId ?? null,
      now,
      now,
    )
    .run();

  return (await getLineTargetByLineTargetId(db, input.lineTargetId))!;
}

export interface SetLineTargetActiveInput {
  targetType: 'group' | 'room';
  lineTargetId: string;
  isActive: boolean;
  /** LINE event.timestamp (ms) of the join/leave event. */
  eventTimestamp: number;
  lineAccountId?: string | null;
}

/**
 * Apply a join/leave membership transition. LINE may redeliver webhook events
 * out of order, so the transition only applies when `eventTimestamp` is not
 * older than the last applied one — a stale join redelivered after a leave
 * must not flip the target back to active (and re-open the 409 send guard).
 *
 * Single atomic INSERT ... ON CONFLICT: a leave for a target that was never
 * registered (pre-feature groups, concurrent webhooks) writes an inactive
 * tombstone row with the event timestamp. Without it, a later stale join
 * would register the target as active and the ordering guard would have
 * nothing to compare against.
 */
export async function setLineTargetActive(
  db: D1Database,
  input: SetLineTargetActiveInput,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, is_active, line_account_id, membership_updated_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_target_id) DO UPDATE SET
         is_active = CASE
           WHEN line_targets.membership_updated_at IS NULL OR line_targets.membership_updated_at <= excluded.membership_updated_at
           THEN excluded.is_active ELSE line_targets.is_active END,
         membership_updated_at = CASE
           WHEN line_targets.membership_updated_at IS NULL OR line_targets.membership_updated_at <= excluded.membership_updated_at
           THEN excluded.membership_updated_at ELSE line_targets.membership_updated_at END,
         line_account_id = COALESCE(excluded.line_account_id, line_targets.line_account_id),
         updated_at = excluded.updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      input.targetType,
      input.lineTargetId,
      input.isActive ? 1 : 0,
      input.lineAccountId ?? null,
      input.eventTimestamp,
      now,
      now,
    )
    .run();
}

export async function updateLineTargetMetadata(
  db: D1Database,
  id: string,
  metadataJson: string,
): Promise<void> {
  await db
    .prepare(`UPDATE line_targets SET metadata = ?, updated_at = ? WHERE id = ?`)
    .bind(metadataJson, jstNow(), id)
    .run();
}

export interface LogTargetMessageInput {
  targetId: string;
  direction: 'incoming' | 'outgoing';
  messageType: string;
  content: string;
  senderLineUserId?: string | null;
  senderDisplayName?: string | null;
  source?: string | null;
  lineAccountId?: string | null;
  senderStaffId?: string | null;
  senderName?: string | null;
  senderIconUrl?: string | null;
  /**
   * LINE message id of an incoming webhook message. Dedupe key: LINE redelivers
   * webhook events (same message id, deliveryContext.isRedelivery=true), and a
   * UNIQUE index on (target_id, line_message_id) makes the insert idempotent.
   * Outgoing sends leave this null (no dedupe needed).
   */
  lineMessageId?: string | null;
  /**
   * LINE event.timestamp (ms) — when the message actually occurred. Used for
   * created_at / last_message_at so delayed or redelivered webhooks keep the
   * real conversation order instead of surfacing as the newest message.
   * Outgoing sends omit it (send time = occurrence time).
   */
  occurredAt?: number | null;
}

/**
 * Insert a target message row and bump the target's last_message_at.
 * Idempotent for incoming messages: a duplicate (target_id, line_message_id)
 * is ignored and the already-stored row's id is returned.
 */
export async function logTargetMessage(
  db: D1Database,
  input: LogTargetMessageInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const createdAt = input.occurredAt != null ? toJstString(new Date(input.occurredAt)) : now;
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO target_messages_log (id, target_id, direction, message_type, content, sender_line_user_id, sender_display_name, source, line_account_id, sender_staff_id, sender_name, sender_icon_url, line_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.targetId,
      input.direction,
      input.messageType,
      input.content,
      input.senderLineUserId ?? null,
      input.senderDisplayName ?? null,
      input.source ?? null,
      input.lineAccountId ?? null,
      input.senderStaffId ?? null,
      input.senderName ?? null,
      input.senderIconUrl ?? null,
      input.lineMessageId ?? null,
      createdAt,
    )
    .run();

  if (result.meta.changes === 0 && input.lineMessageId) {
    const existing = await db
      .prepare(`SELECT id FROM target_messages_log WHERE target_id = ? AND line_message_id = ?`)
      .bind(input.targetId, input.lineMessageId)
      .first<{ id: string }>();
    if (existing) return existing.id;
  }

  // last_message_at is monotonic: a delayed/redelivered old message must not
  // surface the target as having new activity (timestamps share the same JST
  // ISO format, so string MAX is chronological).
  await db
    .prepare(
      `UPDATE line_targets
       SET last_message_at = CASE
             WHEN last_message_at IS NULL OR last_message_at < ? THEN ? ELSE last_message_at END,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(createdAt, createdAt, now, input.targetId)
    .run();
  return id;
}

export interface GetTargetMessagesOptions {
  limit?: number;
  before?: string | null;
}

export async function getTargetMessages(
  db: D1Database,
  targetId: string,
  opts: GetTargetMessagesOptions = {},
): Promise<TargetMessage[]> {
  const { limit = 50, before = null } = opts;
  // julianday() cursor: preserves sub-second precision and sorts ISO 8601
  // cursors in any timezone form correctly against stored +09:00 timestamps
  // (same rationale as GET /api/conversations/:friendId).
  // `id DESC` tie-breaker: created_at comes from LINE event.timestamp (ms), so
  // simultaneous messages are possible; ordering must stay deterministic
  // across pagination requests.
  const sql = before
    ? `SELECT * FROM target_messages_log
       WHERE target_id = ? AND julianday(created_at) < julianday(?)
       ORDER BY created_at DESC, id DESC LIMIT ?`
    : `SELECT * FROM target_messages_log
       WHERE target_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`;
  const binds: (string | number)[] = before ? [targetId, before, limit] : [targetId, limit];
  const result = await db.prepare(sql).bind(...binds).all<TargetMessage>();
  return result.results;
}

export interface TargetParticipant {
  lineUserId: string;
  displayName: string | null;
  lastSpokeAt: string;
}

/**
 * Participants derived from incoming message senders. LINE only exposes the
 * full member list to verified/premium accounts, so the reliable P0 source is
 * "who has spoken". Returns most-recent speaker first.
 */
export async function getTargetParticipants(
  db: D1Database,
  targetId: string,
): Promise<TargetParticipant[]> {
  const result = await db
    .prepare(
      `SELECT sender_line_user_id AS lineUserId,
              MAX(created_at) AS lastSpokeAt,
              (SELECT t2.sender_display_name FROM target_messages_log t2
                WHERE t2.target_id = t.target_id
                  AND t2.sender_line_user_id = t.sender_line_user_id
                  AND t2.sender_display_name IS NOT NULL
                ORDER BY t2.created_at DESC LIMIT 1) AS displayName
       FROM target_messages_log t
       WHERE target_id = ? AND direction = 'incoming' AND sender_line_user_id IS NOT NULL
       GROUP BY sender_line_user_id
       ORDER BY lastSpokeAt DESC`,
    )
    .bind(targetId)
    .all<TargetParticipant>();
  return result.results;
}
