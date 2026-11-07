// Minimal key-value store on IndexedDB: the offline outbox and last-seen list snapshots.

const DB = "listas";
const STORE = "kv";

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return db;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest | void): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req?.result as T);
        tx.onerror = tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idbGet = <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key));

export const idbSet = (key: string, value: unknown) => run<void>("readwrite", (s) => void s.put(value, key));

/** Read-modify-write in one transaction, so two tabs can't interleave and lose a write. */
export function idbUpdate<T>(key: string, fn: (current: T | undefined) => T): Promise<T> {
  let next: T;
  return run<void>("readwrite", (s) => {
    const req = s.get(key);
    req.onsuccess = () => {
      next = fn(req.result);
      s.put(next, key);
    };
  }).then(() => next);
}
