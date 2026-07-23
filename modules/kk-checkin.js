let activeKkCharId = null; // 用于追踪正在查看哪个角色的房屋

/**
 * 【总入口】打开“查岗”功能，显示角色选择列表
 */
async function openKkCheckin() {
  const listEl = document.getElementById("kk-char-selection-list");
  listEl.innerHTML = "";
  const characters = Object.values(state.chats).filter((chat) => !chat.isGroup);

  if (characters.length === 0) {
    listEl.innerHTML =
      '<p style="text-align:center; color: var(--text-secondary);">还没有可以查岗的角色</p>';
  } else {
    characters.forEach((char) => {
      const item = document.createElement("div");
      item.className = "character-select-item"; // 复用“查手机”的样式
      item.dataset.chatId = char.id;
      item.innerHTML = `
                                <img src="${char.settings.aiAvatar || defaultAvatar}" alt="${char.name}">
                                <span class="name">${char.name}</span>
                            `;
      listEl.appendChild(item);
    });
  }
  showScreen("kk-char-selection-screen");
}

/**
 * 选择一个角色后，打开他/她的房屋视图
 * @param {string} charId - 被选择角色的ID
 */
async function openKkHouseView(charId) {
  activeKkCharId = charId;
  const chat = state.chats[charId];
  if (!chat) return;

  // 检查是否已经生成过房屋数据
  if (!chat.houseData) {
    // 【修改点】询问用户是否生成电脑
    const includeComputer = await showCustomConfirm(
      "生成选项",
      "是否需要生成电脑内容？\n(包含浏览器历史、私人文件、Steam游戏等)",
      { confirmText: "必须生成", cancelText: "不需要" },
    );

    // 将用户的选择传给生成函数
    const generatedData = await generateHouseData(charId, includeComputer);

    if (!generatedData) return; // 如果生成失败，则中止
    chat.houseData = generatedData;
    await db.chats.put(chat); // 保存到数据库
  }

  // 渲染房屋视图
  renderKkHouseView(chat.houseData);
  showScreen("kk-house-view-screen");
}

/**
 * 【AI核心 V3】为指定角色一次性生成所有房屋、区域和物品数据
 * @param {string} charId - 角色ID
 * @param {boolean} includeComputer - 【新增】是否包含电脑数据
 * @returns {Promise<object|null>} - 返回生成的房屋数据对象，或在失败时返回null
 */
async function generateHouseData(charId, includeComputer = true) {
  // 默认为true兼容旧代码
  const chat = state.chats[charId];
  showGenerationOverlay("正在努力寻找中...");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    let worldBookContext = "";
    if (
      chat.settings.linkedWorldBookIds &&
      chat.settings.linkedWorldBookIds.length > 0
    ) {
      worldBookContext =
        "--- 世界观设定 (必须严格遵守) ---\n" +
        chat.settings.linkedWorldBookIds
          .map((id) => {
            const book = state.worldBooks.find((b) => b.id === id);
            return book ? `[${book.name}]: ${book.content}` : "";
          })
          .join("\n\n");
    }
    const userNickname = chat.settings.myNickname || "我";

    const recentHistory = chat.history
      .slice(-chat.settings.maxMemory || 20)
      .map((msg) => {
        const sender = msg.role === "user" ? userNickname : chat.name;
        return `${sender}: ${msg.content}`;
      })
      .join("\n");

    let linkedMemoryContext = "";
    if (
      chat.settings.linkedMemories &&
      chat.settings.linkedMemories.length > 0
    ) {
      // ... (保持原有的记忆互通逻辑不变) ...
      const contextPromises = chat.settings.linkedMemories.map(async (link) => {
        const linkedChat = state.chats[link.chatId];
        if (!linkedChat) return "";
        const freshLinkedChat = await db.chats.get(link.chatId);
        if (!freshLinkedChat) return "";
        const recentHistory = freshLinkedChat.history
          .filter((msg) => !msg.isHidden)
          .slice(-link.depth);
        if (recentHistory.length === 0) return "";
        const formattedMessages = recentHistory
          .map((msg) => `  - ${formatMessageForContext(msg, freshLinkedChat)}`)
          .join("\n");
        return `\n## 附加上下文：来自与“${linkedChat.name}”的最近对话内容 (仅你可见)\n${formattedMessages}`;
      });
      const allContexts = await Promise.all(contextPromises);
      linkedMemoryContext = allContexts.filter(Boolean).join("\n");
    }

    const npcLibrary = chat.npcLibrary || [];
    let npcContext = "";
    if (npcLibrary.length > 0) {
      npcContext =
        "# 你的专属NPC好友列表" +
        npcLibrary.map((npc) => `- **${npc.name}**: ${npc.persona}`).join("\n");
    }

    let computerRulesPrompt = "";
    let computerJsonExample = "";

    if (includeComputer) {
      computerRulesPrompt = `
            4.  **【【【电脑生成双重铁律 (内容必须极其详细)】】】**:
                -   **指令一 (数据层 - 拒绝敷衍)**: JSON中**必须**包含 "computer" 对象，且内容必须丰富：
                    -   "browser_history": 生成3-5条**非常具体**的搜索记录。不要只写关键词，要写完整的搜索语句或网页标题。必须反映角色最近的烦恼、兴趣或秘密（例如：“如何挽回前任”、“xx游戏全收集攻略”、“治疗失眠的方法”、“深夜emo文案”）。
                    -   "movies": 虚构2-3个在电脑D盘里的视频文件名。**必须带后缀**（.mp4, .mkv, .avi）。文件名要符合角色口味（如：里番、好莱坞大片、文艺片、偶像演唱会录屏）。
                    -   "steam_games": 虚构3个Steam游戏。包含游戏名和游玩时长。时长要夸张一点，体现宅度或喜好。
                    -   "local_files": 虚构2-4个本地文件。**必须包含 "content" 字段**。内容不能是简单的占位符，**必须是具体的**日记片段、未发送的信、工作草稿或代码片段，能体现角色当下的心理活动。
                    -   "secret_folder": **必须包含**。这是角色的“潘多拉魔盒”。
                        -   "fileName": 必须是一个伪装性很强的文件名（例如：“学习资料.zip”、“系统备份”、“新建文件夹(2)”）。
                        -   "content": **核心重点**。根据角色人设（${chat.settings.aiPersona}）生成具体的私密内容描述。
                            -   如果角色是普通人：可能是羞耻的中二病日记、暗恋对象的偷拍照片、写了一半的玛丽苏小说。
                            -   如果角色是老司机/特定癖好：**必须生成具体的成人影片文件名（带番号）**、本子画师名或Galgame存档。
                            -   如果角色是反派/特工：可能是犯罪计划、目标档案、机密数据。
                            -   **要求：必须具体！不要只写“一些私密文件”！要写出文件名和大致内容！**
                -   **指令二 (物理层)**: 为了让用户能找到这台电脑，你**必须**在【卧室】或【客厅】的 \`items\` 列表中，**显式添加**一个 \`name\` 为 **"电脑"** (或 "笔记本电脑") 的物品。
        `;

      computerJsonExample = `,
          "computer": {
            "browser_history": [ "搜索记录A", "搜索记录B" ],
            "local_files": [
              {"fileName": "日记.txt", "content": "..."}
            ],
            "movies": ["电影A.mkv"],
            "secret_folder": { "fileName": "学习资料.zip", "content": "..." },
            "steam_games": [ {"name": "Elden Ring", "playtime": "300 h"} ]
          }`;
    } else {
      computerRulesPrompt = `4. **【指令】**: 本次**不需要**生成电脑数据，JSON中不要包含 "computer" 字段。`;
    }

    const systemPrompt = `
            # 任务
            你是一个顶级的、充满想象力的场景设计师。请根据角色的人设和最近的聊天记录，为角色“${chat.name}”设计一个充满细节、符合其身份的住所。你的任务是【一次性】生成所有数据。

            # 角色信息
            - 角色名: ${chat.name}
            - 角色人设: ${chat.settings.aiPersona}
            ${worldBookContext}
            - 最近的聊天记录 (供你参考情景):
            ${recentHistory}
            ${linkedMemoryContext}
            ${npcContext}

            # 核心规则 (必须严格遵守)
            1.  **情景一致性**: 住所的设计、找到的物品都必须严格符合角色的人设、世界观和最近的聊天情景。例如，一个贫穷的角色不应住在豪宅，一个刚失恋的角色可能会找到相关物品。
            2.  **区域划分**: 住所必须至少包含【客厅】和【卧室】。你可以根据人设添加其他有趣的区域（如书房、厨房、阳台、地下室等）。
            3.  **可翻找物品 (最重要!)**:
                -   每个区域内必须包含3-5个符合该区域特点、且可以被“翻找”的具体地点。例如：客厅可以有“沙发底下”、“茶几抽屉”、“电视柜后面”、“垃圾桶”；卧室可以有“枕头底下”、“衣柜深处”、“床头柜抽屉”。
                -   你【必须】为【每一个】可翻找的物品预设好翻找后能找到的内容("content")。
                -   找到的内容必须充满细节和想象力，可以是普通的物品，也可以是触发剧情的关键线索。**不要总是“什么都没找到”**。
            ${computerRulesPrompt}
            5.  **图片Prompt**: 你必须为住所的【整体外观】以及【每个独立区域】都生成一个用于文生图的、纯英文的、详细的【纯风景或静物】描述。**绝对不能包含人物**。图片风格必须是【唯美的动漫风格 (beautiful anime style art, cinematic lighting, masterpiece)】。

            # JSON输出格式 (必须严格遵守，不要添加任何额外说明)
            {
              "location": "【例如：市中心的高级公寓顶层】",
              "description": "【对这个住所的整体氛围和风格的简短描述】",
              "locationImagePrompt": "【整体住所外观的英文图片prompt】",
              "areas": {
                "客厅": {
                  "description": "【对客厅的详细描述】",
                  "imagePrompt": "【客厅的英文图片prompt】",
                  "items": [
                    {"name": "沙发底下", "content": "找到了一些零食碎屑和一枚遗落的硬币。"},
                    {"name": "电脑", "content": "这是一台性能不错的笔记本电脑，屏幕还亮着。"}
                  ]
                },
                "卧室": { ... }
              }${computerJsonExample}
            }
            `;

    // ... (后续的API调用请求代码保持不变) ...
    const messagesForApi = [{ role: "user", content: systemPrompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      systemPrompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.8,
          }),
        });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).replace(/^```json\s*|```$/g, "");
    const houseData = JSON.parse(rawContent);

    // ▼▼▼ 逐张生成图片逻辑 (保持不变) ▼▼▼
    (async () => {
      // ... (这里保留你原本的图片生成逻辑，不用动) ...
      const generateWithRetry = async (prompt, description) => {
        let attempt = 1;
        while (true) {
          try {
            console.log(`[${attempt}次尝试] 正在为“${description}”生成图片...`);
            const url = await generateAndLoadImage(prompt);
            if (url && url.length > 100) {
              console.log(`✅ “${description}”生成成功！`);
              return url;
            } else {
              throw new Error("生成的图片URL无效");
            }
          } catch (e) {
            console.warn(
              `❌ “${description}”生成失败: ${e.message}。3秒后自动重试...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
            attempt++;
          }
        }
      };

      try {
        const currentChat = state.chats[charId];
        console.log("🚀 开始队列式生成房屋图片...");

        if (houseData.locationImagePrompt) {
          const locationUrl = await generateWithRetry(
            houseData.locationImagePrompt,
            "住所整体外观",
          );
          const chatToUpdate = await db.chats.get(charId);
          if (chatToUpdate && chatToUpdate.houseData) {
            chatToUpdate.houseData.locationImageUrl = locationUrl;
            await db.chats.put(chatToUpdate);
          }
          if (currentChat && currentChat.houseData) {
            currentChat.houseData.locationImageUrl = locationUrl;
          }
          const houseScreen = document.getElementById("kk-house-view-screen");
          if (
            houseScreen &&
            houseScreen.classList.contains("active") &&
            activeKkCharId === charId
          ) {
            document.getElementById(
              "kk-house-background",
            ).style.backgroundImage = `url(${locationUrl})`;
          }
        }

        const areaNames = Object.keys(houseData.areas);
        for (const areaName of areaNames) {
          const area = houseData.areas[areaName];
          if (area.imagePrompt) {
            const areaUrl = await generateWithRetry(
              area.imagePrompt,
              `区域：${areaName}`,
            );
            const chatToUpdate = await db.chats.get(charId);
            if (
              chatToUpdate &&
              chatToUpdate.houseData &&
              chatToUpdate.houseData.areas[areaName]
            ) {
              chatToUpdate.houseData.areas[areaName].imageUrl = areaUrl;
              await db.chats.put(chatToUpdate);
            }
            if (
              currentChat &&
              currentChat.houseData &&
              currentChat.houseData.areas[areaName]
            ) {
              currentChat.houseData.areas[areaName].imageUrl = areaUrl;
            }
            const areaScreen = document.getElementById("kk-area-view-screen");
            const currentAreaNameTitle =
              document.getElementById("kk-area-name").textContent;
            if (
              areaScreen &&
              areaScreen.classList.contains("active") &&
              activeKkCharId === charId &&
              currentAreaNameTitle === areaName
            ) {
              document.getElementById(
                "kk-area-background",
              ).style.backgroundImage = `url(${areaUrl})`;
            }
          }
        }
      } catch (imgError) {
        console.error("后台图片生成流程发生不可恢复的错误:", imgError);
      }
    })();
    // ▲▲▲ 图片生成逻辑结束 ▲▲▲

    return houseData;
  } catch (error) {
    console.error("生成房屋数据失败:", error);
    await showCustomAlert("生成失败", `发生错误: ${error.message}`);
    return null;
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}

/**
 * 渲染房屋总览视图
 * @param {object} houseData - 角色的房屋数据
 */
function renderKkHouseView(houseData) {
  document.getElementById("kk-house-owner-name").textContent =
    `${state.chats[activeKkCharId].name}的家`;
  document.getElementById("kk-house-background").style.backgroundImage =
    `url(${houseData.locationImageUrl})`;
  document.getElementById("kk-house-location").textContent = houseData.location;
  document.getElementById("kk-house-description").textContent =
    houseData.description;

  const areasContainer = document.getElementById("kk-house-areas");
  areasContainer.innerHTML = "";
  for (const areaName in houseData.areas) {
    const areaBtn = document.createElement("button");
    areaBtn.className = "kk-area-button";
    areaBtn.textContent = areaName;
    areaBtn.onclick = () => openKkAreaView(areaName);
    areasContainer.appendChild(areaBtn);
  }
}

// ▼▼▼ 用这块【修复后】的代码，完整替换旧的 openKkAreaView 函数 ▼▼▼
/**
 * 打开并渲染指定区域的探索视图
 * @param {string} areaName - 区域名称, e.g., "客厅"
 */
function openKkAreaView(areaName) {
  const chat = state.chats[activeKkCharId];
  const areaData = chat.houseData.areas[areaName];
  if (!areaData) return;

  document.getElementById("kk-area-name").textContent = areaName;
  document.getElementById("kk-area-background").style.backgroundImage =
    `url(${areaData.imageUrl})`;
  document.getElementById("kk-area-description").textContent =
    areaData.description;

  const itemsGrid = document.getElementById("kk-area-items-grid");
  itemsGrid.innerHTML = "";

  // ★★★★★ 核心修复在这里 ★★★★★
  // 我们现在遍历的是对象数组，所以要使用 item.name
  areaData.items.forEach((item) => {
    const itemBtn = document.createElement("button");
    itemBtn.className = "kk-item-button";
    // 1. 修复：按钮上显示的文字应该是对象的 name 属性
    itemBtn.textContent = item.name;

    // 2. 修复：点击时传递给 handleRummage 的也应该是 name 字符串
    itemBtn.onclick = () => handleRummage(areaName, item.name);

    itemsGrid.appendChild(itemBtn);
  });
  // ★★★★★ 修复结束 ★★★★★

  showScreen("kk-area-view-screen");
}
/**
 * 处理“翻找”动作 (修复版：模糊匹配电脑，支持物品分享)
 */
function handleRummage(areaName, itemName) {
  // 1. 【核心修复】电脑特殊处理
  // 改用 includes，只要名字里包含“电脑”、“笔记本”或“computer”就打开电脑界面
  const lowerName = itemName.toLowerCase();
  if (
    lowerName.includes("电脑") ||
    lowerName.includes("computer") ||
    lowerName.includes("笔记本")
  ) {
    openComputer();
    return;
  }

  const chat = state.chats[activeKkCharId];
  const area = chat.houseData.areas[areaName];
  const item = area.items.find((i) => i.name === itemName);

  if (item && item.content) {
    // 2. 获取专用弹窗元素
    const modal = document.getElementById("kk-item-share-modal");
    const title = document.getElementById("kk-item-share-title");
    const contentDiv = document.getElementById("kk-item-share-content");
    const shareBtn = document.getElementById("kk-item-share-confirm-btn");

    // 3. 填充数据
    title.textContent = `在“${itemName}”里发现`;
    contentDiv.textContent = item.content;

    // 4. 清除旧监听器防止重复绑定
    const newShareBtn = shareBtn.cloneNode(true);
    shareBtn.parentNode.replaceChild(newShareBtn, shareBtn);

    // 5. 绑定分享事件
    newShareBtn.addEventListener("click", () => {
      shareKkItemToChat(areaName, itemName, item.content);
      modal.classList.remove("visible");
    });

    // 6. 显示弹窗
    modal.classList.add("visible");
  } else {
    showCustomAlert(
      `在“${itemName}”里`,
      "仔细翻了翻，但什么特别的东西都没发现...",
    );
  }
}

/**
 * 将翻找到的物品以卡片形式分享给当前角色
 * (不触发AI自动回复)
 */
async function shareKkItemToChat(areaName, itemName, content) {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];
  if (!chat) return;

  const msg = {
    role: "user", // 这是用户发出的
    type: "kk_item_share",
    timestamp: Date.now(),
    payload: {
      areaName: areaName,
      itemName: itemName,
      content: content,
    },
    content: `[在你的家里找到了] 在${areaName}的${itemName}里发现了：${content}`,
  };

  chat.history.push(msg);
  await db.chats.put(chat);

  showNotification(activeKkCharId, "线索已发送到聊天");
}

/**
 * 【核心功能】处理“重新翻找”按钮的点击事件
 * 这会清空旧数据，并调用AI重新生成一个全新的家。
 */
async function handleResetKkHouse() {
  if (!activeKkCharId) return;

  const confirmed = await showCustomConfirm(
    "确认重新生成",
    "你确定要重新生成这个家吗？所有现有的区域和物品都将被覆盖，此操作不可撤销。",
    { confirmButtonClass: "btn-danger" },
  );

  if (confirmed) {
    // 【修改点】询问用户是否生成电脑
    const includeComputer = await showCustomConfirm(
      "生成选项",
      "这次生成需要包含电脑吗？",
      {
        confirmText: "必须生成",
        cancelText: "不需要",
      },
    );

    const chat = state.chats[activeKkCharId];
    // 将用户的选择传给生成函数
    const generatedData = await generateHouseData(
      activeKkCharId,
      includeComputer,
    );

    if (generatedData) {
      chat.houseData = generatedData; // 用新数据覆盖旧数据
      await db.chats.put(chat); // 保存到数据库
      renderKkHouseView(chat.houseData); // 重新渲染界面
      alert("一个全新的家已经生成！");
    }
  }
}

/**
 * 【核心功能 V2 - 已支持B站】处理“继续翻找”按钮的点击事件
 * 这会保留现有房屋结构，只让AI为每个区域或电脑添加新的可翻找物品/发现。
 */
async function handleContinueKkSearch() {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];
  if (!chat || !chat.houseData) {
    alert("还没有为这个角色生成家，请先“重新翻找”一次。");
    return;
  }

  showGenerationOverlay("正在努力寻找中...");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    // 准备一个只包含现有物品名的上下文，告诉AI不要重复
    let existingItemsContext = "# 已有物品 (请生成与之不同的新物品或发现)\n";
    for (const areaName in chat.houseData.areas) {
      const area = chat.houseData.areas[areaName];
      existingItemsContext += `## ${areaName}:\n`;
      existingItemsContext +=
        area.items.map((item) => `- ${item.name}`).join("\n") + "\n";
    }

    const systemPrompt = `
			# 任务
			你是一个场景补充设计师。用户正在对角色“${chat.name}”的住所进行【补充翻找】。
			你的任务是在【不改变现有结构】的基础上，为【指定的区域】或【电脑】添加2-3个全新的、有趣的、符合人设的可翻找物品或新发现。

			# 角色信息
			- 人设: ${chat.settings.aiPersona}
			- 已有房屋数据:
			${JSON.stringify(chat.houseData, null, 2)}
			${existingItemsContext}

			# 核心规则
			1.  **只添加，不修改**: 你只能添加新物品/发现，绝对不能修改或删除已有的数据。
			2.  **内容丰富**: 新发现的物品/文件/记录的 "content" 必须充满细节和想象力，不要总是“什么都没找到”。
			3.  **格式铁律**: 你的回复【必须且只能】是一个JSON对象，其结构与下方示例完全一致。键是区域名或"computer"，值是一个包含新物品/发现的数组或对象。

			# JSON输出格式示例 (只返回【新增】的物品/发现)
			{
			  "客厅": [
			    {"name": "书架顶层", "content": "发现一本被遗忘的旧相册。"}
			  ],
			  "computer": {
			    "local_files": [{"fileName": "一封未发送的邮件.eml", "content": "邮件内容..."}],
			    "browser_history": ["P站-插画欣赏"],
			    "movies": ["经典电影C.rmvb"],
			    "steam_games": [
			      {"name": "赛博朋克 2077", "playtime": "150 小时"},
			      {"name": "艾尔登法环", "playtime": "300 小时"},
			      {"name": "博德之门3", "playtime": "200 小时"}
			    ]
			  }
			}
			`;
    const messagesForApi = [{ role: "user", content: systemPrompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      systemPrompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
        });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).replace(/^```json\s*|```$/g, "");
    const newItemsData = JSON.parse(rawContent);

    // 将AI返回的新物品/发现合并到旧数据中
    for (const key in newItemsData) {
      // 如果是电脑数据
      if (key === "computer") {
        const computerUpdates = newItemsData.computer;
        for (const subKey in computerUpdates) {
          // ★★★ 这里是核心合并逻辑 ★★★
          // 确保原始数据里有这个数组，如果没有就创建一个
          if (!chat.houseData.computer[subKey]) {
            chat.houseData.computer[subKey] = [];
          }
          // 确保两个都是数组再合并
          if (
            Array.isArray(chat.houseData.computer[subKey]) &&
            Array.isArray(computerUpdates[subKey])
          ) {
            chat.houseData.computer[subKey].push(...computerUpdates[subKey]);
          }
        }
      }
      // 如果是区域物品数据
      else if (chat.houseData.areas[key] && Array.isArray(newItemsData[key])) {
        chat.houseData.areas[key].items.push(...newItemsData[key]);
      }
    }

    await db.chats.put(chat);
    alert("翻找出了更多新东西！现在可以进入区域或电脑查看了。");
  } catch (error) {
    console.error("继续翻找失败:", error);
    await showCustomAlert("操作失败", `发生错误: ${error.message}`);
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}
/**
 * 【新增】打开电脑物品的分享确认弹窗
 * @param {string} itemName - 物品名称（如“浏览器搜索记录”、“Elden Ring”）
 * @param {string} content - 具体内容（如“搜索了xxx”、“游玩时长xxx”）
 * @param {string} sourceCategory - 来源分类（如“电脑浏览器”、“Steam库”）
 */
function openComputerItemShareModal(itemName, content, sourceCategory) {
  const modal = document.getElementById("kk-item-share-modal");
  const title = document.getElementById("kk-item-share-title");
  const contentDiv = document.getElementById("kk-item-share-content");
  const shareBtn = document.getElementById("kk-item-share-confirm-btn");

  // 1. 填充数据
  title.textContent = `分享：${itemName}`;
  contentDiv.textContent = content;

  // 2. 清除旧监听器防止重复绑定（克隆节点法）
  const newShareBtn = shareBtn.cloneNode(true);
  shareBtn.parentNode.replaceChild(newShareBtn, shareBtn);

  // 3. 绑定分享事件
  newShareBtn.addEventListener("click", () => {
    // 调用你已有的分享函数
    shareKkItemToChat("电脑", `${sourceCategory} - ${itemName}`, content);
    modal.classList.remove("visible");
  });

  // 4. 显示弹窗
  modal.classList.add("visible");
}

/**
 * 【新增】通用列表展示函数 (用于浏览器历史和电影)
 * 复用 kk-file-explorer-modal 来显示列表
 */
function showComputerContentList(title, itemsArray, categoryName) {
  const listEl = document.getElementById("kk-file-list");
  const modal = document.getElementById("kk-file-explorer-modal");

  // 修改弹窗标题（临时修改，关闭时没关系）
  modal.querySelector(".modal-header span").textContent = title;

  listEl.innerHTML = ""; // 清空列表

  if (!itemsArray || itemsArray.length === 0) {
    listEl.innerHTML =
      '<p style="text-align:center; color: var(--text-secondary);">空空如也</p>';
  } else {
    itemsArray.forEach((itemStr) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "kk-file-item"; // 复用文件项样式
      itemDiv.style.cursor = "pointer";
      itemDiv.textContent = itemStr;

      // 点击列表项，弹出分享框
      itemDiv.addEventListener("click", () => {
        // 对于纯字符串列表，物品名简略显示，内容显示完整
        const shortName =
          itemStr.length > 10 ? itemStr.substring(0, 10) + "..." : itemStr;
        openComputerItemShareModal(shortName, itemStr, categoryName);
      });

      listEl.appendChild(itemDiv);
    });
  }

  modal.classList.add("visible");
}

function openComputer() {
  const chat = state.chats[activeKkCharId];
  document
    .getElementById("kk-computer-header")
    .querySelector("span").textContent = `${chat.name}的电脑`;

  const desktop = document.getElementById("kk-computer-desktop");
  // 使用Flexbox布局来更好地排列图标
  desktop.style.display = "flex";
  desktop.style.flexWrap = "wrap";
  desktop.style.gap = "20px";
  desktop.style.padding = "20px";
  desktop.style.alignContent = "flex-start";

  // 获取电脑数据，用于动态显示文件名
  const computerData = chat.houseData?.computer || {};
  const secretFolderName = computerData.secret_folder?.fileName || "加密文件夹";

  desktop.innerHTML = `
			        <div class="kk-desktop-icon" id="kk-browser-icon" title="浏览器">
			            <img src="https://i.postimg.cc/gc7tpbwp/浏览器图标.png" alt="Browser">
			            <span>浏览器</span>
			        </div>

			        <div class="kk-desktop-icon" id="kk-movies-icon" title="电影">
			            <img src="https://i.postimg.cc/gc7tpbwd/电影.png" alt="Movies">
			            <span>电影</span>
			        </div>
			        <div class="kk-desktop-icon" id="kk-files-icon" title="私人文件">
			            <img src="https://i.postimg.cc/9Xkg2H4h/48.png" alt="Files">
			            <span>私人文件</span>
			        </div>
			        <div class="kk-desktop-icon" id="kk-secret-folder-icon" title="隐秘文件夹">
			            <img src="https://i.postimg.cc/SQP14bXp/File_Dead_Big_Thumb.png" alt="Secret Folder">
			            <span>${secretFolderName}</span>
			        </div>
			        <div class="kk-desktop-icon" id="kk-steam-icon" title="Steam">
			            <img src="https://i.postimg.cc/xjZpQVkD/steam.png" alt="Steam">
			            <span>Steam</span>
			        </div>
			    `;

  document.getElementById("kk-computer-modal").classList.add("visible");
}

/**
 * 【V3 - 最终修复版】打开文件浏览器，为每个文件项添加data-*属性以便后续点击处理。
 */
function openFileExplorer() {
  const computerData = state.chats[activeKkCharId]?.houseData?.computer;
  const files = computerData?.local_files || [];
  const listEl = document.getElementById("kk-file-list");
  listEl.innerHTML = "";

  if (files.length === 0) {
    listEl.innerHTML =
      '<p style="text-align:center; color: var(--text-secondary);">这个文件夹是空的</p>';
  } else {
    files.forEach((file) => {
      const item = document.createElement("div");
      item.className = "kk-file-item";
      item.textContent = file.fileName;

      // --- ▼▼▼ 这就是本次修复的核心代码 ▼▼▼ ---

      // 1. 让鼠标悬浮时显示为可点击的手指形状
      item.style.cursor = "pointer";
      // 2. 将文件名和文件内容存储到元素的 data-* 属性中，方便之后读取
      item.dataset.fileName = file.fileName;
      item.dataset.fileContent = encodeURIComponent(
        file.content || "（文件内容为空）",
      );

      // --- ▲▲▲ 核心代码结束 ▲▲▲ ---

      listEl.appendChild(item);
    });
  }

  document.getElementById("kk-file-explorer-modal").classList.add("visible");
}

function openFileViewer(fileName, fileContent) {
  // 1. 填充标题和内容
  document.getElementById("kk-file-viewer-title").textContent = fileName;
  const decodedContent = decodeURIComponent(fileContent);

  const contentEl = document.getElementById("kk-file-viewer-content");
  contentEl.textContent = decodedContent;

  // ▼▼▼▼▼▼▼▼▼▼ 修改开始 ▼▼▼▼▼▼▼▼▼▼
  // 强制设置字体颜色为深灰色 (解决看不见的问题)
  contentEl.style.color = "#333333";
  // 建议加上这个，保留文本的换行和空格格式
  contentEl.style.whiteSpace = "pre-wrap";
  // ▲▲▲▲▲▲▲▲▲▲ 修改结束 ▲▲▲▲▲▲▲▲▲▲

  const modal = document.getElementById("kk-file-viewer-modal");
  const modalContent = modal.querySelector(".modal-content");

  // ★★★ 修复关键 1：强制弹窗容器使用 Flex 列布局 ★★★
  modalContent.style.display = "flex";
  modalContent.style.flexDirection = "column";
  modalContent.style.overflow = "hidden"; // 防止外层出现滚动条

  // 2. 检查是否已经有底部栏(footer)，如果没有就创建一个
  let footer = modalContent.querySelector(".modal-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.className = "modal-footer";

    // ★★★ 修复关键 2：移除 absolute 定位，使用标准流布局 ★★★
    // flex-shrink: 0 确保底部栏不会被压缩
    footer.style.cssText =
      "padding: 10px 15px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 10px; background: #fff; flex-shrink: 0; border-radius: 0 0 12px 12px;";

    // ★★★ 修复关键 3：调整内容区域样式 ★★★
    const body = modalContent.querySelector(".modal-body");
    if (body) {
      // 移除旧的硬编码高度计算
      body.style.height = "auto";
      // 让内容区自动占据剩余空间
      body.style.flex = "1";
      // 确保内容区内部可以滚动
      body.style.overflowY = "auto";
      body.style.padding = "15px";
    }

    modalContent.appendChild(footer);
  }

  // 3. 清空旧按钮，重新生成
  footer.innerHTML = "";

  // -- 创建[关闭]按钮 --
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "关闭";
  closeBtn.className = "cancel";
  closeBtn.onclick = closeFileViewer;

  // -- 创建[分享]按钮 --
  const shareBtn = document.createElement("button");
  shareBtn.textContent = "分享给Ta";
  shareBtn.className = "save";
  shareBtn.onclick = () => {
    openComputerItemShareModal(fileName, decodedContent, "电脑私人文件");
  };

  // 4. 添加到底部栏
  footer.appendChild(closeBtn);
  footer.appendChild(shareBtn);

  modal.classList.add("visible");
}

/**
 * 【全新】关闭文件内容查看器
 */
function closeFileViewer() {
  document.getElementById("kk-file-viewer-modal").classList.remove("visible");
}
// ▼▼▼ 【全新】kk查岗-Steam功能核心函数 ▼▼▼

/**
 * 打开Steam游戏库弹窗并渲染内容
 */
function openSteamScreen() {
  renderSteamScreen();
  document.getElementById("kk-steam-modal").classList.add("visible");
}

/**
 * 渲染Steam游戏库列表
 */
function renderSteamScreen() {
  if (!activeKkCharId) return;
  const computerData = state.chats[activeKkCharId]?.houseData?.computer;
  const games = computerData?.steam_games || [];
  const listEl = document.getElementById("kk-steam-games-list");
  listEl.innerHTML = "";

  if (games.length === 0) {
    listEl.innerHTML =
      '<p style="text-align:center; color: var(--text-secondary); padding: 50px 0;">游戏库是空的，试着点击右上角“+”生成一些游戏吧！</p>';
  } else {
    // 让游戏按时长倒序排列
    games.sort((a, b) => {
      const timeA = parseFloat(a.playtime) || 0;
      const timeB = parseFloat(b.playtime) || 0;
      return timeB - timeA;
    });

    // ... 前面的代码不变 ...
    games.forEach((game, index) => {
      const itemEl = document.createElement("div");
      itemEl.className = "character-data-item";
      // 增加点击手势
      itemEl.style.cursor = "pointer";

      itemEl.innerHTML = `
                <div class="title">${game.name}</div>
                <div class="content">总游玩时长: ${game.playtime}</div>
                <button class="item-delete-btn" data-type="computer.steam_games" data-index="${index}" title="删除这个游戏记录">×</button>
            `;

      // 【新增】绑定点击事件：点击卡片本身触发分享
      itemEl.addEventListener("click", (e) => {
        // 如果点击的是删除按钮，不要触发分享
        if (e.target.classList.contains("item-delete-btn")) return;

        openComputerItemShareModal(
          game.name,
          `游玩时长: ${game.playtime}`,
          "Steam游戏库",
        );
      });

      listEl.appendChild(itemEl);
    });
  }
}

/**
 * 【AI核心】为Steam游戏库生成更多游戏
 */
async function generateMoreSteamGames() {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];
  if (!chat.houseData?.computer) {
    alert("请先为角色生成一次完整的房屋数据。");
    return;
  }

  document.getElementById("generation-overlay").classList.add("visible");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    const existingGames = (chat.houseData.computer.steam_games || [])
      .map((g) => g.name)
      .join(", ");
    const prompt = `
			# 任务
			你是一个游戏数据生成器。请根据角色“${chat.name}”的人设，为他/她的Steam游戏库生成2-3款【全新的】PC游戏记录。

			# 角色人设
			${chat.settings.aiPersona}

			# 已有游戏 (请不要重复生成以下游戏)
			${existingGames || "无"}

			# JSON输出格式 (必须严格遵守)
			{
			  "steam_games": [
			    {"name": "【新游戏名1】", "playtime": "【游玩时长，例如：50 小时】"},
			    {"name": "【新游戏名2】", "playtime": "【游玩时长】"}
			  ]
			}
			`;
    const messagesForApi = [{ role: "user", content: prompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
        });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).replace(/^```json\s*|```$/g, "");
    const newData = JSON.parse(rawContent);

    if (newData.steam_games && Array.isArray(newData.steam_games)) {
      if (!chat.houseData.computer.steam_games) {
        chat.houseData.computer.steam_games = [];
      }
      chat.houseData.computer.steam_games.push(...newData.steam_games);
      await db.chats.put(chat);
      renderSteamScreen();
      alert("已添加新的游戏记录！");
    } else {
      throw new Error("AI返回的数据格式不正确。");
    }
  } catch (error) {
    console.error("生成更多游戏失败:", error);
    await showCustomAlert("生成失败", `发生错误: ${error.message}`);
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}
// ▲▲▲ 新增函数结束 ▲▲▲
/**
 * 【总入口 V2】打开监控视图，并处理数据获取和渲染
 * @param {string} charId - 当前查看的角色ID
 */
async function openSurveillanceView(charId) {
  if (!charId) return;
  const chat = state.chats[charId];
  if (!chat || !chat.houseData) {
    alert("找不到角色的房屋数据，请先生成房屋。");
    return;
  }

  document.getElementById("kk-monitor-title").textContent =
    `${chat.name}的监控中心`;

  const fiveMinutes = 5 * 60 * 1000;
  const surveillance = chat.houseData.surveillanceData;

  if (
    !surveillance ||
    !surveillance.feeds ||
    Date.now() - (surveillance.timestamp || 0) > fiveMinutes
  ) {
    try {
      const newSurveillanceData =
        await generateInitialSurveillanceFeeds(charId);
      if (newSurveillanceData) {
        // ★★★ 核心修改：保存完整的对象，包含时间戳、位置和画面数据 ★★★
        chat.houseData.surveillanceData = {
          timestamp: Date.now(),
          characterLocation: newSurveillanceData.characterLocation,
          feeds: newSurveillanceData.feeds,
        };
        await db.chats.put(chat);
        renderSurveillanceView(chat.houseData.surveillanceData); // 渲染新数据
      } else {
        document.getElementById("kk-monitor-grid").innerHTML =
          '<p style="text-align:center; color: #8a8a8a;">无法生成监控画面。</p>';
      }
    } catch (error) {
      await showCustomAlert("生成失败", `生成监控画面时出错: ${error.message}`);
      return;
    }
  } else {
    console.log("从缓存加载监控画面。");
    // ★★★ 核心修改：直接将保存的完整对象传给渲染函数 ★★★
    renderSurveillanceView(surveillance);
  }

  showScreen("kk-monitor-screen");
}

/**
 * 【AI核心 V2 - 结构化数据】调用AI为指定角色生成所有区域的初次监控画面
 * @param {string} charId - 角色ID
 * @returns {Promise<object|null>} - 包含角色位置和各区域画面的对象，或在失败时返回null
 */
async function generateInitialSurveillanceFeeds(charId) {
  const chat = state.chats[charId];
  showGenerationOverlay("正在接入监控信号...");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    // 提取世界书、聊天记录和用户人设作为上下文
    const worldBookContext = (
      await Promise.all(
        (chat.settings.linkedWorldBookIds || []).map(async (id) => {
          const book = await db.worldBooks.get(id);
          return book ? `\n## 世界书: ${book.name}\n${book.content}` : "";
        }),
      )
    ).join("");

    const recentHistory = chat.history
      .slice(-10)
      .map((msg) => {
        const sender =
          msg.role === "user" ? chat.settings.myNickname || "我" : chat.name;
        return `${sender}: ${msg.content}`;
      })
      .join("\n");

    const userPersona =
      state.chats[charId]?.settings?.myPersona || "一个普通的观察者。";

    const areaNames = Object.keys(chat.houseData.areas);

    const systemPrompt = `
			# 任务
			你是一个全知的监控系统AI。你的任务是根据角色的人设和近期活动，为他家中的【每一个区域】生成实时监控画面描述，并明确指出角色【当前所在】的区域。

			# 角色与观察者信息
			- 角色名: ${chat.name}
			- 角色人设: ${chat.settings.aiPersona}
			- 观察者(用户)人设: ${userPersona}
			${worldBookContext || ""}
			- 最近的聊天记录 (供你参考情景):
			${recentHistory}

			# 住所布局
			角色当前的住所包含以下区域: ${areaNames.join("、 ")}

			# 核心规则
			1.  **视角**: 你的描述必须是【客观、冷静的第三人称视角】，就像一个真正的监控摄像头记录的画面。
			2.  **内容**: 描述【此时此刻】角色可能正在每个区域做什么。如果角色不在某个区域，就描述该区域的静态环境。
			3.  **实时性**: 描述必须体现“现在正在发生”的感觉。
			4.  **【【【格式铁律】】】**: 你的回复【必须且只能】是一个严格的JSON对象。
			    -   该JSON对象必须包含一个顶级键 \`characterLocation\`，其值必须是角色当前所在的区域名字符串 (例如: "卧室")。
			    -   该JSON对象还必须包含一个顶级键 \`feeds\`，其值是一个JSON对象，其中每个键是区域名，每个值是**另一个**JSON对象，包含以下两个字段:
			        -   \`"description"\`: (字符串) 该区域的监控画面描述。
			        -   \`"isCharacterPresent"\`: (布尔值) 角色当前是否在该区域内（true 或 false）。

			# JSON输出格式示例 (必须严格遵守):
			{
			  "characterLocation": "卧室",
			  "feeds": {
			    "客厅": {
			      "description": "客厅里很安静，角色并不在这里。电视屏幕是黑的，沙发上随意搭着一件外套。",
			      "isCharacterPresent": false
			    },
			    "卧室": {
			      "description": "角色正坐在床边，低头看着手机，手指快速地在屏幕上滑动，嘴角似乎带着一丝微笑。",
			      "isCharacterPresent": true
			    }
			  }
			}
			`;

    const messagesForApi = [{ role: "user", content: systemPrompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      systemPrompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.8,
          }),
        });

    if (!response.ok) throw new Error(`API请求失败: ${await response.text()}`);

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).replace(/^```json\s*|```$/g, "");
    const surveillanceData = JSON.parse(rawContent);

    return surveillanceData;
  } catch (error) {
    console.error("生成监控画面失败:", error);
    throw error;
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}

/**
 * 【渲染函数 V2 - 全功能交互版】将监控数据渲染到屏幕上
 * @param {object} surveillanceData - 包含角色位置和画面的完整对象
 */
function renderSurveillanceView(surveillanceData) {
  const gridEl = document.getElementById("kk-monitor-grid");
  gridEl.innerHTML = "";
  const chat = state.chats[activeKkCharId];
  if (!chat) return;

  const { characterLocation, feeds } = surveillanceData;

  if (!feeds || Object.keys(feeds).length === 0) {
    gridEl.innerHTML =
      '<p style="text-align:center; color: #8a8a8a;">无法加载监控画面。</p>';
    return;
  }

  for (const areaName in feeds) {
    const feedData = feeds[areaName];
    const area = chat.houseData.areas[areaName];
    const isCharacterPresent = feedData.isCharacterPresent;

    const feedEl = document.createElement("div");
    feedEl.className = "kk-monitor-item";
    // 将区域名存到 data-* 属性中，方便事件委托时获取
    feedEl.dataset.areaName = areaName;

    if (area && area.imageUrl) {
      feedEl.style.backgroundImage = `url(${area.imageUrl})`;
    } else {
      feedEl.style.backgroundColor = "#333";
    }

    if (areaName === characterLocation) {
      feedEl.classList.add("active-character-location");
    }

    // 只有当角色在该区域时，才显示互动按钮
    const interactionControlsHtml = isCharacterPresent
      ? `
			            <div class="monitor-interaction-controls">
			                <button class="monitor-btn" data-action="reroll" title="重Roll">🔄</button>
			                <button class="monitor-btn" data-action="continue" title="继续监控">➡️</button>
			                <button class="monitor-btn" data-action="speak" title="对话">🎤</button>
			            </div>`
      : "";

    feedEl.innerHTML = `
			            <div class="monitor-header">
			                <span>${areaName}</span>
			                <div class="rec-dot"></div>
			            </div>
			            <div class="frosted-glass-panel">
			                <div class="monitor-content-text">${feedData.description}</div>
			                ${interactionControlsHtml}
			            </div>
			        `;

    gridEl.appendChild(feedEl);
  }
}

/**
 * 【全新升级】处理监控画面中所有互动按钮点击的事件委托
 * 增加了变声器设置面板
 */
async function handleMonitorInteraction(areaName, action, feedElement) {
  const contentTextElement = feedElement.querySelector(".monitor-content-text");
  const currentContent = contentTextElement.textContent; // 获取当前画面内容

  if (action === "speak") {
    // ... (变声器HTML定义部分保持不变) ...
    const extraHtml = `
        <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed #eee; text-align: left;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <span style="font-size: 14px; color: #333; font-weight: 500;">🕵️ 使用变声器</span>
                <label class="toggle-switch" style="transform: scale(0.8);">
                    <input type="checkbox" id="monitor-voice-toggle">
                    <span class="slider"></span>
                </label>
            </div>
            <div id="monitor-voice-input-container" style="display: none; animation: fadeIn 0.3s;">
                <label style="font-size: 12px; color: #666;">伪装身份:</label>
                <input type="text" id="monitor-voice-identity" placeholder="例如: 外卖员, 幽灵 (留空默认为陌生人)" 
                       style="width: 100%; padding: 8px; margin-top: 5px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; font-size: 13px;">
            </div>
        </div>
        `;

    let tempVoiceSettings = { enabled: false, identity: "" };

    const promptPromise = showCustomPrompt(
      `对【${areaName}】喊话`,
      "请输入你想说的话：",
      "",
      "text",
      extraHtml,
    );

    setTimeout(() => {
      const toggle = document.getElementById("monitor-voice-toggle");
      const container = document.getElementById(
        "monitor-voice-input-container",
      );
      const identityInput = document.getElementById("monitor-voice-identity");

      if (toggle && container && identityInput) {
        toggle.addEventListener("change", (e) => {
          tempVoiceSettings.enabled = e.target.checked;
          container.style.display = e.target.checked ? "block" : "none";
          if (e.target.checked) identityInput.focus();
        });
        identityInput.addEventListener("input", (e) => {
          tempVoiceSettings.identity = e.target.value;
        });
      }
    }, 50);

    const userInput = await promptPromise;

    if (userInput && userInput.trim()) {
      // ★★★ 核心修改点：在最后增加传入 currentContent ★★★
      await generateMonitorDialogue(
        areaName,
        userInput,
        contentTextElement,
        tempVoiceSettings,
        currentContent,
      );
    }
  } else {
    // Reroll 和 Continue 逻辑
    const newContent = await generateMonitorUpdate(
      areaName,
      action === "continue" ? currentContent : null, // Continue会传入当前内容
      contentTextElement,
    );
    if (newContent) {
      contentTextElement.innerHTML = newContent;
    }
  }
}

/**
 * 【AI核心】生成监控画面的“下一帧”或“重Roll”
 * @param {string} areaName - 区域名
 * @param {string|null} context - 上一帧的内容（如果是重Roll则为null）
 * @param {HTMLElement} textElement - 用于显示加载状态的文本元素
 * @returns {Promise<string|null>} - 新的画面描述
 */
async function generateMonitorUpdate(areaName, context, textElement) {
  const chat = state.chats[activeKkCharId];
  if (!chat) return null;

  textElement.innerHTML = "<i>正在刷新信号...</i>";

  const { proxyUrl, apiKey, model } = state.apiConfig;
  if (!proxyUrl || !apiKey || !model) {
    textElement.innerHTML = '<i style="color: #ff8a80;">API未配置</i>';
    return null;
  }

  // ★★★ 核心修改：优化Prompt，区分“继续”和“重Roll” ★★★
  let promptInstructions = "";
  if (context) {
    // 这种情况是点击了“继续”箭头
    promptInstructions = `
        # 上一秒的画面 (Context)
        “${context}”
        
        # 任务
        请基于“上一秒的画面”，**顺延时间线**描述下一秒发生了什么。
        行为必须连贯。例如：如果刚才拿起了杯子，现在可能是正在喝水；如果刚才在看手机，现在可能是看到了好笑的消息。
        不要跳跃到完全不相关的动作。
    `;
  } else {
    // 这种情况是点击了“重Roll”刷新
    promptInstructions = `
        # 任务
        请忽略之前的状态，**重新生成**一个该角色在【${areaName}】里的全新随机状态/事件。
    `;
  }

  const prompt = `
			你是一个监控系统AI，正在观察角色“${chat.name}”在【${areaName}】区域的活动。
            角色人设：${chat.settings.aiPersona}
            
            ${promptInstructions}

			你的描述必须是客观的第三人称视角，就像摄像头记录的一样。
			如果角色说话，请用引号包裹。
			你的回复只能是纯文本，不要包含任何JSON或额外说明。
			`;

  try {
    let isGemini = proxyUrl === GEMINI_API_URL;
    let messagesForApi = [{ role: "user", content: prompt }];
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
        });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).trim();
  } catch (error) {
    textElement.innerHTML = `<i style="color: #ff8a80;">信号中断: ${error.message}</i>`;
    return null;
  }
}

/**
 * 【AI核心】处理通过监控进行的对话 (支持变声器 + 用户人设注入 + 上下文感知)
 * @param {string} areaName - 区域名
 * @param {string} userInput - 用户说的话
 * @param {HTMLElement} textElement - 用于显示加载状态的文本元素
 * @param {object} voiceSettings - 变声器设置
 * @param {string} currentContext - ★新增参数：对话发生前的画面描述
 */
async function generateMonitorDialogue(
  areaName,
  userInput,
  textElement,
  voiceSettings,
  currentContext,
) {
  const chat = state.chats[activeKkCharId];
  if (!chat) return;

  textElement.innerHTML = "<i>等待对方回应...</i>";

  const { proxyUrl, apiKey, model } = state.apiConfig;
  if (!proxyUrl || !apiKey || !model) {
    textElement.innerHTML =
      '<i style="color: #ff8a80;">麦克风故障: API未配置</i>';
    return;
  }

  const userNickname =
    chat.settings.myNickname || state.qzoneSettings.nickname || "我";
  const userPersona = chat.settings.myPersona || "没有特定人设，普通用户。";

  let soundSourceDescription = "";
  let uiSourceLabel = "";

  if (voiceSettings && voiceSettings.enabled) {
    const identity = voiceSettings.identity
      ? voiceSettings.identity.trim()
      : "陌生人";
    soundSourceDescription = `监控扬声器里传来一个**经过变声处理的、陌生的声音**。这个声音听起来像是一个【${identity}】。那个声音对你说：“${userInput}”。\n【重要指令】：你完全没有听出这是${userNickname}的声音。`;
    uiSourceLabel = `(伪装成: ${identity})`;
  } else {
    soundSourceDescription = `监控扬声器里传来了你非常熟悉的、用户（${userNickname}）的声音。${userNickname}通过监控对你说：“${userInput}”。\n# 说话人（${userNickname}）的人设：${userPersona}\n【重要指令】：你立刻就听出了这是${userNickname}的声音，请自然互动。`;
    uiSourceLabel = `(你)`;
  }

  // ★★★ 核心修改：在Prompt中加入当前上下文 ★★★
  const prompt = `
    # 角色扮演任务
    你现在是角色“${chat.name}”，你正在【${areaName}】里。
    
    # 此时此刻的状态 (上下文)
    就在刚才，**${currentContext || "你在房间里发呆"}**。
    
    # 突发事件
    突然，${soundSourceDescription}

    # 你的角色人设
    ${chat.settings.aiPersona}

    # 你的任务
    请以【第一人称】，**紧接着刚才的状态**，对这句突如其来的话做出【反应】。
    如果刚才你在睡觉，你现在可能被吵醒；如果刚才你在看书，你可能会放下书。
    你的回复应该包含你的【心理活动、动作、以及说出的话】。
    你的回复只能是纯文本。
    `;

  try {
    let isGemini = proxyUrl === GEMINI_API_URL;
    let messagesForApi = [{ role: "user", content: prompt }];
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.8,
          }),
        });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const aiResponse = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).trim();

    textElement.innerHTML = `“${userInput}” <i style="font-size:12px; opacity:0.8;">${uiSourceLabel}</i><br><br>${aiResponse}`;
  } catch (error) {
    textElement.innerHTML = `<i style="color: #ff8a80;">通讯失败: ${error.message}</i>`;
  }
}

/**
 * 【AI核心 V2 - 智能移动版】当用户点击“刷新”时，生成所有区域的新状态
 * @param {string} charId - 角色ID
 * @returns {Promise<object|null>} - 新的完整监控数据
 */
async function generateSurveillanceUpdate(charId) {
  const chat = state.chats[charId];
  if (!chat || !chat.houseData) return null;

  showGenerationOverlay("正在刷新所有监控...");

  const lastSurveillance = chat.houseData.surveillanceData;

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    const systemPrompt = `
			# 任务
			你是一个全知的监控系统AI。你的任务是基于角色“${
        chat.name
      }”的【上一个状态】，推断出【下一秒钟】他可能做的行动，并更新所有监控区域的画面。他可能会从一个房间移动到另一个房间。

			# 角色信息
			- 人设: ${chat.settings.aiPersona}

			# 上一秒的监控状态 (重要参考)
			${JSON.stringify(lastSurveillance, null, 2)}

			# 核心规则
			1.  **逻辑连贯**: 你的更新必须基于上一秒的状态，做出合乎逻辑的推断。例如，如果上一秒在卧室看手机，下一秒可能是继续看、放下手机准备睡觉，或是走出卧室去客厅。
			2.  **角色移动**: 角色【有可能】移动到新的区域。你【必须】在 \`characterLocation\` 字段中准确指出他的新位置。
			3.  **状态更新**: 【所有】区域的画面描述都必须更新。如果角色进入了新区域，该区域的 \`isCharacterPresent\` 必须变为 \`true\`，旧区域的必须变为 \`false\`。
			4.  **格式铁律**: 你的回复【必须】严格遵守与初始生成时完全相同的JSON格式。

			现在，请生成下一秒的完整监控数据。
			`;

    const messagesForApi = [{ role: "user", content: systemPrompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      systemPrompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.8,
          }),
        });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).replace(/^```json\s*|```$/g, "");
    return JSON.parse(rawContent);
  } catch (error) {
    console.error("刷新监控画面失败:", error);
    await showCustomAlert("刷新失败", `发生错误: ${error.message}`);
    return null;
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}
/**
 * 【全新】显示加载动画并设置指定的文字
 * @param {string} text - 要显示的加载提示文字
 */
function showGenerationOverlay(text) {
  const overlay = document.getElementById("generation-overlay");
  const textElement = document.getElementById("generation-text");
  if (textElement) {
    textElement.textContent = text;
  }
  overlay.classList.add("visible");
}
/* ================= KK查岗 - 沉浸式衣帽间 ================= */

// 当前选中的标签页
let activeWardrobeCategory = "上装";

// 1. 更新搭配对象，增加新分类
let currentOutfit = {
  头饰: null, // 细分出的配饰
  上装: null,
  下装: null,
  鞋子: null, // 新增
  首饰: null, // 细分出的配饰
  特殊: null,
};

/**
 * 2. 替换 openKkWardrobe 函数 (最终修复版：独立工具栏，不遮挡任何东西)
 */
async function openKkWardrobe() {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];

  // 检查是否有房屋数据
  if (!chat || !chat.houseData) {
    alert("请先点击“开始翻找”生成房屋数据后，再查看衣柜。");
    return;
  }

  // 检查是否有衣柜数据，没有则生成
  if (!chat.houseData.wardrobe) {
    const confirmed = await showCustomConfirm(
      "发现衣柜",
      `你推开了卧室的衣柜门...\n\n里面空荡荡的，要让AI生成${chat.name}的衣服吗？`,
      { confirmText: "生成衣柜" },
    );
    if (confirmed) {
      await generateWardrobeData(activeKkCharId);
    } else {
      return;
    }
  }

  // 初始化界面状态
  currentOutfit = {
    头饰: null,
    上装: null,
    下装: null,
    鞋子: null,
    首饰: null,
    特殊: null,
  };
  document.getElementById("wardrobe-reaction-bubble").style.display = "none";
  document.getElementById("wardrobe-try-on-btn").disabled = true;
  document.getElementById("wardrobe-try-on-btn").textContent = "让Ta穿上";

  // 设置头像
  document.getElementById("wardrobe-char-avatar").src =
    chat.settings.aiAvatar || defaultAvatar;

  // 1. 更新搭配槽位 (HTML)
  const displayContainer = document.getElementById("current-outfit-display");

  // 清除旧的悬浮按钮（如果之前生成过，防止残留）
  const oldFloatBtn = document.getElementById("wardrobe-history-floating-btn");
  if (oldFloatBtn) oldFloatBtn.remove();

  displayContainer.innerHTML = `
        <div class="outfit-slot" data-type="头饰" data-placeholder="头饰"></div>
        <div class="outfit-slot" data-type="上装" data-placeholder="上衣"></div>
        <div class="outfit-slot" data-type="下装" data-placeholder="下装"></div>
        <div class="outfit-slot" data-type="鞋子" data-placeholder="鞋子"></div>
        <div class="outfit-slot" data-type="首饰" data-placeholder="首饰"></div>
        <div class="outfit-slot" data-type="特殊" data-placeholder="特殊"></div>
    `;

  // 2. 更新分类标签页 (HTML)
  const tabsContainer = document.querySelector(
    "#wardrobe-inventory-area .wardrobe-tabs",
  );
  tabsContainer.innerHTML = `
        <div class="wardrobe-tab active" data-cat="头饰">头饰</div>
        <div class="wardrobe-tab" data-cat="上装">上装</div>
        <div class="wardrobe-tab" data-cat="下装">下装</div>
        <div class="wardrobe-tab" data-cat="鞋子">鞋子</div>
        <div class="wardrobe-tab" data-cat="首饰">首饰</div>
        <div class="wardrobe-tab" data-cat="特殊">特殊</div>
    `;

  // ★★★★★ 修复重点：插入独立工具栏 ★★★★★
  // 我们找到 Inventory Area (库存区域)，把按钮插在 标签页(tabs) 的正上方
  const inventoryArea = document.getElementById("wardrobe-inventory-area");

  // 检查是否已经创建了工具栏容器
  let toolbar = document.getElementById("wardrobe-toolbar-row");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.id = "wardrobe-toolbar-row";
    // 样式：右对齐，留一点内边距，放在标准流中
    toolbar.style.cssText = `
          display: flex; 
          justify-content: flex-end; 
          padding: 5px 15px 0 15px; 
          margin-bottom: 5px;
      `;

    // 把它插入到 tabsContainer 的前面 (即：搭配展示区 和 标签页 之间)
    inventoryArea.insertBefore(toolbar, tabsContainer);
  }

  // 清空工具栏并添加按钮
  toolbar.innerHTML = "";

  const historyBtn = document.createElement("button");
  historyBtn.innerHTML = "📜 历史搭配";
  // 按钮样式：小巧一点，不喧宾夺主
  historyBtn.style.cssText = `
      background: rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 12px;
      color: #555;
      cursor: pointer;
  `;
  historyBtn.onclick = openWardrobeHistory;

  toolbar.appendChild(historyBtn);
  // ★★★★★ 修复结束 ★★★★★

  // 重置当前标签页为“上装”
  activeWardrobeCategory = "上装";

  // 渲染
  renderWardrobeUI();
  showScreen("kk-wardrobe-screen");
}

/**
 * 2. 核心渲染函数：渲染分类标签、网格和选中状态
 */
function renderWardrobeUI() {
  const chat = state.chats[activeKkCharId];
  const items = chat.houseData.wardrobe || [];

  // 1. 更新顶部搭配槽的显示
  const slots = document.querySelectorAll(".outfit-slot");
  slots.forEach((slot) => {
    const type = slot.dataset.type;
    const selectedItem = currentOutfit[type];

    if (selectedItem) {
      slot.classList.add("filled");
      slot.innerHTML = selectedItem.icon;
      // 点击槽位可以取消选择
      slot.onclick = () => selectCloth(type, null);
    } else {
      slot.classList.remove("filled");
      slot.innerHTML = "";
      slot.onclick = null;
    }
  });

  // 2. 更新“穿上”按钮状态 (至少选一件)
  const hasSelection = Object.values(currentOutfit).some((v) => v !== null);
  const btn = document.getElementById("wardrobe-try-on-btn");
  btn.disabled = !hasSelection;

  // 3. 渲染底部库存网格
  const grid = document.getElementById("wardrobe-grid");
  grid.innerHTML = "";

  // 筛选当前标签页的衣服
  const filteredItems = items.filter((item) => {
    if (activeWardrobeCategory === "其他") {
      return !["上装", "下装", "配饰", "特殊"].includes(item.category);
    }
    return item.category === activeWardrobeCategory;
  });

  if (filteredItems.length === 0) {
    grid.innerHTML =
      '<p style="grid-column:1/-1; text-align:center; color:#999; margin-top:20px;">这个分类下没有衣服哦</p>';
  } else {
    filteredItems.forEach((item) => {
      const card = document.createElement("div");
      card.className = "cloth-card";

      // 检查是否被选中
      if (
        currentOutfit[item.category] &&
        currentOutfit[item.category].name === item.name
      ) {
        card.classList.add("selected");
      }

      card.innerHTML = `
                <div class="cloth-icon">${item.icon || "👕"}</div>
                <div class="cloth-name">${item.name}</div>
                <div class="cloth-desc">${item.description}</div>
            `;

      // 点击卡片：选中或取消
      card.addEventListener("click", () => {
        // 如果已经选中，则取消；否则选中
        if (
          currentOutfit[item.category] &&
          currentOutfit[item.category].name === item.name
        ) {
          selectCloth(item.category, null);
        } else {
          selectCloth(item.category, item);
        }
      });

      grid.appendChild(card);
    });
  }

  // 4. 更新标签页高亮
  document.querySelectorAll(".wardrobe-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.cat === activeWardrobeCategory);
  });
}

/**
 * 辅助：选择衣服
 */
function selectCloth(category, item) {
  currentOutfit[category] = item;
  // 隐藏之前的反应气泡，因为搭配变了
  document.getElementById("wardrobe-reaction-bubble").style.display = "none";
  document.getElementById("wardrobe-try-on-btn").textContent = "让Ta穿上";
  renderWardrobeUI();
}

/**
 * 3. 核心功能：试穿并触发AI反应 (修改版：增加历史记录保存功能)
 */
async function handleTryOn() {
  const chat = state.chats[activeKkCharId];
  if (!chat) return;

  // 1. 收集选中的衣服
  const selectedItems = Object.values(currentOutfit).filter((i) => i !== null);
  if (selectedItems.length === 0) return;

  // 2. 界面进入加载状态
  const btn = document.getElementById("wardrobe-try-on-btn");
  btn.disabled = true;
  btn.textContent = "正在换装...";
  document.getElementById("wardrobe-comment-bubble").style.display = "none";
  const bubble = document.getElementById("wardrobe-reaction-bubble");
  bubble.style.display = "none";

  try {
    // --- 构建搭配描述 ---
    const outfitNames = selectedItems.map((i) => i.name).join(" + ");
    const outfitDesc = selectedItems
      .map((i) => `【${i.category}】${i.name} (${i.description})`)
      .join(" + ");

    // --- 步骤 A: 更新心声 (保持原逻辑) ---
    if (!chat.latestInnerVoice) {
      chat.latestInnerVoice = {
        clothing: "",
        behavior: "",
        thoughts: "",
        naughtyThoughts: "",
      };
    }
    chat.latestInnerVoice.clothing = `穿着${outfitNames}`;
    if (!chat.innerVoiceHistory) chat.innerVoiceHistory = [];
    chat.innerVoiceHistory.push({
      ...chat.latestInnerVoice,
      timestamp: Date.now(),
    });

    const hiddenComments = selectedItems
      .map((i) =>
        i.charComment ? `(关于${i.name}的内心想法: ${i.charComment})` : "",
      )
      .join(" ");

    const prompt = `
        # 场景
        用户在你的衣柜里挑选了一套衣服，并要求你穿上。
        # 你的角色
        ${chat.settings.aiPersona}
        # 用户搭配的衣服
        ${outfitDesc}
        ${hiddenComments}
        # 任务
        请以第一人称，做出穿上这套衣服后的反应。
        你需要结合你的人设、衣服的风格（是羞耻、日常、还是华丽？）以及用户强行搭配的行为，给出一句有画面感的回复。
        回复中必须包含【动作】或【神态】描写。
        # 格式要求
        只返回纯文本，不要JSON。字数在30-60字之间。
        `;

    // 4. 调用API
    const { proxyUrl, apiKey, model } = state.apiConfig;
    let isGemini = proxyUrl === GEMINI_API_URL;
    const messagesForApi = [{ role: "user", content: prompt }];
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
        });

    if (!response.ok) throw new Error("API请求失败");
    const data = await response.json();
    const reactionText = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    ).trim();

    // ================== ★★★ 新增：保存历史搭配记录 ★★★ ==================
    if (!chat.houseData.wardrobeHistory) {
      chat.houseData.wardrobeHistory = [];
    }

    // 创建一条历史记录对象
    const historyEntry = {
      id: Date.now(), // 唯一ID
      timestamp: Date.now(), // 时间戳
      dateStr: new Date().toLocaleString(), // 可读时间
      items: selectedItems, // 具体的衣服对象数组
      summary: outfitNames, // 衣服名字组合字符串
      reaction: reactionText, // AI当时的评价
    };

    // 加到数组最前面
    chat.houseData.wardrobeHistory.unshift(historyEntry);

    // 为了防止记录无限膨胀，只保留最近50条
    if (chat.houseData.wardrobeHistory.length > 50) {
      chat.houseData.wardrobeHistory = chat.houseData.wardrobeHistory.slice(
        0,
        50,
      );
    }

    // 立即保存到数据库，确保记录不丢失
    await db.chats.put(chat);
    console.log("已保存搭配历史:", historyEntry);
    // ====================================================================

    // --- 步骤 B: 弹出确认框 (保持原逻辑) ---
    const now = Date.now();
    const wantToDiscuss = await showCustomConfirm(
      "换装完成",
      `${chat.name} 换上了【${outfitNames}】并说道：\n\n“${reactionText}”\n\n要去聊天界面和Ta继续讨论这套搭配吗？`,
      { confirmText: "去讨论", cancelText: "就在这看" },
    );

    if (wantToDiscuss) {
      const eventMsg = {
        role: "system",
        type: "pat_message",
        content: `[你为 ${chat.name} 换上了：${outfitNames}]`,
        timestamp: now,
      };
      const aiMsg = {
        role: "assistant",
        senderName: chat.name,
        content: reactionText,
        timestamp: now + 1,
      };
      const hiddenInstruction = {
        role: "system",
        content: `[系统提示：用户刚刚在衣帽间为你换上了【${outfitDesc}】。你的当前服装已更新。请基于这个新造型和用户继续对话。]`,
        timestamp: now + 2,
        isHidden: true,
      };
      chat.history.push(eventMsg, aiMsg, hiddenInstruction);
      await db.chats.put(chat);
      openChat(activeKkCharId);
    } else {
      bubble.querySelector(".content").textContent = reactionText;
      bubble.style.display = "block";
      btn.textContent = "已换装";
    }
  } catch (error) {
    console.error("试穿失败:", error);
    alert("换装失败了，可能是因为衣服太紧（API错误）...");
  } finally {
    btn.disabled = false;
  }
}

// ================= KK查岗 - 沉浸式衣帽间 (升级版) =================

// 辅助函数：生成衣服图片 (使用 Pollinations，因为它生成物品效果好且快，无需鉴权)
async function generateClothingImage(prompt) {
  // 强制加上白底、产品摄影等关键词
  const enhancedPrompt = `clothing product photography, ${prompt}, white background, flat lay style, studio lighting, high quality, 4k, realistic, no human`;
  const encodedPrompt = encodeURIComponent(enhancedPrompt);
  // 使用随机数防止缓存
  const randomSeed = Math.floor(Math.random() * 10000);
  return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&seed=${randomSeed}`;
}

/**
 * 核心渲染函数：渲染分类标签、网格和选中状态
 * (修改版：支持显示图片)
 */
function renderWardrobeUI() {
  const chat = state.chats[activeKkCharId];
  const items = chat.houseData.wardrobe || [];

  // 1. 更新顶部搭配槽的显示
  const slots = document.querySelectorAll(".outfit-slot");
  slots.forEach((slot) => {
    const type = slot.dataset.type;
    const selectedItem = currentOutfit[type];

    if (selectedItem) {
      slot.classList.add("filled");
      // 如果有图片，显示图片；否则显示 emoji
      if (selectedItem.imageUrl) {
        slot.innerHTML = `<img src="${selectedItem.imageUrl}" style="width:100%; height:100%; object-fit:contain;">`;
      } else {
        slot.innerHTML = selectedItem.icon || "👕";
      }
      slot.onclick = () => selectCloth(type, null);
    } else {
      slot.classList.remove("filled");
      slot.innerHTML = slot.dataset.placeholder; // 显示占位文字
      slot.onclick = null;
    }
  });

  // 2. 更新“穿上”按钮状态
  const hasSelection = Object.values(currentOutfit).some((v) => v !== null);
  const btn = document.getElementById("wardrobe-try-on-btn");
  if (btn) btn.disabled = !hasSelection;

  // 3. 渲染底部库存网格
  const grid = document.getElementById("wardrobe-grid");
  grid.innerHTML = "";

  const filteredItems = items.filter(
    (item) => item.category === activeWardrobeCategory,
  );

  if (filteredItems.length === 0) {
    grid.innerHTML =
      '<p style="grid-column:1/-1; text-align:center; color:#999; margin-top:20px;">这个分类下没有衣服哦</p>';
  } else {
    filteredItems.forEach((item) => {
      const card = document.createElement("div");
      card.className = "cloth-card";

      // 检查是否被选中
      if (
        currentOutfit[item.category] &&
        currentOutfit[item.category].name === item.name
      ) {
        card.classList.add("selected");
      }

      // 图片显示逻辑
      let visualContent;
      if (item.imageUrl) {
        visualContent = `<img src="${item.imageUrl}" class="cloth-img" style="width:100%; height:80px; object-fit:contain; border-radius:4px;" loading="lazy">`;
      } else {
        visualContent = `<div class="cloth-icon" style="font-size:40px;">${item.icon || "👕"}</div>`;
      }

      card.innerHTML = `
                ${visualContent}
                <div class="cloth-name" style="font-size:12px; margin-top:5px; font-weight:bold;">${item.name}</div>
            `;

      // 点击卡片：选中或取消
      card.addEventListener("click", () => {
        if (
          currentOutfit[item.category] &&
          currentOutfit[item.category].name === item.name
        ) {
          selectCloth(item.category, null);
        } else {
          selectCloth(item.category, item);
        }
      });

      grid.appendChild(card);
    });
  }

  // 4. 更新标签页高亮
  document.querySelectorAll(".wardrobe-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.cat === activeWardrobeCategory);
  });
}

/**
 * 辅助：选择衣服 (修改版：显示看法)
 */
function selectCloth(category, item) {
  currentOutfit[category] = item;

  const commentBubble = document.getElementById("wardrobe-comment-bubble");
  const reactionBubble = document.getElementById("wardrobe-reaction-bubble");
  const tryOnBtn = document.getElementById("wardrobe-try-on-btn");

  // 隐藏试穿反应，显示物品看法
  reactionBubble.style.display = "none";
  commentBubble.style.display = "block";

  if (item) {
    // 如果选中了衣服，显示该衣服的评论
    commentBubble.querySelector(".content").innerHTML =
      `<strong>${item.name}</strong><br>"${item.charComment}"`;
  } else {
    // 如果取消选择，显示默认提示
    commentBubble.querySelector(".content").textContent =
      "（在身上比划了一下...）";
  }

  tryOnBtn.textContent = "让Ta穿上";
  renderWardrobeUI();
}

/**
 * 【AI核心】生成衣柜数据 (修改版：包含新分类 + 逐个生成 + 实时保存)
 */
async function generateWardrobeData(charId) {
  const chat = state.chats[charId];
  showGenerationOverlay("正在偷偷打开衣柜...");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    const prompt = `
        # 任务
        你现在是角色 "${chat.name}"。用户正在查看你的【私人衣柜】。
        请根据你的人设，生成你的衣柜内容。

        # 角色人设
        ${chat.settings.aiPersona}

        # 核心要求
        1. **生成分类**：必须包含以下分类：【头饰】、【上装】、【下装】、【鞋子】、【首饰】、【特殊】。
        2. **生成数量**：每个分类生成1-2件，总共生成 10-15 件单品。
        3. **内容细节**：
           - "category": 必须是上述分类之一。
           - "name": 衣服名称。
           - "icon": emoji。
           - "description": 简短描述。
           - "imagePrompt": **重要！** 用于生成该衣服图片的英文 Prompt。必须描述衣服的外观、颜色、材质，**不要包含人物**，强调是单品展示 (e.g., "a pair of red high heels, product photography, white background")。
           - "charComment": **重点！** 以【第一人称】写下你对这件衣服的看法（吐槽、回忆、羞耻感等）。

        # JSON输出格式
        {
          "wardrobe": [
            {
              "category": "鞋子",
              "name": "红色高跟鞋",
              "icon": "👠",
              "description": "漆皮红底高跟鞋。",
              "imagePrompt": "red patent leather high heels, side view, elegant, product photography, white background",
              "charComment": "只有重要场合才会穿..."
            }
          ]
        }
        `;

    const messagesForApi = [{ role: "user", content: prompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.85,
          }),
        });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    )
      .replace(/^```json\s*|```$/g, "")
      .trim();

    const result = JSON.parse(rawContent);

    if (result && result.wardrobe) {
      // 1. 先保存文字数据，确保即使生图失败，物品也在
      chat.houseData.wardrobe = result.wardrobe;
      await db.chats.put(chat);

      // 2. --- 逐个生成图片并实时保存 (串行队列) ---
      const total = result.wardrobe.length;
      const overlayText = document.getElementById("generation-text");

      for (let i = 0; i < total; i++) {
        const item = chat.houseData.wardrobe[i]; // 直接操作 chat 对象里的数据引用

        // 更新UI提示
        if (overlayText) {
          overlayText.textContent = `正在为衣服拍照 (${i + 1}/${total}): ${item.name}...`;
        }

        if (item.imagePrompt) {
          try {
            // 生成图片
            const url = await generateClothingImage(item.imagePrompt);
            // 更新内存数据
            item.imageUrl = url;
            // ★★★ 核心：每生成一张，立刻保存一次数据库 ★★★
            await db.chats.put(chat);
            console.log(`✅ 已保存图片: ${item.name}`);
          } catch (e) {
            console.error(`❌ 图片生成失败: ${item.name}`, e);
          }
        }

        // 可选：稍微延迟一下，防止请求过快
        await new Promise((r) => setTimeout(r, 500));
      }

      alert("衣柜整理完毕！");
      // 如果当前还在衣柜界面，刷新一下图片显示
      if (
        document
          .getElementById("kk-wardrobe-screen")
          .classList.contains("active")
      ) {
        renderWardrobeUI();
      }
    } else {
      throw new Error("AI返回数据格式错误");
    }
  } catch (error) {
    console.error("生成衣柜失败:", error);
    await showCustomAlert("生成失败", `错误: ${error.message}`);
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}

/**
 * 【新增】添加更多衣服 (追加模式 - 包含新分类 + 逐个生成 + 实时保存)
 */
async function generateMoreWardrobeData() {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];

  showGenerationOverlay("正在去商场进货...");

  try {
    const { proxyUrl, apiKey, model } = state.apiConfig;
    if (!proxyUrl || !apiKey || !model) throw new Error("API未配置");

    // 获取现有衣服名称，避免重复
    const existingClothes = (chat.houseData.wardrobe || [])
      .map((i) => i.name)
      .join(", ");

    const prompt = `
        # 任务
        你现在是角色 "${chat.name}"。请为你的衣柜【添置】3-5件新衣服。
        
        # 角色人设
        ${chat.settings.aiPersona}

        # 已有衣服 (不要重复)
        ${existingClothes}

        # 要求
        1. 包含不同品类（可以是 头饰、上装、下装、鞋子、首饰、特殊）。
        2. 必须包含 "imagePrompt" (英文, 白底产品图描述) 和 "charComment" (第一人称看法)。
        
        # JSON输出格式
        {
          "new_items": [
            { "category": "鞋子", "name": "...", "icon": "...", "description": "...", "imagePrompt": "...", "charComment": "..." }
          ]
        }
        `;

    const messagesForApi = [{ role: "user", content: prompt }];
    let isGemini = proxyUrl === GEMINI_API_URL;
    let geminiConfig = toGeminiRequestData(
      model,
      apiKey,
      prompt,
      messagesForApi,
      isGemini,
    );

    const response = isGemini
      ? await fetch(geminiConfig.url, geminiConfig.data)
      : await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            messages: messagesForApi,
            temperature: 0.9,
          }),
        });

    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    const rawContent = (
      isGemini
        ? data.candidates[0].content.parts[0].text
        : data.choices[0].message.content
    )
      .replace(/^```json\s*|```$/g, "")
      .trim();
    const result = JSON.parse(rawContent);

    if (result && result.new_items) {
      // 1. 先把新物品加入到数组并保存文字版
      if (!chat.houseData.wardrobe) chat.houseData.wardrobe = [];

      // 获取当前数组的起始索引，方便后面定位新物品
      const startIndex = chat.houseData.wardrobe.length;

      chat.houseData.wardrobe.push(...result.new_items);
      await db.chats.put(chat); // 保存文字数据

      // 2. --- 逐个生成图片并实时保存 ---
      const total = result.new_items.length;
      const overlayText = document.getElementById("generation-text");

      for (let i = 0; i < total; i++) {
        // 定位到刚刚添加进去的那个物品
        const itemIndex = startIndex + i;
        const item = chat.houseData.wardrobe[itemIndex];

        if (overlayText) {
          overlayText.textContent = `正在为新衣服拍照 (${i + 1}/${total}): ${item.name}...`;
        }

        if (item.imagePrompt) {
          try {
            const url = await generateClothingImage(item.imagePrompt);
            item.imageUrl = url; // 更新内存引用
            await db.chats.put(chat); // ★★★ 实时保存 ★★★
          } catch (e) {
            console.error("图片生成失败", e);
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // 刷新界面
      renderWardrobeUI();
      alert(`成功添加了 ${result.new_items.length} 件新衣服！`);
    }
  } catch (error) {
    console.error("添加衣服失败:", error);
    await showCustomAlert("添加失败", error.message);
  } finally {
    document.getElementById("generation-overlay").classList.remove("visible");
  }
}

// =======================================================
// 绑定新按钮的事件 (请把这段加在 init() 的事件绑定区域)
// =======================================================
// 绑定“添加衣服”按钮
const addClothBtn = document.getElementById("kk-wardrobe-add-btn");
if (addClothBtn) {
  // 防止重复绑定，先移除旧的
  const newBtn = addClothBtn.cloneNode(true);
  addClothBtn.parentNode.replaceChild(newBtn, addClothBtn);
  newBtn.addEventListener("click", generateMoreWardrobeData);
}
/**
 * 【新增】打开历史搭配记录列表
 */
function openWardrobeHistory() {
  const chat = state.chats[activeKkCharId];
  if (!chat || !chat.houseData || !chat.houseData.wardrobeHistory) {
    showCustomAlert("暂无记录", "还没有进行过换装搭配哦。");
    return;
  }

  const historyList = chat.houseData.wardrobeHistory;
  const listEl = document.getElementById("kk-file-list"); // 复用文件列表容器
  const modal = document.getElementById("kk-file-explorer-modal"); // 复用通用列表弹窗

  // 修改弹窗标题
  modal.querySelector(".modal-header span").textContent =
    `${chat.name}的穿搭日记`;
  listEl.innerHTML = "";

  if (historyList.length === 0) {
    listEl.innerHTML =
      '<p style="text-align:center; color: var(--text-secondary);">暂无记录</p>';
  } else {
    historyList.forEach((entry) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "kk-file-item"; // 复用样式
      itemDiv.style.cssText =
        "cursor: pointer; display: flex; flex-direction: column; gap: 5px; padding: 10px; border-bottom: 1px solid #eee;";

      // 格式化时间
      const timeStr = new Date(entry.timestamp).toLocaleString();

      itemDiv.innerHTML = `
                <div style="display:flex; justify-content:space-between; font-size:12px; color:#999;">
                    <span>${timeStr}</span>
                </div>
                <div style="font-weight:bold; color:#333;">${entry.summary}</div>
                <div style="font-size:13px; color:#666; font-style:italic;">“${entry.reaction.substring(0, 30)}${
                  entry.reaction.length > 30 ? "..." : ""
                }”</div>
            `;

      // 点击查看详情
      itemDiv.addEventListener("click", () => {
        showHistoryDetail(entry);
      });

      listEl.appendChild(itemDiv);
    });
  }

  modal.classList.add("visible");
}

/**
 * 【新增】查看某一条历史记录的详情
 */
function showHistoryDetail(entry) {
  // 这里我们复用“物品分享弹窗”来显示详情，简单快捷
  const modal = document.getElementById("kk-item-share-modal");
  const title = document.getElementById("kk-item-share-title");
  const contentDiv = document.getElementById("kk-item-share-content");
  const shareBtn = document.getElementById("kk-item-share-confirm-btn");

  title.textContent = "搭配详情";

  // 构建详情内容
  let detailHtml = `
        <div style="text-align:left; font-size:14px;">
            <p><strong>📅 时间:</strong> ${new Date(entry.timestamp).toLocaleString()}</p>
            <p><strong>👗 搭配方案:</strong><br>${entry.summary}</p>
            <hr style="margin:10px 0; border:0; border-top:1px dashed #ccc;">
            <p><strong>🗣️ 当时评价:</strong><br>“${entry.reaction}”</p>
        </div>
    `;

  // 如果支持innerHTML，可以直接塞进去，如果你的contentDiv只支持text，则需要改一下结构
  // 假设 contentDiv 是个 div，我们先清空再塞 HTML
  contentDiv.innerHTML = detailHtml;

  // 修改按钮功能为“再次穿上” (高级功能，可选)
  const newShareBtn = shareBtn.cloneNode(true);
  shareBtn.parentNode.replaceChild(newShareBtn, shareBtn);

  newShareBtn.textContent = "分享/回顾";
  newShareBtn.onclick = () => {
    shareKkItemToChat(
      "历史记录",
      `回顾了之前的造型：${entry.summary}`,
      `当时的评价：${entry.reaction}`,
    );
    modal.classList.remove("visible");
  };

  modal.classList.add("visible");
}

/* ================= KK查岗 - 缺失依赖补全 & 事件绑定 (集成补丁) ================= */

/**
 * 补全：格式化单条消息用于跨聊天上下文注入 (linkedMemories 用)
 */
/**
 * 补全：格式化单条消息用于跨聊天上下文注入 (linkedMemories 用)
 * (这是从原项目 index.html 里找到的真实实现，原样移植)
 */
function formatMessageForContext(msg, chat) {
  let senderName = "";
  if (msg.role === "user") {
    senderName = chat?.isGroup ? chat.settings.myNickname || "我" : "我";
  } else {
    senderName = msg.senderName || chat?.name || "TA";
  }

  let contentText = "";
  if (
    msg.type === "sticker" ||
    (typeof msg.content === "string" && typeof STICKER_REGEX !== "undefined" && STICKER_REGEX.test(msg.content))
  ) {
    contentText = msg.meaning ? `[表情: ${msg.meaning}]` : "[表情]";
  } else if (
    msg.type === "ai_image" ||
    msg.type === "user_photo" ||
    Array.isArray(msg.content)
  ) {
    contentText = "[图片]";
  } else if (msg.type === "voice_message") {
    contentText = `[语音]: ${msg.content}`;
  } else if (msg.type === "transfer") {
    contentText = `[转账] 金额: ${msg.amount}, 备注: ${msg.note || "无"}`;
  } else {
    contentText = String(msg.content || "");
  }

  const date = new Date(msg.timestamp);
  const formattedDate = date.toLocaleString();
  return `${formattedDate} ${senderName}: ${contentText}`;
}

/**
 * 补全：房屋/区域整体场景图生成 (原引用的 generateAndLoadImage 缺失)
 * (这是从原项目 taobao.js 里找到的真实实现，原样移植：Pollinations 主备双域名 + 无限重试)
 */
async function generateAndLoadImage(prompt) {
  while (true) {
    try {
      const encodedPrompt = encodeURIComponent(prompt);
      const seed = Math.floor(Math.random() * 100000);
      const primaryUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=640&seed=${seed}`;

      const loadImage = (url) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.src = url;
          img.onload = () => resolve(url);
          img.onerror = () => reject(new Error(`URL加载失败: ${url}`));
        });

      const imageUrl = await loadImage(primaryUrl).catch(async () => {
        console.warn(`主URL加载失败，尝试备用URL for: ${prompt}`);
        const fallbackUrl = `https://pollinations.ai/p/${encodedPrompt}?width=1024&height=640&seed=${seed}`;
        return await loadImage(fallbackUrl);
      });

      return imageUrl;
    } catch (error) {
      console.error(`图片生成彻底失败，将在5秒后重试。错误: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * 补全：监控中心右上角"全部刷新"按钮的入口封装
 */
async function refreshAllKkMonitors() {
  if (!activeKkCharId) return;
  const newData = await generateSurveillanceUpdate(activeKkCharId);
  if (newData) {
    const chat = state.chats[activeKkCharId];
    chat.houseData.surveillanceData = {
      timestamp: Date.now(),
      characterLocation: newData.characterLocation,
      feeds: newData.feeds,
    };
    await db.chats.put(chat);
    renderSurveillanceView(chat.houseData.surveillanceData);
  }
}

/**
 * 补全：删除Steam游戏记录
 */
async function handleDeleteKkSteamGame(index) {
  if (!activeKkCharId) return;
  const chat = state.chats[activeKkCharId];
  const games = chat?.houseData?.computer?.steam_games;
  if (!games || !games[index]) return;
  const confirmed = await showCustomConfirm("删除记录", `确定要删除“${games[index].name}”这条游戏记录吗？`, { confirmButtonClass: "btn-danger" });
  if (!confirmed) return;
  games.splice(index, 1);
  await db.chats.put(chat);
  renderSteamScreen();
}

/**
 * 打开隐秘文件夹 (与原项目行为一致：先弹出"加密访问"确认，确认后走物品分享弹窗)
 */
function openKkSecretFolder() {
  const chat = state.chats[activeKkCharId];
  const secretFolder = chat?.houseData?.computer?.secret_folder;
  if (!secretFolder) {
    showCustomAlert("未发现", "没有找到隐秘文件夹。");
    return;
  }
  showCustomConfirm(
    "加密访问",
    `你尝试打开文件 "${secretFolder.fileName}"。<br><br>这是一个加密文件夹，是否继续访问？`,
  ).then((confirmed) => {
    if (confirmed) {
      openComputerItemShareModal(secretFolder.fileName, secretFolder.content, "加密文件夹");
    }
  });
}

/* ---------------- 事件委托绑定：补全所有原文件里没有绑定的点击交互 (与原项目行为对齐) ---------------- */

// 1. 角色选择列表 -> 打开对应角色的家
document.getElementById("kk-char-selection-list")?.addEventListener("click", (e) => {
  const item = e.target.closest(".character-select-item");
  if (item && item.dataset.chatId) {
    openKkHouseView(item.dataset.chatId);
  }
});

// 2. 电脑桌面图标 -> 各功能入口
document.getElementById("kk-computer-desktop")?.addEventListener("click", (e) => {
  const icon = e.target.closest(".kk-desktop-icon");
  if (!icon) return;
  const computerData = state.chats[activeKkCharId]?.houseData?.computer;
  if (!computerData) {
    showCustomAlert("错误", "找不到电脑数据。");
    return;
  }
  switch (icon.id) {
    case "kk-browser-icon":
      showComputerContentList("浏览器历史 (点击分享)", computerData.browser_history || [], "浏览器");
      break;
    case "kk-movies-icon":
      showComputerContentList("D盘电影 (点击分享)", computerData.movies || [], "D盘");
      break;
    case "kk-files-icon":
      openFileExplorer();
      break;
    case "kk-secret-folder-icon":
      openKkSecretFolder();
      break;
    case "kk-steam-icon":
      openSteamScreen();
      break;
  }
});

// 3. 文件浏览器列表项 -> 打开文件查看器 (只处理带 data-file-name 的项，避免和其他列表复用冲突)
document.getElementById("kk-file-list")?.addEventListener("click", (e) => {
  const item = e.target.closest(".kk-file-item");
  if (item && item.dataset.fileName !== undefined) {
    openFileViewer(item.dataset.fileName, item.dataset.fileContent);
  }
});

// 4. 点击遮罩层关闭文件查看器 / 物品分享弹窗
document.getElementById("kk-file-viewer-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "kk-file-viewer-modal") closeFileViewer();
});
document.getElementById("kk-item-share-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "kk-item-share-modal") e.target.classList.remove("visible");
});

// 5. 监控网格：点击互动按钮触发对应操作，点击卡片其他区域则进入该区域探索视图
document.getElementById("kk-monitor-grid")?.addEventListener("click", (e) => {
  const monitorItem = e.target.closest(".kk-monitor-item");
  if (!monitorItem) return;
  const areaName = monitorItem.dataset.areaName;
  const interactionButton = e.target.closest(".monitor-btn");
  if (interactionButton) {
    e.stopPropagation();
    handleMonitorInteraction(areaName, interactionButton.dataset.action, monitorItem);
  } else {
    openKkAreaView(areaName);
  }
});

// 6. Steam游戏库删除按钮
document.getElementById("kk-steam-games-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".item-delete-btn");
  if (btn && btn.dataset.type === "computer.steam_games") {
    handleDeleteKkSteamGame(parseInt(btn.dataset.index, 10));
  }
});

// 7. 衣帽间分类标签切换
// 8. 返回按钮们
document.getElementById("kk-back-from-house-view")?.addEventListener("click", () => showScreen("kk-char-selection-screen"));
document.getElementById("kk-back-from-area-view")?.addEventListener("click", () => showScreen("kk-house-view-screen"));
document.getElementById("kk-back-from-monitor")?.addEventListener("click", () => showScreen("kk-house-view-screen"));
document.getElementById("kk-back-from-wardrobe")?.addEventListener("click", () => showScreen("kk-house-view-screen"));

// 9. 房屋视图右上角"继续翻找/重新翻找"
document.getElementById("kk-continue-search-btn")?.addEventListener("click", handleContinueKkSearch);
document.getElementById("kk-reset-search-btn")?.addEventListener("click", handleResetKkHouse);

// 10. 房屋视图悬浮工具条：衣柜 / 监控 入口
document.getElementById("kk-wardrobe-btn")?.addEventListener("click", openKkWardrobe);
document.getElementById("kk-house-view-screen")?.addEventListener("click", (e) => {
  if (e.target.closest("#kk-surveillance-icon")) {
    openSurveillanceView(activeKkCharId);
  }
});

// 11. 各弹窗关闭按钮
document.getElementById("close-kk-computer-modal")?.addEventListener("click", () => document.getElementById("kk-computer-modal").classList.remove("visible"));
document.getElementById("close-file-explorer-modal-btn")?.addEventListener("click", () => document.getElementById("kk-file-explorer-modal").classList.remove("visible"));
document.getElementById("close-kk-file-viewer-btn")?.addEventListener("click", closeFileViewer);
document.getElementById("close-kk-steam-modal-btn")?.addEventListener("click", () => document.getElementById("kk-steam-modal").classList.remove("visible"));
document.getElementById("kk-item-share-close-btn")?.addEventListener("click", () => document.getElementById("kk-item-share-modal").classList.remove("visible"));
document.getElementById("kk-generate-more-games-btn")?.addEventListener("click", generateMoreSteamGames);

// 12. 重置衣柜(清空重新生成)
document.getElementById("kk-wardrobe-refresh-btn")?.addEventListener("click", async () => {
  const confirmed = await showCustomConfirm("重置衣柜", "确定要清空并重新生成所有衣服吗？", { confirmButtonClass: "btn-danger" });
  if (confirmed) {
    await generateWardrobeData(activeKkCharId);
    currentOutfit = { 头饰: null, 上装: null, 下装: null, 鞋子: null, 首饰: null, 特殊: null };
    renderWardrobeUI();
  }
});

document.querySelector("#wardrobe-inventory-area .wardrobe-tabs")?.addEventListener("click", (e) => {
  const tab = e.target.closest(".wardrobe-tab");
  if (!tab) return;
  activeWardrobeCategory = tab.dataset.cat;
  renderWardrobeUI();
});
// 注：“添置新衣”按钮(#kk-wardrobe-add-btn)的绑定已经在本文件前面(generateMoreWardrobeData 定义之后)处理过，这里不再重复绑定。
