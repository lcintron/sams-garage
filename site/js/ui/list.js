/*
 * Results list: renders result cards incrementally (first 50, then 50 more whenever the end scrolls into view) and
 * handles keyboard navigation (↑/↓/Home/End between cards, Enter follows the card link).
 */
import { h, svg, ICONS, encodeId, dateLabel, isEstimated } from './dom.js';
import { STATUS_LABELS } from '../filters.js';
import { daysUntil, todayISO } from '../search.js';

const PAGE = 50;

/**
 * @param {HTMLElement} container  the #list element (also the scroll root)
 * @param {{ hrefFor:(id)=>string, onStar:(id)=>boolean, onOpen:(id)=>void }} handlers
 */
export function createList(container, handlers) {
  let results = [];
  let shown = 0;
  let opts = {};
  let sentinel = null;

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) more(); }, { root: container, rootMargin: '600px 0px' })
    : null;

  function card(r) {
    const rec = r.rec;
    const watched = opts.watch?.has(rec.id);
    const days = r.days;
    const closeL = dateLabel(rec, 'close', days);
    // forecasted / pre-release: also show the (estimated) open date
    const openL = isEstimated(rec) ? dateLabel(rec, 'open', daysUntil(rec.open_date, todayISO())) : null;
    const progBits = [rec.program, (rec.phases || []).length ? 'Phase ' + rec.phases.join(', ') : null].filter(Boolean).join(' · ');

    // profile matches: active profiles with their terms + score; inactive matches as a dim hint
    let prof = null;
    if (r.profile) {
      const bits = [];
      for (const [pid, terms] of Object.entries(r.profile.matched)) {
        const p = opts.profilesById?.get(pid);
        if (!p) continue;
        const active = opts.activeProfiles?.includes(pid);
        bits.push(h('span', { class: 'p' + (active ? '' : ' inactive'), title: `${p.name} profile: ${terms.join(', ')}` }, '#' + p.name),
          active ? h('span', { class: 'terms', text: terms.slice(0, 4).join(', ') }) : null);
      }
      if (bits.length) {
        prof = h('div', { class: 'prof' }, bits,
          opts.activeProfiles?.length ? h('span', { class: 'score', title: 'Relevance score for the active profiles' }, 'score ' + r.profileScore) : null);
      }
    }

    const el = h('article', { class: 'card' + (rec.id === opts.selectedId ? ' selected' : ''), role: 'listitem', dataset: { id: rec.id } },
      h('div', { class: 'card-top' },
        h('span', { class: 'status ' + (rec.status || 'unknown'), text: STATUS_LABELS[rec.status] || rec.status || 'Unknown' }),
        h('span', { class: 'tag agency', title: rec.sub_agency ? `${rec.agency} / ${rec.sub_agency}` : rec.agency },
          rec.agency || '—', rec.sub_agency ? ' · ' + rec.sub_agency : ''),
        progBits && h('span', { class: 'dim', text: progBits }),
        r.isNew && h('span', { class: 'tag new', title: 'First seen since your last visit', text: 'NEW' })
      ),
      h('h3', { class: 'card-title' },
        h('a', { href: handlers.hrefFor(rec.id), 'aria-current': rec.id === opts.selectedId ? 'true' : null }, rec.title || rec.topic_number || rec.id)),
      h('div', { class: 'card-meta' },
        rec.topic_number && h('span', { class: 'topic', title: 'Topic number' }, rec.topic_number),
        openL && h('span', { class: 'open-date ' + openL.cls, title: 'Estimated open date' }, openL.text),
        closeL
          ? h('span', { class: 'close-date ' + closeL.cls, title: isEstimated(rec) ? 'Estimated close date' : 'Close date' }, closeL.text)
          : h('span', { class: 'dim', text: 'No close date' })
      ),
      (rec.keywords || []).length ? h('div', { class: 'kw' }, rec.keywords.slice(0, 6).map(k => h('span', { class: 'tag', text: k }))) : null,
      prof
    );
    const star = h('button', {
      class: 'star', type: 'button', 'aria-pressed': watched ? 'true' : 'false',
      'aria-label': (watched ? 'Remove from' : 'Add to') + ' watchlist: ' + (rec.title || rec.id),
      title: watched ? 'Remove from watchlist' : 'Add to watchlist'
    }, svg(ICONS.star));
    star.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const on = handlers.onStar(rec.id);
      star.setAttribute('aria-pressed', on ? 'true' : 'false');
      star.title = on ? 'Remove from watchlist' : 'Add to watchlist';
      star.setAttribute('aria-label', (on ? 'Remove from' : 'Add to') + ' watchlist: ' + (rec.title || rec.id));
    });
    el.appendChild(star);
    return el;
  }

  function more() {
    if (shown >= results.length) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(results.length, shown + PAGE);
    for (let i = shown; i < end; i++) frag.appendChild(card(results[i]));
    shown = end;
    if (sentinel) sentinel.remove();
    container.appendChild(frag);
    if (shown < results.length) {
      sentinel = h('div', { class: 'more' },
        h('button', { class: 'btn small', type: 'button', onclick: () => more(), text: `Show more (${results.length - shown} left)` }));
      container.appendChild(sentinel);
      io?.observe(sentinel);
    } else {
      sentinel = null;
    }
  }

  /**
   * Render results. opts: { selectedId, watch:Set, profilesById:Map, activeProfiles:[], empty: Node, keepScroll }
   */
  function render(newResults, newOpts = {}) {
    const keepScroll = newOpts.keepScroll;
    const prevTop = container.scrollTop;
    const prevShown = shown;
    results = newResults;
    opts = newOpts;
    io?.disconnect();
    container.replaceChildren();
    shown = 0;
    sentinel = null;
    if (!results.length) {
      container.appendChild(newOpts.empty || h('p', { class: 'empty', text: 'No results.' }));
      return;
    }
    more();
    // Keep the same number of cards (and the scroll position) when re-rendering in place, e.g. after a star toggle.
    if (keepScroll) {
      while (shown < Math.min(prevShown, results.length)) more();
      container.scrollTop = prevTop;
    } else {
      container.scrollTop = 0;
    }
  }

  /** Mark the selected card without re-rendering; reveal more cards if it is not rendered yet. */
  function select(id) {
    opts.selectedId = id;
    for (const c of container.querySelectorAll('.card.selected')) {
      c.classList.remove('selected');
      c.querySelector('.card-title a')?.removeAttribute('aria-current');
    }
    if (!id) return;
    const idx = results.findIndex(r => r.rec.id === id);
    while (idx >= shown && shown < results.length) more();
    const el = container.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.add('selected');
      el.querySelector('.card-title a')?.setAttribute('aria-current', 'true');
      const r = el.getBoundingClientRect(), c = container.getBoundingClientRect();
      if (r.top < c.top || r.bottom > c.bottom) el.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Focus the card link for an id (used when returning from the detail view). */
  function focusCard(id) {
    const el = id && container.querySelector(`.card[data-id="${CSS.escape(id)}"] .card-title a`);
    if (el) el.focus({ preventScroll: false });
    return !!el;
  }

  function focusFirst() {
    const a = container.querySelector('.card .card-title a');
    if (a) a.focus();
  }

  // Keyboard: arrows move between cards; the link handles Enter natively.
  container.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'j', 'k'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest('input, textarea, select')) return;
    const links = [...container.querySelectorAll('.card .card-title a')];
    if (!links.length) return;
    const i = links.indexOf(document.activeElement);
    let next = i;
    if (e.key === 'ArrowDown' || e.key === 'j') next = i < 0 ? 0 : Math.min(links.length - 1, i + 1);
    if (e.key === 'ArrowUp' || e.key === 'k') next = i < 0 ? 0 : Math.max(0, i - 1);
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') { while (shown < results.length) more(); next = container.querySelectorAll('.card .card-title a').length - 1; }
    e.preventDefault();
    const target = container.querySelectorAll('.card .card-title a')[next];
    if (target) { target.focus(); target.closest('.card').scrollIntoView({ block: 'nearest' }); }
  });

  // Clicks anywhere on a card follow its link (the title link's ::after covers the card; this is a fallback for
  // assistive tech that clicks the article).
  container.addEventListener('click', e => {
    const c = e.target.closest('.card');
    if (!c || e.target.closest('a, button')) return;
    handlers.onOpen(c.dataset.id);
  });

  return { render, select, focusCard, focusFirst, get results() { return results; } };
}

export { encodeId };
