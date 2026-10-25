/**
 * Web Image Collector - Background Service Worker
 * 调度网关：点击扩展立即打开画廊，后台异步唤起嗅探脚本，基于独立 taskId 严格隔离任务
 */

// 异步嗅探执行器（独立于画廊打开流程，杜绝阻塞画廊呈现）
async function executeSniffForTask(taskId, sourceTab) {
  try {
    let result = null;

    // 1. 首先尝试向页面已有的 content script 发送嗅探指令 (带上 taskId)
    try {
      result = await chrome.tabs.sendMessage(sourceTab.id, {
        action: 'SNIFF_IMAGES',
        taskId: taskId
      });
    } catch {
      // 页面未注入过 content script（例如未刷新页面），动态注入
      console.log(`[Web Image Collector] 任务 ${taskId} 正在动态注入 content.js...`);
      await chrome.scripting.executeScript({
        target: { tabId: sourceTab.id },
        files: ['content.js']
      });

      // 再次发送消息或者直接执行抓取函数
      try {
        result = await chrome.tabs.sendMessage(sourceTab.id, {
          action: 'SNIFF_IMAGES',
          taskId: taskId
        });
      } catch {
        const injectedResults = await chrome.scripting.executeScript({
          target: { tabId: sourceTab.id },
          func: async (tid) => {
            if (typeof window.__webImageCollectorSniff === 'function') {
              const sniffedImages = await window.__webImageCollectorSniff(tid);
              return {
                success: true,
                images: sniffedImages,
                pageUrl: window.location.href,
                pageTitle: document.title || 'Untitled Page'
              };
            }
            return { success: false, error: 'Sniff function not found' };
          },
          args: [taskId]
        });
        if (injectedResults && injectedResults[0] && injectedResults[0].result) {
          result = injectedResults[0].result;
        }
      }
    }

    const images = (result && result.success && Array.isArray(result.images)) ? result.images : [];
    const pageUrl = (result && result.pageUrl) || sourceTab.url || '';
    const pageTitle = (result && result.pageTitle) || sourceTab.title || 'Untitled Page';

    console.log(`[Web Image Collector] 任务 ${taskId} 嗅探完成，捕获到 ${images.length} 张图片`);

    const updatedTask = {
      taskId: taskId,
      sourceTabId: sourceTab.id,
      images: images,
      pageUrl: pageUrl,
      pageTitle: pageTitle,
      status: 'success',
      completedAt: Date.now(),
      warning: images.length === 0 ? '该页面未嗅探到有效图片。' : null
    };

    // 写入专属任务存储空间与向下兼容入口
    await chrome.storage.local.set({
      [`collectorTask_${taskId}`]: updatedTask,
      currentCollectorTask: updatedTask
    });

    // 广播任务完成通知
    chrome.runtime.sendMessage({
      action: 'COLLECTOR_TASK_UPDATED',
      taskId: taskId,
      status: 'success',
      task: updatedTask
    }).catch(() => {});

  } catch (err) {
    console.error(`[Web Image Collector] 任务 ${taskId} 嗅探异常:`, err);
    const failedTask = {
      taskId: taskId,
      sourceTabId: sourceTab.id,
      images: [],
      pageUrl: sourceTab.url || '',
      pageTitle: sourceTab.title || 'Error',
      status: 'error',
      completedAt: Date.now(),
      error: err.message || '网络连接或页面无响应'
    };

    await chrome.storage.local.set({
      [`collectorTask_${taskId}`]: failedTask,
      currentCollectorTask: failedTask
    });

    chrome.runtime.sendMessage({
      action: 'COLLECTOR_TASK_UPDATED',
      taskId: taskId,
      status: 'error',
      error: failedTask.error
    }).catch(() => {});
  }
}

// 监听扩展图标点击：立即创建任务并打开画廊，后台异步扫描
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) {
    return;
  }

  // 1. 生成唯一 taskId 隔离多次或多标签页并发采集
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 2. 拦截不可注入脚本的受限浏览器内部页面
  const restrictedProtocols = ['chrome:', 'edge:', 'about:', 'chrome-extension:', 'devtools:', 'view-source:'];
  const isRestricted = !tab.url || restrictedProtocols.some(proto => tab.url.startsWith(proto));

  if (isRestricted) {
    console.warn('[Web Image Collector] 浏览器特权页面拦截:', tab.url);
    const restrictedTask = {
      taskId: taskId,
      sourceTabId: tab.id,
      images: [],
      pageUrl: tab.url || 'Internal Page',
      pageTitle: tab.title || 'Chrome Internal Page',
      status: 'error',
      createdAt: Date.now(),
      warning: '无法在 Chrome 内部页面（如 chrome:// 开头的页面）抓取图片，请在正常网页（如 Unsplash、GitHub、电商等）上点击插件图标。'
    };
    await chrome.storage.local.set({
      [`collectorTask_${taskId}`]: restrictedTask,
      latestTaskId: taskId,
      currentCollectorTask: restrictedTask
    });
    chrome.tabs.create({ url: chrome.runtime.getURL(`gallery.html?taskId=${taskId}`) });
    return;
  }

  // 3. 立即创建处于 loading 状态的初始任务并暂存
  const initialTask = {
    taskId: taskId,
    sourceTabId: tab.id,
    pageUrl: tab.url || '',
    pageTitle: tab.title || 'Untitled Page',
    status: 'loading',
    images: [],
    createdAt: Date.now(),
    error: null,
    warning: null
  };

  await chrome.storage.local.set({
    [`collectorTask_${taskId}`]: initialTask,
    latestTaskId: taskId,
    currentCollectorTask: initialTask
  });

  // 4. 【立即打开画廊标签页，绝不等待扫描结束】
  chrome.tabs.create({
    url: chrome.runtime.getURL(`gallery.html?taskId=${taskId}`)
  });

  // 5. 后台异步执行图片扫描
  executeSniffForTask(taskId, tab);
});

// 监听来自画廊的重试请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return false;

  if (request.action === 'RETRY_COLLECT_TASK' && request.taskId) {
    (async () => {
      try {
        const key = `collectorTask_${request.taskId}`;
        const res = await chrome.storage.local.get([key]);
        const existingTask = res ? res[key] : null;

        if (existingTask && existingTask.sourceTabId) {
          // 重新标记为 loading 状态
          existingTask.status = 'loading';
          existingTask.error = null;
          await chrome.storage.local.set({ [key]: existingTask });

          chrome.runtime.sendMessage({
            action: 'COLLECTOR_TASK_UPDATED',
            taskId: request.taskId,
            status: 'loading'
          }).catch(() => {});

          // 重新发起嗅探
          executeSniffForTask(request.taskId, {
            id: existingTask.sourceTabId,
            url: existingTask.pageUrl,
            title: existingTask.pageTitle
          });

          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: '未找到对应任务的来源标签页' });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // 保持异步
  }

  return false;
});

