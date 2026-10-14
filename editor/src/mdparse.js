// mdparse.js — Markdown → ProseMirror 文档（markdown-it + prosemirror-markdown）
//
// 保真策略（R5）：
// - 任务列表：markdown-it core 规则识别 "[ ] / [x] " 前缀，写入 list_item attrs
// - 表格：table_open..table_close 之间的源码行原样进 table_block（atom 透传）
// - HTML 块：html_block 原样进 raw_block
// - 软换行：段内 "\n" 保留为文本字符（字节稳定），Vditor 旧版会合并成空格
// - 行内 HTML：按原文进文本流（序列化时会转义，已知边界）

import MarkdownIt from 'markdown-it';
import { MarkdownParser } from 'prosemirror-markdown';

function stripTrailingNewlines(s) {
  return s.replace(/\n+$/, '');
}

// raw 块只读渲染（D2）：markdown-it 输出 HTML（表格 / HTML 块），点击区
// contenteditable=false，编辑走源码态。与解析实例分离，互不影响 token 规则。
const rendererMd = new MarkdownIt({ html: true, linkify: false, breaks: false });

export function renderRawHtml(src) {
  try {
    return rendererMd.render(src || '');
  } catch (e) {
    return '';
  }
}

/**
 * 任务列表 core 规则：inline 解析完成后扫描，
 * list_item_open > paragraph_open > inline 且内容以 "[ ]"/"[x]"/"[X]" 开头时：
 *   - 给 list_item_open 打 data-checked 属性（handler 里转成节点 attrs）
 *   - 从 inline 内容与其首个 text child 中剥掉该前缀
 */
function tasklistRule(state) {
  const tokens = state.tokens;
  const stack = [];
  let lastItemOpen = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.nesting === 1) {
      stack.push(tok.type);
      if (tok.type === 'list_item_open') lastItemOpen = tok;
    } else if (tok.nesting === -1) {
      stack.pop();
    }
    if (tok.type !== 'inline') continue;
    const n = stack.length;
    if (n < 2 || stack[n - 1] !== 'paragraph_open' || stack[n - 2] !== 'list_item_open') continue;
    const m = tok.content.match(/^\[([ xX])\]( +|$)/);
    if (!m) continue;
    if (!lastItemOpen) continue;
    const rest = tok.content.slice(m[0].length);
    tok.content = rest;
    const first = tok.children && tok.children[0];
    if (first && first.type === 'text') {
      if (first.content.startsWith(m[0])) first.content = first.content.slice(m[0].length);
      else first.content = rest;
    }
    lastItemOpen.attrSet('data-checked', m[1] === ' ' ? 'false' : 'true');
  }
}

export function createParser(schema) {
  const md = new MarkdownIt({ html: true, linkify: false, breaks: false });
  md.core.ruler.push('mdnotes_tasklist', tasklistRule);

  // 块级公式 $$...$$：识别为专属块（防止 commonmark 把 "=\n" 行当 setext
  // heading 下划线吞掉公式内容），剥离 $$ 后存为 math_block 节点，
  // 由 bridge 的 math NodeView 用 KaTeX 渲染。
  function mathBlockRule(state, startLine, endLine, silent) {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const startMax = state.eMarks[startLine];
    const first = state.src.slice(startPos, startMax).trim();
    if (!first.startsWith('$$')) return false;
    if (first.length > 4 && first.endsWith('$$')) {
      // 单行完整块：$$x$$
      if (!silent) {
        const tok = state.push('mdnotes_math_block', '', 0);
        tok.content = state.src.slice(startPos, startMax);
        tok.markup = '$$';
        tok.map = [startLine, startLine + 1];
        state.line = startLine + 1;
      }
      return true;
    }
    // 多行块：找闭合 "$$" 行（或 $$x$$ 形态的行）
    let next = startLine + 1;
    while (next < endLine) {
      const p = state.bMarks[next] + state.tShift[next];
      const line = state.src.slice(p, state.eMarks[next]).trim();
      if (line === '$$' || (line.startsWith('$$') && line.endsWith('$$') && line.length > 4)) break;
      next++;
    }
    if (next >= endLine) return false;   // 未闭合：放行走后续规则（普通文本）
    if (silent) return true;
    const tok = state.push('mdnotes_math_block', '', 0);
    tok.content = state.src.slice(state.bMarks[startLine], state.eMarks[next]);
    tok.markup = '$$';
    tok.map = [startLine, next + 1];
    state.line = next + 1;
    return true;
  }
  md.block.ruler.before('fence', 'mdnotes_math_block', mathBlockRule);

  // 行内公式 $...$（非 $$）：inline ruler。行级 $$ 已在 mathBlockRule 消费，
  // 不会流到此处；段落内的 $...$ 在此识别。
  function inlineMathRule(state, silent) {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    if (src.charCodeAt(pos + 1) === 0x24) return false; // 让位块级 $$
    const start = pos + 1;
    let end = start;
    while (end < state.posMax) {
      const c = src.charCodeAt(end);
      if (c === 0x5c /* \ */) { end += 2; continue; } // 跳过转义字符
      if (c === 0x24) break; // 找到闭合 $
      end++;
    }
    if (end >= state.posMax) return false;
    const content = src.slice(start, end);
    if (!content || /^\s|\s$/.test(content)) return false; // 禁止首尾空白（避免吃货币符号）
    if (!silent) {
      const tok = state.push('mdnotes_math_inline', '', 0);
      tok.content = content;
      tok.markup = '$';
    }
    state.pos = end + 1;
    return true;
  }
  md.inline.ruler.before('escape', 'mdnotes_math_inline', inlineMathRule);

  let srcLines = [];

  const tokens = {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: {
      block: 'list_item',
      getAttrs: (tok) => {
        const v = tok.attrGet('data-checked');
        return { checked: v === null ? null : v === 'true' };
      },
    },
    bullet_list: { block: 'bullet_list' },
    ordered_list: {
      block: 'ordered_list',
      getAttrs: (tok) => ({ start: +tok.attrGet('start') || 1 }),
    },
    heading: { block: 'heading', getAttrs: (tok) => ({ level: +tok.tag.slice(1) }) },
    code_block: { block: 'code_block', noCloseToken: true, getAttrs: () => ({ lang: '' }) },
    fence: {
      block: 'code_block',
      noCloseToken: true,
      getAttrs: (tok) => ({ lang: (tok.info || '').trim() }),
    },
    hr: { node: 'horizontal_rule' },
    image: {
      node: 'image',
      getAttrs: (tok) => ({
        src: tok.attrGet('src') || '',
        title: tok.attrGet('title') || null,
        alt: (tok.children && tok.children[0] && tok.children[0].content) || null,
      }),
    },
    hardbreak: { node: 'hard_break' },
    em: { mark: 'em' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    link: {
      mark: 'link',
      getAttrs: (tok) => ({
        href: tok.attrGet('href') || '',
        title: tok.attrGet('title') || null,
      }),
    },
    code_inline: { mark: 'code', noCloseToken: true },
    html_block: {
      node: 'raw_block',
      getAttrs: (tok) => ({ raw: stripTrailingNewlines(tok.content) }),
    },
  };

  const parser = new MarkdownParser(schema, md, tokens);

  // 表格：整段源码原样进 table_block，跳过 table 内部全部 token。
  // 实证（node:test roundtrip）：table_close.map 可为 null（孤立 token），
  // 不可依赖 —— table_open.map = [startLine, endLine) 自含表格行范围。
  parser.tokenHandlers.table_open = (state, tok, toks, i) => {
    let close = -1;
    for (let j = i + 1; j < toks.length; j++) {
      if (toks[j].type === 'table_close') { close = j; break; }
    }
    if (close < 0) return;
    const start = tok.map ? tok.map[0] : 0;
    const endLine = tok.map ? tok.map[1] : start;
    const raw = srcLines.slice(Math.max(0, start), Math.max(start, endLine)).join('\n');
    state.addNode(schema.nodes.table_block, { raw });
    toks.splice(i + 1, close - i); // 消费掉内部 token，外层循环跳过
  };

  // 软换行保留为换行字符（默认实现会折成空格，破坏多行段落字节稳定）
  parser.tokenHandlers.softbreak = (state) => state.addText('\n');

  // 行内 HTML 原文进文本流（序列化时会转义，已知边界）
  parser.tokenHandlers.html_inline = (state, tok) => state.addText(tok.content);

  // 数学块：$$...$$ → math_block 节点（atom），latex 由 KaTeX 在 NodeView 渲染。
  // 必须走显式 addNode（atom 无 content）—— 若配成 block spec，PM 会 addText 进节点，
  // atom 节点 createAndFill 失败返回 null，整块静默消失。
  // 剥掉首尾的 $$ 标记与多余空白，得到纯 latex。
  function stripMathFence(s) {
    return stripTrailingNewlines(s || '')
      .replace(/^\s*\$\$?\s*/, '')
      .replace(/\s*\$\$?\s*$/, '');
  }
  parser.tokenHandlers.mdnotes_math_block = (state, tok) => {
    state.addNode(schema.nodes.math_block, { latex: stripMathFence(tok.content) });
  };

  // 行内公式 $...$ → math_inline 节点（atom）
  parser.tokenHandlers.mdnotes_math_inline = (state, tok) => {
    state.addNode(schema.nodes.math_inline, { latex: tok.content });
  };

  // 包装 tokenizer：记录源码行（table 原样提取用）
  const innerParse = md.parse.bind(md);
  const tokenizer = {
    parse(text, env) {
      srcLines = String(text).split('\n');
      return innerParse(text, env);
    },
    renderer: md.renderer,
  };
  parser.tokenizer = tokenizer;
  return parser;
}
