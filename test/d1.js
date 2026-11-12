// Minimal Cloudflare D1 stand-in on node:sqlite, for testing Pages Functions.
const { DatabaseSync } = require('node:sqlite');

function d1() {
  const sql = new DatabaseSync(':memory:');
  const prepare = (q) => {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async run() { sql.prepare(q).run(...args); return { success: true }; },
      async first() { return sql.prepare(q).get(...args) || null; },
      async all() { return { results: sql.prepare(q).all(...args) }; },
    };
    return stmt;
  };
  return { sql, prepare, async batch(list) { for (const s of list) await s.run(); return []; } };
}
module.exports = { d1 };
