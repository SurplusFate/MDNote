# 需求文档：ProseMirror 编辑器内核替换

Feature Name: prosemirror-editor-kernel
Updated: 2026-10-10
状态：已确认（D1~D3 按推荐方案采纳，2026-10-10）

## 引言

把编辑页 WebView 内的 Vditor IR 内核替换为 ProseMirror 内核，根治「光标定位与列表缩进无法协调」的问题。

根因：Vditor IR 下任何结构变换（缩进/减缩进）都走「改源码 → setValue 整篇重渲染 → 事后按 {blockIndex, offset} 把光标映射回去」，光标恢复是猜测，映射假设一碰边角（懒延续、空项、列表合并、有序重排）就断，v1.92→v1.102 十个版本反复打补丁即是证据。ProseMirror 的事务（transaction）+ 位置映射（position mapping）把「结构变换」与「光标新位置」放进同一个原子操作，这正是 Typora 类编辑器协调能力的来源。

不变的部分：Kotlin 侧桥接契约（`window.editor.*` + stat/probe 轮询 + JS→Kotlin 事件队列）、Markdown 存储格式、WebDAV 同步、列表页 Markwon 预览、工具栏自定义配置、主题系统。

## 术语表

- **内核**：WebView 页内承担「数据模型 → DOM 渲染 → 光标/选区 → 输入处理」的 JS 编辑器引擎
- **事务（transaction）**：ProseMirror 中一次原子文档变更，自带步骤（steps）与选区映射
- **桥接契约**：Kotlin ↔ JS 的既有接口，见 `EditorController.kt` 与 `editor-vditor.js` 的 `window.editor`
- **往返保真（round-trip）**：Markdown 源码 → 编辑器文档模型 → Markdown 源码，未编辑部分逐字节稳定
- **img:// 协议**：本 App 内嵌图的伪协议，由 `EditorImageController` 拦截供流

## 需求

### R1 内核替换（架构）

**User Story:** 作为用户，我想要一个内核级重做的编辑器，使光标与缩进从架构上协调，从而告别打补丁循环。

#### 验收标准

1. THE 编辑器 SHALL 使用 ProseMirror（或其等价事务化内核）作为 WebView 页内的文档模型与渲染引擎。
2. THE 编辑器 SHALL 保持既有桥接契约：`window.editor` 暴露 loadMarkdown / getSource / stat / probe / enterEditAt / exitEditMode / applyTheme / insertImage / toggleSourceMode / indentLine / outdentLine / setToolbarConfig 等同名方法，JS→Kotlin 事件队列（undo/redo/pickImage）语义不变。
3. THE 系统 SHALL 保持 Markdown 纯文本存储，notes.json 结构与 WebDAV 同步逻辑零改动。
4. THE 内核代码 SHALL 以预构建单文件 bundle 落入 assets，运行期零网络依赖（file:// 环境可用）。

### R2 缩进-光标原子协调（本次核心目标）

**User Story:** 作为用户，我想要在列表任意位置按缩进/减缩进后光标原地不动，从而获得 Typora 式的编辑手感。

#### 验收标准

1. WHEN 用户在列表项内任意字符位置触发缩进或减缩进（工具栏按钮或 Tab / Shift+Tab），THE 编辑器 SHALL 在同一事务内完成结构变换与选区映射，光标保持在原文相同字符之前。
2. WHEN 缩进引发有序列表重排或减缩进引发相邻列表合并，THE 编辑器 SHALL 把光标映射到原文相同字符在变换后文档中的新位置。
3. IF 选区映射后目标位置失效（如空项被清理），THE 编辑器 SHALL 将光标落在变换点最近的合法位置，且不跳到文档开头。
4. WHILE 列表嵌套深度在 1~5 层，THE 编辑器 SHALL 对无序 / 有序 / 任务列表及混合嵌套提供一致的缩进-光标行为。

### R3 点击光标归位

**User Story:** 作为用户，我想要点击任意块的任意位置光标都精确落位，从而免去「点开头落到别处」的怪癖。

#### 验收标准

1. WHEN 用户点按任意块（含含子列表的嵌套父项）的任意位置，THE 编辑器 SHALL 将光标落在点击处对应的字符边界（由内核 hit-test，posAtCoords）。
2. WHEN 用户拖拽框选，THE 编辑器 SHALL 保持原生选区行为（含跨块选择）。
3. WHEN 中文 IME 组合输入期间，THE 编辑器 SHALL 保持组合文本完整且光标跟随组合位置（ProseMirror 原生 composition 处理）。

### R4 撤销 / 前进

**User Story:** 作为用户，我想要撤销/前进精确到每一步结构变换，从而放心操作。

#### 验收标准

1. WHEN 用户触发撤销（工具栏 / 辅助栏 / 事件），THE 编辑器 SHALL 回退最近一步变更并恢复该步之前的选区。
2. THE 编辑器 SHALL 对缩进/减缩进等结构变换提供逐步撤销（每步一次撤销）。
3. THE 撤销/前进 SHALL 经既有 JS→Kotlin 事件或桥方法触发，工具栏按钮语义不变。（实现归属：PM history 还是 Kotlin 快照栈，见开放决策 D3）

### R5 Markdown 往返保真

**User Story:** 作为用户，我想要编辑器不再偷偷改写我的源码，从而让多设备同步与预览稳定一致。

#### 验收标准

1. THE 编辑器 SHALL 对未编辑的文档部分保持源码逐字节稳定（打开→保存不动 = 内容零变化）。
2. THE 编辑器 SHALL 保真往返：标题、段落、无序/有序/任务列表（含嵌套与懒延续）、引用、代码块（围栏）、行内代码、加粗、斜体、删除线、链接、分割线、表格、`img://` 图片。
3. WHEN 源码包含编辑器文档模型无法表达的语法，THE 编辑器 SHALL 按原样保留该片段（parse 出错或未知块按纯文本/原样块处理），并保证保存时逐字还原。
4. THE 编辑器 SHALL 保持任务列表勾选状态写回 `- [ ]` / `- [x]` 语法。

### R6 工具栏与键盘辅助栏兼容

**User Story:** 作为用户，我想要现有工具栏配置无缝迁移，从而操作习惯零变化。

#### 验收标准

1. THE 编辑器 SHALL 消费 `setToolbarConfig` 的 JSON（enabled ids + customs），呈现与现状一致的工具栏。
2. THE 编辑器 SHALL 支持 Tools.builtIns 全部 id 对应的能力：headings/bold/italic/strike/link/list/ordered-list/check/quote/line/code/inline-code/indent/outdent/undo/redo/image。
3. THE image 工具 SHALL 保持「JS 发 pickImage 事件 → Kotlin 相册 → insertImage 回填 img://」链路。

### R7 主题 / 字号 / 源码模式

#### 验收标准

1. WHEN Kotlin 调用 applyTheme，THE 编辑器 SHALL 应用 CSS 变量（昼夜背景/前景/边框/字号/字体族）。
2. THE 系统 SHALL 保留深色首屏防闪白机制（bootstrap CSS 注入 + prefers-color-scheme 兜底）。
3. WHEN 用户点顶栏眼睛按钮，THE 编辑器 SHALL 在「即时渲染」与「全文源码」两种视图间切换，双向切换零内容丢失。

### R8 性能与交付

#### 验收标准

1. THE 内核 bundle SHALL 压缩后体积 ≤ 400KB（含 schema/list/markdown/table 插件，不含 polyfill）。
2. THE 编辑页 SHALL 在低端机（4GB RAM 设备）上首屏可交互时间与 Vditor 版本相当或更短。
3. THE 工作区构建流程 SHALL 产出可提交的 dist 文件与构建脚本，真机侧（Android Code Studio）零 npm 依赖。

### R9 兼容与回退

#### 验收标准

1. THE 新内核 SHALL 在 Android 8.0（minSdk 26）对应系统 WebView 上可用。
2. THE 仓库 SHALL 保留 Vditor 版编辑器文件一个版本周期（回退手段），新内核默认启用。（并存策略见开放决策 D3 备注）

## 已决事项

- **D1 内核选型**（2026-10-10 确认）：采用 vanilla ProseMirror——轻量可控、无封装层、单文件打包最容易，适配手机 ACS 构建场景。
- **D2 表格范围**（2026-10-10 确认）：首版表格只读渲染 + 源码态编辑；表格编辑器（prosemirror-tables 方案）单独排期。
- **D3 撤销归属**（2026-10-10 确认）：采用 PM history 插件——事务级逐步撤销、自动带选区恢复；Kotlin 快照栈退役，undo/redo 经桥直通 PM 命令。
