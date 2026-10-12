// roundtrip.test.js — P1 往返保真：parse→serialize→parse→serialize 幂等 + 关键语法断言
// 运行：npm test（node --test，无 DOM 依赖）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mdnotesSchema } from '../src/schema.js';
import { createParser } from '../src/mdparse.js';
import { createSerializer } from '../src/mdser.js';

const parser = createParser(mdnotesSchema);
const ser = createSerializer(mdnotesSchema);
const rt = (src) => ser.serialize(parser.parse(src));

/** 二次幂等：load→getSource→load→getSource 未触碰部分字节稳定（P1 核心） */
function assertIdempotent(src) {
  const once = rt(src);
  const twice = rt(once);
  assert.equal(twice, once, 'not idempotent:\n  in:    ' + JSON.stringify(src) +
    '\n  once:  ' + JSON.stringify(once) + '\n  twice: ' + JSON.stringify(twice));
  return once;
}

test('任务列表往返（[ ] / [x] 前缀）', () => {
  const out = assertIdempotent('- [ ] 买牛奶\n- [x] 已付款');
  assert.equal(out, '- [ ] 买牛奶\n- [x] 已付款');
});

test('嵌套列表往返（紧凑形态）', () => {
  const out = assertIdempotent('- a\n  - nested\n- b');
  assert.equal(out, '- a\n  - nested\n- b');
});

test('有序列表起始号保真', () => {
  const out = assertIdempotent('3. three\n4. four');
  assert.equal(out, '3. three\n4. four');
});

test('有序列表 start 属性反解（markdown-it 输出 start attr）', () => {
  // "3." 起始列表 parse 出 ordered_list start=3
  const doc = parser.parse('3. three');
  const ol = doc.firstChild;
  assert.equal(ol.type.name, 'ordered_list');
  assert.equal(ol.attrs.start, 3);
});

test('软换行逐字节保留（同段内单换行）', () => {
  const out = assertIdempotent('line1\nline2\nline3');
  assert.equal(out, 'line1\nline2\nline3');
});

test('表格原样透传（含分隔行与行内样式）', () => {
  const src = '| a | b |\n| --- | --- |\n| **1** | `2` |';
  const out = assertIdempotent(src);
  assert.equal(out, src);
});

test('表格前后的内容不受影响', () => {
  const out = assertIdempotent('# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter');
  assert.equal(out, '# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter');
});

test('HTML 块原样透传', () => {
  const out = assertIdempotent('x\n\n<div>\nblock html\n</div>\n\ny');
  assert.equal(out, 'x\n\n<div>\nblock html\n</div>\n\ny');
});

test('行内 HTML 原样往返（esc 不转义尖括号，html:true 再识别）', () => {
  const out = assertIdempotent('这是 <u>下划线</u> 文本');
  assert.equal(out, '这是 <u>下划线</u> 文本');
});

test('行内样式：加粗/斜体/删除线/行内代码', () => {
  const out = assertIdempotent('**加粗**、*斜体*、~~删除线~~、`code`');
  assert.equal(out, '**加粗**、*斜体*、~~删除线~~、`code`');
});

test('链接与图片（img:// 源码形态）', () => {
  assert.equal(rt('[text](https://a.b)'), '[text](https://a.b)');
  assert.equal(rt('![alt](img://key)'), '![alt](img://key)');
});

test('标题与引用', () => {
  const out = assertIdempotent('# 标题\n\n> quoted\n> more');
  assert.equal(out, '# 标题\n\n> quoted\n> more');
});

test('分割线', () => {
  assert.equal(rt('---'), '---');
});

test('代码围栏语言保留', () => {
  const out = assertIdempotent('```kotlin\nfun x()\n```');
  assert.equal(out, '```kotlin\nfun x()\n```');
});

test('未知语法（行内公式 $）作为纯文本字节稳定', () => {
  assert.equal(rt('$E = mc^2$'), '$E = mc^2$');
  // 字面反斜杠按 markdown 规则转义，二次幂等
  const out = assertIdempotent('$E = mc^2$ 与 $\\alpha$');
  assert.equal(out, '$E = mc^2$ 与 $\\\\alpha$');
});

test('块级公式 $$...$$ 原样透传（防 setext heading 吞内容）', () => {
  const src = '$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$';
  assert.equal(rt(src), src);
  // 段间多行块 + 块内空行
  const src2 = '段1\n\n$$\nA\n\nB\n$$\n\n段2';
  assert.equal(rt(src2), src2);
  // 块内 "=" 行若不透传会被 commonmark 当 setext 下划线吞掉
  const src3 = '$$\n\\begin{bmatrix} x \\\\ y \n\\end{bmatrix}\n=\n\\begin{bmatrix} ax \n$$';
  assert.equal(rt(src3), src3);
});

test('未闭合 $$ 走普通文本（不吞行）', () => {
  assertIdempotent('# A\n\n$$\n未闭合公式');
});

test('硬换行规范化（两空格 → 反斜杠），二次幂等', () => {
  const out = assertIdempotent('a  \nb');
  assert.equal(out, 'a\\\nb');
});

test('中文序号 "1、" 保持纯文本（输入规则只在打字时触发）', () => {
  assert.equal(rt('1、中文序号'), '1、中文序号');
});

test('seed_notes.json 全量笔记二次幂等', async () => {
  const raw = await readFile(new URL('../../app/src/main/assets/seed_notes.json',
    import.meta.url), 'utf8');
  const arr = JSON.parse(raw);
  const notes = Array.isArray(arr) ? arr : (arr.notes || Object.values(arr)[0]);
  assert.ok(notes.length >= 5, 'seed notes should exist');
  for (const n of notes) {
    assertIdempotent(n.content || '');
  }
});
