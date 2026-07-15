// ============================================================
// reminder-manager.js — 聊天提醒功能
//
// 两种提醒来源：
// 1. AI自动记忆提醒：ai-response.js 里新增的 set_reminder 指令写入
//    chat.settings.aiReminders = [{id, note, triggerTime(ms), fired, createdAt}]
//    需要角色开启 chat.settings.enableAiReminders 才会触发AI去记
// 2. 用户手动设置的每日重复提醒（支持多个）：
//    chat.settings.dailyReminders = [{id, time:"10:00", label:"吃早餐", lastFiredDate:"YYYY-MM-DD"|null}]
//
// 触发时机：每30秒心跳检查一次，到点后实时调一次API用角色语气生成提醒消息，
// 推进聊天记录 + 弹通知。跟"电量提醒/后台独立行动"用的是同一套API选择逻辑
// （优先用后台API，没配置就用主API）。
//
// 接入方式：在 index.html 里 modules/ai-response.js 之后加一行：
//   <script src="modules/reminder-manager.js?v=0.0.1" defer></script>
// ============================================================

(function () {
  const CHECK_INTERVAL_MS = 30 * 1000;

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getApiCfg() {
    const useBackgroundApi = state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel;
    return useBackgroundApi
      ? { proxyUrl: state.apiConfig.backgroundProxyUrl, apiKey: state.apiConfig.backgroundApiKey, model: state.apiConfig.backgroundModel }
      : { proxyUrl: state.apiConfig.proxyUrl, apiKey: state.apiConfig.apiKey, model: state.apiConfig.model };
  }

  function isGeminiUrl(proxyUrl) {
    return !!proxyUrl && proxyUrl.includes('generativelanguage.googleapis.com');
  }

  async function callReminderAI(prompt) {
    const { proxyUrl, apiKey, model } = getApiCfg();
    if (!proxyUrl || !apiKey || !model) throw new Error('API配置不完整');

    const isGemini = isGeminiUrl(proxyUrl);
    let response;
    if (isGemini) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.85 } })
      });
    } else {
      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.85 })
      });
    }
    if (!response.ok) throw new Error(`API请求失败(${response.status})`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = isGemini ? data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() : data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('API返回空内容');
    return text;
  }

  async function sendReminderMessage(chat, reasonNote) {
    const persona = chat.settings?.aiPersona || '';
    const prompt = `你是角色"${chat.name}"，你的人设是：${persona}

现在你要主动提醒对方一件事：${reasonNote}

请用符合你人设的语气，自然地发一条消息提醒对方（就像正常聊天一样开口，不要说"这是提醒"、不要出现"系统"字样），控制在40字以内。只返回这句话本身，不要任何多余文字或引号。`;

    let content;
    try {
      content = await callReminderAI(prompt);
    } catch (e) {
      console.error('[提醒] 生成提醒消息失败，使用兜底文案', e);
      content = reasonNote; // API失败时兜底：直接把记下来的内容发出去，好过完全不提醒
    }

    const aiMessage = {
      role: 'assistant',
      content: content,
      timestamp: Date.now(),
      senderName: chat.name
    };
    if (!chat.history) chat.history = [];
    chat.history.push(aiMessage);
    chat.unreadCount = (chat.unreadCount || 0) + 1;
    await db.chats.put(chat);

    if (typeof showNotification === 'function') showNotification(chat.id, content);
    console.log(`[提醒] 已触发 "${chat.name}": ${content}`);
  }

  async function checkAllReminders() {
    if (!window.state || !window.db || !state.chats) return;
    const now = Date.now();
    const nowDate = new Date();
    const nowHM = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
    const today = todayStr();

    for (const chatId in state.chats) {
      const chat = state.chats[chatId];
      if (!chat || chat.isGroup) continue;
      let dirty = false;

      // ---- 1. AI自动记忆的一次性提醒 ----
      const aiReminders = chat.settings?.aiReminders;
      if (Array.isArray(aiReminders) && aiReminders.length > 0) {
        for (const r of aiReminders) {
          if (!r.fired && r.triggerTime <= now) {
            r.fired = true;
            dirty = true;
            try { await sendReminderMessage(chat, r.note); } catch (e) { console.error('[提醒] AI提醒触发失败', e); }
          }
        }
        // 清理已触发超过1天的旧记录，避免数组无限膨胀
        chat.settings.aiReminders = aiReminders.filter(r => !r.fired || (now - r.triggerTime) < 24 * 60 * 60 * 1000);
      }

      // ---- 2. 用户设置的每日重复提醒 ----
      const dailyReminders = chat.settings?.dailyReminders;
      if (Array.isArray(dailyReminders) && dailyReminders.length > 0) {
        for (const r of dailyReminders) {
          if (r.time === nowHM && r.lastFiredDate !== today) {
            r.lastFiredDate = today;
            dirty = true;
            try { await sendReminderMessage(chat, r.label); } catch (e) { console.error('[提醒] 每日提醒触发失败', e); }
          }
        }
      }

      if (dirty) { try { await db.chats.put(chat); } catch (e) { console.error('[提醒] 保存失败', e); } }
    }
  }

  // ---------------- 聊天设置面板 ----------------
  function injectSettingsPanel() {
    const container = document.querySelector('#chat-settings-screen .settings-container');
    if (!container) { console.warn('[提醒] 未找到聊天设置的 .settings-container，面板未注入'); return; }
    if (document.getElementById('reminder-settings-section')) return;

    const section = document.createElement('div');
    section.className = 'settings-section';
    section.id = 'reminder-settings-section';
    section.innerHTML = `
      <div class="settings-item">
        <label>⏰ AI自动记忆提醒</label>
        <div class="settings-right"><input type="checkbox" id="reminder-ai-enable-toggle"></div>
      </div>
      <div class="settings-item-block">
        <div class="settings-desc">开启后，当你在对话里提到具体时间的安排（比如"12点吃饭"），角色会自动记下来，到点用ta自己的语气提醒你。</div>
      </div>
      <div class="settings-item-block">
        <label>AI记下的待触发提醒</label>
        <div id="reminder-ai-list" style="margin-top:6px;"></div>
      </div>
      <div class="settings-item-block">
        <label>每日重复提醒</label>
        <div class="settings-desc">自己设置固定时间点，每天都会提醒（可以加多个，比如早餐/午餐/吃药）</div>
        <div id="reminder-daily-list" style="margin-top:6px;"></div>
        <button class="settings-full-btn secondary" id="reminder-add-daily-btn" type="button" style="margin-top:10px;">＋ 添加每日提醒</button>
      </div>
    `;
    const anchor = Array.from(container.querySelectorAll(':scope > .settings-section'))
      .find(sec => sec.textContent.includes('回复条数范围') || sec.textContent.includes('启用独立后台活动'));
    container.insertBefore(section, anchor || container.firstChild);

    document.getElementById('reminder-ai-enable-toggle')?.addEventListener('change', async (e) => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.settings.enableAiReminders = e.target.checked;
      await db.chats.put(chat);
    });

    document.getElementById('reminder-add-daily-btn')?.addEventListener('click', async () => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      const time = await showCustomPrompt('添加每日提醒', '提醒时间（24小时制，例如 10:00）', '10:00', 'time');
      if (!time || !/^\d{1,2}:\d{2}$/.test(time.trim())) { if (time) alert('时间格式不对，要是 HH:mm 这样的，比如 10:00'); return; }
      const label = await showCustomPrompt('提醒内容', '要提醒的事情（例如"吃早餐"）', '', 'text');
      if (!label || !label.trim()) return;

      if (!chat.settings.dailyReminders) chat.settings.dailyReminders = [];
      chat.settings.dailyReminders.push({
        id: Date.now() + Math.random(),
        time: time.trim().padStart(5, '0'),
        label: label.trim(),
        lastFiredDate: null
      });
      await db.chats.put(chat);
      renderReminderLists(chat);
    });
  }

  function renderReminderLists(chat) {
    const dailyListEl = document.getElementById('reminder-daily-list');
    const aiListEl = document.getElementById('reminder-ai-list');
    if (!dailyListEl || !aiListEl) return;

    const dailyReminders = chat.settings?.dailyReminders || [];
    dailyListEl.innerHTML = dailyReminders.length === 0
      ? `<div style="color:#999; font-size:12.5px;">还没有设置每日提醒</div>`
      : dailyReminders.sort((a, b) => a.time.localeCompare(b.time)).map(r => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-color,#eee);">
          <div><span style="font-weight:600;">${r.time}</span><span style="color:var(--text-secondary,#999); margin-left:8px; font-size:13px;">${r.label}</span></div>
          <button class="reminder-del-daily" data-id="${r.id}" style="border:none; background:none; color:#FF3B30; font-size:13px;">删除</button>
        </div>
      `).join('');

    dailyListEl.querySelectorAll('.reminder-del-daily').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseFloat(btn.dataset.id);
        chat.settings.dailyReminders = (chat.settings.dailyReminders || []).filter(r => r.id !== id);
        await db.chats.put(chat);
        renderReminderLists(chat);
      });
    });

    const aiReminders = (chat.settings?.aiReminders || []).filter(r => !r.fired);
    aiListEl.innerHTML = aiReminders.length === 0
      ? `<div style="color:#999; font-size:12.5px;">目前没有</div>`
      : aiReminders.sort((a, b) => a.triggerTime - b.triggerTime).map(r => {
          const d = new Date(r.triggerTime);
          const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-color,#eee);">
              <div><span style="font-weight:600;">${timeStr}</span><span style="color:var(--text-secondary,#999); margin-left:8px; font-size:13px;">${r.note}</span></div>
              <button class="reminder-del-ai" data-id="${r.id}" style="border:none; background:none; color:#FF3B30; font-size:13px;">删除</button>
            </div>`;
        }).join('');

    aiListEl.querySelectorAll('.reminder-del-ai').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseFloat(btn.dataset.id);
        chat.settings.aiReminders = (chat.settings.aiReminders || []).filter(r => r.id !== id);
        await db.chats.put(chat);
        renderReminderLists(chat);
      });
    });
  }

  function loadSettingsPanel() {
    const chat = state.chats[state.activeChatId];
    const section = document.getElementById('reminder-settings-section');
    if (!chat || chat.isGroup) { section?.style.setProperty('display', 'none'); return; }
    section?.style.setProperty('display', '');
    document.getElementById('reminder-ai-enable-toggle').checked = !!chat.settings.enableAiReminders;
    renderReminderLists(chat);
  }

  // ---------------- 初始化 ----------------
  function init() {
    injectSettingsPanel();
    setInterval(checkAllReminders, CHECK_INTERVAL_MS);
    checkAllReminders(); // 启动时先跑一次，避免开着页面挂了半天才第一次检查

    if (!window.__reminderShowScreenHooked) {
      window.__reminderShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === 'chat-settings-screen') loadSettingsPanel();
        };
      }
    }
    console.log('[提醒] 初始化完成');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.db && typeof window.showScreen === 'function' && document.getElementById('chat-settings-screen')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[提醒] 等待依赖超时，初始化取消');
      }
    }
    tryInit(30);
  });
})();
