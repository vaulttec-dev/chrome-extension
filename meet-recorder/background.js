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

// ---- Повідомлення ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;

  switch (msg.type) {
    case 'BADGE':
      if (msg.on) {
        chrome.storage.local.set({ isRecording: true });
        chrome.action.setBadgeText({ text: 'REC' });
        chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      } else {
        chrome.storage.local.set({ isRecording: false });
        chrome.action.setBadgeText({ text: '' });
      }
      break;

    case 'STATUS':
      chrome.storage.local.set({ lastStatus: msg.text });
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
// Черга завдань у storage.local.geminiJobs — конспекти НЕ перезаписують одне одного,
// коли накладаються (нова зустріч, поки попередній конспект ще вариться; відновлення).
// job = { geminiFileName, fileUri, mimeType, meetingBaseName, folderId, speakerContext,
//         audioDriveId, durationMs, stage: 'transcribe' | 'summarize', transcript, ticks, errors }
// Два кроки на одну зустріч, по одному на тик: спершу ПОВНИЙ транскрипт (окремий документ),
// потім конспект уже з цього тексту (ще один документ). Після кроку 1 транскрипт лежить у job,
// тож конспект ретраїться без Gemini-файлу й без повторної розшифровки.

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
    jobs.push({ ...job, stage: job.stage || 'transcribe', ticks: 0, errors: 0, createdAt: job.createdAt || Date.now(), nextTryAt: 0 });
    await chrome.storage.local.set({ geminiJobs: jobs });
  });
  setStatus('Роблю транскрипт через Gemini…');
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
async function finishJob(job, status, ok) {
  await withQueue(async () => {
    const jobs = (await readQueue()).filter((j) => !sameJob(j, job));
    await chrome.storage.local.set({ geminiJobs: jobs });
    if (!jobs.length) await chrome.alarms.clear(GEMINI_ALARM);
  });
  MRLog.log(ok ? 'info' : 'error', 'gemini', status, { rec: job.meetingBaseName });
  setStatus(status);
  notify(ok ? 'Конспект готовий' : 'Конспект: проблема', status);
  // Аудіо-доріжку з Drive НЕ прибираємо: вона — постійний член теки зустрічі (відео, аудіо,
  // транскрипт, конспект) і джерело, з якого транскрипт можна перезробити будь-коли.
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
    const stage = job.stage || 'transcribe';
    if (Date.now() - createdAt > GEMINI_DEADLINE_MS) {
      // Файл у Gemini потрібен лише для транскрипту; конспект робиться з тексту в job.
      if (stage === 'transcribe' && await tryReuploadFromDrive(job, geminiApiKey)) return;
      await finishJob(job, stage === 'transcribe'
        ? 'Транскрипт не вдалося зробити за 46 год — аудіо в Gemini вже видалено. Відео й аудіо зустрічі є у Drive.'
        : 'Конспект не вдалося зробити за 46 год. Транскрипт і відео зустрічі є у Drive.', false);
      return;
    }

    try {
      if (stage === 'transcribe') {
        // ---- Крок 1: ПОВНИЙ транскрипт → окремий документ у теці ----
        // Транскрипт міг уже бути в job (SW помер між розшифровкою і збереженням) —
        // тоді не платимо за повторну розшифровку, лише дозберігаємо.
        let text = job.transcript || '';
        if (!text) {
          const file = await Gemini.geminiGetFile(job.geminiFileName, geminiApiKey);
          if (file.state === 'PROCESSING') return; // чекаємо далі — дедлайн і так обмежує
          if (file.state === 'FAILED') {
            await finishJob(job, 'Транскрипт не вдалося зробити: Gemini не обробив аудіо (файл FAILED)', false);
            return;
          }
          // ACTIVE → спеціалізована модель; для довгих записів чи порожньої відповіді
          // geminiTranscribeFile сам іде запасним шляхом і каже чому (onFallback → лог).
          const r = await Gemini.geminiTranscribeFile(
            file.uri || job.fileUri, file.mimeType || job.mimeType, geminiApiKey, job.durationMs || null,
            (why) => MRLog.log('warn', 'gemini', 'Транскрипт: перемикаюсь на запасну модель — ' + why, { rec: job.meetingBaseName })
          );
          if (looksDegenerate(r.text)) throw new Error('транскрипт виродився (repetition collapse)');
          if (!r.text) {
            // Обидві моделі мовчать → у записі, найімовірніше, немає мовлення. Конспект без
            // змісту не робимо; документ із чесною позначкою лишаємо, щоб тека не «зависла».
            await saveDoc(job, transcriptDocName(job), 'Мовлення не розпізнано — запис порожній або без звуку.');
            await finishJob(job, 'Транскрипт порожній: мовлення не розпізнано. Відео й аудіо зустрічі є у Drive.', false);
            return;
          }
          if (r.finishReason && r.finishReason !== 'STOP') MRLog.log('warn', 'gemini', 'Транскрипт обрізано (' + r.finishReason + ') — зберігаю як є', { rec: job.meetingBaseName });
          text = r.text;
          MRLog.log('info', 'gemini', 'Транскрипт готовий (' + r.model + ', ' + text.length + ' симв.)', { rec: job.meetingBaseName });
          await patchJob(job, { transcript: text });
        }
        await saveDoc(job, transcriptDocName(job), text);
        setStatus('Транскрипт готовий ✓ — роблю конспект…');
        await patchJob(job, { stage: 'summarize', errors: 0, nextTryAt: 0 });
        return; // конспект — наступним тиком: один тик = одна довга генерація
      }

      // ---- Крок 2: конспект із транскрипту → ще один документ; тека — за темою ----
      const ctx = ((job.speakerContext || '') + (job.retryConcise ? CONCISE_HINT : '')) || null;
      const { text, finishReason } = await Gemini.geminiSummarize(job.transcript || '', geminiApiKey, ctx);
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
      let status = await saveSummary(job, text);
      if (truncated) status += ' (увага: конспект може бути неповним — ' + finishReason + ')';
      await finishJob(job, status, !truncated);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // Файл видалено з Gemini (403/404) — перезаливаємо з Drive-джерела; без нього завершуємо.
      if (/file get (403|404)/.test(msg)) {
        if (await tryReuploadFromDrive(job, geminiApiKey)) return;
        await finishJob(job, 'Транскрипт не вдалося зробити: аудіо вже видалено з Gemini. Відео й аудіо зустрічі є у Drive.', false);
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

// Імена документів у теці зустрічі: «<база> — транскрипт» і «<база> — конспект».
// docName лишається для завдань, поставлених у чергу ще старим content script.
function transcriptDocName(job) { return job.meetingBaseName + ' — транскрипт'; }
function summaryDocName(job) { return job.docName || (job.meetingBaseName + ' — конспект'); }

// Зберегти текст Google-документом у теку зустрічі; якщо Drive не вдався — локально .txt.
// Повертає 'drive' | 'local'; кидає лише якщо не вдалося ніяк.
async function saveDoc(job, name, text) {
  try {
    await withFreshToken(async (token) => {
      const folderId = job.folderId || await GDrive.getMeetingFolderId(token, job.meetingBaseName);
      await GDrive.createDriveDoc(token, folderId, name, text);
    });
    MRLog.log('info', 'save', 'Документ збережено в Drive: ' + name, { rec: job.meetingBaseName });
    return 'drive';
  } catch (docErr) {
    MRLog.log('warn', 'gemini', 'Doc «' + name + '» у Drive не вдалося, зберігаю локально .txt: ' + ((docErr && docErr.message) || docErr), { rec: job.meetingBaseName });
    await download('data:text/plain;charset=utf-8,' + encodeURIComponent(text), name + '.txt');
    return 'local';
  }
}

// Зберегти конспект; повертає статус-рядок. Перший рядок відповіді Gemini — службова
// «ТЕМА: …»: у документ вона не потрапляє, натомість нею перейменовуємо теку зустрічі
// («Тема — дата час»). Перейменування — ПІСЛЯ збереження: якщо воно впаде, конспект уже на місці.
async function saveSummary(job, raw) {
  const { topic, text } = Gemini.splitTopic(raw);
  const where = await saveDoc(job, summaryDocName(job), text);
  if (where !== 'drive') return 'Конспект готовий ✓ — збережено локально (.txt)';

  const nice = topic && meetingFolderName(topic, job.meetingBaseName);
  if (nice && nice !== job.meetingBaseName) {
    try {
      await withFreshToken(async (token) => {
        const folderId = job.folderId || await GDrive.getMeetingFolderId(token, job.meetingBaseName);
        await GDrive.renameFile(token, folderId, nice);
      });
      MRLog.log('info', 'save', 'Теку зустрічі перейменовано: ' + nice, { rec: job.meetingBaseName });
    } catch (e) {
      MRLog.log('warn', 'save', 'Не вдалося перейменувати теку зустрічі: ' + ((e && e.message) || e), { rec: job.meetingBaseName });
    }
  }
  return 'Конспект готовий ✓ — транскрипт і конспект у теці «Meeting Recordings»';
}

// Назва теки зустрічі: «Тема — РРРР-ММ-ДД ГГ-ХХ». Дату й час беремо з базового імені
// запису (там «Meet <код> РРРР-ММ-ДД ГГ-ХХ-СС»); без них перейменування не робимо —
// теки без дати сортувалися б у Drive як попало.
function meetingFolderName(topic, baseName) {
  const m = String(baseName || '').match(/(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2})/);
  return m ? `${topic} — ${m[1]} ${m[2]}` : null;
}

// Страховка: chrome.alarms не гарантовано переживають перезапуск браузера. Якщо в черзі
// лишилися конспекти (браузер закрили, поки вони робились) — переозброюємо alarm на
// кожному старті SW; onStartup-слухач гарантує, що SW прокинеться на старті браузера.
chrome.runtime.onStartup.addListener(() => { /* будить SW; переозброєння робить код нижче */ });

chrome.storage.local.get('geminiJobs').then(({ geminiJobs }) => {
  if (Array.isArray(geminiJobs) && geminiJobs.length) {
    chrome.alarms.create(GEMINI_ALARM, { periodInMinutes: 0.5 });
  }
});

// Прибирання ключів, що лишилися від старих версій (redo-кнопка, legacy-джоб, tabId,
// диктофон — тепер окреме розширення).
chrome.storage.local.remove(['lastGeminiJob', 'geminiJob', 'recordingTabId', 'dictRecording', 'dictPhase', 'dictLast']);
