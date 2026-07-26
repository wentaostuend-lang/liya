// ============================================================
// group-titles.js
// 群头衔 + 群等级系统 (移植自原项目 -k--main 的群主/管理员/头衔/踢人/转让,
// 并新增：每日发言涨等级、不活跃衰减、等级封顶100)
// ============================================================

/* ---------------- 等级计算 ---------------- */

// 达到 level 级所需的累计积分 (Lv1为0分起点, 每升一级多需要10分: 10,20,30...)
function getLevelThreshold(level) {
  return 5 * level * (level - 1);
}

function getLevelFromPoints(points) {
  points = points || 0;
  let level = 1;
  while (getLevelThreshold(level + 1) <= points && level < 100) {
    level++;
  }
  return Math.min(level, 100);
}

// 当前等级对应的每日不活跃衰减速率
function getDecayRateForLevel(level) {
  if (level <= 20) return 1;
  if (level <= 80) return 2;
  return 5;
}

// 组合展示："Lv1 群主" 这种格式(带一个空格)；有自定义头衔就显示头衔,没有就按身份兜底显示 群主/管理员/成员
function getGroupTitleTag(points, title) {
  const level = getLevelFromPoints(points);
  return title ? `Lv${level} ${title}` : `Lv${level}`;
}

// 计算某人的完整徽章信息：显示文字 + 颜色档位/自定义色
// entity 需要有: points, title, isOwner, isAdmin, customColor
// 把十六进制颜色调亮/调暗一定比例，用于给自定义色自动配一个渐变
function shadeHexColor(hex, percent) {
  let color = hex.replace('#', '');
  if (color.length === 3) {
    color = color.split('').map(c => c + c).join('');
  }
  const num = parseInt(color, 16);
  let r = (num >> 16) + Math.round(255 * percent);
  let g = ((num >> 8) & 0x00ff) + Math.round(255 * percent);
  let b = (num & 0x0000ff) + Math.round(255 * percent);
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

// 根据群主设置的单一色值，自动算出一个浅→深的渐变(135度，和其它三档保持同一种视觉风格)
function buildCustomGradient(hex) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    // 3位简写颜色先展开成6位再计算
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = '#' + hex.slice(1).split('').map(c => c + c).join('');
    } else {
      return `background:${hex};`; // 非标准格式就不强行处理，直接用原值
    }
  }
  const light = shadeHexColor(hex, 0.18);
  const dark = shadeHexColor(hex, -0.12);
  return `background: linear-gradient(135deg, ${light}, ${dark});`;
}

function getGroupBadge(entity) {
  const level = getLevelFromPoints(entity.points || 0);
  let word, tierClass;
  if (entity.isOwner) {
    word = '群主';
    tierClass = 'tier-owner';
  } else if (entity.isAdmin) {
    word = '管理员';
    tierClass = 'tier-admin';
  } else if (entity.title) {
    word = entity.title;
    tierClass = 'tier-title';
  } else {
    word = '成员';
    tierClass = 'tier-default';
  }
  const text = `Lv${level} ${entity.title || word}`;
  if (entity.customColor) {
    return { text, tierClass: '', style: buildCustomGradient(entity.customColor) };
  }
  return { text, tierClass, style: '' };
}

// 计算某个人的标签应该用哪一档颜色/自定义色。
// entity 需要有: isOwner, isAdmin, title, customColor
function resolveTagColor(entity) {
  if (entity.customColor) {
    return { tierClass: '', style: buildCustomGradient(entity.customColor) };
  }
  if (entity.isOwner) {
    return { tierClass: 'tier-owner', style: '' };
  }
  if (entity.isAdmin) {
    return { tierClass: 'tier-admin', style: '' };
  }
  if (entity.title) {
    return { tierClass: 'tier-title', style: '' };
  }
  return { tierClass: 'tier-default', style: '' };
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* ---------------- 每日发言加分 ---------------- */

// entityKey: 'user' 表示用户自己，否则传成员的 id
async function awardGroupActivity(chat, entityKey) {
  if (!chat || !chat.isGroup) return;
  const today = todayDateStr();

  let entity;
  if (entityKey === 'user') {
    if (!chat.settings) chat.settings = {};
    entity = chat.settings;
    if (entity.myLastActiveDate === today) return; // 今天已经记过了
    entity.myLevelPoints = (entity.myLevelPoints || 0) + 10;
    entity.myLastActiveDate = today;
    entity.myLastDecayDate = today; // 今天说过话了，今天不衰减
  } else {
    const member = (chat.members || []).find(m => m.id === entityKey);
    if (!member) return;
    if (member.lastActiveDate === today) return;
    member.levelPoints = (member.levelPoints || 0) + 10;
    member.lastActiveDate = today;
    member.lastDecayDate = today;
  }

  try {
    await db.chats.put(chat);
  } catch (e) {
    console.warn('awardGroupActivity 保存失败', e);
  }
}

/* ---------------- 每日不活跃衰减 ---------------- */

function decayEntity(pointsField, lastDecayDateField, obj, today) {
  if (!obj[lastDecayDateField]) {
    obj[lastDecayDateField] = obj.lastActiveDate || obj.myLastActiveDate || today;
  }
  const days = daysBetween(obj[lastDecayDateField], today);
  if (days <= 0) return false;

  let changed = false;
  let points = obj[pointsField] || 0;
  for (let i = 0; i < days; i++) {
    const level = getLevelFromPoints(points);
    const rate = getDecayRateForLevel(level);
    const before = points;
    points = Math.max(0, points - rate);
    if (points !== before) changed = true;
  }
  obj[pointsField] = points;
  obj[lastDecayDateField] = today;
  return changed;
}

// 打开群聊/群成员管理时调用一次，把这段时间没说话扣的分补上
async function checkAndDecayChat(chat) {
  if (!chat || !chat.isGroup) return;
  const today = todayDateStr();
  let changed = false;

  if (!chat.settings) chat.settings = {};
  if (decayEntity('myLevelPoints', 'myLastDecayDate', chat.settings, today)) changed = true;

  (chat.members || []).forEach(member => {
    if (decayEntity('levelPoints', 'lastDecayDate', member, today)) changed = true;
  });

  if (changed) {
    try {
      await db.chats.put(chat);
    } catch (e) {
      console.warn('checkAndDecayChat 保存失败', e);
    }
  }
}

/* ---------------- 群成员管理列表 (覆盖 misc-features.js 里的简版实现) ---------------- */

function ensureGroupOwnerDefault(chat) {
  // 老群聊没有群主概念，第一次打开管理界面时默认把用户设为群主
  if (chat.isGroup && !chat.ownerId) {
    chat.ownerId = 'user';
    db.chats.put(chat).catch(() => {});
  }
}

function openMemberManagementScreen() {
  if (!state.activeChatId || !state.chats[state.activeChatId].isGroup) return;
  const chat = state.chats[state.activeChatId];
  ensureGroupOwnerDefault(chat);
  checkAndDecayChat(chat).then(() => renderMemberManagementList());
  renderMemberManagementList();
  showScreen('member-management-screen');
}

function renderMemberManagementList() {
  const listEl = document.getElementById('member-management-list');
  const chat = state.chats[state.activeChatId];
  if (!chat || !chat.isGroup) {
    listEl.innerHTML = '';
    return;
  }
  ensureGroupOwnerDefault(chat);
  listEl.innerHTML = '';

  const allParticipants = [
    {
      id: 'user',
      avatar: chat.settings.myAvatar || (typeof defaultMyGroupAvatar !== 'undefined' ? defaultMyGroupAvatar : defaultAvatar),
      groupNickname: chat.settings.myNickname || '我',
      groupTitle: chat.settings.myGroupTitle || '',
      levelPoints: chat.settings.myLevelPoints || 0,
    },
    ...(chat.members || []),
  ];

  allParticipants.sort((a, b) => {
    const isAOwner = a.id === chat.ownerId;
    const isBOwner = b.id === chat.ownerId;
    const isAAdmin = a.id === 'user' ? chat.settings.isUserAdmin : a.isAdmin;
    const isBAdmin = b.id === 'user' ? chat.settings.isUserAdmin : b.isAdmin;
    if (isAOwner) return -1;
    if (isBOwner) return 1;
    if (isAAdmin && !isBAdmin) return -1;
    if (!isAAdmin && isBAdmin) return 1;
    return 0;
  });

  allParticipants.forEach(participant => {
    listEl.appendChild(createMemberManagementItem(participant, chat));
  });
}

function createMemberManagementItem(member, chat) {
  const item = document.createElement('div');
  item.className = 'member-management-item';

  const isCurrentUserOwner = chat.ownerId === 'user';
  const isCurrentUserAdmin = !!chat.settings.isUserAdmin;
  const isThisMemberOwner = member.id === chat.ownerId;
  const isThisMemberAdmin = (member.id === 'user' && chat.settings.isUserAdmin) || member.isAdmin;

  const canManageAdmin = isCurrentUserOwner && !isThisMemberOwner;
  const canManageTitle = (isCurrentUserOwner || isCurrentUserAdmin) && member.id !== 'user';
  const canKick =
    (isCurrentUserOwner && member.id !== 'user') ||
    (isCurrentUserAdmin && !isThisMemberOwner && !isThisMemberAdmin && member.id !== 'user');
  const canMute =
    (isCurrentUserOwner && member.id !== 'user') ||
    (isCurrentUserAdmin && !isThisMemberOwner && !isThisMemberAdmin && member.id !== 'user');

  let roleTag = '';
  if (isThisMemberOwner) {
    roleTag = '<span class="role-tag owner">群主</span>';
  } else if (isThisMemberAdmin) {
    roleTag = '<span class="role-tag admin">管理员</span>';
  }

  const points = member.levelPoints || 0;
  const level = getLevelFromPoints(points);
  const customColor = member.id === 'user' ? chat.settings.myTitleColor : member.titleColor;
  const titleTextForColor = member.id === 'user' ? (chat.settings.myGroupTitle || '') : (member.groupTitle || '');
  const colorInfo = resolveTagColor({
    isOwner: isThisMemberOwner,
    isAdmin: isThisMemberAdmin,
    title: titleTextForColor,
    customColor,
  });
  const levelTag = `<span class="level-tag ${colorInfo.tierClass}" style="${colorInfo.style}">Lv${level}</span>`;

  const titleText = titleTextForColor;
  const titleTag = titleText ? `<span class="title-tag">${titleText}</span>` : '';

  const muteTag = member.isMuted
    ? '<span class="title-tag" style="color:#ff3b30;background:#ffe5e5;">🚫已禁言</span>'
    : '';

  let actionsHtml = '';
  if (member.id === 'user') {
    actionsHtml += `<button class="action-btn" data-action="set-nickname" data-member-id="user">改名</button>`;
    if (chat.settings.isUserMuted) {
      actionsHtml += `<button class="action-btn" data-action="unmute-self" data-member-id="user">解除禁言</button>`;
    }
  }
  if (canManageTitle) {
    actionsHtml += `<button class="action-btn" data-action="set-title" data-member-id="${member.id}">头衔</button>`;
  }
  if (isCurrentUserOwner) {
    actionsHtml += `<button class="action-btn" data-action="set-color" data-member-id="${member.id}">改颜色</button>`;
  }
  if (canManageAdmin) {
    const adminActionText = isThisMemberAdmin ? '取消管理' : '设为管理';
    actionsHtml += `<button class="action-btn" data-action="toggle-admin" data-member-id="${member.id}">${adminActionText}</button>`;
  }
  if (isCurrentUserOwner && member.id !== 'user') {
    actionsHtml += `<button class="action-btn" data-action="transfer-owner" data-member-id="${member.id}">转让</button>`;
  }
  if (canMute) {
    const muteButtonText = member.isMuted ? '解禁' : '禁言';
    actionsHtml += `<button class="action-btn" data-action="mute-member" data-member-id="${member.id}">${muteButtonText}</button>`;
  }
  if (canKick) {
    actionsHtml += `<button class="action-btn danger" data-action="remove-member" data-member-id="${member.id}">踢出</button>`;
  }

  item.innerHTML = `
    <img src="${member.avatar || defaultAvatar}" class="avatar">
    <div class="info">
        <span class="name">${member.groupNickname}</span>
        <div class="tags">
            ${levelTag}
            ${roleTag}
            ${titleTag}
            ${muteTag}
        </div>
        <span class="points-hint">${points} 积分</span>
    </div>
    <div class="actions">${actionsHtml}</div>
  `;
  return item;
}

/* ---------------- 各操作的处理函数 ---------------- */

async function logSystemMessage(chatId, messageContent) {
  const chat = state.chats[chatId];
  if (!chat) return;
  const systemMessage = {
    role: 'system',
    type: 'pat_message',
    content: messageContent,
    timestamp: Date.now(),
  };
  chat.history.push(systemMessage);
  await db.chats.put(chat);
  if (state.activeChatId === chatId && document.getElementById('chat-interface-screen').classList.contains('active')) {
    if (typeof appendMessage === 'function') appendMessage(systemMessage, chat);
  }
  if (typeof renderChatList === 'function') await renderChatList();
}

async function logTitleChange(chatId, actorName, targetName, newTitle) {
  const messageContent = newTitle
    ? `${actorName} 将"${targetName}"的群头衔修改为"${newTitle}"`
    : `${actorName} 取消了"${targetName}"的群头衔`;
  await logSystemMessage(chatId, messageContent);
}

async function handleSetUserNickname() {
  const chat = state.chats[state.activeChatId];
  const oldNickname = chat.settings.myNickname || '我';
  const newNickname = await showCustomPrompt('修改我的群昵称', '请输入新的昵称', oldNickname);
  if (newNickname !== null && newNickname.trim()) {
    chat.settings.myNickname = newNickname.trim();
    await db.chats.put(chat);
    await logSystemMessage(chat.id, `"${oldNickname}"将群昵称修改为"${newNickname.trim()}"`);
    renderMemberManagementList();
  }
}

async function handleSetUserTitle() {
  const chat = state.chats[state.activeChatId];
  const oldTitle = chat.settings.myGroupTitle || '';
  const newTitle = await showCustomPrompt('修改我的群头衔', '留空则为取消头衔', oldTitle);
  if (newTitle !== null) {
    chat.settings.myGroupTitle = newTitle.trim();
    await db.chats.put(chat);
    const myNickname = chat.settings.myNickname || '我';
    await logTitleChange(chat.id, myNickname, myNickname, newTitle.trim());
    renderMemberManagementList();
  }
}

async function handleUserUnmute() {
  const chat = state.chats[state.activeChatId];
  if (!chat || !chat.settings.isUserMuted) return;
  const confirmed = await showCustomConfirm('解除禁言', '确定要为自己解除禁言吗？');
  if (confirmed) {
    chat.settings.isUserMuted = false;
    await db.chats.put(chat);
    await logSystemMessage(chat.id, `"${chat.settings.myNickname || '我'}"为自己解除了禁言。`);
    renderMemberManagementList();
  }
}

async function handleSetMemberTitle(memberId) {
  const chat = state.chats[state.activeChatId];
  const isOwner = chat.ownerId === 'user';
  const isAdmin = chat.settings.isUserAdmin;
  if (!chat || (!isOwner && !isAdmin)) {
    await showCustomAlert('无权限', '你不是群主或管理员，没有权限执行此操作！');
    return;
  }
  const member = chat.members.find(m => m.id === memberId);
  if (!member) return;
  const targetNickname = member.groupNickname;
  const oldTitle = member.groupTitle || '';

  const newTitle = await showCustomPrompt(`为"${targetNickname}"设置头衔`, '留空则为取消头衔', oldTitle);
  if (newTitle !== null) {
    const trimmedTitle = newTitle.trim();
    member.groupTitle = trimmedTitle;
    await db.chats.put(chat);
    const myNickname = chat.settings.myNickname || '我';
    await logTitleChange(chat.id, myNickname, targetNickname, trimmedTitle);
    renderMemberManagementList();
  }
}

async function handleToggleAdmin(memberId) {
  const chat = state.chats[state.activeChatId];
  if (!chat || chat.ownerId !== 'user') {
    await showCustomAlert('无权限', '你不是群主，没有权限执行此操作！');
    return;
  }
  const member = chat.members.find(m => m.id === memberId);
  if (!member) return;
  if (member.id === chat.ownerId) {
    await showCustomAlert('无法操作', '不能对群主进行此操作。');
    return;
  }
  member.isAdmin = !member.isAdmin;
  await db.chats.put(chat);
  const actionText = member.isAdmin ? '设为管理员' : '取消了管理员身份';
  const myNickname = chat.settings.myNickname || '我';
  await logSystemMessage(chat.id, `"${myNickname}"将"${member.groupNickname}"${actionText}。`);
  renderMemberManagementList();
}

async function handleTransferOwnership(memberId) {
  const chat = state.chats[state.activeChatId];
  const newOwner = chat.members.find(m => m.id === memberId);
  if (!newOwner) return;
  const oldOwnerNickname = chat.settings.myNickname || '我';
  const confirmed = await showCustomConfirm(
    '转让群主',
    `你确定要将群主身份转让给"${newOwner.groupNickname}"吗？\n此操作不可撤销，你将失去群主权限。`,
    { confirmButtonClass: 'btn-danger' }
  );
  if (confirmed) {
    chat.ownerId = newOwner.id;
    newOwner.isAdmin = true;
    await logSystemMessage(chat.id, `"${oldOwnerNickname}"已将群主转让给"${newOwner.groupNickname}"`);
    await db.chats.put(chat);
    renderMemberManagementList();
    await showCustomAlert('操作成功', `群主已成功转让给"${newOwner.groupNickname}"。`);
  }
}

async function handleMuteMember(memberId) {
  const chat = state.chats[state.activeChatId];
  if (!chat || !chat.isGroup) return;
  const isOwner = chat.ownerId === 'user';
  const isAdmin = chat.settings.isUserAdmin;
  let targetMember, targetIsOwner, targetIsAdmin;

  if (memberId === 'user') {
    targetMember = { id: 'user', ...chat.settings };
    targetIsOwner = isOwner;
    targetIsAdmin = isAdmin;
  } else {
    targetMember = chat.members.find(m => m.id === memberId);
    if (!targetMember) return;
    targetIsOwner = chat.ownerId === memberId;
    targetIsAdmin = targetMember.isAdmin;
  }

  const canMute = (isOwner && !targetIsOwner) || (isAdmin && !targetIsOwner && !targetIsAdmin);
  if (!canMute) {
    await showCustomAlert('无权限', '你没有权限操作该成员！');
    return;
  }

  if (memberId === 'user') {
    chat.settings.isUserMuted = !chat.settings.isUserMuted;
  } else {
    targetMember.isMuted = !targetMember.isMuted;
  }
  await db.chats.put(chat);
  renderMemberManagementList();

  const myNickname = chat.settings.myNickname || '我';
  const targetNickname = memberId === 'user' ? (chat.settings.myNickname || '我') : targetMember.groupNickname;
  const actionText = (memberId === 'user' ? chat.settings.isUserMuted : targetMember.isMuted) ? '禁言' : '解除禁言';
  await logSystemMessage(chat.id, `"${myNickname}"将"${targetNickname}"${actionText}。`);
}

async function handleSetMemberColor(memberId) {
  const chat = state.chats[state.activeChatId];
  if (!chat || chat.ownerId !== 'user') {
    await showCustomAlert('无权限', '只有群主才能自定义标识颜色！');
    return;
  }
  const isUser = memberId === 'user';
  const targetNickname = isUser ? (chat.settings.myNickname || '我') : (chat.members.find(m => m.id === memberId)?.groupNickname || '');
  const oldColor = isUser ? (chat.settings.myTitleColor || '') : (chat.members.find(m => m.id === memberId)?.titleColor || '');

  const newColor = await showCustomPrompt(
    `为"${targetNickname}"设置标识颜色`,
    '输入十六进制颜色值(如 #17c3b2)，留空则恢复默认三档配色',
    oldColor
  );
  if (newColor === null) return;

  const trimmed = newColor.trim();
  if (trimmed && !/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) {
    await showCustomAlert('格式不对', '请输入合法的十六进制颜色值，例如 #ff6699');
    return;
  }

  if (isUser) {
    chat.settings.myTitleColor = trimmed;
  } else {
    const member = chat.members.find(m => m.id === memberId);
    if (!member) return;
    member.titleColor = trimmed;
  }
  await db.chats.put(chat);
  renderMemberManagementList();
}

async function removeMemberFromGroup(memberId) {
  const chat = state.chats[state.activeChatId];
  if (!chat) return;
  const isOwner = chat.ownerId === 'user';
  const isAdmin = chat.settings.isUserAdmin;
  const memberToRemove = chat.members.find(m => m.id === memberId);
  if (!memberToRemove) return;

  if (!isOwner && !(isAdmin && !memberToRemove.isAdmin && memberToRemove.id !== chat.ownerId)) {
    await showCustomAlert('无权限', '你没有权限移出该成员！');
    return;
  }

  if (chat.members.length <= 2) {
    await showCustomAlert('无法移出', '群聊人数不能少于2人。');
    return;
  }

  const memberIndex = chat.members.findIndex(m => m.id === memberId);
  if (memberIndex === -1) return;

  const memberName = memberToRemove.groupNickname;
  const confirmed = await showCustomConfirm('移出成员', `确定要将"${memberName}"移出群聊吗？`, {
    confirmButtonClass: 'btn-danger',
  });

  if (confirmed) {
    chat.members.splice(memberIndex, 1);
    await db.chats.put(chat);
    const myNickname = chat.settings.myNickname || '我';
    await logSystemMessage(chat.id, `"${myNickname}"将"${memberName}"移出了群聊。`);
    renderMemberManagementList();
  }
}

/* ---------------- 事件绑定：处理头衔/管理员/禁言/转让等按钮 ---------------- */
document.getElementById('member-management-list')?.addEventListener('click', (e) => {
  const button = e.target.closest('.action-btn');
  if (!button) return;
  const action = button.dataset.action;
  const memberId = button.dataset.memberId;
  if (!action || !memberId) return;

  if (memberId === 'user') {
    if (action === 'set-nickname') handleSetUserNickname();
    if (action === 'set-title') handleSetUserTitle();
    if (action === 'unmute-self') handleUserUnmute();
    if (action === 'set-color') handleSetMemberColor('user');
    return;
  }

  switch (action) {
    case 'toggle-admin':
      handleToggleAdmin(memberId);
      break;
    case 'set-title':
      handleSetMemberTitle(memberId);
      break;
    case 'set-color':
      handleSetMemberColor(memberId);
      break;
    case 'transfer-owner':
      handleTransferOwnership(memberId);
      break;
    case 'mute-member':
      handleMuteMember(memberId);
      break;
    case 'remove-member':
      removeMemberFromGroup(memberId);
      break;
  }
});

window.getLevelFromPoints = getLevelFromPoints;
window.getGroupTitleTag = getGroupTitleTag;
window.getGroupBadge = getGroupBadge;
window.resolveTagColor = resolveTagColor;
window.awardGroupActivity = awardGroupActivity;
window.checkAndDecayChat = checkAndDecayChat;
window.openMemberManagementScreen = openMemberManagementScreen;
window.renderMemberManagementList = renderMemberManagementList;
window.removeMemberFromGroup = removeMemberFromGroup;
