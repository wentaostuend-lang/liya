// ============================================================
// forum.js
// 论坛系统（重写版，独立于旧版 doubanPosts/douban.js）
// 第1步：数据结构 + feed骨架 —— 板块tab、发帖(user)、看帖、翻页加载
// 后续步骤会在这个文件里继续加：char发帖(主动回复+后台) / 网友回复 /
// 板块管理 / 热搜 / 小号 / 私信 / HTML互动组件
//
// 依赖全局：state, db, showScreen, showLoader, hideLoader,
//           formatPostTimestamp, parseMarkdown, getDisplayNameByOriginalName,
//           defaultAvatar（均由其他已加载的模块提供，qzone.js同样这样依赖）
// ============================================================

(function () {
  const FORUM_RENDER_WINDOW = 15;

  window.forumBoardsCache = window.forumBoardsCache || [];
  window.forumPostsCache = window.forumPostsCache || [];
  window.forumPostsRenderCount = window.forumPostsRenderCount || 0;
  window.forumActiveBoardId = window.forumActiveBoardId ?? 'all'; // 'all' 表示"全部"tab
  window.isLoadingMoreForumPosts = window.isLoadingMoreForumPosts || false;

  // 论坛自己的默认头像，跟角色/用户头像区分开，避免forumAvatar字段为空时显示破图
  const FORUM_DEFAULT_AVATAR = 'https://i.postimg.cc/KYr2qRCK/1.jpg';

  // ---------- 入口：点击桌面图标时调用 ----------
  async function openForumApp() {
    showScreen('forum-screen');
    await ensureForumBoardsLoaded();
    renderForumBoardTabs();
    await renderForumFeed();
  }
  window.openForumApp = openForumApp;

  // ---------- 板块 ----------
  async function ensureForumBoardsLoaded() {
    if (window.forumBoardsCache.length > 0) return;
    window.forumBoardsCache = await db.forumBoards.orderBy('order').toArray();
  }

  function renderForumBoardTabs() {
    const tabsEl = document.getElementById('forum-board-tabs');
    if (!tabsEl) return;

    const boards = window.forumBoardsCache;
    let html = `<button class="forum-board-tab${window.forumActiveBoardId === 'all' ? ' active' : ''}" data-board-id="all">全部</button>`;
    boards.forEach(board => {
      html += `<button class="forum-board-tab${window.forumActiveBoardId === board.id ? ' active' : ''}" data-board-id="${board.id}">${board.name}</button>`;
    });
    html += `<button class="forum-board-tab forum-board-tab-manage" id="forum-board-manage-tab" title="板块管理">+</button>`;
    tabsEl.innerHTML = html;

    document.getElementById('forum-board-manage-tab')?.addEventListener('click', openForumBoardManageModal);

    tabsEl.querySelectorAll('.forum-board-tab[data-board-id]').forEach(tabBtn => {
      tabBtn.addEventListener('click', async () => {
        const raw = tabBtn.dataset.boardId;
        window.forumActiveBoardId = raw === 'all' ? 'all' : Number(raw);
        renderForumBoardTabs();
        await renderForumFeed();
      });
    });

    // 发帖弹窗里的板块下拉框也顺便同步一下，保证选项跟tab一致
    const selectEl = document.getElementById('forum-create-post-board-select');
    if (selectEl) {
      selectEl.innerHTML = boards.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    }
  }

  // ---------- Feed ----------
  async function renderForumFeed() {
    const listEl = document.getElementById('forum-posts-list');
    if (!listEl) return;

    let query = db.forumPosts.orderBy('timestamp').reverse();
    const posts = await query.toArray();
    const filtered = window.forumActiveBoardId === 'all'
      ? posts
      : posts.filter(p => p.boardId === window.forumActiveBoardId);

    window.forumPostsCache = filtered;
    window.forumPostsRenderCount = 0;
    listEl.innerHTML = '';

    if (filtered.length === 0) {
      listEl.innerHTML = '<p class="forum-empty-tip">这个板块还没有帖子，来发第一条吧</p>';
      return;
    }

    await loadMoreForumPosts();
  }
  window.renderForumFeed = renderForumFeed;

  async function loadMoreForumPosts() {
    if (window.isLoadingMoreForumPosts) return;
    window.isLoadingMoreForumPosts = true;

    const listEl = document.getElementById('forum-posts-list');
    if (!listEl) {
      window.isLoadingMoreForumPosts = false;
      return;
    }

    if (typeof showLoader === 'function') showLoader(listEl, 'bottom');

    setTimeout(async () => {
      if (typeof hideLoader === 'function') hideLoader(listEl);

      const start = window.forumPostsRenderCount;
      const end = start + FORUM_RENDER_WINDOW;
      const slice = window.forumPostsCache.slice(start, end);

      const fragment = document.createDocumentFragment();
      for (const post of slice) {
        const boardName = getBoardNameById(post.boardId);
        fragment.appendChild(await createForumPostElement(post, boardName));
      }
      listEl.appendChild(fragment);

      window.forumPostsRenderCount += slice.length;
      window.isLoadingMoreForumPosts = false;
    }, 300);
  }
  window.loadMoreForumPosts = loadMoreForumPosts;

  // 大数字显示成"1.2万"这种，热搜相关帖子会有夸张的高点赞/评论数，不格式化的话一长串数字很难看
  function formatEngagementCount(n) {
    if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
    return String(n);
  }

  function getBoardNameById(boardId) {
    const board = window.forumBoardsCache.find(b => b.id === boardId);
    return board ? board.name : '';
  }

  // 统一解析作者信息：目前只有 user / char 两种authorType（网友NPC等到第2步接进来）
  // ============================================================
  // 个人主页/私信/提问箱：需要一套"身份key"来判断"这条帖子是不是同一个人发的"
  // (user小号只按altId识别，char按chatId或altId，npc按名字识别——因为历史上NPC的authorId写法不统一，名字是唯一可靠的字段)
  // ============================================================
  function getForumProfileKey(post) {
    if (post.authorAltId) return { kind: 'alt', altId: post.authorAltId };
    if (post.authorType === 'char') return { kind: 'char', chatId: post.authorId };
    if (post.authorType === 'npc') return { kind: 'npc', name: post.authorDisplayName || '' };
    if (post.authorType === 'user') return { kind: 'user' };
    return { kind: 'unknown' };
  }
  function profileKeyMatches(post, key) {
    const pk = getForumProfileKey(post);
    if (pk.kind !== key.kind) return false;
    if (key.kind === 'alt') return pk.altId === key.altId;
    if (key.kind === 'char') return pk.chatId === key.chatId;
    if (key.kind === 'npc') return pk.name === key.name;
    return key.kind === 'user';
  }
  // profileKey序列化成字符串，方便存进DM表的participantId字段(数据库不好存复杂对象做索引)
  function serializeProfileKey(key) {
    return JSON.stringify(key);
  }
  function deserializeProfileKey(str) {
    try { return JSON.parse(str); } catch (e) { return { kind: 'unknown' }; }
  }

  function resolveForumAuthor(post) {
    if (post.authorType === 'user') {
      if (post.authorAltId) {
        // user用小号发的：用发帖时存好的小号名字+头像(避免每次渲染都去查db)
        return { name: post.authorDisplayName || '小号', avatar: post.authorAvatar || FORUM_DEFAULT_AVATAR };
      }
      return {
        name: state.qzoneSettings?.nickname || state.forumSettings?.userNickname || '我',
        avatar: state.qzoneSettings?.avatar || FORUM_DEFAULT_AVATAR,
      };
    }
    if (post.authorType === 'char') {
      if (post.authorAltId) {
        // char用小号发的：同样显示小号身份，不暴露角色本体
        return { name: post.authorDisplayName || '小号', avatar: post.authorAvatar || FORUM_DEFAULT_AVATAR };
      }
      const chat = state.chats[post.authorId];
      return {
        name: chat ? chat.name : '未知角色',
        avatar: chat?.settings?.aiAvatar || FORUM_DEFAULT_AVATAR,
      };
    }
    if (post.authorType === 'npc') {
      return { name: post.authorDisplayName || '网友', avatar: post.authorAvatar || FORUM_DEFAULT_AVATAR };
    }
    return { name: '未知用户', avatar: FORUM_DEFAULT_AVATAR };
  }

  async function createForumPostElement(post, boardName) {
    const el = document.createElement('div');
    el.className = 'forum-post-card';
    el.dataset.postId = post.id;

    const author = resolveForumAuthor(post);
    const timeText = typeof formatPostTimestamp === 'function' ? formatPostTimestamp(post.timestamp) : new Date(post.timestamp).toLocaleString();
    const contentHtml = typeof parseMarkdown === 'function'
      ? parseMarkdown(post.content || '').replace(/\n/g, '<br>')
      : (post.content || '').replace(/\n/g, '<br>');

    const likeCount = (post.likes || []).length + (post.baseLikes || 0);
    const commentCount = (post.commentCount || 0) + (post.baseCommentCount || 0);
    const liked = (post.likes || []).includes('user');

    const imageHtml = post.imageUrl
      ? `<div class="forum-post-image-wrap"><img class="forum-post-image" src="${post.imageUrl}" loading="lazy"></div>`
      : '';

    el.innerHTML = `
      <div class="forum-post-header">
        <img class="forum-post-avatar" src="${author.avatar}" alt="${author.name}">
        <div class="forum-post-meta">
          <span class="forum-post-name">${author.name}</span>
          <span class="forum-post-sub">${boardName ? boardName + ' · ' : ''}${timeText}</span>
        </div>
      </div>
      ${imageHtml}
      <div class="forum-post-content">${contentHtml}</div>
      ${post.quotedPostSnapshot ? renderQuotedPostHtml(post) : ''}
      ${post.widget ? renderForumWidgetHtml(post) : ''}
      <div class="forum-post-footer">
        <div class="forum-post-actions-left">
          <span class="forum-post-action forum-like-btn${liked ? ' liked' : ''}">${ICON_HEART(liked)}</span>
          <span class="forum-post-action forum-comment-btn">${ICON_COMMENT}</span>
          <span class="forum-post-action forum-share-btn">${ICON_SHARE}</span>
          <span class="forum-post-action forum-quote-btn" title="引用发帖">${ICON_QUOTE}</span>
        </div>
        <span class="forum-post-action forum-bookmark-btn">${ICON_BOOKMARK}</span>
      </div>
      <div class="forum-post-engagement">
        ${likeCount > 0 ? `<span class="forum-like-count-text">${formatEngagementCount(likeCount)}人点赞</span>` : ''}
        ${commentCount > 0 ? `<span class="forum-comment-count-text">查看全部${formatEngagementCount(commentCount)}条评论</span>` : ''}
      </div>
    `;

    el.querySelector('.forum-like-btn').addEventListener('click', () => toggleForumLike(post.id, el));
    el.querySelector('.forum-comment-btn').addEventListener('click', () => openForumPostDetail(post.id));
    el.querySelector('.forum-post-content').addEventListener('click', () => openForumPostDetail(post.id));
    el.querySelector('.forum-share-btn').addEventListener('click', () => openForumForwardModal(post.id));
    el.querySelector('.forum-quote-btn').addEventListener('click', () => openForumCreatePostModal(post.id));
    el.querySelector('.forum-post-avatar')?.addEventListener('click', () => openForumProfile(post));
    el.querySelector('.forum-post-name')?.addEventListener('click', () => openForumProfile(post));
    el.querySelector('.forum-quoted-card')?.addEventListener('click', (e) => {
      e.stopPropagation(); // 别触发到外层content的点击（那个会跳到本帖详情，这里要跳去被引用的那条）
      if (post.quotedPostId != null) openForumPostDetail(post.quotedPostId);
    });
    if (post.widget) bindForumWidgetEvents(el, post);

    return el;
  }

  // IG经典线框图标（Feather风格stroke图标），心形点赞状态下变成实心+红色，其余都是纯黑白灰线框
  function ICON_HEART(liked) {
    return liked
      ? `<svg width="23" height="23" viewBox="0 0 24 24" fill="#ed4956" stroke="#ed4956" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`
      : `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
  }
  const ICON_COMMENT = `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
  const ICON_SHARE = `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
  const ICON_BOOKMARK = `<svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
  const ICON_QUOTE = `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v4z"></path></svg>`;

  function renderQuotedPostHtml(post) {
    const q = post.quotedPostSnapshot;
    const previewText = (q.content || '').length > 80 ? q.content.slice(0, 80) + '...' : (q.content || '');
    return `
      <div class="forum-quoted-card" data-quoted-post-id="${post.quotedPostId}">
        <div class="forum-quoted-card-header">
          ${q.avatar ? `<img src="${q.avatar}" class="forum-share-card-avatar">` : ''}
          <span class="forum-share-card-name">${q.authorName || '未知用户'}</span>
          ${q.boardName ? `<span class="forum-share-card-board">· ${q.boardName}</span>` : ''}
        </div>
        <div class="forum-quoted-card-content">${previewText}</div>
      </div>`;
  }

  // ============================================================
  // 互动组件：投票/打赏进度条/接龙/悬赏倒计时/评分卡/骰子/转盘
  // 数据都存在 post.widget = {type, data(发帖时的配置), state(运行时数据，会变化)}
  // ============================================================
  function getCurrentForumDisplayName() {
    const identity = getActiveForumIdentity();
    if (identity.type === 'alt') return identity.name;
    return state.qzoneSettings?.nickname || '我';
  }

  async function saveWidgetState(postId, state) {
    const post = await db.forumPosts.get(postId);
    if (!post) return null;
    post.widget.state = state;
    await db.forumPosts.put(post);
    return post;
  }

  function renderForumWidgetHtml(post) {
    const w = post.widget;
    if (!w) return '';
    if (w.type === 'poll') return renderPollHtml(post);
    if (w.type === 'donation') return renderDonationHtml(post);
    if (w.type === 'chain') return renderChainHtml(post);
    if (w.type === 'bounty') return renderBountyHtml(post);
    if (w.type === 'rating') return renderRatingHtml(post);
    if (w.type === 'dice') return renderDiceHtml(post);
    if (w.type === 'wheel') return renderWheelHtml(post);
    return '';
  }

  // 把AI生成的简化widget配置转成完整的{type,data,state}对象，供NPC/char自动发帖时使用
  // (跟手动发帖弹窗collectWidgetConfigFromForm是同一套shape，只是数据来源不同)
  function buildForumWidgetFromAIOutput(w) {
    if (!w || !w.type) return null;
    try {
      if (w.type === 'poll' && Array.isArray(w.options) && w.options.length >= 2) {
        return { type: 'poll', data: { options: w.options }, state: { votes: w.options.map(() => 0), voters: [] } };
      }
      if (w.type === 'donation' && w.goal) {
        return { type: 'donation', data: { title: w.title || '众筹', goal: Number(w.goal) || 100 }, state: { raised: 0, contributors: [] } };
      }
      if (w.type === 'chain') {
        return { type: 'chain', data: { prompt: w.prompt || '' }, state: { entries: [] } };
      }
      if (w.type === 'bounty' && w.prompt) {
        const hours = Math.max(1, Number(w.hours) || 24);
        return { type: 'bounty', data: { prompt: w.prompt, deadline: Date.now() + hours * 3600000 }, state: { submissions: [] } };
      }
      if (w.type === 'rating' && Array.isArray(w.dims) && w.dims.length >= 2) {
        return { type: 'rating', data: { dims: w.dims }, state: { ratings: [] } };
      }
      if (w.type === 'dice') {
        return { type: 'dice', data: {}, state: { history: [] } };
      }
      if (w.type === 'wheel' && Array.isArray(w.options) && w.options.length >= 2) {
        return { type: 'wheel', data: { options: w.options }, state: { history: [] } };
      }
    } catch (e) {
      console.warn('[论坛] 解析AI生成的widget失败', e);
    }
    return null;
  }
  window.buildForumWidgetFromAIOutput = buildForumWidgetFromAIOutput;

  // 塞进prompt里的通用widget说明文字，7种类型的生成入口都复用这一段，保持格式统一
  const FORUM_WIDGET_PROMPT_HINT = `
可选：给帖子附带一个互动小组件(不是每次都要加，大概10-20%概率加，太频繁会很奇怪)，格式为widget字段：
- 投票：{"type":"poll","options":["选项A","选项B",...]}(2-6个选项)
- 打赏/众筹：{"type":"donation","title":"标题","goal":数字}
- 接龙：{"type":"chain","prompt":"接龙主题(可选)"}
- 悬赏倒计时：{"type":"bounty","prompt":"悬赏内容","hours":数字}
- 评分卡：{"type":"rating","dims":["维度1","维度2",...]}(2-5个维度)
- 骰子：{"type":"dice"}
- 转盘：{"type":"wheel","options":["选项A","选项B",...]}(2-8个选项)
不想加就不要输出widget字段。`;
  window.FORUM_WIDGET_PROMPT_HINT = FORUM_WIDGET_PROMPT_HINT;

  function bindForumWidgetEvents(el, post) {
    const w = post.widget;
    if (!w) return;
    const wrap = el.querySelector('.forum-widget');
    if (!wrap) return;
    if (w.type === 'poll') bindPollEvents(wrap, post);
    else if (w.type === 'donation') bindDonationEvents(wrap, post);
    else if (w.type === 'chain') bindChainEvents(wrap, post);
    else if (w.type === 'bounty') bindBountyEvents(wrap, post);
    else if (w.type === 'rating') bindRatingEvents(wrap, post);
    else if (w.type === 'dice') bindDiceEvents(wrap, post);
    else if (w.type === 'wheel') bindWheelEvents(wrap, post);
  }

  // 重新渲染某个widget容器(不刷新整个帖子卡片，避免详情页评论区跟着重排)
  async function refreshWidgetInPlace(wrap, postId) {
    const post = await db.forumPosts.get(postId);
    if (!post || !post.widget) return;
    const temp = document.createElement('div');
    temp.innerHTML = renderForumWidgetHtml(post);
    const newWrap = temp.firstElementChild;
    wrap.replaceWith(newWrap);
    bindForumWidgetEvents(newWrap.closest('.forum-post-card, .forum-post-detail-body') || newWrap.parentElement, post);
  }

  // ---------- 投票 ----------
  function renderPollHtml(post) {
    const { options } = post.widget.data;
    const { votes } = post.widget.state;
    const total = votes.reduce((a, b) => a + b, 0);
    const voted = localStorage.getItem(`forum_voted_${post.id}`) !== null;
    return `
      <div class="forum-widget forum-widget-poll" data-post-id="${post.id}">
        ${options.map((opt, i) => {
          const pct = total > 0 ? Math.round((votes[i] / total) * 100) : 0;
          return `<div class="forum-poll-option${voted ? ' voted' : ''}" data-index="${i}">
            ${voted ? `<div class="forum-poll-bar" style="width:${pct}%"></div>` : ''}
            <span class="forum-poll-label">${opt}</span>
            ${voted ? `<span class="forum-poll-pct">${pct}%</span>` : ''}
          </div>`;
        }).join('')}
        <div class="forum-widget-meta">${total}人投票${voted ? '' : ' · 点选项投票'}</div>
      </div>`;
  }
  function bindPollEvents(wrap, post) {
    if (localStorage.getItem(`forum_voted_${post.id}`) !== null) return;
    wrap.querySelectorAll('.forum-poll-option').forEach(opt => {
      opt.addEventListener('click', async () => {
        const i = Number(opt.dataset.index);
        const state = post.widget.state;
        state.votes[i] = (state.votes[i] || 0) + 1;
        localStorage.setItem(`forum_voted_${post.id}`, String(i));
        await saveWidgetState(post.id, state);
        await refreshWidgetInPlace(wrap, post.id);
      });
    });
  }

  // ---------- 打赏/众筹进度条 ----------
  function renderDonationHtml(post) {
    const { title, goal } = post.widget.data;
    const { raised, contributors } = post.widget.state;
    const pct = Math.min(100, Math.round((raised / goal) * 100));
    return `
      <div class="forum-widget forum-widget-donation" data-post-id="${post.id}">
        <div class="forum-donation-title">${title}</div>
        <div class="forum-donation-bar-track"><div class="forum-donation-bar-fill" style="width:${pct}%"></div></div>
        <div class="forum-widget-meta">¥${raised} / ¥${goal}${contributors.length > 0 ? ` · ${contributors.length}人打赏` : ''}</div>
        <button class="forum-widget-btn forum-donation-btn">打赏</button>
      </div>`;
  }
  function bindDonationEvents(wrap, post) {
    wrap.querySelector('.forum-donation-btn')?.addEventListener('click', async () => {
      const amountStr = prompt('打赏多少钱？');
      const amount = Number(amountStr);
      if (!amount || amount <= 0) return;
      const state = post.widget.state;
      state.raised = (state.raised || 0) + amount;
      state.contributors = state.contributors || [];
      state.contributors.push({ name: getCurrentForumDisplayName(), amount });
      await saveWidgetState(post.id, state);
      await refreshWidgetInPlace(wrap, post.id);
    });
  }

  // ---------- 接龙 ----------
  function renderChainHtml(post) {
    const { prompt: chainPrompt } = post.widget.data;
    const { entries } = post.widget.state;
    return `
      <div class="forum-widget forum-widget-chain" data-post-id="${post.id}">
        ${chainPrompt ? `<div class="forum-widget-subtitle">🔗 ${chainPrompt}</div>` : ''}
        <div class="forum-chain-entries">${entries.map(e => `<div class="forum-chain-entry"><b>${e.author}：</b>${e.text}</div>`).join('') || '<span class="forum-widget-meta">还没人接，来第一个</span>'}</div>
        <div class="forum-widget-input-row">
          <input type="text" class="forum-widget-text-input forum-chain-input" placeholder="接一句...">
          <button class="forum-widget-btn forum-chain-submit-btn">接龙</button>
        </div>
      </div>`;
  }
  function bindChainEvents(wrap, post) {
    const submit = async () => {
      const input = wrap.querySelector('.forum-chain-input');
      const text = input.value.trim();
      if (!text) return;
      const state = post.widget.state;
      state.entries.push({ author: getCurrentForumDisplayName(), text });
      await saveWidgetState(post.id, state);
      await refreshWidgetInPlace(wrap, post.id);
    };
    wrap.querySelector('.forum-chain-submit-btn')?.addEventListener('click', submit);
    wrap.querySelector('.forum-chain-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  }

  // ---------- 悬赏倒计时 ----------
  function formatCountdown(ms) {
    if (ms <= 0) return '已截止';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `剩余 ${h}小时${m}分钟`;
  }
  function renderBountyHtml(post) {
    const { prompt: bountyPrompt, deadline } = post.widget.data;
    const { submissions } = post.widget.state;
    const remaining = deadline - Date.now();
    const ended = remaining <= 0;
    return `
      <div class="forum-widget forum-widget-bounty" data-post-id="${post.id}" data-deadline="${deadline}">
        <div class="forum-widget-subtitle">🎯 ${bountyPrompt}</div>
        <div class="forum-bounty-countdown">${formatCountdown(remaining)}</div>
        <div class="forum-chain-entries">${submissions.map(s => `<div class="forum-chain-entry"><b>${s.author}：</b>${s.text}</div>`).join('')}</div>
        ${ended
          ? '<div class="forum-widget-meta">征集已结束</div>'
          : `<div class="forum-widget-input-row">
              <input type="text" class="forum-widget-text-input forum-bounty-input" placeholder="提交答案...">
              <button class="forum-widget-btn forum-bounty-submit-btn">提交</button>
            </div>`}
      </div>`;
  }
  function bindBountyEvents(wrap, post) {
    const submit = async () => {
      const input = wrap.querySelector('.forum-bounty-input');
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      const state = post.widget.state;
      state.submissions.push({ author: getCurrentForumDisplayName(), text });
      await saveWidgetState(post.id, state);
      await refreshWidgetInPlace(wrap, post.id);
    };
    wrap.querySelector('.forum-bounty-submit-btn')?.addEventListener('click', submit);
    wrap.querySelector('.forum-bounty-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    // 倒计时每分钟自己刷新一次文字，不用整个组件重渲染
    const countdownEl = wrap.querySelector('.forum-bounty-countdown');
    if (countdownEl) {
      const deadline = Number(wrap.dataset.deadline);
      const timer = setInterval(() => {
        if (!document.body.contains(countdownEl)) { clearInterval(timer); return; }
        const remaining = deadline - Date.now();
        countdownEl.textContent = formatCountdown(remaining);
        if (remaining <= 0) clearInterval(timer);
      }, 60000);
    }
  }

  // ---------- 易得分卡 ----------
  function renderRatingHtml(post) {
    const { dims } = post.widget.data;
    const { ratings } = post.widget.state;
    const avgs = dims.map((_, i) => {
      if (ratings.length === 0) return 0;
      return ratings.reduce((sum, r) => sum + (r.scores[i] || 0), 0) / ratings.length;
    });
    const totalAvg = avgs.length > 0 ? avgs.reduce((a, b) => a + b, 0) / avgs.length : 0;
    return `
      <div class="forum-widget forum-widget-rating" data-post-id="${post.id}">
        ${dims.map((d, i) => `<div class="forum-rating-dim"><span>${d}</span><span>${avgs[i].toFixed(1)} ★</span></div>`).join('')}
        <div class="forum-widget-meta">总分 ${totalAvg.toFixed(1)} · ${ratings.length}人评分</div>
        <div class="forum-rating-form-area"></div>
        <button class="forum-widget-btn forum-rating-btn">我要评分</button>
      </div>`;
  }
  function bindRatingEvents(wrap, post) {
    wrap.querySelector('.forum-rating-btn')?.addEventListener('click', () => {
      const { dims } = post.widget.data;
      const formArea = wrap.querySelector('.forum-rating-form-area');
      const btn = wrap.querySelector('.forum-rating-btn');
      formArea.innerHTML = dims.map((d, i) => `
        <div class="forum-rating-input-row">
          <span>${d}</span>
          <input type="number" class="forum-rating-score-input" data-dim="${i}" min="1" max="5" value="5" style="width:50px;">
        </div>
      `).join('') + `<button class="forum-widget-btn forum-rating-confirm-btn">提交评分</button>`;
      btn.style.display = 'none';
      formArea.querySelector('.forum-rating-confirm-btn').addEventListener('click', async () => {
        const scores = Array.from(formArea.querySelectorAll('.forum-rating-score-input')).map(inp => Math.max(1, Math.min(5, Number(inp.value) || 1)));
        const state = post.widget.state;
        state.ratings.push({ scores });
        await saveWidgetState(post.id, state);
        await refreshWidgetInPlace(wrap, post.id);
      });
    });
  }

  // ---------- 骰子 ----------
  const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  function renderDiceHtml(post) {
    const { history } = post.widget.state;
    const last = history.length > 0 ? history[history.length - 1].result : 0;
    return `
      <div class="forum-widget forum-widget-dice" data-post-id="${post.id}">
        <div class="forum-dice-face">${last ? DICE_FACES[last] : '🎲'}</div>
        <button class="forum-widget-btn forum-dice-roll-btn">掷骰子</button>
        ${history.length > 0 ? `<div class="forum-widget-meta">最近：${history.slice(-8).map(h => h.result).join(' ')}</div>` : ''}
      </div>`;
  }
  function bindDiceEvents(wrap, post) {
    wrap.querySelector('.forum-dice-roll-btn')?.addEventListener('click', async () => {
      const faceEl = wrap.querySelector('.forum-dice-face');
      faceEl.classList.add('forum-dice-rolling');
      const result = Math.floor(Math.random() * 6) + 1;
      setTimeout(async () => {
        faceEl.classList.remove('forum-dice-rolling');
        const state = post.widget.state;
        state.history.push({ result, timestamp: Date.now() });
        await saveWidgetState(post.id, state);
        await refreshWidgetInPlace(wrap, post.id);
      }, 500);
    });
  }

  // ---------- 转盘 ----------
  const WHEEL_COLORS = ['#111', '#444', '#777', '#aaa', '#222', '#555', '#888', '#333'];
  function renderWheelHtml(post) {
    const { options } = post.widget.data;
    const { history } = post.widget.state;
    const n = options.length;
    const seg = 360 / n;
    const gradient = options.map((_, i) => `${WHEEL_COLORS[i % WHEEL_COLORS.length]} ${i * seg}deg ${(i + 1) * seg}deg`).join(', ');
    return `
      <div class="forum-widget forum-widget-wheel" data-post-id="${post.id}">
        <div class="forum-wheel-outer">
          <div class="forum-wheel-pointer">▼</div>
          <div class="forum-wheel-circle" style="background: conic-gradient(${gradient});"></div>
        </div>
        <div class="forum-wheel-labels">${options.map((o, i) => `<span>${i + 1}.${o}</span>`).join(' ')}</div>
        <button class="forum-widget-btn forum-wheel-spin-btn">转一下</button>
        <div class="forum-wheel-result">${history.length > 0 ? `上次结果：${history[history.length - 1].result}` : ''}</div>
      </div>`;
  }
  function bindWheelEvents(wrap, post) {
    wrap.querySelector('.forum-wheel-spin-btn')?.addEventListener('click', async () => {
      const { options } = post.widget.data;
      const circle = wrap.querySelector('.forum-wheel-circle');
      const btn = wrap.querySelector('.forum-wheel-spin-btn');
      btn.disabled = true;
      const n = options.length;
      const seg = 360 / n;
      const targetIndex = Math.floor(Math.random() * n);
      // 转盘指针固定指向顶部，让目标扇区的中心转到顶部：需要转到 -(targetIndex*seg + seg/2)，再加几圈整数360度制造转动感
      const targetAngle = 360 * 4 + (360 - (targetIndex * seg + seg / 2));
      circle.style.transition = 'transform 3s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
      circle.style.transform = `rotate(${targetAngle}deg)`;
      setTimeout(async () => {
        const result = options[targetIndex];
        const state = post.widget.state;
        state.history.push({ result, timestamp: Date.now() });
        await saveWidgetState(post.id, state);
        wrap.querySelector('.forum-wheel-result').textContent = `结果：${result}`;
        btn.disabled = false;
      }, 3100);
    });
  }

  async function toggleForumLike(postId, el) {
    const post = await db.forumPosts.get(postId);
    if (!post) return;
    const myKey = 'user';
    post.likes = post.likes || [];
    const idx = post.likes.indexOf(myKey);
    const nowLiked = idx < 0;
    if (idx >= 0) {
      post.likes.splice(idx, 1);
    } else {
      post.likes.push(myKey);
    }
    await db.forumPosts.put(post);

    const likeBtn = el.querySelector('.forum-like-btn');
    likeBtn.classList.toggle('liked', nowLiked);
    likeBtn.innerHTML = ICON_HEART(nowLiked);

    const engagementEl = el.querySelector('.forum-post-engagement');
    const likeCount = post.likes.length;
    const commentCount = post.commentCount || 0;
    engagementEl.innerHTML = `
      ${likeCount > 0 ? `<span class="forum-like-count-text">${formatEngagementCount(likeCount)}人点赞</span>` : ''}
      ${commentCount > 0 ? `<span class="forum-comment-count-text">查看全部${formatEngagementCount(commentCount)}条评论</span>` : ''}
    `;
  }

  // ---------- 帖子详情(评论区) ----------
  window.forumActiveDetailPostId = null;

  async function openForumPostDetail(postId) {
    window.forumActiveDetailPostId = postId;
    showScreen('forum-post-detail-screen');
    await renderForumPostDetail();
  }
  window.openForumPostDetail = openForumPostDetail;

  async function renderForumPostDetail() {
    const postId = window.forumActiveDetailPostId;
    const bodyEl = document.getElementById('forum-post-detail-body');
    if (!bodyEl || postId == null) return;

    const post = await db.forumPosts.get(postId);
    if (!post) {
      bodyEl.innerHTML = '<p class="forum-empty-tip">这条帖子已经不见了</p>';
      return;
    }

    const boardName = getBoardNameById(post.boardId);
    const postEl = await createForumPostElement(post, boardName);
    postEl.classList.add('forum-post-card-detail');

    const comments = await db.forumComments.where('postId').equals(postId).sortBy('timestamp');

    const commentsHtml = comments.length > 0
      ? comments.map(c => renderForumCommentHtml(c)).join('')
      : '<p class="forum-empty-tip">还没有评论，来抢第一个沙发</p>';

    bodyEl.innerHTML = '';
    bodyEl.appendChild(postEl);
    const commentsWrap = document.createElement('div');
    commentsWrap.className = 'forum-comments-wrap';
    commentsWrap.innerHTML = `<div class="forum-comments-title">评论 ${comments.length || ''}</div>${commentsHtml}`;
    bodyEl.appendChild(commentsWrap);

    commentsWrap.querySelectorAll('.forum-comment-avatar-clickable').forEach(el => {
      el.addEventListener('click', () => {
        try {
          const authorData = JSON.parse(decodeURIComponent(el.dataset.authorKey));
          openForumProfile(authorData);
        } catch (e) { /* 数据坏了就不跳转 */ }
      });
    });
  }

  function renderForumCommentHtml(comment) {
    const author = resolveForumAuthor({ authorType: comment.authorType, authorId: comment.authorId, authorDisplayName: comment.authorDisplayName, authorAvatar: comment.authorAvatar });
    const timeText = typeof formatPostTimestamp === 'function' ? formatPostTimestamp(comment.timestamp) : new Date(comment.timestamp).toLocaleString();
    const contentHtml = typeof parseMarkdown === 'function'
      ? parseMarkdown(comment.content || '').replace(/\n/g, '<br>')
      : (comment.content || '').replace(/\n/g, '<br>');
    const replyToHtml = comment.replyToName ? `<span class="forum-comment-reply-to">回复 @${comment.replyToName}：</span>` : '';
    // 把身份信息编码进data属性，方便事件委托时反查profileKey(评论列表是批量innerHTML插入的，不好逐条绑监听)
    const authorKeyJson = encodeURIComponent(JSON.stringify({
      authorType: comment.authorType,
      authorId: comment.authorId,
      authorAltId: comment.authorAltId,
      authorDisplayName: comment.authorDisplayName,
      authorAvatar: comment.authorAvatar,
    }));
    return `
      <div class="forum-comment-item">
        <img class="forum-comment-avatar forum-comment-avatar-clickable" src="${author.avatar}" alt="${author.name}" data-author-key="${authorKeyJson}">
        <div class="forum-comment-main">
          <span class="forum-comment-name forum-comment-avatar-clickable" data-author-key="${authorKeyJson}">${author.name}</span>
          <div class="forum-comment-text">${replyToHtml}${contentHtml}</div>
          <span class="forum-comment-time">${timeText}</span>
        </div>
      </div>
    `;
  }

  async function submitForumComment() {
    const postId = window.forumActiveDetailPostId;
    const input = document.getElementById('forum-comment-input');
    const content = input.value.trim();
    if (!content || postId == null) return;

    await db.forumComments.add({
      postId,
      ...(await buildAuthorFields()),
      content,
      timestamp: Date.now(),
    });

    const post = await db.forumPosts.get(postId);
    if (post) {
      post.commentCount = (post.commentCount || 0) + 1;
      await db.forumPosts.put(post);
    }

    input.value = '';
    await renderForumPostDetail();

    maybeTriggerPostAuthorReply(postId, content).catch(e => console.warn('[论坛] 帖主回复失败', e));
  }
  window.submitForumComment = submitForumComment;

  // ---------- 帖主回复评论(char/网友发的帖子，user评论了会自动回一条) ----------
  async function maybeTriggerPostAuthorReply(postId, commentContent, commenterNameOverride) {
    const post = await db.forumPosts.get(postId);
    if (!post) return;
    if (post.authorType !== 'char' && post.authorType !== 'npc') return; // user自己的帖子不用自动回复

    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) return; // 没配API就悄悄跳过，不打扰

    let authorPersona = '';
    let authorNameForPrompt = '';
    if (post.authorType === 'char') {
      const chat = state.chats[post.authorId];
      if (!chat) return;
      authorPersona = chat.settings?.aiPersona || '';
      authorNameForPrompt = post.authorAltId ? post.authorDisplayName : chat.name;
    } else {
      const npc = post.authorAltId
        ? null
        : await db.forumNpcs.where('name').equals(post.authorDisplayName || '').first();
      if (!npc && post.authorType === 'npc') return; // 找不到对应网友人设就算了，别瞎编
      authorPersona = npc?.persona || '';
      authorNameForPrompt = post.authorDisplayName || '网友';
    }

    const commenterName = commenterNameOverride || getCurrentForumDisplayName();
    if (commenterName === authorNameForPrompt) return; // 别自己回自己的评论

    const prompt = `
# 你的任务
你是"${authorNameForPrompt}"，人设：${authorPersona || '(没有详细人设，符合网友身份自由发挥)'}
这是你发的帖子：「${post.content}」
现在"${commenterName}"评论了你："${commentContent}"
请回复这条评论。

# 要求
【重要】像真人刷手机随手回复，不是写文章：大部分回复应该很短(一句话甚至几个字)，不用完整通顺、有头有尾，别用书面语。
只输出JSON对象，不要有其他文字：{"reply": "回复内容"}`;

    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请回复' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) return;
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]);
      if (!result.reply) return;

      // 稍微等一下再回复，看起来像真的在打字，不是秒回
      await new Promise(resolve => setTimeout(resolve, 1200 + Math.random() * 1800));

      const replyComment = {
        postId,
        authorType: post.authorType,
        authorId: post.authorId,
        content: result.reply,
        replyToName: commenterName,
        timestamp: Date.now(),
      };
      if (post.authorAltId) {
        replyComment.authorAltId = post.authorAltId;
        replyComment.authorDisplayName = post.authorDisplayName;
        replyComment.authorAvatar = post.authorAvatar;
      } else if (post.authorType === 'npc') {
        replyComment.authorDisplayName = post.authorDisplayName;
        replyComment.authorAvatar = post.authorAvatar || '';
      }
      await db.forumComments.add(replyComment);

      const freshPost = await db.forumPosts.get(postId);
      if (freshPost) {
        freshPost.commentCount = (freshPost.commentCount || 0) + 1;
        await db.forumPosts.put(freshPost);
      }
      if (window.forumActiveDetailPostId === postId) {
        await renderForumPostDetail();
      }
    } catch (e) {
      console.warn('[论坛] 帖主自动回复生成失败', e);
    }
  }
  window.maybeTriggerPostAuthorReply = maybeTriggerPostAuthorReply;


  // 手动触发给当前帖子生成一批网友评论(用现有网友人设，跟一键生成初始内容的评论逻辑类似，但只针对这一条帖子)
  async function generateCommentsForCurrentPost() {
    const postId = window.forumActiveDetailPostId;
    if (postId == null) return;
    const btn = document.getElementById('forum-generate-comments-btn');
    const post = await db.forumPosts.get(postId);
    if (!post) return;

    const npcs = await db.forumNpcs.toArray();
    if (npcs.length === 0) {
      alert('还没有网友，先去"管理网友"里加几个');
      return;
    }
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('还没配置API，去设置里先配一个');
      return;
    }

    const npcList = npcs.map(n => `- ${n.name}：${n.persona || '(没写详细人设，自由发挥)'}`).join('\n');
    const existingComments = (await db.forumComments.where('postId').equals(postId).toArray())
      .map(c => `- ${c.authorDisplayName || '网友'}：${c.content}`).join('\n');

    const prompt = `
# 帖子内容
${post.content}

# 已有评论(避免重复说一样的话)
${existingComments || '(暂无)'}

# 可用网友
${npcList}

# 任务
从上面网友里选几个(3-6个)，给这条帖子生成评论，风格要符合各自人设，内容真实自然，偶尔可以用replyTo回复其他网友(自己刚发的评论也可以，形成对话感)。

# 要求
1. 【重要】像真人刷论坛随手打字，不是写文章：大部分评论应该很短(一句话甚至几个字，比如"哈哈哈笑死""说得对""蹲一个")，不用每条都完整通顺、有头有尾，可以省略主语、用网络用语，不要用"我认为""确实如此"这类书面语。
2. 只输出JSON数组：[{"authorName": "网友名", "content": "评论内容", "replyTo": "被回复的网友名(可选)"}]`;

    const originalHtml = btn.innerHTML;
    btn.style.animation = 'spin 1s linear infinite';
    btn.disabled = true;
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成评论' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const comments = JSON.parse(jsonMatch[0]);
      const npcByName = {};
      npcs.forEach(n => { npcByName[n.name] = n; });

      let addedCount = 0;
      for (const c of comments) {
        if (!c.content) continue;
        const author = npcByName[c.authorName];
        await db.forumComments.add({
          postId,
          authorType: 'npc',
          authorId: `npc_${author ? author.id : 'unknown'}`,
          authorDisplayName: c.authorName || '网友',
          authorAvatar: author?.avatar || '',
          content: c.content,
          replyToName: c.replyTo || null,
          timestamp: Date.now(),
        });
        addedCount++;
      }

      const freshPost = await db.forumPosts.get(postId);
      if (freshPost) {
        freshPost.commentCount = (freshPost.commentCount || 0) + addedCount;
        await db.forumPosts.put(freshPost);
      }
      await renderForumPostDetail();

      // 挑最后一条有效评论，让帖主也可能回复一下(不用给每条评论都触发，避免刷屏)
      const lastValid = [...comments].reverse().find(c => c.content);
      if (lastValid) {
        maybeTriggerPostAuthorReply(postId, lastValid.content, lastValid.authorName).catch(e => console.warn('[论坛] 帖主回复失败', e));
      }
    } catch (e) {
      console.warn('[论坛] 生成评论失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.style.animation = '';
      btn.disabled = false;
    }
  }

  // ---------- 身份/小号 ----------
  // 当前发帖/评论用的身份：{type:'main'} 主账号，或 {type:'alt', id, name} 小号
  function getActiveForumIdentity() {
    try {
      return JSON.parse(localStorage.getItem('forum-active-identity')) || { type: 'main' };
    } catch (e) {
      return { type: 'main' };
    }
  }
  function setActiveForumIdentity(identity) {
    localStorage.setItem('forum-active-identity', JSON.stringify(identity));
  }
  // 根据当前身份返回要写入帖子/评论的作者字段
  async function buildAuthorFields() {
    const identity = getActiveForumIdentity();
    if (identity.type === 'alt') {
      const alt = await db.forumAlts.get(identity.id);
      return {
        authorType: 'user',
        authorId: 'user',
        authorAltId: identity.id,
        authorDisplayName: identity.name,
        authorAvatar: alt?.altAvatar || '',
      };
    }
    return { authorType: 'user', authorId: 'user' };
  }

  let pendingAltAvatar = null; // 创建小号时选中的头像

  function setAltAvatarPreview(url) {
    pendingAltAvatar = url || null;
    const wrap = document.getElementById('forum-alt-avatar-preview-wrap');
    const img = document.getElementById('forum-alt-avatar-preview');
    if (!wrap || !img) return;
    if (pendingAltAvatar) {
      img.src = pendingAltAvatar;
      wrap.style.display = 'block';
    } else {
      img.src = '';
      wrap.style.display = 'none';
    }
  }

  async function openForumIdentityModal() {
    const listEl = document.getElementById('forum-identity-list');
    if (!listEl) return;
    const alts = await db.forumAlts.where({ ownerType: 'user' }).toArray();
    const active = getActiveForumIdentity();
    setAltAvatarPreview(null);

    let html = `<div class="forum-identity-row${active.type === 'main' ? ' active' : ''}" data-type="main">
      <span>主账号</span>${active.type === 'main' ? '<span class="forum-identity-check">✓</span>' : ''}
    </div>`;
    alts.forEach(alt => {
      const isActive = active.type === 'alt' && active.id === alt.id;
      html += `<div class="forum-identity-row${isActive ? ' active' : ''}" data-type="alt" data-id="${alt.id}" data-name="${alt.altName}">
        <img class="forum-identity-avatar" src="${alt.altAvatar || FORUM_DEFAULT_AVATAR}"><span>${alt.altName}</span>${isActive ? '<span class="forum-identity-check">✓</span>' : ''}
      </div>`;
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.forum-identity-row').forEach(row => {
      row.addEventListener('click', () => {
        if (row.dataset.type === 'main') {
          setActiveForumIdentity({ type: 'main' });
        } else {
          setActiveForumIdentity({ type: 'alt', id: Number(row.dataset.id), name: row.dataset.name });
        }
        (function(){const m=document.getElementById('forum-identity-modal'); if(m) m.style.display='none';})();
      });
    });

    (function(){const m=document.getElementById('forum-identity-modal'); if(m) m.style.display='flex';})();
  }

  async function createForumAlt() {
    const input = document.getElementById('forum-new-alt-name-input');
    const name = input.value.trim();
    if (!name) return;
    const id = await db.forumAlts.add({ ownerType: 'user', ownerId: 'user', altName: name, altAvatar: pendingAltAvatar || '' });
    input.value = '';
    setAltAvatarPreview(null);
    setActiveForumIdentity({ type: 'alt', id, name });
    await openForumIdentityModal();
  }

  // char也可以有小号：目前先只做数据层，方便未来在角色设置里接一个管理界面；
  // 也可以直接在控制台调用 createForumCharAlt(chatId, '小号名', '头像url') 手动建
  async function createForumCharAlt(chatId, altName, altAvatar) {
    if (!chatId || !altName) return null;
    return db.forumAlts.add({ ownerType: 'char', ownerId: chatId, altName, altAvatar: altAvatar || '' });
  }
  window.createForumCharAlt = createForumCharAlt;

  // ---------- 角色小号管理弹窗 ----------
  let pendingCharAltAvatar = null;
  let activeCharAltChatId = null;

  function setCharAltAvatarPreview(url) {
    pendingCharAltAvatar = url || null;
    const wrap = document.getElementById('forum-char-alt-avatar-preview-wrap');
    const img = document.getElementById('forum-char-alt-avatar-preview');
    if (!wrap || !img) return;
    if (pendingCharAltAvatar) {
      img.src = pendingCharAltAvatar;
      wrap.style.display = 'block';
    } else {
      img.src = '';
      wrap.style.display = 'none';
    }
  }

  async function openForumCharAltModal() {
    (function(){const m=document.getElementById('forum-identity-modal'); if(m) m.style.display='none';})();
    const listEl = document.getElementById('forum-char-alt-chat-list');
    document.getElementById('forum-char-alt-editor').style.display = 'none';
    if (!listEl) return;

    const allAlts = await db.forumAlts.where({ ownerType: 'char' }).toArray();
    const altCountByChatId = {};
    allAlts.forEach(a => { altCountByChatId[a.ownerId] = (altCountByChatId[a.ownerId] || 0) + 1; });

    const chats = Object.values(state.chats).filter(c => !c.isGroup);
    listEl.innerHTML = chats.map(chat => {
      const count = altCountByChatId[chat.id] || 0;
      return `<div class="forum-identity-row" data-chat-id="${chat.id}">
        <span>${chat.name}${count > 0 ? ` <span style="color:#999; font-weight:400;">(${count}个小号)</span>` : ''}</span>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.forum-identity-row').forEach(row => {
      row.addEventListener('click', async () => {
        activeCharAltChatId = row.dataset.chatId;
        document.getElementById('forum-char-alt-editor-title').textContent = `"${state.chats[activeCharAltChatId]?.name}"的小号`;
        document.getElementById('forum-char-alt-name-input').value = '';
        setCharAltAvatarPreview(null);
        await renderForumCharAltExistingList();
        await renderForumCharAvatarPoolList();
        document.getElementById('forum-char-alt-editor').style.display = 'block';
      });
    });

    (function(){const m=document.getElementById('forum-char-alt-modal'); if(m) m.style.display='flex';})();
  }

  async function renderForumCharAltExistingList() {
    const listEl = document.getElementById('forum-char-alt-existing-list');
    if (!listEl || !activeCharAltChatId) return;
    const alts = await db.forumAlts.where({ ownerType: 'char', ownerId: activeCharAltChatId }).toArray();
    listEl.innerHTML = alts.map(a => `
      <div class="forum-identity-row">
        <img class="forum-identity-avatar" src="${a.altAvatar || FORUM_DEFAULT_AVATAR}">
        <span>${a.altName}</span>
        <span class="forum-board-delete-btn" data-alt-id="${a.id}" style="color:#c33; cursor:pointer; padding:0 4px;">删除</span>
      </div>
    `).join('') || '<p class="forum-empty-tip">还没有小号</p>';

    listEl.querySelectorAll('.forum-board-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await db.forumAlts.delete(Number(btn.dataset.altId));
        await renderForumCharAltExistingList();
      });
    });
  }

  async function saveForumCharAlt() {
    if (!activeCharAltChatId) return;
    const name = document.getElementById('forum-char-alt-name-input').value.trim();
    if (!name) return;

    await db.forumAlts.add({ ownerType: 'char', ownerId: activeCharAltChatId, altName: name, altAvatar: pendingCharAltAvatar || '' });

    document.getElementById('forum-char-alt-name-input').value = '';
    setCharAltAvatarPreview(null);
    await renderForumCharAltExistingList();
  }

  async function pickRandomPoolAvatarForCharAlt() {
    const url = await pickRandomCharPoolAvatar();
    if (!url) {
      alert('角色小号头像池还是空的，先批量上传/加几张进去');
      return;
    }
    setCharAltAvatarPreview(url);
  }

  // ---------- 板块管理 ----------
  async function refreshForumBoardsCache() {
    window.forumBoardsCache = await db.forumBoards.orderBy('order').toArray();
  }

  async function openForumBoardManageModal() {
    document.getElementById('forum-board-ai-suggestions').innerHTML = '';
    document.getElementById('forum-board-ai-theme-input').value = '';
    document.getElementById('forum-new-board-name-input').value = '';
    document.getElementById('forum-new-board-desc-input').value = '';
    document.getElementById('forum-new-board-worldview-input').value = '';
    await renderForumBoardExistingList();
    const modal = document.getElementById('forum-board-manage-modal');
    if (modal) modal.style.display = 'flex';
  }

  async function renderForumBoardExistingList() {
    const listEl = document.getElementById('forum-board-existing-list');
    if (!listEl) return;
    await refreshForumBoardsCache();
    const boards = window.forumBoardsCache;
    listEl.innerHTML = boards.map(b => `
      <div class="forum-identity-row">
        <span>${b.name}${b.description ? `<span style="color:#999; font-weight:400;"> · ${b.description}</span>` : ''}</span>
        <span class="forum-board-delete-btn" data-board-id="${b.id}" style="color:#c33; cursor:pointer; padding:0 4px;">删除</span>
      </div>
    `).join('') || '<p class="forum-empty-tip">还没有板块</p>';

    listEl.querySelectorAll('.forum-board-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('删除这个板块？板块下的帖子不会被删除，但会显示不出板块名')) return;
        await db.forumBoards.delete(Number(btn.dataset.boardId));
        await renderForumBoardExistingList();
        await refreshForumBoardsCache();
        renderForumBoardTabs();
      });
    });
  }

  async function createForumBoardManual() {
    const name = document.getElementById('forum-new-board-name-input').value.trim();
    if (!name) return;
    const description = document.getElementById('forum-new-board-desc-input').value.trim();
    const worldview = document.getElementById('forum-new-board-worldview-input').value.trim();
    const maxOrder = window.forumBoardsCache.reduce((max, b) => Math.max(max, b.order || 0), -1);
    await db.forumBoards.add({ name, description, worldview, order: maxOrder + 1 });

    document.getElementById('forum-new-board-name-input').value = '';
    document.getElementById('forum-new-board-desc-input').value = '';
    document.getElementById('forum-new-board-worldview-input').value = '';
    await renderForumBoardExistingList();
    await refreshForumBoardsCache();
    renderForumBoardTabs();
  }

  async function generateForumBoardSuggestions() {
    const btn = document.getElementById('forum-board-ai-generate-btn');
    const theme = document.getElementById('forum-board-ai-theme-input').value.trim();
    const suggestionsEl = document.getElementById('forum-board-ai-suggestions');
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('还没配置API，去设置里先配一个');
      return;
    }

    const existingNames = window.forumBoardsCache.map(b => b.name).join('、') || '(暂无)';
    const prompt = `
# 任务
帮论坛想几个新板块创意。现有板块：${existingNames}。${theme ? `用户想要的方向：${theme}` : '不限方向，自由发挥，风格多样一些'}

# 要求
1. 想5个新板块，不要跟现有板块重复或高度相似。
2. 每个板块要有一个简短有记忆点的名字(2-6字最佳)和一句话简介。
3. 只输出JSON数组，不要有其他文字：[{"name": "板块名", "description": "一句话简介"}]`;

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>生成中...</span>';
    btn.disabled = true;
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成板块建议' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const suggestions = JSON.parse(jsonMatch[0]);

      suggestionsEl.innerHTML = suggestions.map((s, i) => `
        <div class="forum-identity-row">
          <span>${s.name}<span style="color:#999; font-weight:400;"> · ${s.description || ''}</span></span>
          <span class="forum-board-add-suggestion-btn" data-index="${i}" style="color:#111; font-weight:700; cursor:pointer; padding:0 4px;">+ 添加</span>
        </div>
      `).join('');

      suggestionsEl.querySelectorAll('.forum-board-add-suggestion-btn').forEach(addBtn => {
        addBtn.addEventListener('click', async () => {
          const s = suggestions[Number(addBtn.dataset.index)];
          const maxOrder = window.forumBoardsCache.reduce((max, b) => Math.max(max, b.order || 0), -1);
          await db.forumBoards.add({ name: s.name, description: s.description || '', worldview: '', order: maxOrder + 1 });
          addBtn.textContent = '已添加';
          addBtn.style.pointerEvents = 'none';
          addBtn.style.color = '#999';
          await refreshForumBoardsCache();
          await renderForumBoardExistingList();
          renderForumBoardTabs();
        });
      });
    } catch (e) {
      console.warn('[论坛] 板块建议生成失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  // ---------- 热搜 ----------
  async function openForumHotTopicsScreen() {
    showScreen('forum-hottopics-screen');
    await renderForumHotTopicsList();
  }

  async function renderForumHotTopicsList() {
    const listEl = document.getElementById('forum-hottopics-list');
    if (!listEl) return;
    const topics = await db.forumHotTopics.orderBy('heat').reverse().toArray();
    if (topics.length === 0) {
      listEl.innerHTML = '<p class="forum-empty-tip">还没有热搜，点右上角刷新试试</p>';
      return;
    }
    listEl.innerHTML = topics.map((t, i) => `
      <div class="forum-hottopic-row" data-topic-id="${t.id}">
        <span class="forum-hottopic-rank${i < 3 ? ' top' : ''}">${i + 1}</span>
        <span class="forum-hottopic-keyword">#${t.keyword}#</span>
        <span class="forum-hottopic-heat">🔥${t.heat}</span>
      </div>
    `).join('');
    listEl.querySelectorAll('.forum-hottopic-row').forEach(row => {
      row.addEventListener('click', () => openForumHotTopicDetail(Number(row.dataset.topicId)));
    });
  }

  // 自动/手动都走这个函数：根据最近的论坛帖子内容，用AI提炼出热搜词条
  async function generateForumHotTopics() {
    const btn = document.getElementById('forum-hottopics-refresh-btn');
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      if (btn) alert('还没配置API，去设置里先配一个');
      return;
    }

    const recentPosts = await db.forumPosts.orderBy('timestamp').reverse().limit(30).toArray();
    if (recentPosts.length === 0) return;
    const postsText = recentPosts.map(p => `- ${(p.content || '').substring(0, 60)}`).join('\n');

    const prompt = `
# 任务
根据下面这些论坛帖子的内容，提炼出当前的热搜词条(类似微博热搜的感觉，词条要短、有冲击力/记忆点，不是简单复制帖子原句)。

# 帖子内容
${postsText}

# 要求
1. 提炼8-12个热搜词条，每个词条4-12字。
2. 每个词条给一个热度值(数字，1000-50000之间，越有梗/越多帖子提到的越高)。
3. 只输出JSON数组，不要有其他文字：[{"keyword": "词条", "heat": 数字}]`;

    if (btn) btn.style.animation = 'spin 1s linear infinite';
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成热搜' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const topics = JSON.parse(jsonMatch[0]);

      await db.forumHotTopics.clear(); // 每次刷新都是全新一榜，不叠加旧词条
      for (const t of topics) {
        if (!t.keyword) continue;
        await db.forumHotTopics.add({
          keyword: t.keyword,
          heat: Number(t.heat) || 1000,
          generatedAt: Date.now(),
          relatedPersonaSummary: '',
          relatedPostIds: [],
        });
      }
      await renderForumHotTopicsList();
    } catch (e) {
      console.warn('[论坛] 热搜生成失败', e);
      if (btn) alert(`热搜生成失败：${e.message || '未知错误'}`);
    } finally {
      if (btn) btn.style.animation = '';
    }
  }
  window.generateForumHotTopics = generateForumHotTopics;

  // 点进词条才生成"相关人物/相关帖子"，避免生成一堆没人点的内容
  async function openForumHotTopicDetail(topicId) {
    showScreen('forum-hottopic-detail-screen');
    const topic = await db.forumHotTopics.get(topicId);
    if (!topic) return;
    document.getElementById('forum-hottopic-detail-title').textContent = topic.keyword;
    const bodyEl = document.getElementById('forum-hottopic-detail-body');

    if (topic.relatedPersonaSummary) {
      renderForumHotTopicDetailBody(topic);
      return;
    }

    bodyEl.innerHTML = '<p class="forum-empty-tip">正在生成相关内容...</p>';
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      bodyEl.innerHTML = '<p class="forum-empty-tip">还没配置API，去设置里先配一个</p>';
      return;
    }

    const boards = window.forumBoardsCache.length > 0 ? window.forumBoardsCache : await db.forumBoards.orderBy('order').toArray();
    const prompt = `
# 任务
论坛正在热搜"${topic.keyword}"这个词条。请生成：
1. 一段简短的"围观群众怎么说"总结(2-3句话，模拟舆论氛围，不针对具体某个人)
2. 5到8条带着这个热搜话题的论坛帖子(风格多样，有人吃瓜/有人玩梗/有人认真讨论/有人反驳别人)
3. 每条帖子配3到6条真实感的评论(风格多样，偶尔可以用replyTo字段互相回复)

# 要求
只输出JSON对象：{"summary": "围观群众总结", "posts": [{"authorName": "网友昵称", "content": "帖子内容", "boardName": "板块名，从这些选：${boards.map(b => b.name).join('/')}", "comments": [{"authorName": "网友昵称", "content": "评论内容", "replyTo": "被回复的网友名(可选)"}]}]}
评论要像真人随手打字，大部分很短(一句话甚至几个字)，不用每条都完整通顺，别用书面语。`;

    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const result = JSON.parse(jsonMatch[0]);

      const newPostIds = [];
      for (const p of (result.posts || [])) {
        const board = boards.find(b => b.name === p.boardName) || boards[0];
        if (!board) continue;
        const comments = p.comments || [];
        // 热搜相关的帖子要有"爆款感"：夸张的点赞/评论基数，参考微博热搜内容的量级
        const baseLikes = Math.floor(Math.random() * 400000) + 10000; // 1万~41万
        const baseCommentCount = Math.floor(Math.random() * 15000) + 800; // 800~15800
        const id = await db.forumPosts.add({
          boardId: board.id,
          authorType: 'npc',
          authorId: `hottopic_${topicId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          authorDisplayName: p.authorName || '网友',
          authorAvatar: '',
          content: p.content || '',
          timestamp: Date.now(),
          likes: [],
          baseLikes,
          commentCount: comments.length,
          baseCommentCount,
        });
        for (const c of comments) {
          if (!c.content) continue;
          await db.forumComments.add({
            postId: id,
            authorType: 'npc',
            authorId: `hottopic_${topicId}_c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            authorDisplayName: c.authorName || '网友',
            authorAvatar: '',
            content: c.content,
            replyToName: c.replyTo || null,
            timestamp: Date.now(),
          });
        }
        newPostIds.push(id);
      }

      await db.forumHotTopics.update(topicId, {
        relatedPersonaSummary: result.summary || '',
        relatedPostIds: newPostIds,
      });
      const updatedTopic = await db.forumHotTopics.get(topicId);
      renderForumHotTopicDetailBody(updatedTopic);
    } catch (e) {
      console.warn('[论坛] 热搜详情生成失败', e);
      bodyEl.innerHTML = `<p class="forum-empty-tip">生成失败：${e.message || '未知错误'}</p>`;
    }
  }
  window.openForumHotTopicDetail = openForumHotTopicDetail;

  async function renderForumHotTopicDetailBody(topic) {
    const bodyEl = document.getElementById('forum-hottopic-detail-body');
    if (!bodyEl) return;

    let html = `<div class="forum-hottopic-summary">${topic.relatedPersonaSummary || ''}</div>`;
    const posts = await Promise.all((topic.relatedPostIds || []).map(id => db.forumPosts.get(id)));
    const validPosts = posts.filter(Boolean);

    bodyEl.innerHTML = html;
    for (const post of validPosts) {
      const boardName = getBoardNameById(post.boardId);
      const postEl = await createForumPostElement(post, boardName);
      bodyEl.appendChild(postEl);
    }
    if (validPosts.length === 0) {
      bodyEl.insertAdjacentHTML('beforeend', '<p class="forum-empty-tip">没有相关帖子</p>');
    }
  }

  // ---------- 转发帖子到聊天 ----------
  let pendingForwardPostId = null;

  async function openForumForwardModal(postId) {
    pendingForwardPostId = postId;
    const listEl = document.getElementById('forum-forward-chat-list');
    if (!listEl) return;

    const chats = Object.values(state.chats).filter(c => !c.isGroup); // 先只支持转发到单聊，群聊转发逻辑更复杂留待以后
    listEl.innerHTML = chats.map(c => `
      <div class="forum-forward-chat-row" data-chat-id="${c.id}">
        <img class="forum-forward-chat-avatar" src="${c.settings?.aiAvatar || FORUM_DEFAULT_AVATAR}">
        <span class="forum-forward-chat-name">${c.name}</span>
      </div>
    `).join('') || '<p class="forum-empty-tip">还没有可以转发的聊天</p>';

    listEl.querySelectorAll('.forum-forward-chat-row').forEach(row => {
      row.addEventListener('click', () => forwardForumPostToChat(row.dataset.chatId));
    });

    const modal = document.getElementById('forum-forward-modal');
    if (modal) modal.style.display = 'flex';
  }

  async function forwardForumPostToChat(chatId) {
    const postId = pendingForwardPostId;
    const chat = state.chats[chatId];
    if (!chat || postId == null) return;

    const post = await db.forumPosts.get(postId);
    if (!post) return;
    const author = resolveForumAuthor(post);
    const boardName = getBoardNameById(post.boardId);

    const shareMsg = {
      role: 'user',
      type: 'forum_post_share',
      forumPostId: postId,
      forumPostSnapshot: {
        authorName: author.name,
        avatar: author.avatar,
        boardName,
        content: post.content || '',
      },
      timestamp: Date.now(),
    };
    chat.history.push(shareMsg);
    await db.chats.put(chat);

    if (state.activeChatId === chatId && typeof appendMessage === 'function') {
      appendMessage(shareMsg, chat);
    }
    if (typeof renderChatList === 'function') renderChatList();

    const modal = document.getElementById('forum-forward-modal');
    if (modal) modal.style.display = 'none';
    pendingForwardPostId = null;
  }
  window.openForumForwardModal = openForumForwardModal;

  // ============================================================
  // 个人主页
  // ============================================================
  let activeProfileKey = null;
  let activeProfileInfo = null; // {name, avatar}

  async function openForumProfile(post) {
    activeProfileKey = getForumProfileKey(post);
    if (activeProfileKey.kind === 'unknown') return;
    activeProfileInfo = resolveForumAuthor(post);

    showScreen('forum-profile-screen');
    document.getElementById('forum-profile-avatar').src = activeProfileInfo.avatar || FORUM_DEFAULT_AVATAR;
    document.getElementById('forum-askbox-avatar').src = activeProfileInfo.avatar || FORUM_DEFAULT_AVATAR;
    document.getElementById('forum-profile-name').textContent = activeProfileInfo.name;
    document.getElementById('forum-askbox-input').placeholder = `请向${activeProfileInfo.name}匿名提问...`;

    // user自己的主页不需要私信按钮(不能私信自己)
    const dmBtn = document.getElementById('forum-profile-dm-btn');
    dmBtn.style.display = activeProfileKey.kind === 'user' ? 'none' : 'inline-flex';

    // 切回"帖子"tab
    document.querySelectorAll('.forum-profile-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'posts'));
    document.getElementById('forum-profile-posts-list').style.display = 'block';
    document.getElementById('forum-profile-askbox-area').style.display = 'none';

    await renderForumProfilePosts();
    await renderForumAskBoxList();
  }
  window.openForumProfile = openForumProfile;

  async function renderForumProfilePosts() {
    const listEl = document.getElementById('forum-profile-posts-list');
    if (!listEl || !activeProfileKey) return;
    const allPosts = await db.forumPosts.orderBy('timestamp').reverse().toArray();
    const myPosts = allPosts.filter(p => profileKeyMatches(p, activeProfileKey));

    const countEl = document.getElementById('forum-profile-post-count');
    if (countEl) countEl.textContent = myPosts.length;

    listEl.innerHTML = '';
    if (myPosts.length === 0) {
      listEl.innerHTML = '<p class="forum-empty-tip">还没有发过帖子</p>';
      return;
    }
    for (const post of myPosts) {
      const boardName = getBoardNameById(post.boardId);
      const postEl = await createForumPostElement(post, boardName);
      listEl.appendChild(postEl);
    }
  }

  // ---------- 提问箱 ----------
  async function renderForumAskBoxList() {
    const listEl = document.getElementById('forum-askbox-list');
    if (!listEl || !activeProfileKey) return;
    const all = await db.forumAskBoxQuestions.toArray();
    const mine = all
      .filter(q => q.targetKind === activeProfileKey.kind && q.targetKey === serializeProfileKey(activeProfileKey))
      .sort((a, b) => b.timestamp - a.timestamp);

    listEl.innerHTML = mine.map(q => `
      <div class="forum-askbox-item">
        <div class="forum-askbox-q">❓ ${q.question}</div>
        ${q.answer ? `<div class="forum-askbox-a">💬 ${q.answer}</div>` : '<div class="forum-widget-meta">还没回答</div>'}
      </div>
    `).join('') || '<p class="forum-empty-tip forum-askbox-empty">暂无提问</p>';
  }

  async function submitAskBoxQuestion() {
    const input = document.getElementById('forum-askbox-input');
    const question = input.value.trim();
    if (!question || !activeProfileKey) return;
    input.value = '';

    const targetKey = serializeProfileKey(activeProfileKey);
    const qId = await db.forumAskBoxQuestions.add({
      targetKind: activeProfileKey.kind,
      targetKey,
      question,
      answer: '',
      timestamp: Date.now(),
    });
    await renderForumAskBoxList();

    // 让对方(char/npc)当场回答，user自己的提问箱不用自动回答
    if (activeProfileKey.kind === 'user') return;
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) return;

    let persona = '';
    let name = activeProfileInfo?.name || '';
    if (activeProfileKey.kind === 'char') {
      persona = state.chats[activeProfileKey.chatId]?.settings?.aiPersona || '';
    } else if (activeProfileKey.kind === 'npc') {
      persona = (await db.forumNpcs.where('name').equals(activeProfileKey.name).first())?.persona || '';
    } else if (activeProfileKey.kind === 'alt') {
      const alt = await db.forumAlts.get(activeProfileKey.altId);
      if (alt?.ownerType === 'char') persona = state.chats[alt.ownerId]?.settings?.aiPersona || '';
    }

    const prompt = `
# 你的任务
你是"${name}"，人设：${persona || '(没有详细人设，自由发挥)'}
有人在你的提问箱里留了个问题："${question}"
请回答这个问题。

# 要求
像真人随手回复，简短自然，不用写成一大段。只输出JSON对象：{"answer": "回答内容"}`;

    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请回答' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'system', content: prompt }, ...messagesForApi], temperature: 1 }),
          });
      if (!response.ok) return;
      const data = await response.json();
      const raw = (isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]);
      if (!result.answer) return;
      await db.forumAskBoxQuestions.update(qId, { answer: result.answer });
      await renderForumAskBoxList();
    } catch (e) {
      console.warn('[论坛] 提问箱回答生成失败', e);
    }
  }

  // ============================================================
  // 私信
  // ============================================================
  async function findOrCreateDmThread(profileKey, participantInfo) {
    const participantId = serializeProfileKey(profileKey);
    let thread = await db.forumDMThreads.where({ participantId }).first();
    if (!thread) {
      const threadId = await db.forumDMThreads.add({
        participantType: profileKey.kind,
        participantId,
        participantName: participantInfo.name,
        participantAvatar: participantInfo.avatar || '',
        lastMessageTimestamp: Date.now(),
        lastMessagePreview: '',
      });
      thread = await db.forumDMThreads.get(threadId);
    }
    return thread;
  }

  async function openForumDmThread(profileKey, participantInfo) {
    const thread = await findOrCreateDmThread(profileKey, participantInfo);
    window.activeForumDmThreadId = thread.id;
    showScreen('forum-dm-thread-screen');
    document.getElementById('forum-dm-thread-title').textContent = thread.participantName;
    await renderForumDmThread();
  }

  async function renderForumDmThread() {
    const threadId = window.activeForumDmThreadId;
    const bodyEl = document.getElementById('forum-dm-thread-body');
    if (!bodyEl || threadId == null) return;
    const msgs = await db.forumDMs.where('threadId').equals(threadId).sortBy('timestamp');
    bodyEl.innerHTML = msgs.map(m => `
      <div class="forum-dm-msg ${m.senderType === 'user' ? 'forum-dm-msg-me' : 'forum-dm-msg-other'}">
        <div class="forum-dm-bubble">${m.content}</div>
      </div>
    `).join('') || '<p class="forum-empty-tip">开始聊天吧</p>';
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function submitForumDm() {
    const threadId = window.activeForumDmThreadId;
    const input = document.getElementById('forum-dm-input');
    const content = input.value.trim();
    if (!content || threadId == null) return;
    input.value = '';

    await db.forumDMs.add({ threadId, senderType: 'user', content, timestamp: Date.now() });
    const thread = await db.forumDMThreads.get(threadId);
    await db.forumDMThreads.update(threadId, { lastMessageTimestamp: Date.now(), lastMessagePreview: content });
    await renderForumDmThread();

    triggerDmReply(threadId, thread, content).catch(e => console.warn('[论坛] 私信回复失败', e));
  }
  window.submitForumDm = submitForumDm;

  async function triggerDmReply(threadId, thread, userMessage) {
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) return;
    const key = deserializeProfileKey(thread.participantId);

    let persona = '';
    if (key.kind === 'char') persona = state.chats[key.chatId]?.settings?.aiPersona || '';
    else if (key.kind === 'npc') persona = (await db.forumNpcs.where('name').equals(key.name).first())?.persona || '';
    else if (key.kind === 'alt') {
      const alt = await db.forumAlts.get(key.altId);
      if (alt?.ownerType === 'char') persona = state.chats[alt.ownerId]?.settings?.aiPersona || '';
    }

    const recentMsgs = await db.forumDMs.where('threadId').equals(threadId).sortBy('timestamp');
    const historyText = recentMsgs.slice(-10).map(m => `${m.senderType === 'user' ? '对方' : '你'}：${m.content}`).join('\n');

    const prompt = `
# 你的任务
你是"${thread.participantName}"，人设：${persona || '(没有详细人设，自由发挥)'}
这是你和对方在论坛私信里的对话记录：
${historyText}

请回复对方最新这条消息。

# 要求
像真人私聊打字，简短自然，不用完整通顺，可以分段的感觉但只输出一条回复。只输出JSON对象：{"reply": "回复内容"}`;

    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请回复' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'system', content: prompt }, ...messagesForApi], temperature: 1 }),
          });
      if (!response.ok) return;
      const data = await response.json();
      const raw = (isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]);
      if (!result.reply) return;

      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1500));
      await db.forumDMs.add({ threadId, senderType: 'other', content: result.reply, timestamp: Date.now() });
      await db.forumDMThreads.update(threadId, { lastMessageTimestamp: Date.now(), lastMessagePreview: result.reply });
      if (window.activeForumDmThreadId === threadId) await renderForumDmThread();
    } catch (e) {
      console.warn('[论坛] 私信AI回复生成失败', e);
    }
  }

  async function openForumDmInbox() {
    showScreen('forum-dm-inbox-screen');
    const listEl = document.getElementById('forum-dm-inbox-list');
    const threads = (await db.forumDMThreads.toArray()).sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
    listEl.innerHTML = threads.map(t => `
      <div class="forum-identity-row" data-thread-id="${t.id}">
        <img class="forum-identity-avatar" src="${t.participantAvatar || FORUM_DEFAULT_AVATAR}">
        <span style="flex:1;">${t.participantName}<span style="color:#999; font-weight:400; display:block; font-size:11.5px;">${t.lastMessagePreview || ''}</span></span>
      </div>
    `).join('') || '<p class="forum-empty-tip">还没有私信</p>';

    listEl.querySelectorAll('.forum-identity-row').forEach(row => {
      row.addEventListener('click', async () => {
        const threadId = Number(row.dataset.threadId);
        const thread = await db.forumDMThreads.get(threadId);
        window.activeForumDmThreadId = threadId;
        showScreen('forum-dm-thread-screen');
        document.getElementById('forum-dm-thread-title').textContent = thread.participantName;
        await renderForumDmThread();
      });
    });
  }

  // ---------- 一键批量生成初始内容 ----------
  async function openForumSeedModal() {
    document.getElementById('forum-identity-modal').style.display = 'none';
    const listEl = document.getElementById('forum-seed-char-list');
    const chats = Object.values(state.chats).filter(c => !c.isGroup);
    if (listEl) {
      listEl.innerHTML = chats.map(c => `
        <div class="forum-identity-row" style="cursor:default;">
          <label style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer;">
            <input type="checkbox" class="forum-seed-char-checkbox" data-chat-id="${c.id}" style="width:16px; height:16px;">
            <img class="forum-identity-avatar" src="${c.settings?.aiAvatar || FORUM_DEFAULT_AVATAR}" style="margin-right:0;">
            <span>${c.name}</span>
          </label>
        </div>
      `).join('') || '<p class="forum-empty-tip">还没有可选的角色</p>';
    }
    const modal = document.getElementById('forum-seed-modal');
    if (modal) modal.style.display = 'flex';
  }

  async function runForumSeedGeneration() {
    const btn = document.getElementById('forum-seed-generate-btn');
    const postMin = Math.max(1, parseInt(document.getElementById('forum-seed-post-min-input').value) || 12);
    const postMax = Math.max(postMin, parseInt(document.getElementById('forum-seed-post-max-input').value) || 24);
    const commentTarget = Math.max(0, parseInt(document.getElementById('forum-seed-comment-count-input').value) || 5);
    const includeChar = document.getElementById('forum-seed-include-char-checkbox').checked;
    const postCount = Math.floor(Math.random() * (postMax - postMin + 1)) + postMin;

    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('还没配置API，去设置里先配一个');
      return;
    }

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>生成中，别关页面...</span>';
    btn.disabled = true;

    try {
      // 网友数量不够就先自动补充几个，保证有足够的"人"来发帖回帖
      let npcs = await db.forumNpcs.toArray();
      if (npcs.length < 5) {
        await generateForumNpcsBatchSilent(8 - npcs.length);
        npcs = await db.forumNpcs.toArray();
      }

      const boards = await db.forumBoards.orderBy('order').toArray();
      const npcNamesAndPersonas = npcs.map(n => `- ${n.name}：${n.persona || '(没写详细人设，自由发挥)'}`).join('\n');

      const prompt = `
# 任务
你是论坛内容生成器，帮我批量生成一批论坛帖子+评论，让论坛看起来热闹真实。

# 可用网友(帖子和评论的作者都从这里选，也可以偶尔用同一个网友发多条)
${npcNamesAndPersonas}

# 可用板块
${boards.map(b => b.name).join('/')}

# 要求
1. 生成${postCount}条帖子，每条帖子配大约${commentTarget}条评论(可以上下浮动，不用每条都一样多)。
2. 帖子和评论都要符合对应网友的人设/说话风格，内容真实自然、风格多样(有认真讨论的、有玩梗的、有抬杠的、有安慰的)。
3. 评论里偶尔可以互相@/回复(用replyTo字段写被回复的网友名字，没有specific回复对象就留空)。
4. 【重要】评论要像真人刷手机随手打字：大部分应该很短(一句话甚至几个字)，不用每条都完整通顺、有头有尾，别用"我认为""确实如此"这类书面语，多用口语和网络用语。帖子本身可以稍微完整一点，但也别写成小作文。
5. 只输出JSON数组，不要有其他文字：
[{"boardName": "板块名", "authorName": "网友名", "content": "帖子内容", "widget": {...}(可选，只有少数帖子加就好), "comments": [{"authorName": "网友名", "content": "评论内容", "replyTo": "被回复的网友名(可选)"}]}]
${typeof FORUM_WIDGET_PROMPT_HINT === 'string' ? FORUM_WIDGET_PROMPT_HINT : ''}`;

      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请开始生成' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const posts = JSON.parse(jsonMatch[0]);

      const npcByName = {};
      npcs.forEach(n => { npcByName[n.name] = n; });

      for (const p of posts) {
        const board = boards.find(b => b.name === p.boardName) || boards[0];
        const author = npcByName[p.authorName];
        if (!board || !p.content) continue;

        const seedWidget = p.widget ? buildForumWidgetFromAIOutput(p.widget) : null;
        const postId = await db.forumPosts.add({
          boardId: board.id,
          authorType: 'npc',
          authorId: `npc_${author ? author.id : 'unknown'}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          authorDisplayName: p.authorName || '网友',
          authorAvatar: author?.avatar || '',
          content: p.content,
          timestamp: Date.now() - Math.floor(Math.random() * 72 * 3600000), // 随机分布在过去3天内，看起来不是同一秒炸出来的
          likes: [],
          commentCount: (p.comments || []).length,
          ...(seedWidget ? { widget: seedWidget } : {}),
        });

        for (const c of (p.comments || [])) {
          if (!c.content) continue;
          const cAuthor = npcByName[c.authorName];
          await db.forumComments.add({
            postId,
            authorType: 'npc',
            authorId: `npc_${cAuthor ? cAuthor.id : 'unknown'}`,
            authorDisplayName: c.authorName || '网友',
            authorAvatar: cAuthor?.avatar || '',
            content: c.content,
            replyToName: c.replyTo || null,
            timestamp: Date.now(),
          });
        }
      }

      // 也让角色用真实人设发几条帖子：勾选了具体角色就只让TA们发，一个都没勾就随机挑几个
      if (includeChar && typeof triggerCharForumPost === 'function') {
        const checkedIds = Array.from(document.querySelectorAll('.forum-seed-char-checkbox:checked')).map(cb => cb.dataset.chatId);
        let pickedChars;
        if (checkedIds.length > 0) {
          pickedChars = checkedIds.map(id => state.chats[id]).filter(Boolean);
        } else {
          const chars = Object.values(state.chats).filter(c => !c.isGroup);
          pickedChars = chars.sort(() => Math.random() - 0.5).slice(0, Math.min(3, chars.length));
        }
        for (const c of pickedChars) {
          await triggerCharForumPost(c.id).catch(e => console.warn('[论坛] 批量生成时角色发帖失败', e));
        }
      }

      await refreshForumBoardsCache();
      renderForumBoardTabs();
      await renderForumFeed();
      document.getElementById('forum-seed-modal').style.display = 'none';
      alert(`生成完毕！新增了${posts.length}条帖子`);
    } catch (e) {
      console.warn('[论坛] 批量生成初始内容失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  // 静默批量生成网友(不弹alert、不依赖弹窗里的输入框)，供一键生成初始内容时自动补充网友用
  async function generateForumNpcsBatchSilent(count) {
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) return;
    const existingNames = (await db.forumNpcs.toArray()).map(n => n.name).join('、') || '(暂无)';
    const prompt = `帮论坛生成${count}个"网友"账号人设，现有网友：${existingNames}，不要重复。每个网友要有昵称(2-8字)和persona(2-3句性格/说话风格描述)，风格要多样化。只输出JSON数组：[{"name": "昵称", "persona": "人设描述"}]`;
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'system', content: prompt }, ...messagesForApi], temperature: 1 }),
          });
      if (!response.ok) return;
      const data = await response.json();
      const raw = (isGemini ? data.candidates[0].content.parts[0].text : data.choices[0].message.content).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) return;
      const npcs = JSON.parse(jsonMatch[0]);
      for (const n of npcs) {
        if (!n.name) continue;
        await db.forumNpcs.add({
          name: n.name, persona: n.persona || '', avatar: await pickRandomPoolAvatar(),
          npcGroupId: null, enableBackgroundActivity: true, actionCooldownMinutes: 15, lastActionTimestamp: 0,
        });
      }
    } catch (e) {
      console.warn('[论坛] 自动补充网友失败', e);
    }
  }

  // ---------- 网友管理 ----------
  let pendingNpcAvatar = null;

  function setNpcAvatarPreview(url) {
    pendingNpcAvatar = url || null;
    const wrap = document.getElementById('forum-npc-avatar-preview-wrap');
    const img = document.getElementById('forum-npc-avatar-preview');
    if (!wrap || !img) return;
    if (pendingNpcAvatar) {
      img.src = pendingNpcAvatar;
      wrap.style.display = 'block';
    } else {
      img.src = '';
      wrap.style.display = 'none';
    }
  }

  async function openForumNpcManageModal() {
    document.getElementById('forum-identity-modal').style.display = 'none';
    setNpcAvatarPreview(null);
    document.getElementById('forum-npc-name-input').value = '';
    document.getElementById('forum-npc-persona-input').value = '';
    document.getElementById('forum-npc-cooldown-input').value = '15';
    await renderForumNpcExistingList();
    await renderForumAvatarPoolList();
    const modal = document.getElementById('forum-npc-manage-modal');
    if (modal) modal.style.display = 'flex';
  }

  async function renderForumNpcExistingList() {
    const listEl = document.getElementById('forum-npc-existing-list');
    if (!listEl) return;
    const npcs = await db.forumNpcs.toArray();
    listEl.innerHTML = npcs.map(n => `
      <div class="forum-identity-row">
        <img class="forum-identity-avatar" src="${n.avatar || FORUM_DEFAULT_AVATAR}">
        <span>${n.name}<span style="color:#999; font-weight:400;"> · ${(n.persona || '').slice(0, 20)}</span></span>
        <span class="forum-board-delete-btn" data-npc-id="${n.id}" style="color:#c33; cursor:pointer; padding:0 4px;">删除</span>
      </div>
    `).join('') || '<p class="forum-empty-tip">还没有网友，创建一个试试</p>';

    listEl.querySelectorAll('.forum-board-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('删除这个网友？TA发过的帖子/评论不会被删除')) return;
        await db.forumNpcs.delete(Number(btn.dataset.npcId));
        await renderForumNpcExistingList();
      });
    });
  }

  async function createForumNpc() {
    const name = document.getElementById('forum-npc-name-input').value.trim();
    if (!name) return;
    const persona = document.getElementById('forum-npc-persona-input').value.trim();
    const cooldown = Math.max(1, parseInt(document.getElementById('forum-npc-cooldown-input').value) || 15);

    await db.forumNpcs.add({
      name,
      persona,
      avatar: pendingNpcAvatar || '',
      npcGroupId: null,
      enableBackgroundActivity: true,
      actionCooldownMinutes: cooldown,
      lastActionTimestamp: 0,
    });

    document.getElementById('forum-npc-name-input').value = '';
    document.getElementById('forum-npc-persona-input').value = '';
    setNpcAvatarPreview(null);
    await renderForumNpcExistingList();
  }

  // ---------- 头像池(共享：网友+角色小号都从这里挑) ----------
  // 头像池按poolType分成 'npc'(网友) 和 'char'(角色小号) 两组，互不干扰
  // 老数据没有poolType字段的，一律当npc池处理(那是最早建的池子)
  async function addAvatarsToPool(urls, poolType = 'npc') {
    for (const url of urls) {
      if (url) await db.forumAvatarPool.add({ url, poolType });
    }
    await renderForumAvatarPoolList();
  }

  async function renderForumAvatarPoolList() {
    const listEl = document.getElementById('forum-avatar-pool-list');
    if (!listEl) return;
    const pool = (await db.forumAvatarPool.toArray()).filter(p => !p.poolType || p.poolType === 'npc');
    listEl.innerHTML = pool.map(p => `
      <div class="forum-avatar-pool-item" data-pool-id="${p.id}">
        <img src="${p.url}">
        <span class="forum-avatar-pool-remove">&times;</span>
      </div>
    `).join('') || '<p class="forum-empty-tip" style="padding:10px 0;">头像池是空的</p>';

    listEl.querySelectorAll('.forum-avatar-pool-item').forEach(item => {
      item.querySelector('.forum-avatar-pool-remove').addEventListener('click', async () => {
        await db.forumAvatarPool.delete(Number(item.dataset.poolId));
        await renderForumAvatarPoolList();
      });
    });
  }

  async function renderForumCharAvatarPoolList() {
    const listEl = document.getElementById('forum-char-avatar-pool-list');
    if (!listEl) return;
    const pool = (await db.forumAvatarPool.toArray()).filter(p => p.poolType === 'char');
    listEl.innerHTML = pool.map(p => `
      <div class="forum-avatar-pool-item" data-pool-id="${p.id}">
        <img src="${p.url}">
        <span class="forum-avatar-pool-remove">&times;</span>
      </div>
    `).join('') || '<p class="forum-empty-tip" style="padding:10px 0;">头像池是空的</p>';

    listEl.querySelectorAll('.forum-avatar-pool-item').forEach(item => {
      item.querySelector('.forum-avatar-pool-remove').addEventListener('click', async () => {
        await db.forumAvatarPool.delete(Number(item.dataset.poolId));
        await renderForumCharAvatarPoolList();
      });
    });
  }

  async function pickRandomPoolAvatar() {
    const pool = (await db.forumAvatarPool.toArray()).filter(p => !p.poolType || p.poolType === 'npc');
    if (pool.length === 0) return '';
    return pool[Math.floor(Math.random() * pool.length)].url;
  }

  async function pickRandomCharPoolAvatar() {
    const pool = (await db.forumAvatarPool.toArray()).filter(p => p.poolType === 'char');
    if (pool.length === 0) return '';
    return pool[Math.floor(Math.random() * pool.length)].url;
  }

  // ---------- AI批量生成网友 ----------
  async function generateForumNpcsBatch() {
    const btn = document.getElementById('forum-npc-batch-generate-btn');
    const count = Math.max(1, Math.min(20, parseInt(document.getElementById('forum-npc-batch-count-input').value) || 5));
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('还没配置API，去设置里先配一个');
      return;
    }

    const existingNames = (await db.forumNpcs.toArray()).map(n => n.name).join('、') || '(暂无)';
    const prompt = `
# 任务
帮论坛生成${count}个"网友"账号人设。现有网友：${existingNames}，不要跟这些重复或高度相似。

# 要求
1. 每个网友要有：昵称(2-8字，有网感)、persona(2-3句话描述性格/说话风格/常聊话题，越具体越好，方便之后照着这个人设发帖回帖)。
2. 网友风格要多样化：有人毒舌、有人温柔、有人爱抬杠、有人爱玩梗、有人一本正经，不要都长一个样。
3. 只输出JSON数组，不要有其他文字：[{"name": "昵称", "persona": "人设描述"}]`;

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>生成中...</span>';
    btn.disabled = true;
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成网友' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      const npcs = JSON.parse(jsonMatch[0]);

      for (const n of npcs) {
        if (!n.name) continue;
        await db.forumNpcs.add({
          name: n.name,
          persona: n.persona || '',
          avatar: await pickRandomPoolAvatar(), // 随机从头像池分配，池子空的话就是空字符串(走默认头像)
          npcGroupId: null,
          enableBackgroundActivity: true,
          actionCooldownMinutes: 15,
          lastActionTimestamp: 0,
        });
      }
      await renderForumNpcExistingList();
    } catch (e) {
      console.warn('[论坛] 批量生成网友失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  // 从一句话提示生成单个更详细的网友，先给预览、确认了才真正入库(避免手感不对还得删)
  let pendingNpcHintResult = null;

  async function generateForumNpcFromHint() {
    const btn = document.getElementById('forum-npc-hint-generate-btn');
    const hint = document.getElementById('forum-npc-hint-input').value.trim();
    if (!hint) { alert('先填一句描述'); return; }
    const apiConfig = state.apiConfig || {};
    if (!apiConfig.proxyUrl || !apiConfig.apiKey || !apiConfig.model) {
      alert('还没配置API，去设置里先配一个');
      return;
    }

    const prompt = `
# 任务
根据这句描述，帮论坛生成一个详细的"网友"账号人设：「${hint}」

# 要求
1. 想一个符合描述的昵称(2-8字，有网感，不要直接用描述里的词当昵称)。
2. persona要详细(4-6句话)：包含性格特点、说话语气/口头禅、常聊的话题方向、大概的价值观或槽点，让人一看就知道TA发帖/评论会是什么风格。
3. 只输出JSON对象，不要有其他文字：{"name": "昵称", "persona": "详细人设描述"}`;

    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>生成中...</span>';
    btn.disabled = true;
    try {
      const isGemini = apiConfig.proxyUrl.includes('generativelanguage');
      const messagesForApi = [{ role: 'user', content: '请生成' }];
      const geminiConfig = typeof toGeminiRequestData === 'function'
        ? toGeminiRequestData(apiConfig.model, apiConfig.apiKey, prompt, messagesForApi)
        : null;
      const response = isGemini && geminiConfig
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${apiConfig.proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
              model: apiConfig.model,
              messages: [{ role: 'system', content: prompt }, ...messagesForApi],
              temperature: 1,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = (isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
      ).replace(/```json\s*|```\s*$/g, '').trim();
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) throw new Error('AI没有返回有效格式');
      pendingNpcHintResult = JSON.parse(jsonMatch[0]);

      const previewEl = document.getElementById('forum-npc-hint-preview');
      previewEl.style.display = 'block';
      previewEl.innerHTML = `
        <div class="forum-identity-row" style="flex-direction:column; align-items:flex-start; gap:6px;">
          <span style="font-weight:700;">${pendingNpcHintResult.name}</span>
          <span style="color:#666; font-weight:400; font-size:12.5px; line-height:1.5;">${pendingNpcHintResult.persona}</span>
          <div style="display:flex; gap:10px; margin-top:4px;">
            <span id="forum-npc-hint-confirm-btn" style="color:#111; font-weight:700; cursor:pointer;">+ 添加这个网友</span>
            <span id="forum-npc-hint-regenerate-btn" style="color:#999; cursor:pointer;">重新生成</span>
          </div>
        </div>
      `;
      document.getElementById('forum-npc-hint-confirm-btn').addEventListener('click', async () => {
        if (!pendingNpcHintResult) return;
        await db.forumNpcs.add({
          name: pendingNpcHintResult.name,
          persona: pendingNpcHintResult.persona || '',
          avatar: await pickRandomPoolAvatar(),
          npcGroupId: null,
          enableBackgroundActivity: true,
          actionCooldownMinutes: 15,
          lastActionTimestamp: 0,
        });
        previewEl.style.display = 'none';
        previewEl.innerHTML = '';
        document.getElementById('forum-npc-hint-input').value = '';
        pendingNpcHintResult = null;
        await renderForumNpcExistingList();
      });
      document.getElementById('forum-npc-hint-regenerate-btn').addEventListener('click', generateForumNpcFromHint);
    } catch (e) {
      console.warn('[论坛] 从提示生成网友失败', e);
      alert(`生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }


  // ---------- 发帖(user) ----------
  let pendingForumImage = null; // 待发布帖子选中的图片(dataURL或外链URL)

  function setForumImagePreview(url) {
    pendingForumImage = url || null;
    const wrap = document.getElementById('forum-image-preview-wrap');
    const img = document.getElementById('forum-image-preview');
    if (!wrap || !img) return;
    if (pendingForumImage) {
      img.src = pendingForumImage;
      wrap.style.display = 'block';
    } else {
      img.src = '';
      wrap.style.display = 'none';
    }
  }

  let pendingQuotePostId = null;

  async function openForumCreatePostModal(quotePostId = null) {
    const modal = document.getElementById('forum-create-post-modal');
    const textarea = document.getElementById('forum-create-post-textarea');
    const select = document.getElementById('forum-create-post-board-select');
    const urlInput = document.getElementById('forum-image-url-input');
    if (!modal) return;
    textarea.value = '';
    setForumImagePreview(null);
    if (urlInput) { urlInput.value = ''; urlInput.style.display = 'none'; }
    if (select && window.forumActiveBoardId !== 'all') {
      select.value = String(window.forumActiveBoardId);
    }
    const widgetSelect = document.getElementById('forum-widget-type-select');
    if (widgetSelect) widgetSelect.value = '';
    renderWidgetConfigArea('');

    pendingQuotePostId = quotePostId;
    const quoteWrap = document.getElementById('forum-quote-preview-wrap');
    if (quotePostId) {
      const quotedPost = await db.forumPosts.get(quotePostId);
      if (quotedPost) {
        const author = resolveForumAuthor(quotedPost);
        const boardName = getBoardNameById(quotedPost.boardId);
        const previewText = (quotedPost.content || '').length > 80 ? quotedPost.content.slice(0, 80) + '...' : (quotedPost.content || '');
        document.getElementById('forum-quote-preview-content').innerHTML = `
          <div class="forum-quoted-card">
            <div class="forum-quoted-card-header">
              ${author.avatar ? `<img src="${author.avatar}" class="forum-share-card-avatar">` : ''}
              <span class="forum-share-card-name">${author.name}</span>
              ${boardName ? `<span class="forum-share-card-board">· ${boardName}</span>` : ''}
            </div>
            <div class="forum-quoted-card-content">${previewText}</div>
          </div>`;
        quoteWrap.style.display = 'block';
      }
    } else {
      quoteWrap.style.display = 'none';
      document.getElementById('forum-quote-preview-content').innerHTML = '';
    }

    modal.style.display = 'flex';
  }

  function closeForumCreatePostModal() {
    (function(){const m=document.getElementById('forum-create-post-modal'); if(m) m.style.display='none';})();
    pendingQuotePostId = null;
  }

  // ---------- 互动组件：发帖时的配置表单 ----------
  function renderWidgetConfigArea(type) {
    const area = document.getElementById('forum-widget-config-area');
    if (!area) return;
    const templates = {
      '': '',
      poll: `
        <div class="forum-board-section-title">投票选项(每行一个，2-6个)</div>
        <textarea id="forum-widget-poll-options" class="forum-post-textarea" rows="4" placeholder="选项A&#10;选项B&#10;选项C"></textarea>`,
      donation: `
        <div class="forum-board-section-title">众筹标题</div>
        <input type="text" id="forum-widget-donation-title" class="forum-image-url-input" placeholder="比如：帮我凑猫粮钱">
        <div class="forum-board-section-title">目标金额</div>
        <input type="number" id="forum-widget-donation-goal" class="forum-image-url-input" placeholder="100" min="1">`,
      chain: `
        <div class="forum-board-section-title">接龙主题(可选)</div>
        <input type="text" id="forum-widget-chain-prompt" class="forum-image-url-input" placeholder="比如：接一句歌词/续写故事">`,
      bounty: `
        <div class="forum-board-section-title">悬赏内容</div>
        <input type="text" id="forum-widget-bounty-prompt" class="forum-image-url-input" placeholder="比如：谁知道这是哪部电影的台词">
        <div class="forum-board-section-title">征集时长(小时)</div>
        <input type="number" id="forum-widget-bounty-hours" class="forum-image-url-input" placeholder="24" min="1" value="24">`,
      rating: `
        <div class="forum-board-section-title">评分维度(每行一个，2-5个)</div>
        <textarea id="forum-widget-rating-dims" class="forum-post-textarea" rows="3" placeholder="颜值&#10;性格&#10;才华"></textarea>`,
      dice: `<p class="forum-empty-tip" style="padding:8px 0; font-size:12.5px;">骰子不用配置，发布后大家可以点它掷1-6点</p>`,
      wheel: `
        <div class="forum-board-section-title">转盘选项(每行一个，2-8个)</div>
        <textarea id="forum-widget-wheel-options" class="forum-post-textarea" rows="4" placeholder="选项A&#10;选项B&#10;选项C"></textarea>`,
    };
    area.innerHTML = templates[type] || '';
  }

  function collectWidgetConfigFromForm() {
    const type = document.getElementById('forum-widget-type-select')?.value;
    if (!type) return null;

    if (type === 'poll') {
      const options = document.getElementById('forum-widget-poll-options').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) { alert('投票至少要2个选项'); return undefined; }
      return { type, data: { options }, state: { votes: options.map(() => 0), voters: [] } };
    }
    if (type === 'donation') {
      const title = document.getElementById('forum-widget-donation-title').value.trim() || '众筹';
      const goal = Number(document.getElementById('forum-widget-donation-goal').value) || 100;
      return { type, data: { title, goal }, state: { raised: 0, contributors: [] } };
    }
    if (type === 'chain') {
      const prompt = document.getElementById('forum-widget-chain-prompt').value.trim();
      return { type, data: { prompt }, state: { entries: [] } };
    }
    if (type === 'bounty') {
      const prompt = document.getElementById('forum-widget-bounty-prompt').value.trim();
      if (!prompt) { alert('悬赏内容不能为空'); return undefined; }
      const hours = Math.max(1, Number(document.getElementById('forum-widget-bounty-hours').value) || 24);
      return { type, data: { prompt, deadline: Date.now() + hours * 3600000 }, state: { submissions: [] } };
    }
    if (type === 'rating') {
      const dims = document.getElementById('forum-widget-rating-dims').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (dims.length < 2) { alert('评分维度至少要2个'); return undefined; }
      return { type, data: { dims }, state: { ratings: [] } };
    }
    if (type === 'dice') {
      return { type, data: {}, state: { history: [] } };
    }
    if (type === 'wheel') {
      const options = document.getElementById('forum-widget-wheel-options').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (options.length < 2) { alert('转盘至少要2个选项'); return undefined; }
      return { type, data: { options }, state: { history: [] } };
    }
    return null;
  }

  // AI配图：接你项目里 nai-imagen.js 已有的生图能力——
  // NovelAI(generateNaiImageFromPrompt)优先，没开就退到Google Imagen(generateGoogleImagenFromPrompt)，
  // 两个都没开的话给出明确提示，不静默失败
  window.generateForumPostImageViaAI = async function (prompt) {
    const novelaiEnabled = localStorage.getItem('novelai-enabled') === 'true';
    const googleImagenEnabled = localStorage.getItem('google-imagen-enabled') === 'true';

    if (novelaiEnabled && typeof window.generateNaiImageFromPrompt === 'function') {
      const result = await window.generateNaiImageFromPrompt(prompt, null); // 论坛帖子不挂在具体角色上，不传chatId走系统默认画师串
      return result.imageUrl;
    }
    if (googleImagenEnabled && typeof window.generateGoogleImagenFromPrompt === 'function') {
      const result = await window.generateGoogleImagenFromPrompt(prompt);
      return result.imageUrl;
    }
    throw new Error('没有开启的AI生图服务(NovelAI/Google Imagen都没开)，去对应设置里先开一个');
  };

  // AI配图：如果项目里其他地方已经接了图像生成，实现 window.generateForumPostImageViaAI(prompt)
  // 这个钩子函数即可直接生效；没接的话先友好提示，不报错
  async function handleForumAiImageBtn() {
    const textarea = document.getElementById('forum-create-post-textarea');
    if (typeof window.generateForumPostImageViaAI !== 'function') {
      alert('AI配图还没接入生成接口，可以先用"上传图片"或"图片链接"代替。\n(开发者：实现 window.generateForumPostImageViaAI(prompt) 这个函数即可让这个按钮生效)');
      return;
    }
    const prompt = textarea.value.trim() || '一张符合帖子氛围的配图';
    const btn = document.getElementById('forum-image-ai-btn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<span>生成中...</span>';
    btn.disabled = true;
    try {
      const url = await window.generateForumPostImageViaAI(prompt);
      if (url) setForumImagePreview(url);
    } catch (e) {
      console.warn('[论坛] AI配图生成失败', e);
      alert(`配图生成失败：${e.message || '未知错误'}`);
    } finally {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }

  function handleForumImageFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForumImagePreview(reader.result);
    reader.readAsDataURL(file);
    e.target.value = ''; // 允许连续选同一张图也能触发change
  }

  function handleForumImageUrlConfirm(e) {
    if (e.key && e.key !== 'Enter') return;
    const input = document.getElementById('forum-image-url-input');
    const url = input.value.trim();
    if (url) {
      setForumImagePreview(url);
      input.style.display = 'none';
      input.value = '';
    }
  }

  async function submitForumPost() {
    const textarea = document.getElementById('forum-create-post-textarea');
    const select = document.getElementById('forum-create-post-board-select');
    const content = textarea.value.trim();
    if (!content && !pendingForumImage) return; // 纯图片没文字也允许发，但两个都空就不让发

    const widget = collectWidgetConfigFromForm();
    if (widget === undefined) return; // 配置没填完整，collectWidgetConfigFromForm已经alert提示了，不发布

    const boardId = Number(select.value);
    const newPost = {
      boardId,
      ...(await buildAuthorFields()),
      content,
      timestamp: Date.now(),
      likes: [],
      commentCount: 0,
    };
    if (pendingForumImage) newPost.imageUrl = pendingForumImage;
    if (widget) newPost.widget = widget;
    if (pendingQuotePostId != null) {
      const quotedPost = await db.forumPosts.get(pendingQuotePostId);
      if (quotedPost) {
        const author = resolveForumAuthor(quotedPost);
        const boardName = getBoardNameById(quotedPost.boardId);
        newPost.quotedPostId = pendingQuotePostId;
        newPost.quotedPostSnapshot = {
          authorName: author.name,
          avatar: author.avatar,
          boardName,
          content: quotedPost.content || '',
        };
      }
    }
    await db.forumPosts.add(newPost);

    pendingQuotePostId = null;
    closeForumCreatePostModal();
    await renderForumFeed();
  }
  window.submitForumPost = submitForumPost;

  // ---------- 事件绑定 ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('forum-create-post-btn')?.addEventListener('click', () => openForumCreatePostModal());
    document.getElementById('forum-create-post-close-btn')?.addEventListener('click', closeForumCreatePostModal);
    document.getElementById('forum-widget-type-select')?.addEventListener('change', (e) => renderWidgetConfigArea(e.target.value));
    document.getElementById('forum-create-post-submit-btn')?.addEventListener('click', submitForumPost);

    document.getElementById('forum-image-ai-btn')?.addEventListener('click', handleForumAiImageBtn);
    document.getElementById('forum-image-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-image-file-input')?.click();
    });
    document.getElementById('forum-image-file-input')?.addEventListener('change', handleForumImageFileChange);
    document.getElementById('forum-image-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-image-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-image-url-input')?.addEventListener('keydown', handleForumImageUrlConfirm);
    document.getElementById('forum-image-remove-btn')?.addEventListener('click', () => setForumImagePreview(null));

    document.getElementById('forum-comment-send-btn')?.addEventListener('click', submitForumComment);
    document.getElementById('forum-comment-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitForumComment();
      }
    });

    document.getElementById('forum-identity-btn')?.addEventListener('click', openForumIdentityModal);
    document.getElementById('forum-identity-close-btn')?.addEventListener('click', () => {
      (function(){const m=document.getElementById('forum-identity-modal'); if(m) m.style.display='none';})();
    });
    document.getElementById('forum-new-alt-create-btn')?.addEventListener('click', createForumAlt);

    document.getElementById('forum-alt-avatar-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-alt-avatar-file-input')?.click();
    });
    document.getElementById('forum-alt-avatar-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setAltAvatarPreview(reader.result);
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    document.getElementById('forum-alt-avatar-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-alt-avatar-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-alt-avatar-url-input')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target;
      const url = input.value.trim();
      if (url) {
        setAltAvatarPreview(url);
        input.style.display = 'none';
        input.value = '';
      }
    });
    document.getElementById('forum-alt-avatar-remove-btn')?.addEventListener('click', () => setAltAvatarPreview(null));

    document.getElementById('forum-manage-char-alt-link')?.addEventListener('click', openForumCharAltModal);
    document.getElementById('forum-manage-npc-link')?.addEventListener('click', openForumNpcManageModal);
    document.getElementById('forum-npc-manage-close-btn')?.addEventListener('click', () => {
      const m = document.getElementById('forum-npc-manage-modal');
      if (m) m.style.display = 'none';
    });
    document.getElementById('forum-npc-create-btn')?.addEventListener('click', createForumNpc);
    document.getElementById('forum-npc-avatar-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-npc-avatar-file-input')?.click();
    });
    document.getElementById('forum-npc-avatar-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setNpcAvatarPreview(reader.result);
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    document.getElementById('forum-npc-avatar-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-npc-avatar-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-npc-avatar-url-input')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const url = e.target.value.trim();
      if (url) {
        setNpcAvatarPreview(url);
        e.target.style.display = 'none';
        e.target.value = '';
      }
    });
    document.getElementById('forum-npc-avatar-remove-btn')?.addEventListener('click', () => setNpcAvatarPreview(null));
    document.getElementById('forum-char-alt-close-btn')?.addEventListener('click', () => {
      (function(){const m=document.getElementById('forum-char-alt-modal'); if(m) m.style.display='none';})();
    });
    document.getElementById('forum-char-alt-save-btn')?.addEventListener('click', saveForumCharAlt);
    document.getElementById('forum-char-alt-avatar-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-char-alt-avatar-file-input')?.click();
    });
    document.getElementById('forum-char-alt-avatar-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => setCharAltAvatarPreview(reader.result);
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    document.getElementById('forum-char-alt-avatar-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-char-alt-avatar-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-char-alt-avatar-url-input')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const url = e.target.value.trim();
      if (url) {
        setCharAltAvatarPreview(url);
        e.target.style.display = 'none';
        e.target.value = '';
      }
    });
    document.getElementById('forum-char-alt-avatar-remove-btn')?.addEventListener('click', () => setCharAltAvatarPreview(null));

    document.getElementById('forum-board-manage-close-btn')?.addEventListener('click', () => {
      const m = document.getElementById('forum-board-manage-modal');
      if (m) m.style.display = 'none';
    });
    document.getElementById('forum-new-board-create-btn')?.addEventListener('click', createForumBoardManual);
    document.getElementById('forum-board-ai-generate-btn')?.addEventListener('click', generateForumBoardSuggestions);

    document.getElementById('forum-hottopics-btn')?.addEventListener('click', openForumHotTopicsScreen);
    document.getElementById('forum-hottopics-refresh-btn')?.addEventListener('click', generateForumHotTopics);

    document.getElementById('forum-forward-close-btn')?.addEventListener('click', () => {
      const m = document.getElementById('forum-forward-modal');
      if (m) m.style.display = 'none';
    });

    // 个人主页
    document.querySelectorAll('.forum-profile-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.forum-profile-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const isPosts = tab.dataset.tab === 'posts';
        document.getElementById('forum-profile-posts-list').style.display = isPosts ? 'block' : 'none';
        document.getElementById('forum-profile-askbox-area').style.display = isPosts ? 'none' : 'block';
      });
    });
    document.getElementById('forum-profile-dm-btn')?.addEventListener('click', () => {
      if (activeProfileKey && activeProfileInfo) openForumDmThread(activeProfileKey, activeProfileInfo);
    });
    document.getElementById('forum-askbox-submit-btn')?.addEventListener('click', submitAskBoxQuestion);
    document.getElementById('forum-askbox-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitAskBoxQuestion();
      }
    });

    // 私信
    document.getElementById('forum-dm-inbox-btn')?.addEventListener('click', openForumDmInbox);
    document.getElementById('forum-dm-send-btn')?.addEventListener('click', submitForumDm);
    document.getElementById('forum-dm-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitForumDm();
      }
    });

    // 网友管理：AI批量生成
    document.getElementById('forum-npc-batch-generate-btn')?.addEventListener('click', generateForumNpcsBatch);
    document.getElementById('forum-npc-hint-generate-btn')?.addEventListener('click', generateForumNpcFromHint);
    document.getElementById('forum-generate-comments-btn')?.addEventListener('click', generateCommentsForCurrentPost);

    // 头像池(网友管理弹窗里那个)
    document.getElementById('forum-pool-avatar-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-pool-avatar-file-input')?.click();
    });
    document.getElementById('forum-pool-avatar-file-input')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      const urls = await Promise.all(files.map(file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      })));
      await addAvatarsToPool(urls);
      e.target.value = '';
    });
    document.getElementById('forum-pool-avatar-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-pool-avatar-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-pool-avatar-url-input')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const url = e.target.value.trim();
      if (url) {
        await addAvatarsToPool([url]);
        e.target.style.display = 'none';
        e.target.value = '';
      }
    });

    // 角色小号弹窗里也能批量传头像到同一个池子
    document.getElementById('forum-char-alt-avatar-frompool-btn')?.addEventListener('click', pickRandomPoolAvatarForCharAlt);
    document.getElementById('forum-char-alt-pool-upload-btn')?.addEventListener('click', () => {
      document.getElementById('forum-char-alt-pool-file-input')?.click();
    });
    document.getElementById('forum-char-alt-pool-file-input')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      const urls = await Promise.all(files.map(file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      })));
      for (const url of urls) { if (url) await db.forumAvatarPool.add({ url, poolType: 'char' }); }
      await renderForumCharAvatarPoolList();
      alert(`已加入角色小号头像池${urls.length}张`);
      e.target.value = '';
    });
    document.getElementById('forum-char-alt-pool-url-btn')?.addEventListener('click', () => {
      const input = document.getElementById('forum-char-alt-pool-url-input');
      if (!input) return;
      input.style.display = input.style.display === 'none' ? 'block' : 'none';
      if (input.style.display === 'block') input.focus();
    });
    document.getElementById('forum-char-alt-pool-url-input')?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const url = e.target.value.trim();
      if (url) {
        await db.forumAvatarPool.add({ url, poolType: 'char' });
        await renderForumCharAvatarPoolList();
        e.target.style.display = 'none';
        e.target.value = '';
      }
    });

    // 一键生成初始内容
    document.getElementById('forum-manage-seed-link')?.addEventListener('click', openForumSeedModal);
    document.getElementById('forum-seed-close-btn')?.addEventListener('click', () => {
      const m = document.getElementById('forum-seed-modal');
      if (m) m.style.display = 'none';
    });
    document.getElementById('forum-seed-generate-btn')?.addEventListener('click', runForumSeedGeneration);
  });
})();
