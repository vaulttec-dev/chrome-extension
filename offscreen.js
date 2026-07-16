// offscreen.js — невидимий розширеннєвий документ: тримає мікрофон, пише аудіо,
// транскрибує через Gemini і кладе результат у буфер обміну.
// Origin = розширення, тож дозвіл на мікрофон один на все розширення (не на сайт),
// а Gemini-fetch і буфер працюють без обмежень сторінки.
(function () {
  let recorder = null;
  let stream = null;
  let chunks = [];
  let mimeType = 'audio/webm';

  function copyToClipboard(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // Потік мікрофона тримаємо ПОСТІЙНО (не закриваємо між записами): Chrome на Linux
  // реєструє трей-іконку на КОЖНЕ нове захоплення, а watcher COSMIC не чистить мертві
  // записи — часті open/close засмічували системний трей «фантомними» мікрофонами.
  // Один постійний потік = одна стабільна іконка. Між записами трек вимкнено
  // (enabled=false) — аудіо не пишеться й не обробляється.
  async function ensureStream() {
    if (stream && stream.getTracks().some((t) => t.readyState === 'live')) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return stream;
  }

  async function start() {
    if (recorder && recorder.state === 'recording') return { ok: true };
    try {
      await ensureStream();
    } catch (e) {
      stream = null;
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return { ok: false, code: denied ? 'mic' : 'other', error: (e && e.message) || String(e) };
    }
    stream.getTracks().forEach((t) => { t.enabled = true; });
    chunks = [];
    mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    recorder.start();
    return { ok: true };
  }

  // key передається у повідомленні: chrome.storage НЕдоступний в offscreen-документі.
  async function stop(key) {
    if (!recorder) return { ok: false, error: 'запис не було розпочато' };
    const rec = recorder;
    recorder = null;

    const blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      if (rec.state !== 'inactive') rec.stop();
      else resolve(new Blob(chunks, { type: mimeType }));
    });
    // Потік НЕ закриваємо (див. коментар вище) — лише вимикаємо трек до наступного запису.
    if (stream) stream.getTracks().forEach((t) => { t.enabled = false; });

    if (!blob.size) return { ok: true, text: '' };
    if (!key) return { ok: false, error: 'немає Gemini API-ключа' };

    let text;
    try {
      text = await globalThis.Gemini.geminiTranscribe(blob, key);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
    if (text) copyToClipboard(text);
    return { ok: true, text };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;

    if (msg.type === 'start') {
      start().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.type === 'stop') {
      // Відповідаємо; закриває документ (звільняє мікрофон) service worker після цієї відповіді.
      stop(msg.key).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }
  });
})();
