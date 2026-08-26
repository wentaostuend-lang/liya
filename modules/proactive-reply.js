// ============================================================
// proactive-reply.js
// "主动回复间隔"：距离上次回复超过N小时(默认12，0=关闭)后，
// 再次进入聊天会自动触发AI，模拟角色在这段真实时间里做的事——
// 不局限于发文字，角色能用的指令(表情/语音/转账/礼物/分享链接/
// 位置/撤回/状态更新等)在这里都可能用到，具体用多用少取决于人设。
// ============================================================

// 防止同一次"离开期间"被重复触发：记录已经检查过的最后一条消息时间戳
const proactiveReplyCheckedAnchors = {};

// 主动回复消息 -> 系统通知文案，跟正常AI回复触发通知时的type映射保持一致(照抄ai-response.js里那套switch)
function buildProactiveNotificationText(msg, chat) {
  let notificationText;
  switch (msg.type) {
    case 'transfer':
      notificationText = `[收到一笔转账]`;
      break;
    case 'waimai_request':
      notificationText = `[收到一个外卖代付请求]`;
      break;
    case 'waimai_order':
      notificationText = `[对方给你点了外卖]`;
      break;
    case 'gift':
      notificationText = `[收到一份礼物]`;
      break;
    case 'sticker':
      notificationText = msg.meaning ? `[表情: ${msg.meaning}]` : '[表情]';
      break;
    case 'voice_message':
      notificationText = `[语音]`;
      break;
    case 'location_share':
      notificationText = `[位置分享]`;
      break;
    case 'share_link':
      notificationText = `[分享了一个链接]`;
      break;
    case 'forum_post_share':
      notificationText = `[转发了一条论坛帖子]`;
      break;
    case 'pat_message':
      notificationText = String(msg.content || '[拍了拍]');
      break;
    case 'recalled_message':
      notificationText = `[撤回了一条消息]`;
      break;
    default:
      notificationText = String(msg.content || '');
  }
  const finalText = chat.isGroup && msg.senderName ? `${msg.senderName}: ${notificationText}` : notificationText;
  return finalText.substring(0, 40) + (finalText.length > 40 ? '...' : '');
}

// 每条主动回复消息都触发一次通知：正在看这个聊天就走"聊天页内通知"，没在看就走系统通知
function notifyProactiveMessage(chat, msg) {
  const text = buildProactiveNotificationText(msg, chat);
  const isViewing = state.activeChatId === chat.id;
  if (isViewing) {
    if (typeof triggerSystemNotificationInChatPage === 'function') {
      triggerSystemNotificationInChatPage(chat.id, text);
    }
  } else {
    if (typeof showNotification === 'function') showNotification(chat.id, text);
  }
}

// ============================================================
// 中途暂停 & 重roll：
// - proactiveGenerationState[chat.id] 记录这个聊天当前这次生成的状态
//   (AbortController用来真的把还没返回的fetch请求中断掉，cancelled用来让展示循环提前收手，
//   inProgress用来防止同一个聊天被并发触发两次生成，batchId用来标记这一批消息，方便reroll时精准删除)
// ============================================================
const proactiveGenerationState = {};

// 点击"对方正在输入..."/"成员们正在输入..."时调用，中断当前这次主动回复的生成
function cancelProactiveGeneration(chatId) {
  const gen = proactiveGenerationState[chatId];
  if (!gen || !gen.inProgress) return;
  gen.cancelled = true;
  try { gen.controller.abort(); } catch (e) { /* 已经结束的请求abort会报错，忽略即可 */ }
  console.log(`[主动回复] 用户手动中止了聊天 ${chatId} 的主动回复生成`);
}
window.cancelProactiveGeneration = cancelProactiveGeneration;

// 重新生成：把上一批标记为这个batchId的消息从记录里摘掉，再当成"还没检查过"重新触发一次
async function rerollProactiveReply(chatId, batchId) {
  const chat = state.chats[chatId];
  if (!chat) return;
  if (proactiveGenerationState[chatId]?.inProgress) {
    console.log('[主动回复] 上一次生成还没结束，暂不重roll');
    return;
  }

  const before = chat.history.length;
  chat.history = chat.history.filter(m => m.proactiveBatchId !== batchId);
  const removed = before - chat.history.length;
  console.log(`[主动回复] 重roll："${chat.name}" 移除了 ${removed} 条上一批的主动消息`);

  await db.chats.put(chat);
  if (state.activeChatId === chatId && typeof renderChatInterface === 'function') {
    renderChatInterface(chatId);
  }

  // 摘掉之后，getLastMessageTimestamp会自然回退到这批消息之前的那条真实消息，
  // 清掉"已检查"标记，让下面的检查重新按真实间隔触发一次
  delete proactiveReplyCheckedAnchors[chatId];
  await checkAndTriggerProactiveReply(chat);
}
window.rerollProactiveReply = rerollProactiveReply;

// 格式化成"2026年8月1日 14:20 星期六"这种，给AI提供绝对时间锚点，避免它算不清白天黑夜
function formatDateTimeCN(date) {
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const week = weekDays[date.getDay()];
  return `${y}年${m}月${d}日 ${hh}:${mm} 星期${week}`;
}

function getLastMessageTimestamp(chat) {
  if (!chat.history || chat.history.length === 0) return null;
  for (let i = chat.history.length - 1; i >= 0; i--) {
    if (!chat.history[i].isHidden) return chat.history[i].timestamp;
  }
  return null;
}

async function checkAndTriggerProactiveReply(chat) {
  if (!chat) return;
  if (proactiveGenerationState[chat.id]?.inProgress) {
    console.log(`[主动回复] "${chat.name}" 上一次生成还在进行中，跳过本次检查`);
    return;
  }
  const hoursThreshold = chat.settings?.proactiveReplyHours ?? 12;
  if (!hoursThreshold || hoursThreshold <= 0) {
    console.log(`[主动回复] "${chat.name}" 间隔设置为0或未设置，功能已关闭，不检查`);
    return;
  }

  const lastTimestamp = getLastMessageTimestamp(chat);
  if (!lastTimestamp) {
    console.log(`[主动回复] "${chat.name}" 还没有任何消息记录，不触发`);
    return;
  }

  // 同一个锚点(同一条"最后消息")只触发一次，避免反复进出聊天重复生成
  if (proactiveReplyCheckedAnchors[chat.id] === lastTimestamp) {
    console.log(`[主动回复] "${chat.name}" 这条最后消息已经检查过了，不重复触发`);
    return;
  }

  const now = Date.now();
  const elapsedHours = (now - lastTimestamp) / (1000 * 60 * 60);
  console.log(`[主动回复] "${chat.name}" 距上条消息已过 ${elapsedHours.toFixed(2)} 小时，阈值为 ${hoursThreshold} 小时`);
  if (elapsedHours < hoursThreshold) {
    console.log(`[主动回复] "${chat.name}" 还没到阈值，不触发`);
    return;
  }

  console.log(`[主动回复] "${chat.name}" 达到触发条件，开始生成...`);
  proactiveReplyCheckedAnchors[chat.id] = lastTimestamp;
  if (chat.isGroup) {
    await generateGroupProactiveMessages(chat, elapsedHours, lastTimestamp);
  } else {
    await generateProactiveMessages(chat, elapsedHours, lastTimestamp);
  }
}

// ============================================================
// 多日摘要压缩：间隔时间太长(默认超过48小时)时，直接一次性生成消息容易被AI偷懒
// 压缩成"仿佛只过了一天"的量。这里先单独请求一次"逐日大纲"(每天1句话概括发生了什么)，
// 再把大纲塞进正式生成的prompt里，让AI照着大纲的骨架去展开消息，逼着它把时间线真正拉开。
// 只是一份文字大纲，token消耗很小，只有超过阈值才会多打这一次请求。
// ============================================================
const DAY_SUMMARY_THRESHOLD_HOURS = 48; // 超过这个时长才启用大纲压缩，否则跟以前一样直接生成
const DAY_SUMMARY_MAX_DAYS = 14; // 大纲最多列这么多天，再长也没意义，只取"最近这些天"

async function generateDailyOutlineBlock(chat, elapsedHours, apiConfig, aiPersona, memoryBlock, timeAnchorBlock, signal) {
  const { proxyUrl, apiKey, model } = apiConfig;
  const totalDays = Math.min(DAY_SUMMARY_MAX_DAYS, Math.max(2, Math.ceil(elapsedHours / 24)));

  const outlinePrompt = `
# 场景
你正在扮演角色"${chat.originalName || chat.name}"，人设如下：
${aiPersona}

${memoryBlock}

${timeAnchorBlock}

用户已经大约 ${elapsedHours.toFixed(1)} 小时(约${totalDays}天)没有查看/回复你了。请你先站在角色的视角，按天列出这段时间里角色自己经历的关键事情——这只是给后续生成消息用的大纲/骨架，不是要写对话或消息原文，是写事件概括。

# 要求
1. 一共写${totalDays}天，从最早那天写到最近(最后一天)。
2. 如果某天角色确实没什么特别的事(平淡的一天)，summary就如实写"平淡的一天，没什么特别的事"，不要为了凑数硬编事件。
3. 事件要符合角色人设、符合之前的关系和剧情，不要凭空生出跟人设无关的事；天数越靠后离现在越近，事件之间要有连贯性/发展感，不能自相矛盾。
4. 只输出JSON数组，不要有任何其他文字、不要markdown代码块标记。格式：[{"day": 1, "summary": "这天发生的事，1句话概括"}, ...]
`;

  try {
    const messagesForApi = [{ role: 'user', content: outlinePrompt }];
    const isGemini = proxyUrl === GEMINI_API_URL;
    const geminiConfig = toGeminiRequestData(model, apiKey, outlinePrompt, messagesForApi, isGemini);
    const response = isGemini
      ? await fetch(geminiConfig.url, { ...geminiConfig.data, signal })
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages: messagesForApi, temperature: 0.8 }),
          signal,
        });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const rawContent = (isGemini
      ? data.candidates[0].content.parts[0].text
      : data.choices[0].message.content
    ).replace(/^```json\s*|```\s*$/g, '').trim();
    const days = JSON.parse(rawContent);
    if (!Array.isArray(days) || days.length === 0) return '';

    const lines = days
      .filter(d => d && d.summary)
      .map(d => `第${d.day ?? '?'}天：${d.summary}`)
      .join('\n');
    if (!lines) return '';

    return `# 逐日大纲(必须严格按这份大纲展开，每天的消息内容要围绕对应那天的事件来写，不能超出/偏离大纲、不能把多天的事情混在一起写、不能跳过某天直接跳到很久以后)\n${lines}\n`;
  } catch (e) {
    console.warn('[主动回复] 生成逐日大纲失败，跳过压缩，走普通生成', e);
    return ''; // 失败就悄悄跳过，退回到原来的生成方式，不影响主流程
  }
}

async function generateProactiveMessages(chat, elapsedHours, lastTimestamp) {
  const abortController = new AbortController();
  proactiveGenerationState[chat.id] = { controller: abortController, cancelled: false, inProgress: true, batchId: `pb_${lastTimestamp}` };
  try {
  let apiConfig = state.apiConfig || {};
  if (chat.apiOverride && chat.apiOverride.enabled) {
    apiConfig = {
      proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
      apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
      model: chat.apiOverride.model || state.apiConfig.model,
    };
  }
  const { proxyUrl, apiKey, model } = apiConfig;
  if (!proxyUrl || !apiKey || !model) {
    console.warn(`[主动回复] "${chat.name}" 没有可用的API配置(全局或角色独立配置都没设置好)，跳过生成`);
    return; // 没配置API就悄悄跳过，不打扰用户
  }

  const isViewingThisChat = state.activeChatId === chat.id;
  const chatHeaderTitle = document.getElementById('chat-header-title');
  const typingIndicator = document.getElementById('typing-indicator');

  const onTypingIndicatorClick = () => cancelProactiveGeneration(chat.id);

  if (isViewingThisChat) {
    if (chat.isGroup) {
      if (typingIndicator) {
        typingIndicator.textContent = '成员们正在输入...(点击暂停)';
        typingIndicator.style.display = 'block';
        typingIndicator.style.cursor = 'pointer';
        typingIndicator.addEventListener('click', onTypingIndicatorClick);
      }
    } else if (chatHeaderTitle) {
      chatHeaderTitle.textContent = '对方正在输入...(点击暂停)';
      chatHeaderTitle.classList.add('typing-status');
      chatHeaderTitle.style.cursor = 'pointer';
      chatHeaderTitle.addEventListener('click', onTypingIndicatorClick);
    }
  }

  const restoreTypingIndicator = () => {
    if (!isViewingThisChat) return;
    if (chat.isGroup) {
      if (typingIndicator) {
        typingIndicator.style.display = 'none';
        typingIndicator.style.cursor = '';
        typingIndicator.removeEventListener('click', onTypingIndicatorClick);
      }
    } else if (chatHeaderTitle) {
      chatHeaderTitle.textContent = chat.name;
      chatHeaderTitle.classList.remove('typing-status');
      chatHeaderTitle.style.cursor = '';
      chatHeaderTitle.removeEventListener('click', onTypingIndicatorClick);
    }
  };

  const myNickname = chat.settings.myNickname || '你';
  const myPersona = chat.settings.myPersona || '';
  const aiPersona = chat.settings.aiPersona || '';
  const preciseHours = elapsedHours.toFixed(2); // 精确到分钟级别，给需要严格约束的地方用(比如hours_after不能超过多少)
  const roughHours = Math.round(elapsedHours * 10) / 10; // 大概取整到1位小数，给叙述性提及"大约过了多久"用，读起来更自然
  const roundedHours = preciseHours; // 兼容下面已经写好的引用，默认用精确版

  // 绝对时间锚点：只给"过了多少小时"AI算不清楚具体是白天还是深夜，容易出现"凌晨发消息说早安去上班"这种矛盾
  const lastMsgDateObj = new Date(lastTimestamp);
  const nowDateObj = new Date();
  const timeAnchorBlock = `# 时间锚点(非常重要，必须严格参考，不要出现时间常识矛盾比如深夜发"早安去上班")
- 上一条消息发送于：${formatDateTimeCN(lastMsgDateObj)}
- 现在实际时间是：${formatDateTimeCN(nowDateObj)}
- 请你根据每条消息的 hours_after 偏移量，自己推算出它实际落在哪一天的几点，并让消息内容符合那个具体时间点该有的状态(比如凌晨该是睡觉/失眠/刚下班，早上该是刚醒/通勤，中午该是吃饭/工作，深夜不会说"早安"或"去上班")。`;

  // 表情包：直接复用正常对话流程那一套(真实可用列表+使用铁律)，不要自己瞎编含义
  const stickerBlock = typeof getStickerContextForPrompt === 'function' ? getStickerContextForPrompt(chat) : '';

  // 双语模式：跟正常对话一样，如果这个角色开了双语，文字/语音消息都要用"外语〖中文〗"格式
  const bilingualBlock = chat.settings.enableBilingualMode ? `
# 【双语输出铁律 - 最高优先级】
你的每条文本和语音消息(text/voice_message)都【必须】使用格式：外语〖中文〗
示例：Hello〖你好〗 / I miss you〖我想你了〗
- 括号必须是 〖 和 〗（不是【】或其他符号）
- 外语和〖之间紧贴，不要有空格
- 每句话都要有对应的翻译
- 【绝对禁止】只发外语或只发中文！
` : '';

  // 长期记忆：跟正常对话一样读取，避免主动回复的时候把之前的剧情/关系全忘光
  const memoryBlock = typeof getMemoryContextForPrompt === 'function'
    ? `# 长期记忆(必须严格参考，不要表现得像才刚认识/回到最初的场景)\n${getMemoryContextForPrompt(chat)}`
    : '';

  // 最近的真实聊天记录样本：主动回复之前完全没有参考过这个，导致AI只能靠笼统的规则(比如"双语角色")去猜说话方式，
  // 容易跑偏(比如平时中文夹粤语的角色，脱离了实际语料就可能整段整段冒英文)。这里补上最近几条真实消息当参照。
  const recentHistorySample = (chat.history || [])
    .filter(m => !m.isHidden && typeof m.content === 'string' && m.content)
    .slice(-12)
    .map(m => `${m.role === 'user' ? (chat.settings.myNickname || '用户') : (m.senderName || chat.originalName || chat.name)}: ${m.content}`)
    .join('\n');
  const recentHistoryBlock = recentHistorySample
    ? `# 最近的真实聊天记录(仅供参照说话习惯、用词风格、语言比例，不要脱离样本自己乱发挥)\n${recentHistorySample}\n【重要】以上这些是【已经发生过、已经说完了】的旧消息，只是给你看说话方式用的参照物，不是还没写完的对话、也不是要你接着往下续。你接下来要生成的是这之后【全新发生】的内容——绝对不能把上面任何一句话原样或改写后再发一遍，不能出现意思重复、场景重复的消息。`
    : '';

  // 多日摘要压缩：间隔太长时先打一份逐日大纲，让正式生成时有骨架可依，不会把好几天的事糊成一小会儿
  const enableDaySummaryCompression = chat.settings.enableDaySummaryCompression ?? true;
  let dailyOutlineBlock = '';
  if (enableDaySummaryCompression && elapsedHours >= DAY_SUMMARY_THRESHOLD_HOURS) {
    dailyOutlineBlock = await generateDailyOutlineBlock(chat, elapsedHours, apiConfig, aiPersona, memoryBlock, timeAnchorBlock, abortController.signal);
  }
  if (proactiveGenerationState[chat.id]?.cancelled) { restoreTypingIndicator(); return; } // 打大纲的时候就被暂停了，直接收手

  // 心声/散记功能是否开启(角色自己的设置优先，没设置就看全局)
  const enableThoughts = chat.settings.enableThoughts ?? state.globalSettings.enableThoughts;

  // 状态栏是否开启(全局开关 + 该角色绑定了预设才生效，跟正常对话流程判断条件一致)
  let statusBarPromptSuffix = '';
  if (state.globalSettings.statusBarEnabled && chat.settings.enableStatusBar && chat.settings.statusBarPresetId && window.__statusBarDB) {
    try {
      const sbPreset = await window.__statusBarDB.presets.get(chat.settings.statusBarPresetId);
      if (sbPreset && sbPreset.promptSuffix) statusBarPromptSuffix = sbPreset.promptSuffix;
    } catch (e) {
      console.warn('[主动回复] 读取状态栏预设失败，跳过状态栏更新', e);
    }
  }

  let thoughtsAndStatusBlock = '';
  if (enableThoughts || statusBarPromptSuffix) {
    thoughtsAndStatusBlock = `
# 心声/散记${statusBarPromptSuffix ? '/状态栏' : ''}更新(必须执行，作为数组最后一项)
在数组最后追加恰好一条这样的对象，代表这段时间过去后角色当下的内心状态：
{"type": "update_thoughts", "hours_after": ${roundedHours}${enableThoughts ? ', "heartfelt_voice": "...", "random_jottings": "..."' : ''}${statusBarPromptSuffix ? ', "status_bar": "..."' : ''}}
${enableThoughts ? '- heartfelt_voice/random_jottings 分别是角色此刻的心声和碎碎念，要基于这段时间里发生的事自然更新，不要和之前一模一样。\n' : ''}${statusBarPromptSuffix ? `- status_bar 字段的内容格式为：\n${statusBarPromptSuffix}\n（这是对当前场景状态的真实总结，不是台词，没有明确信息的字段就填"未知"，不要编造，也要体现出随时间推进的变化，不要跟上一次完全一样。）\n` : ''}`;
  }

  // 论坛板块列表：forum_post这个action要用到，得在systemPrompt构建之前拿到
  const forumBoardsForProactive = await db.forumBoards.orderBy('order').toArray().catch(() => []);
  const forumCharAltsForProactive = await db.forumAlts.where({ ownerType: 'char', ownerId: chat.id }).toArray().catch(() => []);
  // 最近的论坛帖子摘要，给forum_share_post用：char可以选一条转发到聊天里(比如看到个热帖想转给你看)
  const forumRecentPostsForShare = await db.forumPosts.orderBy('timestamp').reverse().limit(15).toArray().catch(() => []);

  const systemPrompt = `
# 场景
你正在扮演角色，你的真实身份是"${chat.originalName || chat.name}"（用户对你的备注是"${chat.name}"），人设如下：
${aiPersona}

用户是"${myNickname}"，人设：${myPersona}

${memoryBlock}

${recentHistoryBlock}

${timeAnchorBlock}

${dailyOutlineBlock}
现在的情况是：距离你上一次和用户说话，已经过去了大约 ${roughHours} 个小时（注意：这是【真实经过的时间】，不是固定周期，哪怕是几十、几百个小时/好几天都要如实按这个时长来构思，不能因为时间很长就压缩成好像才过了一小会儿）。
用户这段时间一直没有查看/回复聊天。请你完全代入角色，模拟这段真实时间跨度里角色会主动做的事，具体做什么、发多少、用什么方式，必须完全基于角色人设和之前的对话上下文来判断，不要脱离人设乱发。
重要：这些消息是角色在【独自一人、完全不知道用户会不会看/什么时候看】的情况下发出的，角色此刻并不知道用户"已经回来了"，不要写成"你终于回复了""你看到了吗""你在吗"这种预设用户正在关注、马上会回应的语气，就是单纯记录这段时间角色会说的话，不需要等待或呼唤对方。
角色不应该只是单方面地盼着用户回复、抱怨对方不理自己——也要让角色主动分享这段时间自己真实经历的具体事情(比如工作/学习上发生了什么、和朋友的一件小事、看到的有趣东西、自己的心情起伏)，展现出角色有自己的生活，不是只围着用户转。
文字类消息(text/voice_message)每条尽量简短，控制在15-20个字以内，像真人分段打字一样把一句话拆成好几条发，不要把很多内容塞进一条长消息里。

# 可以用到的行为类型(不是必须每种都用，自己按人设和心情挑，大部分情况下普通文字消息应该还是占多数)
- 文字消息：{"type": "text", "hours_after": 数字, "content": "消息内容"}
- 语音消息：{"type": "voice_message", "hours_after": 数字, "content": "语音文字内容"}
- 表情包：{"type": "sticker", "hours_after": 数字, "meaning": "表情含义"}(必须严格从下面"可用表情包"列表里选，不能自己编)
- 发了消息又反悔撤回：{"type": "send_and_recall", "hours_after": 数字, "content": "撤回前原本想说的那句话"}(偶尔用一次就好，模拟话说到一半觉得太冲/太丢脸删掉的真实感)
- 转账(给用户钱)：{"type": "transfer", "hours_after": 数字, "amount": 金额数字, "note": "备注，比如给你留的生活费"}
- 送礼物：{"type": "gift", "hours_after": 数字, "itemName": "礼物名", "itemPrice": 价格数字, "reason": "为什么想送", "image_prompt": "礼物图片的英文关键词,用%20分隔"}
- 分享位置：{"type": "location_share", "hours_after": 数字, "content": "位置名，比如'公司楼下的便利店'"}
- 分享链接/新闻/趣事：{"type": "share_link", "hours_after": 数字, "title": "标题", "description": "简短描述", "source_name": "来源，比如'微博'/'小红书'", "content": "链接或内容"}
- 更新状态(在做什么)：{"type": "update_status", "hours_after": 数字, "status_text": "正在做的事，比如'加班中'", "is_busy": true或false}
- 拍一拍对方：{"type": "pat_user", "hours_after": 数字, "suffix": "后缀，可选，比如'该睡觉啦'，不需要就填空字符串"}(想到对方了、或者单纯想撩一下的时候用)
- 改自己的备注名：{"type": "change_remark_name", "hours_after": 数字, "new_name": "新备注名"}(心情/关系有变化时偶尔用，不要频繁改)
${forumBoardsForProactive.length > 0 ? `- 去论坛发帖：{"type": "forum_post", "hours_after": 数字, "boardName": "板块名，从这些里选一个：${forumBoardsForProactive.map(b => b.name).join('/')}", "content": "帖子内容", "asAlt": "小号名字(可选)", "createAlt": "新小号名字(可选)"}
  关于身份：不填asAlt/createAlt就是用真实身份发。${forumCharAltsForProactive.length > 0 ? `你已经有这些小号了：${forumCharAltsForProactive.map(a => a.altName).join('/')}——想匿名发就把asAlt填成其中一个名字；一般不需要再新建小号，除非确实想要一个全新的、没人认识的马甲，那才用createAlt取个新名字。` : '如果想匿名发但还没有小号，用createAlt取一个符合人设的名字，系统会自动帮你创建。'}
  (不局限于负面情绪触发，符合人设的日常分享、突然想到的问题、想吐槽的小事、单纯手痒想发条状态，都可以去论坛发——但别每次都发，频率和内容要贴合角色平时的性格和使用习惯，不是每次主动回复都要带一条)
  ${typeof window.FORUM_WIDGET_PROMPT_HINT === 'string' ? window.FORUM_WIDGET_PROMPT_HINT : ''}` : ''}
${forumRecentPostsForShare.length > 0 ? `- 转发论坛帖子给对方看：{"type": "forum_share_post", "hours_after": 数字, "postId": 帖子ID(从下面列表选), "comment": "转发时附带说的话，比如'笑死这个'、'你看这个'"}(看到论坛上有意思/相关的帖子，可以转发给对方一起看，偶尔用就好，不要频繁转)
  最近的论坛帖子(可选来转发)：\n${forumRecentPostsForShare.map(p => `  - ID:${p.id} 内容:${(p.content || '').substring(0, 50)}`).join('\n')}` : ''}
- 发起外卖代付(想让对方帮忙付钱)：{"type": "waimai_request", "hours_after": 数字, "productInfo": "商品名，比如'奶茶'", "amount": 金额数字}
- 主动给对方点外卖(帮对方叫吃的)：{"type": "waimai_order", "hours_after": 数字, "productInfo": "商品名", "amount": 金额数字, "greeting": "留言，比如'趁热吃'"}
${stickerBlock}
${bilingualBlock}
${thoughtsAndStatusBlock}
# 规则
1. 消息数量必须明显跟着离开的时长走：把这段时间按"天"拆开来想，每一天角色都可能有自己的状态和想法(哪怕只是很简短的一两句)，天数越多，总消息量就应该越多，不能十几天和三天生成的量差不多——当然具体每天发不发、发多少，还是要基于人设来定(比如很忙/性格冷淡的角色某一两天可能确实什么都没发，但整体拉长时间线来看，总量应该能明显感觉出"过了很久")。真实的时间跨度要体现在消息的疏密节奏和情绪的自然演变上，不要把所有消息都挤在同一个时间点发生，也不要让情绪从头到尾一成不变。${dailyOutlineBlock ? '如果上面给出了"逐日大纲"，必须以大纲为准来分配每天的消息内容和数量，每天的消息要能对应上大纲里那天写的事，不能脱离大纲自己乱发挥，也不能把大纲里好几天的事糊在同一天说完。' : ''}
2. hours_after(距离上次消息过去了多少小时，数字，可以有小数)必须递增，不能超过 ${roundedHours} 小时，而且必须体现真人发消息的真实节奏——绝对禁止只用1、2、5、12、24、48这种一眼就是凑出来的整数间隔！真人发消息的规律是：想到一件事的时候会连着发好几条短消息(间隔可能只有几十秒到几分钟，也就是0.02~0.1小时这个量级)，说完了就沉默一段不规则的时间(可能是1.6小时、也可能是7.3小时，取决于角色当时在干嘛)，然后因为某件新的小事又冒出来发一两条。把每一天拆成好几个这样的"小波次"，而不是一天只给一两个孤零零的整点。举个反面例子(禁止模仿)：[1, 5, 12, 24]；正面例子(参考这种疏密节奏和小数感)：[0.05, 0.12, 0.18, 2.7, 2.75, 8.4, 13.1, 13.15, 13.4]。
3. 内容要口语化、真实，像真人分段打字发消息，不要每条都是长大段独白，允许有简短的、情绪化的、甚至只有几个字的消息穿插在里面。
4. 绝对不能透露你是AI/模型，不能出戏。
5. 只输出JSON数组，不要有任何其他文字、不要markdown代码块标记。数组里每个对象都要有"type"和"hours_after"字段，格式如上面所示。
`;

  const messagesForApi = [{ role: 'user', content: systemPrompt }];
  const isGemini = proxyUrl === GEMINI_API_URL;
  const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi, isGemini);

  let entries;
  try {
    const response = isGemini
      ? await fetch(geminiConfig.url, { ...geminiConfig.data, signal: abortController.signal })
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
          signal: abortController.signal,
        });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const rawContent = (isGemini
      ? data.candidates[0].content.parts[0].text
      : data.choices[0].message.content
    ).replace(/^```json\s*|```\s*$/g, '').trim();
    entries = JSON.parse(rawContent);
    if (!Array.isArray(entries) || entries.length === 0) {
      restoreTypingIndicator();
      return;
    }
  } catch (e) {
    console.warn('主动回复生成失败:', e);
    restoreTypingIndicator();
    return;
  }

  // 屏蔽词安全网也过一遍，跟正常回复保持一致(只对包含自由文本的字段生效)
  if (typeof applyBannedWordsFilter === 'function') {
    for (const entry of entries) {
      if (typeof entry.content === 'string' && entry.content) {
        entry.content = await applyBannedWordsFilter(entry.content, chat);
      }
      if (typeof entry.note === 'string' && entry.note) {
        entry.note = await applyBannedWordsFilter(entry.note, chat);
      }
      if (typeof entry.status_text === 'string' && entry.status_text) {
        entry.status_text = await applyBannedWordsFilter(entry.status_text, chat);
      }
      if (typeof entry.description === 'string' && entry.description) {
        entry.description = await applyBannedWordsFilter(entry.description, chat);
      }
      if (typeof entry.heartfelt_voice === 'string' && entry.heartfelt_voice) {
        entry.heartfelt_voice = await applyBannedWordsFilter(entry.heartfelt_voice, chat);
      }
      if (typeof entry.random_jottings === 'string' && entry.random_jottings) {
        entry.random_jottings = await applyBannedWordsFilter(entry.random_jottings, chat);
      }
      if (typeof entry.greeting === 'string' && entry.greeting) {
        entry.greeting = await applyBannedWordsFilter(entry.greeting, chat);
      }
    }
  }

  const maxOffsetMs = elapsedHours * 60 * 60 * 1000;

  let nameWasChanged = false; // change_remark_name是否被触发过，触发了才需要事后同步群昵称
  const builtMessages = [];
  let prevOffsetHours = 0; // 强制时间不倒退：即使AI给的hours_after乱序，也保证最终时间戳单调不减
  const forumPostsToCreate = []; // forEach是同步的没法await，先收集，等forEach跑完再统一写入db

  entries.forEach(entry => {
    let offsetHours = Math.max(0, Math.min(elapsedHours, Number(entry.hours_after) || 0));
    offsetHours = Math.max(offsetHours, prevOffsetHours); // 不允许比上一条还早
    prevOffsetHours = offsetHours;
    const timestamp = Math.min(
      lastTimestamp + offsetHours * 60 * 60 * 1000,
      lastTimestamp + maxOffsetMs
    );

    let msg = null;
    switch (entry.type) {
      case 'sticker': {
        const sticker = typeof findBestStickerMatch === 'function'
          ? findBestStickerMatch(entry.meaning || '', state.userStickers)
          : null;
        if (sticker) {
          msg = { role: 'assistant', type: 'sticker', content: sticker.url, meaning: sticker.name, timestamp };
        } else if (entry.meaning) {
          msg = { role: 'assistant', content: `[${entry.meaning}]`, timestamp };
        }
        break;
      }
      case 'voice_message': {
        if (entry.content) {
          msg = { role: 'assistant', type: 'voice_message', content: entry.content, timestamp };
        }
        break;
      }
      case 'transfer': {
        const amount = Number(entry.amount);
        if (amount > 0) {
          msg = {
            role: 'assistant',
            type: 'transfer',
            amount,
            currency: 'CNY',
            note: entry.note || '',
            receiverName: chat.settings.myNickname || '我',
            timestamp,
          };
        }
        break;
      }
      case 'gift': {
        const price = parseFloat(entry.itemPrice);
        if (entry.itemName && !isNaN(price) && entry.image_prompt) {
          const imageUrl = typeof getPollinationsImageUrl === 'function'
            ? getPollinationsImageUrl(entry.image_prompt)
            : '';
          msg = {
            role: 'assistant',
            type: 'gift',
            items: [{ name: entry.itemName, price, imageUrl, quantity: 1 }],
            total: price,
            recipients: null,
            timestamp,
          };
        }
        break;
      }
      case 'location_share': {
        if (entry.content) {
          msg = { role: 'assistant', type: 'location_share', content: entry.content, timestamp };
        }
        break;
      }
      case 'share_link': {
        if (entry.title) {
          msg = {
            role: 'assistant',
            type: 'share_link',
            title: entry.title,
            description: entry.description || '',
            source_name: entry.source_name || '',
            content: entry.content || '',
            timestamp,
          };
        }
        break;
      }
      case 'update_status': {
        if (entry.status_text) {
          chat.status = chat.status || {};
          chat.status.text = entry.status_text;
          chat.status.isBusy = !!entry.is_busy;
          chat.status.lastUpdate = timestamp;
          msg = {
            role: 'system',
            type: 'pat_message',
            content: `[${chat.name}的状态已更新为: ${entry.status_text}]`,
            timestamp,
          };
        }
        break;
      }
      case 'send_and_recall': {
        msg = {
          role: 'assistant',
          type: 'recalled_message',
          content: '对方撤回了一条消息',
          recalledData: {
            originalType: 'text',
            originalContent: entry.content || '',
          },
          timestamp,
        };
        break;
      }
      case 'pat_user': {
        const suffix = entry.suffix ? ` ${String(entry.suffix).trim()}` : '';
        msg = {
          role: 'system',
          type: 'pat_message',
          content: `${chat.name} 拍了拍我${suffix}`,
          timestamp,
        };
        break;
      }
      case 'change_remark_name': {
        if (entry.new_name) {
          const oldName = chat.name;
          const newName = String(entry.new_name).trim();
          if (newName && newName !== oldName) {
            if (!chat.nameHistory) chat.nameHistory = [];
            if (!chat.nameHistory.includes(oldName)) chat.nameHistory.push(oldName);
            chat.name = newName;
            nameWasChanged = true;
            msg = {
              role: 'system',
              type: 'pat_message',
              content: `"${chat.originalName}" 将备注修改为 "${newName}"`,
              timestamp,
            };
          }
        }
        break;
      }
      case 'waimai_request': {
        const amount = Number(entry.amount);
        if (entry.productInfo && amount > 0) {
          msg = {
            role: 'assistant',
            type: 'waimai_request',
            productInfo: entry.productInfo,
            amount,
            status: 'pending',
            countdownEndTime: timestamp + 15 * 60 * 1000,
            timestamp,
          };
        }
        break;
      }
      case 'waimai_order': {
        const amount = Number(entry.amount);
        if (entry.productInfo && amount > 0) {
          msg = {
            role: 'assistant',
            type: 'waimai_order',
            productInfo: entry.productInfo,
            amount,
            greeting: entry.greeting || '',
            recipientName: chat.settings.myNickname || null,
            timestamp,
          };
        }
        break;
      }
      case 'forum_post': {
        if (entry.content && forumBoardsForProactive.length > 0) {
          const matchedBoard = forumBoardsForProactive.find(b => b.name === entry.boardName) || forumBoardsForProactive[0];
          const matchedAlt = entry.asAlt ? forumCharAltsForProactive.find(a => a.altName === entry.asAlt) : null;
          const useAlt = !!matchedAlt;
          const createAltName = !useAlt && entry.createAlt ? String(entry.createAlt).trim() : null;
          const newPost = {
            boardId: matchedBoard.id,
            authorType: 'char',
            authorId: chat.id,
            content: entry.content,
            timestamp,
            likes: [],
            commentCount: 0,
            ...(useAlt ? {
              authorAltId: matchedAlt.id,
              authorDisplayName: matchedAlt.altName,
              authorAvatar: matchedAlt.altAvatar || '',
            } : {}),
          };
          if (createAltName) newPost._pendingCreateAltName = createAltName; // AI自己取的新小号名，等forEach跑完统一await创建
          if (entry.widget && typeof window.buildForumWidgetFromAIOutput === 'function') {
            const proactiveWidget = window.buildForumWidgetFromAIOutput(entry.widget);
            if (proactiveWidget) newPost.widget = proactiveWidget;
          }
          forumPostsToCreate.push(newPost);
          // 论坛帖子本身在论坛app里看，这里只在聊天里留一条小提示，让用户知道TA去论坛发泄了
          // 用小号发的话，聊天里的提示也不点破具体内容，保留"小号=匿名"的悬念感
          msg = {
            role: 'system',
            type: 'pat_message',
            content: (useAlt || createAltName)
              ? `${chat.name} 好像偷偷用小号在论坛"${matchedBoard.name}"发了条帖子`
              : `${chat.name} 好像在论坛"${matchedBoard.name}"发了条帖子`,
            timestamp,
          };
        }
        break;
      }
      case 'forum_share_post': {
        const sharedPost = forumRecentPostsForShare.find(p => p.id === Number(entry.postId));
        if (sharedPost) {
          let authorName = '未知用户';
          let authorAvatar = '';
          if (sharedPost.authorAltId || sharedPost.authorType === 'npc') {
            authorName = sharedPost.authorDisplayName || '网友';
            authorAvatar = sharedPost.authorAvatar || '';
          } else if (sharedPost.authorType === 'char') {
            const sourceChat = state.chats[sharedPost.authorId];
            authorName = sourceChat ? sourceChat.name : '未知角色';
            authorAvatar = sourceChat?.settings?.aiAvatar || '';
          } else if (sharedPost.authorType === 'user') {
            authorName = state.qzoneSettings?.nickname || '我';
            authorAvatar = state.qzoneSettings?.avatar || '';
          }
          const sharedBoard = forumBoardsForProactive.find(b => b.id === sharedPost.boardId);
          msg = {
            role: 'assistant',
            type: 'forum_post_share',
            forumPostId: sharedPost.id,
            forumPostSnapshot: {
              authorName,
              avatar: authorAvatar,
              boardName: sharedBoard ? sharedBoard.name : '',
              content: sharedPost.content || '',
            },
            comment: entry.comment || '',
            timestamp,
          };
        }
        break;
      }
      case 'update_thoughts': {
        if (!chat.isGroup) {
          if (entry.heartfelt_voice) chat.heartfeltVoice = String(entry.heartfelt_voice);
          if (entry.random_jottings) chat.randomJottings = String(entry.random_jottings);
          if (!chat.customThoughts) chat.customThoughts = {};
          Object.keys(entry).forEach(key => {
            if (!['type', 'hours_after', 'heartfelt_voice', 'random_jottings'].includes(key)) {
              chat.customThoughts[key] = String(entry[key]);
            }
          });
          if (!Array.isArray(chat.thoughtsHistory)) chat.thoughtsHistory = [];
          chat.thoughtsHistory.push({
            heartfeltVoice: chat.heartfeltVoice,
            randomJottings: chat.randomJottings,
            customThoughts: JSON.parse(JSON.stringify(chat.customThoughts)),
            timestamp,
          });
          if (chat.thoughtsHistory.length > 50) chat.thoughtsHistory.shift();
        }
        msg = null; // 只是更新内部状态，不产生聊天气泡
        break;
      }
      case 'text':
      default: {
        if (entry.content) {
          msg = { role: 'assistant', content: entry.content, timestamp };
        }
        break;
      }
    }

    if (msg) builtMessages.push(msg);
  });

  // forEach里只是收集了要发的论坛帖子，这里统一await写入db，保证顺序、避免forEach里悬空Promise
  for (const post of forumPostsToCreate) {
    try {
      if (post._pendingCreateAltName) {
        // AI这次自己取名创建了个新小号，先落库拿到id，以后这个角色就有固定马甲了，管理界面也能看到
        const newAltId = await db.forumAlts.add({
          ownerType: 'char',
          ownerId: chat.id,
          altName: post._pendingCreateAltName,
          altAvatar: '',
        });
        post.authorAltId = newAltId;
        post.authorDisplayName = post._pendingCreateAltName;
        delete post._pendingCreateAltName;
      }
      await db.forumPosts.add(post);

      // 隐藏系统消息：让char"记得"自己发过这条帖子，之后user提起时能自然接上(用小号发的不主动暴露)
      chat.history.push({
        role: 'system',
        content: `[系统提示：你刚才${post.authorAltId ? `用小号"${post.authorDisplayName}"` : ''}在论坛发了一条帖子，内容是："${post.content}"。如果用户后面聊起论坛/这条帖子相关的事，你可以自然地回应，不用刻意隐瞒(除非是用小号发的，那就不要主动暴露是你发的)。]`,
        timestamp: post.timestamp,
        isHidden: true,
      });
    } catch (e) {
      console.warn('[主动回复] 发布论坛帖子失败', e);
    }
  }

  // 备注名在这段时间里被改过：事后同步一次，跟正常对话流程改备注时的收尾动作保持一致
  if (nameWasChanged && typeof syncCharacterNameInGroups === 'function') {
    try {
      await syncCharacterNameInGroups(chat);
    } catch (e) {
      console.warn('[主动回复] 同步群内昵称失败', e);
    }
  }

  // 保持"对方正在输入..."贯穿整个揭晓过程，全部弹完了再收起，不要一条一条闪烁
  const batchId = `pb_${lastTimestamp}`;
  builtMessages.forEach(msg => { msg.proactiveBatchId = batchId; }); // 打上批次标记，方便reroll时精准定位删除

  let committedCount = 0;
  if (isViewingThisChat && builtMessages.length > 0) {
    for (const msg of builtMessages) {
      if (proactiveGenerationState[chat.id]?.cancelled) {
        console.log('[主动回复] 展示过程中被用户暂停，剩余消息不再继续弹出');
        break;
      }

      const contentLen = typeof msg.content === 'string' ? msg.content.length : 6;
      const typingDelay = Math.min(2200, Math.max(500, contentLen * 90));
      await new Promise(resolve => setTimeout(resolve, typingDelay));

      if (proactiveGenerationState[chat.id]?.cancelled) break; // 等待的过程中被暂停，这条也不发了

      // 不再强制每条都插时间戳，交给appendMessage自己按平时那套"超过10分钟才显示"的
      // 分组规则判断——这样弹动画时看到的分组，和退出重进/翻历史记录时看到的分组完全一致
      if (typeof appendMessage === 'function') appendMessage(msg, chat);
      chat.history.push(msg);
      committedCount++;
      notifyProactiveMessage(chat, msg);
      await db.chats.put(chat);

      await new Promise(resolve => setTimeout(resolve, 250)); // 消息之间留个小间隔，别一冒出来就接着下一条
    }
    restoreTypingIndicator();
  } else {
    // 没在看这个聊天：直接批量存进去，不用做逐条动画
    restoreTypingIndicator();
    builtMessages.forEach(msg => {
      chat.history.push(msg);
      notifyProactiveMessage(chat, msg);
    });
    committedCount = builtMessages.length;
    chat.unreadCount = (chat.unreadCount || 0) + builtMessages.length; // 之前这里漏了，导致聊天列表都不会显示未读角标
    await db.chats.put(chat);
  }

  if (isViewingThisChat) {
    chat.unreadCount = 0; // 用户当前正在看这个聊天，不算未读
  }
  await db.chats.put(chat);

  if (isViewingThisChat && typeof renderChatInterface === 'function') {
    renderChatInterface(chat.id);
  }
  if (typeof renderChatList === 'function') renderChatList();
  } finally {
    if (proactiveGenerationState[chat.id]) proactiveGenerationState[chat.id].inProgress = false;
  }
}

window.checkAndTriggerProactiveReply = checkAndTriggerProactiveReply;

// 页面从后台切回前台时，如果当前正好停留在某个聊天界面，也重新检查一次，
// 覆盖"没有重新点开聊天列表，只是把App切到后台又切回来"这种情况
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeChatId) {
    const chat = state.chats[state.activeChatId];
    if (chat) {
      console.log(`[主动回复] 页面重新可见，检查当前聊天 "${chat.name}"`);
      checkAndTriggerProactiveReply(chat);
    }
  }
});

// ============================================================
// 测试模式：跳过"真实等待多少小时"这个门槛，手动指定一个小时数直接生成一次，
// 方便你在聊天设置里点按钮立刻看效果，不影响正式的 proactiveReplyHours 设置。
// ============================================================
async function testTriggerProactiveReply() {
  const chat = state.chats[state.activeChatId];
  if (!chat) {
    await showCustomAlert('提示', '当前没有打开的聊天');
    return;
  }

  const lastTimestamp = getLastMessageTimestamp(chat);
  if (!lastTimestamp) {
    await showCustomAlert('提示', '这个聊天还没有任何消息，没法测试(需要有一条历史消息作为时间锚点)');
    return;
  }

  const input = await showCustomPrompt(
    '测试主动回复',
    '输入一个"假装过去了多少小时"的数字，直接生成一次，不用真的等待。这只是测试，不会影响你设置的正式间隔小时数。',
    '24'
  );
  if (input === null) return;
  const testHours = parseFloat(input);
  if (isNaN(testHours) || testHours <= 0) {
    await showCustomAlert('提示', '请输入一个大于0的数字');
    return;
  }

  console.log(`[主动回复-测试模式] "${chat.name}" 手动测试，模拟已过去 ${testHours} 小时`);

  if (chat.isGroup) {
    await generateGroupProactiveMessages(chat, testHours, lastTimestamp);
  } else {
    await generateProactiveMessages(chat, testHours, lastTimestamp);
  }

  // 测试完了直接跳回聊天界面，方便你马上看效果
  showScreen('chat-interface-screen');
  if (typeof renderChatInterface === 'function') renderChatInterface(chat.id);
}

document.getElementById('test-proactive-reply-btn')?.addEventListener('click', testTriggerProactiveReply);

// ============================================================
// 群聊专属版本：多个成员在这段时间里各自可能发生的事，
// 跟单聊的prompt和可用行为类型是分开设计的，不复用单聊那一套。
// ============================================================
async function generateGroupProactiveMessages(chat, elapsedHours, lastTimestamp) {
  const abortController = new AbortController();
  proactiveGenerationState[chat.id] = { controller: abortController, cancelled: false, inProgress: true, batchId: `pb_${lastTimestamp}` };
  try {
  let apiConfig = state.apiConfig || {};
  if (chat.apiOverride && chat.apiOverride.enabled) {
    apiConfig = {
      proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
      apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
      model: chat.apiOverride.model || state.apiConfig.model,
    };
  }
  const { proxyUrl, apiKey, model } = apiConfig;
  if (!proxyUrl || !apiKey || !model) {
    console.warn(`[主动回复] "${chat.name}"(群聊) 没有可用的API配置，跳过生成`);
    return;
  }

  const isViewingThisChat = state.activeChatId === chat.id;
  const typingIndicator = document.getElementById('typing-indicator');
  const onTypingIndicatorClick = () => cancelProactiveGeneration(chat.id);

  if (isViewingThisChat && typingIndicator) {
    typingIndicator.textContent = '成员们正在输入...(点击暂停)';
    typingIndicator.style.display = 'block';
    typingIndicator.style.cursor = 'pointer';
    typingIndicator.addEventListener('click', onTypingIndicatorClick);
  }
  const restoreTypingIndicator = () => {
    if (isViewingThisChat && typingIndicator) {
      typingIndicator.style.display = 'none';
      typingIndicator.style.cursor = '';
      typingIndicator.removeEventListener('click', onTypingIndicatorClick);
    }
  };

  const myNickname = chat.settings.myNickname || '你';
  const preciseHours = elapsedHours.toFixed(2);
  const roughHours = Math.round(elapsedHours * 10) / 10;

  const lastMsgDateObj = new Date(lastTimestamp);
  const nowDateObj = new Date();
  const timeAnchorBlock = `# 时间锚点(非常重要，必须严格参考，不要出现时间常识矛盾比如深夜发"早安去上班")
- 群里上一条消息发送于：${formatDateTimeCN(lastMsgDateObj)}
- 现在实际时间是：${formatDateTimeCN(nowDateObj)}
- 请根据每条消息的 hours_after 偏移量，自己推算出它实际落在哪一天的几点，并让消息内容符合那个具体时间点该有的状态。`;

  const membersList = (chat.members || [])
    .map(m => `- ${m.originalName}${m.groupNickname && m.groupNickname !== m.originalName ? `(群里叫TA"${m.groupNickname}")` : ''}`)
    .join('\n');

  // 双语模式：如果这个群开了双语设置，文字消息也要用"外语〖中文〗"格式
  const bilingualBlock = chat.settings.enableBilingualMode ? `
# 【双语输出铁律 - 最高优先级】
每条文字消息都【必须】使用格式：外语〖中文〗，括号必须是 〖 和 〗，外语和〖之间紧贴不留空格，绝对禁止只发外语或只发中文。
` : '';

  let extraBlocks = '';
  if (typeof buildGroupThoughtChainBlock === 'function') {
    extraBlocks += buildGroupThoughtChainBlock(chat);
  }
  if (typeof buildBannedWordsPromptBlock === 'function') {
    extraBlocks += buildBannedWordsPromptBlock(chat);
  }

  // 表情包：直接复用正常群聊流程那一套真实可用列表，不要自己瞎编含义
  const stickerBlock = typeof getGroupStickerContextForPrompt === 'function' ? getGroupStickerContextForPrompt(chat) : '';

  // 长期记忆：跟正常对话一样读取
  const memoryBlock = typeof getMemoryContextForPrompt === 'function'
    ? `# 长期记忆(必须严格参考，不要表现得像才刚认识/回到最初的场景)\n${getMemoryContextForPrompt(chat)}`
    : '';

  // 最近的真实群聊记录样本：让AI参照各成员实际的说话习惯/语言比例，不要脱离样本乱发挥
  const recentHistorySample = (chat.history || [])
    .filter(m => !m.isHidden && typeof m.content === 'string' && m.content)
    .slice(-15)
    .map(m => `${m.role === 'user' ? (chat.settings.myNickname || '用户') : (m.senderName || '未知成员')}: ${m.content}`)
    .join('\n');
  const recentHistoryBlock = recentHistorySample
    ? `# 最近的真实群聊记录(仅供参照各成员实际的说话习惯、用词风格、语言比例)\n${recentHistorySample}\n【重要】以上是【已经发生过、已经说完了】的旧消息，只是给你看各成员说话方式用的参照物，不是还没写完的对话、也不是要你接着往下续。你接下来要生成的是这之后【全新发生】的群聊内容——绝对不能把上面任何一句话原样或改写后再发一遍，不能出现意思重复、场景重复的消息。`
    : '';

  const systemPrompt = `
# 场景
你是群聊"${chat.name}"的导演，负责扮演【除了用户以外】的所有群成员。
用户是"${myNickname}"。

群成员：
${membersList}

${memoryBlock}

${recentHistoryBlock}

${timeAnchorBlock}

现在的情况是：距离群里上一条消息，已经过去了大约 ${roughHours} 个小时（注意：这是【真实经过的时间】，不是固定周期，哪怕是几十、几百个小时/好几天都要如实按这个时长来构思，不能因为时间很长就压缩成好像才过了一小会儿）。
用户这段时间一直没有查看/回复这个群。请你模拟这段真实时间跨度里，群成员之间会自然产生的互动——群友之间本来就会互相聊天、互相接话，不是只能对着用户说话，用户不在的时候群里该怎么热闹/怎么冷清就怎么来，完全基于每个成员各自的人设和之前的群聊上下文来判断，不要脱离人设乱发，不同成员的说话方式要有区分度。
重要：这些消息是成员们在【不知道用户会不会看/什么时候看】的情况下产生的，不要写成"你终于回来了""你看到了吗"这种预设用户正在关注的语气。
文字类消息每条尽量简短，控制在15-20个字以内，像真实群消息一样一条一条分开发，不要把很多内容塞进一条长消息里。

# 可以用到的行为类型(不是每种都要用，大部分情况下普通文字消息应该还是占多数)
- 文字消息：{"type": "text", "name": "成员本名", "hours_after": 数字, "content": "消息内容"}
- 表情包：{"type": "sticker", "name": "成员本名", "hours_after": 数字, "meaning": "表情含义"}(必须严格从下面"可用表情包"列表里选，不能自己编)
- 发了消息又反悔撤回：{"type": "send_and_recall", "name": "成员本名", "hours_after": 数字, "content": "撤回前原本想说的话"}(偶尔用一次就好)
- 转账/发红包(给用户或群里)：{"type": "transfer", "name": "成员本名", "hours_after": 数字, "amount": 金额数字, "note": "备注"}
- 改群名：{"type": "change_group_name", "name": "成员本名", "hours_after": 数字, "new_name": "新群名"}(非常少用，只有剧情合理时才用)
${stickerBlock}
${bilingualBlock}
${extraBlocks}
# 规则
1. 消息数量必须明显跟着离开的时长走：把这段时间按"天"拆开来想，每一天群里都可能有一些动静(哪怕只是一两句)，天数越多，总消息量应该越多，不能十几天和三天生成的量差不多。当然具体哪天热闹哪天冷清、谁发不发言，还是要基于各成员人设来定，不是每天都要炸群。真实的时间跨度要体现在消息的疏密节奏和话题演变上，不要把所有消息挤在同一个时间点。
2. hours_after(距离上次消息过去了多少小时，数字，可以有小数)必须递增，不能超过 ${preciseHours} 小时，而且必须体现群聊真实的爆发节奏——绝对禁止只用1、2、5、12、24这种一眼就是凑出来的整数间隔！真实群聊是：一件事引发几个人连着扎堆聊几句(间隔可能只有几十秒到几分钟，也就是0.02~0.1小时这个量级)，然后群里安静一段不规则的时间，之后因为别的事又活跃一阵。把每一天拆成好几个这样的"小波次"，而不是一天只给一两条孤零零的整点消息。反面例子(禁止模仿)：[1, 5, 12, 24]；正面例子(参考这种疏密节奏)：[0.05, 0.1, 0.15, 0.2, 4.6, 4.65, 4.7, 9.3, 15.8, 15.85]。
3. 允许插楼、错位回复、允许两三个成员之间自己单独接龙互怼，不用每条都扯上用户；不是每个成员都必须发言。
4. 内容要口语化、真实，像真实群消息流，不要每条都很长，允许简短的、情绪化的、甚至只有几个字的消息穿插在里面。
5. 绝对不能透露你是AI/模型，不能出戏。
6. 只输出JSON数组，不要有任何其他文字、不要markdown代码块标记。数组里每个对象都要有"type"、"name"、"hours_after"字段(change_group_name除外name仍需填触发改名的成员)。
`;

  const messagesForApi = [{ role: 'user', content: systemPrompt }];
  const isGemini = proxyUrl === GEMINI_API_URL;
  const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi, isGemini);

  let entries;
  try {
    const response = isGemini
      ? await fetch(geminiConfig.url, { ...geminiConfig.data, signal: abortController.signal })
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages: messagesForApi, temperature: 0.9 }),
          signal: abortController.signal,
        });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const rawContent = (isGemini
      ? data.candidates[0].content.parts[0].text
      : data.choices[0].message.content
    ).replace(/^```json\s*|```\s*$/g, '').trim();
    entries = JSON.parse(rawContent);
    if (!Array.isArray(entries) || entries.length === 0) {
      restoreTypingIndicator();
      return;
    }
  } catch (e) {
    console.warn('群聊主动回复生成失败:', e);
    restoreTypingIndicator();
    return;
  }

  if (typeof applyBannedWordsFilter === 'function') {
    for (const entry of entries) {
      if (typeof entry.content === 'string' && entry.content) {
        entry.content = await applyBannedWordsFilter(entry.content, chat);
      }
      if (typeof entry.note === 'string' && entry.note) {
        entry.note = await applyBannedWordsFilter(entry.note, chat);
      }
    }
  }

  const maxOffsetMs = elapsedHours * 60 * 60 * 1000;
  const speakerIds = new Set();
  const builtMessages = [];
  const builtSpeakers = []; // 跟builtMessages一一对应，记录说话人是哪个member(用于事后计分)

  let prevOffsetHours = 0; // 强制时间不倒退

  entries.forEach(entry => {
    let offsetHours = Math.max(0, Math.min(elapsedHours, Number(entry.hours_after) || 0));
    offsetHours = Math.max(offsetHours, prevOffsetHours);
    prevOffsetHours = offsetHours;
    const timestamp = Math.min(
      lastTimestamp + offsetHours * 60 * 60 * 1000,
      lastTimestamp + maxOffsetMs
    );
    const member = (chat.members || []).find(m => m.originalName === entry.name || m.groupNickname === entry.name);
    const senderName = entry.name || (member ? member.originalName : '');

    let msg = null;
    switch (entry.type) {
      case 'sticker': {
        const sticker = typeof findBestStickerMatch === 'function'
          ? findBestStickerMatch(entry.meaning || '', state.userStickers)
          : null;
        if (sticker) {
          msg = { role: 'assistant', type: 'sticker', content: sticker.url, meaning: sticker.name, senderName, timestamp };
        } else if (entry.meaning) {
          msg = { role: 'assistant', content: `[${entry.meaning}]`, senderName, timestamp };
        }
        break;
      }
      case 'transfer': {
        const amount = Number(entry.amount);
        if (amount > 0) {
          msg = {
            role: 'assistant',
            type: 'transfer',
            amount,
            currency: 'CNY',
            note: entry.note || '',
            receiverName: chat.settings.myNickname || '我',
            senderName,
            timestamp,
          };
        }
        break;
      }
      case 'send_and_recall': {
        msg = {
          role: 'assistant',
          type: 'recalled_message',
          content: '对方撤回了一条消息',
          recalledData: { originalType: 'text', originalContent: entry.content || '' },
          senderName,
          timestamp,
        };
        break;
      }
      case 'change_group_name': {
        if (entry.new_name) {
          const oldName = chat.name;
          chat.name = entry.new_name;
          msg = {
            role: 'system',
            type: 'pat_message',
            content: `"${senderName}"将群名由"${oldName}"改为了"${entry.new_name}"`,
            timestamp,
          };
        }
        break;
      }
      case 'text':
      default: {
        if (entry.content) {
          msg = { role: 'assistant', content: entry.content, senderName, timestamp };
        }
        break;
      }
    }

    if (msg) {
      builtMessages.push(msg);
      builtSpeakers.push(member || null);
    }
  });

  const batchId = `pb_${lastTimestamp}`;
  builtMessages.forEach(msg => { msg.proactiveBatchId = batchId; });

  let committedCount = 0;
  if (isViewingThisChat && builtMessages.length > 0) {
    // 你正在看这个群：像实时群聊一样，一条一条弹出来，"成员们正在输入..."贯穿整个过程直到全部弹完
    if (typingIndicator) {
      typingIndicator.textContent = '成员们正在输入...(点击暂停)';
      typingIndicator.style.display = 'block';
    }
    for (let i = 0; i < builtMessages.length; i++) {
      if (proactiveGenerationState[chat.id]?.cancelled) {
        console.log('[主动回复] 群聊展示过程中被用户暂停，剩余消息不再继续弹出');
        break;
      }

      const msg = builtMessages[i];
      const member = builtSpeakers[i];
      const contentLen = typeof msg.content === 'string' ? msg.content.length : 6;
      const typingDelay = Math.min(2200, Math.max(500, contentLen * 90));
      await new Promise(resolve => setTimeout(resolve, typingDelay));

      if (proactiveGenerationState[chat.id]?.cancelled) break;

      // 不再强制每条都插时间戳，交给appendMessage按平时的分组规则判断，保持跟历史记录一致
      if (typeof appendMessage === 'function') appendMessage(msg, chat);
      chat.history.push(msg);
      if (member) speakerIds.add(member.id);
      committedCount++;
      notifyProactiveMessage(chat, msg);
      await db.chats.put(chat);

      await new Promise(resolve => setTimeout(resolve, 250));
    }
    restoreTypingIndicator();
  } else {
    restoreTypingIndicator();
    builtMessages.forEach((msg, i) => {
      chat.history.push(msg);
      const member = builtSpeakers[i];
      if (member) speakerIds.add(member.id);
      notifyProactiveMessage(chat, msg);
    });
    committedCount = builtMessages.length;
    chat.unreadCount = (chat.unreadCount || 0) + builtMessages.length; // 之前这里漏了，导致聊天列表都不会显示未读角标
    await db.chats.put(chat);
  }

  for (const memberId of speakerIds) {
    if (typeof awardGroupActivity === 'function') await awardGroupActivity(chat, memberId);
  }

  if (isViewingThisChat) {
    chat.unreadCount = 0;
  }
  await db.chats.put(chat);

  if (isViewingThisChat && typeof renderChatInterface === 'function') {
    renderChatInterface(chat.id);
  }
  if (typeof renderChatList === 'function') renderChatList();
  } finally {
    if (proactiveGenerationState[chat.id]) proactiveGenerationState[chat.id].inProgress = false;
  }
}
