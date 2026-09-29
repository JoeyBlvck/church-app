// Local stores. Same interface for the browser (IndexedDB) and tests (memory).
// Record shape: { collection, id, data, updatedAt, deleted, dirty, seq, rejected? }
// `seq` is the server-assigned version this device last saw for the record (0 = never
// synced / brand new). Pushes are optimistic-concurrency writes keyed on it, not on clocks.

export function memoryStore() {
  const recs = new Map(), meta = new Map();
  const k = (c, i) => `${c}/${i}`;
  return {
    async get(c, id) { return recs.get(k(c, id)); },
    async put(rec) { recs.set(k(rec.collection, rec.id), { ...rec }); },
    async all(c) { return [...recs.values()].filter((r) => r.collection === c); },
    async dirty() { return [...recs.values()].filter((r) => r.dirty); },
    async getMeta(key) { return meta.get(key); },
    async setMeta(key, v) { meta.set(key, v); },
    async deleteMeta(key) { meta.delete(key); },
    async clear() { recs.clear(); meta.clear(); },
    async wipeData() { recs.clear(); meta.delete('cursor'); meta.delete('lastSync'); },
    async everything() { return [...recs.values()]; },
  };
}

export function idbStore(name = 'church') {
  const open = new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const s = db.createObjectStore('records', { keyPath: ['collection', 'id'] });
      s.createIndex('collection', 'collection');
      db.createObjectStore('meta');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async (store, mode, fn) => {
    const db = await open;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    get: (c, id) => run('records', 'readonly', (s) => s.get([c, id])),
    put: (rec) => run('records', 'readwrite', (s) => s.put(rec)),
    all: (c) => run('records', 'readonly', (s) => s.index('collection').getAll(c)),
    dirty: async () => (await run('records', 'readonly', (s) => s.getAll())).filter((r) => r.dirty),
    getMeta: (k) => run('meta', 'readonly', (s) => s.get(k)),
    setMeta: (k, v) => run('meta', 'readwrite', (s) => s.put(v, k)),
    deleteMeta: (k) => run('meta', 'readwrite', (s) => s.delete(k)),
    wipeData: async () => { await run('records', 'readwrite', (s) => s.clear()); await run('meta', 'readwrite', (s) => { s.delete('cursor'); s.delete('lastSync'); }); },
    everything: () => run('records', 'readonly', (s) => s.getAll()),
    clear: async () => { await run('records', 'readwrite', (s) => s.clear()); await run('meta', 'readwrite', (s) => s.clear()); },
  };
}
