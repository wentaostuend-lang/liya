// ============================================================
// hijack-scenes.js — 顶号功能的两套沉浸式子场景
//
// 1. 「让我看看」→ 真实跳转到被翻看的App页面，顶部悬浮一条状态栏
//    （REC · 账号 · 自动翻看 x/y · 最小化/暂停/踢出），每到一处会弹出
//    一个小对话气泡装角色的反应，并给用户两个快捷回应按钮。
//
// 2. 「不看，ta在干嘛」→ 全屏小剧场：前两轮台词+选项是一次性预生成好的
//    （只调一次API拿到完整脚本），最后一轮是用户自己打字，实时调API
//    生成角色的真实回应，然后结束场景。
// ============================================================

const HijackScenes = {

  // ---------- 通用：调主API拿一段纯文本/JSON回复 ----------
  async _callMainApi(systemPrompt, userText) {
    const cfg = state.apiConfig;
    if (!cfg || !cfg.proxyUrl || !cfg.apiKey || !cfg.model) {
      throw new Error('主API未配置完整');
    }
    const isGemini = cfg.proxyUrl.includes('generativelanguage');
    let response;
    if (isGemini) {
      const payload = {
        contents: [{ parts: [{ text: `${systemPrompt}\n\n${userText || ''}` }] }]
      };
      response = await fetch(`${cfg.proxyUrl}/${cfg.model}:generateContent?key=${cfg.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      const payload = {
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText || '（继续）' }
        ],
        max_tokens: 800
      };
      response = await fetch(`${cfg.proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(payload)
      });
    }
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(`主API错误: ${err.error ? err.error.message : response.statusText}`);
    }
    const data = await response.json();
    return isGemini ? getGeminiResponseText(data) : data.choices[0].message.content;
  },

  // ============================================================
  // 「不看」小剧场
  // ============================================================
  async startIgnoreScene(hijackerChat, targetChat, messages, innerMonologue) {
    const modal = document.getElementById('hijack-scene-modal');
    const avatarEl = document.getElementById('hijack-scene-avatar');
    const nameEl = document.getElementById('hijack-scene-name');
    const progressEl = document.getElementById('hijack-scene-progress');
    const narrationEl = document.getElementById('hijack-scene-narration');
    const choicesEl = document.getElementById('hijack-scene-choices');
    const finalInputArea = document.getElementById('hijack-scene-final-input-area');
    const finalInput = document.getElementById('hijack-scene-final-input');
    const finalSendBtn = document.getElementById('hijack-scene-final-send-btn');
    const leaveBtn = document.getElementById('hijack-scene-leave-btn');

    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    nameEl.textContent = hijackerName;
    avatarEl.textContent = hijackerName.slice(0, 1);
    if (hijackerChat.settings && hijackerChat.settings.aiAvatar) {
      avatarEl.style.backgroundImage = `url("${hijackerChat.settings.aiAvatar}")`;
      avatarEl.textContent = '';
    }

    modal.classList.add('visible');
    progressEl.textContent = '';
    narrationEl.textContent = '正在组织语言...';
    choicesEl.innerHTML = '';
    finalInputArea.style.display = 'none';

    // 先真正执行冒充（用户此刻选择了不看，但事情已经发生了）
    await HijackManager._executeHijackMessages(hijackerChat, targetChat, messages);

    // 一次性预生成前面几轮的完整脚本
    let script;
    try {
      const sysPrompt = `你正在为角色"${hijackerName}"生成一段"被发现偷偷用了用户手机"之后的道歉/撒娇小剧场脚本。
背景：TA刚刚偷偷拿用户手机冒充用户身份，给别人发了消息：${JSON.stringify(messages)}。
TA当时的心理活动：${innerMonologue || '（无）'}
现在被用户发现了。请生成3轮对话，每轮包含：一句TA对用户说的话(question)，两个用户可选的回应(option_a偏强硬/option_b偏心软)，以及TA针对这两种回应分别的反应(response_a/response_b)。
语气要符合角色人设，可以撒娇、认错、找补，逐轮情绪从慌张到放松。
只返回JSON，不要任何多余文字：
{"rounds":[{"question":"...","option_a":"...","option_b":"...","response_a":"...","response_b":"..."},...]}`;

      const raw = await this._callMainApi(sysPrompt, '请生成');
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      script = JSON.parse(cleaned).rounds;
    } catch (e) {
      console.error('生成不看小剧场脚本失败:', e);
      script = [
        { question: '呜……对不起，我不该偷偷用你手机的……', option_a: '气还没消', option_b: '不气了', response_a: '呜呜对不起我以后再也不敢了……', response_b: '真的吗谢谢你原谅我！' },
        { question: '那我以后什么都听你的，你能原谅我吗？', option_a: '看你表现', option_b: '行吧原谅你了', response_a: '好，我会证明给你看的！', response_b: '谢谢你！我最好了！' },
        { question: '那……我们和好了吗？', option_a: '嗯，和好了', option_b: '再看看吧', response_a: '太好了！抱一个！', response_b: '好……那我等你消气。' }
      ];
    }

    for (let i = 0; i < script.length; i++) {
      const round = script[i];
      progressEl.textContent = `第 ${i + 1} / ${script.length + 1} 题`;
      await this._typeNarration(narrationEl, round.question);
      const choice = await this._showChoices(choicesEl, round.option_a, round.option_b);
      const resp = choice === 'a' ? round.response_a : round.response_b;
      choicesEl.innerHTML = '';
      await this._typeNarration(narrationEl, resp);
      await this._waitForTap(narrationEl);
    }

    // 最后一轮：用户自己打字，实时调用API
    progressEl.textContent = `第 ${script.length + 1} / ${script.length + 1} 题`;
    narrationEl.textContent = '（TA看着你，等你说点什么）';
    finalInputArea.style.display = 'flex';
    finalInput.value = '';
    finalInput.focus();

    const finalReply = await new Promise((resolve) => {
      const onSend = async () => {
        const userText = finalInput.value.trim();
        if (!userText) return;
        finalSendBtn.disabled = true;
        finalInputArea.style.display = 'none';
        narrationEl.textContent = '（TA正在想怎么回你……）';
        try {
          const sysPrompt2 = `你正在扮演角色"${hijackerName}"，你刚刚偷偷冒充用户身份给别人发了消息，被用户当场发现。经过一番道歉，用户现在对你说："${userText}"。请以这个角色的口吻，给出一句自然的真实回应（不超过60字），完全沉浸在人设里，不要暴露AI身份。只返回这句回应文本，不要任何多余内容。`;
          const reply = await HijackScenes._callMainApi(sysPrompt2, userText);
          resolve(reply.trim());
        } catch (e) {
          console.error('生成最终回应失败:', e);
          resolve('（TA似乎有点不知所措，只是紧紧抱住了你）');
        }
      };
      finalSendBtn.addEventListener('click', onSend, { once: true });
    });

    await this._typeNarration(narrationEl, finalReply);
    await this._waitForTap(narrationEl);

    modal.classList.remove('visible');

    // 把这段"被抓包+道歉"的经过写进顶号角色自己的心声
    hijackerChat.heartfeltVoice = `（被抓到偷偷用手机了……${finalReply}）`;
    if (!Array.isArray(hijackerChat.thoughtsHistory)) hijackerChat.thoughtsHistory = [];
    hijackerChat.thoughtsHistory.push({ heartfeltVoice: hijackerChat.heartfeltVoice, timestamp: Date.now() });
    if (window.db && window.db.chats) {
      try { await db.chats.put(hijackerChat); } catch (e) { console.error(e); }
    }
  },

  // 打字机效果显示一段文字
  _typeNarration(el, text) {
    return new Promise((resolve) => {
      el.textContent = '';
      let i = 0;
      const timer = setInterval(() => {
        el.textContent += text[i] || '';
        i++;
        if (i >= text.length) {
          clearInterval(timer);
          resolve();
        }
      }, 35);
    });
  },

  // 显示两个选项按钮，返回 'a' | 'b'
  _showChoices(choicesEl, optionA, optionB) {
    return new Promise((resolve) => {
      choicesEl.innerHTML = `
        <button class="hijack-scene-choice-btn" data-choice="a">${optionA}</button>
        <button class="hijack-scene-choice-btn" data-choice="b">${optionB}</button>
      `;
      choicesEl.querySelectorAll('.hijack-scene-choice-btn').forEach(btn => {
        btn.addEventListener('click', () => resolve(btn.dataset.choice), { once: true });
      });
    });
  },

  // 等用户点一下屏幕继续
  _waitForTap(el) {
    return new Promise((resolve) => {
      const handler = () => {
        el.removeEventListener('click', handler);
        resolve();
      };
      el.addEventListener('click', handler);
    });
  },

  // ============================================================
  // 「让我看看」实时翻看模式
  // ============================================================

  // 为翻看途中的某一站生成一句符合人设的即时反应/心理活动
  async _generateStopReaction(hijackerChat, stop) {
    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    try {
      const sysPrompt = stop.type === 'chat'
        ? `你正在扮演角色"${hijackerName}"，你正偷偷拿着用户的手机，此刻正准备冒充用户身份给"${stop.name}"发消息。请用一句话(不超过25字)说出你此刻心里的真实想法，符合你的人设语气，完全沉浸在角色里，不要暴露AI身份。只返回这句话，不要引号，不要任何多余内容。`
        : `你正在扮演角色"${hijackerName}"，你正偷偷拿着用户的手机，此刻正在翻看用户的"${stop.name}"。请用一句话(不超过25字)说出你此刻心里看到内容后的真实反应/想法，符合你的人设语气，完全沉浸在角色里，不要暴露AI身份。只返回这句话，不要引号，不要任何多余内容。`;
      const raw = await this._callMainApi(sysPrompt, '请生成');
      return raw.trim().replace(/^["「『]|["」』]$/g, '');
    } catch (e) {
      console.error('生成翻看反应失败:', e);
      return stop.type === 'chat' ? `（正在给"${stop.name}"发消息……）` : `（正在看你的${stop.name}……）`;
    }
  },

  async startWatchTour(hijackerChat, targetChat, messages, browsedApps, browseThought) {
    const APP_SCREEN_MAP = {
      '相册': 'album-screen',
      '朋友圈': 'x-social-screen',
      '豆瓣': 'douban-screen'
    };

    const stops = [];
    (Array.isArray(browsedApps) ? browsedApps : []).forEach(appName => {
      if (APP_SCREEN_MAP[appName]) {
        stops.push({ type: 'app', name: appName, screen: APP_SCREEN_MAP[appName] });
      }
    });
    stops.push({ type: 'chat', name: targetChat.name, screen: 'chat-interface-screen' });

    const topbar = document.getElementById('hijack-watch-topbar');
    const progressText = document.getElementById('hijack-watch-progress');
    const nameText = document.getElementById('hijack-watch-account-name');
    const bubble = document.getElementById('hijack-watch-bubble');
    const pauseBtn = document.getElementById('hijack-watch-pause-btn');
    const kickBtn = document.getElementById('hijack-watch-kick-btn');
    const minimizeBtn = document.getElementById('hijack-watch-minimize-btn');
    const backBtn = document.getElementById('hijack-watch-back-btn');

    const hijackerName = hijackerChat.originalName || hijackerChat.name;
    const userNickname = (targetChat.settings && targetChat.settings.myNickname) || '我';
    nameText.textContent = `${userNickname}·${hijackerName} 在操作`;
    topbar.classList.add('visible');
    topbar.classList.remove('minimized');

    let paused = false;
    let kicked = false;
    const onPause = () => {
      paused = !paused;
      pauseBtn.textContent = paused ? '继续' : '暂停';
    };
    const onKick = () => { kicked = true; };
    const onMinimize = () => { topbar.classList.toggle('minimized'); };

    pauseBtn.addEventListener('click', onPause);
    kickBtn.addEventListener('click', onKick);
    minimizeBtn.addEventListener('click', onMinimize);
    backBtn.addEventListener('click', onMinimize);

    const wait = (ms) => new Promise((resolve) => {
      const check = () => {
        if (kicked) { resolve(); return; }
        if (paused) { setTimeout(check, 200); return; }
        setTimeout(resolve, ms);
      };
      check();
    });

    for (let i = 0; i < stops.length; i++) {
      if (kicked) break;
      const stop = stops[i];
      progressText.textContent = `自动翻看 ${i + 1}/${stops.length}`;

      if (typeof showScreen === 'function') showScreen(stop.screen);
      if (stop.type === 'chat') {
        state.activeChatId = targetChat.id;
        if (typeof renderChatInterface === 'function') renderChatInterface(targetChat.id);
        await HijackManager._executeHijackMessages(hijackerChat, targetChat, messages);
      }

      bubble.textContent = '（想着……）';
      bubble.classList.add('visible');

      const reaction = await this._generateStopReaction(hijackerChat, stop);
      if (kicked) break;
      bubble.textContent = reaction;

      await wait(3200);
      bubble.classList.remove('visible');
    }

    topbar.classList.remove('visible');
    pauseBtn.removeEventListener('click', onPause);
    kickBtn.removeEventListener('click', onKick);
    minimizeBtn.removeEventListener('click', onMinimize);
    backBtn.removeEventListener('click', onMinimize);

    // 记录这次翻看的心声
    if (browseThought) {
      hijackerChat.heartfeltVoice = `（被你看到我翻手机了……${browseThought}）`;
      if (!Array.isArray(hijackerChat.thoughtsHistory)) hijackerChat.thoughtsHistory = [];
      hijackerChat.thoughtsHistory.push({ heartfeltVoice: hijackerChat.heartfeltVoice, timestamp: Date.now() });
      if (window.db && window.db.chats) {
        try { await db.chats.put(hijackerChat); } catch (e) { console.error(e); }
      }
    }
  }
};

window.HijackScenes = HijackScenes;
