// ============================================================
// reply-task-store.js — AI 回复任务持久化与崩溃恢复元数据
// 不保存 API Key、完整系统提示词或可直接重放的敏感请求。
// ============================================================
(function () {
  'use strict';

  const ACTIVE_STATUSES = ['queued', 'requesting', 'receiving', 'parsing', 'applying'];
  const RECOVERABLE_STATUSES = [...ACTIVE_STATUSES, 'interrupted', 'failed'];
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const heartbeatPrefix = 'ephone_reply_guardian_session_';

  function heartbeatKey(id) {
    return `${heartbeatPrefix}${id}`;
  }

  function writeHeartbeat() {
    try { localStorage.setItem(heartbeatKey(sessionId), String(Date.now())); } catch (_) {}
  }

  function isSessionAlive(id) {
    if (!id) return false;
    try {
      const lastBeat = Number(localStorage.getItem(heartbeatKey(id)) || 0);
      return Date.now() - lastBeat < 12000;
    } catch (_) {
      return false;
    }
  }

  function table() {
    return window.db && window.db.replyTasks ? window.db.replyTasks : null;
  }

  function emit(task, previousStatus) {
    window.dispatchEvent(new CustomEvent('replyguardian:taskchange', {
      detail: { task, previousStatus }
    }));
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `reply-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function safeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  }

  function safeProvider(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value, window.location.origin);
      // 诊断只需要接口位置；不持久化账号信息、查询参数或片段。
      return safeText(`${url.origin}${url.pathname}`, 200);
    } catch (_) {
      return safeText(value.replace(/[?#].*$/, ''), 200);
    }
  }

  async function get(id) {
    const taskTable = table();
    return taskTable && id ? taskTable.get(id) : null;
  }

  async function begin(details) {
    const taskTable = table();
    if (!taskTable) return null;

    const now = Date.now();
    const task = {
      id: createId(),
      chatId: details.chatId,
      chatName: safeText(details.chatName || '聊天对象', 80),
      status: 'requesting',
      stageLabel: '正在连接模型',
      model: safeText(details.model || '', 160),
      provider: safeProvider(details.provider || ''),
      stream: !!details.stream,
      userMessageTimestamp: details.userMessageTimestamp || null,
      userMessagePreview: safeText(details.userMessagePreview || '', 240),
      partialResponse: '',
      responseLength: 0,
      retryCount: 0,
      ownerSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
      backgroundedAt: null,
      completedAt: null,
      dismissedAt: null,
      lastError: ''
    };

    await taskTable.put(task);
    emit(task, null);
    return task.id;
  }

  async function update(id, patch) {
    const taskTable = table();
    if (!taskTable || !id) return null;
    const existing = await taskTable.get(id);
    if (!existing) return null;
    const task = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: Date.now()
    };
    if (typeof task.partialResponse === 'string' && task.partialResponse.length > 1000000) {
      task.partialResponse = task.partialResponse.slice(-1000000);
      task.partialResponseTruncated = true;
    }
    await taskTable.put(task);
    emit(task, existing.status);
    return task;
  }

  async function setStage(id, status, stageLabel, extra) {
    return update(id, { status, stageLabel, ...(extra || {}) });
  }

  async function saveResponse(id, responseText) {
    const text = typeof responseText === 'string' ? responseText : '';
    return update(id, {
      status: 'parsing',
      stageLabel: '正在整理回复',
      partialResponse: text,
      responseLength: text.length
    });
  }

  async function complete(id, details) {
    return update(id, {
      status: 'completed',
      stageLabel: '回复已完成',
      partialResponse: '',
      completedAt: Date.now(),
      resultMessageCount: details && details.messageCount || 0,
      lastError: ''
    });
  }

  async function fail(id, error, wasCanceled) {
    return update(id, {
      status: wasCanceled ? 'canceled' : 'failed',
      stageLabel: wasCanceled ? '已取消回复' : '回复未完成',
      lastError: safeText(error && error.message ? error.message : String(error || ''), 800)
    });
  }

  async function markBackgrounded() {
    const taskTable = table();
    if (!taskTable) return;
    const active = await taskTable.where('status').anyOf(ACTIVE_STATUSES).toArray();
    const now = Date.now();
    await Promise.all(active.map(task => update(task.id, { backgroundedAt: now })));
  }

  async function recoverPreviousSession() {
    const taskTable = table();
    if (!taskTable) return [];
    const active = await taskTable.where('status').anyOf(ACTIVE_STATUSES).toArray();
    const recovered = [];
    for (const task of active) {
      if (task.ownerSessionId === sessionId) continue;
      // 另一标签页仍在处理时不抢占任务；避免重复生成。
      if (isSessionAlive(task.ownerSessionId)) continue;
      const next = await update(task.id, {
        status: 'interrupted',
        stageLabel: '页面曾被暂停，可继续生成',
        ownerSessionId: sessionId
      });
      if (next) recovered.push(next);
    }
    return recovered;
  }

  async function listRecoverable(chatId) {
    const taskTable = table();
    if (!taskTable) return [];
    let tasks;
    if (chatId) {
      tasks = await taskTable.where('chatId').equals(chatId).toArray();
    } else {
      tasks = await taskTable.toArray();
    }
    return tasks
      .filter(task => RECOVERABLE_STATUSES.includes(task.status) && !task.dismissedAt)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function dismiss(id) {
    return update(id, { dismissedAt: Date.now() });
  }

  async function prepareRetry(id) {
    const task = await get(id);
    if (!task) return null;
    return update(id, {
      status: 'canceled',
      stageLabel: '已由新的回复任务接替',
      dismissedAt: Date.now(),
      retryCount: (task.retryCount || 0) + 1
    });
  }

  async function cleanup() {
    const taskTable = table();
    if (!taskTable) return;
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const oldTasks = await taskTable.where('updatedAt').below(cutoff).primaryKeys();
    if (oldTasks.length) await taskTable.bulkDelete(oldTasks);
  }

  window.ReplyTaskStore = {
    ACTIVE_STATUSES,
    sessionId,
    begin,
    get,
    update,
    setStage,
    saveResponse,
    complete,
    fail,
    markBackgrounded,
    recoverPreviousSession,
    listRecoverable,
    dismiss,
    prepareRetry,
    cleanup
  };

  writeHeartbeat();
  window.setInterval(writeHeartbeat, 5000);
  document.addEventListener('visibilitychange', writeHeartbeat);
  window.addEventListener('pagehide', () => {
    try { localStorage.removeItem(heartbeatKey(sessionId)); } catch (_) {}
  });
})();
