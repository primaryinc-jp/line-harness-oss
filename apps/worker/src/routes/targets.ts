import { Hono } from 'hono';
import {
  getLineTargetById,
  getLineTargetByLineTargetId,
  listLineTargets,
  updateLineTargetMetadata,
  getTargetMessages,
  getTargetParticipants,
  logTargetMessage,
} from '@line-crm/db';
import type { LineTarget, TargetMessage } from '@line-crm/db';
import { buildMessage, messageToLogPayload } from '../services/step-delivery.js';
import type { Env } from '../index.js';
import { MessageSenderError, resolveMessageSender, type SenderSelection } from '../utils/message-sender.js';

/**
 * Group/room conversation "targets" (P0 group support).
 *
 * A target is a non-1:1 send/receive destination: a LINE group or multi-person
 * room. Friends keep their existing /api/friends surface; these routes expose
 * the same list / detail / metadata / conversation / send operations for
 * group/room targets so external integrations (sales-harness) can treat
 * friends and groups uniformly.
 *
 * :targetId accepts either the harness row id (uuid) or the raw LINE
 * groupId/roomId — external callers usually only know the LINE id.
 */
const targets = new Hono<Env>();

const TARGET_TYPES = ['group', 'room'] as const;
type TargetType = (typeof TARGET_TYPES)[number];

function isTargetType(v: string): v is TargetType {
  return (TARGET_TYPES as readonly string[]).includes(v);
}

/**
 * Parse an integer query param bounded to [min, max]. Returns null on
 * non-integer or out-of-range input so callers can 400 — an unchecked value
 * reaches the SQL LIMIT/OFFSET binds directly (negative LIMIT means
 * "unbounded" in SQLite; NaN is a D1 binding error).
 */
function intParam(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function fallbackDisplayName(row: LineTarget): string {
  const suffix = row.line_target_id.slice(-6);
  return row.target_type === 'group' ? `LINEグループ (${suffix})` : `複数人トーク (${suffix})`;
}

function serializeTarget(row: LineTarget) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.line_target_id,
    displayName: row.display_name ?? fallbackDisplayName(row),
    pictureUrl: row.picture_url,
    isActive: Boolean(row.is_active),
    lineAccountId: row.line_account_id,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeTargetMessage(m: TargetMessage) {
  return {
    id: m.id,
    direction: m.direction,
    messageType: m.message_type,
    content: m.content,
    senderLineUserId: m.sender_line_user_id,
    senderDisplayName: m.sender_display_name,
    source: m.source,
    senderStaffId: m.sender_staff_id,
    senderName: m.sender_name,
    createdAt: m.created_at,
  };
}

/**
 * Optional account-binding assertion for reads. When the caller states which
 * account it expects to own this target (`?lineAccountId=`), reject if
 * ownership has since changed (e.g. account A left and B joined the same group
 * id) so one account's UI never renders another account's thread. Omitted or
 * empty means no assertion (back-compat for SDK/MCP callers).
 */
function assertTargetAccount(requested: string | undefined, owner: string | null): string | null {
  if (requested === undefined || requested === '') return null;
  if (requested !== owner) {
    return 'Target ownership changed for this account; reload before viewing';
  }
  return null;
}

/** Resolve :targetType/:targetId (harness uuid or LINE group/room id). */
async function resolveTarget(
  db: D1Database,
  targetType: string,
  targetId: string,
): Promise<LineTarget | null> {
  const byLineId = await getLineTargetByLineTargetId(db, targetId);
  const target = byLineId ?? (await getLineTargetById(db, targetId));
  if (!target || target.target_type !== targetType) return null;
  return target;
}

// GET /api/targets?type=group|room&lineAccountId=&includeInactive=&limit=&offset=
targets.get('/api/targets', async (c) => {
  try {
    const typeParam = c.req.query('type');
    if (typeParam && !isTargetType(typeParam)) {
      return c.json({ success: false, error: `unsupported target type: ${typeParam}` }, 400);
    }
    const limit = intParam(c.req.query('limit'), 50, 1, 200);
    const offset = intParam(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    if (limit === null || offset === null) {
      return c.json({ success: false, error: 'limit must be an integer 1..200 and offset a non-negative integer' }, 400);
    }

    // Metadata filters: ?metadata.key=value (same contract as GET /api/friends).
    // Lets integrations reverse-look-up "all targets linked to this
    // customer/deal" via ?metadata.salesCustomerPageId=... — needed when one
    // customer has both a 1:1 friend and a group conversation.
    const url = new URL(c.req.url);
    const metadataFilters: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        metadataFilters[key.slice('metadata.'.length)] = value;
      }
    }

    const { items, total } = await listLineTargets(c.env.DB, {
      targetType: typeParam as TargetType | undefined,
      lineAccountId: c.req.query('lineAccountId') || undefined,
      includeInactive: c.req.query('includeInactive') === 'true',
      metadataFilters,
      limit,
      offset,
    });

    return c.json({
      success: true,
      data: {
        items: items.map(serializeTarget),
        total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/targets error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/targets/:targetType/:targetId — detail incl. observed participants
targets.get('/api/targets/:targetType/:targetId', async (c) => {
  try {
    const targetType = c.req.param('targetType');
    if (!isTargetType(targetType)) {
      return c.json({ success: false, error: `unsupported target type: ${targetType}` }, 400);
    }
    const target = await resolveTarget(c.env.DB, targetType, c.req.param('targetId'));
    if (!target) {
      return c.json({ success: false, error: 'Target not found' }, 404);
    }
    const ownershipError = assertTargetAccount(c.req.query('lineAccountId'), target.line_account_id);
    if (ownershipError) return c.json({ success: false, error: ownershipError }, 409);

    // Participants are derived from who has spoken (LINE only exposes full
    // member lists to verified accounts), so this is best-effort by design.
    // Scope to the current owning account so speakers from a previous owner
    // (before a group changed hands) don't appear in this account's view.
    const participants = await getTargetParticipants(c.env.DB, target.id, target.line_account_id);

    return c.json({
      success: true,
      data: {
        ...serializeTarget(target),
        participants,
      },
    });
  } catch (err) {
    console.error('GET /api/targets/:targetType/:targetId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/targets/:targetType/:targetId/metadata - merge metadata fields
// (same merge semantics as PUT /api/friends/:id/metadata)
targets.put('/api/targets/:targetType/:targetId/metadata', async (c) => {
  try {
    const targetType = c.req.param('targetType');
    if (!isTargetType(targetType)) {
      return c.json({ success: false, error: `unsupported target type: ${targetType}` }, 400);
    }
    const db = c.env.DB;
    const target = await resolveTarget(db, targetType, c.req.param('targetId'));
    if (!target) {
      return c.json({ success: false, error: 'Target not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(target.metadata || '{}') as Record<string, unknown>;
    const merged = { ...existing, ...body };
    await updateLineTargetMetadata(db, target.id, JSON.stringify(merged));

    const updated = await getLineTargetById(db, target.id);
    return c.json({ success: true, data: serializeTarget(updated!) });
  } catch (err) {
    console.error('PUT /api/targets/:targetType/:targetId/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/conversations/:targetType/:targetId?limit=&before=&beforeId=
// Group/room conversation thread. Two path segments, so this never collides
// with the friend thread route GET /api/conversations/:friendId.
targets.get('/api/conversations/:targetType/:targetId', async (c) => {
  try {
    const targetType = c.req.param('targetType');
    if (!isTargetType(targetType)) {
      return c.json({ success: false, error: `unsupported target type: ${targetType}` }, 400);
    }
    const db = c.env.DB;
    const target = await resolveTarget(db, targetType, c.req.param('targetId'));
    if (!target) {
      return c.json({ success: false, error: 'Target not found' }, 404);
    }

    const limit = intParam(c.req.query('limit'), 50, 1, 200);
    if (limit === null) {
      return c.json({ success: false, error: 'limit must be an integer 1..200' }, 400);
    }
    const ownershipError = assertTargetAccount(c.req.query('lineAccountId'), target.line_account_id);
    if (ownershipError) return c.json({ success: false, error: ownershipError }, 409);

    const before = c.req.query('before') ?? null;
    // beforeId makes the cursor composite (created_at, id): created_at is the
    // LINE event time, so ties can straddle a page boundary. Pass the id of
    // the oldest message from the previous page together with its createdAt.
    const beforeId = c.req.query('beforeId') ?? null;
    // Scope history to the current owning account: a group that changed hands
    // accumulates rows tagged with each era's account, and only the current
    // owner's rows belong in this view.
    const messages = await getTargetMessages(db, target.id, {
      limit,
      before,
      beforeId,
      lineAccountId: target.line_account_id,
    });

    return c.json({
      success: true,
      data: {
        target: serializeTarget(target),
        messages: messages.reverse().map(serializeTargetMessage),
      },
    });
  } catch (err) {
    console.error('GET /api/conversations/:targetType/:targetId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/targets/:targetType/:targetId/messages - send message to group/room
targets.post('/api/targets/:targetType/:targetId/messages', async (c) => {
  try {
    const targetType = c.req.param('targetType');
    if (!isTargetType(targetType)) {
      return c.json({ success: false, error: `unsupported target type: ${targetType}` }, 400);
    }
    const body = await c.req.json<{
      messageType?: string;
      content: string;
      altText?: string;
      trackLinks?: boolean;
      // Optional account-binding assertion: the account the caller believes
      // owns this target. Omitted by SDK/MCP callers (guard skipped); the admin
      // UI sends its scoped account so a mid-session ownership change is caught.
      lineAccountId?: string | null;
    } & SenderSelection>();
    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const target = await resolveTarget(db, targetType, c.req.param('targetId'));
    if (!target) {
      return c.json({ success: false, error: 'Target not found' }, 404);
    }
    // Account-binding guard: if the caller states which account it expects to
    // own this target, reject when ownership has since changed (e.g. account A
    // left the group and account B joined the same group id) so the send can't
    // silently go out under a different account's token. `undefined` means the
    // caller made no assertion (back-compat); `null` asserts an unbound target.
    if (body.lineAccountId !== undefined && (target.line_account_id ?? null) !== body.lineAccountId) {
      return c.json(
        { success: false, error: 'Target ownership changed for this account; reload before sending' },
        409,
      );
    }
    if (!target.is_active) {
      return c.json({ success: false, error: 'Target is inactive (bot has left the group/room)' }, 409);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    // Resolve access token from the target's account (multi-account support)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (target.line_account_id) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, target.line_account_id);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';
    const sender = await resolveMessageSender(db, c.get('staff'), body);

    // Auto-wrap URLs with tracking links, same as the friend send path.
    // Link tracking is a server-side concern (per-account short links), so
    // callers opt out with trackLinks:false instead of pre-tracking client-side.
    let tracked = { messageType, content: body.content };
    if (body.trackLinks !== false) {
      const { autoTrackContent } = await import('../services/auto-track.js');
      tracked = await autoTrackContent(
        db, messageType, body.content,
        c.env.WORKER_URL || new URL(c.req.url).origin,
        // Tracked links belong to the target's account so they resolve
        // through that account's LIFF (upstream per-account tracking contract)
        { lineAccountId: target.line_account_id },
      );
    }

    const message = buildMessage(tracked.messageType, tracked.content, body.altText);
    await lineClient.pushMessage(target.line_target_id, [message], sender.lineSender);

    // Log what was actually pushed (post-tracking, post-buildMessage) — e.g.
    // a broken image/flex payload falls back to text and must be logged as text
    const logPayload = messageToLogPayload(message);
    const messageId = await logTargetMessage(db, {
      targetId: target.id,
      direction: 'outgoing',
      messageType: logPayload.messageType,
      content: logPayload.content,
      source: 'manual',
      lineAccountId: target.line_account_id,
      senderStaffId: sender.staffId,
      senderName: sender.name,
      senderIconUrl: sender.iconUrl,
    });

    return c.json({ success: true, data: { messageId } });
  } catch (err) {
    if (err instanceof MessageSenderError) {
      return c.json({ success: false, error: err.message }, err.status as 400 | 403 | 404);
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('POST /api/targets/:targetType/:targetId/messages error:', errMsg);
    return c.json({ success: false, error: errMsg }, 500);
  }
});

export { targets };
