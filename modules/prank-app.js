// ============================================================
// prank-app.js — "用TA的手机" 捣乱功能 v2
//
// 完全独立的新玩法，不依赖/不修改 cphone.js 任何代码。
// 悬浮入口 → 选角色(需授权) → 迷你手机主屏(消息/浏览器/备忘录/书城)
//
// 数据结构：
//   chat.settings.enablePrankApp        boolean  该角色是否允许被用来捣乱
//   chat.settings.prankCustomContacts   [{id, name}]  手动添加的自定义联系人（世界书角色）
//   chat.prankRisk                      number 0-100  当前风险值
//   chat.prankThreads                   { [contactKey]: [{role, content, timestamp}] } NPC对话记录
//   chat.prankMemos                     [{id, title, content, timestamp}]  在char手机上建的备忘录
//   chat.prankSearchHistory             [{id, query, timestamp}]  浏览器搜索历史（仅展示用）
//
// "被发现"时：不再锁App，而是实时调API让角色用自己的语气发一条消息到【真实聊天记录】里，
// 同时弹一个警示弹窗告知用户，风险值归零后可以继续玩。
// ============================================================

(function () {
  const RISK_MAX = 100;
  const GAIN_RANGES = { message: [12, 22], browser: [8, 15], memo: [6, 12], novel: [5, 10] };

  function isGeminiUrl(proxyUrl) { return !!proxyUrl && proxyUrl.includes('generativelanguage.googleapis.com'); }

  async function callPrankAI(prompt) {
    const useBackgroundApi = state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel;
    const { proxyUrl, apiKey, model } = useBackgroundApi
      ? { proxyUrl: state.apiConfig.backgroundProxyUrl, apiKey: state.apiConfig.backgroundApiKey, model: state.apiConfig.backgroundModel }
      : state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error('API配置不完整');

    const isGemini = isGeminiUrl(proxyUrl);
    let response;
    if (isGemini) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9 } })
      });
    } else {
      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.9 })
      });
    }
    if (!response.ok) throw new Error(`API请求失败(${response.status})`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = isGemini ? data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() : data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('API返回空内容');
    return text;
  }

  function buildWorldBookContext(chat) {
    let allWorldBookIds = [...(chat.settings.linkedWorldBookIds || [])];
    (state.worldBooks || []).forEach(wb => { if (wb.isGlobal && !allWorldBookIds.includes(wb.id)) allWorldBookIds.push(wb.id); });
    return allWorldBookIds.map(id => (state.worldBooks || []).find(wb => wb.id === id)).filter(Boolean)
      .map(book => `\n## 世界书《${book.name}》:\n${(book.content || []).filter(e => e.enabled).map(e => `- ${e.content}`).join('\n')}`)
      .join('');
  }

  // ---------------- 风险值 + 被发现 ----------------
  async function gainRiskAndCheck(chat, actionKind, actionDescriptionForCallout) {
    const [min, max] = GAIN_RANGES[actionKind] || [10, 18];
    const gain = min + Math.random() * (max - min);
    chat.prankRisk = Math.min(RISK_MAX, (chat.prankRisk || 0) + gain);
    const discovered = chat.prankRisk >= RISK_MAX;
    if (discovered) chat.prankRisk = 0;
    await db.chats.put(chat);

    if (discovered) {
      await handleDiscovered(chat, actionDescriptionForCallout);
    }
    return discovered;
  }

  async function handleDiscovered(chat, actionDescription) {
    const persona = chat.settings?.aiPersona || '';
    const prompt = `你是角色"${chat.name}"，你的人设是：${persona}

你刚刚发现自己的手机被人偷偷拿去用了——具体是：${actionDescription}。你现在拿回了手机，要立刻找那个人对峙。真实的人在情绪激动/生气/震惊的时候发消息，不会写一大段话，而是会连续发好几条短消息，就像连环夺命call一样，条数由你自己决定，符合你此刻的情绪反应就行——可能就一条冷冷的话，也可能气得连发好几条，不用刻意凑数量。

请用符合你人设的语气生成消息（可以是生气、可以是哭笑不得、可以是威胁，取决于你的性格），每条不超过25字。只返回JSON数组，不要任何多余文字：
["第一条消息", "第二条消息", ...]`;

    let messages;
    try {
      const raw = await callPrankAI(prompt);
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      try { messages = JSON.parse(cleaned); } catch (e) {
        const m = raw.match(/\[[\s\S]*\]/);
        messages = m ? JSON.parse(m[0]) : null;
      }
      if (!Array.isArray(messages) || messages.length === 0) throw new Error('格式不对');
    } catch (e) {
      console.error('[捣乱] 生成对峙消息失败', e);
      messages = [`（${chat.name}发现手机被偷用了，气得说不出话...）`];
    }

    if (!chat.history) chat.history = [];
    // 连续消息之间错开几百毫秒的时间戳，视觉上更像"连发"而不是同一秒堆一起
    let ts = Date.now();
    for (const content of messages) {
      chat.history.push({ role: 'assistant', content, timestamp: ts, senderName: chat.name });
      chat.unreadCount = (chat.unreadCount || 0) + 1;
      ts += 400 + Math.floor(Math.random() * 300);
      if (typeof showNotification === 'function') showNotification(chat.id, content);
    }
    await db.chats.put(chat);
  }

  function showDiscoveredModal(chatName) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.id = 'prank-discovered-modal';
      modal.innerHTML = `
        <div class="box">
          <div class="warn-icon">⚠️</div>
          <div class="title">被发现了</div>
          <div class="desc">${chatName} 发现你在偷看 ta 的手机，刚刚给你发了消息。</div>
          <button id="prank-discovered-ok">已知晓</button>
        </div>
      `;
      document.body.appendChild(modal);
      document.getElementById('prank-discovered-ok').addEventListener('click', () => { modal.remove(); resolve(); });
    });
  }

  // ---------------- 样式 ----------------
  function injectStyle() {
    if (document.getElementById('prank-app-style')) return;
    const style = document.createElement('style');
    style.id = 'prank-app-style';
    style.textContent = `
      #prank-app-content {
        display: flex; flex-direction: column; color: #fff; font-family: inherit; width: 100%; height: 100%;
      }
      .prank-header {
        display: flex; align-items: center; gap: 10px; padding: 14px 16px;
        border-bottom: 1px solid #2c2c2e; flex-shrink: 0;
      }
      .prank-header .prank-back { font-size: 22px; cursor: pointer; padding: 4px 8px; }
      .prank-header .prank-title { font-size: 16px; font-weight: 700; flex: 1; }
      .prank-body { flex: 1; overflow-y: auto; padding: 12px 16px; }
      .prank-list-item {
        display: flex; align-items: center; gap: 12px; padding: 12px;
        background: #1c1c1e; border-radius: 12px; margin-bottom: 10px; cursor: pointer;
      }
      .prank-list-item .avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #333; flex-shrink: 0; }
      .prank-list-item .info { flex: 1; min-width: 0; }
      .prank-list-item .info .name { font-weight: 600; font-size: 14px; }
      .prank-list-item .info .desc { font-size: 12px; color: #8e8e93; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .prank-add-btn {
        width: 100%; padding: 12px; border-radius: 10px; border: 1px dashed #48484a;
        background: transparent; color: #8e8e93; font-size: 14px; margin-top: 4px;
      }

      /* 迷你手机主屏 App 图标网格 */
      .prank-home-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; padding: 10px 4px; }
      .prank-app-icon { display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; }
      .prank-app-icon .icon-bg {
        width: 52px; height: 52px; border-radius: 14px; background: #2c2c2e;
        display: flex; align-items: center; justify-content: center; font-size: 24px;
      }
      .prank-app-icon .label { font-size: 11px; color: #ccc; }

      .prank-risk-bar-wrap { padding: 8px 16px 0; flex-shrink: 0; }
      .prank-risk-bar-track { height: 8px; border-radius: 4px; background: #2c2c2e; overflow: hidden; }
      .prank-risk-bar-fill { height: 100%; background: linear-gradient(90deg, #34C759, #FF9500 60%, #FF3B30); transition: width 0.3s; }
      .prank-risk-label { font-size: 11px; color: #8e8e93; margin-top: 4px; text-align: right; }

      .prank-msg-row { display: flex; margin-bottom: 10px; }
      .prank-msg-row.user { justify-content: flex-end; }
      .prank-msg-bubble { max-width: 75%; padding: 9px 13px; border-radius: 14px; font-size: 14px; line-height: 1.5; }
      .prank-msg-row.user .prank-msg-bubble { background: #0A84FF; border-bottom-right-radius: 4px; }
      .prank-msg-row.npc .prank-msg-bubble { background: #2c2c2e; border-bottom-left-radius: 4px; }
      .prank-input-bar { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #2c2c2e; flex-shrink: 0; }
      .prank-input-bar input, .prank-input-bar textarea {
        flex: 1; border: none; border-radius: 12px; padding: 10px 16px; background: #1c1c1e; color: #fff; font-size: 14px; font-family: inherit;
      }
      .prank-input-bar button { border: none; background: #0A84FF; color: #fff; border-radius: 20px; padding: 0 18px; font-size: 14px; }
      .prank-input-bar button:disabled { background: #48484a; }

      .prank-search-bar { display: flex; gap: 8px; padding: 10px 16px; }
      .prank-search-bar input { flex: 1; border: none; border-radius: 20px; padding: 10px 16px; background: #1c1c1e; color: #fff; font-size: 14px; }
      .prank-search-bar button { border: none; background: #0A84FF; color: #fff; border-radius: 20px; padding: 0 16px; }
      .prank-result-card { background: #1c1c1e; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
      .prank-result-card .rtitle { font-size: 14px; font-weight: 600; color: #4da3ff; margin-bottom: 4px; }
      .prank-result-card .rsnippet { font-size: 12.5px; color: #ccc; line-height: 1.5; }

      .prank-memo-list-item { background: #1c1c1e; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
      .prank-memo-list-item .mtitle { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      .prank-memo-list-item .mcontent { font-size: 12.5px; color: #ccc; line-height: 1.5; white-space: pre-wrap; }
      .prank-memo-list-item .mtime { font-size: 11px; color: #666; margin-top: 6px; }

      .prank-novel-card { display: flex; gap: 12px; background: #1c1c1e; border-radius: 12px; padding: 12px; margin-bottom: 10px; cursor: pointer; }
      .prank-novel-card .cover { width: 48px; height: 64px; border-radius: 6px; background: linear-gradient(135deg, #444, #222); flex-shrink: 0; }
      .prank-novel-card .info .ntitle { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
      .prank-novel-card .info .ndesc { font-size: 12px; color: #8e8e93; }
      .prank-novel-reading { font-size: 14px; line-height: 1.9; color: #ddd; white-space: pre-wrap; padding: 6px 2px; }

      .prank-loading { text-align: center; color: #8e8e93; font-size: 13px; padding: 30px 0; }

      #prank-discovered-modal {
        position: fixed; inset: 0; z-index: 9999999; background: rgba(0,0,0,0.85);
        display: flex; align-items: center; justify-content: center;
      }
      #prank-discovered-modal .box { background: #2b2b2d; color: #fff; border-radius: 20px; padding: 28px 22px; width: 78%; max-width: 320px; text-align: center; }
      #prank-discovered-modal .warn-icon {
        width: 64px; height: 64px; border-radius: 50%; background: rgba(255,107,107,0.18); color: #ff6b6b;
        font-size: 30px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;
      }
      #prank-discovered-modal .title { font-size: 19px; font-weight: 800; margin-bottom: 12px; }
      #prank-discovered-modal .desc { font-size: 13.5px; color: #cfcfcf; line-height: 1.6; margin-bottom: 20px; }
      #prank-discovered-modal button { border: none; background: linear-gradient(135deg,#ffb4b4,#ff9d9d); color: #4a1111; font-weight: 700; padding: 13px; border-radius: 26px; font-size: 15px; width: 100%; }
    `;
    document.head.appendChild(style);
  }

  // ---------------- 全局导航状态 ----------------
  let currentChat = null, currentContactKey = null, currentContact = null;

  function getEligibleChats() { return Object.values(state.chats).filter(c => c && !c.isGroup && c.settings?.enablePrankApp); }
  function overlay() { return document.getElementById('prank-app-content'); }

  function renderRiskBar() {
    const risk = Math.round(currentChat.prankRisk || 0);
    return `<div class="prank-risk-bar-wrap"><div class="prank-risk-bar-track"><div class="prank-risk-bar-fill" style="width:${risk}%;"></div></div><div class="prank-risk-label">被发现风险 ${risk}/100</div></div>`;
  }

  // ---------------- 1. 选角色 ----------------
  function renderCharPicker() {
    const chats = getEligibleChats();
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-close-btn">✕</span><span class="prank-title">用TA的手机</span></div>
      <div class="prank-body">
        ${chats.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:40px 0;">还没有角色开启这个功能<br>去"聊天设置"里给角色开启"允许用TA的手机"</div>` : ''}
        ${chats.map(c => `
          <div class="prank-list-item" data-chat-id="${c.id}">
            <img class="avatar" src="${c.settings?.aiAvatar || ''}">
            <div class="info"><div class="name">${c.name}</div><div class="desc">风险值 ${Math.round(c.prankRisk || 0)}/100</div></div>
          </div>`).join('')}
      </div>
    `;
    document.getElementById('prank-close-btn').addEventListener('click', () => showScreen('home-screen'));
    overlay().querySelectorAll('.prank-list-item[data-chat-id]').forEach(el => {
      el.addEventListener('click', () => { currentChat = state.chats[el.dataset.chatId]; renderPhoneHome(); });
    });
  }

  // ---------------- 2. 迷你手机主屏 ----------------
  function renderPhoneHome() {
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-home">‹</span><span class="prank-title">${currentChat.name}的手机</span></div>
      ${renderRiskBar()}
      <div class="prank-body">
        <div class="prank-home-grid">
          <div class="prank-app-icon" data-app="message"><div class="icon-bg">💬</div><div class="label">消息</div></div>
          <div class="prank-app-icon" data-app="browser"><div class="icon-bg">🌐</div><div class="label">浏览器</div></div>
          <div class="prank-app-icon" data-app="memo"><div class="icon-bg">📝</div><div class="label">备忘录</div></div>
          <div class="prank-app-icon" data-app="novel"><div class="icon-bg">📚</div><div class="label">书城</div></div>
        </div>
      </div>
    `;
    document.getElementById('prank-back-home').addEventListener('click', renderCharPicker);
    overlay().querySelectorAll('.prank-app-icon').forEach(el => {
      el.addEventListener('click', () => {
        const app = el.dataset.app;
        if (app === 'message') renderContactPicker();
        else if (app === 'browser') renderBrowser();
        else if (app === 'memo') renderMemoList();
        else if (app === 'novel') renderNovelCity();
      });
    });
  }

  // ---------------- 3a. 消息：联系人列表 ----------------
  async function renderContactPicker() {
    const npcs = (await db.npcs.toArray()).filter(n => n.associatedWith && n.associatedWith.includes(currentChat.id));
    const customs = currentChat.settings.prankCustomContacts || [];

    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">通讯录</span></div>
      <div class="prank-body">
        ${npcs.map(n => `<div class="prank-list-item" data-key="npc_${n.id}"><img class="avatar" src="${n.avatar || ''}"><div class="info"><div class="name">${n.name}</div><div class="desc">${(n.persona || '').slice(0, 20)}</div></div></div>`).join('')}
        ${customs.map(c => `<div class="prank-list-item" data-key="custom_${c.id}"><img class="avatar" src=""><div class="info"><div class="name">${c.name}</div><div class="desc">世界书角色（自定义添加）</div></div></div>`).join('')}
        ${npcs.length === 0 && customs.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:30px 0;">还没有联系人</div>` : ''}
        <button class="prank-add-btn" id="prank-add-contact-btn">＋ 手动添加联系人（世界书角色）</button>
      </div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderPhoneHome);
    document.getElementById('prank-add-contact-btn').addEventListener('click', async () => {
      const name = await showCustomPrompt('添加联系人', '填一个世界书里提到过的角色名字', '', 'text');
      if (!name || !name.trim()) return;
      if (!currentChat.settings.prankCustomContacts) currentChat.settings.prankCustomContacts = [];
      currentChat.settings.prankCustomContacts.push({ id: Date.now() + Math.random(), name: name.trim() });
      await db.chats.put(currentChat);
      renderContactPicker();
    });
    overlay().querySelectorAll('.prank-list-item[data-key]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.key;
        currentContactKey = key;
        if (key.startsWith('npc_')) {
          const npcId = parseInt(key.slice(4), 10);
          const npc = npcs.find(n => n.id === npcId);
          currentContact = { type: 'npc', name: npc?.name, persona: npc?.persona };
        } else {
          const customId = parseFloat(key.slice(7));
          currentContact = { type: 'custom', name: customs.find(c => c.id === customId)?.name, persona: null };
        }
        renderChatScreen();
      });
    });
  }

  // ---------------- 3a-2. 消息：聊天界面 ----------------
  function renderChatScreen() {
    const thread = (currentChat.prankThreads && currentChat.prankThreads[currentContactKey]) || [];
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn2">‹</span><span class="prank-title">${currentContact.name}</span></div>
      ${renderRiskBar()}
      <div class="prank-body" id="prank-msg-list">
        ${thread.map(m => `<div class="prank-msg-row ${m.role === 'user' ? 'user' : 'npc'}"><div class="prank-msg-bubble">${m.content}</div></div>`).join('')}
      </div>
      <div class="prank-input-bar">
        <input type="text" id="prank-input" placeholder="用${currentChat.name}的语气发消息...">
        <button id="prank-send-btn">发送</button>
      </div>
    `;
    document.getElementById('prank-back-btn2').addEventListener('click', renderContactPicker);
    const listEl = document.getElementById('prank-msg-list');
    listEl.scrollTop = listEl.scrollHeight;
    const inputEl = document.getElementById('prank-input');
    const send = () => sendPrankMessage(inputEl.value.trim());
    document.getElementById('prank-send-btn').addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  async function sendPrankMessage(text) {
    if (!text) return;
    if (!currentChat.prankThreads) currentChat.prankThreads = {};
    if (!currentChat.prankThreads[currentContactKey]) currentChat.prankThreads[currentContactKey] = [];
    const thread = currentChat.prankThreads[currentContactKey];

    thread.push({ role: 'user', content: text, timestamp: Date.now() });
    await db.chats.put(currentChat);
    renderChatScreen();
    document.getElementById('prank-input').value = '';
    document.getElementById('prank-send-btn').disabled = true;

    try {
      const recentThreadText = thread.slice(-10).map(m => `${m.role === 'user' ? currentChat.name : currentContact.name}: ${m.content}`).join('\n');
      const worldBookCtx = buildWorldBookContext(currentChat);
      const personaLine = currentContact.type === 'npc' && currentContact.persona
        ? `你的人设：${currentContact.persona}`
        : `你没有预设的人设资料，请结合下面的世界书内容，合理推测并扮演一个叫"${currentContact.name}"的角色。`;
      const prompt = `你正在扮演"${currentContact.name}"。${personaLine}

"${currentChat.name}"（你认识的人）正在用手机给你发消息，内容可能是捣乱/开玩笑/异常的话（因为TA手机其实被别人拿去乱发了，但你不知道）。请以"${currentContact.name}"的身份和语气自然回复。
${worldBookCtx}

# 最近聊天记录
${recentThreadText}

只返回你要发的这一句话本身，不超过40字，不要任何解释或引号。`;
      const reply = await callPrankAI(prompt);
      thread.push({ role: 'npc', content: reply, timestamp: Date.now() });
      await db.chats.put(currentChat);
    } catch (e) {
      console.error('[捣乱] 生成回复失败', e);
      thread.push({ role: 'npc', content: '(对方好像没回复...网络似乎有问题)', timestamp: Date.now() });
      await db.chats.put(currentChat);
    }
    renderChatScreen();

    const discovered = await gainRiskAndCheck(currentChat, 'message', `拿着手机给"${currentContact.name}"发了奇怪的消息`);
    if (discovered) { await showDiscoveredModal(currentChat.name); renderPhoneHome(); }
  }

  // ---------------- 3b. 浏览器 ----------------
  function renderBrowser() {
    const history = currentChat.prankSearchHistory || [];
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">浏览器</span></div>
      ${renderRiskBar()}
      <div class="prank-search-bar"><input type="text" id="prank-search-input" placeholder="搜点什么..."><button id="prank-search-btn">搜索</button></div>
      <div class="prank-body" id="prank-search-results">
        ${history.length > 0 ? `<div style="color:#8e8e93; font-size:12px; margin-bottom:8px;">最近搜过：${history.slice(-5).map(h => h.query).join('、')}</div>` : ''}
      </div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderPhoneHome);
    const inputEl = document.getElementById('prank-search-input');
    const doSearch = () => doPrankSearch(inputEl.value.trim());
    document.getElementById('prank-search-btn').addEventListener('click', doSearch);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  }

  async function doPrankSearch(query) {
    if (!query) return;
    const resultsEl = document.getElementById('prank-search-results');
    resultsEl.innerHTML = `<div class="prank-loading">搜索中...</div>`;

    if (!currentChat.prankSearchHistory) currentChat.prankSearchHistory = [];
    currentChat.prankSearchHistory.push({ id: Date.now(), query, timestamp: Date.now() });
    await db.chats.put(currentChat);

    try {
      const persona = currentChat.settings?.aiPersona || '';
      const prompt = `假设有一个叫"${currentChat.name}"的人（人设：${persona}），有人拿着ta的手机搜索了"${query}"这个词。

请你虚构生成3条看起来真实的搜索结果，每条包含一个标题和一段2-3句话的摘要，风格贴近真实搜索引擎结果，跟"${query}"这个搜索词直接相关。只返回JSON数组，不要任何多余文字：
[{"title":"...", "snippet":"..."}, {"title":"...", "snippet":"..."}, {"title":"...", "snippet":"..."}]`;
      const raw = await callPrankAI(prompt);
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      let results;
      try { results = JSON.parse(cleaned); } catch (e) {
        const m = raw.match(/\[[\s\S]*\]/);
        results = m ? JSON.parse(m[0]) : [];
      }
      resultsEl.innerHTML = results.map(r => `<div class="prank-result-card"><div class="rtitle">${r.title}</div><div class="rsnippet">${r.snippet}</div></div>`).join('') || `<div class="prank-loading">没搜到什么结果</div>`;
    } catch (e) {
      console.error('[捣乱] 搜索失败', e);
      resultsEl.innerHTML = `<div class="prank-loading">搜索失败：${e.message}</div>`;
    }

    const discovered = await gainRiskAndCheck(currentChat, 'browser', `用浏览器搜索了"${query}"`);
    if (discovered) { await showDiscoveredModal(currentChat.name); renderPhoneHome(); }
  }

  // ---------------- 3c. 备忘录 ----------------
  function renderMemoList() {
    const memos = currentChat.prankMemos || [];
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">备忘录</span></div>
      ${renderRiskBar()}
      <div class="prank-body">
        ${memos.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:30px 0;">还没有备忘录</div>` : ''}
        ${memos.slice().reverse().map(m => `<div class="prank-memo-list-item"><div class="mtitle">${m.title}</div><div class="mcontent">${m.content}</div><div class="mtime">${new Date(m.timestamp).toLocaleString()}</div></div>`).join('')}
        <button class="prank-add-btn" id="prank-new-memo-btn">＋ 新增备忘录</button>
      </div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderPhoneHome);
    document.getElementById('prank-new-memo-btn').addEventListener('click', renderMemoEditor);
  }

  function renderMemoEditor() {
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">新增备忘录</span></div>
      <div class="prank-body">
        <input type="text" id="prank-memo-title" placeholder="标题" style="width:100%; box-sizing:border-box; border:none; border-radius:10px; padding:10px 14px; background:#1c1c1e; color:#fff; font-size:15px; margin-bottom:10px;">
        <textarea id="prank-memo-content" placeholder="写点什么..." style="width:100%; box-sizing:border-box; height:180px; border:none; border-radius:10px; padding:10px 14px; background:#1c1c1e; color:#fff; font-size:14px; font-family:inherit; resize:none;"></textarea>
      </div>
      <div class="prank-input-bar"><button id="prank-save-memo-btn" style="width:100%;">保存</button></div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderMemoList);
    document.getElementById('prank-save-memo-btn').addEventListener('click', saveMemo);
  }

  async function saveMemo() {
    const title = document.getElementById('prank-memo-title').value.trim();
    const content = document.getElementById('prank-memo-content').value.trim();
    if (!title && !content) { renderMemoList(); return; }

    if (!currentChat.prankMemos) currentChat.prankMemos = [];
    currentChat.prankMemos.push({ id: Date.now() + Math.random(), title: title || '(无标题)', content, timestamp: Date.now() });
    await db.chats.put(currentChat);

    const discovered = await gainRiskAndCheck(currentChat, 'memo', `在备忘录里新建了一条"${title || content.slice(0, 15)}"`);
    if (discovered) { await showDiscoveredModal(currentChat.name); renderPhoneHome(); return; }
    renderMemoList();
  }

  // ---------------- 3d. 书城 ----------------
  const NOVEL_GENRES = ['都市', '玄幻', '悬疑', '言情', '科幻', '历史'];
  function renderNovelCity() {
    if (!currentChat._prankNovelList) {
      currentChat._prankNovelList = Array.from({ length: 6 }).map((_, i) => ({
        id: i,
        title: null, // 懒加载：点开书城时还没生成标题
        genre: NOVEL_GENRES[i % NOVEL_GENRES.length]
      }));
    }
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">书城</span></div>
      ${renderRiskBar()}
      <div class="prank-body" id="prank-novel-list"><div class="prank-loading">加载书单中...</div></div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderPhoneHome);
    loadNovelList();
  }

  async function loadNovelList() {
    const listEl = document.getElementById('prank-novel-list');
    try {
      const persona = currentChat.settings?.aiPersona || '';
      const prompt = `假设"${currentChat.name}"（人设：${persona}）平时会在书城App看小说。请虚构6本ta书架/推荐里会出现的小说，题材尽量贴合ta的性格喜好。只返回JSON数组：
[{"title":"书名", "genre":"题材", "desc":"一句话简介"}, ...] 共6条`;
      const raw = await callPrankAI(prompt);
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      let novels;
      try { novels = JSON.parse(cleaned); } catch (e) { const m = raw.match(/\[[\s\S]*\]/); novels = m ? JSON.parse(m[0]) : []; }
      currentChat._prankNovelList = novels.map((n, i) => ({ id: i, ...n }));
      listEl.innerHTML = currentChat._prankNovelList.map(n => `
        <div class="prank-novel-card" data-id="${n.id}">
          <div class="cover"></div>
          <div class="info"><div class="ntitle">${n.title}</div><div class="ndesc">[${n.genre}] ${n.desc}</div></div>
        </div>`).join('');
      listEl.querySelectorAll('.prank-novel-card').forEach(el => {
        el.addEventListener('click', () => openNovel(currentChat._prankNovelList.find(n => n.id == el.dataset.id)));
      });
    } catch (e) {
      listEl.innerHTML = `<div class="prank-loading">书单加载失败：${e.message}</div>`;
    }
  }

  async function openNovel(novel) {
    overlay().innerHTML = `
      <div class="prank-header"><span class="prank-back" id="prank-back-btn">‹</span><span class="prank-title">${novel.title}</span></div>
      ${renderRiskBar()}
      <div class="prank-body"><div class="prank-loading">加载正文中...</div></div>
    `;
    document.getElementById('prank-back-btn').addEventListener('click', renderNovelCity);

    try {
      const prompt = `请写一段《${novel.title}》（题材：${novel.genre}，简介：${novel.desc}）的开篇正文片段，200-300字左右，要有代入感，像真的网络小说开头。只返回正文内容本身，不要标题、不要任何说明。`;
      const text = await callPrankAI(prompt);
      overlay().querySelector('.prank-body').innerHTML = `<div class="prank-novel-reading">${text}</div>`;
    } catch (e) {
      overlay().querySelector('.prank-body').innerHTML = `<div class="prank-loading">正文加载失败：${e.message}</div>`;
    }

    const discovered = await gainRiskAndCheck(currentChat, 'novel', `在书城偷偷看小说《${novel.title}》`);
    if (discovered) { await showDiscoveredModal(currentChat.name); renderPhoneHome(); }
  }

  // ---------------- 聊天设置里的授权开关 ----------------
  function injectSettingsToggle() {
    const container = document.querySelector('#chat-settings-screen .settings-container');
    if (!container || document.getElementById('prank-settings-section')) return;

    const section = document.createElement('div');
    section.className = 'settings-section';
    section.id = 'prank-settings-section';
    section.innerHTML = `
      <div class="settings-item">
        <label>😈 允许用TA的手机</label>
        <div class="settings-right"><input type="checkbox" id="prank-enable-toggle"></div>
      </div>
      <div class="settings-item-block">
        <div class="settings-desc">开启后，可以在"用TA的手机"App里选到这个角色，用ta的手机发消息/搜东西/记备忘录/看小说。玩得太过分有概率被发现，ta会亲自发消息找你对峙。</div>
        <button class="settings-full-btn secondary" id="prank-reset-btn" type="button" style="margin-top:8px;">🔓 重置风险值</button>
      </div>
    `;
    const anchor = Array.from(container.querySelectorAll(':scope > .settings-section'))
      .find(sec => sec.textContent.includes('回复条数范围') || sec.textContent.includes('启用独立后台活动'));
    container.insertBefore(section, anchor || container.firstChild);

    document.getElementById('prank-enable-toggle').addEventListener('change', async (e) => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.settings.enablePrankApp = e.target.checked;
      await db.chats.put(chat);
    });
    document.getElementById('prank-reset-btn').addEventListener('click', async () => {
      const chat = state.chats[state.activeChatId];
      if (!chat) return;
      chat.prankRisk = 0;
      await db.chats.put(chat);
      if (typeof showToast === 'function') showToast('已重置');
    });
  }

  function loadSettingsToggle() {
    const chat = state.chats[state.activeChatId];
    const section = document.getElementById('prank-settings-section');
    if (!chat || chat.isGroup) { section?.style.setProperty('display', 'none'); return; }
    section?.style.setProperty('display', '');
    document.getElementById('prank-enable-toggle').checked = !!chat.settings.enablePrankApp;
  }

  // ---------------- 初始化 ----------------
  function init() {
    injectStyle();
    injectSettingsToggle();

    if (!window.__prankShowScreenHooked) {
      window.__prankShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === 'chat-settings-screen') loadSettingsToggle();
          if (screenId === 'prank-app-screen') renderCharPicker();
        };
      }
    }
    console.log('[捣乱App v2] 初始化完成（实体App模式）');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.state.globalSettings && window.db && typeof window.showScreen === 'function' && document.getElementById('chat-settings-screen')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[捣乱App] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
