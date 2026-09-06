// ============================================================
// audio-session.js — 保活音频持久化、内置离线静音与 Media Session
// ============================================================
(function () {
  'use strict';

  let activeObjectUrl = '';

  function revokeActiveUrl() {
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = '';
  }

  function createSilentWavBlob(durationSeconds = 2) {
    const sampleRate = 8000;
    const sampleCount = sampleRate * durationSeconds;
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, sampleCount * 2, true);
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function setSourceStatus(text) {
    const status = document.getElementById('keep-alive-audio-source-status');
    if (status) status.textContent = text;
  }

  function configureMediaSession(chatName) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chatName ? `正在等待 ${chatName} 回复` : 'EPhone 回复守护',
        artist: 'EPhone',
        album: '后台回复守护'
      });
      navigator.mediaSession.playbackState = 'playing';
      navigator.mediaSession.setActionHandler('pause', () => {
        const player = document.getElementById('keep-alive-audio-player');
        if (player) player.pause();
      });
      navigator.mediaSession.setActionHandler('play', () => {
        const player = document.getElementById('keep-alive-audio-player');
        if (player) player.play().catch(() => {});
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        const player = document.getElementById('keep-alive-audio-player');
        if (player) player.pause();
      });
    } catch (error) {
      console.warn('[回复守护] Media Session 配置失败:', error);
    }
  }

  function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch (_) {}
  }

  async function applyBlob(player, blob, label) {
    if (!player || !blob) return false;
    revokeActiveUrl();
    activeObjectUrl = URL.createObjectURL(blob);
    player.src = activeObjectUrl;
    player.loop = true;
    player.preload = 'auto';
    await player.play();
    setSourceStatus(label);
    configureMediaSession(window.state && window.state.chats && window.state.activeChatId
      ? window.state.chats[window.state.activeChatId]?.name
      : '');
    return true;
  }

  async function useBuiltIn(player) {
    return applyBlob(player, createSilentWavBlob(), '当前：内置离线静音音频');
  }

  async function saveCustomAudio(file, player) {
    if (!file || !file.type || !file.type.startsWith('audio/')) {
      throw new Error('请选择有效的音频文件');
    }
    if (file.size > 25 * 1024 * 1024) {
      throw new Error('音频文件不能超过 25MB');
    }
    if (window.db && window.db.keepAliveAssets) {
      await window.db.keepAliveAssets.put({
        id: 'custom-audio',
        blob: file,
        name: file.name || '自定义音频',
        type: file.type,
        size: file.size,
        updatedAt: Date.now()
      });
    }
    await applyBlob(player, file, `当前：${file.name || '自定义音频'}`);
    return true;
  }

  async function restoreSaved(player, fallbackToBuiltIn) {
    if (window.db && window.db.keepAliveAssets) {
      const saved = await window.db.keepAliveAssets.get('custom-audio');
      if (saved && saved.blob) {
        await applyBlob(player, saved.blob, `当前：${saved.name || '已保存的自定义音频'}`);
        return 'custom';
      }
    }
    if (fallbackToBuiltIn) {
      await useBuiltIn(player);
      return 'built-in';
    }
    return null;
  }

  async function clearCustomAndUseBuiltIn(player) {
    if (window.db && window.db.keepAliveAssets) {
      await window.db.keepAliveAssets.delete('custom-audio');
    }
    if (window.state && window.state.globalSettings && window.state.globalSettings.backgroundKeepAlive) {
      delete window.state.globalSettings.backgroundKeepAlive.audioUrl;
      await window.db.globalSettings.put(window.state.globalSettings);
    }
    const urlInput = document.getElementById('keep-alive-audio-url');
    if (urlInput) urlInput.value = '';
    return useBuiltIn(player);
  }

  function noteUrl(url) {
    revokeActiveUrl();
    setSourceStatus(`当前：URL 音频 ${url.length > 42 ? `${url.slice(0, 42)}…` : url}`);
    configureMediaSession('');
  }

  window.ReplyGuardianAudio = {
    createSilentWavBlob,
    useBuiltIn,
    saveCustomAudio,
    restoreSaved,
    clearCustomAndUseBuiltIn,
    configureMediaSession,
    clearMediaSession,
    noteUrl,
    setSourceStatus,
    revokeActiveUrl
  };
})();
