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

  // Тека конкретної зустрічі: «Запис зустрічей» / «РРРР-ММ-ДД» / baseName.
  // Відео й конспект однієї зустрічі лягають сюди разом.
  async function getMeetingFolderId(token, baseName) {
    const root = await getOrCreateFolder(token, 'Запис зустрічей', null);
    const day = (baseName.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const parent = day ? await getOrCreateFolder(token, day, root) : root;
    return getOrCreateFolder(token, baseName, parent);
  }

  // Залити blob у теку зустрічі (resumable upload, бо відео часто > 5 МБ —
  // ліміту multipart). Повертає { fileId, folderId }: folderId переюзається
  // для конспекту, щоб service worker не шукав теку вдруге.
  async function uploadResumable(token, blob, name) {
    const folderId = await getMeetingFolderId(token, name.replace(/\.webm$/i, ''));

    const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [folderId] })
    });
    if (!init.ok) throw httpError('init', init.status);

    const uploadUrl = init.headers.get('Location');
    if (!uploadUrl) throw new Error('no upload url'); // Location не дійшов (CORS?) → фолбек локально

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: blob
    });
    if (!put.ok) throw httpError('put', put.status);
    const file = await put.json();
    return { fileId: file.id, folderId };
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
