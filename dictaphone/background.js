// background.js — диктофон: гаряча клавіша або кнопка в попапі. Перше натискання —
// запис із мікрофона, друге — транскрипт через Gemini у буфер обміну. Стан — бейдж на
// іконці (REC / …) і storage для попапа; результат — системна нотифікація.
//
// MediaRecorder живе в offscreen-документі (chrome.offscreen створює лише SW). Він же —
// єдине джерело правди про «чи йде запис»: SW може перезапуститись посеред запису,
// а offscreen — ні. storage — лише кеш для миттєвого малювання попапа.

const COMMAND = 'toggle-dictation';

let busy = false; // серіалізуємо натискання, щоб клік+клавіша не наклалися
let offscreenCreating = null;

// phase: 'idle' | 'recording' | 'busy'; last: { ok, len } або { ok:false, error }
function setPhase(phase, last) {
  if (phase === 'recording') {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } else if (phase === 'busy') {
    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
  const patch = { dictPhase: phase };
  if (last !== undefined) patch.dictLast = last;
  return chrome.storage.local.set(patch).catch(() => {});
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: String(message || '')
    });
  } catch (e) {
    console.warn('[Dict] notify', e);
  }
}

async function fail(error) {
  await setPhase('idle', { ok: false, error });
  notify('Диктофон: помилка', error);
}

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
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
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (_) { /* уже закритий */ }
}

async function isRecording() {
  if (!(await hasOffscreen())) return false;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'state' });
    return !!(r && r.recording);
  } catch (_) {
    return false; // документ є, але скрипт ще/вже не слухає — записом це не вважаємо
  }
}

// Звіряє кеш попапа з реальністю: застрягле 'recording'/'busy' (SW чи розширення
// перезапустилось) скидається в 'idle'.
async function syncPhase() {
  if (await isRecording()) {
    await setPhase('recording');
    return 'recording';
  }
  if (busy) return 'busy';
  const { dictPhase } = await chrome.storage.local.get('dictPhase');
  if (dictPhase === 'recording' || dictPhase === 'busy') {
    await setPhase('idle', { ok: false, error: 'Попередній запис обірвався (розширення перезапустилось). Спробуйте ще раз.' });
  }
  return 'idle';
}

async function start() {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) {
    await fail('Немає Gemini API-ключа — вставте його у вікні розширення.');
    return;
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start' });
  if (res && res.ok) {
    await setPhase('recording', null);
    return;
  }
  await closeOffscreen();
  if (res && res.code === 'mic') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
    await fail('Надайте доступ до мікрофона у вкладці, що відкрилась, і спробуйте знову.');
  } else {
    await fail((res && res.error) || 'не вдалося почати запис');
  }
}

// Мікрофон звільняє сам offscreen (вимикає трек). Документ НЕ закриваємо: закриття
// offscreen лишає застряглі privacy-іконки в COSMIC.
async function stop() {
  await setPhase('busy');
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  let res;
  try { res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', key: geminiApiKey }); }
  catch (e) { res = { ok: false, error: e.message }; }
  if (res && res.ok) {
    const len = (res.text || '').length;
    await setPhase('idle', { ok: true, len });
    notify('Диктофон', len ? `✓ Скопійовано ${len} симв. — вставте через Ctrl+V.` : 'Порожньо — мовлення не розпізнано.');
  } else {
    await fail((res && res.error) || 'offscreen не відповів');
  }
}

async function toggle() {
  if (busy) return;
  busy = true;
  try {
    if (await isRecording()) await stop();
    else await start();
  } catch (e) {
    await fail((e && e.message) || String(e));
  } finally {
    busy = false;
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === COMMAND) toggle();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'bg') return;
  if (msg.type === 'TOGGLE') {
    toggle().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'STATE') {
    syncPhase()
      .then((phase) => chrome.storage.local.get('dictLast').then(({ dictLast }) => sendResponse({ ok: true, phase, last: dictLast })))
      .catch((e) => sendResponse({ ok: false, phase: 'idle', error: e.message }));
    return true;
  }
});

// Скидання — лише на старті браузера та оновленні розширення. НЕ в top-level: SW
// прокидається посеред запису, і top-level closeOffscreen убивав би запис.
function reset() {
  setPhase('idle');
  closeOffscreen();
}
chrome.runtime.onStartup.addListener(reset);
chrome.runtime.onInstalled.addListener(reset);
