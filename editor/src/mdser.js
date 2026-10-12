// mdser.js — ProseMirror 文档 → Markdown（往返保真的另一半）
//
// 关键点：
// - 任务列表项：首段前写 "[ ] / [x] "（renderList 的 marker 之后）
// - table_block / raw_block：attrs.raw 原样输出
// - 软换行是文本节点里的 "\n"，text() 原样写出（字节稳定）

import { MarkdownSerializer } from 'prosemirror-markdown';

export function createSerializer(schema) {
  // tightLists: 列表项间保持单换行（对齐 MDNote 存储形态，避免往返膨胀空行）
  return new MarkdownSerializer(
    {
      blockquote(state, node) {
        state.wrapBlock('> ', null, node, () => state.renderContent(node));
      },

      code_block(state, node) {
        const backticks = node.textContent.match(/`{3,}/gm);
        const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```';
        state.write(fence + (node.attrs.lang || '') + '\n');
        state.text(node.textContent, false);
        state.write('\n');
        state.write(fence);
        state.closeBlock(node);
      },

      heading(state, node) {
        state.write(state.repeat('#', node.attrs.level) + ' ');
        state.renderInline(node, false);
        state.closeBlock(node);
      },

      horizontal_rule(state, node) {
        state.write('---');
        state.closeBlock(node);
      },

      bullet_list(state, node) {
        state.renderList(node, '  ', () => '- ');
      },

      ordered_list(state, node) {
        const start = node.attrs.start || 1;
        const maxW = String(start + node.childCount - 1).length;
        const space = state.repeat(' ', maxW + 2);
        state.renderList(node, space, (i) => {
          const nStr = String(start + i);
          return state.repeat(' ', maxW - nStr.length) + nStr + '. ';
        });
      },

      list_item(state, node) {
        if (node.attrs.checked === null || node.attrs.checked === undefined) {
          state.renderContent(node);
          return;
        }
        state.write(node.attrs.checked ? '[x] ' : '[ ] ');
        let i = 0;
        if (node.childCount && node.child(0).type === schema.nodes.paragraph) {
          state.renderInline(node.child(0));
          state.closeBlock(node.child(0));
          i = 1;
        }
        for (; i < node.childCount; i++) state.render(node.child(i), node, i);
      },

      paragraph(state, node) {
        state.renderInline(node);
        state.closeBlock(node);
      },

      // table_block / raw_block 共用：原样透传
      table_block(state, node) {
        state.text(node.attrs.raw || '', false);
        state.closeBlock(node);
      },
      raw_block(state, node) {
        state.text(node.attrs.raw || '', false);
        state.closeBlock(node);
      },

      image(state, node) {
        // src 是 img:// 或普通 URL，括号转义防炸结构
        const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
        state.write(
          '![' + state.esc(node.attrs.alt || '') + '](' + src +
          (node.attrs.title ? ' "' + node.attrs.title.replace(/"/g, '\\"') + '"' : '') + ')'
        );
      },

      hard_break(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\\\n');
            return;
          }
        }
      },

      text(state, node) {
        state.text(node.text || '', !state.inAutolink);
      },
    },
    {
      bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
      em: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
      strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
      link: {
        open(state, mark, parent, index) {
          state.inAutolink = isPlainURL(mark, parent, index);
          return state.inAutolink ? '<' : '[';
        },
        close(state, mark, parent, index) {
          const inAutolink = state.inAutolink;
          state.inAutolink = undefined;
          if (inAutolink) return '>';
          const href = String(mark.attrs.href || '').replace(/[()"]/g, '\\$&');
          return '](' + href +
            (mark.attrs.title ? ' "' + mark.attrs.title.replace(/"/g, '\\"') + '"' : '') + ')';
        },
        mixable: true,
      },
      code: {
        open(state, mark, parent, index) { return backticksFor(parent.child(index), -1); },
        close(state, mark, parent, index) { return backticksFor(parent.child(index - 1), 1); },
        escape: false,
      },
    },
    { tightLists: true }
  );
}

function backticksFor(node, side) {
  const ticks = /`+/g;
  let m;
  let len = 0;
  if (node.isText) while ((m = ticks.exec(node.text))) len = Math.max(len, m[0].length);
  let result = len > 0 && side > 0 ? ' `' : '`';
  for (let i = 0; i < len; i++) result += '`';
  if (len > 0 && side < 0) result += ' ';
  return result;
}

function isPlainURL(link, parent, index) {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== link.attrs.href ||
      content.marks[content.marks.length - 1] !== link) return false;
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}
