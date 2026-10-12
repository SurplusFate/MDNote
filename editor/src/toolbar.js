// toolbar.js — 自绘工具栏（消费 setToolbarConfig 的 JSON，id 集合与 Tool.kt 对齐）
//
// 视觉：按钮尺寸/配色沿用旧版 CSS 变量；图标沿用旧 sprite path（icons.js）。
// 交互：headings 出下拉面板；custom 工具点击在光标处插文本；mousedown 一律
//       preventDefault 防抢焦点（与旧版 editorGuardMount 同因，见 bridge.js）。

import { icon, LABELS } from './icons.js';

export function createToolbar(host, opts) {
  let items = [];
  let panel = null;

  function stopFocusSteal(e) {
    if (e.target && e.target.closest && e.target.closest('input, textarea')) return;
    e.preventDefault();
  }

  function button(toolId, title, inner) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'md-tool';
    b.dataset.tool = toolId;
    b.setAttribute('aria-label', title);
    b.innerHTML = inner;
    b.addEventListener('mousedown', stopFocusSteal);
    return b;
  }

  function closePanel() {
    if (panel) { panel.remove(); panel = null; if (opts.onPanelToggle) opts.onPanelToggle(false); }
  }

  function openHeadingsPanel(btn, run) {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'md-panel';
    const entries = [
      [0, '正文'], [1, '标题 1'], [2, '标题 2'], [3, '标题 3'],
      [4, '标题 4'], [5, '标题 5'], [6, '标题 6'],
    ];
    for (const [level, label] of entries) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'md-panel-item';
      b.textContent = label;
      b.dataset.level = String(level);
      b.addEventListener('mousedown', stopFocusSteal);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closePanel();
        run('headings', level);
      });
      panel.appendChild(b);
    }
    host.appendChild(panel);
    // 面板对齐按钮（靠右溢出时右对齐）
    const hb = host.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    const left = Math.max(4, Math.min(bb.left - hb.left, hb.width - panel.offsetWidth - 4));
    panel.style.left = left + 'px';
    if (opts.onPanelToggle) opts.onPanelToggle(true);
  }

  function render() {
    host.textContent = '';
    items = [];
    closePanel();
    for (const t of opts.getTools()) {
      if (t.type === 'custom') {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'md-tool md-tool-text';
        b.dataset.tool = 'custom:' + t.id;
        b.textContent = t.label || '片段';
        b.setAttribute('aria-label', t.label || '自定义片段');
        b.addEventListener('mousedown', stopFocusSteal);
        b.addEventListener('click', (e) => { e.preventDefault(); opts.run('__custom', t.text); });
        host.appendChild(b);
        items.push({ el: b, kind: 'custom', id: t.id });
        continue;
      }
      const id = t.id || t;
      if (id === 'headings') {
        const b = button('headings', LABELS.headings,
          icon('headings') + '<span class="md-caret">\u25BE</span>');
        b.addEventListener('click', (e) => {
          e.preventDefault();
          if (panel) { closePanel(); return; }
          openHeadingsPanel(b, opts.run);
        });
        host.appendChild(b);
        items.push({ el: b, kind: 'builtin', id });
        continue;
      }
      const b = button(id, LABELS[id] || id, icon(id));
      b.addEventListener('click', (e) => { e.preventDefault(); opts.run(id); });
      host.appendChild(b);
      items.push({ el: b, kind: 'builtin', id });
    }
  }

  /** 每次事务后刷新按钮激活态（rAF 由 bridge 控制） */
  function update(view) {
    const st = view.state;
    const $from = st.selection.$from;
    const stored = st.storedMarks || $from.marks();
    const has = (name) => {
      const m = st.schema.marks[name];
      return m && (st.doc.rangeHasMark(st.selection.from, st.selection.to, m) || m.isInSet(stored));
    };
    const parentName = $from.parent.type.name;
    const headingLevel = parentName === 'heading' ? $from.parent.attrs.level : 0;
    let liNode = null;
    let listNode = null;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type.name === 'list_item' && !liNode) liNode = n;
      if ((n.type.name === 'bullet_list' || n.type.name === 'ordered_list') && !listNode) listNode = n;
    }
    const fullscreen = document.body.classList.contains('mdnotes-fullscreen');
    for (const it of items) {
      if (it.kind !== 'builtin') continue;
      const on = (() => {
        switch (it.id) {
          case 'bold': return has('bold');
          case 'italic': return has('em');
          case 'strike': return has('strike');
          case 'inline-code': return has('code');
          case 'link': return has('link');
          case 'list': return listNode && listNode.type.name === 'bullet_list';
          case 'ordered-list': return listNode && listNode.type.name === 'ordered_list';
          case 'check': return liNode && liNode.attrs.checked !== null;
          case 'quote': return parentName === 'blockquote';
          case 'code': return parentName === 'code_block';
          case 'fullscreen': return fullscreen;
          default: return false;
        }
      })();
      it.el.classList.toggle('md-tool--on', on);
    }
    if (panel) {
      for (const b of panel.children) {
        b.classList.toggle('md-panel-item--on', Number(b.dataset.level) === headingLevel);
      }
    }
  }

  function destroy() { closePanel(); }

  render();
  return { rebuild: render, update, destroy };
}
