// commands.js — 编辑命令：缩进/减缩进、列表操作、块级与行内格式
//
// 核心（R2）：列表缩进/减缩进 = sinkListItem / liftListItem，
// 结构变换与选区映射在同一事务内原子完成——这正是替换内核的目的。

import {
  chainCommands,
  exitCode,
  baseKeymap,
  toggleMark,
  setBlockType,
  wrapIn,
  liftEmptyBlock,
} from 'prosemirror-commands';
import {
  sinkListItem,
  liftListItem,
  splitListItem,
  wrapInList,
} from 'prosemirror-schema-list';
import { undo as pmUndo, redo as pmRedo } from 'prosemirror-history';

export const PARA_INDENT_UNIT = '\u3000'; // 全角空格：段落首行缩进单元（对齐旧版行为）

function findParentNode($pos, typeName) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === typeName) return { node, pos: $pos.before(d), depth: d };
  }
  return null;
}

/** 当前选区是否在列表项内（任意嵌套深度） */
export function inListItem(state) {
  return !!findParentNode(state.selection.$from, 'list_item');
}

/**
 * 缩进（R2.1/R2.2）：列表项 → sinkListItem（结构+光标同事务）；
 * 段落/标题/引用 → 块首插全角空格（对齐 v1.82 行为）。
 */
export function indentCommand(schema) {
  const liType = schema.nodes.list_item;
  return function (state, dispatch) {
    if (findParentNode(state.selection.$from, 'list_item')) {
      return sinkListItem(liType)(state, dispatch);
    }
    // 段落分支：在当前文本块内容开头插入一个全角空格。
    // 注意位置模型：$from.start() 是内容首字符位置；insertText 在块边界会
    // 把文本包装成段落 slice（step 覆盖 3 个位置，选区映射跳位），故用裸文本
    // ReplaceStep 插入（step 恰好 1 个位置，光标自然落在缩进单元之后）。
    const $from = state.selection.$from;
    const parent = $from.parent;
    const isTextBlock =
      parent.type.spec.group && parent.type.spec.group.split(' ').includes('block') &&
      parent.type.spec.content && parent.type.spec.content.startsWith('inline');
    if (!isTextBlock || state.selection.to !== state.selection.from) return false;
    const contentStart = $from.start();
    if (dispatch) {
      // insertText 在文本节点旁会把字符并入该节点（step 1 位置，光标映射正确）
      dispatch(state.tr.insertText(PARA_INDENT_UNIT, contentStart, contentStart));
    }
    return true;
  };
}

/** 减缩进：列表项 → liftListItem；段落 → 删块首一个缩进单元 */
export function outdentCommand(schema) {
  const liType = schema.nodes.list_item;
  return function (state, dispatch) {
    if (findParentNode(state.selection.$from, 'list_item')) {
      return liftListItem(liType)(state, dispatch);
    }
    const $from = state.selection.$from;
    const parent = $from.parent;
    const isTextBlock =
      parent.type.spec.group && parent.type.spec.group.split(' ').includes('block') &&
      parent.type.spec.content && parent.type.spec.content.startsWith('inline');
    if (!isTextBlock || !state.selection.empty) return false;
    const contentStart = $from.start();
    if (state.doc.textBetween(contentStart, contentStart + PARA_INDENT_UNIT.length) !== PARA_INDENT_UNIT) {
      return false; // 无缩进可去
    }
    if (dispatch) {
      dispatch(state.tr.delete(contentStart, contentStart + PARA_INDENT_UNIT.length));
    }
    return true;
  };
}

/** 任务列表勾选切换：null → true → null 循环（工具栏 check 工具） */
export function toggleTaskItem(state, dispatch) {
  const found = findParentNode(state.selection.$from, 'list_item');
  if (!found) return false;
  const cur = found.node.attrs.checked;
  const next = cur === null || cur === undefined ? true : null;
  if (dispatch) dispatch(state.tr.setNodeMarkup(found.pos, null, { checked: next }));
  return true;
}

/** 列表类型切换：在同类列表内则提升出来，否则包裹 */
export function toggleList(listType) {
  return function (state, dispatch) {
    const found = findParentNode(state.selection.$from, 'list');
    if (found && found.node.type === listType) {
      return liftListItem(state.schema.nodes.list_item)(state, dispatch);
    }
    return wrapInList(listType)(state, dispatch);
  };
}

/** 标题切换：level>0 设标题，0 回段落；已是目标级则回段落（工具栏 headings 菜单） */
export function toggleHeading(schema, level) {
  const hType = schema.nodes.heading;
  return function (state, dispatch) {
    const type = level > 0 ? hType : schema.nodes.paragraph;
    if (state.selection.$from.parent.type === type &&
        (level === 0 || state.selection.$from.parent.attrs.level === level)) {
      return setBlockType(schema.nodes.paragraph)(state, dispatch);
    }
    return setBlockType(type, level > 0 ? { level } : undefined)(state, dispatch);
  };
}

/** 代码块切换 */
export function toggleCodeBlock(schema) {
  return function (state, dispatch) {
    if (state.selection.$from.parent.type === schema.nodes.code_block) {
      return setBlockType(schema.nodes.paragraph)(state, dispatch);
    }
    return setBlockType(schema.nodes.code_block, { lang: '' })(state, dispatch);
  };
}

/** 分割线：把当前（空或全选的）文本块替换为 hr */
export function insertHr(schema) {
  return function (state, dispatch) {
    if (dispatch) {
      const { from, to } = state.selection;
      const $from = state.doc.resolve(from);
      const parentStart = $from.before();
      const parentEnd = $from.after();
      const parent = $from.parent;
      const onlyThisSelected = from === parentStart && to === parentEnd - 1;
      const range = (parent.textContent.length === 0 || onlyThisSelected)
        ? { from: parentStart, to: parentEnd }
        : { from, to };
      dispatch(state.tr.replaceWith(range.from, range.to, schema.nodes.horizontal_rule.create()));
    }
    return true;
  };
}

/** 链接：无链接则加（占位 href），有则摘除（URL 精修走源码态，真机清单覆盖） */
export function toggleLink(state, dispatch) {
  const { from, to, empty } = state.selection;
  const hasLink = state.doc.rangeHasMark(from, to, state.schema.marks.link);
  if (hasLink) return toggleMark(state.schema.marks.link)(state, dispatch);
  if (empty) return false;
  return toggleMark(state.schema.marks.link, { href: 'https://' })(state, dispatch);
}

export function insertHardBreak(state, dispatch) {
  // 软换行（列表项内换行）：Shift+Enter 插 hard_break；代码块内直接换行
  if (state.selection.$from.parent.type.spec.code) return baseKeymap.Enter(state, dispatch);
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hard_break.create()).scrollIntoView());
  }
  return true;
}

export function buildKeymap(schema) {
  const liType = schema.nodes.list_item;
  return {
    ...baseKeymap,
    Enter: chainCommands(splitListItem(liType), exitCode, baseKeymap.Enter),
    'Shift-Enter': (state, dispatch) => {
      // 代码块内 Shift+Enter = 普通换行；其余 = 软换行
      if (state.selection.$from.parent.type.spec.code) return false;
      return insertHardBreak(state, dispatch);
    },
    Tab: indentCommand(schema),
    'Shift-Tab': outdentCommand(schema),
    'Mod-z': pmUndo,
    'Shift-Mod-z': pmRedo,
    'Mod-y': pmRedo,
    'Mod-b': toggleMark(schema.marks.bold),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-e': toggleMark(schema.marks.code),
  };
}

// 供 toolbar / bridge 使用的再导出
export { chainCommands, toggleMark, setBlockType, wrapIn, liftEmptyBlock, baseKeymap, pmUndo, pmRedo, sinkListItem, liftListItem, splitListItem, wrapInList, findParentNode };
