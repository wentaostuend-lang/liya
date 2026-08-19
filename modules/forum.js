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

  function getBoardNameById(boardId) {
    const board = window.forumBoardsCache.find(b => b.id === boardId);
    return board ? board.name : '';
  }

  // 统一解析作者信息：目前只有 user / char 两种authorType（网友NPC等到第2步接进来）
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

    const likeCount = (post.likes || []).length;
    const commentCount = post.commentCount || 0;
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
      <div class="forum-post-footer">
        <div class="forum-post-actions-left">
          <span class="forum-post-action forum-like-btn${liked ? ' liked' : ''}">${ICON_HEART(liked)}</span>
          <span class="forum-post-action forum-comment-btn">${ICON_COMMENT}</span>
          <span class="forum-post-action forum-share-btn">${ICON_SHARE}</span>
        </div>
        <span class="forum-post-action forum-bookmark-btn">${ICON_BOOKMARK}</span>
      </div>
      <div class="forum-post-engagement">
        ${likeCount > 0 ? `<span class="forum-like-count-text">${likeCount}人点赞</span>` : ''}
        ${commentCount > 0 ? `<span class="forum-comment-count-text">查看全部${commentCount}条评论</span>` : ''}
      </div>
    `;

    el.querySelector('.forum-like-btn').addEventListener('click', () => toggleForumLike(post.id, el));
    el.querySelector('.forum-comment-btn').addEventListener('click', () => openForumPostDetail(post.id));
    el.querySelector('.forum-post-content').addEventListener('click', () => openForumPostDetail(post.id));
    el.querySelector('.forum-share-btn').addEventListener('click', () => openForumForwardModal(post.id));

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
      ${likeCount > 0 ? `<span class="forum-like-count-text">${likeCount}人点赞</span>` : ''}
      ${commentCount > 0 ? `<span class="forum-comment-count-text">查看全部${commentCount}条评论</span>` : ''}
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
  }

  function renderForumCommentHtml(comment) {
    const author = resolveForumAuthor({ authorType: comment.authorType, authorId: comment.authorId, authorDisplayName: comment.authorDisplayName, authorAvatar: comment.authorAvatar });
    const timeText = typeof formatPostTimestamp === 'function' ? formatPostTimestamp(comment.timestamp) : new Date(comment.timestamp).toLocaleString();
    const contentHtml = typeof parseMarkdown === 'function'
      ? parseMarkdown(comment.content || '').replace(/\n/g, '<br>')
      : (comment.content || '').replace(/\n/g, '<br>');
    const replyToHtml = comment.replyToName ? `<span class="forum-comment-reply-to">回复 @${comment.replyToName}：</span>` : '';
    return `
      <div class="forum-comment-item">
        <img class="forum-comment-avatar" src="${author.avatar}" alt="${author.name}">
        <div class="forum-comment-main">
          <span class="forum-comment-name">${author.name}</span>
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
  }
  window.submitForumComment = submitForumComment;

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
    const pool = await db.forumAvatarPool.toArray();
    if (pool.length === 0) {
      alert('头像池还是空的，先批量上传/加几张进去');
      return;
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    setCharAltAvatarPreview(picked.url);
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
        <span class="forum-hottopic-keyword">${t.keyword}</span>
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
1. 提炼5-8个热搜词条，每个词条4-12字。
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
只输出JSON对象：{"summary": "围观群众总结", "posts": [{"authorName": "网友昵称", "content": "帖子内容", "boardName": "板块名，从这些选：${boards.map(b => b.name).join('/')}", "comments": [{"authorName": "网友昵称", "content": "评论内容", "replyTo": "被回复的网友名(可选)"}]}]}`;

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
        const id = await db.forumPosts.add({
          boardId: board.id,
          authorType: 'npc',
          authorId: `hottopic_${topicId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          authorDisplayName: p.authorName || '网友',
          authorAvatar: '',
          content: p.content || '',
          timestamp: Date.now(),
          likes: [],
          commentCount: comments.length,
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

  // ---------- 一键批量生成初始内容 ----------
  async function openForumSeedModal() {
    document.getElementById('forum-identity-modal').style.display = 'none';
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
4. 只输出JSON数组，不要有其他文字：
[{"boardName": "板块名", "authorName": "网友名", "content": "帖子内容", "comments": [{"authorName": "网友名", "content": "评论内容", "replyTo": "被回复的网友名(可选)"}]}]`;

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

      // 也让几个现有角色用真实人设发几条帖子(复用background-activity.js里已有的triggerCharForumPost)
      if (includeChar && typeof triggerCharForumPost === 'function') {
        const chars = Object.values(state.chats).filter(c => !c.isGroup);
        const pickedChars = chars.sort(() => Math.random() - 0.5).slice(0, Math.min(3, chars.length));
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
  async function addAvatarsToPool(urls) {
    for (const url of urls) {
      if (url) await db.forumAvatarPool.add({ url });
    }
    await renderForumAvatarPoolList();
  }

  async function renderForumAvatarPoolList() {
    const listEl = document.getElementById('forum-avatar-pool-list');
    if (!listEl) return;
    const pool = await db.forumAvatarPool.toArray();
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

  async function pickRandomPoolAvatar() {
    const pool = await db.forumAvatarPool.toArray();
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

  function openForumCreatePostModal() {
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
    modal.style.display = 'flex';
  }

  function closeForumCreatePostModal() {
    (function(){const m=document.getElementById('forum-create-post-modal'); if(m) m.style.display='none';})();
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
    await db.forumPosts.add(newPost);

    closeForumCreatePostModal();
    await renderForumFeed();
  }
  window.submitForumPost = submitForumPost;

  // ---------- 事件绑定 ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('forum-create-post-btn')?.addEventListener('click', openForumCreatePostModal);
    document.getElementById('forum-create-post-close-btn')?.addEventListener('click', closeForumCreatePostModal);
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

    // 网友管理：AI批量生成
    document.getElementById('forum-npc-batch-generate-btn')?.addEventListener('click', generateForumNpcsBatch);

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
      for (const url of urls) { if (url) await db.forumAvatarPool.add({ url }); }
      alert(`已加入头像池${urls.length}张`);
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
        await db.forumAvatarPool.add({ url });
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
