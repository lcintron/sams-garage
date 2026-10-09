/*
 * SQL console engine: lazy sql.js loader + read-only query runner. Only imported on #/sql.
 * The query guard (isReadOnlyQuery) and result shaping are pure and tested under node.
 *
 * Read-only is enforced twice: a static check that rejects anything but a single SELECT / WITH … SELECT / EXPLAIN /
 * VALUES statement, and "PRAGMA query_only = ON" on the opened database (the database lives only in this tab's
 * memory anyway; nothing can be written back to the server).
 */

export const MAX_ROWS = 1000;

/** Remove comments and the contents of string/identifier literals so keywords inside them are not seen. */
export function stripSql(sql) {
  let out = '';
  const s = String(sql || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (c === '-' && n === '-') { while (i < s.length && s[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < s.length) {
        if (s[i] === close) { if (s[i + 1] === close && close !== ']') { i += 2; continue; } break; }
        i++;
      }
      out += c === "'" ? "''" : '""';
      continue;
    }
    out += c;
  }
  return out;
}

const WRITE_AFTER_CTE = /\)\s*(insert|update|delete|replace)\b/i;
const FORBIDDEN = /\b(attach|detach|pragma|vacuum|reindex|begin|commit|rollback|savepoint|release|create|drop|alter|load_extension)\b/i;

/**
 * Accept only a single read statement. Returns { ok: true } or { ok: false, reason }.
 */
export function isReadOnlyQuery(sql) {
  const stripped = stripSql(sql);
  const statements = stripped.split(';').map(x => x.trim()).filter(Boolean);
  if (!statements.length) return { ok: false, reason: 'Enter a query.' };
  if (statements.length > 1) return { ok: false, reason: 'Run one statement at a time.' };
  const st = statements[0];
  const first = (st.match(/^\(*\s*([a-z]+)/i) || [])[1]?.toLowerCase();
  if (!['select', 'with', 'explain', 'values'].includes(first)) {
    return { ok: false, reason: 'Read-only console: only SELECT, WITH … SELECT, EXPLAIN and VALUES are allowed.' };
  }
  if (first === 'with' && WRITE_AFTER_CTE.test(st)) return { ok: false, reason: 'Read-only console: WITH … INSERT/UPDATE/DELETE is not allowed.' };
  if (FORBIDDEN.test(st)) return { ok: false, reason: `Read-only console: "${st.match(FORBIDDEN)[1].toUpperCase()}" is not allowed.` };
  return { ok: true };
}

/** Run a statement on an open sql.js Database, capped at maxRows. Returns { columns, rows, truncated, ms }. */
export function runQuery(db, sql, maxRows = MAX_ROWS, now = () => performance.now()) {
  const guard = isReadOnlyQuery(sql);
  if (!guard.ok) throw new Error(guard.reason);
  const t0 = now();
  const stmt = db.prepare(sql);
  try {
    const columns = stmt.getColumnNames();
    const rows = [];
    let truncated = false;
    while (stmt.step()) {
      if (rows.length >= maxRows) { truncated = true; break; }
      rows.push(stmt.get());
    }
    return { columns, rows, truncated, ms: now() - t0 };
  } finally {
    stmt.free();
  }
}

/** Schema for the sidebar: [{ name, type: 'table'|'view', columns: [{name, type}] }]. */
export function readSchema(db) {
  const res = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const objs = res.length ? res[0].values.map(([name, type]) => ({ name, type, columns: [] })) : [];
  for (const o of objs) {
    const info = db.exec(`SELECT name, type FROM pragma_table_info('${o.name.replace(/'/g, "''")}')`);
    o.columns = info.length ? info[0].values.map(([name, type]) => ({ name, type })) : [];
  }
  return objs;
}

export const EXAMPLES = [
  { label: 'Open now, closing soonest', sql: "SELECT id, title, agency, sub_agency, close_date\nFROM solicitations\nWHERE status = 'open'\nORDER BY close_date\nLIMIT 100;" },
  { label: 'Closing soon (view)', sql: 'SELECT *\nFROM closing_soon\nLIMIT 100;' },
  { label: 'Open now (view)', sql: 'SELECT *\nFROM open_now\nLIMIT 100;' },
  { label: 'Counts by agency and status', sql: 'SELECT agency, status, COUNT(*) AS n\nFROM solicitations\nGROUP BY agency, status\nORDER BY agency, n DESC;' },
  { label: 'Topics with a keyword', sql: "SELECT s.id, s.title, s.close_date\nFROM solicitations s\nJOIN keywords k ON k.id = s.id\nWHERE k.keyword LIKE '%acoustic%'\nGROUP BY s.id\nORDER BY s.close_date;" },
  { label: 'Most common keywords', sql: 'SELECT keyword, COUNT(*) AS n\nFROM keywords\nGROUP BY keyword\nORDER BY n DESC\nLIMIT 50;' },
  { label: 'Description contains…', sql: "SELECT id, title, agency, status\nFROM solicitations\nWHERE description LIKE '%counter-uas%' OR title LIKE '%counter-uas%'\nORDER BY close_date;" },
  { label: 'Recent changes (changelog)', sql: 'SELECT *\nFROM changelog\nORDER BY at DESC\nLIMIT 100;' },
  { label: 'New in the last 7 days', sql: "SELECT id, title, agency, first_seen\nFROM solicitations\nWHERE first_seen >= date('now', '-7 day')\nORDER BY first_seen DESC;" }
];

/** True when the bytes start with the SQLite 3 file header ("SQLite format 3" followed by a NUL byte). */
export function isSqliteFile(bytes) {
  const magic = 'SQLite format 3';
  if (!bytes || bytes.length < 100) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return bytes[magic.length] === 0;
}

// ---------- browser-only loading ----------

let sqlPromise = null;
/** Load vendor/sqljs/sql-wasm.js via a script tag (it is a classic script that defines window.initSqlJs). */
export function loadSqlJs() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = new Promise((resolve, reject) => {
    if (globalThis.initSqlJs) return resolve(globalThis.initSqlJs);
    const s = document.createElement('script');
    s.src = 'vendor/sqljs/sql-wasm.js';
    s.onload = () => (globalThis.initSqlJs ? resolve(globalThis.initSqlJs) : reject(new Error('sql.js failed to initialise')));
    s.onerror = () => reject(new Error('Could not load sql.js'));
    document.head.appendChild(s);
  }).then(init => init({ locateFile: f => 'vendor/sqljs/' + f }));
  sqlPromise.catch(() => { sqlPromise = null; });
  return sqlPromise;
}

export class NotBuiltError extends Error {
  constructor() { super('The SQLite database has not been built yet.'); this.name = 'NotBuiltError'; }
}

/** Fetch the database (with progress callback) and open it read-only. */
export async function openDatabase(url, onProgress) {
  const [SQL, buf] = await Promise.all([loadSqlJs(), fetchBytes(url, onProgress)]);
  const db = new SQL.Database(buf);
  db.run('PRAGMA query_only = ON;');
  return db;
}

async function fetchBytes(url, onProgress) {
  let res;
  try { res = await fetch(url); } catch { throw new Error('Could not download the database (offline?).'); }
  if (res.status === 404) throw new NotBuiltError();
  if (!res.ok) throw new Error(`Database download failed: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  let bytes;
  if (!res.body || !onProgress) {
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got, total);
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
  }
  // Anything that is not a SQLite file (e.g. a host's HTML fallback page for a missing file) counts as "not built".
  if (!isSqliteFile(bytes)) throw new NotBuiltError();
  return bytes;
}
