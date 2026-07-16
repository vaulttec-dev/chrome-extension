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

  // Стан запису — ЄДИНИЙ у background (offscreen один на все розширення). Кнопка лише
  // просить background перемкнути й показує результат. Так неможливо запустити другий
  // getUserMedia з іншої вкладки й накопичити «зомбі-мікрофони».
  let busy = false;

  async function toggle() {
    if (busy) return; // не даємо накластися двом запитам toggle
    busy = true;
    // Оптимістично показуємо проміжний стан за локальним відображенням.
    const wasRecording = state === 'recording';
    if (wasRecording) { setState('busy'); showToast('Розшифровую через Gemini…', 0); }
    else { setState('recording'); showToast('● Запис… говоріть. Натисніть ще раз, щоб зупинити.', 0); }

    let key;
    try { ({ geminiApiKey: key } = await chrome.storage.local.get('geminiApiKey')); } catch (_) { /* undefined */ }

    const res = await send({ target: 'bg', type: 'DICT_TOGGLE', key }, 90000);
    busy = false;

    if (!res || !res.ok) {
      setState('idle');
      if (res && res.code === 'mic') showToast('Надайте доступ до мікрофона у вкладці, що відкрилась, потім спробуйте знову.', 5000);
      else showToast('Помилка: ' + ((res && res.error) || 'невідома помилка'), 5000);
      return;
    }
    if (res.recording) {
      setState('recording');
      showToast('● Запис… говоріть. Натисніть ще раз, щоб зупинити.', 0);
    } else {
      setState('idle');
      if (res.text) showToast('✓ Скопійовано в буфер (' + res.text.length + ' символів). Вставте: Ctrl+V');
      else showToast('Порожньо — мовлення не розпізнано.');
    }
  }

  btn.addEventListener('click', toggle);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== 'content') return;
    // Гаряча клавіша (chrome.commands → background → сюди).
    if (msg.type === 'DICT_TOGGLE') toggle();
    // Синхронізація стану між вкладками (broadcast із background).
    else if (msg.type === 'DICT_STATE' && !busy) setState(msg.recording ? 'recording' : 'idle');
  });
})();
