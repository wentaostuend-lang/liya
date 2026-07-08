// ========================================
// 移动端键盘弹出导致顶栏被顶起 —— 修复模块
// 原理：手机键盘弹出时，浏览器会平移"可视视口(visualViewport)"
// 把光标带入可视区域，这个平移与 CSS 的 position:fixed/absolute
// 无关（它们是相对"布局视口"定位的），所以必须用 JS 主动接管，
// 把容器高度钉死在 visualViewport.height，并阻止页面被自动滚动。
// ========================================
(function () {
  if (!window.visualViewport) return; // 不支持的浏览器直接跳过，不影响原有功能

  const phoneScreen = document.getElementById('phone-screen');
  if (!phoneScreen) return;

  let rafId = null;

  function applyViewportFix() {
    const vv = window.visualViewport;

    // 1. 让手机模拟器容器的高度跟随"可视视口"，而不是布局视口(100vh)
    //    这样键盘弹出后，容器会真正变矮，而不是被平移/裁切
    phoneScreen.style.height = vv.height + 'px';

    // 2. 有些机型/浏览器键盘弹出时仍会把 window 滚动一点点，
    //    强制归零，防止顶栏跟着一起被"卷走"
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }

    // 3. 双保险：如果当前激活的是聊天详情页，确保输入框区域紧贴新的可视区域底部
    //    （chat-input-area 本身已经是 position:absolute; bottom:0，
    //    只要 #chat-interface-screen 高度跟着变了，它自然会跟上，
    //    这里不需要额外处理，写出来只是方便你以后调试时知道链路）
  }

  function scheduleFix() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyViewportFix);
  }

  window.visualViewport.addEventListener('resize', scheduleFix);
  window.visualViewport.addEventListener('scroll', scheduleFix);

  // 键盘收起后（输入框失焦），把高度还原成整屏，避免残留一个小高度
  document.addEventListener('focusout', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(function () {
        phoneScreen.style.height = window.visualViewport.height + 'px';
      }, 100);
    }
  }, true);
})();
