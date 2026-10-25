/**
 * Web Image Collector - Content Script (网页图片嗅探器 - 精准修复版)
 * 运行在宿主页面上下文中：
 * 1. 严格过滤不可见元素与头像/logo等小杂质（>=150px 门槛）
 * 2. DOM 节点就地决选：单个 <img> 元素内部决选最高清 URL，从源头杜绝单个元素多次录入
 * 3. 跨节点安全去重：仅当【完整 URL 字符串完全相同】时执行去重，绝不盲目截断 ? 参数
 * 4. 白名单 CDN 增强：仅对 images.unsplash.com 等受信域名调整画质参数，非白名单域名保留原始完整 URL
 */

(function () {
  // 防止重复注入全局污染
  if (window.__webImageCollectorLoaded) {
    return;
  }
  window.__webImageCollectorLoaded = true;

  /**
   * 将任意相对地址规范化为完整绝对 URL
   */
  function normalizeUrl(rawUrl, baseUrl = window.location.href) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('about:')) {
      return null;
    }
    try {
      return new URL(trimmed, baseUrl).href;
    } catch {
      return null;
    }
  }

  /**
   * 白名单 CDN 增强逻辑：
   * 仅对白名单域名（如 images.unsplash.com）安全调整已知的画质参数。
   * 对所有非白名单网站，严格保留原始完整 URL（包括所有 query 参数与签名），确保绝对兼容性。
   */
  function enhanceToHighResUrl(rawUrl) {
    if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;

    try {
      const parsed = new URL(rawUrl, window.location.href);
      const host = parsed.hostname.toLowerCase();

      // 白名单：Unsplash CDN
      if (host === 'images.unsplash.com' || host.endsWith('.unsplash.com')) {
        const sp = parsed.searchParams;
        if (sp.has('w')) {
          const curW = parseInt(sp.get('w'), 10) || 0;
          if (curW < 2560) {
            sp.set('w', '2560'); // 安全提升至 2560px 原画
          }
        }
        if (sp.has('q')) {
          sp.set('q', '85'); // 提高画质压缩比
        }
        if (sp.get('fit') === 'crop') {
          sp.set('fit', 'max'); // 避免强制切头切尾裁剪，保留完整比例
        }
        return parsed.href;
      }

      // 所有非白名单网站，必须保留原始完整 URL，严禁篡改任何路径或参数
      return rawUrl;
    } catch {
      return rawUrl;
    }
  }

  /**
   * 检测 DOM 元素的可见性（严格过滤隐藏图片）
   */
  function isElementVisible(el) {
    if (!el) return false;

    // 1. 检查 offset 尺寸
    if (el.offsetWidth === 0 || el.offsetHeight === 0) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        return false;
      }
    }

    // 2. 检查 CSS 计算样式
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
    } catch {
      // 样式获取异常
    }

    // 3. 检查 HTML 隐藏属性
    if (el.hasAttribute('hidden')) {
      return false;
    }

    return true;
  }

  /**
   * 检查元素是否为头像、作者照片、Logo 或小图标等杂质
   */
  function isAvatarOrIcon(el) {
    if (!el) return false;
    const keywords = ['avatar', 'profile', 'author', 'logo', 'icon', 'badge', 'user-pic', 'userpic', 'user-avatar'];

    let current = el;
    let depth = 0;
    while (current && depth < 4) {
      const className = (typeof current.className === 'string' ? current.className : '').toLowerCase();
      const id = (current.id || '').toLowerCase();
      const role = (current.getAttribute && current.getAttribute('role') || '').toLowerCase();

      for (const kw of keywords) {
        if (className.includes(kw) || id.includes(kw)) {
          return true;
        }
      }

      if (role === 'img' && (className.includes('icon') || className.includes('logo'))) {
        return true;
      }

      current = current.parentElement;
      depth++;
    }
    return false;
  }

  /**
   * 检查是否为微型追踪像素或极小占位符
   */
  function isPixelOrTinyDataUrl(url, width, height) {
    if (!url) return true;

    // 150px 门槛检测：如果已知尺寸均小于 150px，剔除
    if (width > 0 && height > 0 && (width < 150 || height < 150)) {
      return true;
    }

    // 检查常见的 1x1 透明 gif/png 追踪像素 base64
    if (url.startsWith('data:')) {
      if (url.includes('R0lGODlhAQABA') || url.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')) {
        return true;
      }
      if (url.length < 200) {
        return true;
      }
    }

    return false;
  }

  /**
   * 从 srcset 字符串中强制提取 descriptor 最大（如 2x 或 1080w、2048w）的高清 URL 作为候选源
   */
  function extractBestFromSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return null;

    const entries = srcset.split(/,\s+/).map(item => {
      const parts = item.trim().split(/\s+/);
      const rawCandidateUrl = parts[0];
      const descriptor = parts[1] || '1x';
      let width = 0;
      let scale = 1;
      let score = 1;

      if (descriptor.endsWith('w')) {
        width = parseInt(descriptor, 10) || 1;
        score = width; // 比如 2048
      } else if (descriptor.endsWith('x')) {
        scale = parseFloat(descriptor) || 1;
        score = scale * 1000; // 2x -> 2000, 3x -> 3000
      }

      return {
        url: rawCandidateUrl,
        score,
        width
      };
    });

    entries.sort((a, b) => b.score - a.score);
    return entries.length > 0 ? entries[0] : null;
  }

  /**
   * 检查 URL 是否直接指向图片文件直链
   */
  function isDirectImageFileUrl(url) {
    if (!url) return false;
    return /\.(jpe?g|png|webp|avif|gif|bmp)(?:[\?#]|$)/i.test(url) ||
           /\/(?:raw|large|original|download|full)\//i.test(url);
  }

  /**
   * 检查 img 节点自身及父级容器上常见的大图属性
   */
  function extractLocalHighResAttribute(img) {
    const attrs = [
      'data-original', 'data-highres', 'data-zoom', 'data-full-src',
      'data-large', 'data-src-large', 'data-raw', 'data-origin-src',
      'data-actualsrc', 'data-super-full', 'data-zoom-image'
    ];
    for (const attr of attrs) {
      const val = img.getAttribute(attr);
      if (val && !val.startsWith('data:')) {
        const abs = normalizeUrl(val);
        if (abs) return abs;
      }
    }
    if (img.parentElement) {
      for (const attr of attrs) {
        const val = img.parentElement.getAttribute(attr);
        if (val && !val.startsWith('data:')) {
          const abs = normalizeUrl(val);
          if (abs) return abs;
        }
      }
    }
    return null;
  }

  /**
   * 探测直接包裹 <img> 的 <a> 标签，识别大图直链或详情页地址
   */
  function extractAnchorInfo(img) {
    const parentAnchor = img.closest('a');
    if (!parentAnchor) return { directImageUrl: null, detailUrl: null };

    const rawHref = parentAnchor.getAttribute('href') || parentAnchor.href;
    if (!rawHref) return { directImageUrl: null, detailUrl: null };

    const trimmed = rawHref.trim();
    if (!trimmed || trimmed.startsWith('javascript:') || trimmed.startsWith('#') || trimmed.startsWith('mailto:')) {
      return { directImageUrl: null, detailUrl: null };
    }

    const absHref = normalizeUrl(trimmed);
    if (!absHref) return { directImageUrl: null, detailUrl: null };

    // 1. 若 a.href 直接是指向图片文件的直链
    if (isDirectImageFileUrl(absHref)) {
      return { directImageUrl: absHref, detailUrl: null };
    }

    // 排除无意义的外部社交分享
    if (/(?:facebook\.com\/sharer|twitter\.com\/intent|pinterest\.com\/pin\/create|linkedin\.com\/share)/i.test(absHref)) {
      return { directImageUrl: null, detailUrl: null };
    }

    // 2. 有效的同源/第三方详情页网址
    return { directImageUrl: null, detailUrl: absHref };
  }

  /**
   * 页面图片采集主入口
   */
  function collectImagesFromPage() {
    // 跨节点的去重逻辑：安全基准，仅当【完整 URL 字符串完全相同】时执行去重
    const candidateMap = new Map(); // targetUrl -> ImageCandidate

    function registerCandidate({ url, width = 0, height = 0, alt = '', source = 'img', detailUrl = null, hasDetailLink = false }) {
      const absUrl = normalizeUrl(url);
      if (!absUrl) return;

      // 提升门槛：小于 150px 排除
      if (isPixelOrTinyDataUrl(absUrl, width, height)) {
        return;
      }

      // 仅白名单 CDN 调整参数，非白名单严格保留原始完整 URL
      const targetUrl = enhanceToHighResUrl(absUrl);

      // 安全基准去重：仅当完整 URL 字符串完全相同时去重
      if (candidateMap.has(targetUrl)) {
        const existing = candidateMap.get(targetUrl);
        existing.width = Math.max(existing.width || 0, width || 0);
        existing.height = Math.max(existing.height || 0, height || 0);
        if (!existing.alt && alt) existing.alt = alt;
        if (!existing.detailUrl && detailUrl) {
          existing.detailUrl = detailUrl;
          existing.hasDetailLink = true;
        }
      } else {
        candidateMap.set(targetUrl, {
          url: targetUrl,
          width: width || 0,
          height: height || 0,
          alt: (alt || '').trim().slice(0, 100),
          source: source,
          detailUrl: detailUrl || null,
          hasDetailLink: !!detailUrl
        });
      }
    }

    // 1. 深度扫描页面所有 <img> 标签
    const imgElements = document.querySelectorAll('img');
    imgElements.forEach(img => {
      // 1.1 可见性检测：过滤不可见元素
      if (!isElementVisible(img)) {
        return;
      }

      // 1.2 过滤头像与小杂质
      if (isAvatarOrIcon(img)) {
        return;
      }

      // 1.3 尺寸检测：过滤 < 150px 杂质
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      const clientWidth = img.clientWidth || img.offsetWidth || 0;
      const clientHeight = img.clientHeight || img.offsetHeight || 0;

      // 如果已具备渲染尺寸且尺寸均 < 150px，剔除
      if (naturalWidth > 0 && naturalHeight > 0) {
        if (naturalWidth < 150 || naturalHeight < 150) return;
      } else if (clientWidth > 0 && clientHeight > 0) {
        if (clientWidth < 150 || clientHeight < 150) return;
      }

      let width = naturalWidth || clientWidth;
      let height = naturalHeight || clientHeight;

      // 1.4 顺藤摸瓜探测：识别外层包裹的 <a> 链接与本地大图属性
      const { directImageUrl, detailUrl } = extractAnchorInfo(img);
      const localHighRes = extractLocalHighResAttribute(img);

      // 1.5 【DOM 节点就地决选】
      const rawSrcset = img.getAttribute('srcset');
      const bestSrcset = extractBestFromSrcset(rawSrcset);

      let chosenUrl = null;
      let chosenWidth = width;
      let chosenHeight = height;
      let chosenSource = 'img';

      // 决选最高优先级 A：父级 <a> 直接指向的高清大图直链
      if (directImageUrl) {
        chosenUrl = directImageUrl;
        chosenSource = 'img-anchor-direct';
      }
      // 决选优先级 B：节点自身或父级携带的 data-original/data-highres 大图属性
      else if (localHighRes) {
        chosenUrl = localHighRes;
        chosenSource = 'img-local-hd';
      }
      // 决选优先级 C：srcset 中 descriptor 最大的高清条目
      else if (bestSrcset && bestSrcset.url) {
        chosenUrl = bestSrcset.url;
        chosenWidth = Math.max(width, bestSrcset.width || 0);
        if (chosenWidth > width && width > 0 && height > 0) {
          chosenHeight = Math.round(chosenWidth * (height / width));
        }
        chosenSource = 'img-srcset-hd';
      }

      // 若未命中大图，检查常见懒加载真实原图属性
      if (!chosenUrl) {
        const lazyUrl = img.getAttribute('data-src') || 
                        img.getAttribute('data-original') || 
                        img.getAttribute('data-origin-src') || 
                        img.getAttribute('data-actualsrc');
        if (lazyUrl) {
          chosenUrl = lazyUrl;
          chosenSource = 'img-lazy';
        }
      }

      // 最后降级为当前常规 src (优先 currentSrc，降级 src)
      if (!chosenUrl) {
        const primaryUrl = img.currentSrc || img.src;
        if (primaryUrl) {
          chosenUrl = primaryUrl;
          chosenSource = 'img';
        }
      }

      // 单个 <img> 仅录入就地胜出的唯一最高清 URL，并附带 detailUrl 元数据
      if (chosenUrl) {
        registerCandidate({
          url: chosenUrl,
          width: chosenWidth,
          height: chosenHeight,
          alt: img.alt || img.title,
          source: chosenSource,
          detailUrl: detailUrl || null,
          hasDetailLink: !!detailUrl
        });
      }
    });

    // 2. 扫描 <picture> 内的 <source>（若未包含在已处理的 img 中）
    const pictureSources = document.querySelectorAll('picture source');
    pictureSources.forEach(source => {
      const parentPic = source.closest('picture');
      if (parentPic && !isElementVisible(parentPic)) return;
      if (parentPic && isAvatarOrIcon(parentPic)) return;

      // 若父级 picture 已经包含 img，img 处理逻辑已就地提取 srcset
      if (parentPic && parentPic.querySelector('img')) {
        return;
      }

      const bestSrcset = extractBestFromSrcset(source.getAttribute('srcset'));
      if (bestSrcset && bestSrcset.url) {
        registerCandidate({
          url: bestSrcset.url,
          width: bestSrcset.width || 0,
          height: 0,
          source: 'picture-source-hd'
        });
      }
    });

    // 3. 扫描 <video poster="..."> 视频封面
    const videoElements = document.querySelectorAll('video[poster]');
    videoElements.forEach(video => {
      if (!isElementVisible(video)) return;
      if (isAvatarOrIcon(video)) return;

      const poster = video.getAttribute('poster');
      if (poster) {
        const w = video.videoWidth || video.clientWidth || 0;
        const h = video.videoHeight || video.clientHeight || 0;
        if ((w === 0 || w >= 150) && (h === 0 || h >= 150)) {
          registerCandidate({
            url: poster,
            width: w,
            height: h,
            source: 'video-poster'
          });
        }
      }
    });

    // 4. 扫描 CSS background-image
    const bgElements = document.querySelectorAll(
      '[style*="background"], header, banner, hero, .banner, .hero, .bg, .slider, .carousel, div, section, article'
    );
    const urlPattern = /url\(["']?(.*?)["']?\)/i;

    bgElements.forEach(el => {
      try {
        if (!isElementVisible(el)) return;
        if (isAvatarOrIcon(el)) return;

        const w = el.clientWidth || el.offsetWidth || 0;
        const h = el.clientHeight || el.offsetHeight || 0;
        // 背景容器小于 150px 排除
        if (w > 0 && h > 0 && (w < 150 || h < 150)) {
          return;
        }

        const inlineBg = el.style && el.style.backgroundImage;
        let bgStyle = inlineBg;

        if (!bgStyle && el.tagName && ['DIV', 'SECTION', 'HEADER', 'ARTICLE'].includes(el.tagName)) {
          const comp = window.getComputedStyle(el);
          if (comp && comp.backgroundImage && comp.backgroundImage !== 'none') {
            bgStyle = comp.backgroundImage;
          }
        }

        if (bgStyle && bgStyle !== 'none') {
          const match = bgStyle.match(urlPattern);
          if (match && match[1]) {
            registerCandidate({
              url: match[1],
              width: w,
              height: h,
              source: 'background-image'
            });
          }
        }
      } catch {
        // 忽略样式跨域等错误
      }
    });

    // 输出清洗后的图片列表（包含原图穿透元数据）
    const finalResults = Array.from(candidateMap.values()).map(item => ({
      url: item.url,
      width: item.width,
      height: item.height,
      alt: item.alt,
      source: item.source,
      detailUrl: item.detailUrl || null,
      hasDetailLink: !!item.detailUrl
    })).filter(item => {
      if (!item.url) return false;
      if (item.url.startsWith('data:')) return item.url.length >= 200;
      return item.url.startsWith('http://') || item.url.startsWith('https://');
    });

    return finalResults;
  }

  // 监听来自 Background 的采集指令
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === 'SNIFF_IMAGES') {
      try {
        const images = collectImagesFromPage();
        sendResponse({
          success: true,
          images: images,
          pageUrl: window.location.href,
          pageTitle: document.title || 'Untitled Page'
        });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message
        });
      }
    }
    return true;
  });

  // 全局暴露嗅探方法供 executeScript 直接获取结果
  window.__webImageCollectorSniff = collectImagesFromPage;
})();
