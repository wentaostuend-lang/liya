// ============================================================
// smart-sticker-v7.js
// 表情包智能匹配 —— 液态玻璃自定义面板 (V7.9.18 项目内置版)
// 由用户提供的油猴脚本改造而来：去掉 UserScript 外壳直接内嵌进项目，
// 面板改为动态跟随 #chat-input-area 的实际位置（配合 keyboard-fix.js，
// 键盘弹出/收起、输入区域高度变化时都会自动贴上去，不会再被键盘挡住），
// 同时把玻璃质感的不透明度整体调低了一档，观感更"透"。
// ============================================================
(function() {
    'use strict';

    // ================= ✨ 触感引擎 =================
    const haptic = {
        success: () => { if (navigator.vibrate) navigator.vibrate([15, 40, 15]); },
        heavy: () => { if (navigator.vibrate) navigator.vibrate(40); }
    };

    // ================= 1. 终极 CSS 注入 =================
    const style = document.createElement('style');
    style.textContent = `
        /* 🛑 核心：彻底隐藏官方原本的面板 */
        #smart-sticker-match-panel { display: none !important; opacity: 0 !important; pointer-events: none !important; }
        body { padding-bottom: 70px !important; }

        /* ✨ 动态镜面液态面板 */
        #v7-custom-sticker-panel {
          --s-pct: 0;
          display: none;
          position: fixed !important; bottom: 95px; left: 12px !important; right: 12px !important;
          width: auto !important; box-sizing: border-box !important; z-index: 10000 !important;
          padding: 14px !important; pointer-events: auto !important; overflow: visible !important; min-height: 90px !important;
          background-image:
            linear-gradient(105deg,
              rgba(255,255,255,0) calc(var(--s-pct) * 100% - 30%),
              var(--v7-glare-color) calc(var(--s-pct) * 100%),
              rgba(255,255,255,0) calc(var(--s-pct) * 100% + 30%)
            ),
            var(--v7-panel-bg) !important;
          backdrop-filter: blur(18px) saturate(160%) !important; -webkit-backdrop-filter: blur(18px) saturate(160%) !important;
          border: var(--v7-panel-border) !important;
          border-top: var(--v7-panel-border-top) !important;
          border-left: var(--v7-panel-border-left) !important;
          border-radius: 24px !important;
          box-shadow: var(--v7-panel-shadow) !important;
          transform-origin: center bottom !important;
          animation: fluidMorph 0.42s cubic-bezier(0.175, 0.885, 0.32, 1.25) forwards !important;
          will-change: transform, opacity, filter;
        }

        /* 👑 核心秘籍：在面板上方生成一个巨大的【隐形触控结界】 */
        #v7-custom-sticker-panel::after {
          content: '' !important;
          position: absolute !important;
          top: -80px !important; left: -10px !important; right: -10px !important; height: 94px !important;
          background: rgba(255, 255, 255, 0.001) !important;
          pointer-events: auto !important; z-index: 10001 !important;
        }

        /* 流体微光边框闪烁 */
        #v7-custom-sticker-panel::before {
          content: '' !important; position: absolute !important; inset: 0 !important;
          border-radius: 24px !important; pointer-events: none !important; z-index: 10001 !important;
          padding: 2px !important;
          background: var(--v8-shimmer-color) !important;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0) !important;
          -webkit-mask-composite: xor !important;
          mask-composite: exclude !important;
          opacity: 0;
          background-size: 200% 100% !important;
        }
        #v7-custom-sticker-panel.show-shimmer::before {
          animation: borderShimmer 1.2s cubic-bezier(0.25, 1, 0.5, 1) forwards !important;
        }
        #v7-custom-sticker-panel.continuous-mode::before {
          opacity: 1 !important;
          animation: continuousShimmer 2s linear infinite !important;
        }
        @keyframes borderShimmer {
          0% { opacity: 0; background-position: 200% 0; }
          15% { opacity: 1; }
          75% { opacity: 1; }
          100% { opacity: 0; background-position: -200% 0; }
        }
        @keyframes continuousShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes fluidMorph {
          0% { opacity: 0; transform: scaleY(0.2) scaleX(0.6) translateY(20px); filter: blur(4px); }
          70% { transform: scaleY(1.04) scaleX(1.02) translateY(-2px); filter: blur(0); }
          100% { opacity: 1; transform: scaleY(1) scaleX(1) translateY(0); }
        }
        #v7-custom-sticker-panel.v7-collapsing {
          animation: islandCollapse 0.2s cubic-bezier(0.5, 0, 1, 0.5) forwards !important;
          pointer-events: none !important;
        }
        @keyframes islandCollapse {
          0% { opacity: 1; transform: scaleY(1) scaleX(1) translateY(0); filter: blur(0); }
          100% { opacity: 0; transform: scaleY(0.3) scaleX(0.7) translateY(30px); filter: blur(12px); }
        }

        #v7-custom-sticker-grid {
          display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important;
          overflow-x: auto !important; overflow-y: hidden !important; gap: 12px !important;
          padding-bottom: 4px !important; min-height: 65px !important; scrollbar-width: none !important;
          -webkit-overflow-scrolling: touch !important; scroll-behavior: smooth !important;
          scroll-snap-type: x mandatory !important;
        }
        #v7-custom-sticker-grid::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }

        #v7-custom-sticker-grid .sticker-item {
          display: block !important; flex: 0 0 auto !important; width: 65px !important;
          height: 65px !important; object-fit: contain !important; border-radius: 12px !important;
          background: var(--v7-item-bg) !important;
          border: var(--v7-item-border) !important;
          border-top: var(--v7-item-border-top) !important;
          box-shadow: var(--v7-item-shadow) !important;
          transition: transform 0.15s cubic-bezier(0.4, 0, 0.2, 1) !important;
          cursor: pointer;
          scroll-snap-align: center !important;
          user-select: none !important; -webkit-user-select: none !important;
          -webkit-touch-callout: none !important;
        }
        #v7-custom-sticker-grid .sticker-item:active { transform: scale(0.85) !important; }

        #v7-sticker-preview-modal {
          display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.5); backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
          z-index: 999999; align-items: center; justify-content: center; flex-direction: column;
          padding: 20px; box-sizing: border-box; opacity: 0; transition: opacity 0.2s ease;
          user-select: none !important; -webkit-user-select: none !important; -webkit-touch-callout: none !important;
        }
        #v7-sticker-preview-modal.active { display: flex; opacity: 1; }
        #v7-sticker-preview-img {
          max-width: 100%; max-height: 60vh; object-fit: contain; border-radius: 24px;
          box-shadow: 0 30px 60px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.1);
          transform: scale(0.8); transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
          user-select: none !important; -webkit-user-select: none !important; -webkit-touch-callout: none !important; pointer-events: none;
        }
        #v7-sticker-preview-modal.active #v7-sticker-preview-img { transform: scale(1); }
        #v7-sticker-preview-text {
          margin-top: 24px; padding: 10px 20px;
          background: rgba(255, 255, 255, 0.15); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 20px;
          color: #fff; font-size: 15px; font-weight: 500; text-align: center;
          max-width: 80vw; word-break: break-all; overflow-wrap: break-word;
          opacity: 0; transform: translateY(15px); transition: all 0.25s cubic-bezier(0.2, 0.8, 0.2, 1); transition-delay: 0.05s;
          user-select: none !important; -webkit-user-select: none !important; -webkit-touch-callout: none !important; pointer-events: none;
        }
        #v7-sticker-preview-modal.active #v7-sticker-preview-text { opacity: 1; transform: translateY(0); }
    `;
    document.head.appendChild(style);

    // ================= 2. DOM 初始化与全局状态 =================
    const chatInput = document.getElementById('chat-input');

    const previewModal = document.createElement('div');
    previewModal.id = 'v7-sticker-preview-modal';
    previewModal.innerHTML = `
        <img id="v7-sticker-preview-img" src="" />
        <div id="v7-sticker-preview-text"></div>
    `;
    document.body.appendChild(previewModal);
    previewModal.addEventListener('contextmenu', (e) => e.preventDefault());
    previewModal.addEventListener('mousedown', (e) => { e.preventDefault(); previewModal.classList.remove('active'); });
    previewModal.addEventListener('touchstart', (e) => { e.preventDefault(); previewModal.classList.remove('active'); }, { passive: false });

    let myCustomPanel = document.getElementById('v7-custom-sticker-panel');
    let myCustomGrid;
    if (!myCustomPanel) {
        myCustomPanel = document.createElement('div');
        myCustomPanel.id = 'v7-custom-sticker-panel';
        myCustomGrid = document.createElement('div');
        myCustomGrid.id = 'v7-custom-sticker-grid';
        myCustomPanel.appendChild(myCustomGrid);
        document.body.appendChild(myCustomPanel);
    } else {
        myCustomGrid = document.getElementById('v7-custom-sticker-grid');
    }

    // ================= 2.5 新增：面板跟随输入区域实时定位 =================
    // 不再写死 bottom:95px。每次输入区域位置变化（键盘弹出/收起、
    // 回复预览条出现、心声/表情操作栏展开等导致输入区高度变化）时，
    // 都重新计算一次，让面板始终紧贴在 #chat-input-area 正上方。
    let positionRafId = null;
    function syncPanelPosition() {
        const inputArea = document.getElementById('chat-input-area');
        if (!inputArea) return;
        const rect = inputArea.getBoundingClientRect();
        const gap = 8; // 面板和输入区域之间留一点缝隙
        const bottomOffset = Math.max(8, window.innerHeight - rect.top + gap);
        myCustomPanel.style.setProperty('bottom', bottomOffset + 'px', 'important');
    }
    function schedulePositionSync() {
        if (positionRafId) cancelAnimationFrame(positionRafId);
        positionRafId = requestAnimationFrame(syncPanelPosition);
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', schedulePositionSync);
        window.visualViewport.addEventListener('scroll', schedulePositionSync);
    }
    window.addEventListener('resize', schedulePositionSync);
    document.addEventListener('focusin', function(e) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            schedulePositionSync();
            setTimeout(schedulePositionSync, 320); // 键盘弹出动画有延迟，再修正一次
        }
    }, true);
    document.addEventListener('focusout', function(e) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            setTimeout(schedulePositionSync, 320);
        }
    }, true);
    // 输入区域自身尺寸变化（比如出现回复预览条）也要跟着重新定位
    const inputAreaObserver = new MutationObserver(schedulePositionSync);
    document.addEventListener('DOMContentLoaded', () => {
        const inputArea = document.getElementById('chat-input-area');
        if (inputArea) {
            inputAreaObserver.observe(inputArea, { attributes: true, childList: true, subtree: true });
        }
    });
    // 万一 DOMContentLoaded 已经过了（脚本较晚执行），立刻尝试一次
    (function tryObserveNow() {
        const inputArea = document.getElementById('chat-input-area');
        if (inputArea) {
            inputAreaObserver.observe(inputArea, { attributes: true, childList: true, subtree: true });
        }
    })();

    // ================= 3. 连发模式：长按面板空白处 0.6 秒开启/关闭 =================
    let isContinuousMode = false;
    let continuousLongPressTimer = null;
    let continuousTouchStartX = 0;
    let continuousTouchStartY = 0;

    const toggleContinuousMode = () => {
        isContinuousMode = !isContinuousMode;
        if (isContinuousMode) {
            haptic.heavy();
            myCustomPanel.classList.add('continuous-mode');
            if (chatInput) {
                chatInput.setAttribute('readonly', 'true');
                chatInput.blur();
            }
        } else {
            haptic.success();
            myCustomPanel.classList.remove('continuous-mode');
            if (chatInput) {
                chatInput.removeAttribute('readonly');
            }
            if (chatInput && !chatInput.value.trim()) {
                closePanelSmoothly();
            }
        }
    };

    myCustomPanel.addEventListener('touchstart', (e) => {
        if (e.target.closest('.sticker-item')) return;
        continuousTouchStartX = e.touches[0].clientX;
        continuousTouchStartY = e.touches[0].clientY;
        continuousLongPressTimer = setTimeout(() => {
            haptic.heavy();
            toggleContinuousMode();
        }, 600);
    }, { passive: true });

    myCustomPanel.addEventListener('touchmove', (e) => {
        if (!continuousLongPressTimer) return;
        const dx = Math.abs(e.touches[0].clientX - continuousTouchStartX);
        const dy = Math.abs(e.touches[0].clientY - continuousTouchStartY);
        if (dx > 10 || dy > 10) {
            clearTimeout(continuousLongPressTimer);
            continuousLongPressTimer = null;
        }
    }, { passive: true });

    myCustomPanel.addEventListener('touchend', () => {
        clearTimeout(continuousLongPressTimer);
        continuousLongPressTimer = null;
    }, { passive: true });

    myCustomPanel.addEventListener('touchcancel', () => {
        clearTimeout(continuousLongPressTimer);
        continuousLongPressTimer = null;
    }, { passive: true });

    if (chatInput) {
        chatInput.addEventListener('blur', () => {
            setTimeout(() => {
                const scrollPos = document.documentElement.scrollTop || document.body.scrollTop;
                window.scrollTo({ top: Math.max(scrollPos - 1, 0), behavior: 'instant' });
            }, 50);
        });
    }

    myCustomPanel.addEventListener('mousedown', (e) => {
        if (e.target === myCustomPanel || e.target === myCustomGrid) {
            e.preventDefault();
        }
    });

    let scrollTicking = false;
    myCustomGrid.addEventListener('scroll', () => {
        if (!scrollTicking) {
            window.requestAnimationFrame(() => {
                const maxScroll = myCustomGrid.scrollWidth - myCustomGrid.clientWidth;
                const scrollPct = maxScroll > 0 ? (myCustomGrid.scrollLeft / maxScroll) : 0;
                myCustomPanel.style.setProperty('--s-pct', scrollPct.toFixed(3));
                scrollTicking = false;
            });
            scrollTicking = true;
        }
    }, { passive: true });

    function closePanelSmoothly() {
        if (myCustomPanel.style.display === 'none' || myCustomPanel.classList.contains('v7-collapsing')) return;
        myCustomPanel.classList.add('v7-collapsing');
        setTimeout(() => {
            myCustomPanel.style.display = 'none';
            myCustomPanel.classList.remove('v7-collapsing');
            myCustomPanel.classList.remove('show-shimmer');
            isContinuousMode = false;
            myCustomPanel.classList.remove('continuous-mode');
            if (chatInput) chatInput.removeAttribute('readonly');
        }, 200);
    }

    // ================= 主题校准（液态玻璃重制版 —— 更透明档位） =================
    const targetScreen = document.getElementById('phone-screen') || document.body;

    function applyDynamicTheme() {
        if (!myCustomPanel) return;
        const isDark = targetScreen.classList.contains('dark-mode') || targetScreen.getAttribute('theme') === 'dark';

        if (isDark) {
            // 暗色：调低了整体不透明度，加大了模糊，玻璃感更透
            myCustomPanel.style.setProperty('--v7-glare-color', 'rgba(255,255,255,0.10)');
            myCustomPanel.style.setProperty('--v7-panel-bg', 'linear-gradient(160deg, rgba(60,60,70,0.45) 0%, rgba(25,25,32,0.30) 100%)');
            myCustomPanel.style.setProperty('--v7-panel-border', '1px solid rgba(255,255,255,0.05)');
            myCustomPanel.style.setProperty('--v7-panel-border-top', '0.8px solid rgba(255,255,255,0.18)');
            myCustomPanel.style.setProperty('--v7-panel-border-left', '0.8px solid rgba(255,255,255,0.08)');
            myCustomPanel.style.setProperty('--v7-panel-shadow',
                '0 20px 50px rgba(0,0,0,0.5), ' +
                '0 4px 16px rgba(0,0,0,0.3), ' +
                'inset 0 0.5px 0 rgba(255,255,255,0.14), ' +
                'inset 0 -1px 0 rgba(0,0,0,0.22)'
            );
            myCustomPanel.style.setProperty('--v7-item-bg', 'linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))');
            myCustomPanel.style.setProperty('--v7-item-border', '1px solid rgba(255,255,255,0.06)');
            myCustomPanel.style.setProperty('--v7-item-border-top', '1px solid rgba(255,255,255,0.14)');
            myCustomPanel.style.setProperty('--v7-item-shadow', 'inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 6px rgba(0,0,0,0.4)');
            myCustomPanel.style.setProperty('--v8-shimmer-color', 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0) 100%)');
        } else {
            // 亮色：同样调低不透明度，加大模糊，让"透"的感觉更明显
            myCustomPanel.style.setProperty('--v7-glare-color', 'rgba(255,255,255,0.70)');
            myCustomPanel.style.setProperty('--v7-panel-bg', 'linear-gradient(160deg, rgba(255,255,255,0.38) 0%, rgba(240,242,248,0.18) 100%)');
            myCustomPanel.style.setProperty('--v7-panel-border', '1px solid rgba(255,255,255,0.35)');
            myCustomPanel.style.setProperty('--v7-panel-border-top', '0.8px solid rgba(255,255,255,0.75)');
            myCustomPanel.style.setProperty('--v7-panel-border-left', '0.8px solid rgba(255,255,255,0.55)');
            myCustomPanel.style.setProperty('--v7-panel-shadow',
                '0 12px 40px rgba(0,0,0,0.08), ' +
                '0 4px 12px rgba(0,0,0,0.05), ' +
                'inset 0 0.5px 0 rgba(255,255,255,0.80), ' +
                'inset 0 -1px 0 rgba(0,0,0,0.02), ' +
                'inset 1px 0 0 rgba(255,255,255,0.45)'
            );
            myCustomPanel.style.setProperty('--v7-item-bg', 'linear-gradient(145deg, rgba(255,255,255,0.42), rgba(255,255,255,0.10))');
            myCustomPanel.style.setProperty('--v7-item-border', '1px solid rgba(255,255,255,0.38)');
            myCustomPanel.style.setProperty('--v7-item-border-top', '0.8px solid rgba(255,255,255,0.65)');
            myCustomPanel.style.setProperty('--v7-item-shadow', 'inset 0 0.5px 0 rgba(255,255,255,0.65), 0 2px 6px rgba(0,0,0,0.05)');
            myCustomPanel.style.setProperty('--v8-shimmer-color', 'linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.85) 50%, rgba(255,255,255,0) 100%)');
        }
    }
    applyDynamicTheme();
    const nightObserver = new MutationObserver(() => { applyDynamicTheme(); });
    nightObserver.observe(targetScreen, { attributes: true, attributeFilter: ['class', 'theme'] });

    // ================= 4. 数据统计 =================
    const USAGE_KEY = 'ephone_sticker_usage_v7';
    let stickerStats = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
    function recordUsage(name) { if(name){ stickerStats[name] = (stickerStats[name] || 0) + 1; localStorage.setItem(USAGE_KEY, JSON.stringify(stickerStats)); } }
    function getUsageScore(name) { return stickerStats[name] || 0; }

    // ================= 5. 输入框与核心逻辑 =================
    if (!chatInput) return;

    chatInput.addEventListener('keyup', () => {
        if (!chatInput.value.trim() && !isContinuousMode) closePanelSmoothly();
    });

    let customDebounceTimer = null;
    chatInput.addEventListener('input', () => {
        if (customDebounceTimer) clearTimeout(customDebounceTimer);
        customDebounceTimer = setTimeout(() => forceRenderAllStickers(), 350);
    });

    function forceRenderAllStickers() {
        if (!window.state || !window.state.activeChatId || !window.state.chats) return;
        const chat = window.state.chats[window.state.activeChatId];
        if (!chat || !chat.settings.enableStickerSmartMatch) return;

        const inputText = chatInput.value.trim().toLowerCase();
        if (!inputText) {
            if (!isContinuousMode) closePanelSmoothly();
            return;
        }

        const categoryId = chat.settings.stickerCategoryId;
        let availableStickers = categoryId ? window.state.userStickers.filter(s => s.categoryId === categoryId) : window.state.userStickers;
        if (!availableStickers || availableStickers.length === 0) return;

        const matches = [];
        const keywords = inputText.split(/\s+/);
        availableStickers.forEach(sticker => {
            if (!sticker.name) return;
            const stickerName = sticker.name.toLowerCase();
            let score = 0;
            keywords.forEach(keyword => { if (stickerName.includes(keyword)) score += keyword.length; });
            if (stickerName === inputText) score += 100;
            if (stickerName.includes(inputText)) score += 50;
            if (score > 0) matches.push({ sticker, score });
        });

        matches.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return getUsageScore(b.sticker.name) - getUsageScore(a.sticker.name);
        });

        if (matches.length === 0) {
            if (!isContinuousMode) closePanelSmoothly();
            return;
        }

        myCustomGrid.innerHTML = '';
        matches.forEach(({ sticker }) => {
            const stickerItem = document.createElement('div');
            stickerItem.className = 'sticker-item';
            stickerItem.innerHTML = `<div style="background-image: url('${sticker.url}'); width: 100%; height: 100%; background-size: contain; background-position: center; background-repeat: no-repeat;"></div>`;
            stickerItem.addEventListener('contextmenu', (e) => e.preventDefault());

            let pressTimer = null;
            let isLongPressing = false;
            let touchStartX = 0, touchStartY = 0, isDragging = false;

            const executeSendSticker = () => {
                const msg = { role: 'user', type: 'sticker', content: sticker.url, meaning: sticker.name, timestamp: Date.now() };
                if (typeof window.appendMessage === 'function') {
                    window.appendMessage(msg, chat); chat.history.push(msg);
                    if(window.db && window.db.chats) window.db.chats.put(chat);
                    if(typeof window.renderChatList === 'function') window.renderChatList();
                    const messages = document.querySelector('#chat-interface-screen #chat-messages');
                    if (messages) {
                        setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 50);
                        setTimeout(() => { messages.scrollTop = messages.scrollHeight; }, 150);
                    }
                }
                recordUsage(sticker.name);
                if (!isContinuousMode) {
                    haptic.success();
                    chatInput.value = '';
                    chatInput.style.height = 'auto';
                    closePanelSmoothly();
                    myCustomPanel.style.setProperty('--s-pct', 0);
                } else {
                    haptic.heavy();
                    if (chatInput) chatInput.blur();
                }
            };

            const startPress = () => {
                isLongPressing = false;
                pressTimer = setTimeout(() => {
                    isLongPressing = true;
                    document.getElementById('v7-sticker-preview-img').src = sticker.url;
                    document.getElementById('v7-sticker-preview-text').textContent = sticker.name || '未命名表情';
                    previewModal.classList.add('active'); haptic.heavy();
                }, 400);
            };
            const cancelPress = () => { clearTimeout(pressTimer); previewModal.classList.remove('active'); };

            stickerItem.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startPress();
            });
            stickerItem.addEventListener('click', (e) => {
                cancelPress();
                if (isLongPressing) { e.preventDefault(); e.stopPropagation(); isLongPressing = false; return; }
                executeSendSticker();
            });
            stickerItem.addEventListener('mouseleave', cancelPress);

            stickerItem.addEventListener('touchstart', (e) => {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                isDragging = false;
                startPress();
            }, { passive: true });
            stickerItem.addEventListener('touchmove', (e) => {
                const dx = Math.abs(e.touches[0].clientX - touchStartX);
                const dy = Math.abs(e.touches[0].clientY - touchStartY);
                if (dx > 10 || dy > 10) { isDragging = true; cancelPress(); }
            }, { passive: true });
            stickerItem.addEventListener('touchend', (e) => {
                cancelPress();
                if (!isDragging) {
                    e.preventDefault();
                    if (!isLongPressing) {
                        executeSendSticker();
                    } else {
                        isLongPressing = false;
                    }
                }
            });
            stickerItem.addEventListener('touchcancel', cancelPress);

            myCustomGrid.appendChild(stickerItem);
        });

        if (myCustomPanel.style.display !== 'block') {
            myCustomPanel.classList.remove('v7-collapsing');
            myCustomPanel.classList.remove('show-shimmer');
            void myCustomPanel.offsetWidth;
            myCustomPanel.style.display = 'block';
            if (!isContinuousMode) {
                myCustomPanel.classList.add('show-shimmer');
            }
        }

        applyDynamicTheme();
        myCustomPanel.style.setProperty('--s-pct', 0);
        myCustomGrid.scrollLeft = 0;

        // 面板刚渲染出来时，立刻贴一次位置
        schedulePositionSync();
    }
})();
