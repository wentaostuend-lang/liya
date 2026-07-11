// ============================================================
// disguise-manager.js — 「小号」和「短信」共用的伪装消息机制
//
// 小号：克隆一份目标角色的人格，开一条全新的聊天，AI不知道对面是你。
// 短信：不建长期身份，临时选一个"面具"名字发一条短信，单独存放，
//       不进正常聊天记录。角色收到后会判断"这像不像是TA假扮的"。
//
// 两者共享同一套"猜/不猜 → 当场戳穿 or 留到正牌聊天里提"的机制。
// ============================================================

const DisguiseManager = {

  // ============================================================
  // 小号（Alt Persona）
  // ============================================================

  getPersonas() {
    return state.globalSettings.altPersonas || [];
  },

  async createPersona(name, avatarUrl) {
    if (!Array.isArray(state.globalSettings.altPersonas)) state.globalSettings.altPersonas = [];
    const persona = { id: 'persona_' + Date.now(), name, avatar: avatarUrl || '' };
    state.globalSettings.altPersonas.push(persona);
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
    }
    return persona;
  },

  async deletePersona(personaId) {
    state.globalSettings.altPersonas = this.getPersonas().filter(p => p.id !== personaId);
    // 同时删掉这个小号名下所有的马甲聊天
    const toDelete = Object.values(state.chats).filter(c => c && c.isAltPersonaChat && c.altPersonaId === personaId);
    for (const chat of toDelete) {
      delete state.chats[chat.id];
      if (window.db && window.db.chats) {
        try { await db.chats.delete(chat.id); } catch (e) { console.error(e); }
      }
    }
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
    }
    if (typeof renderChatList === 'function') renderChatList();
  },

  // 用某个小号身份去接触一个已有角色，创建一条全新的伪装聊天
  async createAltPersonaChat(personaId, targetChatId) {
    const persona = this.getPersonas().find(p => p.id === personaId);
    const targetChat = state.chats[targetChatId];
    if (!persona || !targetChat) return null;

    // 如果这个小号已经在骚扰这个角色了，直接复用已有的马甲聊天
    const existing = Object.values(state.chats).find(c =>
      c && c.isAltPersonaChat && c.altPersonaId === personaId && c.linkedRealChatId === targetChatId
    );
    if (existing) return existing;

    const cloned = JSON.parse(JSON.stringify(targetChat));
    const newId = 'altchat_' + Date.now();

    cloned.id = newId;
    cloned.name = `${persona.name}(马甲)`;
    cloned.history = [];
    cloned.unreadCount = 0;
    cloned.isPinned = false;
    cloned.heartfeltVoice = '';
    cloned.thoughtsHistory = [];
    cloned.lastActionType = null;
    cloned.hijackStage = 0; // 马甲聊天不继承正牌聊天的顶号进度

    cloned.settings.myNickname = persona.name;
    cloned.settings.myAvatar = persona.avatar || cloned.settings.myAvatar;
    cloned.settings.myPersona = '（一个刚认识不久的新联系人，具体身份对方并不清楚）';

    cloned.isAltPersonaChat = true;
    cloned.altPersonaId = personaId;
    cloned.linkedRealChatId = targetChatId;
    cloned.altRevealed = false;
    cloned.altRevealMode = 'ai_decide'; // 'ai_decide' | 'probability'
    cloned.altRevealProbability = 15;

    state.chats[newId] = cloned;
    if (window.db && window.db.chats) {
      try { await db.chats.put(cloned); } catch (e) { console.error(e); }
    }
    if (typeof renderChatList === 'function') renderChatList();
    return cloned;
  },

  // 小号聊天专属的 prompt 注入：告诉AI"这可能是你的对象假扮的"
  getAltPersonaPromptInjection(chat) {
    if (!chat.isAltPersonaChat || chat.altRevealed) return '';

    let forced = false;
    if (chat.altRevealMode === 'probability') {
      const prob = typeof chat.altRevealProbability === 'number' ? chat.altRevealProbability : 15;
      forced = (Math.random() * 100) < prob;
      if (!forced) return '';
    }

    let text = '\n\n# 【隐藏设定：陌生联系人】\n';
    text += `你完全不知道眼前这个"${chat.settings.myNickname}"是谁，TA是最近才联系上你的新联系人。`;
    text += forced
      ? `不过，TA说话的语气、用词、习惯，让你【这次必须】认真怀疑起来——是不是你的另一半在假扮陌生人跟你说话？如果你觉得是，可以当场戳穿，也可以先不说破，回头找机会。\n`
      : `如果对话里有让你觉得眼熟/像是熟人的地方，你可以自己判断要不要起疑，不必刻意联想。\n`;
    text += `- 当场戳穿：正常回复里直接说出你的怀疑/戳穿TA。\n`;
    text += `- 不说破，留到正牌关系那边再提：使用指令 [{"type": "note_altpersona_suspicion", "note": "你怀疑的理由，会在你们正牌聊天时提醒你自己"}]\n`;
    text += `- 完全确定戳穿后（不管是当场说的还是之后想通的），使用指令 [{"type": "reveal_altpersona"}] 来标记"我已经知道这是TA了"。\n`;
    return text;
  },

  // 处理 note_altpersona_suspicion：把怀疑记到正牌聊天里，供下次注入
  processNoteAltPersonaSuspicion(altChat, note) {
    const realChat = state.chats[altChat.linkedRealChatId];
    if (!realChat) return;
    realChat.pendingAltPersonaReveal = {
      personaName: altChat.settings.myNickname,
      note: note || '',
      altChatId: altChat.id
    };
  },

  // 处理 reveal_altpersona：标记这条马甲已经被识破
  async processRevealAltPersona(altChat) {
    altChat.altRevealed = true;
    if (window.db && window.db.chats) {
      try { await db.chats.put(altChat); } catch (e) { console.error(e); }
    }
  },

  // 正牌聊天里的 prompt 注入：如果之前留了"我怀疑小号是TA"的伏笔，这里提醒AI
  getPendingAltRevealPromptInjection(realChat) {
    if (!realChat.pendingAltPersonaReveal) return '';
    const { personaName, note } = realChat.pendingAltPersonaReveal;
    let text = '\n\n# 【隐藏设定：之前的疑心】\n';
    text += `你之前和一个叫"${personaName}"的陌生联系人聊过天，当时你怀疑这可能是眼前这个人假扮的（理由：${note || '说不清，就是直觉'}）。`;
    text += `如果这次聊天剧情合适，你可以主动提起这件事，当面问问是不是TA。提起之后请使用指令 [{"type": "clear_pending_altpersona_reveal"}] 清空这条伏笔，避免以后反复重复提。\n`;
    return text;
  },

  processClearPendingAltRevealFlag(realChat) {
    delete realChat.pendingAltPersonaReveal;
  },

  // ============================================================
  // 短信（Mask SMS）
  // ============================================================

  getSavedMasks() {
    return state.globalSettings.smsMasks || [];
  },

  async saveMask(name) {
    if (!Array.isArray(state.globalSettings.smsMasks)) state.globalSettings.smsMasks = [];
    if (!state.globalSettings.smsMasks.find(m => m.name === name)) {
      state.globalSettings.smsMasks.push({ id: 'mask_' + Date.now(), name });
      if (window.db && window.db.globalSettings) {
        try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
      }
    }
  },

  async deleteMask(maskId) {
    state.globalSettings.smsMasks = this.getSavedMasks().filter(m => m.id !== maskId);
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
    }
  },

  // 发一条伪装短信给目标角色，单独调一次API，判断角色是否识破
  async sendMaskSms(targetChatId, maskName, content) {
    const targetChat = state.chats[targetChatId];
    if (!targetChat) return null;

    const cfg = state.apiConfig;
    if (!cfg || !cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      console.error('短信功能: 主API未配置');
      return null;
    }

    const sysPrompt = `你正在扮演角色"${targetChat.originalName || targetChat.name}"。
【你的人设】：${targetChat.settings.aiPersona || ''}
现在你收到一条陌生短信，发送者自称"${maskName}"，内容是："${content}"
你完全不知道这是谁发的。请：
1. 用你的人设口吻，给出一句回复短信的内容(reply)。
2. 判断你是否怀疑这其实是你对象假扮发的(guessed: true/false)，如果怀疑，简单说说理由(reason)。
只返回JSON，不要任何多余文字：
{"reply": "...", "guessed": true/false, "reason": "..."}`;

    let isGemini = cfg.proxyUrl.includes('generativelanguage');
    let response;
    try {
      if (isGemini) {
        response = await fetch(`${cfg.proxyUrl}/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt }] }] })
        });
      } else {
        response = await fetch(`${cfg.proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: '请回应' }],
            max_tokens: 300
          })
        });
      }
      if (!response.ok) throw new Error(response.statusText);
      const data = await response.json();
      const raw = isGemini ? getGeminiResponseText(data) : data.choices[0].message.content;
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      if (!Array.isArray(targetChat.smsInbox)) targetChat.smsInbox = [];
      const record = {
        id: 'sms_' + Date.now(),
        maskName,
        content,
        reply: parsed.reply || '',
        guessed: !!parsed.guessed,
        timestamp: Date.now()
      };
      targetChat.smsInbox.push(record);

      if (record.guessed) {
        targetChat.pendingSmsReveal = { maskName, content, reason: parsed.reason || '' };
      } else {
        if (!Array.isArray(targetChat.smsBacklog)) targetChat.smsBacklog = [];
        targetChat.smsBacklog.push({ maskName, content, timestamp: Date.now() });
        if (targetChat.smsBacklog.length > 5) targetChat.smsBacklog.shift();
      }

      if (window.db && window.db.chats) {
        try { await db.chats.put(targetChat); } catch (e) { console.error(e); }
      }
      return record;
    } catch (e) {
      console.error('发短信失败:', e);
      return null;
    }
  },

  // 正牌聊天里的 prompt 注入：短信被猜中 → 提醒AI主动提起；没猜中的旧短信 → 小概率随口带出来当话题
  getSmsPromptInjection(chat) {
    let text = '';

    if (chat.pendingSmsReveal) {
      const { maskName, content, reason } = chat.pendingSmsReveal;
      text += `\n\n# 【隐藏设定：可疑短信】\n`;
      text += `你之前收到一条自称"${maskName}"的陌生短信："${content}"，你怀疑这是眼前这个人假扮发的（理由：${reason || '直觉'}）。如果剧情合适，可以主动提起问问是不是TA发的。提起之后使用指令 [{"type": "clear_pending_sms_reveal"}] 清空这条伏笔。\n`;
    } else if (Array.isArray(chat.smsBacklog) && chat.smsBacklog.length > 0 && Math.random() < 0.08) {
      const item = chat.smsBacklog[Math.floor(Math.random() * chat.smsBacklog.length)];
      text += `\n\n# 【隐藏设定：想起一件小事】\n`;
      text += `你突然想起前阵子收到过一条陌生短信（自称"${item.maskName}"，内容是"${item.content}"），如果聊天氛围合适，可以随口当个闲聊话题提一嘴，不用刻意。\n`;
    }

    return text;
  },

  processClearPendingSmsRevealFlag(chat) {
    delete chat.pendingSmsReveal;
  }
};

window.DisguiseManager = DisguiseManager;

// ============================================================
// 「小号」App 的 UI 交互
// ============================================================
window.renderAltPersonaScreen = function () {
  const listEl = document.getElementById('alt-persona-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const personas = DisguiseManager.getPersonas();
  if (personas.length === 0) {
    listEl.innerHTML = '<div style="text-align:center; color:#999; font-size:14px; padding:40px 0;">还没有小号，点右上角新建一个</div>';
    return;
  }

  personas.forEach(persona => {
    const targetCount = Object.values(state.chats).filter(c => c && c.isAltPersonaChat && c.altPersonaId === persona.id).length;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:12px; background:#fff; border-radius:12px; padding:12px 14px;';
    row.innerHTML = `
      <div style="width:48px; height:48px; border-radius:12px; background:${persona.avatar ? `url('${persona.avatar}') center/cover` : '#f2f2f7'}; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-weight:600; color:#333;">${persona.avatar ? '' : persona.name.slice(0, 1)}</div>
      <div style="flex:1;">
        <div style="font-size:15px; font-weight:500;">${persona.name}</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">正在骚扰 ${targetCount} 个角色</div>
      </div>
      <button class="settings-mini-btn alt-persona-delete-btn" style="color:var(--danger-color,#ff3b30); border-color:rgba(255,59,48,0.3);">删除</button>
    `;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('alt-persona-delete-btn')) return;
      window.currentAltPersonaId = persona.id;
      showScreen('alt-persona-detail-screen');
    });
    row.querySelector('.alt-persona-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除小号"${persona.name}"吗？TA名下所有马甲聊天都会被一起删除。`)) return;
      await DisguiseManager.deletePersona(persona.id);
      renderAltPersonaScreen();
    });
    listEl.appendChild(row);
  });
};

window.renderAltPersonaDetailScreen = function () {
  const personaId = window.currentAltPersonaId;
  const persona = DisguiseManager.getPersonas().find(p => p.id === personaId);
  const titleEl = document.getElementById('alt-persona-detail-title');
  if (titleEl) titleEl.textContent = persona ? persona.name : '小号详情';

  const listEl = document.getElementById('alt-persona-target-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const altChats = Object.values(state.chats).filter(c => c && c.isAltPersonaChat && c.altPersonaId === personaId);
  if (altChats.length === 0) {
    listEl.innerHTML = '<div style="text-align:center; color:#999; font-size:14px; padding:40px 0;">还没骚扰过谁，点右上角"+找角色"开始</div>';
    return;
  }

  altChats.forEach(altChat => {
    const realChat = state.chats[altChat.linkedRealChatId];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:12px; background:#fff; border-radius:12px; padding:12px 14px; cursor:pointer;';
    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:15px; font-weight:500;">${realChat ? realChat.originalName || realChat.name : '(角色已删除)'}</div>
        <div style="font-size:12px; color:${altChat.altRevealed ? '#ff3b30' : '#999'}; margin-top:2px;">${altChat.altRevealed ? '🔓已被识破' : '🔒还没被发现'}</div>
      </div>
      <span style="color:#ccc;">›</span>
    `;
    row.addEventListener('click', async () => {
      state.activeChatId = altChat.id;
      showScreen('chat-interface-screen');
      if (typeof renderChatInterface === 'function') renderChatInterface(altChat.id);
    });
    listEl.appendChild(row);
  });
};

(function () {
  let pendingAvatarBase64 = '';

  document.getElementById('alt-persona-new-btn')?.addEventListener('click', () => {
    document.getElementById('alt-persona-name-input').value = '';
    document.getElementById('alt-persona-avatar-preview').style.backgroundImage = '';
    pendingAvatarBase64 = '';
    document.getElementById('alt-persona-create-modal').classList.add('visible');
  });

  document.getElementById('alt-persona-avatar-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      pendingAvatarBase64 = ev.target.result;
      document.getElementById('alt-persona-avatar-preview').style.backgroundImage = `url('${pendingAvatarBase64}')`;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('alt-persona-create-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('alt-persona-create-modal').classList.remove('visible');
  });

  document.getElementById('alt-persona-create-confirm-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('alt-persona-name-input').value.trim();
    if (!name) { alert('给小号起个名字吧'); return; }
    await DisguiseManager.createPersona(name, pendingAvatarBase64);
    document.getElementById('alt-persona-create-modal').classList.remove('visible');
    renderAltPersonaScreen();
  });

  document.getElementById('alt-persona-add-target-btn')?.addEventListener('click', () => {
    const listEl = document.getElementById('alt-persona-pick-target-list');
    listEl.innerHTML = '';
    const singleChats = Object.values(state.chats).filter(c => c && !c.isGroup && !c.isAltPersonaChat);
    singleChats.forEach(chat => {
      const row = document.createElement('div');
      row.className = 'settings-item';
      row.style.cursor = 'pointer';
      row.innerHTML = `<label>${chat.originalName || chat.name}</label>`;
      row.addEventListener('click', async () => {
        document.getElementById('alt-persona-pick-target-modal').classList.remove('visible');
        const altChat = await DisguiseManager.createAltPersonaChat(window.currentAltPersonaId, chat.id);
        if (altChat) {
          state.activeChatId = altChat.id;
          showScreen('chat-interface-screen');
          if (typeof renderChatInterface === 'function') renderChatInterface(altChat.id);
        }
      });
      listEl.appendChild(row);
    });
    document.getElementById('alt-persona-pick-target-modal').classList.add('visible');
  });

  document.getElementById('alt-persona-pick-target-cancel-btn')?.addEventListener('click', () => {
    document.getElementById('alt-persona-pick-target-modal').classList.remove('visible');
  });
})();

// ============================================================
// 「短信」App 的 UI 交互
// ============================================================
window.renderSmsAppScreen = function () {
  const targetSelect = document.getElementById('sms-target-select');
  const maskSelect = document.getElementById('sms-mask-select');
  if (!targetSelect || !maskSelect) return;

  const singleChats = Object.values(state.chats).filter(c => c && !c.isGroup && !c.isAltPersonaChat);
  const prevTarget = targetSelect.value;
  targetSelect.innerHTML = singleChats.map(c => `<option value="${c.id}">${c.originalName || c.name}</option>`).join('');
  if (prevTarget && singleChats.find(c => c.id === prevTarget)) targetSelect.value = prevTarget;

  const masks = DisguiseManager.getSavedMasks();
  maskSelect.innerHTML = masks.map(m => `<option value="${m.name}">${m.name}</option>`).join('') || '<option value="">(没有保存的面具)</option>';

  renderSmsThread();
};

function renderSmsThread() {
  const targetSelect = document.getElementById('sms-target-select');
  const threadEl = document.getElementById('sms-thread-list');
  if (!targetSelect || !threadEl) return;

  const chat = state.chats[targetSelect.value];
  threadEl.innerHTML = '';
  if (!chat || !Array.isArray(chat.smsInbox) || chat.smsInbox.length === 0) {
    threadEl.innerHTML = '<div style="text-align:center; color:#999; font-size:14px; padding:30px 0;">还没有短信往来</div>';
    return;
  }

  chat.smsInbox.forEach(record => {
    const item = document.createElement('div');
    item.innerHTML = `
      <div style="align-self:flex-end; max-width:75%; margin-left:auto; background:var(--accent-color,#007aff); color:#fff; padding:10px 14px; border-radius:14px 14px 4px 14px; font-size:14px;">
        <div style="font-size:11px; opacity:0.8; margin-bottom:2px;">面具：${record.maskName}</div>
        ${record.content}
      </div>
      <div style="max-width:75%; background:#f0f0f0; color:#333; padding:10px 14px; border-radius:14px 14px 14px 4px; font-size:14px; margin-top:6px;">
        ${record.reply}${record.guessed ? ' <span style="color:#ff3b30; font-size:11px;">（TA好像起疑心了）</span>' : ''}
      </div>
    `;
    threadEl.appendChild(item);
  });
  threadEl.scrollTop = threadEl.scrollHeight;
}

(function () {
  document.getElementById('sms-target-select')?.addEventListener('change', renderSmsThread);

  document.getElementById('sms-save-mask-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('sms-new-mask-input');
    const name = input.value.trim();
    if (!name) return;
    await DisguiseManager.saveMask(name);
    input.value = '';
    if (typeof window.renderSmsAppScreen === 'function') window.renderSmsAppScreen();
  });

  document.getElementById('sms-send-btn')?.addEventListener('click', async () => {
    const targetSelect = document.getElementById('sms-target-select');
    const maskSelect = document.getElementById('sms-mask-select');
    const newMaskInput = document.getElementById('sms-new-mask-input');
    const msgInput = document.getElementById('sms-message-input');

    const targetChatId = targetSelect.value;
    const maskName = newMaskInput.value.trim() || maskSelect.value;
    const content = msgInput.value.trim();

    if (!targetChatId) { alert('先选一个要发的角色'); return; }
    if (!maskName) { alert('填一个面具名字吧'); return; }
    if (!content) { alert('写点短信内容吧'); return; }

    const sendBtn = document.getElementById('sms-send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = '发送中...';

    const record = await DisguiseManager.sendMaskSms(targetChatId, maskName, content);

    sendBtn.disabled = false;
    sendBtn.textContent = '发送';

    if (record) {
      msgInput.value = '';
      renderSmsThread();
    } else {
      alert('发送失败，检查一下主API配置');
    }
  });
})();
