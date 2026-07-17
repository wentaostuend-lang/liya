// ============================================================
// status-bar-manager.js — 状态栏预设库管理 App
//
// 依赖 status-bar.js 里暴露的 window.__statusBarDB（同一个 Dexie 库）。
// 实体App（第4页图标），不是浮层。
//
// 字段名对齐社区通用的状态栏预设JSON格式：
//   { id, name, promptSuffix, regexPattern, replacePattern }
// regexPattern 存的是 "/pattern/flags" 这种JS正则字面量字符串。
// 导入/导出都走这个格式，兼容外面分享的预设文件。
// ============================================================

(function () {
  function db_() { return window.__statusBarDB; }
  function content() { return document.getElementById('status-bar-app-content'); }

  let editingPreset = null;

  function injectStyle() {
    if (document.getElementById('sbm-style')) return;
    const style = document.createElement('style');
    style.id = 'sbm-style';
    style.textContent = `
      #status-bar-app-content { display:flex; flex-direction:column; width:100%; height:100%; background:#000; color:#fff; font-family:inherit; }
      .sbm-header { display:flex; align-items:center; gap:10px; padding:14px 16px; border-bottom:1px solid #2c2c2e; flex-shrink:0; }
      .sbm-header .back { font-size:22px; cursor:pointer; padding:4px 8px; }
      .sbm-header .title { font-size:16px; font-weight:700; flex:1; }
      .sbm-header .icon-btn { font-size:19px; cursor:pointer; padding:4px 8px; color:#8ab4ff; }
      .sbm-body { flex:1; overflow-y:auto; padding:14px 16px; }
      .sbm-card { display:flex; align-items:center; justify-content:space-between; background:#1c1c1e; border-radius:14px; padding:14px; margin-bottom:10px; cursor:pointer; }
      .sbm-card .name { font-size:14px; font-weight:600; }
      .sbm-add-btn { width:100%; padding:14px; border-radius:14px; border:1px dashed #48484a; background:transparent; color:#8e8e93; font-size:14px; margin-top:6px; }
      .sbm-row { margin-bottom:14px; }
      .sbm-row label { display:block; font-size:13px; color:#8e8e93; margin-bottom:6px; }
      .sbm-row input[type="text"], .sbm-row textarea {
        width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:none; background:#1c1c1e; color:#fff; font-size:13.5px; font-family:'Courier New', monospace;
      }
      .sbm-row textarea { min-height:80px; resize:vertical; }
      .sbm-hint { font-size:11px; color:#666; margin-top:4px; }
      .sbm-actions { display:flex; gap:8px; margin-top:8px; }
      .sbm-actions button { flex:1; border:none; border-radius:10px; padding:11px; font-size:14px; }
      .sbm-btn-primary { background:#fff; color:#000; font-weight:700; }
      .sbm-btn-secondary { background:#1c1c1e; color:#fff; }
      .sbm-btn-danger { background:#3a1d1d; color:#ff6b6b; }
      #sbm-test-result { background:#111; border-radius:10px; padding:12px; margin-top:6px; min-height:40px; font-size:13px; }
    `;
    document.head.appendChild(style);
  }

  // ---------------- 正则字面量解析/构建（跟status-bar.js保持一致的逻辑） ----------------
  function parseRegexLiteral(source) {
    if (!source) return null;
    const trimmed = source.trim();
    if (trimmed.startsWith('/')) {
      const lastSlash = trimmed.lastIndexOf('/');
      if (lastSlash > 0) {
        const pattern = trimmed.slice(1, lastSlash);
        const flags = trimmed.slice(lastSlash + 1).replace(/[^gimsuy]/g, '');
        return { pattern, flags: flags || '' };
      }
    }
    return { pattern: trimmed, flags: '' };
  }

  async function renderList() {
    const presets = await db_().presets.toArray();
    content().innerHTML = `
      <div class="sbm-header">
        <span class="back" id="sbm-close">✕</span>
        <span class="title">状态栏预设库</span>
        <span class="icon-btn" id="sbm-import-btn">⬆ 导入</span>
      </div>
      <input type="file" id="sbm-import-file" accept=".json" style="display:none;">
      <div class="sbm-body">
        ${presets.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:30px 0;">还没有预设，新建一个，或者导入别人分享的.json文件</div>` : ''}
        ${presets.map(p => `
          <div class="sbm-card" data-id="${p.id}">
            <span class="name">${p.name}</span>
            <span style="color:#8e8e93;">›</span>
          </div>
        `).join('')}
        <button class="sbm-add-btn" id="sbm-new-btn">＋ 新建预设</button>
      </div>
    `;
    document.getElementById('sbm-close').addEventListener('click', () => showScreen('home-screen'));
    document.getElementById('sbm-new-btn').addEventListener('click', () => renderEditor(null));
    document.getElementById('sbm-import-btn').addEventListener('click', () => document.getElementById('sbm-import-file').click());
    document.getElementById('sbm-import-file').addEventListener('change', handleImportFile);
    content().querySelectorAll('.sbm-card[data-id]').forEach(el => {
      el.addEventListener('click', async () => renderEditor(await db_().presets.get(parseInt(el.dataset.id, 10))));
    });
  }
  window.__sbRenderPresetList = renderList;

  async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.name || !data.regexPattern || !data.replacePattern) {
        alert('这个文件格式不太对，缺少 name/regexPattern/replacePattern 字段');
        return;
      }
      await db_().presets.add({
        name: data.name,
        promptSuffix: data.promptSuffix || '',
        regexPattern: data.regexPattern,
        replacePattern: data.replacePattern
      });
      if (typeof showToast === 'function') showToast(`已导入「${data.name}」`);
      renderList();
    } catch (err) {
      alert('导入失败，文件可能不是有效的JSON：' + err.message);
    } finally {
      e.target.value = '';
    }
  }

  function renderEditor(preset) {
    editingPreset = preset;
    const isNew = !preset;
    const p = preset || { name: '', promptSuffix: '', regexPattern: '', replacePattern: '' };

    content().innerHTML = `
      <div class="sbm-header"><span class="back" id="sbm-back">‹</span><span class="title">${isNew ? '新建预设' : '编辑预设'}</span></div>
      <div class="sbm-body">
        <div class="sbm-row"><label>预设名字</label><input type="text" id="sbm-name" value="${(p.name || '').replace(/"/g, '&quot;')}"></div>
        <div class="sbm-row">
          <label>Prompt后缀（指示AI在回复末尾输出暗号的自然语言说明）</label>
          <textarea id="sbm-prompt" placeholder="例如：请在每次回复的最后加上一行：[State: mood=当前心情, loc=当前位置]">${p.promptSuffix || ''}</textarea>
        </div>
        <div class="sbm-row">
          <label>正则表达式（JS正则字面量格式，带斜杠和flags）</label>
          <input type="text" id="sbm-regex" placeholder="/\\[State: mood=(.*?), loc=(.*?)\\]/s" value="${(p.regexPattern || '').replace(/"/g, '&quot;')}">
          <div class="sbm-hint">格式是 /正则内容/flags，比如 /\\[State: (.*?)\\]/s，别用命名捕获组，用普通 (...) 就行</div>
        </div>
        <div class="sbm-row">
          <label>替换模板（用 $1 $2... 代表捕获组，支持完整HTML/CSS，支持 {{char_avatar}} 等变量）</label>
          <textarea id="sbm-html" style="min-height:140px;" placeholder="&lt;div&gt;心情：$1，位置：$2&lt;/div&gt;">${p.replacePattern || ''}</textarea>
        </div>
        <div class="sbm-row">
          <label>测试文本（仅本地预览用，不会存进导出文件）</label>
          <textarea id="sbm-test" placeholder="随便写一句带暗号的话，比如：今天天气不错。[State: mood=开心, loc=咖啡厅]"></textarea>
        </div>
        <button class="sbm-btn-secondary" style="width:100%; padding:11px; border:none; border-radius:10px; margin-bottom:6px;" id="sbm-test-btn">🧪 测试</button>
        <div id="sbm-test-result"></div>

        <div class="sbm-actions" style="margin-top:16px;">
          <button class="sbm-btn-secondary" id="sbm-export-btn">⬇ 导出JSON</button>
          ${!isNew ? '<button class="sbm-btn-danger" id="sbm-delete-btn">删除</button>' : ''}
        </div>
        <button class="sbm-btn-primary" id="sbm-save-btn" style="width:100%; margin-top:10px;">保存</button>
      </div>
    `;
    document.getElementById('sbm-back').addEventListener('click', renderList);
    document.getElementById('sbm-test-btn').addEventListener('click', runTest);
    document.getElementById('sbm-save-btn').addEventListener('click', savePreset);
    document.getElementById('sbm-export-btn').addEventListener('click', exportPreset);
    document.getElementById('sbm-delete-btn')?.addEventListener('click', deletePreset);
  }

  function runTest() {
    const regexRaw = document.getElementById('sbm-regex').value.trim();
    const replacePattern = document.getElementById('sbm-html').value;
    const testText = document.getElementById('sbm-test').value;
    const resultEl = document.getElementById('sbm-test-result');

    const parsed = parseRegexLiteral(regexRaw);
    let regex;
    try { regex = new RegExp(parsed.pattern, parsed.flags); } catch (e) {
      resultEl.innerHTML = `<span style="color:#ff6b6b;">正则语法错误：${e.message}</span>`;
      return;
    }
    const m = regex.exec(testText);
    if (!m) {
      resultEl.innerHTML = `<span style="color:#ff9500;">没匹配上，检查一下测试文本里有没有暗号，或者正则是不是写对了</span>`;
      return;
    }
    let html = replacePattern;
    m.slice(1).forEach((g, i) => { html = html.replace(new RegExp('\\$' + (i + 1), 'g'), g || ''); });
    resultEl.innerHTML = html;
  }

  function collectFormData() {
    return {
      name: document.getElementById('sbm-name').value.trim(),
      promptSuffix: document.getElementById('sbm-prompt').value,
      regexPattern: document.getElementById('sbm-regex').value.trim(),
      replacePattern: document.getElementById('sbm-html').value
    };
  }

  async function savePreset() {
    const data = collectFormData();
    if (!data.name) { alert('给预设起个名字吧'); return; }
    if (editingPreset && editingPreset.id) {
      await db_().presets.update(editingPreset.id, data);
    } else {
      await db_().presets.add(data);
    }
    if (typeof showToast === 'function') showToast('已保存');
    renderList();
  }

  async function deletePreset() {
    if (!editingPreset || !editingPreset.id) return;
    if (!confirm('确定删除这个预设吗？用到它的角色会失效，需要重新选一个。')) return;
    await db_().presets.delete(editingPreset.id);
    renderList();
  }

  function exportPreset() {
    const data = collectFormData();
    if (!data.name) { alert('先起个名字再导出吧'); return; }
    // 严格对齐社区通用格式：id/name/promptSuffix/regexPattern/replacePattern
    const exportObj = {
      id: String(editingPreset?.id || Date.now()),
      name: data.name,
      promptSuffix: data.promptSuffix,
      regexPattern: data.regexPattern,
      replacePattern: data.replacePattern
    };

    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `status_preset_${data.name}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function init() {
    injectStyle();
    console.log('[状态栏预设库] 初始化完成');
  }

  document.addEventListener('DOMContentLoaded', () => {
    function tryInit(retries) {
      if (window.state && window.db && typeof Dexie !== 'undefined' && document.getElementById('status-bar-app-content')) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn('[状态栏预设库] 等待依赖超时');
      }
    }
    tryInit(30);
  });
})();
