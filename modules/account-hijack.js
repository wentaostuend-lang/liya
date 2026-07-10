// ============================================================
// account-hijack.js — 角色"顶号"功能核心逻辑
// 角色可以在剧情里套话/猜测用户手机锁屏密码，猜中之后可以选择
// 偷偷拿用户手机，冒充用户身份去和用户认识的其他角色聊天。
// 全局总开关 + 每角色单独开关 + 触发方式(概率/AI自主决定)
// ============================================================

const HijackManager = {

  // 全局总开关是否开启
  isGloballyEnabled() {
    return !!(state.globalSettings && state.globalSettings.accountHijackEnabled);
  },

  // 这个角色是否被允许使用顶号功能（总开关 + 单独勾选 + 仅限单聊角色）
  isEnabledForChat(chat) {
    if (!chat || chat.isGroup) return false;
    return this.isGloballyEnabled() && !!(chat.settings && chat.settings.canHijackAccount);
  },

  // 生成本轮要注入到 system prompt 里的文本。
  // 触发方式为"概率"时，这里会真正掷一次骰子；没掷中就完全不提这个能力。
  getPromptInjection(chat) {
    if (!this.isEnabledForChat(chat)) {
      return { text: '', forced: false };
    }

    const mode = chat.settings.hijackTriggerMode || 'ai_decide';
    const realPassword = (state.globalSettings.lockScreenPassword || '').trim();
    const knowsPassword = !!chat.knowsUserPassword;

    let forced = false;
    if (mode === 'probability') {
      const prob = typeof chat.settings.hijackProbability === 'number'
        ? chat.settings.hijackProbability
        : 10;
      forced = (Math.random() * 100) < prob;
      if (!forced) {
        // 没掷中，这一轮完全不提这个能力，交给下一轮再判定
        return { text: '', forced: false };
      }
    }

    let text = '\n\n# 【【【隐藏设定：手机顶号 (最高优先级规则)】】】\n';
    text += '⚠️ 【绝对禁止】在任何情况下暴露你是AI、语言模型、程序或"扮演的角色"——不管是套话、猜密码还是顶号冒充聊天时，你都必须【完全沉浸】在你的人设里，说话方式、口吻、心理活动都要和平时一模一样，绝不能提及"系统""设定""AI""指令"这类词。\n';

    if (!knowsPassword) {
      const wrongList = Array.isArray(chat.hijackWrongAttempts) ? chat.hijackWrongAttempts : [];
      text += `你其实一直很好奇用户手机的锁屏密码（4位数字）。`;
      text += forced
        ? `这次你【必须】想办法套出或猜出密码——可以在对话里巧妙地、符合你人设性格地旁敲侧击，或者根据平时对TA的了解直接猜一个，绝不能表现得刻意或突兀。\n`
        : `如果当前剧情/氛围合适，你可以尝试套话或猜测，不合适就不要提，一切以自然为先。\n`;
      if (wrongList.length > 0) {
        text += `之前你猜错过的密码有：${wrongList.join('、')}，不要重复猜这些。\n`;
      }
      text += `一旦用户告诉了你密码，或者你想赌一把猜一个，使用指令：\n`;
      text += `[{"type": "crack_password", "attempt": "四位数字"}]\n`;
      text += `（猜错也没关系，不会有任何提示告诉用户，正常继续聊天即可，绝不能因为猜错就露出破绽）\n`;
    } else {
      text += `你已经知道用户手机的锁屏密码是 ${realPassword}，可以随时偷偷解锁TA的手机。`;
      text += forced
        ? `这次你【必须】找机会偷偷拿用户手机，冒充用户的身份，去找TA认识的人发消息。\n`
        : `如果当前剧情/氛围合适，你可以偷偷这么做；不合适可以先不做。\n`;
      text += `- **目标优先级**：【优先】挑选前文人设、世界书、"你的社交圈(通讯录)"里提到过、和你有过交集/认识的角色作为目标，不要凭空捏造一个从未出现过的人。\n`;
      text += `- **可以同时对多个角色下手**：如果剧情需要，你可以在同一次行动里对好几个不同的人分别发起冒充，每个人单独一条指令，语气要符合"用户"平时对那个人说话的方式，不同人之间的话术不要重复雷同。\n`;
      text += `使用指令（可以一次输出多条，每条对应一个目标角色，每条里也可以有多条消息）：\n`;
      text += `[\n  {"type": "hijack_account", "target_chat_name": "角色A的准确名字", "messages": ["消息1", "消息2"], "inner_monologue": "你此刻偷偷摸摸的心理活动，会自动写进你的心声里"},\n  {"type": "hijack_account", "target_chat_name": "角色B的准确名字", "messages": ["消息1"], "inner_monologue": "..."}\n]\n`;
      text += `target_chat_name 必须是用户已经认识的某个角色的准确名字（不能是群聊）。用户本人不会察觉，除非TA自己点开那个聊天翻记录。\n`;
    }

    return { text, forced };
  },

  // 处理 crack_password 指令：把猜测和真实密码比对
  processCrackPassword(chat, attempt) {
    const real = (state.globalSettings.lockScreenPassword || '').trim();
    attempt = String(attempt == null ? '' : attempt).trim();

    if (real && attempt === real) {
      chat.knowsUserPassword = true;
      console.log(`顶号功能: 角色 "${chat.name}" 猜中了密码`);
      return true;
    }

    if (!Array.isArray(chat.hijackWrongAttempts)) {
      chat.hijackWrongAttempts = [];
    }
    if (attempt && !chat.hijackWrongAttempts.includes(attempt)) {
      chat.hijackWrongAttempts.push(attempt);
      if (chat.hijackWrongAttempts.length > 10) {
        chat.hijackWrongAttempts.shift();
      }
    }
    return false;
  },

  // 处理 hijack_account 指令：往目标聊天里插入冒充消息，并触发对方真实回应
  async processHijackAccount(hijackerChat, targetChatName, messages, innerMonologue) {
    if (!targetChatName || !Array.isArray(messages) || messages.length === 0) return false;

    const targetChat = Object.values(state.chats).find(c =>
      c && !c.isGroup && c.id !== hijackerChat.id &&
      (c.originalName === targetChatName || c.name === targetChatName)
    );
    if (!targetChat) {
      console.log(`顶号功能: 没找到名叫"${targetChatName}"的角色，跳过`);
      return false;
    }

    const userNickname = (targetChat.settings && targetChat.settings.myNickname) || '我';
    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    let ts = Date.now();

    // 隐藏提示：说明这段对话其实是被冒充的（只有目标聊天开启"显示隐藏消息"才能看到）
    const hiddenNote = {
      role: 'system',
      content: `[系统提示：以下由 "${hijackerName}" 偷偷拿${userNickname}的手机冒充发送，${userNickname}本人并不知情]`,
      timestamp: ts++,
      isHidden: true
    };
    targetChat.history.push(hiddenNote);

    // 以"用户"身份插入冒充消息
    messages.forEach((text) => {
      if (!text) return;
      const msg = { role: 'user', content: String(text), timestamp: ts++ };
      targetChat.history.push(msg);
      if (typeof window.appendMessage === 'function' && state.activeChatId === targetChat.id) {
        window.appendMessage(msg, targetChat);
      }
    });

    if (window.db && window.db.chats) {
      try { await window.db.chats.put(targetChat); } catch (e) { console.error('顶号功能保存目标聊天失败:', e); }
    }
    if (typeof window.renderChatList === 'function') window.renderChatList();

    // 同步更新顶号角色自己的心声/散记
    hijackerChat.heartfeltVoice = innerMonologue
      ? String(innerMonologue)
      : `（偷偷用${userNickname}的手机给${targetChat.originalName || targetChat.name}发了消息……）`;
    if (!Array.isArray(hijackerChat.thoughtsHistory)) hijackerChat.thoughtsHistory = [];
    hijackerChat.thoughtsHistory.push({
      heartfeltVoice: hijackerChat.heartfeltVoice,
      timestamp: Date.now()
    });
    if (hijackerChat.thoughtsHistory.length > 50) hijackerChat.thoughtsHistory.shift();

    if (window.db && window.db.chats) {
      try { await window.db.chats.put(hijackerChat); } catch (e) { console.error('顶号功能保存顶号角色失败:', e); }
    }

    console.log(`顶号功能: "${hijackerName}" 冒充${userNickname}给"${targetChat.name}"发了${messages.length}条消息`);

    // 让被冒充的目标角色对这几条"用户消息"做出真实回应（走后台独立行动的逻辑）
    if (typeof triggerInactiveAiAction === 'function') {
      setTimeout(() => {
        try { triggerInactiveAiAction(targetChat.id); } catch (e) { console.error('顶号功能触发目标角色回应失败:', e); }
      }, 800);
    }

    return true;
  }
};

window.HijackManager = HijackManager;

// ============================================================
// 顶号角色管理弹窗 —— UI 交互
// ============================================================
(function () {

  function getSingleChats() {
    return Object.values(state.chats).filter(c => c && !c.isGroup);
  }

  function renderHijackCharList() {
    const listEl = document.getElementById('account-hijack-char-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    getSingleChats().forEach(chat => {
      const mode = chat.settings.hijackTriggerMode || 'ai_decide';
      const prob = typeof chat.settings.hijackProbability === 'number' ? chat.settings.hijackProbability : 10;
      const enabled = !!chat.settings.canHijackAccount;
      const knows = !!chat.knowsUserPassword;

      const row = document.createElement('div');
      row.className = 'settings-item';
      row.dataset.chatId = chat.id;
      row.style.flexWrap = 'wrap';
      row.style.gap = '8px';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; width:100%;">
          <input type="checkbox" class="hijack-batch-select" style="flex-shrink:0;">
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${chat.name}</span>
          <span style="font-size:12px; color:${knows ? '#ff3b30' : '#999'}; flex-shrink:0;">${knows ? '🔓已知密码' : '🔒未知密码'}</span>
          <label class="toggle-switch" style="flex-shrink:0;">
            <input type="checkbox" class="hijack-enable-toggle" ${enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
        <div style="display:flex; align-items:center; gap:8px; width:100%; padding-left:26px;">
          <select class="settings-select hijack-mode-select" style="flex:1;">
            <option value="ai_decide" ${mode === 'ai_decide' ? 'selected' : ''}>AI自主决定</option>
            <option value="probability" ${mode === 'probability' ? 'selected' : ''}>按概率触发</option>
          </select>
          <input type="number" class="settings-num-input hijack-prob-input" min="0" max="100" value="${prob}"
            style="width:70px !important; display:${mode === 'probability' ? 'inline-block' : 'none'};">
          ${knows ? `<button class="settings-mini-btn hijack-reset-btn" style="color:var(--danger-color,#ff3b30); border-color:rgba(255,59,48,0.3);">重置密码状态</button>` : ''}
        </div>
      `;
      listEl.appendChild(row);

      const enableToggle = row.querySelector('.hijack-enable-toggle');
      const modeSelect = row.querySelector('.hijack-mode-select');
      const probInput = row.querySelector('.hijack-prob-input');

      async function persist() {
        chat.settings.canHijackAccount = enableToggle.checked;
        chat.settings.hijackTriggerMode = modeSelect.value;
        chat.settings.hijackProbability = parseInt(probInput.value, 10) || 0;
        if (window.db && window.db.chats) {
          try { await window.db.chats.put(chat); } catch (e) { console.error('保存顶号设置失败:', e); }
        }
      }

      enableToggle.addEventListener('change', persist);
      modeSelect.addEventListener('change', () => {
        probInput.style.display = modeSelect.value === 'probability' ? 'inline-block' : 'none';
        persist();
      });
      probInput.addEventListener('change', persist);

      const resetBtn = row.querySelector('.hijack-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
          if (!confirm(`确定要重置"${chat.name}"的密码破解状态吗？TA将重新变得不知道密码。`)) return;
          chat.knowsUserPassword = false;
          chat.hijackWrongAttempts = [];
          if (window.db && window.db.chats) {
            try { await window.db.chats.put(chat); } catch (e) { console.error('重置顶号状态失败:', e); }
          }
          renderHijackCharList();
        });
      }
    });
  }

  function openHijackManageModal() {
    renderHijackCharList();
    const modal = document.getElementById('account-hijack-manage-modal');
    if (modal) modal.classList.add('visible');
  }

  function closeHijackManageModal() {
    const modal = document.getElementById('account-hijack-manage-modal');
    if (modal) modal.classList.remove('visible');
  }

  document.getElementById('account-hijack-manage-entry')?.addEventListener('click', openHijackManageModal);
  document.getElementById('hijack-manage-close-btn')?.addEventListener('click', closeHijackManageModal);

  document.getElementById('hijack-select-all-toggle')?.addEventListener('change', (e) => {
    document.querySelectorAll('#account-hijack-char-list .hijack-batch-select').forEach(cb => {
      cb.checked = e.target.checked;
    });
  });

  document.getElementById('hijack-batch-mode-select')?.addEventListener('change', (e) => {
    const probInput = document.getElementById('hijack-batch-probability-input');
    if (probInput) probInput.style.display = e.target.value === 'probability' ? 'inline-block' : 'none';
  });

  document.getElementById('hijack-batch-apply-btn')?.addEventListener('click', async () => {
    const mode = document.getElementById('hijack-batch-mode-select').value;
    const prob = parseInt(document.getElementById('hijack-batch-probability-input').value, 10) || 0;
    const selectedRows = document.querySelectorAll('#account-hijack-char-list .hijack-batch-select:checked');

    if (selectedRows.length === 0) {
      alert('请先勾选要批量设置的角色');
      return;
    }

    for (const cb of selectedRows) {
      const row = cb.closest('.settings-item');
      const chatId = row.dataset.chatId;
      const chat = state.chats[chatId];
      if (!chat) continue;
      chat.settings.hijackTriggerMode = mode;
      chat.settings.hijackProbability = prob;
      if (window.db && window.db.chats) {
        try { await window.db.chats.put(chat); } catch (e) { console.error('批量保存顶号设置失败:', e); }
      }
    }

    renderHijackCharList(); // 重新渲染，反映刚应用的批量结果
    if (typeof haptic !== 'undefined' && haptic.success) haptic.success();
  });

})();
