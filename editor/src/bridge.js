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

const nodeViews = {
  table_block: rawView,
  raw_block: rawView,
};

// ---- EditorState 装配 ----

/** 撤销/前进历史插件：模块级单例，桥据此上报栈深度（顶栏按钮点亮） */
const historyPlugin = history();

function makeState(src) {
  const doc = safe(() => parser.parse(src || '')) || emptyParagraph();
  return EditorState.create({
    doc,
    plugins: [historyPlugin, taskTogglePlugin, buildInputRules(schema), keymap(buildKeymap(schema))],
  });
}

function makeView(place, src) {
  const st = makeState(src);
  const v = new EditorView(place, {
    state: st,
    nodeViews,
    attributes: { spellcheck: 'false' },
    dispatchTransaction(tr) {
      v.updateState(v.state.apply(tr));
      afterTransaction(v);
    },
  });
  // editing 真源：PM DOM 的 focus/blur（替代 Vditor 的 options.focus/blur 回调）
  v.dom.addEventListener('focus', () => { editing = true; safe(() => dockUpdate()); });
  v.dom.addEventListener('blur', () => { editing = false; safe(() => dockUpdate()); });
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
      const st = makeState(pendingValue);
      view.updateState(st);
      afterTransaction(view);
      if (keepEditing && wasEditing) { editing = true; safe(() => view.focus()); }
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
      c: 0,
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
    if (view && ready) { editing = true; safe(() => view.focus()); }
    else pendingFocus = true;
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
