import { jstNow } from './utils.js';

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
  limit?: number;
  offset?: number;
}

export async function listLineTargets(
  db: D1Database,
  opts: ListLineTargetsOptions = {},
): Promise<{ items: LineTarget[]; total: number }> {
  const { targetType, lineAccountId, includeInactive = false, limit = 50, offset = 0 } = opts;

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
 * Insert or reactivate a group/room target. Existing display_name/picture_url
 * are only overwritten when the input provides a non-null value (group summary
 * fetches are best-effort and must not blank out a previously known name).
 */
export async function upsertLineTarget(
  db: D1Database,
  input: UpsertLineTargetInput,
): Promise<LineTarget> {
  const now = jstNow();
  const existing = await getLineTargetByLineTargetId(db, input.lineTargetId);

  if (existing) {
    await db
      .prepare(
        `UPDATE line_targets
         SET display_name = ?,
             picture_url = ?,
             line_account_id = ?,
             is_active = 1,
             updated_at = ?
         WHERE line_target_id = ?`,
      )
      .bind(
        input.displayName ?? existing.display_name,
        input.pictureUrl ?? existing.picture_url,
        input.lineAccountId ?? existing.line_account_id,
        now,
        input.lineTargetId,
      )
      .run();
    return (await getLineTargetByLineTargetId(db, input.lineTargetId))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, display_name, picture_url, is_active, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .bind(
      id,
      input.targetType,
      input.lineTargetId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.lineAccountId ?? null,
      now,
      now,
    )
    .run();

  return (await getLineTargetById(db, id))!;
}

/** Mark a target inactive (bot left / was removed from the group). */
export async function setLineTargetActive(
  db: D1Database,
  lineTargetId: string,
  isActive: boolean,
): Promise<void> {
  await db
    .prepare(`UPDATE line_targets SET is_active = ?, updated_at = ? WHERE line_target_id = ?`)
    .bind(isActive ? 1 : 0, jstNow(), lineTargetId)
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
}

/** Insert a target message row and bump the target's last_message_at. */
export async function logTargetMessage(
  db: D1Database,
  input: LogTargetMessageInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO target_messages_log (id, target_id, direction, message_type, content, sender_line_user_id, sender_display_name, source, line_account_id, sender_staff_id, sender_name, sender_icon_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
    )
    .run();
  await db
    .prepare(`UPDATE line_targets SET last_message_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, input.targetId)
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
  const sql = before
    ? `SELECT * FROM target_messages_log
       WHERE target_id = ? AND julianday(created_at) < julianday(?)
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM target_messages_log
       WHERE target_id = ?
       ORDER BY created_at DESC LIMIT ?`;
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
