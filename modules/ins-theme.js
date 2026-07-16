// ============================================================
// ins-theme.js — INS 风（黑白灰）美化
//
// 范围：只作用于"各个App的主页 + 操作/设置面板"，不碰聊天气泡(#chat-interface-screen)
// 和聊天列表(#chat-list-screen)——用户会用别的美化方案单独处理那两块。
//
// 重要技术说明：CSS的filter一旦加在父容器上，子元素没法用filter:none撤销
// （父子一起被光栅化处理），所以这里改成【逐个非聊天screen单独套filter】，
// 而不是套在#phone-screen这个共同父容器上，从根源上排除聊天区域。
//
// 状态持久化：state.globalSettings.insThemeEnabled
// ============================================================

(function () {
  const EXCLUDE_SELECTOR = ':not(#chat-interface-screen):not(#chat-list-screen)';

  function injectStyle() {
    if (document.getElementById('ins-theme-style')) return;
    const style = document.createElement('style');
    style.id = 'ins-theme-style';
    style.textContent = `
      /* ---- 逐屏应用：变量 + 滤镜都各自局部生效，聊天界面/聊天列表完全不受影响 ----
         选择器同时覆盖 .screen 类和 #phone-screen 任意直接子级，
         不管某个App的主页是不是走标准 .screen 切换机制，都能兜到 */
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR},
      #phone-screen.ins-mode > *${EXCLUDE_SELECTOR} {
        --accent-color: #1a1a1a !important;
        --secondary-bg: #f4f4f4 !important;
        --border-color: #d9d9d9 !important;
        --text-primary: #111111 !important;
        --text-secondary: #7d7d7d !important;
        filter: grayscale(1) contrast(1.06) brightness(1.02);
      }
      #phone-screen.ins-mode.dark-mode .screen${EXCLUDE_SELECTOR},
      #phone-screen.ins-mode.dark-mode > *${EXCLUDE_SELECTOR} {
        --accent-color: #e5e5e5 !important;
        --secondary-bg: #161616 !important;
        --border-color: #2e2e2e !important;
        --text-primary: #f2f2f2 !important;
        --text-secondary: #8f8f8f !important;
      }
      /* 逃生舱口：某个元素不想被滤镜影响，加 class="ins-exempt"（仅对自身生效，
         不能用来豁免"父级screen的滤镜"，只适合豁免同一屏内单独追加filter的元素） */
      #phone-screen.ins-mode .ins-exempt { filter: none !important; }

      /* ---- 装饰性英文标签：挂在标题旁边，纯氛围装饰，没有实际含义 ---- */
      .ins-decor-tag {
        display: inline-block;
        font-family: 'Courier New', monospace;
        font-size: 9.5px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        padding: 2px 7px;
        margin-left: 8px;
        border: 1px solid currentColor;
        border-radius: 20px;
        opacity: 0.5;
        vertical-align: middle;
        font-weight: 400;
      }

      /* ---- 标题加粗 + 操作面板卡片化，对照参考图那种深色圆角+图标行的风格 ---- */
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .header,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .modal-header,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-section-title {
        font-weight: 800 !important;
        letter-spacing: 0.2px;
      }

      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} button,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} input[type="text"],
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} input[type="number"],
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} input[type="search"],
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} textarea,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} select,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .modal-content {
        border-radius: 18px !important;
      }
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .app-icon .icon-bg {
        border-radius: 24px !important;
      }

      /* 操作面板卡片：settings-section 变成深色圆角卡片容器，settings-item 变成
         图标+文字+开关的行，行与行之间用细分割线，贴合参考图那种极简列表感 */
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-section {
        background: var(--secondary-bg) !important;
        border: 1px solid var(--border-color) !important;
        border-radius: 20px !important;
        overflow: hidden;
        box-shadow: none !important;
      }
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-item,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-item-block {
        border-bottom: 1px solid var(--border-color) !important;
        background: transparent !important;
      }
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-section > *:last-child {
        border-bottom: none !important;
      }
      /* 危险/删除类操作单独标红，跟参考图"清除聊天记录/拉黑联系人"的处理方式一致 */
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .danger,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} .settings-item.danger,
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} [class*="delete"],
      #phone-screen.ins-mode .screen${EXCLUDE_SELECTOR} [class*="danger"] {
        color: #ff453a !important;
        filter: none;
      }

      /* ---- 外观设置里的开关样式 ---- */
      .ins-theme-appearance-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; margin: 10px 12px;
        background: var(--secondary-bg, #f7f7f7);
        border: 1px solid var(--border-color, #e0e0e0);
        border-radius: 10px;
      }
      .ins-theme-appearance-row .label { font-size: 14px; font-weight: 700; color: var(--text-primary, #000); }
      .ins-theme-appearance-row .desc { font-size: 11.5px; color: var(--text-secondary, #999); margin-top: 3px; }
    `;
    document.head.appendChild(style);
  }

  function getConfig() {
    if (state.globalSettings.insThemeEnabled === undefined) state.globalSettings.insThemeEnabled = false;
    return state.globalSettings.insThemeEnabled;
  }

  async function setEnabled(enabled) {
    state.globalSettings.insThemeEnabled = enabled;
    applyTheme();
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error('[INS风] 保存失败', e); }
    }
  }

  function applyTheme() {
    const phoneScreen = document.getElementById('phone-screen');
    if (!phoneScreen) return;
    const enabled = !!getConfig();
    phoneScreen.classList.toggle('ins-mode', enabled);
    if (enabled) decorateHeaders();
  }

  const DECOR_POOL = ['SYS.04', 'V2.1', 'LOCAL', 'NO SIGNAL', 'OFFLINE', 'BETA.01', 'ARCHIVE', 'STATIC', 'RE:01'];
  function decorateHeaders() {
    document.querySelectorAll('.screen').forEach(screen => {
      if (screen.id === 'chat-interface-screen' || screen.id === 'chat-list-screen') return;
      const header = screen.querySelector('.header');
      if (!header || header.querySelector('.ins-decor-tag')) return;
      const tag = document.createElement('span');
      tag.className = 'ins-decor-tag';
      tag.textContent = DECOR_POOL[Math.floor(Math.random() * DECOR_POOL.length)];
      header.appendChild(tag);
    });
  }

  function injectAppearanceToggle() {
    if (document.getElementById('ins-theme-toggle')) return;
    const screen = document.getElementById('wallpaper-screen');
    if (!screen) { console.warn('[INS风] 未找到 #wallpaper-screen，开关未注入'); return; }

    const row = document.createElement('div');
    row.className = 'ins-theme-appearance-row';
    row.innerHTML = `
      <div>
        <div class="label">🖤 INS风美化</div>
        <div class="desc">黑白灰极简风格，只影响各App主页和操作面板，不影响聊天气泡/聊天列表</div>
      </div>
      <input type="checkbox" id="ins-theme-toggle">
    `;
    const container = screen.querySelector('.settings-container, .settings-list, .modal-body, .screen-body') || screen;
    container.insertBefore(row, container.firstChild);

    const toggle = document.getElementById('ins-theme-toggle');
    toggle.checked = !!getConfig();
    toggle.addEventListener('change', () => setEnabled(toggle.checked));
  }

  function init() {
    injectStyle();
    injectAppearanceToggle();
    applyTheme();

    if (!window.__insThemeShowScreenHooked) {
      window.__insThemeShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (getConfig()) decorateHeaders();
        };
      }
    }
    console.log('[INS风] 初始化完成');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.db && document.getElementById('phone-screen')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[INS风] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
