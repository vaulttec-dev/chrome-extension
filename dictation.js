// dictation.js — плаваюча кнопка «диктофон» на будь-якій сторінці.
// Клік → старт запису мікрофона, ще клік → стоп + транскрипція Gemini + текст у буфер.
// Сам мікрофон/запис/Gemini/буфер веде offscreen-документ (розширеннєвий origin),
// тож дозвіл на мікрофон дається ОДИН раз на все розширення, а не на кожному сайті.
(function () {
  // Лише у верхньому фреймі й лише один раз на вкладку.
  if (window.top !== window.self) return;
  if (document.getElementById('d2p-dictation-btn')) return;

  let state = 'idle'; // 'idle' | 'recording' | 'busy'
  let toastTimer = null;

  const btn = document.createElement('button');
  btn.id = 'd2p-dictation-btn';
  btn.type = 'button';
  btn.title = 'Диктування → транскрипт у буфер (Gemini) · Alt+Q';
  btn.textContent = '🎤';

  const toast = document.createElement('div');
  toast.id = 'd2p-dictation-toast';

  function mount() {
    const root = document.body || document.documentElement;
    root.appendChild(btn);
    root.appendChild(toast);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  function showToast(msg, ms = 2600) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function setState(next) {
    state = next;
    btn.classList.toggle('rec', next === 'recording');
    btn.classList.toggle('busy', next === 'busy');
    btn.textContent = next === 'recording' ? '⏹' : next === 'busy' ? '⏳' : '🎤';
    btn.disabled = next === 'busy';
    btn.title = next === 'recording'
      ? 'Йде запис — натисніть, щоб зупинити й транскрибувати'
      : next === 'busy'
        ? 'Розшифровую…'
        : 'Диктування → транскрипт у буфер (Gemini) · Alt+Q';
  }

  // sendMessage, що НІКОЛИ не висить: reject → помилка, тиша понад timeoutMs → таймаут.
  function send(msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(t); resolve(r); };
      const t = setTimeout(() => finish({ ok: false, error: 'таймаут — Gemini не відповів' }), timeoutMs);
      chrome.runtime.sendMessage(msg).then(
        (r) => finish(r || { ok: false, error: 'порожня відповідь' }),
        (e) => finish({ ok: false, error: String((e && e.message) || e) })
      );
    });
  }

  async function start() {
    setState('recording');
    showToast('● Запис… говоріть. Натисніть ще раз, щоб зупинити.', 0);
    // START через service worker: лише він може створити offscreen-документ.
    const res = await send({ target: 'bg', type: 'DICT_START' }, 15000);
    if (!res || !res.ok) {
      setState('idle');
      if (res && res.code === 'mic') {
        showToast('Надайте доступ до мікрофона у вкладці, що відкрилась, потім спробуйте знову.', 5000);
      } else {
        showToast('Не вдалося почати: ' + ((res && res.error) || 'невідома помилка'), 4000);
      }
    }
  }

  async function stop() {
    setState('busy');
    showToast('Розшифровую через Gemini…', 0);
    // Ключ читаємо тут (content має chrome.storage) і передаємо в offscreen — там storage немає.
    let key;
    try { ({ geminiApiKey: key } = await chrome.storage.local.get('geminiApiKey')); } catch (_) { /* ключ лишиться undefined */ }
    // STOP — НАПРЯМУ до offscreen (повз SW): аплоад+обробка можуть тривати, а SW засинає.
    const res = await send({ target: 'offscreen', type: 'stop', key }, 90000);
    setState('idle');
    if (res && res.ok) {
      if (res.text) showToast('✓ Скопійовано в буфер (' + res.text.length + ' символів). Вставте: Ctrl+V');
      else showToast('Порожньо — мовлення не розпізнано.');
    } else {
      showToast('Помилка: ' + ((res && res.error) || 'невідома помилка'), 5000);
    }
  }

  function toggle() {
    if (state === 'idle') start();
    else if (state === 'recording') stop();
  }

  btn.addEventListener('click', toggle);

  // Гаряча клавіша (chrome.commands → background → сюди).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'content' && msg.type === 'DICT_TOGGLE') toggle();
  });
})();
