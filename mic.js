// mic.js — одноразовий запит дозволу мікрофона у видимій вкладці розширення.
// Дозвіл зберігається для origin розширення й надалі діє в offscreen-документі.
(function () {
  const el = document.getElementById('state');
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => {
      stream.getTracks().forEach((t) => t.stop());
      el.textContent = '✓ Дозвіл надано. Можете закрити цю вкладку й натискати кнопку 🎤 на будь-якому сайті.';
      el.className = 'ok';
    })
    .catch((e) => {
      el.textContent = '✗ Доступ не надано (' + (e && e.name || 'помилка') +
        '). Натисніть значок 🔒 у рядку адреси → дозвольте мікрофон, або перезавантажте цю сторінку.';
      el.className = 'err';
    });
})();
