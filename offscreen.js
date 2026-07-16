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

  function cleanupStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  async function start() {
    if (recorder && recorder.state === 'recording') return { ok: true };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      cleanupStream();
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      return { ok: false, code: denied ? 'mic' : 'other', error: (e && e.message) || String(e) };
    }
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
    cleanupStream();

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

  // Завжди відповідаємо (навіть на reject), інакше відправник висить назавжди.
  const fail = (sendResponse) => (e) => sendResponse({ ok: false, error: String((e && e.message) || e) });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return;
    if (msg.type === 'start') { start().then(sendResponse, fail(sendResponse)); return true; }
    if (msg.type === 'stop') { stop(msg.key).then(sendResponse, fail(sendResponse)); return true; }
  });
})();
