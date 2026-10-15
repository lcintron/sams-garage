/*
 * Navigation decisions, pure (no DOM, no globals; node --test imports it): the routes, which side-panel mode a
 * window width gets, which panel item a route marks as current, where the back links go, and the side-panel and
 * theme preferences.
 *
 * Routes (hash): #/ list · #/s/<id> detail · #/watch watchlist · #/sql SQL console · #/notify notifications ·
 * #/settings · #/about. The filter state lives in the query of the list routes (#/?q=uas, #/s/<id>?q=uas,
 * #/watch?q=uas&sort=title); the other views keep it untouched, so a way back home still has the last filters. The
 * watchlist uses the search and the sort, not the filters (they are kept for the way back).
 */
import { buildHash } from './filters.js';

/** At this width and above the side panel is a docked column; below it, an overlay drawer. */
export const WIDE_MIN = 1280;

/** @returns {'docked'|'overlay'} */
export const panelMode = width => (width >= WIDE_MIN ? 'docked' : 'overlay');

/** The views other than the list, with their titles. */
export const VIEWS = { sql: 'SQL console', notify: 'Notifications', settings: 'Settings', about: 'About' };

/**
 * A hash path -> a route, or null for an unknown path (the app sends those home).
 * @returns {{name:'list', id:null, mode:'all'|'watch'} | {name:'detail', id:string} | {name:'sql'|'notify'|'settings'|'about'} | null}
 */
export function parseRoute(path) {
  if (path === '/' || path === '') return { name: 'list', id: null, mode: 'all' };
  if (path === '/watch') return { name: 'list', id: null, mode: 'watch' };
  const v = /^\/([a-z]+)$/.exec(path);
  if (v && Object.hasOwn(VIEWS, v[1])) return { name: v[1] };
  const m = path.match(/^\/s\/(.+)$/);
  if (m) { try { return { name: 'detail', id: decodeURIComponent(m[1]) }; } catch { return { name: 'detail', id: m[1] }; } }
  return null;
}

/** Which main view a route shows: 'list' (the list, with the detail beside or over it) or one of VIEWS. */
export const viewOf = route => (route && Object.hasOwn(VIEWS, route.name) ? route.name : 'list');

/** Whether the route's query is the filter state (the list routes); the other views leave the state as it was. */
export const keepsState = route => !!route && (route.name === 'list' || route.name === 'detail');

/**
 * The side-panel item marked current (aria-current="page") for a route.
 * @param {object} route parseRoute's result
 * @param {'all'|'watch'} listMode which list a detail belongs to
 * @returns {'home'|'watch'|'sql'|'notify'|'settings'|'about'|null}
 */
export function activeNav(route, listMode = 'all') {
  if (!route) return null;
  if (route.name === 'list') return route.mode === 'watch' ? 'watch' : 'home';
  if (route.name === 'detail') return listMode === 'watch' ? 'watch' : 'home';
  return Object.hasOwn(VIEWS, route.name) ? route.name : null;
}

/** The filters show on the list of all topics and its detail; not on the watchlist or the other views. */
export const showsFilters = (route, listMode = 'all') => activeNav(route, listMode) === 'home';

/** A view away from home: the watchlist, the other views. Esc there goes home (a detail goes back to its list). */
export const isSecondary = route => !!route && route.name !== 'detail' && activeNav(route) !== 'home' && activeNav(route) !== null;

/** Home with the filters as they are: the target of every "← Opportunities" back link. */
export const homeHref = state => buildHash('/', state);
/** The watchlist. Its query carries the whole state: the search and the sort apply there, the filters wait for home. */
export const watchHref = state => buildHash('/watch', state);

/** Document title of a view. */
export const viewTitle = name => (Object.hasOwn(VIEWS, name) ? VIEWS[name] : 'Open topics') + " · SAM's Garage";

/**
 * Whether the docked panel is collapsed. The preference was called filtersCollapsed when the panel held only the
 * filters; it is read when panelCollapsed has never been set.
 */
export const panelCollapsedPref = p => (p && typeof p.panelCollapsed === 'boolean' ? p.panelCollapsed : !!(p && p.filtersCollapsed));

/** The theme choice in the preferences: 'light', 'dark' or 'system' (no choice saved: follow the system). */
export const themeChoice = p => (p && (p.theme === 'light' || p.theme === 'dark') ? p.theme : 'system');
