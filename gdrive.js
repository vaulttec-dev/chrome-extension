// gdrive.js — чисті функції Google Drive (приймають OAuth-токен аргументом).
// Спільні для service worker (importScripts) і content script (content_scripts.js[]):
// жодного chrome.* / стану, токен передається ззовні. У content script токен бере
// service worker (бо chrome.identity недоступний у content scripts) і віддає рядком.
(function (g) {
  // Помилка з HTTP-статусом — щоб виклик міг відловити 401 і оновити токен.
  function httpError(stage, status) {
    const e = new Error(stage + ' ' + status);
    e.status = status;
    return e;
  }

  // Знайти або створити теку name всередині parentId (або в корені My Drive).
  async function getOrCreateFolder(token, name, parentId) {
    const safe = name.replace(/'/g, "\\'");
    let q = `mimeType='application/vnd.google-apps.folder' and name='${safe}' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw httpError('folder search', r.status);
    const d = await r.json();
    let id = d.files && d.files[0] && d.files[0].id;
    if (!id) {
      const body = { name, mimeType: 'application/vnd.google-apps.folder' };
      if (parentId) body.parents = [parentId];
      const c = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!c.ok) throw httpError('folder create', c.status);
      id = (await c.json()).id;
    }
    return id;
  }

  // Тека конкретної зустрічі: «Meeting Recordings» / «РРРР-ММ-ДД» / baseName.
  // Відео й конспект однієї зустрічі лягають сюди разом.
  async function getMeetingFolderId(token, baseName) {
    const root = await getOrCreateFolder(token, 'Meeting Recordings', null);
    const day = (baseName.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const parent = day ? await getOrCreateFolder(token, day, root) : root;
    return getOrCreateFolder(token, baseName, parent);
  }

  // Залити blob у теку зустрічі шматками по 32 МіБ через resumable-сесію Drive.
  // Головне: сесія (uploadUrl) переживає обрив вкладки — наступна спроба продовжує
  // з байта, на якому зупинились (сесія Drive живе ~тиждень), а не з нуля.
  // opts = { uploadUrl?, folderId?, onSession?(uploadUrl, folderId), onProgress?(pct) }:
  //   uploadUrl/folderId — сесія попередньої спроби (з журналу запису);
  //   onSession — кличеться одразу після створення сесії, щоб зберегти її в журнал;
  //   onProgress — відсоток залитого, для банера.
  const UPLOAD_CHUNK = 32 * 1024 * 1024; // кратно 256 КіБ — вимога протоколу Drive

  async function uploadResumable(token, blob, name, opts) {
    const o = opts || {};
    let folderId = o.folderId || null;
    let uploadUrl = o.uploadUrl || null;
    let offset = 0;

    if (uploadUrl) {
      // Скільки байтів сесія вже прийняла? 308 → продовжуємо; 2xx → усе вже залито
      // минулого разу; інше (404/410) → сесія померла, починаємо нову.
      const probe = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes */${blob.size}` }
      });
      if (probe.status === 308) {
        const range = probe.headers.get('Range'); // "bytes=0-N" або нічого (0 байт)
        offset = range ? parseInt(range.split('-')[1], 10) + 1 : 0;
      } else if (probe.ok) {
        const file = await probe.json();
        return { fileId: file.id, folderId };
      } else {
        uploadUrl = null;
      }
    }

    if (!uploadUrl) {
      if (!folderId) folderId = await getMeetingFolderId(token, name.replace(/\.webm$/i, ''));
      const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: [folderId] })
      });
      if (!init.ok) throw httpError('init', init.status);
      uploadUrl = init.headers.get('Location');
      if (!uploadUrl) throw new Error('no upload url'); // Location не дійшов (CORS?) → фолбек локально
      offset = 0;
      if (o.onSession) try { o.onSession(uploadUrl, folderId); } catch (_) {}
    }

    while (offset < blob.size) {
      const end = Math.min(offset + UPLOAD_CHUNK, blob.size);
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` },
        body: blob.slice(offset, end)
      });
      if (put.status === 308) {
        const range = put.headers.get('Range');
        offset = range ? parseInt(range.split('-')[1], 10) + 1 : end;
      } else if (put.ok) {
        if (o.onProgress) try { o.onProgress(100); } catch (_) {}
        const file = await put.json();
        return { fileId: file.id, folderId };
      } else {
        throw httpError('put', put.status);
      }
      if (o.onProgress) try { o.onProgress(Math.round((offset / blob.size) * 100)); } catch (_) {}
    }
    throw new Error('upload не завершився'); // останній шматок мав повернути 2xx
  }

  // Створити Google Doc із конспекту в теці folderId (multipart → конвертація з markdown).
  async function createDriveDoc(token, folderId, name, text) {
    const boundary = 'meetrec_doc_boundary';
    const meta = JSON.stringify({
      name,
      parents: [folderId],
      mimeType: 'application/vnd.google-apps.document'
    });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      meta,
      `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n`,
      text,
      `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });

    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body
    });
    if (!r.ok) throw httpError('doc create', r.status);
    return r.json();
  }

  g.GDrive = { httpError, getOrCreateFolder, getMeetingFolderId, uploadResumable, createDriveDoc };
})(globalThis);
