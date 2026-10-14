// bridge.js — window.editor 桥接层（与旧 editor-vditor.js 同名同协议，Kotlin 零改动）
//
// 协议（对照 EditorController.kt 调用清单，逐一保留）：
//   loadMarkdown/getSource/stat/probe/enterEditAt/exitEditMode/applyTheme/
//   insertImage/toggleSourceMode/undo/redo/onIme/focus/blur/insertText/
//   wrapSelection/applyLinePrefix/softBreak/indentLine/outdentLine/
//   setToolbarConfig/rebuildToolbar
// 语义变化（design.md D3）：
//   undo/redo 直通 PM history（不再发 JS→Kotlin 事件，Kotlin 快照栈退役）；
//   loadMarkdown = 新建 EditorState（历史随之重置）。
// 队列：pushEvent(m,a) → stat().q 出队，仅剩 pickImage 一个事件源。

import { EditorState, TextSelection } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undoDepth, redoDepth } from 'prosemirror-history';
import { mdnotesSchema as schema, emptyParagraph, isEmptyDoc } from './schema.js';
import { createParser, renderRawHtml } from './mdparse.js';
import { createSerializer } from './mdser.js';
import {
  buildKeymap, indentCommand, outdentCommand, pmUndo, pmRedo,
  toggleMark, wrapIn, toggleList, toggleHeading, toggleCodeBlock,
  insertHr, toggleLink, toggleTaskItem,
} from './commands.js';
import { buildInputRules } from './inputrules.js';
import { createToolbar } from './toolbar.js';
import { DEFAULT_TOOLS, icon } from './icons.js';
import katex from 'katex';

const IMG_SRC_PREFIX = 'img://';

// ---- 全局状态（对齐旧版命名） ----
let view = null;
let ready = false;
let editing = false;
let sourceMode = false;
let pendingValue = '';
let pendingTheme = null;
let pendingFocus = false;
let currentNight = false;
let __toolbarCfg = null;
let __jsQueue = [];
const indentOps = { en: 0, ok: 0, er: 0 };
let indentDiag = '';
let dockUpdate = function () {};
let editorImePush = null;

const parser = createParser(schema);
const serializer = createSerializer(schema);

function safe(fn) { try { return fn(); } catch (e) { return null; } }

function pushEvent(m, a) { __jsQueue.push({ m: m, a: a || '' }); }

// ---- 源码往返 ----

function getSource() {
  if (sourceMode) {
    const ta = document.getElementById('md-source');
    return ta ? ta.value : pendingValue;
  }
  if (view && ready) return safe(() => serializer.serialize(view.state.doc)) || pendingValue;
  return pendingValue;
}

// ---- 任务项 checkbox 点击切换（渲染 DOM 里 .md-task-box 由 CSS 画框） ----

const taskTogglePlugin = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const t = event.target;
        if (!t || !t.classList || !t.classList.contains('md-task-box')) return false;
        event.preventDefault();
        const liDom = t.closest && t.closest('li.md-task');
        if (!liDom) return true;
        const pos = view.posAtDOM(liDom, 0);
        const $pos = view.state.doc.resolve(pos);
        for (let d = $pos.depth; d > 0; d--) {
          const n = $pos.node(d);
          if (n.type.name === 'list_item' && n.attrs.checked !== null) {
            view.dispatch(view.state.tr
              .setNodeMarkup($pos.before(d), null, { checked: !n.attrs.checked })
              .scrollIntoView());
            return true;
          }
        }
        return true;
      },
    },
  },
});

// ---- table_block / raw_block 只读 NodeView（markdown-it 渲染原文，D2） ----

function rawView(node) {
  const dom = document.createElement('div');
  dom.className = 'md-raw';
  dom.setAttribute('data-md-raw', '1');
  dom.contentEditable = 'false';
  dom.innerHTML = renderRawHtml(node.attrs.raw || '');
  return { dom, stopEvent: () => true };
}

// ---- 公式 NodeView：KaTeX 渲染（离线，字体由 editor.html 引入的 katex.min.css 提供） ----
// 渲染失败（语法错误）时退回纯文本原文，绝不静默消失。

function mathView(node) {
  const disp = node.type.name === 'math_block';
  const dom = document.createElement(disp ? 'div' : 'span');
  dom.className = disp ? 'md-math-block' : 'md-math-inline';
  const latex = node.attrs.latex || '';
  try {
    dom.innerHTML = katex.renderToString(latex, {
      displayMode: disp,
      throwOnError: false,
      output: 'htmlAndMathml',
      trust: false,
      strict: false,
    });
  } catch (e) {
    dom.textContent = (disp ? '$$' : '$') + latex + (disp ? '$$' : '$');
  }
  return { dom, stopEvent: () => true };
}

const nodeViews = {
  table_block: rawView,
  raw_block: rawView,
  math_block: mathView,
  math_inline: mathView,
};

// ---- EditorState 装配 ----

/** 撤销/前进历史插件：模块级单例，桥据此上报栈深度（顶栏按钮点亮） */
const historyPlugin = history();

// 鲁棒地取「文档末尾 text 选区」：文档以 atom/NodeView（math_block/raw_block/
// table_block 等）结尾时，TextSelection.atEnd 可能抛异常或落在非法边界；
// 逐字符倒退寻找最后一个合法 text 位置，找不到才退回开头(pos 1)。
// 这是「打开/重载笔记本该在末尾、却跳到开头」的关键兜底——旧实现 atEnd
// 失败时直接保留默认开头选区(pos 1)，遇到 atom 结尾笔记必现。
function endSelection(doc) {
  try { return TextSelection.atEnd(doc); } catch (e) {
    console.warn('[caret] TextSelection.atEnd failed (atom/NodeView end?), fallback near-end: ' + (e && e.message));
  }
  for (let p = doc.content.size; p >= 1; p--) {
    try { return TextSelection.create(doc, p); } catch (e) { /* try prev */ }
  }
  console.warn('[caret] no valid end position found, using start(pos 1)');
  return TextSelection.create(doc, 1);
}

function makeState(src, sel) {
  const doc = safe(() => parser.parse(src || '')) || emptyParagraph();
  let state = EditorState.create({
    doc,
    plugins: [historyPlugin, taskTogglePlugin, buildInputRules(schema), keymap(buildKeymap(schema))],
  });
  // 载入后把光标放到末尾（用户预期「打开笔记接着写」在末尾）。
  // sel 为 ProseMirror 文档位置（doc 字符数）：Kotlin 经 loadMarkdown/enterEditAt 传入；
  // 合法且落在文档内则落到该位置，否则落到文档末尾（鲁棒，见 endSelection）。
  try {
    if (sel && Number.isFinite(sel) && sel > 0) {
      const pos = Math.max(1, Math.min(Math.floor(sel), doc.content.size - 1));
      state = state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
    } else {
      state = state.apply(state.tr.setSelection(endSelection(doc)));
    }
  } catch (e) {
    console.warn('[caret] makeState selection failed, keep default (start): ' + (e && e.message));
  }
  return state;
}

// v1.110：描述一次点击命中的语义元素（用于 [caret] click 打点）
function describeHit(node) {
  if (!node || !node.closest) return 'none';
  const c = node.classList || {};
  if (c.contains && c.contains('md-math-inline')) return 'math-inline';
  if (c.contains && c.contains('md-math-block')) return 'math-block';
  if (c.contains && c.contains('md-task-box')) return 'task-box';
  if (node.tagName === 'IMG') return 'image';
  if (node.tagName === 'A') return 'link';
  if (node.closest('table')) return 'table';
  if (node.closest('li.md-task')) return 'task-item';
  if (node.closest('LI')) return 'list-item';
  if (node.closest('BLOCKQUOTE')) return 'quote';
  if (node.closest('PRE')) return 'code-block';
  if (node.closest('H1,H2,H3,H4,H5,H6')) return 'heading';
  if (node.closest('P')) return 'paragraph';
  return (node.tagName || 'node').toLowerCase();
}

// 返回 pos 所在文本块（段落/列表项正文等）的起始位置，用作「落在哪一行」的块标识。
// 跨块校正时用它判断是否落错了行/项。
function blockStart(doc, pos) {
  try {
    const $ = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
    for (let d = $.depth; d > 0; d--) {
      if ($.node(d).isTextblock) return $.before(d);
    }
  } catch (_) {}
  return -1;
}

// ============================================================
// v1.117：Android WebView 在「文本右侧空白带」点按时，原生命中测试
// (caretRangeFromPoint / caretPositionFromPoint / ProseMirror 的 posAtCoords) 会把光标
// 误翻到上一块的行首（社区通病：MDN 的 caretRangeFromPoint 文档、php.cn/faq/3050250、
// bbccb.com 的 contenteditable 光标文章均记载此现象，Quill/wangEditor/Tiptap 移动端编辑
// 器都有同类反馈）。下面用「几何夹 x」思路纠正：找到点按所在视觉行文本的右缘，若点击 x 落在
// 其右侧，就把探测 x 夹回行内再交给 PM 重探，使光标稳定落在本行行尾，而不是翻到上一块行首。
// ============================================================
const TEXTBLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, code';

function safePosAtCoords(view, x, y) {
  try {
    const a = view.posAtCoords({ left: x, top: y });
    return a && a.pos != null ? a.pos : null;
  } catch (_) { return null; }
}

// 找到 (x,y) 处最内层承载文本的元素（处理 flex 任务项、列表嵌套等层级）
function innermostTextblockAt(view, x, y) {
  let el = null;
  try { el = document.elementFromPoint(x, y); } catch (_) {}
  if (!el || !view.dom.contains(el)) el = null;
  // 直接命中的是容器时，按 y 在顶层块里找
  if (!el || el === view.dom) {
    for (const child of view.dom.children) {
      const rr = child.getBoundingClientRect();
      if (y >= rr.top - 2 && y <= rr.bottom + 2) { el = child; break; }
    }
  }
  if (!el || el === view.dom) return null;
  // 列表容器下钻到 y 所在的 li
  if (el.nodeName === 'OL' || el.nodeName === 'UL') {
    let target = null;
    for (const c of el.children) {
      const rr = c.getBoundingClientRect();
      if (y >= rr.top - 2 && y <= rr.bottom + 2) { target = c; break; }
    }
    el = target || el;
  }
  const inner = el.querySelector ? el.querySelector(TEXTBLOCK_SELECTOR) : null;
  return inner || el;
}

// 纠正「右侧空白带」点按的命中错误。
//  返回 { pos, native, gutter }
//   pos    : 几何纠正后的真实意图位置（gutter 时为本行行尾）
//   native : PM 原生命中位置（可能已误翻到上一块行首）
//   gutter : 是否命中「右侧空白带」误判（native 与纠正结果不一致）
function resolveTapPos(view, x, y) {
  const native = safePosAtCoords(view, x, y);
  const block = innermostTextblockAt(view, x, y);
  if (!block) return { pos: native, native, gutter: false };
  // 用 Range 覆盖块内联内容取「文本行盒」：每行真实文字宽度的右缘（Element.getClientRects
  // 返回的是块级边框盒=整行满宽，无法区分文字与右侧空白，故必须走 Range）。
  let rects = [];
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    rects = Array.from(range.getClientRects());
  } catch (_) {}
  if (!rects.length) return { pos: native, native, gutter: false };
  // 找包含 y 的视觉行（取竖带最接近的一行）
  let best = null, bestDist = Infinity;
  for (const r of rects) {
    if (y >= r.top - 2 && y <= r.bottom + 2) { best = r; break; }
    const mid = (r.top + r.bottom) / 2;
    const d = Math.abs(y - mid);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  if (!best) return { pos: native, native, gutter: false };
  // 点击落在该视觉行文本右缘右侧（右侧空白带）→ 夹 x 到行内重探
  if (x > best.right + 4) {
    const cx = Math.max(best.left + 2, best.right - 2);
    const fixed = safePosAtCoords(view, cx, y);
    if (fixed != null) return { pos: fixed, native, gutter: fixed !== native };
  }
  return { pos: native, native, gutter: false };
}

function makeView(place, src) {
  // 用户最近一次点按位置（pointerdown 时算）——作为"用户真实意图"的基准，用于把被
  // WebView 误重置到开头的光标拉回。
  let tapPos = -1, tapBlock = -2, tapT = 0, tapRawPos = null, tapGutter = false;
  const st = makeState(src);
  const v = new EditorView(place, {
    state: st,
    nodeViews,
    attributes: { spellcheck: 'false' },
    dispatchTransaction(tr) {
      const prevHead = v.state.selection.head;
      v.updateState(v.state.apply(tr));
      afterTransaction(v);
      // v1.115 修复（根因已在浏览器 harness 证实）：Android WebView 点按时会把 DOM 选区
      // 重置到文档开头，PM 的 domObserver 将这个外部重置"采纳"成逻辑选区，导致光标偶发跳到
      // 开头。这里抓住"逻辑光标被瞬移进首块"的瞬间，用用户最近一次真实点按的位置拉回。
      // 仅在「跳进首块 + 之前不在首块 + 最近点按的不是首块」时触发：正常点首行、拖选、
      // 键盘编辑都不满足，绝不会误伤。
      try {
        const s = v.state.selection;
        if (s.head !== prevHead) {
          const firstBlock = blockStart(v.state.doc, 1);
          const nowBlock = blockStart(v.state.doc, s.head);
          const wasBlock = blockStart(v.state.doc, prevHead);
          if (nowBlock === firstBlock && wasBlock !== firstBlock && wasBlock >= 0 &&
              tapBlock >= 0 && tapBlock !== firstBlock && (Date.now() - tapT) < 3000 &&
              tapPos >= 0 && blockStart(v.state.doc, tapPos) !== firstBlock) {
            const fix = v.state.tr.setSelection(TextSelection.create(v.state.doc, tapPos));
            v.updateState(v.state.apply(fix));
            console.warn('[caret] webview-reset reverted ' + prevHead + '->' + s.head + ' back to tap ' + tapPos);
          }
        }
      } catch (_) {}
      // v1.117：纠正 WebView 对「右侧空白带」点按的命中错误。
      // 用户在某视觉行右侧空白区点按时，原生 posAtCoords 会把光标翻到上一块行首；
      // pointerdown 已用几何方式算出了真实意图位置（tapPos = 本行行尾）。若 PM 把光标放到了
      // 与 tapBlock 不同的块，且本次点按确属右侧空白带误判（tapGutter），则拉回到 tapPos。
      // 仅对「点按」（结果为折叠光标）生效，拖选/长按产生的选区不触发，避免误伤。
      try {
        const s2 = v.state.selection;
        if (s2.empty && tapGutter && tapRawPos != null && tapBlock >= 0 &&
            (Date.now() - tapT) < 1000) {
          const headBlock = blockStart(v.state.doc, s2.head);
          if (headBlock !== tapBlock) {
            const fix = v.state.tr.setSelection(TextSelection.create(v.state.doc, tapPos));
            v.updateState(v.state.apply(fix));
            console.warn('[caret] right-gutter hit corrected ' + s2.head + ' -> ' + tapPos + ' (tapBlock ' + tapBlock + ')');
          }
        }
      } catch (_) {}
    },
  });
  // 最终保险：直接在 .ProseMirror 元素上设 inline white-space，确保 ProseMirror 读取
  // getComputedStyle(view.dom).whiteSpace 一定为 pre-wrap（任何 CSS 注入/嵌套都覆盖不了），
  // 否则 coordsAtPos / 命中测试在软换行处坐标错乱，光标跳到开头或折行处乱跳。
  v.dom.style.whiteSpace = 'pre-wrap';
  v.dom.style.overflowWrap = 'break-word';
  // editing 真源：PM DOM 的 focus/blur（替代 Vditor 的 options.focus/blur 回调）
  v.dom.addEventListener('focus', () => {
    editing = true;
    safe(() => dockUpdate());
    // v1.110：DOM focus 在「文档以 atom/NodeView（math_block/raw_block/table）结尾」时，
    // 浏览器无法在 atom 末尾放置 DOM caret，会把光标顶到文档开头，再被 ProseMirror
    // 同步成 selection=开头。若 focus 前在非开头、focus 后被顶开头，则恢复并打点。
    const bef = v.state.selection.head;
    requestAnimationFrame(() => {
      const aft = v.state.selection.head;
      if (bef > 1 && aft <= 1) {
        try {
          v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, bef)));
          console.warn('[caret] focus pulled caret to start, restored to ' + bef);
        } catch (e) {
          console.warn('[caret] focus restore failed: ' + (e && e.message));
        }
      }
    });
  });
  v.dom.addEventListener('blur', () => { editing = false; safe(() => dockUpdate()); });
  // v1.115：pointerdown 记录用户真实点按位置（供上面的 webview-reset 回退使用）。
  // v1.117：此处用几何纠正后的位置，原生命中在「右侧空白带」被误翻到上一块行首时，
  // 这里记录的是本行行尾（tapGutter 标记这次点按确实属于该误判场景）。
  v.dom.addEventListener('pointerdown', (e) => {
    tapT = Date.now();
    const r = resolveTapPos(v, e.clientX, e.clientY);
    tapRawPos = r.native;   // PM 原生命中（可能误翻到上一块行首）
    tapPos = r.pos;         // 几何纠正后的真实意图位置（本行行尾）
    tapGutter = r.gutter;   // 是否命中「右侧空白带」误判
    tapBlock = (r.pos >= 0) ? blockStart(v.state.doc, r.pos) : -2;
  });

  // ============================================================
  // v1.116 防误选（根因有录屏逐帧证据）：快速连点时第二击落入系统双击窗口，
  // WebView 触发"双击选词"——选区+左右手柄+「剪切/复制/粘贴/全选」菜单全弹出，
  // 且 IME 随之切面板。后果：菜单开着时后续点按被吃掉（光标"不灵敏"）；
  // 选区收起时光标落到行首而非点按处（"点行尾跑到行首"）。
  // 两道防线，均不影响长按选词与拖选手势：
  //  1) detail>1（双击/三连击）的 mousedown 直接拦截，不让选词手势成立，
  //     并手动把光标放到本次点按位置——连点移动光标依然跟手；
  //  2) 兜底：一次"短触摸"（<250ms，即点按而非长按）结束后短暂窗口内，
  //     若冒出非空选区（双击/微动误选），立即收回到该次点按的位置。
  // ============================================================
  let touchDownT = 0, touchDurMs = 0, touchActive = false, lastTapEndT = 0;
  let lastTapX = -1, lastTapY = -1, selGuard = 0;
  const collapseAccidental = () => {
    if (selGuard) return;
    selGuard = setTimeout(() => {
      selGuard = 0;
      try {
        if (!editing || touchActive) return;
        if (Date.now() - lastTapEndT > 350) return;
        const s = v.state.selection;
        if (s.empty) return;
        let p = s.head;
        if (lastTapX >= 0) {
          const rr = resolveTapPos(v, lastTapX, lastTapY);
          if (rr && rr.pos != null) p = rr.pos;
        }
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, p)));
        console.warn('[caret] accidental selection collapsed to ' + p);
      } catch (_) {}
    }, 60);
  };
  v.dom.addEventListener('touchstart', (e) => {
    touchActive = true;
    touchDownT = Date.now();
    if (e.touches && e.touches.length) { lastTapX = e.touches[0].clientX; lastTapY = e.touches[0].clientY; }
  }, { passive: true });
  v.dom.addEventListener('touchend', () => {
    touchActive = false;
    touchDurMs = Date.now() - touchDownT;
    lastTapEndT = Date.now();
    collapseAccidental();
  }, { passive: true });
  v.dom.addEventListener('touchcancel', () => { touchActive = false; }, { passive: true });
  v.dom.addEventListener('mousedown', (e) => {
    if (e.detail > 1) {
      e.preventDefault();
      const x = e.clientX, y = e.clientY;
      setTimeout(() => {
        try {
          const rr = resolveTapPos(v, x, y);
          if (rr && rr.pos != null) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, rr.pos)));
        } catch (_) {}
      }, 0);
    }
  }, true);
  document.addEventListener('selectionchange', collapseAccidental);
  return v;
}

function afterTransaction(v) {
  // 空态占位 + 工具栏激活态刷新（rAF 节流）
  v.dom.classList.toggle('md-empty', isEmptyDoc(v.state.doc));
  scheduleToolbarUpdate();
}

let tbRaf = 0;
function scheduleToolbarUpdate() {
  if (tbRaf || !view) return;
  tbRaf = (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
    tbRaf = 0;
    if (toolbar) toolbar.update(view);
  });
}

// ---- 工具栏 ----

let toolbar = null;
const TOOL_TYPES = DEFAULT_TOOLS.slice();

function validTools() {
  if (__toolbarCfg && __toolbarCfg.enabled && __toolbarCfg.enabled.length) {
    const valid = __toolbarCfg.enabled.filter((id) => TOOL_TYPES.indexOf(id) >= 0);
    if (valid.length) return groupWithDividers(valid, 5);
  }
  const w = window.innerWidth || document.documentElement.clientWidth || 0;
  if (w && w < 640) {
    // 窄屏默认（对齐旧版 effectiveIds；image 在 Kotlin 侧作为特殊工具也有自绘按钮，
    // 新版统一在 JS 栏内渲染，Kotlin 顶栏不再重复出图库入口）
    return ['headings', 'bold', 'italic', 'strike', '|',
      'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
      'quote', 'code', 'image'];
  }
  return ['headings', 'bold', 'italic', 'strike', '|',
    'link', '|',
    'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
    'quote', 'line', 'code', 'inline-code', '|',
    'undo', 'redo', '|',
    'fullscreen', 'image'];
}

function groupWithDividers(ids, step) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && i % step === 0) out.push('|');
    out.push(ids[i]);
  }
  return out;
}

function getToolbarItems() {
  return validTools()
    .filter((id) => id !== '|')
    .map((id) => (id === 'image'
      ? { type: 'builtin', id: 'image' }
      : { type: 'builtin', id }))
    .concat((__toolbarCfg && __toolbarCfg.customs) || []);
}

function runTool(id, arg) {
  if (sourceMode) {
    // 源码态：仅支持插文本类操作（改 textarea），块级/格式命令无意义
    if (id === '__custom') window.editor.insertText(arg == null ? '' : String(arg));
    else if (id === 'image') pushEvent('pickImage');
    return;
  }
  if (!view) return;
  const st = view.state;
  const dispatch = view.dispatch.bind(view);
  switch (id) {
    case 'headings':
      safe(() => { toggleHeading(schema, Number(arg) || 0)(st, dispatch); scheduleToolbarUpdate(); });
      break;
    case 'bold': safe(() => { toggleMark(schema.marks.bold)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'italic': safe(() => { toggleMark(schema.marks.em)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'strike': safe(() => { toggleMark(schema.marks.strike)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'inline-code': safe(() => { toggleMark(schema.marks.code)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'link': safe(() => { toggleLink(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'list': safe(() => { toggleList(schema.nodes.bullet_list)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'ordered-list': safe(() => { toggleList(schema.nodes.ordered_list)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'check': safe(() => { toggleTaskItem(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'quote': safe(() => { wrapIn(schema.nodes.blockquote)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'line': safe(() => { insertHr(schema)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'code': safe(() => { toggleCodeBlock(schema)(st, dispatch); scheduleToolbarUpdate(); }); break;
    case 'indent': runIndent('indent'); break;
    case 'outdent': runIndent('outdent'); break;
    case 'undo': window.editor.undo(); break;
    case 'redo': window.editor.redo(); break;
    case 'fullscreen':
      document.body.classList.toggle('mdnotes-fullscreen');
      scheduleToolbarUpdate();
      break;
    case 'image':
      pushEvent('pickImage');   // Kotlin 轮询取出 → 打开相册
      break;
    case '__custom':
      window.editor.insertText(arg == null ? '' : String(arg));
      break;
    default: break;
  }
}

// ---- 诊断包装的缩进入口（stat().d 语义保持） ----

function runIndent(dir) {
  if (!view || sourceMode) return;
  indentOps.en++;
  const cmd = dir === 'indent' ? indentCommand(schema) : outdentCommand(schema);
  let ok = false;
  safe(() => { ok = cmd(view.state, view.dispatch); });
  if (ok) {
    indentOps.ok++;
    indentDiag = dir + ':ok';
    scheduleToolbarUpdate();
  } else {
    indentOps.er++;
    indentDiag = dir + ':none';
  }
}

// ============================================================
// dock：工具栏随键盘显隐/贴底/钉顶（逻辑与旧版逐行对齐，仅选择器换 .md-*）
// ============================================================

function setupToolbarDock() {
  let imeHasHeight = false;
  let menuOpen = false;
  let floatGrace = 0;
  let graceDone = false;
  let prevEditing = false;
  function setKbd(open, pinTop) {
    const cl = document.body.classList;
    cl.toggle('mdnotes-kbd-on', open);
    cl.toggle('mdnotes-kbd-off', !open);
    cl.toggle('mdnotes-kbd-float', open && !!pinTop);
  }
  function apply() {
    // 进入新编辑会话：复位占高证据与宽限（上一会话的收尾态不串场）
    if (editing && !prevEditing) { imeHasHeight = false; graceDone = false; }
    prevEditing = editing;
    if (!editing) {
      menuOpen = false;
      if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
      setKbd(false, false);
      return;
    }
    if (menuOpen) { setKbd(true, !imeHasHeight); return; }
    if (imeHasHeight) {
      if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
      graceDone = false;
      setKbd(true, false);
      return;
    }
    if (graceDone) { setKbd(true, true); return; }
    if (!floatGrace) {
      floatGrace = setTimeout(function () {
        floatGrace = 0;
        graceDone = true;
        if (editing) apply();
      }, 400);
    }
    setKbd(true, false);
  }
  dockUpdate = apply;
  document.body.classList.add('mdnotes-kbd-off');
  if (window.visualViewport) window.visualViewport.addEventListener('resize', apply);
  window.addEventListener('resize', apply);
  editorImePush = function (open, floating) {
    if (open && floating === false) { imeHasHeight = true; graceDone = false; }
    if (open && floating === true) {
      imeHasHeight = false;
      graceDone = true;
      if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
    }
    if (!open && menuOpen) { menuOpen = false; if (toolbar) toolbar.closePanel(); }
    apply();
  };
}

// ============================================================
// 主题：CSS 变量注入 + 昼夜推断 + 内容元素配色适配
// ============================================================

function isNight(vars) {
  const bg = (vars && vars['bg-page']) || '#ffffff';
  let c = bg.replace('#', '');
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  if (c.length !== 6) return false;
  const r = parseInt(c.substr(0, 2), 16);
  const g = parseInt(c.substr(2, 2), 16);
  const b = parseInt(c.substr(4, 2), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

function injectTheme(vars) {
  if (!vars) return;
  const root = document.documentElement.style;
  for (const k in vars) {
    if (k === 'night') continue;
    root.setProperty('--' + k, String(vars[k]));
  }
  const px = vars['font-px'] || '18px';
  const fam = vars['font-family'] || 'sans-serif';
  const css =
    '.md-content{font-size:' + px + ' !important;font-family:' + fam + ' !important;}' +
    '.md-content, .md-content *{color:var(--text,#222);}' +
    '.md-content pre{background:var(--code-bg,#f6f6f6) !important;}' +
    '.md-content code{background:var(--code-bg,#f6f6f6);}' +
    '.md-content table{border-collapse:collapse;}' +
    '.md-content table td,.md-content table th{border:1px solid var(--table-border,#d0d0d0) !important;' +
    'padding:6px 13px;color:var(--text,#222) !important;}' +
    '.md-content table th{background-color:rgba(128,128,128,0.18) !important;font-weight:600;}' +
    '.md-content table tbody tr:nth-child(2n){background-color:rgba(128,128,128,0.08);}' +
    '.md-content blockquote{border-left:4px solid var(--table-border,#d0d0d0) !important;' +
    'color:var(--text-sub,#8E8E93) !important;background:rgba(128,128,128,0.06) !important;}' +
    '.md-content hr{border-color:var(--table-border,#d0d0d0) !important;}' +
    '.md-content img{max-width:100%;}' +
    '.md-toolbar{background-color:var(--paper,#fff);border-top:1px solid var(--table-border,#d0d0d0);}' +
    '.md-toolbar .md-tool{color:var(--text-sub,#666);}' +
    '.md-toolbar .md-tool--on{color:var(--brand,#ff6f00);}' +
    '.md-panel{background-color:var(--paper,#fff);border:1px solid var(--table-border,#d0d0d0);}' +
    '.md-panel .md-panel-item{color:var(--text,#222);}' +
    '.md-panel .md-panel-item--on{color:var(--brand,#ff6f00);}' +
    '.md-source{background:var(--paper,#fff);color:var(--text,#222);' +
    'font-size:' + px + ' !important;font-family:' + fam + ' !important;}';
  let tag = document.getElementById('mdnotes-theme');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'mdnotes-theme';
    document.head.appendChild(tag);
  }
  tag.textContent = css;
}

// ============================================================
// 源码模式：textarea 覆盖层（sourcemode 的 DOM 由 editor.html 提供）
// ============================================================

function setupSourceMode() {
  const ta = document.getElementById('md-source');
  const pmHost = document.getElementById('md-pm-host');
  if (!ta || !pmHost) return;
  ta.addEventListener('input', function () { pendingValue = ta.value; });
  ta.addEventListener('blur', function () { editing = false; safe(() => dockUpdate()); });
  ta.addEventListener('focus', function () { editing = true; safe(() => dockUpdate()); });
}

function enterSourceMode() {
  if (sourceMode || !view) return;
  const ta = document.getElementById('md-source');
  const pmHost = document.getElementById('md-pm-host');
  if (!ta || !pmHost) return;
  ta.value = getSource();
  sourceMode = true;
  pmHost.style.display = 'none';
  ta.style.display = 'block';
  safe(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  safe(() => dockUpdate());
}

function exitSourceMode() {
  if (!sourceMode) return;
  const ta = document.getElementById('md-source');
  const pmHost = document.getElementById('md-pm-host');
  if (!ta || !pmHost) return;
  const val = ta.value;
  pendingValue = val;
  sourceMode = false;
  ta.style.display = 'none';
  pmHost.style.display = '';
  if (view) {
    const st = makeState(val);
    view.updateState(st);
    afterTransaction(view);
  }
}

// ============================================================
// boot：等 DOM 就绪后装配 PM view + 工具栏 + dock
// ============================================================

function boot() {
  const host = document.getElementById('md-pm-host');
  if (!host) return;
  setupToolbarDock();
  setupSourceMode();
  view = makeView(host, pendingValue);
  ready = true;
  window.__pmview = view;   // 调试句柄（对齐旧版 window.__vd）
  afterTransaction(view);
  const tbHost = document.querySelector('.md-toolbar');
  if (tbHost) {
    toolbar = createToolbar(tbHost, {
      getTools: getToolbarItems,
      run: runTool,
      onPanelToggle: function () { safe(() => dockUpdate()); },
    });
    // 防闪跳：初始按 editing 渲染一次
    safe(() => dockUpdate());
  }
  if (pendingTheme) { const t = pendingTheme; pendingTheme = null; applyTheme(t); }
  if (pendingFocus) { pendingFocus = false; editing = true; safe(() => view.focus()); }
}

function applyTheme(vars) {
  injectTheme(vars);
  if (!vars) return;
  currentNight = isNight(vars);
  document.body.classList.toggle('mdnotes-night', currentNight);
}

  /** 源码态的文本插入（自定义片段 / softBreak / applyLinePrefix 共用） */
  function sourceInsert(t) {
    const ta = document.getElementById('md-source');
    if (!ta) return;
    const start = ta.selectionStart || 0;
    const end = ta.selectionEnd || 0;
    ta.setRangeText(t == null ? '' : String(t), start, end, 'end');
    pendingValue = ta.value;
  }

  // ---- 暴露给 Kotlin 的 window.editor（同名同参，Kotlin 零改动） ----
window.editor = {
  /** 装载/初始化全文：首次进入创建 PM view，之后重建 EditorState（历史重置） */
  loadMarkdown: function (src, sel, keepEditing) {
    pendingValue = src || '';
    if (view && ready) {
      const wasEditing = editing;
      const st = makeState(pendingValue, sel);
      view.updateState(st);
      afterTransaction(view);
      if (keepEditing && wasEditing) { editing = true; safe(() => view.focus()); }
      console.log('[caret] loadMarkdown sel=' + sel + ' cursor=' + view.state.selection.head + ' size=' + st.doc.content.size);
    } else {
      console.log('[caret] loadMarkdown deferred (not ready), pending sel=' + sel);
    }
  },
  getSource: getSource,
  /** 轮询探针（未编辑态用）：编辑态 + 诊断计数 + 历史深度，不含内容 */
  probe: function () {
    return {
      e: editing,
      d: {
        en: indentOps.en, ok: indentOps.ok, er: indentOps.er, id: indentDiag,
        u: view ? undoDepth(view.state) : 0,
        r: view ? redoDepth(view.state) : 0,
      },
      q: [],
    };
  },
  /** 轮询全量（编辑态用）：内容 + 光标 + 事件队列，走同一 onJsContentChanged */
  stat: function () {
    const q = __jsQueue;
    __jsQueue = [];
    return {
      e: editing,
      s: getSource(),
      c: view ? view.state.selection.head : 0,
      d: {
        en: indentOps.en, ok: indentOps.ok, er: indentOps.er, id: indentDiag,
        u: view ? undoDepth(view.state) : 0,
        r: view ? redoDepth(view.state) : 0,
      },
      q: q,
    };
  },
  /** 退出编辑态（键盘收起时）：失焦 */
  exitEditMode: function () {
    if (sourceMode) {
      const ta = document.getElementById('md-source');
      if (ta) safe(() => ta.blur());
    } else if (view && ready) {
      safe(() => view.dom.blur());
    }
    editing = false;
    safe(() => dockUpdate());
  },
  /** 进入编辑态（新笔记自动进编辑）：聚焦编辑器 */
  enterEditAt: function (sel) {
    if (sourceMode) {
      const ta = document.getElementById('md-source');
      if (ta) safe(() => ta.focus());
      editing = true;
      safe(() => dockUpdate());
      return;
    }
    if (view && ready) {
      editing = true;
      safe(() => view.focus());
      console.log('[caret] enterEditAt sel=' + sel + ' cursor=' + view.state.selection.head);
    } else pendingFocus = true;
  },
  /** 主题落地：注入 CSS 变量 + 昼夜类切换 + 字号 */
  applyTheme: function (vars) {
    if (!ready) { pendingTheme = vars; injectTheme(vars); return; }
    applyTheme(vars);
  },
  /** 插入图片（Kotlin 图片工具回填 img://key）：渲染为本地可加载图 */
  insertImage: function (key) {
    if (sourceMode) {
      sourceInsert('![image](img://' + key + ')');
      return;
    }
    if (!view || !ready) return;
    safe(() => {
      const node = schema.nodes.image.create({ src: IMG_SRC_PREFIX + key, alt: 'image' });
      const tr = view.state.tr;
      if (view.state.selection instanceof TextSelection) tr.replaceSelectionWith(node);
      else tr.replaceWith(view.state.doc.content.size - 1, view.state.doc.content.size - 1, node);
      view.dispatch(tr.scrollIntoView());
      editing = true;
      safe(() => view.focus());
    });
  },
  /** 源码 ⇄ 富文本 切换（顶栏眼睛按钮） */
  toggleSourceMode: function () {
    if (!view || !ready) return;
    if (sourceMode) exitSourceMode();
    else enterSourceMode();
    safe(() => dockUpdate());
  },
  /** 撤回 / 重做：D3 直通 PM history（Kotlin 快照栈退役）；源码态走原生撤销 */
  undo: function () {
    if (!view || sourceMode) {
      if (sourceMode) safe(() => document.execCommand('undo', false, null));
      return;
    }
    safe(() => { pmUndo(view.state, view.dispatch); scheduleToolbarUpdate(); });
  },
  redo: function () {
    if (!view || sourceMode) {
      if (sourceMode) safe(() => document.execCommand('redo', false, null));
      return;
    }
    safe(() => { pmRedo(view.state, view.dispatch); scheduleToolbarUpdate(); });
  },
  /** Kotlin 推送键盘状态（证据语义与旧版一致，见 setupToolbarDock） */
  onIme: function (open, floating) { if (editorImePush) editorImePush(open, floating); },
  focus: function () {
    if (sourceMode) { const ta = document.getElementById('md-source'); if (ta) safe(() => ta.focus()); return; }
    if (view && ready) safe(() => view.focus());
    else pendingFocus = true;
  },
  blur: function () {
    if (sourceMode) { const ta = document.getElementById('md-source'); if (ta) safe(() => ta.blur()); return; }
    if (view && ready) safe(() => view.dom.blur());
  },
  insertText: function (t) {
    if (sourceMode) { sourceInsert(t); return; }
    if (!view || !ready) { pendingValue += t || ''; return; }
    safe(() => { view.dispatch(view.state.tr.insertText(t || '')); });
  },
  wrapSelection: function (b, a) {
    if (sourceMode) {
      const ta = document.getElementById('md-source');
      if (ta) {
        const sel = ta.value.slice(ta.selectionStart || 0, ta.selectionEnd || 0);
        sourceInsert(b + sel + a);
      }
      return;
    }
    if (!view || !ready) return;
    safe(() => {
      const sel = view.state.selection;
      const text = view.state.doc.textBetween(sel.from, sel.to, '\n', '\uFFFC');
      if (text) {
        const tr = view.state.tr.replaceSelectionWith(schema.text(b + text + a));
        view.dispatch(tr);
      } else {
        view.dispatch(view.state.tr.insertText(b + a));
      }
    });
  },
  applyLinePrefix: function (p) {
    if (sourceMode) { sourceInsert(p || ''); return; }
    if (!view || !ready) return;
    safe(() => { view.dispatch(view.state.tr.insertText(p || '')); });
  },
  softBreak: function () {
    if (sourceMode) { sourceInsert('\n'); return; }
    if (!view || !ready) return;
    safe(() => { view.dispatch(view.state.tr.insertText('\n')); });
  },
  indentLine: function () { runIndent('indent'); },
  outdentLine: function () { runIndent('outdent'); },
  /** 注入自定义工具栏配置；就绪则重建生效，否则仅存（boot 时读取） */
  setToolbarConfig: function (cfg) {
    __toolbarCfg = cfg || null;
    if (toolbar) toolbar.rebuild();
  },
  /** 按当前配置重建工具栏（设置返回编辑页时由 Kotlin 调用） */
  rebuildToolbar: function () { if (toolbar) toolbar.rebuild(); },
};

// v1.117 headless 回归钩子：仅当显式置位 window.__MDNOTE_DEBUG__ 时暴露内部函数，
// 用于验证「右侧空白带」命中纠正（见 test/caret-gutter.test.js）。生产环境永不触发。
if (typeof window !== 'undefined' && window.__MDNOTE_DEBUG__) {
  window.__mdnoteDebug = {
    resolveTapPos, blockStart,
    getView: () => view,
    makeState, schema,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
