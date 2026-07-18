// ============================================================
// worldbook-char-picker.js — 世界书编辑页里直接多选角色挂载
//
// 不改 data-management.js 的 openWorldBookEditor，用 showScreen 钩子
// 在进入编辑页时注入一个多选勾选框列表；保存时用独立的第二个
// click监听器（跟原生的save-world-book-btn处理器互不干扰，各自触发）。
// ============================================================

(function () {
  function injectChecklistContainer() {
    if (document.getElementById('wb-char-picker-group')) return;
    const anchor = document.getElementById('world-book-inject-position-group');
    if (!anchor) { console.warn('[世界书角色挂载] 未找到注入位置分组，跳过注入'); return; }

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'wb-char-picker-group';
    group.innerHTML = `
      <label>
        <span style="font-weight: 500;">挂载给哪些角色</span>
        <span style="font-size: 12px; color: var(--text-secondary); display: block; margin-top: 4px;">
          直接在这里勾选，不用逐个跑去角色设置里加。如果上面"全局世界书"开着，所有角色都会生效，这里勾不勾都一样。
        </span>
      </label>
      <div id="wb-char-picker-list" style="max-height: 220px; overflow-y: auto; margin-top: 8px; border: 1px solid var(--border-color); border-radius: 8px; padding: 4px 10px;"></div>
    `;
    anchor.parentNode.insertBefore(group, anchor);
  }

  function renderChecklist() {
    const listEl = document.getElementById('wb-char-picker-list');
    if (!listEl) return;
    const bookId = window.editingWorldBookId;
    if (bookId === undefined || bookId === null) { setTimeout(renderChecklist, 100); return; }

    const book = state.worldBooks.find(wb => wb.id === bookId);
    const isGlobal = !!(book && book.isGlobal);
    const chats = Object.values(state.chats).filter(c => c && !c.isGroup);

    listEl.innerHTML = chats.length === 0
      ? `<div style="color: var(--text-secondary); font-size: 13px; padding: 8px 0;">还没有角色</div>`
      : chats.map(c => {
          const checked = (c.settings.linkedWorldBookIds || []).includes(bookId);
          return `
            <label style="display:flex; align-items:center; gap:10px; padding:8px 0; font-size:14px; ${isGlobal ? 'opacity:0.5;' : ''}">
              <input type="checkbox" class="wb-char-checkbox" data-chat-id="${c.id}" ${checked ? 'checked' : ''} ${isGlobal ? 'disabled' : ''}>
              <span>${c.name}</span>
            </label>
          `;
        }).join('');
  }

  async function handleSaveExtra() {
    const bookId = window.editingWorldBookId;
    if (bookId === undefined || bookId === null) return;
    const checkboxes = document.querySelectorAll('.wb-char-checkbox');
    if (checkboxes.length === 0) return;

    for (const cb of checkboxes) {
      const chat = state.chats[cb.dataset.chatId];
      if (!chat) continue;
      if (!chat.settings.linkedWorldBookIds) chat.settings.linkedWorldBookIds = [];
      const has = chat.settings.linkedWorldBookIds.includes(bookId);
      if (cb.checked && !has) {
        chat.settings.linkedWorldBookIds.push(bookId);
        await db.chats.put(chat);
      } else if (!cb.checked && has) {
        chat.settings.linkedWorldBookIds = chat.settings.linkedWorldBookIds.filter(id => id !== bookId);
        await db.chats.put(chat);
      }
    }
    if (typeof showToast === 'function') showToast('角色挂载已更新');
  }

  function init() {
    injectChecklistContainer();

    document.getElementById('save-world-book-btn')?.addEventListener('click', handleSaveExtra);

    // 全局开关变化时，实时切换勾选框的可用/禁用状态（不用等保存）
    document.getElementById('world-book-global-switch')?.addEventListener('change', (e) => {
      document.querySelectorAll('.wb-char-checkbox').forEach(cb => {
        cb.disabled = e.target.checked;
        cb.closest('label').style.opacity = e.target.checked ? '0.5' : '1';
      });
    });

    if (!window.__wbPickerShowScreenHooked) {
      window.__wbPickerShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === 'world-book-editor-screen') setTimeout(renderChecklist, 100);
        };
      }
    }
    console.log('[世界书角色挂载] 初始化完成');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.state.globalSettings && window.db && typeof window.showScreen === 'function' && document.getElementById('world-book-editor-screen')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[世界书角色挂载] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
