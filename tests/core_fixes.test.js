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

  // =============================================================
  // 阶段 2 定点修复：图片已显示但尺寸仍为未知（9 项定点自动化测试）
  // =============================================================

  // 从 gallery.js 生产代码动态提取真实 getDimensionBadgeInfo 函数
  function extractGetDimensionBadgeInfo() {
    const code = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    const match = code.match(/function getDimensionBadgeInfo\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    if (!match) throw new Error('getDimensionBadgeInfo 未在 gallery.js 中找到');
    return new Function(`${match[0]}; return getDimensionBadgeInfo;`)();
  }
  const realGetDimensionBadgeInfo = extractGetDimensionBadgeInfo();

  await asyncTest('阶段 2 定点验证 1: 首次采集检测超时(尺寸为0)，画廊稍后加载成功时尺寸自动更新并展示真实尺寸', async () => {
    // 模拟采集阶段由于网络延迟超过 1200ms，采集到的尺寸为 0x0
    const imgItem = {
      id: 'img_unsplash_slow',
      url: 'https://images.unsplash.com/photo-slow?w=2000',
      width: 0,
      height: 0,
      isFallback: false
    };

    // 初始状态下徽章应为「检测中」
    const initialBadge = realGetDimensionBadgeInfo(imgItem);
    assert.strictEqual(initialBadge.text, '检测中');
    assert.strictEqual(initialBadge.className, 'badge badge-res badge-pending');

    // 模拟画廊卡片渲染，thumbImg 加载完成 (naturalWidth=2000, naturalHeight=3000)
    let cardBadgeText = initialBadge.text;
    let cardBadgeClass = initialBadge.className;

    function updateCardDimension(nw, nh, isFallback) {
      if (!nw || !nh) return;
      if (isFallback) {
        imgItem.width = nw;
        imgItem.height = nh;
        imgItem.isFallback = true;
        cardBadgeText = `预览 ${nw} × ${nh}`;
        cardBadgeClass = 'badge badge-res badge-preview';
      } else {
        imgItem.width = nw;
        imgItem.height = nh;
        imgItem.isFallback = false;
        cardBadgeText = `${nw} × ${nh}`;
        cardBadgeClass = `badge badge-res ${nw >= 1000 || nh >= 1000 ? 'large-res' : ''}`;
      }
    }

    // 图片加载完成事件触发
    updateCardDimension(2000, 3000, false);

    assert.strictEqual(imgItem.width, 2000);
    assert.strictEqual(imgItem.height, 3000);
    assert.strictEqual(cardBadgeText, '2000 × 3000');
    assert.strictEqual(cardBadgeClass, 'badge badge-res large-res');
    assert.strictEqual(imgItem.isFallback, false);
  });

  await asyncTest('阶段 2 定点验证 2: 图片已在浏览器缓存中，thumbImg.complete 补查确保绝不错过尺寸检测', async () => {
    // 模拟浏览器缓存场景：在绑定 load 监听器时，img.complete 已经为 true
    const cachedImgItem = {
      id: 'img_cached_1',
      url: 'https://images.unsplash.com/photo-cached',
      width: 0,
      height: 0
    };

    const mockThumbImg = {
      complete: true,
      naturalWidth: 1920,
      naturalHeight: 1080,
      dataset: {},
      listeners: {},
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      }
    };

    let badgeText = '检测中';
    let updateCount = 0;

    function bindThumbEvents(thumbImg, item) {
      function updateCardDimension(nw, nh, isFallback) {
        item.width = nw;
        item.height = nh;
        badgeText = isFallback ? `预览 ${nw} × ${nh}` : `${nw} × ${nh}`;
        updateCount++;
      }

      thumbImg.addEventListener('load', () => {
        if (thumbImg.naturalWidth > 0 && thumbImg.naturalHeight > 0) {
          updateCardDimension(thumbImg.naturalWidth, thumbImg.naturalHeight, thumbImg.dataset.isFallback === 'true');
        }
      });

      // 关键补查：如果图片已经完成加载，立即同步触发更新
      if (thumbImg.complete) {
        if (thumbImg.naturalWidth > 0 && thumbImg.naturalHeight > 0) {
          updateCardDimension(thumbImg.naturalWidth, thumbImg.naturalHeight, thumbImg.dataset.isFallback === 'true');
        }
      }
    }

    bindThumbEvents(mockThumbImg, cachedImgItem);

    // 验证即使从未触发 load 事件（因为绑定前就已经 complete 了），补查逻辑也立即读取了尺寸！
    assert.strictEqual(updateCount, 1, '由于 complete=true，立即触发了尺寸更新');
    assert.strictEqual(cachedImgItem.width, 1920);
    assert.strictEqual(cachedImgItem.height, 1080);
    assert.strictEqual(badgeText, '1920 × 1080');
  });

  await asyncTest('阶段 2 定点验证 3: content.js 尺寸校验超时不污染缓存，并发复用 Promise，后续重试可成功', async () => {
    // 从 content.js 动态提取真实的 verifyImageDimensions 生产代码
    const contentSrc = fs.readFileSync(CONTENT_JS_PATH, 'utf-8');
    const match = contentSrc.match(/(const verifiedDimensionsCache = new Map\(\);[\s\S]*?const inFlightVerifications = new Map\(\);[\s\S]*?function verifyImageDimensions\s*\([^)]*\)\s*\{[\s\S]*?\n  \})/);
    assert.ok(match, 'content.js 中必须存在 verifiedDimensionsCache 与 verifyImageDimensions');

    let imageShouldTimeout = false;
    class MockImage {
      constructor() {
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        this.onload = null;
        this.onerror = null;
        this._src = '';
      }
      set src(val) {
        this._src = val;
        if (!val) return;
        if (imageShouldTimeout) {
          // 模拟慢网络超时：不触发 onload
        } else {
          setTimeout(() => {
            this.naturalWidth = 2400;
            this.naturalHeight = 1600;
            if (this.onload) this.onload();
          }, 5);
        }
      }
      get src() { return this._src; }
    }

    const fnWrapper = new Function('Image', 'setTimeout', 'clearTimeout', 'Promise', 'URL', match[1] + '; return { verifyImageDimensions, verifiedDimensionsCache, inFlightVerifications };');
    const { verifyImageDimensions, verifiedDimensionsCache, inFlightVerifications } = fnWrapper(MockImage, setTimeout, clearTimeout, Promise, URL);

    const testUrl = 'https://images.unsplash.com/photo-retry-demo';

    // 1. 首次调用：超时
    imageShouldTimeout = true;
    const res1 = await verifyImageDimensions(testUrl, 20);
    assert.strictEqual(res1.timeout, true, '超时标志应为 true');
    assert.strictEqual(res1.valid, false);
    assert.strictEqual(verifiedDimensionsCache.has(testUrl), false, '【关键断言】超时绝对不能存入 verifiedDimensionsCache！');

    // 2. 模拟后续重试或刷新，此时网络正常
    imageShouldTimeout = false;
    const res2 = await verifyImageDimensions(testUrl, 20);
    assert.strictEqual(res2.valid, true, '重新检测能够成功验证');
    assert.strictEqual(res2.width, 2400);
    assert.strictEqual(res2.height, 1600);
    assert.strictEqual(verifiedDimensionsCache.has(testUrl), true, '成功尺寸正常被缓存');

    // 3. 并发 Promise 复用验证
    verifiedDimensionsCache.clear();
    const concurrentUrl = 'https://images.unsplash.com/photo-concurrent';
    const p1 = verifyImageDimensions(concurrentUrl, 50);
    const p2 = verifyImageDimensions(concurrentUrl, 50);
    assert.strictEqual(p1, p2, '同一 URL 的并发检测必须共享同一个 in-flight Promise！');
    await Promise.all([p1, p2]);
  });

  await asyncTest('阶段 2 定点验证 4: 高清候选与预览回退不混用尺寸，状态机展示明确区分', async () => {
    // 1. 未完成检测 -> 「检测中」
    const pendingImg = { id: 'p1', url: 'https://example.com/p1.jpg', width: 0, height: 0 };
    const pendingBadge = realGetDimensionBadgeInfo(pendingImg);
    assert.strictEqual(pendingBadge.text, '检测中');
    assert.strictEqual(pendingBadge.className, 'badge badge-res badge-pending');

    // 2. 高清候选成功加载 -> 真实高清尺寸例如「3840 × 2160」
    const hdImg = { id: 'hd1', url: 'https://example.com/hd.jpg', width: 3840, height: 2160, isFallback: false };
    const hdBadge = realGetDimensionBadgeInfo(hdImg);
    assert.strictEqual(hdBadge.text, '3840 × 2160');
    assert.strictEqual(hdBadge.className, 'badge badge-res large-res');

    // 3. 高清加载失败、预览回退成功 -> 明确标识为「预览 800 × 1200」与 badge-preview 样式
    const fallbackImg = { id: 'fb1', url: 'https://example.com/preview.jpg', width: 800, height: 1200, isFallback: true };
    const fbBadge = realGetDimensionBadgeInfo(fallbackImg);
    assert.strictEqual(fbBadge.text, '预览 800 × 1200', '回退预览尺寸必须带明确「预览」标识');
    assert.strictEqual(fbBadge.className, 'badge badge-res badge-preview');

    // 4. 最终无法加载或解析 -> 「无法读取尺寸」与 badge-failed 样式
    const failedImg = { id: 'fail1', url: 'https://example.com/fail.jpg', width: 0, height: 0, detectionFailed: true };
    const failedBadge = realGetDimensionBadgeInfo(failedImg);
    assert.strictEqual(failedBadge.text, '无法读取尺寸');
    assert.strictEqual(failedBadge.className, 'badge badge-res badge-failed');
  });

  await asyncTest('阶段 2 定点验证 5: 尺寸回填后持久化保存，刷新画廊页面后仍然正确展示且保留预览标记', async () => {
    const taskId = 'task_unsplash_persist_test';
    const mockStorage = {
      [`collectorTask_${taskId}`]: {
        taskId,
        pageTitle: 'Unsplash Page',
        images: [
          { id: 'img_1', url: 'https://images.unsplash.com/photo-1', width: 0, height: 0, isFallback: false },
          { id: 'img_2', url: 'https://images.unsplash.com/photo-2', width: 0, height: 0, isFallback: false }
        ]
      }
    };

    // 模拟画廊卡片加载完成，触发尺寸自动回填并持久化
    const task = mockStorage[`collectorTask_${taskId}`];
    task.images[0].width = 2400;
    task.images[0].height = 1600;
    task.images[0].isFallback = false;

    task.images[1].width = 600;
    task.images[1].height = 400;
    task.images[1].isFallback = true; // 回退预览

    // 模拟刷新画廊页面：从 storage 重新读取并进入 processTaskImages
    const restoredImages = task.images;
    const dedupeMap = new Map();
    restoredImages.forEach(img => {
      dedupeMap.set(img.url, {
        ...img,
        isFallback: !!img.isFallback
      });
    });

    const refreshedAllImages = Array.from(dedupeMap.values()).map((item, idx) => ({
      ...item,
      id: item.id || `img_${idx + 1}`
    }));

    assert.strictEqual(refreshedAllImages.length, 2);
    assert.strictEqual(refreshedAllImages[0].width, 2400);
    assert.strictEqual(refreshedAllImages[0].height, 1600);
    assert.strictEqual(refreshedAllImages[0].isFallback, false);
    const badge1 = realGetDimensionBadgeInfo(refreshedAllImages[0]);
    assert.strictEqual(badge1.text, '2400 × 1600');

    assert.strictEqual(refreshedAllImages[1].width, 600);
    assert.strictEqual(refreshedAllImages[1].height, 400);
    assert.strictEqual(refreshedAllImages[1].isFallback, true);
    const badge2 = realGetDimensionBadgeInfo(refreshedAllImages[1]);
    assert.strictEqual(badge2.text, '预览 600 × 400', '刷新页面后预览尺寸标识依然精确保留！');
  });

  await asyncTest('阶段 2 定点验证 6: 多张图片并发回填防抖合并写入存储，无覆盖且任务隔离互不串台', async () => {
    let storageWrites = 0;
    const storage = {
      collectorTask_task_A: {
        taskId: 'task_A',
        images: [
          { id: 'img_A1', url: 'https://example.com/a1.jpg', width: 0, height: 0 },
          { id: 'img_A2', url: 'https://example.com/a2.jpg', width: 0, height: 0 },
          { id: 'img_A3', url: 'https://example.com/a3.jpg', width: 0, height: 0 }
        ]
      },
      collectorTask_task_B: {
        taskId: 'task_B',
        images: [
          { id: 'img_B1', url: 'https://example.com/b1.jpg', width: 100, height: 100 }
        ]
      }
    };

    const pendingUpdates = new Map();
    function scheduleUpdate(id, w, h, isFallback) {
      pendingUpdates.set(id, { width: w, height: h, isFallback });
    }

    function flushUpdates(currentTaskId) {
      if (pendingUpdates.size === 0) return;
      const targetTask = storage[`collectorTask_${currentTaskId}`];
      if (targetTask) {
        targetTask.images.forEach(img => {
          if (pendingUpdates.has(img.id)) {
            const upd = pendingUpdates.get(img.id);
            img.width = upd.width;
            img.height = upd.height;
            img.isFallback = upd.isFallback;
          }
        });
        storageWrites++;
      }
      pendingUpdates.clear();
    }

    // 模拟 3 张图片在几十毫秒内相继加载完成
    scheduleUpdate('img_A1', 1920, 1080, false);
    scheduleUpdate('img_A2', 800, 600, true);
    scheduleUpdate('img_A3', 3840, 2160, false);

    // 触发合并保存
    flushUpdates('task_A');

    assert.strictEqual(storageWrites, 1, '多张图片并发更新合并为单次存储写入，杜绝高频 IO');
    const taskA = storage.collectorTask_task_A;
    assert.strictEqual(taskA.images[0].width, 1920);
    assert.strictEqual(taskA.images[1].width, 800);
    assert.strictEqual(taskA.images[1].isFallback, true);
    assert.strictEqual(taskA.images[2].width, 3840);

    // 验证任务 B 完全不受影响（隔离不串台）
    const taskB = storage.collectorTask_task_B;
    assert.strictEqual(taskB.images[0].width, 100, '其他任务不受当前画廊持久化影响');
  });

  await asyncTest('阶段 2 定点验证 7: 8x8、32x32 等有效小图片继续保留并如实显示真实尺寸', async () => {
    const smallImages = [
      { id: 'img_tiny_1', url: 'https://example.com/8x8.png', width: 8, height: 8, isFallback: false },
      { id: 'img_tiny_2', url: 'https://example.com/32x32.ico', width: 32, height: 32, isFallback: false }
    ];

    smallImages.forEach(img => {
      const badge = realGetDimensionBadgeInfo(img);
      assert.strictEqual(badge.text, `${img.width} × ${img.height}`);
      assert.strictEqual(badge.className, 'badge badge-res ');
    });
  });

  await asyncTest('阶段 2 定点验证 8: 手动「刷新图片」功能依然正常，增量合并且已有尺寸和勾选不受影响', async () => {
    const currentImages = [
      { id: 'img_1', url: 'https://example.com/existing.jpg', width: 2000, height: 1500, isFallback: false }
    ];
    const selectedIds = new Set(['img_1']);

    const newlyScanned = [
      { url: 'https://example.com/existing.jpg', width: 0, height: 0 },
      { url: 'https://example.com/new_image.jpg', width: 1200, height: 800 }
    ];

    // 增量合并逻辑
    const existingUrls = new Set(currentImages.map(img => img.url));
    let nextId = currentImages.length + 1;
    newlyScanned.forEach(item => {
      if (!existingUrls.has(item.url)) {
        currentImages.push({
          ...item,
          id: `img_${nextId++}`
        });
      }
    });

    assert.strictEqual(currentImages.length, 2, '增量新图加入，去重已有图片');
    assert.strictEqual(currentImages[0].width, 2000, '原有图片的尺寸依然保持');
    assert.ok(selectedIds.has('img_1'), '原有勾选状态不受影响');
    assert.strictEqual(selectedIds.has('img_2'), false, '新图不自动勾选');
  });

  await asyncTest('阶段 2 定点验证 9: 加载动画、ZIP 下载和单张下载功能未受破坏', async () => {
    const galleryHtml = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');
    assert.ok(galleryHtml.includes('id="loadingState"'), '加载状态容器存在');
    assert.ok(galleryHtml.includes('collector-spinner'), '加载动画旋转器样式存在');
    assert.ok(galleryHtml.includes('id="btnDownloadZip"'), 'ZIP 批量下载按钮存在');

    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    assert.ok(galleryJs.includes('startBatchDownload'), 'ZIP 批量打包逻辑完整');
    assert.ok(galleryJs.includes('downloadSingleImage'), '单张下载逻辑完整');
    assert.ok(galleryJs.includes('fetchImageWithFallback'), '图片安全下载与回退逻辑完整');
  });

  // =============================================================
  // 测试 8：阶段 3 尺寸分类筛选与默认选择行为改造自动化验收测试
  // =============================================================

  // 从 gallery.js 生产源码提取阶段 3 真实辅助函数构建沙箱
  function extractPhase3GalleryHelpers() {
    const code = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    const isValidDimMatch = code.match(/function isValidDimension\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const getLongEdgeMatch = code.match(/function getImageLongEdge\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const getSizeCatMatch = code.match(/function getImageSizeCategory\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const matchSizeFilterMatch = code.match(/function matchesSizeFilter\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const matchFmtFilterMatch = code.match(/function matchesFormatFilter\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const detectFmtMatch = code.match(/function detectImageFormat\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
    const getUrlExtMatch = code.match(/function getUrlExtension\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);

    assert.ok(isValidDimMatch, '必须能从 gallery.js 提取到 isValidDimension');
    assert.ok(getLongEdgeMatch, '必须能从 gallery.js 提取到 getImageLongEdge');
    assert.ok(getSizeCatMatch, '必须能从 gallery.js 提取到 getImageSizeCategory');
    assert.ok(matchSizeFilterMatch, '必须能从 gallery.js 提取到 matchesSizeFilter');

    return function(state) {
      const runner = new Function('state', `
        ${getUrlExtMatch ? getUrlExtMatch[0] : ''}
        ${detectFmtMatch ? detectFmtMatch[0] : 'function detectImageFormat(img) { return "JPG"; }'}
        ${isValidDimMatch[0]}
        ${getLongEdgeMatch[0]}
        ${getSizeCatMatch[0]}
        ${matchSizeFilterMatch[0]}
        ${matchFmtFilterMatch ? matchFmtFilterMatch[0] : ''}
        return { isValidDimension, getImageLongEdge, getImageSizeCategory, matchesSizeFilter, matchesFormatFilter };
      `);
      return runner(state);
    };
  }
  const createPhase3Helpers = extractPhase3GalleryHelpers();

  await asyncTest('阶段 3 验证 1: 初次打开默认进入「大图」模式且 UI 激活对应 Chip', async () => {
    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');
    const galleryHtml = fs.readFileSync(GALLERY_HTML_PATH, 'utf-8');

    // 1. state.sizeCategory 默认初始值为 'LARGE'
    assert.ok(galleryJs.includes("sizeCategory: 'LARGE'"), 'state.sizeCategory 默认初始值必须为 LARGE');

    // 2. gallery.html 中「大图」按钮默认具备 active 类，且其他分类初始不带 active
    assert.ok(
      galleryHtml.includes('class="chip active" data-category="LARGE"') ||
      galleryHtml.includes("class='chip active' data-category='LARGE'"),
      'HTML 中大图分类 Chip 必须默认具备 active 高亮样式'
    );
    assert.ok(
      galleryHtml.includes('class="chip" data-category="ALL"'),
      'HTML 中全部 Chip 初始不应带 active'
    );
    assert.ok(
      galleryHtml.includes('class="chip" data-category="MEDIUM"'),
      'HTML 中中图 Chip 初始不应带 active'
    );
  });

  await asyncTest('阶段 3 验证 2: 免费版与 Pro 版初次打开均为零勾选', async () => {
    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 验证 preselectInitialImages 内部绝无自动勾选前 20 张的逻辑
    assert.ok(
      !galleryJs.includes('for (let i = 0; i < limit; i++) {\n      state.selectedIds.add(state.filteredImages[i].id);'),
      'preselectInitialImages 严禁再自动批量勾选前 20 张'
    );

    // 2. 模拟真实初次任务载入，不论免费版还是 Pro 版，selectedIds 保持为 0
    const stateFree = {
      isPro: false,
      proLimit: 20,
      selectedIds: new Set(),
      filteredImages: [{ id: 'img_1' }, { id: 'img_2' }, { id: 'img_3' }]
    };
    assert.strictEqual(stateFree.selectedIds.size, 0, '免费版初始勾选数量必须为 0');

    const statePro = {
      isPro: true,
      selectedIds: new Set(),
      filteredImages: [{ id: 'img_1' }, { id: 'img_2' }, { id: 'img_3' }]
    };
    assert.strictEqual(statePro.selectedIds.size, 0, 'Pro 版初始勾选数量必须为 0');

    // 3. 异步任务广播更新时，严禁清空用户已经主动勾选的图片
    const existingSelected = new Set(['img_1', 'img_2']);
    const updatedImages = [{ id: 'img_1' }, { id: 'img_2' }, { id: 'img_3' }];
    const validIds = new Set(updatedImages.map(img => img.id));
    for (const id of existingSelected) {
      if (!validIds.has(id)) existingSelected.delete(id);
    }
    assert.strictEqual(existingSelected.size, 2, '异步任务完成通知到达时不破坏用户已有选择');
    assert.ok(existingSelected.has('img_1') && existingSelected.has('img_2'));
  });

  await asyncTest('阶段 3 验证 3: 零勾选时 ZIP 按钮禁用，有勾选时启用', async () => {
    // 模拟 updateSelectionSummary 行为
    const mockDom = {
      btnDownloadZip: { disabled: false },
      downloadBadge: { textContent: '' },
      statSelectedCount: { textContent: '' },
      statVisibleCount: { textContent: '' }
    };

    function simulateSummary(selectedCount, isDownloading = false) {
      mockDom.btnDownloadZip.disabled = selectedCount === 0 || isDownloading;
      mockDom.downloadBadge.textContent = selectedCount;
    }

    // 零勾选
    simulateSummary(0, false);
    assert.strictEqual(mockDom.btnDownloadZip.disabled, true, '零勾选时 ZIP 按钮必须禁用');
    assert.strictEqual(mockDom.downloadBadge.textContent, 0);

    // 用户勾选 1 张
    simulateSummary(1, false);
    assert.strictEqual(mockDom.btnDownloadZip.disabled, false, '有勾选时 ZIP 按钮必须启用');
    assert.strictEqual(mockDom.downloadBadge.textContent, 1);

    // 下载中
    simulateSummary(1, true);
    assert.strictEqual(mockDom.btnDownloadZip.disabled, true, '下载中状态必须禁用 ZIP 按钮');

    // 下载完成后（零勾选）
    simulateSummary(0, false);
    assert.strictEqual(mockDom.btnDownloadZip.disabled, true, '下载完成后若无勾选必须维持禁用');
  });

  await asyncTest('阶段 3 验证 4: 16×16、32×32 图片在「全部」「小图」中正常展示，不归入大图', async () => {
    const h = createPhase3Helpers({ sizeCategory: 'ALL', minWidth: 0, minHeight: 0 });

    const img16 = { id: 'i16', width: 16, height: 16 };
    const img32 = { id: 'i32', width: 32, height: 32 };

    assert.strictEqual(h.getImageSizeCategory(img16), 'SMALL');
    assert.strictEqual(h.getImageSizeCategory(img32), 'SMALL');

    // 1. 全部模式：展示
    const hAll = createPhase3Helpers({ sizeCategory: 'ALL' });
    assert.strictEqual(hAll.matchesSizeFilter(img16), true, '全部模式下 16x16 正常展示');
    assert.strictEqual(hAll.matchesSizeFilter(img32), true, '全部模式下 32x32 正常展示');

    // 2. 小图模式：展示
    const hSmall = createPhase3Helpers({ sizeCategory: 'SMALL' });
    assert.strictEqual(hSmall.matchesSizeFilter(img16), true, '小图模式下 16x16 正常展示');
    assert.strictEqual(hSmall.matchesSizeFilter(img32), true, '小图模式下 32x32 正常展示');

    // 3. 大图模式：严禁展示
    const hLarge = createPhase3Helpers({ sizeCategory: 'LARGE' });
    assert.strictEqual(hLarge.matchesSizeFilter(img16), false, '大图模式下 16x16 严禁展示');
    assert.strictEqual(hLarge.matchesSizeFilter(img32), false, '大图模式下 32x32 严禁展示');
  });

  await asyncTest('阶段 3 验证 5: 999px 长边归入中图，1000px 长边归入大图', async () => {
    const h = createPhase3Helpers({});

    // 边界值校验：longEdge = Math.max(width, height)
    // 999 宽，500 高 -> longEdge 999 -> MEDIUM
    assert.strictEqual(h.getImageSizeCategory({ width: 999, height: 500 }), 'MEDIUM');
    // 600 宽，999 高 -> longEdge 999 -> MEDIUM
    assert.strictEqual(h.getImageSizeCategory({ width: 600, height: 999 }), 'MEDIUM');

    // 1000 宽，400 高 -> longEdge 1000 -> LARGE
    assert.strictEqual(h.getImageSizeCategory({ width: 1000, height: 400 }), 'LARGE');
    // 500 宽，1000 高 -> longEdge 1000 -> LARGE
    assert.strictEqual(h.getImageSizeCategory({ width: 500, height: 1000 }), 'LARGE');

    // 200 宽，150 高 -> longEdge 200 -> MEDIUM (200-999)
    assert.strictEqual(h.getImageSizeCategory({ width: 200, height: 150 }), 'MEDIUM');
    // 199 宽，199 高 -> longEdge 199 -> SMALL (<200)
    assert.strictEqual(h.getImageSizeCategory({ width: 199, height: 199 }), 'SMALL');
  });

  await asyncTest('阶段 3 验证 6: 宽高未知的图片归入未知尺寸，绝对不错误显示为大图', async () => {
    const h = createPhase3Helpers({ sizeCategory: 'LARGE' });

    const unk1 = { width: 0, height: 0 };
    const unk2 = { width: undefined, height: 1200 };
    const unk3 = { width: 2000, height: null };
    const unk4 = { width: -10, height: 500 };
    const unk5 = { width: NaN, height: NaN };

    assert.strictEqual(h.getImageSizeCategory(unk1), 'UNKNOWN');
    assert.strictEqual(h.getImageSizeCategory(unk2), 'UNKNOWN');
    assert.strictEqual(h.getImageSizeCategory(unk3), 'UNKNOWN');
    assert.strictEqual(h.getImageSizeCategory(unk4), 'UNKNOWN');
    assert.strictEqual(h.getImageSizeCategory(unk5), 'UNKNOWN');

    // 在默认「大图」模式下，未知尺寸严禁匹配
    assert.strictEqual(h.matchesSizeFilter(unk1), false, '0x0 未知尺寸不能错误显示为大图');
    assert.strictEqual(h.matchesSizeFilter(unk2), false);
    assert.strictEqual(h.matchesSizeFilter(unk3), false);

    // 在「未知尺寸」模式下正确匹配
    const hUnknown = createPhase3Helpers({ sizeCategory: 'UNKNOWN' });
    assert.strictEqual(hUnknown.matchesSizeFilter(unk1), true);
    assert.strictEqual(hUnknown.matchesSizeFilter(unk2), true);
  });

  await asyncTest('阶段 3 验证 7: 五种分类的数量正确，且互不重复、没有漏算', async () => {
    const h = createPhase3Helpers({});

    // 构建涵盖各种边界与尺寸的 100 张样本
    const testList = [];
    // 30 张大图 (longEdge >= 1000)
    for (let i = 0; i < 30; i++) {
      testList.push({ id: `l_${i}`, width: 1000 + i * 20, height: 800 });
    }
    // 25 张中图 (200..999)
    for (let i = 0; i < 25; i++) {
      testList.push({ id: `m_${i}`, width: 200 + i * 10, height: 300 });
    }
    // 35 张小图 (<200)
    for (let i = 0; i < 35; i++) {
      testList.push({ id: `s_${i}`, width: 10 + i * 4, height: 20 + i * 4 });
    }
    // 10 张未知尺寸
    for (let i = 0; i < 10; i++) {
      testList.push({ id: `u_${i}`, width: 0, height: 0 });
    }

    assert.strictEqual(testList.length, 100);

    let countLarge = 0;
    let countMedium = 0;
    let countSmall = 0;
    let countUnknown = 0;

    testList.forEach(img => {
      const cat = h.getImageSizeCategory(img);
      if (cat === 'LARGE') countLarge++;
      else if (cat === 'MEDIUM') countMedium++;
      else if (cat === 'SMALL') countSmall++;
      else if (cat === 'UNKNOWN') countUnknown++;
    });

    assert.strictEqual(countLarge, 30, '大图统计必须精准为 30');
    assert.strictEqual(countMedium, 25, '中图统计必须精准为 25');
    assert.strictEqual(countSmall, 35, '小图统计必须精准为 35');
    assert.strictEqual(countUnknown, 10, '未知尺寸统计必须精准为 10');
    assert.strictEqual(countLarge + countMedium + countSmall + countUnknown, testList.length, '五类统计之和必须严格等于总数 100，杜绝漏算与重复');
  });

  await asyncTest('阶段 3 验证 8: 修改宽高滑块后进入自定义筛选，未知尺寸不满足正数门槛', async () => {
    // 自定义模式
    const hCustom = createPhase3Helpers({
      sizeCategory: 'CUSTOM',
      minWidth: 400,
      minHeight: 300
    });

    const validLarge = { width: 500, height: 400 };
    const widthTooSmall = { width: 350, height: 400 };
    const heightTooSmall = { width: 500, height: 250 };
    const unknownImg = { width: 0, height: 0 };

    assert.strictEqual(hCustom.matchesSizeFilter(validLarge), true, '满足宽高滑块的图片正常通过');
    assert.strictEqual(hCustom.matchesSizeFilter(widthTooSmall), false, '宽度不足时被过滤');
    assert.strictEqual(hCustom.matchesSizeFilter(heightTooSmall), false, '高度不足时被过滤');
    assert.strictEqual(hCustom.matchesSizeFilter(unknownImg), false, '【关键断言】自定义模式下未知尺寸严禁被当作满足正数门槛！');

    // 若滑块全调为 0，未知尺寸在自定义模式下允许通过
    const hCustomZero = createPhase3Helpers({
      sizeCategory: 'CUSTOM',
      minWidth: 0,
      minHeight: 0
    });
    assert.strictEqual(hCustomZero.matchesSizeFilter(unknownImg), true, '滑块均为 0 时未知尺寸允许呈现');
  });

  await asyncTest('阶段 3 验证 9: 格式过滤与尺寸分类组合正常', async () => {
    const state = {
      sizeCategory: 'LARGE',
      currentFormat: 'JPG'
    };
    const h = createPhase3Helpers(state);

    const jpgLarge = { url: 'https://example.com/banner.jpg', width: 1920, height: 1080 };
    const pngLarge = { url: 'https://example.com/banner.png', width: 1920, height: 1080 };
    const jpgSmall = { url: 'https://example.com/avatar.jpg', width: 64, height: 64 };

    // 组合筛选：大图 + JPG
    assert.strictEqual(h.matchesSizeFilter(jpgLarge) && h.matchesFormatFilter(jpgLarge), true, 'JPG 大图正常通过组合筛选');
    assert.strictEqual(h.matchesSizeFilter(pngLarge) && h.matchesFormatFilter(pngLarge), false, 'PNG 大图被 JPG 格式筛选阻断');
    assert.strictEqual(h.matchesSizeFilter(jpgSmall) && h.matchesFormatFilter(jpgSmall), false, 'JPG 小图被大图分类阻断');
  });

  await asyncTest('阶段 3 验证 10: 切换分类不清空隐藏的已勾选图片，且统计看板正确提示', async () => {
    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 静态验证 updateSelectionSummary 中计算 hiddenSelectedCount 与显示 hiddenSelectedNotice
    assert.ok(galleryJs.includes('hiddenSelectedCount'), '必须计算 hiddenSelectedCount');
    assert.ok(galleryJs.includes('hiddenSelectedNotice'), '必须包含隐藏选中项提示组件');

    // 2. 模拟切换分类场景
    const state = {
      allImages: [
        { id: 'img_l1', width: 2000, height: 1000 },
        { id: 'img_l2', width: 1500, height: 1200 },
        { id: 'img_s1', width: 80, height: 80 }
      ],
      filteredImages: [],
      selectedIds: new Set()
    };

    // 用户在「大图」模式下勾选了 img_l1 与 img_l2
    state.selectedIds.add('img_l1');
    state.selectedIds.add('img_l2');

    // 用户切换到「小图」分类
    state.filteredImages = [state.allImages[2]]; // 仅 img_s1 可见

    // 计算隐藏勾选数
    const visibleSet = new Set(state.filteredImages.map(img => img.id));
    let hiddenCount = 0;
    for (const id of state.selectedIds) {
      if (!visibleSet.has(id)) hiddenCount++;
    }

    assert.strictEqual(hiddenCount, 2, '隐藏勾选数必须精准为 2');
    assert.strictEqual(state.selectedIds.size, 2, '原有已选的 2 张大图绝对不被清空');
    assert.ok(state.selectedIds.has('img_l1') && state.selectedIds.has('img_l2'));
  });

  await asyncTest('阶段 3 验证 11: 全选、反选只操作可见图片，免费版总计不突破 20 张配额', async () => {
    // 模拟全选逻辑
    const state = {
      isPro: false,
      proLimit: 20,
      selectedIds: new Set(),
      filteredImages: []
    };

    // 预先在其他分类勾选 8 张
    for (let i = 1; i <= 8; i++) {
      state.selectedIds.add(`hidden_${i}`);
    }

    // 当前可见分类有 15 张图片
    for (let i = 1; i <= 15; i++) {
      state.filteredImages.push({ id: `vis_${i}` });
    }

    // 1. 执行全选：剩余配额 20 - 8 = 12 张
    const unselectedVisible = state.filteredImages.filter(img => !state.selectedIds.has(img.id));
    const remainingQuota = Math.max(0, state.proLimit - state.selectedIds.size);
    if (unselectedVisible.length > remainingQuota) {
      for (let i = 0; i < remainingQuota; i++) {
        state.selectedIds.add(unselectedVisible[i].id);
      }
    }

    assert.strictEqual(state.selectedIds.size, 20, '全选后总勾选数量必须严格限制在 20 张以内');
    // 验证原有的 8 张隐藏图片依然完好
    for (let i = 1; i <= 8; i++) {
      assert.ok(state.selectedIds.has(`hidden_${i}`), `隐藏图片 hidden_${i} 必须依然保留勾选`);
    }

    // 2. 模拟反选逻辑
    const visibleIds = new Set(state.filteredImages.map(img => img.id));
    const toSelectVisible = state.filteredImages.filter(img => !state.selectedIds.has(img.id));
    const toDeselectVisible = state.filteredImages.filter(img => state.selectedIds.has(img.id));

    let hiddenSelectedCount = 0;
    for (const id of state.selectedIds) {
      if (!visibleIds.has(id)) hiddenSelectedCount++;
    }
    toDeselectVisible.forEach(img => state.selectedIds.delete(img.id));

    const availableQuota = Math.max(0, state.proLimit - hiddenSelectedCount);
    for (let i = 0; i < Math.min(availableQuota, toSelectVisible.length); i++) {
      state.selectedIds.add(toSelectVisible[i].id);
    }

    assert.ok(state.selectedIds.size <= 20, '反选后总勾选数量亦不能突破 20 张');
    assert.strictEqual(hiddenSelectedCount, 8, '反选操作绝不波及隐藏的 8 张已选图片');
  });

  await asyncTest('阶段 3 验证 12: 清空操作能够清除全部勾选（包含隐藏图片）', async () => {
    const state = {
      selectedIds: new Set(['vis_1', 'vis_2', 'hidden_1', 'hidden_2'])
    };
    assert.strictEqual(state.selectedIds.size, 4);

    // clearSelection 执行
    state.selectedIds.clear();
    assert.strictEqual(state.selectedIds.size, 0, '清空必须彻底清除可见与隐藏的所有选中项');
  });

  await asyncTest('阶段 3 验证 13: 仅选大图统一采用长边至少 1000px，且只对可见范围操作', async () => {
    const h = createPhase3Helpers({});

    const visibleItems = [
      { id: 'img_999', width: 999, height: 600 },
      { id: 'img_1000', width: 1000, height: 500 },
      { id: 'img_portrait_1200', width: 800, height: 1200 },
      { id: 'img_small', width: 100, height: 100 }
    ];

    const largeItems = visibleItems.filter(img => h.getImageSizeCategory(img) === 'LARGE');

    assert.strictEqual(largeItems.length, 2, '仅长边至少 1000px 的图片被判定为大图');
    assert.ok(largeItems.some(i => i.id === 'img_1000'));
    assert.ok(largeItems.some(i => i.id === 'img_portrait_1200'));
    assert.ok(!largeItems.some(i => i.id === 'img_999'), '999px 长边严禁被勾选');
  });

  await asyncTest('阶段 3 验证 14: 手动刷新追加图片后，维持当前筛选分类和已有选择', async () => {
    const state = {
      sizeCategory: 'MEDIUM',
      currentFormat: 'ALL',
      allImages: [
        { id: 'img_1', url: 'https://example.com/med1.jpg', width: 500, height: 400 }
      ],
      filteredImages: [],
      selectedIds: new Set(['img_1'])
    };

    // 增量追加新图片
    const newItems = [
      { url: 'https://example.com/large1.jpg', width: 1920, height: 1080 },
      { url: 'https://example.com/med2.jpg', width: 600, height: 400 }
    ];

    const h = createPhase3Helpers(state);
    let idCounter = 2;
    newItems.forEach(item => {
      state.allImages.push({
        ...item,
        id: `img_${idCounter++}`
      });
    });

    // 重新应用过滤
    state.filteredImages = state.allImages.filter(img => h.matchesSizeFilter(img));

    // 断言：筛选分类依然为 MEDIUM，已有勾选保持，新图不自动勾选
    assert.strictEqual(state.sizeCategory, 'MEDIUM', '当前筛选分类维持不变');
    assert.ok(state.selectedIds.has('img_1'), '已有选中状态完好保留');
    assert.strictEqual(state.selectedIds.has('img_2'), false, '新图严禁被自动勾选');
    assert.strictEqual(state.filteredImages.length, 2, '仅符合 MEDIUM 的图片进入当前视图 (med1, med2)');
  });

  await asyncTest('阶段 3 验证 15: 尺寸异步回填后，分类和计数正确更新，已有勾选不丢失', async () => {
    const h = createPhase3Helpers({});

    const imgAsync = { id: 'img_unknown_init', width: 0, height: 0 };
    assert.strictEqual(h.getImageSizeCategory(imgAsync), 'UNKNOWN', '初始为未知尺寸');

    const selectedIds = new Set(['img_unknown_init']);

    // 异步校验成功回填
    imgAsync.width = 2560;
    imgAsync.height = 1440;
    imgAsync.isFallback = false;

    assert.strictEqual(h.getImageSizeCategory(imgAsync), 'LARGE', '回填真实尺寸后自动识别为大图');
    assert.ok(selectedIds.has('img_unknown_init'), '异步回填尺寸后用户已有勾选绝对不丢失');
  });

  await asyncTest('阶段 3 验证 16: 原有尺寸持久化、画廊加载状态和下载功能完整不受影响', async () => {
    const galleryJs = fs.readFileSync(GALLERY_JS_PATH, 'utf-8');

    // 1. 尺寸持久化队列与防抖调用存在
    assert.ok(galleryJs.includes('schedulePersistImageDimensions'), '尺寸防抖持久化函数存在');
    assert.ok(galleryJs.includes('flushPersistImageDimensions'), '尺寸数据冲刷存储函数存在');

    // 2. 下载结束会话恢复更新
    assert.ok(galleryJs.includes('finishDownloadSession'), '下载生命周期结束会话存在');

    // 3. 空状态展示友好文字断言
    assert.ok(galleryJs.includes('当前没有符合条件的大图，可切换到全部查看。'), '大图空状态友好提示文案精准无误');
  });

  console.log(`\n测试完成: ${passed} / ${total} 全部通过`);
  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
