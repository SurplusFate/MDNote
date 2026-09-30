/*
 * list-transform.test.js — ListStructureTransformer 纯函数单元测试（Sprint 2 + #52）
 * 运行：node app/src/test/js/list-transform.test.js
 * 覆盖审查 #13 测试矩阵：普通 / 有序 / 任务 / 混合 / 深层嵌套 / 重复文本 / 空项 / 格式变体
 *        × indent / outdent / 连续操作 / 光标进位。零依赖、零 WebView。
 * #52 新增：有序列表缩进自动重排编号（对齐 Obsidian 规律），见 ADR-008。
 */
var T = require('../../main/assets/editor/editor-list.js');

var passed = 0, failed = 0;
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error('  ✗ ' + msg + '\n      expected: ' + e + '\n      actual:   ' + a); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } }
function src(s) { return s.replace(/\n/g, '\\n'); }

// 连续应用 indent/outdent 指定行若干次
function applySeq(fn, source, line, times) {
  var r = { src: source, changed: true, caret: null };
  for (var i = 0; i < times; i++) r = fn(r.src, line);
  return r;
}

console.log('— 普通列表 —');
eq(T.indent('- a\n- b', 1).src, '- a\n  - b', 'U indent 兄弟项挂到上一项');
eq(T.indent('- a\n- b', 1).changed, true, 'U indent 有变化');
eq(T.outdent('- a\n  - b', 1).src, '- a\n- b', 'U outdent 回到同级');
eq(T.outdent('- a', 0).changed, false, 'U outdent 顶级 no-op');
eq(T.indent('- a', 0).changed, false, 'U indent 首项 no-op');

console.log('— 深层嵌套 —');
eq(T.indent('- a\n  - b\n  - c', 2).src, '- a\n  - b\n    - c', 'U 三层：c 挂到 b');
eq(T.outdent('- a\n  - b\n    - c', 2).src, '- a\n  - b\n  - c', 'U outdent c 回到 b 同级');
eq(T.indent('- a\n  - b\n    - c', 2).changed, false, 'U 已嵌套项再 indent no-op');

console.log('— 有序列表（#52：缩进自动重排编号，对齐 Obsidian 规律）—');
// 子层从 1 重排
eq(T.indent('1. a\n2. b', 1).src, '1. a\n   1. b', 'O indent 兄弟项挂到上级 + 子层重排为 1');
eq(T.indent('1. a\n2. b', 1).changed, true, 'O indent 有序项不再是 no-op（#52）');
// 下钻中间项：c 挂到 b 下（嵌套层从 1），b 保持顶层序号 2
eq(T.indent('1. a\n2. b\n3. c', 2).src, '1. a\n2. b\n   1. c', 'O 下钻 c：c 挂到 b 下（嵌套显示 1），b 保持顶层 2');
// 多兄弟下钻：c 下钻，d 接回 3
eq(T.indent('1. a\n2. b\n3. c\n4. d', 2).src, '1. a\n2. b\n   1. c\n3. d', 'O 中间项下钻，后续接回连续序号');
// outdent 接回父层序号
eq(T.outdent('1. a\n   1. b\n   2. c', 1).src, '1. a\n2. b\n   1. c', 'O outdent 子项弹回顶层为 2，孙项 c 仍嵌套 b 显示 1');
eq(T.outdent('1. a\n   2. b', 1).src, '1. a\n2. b', 'O outdent 有序项抬到同级（源码层重排）');
eq(T.indent('- a\n  1. b', 1).changed, false, 'U父O子 已嵌套 indent 仍 no-op（与无序同规则）');

console.log('— 有序父 + 无序子（unit=3，已实测可嵌套）—');
eq(T.indent('1. a\n- b', 1).src, '1. a\n   - b', 'O父U子 indent unit=3');
eq(T.outdent('1. a\n   - b', 1).src, '1. a\n- b', 'O父U子 outdent cut=3');

console.log('— 无序父 + 有序子（无序打断编号，子层从 1 重排）—');
eq(T.indent('- a\n- b\n1. c', 2).src, '- a\n- b\n  1. c', 'U父O子 indent：c 嵌套 b 下，编号从 1');
eq(T.indent('- a\n- b\n1. c\n2. d', 2).src, '- a\n- b\n  1. c\n1. d', 'U父O子 多项：c 嵌套 b 下显示 1，d 顶层独立块显示 1');

console.log('— 任务列表 —');
eq(T.indent('- [ ] A\n- [ ] B', 1).src, '- [ ] A\n  - [ ] B', 'T indent 任务子项');
eq(T.outdent('- [ ] A\n  - [ ] B', 1).src, '- [ ] A\n- [ ] B', 'T outdent 任务子项');
eq(T.toggleTask('- a', 0).src, '- [ ] a', 'T 普通项转任务');
eq(T.toggleTask('- [ ] a', 0).src, '- [x] a', 'T 勾选');
eq(T.toggleTask('- [x] a', 0).src, '- [ ] a', 'T 取消勾选');
eq(T.toggleTask('plain text', 0).changed, false, 'T 非列表行 no-op');

console.log('— 混合（已嵌套有序子项无法再 indent）—');
eq(T.indent('- a\n  1. b', 1).changed, false, 'U父O子 已嵌套 indent no-op');

console.log('— 重复文本（按行号定位，不靠文字猜测）—');
eq(T.indent('- 观后感\n- 哈哈哈\n- 观后感', 2).src,
   '- 观后感\n- 哈哈哈\n  - 观后感', '重复文本 indent 第二项观后感');
eq(T.indent('- 观后感\n- 哈哈哈\n- 观后感', 0).changed, false, '重复文本 indent 首项 no-op');

console.log('— 空项 —');
eq(T.indent('- [ ]\n- [ ]', 1).src, '- [ ]\n  - [ ]', '空任务项可缩进');
eq(T.outdent('- [ ]\n  - [ ]', 1).src, '- [ ]\n- [ ]', '空任务项可减缩进');

console.log('— 格式变体（* / + / 多空格）—');
eq(T.indent('* a\n* b', 1).src, '* a\n  * b', '* 列表缩进');
eq(T.indent('+ a\n+ b', 1).src, '+ a\n  + b', '+ 列表缩进');
eq(T.indent('-   [ ] a\n-   [ ] b', 1).src, '-   [ ] a\n  -   [ ] b', '多空格任务项缩进 unit=2');

console.log('— 连续操作（先缩进 b，再缩进 c 挂到 b；反向同理）—');
var s1 = T.indent('- a\n- b\n- c', 1).src;
eq(s1, '- a\n  - b\n- c', 'indent b 挂到 a');
var s2 = T.indent(s1, 2).src;
eq(s2, '- a\n  - b\n  - c', '再 indent c：c 作为 a 的子项与 b 同级（顶层项缩进一级）');
ok(T.indent('- a\n  - b\n    - c', 2).changed === false, '已嵌套项再 indent no-op');
var o1 = T.outdent('- a\n  - b\n    - c', 2).src;
eq(o1, '- a\n  - b\n  - c', 'outdent c 弹回 b 同级');
var o2 = T.outdent(o1, 1).src;
eq(o2, '- a\n- b\n  - c', '再 outdent b 弹回顶级（c 作为 a 的子项保留嵌套）');

console.log('— 有序连续操作（#52：多层下钻 + 回弹，编号始终连续）—');
// 1.a / 2.b / 3.c -> 下钻 b（b,c 同变子层）-> 再下钻 c
var oo1 = T.indent('1. a\n2. b\n3. c', 1).src;
eq(oo1, '1. a\n   1. b\n2. c', 'O 下钻 b：b 成子层1，c 接回顶层2');
var oo2 = T.indent(oo1, 2).src; // 对 c（line2）下钻
eq(oo2, '1. a\n   1. b\n   2. c', 'O 再下钻 c：c 与 b 同级子层，连续 1,2（顶层只剩 a）');
var oo3 = T.outdent(oo2, 1).src; // 弹回 b
eq(oo3, '1. a\n2. b\n   1. c', 'O 回弹 b：b 回到顶层2，c 仍嵌套 b 下显示1');
var oo4 = T.outdent(oo3, 2).src; // 弹回 c
eq(oo4, '1. a\n2. b\n3. c', 'O 回弹 c：完全回到原始连续编号');

console.log('— renumberOrderedLines 直接测试（#52 编号算法）—');
eq(T.renumberOrderedLines(['1. a', '2. b', '3. c']), ['1. a', '2. b', '3. c'], 'R 已连续：不变');
eq(T.renumberOrderedLines(['1. a', '   2. b', '   3. c']), ['1. a', '   1. b', '   2. c'], 'R 子层从 1 重排');
eq(T.renumberOrderedLines(['9. a', '10. b']), ['1. a', '2. b'], 'R 跨位数重排（长度变化安全）');
eq(T.renumberOrderedLines(['1. a', '- x', '2. b']), ['1. a', '- x', '1. b'], 'R 无序项打断编号：b 新顶层 1');
eq(T.renumberOrderedLines(['1. a', '   1. b', '2. c']), ['1. a', '   1. b', '2. c'], 'R 顶层1,2 + 嵌套子1');
eq(T.renumberOrderedLines(['1. a', '   5. b', '   6. c']), ['1. a', '   1. b', '   2. c'], 'R 子层乱序编号也重写为 1,2');
eq(T.renumberOrderedLines(['- a', '  1. b', '  2. c']), ['- a', '  1. b', '  2. c'], 'R 无序父下有序子：子层 1,2');

console.log('— 光标进位（逻辑坐标，无序项不受 renumber 影响）—');
eq(T.indent('- a\n- b', 1, 0).caret, { line: 1, offset: 2 }, 'indent 光标+2');
eq(T.outdent('- a\n  - b', 1, 2).caret, { line: 1, offset: 0 }, 'outdent 光标-2');
eq(T.indent('- a\n- b', 1, 5).caret, { line: 1, offset: 7 }, 'indent 行内光标随行首平移');

console.log('— 子树整体平移（减缩进带走后代）—');
eq(T.outdent('- a\n  - b\n    - c\n    - d', 1).src,
   '- a\n- b\n  - c\n  - d', 'outdent b 带走 c/d 子树');
eq(T.indent('- a\n- b\n  - c\n  - d', 1).src,
   '- a\n  - b\n    - c\n    - d', 'indent b 带走 c/d 子树');

console.log('\n=== ' + passed + ' passed, ' + failed + ' failed ===');
if (failed > 0) process.exit(1);
