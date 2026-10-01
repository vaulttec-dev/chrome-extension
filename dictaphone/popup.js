// popup.js — кнопка диктофона, гаряча клавіша, Gemini-ключ.
// Попап Chrome знищує при закритті, тож локального стану немає: усе малюється зі
// storage (dictPhase / dictLast), який веде background. Вікно можна закрити посеред
// запису — offscreen покладе транскрипт у буфер незалежно від попапа.
const dictBtn = document.getElementById('dict');
const dictStateEl = document.getElementById('dictstate');

function renderDict(phase, last) {
  const ph = phase || 'idle';
  dictBtn.classList.toggle('rec', ph === 'recording');
  dictBtn.classList.toggle('busy', ph === 'busy');
  dictBtn.disabled = ph === 'busy';
  dictBtn.textContent = ph === 'recording'
    ? '⏹ Зупинити й розшифрувати'
    : ph === 'busy'
      ? '⏳ Розшифровую…'
      : '🎤 Почати диктування';

  let text;
  let err = false;
  if (ph === 'recording') text = '● Запис… говоріть. Вікно можна закрити — запис триває.';
  else if (ph === 'busy') text = 'Gemini розшифровує аудіо…';
  else if (last && last.ok) text = last.len ? `✓ Скопійовано ${last.len} симв. — вставте через Ctrl+V.` : 'Порожньо — мовлення не розпізнано.';
  else if (last && last.error) { text = '⚠ ' + last.error; err = true; }
  else text = 'Клік або клавіша — запис, ще раз — транскрипт у буфері обміну.';
  dictStateEl.textContent = text;
  dictStateEl.classList.toggle('err', err);
}

function refreshDict() {
  chrome.storage.local.get(['dictPhase', 'dictLast'])
    .then(({ dictPhase, dictLast }) => renderDict(dictPhase, dictLast));
}

// Спершу з кешу (миттєво), слідом — справжній стан від background (звіряє з offscreen).
refreshDict();
chrome.runtime.sendMessage({ target: 'bg', type: 'STATE' })
  .then((r) => { if (r && r.ok) renderDict(r.phase, r.last); })
  .catch(() => {});

dictBtn.addEventListener('click', () => {
  // Оптимістичний вигляд; напрямок вирішує background за реальним станом offscreen,
  // правильна фаза прилетить через storage.onChanged.
  const wasRecording = dictBtn.classList.contains('rec');
  renderDict(wasRecording ? 'busy' : 'recording', null);
  chrome.runtime.sendMessage({ target: 'bg', type: 'TOGGLE' }).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.dictPhase || changes.dictLast)) refreshDict();
});

// ---- Гаряча клавіша ----
chrome.commands.getAll().then((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-dictation');
  document.getElementById('shortcut').textContent = (c && c.shortcut) || 'не призначено';
});

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---- Gemini API-ключ ----
const keyInput = document.getElementById('gkey');
const keyStateEl = document.getElementById('keystate');

function renderKeyState(key) {
  keyStateEl.textContent = key ? '✓ Ключ збережено.' : 'Без ключа диктофон не працює.';
}

chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => renderKeyState(geminiApiKey));

document.getElementById('savekey').addEventListener('click', () => {
  const key = keyInput.value.trim();
  chrome.storage.local.set({ geminiApiKey: key }).then(() => {
    keyInput.value = '';
    renderKeyState(key);
  });
});
