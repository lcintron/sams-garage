/*
 * SQL console view (#/sql). Loads sql.js and data/solicitations.sqlite on first visit only; never blocks the list.
 * Textarea + Run (Ctrl/Cmd+Enter), example queries, schema sidebar, results table capped at MAX_ROWS, inline errors.
 */
import { h, encodeId } from './dom.js';

let state = null; // { db, schema } once loaded
let loading = null;

/**
 * @param {HTMLElement} view   #sqlView
 * @param {{ url: string, version: string }} opts
 */
export async function showSqlConsole(view, opts) {
  const sqlMod = await import('../sql.js');
  if (view.dataset.built === opts.version && state) { view.querySelector('textarea')?.focus(); return; }
  view.dataset.built = '';

  const progressBar = h('div');
  const status = h('p', { class: 'sql-msg dim', role: 'status', text: 'Loading the SQL engine and database…' });
  view.replaceChildren(h('div', { class: 'about' }, status, h('div', { class: 'progress', 'aria-hidden': 'true' }, progressBar)));

  try {
    if (!loading || loading.version !== opts.version) {
      state?.db?.close?.();
      state = null;
      const p = sqlMod.openDatabase(opts.url, (got, total) => {
        if (total) progressBar.style.width = Math.round((got / total) * 100) + '%';
        status.textContent = `Downloading database… ${(got / 1048576).toFixed(1)} MB${total ? ' of ' + (total / 1048576).toFixed(1) + ' MB' : ''}`;
      }).then(db => ({ db, schema: sqlMod.readSchema(db) }));
      loading = { version: opts.version, p };
      p.catch(() => { loading = null; });
    }
    state = await loading.p;
  } catch (err) {
    view.replaceChildren(h('div', { class: 'about' }, notBuiltOrError(err, sqlMod)));
    return;
  }
  build(view, sqlMod, opts);
  view.dataset.built = opts.version;
}

function notBuiltOrError(err, sqlMod) {
  if (err instanceof sqlMod.NotBuiltError) {
    return h('div', { class: 'notice' },
      h('h2', { text: 'Database not built yet' }),
      h('p', null, 'The SQL console queries ', h('code', { text: 'data/solicitations.sqlite' }), ', which this deployment does not have yet.'),
      h('p', null, 'Locally, build it with ', h('code', { text: 'python -m scraper build --out site/data' }),
        ' (or ', h('code', { text: 'npm run build' }), '). On GitHub Pages it appears after the next daily data refresh.'),
      h('p', null, h('a', { href: '#/', text: '← Back to the list' }), ' — search and filters work without it.'));
  }
  return h('div', { class: 'notice' }, h('h2', { text: 'Could not open the database' }), h('p', { class: 'sql-msg err', text: err.message || String(err) }),
    h('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: () => location.reload() }));
}

function build(view, sqlMod, opts) {
  const { db, schema } = state;
  const ta = h('textarea', { id: 'sqlInput', spellcheck: 'false', 'aria-label': 'SQL query', autocapitalize: 'off', autocomplete: 'off' });
  ta.value = sessionGet() || sqlMod.EXAMPLES[0].sql;
  const msg = h('div', { class: 'sql-msg', role: 'status', 'aria-live': 'polite' });
  const out = h('div', { class: 'sql-out', tabindex: '0', 'aria-label': 'Query results' });

  const examples = h('select', { 'aria-label': 'Example queries', title: 'Example queries' },
    h('option', { value: '', text: 'Examples…' }),
    sqlMod.EXAMPLES.map((e, i) => h('option', { value: String(i), text: e.label })));
  examples.addEventListener('change', () => {
    const ex = sqlMod.EXAMPLES[+examples.value];
    if (ex) { ta.value = ex.sql; run(); }
    examples.value = '';
  });

  function run() {
    sessionSet(ta.value);
    msg.className = 'sql-msg';
    try {
      const res = sqlMod.runQuery(db, ta.value);
      msg.textContent = `${res.rows.length.toLocaleString()} row${res.rows.length === 1 ? '' : 's'}${res.truncated ? ` (showing the first ${sqlMod.MAX_ROWS.toLocaleString()}; add LIMIT/OFFSET to page)` : ''} · ${res.ms.toFixed(1)} ms`;
      out.replaceChildren(table(res));
    } catch (err) {
      msg.className = 'sql-msg err';
      msg.textContent = String(err.message || err);
    }
  }

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  });

  const schemaEl = h('aside', { class: 'sql-schema', 'aria-label': 'Schema' }, h('h2', { text: 'Schema' }),
    schema.map(o => h('details', { open: o.name === 'solicitations' },
      h('summary', null, o.name, h('span', { class: 'k', text: ' ' + o.type })),
      h('ul', null, o.columns.map(c => h('li', null, h('b', { text: c.name }), c.type ? ' ' + c.type.toLowerCase() : ''))))),
    h('p', { class: 'dim', style: 'margin-top:12px' }, 'Read-only: SELECT, WITH and EXPLAIN only. ', h('a', { href: opts.url, download: 'solicitations.sqlite', text: 'Download .sqlite' })));

  view.replaceChildren(h('div', { class: 'sql' }, schemaEl,
    h('div', { class: 'sql-main' },
      h('div', { class: 'sql-bar' }, examples, h('span', { class: 'grow' }),
        h('button', { class: 'btn small primary', type: 'button', title: 'Run (Ctrl+Enter)', text: 'Run ▸', onclick: run })),
      ta, msg, out)));
  run();
  ta.focus();
}

function table({ columns, rows }) {
  if (!columns.length) return h('p', { class: 'dim pad', text: 'The statement returned no columns.' });
  const idCol = columns.indexOf('id');
  return h('table', null,
    h('thead', null, h('tr', null, columns.map(c => h('th', { scope: 'col', text: c })))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((v, i) => {
      if (v == null) return h('td', { class: 'null', text: 'NULL' });
      if (i === idCol && typeof v === 'string') return h('td', null, h('a', { href: '#/s/' + encodeId(v), text: v }));
      if (v instanceof Uint8Array) return h('td', { class: 'null', text: `<blob ${v.length} bytes>` });
      const s = String(v);
      return h('td', { class: typeof v === 'number' ? 'num' : '', title: s.length > 60 ? s.slice(0, 500) : null, text: s });
    })))));
}

function sessionGet() { try { return sessionStorage.getItem('sg.sql') || ''; } catch { return ''; } }
function sessionSet(v) { try { sessionStorage.setItem('sg.sql', v); } catch { /* ignore */ } }
