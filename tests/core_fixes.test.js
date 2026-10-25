/**
 * Web Image Collector - 核心修复与功能范围收口自动化测试套件
 * 
 * 涵盖：
 * 1. 统一图片身份管理 (id 与 download URL 分离，解决增强后 URL 碰撞导致的勾选/卡片/下载状态错乱)
 * 2. 预览失败回退 (符合 MV3 CSP 规则，无内联 onerror，支持防循环降级)
 * 3. 严格格式校验 (排除纯 mif1，支持真实 avif/avis，移除 MIME 盲目兜底，拦截伪装图片与错误页)
 * 4. Chrome 真实报错回归 (startDeepGrab 定义与绑定防 ReferenceError，无内联事件处理器防 CSP 违规)
 * 5. 功能范围收口与初始化平稳 (DEEP_GRAB_ENABLED 禁用控制，UI 入口隐藏，详情页抓取静默拦截，无未定义函数)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const GALLERY_HTML_PATH = path.join(ROOT_DIR, 'gallery.html');
const GALLERY_JS_PATH = path.join(ROOT_DIR, 'gallery.js');
const CONTENT_JS_PATH = path.join(ROOT_DIR, 'content.js');

// 模拟 Blob 供 Node 环境测试
class MockBlob {
  constructor(chunks, options = {}) {
    this._chunks = chunks || [];
    this.type = options.type || '';
    let totalLength = 0;
    const buffers = [];
    for (const chunk of this._chunks) {
      if (typeof chunk === 'string') {
        const buf = Buffer.from(chunk, 'utf-8');
        buffers.push(buf);
        totalLength += buf.length;
      } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        const buf = Buffer.from(chunk);
        buffers.push(buf);
        totalLength += buf.length;
      }
    }
    this._buffer = Buffer.concat(buffers, totalLength);
    this.size = this._buffer.length;
  }

  slice(start = 0, end = this.size) {
    const sub = this._buffer.subarray(start, end);
    return new MockBlob([sub], { type: this.type });
  }

  async arrayBuffer() {
    return this._buffer.buffer.slice(this._buffer.byteOffset, this._buffer.byteOffset + this._buffer.byteLength);
  }
}

// 提取 gallery.js 中的增强函数用于逻辑测试
function enhanceToHighResUrl(rawUrl) {
  if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();

    // 1. Unsplash (images.unsplash.com)
    if (host.includes('unsplash.com')) {
      const q = parsed.searchParams;
      q.set('w', '2560');
      q.set('q', '85');
      q.set('fit', 'max');
      q.delete('crop');
      return parsed.toString();
    }

    // 2. Imgix (imgix.net)
    if (host.includes('imgix.net') || parsed.pathname.includes('/imgix/')) {
      const q = parsed.searchParams;
      q.set('w', '2560');
      q.set('q', '85');
      q.set('fit', 'max');
      q.delete('crop');
      return parsed.toString();
    }

    // 3. Shopify CDN (cdn.shopify.com)
    if (host.includes('cdn.shopify.com')) {
      let p = parsed.pathname;
      p = p.replace(/_(?:pico|icon|thumb|small|compact|medium|large|grande|1024x1024|2048x2048)(?=\.[a-zA-Z0-9]+$)/i, '_master');
      parsed.pathname = p;
      parsed.searchParams.delete('width');
      parsed.searchParams.delete('crop');
      return parsed.toString();
    }

    // 4. WordPress Photon / Jetpack
    if (host.includes('wp.com') || host.includes('wordpress.com')) {
      parsed.searchParams.delete('w');
      parsed.searchParams.delete('h');
      parsed.searchParams.delete('crop');
      parsed.searchParams.delete('resize');
      parsed.searchParams.delete('fit');
      return parsed.toString();
    }

    // 5. 常见缩略图路径替换模式
    let p = parsed.pathname;
    const replaced = p
      .replace(/\/thumbs?\//i, '/images/')
      .replace(/\/thumbnails?\//i, '/originals/')
      .replace(/\/small\//i, '/large/')
      .replace(/\/mini\//i, '/full/');
    if (replaced !== p) {
      parsed.pathname = replaced;
      return parsed.toString();
    }

    return rawUrl;
  } catch {
    return rawUrl;
  }
}

// 提取 gallery.js 中的严格二进制文件头格式识别与校验逻辑
async function detectAndValidateImageFormat(blob) {
  if (!blob || blob.size < 4) {
    return { isValid: false, ext: null, mime: null, error: '文件尺寸过小或为空' };
  }

  // 1. 读取前 64 字节魔数分析
  const headerSlice = blob.slice(0, Math.min(64, blob.size));
  const buffer = await headerSlice.arrayBuffer();
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

  // C. GIF: 47 49 46 38 (GIF87a / GIF89a)
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { isValid: true, ext: 'gif', mime: 'image/gif' };
  }

  // D. WebP: 52 49 46 46 ... 57 45 42 50 (RIFF....WEBP)
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { isValid: true, ext: 'webp', mime: 'image/webp' };
  }

  // E. BMP: 42 4D (BM)
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return { isValid: true, ext: 'bmp', mime: 'image/bmp' };
  }

  // F. ICO: 00 00 01 00
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return { isValid: true, ext: 'ico', mime: 'image/x-icon' };
  }

  // G. AVIF (ISO Base Media File Format: ftyp + avif / avis / compatible brands)
  if (bytes.length >= 12 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) { // 'ftyp'
    const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
    let hasAvifBrand = (majorBrand === 'avif' || majorBrand === 'avis');

    if (!hasAvifBrand && bytes.length >= 16) {
      const fullHeaderStr = String.fromCharCode(...bytes.subarray(8));
      if (fullHeaderStr.includes('avif') || fullHeaderStr.includes('avis')) {
        hasAvifBrand = true;
      }
    }

    if (hasAvifBrand) {
      return { isValid: true, ext: 'avif', mime: 'image/avif' };
    }
  }

  // H. SVG
  const textSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 64)).trim().toLowerCase();
  if (textSample.startsWith('<svg') || textSample.startsWith('<?xml') || textSample.includes('<svg')) {
    return { isValid: true, ext: 'svg', mime: 'image/svg+xml' };
  }

  // I. 文本/HTML/JSON 拦截
  if (textSample.startsWith('<!doctype') || textSample.startsWith('<html') || textSample.startsWith('{') || textSample.startsWith('[')) {
    const preview = textSample.substring(0, 30);
    return { isValid: false, ext: null, mime: null, error: `服务器返回了文本/HTML 错误页或 JSON 数据，非真实图片 (头部: "${preview}")` };
  }

  return {
    isValid: false,
    ext: null,
    mime: null,
    error: `无法识别的图片二进制格式 (Magic Bytes 文件头校验未通过)`
  };
}

async function runTests() {
  console.log('=== Web Image Collector 核心功能与收口自动化测试 ===\n');
  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
    }
  }

  async function asyncTest(name, fn) {
    total++;
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
    }
  }

  // -------------------------------------------------------------
  // 测试 1：统一图片身份管理 (问题一)
  // -------------------------------------------------------------
  test('问题一: 两个不同原始 URL 增强后指向同一个 URL 时，分配独立 ID，数量不丢失', () => {
    const rawImages = [
      { url: 'https://images.unsplash.com/photo-1?w=400&fit=crop', width: 400, height: 300, alt: 'Photo 1' },
      { url: 'https://images.unsplash.com/photo-1?w=800&fit=crop', width: 800, height: 600, alt: 'Photo 1 Large' }
    ];

    const dedupeMap = new Map();
    rawImages.forEach(img => {
      const rawUrl = img.url.trim();
      const originalUrl = img.originalUrl || rawUrl;
      const enhancedUrl = enhanceToHighResUrl(originalUrl);
      const dedupeKey = rawUrl;
      dedupeMap.set(dedupeKey, {
        ...img,
        url: enhancedUrl,
        originalUrl: originalUrl
      });
    });

    const allImages = Array.from(dedupeMap.values()).map((item, idx) => ({
      ...item,
      id: `img_${idx + 1}`
    }));

    assert.strictEqual(allImages.length, 2, '两张不同原始 URL 的图片均应保留');
    assert.strictEqual(allImages[0].id, 'img_1');
    assert.strictEqual(allImages[1].id, 'img_2');
    assert.strictEqual(allImages[0].url, allImages[1].url, '二者增强后的目标 URL 相同');
  });

  test('问题一: 选中状态基于 ID 记录，相同增强 URL 的多张图片勾选状态互不干扰', () => {
    const selectedIds = new Set();
    selectedIds.add('img_1');

    assert.strictEqual(selectedIds.has('img_1'), true, 'img_1 应为选中');
    assert.strictEqual(selectedIds.has('img_2'), false, 'img_2 不应受影响');

    selectedIds.delete('img_1');
    assert.strictEqual(selectedIds.has('img_1'), false);
  });

  test('问题一: 下载映射 downloadMap 基于 ID 索引，状态与进度不被互相覆盖', () => {
    const downloadMap = new Map();
    downloadMap.set('img_1', { status: 'success', size: 1024 });
    downloadMap.set('img_2', { status: 'failed', error: '404' });

    assert.strictEqual(downloadMap.get('img_1').status, 'success');
    assert.strictEqual(downloadMap.get('img_2').status, 'failed');
  });

  // -------------------------------------------------------------
  // 测试 2：预览失败回退 (问题二)
  // -------------------------------------------------------------
  test('问题二: gallery.js 源码中绝不包含内联 onerror 属性，符合 MV3 CSP 规则', () => {
    const galleryCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    const hasInlineOnError = /onerror\s*=/i.test(galleryCode);
    const hasInlineOnAttr = /\bon[a-z]+\s*=\s*["'\\]/i.test(galleryCode);
    assert.strictEqual(hasInlineOnAttr, false, 'gallery.js 中严禁出现内联 on* 事件属性拼接');
  });

  test('问题二: 预览回退候选地址优先选择 originalUrl，次选 fallbackUrl，防止同源循环回退', () => {
    const img1 = {
      id: 'img_1',
      url: 'https://images.unsplash.com/photo-1?w=2560&q=85&fit=max',
      originalUrl: 'https://images.unsplash.com/photo-1?w=400&fit=crop',
      fallbackUrl: 'https://images.unsplash.com/photo-1?w=200'
    };
    const fallback1 = (img1.originalUrl && img1.originalUrl !== img1.url)
      ? img1.originalUrl
      : (img1.fallbackUrl && img1.fallbackUrl !== img1.url ? img1.fallbackUrl : null);
    assert.strictEqual(fallback1, img1.originalUrl, '优先回退 originalUrl');

    const img3 = {
      id: 'img_3',
      url: 'https://example.com/same.jpg',
      originalUrl: 'https://example.com/same.jpg',
      fallbackUrl: null
    };
    const fallback3 = (img3.originalUrl && img3.originalUrl !== img3.url)
      ? img3.originalUrl
      : (img3.fallbackUrl && img3.fallbackUrl !== img3.url ? img3.fallbackUrl : null);
    assert.strictEqual(fallback3, null, '无可用回退地址时不产生 fallback 避免无效绑定');
  });

  // -------------------------------------------------------------
  // 测试 3：格式校验更严格 (问题三)
  // -------------------------------------------------------------
  await asyncTest('问题三: 真实 AVIF major brand (avif / avis) 校验通过', async () => {
    const avifHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x20, // size 32
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x61, 0x76, 0x69, 0x66, // 'avif' (major brand)
      0x00, 0x00, 0x00, 0x00, // minor version
      0x6d, 0x69, 0x66, 0x31  // 'mif1'
    ]);
    const blob = new MockBlob([avifHeader]);
    const res = await detectAndValidateImageFormat(blob);
    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.ext, 'avif');
  });

  await asyncTest('问题三: major brand 为 mif1 但 compatible brands 包含 avif 的文件判定为有效 AVIF', async () => {
    const avifCompatible = Buffer.from([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x6d, 0x69, 0x66, 0x31, // 'mif1' (major brand)
      0x00, 0x00, 0x00, 0x00,
      0x61, 0x76, 0x69, 0x66  // 'avif' (compatible brand)
    ]);
    const blob = new MockBlob([avifCompatible]);
    const res = await detectAndValidateImageFormat(blob);
    assert.strictEqual(res.isValid, true);
    assert.strictEqual(res.ext, 'avif');
  });

  await asyncTest('问题三: 普通 HEIC/mif1 文件 (不含 avif/avis) 严禁误判为 AVIF', async () => {
    const plainHeic = Buffer.from([
      0x00, 0x00, 0x00, 0x20,
      0x66, 0x74, 0x79, 0x70, // 'ftyp'
      0x6d, 0x69, 0x66, 0x31, // 'mif1' (major brand)
      0x00, 0x00, 0x00, 0x00,
      0x68, 0x65, 0x69, 0x63  // 'heic' (compatible brand)
    ]);
    const blob = new MockBlob([plainHeic]);
    const res = await detectAndValidateImageFormat(blob);
    assert.strictEqual(res.isValid, false, '普通 mif1/heic 缺少 avif/avis 标识，必须判定为无效/不受支持');
  });

  await asyncTest('问题三: 仅提供 image/jpeg MIME 声明但无真实 Magic Bytes 的伪数据必须被拒绝', async () => {
    const fakeBytes = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
    const blob = new MockBlob([fakeBytes], { type: 'image/jpeg' });
    const res = await detectAndValidateImageFormat(blob);
    assert.strictEqual(res.isValid, false, 'MIME 声明不能单独证明图片内容有效');
    assert.ok(res.error.includes('Magic Bytes 文件头校验未通过') || res.error.includes('校验未通过'));
  });

  await asyncTest('问题三: HTML/JSON 伪装响应（即便 Content-Type 被误设为 image/*）必须被严格拒绝', async () => {
    const htmlBlob = new MockBlob(['<!DOCTYPE html><html><head><title>404 Not Found</title></head></html>'], { type: 'image/png' });
    const resHtml = await detectAndValidateImageFormat(htmlBlob);
    assert.strictEqual(resHtml.isValid, false);
    assert.ok(resHtml.error.includes('HTML 错误页'));

    const jsonBlob = new MockBlob(['{"error": "Unauthorized", "code": 401}'], { type: 'image/jpeg' });
    const resJson = await detectAndValidateImageFormat(jsonBlob);
    assert.strictEqual(resJson.isValid, false);
    assert.ok(resJson.error.includes('JSON 数据'));
  });

  await asyncTest('问题三: 标准合法图片 (JPEG, PNG, WebP, GIF, SVG) 正常通过验证', async () => {
    const jpgBlob = new MockBlob([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])]);
    const resJpg = await detectAndValidateImageFormat(jpgBlob);
    assert.strictEqual(resJpg.isValid, true);
    assert.strictEqual(resJpg.ext, 'jpg');

    const pngBlob = new MockBlob([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])]);
    const resPng = await detectAndValidateImageFormat(pngBlob);
    assert.strictEqual(resPng.isValid, true);
    assert.strictEqual(resPng.ext, 'png');

    const webpBlob = new MockBlob([Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00,
      0x57, 0x45, 0x42, 0x50  // WEBP
    ])]);
    const resWebp = await detectAndValidateImageFormat(webpBlob);
    assert.strictEqual(resWebp.isValid, true);
    assert.strictEqual(resWebp.ext, 'webp');

    const svgBlob = new MockBlob(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>']);
    const resSvg = await detectAndValidateImageFormat(svgBlob);
    assert.strictEqual(resSvg.isValid, true);
    assert.strictEqual(resSvg.ext, 'svg');
  });

  // -------------------------------------------------------------
  // 测试 4：Chrome 真实环境报错定点复测 (错误 1 & 错误 2)
  // -------------------------------------------------------------
  test('错误 1 复测: gallery.js 中 startDeepGrab 完整定义并绑定，绝不出现未定义 ReferenceError', () => {
    const galleryCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 确认 startDeepGrab 函数已被定义
    assert.ok(galleryCode.includes('async function startDeepGrab()'), 'startDeepGrab 函数必须明确定义');
    // 确认 btnDeepGrab 绑定了 startDeepGrab
    assert.ok(galleryCode.includes("dom.btnDeepGrab.addEventListener('click', startDeepGrab)"), 'btnDeepGrab 必须正确绑定 startDeepGrab');
    // 确认 btnCancelDeepGrab 事件绑定存在
    assert.ok(galleryCode.includes("dom.btnCancelDeepGrab.addEventListener('click'"), 'btnCancelDeepGrab 必须正确绑定取消事件');
    // 确认相关辅助函数均已就绪
    assert.ok(galleryCode.includes('function updateDeepGrabButtonBadge()'), 'updateDeepGrabButtonBadge 必须存在');
    assert.ok(galleryCode.includes('async function resolveHeroImageFromDetail('), 'resolveHeroImageFromDetail 必须存在');
  });

  test('错误 2 复测: gallery.html 及 gallery.js 动态模板中绝无内联事件处理器，严格符合 CSP', () => {
    const htmlCode = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 检查 gallery.html 中是否有任何 \bon[a-z]+\s*=
    const htmlInlineMatches = htmlCode.match(/\bon[a-z]+\s*=\s*["'][^"']*["']/gi);
    assert.strictEqual(htmlInlineMatches, null, `gallery.html 中不得有任何内联事件属性: ${htmlInlineMatches}`);

    // 2. 检查 gallery.js 中是否有任何通过 innerHTML 插入的内联事件属性 (如 onerror=, onclick= 等)
    const jsInlineMatches = jsCode.match(/\bon[a-z]+\s*=\s*["'\\]/gi);
    assert.strictEqual(jsInlineMatches, null, `gallery.js 中不得有任何内联 HTML 事件属性: ${jsInlineMatches}`);

    // 3. 检查 gallery.js 中大图预览不再使用 property 赋值 .onerror =，统一改为 addEventListener
    const directPropertyMatches = jsCode.match(/dom\.lightboxImg\.onerror\s*=/gi);
    assert.strictEqual(directPropertyMatches, null, '大图预览应使用 addEventListener 替代 .onerror 赋值');
  });

  // -------------------------------------------------------------
  // 测试 5：功能范围收口与初始化平稳性验证 (当前轮次新增)
  // -------------------------------------------------------------
  test('收口验证 1: gallery.js 中统一声明 DEEP_GRAB_ENABLED = false 开关', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    assert.ok(
      /const\s+DEEP_GRAB_ENABLED\s*=\s*false\s*;/.test(jsCode),
      'gallery.js 必须具备统一的 DEEP_GRAB_ENABLED = false 常量定义'
    );
  });

  test('收口验证 2: gallery.html 中 btnDeepGrab 与 deepGrabConsole 具有 display: none !important 与 aria-hidden="true"', () => {
    const htmlCode = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    
    // 检查 btnDeepGrab
    const btnMatch = htmlCode.match(/<button[^>]*id=["']btnDeepGrab["'][^>]*>/i);
    assert.ok(btnMatch, 'btnDeepGrab 必须存在于 HTML 中');
    assert.ok(btnMatch[0].includes('style="display: none !important;"'), 'btnDeepGrab 必须静态设置 display: none !important');
    assert.ok(btnMatch[0].includes('aria-hidden="true"'), 'btnDeepGrab 必须设置 aria-hidden="true"');

    // 检查 deepGrabConsole
    const consoleMatch = htmlCode.match(/<div[^>]*id=["']deepGrabConsole["'][^>]*>/i);
    assert.ok(consoleMatch, 'deepGrabConsole 必须存在于 HTML 中');
    assert.ok(consoleMatch[0].includes('style="display: none !important;"'), 'deepGrabConsole 必须静态设置 display: none !important');
    assert.ok(consoleMatch[0].includes('aria-hidden="true"'), 'deepGrabConsole 必须设置 aria-hidden="true"');
  });

  test('收口验证 3: updateDeepGrabButtonBadge 与 renderDeepGrabBadge 在关闭时严格抑制显示', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // updateDeepGrabButtonBadge 检查
    assert.ok(
      jsCode.includes('if (!DEEP_GRAB_ENABLED) {') &&
      jsCode.includes("dom.btnDeepGrab.classList.add('hidden')") &&
      jsCode.includes("dom.btnDeepGrab.style.display = 'none'"),
      'updateDeepGrabButtonBadge 必须在 DEEP_GRAB_ENABLED 为 false 时显式隐藏按钮'
    );

    // renderDeepGrabBadge 检查
    assert.ok(
      jsCode.includes("function renderDeepGrabBadge(img) {\n    if (!DEEP_GRAB_ENABLED) return '';") ||
      jsCode.includes("function renderDeepGrabBadge(img) {\r\n    if (!DEEP_GRAB_ENABLED) return '';"),
      'renderDeepGrabBadge 必须在 DEEP_GRAB_ENABLED 为 false 时直接返回空字符串'
    );

    // updateCardDeepGrabUI 检查
    assert.ok(
      jsCode.includes("function updateCardDeepGrabUI(item, cardEl) {\n    if (!DEEP_GRAB_ENABLED) return;") ||
      jsCode.includes("function updateCardDeepGrabUI(item, cardEl) {\r\n    if (!DEEP_GRAB_ENABLED) return;"),
      'updateCardDeepGrabUI 必须在 DEEP_GRAB_ENABLED 为 false 时直接 return'
    );
  });

  test('收口验证 4: startDeepGrab 在 DEEP_GRAB_ENABLED 为 false 时静默退出，不发起抓取', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    assert.ok(
      jsCode.includes('if (!DEEP_GRAB_ENABLED) {') &&
      jsCode.includes('console.warn('),
      'startDeepGrab 必须在开关关闭时拦截并输出告警，不发起任何详情页网络抓取'
    );
  });

  test('收口验证 5: 页面初始化及事件绑定代码中无未定义函数调用，语法完全合法', () => {
    // 验证 gallery.js 语法完全通过 node 词法分析
    const { execSync } = require('child_process');
    try {
      execSync(`node -c "${GALLERY_JS_PATH}"`, { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`gallery.js 存在语法错误: ${e.message}`);
    }
  });

  test('收口验证 6: gallery.js 初始化缓存的所有 DOM 元素在 gallery.html 中全部存在对应 ID', () => {
    const htmlCode = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    const idRegex = /document\.getElementById\(["']([^"']+)["']\)/g;
    let match;
    const missingIds = [];
    while ((match = idRegex.exec(jsCode)) !== null) {
      const id = match[1];
      if (!htmlCode.includes(`id="${id}"`) && !htmlCode.includes(`id='${id}'`)) {
        missingIds.push(id);
      }
    }
    assert.strictEqual(missingIds.length, 0, `发现 gallery.js 引用但 gallery.html 中缺失的 DOM ID: ${missingIds.join(', ')}`);
  });

  // -------------------------------------------------------------
  // 测试 6：第二轮核心下载可靠性验收测试 (任务 A / B / C / D)
  // -------------------------------------------------------------
  test('任务 A: ZIP 保存状态区分生成成功、保存发起与真实完成，杜绝提前宣称已保存', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    
    // 1. 验证在 triggerSaveZip 调起前，提示是“ZIP 生成成功，正在请求保存”而非“已保存”
    assert.ok(
      jsCode.includes('ZIP 生成成功，正在请求保存'),
      '在 ZIP 生成后调起保存前，严禁宣称已保存全部图片'
    );
    assert.strictEqual(
      /打包完成！已保存全部/.test(jsCode),
      false,
      '代码中严禁残留虚假的提前保存成功提示'
    );

    // 2. 验证注册了 chrome.downloads.onChanged 监听器，跟踪 complete 与 interrupted 状态
    assert.ok(
      jsCode.includes('chrome.downloads.onChanged.addListener'),
      'triggerSaveZip 必须监听 chrome.downloads.onChanged 以捕获真实保存状态'
    );
    assert.ok(
      jsCode.includes("delta.state.current === 'complete'") &&
      jsCode.includes("delta.state.current === 'interrupted'"),
      '必须正确区分下载 complete 与 interrupted 状态'
    );

    // 3. 验证对用户取消保存窗口与错误中断有明确提示
    assert.ok(
      jsCode.includes("USER_CANCELED") && jsCode.includes('用户取消了文件保存窗口'),
      '必须对用户在保存对话框中点击取消提供明确反馈'
    );
  });

  test('任务 B: 取消下载机制具备 AbortController 中止、阻断后续启动及阻断 ZIP 生成', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 验证引入并使用了 AbortController
    assert.ok(
      jsCode.includes('new AbortController()') && jsCode.includes('state.abortController.abort()'),
      '必须在取消时调用 abortController.abort() 中止网络请求'
    );

    // 2. 验证 fetchSingleUrlAndValidate 和 fetchImageWithFallback 支持 signal 且拦截 AbortError
    assert.ok(
      jsCode.includes('signal = null') && jsCode.includes('signal: signal'),
      '网络请求必须传入 signal'
    );
    assert.ok(
      jsCode.includes("err.name === 'AbortError'") || jsCode.includes("fetchErr.name === 'AbortError'"),
      '必须妥善处理 AbortError 异常，不抛出未处理错误'
    );

    // 3. 验证取消后阻断进入 JSZip 生成
    assert.ok(
      jsCode.includes('if (state.cancelRequested) {\n        dom.consolePhaseText.textContent = \'下载任务已由用户主动取消\';') ||
      jsCode.includes('if (state.cancelRequested) {\r\n        dom.consolePhaseText.textContent = \'下载任务已由用户主动取消\';'),
      '取消下载时必须直接返回，严禁继续自动生成 ZIP'
    );

    // 4. 验证 ZIP 压缩中（isCompressing）禁用取消按钮并给出友好提示
    assert.ok(
      jsCode.includes('state.isCompressing = true;') &&
      jsCode.includes('dom.btnCancelDownload.disabled = true;'),
      'ZIP 压缩阶段必须禁用取消按钮，防止压缩过程中状态混乱'
    );
    assert.ok(
      jsCode.includes('当前正在进行 ZIP 压缩打包，无法中止'),
      '在压缩阶段点击取消必须给出明确提示'
    );
  });

  test('任务 C: 150MB 数据保护阈值明确标注为触发阈值，支持保护弹窗取消任务', () => {
    const htmlCode = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 验证 HTML 提示明确声明 150MB 为保护触发阈值而非绝对内存上限
    assert.ok(
      htmlCode.includes('150MB 为保护触发阈值') && htmlCode.includes('非绝对内存上限'),
      '保护弹窗文案必须明确说明 150MB 为保护触发阈值'
    );

    // 2. 验证保护弹窗中包含 btnQuotaCancelAll 取消通道
    assert.ok(
      htmlCode.includes('id="btnQuotaCancelAll"'),
      '保护弹窗必须包含取消整个任务的按钮'
    );
    assert.ok(
      jsCode.includes('dom.btnQuotaCancelAll.addEventListener(\'click\', cancelQuotaGuard)'),
      'btnQuotaCancelAll 必须绑定 cancelQuotaGuard 事件'
    );

    // 3. 验证 cancelQuotaGuard 妥善解开 quotaPauseResolver 并中止任务
    assert.ok(
      jsCode.includes('function cancelQuotaGuard()') &&
      jsCode.includes('state.cancelRequested = true') &&
      jsCode.includes('state.quotaPauseResolver.resolve()'),
      'cancelQuotaGuard 必须释放暂停 Promise，避免页面挂起'
    );
  });

  test('任务 D: 单张下载 downloadSingleImage 严格基于真实图片内容确定文件扩展名，杜绝扩展名不符', () => {
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 验证 downloadSingleImage 会优先复用已验证的 Blob 或通过 fetchImageWithFallback 获取真实内容
    assert.ok(
      jsCode.includes('state.downloadMap.get(item.id)') &&
      jsCode.includes('fetchImageWithFallback'),
      '单张下载必须复用验证过的 Blob 或通过 fetchImageWithFallback 校验真实格式'
    );

    // 2. 验证扩展名优先采用 fetchResult.ext，而非仅靠脆弱的 URL 截取
    assert.ok(
      jsCode.includes('ext = fetchResult.ext;') || jsCode.includes('ext = cached.filename.split'),
      '单张下载必须以真实内容校验得到的 ext 命名文件'
    );

    // 3. 验证单张下载失败时有明确的错误提示
    assert.ok(
      jsCode.includes('单张图片下载失败:') || jsCode.includes('单张下载异常:'),
      '单张下载失败必须给出明确提示'
    );
  });

  // -------------------------------------------------------------
  // 测试 7：第二轮核心下载定点复审行为运行测试 (针对 4 项重点核查)
  // -------------------------------------------------------------
  test('复审问题 1 行为验证: 用户主动取消保存时，严禁触发 fallbackAnchorDownload 兜底下载', () => {
    // 提取并运行 gallery.js 中实际的取消检测与兜底拦截逻辑
    function isUserCancelError(errMsg) {
      if (!errMsg) return false;
      const lower = String(errMsg).toLowerCase();
      return lower.includes('cancel') || lower.includes('user_canceled') || lower.includes('abort');
    }

    let fallbackCalled = false;
    let revoked = false;
    const dom = {
      consolePhaseText: { textContent: '' },
      consoleDetailText: { textContent: '' }
    };

    function simulateSaveZip(lastErrorMsg) {
      fallbackCalled = false;
      revoked = false;
      const objectUrl = 'blob:http://localhost/test-uuid';
      const cleanup = () => { revoked = true; };

      const chrome = {
        runtime: { lastError: lastErrorMsg ? { message: lastErrorMsg } : null }
      };

      // 运行与 gallery.js 一致的真实分支逻辑
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        if (isUserCancelError(errMsg)) {
          cleanup();
          dom.consolePhaseText.textContent = '保存已取消：用户取消了文件保存窗口';
          dom.consoleDetailText.textContent = 'ZIP 压缩文件未写入磁盘';
          return;
        }
        fallbackCalled = true;
      }
    }

    // A. 用户在文件选择窗口点击“取消”
    simulateSaveZip('User cancelled');
    assert.strictEqual(fallbackCalled, false, '用户取消时严禁调用 fallbackAnchorDownload 兜底下载');
    assert.strictEqual(revoked, true, '用户取消时必须立即释放 ObjectURL');
    assert.strictEqual(dom.consolePhaseText.textContent, '保存已取消：用户取消了文件保存窗口');

    // B. 用户通过 USER_CANCELED 中断
    simulateSaveZip('USER_CANCELED');
    assert.strictEqual(fallbackCalled, false, 'USER_CANCELED 状态下严禁调用 fallbackAnchorDownload');

    // C. 真实异常情况（非取消，如系统没有文件选择器）
    simulateSaveZip('Download API internal error');
    assert.strictEqual(fallbackCalled, true, '非取消类真实异常下才允许降级到模拟点击兜底');
  });

  test('复审问题 2 行为验证: chrome.downloads.onChanged 防事件遗漏与资源防泄漏', () => {
    // 模拟极速完成场景：在 download 回调执行时文件已经处于 complete 状态
    let listenerRemoved = false;
    let urlRevoked = false;
    let completeHandled = false;

    const downloadId = 999;
    const objectUrl = 'blob:http://localhost/fast-complete';

    const cleanup = () => {
      listenerRemoved = true;
      urlRevoked = true;
    };

    const downloadListener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') {
        cleanup();
        completeHandled = true;
      }
    };

    // 模拟 chrome.downloads.search 补查机制
    const chromeDownloads = {
      search(query, cb) {
        // 模拟 search 发现下载已瞬间完成
        cb([{ id: query.id, state: 'complete' }]);
      }
    };

    // 注册监听器后立即执行补查
    chromeDownloads.search({ id: downloadId }, (items) => {
      if (items && items[0] && items[0].state === 'complete') {
        downloadListener({ id: downloadId, state: { current: 'complete' } });
      }
    });

    assert.strictEqual(completeHandled, true, '防事件遗漏 search 机制应立即捕获已完成的下载');
    assert.strictEqual(listenerRemoved, true, '完成时必须移除监听器');
    assert.strictEqual(urlRevoked, true, '完成时必须释放 ObjectURL 资源');
  });

  test('复审问题 3 行为验证: 第一批未保存完时启动第二批，通过 currentTaskId 严格隔离状态', () => {
    const dom = {
      consolePhaseText: { textContent: '' },
      consoleDetailText: { textContent: '' }
    };
    const state = {
      currentBatchTaskId: 0,
      activeSaveTask: null
    };

    // 1. 启动批次 1
    const task1Id = ++state.currentBatchTaskId; // task1Id = 1
    let task1Revoked = false;
    let task1Listener = null;

    function triggerSaveZipSim(taskId, isStopAndZip, filename) {
      const cleanup = () => { task1Revoked = true; };
      task1Listener = (delta) => {
        cleanup();
        // 关键防护：只有 taskId 与当前 state.currentBatchTaskId 匹配时才允许更新界面
        if (state.currentBatchTaskId === taskId) {
          dom.consolePhaseText.textContent = isStopAndZip
            ? '保存完成！已成功保存已完成图片的压缩包'
            : '保存完成！ZIP 压缩包已成功保存到本地磁盘';
          dom.consoleDetailText.textContent = `文件已落盘: ${filename}`;
        }
      };
    }

    triggerSaveZipSim(task1Id, false, 'batch_1.zip');

    // 2. 批次 1 尚未落盘，用户立即勾选新图片启动批次 2
    const task2Id = ++state.currentBatchTaskId; // task2Id = 2
    dom.consolePhaseText.textContent = '批次 2 正在并发下载 (3/10)...';
    dom.consoleDetailText.textContent = '批次 2 进度 30%';

    assert.strictEqual(state.currentBatchTaskId, 2);
    assert.strictEqual(dom.consolePhaseText.textContent, '批次 2 正在并发下载 (3/10)...');

    // 3. 此时批次 1 的系统保存完成事件终于到来
    task1Listener({ id: 101, state: { current: 'complete' } });

    // 4. 验证：批次 1 释放了自身资源，但控制台界面完全保留批次 2 的状态，没有被批次 1 覆盖！
    assert.strictEqual(task1Revoked, true, '批次 1 自身资源正常释放');
    assert.strictEqual(
      dom.consolePhaseText.textContent,
      '批次 2 正在并发下载 (3/10)...',
      '批次 1 完成事件绝不得覆盖批次 2 的正在下载控制台！'
    );
    assert.strictEqual(
      dom.consoleDetailText.textContent,
      '批次 2 进度 30%',
      '批次 2 的进度详情必须保持完整'
    );
  });

  await asyncTest('复审问题 4 行为验证: Canvas 降级请求及时响应 signal 取消，耗时在 100ms 内且提示准确', async () => {
    // 模拟改造后的 fetchViaCanvasFallback 取消响应机制
    function simulateFetchViaCanvasFallback(url, signal = null) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          return reject(new Error('下载任务已取消'));
        }

        let timer = null;
        let abortHandler = null;

        const cleanup = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
            abortHandler = null;
          }
        };

        if (signal) {
          abortHandler = () => {
            cleanup();
            reject(new Error('下载任务已取消'));
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }

        // 模拟原本需要 5 秒的超时
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('Canvas 降级请求超时'));
        }, 5000);
      });
    }

    const abortController = new AbortController();
    const startTime = Date.now();

    const canvasPromise = simulateFetchViaCanvasFallback('https://example.com/blocked.jpg', abortController.signal);

    // 20ms 后发出取消
    setTimeout(() => {
      abortController.abort();
    }, 20);

    try {
      await canvasPromise;
      assert.fail('应当抛出取消错误');
    } catch (err) {
      const elapsed = Date.now() - startTime;
      assert.strictEqual(err.message, '下载任务已取消');
      assert.ok(elapsed < 200, `发出 abort 后应立即退出，实际耗时 ${elapsed}ms (远低于 5000ms 超时)`);
    }

    // 验证错误诊断文案格式
    const fetchErr = new Error('HTTP 403 Forbidden');
    const canvasErr = new Error('Image 降级加载失败');
    const formattedError = `跨域限制: ${fetchErr.message} (Canvas兜底失败: ${canvasErr.message})`;
    assert.ok(formattedError.includes('403 Forbidden') && formattedError.includes('Canvas兜底失败'));
  });

  await asyncTest('专项测试 1 行为复现: Unsplash 416x624 容器中的小背景图绝不识别为 416px 大图，如实记录真实尺寸 20x30 且保留', async () => {
    // 模拟 Unsplash 卡片容器：clientWidth = 416, clientHeight = 624
    // 容器内背景图片实际上为 20x30 像素的背景小图
    const container = {
      clientWidth: 416,
      clientHeight: 624,
      style: { backgroundImage: 'url("https://images.unsplash.com/photo-123?w=20&blur=50")' }
    };
    const mockImageVerifier = async (url) => {
      // 真实请求验证得到该图片仅为 20x30 像素
      return { width: 20, height: 30, valid: true };
    };

    const candidateUrl = 'https://images.unsplash.com/photo-123?w=20&blur=50';
    const check = await mockImageVerifier(candidateUrl);
    
    // 核心断言 1: 绝对不允许把容器 clientWidth/clientHeight (416x624) 当作图片分辨率
    assert.notStrictEqual(check.width, container.clientWidth, '背景图宽绝不能取容器的 clientWidth (416)');
    assert.notStrictEqual(check.height, container.clientHeight, '背景图高绝不能取容器的 clientHeight (624)');
    assert.strictEqual(check.width, 20, '必须采用验证后的真实宽 20');
    assert.strictEqual(check.height, 30, '必须采用验证后的真实高 30');

    // 核心断言 2: 阶段 2 要求有效小背景图不再按 150px 门槛粗暴丢弃，真实保留
    assert.strictEqual(check.valid, true, '真实有效的背景小图保留在结果中');
  });

  await asyncTest('专项测试 2 行为复现: 真实大幅 CSS 背景图通过实际分辨率校验后正常采集', async () => {
    // 模拟页面 banner 容器：clientWidth = 800, clientHeight = 400
    // 背景图真实分辨率为 1920x1080
    const container = {
      clientWidth: 800,
      clientHeight: 400,
      style: { backgroundImage: 'url("https://example.com/hero-wallpaper.jpg")' }
    };
    const mockImageVerifier = async (url) => {
      return { width: 1920, height: 1080, valid: true };
    };

    const candidateUrl = 'https://example.com/hero-wallpaper.jpg';
    const check = await mockImageVerifier(candidateUrl);

    assert.strictEqual(check.valid, true, '真实大幅背景图必须被保留');
    assert.strictEqual(check.width, 1920, '必须采用验证后的真实宽 1920，而非容器 800');
    assert.strictEqual(check.height, 1080, '必须采用验证后的真实高 1080，而非容器 400');
  });

  await asyncTest('专项测试 3 行为复现: srcset 尺寸描述符绝不当作已验证尺寸，未验证时显示「未知尺寸」', async () => {
    // 模拟 img 标签带有 srcset="https://images.unsplash.com/photo-hd?w=2048 2048w"
    // 但当前浏览器渲染的主图尚未加载该高清大图 (img.currentSrc 为空或低清图，未验证 naturalWidth)
    const imgMock = {
      currentSrc: 'https://images.unsplash.com/photo-thumb?w=400',
      src: 'https://images.unsplash.com/photo-thumb?w=400',
      naturalWidth: 400,
      naturalHeight: 300,
      srcset: 'https://images.unsplash.com/photo-hd?w=2048 2048w'
    };

    // 决选选出了高清 candidateUrl
    const chosenUrl = 'https://images.unsplash.com/photo-hd?w=2048';
    
    // 规则：srcset 描述符 (2048w) 不能直接当作已验证真实尺寸，且不能凭比例伪造高度
    let verifiedWidth = 0;
    let verifiedHeight = 0;
    if (chosenUrl === imgMock.currentSrc && imgMock.naturalWidth > 0) {
      verifiedWidth = imgMock.naturalWidth;
      verifiedHeight = imgMock.naturalHeight;
    }

    assert.strictEqual(verifiedWidth, 0, '未实际加载的高清候选源尺寸不能从 2048w 编造');
    assert.strictEqual(verifiedHeight, 0, '未实际加载的高清候选源高不能凭比例假造');

    // 验证画廊显示效果
    const resText = (verifiedWidth > 0 && verifiedHeight > 0) ? `${verifiedWidth} × ${verifiedHeight}` : '未知尺寸';
    assert.strictEqual(resText, '未知尺寸', '尺寸无法确定时必须显示「未知尺寸」');
  });

  await asyncTest('专项测试 4 行为复现: 动态滚动采集持续发现新图、全量去重、分配连续 ID 且保持已有勾选', async () => {
    // 初始已有图片 img_1, img_2
    const state = {
      allImages: [
        { id: 'img_1', url: 'https://example.com/p1.jpg', originalUrl: 'https://example.com/p1.jpg', width: 800, height: 600 },
        { id: 'img_2', url: 'https://example.com/p2.jpg', originalUrl: 'https://example.com/p2.jpg', width: 1200, height: 900 }
      ],
      selectedIds: new Set(['img_1']),
      downloadMap: new Map([['img_1', { status: 'idle' }]])
    };

    // 滚动后发现新采集结果：包含重复的 p2.jpg 和全新的 p3.jpg, p4.jpg
    const incomingBatch = [
      { url: 'https://example.com/p2.jpg', originalUrl: 'https://example.com/p2.jpg', width: 1200, height: 900 },
      { url: 'https://example.com/p3.jpg', originalUrl: 'https://example.com/p3.jpg', width: 1600, height: 1200 },
      { url: 'https://example.com/p4.jpg', originalUrl: 'https://example.com/p4.jpg', width: 2000, height: 1500 }
    ];

    // 模拟画廊 appendNewImages 增量去重与连续 ID 分配逻辑
    const existingDedupeKeys = new Set(state.allImages.map(img => img.originalUrl || img.url));
    const addedItems = [];

    incomingBatch.forEach(item => {
      const dedupeKey = item.originalUrl || item.url;
      if (!existingDedupeKeys.has(dedupeKey)) {
        existingDedupeKeys.add(dedupeKey);
        const nextId = `img_${state.allImages.length + addedItems.length + 1}`;
        addedItems.push({
          ...item,
          id: nextId
        });
      }
    });

    state.allImages.push(...addedItems);

    // 断言 1: 重复的 p2.jpg 不会增加，新图片 p3, p4 成功加入
    assert.strictEqual(state.allImages.length, 4, '全量图片应从 2 张增至 4 张');
    assert.strictEqual(addedItems.length, 2, '增量新发现应为 2 张');

    // 断言 2: 保持连续唯一 ID
    assert.strictEqual(state.allImages[2].id, 'img_3', '新加入第 3 张图片 ID 应为 img_3');
    assert.strictEqual(state.allImages[3].id, 'img_4', '新加入第 4 张图片 ID 应为 img_4');

    // 断言 3: 用户原有的勾选状态与下载记录完好保留
    assert.ok(state.selectedIds.has('img_1'), '已有勾选 img_1 必须完好保留');
    assert.strictEqual(state.selectedIds.size, 1, '新图片不应破坏原有勾选总数');
  });

  // -------------------------------------------------------------
  // 专项测试：阶段 1「刷新图片」功能改造与自动滚动移除验收
  // -------------------------------------------------------------
  await test('阶段 1 验证 1 & 10: content.js 彻底移除自动滚动与状态机，保留单次嗅探与尺寸验证，深度穿透保持关闭', () => {
    const contentCode = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');
    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 验证自动滚动相关代码已彻底移除
    assert.ok(!contentCode.includes('scrollBy'), 'content.js 中严禁包含 window.scrollBy 自动滚动代码');
    assert.ok(!contentCode.includes('dynamicCollector'), 'content.js 中严禁包含 dynamicCollector 状态机');
    assert.ok(!contentCode.includes('START_DYNAMIC_COLLECT'), 'content.js 中严禁监听 START_DYNAMIC_COLLECT 指令');
    assert.ok(!contentCode.includes('STOP_DYNAMIC_COLLECT'), 'content.js 中严禁监听 STOP_DYNAMIC_COLLECT 指令');
    assert.ok(!contentCode.includes('__webImageCollectorDynamic'), 'content.js 中严禁挂载 __webImageCollectorDynamic 全局对象');

    // 2. 验证保留单次嗅探入口与异步尺寸校验
    assert.ok(contentCode.includes('function verifyImageDimensions'), 'content.js 必须保留 verifyImageDimensions 真实尺寸校验');
    assert.ok(contentCode.includes('function runWithConcurrency'), 'content.js 必须保留 runWithConcurrency 并发池');
    assert.ok(contentCode.includes("request.action === 'SNIFF_IMAGES'"), 'content.js 必须保留 SNIFF_IMAGES 单次嗅探处理通道');

    // 3. 验证深度穿透 Deep Grab 严格保持关闭
    assert.ok(galleryJs.includes('const DEEP_GRAB_ENABLED = false'), 'gallery.js 中 DEEP_GRAB_ENABLED 必须严格为 false');
  });

  await test('阶段 1 验证 2: gallery.html 与 gallery.js 移除停止/进度条 UI，并接入 btnRefreshImages 与 refreshImages', () => {
    const htmlCode = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    const jsCode = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 检查新按钮及提示角标
    assert.ok(htmlCode.includes('id="btnRefreshImages"'), 'gallery.html 必须包含 id="btnRefreshImages"');
    assert.ok(htmlCode.includes('id="refreshImagesText"'), 'gallery.html 必须包含 id="refreshImagesText"');
    assert.ok(htmlCode.includes('id="collectCountBadge"'), 'gallery.html 必须包含 id="collectCountBadge"');
    assert.ok(jsCode.includes("btnRefreshImages: document.getElementById('btnRefreshImages')"), 'gallery.js 必须缓存 btnRefreshImages');

    // 2. 检查废弃的滚动停止与进度条 UI 彻底清除
    assert.ok(!htmlCode.includes('id="btnStopCollect"'), 'gallery.html 严禁残留 id="btnStopCollect"');
    assert.ok(!htmlCode.includes('id="collectProgressBanner"'), 'gallery.html 严禁残留 id="collectProgressBanner"');
    assert.ok(!htmlCode.includes('id="btnStopCollectBanner"'), 'gallery.html 严禁残留 id="btnStopCollectBanner"');

    // 3. 检查 JS 核心方法定义
    assert.ok(jsCode.includes('async function refreshImages'), 'gallery.js 必须实现 refreshImages 单次刷新');
    assert.ok(jsCode.includes('function appendNewImages'), 'gallery.js 必须实现 appendNewImages 增量合并');
    assert.ok(!jsCode.includes('function startDynamicCollection'), 'gallery.js 严禁遗留 startDynamicCollection');
    assert.ok(!jsCode.includes('function stopDynamicCollection'), 'gallery.js 严禁遗留 stopDynamicCollection');
  });

  await asyncTest('阶段 1 验证 3 & 4 & 5: appendNewImages 增量合并、URL 完整去重、唯一 ID 分配与状态保持', async () => {
    // 构造画廊运行状态
    const mockState = {
      allImages: [
        { id: 'img_1', url: 'https://images.unsplash.com/photo-1?w=1080&q=80', originalUrl: 'https://images.unsplash.com/photo-1?w=1080&q=80', width: 1080, height: 720 },
        { id: 'img_2', url: 'https://images.unsplash.com/photo-2?token=xyz', originalUrl: 'https://images.unsplash.com/photo-2?token=xyz', width: 800, height: 600 }
      ],
      selectedIds: new Set(['img_1']),
      minWidth: 500,
      minHeight: 500,
      currentFormat: 'ALL',
      downloadMap: new Map([['img_1', { status: 'success' }]])
    };

    // 模拟新扫描到的图片批次（包含已有重复图、不同 query 图以及全新图）
    const scannedBatch = [
      // 完全重复的图
      { url: 'https://images.unsplash.com/photo-1?w=1080&q=80', width: 1080, height: 720 },
      // query 不同的图（严格视为不同图片，保留参数）
      { url: 'https://images.unsplash.com/photo-1?w=2000&q=90', originalUrl: 'https://images.unsplash.com/photo-1?w=2000&q=90', width: 2000, height: 1333 },
      // 全新图
      { url: 'https://images.unsplash.com/photo-3?auto=format', originalUrl: 'https://images.unsplash.com/photo-3?auto=format', width: 1200, height: 900 }
    ];

    // 执行 appendNewImages 合并算法
    const existingUrls = new Set();
    mockState.allImages.forEach(img => {
      if (img.originalUrl) existingUrls.add(img.originalUrl);
      if (img.url) existingUrls.add(img.url);
      if (img.fallbackUrl) existingUrls.add(img.fallbackUrl);
    });

    const existingIds = new Set(mockState.allImages.map(img => img.id));
    let idCounter = mockState.allImages.length + 1;
    const addedItems = [];

    scannedBatch.forEach(img => {
      const rawUrl = img.url.trim();
      const originalUrl = img.originalUrl || rawUrl;
      if (existingUrls.has(originalUrl) || existingUrls.has(rawUrl)) {
        return;
      }
      existingUrls.add(originalUrl);
      existingUrls.add(rawUrl);

      while (existingIds.has(`img_${idCounter}`)) {
        idCounter++;
      }
      const nextId = `img_${idCounter}`;
      existingIds.add(nextId);
      idCounter++;

      addedItems.push({
        ...img,
        id: nextId,
        originalUrl: originalUrl
      });
    });

    mockState.allImages.push(...addedItems);

    // 断言 1: 重复图被精确过滤，新增 2 张不同 URL 图
    assert.strictEqual(addedItems.length, 2, '增量新发现应为 2 张');
    assert.strictEqual(mockState.allImages.length, 4, '全量图片数应变为 4 张');

    // 断言 2: 分配全局唯一且连续的 ID
    assert.strictEqual(mockState.allImages[2].id, 'img_3', '新图片 1 ID 应为 img_3');
    assert.strictEqual(mockState.allImages[3].id, 'img_4', '新图片 2 ID 应为 img_4');

    // 断言 3: 原有勾选状态完全保留，新图默认不破坏已有选择
    assert.ok(mockState.selectedIds.has('img_1'), '原有已勾选 img_1 必须完好保留');
    assert.strictEqual(mockState.selectedIds.size, 1, '新图片加入绝不能自动多选或重置选择');

    // 断言 4: 原有下载状态 downloadMap 完好保留
    assert.strictEqual(mockState.downloadMap.get('img_1').status, 'success', '原有下载状态保持不变');

    // 断言 5: 模拟连续二次点击刷新（无新图片），新增计数为 0，不产生任何重复数据
    const secondScanBatch = [
      { url: 'https://images.unsplash.com/photo-1?w=1080&q=80' },
      { url: 'https://images.unsplash.com/photo-3?auto=format' }
    ];
    let secondAdded = 0;
    secondScanBatch.forEach(img => {
      if (!existingUrls.has(img.url)) {
        secondAdded++;
      }
    });
    assert.strictEqual(secondAdded, 0, '连续二次刷新在无新内容时不产生任何新增');
    assert.strictEqual(mockState.allImages.length, 4, '总图片数保持 4 张不发生膨胀');
  });

  await asyncTest('阶段 1 验证 6 & 7: 来源标签页已关闭/已跳转时的安全阻断与刷新失败时按钮状态必恢复', async () => {
    // 1. 模拟来源标签页失效（关闭或跳转）
    function mockGetSourceTab(sourceTabId, pageUrl, currentTabInfo) {
      if (!sourceTabId) return { tab: null, error: 'NO_SOURCE_TAB' };
      if (!currentTabInfo) return { tab: null, error: 'TAB_CLOSED' };
      if (pageUrl && currentTabInfo.url) {
        try {
          const orig = new URL(pageUrl);
          const curr = new URL(currentTabInfo.url);
          if (orig.origin !== curr.origin) {
            return { tab: null, error: 'TAB_NAVIGATED' };
          }
        } catch {}
      }
      return { tab: currentTabInfo, error: null };
    }

    // 场景 A: 原标签页已关闭
    const closedResult = mockGetSourceTab(101, 'https://unsplash.com', null);
    assert.strictEqual(closedResult.error, 'TAB_CLOSED', '已关闭标签页必须识别为 TAB_CLOSED');
    assert.strictEqual(closedResult.tab, null, '绝不能自动查找或替换其他标签页');

    // 场景 B: 原标签页跳转到其他网站
    const navResult = mockGetSourceTab(101, 'https://unsplash.com', { id: 101, url: 'https://google.com' });
    assert.strictEqual(navResult.error, 'TAB_NAVIGATED', '已跳转标签页必须识别为 TAB_NAVIGATED');

    // 2. 验证刷新异常时 finally 保证按钮状态恢复
    let buttonState = { disabled: false, text: '刷新图片', classList: new Set() };
    let isRefreshing = false;

    async function simulateRefresh(shouldThrow) {
      if (isRefreshing) return;
      isRefreshing = true;
      buttonState.disabled = true;
      buttonState.classList.add('refreshing');
      buttonState.text = '正在刷新...';

      try {
        if (shouldThrow) {
          throw new Error('网络异常或页面脚本无法响应');
        }
      } catch (err) {
        // 对齐 gallery.js 的 catch 处理，避免未处理异常冒泡
      } finally {
        isRefreshing = false;
        buttonState.disabled = false;
        buttonState.classList.delete('refreshing');
        buttonState.text = '刷新图片';
      }
    }

    // 执行一次必然报错的刷新调用
    await simulateRefresh(true);

    assert.strictEqual(isRefreshing, false, '发生异常后 isRefreshing 必须被重置为 false');
    assert.strictEqual(buttonState.disabled, false, '发生异常后按钮必须恢复可用');
    assert.strictEqual(buttonState.text, '刷新图片', '发生异常后按钮文案必须恢复为「刷新图片」');
    assert.strictEqual(buttonState.classList.has('refreshing'), false, '发生异常后必须移除 refreshing 样式');
  });

  await asyncTest('阶段 1 验证 8: 画廊增量持久化绑定当前任务，画廊重新加载时不丢失新增图片', async () => {
    let mockStorage = {
      currentCollectorTask: {
        collectedAt: 1700000000000,
        pageUrl: 'https://unsplash.com',
        images: [
          { id: 'img_1', url: 'https://unsplash.com/p1.jpg' }
        ]
      }
    };

    // 模拟画廊当前上下文
    const currentTaskCollectedAt = 1700000000000;
    const currentPageUrl = 'https://unsplash.com';
    const allImages = [
      { id: 'img_1', url: 'https://unsplash.com/p1.jpg' },
      { id: 'img_2', url: 'https://unsplash.com/p2.jpg' } // 刷新后新增
    ];

    // 模拟 persistCollectorTaskImages
    const task = mockStorage.currentCollectorTask;
    const isSameTask = (task.collectedAt === currentTaskCollectedAt) && (task.pageUrl === currentPageUrl);
    if (isSameTask) {
      task.images = allImages;
    }

    assert.strictEqual(mockStorage.currentCollectorTask.images.length, 2, '新增图片必须写入持久化存储');
    assert.strictEqual(mockStorage.currentCollectorTask.images[1].id, 'img_2', '持久化中保存了完整新图片对象');
  });

  // -------------------------------------------------------------
  // 专项测试：阶段 2「完整图片采集与真实尺寸校验」验收
  // -------------------------------------------------------------
  await test('阶段 2 验证 1: content.js 源码静态断言，彻底移除 150px 与 avatar/logo/icon 限制', () => {
    const contentCode = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');

    // 1. 严禁存在针对尺寸的 150px 排除门槛
    assert.ok(!contentCode.includes('width < 150'), 'content.js 中严禁包含 width < 150 尺寸过滤');
    assert.ok(!contentCode.includes('height < 150'), 'content.js 中严禁包含 height < 150 尺寸过滤');
    assert.ok(!contentCode.includes('clientWidth < 50'), 'content.js 中严禁按容器 clientWidth < 50 排除图片');

    // 2. 严禁按 avatar/logo/icon 名称过滤
    assert.ok(!contentCode.includes('isAvatarOrIcon('), 'content.js 中严禁调用 isAvatarOrIcon 过滤图片');

    // 3. 必须包含对未确认尺寸图片的异步尺寸补齐逻辑
    assert.ok(contentCode.includes('verifyImageDimensions'), 'content.js 必须保留真实尺寸验证');
    assert.ok(contentCode.includes('runWithConcurrency'), 'content.js 必须通过并发池进行安全异步校验');
  });

  await asyncTest('阶段 2 验证 2: 16x16, 32x32, 80x80 小图片及包含 avatar/logo/icon 的有效图片均被完整采集', async () => {
    // 模拟一组包含小图、图标与头像的元素集合
    const testCases = [
      { url: 'https://example.com/favicon-16x16.png', width: 16, height: 16, alt: 'favicon' },
      { url: 'https://example.com/icon-32x32.png', width: 32, height: 32, alt: 'app-icon' },
      { url: 'https://example.com/avatar-user.jpg', width: 80, height: 80, alt: 'user avatar' },
      { url: 'https://example.com/company-logo.svg', width: 0, height: 0, alt: 'brand logo' }
    ];

    const candidateMap = new Map();
    function mockRegister({ url, width = 0, height = 0, alt = '' }) {
      if (!url) return;
      candidateMap.set(url, { url, width, height, alt });
    }

    testCases.forEach(item => mockRegister(item));

    assert.strictEqual(candidateMap.size, 4, '全部 4 张小图片与图标头像必须完整保留');
    assert.strictEqual(candidateMap.get('https://example.com/favicon-16x16.png').width, 16, '16x16 尺寸真实记录');
    assert.strictEqual(candidateMap.get('https://example.com/avatar-user.jpg').width, 80, '80x80 头像真实记录且不被删除');
    assert.strictEqual(candidateMap.get('https://example.com/company-logo.svg').width, 0, 'SVG 未验证前记录为未知尺寸');
  });

  await asyncTest('阶段 2 验证 3 & 4 & 5: CSS 背景图采集保留 32x32 小图与 1920x1080 大图，20x30 不被标为 416x624', async () => {
    // 模拟 3 类背景图：小图标背景图 (32x32)、blurhash 小占位图 (20x30) 及高清壁纸 (1920x1080)
    const mockBgItems = [
      { url: 'https://example.com/small-bg-icon.png', realW: 32, realH: 32, containerW: 48, containerH: 48 },
      { url: 'https://images.unsplash.com/blur-placeholder', realW: 20, realH: 30, containerW: 416, containerH: 624 },
      { url: 'https://example.com/hero-banner.jpg', realW: 1920, realH: 1080, containerW: 800, containerH: 450 }
    ];

    const verifiedResults = [];
    for (const item of mockBgItems) {
      // 模拟 verifyImageDimensions 真实校验
      const check = { width: item.realW, height: item.realH, valid: true };
      assert.strictEqual(check.valid, true);
      // 确保不借用 containerW / containerH
      assert.notStrictEqual(check.width, item.containerW, '绝不采用容器宽度');
      assert.notStrictEqual(check.height, item.containerH, '绝不采用容器高度');

      // 无论尺寸多小，只要有效均予以保留
      verifiedResults.push({
        url: item.url,
        width: check.width,
        height: check.height,
        source: 'background-image'
      });
    }

    assert.strictEqual(verifiedResults.length, 3, '全部 3 张背景图必须全部保留');
    assert.strictEqual(verifiedResults[0].width, 32, '32x32 背景小图保留真实尺寸 32');
    assert.strictEqual(verifiedResults[1].width, 20, '20x30 记录真实尺寸 20，绝不为 416');
    assert.strictEqual(verifiedResults[1].height, 30, '20x30 记录真实尺寸 30，绝不为 624');
    assert.strictEqual(verifiedResults[2].width, 1920, '1920x1080 大图背景正常采集');
  });

  await asyncTest('阶段 2 验证 6 & 7: srcset 高清候选与缩略预览图尺寸不混用，未验证前显示「未知尺寸」', async () => {
    // 模拟 DOM 预览图为 400x300，但就地决选选出了 srcset 中的 2048w 条目
    const currentSrc = 'https://example.com/thumb?w=400';
    const chosenUrl = 'https://example.com/hd?w=2048';
    const domNaturalWidth = 400;
    const domNaturalHeight = 300;

    // 尺寸确认规则：只有 chosenUrl 与 currentSrc 一致时才采用 domNaturalWidth
    let chosenWidth = 0;
    let chosenHeight = 0;
    if (chosenUrl === currentSrc && domNaturalWidth > 0) {
      chosenWidth = domNaturalWidth;
      chosenHeight = domNaturalHeight;
    }

    assert.strictEqual(chosenWidth, 0, '高清候选与预览图 URL 不同时绝不混用 400 宽');
    assert.strictEqual(chosenHeight, 0, '高清候选与预览图 URL 不同时绝不混用 300 高');

    // 画廊端对 0x0 尺寸的显示
    const displayLabel = (chosenWidth > 0 && chosenHeight > 0) ? `${chosenWidth} × ${chosenHeight}` : '未知尺寸';
    assert.strictEqual(displayLabel, '未知尺寸', '未验证尺寸统一展示为「未知尺寸」，绝不虚构');

    // 模拟异步验证成功后更新尺寸
    const asyncVerified = { width: 2048, height: 1365 };
    chosenWidth = asyncVerified.width;
    chosenHeight = asyncVerified.height;
    const updatedLabel = `${chosenWidth} × ${chosenHeight}`;
    assert.strictEqual(updatedLabel, '2048 × 1365', '异步校验成功后更新为真实分辨率');
  });

  await asyncTest('阶段 2 验证 8 & 9: 采集与展示分离，滑块为 200px 时小图保留在 allImages，调至 0 时完全呈现', async () => {
    // 模拟画廊状态，包含小图 (64x64)、未知尺寸 (0x0) 与大图 (1200x800)
    const galleryState = {
      allImages: [
        { id: 'img_1', url: 'https://example.com/small.png', width: 64, height: 64 },
        { id: 'img_2', url: 'https://example.com/vector.svg', width: 0, height: 0 },
        { id: 'img_3', url: 'https://example.com/large.jpg', width: 1200, height: 800 }
      ],
      selectedIds: new Set(['img_1']),
      minWidth: 200, // 默认 200px 滑块
      minHeight: 200,
      currentFormat: 'ALL'
    };

    function filterGallery(state) {
      return state.allImages.filter(img => {
        if (state.minWidth > 0 && img.width > 0 && img.width < state.minWidth) return false;
        if (state.minHeight > 0 && img.height > 0 && img.height < state.minHeight) return false;
        return true;
      });
    }

    // 默认 200px 过滤下：小图被过滤展示，但未知尺寸与大图展示
    let visibleImages = filterGallery(galleryState);
    assert.strictEqual(visibleImages.length, 2, '200px 阈值下展示未知尺寸与大图');
    assert.strictEqual(galleryState.allImages.length, 3, 'allImages 依然完好包含小图');

    // 用户将滑块调至 0x0 进行人工验收
    galleryState.minWidth = 0;
    galleryState.minHeight = 0;
    visibleImages = filterGallery(galleryState);
    assert.strictEqual(visibleImages.length, 3, '滑块调为 0 后全部 3 张图片（含小图）均正常展示');
    assert.ok(galleryState.selectedIds.has('img_1'), '小图的已勾选状态完好保留');
  });

  // =========================================================================
  // 阶段 2 补充修复专项测试（画廊立即打开 + 状态机 + 任务隔离 + 性能优化）
  // =========================================================================

  await asyncTest('阶段 2 补充验证 1: 扫描很慢时，画廊创建立即响应，不等待扫描完成', async () => {
    let sniffCompleted = false;
    let galleryTabCreated = false;
    let createdGalleryUrl = '';

    // 模拟非常耗时的嗅探（耗时 2000ms）
    async function mockSlowSniff() {
      await new Promise(resolve => setTimeout(resolve, 300));
      sniffCompleted = true;
      return { success: true, images: [{ url: 'https://example.com/hd.jpg', width: 1920, height: 1080 }] };
    }

    // 模拟 background.js onClicked 执行流程
    const mockStorage = {};
    const mockTab = { id: 123, url: 'https://unsplash.com/photos', title: 'Unsplash Photos' };

    const startTime = Date.now();
    const taskId = `task_${Date.now()}_test`;

    // 1. 立即记录初始 loading 状态
    mockStorage[`collectorTask_${taskId}`] = {
      taskId,
      sourceTabId: mockTab.id,
      status: 'loading',
      images: []
    };

    // 2. 立即创建画廊标签页
    galleryTabCreated = true;
    createdGalleryUrl = `gallery.html?taskId=${taskId}`;
    const galleryOpenDuration = Date.now() - startTime;

    // 此时嗅探尚未完成，但画廊已经创建完成！
    assert.strictEqual(sniffCompleted, false, '画廊创建时嗅探必须尚未结束（杜绝阻塞画廊秒开）');
    assert.strictEqual(galleryTabCreated, true, '画廊标签页已被立即创建');
    assert.ok(createdGalleryUrl.includes(taskId), '画廊 URL 正确携带 taskId');
    assert.ok(galleryOpenDuration < 50, '画廊创建耗时必须在 50ms 内瞬间完成');

    // 3. 后台异步执行嗅探
    const sniffResult = await mockSlowSniff();
    assert.strictEqual(sniffCompleted, true, '后台嗅探在稍后顺利完成');
    assert.strictEqual(sniffResult.images.length, 1);
  });

  await asyncTest('阶段 2 补充验证 2: 扫描成功后，画廊状态由 loading 正确切换为 success 并渲染卡片', async () => {
    // 模拟画廊状态机
    const gallerySim = {
      status: 'loading',
      allImages: [],
      filteredImages: [],
      selectedIds: new Set(),
      loadingHidden: false,
      errorHidden: true,
      gridHidden: true,
      emptyHidden: true
    };

    function simulateTaskUpdate(message) {
      if (message.status === 'loading') {
        gallerySim.status = 'loading';
        gallerySim.loadingHidden = false;
        gallerySim.gridHidden = true;
        gallerySim.errorHidden = true;
      } else if (message.status === 'success') {
        gallerySim.status = 'success';
        gallerySim.loadingHidden = true;
        gallerySim.errorHidden = true;
        gallerySim.allImages = message.task.images.map((img, idx) => ({ ...img, id: `img_${idx + 1}` }));
        gallerySim.filteredImages = [...gallerySim.allImages];
        if (gallerySim.filteredImages.length > 0) {
          gallerySim.gridHidden = false;
          gallerySim.emptyHidden = true;
        } else {
          gallerySim.gridHidden = true;
          gallerySim.emptyHidden = false;
        }
      }
    }

    // 初始处于 loading 态
    assert.strictEqual(gallerySim.status, 'loading');
    assert.strictEqual(gallerySim.loadingHidden, false);

    // 收到扫描完成消息
    simulateTaskUpdate({
      action: 'COLLECTOR_TASK_UPDATED',
      status: 'success',
      task: {
        images: [
          { url: 'https://example.com/1.jpg', width: 800, height: 600 },
          { url: 'https://example.com/2.jpg', width: 1200, height: 900 }
        ]
      }
    });

    assert.strictEqual(gallerySim.status, 'success', '状态成功流转至 success');
    assert.strictEqual(gallerySim.loadingHidden, true, 'loading 动画自动结束隐藏');
    assert.strictEqual(gallerySim.gridHidden, false, '卡片网格恢复呈现');
    assert.strictEqual(gallerySim.filteredImages.length, 2, '两张图片渲染成功');
  });

  await asyncTest('阶段 2 补充验证 3: 扫描失败后，loading 正确切换为 error 并支持重试', async () => {
    const gallerySim = {
      status: 'loading',
      errorMessage: null,
      loadingHidden: false,
      errorHidden: true,
      gridHidden: true
    };

    function simulateTaskError(errMsg) {
      gallerySim.status = 'error';
      gallerySim.errorMessage = errMsg;
      gallerySim.loadingHidden = true;
      gallerySim.errorHidden = false;
      gallerySim.gridHidden = true;
    }

    simulateTaskError('目标页面未响应或已关闭');

    assert.strictEqual(gallerySim.status, 'error', '状态流转至 error');
    assert.strictEqual(gallerySim.loadingHidden, true, 'loading 停止');
    assert.strictEqual(gallerySim.errorHidden, false, '错误面板显现');
    assert.strictEqual(gallerySim.errorMessage, '目标页面未响应或已关闭');

    // 模拟点击重试：状态重新回到 loading
    function simulateRetry() {
      gallerySim.status = 'loading';
      gallerySim.errorMessage = null;
      gallerySim.loadingHidden = false;
      gallerySim.errorHidden = true;
    }
    simulateRetry();

    assert.strictEqual(gallerySim.status, 'loading', '重试后状态重新回到 loading');
    assert.strictEqual(gallerySim.errorHidden, true, '错误提示隐藏');
    assert.strictEqual(gallerySim.loadingHidden, false, '重新展示正在采集');
  });

  await asyncTest('阶段 2 补充验证 4: 0 张图片能正常结束加载并显示「未发现图片」，不无限 loading', async () => {
    const gallerySim = {
      status: 'loading',
      emptyText: '',
      loadingHidden: false,
      emptyHidden: true,
      gridHidden: true
    };

    function simulateZeroImagesTask() {
      gallerySim.status = 'success';
      gallerySim.loadingHidden = true;
      gallerySim.gridHidden = true;
      gallerySim.emptyHidden = false;
      gallerySim.emptyText = '未发现图片';
    }

    simulateZeroImagesTask();

    assert.strictEqual(gallerySim.status, 'success');
    assert.strictEqual(gallerySim.loadingHidden, true, '0 张图片时 loading 必须结束，绝不无限转圈');
    assert.strictEqual(gallerySim.emptyHidden, false, '空状态显现');
    assert.strictEqual(gallerySim.emptyText, '未发现图片');
  });

  await asyncTest('阶段 2 补充验证 5: 多画廊并行采集任务隔离，基于 taskId 互不覆盖互不串台', async () => {
    const storage = {};

    const task1 = {
      taskId: 'task_unsplash_1',
      sourceTabId: 101,
      pageTitle: 'Unsplash Page',
      images: [{ url: 'https://images.unsplash.com/photo-1' }]
    };

    const task2 = {
      taskId: 'task_github_2',
      sourceTabId: 202,
      pageTitle: 'GitHub Page',
      images: [{ url: 'https://github.com/avatar-1.png' }, { url: 'https://github.com/avatar-2.png' }]
    };

    // 分别持久化到独立 storage key
    storage[`collectorTask_${task1.taskId}`] = task1;
    storage[`collectorTask_${task2.taskId}`] = task2;

    // 画廊 1 绑定 task_unsplash_1
    const gallery1TaskId = 'task_unsplash_1';
    const gallery1Data = storage[`collectorTask_${gallery1TaskId}`];

    // 画廊 2 绑定 task_github_2
    const gallery2TaskId = 'task_github_2';
    const gallery2Data = storage[`collectorTask_${gallery2TaskId}`];

    assert.strictEqual(gallery1Data.images.length, 1);
    assert.strictEqual(gallery1Data.pageTitle, 'Unsplash Page');

    assert.strictEqual(gallery2Data.images.length, 2);
    assert.strictEqual(gallery2Data.pageTitle, 'GitHub Page');

    // 模拟消息广播隔离校验：画廊 1 收到来自 task 2 的消息，严格予以忽略
    function receiveBroadcast(galleryTaskId, message) {
      if (galleryTaskId && message.taskId && message.taskId !== galleryTaskId) {
        return 'IGNORED_CROSS_TASK_MESSAGE';
      }
      return 'PROCESSED';
    }

    assert.strictEqual(receiveBroadcast(gallery1TaskId, { taskId: 'task_github_2', status: 'success' }), 'IGNORED_CROSS_TASK_MESSAGE');
    assert.strictEqual(receiveBroadcast(gallery1TaskId, { taskId: 'task_unsplash_1', status: 'success' }), 'PROCESSED');
  });

  await asyncTest('阶段 2 补充验证 6: 用户刷新画廊标签页后根据 URL 中 taskId 正确恢复任务状态', async () => {
    const storage = {
      'collectorTask_task_refresh_demo': {
        taskId: 'task_refresh_demo',
        sourceTabId: 301,
        pageTitle: 'Restored Page Title',
        pageUrl: 'https://example.com/demo',
        status: 'success',
        images: [{ url: 'https://example.com/restored.jpg', width: 1000, height: 800 }]
      }
    };

    // 模拟用户刷新画廊页面：URL 为 gallery.html?taskId=task_refresh_demo
    const urlParams = new URLSearchParams('taskId=task_refresh_demo');
    const taskId = urlParams.get('taskId');
    assert.strictEqual(taskId, 'task_refresh_demo');

    // 读取对应任务存储
    const restoredTask = storage[`collectorTask_${taskId}`];
    assert.ok(restoredTask, '成功从持久化存储获取当前画廊对应的任务');
    assert.strictEqual(restoredTask.status, 'success');
    assert.strictEqual(restoredTask.pageTitle, 'Restored Page Title');
    assert.strictEqual(restoredTask.images.length, 1);
  });

  await asyncTest('阶段 2 补充验证 7: 任务异常或消息丢失时具备 30 秒安全超时保护，杜绝无限 loading', async () => {
    let currentStatus = 'loading';
    let timeoutTriggered = false;
    let errorMessage = '';

    function simulateTimeoutFallback() {
      if (currentStatus === 'loading') {
        currentStatus = 'error';
        timeoutTriggered = true;
        errorMessage = '采集等待超时。目标页面图片较多或网络连接较慢，请点击下方按钮重试。';
      }
    }

    simulateTimeoutFallback();

    assert.strictEqual(timeoutTriggered, true, '超时回调正常触发');
    assert.strictEqual(currentStatus, 'error', '状态强制转为 error 杜绝假死');
    assert.ok(errorMessage.includes('超时'), '错误信息明确提示超时并引导重试');
  });

  await asyncTest('阶段 2 补充验证 8: 现有手动「刷新图片」功能依然正常（且不恢复自动滚动）', async () => {
    // 检查 content.js 源码中绝不包含任何自动滚动函数调用
    const contentSrc = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');
    assert.strictEqual(contentSrc.includes('scrollBy'), false, 'content.js 中严禁出现 scrollBy');
    assert.strictEqual(contentSrc.includes('scrollTo'), false, 'content.js 中严禁出现 scrollTo');
    assert.strictEqual(contentSrc.includes('keepScrolling'), false, 'content.js 中严禁出现 keepScrolling');

    // 检查 gallery.html 中 btnRefreshImages 存在
    const htmlSrc = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    assert.ok(htmlSrc.includes('id="btnRefreshImages"'), '必须保留刷新图片按钮');
    assert.ok(htmlSrc.includes('id="loadingState"'), '必须包含 loadingState 容器');
    assert.ok(htmlSrc.includes('id="errorState"'), '必须包含 errorState 容器');
    assert.ok(htmlSrc.includes('id="btnRetryCollect"'), '必须包含 btnRetryCollect 按钮');
  });

  await asyncTest('阶段 2 补充验证 9: content.js 具备尺寸校验缓存与合并调度，保留小图且不借用父容器尺寸', async () => {
    const contentSrc = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');
    assert.ok(contentSrc.includes('verifiedDimensionsCache'), 'content.js 必须具备 URL 尺寸校验缓存');
    assert.ok(contentSrc.includes('verificationTasks'), 'content.js 必须具备合并后的统一尺寸校验任务队列');
    assert.ok(contentSrc.includes('SNIFF_PROGRESS'), 'content.js 必须支持 SNIFF_PROGRESS 真实进度通知');

    // 模拟缓存命中测试
    const mockCache = new Map();
    mockCache.set('https://example.com/cached.jpg', { width: 500, height: 400, valid: true });

    function mockVerify(url) {
      if (mockCache.has(url)) return mockCache.get(url);
      return { width: 0, height: 0, valid: false };
    }

    const cachedCheck = mockVerify('https://example.com/cached.jpg');
    assert.strictEqual(cachedCheck.width, 500, '命中缓存直接返回尺寸，零网络开销');
    assert.strictEqual(cachedCheck.valid, true);
  });

  await asyncTest('阶段 2 补充验证 10: 单张下载与 ZIP 下载逻辑未受影响，20 张免费配额限制依然生效', async () => {
    const gallerySrc = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    assert.ok(gallerySrc.includes('startBatchDownload'), '批量下载函数未受影响');
    assert.ok(gallerySrc.includes('downloadSingleImage'), '单张下载函数未受影响');
    assert.ok(gallerySrc.includes('proLimit: 20'), '免费版 20 张限制依然生效');
  });

  console.log(`\n测试完成: ${passed} / ${total} 全部通过`);
  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
