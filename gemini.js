// gemini.js — чисті функції Gemini (приймають API-ключ аргументом).
// Розподіл: великий аплоад відео (geminiUploadFile) робить content script —
// щоб blob не йшов через sendMessage; дрібні запити (geminiGetFile, geminiGenerate)
// веде service worker через chrome.alarms, незалежно від вкладки Meet.
(function (g) {
  // Аліас «-latest» завжди вказує на найновішу flash-модель — код не треба оновлювати
  // з виходом нових версій (конспекти й диктофон використовують цю саму константу).
  const GEMINI_MODEL = 'gemini-flash-latest';
  const GEMINI_PROMPT = `Ти — досвідчений асистент із протоколювання робочих зустрічей.
Тобі дано АУДІОЗАПИС зустрічі Google Meet. Спирайся ВИКЛЮЧНО на те, що РЕАЛЬНО СКАЗАНО вголос,
уважно «прослухай» увесь запис від початку до кінця і не пропусти жодної важливої деталі.

Спершу подумки зроби ПОВНУ розшифровку всього мовлення, а потім на її основі склади
ДЕТАЛЬНИЙ конспект УКРАЇНСЬКОЮ у форматі Markdown. Пиши детально й конкретно, але рівно
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

Якщо в записі реально немає мовлення або воно нерозбірливе — прямо так і напиши.
НІКОЛИ не повторюй той самий символ, слово чи речення поспіль і не додавай тексту-заповнювача;
якщо змісту мало — конспект короткий, і це нормально. Пиши українською, конкретно; нічого
важливого не вигадуй і не пропускай.`;

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

  // Згенерувати конспект із завантаженого файлу. context — необов'язковий текстовий блок
  // зі списком учасників та шкалою «хто коли говорив» (його збирає content script з DOM Meet).
  async function geminiGenerate(fileUri, mimeType, key, context) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: mimeType || 'video/webm', file_uri: fileUri } },
              { text: context ? GEMINI_PROMPT + '\n\n' + context : GEMINI_PROMPT }
            ]
          }],
          generationConfig: {
            mediaResolution: 'MEDIA_RESOLUTION_LOW',
            temperature: 0.6,
            maxOutputTokens: 24576
          }
        })
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('gemini generate ' + r.status + ' ' + t.slice(0, 200));
    }
    const d = await r.json();
    const cand = d && d.candidates && d.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    const finishReason = cand && cand.finishReason; // 'STOP' норм; 'MAX_TOKENS'/'SAFETY'/… = обрізано
    const text = parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
    if (!text) throw new Error('gemini: порожня відповідь' + (finishReason ? ' (finishReason: ' + finishReason + ')' : ''));
    return { text, finishReason };
  }

  // ---- Диктофон: дослівна транскрипція короткого аудіо ----
  const GEMINI_TRANSCRIBE_PROMPT = `Розшифруй це аудіо у звичайний текст.
Поверни ВИКЛЮЧНО дослівний транскрипт сказаного тією ж мовою, якою говорять
(українською — українською). Без жодних коментарів, заголовків, лапок чи пояснень.
Розстав природну пунктуацію та великі літери. Прибери слова-паразити й повтори-запинки
лише якщо вони явно випадкові. Якщо мовлення немає — поверни порожній рядок.`;

  // Короткий аудіоблоб → дослівний текст. Через Files API (той самий надійний шлях,
  // що й конспект): resumable-аплоад → коротке очікування ACTIVE → generate.
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

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: mime, file_uri: file.uri } },
              { text: GEMINI_TRANSCRIBE_PROMPT }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        })
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('gemini transcribe ' + r.status + ' ' + t.slice(0, 200));
    }
    const d = await r.json();
    const cand = d && d.candidates && d.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    return parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
  }

  g.Gemini = { GEMINI_MODEL, GEMINI_PROMPT, geminiUploadFile, geminiGetFile, geminiGenerate, geminiTranscribe };
})(globalThis);
