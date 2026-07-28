// ============================================================
// send-translate.js
// 发送语言翻译：user打字用母语，选择一个目标语言后，发送前会先用AI
// 翻译成地道、母语级别的对应语言，角色看到的就是翻译后的内容。
// ============================================================

const SEND_TRANSLATE_LANGUAGE_LABELS = {
  ja: '日语',
  en: '英语',
  ko: '韩语',
  fr: '法语',
  de: '德语',
  es: '西班牙语',
  ru: '俄语',
  'zh-TW': '繁体中文',
};

// 调用AI把text翻译成目标语言，要求母语级别、自然口语化，而不是逐字直译
async function translateUserOutgoingMessage(text, targetLangCode) {
  const langLabel = SEND_TRANSLATE_LANGUAGE_LABELS[targetLangCode] || targetLangCode;
  const { proxyUrl, apiKey, model } = state.apiConfig || {};
  if (!proxyUrl || !apiKey || !model) {
    throw new Error('尚未配置API，无法使用发送语言翻译功能');
  }

  const systemPrompt = `你是一位精通${langLabel}的母语级翻译，长期生活在使用${langLabel}的国家。
请把下面这句话翻译成自然、地道、符合${langLabel}母语者日常聊天/打字习惯的表达。
要求：
1. 不要逐字直译，要按照母语者真实会怎么说来组织句子，可以适当调整语序、增删语气词。
2. 保留原文的语气、情绪、潜台词(比如撒娇、生气、调侃)，翻译后读起来要像真人聊天，不要书面语、不要翻译腔。
3. 如果原文有网络流行语、缩写、表情符号，尽量用${langLabel}里对应的地道说法或直接保留表情符号。
4. 只输出翻译结果本身，不要加任何解释、引号、前后缀或"翻译："这类字样。

原文：
${text}`;

  const messagesForApi = [{ role: 'user', content: systemPrompt }];
  const isGemini = proxyUrl === GEMINI_API_URL;
  const geminiConfig = toGeminiRequestData(model, apiKey, systemPrompt, messagesForApi, isGemini);

  const response = isGemini
    ? await fetch(geminiConfig.url, geminiConfig.data)
    : await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messagesForApi,
          temperature: 0.4,
        }),
      });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const rawContent = isGemini
    ? data.candidates[0].content.parts[0].text
    : data.choices[0].message.content;

  return rawContent.trim().replace(/^["“]|["”]$/g, '').trim();
}

// 点击自己发出去的(经过翻译的)气泡，切换显示/隐藏原文小字
function toggleSendTranslateOriginal(bubble) {
  const original = bubble.dataset.sendTranslateOriginal;
  if (!original) return;
  const isShowing = bubble.dataset.showingSendTranslateOriginal === 'true';
  const contentDiv = bubble.querySelector('.content');
  if (!contentDiv) return;

  if (isShowing) {
    const hintEl = contentDiv.querySelector('.send-translate-original-hint');
    if (hintEl) hintEl.remove();
    bubble.dataset.showingSendTranslateOriginal = 'false';
  } else {
    const hintEl = document.createElement('div');
    hintEl.className = 'send-translate-original-hint';
    hintEl.textContent = `原文: ${original}`;
    contentDiv.appendChild(hintEl);
    bubble.dataset.showingSendTranslateOriginal = 'true';
  }
}

window.toggleSendTranslateOriginal = toggleSendTranslateOriginal;
window.translateUserOutgoingMessage = translateUserOutgoingMessage;
window.SEND_TRANSLATE_LANGUAGE_LABELS = SEND_TRANSLATE_LANGUAGE_LABELS;
