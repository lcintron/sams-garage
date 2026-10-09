/*
 * CSV / JSON export of the current results. The string builders are pure (tested under node); download() touches
 * the DOM only when called.
 */

export const CSV_COLUMNS = [
  ['id', r => r.id],
  ['title', r => r.title],
  ['status', r => r.status],
  ['agency', r => r.agency],
  ['sub_agency', r => r.sub_agency],
  ['program', r => r.program],
  ['phases', r => (r.phases || []).join('; ')],
  ['topic_number', r => r.topic_number],
  ['solicitation_number', r => r.solicitation_number],
  ['release_date', r => r.release_date],
  ['open_date', r => r.open_date],
  ['close_date', r => r.close_date],
  ['keywords', r => (r.keywords || []).join('; ')],
  ['url', r => primaryLink(r)],
  ['first_seen', r => r.first_seen],
  ['last_changed', r => r.last_changed],
  ['summary', r => r.summary]
];

/** The best human link for a record: official solicitation, else the primary source's page, else any. */
export function primaryLink(r) {
  const l = r.links || {};
  return l.official || l[r.source] || l.dod_dsip || l.sbir_gov || l.grants_gov || '';
}

/**
 * Escape one CSV field (RFC 4180): quote when it contains a comma, quote, CR or LF, or leading/trailing space;
 * double embedded quotes. Text that a spreadsheet would run as a formula (=, +, -, @, tab, CR at the start) is
 * prefixed with an apostrophe (OWASP CSV-injection guidance); plain negative numbers are left alone.
 */
export function csvEscape(value) {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : Array.isArray(value) ? value.join('; ') : String(value);
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV text with a header row, CRLF line endings and a UTF-8 BOM (so Excel reads accents correctly). */
export function toCSV(records, columns = CSV_COLUMNS) {
  const lines = [columns.map(([h]) => csvEscape(h)).join(',')];
  for (const r of records) lines.push(columns.map(([, f]) => csvEscape(f(r))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Pretty JSON of the records. */
export function toJSON(records) {
  return JSON.stringify(records, null, 2) + '\n';
}

/** A filename like "sbir-topics-2026-10-09.csv". */
export function exportName(ext, today = new Date().toISOString().slice(0, 10), base = 'sbir-topics') {
  return `${base}-${today}.${ext}`;
}

/** Trigger a browser download (DOM; call from UI code only). */
export function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
