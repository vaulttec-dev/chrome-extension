// gemini.js — чисті функції Gemini (приймають API-ключ аргументом).
// Розподіл: великий аплоад відео (geminiUploadFile) робить content script —
// щоб blob не йшов через sendMessage; дрібні запити (geminiGetFile, geminiGenerate)
// веде service worker через chrome.alarms, незалежно від вкладки Meet.
(function (g) {
  const GEMINI_MODEL = 'gemini-2.5-flash';
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
Основна змістовна секція. Веди розповідь послідовно за ходом зустрічі. За потреби розбий її
на підрозділи по темах (став підзаголовки «### Назва теми»), а всередині кожної теми
фіксуй те, що реально прозвучало, конкретними пунктами:
- хто що сказав і запропонував, які навів аргументи й контраргументи;
- усі цифри, дати, суми, терміни, назви, імена, посилання, приклади;
- хід думки й те, як учасники дійшли (чи не дійшли) згоди.

## Ухвалені рішення
- Кожне рішення окремим пунктом, з контекстом: що саме вирішили й чому.

## Завдання та доручення
Перелічи ВСІ завдання, доручення й домовленості, що були ОЗВУЧЕНІ, навіть згадані мимохідь.
Формат кожного пункту: «Виконавець — що зробити — до коли». Якщо щось не назване — постав «—».
Краще включити сумнівне завдання, ніж пропустити.

## Відкриті питання
- Питання, що лишилися без відповіді або потребують подальшого з'ясування.

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

  // Згенерувати конспект із завантаженого файлу.
  async function geminiGenerate(fileUri, mimeType, key) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: mimeType || 'video/webm', file_uri: fileUri } },
              { text: GEMINI_PROMPT }
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
    const parts = d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
    if (!text) throw new Error('gemini: порожня відповідь');
    return text;
  }

  g.Gemini = { GEMINI_MODEL, GEMINI_PROMPT, geminiUploadFile, geminiGetFile, geminiGenerate };
})(globalThis);
