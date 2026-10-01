// gemini.js — транскрипція короткого аудіо через Gemini (API-ключ передається аргументом).
// Шлях: resumable-аплоад у Files API → коротке очікування ACTIVE → спеціалізована модель
// gemini-3.5-transcribe (Interactions API) із запасним шляхом через flash-модель.
(function (g) {
  const GEMINI_MODEL = 'gemini-flash-latest';
  const GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

  const GEMINI_TRANSCRIBE_PROMPT = `Розшифруй це аудіо у звичайний текст — ПОВНІСТЮ, від початку до кінця.
Поверни ВИКЛЮЧНО дослівний транскрипт сказаного тією ж мовою, якою говорять
(українською — українською). Без жодних коментарів, заголовків, лапок чи пояснень.
Розстав природну пунктуацію та великі літери; зміну мовця познач новим абзацом.
Прибери слова-паразити й повтори-запинки лише якщо вони явно випадкові.
Нічого не скорочуй і не підсумовуй. Якщо мовлення немає — поверни порожній рядок.`;

  async function geminiUploadFile(blob, key, mimeType) {
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
      body: JSON.stringify({ file: { display_name: 'dictation' } })
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

  async function geminiGetFile(fileName, key) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: { 'x-goog-api-key': key }
    });
    if (!r.ok) throw new Error('gemini file get ' + r.status);
    return r.json();
  }

  // REST віддає поле в camelCase (outputText), SDK — output_text; про всяк випадок
  // збираємо ще й із кроків (steps[].content[].text).
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
    const d = await r.json();
    const cand = d && d.candidates && d.candidates[0];
    const parts = cand && cand.content && cand.content.parts;
    return parts ? parts.map((p) => p.text).filter(Boolean).join('\n').trim() : '';
  }

  // Короткий аудіоблоб → текст. Порожня відповідь або 4xx (крім 429) спеціалізованої
  // моделі → запасний шлях; мережа / 429 / 5xx кидаються далі.
  async function geminiTranscribe(blob, key) {
    const mime = (blob.type || 'audio/webm').split(';')[0];
    let file = await geminiUploadFile(blob, key, mime);

    // Аудіо зазвичай стає ACTIVE майже одразу; чекаємо максимум ~30 с.
    for (let i = 0; i < 30 && file.state === 'PROCESSING'; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      file = await geminiGetFile(file.name, key);
    }
    if (file.state === 'FAILED') throw new Error('Gemini не зміг обробити аудіо');
    if (file.state === 'PROCESSING') throw new Error('Gemini надто довго обробляє аудіо');

    const fileMime = (file.mimeType || mime).split(';')[0];
    try {
      const text = await transcribeViaInteractions(file.uri, fileMime, key);
      if (text) return text;
    } catch (e) {
      const s = e && e.status;
      if (!(s >= 400 && s < 500 && s !== 429)) throw e;
    }
    return transcribeViaGenerate(file.uri, fileMime, key);
  }

  g.Gemini = { geminiTranscribe };
})(globalThis);
