// background.js — service worker: бейдж/стан, OAuth-токен для content script,
// резервна зупинка, і фонова Gemini-обробка через chrome.alarms.
// Захоплення, запис і великі аплоади (Drive/Gemini) — у content script.
importScripts('logstore.js', 'gdrive.js', 'gemini.js');

const GEMINI_ALARM = 'geminiPoll';
const GEMINI_MAX_TICKS = 60; // ~30 хв при періоді 0.5 хв — багатогодинне аудіо довго в стані PROCESSING
const GEMINI_MAX_ERRORS = 8; // ~4 хв повторів — разовий збій мережі чи 503 від Gemini не вбиває конспект
// Додаток до промпту при повторі після обрізання (MAX_TOKENS) — вимагаємо стисліший формат.
const CONCISE_HINT = '\n\nВАЖЛИВО: попередня спроба конспекту вийшла надто довгою і обірвалася по ліміту. ' +
  'Цього разу пиши значно стисліше: синтез по темах, БЕЗ цитування окремих реплік і БЕЗ таймкодів.';

function setStatus(text) {
  chrome.storage.local.set({ lastStatus: text });
  MRLog.log('info', 'status', text);
}

// Системна нотифікація — головний канал для фонового конспекту (вкладку Meet уже закрито).
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: String(message || '')
    });
  } catch (e) {
    MRLog.log('warn', 'notify', e);
  }
}

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

// ---- Offscreen-документ для диктофона (мікрофон + Gemini + буфер) ----
// Content script не має доступу до chrome.offscreen, тож документ створює тут SW.
let offscreenCreating = null;
async function ensureOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctxs.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'CLIPBOARD'],
      justification: 'Запис мікрофона для голосової транскрипції та копіювання тексту в буфер.'
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
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

    case 'DICT_START':
      (async () => {
        try {
          const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
          if (!geminiApiKey) {
            sendResponse({ ok: false, error: 'Немає Gemini API-ключа — додайте його в попапі розширення.' });
            return;
          }
          await ensureOffscreen();
          const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start' });
          if (res && res.code === 'mic') {
            // Дозволу на мікрофон ще нема — відкриваємо видиму вкладку для одноразового запиту.
            chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
          }
          sendResponse(res || { ok: false, error: 'offscreen не відповів' });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    case 'DICT_STOP':
      (async () => {
        try {
          const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
          if (res && res.ok) {
            MRLog.log('info', 'dict', res.text ? ('Транскрипт скопійовано (' + res.text.length + ' симв.)') : 'Порожньо — мовлення не розпізнано');
          } else {
            MRLog.log('error', 'dict', (res && res.error) || 'offscreen не відповів');
          }
          sendResponse(res || { ok: false, error: 'offscreen не відповів' });
        } catch (e) {
          MRLog.log('error', 'dict', e.message);
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    case 'GEMINI_CONTINUE':
      // content залив відео в Gemini → ведемо дрібну обробку у фоні (alarms).
      startGeminiJob(msg.job)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GEMINI_REDO':
      // Кнопка «Повторити конспект» у popup: перезапустити останній job зі стислішим
      // форматом. Працює, поки аудіо-файл живе в Gemini (~48 год після зустрічі).
      chrome.storage.local.get('lastGeminiJob').then(({ lastGeminiJob }) => {
        if (!lastGeminiJob) { sendResponse({ ok: false, error: 'немає попереднього конспекту' }); return; }
        startGeminiJob({ ...lastGeminiJob, retryConcise: true })
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
      });
      return true;
  }
});

// ---- Фонова Gemini-обробка (переживає засинання SW через chrome.alarms) ----
// Черга завдань у storage.local.geminiJobs — конспекти НЕ перезаписують одне одного,
// коли накладаються (нова зустріч, поки попередній конспект ще вариться; відновлення).
// job = { geminiFileName, fileUri, mimeType, docName, meetingBaseName, folderId, ticks, errors }

// Усі read-modify-write черги — через один ланцюжок, щоб push і видалення не губили одне одного.
let queueChain = Promise.resolve();
function withQueue(fn) {
  const p = queueChain.then(fn, fn);
  queueChain = p.then(() => {}, () => {});
  return p;
}
async function readQueue() {
  const { geminiJobs } = await chrome.storage.local.get('geminiJobs');
  return Array.isArray(geminiJobs) ? geminiJobs : [];
}
function sameJob(a, b) { return a && b && a.geminiFileName === b.geminiFileName; }

async function startGeminiJob(job) {
  await withQueue(async () => {
    const jobs = await readQueue();
    jobs.push({ ...job, ticks: 0, errors: 0 });
    await chrome.storage.local.set({ geminiJobs: jobs });
  });
  setStatus('Роблю конспект через Gemini…');
  await chrome.alarms.create(GEMINI_ALARM, { periodInMinutes: 0.5 });
}

// Оновити поля завдання в черзі (шукаємо за geminiFileName — він унікальний на аплоад).
function patchJob(job, patch) {
  return withQueue(async () => {
    const jobs = await readQueue();
    const i = jobs.findIndex((j) => sameJob(j, job));
    if (i >= 0) {
      jobs[i] = { ...jobs[i], ...patch };
      await chrome.storage.local.set({ geminiJobs: jobs });
    }
  });
}

// Прибрати завдання з черги + статус і нотифікація; alarm гасимо, лише коли черга порожня.
// Останній job лишаємо в lastGeminiJob — кнопка «Повторити конспект» у popup перезапускає
// його, поки аудіо живе в Gemini (~48 год): рятує обрізані/невдалі конспекти без перезапису.
async function finishJob(job, status, ok) {
  await withQueue(async () => {
    const jobs = (await readQueue()).filter((j) => !sameJob(j, job));
    await chrome.storage.local.set({ geminiJobs: jobs, lastGeminiJob: { ...job, ticks: 0, errors: 0 } });
    if (!jobs.length) await chrome.alarms.clear(GEMINI_ALARM);
  });
  MRLog.log(ok ? 'info' : 'error', 'gemini', status, { rec: job.meetingBaseName });
  setStatus(status);
  notify(ok ? 'Конспект готовий' : 'Конспект: проблема', status);
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
    // Міграція одиночного geminiJob зі старої версії розширення в чергу.
    const { geminiJob: legacy } = await chrome.storage.local.get('geminiJob');
    if (legacy) {
      await chrome.storage.local.remove('geminiJob');
      await withQueue(async () => {
        const jobs = await readQueue();
        jobs.push({ ticks: 0, errors: 0, ...legacy });
        await chrome.storage.local.set({ geminiJobs: jobs });
      });
    }

    const jobs = await readQueue();
    if (!jobs.length) { await chrome.alarms.clear(GEMINI_ALARM); return; }

    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) {
      // Без ключа завдання не виконати ніколи — чесно завершуємо, а не тримаємо вічно.
      for (const j of jobs) MRLog.log('error', 'gemini', 'Конспект скасовано: не задано Gemini-ключ', { rec: j.meetingBaseName });
      await withQueue(() => chrome.storage.local.set({ geminiJobs: [] }));
      await chrome.alarms.clear(GEMINI_ALARM);
      notify('Конспект: проблема', 'Не задано Gemini API-ключ — конспект скасовано');
      return;
    }

    const job = jobs[0]; // обробляємо послідовно: одна генерація за раз, решта чекає в черзі
    try {
      const file = await Gemini.geminiGetFile(job.geminiFileName, geminiApiKey);

      if (file.state === 'PROCESSING') {
        const ticks = (job.ticks || 0) + 1;
        if (ticks >= GEMINI_MAX_TICKS) await finishJob(job, 'Конспект не вдалося зробити: тайм-аут обробки аудіо', false);
        else await patchJob(job, { ticks });
        return;
      }
      if (file.state === 'FAILED') {
        await finishJob(job, 'Конспект не вдалося зробити: Gemini не обробив аудіо', false);
        return;
      }

      // ACTIVE → генеруємо конспект і кладемо у Drive (або локально .txt).
      const ctx = ((job.speakerContext || '') + (job.retryConcise ? CONCISE_HINT : '')) || null;
      const { text, finishReason } = await Gemini.geminiGenerate(file.uri || job.fileUri, file.mimeType || job.mimeType, geminiApiKey, ctx);
      const truncated = finishReason && finishReason !== 'STOP';
      if (truncated && !job.retryConcise) {
        // Обрізалося по ліміту → НЕ зберігаємо огризок, а автоматично повторюємо
        // наступним тиком зі стислішим форматом (одна повторна спроба).
        MRLog.log('warn', 'gemini', 'Конспект обрізано (' + finishReason + ') — автоматично повторюю стисліше', { rec: job.meetingBaseName });
        await patchJob(job, { retryConcise: true });
        return;
      }
      if (truncated) MRLog.log('warn', 'gemini', 'Конспект знову обрізано (' + finishReason + ') — зберігаю як є', { rec: job.meetingBaseName });
      let status = await saveDoc(job, text);
      if (truncated) status += ' (увага: конспект може бути неповним — ' + finishReason + ')';
      await finishJob(job, status, !truncated);
    } catch (e) {
      // Разова помилка мережі/503 не вбиває конспект — повторюємо наступними тиками.
      const errors = (job.errors || 0) + 1;
      const msg = (e && e.message) || String(e);
      if (errors >= GEMINI_MAX_ERRORS) {
        await finishJob(job, 'Конспект не вдалося зробити: ' + msg, false);
      } else {
        MRLog.log('warn', 'gemini', 'Спроба ' + errors + '/' + GEMINI_MAX_ERRORS + ' не вдалася, повторю за 30 с: ' + msg, { rec: job.meetingBaseName });
        await patchJob(job, { errors });
      }
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
    return 'Конспект готовий ✓ — у теці «Meeting Recordings»';
  } catch (docErr) {
    MRLog.log('warn', 'gemini', 'Doc у Drive не вдалося, зберігаю локально .txt: ' + ((docErr && docErr.message) || docErr));
    await download('data:text/plain;charset=utf-8,' + encodeURIComponent(text), job.docName + '.txt');
    return 'Конспект готовий ✓ — збережено локально (.txt)';
  }
}

// Страховка: chrome.alarms не гарантовано переживають перезапуск браузера. Якщо в черзі
// лишилися конспекти (браузер закрили, поки вони робились) — переозброюємо alarm на
// кожному старті SW; onStartup-слухач гарантує, що SW прокинеться на старті браузера.
// Гаряча клавіша диктофона → тогл у активній вкладці (content script dictation.js).
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-dictation') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { target: 'content', type: 'DICT_TOGGLE' }, () => void chrome.runtime.lastError);
    }
  });
});

chrome.runtime.onStartup.addListener(() => { /* будить SW; переозброєння робить код нижче */ });
chrome.storage.local.get(['geminiJobs', 'geminiJob']).then(({ geminiJobs, geminiJob }) => {
  if ((Array.isArray(geminiJobs) && geminiJobs.length) || geminiJob) {
    chrome.alarms.create(GEMINI_ALARM, { periodInMinutes: 0.5 });
  }
});

// Одноразовий порятунок: якщо lastGeminiJob порожній, підхопити його з seed-файла
// (метадані обрізаного конспекту 15.07 — щоб кнопка «Повторити конспект» його врятувала).
// Після успішного повтору файл seed-lastjob.json можна видалити з теки розширення.
chrome.storage.local.get('lastGeminiJob').then(async ({ lastGeminiJob }) => {
  if (lastGeminiJob) return;
  try {
    const r = await fetch(chrome.runtime.getURL('seed-lastjob.json'));
    if (r.ok) await chrome.storage.local.set({ lastGeminiJob: await r.json() });
  } catch (_) { /* seed нема — і не треба */ }
});
