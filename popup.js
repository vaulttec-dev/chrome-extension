// popup.js — статус, Gemini-ключ і повноцінний журнал (персистентні логи).
const statusEl = document.getElementById('status');

function refresh() {
  chrome.storage.local.get(['isRecording', 'lastStatus']).then(({ isRecording, lastStatus }) => {
    statusEl.textContent = lastStatus || (isRecording ? 'Запис…' : 'Готово до запису');
  });
}

refresh();

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

// ---- Логи (персистентний журнал; найновіші зверху, з роздільниками по днях) ----
const logEl = document.getElementById('log');
const clearLogBtn = document.getElementById('clearlog');

const p = (n) => String(n).padStart(2, '0');
function fmtTime(t) {
  const d = new Date(t);
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDay(t) {
  const d = new Date(t);
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function renderLog(logs) {
  const arr = Array.isArray(logs) ? logs : [];
  if (!arr.length) { logEl.innerHTML = '<span class="empty">Поки що порожньо.</span>'; return; }
  logEl.innerHTML = '';
  let curDay = '';
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i];
    const day = fmtDay(e.t);
    if (day !== curDay) {
      curDay = day;
      const hdr = document.createElement('div');
      hdr.className = 'day';
      hdr.textContent = day;
      logEl.appendChild(hdr);
    }
    const row = document.createElement('div');
    row.className = 'row' + (e.lvl === 'warn' ? ' warn' : e.lvl === 'error' ? ' error' : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(e.t) + ' ';
    row.appendChild(t);
    const extra = e.rec ? ' · ' + e.rec : '';
    row.appendChild(document.createTextNode('[' + (e.stage || '') + '] ' + (e.msg || '') + extra));
    logEl.appendChild(row);
  }
}

chrome.storage.local.get('logs').then(({ logs }) => renderLog(logs));

clearLogBtn.addEventListener('click', () => {
  chrome.storage.local.remove('logs').then(() => renderLog([]));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.logs) renderLog(changes.logs.newValue);
  if (changes.isRecording || changes.lastStatus) refresh();
});
