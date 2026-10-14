// schema.js — MDNotes 文档模型（ProseMirror schema）
//
// 设计约束（specs/prosemirror-editor-kernel/design.md）：
// - list_item.checked: null=普通项 / true / false —— 任务列表用同一个节点类型，
//   序列化为 "- [ ]"/"- [x]"，缩进/减缩进（sink/lift）对普通与任务项行为一致。
// - table_block / raw_block：atom 原样透传节点，保证往返逐字节稳定（P1 生命线）。
// - image.src 永远保存 img://key 原文；渲染 DOM 时才改写为可加载地址。

import { Schema } from 'prosemirror-model';

const blockMarkdown = {
  parseDOM: [{ tag: 'div[data-md-raw]' }],
  toDOM: () => ['div', { 'data-md-raw': '1' }, 0],
};

export const mdnotesSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },

    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },

    heading: {
      group: 'block',
      content: 'inline*',
      defining: true,
      attrs: { level: { default: 1, validate: 'number' } },
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        getAttrs: () => ({ level }),
      })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },

    bullet_list: {
      group: 'block',
      content: 'list_item+',
      defining: true,
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },

    ordered_list: {
      group: 'block',
      content: 'list_item+',
      defining: true,
      attrs: { start: { default: 1, validate: 'number' } },
      parseDOM: [
        {
          tag: 'ol',
          getAttrs: (dom) => ({
            start: dom.hasAttribute('start') ? +dom.getAttribute('start') : 1,
          }),
        },
      ],
      toDOM: (node) => [
        'ol',
        node.attrs.start !== 1 ? { start: node.attrs.start } : {},
        0,
      ],
    },

    // checked: null = 普通列表项；true/false = 任务项（勾选状态）
    list_item: {
      content: 'paragraph block*',
      defining: true,
      attrs: { checked: { default: null } },
      parseDOM: [{ tag: 'li' }],
      // 注意：内容孔 0 必须是其所在元素的唯一子节点（PM 硬性约束）。
      // 任务项把勾选框 span 与内容孔 0 并列会导致渲染抛
      // "Content hole must be the only child of its parent node"、整页空白。
      // 因此勾选框与正文分别包进独立元素，0 独占 .md-task-body。
      toDOM: (node) => {
        if (node.attrs.checked === null || node.attrs.checked === undefined) return ['li', 0];
        return ['li', {
          class: 'md-task' + (node.attrs.checked ? ' md-task--on' : ''),
          'data-checked': String(node.attrs.checked),
        }, ['span', { class: 'md-task-box', contenteditable: 'false' }], ['span', { class: 'md-task-body' }, 0]];
      },
    },

    blockquote: {
      group: 'block',
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },

    code_block: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      attrs: { lang: { default: '' } },
      parseDOM: [
        {
          tag: 'pre',
          preserveWhitespace: 'full',
          getAttrs: (dom) => ({
            lang: (dom.querySelector('code') || dom).getAttribute('data-lang') || '',
          }),
        },
      ],
      toDOM: (node) => [
        'pre',
        { 'data-lang': node.attrs.lang || null },
        ['code', 0],
      ],
    },

    horizontal_rule: {
      group: 'block',
      atom: true,
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },

    // GFM 表格原样透传（D2：首版只读渲染 + 源码态编辑）
    table_block: {
      group: 'block',
      atom: true,
      attrs: { raw: { default: '' } },
      ...blockMarkdown,
    },

    // 一切不可解析块（HTML 块/脚注区/其他方言）原样透传（R5.3）
    raw_block: {
      group: 'block',
      atom: true,
      attrs: { raw: { default: '' } },
      ...blockMarkdown,
    },

    image: {
      group: 'inline',
      inline: true,
      atom: true,
      draggable: true,
      attrs: {
        src: { default: '' },
        alt: { default: null },
        title: { default: null },
      },
      parseDOM: [
        {
          tag: 'img[src]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src'),
            alt: dom.getAttribute('alt'),
            title: dom.getAttribute('title'),
          }),
        },
      ],
      toDOM: (node) => {
        // img:// 协议只存在于文档模型；渲染 DOM 换成 WebView 可加载的同源假地址，
        // 由 Kotlin shouldInterceptRequest 供流。序列化永远读 attrs.src，往返不受影响。
        let src = node.attrs.src || '';
        if (src.startsWith('img://')) src = 'https://mdnotes.local/img/' + src.slice(6);
        return ['img', { src, alt: node.attrs.alt || '', title: node.attrs.title || null }];
      },
    },

    hard_break: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },

    // 行内公式 $...$（atom；视觉由 bridge 的 math NodeView 用 KaTeX 渲染）
    math_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { latex: { default: '' } },
      parseDOM: [{
        tag: 'span[data-md-math-inline]',
        getAttrs: (dom) => ({ latex: dom.getAttribute('data-latex') || '' }),
      }],
      toDOM: (node) => ['span', {
        'data-md-math-inline': '1',
        'data-latex': node.attrs.latex,
        class: 'md-math-inline',
      }],
    },

    // 块级公式 $$...$$（atom；视觉由 KaTeX 渲染）
    math_block: {
      group: 'block',
      atom: true,
      attrs: { latex: { default: '' } },
      parseDOM: [{
        tag: 'div[data-md-math-block]',
        getAttrs: (dom) => ({ latex: dom.getAttribute('data-latex') || '' }),
      }],
      toDOM: (node) => ['div', {
        'data-md-math-block': '1',
        'data-latex': node.attrs.latex,
        class: 'md-math-block',
      }],
    },

    text: { group: 'inline' },
  },

  marks: {
    bold: {
      parseDOM: [
        { tag: 'strong' },
        { tag: 'b', getAttrs: (dom) => (dom.style.fontWeight !== 'normal' ? null : false) },
        { style: 'font-weight', getAttrs: (v) => (/^(bold(er)?|[5-9]\d{2,})$/.test(v) && null) },
      ],
      toDOM: () => ['strong', 0],
    },
    em: {
      parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
      toDOM: () => ['s', 0],
    },
    code: {
      code: true,
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
    link: {
      inclusive: false,
      attrs: {
        href: { default: '' },
        title: { default: null },
      },
      parseDOM: [
        {
          tag: 'a[href]',
          getAttrs: (dom) => ({
            href: dom.getAttribute('href'),
            title: dom.getAttribute('title'),
          }),
        },
      ],
      toDOM: (node) => ['a', { href: node.attrs.href, title: node.attrs.title || null }, 0],
    },
  },
});

/** 空文档（首开/新建用） */
export function emptyDoc() {
  return mdnotesSchema.nodes.doc.createAndFill();
}

/** 空段落 */
export function emptyParagraph() {
  return mdnotesSchema.nodes.paragraph.createAndFill();
}

/** 空文档判定（空态占位用）：无内容，或仅一个无文本段落 */
export function isEmptyDoc(doc) {
  if (!doc || doc.childCount === 0) return true;
  if (doc.childCount > 1) return false;
  const first = doc.firstChild;
  return first.type === mdnotesSchema.nodes.paragraph &&
    first.content.size === 0;
}
