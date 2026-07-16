// ============================================================
// theater-app.js — 小剧场 App（不带记忆的角色扮演长文生成）
//
// 完全独立新模块，不修改绿江(green-river.js)任何代码，只是搬运了它的
// 内置文风预设列表 + 字数强控的prompt写法思路。
//
// 数据独立存储：用自己的 Dexie 库 TheaterDB（跟主 db 完全隔离，
// 不需要碰主项目的 db schema version，零冲突风险）。
//
// 角色来源：state.chats 里的单人角色，只取 aiPersona + 关联世界书，不读取
// chat.history / 长期记忆——每次都是全新的、不带记忆的演绎。
// 用户人设来源：db.personaPresets（复用你项目已有的"我的人设库"）或自定义输入。
// 文风来源：内置的著名作家/风格预设（抄自绿江）或用户自定义粘贴。
// ============================================================

(function () {
  // ---------------- 独立数据库 ----------------
  const theaterDB = new Dexie('LiyaTheaterDB');
  theaterDB.version(1).stores({
    stories: '++id, updatedAt'
  });

  // ---------------- 内置文风预设（搬自绿江 DEFAULT_AUTHORS） ----------------
  const STYLE_PRESETS = [
    { name: "细腻情感", style: "侧重心理描写，文笔细腻，擅长捕捉人物间微妙的情感流动，氛围感强。" },
    { name: "正剧剧情", style: "注重剧情逻辑，节奏紧凑，对白干练，擅长推动故事情节发展。" },
    { name: "轻松日常", style: "幽默风趣，轻松愉快，多用生动的对话和有趣的细节描写，治愈系。" },
    { name: "意识流", style: "大量使用隐喻和象征，句式优美复杂，着重于意象和哲学思考，弱化具体情节。" },
    { name: "鲁迅", style: "犀利深刻，善用讽刺和批判，文笔简练有力，揭露社会黑暗面，语言辛辣而富有战斗性。多用短句，节奏明快，常有深刻的社会洞察。" },
    { name: "张爱玲", style: "细腻敏感，擅长描写都市男女的情感纠葛，文字华丽而苍凉，善用比喻和意象，笔触冷静克制，充满人生况味。关注细节，氛围感极强。" },
    { name: "老舍", style: "京味十足，语言生动幽默，善于刻画小人物的悲欢离合，文字朴实而富有生活气息，对话生动传神，充满市井烟火味。" },
    { name: "沈从文", style: "抒情诗意，文字清新隽永，善于描绘湘西风情和人性美好，笔触细腻温婉，充满诗意和画面感，语言优美流畅。" },
    { name: "钱钟书", style: "博学机智，语言幽默讽刺，善用典故和比喻，文字雅致而犀利，充满知识分子的睿智和调侃，叙述风格独特。" },
    { name: "巴金", style: "激情澎湃，文字真挚热烈，关注社会现实和人性挣扎，笔触饱含感情，语言流畅自然，充满理想主义色彩。" },
    { name: "林语堂", style: "幽默雅致，中西合璧，文字闲适自在，善于议论和抒情，语言轻松诙谐，充满生活哲理和人生智慧。" },
    { name: "冰心", style: "清新纯净，文字温婉柔美，善于抒发母爱、童真和自然之美，笔触细腻真挚，语言优美如诗，充满温情。" },
    { name: "余华", style: "冷峻克制，善于描写命运的荒诞和人性的坚韧，文字简洁有力，叙事冷静客观，却能直击人心，充满悲悯情怀。" },
    { name: "莫言", style: "魔幻现实，想象力丰富，文字恣肆汪洋，善于用民间传说和乡土元素，语言浓烈奔放，充满生命力和张力。" }
  ];

  function isGeminiUrl(proxyUrl) { return !!proxyUrl && proxyUrl.includes('generativelanguage.googleapis.com'); }

  async function callTheaterAI(prompt) {
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
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.95 } })
      });
    } else {
      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.95 })
      });
    }
    if (!response.ok) throw new Error(`API请求失败(${response.status})`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const text = isGemini ? data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() : data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('API返回空内容');
    return text;
  }

  // ---------------- 长文生成（字数区间强控） ----------------
  async function generateChapter(story, userDirection) {
    const chats = (story.chatIds || []).map(id => state.chats[id]).filter(Boolean);
    if (chats.length === 0) throw new Error('找不到对应角色，可能被删除了');

    const min = story.minWords || 1500, max = story.maxWords || 3300;
    const targetWordCount = Math.round(min + (max - min) * 0.7);

    // 多角色：每个角色各自的人设 + 各自世界书，合并去重
    let charsContext = '';
    const allWorldBookIds = new Set();
    for (const chat of chats) {
      charsContext += `### 角色: ${chat.name}\n- 人设: ${chat.settings.aiPersona || ''}\n\n`;
      (chat.settings.linkedWorldBookIds || []).forEach(id => allWorldBookIds.add(id));
    }
    (state.worldBooks || []).forEach(wb => { if (wb.isGlobal) allWorldBookIds.add(wb.id); });
    const worldBookText = Array.from(allWorldBookIds).map(id => (state.worldBooks || []).find(wb => wb.id === id)).filter(Boolean)
      .map(book => `- 《${book.name}》: ${(book.content || []).filter(e => e.enabled).map(e => e.content).join('；')}`)
      .join('\n');

    const prevChapters = story.chapters || [];
    const prevSummary = prevChapters.length > 0
      ? prevChapters[prevChapters.length - 1].content.slice(-300)
      : '这是故事的开始。';

    const buildPrompt = (retryNote) => `
# 身份
你现在是【${story.styleName}】。文风特点：${story.styleText}

# 核心任务
以下面${chats.length > 1 ? '这几位角色' : '这个角色'}为主角，续写/演绎这段剧情，只依据【人设 + 世界书】发挥，不需要考虑角色的聊天记忆（这是一个独立的、不带记忆的平行演绎）。${chats.length > 1 ? '多个角色之间要有互动，不要各说各话。' : ''}

# 登场角色设定
${charsContext}
# 世界书设定
${worldBookText || '（无）'}

# "我"（读者/参与者）的设定
${story.userPersonaText || '普通人'}

# 前情提要
${prevSummary}

# 剧情指示 / IF线
${userDirection || '（无特别指示，请顺着前情自然发展）'}

# 【字数要求，最高优先级】
正文字数必须落在 **${min} 到 ${max} 字** 之间，目标写到约 ${targetWordCount} 字左右。
为了达到字数，请：环境/感官细节描写、角色心理活动、动作拆解放慢节奏，但不要注水废话。
${retryNote || ''}

# 输出格式
只返回正文内容本身，不要标题、不要任何解释说明、不要markdown标记。`;

    let content = await callTheaterAI(buildPrompt());
    let len = content.replace(/\s/g, '').length;

    // 超出范围时最多重试一次，避免无限循环烧token
    if (len < min || len > max) {
      const retryNote = len < min
        ? `\n（上次生成只有约${len}字，明显不够，这次必须真正写到${min}字以上）`
        : `\n（上次生成约${len}字，超出上限，这次要精简到${max}字以内，但保留关键情节）`;
      try {
        const retryContent = await callTheaterAI(buildPrompt(retryNote));
        const retryLen = retryContent.replace(/\s/g, '').length;
        if (retryLen >= min - 100 && retryLen <= max + 200) {
          content = retryContent; len = retryLen;
        }
      } catch (e) { console.warn('[小剧场] 重试生成失败，使用第一次结果', e); }
    }

    return { content, length: len, userDirection: userDirection || '', timestamp: Date.now() };
  }

  // ---------------- 样式 ----------------
  function injectStyle() {
    if (document.getElementById('theater-app-style')) return;
    const style = document.createElement('style');
    style.id = 'theater-app-style';
    style.textContent = `
      #theater-app-content { display:flex; flex-direction:column; width:100%; height:100%; background:#000; color:#fff; font-family:inherit; }
      .th-header { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid #2c2c2e; flex-shrink:0; }
      .th-header .th-back { font-size:22px; cursor:pointer; padding:4px 8px; }
      .th-header .th-title { font-size:16px; font-weight:700; flex:1; }
      .th-body { flex:1; overflow-y:auto; padding:14px 16px; }
      .th-story-card { display:flex; align-items:center; justify-content:space-between; background:#1c1c1e; border-radius:14px; padding:14px; margin-bottom:10px; cursor:pointer; }
      .th-story-card .name { font-size:14px; font-weight:600; }
      .th-story-card .meta { font-size:12px; color:#8e8e93; margin-top:4px; }
      .th-add-btn { width:100%; padding:14px; border-radius:14px; border:1px dashed #48484a; background:transparent; color:#8e8e93; font-size:14px; margin-top:6px; }
      .th-form-row { margin-bottom:16px; }
      .th-form-row label { display:block; font-size:13px; color:#8e8e93; margin-bottom:6px; }
      .th-form-row select, .th-form-row input[type="text"], .th-form-row input[type="number"], .th-form-row textarea {
        width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:none; background:#1c1c1e; color:#fff; font-size:14px; font-family:inherit;
      }
      .th-form-row textarea { min-height:80px; resize:vertical; }
      .th-radio-group { display:flex; gap:16px; margin-bottom:8px; font-size:13px; }
      .th-word-range { display:flex; align-items:center; gap:8px; }
      .th-word-range input { width:100%; }
      .th-primary-btn { width:100%; padding:14px; border-radius:14px; border:none; background:#fff; color:#000; font-weight:700; font-size:15px; }
      .th-chapter-block { background:#141414; border-radius:14px; padding:14px; margin-bottom:14px; font-size:14.5px; line-height:1.9; white-space:pre-wrap; }
      .th-chapter-meta { font-size:11px; color:#666; margin-top:8px; text-align:right; }
      .th-direction-bar { padding:10px 12px; border-top:1px solid #2c2c2e; flex-shrink:0; }
      .th-direction-bar textarea { width:100%; box-sizing:border-box; min-height:50px; border:none; border-radius:12px; padding:10px 12px; background:#1c1c1e; color:#fff; font-size:14px; font-family:inherit; resize:none; }
      .th-direction-actions { display:flex; gap:8px; margin-top:8px; }
      .th-direction-actions button { flex:1; border:none; border-radius:12px; padding:11px; font-size:14px; }
      .th-btn-generate { background:#fff; color:#000; font-weight:700; }
      .th-btn-immersive { background:#1c1c1e; color:#fff; }
      .th-btn-generate:disabled { background:#48484a; color:#8e8e93; }
      #theater-immersive-view { position:fixed; inset:0; z-index:9999996; background:#000; color:#eee; overflow-y:auto; padding:40px 22px; font-size:16px; line-height:2.1; white-space:pre-wrap; }
      #theater-immersive-exit { position:fixed; top:16px; right:16px; z-index:9999997; color:#888; font-size:22px; }
      .th-loading { text-align:center; color:#8e8e93; font-size:13px; padding:30px 0; }
    `;
    document.head.appendChild(style);
  }

  // ---------------- 导航状态 ----------------
  let currentStory = null;
  function content() { return document.getElementById('theater-app-content'); }

  async function renderStoryList() {
    const stories = await theaterDB.stories.orderBy('updatedAt').reverse().toArray();
    content().innerHTML = `
      <div class="th-header"><span class="th-back" id="th-close-btn">✕</span><span class="th-title">小剧场</span></div>
      <div class="th-body">
        ${stories.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:40px 0;">还没有任何剧场，新建一个开始吧</div>` : ''}
        ${stories.map(s => {
          const names = (s.chatIds || []).map(id => state.chats[id]?.name).filter(Boolean);
          const wordTotal = (s.chapters || []).reduce((a, c) => a + (c.length || 0), 0);
          return `<div class="th-story-card" data-id="${s.id}">
            <div><div class="name">${names.length > 0 ? names.join('、') : '(角色已删除)'}</div><div class="meta">${s.styleName} · ${(s.chapters || []).length}章 · 共${wordTotal}字</div></div>
            <span style="color:#8e8e93;">›</span>
          </div>`;
        }).join('')}
        <button class="th-add-btn" id="th-new-story-btn">＋ 新建小剧场</button>
      </div>
    `;
    document.getElementById('th-close-btn').addEventListener('click', () => showScreen('home-screen'));
    document.getElementById('th-new-story-btn').addEventListener('click', renderNewStoryForm);
    content().querySelectorAll('.th-story-card[data-id]').forEach(el => {
      el.addEventListener('click', async () => {
        currentStory = await theaterDB.stories.get(parseInt(el.dataset.id, 10));
        renderWritingScreen();
      });
    });
  }

  async function renderNewStoryForm() {
    const eligibleChats = Object.values(state.chats).filter(c => c && !c.isGroup);
    const personaPresets = state.personaPresets || (await db.personaPresets.toArray());

    content().innerHTML = `
      <div class="th-header"><span class="th-back" id="th-back-list">‹</span><span class="th-title">新建小剧场</span></div>
      <div class="th-body">
        <div class="th-form-row">
          <label>选择角色（只用人设+世界书，不带聊天记忆；可以只选一个，也可以多选一起演）</label>
          <div id="th-char-checklist" style="max-height:180px; overflow-y:auto; background:#1c1c1e; border-radius:10px; padding:6px 4px;">
            ${eligibleChats.length === 0 ? '<div style="color:#8e8e93; font-size:13px; padding:10px;">还没有角色</div>' : eligibleChats.map(c => `
              <label style="display:flex; align-items:center; gap:10px; padding:9px 10px; font-size:14px;">
                <input type="checkbox" class="th-char-checkbox" value="${c.id}">
                <span>${c.name}</span>
              </label>
            `).join('')}
          </div>
        </div>

        <div class="th-form-row">
          <label>"我"的人设</label>
          <div class="th-radio-group">
            <label><input type="radio" name="th-persona-mode" value="preset" checked> 从预设库选</label>
            <label><input type="radio" name="th-persona-mode" value="custom"> 自己写</label>
          </div>
          <select id="th-persona-select">
            ${personaPresets.length === 0 ? '<option value="">（人设库是空的）</option>' : personaPresets.map(p => `<option value="${p.id}">${(p.persona || '').slice(0, 24)}...</option>`).join('')}
          </select>
          <textarea id="th-persona-custom" placeholder="自己写一段人设..." style="display:none; margin-top:8px;"></textarea>
        </div>

        <div class="th-form-row">
          <label>文风</label>
          <div class="th-radio-group">
            <label><input type="radio" name="th-style-mode" value="preset" checked> 内置文风</label>
            <label><input type="radio" name="th-style-mode" value="custom"> 自定义文风</label>
          </div>
          <select id="th-style-select">
            ${STYLE_PRESETS.map((s, i) => `<option value="${i}">${s.name}</option>`).join('')}
          </select>
          <textarea id="th-style-custom" placeholder="粘贴一段参考文风的文字，或直接描述文风特点..." style="display:none; margin-top:8px;"></textarea>
        </div>

        <div class="th-form-row">
          <label>字数范围</label>
          <div class="th-word-range">
            <input type="number" id="th-min-words" value="1500" min="200" step="100"> —
            <input type="number" id="th-max-words" value="3300" min="200" step="100">
            <span style="font-size:13px; color:#8e8e93;">字</span>
          </div>
        </div>

        <button class="th-primary-btn" id="th-create-btn">创建</button>
      </div>
    `;
    document.getElementById('th-back-list').addEventListener('click', renderStoryList);

    document.querySelectorAll('input[name="th-persona-mode"]').forEach(r => r.addEventListener('change', () => {
      const isCustom = document.querySelector('input[name="th-persona-mode"]:checked').value === 'custom';
      document.getElementById('th-persona-select').style.display = isCustom ? 'none' : '';
      document.getElementById('th-persona-custom').style.display = isCustom ? '' : 'none';
    }));
    document.querySelectorAll('input[name="th-style-mode"]').forEach(r => r.addEventListener('change', () => {
      const isCustom = document.querySelector('input[name="th-style-mode"]:checked').value === 'custom';
      document.getElementById('th-style-select').style.display = isCustom ? 'none' : '';
      document.getElementById('th-style-custom').style.display = isCustom ? '' : 'none';
    }));

    document.getElementById('th-create-btn').addEventListener('click', async () => {
      const chatIds = Array.from(document.querySelectorAll('.th-char-checkbox:checked')).map(el => el.value);
      if (chatIds.length === 0) { alert('至少选一个角色吧'); return; }

      const personaMode = document.querySelector('input[name="th-persona-mode"]:checked').value;
      const userPersonaText = personaMode === 'custom'
        ? document.getElementById('th-persona-custom').value.trim()
        : (personaPresets.find(p => String(p.id) === document.getElementById('th-persona-select').value)?.persona || '');

      const styleMode = document.querySelector('input[name="th-style-mode"]:checked').value;
      let styleName, styleText;
      if (styleMode === 'custom') {
        styleName = '自定义文风';
        styleText = document.getElementById('th-style-custom').value.trim();
        if (!styleText) { alert('自定义文风不能是空的'); return; }
      } else {
        const preset = STYLE_PRESETS[parseInt(document.getElementById('th-style-select').value, 10)];
        styleName = preset.name; styleText = preset.style;
      }

      const minWords = parseInt(document.getElementById('th-min-words').value, 10) || 1500;
      const maxWords = parseInt(document.getElementById('th-max-words').value, 10) || 3300;
      if (minWords >= maxWords) { alert('最小字数要小于最大字数'); return; }

      const newStory = { chatIds, userPersonaText, styleName, styleText, minWords, maxWords, chapters: [], updatedAt: Date.now() };
      const id = await theaterDB.stories.add(newStory);
      currentStory = { ...newStory, id };
      renderWritingScreen();
    });
  }

  function renderWritingScreen() {
    const names = (currentStory.chatIds || []).map(id => state.chats[id]?.name).filter(Boolean);
    content().innerHTML = `
      <div class="th-header"><span class="th-back" id="th-back-list2">‹</span><span class="th-title">${names.join('、') || '未知角色'} · ${currentStory.styleName}</span></div>
      <div class="th-body" id="th-chapters">
        ${(currentStory.chapters || []).map(ch => `
          <div class="th-chapter-block">${ch.content}<div class="th-chapter-meta">${ch.length}字${ch.userDirection ? ' · 指示: ' + ch.userDirection : ''}</div></div>
        `).join('') || `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:30px 0;">还没有正文，在下面输入剧情指示，点生成开始吧</div>`}
      </div>
      <div class="th-direction-bar">
        <textarea id="th-direction-input" placeholder="输入if线/剧情指令，留空则自然发展..."></textarea>
        <div class="th-direction-actions">
          <button class="th-btn-generate" id="th-generate-btn">✨ 生成</button>
          <button class="th-btn-immersive" id="th-immersive-btn">📖 沉浸阅读</button>
        </div>
      </div>
    `;
    document.getElementById('th-back-list2').addEventListener('click', renderStoryList);
    const chaptersEl = document.getElementById('th-chapters');
    chaptersEl.scrollTop = chaptersEl.scrollHeight;

    document.getElementById('th-generate-btn').addEventListener('click', doGenerate);
    document.getElementById('th-immersive-btn').addEventListener('click', enterImmersiveMode);
  }

  async function doGenerate() {
    const btn = document.getElementById('th-generate-btn');
    const direction = document.getElementById('th-direction-input').value.trim();
    btn.disabled = true;
    btn.textContent = '撰写中...';

    try {
      const chapter = await generateChapter(currentStory, direction);
      if (!currentStory.chapters) currentStory.chapters = [];
      currentStory.chapters.push(chapter);
      currentStory.updatedAt = Date.now();
      await theaterDB.stories.put(currentStory);
      renderWritingScreen();
    } catch (e) {
      console.error('[小剧场] 生成失败', e);
      alert('生成失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '✨ 生成';
    }
  }

  function enterImmersiveMode() {
    const fullText = (currentStory.chapters || []).map(c => c.content).join('\n\n———\n\n');
    const view = document.createElement('div');
    view.id = 'theater-immersive-view';
    view.innerHTML = `<div id="theater-immersive-exit">✕</div>${fullText || '（还没有正文）'}`;
    document.body.appendChild(view);
    view.querySelector('#theater-immersive-exit').addEventListener('click', () => view.remove());
  }

  // ---------------- 初始化 ----------------
  function init() {
    injectStyle();

    if (!window.__theaterShowScreenHooked) {
      window.__theaterShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === 'function') {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === 'theater-app-screen') renderStoryList();
        };
      }
    }
    console.log('[小剧场] 初始化完成');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.db && typeof window.showScreen === 'function' && typeof Dexie !== 'undefined') {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[小剧场] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
