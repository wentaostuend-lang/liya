// ============================================================
// status-bar-manager.js — 状态栏预设库管理 App
//
// 依赖 status-bar.js 里暴露的 window.__statusBarDB（同一个 Dexie 库）。
// 实体App（第4页图标），不是浮层。
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
      .sbm-actions { display:flex; gap:8px; margin-top:8px; }
      .sbm-actions button { flex:1; border:none; border-radius:10px; padding:11px; font-size:14px; }
      .sbm-btn-primary { background:#fff; color:#000; font-weight:700; }
      .sbm-btn-secondary { background:#1c1c1e; color:#fff; }
      .sbm-btn-danger { background:#3a1d1d; color:#ff6b6b; }
      #sbm-test-result { background:#111; border-radius:10px; padding:12px; margin-top:6px; min-height:40px; font-size:13px; }
    `;
    document.head.appendChild(style);
  }

  async function renderList() {
    const presets = await db_().presets.toArray();
    content().innerHTML = `
      <div class="sbm-header"><span class="back" id="sbm-close">✕</span><span class="title">状态栏预设库</span></div>
      <div class="sbm-body">
        ${presets.length === 0 ? `<div style="color:#8e8e93; font-size:13px; text-align:center; padding:30px 0;">还没有预设，新建一个吧</div>` : ''}
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
    content().querySelectorAll('.sbm-card[data-id]').forEach(el => {
      el.addEventListener('click', async () => renderEditor(await db_().presets.get(parseInt(el.dataset.id, 10))));
    });
  }
  window.__sbRenderPresetList = renderList;

  function renderEditor(preset) {
    editingPreset = preset;
    const isNew = !preset;
    const p = preset || { name: '', promptSuffix: '', regexSource: '', htmlTemplate: '', testText: '' };

    content().innerHTML = `
      <div class="sbm-header"><span class="back" id="sbm-back">‹</span><span class="title">${isNew ? '新建预设' : '编辑预设'}</span></div>
      <div class="sbm-body">
        <div class="sbm-row"><label>预设名字</label><input type="text" id="sbm-name" value="${p.name}"></div>
        <div class="sbm-row">
          <label>Prompt后缀（指示AI在回复末尾输出暗号的自然语言说明）</label>
          <textarea id="sbm-prompt" placeholder="例如：请在每次回复的最后加上一行：[State: mood=当前心情, loc=当前位置]">${p.promptSuffix}</textarea>
        </div>
        <div class="sbm-row">
          <label>正则表达式（JS语法，只用普通捕获组，别用命名捕获组）</label>
          <input type="text" id="sbm-regex" placeholder="\\\\[State: mood=(.*?), loc=(.*?)\\\\]" value="${(p.regexSource || '').replace(/"/g, '&quot;')}">
        </div>
        <div class="sbm-row">
          <label>HTML替换模板（用 $1 $2... 代表捕获组，支持完整HTML/CSS，支持 {{char_avatar}} 等变量）</label>
          <textarea id="sbm-html" style="min-height:140px;" placeholder="&lt;div&gt;心情：$1，位置：$2&lt;/div&gt;">${p.htmlTemplate}</textarea>
        </div>
        <div class="sbm-row">
          <label>测试文本（模拟AI的一条回复，点下面"测试"看渲染效果）</label>
          <textarea id="sbm-test" placeholder="随便写一句带暗号的话，比如：今天天气不错。[State: mood=开心, loc=咖啡厅]">${p.testText}</textarea>
        </div>
        <button class="sbm-btn-secondary" style="width:100%; padding:11px; border:none; border-radius:10px; margin-bottom:6px;" id="sbm-test-btn">🧪 测试</button>
        <div id="sbm-test-result"></div>

        <div class="sbm-actions" style="margin-top:16px;">
          <button class="sbm-btn-secondary" id="sbm-export-btn">⬇ 导出TXT</button>
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
    const regexSource = document.getElementById('sbm-regex').value.trim();
    const htmlTemplate = document.getElementById('sbm-html').value;
    const testText = document.getElementById('sbm-test').value;
    const resultEl = document.getElementById('sbm-test-result');

    let regex;
    try { regex = new RegExp(regexSource); } catch (e) {
      resultEl.innerHTML = `<span style="color:#ff6b6b;">正则语法错误：${e.message}</span>`;
      return;
    }
    const m = regex.exec(testText);
    if (!m) {
      resultEl.innerHTML = `<span style="color:#ff9500;">没匹配上，检查一下测试文本里有没有暗号，或者正则是不是写对了</span>`;
      return;
    }
    let html = htmlTemplate;
    m.slice(1).forEach((g, i) => { html = html.replace(new RegExp('\\$' + (i + 1), 'g'), g || ''); });
    resultEl.innerHTML = html;
  }

  async function savePreset() {
    const name = document.getElementById('sbm-name').value.trim();
    if (!name) { alert('给预设起个名字吧'); return; }
    const data = {
      name,
      promptSuffix: document.getElementById('sbm-prompt').value,
      regexSource: document.getElementById('sbm-regex').value.trim(),
      htmlTemplate: document.getElementById('sbm-html').value,
      testText: document.getElementById('sbm-test').value
    };
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
    const name = document.getElementById('sbm-name').value.trim() || '未命名预设';
    const data = {
      name,
      promptSuffix: document.getElementById('sbm-prompt').value,
      regexSource: document.getElementById('sbm-regex').value.trim(),
      htmlTemplate: document.getElementById('sbm-html').value,
      testText: document.getElementById('sbm-test').value
    };
    // 暂时按"整份预设用<statusbar>包一层"的理解导出，等你发具体范例后再调整格式
    const txtContent = `<statusbar name="${data.name}">\n[PromptSuffix]\n${data.promptSuffix}\n\n[Regex]\n${data.regexSource}\n\n[HtmlTemplate]\n${data.htmlTemplate}\n\n[TestText]\n${data.testText}\n</statusbar>`;

    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-状态栏预设.txt`;
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
