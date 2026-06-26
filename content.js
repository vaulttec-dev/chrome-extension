// content.js — кнопка запису в Meet + захоплення (екран + мікрофон) і запис у самій сторінці.
// Запис ведеться тут (а не в offscreen), бо сторінка Meet уже має дозвіл на мікрофон.
(() => {
  const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?])/;

  let btn = null;
  let isRecording = false;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let streams = [];

  function meetCode() {
    const m = location.pathname.match(MEET_CODE_RE);
    return m ? m[1] : null;
  }
  function inCall() { return !!meetCode(); }

  // Евристика екрана «Ви вийшли з дзвінка» для автозупинки.
  function leftCall() {
    const needles = ['rejoin', 'return to home', 'you left',
      'повернутися на головний', 'знову приєдн', 'ви вийшли'];
    const nodes = document.querySelectorAll('button, [role="button"], h1');
    for (const el of nodes) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t && needles.some((n) => t.includes(n))) return true;
    }
    return false;
  }

  function setStatus(text) {
    console.log('[MeetRec]', text);
    chrome.runtime.sendMessage({ target: 'bg', type: 'STATUS', text });
  }

  // ---- UI ----
  function ensureButton() {
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'meet-rec-btn';
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
    render();
  }
  function removeButton() { if (btn) { btn.remove(); btn = null; } }
  function render() {
    if (!btn) return;
    btn.classList.toggle('recording', isRecording);
    btn.textContent = isRecording ? '■ Зупинити запис' : '● Запис';
  }

  function onClick() {
    if (isRecording) stopCapture();
    else startCapture();
  }

  // ---- Захоплення + запис ----
  async function startCapture() {
    if (recorder) return;
    chunks = [];
    try {
      // Відео + звук вкладки. preferCurrentTab → діалог «Поділитися цією вкладкою?»
      // саме для Meet (без вибору вікна/екрана; поточну вкладку видно й можна обрати).
      // На цій машині Chrome кодує відео ТІЛЬКИ процесором (Video Encode: software).
      // Тому на завантаженому профілі CPU не встигає → дропає кадри → ривки.
      // 720p/30fps удвічі дешевші за 1080p — витягує навіть зайнятий профіль.
      // Хочеш 1080p — постав height: { max: 1080 } (краще разом з апаратним кодуванням).
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, height: { max: 720 } },
        audio: true,
        preferCurrentTab: true
      });

      // Мікрофон — у контексті Meet дозвіл уже є, тож працює без запиту.
      let mic = null, micError = '';
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        micError = (e && e.name) ? `${e.name}: ${e.message}` : String(e);
      }
      streams = [display, mic].filter(Boolean);

      // Мікс: звук вкладки + мікрофон → одна доріжка.
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      if (display.getAudioTracks().length) audioCtx.createMediaStreamSource(display).connect(dest);
      if (mic) audioCtx.createMediaStreamSource(mic).connect(dest);

      const mixed = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      // VP8 першим: його програмний енкодер у ~1.5–2× легший за VP9. Машини без
      // апаратного VP9-кодування (а їх багато) на VP9 у софті дропають кадри.
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
        .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

      // Фіксований бітрейт під 720p — менше навантаження на CPU-кодування.
      recorder = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onRecorderStop;
      display.getVideoTracks()[0].addEventListener('ended', stopCapture);
      recorder.start(1000);

      isRecording = true;
      render();
      chrome.runtime.sendMessage({ target: 'bg', type: 'BADGE', on: true });

      const missing = [];
      if (!mic) missing.push('без мікрофона [' + (micError || '?') + ']');
      if (!display.getAudioTracks().length) missing.push('без звуку вкладки — поставте галочку в діалозі');
      setStatus(missing.length ? 'Запис… (' + missing.join('; ') + ')' : 'Запис…');
    } catch (e) {
      setStatus('Скасовано: ' + ((e && e.message) || e));
      cleanup();
    }
  }

  function stopCapture() {
    if (recorder && recorder.state !== 'inactive') {
      setStatus('Зупинка та збереження…');
      recorder.stop();
    }
  }

  async function onRecorderStop() {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const name = `Meet ${meetCode() ? meetCode() + ' ' : ''}${timestamp()}.webm`;
    cleanupStreams();
    isRecording = false;
    render();
    chrome.runtime.sendMessage({ target: 'bg', type: 'BADGE', on: false });

    try {
      const dataUrl = await blobToDataURL(blob);
      const res = await chrome.runtime.sendMessage({ target: 'bg', type: 'SAVE', dataUrl, name });
      if (res && res.ok) {
        setStatus(res.where === 'drive'
          ? 'Готово ✓ — збережено в Google Drive'
          : 'Готово ✓ — збережено локально (тека «Завантаження»)');
      } else {
        setStatus('Помилка збереження: ' + ((res && res.error) || '?'));
      }
    } catch (e) {
      setStatus('Помилка збереження: ' + ((e && e.message) || e));
    } finally {
      recorder = null;
      chunks = [];
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('FileReader error'));
      r.readAsDataURL(blob);
    });
  }
  function cleanupStreams() {
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    streams = [];
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
  }
  function cleanup() {
    cleanupStreams();
    recorder = null;
    chunks = [];
    isRecording = false;
    render();
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function timestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  // Зупинка з попапа.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'content' && msg.type === 'STOP') stopCapture();
  });

  // Показ кнопки під час дзвінка + автозупинка на завершенні.
  setInterval(() => {
    const onMeeting = inCall();
    if (onMeeting) ensureButton(); else removeButton();
    if (isRecording && (!onMeeting || leftCall())) stopCapture();
  }, 1000);
})();
