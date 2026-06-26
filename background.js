// background.js — service worker: бейдж/стан + збереження у Google Drive або локально
// + авто-конспект через Gemini.
// Захоплення й запис відбуваються в content script (сторінка Meet має дозвіл на мікрофон).

let recordingTabId = null;

// ---- Gemini (авто-конспект) ----
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_PROMPT = `Ти — досвідчений асистент із протоколювання робочих зустрічей.
Тобі дано ЗАПИС зустрічі Google Meet. Спирайся ВИКЛЮЧНО на те, що РЕАЛЬНО СКАЗАНО вголос
(аудіо), а не на те, що видно на екрані. Уважно «прослухай» увесь запис від початку до кінця
і не пропусти жодної важливої деталі.

Спершу подумки зроби ПОВНУ розшифровку всього мовлення, а потім на її основі склади
ДЕТАЛЬНИЙ конспект УКРАЇНСЬКОЮ у форматі Markdown:

# Короткий підсумок
2–4 речення про головне.

## Перебіг обговорення
Детально, пунктами: усі теми й важливі деталі, що прозвучали (цифри, дати, імена, домовленості,
аргументи). Не скорочуй до загальних фраз — фіксуй конкретику.

## Ухвалені рішення
- Кожне рішення окремим пунктом.

## Завдання та доручення
Перелічи ВСІ завдання, доручення й домовленості, що були ОЗВУЧЕНІ, навіть згадані мимохідь.
Формат кожного пункту: «Виконавець — що зробити — до коли». Якщо щось не назване — постав «—».
Краще включити сумнівне завдання, ніж пропустити.

## Відкриті питання
- Питання, що лишилися без відповіді.

Якщо в записі реально немає мовлення або воно нерозбірливе — прямо так і напиши. Пиши
українською, конкретно; нічого важливого не вигадуй і не пропускай.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function setStatus(text) { chrome.storage.local.set({ lastStatus: text }); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;

  switch (msg.type) {
    case 'BADGE':
      if (msg.on) {
        recordingTabId = sender.tab ? sender.tab.id : null;
        chrome.storage.local.set({ isRecording: true });
        chrome.action.setBadgeText({ text: 'REC' });
        chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      } else {
        recordingTabId = null;
        chrome.storage.local.set({ isRecording: false });
        chrome.action.setBadgeText({ text: '' });
      }
      break;

    case 'STATUS':
      chrome.storage.local.set({ lastStatus: msg.text });
      break;

    case 'STOP':
      // Натиснуто «Зупинити» в попапі → переслати у вкладку, де йде запис.
      if (recordingTabId != null) {
        chrome.tabs.sendMessage(recordingTabId, { target: 'content', type: 'STOP' });
      }
      break;

    case 'SAVE':
      handleSave(msg.dataUrl, msg.name).then(sendResponse);
      return true; // відповідь асинхронна
  }
});

// Зберегти відео, а потім (якщо налаштовано ключ) зробити конспект через Gemini.
// Відповідь повертаємо лише в кінці — щоб service worker не вимкнувся посеред Gemini-обробки.
async function handleSave(dataUrl, name) {
  const res = await saveRecording(dataUrl, name);
  await processWithGemini(dataUrl, name); // оновлює lastStatus; ніколи не кидає виняток
  return res;
}

async function saveRecording(dataUrl, name) {
  // Спершу Drive; якщо не вдалося (зокрема ще не налаштований OAuth) — локально.
  try {
    await uploadToDrive(dataUrl, name);
    return { ok: true, where: 'drive' };
  } catch (driveErr) {
    console.warn('[MeetRec] Drive недоступний, зберігаю локально:', driveErr);
    try {
      await download(dataUrl, name);
      return { ok: true, where: 'local' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

function download(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'download failed'));
      } else {
        resolve(id);
      }
    });
  });
}

// ---- Google Drive ----

function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no token'));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// Помилка з HTTP-статусом, щоб withFreshToken міг відловити 401.
function httpError(stage, status) {
  const e = new Error(stage + ' ' + status);
  e.status = status;
  return e;
}

// Виконати fn(token); якщо токен прострочений (401) — скинути з кешу й повторити один раз.
async function withFreshToken(fn) {
  let token = await getToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (e && e.status === 401) {
      await removeCachedToken(token);
      token = await getToken(true);
      return await fn(token);
    }
    throw e;
  }
}

async function getFolderId(token) {
  const q = "mimeType='application/vnd.google-apps.folder' and name='Запис зустрічей' and trashed=false";
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw httpError('folder search', r.status);
  const d = await r.json();
  let id = d.files && d.files[0] && d.files[0].id;
  if (!id) {
    const c = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Запис зустрічей', mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!c.ok) throw httpError('folder create', c.status);
    id = (await c.json()).id;
  }
  return id;
}

async function uploadToDrive(dataUrl, name) {
  const blob = await (await fetch(dataUrl)).blob();
  return withFreshToken((token) => uploadWithToken(token, blob, name));
}

async function uploadWithToken(token, blob, name) {
  const folderId = await getFolderId(token);

  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [folderId] })
  });
  if (!init.ok) throw httpError('init', init.status);

  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('no upload url');

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/webm' },
    body: blob
  });
  if (!put.ok) throw httpError('put', put.status);
  return put.json();
}

// Створити Google Doc із конспекту в тій самій теці (multipart → конвертація в Google Doc).
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

// ---- Gemini: завантаження файлу + генерація конспекту ----

// Залити відео у Gemini Files API (resumable) → повертає { name, uri, state, mimeType }.
async function geminiUploadFile(blob, key) {
  const start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': 'video/webm',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: 'meet-recording' } })
  });
  if (!start.ok) throw new Error('gemini upload start ' + start.status);

  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('gemini: немає upload url');

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(blob.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: blob
  });
  if (!up.ok) throw new Error('gemini upload ' + up.status);
  return (await up.json()).file;
}

// Відео обробляється асинхронно — чекаємо, доки стане ACTIVE.
async function geminiWaitActive(file, key) {
  let f = file;
  for (let i = 0; i < 60; i++) { // ~5 хв максимум
    if (f.state === 'ACTIVE') return f;
    if (f.state === 'FAILED') throw new Error('gemini: обробка файлу не вдалася');
    await sleep(5000);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${f.name}`, {
      headers: { 'x-goog-api-key': key }
    });
    if (!r.ok) throw new Error('gemini file get ' + r.status);
    f = await r.json();
  }
  throw new Error('gemini: тайм-аут обробки файлу');
}

// Згенерувати конспект із завантаженого файлу.
async function geminiGenerate(fileUri, mimeType, key) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { file_data: { mime_type: mimeType || 'video/webm', file_uri: fileUri } },
            { text: GEMINI_PROMPT }
          ]
        }],
        generationConfig: {
          mediaResolution: 'MEDIA_RESOLUTION_LOW',
          temperature: 0.3,
          maxOutputTokens: 8192
        }
      })
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('gemini generate ' + r.status + ' ' + t.slice(0, 200));
  }
  const d = await r.json();
  const parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
  const text = parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
  if (!text) throw new Error('gemini: порожня відповідь');
  return text;
}

// Оркестрація: відео → Gemini → конспект → Google Doc (або локальний .txt як резерв).
async function processWithGemini(dataUrl, name) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return; // функція вимкнена, доки немає ключа

  const docName = `${name.replace(/\.webm$/i, '')} — конспект`;
  try {
    setStatus('Роблю конспект через Gemini…');
    const blob = await (await fetch(dataUrl)).blob();
    const file = await geminiUploadFile(blob, geminiApiKey);
    const ready = await geminiWaitActive(file, geminiApiKey);
    const text = await geminiGenerate(ready.uri, ready.mimeType, geminiApiKey);

    try {
      await withFreshToken(async (token) => {
        const folderId = await getFolderId(token);
        await createDriveDoc(token, folderId, docName, text);
      });
      setStatus('Конспект готовий ✓ — у теці «Запис зустрічей»');
    } catch (docErr) {
      console.warn('[MeetRec] Doc у Drive не вдалося, зберігаю локально:', docErr);
      await download('data:text/plain;charset=utf-8,' + encodeURIComponent(text), docName + '.txt');
      setStatus('Конспект готовий ✓ — збережено локально (.txt)');
    }
  } catch (e) {
    console.warn('[MeetRec] Gemini помилка:', e);
    setStatus('Конспект не вдалося зробити: ' + ((e && e.message) || e));
  }
}
