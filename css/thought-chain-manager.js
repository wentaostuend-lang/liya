const ThoughtChainManager = {
    items: [],
    enabled: true,
    selectedIds: [],
    draggedItemId: null,
    currentPresetId: null,
    basePresetId: null,
    lastSavedSnapshot: '',
    behavior: null,
    organizeMode: false,

    defaultBehavior: {
        prefillEnabled: true,
        extractionEnabled: true,
        extractionMode: 'tags',
        startMarker: '<thinking>',
        endMarker: '</thinking>',
        extractionRegex: '',
        ignoreCase: true,
        removeFromBody: true,
        allowMissingStart: true,
        extractAll: false
    },
    
    defaultItems: [
        {
            id: 'tc_head_1',
            name: '思维链开启引导',
            position: 'head',
            role: 'system',
            content: '在行动前，你必须先思考。请按照以下步骤在 <thinking> 和 </thinking> 标签内进行思考：',
            enabled: true,
            isCore: true
        },
        {
            id: 'tc_mid_1',
            name: '潜台词感知',
            position: 'middle',
            role: 'system',
            content: '- 潜台词感知：对方这句话的潜台词是什么？当前话题是否涉及世界书/人设中的特殊设定？我该如何体现？对他/她的人设是否把握准确？',
            enabled: true
        },
        {
            id: 'tc_mid_2',
            name: '情绪反应',
            position: 'middle',
            role: 'system',
            content: '- 情绪反应：我此刻的真实情绪（开心/委屈/期待？）我的情绪是否符合我的人设',
            enabled: true
        },
        {
            id: 'tc_mid_3',
            name: '角色想法',
            position: 'middle',
            role: 'system',
            content: '- 角色想法：基于人设，我内心最真实的想法...',
            enabled: true
        },
        {
            id: 'tc_bottom_1',
            name: '思维链触发器',
            position: 'bottom',
            role: 'assistant',
            content: '<thinking>\n',
            enabled: true,
            isCore: true
        }
    ],

    init() {
        this.loadData();
        this.bindEvents();
        this.renderList();
        this.renderBehaviorSettings();
        
        // 由于 Dexie 初始化可能是异步的，等待一点时间后加载下拉框
        setTimeout(() => {
            this.loadPresetsDropdown();
        }, 500);
    },

    clone(value) {
        return JSON.parse(JSON.stringify(value));
    },

    async showThoughtChainConfirm(...args) {
        document.body.classList.add('tc-modal-context');
        try { return await showCustomConfirm(...args); }
        finally { document.body.classList.remove('tc-modal-context'); }
    },

    async showThoughtChainPrompt(...args) {
        document.body.classList.add('tc-modal-context');
        try { return await showCustomPrompt(...args); }
        finally { document.body.classList.remove('tc-modal-context'); }
    },

    escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    normalizeItem(item, index = 0) {
        const allowedPositions = ['head', 'middle', 'bottom', 'before_history', 'in_chat', 'after_history'];
        const allowedRoles = ['system', 'assistant', 'user'];
        const normalized = item && typeof item === 'object' ? item : {};
        return {
            ...normalized,
            id: typeof normalized.id === 'string' && normalized.id ? normalized.id : `tc_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 9)}`,
            name: typeof normalized.name === 'string' && normalized.name.trim() ? normalized.name.trim() : `未命名条目 ${index + 1}`,
            position: allowedPositions.includes(normalized.position) ? normalized.position : 'middle',
            role: allowedRoles.includes(normalized.role) ? normalized.role : 'system',
            content: typeof normalized.content === 'string' ? normalized.content : '',
            note: typeof normalized.note === 'string' ? normalized.note : '',
            depth: Number.isFinite(Number(normalized.depth)) ? Math.max(0, Math.floor(Number(normalized.depth))) : 0,
            order: Number.isFinite(Number(normalized.order)) ? Number(normalized.order) : index,
            enabled: normalized.enabled !== false,
            isCore: normalized.isCore === true
        };
    },

    normalizeItems(items) {
        if (!Array.isArray(items)) return [];
        const seen = new Set();
        return items.map((item, index) => {
            const normalized = this.normalizeItem(item, index);
            if (seen.has(normalized.id)) normalized.id = `tc_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 9)}`;
            seen.add(normalized.id);
            return normalized;
        });
    },

    normalizeBehavior(behavior) {
        const merged = { ...this.defaultBehavior, ...(behavior && typeof behavior === 'object' ? behavior : {}) };
        merged.extractionMode = merged.extractionMode === 'regex' ? 'regex' : 'tags';
        merged.startMarker = typeof merged.startMarker === 'string' ? merged.startMarker : '<thinking>';
        merged.endMarker = typeof merged.endMarker === 'string' ? merged.endMarker : '</thinking>';
        merged.extractionRegex = typeof merged.extractionRegex === 'string' ? merged.extractionRegex : '';
        ['prefillEnabled', 'extractionEnabled', 'ignoreCase', 'removeFromBody', 'allowMissingStart', 'extractAll'].forEach(key => {
            merged[key] = merged[key] !== false;
        });
        // extractAll historically defaults to false, unlike the other switches.
        merged.extractAll = behavior && behavior.extractAll === true;
        return merged;
    },

    getStateSnapshot() {
        return JSON.stringify({ enabled: this.enabled, items: this.items, behavior: this.behavior });
    },

    setSavedSnapshot() {
        this.lastSavedSnapshot = this.getStateSnapshot();
        this.updateDirtyState();
    },

    updateDirtyState() {
        const indicator = document.getElementById('thought-chain-unsaved-indicator');
        if (!indicator) return;
        const dirty = !!this.lastSavedSnapshot && this.getStateSnapshot() !== this.lastSavedSnapshot;
        indicator.hidden = !dirty;
    },

    async loadPresetsDropdown(forceSelectedId = null) {
        const selectEl = document.getElementById('thought-chain-preset-select');
        if (!selectEl) return;
        
        selectEl.innerHTML = '<option value="current">当前配置 (未保存)</option>';

        try {
            // 插入内置默认模板
            const defaultOption = document.createElement('option');
            defaultOption.value = 'default';
            defaultOption.textContent = '内置默认模板';
            selectEl.appendChild(defaultOption);

            const presets = await db.thoughtChainPresets.toArray();
            presets.forEach(preset => {
                const option = document.createElement('option');
                option.value = preset.id;
                option.textContent = preset.name;
                selectEl.appendChild(option);
            });

            if (forceSelectedId) {
                selectEl.value = forceSelectedId;
                this.currentPresetId = Number(forceSelectedId) || forceSelectedId;
                this.basePresetId = this.currentPresetId;
                return;
            }
            
            // 尝试匹配当前配置
            let matchingPresetId = null;
            const currentItemsJson = JSON.stringify(this.items);
            for (const preset of presets) {
                const sameItems = JSON.stringify(this.normalizeItems(this.clone(preset.items || []))) === currentItemsJson;
                const sameBehavior = JSON.stringify(this.normalizeBehavior(preset.behavior)) === JSON.stringify(this.behavior);
                const sameEnabled = (preset.enabled !== false) === this.enabled;
                if (sameItems && sameBehavior && sameEnabled) {
                    matchingPresetId = preset.id;
                    break;
                }
            }

            if (matchingPresetId) {
                selectEl.value = matchingPresetId;
                this.currentPresetId = Number(matchingPresetId);
                this.basePresetId = this.currentPresetId;
            } else if (JSON.stringify(this.items) === JSON.stringify(this.normalizeItems(this.clone(this.defaultItems)))) {
                selectEl.value = 'default';
                this.currentPresetId = 'default';
                this.basePresetId = 'default';
            } else {
                selectEl.value = 'current';
                this.currentPresetId = null;
            }
        } catch (e) {
            console.error('加载思维链预设失败:', e);
        }
    },

    async handlePresetSelectionChange() {
        const selectEl = document.getElementById('thought-chain-preset-select');
        const selectedValue = selectEl.value;

        if (this.lastSavedSnapshot && this.getStateSnapshot() !== this.lastSavedSnapshot) {
            const confirmed = await this.showThoughtChainConfirm('未保存修改', '当前配置有未保存修改，确定放弃修改并切换预设吗？', {
                confirmButtonText: '放弃并切换'
            });
            if (!confirmed) {
                selectEl.value = this.currentPresetId === 'default' ? 'default' : (this.currentPresetId || 'current');
                return;
            }
        }

        if (selectedValue === 'default') {
            this.items = this.normalizeItems(this.clone(this.defaultItems));
            this.behavior = this.normalizeBehavior(this.defaultBehavior);
            this.enabled = true;
            this.currentPresetId = 'default';
            this.basePresetId = 'default';
            this.selectedIds = [];
            this.saveData();
            this.renderList();
            this.renderBehaviorSettings();
            this.setSavedSnapshot();
            showToast('已加载内置默认模板');
            return;
        }

        const selectedId = parseInt(selectedValue);
        if (isNaN(selectedId)) {
            return;
        }

        try {
            const preset = await db.thoughtChainPresets.get(selectedId);
            if (preset && preset.items) {
                this.items = this.normalizeItems(this.clone(preset.items));
                this.behavior = this.normalizeBehavior(preset.behavior);
                this.enabled = preset.enabled !== false;
                this.currentPresetId = selectedId;
                this.basePresetId = selectedId;
                this.selectedIds = [];
                this.saveData();
                this.renderList();
                this.renderBehaviorSettings();
                this.setSavedSnapshot();
                showToast(`已加载思维链预设: ${preset.name}`);
            }
        } catch (e) {
            console.error('加载思维链预设详细信息失败:', e);
        }
    },

    async savePreset() {
        const name = await this.showThoughtChainPrompt('保存思维链预设', '请输入预设名称');
        if (!name || !name.trim()) return;

        const presetData = {
            name: name.trim(),
            items: this.clone(this.items),
            behavior: this.clone(this.behavior),
            enabled: this.enabled,
            formatVersion: 2,
            updatedAt: Date.now()
        };

        try {
            const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
            if (existingPreset) {
                const confirmed = await this.showThoughtChainConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                    confirmButtonClass: 'btn-danger'
                });
                if (!confirmed) return;
                presetData.id = existingPreset.id;
            }

            await db.thoughtChainPresets.put(presetData);
            await this.loadPresetsDropdown(presetData.id);
            this.currentPresetId = presetData.id;
            this.basePresetId = presetData.id;
            this.setSavedSnapshot();
            showToast('思维链预设已保存！');
        } catch (e) {
            console.error('保存思维链预设失败:', e);
            alert('保存失败，请查看控制台。');
        }
    },

    async deletePreset() {
        const selectEl = document.getElementById('thought-chain-preset-select');
        const selectedId = parseInt(selectEl.value);

        if (isNaN(selectedId)) {
            alert('请先从下拉框中选择一个要删除的预设。');
            return;
        }

        try {
            const preset = await db.thoughtChainPresets.get(selectedId);
            if (!preset) return;

            const confirmed = await this.showThoughtChainConfirm('删除预设', `确定要删除预设 "${preset.name}" 吗？`, {
                confirmButtonClass: 'btn-danger'
            });
            if (confirmed) {
                await db.thoughtChainPresets.delete(selectedId);
                if (Number(this.basePresetId) === selectedId) this.basePresetId = null;
                if (Number(this.currentPresetId) === selectedId) this.currentPresetId = null;
                await this.loadPresetsDropdown();
                showToast('预设已删除。');
            }
        } catch (e) {
            console.error('删除思维链预设失败:', e);
        }
    },

    loadData() {
        const storedEnabled = localStorage.getItem('ephone_thought_chain_enabled');
        if (storedEnabled !== null) {
            this.enabled = storedEnabled === 'true';
        }

        const storedItems = localStorage.getItem('ephone_thought_chain_items');
        if (storedItems) {
            try {
                this.items = this.normalizeItems(JSON.parse(storedItems));
            } catch (e) {
                console.error('Failed to parse thought chain items', e);
                this.items = this.normalizeItems(this.clone(this.defaultItems));
            }
        } else {
            this.items = this.normalizeItems(this.clone(this.defaultItems));
            this.saveData();
        }

        try {
            const storedBehavior = localStorage.getItem('ephone_thought_chain_behavior');
            this.behavior = this.normalizeBehavior(storedBehavior ? JSON.parse(storedBehavior) : null);
        } catch (error) {
            console.warn('思维链兼容设置读取失败，已使用兼容旧行为的默认值:', error);
            this.behavior = this.normalizeBehavior(null);
        }
        
        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) {
            enableSwitch.checked = this.enabled;
        }
        this.lastSavedSnapshot = this.getStateSnapshot();
    },

    saveData() {
        localStorage.setItem('ephone_thought_chain_enabled', this.enabled);
        localStorage.setItem('ephone_thought_chain_items', JSON.stringify(this.items));
        localStorage.setItem('ephone_thought_chain_behavior', JSON.stringify(this.behavior || this.defaultBehavior));
        this.updateDirtyState();
    },

    bindEvents() {
        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) {
            enableSwitch.addEventListener('change', (e) => {
                this.enabled = e.target.checked;
                this.saveData();
                this.updateDirtyState();
            });
        }

        const resetBtn = document.getElementById('thought-chain-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (confirm('确定要恢复默认的思维链条目吗？这会覆盖你所有的自定义修改。')) {
                    this.items = this.normalizeItems(this.clone(this.defaultItems));
                    this.selectedIds = [];
                    this.saveData();
                    this.renderList();
                }
            });
        }

        const addBtn = document.getElementById('add-thought-chain-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                this.openEditor();
            });
        }

        const cancelBtn = document.getElementById('tc-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.closeEditor();
            });
        }

        const saveBtn = document.getElementById('tc-save-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveEditorItem();
            });
        }
        
        // 预设相关事件绑定
        const presetSelect = document.getElementById('thought-chain-preset-select');
        if (presetSelect) {
            presetSelect.addEventListener('change', () => this.handlePresetSelectionChange());
        }
        
        const newPresetBtn = document.getElementById('new-thought-chain-preset-btn');
        if (newPresetBtn) {
            newPresetBtn.addEventListener('click', () => this.createNewPreset());
        }

        const savePresetBtn = document.getElementById('save-thought-chain-preset-btn');
        if (savePresetBtn) {
            savePresetBtn.addEventListener('click', () => this.savePreset());
        }
        
        const deletePresetBtn = document.getElementById('delete-thought-chain-preset-btn');
        if (deletePresetBtn) {
            deletePresetBtn.addEventListener('click', () => this.deletePreset());
        }
        
        const exportPresetBtn = document.getElementById('export-thought-chain-preset-btn');
        if (exportPresetBtn) {
            exportPresetBtn.addEventListener('click', () => this.exportPreset());
        }
        
        const importPresetBtn = document.getElementById('import-thought-chain-preset-btn');
        const importPresetFile = document.getElementById('import-thought-chain-preset-file');
        if (importPresetBtn && importPresetFile) {
            importPresetBtn.addEventListener('click', () => importPresetFile.click());
            importPresetFile.addEventListener('change', (e) => this.importPreset(e));
        }

        const organizeBtn = document.getElementById('tc-organize-btn');
        if (organizeBtn) organizeBtn.addEventListener('click', () => {
            this.organizeMode = true;
            this.renderList();
        });
        const organizeDoneBtn = document.getElementById('tc-organize-done-btn');
        if (organizeDoneBtn) organizeDoneBtn.addEventListener('click', () => {
            this.organizeMode = false;
            this.selectedIds = [];
            this.renderList();
        });

        const duplicatePresetBtn = document.getElementById('duplicate-thought-chain-preset-btn');
        if (duplicatePresetBtn) duplicatePresetBtn.addEventListener('click', () => this.duplicatePreset());
        const renamePresetBtn = document.getElementById('rename-thought-chain-preset-btn');
        if (renamePresetBtn) renamePresetBtn.addEventListener('click', () => this.renamePreset());
        const revertPresetBtn = document.getElementById('revert-thought-chain-preset-btn');
        if (revertPresetBtn) revertPresetBtn.addEventListener('click', () => this.revertCurrentPreset());

        const behaviorBindings = {
            'thought-chain-prefill-switch': ['prefillEnabled', 'checked'],
            'thought-chain-extraction-switch': ['extractionEnabled', 'checked'],
            'thought-chain-extraction-mode': ['extractionMode', 'value'],
            'thought-chain-start-marker': ['startMarker', 'value'],
            'thought-chain-end-marker': ['endMarker', 'value'],
            'thought-chain-extraction-regex': ['extractionRegex', 'value'],
            'thought-chain-ignore-case-switch': ['ignoreCase', 'checked'],
            'thought-chain-remove-from-body-switch': ['removeFromBody', 'checked'],
            'thought-chain-allow-missing-start-switch': ['allowMissingStart', 'checked'],
            'thought-chain-extract-all-switch': ['extractAll', 'checked']
        };
        Object.entries(behaviorBindings).forEach(([id, [key, property]]) => {
            const element = document.getElementById(id);
            if (!element) return;
            const eventName = element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
            element.addEventListener(eventName, () => {
                this.behavior[key] = element[property];
                this.saveData();
                this.updateBehaviorVisibility();
            });
        });

        const previewBtn = document.getElementById('thought-chain-preview-btn');
        if (previewBtn) previewBtn.addEventListener('click', () => this.openPreviewTool());
        const parserTestBtn = document.getElementById('thought-chain-parser-test-btn');
        if (parserTestBtn) parserTestBtn.addEventListener('click', () => this.openParserTestTool());
        const toolsCloseBtn = document.getElementById('thought-chain-tools-close-btn');
        if (toolsCloseBtn) toolsCloseBtn.addEventListener('click', () => this.closeToolsModal());
        const toolsRunBtn = document.getElementById('thought-chain-tools-run-btn');
        if (toolsRunBtn) toolsRunBtn.addEventListener('click', () => this.runParserTest());
    },

    renderBehaviorSettings() {
        const values = {
            'thought-chain-prefill-switch': ['prefillEnabled', 'checked'],
            'thought-chain-extraction-switch': ['extractionEnabled', 'checked'],
            'thought-chain-extraction-mode': ['extractionMode', 'value'],
            'thought-chain-start-marker': ['startMarker', 'value'],
            'thought-chain-end-marker': ['endMarker', 'value'],
            'thought-chain-extraction-regex': ['extractionRegex', 'value'],
            'thought-chain-ignore-case-switch': ['ignoreCase', 'checked'],
            'thought-chain-remove-from-body-switch': ['removeFromBody', 'checked'],
            'thought-chain-allow-missing-start-switch': ['allowMissingStart', 'checked'],
            'thought-chain-extract-all-switch': ['extractAll', 'checked']
        };
        Object.entries(values).forEach(([id, [key, property]]) => {
            const element = document.getElementById(id);
            if (element) element[property] = this.behavior[key];
        });
        const enableSwitch = document.getElementById('thought-chain-enable-switch');
        if (enableSwitch) enableSwitch.checked = this.enabled;
        this.updateBehaviorVisibility();
        this.updateDirtyState();
    },

    updateBehaviorVisibility() {
        const settings = document.getElementById('thought-chain-extraction-settings');
        const tagSettings = document.getElementById('thought-chain-tag-settings');
        const regexSetting = document.getElementById('thought-chain-regex-setting');
        if (settings) settings.hidden = !this.behavior.extractionEnabled;
        const regexMode = this.behavior.extractionMode === 'regex';
        if (tagSettings) tagSettings.hidden = regexMode;
        if (regexSetting) regexSetting.hidden = !regexMode;
    },

    async createNewPreset() {
        const name = await this.showThoughtChainPrompt('新建思维链预设', '请输入新模板名称');
        if (!name || !name.trim()) return;

        // 仅保留头尾核心条目
        const coreItems = this.defaultItems.filter(item => item.isCore);
        
        const presetData = {
            name: name.trim(),
            items: this.clone(coreItems),
            behavior: this.clone(this.behavior),
            enabled: this.enabled,
            formatVersion: 2,
            updatedAt: Date.now()
        };

        try {
            const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
            if (existingPreset) {
                const confirmed = await this.showThoughtChainConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                    confirmButtonClass: 'btn-danger'
                });
                if (!confirmed) return;
                presetData.id = existingPreset.id;
            }

            const newId = await db.thoughtChainPresets.put(presetData);
            this.items = presetData.items;
            this.currentPresetId = newId;
            this.basePresetId = newId;
            this.selectedIds = [];
            this.saveData();
            this.renderList();
            await this.loadPresetsDropdown(newId);
            this.setSavedSnapshot();
            showToast('新模板创建成功，你可以自由添加中间的自定义条目了。');
        } catch (e) {
            console.error('新建思维链预设失败:', e);
            alert('创建失败，请查看控制台。');
        }
    },

    async duplicatePreset() {
        const name = await this.showThoughtChainPrompt('复制思维链预设', '请输入副本名称');
        if (!name || !name.trim()) return;
        const presetData = {
            name: name.trim(),
            items: this.clone(this.items),
            behavior: this.clone(this.behavior),
            enabled: this.enabled,
            formatVersion: 2,
            updatedAt: Date.now()
        };
        const existing = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
        if (existing) {
            showToast('已有同名预设，请使用其他名称。');
            return;
        }
        const newId = await db.thoughtChainPresets.add(presetData);
        this.currentPresetId = newId;
        this.basePresetId = newId;
        await this.loadPresetsDropdown(newId);
        this.setSavedSnapshot();
        showToast('预设副本已创建。');
    },

    async renamePreset() {
        const selectEl = document.getElementById('thought-chain-preset-select');
        const selectedId = Number(selectEl && selectEl.value);
        if (!Number.isInteger(selectedId) || selectedId <= 0) {
            showToast('请先选择一个已保存的自定义预设。');
            return;
        }
        const preset = await db.thoughtChainPresets.get(selectedId);
        if (!preset) return;
        const name = await this.showThoughtChainPrompt('重命名思维链预设', '请输入新名称', preset.name);
        if (!name || !name.trim() || name.trim() === preset.name) return;
        const existing = await db.thoughtChainPresets.where('name').equals(name.trim()).first();
        if (existing && existing.id !== selectedId) {
            showToast('已有同名预设，请使用其他名称。');
            return;
        }
        await db.thoughtChainPresets.update(selectedId, { name: name.trim(), updatedAt: Date.now() });
        await this.loadPresetsDropdown(selectedId);
        showToast('预设已重命名。');
    },

    async revertCurrentPreset() {
        const presetReference = this.currentPresetId || this.basePresetId;
        if (presetReference === 'default') {
            const confirmed = await this.showThoughtChainConfirm('撤销修改', '确定恢复到内置默认模板吗？');
            if (!confirmed) return;
            this.items = this.normalizeItems(this.clone(this.defaultItems));
            this.behavior = this.normalizeBehavior(this.defaultBehavior);
            this.enabled = true;
            this.currentPresetId = 'default';
            this.basePresetId = 'default';
            this.selectedIds = [];
            this.saveData();
            this.renderList();
            this.renderBehaviorSettings();
            await this.loadPresetsDropdown('default');
            this.setSavedSnapshot();
            showToast('已恢复到内置默认模板。');
            return;
        }
        const selectedId = Number(presetReference);
        if (!Number.isInteger(selectedId) || selectedId <= 0) {
            showToast('当前没有可恢复的已保存自定义预设。');
            return;
        }
        const preset = await db.thoughtChainPresets.get(selectedId);
        if (!preset) return;
        const confirmed = await this.showThoughtChainConfirm('撤销修改', '确定恢复到这个预设上次保存的状态吗？');
        if (!confirmed) return;
        this.items = this.normalizeItems(this.clone(preset.items));
        this.behavior = this.normalizeBehavior(preset.behavior);
        this.enabled = preset.enabled !== false;
        this.currentPresetId = selectedId;
        this.basePresetId = selectedId;
        this.selectedIds = [];
        this.saveData();
        this.renderList();
        this.renderBehaviorSettings();
        this.setSavedSnapshot();
        showToast('已恢复到上次保存状态。');
    },

    exportPreset() {
        if (!this.items || this.items.length === 0) {
            alert('当前没有可导出的思维链配置。');
            return;
        }

        const presetSelect = document.getElementById('thought-chain-preset-select');
        const presetName = presetSelect.options[presetSelect.selectedIndex].text || '思维链预设';
        
        const exportData = {
            formatVersion: 2,
            type: 'ephone-thought-chain-preset',
            name: presetName,
            exportedAt: new Date().toISOString(),
            enabled: this.enabled,
            behavior: this.clone(this.behavior),
            items: this.clone(this.items)
        };
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href",     dataStr);
        // 去除名称中的非法字符
        const safeName = presetName.replace(/[<>:"\/\\|?*\x00-\x1F]/g, '_');
        downloadAnchorNode.setAttribute("download", `思维链预设_${safeName}.json`);
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        showToast('已导出思维链配置。');
    },

    async importPreset(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            let parsedItems = parsed;
            let importedBehavior = null;
            let importedEnabled = this.enabled;
            
            // 兼容历史数组格式，同时严格校验会影响注入行为的字段。
            if (!Array.isArray(parsedItems)) {
                if (parsedItems.items && Array.isArray(parsedItems.items)) {
                    importedBehavior = parsedItems.behavior;
                    if (typeof parsedItems.enabled === 'boolean') importedEnabled = parsedItems.enabled;
                    parsedItems = parsedItems.items;
                } else {
                     throw new Error('导入的数据格式不正确，应为包含数组的JSON。');
                }
            }

            if (parsedItems.length > 1000) throw new Error('条目数量超过 1000，已停止导入。');
            const allowedPositions = new Set(['head', 'middle', 'bottom', 'before_history', 'in_chat', 'after_history']);
            const allowedRoles = new Set(['system', 'assistant', 'user']);
            parsedItems.forEach((item, index) => {
                if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 个条目不是有效对象。`);
                if (typeof item.name !== 'string' || !item.name.trim()) throw new Error(`第 ${index + 1} 个条目缺少名称。`);
                if (typeof item.content !== 'string') throw new Error(`第 ${index + 1} 个条目内容不是文本。`);
                if (item.content.length > 100000) throw new Error(`第 ${index + 1} 个条目内容过长。`);
                if (!allowedPositions.has(item.position)) throw new Error(`第 ${index + 1} 个条目的注入位置无效。`);
                if (!allowedRoles.has(item.role)) throw new Error(`第 ${index + 1} 个条目的发送身份无效。`);
            });

            const confirmed = await this.showThoughtChainConfirm('导入配置', '确定要导入此思维链配置吗？这将覆盖当前的未保存配置。', { confirmButtonText: '确定导入' });
            if (confirmed) {
                this.items = this.normalizeItems(parsedItems);
                // 重置所有导入项的内部状态以防冲突 (可选，但推荐生成新的内部 ID)
                this.items = this.items.map(item => ({
                    ...item,
                    id: 'tc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
                }));
                if (importedBehavior) this.behavior = this.normalizeBehavior(importedBehavior);
                this.enabled = importedEnabled;
                this.selectedIds = [];
                this.currentPresetId = null;
                this.basePresetId = null;
                this.saveData();
                this.renderList();
                this.renderBehaviorSettings();
                
                let defaultName = file.name.replace(/\.json$/i, '');
                if (defaultName.startsWith('思维链预设_')) {
                    defaultName = defaultName.substring('思维链预设_'.length);
                }
                
                const name = await this.showThoughtChainPrompt('保存为预设', '请输入新预设的名称', defaultName);
                if (name && name.trim()) {
                    const presetData = {
                        name: name.trim(),
                        items: this.clone(this.items),
                        behavior: this.clone(this.behavior),
                        enabled: this.enabled,
                        formatVersion: 2,
                        updatedAt: Date.now()
                    };
                    
                    const existingPreset = await db.thoughtChainPresets.where('name').equals(presetData.name).first();
                    let shouldSave = true;
                    if (existingPreset) {
                        const overwrite = await this.showThoughtChainConfirm('覆盖预设', `名为 "${presetData.name}" 的预设已存在。要覆盖它吗？`, {
                            confirmButtonClass: 'btn-danger'
                        });
                        if (!overwrite) {
                            shouldSave = false;
                        } else {
                            presetData.id = existingPreset.id;
                        }
                    }
                    
                    if (shouldSave) {
                        const newId = await db.thoughtChainPresets.put(presetData);
                        this.currentPresetId = newId;
                        this.basePresetId = newId;
                        await this.loadPresetsDropdown(newId);
                        this.setSavedSnapshot();
                        showToast('思维链配置导入并保存成功！');
                    } else {
                        this.loadPresetsDropdown();
                        showToast('思维链配置导入成功！（未保存为预设）');
                    }
                } else {
                    this.loadPresetsDropdown(); // 如果取消保存，则重置下拉框为当前未保存状态
                    showToast('思维链配置导入成功！（未保存为预设）');
                }
            }
        } catch (error) {
            console.error('导入思维链配置失败:', error);
            alert(`导入失败: ${error.message || '文件格式错误'}`);
        } finally {
            // 清空 file input，以便下次可以选择同一个文件
            event.target.value = '';
        }
    },

    moveItemUp(index) {
        if (index <= 0) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.splice(index - 1, 0, item);
        this.syncOrdersFromList();
        this.saveData();
        this.renderList();
    },

    moveItemDown(index) {
        if (index >= this.items.length - 1) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.splice(index + 1, 0, item);
        this.syncOrdersFromList();
        this.saveData();
        this.renderList();
    },

    moveItemTop(index) {
        if (index <= 0) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.unshift(item);
        this.syncOrdersFromList();
        this.saveData();
        this.renderList();
    },

    moveItemBottom(index) {
        if (index >= this.items.length - 1) return;
        const item = this.items[index];
        this.items.splice(index, 1);
        this.items.push(item);
        this.syncOrdersFromList();
        this.saveData();
        this.renderList();
    },

    moveSelectedUp() {
        if (this.selectedIds.length === 0) return;
        let moved = false;
        for (let i = 1; i < this.items.length; i++) {
            if (this.selectedIds.includes(this.items[i].id) && !this.selectedIds.includes(this.items[i-1].id)) {
                const temp = this.items[i];
                this.items[i] = this.items[i-1];
                this.items[i-1] = temp;
                moved = true;
            }
        }
        if (moved) {
            this.syncOrdersFromList();
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedDown() {
        if (this.selectedIds.length === 0) return;
        let moved = false;
        for (let i = this.items.length - 2; i >= 0; i--) {
            if (this.selectedIds.includes(this.items[i].id) && !this.selectedIds.includes(this.items[i+1].id)) {
                const temp = this.items[i];
                this.items[i] = this.items[i+1];
                this.items[i+1] = temp;
                moved = true;
            }
        }
        if (moved) {
            this.syncOrdersFromList();
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedTop() {
        if (this.selectedIds.length === 0) return;
        const selectedItems = [];
        const unselectedItems = [];
        
        for (const item of this.items) {
            if (this.selectedIds.includes(item.id)) {
                selectedItems.push(item);
            } else {
                unselectedItems.push(item);
            }
        }
        
        let isAlreadyTop = true;
        for (let i = 0; i < selectedItems.length; i++) {
            if (this.items[i].id !== selectedItems[i].id) {
                isAlreadyTop = false;
                break;
            }
        }
        
        if (!isAlreadyTop) {
            this.items = [...selectedItems, ...unselectedItems];
            this.syncOrdersFromList();
            this.saveData();
            this.renderList();
        }
    },

    moveSelectedBottom() {
        if (this.selectedIds.length === 0) return;
        const selectedItems = [];
        const unselectedItems = [];
        
        for (const item of this.items) {
            if (this.selectedIds.includes(item.id)) {
                selectedItems.push(item);
            } else {
                unselectedItems.push(item);
            }
        }
        
        let isAlreadyBottom = true;
        for (let i = 0; i < selectedItems.length; i++) {
            if (this.items[this.items.length - selectedItems.length + i].id !== selectedItems[i].id) {
                isAlreadyBottom = false;
                break;
            }
        }
        
        if (!isAlreadyBottom) {
            this.items = [...unselectedItems, ...selectedItems];
            this.syncOrdersFromList();
            this.saveData();
            this.renderList();
        }
    },

    toggleSelection(id) {
        const index = this.selectedIds.indexOf(id);
        if (index === -1) {
            this.selectedIds.push(id);
        } else {
            this.selectedIds.splice(index, 1);
        }
        this.renderList();
    },

    toggleAllSelection(checked) {
        if (checked) {
            this.selectedIds = this.items.map(item => item.id);
        } else {
            this.selectedIds = [];
        }
        this.renderList();
    },

    syncOrdersFromList() {
        this.items.forEach((item, index) => { item.order = index; });
    },

    duplicateItem(itemId) {
        const index = this.items.findIndex(item => item.id === itemId);
        if (index < 0) return;
        const copy = this.clone(this.items[index]);
        copy.id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        copy.name = `${copy.name} 副本`;
        copy.isCore = false;
        this.items.splice(index + 1, 0, copy);
        this.saveData();
        this.renderList();
        this.loadPresetsDropdown();
        this.openEditor(copy.id);
    },

    legacyRenderList() {
        const listContainer = document.getElementById('thought-chain-list');
        if (!listContainer) return;
        const existingIds = new Set(this.items.map(item => item.id));
        this.selectedIds = this.selectedIds.filter(id => existingIds.has(id));
        
        listContainer.innerHTML = '';
        
        if (this.items.length === 0) {
            listContainer.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无思维链条目</div>';
            return;
        }

        const allSelected = this.items.length > 0 && this.selectedIds.length === this.items.length;
        const someSelected = this.selectedIds.length > 0;
        
        const toolbarEl = document.createElement('div');
        toolbarEl.style.cssText = 'display: flex; gap: 10px; align-items: center; margin-bottom: 10px; padding: 8px 12px; background: #f9f9f9; border-radius: 8px; border: 1px solid #eee;';
        toolbarEl.innerHTML = `
            <label style="display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
                <input type="checkbox" id="tc-select-all" ${allSelected ? 'checked' : ''}>
                <span style="font-size: 13px; color: #333; font-weight: 500;">全选</span>
            </label>
            <div style="flex: 1;"></div>
            <button id="tc-btn-move-top" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">置顶选中</button>
            <button id="tc-btn-move-up" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">上移选中</button>
            <button id="tc-btn-move-down" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">下移选中</button>
            <button id="tc-btn-move-bottom" style="padding: 4px 10px; font-size: 12px; border-radius: 4px; border: 1px solid #ccc; background: white; cursor: ${someSelected ? 'pointer' : 'not-allowed'}; opacity: ${someSelected ? 1 : 0.5}; color: #333;">置底选中</button>
        `;
        listContainer.appendChild(toolbarEl);
        
        toolbarEl.querySelector('#tc-select-all').addEventListener('change', (e) => {
            this.toggleAllSelection(e.target.checked);
        });
        toolbarEl.querySelector('#tc-btn-move-top').addEventListener('click', () => {
            this.moveSelectedTop();
        });
        toolbarEl.querySelector('#tc-btn-move-up').addEventListener('click', () => {
            this.moveSelectedUp();
        });
        toolbarEl.querySelector('#tc-btn-move-down').addEventListener('click', () => {
            this.moveSelectedDown();
        });
        toolbarEl.querySelector('#tc-btn-move-bottom').addEventListener('click', () => {
            this.moveSelectedBottom();
        });

        this.items.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'tc-item-card';
            el.draggable = true;
            el.dataset.index = index;
            el.dataset.id = item.id;
            
            el.addEventListener('dragstart', (e) => {
                this.draggedItemId = item.id;
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => el.style.opacity = '0.5', 0);
            });
            el.addEventListener('dragend', (e) => {
                this.draggedItemId = null;
                el.style.opacity = '1';
                listContainer.querySelectorAll('.tc-item-card').forEach(card => {
                    card.style.borderTop = '';
                    card.style.borderBottom = '';
                });
            });
            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = el.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                if (e.clientY < mid) {
                    el.style.borderTop = '2px solid #007aff';
                    el.style.borderBottom = '';
                } else {
                    el.style.borderBottom = '2px solid #007aff';
                    el.style.borderTop = '';
                }
            });
            el.addEventListener('dragleave', (e) => {
                el.style.borderTop = '';
                el.style.borderBottom = '';
            });
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.style.borderTop = '';
                el.style.borderBottom = '';
                if (!this.draggedItemId || this.draggedItemId === item.id) return;
                
                const rect = el.getBoundingClientRect();
                const mid = rect.top + rect.height / 2;
                const insertAfter = e.clientY >= mid;
                
                const draggedIndex = this.items.findIndex(i => i.id === this.draggedItemId);
                let targetIndex = index;
                if (insertAfter && draggedIndex > targetIndex) targetIndex++;
                else if (!insertAfter && draggedIndex < targetIndex) targetIndex--;
                
                const draggedItem = this.items[draggedIndex];
                this.items.splice(draggedIndex, 1);
                this.items.splice(targetIndex, 0, draggedItem);
                this.syncOrdersFromList();
                
                this.saveData();
                this.renderList();
            });

            el.style.cssText = 'background: white; border-radius: 8px; padding: 12px; border: 1px solid #eee; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); margin-bottom: 8px; transition: transform 0.2s;';
            
            const isSelected = this.selectedIds.includes(item.id);
            const positionLabels = {
                head: '头部', middle: '中间', bottom: '底部',
                before_history: '记录前', in_chat: `记录内·深度${item.depth || 0}`, after_history: '记录后'
            };
            const positionText = positionLabels[item.position] || item.position;
            const roleText = item.role === 'system' ? 'System' : (item.role === 'assistant' ? 'Assistant' : 'User');
            const safeItemId = this.escapeHtml(item.id);
            
            el.innerHTML = `
                <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px; opacity: ${item.enabled ? '1' : '0.5'};">
                    <div style="cursor: grab; color: #bbb; font-size: 18px; user-select: none; line-height: 1;" title="长按拖动">≡</div>
                    <input type="checkbox" class="tc-item-select" data-id="${safeItemId}" ${isSelected ? 'checked' : ''} style="cursor: pointer; margin: 0;">
                    <span style="font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;" title="${this.escapeHtml(item.note || item.name)}">${this.escapeHtml(item.name)}</span>
                    <span style="font-size: 11px; font-weight: normal; background: #f0f0f0; padding: 2px 6px; border-radius: 4px; color: #666; white-space: nowrap; flex-shrink: 0;">${this.escapeHtml(positionText)} | ${roleText} | #${Number(item.order) || 0}</span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                    <button class="tc-item-move-top-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === 0 ? 'disabled' : ''}>置顶</button>
                    <button class="tc-item-move-up-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === 0 ? 'disabled' : ''}>上移</button>
                    <button class="tc-item-move-down-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === this.items.length - 1 ? 'disabled' : ''}>下移</button>
                    <button class="tc-item-move-bottom-btn" data-index="${index}" style="background: none; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #333;" ${index === this.items.length - 1 ? 'disabled' : ''}>置底</button>
                    <label class="toggle-switch" style="transform: scale(0.8); margin: 0;">
                        <input type="checkbox" class="tc-item-toggle" data-id="${safeItemId}" ${item.enabled ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <button class="tc-item-duplicate-btn" data-id="${safeItemId}" style="background: none; border: 1px solid #8e8e93; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #636366;">复制</button>
                    <button class="tc-item-edit-btn" data-id="${safeItemId}" style="background: none; border: 1px solid #007aff; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #007aff;">编辑</button>
                    ${!item.isCore ? `<button class="tc-item-delete-btn" data-id="${safeItemId}" style="background: none; border: 1px solid #ff3b30; border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer; color: #ff3b30;">删除</button>` : ''}
                </div>
            `;
            
            listContainer.appendChild(el);
        });

        // Bind events for items
        listContainer.querySelectorAll('.tc-item-select').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                this.toggleSelection(id);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-up-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemUp(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-down-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemDown(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-top-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemTop(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-move-bottom-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.getAttribute('data-index'), 10);
                this.moveItemBottom(index);
            });
        });

        listContainer.querySelectorAll('.tc-item-toggle').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const id = e.target.getAttribute('data-id');
                const item = this.items.find(i => i.id === id);
                if (item) {
                    item.enabled = e.target.checked;
                    this.saveData();
                    this.renderList();
                }
            });
        });

        listContainer.querySelectorAll('.tc-item-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                this.openEditor(id);
            });
        });

        listContainer.querySelectorAll('.tc-item-duplicate-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.duplicateItem(e.currentTarget.getAttribute('data-id')));
        });

        listContainer.querySelectorAll('.tc-item-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (confirm('确定要删除这个条目吗？')) {
                    const id = e.target.getAttribute('data-id');
                    this.items = this.items.filter(i => i.id !== id);
                    
                    const selIndex = this.selectedIds.indexOf(id);
                    if (selIndex !== -1) {
                        this.selectedIds.splice(selIndex, 1);
                    }
                    
                    this.saveData();
                    this.renderList();
                }
            });
        });
    },

    renderList() {
        const list = document.getElementById('thought-chain-list');
        if (!list) return;
        const existingIds = new Set(this.items.map(item => item.id));
        this.selectedIds = this.selectedIds.filter(id => existingIds.has(id));
        list.className = `thought-chain-list ${this.organizeMode ? 'is-organizing' : 'is-browsing'}`;
        list.innerHTML = '';

        if (!this.items.length) {
            list.innerHTML = '<div class="tc-empty"><span class="tc-empty-index">00</span><p>还没有思考模块</p><button class="tc-add-empty" type="button">新增思考模块</button></div>';
            list.querySelector('button').addEventListener('click', () => this.openEditor());
            return;
        }

        if (this.organizeMode) {
            const allSelected = this.selectedIds.length === this.items.length;
            const toolbar = document.createElement('div');
            toolbar.className = 'tc-organize-toolbar';
            toolbar.innerHTML = `<div class="tc-toolbar-heading"><span class="tc-kicker">EDITING ORDER</span><strong>编排模块</strong></div>
                <label class="tc-select-all"><input type="checkbox" id="tc-select-all" ${allSelected ? 'checked' : ''}><span>全选</span></label>
                <div class="tc-batch-actions"><button id="tc-btn-move-top" type="button">置顶</button><button id="tc-btn-move-up" type="button">上移</button><button id="tc-btn-move-down" type="button">下移</button><button id="tc-btn-move-bottom" type="button">置底</button></div>
                <button id="tc-organize-done-btn" class="tc-done-btn" type="button">完成</button>`;
            list.appendChild(toolbar);
            toolbar.querySelector('#tc-select-all').addEventListener('change', e => this.toggleAllSelection(e.target.checked));
            toolbar.querySelector('#tc-btn-move-top').addEventListener('click', () => this.moveSelectedTop());
            toolbar.querySelector('#tc-btn-move-up').addEventListener('click', () => this.moveSelectedUp());
            toolbar.querySelector('#tc-btn-move-down').addEventListener('click', () => this.moveSelectedDown());
            toolbar.querySelector('#tc-btn-move-bottom').addEventListener('click', () => this.moveSelectedBottom());
            toolbar.querySelector('#tc-organize-done-btn').addEventListener('click', () => { this.organizeMode = false; this.selectedIds = []; this.renderList(); });
        }

        const positionLabels = { head: 'HEAD', middle: 'MIDDLE', bottom: 'BOTTOM', before_history: '记录前', in_chat: '记录内', after_history: '记录后' };
        const roleLabels = { system: 'SYSTEM', assistant: 'ASSISTANT', user: 'USER' };
        this.items.forEach((item, index) => {
            const el = document.createElement('article');
            el.className = `tc-module tc-position-${item.position} ${item.enabled ? '' : 'is-disabled'} ${item.isCore ? 'is-core' : ''}`;
            el.dataset.index = index; el.dataset.id = item.id; el.draggable = this.organizeMode;
            const safeId = this.escapeHtml(item.id);
            const summary = this.escapeHtml(item.content).replace(/\n/g, '<br>');
            el.innerHTML = `<div class="tc-module-index">${String(index + 1).padStart(2, '0')}</div>
                ${this.organizeMode ? `<div class="tc-drag-handle" title="拖动排序" aria-label="拖动排序">⋮⋮</div><input class="tc-item-select" type="checkbox" data-id="${safeId}" ${this.selectedIds.includes(item.id) ? 'checked' : ''}>` : ''}
                <div class="tc-module-main"><div class="tc-module-topline"><h3>${this.escapeHtml(item.name)}</h3>${item.isCore ? '<span class="tc-core-label">CORE</span>' : ''}<span class="tc-module-state"><i></i>${item.enabled ? '启用' : '停用'}</span></div>
                    <p class="tc-module-summary">${summary}</p><div class="tc-module-meta"><span>${this.escapeHtml(positionLabels[item.position] || item.position)}</span><span>${roleLabels[item.role] || this.escapeHtml(item.role)}</span>${item.position === 'in_chat' ? `<span>DEPTH ${Number(item.depth) || 0}</span>` : ''}</div></div>
                <details class="tc-module-more"><summary aria-label="更多操作">···</summary><div class="tc-more-menu">
                    <button class="tc-item-edit-btn" data-id="${safeId}" type="button">编辑</button><button class="tc-item-toggle-action" data-id="${safeId}" type="button">${item.enabled ? '停用' : '启用'}</button>
                    <button class="tc-item-move-top-btn" data-index="${index}" type="button">置顶</button><button class="tc-item-move-up-btn" data-index="${index}" type="button">上移</button><button class="tc-item-move-down-btn" data-index="${index}" type="button">下移</button><button class="tc-item-move-bottom-btn" data-index="${index}" type="button">置底</button><button class="tc-item-duplicate-btn" data-id="${safeId}" type="button">复制</button>
                    ${item.isCore ? '<span class="tc-protected-note">核心模块不可删除</span>' : `<button class="tc-item-delete-btn tc-danger-action" data-id="${safeId}" type="button">删除</button>`}</div></details>`;
            list.appendChild(el);

            if (this.organizeMode) {
                el.addEventListener('dragstart', e => { this.draggedItemId = item.id; e.dataTransfer.effectAllowed = 'move'; el.classList.add('is-dragging'); });
                el.addEventListener('dragend', () => { this.draggedItemId = null; el.classList.remove('is-dragging'); list.querySelectorAll('.tc-module').forEach(card => card.classList.remove('drop-before', 'drop-after')); });
                el.addEventListener('dragover', e => { e.preventDefault(); el.classList.toggle('drop-before', e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2); el.classList.toggle('drop-after', e.clientY >= el.getBoundingClientRect().top + el.offsetHeight / 2); });
                el.addEventListener('drop', e => { e.preventDefault(); const from = this.items.findIndex(i => i.id === this.draggedItemId); if (from < 0 || from === index) return; let to = index + (e.clientY >= el.getBoundingClientRect().top + el.offsetHeight / 2 ? 1 : 0); const moved = this.items.splice(from, 1)[0]; if (from < to) to--; this.items.splice(to, 0, moved); this.syncOrdersFromList(); this.saveData(); this.renderList(); });
                el.querySelector('.tc-item-select').addEventListener('change', e => this.toggleSelection(e.target.dataset.id));
            } else {
                // 浏览模式下，点击卡片直接打开查看/编辑弹窗
                el.addEventListener('click', (e) => {
                    // 如果点击的是右侧更多操作菜单、摘要展开标签或按钮，则不触发整卡点击
                    if (e.target.closest('.tc-module-more') || e.target.closest('button') || e.target.closest('input')) {
                        return;
                    }
                    // 如果用户正在划词选中文本，不触发打开
                    const selection = window.getSelection ? window.getSelection().toString() : '';
                    if (selection && selection.trim().length > 0) {
                        return;
                    }
                    this.openEditor(item.id);
                });
            }
        });
        const addEntry = document.createElement('button');
        addEntry.className = 'tc-add-entry';
        addEntry.type = 'button';
        addEntry.innerHTML = '<span>＋</span><span><strong>新增思考模块</strong><small>创建一个可自由命名、排序与启停的条目</small></span>';
        addEntry.addEventListener('click', () => this.openEditor());
        list.appendChild(addEntry);
        list.querySelectorAll('.tc-item-edit-btn').forEach(btn => btn.addEventListener('click', e => this.openEditor(e.currentTarget.dataset.id)));
        list.querySelectorAll('.tc-item-toggle-action').forEach(btn => btn.addEventListener('click', e => { const item = this.items.find(i => i.id === e.currentTarget.dataset.id); if (item) { item.enabled = !item.enabled; this.saveData(); this.renderList(); } }));
        [['.tc-item-move-top-btn','moveItemTop'],['.tc-item-move-up-btn','moveItemUp'],['.tc-item-move-down-btn','moveItemDown'],['.tc-item-move-bottom-btn','moveItemBottom']].forEach(([selector, method]) => list.querySelectorAll(selector).forEach(btn => btn.addEventListener('click', e => this[method](Number(e.currentTarget.dataset.index)))));
        list.querySelectorAll('.tc-item-duplicate-btn').forEach(btn => btn.addEventListener('click', e => this.duplicateItem(e.currentTarget.dataset.id)));
        list.querySelectorAll('.tc-item-delete-btn').forEach(btn => btn.addEventListener('click', e => { if (confirm('确定要删除这个条目吗？')) { this.items = this.items.filter(i => i.id !== e.currentTarget.dataset.id); this.selectedIds = this.selectedIds.filter(id => id !== e.currentTarget.dataset.id); this.saveData(); this.renderList(); } }));
    },

    openEditor(itemId = null) {
        const modal = document.getElementById('thought-chain-editor-modal');
        const titleEl = document.getElementById('thought-chain-editor-title');
        
        // Reset form
        document.getElementById('tc-name-input').value = '';
        document.getElementById('tc-position-select').value = 'middle';
        document.getElementById('tc-role-select').value = 'system';
        document.getElementById('tc-content-input').value = '';
        document.getElementById('tc-note-input').value = '';
        document.getElementById('tc-depth-input').value = '0';
        document.getElementById('tc-order-input').value = String(this.items.length);
        document.getElementById('tc-enabled-switch').checked = true;
        
        this.currentEditId = null;

        if (itemId) {
            const item = this.items.find(i => i.id === itemId);
            if (item) {
                this.currentEditId = item.id;
                titleEl.textContent = '编辑条目';
                document.getElementById('tc-name-input').value = item.name;
                document.getElementById('tc-position-select').value = item.position;
                document.getElementById('tc-role-select').value = item.role;
                document.getElementById('tc-content-input').value = item.content;
                document.getElementById('tc-note-input').value = item.note || '';
                document.getElementById('tc-depth-input').value = String(item.depth || 0);
                document.getElementById('tc-order-input').value = String(Number(item.order) || 0);
                document.getElementById('tc-enabled-switch').checked = item.enabled;
            }
        } else {
            titleEl.textContent = '添加新条目';
        }

        modal.classList.add('visible');
    },

    closeEditor() {
        const modal = document.getElementById('thought-chain-editor-modal');
        if (modal) {
            modal.classList.remove('visible');
        }
        this.currentEditId = null;
    },

    saveEditorItem() {
        const name = document.getElementById('tc-name-input').value.trim();
        const position = document.getElementById('tc-position-select').value;
        const role = document.getElementById('tc-role-select').value;
        const content = document.getElementById('tc-content-input').value.trim();
        const note = document.getElementById('tc-note-input').value.trim();
        const depth = Math.max(0, parseInt(document.getElementById('tc-depth-input').value, 10) || 0);
        const order = Number(document.getElementById('tc-order-input').value) || 0;
        const enabled = document.getElementById('tc-enabled-switch').checked;

        if (!name || !content) {
            alert('名称和内容不能为空！');
            return;
        }

        if (this.currentEditId) {
            const item = this.items.find(i => i.id === this.currentEditId);
            if (item) {
                item.name = name;
                item.position = position;
                item.role = role;
                item.content = content;
                item.note = note;
                item.depth = depth;
                item.order = order;
                item.enabled = enabled;
            }
        } else {
            const newItem = {
                id: 'tc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                name,
                position,
                role,
                content,
                note,
                depth,
                order,
                enabled
            };

            let insertIndex = this.items.length;
            if (position === 'head') {
                const lastHeadIndex = this.items.map(i => i.position).lastIndexOf('head');
                insertIndex = lastHeadIndex !== -1 ? lastHeadIndex + 1 : 0;
            } else if (position === 'middle') {
                const lastMiddleIndex = this.items.map(i => i.position).lastIndexOf('middle');
                if (lastMiddleIndex !== -1) {
                    insertIndex = lastMiddleIndex + 1;
                } else {
                    const lastHeadIndex = this.items.map(i => i.position).lastIndexOf('head');
                    insertIndex = lastHeadIndex !== -1 ? lastHeadIndex + 1 : 0;
                }
            }
            
            this.items.splice(insertIndex, 0, newItem);
        }

        this.saveData();
        this.renderList();
        this.closeEditor();
        this.loadPresetsDropdown(); // 更新下拉框状态，可能变为"当前配置 (未保存)"
    },

    openToolsModal(title, inputVisible) {
        const modal = document.getElementById('thought-chain-tools-modal');
        const titleEl = document.getElementById('thought-chain-tools-title');
        const input = document.getElementById('thought-chain-test-input');
        const runBtn = document.getElementById('thought-chain-tools-run-btn');
        if (!modal || !titleEl || !input || !runBtn) return;
        titleEl.textContent = title;
        input.hidden = !inputVisible;
        runBtn.hidden = !inputVisible;
        modal.classList.add('visible');
    },

    closeToolsModal() {
        const modal = document.getElementById('thought-chain-tools-modal');
        if (modal) modal.classList.remove('visible');
    },

    openPreviewTool() {
        this.openToolsModal('最终注入预览', false);
        const output = document.getElementById('thought-chain-tools-output');
        if (!output) return;
        const chunks = this.getPayloadChunks();
        const sections = [
            ['头部（合并到主提示词）', chunks.head],
            ['中间（合并到主提示词）', chunks.middle],
            ['聊天记录之前', chunks.before_history],
            ['聊天记录内部', chunks.in_chat],
            ['聊天记录之后', chunks.after_history],
            ['底部 / Assistant 预填', this.behavior.prefillEnabled ? chunks.bottom : []]
        ];
        const lines = [`总开关：${this.enabled ? '开启' : '关闭'}`, `底部 / 预填：${this.behavior.prefillEnabled ? '发送' : '不发送'}`, ''];
        sections.forEach(([title, items]) => {
            lines.push(`【${title}】`);
            if (!items.length) {
                lines.push('（无启用条目）', '');
                return;
            }
            items.forEach(item => {
                lines.push(`- ${item.name} | ${item.role} | depth=${item.depth || 0} | order=${Number(item.order) || 0}`);
                lines.push(item.content);
            });
            lines.push('');
        });
        const unresolved = [...new Set(this.items.flatMap(item => Array.from(item.content.matchAll(/\{\{([^{}]+)\}\}/g), match => match[1].trim())))];
        if (unresolved.length) lines.push(`待运行时展开的变量：${unresolved.join('、')}`);
        output.textContent = lines.join('\n');
    },

    openParserTestTool() {
        this.openToolsModal('测试思考提取规则', true);
        const output = document.getElementById('thought-chain-tools-output');
        if (output) output.textContent = '粘贴模拟返回内容后点击“运行测试”。此操作不会调用模型，也不会写入聊天记录。';
    },

    runParserTest() {
        const input = document.getElementById('thought-chain-test-input');
        const output = document.getElementById('thought-chain-tools-output');
        if (!input || !output) return;
        const result = this.extractReasoning(input.value);
        output.textContent = [
            `匹配数量：${result.matches.length}`,
            result.error ? `配置错误：${result.error}` : '',
            '',
            '【提取出的思考内容】',
            result.reasoning || '（无）',
            '',
            '【交给正文解析器的内容】',
            result.body || '（空）'
        ].filter((line, index) => line || index > 1).join('\n');
    },

    extractReasoning(rawContent) {
        const raw = typeof rawContent === 'string' ? rawContent : String(rawContent ?? '');
        const config = this.behavior || this.defaultBehavior;
        if (!config.extractionEnabled || !raw) return { reasoning: '', body: raw, matches: [], error: null };

        try {
            let source = '';
            if (config.extractionMode === 'regex') {
                if (!config.extractionRegex) return { reasoning: '', body: raw, matches: [], error: '正则表达式为空' };
                source = config.extractionRegex;
            } else {
                const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const start = escapeRegex(config.startMarker || '');
                const end = escapeRegex(config.endMarker || '');
                if (!end) return { reasoning: '', body: raw, matches: [], error: '结束标记为空' };
                const comparisonRaw = config.ignoreCase ? raw.toLowerCase() : raw;
                const comparisonStart = config.ignoreCase ? String(config.startMarker || '').toLowerCase() : String(config.startMarker || '');
                const hasStartMarker = !!comparisonStart && comparisonRaw.includes(comparisonStart);
                if (start && hasStartMarker) source = `${start}([\\s\\S]*?)${end}`;
                else if (config.allowMissingStart) source = `^([\\s\\S]*?)${end}`;
                else if (start) source = `${start}([\\s\\S]*?)${end}`;
                else source = `^([\\s\\S]*?)${end}`;
            }

            let flags = config.ignoreCase ? 'i' : '';
            if (config.extractAll) flags += 'g';
            const regex = new RegExp(source, flags);
            const matches = [];
            if (config.extractAll) {
                let match;
                while ((match = regex.exec(raw)) !== null) {
                    matches.push({ full: match[0], content: (match[1] ?? match[0]).trim() });
                    if (match[0] === '') regex.lastIndex += 1;
                }
            } else {
                const match = regex.exec(raw);
                if (match) matches.push({ full: match[0], content: (match[1] ?? match[0]).trim() });
            }
            let body = raw;
            if (config.removeFromBody) matches.forEach(match => { body = body.replace(match.full, ''); });
            return {
                reasoning: matches.map(match => match.content).filter(Boolean).join('\n\n'),
                body: body.trim(),
                matches,
                error: null
            };
        } catch (error) {
            return { reasoning: '', body: raw, matches: [], error: error.message || String(error) };
        }
    },

    injectIntoMessages(messages) {
        const history = Array.isArray(messages) ? messages.slice() : [];
        let result = history.slice();
        if (!this.enabled) return result;
        const chunks = this.getPayloadChunks();
        const asMessage = item => ({ role: item.role, content: item.content });
        const beforeMessages = chunks.before_history.map(asMessage);
        result = [...beforeMessages, ...result];
        const insertedAnchors = [];
        chunks.in_chat.forEach(item => {
            const depth = Math.max(0, Number(item.depth) || 0);
            const anchor = beforeMessages.length + Math.max(0, history.length - Math.min(depth, history.length));
            const offset = insertedAnchors.filter(existingAnchor => existingAnchor <= anchor).length;
            const index = anchor + offset;
            result.splice(index, 0, asMessage(item));
            insertedAnchors.push(anchor);
        });
        result.push(...chunks.after_history.map(asMessage));
        if (this.behavior.prefillEnabled) result.push(...chunks.bottom.map(asMessage));
        return result;
    },

    getPayloadChunks() {
        if (!this.enabled) return { head: [], middle: [], bottom: [], before_history: [], in_chat: [], after_history: [] };

        const chunks = {
            head: [],
            middle: [],
            bottom: [],
            before_history: [],
            in_chat: [],
            after_history: []
        };

        this.items.forEach(item => {
            if (item.enabled) {
                if (item.position === 'head') chunks.head.push(item);
                else if (item.position === 'middle') chunks.middle.push(item);
                else if (item.position === 'bottom') chunks.bottom.push(item);
                else if (chunks[item.position]) chunks[item.position].push(item);
            }
        });

        Object.values(chunks).forEach(items => items.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)));

        return chunks;
    }
};

document.addEventListener('DOMContentLoaded', () => {
    ThoughtChainManager.init();
});

