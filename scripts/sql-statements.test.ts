import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error Local JavaScript helper intentionally has no declaration file.
import { splitSqlStatements } from './sql-statements.mjs';

describe('D1 migration statement splitting', () => {
  test('keeps one-line trigger bodies intact', () => {
    const sql = readFileSync(join(process.cwd(), 'packages/db/migrations/904_primaryinc_message_delivery_guards.sql'), 'utf8');
    const statements = splitSqlStatements(sql) as string[];
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE UNIQUE INDEX');
    expect(statements[1]).toContain('prevent_friend_account_change_during_delivery');
    expect(statements[1]).toContain("RAISE(ABORT, 'friend has an in-progress idempotent delivery');");
    expect(statements[2]).toContain('prevent_friend_delete_with_delivery_history');
    expect(statements[2]).toMatch(/END;?$/);
  });
});
