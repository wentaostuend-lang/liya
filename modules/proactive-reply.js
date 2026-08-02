// ============================================================
// proactive-reply.js
// "主动回复间隔"：距离上次回复超过N小时(默认12，0=关闭)后，
// 再次进入聊天会自动触发AI，模拟角色在这段真实时间里做的事——
// 不局限于发文字，角色能用的指令(表情/语音/转账/礼物/分享链接/
// 位置/撤回/状态更新等)在这里都可能用到，具体用多用少取决于人设。
// ============================================================

// 防止同一次"离开期间"被重复触发：记录已经检查过的最后一条消息时间戳
const proactiveReplyCheckedAnchors = {};

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

async function generateProactiveMessages(chat, elapsedHours, lastTimestamp) {
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

  if (isViewingThisChat) {
    if (chat.isGroup) {
      if (typingIndicator) {
        typingIndicator.textContent = '成员们正在输入...';
        typingIndicator.style.display = 'block';
      }
    } else if (chatHeaderTitle) {
      chatHeaderTitle.textContent = '对方正在输入...';
      chatHeaderTitle.classList.add('typing-status');
    }
  }

  const restoreTypingIndicator = () => {
    if (!isViewingThisChat) return;
    if (chat.isGroup) {
      if (typingIndicator) typingIndicator.style.display = 'none';
    } else if (chatHeaderTitle) {
      chatHeaderTitle.textContent = chat.name;
      chatHeaderTitle.classList.remove('typing-status');
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

  // 长期记忆：跟正常对话一样读取，避免主动回复的时候把之前的剧情/关系全忘光
  const memoryBlock = typeof getMemoryContextForPrompt === 'function'
    ? `# 长期记忆(必须严格参考，不要表现得像才刚认识/回到最初的场景)\n${getMemoryContextForPrompt(chat)}`
    : '';

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

  const systemPrompt = `
# 场景
你正在扮演角色，你的真实身份是"${chat.originalName || chat.name}"（用户对你的备注是"${chat.name}"），人设如下：
${aiPersona}

用户是"${myNickname}"，人设：${myPersona}

${memoryBlock}

${timeAnchorBlock}

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
${stickerBlock}
${thoughtsAndStatusBlock}
# 规则
1. 离开的时间越长，可以自然地生成越多条、涉及越多种类型；真实的时间跨度应该体现在消息的疏密节奏和情绪的自然演变上，不要把所有消息都挤在同一个时间点发生，也不要让情绪从头到尾一成不变。
2. 每条都要给出模拟发送时间点，用"距离上次消息过去了多少小时"表示(hours_after字段，数字，可以有小数比如0.2表示12分钟后)，必须递增，且不能超过 ${roundedHours} 小时。
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
      ? await fetch(geminiConfig.url, geminiConfig.data)
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
    }
  }

  const maxOffsetMs = elapsedHours * 60 * 60 * 1000;

  const builtMessages = [];

  entries.forEach(entry => {
    const offsetHours = Math.max(0, Math.min(elapsedHours, Number(entry.hours_after) || 0));
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

  restoreTypingIndicator(); // 生成阶段的"正在输入"先收起来，下面逐条揭晓时会重新显示

  if (isViewingThisChat && builtMessages.length > 0) {
    // 你正在看这个聊天：像实时聊天一样，一条一条弹出来，每条之前都会有"对方正在输入..."
    for (const msg of builtMessages) {
      if (chatHeaderTitle) {
        chatHeaderTitle.textContent = '对方正在输入...';
        chatHeaderTitle.classList.add('typing-status');
      }
      const contentLen = typeof msg.content === 'string' ? msg.content.length : 6;
      const typingDelay = Math.min(2200, Math.max(500, contentLen * 90));
      await new Promise(resolve => setTimeout(resolve, typingDelay));

      if (chatHeaderTitle) {
        chatHeaderTitle.textContent = chat.name;
        chatHeaderTitle.classList.remove('typing-status');
      }
      chat.history.push(msg);
      await db.chats.put(chat);
      if (typeof appendMessage === 'function') appendMessage(msg, chat);

      await new Promise(resolve => setTimeout(resolve, 250)); // 消息之间留个小间隔，别一冒出来就接着下一条
    }
  } else {
    // 没在看这个聊天：直接批量存进去，不用做逐条动画
    builtMessages.forEach(msg => chat.history.push(msg));
    await db.chats.put(chat);
  }

  chat.unreadCount = 0; // 用户当前正在看这个聊天，不算未读
  await db.chats.put(chat);

  if (isViewingThisChat && typeof renderChatInterface === 'function') {
    renderChatInterface(chat.id);
  }
  if (typeof renderChatList === 'function') renderChatList();
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

  if (isViewingThisChat && typingIndicator) {
    typingIndicator.textContent = '成员们正在输入...';
    typingIndicator.style.display = 'block';
  }
  const restoreTypingIndicator = () => {
    if (isViewingThisChat && typingIndicator) typingIndicator.style.display = 'none';
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

  const systemPrompt = `
# 场景
你是群聊"${chat.name}"的导演，负责扮演【除了用户以外】的所有群成员。
用户是"${myNickname}"。

群成员：
${membersList}

${memoryBlock}

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
${extraBlocks}
# 规则
1. 离开的时间越长，可以自然地生成越多条、涉及越多个成员；真实的时间跨度应该体现在消息的疏密节奏和话题演变上，不要把所有消息挤在同一个时间点。
2. 每条都要给出模拟发送时间点(hours_after字段，数字，可以有小数比如0.2表示12分钟后)，必须递增，且不能超过 ${preciseHours} 小时。
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
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, messages: messagesForApi, temperature: 0.9 }),
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

  entries.forEach(entry => {
    const offsetHours = Math.max(0, Math.min(elapsedHours, Number(entry.hours_after) || 0));
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

  restoreTypingIndicator();

  if (isViewingThisChat && builtMessages.length > 0) {
    // 你正在看这个群：像实时群聊一样，一条一条弹出来，每条之前都有"成员们正在输入..."
    for (let i = 0; i < builtMessages.length; i++) {
      const msg = builtMessages[i];
      const member = builtSpeakers[i];
      if (typingIndicator) {
        typingIndicator.textContent = '成员们正在输入...';
        typingIndicator.style.display = 'block';
      }
      const contentLen = typeof msg.content === 'string' ? msg.content.length : 6;
      const typingDelay = Math.min(2200, Math.max(500, contentLen * 90));
      await new Promise(resolve => setTimeout(resolve, typingDelay));

      if (typingIndicator) typingIndicator.style.display = 'none';
      chat.history.push(msg);
      if (member) speakerIds.add(member.id);
      await db.chats.put(chat);
      if (typeof appendMessage === 'function') appendMessage(msg, chat);

      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } else {
    builtMessages.forEach((msg, i) => {
      chat.history.push(msg);
      const member = builtSpeakers[i];
      if (member) speakerIds.add(member.id);
    });
    await db.chats.put(chat);
  }

  for (const memberId of speakerIds) {
    if (typeof awardGroupActivity === 'function') await awardGroupActivity(chat, memberId);
  }

  chat.unreadCount = 0;
  await db.chats.put(chat);

  if (isViewingThisChat && typeof renderChatInterface === 'function') {
    renderChatInterface(chat.id);
  }
  if (typeof renderChatList === 'function') renderChatList();
}
