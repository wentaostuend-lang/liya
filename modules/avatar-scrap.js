// ============================================================
// avatar-scrap.js — 头像边角料 & 情侣头像功能
//
// 通过聊天输入区新增的"发头像"按钮触发：
// - 只选1张图：发进聊天记录的同时，调用识图API找出图片里除了人物
//   本身之外最适合截取的一个"边角"元素（比如照片里的狗），裁剪下来
//   自动设为AI角色自己的头像。
// - 一次选2张图：视为情侣头像（第1张=用户自己那半，第2张=AI那半），
//   直接分别设为双方头像，不需要裁剪/AI分析。
// ============================================================

// 把 base64 图片按百分比裁剪，返回裁剪后的 base64 (image/png)
function cropImageByPercent(base64Url, xPct, yPct, wPct, hPct) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const naturalW = img.naturalWidth || img.width;
      const naturalH = img.naturalHeight || img.height;

      // 边界保护，防止AI返回的百分比超范围或宽高为0
      let x = Math.max(0, Math.min(100, xPct || 0));
      let y = Math.max(0, Math.min(100, yPct || 0));
      let w = Math.max(5, Math.min(100 - x, wPct || 40));
      let h = Math.max(5, Math.min(100 - y, hPct || 40));

      const sx = (x / 100) * naturalW;
      const sy = (y / 100) * naturalH;
      const sw = (w / 100) * naturalW;
      const sh = (h / 100) * naturalH;

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('图片加载失败，无法裁剪'));
    img.src = base64Url;
  });
}

// 调用识图API，让AI找出图片里适合截取的"边角料"区域
async function getAvatarScrapCropFromApi(base64Url) {
  const useVisionApi = state.apiConfig.visionProxyUrl && state.apiConfig.visionApiKey && state.apiConfig.visionModel;
  const useSecondaryApi = state.apiConfig.secondaryProxyUrl && state.apiConfig.secondaryApiKey && state.apiConfig.secondaryModel;
  const { proxyUrl, apiKey, model } = useVisionApi
    ? { proxyUrl: state.apiConfig.visionProxyUrl, apiKey: state.apiConfig.visionApiKey, model: state.apiConfig.visionModel }
    : useSecondaryApi
    ? { proxyUrl: state.apiConfig.secondaryProxyUrl, apiKey: state.apiConfig.secondaryApiKey, model: state.apiConfig.secondaryModel }
    : state.apiConfig;

  if (!proxyUrl || !apiKey || !model) {
    throw new Error('主API和副API均未配置或配置不完整。');
  }

  const prompt = `请分析这张图片。这可能是一张自拍、合影，或者包含宠物/玩偶/物品的照片。
请找出图片中除了人物主体之外，最适合单独截取出来当头像用的一个"边角"元素——比如照片里的宠物、玩偶、有趣的小物件、有特色的局部背景等。
如果实在找不到明显的次要元素，就挑选一个有特色的局部区域（比如一个配饰的特写）。

请只返回一个JSON对象，不要有任何多余文字、不要markdown代码块标记，格式如下：
{"name": "简短名字（4个字以内，比如"小狗特写"）", "x": 数字, "y": 数字, "width": 数字, "height": 数字}

x/y 是裁剪区域左上角在原图中的位置百分比(0-100)，width/height 是裁剪区域的宽高百分比(0-100)。
尽量让裁剪区域接近正方形，因为要用作圆形头像。`;

  let isGemini = proxyUrl.includes('generativelanguage');
  let response;

  if (isGemini) {
    const mimeType = base64Url.match(/^data:(.*);base64/)[1];
    const base64Data = base64Url.split(',')[1];
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ]
      }]
    };
    response = await fetch(`${proxyUrl}/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    const payload = {
      model: model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: base64Url } }
        ]
      }],
      max_tokens: 200
    };
    response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
  }

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`识图API 错误: ${errorData.error ? errorData.error.message : response.statusText}`);
  }

  const data = await response.json();
  let rawText = isGemini ? getGeminiResponseText(data) : data.choices[0].message.content;

  // 清理可能出现的markdown代码块标记
  rawText = rawText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

  const parsed = JSON.parse(rawText);
  return {
    name: parsed.name || '边角料',
    x: Number(parsed.x) || 0,
    y: Number(parsed.y) || 0,
    width: Number(parsed.width) || 40,
    height: Number(parsed.height) || 40
  };
}

// 单图流程：截取边角料，设为AI自己的头像
async function processSingleAvatarScrap(chat, base64Url) {
  try {
    const cropInfo = await getAvatarScrapCropFromApi(base64Url);
    const croppedUrl = await cropImageByPercent(base64Url, cropInfo.x, cropInfo.y, cropInfo.width, cropInfo.height);

    if (!chat.settings.aiAvatarLibrary) chat.settings.aiAvatarLibrary = [];
    chat.settings.aiAvatarLibrary.push({ name: cropInfo.name, url: croppedUrl });
    chat.settings.aiAvatar = croppedUrl;

    const notice = {
      role: 'system',
      type: 'pat_message',
      content: `[${chat.name} 偷偷截了张图里的"${cropInfo.name}"当成了自己的新头像]`,
      timestamp: Date.now()
    };
    chat.history.push(notice);

    await db.chats.put(chat);
    appendMessage(notice, chat);
    renderChatList();
    if (typeof syncCharacterAvatarInGroups === 'function') await syncCharacterAvatarInGroups(chat);
    if (typeof renderChatInterface === 'function') renderChatInterface(chat.id);
  } catch (e) {
    console.error('头像边角料处理失败:', e);
  }
}

// 双图流程：情侣头像，直接分配
async function processCoupleAvatarPair(chat, myBase64Url, aiBase64Url) {
  chat.settings.myAvatar = myBase64Url;
  chat.settings.aiAvatar = aiBase64Url;

  if (!chat.settings.myAvatarLibrary) chat.settings.myAvatarLibrary = [];
  chat.settings.myAvatarLibrary.push({ name: '情侣头像-我的部分', url: myBase64Url });

  if (!chat.settings.aiAvatarLibrary) chat.settings.aiAvatarLibrary = [];
  chat.settings.aiAvatarLibrary.push({ name: '情侣头像-TA的部分', url: aiBase64Url });

  const notice = {
    role: 'system',
    type: 'pat_message',
    content: `[你和${chat.name}换上了情侣头像]`,
    timestamp: Date.now()
  };
  chat.history.push(notice);

  await db.chats.put(chat);
  appendMessage(notice, chat);
  renderChatList();
  if (typeof syncCharacterAvatarInGroups === 'function') await syncCharacterAvatarInGroups(chat);
  if (typeof renderChatInterface === 'function') renderChatInterface(chat.id);
}

// ============================================================
// UI 绑定
// ============================================================
(function () {
  document.getElementById('send-avatar-btn')?.addEventListener('click', () => {
    document.getElementById('avatar-upload-input')?.click();
  });

  document.getElementById('avatar-upload-input')?.addEventListener('change', async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !state.activeChatId) return;

    const chat = state.chats[state.activeChatId];

    const readPromises = Array.from(files).slice(0, 2).map(file => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    }));
    const base64Urls = await Promise.all(readPromises);

    // 先把图片作为普通消息发进聊天记录，用户能看到自己发了什么
    for (let i = 0; i < base64Urls.length; i++) {
      const msg = {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: base64Urls[i] } }],
        timestamp: Date.now() + i
      };
      chat.history.push(msg);
      appendMessage(msg, chat);
    }
    await db.chats.put(chat);
    renderChatList();
    event.target.value = '';

    if (base64Urls.length === 1) {
      processSingleAvatarScrap(chat, base64Urls[0]);
    } else if (base64Urls.length === 2) {
      processCoupleAvatarPair(chat, base64Urls[0], base64Urls[1]);
    }
  });
})();
