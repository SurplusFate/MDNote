# ADR-011 编辑器内核更换：Vditor IR → vanilla ProseMirror

- 日期：2026-10-10
- 状态：已采纳（v1.103-prosemirror）
- 关联：ADR-004（列表缩进）、ADR-005（逻辑光标）、ADR-006（编辑稳定性）、ADR-009（光标补丁）、ADR-010（Selection 模型）

## 背景（v1.92→v1.102 十个版本补丁循环的根因）

v1.92 起编辑器进入补丁循环：列表缩进（ADR-004）、逻辑光标（ADR-005）、点击归位
（ADR-009/010）等「光标定位与列表缩进无法协调」的问题接连修了十个版本仍未根治。
根因在底座：**Vditor IR 的 `setValue` 是整篇重渲染**——任何结构操作（缩进、撤销、
工具栏命令）都会销毁重建 DOM，Kotlin 侧只能「事后映射光标」，映射基准（DOM）每步
都在变，于是每个修复都要再打一层时序/近似补丁。

ADR-010 已把点击光标对标 ProseMirror 的 Selection 模型，但仍在 contenteditable 底座
内打补丁；W3C 已于 2025-02 将 ContentEditable 草稿规范定为 Discontinued。业界共识：
**文档模型为真（Model-First），DOM 只是视图**。与其继续给 Vditor 上夹板，直接换用
vanilla ProseMirror 内核（不经 Tiptap 包装）。

## 决策

1. **内核**：vanilla ProseMirror（prosemirror-model/state/view/keymap/history +
   prosemirror-markdown/markdown-it）。Schema 自建（paragraph/heading/blockquote/
   code_block/bullet_list/ordered_list/list_item/task 行内勾选盒/horizontal_rule/
   raw_block/table_block + bold/italic/code/link/img），Markdown 解析/序列化用
   prosemirror-markdown + markdown-it（tokenHandlers 后置覆盖任务列表/软换行/`$$`）。
2. **桥接契约零改动**：`window.editor.*`（loadMarkdown/getSource/stat/probe/
   enterEditAt/exitEditMode/toggleSourceMode/setToolbarConfig/applyTheme）+ stat/probe
   轮询 + JS→Kotlin 事件队列原样保留，EditorController 主体不动。
3. **存储零改动**：Markdown 文本仍是唯一存储形态（notes.json / WebDAV / 列表页
   Markwon 渲染全保留）。往返保真目标 P1：load→getSource 未触碰部分逐字节稳定；
   未知语法走 raw_block/table_block 原样透传。
4. **撤销/前进**：D3——PM history 直通（WebView 内 editor.undo()/redo()），
   Kotlin 快照栈 EditorHistoryController 退役不装配（文件保留至 v1.104）；顶栏按钮
   点亮由轮询 d.u/d.r（undoDepth/redoDepth）驱动，菜单初始 disabled。
5. **表格与 HTML 块只读渲染**（D2）：markdown-it renderRawHtml 出只读 DOM
   （contentEditable=false），点「源码模式」进 textarea 编辑，保源码往返。
6. **旧资产退役节奏**：editor-vditor.js 与 Vditor assets 保留一个版本周期，v1.104 删。

## 实证发现（构建期踩坑，写进记忆防复发）

- prosemirror-markdown 1.13.8 的 serializer 是 `MarkdownSerializer.serialize(doc)`
  （无 stringify 方法）；marks 键名必须等于 schema mark 名（`bold` 非 `strong`）。
- `$$` 数学块走显式 `state.addNode(raw_block)` handler：noCloseToken block spec 会把
  文本 addText 进 atom 节点，createAndFill 返回 null、静默丢块。
- serializer 构造第三参 `{ tightLists: true }`：列表项之间保持单换行（默认 false 会
  把紧凑列表空行化）。
- 段落缩进的位置模型用 `$from.start()`（内容起点）而非 `$from.before()`（块边界）；
  insertText 在文本节点旁并入节点（+1 位置），在块边界会包装段落 slice、光标跳位。
- build.mjs target es2020（Android 9+ WebView 全覆盖），出包 399.3KB，低于 400KB 红线。

## 验证证据

- 往返测试 28 用例全绿（editor/test/roundtrip.test.js + tx.test.js，node --test）：
  任务列表/嵌套列表/有序 start/软换行/表格/html_block/html_inline/行内公式/硬换行/
  `$$` 块/未闭合 `$$`/seed_notes.json 全量，二次幂等；I1 sink/I2 lift/I3 段落全角
  空格/I4 减缩进/undo-redo 恢复。
- 工作区无 chromium/JDK，e2e 与 Kotlin 编译在真机侧（Android Code Studio）验证，
  见 真机测试清单-v1.103.md。

## 代价与边界

- 内核自维护（schema/commands/inputrules/bridge 共 ~2000 行），社区插件生态不经
  Tiptap 不可直接用；表格编辑器内只读（编辑走源码态）。
- Kotlin 侧 EditorHistoryController 的词级合并撤销粒度由 PM 事务粒度取代
  （连续打字合并由 PM history 内建 newGroupDelay 处理）。
- img:// 协议由 schema toDOM 渲染期换 `https://mdnotes.local/img/` 前缀，存储不变。
