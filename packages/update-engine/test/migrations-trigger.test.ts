import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../src/migrations.js';

// Fork migrations (900-series) use CREATE TRIGGER as a delivery-safety guard,
// so the safe D1 splitter has to keep trigger bodies whole instead of
// splitting on the semicolons inside them.
describe('splitSqlStatements with CREATE TRIGGER', () => {
  it('keeps a single-line trigger body in one statement', () => {
    const sql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_a ON t(c);

CREATE TRIGGER IF NOT EXISTS guard_a
BEFORE UPDATE OF line_account_id ON friends
WHEN OLD.line_account_id IS NOT NEW.line_account_id
BEGIN SELECT RAISE(ABORT, 'in-progress delivery'); END;
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE UNIQUE INDEX');
    expect(statements[1]).toContain('CREATE TRIGGER');
    expect(statements[1]).toContain("RAISE(ABORT, 'in-progress delivery')");
    expect(statements[1].trimEnd().endsWith('END')).toBe(true);
  });

  it('keeps a multi-statement trigger body in one statement', () => {
    const sql = `
CREATE TRIGGER guard_b AFTER INSERT ON t
BEGIN
  UPDATE t SET a = 1 WHERE id = NEW.id;
  DELETE FROM u WHERE id = NEW.id;
END;
CREATE INDEX idx_b ON t(a);
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('UPDATE t SET a = 1');
    expect(statements[0]).toContain('DELETE FROM u');
    expect(statements[1]).toContain('CREATE INDEX idx_b');
  });

  it('does not close the body on a CASE ... END inside it', () => {
    const sql = `
CREATE TRIGGER guard_c AFTER INSERT ON t
BEGIN
  UPDATE t SET a = CASE WHEN NEW.b > 0 THEN 1 ELSE 0 END;
  UPDATE t SET c = 2;
END;
CREATE INDEX idx_c ON t(a);
`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('UPDATE t SET c = 2');
    expect(statements[1]).toContain('CREATE INDEX idx_c');
  });

  it('rejects an unterminated trigger body instead of emitting a fragment', () => {
    const sql = `CREATE TRIGGER guard_d AFTER INSERT ON t BEGIN UPDATE t SET a = 1;`;
    expect(() => splitSqlStatements(sql)).toThrow(/unterminated CREATE TRIGGER/);
  });

  it('still splits normal statements that merely mention END in a string', () => {
    const sql = `INSERT INTO t (a) VALUES ('END;');\nCREATE INDEX idx_e ON t(a);`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("VALUES ('END;')");
  });

  // Migration 065 backfills friends with a CASE ... END inside a plain UPDATE.
  // Depth tracking must ignore it, since no trigger body is open.
  it('ignores CASE ... END outside a trigger body', () => {
    const sql = `UPDATE t SET a = CASE WHEN b = 1 THEN 1 ELSE 0 END;\nUPDATE t SET c = 2;`;
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('does not treat identifiers that merely contain the keywords as keywords', () => {
    const sql = `CREATE TABLE weekend (beginning TEXT, ending TEXT);\nCREATE INDEX idx_w ON weekend(beginning);`;
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('does not open a body for a CREATE TRIGGER mentioned only in a comment', () => {
    const sql = `-- CREATE TRIGGER documented here, not declared\nCREATE TABLE t (a);\nCREATE TABLE u (b);`;
    expect(splitSqlStatements(sql)).toHaveLength(2);
  });

  it('handles two trigger declarations back to back', () => {
    const sql = [
      'CREATE TRIGGER a AFTER INSERT ON t BEGIN SELECT 1; END;',
      'CREATE TRIGGER b AFTER DELETE ON t BEGIN SELECT 2; END;',
    ].join('\n');
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('SELECT 1');
    expect(statements[1]).toContain('SELECT 2');
  });
});
