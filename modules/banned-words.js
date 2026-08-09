// ============================================================
// banned-words.js
// 屏蔽词功能：全局一份 + 每个聊天可以再加自己的一份。
// 双保险：1) 写进system prompt让AI主动避开、自己换近义词表达
//         2) AI回复生成后再过一遍安全网，命中就删除/替换，兜底保证不会漏出来
// ============================================================

let bannedWordsEditScope = 'global'; // 'global' 或 一个 chatId

function ensureBannedWordsDefaults() {
  if (!state.globalSettings) state.globalSettings = {};
  if (!Array.isArray(state.globalSettings.bannedWords)) {
    state.globalSettings.bannedWords = [];
  }
}

function getScopeList(scope) {
  ensureBannedWordsDefaults();
  if (scope === 'global') {
    return state.globalSettings.bannedWords;
  }
  const chat = state.chats[scope];
  if (!chat) return [];
  if (!chat.settings) chat.settings = {};
  if (!Array.isArray(chat.settings.bannedWords)) chat.settings.bannedWords = [];
  return chat.settings.bannedWords;
}

async function saveScopeList(scope) {
  if (scope === 'global') {
    await db.globalSettings.put(state.globalSettings);
  } else {
    const chat = state.chats[scope];
    if (chat) await db.chats.put(chat);
  }
}

// 某个聊天实际生效的屏蔽词 = 全局的 + 这个聊天自己加的
function getEffectiveBannedWords(chat) {
  ensureBannedWordsDefaults();
  const globalList = state.globalSettings.bannedWords || [];
  const chatList = (chat && chat.settings && Array.isArray(chat.settings.bannedWords)) ? chat.settings.bannedWords : [];
  return [...globalList, ...chatList];
}

// 生成注入到system prompt里的那段说明，让AI主动避开这些词
function buildBannedWordsPromptBlock(chat) {
  const list = getEffectiveBannedWords(chat);
  if (!list.length) return '';
  const lines = list.map(item => {
    if (item.isRegex) {
      return `- 匹配模式 ${item.word} 所命中的任何表达`;
    }
    return `- "${item.word}"`;
  }).join('\n');
  return `
# --- 屏蔽词规则 (最高优先级，必须遵守) ---
以下词语/表达是被明确禁止使用的，无论上下文如何都【绝对不能】在回复中出现：
${lines}
如果原本想表达的意思涉及到这些词，请你主动使用同义词、近义表达或换一种说法自然地代替，而不是生硬地空着不说或者提及"这个词被禁止了"之类的话，也不要在回复里解释你在避讳。
# --- 屏蔽词规则结束 ---
`;
}

// 安全网：AI回复生成后再扫一遍，命中就替换/删除，防止AI没听话
async function applyBannedWordsFilter(text, chat) {
  if (typeof text !== 'string' || !text) return text;
  const list = getEffectiveBannedWords(chat);
  if (!list.length) return text;

  const hits = [];
  for (const item of list) {
    if (!item.word) continue;
    try {
      const re = buildBannedWordRegex(item);
      if (re.test(text)) hits.push(item);
    } catch (e) {
      console.warn('屏蔽词检测出错，已跳过该条:', item, e);
    }
  }
  if (hits.length === 0) return text;

  // 有预设替换词的，直接查表替换，不用等API，秒出结果
  const hitsWithoutReplacement = hits.filter(h => !h.replacement);
  if (hitsWithoutReplacement.length === 0) {
    let result = text;
    for (const item of hits) {
      try {
        const re = buildBannedWordRegex(item);
        result = result.replace(re, item.replacement);
      } catch (e) {
        console.warn('屏蔽词替换出错，已跳过该条:', item, e);
      }
    }
    return result;
  }

  // 还有词没有预设替换词，才需要现场调AI自然改写(方案C)
  let apiConfig = state.apiConfig || {};
  if (chat && chat.apiOverride && chat.apiOverride.enabled) {
    apiConfig = {
      proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
      apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
      model: chat.apiOverride.model || state.apiConfig.model,
    };
  }
  const { proxyUrl, apiKey, model } = apiConfig;
  if (proxyUrl && apiKey && model) {
    try {
      return await rewriteTextAvoidingBannedWords(text, hits, chat);
    } catch (e) {
      console.warn('屏蔽词AI改写失败，降级为直接替换/删除:', e);
    }
  } else {
    console.warn('[屏蔽词] 没有可用的API配置(全局或角色独立配置都没设置好)，直接降级为删除/替换');
  }

  // 兜底：AI改写失败或没配置API时，退回原来的直接替换/删除
  let result = text;
  for (const item of hits) {
    try {
      const re = buildBannedWordRegex(item);
      result = result.replace(re, item.replacement || '');
    } catch (e) {
      console.warn('屏蔽词替换出错，已跳过该条:', item, e);
    }
  }
  return result;
}

function buildBannedWordRegex(item) {
  if (item.isRegex) {
    let pattern = item.word;
    let flags = 'g';
    const match = pattern.match(/^\/(.*)\/([a-z]*)$/i);
    if (match) {
      pattern = match[1];
      flags = match[2].includes('g') ? match[2] : match[2] + 'g';
    }
    return new RegExp(pattern, flags);
  }
  const escaped = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'gi');
}

// 命中屏蔽词后，现场请求AI在不改变原意/语气的前提下自然改写这句话
async function rewriteTextAvoidingBannedWords(text, hits, chat) {
  let apiConfig = state.apiConfig || {};
  if (chat && chat.apiOverride && chat.apiOverride.enabled) {
    apiConfig = {
      proxyUrl: chat.apiOverride.proxyUrl || state.apiConfig.proxyUrl,
      apiKey: chat.apiOverride.apiKey || state.apiConfig.apiKey,
      model: chat.apiOverride.model || state.apiConfig.model,
    };
  }
  const { proxyUrl, apiKey, model } = apiConfig;
  const wordsList = hits.map(h => h.word).join('、');
  const prompt = `下面这句话里包含了不允许出现的词/表达：${wordsList}。
请你在【不改变整体意思、语气和情绪】的前提下，把这些词自然地换成合适的近义表达或说法，句子的其余部分尽量保持原样，不要生硬地把词删掉导致语句不通顺、意思缺失。
只输出改写后的完整这句话本身，不要加任何解释、引号、前后缀或多余文字。

原句：
${text}`;

  const messagesForApi = [{ role: 'user', content: prompt }];
  const isGemini = proxyUrl === GEMINI_API_URL;
  const geminiConfig = toGeminiRequestData(model, apiKey, prompt, messagesForApi, isGemini);

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
          temperature: 0.5,
        }),
      });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const rawContent = isGemini
    ? data.candidates[0].content.parts[0].text
    : data.choices[0].message.content;

  return rawContent.trim().replace(/^["“]|["”]$/g, '').trim();
}

/* ---------------- 管理界面 ---------------- */

function openBannedWordsScreen(scope) {
  bannedWordsEditScope = scope;
  const titleEl = document.getElementById('banned-words-title');
  const hintEl = document.getElementById('banned-words-scope-hint');
  if (scope === 'global') {
    titleEl.textContent = '全局屏蔽词';
    hintEl.textContent = '这里的屏蔽词对所有聊天都生效。';
  } else {
    const chat = state.chats[scope];
    titleEl.textContent = `屏蔽词 · ${chat ? chat.name : ''}`;
    hintEl.textContent = '这里加的词只对当前这个聊天生效。';
  }
  renderBannedWordsList();
  showScreen('banned-words-screen');
}

function renderBannedWordsList() {
  const listEl = document.getElementById('banned-words-list');
  if (!listEl) return;
  const list = getScopeList(bannedWordsEditScope);
  listEl.innerHTML = '';
  if (!list.length) {
    listEl.innerHTML = '<div style="padding:20px; text-align:center; color:#999; font-size:13px;">还没有添加任何屏蔽词</div>';
    return;
  }
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 15px; border-bottom:1px solid var(--border-color,#eee);';
    const replaceHint = item.replacement ? `→ "${item.replacement}"` : '→ 直接删除';
    row.innerHTML = `
      <div style="flex-grow:1; min-width:0;">
        <div style="font-weight:500; word-break:break-all;">${item.word}${item.isRegex ? ' <span style="font-size:10px;color:#999;">[正则]</span>' : ''}</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">${replaceHint}</div>
      </div>
      <div style="display:flex; gap:8px; flex-shrink:0; margin-left:10px;">
        <button class="action-btn" data-edit-id="${item.id}">改替换词</button>
        <button class="action-btn" data-id="${item.id}" style="color:#ff3b30;">删除</button>
      </div>
    `;
    listEl.appendChild(row);
  });
}

async function addBannedWordEntries(entries) {
  const list = getScopeList(bannedWordsEditScope);
  const existingWords = new Set(list.map(item => item.word));
  let addedCount = 0;
  entries.forEach(entry => {
    const word = (entry.word || '').trim();
    if (!word || existingWords.has(word)) return;
    existingWords.add(word);
    list.push({
      id: `bw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      word,
      isRegex: false,
      replacement: (entry.replacement || '').trim(),
    });
    addedCount++;
  });
  await saveScopeList(bannedWordsEditScope);
  return addedCount;
}

async function extractBannedWordsWithAI() {
  const textarea = document.getElementById('banned-words-bulk-import-text');
  const rawText = textarea.value.trim();
  if (!rawText) {
    await showCustomAlert('提示', '请先把禁词说明文档粘贴到文本框里');
    return;
  }
  const { proxyUrl, apiKey, model } = state.apiConfig || {};
  if (!proxyUrl || !apiKey || !model) {
    await showCustomAlert('未配置API', '请先在API设置里配置好接口，才能使用AI智能提取。');
    return;
  }

  showGenerationOverlay('AI正在提取禁词...');
  try {
    const systemPrompt = `
# 任务
下面是一段用户整理的"禁词说明文档"，里面混杂了真正要禁止的词句、以及大量解释性文字(比如为什么禁止、举例说明、变体提示等)。
请你仔细阅读，提取出所有【真正需要在AI回复中禁止出现的具体词语或短句】，忽略掉纯解释性、说明性的句子本身(比如"严禁XX式调情""必须保持XX"这类规则描述句不要整句提取，但其中举例列出的具体词句要提取出来)。

# 规则
1. 如果一行里用"、"或"/"分隔了多个并列的词(比如"管家婆/公"、"骚货、荡妇")，请拆成多个独立的词分别输出。
2. 遇到"XX（及其他变体）"这种，只提取"XX"本身，忽略"及其他变体"这几个字。
3. 遇到句子里举例的部分(通常在"如："、括号、引号里)，把举例的具体词句提取出来，忽略前面的解释文字。
4. 不要把整条规则描述(比如"严禁XX与XX：绝对禁止XX"这种大标题式的句子)当成一个词条，只提取其中真正具体的词句。
5. 如果原文提到某个词"必须替换成XX"或给出了替代说法，就把它填进 replacement 字段；大部分情况下没有指定替代词，replacement 留空字符串即可(意思是直接删除，让AI自己想近义表达)。
6. 每个词条尽量简短、具体，不要包含多余的标点或语气词。

# 待处理文档
${rawText}

# 输出格式
只输出一个JSON数组，不要有任何其他文字、不要markdown代码块标记。格式如下：
[{"word": "词语1", "replacement": ""}, {"word": "词语2", "replacement": "替代词"}]
`;
    const messagesForApi = [{ role: 'user', content: systemPrompt }];
    const isGemini = proxyUrl === GEMINI_API_URL;
    const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi, isGemini);

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
            temperature: 0.3,
          }),
        });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const rawContent = (isGemini
      ? data.candidates[0].content.parts[0].text
      : data.choices[0].message.content
    ).replace(/^```json\s*|```\s*$/g, '').trim();

    const entries = JSON.parse(rawContent);
    if (!Array.isArray(entries)) throw new Error('AI返回的格式不对');

    const addedCount = await addBannedWordEntries(entries);
    textarea.value = '';
    renderBannedWordsList();
    document.getElementById('generation-overlay').classList.remove('visible');
    await showCustomAlert('提取完成', `成功提取并添加了 ${addedCount} 条屏蔽词(已自动跳过重复的)。`);
  } catch (e) {
    document.getElementById('generation-overlay').classList.remove('visible');
    console.error('屏蔽词AI提取失败:', e);
    await showCustomAlert('提取失败', `出错了，请重试或检查API配置：${e.message}`);
  }
}

async function addBannedWord() {
  const input = document.getElementById('banned-word-input');
  const isRegexEl = document.getElementById('banned-word-is-regex');
  const replacementEl = document.getElementById('banned-word-replacement');
  const rawValue = input.value.trim();
  if (!rawValue) {
    await showCustomAlert('提示', '请输入要屏蔽的词语或正则表达式');
    return;
  }
  const isRegex = isRegexEl.checked;
  const replacement = replacementEl.value.trim();
  const list = getScopeList(bannedWordsEditScope);
  const existingWords = new Set(list.map(item => item.word));

  // 非正则模式下支持逗号分隔一次添加多个词；正则模式下整条输入当成一个规则
  const words = isRegex ? [rawValue] : rawValue.split(/[,，]/).map(w => w.trim()).filter(Boolean);

  let skippedCount = 0;
  words.forEach(word => {
    if (existingWords.has(word)) {
      skippedCount++;
      return;
    }
    existingWords.add(word);
    list.push({
      id: `bw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      word,
      isRegex,
      replacement,
    });
  });

  await saveScopeList(bannedWordsEditScope);
  input.value = '';
  replacementEl.value = '';
  isRegexEl.checked = false;
  renderBannedWordsList();
  if (skippedCount > 0) {
    await showCustomAlert('提示', `已添加，其中 ${skippedCount} 条因为重复被跳过。`);
  }
}

async function removeBannedWord(id) {
  const list = getScopeList(bannedWordsEditScope);
  const idx = list.findIndex(item => item.id === id);
  if (idx === -1) return;
  const confirmed = await showCustomConfirm('删除屏蔽词', `确定要删除"${list[idx].word}"吗？`, { confirmButtonClass: 'btn-danger' });
  if (!confirmed) return;
  list.splice(idx, 1);
  await saveScopeList(bannedWordsEditScope);
  renderBannedWordsList();
}

async function editBannedWordReplacement(id) {
  const list = getScopeList(bannedWordsEditScope);
  const item = list.find(i => i.id === id);
  if (!item) return;
  const newReplacement = await showCustomPrompt(`"${item.word}" 命中后替换为`, '留空=直接删除', item.replacement || '');
  if (newReplacement === null) return;
  item.replacement = newReplacement.trim();
  await saveScopeList(bannedWordsEditScope);
  renderBannedWordsList();
}

/* ---------------- 事件绑定 ---------------- */

document.getElementById('banned-words-back-btn')?.addEventListener('click', () => {
  if (bannedWordsEditScope === 'global') {
    showScreen('home-screen');
  } else {
    showScreen('chat-settings-screen');
  }
});

document.getElementById('add-banned-word-btn')?.addEventListener('click', addBannedWord);
document.getElementById('extract-banned-words-ai-btn')?.addEventListener('click', extractBannedWordsWithAI);

document.getElementById('banned-words-list')?.addEventListener('click', (e) => {
  const editBtn = e.target.closest('button[data-edit-id]');
  if (editBtn) {
    editBannedWordReplacement(editBtn.dataset.editId);
    return;
  }
  const btn = e.target.closest('button[data-id]');
  if (btn) removeBannedWord(btn.dataset.id);
});

document.getElementById('open-chat-banned-words-btn')?.addEventListener('click', () => {
  if (state.activeChatId) openBannedWordsScreen(state.activeChatId);
});

window.getEffectiveBannedWords = getEffectiveBannedWords;
window.buildBannedWordsPromptBlock = buildBannedWordsPromptBlock;
window.applyBannedWordsFilter = applyBannedWordsFilter;
window.openBannedWordsScreen = openBannedWordsScreen;
