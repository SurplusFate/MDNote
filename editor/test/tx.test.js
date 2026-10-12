// tx.test.js — R2 缩进事务：结构变换与选区映射同事务原子完成（无 DOM，纯 state/tr 断言）
// 运行：npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, TextSelection } from 'prosemirror-state';
import { history, undo, redo } from 'prosemirror-history';
import { mdnotesSchema as schema } from '../src/schema.js';
import { indentCommand, outdentCommand, PARA_INDENT_UNIT } from '../src/commands.js';

const indent = indentCommand(schema);
const outdent = outdentCommand(schema);

function run(cmd, state) {
  let tr = null;
  const ok = cmd(state, (t) => { tr = t; });
  return { ok, tr };
}

function stateWith(doc, pos) {
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

const text = (s) => schema.text(s);   // helper: text node
const para = (...kids) => schema.nodes.paragraph.create(null, kids);
const li = (...kids) => schema.nodes.list_item.create(null, kids);
const ul = (...items) => schema.nodes.bullet_list.create(null, items);

test('I1: 列表项缩进 = sink，结构与光标同事务（R2 核心）', () => {
  // - a
  // - b     ← 光标在 b 开头（pos 7）
  const doc = schema.nodes.doc.create(null, [
    ul(
      li(para(text('a'))),
      li(para(text('b'))),
    ),
  ]);
  const st = stateWith(doc, 7);
  const { ok, tr } = run(indent, st);
  assert.ok(ok);
  // b 应成为 a 的子项
  const root = tr.doc.firstChild;           // bullet_list
  assert.equal(root.childCount, 1);
  const first = root.child(0);              // list_item "a"
  assert.equal(first.childCount, 2);
  const nested = first.child(1);            // 嵌套 bullet_list
  assert.equal(nested.type.name, 'bullet_list');
  assert.equal(nested.child(0).child(0).textContent, 'b');
  // 光标仍落在 b 的段落内
  const sel = tr.selection;
  assert.equal(tr.doc.resolve(sel.from).parent.textContent, 'b');
});

test('I2: 嵌套项减缩进 = lift，回平级且光标保持', () => {
  // - a
  //   - b   ← 光标在 b 开头
  const doc = schema.nodes.doc.create(null, [
    ul(
      li(para(text('a'))),
    ),
  ]);
  // 手工构造嵌套：a 的 list_item 内第二子节点是嵌套 bullet_list
  const nestedDoc = schema.nodes.doc.create(null, [
    ul(
      li(
        para(text('a')),
        ul(li(para(text('b')))),
      ),
    ),
  ]);
  // b 的文本位置：0 doc,1 ul,2 li1,3 p(a) content,4..5 'a'，p 结束 5；
  // 嵌套 ul before=6, content 7, li before=7, content 8, p before=8, content 9, 'b' 9..10
  const st = stateWith(nestedDoc, 9);
  const { ok, tr } = run(outdent, st);
  assert.ok(ok);
  const root = tr.doc.firstChild;
  assert.equal(root.childCount, 2, 'lift 后应有两个平级项');
  assert.equal(root.child(1).textContent, 'b');
  const sel = tr.selection;
  assert.equal(tr.doc.resolve(sel.from).parent.textContent, 'b');
});

test('I3: 段落缩进 = 行首插全角空格，光标落到缩进后', () => {
  const doc = schema.nodes.doc.create(null, [para(text('hello'))]);
  const st = stateWith(doc, 1);
  const { ok, tr } = run(indent, st);
  assert.ok(ok);
  assert.equal(tr.doc.textContent, PARA_INDENT_UNIT + 'hello');
  assert.equal(tr.selection.from, 2, '光标在全角空格之后');
});

test('I4: 段落减缩进 = 删行首一个缩进单元', () => {
  const doc = schema.nodes.doc.create(null, [para(text(PARA_INDENT_UNIT + 'hello'))]);
  const st = stateWith(doc, 1);
  const { ok, tr } = run(outdent, st);
  assert.ok(ok);
  assert.equal(tr.doc.textContent, 'hello');
  assert.equal(tr.selection.from, 1, '光标仍落原处（删除后即行首）');
});

test('I4 边界: 无缩进可减时 no-op（返回 false，不动文档）', () => {
  const doc = schema.nodes.doc.create(null, [para(text('hello'))]);
  const st = stateWith(doc, 1);
  const { ok, tr } = run(outdent, st);
  assert.ok(!ok);
  assert.equal(tr, null);
});

test('I1 边界: 单项列表无法 sink（返回 false）', () => {
  const doc = schema.nodes.doc.create(null, [ul(li(para(text('only'))))]);
  const st = stateWith(doc, 2);
  const { ok } = run(indent, st);
  assert.ok(!ok);
});

test('引用内段落走全角空格分支', () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.blockquote.create(null, [para(text('q'))]),
  ]);
  const st = stateWith(doc, 2);
  const { ok, tr } = run(indent, st);
  assert.ok(ok);
  assert.equal(tr.doc.textContent, PARA_INDENT_UNIT + 'q');
});

test('撤销恢复（R2: 结构变换可逐步撤销）', () => {
  const doc = schema.nodes.doc.create(null, [
    ul(li(para(text('a'))), li(para(text('b')))),
  ]);
  let st = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 7),
    plugins: [history()],
  });
  const { ok, tr } = run(indent, st);
  assert.ok(ok);
  st = st.apply(tr);
  assert.equal(st.doc.textContent.replace(/\n/g, ''), 'ab');
  let undone = null;
  assert.ok(undo(st, (t) => { undone = t; }));
  st = st.apply(undone);
  // 撤销后回到两个平级项
  const root = st.doc.firstChild;
  assert.equal(root.childCount, 2);
  assert.equal(root.child(0).textContent, 'a');
  assert.equal(root.child(1).textContent, 'b');
  // 重做恢复嵌套
  let redone = null;
  assert.ok(redo(st, (t) => { redone = t; }));
  st = st.apply(redone);
  assert.equal(st.doc.firstChild.childCount, 1);
});
