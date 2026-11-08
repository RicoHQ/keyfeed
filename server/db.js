// Node storage: node:sqlite with a tiny adapter so the tracker sees the same interface as on
// Cloudflare (see sqlite-do.js): prepare(sql).run/get/all, exec(sql), transaction(fn).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA } from './schema.js';

export { today } from './schema.js';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  if (path !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  for (const stmt of SCHEMA) raw.exec(stmt);

  const clean = (args) => args.map((a) => (a === undefined ? null : a && typeof a === 'object' && !Array.isArray(a)
    ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v === undefined ? null : v]))
    : a));

  return {
    raw,
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        run: (...a) => st.run(...clean(a)),
        get: (...a) => st.get(...clean(a)),
        all: (...a) => st.all(...clean(a)),
      };
    },
    exec: (sql) => raw.exec(sql),
    transaction(fn) {
      raw.exec('BEGIN');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
