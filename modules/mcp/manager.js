(function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    id: 'main',
    autoReconnect: true,
    showChatCards: true,
    includeResultDetails: false,
    activityRetentionDays: 30,
    timeoutMs: 20000
  };

  const CONNECTION_TYPES = {
    remote: {
      label: '远程 MCP',
      short: '远程',
      description: '连接支持 Streamable HTTP 的 HTTPS 服务',
      endpoint: true
    },
    termux: {
      label: 'Termux 执行器',
      short: '安卓',
      description: '通过安卓 Termux 中运行的桥接端点连接',
      endpoint: true
    },
    ios_ish: {
      label: 'iOS 执行器',
      short: '苹果',
      description: '连接 iSH 或兼容的 iOS 本地桥接器',
      endpoint: true
    },
    ios_shortcuts: {
      label: '苹果快捷指令',
      short: '快捷指令',
      description: '把一次性动作作为可启动的本地通道',
      shortcut: true
    },
    bluetooth: {
      label: '蓝牙设备',
      short: '蓝牙',
      description: '浏览器直连 BLE，或连接蓝牙桥接端点',
      bluetooth: true
    },
    computer: {
      label: '电脑节点',
      short: '电脑',
      description: '连接 Windows、macOS 或 Linux 上的 MCP Bridge',
      endpoint: true,
      pairing: true
    },
    custom: {
      label: '自定义桥接器',
      short: '自定义',
      description: '连接兼容 MCP HTTP 协议的自托管通道',
      endpoint: true
    }
  };

  const STATUS_LABELS = {
    online: '已连接',
    offline: '未连接',
    testing: '连接中',
    error: '异常',
    disabled: '已停用',
    paired: '已配对',
    ready: '可启动',
    pending: '待确认',
    running: '执行中',
    success: '已完成',
    failed: '失败',
    cancelled: '已取消'
  };

  const state = {
    connections: [],
    activities: [],
    settings: { ...DEFAULT_SETTINGS },
    activeTab: 'connections',
    initialized: false,
    busy: new Set(),
    sessions: new Map()
  };

  let els = {};

  function uid(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}_${window.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatTime(value, includeDate) {
    if (!value) return '暂无';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '暂无';
    const options = includeDate
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' };
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
  }

  function truncate(value, maxLength) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function iconSvg(kind) {
    const attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    const icons = {
      remote: `<svg ${attrs}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`,
      termux: `<svg ${attrs}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 15h5"/></svg>`,
      ios_ish: `<svg ${attrs}><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg>`,
      ios_shortcuts: `<svg ${attrs}><path d="m8 7 4-4 4 4-4 4-4-4Z"/><path d="m8 17 4-4 4 4-4 4-4-4Z"/><path d="m4 12 4-4 4 4-4 4-4-4ZM12 12l4-4 4 4-4 4-4-4Z"/></svg>`,
      bluetooth: `<svg ${attrs}><path d="m7 7 10 10-5 4V3l5 4L7 17"/></svg>`,
      computer: `<svg ${attrs}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
      custom: `<svg ${attrs}><path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4"/><circle cx="12" cy="12" r="3"/></svg>`,
      activity: `<svg ${attrs}><path d="M4 12h3l2-6 4 12 2-6h5"/></svg>`,
      empty: `<svg ${attrs}><circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="17" r="2"/><path d="m7.7 8.1 3 7M16.3 8.1l-3 7M8 7h8"/></svg>`
    };
    return icons[kind] || icons.custom;
  }

  function typeInfo(type) {
    return CONNECTION_TYPES[type] || CONNECTION_TYPES.custom;
  }

  function statusClass(connection) {
    if (!connection.enabled) return 'disabled';
    return connection.status || 'offline';
  }

  function statusLabel(connection) {
    return STATUS_LABELS[statusClass(connection)] || '未连接';
  }

  async function loadData() {
    if (!window.db || !db.mcpConnections) return;
    const cutoff = Date.now() - (state.settings.activityRetentionDays || 30) * 86400000;
    const [connections, activities, savedSettings, secrets] = await Promise.all([
      db.mcpConnections.toArray(),
      db.mcpActivities.orderBy('createdAt').reverse().limit(150).toArray(),
      db.mcpSettings.get('main'),
      db.mcpSecrets.toArray()
    ]);
    const secretMap = new Map(secrets.map(item => [item.id, item]));
    state.connections = connections.map(connection => {
      const secret = secretMap.get(connection.id);
      const session = state.sessions.get(connection.id);
      return { ...connection, ...(secret || {}), ...(session || {}), id: connection.id };
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.activities = activities;
    state.settings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) };
    if (cutoff > 0) {
      db.mcpActivities.where('createdAt').below(cutoff).delete().catch(error => {
        console.warn('[MCP] 清理过期活动失败:', error);
      });
    }
  }

  async function openMcpScreen() {
    if (typeof window.showScreen === 'function') window.showScreen('mcp-screen');
    await loadData();
    render();
  }

  function updateSummary() {
    if (!els.summaryTitle) return;
    const enabled = state.connections.filter(item => item.enabled);
    const online = enabled.filter(item => ['online', 'paired', 'ready'].includes(item.status));
    const errors = enabled.filter(item => item.status === 'error');
    if (!state.connections.length) {
      els.summaryTitle.textContent = '尚未连接';
      els.summaryDetail.textContent = '不会预装服务，由你连接自己的 MCP';
      els.summaryDot.className = 'mcp-summary-dot';
    } else if (online.length) {
      els.summaryTitle.textContent = `${online.length} 个通道可用`;
      els.summaryDetail.textContent = `共 ${state.connections.length} 个连接，${enabled.length} 个已启用`;
      els.summaryDot.className = 'mcp-summary-dot online';
    } else if (errors.length) {
      els.summaryTitle.textContent = `${errors.length} 个连接异常`;
      els.summaryDetail.textContent = '打开连接详情可查看诊断信息';
      els.summaryDot.className = 'mcp-summary-dot warning';
    } else {
      els.summaryTitle.textContent = '连接均未就绪';
      els.summaryDetail.textContent = `已保存 ${state.connections.length} 个连接`;
      els.summaryDot.className = 'mcp-summary-dot';
    }
  }

  function render() {
    if (!els.content) return;
    updateSummary();
    document.querySelectorAll('.mcp-tab').forEach(tab => {
      const active = tab.dataset.mcpTab === state.activeTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    if (state.activeTab === 'connections') renderConnections();
    if (state.activeTab === 'capabilities') renderCapabilities();
    if (state.activeTab === 'activity') renderActivities();
    if (state.activeTab === 'settings') renderSettings();
  }

  function emptyState(title, text, actionText, action) {
    return `
      <div class="mcp-panel mcp-empty">
        <div class="mcp-empty-icon">${iconSvg('empty')}</div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(text)}</p>
        ${actionText ? `<button type="button" class="mcp-primary-btn" data-mcp-action="${escapeHtml(action)}">${escapeHtml(actionText)}</button>` : ''}
      </div>`;
  }

  function renderConnections() {
    if (!state.connections.length) {
      els.content.innerHTML = emptyState(
        '连接你自己的 MCP',
        '支持远程服务、手机执行器、蓝牙桥接和电脑节点，不会自动安装任何服务。',
        '添加连接',
        'add'
      ) + `
        <div class="mcp-action-strip">
          <button type="button" class="mcp-secondary-btn" data-mcp-action="import">导入配置</button>
        </div>`;
      return;
    }

    const rows = state.connections.map(connection => {
      const info = typeInfo(connection.type);
      const busy = state.busy.has(connection.id);
      const meta = connection.type === 'ios_shortcuts'
        ? connection.shortcutName || '尚未填写快捷指令'
        : connection.type === 'bluetooth' && connection.deviceName
          ? connection.deviceName
          : connection.endpoint || '等待配置端点';
      return `
        <div class="mcp-connection" data-connection-id="${escapeHtml(connection.id)}">
          <div class="mcp-kind-icon">${iconSvg(connection.type)}</div>
          <div class="mcp-connection-main">
            <div class="mcp-connection-name">
              <span>${escapeHtml(connection.name)}</span>
              <span class="mcp-status-tag ${statusClass(connection)}">${busy ? '连接中' : statusLabel(connection)}</span>
            </div>
            <div class="mcp-connection-meta">${escapeHtml(info.short)} · ${escapeHtml(truncate(meta, 58))}</div>
          </div>
          <div class="mcp-row-actions">
            <button type="button" class="mcp-small-btn" data-mcp-action="test" data-id="${escapeHtml(connection.id)}" ${busy || !connection.enabled ? 'disabled' : ''}>${connection.type === 'bluetooth' ? '配对' : '测试'}</button>
            <button type="button" class="mcp-icon-btn" data-mcp-action="details" data-id="${escapeHtml(connection.id)}" aria-label="查看详情" title="查看详情">›</button>
          </div>
        </div>`;
    }).join('');

    els.content.innerHTML = `
      <div class="mcp-section-title">我的连接</div>
      <div class="mcp-panel">${rows}</div>
      <div class="mcp-action-strip">
        <button type="button" class="mcp-secondary-btn" data-mcp-action="import">导入配置</button>
        <button type="button" class="mcp-secondary-btn" data-mcp-action="export">导出配置</button>
      </div>`;
  }

  function collectCapabilities() {
    const groups = [];
    state.connections.filter(item => item.enabled).forEach(connection => {
      const capabilities = connection.capabilities || {};
      ['tools', 'resources', 'prompts'].forEach(kind => {
        const items = Array.isArray(capabilities[kind]) ? capabilities[kind] : [];
        items.forEach(item => groups.push({ connection, kind, item }));
      });
    });
    return groups;
  }

  function capabilityLabel(kind) {
    return kind === 'tools' ? '工具' : kind === 'resources' ? '资源' : '提示词';
  }

  function renderCapabilities() {
    const capabilities = collectCapabilities();
    if (!capabilities.length) {
      els.content.innerHTML = emptyState(
        '尚未发现能力',
        '测试一个远程或桥接连接后，这里会显示服务器提供的工具、资源和提示词。',
        state.connections.length ? '返回连接' : '添加连接',
        state.connections.length ? 'connections-tab' : 'add'
      );
      return;
    }

    const rows = capabilities.map(({ connection, kind, item }) => {
      const name = item.title || item.name || item.uri || '未命名能力';
      const description = item.description || item.mimeType || item.uri || `${connection.name} 提供`;
      const actionLabel = kind === 'tools' ? '调用' : kind === 'resources' ? '读取' : '使用';
      return `
        <div class="mcp-capability">
          <div class="mcp-capability-main">
            <div class="mcp-capability-name">
              <span>${escapeHtml(name)}</span>
              <span class="mcp-type-tag">${capabilityLabel(kind)}</span>
            </div>
            <div class="mcp-capability-desc">${escapeHtml(connection.name)} · ${escapeHtml(truncate(description, 100))}</div>
          </div>
          <button type="button" class="mcp-small-btn" data-mcp-action="${kind === 'tools' ? 'invoke' : 'consume-capability'}" data-id="${escapeHtml(connection.id)}" data-kind="${escapeHtml(kind)}" data-name="${escapeHtml(item.name || item.uri || '')}">${actionLabel}</button>
        </div>`;
    }).join('');

    els.content.innerHTML = `
      <div class="mcp-section-title">已发现 ${capabilities.length} 项能力</div>
      <div class="mcp-panel">${rows}</div>`;
  }

  function renderActivities() {
    if (!state.activities.length) {
      els.content.innerHTML = emptyState('暂无活动', '连接测试、工具调用和错误记录会显示在这里。', '', '');
      return;
    }
    const rows = state.activities.map(activity => `
      <div class="mcp-activity-row">
        <div class="mcp-activity-main">
          <div class="mcp-activity-name">
            <span>${escapeHtml(activity.title || 'MCP 活动')}</span>
            <span class="mcp-status-tag ${escapeHtml(activity.status || 'offline')}">${escapeHtml(STATUS_LABELS[activity.status] || activity.status || '记录')}</span>
          </div>
          <div class="mcp-activity-meta">${escapeHtml(activity.connectionName || '未知连接')} · ${formatTime(activity.createdAt, true)}${activity.summary ? ` · ${escapeHtml(truncate(activity.summary, 70))}` : ''}</div>
        </div>
        <button type="button" class="mcp-icon-btn" data-mcp-action="activity-details" data-id="${escapeHtml(activity.id)}" aria-label="查看活动详情" title="查看详情">›</button>
      </div>`).join('');
    els.content.innerHTML = `
      <div class="mcp-section-title">最近活动</div>
      <div class="mcp-panel">${rows}</div>
      <div class="mcp-action-strip">
        <button type="button" class="mcp-secondary-btn" data-mcp-action="clear-activity">清除活动记录</button>
      </div>`;
  }

  function settingToggle(name, label, description, checked) {
    return `
      <div class="mcp-setting-row">
        <div class="mcp-setting-main">
          <div class="mcp-setting-name">${escapeHtml(label)}</div>
          <div class="mcp-setting-desc">${escapeHtml(description)}</div>
        </div>
        <label class="mcp-toggle">
          <input type="checkbox" data-mcp-setting="${escapeHtml(name)}" ${checked ? 'checked' : ''}>
          <span></span>
        </label>
      </div>`;
  }

  function renderSettings() {
    els.content.innerHTML = `
      <div class="mcp-section-title">运行</div>
      <div class="mcp-panel">
        ${settingToggle('autoReconnect', '自动恢复连接', '页面从后台恢复时重新检查已启用连接', state.settings.autoReconnect)}
        ${settingToggle('showChatCards', '显示对话活动卡片', '工具调用可同步到当前聊天并保留执行状态', state.settings.showChatCards)}
        ${settingToggle('includeResultDetails', '卡片保留完整结果', '关闭时只在聊天中保存结果摘要', state.settings.includeResultDetails)}
        <div class="mcp-setting-row">
          <div class="mcp-setting-main">
            <div class="mcp-setting-name">连接超时</div>
            <div class="mcp-setting-desc">用于握手、能力发现和工具调用</div>
          </div>
          <select class="mcp-small-btn" data-mcp-setting="timeoutMs" aria-label="连接超时">
            <option value="10000" ${state.settings.timeoutMs === 10000 ? 'selected' : ''}>10 秒</option>
            <option value="20000" ${state.settings.timeoutMs === 20000 ? 'selected' : ''}>20 秒</option>
            <option value="30000" ${state.settings.timeoutMs === 30000 ? 'selected' : ''}>30 秒</option>
          </select>
        </div>
        <div class="mcp-setting-row">
          <div class="mcp-setting-main">
            <div class="mcp-setting-name">活动保留</div>
            <div class="mcp-setting-desc">仅影响 MCP 中心日志，不删除聊天卡片</div>
          </div>
          <select class="mcp-small-btn" data-mcp-setting="activityRetentionDays" aria-label="活动保留时间">
            <option value="7" ${state.settings.activityRetentionDays === 7 ? 'selected' : ''}>7 天</option>
            <option value="30" ${state.settings.activityRetentionDays === 30 ? 'selected' : ''}>30 天</option>
            <option value="90" ${state.settings.activityRetentionDays === 90 ? 'selected' : ''}>90 天</option>
          </select>
        </div>
      </div>
      <div class="mcp-section-title">数据</div>
      <div class="mcp-panel">
        <div class="mcp-setting-row" data-mcp-action="export">
          <div class="mcp-setting-main"><div class="mcp-setting-name">导出连接配置</div><div class="mcp-setting-desc">不会导出 Token、API Key 和会话标识</div></div>
          <button type="button" class="mcp-icon-btn" data-mcp-action="export" aria-label="导出配置">›</button>
        </div>
        <div class="mcp-setting-row" data-mcp-action="import">
          <div class="mcp-setting-main"><div class="mcp-setting-name">导入连接配置</div><div class="mcp-setting-desc">导入前会校验格式，不会自动启用连接</div></div>
          <button type="button" class="mcp-icon-btn" data-mcp-action="import" aria-label="导入配置">›</button>
        </div>
      </div>
      <div class="mcp-inline-notice info" style="margin-top:12px;">MCP 中心不会预装服务器，也不会在后台替你启动本地程序。Termux、iSH、蓝牙和电脑节点需要用户自己的执行器或桥接端点。</div>`;
  }

  function showSheet(title, bodyHtml, actionsHtml) {
    els.sheetTitle.textContent = title;
    els.sheetBody.innerHTML = bodyHtml;
    els.sheetActions.innerHTML = actionsHtml || '';
    els.sheetBackdrop.classList.add('visible');
    els.sheetBackdrop.setAttribute('aria-hidden', 'false');
    const firstControl = els.sheetBody.querySelector('input, select, textarea, button');
    if (firstControl) setTimeout(() => firstControl.focus({ preventScroll: true }), 50);
  }

  function closeSheet() {
    els.sheetBackdrop.classList.remove('visible');
    els.sheetBackdrop.setAttribute('aria-hidden', 'true');
    els.sheetBody.innerHTML = '';
    els.sheetActions.innerHTML = '';
  }

  function showTypeChooser() {
    const options = Object.entries(CONNECTION_TYPES).map(([key, info]) => `
      <button type="button" class="mcp-type-option" data-mcp-type="${escapeHtml(key)}">
        <strong>${escapeHtml(info.label)}</strong>
        <span>${escapeHtml(info.description)}</span>
      </button>`).join('');
    showSheet(
      '添加连接',
      `<div class="mcp-type-grid">${options}</div>
       <div class="mcp-inline-notice info" style="margin-top:12px;">手机浏览器不能直接启动 stdio 服务。此类 MCP 请通过 Termux、iOS 执行器或电脑节点转换为可连接端点。</div>`,
      ''
    );
  }

  function endpointFields(connection, info) {
    if (!info.endpoint && !(info.bluetooth && connection.bluetoothMode === 'bridge')) return '';
    return `
      <div class="mcp-field">
        <label for="mcp-form-endpoint">MCP 端点</label>
        <input id="mcp-form-endpoint" name="endpoint" type="url" inputmode="url" value="${escapeHtml(connection.endpoint || '')}" placeholder="https://example.com/mcp" autocomplete="off" required>
        <span class="mcp-field-note">需要支持浏览器跨域访问；本地 HTTP 在 HTTPS PWA 中可能被拦截。</span>
      </div>
      <div class="mcp-form-row">
        <div class="mcp-field">
          <label for="mcp-form-transport">传输方式</label>
          <select id="mcp-form-transport" name="transport">
            <option value="auto" ${(connection.transport || 'auto') === 'auto' ? 'selected' : ''}>自动检测</option>
            <option value="streamable_http" ${connection.transport === 'streamable_http' ? 'selected' : ''}>Streamable HTTP</option>
            <option value="bridge" ${connection.transport === 'bridge' ? 'selected' : ''}>兼容桥接器</option>
          </select>
        </div>
        <div class="mcp-field">
          <label for="mcp-form-auth">认证方式</label>
          <select id="mcp-form-auth" name="authType">
            <option value="none" ${(connection.authType || 'none') === 'none' ? 'selected' : ''}>无认证</option>
            <option value="bearer" ${connection.authType === 'bearer' ? 'selected' : ''}>Bearer Token</option>
            <option value="api_key" ${connection.authType === 'api_key' ? 'selected' : ''}>API Key Header</option>
            <option value="custom" ${connection.authType === 'custom' ? 'selected' : ''}>自定义 Header</option>
          </select>
        </div>
      </div>
      <div id="mcp-auth-fields"></div>
      <div class="mcp-field">
        <label for="mcp-form-headers">附加 Headers（JSON，可选）</label>
        <textarea id="mcp-form-headers" name="customHeaders" spellcheck="false" placeholder='{"X-Workspace": "personal"}'>${escapeHtml(connection.customHeaders ? JSON.stringify(connection.customHeaders, null, 2) : '')}</textarea>
      </div>`;
  }

  function connectionForm(type, existing) {
    const info = typeInfo(type);
    const connection = existing || {
      type,
      name: info.label,
      enabled: true,
      transport: type === 'custom' || type === 'computer' || type === 'termux' || type === 'ios_ish' ? 'bridge' : 'auto',
      authType: 'none',
      availability: 'manual',
      bluetoothMode: 'direct'
    };
    const shortcutFields = info.shortcut ? `
      <div class="mcp-field">
        <label for="mcp-form-shortcut">快捷指令名称</label>
        <input id="mcp-form-shortcut" name="shortcutName" value="${escapeHtml(connection.shortcutName || '')}" placeholder="例如：添加提醒事项" required>
        <span class="mcp-field-note">快捷指令适合一次性动作，不会伪装成长连接 MCP。</span>
      </div>` : '';
    const bluetoothFields = info.bluetooth ? `
      <div class="mcp-field">
        <label for="mcp-form-bluetooth-mode">蓝牙接入方式</label>
        <select id="mcp-form-bluetooth-mode" name="bluetoothMode">
          <option value="direct" ${(connection.bluetoothMode || 'direct') === 'direct' ? 'selected' : ''}>浏览器直接连接 BLE</option>
          <option value="bridge" ${connection.bluetoothMode === 'bridge' ? 'selected' : ''}>通过手机或电脑桥接器</option>
        </select>
      </div>
      <div class="mcp-field" id="mcp-bluetooth-service-field">
        <label for="mcp-form-service-uuid">BLE Service UUID（可选）</label>
        <input id="mcp-form-service-uuid" name="serviceUuid" value="${escapeHtml(connection.serviceUuid || '')}" placeholder="0000180d-0000-1000-8000-00805f9b34fb">
      </div>
      <div id="mcp-bluetooth-endpoint-fields"></div>
      <div class="mcp-inline-notice">Safari/PWA 无法直接使用 Web Bluetooth，会保留此连接并提示改用 iOS 或电脑桥接器。</div>` : '';
    const pairingField = info.pairing ? `
      <div class="mcp-field">
        <label for="mcp-form-pairing">配对码（可选）</label>
        <input id="mcp-form-pairing" name="pairingCode" inputmode="numeric" value="${escapeHtml(connection.pairingCode || '')}" placeholder="由电脑节点显示的一次性配对码" autocomplete="one-time-code">
      </div>` : '';

    showSheet(
      existing ? '编辑连接' : info.label,
      `<form class="mcp-form" id="mcp-connection-form" data-type="${escapeHtml(type)}" data-id="${escapeHtml(existing ? existing.id : '')}">
        <div class="mcp-field">
          <label for="mcp-form-name">连接名称</label>
          <input id="mcp-form-name" name="name" value="${escapeHtml(connection.name || info.label)}" maxlength="60" required>
        </div>
        ${shortcutFields}
        ${bluetoothFields}
        ${pairingField}
        <div id="mcp-standard-endpoint-fields">${info.endpoint ? endpointFields(connection, info) : ''}</div>
        <div class="mcp-field">
          <label for="mcp-form-availability">对话卡片范围</label>
          <select id="mcp-form-availability" name="availability">
            <option value="manual" ${(connection.availability || 'manual') === 'manual' ? 'selected' : ''}>仅保留在 MCP 中心</option>
            <option value="all_chats" ${connection.availability === 'all_chats' ? 'selected' : ''}>可同步到所有聊天</option>
            <option value="current_chat" ${connection.availability === 'current_chat' ? 'selected' : ''} ${window.state && window.state.activeChatId ? '' : 'disabled'}>仅同步到当前聊天</option>
          </select>
        </div>
        <label class="mcp-setting-row" style="padding:8px 0;border:0;">
          <div class="mcp-setting-main"><div class="mcp-setting-name">启用连接</div><div class="mcp-setting-desc">关闭后保留配置和能力记录</div></div>
          <span class="mcp-toggle"><input type="checkbox" name="enabled" ${connection.enabled !== false ? 'checked' : ''}><span></span></span>
        </label>
      </form>`,
      `<button type="button" class="mcp-secondary-btn" data-mcp-action="close-sheet">取消</button>
       <button type="button" class="mcp-primary-btn" data-mcp-action="save-connection">保存</button>`
    );
    updateConditionalFormFields(connection);
  }

  function authFieldsHtml(authType, connection) {
    if (authType === 'none') return '';
    const label = authType === 'bearer' ? 'Bearer Token' : authType === 'api_key' ? 'API Key' : 'Header 值';
    const headerName = authType === 'api_key'
      ? (connection.headerName || 'X-API-Key')
      : authType === 'custom'
        ? (connection.headerName || '')
        : '';
    return `
      ${authType !== 'bearer' ? `<div class="mcp-field"><label for="mcp-form-header-name">Header 名称</label><input id="mcp-form-header-name" name="headerName" value="${escapeHtml(headerName)}" placeholder="X-API-Key"></div>` : ''}
      <div class="mcp-field">
        <label for="mcp-form-secret">${label}</label>
        <input id="mcp-form-secret" name="secret" type="password" value="" placeholder="${connection.secret ? '已保存；留空保持不变' : '仅保存在本机数据库'}" autocomplete="off">
      </div>`;
  }

  function bindAuthFields(form, connection) {
    const authSelect = form && form.elements.authType;
    const authTarget = document.getElementById('mcp-auth-fields');
    if (!authSelect || !authTarget) return;
    const refreshAuth = () => {
      authTarget.innerHTML = authFieldsHtml(authSelect.value, connection || {});
    };
    refreshAuth();
    authSelect.onchange = refreshAuth;
  }

  function updateConditionalFormFields(connection) {
    const form = document.getElementById('mcp-connection-form');
    if (!form) return;
    bindAuthFields(form, connection);
    const bluetoothMode = form.elements.bluetoothMode;
    const bluetoothEndpoint = document.getElementById('mcp-bluetooth-endpoint-fields');
    const serviceField = document.getElementById('mcp-bluetooth-service-field');
    if (bluetoothMode && bluetoothEndpoint) {
      const refresh = () => {
        const isBridge = bluetoothMode.value === 'bridge';
        serviceField.style.display = isBridge ? 'none' : 'flex';
        bluetoothEndpoint.innerHTML = isBridge ? endpointFields({ ...(connection || {}), bluetoothMode: 'bridge' }, { endpoint: true }) : '';
        if (isBridge) bindAuthFields(form, connection);
      };
      bluetoothMode.onchange = refresh;
      if (bluetoothMode.value === 'bridge') refresh();
    }
  }

  function parseHeaders(value) {
    if (!String(value || '').trim()) return {};
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('附加 Headers 必须是 JSON 对象。');
    }
    const blocked = ['host', 'origin', 'cookie', 'content-length', 'accept', 'content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version'];
    Object.keys(parsed).forEach(key => {
      if (blocked.includes(key.toLowerCase())) throw new Error(`浏览器不允许设置 ${key} Header。`);
      if (typeof parsed[key] !== 'string') throw new Error(`Header ${key} 的值必须是字符串。`);
    });
    return parsed;
  }

  function connectionForStorage(connection) {
    const stored = { ...connection };
    delete stored.secret;
    delete stored.sessionId;
    delete stored.pairingCode;
    delete stored.deviceId;
    return stored;
  }

  async function persistConnection(connection) {
    const secureRecord = {
      id: connection.id,
      secret: connection.secret || '',
      pairingCode: connection.pairingCode || '',
      deviceId: connection.deviceId || '',
      updatedAt: Date.now()
    };
    await db.transaction('rw', db.mcpConnections, db.mcpSecrets, async () => {
      await db.mcpConnections.put(connectionForStorage(connection));
      if (secureRecord.secret || secureRecord.pairingCode || secureRecord.deviceId) await db.mcpSecrets.put(secureRecord);
      else await db.mcpSecrets.delete(connection.id);
    });
  }

  async function saveConnectionFromForm() {
    const form = document.getElementById('mcp-connection-form');
    if (!form || !form.reportValidity()) return;
    const formData = new FormData(form);
    const type = form.dataset.type;
    const existing = state.connections.find(item => item.id === form.dataset.id);
    let customHeaders;
    try {
      customHeaders = parseHeaders(formData.get('customHeaders'));
    } catch (error) {
      await showCustomAlert('配置有误', error.message);
      return;
    }
    const endpoint = String(formData.get('endpoint') || '').trim();
    if (endpoint) {
      try {
        const url = new URL(endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch (error) {
        await showCustomAlert('地址无效', 'MCP 端点必须是完整的 HTTP 或 HTTPS 地址。');
        return;
      }
    }
    const now = Date.now();
    const connection = {
      ...(existing || {}),
      id: existing ? existing.id : uid('mcp'),
      type,
      name: String(formData.get('name') || typeInfo(type).label).trim(),
      endpoint,
      transport: String(formData.get('transport') || (type === 'ios_shortcuts' ? 'shortcut' : type === 'bluetooth' ? 'bluetooth' : 'auto')),
      authType: String(formData.get('authType') || 'none'),
      headerName: String(formData.get('headerName') || '').trim(),
      customHeaders,
      shortcutName: String(formData.get('shortcutName') || '').trim(),
      bluetoothMode: String(formData.get('bluetoothMode') || ''),
      serviceUuid: String(formData.get('serviceUuid') || '').trim(),
      pairingCode: String(formData.get('pairingCode') || '').trim(),
      availability: String(formData.get('availability') || 'manual'),
      chatId: formData.get('availability') === 'current_chat' && window.state ? window.state.activeChatId : null,
      enabled: form.elements.enabled.checked,
      status: form.elements.enabled.checked ? (existing && existing.status !== 'disabled' ? existing.status : 'offline') : 'disabled',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    if (['api_key', 'custom'].includes(connection.authType)) {
      const headerName = connection.headerName.toLowerCase();
      if (!headerName || ['host', 'origin', 'cookie', 'content-length', 'mcp-session-id', 'mcp-protocol-version'].includes(headerName)) {
        await showCustomAlert('认证配置有误', '请填写一个允许由浏览器发送的认证 Header 名称。');
        return;
      }
    }
    const newSecret = String(formData.get('secret') || '');
    if (newSecret) connection.secret = newSecret;
    if (connection.authType === 'none') {
      delete connection.secret;
      delete connection.headerName;
    }
    await persistConnection(connection);
    await logActivity({
      connection,
      status: 'success',
      title: existing ? '连接配置已更新' : '连接已添加',
      summary: typeInfo(type).label
    });
    closeSheet();
    await loadData();
    render();
    showToast(existing ? '连接配置已保存' : '连接已添加', 'success');
  }

  function getConnection(id) {
    return state.connections.find(item => item.id === id);
  }

  function connectionDetails(connection) {
    const info = typeInfo(connection.type);
    const capabilityCount = ['tools', 'resources', 'prompts'].reduce((total, kind) => {
      return total + ((connection.capabilities && connection.capabilities[kind] || []).length);
    }, 0);
    const endpoint = connection.type === 'ios_shortcuts'
      ? `shortcuts://run-shortcut?name=${encodeURIComponent(connection.shortcutName || '')}`
      : connection.type === 'bluetooth' && connection.bluetoothMode === 'direct'
        ? (connection.deviceName || '等待蓝牙配对')
        : (connection.endpoint || '未设置');
    const error = connection.lastError ? `<div class="mcp-inline-notice" style="margin-top:12px;">${escapeHtml(connection.lastError)}</div>` : '';
    showSheet(
      connection.name,
      `<dl class="mcp-detail-grid">
        <dt>类型</dt><dd>${escapeHtml(info.label)}</dd>
        <dt>状态</dt><dd><span class="mcp-status-tag ${statusClass(connection)}">${statusLabel(connection)}</span></dd>
        <dt>地址/设备</dt><dd>${escapeHtml(endpoint)}</dd>
        <dt>传输</dt><dd>${escapeHtml(connection.transport || connection.bluetoothMode || '自动')}</dd>
        <dt>能力</dt><dd>${capabilityCount ? `${capabilityCount} 项` : '尚未发现'}</dd>
        <dt>协议</dt><dd>${escapeHtml(connection.protocolVersion || '尚未协商')}</dd>
        <dt>最近检查</dt><dd>${formatTime(connection.lastTestedAt, true)}</dd>
        <dt>卡片范围</dt><dd>${connection.availability === 'all_chats' ? '所有聊天' : connection.availability === 'current_chat' ? '指定聊天' : '仅 MCP 中心'}</dd>
      </dl>${error}`,
      `<button type="button" class="mcp-secondary-btn" data-mcp-action="edit" data-id="${escapeHtml(connection.id)}">编辑</button>
       ${connection.type === 'ios_shortcuts' ? `<button type="button" class="mcp-primary-btn" data-mcp-action="launch-shortcut" data-id="${escapeHtml(connection.id)}">运行</button>` : `<button type="button" class="mcp-primary-btn" data-mcp-action="test" data-id="${escapeHtml(connection.id)}">${connection.type === 'bluetooth' ? '配对/测试' : '测试连接'}</button>`}
       <button type="button" class="mcp-danger-btn" data-mcp-action="delete" data-id="${escapeHtml(connection.id)}">删除</button>`
    );
  }

  function buildRequestHeaders(connection, initialized) {
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(connection.customHeaders || {})
    };
    if (connection.authType === 'bearer' && connection.secret) {
      headers.Authorization = `Bearer ${connection.secret}`;
    } else if (['api_key', 'custom'].includes(connection.authType) && connection.headerName && connection.secret) {
      headers[connection.headerName] = connection.secret;
    }
    if (initialized && connection.protocolVersion) headers['MCP-Protocol-Version'] = connection.protocolVersion;
    if (initialized && connection.sessionId) headers['Mcp-Session-Id'] = connection.sessionId;
    if (connection.pairingCode) headers['X-MCP-Pairing-Code'] = connection.pairingCode;
    return headers;
  }

  function parseSsePayload(text, requestId) {
    const messages = [];
    text.split(/\r?\n\r?\n/).forEach(block => {
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) return;
      try { messages.push(JSON.parse(data)); } catch (error) { /* Ignore non-JSON SSE events. */ }
    });
    return messages.find(item => item.id === requestId) || messages.find(item => item.result || item.error) || null;
  }

  async function rpc(connection, method, params, options) {
    const requestId = options && options.notification ? undefined : uid('rpc');
    const body = {
      jsonrpc: '2.0',
      ...(requestId ? { id: requestId } : {}),
      method,
      ...(params !== undefined ? { params } : {})
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), state.settings.timeoutMs || 20000);
    let response;
    try {
      response = await fetch(connection.endpoint, {
        method: 'POST',
        headers: buildRequestHeaders(connection, method !== 'initialize'),
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store'
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`连接超时（${Math.round((state.settings.timeoutMs || 20000) / 1000)} 秒）`);
      if (/Failed to fetch|NetworkError|Load failed/i.test(error.message)) {
        throw new Error('浏览器无法访问该端点。请检查 HTTPS、CORS、局域网权限和桥接器运行状态。');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (method === 'initialize') {
      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) connection.sessionId = sessionId;
    }
    if (!response.ok) {
      let detail = '';
      try { detail = truncate(await response.text(), 240); } catch (error) { /* No response body. */ }
      throw new Error(`服务器返回 ${response.status}${detail ? `：${detail}` : ''}`);
    }
    if (options && options.notification) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    const contentType = response.headers.get('content-type') || '';
    let payload;
    if (contentType.includes('text/event-stream')) {
      payload = parseSsePayload(text, requestId);
    } else {
      try { payload = JSON.parse(text); } catch (error) { throw new Error('服务器返回了无法解析的 MCP 响应。'); }
    }
    if (!payload) throw new Error('服务器没有返回对应的 MCP 响应。');
    if (payload.error) throw new Error(payload.error.message || `MCP 错误 ${payload.error.code || ''}`.trim());
    return payload.result;
  }

  async function initializeConnection(connection) {
    if (!connection.endpoint) throw new Error('请先填写 MCP 端点。');
    const result = await rpc(connection, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'EPhone MCP', version: '0.0.36' }
    });
    if (!result || !result.protocolVersion) throw new Error('服务器没有返回有效的初始化结果。');
    connection.protocolVersion = result.protocolVersion;
    connection.serverInfo = result.serverInfo || {};
    connection.serverCapabilities = result.capabilities || {};
    state.sessions.set(connection.id, {
      sessionId: connection.sessionId || '',
      protocolVersion: connection.protocolVersion
    });
    await rpc(connection, 'notifications/initialized', undefined, { notification: true });
    return result;
  }

  async function discoverCapabilities(connection) {
    const capabilities = { tools: [], resources: [], prompts: [] };
    const mapping = [
      ['tools', 'tools/list'],
      ['resources', 'resources/list'],
      ['prompts', 'prompts/list']
    ];
    for (const [key, method] of mapping) {
      if (connection.serverCapabilities && !connection.serverCapabilities[key]) continue;
      try {
        const result = await rpc(connection, method, {});
        capabilities[key] = result && Array.isArray(result[key]) ? result[key] : [];
      } catch (error) {
        console.warn(`[MCP] ${method} 失败:`, error);
      }
    }
    connection.capabilities = capabilities;
    return capabilities;
  }

  async function pairBluetooth(connection) {
    if (connection.bluetoothMode === 'bridge') {
      await initializeConnection(connection);
      await discoverCapabilities(connection);
      connection.status = 'online';
      return '蓝牙桥接器连接成功';
    }
    if (!navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== 'function') {
      throw new Error('当前浏览器不支持直接蓝牙连接。苹果 Safari/PWA 请使用 iOS 桥接器，或改用电脑节点。');
    }
    const serviceUuid = String(connection.serviceUuid || '').trim();
    const requestOptions = serviceUuid
      ? { filters: [{ services: [serviceUuid] }], optionalServices: [serviceUuid] }
      : { acceptAllDevices: true };
    const device = await navigator.bluetooth.requestDevice(requestOptions);
    connection.deviceName = device.name || '未命名 BLE 设备';
    connection.deviceId = device.id;
    connection.status = 'paired';
    return `已配对 ${connection.deviceName}`;
  }

  async function testConnection(id) {
    const connection = getConnection(id);
    if (!connection || state.busy.has(id)) return;
    if (!connection.enabled) {
      await showCustomAlert('连接已停用', '请先在编辑页面启用此连接。');
      return;
    }
    state.busy.add(id);
    connection.status = 'testing';
    connection.lastError = '';
    render();
    if (els.sheetBackdrop.classList.contains('visible')) connectionDetails(connection);
    const start = performance.now();
    let summary;
    try {
      if (connection.type === 'ios_shortcuts') {
        if (!connection.shortcutName) throw new Error('请先填写快捷指令名称。');
        connection.status = 'ready';
        summary = '快捷指令通道已就绪';
      } else if (connection.type === 'bluetooth') {
        summary = await pairBluetooth(connection);
      } else {
        await initializeConnection(connection);
        const capabilities = await discoverCapabilities(connection);
        const count = capabilities.tools.length + capabilities.resources.length + capabilities.prompts.length;
        connection.status = 'online';
        connection.latencyMs = Math.round(performance.now() - start);
        summary = `握手成功，发现 ${count} 项能力，${connection.latencyMs}ms`;
      }
      connection.lastTestedAt = Date.now();
      connection.updatedAt = Date.now();
      await persistConnection(connection);
      await logActivity({ connection, status: 'success', title: '连接测试成功', summary });
      showToast(summary, 'success');
    } catch (error) {
      connection.status = 'error';
      connection.lastError = error.message || String(error);
      connection.lastTestedAt = Date.now();
      connection.updatedAt = Date.now();
      await persistConnection(connection);
      await logActivity({ connection, status: 'failed', title: '连接测试失败', summary: connection.lastError });
      await showCustomAlert('连接失败', connection.lastError);
    } finally {
      state.busy.delete(id);
      await loadData();
      render();
      if (els.sheetBackdrop.classList.contains('visible')) {
        const refreshed = getConnection(id);
        if (refreshed) connectionDetails(refreshed);
      }
    }
  }

  async function logActivity(input) {
    const activity = {
      id: input.id || uid('activity'),
      connectionId: input.connection ? input.connection.id : input.connectionId,
      connectionName: input.connection ? input.connection.name : input.connectionName,
      status: input.status || 'success',
      title: input.title || 'MCP 活动',
      summary: input.summary || '',
      request: input.request,
      result: input.result,
      error: input.error,
      toolName: input.toolName,
      chatId: input.chatId || null,
      createdAt: input.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    await db.mcpActivities.put(activity);
    const index = state.activities.findIndex(item => item.id === activity.id);
    if (index >= 0) state.activities[index] = activity;
    else state.activities.unshift(activity);
    return activity;
  }

  function findCapability(connection, kind, name) {
    const list = connection && connection.capabilities && connection.capabilities[kind];
    return Array.isArray(list) ? list.find(item => item.name === name || item.uri === name) : null;
  }

  function defaultArguments(schema) {
    const output = {};
    if (!schema || !schema.properties) return output;
    Object.entries(schema.properties).forEach(([key, value]) => {
      if (value.default !== undefined) output[key] = value.default;
      else if ((schema.required || []).includes(key)) {
        if (value.type === 'number' || value.type === 'integer') output[key] = 0;
        else if (value.type === 'boolean') output[key] = false;
        else if (value.type === 'array') output[key] = [];
        else if (value.type === 'object') output[key] = {};
        else output[key] = '';
      }
    });
    return output;
  }

  function canSyncToActiveChat(connection) {
    const activeChatId = window.state && window.state.activeChatId;
    if (!activeChatId || !connection) return false;
    if (connection.availability === 'all_chats') return true;
    return connection.availability === 'current_chat' && connection.chatId === activeChatId;
  }

  function showInvokeForm(connection, tool) {
    const chat = window.state && window.state.activeChatId ? window.state.chats[window.state.activeChatId] : null;
    const args = defaultArguments(tool.inputSchema);
    showSheet(
      tool.title || tool.name,
      `<div class="mcp-inline-notice">工具来自外部服务器。调用前请检查参数，工具描述和返回内容都不应视为可信系统指令。</div>
       <div class="mcp-form" style="margin-top:12px;">
        <div class="mcp-field"><label>服务器</label><input value="${escapeHtml(connection.name)}" disabled></div>
        <div class="mcp-field"><label for="mcp-tool-arguments">调用参数（JSON）</label><textarea id="mcp-tool-arguments" spellcheck="false">${escapeHtml(JSON.stringify(args, null, 2))}</textarea></div>
        ${chat && state.settings.showChatCards && canSyncToActiveChat(connection) ? `<label class="mcp-setting-row" style="padding:8px 0;border:0;"><div class="mcp-setting-main"><div class="mcp-setting-name">同步到对话</div><div class="mcp-setting-desc">在“${escapeHtml(chat.name || '当前聊天')}”中显示 MCP 活动卡片</div></div><span class="mcp-toggle"><input id="mcp-sync-chat" type="checkbox" checked><span></span></span></label>` : ''}
       </div>`,
      `<button type="button" class="mcp-secondary-btn" data-mcp-action="close-sheet">取消</button>
       <button type="button" class="mcp-primary-btn" data-mcp-action="confirm-invoke" data-id="${escapeHtml(connection.id)}" data-name="${escapeHtml(tool.name)}">确认调用</button>`
    );
  }

  function resultSummary(result) {
    if (!result) return '工具已完成，没有返回内容';
    if (result.isError) return '工具返回错误结果';
    if (Array.isArray(result.content)) {
      const text = result.content
        .filter(item => item && item.type === 'text')
        .map(item => item.text)
        .join(' ');
      if (text) return truncate(text, 180);
      const types = Array.from(new Set(result.content.map(item => item && item.type).filter(Boolean)));
      if (types.length) return `返回 ${result.content.length} 项内容：${types.join('、')}`;
    }
    if (Array.isArray(result.contents)) {
      const text = result.contents.map(item => item && item.text).filter(Boolean).join(' ');
      if (text) return truncate(text, 180);
      return `读取到 ${result.contents.length} 项资源内容`;
    }
    if (Array.isArray(result.messages)) {
      const text = result.messages.map(message => {
        const content = message && message.content;
        return content && typeof content.text === 'string' ? content.text : '';
      }).filter(Boolean).join(' ');
      if (text) return truncate(text, 180);
      return `获取到 ${result.messages.length} 条提示消息`;
    }
    if (result.structuredContent) return truncate(JSON.stringify(result.structuredContent), 180);
    return truncate(JSON.stringify(result), 180) || '工具已完成';
  }

  async function appendActivityToChat(activity, connection, status, result) {
    if (!state.settings.showChatCards || !activity.chatId || !window.state) return;
    const chat = window.state.chats[activity.chatId];
    if (!chat) return;
    const existingMessage = chat.history.find(message => message.type === 'mcp_activity' && message.mcpActivity && message.mcpActivity.id === activity.id);
    const detail = state.settings.includeResultDetails && result ? JSON.stringify(result, null, 2) : '';
    const cardData = {
      id: activity.id,
      connectionId: connection.id,
      connectionName: connection.name,
      toolName: activity.toolName,
      title: activity.title,
      summary: activity.summary,
      status,
      detail,
      updatedAt: Date.now()
    };
    if (existingMessage) {
      existingMessage.content = activity.summary;
      existingMessage.mcpActivity = cardData;
      await db.chats.put(chat);
      updateMessageCardDom(cardData);
      return;
    }
    const message = {
      role: 'assistant',
      type: 'mcp_activity',
      content: activity.summary || activity.title,
      mcpActivity: cardData,
      timestamp: Date.now()
    };
    chat.history.push(message);
    await db.chats.put(chat);
    if (window.state.activeChatId === chat.id && typeof window.appendMessage === 'function') {
      await window.appendMessage(message, chat);
    }
  }

  async function invokeTool(connectionId, toolName, args, syncChat) {
    const connection = getConnection(connectionId);
    if (!connection) return;
    const chatId = syncChat && canSyncToActiveChat(connection) ? window.state.activeChatId : null;
    const activity = await logActivity({
      connection,
      status: 'running',
      title: toolName,
      summary: '正在调用外部工具',
      request: args,
      toolName,
      chatId
    });
    closeSheet();
    await appendActivityToChat(activity, connection, 'running');
    state.activeTab = 'activity';
    render();
    try {
      if (connection.status !== 'online' || !connection.protocolVersion || !connection.sessionId) {
        await initializeConnection(connection);
        await discoverCapabilities(connection);
      }
      const result = await rpc(connection, 'tools/call', { name: toolName, arguments: args });
      activity.status = result && result.isError ? 'failed' : 'success';
      activity.summary = resultSummary(result);
      activity.result = result;
      activity.error = result && result.isError ? activity.summary : undefined;
      await logActivity(activity);
      await appendActivityToChat(activity, connection, activity.status, result);
      await persistConnection({ ...connection, status: 'online', lastError: '', updatedAt: Date.now() });
      showToast(activity.status === 'success' ? 'MCP 工具调用完成' : 'MCP 工具返回错误', activity.status === 'success' ? 'success' : 'error');
    } catch (error) {
      activity.status = 'failed';
      activity.summary = error.message || String(error);
      activity.error = activity.summary;
      await logActivity(activity);
      await appendActivityToChat(activity, connection, 'failed');
      await persistConnection({ ...connection, status: 'error', lastError: activity.summary, updatedAt: Date.now() });
      await showCustomAlert('调用失败', activity.summary);
    } finally {
      await loadData();
      render();
    }
  }

  function showCapabilityUseForm(connection, kind, item) {
    const chat = window.state && window.state.activeChatId ? window.state.chats[window.state.activeChatId] : null;
    const isResource = kind === 'resources';
    showSheet(
      item.title || item.name || item.uri || capabilityLabel(kind),
      `<div class="mcp-inline-notice info">${isResource ? '将从外部 MCP 读取此资源。内容不会自动发送给其他服务器。' : '将从外部 MCP 获取提示模板。返回内容会作为外部内容展示。'}</div>
       <div class="mcp-form" style="margin-top:12px;">
        <div class="mcp-field"><label>服务器</label><input value="${escapeHtml(connection.name)}" disabled></div>
        <div class="mcp-field"><label>${isResource ? '资源地址' : '提示名称'}</label><input value="${escapeHtml(isResource ? item.uri : item.name)}" disabled></div>
        ${isResource ? '' : '<div class="mcp-field"><label for="mcp-capability-arguments">提示参数（JSON）</label><textarea id="mcp-capability-arguments" spellcheck="false">{}</textarea></div>'}
        ${chat && state.settings.showChatCards && canSyncToActiveChat(connection) ? `<label class="mcp-setting-row" style="padding:8px 0;border:0;"><div class="mcp-setting-main"><div class="mcp-setting-name">同步到对话</div><div class="mcp-setting-desc">在“${escapeHtml(chat.name || '当前聊天')}”中显示 MCP 活动卡片</div></div><span class="mcp-toggle"><input id="mcp-sync-chat" type="checkbox" checked><span></span></span></label>` : ''}
       </div>`,
      `<button type="button" class="mcp-secondary-btn" data-mcp-action="capability-details" data-id="${escapeHtml(connection.id)}" data-kind="${escapeHtml(kind)}" data-name="${escapeHtml(item.name || item.uri || '')}">详情</button>
       <button type="button" class="mcp-primary-btn" data-mcp-action="confirm-consume" data-id="${escapeHtml(connection.id)}" data-kind="${escapeHtml(kind)}" data-name="${escapeHtml(item.name || item.uri || '')}">${isResource ? '确认读取' : '确认使用'}</button>`
    );
  }

  async function consumeCapability(connectionId, kind, name, args, syncChat) {
    const connection = getConnection(connectionId);
    const item = findCapability(connection, kind, name);
    if (!connection || !item) return;
    const isResource = kind === 'resources';
    const title = item.title || item.name || item.uri;
    const chatId = syncChat && canSyncToActiveChat(connection) ? window.state.activeChatId : null;
    const activity = await logActivity({
      connection,
      status: 'running',
      title,
      summary: isResource ? '正在读取外部资源' : '正在获取外部提示模板',
      request: isResource ? { uri: item.uri } : args,
      toolName: isResource ? 'resources/read' : 'prompts/get',
      chatId
    });
    closeSheet();
    await appendActivityToChat(activity, connection, 'running');
    state.activeTab = 'activity';
    render();
    try {
      if (connection.status !== 'online' || !connection.protocolVersion || !connection.sessionId) {
        await initializeConnection(connection);
        await discoverCapabilities(connection);
      }
      const result = isResource
        ? await rpc(connection, 'resources/read', { uri: item.uri })
        : await rpc(connection, 'prompts/get', { name: item.name, arguments: args });
      activity.status = 'success';
      activity.summary = resultSummary(result);
      activity.result = result;
      await logActivity(activity);
      await appendActivityToChat(activity, connection, 'success', result);
      await persistConnection({ ...connection, status: 'online', lastError: '', updatedAt: Date.now() });
      showToast(isResource ? 'MCP 资源读取完成' : 'MCP 提示词已获取', 'success');
    } catch (error) {
      activity.status = 'failed';
      activity.summary = error.message || String(error);
      activity.error = activity.summary;
      await logActivity(activity);
      await appendActivityToChat(activity, connection, 'failed');
      await persistConnection({ ...connection, status: 'error', lastError: activity.summary, updatedAt: Date.now() });
      await showCustomAlert(isResource ? '读取失败' : '获取失败', activity.summary);
    } finally {
      await loadData();
      render();
    }
  }

  function renderMessageCard(message) {
    const data = message.mcpActivity || {};
    const status = data.status || 'success';
    const detail = data.detail || '';
    return `
      <div class="mcp-message-card ${escapeHtml(status)}" data-mcp-activity-id="${escapeHtml(data.id || '')}">
        <div class="mcp-message-head">
          <span class="mcp-message-source">${escapeHtml(data.connectionName || 'MCP')}</span>
          <span class="mcp-status-tag ${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>
        </div>
        <div class="mcp-message-body">
          <div class="mcp-message-title">${escapeHtml(data.title || data.toolName || 'MCP 活动')}</div>
          <div class="mcp-message-summary">${escapeHtml(data.summary || message.content || '')}</div>
        </div>
        ${detail ? `<button type="button" class="mcp-message-toggle" data-mcp-card-toggle>查看执行详情</button><div class="mcp-message-detail">${escapeHtml(detail)}</div>` : ''}
      </div>`;
  }

  function updateMessageCardDom(cardData) {
    document.querySelectorAll('.mcp-message-card[data-mcp-activity-id]').forEach(card => {
      if (card.dataset.mcpActivityId !== cardData.id) return;
      card.className = `mcp-message-card ${cardData.status}`;
      const tag = card.querySelector('.mcp-status-tag');
      const summary = card.querySelector('.mcp-message-summary');
      if (tag) {
        tag.className = `mcp-status-tag ${cardData.status}`;
        tag.textContent = STATUS_LABELS[cardData.status] || cardData.status;
      }
      if (summary) summary.textContent = cardData.summary || '';
    });
  }

  function showCapabilityDetails(connection, kind, item) {
    showSheet(
      item.title || item.name || item.uri || '能力详情',
      `<dl class="mcp-detail-grid">
        <dt>服务器</dt><dd>${escapeHtml(connection.name)}</dd>
        <dt>类型</dt><dd>${capabilityLabel(kind)}</dd>
        <dt>名称</dt><dd>${escapeHtml(item.name || item.uri || '未命名')}</dd>
        <dt>描述</dt><dd>${escapeHtml(item.description || '无')}</dd>
      </dl>
      <pre class="mcp-json-block">${escapeHtml(JSON.stringify(item, null, 2))}</pre>`,
      `<button type="button" class="mcp-primary-btn" data-mcp-action="close-sheet">完成</button>`
    );
  }

  function showActivityDetails(activity) {
    showSheet(
      activity.title || 'MCP 活动',
      `<dl class="mcp-detail-grid">
        <dt>连接</dt><dd>${escapeHtml(activity.connectionName || '未知')}</dd>
        <dt>状态</dt><dd><span class="mcp-status-tag ${escapeHtml(activity.status)}">${escapeHtml(STATUS_LABELS[activity.status] || activity.status)}</span></dd>
        <dt>时间</dt><dd>${formatTime(activity.createdAt, true)}</dd>
        <dt>摘要</dt><dd>${escapeHtml(activity.summary || '无')}</dd>
      </dl>
      ${activity.request ? `<div class="mcp-section-title">请求参数</div><pre class="mcp-json-block">${escapeHtml(JSON.stringify(activity.request, null, 2))}</pre>` : ''}
      ${activity.result ? `<div class="mcp-section-title">返回结果</div><pre class="mcp-json-block">${escapeHtml(JSON.stringify(activity.result, null, 2))}</pre>` : ''}
      ${activity.error ? `<div class="mcp-inline-notice" style="margin-top:12px;">${escapeHtml(activity.error)}</div>` : ''}`,
      `<button type="button" class="mcp-primary-btn" data-mcp-action="close-sheet">完成</button>`
    );
  }

  function sanitizedConnection(connection) {
    const copy = JSON.parse(JSON.stringify(connection));
    delete copy.secret;
    delete copy.sessionId;
    delete copy.pairingCode;
    delete copy.deviceId;
    copy.enabled = false;
    copy.status = 'disabled';
    return copy;
  }

  function exportConnections() {
    const payload = {
      kind: 'ephone-mcp-connections',
      format: 1,
      exportedAt: new Date().toISOString(),
      connections: state.connections.map(sanitizedConnection)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `EPhone-MCP-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast('连接配置已导出，凭证未包含', 'success');
  }

  async function importConnections(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const list = Array.isArray(parsed) ? parsed : parsed.connections;
      if (!Array.isArray(list)) throw new Error('文件中没有连接配置列表。');
      const validTypes = new Set(Object.keys(CONNECTION_TYPES));
      const imported = list.map(item => {
        if (!item || !validTypes.has(item.type)) throw new Error(`存在不支持的连接类型：${item && item.type}`);
        const copy = sanitizedConnection(item);
        copy.id = uid('mcp');
        copy.name = String(copy.name || typeInfo(copy.type).label).slice(0, 60);
        copy.createdAt = Date.now();
        copy.updatedAt = Date.now();
        return copy;
      });
      await db.mcpConnections.bulkPut(imported);
      await loadData();
      render();
      showToast(`已导入 ${imported.length} 个连接，需重新授权后启用`, 'success');
    } catch (error) {
      await showCustomAlert('导入失败', error.message || String(error));
    } finally {
      els.importInput.value = '';
    }
  }

  async function deleteConnection(id) {
    const connection = getConnection(id);
    if (!connection) return;
    const confirmed = await showCustomConfirm('删除 MCP 连接', `将删除“${escapeHtml(connection.name)}”的配置和本地凭证。已有聊天活动卡片会保留。`, {
      confirmText: '删除',
      confirmButtonClass: 'btn-danger'
    });
    if (!confirmed) return;
    await db.transaction('rw', db.mcpConnections, db.mcpSecrets, async () => {
      await db.mcpConnections.delete(id);
      await db.mcpSecrets.delete(id);
    });
    await db.mcpActivities.where('connectionId').equals(id).delete();
    closeSheet();
    await loadData();
    render();
    showToast('连接已删除', 'success');
  }

  async function launchShortcut(connection) {
    if (!connection || !connection.shortcutName) return;
    const confirmed = await showCustomConfirm('打开快捷指令', `即将离开当前页面并运行“${escapeHtml(connection.shortcutName)}”。快捷指令的权限和执行结果由 iOS 管理。`, { confirmText: '打开' });
    if (!confirmed) return;
    const activity = await logActivity({ connection, status: 'success', title: '启动快捷指令', summary: connection.shortcutName });
    await loadData();
    window.location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(connection.shortcutName)}&input=text&text=${encodeURIComponent(JSON.stringify({ source: 'EPhone MCP', activityId: activity.id }))}`;
  }

  async function reconnectEligibleConnections() {
    const candidates = state.connections.filter(connection => connection.enabled && connection.endpoint && connection.status === 'online');
    for (const connection of candidates) {
      if (state.busy.has(connection.id)) continue;
      state.busy.add(connection.id);
      try {
        await initializeConnection(connection);
        await discoverCapabilities(connection);
        connection.status = 'online';
        connection.lastError = '';
      } catch (error) {
        connection.status = 'error';
        connection.lastError = error.message || String(error);
      } finally {
        connection.updatedAt = Date.now();
        await persistConnection(connection);
        state.busy.delete(connection.id);
      }
    }
  }

  async function handleContentClick(event) {
    const target = event.target.closest('[data-mcp-action]');
    if (!target) return;
    const action = target.dataset.mcpAction;
    if (action === 'add') showTypeChooser();
    if (action === 'connections-tab') { state.activeTab = 'connections'; render(); }
    if (action === 'import') els.importInput.click();
    if (action === 'export') exportConnections();
    if (action === 'details') connectionDetails(getConnection(target.dataset.id));
    if (action === 'test') await testConnection(target.dataset.id);
    if (action === 'activity-details') {
      const activity = state.activities.find(item => item.id === target.dataset.id);
      if (activity) showActivityDetails(activity);
    }
    if (action === 'capability-details') {
      const connection = getConnection(target.dataset.id);
      const item = findCapability(connection, target.dataset.kind, target.dataset.name);
      if (connection && item) showCapabilityDetails(connection, target.dataset.kind, item);
    }
    if (action === 'invoke') {
      const connection = getConnection(target.dataset.id);
      const tool = findCapability(connection, 'tools', target.dataset.name);
      if (connection && tool) showInvokeForm(connection, tool);
    }
    if (action === 'consume-capability') {
      const connection = getConnection(target.dataset.id);
      const item = findCapability(connection, target.dataset.kind, target.dataset.name);
      if (connection && item) showCapabilityUseForm(connection, target.dataset.kind, item);
    }
    if (action === 'clear-activity') {
      const confirmed = await showCustomConfirm('清除活动记录', '只清除 MCP 中心的活动日志，不会删除聊天中的 MCP 卡片。', { confirmText: '清除' });
      if (confirmed) {
        await db.mcpActivities.clear();
        await loadData();
        render();
      }
    }
  }

  async function handleSheetClick(event) {
    const typeButton = event.target.closest('[data-mcp-type]');
    if (typeButton) {
      connectionForm(typeButton.dataset.mcpType);
      return;
    }
    const target = event.target.closest('[data-mcp-action]');
    if (!target) return;
    const action = target.dataset.mcpAction;
    if (action === 'close-sheet') closeSheet();
    if (action === 'save-connection') await saveConnectionFromForm();
    if (action === 'edit') {
      const connection = getConnection(target.dataset.id);
      if (connection) connectionForm(connection.type, connection);
    }
    if (action === 'test') await testConnection(target.dataset.id);
    if (action === 'delete') await deleteConnection(target.dataset.id);
    if (action === 'launch-shortcut') await launchShortcut(getConnection(target.dataset.id));
    if (action === 'confirm-invoke') {
      let args;
      try {
        args = JSON.parse(document.getElementById('mcp-tool-arguments').value || '{}');
      } catch (error) {
        await showCustomAlert('参数有误', '调用参数必须是有效的 JSON 对象。');
        return;
      }
      if (!args || Array.isArray(args) || typeof args !== 'object') {
        await showCustomAlert('参数有误', '工具参数必须是 JSON 对象。');
        return;
      }
      const syncChat = !!document.getElementById('mcp-sync-chat')?.checked;
      await invokeTool(target.dataset.id, target.dataset.name, args, syncChat);
    }
    if (action === 'capability-details') {
      const connection = getConnection(target.dataset.id);
      const item = findCapability(connection, target.dataset.kind, target.dataset.name);
      if (connection && item) showCapabilityDetails(connection, target.dataset.kind, item);
    }
    if (action === 'confirm-consume') {
      let args = {};
      const input = document.getElementById('mcp-capability-arguments');
      if (input) {
        try { args = JSON.parse(input.value || '{}'); }
        catch (error) {
          await showCustomAlert('参数有误', '提示参数必须是有效的 JSON 对象。');
          return;
        }
      }
      if (!args || Array.isArray(args) || typeof args !== 'object') {
        await showCustomAlert('参数有误', '提示参数必须是 JSON 对象。');
        return;
      }
      const syncChat = !!document.getElementById('mcp-sync-chat')?.checked;
      await consumeCapability(target.dataset.id, target.dataset.kind, target.dataset.name, args, syncChat);
    }
  }

  async function handleSettingChange(event) {
    const target = event.target.closest('[data-mcp-setting]');
    if (!target) return;
    const name = target.dataset.mcpSetting;
    state.settings[name] = target.type === 'checkbox' ? target.checked : Number(target.value);
    await db.mcpSettings.put(state.settings);
    showToast('MCP 设置已保存', 'success', 1600);
  }

  function bindEvents() {
    document.getElementById('mcp-add-connection-btn')?.addEventListener('click', showTypeChooser);
    document.querySelectorAll('.mcp-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        state.activeTab = tab.dataset.mcpTab;
        render();
      });
    });
    els.content.addEventListener('click', handleContentClick);
    els.content.addEventListener('change', handleSettingChange);
    els.sheetBody.addEventListener('click', handleSheetClick);
    els.sheetActions.addEventListener('click', handleSheetClick);
    els.sheetClose.addEventListener('click', closeSheet);
    els.sheetBackdrop.addEventListener('click', event => {
      if (event.target === els.sheetBackdrop) closeSheet();
    });
    els.importInput.addEventListener('change', () => importConnections(els.importInput.files[0]));
    document.addEventListener('click', event => {
      const toggle = event.target.closest('[data-mcp-card-toggle]');
      if (!toggle) return;
      const card = toggle.closest('.mcp-message-card');
      if (!card) return;
      const expanded = card.classList.toggle('expanded');
      toggle.textContent = expanded ? '收起执行详情' : '查看执行详情';
    });
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !state.settings.autoReconnect || !state.initialized) return;
      const active = document.getElementById('mcp-screen')?.classList.contains('active');
      if (active) {
        await reconnectEligibleConnections();
        await loadData();
        render();
      }
    });
  }

  async function init() {
    els = {
      content: document.getElementById('mcp-content'),
      summaryTitle: document.getElementById('mcp-summary-title'),
      summaryDetail: document.getElementById('mcp-summary-detail'),
      summaryDot: document.getElementById('mcp-summary-dot'),
      sheetBackdrop: document.getElementById('mcp-sheet-backdrop'),
      sheetTitle: document.getElementById('mcp-sheet-title'),
      sheetBody: document.getElementById('mcp-sheet-body'),
      sheetActions: document.getElementById('mcp-sheet-actions'),
      sheetClose: document.getElementById('mcp-sheet-close'),
      importInput: document.getElementById('mcp-import-input')
    };
    if (!els.content) return;
    bindEvents();
    await loadData();
    state.initialized = true;
    render();
  }

  window.openMcpScreen = openMcpScreen;
  window.mcpManager = {
    open: openMcpScreen,
    renderMessageCard,
    callTool: invokeTool,
    getConnections: () => state.connections.map(item => ({ ...item, secret: undefined, sessionId: undefined })),
    getEnabledTools: () => collectCapabilities().filter(item => item.kind === 'tools')
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
