(function loadDocumentFragments() {
  const fragmentScripts = window.__EPHONE_HTML_FRAGMENT_SCRIPTS;
  const htmlParts = [];
  window.__EPHONE_HTML_PARTS = htmlParts;

  const showFailure = error => {
    console.error('[DocumentLoader] 页面片段加载失败:', error);
    document.body.innerHTML = '';
    const message = document.createElement('main');
    message.style.cssText = 'max-width:560px;margin:15vh auto;padding:24px;font-family:sans-serif;line-height:1.6;';
    const title = document.createElement('h1');
    title.textContent = '页面加载失败';
    const detail = document.createElement('p');
    detail.textContent = '无法读取页面片段，请确认项目文件完整后刷新。';
    message.append(title, detail);
    document.body.appendChild(message);
  };

  if (!Array.isArray(fragmentScripts) || fragmentScripts.length === 0) {
    showFailure(new Error('HTML fragment script manifest is missing.'));
    return;
  }

  let nextFragmentIndex = 0;

  const loadNextFragment = () => {
    if (nextFragmentIndex === fragmentScripts.length) {
      delete window.__EPHONE_HTML_FRAGMENT_SCRIPTS;
      delete window.__EPHONE_HTML_PARTS;
      document.open('text/html', 'replace');
      document.write(htmlParts.join(''));
      document.close();
      return;
    }

    const fragmentPath = fragmentScripts[nextFragmentIndex];
    nextFragmentIndex += 1;
    const script = document.createElement('script');
    script.src = fragmentPath;
    script.onload = () => {
      script.remove();
      loadNextFragment();
    };
    script.onerror = () => showFailure(new Error(`Unable to load ${fragmentPath}`));
    document.head.appendChild(script);
  };

  loadNextFragment();
})();
