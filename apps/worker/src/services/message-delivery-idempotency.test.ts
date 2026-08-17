import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  finishMessageDelivery,
  claimMessageDeliveryDispatch,
  reconcileStaleMessageDelivery,
  resolveClaimedMessageDelivery,
  reserveMessageDelivery,
  sha256Hex,
} from './message-delivery-idempotency.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PACKAGE = join(HERE, '../../../../packages/db');

function asD1(db: Database.Database): D1Database {
  const wrap = (sql: string, binds: unknown[] = []) => ({
    bind: (...args: unknown[]) => wrap(sql, args),
    run: async () => {
      const info = db.prepare(sql).run(...(binds as never[]));
      return { meta: { changes: info.changes } };
    },
    first: async () => db.prepare(sql).get(...(binds as never[])) ?? null,
  });
  return { prepare: (sql: string) => wrap(sql) } as unknown as D1Database;
}

describe('message delivery idempotency', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(DB_PACKAGE, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-1', 'channel-1', 'Primary', 'token', 'secret')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
       VALUES ('friend-1', 'U123', '山田', 'acc-1')`,
    ).run();
    db = asD1(sqlite);
  });

  test('reserves once and returns the existing receipt after completion', async () => {
    const requestHash = await sha256Hex('body');
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:1', friendId: 'friend-1',
      requestHash, now: '2026-08-04T07:00:00+09:00',
    };
    await expect(reserveMessageDelivery(db, input)).resolves.toEqual({ kind: 'reserved' });
    await expect(reserveMessageDelivery(db, input)).resolves.toMatchObject({
      kind: 'existing', status: 'in_progress',
    });

    await finishMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:1', status: 'sent',
      messageLogId: 'message-1', now: '2026-08-04T07:01:00+09:00',
    });
    await expect(reserveMessageDelivery(db, input)).resolves.toEqual({
      kind: 'existing', status: 'sent', messageLogId: 'message-1', errorCode: null,
    });
  });

  test('concurrent reservations have exactly one winner', async () => {
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:concurrent', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    const results = await Promise.all([
      reserveMessageDelivery(db, input),
      reserveMessageDelivery(db, input),
    ]);
    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'existing')).toHaveLength(1);
  });

  test('rejects key reuse with a different body or friend', async () => {
    const base = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:1', friendId: 'friend-1',
      requestHash: 'hash-a', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, base);
    await expect(reserveMessageDelivery(db, { ...base, requestHash: 'hash-b' }))
      .resolves.toEqual({ kind: 'request_conflict' });
  });

  test('reclaims an identical request that failed before provider dispatch', async () => {
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'delivery:retry-safe', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, input);
    await finishMessageDelivery(db, {
      lineAccountId: input.lineAccountId,
      clientRequestId: input.clientRequestId,
      status: 'failed',
      errorCode: 'pre_delivery_failure',
      now: '2026-08-04T07:00:01+09:00',
    });

    await expect(reserveMessageDelivery(db, {
      ...input,
      now: '2026-08-04T07:00:02+09:00',
    })).resolves.toEqual({ kind: 'reserved' });
    expect(sqlite.prepare(
      `SELECT status, error_code, dispatch_claimed_at
       FROM message_delivery_idempotency WHERE client_request_id = ?`,
    ).get(input.clientRequestId)).toEqual({
      status: 'in_progress', error_code: null, dispatch_claimed_at: null,
    });
  });

  test('never reclaims an uncertain provider-started delivery', async () => {
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'delivery:retry-unsafe', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, input);
    await claimMessageDeliveryDispatch(db, {
      lineAccountId: input.lineAccountId,
      clientRequestId: input.clientRequestId,
      now: '2026-08-04T07:00:01+09:00',
    });
    await finishMessageDelivery(db, {
      lineAccountId: input.lineAccountId,
      clientRequestId: input.clientRequestId,
      status: 'uncertain',
      errorCode: 'provider_result_unknown',
      now: '2026-08-04T07:00:02+09:00',
    });

    await expect(reserveMessageDelivery(db, input)).resolves.toMatchObject({
      kind: 'existing', status: 'uncertain', errorCode: 'provider_result_unknown',
    });
  });

  test('fails closed when account ownership does not match', async () => {
    await expect(reserveMessageDelivery(db, {
      lineAccountId: 'acc-other', clientRequestId: 'proposal:1', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    })).resolves.toEqual({ kind: 'ownership_mismatch' });
  });

  test('blocks account relinking while a delivery is in progress', async () => {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'Other', 'token', 'secret')`,
    ).run();
    await reserveMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:1', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    });
    expect(() => sqlite.prepare("UPDATE friends SET line_account_id = 'acc-2' WHERE id = 'friend-1'").run())
      .toThrow(/in-progress idempotent delivery/);
  });

  test('does not make a sent request key reusable after an account relink', async () => {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'Other', 'token', 'secret')`,
    ).run();
    const original = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:stable', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, original);
    await finishMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:stable', status: 'sent',
      messageLogId: 'message-1', now: '2026-08-04T07:01:00+09:00',
    });
    sqlite.prepare("UPDATE friends SET line_account_id = 'acc-2' WHERE id = 'friend-1'").run();
    await expect(reserveMessageDelivery(db, { ...original, lineAccountId: 'acc-2' }))
      .resolves.toEqual({ kind: 'request_conflict' });
  });

  test('owner reconciliation converts only stale in-progress deliveries to uncertain', async () => {
    await reserveMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:stale', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    });
    await expect(reconcileStaleMessageDelivery(db, {
      clientRequestId: 'proposal:stale', lineAccountId: 'acc-1',
      now: '2026-08-04T07:05:00+09:00', staleBefore: '2026-08-04T06:50:00+09:00',
    })).resolves.toBe('not_stale');
    await expect(reconcileStaleMessageDelivery(db, {
      clientRequestId: 'proposal:stale', lineAccountId: 'acc-1',
      now: '2026-08-04T07:20:00+09:00', staleBefore: '2026-08-04T07:05:00+09:00',
    })).resolves.toBe('reconciled_uncertain');
    await expect(reserveMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:stale', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:21:00+09:00',
    })).resolves.toMatchObject({ kind: 'existing', status: 'uncertain' });
  });

  test('dispatch claim and stale reconciliation are mutually exclusive', async () => {
    await reserveMessageDelivery(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:claim', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    });
    await expect(claimMessageDeliveryDispatch(db, {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:claim', now: '2026-08-04T07:00:01+09:00',
    })).resolves.toBe(true);
    await expect(reconcileStaleMessageDelivery(db, {
      clientRequestId: 'proposal:claim', lineAccountId: 'acc-1',
      now: '2026-08-04T07:20:00+09:00', staleBefore: '2026-08-04T07:05:00+09:00',
    })).resolves.toBe('dispatch_started');
  });

  test('owner provider verification closes a crashed dispatch without making its key reusable', async () => {
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:crashed-after-claim', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, input);
    await claimMessageDeliveryDispatch(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId, now: '2026-08-04T07:00:01+09:00',
    });
    await expect(resolveClaimedMessageDelivery(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId,
      resolution: 'sent', providerReference: 'line-provider-log-123', resolvedByStaffId: 'staff-owner-1',
      now: '2026-08-04T07:20:00+09:00', staleBefore: '2026-08-04T07:05:00+09:00',
    })).resolves.toBe('resolved');
    await expect(reserveMessageDelivery(db, input)).resolves.toEqual({
      kind: 'existing', status: 'sent', messageLogId: 'provider:line-provider-log-123',
      errorCode: 'owner_provider_verified_sent',
    });
    expect(sqlite.prepare(
      'SELECT resolved_by_staff_id FROM message_delivery_idempotency WHERE client_request_id = ?',
    ).get(input.clientRequestId)).toEqual({ resolved_by_staff_id: 'staff-owner-1' });
  });

  test('owner can close a claimed but unverifiable dispatch as uncertain and release account relinking', async () => {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'Other', 'token', 'secret')`,
    ).run();
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:crashed-unknown', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, input);
    await claimMessageDeliveryDispatch(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId, now: '2026-08-04T07:00:01+09:00',
    });
    await expect(resolveClaimedMessageDelivery(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId,
      resolution: 'uncertain', resolvedByStaffId: 'staff-owner-1',
      now: '2026-08-04T07:20:00+09:00', staleBefore: '2026-08-04T07:05:00+09:00',
    })).resolves.toBe('resolved');
    expect(() => sqlite.prepare("UPDATE friends SET line_account_id = 'acc-2' WHERE id = 'friend-1'").run()).not.toThrow();
    await expect(reserveMessageDelivery(db, { ...input, lineAccountId: 'acc-2' }))
      .resolves.toEqual({ kind: 'request_conflict' });
  });

  test('owner cannot resolve a dispatch claim while its worker may still be running', async () => {
    const input = {
      lineAccountId: 'acc-1', clientRequestId: 'proposal:fresh-claim', friendId: 'friend-1',
      requestHash: 'hash', now: '2026-08-04T07:00:00+09:00',
    };
    await reserveMessageDelivery(db, input);
    await claimMessageDeliveryDispatch(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId, now: '2026-08-04T07:10:00+09:00',
    });
    await expect(resolveClaimedMessageDelivery(db, {
      lineAccountId: input.lineAccountId, clientRequestId: input.clientRequestId,
      resolution: 'uncertain', resolvedByStaffId: 'staff-owner-1',
      now: '2026-08-04T07:20:00+09:00', staleBefore: '2026-08-04T07:05:00+09:00',
    })).resolves.toBe('not_in_progress');
  });
});
