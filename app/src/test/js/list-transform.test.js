/*
 * list-transform.test.js — ListStructureTransformer 纯函数单元测试（Sprint 2）
 * 运行：node app/src/test/js/list-transform.test.js
 * 覆盖审查 #13 测试矩阵：普通 / 有序 / 任务 / 混合 / 深层嵌套 / 重复文本 / 空项 / 格式变体
 *        × indent / outdent / 连续操作 / 光标进位。零依赖、零 WebView。
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

console.log('— 有序列表（Lute 不支持有序嵌套 → 有序项 indent no-op）—');
eq(T.indent('1. a\n2. b', 1).changed, false, 'O indent 有序项 no-op');
eq(T.indent('1. a\n2. b\n3. c', 2).changed, false, 'O indent 多项有序 no-op');
eq(T.outdent('1. a\n   2. b', 1).src, '1. a\n2. b', 'O outdent 有序项抬到同级（源码层）');

console.log('— 有序父 + 无序子（unit=3，已实测可嵌套）—');
eq(T.indent('1. a\n- b', 1).src, '1. a\n   - b', 'O父U子 indent unit=3');
eq(T.outdent('1. a\n   - b', 1).src, '1. a\n- b', 'O父U子 outdent cut=3');

console.log('— 任务列表 —');
eq(T.indent('- [ ] A\n- [ ] B', 1).src, '- [ ] A\n  - [ ] B', 'T indent 任务子项');
eq(T.outdent('- [ ] A\n  - [ ] B', 1).src, '- [ ] A\n- [ ] B', 'T outdent 任务子项');
eq(T.toggleTask('- a', 0).src, '- [ ] a', 'T 普通项转任务');
eq(T.toggleTask('- [ ] a', 0).src, '- [x] a', 'T 勾选');
eq(T.toggleTask('- [x] a', 0).src, '- [ ] a', 'T 取消勾选');
eq(T.toggleTask('plain text', 0).changed, false, 'T 非列表行 no-op');

console.log('— 混合（有序子项无法嵌套）—');
eq(T.indent('- a\n  1. b', 1).changed, false, 'U父O子 indent no-op（Lute 不支持有序嵌套）');

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

console.log('— 光标进位（逻辑坐标）—');
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
