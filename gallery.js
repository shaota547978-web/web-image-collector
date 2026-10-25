/**
 * Web Image Collector - Gallery Engine
 * 负责画廊渲染、滑块动态过滤、免费版配额拦截、3 并发下载池、150MB 内存保护与 JSZip 打包
 */

(function () {
  'use strict';

  // -------------------------------------------------------------
  // 1. 全局状态
  // -------------------------------------------------------------
  const state = {
    allImages: [],           // 嗅探到的所有图片列表 [{ url, width, height, alt, source }]
    filteredImages: [],      // 当前符合滑块与格式条件的图片列表
    selectedUrls: new Set(), // 当前已勾选的图片 URL
    isPro: false,            // 是否激活 Pro License
    proLimit: 20,            // 免费版单次最大允许勾选数量
    minWidth: 200,           // 默认最小过滤门槛 200px
    minHeight: 200,          // 默认最小过滤门槛 200px
    currentFormat: 'ALL',

    // 下载运行时状态
    isDownloading: false,
    cancelRequested: false,
    downloadMap: new Map(),  // url -> { status: 'idle'|'downloading'|'success'|'failed', error?: string, blob?: Blob, size?: number, filename?: string }
    totalDownloadedBytes: 0,
    quotaWarned: false,      // 是否已触发过 150MB 警告
    quotaPauseResolver: null,// 暂停等待用户决策的 Promise resolver
    activeWorkersCount: 0,

    // 原图穿透 (Deep Grab) 状态
    isDeepGrabbing: false,
    deepGrabCancelRequested: false
  };

  const MAX_CONCURRENCY = 3;
  const MAX_DEEP_CONCURRENCY = 2; // 穿透详情页严格限制为 2 并发
  const QUOTA_LIMIT_BYTES = 150 * 1024 * 1024; // 150MB

  // -------------------------------------------------------------
  // 2. DOM 元素缓存
  // -------------------------------------------------------------
  const dom = {
    sourceCapsule: document.getElementById('sourceCapsule'),
    sourceTitle: document.getElementById('sourceTitle'),
    sourceLink: document.getElementById('sourceLink'),

    btnProModal: document.getElementById('btnProModal'),
    proBtnText: document.getElementById('proBtnText'),
    btnDeepGrab: document.getElementById('btnDeepGrab'),
    deepGrabText: document.getElementById('deepGrabText'),
    deepGrabBadge: document.getElementById('deepGrabBadge'),
    btnDownloadZip: document.getElementById('btnDownloadZip'),
    downloadBadge: document.getElementById('downloadBadge'),

    sliderMinWidth: document.getElementById('sliderMinWidth'),
    sliderMinHeight: document.getElementById('sliderMinHeight'),
    valMinWidth: document.getElementById('valMinWidth'),
    valMinHeight: document.getElementById('valMinHeight'),
    formatChips: document.getElementById('formatChips'),

    btnSelectAll: document.getElementById('btnSelectAll'),
    btnInvertSelect: document.getElementById('btnInvertSelect'),
    btnSelectLarge: document.getElementById('btnSelectLarge'),
    btnClearSelect: document.getElementById('btnClearSelect'),

    statSelectedCount: document.getElementById('statSelectedCount'),
    statVisibleCount: document.getElementById('statVisibleCount'),
    statEstimatedSize: document.getElementById('statEstimatedSize'),
    freeLimitNotice: document.getElementById('freeLimitNotice'),

    alertBanner: document.getElementById('alertBanner'),
    alertBannerText: document.getElementById('alertBannerText'),
    btnAlertClose: document.getElementById('btnAlertClose'),

    emptyState: document.getElementById('emptyState'),
    emptySubtext: document.getElementById('emptySubtext'),
    galleryGrid: document.getElementById('galleryGrid'),

    // 穿透进度面板
    deepGrabConsole: document.getElementById('deepGrabConsole'),
    deepGrabPhaseText: document.getElementById('deepGrabPhaseText'),
    deepGrabProgressFill: document.getElementById('deepGrabProgressFill'),
    btnCancelDeepGrab: document.getElementById('btnCancelDeepGrab'),

    // 底部控制台
    bottomConsole: document.getElementById('bottomConsole'),
    consolePhaseText: document.getElementById('consolePhaseText'),
    consoleDetailText: document.getElementById('consoleDetailText'),
    consoleProgressCounter: document.getElementById('consoleProgressCounter'),
    progressBarFill: document.getElementById('progressBarFill'),
    btnCancelDownload: document.getElementById('btnCancelDownload'),
    errorSummaryBar: document.getElementById('errorSummaryBar'),
    errorBadgeCount: document.getElementById('errorBadgeCount'),
    btnToggleErrorDrawer: document.getElementById('btnToggleErrorDrawer'),
    errorDrawerIcon: document.getElementById('errorDrawerIcon'),
    errorDetailsList: document.getElementById('errorDetailsList'),

    // 模态框
    modalPro: document.getElementById('modalPro'),
    btnCloseProModal: document.getElementById('btnCloseProModal'),
    inputLicenseKey: document.getElementById('inputLicenseKey'),
    btnActivateLicense: document.getElementById('btnActivateLicense'),
    licenseStatusDisplay: document.getElementById('licenseStatusDisplay'),
    btnResetProTrial: document.getElementById('btnResetProTrial'),

    modalQuotaGuard: document.getElementById('modalQuotaGuard'),
    currentDownloadedSizeText: document.getElementById('currentDownloadedSizeText'),
    btnQuotaStopAndZip: document.getElementById('btnQuotaStopAndZip'),
    btnQuotaContinue: document.getElementById('btnQuotaContinue'),

    modalLightbox: document.getElementById('modalLightbox'),
    btnCloseLightbox: document.getElementById('btnCloseLightbox'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxResolution: document.getElementById('lightboxResolution'),
    lightboxFormat: document.getElementById('lightboxFormat'),
    lightboxUrl: document.getElementById('lightboxUrl'),
    btnCopyImageUrl: document.getElementById('btnCopyImageUrl'),
    btnDownloadSingleImg: document.getElementById('btnDownloadSingleImg')
  };

  // -------------------------------------------------------------
  // 3. 辅助函数
  // -------------------------------------------------------------
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function getUrlExtension(url) {
    if (!url) return 'jpg';
    if (url.startsWith('data:image/')) {
      const mime = url.substring(11, url.indexOf(';'));
      if (mime.includes('png')) return 'png';
      if (mime.includes('webp')) return 'webp';
      if (mime.includes('svg')) return 'svg';
      if (mime.includes('gif')) return 'gif';
      return 'jpg';
    }
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-zA-Z0-9]+)(?:[\?#]|$)/);
      if (match) {
        const ext = match[1].toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'svg', 'gif', 'bmp', 'ico', 'avif'].includes(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch {
      // 降级为 jpg
    }
    return 'jpg';
  }

  function detectImageFormat(item) {
    const ext = getUrlExtension(item.url).toUpperCase();
    if (ext === 'JPEG') return 'JPG';
    return ext;
  }

  function getBaseImageUrl(rawUrl) {
    if (!rawUrl) return '';
    if (rawUrl.startsWith('data:')) return rawUrl;
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return rawUrl.split('?')[0].split('#')[0];
    }
  }

  function enhanceToHighResUrl(rawUrl) {
    if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;
    try {
      const parsed = new URL(rawUrl);
      const host = parsed.hostname.toLowerCase();

      // 1. Unsplash (images.unsplash.com)
      if (host.includes('unsplash.com')) {
        const sp = parsed.searchParams;
        if (sp.has('w')) {
          const curW = parseInt(sp.get('w'), 10) || 0;
          if (curW < 2560) {
            sp.set('w', '2560');
          }
        }
        if (sp.has('q')) {
          sp.set('q', '85');
        }
        if (sp.get('fit') === 'crop') {
          sp.set('fit', 'max');
        }
        return parsed.href;
      }

      // 2. Imgix (*.imgix.net 或含 ixlib 标识)
      if (host.includes('imgix.net') || parsed.searchParams.has('ixlib')) {
        const sp = parsed.searchParams;
        if (sp.has('w')) {
          const curW = parseInt(sp.get('w'), 10) || 0;
          if (curW < 2560) {
            sp.set('w', '2560');
          }
        }
        if (sp.get('fit') === 'crop') {
          sp.set('fit', 'max');
        }
        if (sp.has('q')) {
          sp.set('q', '85');
        }
        return parsed.href;
      }

      // 3. Shopify (cdn.shopify.com)
      if (host.includes('cdn.shopify.com')) {
        parsed.pathname = parsed.pathname
          .replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|1024x1024|2048x2048)\.([a-zA-Z0-9]+)$/i, '.$1')
          .replace(/_\d+x\d*\.([a-zA-Z0-9]+)$/i, '.$1');

        if (parsed.searchParams.has('width')) {
          parsed.searchParams.delete('width');
        }
        return parsed.href;
      }

      // 4. 知乎 (zhimg.com)
      if (host.includes('zhimg.com')) {
        parsed.pathname = parsed.pathname.replace(/_b\.(jpg|png|jpeg)$/i, '_r.$1');
        return parsed.href;
      }

      // 5. 微博 (sinaimg.cn)
      if (host.includes('sinaimg.cn')) {
        parsed.pathname = parsed.pathname.replace(/\/(?:thumbnail|thumb\d+|mw\d+|orj\d+)\//i, '/large/');
        return parsed.href;
      }

      return rawUrl;
    } catch {
      return rawUrl;
    }
  }

  // -------------------------------------------------------------
  // 4. 初始化与数据加载
  // -------------------------------------------------------------
  async function init() {
    bindEvents();

    // 检查 Pro 授权状态
    await loadProStatus();

    // 读取嗅探任务数据
    await loadCollectorTaskData();
  }

  async function loadProStatus() {
    try {
      const result = await chrome.storage.local.get(['proLicense']);
      if (result && result.proLicense && result.proLicense.active) {
        state.isPro = true;
      } else {
        state.isPro = false;
      }
    } catch {
      state.isPro = false;
    }
    updateProUI();
  }

  function updateProUI() {
    if (state.isPro) {
      dom.btnProModal.className = 'btn-pro-badge pro-active';
      dom.proBtnText.textContent = 'PRO Active ✨';
      dom.licenseStatusDisplay.textContent = '当前状态：Pro 会员已激活 (无限制)';
      dom.freeLimitNotice.classList.add('pro-hidden');
    } else {
      dom.btnProModal.className = 'btn-pro-badge free-state';
      dom.proBtnText.textContent = 'Upgrade Pro 💎';
      dom.licenseStatusDisplay.textContent = '当前状态：免费版 (单次上限 20 张)';
      dom.freeLimitNotice.classList.remove('pro-hidden');
    }
    updateSelectionSummary();
  }

  async function loadCollectorTaskData() {
    try {
      const result = await chrome.storage.local.get(['currentCollectorTask']);
      const task = result ? result.currentCollectorTask : null;

      if (!task || !task.images || task.images.length === 0) {
        if (task && task.warning) {
          showAlert(task.warning);
        } else {
          showAlert('未检测到可用的网页采集数据。请在目标网页上点击扩展图标触发采集。');
        }
        renderEmptyState('未找到图片数据');
        return;
      }

      // 设置来源信息
      dom.sourceTitle.textContent = task.pageTitle || '未知网页';
      dom.sourceTitle.title = task.pageTitle || '';
      if (task.pageUrl) {
        dom.sourceLink.href = task.pageUrl;
      }

      if (task.warning) {
        showAlert(task.warning);
      }

      // 对图片进行 base_url 规范化去重与超清原画增强
      const dedupeMap = new Map();
      task.images.forEach(img => {
        const cleanUrl = enhanceToHighResUrl(img.url);
        const baseUrl = getBaseImageUrl(cleanUrl);
        if (!baseUrl) return;

        const currentScore = Math.max(img.width || 0, img.height || 0);

        if (dedupeMap.has(baseUrl)) {
          const existing = dedupeMap.get(baseUrl);
          const existingScore = Math.max(existing.width || 0, existing.height || 0);
          if (currentScore > existingScore) {
            existing.url = cleanUrl;
            existing.width = Math.max(existing.width || 0, img.width || 0);
            existing.height = Math.max(existing.height || 0, img.height || 0);
            if (img.alt) existing.alt = img.alt;
            if (img.detailUrl) {
              existing.detailUrl = img.detailUrl;
              existing.hasDetailLink = true;
            }
          } else if (img.detailUrl && !existing.detailUrl) {
            existing.detailUrl = img.detailUrl;
            existing.hasDetailLink = true;
          }
        } else {
          dedupeMap.set(baseUrl, {
            ...img,
            url: cleanUrl,
            baseUrl: baseUrl,
            detailUrl: img.detailUrl || null,
            hasDetailLink: !!img.detailUrl
          });
        }
      });

      state.allImages = Array.from(dedupeMap.values());

      // 更新深度穿透按钮展示状态
      updateDeepGrabButtonBadge();

      // 默认全选前 20 张（或全部若小于 20 张）
      applyFilters();
      preselectInitialImages();

    } catch (err) {
      console.error('[Gallery] 读取存储数据失败:', err);
      showAlert(`读取图片数据失败: ${err.message}`);
      renderEmptyState('读取数据失败');
    }
  }

  function preselectInitialImages() {
    state.selectedUrls.clear();
    const limit = state.isPro ? state.filteredImages.length : Math.min(state.proLimit, state.filteredImages.length);
    for (let i = 0; i < limit; i++) {
      state.selectedUrls.add(state.filteredImages[i].url);
    }
    updateSelectionSummary();
    renderGallery();
  }

  // -------------------------------------------------------------
  // 原图穿透 (Deep Grab) 辅助与启发式解析算法
  // -------------------------------------------------------------
  function updateDeepGrabButtonBadge() {
    const pendingCount = state.allImages.filter(img => img.hasDetailLink && img.detailUrl && img.deepGrabStatus !== 'success').length;
    if (pendingCount > 0) {
      dom.btnDeepGrab.classList.remove('hidden');
      dom.deepGrabText.textContent = `深度穿透 (${pendingCount})`;
      dom.deepGrabBadge.textContent = pendingCount;
    } else {
      const successCount = state.allImages.filter(img => img.deepGrabStatus === 'success').length;
      if (successCount > 0) {
        dom.btnDeepGrab.classList.remove('hidden');
        dom.deepGrabText.textContent = `穿透完成 (${successCount})`;
        dom.deepGrabBadge.textContent = '✓';
      } else {
        dom.btnDeepGrab.classList.add('hidden');
      }
    }
  }

  function renderDeepGrabBadge(img) {
    if (!img.hasDetailLink && !img.detailUrl) return '';

    if (img.deepGrabStatus === 'success') {
      const label = img.is4K ? '⚡ 4K 原图' : '⚡ HD 原图';
      return `<span class="badge-deep-grab success" title="已成功穿透详情页提取最高画质原图">${label}</span>`;
    }
    if (img.deepGrabStatus === 'resolving') {
      return `<span class="badge-deep-grab resolving">⚡ 解析中...</span>`;
    }
    if (img.deepGrabStatus === 'fallback') {
      return `<span class="badge-deep-grab fallback" title="详情页未发现更高清大图，已保留预览图">已保持预览图</span>`;
    }
    // 待穿透状态
    return `<span class="badge-deep-grab ready" title="检测到详情页：${escapeHtml(img.detailUrl)}，点击顶部深度穿透提取原画">⚡ 可提取原图</span>`;
  }

  function updateCardDeepGrabUI(item, cardEl) {
    const card = cardEl || dom.galleryGrid.querySelector(`.image-card[data-url="${CSS.escape(item.url)}"]`);
    if (!card) return;

    let badge = card.querySelector('.badge-deep-grab');
    const badgeHtml = renderDeepGrabBadge(item);

    if (!badgeHtml) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      const thumb = card.querySelector('.card-thumb-wrapper');
      if (thumb) {
        const temp = document.createElement('div');
        temp.innerHTML = badgeHtml;
        badge = temp.firstElementChild;
        thumb.appendChild(badge);
      }
    } else {
      badge.outerHTML = badgeHtml;
    }
  }

  function updateCardWithResolvedHero(item, oldUrl) {
    let card = dom.galleryGrid.querySelector(`.image-card[data-url="${CSS.escape(oldUrl)}"]`);
    if (!card) {
      card = dom.galleryGrid.querySelector(`.image-card[data-url="${CSS.escape(item.url)}"]`);
    }
    if (!card) return;

    card.dataset.url = item.url;

    const imgEl = card.querySelector('.card-thumb-wrapper img');
    if (imgEl) {
      imgEl.src = item.url;
    }

    const resBadge = card.querySelector('.badge-res');
    if (resBadge) {
      const isLarge = (item.width >= 1000 || item.height >= 1000);
      resBadge.textContent = (item.width > 0 && item.height > 0) ? `${item.width} × ${item.height}` : '未知尺寸';
      if (isLarge) resBadge.classList.add('large-res');
    }

    updateCardDeepGrabUI(item, card);
  }

  function preloadImageDimensions(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => {
        resolve({ width: 0, height: 0 });
      }, 5000);

      img.onload = () => {
        clearTimeout(timer);
        resolve({
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0
        });
      };

      img.onerror = () => {
        clearTimeout(timer);
        resolve({ width: 0, height: 0 });
      };

      img.src = url;
    });
  }

  /**
   * 详情页 HTML 解析与“主角图”启发式算法
   */
  async function resolveHeroImageFromDetail(detailUrl) {
    if (!detailUrl) return null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(detailUrl, {
        method: 'GET',
        signal: controller.signal,
        credentials: 'omit',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }
      });
      clearTimeout(timeoutId);

      if (!resp.ok) return null;
      const htmlText = await resp.text();
      if (!htmlText) return null;

      const doc = new DOMParser().parseFromString(htmlText, 'text/html');

      function isValidImgCandidate(u) {
        if (!u || typeof u !== 'string') return false;
        const t = u.trim();
        if (!t || t.startsWith('javascript:') || t.startsWith('data:') || t.startsWith('#')) return false;
        return true;
      }

      // 优先级 A（官方元数据）：检查 og:image 与 twitter:image
      const ogMeta = doc.querySelector('meta[property="og:image:secure_url"]') ||
                     doc.querySelector('meta[property="og:image"]') ||
                     doc.querySelector('meta[name="twitter:image"]') ||
                     doc.querySelector('meta[name="twitter:image:src"]');
      if (ogMeta) {
        const content = ogMeta.getAttribute('content');
        if (isValidImgCandidate(content)) {
          try {
            return new URL(content.trim(), detailUrl).href;
          } catch {}
        }
      }

      // 优先级 B（下载直链）：检查页面中是否存在带有 download 属性的 <a>，或类名包含 download-btn、btn-download、origin-image、view-full 的 <a> 链接
      const downloadSelectors = [
        'a[download]',
        'a.download-btn',
        'a.btn-download',
        'a.origin-image',
        'a.view-full',
        'a.full-size',
        'a[href*="download"]',
        'a[class*="download"]',
        'a[id*="download"]'
      ];
      const downloadLinks = doc.querySelectorAll(downloadSelectors.join(','));
      for (const a of downloadLinks) {
        const rawHref = a.getAttribute('href');
        if (isValidImgCandidate(rawHref)) {
          try {
            const abs = new URL(rawHref.trim(), detailUrl).href;
            if (/\.(jpe?g|png|webp|avif|bmp)(?:[\?#]|$)/i.test(abs) || /\/(?:raw|original|large|download)\//i.test(abs)) {
              return abs;
            }
          } catch {}
        }
      }

      // 优先级 C（主画布启发式）：检索详情页中所有的 <img>，选取 width*height 最大、或文件名含有 raw/original/large 的一张作为主角
      const images = Array.from(doc.querySelectorAll('img'));
      let bestCandidate = null;
      let maxScore = -1;

      const excludeRegex = /(avatar|logo|icon|ad-|advertisement|banner|related|recommend|comment|user|thumb|small)/i;
      const highResRegex = /(raw|original|large|full|wallpaper|origin|master|hires)/i;

      for (const img of images) {
        const rawSrc = img.getAttribute('data-original') ||
                       img.getAttribute('data-src') ||
                       img.getAttribute('data-highres') ||
                       img.getAttribute('src');

        if (!isValidImgCandidate(rawSrc)) continue;

        try {
          const absSrc = new URL(rawSrc.trim(), detailUrl).href;
          const className = `${img.className || ''} ${img.parentElement?.className || ''}`;
          const id = `${img.id || ''} ${img.parentElement?.id || ''}`;
          const alt = img.getAttribute('alt') || '';

          if (excludeRegex.test(className) || excludeRegex.test(id) || excludeRegex.test(absSrc) || excludeRegex.test(alt)) {
            continue;
          }

          const w = parseInt(img.getAttribute('width') || img.getAttribute('data-width') || '0', 10);
          const h = parseInt(img.getAttribute('height') || img.getAttribute('data-height') || '0', 10);
          let score = (w * h) || 1;

          if (highResPattern.test(absSrc) || highResPattern.test(className) || highResPattern.test(id)) {
            score += 10000000;
          }

          // 检查 srcset
          const rawSrcset = img.getAttribute('srcset');
          if (rawSrcset) {
            const best = extractBestFromSrcset(rawSrcset);
            if (best && best.score > 1000) {
              score += best.score * 5000;
            }
          }

          if (score > maxScore) {
            maxScore = score;
            bestCandidate = absSrc;
          }
        } catch {}
      }

      if (bestCandidate) {
        return bestCandidate;
      }

      return null;
    } catch (err) {
      console.warn('[Deep Grab] 穿透解析详情页失败:', detailUrl, err.message);
      return null;
    }
  }

  function updateDeepGrabConsoleProgress(completed, total, phaseText) {
    if (phaseText) dom.deepGrabPhaseText.textContent = phaseText;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    dom.deepGrabProgressFill.style.width = `${percent}%`;
  }

  /**
   * 启动受控并发穿透流程 (并发限制 2，微延迟 200ms)
   */
  async function startDeepGrab() {
    if (state.isDeepGrabbing) return;

    const candidates = state.allImages.filter(img => img.hasDetailLink && img.detailUrl && img.deepGrabStatus !== 'success');
    if (candidates.length === 0) {
      showAlert('当前画廊没有检测到可穿透的详情页，或者全部图片已穿透完成！');
      return;
    }

    state.isDeepGrabbing = true;
    state.deepGrabCancelRequested = false;
    dom.btnDeepGrab.disabled = true;
    dom.deepGrabConsole.classList.remove('hidden');

    const total = candidates.length;
    let finishedCount = 0;
    let successCount = 0;
    let fallbackCount = 0;

    updateDeepGrabConsoleProgress(0, total, `正在穿透详情页: 0/${total}...`);

    let currentIndex = 0;

    async function deepWorker() {
      while (currentIndex < candidates.length) {
        if (state.deepGrabCancelRequested) break;
        const myIdx = currentIndex++;
        const item = candidates[myIdx];

        item.deepGrabStatus = 'resolving';
        updateCardDeepGrabUI(item);

        updateDeepGrabConsoleProgress(
          finishedCount,
          total,
          `正在穿透详情页 (${finishedCount + 1}/${total})...`
        );

        // 保护性微延迟 200ms
        await new Promise(r => setTimeout(r, 200));
        if (state.deepGrabCancelRequested) break;

        const heroUrl = await resolveHeroImageFromDetail(item.detailUrl);

        if (heroUrl && heroUrl !== item.url) {
          const dims = await preloadImageDimensions(heroUrl);
          const oldUrl = item.url;
          item.originalPreviewUrl = oldUrl;
          item.url = heroUrl;
          if (dims.width > 0) item.width = dims.width;
          if (dims.height > 0) item.height = dims.height;

          item.is4K = Math.max(item.width, item.height) >= 2560;
          item.deepGrabStatus = 'success';
          successCount++;

          if (state.selectedUrls.has(oldUrl)) {
            state.selectedUrls.delete(oldUrl);
            state.selectedUrls.add(heroUrl);
          }

          updateCardWithResolvedHero(item, oldUrl);
        } else {
          item.deepGrabStatus = 'fallback';
          fallbackCount++;
          updateCardDeepGrabUI(item);
        }

        finishedCount++;
        updateDeepGrabConsoleProgress(finishedCount, total);
      }
    }

    const pool = [];
    const workerCount = Math.min(MAX_DEEP_CONCURRENCY, candidates.length);
    for (let i = 0; i < workerCount; i++) {
      pool.push(deepWorker());
    }

    await Promise.all(pool);

    state.isDeepGrabbing = false;
    dom.btnDeepGrab.disabled = false;
    dom.deepGrabConsole.classList.add('hidden');
    updateDeepGrabButtonBadge();
    updateSelectionSummary();

    if (state.deepGrabCancelRequested) {
      showAlert(`深度穿透已中止：已处理 ${finishedCount} 张，成功提取 ${successCount} 张高清原图。`);
    } else {
      showAlert(`🎉 深度穿透完成！成功提取 ${successCount} 张 4K/HD 原画大图，${fallbackCount} 张保持原预览。`);
    }
  }

  // -------------------------------------------------------------
  // 5. 过滤与画廊渲染
  // -------------------------------------------------------------
  function applyFilters() {
    state.filteredImages = state.allImages.filter(img => {
      // 宽度过滤
      if (state.minWidth > 0 && img.width > 0 && img.width < state.minWidth) {
        return false;
      }
      // 高度过滤
      if (state.minHeight > 0 && img.height > 0 && img.height < state.minHeight) {
        return false;
      }
      // 格式过滤
      if (state.currentFormat !== 'ALL') {
        const fmt = detectImageFormat(img);
        if (state.currentFormat === 'JPG' && !['JPG', 'JPEG'].includes(fmt)) return false;
        if (state.currentFormat !== 'JPG' && fmt !== state.currentFormat) return false;
      }
      return true;
    });

    renderGallery();
    updateSelectionSummary();
  }

  function renderGallery() {
    dom.galleryGrid.innerHTML = '';

    if (state.filteredImages.length === 0) {
      dom.emptyState.classList.remove('hidden');
      return;
    }

    dom.emptyState.classList.add('hidden');

    const fragment = document.createDocumentFragment();

    state.filteredImages.forEach((img, idx) => {
      const card = document.createElement('div');
      const isSelected = state.selectedUrls.has(img.url);
      const dlInfo = state.downloadMap.get(img.url);

      card.className = `image-card ${isSelected ? 'selected' : ''} ${dlInfo && dlInfo.status === 'failed' ? 'card-failed' : ''}`;
      card.dataset.url = img.url;

      const format = detectImageFormat(img);
      const isLarge = (img.width >= 1000 || img.height >= 1000);
      const resText = (img.width > 0 && img.height > 0) ? `${img.width} × ${img.height}` : '未知尺寸';

      card.innerHTML = `
        <div class="card-thumb-wrapper">
          <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || 'image')}" loading="lazy" />
          ${renderDeepGrabBadge(img)}
        </div>

        <div class="card-checkbox-wrapper">
          <div class="custom-checkbox">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        </div>

        <div class="card-hover-actions">
          <button class="action-btn-circle btn-preview" title="放大预览" data-idx="${idx}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              <line x1="11" y1="8" x2="11" y2="14"></line>
              <line x1="8" y1="11" x2="14" y2="11"></line>
            </svg>
          </button>
          <button class="action-btn-circle btn-card-download" title="单张下载" data-url="${escapeHtml(img.url)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>
        </div>

        <div class="card-meta">
          <div class="meta-badges">
            <span class="badge badge-res ${isLarge ? 'large-res' : ''}">${resText}</span>
            <span class="badge badge-fmt">${format}</span>
          </div>
          <span class="badge" style="font-size: 10px; color: var(--text-dim);">${img.source || 'img'}</span>
        </div>
      `;

      // 如果有下载状态覆盖层
      if (dlInfo && dlInfo.status !== 'idle') {
        const overlay = document.createElement('div');
        overlay.className = 'card-status-overlay';
        if (dlInfo.status === 'downloading') {
          overlay.innerHTML = `
            <div class="overlay-icon-spinner"></div>
            <span class="overlay-text">正在下载...</span>
          `;
        } else if (dlInfo.status === 'success') {
          overlay.innerHTML = `
            <div class="overlay-icon-success">✓</div>
            <span class="overlay-text">${formatBytes(dlInfo.size)}</span>
          `;
        } else if (dlInfo.status === 'failed') {
          overlay.innerHTML = `
            <div class="overlay-icon-failed">⚠️</div>
            <span class="overlay-text failed" title="${escapeHtml(dlInfo.error || '失败')}">下载失败</span>
          `;
        }
        card.appendChild(overlay);
      }

      // 卡片点击事件：切换多选
      card.addEventListener('click', (e) => {
        // 如果点击的是放大镜或单张下载按钮，不触发卡片选中切换
        if (e.target.closest('.card-hover-actions')) return;
        toggleSelectImage(img.url, card);
      });

      // 绑定悬浮按钮事件
      const btnPreview = card.querySelector('.btn-preview');
      btnPreview.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(img);
      });

      const btnCardDownload = card.querySelector('.btn-card-download');
      btnCardDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSingleImage(img.url);
      });

      fragment.appendChild(card);
    });

    dom.galleryGrid.appendChild(fragment);
  }

  function renderEmptyState(subtext) {
    dom.galleryGrid.innerHTML = '';
    dom.emptyState.classList.remove('hidden');
    if (subtext) dom.emptySubtext.textContent = subtext;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[m]);
  }

  // -------------------------------------------------------------
  // 6. 选中与商业配额拦截逻辑 (Max 20 for Free)
  // -------------------------------------------------------------
  function toggleSelectImage(url, cardEl) {
    const isCurrentlySelected = state.selectedUrls.has(url);

    if (isCurrentlySelected) {
      state.selectedUrls.delete(url);
      if (cardEl) cardEl.classList.remove('selected');
    } else {
      // 检查免费版 20 张配额上限
      if (!state.isPro && state.selectedUrls.size >= state.proLimit) {
        showProModal(true, '免费版单次最多勾选 20 张图片，请升级 Pro 解锁无限批量导出！');
        return;
      }
      state.selectedUrls.add(url);
      if (cardEl) cardEl.classList.add('selected');
    }

    updateSelectionSummary();
  }

  function updateSelectionSummary() {
    const selectedCount = state.selectedUrls.size;
    const visibleCount = state.filteredImages.length;

    dom.statSelectedCount.textContent = selectedCount;
    dom.statVisibleCount.textContent = visibleCount;
    dom.downloadBadge.textContent = selectedCount;

    // 预估容量：假设高清图平均每张 600KB
    const estBytes = selectedCount * 600 * 1024;
    dom.statEstimatedSize.textContent = formatBytes(estBytes);

    dom.btnDownloadZip.disabled = selectedCount === 0 || state.isDownloading;
  }

  function selectAllVisible() {
    if (state.filteredImages.length === 0) return;

    if (!state.isPro && state.filteredImages.length > state.proLimit) {
      state.selectedUrls.clear();
      for (let i = 0; i < state.proLimit; i++) {
        state.selectedUrls.add(state.filteredImages[i].url);
      }
      showProModal(true, `免费版已为您自动勾选前 ${state.proLimit} 张。升级 Pro 会员可一键全选所有图片！`);
    } else {
      state.filteredImages.forEach(img => state.selectedUrls.add(img.url));
    }

    renderGallery();
    updateSelectionSummary();
  }

  function invertSelection() {
    const newSelected = new Set();
    const candidates = [];

    state.filteredImages.forEach(img => {
      if (!state.selectedUrls.has(img.url)) {
        candidates.push(img.url);
      }
    });

    if (!state.isPro && candidates.length > state.proLimit) {
      candidates.slice(0, state.proLimit).forEach(url => newSelected.add(url));
      showProModal(true, `反选结果超过 ${state.proLimit} 张，免费版已为您选取前 ${state.proLimit} 张。`);
    } else {
      candidates.forEach(url => newSelected.add(url));
    }

    state.selectedUrls = newSelected;
    renderGallery();
    updateSelectionSummary();
  }

  function selectLargeImagesOnly() {
    state.selectedUrls.clear();
    const largeList = state.filteredImages.filter(img => img.width >= 800 || img.height >= 800);

    if (largeList.length === 0) {
      showAlert('当前筛选条件下未找到宽高 > 800px 的高清大图。');
      return;
    }

    if (!state.isPro && largeList.length > state.proLimit) {
      largeList.slice(0, state.proLimit).forEach(img => state.selectedUrls.add(img.url));
      showProModal(true, `发现 ${largeList.length} 张高清大图。免费版已勾选前 ${state.proLimit} 张，升级 Pro 可一键导出全部！`);
    } else {
      largeList.forEach(img => state.selectedUrls.add(img.url));
    }

    renderGallery();
    updateSelectionSummary();
  }

  function clearSelection() {
    state.selectedUrls.clear();
    renderGallery();
    updateSelectionSummary();
  }

  // -------------------------------------------------------------
  // 7. 并发控制下载池 (Max 3 Concurrency) 与 150MB 内存保护
  // -------------------------------------------------------------
  async function startBatchDownload() {
    if (state.selectedUrls.size === 0 || state.isDownloading) return;

    // 严禁外部依赖未载入
    if (typeof JSZip === 'undefined') {
      showAlert('本地 JSZip 依赖库未就绪，请检查 libs/jszip.min.js 文件。');
      return;
    }

    state.isDownloading = true;
    state.cancelRequested = false;
    state.totalDownloadedBytes = 0;
    state.quotaWarned = false;
    state.downloadMap.clear();

    dom.btnDownloadZip.disabled = true;
    dom.bottomConsole.classList.remove('hidden');
    dom.errorSummaryBar.classList.add('hidden');
    dom.errorDetailsList.innerHTML = '';
    dom.errorBadgeCount.textContent = '0 张图片下载失败';

    const targetUrls = Array.from(state.selectedUrls);
    const totalCount = targetUrls.length;

    updateConsoleProgress(0, totalCount, '正在初始化下载连接...', `并发池限制: ${MAX_CONCURRENCY} | 目标: ${totalCount} 张`);

    // 初始化每张卡片状态
    targetUrls.forEach(url => {
      state.downloadMap.set(url, { status: 'pending' });
    });
    renderGallery();

    let completedCount = 0;
    let failedCount = 0;
    const failedList = [];

    // 并发池调度器
    async function runPool() {
      let currentIndex = 0;

      async function worker() {
        while (currentIndex < targetUrls.length) {
          if (state.cancelRequested) break;

          const myIndex = currentIndex++;
          const url = targetUrls[myIndex];

          // 检查并等待 150MB 保护锁
          if (state.quotaPauseResolver) {
            await state.quotaPauseResolver.promise;
          }
          if (state.cancelRequested) break;

          state.downloadMap.set(url, { status: 'downloading' });
          updateCardStatusUI(url, 'downloading');

          updateConsoleProgress(
            completedCount,
            totalCount,
            `正在并发下载 (${completedCount + 1}/${totalCount})...`,
            `已占用内存: ${formatBytes(state.totalDownloadedBytes)}`
          );

          // 执行下载
          const fetchResult = await fetchImageWithFallback(url);

          if (fetchResult.success) {
            const blob = fetchResult.blob;
            state.totalDownloadedBytes += blob.size;

            state.downloadMap.set(url, {
              status: 'success',
              blob: blob,
              size: blob.size,
              filename: generateFileName(url, myIndex + 1, blob.type)
            });
            updateCardStatusUI(url, 'success', blob.size);

            // 检查 150MB 保护上限
            if (!state.quotaWarned && state.totalDownloadedBytes >= QUOTA_LIMIT_BYTES) {
              state.quotaWarned = true;
              pauseForQuotaGuard();
            }

          } else {
            failedCount++;
            failedList.push({ url, error: fetchResult.error });
            state.downloadMap.set(url, {
              status: 'failed',
              error: fetchResult.error
            });
            updateCardStatusUI(url, 'failed', 0, fetchResult.error);
          }

          completedCount++;
          const progressPercent = Math.round((completedCount / totalCount) * 80); // 80% 留给下载，20% 留给 ZIP 压缩
          dom.progressBarFill.style.width = `${progressPercent}%`;
          dom.consoleProgressCounter.textContent = `${completedCount} / ${totalCount}`;
        }
      }

      // 启动 MAX_CONCURRENCY 个 worker
      const pool = [];
      const concurrency = Math.min(MAX_CONCURRENCY, targetUrls.length);
      for (let i = 0; i < concurrency; i++) {
        pool.push(worker());
      }

      await Promise.all(pool);
    }

    try {
      await runPool();

      if (state.cancelRequested) {
        dom.consolePhaseText.textContent = '下载已由用户取消';
        finishDownloadSession();
        return;
      }

      // 渲染错误面板 (若有失败项)
      if (failedList.length > 0) {
        showFailedDrawer(failedList);
      }

      // 汇总成功的 Blob
      const successfulItems = [];
      state.downloadMap.forEach((val) => {
        if (val.status === 'success' && val.blob) {
          successfulItems.push(val);
        }
      });

      if (successfulItems.length === 0) {
        dom.consolePhaseText.textContent = '所有选中的图片均下载失败（受限于跨域或私有防盗链）';
        dom.progressBarFill.style.width = '100%';
        showAlert('选中的所有图片均因目标站点 CORS / 防盗链限制未能获取，无法生成压缩包。');
        finishDownloadSession();
        return;
      }

      // 阶段 2：执行本地 JSZip 打包
      dom.consolePhaseText.textContent = `正在生成 ZIP 压缩包 (成功 ${successfulItems.length} 张)...`;
      dom.consoleDetailText.textContent = `总包体积预估: ${formatBytes(state.totalDownloadedBytes)}`;

      const zip = new JSZip();
      successfulItems.forEach(item => {
        zip.file(item.filename, item.blob);
      });

      // 异步生成 ZIP
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 4 }
      }, (metadata) => {
        const zipPercent = 80 + Math.round(metadata.percent * 0.2);
        dom.progressBarFill.style.width = `${zipPercent}%`;
        dom.consoleDetailText.textContent = `ZIP 压缩中: ${metadata.percent.toFixed(0)}%`;
      });

      // 阶段 3：唤起下载保存
      dom.progressBarFill.style.width = '100%';
      dom.consolePhaseText.textContent = '打包完成！正在调起浏览器原生保存...';
      triggerSaveZip(zipBlob);

    } catch (err) {
      console.error('[Gallery] 批量打包流程发生异常:', err);
      showAlert(`打包异常: ${err.message}`);
      dom.consolePhaseText.textContent = '打包过程中遇到错误中断';
    } finally {
      finishDownloadSession();
    }
  }

  function finishDownloadSession() {
    state.isDownloading = false;
    dom.btnDownloadZip.disabled = false;
    state.quotaPauseResolver = null;
  }

  // 单张图片下载（带 CORS 失败降级捕获）
  async function fetchImageWithFallback(url) {
    // 1. 如果是 data URL
    if (url.startsWith('data:')) {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        return { success: true, blob };
      } catch (err) {
        return { success: false, error: 'Data URL 解析失败' };
      }
    }

    // 2. 主动发起跨域 fetch 请求
    try {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      if (!blob || blob.size === 0) {
        throw new Error('获取到的图片内容为空 (0 bytes)');
      }
      return { success: true, blob };

    } catch (fetchErr) {
      // 3. 降级尝试：利用 Image 标签 + Canvas 转 Blob（应对部分允许绘制但不响应 fetch 的场景）
      try {
        const canvasBlob = await fetchViaCanvasFallback(url);
        return { success: true, blob: canvasBlob };
      } catch {
        return {
          success: false,
          error: fetchErr.message || '跨域限制 (CORS) 或服务端防盗链拦截'
        };
      }
    }
  }

  function fetchViaCanvasFallback(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const timer = setTimeout(() => {
        img.src = '';
        reject(new Error('Canvas 降级请求超时'));
      }, 5000);

      img.onload = () => {
        clearTimeout(timer);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);

          canvas.toBlob(blob => {
            if (blob && blob.size > 0) {
              resolve(blob);
            } else {
              reject(new Error('Canvas 导出 Blob 失败'));
            }
          }, 'image/png');
        } catch (canvasErr) {
          reject(canvasErr);
        }
      };

      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Image 降级加载失败'));
      };

      img.src = url;
    });
  }

  function generateFileName(url, index, mimeType) {
    const padIndex = String(index).padStart(3, '0');
    let ext = 'jpg';

    if (mimeType) {
      if (mimeType.includes('png')) ext = 'png';
      else if (mimeType.includes('webp')) ext = 'webp';
      else if (mimeType.includes('svg')) ext = 'svg';
      else if (mimeType.includes('gif')) ext = 'gif';
      else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
      else ext = getUrlExtension(url);
    } else {
      ext = getUrlExtension(url);
    }

    return `image_${padIndex}.${ext}`;
  }

  // 150MB 内存保护暂停
  function pauseForQuotaGuard() {
    let resolver;
    const promise = new Promise(resolve => {
      resolver = resolve;
    });
    state.quotaPauseResolver = { promise, resolve: resolver };

    dom.currentDownloadedSizeText.textContent = formatBytes(state.totalDownloadedBytes);
    dom.modalQuotaGuard.classList.remove('hidden');
  }

  function resumeQuotaGuard(continueDownload) {
    dom.modalQuotaGuard.classList.add('hidden');
    if (!continueDownload) {
      // 停止后续下载，立即打包
      state.cancelRequested = true;
    }
    if (state.quotaPauseResolver) {
      state.quotaPauseResolver.resolve();
      state.quotaPauseResolver = null;
    }
  }

  // 触发保存 ZIP 文件
  function triggerSaveZip(blob) {
    const filename = `images_bundle_${Date.now()}.zip`;
    const objectUrl = URL.createObjectURL(blob);

    if (chrome && chrome.downloads && typeof chrome.downloads.download === 'function') {
      chrome.downloads.download({
        url: objectUrl,
        filename: filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          fallbackAnchorDownload(objectUrl, filename);
        } else {
          console.log('[Gallery] 原生下载任务已创建, ID:', downloadId);
        }
      });
    } else {
      fallbackAnchorDownload(objectUrl, filename);
    }

    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 60000);
  }

  function fallbackAnchorDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function updateCardStatusUI(url, status, size = 0, error = '') {
    const card = dom.galleryGrid.querySelector(`.image-card[data-url="${CSS.escape(url)}"]`);
    if (!card) return;

    let overlay = card.querySelector('.card-status-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'card-status-overlay';
      card.appendChild(overlay);
    }

    if (status === 'downloading') {
      overlay.innerHTML = `
        <div class="overlay-icon-spinner"></div>
        <span class="overlay-text">正在下载...</span>
      `;
    } else if (status === 'success') {
      overlay.innerHTML = `
        <div class="overlay-icon-success">✓</div>
        <span class="overlay-text">${formatBytes(size)}</span>
      `;
    } else if (status === 'failed') {
      card.classList.add('card-failed');
      overlay.innerHTML = `
        <div class="overlay-icon-failed">⚠️</div>
        <span class="overlay-text failed" title="${escapeHtml(error)}">下载失败</span>
      `;
    }
  }

  function updateConsoleProgress(completed, total, phaseText, detailText) {
    if (phaseText) dom.consolePhaseText.textContent = phaseText;
    if (detailText) dom.consoleDetailText.textContent = detailText;
    dom.consoleProgressCounter.textContent = `${completed} / ${total}`;
  }

  function showFailedDrawer(failedList) {
    dom.errorSummaryBar.classList.remove('hidden');
    dom.errorBadgeCount.textContent = `${failedList.length} 张图片下载失败`;

    dom.errorDetailsList.innerHTML = failedList.map(item => `
      <div class="error-item">
        <span class="err-url" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
        <span class="err-msg">${escapeHtml(item.error)}</span>
      </div>
    `).join('');
  }

  // -------------------------------------------------------------
  // 8. 单张下载与 Lightbox 大图预览
  // -------------------------------------------------------------
  async function downloadSingleImage(url) {
    try {
      const ext = getUrlExtension(url);
      const filename = `single_image_${Date.now()}.${ext}`;

      if (chrome && chrome.downloads && typeof chrome.downloads.download === 'function') {
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: true
        }, (id) => {
          if (chrome.runtime.lastError) {
            fallbackAnchorDownload(url, filename);
          }
        });
      } else {
        fallbackAnchorDownload(url, filename);
      }
    } catch (err) {
      fallbackAnchorDownload(url, `image_${Date.now()}.jpg`);
    }
  }

  function openLightbox(imgItem) {
    dom.lightboxImg.src = imgItem.url;
    dom.lightboxResolution.textContent = (imgItem.width && imgItem.height) ? `${imgItem.width} × ${imgItem.height}` : '未知尺寸';
    dom.lightboxFormat.textContent = detectImageFormat(imgItem);
    dom.lightboxUrl.textContent = imgItem.url;
    dom.modalLightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    dom.modalLightbox.classList.add('hidden');
    dom.lightboxImg.src = '';
  }

  // -------------------------------------------------------------
  // 9. Pro 会员 License 商业层逻辑 (MOCK-PRO-2026)
  // -------------------------------------------------------------
  function showProModal(isAutoTrigger = false, reason = '') {
    dom.modalPro.classList.remove('hidden');
    if (reason) {
      dom.inputLicenseKey.placeholder = '输入 MOCK-PRO-2026 免费解锁';
    }
  }

  function closeProModal() {
    dom.modalPro.classList.add('hidden');
  }

  async function activateLicenseKey() {
    const rawInput = (dom.inputLicenseKey.value || '').trim();
    const cleanKey = rawInput.toUpperCase().replace(/\s+/g, '');

    if (cleanKey === 'MOCK-PRO-2026') {
      const licenseData = {
        active: true,
        code: 'MOCK-PRO-2026',
        activatedAt: Date.now()
      };

      await chrome.storage.local.set({ proLicense: licenseData });
      state.isPro = true;
      updateProUI();
      closeProModal();
      showAlert('🎉 恭喜！Pro 会员已成功激活，已解除单次 20 张配额上限！');
    } else {
      showAlert('❌ 无效的授权码！验收请使用测试码：MOCK-PRO-2026');
    }
  }

  async function resetProTrial() {
    await chrome.storage.local.remove(['proLicense']);
    state.isPro = false;
    updateProUI();
    showAlert('已成功重置为免费版。您可以再次测试单次 20 张拦截限制。');
  }

  function showAlert(text) {
    dom.alertBannerText.textContent = text;
    dom.alertBanner.classList.remove('hidden');
  }

  function hideAlert() {
    dom.alertBanner.classList.add('hidden');
  }

  // -------------------------------------------------------------
  // 10. 事件监听器绑定
  // -------------------------------------------------------------
  function bindEvents() {
    // 宽度滑块
    dom.sliderMinWidth.addEventListener('input', (e) => {
      state.minWidth = parseInt(e.target.value, 10) || 0;
      dom.valMinWidth.textContent = `${state.minWidth} px`;
      applyFilters();
    });

    // 高度滑块
    dom.sliderMinHeight.addEventListener('input', (e) => {
      state.minHeight = parseInt(e.target.value, 10) || 0;
      dom.valMinHeight.textContent = `${state.minHeight} px`;
      applyFilters();
    });

    // 格式过滤 Chips
    dom.formatChips.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        dom.formatChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        state.currentFormat = btn.dataset.format || 'ALL';
        applyFilters();
      });
    });

    // 快捷按钮
    dom.btnSelectAll.addEventListener('click', selectAllVisible);
    dom.btnInvertSelect.addEventListener('click', invertSelection);
    dom.btnSelectLarge.addEventListener('click', selectLargeImagesOnly);
    dom.btnClearSelect.addEventListener('click', clearSelection);

    // 核心下载
    dom.btnDownloadZip.addEventListener('click', startBatchDownload);

    // 深度穿透 (Deep Grab)
    if (dom.btnDeepGrab) {
      dom.btnDeepGrab.addEventListener('click', startDeepGrab);
    }
    if (dom.btnCancelDeepGrab) {
      dom.btnCancelDeepGrab.addEventListener('click', () => {
        state.deepGrabCancelRequested = true;
        if (dom.deepGrabPhaseText) dom.deepGrabPhaseText.textContent = '正在中止穿透...';
      });
    }

    // 取消下载
    dom.btnCancelDownload.addEventListener('click', () => {
      state.cancelRequested = true;
      dom.consolePhaseText.textContent = '正在取消下载...';
    });

    // 错误抽屉折叠
    dom.btnToggleErrorDrawer.addEventListener('click', () => {
      const isHidden = dom.errorDetailsList.classList.toggle('hidden');
      dom.errorDrawerIcon.textContent = isHidden ? '▼' : '▲';
    });

    // 告警关闭
    dom.btnAlertClose.addEventListener('click', hideAlert);

    // Pro 模态框
    dom.btnProModal.addEventListener('click', () => showProModal(false));
    dom.btnCloseProModal.addEventListener('click', closeProModal);
    dom.btnActivateLicense.addEventListener('click', activateLicenseKey);
    dom.btnResetProTrial.addEventListener('click', resetProTrial);
    dom.inputLicenseKey.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') activateLicenseKey();
    });

    // 150MB 内存保护模态框
    dom.btnQuotaStopAndZip.addEventListener('click', () => resumeQuotaGuard(false));
    dom.btnQuotaContinue.addEventListener('click', () => resumeQuotaGuard(true));

    // Lightbox 大图预览
    dom.btnCloseLightbox.addEventListener('click', closeLightbox);
    dom.modalLightbox.addEventListener('click', (e) => {
      if (e.target === dom.modalLightbox) closeLightbox();
    });
    dom.btnCopyImageUrl.addEventListener('click', async () => {
      const url = dom.lightboxUrl.textContent;
      if (url) {
        await navigator.clipboard.writeText(url);
        dom.btnCopyImageUrl.textContent = '已复制!';
        setTimeout(() => { dom.btnCopyImageUrl.textContent = '复制图片地址'; }, 2000);
      }
    });
    dom.btnDownloadSingleImg.addEventListener('click', () => {
      const url = dom.lightboxUrl.textContent;
      if (url) downloadSingleImage(url);
    });

    // ESC 快捷键关闭弹窗 / 中止深度穿透
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (state.isDeepGrabbing) {
          state.deepGrabCancelRequested = true;
          if (dom.deepGrabPhaseText) dom.deepGrabPhaseText.textContent = '正在中止穿透...';
        }
        if (!dom.modalLightbox.classList.contains('hidden')) closeLightbox();
        if (!dom.modalPro.classList.contains('hidden')) closeProModal();
      }
    });
  }

  // 启动
  document.addEventListener('DOMContentLoaded', init);
})();
