// logstore.js — персистентний кільцевий лог у chrome.storage.local (ключ 'logs').
// Переживає перезавантаження вкладки/воркера, тож історію запису й конспекту видно
// в popup постфактум. Спільний для content script і service worker (importScripts).
// Дзеркалить у console (щоб DevTools теж працював) і додає запис у кільцевий буфер.
(function (g) {
  const KEY = 'logs';
  const MAX = 300; // старіші за це витісняються
  let chain = Promise.resolve(); // серіалізуємо read-modify-write у межах контексту

  // level: 'info' | 'warn' | 'error'; stage: 'record'|'save'|'gemini'|'recovery'|'status'|...
  function log(level, stage, msg, extra) {
    const text = (msg && msg.message) ? msg.message : String(msg);
    const entry = { t: Date.now(), lvl: level, stage, msg: text };
    if (extra && typeof extra === 'object') Object.assign(entry, extra);

    const c = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    c('[MeetRec]', stage + ':', text, extra || '');

    chain = chain.then(async () => {
      try {
        const got = await chrome.storage.local.get(KEY);
        const arr = Array.isArray(got[KEY]) ? got[KEY] : [];
        arr.push(entry);
        if (arr.length > MAX) arr.splice(0, arr.length - MAX);
        await chrome.storage.local.set({ [KEY]: arr });
      } catch (e) {
        // лог не має валити основний потік
      }
    });
    return chain;
  }

  g.MRLog = { log };
})(globalThis);
