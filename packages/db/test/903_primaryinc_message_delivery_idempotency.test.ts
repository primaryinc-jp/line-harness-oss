import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
// @ts-expect-error Repository JavaScript helper intentionally has no declaration file.
import { splitSqlStatements } from '../../../scripts/sql-statements.mjs';

describe('PrimaryInc message delivery idempotency migration', () => {
  test('repairs a partially applied older 903 with a global request key', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE friends (id TEXT PRIMARY KEY, line_account_id TEXT);
      CREATE TABLE message_delivery_idempotency (
        line_account_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        friend_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        message_log_id TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (line_account_id, client_request_id)
      );
    `);
    for (const file of [
      '903_primaryinc_message_delivery_idempotency.sql',
      '904_primaryinc_message_delivery_guards.sql',
    ]) {
      const sql = readFileSync(join(process.cwd(), `migrations/${file}`), 'utf8');
      for (const statement of splitSqlStatements(sql) as string[]) {
        try { db.exec(statement); }
        catch (error) {
          if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
        }
      }
    }
    const insert = db.prepare(`INSERT INTO message_delivery_idempotency
      (line_account_id, client_request_id, friend_id, request_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, 'hash', 'in_progress', 'now', 'now')`);
    db.prepare('INSERT INTO friends (id, line_account_id) VALUES (?, ?)').run('friend-1', 'acc-1');
    insert.run('acc-1', 'proposal:stable', 'friend-1');
    expect(() => insert.run('acc-2', 'proposal:stable', 'friend-1')).toThrow(/UNIQUE constraint failed/);
    expect(() => db.prepare("UPDATE friends SET line_account_id = 'acc-2' WHERE id = 'friend-1'").run())
      .toThrow(/in-progress idempotent delivery/);
    db.prepare("UPDATE message_delivery_idempotency SET status = 'uncertain' WHERE client_request_id = 'proposal:stable'").run();
    expect(() => db.prepare("UPDATE friends SET line_account_id = 'acc-2' WHERE id = 'friend-1'").run()).not.toThrow();
    expect(() => db.prepare("DELETE FROM friends WHERE id = 'friend-1'").run())
      .toThrow(/message delivery idempotency history/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM message_delivery_idempotency').get()).toEqual({ count: 1 });
    db.close();
  });
});
