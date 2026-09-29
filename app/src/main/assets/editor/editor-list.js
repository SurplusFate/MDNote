/*
 * editor-list.js — ListStructureTransformer（Sprint 2：列表编辑器脱离 DOM 猜测）
 *
 * 这是一个「纯函数」模块：输入 Markdown 源码字符串 + 光标所在源码行号，
 * 输出新的源码字符串（+ 逻辑光标位置），完全不碰 DOM / Vditor / 窗口。
 * 因此可以在 Node 里用单元测试穷举验证（见 app/src/test/js/list-transform.test.js），
 * 不必启动 WebView。
 *
 * 设计依据（headless Chromium + Vditor/Lute 实测，非猜测）：
 *  - 无序子项嵌套 unit = 2（'- ' 宽度）：`- a` 下 `- b` → `  - b` 正确嵌套。
 *  - 有序父下无序子项 unit = 3（'1. ' 宽度）：`1. a` 下 `- b` → `   - b` 正确嵌套。
 *  - Lute 的 IR 解析**不支持有序列表嵌套**（有序子项无论缩进多少都被当成同级续写），
 *    故对「有序项」做 indent 是 no-op（与 Vditor 原生 Tab 行为一致，无回归）；
 *    该限制记入 ADR-004，不是本模块 bug。
 *  - indent 只能把「与上一列表项同缩进的兄弟项」挂到上一项下；已嵌套项（上一项目缩进更浅）
 *    再 indent 无意义 → no-op。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ListTransformer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 解析一行是否为列表项。返回 null 表示不是列表行。
  // indent: 行首前导空格数；ordered: 是否有序；bullet: 标记符；
  // task: 任务状态（null=非任务，false=未勾，true=已勾）。
  function parseListItem(line) {
    if (line == null) return null;
    var m = line.match(/^(\s*)([-*+]|(\d+)[.)])(\s*)/);
    if (!m) return null;
    var indent = m[1].length;
    var bullet = m[2];
    var ordered = /^\d/.test(bullet);
    var after = line.slice(m[0].length);
    var tm = after.match(/^\[([ xX])\]/);
    var task = tm ? (tm[1] === ' ' ? false : true) : null;
    return { indent: indent, ordered: ordered, bullet: bullet, task: task, raw: line };
  }

  function leadingSpaces(line) {
    var mm = line.match(/^(\s*)/);
    return mm ? mm[1].length : 0;
  }

  // 在 lines 数组中，从 i 向上跳过空行，找「最近的列表项」。
  // 返回 {item, idx} 或 null（i 是列表第一项 / 上方非列表行）。
  function prevListItem(lines, i) {
    for (var j = i - 1; j >= 0; j--) {
      if (lines[j].trim() === '') continue;
      var p = parseListItem(lines[j]);
      if (p) return { item: p, idx: j };
      return null; // 遇到非列表行：不在同一列表内
    }
    return null;
  }

  // 子树范围 [i, end]：i 及其下方「缩进比 i 深」的连续行（空行跳过，并入子树一起平移）。
  function subtreeEnd(lines, i, baseIndent) {
    var end = i;
    while (end + 1 < lines.length) {
      var nx = lines[end + 1];
      if (nx.trim() === '') { end++; continue; }
      var pn = parseListItem(nx);
      if (pn && pn.indent > baseIndent) { end++; continue; }
      break;
    }
    return end;
  }

  function makeResult(src, changed, caret) {
    return { src: src, changed: changed, caret: caret || null };
  }

  /**
   * 加缩进（indent）。
   * @param src      当前 Markdown 源码
   * @param caretLine 光标所在源码行号（0-based）；该行必须是列表项
   * @param caretOffset 可选，光标在该行的绝对偏移（含前导空格），用于计算新逻辑光标
   * @returns {src, changed, caret:{line,offset}}
   */
  function indent(src, caretLine, caretOffset) {
    var lines = String(src).split('\n');
    if (caretLine < 0 || caretLine >= lines.length) return makeResult(src, false, null);
    var it = parseListItem(lines[caretLine]);
    if (!it) return makeResult(src, false, null);          // 非列表行：不动

    var prev = prevListItem(lines, caretLine);
    if (!prev) return makeResult(src, false, null);         // 列表首项：无处可挂 → no-op
    if (prev.item.indent < it.indent) return makeResult(src, false, null); // 已嵌套：再缩进无意义
    if (it.ordered) return makeResult(src, false, null);   // Lute 不支持有序嵌套：no-op

    var unit = prev.item.ordered ? 3 : 2;
    var end = subtreeEnd(lines, caretLine, it.indent);
    for (var j = caretLine; j <= end; j++) lines[j] = repeat(unit) + lines[j];

    var newOffset = (caretOffset != null) ? caretOffset + unit : null;
    return makeResult(lines.join('\n'), true, { line: caretLine, offset: newOffset });
  }

  /**
   * 减缩进（outdent）。
   * @param src, caretLine, caretOffset 同上
   */
  function outdent(src, caretLine, caretOffset) {
    var lines = String(src).split('\n');
    if (caretLine < 0 || caretLine >= lines.length) return makeResult(src, false, null);
    var it = parseListItem(lines[caretLine]);
    if (!it) return makeResult(src, false, null);
    if (it.indent === 0) return makeResult(src, false, null); // 已是一级：no-op

    // 找「缩进比当前项更浅」的最近列表项（即当前项的父项）；找不到则用自身类型估 cut。
    var cut = it.ordered ? 3 : 2;
    for (var j = caretLine - 1; j >= 0; j--) {
      if (lines[j].trim() === '') continue;
      var p = parseListItem(lines[j]);
      if (p) {
        if (p.indent < it.indent) { cut = p.ordered ? 3 : 2; }
        break; // 最近列表项：无论深浅都停止（更浅即父，更深/同级继续向上找）
      } else break;
    }
    cut = Math.min(cut, it.indent);
    if (cut <= 0) return makeResult(src, false, null);

    var end = subtreeEnd(lines, caretLine, it.indent);
    for (var k = caretLine; k <= end; k++) {
      var lead = leadingSpaces(lines[k]);
      var rem = Math.min(cut, lead);
      lines[k] = lines[k].slice(rem);
    }
    var newOffset = (caretOffset != null) ? caretOffset - cut : null;
    if (newOffset != null && newOffset < 0) newOffset = 0;
    return makeResult(lines.join('\n'), true, { line: caretLine, offset: newOffset });
  }

  /**
   * 切换任务勾选状态（toggleTask）。
   *  - 普通列表项 → 变成未勾任务项（`[ ]`）
   *  - 任务项 → `[ ]` ↔ `[x]` 翻转
   * @returns {src, changed, caret}
   */
  function toggleTask(src, caretLine) {
    var lines = String(src).split('\n');
    if (caretLine < 0 || caretLine >= lines.length) return makeResult(src, false, null);
    var it = parseListItem(lines[caretLine]);
    if (!it) return makeResult(src, false, null);

    var m = lines[caretLine].match(/^(\s*)([-*+]|\d+[.)])(\s*)/);
    if (!m) return makeResult(src, false, null);
    var indentStr = m[1], bullet = m[2], spaceAfter = m[3];

    if (it.task === null) {
      // 普通列表项 → 任务项
      lines[caretLine] = indentStr + bullet + ' [ ] ' + lines[caretLine].slice(m[0].length);
    } else {
      var newState = it.task ? '[ ]' : '[x]';
      lines[caretLine] = lines[caretLine].replace(
        /^(\s*(?:[-*+]|\d+[.)])\s*)\[([ xX])\]/,
        function (_, pre) { return pre + newState; }
      );
    }
    return makeResult(lines[caretLine] !== src ? lines.join('\n') : src,
      lines[caretLine] !== src, { line: caretLine, offset: null });
  }

  function repeat(n) { var s = ''; for (var i = 0; i < n; i++) s += ' '; return s; }

  return {
    parseListItem: parseListItem,
    indent: indent,
    outdent: outdent,
    toggleTask: toggleTask
  };
});
