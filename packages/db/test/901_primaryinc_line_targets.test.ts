import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertLineTarget, logTargetMessage, setLineTargetActive, getTargetMessages } from '../src/targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  // schema.sql already contains the 901 tables (kept in sync for fresh
  // installs); applying the migration on top verifies idempotence for
  // existing installs.
  const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
  db.exec(schema);
  const migration = readFileSync(
    join(PKG_ROOT, 'migrations', '901_primaryinc_line_targets.sql'),
    'utf8',
  );
  db.exec(migration);
  return db;
}

/**
 * Minimal D1Database adapter over better-sqlite3, enough to exercise the
 * targets.ts helpers (prepare/bind/run/first/all) against a real SQLite
 * schema — the behavior under test (ON CONFLICT upsert, INSERT OR IGNORE
 * dedupe) lives in the SQL, not in D1 itself.
 */
function asD1(db: Database.Database): D1Database {
  const wrap = (sql: string, binds: unknown[] = []) => ({
    bind: (...args: unknown[]) => wrap(sql, args),
    run: async () => {
      const info = db.prepare(sql).run(...(binds as never[]));
      return { meta: { changes: info.changes } };
    },
    first: async () => db.prepare(sql).get(...(binds as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(binds as never[])) }),
  });
  return { prepare: (sql: string) => wrap(sql) } as unknown as D1Database;
}

describe('901_primaryinc_line_targets.sql', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = loadDb();
  });

  it('creates line_targets with the expected columns', () => {
    const rows = db
      .prepare("PRAGMA table_info('line_targets')")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(
      [
        'id',
        'target_type',
        'line_target_id',
        'display_name',
        'picture_url',
        'is_active',
        'line_account_id',
        'metadata',
        'last_message_at',
        'membership_updated_at',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('creates target_messages_log with sender attribution columns', () => {
    const rows = db
      .prepare("PRAGMA table_info('target_messages_log')")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('sender_line_user_id');
    expect(names).toContain('sender_display_name');
    expect(names).toContain('sender_staff_id');
  });

  it('rejects target types other than group/room', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO line_targets (id, target_type, line_target_id) VALUES ('t1', 'friend', 'Cx')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('enforces unique line_target_id', () => {
    db.prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id) VALUES ('t1', 'group', 'Cg1')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO line_targets (id, target_type, line_target_id) VALUES ('t2', 'room', 'Cg1')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('supports json_extract metadata lookup used by listLineTargets', () => {
    // Same customer linked to a group and a room — the metadata filter must
    // return both (one customer ↔ many targets is a supported shape).
    db.prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, metadata)
       VALUES ('t1', 'group', 'Cg1', '{"salesCustomerPageId":"cust-1"}')`,
    ).run();
    db.prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, metadata)
       VALUES ('t2', 'room', 'Cr1', '{"salesCustomerPageId":"cust-1","salesDealPageId":"deal-9"}')`,
    ).run();
    db.prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id, metadata)
       VALUES ('t3', 'group', 'Cg2', '{"salesCustomerPageId":"cust-2"}')`,
    ).run();

    const rows = db
      .prepare(
        `SELECT id FROM line_targets WHERE json_extract(metadata, '$.' || ?) = ? ORDER BY id`,
      )
      .all('salesCustomerPageId', 'cust-1') as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['t1', 't2']);
  });

  it('cascades message deletion when a target is removed', () => {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO line_targets (id, target_type, line_target_id) VALUES ('t1', 'group', 'Cg1')`,
    ).run();
    db.prepare(
      `INSERT INTO target_messages_log (id, target_id, direction, message_type, content)
       VALUES ('m1', 't1', 'incoming', 'text', 'hello')`,
    ).run();
    db.prepare(`DELETE FROM line_targets WHERE id = 't1'`).run();
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM target_messages_log`)
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('upsertLineTarget is atomic: concurrent first registrations both succeed with one row', async () => {
    // Two webhooks for the same unregistered group racing each other: with a
    // SELECT→INSERT pair the loser would hit the UNIQUE constraint and throw,
    // dropping its event. The single-statement upsert must let both resolve.
    const d1 = asD1(db);
    const [a, b] = await Promise.all([
      upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1', displayName: null }),
      upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1', displayName: '田中家' }),
    ]);
    expect(a.id).toBe(b.id);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM line_targets`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('upsertLineTarget preserves known name/account on null input and never touches is_active', async () => {
    const d1 = asD1(db);
    await upsertLineTarget(d1, {
      targetType: 'group', lineTargetId: 'Cg1', displayName: '田中家', pictureUrl: 'p.png', lineAccountId: 'acc1',
    });
    db.prepare(`UPDATE line_targets SET is_active = 0`).run();
    // Regression (leave → old message redelivery): a message-driven upsert
    // must NOT reactivate a target the bot has left
    const row = await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    expect(row.display_name).toBe('田中家');
    expect(row.picture_url).toBe('p.png');
    expect(row.line_account_id).toBe('acc1');
    expect(row.is_active).toBe(0);
  });

  it('setLineTargetActive applies membership transitions in event-time order', async () => {
    const d1 = asD1(db);
    await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    const active = () =>
      (db.prepare(`SELECT is_active AS a FROM line_targets WHERE line_target_id = 'Cg1'`).get() as { a: number }).a;

    // leave at t=200
    await setLineTargetActive(d1, { targetType: 'group', lineTargetId: 'Cg1', isActive: false, eventTimestamp: 200 });
    expect(active()).toBe(0);
    // stale join redelivered out of order (t=100) must NOT reactivate —
    // it would re-open sends to a group the bot already left
    await setLineTargetActive(d1, { targetType: 'group', lineTargetId: 'Cg1', isActive: true, eventTimestamp: 100 });
    expect(active()).toBe(0);
    // a genuinely newer join (t=300) does reactivate
    await setLineTargetActive(d1, { targetType: 'group', lineTargetId: 'Cg1', isActive: true, eventTimestamp: 300 });
    expect(active()).toBe(1);
  });

  it('leave for an unregistered target writes a tombstone that blocks a stale join', async () => {
    const d1 = asD1(db);
    // leave (t=200) arrives before the target was ever registered — must
    // persist an inactive tombstone, not be a no-op
    await setLineTargetActive(d1, { targetType: 'group', lineTargetId: 'Cg1', isActive: false, eventTimestamp: 200 });
    const row = () =>
      db.prepare(`SELECT is_active AS a, membership_updated_at AS ts FROM line_targets WHERE line_target_id = 'Cg1'`)
        .get() as { a: number; ts: number } | undefined;
    expect(row()).toMatchObject({ a: 0, ts: 200 });

    // stale join redelivered afterwards (t=100): the join path first upserts
    // (name refresh — must not touch is_active) then applies the guarded
    // membership transition, which the tombstone timestamp blocks
    await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1', displayName: '田中家' });
    await setLineTargetActive(d1, { targetType: 'group', lineTargetId: 'Cg1', isActive: true, eventTimestamp: 100 });
    expect(row()).toMatchObject({ a: 0, ts: 200 });
    const count = db.prepare(`SELECT COUNT(*) AS c FROM line_targets`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('logTargetMessage stores occurredAt as created_at and keeps last_message_at monotonic', async () => {
    const d1 = asD1(db);
    const target = await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    const lastMessageAt = () =>
      (db.prepare(`SELECT last_message_at AS t FROM line_targets WHERE id = ?`).get(target.id) as { t: string }).t;

    // newer message first (t2), then a delayed older one (t1) arrives late
    const t1 = Date.UTC(2026, 6, 10, 1, 0, 0); // 10:00 JST
    const t2 = Date.UTC(2026, 6, 10, 2, 0, 0); // 11:00 JST
    await logTargetMessage(d1, {
      targetId: target.id, direction: 'incoming', messageType: 'text', content: '新しい方', lineMessageId: 'm2', occurredAt: t2,
    });
    const afterNewer = lastMessageAt();
    await logTargetMessage(d1, {
      targetId: target.id, direction: 'incoming', messageType: 'text', content: '遅延した古い方', lineMessageId: 'm1', occurredAt: t1,
    });

    // created_at reflects the event time, so ordering is by real occurrence
    const rows = db
      .prepare(`SELECT content FROM target_messages_log WHERE target_id = ? ORDER BY created_at DESC, id DESC`)
      .all(target.id) as Array<{ content: string }>;
    expect(rows.map((r) => r.content)).toEqual(['新しい方', '遅延した古い方']);
    // the delayed old message must not surface the target as newly active
    expect(lastMessageAt()).toBe(afterNewer);
    expect(afterNewer).toBe('2026-07-10T11:00:00.000+09:00');
  });

  it('logTargetMessage dedupes redelivered webhook messages by line_message_id', async () => {
    const d1 = asD1(db);
    const target = await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    const input = {
      targetId: target.id,
      direction: 'incoming' as const,
      messageType: 'text',
      content: 'hello',
      lineMessageId: 'lm-1',
    };
    const first = await logTargetMessage(d1, input);
    const second = await logTargetMessage(d1, input);
    expect(second).toBe(first);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM target_messages_log`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('paginates through messages sharing one created_at without loss (composite cursor)', async () => {
    const d1 = asD1(db);
    const target = await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    // Four messages: three share the same event timestamp (LINE event.timestamp
    // has ms precision — simultaneous group messages are realistic), one older
    const ts = Date.UTC(2026, 6, 10, 2, 0, 0);
    for (const [n, at] of [['m1', ts], ['m2', ts], ['m3', ts], ['m0', ts - 60_000]] as const) {
      await logTargetMessage(d1, {
        targetId: target.id, direction: 'incoming', messageType: 'text',
        content: n, lineMessageId: n, occurredAt: at,
      });
    }

    // Page size 2 → the tie of three straddles the page boundary
    const page1 = await getTargetMessages(d1, target.id, { limit: 2 });
    expect(page1).toHaveLength(2);
    const cursor = page1[page1.length - 1];

    // Timestamp-only cursor would skip the remaining tied message entirely;
    // the composite (before, beforeId) cursor must return it
    const page2 = await getTargetMessages(d1, target.id, {
      limit: 2, before: cursor.created_at, beforeId: cursor.id,
    });
    const all = [...page1, ...page2];
    expect(all).toHaveLength(4);
    // No duplicates, no losses
    expect(new Set(all.map((m) => m.id)).size).toBe(4);
    expect(all.map((m) => m.content).sort()).toEqual(['m0', 'm1', 'm2', 'm3']);
    // Deterministic order: ties resolved by id DESC, older message last
    expect(all[3].content).toBe('m0');
  });

  it('logTargetMessage allows multiple outgoing rows without line_message_id', async () => {
    const d1 = asD1(db);
    const target = await upsertLineTarget(d1, { targetType: 'group', lineTargetId: 'Cg1' });
    const base = { targetId: target.id, direction: 'outgoing' as const, messageType: 'text', content: 'hi' };
    const a = await logTargetMessage(d1, base);
    const b = await logTargetMessage(d1, base);
    expect(a).not.toBe(b);
    const count = db.prepare(`SELECT COUNT(*) AS c FROM target_messages_log`).get() as { c: number };
    expect(count.c).toBe(2);
  });
});
