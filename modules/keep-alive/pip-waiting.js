// ============================================================
// pip-waiting.js — 移动端视频画中画等待窗（能力检测后显示）
// ============================================================
(function () {
  'use strict';

  let video = null;
  let canvas = null;
  let context = null;
  let animationId = null;
  let startedAt = 0;
  let currentName = '';
  let completed = false;

  function isSupported() {
    return !!(
      document.pictureInPictureEnabled &&
      window.HTMLVideoElement &&
      HTMLVideoElement.prototype.requestPictureInPicture &&
      window.HTMLCanvasElement &&
      HTMLCanvasElement.prototype.captureStream
    );
  }

  function draw() {
    if (!context || !canvas) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    const pulse = 0.65 + Math.sin(Date.now() / 420) * 0.18;

    context.fillStyle = '#f7f7fb';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = completed ? '#34c759' : '#007aff';
    context.globalAlpha = pulse;
    context.beginPath();
    context.arc(52, 90, 22, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.fillStyle = '#1c1c1e';
    context.font = '600 20px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(completed ? '回复已完成' : `${currentName || '对方'}正在回复`, 88, 82);
    context.fillStyle = '#8e8e93';
    context.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    context.fillText(completed ? '返回 EPhone 查看消息' : `已等待 ${minutes}:${seconds} · 任务已保存`, 88, 108);
    animationId = requestAnimationFrame(draw);
  }

  async function open(chatName) {
    if (!isSupported()) throw new Error('当前浏览器不支持等待小窗');
    currentName = chatName || '';
    completed = false;
    startedAt = Date.now();

    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      context = canvas.getContext('2d');
    }
    if (!video) {
      video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px;';
      video.srcObject = canvas.captureStream(12);
      video.addEventListener('leavepictureinpicture', () => {
        if (animationId) cancelAnimationFrame(animationId);
        animationId = null;
      });
      document.body.appendChild(video);
    }
    if (animationId) cancelAnimationFrame(animationId);
    draw();
    await video.play();
    await video.requestPictureInPicture();
  }

  function markCompleted() {
    completed = true;
    if (!animationId) draw();
  }

  window.ReplyGuardianPiP = { isSupported, open, markCompleted };
})();
