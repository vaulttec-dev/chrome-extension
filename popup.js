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

// ---- Історія (персистентний лог) ----
const logEl = document.getElementById('log');
const clearLogBtn = document.getElementById('clearlog');

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLog(logs) {
  const arr = Array.isArray(logs) ? logs : [];
  if (!arr.length) { logEl.innerHTML = '<span class="empty">Поки що порожньо.</span>'; return; }
  // найновіші зверху
  logEl.innerHTML = '';
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    const row = document.createElement('div');
    row.className = 'row' + (e.lvl === 'warn' ? ' warn' : e.lvl === 'error' ? ' error' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(e.t) + ' ';
    row.appendChild(t);
    row.appendChild(document.createTextNode('[' + (e.stage || '') + '] ' + (e.msg || '')));
    logEl.appendChild(row);
  }
}

chrome.storage.local.get('logs').then(({ logs }) => renderLog(logs));

clearLogBtn.addEventListener('click', () => {
  chrome.storage.local.remove('logs').then(() => renderLog([]));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.logs) renderLog(changes.logs.newValue);
});
