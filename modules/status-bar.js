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
    const dismissed = new Set(chat.settings.dismissedStatusBarKeys || []);
    const results = [];
    const history = (chat.history || []).filter(m => m.role !== 'user' && typeof m.content === 'string');
    for (let i = history.length - 1; i >= 0 && results.length < limit; i--) {
      const msg = history[i];
      if (dismissed.has(msg.timestamp)) continue; // 被"删除"过的状态栏跳过，但消息本身还在聊天记录里
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

  // ---------------- 弹窗展示（全屏沉浸 + 左右滑动轮播） ----------------
  function injectViewerStyle() {
    if (document.getElementById('sb-viewer-style')) return;
    const style = document.createElement('style');
    style.id = 'sb-viewer-style';
    style.textContent = `
      #sb-viewer-overlay {
        position: fixed; inset: 0; z-index: 999998;
        background: rgba(0,0,0,0.45);
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      #sb-viewer-track {
        flex: 1; display: flex; height: 100%;
        transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
        touch-action: pan-y;
      }
      .sb-page {
        flex: 0 0 100%; width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        padding: 60px 20px 100px; box-sizing: border-box;
        overflow-y: auto;
        scrollbar-width: none; /* Firefox 隐藏滚动条 */
        -ms-overflow-style: none;
      }
      .sb-page::-webkit-scrollbar { display: none; } /* Chrome/Safari 隐藏滚动条 */
      .sb-page-inner { width: 100%; }
      .sb-empty { text-align:center; color: rgba(255,255,255,0.6); font-size:13px; }

      /* ---- 多选删除模式 ---- */
      #sb-select-list {
        position: fixed; inset: 0; z-index: 999997; overflow-y: auto;
        padding: 70px 16px 90px; box-sizing: border-box;
        scrollbar-width: none;
      }
      #sb-select-list::-webkit-scrollbar { display: none; }
      .sb-select-card {
        position: relative; margin-bottom: 14px; border-radius: 16px; overflow: hidden;
        border: 2px solid transparent;
      }
      .sb-select-card.checked { border-color: rgba(255,255,255,0.8); }
      .sb-select-card .sb-select-mark {
        position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; border-radius: 50%;
        background: rgba(0,0,0,0.4); border: 1.5px solid rgba(255,255,255,0.7);
        display: flex; align-items: center; justify-content: center; color: #fff; font-size: 13px;
      }
      .sb-select-card.checked .sb-select-mark { background: #0A84FF; border-color: #0A84FF; }
      #sb-select-bottom-bar {
        position: fixed; left: 0; right: 0; bottom: 0; z-index: 999999;
        background: rgba(28,28,30,0.92); backdrop-filter: blur(16px);
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 18px calc(14px + env(safe-area-inset-bottom));
        color: #fff; font-size: 14px;
      }
      #sb-select-bottom-bar .sb-count { color: rgba(255,255,255,0.7); font-size: 13px; }
      #sb-select-bottom-bar .sb-actions { display: flex; gap: 16px; }
      #sb-select-bottom-bar button { border: none; background: none; color: #fff; font-size: 14px; padding: 6px 4px; }
      #sb-select-bottom-bar button.sb-delete-selected { color: #ff453a; font-weight: 600; }
      #sb-select-bottom-bar button.sb-delete-selected:disabled { color: rgba(255,69,58,0.35); }

      /* 玻璃质感按钮：参考色值来自你自己项目里v7/v8那套暗色玻璃面板变量 */
      .sb-glass-btn {
        width: 46px; height: 46px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        color: rgba(255,255,255,0.9); font-size: 18px; cursor: pointer;
        background: linear-gradient(160deg, rgba(60,60,70,0.45) 0%, rgba(25,25,32,0.30) 100%);
        border: 1px solid rgba(255,255,255,0.05);
        border-top: 0.8px solid rgba(255,255,255,0.18);
        border-left: 0.8px solid rgba(255,255,255,0.08);
        box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3),
          inset 0 0.5px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.22);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
      }
      #sb-viewer-edit {
        position: fixed; top: max(16px, env(safe-area-inset-top)); right: 16px; z-index: 999999;
      }
      #sb-viewer-close-round {
        position: fixed; left: 50%; bottom: max(28px, env(safe-area-inset-bottom));
        transform: translateX(-50%); z-index: 999999;
      }
      #sb-viewer-dots {
        position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%);
        z-index: 999999; display: flex; gap: 6px;
      }
      #sb-viewer-dots .dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.35); }
      #sb-viewer-dots .dot.active { background: rgba(255,255,255,0.9); }
      #sb-viewer-counter {
        position: fixed; left: 50%; bottom: 88px; transform: translateX(-50%);
        z-index: 999999; color: rgba(255,255,255,0.7); font-size: 11px;
        background: rgba(0,0,0,0.3); padding: 3px 10px; border-radius: 20px;
        backdrop-filter: blur(6px);
      }
    `;
    document.head.appendChild(style);
  }

  function showStatusBarViewer(chat, preset) {
    injectViewerStyle();
    document.getElementById('sb-viewer-overlay')?.remove();
    document.getElementById('sb-select-list')?.remove();
    document.getElementById('sb-select-bottom-bar')?.remove();

    let entries = collectStatusBars(chat, preset);
    let currentIndex = 0; // 0 = 最新

    const overlay = document.createElement('div');
    overlay.id = 'sb-viewer-overlay';

    function renderFrame() {
      const dotsHtml = entries.length > 1
        ? `<div id="sb-viewer-dots">${entries.map((_, i) => `<div class="dot ${i === currentIndex ? 'active' : ''}"></div>`).join('')}</div>`
        : '';
      const counterHtml = entries.length > 1 ? `<div id="sb-viewer-counter">${currentIndex + 1} / ${entries.length}</div>` : '';

      overlay.innerHTML = `
        <div id="sb-viewer-track">
          ${entries.length === 0
            ? `<div class="sb-page"><div class="sb-empty">还没有匹配到状态栏数据，可能AI还没按格式回复过</div></div>`
            : entries.map(e => `<div class="sb-page"><div class="sb-page-inner">${e.html}</div></div>`).join('')}
        </div>
        <div id="sb-viewer-edit" class="sb-glass-btn">✓</div>
        <div id="sb-viewer-close-round" class="sb-glass-btn">✕</div>
        ${dotsHtml}${counterHtml}
      `;

      const track = document.getElementById('sb-viewer-track');
      track.style.transform = `translateX(${-currentIndex * 100}%)`;

      document.getElementById('sb-viewer-close-round').addEventListener('click', () => overlay.remove());
      document.getElementById('sb-viewer-edit').addEventListener('click', enterSelectMode);
      wireInteractiveButtons(overlay, chat.id);
      bindSwipe(track);
    }

    // ---- 多选删除模式：只把状态栏标记为"隐藏"，不动背后的聊天消息 ----
    function enterSelectMode() {
      if (entries.length === 0) return;
      overlay.style.display = 'none';

      const selected = new Set();
      const listEl = document.createElement('div');
      listEl.id = 'sb-select-list';
      listEl.innerHTML = entries.map((e, i) => `
        <div class="sb-select-card" data-idx="${i}">
          <div class="sb-page-inner">${e.html}</div>
          <div class="sb-select-mark">✓</div>
        </div>
      `).join('');

      const barEl = document.createElement('div');
      barEl.id = 'sb-select-bottom-bar';
      const updateBar = () => {
        barEl.innerHTML = `
          <span class="sb-count">已选 ${selected.size} 项</span>
          <div class="sb-actions">
            <button id="sb-select-all-btn">${selected.size === entries.length ? '取消全选' : '全选'}</button>
            <button class="sb-delete-selected" id="sb-delete-selected-btn" ${selected.size === 0 ? 'disabled' : ''}>删除选中</button>
            <button id="sb-select-cancel-btn">取消</button>
          </div>
        `;
        document.getElementById('sb-select-all-btn').addEventListener('click', () => {
          if (selected.size === entries.length) selected.clear();
          else entries.forEach((_, i) => selected.add(i));
          syncCardChecks(); updateBar();
        });
        document.getElementById('sb-delete-selected-btn').addEventListener('click', deleteSelected);
        document.getElementById('sb-select-cancel-btn').addEventListener('click', exitSelectMode);
      };

      function syncCardChecks() {
        listEl.querySelectorAll('.sb-select-card').forEach(card => {
          card.classList.toggle('checked', selected.has(parseInt(card.dataset.idx, 10)));
        });
      }

      listEl.querySelectorAll('.sb-select-card').forEach(card => {
        card.addEventListener('click', () => {
          const idx = parseInt(card.dataset.idx, 10);
          if (selected.has(idx)) selected.delete(idx); else selected.add(idx);
          syncCardChecks(); updateBar();
        });
      });

      async function deleteSelected() {
        if (selected.size === 0) return;
        const keysToHide = Array.from(selected).map(i => entries[i].timestamp);
        if (!chat.settings.dismissedStatusBarKeys) chat.settings.dismissedStatusBarKeys = [];
        chat.settings.dismissedStatusBarKeys.push(...keysToHide);
        await db.chats.put(chat);

        entries = collectStatusBars(chat, preset);
        currentIndex = 0;
        exitSelectMode();
        if (entries.length === 0) { overlay.remove(); return; }
        overlay.style.display = 'flex';
        renderFrame();
      }

      function exitSelectMode() {
        listEl.remove();
        barEl.remove();
        overlay.style.display = 'flex';
      }

      document.body.appendChild(listEl);
      document.body.appendChild(barEl);
      updateBar();
    }

    function bindSwipe(track) {
      let startX = 0, startY = 0, dragging = false, moved = false;
      track.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY; dragging = true; moved = false;
      }, { passive: true });
      track.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) moved = true;
      }, { passive: true });
      track.addEventListener('touchend', (e) => {
        if (!dragging) return;
        dragging = false;
        if (!moved) return;
        const dx = e.changedTouches[0].clientX - startX;
        if (dx < -40 && currentIndex < entries.length - 1) currentIndex++;
        else if (dx > 40 && currentIndex > 0) currentIndex--;
        renderFrame();
      });
    }

    document.body.appendChild(overlay);
    renderFrame();
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
