/**
 * Ry Markdown Reader — viewer.
 *
 * Fetches the Markdown document with the extension's host permissions, renders
 * it read-only with marked + DOMPurify, and turns ```mermaid blocks into SVG.
 * No editing and no file management: the URL is the only input.
 */

(() => {
  'use strict';

  const THEME_KEY = 'ry-md-theme';
  const FETCH_TIMEOUT = 30000;

  const dom = {
    progress: document.getElementById('progress'),
    docMeta: document.getElementById('doc-meta'),
    docTitle: document.getElementById('doc-title'),
    docSub: document.getElementById('doc-sub'),
    rawBtn: document.getElementById('raw-btn'),
    reloadBtn: document.getElementById('reload-btn'),
    themeToggle: document.getElementById('theme-toggle'),
    landing: document.getElementById('landing'),
    openForm: document.getElementById('open-form'),
    urlInput: document.getElementById('url-input'),
    landingError: document.getElementById('landing-error'),
    status: document.getElementById('status'),
    statusSpinner: document.getElementById('status-spinner'),
    statusIcon: document.getElementById('status-icon'),
    statusTitle: document.getElementById('status-title'),
    statusText: document.getElementById('status-text'),
    statusActions: document.getElementById('status-actions'),
    retryBtn: document.getElementById('retry-btn'),
    changeBtn: document.getElementById('change-btn'),
    doc: document.getElementById('doc'),
    toast: document.getElementById('toast'),
    lightbox: document.getElementById('lightbox'),
    lightboxStage: document.getElementById('lightbox-stage'),
    lightboxImage: document.getElementById('lightbox-image'),
    lightboxLoading: document.getElementById('lightbox-loading'),
    lightboxAlt: document.getElementById('lightbox-alt'),
    lightboxDim: document.getElementById('lightbox-dim'),
    lightboxOpen: document.getElementById('lightbox-open'),
    lightboxClose: document.getElementById('lightbox-close'),
    zoomOut: document.getElementById('zoom-out'),
    zoomReset: document.getElementById('zoom-reset'),
    zoomIn: document.getElementById('zoom-in'),
    zoomLabel: document.getElementById('zoom-label'),
  };

  let theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  let currentSource = '';
  let currentRawUrl = '';
  let controller = null;
  let mermaidToken = 0;
  let toastTimer = 0;
  let progressRaf = 0;
  let docReady = false;

  let lightboxScale = 1;
  let lightboxX = 0;
  let lightboxY = 0;
  let lightboxLoadToken = 0;
  let lightboxLastFocus = null;
  let lightboxDragging = false;
  let lightboxDragMoved = false;
  let lightboxDragStartX = 0;
  let lightboxDragStartY = 0;
  let lightboxDragOriginX = 0;
  let lightboxDragOriginY = 0;

  class ViewError extends Error {
    constructor(message, hint = '') {
      super(message);
      this.name = 'ViewError';
      this.hint = hint;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Small helpers                                                    */
  /* ---------------------------------------------------------------- */

  function normalizeInput(value) {
    let raw = String(value || '').trim();
    if (!raw) return null;

    if (/^[A-Za-z]:[\\/]/.test(raw)) {
      // Windows absolute path, e.g. C:\docs\README.md
      raw = `file:///${raw.replace(/\\/g, '/')}`;
    } else if (raw.startsWith('//')) {
      raw = `https:${raw}`;
    } else if (raw.startsWith('/')) {
      // POSIX absolute path, e.g. /home/me/docs/README.md
      raw = `file://${raw}`;
    }

    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`;

    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
      return null;
    }
    return url;
  }

  function sourceLabel(url) {
    if (url.protocol !== 'file:') return url.hostname;

    try {
      const pathname = decodeURIComponent(url.pathname);
      const slash = pathname.lastIndexOf('/');
      return slash > 0 ? pathname.slice(0, slash) : '本地文件';
    } catch {
      return '本地文件';
    }
  }

  function fileNameFromUrl(value) {
    try {
      const url = new URL(value);
      const pathname = decodeURIComponent(url.pathname);
      const last = pathname.split('/').filter(Boolean).pop();
      return last || url.hostname;
    } catch {
      return 'Markdown';
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function slugify(value) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => dom.toast.classList.remove('show'), 1600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  function updateProgress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    dom.progress.style.width = `${(ratio * 100).toFixed(2)}%`;
  }

  function queueProgress() {
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      updateProgress();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Image lightbox                                                   */
  /* ---------------------------------------------------------------- */

  const LIGHTBOX_MIN_ZOOM = 1;
  const LIGHTBOX_MAX_ZOOM = 6;

  function lightboxIsOpen() {
    return !dom.lightbox.hidden;
  }

  function lightboxPanLimits() {
    const style = getComputedStyle(dom.lightboxStage);
    const availableWidth = Math.max(
      0,
      dom.lightboxStage.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
    );
    const availableHeight = Math.max(
      0,
      dom.lightboxStage.clientHeight -
        (Number.parseFloat(style.paddingTop) || 0) -
        (Number.parseFloat(style.paddingBottom) || 0)
    );
    return {
      x: Math.max(0, (dom.lightboxImage.clientWidth * lightboxScale - availableWidth) / 2),
      y: Math.max(0, (dom.lightboxImage.clientHeight * lightboxScale - availableHeight) / 2),
    };
  }

  function clampLightboxPan() {
    const limits = lightboxPanLimits();
    lightboxX = Math.min(limits.x, Math.max(-limits.x, lightboxX));
    lightboxY = Math.min(limits.y, Math.max(-limits.y, lightboxY));
  }

  function applyLightboxTransform() {
    dom.lightboxImage.style.transform = `translate3d(${lightboxX}px, ${lightboxY}px, 0) scale(${lightboxScale})`;
    dom.zoomLabel.textContent = `${Math.round(lightboxScale * 100)}%`;
  }

  function resetLightboxZoom() {
    lightboxScale = 1;
    lightboxX = 0;
    lightboxY = 0;
    applyLightboxTransform();
  }

  function zoomLightbox(next) {
    const target = Math.min(
      LIGHTBOX_MAX_ZOOM,
      Math.max(LIGHTBOX_MIN_ZOOM, Math.round(next * 100) / 100)
    );
    if (target <= LIGHTBOX_MIN_ZOOM) {
      resetLightboxZoom();
      return;
    }
    lightboxScale = target;
    clampLightboxPan();
    applyLightboxTransform();
  }

  function openLightbox(image) {
    if (!image) return;
    const src = image.currentSrc || image.src;
    if (!src) return;

    const token = ++lightboxLoadToken;
    lightboxLastFocus = image;
    lightboxScale = 1;
    lightboxX = 0;
    lightboxY = 0;
    lightboxDragging = false;
    lightboxDragMoved = false;

    dom.lightboxAlt.textContent = image.alt || '图片预览';
    dom.lightboxDim.textContent =
      image.naturalWidth && image.naturalHeight
        ? `${image.naturalWidth} × ${image.naturalHeight}`
        : '';
    dom.lightboxOpen.href = src;
    dom.lightboxImage.alt = image.alt || '图片预览';
    dom.lightboxImage.hidden = true;
    dom.lightboxImage.style.transform = '';
    dom.lightboxLoading.hidden = false;
    dom.lightboxLoading.textContent = '正在加载图片…';

    const reveal = () => {
      if (token !== lightboxLoadToken) return;
      dom.lightboxLoading.hidden = true;
      dom.lightboxImage.hidden = false;
      dom.lightboxDim.textContent =
        dom.lightboxImage.naturalWidth && dom.lightboxImage.naturalHeight
          ? `${dom.lightboxImage.naturalWidth} × ${dom.lightboxImage.naturalHeight}`
          : '';
      resetLightboxZoom();
    };

    dom.lightboxImage.onload = reveal;
    dom.lightboxImage.onerror = () => {
      if (token !== lightboxLoadToken) return;
      dom.lightboxImage.hidden = true;
      dom.lightboxLoading.hidden = false;
      dom.lightboxLoading.textContent = '图片加载失败';
    };

    dom.lightbox.hidden = false;
    document.body.classList.add('lightbox-open');
    dom.zoomLabel.textContent = '100%';

    dom.lightboxImage.src = src;
    if (dom.lightboxImage.complete && dom.lightboxImage.naturalWidth) reveal();

    dom.lightboxClose.focus({ preventScroll: true });
  }

  function closeLightbox() {
    if (!lightboxIsOpen()) return;

    lightboxLoadToken += 1;
    dom.lightbox.hidden = true;
    document.body.classList.remove('lightbox-open');
    dom.lightboxImage.onload = null;
    dom.lightboxImage.onerror = null;
    dom.lightboxImage.hidden = true;
    dom.lightboxImage.removeAttribute('src');
    dom.lightboxImage.style.transform = '';
    dom.lightboxStage.classList.remove('is-dragging');

    lightboxScale = 1;
    lightboxX = 0;
    lightboxY = 0;
    lightboxDragging = false;
    lightboxDragMoved = false;

    if (lightboxLastFocus && document.contains(lightboxLastFocus)) {
      if (!lightboxLastFocus.hasAttribute('tabindex')) {
        lightboxLastFocus.setAttribute('tabindex', '-1');
      }
      lightboxLastFocus.focus({ preventScroll: true });
    }
    lightboxLastFocus = null;
  }

  function bindLightboxEvents() {
    dom.lightboxClose.addEventListener('click', closeLightbox);

    dom.lightbox.addEventListener('click', (event) => {
      if (event.target === dom.lightbox) closeLightbox();
    });

    dom.lightboxStage.addEventListener('click', (event) => {
      if (lightboxDragMoved) {
        lightboxDragMoved = false;
        return;
      }
      if (event.target === dom.lightboxStage) closeLightbox();
    });

    dom.zoomIn.addEventListener('click', () => {
      zoomLightbox(lightboxScale + 0.25);
    });

    dom.zoomOut.addEventListener('click', () => {
      zoomLightbox(lightboxScale - 0.25);
    });

    dom.zoomReset.addEventListener('click', resetLightboxZoom);

    dom.lightboxImage.addEventListener('dblclick', (event) => {
      event.preventDefault();
      if (lightboxScale > 1.01) resetLightboxZoom();
      else zoomLightbox(2.2);
    });

    dom.lightboxStage.addEventListener(
      'wheel',
      (event) => {
        if (!lightboxIsOpen()) return;
        event.preventDefault();
        zoomLightbox(lightboxScale + (event.deltaY < 0 ? 0.25 : -0.25));
      },
      { passive: false }
    );

    dom.lightboxStage.addEventListener('pointerdown', (event) => {
      if (!lightboxIsOpen() || event.button !== 0 || lightboxScale <= 1.001) return;

      lightboxDragging = true;
      lightboxDragMoved = false;
      lightboxDragStartX = event.clientX;
      lightboxDragStartY = event.clientY;
      lightboxDragOriginX = lightboxX;
      lightboxDragOriginY = lightboxY;
      dom.lightboxStage.classList.add('is-dragging');
      try {
        dom.lightboxStage.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort.
      }
    });

    dom.lightboxStage.addEventListener('pointermove', (event) => {
      if (!lightboxDragging) return;

      const dx = event.clientX - lightboxDragStartX;
      const dy = event.clientY - lightboxDragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lightboxDragMoved = true;

      lightboxX = lightboxDragOriginX + dx;
      lightboxY = lightboxDragOriginY + dy;
      clampLightboxPan();
      applyLightboxTransform();
    });

    const endDrag = (event) => {
      if (!lightboxDragging) return;
      lightboxDragging = false;
      dom.lightboxStage.classList.remove('is-dragging');
      if (dom.lightboxStage.hasPointerCapture(event.pointerId)) {
        dom.lightboxStage.releasePointerCapture(event.pointerId);
      }
      clampLightboxPan();
      applyLightboxTransform();
      window.setTimeout(() => {
        lightboxDragMoved = false;
      }, 0);
    };

    dom.lightboxStage.addEventListener('pointerup', endDrag);
    dom.lightboxStage.addEventListener('pointercancel', endDrag);

    document.addEventListener('keydown', (event) => {
      if (!lightboxIsOpen()) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        closeLightbox();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomLightbox(lightboxScale + 0.25);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomLightbox(lightboxScale - 0.25);
      } else if (event.key === '0') {
        event.preventDefault();
        resetLightboxZoom();
      }
    });

    window.addEventListener('resize', () => {
      if (!lightboxIsOpen() || !dom.lightboxImage.naturalWidth) return;
      clampLightboxPan();
      applyLightboxTransform();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Theme                                                            */
  /* ---------------------------------------------------------------- */

  function applyTheme(next, { persist = true, rerender = true } = {}) {
    theme = next === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;

    const label = theme === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    dom.themeToggle.title = label;
    dom.themeToggle.setAttribute('aria-label', label);

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        // Ignore storage failures; the in-memory theme still applies.
      }
    }

    if (rerender && docReady) renderMermaidBlocks();
  }

  function initTheme() {
    applyTheme(theme, { persist: false, rerender: false });

    dom.themeToggle.addEventListener('click', () => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== THEME_KEY || !event.newValue) return;
      applyTheme(event.newValue, { persist: false });
    });
  }

  /* ---------------------------------------------------------------- */
  /* State transitions                                                */
  /* ---------------------------------------------------------------- */

  function setMeta(title, sub) {
    dom.docTitle.textContent = title;
    dom.docSub.textContent = sub;
    dom.docMeta.hidden = !title;
  }

  function resetMeta() {
    dom.docMeta.hidden = true;
    dom.docTitle.textContent = '';
    dom.docSub.textContent = '';
    dom.rawBtn.hidden = true;
    dom.reloadBtn.hidden = true;
    currentRawUrl = '';
  }

  function cancelFetch() {
    if (!controller) return;
    controller.abort();
    controller = null;
  }

  function showLanding() {
    cancelFetch();
    docReady = false;
    mermaidToken += 1;

    dom.landing.hidden = false;
    dom.status.hidden = true;
    dom.doc.hidden = true;
    resetMeta();
    document.title = 'Markdown Reader';
    dom.progress.style.width = '0%';
    window.scrollTo(0, 0);
    if (window.matchMedia('(pointer: fine)').matches) {
      window.setTimeout(() => dom.urlInput.focus(), 30);
    }
  }

  function showStatus({ title, text = '', error = false, actions = false }) {
    dom.landing.hidden = true;
    dom.doc.hidden = true;
    dom.status.hidden = false;
    dom.statusSpinner.hidden = error;
    dom.statusIcon.hidden = !error;
    dom.statusTitle.textContent = title;
    dom.statusText.textContent = text;
    dom.statusActions.hidden = !actions;
  }

  function showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error && error.hint ? error.hint : '';
    showStatus({
      title: '无法加载这份 Markdown',
      text: hint ? `${message}\n${hint}` : message,
      error: true,
      actions: true,
    });

    if (currentSource) {
      try {
        const url = new URL(currentSource);
        setMeta(fileNameFromUrl(currentSource), sourceLabel(url));
      } catch {
        resetMeta();
      }
    } else {
      resetMeta();
    }

    dom.reloadBtn.hidden = !currentSource;
    dom.rawBtn.hidden = !currentRawUrl;
    document.title = `${dom.docTitle.textContent || '读取失败'} · Markdown Reader`;
  }

  /* ---------------------------------------------------------------- */
  /* Fetch                                                             */
  /* ---------------------------------------------------------------- */

  function prepareFetchUrl(url) {
    const next = new URL(url.href);
    next.hash = '';

    if (next.hostname === 'github.com' && next.pathname.includes('/blob/')) {
      next.searchParams.set('raw', '1');
    }

    if (next.hostname === 'gitlab.com' && next.pathname.includes('/-/blob/')) {
      next.pathname = next.pathname.replace('/-/blob/', '/-/raw/');
    }

    return next.href;
  }

  async function load(url) {
    const sourceUrl = url instanceof URL ? url : normalizeInput(url);
    if (!sourceUrl) {
      showLanding();
      return;
    }

    cancelFetch();
    currentSource = sourceUrl.href;
    currentRawUrl = '';
    docReady = false;
    mermaidToken += 1;
    resetMeta();
    setMeta(fileNameFromUrl(currentSource), sourceLabel(sourceUrl));
    dom.doc.hidden = true;
    dom.landing.hidden = true;
    showStatus({
      title: '正在读取 Markdown…',
      text: currentSource,
    });
    document.title = `读取中 · ${fileNameFromUrl(currentSource)}`;
    window.scrollTo(0, 0);

    const fetchUrl = prepareFetchUrl(sourceUrl);
    const myController = new AbortController();
    controller = myController;
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      myController.abort();
    }, FETCH_TIMEOUT);

    try {
      const response = await fetch(fetchUrl, {
        signal: myController.signal,
        credentials: 'include',
        cache: 'no-cache',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
      });

      if (controller !== myController) return;

      if (!response.ok) {
        const reason =
          response.status === 404
            ? '文件不存在或没有访问权限（HTTP 404）。'
            : `服务器返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}。`;
        throw new ViewError(reason, '请确认地址正确，或检查该文件是否需要登录后才能访问。');
      }

      currentRawUrl = response.url && /^https?:/i.test(response.url) ? response.url : fetchUrl;

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        throw new ViewError(
          '这个地址返回的是 HTML 网页，而不是 Markdown 文本。',
          '如果这是 GitHub / GitLab 的文件页面，请改用 Raw 链接；也可以直接打开该页面后复制内容。'
        );
      }

      if (
        /^(image|audio|video|font)\//.test(contentType) ||
        /application\/(pdf|zip|gzip|x-tar|msword|vnd\.openxmlformats-officedocument)/.test(contentType)
      ) {
        throw new ViewError(
          '这个地址返回的不是可阅读的文本文件。',
          `服务器返回的 Content-Type 是 ${contentType}。请确认链接指向 Markdown 原文。`
        );
      }

      const buffer = await response.arrayBuffer();
      if (controller !== myController) return;

      const charsetMatch = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
      let charset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : 'utf-8';
      let text;
      try {
        text = new TextDecoder(charset).decode(buffer);
      } catch {
        text = new TextDecoder('utf-8').decode(buffer);
      }
      // Local files rarely declare a charset. If UTF-8 produced replacement
      // characters, try GBK before giving up (common for Chinese documents).
      if (!charsetMatch && text.includes('\uFFFD')) {
        try {
          const gbk = new TextDecoder('gbk').decode(buffer);
          if (!gbk.includes('\uFFFD')) text = gbk;
        } catch {
          // GBK decoder unavailable; keep the UTF-8 result.
        }
      }
      text = text.replace(/^\uFEFF/, '');

      if (!text.trim()) {
        throw new ViewError('这个文件是空的，没有可显示的 Markdown 内容。');
      }

      const baseUrl = currentRawUrl;
      renderDocument(text, sourceUrl, baseUrl);
    } catch (error) {
      if (controller !== myController) return;

      if (error && error.name === 'AbortError') {
        if (!timedOut) return;
        showError(new ViewError('加载超时（30 秒）。', '请检查网络连接，或稍后重试。'));
        return;
      }

      if (error instanceof ViewError) {
        showError(error);
        return;
      }

      if (sourceUrl.protocol === 'file:') {
        showError(
          new ViewError(
            '无法读取这个本地文件。',
            '请确认路径存在，并在 chrome://extensions 的扩展详情中开启「允许访问文件网址」。'
          )
        );
        console.warn('[Markdown Reader] local file fetch failed:', error);
        return;
      }

      showError(
        new ViewError(
          '网络请求失败，无法读取这个地址。',
          '请检查地址是否正确、网络是否可用；如果目标站点需要登录，请先在该站点登录。'
        )
      );
      console.warn('[Markdown Reader] fetch failed:', error);
    } finally {
      window.clearTimeout(timer);
      if (controller === myController) controller = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Markdown rendering                                               */
  /* ---------------------------------------------------------------- */

  function stripFrontMatter(text) {
    const meta = {};
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return { body: text, meta };

    const block = match[1];
    if (!/^[A-Za-z_][\w-]*\s*:/m.test(block)) return { body: text, meta };

    const title = /^title\s*:\s*(.+)$/m.exec(block);
    if (title) {
      meta.title = title[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    }

    return { body: text.slice(match[0].length), meta };
  }

  function codeFigure(code, language) {
    const lang = String(language || '').trim().split(/\s+/)[0].toLowerCase();
    const safeLang = lang.replace(/[^a-z0-9_+#.-]/g, '');
    const label = safeLang || 'text';

    if (safeLang === 'mermaid' || safeLang === 'mmd') {
      return [
        '<figure class="mermaid-block">',
        '<figcaption class="code-head">',
        '<span class="code-lang">mermaid</span>',
        '<button class="copy-btn" type="button">复制源码</button>',
        '</figcaption>',
        '<div class="mermaid-canvas"><div class="mermaid-status">正在渲染图表…</div></div>',
        `<pre class="mermaid-source" hidden>${escapeHtml(code)}</pre>`,
        '</figure>',
      ].join('');
    }

    return [
      `<figure class="code-block" data-lang="${escapeHtml(safeLang)}">`,
      '<figcaption class="code-head">',
      `<span class="code-lang">${escapeHtml(label)}</span>`,
      '<button class="copy-btn" type="button">复制</button>',
      '</figcaption>',
      `<pre><code class="hljs${safeLang ? ` language-${escapeHtml(safeLang)}` : ''}">${escapeHtml(code)}</code></pre>`,
      '</figure>',
    ].join('');
  }

  function createRenderer() {
    const renderer = new marked.Renderer();

    // marked v12 calls code(code, infostring, escaped); newer versions pass a
    // token object. Support both so the bundled renderer stays upgrade-safe.
    renderer.code = function (code, infostring) {
      let source = code;
      let info = infostring;
      if (code && typeof code === 'object') {
        source = code.text || '';
        info = code.lang || '';
      }
      return codeFigure(source, info);
    };

    return renderer;
  }

  const PURIFY_CONFIG = {
    USE_PROFILES: { html: true },
    ADD_ATTR: [
      'target',
      'rel',
      'align',
      'hidden',
      'open',
      'loading',
      'decoding',
      'referrerpolicy',
    ],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'contenteditable'],
  };

  function resolveUrl(value, baseUrl) {
    let base = baseUrl;
    try {
      const parsedBase = new URL(baseUrl);
      // Raw GitHub content lives on raw.githubusercontent.com, but root-relative
      // links inside README files refer to github.com.
      if (
        parsedBase.hostname.endsWith('githubusercontent.com') &&
        value.startsWith('/') &&
        !value.startsWith('//')
      ) {
        base = 'https://github.com/';
      }
    } catch {
      // Fall back to the given base.
    }
    return new URL(value, base).href;
  }

  function resolveRelativeUrls(root, baseUrl) {
    root.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      if (/^(mailto:|tel:)/i.test(href)) return;

      try {
        const absolute = resolveUrl(href, baseUrl);
        anchor.setAttribute('href', absolute);
        if (/^https?:/i.test(absolute)) {
          anchor.setAttribute('rel', 'noreferrer');
        }
      } catch {
        // Leave malformed links untouched.
      }
    });

    root.querySelectorAll('img[src]').forEach((image) => {
      const src = image.getAttribute('src') || '';
      if (!src || /^data:/i.test(src)) return;

      try {
        image.setAttribute('src', resolveUrl(src, baseUrl));
      } catch {
        // Leave malformed image URLs untouched.
      }
      image.setAttribute('loading', 'lazy');
      image.setAttribute('decoding', 'async');
      image.setAttribute('referrerpolicy', 'no-referrer');
    });
  }

  function wrapTables(root) {
    root.querySelectorAll('table').forEach((table) => {
      if (table.parentElement && table.parentElement.classList.contains('table-wrap')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrap';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }

  function addHeadingIds(root) {
    const used = new Set();
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      const base = slugify(heading.textContent || '') || 'section';
      let id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
      heading.id = id;
    });
  }

  function highlightCode(root) {
    root.querySelectorAll('pre:not(.mermaid-source) > code').forEach((code) => {
      try {
        hljs.highlightElement(code);
      } catch (error) {
        console.warn('[Markdown Reader] highlight failed:', error);
      }
    });
  }

  function renderDocument(text, originalUrl, baseUrl) {
    const { body, meta } = stripFrontMatter(text);
    const fileName = fileNameFromUrl(originalUrl.href);
    const headingTitle = meta.title || fileName;

    let html;
    try {
      html = marked.parse(body, {
        gfm: true,
        breaks: false,
        renderer: createRenderer(),
      });
    } catch (error) {
      showError(new ViewError('Markdown 解析失败。', error.message || ''));
      return;
    }

    const clean = DOMPurify.sanitize(html, PURIFY_CONFIG);
    dom.doc.innerHTML = clean;

    // The viewer is strictly read-only, including checkbox controls that may
    // have been written directly as HTML in the Markdown source.
    dom.doc.querySelectorAll('input, textarea, select').forEach((field) => {
      field.disabled = true;
    });

    resolveRelativeUrls(dom.doc, baseUrl);
    wrapTables(dom.doc);
    addHeadingIds(dom.doc);
    highlightCode(dom.doc);

    const subParts = [];
    if (headingTitle !== fileName) subParts.push(fileName);
    subParts.push(sourceLabel(originalUrl));

    setMeta(headingTitle, subParts.join(' · '));
    document.title = `${headingTitle} · Markdown Reader`;

    dom.status.hidden = true;
    dom.landing.hidden = true;
    dom.doc.hidden = false;
    dom.rawBtn.hidden = false;
    dom.reloadBtn.hidden = false;
    docReady = true;
    updateProgress();

    const hash = originalUrl.hash;
    renderMermaidBlocks().then(() => {
      if (hash) scrollToHash(hash);
    });
  }

  function scrollToHash(hash) {
    let raw = hash.replace(/^#/, '');
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Keep the raw value.
    }
    if (!raw) return;

    const candidates = [
      raw,
      raw.replace(/^user-content-/, ''),
      slugify(raw.replace(/^user-content-/, '')),
    ];

    let target = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      target = document.getElementById(candidate);
      if (target) break;
    }
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Mermaid                                                          */
  /* ---------------------------------------------------------------- */

  function mermaidVariables() {
    if (theme === 'dark') {
      return {
        darkMode: true,
        background: '#131417',
        mainBkg: '#1b1d22',
        primaryColor: '#1e2745',
        primaryTextColor: '#e7e9ee',
        primaryBorderColor: '#4d6bfe',
        secondaryColor: '#191b20',
        secondaryTextColor: '#e7e9ee',
        secondaryBorderColor: '#353a45',
        tertiaryColor: '#171d2e',
        tertiaryTextColor: '#a6abb5',
        tertiaryBorderColor: '#262931',
        lineColor: '#596070',
        textColor: '#e7e9ee',
        labelTextColor: '#e7e9ee',
        nodeTextColor: '#e7e9ee',
        edgeLabelBackground: '#131417',
        clusterBkg: '#191b20',
        clusterBorder: '#353a45',
        titleColor: '#e7e9ee',
        noteBkgColor: '#1e2745',
        noteTextColor: '#e7e9ee',
        noteBorderColor: '#7b8fff',
        actorBkg: '#1b1d22',
        actorBorder: '#7b8fff',
        actorTextColor: '#e7e9ee',
        actorLineColor: '#353a45',
        signalColor: '#a6abb5',
        signalTextColor: '#e7e9ee',
        activationBkgColor: '#1e2745',
        activationBorderColor: '#7b8fff',
        sequenceNumberColor: '#131417',
        sectionBkgColor: '#191b20',
        altSectionBkgColor: '#131417',
        gridColor: '#262931',
        taskBkgColor: '#1e2745',
        taskTextColor: '#e7e9ee',
        taskBorderColor: '#7b8fff',
        activeTaskBkgColor: '#4d6bfe',
        activeTaskBorderColor: '#7b8fff',
        doneTaskBkgColor: '#1b1d22',
        doneTaskBorderColor: '#353a45',
        critBkgColor: '#2a181b',
        critBorderColor: '#ff757d',
        todayLineColor: '#7b8fff',
      };
    }

    return {
      darkMode: false,
      background: '#ffffff',
      mainBkg: '#ffffff',
      primaryColor: '#eef2ff',
      primaryTextColor: '#0f1115',
      primaryBorderColor: '#4d6bfe',
      secondaryColor: '#f7f8fa',
      secondaryTextColor: '#0f1115',
      secondaryBorderColor: '#d8dce3',
      tertiaryColor: '#f6f8ff',
      tertiaryTextColor: '#61666b',
      tertiaryBorderColor: '#e9ebef',
      lineColor: '#9aa5b5',
      textColor: '#0f1115',
      labelTextColor: '#0f1115',
      nodeTextColor: '#0f1115',
      edgeLabelBackground: '#ffffff',
      clusterBkg: '#f7f8fa',
      clusterBorder: '#d8dce3',
      titleColor: '#0f1115',
      noteBkgColor: '#eef2ff',
      noteTextColor: '#0f1115',
      noteBorderColor: '#4d6bfe',
      actorBkg: '#ffffff',
      actorBorder: '#4d6bfe',
      actorTextColor: '#0f1115',
      actorLineColor: '#d8dce3',
      signalColor: '#61666b',
      signalTextColor: '#0f1115',
      activationBkgColor: '#eef2ff',
      activationBorderColor: '#4d6bfe',
      sequenceNumberColor: '#ffffff',
      sectionBkgColor: '#f7f8fa',
      altSectionBkgColor: '#ffffff',
      gridColor: '#e9ebef',
      taskBkgColor: '#eef2ff',
      taskTextColor: '#0f1115',
      taskBorderColor: '#4d6bfe',
      activeTaskBkgColor: '#4d6bfe',
      activeTaskBorderColor: '#3f5bf0',
      doneTaskBkgColor: '#f7f8fa',
      doneTaskBorderColor: '#d8dce3',
      critBkgColor: '#fdf1f1',
      critBorderColor: '#d93843',
      todayLineColor: '#4d6bfe',
    };
  }

  function initMermaid() {
    if (typeof mermaid === 'undefined') return false;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: '"JetBrains Mono", "MiSans", monospace',
      fontSize: 14,
      themeVariables: mermaidVariables(),
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis',
        padding: 14,
      },
      sequence: {
        useMaxWidth: true,
        wrap: true,
        messageAlign: 'left',
      },
      gantt: {
        useMaxWidth: true,
      },
      class: {
        useMaxWidth: true,
      },
      state: {
        useMaxWidth: true,
      },
      er: {
        useMaxWidth: true,
      },
      journey: {
        useMaxWidth: true,
      },
      timeline: {
        useMaxWidth: true,
      },
    });
    return true;
  }

  function fitMermaidSvg(block, svg) {
    // Mermaid writes the natural width into an inline max-width. If scaling
    // that down to the card width would make labels unreadably small, keep the
    // natural size and let the canvas scroll horizontally instead.
    const natural = Number.parseFloat(svg.style.maxWidth || '');
    const canvas = block.querySelector('.mermaid-canvas');

    svg.removeAttribute('height');
    svg.style.height = 'auto';

    if (!canvas || !Number.isFinite(natural) || natural <= 0) return;

    const available = canvas.clientWidth - 36;
    if (available > 0 && available / natural < 0.62) {
      svg.style.maxWidth = 'none';
      svg.style.width = `${Math.ceil(natural)}px`;
      block.classList.add('is-wide');
      canvas.title = '图表较宽，可横向滚动查看';
    }
  }

  function mermaidError(block, error) {
    const canvas = block.querySelector('.mermaid-canvas');
    const source = block.querySelector('.mermaid-source');
    if (!canvas) return;

    canvas.textContent = '';
    const box = document.createElement('div');
    box.className = 'mermaid-error';
    const detail = error && error.message ? error.message : String(error || '未知错误');
    box.textContent = `Mermaid 渲染失败：${detail}`;
    canvas.appendChild(box);

    if (source) source.hidden = false;
    console.warn('[Markdown Reader] mermaid failed:', error);
  }

  async function renderMermaidBlocks() {
    const token = ++mermaidToken;

    if (!docReady || !dom.doc.querySelector('.mermaid-block')) return;
    if (!initMermaid()) {
      dom.doc.querySelectorAll('.mermaid-block').forEach((block) => {
        mermaidError(block, new Error('Mermaid 组件未加载'));
      });
      return;
    }

    try {
      await document.fonts.ready;
    } catch {
      // Font loading API is best-effort.
    }
    if (token !== mermaidToken) return;

    const blocks = Array.from(dom.doc.querySelectorAll('.mermaid-block'));
    for (let index = 0; index < blocks.length; index += 1) {
      if (token !== mermaidToken) return;

      const block = blocks[index];
      const canvas = block.querySelector('.mermaid-canvas');
      const source = block.querySelector('.mermaid-source');
      const code = source ? source.textContent : '';
      if (!canvas) continue;

      if (source) source.hidden = true;
      block.classList.remove('is-error', 'is-wide');
      canvas.removeAttribute('title');
      canvas.textContent = '';
      const status = document.createElement('div');
      status.className = 'mermaid-status';
      status.textContent = '正在渲染图表…';
      canvas.appendChild(status);

      if (!code.trim()) {
        mermaidError(block, new Error('代码块为空'));
        continue;
      }

      const id = `ry-mermaid-${token}-${index}`;
      try {
        const result = await mermaid.render(id, code);
        if (token !== mermaidToken) return;

        const svgMarkup = typeof result === 'string' ? result : result.svg;
        const bindFunctions = typeof result === 'object' && result ? result.bindFunctions : null;

        canvas.textContent = '';
        canvas.innerHTML = svgMarkup;

        const svg = canvas.querySelector('svg');
        if (svg) fitMermaidSvg(block, svg);
        if (typeof bindFunctions === 'function') bindFunctions(canvas);
      } catch (error) {
        if (token !== mermaidToken) return;
        mermaidError(block, error);

        const stray = document.getElementById(`d${id}`);
        if (stray) stray.remove();
      }
    }

    if (token === mermaidToken) updateProgress();
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                           */
  /* ---------------------------------------------------------------- */

  function bindEvents() {
    dom.openForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = normalizeInput(dom.urlInput.value);
      if (!url) {
        dom.landingError.textContent = '请输入有效的 Markdown 地址（http(s) 链接或本地文件路径）。';
        dom.landingError.hidden = false;
        dom.urlInput.focus();
        return;
      }
      location.href = `viewer.html?src=${encodeURIComponent(url.href)}`;
    });

    dom.urlInput.addEventListener('input', () => {
      dom.landingError.hidden = true;
    });

    dom.retryBtn.addEventListener('click', () => {
      if (currentSource) load(currentSource);
    });

    dom.changeBtn.addEventListener('click', () => {
      const url = new URL(location.href);
      url.search = '';
      url.hash = '';
      location.href = url.href;
    });

    dom.reloadBtn.addEventListener('click', () => {
      if (currentSource) load(currentSource);
    });

    dom.rawBtn.addEventListener('click', () => {
      if (!currentRawUrl) return;
      try {
        const url = new URL(currentRawUrl);
        url.hash = 'ry-raw';
        window.open(url.href, '_blank', 'noopener,noreferrer');
      } catch {
        // Ignore malformed raw URLs.
      }
    });

    dom.doc.addEventListener('click', async (event) => {
      const image = event.target.closest('img');
      if (image && dom.doc.contains(image)) {
        event.preventDefault();
        openLightbox(image);
        return;
      }

      const button = event.target.closest('.copy-btn');
      if (!button || !dom.doc.contains(button)) return;

      const block = button.closest('.code-block, .mermaid-block');
      if (!block) return;

      const source = block.classList.contains('mermaid-block')
        ? block.querySelector('.mermaid-source')
        : block.querySelector('pre code');
      if (!source) return;

      const ok = await copyText(source.textContent || '');
      if (!ok) {
        showToast('复制失败');
        return;
      }

      const previous = button.textContent;
      button.textContent = '已复制';
      window.setTimeout(() => {
        button.textContent = previous;
      }, 1400);
    });

    window.addEventListener('scroll', queueProgress, { passive: true });
    window.addEventListener('resize', queueProgress, { passive: true });

    bindLightboxEvents();
  }

  /* ---------------------------------------------------------------- */
  /* Start                                                            */
  /* ---------------------------------------------------------------- */

  function start() {
    initTheme();
    bindEvents();
    updateProgress();

    const source = new URLSearchParams(location.search).get('src');
    if (!source) {
      showLanding();
      return;
    }

    const url = normalizeInput(source);
    if (!url) {
      showLanding();
      dom.landingError.textContent = '这个地址无效，只支持 http(s) 链接或本地文件路径。';
      dom.landingError.hidden = false;
      return;
    }

    load(url);
  }

  start();
})();
