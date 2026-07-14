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

  // ---- Захист аплоаду від закриття вкладки ----
  // Головна причина втрат записів (видно в логах 13–14.07): відео 1–2 ГБ вантажиться на
  // Drive кілька хвилин, а вкладка закривається/переходить раніше. Тому на час збереження:
  // (1) показуємо помітний банер, (2) вмикаємо beforeunload-діалог «покинути сторінку?».
  let savingBusy = false;
  let busyBanner = null;

  function setSaving(on, text) {
    savingBusy = on;
    if (!on) { if (busyBanner) { busyBanner.remove(); busyBanner = null; } return; }
    if (!busyBanner) {
      busyBanner = document.createElement('div');
      busyBanner.id = 'meet-rec-busy';
      busyBanner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
        'z-index:2147483647;background:#b3261e;color:#fff;padding:10px 18px;border-radius:8px;' +
        'font:500 14px/1.3 "Google Sans",Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)';
      document.body.appendChild(busyBanner);
    }
    busyBanner.textContent = '⏳ ' + (text || 'Зберігаю запис — НЕ закривайте вкладку');
  }

  window.addEventListener('beforeunload', (e) => {
    if (savingBusy) { e.preventDefault(); e.returnValue = ''; }
  });

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
      // Помилка енкодера/диска не має мовчати: лог + фіналізація однаково прийде через onstop.
      recorder.onerror = (e) => MRLog.log('error', 'record', 'Помилка відео-рекордера: ' + ((e && e.error && e.error.message) || (e && e.error) || e));

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
      audioRecorder.onerror = (e) => MRLog.log('error', 'record', 'Помилка аудіо-рекордера: ' + ((e && e.error && e.error.message) || (e && e.error) || e));

      display.getVideoTracks()[0].addEventListener('ended', stopCapture);
      recorder.start(1000);
      audioRecorder.start(1000);

      isRecording = true;
      resetMeta(); // почати збір учасників і «хто говорить» для конспекту
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
    // Якщо стоп прийшов не через stopCapture (напр. відео-рекордер упав сам) — дозупинити
    // аудіо тут, інакше audioStopPromise ніколи не резолвиться і збереження зависне.
    if (audioRecorder && audioRecorder.state !== 'inactive') { try { audioRecorder.stop(); } catch (_) {} }
    if (audioStopPromise) await audioStopPromise;
    const audioBlob = id
      ? await RecStore.readBlob(id, 'audio/webm', 'audio')
      : new Blob(audioChunks, { type: 'audio/webm' });
    cleanupStreams();
    isRecording = false;
    render();
    chrome.runtime.sendMessage({ target: 'bg', type: 'BADGE', on: false });

    // Імена учасників і шкала мовців — для конспекту (і в журнал, щоб пережили обрив).
    const meta = buildMeetingMeta();
    if (meta) MRLog.log('info', 'meta', 'Зібрано для конспекту: ' + meta.split('\n')[0].slice(0, 160) + (speakerSegs && speakerSegs.length ? ` | сегментів мовлення: ${speakerSegs.length}` : ' | шкали мовців немає'));
    else MRLog.log('warn', 'meta', 'Учасників з DOM Meet зчитати не вдалося (розмітка змінилась?) — конспект піде без списку імен');
    if (id && meta) await RecStore.updateSession(id, { meta }).catch(() => {});

    try {
      setStatus('Збереження…');
      setSaving(true, 'Зберігаю відео на Drive — НЕ закривайте вкладку (це може тривати кілька хвилин)');
      const saved = await saveRecording(blob, name, { id });
      setStatus(saved.where === 'drive'
        ? 'Готово ✓ — збережено в Google Drive'
        : 'Готово ✓ — збережено локально (тека «Завантаження»)');
      MRLog.log('info', 'save', 'Запис збережено (' + saved.where + '): ' + name);
      // Відео в безпеці → позначаємо це в журналі, але сесію тримаємо, поки аудіо не піде
      // в Gemini: закриють вкладку під час аплоаду аудіо — конспект відновиться банером.
      if (id) await RecStore.updateSession(id, { videoSaved: true, folderId: saved.folderId || null })
        .catch((e2) => MRLog.log('warn', 'save', 'updateSession: ' + ((e2 && e2.message) || e2)));
      const gemOk = await maybeGemini(audioBlob, name, saved.folderId, meta); // ставить власні статуси
      if (id) {
        if (gemOk) await RecStore.deleteSession(id); // конспект у роботі або свідомо пропущено → журнал не потрібен
        else MRLog.log('warn', 'gemini', 'Аудіо не пішло в Gemini — сесія лишається, конспект можна повторити банером у Meet');
      }
    } catch (e) {
      // Сесію НЕ видаляємо → запис відновиться при наступному відкритті Meet.
      MRLog.log('error', 'save', 'Помилка збереження (запис лишається для відновлення): ' + ((e && e.message) || e));
      setStatus('Помилка збереження: ' + ((e && e.message) || e));
    } finally {
      setSaving(false);
      recorder = null;
      chunks = [];
      audioRecorder = null;
      audioChunks = [];
      audioStopPromise = null;
      recId = null;
    }
  }

  // Спершу Drive (великий аплоад прямо звідси); якщо не вдалося — локально.
  // resumeCtx = { id, uploadUrl, folderId }: id сесії журналу (туди зберігається
  // resumable-сесія Drive одразу після створення) та, за наявності, сесія попередньої
  // спроби — тоді аплоад продовжується з байта, на якому обірвався, а не з нуля.
  async function saveRecording(blob, name, resumeCtx) {
    let sessUrl = (resumeCtx && resumeCtx.uploadUrl) || null;
    let sessFolder = (resumeCtx && resumeCtx.folderId) || null;
    try {
      const { folderId } = await withToken((token) => GDrive.uploadResumable(token, blob, name, {
        uploadUrl: sessUrl,
        folderId: sessFolder,
        onSession: (u, f) => {
          sessUrl = u; sessFolder = f;
          if (resumeCtx && resumeCtx.id) RecStore.updateSession(resumeCtx.id, { uploadUrl: u, folderId: f }).catch(() => {});
        },
        onProgress: (pct) => setSaving(true, `Зберігаю відео на Drive: ${pct}% — НЕ закривайте вкладку`)
      }));
      return { where: 'drive', folderId: folderId || sessFolder };
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

  // ---- Учасники та «хто говорить» (з DOM Meet) ----
  // Усе тут — best-effort евристики по розмітці Meet: якщо Google її змінить, збір просто
  // поверне порожньо (конспект піде без імен), а в лог впаде попередження. Запису це не ламає.
  let roster = null;       // participantId → { names: Map(ім'я → к-сть спостережень), self: bool }
  let speakerSegs = null;  // сегменти мовлення [{s,e,id}] у секундах від старту запису
  let openSegs = null;     // id → відкритий сегмент (для склеювання сусідніх секунд)
  let recStartMs = 0;
  let speakerOverflow = false;

  function resetMeta() {
    roster = new Map();
    speakerSegs = [];
    openSegs = {};
    recStartMs = Date.now();
    speakerOverflow = false;
  }

  // Тексти-кандидати на ім'я всередині плитки учасника.
  function textCandidates(tile) {
    const out = [];
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim();
      if (t.length < 2 || t.length > 60) continue;
      if (/^[a-z_0-9]+$/.test(t)) continue;            // лігатури material-іконок (mic_off тощо)
      if (/\d{1,2}:\d{2}/.test(t)) continue;           // таймери
      if (/презентац|presentation|демонстр/i.test(t)) continue;
      // тексти кнопок/меню Meet, що просочуються у плитки (бачили в логах «Більше варіант…»)
      if (/більше|вилучити|закріпити|відкріпити|вимкнути|увімкнути|додати|варіант|повідомл|реакці|мікрофон|камер|звук$|аудіо|відео|дзвін|розмов|учасник|pin|unpin|remove|mute|option|more|call/i.test(t)) continue;
      out.push(t);
    }
    return out;
  }

  // «Плитка зараз говорить»: Meet анімує дрібний індикатор (звукові хвильки) — шукаємо
  // маленький елемент із запущеною CSS-анімацією. Обмежуємо перебір, щоб не вантажити CPU.
  function isSpeakingTile(tile) {
    const els = tile.querySelectorAll('div,span,svg');
    let checked = 0;
    for (const el of els) {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h || w > 48 || h > 48) continue;
      if (++checked > 60) break;
      const st = getComputedStyle(el);
      if (st.animationName && st.animationName !== 'none' && st.animationPlayState === 'running') return true;
    }
    return false;
  }

  // Один семпл на секунду під час запису: оновити імена і відкриті сегменти мовлення.
  function sampleMeta() {
    if (!roster) return;
    try {
      const selfEl = document.querySelector('[data-self-name]');
      const selfName = selfEl ? selfEl.getAttribute('data-self-name') : null;
      const tiles = document.querySelectorAll('[data-participant-id]');
      if (!tiles.length || tiles.length > 60) return;
      const nowSec = Math.round((Date.now() - recStartMs) / 1000);
      const seenIds = new Set();
      tiles.forEach((tile) => {
        const id = tile.getAttribute('data-participant-id');
        if (!id || seenIds.has(id)) return;
        seenIds.add(id);
        let rec = roster.get(id);
        if (!rec) { rec = { names: new Map(), self: false }; roster.set(id, rec); }
        for (const t of textCandidates(tile)) {
          if (/^(ви|you|вы)$/i.test(t)) { rec.self = true; continue; }
          rec.names.set(t, (rec.names.get(t) || 0) + 1);
        }
        if (selfName && rec.self) rec.names.set(selfName, (rec.names.get(selfName) || 0) + 1);
        if (!speakerOverflow && isSpeakingTile(tile)) {
          let g = openSegs[id];
          if (g && nowSec - g.e <= 2) g.e = nowSec; // склеюємо паузи ≤2 с
          else {
            g = { s: nowSec, e: nowSec, id };
            speakerSegs.push(g);
            openSegs[id] = g;
            if (speakerSegs.length > 1500) speakerOverflow = true; // дуже довга зустріч — далі лише імена
          }
        }
      });
    } catch (_) { /* збір метаданих ніколи не має ламати запис */ }
  }

  // Зібрати текстовий блок для промпту Gemini: список імен + шкала «хто коли говорив».
  function buildMeetingMeta() {
    if (!roster || !roster.size) return null;
    const idName = new Map();
    const people = [];
    for (const [id, rec] of roster) {
      let best = null, bestN = 0;
      for (const [n, c] of rec.names) if (c > bestN) { best = n; bestN = c; }
      if (!best || bestN < 2) continue; // випадкове сміття, бачене один раз
      idName.set(id, best);
      people.push(best + (rec.self ? ' (я — власник запису)' : ''));
    }
    const uniq = [...new Set(people)];
    if (!uniq.length) return null;
    let txt = 'Учасники зустрічі (імена з інтерфейсу Meet — вживай у конспекті ЛИШЕ їх): ' + uniq.join(', ') + '.';
    const segs = (speakerSegs || []).filter((g) => idName.has(g.id) && g.e - g.s >= 2);
    if (segs.length >= 3) {
      const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      txt += '\nОрієнтовна шкала «хто коли говорив» (за індикатором Meet; похибка в кілька секунд, ' +
        'звіряй із голосами та звертаннями в аудіо): ' +
        segs.map((g) => `${fmt(g.s)}–${fmt(g.e)} ${idName.get(g.id)}`).join('; ') + '.';
    }
    return txt;
  }

  // Якщо є Gemini-ключ — заливаємо АУДІО в Gemini (великий аплоад тут), далі
  // дрібну обробку (очікування → генерація → Google Doc) веде service worker.
  // Повертає true, коли повторювати нема чого (конспект запущено або свідомо пропущено),
  // і false, коли аплоад/передача не вдалися — тоді сесію в журналі варто лишити на повтор.
  // meta — блок «учасники + хто коли говорив» для промпту (може бути null).
  async function maybeGemini(audioBlob, name, folderId, meta) {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) { MRLog.log('info', 'gemini', 'Конспект пропущено: не задано Gemini-ключ'); return true; }
    // Свідомо шлемо ЛИШЕ аудіо-доріжку. Повне відео сюди слати не можна: години 720p —
    // це ГБ і не влазить у ліміт файлу/контекст, конспект гарантовано впаде або таймаутиться.
    if (!audioBlob || !audioBlob.size) {
      MRLog.log('warn', 'gemini', 'Конспект пропущено: у записі немає аудіо-доріжки (старий запис або без звуку): ' + name);
      setStatus('Конспект пропущено: у записі немає окремої аудіо-доріжки (старий запис або без звуку)');
      return true;
    }
    const baseName = name.replace(/\.webm$/i, '');
    try {
      setStatus('Готую конспект (надсилаю аудіо в Gemini)…');
      setSaving(true, 'Надсилаю аудіо для конспекту — НЕ закривайте вкладку');
      const file = await Gemini.geminiUploadFile(audioBlob, geminiApiKey, 'audio/webm');
      const r = await sendBg({
        type: 'GEMINI_CONTINUE',
        job: {
          geminiFileName: file.name,
          fileUri: file.uri,
          mimeType: file.mimeType,
          docName: baseName + ' — конспект',
          meetingBaseName: baseName,
          folderId: folderId || null,
          speakerContext: meta || null
        }
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'background не прийняв завдання');
      MRLog.log('info', 'gemini', 'Аудіо залито в Gemini, конспект робиться у фоні: ' + baseName);
      setStatus('Конспект робиться у фоні — вкладку можна закрити.');
      return true;
    } catch (e) {
      MRLog.log('error', 'gemini', 'Не вдалося залити аудіо в Gemini: ' + ((e && e.message) || e));
      setStatus('Конспект не вдалося надіслати в Gemini: ' + ((e && e.message) || e));
      return false;
    }
  }

  // ---- Відновлення урваного запису ----
  async function initRecovery() {
    try {
      await RecStore.pruneOld();
      const orphans = await RecStore.listOrphans();
      if (orphans.length && !isRecording) {
        const s = orphans[0];
        if (s.videoSaved || s.uploadUrl) {
          // Збереження вже почалося (або відео вже в Drive, лишився конспект) —
          // доводимо до кінця САМІ, без кліків: аплоад продовжиться з місця обриву.
          MRLog.log('info', 'recovery', 'Авто-продовження збереження: ' + (s.name || s.id));
          recover(s, true);
        } else {
          // Обрив ще ДО початку збереження (крах посеред запису) — тут лишаємо вибір людині.
          MRLog.log('info', 'recovery', 'Знайдено незавершений запис: ' + (s.name || s.id));
          showRecoveryBanner(s);
        }
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
    if (session.videoSaved) {
      // Відео вже збережено — лишилося тільки зробити конспект з аудіо-доріжки.
      txt.textContent = `Незавершений конспект від ${when}${dur}`;
      b.append(
        txt,
        mkBtn('Зробити конспект', () => recover(session, true)),
        mkBtn('✕', () => dismissRecovery(session))
      );
    } else {
      txt.textContent = `Незавершений запис від ${when}${dur}`;
      b.append(
        txt,
        mkBtn('Зберегти на Drive', () => recover(session, true)),
        mkBtn('Завантажити', () => recover(session, false)),
        mkBtn('✕', () => dismissRecovery(session))
      );
    }
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

  // Обгортка: дві вкладки Meet не мають лити той самий запис одночасно —
  // Web Locks працюють між вкладками одного origin, зайва вкладка просто пропустить.
  async function recover(session, toDrive) {
    removeRecoveryBanner();
    return navigator.locks.request('meetrec-recover-' + session.id, { ifAvailable: true }, async (lock) => {
      if (!lock) { MRLog.log('info', 'recovery', 'Пропущено: цей запис уже відновлює інша вкладка'); return; }
      await doRecover(session, toDrive);
    });
  }

  async function doRecover(session, toDrive) {
    try {
      setSaving(true, 'Відновлюю запис — НЕ закривайте вкладку (це може тривати кілька хвилин)');
      MRLog.log('info', 'recovery', 'Відновлення (' + (session.videoSaved ? 'лише конспект' : toDrive ? 'на Drive' : 'локально') + '): ' + (session.name || session.id));
      const name = session.name || `Meet ${session.code ? session.code + ' ' : ''}recovered.webm`;
      let folderId = session.folderId || null;

      if (!session.videoSaved) {
        setStatus('Відновлення запису…');
        const blob = await RecStore.readBlob(session.id, session.mime || 'video/webm');
        if (!blob.size) {
          MRLog.log('warn', 'recovery', 'Запис порожній, видаляю: ' + session.id);
          setStatus('Відновлення: запис порожній');
          await RecStore.deleteSession(session.id);
          return;
        }
        if (toDrive) {
          const saved = await saveRecording(blob, name, { id: session.id, uploadUrl: session.uploadUrl || null, folderId: session.folderId || null });
          folderId = saved.folderId || null;
          setStatus(saved.where === 'drive'
            ? 'Відновлено ✓ — збережено в Google Drive'
            : 'Відновлено ✓ — збережено локально');
        } else {
          downloadLocally(blob, name);
          setStatus('Відновлено ✓ — файл завантажується');
        }
        MRLog.log('info', 'recovery', 'Відео відновлено: ' + name);
        // Відео в безпеці → якщо конспект далі урветься, банер запропонує лише конспект.
        await RecStore.updateSession(session.id, { videoSaved: true, folderId })
          .catch((e2) => MRLog.log('warn', 'recovery', 'updateSession: ' + ((e2 && e2.message) || e2)));
      } else {
        setStatus('Відновлюю конспект…');
      }

      // Повне відео в Gemini НЕ шлемо (завелике → гарантований провал) — лише аудіо-доріжку.
      // Якщо її нема (стара сесія / запис без звуку) — maybeGemini чесно пропустить конспект.
      const audioBlob = await RecStore.readBlob(session.id, 'audio/webm', 'audio').catch(() => null);
      // Імена/шкала мовців збережені в сесії ще під час запису (тік раз на 30 с).
      const gemOk = await maybeGemini(audioBlob, name, folderId, session.meta || null);
      if (gemOk) {
        await RecStore.deleteSession(session.id);
        initRecovery(); // якщо є ще незавершені сесії — одразу показати наступний банер
      } else {
        // Аудіо не пішло в Gemini — сесію лишаємо, банер одразу пропонує повторити конспект.
        showRecoveryBanner({ ...session, videoSaved: true, folderId });
      }
    } catch (e) {
      // Сесію лишаємо — можна спробувати ще раз (банер з'явиться при наступному відкритті).
      MRLog.log('error', 'recovery', 'Відновлення не вдалося (запис лишається): ' + ((e && e.message) || e));
      setStatus('Відновлення не вдалося: ' + ((e && e.message) || e));
      showRecoveryBanner(session);
    } finally {
      setSaving(false);
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
  // Той самий тік раз на секунду семплить учасників/мовців і раз на 30 с
  // персистить зібране в журнал — щоб імена пережили обрив і дісталися recovery.
  let metaTick = 0;
  setInterval(() => {
    const onMeeting = inCall();
    if (onMeeting) ensureButton(); else removeButton();
    if (isRecording) {
      sampleMeta();
      if (recId && (++metaTick % 30) === 0) {
        const meta = buildMeetingMeta();
        if (meta) RecStore.updateSession(recId, { meta }).catch(() => {});
      }
    }
    if (isRecording && (!onMeeting || leftCall())) stopCapture();
  }, 1000);

  // Перевірити, чи лишився урваний запис від минулого разу.
  initRecovery();
})();
