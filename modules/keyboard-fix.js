// ========================================
// 移动端键盘弹出修复模块（V2：修复"输入区被顶飞"的双重补偿 bug）
//
// 只做一件事：实时算出键盘挡住了多少高度，把 #chat-input-area 的
// bottom 顶上去正好这么多——不再同时改 #phone-screen 的高度，
// 避免和这个偏移量叠加导致"飞天"。
//
// 顺带实现：打字 / 键盘弹出时，聊天消息区自动滚动到最后一条，
// 且只是滚 #chat-messages 内部的 scrollTop，不改布局、不把内容
// 往上顶，贴近原生 App 的体验。
// ========================================
(function () {
  const phoneScreen = document.getElementById('phone-screen');
  if (!phoneScreen) return;

  let rafId = null;
  let baselineHeight = window.innerHeight; // 没有键盘时的基准高度（无 visualViewport 时的兜底用）

  function getKeyboardHeight() {
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const kb = window.innerHeight - vv.height - vv.offsetTop;
      return kb > 60 ? kb : 0; // 小于60px的误差不算键盘弹出
    }
    const kb = baselineHeight - window.innerHeight;
    return kb > 60 ? kb : 0;
  }

  function isChatScreenActive() {
    const chatScreen = document.getElementById('chat-interface-screen');
    return !!(chatScreen && chatScreen.classList.contains('active'));
  }

  function scrollChatToBottom() {
    if (!isChatScreenActive()) return;
    const messages = document.getElementById('chat-messages');
    if (!messages) return;

    const keyboardHeight = getKeyboardHeight();
    if (keyboardHeight > 0) {
      // 键盘弹出时，在消息区末尾额外留出等于键盘高度的滚动余量，
      // 这样才能真正把最后一条消息滚到键盘上方（不是移动已有消息，
      // 只是让可滚动范围变大，纯滚动效果）
      messages.style.setProperty(
        'padding-bottom',
        `calc(120px + env(safe-area-inset-bottom, 0px) + ${keyboardHeight}px)`,
        'important'
      );
    } else {
      // 键盘收起，恢复 CSS 里原本定义的内边距
      messages.style.removeProperty('padding-bottom');
    }

    messages.scrollTop = messages.scrollHeight;
  }

  function applyFix() {
    const keyboardHeight = getKeyboardHeight();

    // 核心修复：只用这一种方式顶输入区域，不再叠加容器高度收缩
    const chatInputArea = document.getElementById('chat-input-area');
    if (chatInputArea) {
      chatInputArea.style.setProperty('bottom', keyboardHeight + 'px', 'important');
    }

    // 防止页面被自动滚动，导致顶栏跟着一起移位
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }

    // 键盘状态变化时，聊天区顺带滚到最后一条（不遮挡）
    scrollChatToBottom();
  }

  function scheduleFix() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(applyFix);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleFix);
    window.visualViewport.addEventListener('scroll', scheduleFix);
  } else {
    window.addEventListener('resize', scheduleFix);
  }

  // 输入框聚焦（键盘弹出）：立刻修正一次，键盘动画有延迟，300ms后再修正一次
  document.addEventListener('focusin', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      scheduleFix();
      setTimeout(scheduleFix, 300);
      // 聊天输入框一获得焦点，立刻滚到最后一条，模拟原生App"点输入框自动滚底"的体验
      if (e.target.id === 'chat-input') {
        scrollChatToBottom();
        setTimeout(scrollChatToBottom, 300);
      }
    }
  }, true);

  // 输入框失焦（键盘收起）：还原
  document.addEventListener('focusout', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
      setTimeout(function () {
        baselineHeight = window.innerHeight;
        applyFix();
      }, 100);
    }
  }, true);

  // 打字过程中也顺带滚到最后一条（比如对方在你打字时发来新消息，也希望能看见）
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'chat-input') {
      scrollChatToBottom();
    }
  }, true);
})();
