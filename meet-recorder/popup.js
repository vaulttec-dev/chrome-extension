// popup.js — статус, якість відео, Gemini-ключ.
const statusEl = document.getElementById('status');

function refresh() {
  chrome.storage.local.get(['isRecording', 'lastStatus']).then(({ isRecording, lastStatus }) => {
    statusEl.textContent = lastStatus || (isRecording ? 'Запис…' : 'Готово до запису');
  });
}

refresh();

// ---- Якість відео ----
// «Авто» = замір швидкості кодування на старті запису (див. content.js): вища
// роздільність вмикається лише там, де машина витягне її без дропу кадрів.
const qualityEl = document.getElementById('quality');
const qualityHintEl = document.getElementById('qualityhint');

function renderQualityHint(v) {
  qualityHintEl.textContent = v === 'auto'
    ? 'Перед стартом заміряється швидкість кодера й береться найвищий профіль без ризику ривків.'
    : 'Фіксований профіль. Якщо CPU не встигатиме — розширення само знизить кадри/с, роздільність лишиться.';
}

chrome.storage.local.get('videoQuality').then(({ videoQuality }) => {
  const v = videoQuality || 'auto';
  qualityEl.value = v;
  renderQualityHint(v);
});

qualityEl.addEventListener('change', () => {
  const v = qualityEl.value;
  chrome.storage.local.set({ videoQuality: v }).then(() => renderQualityHint(v));
});

// ---- Gemini API-ключ ----
const keyInput = document.getElementById('gkey');
const saveKeyBtn = document.getElementById('savekey');
const keyStateEl = document.getElementById('keystate');

function renderKeyState(key) {
  keyStateEl.textContent = key
    ? '✓ Ключ збережено — конспект робитиметься автоматично.'
    : 'Без ключа конспект не робиться (зберігається лише відео).';
}

chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => {
  renderKeyState(geminiApiKey);
});

saveKeyBtn.addEventListener('click', () => {
  const key = keyInput.value.trim();
  chrome.storage.local.set({ geminiApiKey: key }).then(() => {
    keyInput.value = '';
    renderKeyState(key);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.isRecording || changes.lastStatus) refresh();
});
