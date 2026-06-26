// popup.js — статус запису та резервна ручна зупинка.
const statusEl = document.getElementById('status');
const stopBtn = document.getElementById('stop');

function render(isRecording, lastStatus) {
  statusEl.textContent = lastStatus || (isRecording ? 'Запис…' : 'Готово до запису');
  stopBtn.disabled = !isRecording;
}

function refresh() {
  chrome.storage.local.get(['isRecording', 'lastStatus']).then(({ isRecording, lastStatus }) => {
    render(!!isRecording, lastStatus);
  });
}

refresh();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') refresh();
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ target: 'bg', type: 'STOP' });
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
