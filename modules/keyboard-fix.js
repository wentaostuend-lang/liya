// ========================================
// 移动端键盘弹出修复模块
// 解决两个问题：
// 1. 顶栏被键盘顶起/顶栏错位
// 2. 表情包智能匹配面板、发送按钮被键盘完全遮挡
//
// 原理：不依赖"容器高度是否会跟着键盘收缩"（很多 WebView/浏览器其实
// 并不会真的收缩，键盘只是悬浮盖在页面上），而是直接实时计算"键盘挡住
// 了多少高度"，把聊天输入区域(#chat-input-area)的 bottom 值顶上去，
// 让它始终紧贴在键盘上方——这样表情面板、发送按钮就不会被键盘盖住了。
// ========================================
(function () {
  const phoneScreen = document.getElementById('phone-screen');
  if (!phoneScreen) return;

  let rafId = null;
  let baselineHeight = window.innerHeight; // 没有键盘时的基准高度

  function getKeyboardHeight() {
    if (window.visualViewport) {
      const vv = window.visualViewport;
      // 键盘高度 = 窗口总高度 - 可视视口高度 - 可视视口顶部偏移(部分机型滚动了一点)
      const kb = window.innerHeight - vv.height - vv.offsetTop;
      return kb > 60 ? kb : 0; // 小于60px的误差不算键盘弹出（避免地址栏收起等抖动误判）
    }
    // 不支持 visualViewport 的兜底方案：用 resize 前后高度差估算
    const kb = baselineHeight - window.innerHeight;
    return kb > 60 ? kb : 0;
  }

  function applyFix() {
    const keyboardHeight = getKeyboardHeight();

    // 1. 手机模拟器容器高度尽量跟随可视区域（对支持的浏览器有效，双保险）
    if (window.visualViewport) {
      phoneScreen.style.height = window.visualViewport.height + 'px';
    }

    // 2. 核心修复：直接把输入区域顶到键盘上方
    //    用 setProperty(..., 'important') 是因为 CSS 里 bottom:0 写了 !important，
    //    普通的 inline style 覆盖不掉它，必须用同等优先级去覆盖。
    const chatInputArea = document.getElementById('chat-input-area');
    if (chatInputArea) {
      chatInputArea.style.setProperty('bottom', keyboardHeight + 'px', 'important');
    }

    // 3. 防止页面被自动滚动，导致顶栏跟着一起移位
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }

  function scheduleFix() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyFix);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleFix);
    window.visualViewport.addEventListener('scroll', scheduleFix);
  } else {
    // 不支持 visualViewport 的浏览器，退化用普通 resize 事件
    window.addEventListener('resize', scheduleFix);
  }

  // 输入框失焦（键盘收起）时，把输入区域和容器高度都还原
  document.addEventListener('focusout', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(function () {
        baselineHeight = window.innerHeight;
        applyFix();
      }, 100);
    }
  }, true);

  // 输入框聚焦（键盘弹出）时也立刻算一次，不等 resize 事件姗姗来迟
  document.addEventListener('focusin', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      scheduleFix();
      setTimeout(scheduleFix, 300); // 键盘动画有延迟，300ms后再修正一次
    }
  }, true);
})();
