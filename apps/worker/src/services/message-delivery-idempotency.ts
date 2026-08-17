export type DeliveryReservationStatus = 'in_progress' | 'sent' | 'failed' | 'uncertain';

interface DeliveryReservationRow {
  line_account_id: string;
  client_request_id: string;
  friend_id: string;
  request_hash: string;
  status: DeliveryReservationStatus;
  message_log_id: string | null;
  error_code: string | null;
  dispatch_claimed_at: string | null;
}

export type ReserveDeliveryResult =
  | { kind: 'reserved' }
  | { kind: 'ownership_mismatch' }
  | { kind: 'request_conflict' }
  | { kind: 'existing'; status: DeliveryReservationStatus; messageLogId: string | null; errorCode: string | null };

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function reserveMessageDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    clientRequestId: string;
    friendId: string;
    requestHash: string;
    now: string;
  },
): Promise<ReserveDeliveryResult> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO message_delivery_idempotency
         (line_account_id, client_request_id, friend_id, request_hash, status, created_at, updated_at)
       SELECT ?, ?, f.id, ?, 'in_progress', ?, ?
       FROM friends f
       WHERE f.id = ? AND f.line_account_id = ?`,
    )
    .bind(
      input.lineAccountId,
      input.clientRequestId,
      input.requestHash,
      input.now,
      input.now,
      input.friendId,
      input.lineAccountId,
    )
    .run();

  if ((inserted.meta.changes ?? 0) === 1) return { kind: 'reserved' };

  const existing = await db
    .prepare(
      `SELECT line_account_id, client_request_id, friend_id, request_hash, status,
              message_log_id, error_code, dispatch_claimed_at
       FROM message_delivery_idempotency
       WHERE client_request_id = ?`,
    )
    .bind(input.clientRequestId)
    .first<DeliveryReservationRow>();

  if (!existing) return { kind: 'ownership_mismatch' };
  if (existing.line_account_id !== input.lineAccountId
      || existing.friend_id !== input.friendId
      || existing.request_hash !== input.requestHash) {
    return { kind: 'request_conflict' };
  }

  // A failure before dispatch_claimed_at is known to have happened before the
  // provider call. The same request may therefore atomically reclaim its key.
  // Provider-started failures are `uncertain` and can never enter this path.
  if (existing.status === 'failed' && existing.dispatch_claimed_at === null) {
    const reclaimed = await db.prepare(
      `UPDATE message_delivery_idempotency
       SET status = 'in_progress', message_log_id = NULL, error_code = NULL,
           updated_at = ?
       WHERE client_request_id = ? AND line_account_id = ? AND friend_id = ?
         AND request_hash = ? AND status = 'failed' AND dispatch_claimed_at IS NULL`,
    ).bind(
      input.now,
      input.clientRequestId,
      input.lineAccountId,
      input.friendId,
      input.requestHash,
    ).run();
    if ((reclaimed.meta.changes ?? 0) === 1) return { kind: 'reserved' };

    // A concurrent request reclaimed it first. Read the winner's current state
    // so callers receive the same fail-closed result as a normal duplicate.
    const current = await db.prepare(
      `SELECT status, message_log_id, error_code
       FROM message_delivery_idempotency
       WHERE client_request_id = ? AND line_account_id = ?`,
    ).bind(input.clientRequestId, input.lineAccountId).first<{
      status: DeliveryReservationStatus;
      message_log_id: string | null;
      error_code: string | null;
    }>();
    if (current) {
      return {
        kind: 'existing',
        status: current.status,
        messageLogId: current.message_log_id,
        errorCode: current.error_code,
      };
    }
  }
  return {
    kind: 'existing',
    status: existing.status,
    messageLogId: existing.message_log_id,
    errorCode: existing.error_code,
  };
}

export async function claimMessageDeliveryDispatch(
  db: D1Database,
  input: { clientRequestId: string; lineAccountId: string; now: string },
): Promise<boolean> {
  const updated = await db.prepare(
    `UPDATE message_delivery_idempotency
     SET dispatch_claimed_at = ?, updated_at = ?
     WHERE client_request_id = ? AND line_account_id = ?
       AND status = 'in_progress' AND dispatch_claimed_at IS NULL`,
  ).bind(input.now, input.now, input.clientRequestId, input.lineAccountId).run();
  return (updated.meta.changes ?? 0) === 1;
}

export async function reconcileStaleMessageDelivery(
  db: D1Database,
  input: {
    clientRequestId: string;
    lineAccountId: string;
    now: string;
    staleBefore: string;
  },
): Promise<'reconciled_uncertain' | 'not_found' | 'not_stale' | 'already_final' | 'dispatch_started'> {
  const row = await db.prepare(
    `SELECT status, updated_at, line_account_id, dispatch_claimed_at FROM message_delivery_idempotency
     WHERE client_request_id = ?`,
  ).bind(input.clientRequestId).first<{
    status: DeliveryReservationStatus;
    updated_at: string;
    line_account_id: string;
    dispatch_claimed_at: string | null;
  }>();
  if (!row || row.line_account_id !== input.lineAccountId) return 'not_found';
  if (row.status !== 'in_progress') return 'already_final';
  if (row.dispatch_claimed_at) return 'dispatch_started';
  if (Date.parse(row.updated_at) > Date.parse(input.staleBefore)) return 'not_stale';
  const updated = await db.prepare(
    `UPDATE message_delivery_idempotency
     SET status = 'uncertain', error_code = 'stale_in_progress_reconciled', updated_at = ?
     WHERE client_request_id = ? AND line_account_id = ? AND status = 'in_progress'
       AND dispatch_claimed_at IS NULL
       AND julianday(updated_at) <= julianday(?)`,
  ).bind(input.now, input.clientRequestId, input.lineAccountId, input.staleBefore).run();
  return (updated.meta.changes ?? 0) === 1 ? 'reconciled_uncertain' : 'not_stale';
}

export async function resolveClaimedMessageDelivery(
  db: D1Database,
  input: {
    clientRequestId: string;
    lineAccountId: string;
    resolution: 'sent' | 'uncertain';
    providerReference?: string;
    resolvedByStaffId: string;
    now: string;
    staleBefore: string;
  },
): Promise<'resolved' | 'not_in_progress'> {
  if (input.resolution === 'sent' && !input.providerReference) {
    throw new Error('providerReference is required for a verified sent delivery');
  }
  const updated = await db.prepare(
    `UPDATE message_delivery_idempotency
     SET status = ?, message_log_id = ?, error_code = ?, resolved_by_staff_id = ?, updated_at = ?
     WHERE client_request_id = ? AND line_account_id = ?
       AND status = 'in_progress' AND dispatch_claimed_at IS NOT NULL
       AND julianday(dispatch_claimed_at) <= julianday(?)`,
  ).bind(
    input.resolution,
    input.resolution === 'sent' ? `provider:${input.providerReference}` : null,
    input.resolution === 'sent' ? 'owner_provider_verified_sent' : 'owner_provider_verified_uncertain',
    input.resolvedByStaffId,
    input.now,
    input.clientRequestId,
    input.lineAccountId,
    input.staleBefore,
  ).run();
  return (updated.meta.changes ?? 0) === 1 ? 'resolved' : 'not_in_progress';
}

export async function finishMessageDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    clientRequestId: string;
    status: Exclude<DeliveryReservationStatus, 'in_progress'>;
    messageLogId?: string;
    errorCode?: string;
    now: string;
  },
): Promise<void> {
  const updated = await db
    .prepare(
      `UPDATE message_delivery_idempotency
       SET status = ?, message_log_id = ?, error_code = ?, updated_at = ?
       WHERE line_account_id = ? AND client_request_id = ? AND status = 'in_progress'`,
    )
    .bind(
      input.status,
      input.messageLogId ?? null,
      input.errorCode ?? null,
      input.now,
      input.lineAccountId,
      input.clientRequestId,
    )
    .run();
  if ((updated.meta.changes ?? 0) !== 1) {
    throw new Error('idempotent delivery reservation is no longer in progress');
  }
}
