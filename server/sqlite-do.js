// Cloudflare Durable Object storage adapter: wraps ctx.storage.sql in the same interface
// the tracker uses with node:sqlite. Named params (:name with an object argument) are
// rewritten to positional `?` because the DO SQL API only takes positional bindings.
import { SCHEMA } from './schema.js';

export function openDoDb(storage) {
  const sql = storage.sql;
  for (const stmt of SCHEMA) sql.exec(stmt);

  const val = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

  return {
    prepare(text) {
      const names = [];
      const q = text.replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (_, n) => { names.push(n); return '?'; });
      const bind = (args) => (names.length ? names.map((n) => val(args[0]?.[n])) : args.map(val));
      return {
        run: (...a) => { sql.exec(q, ...bind(a)); },
        get: (...a) => sql.exec(q, ...bind(a)).toArray()[0],
        all: (...a) => sql.exec(q, ...bind(a)).toArray(),
      };
    },
    exec(text) {
      for (const s of text.split(';').map((x) => x.trim()).filter(Boolean)) sql.exec(s);
    },
    transaction: (fn) => storage.transactionSync(fn),
  };
}
