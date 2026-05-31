#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const dbName = process.env.D1_DATABASE_NAME;
const migrationsDir = resolve(process.env.D1_MIGRATIONS_DIR ?? 'packages/db/migrations');

if (!dbName) {
  console.error('D1_DATABASE_NAME is required');
  process.exit(1);
}

function runWrangler(args, options = {}) {
  const finalArgs = args.includes('--json') ? args : [...args, '--json'];
  const result = spawnSync('./node_modules/.bin/wrangler', ['d1', 'execute', dbName, '--remote', ...finalArgs], {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const error = new Error(message || `wrangler exited with ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout ?? '';
}

function query(command) {
  const raw = runWrangler([`--command=${command}`, '--json'], { capture: true });
  const parsed = JSON.parse(raw);
  return parsed[0]?.results ?? [];
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      current += ch + next;
      i += 1;
      lineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      current += ch + next;
      i += 1;
      blockComment = true;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }

    current += ch;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function isAlreadyAppliedError(error) {
  const text = error.message.toLowerCase();
  return (
    text.includes('duplicate column name') ||
    text.includes('already exists') ||
    (text.includes('index') && text.includes('already exists')) ||
    (text.includes('table') && text.includes('already exists'))
  );
}

function hasExecutableSql(statement) {
  const withoutComments = statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .trim();
  return withoutComments.length > 0;
}

runWrangler([
  '--command=CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
]);

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

for (const fileName of migrationFiles) {
  const name = basename(fileName);
  const applied = query(`SELECT name FROM _migrations WHERE name = '${sqlString(name)}'`);
  if (applied.length > 0) {
    console.log(`Skipped: ${name}`);
    continue;
  }

  console.log(`Applying: ${name}`);
  const sql = readFileSync(join(migrationsDir, fileName), 'utf8');
  const statements = splitStatements(sql);

  for (const statement of statements) {
    if (!hasExecutableSql(statement)) continue;
    try {
      runWrangler([`--command=${statement}`]);
    } catch (error) {
      if (isAlreadyAppliedError(error)) {
        console.log(`Already applied statement in ${name}: ${error.message.split('\n').at(-1)}`);
        continue;
      }
      throw error;
    }
  }

  runWrangler([
    `--command=INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('${sqlString(name)}', datetime('now'))`,
  ]);
}
