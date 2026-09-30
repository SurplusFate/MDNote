# ADR-008 有序列表缩进：自动重排编号（待办 #52）

- 状态：已采纳（v1.100-orderedrenum / 待办 #52）
- 决策日期：2026-09-30
- 关联：待办 #52；ADR-004（列表缩进）；Sprint 2 的 `ListStructureTransformer`

## 背景

Sprint 2（ADR-004）曾依据一次**不完整的 headless 实测**，写入「Lute 的 IR 解析
不支持有序列表嵌套，故对有序项 indent 为 no-op」这一反向约束。后续专项调查
（用户要求「先不动代码查根因」）推翻了该结论：

- **Lute 实际支持有序列表嵌套**；
- CommonMark 规定「**子有序列表起始编号必须为 `1.`**」，写 `2.`/`3.` 会被当父项
  的懒惰续写文本摊平——这才是此前「不嵌套」的真正原因，而非引擎不支持；
- 原生 Vditor Tab 只加空格不加编号；Obsidian 的做法是**缩进时实时重排编号**
  （顶层全局连续、每嵌套层从 1 重排、同级连续）。

用户明确需要该能力（对照 Obsidian 截图），故实施待办 #52，并借机修正 ADR-004 的错误结论。

## 决策

在纯函数模块 `editor-list.js` 中新增 `renumberOrderedLines(lines)`：

- 只改写有序项的「数字」，绝不改动缩进、无序项、任务状态或可见文字；
- 按**缩进层级**重排编号：
  - 顶层有序列表从 1 全局连续（1, 2, 3…）；
  - 每个嵌套层（缩进比父更深）从 1 重新计数，不继承父编号；
  - 同一父下的兄弟项 1, 2, 3… 连续；
  - 无序列表项不编号，且**打断**有序层级上下文（其后的有序项重新从 1 计数，
    层级由缩进决定）；无序项自身参与祖先链，使「无序父 + 有序子」能正确算层级；
  - 非列表行重置全部层级；空行保留层级上下文（续写 / 子项间空行）。
- 层级判定用「祖先链栈 + 同级父键」：弹出缩进 ≥ 当前项的祖先，父须严格更浅；
  同级（同父键）计数累加，换父则重置为 1。

`indent` / `outdent` 在平移（带整棵子树）之后统一调用 `renumberOrderedLines`：

- `indent` 不再对有序项 no-op——把该项挂到上一级，嵌套层编号从 1 重排，
  原层后续兄弟接回父层连续序号；
- `outdent` 减缩进后重排，使弹回的项接回父层 / 顶层序号，同级保持连续。

`renumberOrderedLines` 同步导出（Node 单测可直接验证，零 WebView）。

## 为什么不改 Vditor 桥接层

`editor-vditor.js` 的 `transformList` 用「逻辑光标」模型
`{blockIndex, offset}`（块内**可见文字**偏移）还原光标。`renumberOrderedLines`
只改行首 bullet 数字、不动块内文字与块序，因此：

- 逻辑光标 `{blockIndex, offset}` 完全不变，光标还原安全（无跳行）；
- 行数 / 行序不变，`blockIndexToSrcLine` 映射稳定；
- 膨胀守卫（行数突增即回滚）依旧生效。

JS 资产无需为 #52 做任何改动，回归面仅限 `editor-list.js` 纯函数 + 单测矩阵。

## 验证

- **纯单元测试**（`app/src/test/js/list-transform.test.js`，`node` 直跑）：
  54 例全绿。覆盖普通 / 有序 / 任务 / 混合 / 深层嵌套 / 重复文本 / 空项 / 格式变体
  × indent / outdent / 连续操作 / 光标进位，并新增：
  - #52 专项：indent 子层从 1 重排、下钻后续兄弟接回父层、outdent 接回父层序号、
    多级下钻→回弹编号始终连续；
  - `renumberOrderedLines` 直接测试：跨位数（9→1）、无序打断、子层乱序重写、混合父子。
- **headless 端到端**（playwright + `/usr/bin/chromium` 加载真实 Vditor/Lute，
  `/tmp/e2e_52.js`）：
  - `1. a\n2. b` indent b → 源码 `1. a\n   1. b`，渲染 `a`(depth0)/`b`(depth1)，光标停 b 不跳；
  - `1. a\n2. b\n3. c` indent b → `1. a\n   1. b\n2. c`，渲染 `a`(0)/`b`(1)/`c`(0)
    （子层从 1、c 接回顶层连续）；
  - outdent `1. a\n   1. b\n   2. c` 的 b → `1. a\n2. b\n   1. c`，b 弹回顶层、c 仍嵌套 b 下。
  全部 `changed:true`、无 pageerror，符合 Obsidian 编号规律。

## 后果

- 正向：有序列表多级缩进可用，且编号自动重排，对齐 Obsidian 习惯；纯函数可单测，
  逻辑光标模型天然免疫编号改动导致的光标漂移；JS 资产零改动。
- 负向 / 边界：
  - 编号重排是「源码层」的主动维护（Obsidian 同款策略），会改写用户刻意写的非连续
    有序编号（如 `1.` `3.` 跳号）——符合 Obsidian 行为，非 bug；
  - 已嵌套项再 indent 仍 no-op（与无序同规则，见 `subtreeEnd` 约束），不强制更深嵌套；
  - 一个列表项文字跨多行源码时，逻辑光标安全降级（规则 4 兜底，见 ADR-005）。
