// caret-gutter-verify.cjs
// 验证 v1.117「右侧空白带」命中纠正：
//   桌面 Chromium 不会把右侧空白带点按翻到上一块（它直接夹到行尾），所以本脚本
//   通过给 view.posAtCoords 打补丁「模拟 WebView 误翻」（右侧空白带返回上一块位置），
//   再走完整点击链路，断言最终光标落在本行行尾而非上一块行首。
const { chromium } = require('playwright');

const HTML = 'file:///workspace/MDNote/app/src/main/assets/editor/editor.html';

const MD = [
  '# 任务清单',
  '- [ ] 第一步',
  '- [ ] 第二步',
  '- [ ] 第三步',
  '正文一段用来占位的较长文本较长文本较长文本较长文本较长文本较长文本较长文本很长会折行到第二行。',
].join('\n');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/chromium' });
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  // 在 bundle 执行前置位调试标志，暴露 window.__mdnoteDebug
  await page.addInitScript(() => { window.__MDNOTE_DEBUG__ = true; });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));

  await page.goto(HTML);
  await page.waitForFunction(() => window.__mdnoteDebug && window.__mdnoteDebug.getView && window.__mdnoteDebug.getView(), { timeout: 10000 });
  await page.evaluate((md) => window.editor.loadMarkdown(md, null, false), MD);
  await page.waitForTimeout(150);

  // 计算「第一步」这一短任务行的文本右缘与 gutter 坐标（用 Range 取文本行盒）
  const geo = await page.evaluate(() => {
    const dbg = window.__mdnoteDebug;
    const view = dbg.getView();
    const lis = Array.from(view.dom.querySelectorAll('li.md-task'));
    const li = lis.find((el) => el.textContent.includes('第一步'));
    const p = li.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    const rects = Array.from(range.getClientRects());
    const r = rects[rects.length - 1];   // 末行文本行盒
    const textRight = r.right;
    return {
      textRight,
      top: r.top, bottom: r.bottom,
      y: (r.top + r.bottom) / 2,
      docSize: view.state.doc.content.size,
    };
  });
  const GUTTER_X = geo.textRight + 80;     // 文本右侧 80px 的空白带
  const GUT = geo.textRight + 30;          // 误翻阈值：x>=GUT 视为右侧空白带
  const Y = geo.y;

  // 先拿到「正确」答案：未打补丁时，夹到行内 (textRight-2) 的 posAtCoords = 本行行尾
  const EXPECTED = await page.evaluate(({ x, y }) => {
    const view = window.__mdnoteDebug.getView();
    const a = view.posAtCoords({ left: x, top: y });
    return a ? a.pos : null;
  }, { x: geo.textRight - 2, y: Y });

  // 计算「上一块」（误翻应落到的位置）—— 取紧邻「第一步」之前的文本块起点
  const PREV = await page.evaluate((exp) => {
    const dbg = window.__mdnoteDebug;
    const view = dbg.getView();
    const doc = view.state.doc;
    const $ = doc.resolve(exp);
    let d = $.depth;
    while (d > 0 && !$.node(d).isTextblock) d--;
    if (d <= 0) return 1;
    const before = $.before(d);
    const $p = doc.resolve(Math.max(0, before - 1));
    for (let dd = $p.depth; dd > 0; dd--) {
      if ($p.node(dd).isTextblock) return $p.before(dd);
    }
    return 1;
  }, EXPECTED);

  // 打补丁：模拟 WebView 误翻（右侧空白带点按 → 上一块位置）
  await page.evaluate(({ GUT, PREV }) => {
    const view = window.__mdnoteDebug.getView();
    const real = view.posAtCoords.bind(view);
    view.__realPosAtCoords = real;
    view.posAtCoords = (coords) => {
      if (coords.left >= GUT) return { pos: PREV };   // 误翻到上一块
      return real(coords);                            // 行内正常
    };
  }, { GUT: GUT, PREV: PREV });

  // ---- Test A：resolveTapPos 几何纠正 ----
  const A = await page.evaluate(({ x, y }) => window.__mdnoteDebug.resolveTapPos(window.__mdnoteDebug.getView(), x, y),
    { x: GUTTER_X, y: Y });

  // ---- Test B：完整点击链路（用真实 mouse 事件触发 PM）→ 最终光标 ----
  await page.mouse.click(GUTTER_X, Y);
  await page.waitForTimeout(60);
  const HEAD_B = await page.evaluate(() => window.__mdnoteDebug.getView().state.selection.head);

  // ---- Test C：回归——正文段落「行内」点按（非右侧空白带）不应被误改 ----
  const C = await page.evaluate(() => {
    const dbg = window.__mdnoteDebug;
    const view = dbg.getView();
    const ps = Array.from(view.dom.querySelectorAll('p'));
    const bodyP = ps.find((p) => p.textContent.includes('正文一段'));
    const range = document.createRange();
    range.selectNodeContents(bodyP);
    const rects = Array.from(range.getClientRects());
    const r = rects[0];                       // 正文首行文本行盒
    const x = (r.left + r.right) / 2;          // 行内中点（文字上，非空白带）
    const y = (r.top + r.bottom) / 2;
    const rr = dbg.resolveTapPos(view, x, y);
    // 正文块起点（用于判断 pos 是否落在正文而非误翻到别处）
    const bodyStart = dbg.blockStart(view.state.doc, rr.pos);
    return { x: Math.round(x), y: Math.round(y), pos: rr.pos, gutter: rr.gutter, bodyStart };
  });

  await browser.close();

  const pass =
    A.pos === EXPECTED && A.gutter === true &&
    HEAD_B === EXPECTED &&
    C.gutter === false && C.pos != null && C.bodyStart >= 0;

  console.log('=== 验证结果 ===');
  console.log('文本右缘 textRight   =', geo.textRight.toFixed(1));
  console.log('本行行尾 EXPECTED    =', EXPECTED, '  上一块 PREV =', PREV);
  console.log('Test A resolveTapPos =', JSON.stringify(A), ' (期望 pos=' + EXPECTED + ', gutter=true)');
  console.log('Test B 点击后 head   =', HEAD_B, ' (期望=' + EXPECTED + ', 即本行行尾而非 PREV)');
  console.log('Test C 折行行内点按  =', JSON.stringify(C), ' (期望 gutter=false, 不误改)');
  console.log(pass ? 'RESULT: PASS ✅' : 'RESULT: FAIL ❌');
  if (!pass) { console.log('--- 相关日志 ---'); logs.slice(-12).forEach((l) => console.log(l)); }
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
