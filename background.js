/**
 * Web Image Collector - Background Service Worker
 * 调度网关：负责监听点击动作、注入并唤起嗅探脚本、暂存图片数据并打开独立画廊页面
 */

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) {
    return;
  }

  // 1. 拦截不可注入脚本的受限浏览器内部页面
  const restrictedProtocols = ['chrome:', 'edge:', 'about:', 'chrome-extension:', 'devtools:', 'view-source:'];
  const isRestricted = !tab.url || restrictedProtocols.some(proto => tab.url.startsWith(proto));

  if (isRestricted) {
    console.warn('[Web Image Collector] 无法在浏览器特权页面上执行图片抓取:', tab.url);
    // 打开画廊页面并展示引导提示
    await chrome.storage.local.set({
      currentCollectorTask: {
        images: [],
        pageUrl: tab.url || 'Internal Page',
        pageTitle: tab.title || 'Chrome Internal Page',
        collectedAt: Date.now(),
        warning: '无法在 Chrome 内部页面（如 chrome:// 开头的页面）抓取图片，请在正常网页（如 Unsplash、GitHub、电商等）上点击插件图标。'
      }
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') });
    return;
  }

  try {
    let result = null;

    // 2. 首先尝试向页面已有的 content script 发送消息
    try {
      result = await chrome.tabs.sendMessage(tab.id, { action: 'SNIFF_IMAGES' });
    } catch {
      // 页面未注入过 content script（例如未刷新页面），需要动态注入
      console.log('[Web Image Collector] 正在动态注入 content.js...');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      });

      // 再次发送消息或者直接执行抓取函数
      try {
        result = await chrome.tabs.sendMessage(tab.id, { action: 'SNIFF_IMAGES' });
      } catch {
        // 如果消息通道仍未就绪，使用 executeScript 执行函数返回值
        const injectedResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            if (typeof window.__webImageCollectorSniff === 'function') {
              return {
                success: true,
                images: window.__webImageCollectorSniff(),
                pageUrl: window.location.href,
                pageTitle: document.title || 'Untitled Page'
              };
            }
            return { success: false, error: 'Sniff function not found' };
          }
        });
        if (injectedResults && injectedResults[0] && injectedResults[0].result) {
          result = injectedResults[0].result;
        }
      }
    }

    const images = (result && result.success && Array.isArray(result.images)) ? result.images : [];
    const pageUrl = (result && result.pageUrl) || tab.url || '';
    const pageTitle = (result && result.pageTitle) || tab.title || 'Untitled Page';

    console.log(`[Web Image Collector] 成功捕获到 ${images.length} 张图片，正在打开画廊工作台...`);

    // 3. 将抓取到的数据写入 storage.local
    await chrome.storage.local.set({
      currentCollectorTask: {
        images: images,
        pageUrl: pageUrl,
        pageTitle: pageTitle,
        collectedAt: Date.now(),
        warning: images.length === 0 ? '该页面未嗅探到有效大图（可能图片以 Canvas、WebGL 渲染或均小于 32x32 像素）。' : null
      }
    });

    // 4. 打开独立的 gallery.html 标签页
    chrome.tabs.create({
      url: chrome.runtime.getURL('gallery.html')
    });

  } catch (err) {
    console.error('[Web Image Collector] 嗅探过程发生异常:', err);
    // 写入异常信息并打开画廊页面展示友好错误提示
    await chrome.storage.local.set({
      currentCollectorTask: {
        images: [],
        pageUrl: tab.url || '',
        pageTitle: tab.title || 'Error',
        collectedAt: Date.now(),
        warning: `采集失败: ${err.message || '未知错误'}`
      }
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') });
  }
});
