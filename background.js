// background.js — service worker: бейдж/стан, OAuth-токен для content script,
// резервна зупинка, і фонова Gemini-обробка через chrome.alarms.
// Захоплення, запис і великі аплоади (Drive/Gemini) — у content script.
importScripts('gdrive.js', 'gemini.js');

const GEMINI_ALARM = 'geminiPoll';
const GEMINI_MAX_TICKS = 12; // ~6 хв при періоді 0.5 хв

function setStatus(text) { chrome.storage.local.set({ lastStatus: text }); }

// ---- OAuth токен (chrome.identity доступний лише тут, не в content script) ----

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

// Виконати fn(token); якщо токен прострочений (401) — скинути з кешу й повторити раз.
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

// ---- Повідомлення ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;

  switch (msg.type) {
    case 'BADGE':
      if (msg.on) {
        // tabId у storage (не в пам'яті SW): переживає засинання worker'а під час запису,
        // тож резервна зупинка з попапа знаходить вкладку навіть після сну.
        chrome.storage.local.set({ isRecording: true, recordingTabId: sender.tab ? sender.tab.id : null });
        chrome.action.setBadgeText({ text: 'REC' });
        chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      } else {
        chrome.storage.local.set({ isRecording: false, recordingTabId: null });
        chrome.action.setBadgeText({ text: '' });
      }
      break;

    case 'STATUS':
      chrome.storage.local.set({ lastStatus: msg.text });
      break;

    case 'STOP':
      // Натиснуто «Зупинити» в попапі → переслати у вкладку, де йде запис.
      chrome.storage.local.get('recordingTabId').then(({ recordingTabId }) => {
        if (recordingTabId != null) {
          chrome.tabs.sendMessage(recordingTabId, { target: 'content', type: 'STOP' });
        }
      });
      break;

    case 'GET_TOKEN':
      getToken(true)
        .then((token) => sendResponse({ ok: true, token }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'REFRESH_TOKEN':
      // content отримав 401 → скинути старий токен і видати свіжий.
      (async () => {
        if (msg.token) await removeCachedToken(msg.token);
        try { sendResponse({ ok: true, token: await getToken(true) }); }
        catch (e) { sendResponse({ ok: false, error: e.message }); }
      })();
      return true;

    case 'GEMINI_CONTINUE':
      // content залив відео в Gemini → ведемо дрібну обробку у фоні (alarms).
      startGeminiJob(msg.job)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
  }
});

// ---- Фонова Gemini-обробка (переживає засинання SW через chrome.alarms) ----
// job = { geminiFileName, fileUri, mimeType, docName, meetingBaseName, folderId }

async function startGeminiJob(job) {
  await chrome.storage.local.set({ geminiJob: { ...job, ticks: 0 } });
  setStatus('Роблю конспект через Gemini…');
  await chrome.alarms.create(GEMINI_ALARM, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GEMINI_ALARM) pollGeminiJob();
});

// Захист від накладання тиків: generateContent може тривати довше за період alarm
// (30 с) — без guard наступний tick згенерував би й зберіг конспект удруге.
let geminiBusy = false;

async function pollGeminiJob() {
  if (geminiBusy) return;
  geminiBusy = true;
  try {
    const { geminiJob: job, geminiApiKey } = await chrome.storage.local.get(['geminiJob', 'geminiApiKey']);
    if (!job || !geminiApiKey) { await chrome.alarms.clear(GEMINI_ALARM); return; }

    try {
      const file = await Gemini.geminiGetFile(job.geminiFileName, geminiApiKey);

      if (file.state === 'PROCESSING') {
        job.ticks = (job.ticks || 0) + 1;
        if (job.ticks >= GEMINI_MAX_TICKS) {
          await finishGeminiJob('Конспект не вдалося зробити: тайм-аут обробки відео');
        } else {
          await chrome.storage.local.set({ geminiJob: job });
        }
        return;
      }
      if (file.state === 'FAILED') {
        await finishGeminiJob('Конспект не вдалося зробити: Gemini не обробив відео');
        return;
      }

      // ACTIVE → генеруємо конспект і кладемо у Drive (або локально .txt).
      const text = await Gemini.geminiGenerate(file.uri || job.fileUri, file.mimeType || job.mimeType, geminiApiKey);
      await finishGeminiJob(await saveDoc(job, text));
    } catch (e) {
      console.warn('[MeetRec] Gemini помилка:', e);
      await finishGeminiJob('Конспект не вдалося зробити: ' + ((e && e.message) || e));
    }
  } finally {
    geminiBusy = false;
  }
}

// Зберегти конспект; повертає статус-рядок. Кидає лише якщо й Drive, і локально не вдалося.
async function saveDoc(job, text) {
  try {
    await withFreshToken(async (token) => {
      const folderId = job.folderId || await GDrive.getMeetingFolderId(token, job.meetingBaseName);
      await GDrive.createDriveDoc(token, folderId, job.docName, text);
    });
    return 'Конспект готовий ✓ — у теці «Запис зустрічей»';
  } catch (docErr) {
    console.warn('[MeetRec] Doc у Drive не вдалося, зберігаю локально:', docErr);
    await download('data:text/plain;charset=utf-8,' + encodeURIComponent(text), job.docName + '.txt');
    return 'Конспект готовий ✓ — збережено локально (.txt)';
  }
}

async function finishGeminiJob(status) {
  await chrome.alarms.clear(GEMINI_ALARM);
  await chrome.storage.local.remove('geminiJob');
  setStatus(status);
}
