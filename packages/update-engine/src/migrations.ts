import { createHash } from 'node:crypto';
import type { CfApiCreds } from './types.js';
import { executeD1Query } from './cf-api/d1.js';
import { isBenignSchemaErrorText } from './materialize.js';

const MIGRATION_STATE_TABLE = '_line_harness_migrations';

type D1Executor = typeof executeD1Query;

export interface MigrationApplyResult {
  name: string;
  alreadyApplied: boolean;
  executedStatements: number;
  skippedStatements: number;
}

export interface ApplyD1MigrationsOptions {
  creds: CfApiCreds;
  databaseId: string;
  names: string[];
  migrations: Map<string, Buffer>;
  onMigrationStart?: (name: string) => void | Promise<void>;
  onMigrationDone?: (result: MigrationApplyResult) => void | Promise<void>;
  /** Test seam. Production callers use the Cloudflare D1 HTTP API. */
  execute?: D1Executor;
}

/**
 * Split a SQLite migration into individual statements.
 *
 * D1 executes a multi-statement SQL string atomically. That is unsafe for
 * legacy L Harness installs: one duplicate ALTER TABLE rolls back later
 * statements in the same file. This scanner splits only on semicolons that
 * are outside strings, quoted identifiers, and comments.
 *
 * CREATE TRIGGER bodies are kept whole: the statements between BEGIN and the
 * matching END each end in `;`, so splitting on them would emit fragments that
 * D1 rejects. BEGIN and CASE both nest and both close with END, so the scanner
 * tracks block depth rather than stopping at the first `END;` it sees.
 */
export function splitSqlStatements(sql: string): string[] {
  const uncommented = stripSqlComments(sql);
  if (
    /\bDROP\s+(?:TABLE|COLUMN)\b/i.test(uncommented) ||
    /\bRENAME\s+(?:TO|COLUMN)\b/i.test(uncommented)
  ) {
    throw new Error('destructive schema changes are not supported by safe D1 updates');
  }

  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | '`' | ']' | null = null;
  let lineComment = false;
  let blockComment = false;
  // > 0 while inside a CREATE TRIGGER body. Semicolons there belong to the
  // body, not to the migration.
  let blockDepth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      const closing = quote;
      if (ch === closing) {
        // SQLite escapes quote characters by doubling them.
        if (next === closing && closing !== ']') {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      quote = ']';
      continue;
    }
    if (isKeywordAt(sql, i, 'BEGIN')) {
      // Only a trigger's own BEGIN opens a body worth protecting. A BEGIN that
      // starts a transaction is not valid inside a D1 migration statement.
      if (blockDepth > 0) {
        blockDepth += 1;
      } else if (isCreateTriggerHead(sql.slice(start, i))) {
        blockDepth = 1;
      }
      i += 'BEGIN'.length - 1;
      continue;
    }
    if (blockDepth > 0 && isKeywordAt(sql, i, 'CASE')) {
      blockDepth += 1;
      i += 'CASE'.length - 1;
      continue;
    }
    if (blockDepth > 0 && isKeywordAt(sql, i, 'END')) {
      blockDepth -= 1;
      i += 'END'.length - 1;
      continue;
    }
    if (ch === ';') {
      if (blockDepth > 0) continue;
      pushSqlStatement(statements, sql.slice(start, i));
      start = i + 1;
    }
  }

  if (quote || blockComment) {
    throw new Error('migration contains an unterminated SQL quote or block comment');
  }
  if (blockDepth > 0) {
    throw new Error('migration contains an unterminated CREATE TRIGGER body');
  }
  pushSqlStatement(statements, sql.slice(start));
  return statements;
}

/**
 * Apply cumulative release migrations safely across fresh, fully-applied,
 * and partially-applied databases.
 *
 * Each statement is its own D1 request. Duplicate schema-object errors are
 * skipped at statement granularity, so a duplicate first ALTER no longer
 * prevents later ALTERs in the same file from running. A checksum ledger is
 * written only after every statement succeeds or is confirmed benign; later
 * releases can then skip the immutable migration without replaying its DML.
 */
export async function applyD1Migrations(
  opts: ApplyD1MigrationsOptions,
): Promise<MigrationApplyResult[]> {
  const execute = opts.execute ?? executeD1Query;
  const base = { creds: opts.creds, databaseId: opts.databaseId };

  // Validate the whole manifest before touching D1. A malformed release must
  // fail without leaving even the migration ledger behind.
  const parsedStatements = new Map<string, string[]>();
  for (const name of opts.names) {
    if (!opts.migrations.has(name)) {
      throw new Error(`migration ${name} missing in bundle`);
    }
    parsedStatements.set(
      name,
      splitSqlStatements((opts.migrations.get(name) as Buffer).toString('utf8')),
    );
  }
  if (opts.names.length === 0) return [];

  // Associate ledger initialization failures with the first migration in
  // progress output. Older callers/tests expect a migration:running event
  // before any D1-side failure is surfaced.
  await opts.onMigrationStart?.(opts.names[0]);
  await execute({
    ...base,
    sql:
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_STATE_TABLE} (` +
      'name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  });

  const results: MigrationApplyResult[] = [];
  for (let migrationIndex = 0; migrationIndex < opts.names.length; migrationIndex += 1) {
    const name = opts.names[migrationIndex];
    const source = opts.migrations.get(name) as Buffer;

    if (migrationIndex > 0) await opts.onMigrationStart?.(name);
    const checksum = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    const recorded = await execute({
      ...base,
      sql: `SELECT checksum FROM ${MIGRATION_STATE_TABLE} WHERE name = ?`,
      params: [name],
    });
    const priorChecksum = firstResultValue(recorded, 'checksum');
    if (typeof priorChecksum === 'string') {
      if (priorChecksum !== checksum) {
        throw new Error(
          `migration ${name} changed after it was applied (${priorChecksum} != ${checksum})`,
        );
      }
      const result: MigrationApplyResult = {
        name,
        alreadyApplied: true,
        executedStatements: 0,
        skippedStatements: 0,
      };
      results.push(result);
      await opts.onMigrationDone?.(result);
      continue;
    }

    const statements = parsedStatements.get(name) as string[];
    let executedStatements = 0;
    let skippedStatements = 0;
    for (let index = 0; index < statements.length; index += 1) {
      try {
        await execute({ ...base, sql: statements[index] });
        executedStatements += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBenignSchemaErrorText(message)) {
          skippedStatements += 1;
          continue;
        }
        throw new Error(
          `migration ${name} statement ${index + 1}/${statements.length} failed: ${message}`,
          { cause: error },
        );
      }
    }

    await execute({
      ...base,
      sql:
        `INSERT INTO ${MIGRATION_STATE_TABLE} (name, checksum, applied_at) ` +
        "VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      params: [name, checksum],
    });
    const result: MigrationApplyResult = {
      name,
      alreadyApplied: false,
      executedStatements,
      skippedStatements,
    };
    results.push(result);
    await opts.onMigrationDone?.(result);
  }
  return results;
}

function pushSqlStatement(statements: string[], candidate: string): void {
  const trimmed = candidate.trim();
  if (trimmed && stripSqlComments(trimmed).trim()) statements.push(trimmed);
}

/** Case-insensitive keyword match at `index`, bounded by non-identifier chars. */
function isKeywordAt(sql: string, index: number, keyword: string): boolean {
  if (sql.substr(index, keyword.length).toUpperCase() !== keyword) return false;
  const before = index > 0 ? sql[index - 1] : '';
  const after = sql[index + keyword.length] ?? '';
  return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
}

/** True when the statement scanned so far opens a CREATE TRIGGER. */
function isCreateTriggerHead(statementSoFar: string): boolean {
  return /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(
    stripSqlComments(statementSoFar),
  );
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function firstResultValue(
  response: { result: any[] },
  key: string,
): unknown {
  const first = response.result?.[0];
  const rows = first && typeof first === 'object' ? first.results : undefined;
  return Array.isArray(rows) && rows.length > 0 ? rows[0]?.[key] : undefined;
}
