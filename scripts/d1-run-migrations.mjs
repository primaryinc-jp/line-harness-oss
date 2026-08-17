#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { splitSqlStatements } from './sql-statements.mjs';

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
  const statements = splitSqlStatements(sql);

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
