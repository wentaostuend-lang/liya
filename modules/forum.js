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
    tabsEl.innerHTML = html;

    tabsEl.querySelectorAll('.forum-board-tab').forEach(tabBtn => {
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
      return {
        name: state.qzoneSettings?.nickname || state.forumSettings?.userNickname || '我',
        avatar: state.qzoneSettings?.avatar || FORUM_DEFAULT_AVATAR,
      };
    }
    if (post.authorType === 'char') {
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

    el.innerHTML = `
      <div class="forum-post-header">
        <img class="forum-post-avatar" src="${author.avatar}" alt="${author.name}">
        <div class="forum-post-meta">
          <span class="forum-post-name">${author.name}</span>
          <span class="forum-post-sub">${boardName ? boardName + ' · ' : ''}${timeText}</span>
        </div>
      </div>
      <div class="forum-post-content">${contentHtml}</div>
      <div class="forum-post-footer">
        <span class="forum-post-action forum-like-btn">♡ <span class="forum-like-count">${(post.likes || []).length || ''}</span></span>
        <span class="forum-post-action forum-comment-btn">💬 <span class="forum-comment-count">${post.commentCount || ''}</span></span>
      </div>
    `;

    el.querySelector('.forum-like-btn').addEventListener('click', () => toggleForumLike(post.id, el));
    el.querySelector('.forum-comment-btn').addEventListener('click', () => openForumPostDetail(post.id));
    el.querySelector('.forum-post-content').addEventListener('click', () => openForumPostDetail(post.id));

    return el;
  }

  async function toggleForumLike(postId, el) {
    const post = await db.forumPosts.get(postId);
    if (!post) return;
    const myKey = 'user';
    post.likes = post.likes || [];
    const idx = post.likes.indexOf(myKey);
    if (idx >= 0) {
      post.likes.splice(idx, 1);
    } else {
      post.likes.push(myKey);
    }
    await db.forumPosts.put(post);
    const countEl = el.querySelector('.forum-like-count');
    if (countEl) countEl.textContent = post.likes.length || '';
    el.querySelector('.forum-like-btn').classList.toggle('liked', idx < 0);
  }

  // 帖子详情页留到第2步(接评论/网友回复)时再完整实现，这里先占位跳转
  function openForumPostDetail(postId) {
    console.log('[论坛] 打开帖子详情', postId, '（详情页将在下一步接入评论/网友回复时完善）');
  }
  window.openForumPostDetail = openForumPostDetail;

  // ---------- 发帖(user) ----------
  function openForumCreatePostModal() {
    const modal = document.getElementById('forum-create-post-modal');
    const textarea = document.getElementById('forum-create-post-textarea');
    const select = document.getElementById('forum-create-post-board-select');
    if (!modal) return;
    textarea.value = '';
    if (select && window.forumActiveBoardId !== 'all') {
      select.value = String(window.forumActiveBoardId);
    }
    modal.classList.add('active');
  }

  function closeForumCreatePostModal() {
    document.getElementById('forum-create-post-modal')?.classList.remove('active');
  }

  async function submitForumPost() {
    const textarea = document.getElementById('forum-create-post-textarea');
    const select = document.getElementById('forum-create-post-board-select');
    const content = textarea.value.trim();
    if (!content) return;

    const boardId = Number(select.value);
    await db.forumPosts.add({
      boardId,
      authorType: 'user',
      authorId: 'user',
      content,
      timestamp: Date.now(),
      likes: [],
      commentCount: 0,
    });

    closeForumCreatePostModal();
    await renderForumFeed();
  }
  window.submitForumPost = submitForumPost;

  // ---------- 事件绑定 ----------
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('forum-create-post-btn')?.addEventListener('click', openForumCreatePostModal);
    document.getElementById('forum-create-post-close-btn')?.addEventListener('click', closeForumCreatePostModal);
    document.getElementById('forum-create-post-submit-btn')?.addEventListener('click', submitForumPost);
  });
})();
