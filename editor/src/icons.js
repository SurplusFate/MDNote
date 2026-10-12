// icons.js — 工具栏图标（自旧版 Vditor sprite 提取的等价 path，视觉零迁移成本）
// eslint-disable-next-line
import ICONS_JSON from './icons.json';

const ICONS = {};
for (const it of ICONS_JSON) {
  ICONS[it.id] =
    '<svg viewBox="' + it.viewBox + '" width="16" height="16" aria-hidden="true">' +
    it.body + '</svg>';
}

// 图片按钮（对齐旧版自绘 SVG）
ICONS['image'] =
  '<svg viewBox="0 0 32 32" width="16" height="16" fill="none" stroke="currentColor"' +
  ' stroke-width="2.5" aria-hidden="true">' +
  '<rect x="4" y="6" width="24" height="20" rx="2"></rect>' +
  '<circle cx="11" cy="13" r="2.5" fill="currentColor" stroke="none"></circle>' +
  '<path d="M6 23l6-7 4 4.5 3-3.5 7 6" stroke-linejoin="round" stroke-linecap="round"></path>' +
  '</svg>';

export function icon(id) {
  return ICONS[id] || '';
}

export const LABELS = {
  headings: '标题',
  bold: '加粗',
  italic: '斜体',
  strike: '删除线',
  link: '链接',
  list: '无序列表',
  'ordered-list': '有序列表',
  check: '任务列表',
  quote: '引用',
  line: '分割线',
  code: '代码块',
  'inline-code': '行内代码',
  indent: '缩进',
  outdent: '减缩进',
  undo: '撤销',
  redo: '重做',
  fullscreen: '全屏',
  image: '图片',
};

/** 未配置时的默认顺序（与 Tool.kt builtIns 一致） */
export const DEFAULT_TOOLS = [
  'headings', 'bold', 'italic', 'strike', 'link',
  'list', 'ordered-list', 'check', 'quote',
  'line', 'code', 'inline-code', 'indent', 'outdent',
  'undo', 'redo', 'fullscreen', 'image',
];
