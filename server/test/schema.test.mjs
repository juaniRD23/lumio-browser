// schema.sql and migrations/ describe the same database: every table, column
// and index a migration makes is in schema.sql, defined the same way, and a
// migration run on a database made from schema.sql changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = new URL('../migrations/', import.meta.url);
const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrations = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => [f, fs.readFileSync(new URL(f, dir), 'utf8')]);

// Tables (columns as SQLite sees them) and indexes (columns, uniqueness).
function shape(db) {
  const out = {};
  for (const { name, type } of db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')").all()) {
    if (type === 'table') out[`table ${name}`] = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ ...c }));
    else {
      const info = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE name = ?").get(name);
      out[`index ${name}`] = { table: info.tbl_name, unique: /UNIQUE/i.test(info.sql), cols: db.prepare(`PRAGMA index_info(${name})`).all().map((c) => c.name) };
    }
  }
  return out;
}

test('every migration is already in schema.sql, the same way', () => {
  const full = new DatabaseSync(':memory:');
  full.exec(schema);
  const want = shape(full);
  for (const [i, [file, sql]] of migrations.entries()) {
    const alters = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)];
    if (alters.length) {
      // Columns added later: schema.sql's CREATE TABLE has them.
      for (const [, table, column] of alters) assert.ok(want[`table ${table}`]?.some((c) => c.name === column), `${file}: ${table}.${column} is in schema.sql`);
      continue;
    }
    // On its own, it makes exactly what schema.sql has for those tables and indexes,
    // once the columns later migrations add to them are in (for example
    // app_codes.challenge from 2026-10-06-apple-account.sql).
    const alone = new DatabaseSync(':memory:');
    alone.exec(sql);
    for (const [, later] of migrations.slice(i + 1)) {
      for (const [stmt, table] of later.replace(/--.*$/gm, '').matchAll(/ALTER TABLE (\w+) ADD COLUMN [^;]+/gi)) {
        if (alone.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) alone.exec(stmt);
      }
    }
    const got = shape(alone);
    assert.ok(Object.keys(got).length, `${file} makes something`);
    for (const [name, def] of Object.entries(got)) assert.deepEqual(def, want[name], `${file}: ${name} matches schema.sql`);
    // And run again on a database made from schema.sql, it's a no-op.
    full.exec(sql);
    assert.deepEqual(shape(full), want, `${file} changes nothing on a database from schema.sql`);
  }
});

test('schema.sql runs twice, and creates nothing twice', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(schema);
  const names = [...schema.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], 'no duplicate definitions');
  for (const [file, sql] of migrations) {
    for (const stmt of sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) {
      assert.match(stmt, /^(CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN)/i, `${file}: only idempotent creates or added columns`);
    }
  }
});
