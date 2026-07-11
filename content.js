// content.js — кнопка запису в Meet, захоплення (екран + мікрофон) і запис у самій
// сторінці, а також ВЕЛИКІ аплоади (Drive / Gemini) — прямо звідси, щоб відео не
// йшло через sendMessage. Чисті Drive/Gemini-функції — у gdrive.js / gemini.js;
// журнал шматків на диск — у recstore.js (підключені перед цим файлом). OAuth-токен
// бере service worker (chrome.identity недоступний у content script) і віддає рядком.
(() => {
  const MEET_CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?])/;

  let btn = null;
  let isRecording = false;
  let recorder = null;
  let chunks = [];        // запасний шлях у пам'яті, якщо журнал IndexedDB недоступний
  let audioRecorder = null;   // окрема аудіо-доріжка для Gemini (відео для конспекту завелике)
  let audioChunks = [];       // запасний шлях у пам'яті для аудіо
  let audioStopPromise = null; // резолвиться, коли audioRecorder завершив і скинув останній шматок
  let audioCtx = null;
  let streams = [];
  let capturedCode = null; // код зустрічі, зафіксований на старті (URL може змінитися на стопі)
  let recId = null;        // id сесії в журналі IndexedDB (null → пишемо в пам'ять)
  let recName = null;      // ім'я файлу, зафіксоване на старті
  let recoveryBanner = null;

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
    MRLog.log('info', 'status', text);
    chrome.runtime.sendMessage({ target: 'bg', type: 'STATUS', text });
  }
  function sendBg(msg) { return chrome.runtime.sendMessage({ target: 'bg', ...msg }); }

  // ---- OAuth токен через service worker (з оновленням на 401) ----
  async function requestToken(refreshOld) {
    const r = await sendBg(refreshOld
      ? { type: 'REFRESH_TOKEN', token: refreshOld }
      : { type: 'GET_TOKEN' });
    if (!r || !r.ok) throw new Error((r && r.error) || 'no token');
    return r.token;
  }
  async function withToken(fn) {
    let token = await requestToken();
    try {
      return await fn(token);
    } catch (e) {
      if (e && e.status === 401) {
        token = await requestToken(token);
        return await fn(token);
      }
      throw e;
    }
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

      // Журнал на диск: ім'я й id фіксуємо на старті, щоб відновлений файл був ідентичний.
      capturedCode = meetCode();
      const startedAt = Date.now();
      recName = `Meet ${capturedCode ? capturedCode + ' ' : ''}${timestamp()}.webm`;
      try {
        recId = await RecStore.startSession({ id: `${startedAt}-${capturedCode || 'meet'}`, name: recName, code: capturedCode, mime: 'video/webm', startedAt });
      } catch (e) {
        MRLog.log('warn', 'record', 'Журнал IndexedDB недоступний, пишу в пам\'ять (без захисту від обриву): ' + ((e && e.message) || e));
        recId = null;
      }

      recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        if (recId) RecStore.appendChunk(recId, e.data, 'video').catch((err) => MRLog.log('warn', 'record', 'Втрачено відео-шматок: ' + ((err && err.message) || err)));
        else chunks.push(e.data);
      };
      recorder.onstop = onRecorderStop;

      // Паралельно пишемо лише змікшований звук (вкладка + мікрофон) окремою доріжкою.
      // У Gemini шлемо саме її: відео 720p за кілька годин — це ГБ і мільйони токенів,
      // тоді як opus-аудіо влазить і в ліміт файлу (2 ГБ), і в контекст моделі.
      audioChunks = [];
      const audioMime = ['audio/webm;codecs=opus', 'audio/webm']
        .find((t) => MediaRecorder.isTypeSupported(t)) || 'audio/webm';
      audioRecorder = new MediaRecorder(dest.stream, { mimeType: audioMime });
      audioStopPromise = new Promise((resolve) => { audioRecorder.onstop = resolve; });
      audioRecorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        if (recId) RecStore.appendChunk(recId, e.data, 'audio').catch((err) => MRLog.log('warn', 'record', 'Втрачено аудіо-шматок: ' + ((err && err.message) || err)));
        else audioChunks.push(e.data);
      };

      display.getVideoTracks()[0].addEventListener('ended', stopCapture);
      recorder.start(1000);
      audioRecorder.start(1000);

      isRecording = true;
      render();
      removeRecoveryBanner(); // йде новий запис — старий банер відновлення прибрати
      chrome.runtime.sendMessage({ target: 'bg', type: 'BADGE', on: true });

      const missing = [];
      if (!mic) missing.push('без мікрофона [' + (micError || '?') + ']');
      if (!display.getAudioTracks().length) missing.push('без звуку вкладки — поставте галочку в діалозі');
      MRLog.log('info', 'record', 'Старт запису: ' + recName + (missing.length ? ' [' + missing.join('; ') + ']' : '') + (recId ? '' : ' (у пам\'ять — журнал недоступний)'));
      setStatus(missing.length ? 'Запис… (' + missing.join('; ') + ')' : 'Запис…');
    } catch (e) {
      MRLog.log('warn', 'record', 'Старт скасовано/помилка: ' + ((e && e.message) || e));
      setStatus('Скасовано: ' + ((e && e.message) || e));
      cleanup();
    }
  }

  function stopCapture() {
    if (recorder && recorder.state !== 'inactive') {
      setStatus('Зупинка та збереження…');
      if (audioRecorder && audioRecorder.state !== 'inactive') audioRecorder.stop();
      recorder.stop();
    }
  }

  async function onRecorderStop() {
    const id = recId;
    const name = recName || `Meet ${capturedCode ? capturedCode + ' ' : ''}${timestamp()}.webm`;
    // Транзакції IndexedDB на 'chunks' серіалізовані за порядком створення, тож readBlob
    // (створена після appendChunk останнього шматка) гарантовано бачить увесь запис.
    const blob = id ? await RecStore.readBlob(id, 'video/webm') : new Blob(chunks, { type: 'video/webm' });
    // Дочекатися, поки аудіо-рекордер скине останній шматок, і зібрати аудіо-доріжку для Gemini.
    if (audioStopPromise) await audioStopPromise;
    const audioBlob = id
      ? await RecStore.readBlob(id, 'audio/webm', 'audio')
      : new Blob(audioChunks, { type: 'audio/webm' });
    cleanupStreams();
    isRecording = false;
    render();
    chrome.runtime.sendMessage({ target: 'bg', type: 'BADGE', on: false });

    try {
      setStatus('Збереження…');
      const saved = await saveRecording(blob, name);
      setStatus(saved.where === 'drive'
        ? 'Готово ✓ — збережено в Google Drive'
        : 'Готово ✓ — збережено локально (тека «Завантаження»)');
      MRLog.log('info', 'save', 'Запис збережено (' + saved.where + '): ' + name);
      if (id) await RecStore.deleteSession(id); // відео в безпеці → журнал більше не потрібен
      await maybeGemini(audioBlob, name, saved.folderId); // ставить власні статуси
    } catch (e) {
      // Сесію НЕ видаляємо → запис відновиться при наступному відкритті Meet.
      MRLog.log('error', 'save', 'Помилка збереження (запис лишається для відновлення): ' + ((e && e.message) || e));
      setStatus('Помилка збереження: ' + ((e && e.message) || e));
    } finally {
      recorder = null;
      chunks = [];
      audioRecorder = null;
      audioChunks = [];
      audioStopPromise = null;
      recId = null;
    }
  }

  // Спершу Drive (великий аплоад прямо звідси); якщо не вдалося — локально.
  async function saveRecording(blob, name) {
    try {
      const { folderId } = await withToken((token) => GDrive.uploadResumable(token, blob, name));
      return { where: 'drive', folderId };
    } catch (driveErr) {
      MRLog.log('warn', 'save', 'Drive недоступний, зберігаю локально: ' + ((driveErr && driveErr.message) || driveErr));
      downloadLocally(blob, name);
      return { where: 'local', folderId: null };
    }
  }

  // Локальне збереження без передачі blob у SW: object URL + програмний <a download>.
  function downloadLocally(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // Якщо є Gemini-ключ — заливаємо АУДІО в Gemini (великий аплоад тут), далі
  // дрібну обробку (очікування → генерація → Google Doc) веде service worker.
  async function maybeGemini(audioBlob, name, folderId) {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) { MRLog.log('info', 'gemini', 'Конспект пропущено: не задано Gemini-ключ'); return; }
    // Свідомо шлемо ЛИШЕ аудіо-доріжку. Повне відео сюди слати не можна: години 720p —
    // це ГБ і не влазить у ліміт файлу/контекст, конспект гарантовано впаде або таймаутиться.
    if (!audioBlob || !audioBlob.size) {
      MRLog.log('warn', 'gemini', 'Конспект пропущено: у записі немає аудіо-доріжки (старий запис або без звуку): ' + name);
      setStatus('Конспект пропущено: у записі немає окремої аудіо-доріжки (старий запис або без звуку)');
      return;
    }
    const baseName = name.replace(/\.webm$/i, '');
    try {
      setStatus('Готую конспект (надсилаю аудіо в Gemini)…');
      const file = await Gemini.geminiUploadFile(audioBlob, geminiApiKey, 'audio/webm');
      await sendBg({
        type: 'GEMINI_CONTINUE',
        job: {
          geminiFileName: file.name,
          fileUri: file.uri,
          mimeType: file.mimeType,
          docName: baseName + ' — конспект',
          meetingBaseName: baseName,
          folderId: folderId || null
        }
      });
      MRLog.log('info', 'gemini', 'Аудіо залито в Gemini, конспект робиться у фоні: ' + baseName);
      setStatus('Конспект робиться у фоні — вкладку можна закрити.');
    } catch (e) {
      MRLog.log('error', 'gemini', 'Не вдалося залити аудіо в Gemini: ' + ((e && e.message) || e));
      setStatus('Конспект не вдалося надіслати в Gemini: ' + ((e && e.message) || e));
    }
  }

  // ---- Відновлення урваного запису ----
  async function initRecovery() {
    try {
      await RecStore.pruneOld();
      const orphans = await RecStore.listOrphans();
      if (orphans.length && !isRecording) {
        MRLog.log('info', 'recovery', 'Знайдено незавершений запис: ' + (orphans[0].name || orphans[0].id));
        showRecoveryBanner(orphans[0]);
      }
    } catch (e) {
      MRLog.log('warn', 'recovery', 'Помилка ініціалізації відновлення: ' + ((e && e.message) || e));
    }
  }

  function mkBtn(label, onClickFn) {
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = label;
    x.addEventListener('click', onClickFn);
    return x;
  }
  function removeRecoveryBanner() { if (recoveryBanner) { recoveryBanner.remove(); recoveryBanner = null; } }

  async function showRecoveryBanner(session) {
    if (recoveryBanner) return;
    const secs = await RecStore.countChunks(session.id).catch(() => 0);
    const when = new Date(session.startedAt).toLocaleString();
    const dur = secs ? ` (~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')})` : '';

    const b = document.createElement('div');
    b.id = 'meet-rec-recovery';
    const txt = document.createElement('span');
    txt.className = 'mrr-text';
    txt.textContent = `Незавершений запис від ${when}${dur}`;
    b.append(
      txt,
      mkBtn('Зберегти на Drive', () => recover(session, true)),
      mkBtn('Завантажити', () => recover(session, false)),
      mkBtn('✕', () => dismissRecovery(session))
    );
    document.body.appendChild(b);
    recoveryBanner = b;
  }

  async function dismissRecovery(session) {
    removeRecoveryBanner();
    try {
      await RecStore.deleteSession(session.id);
      MRLog.log('info', 'recovery', 'Незавершений запис відхилено користувачем: ' + (session.name || session.id));
    } catch (e) { MRLog.log('warn', 'recovery', 'Не вдалося видалити сесію: ' + ((e && e.message) || e)); }
  }

  async function recover(session, toDrive) {
    removeRecoveryBanner();
    try {
      MRLog.log('info', 'recovery', 'Відновлення (' + (toDrive ? 'на Drive' : 'локально') + '): ' + (session.name || session.id));
      setStatus('Відновлення запису…');
      const blob = await RecStore.readBlob(session.id, session.mime || 'video/webm');
      if (!blob.size) {
        MRLog.log('warn', 'recovery', 'Запис порожній, видаляю: ' + session.id);
        setStatus('Відновлення: запис порожній');
        await RecStore.deleteSession(session.id);
        return;
      }
      const name = session.name || `Meet ${session.code ? session.code + ' ' : ''}recovered.webm`;
      // Аудіо-доріжку читаємо ДО видалення сесії. Повне відео в Gemini НЕ шлемо (завелике → провал);
      // якщо аудіо нема (стара сесія / без звуку) — maybeGemini чесно пропустить конспект.
      const audioBlob = await RecStore.readBlob(session.id, 'audio/webm', 'audio').catch(() => null);
      let folderId = null;
      if (toDrive) {
        const saved = await saveRecording(blob, name);
        folderId = saved.folderId;
        setStatus(saved.where === 'drive'
          ? 'Відновлено ✓ — збережено в Google Drive'
          : 'Відновлено ✓ — збережено локально');
      } else {
        downloadLocally(blob, name);
        setStatus('Відновлено ✓ — файл завантажується');
      }
      MRLog.log('info', 'recovery', 'Відео відновлено (' + (toDrive ? 'drive' : 'local') + '): ' + name);
      await RecStore.deleteSession(session.id);
      // Конспект тепер робиться в ОБОХ гілках (раніше «Завантажити» його пропускало).
      await maybeGemini(audioBlob, name, folderId);
    } catch (e) {
      // Сесію лишаємо — можна спробувати ще раз (банер з'явиться при наступному відкритті).
      MRLog.log('error', 'recovery', 'Відновлення не вдалося (запис лишається): ' + ((e && e.message) || e));
      setStatus('Відновлення не вдалося: ' + ((e && e.message) || e));
      showRecoveryBanner(session);
    }
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
    audioRecorder = null;
    audioChunks = [];
    audioStopPromise = null;
    recId = null;
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

  // Перевірити, чи лишився урваний запис від минулого разу.
  initRecovery();
})();
