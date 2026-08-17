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
      authorType: 'user',
      authorId: 'user',
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
    modal.classList.add('active');
  }

  function closeForumCreatePostModal() {
    document.getElementById('forum-create-post-modal')?.classList.remove('active');
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
      authorType: 'user',
      authorId: 'user',
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
  });
})();
