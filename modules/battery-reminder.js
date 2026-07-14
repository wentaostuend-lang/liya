// ============================================================
// battery-reminder.js — 低电量/充满电时角色气泡提醒 (V2 多档位版)
//
// 支持自定义多个低电量档位（比如20%/50%/80%各提醒一次），
// 加上"充满电"提醒。每个角色 + 每个档位（含"充满"）都有独立的
// 预生成台词库。
// ⚠️ navigator.getBattery() 只有 Chrome 系还支持，iOS Safari / Firefox 不支持。
// ============================================================

const FULL_TIER_KEY = 'full';

const BatteryReminder = {
  _battery: null,
  _triggeredLowTiers: new Set(),
  _triggeredFull: false,

  async init() {
    if (!('getBattery' in navigator)) {
      const tip = document.getElementById('battery-reminder-unsupported-tip');
      if (tip) tip.style.display = 'block';
      const toggle = document.getElementById('battery-reminder-toggle');
      if (toggle) toggle.disabled = true;
      return;
    }
    try {
      this._battery = await navigator.getBattery();
      this._battery.addEventListener('levelchange', () => this.checkLevel());
      this._battery.addEventListener('chargingchange', () => this.checkLevel());
      this.checkLevel();
    } catch (e) {
      console.warn('电量提醒: 获取电量信息失败', e);
    }
  },

  getTiers() {
    if (!Array.isArray(state.globalSettings.batteryReminderTiers)) {
      state.globalSettings.batteryReminderTiers = [
        { threshold: 20, enabled: true },
        { threshold: 50, enabled: true },
        { threshold: 80, enabled: true }
      ];
    }
    return state.globalSettings.batteryReminderTiers;
  },

  checkLevel() {
    if (!this._battery) return;
    if (!state.globalSettings.batteryReminderEnabled) return;

    const percent = Math.round(this._battery.level * 100);
    const charging = this._battery.charging;

    // ===== 充满电提醒 =====
    if (state.globalSettings.batteryFullReminderEnabled) {
      if (percent >= 100 && !this._triggeredFull) {
        this._triggeredFull = true;
        this.triggerReminder(FULL_TIER_KEY, percent);
      } else if (percent < 95) {
        this._triggeredFull = false; // 掉回95%以下才重新武装
      }
    }

    // ===== 低电量档位提醒 =====
    const tiers = this.getTiers().filter(t => t.enabled).sort((a, b) => b.threshold - a.threshold);

    if (charging) {
      // 充电中，只要电量比某档位高出5%以上就重新武装那一档
      tiers.forEach(t => {
        if (percent > t.threshold + 5) this._triggeredLowTiers.delete(t.threshold);
      });
      return;
    }

    for (const tier of tiers) {
      if (percent <= tier.threshold && !this._triggeredLowTiers.has(tier.threshold)) {
        this._triggeredLowTiers.add(tier.threshold);
        this.triggerReminder(tier.threshold, percent);
        break; // 一次只提醒当前命中的最高档位，避免一次掉多档连环弹
      }
    }
  },

  getReminderChat() {
    const mode = state.globalSettings.batteryReminderWhoMode || 'active_chat';
    if (mode === 'assigned' && state.globalSettings.batteryReminderAssignedChatId) {
      return state.chats[state.globalSettings.batteryReminderAssignedChatId] || null;
    }
    const activeChat = state.chats[state.activeChatId];
    if (activeChat && !activeChat.isGroup) return activeChat;
    return null;
  },

  _getLib(chat, tierKey) {
    if (!chat.batteryReminderLines || Array.isArray(chat.batteryReminderLines)) {
      chat.batteryReminderLines = {}; // 兼容旧版本的扁平数组，重置成按档位存储
    }
    if (!Array.isArray(chat.batteryReminderLines[tierKey])) {
      chat.batteryReminderLines[tierKey] = [];
    }
    return chat.batteryReminderLines[tierKey];
  },

  async triggerReminder(tierKey, percent) {
    const chat = this.getReminderChat();
    if (!chat) return;

    const genMode = state.globalSettings.batteryReminderGenMode || 'pregen';
    let line = '';

    if (genMode === 'pregen') {
      const lib = this._getLib(chat, tierKey);
      if (lib.length > 0) {
        line = lib[Math.floor(Math.random() * lib.length)].replace('{battery}', percent);
      } else {
        line = await this._generateOneLine(chat, tierKey, percent);
      }
    } else {
      line = await this._generateOneLine(chat, tierKey, percent);
    }

    if (!line) return;
    this.showBubble(chat, line);
  },

  async _generateOneLine(chat, tierKey, percent) {
    const cfg = state.apiConfig;
    if (!cfg || !cfg.proxyUrl || !cfg.apiKey || !cfg.model) return '';
    const scenario = tierKey === FULL_TIER_KEY
      ? '用户的手机刚刚充满电了（100%）'
      : `用户的手机电量降到了 ${percent}%`;
    const sysPrompt = `你正在扮演角色"${chat.originalName || chat.name}"。
【你的人设】：${chat.settings.aiPersona || ''}
${scenario}，请用你的人设口吻说一句话（不超过30字，自然、符合你的性格，不要暴露AI身份）。只返回这句话，不要引号。`;
    try {
      const isGemini = cfg.proxyUrl.includes('generativelanguage');
      let response;
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
            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: '请生成' }],
            max_tokens: 100
          })
        });
      }
      if (!response.ok) throw new Error(response.statusText);
      const data = await response.json();
      const raw = isGemini ? getGeminiResponseText(data) : data.choices[0].message.content;
      return raw.trim().replace(/^["「『]|["」』]$/g, '');
    } catch (e) {
      console.error('电量提醒: 实时生成台词失败', e);
      return tierKey === FULL_TIER_KEY ? '电量充满啦！' : `电量只剩${percent}%啦，快去充电吧！`;
    }
  },

  showBubble(chat, text) {
    const bubble = document.getElementById('battery-reminder-bubble');
    const avatarEl = document.getElementById('battery-reminder-bubble-avatar');
    const textEl = document.getElementById('battery-reminder-bubble-text');
    if (!bubble || !textEl) return;

    textEl.textContent = text;
    if (avatarEl) {
      const avatarUrl = chat.settings && chat.settings.aiAvatar;
      avatarEl.style.backgroundImage = avatarUrl ? `url('${avatarUrl}')` : '';
    }
    bubble.classList.add('visible');
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => bubble.classList.remove('visible'), 6000);
  },

  // 批量生成一批台词存进某个角色 + 某个档位的台词库（会替换掉原来的）
  async regenerateLibrary(chatId, tierKey, count = 5) {
    const chat = state.chats[chatId];
    if (!chat) return [];
    const cfg = state.apiConfig;
    if (!cfg || !cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      alert('主API未配置');
      return this._getLib(chat, tierKey);
    }

    const scenario = tierKey === FULL_TIER_KEY
      ? '提醒用户"手机刚充满电了"'
      : '提醒用户"手机快没电了，赶紧充电"';
    const sysPrompt = `你正在扮演角色"${chat.originalName || chat.name}"。
【你的人设】：${chat.settings.aiPersona || ''}
请生成 ${count} 句不同的、${scenario}的台词，符合你的人设口吻，风格尽量多样（可以关心、可以调侃、可以命令语气等）。
${tierKey === FULL_TIER_KEY ? '' : '台词里如果需要提到具体电量百分比，用 {battery} 作为占位符（后面会自动替换成真实数字）。'}
只返回一个JSON数组，不要任何多余文字：["台词1", "台词2", ...]`;

    try {
      const isGemini = cfg.proxyUrl.includes('generativelanguage');
      let response;
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
            messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: '请生成' }],
            max_tokens: 500
          })
        });
      }
      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`API请求失败(${response.status}): ${errText}`);
      }
      const data = await response.json();
      if (data.error) throw new Error(`API返回错误: ${data.error.message || JSON.stringify(data.error)}`);
      const raw = isGemini ? getGeminiResponseText(data) : data.choices?.[0]?.message?.content;
      if (!raw) throw new Error('API返回了空内容，模型可能没有正常输出');

      // 不再简单假设返回内容是"纯净JSON"：先尝试直接去围栏解析，
      // 失败就用正则从文本里把 [...] 数组部分抠出来再解析一次，
      // 兼容模型在JSON前后多说废话的情况（这是之前"生成失败"的主因）。
      let lines;
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      try {
        lines = JSON.parse(cleaned);
      } catch (parseErr) {
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          lines = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`AI没有返回可解析的JSON数组，原始回复：${raw.slice(0, 100)}`);
        }
      }

      if (!chat.batteryReminderLines || Array.isArray(chat.batteryReminderLines)) chat.batteryReminderLines = {};
      chat.batteryReminderLines[tierKey] = Array.isArray(lines) ? lines : [];

      if (window.db && window.db.chats) {
        try { await db.chats.put(chat); } catch (e) { console.error(e); }
      }
      return chat.batteryReminderLines[tierKey];
    } catch (e) {
      console.error('电量提醒: 生成台词库失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
      return this._getLib(chat, tierKey);
    }
  }
};

window.BatteryReminder = BatteryReminder;

// ============================================================
// 设置界面 UI 交互
// ============================================================
window.reflectBatteryReminderSettings = function () {
  const toggle = document.getElementById('battery-reminder-toggle');
  if (toggle) toggle.checked = state.globalSettings.batteryReminderEnabled || false;

  const fullToggle = document.getElementById('battery-full-reminder-toggle');
  if (fullToggle) fullToggle.checked = state.globalSettings.batteryFullReminderEnabled || false;

  const whoMode = document.getElementById('battery-reminder-who-mode');
  if (whoMode) whoMode.value = state.globalSettings.batteryReminderWhoMode || 'active_chat';

  const genMode = document.getElementById('battery-reminder-gen-mode');
  if (genMode) genMode.value = state.globalSettings.batteryReminderGenMode || 'pregen';

  const assignedSelect = document.getElementById('battery-reminder-assigned-char');
  if (assignedSelect) {
    const singleChats = Object.values(state.chats).filter(c => c && !c.isGroup && !c.isAltPersonaChat);
    assignedSelect.innerHTML = singleChats.map(c => `<option value="${c.id}">${c.originalName || c.name}</option>`).join('');
    if (state.globalSettings.batteryReminderAssignedChatId) {
      assignedSelect.value = state.globalSettings.batteryReminderAssignedChatId;
    }
    assignedSelect.style.display = (whoMode && whoMode.value === 'assigned') ? 'block' : 'none';
  }

  renderTierList();
};

function renderTierList() {
  const listEl = document.getElementById('battery-tier-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  BatteryReminder.getTiers().forEach((tier, index) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    row.innerHTML = `
      <input type="number" class="tier-threshold-input" min="1" max="99" value="${tier.threshold}" style="width:70px; padding:6px 8px; border:1px solid #e0e0e0; border-radius:8px; font-size:14px;">
      <span style="font-size:13px; color:#999;">%</span>
      <label class="toggle-switch" style="transform: scale(0.8);">
        <input type="checkbox" class="tier-enabled-toggle" ${tier.enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
      <button class="settings-mini-btn tier-delete-btn" style="margin-left:auto; color:var(--danger-color,#ff3b30); border-color:rgba(255,59,48,0.3);">删除</button>
    `;
    listEl.appendChild(row);

    const persist = async () => {
      const tiers = BatteryReminder.getTiers();
      tiers[index].threshold = parseInt(row.querySelector('.tier-threshold-input').value, 10) || tier.threshold;
      tiers[index].enabled = row.querySelector('.tier-enabled-toggle').checked;
      if (window.db && window.db.globalSettings) {
        try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
      }
    };
    row.querySelector('.tier-threshold-input').addEventListener('change', persist);
    row.querySelector('.tier-enabled-toggle').addEventListener('change', persist);
    row.querySelector('.tier-delete-btn').addEventListener('click', async () => {
      const tiers = BatteryReminder.getTiers();
      tiers.splice(index, 1);
      if (window.db && window.db.globalSettings) {
        try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
      }
      renderTierList();
    });
  });
}

(function () {
  async function persist(key, value) {
    state.globalSettings[key] = value;
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
    }
  }

  document.getElementById('battery-reminder-toggle')?.addEventListener('change', (e) => {
    persist('batteryReminderEnabled', e.target.checked);
    if (e.target.checked && typeof BatteryReminder !== 'undefined') BatteryReminder.checkLevel();
  });

  document.getElementById('battery-full-reminder-toggle')?.addEventListener('change', (e) => {
    persist('batteryFullReminderEnabled', e.target.checked);
  });

  document.getElementById('battery-tier-add-btn')?.addEventListener('click', async () => {
    const tiers = BatteryReminder.getTiers();
    tiers.push({ threshold: 10, enabled: true });
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) { console.error(e); }
    }
    renderTierList();
  });

  document.getElementById('battery-reminder-who-mode')?.addEventListener('change', (e) => {
    persist('batteryReminderWhoMode', e.target.value);
    const assignedSelect = document.getElementById('battery-reminder-assigned-char');
    if (assignedSelect) assignedSelect.style.display = e.target.value === 'assigned' ? 'block' : 'none';
  });

  document.getElementById('battery-reminder-assigned-char')?.addEventListener('change', (e) => {
    persist('batteryReminderAssignedChatId', e.target.value);
  });

  document.getElementById('battery-reminder-gen-mode')?.addEventListener('change', (e) => {
    persist('batteryReminderGenMode', e.target.value);
  });

  document.getElementById('battery-reminder-lib-entry')?.addEventListener('click', () => {
    const charSelect = document.getElementById('battery-lib-char-select');
    const singleChats = Object.values(state.chats).filter(c => c && !c.isGroup && !c.isAltPersonaChat);
    charSelect.innerHTML = singleChats.map(c => `<option value="${c.id}">${c.originalName || c.name}</option>`).join('');

    const tierSelect = document.getElementById('battery-lib-tier-select');
    const options = BatteryReminder.getTiers().map(t => `<option value="${t.threshold}">${t.threshold}% 档位</option>`).join('');
    tierSelect.innerHTML = options + `<option value="${FULL_TIER_KEY}">充满电（100%）</option>`;

    renderBatteryLibLines();
    document.getElementById('battery-reminder-lib-modal').classList.add('visible');
  });

  document.getElementById('battery-lib-char-select')?.addEventListener('change', renderBatteryLibLines);
  document.getElementById('battery-lib-tier-select')?.addEventListener('change', renderBatteryLibLines);

  function renderBatteryLibLines() {
    const charSelect = document.getElementById('battery-lib-char-select');
    const tierSelect = document.getElementById('battery-lib-tier-select');
    const listEl = document.getElementById('battery-lib-lines-list');
    if (!charSelect || !tierSelect || !listEl) return;
    const chat = state.chats[charSelect.value];
    listEl.innerHTML = '';
    const lines = chat ? BatteryReminder._getLib(chat, tierSelect.value) : [];
    if (lines.length === 0) {
      listEl.innerHTML = '<div style="color:#999; font-size:13px; text-align:center; padding:20px 0;">还没有台词，点上面按钮生成一批</div>';
      return;
    }
    lines.forEach(line => {
      const item = document.createElement('div');
      item.style.cssText = 'background:#f5f5f7; border-radius:10px; padding:10px 12px; font-size:13px;';
      item.textContent = line;
      listEl.appendChild(item);
    });
  }

  document.getElementById('battery-lib-generate-btn')?.addEventListener('click', async () => {
    const charSelect = document.getElementById('battery-lib-char-select');
    const tierSelect = document.getElementById('battery-lib-tier-select');
    if (!charSelect.value) { alert('先选个角色'); return; }
    const btn = document.getElementById('battery-lib-generate-btn');
    btn.disabled = true;
    btn.textContent = '生成中...';
    await BatteryReminder.regenerateLibrary(charSelect.value, tierSelect.value);
    btn.disabled = false;
    btn.textContent = '🔄 生成一批新台词（会替换现有的）';
    renderBatteryLibLines();
  });

  document.getElementById('battery-lib-close-btn')?.addEventListener('click', () => {
    document.getElementById('battery-reminder-lib-modal').classList.remove('visible');
  });

  // 页面加载完成后启动电量监听
  if (typeof BatteryReminder !== 'undefined') BatteryReminder.init();
})();
