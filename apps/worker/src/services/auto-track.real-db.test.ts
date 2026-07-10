import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoTrackContent } from './auto-track.js';
import { trackedLinks } from '../routes/tracked-links.js';

// End-to-end over a REAL schema (no @line-crm/db mock): a URL sent to a
// group target owned by a secondary account must produce a tracked_links row
// with that account's line_account_id, and its /t/ redirect must resolve to
// that account's LIFF — not the global env.LIFF_URL (which would show another
// account's consent screen).

const __dirname = dirname(fileURLToPath(import.meta.url));
// bootstrap.sql is the generated fresh-install schema (migrations applied),
// e.g. line_accounts.liff_id comes from 008_multi_account and is absent from
// the hand-maintained schema.sql
const SCHEMA = readFileSync(
  join(__dirname, '../../../../packages/db/bootstrap.sql'),
  'utf8',
);

/** Minimal D1Database adapter over better-sqlite3 (same shape as packages/db tests). */
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

const LINE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Line/14.0.0';

describe('group send → per-account tracked link (real DB)', () => {
  let db: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    // Two accounts: the harness default (acc-1) and the secondary account
    // that owns the group (acc-2)
    db.prepare(
      `INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, liff_id, created_at, updated_at)
       VALUES ('acc-2', 'セカンダリ', 'ch2', 'sec2', 'tok2', '2009668520-YghzbHx9', '2026-07-01', '2026-07-01')`,
    ).run();
    d1 = asD1(db);
  });

  it('persists the target-owning account on the tracked_links row', async () => {
    const result = await autoTrackContent(
      d1,
      'text',
      '物件ページです https://example.com/property/123',
      'https://worker.example.com',
      { lineAccountId: 'acc-2' },
    );

    const row = db
      .prepare(`SELECT line_account_id, short_code, original_url FROM tracked_links`)
      .get() as { line_account_id: string | null; short_code: string | null; original_url: string };
    expect(row.original_url).toBe('https://example.com/property/123');
    // The whole point of per-account tracking: the row must carry the account
    expect(row.line_account_id).toBe('acc-2');
    expect(row.short_code).toBeTruthy();
    expect(result.content).toContain(`/t/${row.short_code}`);
  });

  it('redirects LINE in-app clicks to the owning account LIFF, not the global default', async () => {
    await autoTrackContent(
      d1, 'text', 'https://example.com/property/123',
      'https://worker.example.com',
      { lineAccountId: 'acc-2' },
    );
    const { short_code } = db
      .prepare(`SELECT short_code FROM tracked_links`)
      .get() as { short_code: string };

    const res = await trackedLinks.request(
      `https://worker.example.com/t/${short_code}`,
      { headers: { 'user-agent': LINE_UA }, redirect: 'manual' },
      {
        DB: d1,
        LIFF_URL: 'https://liff.line.me/2009554425-GLOBAL',
        WORKER_URL: 'https://worker.example.com',
      },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    // acc-2's LIFF, never the global fallback
    expect(location.startsWith('https://liff.line.me/2009668520-YghzbHx9?redirect=')).toBe(true);
    expect(location).not.toContain('GLOBAL');
  });
});
