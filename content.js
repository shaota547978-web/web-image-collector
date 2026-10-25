/**
 * Web Image Collector - Content Script (网页图片嗅探器 - 核心修复版)
 * 运行在宿主页面上下文中：
 * 1. 严格过滤不可见元素与头像/logo等小杂质（>=150px 门槛）
 * 2. DOM 节点就地决选：单个 <img> 元素内部决选最高清 URL（direct link > data-original > srcset > lazy > src），并保留主图 fallbackUrl
 * 3. 跨节点保真去重：以完整规范化绝对 URL 字符串为基准去重，绝不截断 ? 查询参数或丢失签名/ID
 * 4. 统一职责：采集层忠实保留网页原始真实 URL，由画廊层统一负责安全的超清增强与失败回退调度
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
   * 检测 DOM 元素的可见性（严格过滤隐藏图片，但保留视口外有明确图片地址的懒加载节点）
   */
  function isElementVisible(el) {
    if (!el) return false;

    // 1. 检查 HTML 隐藏属性
    if (el.hasAttribute && el.hasAttribute('hidden')) {
      return false;
    }

    // 2. 检查 CSS 计算样式：明确声明不可见的直接过滤
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
    } catch {
      // 样式获取异常
    }

    // 3. 检查尺寸：如果 offset 尺寸与 getBoundingClientRect 均为 0，
    // 但拥有明确有效的图片 URL 属性（懒加载节点尚未进入视口渲染），不予排除
    if (el.offsetWidth === 0 || el.offsetHeight === 0) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        const hasLazyImageAttr = el.hasAttribute && (
          el.hasAttribute('src') ||
          el.hasAttribute('data-src') ||
          el.hasAttribute('data-original') ||
          el.hasAttribute('data-srcset') ||
          el.hasAttribute('srcset') ||
          el.hasAttribute('data-highres')
        );
        if (!hasLazyImageAttr) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * 检查是否为明确的空或微型追踪像素 data URL (绝不按分辨率排除普通小图片)
   */
  function isPixelOrTinyDataUrl(url) {
    if (!url) return true;

    // 仅针对 data URL 检查典型的 1x1 透明 gif/png 追踪像素 base64
    if (url.startsWith('data:')) {
      if (url.includes('R0lGODlhAQABA') || url.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')) {
        return true;
      }
      if (url.length < 40) {
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
   * 异步验证图片真实分辨率，带超时控制与错误捕获
   */
  function verifyImageDimensions(url, timeoutMs = 2000) {
    return new Promise((resolve) => {
      if (!url) return resolve({ width: 0, height: 0, valid: false });
      // 快速剔除无效或 1x1 base64 占位图
      if (url.startsWith('data:')) {
        if (url.includes('R0lGODlhAQABA') || url.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB') || url.length < 200) {
          return resolve({ width: 0, height: 0, valid: false });
        }
      }

      // 如果运行在 Node.js 环境或缺失 Image 构造器
      if (typeof Image === 'undefined') {
        return resolve({ width: 0, height: 0, valid: true });
      }

      const img = new Image();
      let timer = null;
      let settled = false;

      const finish = (w, h, valid, timeout = false) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        try { img.src = ''; } catch {}
        resolve({ width: w, height: h, valid, timeout });
      };

      timer = setTimeout(() => {
        finish(0, 0, false, true);
      }, timeoutMs);

      img.onload = () => {
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        finish(nw, nh, true, false);
      };

      img.onerror = () => {
        finish(0, 0, false, false);
      };

      try {
        img.src = url;
      } catch {
        finish(0, 0, false, false);
      }
    });
  }

  /**
   * 并发限制执行池 (限制最大并发数，避免拖慢页面)
   */
  async function runWithConcurrency(items, limit, workerFn) {
    const results = [];
    let idx = 0;
    const executing = [];

    for (const item of items) {
      const p = Promise.resolve().then(() => workerFn(item, idx++)).then(res => {
        const pIdx = executing.indexOf(p);
        if (pIdx !== -1) executing.splice(pIdx, 1);
        return res;
      });
      executing.push(p);
      results.push(p);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
    return Promise.all(results);
  }

  /**
   * 页面图片采集主入口 (完整采集所有有效图片，真实校验图片尺寸)
   */
  async function collectImagesFromPage() {
    // 跨节点的去重逻辑：安全基准，仅当【完整 URL 字符串完全相同】时执行去重
    const candidateMap = new Map(); // targetUrl -> ImageCandidate

    function registerCandidate({ url, primaryUrl = null, width = 0, height = 0, alt = '', source = 'img', detailUrl = null, hasDetailLink = false }) {
      const absUrl = normalizeUrl(url);
      if (!absUrl) return;

      // 仅过滤微型 1x1 追踪 data URL，绝不因为尺寸小而丢弃有效图片
      if (isPixelOrTinyDataUrl(absUrl)) {
        return;
      }

      // 统一职责：采集层忠实保留网页原始完整 URL（保留所有 query、签名与 token），绝不篡改 CDN 参数
      const targetUrl = absUrl;
      const absPrimary = primaryUrl ? normalizeUrl(primaryUrl) : null;
      const fallbackUrl = (absPrimary && absPrimary !== targetUrl) ? absPrimary : null;

      // 安全基准去重：仅当完整 URL 字符串完全相同时去重
      if (candidateMap.has(targetUrl)) {
        const existing = candidateMap.get(targetUrl);
        if (width > 0) existing.width = Math.max(existing.width || 0, width);
        if (height > 0) existing.height = Math.max(existing.height || 0, height);
        if (!existing.alt && alt) existing.alt = alt;
        if (!existing.detailUrl && detailUrl) {
          existing.detailUrl = detailUrl;
          existing.hasDetailLink = true;
        }
        if (!existing.fallbackUrl && fallbackUrl) {
          existing.fallbackUrl = fallbackUrl;
        }
      } else {
        candidateMap.set(targetUrl, {
          url: targetUrl,
          originalUrl: targetUrl,
          fallbackUrl: fallbackUrl,
          width: width || 0,
          height: height || 0,
          alt: (alt || '').trim().slice(0, 100),
          source: source,
          detailUrl: detailUrl || null,
          hasDetailLink: !!detailUrl
        });
      }
    }

    // 1. 深度扫描页面所有 <img> 标签（不排除头像、Logo、小图标与小图片）
    const imgElements = document.querySelectorAll('img');
    imgElements.forEach(img => {
      // 1.1 可见性检测：仅过滤显式隐藏元素
      if (!isElementVisible(img)) {
        return;
      }

      // 1.2 顺藤摸瓜探测：识别外层包裹的 <a> 链接与本地大图属性
      const { directImageUrl, detailUrl } = extractAnchorInfo(img);
      const localHighRes = extractLocalHighResAttribute(img);

      // 1.3 【DOM 节点就地决选】
      const rawSrcset = img.getAttribute('srcset');
      const bestSrcset = extractBestFromSrcset(rawSrcset);

      let chosenUrl = null;
      let chosenWidth = 0;
      let chosenHeight = 0;
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
      // 决选优先级 C：srcset 中 descriptor 最大的高清条目 (注意：srcset 描述符不能直接当作已验证真实尺寸)
      else if (bestSrcset && bestSrcset.url) {
        chosenUrl = bestSrcset.url;
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

      // 记录当前常规真实主图 src (优先 currentSrc，降级 src)，作为 DOM 级降级 fallbackUrl
      const primaryUrl = img.currentSrc || img.src;
      if (!chosenUrl) {
        if (primaryUrl) {
          chosenUrl = primaryUrl;
          chosenSource = 'img';
        }
      }

      // 严格尺寸确认：只有当 chosenUrl 确实是当前 img 已经在 DOM 中加载且具有 naturalWidth/naturalHeight 时，才是真实已验证分辨率
      // 绝不把容器 clientWidth/clientHeight 或 srcset 描述符当成已验证尺寸！两者不一致时设为 0，等待异步校验或标注为未知尺寸
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      if (chosenUrl && primaryUrl && (chosenUrl === primaryUrl || chosenUrl === img.src)) {
        if (naturalWidth > 0 && naturalHeight > 0) {
          chosenWidth = naturalWidth;
          chosenHeight = naturalHeight;
        }
      }

      // 单个 <img> 录入就地胜出的最高清候选 URL，保留全部有效小图与大图
      if (chosenUrl) {
        registerCandidate({
          url: chosenUrl,
          primaryUrl: primaryUrl,
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

      if (parentPic && parentPic.querySelector('img')) {
        return;
      }

      const bestSrcset = extractBestFromSrcset(source.getAttribute('srcset'));
      if (bestSrcset && bestSrcset.url) {
        registerCandidate({
          url: bestSrcset.url,
          width: 0, // 绝不把 srcset 描述符当成已验证尺寸
          height: 0,
          source: 'picture-source-hd'
        });
      }
    });

    // 3. 扫描 <video poster="..."> 视频封面
    const videoElements = document.querySelectorAll('video[poster]');
    videoElements.forEach(video => {
      if (!isElementVisible(video)) return;

      const poster = video.getAttribute('poster');
      if (poster) {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        registerCandidate({
          url: poster,
          width: w,
          height: h,
          source: 'video-poster'
        });
      }
    });

    // 4. 扫描 CSS background-image
    // 关键修复：绝不再把容器 clientWidth/clientHeight 当作背景图片真实分辨率
    // 对背景图 URL 执行真实图片宽高验证，保留有效小图片（如 32x32）与大幅背景图（如 1920x1080）
    const candidateBgUrls = new Set();
    const bgElements = document.querySelectorAll(
      '[style*="background"], header, banner, hero, .banner, .hero, .bg, .slider, .carousel, div, section, article'
    );
    const urlPattern = /url\(["']?(.*?)["']?\)/i;

    bgElements.forEach(el => {
      try {
        if (!isElementVisible(el)) return;

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
            const rawUrl = match[1].trim();
            const absUrl = normalizeUrl(rawUrl);
            if (absUrl && !candidateMap.has(absUrl)) {
              if (!isPixelOrTinyDataUrl(absUrl)) {
                candidateBgUrls.add(absUrl);
              }
            }
          }
        }
      } catch {
        // 忽略样式跨域等错误
      }
    });

    // 4.1 对收集到的候选背景图片 URL 执行真实尺寸校验（允许小尺寸背景图进入，记录真实尺寸）
    if (candidateBgUrls.size > 0) {
      const bgUrlList = Array.from(candidateBgUrls);
      await runWithConcurrency(bgUrlList, 6, async (bgUrl) => {
        const check = await verifyImageDimensions(bgUrl, 2000);
        if (check.valid) {
          // 记录真实分辨率，不编造父容器尺寸，也不丢弃小尺寸有效背景图
          registerCandidate({
            url: bgUrl,
            width: check.width || 0,
            height: check.height || 0,
            source: 'background-image'
          });
        } else if (check.timeout) {
          // 验证超时但为有效网络图片：保留但设为未知尺寸，不编造
          if (bgUrl.startsWith('http://') || bgUrl.startsWith('https://')) {
            registerCandidate({
              url: bgUrl,
              width: 0,
              height: 0,
              source: 'background-image'
            });
          }
        }
      });
    }

    // 5. 对所有未确认尺寸的候选网络图片（如 srcset 高清候选、未加载懒加载大图）进行受控异步验证并更新真实尺寸
    const unverifiedCandidates = Array.from(candidateMap.values()).filter(
      item => (item.width === 0 || item.height === 0) &&
              item.source !== 'background-image' &&
              (item.url.startsWith('http://') || item.url.startsWith('https://'))
    );

    if (unverifiedCandidates.length > 0) {
      await runWithConcurrency(unverifiedCandidates, 8, async (item) => {
        try {
          const check = await verifyImageDimensions(item.url, 1500);
          if (check.valid && check.width > 0 && check.height > 0) {
            item.width = check.width;
            item.height = check.height;
          }
        } catch {
          // 校验失败保留原有 0 宽高，由画廊显示「未知尺寸」
        }
      });
    }

    // 6. 输出清洗后的图片列表（包含原始地址与降级元数据，不过滤小图片）
    const finalResults = Array.from(candidateMap.values()).map(item => ({
      url: item.url,
      originalUrl: item.originalUrl || item.url,
      fallbackUrl: item.fallbackUrl || null,
      width: item.width || 0,
      height: item.height || 0,
      alt: item.alt,
      source: item.source,
      detailUrl: item.detailUrl || null,
      hasDetailLink: !!item.detailUrl
    })).filter(item => {
      if (!item.url) return false;
      if (item.url.startsWith('data:')) return !isPixelOrTinyDataUrl(item.url);
      return item.url.startsWith('http://') || item.url.startsWith('https://');
    });

    return finalResults;
  }

  // 监听来自 Background 与 Gallery 的采集指令
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) return false;

    if (request.action === 'SNIFF_IMAGES') {
      (async () => {
        try {
          const images = await collectImagesFromPage();
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
      })();
      return true; // 保持异步消息通道有效
    }

    return false;
  });

  // 全局暴露嗅探方法供 executeScript 直接调度
  window.__webImageCollectorSniff = collectImagesFromPage;
})();

