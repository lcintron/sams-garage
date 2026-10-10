/*
 * Where the public site lives. Shared links (Copy link) use the page's own address when it is served over
 * http(s); the desktop app (app://sg/) links here instead. scripts/assemble-site.sh rewrites PUBLIC_URL (and the
 * same address in index.html's link-preview tags) from the SITE_URL of the deploy, so moving the site to the
 * custom domain is a change in the workflows only.
 */
export const PUBLIC_URL = 'https://lcintron.github.io/sams-garage/';

/** The base address for shareable links: this page's (no hash) when it is on the web, else PUBLIC_URL. */
export function publicBase(loc = globalThis.location, fallback = PUBLIC_URL) {
  return loc && /^https?:$/.test(loc.protocol) ? loc.href.split('#')[0] : fallback;
}

/** A shareable link to a topic: <base>#/s/<id> (":" kept readable, everything else escaped). */
export function topicLink(base, id) {
  return base + '#/s/' + encodeURIComponent(id).replace(/%3A/gi, ':');
}
