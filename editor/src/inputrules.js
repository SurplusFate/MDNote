// inputrules.js — Markdown 块级输入规则（Typora 手感：行首打字即转结构）
//
// 覆盖：标题 #、无序 - * +、有序 1. / 1) / 1（中英两式）、任务 [ ] [x]、
//       引用 >、代码围栏 ```、分割线 ---。
// 行内规则（**加粗** 等）首版不做，工具栏可完成同等操作（design.md 已声明边界）。

import { InputRule, inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules';
import { wrapIn } from 'prosemirror-commands';

export function buildInputRules(schema) {
  const rules = [];

  // # ~ ###### + 空格 → 标题
  rules.push(textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading,
    (match) => ({ level: match[1].length })));

  // - / * / + + 空格 → 无序列表
  rules.push(wrappingInputRule(/^\s*([-*+])\s$/, schema.nodes.bullet_list));

  // 1. / 1) + 空格 → 有序列表（起始号保真）
  rules.push(wrappingInputRule(/^\s*(\d+)[.)]\s$/, schema.nodes.ordered_list,
    (match) => ({ start: +match[1] }),
    (match, node) => node.childCount + node.attrs.start === +match[1]));

  // 中文序号：1、 → 有序列表
  rules.push(wrappingInputRule(/^\s*(\d+)、$/, schema.nodes.ordered_list,
    (match) => ({ start: +match[1] }),
    (match, node) => node.childCount + node.attrs.start === +match[1]));

  // > + 空格 → 引用
  rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));

  // [ ] / [x] + 空格 → 任务项（需已在列表项内：配合 "- [ ] " 的打字顺序）
  rules.push(new InputRule(/^\[([ xX])\]\s$/, (state, match, start, end) => {
    const $from = state.doc.resolve(start);
    let li = null;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'list_item') { li = { pos: $from.before(d), node: $from.node(d) }; break; }
    }
    if (!li) return null;
    // 仅当列表项内容就是这段标记本身（避免误改有内容的项）
    const liStart = li.pos + 1;
    const liText = state.doc.textBetween(liStart, end, '\n', '\n');
    if (liText.replace(/^[\s]*/, '').length > match[0].length) return null;
    return state.tr
      .delete(start, end)
      .setNodeMarkup(li.pos, null, { checked: match[1] !== ' ' });
  }));

  // ``` + 空格 → 代码块（info string 可带语言）
  rules.push(textblockTypeInputRule(/^```([a-zA-Z0-9_+-]*)\s$/, schema.nodes.code_block,
    (match) => ({ lang: match[1] })));

  // --- / *** / ___ + 空格 → 分割线
  rules.push(new InputRule(/^(?:---|\*\*\*|___)\s$/, (state, _match, start, end) => {
    const $from = state.doc.resolve(start);
    const parentStart = $from.before();
    const parentEnd = $from.after();
    if (state.doc.resolve(end).parent.textContent.replace(/^(?:---|\*\*\*|___)\s*$/, '').length > 0) return null;
    return state.tr.replaceWith(parentStart, parentEnd, schema.nodes.horizontal_rule.create());
  }));

  return inputRules({ rules });
}
