/*
 * A small promise wrapper around one IndexedDB key-value store (database "sg", store "kv"), shared by the page and the
 * service worker: the notification settings, their run state, the last report, and copies of the watchlist and the
 * custom keyword profiles (the page mirrors those from localStorage, which a service worker cannot read).
 *
 * A classic script like core.js (no import/export): globalThis.SgIdb. The page imports it for its side effect, sw.js
 * loads it with importScripts. SgIdb.create(factory) makes one over another IndexedDB (tests).
 *
 *   get(key) · set(key, value) · del(key) · update(key, fn)   fn(old) -> new, in one transaction
 *   lock(name, owner, ttlMs) -> boolean · renew(name, owner, ttlMs) -> boolean (only while still held)
 *   unlock(name, owner)                                         a lease shared by page and worker, so a report is
 *                                                                 never sent twice when both check at once
 */
(function (root) {
  'use strict';
  const DB = 'sg', STORE = 'kv', VERSION = 1;

  /**
   * Whether `owner` may take the lock now: it is free, expired, or already theirs (re-entrant: the holder renews it).
   * Owners must be unique per execution context ('page:<uuid>' per tab, 'sw:<uuid>'), never shared. Pure.
   * @param {{owner: string, until: number} | undefined} current
   */
  function canLock(current, owner, now) {
    return !current || typeof current !== 'object' || !(current.until > now) || current.owner === owner;
  }

  function create(factory) {
    let dbp = null;
    const idb = () => factory || root.indexedDB;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const f = idb();
        if (!f) { reject(new Error('IndexedDB is not available')); return; }
        const req = f.open(DB, VERSION);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbp = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
      });
      dbp.catch(() => { dbp = null; });
      return dbp;
    }
    /** Run body(store) in one transaction; resolves with body's result once the transaction has committed. */
    async function tx(mode, body) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
        try { body(t.objectStore(STORE), v => { result = v; }); } catch (e) { try { t.abort(); } catch (e2) { /* gone */ } reject(e); }
      });
    }
    const get = key => tx('readonly', (s, done) => { const r = s.get(key); r.onsuccess = () => done(r.result); });
    const set = (key, value) => tx('readwrite', s => { s.put(value, key); });
    const del = key => tx('readwrite', s => { s.delete(key); });
    /** Read, change and write a value in one transaction (fn must be synchronous). Resolves with the new value. */
    const update = (key, fn) => tx('readwrite', (s, done) => {
      const r = s.get(key);
      r.onsuccess = () => { const next = fn(r.result); s.put(next, key); done(next); };
    });
    /** Take a lease on `name` for ttlMs; false when someone else holds it. */
    const lock = (name, owner, ttlMs, now = Date.now()) => tx('readwrite', (s, done) => {
      const key = 'lock:' + name;
      const r = s.get(key);
      r.onsuccess = () => {
        if (!canLock(r.result, owner, now)) { done(false); return; }
        s.put({ owner, until: now + ttlMs }, key);
        done(true);
      };
    });
    /**
     * Extend a lease this owner still holds: true only when the record exists and is this owner's, expired or not.
     * A lease that someone else took, or that was taken and released meanwhile (unlock deletes it), is lost: false.
     */
    const renew = (name, owner, ttlMs, now = Date.now()) => tx('readwrite', (s, done) => {
      const key = 'lock:' + name;
      const r = s.get(key);
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur || typeof cur !== 'object' || cur.owner !== owner) { done(false); return; }
        s.put({ owner, until: now + ttlMs }, key);
        done(true);
      };
    });
    const unlock = (name, owner) => tx('readwrite', s => {
      const key = 'lock:' + name;
      const r = s.get(key);
      r.onsuccess = () => { if (r.result && r.result.owner === owner) s.delete(key); };
    });
    return { get, set, del, update, lock, renew, unlock };
  }

  root.SgIdb = Object.assign(create(), { create, canLock, DB, STORE });
})(typeof globalThis !== 'undefined' ? globalThis : this);
