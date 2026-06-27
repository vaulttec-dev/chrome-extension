// recstore.js — журнал запису в IndexedDB: шматки MediaRecorder пишуться на диск
// під час дзвінка, тож обрив (закрита вкладка / краш / вимкнене світло) не губить
// дані. При наступному відкритті Meet незавершену сесію можна до-зберегти одним
// файлом. Підключається в content_scripts перед content.js → globalThis.RecStore.
(function (g) {
  const DB_NAME = 'meetrec';
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recordings')) {
          db.createObjectStore('recordings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chunks')) {
          // autoIncrement → монотонний порядок вставки; індекс 'rid' групує шматки сесії.
          const cs = db.createObjectStore('chunks', { keyPath: 'seq', autoIncrement: true });
          cs.createIndex('rid', 'rid', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
    });
    return dbPromise;
  }

  // Виконати операцію в транзакції; resolve значенням resultFn(stores...) після commit.
  async function tx(storeNames, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error || new Error('tx failed'));
      t.onabort = () => reject(t.error || new Error('tx aborted'));
      out = fn(t);
    });
  }

  function reqDone(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Почати сесію. meta = { id, name, code, mime, startedAt }. Повертає id.
  async function startSession(meta) {
    await tx('recordings', 'readwrite', (t) => {
      t.objectStore('recordings').put({ ...meta, status: 'recording' });
    });
    return meta.id;
  }

  // Дописати шматок відео сесії id (на диск).
  async function appendChunk(id, blob) {
    await tx('chunks', 'readwrite', (t) => {
      t.objectStore('chunks').add({ rid: id, blob });
    });
  }

  // Зібрати всі шматки сесії в один Blob (за порядком вставки).
  async function readBlob(id, mime) {
    const parts = await tx('chunks', 'readonly', (t) =>
      reqDone(t.objectStore('chunks').index('rid').getAll(IDBKeyRange.only(id))));
    return new Blob((parts || []).map((p) => p.blob), { type: mime || 'video/webm' });
  }

  // Кількість шматків сесії (≈ секунди запису при recorder.start(1000)) — дешево, без читання Blob.
  async function countChunks(id) {
    return tx('chunks', 'readonly', (t) =>
      reqDone(t.objectStore('chunks').index('rid').count(IDBKeyRange.only(id))));
  }

  // Усі незавершені сесії (видалені = вже збережені), найновіші першими.
  async function listOrphans() {
    const all = await tx('recordings', 'readonly', (t) =>
      reqDone(t.objectStore('recordings').getAll()));
    return (all || []).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  // Видалити сесію разом з її шматками.
  async function deleteSession(id) {
    await tx(['recordings', 'chunks'], 'readwrite', (t) => {
      t.objectStore('recordings').delete(id);
      const idx = t.objectStore('chunks').index('rid');
      const cur = idx.openCursor(IDBKeyRange.only(id));
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { c.delete(); c.continue(); }
      };
    });
  }

  // Прибрати покинуті сесії, старші за maxAgeDays, щоб IndexedDB не ріс безмежно.
  async function pruneOld(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const stale = (await listOrphans()).filter((s) => (s.startedAt || 0) < cutoff);
    for (const s of stale) await deleteSession(s.id);
    return stale.length;
  }

  g.RecStore = { startSession, appendChunk, readBlob, countChunks, listOrphans, deleteSession, pruneOld };
})(globalThis);
