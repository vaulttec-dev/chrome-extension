// gemini.js — чисті функції Gemini (приймають API-ключ аргументом).
// Розподіл: великий аплоад аудіо (geminiUploadFile) робить content script —
// щоб blob не йшов через sendMessage; решту (geminiGetFile, geminiTranscribeFile,
// geminiSummarize) веде service worker через chrome.alarms, незалежно від вкладки Meet.
// Конвеєр зустрічі — два кроки: аудіо → ПОВНИЙ транскрипт (спеціалізована модель),
// потім транскрипт → конспект (звичайна flash-модель). Обидва — окремі файли в теці.
(function (g) {
  // Аліас «-latest» завжди вказує на найновішу flash-модель — код не треба оновлювати
  // з виходом нових версій (конспект і запасна транскрипція використовують цю константу).
  const GEMINI_MODEL = 'gemini-flash-latest';
  const GEMINI_PROMPT = `Ти — досвідчений асистент із протоколювання робочих зустрічей.
Вище дано ПОВНИЙ ТРАНСКРИПТ зустрічі Google Meet — дослівну розшифровку аудіозапису.
Спирайся ВИКЛЮЧНО на те, що є в транскрипті, уважно прочитай його від початку до кінця
і не пропусти жодної важливої деталі.

На основі транскрипту склади ДЕТАЛЬНИЙ конспект УКРАЇНСЬКОЮ у форматі Markdown.

ПЕРШИЙ рядок відповіді — СЛУЖБОВИЙ, рівно у форматі «ТЕМА: <до 5 слів українською>»:
коротка назва зустрічі по суті (напр. «ТЕМА: Бюджет реклами на липень»). Без лапок, без крапки
в кінці, без символів / \\ : * ? " < > |. Якщо про що йшлося визначити неможливо —
напиши «ТЕМА: Зустріч без визначеної теми». Далі з нового рядка йде сам конспект. Пиши детально й конкретно, але рівно
стільки, скільки реально було сказано — обсяг конспекту має відповідати обсягу зустрічі;
коротку зустріч не розтягуй. Структура документа така:

# Короткий підсумок
Кілька речень про головне: що це була за зустріч, які ключові теми й чим вона завершилася.
Це стислий огляд — решта документа нижче розгортає сказане детальніше.

## Перебіг обговорення
Основна змістовна секція. Це СИНТЕЗ ПО ТЕМАХ, а не розшифровка: НЕ цитуй кожну репліку
окремим пунктом і НЕ став таймкоди — інакше конспект не вміститься. Розбий обговорення
на теми (підзаголовки «### Назва теми») і всередині кожної теми повно, але без «стенограми», виклади:
- хто яку позицію чи пропозицію висловив і які навів аргументи й контраргументи;
- усі цифри, дати, суми, терміни, назви, імена, посилання, приклади;
- до чого дійшли (чи не дійшли) і чому.

## Ухвалені рішення
- Кожне рішення окремим пунктом, з контекстом: що саме вирішили й чому.

## Завдання та доручення
Перелічи ВСІ завдання, доручення й домовленості, що були ОЗВУЧЕНІ, навіть згадані мимохідь.
Формат кожного пункту: «Виконавець — що зробити — до коли». Якщо щось не назване — постав «—».
Краще включити сумнівне завдання, ніж пропустити.

## Відкриті питання
- Питання, що лишилися без відповіді або потребують подальшого з'ясування.

Імена: якщо нижче надано список учасників — у конспекті вживай імена ВИКЛЮЧНО з цього списку.
Мовців визначай насамперед за звертаннями й самопредставленнями в розмові, а також за наданою
шкалою «хто коли говорив». Якщо впевненості, хто говорить, немає — НЕ вгадуй: пиши
«(мовця не визначено)», а виконавця завдання познач «—».

Якщо транскрипт порожній або беззмістовний (мовлення не було чи не розпізналось) — прямо так і напиши.
НІКОЛИ не повторюй той самий символ, слово чи речення поспіль і не додавай тексту-заповнювача;
якщо змісту мало — конспект короткий, і це нормально. Пиши українською, конкретно; нічого
важливого не вигадуй і не пропускай.`;

  // Відрізати службовий перший рядок «ТЕМА: …» → { topic, text }.
  // topic — очищена назва (≤5 слів, без заборонених у Drive символів) або null,
  // якщо модель рядок не дала; text — конспект уже без цього рядка.
  function splitTopic(text) {
    const s = String(text || '');
    const m = s.match(/^\s*(?:#+\s*)?(?:\*\*)?\s*ТЕМА\s*:\s*(.+?)\s*(?:\*\*)?\s*(?:\n|$)/i);
    if (!m) return { topic: null, text: s };
    const topic = m[1]
      .replace(/[\/\\:*?"<>|#]/g, ' ')   // заборонене у назвах файлів + markdown-сміття
      .replace(/[«»"'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ').slice(0, 5).join(' ')  // страховка: не більше 5 слів
      .replace(/[.,;–—-]+$/, '')
      .slice(0, 60)
      .trim();
    return { topic: topic || null, text: s.slice(m[0].length).replace(/^\s+/, '') };
  }

  // Залити медіа у Gemini Files API (resumable) → { name, uri, state, mimeType }.
  // mimeType: 'audio/webm' для аудіо-доріжки (типово) або 'video/webm' для повного відео.
  async function geminiUploadFile(blob, key, mimeType = 'video/webm') {
    const start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(blob.size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: 'meet-recording' } })
    });
    if (!start.ok) throw new Error('gemini upload start ' + start.status);

    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('gemini: немає upload url');

    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(blob.size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize'
      },
      body: blob
    });
    if (!up.ok) throw new Error('gemini upload ' + up.status);
    return (await up.json()).file;
  }

  // Один запит стану файлу (відео обробляється асинхронно): PROCESSING/ACTIVE/FAILED.
  // Цикл очікування веде service worker по тиках chrome.alarms, а не sleep тут.
  async function geminiGetFile(fileName, key) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: { 'x-goog-api-key': key }
    });
    if (!r.ok) throw new Error('gemini file get ' + r.status);
    return r.json();
  }

  // Розібрати відповідь generateContent → { text, finishReason }.
  // finishReason: 'STOP' норм; 'MAX_TOKENS'/'SAFETY'/… = вивід обрізано.
  function pickCandidateText(d) {
    const cand = d && d.candidates && d.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    const finishReason = cand && cand.finishReason;
    const text = parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
    return { text, finishReason };
  }

  // Конспект із ГОТОВОГО транскрипту (текст → текст). Аудіо сюди більше не йде: дослівну
  // розшифровку робить окрема модель (geminiTranscribeFile), а конспект — уже з неї, тож
  // спирається на повний текст, а не на те, що модель «дочула». context — необов'язковий
  // блок зі списком учасників і шкалою «хто коли говорив» (збирає content script з DOM Meet).
  // Транскрипт ставимо ПЕРЕД інструкцією: для довгого контексту Gemini краще тримає
  // завдання, коли воно йде після даних.
  async function geminiSummarize(transcript, key, context) {
    const prompt = '===== ТРАНСКРИПТ ЗУСТРІЧІ =====\n' + transcript + '\n===== КІНЕЦЬ ТРАНСКРИПТУ =====\n\n' +
      GEMINI_PROMPT + (context ? '\n\n' + context : '');
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 24576 }
        })
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('gemini generate ' + r.status + ' ' + t.slice(0, 200));
    }
    const { text, finishReason } = pickCandidateText(await r.json());
    if (!text) throw new Error('gemini: порожня відповідь' + (finishReason ? ' (finishReason: ' + finishReason + ')' : ''));
    return { text, finishReason };
  }

  // ---- Транскрипція: спеціалізована модель Gemini 3.5 Transcribe ----
  // Це ОКРЕМИЙ Interactions API (POST /v1beta/interactions), а не generateContent: без
  // промпту, модель віддає лише текст розшифровки (85+ мов, пунктуація, форматування).
  // Ліміт — до 1 год аудіо на запит. Довший запис, помилка формату/доступу (4xx) чи порожня
  // відповідь → запасний шлях через звичайну flash-модель із промптом дослівної розшифровки:
  // вона тягне й багатогодинне аудіо, тож транскрипт НІКОЛИ не лишається без результату.
  const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
  const TRANSCRIBE_MAX_MS = 60 * 60 * 1000;

  const GEMINI_TRANSCRIBE_PROMPT = `Розшифруй це аудіо у звичайний текст — ПОВНІСТЮ, від початку до кінця.
Поверни ВИКЛЮЧНО дослівний транскрипт сказаного тією ж мовою, якою говорять
(українською — українською). Без жодних коментарів, заголовків, лапок чи пояснень.
Розстав природну пунктуацію та великі літери; зміну мовця познач новим абзацом.
Прибери слова-паразити й повтори-запинки лише якщо вони явно випадкові.
Нічого не скорочуй і не підсумовуй. Якщо мовлення немає — поверни порожній рядок.`;

  // Текст із відповіді Interactions API. REST віддає поле в camelCase (outputText), SDK
  // показує output_text; про всяк випадок збираємо ще й із кроків (steps[].content[].text).
  function pickInteractionText(d) {
    if (!d) return '';
    if (typeof d.outputText === 'string') return d.outputText.trim();
    if (typeof d.output_text === 'string') return d.output_text.trim();
    const steps = Array.isArray(d.steps) ? d.steps : Array.isArray(d.outputs) ? d.outputs : [];
    const parts = [];
    for (const s of steps) {
      const content = Array.isArray(s && s.content) ? s.content : [];
      for (const c of content) if (c && typeof c.text === 'string') parts.push(c.text);
    }
    return parts.join('\n').trim();
  }

  async function transcribeViaInteractions(fileUri, mimeType, key) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GEMINI_TRANSCRIBE_MODEL,
        input: [{ type: 'audio', uri: fileUri, mime_type: mimeType }]
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const err = new Error('gemini transcribe ' + r.status + ' ' + t.slice(0, 200));
      err.status = r.status;
      throw err;
    }
    return pickInteractionText(await r.json());
  }

  // Запасний шлях: звичайна модель + промпт дослівної розшифровки. 65k токенів виводу
  // вистачає на ~4 год мовлення; якщо обріжеться — finishReason скаже (MAX_TOKENS).
  async function transcribeViaGenerate(fileUri, mimeType, key) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: mimeType, file_uri: fileUri } },
              { text: GEMINI_TRANSCRIBE_PROMPT }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 65536 }
        })
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('gemini transcribe (fallback) ' + r.status + ' ' + t.slice(0, 200));
    }
    return pickCandidateText(await r.json());
  }

  // Повна розшифровка вже залитого (ACTIVE) файлу → { text, model, finishReason }.
  // durationMs — тривалість запису, якщо відома (null → одразу пробуємо спеціалізовану модель).
  // onFallback(why) — колбек для логу, коли перемикаємось на запасну модель.
  // Мережа / 429 / 5xx НЕ перехоплюються — кидаємо далі, черга повторить пізніше.
  async function geminiTranscribeFile(fileUri, mimeType, key, durationMs, onFallback) {
    const mime = (mimeType || 'audio/webm').split(';')[0];
    const tooLong = durationMs != null && durationMs > TRANSCRIBE_MAX_MS;
    if (tooLong) {
      if (onFallback) onFallback('запис довший за 1 год — понад ліміт спеціалізованої моделі');
    } else {
      try {
        const text = await transcribeViaInteractions(fileUri, mime, key);
        if (text) return { text, model: GEMINI_TRANSCRIBE_MODEL, finishReason: 'STOP' };
        if (onFallback) onFallback('спеціалізована модель повернула порожній транскрипт');
      } catch (e) {
        // 4xx (крім 429 «ліміт запитів») — запит або аудіо модель не приймає: повтори не
        // допоможуть, тож не чекаємо 46 год, а йдемо запасним шляхом одразу.
        const s = e && e.status;
        if (!(s >= 400 && s < 500 && s !== 429)) throw e;
        if (onFallback) onFallback((e && e.message) || String(e));
      }
    }
    const { text, finishReason } = await transcribeViaGenerate(fileUri, mime, key);
    return { text, model: GEMINI_MODEL, finishReason };
  }

  // ---- Диктофон: короткий аудіоблоб → текст ----
  // Той самий шлях, що й у зустрічі: resumable-аплоад у Files API → коротке очікування
  // ACTIVE → geminiTranscribeFile (спеціалізована модель із запасним шляхом).
  // onWait — необовʼязковий колбек статусу (напр., щоб оновити тост «обробка…»).
  async function geminiTranscribe(blob, key, onWait) {
    const mime = (blob.type || 'audio/webm').split(';')[0];
    let file = await geminiUploadFile(blob, key, mime);

    // Аудіо зазвичай стає ACTIVE майже одразу; чекаємо максимум ~30 с.
    for (let i = 0; i < 30 && file.state === 'PROCESSING'; i++) {
      if (onWait) onWait(i);
      await new Promise((res) => setTimeout(res, 1000));
      file = await geminiGetFile(file.name, key);
    }
    if (file.state === 'FAILED') throw new Error('Gemini не зміг обробити аудіо');
    if (file.state === 'PROCESSING') throw new Error('Gemini надто довго обробляє аудіо');

    const { text } = await geminiTranscribeFile(file.uri, file.mimeType || mime, key, null);
    return text;
  }

  g.Gemini = {
    GEMINI_MODEL, GEMINI_TRANSCRIBE_MODEL, GEMINI_PROMPT, splitTopic,
    geminiUploadFile, geminiGetFile, geminiTranscribeFile, geminiSummarize, geminiTranscribe
  };
})(globalThis);
