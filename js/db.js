// IndexedDB persistence for project JSON and imported media blobs.
const DB_NAME = 'premiere-web';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  putFile: (key, blob) => tx('files', 'readwrite', s => s.put(blob, key)),
  getFile: key => tx('files', 'readonly', s => s.get(key)),
  delFile: key => tx('files', 'readwrite', s => s.delete(key)),
  fileKeys: () => tx('files', 'readonly', s => s.getAllKeys()),
  putProject: (key, json) => tx('projects', 'readwrite', s => s.put(json, key)),
  getProject: key => tx('projects', 'readonly', s => s.get(key)),
  async clearFiles() { return tx('files', 'readwrite', s => s.clear()); },
};

export async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { }
}
