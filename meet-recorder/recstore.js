// recstore.js — журнал запису в IndexedDB: шматки MediaRecorder пишуться на диск
// під час дзвінка, тож обрив (закрита вкладка / краш / вимкнене світло) не губить
// дані. При наступному відкритті Meet незавершену сесію можна до-зберегти одним
// файлом. Підключається в content_scripts перед content.js → globalThis.RecStore.
(function (g) {
  const DB_NAME = 'meetrec';
  // v2 додає складений індекс 'rid_kind' → дешевий count() відео-шматків без читання Blob.
  // Міграція лише додає індекс; наявні сесії (без поля kind) зберігаються.
  const DB_VERSION = 2;
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
        let chunks;
        if (!db.objectStoreNames.contains('chunks')) {
          // autoIncrement → монотонний порядок вставки; індекс 'rid' групує шматки сесії.
          chunks = db.createObjectStore('chunks', { keyPath: 'seq', autoIncrement: true });
          chunks.createIndex('rid', 'rid', { unique: false });
        } else {
          chunks = req.transaction.objectStore('chunks');
        }
        if (!chunks.indexNames.contains('rid_kind')) {
          chunks.createIndex('rid_kind', ['rid', 'kind'], { unique: false });
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

  // Оновити метадані сесії (напр. videoSaved після успішного аплоаду відео) — щоб
  // відновлення знало, що лишився тільки конспект, і не дублювало відео в Drive.
  async function updateSession(id, patch) {
    await tx('recordings', 'readwrite', (t) => {
      const store = t.objectStore('recordings');
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) store.put({ ...req.result, ...patch }); };
    });
  }

  // Дописати шматок доріжки сесії id (на диск). kind: 'video' (типово) або 'audio'.
  async function appendChunk(id, blob, kind = 'video') {
    await tx('chunks', 'readwrite', (t) => {
      t.objectStore('chunks').add({ rid: id, kind, blob });
    });
  }

  // Зібрати всі шматки однієї доріжки сесії в один Blob (за порядком вставки).
  // Старі записи без поля kind трактуємо як 'video'.
  async function readBlob(id, mime, kind = 'video') {
    const parts = await tx('chunks', 'readonly', (t) =>
      reqDone(t.objectStore('chunks').index('rid').getAll(IDBKeyRange.only(id))));
    const wanted = (parts || []).filter((p) => (p.kind || 'video') === kind);
    return new Blob(wanted.map((p) => p.blob), { type: mime || 'video/webm' });
  }

  // Кількість відео-шматків сесії (≈ секунди запису при recorder.start(1000)) — дешево, без читання Blob.
  // Складеним індексом рахуємо лише доріжку 'video', щоб паралельні аудіо-шматки не подвоювали тривалість.
  // Старі сесії (kind=undefined) у складений індекс не потрапляють → 0 (банер просто без тривалості).
  async function countChunks(id) {
    return tx('chunks', 'readonly', (t) =>
      reqDone(t.objectStore('chunks').index('rid_kind').count(IDBKeyRange.only([id, 'video']))));
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

  g.RecStore = { startSession, updateSession, appendChunk, readBlob, countChunks, listOrphans, deleteSession, pruneOld };
})(globalThis);
