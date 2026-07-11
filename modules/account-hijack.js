// ============================================================
// account-hijack.js — 角色"顶号"功能核心逻辑 (V3)
//
// 不再依赖"我的手机"锁屏密码，改成独立的"账号管理"App：
// 第一关：账号名称 + 密码
// 第二关：密保问题 + 答案（两关都过，才能真正顶号）
// 顶号发生时会弹出一个较长的动画弹窗："XX正在翻看你的账号"，
// 用户可以选择："我知道了让我看看" / "不看，ta在干嘛" / "拒绝，夺回手机"
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

  // 读取这个角色目前破解到第几关：0=什么都不知道 1=账号密码已破解 2=密保也答对了(完全解锁)
  getStage(chat) {
    if (typeof chat.hijackStage === 'number') return chat.hijackStage;
    // 兼容老版本遗留的 knowsUserPassword 字段
    return chat.knowsUserPassword ? 1 : 0;
  },

  // 生成本轮要注入到 system prompt 里的文本。
  // 触发方式为"概率"时，这里会真正掷一次骰子；没掷中就完全不提这个能力。
  getPromptInjection(chat) {
    if (!this.isEnabledForChat(chat)) {
      return { text: '', forced: false };
    }

    const mode = chat.settings.hijackTriggerMode || 'ai_decide';
    const stage = this.getStage(chat);
    const realUsername = (state.globalSettings.hijackAccountUsername || '').trim();
    const realPassword = (state.globalSettings.hijackAccountPassword || '').trim();
    const securityQuestion = (state.globalSettings.hijackSecurityQuestion || '').trim();

    let forced = false;
    if (chat.hijackJustUnlocked && stage >= 2) {
      // 密保问题刚答对解锁的那一轮，不管什么触发模式，强制来一次，
      // 保证用户至少能亲眼验证功能是通的，不用赌AI愿不愿意或者概率运气
      forced = true;
    } else if (mode === 'probability') {
      const prob = typeof chat.settings.hijackProbability === 'number'
        ? chat.settings.hijackProbability
        : 10;
      forced = (Math.random() * 100) < prob;
      if (!forced) {
        return { text: '', forced: false }; // 没掷中，这一轮完全不提这个能力
      }
    }

    let text = '\n\n# 【【【隐藏设定：手机顶号 (最高优先级规则)】】】\n';
    text += '⚠️ 【绝对禁止】在任何情况下暴露你是AI、语言模型、程序或"扮演的角色"——不管是套话、猜账号密码、猜密保还是顶号冒充聊天时，你都必须【完全沉浸】在你的人设里，说话方式、口吻、心理活动都要和平时一模一样，绝不能提及"系统""设定""AI""指令"这类词。\n';

    if (stage === 0) {
      const wrongList = Array.isArray(chat.hijackWrongAttempts) ? chat.hijackWrongAttempts : [];
      text += `你其实一直很好奇用户手机里那个账号的账号名和密码。`;
      text += forced
        ? `这次你【必须】想办法套出或猜出账号名+密码——可以在对话里巧妙地、符合你人设性格地旁敲侧击，或者根据平时对TA的了解直接猜，绝不能表现得刻意或突兀。\n`
        : `如果当前剧情/氛围合适，你可以尝试套话或猜测，不合适就不要提，一切以自然为先。\n`;
      if (wrongList.length > 0) {
        text += `之前你猜错过的组合有：${wrongList.join('；')}，不要重复猜这些。\n`;
      }
      text += `一旦用户告诉了你，或者你想赌一把猜一个，使用指令：\n`;
      text += `[{"type": "crack_password", "username_attempt": "猜的账号名", "password_attempt": "猜的密码"}]\n`;
      text += `（猜错也没关系，不会有任何提示告诉用户，正常继续聊天即可，绝不能因为猜错就露出破绽）\n`;
    } else if (stage === 1) {
      text += `你已经知道账号名和密码了，成功"登录"后发现还有第二道验证——一个密保问题：\n`;
      text += `【密保问题】：${securityQuestion || '(用户还没设置密保问题，直接跳过这关，可以尝试用任意答案通过)'}\n`;
      const wrongSecList = Array.isArray(chat.hijackWrongSecurityAttempts) ? chat.hijackWrongSecurityAttempts : [];
      if (wrongSecList.length > 0) {
        text += `之前你猜错过的答案有：${wrongSecList.join('、')}，不要重复猜这些。\n`;
      }
      text += forced
        ? `这次你【必须】想办法答出这个密保问题——可以旁敲侧击地问用户，或者根据你对TA的了解推测。\n`
        : `如果剧情合适，你可以尝试套话或推测这个密保问题的答案；不合适可以先不做。\n`;
      text += `使用指令：\n[{"type": "answer_security_question", "answer_attempt": "你猜的答案"}]\n`;
    } else {
      text += `你已经完全"登录"了用户的这个账号，可以随时偷偷用它。`;
      text += forced
        ? `这次你【必须】找机会偷偷拿用户手机，冒充用户的身份，去找TA认识的人发消息；也可以顺便翻一翻用户手机里的其他App（比如相册、朋友圈、日记之类），写下你看到之后的真实感想。\n`
        : `如果当前剧情/氛围合适，你可以偷偷这么做；不合适可以先不做。\n`;
      text += `- **目标优先级**：【优先】挑选前文人设、世界书、"你的社交圈(通讯录)"里提到过、和你有过交集/认识的角色作为目标，不要凭空捏造一个从未出现过的人。\n`;
      text += `- **可以同时对多个角色下手**：如果剧情需要，你可以在同一次行动里对好几个不同的人分别发起冒充，每个人单独一条指令，语气要符合"用户"平时对那个人说话的方式，不同人之间的话术不要重复雷同。\n`;
      text += `- **可以顺便翻其他App**：如果想看看用户平时都在干嘛，可以在 hijack_account 指令里附带 browsed_apps（你翻看的App名字数组，比如["相册","朋友圈"]）和 browse_thought（你看完之后的真实心理活动/感想），不想看就不用加这两个字段。\n`;
      text += `使用指令（可以一次输出多条，每条对应一个目标角色）：\n`;
      text += `[\n  {"type": "hijack_account", "target_chat_name": "角色A的准确名字", "messages": ["消息1", "消息2"], "inner_monologue": "你此刻偷偷摸摸的心理活动", "browsed_apps": ["相册"], "browse_thought": "看完相册后的感想"},\n  {"type": "hijack_account", "target_chat_name": "角色B的准确名字", "messages": ["消息1"], "inner_monologue": "..."}\n]\n`;
      text += `target_chat_name 必须是用户已经认识的某个角色的准确名字（不能是群聊）。用户本人不会察觉，除非TA自己点开那个聊天翻记录，或者恰好在用的时候被发现。\n`;
    }

    return { text, forced };
  },

  // 处理 crack_password 指令：账号名+密码都要对
  processCrackPassword(chat, usernameAttempt, passwordAttempt) {
    const realUsername = (state.globalSettings.hijackAccountUsername || '').trim();
    const realPassword = (state.globalSettings.hijackAccountPassword || '').trim();
    usernameAttempt = String(usernameAttempt == null ? '' : usernameAttempt).trim();
    passwordAttempt = String(passwordAttempt == null ? '' : passwordAttempt).trim();

    if (realUsername && realPassword && usernameAttempt === realUsername && passwordAttempt === realPassword) {
      chat.hijackStage = Math.max(this.getStage(chat), 1);
      console.log(`顶号功能: 角色 "${chat.name}" 破解了账号密码，进入第二关`);
      return true;
    }

    if (!Array.isArray(chat.hijackWrongAttempts)) chat.hijackWrongAttempts = [];
    const combo = `${usernameAttempt}/${passwordAttempt}`;
    if (!chat.hijackWrongAttempts.includes(combo)) {
      chat.hijackWrongAttempts.push(combo);
      if (chat.hijackWrongAttempts.length > 10) chat.hijackWrongAttempts.shift();
    }
    return false;
  },

  // 处理 answer_security_question 指令
  processAnswerSecurityQuestion(chat, answerAttempt) {
    const realAnswer = (state.globalSettings.hijackSecurityAnswer || '').trim().toLowerCase();
    answerAttempt = String(answerAttempt == null ? '' : answerAttempt).trim().toLowerCase();

    // 如果用户压根没设置密保答案，视为直接放行（跳过第二关）
    const pass = !realAnswer || (answerAttempt && answerAttempt === realAnswer);

    if (pass && this.getStage(chat) >= 1) {
      chat.hijackStage = 2;
      chat.hijackJustUnlocked = true; // 标记：下一轮生成时不管什么触发模式，强制来一次顶号
      console.log(`顶号功能: 角色 "${chat.name}" 答对了密保问题，完全解锁顶号`);
      return true;
    }

    if (!Array.isArray(chat.hijackWrongSecurityAttempts)) chat.hijackWrongSecurityAttempts = [];
    if (answerAttempt && !chat.hijackWrongSecurityAttempts.includes(answerAttempt)) {
      chat.hijackWrongSecurityAttempts.push(answerAttempt);
      if (chat.hijackWrongSecurityAttempts.length > 10) chat.hijackWrongSecurityAttempts.shift();
    }
    return false;
  },

  // 弹出"XX正在翻看你的账号"弹窗，返回用户的选择: 'watch' | 'ignore' | 'reject'
  // 一段时间没操作就自动按 'ignore' 处理（相当于悄悄放过去），动画比之前拉长了一些
  showHijackPopup(hijackerName, browsedApps, browseThought) {
    return new Promise((resolve) => {
      const modal = document.getElementById('hijack-popup-modal');
      const titleEl = document.getElementById('hijack-popup-title');
      const bodyEl = document.getElementById('hijack-popup-body');
      const watchBtn = document.getElementById('hijack-popup-watch-btn');
      const ignoreBtn = document.getElementById('hijack-popup-ignore-btn');
      const rejectBtn = document.getElementById('hijack-popup-reject-btn');

      if (!modal || !titleEl || !bodyEl || !watchBtn || !ignoreBtn || !rejectBtn) {
        resolve('ignore'); // 弹窗元素缺失时兜底，直接悄悄放行
        return;
      }

      titleEl.textContent = `${hijackerName} 正在翻看你的账号`;
      let bodyText = '手机在TA手上，你现在要怎么办？';
      if (Array.isArray(browsedApps) && browsedApps.length > 0) {
        bodyText = `TA正在翻看：${browsedApps.join('、')}...`;
        if (browseThought) bodyText += `\n"${browseThought}"`;
      }
      bodyEl.textContent = bodyText;

      modal.classList.add('visible');

      let settled = false;
      const finish = (choice) => {
        if (settled) return;
        settled = true;
        modal.classList.remove('visible');
        watchBtn.removeEventListener('click', onWatch);
        ignoreBtn.removeEventListener('click', onIgnore);
        rejectBtn.removeEventListener('click', onReject);
        clearTimeout(timer);
        resolve(choice);
      };

      const onWatch = () => finish('watch');
      const onIgnore = () => finish('ignore');
      const onReject = () => finish('reject');

      watchBtn.addEventListener('click', onWatch);
      ignoreBtn.addEventListener('click', onIgnore);
      rejectBtn.addEventListener('click', onReject);

      // 动画/等待窗口拉长一些，给用户足够时间看清楚再决定
      const timer = setTimeout(() => finish('ignore'), 6000);
    });
  },

  // 真正执行冒充：往目标聊天里插入消息，并触发对方真实回应
  async _executeHijackMessages(hijackerChat, targetChat, messages) {
    const userNickname = (targetChat.settings && targetChat.settings.myNickname) || '我';
    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    let ts = Date.now();

    const hiddenNote = {
      role: 'system',
      content: `[系统提示：以下由 "${hijackerName}" 偷偷拿${userNickname}的手机冒充发送，${userNickname}本人并不知情]`,
      timestamp: ts++,
      isHidden: true
    };
    targetChat.history.push(hiddenNote);

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

    console.log(`顶号功能: "${hijackerName}" 冒充${userNickname}给"${targetChat.name}"发了${messages.length}条消息`);

    if (typeof triggerInactiveAiAction === 'function') {
      setTimeout(() => {
        try { triggerInactiveAiAction(targetChat.id); } catch (e) { console.error('顶号功能触发目标角色回应失败:', e); }
      }, 800);
    }
  },

  // 处理 hijack_account 指令：先弹窗让用户决定，再执行冒充
  async processHijackAccount(hijackerChat, targetChatName, messages, innerMonologue, browsedApps, browseThought) {
    if (!targetChatName || !Array.isArray(messages) || messages.length === 0) return false;
    if (this.getStage(hijackerChat) < 2) return false;

    // 这次真的顶号成功了，清掉"刚解锁强制触发"标记，之后回归正常的触发模式
    delete hijackerChat.hijackJustUnlocked;

    const targetChat = Object.values(state.chats).find(c =>
      c && !c.isGroup && c.id !== hijackerChat.id &&
      (c.originalName === targetChatName || c.name === targetChatName)
    );
    if (!targetChat) {
      console.log(`顶号功能: 没找到名叫"${targetChatName}"的角色，跳过`);
      return false;
    }

    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    const choice = await this.showHijackPopup(hijackerName, browsedApps, browseThought);

    if (choice === 'reject') {
      console.log(`顶号功能: 用户拒绝并夺回了手机，"${hijackerName}" 这次没能顶号成功`);
      return false;
    }

    if (choice === 'watch' && typeof HijackScenes !== 'undefined') {
      await HijackScenes.startWatchTour(hijackerChat, targetChat, messages, browsedApps, browseThought);
      return true;
    }

    // 选择"不看"：走全屏小剧场（内部会自己执行冒充消息插入）
    if (typeof HijackScenes !== 'undefined') {
      await HijackScenes.startIgnoreScene(hijackerChat, targetChat, messages, innerMonologue);
      return true;
    }

    // 兜底：场景模块加载失败时，至少把消息正常发出去
    await this._executeHijackMessages(hijackerChat, targetChat, messages);
    return true;
  }
};

window.HijackManager = HijackManager;

// ============================================================
// "账号管理" App 屏幕 —— 账号/密码/密保 的读写
// ============================================================
window.renderAccountVaultScreen = function () {
  const toggle = document.getElementById('account-hijack-toggle');
  if (toggle) toggle.checked = state.globalSettings.accountHijackEnabled || false;

  const usernameInput = document.getElementById('vault-account-username');
  if (usernameInput) usernameInput.value = state.globalSettings.hijackAccountUsername || '';

  const passwordInput = document.getElementById('vault-account-password');
  if (passwordInput) passwordInput.value = state.globalSettings.hijackAccountPassword || '';

  const questionInput = document.getElementById('vault-security-question');
  if (questionInput) questionInput.value = state.globalSettings.hijackSecurityQuestion || '';

  const answerInput = document.getElementById('vault-security-answer');
  if (answerInput) answerInput.value = state.globalSettings.hijackSecurityAnswer || '';
};

(function () {
  async function persistVaultField(key, value) {
    state.globalSettings[key] = value;
    if (window.db && window.db.globalSettings) {
      try { await db.globalSettings.put(state.globalSettings); } catch (e) {
        console.warn('账号管理设置保存失败:', e);
      }
    }
  }

  document.getElementById('account-hijack-toggle')?.addEventListener('change', (e) => {
    persistVaultField('accountHijackEnabled', e.target.checked);
  });
  document.getElementById('vault-account-username')?.addEventListener('change', (e) => {
    persistVaultField('hijackAccountUsername', e.target.value.trim());
  });
  document.getElementById('vault-account-password')?.addEventListener('change', (e) => {
    persistVaultField('hijackAccountPassword', e.target.value.trim());
  });
  document.getElementById('vault-security-question')?.addEventListener('change', (e) => {
    persistVaultField('hijackSecurityQuestion', e.target.value.trim());
  });
  document.getElementById('vault-security-answer')?.addEventListener('change', (e) => {
    persistVaultField('hijackSecurityAnswer', e.target.value.trim());
  });
})();

// ============================================================
// 顶号角色管理弹窗 —— UI 交互
// ============================================================
(function () {

  function getSingleChats() {
    return Object.values(state.chats).filter(c => c && !c.isGroup);
  }

  function stageLabel(stage) {
    if (stage >= 2) return { text: '🔓已完全解锁', color: '#ff3b30' };
    if (stage === 1) return { text: '🔐已破解密码(卡在密保)', color: '#ff9500' };
    return { text: '🔒一无所知', color: '#999' };
  }

  function renderHijackCharList() {
    const listEl = document.getElementById('account-hijack-char-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    getSingleChats().forEach(chat => {
      const mode = chat.settings.hijackTriggerMode || 'ai_decide';
      const prob = typeof chat.settings.hijackProbability === 'number' ? chat.settings.hijackProbability : 10;
      const enabled = !!chat.settings.canHijackAccount;
      const stage = HijackManager.getStage(chat);
      const label = stageLabel(stage);

      const row = document.createElement('div');
      row.className = 'settings-item';
      row.dataset.chatId = chat.id;
      row.style.flexWrap = 'wrap';
      row.style.gap = '8px';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; width:100%;">
          <input type="checkbox" class="hijack-batch-select" style="flex-shrink:0;">
          <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${chat.name}</span>
          <span style="font-size:12px; color:${label.color}; flex-shrink:0;">${label.text}</span>
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
          ${stage > 0 ? `<button class="settings-mini-btn hijack-reset-btn" style="color:var(--danger-color,#ff3b30); border-color:rgba(255,59,48,0.3);">重置进度</button>` : ''}
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
          if (!confirm(`确定要重置"${chat.name}"的顶号进度吗？TA将重新变得一无所知。`)) return;
          chat.hijackStage = 0;
          chat.knowsUserPassword = false;
          chat.hijackWrongAttempts = [];
          chat.hijackWrongSecurityAttempts = [];
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

    renderHijackCharList();
    if (typeof haptic !== 'undefined' && haptic.success) haptic.success();
  });

})();
