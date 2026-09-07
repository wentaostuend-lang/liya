// ========================================
// 绿江 (Green River) 同人创作模块 —— 已从 xinyuan 更新至新版
// 合并自: authors-and-library.js + story-settings-and-reader.js + story-generation.js + chapters-and-export.js
// ========================================

// ========================================
// 绿江 (Green River) 同人创作模块
// 来源: script.js 第 62277 ~ 64166 行
// 包含: grState, DEFAULT_AUTHORS, initGreenRiverData, openGreenRiverScreen,
//       renderBookList, openAuthorManager, openAuthorEditor, saveAuthor,
//       deleteAuthor, addAuthor, createNewStory, openStorySettings,
//       loadStorySettingsUI, saveStorySettings, openReader, handleGenerateStoryContent,
//       openChapterList, closeChapterList, renderChapterList, deleteSelectedChapters,
//       calculateNextUpdateTime, checkAutoUpdate, autoGenerateChapter,
//       checkAllStoriesForAutoUpdate, startAutoUpdateTimer, stopAutoUpdateTimer
// ========================================

  // ==========================================
  // ▼▼▼ 绿江 (Green River) 同人创作模块 ▼▼▼
  // ==========================================

  let grState = {
    activeStoryId: null,
    isGenerating: false,
    currentReaderChapter: null,
    readingOnly: false
  };

  // 默认作者预设
  const DEFAULT_AUTHORS = [
    { name: "细腻情感", style: "侧重心理描写，文笔细腻，擅长捕捉人物间微妙的情感流动，氛围感强。", maxOutput: 600 },
    { name: "正剧剧情", style: "注重剧情逻辑，节奏紧凑，对白干练，擅长推动故事情节发展。", maxOutput: 800 },
    { name: "轻松日常", style: "幽默风趣，轻松愉快，多用生动的对话和有趣的细节描写，治愈系。", maxOutput: 500 },
    { name: "意识流", style: "大量使用隐喻和象征，句式优美复杂，着重于意象和哲学思考，弱化具体情节。", maxOutput: 400 },

    // 著名作家文风
    { name: "鲁迅", style: "犀利深刻，善用讽刺和批判，文笔简练有力，揭露社会黑暗面，语言辛辣而富有战斗性。多用短句，节奏明快，常有深刻的社会洞察。", maxOutput: 600 },
    { name: "张爱玲", style: "细腻敏感，擅长描写都市男女的情感纠葛，文字华丽而苍凉，善用比喻和意象，笔触冷静克制，充满人生况味。关注细节，氛围感极强。", maxOutput: 700 },
    { name: "老舍", style: "京味十足，语言生动幽默，善于刻画小人物的悲欢离合，文字朴实而富有生活气息，对话生动传神，充满市井烟火味。", maxOutput: 650 },
    { name: "沈从文", style: "抒情诗意，文字清新隽永，善于描绘湘西风情和人性美好，笔触细腻温婉，充满诗意和画面感，语言优美流畅。", maxOutput: 600 },
    { name: "钱钟书", style: "博学机智，语言幽默讽刺，善用典故和比喻，文字雅致而犀利，充满知识分子的睿智和调侃，叙述风格独特。", maxOutput: 700 },
    { name: "巴金", style: "激情澎湃，文字真挚热烈，关注社会现实和人性挣扎，笔触饱含感情，语言流畅自然，充满理想主义色彩。", maxOutput: 650 },
    { name: "林语堂", style: "幽默雅致，中西合璧，文字闲适自在，善于议论和抒情，语言轻松诙谐，充满生活哲理和人生智慧。", maxOutput: 600 },
    { name: "冰心", style: "清新纯净，文字温婉柔美，善于抒发母爱、童真和自然之美，笔触细腻真挚，语言优美如诗，充满温情。", maxOutput: 500 },
    { name: "余华", style: "冷峻克制，善于描写命运的荒诞和人性的坚韧，文字简洁有力，叙事冷静客观，却能直击人心，充满悲悯情怀。", maxOutput: 650 },
    { name: "莫言", style: "魔幻现实，想象力丰富，文字恣肆汪洋，善于用民间传说和乡土元素，语言浓烈奔放，充满生命力和张力。", maxOutput: 800 }
  ];

  // 1. 初始化数据 (在 openGreenRiverScreen 时调用)
  async function initGreenRiverData() {
    const count = await db.grAuthors.count();
    if (count === 0) {
      await db.grAuthors.bulkAdd(DEFAULT_AUTHORS);
    }
  }

  // 2. 打开主界面
  async function openGreenRiverScreen() {
    await initGreenRiverData();
    showScreen('green-river-screen');
    const search = document.getElementById('gr-library-search');
    if (search) {
      search.value = '';
      search.oninput = () => renderBookList(search.value);
    }
    renderBookList();
  }

  // 3. 渲染书架
  // 找到 renderBookList 函数，替换整个函数
  async function renderBookList(searchTerm = '') {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    const listEl = document.getElementById('gr-book-list');
    listEl.innerHTML = '';

    const allStories = await db.grStories.toArray();
    const stories = allStories.filter(story => {
      const bible = Object.assign({}, window.GreenRiverStoryEngine?.DEFAULT_STORY_BIBLE || {}, story.storyBible || {});
      const haystack = [story.title, bible.genre, ...(bible.tags || [])].join(' ').toLowerCase();
      return !searchTerm || haystack.includes(String(searchTerm).trim().toLowerCase());
    }).sort((a, b) => {
      const aTime = a.lastUpdated || 0;
      const bTime = b.lastUpdated || 0;
      return bTime - aTime;
    });
    const authors = await db.grAuthors.toArray();
    const authorMap = new Map(authors.map(a => [a.id, a.name]));

    // 获取已关联的书籍ID集合
    const existingBooks = await db.readingLibrary.toArray();
    const linkedIds = new Set(existingBooks.map(b => b.linkedStoryId).filter(id => id));

    if (stories.length === 0) {
      listEl.innerHTML = `<p style="grid-column:1/-1; text-align:center; color:var(--gr-text-sub); margin-top:50px;">${searchTerm ? '没有找到匹配的作品。' : '书架是空的，点击右上角新建一部作品吧。'}</p>`;
      return;
    }

    stories.forEach(story => {
      const authorName = authorMap.get(story.authorId) || '未知作者';
      const div = document.createElement('div');
      div.className = 'gr-book-card';

      const wordCount = story.chapters.reduce((acc, ch) => acc + (ch.content || '').length, 0);
      const bible = Object.assign({}, window.GreenRiverStoryEngine?.DEFAULT_STORY_BIBLE || {}, story.storyBible || {});
      const tags = (bible.tags || []).slice(0, 3);

      // 【核心逻辑修改】
      const isAdded = linkedIds.has(story.id);
      // 如果已加入，显示"已在书架"，点击触发移除；否则显示"加入"，点击触发加入
      const btnText = isAdded ? '已在书架' : '加入共读';
      const btnClass = isAdded ? 'gr-add-shelf-btn added' : 'gr-add-shelf-btn';
      const actionFn = isAdded ? 'removeGreenRiverFromShelf' : 'addGreenRiverToShelf';

      div.innerHTML = `
            <div>
                <div class="gr-book-title">${escapeHtml(story.title)}</div>
                ${bible.synopsis ? `<div class="gr-book-synopsis">${escapeHtml(bible.synopsis)}</div>` : ''}
                <div class="gr-book-meta">
                    <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    ${escapeHtml(authorName)}
                    <span class="gr-book-status">${escapeHtml(bible.status || '连载中')}</span>
                </div>
                ${tags.length ? `<div class="gr-book-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="gr-book-meta" style="justify-content: space-between; margin-top:15px; align-items: flex-end;">
                <div style="display:flex; flex-direction:column; gap:2px;">
                    <span>${story.chapters.length} 章</span>
                    <span>${(wordCount / 1000).toFixed(1)}k 字</span>
                </div>
                <button class="${btnClass}" onclick="event.stopPropagation(); ${actionFn}(${story.id}, this);">
                    ${isAdded ? '✓ ' : '+ '}${btnText}
                </button>
            </div>
        `;

      div.onclick = (e) => {
        if (e.target.tagName !== 'BUTTON') openReader(story.id);
      };

      addLongPressListener(div, async () => {
        if (confirm(`确定要删除作品《${story.title}》吗？`)) {
          await db.grStories.delete(story.id);
          renderBookList();
        }
      });

      listEl.appendChild(div);
    });
  }

  // 4. 作者管理
  // --- 绿江作者管理重构 (修复布局和编辑功能) ---

  let editingAuthorId = null; // 用于记录当前正在编辑的作者ID

  // 1. 打开作者管理列表 (渲染界面)
  async function openAuthorManager() {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    showScreen('gr-author-screen');
    const listEl = document.getElementById('gr-author-list');
    listEl.innerHTML = '';

    const authors = await db.grAuthors.toArray();

    if (authors.length === 0) {
      listEl.innerHTML = '<p style="text-align:center; color:#999; margin-top:50px;">还没有设定作者，点击右上角"+"添加。</p>';
      return;
    }

    authors.forEach(author => {
      const div = document.createElement('div');
      div.className = 'gr-author-item';
      div.innerHTML = `
            <div class="gr-author-info" style="flex-grow: 1; padding-right: 10px; min-width: 0;">
                <h3 style="margin: 0 0 5px 0; font-size: 16px; font-weight: 600; color: #1C1C1E;">${escapeHtml(author.name)}</h3>
                <p style="margin: 0; font-size: 13px; color: #8E8E93; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5;">${escapeHtml(author.style)}</p>
            </div>
            <div class="gr-author-actions">
                <button class="gr-icon-btn" onclick="openAuthorEditor(${author.id})" title="编辑">
                   <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                </button>
                <button class="gr-icon-btn" style="color:#ff3b30;" onclick="deleteAuthor(${author.id})" title="删除">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
            </div>
        `;
      listEl.appendChild(div);
    });
  }

  // 2. 打开编辑/添加弹窗
  // 如果传入 id，则是编辑模式；否则是添加模式
  async function openAuthorEditor(id = null) {
    editingAuthorId = id;
    const modal = document.getElementById('gr-author-editor-modal');
    const titleEl = document.getElementById('gr-author-editor-title');
    const nameInput = document.getElementById('gr-author-name-input');
    const styleInput = document.getElementById('gr-author-style-input');

    if (id) {
      // 编辑模式：回显数据
      const author = await db.grAuthors.get(id);
      if (author) {
        titleEl.textContent = "编辑作者";
        nameInput.value = author.name;
        styleInput.value = author.style;
      }
    } else {
      // 添加模式：清空数据
      titleEl.textContent = "添加作者";
      nameInput.value = "";
      styleInput.value = "";
    }

    modal.classList.add('visible');
  }

  // 3. 保存作者 (由弹窗内的保存按钮调用)
  async function saveAuthor() {
    const name = document.getElementById('gr-author-name-input').value.trim();
    const style = document.getElementById('gr-author-style-input').value.trim();

    if (!name || !style) {
      alert("名称和风格描述都不能为空！");
      return;
    }

    if (editingAuthorId) {
      // 更新
      await db.grAuthors.update(editingAuthorId, { name, style });
    } else {
      // 新增
      await db.grAuthors.add({ name, style, maxOutput: 600 });
    }

    // 关闭弹窗并刷新列表
    document.getElementById('gr-author-editor-modal').classList.remove('visible');
    openAuthorManager();
  }

  // 4. 删除作者
  async function deleteAuthor(id) {
    const confirmed = await showCustomConfirm("确认删除", "确定删除这位作者设定吗？\n(这不会影响已生成的章节内容)", { confirmButtonClass: 'btn-danger' });
    if (confirmed) {
      await db.grAuthors.delete(id);
      openAuthorManager();
    }
  }

  // 5. 绑定头部"+"按钮到新的编辑器逻辑
  // (这个函数名与HTML中的onclick="addAuthor()"对应，我们将其重定向到openAuthorEditor)
  function addAuthor() {
    openAuthorEditor(null);
  }

  // 6. 绑定保存按钮事件 (在初始化时执行一次即可，防止重复绑定)
  const saveBtn = document.getElementById('gr-save-author-btn');
  if (saveBtn) {
    // 使用 cloneNode 移除旧的监听器 (如果有的话)
    const newBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newBtn, saveBtn);
    newBtn.onclick = saveAuthor;
  }

  // 暴露给全局
  window.openAuthorManager = openAuthorManager;
  window.openAuthorEditor = openAuthorEditor;
  window.addAuthor = addAuthor;
  window.deleteAuthor = deleteAuthor;

  // 5. 新建作品 (设置页)

  async function createNewStory() {
    grState.activeStoryId = null; // 标记为新建
    document.getElementById('gr-story-title').value = '';
    await loadStorySettingsUI();
    document.getElementById('gr-settings-modal').classList.add('visible');
  }

  async function openStorySettings() {
    if (!grState.activeStoryId) return;
    const story = await db.grStories.get(grState.activeStoryId);
    if (!story) return;

    document.getElementById('gr-story-title').value = story.title;
    await loadStorySettingsUI(story.settings, story.authorId, story.storyBible);

    document.getElementById('gr-settings-modal').classList.add('visible');
  }

  // 加载设置弹窗中的选项
  // 加载设置弹窗中的选项 (修复版：增加字数和条数的回显)
  async function loadStorySettingsUI(settings = {}, selectedAuthorId = null, storyBible = {}) {
    const engine = window.GreenRiverStoryEngine;
    storyBible = Object.assign({}, engine.DEFAULT_STORY_BIBLE, storyBible || {});
    const exportBtn = document.getElementById('gr-export-txt-btn');
    if (exportBtn) {
      if (grState.activeStoryId) {
        exportBtn.style.display = 'block';
        exportBtn.textContent = '导出作品';
        exportBtn.onclick = () => openExportTxtModal(grState.activeStoryId);
      } else {
        exportBtn.style.display = 'none';
      }
    }

    // 1. 加载作者列表
    const authorSelect = document.getElementById('gr-author-select');
    authorSelect.innerHTML = '';
    const authors = await db.grAuthors.toArray();
    authors.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      if (selectedAuthorId === a.id) opt.selected = true;
      authorSelect.appendChild(opt);
    });
    bindAuthorPicker();
    const authorTrigger = document.getElementById('gr-author-select-trigger');
    if (authorTrigger) authorTrigger.textContent = authorSelect.selectedOptions[0]?.textContent || '请选择作者';

    // 2. 加载角色列表 (Chats + NPCs)
    const charList = document.getElementById('gr-char-list');
    charList.innerHTML = '';
    const chars = Object.values(state.chats);
    const npcs = await db.npcs.toArray();

    const allEntities = [
      ...chars.map(c => ({ id: c.id, name: c.name, type: c.isGroup ? '群聊' : '角色' })),
      ...npcs.map(n => ({ id: `npc_${n.id}`, name: n.name, type: 'NPC' }))
    ];

    allEntities.forEach(item => {
      const div = document.createElement('div');
      div.className = 'gr-checkbox-item';
      // 回显：检查是否在已保存的列表中
      const isChecked = settings.charIds && settings.charIds.includes(item.id);
      div.innerHTML = `<input type="checkbox" value="${item.id}" ${isChecked ? 'checked' : ''}> <span>${item.name} <small style="color:#999">(${item.type})</small></span>`;
      div.onclick = (e) => { if (e.target.tagName !== 'INPUT') div.querySelector('input').click(); };
      charList.appendChild(div);
    });

    // 3. 加载世界书列表
    const wbList = document.getElementById('gr-worldbook-list');
    wbList.innerHTML = '';
    const books = await db.worldBooks.toArray();
    books.forEach(book => {
      const div = document.createElement('div');
      div.className = 'gr-checkbox-item';
      // 回显：检查是否在已保存的列表中
      const isChecked = settings.bookIds && settings.bookIds.includes(book.id);
      div.innerHTML = `<input type="checkbox" value="${book.id}" ${isChecked ? 'checked' : ''}> <span>${book.name}</span>`;
      div.onclick = (e) => { if (e.target.tagName !== 'INPUT') div.querySelector('input').click(); };
      wbList.appendChild(div);
    });

    // 4. 加载User预设
    const userSelect = document.getElementById('gr-user-persona-select');
    userSelect.innerHTML = '<option value="">当前默认</option>';
    const presets = await db.personaPresets.toArray();
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.persona.substring(0, 20) + '...';
      // 回显：选中已保存的 User Persona
      if (settings.userPersonaId === p.id) opt.selected = true;
      userSelect.appendChild(opt);
    });

    // 5. 【核心修复】：回显字数和上下文条数
    // 如果 settings 里有值，就用 settings 里的；如果没有（新建时），就用默认值 500 和 20
    document.getElementById('gr-output-length').value = settings.outputLength || 500;
    document.getElementById('gr-context-limit').value = settings.contextLimit || 20;
    document.getElementById('gr-reader-comments-enabled').checked = settings.readerCommentsEnabled || false;
    document.getElementById('gr-reader-comment-density').value = settings.readerCommentDensity || 'natural';
    document.getElementById('gr-reader-comment-tone').value = settings.readerCommentTone || 'mixed';
    document.getElementById('gr-macro-world-view').value = settings.macroWorldView || '';
    document.getElementById('gr-story-synopsis').value = storyBible.synopsis || '';
    document.getElementById('gr-story-genre').value = storyBible.genre || '';
    document.getElementById('gr-story-tone').value = storyBible.tone || '';
    document.getElementById('gr-story-status').value = storyBible.status || '连载中';
    document.getElementById('gr-story-tags').value = (storyBible.tags || []).join(', ');
    document.getElementById('gr-story-pov').value = storyBible.pov || '第三人称有限视角';
    document.getElementById('gr-story-tense').value = storyBible.tense || '自然叙事';
    document.getElementById('gr-ending-direction').value = storyBible.endingDirection || '';
    document.getElementById('gr-forbidden-content').value = storyBible.forbiddenContent || '';

    // 绑定按钮事件
    const saveBtn = document.getElementById('gr-save-story-btn');
    const cancelBtn = document.getElementById('gr-cancel-settings-btn');

    // 使用 cloneNode 清除旧的监听器，防止多次点击
    const newSaveBtn = saveBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);

    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newSaveBtn.textContent = grState.activeStoryId ? '保存设定' : '开始创作';
    newSaveBtn.onclick = () => saveStorySettings();
    newCancelBtn.onclick = () => document.getElementById('gr-settings-modal').classList.remove('visible');
  }

  // 5. 修复版：保存作品设置
  async function saveStorySettings() {
    // 获取 DOM 元素
    const titleInput = document.getElementById('gr-story-title');
    const authorSelect = document.getElementById('gr-author-select');
    const userPersonaSelect = document.getElementById('gr-user-persona-select');
    const outputLengthInput = document.getElementById('gr-output-length'); // 检查HTML ID是否一致
    const contextLimitInput = document.getElementById('gr-context-limit'); // 检查HTML ID是否一致
    const macroWorldViewInput = document.getElementById('gr-macro-world-view');
    const title = titleInput.value.trim();
    const authorId = parseInt(authorSelect.value);

    const charIds = Array.from(document.querySelectorAll('#gr-char-list input:checked')).map(cb => cb.value);
    const bookIds = Array.from(document.querySelectorAll('#gr-worldbook-list input:checked')).map(cb => cb.value);
    const userPersonaId = userPersonaSelect.value;

    // 【核心修复】：确保这里取到的是数字，并且有默认值
    const outputLength = parseInt(outputLengthInput.value) || 500;
    const contextLimit = parseInt(contextLimitInput.value) || 20;
    const readerCommentsEnabled = document.getElementById('gr-reader-comments-enabled').checked;
    const readerCommentDensity = document.getElementById('gr-reader-comment-density').value;
    const readerCommentTone = document.getElementById('gr-reader-comment-tone').value;
    const macroWorldView = macroWorldViewInput.value.trim();
    if (!title) return alert("请输入书名");
    if (charIds.length === 0) return alert("请至少选择一个角色或群聊");

    const existingStory = grState.activeStoryId ? await db.grStories.get(grState.activeStoryId) : null;
    const settings = Object.assign({}, existingStory?.settings || {}, {
      charIds,
      bookIds,
      userPersonaId,
      outputLength, // 这里的名字要和 prompt 里的对应
      contextLimit,
      macroWorldView,
      readerCommentsEnabled,
      readerCommentDensity,
      readerCommentTone
    });

    const oldBible = existingStory?.storyBible || {};
    const storyBible = Object.assign({}, window.GreenRiverStoryEngine.DEFAULT_STORY_BIBLE, oldBible, {
      synopsis: document.getElementById('gr-story-synopsis').value.trim(),
      genre: document.getElementById('gr-story-genre').value.trim(),
      tone: document.getElementById('gr-story-tone').value.trim(),
      status: document.getElementById('gr-story-status').value,
      tags: document.getElementById('gr-story-tags').value.split(/[,，]/).map(text => text.trim()).filter(Boolean),
      pov: document.getElementById('gr-story-pov').value,
      tense: document.getElementById('gr-story-tense').value,
      endingDirection: document.getElementById('gr-ending-direction').value.trim(),
      forbiddenContent: document.getElementById('gr-forbidden-content').value.trim()
    });

    if (grState.activeStoryId) {
      // 更新现有作品
      await db.grStories.update(grState.activeStoryId, { title, authorId, settings, storyBible, lastUpdated: Date.now() });
    } else {
      // 新建作品
      const newStory = {
        title,
        authorId,
        settings,
        storyBible,
        chapters: [],
        lastUpdated: Date.now()
      };
      grState.activeStoryId = await db.grStories.add(newStory);
    }

    document.getElementById('gr-settings-modal').classList.remove('visible');

    // 打开阅读器，并定位到最新一章
    const story = await db.grStories.get(grState.activeStoryId);
    const lastIndex = Math.max(0, story.chapters.length - 1);
    openReader(grState.activeStoryId, lastIndex);
  }

  function showReaderCommentsPopup(comments, paragraphId) {
    const popup = document.getElementById('gr-reader-comments-popup');
    const listEl = popup && popup.querySelector('.gr-comments-popup-list');
    if (!popup || !listEl) return;
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    listEl.innerHTML = (comments || []).map(c => {
      const name = escapeHtml(c.name || '读者');
      const content = escapeHtml(c.content || '');
      const likes = Math.max(0, Number(c.likes) || 0);
      return `<div class="gr-comment-item"><div class="gr-comment-name">${name}</div><div class="gr-comment-content">${content}</div>${likes ? `<div class="gr-comment-meta">♡ ${likes}</div>` : ''}</div>`;
    }).join('');
    if (!listEl.innerHTML) listEl.innerHTML = '<div class="gr-comments-empty">这里还没有段评</div>';
    popup.style.display = 'flex';
    const close = () => { popup.style.display = 'none'; };
    popup.onclick = (e) => { if (e.target === popup) close(); };
    const closeBtn = popup.querySelector('.gr-comments-popup-close');
    if (closeBtn) closeBtn.onclick = close;
    const input = document.getElementById('gr-user-comment-input');
    const submit = document.getElementById('gr-user-comment-submit');
    if (input) input.value = '';
    if (submit) submit.onclick = async () => {
      const content = input?.value.trim();
      if (!content || !paragraphId || !grState.activeStoryId) return;
      const story = await db.grStories.get(grState.activeStoryId);
      window.GreenRiverStoryEngine.normalizeStory(story);
      const chapter = story.chapters[grState.currentChapterIndex];
      if (!chapter) return;
      let group = chapter.readerComments.find(item => item.paragraphId === paragraphId);
      if (!group) {
        const segmentIndex = chapter.paragraphs.findIndex(item => item.id === paragraphId);
        group = { paragraphId, segmentIndex, comments: [] };
        chapter.readerComments.push(group);
      }
      group.comments.push({ id: window.GreenRiverStoryEngine.makeId('comment'), name: '我', content, likes: 0, timestamp: Date.now(), isUser: true });
      story.lastUpdated = Date.now();
      await db.grStories.put(story);
      grState.currentReaderChapter = chapter;
      const bubble = Array.from(document.querySelectorAll('.gr-reader-comment-bubble')).find(item => item.dataset.paragraphId === paragraphId);
      if (bubble) bubble.textContent = `${group.comments.length}条`;
      showReaderCommentsPopup(group.comments, paragraphId);
    };
    if (input) input.onkeydown = event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit?.click(); }
    };
  }

  // 6. 阅读器逻辑 - 分页版 (Jinjiang Style)
  async function openReader(storyId, chapterIndex = 0) {
    grState.activeStoryId = storyId;
    const story = await db.grStories.get(storyId);
    if (!story) return;
    window.GreenRiverStoryEngine.normalizeStory(story);
    // 旧作品首次打开时持久化稳定章节/段落 ID，保证段评、共读进度和修订记录不漂移。
    await db.grStories.put(story);

    // 确保索引合法
    const totalChapters = story.chapters.length;
    if (totalChapters > 0 && chapterIndex >= totalChapters) chapterIndex = totalChapters - 1;
    if (chapterIndex < 0) chapterIndex = 0;

    grState.currentChapterIndex = chapterIndex;
    applyGreenRiverReadingMode();

    // 更新顶部标题
    document.getElementById('gr-book-name-display').textContent = story.title;

    const contentArea = document.getElementById('gr-reader-content');
    contentArea.innerHTML = '';
    bindWritingModePicker();

    // --- 场景 A: 尚未开始 (没有章节) ---
    if (totalChapters === 0) {
      document.getElementById('gr-chapter-title-display').textContent = "序章";
      contentArea.innerHTML = `
            <div style="text-align:center; padding-top:100px; color:#888;">
                <p>故事尚未开始。</p>
                <p>请在下方输入第一章的剧情走向，点击"续写"开始创作。</p>
            </div>
        `;
      // 显示写作控制栏，隐藏翻页栏
      document.getElementById('gr-pagination-controls').style.display = 'none';
      document.getElementById('gr-writing-controls').style.display = 'flex';
      contentArea.style.paddingBottom = '190px';
      const creatorTools = document.getElementById('gr-creator-tools');
      if (creatorTools) creatorTools.style.display = 'flex';
      const bibleBtn = document.getElementById('gr-story-bible-btn');
      const newChapterBtn = document.getElementById('gr-new-chapter-btn');
      if (bibleBtn) { bibleBtn.disabled = false; bibleBtn.onclick = () => openStoryBibleEditor(storyId); }
      if (newChapterBtn) { newChapterBtn.disabled = false; newChapterBtn.onclick = () => openChapterEditor(storyId, null); }
      ['gr-edit-chapter-btn', 'gr-diagnose-btn', 'gr-revisions-btn', 'gr-regenerate-comments-btn', 'gr-create-branch-btn'].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = true;
      });

      // 绑定生成按钮
      updateGenButtonBinding();
      showScreen('gr-reader-screen');
      return;
    }

    // --- 场景 B: 显示特定章节 ---
    const chapter = story.chapters[chapterIndex];
    grState.currentReaderChapter = chapter;
    const engine = window.GreenRiverStoryEngine;
    const chapterTitle = chapter.title || `第 ${chapterIndex + 1} 章`; // 如果没有标题，使用默认

    document.getElementById('gr-chapter-title-display').textContent = chapterTitle;

    // 1. 顶部：前情提要 (Context)
    if (chapter.prevSummary) {
      contentArea.innerHTML += `
            <details class="gr-summary-box top-summary">
                <summary>📖 上文提要 (Context)</summary>
                <div class="gr-summary-content" style="font-size:12px; color:#888;">${engine.escapeHtml(chapter.prevSummary)}</div>
            </details>
        `;
    }

    // 2. 章节大标题
    contentArea.innerHTML += `<div class="gr-chapter-title-large">${engine.escapeHtml(chapterTitle)}</div>`;

    // 3. 正文（有读者评论时按段渲染+气泡，否则整块）
    const commentMap = {};
    const anchoredComments = engine.paragraphCommentMap(chapter);
    const segments = chapter.paragraphs || [];
    
    const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    if (segments.length <= 1 && anchoredComments.size === 0) {
      contentArea.innerHTML += `<div class="gr-chapter-text">${escapeHtml(chapter.content || '').replace(/\n/g, '<br>')}</div>`;
    } else {
      let bodyHtml = '';
      segments.forEach((paragraph, i) => {
        // 先转义文本内容，然后替换换行符
        const text = escapeHtml(paragraph.text.trim()).replace(/\n/g, '<br>');
        const comments = anchoredComments.get(paragraph.id);
        
        // 创建段落div
        bodyHtml += `<div class="gr-chapter-segment" data-paragraph-id="${engine.escapeHtml(paragraph.id)}">${text}`;
        
        // 如果有评论，添加气泡（不转义，因为这是我们自己生成的HTML）
        if (comments && comments.length > 0) {
          bodyHtml += ` <span class="gr-reader-comment-bubble" data-paragraph-id="${engine.escapeHtml(paragraph.id)}" data-segment-index="${i}">${comments.length}条</span>`;
        }
        
        bodyHtml += '</div>';
      });
      contentArea.innerHTML += bodyHtml;
    }

    // 读者评论气泡：事件委托，避免被后续 innerHTML 替换掉绑定
    if (!contentArea._readerCommentDelegation) {
      contentArea._readerCommentDelegation = true;
      contentArea.addEventListener('click', function (e) {
        const bubble = e.target.closest('.gr-reader-comment-bubble');
        if (!bubble) return;
        e.preventDefault();
        const curChapter = grState.currentReaderChapter;
        if (!curChapter || !curChapter.readerComments) return;
        const paragraphId = bubble.dataset.paragraphId;
        const idx = parseInt(bubble.dataset.segmentIndex, 10);
        const list = curChapter.readerComments.find(r => r.paragraphId === paragraphId || (!r.paragraphId && Number(r.segmentIndex) === idx));
        const comments = list ? (list.comments || []) : [];
        showReaderCommentsPopup(comments, paragraphId);
      });
    }

    // 4. 底部：本章摘要 (可编辑)
    const summaryHtml = `
            <div class="gr-summary-card editable">
                <div class="gr-summary-header">
                    <span class="gr-summary-title">Chapter Checkpoint · 剧情存档</span>
                    <button class="gr-mini-btn save-summary-btn" data-index="${chapterIndex}">保存修改</button>
                </div>
                <textarea class="gr-summary-input" data-index="${chapterIndex}" placeholder="在此处概括本章关键剧情点，供AI记忆..."></textarea>
                 <div class="gr-summary-footer">
                    * AI续写时将读取此框内容作为唯一记忆依据。
                </div>
            </div>
        `;
    contentArea.innerHTML += summaryHtml;
    const summaryInput = contentArea.querySelector(`.gr-summary-input[data-index="${chapterIndex}"]`);
    if (summaryInput) summaryInput.value = chapter.summary || '';
    contentArea.innerHTML += `<div style="height: 100px;"></div>`;

    // 绑定保存摘要按钮
    contentArea.querySelectorAll('.save-summary-btn').forEach(btn => {
      btn.onclick = (e) => {
        const idx = parseInt(e.target.dataset.index);
        const textarea = contentArea.querySelector(`.gr-summary-input[data-index="${idx}"]`);
        saveChapterSummary(storyId, idx, textarea.value);
        e.target.textContent = "已保存";
        setTimeout(() => e.target.style.display = 'none', 1000);
      };
    });

    // 5. 更新底部导航栏状态
    const prevBtn = document.getElementById('gr-prev-chapter-btn');
    const nextBtn = document.getElementById('gr-next-chapter-btn');
    const paginationDiv = document.getElementById('gr-pagination-controls');
    const writingDiv = document.getElementById('gr-writing-controls');
    const rerollBtn = document.getElementById('gr-reroll-btn');
    const creatorTools = document.getElementById('gr-creator-tools');
    if (creatorTools) creatorTools.style.display = 'flex';

    // 总是显示分页栏，写作栏只在最后一页显示
    paginationDiv.style.display = 'flex';

    prevBtn.disabled = (chapterIndex === 0);
    prevBtn.onclick = () => openReader(storyId, chapterIndex - 1);

    if (chapterIndex < totalChapters - 1) {
      // 如果不是最后一章
      nextBtn.textContent = "下一章";
      nextBtn.onclick = () => openReader(storyId, chapterIndex + 1);
      writingDiv.style.display = 'none'; // 隐藏写作栏
      contentArea.style.paddingBottom = '120px';
    } else {
      // 如果是最后一章
      nextBtn.textContent = "续写下一章";
      nextBtn.onclick = () => {
        // 点击下一章按钮时，显示写作栏，并自动滚动到底部
        writingDiv.style.display = 'flex';
        contentArea.scrollTop = contentArea.scrollHeight;
        document.getElementById('gr-direction-input').focus();
      };
      // 默认也显示写作栏
      writingDiv.style.display = 'flex';
      contentArea.style.paddingBottom = '230px';

      // 绑定重写按钮
      rerollBtn.onclick = async () => {
        const confirmed = await showCustomConfirm("重写本章", "将生成一份新的本章内容。当前原稿会保存在修订记录中，生成失败不会改变原稿。", { confirmText: "重写", confirmButtonClass: "btn-danger" });
        if (confirmed) handleGenerateStoryContent(true);
      };
    }

    // 绑定生成按钮
    updateGenButtonBinding();
    bindCreatorToolButtons(storyId, chapterIndex);

    showScreen('gr-reader-screen');
    contentArea.scrollTop = 0;
  }

  // 辅助：绑定自定义写作方式选择器
  function bindWritingModePicker() {
    const trigger = document.getElementById('gr-writing-mode-trigger');
    const select = document.getElementById('gr-writing-mode');
    const modal = document.getElementById('gr-writing-mode-modal');
    if (!trigger || !select || !modal || trigger.dataset.bound === 'true') return;
    // 控制栏使用 backdrop-filter，会给 fixed 子元素建立新的坐标系；
    // 将弹窗提升到 body，才能相对整个屏幕真正居中。
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    const close = () => {
      modal.classList.remove('visible');
      modal.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
    };
    trigger.onclick = () => {
      modal.classList.add('visible');
      modal.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
    };
    document.getElementById('gr-writing-mode-close')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) return close();
      const option = event.target.closest('[data-value]');
      if (!option) return;
      select.value = option.dataset.value;
      trigger.firstChild.textContent = option.firstChild.textContent;
      close();
    });
    trigger.dataset.bound = 'true';
  }

  function bindAuthorPicker() {
    const trigger = document.getElementById('gr-author-select-trigger');
    const select = document.getElementById('gr-author-select');
    const modal = document.getElementById('gr-author-select-modal');
    const options = document.getElementById('gr-author-select-options');
    if (!trigger || !select || !modal || !options || trigger.dataset.bound === 'true') return;
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    const close = () => {
      modal.classList.remove('visible');
      modal.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
    };
    trigger.onclick = () => {
      const escape = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
      options.innerHTML = `<button type="button" class="gr-author-picker-add" data-add-author="true">＋ 新增作者文风</button>` +
        Array.from(select.options).map(option =>
          `<div class="gr-author-picker-item${select.value === option.value ? ' selected' : ''}" data-value="${escape(option.value)}">
             <button type="button" class="gr-author-picker-choice"><span>${escape(option.textContent)}</span><small>使用该作者的文风进行创作</small></button>
             <button type="button" class="gr-author-picker-edit" data-edit-author="${escape(option.value)}">编辑</button>
           </div>`
        ).join('');
      modal.classList.add('visible');
      modal.setAttribute('aria-hidden', 'false');
      trigger.setAttribute('aria-expanded', 'true');
    };
    document.getElementById('gr-author-select-close')?.addEventListener('click', close);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) return close();
      if (event.target.closest('[data-add-author]')) {
        close();
        return window.openAuthorEditor?.();
      }
      const editButton = event.target.closest('[data-edit-author]');
      if (editButton) {
        close();
        return window.openAuthorEditor?.(Number(editButton.dataset.editAuthor));
      }
      const option = event.target.closest('[data-value]');
      if (!option) return;
      select.value = option.dataset.value;
      trigger.textContent = option.querySelector('.gr-author-picker-choice span')?.textContent || '';
      close();
    });
    trigger.dataset.bound = 'true';
  }

  // 辅助：绑定生成按钮
  function updateGenButtonBinding() {
    const genBtn = document.getElementById('gr-generate-btn');
    // 使用克隆节点来移除旧的监听器
    const newBtn = genBtn.cloneNode(true);
    genBtn.parentNode.replaceChild(newBtn, genBtn);
    newBtn.onclick = () => handleGenerateStoryContent(false);
  }

  // 辅助：更新底部控制栏
  function updateControlPanel(story) {
    const controlPanel = document.querySelector('.gr-control-panel');
    // 清空旧内容，重新构建
    controlPanel.innerHTML = `
        <div style="display:flex; gap:10px; align-items:center; width:100%;">
            <div class="gr-input-group" style="flex-grow:1;">
                <input type="text" id="gr-direction-input" class="gr-input" placeholder="输入剧情走向 (留空则自由续写)...">
            </div>
            
            ${story.chapters.length > 0 ? `
            <button id="gr-reroll-btn" class="gr-main-btn" style="background-color:#F4F4F5; color:#666; border:1px solid #ddd;" title="不满当前章？重写！">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            </button>
            ` : ''}

            <button id="gr-generate-btn" class="gr-main-btn">
                <span id="gr-gen-text">续写</span>
                <svg id="gr-gen-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path></svg>
            </button>
        </div>
    `;

    // 绑定事件
    document.getElementById('gr-generate-btn').onclick = () => handleGenerateStoryContent(false); // false = 不是重写

    const rerollBtn = document.getElementById('gr-reroll-btn');
    if (rerollBtn) {
      rerollBtn.onclick = async () => {
        const confirmed = await showCustomConfirm("重写本章", "将生成一份新的本章内容。当前原稿会保存在修订记录中，生成失败不会改变原稿。", { confirmText: "重写", confirmButtonClass: "btn-danger" });
        if (confirmed) {
          handleGenerateStoryContent(true); // true = 是重写
        }
      };
    }
  }

  // 辅助：保存修改后的摘要
  async function saveChapterSummary(storyId, chapterIndex, newSummary) {
    const story = await db.grStories.get(storyId);
    if (story && story.chapters[chapterIndex]) {
      story.chapters[chapterIndex].summary = newSummary;
      await db.grStories.put(story);
      console.log("摘要已手动更新");
    }
  }

  function applyGreenRiverReadingMode() {
    const screen = document.getElementById('gr-reader-screen');
    const button = document.getElementById('gr-reading-mode-toggle');
    if (!screen || !button) return;
    screen.classList.toggle('reading-only', Boolean(grState.readingOnly));
    button.textContent = grState.readingOnly ? '创作' : '阅读';
    button.setAttribute('aria-pressed', String(Boolean(grState.readingOnly)));
    button.onclick = () => {
      grState.readingOnly = !grState.readingOnly;
      applyGreenRiverReadingMode();
    };
  }

  function bindCreatorToolButtons(storyId, chapterIndex) {
    const bibleBtn = document.getElementById('gr-story-bible-btn');
    const newChapterBtn = document.getElementById('gr-new-chapter-btn');
    const editBtn = document.getElementById('gr-edit-chapter-btn');
    const diagnoseBtn = document.getElementById('gr-diagnose-btn');
    const revisionsBtn = document.getElementById('gr-revisions-btn');
    const commentsBtn = document.getElementById('gr-regenerate-comments-btn');
    const branchBtn = document.getElementById('gr-create-branch-btn');
    [bibleBtn, newChapterBtn, editBtn, diagnoseBtn, revisionsBtn, commentsBtn, branchBtn].forEach(button => { if (button) button.disabled = false; });
    if (bibleBtn) bibleBtn.onclick = () => openStoryBibleEditor(storyId);
    if (newChapterBtn) newChapterBtn.onclick = () => openChapterEditor(storyId, null);
    if (editBtn) editBtn.onclick = () => openChapterEditor(storyId, chapterIndex);
    if (diagnoseBtn) diagnoseBtn.onclick = () => showChapterDiagnostics(storyId, chapterIndex);
    if (revisionsBtn) revisionsBtn.onclick = () => openChapterRevisions(storyId, chapterIndex);
    if (commentsBtn) commentsBtn.onclick = () => regenerateReaderComments(storyId, chapterIndex);
    if (branchBtn) branchBtn.onclick = () => createStoryBranch(storyId, chapterIndex);
  }

  async function ensureStoryCharacterProfiles(story) {
    const profiles = story.storyBible.storyCharacters;
    for (const id of (story.settings.charIds || [])) {
      if (profiles[id]) continue;
      if (String(id).startsWith('npc_')) {
        const npc = await db.npcs.get(parseInt(String(id).replace('npc_', ''), 10));
        if (npc) profiles[id] = { name: npc.name, sourceId: id, persona: npc.persona || '', role: '', goal: '', voice: '', relationships: '', knowledge: '' };
      } else {
        const chat = state.chats[id];
        if (chat) profiles[id] = { name: chat.name, sourceId: id, persona: chat.settings?.aiPersona || '', role: '', goal: '', voice: '', relationships: '', knowledge: '' };
      }
    }
  }

  async function openStoryBibleEditor(storyId) {
    const story = await db.grStories.get(storyId);
    if (!story) return;
    const engine = window.GreenRiverStoryEngine;
    engine.normalizeStory(story);
    await ensureStoryCharacterProfiles(story);
    await db.grStories.put(story);
    const bible = story.storyBible;
    document.getElementById('gr-global-story-summary').value = bible.globalSummary || '';
    document.getElementById('gr-open-threads-input').value = bible.openThreads.map(item => typeof item === 'string' ? item : item.text).filter(Boolean).join('\n');
    const characterEditor = document.getElementById('gr-story-character-editor');
    characterEditor.innerHTML = '';
    Object.entries(bible.storyCharacters).forEach(([id, profile]) => {
      const card = document.createElement('div');
      card.className = 'gr-story-character-card';
      const heading = document.createElement('strong');
      heading.textContent = profile.name || id;
      card.appendChild(heading);
      [['role', '小说内身份'], ['goal', '当前目标'], ['voice', '说话特点'], ['relationships', '关系与状态'], ['knowledge', '当前掌握的信息']].forEach(([field, label]) => {
        const wrapper = document.createElement('label');
        wrapper.textContent = label;
        const input = document.createElement('textarea');
        input.rows = field === 'relationships' || field === 'knowledge' ? 2 : 1;
        input.className = 'gr-input';
        input.dataset.characterId = id;
        input.dataset.field = field;
        input.value = profile[field] || '';
        wrapper.appendChild(input);
        card.appendChild(wrapper);
      });
      characterEditor.appendChild(card);
    });
    if (!characterEditor.children.length) characterEditor.innerHTML = '<div class="gr-empty-state">人物档案会在首次生成时从已选择角色建立。</div>';
    const timeline = document.getElementById('gr-story-timeline');
    timeline.innerHTML = '';
    bible.timeline.slice().reverse().slice(0, 30).forEach(item => {
      const row = document.createElement('div');
      row.textContent = typeof item === 'string' ? item : item.text;
      timeline.appendChild(row);
    });
    if (!timeline.children.length) timeline.innerHTML = '<div class="gr-empty-state">生成章节后会自动记录关键事件。</div>';
    const modal = document.getElementById('gr-story-bible-modal');
    modal.classList.add('visible');
    document.getElementById('gr-cancel-story-bible').onclick = () => modal.classList.remove('visible');
    document.getElementById('gr-save-story-bible').onclick = async () => {
      const latest = await db.grStories.get(storyId);
      engine.normalizeStory(latest);
      latest.storyBible.globalSummary = document.getElementById('gr-global-story-summary').value.trim();
      latest.storyBible.openThreads = document.getElementById('gr-open-threads-input').value.split(/\n/).map(text => text.trim()).filter(Boolean).map(text => ({ id: engine.makeId('thread'), text }));
      characterEditor.querySelectorAll('[data-character-id][data-field]').forEach(input => {
        const profile = latest.storyBible.storyCharacters[input.dataset.characterId];
        if (profile) profile[input.dataset.field] = input.value.trim();
      });
      latest.lastUpdated = Date.now();
      await db.grStories.put(latest);
      modal.classList.remove('visible');
      await showCustomAlert('已保存', '剧情档案会在后续续写中参与连续性判断。');
    };
  }

  async function openChapterEditor(storyId, chapterIndex) {
    const story = await db.grStories.get(storyId);
    const isNewChapter = chapterIndex === null;
    if (!story || (!isNewChapter && !story.chapters?.[chapterIndex])) return;
    window.GreenRiverStoryEngine.normalizeStory(story);
    const chapter = isNewChapter ? { title: `第 ${story.chapters.length + 1} 章`, content: '', summary: '' } : story.chapters[chapterIndex];
    document.getElementById('gr-edit-chapter-title').value = chapter.title || '';
    document.getElementById('gr-edit-chapter-content').value = chapter.content || '';
    document.getElementById('gr-edit-chapter-summary').value = chapter.summary || '';
    const modal = document.getElementById('gr-chapter-editor-modal');
    modal.classList.add('visible');
    document.getElementById('gr-cancel-chapter-edit').onclick = () => modal.classList.remove('visible');
    modal.querySelectorAll('[data-gr-transform]').forEach(button => {
      button.onclick = () => transformSelectedChapterText(button.dataset.grTransform, button);
    });
    document.getElementById('gr-save-chapter-edit').onclick = async () => {
      const latest = await db.grStories.get(storyId);
      window.GreenRiverStoryEngine.normalizeStory(latest);
      let target = isNewChapter ? null : latest.chapters[chapterIndex];
      const title = document.getElementById('gr-edit-chapter-title').value.trim();
      const content = document.getElementById('gr-edit-chapter-content').value.trim();
      const summary = document.getElementById('gr-edit-chapter-summary').value.trim();
      if (!content) return alert('正文不能为空');
      if (isNewChapter) {
        target = {
          id: window.GreenRiverStoryEngine.makeId('chapter'),
          title: title || `第 ${latest.chapters.length + 1} 章`,
          content: '', paragraphs: [], summary: '', prevSummary: latest.chapters[latest.chapters.length - 1]?.summary || '这是故事的开始。',
          readerComments: [], revisions: [], storyDelta: {}, timestamp: Date.now(), writingMode: 'manual'
        };
      } else {
        window.GreenRiverStoryEngine.snapshotRevision(target, '手动编辑前');
      }
      const oldCommentsByText = new Map((target.paragraphs || []).map(p => [p.text.trim(), p.id]));
      target.title = title || target.title;
      target.content = content;
      target.summary = summary;
      target.paragraphs = window.GreenRiverStoryEngine.splitParagraphs(content).map(text => ({
        id: oldCommentsByText.get(text.trim()) || window.GreenRiverStoryEngine.makeId('paragraph'),
        text
      }));
      target.readerComments = window.GreenRiverStoryEngine.attachCommentAnchors(target, target.readerComments);
      if (isNewChapter) latest.chapters.push(target);
      latest.lastUpdated = Date.now();
      await db.grStories.put(latest);
      modal.classList.remove('visible');
      await openReader(storyId, isNewChapter ? latest.chapters.length - 1 : chapterIndex);
    };
  }

  async function transformSelectedChapterText(operation, button) {
    const textarea = document.getElementById('gr-edit-chapter-content');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) return showCustomAlert('请先选择文字', '在正文编辑框中选中需要处理的段落后再使用此工具。');
    const selected = textarea.value.slice(start, end);
    if (selected.length > 8000) return showCustomAlert('选择内容过长', '请一次选择不超过 8000 个字符，以免局部处理失去重点。');
    const instruction = {
      polish: '自然润色这段中文小说文字，保持事实、人物意图和信息不变，使表达流畅克制，不增加新剧情。',
      deai: '去除这段小说文字的AI腔：删掉重复解释、模板化情绪、滥用的目光指尖呼吸心跳和空泛比喻；保持原事实、语气和人物关系。',
      expand: '扩写这段小说文字，补充能推动场景或体现人物意图的有效动作、对话和感官细节，不得注水或重复心理。',
      condense: '精简这段小说文字，删除重复、空泛抒情和无效动作，保留所有关键事实、人物情绪转折和必要语气。',
      dialogue: '改进这段小说中的人物对话，使不同人物声音更有区分度，并增加潜台词；保留原有事实和剧情结果。'
    }[operation];
    if (!instruction || typeof callGreenRiverModel !== 'function') return;
    const before = textarea.value.slice(Math.max(0, start - 600), start);
    const after = textarea.value.slice(end, Math.min(textarea.value.length, end + 600));
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = '处理中…';
    try {
      const output = await callGreenRiverModel('你是中文小说局部编辑器。严格只返回处理后的选中文字，不要解释，不要引号，不要代码围栏。', `${instruction}\n\n前文参考：${before}\n\n【待处理文字】\n${selected}\n\n后文参考：${after}`, 0.65);
      const replacement = String(output || '').trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/i, '');
      if (!replacement) throw new Error('AI未返回处理结果');
      textarea.setRangeText(replacement, start, end, 'select');
      document.getElementById('gr-edit-chapter-hint').textContent = '局部处理已放入编辑框，确认效果后点击“保存修改”；取消则不会写入作品。';
    } catch (error) {
      alert(`局部处理失败：${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  async function createStoryBranch(storyId, chapterIndex) {
    const branchName = await showCustomPrompt('创建剧情分支', '输入分支名称。新作品会保留到当前章节，原作品不受影响。', '另一条可能');
    if (branchName === null || !String(branchName).trim()) return;
    const story = await db.grStories.get(storyId);
    if (!story) return;
    window.GreenRiverStoryEngine.normalizeStory(story);
    const branch = window.GreenRiverStoryEngine.clone(story);
    delete branch.id;
    branch.title = `${story.title} · ${String(branchName).trim()}`;
    branch.chapters = branch.chapters.slice(0, chapterIndex + 1);
    branch.parentStoryId = story.id;
    branch.branchFromChapterId = story.chapters[chapterIndex]?.id || null;
    branch.deletedChapters = [];
    const retainedChapterIds = new Set(branch.chapters.map(chapter => chapter.id));
    branch.storyBible.timeline = (branch.storyBible.timeline || []).filter(item => !item.chapterId || retainedChapterIds.has(item.chapterId));
    branch.storyBible.openThreads = (branch.storyBible.openThreads || []).filter(item => !item.chapterId || retainedChapterIds.has(item.chapterId));
    window.GreenRiverStoryEngine.refreshGlobalSummary(branch);
    branch.lastUpdated = Date.now();
    const branchId = await db.grStories.add(branch);
    await openReader(branchId, branch.chapters.length - 1);
    await showCustomAlert('分支已创建', `《${branch.title}》已作为独立作品加入绿江书架。`);
  }

  async function showChapterDiagnostics(storyId, chapterIndex) {
    const story = await db.grStories.get(storyId);
    const chapter = story?.chapters?.[chapterIndex];
    if (!chapter) return;
    const result = window.GreenRiverStoryEngine.analyseChapter(chapter);
    const content = document.getElementById('gr-diagnostics-content');
    content.innerHTML = `<div class="gr-diagnostic-stats"><span>${result.charCount} 字</span><span>${result.paragraphCount} 段</span></div><div class="gr-diagnostic-message">${window.GreenRiverStoryEngine.escapeHtml(result.message).replace(/\n/g, '<br>')}</div>`;
    const modal = document.getElementById('gr-diagnostics-modal');
    modal.classList.add('visible');
    document.getElementById('gr-close-diagnostics').onclick = () => modal.classList.remove('visible');
  }

  async function openChapterRevisions(storyId, chapterIndex) {
    const story = await db.grStories.get(storyId);
    window.GreenRiverStoryEngine.normalizeStory(story);
    const chapter = story?.chapters?.[chapterIndex];
    if (!chapter) return;
    const list = document.getElementById('gr-revisions-list');
    const revisions = (chapter.revisions || []).slice().reverse();
    list.innerHTML = revisions.length ? '' : '<div class="gr-empty-state">当前章节还没有修订记录。</div>';
    revisions.forEach(revision => {
      const item = document.createElement('div');
      item.className = 'gr-revision-item';
      const info = document.createElement('div');
      info.innerHTML = `<strong>${window.GreenRiverStoryEngine.escapeHtml(revision.reason || '历史稿')}</strong><span>${new Date(revision.timestamp).toLocaleString()}</span>`;
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'gr-tool-btn';
      restoreBtn.textContent = '恢复此稿';
      restoreBtn.onclick = async () => {
        const confirmed = await showCustomConfirm('恢复历史稿', '当前内容会先自动存档，然后恢复所选历史稿。', { confirmText: '恢复' });
        if (!confirmed) return;
        const latest = await db.grStories.get(storyId);
        window.GreenRiverStoryEngine.normalizeStory(latest);
        window.GreenRiverStoryEngine.restoreRevision(latest.chapters[chapterIndex], revision);
        latest.lastUpdated = Date.now();
        await db.grStories.put(latest);
        document.getElementById('gr-revisions-modal').classList.remove('visible');
        await openReader(storyId, chapterIndex);
      };
      item.appendChild(info);
      item.appendChild(restoreBtn);
      list.appendChild(item);
    });
    const modal = document.getElementById('gr-revisions-modal');
    modal.classList.add('visible');
    document.getElementById('gr-close-revisions').onclick = () => modal.classList.remove('visible');
  }

  let grGenerationController = null;

  function extractGreenRiverJson(aiText) {
    const raw = String(aiText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error('AI未返回有效JSON格式');
    const jsonText = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonText);
    } catch (firstError) {
      const fixed = jsonText.replace(/\x00/g, '').replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
      try { return JSON.parse(fixed); } catch (_) { throw new Error(`JSON解析失败：${firstError.message}`); }
    }
  }

  async function callGreenRiverModel(systemPrompt, userPrompt, temperature = 0.75, signal) {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !model) throw new Error('请先完成API设置');
    const messages = [{ role: 'user', content: userPrompt }];
    let response;
    if (proxyUrl.includes('generativelanguage')) {
      const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messages);
      response = await fetch(geminiConfig.url, Object.assign({}, geminiConfig.data, { signal }));
    } else {
      response = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          temperature,
          ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
          ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
          ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
          ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
        })
      });
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API 请求失败 (${response.status}): ${text}`);
    }
    return getGeminiResponseText(await response.json());
  }

  function selectRelevantWorldBookEntries(book, query) {
    const entries = Array.isArray(book?.content) ? book.content.filter(item => item.enabled !== false) : [];
    const lowerQuery = String(query || '').toLowerCase();
    return entries.sort((a, b) => {
      const score = item => (item.keys || []).reduce((total, key) => total + (lowerQuery.includes(String(key).toLowerCase()) ? 1 : 0), 0);
      return score(b) - score(a);
    });
  }

  async function buildGreenRiverCharacterContext(story, historyLimit) {
    const bible = story.storyBible;
    const blocks = [];
    for (const id of (story.settings.charIds || [])) {
      if (String(id).startsWith('npc_')) {
        const npc = await db.npcs.get(parseInt(String(id).replace('npc_', ''), 10));
        if (!npc) continue;
        if (!bible.storyCharacters[id]) bible.storyCharacters[id] = { name: npc.name, sourceId: id, persona: npc.persona || '', role: '', goal: '', voice: '', relationships: '', knowledge: '' };
        const p = bible.storyCharacters[id];
        blocks.push(`### ${p.name}\n小说内设定：${p.persona}\n当前目标：${p.goal || '未指定'}\n说话特点：${p.voice || '沿用基础人设'}`);
        continue;
      }
      const chat = state.chats[id];
      if (!chat) continue;
      if (!bible.storyCharacters[id]) {
        bible.storyCharacters[id] = { name: chat.name, sourceId: id, persona: chat.settings?.aiPersona || '', role: '', goal: '', voice: '', relationships: '', knowledge: '' };
      }
      const p = bible.storyCharacters[id];
      const toneReferences = (chat.history || []).slice(-Math.max(1, historyLimit || 20)).filter(message => {
        return message.role !== 'system' && !['red_packet', 'waimai_request', 'transfer'].includes(message.type);
      }).slice(-Math.min(30, Math.max(1, historyLimit || 20))).map(message => `${message.senderName || (message.role === 'user' ? 'User' : p.name)}：${String(message.content || '').slice(0, 180)}`).join('\n');
      blocks.push(`### ${p.name}\n小说内设定：${p.persona}\n小说内身份：${p.role || '依据作品设定自然确定'}\n当前目标：${p.goal || '根据当前剧情确定'}\n关系状态：${p.relationships || '依据已发生剧情'}\n掌握信息：${p.knowledge || '不得知道尚未获知的秘密'}\n说话特点：${p.voice || '参考基础人设'}${toneReferences ? `\n少量语气参考（只参考说话习惯，不把聊天事件当小说事实）：\n${toneReferences}` : ''}`);
    }
    return blocks.join('\n\n');
  }

  async function buildGreenRiverWorldContext(story, continuity, userDirection) {
    const query = [story.storyBible.synopsis, story.settings.macroWorldView, continuity.lastChapterTail, userDirection].join('\n');
    const blocks = [];
    for (const id of (story.settings.bookIds || [])) {
      const book = await db.worldBooks.get(id);
      if (!book) continue;
      const text = selectRelevantWorldBookEntries(book, query).map(entry => entry.content).filter(Boolean).join('\n');
      if (text) blocks.push(`《${book.name}》\n${text}`);
    }
    return blocks.join('\n\n').slice(0, 18000);
  }

  async function getGreenRiverUserPersona(story) {
    if (story.settings.userPersonaId) {
      const preset = await db.personaPresets.get(story.settings.userPersonaId);
      if (preset) return preset.persona;
    }
    const active = state.chats[state.activeChatId];
    if (active?.settings?.myPersona) return active.settings.myPersona;
    const fallback = Object.values(state.chats || {}).find(chat => chat?.settings?.myPersona);
    return fallback?.settings?.myPersona || '普通用户';
  }

  function writingModeInstruction(mode, isReroll) {
    if (isReroll) return '改写当前最新章节：保留已经成立的前情事实，但重新组织本章场景、动作和对话。';
    return ({
      continue: '自然续写为新章节，承接上一章最后动作和语气。',
      direction: '按照用户给出的剧情方向续写为新章节。',
      extend: '不要开启新章节；继续并延长当前章节结尾的同一场景。',
      transition: '续写为新章节，重点补足上一章与目标剧情之间自然可信的过渡。',
      dialogue: '续写为新章节，重点增强人物之间有潜台词、有区分度的对话，同时保持必要动作推进。'
    })[mode] || '自然续写为新章节，承接上一章最后动作和语气。';
  }

  function buildGreenRiverWritingPrompt(data) {
    const { story, author, continuity, charsContext, worldContext, userPersona, userDirection, mode, targetMin, targetMax, isReroll } = data;
    const bible = story.storyBible;
    return `
# 身份与目标
你是负责持续创作这部长篇小说的中文小说作者。作者风格配置：${author?.name || '自定义作者'}；${author?.style || '自然、清晰、贴合人物'}。
首要目标是连续性、人物真实感、场景推进和自然表达，不以堆砌辞藻或凑字数为目标。

# 本次写作方式
${writingModeInstruction(mode, isReroll)}
用户指示：${userDirection || '没有额外指示，请依据未解决剧情自然发展。'}

# 作品档案
书名：${story.title}
简介/前提：${bible.synopsis || '未单独填写'}
题材：${bible.genre || '依据已有内容'}
基调：${bible.tone || '依据已有内容'}
叙事视角：${bible.pov}
叙事节奏：${bible.tense}
长期方向：${bible.endingDirection || '未指定，不要擅自仓促完结'}
核心世界观/IF线：${story.settings.macroWorldView || '无额外设定'}
禁止内容或表达：${bible.forbiddenContent || '无额外限制'}
全局故事摘要：${bible.globalSummary || '尚未形成'}

# 连续性上下文
最近章节摘要：
${continuity.recentSummaries || '这是故事开篇'}

上一章结尾原文（新正文必须直接承接其动作、地点、时间和语气）：
${continuity.lastChapterTail || '这是故事开篇，请建立清楚而有吸引力的初始场景。'}

未解决剧情/伏笔：
${continuity.openThreads || '暂无结构化记录，可从最近正文判断'}

近期时间线：
${continuity.timeline || '暂无结构化记录'}

# 人物
User 小说内设定：${userPersona}
${charsContext}

# 世界书
${worldContext || '没有选中的世界书内容'}

# 写作质量规则
- 正文目标为约 ${targetMin}～${targetMax} 个中文字符；内容完整时自然收束，不得通过重复心理、重复环境或拆慢每个动作凑字数。
- 每个场景必须发生可辨认的状态变化：信息、关系、目标、处境或决定至少有一项推进。
- 对话要符合人物各自身份和说话习惯，允许留白与潜台词，不要替读者反复解释情绪。
- 描写按场景需要出现；不要机械轮流描写目光、指尖、呼吸、心跳、空气凝固。
- 不要复述上一章摘要，不要重新介绍已经认识的人物，不要擅自让角色知道秘密。
- 遵守时代、地点、人物在场状态、物品位置及既有事实。
- 正文按自然段使用双换行分隔。

# 输出
只输出一个合法 JSON 对象，不要代码围栏，不要额外解释：
{"title":"章节标题","content":"正文，段落之间用\\n\\n分隔","summary":"准确记录本章关键事实、关系变化、获得的信息和结尾状态","globalSummary":"在旧全局摘要基础上更新的精炼全局故事摘要，保留长期重要事实","storyDelta":{"timelineEvent":"本章新增的一条时间线事件","openThreadsAdded":["新增未解决问题或伏笔"],"openThreadsResolved":["已经解决的既有问题或伏笔"],"characterChanges":[{"name":"角色名","change":"目标、关系、认知或状态变化"}]}}`;
  }

  function applyStoryDelta(story, chapter) {
    const delta = chapter.storyDelta || {};
    const bible = story.storyBible;
    if (delta.timelineEvent) bible.timeline.push({ id: GreenRiverStoryEngine.makeId('event'), text: String(delta.timelineEvent), chapterId: chapter.id, timestamp: Date.now() });
    const resolved = new Set((delta.openThreadsResolved || []).map(item => String(item).trim()).filter(Boolean));
    bible.openThreads = bible.openThreads.filter(item => !resolved.has(String(typeof item === 'string' ? item : item.text).trim()));
    (delta.openThreadsAdded || []).map(item => String(item).trim()).filter(Boolean).forEach(text => {
      if (!bible.openThreads.some(item => String(typeof item === 'string' ? item : item.text).trim() === text)) bible.openThreads.push({ id: GreenRiverStoryEngine.makeId('thread'), text, chapterId: chapter.id });
    });
  }

  function commentLimits(settings) {
    if (settings.readerCommentDensity === 'sparse') return { paragraphCount: 3, perParagraph: 2 };
    if (settings.readerCommentDensity === 'lively') return { paragraphCount: 8, perParagraph: 4 };
    return { paragraphCount: 5, perParagraph: 3 };
  }

  function getOrCreateReaderProfiles(story) {
    const bible = story.storyBible;
    if (!Array.isArray(bible.readerProfiles) || bible.readerProfiles.length < 6) {
      bible.readerProfiles = [
        { name: '今天也在追更', type: '剧情分析', voice: '注意伏笔和逻辑，表达简洁' },
        { name: '糖分观察员', type: '关系向', voice: '关注人物关系变化，但不过度尖叫' },
        { name: '页边小灯', type: '细节型', voice: '温和，善于发现动作和措辞细节' },
        { name: '不许刀我', type: '情绪型', voice: '情绪直接，偶尔轻松吐槽' },
        { name: '埋伏笔了吗', type: '推理型', voice: '提出有依据的猜测，不提前剧透' },
        { name: '路过但认真看了', type: '普通读者', voice: '自然口语，偶尔表达不同意见' },
        { name: '角色行为研究所', type: '角色分析', voice: '分析动机，不复述正文' }
      ];
    }
    return bible.readerProfiles;
  }

  async function generateReaderCommentsForChapter(story, chapter, signal) {
    if (!story.settings.readerCommentsEnabled) return [];
    const profiles = getOrCreateReaderProfiles(story);
    const limits = commentLimits(story.settings);
    const toneMap = { mixed: '自然混合', gentle: '总体温和', funny: '偏轻松吐槽', serious: '偏认真分析' };
    const paragraphs = chapter.paragraphs.map((item, index) => `[${index}] ${item.text}`).join('\n\n');
    const prompt = `你正在为小说《${story.title}》的《${chapter.title}》生成真实自然的段评。\n读者档案：${profiles.map(p => `${p.name}（${p.type}：${p.voice}）`).join('；')}\n评论气氛：${toneMap[story.settings.readerCommentTone] || toneMap.mixed}。\n只在信息揭露、情绪转折、关系推进、喜剧点、伏笔呼应或章末钩子等值得评论的位置发言。不要机械覆盖每段，不要复述正文，不要让所有人都用“啊啊啊、救命、磕到了”。读者可以观点不同，但不能知道本章尚未揭示的信息。最多选择 ${limits.paragraphCount} 个段落，每段最多 ${limits.perParagraph} 条。\n\n正文：\n${paragraphs}\n\n只输出合法JSON：{"readerComments":[{"segmentIndex":0,"comments":[{"name":"必须来自读者档案","content":"自然评论","likes":0}]}]}`;
    const result = extractGreenRiverJson(await callGreenRiverModel('你负责生成小说读者段评，不修改正文。', prompt, 0.85, signal));
    return GreenRiverStoryEngine.attachCommentAnchors(chapter, result.readerComments || []);
  }

  async function regenerateReaderComments(storyId, chapterIndex) {
    if (grState.isGenerating) return;
    const story = await db.grStories.get(storyId);
    if (!story?.chapters?.[chapterIndex]) return;
    GreenRiverStoryEngine.normalizeStory(story);
    if (!story.settings.readerCommentsEnabled) return showCustomAlert('尚未开启段评', '请先在作品设定中开启“生成时开启读者评论”。');
    const confirmed = await showCustomConfirm('重生成段评', '正文不会改变，当前章节已有段评会先保存在修订记录中。', { confirmText: '生成' });
    if (!confirmed) return;
    grState.isGenerating = true;
    const button = document.getElementById('gr-regenerate-comments-btn');
    if (button) { button.disabled = true; button.textContent = '生成中…'; }
    try {
      const chapter = story.chapters[chapterIndex];
      GreenRiverStoryEngine.snapshotRevision(chapter, '重生成段评前');
      chapter.readerComments = await generateReaderCommentsForChapter(story, chapter);
      story.lastUpdated = Date.now();
      await db.grStories.put(story);
      await openReader(storyId, chapterIndex);
    } catch (error) {
      alert(`段评生成失败：${error.message}`);
    } finally {
      grState.isGenerating = false;
      if (button) { button.disabled = false; button.textContent = '重生成段评'; }
    }
  }

  async function handleGenerateStoryContent(isReroll = false) {
    if (grState.isGenerating) { if (grGenerationController) grGenerationController.abort(); return; }
    let story = await db.grStories.get(grState.activeStoryId);
    if (!story) return;
    const engine = GreenRiverStoryEngine;
    engine.normalizeStory(story);
    const oldLatestChapter = isReroll ? story.chapters[story.chapters.length - 1] : null;
    if (isReroll && !oldLatestChapter) return;
    const directionInput = document.getElementById('gr-direction-input');
    const mode = document.getElementById('gr-writing-mode')?.value || 'continue';
    const userDirection = directionInput?.value.trim() || '';
    const author = await db.grAuthors.get(story.authorId);
    const genBtn = document.getElementById('gr-generate-btn');
    const btnText = document.getElementById('gr-gen-text');
    grState.isGenerating = true;
    grGenerationController = new AbortController();
    if (genBtn) {
      genBtn.disabled = false;
      genBtn.classList.add('is-generating');
      genBtn.title = '点击取消生成';
      genBtn.onclick = () => grGenerationController?.abort();
      if (btnText) btnText.textContent = '取消';
    }
    try {
      const contextStory = engine.clone(story);
      if (isReroll) {
        const removed = contextStory.chapters.pop();
        contextStory.storyBible.timeline = (contextStory.storyBible.timeline || []).filter(item => item.chapterId !== removed?.id);
        contextStory.storyBible.openThreads = (contextStory.storyBible.openThreads || []).filter(item => item.chapterId !== removed?.id);
      }
      engine.normalizeStory(contextStory);
      const continuity = engine.buildContinuityContext(contextStory);
      const charsContext = await buildGreenRiverCharacterContext(story, Math.max(1, Number(story.settings.contextLimit) || 20));
      const worldContext = await buildGreenRiverWorldContext(story, continuity, userDirection);
      const userPersona = await getGreenRiverUserPersona(story);
      const requested = Math.max(200, Number(story.settings.outputLength) || 500);
      const targetMin = Math.max(150, Math.floor(requested * 0.85));
      const targetMax = Math.max(targetMin + 100, Math.ceil(requested * 1.25));
      const systemPrompt = buildGreenRiverWritingPrompt({ story, author, continuity, charsContext, worldContext, userPersona, userDirection, mode, targetMin, targetMax, isReroll });
      const result = extractGreenRiverJson(await callGreenRiverModel(systemPrompt, '请根据全部资料完成本次小说写作。', 0.76, grGenerationController.signal));
      const content = String(result.content || '').trim();
      if (content.length < 80) throw new Error('AI返回的正文过短，未保存本次结果');
      const newChapter = {
        id: engine.makeId('chapter'),
        title: String(result.title || `第 ${isReroll ? story.chapters.length : story.chapters.length + 1} 章`),
        content,
        paragraphs: engine.splitParagraphs(content).map(text => ({ id: engine.makeId('paragraph'), text })),
        summary: String(result.summary || ''),
        prevSummary: continuity.lastChapter?.summary || (continuity.recentSummaries || '这是故事的开始。'),
        storyDelta: result.storyDelta && typeof result.storyDelta === 'object' ? result.storyDelta : {},
        readerComments: [], revisions: [], generationInstruction: userDirection, writingMode: mode, timestamp: Date.now()
      };
      if (story.settings.readerCommentsEnabled) {
        try { newChapter.readerComments = await generateReaderCommentsForChapter(story, newChapter, grGenerationController.signal); }
        catch (commentError) { if (commentError.name === 'AbortError') throw commentError; console.warn('正文已完成，但段评生成失败：', commentError); }
      }
      const generatedBibleState = engine.clone(story.storyBible);
      story = await db.grStories.get(grState.activeStoryId);
      engine.normalizeStory(story);
      story.storyBible.storyCharacters = generatedBibleState.storyCharacters || story.storyBible.storyCharacters;
      if (generatedBibleState.readerProfiles) story.storyBible.readerProfiles = generatedBibleState.readerProfiles;
      if (result.globalSummary) story.storyBible.globalSummary = String(result.globalSummary).slice(0, 5000);
      if (mode === 'extend' && !isReroll && story.chapters.length) {
        const target = story.chapters[story.chapters.length - 1];
        engine.snapshotRevision(target, '延长场景前');
        const offset = target.paragraphs.length;
        target.paragraphs.push(...newChapter.paragraphs);
        target.content = target.paragraphs.map(item => item.text).join('\n\n');
        target.summary = newChapter.summary || target.summary;
        target.storyDelta = newChapter.storyDelta;
        target.readerComments.push(...newChapter.readerComments.map(group => Object.assign({}, group, { segmentIndex: Number(group.segmentIndex) + offset })));
        target.timestamp = Date.now();
        applyStoryDelta(story, target);
      } else if (isReroll) {
        const current = story.chapters[story.chapters.length - 1];
        story.storyBible.timeline = (story.storyBible.timeline || []).filter(item => item.chapterId !== current.id);
        story.storyBible.openThreads = (story.storyBible.openThreads || []).filter(item => item.chapterId !== current.id);
        const oldSnapshot = { id: engine.makeId('revision'), reason: '重写前原稿', timestamp: Date.now(), title: current.title, content: current.content, summary: current.summary, paragraphs: engine.clone(current.paragraphs), readerComments: engine.clone(current.readerComments), storyDelta: engine.clone(current.storyDelta) };
        newChapter.revisions = [...(current.revisions || []), oldSnapshot].slice(-20);
        story.chapters[story.chapters.length - 1] = newChapter;
        applyStoryDelta(story, newChapter);
      } else {
        story.chapters.push(newChapter);
        applyStoryDelta(story, newChapter);
      }
      story.lastUpdated = Date.now();
      await db.grStories.put(story);
      await openReader(story.id, story.chapters.length - 1);
      if (directionInput) directionInput.value = '';
    } catch (error) {
      if (error.name === 'AbortError') await showCustomAlert('已取消', '本次生成已取消，原有章节没有变化。');
      else { console.error('绿江生成失败:', error); alert(`生成失败：${error.message}`); }
    } finally {
      grState.isGenerating = false;
      grGenerationController = null;
      const currentBtn = document.getElementById('gr-generate-btn');
      if (currentBtn) { currentBtn.disabled = false; currentBtn.classList.remove('is-generating'); currentBtn.title = ''; }
      const currentText = document.getElementById('gr-gen-text');
      if (currentText) currentText.textContent = '续写';
      updateGenButtonBinding();
    }
  }

  window.regenerateReaderComments = regenerateReaderComments;

  const chapterDeleteState = {
    isDeleteMode: false,
    selectedChapters: new Set()
  };

  function openChapterList() {
    const sidebar = document.getElementById('gr-chapter-sidebar');
    const overlay = document.getElementById('gr-sidebar-overlay');
    const listContainer = document.getElementById('gr-chapter-list-content');
    const countEl = document.getElementById('gr-total-chapters');

    if (!grState.activeStoryId) return;

    db.grStories.get(grState.activeStoryId).then(story => {
      if (!story) return;
      if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
      // 重置删除模式
      chapterDeleteState.isDeleteMode = false;
      chapterDeleteState.selectedChapters.clear();
      
      renderChapterList(story, listContainer, countEl);

      sidebar.classList.add('visible');
      overlay.classList.add('visible');
    });
  }

  function renderChapterList(story, listContainer, countEl) {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    listContainer.innerHTML = '';
    countEl.textContent = `共 ${story.chapters.length} 章`;

    // 如果是删除模式，显示控制栏
    if (chapterDeleteState.isDeleteMode) {
      const controlBar = document.createElement('div');
      controlBar.style.cssText = 'padding: 10px; background: #f5f5f5; border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: center; gap: 10px;';
      
      const leftButtons = document.createElement('div');
      leftButtons.style.cssText = 'display: flex; gap: 8px; align-items: center;';
      
      // 全选按钮
      const selectAllBtn = document.createElement('button');
      selectAllBtn.textContent = '全选';
      selectAllBtn.style.cssText = 'padding: 5px 12px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      selectAllBtn.onclick = () => {
        story.chapters.forEach((_, idx) => chapterDeleteState.selectedChapters.add(idx));
        renderChapterList(story, listContainer, countEl);
      };
      
      // 取消全选按钮
      const deselectAllBtn = document.createElement('button');
      deselectAllBtn.textContent = '取消全选';
      deselectAllBtn.style.cssText = 'padding: 5px 12px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      deselectAllBtn.onclick = () => {
        chapterDeleteState.selectedChapters.clear();
        renderChapterList(story, listContainer, countEl);
      };
      
      // 选中计数
      const countSpan = document.createElement('span');
      countSpan.style.cssText = 'font-size: 13px; color: #666;';
      countSpan.textContent = `已选 ${chapterDeleteState.selectedChapters.size} 章`;
      
      leftButtons.appendChild(selectAllBtn);
      leftButtons.appendChild(deselectAllBtn);
      leftButtons.appendChild(countSpan);
      
      const rightButtons = document.createElement('div');
      rightButtons.style.cssText = 'display: flex; gap: 8px;';
      
      // 确认删除按钮
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = `删除 (${chapterDeleteState.selectedChapters.size})`;
      deleteBtn.style.cssText = 'padding: 5px 15px; background: #ff4444; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;';
      deleteBtn.disabled = chapterDeleteState.selectedChapters.size === 0;
      if (deleteBtn.disabled) {
        deleteBtn.style.background = '#ccc';
        deleteBtn.style.cursor = 'not-allowed';
      }
      deleteBtn.onclick = async () => {
        if (chapterDeleteState.selectedChapters.size === 0) return;
        
        const confirmed = await showCustomConfirm(
          '确认删除',
          `确定要删除选中的 ${chapterDeleteState.selectedChapters.size} 个章节吗？\n此操作不可撤销！`,
          { confirmText: '删除', confirmButtonClass: 'btn-danger' }
        );
        
        if (confirmed) {
          await deleteSelectedChapters();
        }
      };
      
      // 取消按钮
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'padding: 5px 15px; background: #fff; color: #666; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px;';
      cancelBtn.onclick = () => {
        chapterDeleteState.isDeleteMode = false;
        chapterDeleteState.selectedChapters.clear();
        renderChapterList(story, listContainer, countEl);
      };
      
      rightButtons.appendChild(deleteBtn);
      rightButtons.appendChild(cancelBtn);
      
      controlBar.appendChild(leftButtons);
      controlBar.appendChild(rightButtons);
      listContainer.appendChild(controlBar);
    } else {
      // 非删除模式，显示删除按钮
      const toolBar = document.createElement('div');
      toolBar.style.cssText = 'padding: 10px; background: #f9f9f9; border-bottom: 1px solid #ddd; display: flex; justify-content: flex-end;';
      
      const deleteBtn = document.createElement('button');
      deleteBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
        删除章节
      `;
      deleteBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: #666; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 13px; display: flex; align-items: center;';
      deleteBtn.onclick = () => {
        chapterDeleteState.isDeleteMode = true;
        renderChapterList(story, listContainer, countEl);
      };
      
      if (Array.isArray(story.deletedChapters) && story.deletedChapters.length) {
        const restoreBtn = document.createElement('button');
        restoreBtn.textContent = '恢复最近删除';
        restoreBtn.style.cssText = 'padding: 6px 12px; background: #fff; color: var(--gr-primary); border: 1px solid var(--gr-primary); border-radius: 4px; cursor: pointer; font-size: 13px; margin-right:8px;';
        restoreBtn.onclick = async () => {
          const latest = await db.grStories.get(story.id);
          const record = latest?.deletedChapters?.[latest.deletedChapters.length - 1];
          if (!record) return;
          const confirmed = await showCustomConfirm('恢复章节', `恢复《${record.chapter.title || '无题'}》到原来的章节位置？`, { confirmText: '恢复' });
          if (!confirmed) return;
          latest.deletedChapters.pop();
          latest.chapters.splice(Math.min(record.originalIndex, latest.chapters.length), 0, record.chapter);
          latest.chapters.forEach((chapter, index) => { chapter.prevSummary = index > 0 ? latest.chapters[index - 1].summary || '' : '这是故事的开始。'; });
          if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(latest);
          latest.lastUpdated = Date.now();
          await db.grStories.put(latest);
          renderChapterList(latest, listContainer, countEl);
          openReader(latest.id, Math.min(record.originalIndex, latest.chapters.length - 1));
        };
        toolBar.appendChild(restoreBtn);
      }
      toolBar.appendChild(deleteBtn);
      listContainer.appendChild(toolBar);
    }

    // 渲染章节列表
    story.chapters.forEach((ch, index) => {
      const div = document.createElement('div');
      div.className = 'gr-sidebar-item';
      if (index === grState.currentChapterIndex && !chapterDeleteState.isDeleteMode) {
        div.classList.add('active');
      }

      if (chapterDeleteState.isDeleteMode) {
        const isSelected = chapterDeleteState.selectedChapters.has(index);
        
        div.style.cssText = 'display: flex; align-items: center; padding: 12px; cursor: pointer; user-select: none;';
        if (isSelected) {
          div.style.background = '#e3f2fd';
        }
        
        // 复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isSelected;
        checkbox.style.cssText = 'width: 18px; height: 18px; margin-right: 12px; cursor: pointer;';
        checkbox.onclick = (e) => {
          e.stopPropagation();
        };
        
        div.onclick = () => {
          if (chapterDeleteState.selectedChapters.has(index)) {
            chapterDeleteState.selectedChapters.delete(index);
          } else {
            chapterDeleteState.selectedChapters.add(index);
          }
          renderChapterList(story, listContainer, countEl);
        };
        
        const content = document.createElement('div');
        content.style.cssText = 'flex: 1;';
        content.innerHTML = `
          <div style="display:flex; justify-content:space-between;">
            <span>${index + 1}. ${escapeHtml(ch.title || '无题')}</span>
            <span style="font-size:12px; color:#999;">${new Date(ch.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="font-size:12px; color:#999; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml((ch.summary || '').substring(0, 30))}...</div>
        `;
        
        div.appendChild(checkbox);
        div.appendChild(content);
      } else {
        div.innerHTML = `
          <div class="gr-sidebar-chapter-row" style="display:flex; justify-content:space-between;gap:8px;">
            <span>${index + 1}. ${escapeHtml(ch.title || '无题')}</span>
            <span style="font-size:12px; color:#999;white-space:nowrap;">${new Date(ch.timestamp).toLocaleTimeString()}</span>
          </div>
          <div style="font-size:12px; color:#999; margin-left:10px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml((ch.summary || '').substring(0, 20))}...</div>
        `;

        const actions = document.createElement('div');
        actions.className = 'gr-chapter-order-actions';
        [['↑', -1, '上移章节'], ['↓', 1, '下移章节']].forEach(([label, offset, title]) => {
          const button = document.createElement('button');
          button.textContent = label;
          button.title = title;
          button.disabled = index + offset < 0 || index + offset >= story.chapters.length;
          button.onclick = async event => {
            event.stopPropagation();
            if (button.disabled) return;
            const targetIndex = index + offset;
            [story.chapters[index], story.chapters[targetIndex]] = [story.chapters[targetIndex], story.chapters[index]];
            story.chapters.forEach((chapter, chapterPosition) => { chapter.prevSummary = chapterPosition > 0 ? story.chapters[chapterPosition - 1].summary || '' : '这是故事的开始。'; });
            if (story.storyBible?.timeline) {
              const order = new Map(story.chapters.map((chapter, chapterPosition) => [chapter.id, chapterPosition]));
              story.storyBible.timeline.sort((a, b) => (order.get(a.chapterId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.chapterId) ?? Number.MAX_SAFE_INTEGER));
            }
            if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(story);
            story.lastUpdated = Date.now();
            await db.grStories.put(story);
            grState.currentChapterIndex = targetIndex;
            renderChapterList(story, listContainer, countEl);
            await openReader(story.id, targetIndex);
          };
          actions.appendChild(button);
        });
        div.querySelector('.gr-sidebar-chapter-row').appendChild(actions);

        div.onclick = () => {
          openReader(story.id, index);
          closeChapterList();
        };
      }
      
      listContainer.appendChild(div);
    });
  }

  async function deleteSelectedChapters() {
    if (!grState.activeStoryId) return;
    
    const story = await db.grStories.get(grState.activeStoryId);
    if (!story) return;
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
    
    // 将选中的索引转为数组并排序（从大到小，避免删除时索引变化）
    const indicesToDelete = Array.from(chapterDeleteState.selectedChapters).sort((a, b) => b - a);
    
    console.log('[章节删除] 准备删除章节:', indicesToDelete);
    
    story.deletedChapters = Array.isArray(story.deletedChapters) ? story.deletedChapters : [];
    const deletedChapterIds = new Set();
    // 删除章节前保存可恢复副本
    indicesToDelete.forEach(index => {
      const chapter = story.chapters[index];
      if (!chapter) return;
      deletedChapterIds.add(chapter.id);
      story.deletedChapters.push({ chapter: window.GreenRiverStoryEngine ? window.GreenRiverStoryEngine.clone(chapter) : JSON.parse(JSON.stringify(chapter)), originalIndex: index, deletedAt: Date.now() });
      story.chapters.splice(index, 1);
    });
    if (story.deletedChapters.length > 20) story.deletedChapters.splice(0, story.deletedChapters.length - 20);
    story.chapters.forEach((chapter, index) => { chapter.prevSummary = index > 0 ? story.chapters[index - 1].summary || '' : '这是故事的开始。'; });
    if (story.storyBible) {
      story.storyBible.timeline = (story.storyBible.timeline || []).filter(item => !deletedChapterIds.has(item.chapterId));
      story.storyBible.openThreads = (story.storyBible.openThreads || []).filter(item => !deletedChapterIds.has(item.chapterId));
    }
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.refreshGlobalSummary(story);
    
    story.lastUpdated = Date.now();
    await db.grStories.put(story);
    
    console.log(`[章节删除] 成功删除 ${indicesToDelete.length} 个章节`);
    
    // 重置状态
    chapterDeleteState.isDeleteMode = false;
    chapterDeleteState.selectedChapters.clear();
    
    // 重新渲染列表
    const listContainer = document.getElementById('gr-chapter-list-content');
    const countEl = document.getElementById('gr-total-chapters');
    renderChapterList(story, listContainer, countEl);
    
    // 如果当前阅读的章节被删除了，跳转到最后一章
    if (indicesToDelete.includes(grState.currentChapterIndex)) {
      const newIndex = Math.max(0, story.chapters.length - 1);
      if (story.chapters.length > 0) {
        openReader(story.id, newIndex);
      } else {
        // 如果所有章节都被删除了，显示空状态
        document.getElementById('gr-reader-content').innerHTML = `
          <div style="text-align: center; padding: 50px; color: #999;">
            <p>暂无章节</p>
            <p style="font-size: 14px; margin-top: 10px;">点击下方"续写"按钮开始创作</p>
          </div>
        `;
      }
    } else {
      // 重新加载当前章节（索引可能发生变化）
      const deletedBefore = indicesToDelete.filter(i => i < grState.currentChapterIndex).length;
      const newIndex = grState.currentChapterIndex - deletedBefore;
      openReader(story.id, newIndex);
    }
    
    alert(`成功删除 ${indicesToDelete.length} 个章节`);
  }

  function closeChapterList() {
    document.getElementById('gr-chapter-sidebar').classList.remove('visible');
    document.getElementById('gr-sidebar-overlay').classList.remove('visible');
  }
  // 暴露给 HTML onclick
  window.openChapterList = openChapterList;
  window.closeChapterList = closeChapterList;
  
  // ==========================================
  // 导出TXT功能
  // ==========================================
  async function openExportTxtModal(storyId) {
    const story = await db.grStories.get(storyId);
    if (!story || !story.chapters || story.chapters.length === 0) {
      alert("该作品还没有任何章节，无法导出。");
      return;
    }
    const modal = document.getElementById('gr-export-txt-modal');
    const listEl = document.getElementById('gr-export-txt-list');
    listEl.innerHTML = '';
    
    // 渲染章节列表
    story.chapters.forEach((ch, index) => {
      const div = document.createElement('div');
      div.style.cssText = 'display: flex; align-items: center; padding: 12px; border-bottom: 1px solid #eee;';
      div.innerHTML = `
        <input type="checkbox" class="gr-export-checkbox" value="${index}" checked style="width: 18px; height: 18px; margin-right: 12px; cursor: pointer;">
        <span style="font-size: 14px; color: #333;">${index + 1}. ${(window.GreenRiverStoryEngine?.escapeHtml || String)(ch.title || '无题')}</span>
      `;
      div.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
          const cb = div.querySelector('input');
          cb.checked = !cb.checked;
          updateExportSelectAllState();
        }
      };
      listEl.appendChild(div);
    });

    const selectAllCheckbox = document.getElementById('select-all-gr-export');
    selectAllCheckbox.checked = true;
    selectAllCheckbox.onclick = (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.gr-export-checkbox').forEach(cb => cb.checked = isChecked);
    };

    function updateExportSelectAllState() {
      const allCbs = Array.from(document.querySelectorAll('.gr-export-checkbox'));
      const allChecked = allCbs.every(cb => cb.checked);
      const someChecked = allCbs.some(cb => cb.checked);
      selectAllCheckbox.checked = allChecked;
      selectAllCheckbox.indeterminate = someChecked && !allChecked;
    }
    
    document.querySelectorAll('.gr-export-checkbox').forEach(cb => {
      cb.addEventListener('change', updateExportSelectAllState);
    });

    // 绑定按钮事件
    const cancelBtn = document.getElementById('cancel-gr-export-btn');
    const confirmBtn = document.getElementById('confirm-gr-export-btn');
    
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.onclick = () => modal.classList.remove('visible');

    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    newConfirmBtn.onclick = () => doExportTxt(story);

    modal.classList.add('visible');
  }

  function doExportTxt(story) {
    const selectedIndices = Array.from(document.querySelectorAll('.gr-export-checkbox'))
      .filter(cb => cb.checked)
      .map(cb => parseInt(cb.value));

    if (selectedIndices.length === 0) {
      alert("请至少选择一个章节进行导出。");
      return;
    }

    const format = document.getElementById('gr-export-format')?.value || 'txt';
    const includeComments = document.getElementById('gr-export-include-comments')?.checked || false;
    if (format === 'html') {
      doExportGreenRiverHtml(story, selectedIndices, includeComments);
      document.getElementById('gr-export-txt-modal').classList.remove('visible');
      return;
    }
    if (window.GreenRiverStoryEngine) window.GreenRiverStoryEngine.normalizeStory(story);
    let txtContent = story.title + "\n\n";
    selectedIndices.sort((a, b) => a - b).forEach(index => {
      const ch = story.chapters[index];
      txtContent += "===============\n";
      txtContent += (ch.title || `第 ${index + 1} 章`) + "\n";
      txtContent += "===============\n\n";
      txtContent += (ch.content || "") + "\n\n";
      if (includeComments && Array.isArray(ch.readerComments) && ch.readerComments.length) {
        txtContent += "【段评】\n";
        ch.readerComments.forEach(group => (group.comments || []).forEach(comment => { txtContent += `${comment.name || '读者'}：${comment.content || ''}\n`; }));
        txtContent += "\n";
      }
    });

    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${story.title || '作品导出'}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    document.getElementById('gr-export-txt-modal').classList.remove('visible');
  }

  function doExportGreenRiverHtml(story, selectedIndices, includeComments) {
    const escapeHtml = window.GreenRiverStoryEngine?.escapeHtml || (value => String(value));
    const chaptersHtml = selectedIndices.sort((a, b) => a - b).map(index => {
      const chapter = story.chapters[index];
      const commentsByParagraph = window.GreenRiverStoryEngine?.paragraphCommentMap(chapter) || new Map();
      const paragraphs = (chapter.paragraphs || window.GreenRiverStoryEngine.splitParagraphs(chapter.content).map(text => ({ text }))).map(paragraph => {
        const comments = includeComments ? (commentsByParagraph.get(paragraph.id) || []) : [];
        const commentHtml = comments.length ? `<aside>${comments.map(comment => `<div><strong>${escapeHtml(comment.name || '读者')}</strong> ${escapeHtml(comment.content || '')}</div>`).join('')}</aside>` : '';
        return `<p>${escapeHtml(paragraph.text)}</p>${commentHtml}`;
      }).join('');
      return `<article><h2>${escapeHtml(chapter.title || `第 ${index + 1} 章`)}</h2>${paragraphs}</article>`;
    }).join('');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(story.title)}</title><style>body{max-width:760px;margin:0 auto;padding:40px 24px;background:#faf9f5;color:#27251f;font:18px/1.9 system-ui,sans-serif}h1,h2{text-align:center}article{margin:60px 0}p{text-indent:2em;white-space:pre-wrap}aside{margin:-6px 0 20px 2em;padding:10px 14px;border-left:3px solid #2e7d32;background:#f1f7f3;font-size:14px;line-height:1.6}aside div+div{margin-top:6px}</style></head><body><h1>${escapeHtml(story.title)}</h1>${chaptersHtml}</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${story.title || '作品导出'}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  // 暴露给全局
  window.openGreenRiverScreen = openGreenRiverScreen;
  window.openAuthorManager = openAuthorManager;
  window.createNewStory = createNewStory;
  window.openStorySettings = openStorySettings;
  window.addAuthor = addAuthor;
  window.deleteAuthor = deleteAuthor;
