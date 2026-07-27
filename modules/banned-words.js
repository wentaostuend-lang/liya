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
function applyBannedWordsFilter(text, chat) {
  if (typeof text !== 'string' || !text) return text;
  const list = getEffectiveBannedWords(chat);
  let result = text;
  for (const item of list) {
    if (!item.word) continue;
    const replacement = item.replacement || '';
    try {
      if (item.isRegex) {
        // word 里可能是 /pattern/flags 形式，也可能是纯 pattern
        let pattern = item.word;
        let flags = 'g';
        const match = pattern.match(/^\/(.*)\/([a-z]*)$/i);
        if (match) {
          pattern = match[1];
          flags = match[2].includes('g') ? match[2] : match[2] + 'g';
        }
        const re = new RegExp(pattern, flags);
        result = result.replace(re, replacement);
      } else {
        // 普通文字：不区分大小写、全局替换
        const escaped = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escaped, 'gi');
        result = result.replace(re, replacement);
      }
    } catch (e) {
      console.warn('屏蔽词过滤出错，已跳过该条:', item, e);
    }
  }
  return result;
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
      <button class="action-btn" data-id="${item.id}" style="color:#ff3b30; flex-shrink:0; margin-left:10px;">删除</button>
    `;
    listEl.appendChild(row);
  });
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

  // 非正则模式下支持逗号分隔一次添加多个词；正则模式下整条输入当成一个规则
  const words = isRegex ? [rawValue] : rawValue.split(/[,，]/).map(w => w.trim()).filter(Boolean);

  words.forEach(word => {
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

/* ---------------- 事件绑定 ---------------- */

document.getElementById('banned-words-back-btn')?.addEventListener('click', () => {
  if (bannedWordsEditScope === 'global') {
    showScreen('home-screen');
  } else {
    showScreen('chat-settings-screen');
  }
});

document.getElementById('add-banned-word-btn')?.addEventListener('click', addBannedWord);

document.getElementById('banned-words-list')?.addEventListener('click', (e) => {
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
