let touchStart = null;

document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  const detail = document.querySelector('.detail');
  if (!detail) return;
  const t = e.touches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

document.addEventListener('touchend', e => {
  if (!touchStart || e.changedTouches.length !== 1) return;
  const start = touchStart;
  touchStart = null;
  const t = e.changedTouches[0];
  const dx = t.clientX - start.x;
  const dy = t.clientY - start.y;
  if (dy < 90 || dy <= Math.abs(dx) * 1.35) return;
  if (window.scrollY > 8) return;
  const back = document.querySelector('.detail .back');
  if (back) back.click();
}, { passive: true });
