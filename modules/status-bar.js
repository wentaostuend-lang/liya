// ============================================================
// status-bar.js — 角色状态栏（正则+HTML模板渲染）
//
// 独立数据库 StatusBarDB 存预设库，不碰主项目 db schema。
// 变量命名沿用 ai-response.js 里 contextMap 已经在用的那套
// (char_avatar/user_avatar/char_name/char_remark/user_name/user_remark)。
//
// 数据结构：
//   StatusBarDB.presets: {id, name, promptSuffix, regexPattern, replacePattern}
//   （字段名对齐社区通用的状态栏预设JSON格式，regexPattern是"/pattern/flags"这种JS正则字面量字符串）
//   chat.settings.enableStatusBar        boolean 这个角色是否生成状态栏
//   chat.settings.statusBarPresetId       number  用哪个预设
//   chat.settings.statusBarHistoryLimit   number  最多同时显示几条历史（默认20）
//   state.globalSettings.statusBarEnabled boolean 全局总开关
// ============================================================

(function () {
  const sbDB = new Dexie('LiyaStatusBarDB');
  sbDB.version(1).stores({ presets: '++id, name' });

  // ---------------- 变量替换 + 特殊标签 + 交互按钮 ----------------
  function getVarMap(chat) {
    return {
      char_avatar: chat.isGroup ? (chat.settings.groupAvatar || '') : (chat.settings.aiAvatar || ''),
      user_avatar: chat.settings.myAvatar || (state.qzoneSettings && state.qzoneSettings.avatar) || '',
      char_name: chat.isGroup ? chat.name : (chat.originalName || chat.name),
      char_remark: chat.name,
      user_name: chat.settings.myNickname || '我',
      user_remark: chat.settings.myNickname || '我'
    };
  }

  function applyVariables(html, chat) {
    const vars = getVarMap(chat);
    let out = html.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] !== undefined ? vars[key] : match);
    // <char-avatar style="..."></char-avatar> / <user-avatar> 转成真实 <img>
    out = out.replace(/<char-avatar([^>]*)><\/char-avatar>/g, (m, attrs) => `<img src="${vars.char_avatar}"${attrs}>`);
    out = out.replace(/<user-avatar([^>]*)><\/user-avatar>/g, (m, attrs) => `<img src="${vars.user_avatar}"${attrs}>`);
    return out;
  }

  function wireInteractiveButtons(container, chatId) {
    container.querySelectorAll('[data-send-msg]').forEach(el => {
      el.addEventListener('click', () => {
        const text = el.getAttribute('data-send-msg');
        if (!text) return;
        if (typeof window.sendMessageForChat === 'function') {
          window.sendMessageForChat(chatId, text);
        } else if (typeof window.handleSendMessage === 'function') {
          window.handleSendMessage(text);
        } else {
          // 兜底：直接把文字填进输入框，模拟用户自己点发送（具体输入框id待你项目确认后可再精确对接）
          const inputEl = document.getElementById('message-input') || document.querySelector('#chat-interface-screen textarea, #chat-interface-screen input[type="text"]');
          if (inputEl) { inputEl.value = text; inputEl.dispatchEvent(new Event('input')); }
          alert('已把内容填入输入框，请手动点发送（这个按钮的自动发送对接还需要确认你项目里发送消息的具体函数名）');
        }
      });
    });
  }

  // ---------------- 正则匹配 + 渲染 ----------------
  // 解析 "/pattern/flags" 这种JS正则字面量字符串，兼容社区通用的状态栏预设格式
  function parseRegexLiteral(source) {
    if (!source) return null;
    const trimmed = source.trim();
    if (trimmed.startsWith('/')) {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1).replace(/[^gimsuy]/g, '');
        return { pattern, flags: flags.includes('g') ? flags : flags + 'g' };
      }
    }
    // 没有斜杠包裹，当成裸正则处理，兼容手写的情况
    return { pattern: trimmed, flags: 'g' };
  }

  function buildRegex(source) {
    const parsed = parseRegexLiteral(source);
    if (!parsed) return null;
    try {
      return new RegExp(parsed.pattern, parsed.flags);
    } catch (e) {
      console.error('[状态栏] 正则语法错误', e);
      return null;
    }
  }

  function renderOne(matchGroups, replacePattern, chat) {
    let html = replacePattern;
    matchGroups.forEach((g, i) => {
      const re = new RegExp('\\$' + (i + 1), 'g');
      html = html.replace(re, g !== undefined ? g : '');
    });
    return applyVariables(html, chat);
  }

  function collectStatusBars(chat, preset) {
    const regex = buildRegex(preset.regexPattern);
    if (!regex) return [];
    const limit = chat.settings.statusBarHistoryLimit || 20;
    const results = [];
    const history = (chat.history || []).filter(m => m.role !== 'user' && typeof m.content === 'string');
    for (let i = history.length - 1; i >= 0 && results.length < limit; i--) {
      const msg = history[i];
      regex.lastIndex = 0;
      const m = regex.exec(msg.content);
      if (m) {
        results.push({
          html: renderOne(m.slice(1), preset.replacePattern, chat),
          timestamp: msg.timestamp
        });
      }
    }
    return results; // 从新到旧
  }

  // ---------------- 弹窗展示 ----------------
  function injectViewerStyle() {
    if (document.getElementById('sb-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'sb-viewer-style';
    style.textContent = `
      #sb-viewer-overlay {
        position: fixed; inset: 0; z-index: 999998;
        background: rgba(0,0,0,0.45); backdrop-filter: blur(2px);
        display: flex; align-items: flex-end; justify-content: center;
      }
      #sb-viewer-panel {
        background: rgba(28,28,30,0.97); color: #fff; width: 100%; max-height: 75vh;
        border-radius: 20px 20px 0 0; overflow: hidden; display: flex; flex-direction: column;
      }
      #sb-viewer-header { display:flex; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid #333; }
      #sb-viewer-header .title { font-size:15px; font-weight:700; }
      #sb-viewer-header .close { font-size:20px; color:#999; cursor:pointer; padding:4px 8px; }
      #sb-viewer-list { overflow-y:auto; padding:12px 16px; }
      .sb-entry { margin-bottom:14px; padding-bottom:14px; border-bottom:1px dashed #333; }
      .sb-entry:last-child { border-bottom:none; }
      .sb-entry-time { font-size:10.5px; color:#777; margin-top:6px; text-align:right; }
      .sb-empty { text-align:center; color:#888; font-size:13px; padding:30px 0; }
      #sb-viewer-close-round {
        width: 44px; height: 44px; border-radius: 50%;
        background: rgba(255,255,255,0.15); backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        color: #fff; font-size: 20px; margin: 14px auto 20px; cursor: pointer;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  function showStatusBarViewer(chat, preset) {
    injectViewerStyle();
    document.getElementById('sb-viewer-overlay')?.remove();

    const entries = collectStatusBars(chat, preset);
    const overlay = document.createElement('div');
    overlay.id = 'sb-viewer-overlay';
    overlay.style.flexDirection = 'column';
    overlay.innerHTML = `
      <div id="sb-viewer-panel">
        <div id="sb-viewer-header">
          <span class="title">${chat.name} · 状态栏（${preset.name}）</span>
        </div>
        <div id="sb-viewer-list">
          ${entries.length === 0
            ? `<div class="sb-empty">还没有匹配到状态栏数据，可能AI还没按格式回复过</div>`
            : entries.map(e => `<div class="sb-entry">${e.html}<div class="sb-entry-time">${new Date(e.timestamp).toLocaleString()}</div></div>`).join('')}
        </div>
      </div>
      <div id="sb-viewer-close-round">✕</div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('sb-viewer-close-round').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    wireInteractiveButtons(overlay, chat.id);
  }

  async function handleHeaderClick() {
    const g = state.globalSettings.statusBarEnabled;
    if (!g) return; // 全局关闭，点了没反应
    const chat = state.chats[state.activeChatId];
    if (!chat || !chat.settings.enableStatusBar || !chat.settings.statusBarPresetId) return;
    const preset = await sbDB.presets.get(chat.settings.statusBarPresetId);
    if (!preset) { alert('绑定的状态栏预设不存在了，去聊天设置里重新选一个'); return; }
    showStatusBarViewer(chat, preset);
  }

  function bindHeaderClick() {
    const titleEl = document.getElementById('chat-header-title');
    if (!titleEl || titleEl.dataset.sbBound) return;
    titleEl.dataset.sbBound = '1';
    titleEl.style.cursor = 'pointer';
    titleEl.addEventListener('click', handleHeaderClick);
  }

  // ---------------- 全局开关（API设置页，心声功能开关下面） ----------------
  function injectGlobalToggle() {
    if (document.getElementById('status-bar-global-toggle')) return;
    const anchor = document.getElementById('global-enable-thoughts-switch');
    if (!anchor) { console.warn('[状态栏] 未找到心声全局开关，全局开关未注入'); return; }
    const settingsItem = anchor.closest('.settings-item');
    if (!settingsItem) return;

    const row = document.createElement('div');
    row.className = 'settings-item';
    row.innerHTML = `
      <div>
        <div style="font-weight: 500;">启用状态栏功能</div>
        <div style="font-size: 12px; color: var(--text-secondary);">开启后，绑定了状态栏预设的角色会自动生成状态数据</div>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="status-bar-global-toggle">
        <span class="slider"></span>
      </label>
    `;
    settingsItem.parentNode.insertBefore(row, settingsItem.nextSibling);

    const toggle = document.getElementById('status-bar-global-toggle');
    toggle.checked = !!state.globalSettings.statusBarEnabled;
    toggle.addEventListener('change', async () => {
      state.globalSettings.statusBarEnabled = toggle.checked;
      if (window.db && window.db.globalSettings) await db.globalSettings.put(state.globalSettings);
    });
  }

  // ---------------- 聊天设置：单角色面板 ----------------
  async function injectChatSettingsPanel() {
    const container = document.querySelector('#chat-settings-screen .settings-container');
    if (!container || document.getElementById('status-bar-chat-panel')) return;

    const section = document.createElement('div');
    section.className = 'settings-section';
    section.id = 'status-bar-chat-panel';
    section.innerHTML = `
      <div class="settings-item">
        <label>📊 为这个角色生成状态栏</label>
        <div class="settings-right"><input type="checkbox" id="sb-chat-enable-toggle"></div>
      </div>
      <div class="settings-item-block">
        <label>使用哪个预设</label>
        <select id="sb-chat-preset-select" style="width:100%;"></select>
      </div>
      <div class="settings-item-block">
        <label>最多同时显示历史条数（默认20）</label>
        <input type="number" id="sb-chat-history-limit" min="1" max="100" style="width:100%;">
      </div>
    `;
    const anchor = Array.from(container.querySelectorAll(':scope > .settings-section'))
      .find(sec => sec.textContent.includes('回复条数范围') || sec.textContent.includes('启用独立后台活动'));
    container.insertBefore(section, anchor || container.firstChild);

    document.getElementById('sb-chat-enable-toggle').addEventListener('change', async (e) => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.settings.enableStatusBar = e.target.checked;
      await db.chats.put(chat);
    });
    document.getElementById('sb-chat-preset-select').addEventListener('change', async (e) => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.settings.statusBarPresetId = parseInt(e.target.value, 10) || null;
      await db.chats.put(chat);
    });
    document.getElementById('sb-chat-history-limit').addEventListener('change', async (e) => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.settings.statusBarHistoryLimit = parseInt(e.target.value, 10) || 20;
      await db.chats.put(chat);
    });
  }

  async function loadChatSettingsPanel() {
    const chat = state.chats[state.activeChatId];
    const section = document.getElementById('status-bar-chat-panel');
    if (!chat || chat.isGroup) { section?.style.setProperty('display', 'none'); return; }
    section?.style.setProperty('display', '');

    document.getElementById('sb-chat-enable-toggle').checked = !!chat.settings.enableStatusBar;
    document.getElementById('sb-chat-history-limit').value = chat.settings.statusBarHistoryLimit || 20;

    const presets = await sbDB.presets.toArray();
    const select = document.getElementById('sb-chat-preset-select');
    select.innerHTML = presets.length === 0
      ? '<option value="">（预设库是空的，先去"状态栏"App里建一个）</option>'
      : presets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    if (chat.settings.statusBarPresetId) select.value = chat.settings.statusBarPresetId;
  }

  // ---------------- 初始化 ----------------
  function init() {
    injectGlobalToggle();
    injectChatSettingsPanel();
    bindHeaderClick();

    if (!window.__statusBarShowScreenHooked) {
      window.__statusBarShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === 'chat-settings-screen') loadChatSettingsPanel();
          if (screenId === 'chat-interface-screen') setTimeout(bindHeaderClick, 50);
          if (screenId === 'status-bar-app-screen' && typeof window.__sbRenderPresetList === 'function') window.__sbRenderPresetList();
        };
      }
    }
    console.log('[状态栏] 初始化完成');
  }

  window.__statusBarDB = sbDB; // 供预设管理App(status-bar-manager.js)复用同一个库

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.db && typeof window.showScreen === 'function' && typeof Dexie !== 'undefined' && document.getElementById('chat-settings-screen')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[状态栏] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
