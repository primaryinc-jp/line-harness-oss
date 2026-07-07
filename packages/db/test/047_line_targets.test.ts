import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  // schema.sql already contains the 047 tables (kept in sync for fresh
  // installs); applying the migration on top verifies idempotence for
  // existing installs.
  const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
  db.exec(schema);
  const migration = readFileSync(
    join(PKG_ROOT, 'migrations', '047_line_targets.sql'),
    'utf8',
  );
  db.exec(migration);
  return db;
}

describe('047_line_targets.sql', () => {
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
});
