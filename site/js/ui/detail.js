/*
 * Detail pane: every field of a record, a date timeline, the description with its paragraphs, links, changelog,
 * and actions (back, star, copy link, export JSON). Renders the catalog record at once and fills in the full record
 * (description, extra, changelog) when it arrives.
 */
import { h, svg, ICONS, fmtDate, relDays, isEstimated } from './dom.js';
import { STATUS_LABELS } from '../filters.js';
import { daysUntil } from '../search.js';

const LINK_LABELS = { official: 'Official solicitation', dod_dsip: 'DoD DSIP topic search', sbir_gov: 'SBIR.gov', grants_gov: 'Grants.gov' };
const EVENT_LABELS = { new: 'First seen', status: 'Status changed', updated: 'Content updated', missing: 'Missing from source' };

/**
 * @param {HTMLElement} container
 * @param {object} rec catalog record
 * @param {object} o { full: object|null|Error, watched, today, profile, profilesById, backHref,
 *                     onStar(id)->bool, onCopyLink(), onExport(rec) }
 */
export function renderDetail(container, rec, o) {
  const full = o.full && !(o.full instanceof Error) ? o.full : null;
  const r = full ? { ...rec, ...full } : rec;
  const watched = !!o.watched;

  const star = h('button', { class: 'btn small', type: 'button', 'aria-pressed': watched ? 'true' : 'false' },
    svg(ICONS.star, 16), watched ? 'Watching' : 'Watch');
  star.addEventListener('click', () => {
    const on = o.onStar(rec.id);
    star.setAttribute('aria-pressed', on ? 'true' : 'false');
    star.lastChild.textContent = on ? 'Watching' : 'Watch';
    star.querySelector('path').setAttribute('fill', on ? 'currentColor' : 'none');
  });
  if (watched) star.querySelector('path').setAttribute('fill', 'currentColor');

  const toolbar = h('div', { class: 'd-toolbar' },
    h('a', { class: 'btn small d-back', href: o.backHref, title: 'Back to results (Esc)' }, svg(ICONS.back, 16), 'Back'),
    h('span', { class: 'grow' }),
    star,
    h('button', { class: 'btn small', type: 'button', title: 'Copy a link to this topic', onclick: o.onCopyLink }, svg(ICONS.link, 16), 'Copy link'),
    h('button', { class: 'btn small', type: 'button', title: 'Download this record as JSON', onclick: () => o.onExport(r) }, svg(ICONS.download, 16), 'JSON')
  );

  const title = h('h2', { class: 'd-title', id: 'detailTitle', tabindex: '-1' }, r.title || r.topic_number || r.id);

  const tags = h('div', { class: 'd-tags' },
    h('span', { class: 'status ' + (r.status || 'unknown'), text: STATUS_LABELS[r.status] || r.status || 'Unknown' }),
    h('span', { class: 'tag agency' }, r.agency || '—', r.sub_agency ? ' · ' + r.sub_agency : ''),
    r.program && h('span', { class: 'tag', text: r.program }),
    (r.phases || []).map(p => h('span', { class: 'tag', text: 'Phase ' + p })),
    o.isNew && h('span', { class: 'tag new', text: 'NEW' })
  );

  // key facts
  const days = daysUntil(r.close_date, o.today);
  // forecasted / pre-release dates are estimates; a passed estimate is not "closed"
  const est = isEstimated(r);
  const closeText = !r.close_date ? null
    : est ? `${fmtDate(r.close_date)} (${days != null && days < 0 ? 'date passed' : relDays(days)})`
    : `${fmtDate(r.close_date)}${days != null ? ' (' + relDays(days) + ')' : ''}`;
  const facts = [
    ['Topic number', r.topic_number],
    ['Solicitation', [r.solicitation_number, r.solicitation_title].filter(Boolean).join(' — ')],
    [est ? 'Closes (estimated)' : 'Closes', closeText],
    [est ? 'Opens (estimated)' : null, est && r.open_date ? `${fmtDate(r.open_date)} (${(d => (d != null && d < 0 ? 'date passed' : relDays(d)))(daysUntil(r.open_date, o.today))})` : null],
    ['Year', r.year],
    ['Technology areas', (r.technology_areas || []).join(', ')],
    ['Keywords', (r.keywords || []).join(', ')],
    ['Source', r.source],
    ['Record id', r.id],
    ['Also known as', (r.alt_ids || []).join(', ')],
    ['First seen', r.first_seen ? fmtDate(r.first_seen) : null],
    ['Last seen', r.last_seen ? fmtDate(r.last_seen) : null],
    ['Last changed', r.last_changed ? fmtDate(r.last_changed) : null]
  ].filter(([k, v]) => k && v !== null && v !== undefined && v !== '');
  const grid = h('dl', { class: 'd-grid' }, facts.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]));

  // profile matches
  let profSec = null;
  if (o.profile) {
    const rows = Object.entries(o.profile.matched).map(([pid, terms]) => {
      const p = o.profilesById?.get(pid);
      return h('li', null, h('b', { text: '#' + (p ? p.name : pid) }), ': ' + terms.join(', '));
    });
    profSec = h('section', { class: 'd-section' }, h('h2', { text: `Keyword profiles · score ${o.profile.score}` }),
      h('ul', { class: 'small' }, rows),
      o.profile.context?.length ? h('p', { class: 'small dim', text: 'Context terms: ' + o.profile.context.join(', ') }) : null);
  }

  // timeline
  const steps = [
    ['Release', r.release_date], ['Open', r.open_date], ['Q&A opens', r.qa_open_date], ['Q&A closes', r.qa_close_date], ['Close', r.close_date]
  ].filter(([, d]) => d)
    // chronological: DSIP's Q&A period usually opens during pre-release, before the open date (stable sort keeps ties)
    .sort((a, b) => String(a[1]).slice(0, 10).localeCompare(String(b[1]).slice(0, 10)));
  const timeline = steps.length ? h('section', { class: 'd-section' }, h('h2', { text: 'Timeline' }),
    h('ol', { class: 'timeline' }, steps.map(([lbl, d]) => {
      const dd = daysUntil(d, o.today);
      // For forecasted / pre-release records every step after the release is an estimate: label it so, and show a
      // passed estimate dimmed as "date passed" rather than as a completed step.
      if (est && lbl !== 'Release') {
        const passed = dd != null && dd < 0;
        return h('li', { class: 'est' + (passed ? ' est-passed' : '') + (dd === 0 ? ' today' : ''), title: 'Estimated date' },
          h('span', { class: 'lbl', text: 'Est. ' + lbl.toLowerCase() }), h('span', { class: 'when', text: fmtDate(d) }),
          h('span', { class: 'rel', text: passed ? 'date passed' : relDays(dd) }));
      }
      return h('li', { class: (dd != null && dd <= 0 ? 'past' : '') + (dd === 0 ? ' today' : '') },
        h('span', { class: 'lbl', text: lbl }), h('span', { class: 'when', text: fmtDate(d) }), h('span', { class: 'rel', text: relDays(dd) }));
    }))) : null;

  // description
  let desc;
  if (full) {
    const paras = String(full.description || r.summary || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
    desc = paras.length ? paras.map(p => h('p', { text: p })) : h('p', { class: 'dim', text: 'No description provided by the source. See the official solicitation.' });
  } else if (o.full instanceof Error) {
    desc = [r.summary && h('p', { text: r.summary }), h('p', { class: 'dim small', text: 'Full description unavailable: ' + o.full.message })];
  } else {
    desc = [r.summary && h('p', { text: r.summary }), h('div', { class: 'loading-line', 'aria-hidden': 'true' }), h('div', { class: 'loading-line', 'aria-hidden': 'true', style: 'width:70%' })];
  }
  const descSec = h('section', { class: 'd-section' }, h('h2', { text: 'Description' }), h('div', { class: 'd-desc', 'aria-busy': full || o.full instanceof Error ? 'false' : 'true' }, desc));

  // links
  const links = Object.entries(r.links || {}).filter(([, u]) => u && /^https?:\/\//i.test(u));
  const linkSec = links.length ? h('section', { class: 'd-section' }, h('h2', { text: 'Links' }),
    h('div', { class: 'd-links' }, links.map(([k, u]) => h('div', null,
      h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, svg(ICONS.external, 14), ' ', LINK_LABELS[k] || k),
      h('span', { class: 'dim small', text: ' — ' + hostOf(u) }),
      // DSIP's app ignores deep-link parameters: tell the user what to search for there
      k === 'dod_dsip' && r.topic_number ? h('span', { class: 'small link-hint' }, ' · search for ', h('code', { text: r.topic_number })) : null)))) : null;

  // changelog (if the build provides it on the record)
  const events = Array.isArray(r.changelog) ? r.changelog : Array.isArray(r.history) ? r.history : [];
  const logSec = events.length ? h('section', { class: 'd-section' }, h('h2', { text: 'History' }),
    h('ul', { class: 'changelog' }, [...events].sort((a, b) => String(b.at).localeCompare(String(a.at))).map(ev =>
      h('li', null, h('b', { text: fmtDate(ev.at) }), ' · ', EVENT_LABELS[ev.event] || ev.event,
        ev.from || ev.to ? ` (${STATUS_LABELS[ev.from] || ev.from || '—'} → ${STATUS_LABELS[ev.to] || ev.to || '—'})` : '')))) : null;

  // extra (bounded source-specific leftovers)
  const extra = full && full.extra && typeof full.extra === 'object' ? Object.entries(full.extra).filter(([, v]) => v != null && v !== '') : [];
  const extraSec = extra.length ? h('section', { class: 'd-section' }, h('h2', { text: 'Other fields' }),
    h('dl', { class: 'd-grid' }, extra.flatMap(([k, v]) => [h('dt', { text: k.replace(/_/g, ' ') }), h('dd', { text: typeof v === 'object' ? JSON.stringify(v) : String(v) })]))) : null;

  container.replaceChildren(h('article', { class: 'd-wrap', 'aria-labelledby': 'detailTitle' },
    toolbar, tags, title, grid, timeline, profSec, descSec, linkSec, logSec, extraSec));
  return { title };
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Placeholder for an id that is not in the catalog. */
export function renderMissing(container, id, backHref) {
  container.replaceChildren(h('div', { class: 'd-wrap' },
    h('div', { class: 'd-toolbar' }, h('a', { class: 'btn small d-back', href: backHref }, svg(ICONS.back, 16), 'Back')),
    h('h2', { class: 'd-title', tabindex: '-1', id: 'detailTitle', text: 'Topic not found' }),
    h('p', { class: 'dim' }, 'No record with id ', h('code', { text: id }), ' is in the current data. It may have been removed from the catalog, or the link is mistyped.')));
}

/** Empty state for wide screens. */
export function renderEmpty(container, template) {
  container.replaceChildren(template.cloneNode(true));
}
