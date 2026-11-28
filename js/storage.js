export const STORE_KEY = 'loom_companion_proto_v1';
export const IDB_NAME = 'LoomCompanionDB';
export const IDB_STORE = 'kv';

// ---- Async Storage Adapter ----
export const StorageAdapter = (() => {
  let dbPromise = null;

  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('No IndexedDB'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error('IDB open failed'));
      };
    });
    return dbPromise;
  }

  async function get(key) {
    try {
      const db = await openDB();
      const val = await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (val !== undefined && val !== null) return val;
    } catch {}

    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        await set(key, parsed).catch(() => {});
        return parsed;
      }
    } catch (err) {
      try {
        const broken = localStorage.getItem(key);
        if (broken) localStorage.setItem(`roomi_corrupt_backup_${Date.now()}`, broken.slice(0, 120000));
      } catch {}
      window.__roomiCorruptNotice = true;
    }
    return null;
  }

  async function set(key, value) {
    let idbOk = false;
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(reqErrorOrDefault(tx.error));
        tx.onabort = () => reject(reqErrorOrDefault(tx.error || new Error('IDB transaction aborted')));
      });
      idbOk = true;
    } catch {}

    if (idbOk) return;
    localStorage.setItem(key, JSON.stringify(value));
  }

  function reqErrorOrDefault(err) {
    return err || new Error('IDB write error');
  }

  async function remove(key) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IDB transaction aborted'));
      });
    } catch {}
    try { localStorage.removeItem(key); } catch {}
  }

  return { get, set, remove };
})();
