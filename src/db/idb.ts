// A minimal promise wrapper around IndexedDB (no library).

const DB_NAME = 'serifwriter';
const DB_VERSION = 1;

export type StoreName = 'projects' | 'sections' | 'snapshots' | 'snapshotData' | 'templates' | 'assets' | 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const mk = (name: string, opts: IDBObjectStoreParameters, indexes: [string, string][] = []) => {
        if (db.objectStoreNames.contains(name)) return;
        const s = db.createObjectStore(name, opts);
        for (const [n, k] of indexes) s.createIndex(n, k);
      };
      mk('projects', { keyPath: 'id' });
      mk('sections', { keyPath: 'id' }, [['projectId', 'projectId']]);
      mk('snapshots', { keyPath: 'id' }, [['projectId', 'projectId']]);
      mk('snapshotData', { keyPath: 'id' });
      mk('templates', { keyPath: 'id' });
      mk('assets', { keyPath: 'id' }, [['projectId', 'projectId']]);
      mk('kv', {});
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: close so it can proceed, reopen lazily.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB open blocked by another tab');
  });
  return dbPromise;
}

export function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).get(key));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).getAll());
}

export async function getAllByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).index(index).getAll(key));
}

export async function getAllKeysByIndex(store: StoreName, index: string, key: IDBValidKey): Promise<IDBValidKey[]> {
  const db = await openDB();
  return promisify(db.transaction(store).objectStore(store).index(index).getAllKeys(key));
}

export type Op =
  | { store: StoreName; put: any; key?: IDBValidKey }
  | { store: StoreName; del: IDBValidKey };

/** Applies several writes atomically in one transaction. */
export async function write(ops: Op[]): Promise<void> {
  if (!ops.length) return;
  const db = await openDB();
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(stores, 'readwrite', { durability: 'strict' } as any);
  for (const op of ops) {
    const s = tx.objectStore(op.store);
    if ('put' in op) {
      if (op.key !== undefined) s.put(op.put, op.key);
      else s.put(op.put);
    } else s.delete(op.del);
  }
  await done(tx);
}

export const put = (store: StoreName, value: any, key?: IDBValidKey) => write([{ store, put: value, key }]);
export const del = (store: StoreName, key: IDBValidKey) => write([{ store, del: key }]);
