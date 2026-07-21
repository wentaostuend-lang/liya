// ============================================================
// status-bar.js — 角色状态栏（正则+HTML模板渲染）
//
// 独立数据库 StatusBarDB 存预设库，不碰主项目 db schema。
// 变量命名沿用 ai-response.js 里 contextMap 已经在用的那套
// (char_avatar/user_avatar/char_name/char_remark/user_name/user_remark)。
//
// 数据来源（重要，和早期版本不一样）：
//   状态栏的原始文本不再是"AI自然写在回复正文里、前端正则去聊天气泡里扫"，
//   而是跟着 update_thoughts 指令（心声/散记）一起，作为 status_bar 字段输出，
//   存在 chat.thoughtsHistory[i].customThoughts.status_bar 里。
//   这样天然不会出现在聊天气泡里（不用碰聊天气泡的渲染函数），
//   也复用了 update_thoughts 已经验证过比较稳定、不容易被复读的生成方式。
//   正则(regexPattern)和HTML模板(replacePattern)还是原来那套，只是现在拿去匹配
//   status_bar 字符串，而不是匹配聊天消息正文。
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

  // 给iframe要加载的HTML默认兜上app本身的字体——如果预设自己在<style>里声明了font-family，
  // 那条规则出现在后面，层叠优先级一样时"后面的赢"，所以预设自己的字体设置不受影响；
  // 如果预设根本没提字体，就用这个默认值兜底，不会退回手机系统默认字体。
  const SB_DEFAULT_FONT_STYLE = `<style>html,body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}</style>`;
  function wrapHtmlWithDefaultFont(html) {
    if (!html) return html;
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
      // 完整文档：插到<head>开头，让预设自己后面的<style>能顺理成章地覆盖它
      const idx = html.indexOf(headMatch[0]) + headMatch[0].length;
      return html.slice(0, idx) + SB_DEFAULT_FONT_STYLE + html.slice(idx);
    }
    // 没有<head>，大概率是纯片段（比如只用了行内style），直接在最前面加就行，不用担心DOCTYPE位置
    return SB_DEFAULT_FONT_STYLE + html;
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
    // 修复：之前是按 $1、$2...$9、$10、$11 这样顺序逐个用 new RegExp('\\$'+n) 替换，
    // 但 "$1" 是 "$10"/"$11"/"$13"...的前缀，先替换 $1 会把 $10~$19、$1X 这些也提前吃掉一部分
    // （比如 $13 会被 $1 的替换啃掉一半，变成 "值3"）。字段数一旦超过9个（这个预设有33个）就会开始出错，
    // 这也是"只能渲染出一部分"的根因。改成一次性用 \$(\d+) 整体匹配，数字部分交给正则自己贪婪匹配，
    // 就不会有 $1 抢跑吃掉 $10/$13 的问题了。
    const html = replacePattern.replace(/\$(\d+)/g, (match, numStr) => {
      const idx = parseInt(numStr, 10) - 1;
      const g = matchGroups[idx];
      return g !== undefined ? g : '';
    });
    return applyVariables(html, chat);
  }

  function collectStatusBars(chat, preset) {
    const regex = buildRegex(preset.regexPattern);
    if (!regex) return [];
    const limit = chat.settings.statusBarHistoryLimit || 20;
    const dismissed = new Set(chat.settings.dismissedStatusBarKeys || []);
    const results = [];
    // 不再扫描聊天正文：状态栏内容现在跟着 update_thoughts 指令一起生成，存在 chat.thoughtsHistory
    // 里每一条的 customThoughts.status_bar 字段上，天然不会出现在聊天气泡里，也复用了心声那套
    // 已经验证过很稳定、不容易重复的生成机制。
    const thoughtsHistory = chat.thoughtsHistory || [];
    for (let i = thoughtsHistory.length - 1; i >= 0 && results.length < limit; i--) {
      const entry = thoughtsHistory[i];
      const raw = entry && entry.customThoughts && entry.customThoughts.status_bar;
      if (!raw || typeof raw !== 'string') continue;
      if (dismissed.has(entry.timestamp)) continue;
      regex.lastIndex = 0;
      const m = regex.exec(raw);
      if (m) {
        results.push({
          html: renderOne(m.slice(1), preset.replacePattern, chat),
          timestamp: entry.timestamp
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
      .sb-page-iframe { width: 100%; border: none; display: block; min-height: 200px; background: transparent; }
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
        background: #fff; color: #333; box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        display: flex; align-items: center; justify-content: center; font-size: 13px;
      }
      .sb-select-card.checked .sb-select-mark { background: #0A84FF; color: #fff; }
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

      /* 实色按钮，仿图上那种白色圆形✕ / 蓝色圆形✓ 的风格，不做玻璃透明效果 */
      .sb-glass-btn {
        width: 46px; height: 46px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px; cursor: pointer;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      }
      #sb-viewer-edit {
        position: fixed; top: max(16px, env(safe-area-inset-top)); right: 16px; z-index: 999999;
        background: #f2f2f2; color: #333;
      }
      #sb-viewer-close-round {
        position: fixed; left: 50%; bottom: max(28px, env(safe-area-inset-bottom));
        transform: translateX(-50%); z-index: 999999;
        background: #f2f2f2; color: #333;
      }
      #sb-viewer-counter {
        position: fixed; left: 50%; bottom: 82px; transform: translateX(-50%);
        z-index: 999999; color: rgba(255,255,255,0.75); font-size: 13px;
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
            : entries.map((e, i) => `<div class="sb-page"><div class="sb-page-inner" data-page-index="${i}"></div></div>`).join('')}
        </div>
        <div id="sb-viewer-edit" class="sb-glass-btn">✓</div>
        <div id="sb-viewer-close-round" class="sb-glass-btn">✕</div>
        ${dotsHtml}${counterHtml}
      `;

      // 之前这里是直接把预设渲染出来的HTML用 innerHTML 塞进 .sb-page-inner，
      // 但不少预设（比如"情侣空间"、"知乎"、"ins帖子热评"）写的其实是一份完整的独立网页，
      // 自带 <style> 和 <script>——用 innerHTML 插入的 <script> 浏览器根本不会执行，
      // <style> 也变成没有隔离的全局样式，很容易被app自己的样式覆盖/冲突，
      // 表现出来就是"样式全乱、看起来像默认气泡"或者"评论点了没反应"。
      // 改成用 iframe（srcdoc）加载，每个预设的页面在自己独立的文档里跑，
      // style 天然隔离，script 也能正常执行，跟预设作者本来的设计意图一致。
      entries.forEach((e, i) => {
        const container = overlay.querySelector(`.sb-page-inner[data-page-index="${i}"]`);
        if (!container) return;
        const iframe = document.createElement('iframe');
        iframe.className = 'sb-page-iframe';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.setAttribute('scrolling', 'no');
        iframe.srcdoc = wrapHtmlWithDefaultFont(e.html);
        iframe.addEventListener('load', () => {
          try {
            const doc = iframe.contentDocument;
            const h = Math.max(
              doc.documentElement ? doc.documentElement.scrollHeight : 0,
              doc.body ? doc.body.scrollHeight : 0
            );
            if (h > 0) iframe.style.height = h + 'px';
            // 预设HTML里可能有 data-send-msg 这种"点了帮你发消息"的按钮，
            // 之前是靠 wireInteractiveButtons(overlay,...) 在外层文档里找，但现在
            // 这些按钮都在iframe自己的文档里，外层找不到了，改成在iframe文档里重新绑一次。
            wireInteractiveButtons(doc, chat.id);
          } catch (err) {
            // 沙盒/跨域读不到内容就算了，保留默认高度，按钮绑不上也不至于整个弹窗报错
          }
        });
        container.appendChild(iframe);
      });

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
          <div class="sb-page-inner" data-select-page-index="${i}"></div>
          <div class="sb-select-mark">✓</div>
        </div>
      `).join('');
      // 预览卡片同样用iframe装，样式才不会跟主文档冲突/丢失；这里纯预览不需要交互，
      // 所以sandbox不给allow-scripts，省得预览列表里一堆脚本重复跑。
      entries.forEach((e, i) => {
        const container = listEl.querySelector(`[data-select-page-index="${i}"]`);
        if (!container) return;
        const iframe = document.createElement('iframe');
        iframe.className = 'sb-page-iframe';
        iframe.setAttribute('sandbox', 'allow-same-origin');
        iframe.setAttribute('scrolling', 'no');
        iframe.srcdoc = wrapHtmlWithDefaultFont(e.html);
        iframe.style.pointerEvents = 'none'; // 预览卡片本来就是靠外层div接收点击来选中，iframe不用响应点击
        iframe.addEventListener('load', () => {
          try {
            const doc = iframe.contentDocument;
            const h = Math.max(
              doc.documentElement ? doc.documentElement.scrollHeight : 0,
              doc.body ? doc.body.scrollHeight : 0
            );
            if (h > 0) iframe.style.height = h + 'px';
          } catch (err) {}
        });
        container.appendChild(iframe);
      });

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

  // ---------------- 全局开关：改成默认开启，且开关本体挪到"状态栏"App自己界面里管理，
  // 不再依赖注入进API设置页那种做法（之前那种方式一直没能稳定生效）

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
    if (state.globalSettings.statusBarEnabled === undefined) state.globalSettings.statusBarEnabled = true; // 默认开启
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
      if (window.state && window.state.globalSettings && window.db && typeof window.showScreen === 'function' && typeof Dexie !== 'undefined' && document.getElementById('chat-settings-screen')) {
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
