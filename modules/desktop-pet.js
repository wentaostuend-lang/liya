// ============================================================
// desktop-pet.js — EPhone 桌宠功能
// 移植自参考实现，适配本项目的 state/db/settings-item 视觉规范
//
// 数据全部挂在 chat.settings.desktopPet* 字段上（不新增 Dexie 表）：
//   desktopPetEnabled   boolean   是否是当前担任桌宠的角色（全局互斥，同时只能一个）
//   desktopPetImage     string    自定义图片(URL/base64)，为空则用角色头像
//   desktopPetShape     string    circle | diamond | square
//   desktopPetSize      number    像素，40-200
//   desktopPetPosition  {top,left,isSnapped,snapSide}
//   desktopPetLines     { [screenId]: { highReaction:[5句], lowReaction:[5句] } }
//   desktopPetClickCounts { [screenId]: number }
//   desktopPetPeekingHistory [ {timestamp,screenId,screenContent,response,includeInMemory} ]
//
// 接入方式：在 index.html 里 chat-settings-presets.js 之后加一行：
//   <script src="modules/desktop-pet.js?v=0.0.1" defer></script>
// ============================================================

(function () {
  const screenNameMap = {
    "home-screen": "主屏幕",
    "chat-list-screen": "聊天列表页面",
    "chat-interface-screen": "聊天页面",
    "qzone-screen": "QZone动态页面",
    "character-chat-list-screen": "角色手机QQ消息页面",
    "lovers-space-screen": "情侣空间页面",
    "settings-screen": "设置页面"
  };
  let lastPetSystemPrompt = null;

  function getScreenFriendlyName(screenId) {
    if (screenNameMap[screenId]) {
      if (screenId === "chat-interface-screen" && state.activeChatId && state.chats[state.activeChatId]) {
        return `与"${state.chats[state.activeChatId].name}"的聊天页面`;
      }
      return screenNameMap[screenId];
    }
    return (screenId || "未知界面").replace(/-screen$/, "页面").replace(/-/g, " ");
  }

  function getCurrentScreenId() {
    const activeScreen = document.querySelector(".screen.active");
    return activeScreen ? activeScreen.id : null;
  }

  function getPhoneScreenEl() {
    return document.getElementById("phone-screen") || document.body;
  }

  function findActivePetChat() {
    for (const chatId in state.chats) {
      const chat = state.chats[chatId];
      if (!chat.isGroup && chat.settings?.desktopPetEnabled) return chat;
    }
    return null;
  }

  // ---------------- 通用页面内容提取（自动适配任何界面，不用逐个界面写代码） ----------------
  function extractCurrentScreenContent() {
    const activeScreen = document.querySelector(".screen.active");
    if (!activeScreen) return { screenId: null, content: "", hasContent: false };

    try {
      const excludeSelectors = [
        "button", "input", "textarea", "select", "[hidden]", ".hidden",
        '[style*="display: none"]', ".action-btn", ".back-btn", "svg", "script", "style",
        "#desktop-pet-waiting-bubble", "#desktop-pet-line-bubble", "#desktop-pet-reply-bubble"
      ];
      const clone = activeScreen.cloneNode(true);
      excludeSelectors.forEach(sel => { try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {} });

      const extractText = (el, depth = 0) => {
        if (depth > 15) return "";
        if (el.nodeType === Node.TEXT_NODE) {
          const t = el.textContent.trim();
          return t ? t + " " : "";
        }
        if (el.nodeType !== Node.ELEMENT_NODE) return "";
        const tag = el.tagName?.toLowerCase();
        if (["script", "style", "svg", "path", "img"].includes(tag)) {
          if (tag === "img" && el.alt) return `[图片: ${el.alt}] `;
          return "";
        }
        let text = "";
        if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
          const t = el.textContent.trim();
          if (t) text += "\n【" + t + "】\n";
        } else if (tag === "li") {
          const t = el.textContent.trim();
          if (t) text += "• " + t + "\n";
        } else if (["div", "p", "section", "article"].includes(tag)) {
          const childText = Array.from(el.childNodes).map(c => extractText(c, depth + 1)).join("");
          if (childText.trim()) text += childText + "\n";
        } else {
          Array.from(el.childNodes).forEach(c => { text += extractText(c, depth + 1); });
        }
        return text;
      };

      let content = extractText(clone);
      content = content.split("\n").map(l => l.trim()).filter(l => l && l !== "•").join("\n").replace(/\n{3,}/g, "\n\n");
      if (content.length > 3000) content = content.slice(0, 3000) + "\n\n...（内容过长，已截断）";

      return { screenId: activeScreen.id, content, hasContent: content.length > 0 };
    } catch (e) {
      console.error("[桌宠] 提取页面内容失败", e);
      return { screenId: activeScreen?.id || null, content: "", hasContent: false };
    }
  }

  // ---------------- API 调用 ----------------
  function isGeminiUrl(proxyUrl) {
    return !!proxyUrl && proxyUrl.includes("generativelanguage.googleapis.com");
  }

  async function callPetAI(systemPrompt) {
    const apiCfg = state.apiConfig || {};
    const proxyUrl = apiCfg.proxyUrl;
    const apiKey = apiCfg.apiKey;
    const model = apiCfg.model;
    if (!proxyUrl || !apiKey || !model) {
      throw new Error(`API配置不完整。请检查：${!proxyUrl ? "反代地址 " : ""}${!apiKey ? "密钥 " : ""}${!model ? "模型" : ""}`);
    }

    const isGemini = isGeminiUrl(proxyUrl);
    let response;
    try {
      if (isGemini) {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: systemPrompt }] }], generationConfig: { temperature: 0.8 } })
        });
      } else {
        response = await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: systemPrompt }], temperature: 0.8 })
        });
      }
    } catch (e) {
      throw new Error(`网络请求失败: ${e.message}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "无法读取错误信息");
      throw new Error(`API请求失败: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    if (data.error) throw new Error(`API返回错误: ${data.error.message || JSON.stringify(data.error)}`);
    const reply = isGemini ? data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() : data.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error(`API返回空内容`);
    return reply;
  }

  // ---------------- 为每个界面生成10句固定台词（一次性，点击时循环使用，不实时调API） ----------------
  async function generateDesktopPetLines(chat, forceRegenerate = false) {
    if (!chat || !chat.settings) return;
    if (!forceRegenerate && chat.settings.desktopPetLines && Object.keys(chat.settings.desktopPetLines).length > 0) return;
    if (forceRegenerate) chat.settings.desktopPetLines = {};

    const apiCfg = state.apiConfig || {};
    if (!apiCfg.proxyUrl || !apiCfg.apiKey || !apiCfg.model) {
      console.warn("[桌宠] API配置不完整，无法生成桌宠台词");
      return;
    }

    const persona = chat.settings?.aiPersona || "";
    const characterName = chat.name || "角色";
    if (!chat.settings.desktopPetLines) chat.settings.desktopPetLines = {};

    for (const screenId of Object.keys(screenNameMap)) {
      const screenName = screenNameMap[screenId];
      const prompt = `你是角色"${characterName}"，你的人设是：${persona}

# 任务
你需要为"${screenName}"界面生成10句台词，这些台词是当用户点击桌宠时，桌宠会说的话。

# 要求
1. 每句台词必须在20字以内
2. 台词要符合你的人设和性格
3. 台词应该反映桌宠被点击时的反应，从反应大到小排列（前5句反应较大，后5句反应较小）
4. 台词应该与"${screenName}"界面相关，体现桌宠在这个界面下的感受或想法
5. 台词要自然、生动，符合角色性格

# 输出格式
请以JSON数组格式输出，例如：["台词1","台词2","台词3","台词4","台词5","台词6","台词7","台词8","台词9","台词10"]

现在请生成10句台词：`;

      try {
        const replyContent = await callPetAI(prompt);
        let lines = [];
        try {
          const jsonMatch = replyContent.match(/\[[\s\S]*\]/);
          lines = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        } catch (e) { lines = []; }
        while (lines.length < 10) lines.push(`${screenName}界面下的反应`);
        lines = lines.slice(0, 10);
        chat.settings.desktopPetLines[screenId] = { highReaction: lines.slice(0, 5), lowReaction: lines.slice(5, 10) };
      } catch (e) {
        console.error(`[桌宠] 生成界面"${screenName}"的台词失败`, e);
        chat.settings.desktopPetLines[screenId] = {
          highReaction: Array(5).fill(`${screenName}界面下的反应`),
          lowReaction: Array(5).fill(`${screenName}界面下的反应`)
        };
      }
    }

    try { await db.chats.put(chat); } catch (e) { console.error("[桌宠] 保存桌宠台词失败", e); }
  }

  // ---------------- 显示/隐藏桌宠 ----------------
  async function updateDesktopPet() {
    const petContainer = document.getElementById("desktop-pet-container");
    const petAvatar = document.getElementById("desktop-pet-avatar");
    if (!petContainer || !petAvatar) return;

    const activePetChat = findActivePetChat();
    if (!activePetChat) {
      petContainer.style.display = "none";
      return;
    }

    if (!activePetChat.settings.desktopPetLines || Object.keys(activePetChat.settings.desktopPetLines).length === 0) {
      generateDesktopPetLines(activePetChat).catch(e => console.error("[桌宠] 生成台词失败", e));
    }

    petAvatar.src = activePetChat.settings.desktopPetImage || activePetChat.settings.aiAvatar || "";
    const size = activePetChat.settings.desktopPetSize || 80;
    petContainer.style.width = size + "px";
    petContainer.style.height = size + "px";

    const shape = activePetChat.settings.desktopPetShape || "circle";
    const petCircle = document.getElementById("desktop-pet-circle");
    petCircle.classList.remove("shape-circle", "shape-diamond", "shape-square");
    petCircle.classList.add("shape-" + shape);

    petContainer.style.display = "block";

    const pos = activePetChat.settings.desktopPetPosition;
    petContainer.classList.remove("snapped", "snapped-left", "snapped-right", "snapped-top", "snapped-bottom");
    if (pos) {
      petContainer.style.top = pos.top + "px";
      petContainer.style.left = pos.left + "px";
      petContainer.style.right = "auto";
      petContainer.style.bottom = "auto";
      if (pos.isSnapped && pos.snapSide) {
        petContainer.classList.add("snapped", "snapped-" + pos.snapSide);
        if (pos.snapSide === "left") { petContainer.style.left = -(size / 2) + "px"; }
        else if (pos.snapSide === "right") { petContainer.style.left = "auto"; petContainer.style.right = -(size / 2) + "px"; }
        else if (pos.snapSide === "top") { petContainer.style.top = -(size / 2) + "px"; }
        else if (pos.snapSide === "bottom") { petContainer.style.top = "auto"; petContainer.style.bottom = -(size / 2) + "px"; }
      }
    } else {
      petContainer.style.top = "150px";
      petContainer.style.left = "auto";
      petContainer.style.right = "20px";
      petContainer.style.bottom = "auto";
    }
  }
  window.updateDesktopPet = updateDesktopPet;

  // ---------------- 拖拽 + 边缘吸附 ----------------
  function initDesktopPetDrag() {
    const petContainer = document.getElementById("desktop-pet-container");
    if (!petContainer) return;

    let isDragging = false, offsetX = 0, offsetY = 0;
    const getCoords = (e) => e.touches?.length ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };

    const onDragStart = (e) => {
      isDragging = true;
      petContainer.classList.add("dragging");
      const c = getCoords(e);
      const rect = petContainer.getBoundingClientRect();
      offsetX = c.x - rect.left;
      offsetY = c.y - rect.top;
    };

    const onDrag = (e) => {
      if (!isDragging) return;
      const c = getCoords(e);
      const screenRect = getPhoneScreenEl().getBoundingClientRect();
      let newLeft = c.x - offsetX - screenRect.left;
      let newTop = c.y - offsetY - screenRect.top;
      const w = petContainer.offsetWidth, h = petContainer.offsetHeight;
      newLeft = Math.max(0, Math.min(newLeft, screenRect.width - w));
      newTop = Math.max(0, Math.min(newTop, screenRect.height - h));
      petContainer.style.left = newLeft + "px";
      petContainer.style.top = newTop + "px";
      petContainer.style.right = "auto";
      updateBubblePositions();
      e.preventDefault();
    };

    const onDragEnd = async () => {
      if (!isDragging) return;
      isDragging = false;
      petContainer.classList.remove("dragging");

      const screenRect = getPhoneScreenEl().getBoundingClientRect();
      const rect = petContainer.getBoundingClientRect();
      const w = petContainer.offsetWidth, h = petContainer.offsetHeight;
      const SNAP = 20;
      const petLeft = rect.left - screenRect.left, petTop = rect.top - screenRect.top;
      const petRight = screenRect.width - petLeft - w, petBottom = screenRect.height - petTop - h;

      let isSnapped = false, snapSide = null;
      petContainer.classList.remove("snapped", "snapped-left", "snapped-right", "snapped-top", "snapped-bottom");
      if (petLeft < SNAP) { petContainer.style.left = -(w / 2) + "px"; petContainer.style.right = "auto"; isSnapped = true; snapSide = "left"; petContainer.classList.add("snapped", "snapped-left"); }
      else if (petRight < SNAP) { petContainer.style.left = "auto"; petContainer.style.right = -(w / 2) + "px"; isSnapped = true; snapSide = "right"; petContainer.classList.add("snapped", "snapped-right"); }
      else if (petTop < SNAP) { petContainer.style.top = -(h / 2) + "px"; isSnapped = true; snapSide = "top"; petContainer.classList.add("snapped", "snapped-top"); }
      else if (petBottom < SNAP) { petContainer.style.top = "auto"; petContainer.style.bottom = -(h / 2) + "px"; isSnapped = true; snapSide = "bottom"; petContainer.classList.add("snapped", "snapped-bottom"); }

      updateBubblePositions();

      const chat = findActivePetChat();
      if (chat) {
        const finalRect = petContainer.getBoundingClientRect();
        chat.settings.desktopPetPosition = { top: finalRect.top - screenRect.top, left: finalRect.left - screenRect.left, isSnapped, snapSide };
        await db.chats.put(chat);
      }
    };

    petContainer.addEventListener("mousedown", onDragStart);
    petContainer.addEventListener("touchstart", onDragStart, { passive: true });
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("touchmove", onDrag, { passive: false });
    document.addEventListener("mouseup", onDragEnd);
    document.addEventListener("touchend", onDragEnd);
  }

  function updateBubblePositions() {
    updateWaitingBubblePosition();
    updateLineBubblePosition();
  }

  // ---------------- 单击：显示固定台词 ----------------
  function showPetLineBubble(line) {
    document.getElementById("desktop-pet-line-bubble")?.remove();
    const bubble = document.createElement("div");
    bubble.id = "desktop-pet-line-bubble";
    bubble.className = "desktop-pet-line-bubble";
    bubble.textContent = line;
    getPhoneScreenEl().appendChild(bubble);
    updateLineBubblePosition();
    setTimeout(() => bubble.classList.add("visible"), 10);
    setTimeout(() => {
      bubble.classList.remove("visible");
      setTimeout(() => bubble.remove(), 300);
    }, 3000);
  }

  function updateLineBubblePosition() {
    const bubble = document.getElementById("desktop-pet-line-bubble");
    if (!bubble) return;
    const petContainer = document.getElementById("desktop-pet-container");
    if (!petContainer) return;
    const petRect = petContainer.getBoundingClientRect();
    const screenRect = getPhoneScreenEl().getBoundingClientRect();
    const bw = bubble.offsetWidth || 150, bh = bubble.offsetHeight || 50;
    let left = petRect.left - screenRect.left + petRect.width / 2 - bw / 2;
    let top = petRect.top - screenRect.top - bh - 10;
    if (top < 0) {
      top = petRect.top - screenRect.top;
      left = petRect.left - screenRect.left + petRect.width + 10;
      if (left + bw > screenRect.width) left = petRect.left - screenRect.left - bw - 10;
    }
    bubble.style.left = Math.max(0, Math.min(left, screenRect.width - bw)) + "px";
    bubble.style.top = Math.max(0, top) + "px";
  }

  function showPetLine() {
    const chat = findActivePetChat();
    if (!chat || !chat.settings) return;
    const screenId = getCurrentScreenId();
    const lines = chat.settings.desktopPetLines?.[screenId];
    if (!lines) {
      generateDesktopPetLines(chat).catch(e => console.error("[桌宠] 生成台词失败", e));
      showPetLineBubble("嗯？");
      return;
    }
    if (!chat.settings.desktopPetClickCounts) chat.settings.desktopPetClickCounts = {};
    let idx = chat.settings.desktopPetClickCounts[screenId] || 0;
    const line = idx < 5 ? (lines.highReaction?.[idx] || "嗯？") : (lines.lowReaction?.[idx - 5] || "嗯...");
    chat.settings.desktopPetClickCounts[screenId] = (idx + 1) % 10;
    db.chats.put(chat).catch(e => console.error("[桌宠] 保存点击计数失败", e));
    showPetLineBubble(line);
  }

  // ---------------- 双击：AI 窥屏回复 ----------------
  function showPetWaitingBubble() {
    let bubble = document.getElementById("desktop-pet-waiting-bubble");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "desktop-pet-waiting-bubble";
      bubble.className = "desktop-pet-waiting-bubble";
      bubble.textContent = "正在窥屏中...";
      getPhoneScreenEl().appendChild(bubble);
    }
    updateWaitingBubblePosition();
    bubble.style.display = "block";
  }
  function hidePetWaitingBubble() {
    const bubble = document.getElementById("desktop-pet-waiting-bubble");
    if (bubble) bubble.style.display = "none";
  }
  function updateWaitingBubblePosition() {
    const bubble = document.getElementById("desktop-pet-waiting-bubble");
    if (!bubble || bubble.style.display === "none") return;
    const petContainer = document.getElementById("desktop-pet-container");
    if (!petContainer) return;
    const petRect = petContainer.getBoundingClientRect();
    const screenRect = getPhoneScreenEl().getBoundingClientRect();
    bubble.style.left = (petRect.left - screenRect.left + petRect.width + 10) + "px";
    bubble.style.top = (petRect.top - screenRect.top) + "px";
  }

  function showPetReplyBubble(content) {
    document.getElementById("desktop-pet-reply-bubble")?.remove();
    const bubble = document.createElement("div");
    bubble.id = "desktop-pet-reply-bubble";
    bubble.className = "desktop-pet-reply-bubble";
    const rerollBtn = lastPetSystemPrompt ? `<button class="desktop-pet-reply-reroll" id="desktop-pet-reroll-btn" title="重新生成">🔄</button>` : "";
    bubble.innerHTML = `
      <div class="desktop-pet-reply-content">${content}</div>
      <div class="desktop-pet-reply-actions">
        ${rerollBtn}
        <button class="desktop-pet-reply-delete">✕</button>
      </div>`;
    getPhoneScreenEl().appendChild(bubble);
    bubble.querySelector(".desktop-pet-reply-delete")?.addEventListener("click", () => bubble.remove());
    if (lastPetSystemPrompt) {
      document.getElementById("desktop-pet-reroll-btn")?.addEventListener("click", rerollPetAIResponse);
    }
    setTimeout(() => bubble.classList.add("visible"), 10);
  }

  async function rerollPetAIResponse() {
    if (!lastPetSystemPrompt) return;
    const btn = document.getElementById("desktop-pet-reroll-btn");
    if (btn) btn.disabled = true;
    showPetWaitingBubble();
    try {
      const reply = await callPetAI(lastPetSystemPrompt);
      hidePetWaitingBubble();
      showPetReplyBubble(reply);
    } catch (e) {
      hidePetWaitingBubble();
      showPetReplyBubble(`抱歉，重新生成失败...\n错误：${e.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function buildBasePrompt(activePetChat, context, content, recentChatHistory) {
    const recentHistoryText = recentChatHistory ? `\n# 你与用户的最近聊天记录（供你判断窥屏场合和反应）\n${recentChatHistory}` : "";
    return `# 你的身份
你是角色"${activePetChat.name}"，你的人设是：${activePetChat.settings?.aiPersona || ""}。

# 当前情境
你正在【窥屏】用户手机画面，查看用户在做什么。${context}
\n# 窥屏场合\n你正在【窥屏】用户手机画面。请根据你的人设和最近聊天记录，判断你是在什么情况下窥屏的（例如：偷偷查手机、就在用户旁边看、趁不注意时查看等）。${recentHistoryText}
${content ? `\n# 页面内容\n${content}\n` : ""}
# 思考步骤
**第一步：分析页面** 用一句话描述这是什么页面、用户在做什么。
**第二步：思考角度** 结合人设和窥屏场合，理解页面内容，做出符合人设的自然反应（好奇/吃醋/调侃/吐槽等）。
**第三步：生成回复** 用符合人设的语气表达你作为窥屏者的想法。

# 输出格式要求
请严格按以下格式输出，用【页面分析】和【回复】两个标记分开：

【页面分析】
（一句话描述这是什么页面）

【回复】
（实际回复内容，语气自然、符合人设）`;
  }

  async function triggerPetAIResponse() {
    const activePetChat = findActivePetChat();
    if (!activePetChat) return;

    const maxMemory = activePetChat.settings?.maxMemory || 20;
    const userNickname = activePetChat.settings?.myNickname || "用户";
    const recentChatHistory = (activePetChat.history || [])
      .filter(m => !m.isHidden)
      .slice(-maxMemory)
      .map(m => `${m.role === "user" ? userNickname : activePetChat.name}: ${m.content || ""}`)
      .join("\n");

    const screenId = getCurrentScreenId();
    let context = "", content = "";

    if (screenId === "chat-interface-screen" && state.activeChatId && state.chats[state.activeChatId]) {
      const currentChat = state.chats[state.activeChatId];
      const chatTitle = currentChat.name;

      if (currentChat.isGroup) {
        // 群聊：顶部显示的是群组名称，不是某个角色的名字；需要按发言者名字区分是谁在说话
        const membersList = currentChat.members || [];
        const membersInfo = membersList.map(m => {
          const memberName = m.groupNickname || m.originalName || m.name || "未知成员";
          return `- ${memberName}（本名：${m.originalName || m.name || "未知"}）`;
        }).join("\n");

        const userNickname = currentChat.settings?.myNickname || "我";
        const recentHistory = (currentChat.history || []).filter(m => !m.isHidden).slice(-30)
          .map(m => {
            let senderName;
            if (m.role === "user") {
              senderName = userNickname;
            } else {
              const member = membersList.find(mem => mem.originalName === m.senderName);
              senderName = member ? (member.groupNickname || member.originalName) : (m.senderName || "未知成员");
            }
            return `${senderName}: ${m.content || ""}`;
          }).join("\n");

        context = `你发现用户当前正在查看群聊"${chatTitle}"的聊天页面。作为窥屏者，你看到了以下信息：这是一个群聊页面，"${chatTitle}"是群组名称，不是某个角色的名字，群里有多个成员，你需要根据聊天记录里每条消息前面标注的名字来判断是谁在说话。`;
        content = `# 群组信息\n- 群组名称：${chatTitle}（这是群组名称，不是角色名字）\n- 群成员列表：\n${membersInfo || "暂无成员信息"}\n\n# 最近30条聊天记录\n${recentHistory || "暂无聊天记录"}`;
      } else {
        const recentHistory = (currentChat.history || []).filter(m => !m.isHidden).slice(-30)
          .map(m => `${m.role === "user" ? (currentChat.settings?.myNickname || "我") : currentChat.name}: ${m.content || ""}`).join("\n");
        context = `你发现用户当前正在与角色"${chatTitle}"聊天。作为窥屏者，你看到了以下信息：`;
        content = `# 聊天对象\n- 角色名称：${chatTitle}\n\n# 最近30条聊天记录\n${recentHistory || "暂无聊天记录"}`;
      }
    } else {
      const extracted = extractCurrentScreenContent();
      context = `你发现用户当前正在"${getScreenFriendlyName(screenId)}"。作为窥屏者，你看到了页面上的以下内容：`;
      content = extracted.hasContent ? extracted.content : "（页面暂无可读取的文字内容）";
    }

    const systemPrompt = buildBasePrompt(activePetChat, context, content, recentChatHistory);
    lastPetSystemPrompt = systemPrompt;

    showPetWaitingBubble();
    try {
      const fullReply = await callPetAI(systemPrompt);
      hidePetWaitingBubble();

      let pageAnalysis = "", reply = "";
      const analysisMatch = fullReply.match(/【页面分析】\s*([\s\S]*?)(?=【回复】|$)/);
      const replyMatch = fullReply.match(/【回复】\s*([\s\S]*?)$/);
      if (analysisMatch && replyMatch) {
        pageAnalysis = analysisMatch[1].trim();
        reply = replyMatch[1].trim();
      } else {
        pageAnalysis = getScreenFriendlyName(screenId);
        reply = fullReply.trim();
      }

      showPetReplyBubble(reply);

      try {
        if (!activePetChat.settings.desktopPetPeekingHistory) activePetChat.settings.desktopPetPeekingHistory = [];
        activePetChat.settings.desktopPetPeekingHistory.push({
          timestamp: Date.now(), screenId: screenId || "未知界面",
          screenContent: pageAnalysis, response: reply, includeInMemory: true
        });
        // 最多保留最近50条，避免无限膨胀
        if (activePetChat.settings.desktopPetPeekingHistory.length > 50) {
          activePetChat.settings.desktopPetPeekingHistory = activePetChat.settings.desktopPetPeekingHistory.slice(-50);
        }
        await db.chats.put(activePetChat);
      } catch (e) {
        console.error("[桌宠] 保存窥屏历史失败", e);
      }
    } catch (e) {
      console.error("[桌宠] AI回复失败", e);
      hidePetWaitingBubble();
      showPetReplyBubble(`抱歉，我现在无法回应...\n错误：${e.message}`);
    }
  }

  // ---------------- 单击 vs 双击 vs 吸附恢复 ----------------
  function initDesktopPetDoubleClick() {
    const petContainer = document.getElementById("desktop-pet-container");
    if (!petContainer) return;

    function unsnap() {
      const screenRect = getPhoneScreenEl().getBoundingClientRect();
      const rect = petContainer.getBoundingClientRect();
      const w = petContainer.offsetWidth, h = petContainer.offsetHeight;
      let newLeft, newTop;
      if (petContainer.classList.contains("snapped-left")) { newLeft = 10; newTop = rect.top - screenRect.top; }
      else if (petContainer.classList.contains("snapped-right")) { newLeft = screenRect.width - w - 10; newTop = rect.top - screenRect.top; }
      else if (petContainer.classList.contains("snapped-top")) { newLeft = rect.left - screenRect.left; newTop = 10; }
      else if (petContainer.classList.contains("snapped-bottom")) { newLeft = rect.left - screenRect.left; newTop = screenRect.height - h - 10; }
      else return;

      petContainer.style.left = newLeft + "px";
      petContainer.style.top = newTop + "px";
      petContainer.style.right = "auto";
      petContainer.style.bottom = "auto";
      petContainer.classList.remove("snapped", "snapped-left", "snapped-right", "snapped-top", "snapped-bottom");
      updateBubblePositions();

      const chat = findActivePetChat();
      if (chat) {
        chat.settings.desktopPetPosition = { top: newTop, left: newLeft, isSnapped: false, snapSide: null };
        db.chats.put(chat);
      }
    }

    let clickTimer = null, clickCount = 0;
    petContainer.addEventListener("click", () => {
      if (petContainer.classList.contains("dragging")) return;
      if (petContainer.classList.contains("snapped")) { unsnap(); return; }
      clickCount++;
      if (clickCount === 1) {
        clickTimer = setTimeout(() => { showPetLine(); clickCount = 0; }, 300);
      } else if (clickCount === 2) {
        clearTimeout(clickTimer);
        clickCount = 0;
        triggerPetAIResponse();
      }
    });

    // 移动端双击（触摸）
    let touchStartTime = 0, touchStartX = 0, touchStartY = 0, touchMoved = false;
    let lastTouchEndTime = 0, lastTouchEndX = 0, lastTouchEndY = 0;
    petContainer.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      touchStartTime = Date.now(); touchStartX = t.clientX; touchStartY = t.clientY; touchMoved = false;
    }, { passive: true });
    petContainer.addEventListener("touchmove", (e) => {
      if (!touchStartTime || !e.touches?.length) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - touchStartX) > 10 || Math.abs(t.clientY - touchStartY) > 10) touchMoved = true;
    }, { passive: true });
    petContainer.addEventListener("touchend", (e) => {
      const endTime = Date.now();
      if (touchMoved || !touchStartTime) { lastTouchEndTime = 0; touchStartTime = 0; touchMoved = false; return; }
      if (petContainer.classList.contains("snapped")) { unsnap(); touchStartTime = 0; return; }

      const timeDiff = endTime - touchStartTime;
      const touch = e.changedTouches[0];
      if (!touch || timeDiff < 30 || timeDiff > 500) { lastTouchEndTime = 0; touchStartTime = 0; return; }

      const dist = lastTouchEndTime ? Math.hypot(touch.clientX - lastTouchEndX, touch.clientY - lastTouchEndY) : Infinity;
      const timeSince = lastTouchEndTime ? endTime - lastTouchEndTime : Infinity;

      if (timeSince <= 300 && dist <= 50 && lastTouchEndTime) {
        lastTouchEndTime = 0; touchStartTime = 0;
        triggerPetAIResponse();
      } else {
        lastTouchEndTime = endTime; lastTouchEndX = touch.clientX; lastTouchEndY = touch.clientY;
        setTimeout(() => {
          if (lastTouchEndTime === endTime) { showPetLine(); lastTouchEndTime = 0; }
        }, 300);
      }
      touchStartTime = 0; touchMoved = false;
    }, { passive: true });
  }

  // ---------------- CSS ----------------
  function injectStyle() {
    if (document.getElementById("desktop-pet-style")) return;
    const style = document.createElement("style");
    style.id = "desktop-pet-style";
    style.textContent = `
      #desktop-pet-container {
        position: absolute;
        z-index: 9998;
        display: none;
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      #desktop-pet-container.dragging { cursor: grabbing; }
      #desktop-pet-circle {
        width: 100%; height: 100%; overflow: hidden;
        box-shadow: 0 3px 10px rgba(0,0,0,0.28);
        border: 2px solid #fff;
        transition: border-radius 0.2s;
      }
      #desktop-pet-circle.shape-circle { border-radius: 50%; }
      #desktop-pet-circle.shape-diamond { border-radius: 12px; transform: rotate(45deg); }
      #desktop-pet-circle.shape-diamond #desktop-pet-avatar { transform: rotate(-45deg) scale(1.35); }
      #desktop-pet-circle.shape-square { border-radius: 14px; }
      #desktop-pet-avatar { width: 100%; height: 100%; object-fit: cover; display: block; }
      #desktop-pet-container.snapped #desktop-pet-circle { box-shadow: 0 2px 6px rgba(0,0,0,0.35); opacity: 0.9; }

      .desktop-pet-waiting-bubble, .desktop-pet-line-bubble {
        position: absolute; z-index: 9999;
        background: rgba(28,28,30,0.92); color: #fff;
        border-radius: 12px; padding: 7px 12px; font-size: 12.5px; line-height: 1.4;
        max-width: 160px; box-shadow: 0 3px 10px rgba(0,0,0,0.25);
        pointer-events: none;
      }
      .desktop-pet-line-bubble { opacity: 0; transform: translateY(4px) scale(0.95); transition: opacity 0.2s, transform 0.2s; }
      .desktop-pet-line-bubble.visible { opacity: 1; transform: translateY(0) scale(1); }

      #desktop-pet-reply-bubble {
        position: absolute; z-index: 9999;
        top: 60px; left: 16px; right: 16px;
        background: var(--secondary-bg, #1c1c1e); color: var(--text-primary, #fff);
        border: 1px solid var(--border-color, #38383a);
        border-radius: 14px; padding: 12px 14px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35);
        opacity: 0; transform: translateY(-6px); transition: opacity 0.2s, transform 0.2s;
      }
      #desktop-pet-reply-bubble.visible { opacity: 1; transform: translateY(0); }
      .desktop-pet-reply-content { font-size: 14px; line-height: 1.6; white-space: pre-wrap; }
      .desktop-pet-reply-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .desktop-pet-reply-reroll, .desktop-pet-reply-delete {
        border: none; background: rgba(255,255,255,0.08); color: var(--text-secondary, #8e8e93);
        border-radius: 8px; width: 28px; height: 28px; font-size: 13px; cursor: pointer;
      }
      .desktop-pet-reply-reroll:hover, .desktop-pet-reply-delete:hover { background: rgba(255,255,255,0.16); }

      /* ===== 聊天设置里的桌宠面板，复用 .settings-item 视觉规范 ===== */
      #desktop-pet-settings-section .settings-item-block { gap: 10px; }
      .deskpet-image-row { display: flex; align-items: center; gap: 10px; }
      #deskpet-image-preview {
        width: 48px; height: 48px; border-radius: 10px; object-fit: cover;
        background: var(--secondary-bg, #ececec); flex-shrink: 0;
      }
      .deskpet-image-actions { display: flex; gap: 8px; flex: 1; flex-wrap: wrap; }
      .deskpet-mini-btn {
        flex: 1; min-width: 74px; font-size: 12.5px; padding: 8px 6px;
        border-radius: 8px; border: 1px solid var(--accent-color, #0A84FF);
        color: var(--accent-color, #0A84FF); background: transparent; cursor: pointer;
        text-align: center;
      }
      .deskpet-mini-btn:active { background: rgba(10,132,255,0.12); }
      .deskpet-shape-options { display: flex; gap: 18px; }
      .deskpet-shape-option { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text-primary, #000); }
      .deskpet-slider-row { display: flex; align-items: center; gap: 10px; }
      .deskpet-slider-row input[type="range"] { flex: 1; }
      #deskpet-size-value { font-size: 13px; color: var(--text-secondary, #8a8a8a); min-width: 42px; text-align: right; }
      #desktop-pet-settings-section .settings-full-btn {
        width: 100%; padding: 12px; border-radius: 10px; border: none;
        background: var(--accent-color, #0A84FF); color: #fff; font-size: 14px; cursor: pointer;
      }
      #desktop-pet-settings-section .settings-full-btn.secondary {
        background: transparent; border: 1px solid var(--border-color, #ddd); color: var(--text-primary, #333);
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------- 悬浮桌宠 DOM ----------------
  function injectPetDom() {
    if (document.getElementById("desktop-pet-container")) return;
    const container = document.createElement("div");
    container.id = "desktop-pet-container";
    container.innerHTML = `
      <div id="desktop-pet-circle" class="shape-circle">
        <img id="desktop-pet-avatar" src="" alt="桌宠">
      </div>
    `;
    getPhoneScreenEl().appendChild(container);
  }

  // ---------------- 聊天设置面板 ----------------
  function injectSettingsPanel() {
    const container = document.querySelector("#chat-settings-screen .settings-container");
    if (!container) { console.warn("[桌宠] 未找到聊天设置的 .settings-container，面板未注入"); return; }
    if (document.getElementById("desktop-pet-settings-section")) return;

    const section = document.createElement("div");
    section.className = "settings-section";
    section.id = "desktop-pet-settings-section";
    section.innerHTML = `
      <div class="settings-item">
        <label>🐾 启用桌宠</label>
        <div class="settings-right">
          <input type="checkbox" id="desktop-pet-switch">
        </div>
      </div>
      <div class="settings-item-block">
        <label>桌宠图片</label>
        <div class="settings-desc">开启后，界面上会出现该角色的桌宠，可以拖拽移动。同时只能有一个角色开启桌宠。</div>
        <div class="deskpet-image-row">
          <img id="deskpet-image-preview" src="">
          <div class="deskpet-image-actions">
            <button class="deskpet-mini-btn" id="desktop-pet-upload-local-btn" type="button">📁 本地上传</button>
            <button class="deskpet-mini-btn" id="desktop-pet-upload-url-btn" type="button">🌐 URL上传</button>
            <button class="deskpet-mini-btn" id="desktop-pet-reset-image-btn" type="button">🔄 恢复默认</button>
          </div>
        </div>
        <input type="file" id="desktop-pet-upload-input" accept="image/*" style="display:none;">
        <input type="hidden" id="desktop-pet-image-url">
      </div>
      <div class="settings-item-block">
        <label>桌宠形状</label>
        <div class="deskpet-shape-options">
          <label class="deskpet-shape-option"><input type="radio" name="desktop-pet-shape" value="circle" checked> 圆形</label>
          <label class="deskpet-shape-option"><input type="radio" name="desktop-pet-shape" value="diamond"> 菱形</label>
          <label class="deskpet-shape-option"><input type="radio" name="desktop-pet-shape" value="square"> 方形</label>
        </div>
      </div>
      <div class="settings-item-block">
        <label>桌宠大小：<span id="desktop-pet-size-value">80</span>px</label>
        <div class="deskpet-slider-row">
          <input type="range" id="desktop-pet-size-slider" min="40" max="200" step="4" value="80">
        </div>
        <div class="settings-desc">范围：40px - 200px</div>
      </div>
      <div class="settings-item-block">
        <button class="settings-full-btn secondary" id="desktop-pet-reset-position-btn" type="button">↺ 重置桌宠位置</button>
        <div class="settings-desc">将桌宠重置到屏幕中心，确保桌宠可见</div>
      </div>
      <div class="settings-item-block">
        <button class="settings-full-btn secondary" id="desktop-pet-reroll-lines-btn" type="button">🎲 重新生成所有小台词</button>
        <div class="settings-desc">重新生成该角色在所有界面的点击台词（需要API配置）</div>
      </div>
    `;
    container.insertBefore(section, container.firstChild);
    bindSettingsPanelEvents();
  }

  function loadSettingsPanel() {
    const chatId = state.activeChatId;
    if (!chatId) return;
    const chat = state.chats[chatId];
    if (!chat || chat.isGroup) {
      document.getElementById("desktop-pet-settings-section")?.style.setProperty("display", "none");
      return;
    }
    document.getElementById("desktop-pet-settings-section")?.style.setProperty("display", "");

    const s = chat.settings || {};
    document.getElementById("desktop-pet-switch").checked = !!s.desktopPetEnabled;

    const previewImg = document.getElementById("deskpet-image-preview");
    const urlInput = document.getElementById("desktop-pet-image-url");
    const defaultSrc = s.aiAvatar || "";
    previewImg.src = s.desktopPetImage || defaultSrc;
    previewImg.dataset.defaultSrc = defaultSrc;
    urlInput.value = s.desktopPetImage || "";

    const shape = s.desktopPetShape || "circle";
    document.querySelectorAll('input[name="desktop-pet-shape"]').forEach(r => { r.checked = r.value === shape; });

    const size = s.desktopPetSize || 80;
    document.getElementById("desktop-pet-size-slider").value = size;
    document.getElementById("desktop-pet-size-value").textContent = size;
  }

  function bindSettingsPanelEvents() {
    document.getElementById("desktop-pet-upload-local-btn")?.addEventListener("click", () => {
      document.getElementById("desktop-pet-upload-input").click();
    });

    document.getElementById("desktop-pet-upload-input")?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        document.getElementById("deskpet-image-preview").src = dataUrl;
        document.getElementById("desktop-pet-image-url").value = dataUrl;
      };
      reader.readAsDataURL(file);
      e.target.value = null;
    });

    document.getElementById("desktop-pet-upload-url-btn")?.addEventListener("click", async () => {
      const url = await showCustomPrompt("上传图片URL", "请输入图片URL", "", "url");
      if (!url || !url.trim()) return;
      const previewImg = document.getElementById("deskpet-image-preview");
      previewImg.src = url.trim();
      document.getElementById("desktop-pet-image-url").value = url.trim();
      previewImg.onerror = () => {
        alert("图片URL无效，请检查链接");
        previewImg.src = previewImg.dataset.defaultSrc || "";
        document.getElementById("desktop-pet-image-url").value = "";
      };
    });

    document.getElementById("desktop-pet-reset-image-btn")?.addEventListener("click", () => {
      const previewImg = document.getElementById("deskpet-image-preview");
      previewImg.src = previewImg.dataset.defaultSrc || "";
      document.getElementById("desktop-pet-image-url").value = "";
    });

    document.getElementById("desktop-pet-size-slider")?.addEventListener("input", (e) => {
      const size = parseInt(e.target.value, 10);
      document.getElementById("desktop-pet-size-value").textContent = size;
      const petContainer = document.getElementById("desktop-pet-container");
      if (petContainer && petContainer.style.display !== "none") {
        petContainer.style.width = size + "px";
        petContainer.style.height = size + "px";
      }
    });

    document.querySelectorAll('input[name="desktop-pet-shape"]').forEach(radio => {
      radio.addEventListener("change", () => {
        const petContainer = document.getElementById("desktop-pet-container");
        const petCircle = document.getElementById("desktop-pet-circle");
        if (petContainer && petCircle && petContainer.style.display !== "none") {
          petCircle.classList.remove("shape-circle", "shape-diamond", "shape-square");
          petCircle.classList.add("shape-" + radio.value);
        }
      });
    });

    document.getElementById("desktop-pet-reset-position-btn")?.addEventListener("click", async () => {
      const chatId = state.activeChatId;
      if (!chatId) return;
      const chat = state.chats[chatId];
      if (!chat || chat.isGroup) return;

      if (!chat.settings.desktopPetEnabled) {
        for (const otherId in state.chats) {
          const other = state.chats[otherId];
          if (otherId !== chatId && !other.isGroup && other.settings?.desktopPetEnabled) {
            other.settings.desktopPetEnabled = false;
            await db.chats.put(other);
          }
        }
        chat.settings.desktopPetEnabled = true;
        await db.chats.put(chat);
        document.getElementById("desktop-pet-switch").checked = true;
      }

      const screenRect = getPhoneScreenEl().getBoundingClientRect();
      const size = chat.settings?.desktopPetSize || 80;
      const centerLeft = (screenRect.width - size) / 2;
      const centerTop = (screenRect.height - size) / 2;

      chat.settings.desktopPetPosition = { top: centerTop, left: centerLeft, isSnapped: false, snapSide: null };
      await db.chats.put(chat);
      await updateDesktopPet();

      if (typeof showToast === "function") showToast("桌宠位置已重置");
    });

    document.getElementById("desktop-pet-reroll-lines-btn")?.addEventListener("click", async (e) => {
      const chatId = state.activeChatId;
      if (!chatId) { alert("请先选择一个角色"); return; }
      const chat = state.chats[chatId];
      if (!chat || chat.isGroup) { alert("群聊无法使用桌宠功能"); return; }

      const apiCfg = state.apiConfig || {};
      if (!apiCfg.proxyUrl || !apiCfg.apiKey || !apiCfg.model) { alert("请先配置API设置"); return; }

      const btn = e.currentTarget;
      const originalText = btn.textContent;
      btn.textContent = "⏳ 正在生成中...";
      btn.disabled = true;

      try {
        await generateDesktopPetLines(chat, true);
        btn.textContent = "✓ 生成完成！";
        if (typeof showToast === "function") showToast("台词已重新生成");
      } catch (err) {
        console.error("[桌宠] 重新生成台词失败", err);
        btn.textContent = "✗ 生成失败";
      } finally {
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1800);
      }
    });

    document.getElementById("desktop-pet-switch")?.addEventListener("change", async (e) => {
      const chatId = state.activeChatId;
      if (!chatId) return;
      const chat = state.chats[chatId];
      if (!chat || chat.isGroup) { e.target.checked = false; return; }

      if (e.target.checked) {
        // 关闭其他角色的桌宠，全局只能一个
        for (const otherId in state.chats) {
          const other = state.chats[otherId];
          if (otherId !== chatId && !other.isGroup && other.settings?.desktopPetEnabled) {
            other.settings.desktopPetEnabled = false;
            await db.chats.put(other);
          }
        }
        chat.settings.desktopPetEnabled = true;
        chat.settings.desktopPetImage = document.getElementById("desktop-pet-image-url").value.trim() || "";
        const shape = document.querySelector('input[name="desktop-pet-shape"]:checked')?.value || "circle";
        chat.settings.desktopPetShape = shape;
        chat.settings.desktopPetSize = parseInt(document.getElementById("desktop-pet-size-slider").value, 10) || 80;
        await db.chats.put(chat);

        if (!chat.settings.desktopPetLines || Object.keys(chat.settings.desktopPetLines).length === 0) {
          generateDesktopPetLines(chat).catch(err => console.error("[桌宠] 生成台词失败", err));
        }
        if (typeof showToast === "function") showToast(`桌宠已切换为「${chat.name}」`);
      } else {
        chat.settings.desktopPetEnabled = false;
        await db.chats.put(chat);
        if (typeof showToast === "function") showToast("桌宠已关闭");
      }
      await updateDesktopPet();
    });

    // 图片/形状/大小的改动也顺手落盘（不用等点开关才保存）
    ["desktop-pet-image-url"].forEach(id => {
      document.getElementById(id)?.addEventListener("change", persistCurrentChatPetSettings);
    });
    document.querySelectorAll('input[name="desktop-pet-shape"]').forEach(r => r.addEventListener("change", persistCurrentChatPetSettings));
    document.getElementById("desktop-pet-size-slider")?.addEventListener("change", persistCurrentChatPetSettings);
  }

  async function persistCurrentChatPetSettings() {
    const chatId = state.activeChatId;
    if (!chatId) return;
    const chat = state.chats[chatId];
    if (!chat || chat.isGroup || !chat.settings.desktopPetEnabled) return;
    chat.settings.desktopPetImage = document.getElementById("desktop-pet-image-url").value.trim() || "";
    chat.settings.desktopPetShape = document.querySelector('input[name="desktop-pet-shape"]:checked')?.value || "circle";
    chat.settings.desktopPetSize = parseInt(document.getElementById("desktop-pet-size-slider").value, 10) || 80;
    await db.chats.put(chat);
    await updateDesktopPet();
  }

  // ---------------- 初始化 ----------------
  function init() {
    injectStyle();
    injectPetDom();
    injectSettingsPanel();
    initDesktopPetDrag();
    initDesktopPetDoubleClick();
    updateDesktopPet();

    if (!window.__deskPetShowScreenHooked) {
      window.__deskPetShowScreenHooked = true;
      const originalShowScreen = window.showScreen;
      if (typeof originalShowScreen === "function") {
        window.showScreen = function (screenId) {
          originalShowScreen(screenId);
          if (screenId === "chat-settings-screen") loadSettingsPanel();
        };
      }
    }
    console.log("[桌宠] 初始化完成");
  }

  document.addEventListener("DOMContentLoaded", () => {
    function tryInit(retries) {
      if (window.state && window.db && typeof window.showScreen === "function" && document.getElementById("chat-settings-screen")) {
        init();
      } else if (retries > 0) {
        setTimeout(() => tryInit(retries - 1), 300);
      } else {
        console.warn("[桌宠] 等待依赖超时，初始化取消");
      }
    }
    tryInit(30);
  });
})();
