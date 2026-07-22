// background.js — service worker: бейдж/стан, OAuth-токен для content script,
// резервна зупинка, і фонова Gemini-обробка через chrome.alarms.
// Захоплення, запис і великі аплоади (Drive/Gemini) — у content script.
importScripts('logstore.js', 'gdrive.js', 'gemini.js');

const GEMINI_ALARM = 'geminiPoll';
// Гарантія «само запишеться»: job НЕ вбиваємо по лічильниках спроб. Аудіо живе в Gemini
// ~48 год — тож ретраїмо (з наростаючою паузою) аж до дедлайну; фатальними вважаємо лише
// «файл видалено/не обробився». Навіть багатогодинний збій мережі конспект не втрачає.
const GEMINI_DEADLINE_MS = 46 * 60 * 60 * 1000; // ~46 год від створення job
const GEMINI_BACKOFF_MAX_MS = 15 * 60 * 1000;   // пауза між повторами росте до 15 хв
const GEMINI_MAX_REUPLOADS = 5; // перезаливок аудіо з Drive (кожна дає свіжі ~46 год)
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

// ---- Диктофон: offscreen (мікрофон + Gemini + буфер) з ЄДИНИМ станом у SW ----
// Content script не має доступу до chrome.offscreen, тож документ створює/закриває SW.
// Стан запису — у storage (storage.local.dictRecording), щоб пережити засинання SW під
// час довгого запису. offscreen один на все розширення, тож другий getUserMedia неможливий,
// поки йде запис (жодних «зомбі-мікрофонів»).
let dictBusy = false; // серіалізуємо toggle, щоб клік+клавіша не наклалися
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

async function closeOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctxs.length) await chrome.offscreen.closeDocument();
  } catch (_) { /* уже закритий */ }
}

// Синхронізуємо вигляд кнопки в усіх вкладках (запис могли зупинити з іншої вкладки/клавішею).
function broadcastDict(recording) {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) chrome.tabs.sendMessage(t.id, { target: 'content', type: 'DICT_STATE', recording }, () => void chrome.runtime.lastError);
    }
  });
}

async function handleDictToggle(msg, sendResponse) {
  if (dictBusy) { sendResponse({ ok: false, error: 'зачекайте — обробляю попередню дію' }); return; }
  dictBusy = true;
  try {
    const { dictRecording } = await chrome.storage.local.get('dictRecording');
    if (!dictRecording) {
      // ---- СТАРТ ----
      const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
      if (!geminiApiKey) { sendResponse({ ok: false, error: 'Немає Gemini API-ключа — додайте його в попапі розширення.' }); return; }
      await ensureOffscreen();
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start' });
      if (res && res.ok) {
        await chrome.storage.local.set({ dictRecording: true });
        broadcastDict(true);
        sendResponse({ ok: true, recording: true });
      } else {
        if (res && res.code === 'mic') chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
        await closeOffscreen();
        sendResponse({ ok: false, code: res && res.code, error: (res && res.error) || 'не вдалося почати запис' });
      }
    } else {
      // ---- СТОП + транскрипція. Мікрофон звільняє САМ offscreen через track.stop()
      // (як роблять Zed/VS Code). Документ НЕ закриваємо: закриття offscreen лишає
      // застряглі privacy-іконки в COSMIC. Idle-документ без активного треку індикатора не дає.
      let res;
      try { res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', key: msg.key }); }
      catch (e) { res = { ok: false, error: e.message }; }
      await chrome.storage.local.set({ dictRecording: false });
      broadcastDict(false);
      if (res && res.ok) {
        MRLog.log('info', 'dict', res.text ? ('Транскрипт скопійовано (' + res.text.length + ' симв.)') : 'Порожньо — мовлення не розпізнано');
        sendResponse({ ok: true, recording: false, text: res.text });
      } else {
        MRLog.log('error', 'dict', (res && res.error) || 'offscreen не відповів');
        sendResponse({ ok: false, recording: false, error: (res && res.error) || 'помилка транскрипції' });
      }
    }
  } catch (e) {
    // Offscreen НЕ закриваємо: постійний потік мікрофона = одна стабільна трей-іконка
    // (часті open/close засмічують трей COSMIC мертвими записами).
    await chrome.storage.local.set({ dictRecording: false }).catch(() => {});
    broadcastDict(false);
    sendResponse({ ok: false, error: e.message });
  } finally {
    dictBusy = false;
  }
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

    case 'DICT_TOGGLE':
      handleDictToggle(msg, sendResponse);
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
    jobs.push({ ...job, ticks: 0, errors: 0, createdAt: job.createdAt || Date.now(), nextTryAt: 0 });
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

  // Конспект удався → страхове аудіо в Drive більше не потрібне, прибираємо.
  // При невдачі аудіо ЛИШАЄМО — це єдине джерело, з якого конспект ще можна зробити.
  if (ok && job.audioDriveId) {
    try {
      await withFreshToken((token) => GDrive.deleteFile(token, job.audioDriveId));
      MRLog.log('info', 'gemini', 'Страхове аудіо прибрано з Drive', { rec: job.meetingBaseName });
    } catch (e) {
      MRLog.log('warn', 'gemini', 'Не вдалося прибрати страхове аудіо з Drive: ' + ((e && e.message) || e), { rec: job.meetingBaseName });
    }
  }
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

    // Пауза між повторами після помилок (експоненційний backoff) — тик просто пропускаємо.
    if (job.nextTryAt && Date.now() < job.nextTryAt) return;

    // Дедлайн: файл у Gemini живе ~48 год. Якщо є аудіо-джерело в Drive — перезаливаємо
    // його в Gemini (свіжі ~46 год) і продовжуємо; без джерела — чесно завершуємо.
    const createdAt = job.createdAt || Date.now();
    if (!job.createdAt) await patchJob(job, { createdAt });
    if (Date.now() - createdAt > GEMINI_DEADLINE_MS) {
      if (await tryReuploadFromDrive(job, geminiApiKey)) return;
      await finishJob(job, 'Конспект не вдалося зробити за 46 год — аудіо в Gemini вже видалено. Відео зустрічі є у Drive.', false);
      return;
    }

    try {
      const file = await Gemini.geminiGetFile(job.geminiFileName, geminiApiKey);

      if (file.state === 'PROCESSING') return; // чекаємо далі — дедлайн і так обмежує
      if (file.state === 'FAILED') {
        await finishJob(job, 'Конспект не вдалося зробити: Gemini не обробив аудіо (файл FAILED)', false);
        return;
      }

      // ACTIVE → генеруємо конспект і кладемо у Drive (або локально .txt).
      const ctx = ((job.speakerContext || '') + (job.retryConcise ? CONCISE_HINT : '')) || null;
      const { text, finishReason } = await Gemini.geminiGenerate(file.uri || job.fileUri, file.mimeType || job.mimeType, geminiApiKey, ctx);
      const truncated = finishReason && finishReason !== 'STOP';
      const degenerate = looksDegenerate(text); // repetition collapse: «UUUU…» замість конспекту
      if ((truncated || degenerate) && !job.retryConcise) {
        // Сміття/огризок НЕ зберігаємо — автоматично повторюємо стислішим форматом.
        MRLog.log('warn', 'gemini', 'Конспект ' + (degenerate ? 'виродився (повтори символів)' : 'обрізано (' + finishReason + ')') + ' — автоматично повторюю стисліше', { rec: job.meetingBaseName });
        await patchJob(job, { retryConcise: true });
        return;
      }
      if (degenerate) {
        // Повторна спроба теж виродилася — ретраїмо далі з паузою до дедлайну (не зберігаємо сміття).
        throw new Error('вивід виродився повторно (repetition collapse)');
      }
      if (truncated) MRLog.log('warn', 'gemini', 'Конспект знову обрізано (' + finishReason + ') — зберігаю як є', { rec: job.meetingBaseName });
      let status = await saveDoc(job, text);
      if (truncated) status += ' (увага: конспект може бути неповним — ' + finishReason + ')';
      await finishJob(job, status, !truncated);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // Файл видалено з Gemini (403/404) — перезаливаємо з Drive-джерела; без нього завершуємо.
      if (/file get (403|404)/.test(msg)) {
        if (await tryReuploadFromDrive(job, geminiApiKey)) return;
        await finishJob(job, 'Конспект не вдалося зробити: аудіо вже видалено з Gemini. Відео зустрічі є у Drive.', false);
        return;
      }
      // Будь-яка інша помилка (мережа, 5xx, ліміти) конспект НЕ вбиває: повтор із
      // наростаючою паузою (30 с → 1 хв → … → 15 хв) аж до 46-годинного дедлайну.
      const errors = (job.errors || 0) + 1;
      const backoff = Math.min(GEMINI_BACKOFF_MAX_MS, 30000 * Math.pow(2, Math.min(errors - 1, 5)));
      const leftH = Math.max(0, Math.round((GEMINI_DEADLINE_MS - (Date.now() - createdAt)) / 3600000));
      MRLog.log('warn', 'gemini', 'Спроба ' + errors + ' не вдалася (' + msg + ') — повторю за ~' + Math.round(backoff / 60000 || 1) + ' хв, ретраю ще до ' + leftH + ' год', { rec: job.meetingBaseName });
      await patchJob(job, { errors, nextTryAt: Date.now() + backoff });
    }
  } finally {
    geminiBusy = false;
  }
}

// Копія аудіо в Gemini протухла (48 год) → перезалити з постійного джерела в Drive.
// Повертає true, якщо перезалито (job оновлено свіжим файлом і свіжим дедлайном).
async function tryReuploadFromDrive(job, geminiApiKey) {
  if (!job.audioDriveId) return false;
  const reuploads = (job.reuploads || 0) + 1;
  if (reuploads > GEMINI_MAX_REUPLOADS) {
    MRLog.log('error', 'gemini', 'Вичерпано перезаливки аудіо з Drive (' + GEMINI_MAX_REUPLOADS + ') — здаюся', { rec: job.meetingBaseName });
    return false;
  }
  try {
    MRLog.log('info', 'gemini', 'Копія аудіо в Gemini протухла — перезаливаю з Drive (спроба ' + reuploads + '/' + GEMINI_MAX_REUPLOADS + ')', { rec: job.meetingBaseName });
    const blob = await withFreshToken((token) => GDrive.downloadFile(token, job.audioDriveId));
    const file = await Gemini.geminiUploadFile(blob, geminiApiKey, 'audio/webm');
    await patchJob(job, {
      geminiFileName: file.name,
      fileUri: file.uri,
      mimeType: file.mimeType || 'audio/webm',
      createdAt: Date.now(), // свіжий файл → свіжий 46-годинний дедлайн
      reuploads,
      errors: 0,
      nextTryAt: 0
    });
    return true;
  } catch (e) {
    MRLog.log('warn', 'gemini', 'Перезаливка аудіо з Drive не вдалася: ' + ((e && e.message) || e), { rec: job.meetingBaseName });
    // Полічити спробу й відкласти наступну, щоб не молотити щотика.
    await patchJob(job, { reuploads, nextTryAt: Date.now() + GEMINI_BACKOFF_MAX_MS });
    return true; // job живий — повторимо перезаливку пізніше
  }
}

// Репетишн-колапс Gemini: «конспект» із нескінченного повтору одного символу/фрази
// (реальний кейс — суцільні «U»). Один символ понад 40% тексту = сміття, не зберігаємо.
function looksDegenerate(text) {
  if (!text || text.length < 400) return false;
  const counts = {};
  for (const ch of text) { if (ch !== ' ' && ch !== '\n') counts[ch] = (counts[ch] || 0) + 1; }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return false;
  return Math.max(...Object.values(counts)) / total > 0.4;
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
chrome.runtime.onStartup.addListener(() => { /* будить SW; переозброєння робить код нижче */ });

// Скидання стану диктофона — ЛИШЕ на старті браузера та оновленні розширення.
// НЕ в top-level: SW прокидається щопівхвилини (тики конспекту, повідомлення), і
// top-level closeOffscreen убивав би offscreen прямо посеред запису диктофона.
function resetDictation() {
  chrome.storage.local.set({ dictRecording: false });
  closeOffscreen();
}
chrome.runtime.onStartup.addListener(resetDictation);
chrome.runtime.onInstalled.addListener(resetDictation);

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
