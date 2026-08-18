// ========== 后台活动模块 ==========
// 来源：script.js 第 21043~21384, 37449~37788, 47205~47250 行
// 功能：后台模拟活动、NPC行动生成、后台保活、页面可见性处理
// 包含：startBackgroundSimulation, stopBackgroundSimulation, runBackgroundSimulationTick,
//       generateNpcActions, simulateBackgroundActivity, initializeBackgroundKeepAlive,
//       startBackgroundKeepAlive, stopBackgroundKeepAlive, handleVisibilityChange,
//       bindBackgroundKeepAliveEvents, loadBackgroundKeepAliveSettings

  // 计算下一次后台活动触发前的等待时间（毫秒）
  // 模式由 state.globalSettings.backgroundActivityMode 决定：
  //   'fixed'  → 固定间隔，读取 backgroundActivityInterval（单位：秒），未配置默认 60 秒
  //   'random' → 随机区间，读取 backgroundActivityIntervalMin / Max（单位：分钟），未配置默认 10~25 分钟
  // 未设置 mode 时默认按 'random' 处理（保持当前版本的行为）
  function getNextBackgroundIntervalMs() {
    const mode = state.globalSettings.backgroundActivityMode || 'random';

    if (mode === 'fixed') {
      const intervalSeconds = Number(state.globalSettings.backgroundActivityInterval) || 60;
      return intervalSeconds * 1000;
    }

    const minMinutes = Number(state.globalSettings.backgroundActivityIntervalMin) || 10;
    const maxMinutes = Number(state.globalSettings.backgroundActivityIntervalMax) || 25;
    const lower = Math.min(minMinutes, maxMinutes);
    const upper = Math.max(minMinutes, maxMinutes);
    const randomMinutes = lower + Math.random() * (upper - lower);
    return randomMinutes * 60 * 1000;
  }

  function startBackgroundSimulation() {
    if (simulationIntervalId) return;
    scheduleNextBackgroundSimulationTick();
    playSilentAudio();
  }

  // 排定下一次 tick：固定模式下每次间隔相同；随机模式下每次重新随机
  function scheduleNextBackgroundSimulationTick() {
    const delayMs = getNextBackgroundIntervalMs();
    const mode = state.globalSettings.backgroundActivityMode || 'random';
    console.log(mode === 'fixed'
      ? `[后台活动] 固定间隔，下一次将在 ${(delayMs / 1000).toFixed(0)} 秒后触发`
      : `[后台活动] 随机间隔，下一次将在约 ${(delayMs / 60000).toFixed(1)} 分钟后触发`);

    simulationIntervalId = setTimeout(async () => {
      await runBackgroundSimulationTick();
      // tick 内部若检测到总开关已关闭，会调用 stopBackgroundSimulation 把 simulationIntervalId 置空
      if (state.globalSettings.enableBackgroundActivity) {
        scheduleNextBackgroundSimulationTick();
      } else {
        simulationIntervalId = null;
      }
    }, delayMs);
  }

  function stopBackgroundSimulation() {
    if (simulationIntervalId) {
      clearTimeout(simulationIntervalId);
      simulationIntervalId = null;
    }
    stopSilentAudio();
  }




  // 判断某个角色/群聊是否到了它自己的随机检查间隔（不影响冷却时间的判断，两者独立叠加）
  // 到点后会重新随机排定下一次检查时间，并持久化保存
  function isDueForRandomIntervalCheck(chat) {
    const now = Date.now();
    if (chat.nextCheckTimestamp && now < chat.nextCheckTimestamp) {
      return false; // 还没到这个角色自己的随机检查时间
    }
    const intervalMin = Number(chat.settings.randomIntervalMin) || 10;
    const intervalMax = Number(chat.settings.randomIntervalMax) || 25;
    const lower = Math.min(intervalMin, intervalMax);
    const upper = Math.max(intervalMin, intervalMax);
    const randomMinutes = lower + Math.random() * (upper - lower);
    chat.nextCheckTimestamp = now + randomMinutes * 60 * 1000;
    // 持久化保存，避免刷新页面后随机排期丢失（不阻塞主流程，失败也不影响本次判断）
    if (typeof db !== 'undefined' && db.chats) {
      db.chats.put(chat).catch(() => {});
    }
    return true;
  }

  async function runBackgroundSimulationTick() {
    console.log("模拟器心跳 Tick...");
    if (!state.globalSettings.enableBackgroundActivity) {
      stopBackgroundSimulation();
      return;
    }


    const allSingleChats = Object.values(state.chats).filter(chat => !chat.isGroup);
    runForumNpcTick(); // 论坛网友回复/发帖，不依赖具体某个chat，每次心跳独立跑一次
    allSingleChats.forEach(chat => {
      if (chat.relationship?.status === 'blocked_by_user') {
        const blockedTimestamp = chat.relationship.blockedTimestamp;
        if (!blockedTimestamp) return;
        const blockedDuration = Date.now() - blockedTimestamp;
        const cooldownMilliseconds = (state.globalSettings.blockCooldownHours || 1) * 60 * 60 * 1000;
        if (blockedDuration > cooldownMilliseconds) {
          chat.relationship.status = 'pending_system_reflection';
          triggerAiFriendApplication(chat.id);
        }
      } else if (chat.relationship?.status === 'friend' && chat.id !== state.activeChatId) {
        if (chat.settings.enableBackgroundActivity === false) {
          console.log(`角色 "${chat.name}" 的独立后台活动开关已关闭，本次跳过。`);
          return;
        }
        // 每个角色有自己的随机检查间隔，没到点就先不评估这次心跳
        if (!isDueForRandomIntervalCheck(chat)) {
          return;
        }
        if (Math.random() < 0.20) {
          console.log(`角色 "${chat.name}" 被唤醒，准备独立行动...`);
          triggerInactiveAiAction(chat.id);
        }
        // 论坛：独立小概率触发角色自己发帖(不依赖triggerInactiveAiAction，自成一路)
        if (Math.random() < 0.06) {
          triggerCharForumPost(chat.id).catch(e => console.warn('[论坛] 角色后台发帖失败', e));
        }
        // 检查是否可以帮助用户清空购物车
        checkAndClearShoppingCart(chat.id);
        // 情侣空间 AI 自主决定模式 - 后台触发
        if (typeof triggerCoupleSpaceAiDecide === 'function') {
          try { triggerCoupleSpaceAiDecide(chat.id, 'background'); } catch(e) {}
        }
      }
    });


    const allGroupChats = Object.values(state.chats).filter(chat => chat.isGroup);
    allGroupChats.forEach(chat => {
      if (chat.settings.enableBackgroundActivity === false) {
        console.log(`群聊 "${chat.name}" 的后台活动开关已关闭，本次跳过。`);
        return;
      }
      // 群聊同样按自己的随机间隔来判断是否该检查
      if (!isDueForRandomIntervalCheck(chat)) {
        return;
      }
      if (chat.id !== state.activeChatId && Math.random() < 0.10) {
        console.log(`群聊 "${chat.name}" 被唤醒，准备独立行动...`);
        triggerGroupAiAction(chat.id);
      }
    });



    try {
      const allNpcs = await db.npcs.toArray();
      if (allNpcs.length === 0) return;

      const allRecentPosts = await db.qzonePosts.orderBy('timestamp').reverse().limit(10).toArray();

      for (const npc of allNpcs) {
        if (npc.enableBackgroundActivity === false) continue;
        const cooldownMinutes = npc.actionCooldownMinutes || 15;
        if (npc.lastActionTimestamp) {
          const minutesSinceLastAction = (Date.now() - npc.lastActionTimestamp) / (1000 * 60);
          if (minutesSinceLastAction < cooldownMinutes) {
            continue;
          }
        }
        if (Math.random() > 0.3) continue;


        const tasks = [];
        for (const post of allRecentPosts) {

          if (post.authorId === `npc_${npc.id}`) continue;


          const isRepliedTo = post.comments?.some(c => c.replyTo === npc.name);


          const lastCommenter = post.comments?.slice(-1)[0]?.commenterName;
          if (lastCommenter === npc.name) continue;

          let isVisible = false;


          if (post.authorId === 'user' || post.authorId.startsWith('chat_')) {
            if (npc.associatedWith.includes(post.authorId)) {
              isVisible = true;
            }
          } else if (post.authorId.startsWith('npc_')) {
            const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
            const authorNpc = await db.npcs.get(authorNpcId);


            if (authorNpc) {
              const npc1_group = npc.npcGroupId;
              const npc2_group = authorNpc.npcGroupId;


              if (npc1_group && npc2_group && npc1_group === npc2_group) {
                isVisible = true;
              }
            }
          }

          if (isVisible || isRepliedTo) {
            tasks.push(post);
          }
        }



        if (tasks.length > 0 || Math.random() < 0.2) {
          console.log(`NPC "${npc.name}" 触发行动决策...`);
          const generatedActions = await generateNpcActions(npc, tasks);

          if (generatedActions && generatedActions.length > 0) {
            for (const action of generatedActions) {
              if (action.type === 'qzone_comment') {

                const post = await db.qzonePosts.get(action.postId);
                if (post) {
                  if (!post.comments) post.comments = [];
                  post.comments.push({
                    commenterName: npc.name,
                    text: action.commentText,
                    replyTo: action.replyTo || null,
                    timestamp: Date.now() + Math.random()
                  });
                  await db.qzonePosts.update(action.postId, {
                    comments: post.comments
                  });
                  updateUnreadIndicator(unreadPostsCount + 1);
                }
              } else if (action.type === 'qzone_post') {

                const newPost = {
                  type: action.postType || 'shuoshuo',
                  content: action.content,
                  timestamp: Date.now(),
                  authorId: `npc_${npc.id}`,
                  authorOriginalName: npc.name,
                  visibleTo: npc.associatedWith,
                  likes: [],
                  comments: [],
                  isDeleted: false
                };
                await db.qzonePosts.add(newPost);
                console.log(`NPC "${npc.name}" 成功发布了一条新动态。`);
                updateUnreadIndicator(unreadPostsCount + 1);
              }
            }
            await db.npcs.update(npc.id, {
              lastActionTimestamp: Date.now()
            });
            if (document.getElementById('qzone-screen').classList.contains('active')) {
              await renderQzonePosts();
            }
          }
        }
      }
    } catch (error) {
      console.error("处理NPC后台活动时出错:", error);
    }
  }

  // ============================================================
  // 论坛：角色后台自己发帖(跟主动回复的forum_post是两条独立入口，
  // 这个是"哪怕user在正常聊天/根本没触发主动回复"也可能发生的日常动态)
  // ============================================================
  async function triggerCharForumPost(chatId) {
    const chat = state.chats[chatId];
    if (!chat) return;
    const boards = await db.forumBoards.orderBy('order').toArray();
    if (boards.length === 0) return;
    const charAlt = await db.forumAlts.where({ ownerType: 'char', ownerId: chatId }).first();

    const useBackgroundApi = state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel;
    const { proxyUrl, apiKey, model } = useBackgroundApi
      ? { proxyUrl: state.apiConfig.backgroundProxyUrl, apiKey: state.apiConfig.backgroundApiKey, model: state.apiConfig.backgroundModel }
      : state.apiConfig;
    if (!proxyUrl || !apiKey || !model) return;

    const boardNames = boards.map(b => b.name).join('/');
    const systemPrompt = `
# 你的任务
你是角色"${chat.name}"，人设如下：
${chat.settings.aiPersona}

现在你想去论坛发一条帖子，可能是日常分享、突然想到的问题、想吐槽的小事，也可能因为跟用户的相处有感而发——完全基于人设自由发挥，不要总是负面情绪。

# 要求
1. 板块从这些里选一个：${boardNames}
2. 只输出JSON对象，不要有其他文字：{"boardName": "板块名", "content": "帖子内容"${charAlt ? `, "asAlt": true或false(true表示用小号"${charAlt.altName}"匿名发)` : `, "createAlt": "小号名字"(可选，如果你还没有小号但这次想匿名发，取一个符合人设的名字，系统会自动帮你创建这个小号并用它发布，以后就是你固定的马甲了)`}}`;

    try {
      const messagesForApi = [{ role: 'user', content: '请生成这条帖子' }];
      const isGemini = proxyUrl.includes('generativelanguage');
      const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);
      const response = isGemini
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: systemPrompt }, ...messagesForApi],
              temperature: state.globalSettings.apiTemperature || 0.9,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = getGeminiResponseText(data);
      const jsonMatch = raw.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) return;
      const result = JSON.parse(jsonMatch[0]);
      if (!result.content) return;

      const matchedBoard = boards.find(b => b.name === result.boardName) || boards[0];
      let useAlt = result.asAlt === true && charAlt;
      let finalAltId = useAlt ? charAlt.id : null;
      let finalAltName = useAlt ? charAlt.altName : null;
      let finalAltAvatar = useAlt ? (charAlt.altAvatar || '') : '';

      if (!charAlt && result.createAlt) {
        // AI自己取名创建了个新小号，落库后以后这个角色就有固定马甲了，管理界面也能看到
        const newAltName = String(result.createAlt).trim();
        if (newAltName) {
          finalAltId = await db.forumAlts.add({ ownerType: 'char', ownerId: chatId, altName: newAltName, altAvatar: '' });
          finalAltName = newAltName;
          useAlt = true;
        }
      }

      await db.forumPosts.add({
        boardId: matchedBoard.id,
        authorType: 'char',
        authorId: chat.id,
        content: result.content,
        timestamp: Date.now(),
        likes: [],
        commentCount: 0,
        ...(useAlt ? { authorAltId: finalAltId, authorDisplayName: finalAltName, authorAvatar: finalAltAvatar } : {}),
      });
      console.log(`[论坛] 角色 "${chat.name}" 后台发布了一条帖子${useAlt ? '(小号)' : ''}`);
      if (document.getElementById('forum-screen')?.classList.contains('active') && typeof renderForumFeed === 'function') {
        await renderForumFeed();
      }
    } catch (e) {
      console.warn(`[论坛] 角色 "${chat.name}" 后台发帖失败`, e);
    }
  }
  window.triggerCharForumPost = triggerCharForumPost;

  // ============================================================
  // 论坛：网友(forumNpcs)回复/发帖，完全照抄generateNpcActions的模式
  // ============================================================
  async function runForumNpcTick() {
    try {
      // 热搜自动刷新：超过6小时没刷新过，且论坛里有一定数量帖子，就顺手自动刷一次
      try {
        const latestTopic = await db.forumHotTopics.orderBy('generatedAt').reverse().first();
        const hoursSinceRefresh = latestTopic ? (Date.now() - latestTopic.generatedAt) / 3600000 : Infinity;
        const totalPosts = await db.forumPosts.count();
        if (hoursSinceRefresh >= 6 && totalPosts >= 3 && typeof generateForumHotTopics === 'function') {
          await generateForumHotTopics();
        }
      } catch (e) {
        console.warn('[论坛] 自动刷新热搜失败', e);
      }

      const allForumNpcs = await db.forumNpcs.toArray();
      if (allForumNpcs.length === 0) return;
      const boards = await db.forumBoards.orderBy('order').toArray();
      const recentPosts = await db.forumPosts.orderBy('timestamp').reverse().limit(10).toArray();

      for (const npc of allForumNpcs) {
        if (npc.enableBackgroundActivity === false) continue;
        const cooldownMinutes = npc.actionCooldownMinutes || 15;
        if (npc.lastActionTimestamp && (Date.now() - npc.lastActionTimestamp) / 60000 < cooldownMinutes) continue;
        if (Math.random() > 0.3) continue;

        const tasks = recentPosts.filter(p => p.authorId !== `forumnpc_${npc.id}`);
        if (tasks.length === 0 && Math.random() > 0.2) continue;

        const actions = await generateForumNpcActions(npc, tasks, boards);
        if (!actions || actions.length === 0) continue;

        for (const action of actions) {
          if (action.type === 'forum_comment' && action.postId) {
            await db.forumComments.add({
              postId: action.postId,
              authorType: 'npc',
              authorId: `forumnpc_${npc.id}`,
              authorDisplayName: npc.name,
              authorAvatar: npc.avatar || '',
              content: action.commentText,
              replyToName: action.replyTo || null,
              timestamp: Date.now(),
            });
            const post = await db.forumPosts.get(action.postId);
            if (post) {
              post.commentCount = (post.commentCount || 0) + 1;
              await db.forumPosts.put(post);
            }
          } else if (action.type === 'forum_post' && action.content) {
            const board = boards.find(b => b.name === action.boardName) || boards[0];
            if (board) {
              await db.forumPosts.add({
                boardId: board.id,
                authorType: 'npc',
                authorId: `forumnpc_${npc.id}`,
                authorDisplayName: npc.name,
                authorAvatar: npc.avatar || '',
                content: action.content,
                timestamp: Date.now(),
                likes: [],
                commentCount: 0,
              });
            }
          }
        }
        await db.forumNpcs.update(npc.id, { lastActionTimestamp: Date.now() });
      }
      if (document.getElementById('forum-screen')?.classList.contains('active') && typeof renderForumFeed === 'function') {
        await renderForumFeed();
      }
    } catch (e) {
      console.error('[论坛] 网友后台活动出错', e);
    }
  }
  window.runForumNpcTick = runForumNpcTick;

  async function generateForumNpcActions(npc, tasks, boards) {
    const useBackgroundApi = state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel;
    const { proxyUrl, apiKey, model } = useBackgroundApi
      ? { proxyUrl: state.apiConfig.backgroundProxyUrl, apiKey: state.apiConfig.backgroundApiKey, model: state.apiConfig.backgroundModel }
      : state.apiConfig;
    if (!proxyUrl || !apiKey || !model) return null;

    const tasksString = tasks.map(post => {
      let authorName = '未知';
      if (post.authorType === 'user') authorName = state.qzoneSettings?.nickname || '用户';
      else if (post.authorType === 'char') authorName = state.chats[post.authorId]?.name || '未知角色';
      else if (post.authorType === 'npc') authorName = post.authorDisplayName || '网友';
      return `- 帖子ID:${post.id} 作者:${authorName} 内容:${(post.content || '').substring(0, 100)}`;
    }).join('\n');

    const systemPrompt = `
# 你的任务
你是论坛网友"${npc.name}"，人设：${npc.persona}
参与论坛互动，可以【发新帖】或【评论帖子】。

# 待处理帖子列表
${tasksString || '(暂无)'}

# 规则
1. 优先评论列表里合适的帖子，而不是总发新帖。
2. 板块（发新帖时用）：${boards.map(b => b.name).join('/')}
3. 只输出JSON数组：[{"type":"forum_comment","postId":123,"commentText":"..."}] 或 [{"type":"forum_post","boardName":"...","content":"..."}]，可以为空数组。`;

    try {
      const messagesForApi = [{ role: 'user', content: '请开始你的行动' }];
      const isGemini = proxyUrl.includes('generativelanguage');
      const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);
      const response = isGemini
        ? await fetch(geminiConfig.url, geminiConfig.data)
        : await fetch(`${proxyUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: systemPrompt }, ...messagesForApi],
              temperature: state.globalSettings.apiTemperature || 0.9,
            }),
          });
      if (!response.ok) throw new Error(`API错误: ${response.statusText}`);
      const data = await response.json();
      const raw = getGeminiResponseText(data);
      const jsonMatch = raw.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) return null;
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error(`[论坛] 网友"${npc.name}"生成行动失败`, e);
      return null;
    }
  }
  window.generateForumNpcActions = generateForumNpcActions;

  async function generateNpcActions(npc, tasks) {
    // 优先使用后台API，如果未配置则使用主API
    const useBackgroundApi = state.apiConfig.backgroundProxyUrl && state.apiConfig.backgroundApiKey && state.apiConfig.backgroundModel;
    const {
      proxyUrl,
      apiKey,
      model
    } = useBackgroundApi
      ? {
          proxyUrl: state.apiConfig.backgroundProxyUrl,
          apiKey: state.apiConfig.backgroundApiKey,
          model: state.apiConfig.backgroundModel
        }
      : state.apiConfig;
    
    if (!proxyUrl || !apiKey || !model) {
      console.error("NPC行动失败：API未配置。");
      return null;
    }


    let charactersContext = "# 你的互动对象 (用户和其他角色)\n";
    const userNickname = state.qzoneSettings.nickname || '我';
    const userPersona = state.chats[Object.keys(state.chats)[0]]?.settings.myPersona || '(未设置)';
    charactersContext += `- **${userNickname} (用户)**: ${userPersona}\n`;
    if (npc.associatedWith && npc.associatedWith.length > 0) {
      npc.associatedWith.forEach(charId => {
        const char = state.chats[charId];
        if (char && !char.isGroup) {
          charactersContext += `- **${char.name} (本名: ${char.originalName})**: ${char.settings.aiPersona}\n`;
        }
      });
    }

    const tasksString = (await Promise.all(tasks.map(async post => {
      let authorDisplayName = '未知作者';
      if (post.authorId === 'user') {
        authorDisplayName = state.qzoneSettings.nickname || '用户';
      } else if (post.authorId.startsWith('chat_')) {
        authorDisplayName = getDisplayNameByOriginalName(post.authorOriginalName || post.authorId);
      } else if (post.authorId.startsWith('npc_')) {
        const authorNpcId = parseInt(post.authorId.replace('npc_', ''));
        const authorNpc = await db.npcs.get(authorNpcId);
        if (authorNpc) {
          authorDisplayName = authorNpc.name;
        }
      }

      const commentsString = (post.comments || [])
        .map(c => {
          if (typeof c === 'object' && c.commenterName) {
            const commenterDisplayName = getDisplayNameByOriginalName(c.commenterName);
            return `- **${commenterDisplayName}**: ${c.text}`;
          }
          return `- ${c}`;
        }).join('\n');
      return `
---
### 帖子ID: ${post.id}
- **作者**: ${authorDisplayName}
- **内容摘要**: ${(post.content || post.publicText || '').substring(0, 150)}...
- **已有评论**:
${commentsString || '(暂无评论)'}
---
`;
    }))).join('\n');





    const npcAuthorId = `npc_${npc.id}`;
    const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
    const recentNpcPosts = await db.qzonePosts
      .where('authorId').equals(npcAuthorId)
      .and(post => post.timestamp > twelveHoursAgo)
      .toArray();


    let postingCooldownInstruction = '';
    if (recentNpcPosts.length > 0) {
      postingCooldownInstruction = `
# 【行为倾向指令 (高优先级)】
**你最近已经发布过动态了。** 为了让社区互动更自然，你本次行动的【唯一任务】就是**评论**或**回复**下面"待处理的帖子列表"中的内容。
你【绝对禁止】再次发布新动态，除非你收到了直接的指令或有一个对剧情发展至关重要的、紧急的新想法。
`;
    }


    const systemPrompt = `
# 你的任务
你是一个虚拟社区的AI。你的核心任务是扮演角色"${npc.name}"，并根据其人设，通过【发布新动态】或【评论/回复帖子】来参与社区互动。

${postingCooldownInstruction}

# 核心规则
1.  **【角色扮演】**: 你的所有行为都【必须】严格符合你的角色设定。
2.  **【互动逻辑】**: 你的首要任务是检查"待处理的帖子列表"。如果列表中有你可以回应的帖子（特别是那些有新评论或提到你的），你【必须】优先进行评论或回复，而不是发布新动态。
3.  **【格式铁律 (最高优先级)】**: 
    -   你的回复【必须且只能】是一个JSON数组格式的字符串。
    -   数组中可以包含【一个或多个】行动对象。
    -   每个行动对象的格式【必须】是以下两种之一：
      -   **发布新动态**: \`{"type": "qzone_post", "postType": "shuoshuo", "content": "你的新动态内容。"}\`
      -   **发表评论**: \`{"type": "qzone_comment", "postId": 123, "commentText": "你的新评论内容。"}\` 或 \`{"type": "qzone_comment", "postId": 123, "replyTo": "被回复者的【本名】", "commentText": "你的回复内容。"}\`
4.  **【行为组合指南】**:
    -   你可以自由组合不同的行动，例如，先发布一条自己的动态，再去评论别人的动态。
    -   为了模拟真实行为，你本次生成的行动数量建议在【1到3个】之间。

# 你的角色设定
- **昵称**: ${npc.name}
- **人设**: ${npc.persona}

${charactersContext} 

# 待处理的帖子列表 (如果你选择评论)
${tasksString}

现在，请严格遵守所有规则，选择并执行你的行动。`;


    try {
      const messagesForApi = [{
        role: 'user',
        content: "请根据你的设定，开始你的行动。"
      }];
      let isGemini = proxyUrl.includes('generativelanguage');
      let geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi);

      const response = isGemini ?
        await fetch(geminiConfig.url, geminiConfig.data) :
        await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: model,
            messages: [{
              role: 'system',
              content: systemPrompt
            }, ...messagesForApi],
            temperature: state.globalSettings.apiTemperature || 0.9,
            ...(state.globalSettings.apiTopPEnabled && state.globalSettings.apiTopP !== undefined ? { top_p: state.globalSettings.apiTopP } : {}),
            ...(state.globalSettings.apiMaxTokensEnabled && state.globalSettings.apiMaxTokens !== undefined ? { max_tokens: state.globalSettings.apiMaxTokens } : {}),
            ...(state.globalSettings.apiPresencePenaltyEnabled && state.globalSettings.apiPresencePenalty !== undefined ? { presence_penalty: state.globalSettings.apiPresencePenalty } : {}),
            ...(state.globalSettings.apiFrequencyPenaltyEnabled && state.globalSettings.apiFrequencyPenalty !== undefined ? { frequency_penalty: state.globalSettings.apiFrequencyPenalty } : {})
          })
        });

      if (!response.ok) throw new Error(`API 错误: ${response.statusText}`);

      const data = await response.json();
      const aiResponseContent = getGeminiResponseText(data);
      const jsonMatch = aiResponseContent.match(/(\[[\s\S]*\])/);
      if (!jsonMatch) throw new Error("AI返回的行动中未找到有效的JSON数组。");

      return JSON.parse(jsonMatch[0]);

    } catch (error) {
      console.error(`为NPC "${npc.name}" 生成行动失败:`, error);
      return null;
    }
  }



  // ========== 后台保活功能开始 ==========

  let keepAliveInterval = null;
  let keepAliveAudio = null;
  let wakeLock = null;
  let keepAliveWorker = null;
  let keepAliveSharedWorker = null;
  let keepAliveBroadcast = null;
  let keepAliveAnimationFrame = null;
  let keepAliveAudioContext = null;
  let keepAliveMultiTimers = [];
  let keepAliveWebRTC = null;
  let keepAliveAudioPlayer = null; // 用于显示的音频播放器
  let smartKeepAliveWorker = null; // 用于无声智能保活的 Web Worker
  let smartKeepAliveWakeLock = null; // 用于无声智能保活的 WakeLock
  let smartKeepAliveEnabled = false;
  let smartKeepAliveLockController = null; // 用于释放 Web Locks 锁的 AbortController
  let smartKeepAliveOscillatorCtx = null; // 静音振荡器专用的 AudioContext
  let smartKeepAliveOscillatorNode = null;
  let smartKeepAliveOscillatorGain = null;
  let smartKeepAliveOscillatorFirstTouchBound = false;

  // 初始化后台保活
  async function initializeBackgroundKeepAlive() {
    if (!state.globalSettings.backgroundKeepAlive) {
      state.globalSettings.backgroundKeepAlive = {
        enabled: false
      };
    }
    if (!state.globalSettings.smartKeepAlive) {
      state.globalSettings.smartKeepAlive = {
        enabled: false
      };
    }
  }

  // ==== 无声智能保活策略开始 ====

  // 启动无声智能保活
  async function startSmartKeepAlive() {
    console.log('[无声保活] 启动无声智能保活...');
    smartKeepAliveEnabled = true;
    
    // 1. Android WakeLock 策略
    if ('wakeLock' in navigator) {
      try {
        smartKeepAliveWakeLock = await navigator.wakeLock.request('screen');
        console.log('[无声保活] WakeLock (屏幕唤醒锁) 获取成功');
        smartKeepAliveWakeLock.addEventListener('release', () => {
          console.log('[无声保活] WakeLock 被释放，尝试在下次可见时重新获取');
        });
      } catch (err) {
        console.warn('[无声保活] WakeLock 获取失败:', err);
      }
    }

    // 1.5 Web Locks 策略：持有一个不释放的锁，让浏览器认为页面正在做重要事情，不轻易回收
    if ('locks' in navigator && !smartKeepAliveLockController) {
      smartKeepAliveLockController = new AbortController();
      navigator.locks.request(
        'liya-smart-keep-alive-lock',
        { signal: smartKeepAliveLockController.signal },
        () => {
          console.log('[无声保活] Web Lock 已获取，页面被标记为"正在做重要事情"');
          // 持有这个锁直到被 AbortController 中止，用一个只在中止时resolve的Promise占住它
          return new Promise((resolve) => {
            smartKeepAliveLockController.signal.addEventListener('abort', () => resolve());
          });
        }
      ).catch((err) => {
        if (err.name !== 'AbortError') {
          console.warn('[无声保活] Web Lock 获取失败:', err);
        }
      });
    }

    // 1.8 静音振荡器策略：1Hz + 增益0.001，不出声也不会触发系统媒体控制栏，比<audio>文件稳定
    // 音频相关操作必须等用户第一次触摸/点击后才启动，避免被浏览器自动播放策略拦截
    const startSilentOscillator = () => {
      if (smartKeepAliveOscillatorCtx) return; // 已经启动过了
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        smartKeepAliveOscillatorCtx = new AudioCtx();
        smartKeepAliveOscillatorNode = smartKeepAliveOscillatorCtx.createOscillator();
        smartKeepAliveOscillatorGain = smartKeepAliveOscillatorCtx.createGain();
        smartKeepAliveOscillatorNode.frequency.value = 1; // 1Hz
        smartKeepAliveOscillatorGain.gain.value = 0.001; // 极低增益，人耳听不到
        smartKeepAliveOscillatorNode.connect(smartKeepAliveOscillatorGain);
        smartKeepAliveOscillatorGain.connect(smartKeepAliveOscillatorCtx.destination);
        smartKeepAliveOscillatorNode.start();
        console.log('[无声保活] 静音振荡器已启动 (1Hz, 增益0.001)');
      } catch (err) {
        console.warn('[无声保活] 静音振荡器启动失败:', err);
        smartKeepAliveOscillatorCtx = null;
      }
    };

    if (document.visibilityState !== undefined && (document.hasFocus ? document.hasFocus() : true)) {
      // 尝试直接启动；如果浏览器要求用户手势，会在 catch 里静默失败，靠下面的首次触摸兜底
      startSilentOscillator();
    }
    if (!smartKeepAliveOscillatorFirstTouchBound) {
      smartKeepAliveOscillatorFirstTouchBound = true;
      const onFirstTouch = () => {
        startSilentOscillator();
        if (smartKeepAliveOscillatorCtx && smartKeepAliveOscillatorCtx.state === 'suspended') {
          smartKeepAliveOscillatorCtx.resume().catch(() => {});
        }
        document.removeEventListener('pointerdown', onFirstTouch);
        document.removeEventListener('touchstart', onFirstTouch);
        document.removeEventListener('click', onFirstTouch);
      };
      document.addEventListener('pointerdown', onFirstTouch, { once: true });
      document.addEventListener('touchstart', onFirstTouch, { once: true });
      document.addEventListener('click', onFirstTouch, { once: true });
    }

    // 2. Web Worker 心跳策略 (防止 JS 挂起，每15秒ping一次主线程，顺便检查AudioContext是否被系统挂起)
    if (!smartKeepAliveWorker) {
      const workerCode = `
        let intervalId;
        self.addEventListener('message', function(e) {
          if (e.data === 'start') {
            intervalId = setInterval(() => {
              self.postMessage('tick');
            }, 15000); // 每 15 秒发送一次心跳
          } else if (e.data === 'stop') {
            clearInterval(intervalId);
          }
        });
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      smartKeepAliveWorker = new Worker(URL.createObjectURL(blob));
      smartKeepAliveWorker.onmessage = (e) => {
        if (e.data === 'tick' && smartKeepAliveEnabled) {
          // 在此保持主线程略微活跃
          if (Math.random() < 0.01) console.log('[无声保活] Web Worker 心跳...');
          // 顺便检查静音振荡器的AudioContext是否被系统挂起，挂起了就自动恢复
          if (smartKeepAliveOscillatorCtx && smartKeepAliveOscillatorCtx.state === 'suspended') {
            smartKeepAliveOscillatorCtx.resume()
              .then(() => console.log('[无声保活] AudioContext 已从挂起状态恢复'))
              .catch((err) => console.warn('[无声保活] AudioContext 恢复失败:', err));
          }
        }
      };
      smartKeepAliveWorker.postMessage('start');
    }

    // 3. 监听生命周期事件 (iOS 恢复策略)
    document.addEventListener('visibilitychange', handleSmartVisibilityChange);
    window.addEventListener('pagehide', handleSmartPageHide);
    window.addEventListener('resume', handleSmartResume); // PWA/Cordova resume 事件

    updateSmartKeepAliveUI();
    console.log('[无声保活] ✅ 无声智能保活已启动');
  }

  // 停止无声智能保活
  function stopSmartKeepAlive() {
    console.log('[无声保活] 停止无声智能保活...');
    smartKeepAliveEnabled = false;

    // 释放 WakeLock
    if (smartKeepAliveWakeLock !== null) {
      smartKeepAliveWakeLock.release()
        .then(() => {
          smartKeepAliveWakeLock = null;
        });
    }

    // 停止并销毁 Worker
    if (smartKeepAliveWorker) {
      smartKeepAliveWorker.postMessage('stop');
      smartKeepAliveWorker.terminate();
      smartKeepAliveWorker = null;
    }

    // 释放 Web Locks 锁
    if (smartKeepAliveLockController) {
      smartKeepAliveLockController.abort();
      smartKeepAliveLockController = null;
      console.log('[无声保活] Web Lock 已释放');
    }

    // 关闭静音振荡器
    if (smartKeepAliveOscillatorNode) {
      try {
        smartKeepAliveOscillatorNode.stop();
      } catch (e) {}
      smartKeepAliveOscillatorNode = null;
    }
    if (smartKeepAliveOscillatorCtx) {
      smartKeepAliveOscillatorCtx.close().catch(() => {});
      smartKeepAliveOscillatorCtx = null;
    }
    smartKeepAliveOscillatorGain = null;
    smartKeepAliveOscillatorFirstTouchBound = false;

    // 移除事件监听
    document.removeEventListener('visibilitychange', handleSmartVisibilityChange);
    window.removeEventListener('pagehide', handleSmartPageHide);
    window.removeEventListener('resume', handleSmartResume);

    updateSmartKeepAliveUI();
    console.log('[无声保活] ✅ 无声智能保活已停止');
  }

  // 智能保活：可见性变化处理 (JIT 预热与 WakeLock 恢复)
  async function handleSmartVisibilityChange() {
    if (document.visibilityState === 'visible' && smartKeepAliveEnabled) {
      console.log('[无声保活] 🔄 页面恢复可见，执行 JIT 预热与 WakeLock 恢复');
      // 恢复 WakeLock
      if ('wakeLock' in navigator && smartKeepAliveWakeLock === null) {
        try {
          smartKeepAliveWakeLock = await navigator.wakeLock.request('screen');
          console.log('[无声保活] 重新获取 WakeLock 成功');
        } catch (err) {
          console.warn('[无声保活] 重新获取 WakeLock 失败:', err);
        }
      }
      // 恢复 Web Locks 锁（如果之前意外被释放了）
      if ('locks' in navigator && !smartKeepAliveLockController) {
        smartKeepAliveLockController = new AbortController();
        navigator.locks.request(
          'liya-smart-keep-alive-lock',
          { signal: smartKeepAliveLockController.signal },
          () => {
            console.log('[无声保活] Web Lock 重新获取成功');
            return new Promise((resolve) => {
              smartKeepAliveLockController.signal.addEventListener('abort', () => resolve());
            });
          }
        ).catch((err) => {
          if (err.name !== 'AbortError') console.warn('[无声保活] Web Lock 重新获取失败:', err);
        });
      }
      // 恢复静音振荡器的 AudioContext（如果被系统挂起了）
      if (smartKeepAliveOscillatorCtx && smartKeepAliveOscillatorCtx.state === 'suspended') {
        smartKeepAliveOscillatorCtx.resume()
          .then(() => console.log('[无声保活] AudioContext 已恢复'))
          .catch((err) => console.warn('[无声保活] AudioContext 恢复失败:', err));
      }
      // JIT 预热（执行极短的无害计算，帮助 iOS WebKit 快速恢复执行上下文）
      for (let i = 0; i < 1000; i++) {
        Math.sqrt(i);
      }
    }
  }

  // 智能保活：即将进入后台/冻结前的处理
  function handleSmartPageHide(event) {
    if (smartKeepAliveEnabled) {
      console.log('[无声保活] ❄️ 页面即将冻结/隐藏，进行状态快照 (如果需要)...');
      // 可以在此处保存滚动位置、当前活跃输入等状态到 IndexedDB，本处暂作日志记录
    }
  }

  // 智能保活：从 PWA 冻结状态恢复
  function handleSmartResume() {
    if (smartKeepAliveEnabled) {
      console.log('[无声保活] 🚀 PWA 触发 resume 事件，快速复原环境');
      // 可在此处读取 IndexedDB 快照恢复状态
    }
  }

  // 更新智能保活相关的 UI 状态（如果有专属的 UI 元素可以放这里）
  function updateSmartKeepAliveUI() {
    // 视需求更新，暂时无专门文字显示
  }

  // ==== 无声智能保活策略结束 ====

  // 启动音频后台保活
  async function startBackgroundKeepAlive() {
    console.log('[后台保活] 启动后台保活（音频播放器模式）...');

    // 显示保活音频配置按钮
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    if (audioBtnContainer) {
      audioBtnContainer.style.display = 'flex';
    }

    // 监听页面可见性变化（用于音频恢复）
    // ★ 先移除再添加，防止叠加
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    updateKeepAliveStatus('运行中（音频播放器）');
    console.log('[后台保活] ✅ 后台保活已启动');
    console.log('[后台保活] 💪 使用音频播放器进行强力保活');
  }

  // 停止后台保活
  function stopBackgroundKeepAlive() {
    console.log('[后台保活] 停止后台保活...');

    // 停止音频播放器并隐藏按钮
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    const audioPlayer = document.getElementById('keep-alive-audio-player');
    const audioModal = document.getElementById('keep-alive-audio-modal');

    if (audioPlayer && keepAliveAudioPlayer) {
      try {
        const oldSrc = audioPlayer.src;
        audioPlayer.pause();
        audioPlayer.src = '';
        // 释放URL对象（如果是blob URL）
        if (oldSrc && oldSrc.startsWith('blob:')) {
          URL.revokeObjectURL(oldSrc);
        }
        keepAliveAudioPlayer = null;
        console.log('[后台保活] 保活音频已停止');
      } catch (error) {
        console.warn('[后台保活] 停止保活音频失败:', error);
      }
    }

    if (audioBtnContainer) {
      audioBtnContainer.style.display = 'none';
    }

    if (audioModal) {
      audioModal.style.display = 'none';
    }

    // 移除事件监听
    document.removeEventListener('visibilitychange', handleVisibilityChange);

    updateKeepAliveStatus('未启用');
    console.log('[后台保活] ✅ 后台保活已停止');
  }

  // 处理页面可见性变化
  // 页面可见性变化处理（简化版）
  async function handleVisibilityChange() {
    if (document.hidden) {
      console.log('[后台保活] 🔄 页面进入后台');
    } else {
      console.log('[后台保活] ✅ 页面返回前台');
      
      // 页面返回前台时，重新播放用户配置的保活音频
      if (state.globalSettings.backgroundKeepAlive?.enabled && keepAliveAudioPlayer && keepAliveAudioPlayer.src) {
        try {
          await keepAliveAudioPlayer.play();
          console.log('[后台保活] 保活音频已重新播放');
        } catch (error) {
          console.warn('[后台保活] 重新播放保活音频失败:', error);
        }
      }
    }
  }

  // 空的处理函数（保留以避免事件监听器错误）
  function handleStorageChange(event) {}
  function handlePageFreeze() {}
  function handlePageResume() {}

  // 更新保活状态显示
  function updateKeepAliveStatus(statusText) {
    const statusElement = document.getElementById('keep-alive-status-text');
    if (statusElement) {
      statusElement.textContent = statusText;

      // 根据状态设置颜色
      if (statusText.includes('运行中')) {
        statusElement.style.color = '#4CAF50';
      } else {
        statusElement.style.color = '#999';
      }
    }
  }

  // 绑定后台保活开关事件
  function bindBackgroundKeepAliveEvents() {
    const smartKeepAliveSwitch = document.getElementById('smart-keep-alive-switch');
    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const statusDiv = document.getElementById('keep-alive-status');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');
    const audioBtn = document.getElementById('keep-alive-audio-btn');
    const audioModal = document.getElementById('keep-alive-audio-modal');
    const audioMinimize = document.getElementById('keep-alive-audio-minimize');
    const audioClose = document.getElementById('keep-alive-audio-close');
    const audioFile = document.getElementById('keep-alive-audio-file');
    const audioUrl = document.getElementById('keep-alive-audio-url');
    const audioLoadUrl = document.getElementById('keep-alive-audio-load-url');
    const audioPlayer = document.getElementById('keep-alive-audio-player');

    if (smartKeepAliveSwitch) {
      smartKeepAliveSwitch.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        state.globalSettings.smartKeepAlive.enabled = enabled;
        await db.globalSettings.put(state.globalSettings);

        if (enabled) {
          await startSmartKeepAlive();
        } else {
          stopSmartKeepAlive();
        }
      });
    }

    if (keepAliveSwitch) {
      keepAliveSwitch.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        state.globalSettings.backgroundKeepAlive.enabled = enabled;
        await db.globalSettings.put(state.globalSettings);

        // 显示/隐藏状态和音频按钮容器
        if (statusDiv) {
          statusDiv.style.display = enabled ? 'flex' : 'none';
        }

        if (enabled) {
          await startBackgroundKeepAlive();
          // 恢复之前保存的音频URL
          const savedUrl = state.globalSettings.backgroundKeepAlive.audioUrl;
          if (savedUrl) {
            const ap = document.getElementById('keep-alive-audio-player');
            const au = document.getElementById('keep-alive-audio-url');
            if (ap) {
              ap.src = savedUrl;
              ap.loop = true;
              ap.play().then(() => {
                keepAliveAudioPlayer = ap;
                console.log('[后台保活] 开关开启，已恢复保存的音频URL');
              }).catch(err => {
                console.warn('[后台保活] 恢复音频播放失败:', err);
              });
            }
            if (au) au.value = savedUrl;
          }
        } else {
          stopBackgroundKeepAlive();
        }
      });
    }

    // 打开音频配置面板
    if (audioBtn && audioModal) {
      audioBtn.addEventListener('click', () => {
        audioModal.style.display = 'flex';
      });
    }

    // 最小化音频配置面板（只隐藏弹窗，音频继续播放）
    if (audioMinimize && audioModal) {
      audioMinimize.addEventListener('click', () => {
        audioModal.style.display = 'none';
        console.log('[后台保活] 播放器已最小化，音频继续播放');
      });
    }

    // 关闭音频配置面板（停止音频并隐藏）
    if (audioClose && audioModal && audioPlayer) {
      audioClose.addEventListener('click', async () => {
        // 停止音频播放
        if (keepAliveAudioPlayer) {
          try {
            const oldSrc = audioPlayer.src;
            audioPlayer.pause();
            audioPlayer.src = '';
            // 释放URL对象（如果是blob URL）
            if (oldSrc && oldSrc.startsWith('blob:')) {
              URL.revokeObjectURL(oldSrc);
            }
            keepAliveAudioPlayer = null;
            // 清除保存的音频URL
            if (state.globalSettings.backgroundKeepAlive) {
              delete state.globalSettings.backgroundKeepAlive.audioUrl;
              await db.globalSettings.put(state.globalSettings);
            }
            console.log('[后台保活] 播放器已关闭，音频已停止，已清除保存的URL');
          } catch (error) {
            console.warn('[后台保活] 停止音频失败:', error);
          }
        }
        audioModal.style.display = 'none';
      });
    }

    // 点击背景最小化（只隐藏弹窗，音频继续播放）
    if (audioModal) {
      audioModal.addEventListener('click', (e) => {
        if (e.target === audioModal) {
          audioModal.style.display = 'none';
          console.log('[后台保活] 播放器已最小化，音频继续播放');
        }
      });
    }

    // 处理本地文件上传
    if (audioFile && audioPlayer) {
      audioFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          try {
            // 释放之前的URL
            if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
              URL.revokeObjectURL(audioPlayer.src);
            }

            const fileUrl = URL.createObjectURL(file);
            audioPlayer.src = fileUrl;
            audioPlayer.loop = true;
            audioPlayer.play().then(() => {
              keepAliveAudioPlayer = audioPlayer;
              console.log('[后台保活] 本地音频已加载并播放');
            }).catch(err => {
              console.warn('[后台保活] 音频播放失败:', err);
            });
          } catch (error) {
            console.error('[后台保活] 加载本地音频失败:', error);
            alert('加载音频文件失败，请重试');
          }
        }
      });
    }

    // 处理URL加载
    if (audioLoadUrl && audioUrl && audioPlayer) {
      audioLoadUrl.addEventListener('click', async () => {
        const url = audioUrl.value.trim();
        if (!url) {
          alert('请输入音频URL');
          return;
        }

        try {
          // 释放之前的URL
          if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
            URL.revokeObjectURL(audioPlayer.src);
          }

          audioPlayer.src = url;
          audioPlayer.loop = true;
          audioPlayer.play().then(async () => {
            keepAliveAudioPlayer = audioPlayer;
            console.log('[后台保活] URL音频已加载并播放');
            // 保存URL到设置中，刷新后可恢复
            state.globalSettings.backgroundKeepAlive.audioUrl = url;
            await db.globalSettings.put(state.globalSettings);
            console.log('[后台保活] 音频URL已保存');
          }).catch(err => {
            console.warn('[后台保活] 音频播放失败:', err);
            alert('音频播放失败，可能是URL无效或跨域问题');
          });
        } catch (error) {
          console.error('[后台保活] 加载URL音频失败:', error);
          alert('加载音频URL失败，请检查URL是否正确');
        }
      });
    }
  }

  // 加载后台保活设置到UI
  function loadBackgroundKeepAliveSettings() {
    const smartConfig = state.globalSettings.smartKeepAlive;
    const config = state.globalSettings.backgroundKeepAlive;

    const smartKeepAliveSwitch = document.getElementById('smart-keep-alive-switch');
    const keepAliveSwitch = document.getElementById('background-keep-alive-switch');
    const statusDiv = document.getElementById('keep-alive-status');
    const audioBtnContainer = document.getElementById('keep-alive-audio-btn-container');

    if (smartKeepAliveSwitch && smartConfig) {
      smartKeepAliveSwitch.checked = smartConfig.enabled || false;
      if (smartConfig.enabled) {
        startSmartKeepAlive();
      }
    }

    if (keepAliveSwitch && config) {
      keepAliveSwitch.checked = config.enabled || false;

      if (statusDiv) {
        statusDiv.style.display = config.enabled ? 'flex' : 'none';
      }

      // 如果之前是开启状态，重新启动保活
      if (config.enabled) {
        startBackgroundKeepAlive();

        // 恢复之前保存的音频URL
        if (config.audioUrl) {
          const audioPlayer = document.getElementById('keep-alive-audio-player');
          const audioUrl = document.getElementById('keep-alive-audio-url');
          if (audioPlayer) {
            audioPlayer.src = config.audioUrl;
            audioPlayer.loop = true;
            audioPlayer.play().then(() => {
              keepAliveAudioPlayer = audioPlayer;
              console.log('[后台保活] 已恢复保存的音频URL并播放');
            }).catch(err => {
              console.warn('[后台保活] 恢复音频播放失败（可能需要用户交互）:', err);
            });
          }
          // 恢复URL输入框的值
          if (audioUrl) {
            audioUrl.value = config.audioUrl;
          }
        }
      } else {
        // 如果是关闭状态，确保音频按钮容器隐藏
        if (audioBtnContainer) {
          audioBtnContainer.style.display = 'none';
        }
      }
    }
  }

  // ========== 后台保活功能结束 ==========


  async function simulateBackgroundActivity(minutesOffline) {
    console.log(`检测到应用离线了 ${minutesOffline.toFixed(1)} 分钟，开始模拟后台活动...`);


    const activeCharacters = Object.values(state.chats).filter(chat =>
      !chat.isGroup &&
      chat.settings.enableBackgroundActivity &&
      chat.relationship?.status === 'friend'
    );

    if (activeCharacters.length === 0) {
      console.log("没有配置为后台活跃的角色，跳过模拟。");
      return;
    }


    for (const char of activeCharacters) {

      const cooldownMinutes = char.settings.actionCooldownMinutes || 15;
      const timeSinceLastAction = char.lastActionTimestamp ?
        (Date.now() - char.lastActionTimestamp) / (1000 * 60) :
        Infinity;


      if (minutesOffline > cooldownMinutes && timeSinceLastAction > cooldownMinutes) {



        if (Math.random() < 0.3) {
          console.log(`角色 "${char.name}" 触发了后台行动！`);


          if (Math.random() < 0.7) {

            await triggerInactiveAiAction(char.id);
          } else {

            console.log(`角色 "${char.name}" 决定去发一条动态... (此处为模拟)`);
          }
        }
      }
    }
  }

  // ========== 全局暴露 ==========
  window.simulateBackgroundActivity = simulateBackgroundActivity;
  window.startBackgroundSimulation = startBackgroundSimulation;
  window.stopBackgroundSimulation = stopBackgroundSimulation;
  window.initializeBackgroundKeepAlive = initializeBackgroundKeepAlive;
  window.bindBackgroundKeepAliveEvents = bindBackgroundKeepAliveEvents;
  window.loadBackgroundKeepAliveSettings = loadBackgroundKeepAliveSettings;
