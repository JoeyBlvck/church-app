// A store for Node scripts (no IndexedDB available) that persists to one local JSON file.
// Implements the exact same interface as app/js/store.js's memoryStore/idbStore, so the
// already-tested sync client (app/js/sync.js) works unmodified against it — see
// hikvision-bridge.js, which is really just another local-first "device".
import { readFile, writeFile } from 'node:fs/promises';

export function fileStore(path) {
  let loaded = null;
  const load = async () => {
    if (loaded) return loaded;
    try { loaded = JSON.parse(await readFile(path, 'utf8')); }
    catch { loaded = { records: {}, meta: {} }; }
    return loaded;
  };
  const save = async () => writeFile(path, JSON.stringify(loaded, null, 2));
  const key = (c, id) => `${c}/${id}`;

  return {
    async get(c, id) { return (await load()).records[key(c, id)]; },
    async put(rec) { const s = await load(); s.records[key(rec.collection, rec.id)] = { ...rec }; await save(); },
    async all(c) { return Object.values((await load()).records).filter((r) => r.collection === c); },
    async dirty() { return Object.values((await load()).records).filter((r) => r.dirty); },
    async getMeta(k) { return (await load()).meta[k]; },
    async setMeta(k, v) { const s = await load(); s.meta[k] = v; await save(); },
    async clear() { loaded = { records: {}, meta: {} }; await save(); },
    async wipeData() { const s = await load(); s.records = {}; delete s.meta.cursor; delete s.meta.lastSync; await save(); },
    async everything() { return Object.values((await load()).records); },
  };
}
