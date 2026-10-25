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
    cancelRequested: false,       // 用户主动点击“取消下载”标记
    stopAndZipRequested: false,   // 触发150MB保护后用户选择“停止后续下载，仅打包已完成图片”标记
    downloadMap: new Map(),       // url -> { status: 'idle'|'downloading'|'success'|'failed', error?: string, blob?: Blob, size?: number, filename?: string }
    totalDownloadedBytes: 0,
    quotaWarned: false,           // 是否已触发过 150MB 保护警告
    quotaPauseResolver: null,     // 暂停等待用户决策的 Promise resolver
    activeWorkersCount: 0
  };

  const MAX_CONCURRENCY = 3;
  const QUOTA_LIMIT_BYTES = 150 * 1024 * 1024; // 150MB 下载数据量保护阈值

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

    // 穿透进度面板（入口停用）
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
      if (mime.includes('avif')) return 'avif';
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

  /**
   * 严格检验下载内容是否为真实图片（防止伪装为图片的 HTML 错误页/JSON 错误响应等）
   * 兼容 JPG, PNG, WebP, GIF, SVG, AVIF, BMP, ICO
   * 仅通过头部魔数（Magic Bytes）或轻量文本探测，不执行高开销的完整解码
   */
  async function detectAndValidateImageFormat(blob) {
    if (!blob || blob.size < 4) {
      return { isValid: false, error: '获取到的图片数据过小或为空' };
    }

    const mime = (blob.type || '').toLowerCase();

    // 1. 读取前 64 字节检查二进制图片魔数 (Magic Bytes)
    try {
      const slice = blob.slice(0, 64);
      const buffer = await slice.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // JPEG: FF D8 FF
      if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { isValid: true, ext: 'jpg', mime: 'image/jpeg' };
      }

      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes.length >= 8 &&
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
          bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return { isValid: true, ext: 'png', mime: 'image/png' };
      }

      // GIF: 'GIF87a' 或 'GIF89a'
      if (bytes.length >= 6 &&
          bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
          bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
        return { isValid: true, ext: 'gif', mime: 'image/gif' };
      }

      // WebP: 'RIFF' .... 'WEBP'
      if (bytes.length >= 12 &&
          bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { isValid: true, ext: 'webp', mime: 'image/webp' };
      }

      // AVIF: 检查 ISO BMFF 'ftyp' 与 brand 'avif' / 'avis' / 'mif1'
      if (bytes.length >= 12 &&
          bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
        if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
          return { isValid: true, ext: 'avif', mime: 'image/avif' };
        }
      }

      // BMP: 'BM'
      if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { isValid: true, ext: 'bmp', mime: 'image/bmp' };
      }

      // ICO: 00 00 01 00
      if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
        return { isValid: true, ext: 'ico', mime: 'image/x-icon' };
      }
    } catch {
      // 继续尝试文本探测
    }

    // 2. 文本类图片 (如 SVG) 及 HTML/JSON 伪装探测（读取前 512 字节）
    try {
      const textSlice = blob.slice(0, 512);
      const textBuffer = await textSlice.arrayBuffer();
      const text = new TextDecoder('utf-8').decode(textBuffer).trim().toLowerCase();

      // 明确拦截：HTML 错误页（如 404/500/Cloudflare 拦截）或 JSON 接口响应
      if (text.startsWith('<!doctype html') ||
          text.startsWith('<html') ||
          text.includes('<head>') ||
          text.includes('<body>') ||
          text.startsWith('{"') ||
          text.startsWith('{\n') ||
          text.startsWith('[{')) {
        return { isValid: false, error: '目标地址返回了 HTML 错误页或 JSON 数据，非有效图片' };
      }

      // 验证 SVG 矢量图
      if (text.includes('<svg') && (text.includes('xmlns') || text.includes('viewbox') || text.includes('<path') || text.includes('<g') || text.includes('<circle') || text.includes('<rect') || text.startsWith('<svg'))) {
        return { isValid: true, ext: 'svg', mime: 'image/svg+xml' };
      }
    } catch {
      // 忽略
    }

    // 3. 兜底检查：若 mime 明确为 image/* 且未命中 html/json
    if (mime.startsWith('image/')) {
      const sub = mime.substring(6).split('+')[0];
      if (['jpeg', 'jpg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp', 'x-icon', 'vnd.microsoft.icon'].includes(sub)) {
        const cleanExt = (sub === 'jpeg' || sub === 'jpg') ? 'jpg' : (sub.includes('icon') ? 'ico' : sub);
        return { isValid: true, ext: cleanExt, mime: mime };
      }
    }

    return { isValid: false, error: '文件内容非受支持的有效图片格式 (Magic Bytes 校验未通过)' };
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

      // 修复 1：采用完整、有效的图片 URL 判断重复，绝不删除 ? 后的查询参数，确保不同 id/sign/token 的图片不被合并
      const dedupeMap = new Map();
      task.images.forEach(img => {
        if (!img || !img.url) return;
        const rawUrl = img.url.trim();
        if (!rawUrl) return;

        // 统一在画廊层执行白名单 CDN 高清增强，并严格保留 originalUrl 与 fallbackUrl
        const originalUrl = img.originalUrl || rawUrl;
        const fallbackUrl = img.fallbackUrl || null;
        const enhancedUrl = enhanceToHighResUrl(originalUrl);

        // 去重主键以完整的原始 URL 规范化标识（杜绝截断 query 导致不同图片被合并）
        const dedupeKey = rawUrl;
        const currentScore = Math.max(img.width || 0, img.height || 0);

        if (dedupeMap.has(dedupeKey)) {
          const existing = dedupeMap.get(dedupeKey);
          const existingScore = Math.max(existing.width || 0, existing.height || 0);
          if (currentScore > existingScore) {
            existing.width = Math.max(existing.width || 0, img.width || 0);
            existing.height = Math.max(existing.height || 0, img.height || 0);
          }
          if (!existing.alt && img.alt) existing.alt = img.alt;
          if (!existing.fallbackUrl && fallbackUrl) existing.fallbackUrl = fallbackUrl;
          if (!existing.originalUrl && originalUrl) existing.originalUrl = originalUrl;
          if (!existing.detailUrl && img.detailUrl) {
            existing.detailUrl = img.detailUrl;
            existing.hasDetailLink = true;
          }
        } else {
          dedupeMap.set(dedupeKey, {
            ...img,
            url: enhancedUrl, // 优先尝试超清增强地址
            originalUrl: originalUrl, // 保留原始未增强地址用于下载失败自动回退
            fallbackUrl: fallbackUrl, // 保留 DOM 级主图降级地址
            detailUrl: img.detailUrl || null,
            hasDetailLink: !!img.detailUrl
          });
        }
      });

      state.allImages = Array.from(dedupeMap.values());

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
  // 原图穿透 (Deep Grab) 辅助（本轮停用入口与穿透请求，保留结构兼容）
  // -------------------------------------------------------------
  function renderDeepGrabBadge(img) {
    // 本轮按要求暂时停用 Deep Grab 视觉标签展示
    return '';
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
          <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || 'image')}" loading="lazy" ${img.originalUrl && img.originalUrl !== img.url ? `onerror="if(this.dataset.fallback && this.src !== this.dataset.fallback){this.src=this.dataset.fallback;}" data-fallback="${escapeHtml(img.originalUrl)}"` : ''} />
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
  // 7. 并发控制下载池 (Max 3 Concurrency) 与 150MB 数据保护阈值
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
    state.stopAndZipRequested = false;
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

    updateConsoleProgress(0, totalCount, '正在初始化下载连接...', `并发限制: ${MAX_CONCURRENCY} | 数据量保护阈值: 150MB`);

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
          if (state.cancelRequested || state.stopAndZipRequested) break;

          const myIndex = currentIndex++;
          const url = targetUrls[myIndex];

          // 检查并等待 150MB 保护锁
          if (state.quotaPauseResolver) {
            await state.quotaPauseResolver.promise;
          }
          if (state.cancelRequested || state.stopAndZipRequested) break;

          state.downloadMap.set(url, { status: 'downloading' });
          updateCardStatusUI(url, 'downloading');

          updateConsoleProgress(
            completedCount,
            totalCount,
            `正在并发下载 (${completedCount + 1}/${totalCount})...`,
            `已下载数据: ${formatBytes(state.totalDownloadedBytes)}`
          );

          // 执行下载（含高清->原图自动回退与真实图片格式校验）
          const imgItem = state.allImages.find(img => img.url === url) || { url };
          const fetchResult = await fetchImageWithFallback(imgItem);

          if (fetchResult.success) {
            const blob = fetchResult.blob;
            state.totalDownloadedBytes += blob.size;

            state.downloadMap.set(url, {
              status: 'success',
              blob: blob,
              size: blob.size,
              filename: generateFileName(url, myIndex + 1, fetchResult.mime, fetchResult.ext)
            });
            updateCardStatusUI(url, 'success', blob.size);

            // 检查 150MB 数据保护阈值
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

      // 操作 C：用户主动点击“取消下载”
      if (state.cancelRequested) {
        dom.consolePhaseText.textContent = '下载任务已由用户主动取消';
        dom.consoleDetailText.textContent = '已中止全部操作，未生成任何压缩包';
        dom.progressBarFill.style.width = '0%';
        finishDownloadSession();
        return;
      }

      // 操作 B：达到 150MB 保护后选择“停止并打包”时，标记未启动的图片为跳过
      if (state.stopAndZipRequested) {
        targetUrls.forEach(url => {
          const item = state.downloadMap.get(url);
          if (!item || item.status === 'pending') {
            state.downloadMap.set(url, {
              status: 'failed',
              error: '已达 150MB 数据保护上限，已停止下载后续图片'
            });
            updateCardStatusUI(url, 'failed', 0, '保护阈值跳过');
            failedList.push({ url, error: '已达 150MB 数据保护上限，已停止下载后续图片' });
          }
        });
      }

      // 汇总成功的 Blob
      const successfulItems = [];
      state.downloadMap.forEach((val) => {
        if (val.status === 'success' && val.blob) {
          successfulItems.push(val);
        }
      });

      const uncompletedCount = totalCount - successfulItems.length;

      // 若未成功获取到任何有效图片
      if (successfulItems.length === 0) {
        dom.consolePhaseText.textContent = '未能成功下载任何图片，无法生成压缩包';
        dom.progressBarFill.style.width = '100%';
        if (failedList.length > 0) {
          showFailedDrawer(failedList);
        }
        showAlert('选中的所有图片均未能获取（可能受限于跨域 CORS 或防盗链），无法生成压缩包。');
        finishDownloadSession();
        return;
      }

      // 区分三种操作的状态反馈
      if (state.stopAndZipRequested) {
        // 操作 B：达到限制后选择“停止并打包”
        dom.consolePhaseText.textContent = `保护限制停止：正在打包已完成的 ${successfulItems.length} 张图片 (未完成 ${uncompletedCount} 张)...`;
        dom.consoleDetailText.textContent = `已下载数据量: ${formatBytes(state.totalDownloadedBytes)} (阈值 150MB)`;
      } else {
        // 操作 A：正常下载完成
        dom.consolePhaseText.textContent = `正在生成 ZIP 压缩包 (成功 ${successfulItems.length} 张${uncompletedCount > 0 ? `，失败 ${uncompletedCount} 张` : ''})...`;
        dom.consoleDetailText.textContent = `总包体积预估: ${formatBytes(state.totalDownloadedBytes)}`;
      }

      // 渲染错误/跳过报告抽屉 (若有失败或未完成项)
      if (failedList.length > 0) {
        showFailedDrawer(failedList);
      }

      // 阶段 2：执行本地 JSZip 打包
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

      // 阶段 3：调起原生保存
      dom.progressBarFill.style.width = '100%';
      dom.consolePhaseText.textContent = state.stopAndZipRequested
        ? `打包完成！已保存 ${successfulItems.length} 张已完成图片 (未完成 ${uncompletedCount} 张)`
        : `打包完成！已保存全部 ${successfulItems.length} 张图片`;
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

  // 单个 URL 请求与格式验证（Fix 3：防止伪装为图片的 HTML 错误页/JSON 错误响应）
  async function fetchSingleUrlAndValidate(url) {
    if (!url) return { success: false, error: '无效的图片地址' };

    // 1. 如果是 data URL
    if (url.startsWith('data:')) {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        if (!blob || blob.size === 0) {
          return { success: false, error: 'Data URL 内容为空' };
        }
        const validation = await detectAndValidateImageFormat(blob);
        if (!validation.isValid) {
          return { success: false, error: validation.error || 'Data URL 非有效图片格式' };
        }
        return { success: true, blob, ext: validation.ext, mime: validation.mime };
      } catch (err) {
        return { success: false, error: 'Data URL 解析失败: ' + err.message };
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

      const ct = (response.headers.get('content-type') || '').toLowerCase();
      // 快速拦截明确标记为 HTML 或 JSON 的响应
      if (ct.includes('text/html') || ct.includes('application/json')) {
        throw new Error(`响应 Content-Type 为 ${ct}，非有效图片数据`);
      }

      const blob = await response.blob();
      if (!blob || blob.size === 0) {
        throw new Error('获取到的图片内容为空 (0 bytes)');
      }

      // 二进制/文本格式验证 (Magic Bytes 检查)
      const validation = await detectAndValidateImageFormat(blob);
      if (!validation.isValid) {
        throw new Error(validation.error || '文件内容未通过图片格式校验');
      }

      return {
        success: true,
        blob: blob,
        ext: validation.ext,
        mime: validation.mime
      };

    } catch (fetchErr) {
      // 3. 降级尝试：利用 Image 标签 + Canvas 转 Blob（应对部分允许绘制但不响应 fetch 的场景）
      try {
        const canvasBlob = await fetchViaCanvasFallback(url);
        const validation = await detectAndValidateImageFormat(canvasBlob);
        if (!validation.isValid) {
          throw new Error('Canvas 导出的数据格式校验失败');
        }
        return {
          success: true,
          blob: canvasBlob,
          ext: validation.ext || 'png',
          mime: validation.mime || 'image/png'
        };
      } catch {
        return {
          success: false,
          error: fetchErr.message || '跨域限制 (CORS) 或服务端防盗链拦截'
        };
      }
    }
  }

  // 图片多级下载与回退调度器（Fix 2 高清下载失败自动回退原始地址）
  async function fetchImageWithFallback(itemOrUrl) {
    let primaryUrl = '';
    let originalUrl = null;
    let fallbackUrl = null;

    if (typeof itemOrUrl === 'string') {
      primaryUrl = itemOrUrl;
      const matched = state.allImages.find(img => img.url === itemOrUrl);
      if (matched) {
        originalUrl = matched.originalUrl;
        fallbackUrl = matched.fallbackUrl;
      }
    } else if (itemOrUrl && typeof itemOrUrl === 'object') {
      primaryUrl = itemOrUrl.url;
      originalUrl = itemOrUrl.originalUrl;
      fallbackUrl = itemOrUrl.fallbackUrl;
    }

    // 构建按优先级尝试的候选 URL 列表：[高清增强地址, 原始可下载地址, DOM级原图降级地址]
    const candidates = [primaryUrl];
    if (originalUrl && originalUrl !== primaryUrl && !candidates.includes(originalUrl)) {
      candidates.push(originalUrl);
    }
    if (fallbackUrl && fallbackUrl !== primaryUrl && !candidates.includes(fallbackUrl)) {
      candidates.push(fallbackUrl);
    }

    let lastError = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidateUrl = candidates[i];
      const isFallback = (i > 0);

      const result = await fetchSingleUrlAndValidate(candidateUrl);
      if (result.success) {
        if (isFallback) {
          console.info(`[Gallery] 原始地址回退成功: ${candidateUrl}`);
        }
        return {
          ...result,
          usedUrl: candidateUrl,
          isFallback: isFallback
        };
      } else {
        lastError = result.error;
        if (!isFallback && candidates.length > 1) {
          console.warn(`[Gallery] 高清地址下载或校验失败 (${lastError})，自动回退原始地址: ${candidates[i + 1]}`);
        }
      }
    }

    return {
      success: false,
      error: lastError || '下载失败且无可用回退地址'
    };
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

  // 生成打包文件名（Fix 3：ZIP 中的扩展名与实际检测到的图片格式一致）
  function generateFileName(url, index, mimeType, detectedExt) {
    const padIndex = String(index).padStart(3, '0');
    let ext = detectedExt;

    if (!ext) {
      if (mimeType) {
        if (mimeType.includes('png')) ext = 'png';
        else if (mimeType.includes('webp')) ext = 'webp';
        else if (mimeType.includes('svg')) ext = 'svg';
        else if (mimeType.includes('gif')) ext = 'gif';
        else if (mimeType.includes('avif')) ext = 'avif';
        else if (mimeType.includes('jpeg') || mimeType.includes('jpg')) ext = 'jpg';
        else ext = getUrlExtension(url);
      } else {
        ext = getUrlExtension(url);
      }
    }

    return `image_${padIndex}.${ext}`;
  }

  // 150MB 数据保护阈值暂停
  function pauseForQuotaGuard() {
    let resolver;
    const promise = new Promise(resolve => {
      resolver = resolve;
    });
    state.quotaPauseResolver = { promise, resolve: resolver };

    dom.currentDownloadedSizeText.textContent = formatBytes(state.totalDownloadedBytes);
    dom.modalQuotaGuard.classList.remove('hidden');
  }

  // 恢复/决策保护行为（Fix 4：明确区分停止并打包与取消下载）
  function resumeQuotaGuard(continueDownload) {
    dom.modalQuotaGuard.classList.add('hidden');
    if (!continueDownload) {
      // 停止后续下载，仅打包已完成图片（设置 stopAndZipRequested，绝不能设置 cancelRequested）
      state.stopAndZipRequested = true;
      dom.consolePhaseText.textContent = '已触发数据保护上限，正在停止后续下载并准备打包...';
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
      const item = state.allImages.find(img => img.url === url);
      const fallbackUrl = (item && item.originalUrl !== url) ? item.originalUrl : null;
      const ext = getUrlExtension(url);
      const filename = `single_image_${Date.now()}.${ext}`;

      if (chrome && chrome.downloads && typeof chrome.downloads.download === 'function') {
        chrome.downloads.download({
          url: url,
          filename: filename,
          saveAs: true
        }, () => {
          if (chrome.runtime.lastError) {
            if (fallbackUrl) {
              chrome.downloads.download({
                url: fallbackUrl,
                filename: filename,
                saveAs: true
              }, () => {
                if (chrome.runtime.lastError) {
                  fallbackAnchorDownload(fallbackUrl, filename);
                }
              });
            } else {
              fallbackAnchorDownload(url, filename);
            }
          }
        });
      } else {
        fallbackAnchorDownload(url, filename);
      }
    } catch {
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

    // 取消下载
    dom.btnCancelDownload.addEventListener('click', () => {
      state.cancelRequested = true;
      if (state.quotaPauseResolver) {
        state.quotaPauseResolver.resolve();
        state.quotaPauseResolver = null;
      }
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

    // 150MB 数据保护模态框
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

    // ESC 快捷键关闭弹窗
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dom.modalLightbox.classList.contains('hidden')) closeLightbox();
        if (!dom.modalPro.classList.contains('hidden')) closeProModal();
      }
    });
  }

  // 启动
  document.addEventListener('DOMContentLoaded', init);
})();
