// ============================================================
// proactive-reply.js
// "主动回复间隔"：距离上次回复超过N小时(默认12，0=关闭)后，
// 再次进入聊天会自动触发AI，模拟角色在这段真实时间里做的事——
// 不局限于发文字，角色能用的指令(表情/语音/转账/礼物/分享链接/
// 位置/撤回/状态更新等)在这里都可能用到，具体用多用少取决于人设。
// ============================================================

// 防止同一次"离开期间"被重复触发：记录已经检查过的最后一条消息时间戳
const proactiveReplyCheckedAnchors = {};

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
  if (!hoursThreshold || hoursThreshold <= 0) return; // 0 = 关闭

  const lastTimestamp = getLastMessageTimestamp(chat);
  if (!lastTimestamp) return; // 还没有任何消息，不触发

  // 同一个锚点(同一条"最后消息")只触发一次，避免反复进出聊天重复生成
  if (proactiveReplyCheckedAnchors[chat.id] === lastTimestamp) return;

  const now = Date.now();
  const elapsedHours = (now - lastTimestamp) / (1000 * 60 * 60);
  if (elapsedHours < hoursThreshold) return;

  proactiveReplyCheckedAnchors[chat.id] = lastTimestamp;
  await generateProactiveMessages(chat, elapsedHours, lastTimestamp);
}

async function generateProactiveMessages(chat, elapsedHours, lastTimestamp) {
  const { proxyUrl, apiKey, model } = state.apiConfig || {};
  if (!proxyUrl || !apiKey || !model) return; // 没配置API就悄悄跳过，不打扰用户

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
  const roundedHours = Math.round(elapsedHours * 10) / 10;

  const systemPrompt = `
# 场景
你正在扮演角色"${chat.originalName}"，人设如下：
${aiPersona}

用户是"${myNickname}"，人设：${myPersona}

现在的情况是：距离你上一次和用户说话，已经过去了大约 ${roundedHours} 个小时（注意：这是【真实经过的时间】，不是固定周期，哪怕是几十、几百个小时/好几天都要如实按这个时长来构思，不能因为时间很长就压缩成好像才过了一小会儿）。
用户这段时间一直没有查看/回复聊天。请你完全代入角色，模拟这段真实时间跨度里角色会主动做的事，具体做什么、发多少、用什么方式，必须完全基于角色人设和之前的对话上下文来判断，不要脱离人设乱发。
重要：这些消息是角色在【独自一人、完全不知道用户会不会看/什么时候看】的情况下发出的，角色此刻并不知道用户"已经回来了"，不要写成"你终于回复了""你看到了吗""你在吗"这种预设用户正在关注、马上会回应的语气，就是单纯记录这段时间角色会说的话，不需要等待或呼唤对方。
角色不应该只是单方面地盼着用户回复、抱怨对方不理自己——也要让角色主动分享这段时间自己真实经历的具体事情(比如工作/学习上发生了什么、和朋友的一件小事、看到的有趣东西、自己的心情起伏)，展现出角色有自己的生活，不是只围着用户转。

# 可以用到的行为类型(不是必须每种都用，自己按人设和心情挑，大部分情况下普通文字消息应该还是占多数)
- 文字消息：{"type": "text", "hours_after": 数字, "content": "消息内容"}
- 语音消息：{"type": "voice_message", "hours_after": 数字, "content": "语音文字内容"}
- 表情包：{"type": "sticker", "hours_after": 数字, "meaning": "表情含义(必须是常见情绪词，比如'生气'、'委屈'、'开心'、'无语')"}
- 发了消息又反悔撤回：{"type": "send_and_recall", "hours_after": 数字, "content": "撤回前原本想说的那句话"}(偶尔用一次就好，模拟话说到一半觉得太冲/太丢脸删掉的真实感)
- 转账(给用户钱)：{"type": "transfer", "hours_after": 数字, "amount": 金额数字, "note": "备注，比如给你留的生活费"}
- 送礼物：{"type": "gift", "hours_after": 数字, "itemName": "礼物名", "itemPrice": 价格数字, "reason": "为什么想送", "image_prompt": "礼物图片的英文关键词,用%20分隔"}
- 分享位置：{"type": "location_share", "hours_after": 数字, "content": "位置名，比如'公司楼下的便利店'"}
- 分享链接/新闻/趣事：{"type": "share_link", "hours_after": 数字, "title": "标题", "description": "简短描述", "source_name": "来源，比如'微博'/'小红书'", "content": "链接或内容"}
- 更新状态(在做什么)：{"type": "update_status", "hours_after": 数字, "status_text": "正在做的事，比如'加班中'", "is_busy": true或false}

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
    }
  }

  const maxOffsetMs = elapsedHours * 60 * 60 * 1000;

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
      case 'text':
      default: {
        if (entry.content) {
          msg = { role: 'assistant', content: entry.content, timestamp };
        }
        break;
      }
    }

    if (msg) chat.history.push(msg);
  });

  chat.unreadCount = 0; // 用户当前正在看这个聊天，不算未读
  await db.chats.put(chat);

  restoreTypingIndicator();

  if (isViewingThisChat && typeof renderChatInterface === 'function') {
    renderChatInterface(chat.id);
  }
  if (typeof renderChatList === 'function') renderChatList();
}

window.checkAndTriggerProactiveReply = checkAndTriggerProactiveReply;
