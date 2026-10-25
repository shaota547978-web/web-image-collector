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
    allImages: [],           // 嗅探到的所有图片列表 [{ id, url, originalUrl, fallbackUrl, width, height, alt, source, detailUrl, hasDetailLink, deepGrabStatus }]
    filteredImages: [],      // 当前符合滑块与格式条件的图片列表
    selectedIds: new Set(),  // 当前已勾选的图片 ID (统一身份管理，杜绝与下载 URL 混用)
    isPro: false,            // 是否激活 Pro License
    proLimit: 20,            // 免费版单次最大允许勾选数量
    minWidth: 200,           // 默认最小过滤门槛 200px
    minHeight: 200,          // 默认最小过滤门槛 200px
    currentFormat: 'ALL',

    // 深度穿透 (Deep Grab) 运行时状态
    isDeepGrabbing: false,
    deepGrabCancelRequested: false,

    // 下载运行时状态
    isDownloading: false,
    isCompressing: false,         // 是否正在进行 JSZip 压缩打包 (此阶段禁用取消)
    cancelRequested: false,       // 用户主动点击“取消下载”标记
    stopAndZipRequested: false,   // 触发150MB保护后用户选择“停止后续下载，仅打包已完成图片”标记
    abortController: null,        // 用于及时中止正在进行的网络请求
    currentBatchTaskId: 0,        // 当前批次任务自增 ID，用于隔离跨批次异步状态覆盖
    activeSaveTask: null,         // 当前正在等待落盘的保存任务引用 { taskId, cleanup }
    downloadMap: new Map(),       // id -> { status: 'idle'|'pending'|'downloading'|'success'|'failed', error?: string, blob?: Blob, size?: number, filename?: string }
    totalDownloadedBytes: 0,
    quotaWarned: false,           // 是否已触发过 150MB 保护警告
    quotaPauseResolver: null,     // 暂停等待用户决策的 Promise resolver
    activeWorkersCount: 0,

    // 来源网页与手动刷新状态
    sourceTabId: null,
    pageUrl: '',
    taskCollectedAt: null,
    isRefreshing: false,

    // 任务隔离与状态机
    taskId: null,
    taskStatus: 'loading',        // 'loading' | 'success' | 'error'
    loadingTimeoutTimer: null
  };

  const MAX_CONCURRENCY = 3;
  const MAX_DEEP_CONCURRENCY = 2; // 穿透详情页严格限制为 2 并发，防止请求过频触发风控
  const QUOTA_LIMIT_BYTES = 150 * 1024 * 1024; // 150MB 下载数据量保护阈值

  // 统一功能开关：深度穿透当前处于暂停关闭状态，MVP 阶段专注于核心下载链路稳定可靠
  const DEEP_GRAB_ENABLED = false;

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

    // 刷新图片按钮与提示角标
    btnRefreshImages: document.getElementById('btnRefreshImages'),
    refreshImagesText: document.getElementById('refreshImagesText'),
    collectCountBadge: document.getElementById('collectCountBadge'),

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

    // 采集加载中状态与失败重试
    loadingState: document.getElementById('loadingState'),
    loadingStateTitle: document.getElementById('loadingStateTitle'),
    loadingStateSubtext: document.getElementById('loadingStateSubtext'),
    loadingProgressCounter: document.getElementById('loadingProgressCounter'),

    errorState: document.getElementById('errorState'),
    errorStateTitle: document.getElementById('errorStateTitle'),
    errorStateSubtitle: document.getElementById('errorStateSubtitle'),
    btnRetryCollect: document.getElementById('btnRetryCollect'),

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
    btnQuotaCancelAll: document.getElementById('btnQuotaCancelAll'),

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
   * 严格检验下载内容是否为真实有效图片（真实文件特征校验）
   * 必须通过文件头特征（Magic Bytes）或 SVG 规范验证。
   * MIME 声明绝不能单独证明图片内容有效；无法可靠识别的格式直接拒绝，不把伪图片写入 ZIP。
   * 兼容支持：JPG, PNG, WebP, GIF, AVIF, SVG, BMP, ICO。
   */
  async function detectAndValidateImageFormat(blob) {
    if (!blob || blob.size < 4) {
      return { isValid: false, error: '获取到的图片数据过小或为空 (小于 4 字节)' };
    }

    // 1. 读取前 64 字节检查二进制图片魔数 (Magic Bytes)
    try {
      const slice = blob.slice(0, 64);
      const buffer = await slice.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // A. JPEG: FF D8 FF
      if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { isValid: true, ext: 'jpg', mime: 'image/jpeg' };
      }

      // B. PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes.length >= 8 &&
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
          bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
        return { isValid: true, ext: 'png', mime: 'image/png' };
      }

      // C. GIF: 'GIF87a' 或 'GIF89a'
      if (bytes.length >= 6 &&
          bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
          bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
        return { isValid: true, ext: 'gif', mime: 'image/gif' };
      }

      // D. WebP: 0..3 为 'RIFF', 8..11 为 'WEBP'
      if (bytes.length >= 12 &&
          bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return { isValid: true, ext: 'webp', mime: 'image/webp' };
      }

      // E. AVIF: 4..7 为 'ftyp'，且 major brand 或 compatible brands 必须明确包含 'avif' 或 'avis'
      // 严禁将一般的 'mif1' 或 'heic' 盲目当作 AVIF 识别
      if (bytes.length >= 12 &&
          bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
        const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
        let isAvif = (majorBrand === 'avif' || majorBrand === 'avis');

        if (!isAvif && bytes.length >= 20) {
          for (let offset = 16; offset + 4 <= bytes.length; offset += 4) {
            const compBrand = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]).toLowerCase();
            if (compBrand === 'avif' || compBrand === 'avis') {
              isAvif = true;
              break;
            }
          }
        }

        if (isAvif) {
          return { isValid: true, ext: 'avif', mime: 'image/avif' };
        }
      }

      // F. BMP: 'BM'
      if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
        return { isValid: true, ext: 'bmp', mime: 'image/bmp' };
      }

      // G. ICO: 00 00 01 00
      if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
        return { isValid: true, ext: 'ico', mime: 'image/x-icon' };
      }
    } catch {
      // 忽略读取异常，继续尝试文本探测
    }

    // 2. 文本类图片 (如 SVG) 及明确的 HTML/JSON 伪装探测（读取前 512 字节）
    try {
      const textSlice = blob.slice(0, 512);
      const textBuffer = await textSlice.arrayBuffer();
      const text = new TextDecoder('utf-8').decode(textBuffer).trim().toLowerCase();

      // 明确拦截：HTML 错误页（如 404/500/Cloudflare 拦截等）或 JSON 接口响应
      if (text.startsWith('<!doctype html') ||
          text.startsWith('<html') ||
          text.includes('<head>') ||
          text.includes('<body>') ||
          text.startsWith('{"') ||
          text.startsWith('{\n') ||
          text.startsWith('[{')) {
        return { isValid: false, error: '目标地址返回了 HTML 错误页或 JSON 数据，非有效图片' };
      }

      // 验证是否符合 SVG 矢量图规范
      if (text.includes('<svg') && (text.includes('xmlns') || text.includes('viewbox') || text.includes('<path') || text.includes('<g') || text.includes('<circle') || text.includes('<rect') || text.startsWith('<svg'))) {
        return { isValid: true, ext: 'svg', mime: 'image/svg+xml' };
      }
    } catch {
      // 忽略
    }

    // 严禁根据 MIME 声明放行未通过文件特征校验的数据
    return { isValid: false, error: '文件内容非受支持的有效图片格式 (Magic Bytes 文件头校验未通过)' };
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
    bindTaskMessageListener();

    // 检查 Pro 授权状态
    await loadProStatus();

    // 读取嗅探任务数据
    await loadCollectorTaskData();
  }

  function clearLoadingTimeout() {
    if (state.loadingTimeoutTimer) {
      clearTimeout(state.loadingTimeoutTimer);
      state.loadingTimeoutTimer = null;
    }
  }

  function showLoadingState(message, count) {
    state.taskStatus = 'loading';
    clearLoadingTimeout();

    if (dom.loadingState) {
      dom.loadingState.classList.remove('hidden');
    }
    if (dom.errorState) {
      dom.errorState.classList.add('hidden');
    }
    if (dom.emptyState) {
      dom.emptyState.classList.add('hidden');
    }
    if (dom.galleryGrid) {
      dom.galleryGrid.classList.add('hidden');
    }

    if (dom.loadingStateTitle && message) {
      dom.loadingStateTitle.textContent = message;
    }

    if (count != null && count > 0 && dom.loadingProgressCounter) {
      dom.loadingProgressCounter.textContent = `已识别 ${count} 张`;
      dom.loadingProgressCounter.classList.remove('hidden');
    } else if (dom.loadingProgressCounter) {
      dom.loadingProgressCounter.classList.add('hidden');
    }

    // 防假死安全超时：30秒后若仍处于 loading，切换为 error 状态
    state.loadingTimeoutTimer = setTimeout(() => {
      if (state.taskStatus === 'loading') {
        showErrorState('采集等待超时。目标页面图片较多或网络连接较慢，请点击下方按钮重试。');
      }
    }, 30000);
  }

  function showErrorState(errorMessage) {
    state.taskStatus = 'error';
    clearLoadingTimeout();

    if (dom.loadingState) {
      dom.loadingState.classList.add('hidden');
    }
    if (dom.galleryGrid) {
      dom.galleryGrid.classList.add('hidden');
    }
    if (dom.emptyState) {
      dom.emptyState.classList.add('hidden');
    }
    if (dom.errorState) {
      dom.errorState.classList.remove('hidden');
    }
    if (dom.errorStateSubtitle) {
      dom.errorStateSubtitle.textContent = errorMessage || '未能从源网页获取图片，请检查网页是否已关闭或刷新重试。';
    }
    if (dom.btnRetryCollect) {
      dom.btnRetryCollect.disabled = false;
      dom.btnRetryCollect.textContent = '重试采集';
    }
  }

  function showSuccessState() {
    state.taskStatus = 'success';
    clearLoadingTimeout();

    if (dom.loadingState) {
      dom.loadingState.classList.add('hidden');
    }
    if (dom.errorState) {
      dom.errorState.classList.add('hidden');
    }

    if (state.allImages.length === 0) {
      renderEmptyState('未发现图片');
    } else {
      if (dom.galleryGrid) {
        dom.galleryGrid.classList.remove('hidden');
      }
      renderGallery();
    }
  }

  // 监听后台任务状态广播与实时嗅探进度通知
  function bindTaskMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return;

      // 任务隔离校验：若当前画廊已绑定 taskId，且收到的消息带有 taskId，两者必须匹配！杜绝串台！
      if (state.taskId && message.taskId && message.taskId !== state.taskId) {
        return;
      }

      if (message.action === 'COLLECTOR_TASK_UPDATED') {
        if (message.status === 'loading') {
          showLoadingState('正在采集网页图片…');
        } else if (message.status === 'success') {
          if (message.task) {
            processTaskImages(message.task);
          } else if (state.taskId) {
            chrome.storage.local.get([`collectorTask_${state.taskId}`]).then(res => {
              if (res && res[`collectorTask_${state.taskId}`]) {
                processTaskImages(res[`collectorTask_${state.taskId}`]);
              }
            });
          }
        } else if (message.status === 'error') {
          showErrorState(message.error || '采集失败，请重试');
        }
      } else if (message.action === 'SNIFF_PROGRESS') {
        if (state.taskStatus === 'loading' && typeof message.count === 'number') {
          if (dom.loadingProgressCounter) {
            dom.loadingProgressCounter.textContent = `已识别 ${message.count} 张`;
            dom.loadingProgressCounter.classList.remove('hidden');
          }
        }
      }
    });
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
      // 1. 从 URL 查询参数获取绑定 taskId，或从 latestTaskId 兜底
      const urlParams = new URLSearchParams(window.location.search);
      let taskId = urlParams.get('taskId');
      if (!taskId) {
        const latestRes = await chrome.storage.local.get(['latestTaskId']);
        if (latestRes && latestRes.latestTaskId) {
          taskId = latestRes.latestTaskId;
        }
      }
      state.taskId = taskId;

      // 2. 根据 taskId 读取隔离的任务数据，或者向下兼容 currentCollectorTask
      let task = null;
      if (taskId) {
        const storageKey = `collectorTask_${taskId}`;
        const res = await chrome.storage.local.get([storageKey]);
        task = res ? res[storageKey] : null;
      }
      if (!task) {
        const res = await chrome.storage.local.get(['currentCollectorTask']);
        task = res ? res.currentCollectorTask : null;
      }

      if (!task) {
        showErrorState('未检测到可用的采集任务。请在目标网页上点击扩展图标触发采集。');
        return;
      }

      // 设置来源信息
      dom.sourceTitle.textContent = task.pageTitle || '未知网页';
      dom.sourceTitle.title = task.pageTitle || '';
      if (task.pageUrl) {
        dom.sourceLink.href = task.pageUrl;
        state.pageUrl = task.pageUrl;
      }
      state.sourceTabId = task.sourceTabId || null;
      state.taskCollectedAt = task.createdAt || task.completedAt || null;

      // 3. 判断任务状态 (loading / error / success)
      if (task.status === 'loading') {
        showLoadingState('正在采集网页图片…');
        return;
      }

      if (task.status === 'error') {
        showErrorState(task.error || task.warning || '采集失败');
        return;
      }

      // 4. status === 'success' 或已有结果数据
      processTaskImages(task);

    } catch (err) {
      console.error('[Gallery] 读取存储数据失败:', err);
      showErrorState(`读取图片数据失败: ${err.message}`);
    }
  }

  function processTaskImages(task) {
    if (!task) return;

    if (task.pageTitle) {
      dom.sourceTitle.textContent = task.pageTitle;
      dom.sourceTitle.title = task.pageTitle;
    }
    if (task.pageUrl) {
      dom.sourceLink.href = task.pageUrl;
      state.pageUrl = task.pageUrl;
    }
    if (task.sourceTabId) {
      state.sourceTabId = task.sourceTabId;
    }
    if (task.createdAt || task.completedAt) {
      state.taskCollectedAt = task.completedAt || task.createdAt;
    }

    if (task.warning) {
      showAlert(task.warning);
    }

    const rawImages = Array.isArray(task.images) ? task.images : [];
    if (rawImages.length === 0) {
      state.allImages = [];
      state.filteredImages = [];
      state.selectedIds.clear();
      updateSelectionSummary();
      showSuccessState();
      return;
    }

    // 修复 1：采用完整、有效的图片 URL 判断重复，绝不删除 ? 后的查询参数，确保不同 id/sign/token 的图片不被合并
    const dedupeMap = new Map();
    rawImages.forEach(img => {
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

    // 统一图片身份管理：每张去重后的图片分配唯一全局 id (如 img_1, img_2...)
    // 保证画廊展示、多选集合、下载队列、卡片 UI 状态与错误报告一一对应，杜绝增强后 URL 相同导致的覆盖
    state.allImages = Array.from(dedupeMap.values()).map((item, idx) => ({
      ...item,
      id: `img_${idx + 1}`
    }));

    // 默认全选前 20 张（或全部若小于 20 张）
    applyFilters();
    preselectInitialImages();
    updateDeepGrabButtonBadge();
    showSuccessState();
  }

  function preselectInitialImages() {
    state.selectedIds.clear();
    const limit = state.isPro ? state.filteredImages.length : Math.min(state.proLimit, state.filteredImages.length);
    for (let i = 0; i < limit; i++) {
      state.selectedIds.add(state.filteredImages[i].id);
    }
    updateSelectionSummary();
    renderGallery();
  }

  // -------------------------------------------------------------
  // 原图穿透 (Deep Grab) 辅助与启发式解析算法
  // -------------------------------------------------------------
  function updateDeepGrabButtonBadge() {
    if (!dom.btnDeepGrab) return;
    if (!DEEP_GRAB_ENABLED) {
      dom.btnDeepGrab.classList.add('hidden');
      dom.btnDeepGrab.style.display = 'none';
      return;
    }
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
    if (!DEEP_GRAB_ENABLED) return '';
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
    if (!DEEP_GRAB_ENABLED) return;
    const card = cardEl || dom.galleryGrid.querySelector(`.image-card[data-id="${CSS.escape(item.id)}"]`);
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
        if (badge) thumb.appendChild(badge);
      }
    } else {
      badge.outerHTML = badgeHtml;
    }
  }

  function updateCardWithResolvedHero(item, oldUrl) {
    const card = dom.galleryGrid.querySelector(`.image-card[data-id="${CSS.escape(item.id)}"]`);
    if (!card) return;

    card.dataset.url = item.url;

    const imgEl = card.querySelector('.card-thumb-wrapper img');
    if (imgEl) {
      imgEl.src = item.url;
      delete imgEl.dataset.fallbackAttempted;
      const fallbackUrl = item.originalUrl || oldUrl;
      if (fallbackUrl && fallbackUrl !== item.url) {
        imgEl.addEventListener('error', function onHeroFallbackError() {
          if (this.dataset.fallbackAttempted === 'true') return;
          this.dataset.fallbackAttempted = 'true';
          this.src = fallbackUrl;
        }, { once: true });
      }
    }

    const resBadge = card.querySelector('.badge-res');
    if (resBadge) {
      const isLarge = (item.width >= 1000 || item.height >= 1000);
      resBadge.textContent = (item.width > 0 && item.height > 0) ? `${item.width} × ${item.height}` : '未知尺寸';
      if (isLarge) resBadge.classList.add('large-res');
    }

    const fmtBadge = card.querySelector('.badge-fmt');
    if (fmtBadge) {
      fmtBadge.textContent = detectImageFormat(item);
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

      // 优先级 B（下载直链）：检查页面中是否存在带有 download 属性的 <a>，或类名包含 download-btn、btn-download
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

      // 优先级 C（主画布启发式）：检索详情页中所有的 <img>，选取宽高最大或高画质特征图
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

          if (highResRegex.test(absSrc) || highResRegex.test(className) || highResRegex.test(id)) {
            score += 10000000;
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
    if (phaseText && dom.deepGrabPhaseText) dom.deepGrabPhaseText.textContent = phaseText;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    if (dom.deepGrabProgressFill) dom.deepGrabProgressFill.style.width = `${percent}%`;
  }

  /**
   * 启动受控并发穿透流程 (并发限制 2，微延迟 200ms)
   * 注：当前功能范围收口中已统一暂停，完整算法保留在此供后续阶段评估
   */
  async function startDeepGrab() {
    if (!DEEP_GRAB_ENABLED) {
      console.warn('[DeepGrab] 深度穿透功能当前处于暂停关闭状态');
      return;
    }
    if (state.isDeepGrabbing) return;

    const candidates = state.allImages.filter(img => img.hasDetailLink && img.detailUrl && img.deepGrabStatus !== 'success');
    if (candidates.length === 0) {
      showAlert('当前画廊没有检测到可穿透的详情页，或者全部图片已穿透完成！');
      return;
    }

    state.isDeepGrabbing = true;
    state.deepGrabCancelRequested = false;
    if (dom.btnDeepGrab) dom.btnDeepGrab.disabled = true;
    if (dom.deepGrabConsole) {
      dom.deepGrabConsole.classList.remove('hidden');
    }

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
    if (dom.btnDeepGrab) dom.btnDeepGrab.disabled = false;
    if (dom.deepGrabConsole) {
      dom.deepGrabConsole.classList.add('hidden');
    }
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
    const tRender0 = performance.now();
    dom.galleryGrid.innerHTML = '';

    if (state.filteredImages.length === 0) {
      dom.emptyState.classList.remove('hidden');
      return;
    }

    dom.emptyState.classList.add('hidden');

    const fragment = document.createDocumentFragment();

    state.filteredImages.forEach((img, idx) => {
      const card = document.createElement('div');
      const isSelected = state.selectedIds.has(img.id);
      const dlInfo = state.downloadMap.get(img.id);

      card.className = `image-card ${isSelected ? 'selected' : ''} ${dlInfo && dlInfo.status === 'failed' ? 'card-failed' : ''}`;
      card.dataset.id = img.id;
      card.dataset.url = img.url;

      const format = detectImageFormat(img);
      const isLarge = (img.width >= 1000 || img.height >= 1000);
      const resText = (img.width > 0 && img.height > 0) ? `${img.width} × ${img.height}` : '未知尺寸';

      // 遵守 MV3 CSP: 不在 innerHTML 中使用内联 onerror 事件属性
      card.innerHTML = `
        <div class="card-thumb-wrapper">
          <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || 'image')}" loading="lazy" />
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
          <button class="action-btn-circle btn-card-download" title="单张下载" data-id="${escapeHtml(img.id)}">
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

      // 修复 2：通过纯 JS 事件绑定实现高清预览失败时回退原始地址，杜绝内联 onerror 违反 CSP，防止无限回退
      const thumbImg = card.querySelector('.card-thumb-wrapper img');
      const fallbackCandidate = (img.originalUrl && img.originalUrl !== img.url)
        ? img.originalUrl
        : (img.fallbackUrl && img.fallbackUrl !== img.url ? img.fallbackUrl : null);

      if (thumbImg) {
        // 当图片在画廊卡片中成功渲染时，若原始尺寸未知，通过天然 naturalWidth/naturalHeight 动态更新真实尺寸
        thumbImg.addEventListener('load', function onThumbLoaded() {
          if ((!img.width || !img.height) && this.naturalWidth > 0 && this.naturalHeight > 0) {
            img.width = this.naturalWidth;
            img.height = this.naturalHeight;
            const resBadge = card.querySelector('.badge-res');
            if (resBadge) {
              resBadge.textContent = `${img.width} × ${img.height}`;
              if (img.width >= 1000 || img.height >= 1000) {
                resBadge.classList.add('large-res');
              }
            }
          }
        }, { once: true });

        if (fallbackCandidate) {
          thumbImg.addEventListener('error', function onThumbError() {
            if (this.dataset.fallbackAttempted === 'true') return;
            this.dataset.fallbackAttempted = 'true';
            this.src = fallbackCandidate;
          }, { once: true });
        }
      }

      // 深度穿透标签展示（若该图片有详情页支持穿透）
      const deepBadgeHtml = renderDeepGrabBadge(img);
      if (deepBadgeHtml) {
        const thumbWrapper = card.querySelector('.card-thumb-wrapper');
        if (thumbWrapper) {
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = deepBadgeHtml;
          if (tempDiv.firstElementChild) {
            thumbWrapper.appendChild(tempDiv.firstElementChild);
          }
        }
      }

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

      // 卡片点击事件：切换多选 (使用统一图片 ID)
      card.addEventListener('click', (e) => {
        // 如果点击的是放大镜或单张下载按钮，不触发卡片选中切换
        if (e.target.closest('.card-hover-actions')) return;
        toggleSelectImage(img.id, card);
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
        downloadSingleImage(img.id);
      });

      fragment.appendChild(card);
    });

    dom.galleryGrid.appendChild(fragment);
    const tRender1 = performance.now();
    console.log(`[Web Image Collector Perf] 画廊卡片渲染耗时: ${(tRender1 - tRender0).toFixed(1)}ms (渲染卡片数: ${state.filteredImages.length})`);
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
  // 5.5 原网页「刷新图片」单次嗅探与增量合并逻辑
  // -------------------------------------------------------------
  async function getSourceTab() {
    if (!state.sourceTabId) {
      return { tab: null, error: 'NO_SOURCE_TAB' };
    }
    try {
      const tab = await chrome.tabs.get(state.sourceTabId);
      if (!tab || !tab.id) {
        return { tab: null, error: 'TAB_CLOSED' };
      }
      // 检查原标签页是否已导航跳转到其他域名页面
      if (state.pageUrl && tab.url) {
        try {
          const origUrl = new URL(state.pageUrl);
          const currUrl = new URL(tab.url);
          if (origUrl.origin !== currUrl.origin) {
            return { tab: null, error: 'TAB_NAVIGATED' };
          }
        } catch {}
      }
      return { tab, error: null };
    } catch {
      // 标签页不存在或已被关闭
      return { tab: null, error: 'TAB_CLOSED' };
    }
  }

  async function refreshImages() {
    if (state.isRefreshing) return;

    state.isRefreshing = true;

    // 更新界面状态为刷新中并禁用按钮
    if (dom.btnRefreshImages) {
      dom.btnRefreshImages.classList.add('refreshing');
      dom.btnRefreshImages.disabled = true;
    }
    if (dom.refreshImagesText) {
      dom.refreshImagesText.textContent = '正在刷新...';
    }

    showAlert('正在检查来源网页的新图片...');

    try {
      const { tab: sourceTab, error: tabError } = await getSourceTab();
      if (!sourceTab) {
        if (tabError === 'TAB_NAVIGATED') {
          showAlert('来源网页已跳转到其他页面，无法继续采集原页面图片');
        } else {
          showAlert('来源网页已关闭，请重新打开网页进行采集');
        }
        return;
      }

      let response = null;
      try {
        response = await chrome.tabs.sendMessage(sourceTab.id, {
          action: 'SNIFF_IMAGES',
          taskId: state.taskId
        });
      } catch {
        // 通信未就绪时（例如页面手动重载过），动态注入 content.js 后重试一次
        try {
          await chrome.scripting.executeScript({
            target: { tabId: sourceTab.id },
            files: ['content.js']
          });
          response = await chrome.tabs.sendMessage(sourceTab.id, {
            action: 'SNIFF_IMAGES',
            taskId: state.taskId
          });
        } catch (injectErr) {
          console.warn('[Gallery] 注入 content.js 单次嗅探失败:', injectErr);
        }
      }

      if (response && response.success && Array.isArray(response.images)) {
        const addedCount = appendNewImages(response.images);
        if (addedCount > 0) {
          if (dom.collectCountBadge) {
            dom.collectCountBadge.textContent = `+${addedCount}`;
            dom.collectCountBadge.classList.remove('hidden');
            setTimeout(() => {
              if (dom.collectCountBadge) dom.collectCountBadge.classList.add('hidden');
            }, 4000);
          }
          showAlert(`本次新增 ${addedCount} 张，累计 ${state.allImages.length} 张`);
        } else {
          showAlert('没有发现新图片');
        }
      } else {
        showAlert('刷新失败，请重试');
      }
    } catch (err) {
      console.warn('[Gallery] 刷新图片发生异常:', err);
      showAlert('刷新失败，请重试');
    } finally {
      state.isRefreshing = false;
      if (dom.btnRefreshImages) {
        dom.btnRefreshImages.classList.remove('refreshing');
        dom.btnRefreshImages.disabled = false;
      }
      if (dom.refreshImagesText) {
        dom.refreshImagesText.textContent = '刷新图片';
      }
    }
  }

  function appendNewImages(newRawImages) {
    if (!Array.isArray(newRawImages) || newRawImages.length === 0) return 0;

    // 建立已有图片 dedupeKey 集合（严格按完整 URL 包括 query 去重，杜绝重复添加）
    const existingUrls = new Set();
    state.allImages.forEach(img => {
      if (img.originalUrl) existingUrls.add(img.originalUrl);
      if (img.url) existingUrls.add(img.url);
      if (img.fallbackUrl) existingUrls.add(img.fallbackUrl);
    });

    // 收集已有 ID，分配连续唯一的 img_N 标识
    const existingIds = new Set(state.allImages.map(img => img.id));
    let idCounter = state.allImages.length + 1;

    const addedItems = [];

    newRawImages.forEach(img => {
      if (!img || !img.url) return;
      const rawUrl = img.url.trim();
      if (!rawUrl) return;

      const originalUrl = img.originalUrl || rawUrl;
      const fallbackUrl = img.fallbackUrl || null;

      // 重复图片严格跳过
      if (existingUrls.has(originalUrl) || existingUrls.has(rawUrl)) {
        return;
      }

      existingUrls.add(originalUrl);
      existingUrls.add(rawUrl);

      const enhancedUrl = enhanceToHighResUrl(originalUrl);

      while (existingIds.has(`img_${idCounter}`)) {
        idCounter++;
      }
      const nextId = `img_${idCounter}`;
      existingIds.add(nextId);
      idCounter++;

      addedItems.push({
        ...img,
        id: nextId,
        url: enhancedUrl,
        originalUrl: originalUrl,
        fallbackUrl: fallbackUrl,
        width: img.width || 0,
        height: img.height || 0,
        detailUrl: img.detailUrl || null,
        hasDetailLink: !!img.detailUrl
      });
    });

    if (addedItems.length === 0) return 0;

    // 追加到全量数据列表（不清空旧图片）
    state.allImages.push(...addedItems);

    // 重新应用过滤（保持现有 minWidth, minHeight, currentFormat 与 selectedIds 不变）
    applyFilters();
    updateSelectionSummary();

    // 持久化到 storage.local 并校验绑定当前采集任务，避免污染其他画廊标签页
    try {
      const keys = state.taskId ? [`collectorTask_${state.taskId}`, 'currentCollectorTask'] : ['currentCollectorTask'];
      chrome.storage.local.get(keys).then(res => {
        const updates = {};
        if (state.taskId && res && res[`collectorTask_${state.taskId}`]) {
          const t = res[`collectorTask_${state.taskId}`];
          t.images = state.allImages;
          updates[`collectorTask_${state.taskId}`] = t;
        }
        if (res && res.currentCollectorTask) {
          const currentTask = res.currentCollectorTask;
          const isSameTask = (!state.taskId || currentTask.taskId === state.taskId) ||
            ((!state.taskCollectedAt || currentTask.collectedAt === state.taskCollectedAt)
            && (!state.pageUrl || currentTask.pageUrl === state.pageUrl));
          if (isSameTask) {
            currentTask.images = state.allImages;
            updates.currentCollectorTask = currentTask;
          }
        }
        if (Object.keys(updates).length > 0) {
          chrome.storage.local.set(updates);
        }
      }).catch(() => {});
    } catch {}

    return addedItems.length;
  }

  // -------------------------------------------------------------
  // 6. 选中与商业配额拦截逻辑 (Max 20 for Free, 统一基于 img.id 识别)
  // -------------------------------------------------------------
  function toggleSelectImage(id, cardEl) {
    const isCurrentlySelected = state.selectedIds.has(id);

    if (isCurrentlySelected) {
      state.selectedIds.delete(id);
      if (cardEl) cardEl.classList.remove('selected');
    } else {
      // 检查免费版 20 张配额上限
      if (!state.isPro && state.selectedIds.size >= state.proLimit) {
        showProModal(true, '免费版单次最多勾选 20 张图片，请升级 Pro 解锁无限批量导出！');
        return;
      }
      state.selectedIds.add(id);
      if (cardEl) cardEl.classList.add('selected');
    }

    updateSelectionSummary();
  }

  function updateSelectionSummary() {
    const selectedCount = state.selectedIds.size;
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
      state.selectedIds.clear();
      for (let i = 0; i < state.proLimit; i++) {
        state.selectedIds.add(state.filteredImages[i].id);
      }
      showProModal(true, `免费版已为您自动勾选前 ${state.proLimit} 张。升级 Pro 会员可一键全选所有图片！`);
    } else {
      state.filteredImages.forEach(img => state.selectedIds.add(img.id));
    }

    renderGallery();
    updateSelectionSummary();
  }

  function invertSelection() {
    const newSelected = new Set();
    const candidates = [];

    state.filteredImages.forEach(img => {
      if (!state.selectedIds.has(img.id)) {
        candidates.push(img.id);
      }
    });

    if (!state.isPro && candidates.length > state.proLimit) {
      candidates.slice(0, state.proLimit).forEach(id => newSelected.add(id));
      showProModal(true, `反选结果超过 ${state.proLimit} 张，免费版已为您选取前 ${state.proLimit} 张。`);
    } else {
      candidates.forEach(id => newSelected.add(id));
    }

    state.selectedIds = newSelected;
    renderGallery();
    updateSelectionSummary();
  }

  function selectLargeImagesOnly() {
    state.selectedIds.clear();
    const largeList = state.filteredImages.filter(img => img.width >= 800 || img.height >= 800);

    if (largeList.length === 0) {
      showAlert('当前筛选条件下未找到宽高 > 800px 的高清大图。');
      return;
    }

    if (!state.isPro && largeList.length > state.proLimit) {
      largeList.slice(0, state.proLimit).forEach(img => state.selectedIds.add(img.id));
      showProModal(true, `发现 ${largeList.length} 张高清大图。免费版已勾选前 ${state.proLimit} 张，升级 Pro 可一键导出全部！`);
    } else {
      largeList.forEach(img => state.selectedIds.add(img.id));
    }

    renderGallery();
    updateSelectionSummary();
  }

  function clearSelection() {
    state.selectedIds.clear();
    renderGallery();
    updateSelectionSummary();
  }

  // -------------------------------------------------------------
  // 7. 并发控制下载池 (Max 3 Concurrency) 与 150MB 数据保护阈值
  // -------------------------------------------------------------
  async function startBatchDownload() {
    if (state.selectedIds.size === 0 || state.isDownloading) return;

    // 严禁外部依赖未载入
    if (typeof JSZip === 'undefined') {
      showAlert('本地 JSZip 依赖库未就绪，请检查 libs/jszip.min.js 文件。');
      return;
    }

    // 清理此前残留的保存任务与监听器
    if (state.activeSaveTask && typeof state.activeSaveTask.cleanup === 'function') {
      state.activeSaveTask.cleanup();
      state.activeSaveTask = null;
    }

    const currentTaskId = ++state.currentBatchTaskId;

    state.isDownloading = true;
    state.isCompressing = false;
    state.cancelRequested = false;
    state.stopAndZipRequested = false;
    state.totalDownloadedBytes = 0;
    state.quotaWarned = false;
    state.abortController = new AbortController();
    state.downloadMap.clear();

    dom.btnDownloadZip.disabled = true;
    if (dom.btnCancelDownload) {
      dom.btnCancelDownload.disabled = false;
      dom.btnCancelDownload.title = '取消当前下载';
    }
    dom.bottomConsole.classList.remove('hidden');
    dom.errorSummaryBar.classList.add('hidden');
    dom.errorDetailsList.innerHTML = '';
    dom.errorBadgeCount.textContent = '0 张图片下载失败';

    const targetIds = Array.from(state.selectedIds);
    const totalCount = targetIds.length;

    updateConsoleProgress(0, totalCount, '正在初始化下载连接...', `并发限制: ${MAX_CONCURRENCY} | 数据量保护阈值: 150MB`);

    // 初始化每张卡片状态 (按统一图片 ID 映射)
    targetIds.forEach(id => {
      state.downloadMap.set(id, { status: 'pending' });
    });
    renderGallery();

    let completedCount = 0;
    let failedCount = 0;
    const failedList = [];

    // 并发池调度器
    async function runPool() {
      let currentIndex = 0;

      async function worker() {
        while (currentIndex < targetIds.length) {
          if (state.cancelRequested || state.stopAndZipRequested) break;

          const myIndex = currentIndex++;
          const id = targetIds[myIndex];

          // 检查并等待 150MB 保护锁
          if (state.quotaPauseResolver) {
            await state.quotaPauseResolver.promise;
          }
          if (state.cancelRequested || state.stopAndZipRequested) break;

          state.downloadMap.set(id, { status: 'downloading' });
          updateCardStatusUI(id, 'downloading');

          updateConsoleProgress(
            completedCount,
            totalCount,
            `正在并发下载 (${completedCount + 1}/${totalCount})...`,
            `已下载数据: ${formatBytes(state.totalDownloadedBytes)}`
          );

          // 执行下载（含高清->原图自动回退与真实图片格式校验，传入 signal 支持及时中止）
          const imgItem = state.allImages.find(img => img.id === id) || { id, url: '' };
          const fetchResult = await fetchImageWithFallback(imgItem, state.abortController ? state.abortController.signal : null);

          // 若在下载过程中用户点击了取消，立即退出
          if (state.cancelRequested) break;

          if (fetchResult.success) {
            const blob = fetchResult.blob;
            state.totalDownloadedBytes += blob.size;

            state.downloadMap.set(id, {
              status: 'success',
              blob: blob,
              size: blob.size,
              filename: generateFileName(imgItem.url || imgItem.originalUrl, myIndex + 1, fetchResult.mime, fetchResult.ext)
            });
            updateCardStatusUI(id, 'success', blob.size);

            // 检查 150MB 数据保护阈值
            if (!state.quotaWarned && state.totalDownloadedBytes >= QUOTA_LIMIT_BYTES) {
              state.quotaWarned = true;
              pauseForQuotaGuard();
            }

          } else {
            failedCount++;
            const reportUrl = imgItem ? (imgItem.originalUrl || imgItem.url) : id;
            failedList.push({ id, url: reportUrl, error: fetchResult.error });
            state.downloadMap.set(id, {
              status: 'failed',
              error: fetchResult.error
            });
            updateCardStatusUI(id, 'failed', 0, fetchResult.error);
          }

          completedCount++;
          const progressPercent = Math.round((completedCount / totalCount) * 80); // 80% 留给下载，20% 留给 ZIP 压缩
          dom.progressBarFill.style.width = `${progressPercent}%`;
          dom.consoleProgressCounter.textContent = `${completedCount} / ${totalCount}`;
        }
      }

      // 启动 MAX_CONCURRENCY 个 worker
      const pool = [];
      const concurrency = Math.min(MAX_CONCURRENCY, targetIds.length);
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
        dom.consoleDetailText.textContent = '已中止全部网络请求，未生成任何压缩包';
        dom.progressBarFill.style.width = '0%';
        finishDownloadSession();
        return;
      }

      // 操作 B：达到 150MB 保护后选择“停止并打包”时，标记未启动的图片为跳过
      if (state.stopAndZipRequested) {
        targetIds.forEach(id => {
          const item = state.downloadMap.get(id);
          if (!item || item.status === 'pending') {
            state.downloadMap.set(id, {
              status: 'failed',
              error: '已达 150MB 数据保护阈值，已停止下载后续图片'
            });
            updateCardStatusUI(id, 'failed', 0, '保护阈值跳过');
            const imgItem = state.allImages.find(img => img.id === id);
            const reportUrl = imgItem ? (imgItem.originalUrl || imgItem.url) : id;
            failedList.push({ id, url: reportUrl, error: '已达 150MB 数据保护阈值，已停止下载后续图片' });
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

      // 区分操作的状态反馈
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

      // 检查在进入压缩前是否被用户取消
      if (state.cancelRequested) {
        dom.consolePhaseText.textContent = '下载任务已由用户主动取消';
        dom.consoleDetailText.textContent = '已中止全部操作，未生成任何压缩包';
        finishDownloadSession();
        return;
      }

      // 阶段 2：执行本地 JSZip 打包（此阶段不可打断，明确禁用取消按钮并提示）
      state.isCompressing = true;
      if (dom.btnCancelDownload) {
        dom.btnCancelDownload.disabled = true;
        dom.btnCancelDownload.title = '压缩打包中无法取消';
      }

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

      // 阶段 3：调起原生保存（准确区分生成成功与实际落盘状态，杜绝提前宣称已保存，传递任务 ID 实现状态隔离）
      dom.progressBarFill.style.width = '100%';
      dom.consolePhaseText.textContent = state.stopAndZipRequested
        ? `ZIP 生成成功，正在请求保存 (已完成 ${successfulItems.length} 张，未完成 ${uncompletedCount} 张)...`
        : `ZIP 生成成功，正在请求保存 (共 ${successfulItems.length} 张)...`;
      dom.consoleDetailText.textContent = '请在弹出的保存窗口中确认保存位置';
      triggerSaveZip(zipBlob, currentTaskId, state.stopAndZipRequested);

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
    state.isCompressing = false;
    state.abortController = null;
    if (dom.btnDownloadZip) dom.btnDownloadZip.disabled = false;
    if (dom.btnCancelDownload) {
      dom.btnCancelDownload.disabled = false;
      dom.btnCancelDownload.title = '取消当前下载';
    }
    state.quotaPauseResolver = null;
  }

  // 单个 URL 请求与格式验证（Fix 3：防止伪装为图片的 HTML 错误页/JSON 错误响应，支持 signal 及时取消）
  async function fetchSingleUrlAndValidate(url, signal = null) {
    if (!url) return { success: false, error: '无效的图片地址' };
    if (signal && signal.aborted) {
      return { success: false, error: '下载任务已取消', aborted: true };
    }

    // 1. 如果是 data URL
    if (url.startsWith('data:')) {
      try {
        const res = await fetch(url, { signal });
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
        if ((signal && signal.aborted) || err.name === 'AbortError') {
          return { success: false, error: '下载任务已取消', aborted: true };
        }
        return { success: false, error: 'Data URL 解析失败: ' + err.message };
      }
    }

    // 2. 主动发起跨域 fetch 请求
    try {
      const response = await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        signal: signal
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
      if ((signal && signal.aborted) || fetchErr.name === 'AbortError') {
        return { success: false, error: '下载任务已取消', aborted: true };
      }

      // 3. 降级尝试：利用 Image 标签 + Canvas 转 Blob（应对部分允许绘制但不响应 fetch 的场景，传入 signal 支持及时取消）
      try {
        const canvasBlob = await fetchViaCanvasFallback(url, signal);
        if (signal && signal.aborted) {
          return { success: false, error: '下载任务已取消', aborted: true };
        }
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
      } catch (canvasErr) {
        if ((signal && signal.aborted) || (canvasErr && canvasErr.message === '下载任务已取消')) {
          return { success: false, error: '下载任务已取消', aborted: true };
        }
        return {
          success: false,
          error: `跨域限制: ${fetchErr.message} (Canvas兜底失败: ${canvasErr.message})`
        };
      }
    }
  }

  // 图片多级下载与回退调度器（Fix 2 高清下载失败自动回退原始地址，支持 signal 及时取消）
  async function fetchImageWithFallback(itemOrUrl, signal = null) {
    if (signal && signal.aborted) {
      return { success: false, error: '下载任务已取消', aborted: true };
    }
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
      if (signal && signal.aborted) {
        return { success: false, error: '下载任务已取消', aborted: true };
      }
      const candidateUrl = candidates[i];
      const isFallback = (i > 0);

      const result = await fetchSingleUrlAndValidate(candidateUrl, signal);
      if (result.aborted) {
        return result;
      }
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

  function fetchViaCanvasFallback(url, signal = null) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        return reject(new Error('下载任务已取消'));
      }

      const img = new Image();
      img.crossOrigin = 'anonymous';

      let timer = null;
      let abortHandler = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
        img.onload = null;
        img.onerror = null;
      };

      if (signal) {
        abortHandler = () => {
          cleanup();
          img.src = '';
          reject(new Error('下载任务已取消'));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      timer = setTimeout(() => {
        cleanup();
        img.src = '';
        reject(new Error('Canvas 降级请求超时'));
      }, 5000);

      img.onload = () => {
        cleanup();
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
        cleanup();
        img.src = '';
        reject(new Error('Image 降级加载失败 (可能目标网站禁止跨域画布导出)'));
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

  // 用户在保护弹窗中选择彻底取消下载任务
  function cancelQuotaGuard() {
    dom.modalQuotaGuard.classList.add('hidden');
    state.cancelRequested = true;
    if (state.abortController) {
      state.abortController.abort();
    }
    if (state.quotaPauseResolver) {
      state.quotaPauseResolver.resolve();
      state.quotaPauseResolver = null;
    }
    dom.consolePhaseText.textContent = '正在取消下载任务...';
  }

  // 辅助函数：判断错误是否为用户在文件窗口中主动取消
  function isUserCancelError(errMsg) {
    if (!errMsg) return false;
    const lower = String(errMsg).toLowerCase();
    return lower.includes('cancel') || lower.includes('user_canceled') || lower.includes('abort');
  }

  // 触发保存 ZIP 文件（准确追踪：生成成功 -> 保存已发起 -> 浏览器实际落盘/失败，支持跨批次隔离与防内存泄漏）
  function triggerSaveZip(blob, currentTaskId = 0, isStopAndZip = false) {
    const filename = `images_bundle_${Date.now()}.zip`;
    const objectUrl = URL.createObjectURL(blob);

    let isCleanedUp = false;
    let safetyTimer = null;
    let activeListener = null;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (safetyTimer) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      if (activeListener && chrome && chrome.downloads && typeof chrome.downloads.onChanged === 'object' && typeof chrome.downloads.onChanged.removeListener === 'function') {
        try {
          chrome.downloads.onChanged.removeListener(activeListener);
        } catch {}
        activeListener = null;
      }
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {}
      if (state.activeSaveTask && state.activeSaveTask.taskId === currentTaskId) {
        state.activeSaveTask = null;
      }
    };

    state.activeSaveTask = { taskId: currentTaskId, cleanup };

    if (chrome && chrome.downloads && typeof chrome.downloads.download === 'function') {
      chrome.downloads.download({
        url: objectUrl,
        filename: filename,
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : '下载拉起失败';
          
          // Fix 1: 用户主动取消保存窗口时，绝不触发 fallbackAnchorDownload，防止违背意愿强行下载
          if (isUserCancelError(errMsg)) {
            console.info('[Gallery] 用户在保存窗口中取消了下载:', errMsg);
            cleanup();
            if (state.currentBatchTaskId === currentTaskId) {
              dom.consolePhaseText.textContent = '保存已取消：用户取消了文件保存窗口';
              dom.consoleDetailText.textContent = 'ZIP 压缩文件未写入磁盘';
            }
            return;
          }

          console.warn('[Gallery] chrome.downloads.download 异常，降级为模拟点击下载:', errMsg);
          fallbackAnchorDownload(objectUrl, filename);
          if (state.currentBatchTaskId === currentTaskId) {
            dom.consolePhaseText.textContent = '保存已发起：请在浏览器下载面板中查看进度';
            dom.consoleDetailText.textContent = `文件: ${filename} (${formatBytes(blob.size)})`;
          }
          safetyTimer = setTimeout(cleanup, 60000);
          return;
        }

        // 保存已发起，等待浏览器完成写入
        if (state.currentBatchTaskId === currentTaskId) {
          dom.consolePhaseText.textContent = '保存已发起，等待浏览器完成写入...';
          dom.consoleDetailText.textContent = `文件: ${filename} (若弹出保存窗口，请点击保存)`;
        }

        // 监听下载状态变化，准确区分完成与失败
        if (chrome.downloads.onChanged && typeof chrome.downloads.onChanged.addListener === 'function') {
          const downloadListener = (delta) => {
            if (delta.id !== downloadId) return;

            if (delta.state && delta.state.current === 'complete') {
              cleanup();
              // Fix 3: 跨任务状态隔离，避免旧批次覆盖新启动批次的控制台
              if (state.currentBatchTaskId === currentTaskId) {
                dom.consolePhaseText.textContent = isStopAndZip
                  ? '保存完成！已成功保存已完成图片的压缩包'
                  : '保存完成！ZIP 压缩包已成功保存到本地磁盘';
                dom.consoleDetailText.textContent = `文件已落盘: ${filename} (${formatBytes(blob.size)})`;
              } else {
                console.info(`[Gallery] 批次 #${currentTaskId} 落盘完成，当前运行新任务 #${state.currentBatchTaskId}，不覆盖控制台`);
              }
            } else if (delta.state && delta.state.current === 'interrupted') {
              cleanup();
              const reason = delta.error ? delta.error.current : '未知错误';
              if (state.currentBatchTaskId === currentTaskId) {
                if (reason === 'USER_CANCELED' || isUserCancelError(reason)) {
                  dom.consolePhaseText.textContent = '保存已取消：用户取消了文件保存窗口';
                  dom.consoleDetailText.textContent = 'ZIP 压缩文件未写入磁盘';
                } else {
                  dom.consolePhaseText.textContent = `保存失败：浏览器写入错误 (${reason})`;
                  dom.consoleDetailText.textContent = '请检查浏览器下载权限或磁盘空间';
                  showAlert(`ZIP 保存失败: ${reason}`);
                }
              } else {
                console.info(`[Gallery] 批次 #${currentTaskId} 保存中断 (${reason})，当前运行新任务 #${state.currentBatchTaskId}，不覆盖控制台`);
              }
            }
          };

          activeListener = downloadListener;
          chrome.downloads.onChanged.addListener(downloadListener);

          // Fix 2: 防事件遗漏，针对瞬时完成或极速写入的场景，立即通过 search 补查
          if (typeof chrome.downloads.search === 'function') {
            chrome.downloads.search({ id: downloadId }, (items) => {
              if (items && items[0]) {
                const item = items[0];
                if (item.state === 'complete') {
                  downloadListener({ id: downloadId, state: { current: 'complete' } });
                } else if (item.state === 'interrupted') {
                  downloadListener({ id: downloadId, state: { current: 'interrupted' }, error: { current: item.error || 'SERVER_FAILED' } });
                }
              }
            });
          }

          // Fix 2: 安全兜底超时定时器，防止挂起状态导致 ObjectURL 及监听器永久泄漏
          safetyTimer = setTimeout(() => {
            console.warn(`[Gallery] 批次 #${currentTaskId} 保存任务超时未终结，执行安全清理`);
            cleanup();
          }, 300000);
        } else {
          // 若无 onChanged 监听权限，保持“保存已发起”状态提示
          if (state.currentBatchTaskId === currentTaskId) {
            dom.consolePhaseText.textContent = '保存已发起：请在浏览器下载面板中查看进度';
            dom.consoleDetailText.textContent = `文件: ${filename} (${formatBytes(blob.size)})`;
          }
          safetyTimer = setTimeout(cleanup, 60000);
        }
      });
    } else {
      fallbackAnchorDownload(objectUrl, filename);
      if (state.currentBatchTaskId === currentTaskId) {
        dom.consolePhaseText.textContent = '保存已发起：请在浏览器下载面板中查看进度';
        dom.consoleDetailText.textContent = `文件: ${filename} (${formatBytes(blob.size)})`;
      }
      safetyTimer = setTimeout(cleanup, 60000);
    }
  }

  function fallbackAnchorDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function updateCardStatusUI(id, status, size = 0, error = '') {
    const card = dom.galleryGrid.querySelector(`.image-card[data-id="${CSS.escape(id)}"]`);
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
        <span class="err-url" title="${escapeHtml(item.url || item.id)}">${escapeHtml(item.url || item.id)}</span>
        <span class="err-msg">${escapeHtml(item.error)}</span>
      </div>
    `).join('');
  }

  // -------------------------------------------------------------
  // 8. 单张下载与 Lightbox 大图预览
  // -------------------------------------------------------------
  async function downloadSingleImage(idOrUrl) {
    try {
      const item = state.allImages.find(img => img.id === idOrUrl || img.url === idOrUrl);
      const targetUrl = item ? item.url : idOrUrl;
      const fallbackUrl = (item && item.originalUrl && item.originalUrl !== targetUrl) ? item.originalUrl : null;

      // 1. 优先复用下载池已成功的 Blob（避免重复请求且保证扩展名精确）
      const cached = item ? state.downloadMap.get(item.id) : null;
      let blob = null;
      let ext = null;

      if (cached && cached.status === 'success' && cached.blob) {
        blob = cached.blob;
        ext = cached.filename ? cached.filename.split('.').pop() : null;
      } else {
        // 2. 发起下载并严格验证二进制格式 (自动触发高清地址->原始地址->Canvas回退)
        showAlert('正在准备下载单张图片...');
        const fetchResult = await fetchImageWithFallback(item || { id: idOrUrl, url: targetUrl, originalUrl: fallbackUrl });
        if (!fetchResult.success) {
          showAlert(`单张图片下载失败: ${fetchResult.error}`);
          return;
        }
        blob = fetchResult.blob;
        ext = fetchResult.ext;
        hideAlert();
      }

      if (!ext) {
        ext = getUrlExtension(targetUrl);
      }

      const filename = `single_image_${Date.now()}.${ext}`;
      const objectUrl = URL.createObjectURL(blob);

      if (chrome && chrome.downloads && typeof chrome.downloads.download === 'function') {
        chrome.downloads.download({
          url: objectUrl,
          filename: filename,
          saveAs: true
        }, (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : '';
            // Fix 1: 用户取消单张图片保存窗口时，不触发兜底下载
            if (isUserCancelError(errMsg)) {
              console.info('[Gallery] 用户取消了单张图片保存窗口');
              URL.revokeObjectURL(objectUrl);
              return;
            }
            fallbackAnchorDownload(objectUrl, filename);
          }
          setTimeout(() => { URL.revokeObjectURL(objectUrl); }, 60000);
        });
      } else {
        fallbackAnchorDownload(objectUrl, filename);
        setTimeout(() => { URL.revokeObjectURL(objectUrl); }, 60000);
      }
    } catch (err) {
      console.error('[Gallery] 单张下载异常:', err);
      showAlert(`单张下载异常: ${err.message}`);
    }
  }

  let lightboxErrorHandler = null;

  function openLightbox(imgItem) {
    dom.lightboxImg.dataset.id = imgItem.id || '';
    dom.lightboxResolution.textContent = (imgItem.width && imgItem.height) ? `${imgItem.width} × ${imgItem.height}` : '未知尺寸';
    dom.lightboxFormat.textContent = detectImageFormat(imgItem);
    dom.lightboxUrl.textContent = imgItem.url;

    // 清理旧的错误监听器
    if (lightboxErrorHandler) {
      dom.lightboxImg.removeEventListener('error', lightboxErrorHandler);
      lightboxErrorHandler = null;
    }

    // 修复 2：大图预览失败时通过纯 JS 事件监听器安全回退原始地址，杜绝内联属性且防止死循环
    const fallbackCandidate = (imgItem.originalUrl && imgItem.originalUrl !== imgItem.url)
      ? imgItem.originalUrl
      : (imgItem.fallbackUrl && imgItem.fallbackUrl !== imgItem.url ? imgItem.fallbackUrl : null);

    if (fallbackCandidate) {
      lightboxErrorHandler = function () {
        if (dom.lightboxImg.src !== fallbackCandidate) {
          dom.lightboxImg.src = fallbackCandidate;
          dom.lightboxUrl.textContent = fallbackCandidate;
        }
      };
      dom.lightboxImg.addEventListener('error', lightboxErrorHandler, { once: true });
    }

    dom.lightboxImg.src = imgItem.url;
    dom.modalLightbox.classList.remove('hidden');
  }

  function closeLightbox() {
    dom.modalLightbox.classList.add('hidden');
    if (lightboxErrorHandler) {
      dom.lightboxImg.removeEventListener('error', lightboxErrorHandler);
      lightboxErrorHandler = null;
    }
    dom.lightboxImg.src = '';
    dom.lightboxImg.dataset.id = '';
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

    // 刷新图片（单次扫描原网页 DOM 增量发现新图）
    if (dom.btnRefreshImages) {
      dom.btnRefreshImages.addEventListener('click', refreshImages);
    }

    // 失败重试采集
    if (dom.btnRetryCollect) {
      dom.btnRetryCollect.addEventListener('click', async () => {
        if (!state.taskId) {
          showAlert('未找到当前任务 ID，无法重试');
          return;
        }
        dom.btnRetryCollect.disabled = true;
        dom.btnRetryCollect.textContent = '正在重新启动...';
        showLoadingState('正在重新采集网页图片…');
        try {
          const resp = await chrome.runtime.sendMessage({
            action: 'RETRY_COLLECT_TASK',
            taskId: state.taskId
          });
          if (!resp || !resp.success) {
            showErrorState((resp && resp.error) || '重试失败，请确保来源标签页未关闭');
          }
        } catch (err) {
          showErrorState('重试请求发送失败: ' + err.message);
        }
      });
    }

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

    // 取消下载（在进行 ZIP 压缩打包时不可取消）
    dom.btnCancelDownload.addEventListener('click', () => {
      if (state.isCompressing) {
        showAlert('当前正在进行 ZIP 压缩打包，无法中止。请等待压缩完成。');
        return;
      }
      state.cancelRequested = true;
      if (state.abortController) {
        state.abortController.abort();
      }
      if (state.quotaPauseResolver) {
        state.quotaPauseResolver.resolve();
        state.quotaPauseResolver = null;
      }
      if (dom.modalQuotaGuard) {
        dom.modalQuotaGuard.classList.add('hidden');
      }
      dom.consolePhaseText.textContent = '正在取消下载任务...';
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
    if (dom.btnQuotaCancelAll) {
      dom.btnQuotaCancelAll.addEventListener('click', cancelQuotaGuard);
    }

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
      const id = dom.lightboxImg.dataset.id;
      const url = dom.lightboxUrl.textContent;
      if (id) {
        downloadSingleImage(id);
      } else if (url) {
        downloadSingleImage(url);
      }
    });

    // ESC 快捷键关闭弹窗 / 中止深度穿透 / 取消保护下载
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dom.modalQuotaGuard.classList.contains('hidden')) cancelQuotaGuard();
        if (!dom.modalLightbox.classList.contains('hidden')) closeLightbox();
        if (!dom.modalPro.classList.contains('hidden')) closeProModal();
      }
    });
  }

  // 启动
  document.addEventListener('DOMContentLoaded', init);
})();
