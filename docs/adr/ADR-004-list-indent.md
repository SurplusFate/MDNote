# ADR-004 列表缩进/减缩进：纯源码变换替代 Vditor 原生 Tab

- 状态：已采纳（v1.96-liststruct / Sprint 2）
- 决策日期：2026-09-29
- 关联：审查文档 #7、#10、#56、#82（规则 14/5）；Sprint 2

## 背景

v1.94 及之前，列表加缩进依赖 **Vditor 原生 Tab**（由 Kotlin 经 WebView
`dispatchKeyEvent` 派发「可信」Tab 键），减缩进依赖**源码级 `outdentSubtree`**。
两条路径不一致，且原生 Tab 路径存在：

- 必须靠 Kotlin 派发可信按键 + 60/140ms 轮询 `armTabRefresh` 布防（时序脆弱，
  快速连点易串扰）；
- 嵌套任务列表 checkbox 偶发渲染成字面 `[ ]`，需 `setValue` 全量重渲染兜底；
- 缩进/减缩进的「结构真相」分散在 DOM 行为与源码改写两处，难以单测。

审查 #7 明确要求：indent / outdent 统一进同一个 `ListStructureTransformer`，
不再让「DOM 猜测」成为列表操作的主路径。

## 决策

新增纯函数模块 `editor-list.js`（`ListStructureTransformer`），对 Markdown **源码行**
做加/减缩进与任务勾选切换，**不触碰 DOM / Vditor / 窗口**；暴露
`window.ListTransformer`（浏览器）与 `module.exports`（Node）。

`editor-vditor.js` 的 `indentLine` / `outdentLine` 的 LI 分支统一改为调用
`transformList(op)`：`记 li 相对坐标 → 定位源码行 → transformer 计算新源码 →
setValue 受控重渲染 → 膨胀守卫 → 按 li 相对坐标还原光标`。

Kotlin 侧 `EditActivity` 的 `onJsIndentTab` / `onJsOutdentTab` / `requestTab` /
`dispatchTabToEditor` / `drainTabQueue` / `TAB_GAP_MS` 等「可信按键派发」链路整体移除
（不再有 JS 推送 `indentTab` 事件）。

## 缩进规则（以 Lute/headless 实测为准，非猜测）

通过 headless Chromium + Vditor/Lute 实测得到嵌套规则：

- 无序父下无序子项：缩进 unit = 2（`- ` 宽度）。
- 有序父下无序子项：缩进 unit = 3（`1. ` 宽度）。
- **（已推翻）原结论「Lute 不支持有序嵌套、故有序 indent 为 no-op」经专项调查证伪**：
  实测 Lute 支持有序嵌套，CommonMark 仅要求子有序起始为 `1.`（`2.`/`3.` 被当懒惰续写
  文本摊平）。该限制已在待办 #52 / **ADR-008** 解除——indent 有序项会重排编号并正确嵌套。
  本 ADR 原「反向约束」作废，详见 ADR-008。
- indent 只能把「与上一列表项同缩进的兄弟项」挂到上一项下；已嵌套项（上一项目更浅）
  再 indent 无意义 → no-op。
- outdent 按「缩进比当前项更浅的最近列表项」的类型取 cut（有序 3 / 无序 2），
  带整棵子树一起平移，避免旧 `outdentSubtree` 按当前行类型取 cut 在混合列表下错位。

## 验证

- **纯单元测试**（零 WebView）：`app/src/test/js/list-transform.test.js`，`node` 直接运行，
  覆盖审查 #13 矩阵（普通/有序/任务/混合/深层嵌套/重复文本/空项/格式变体）×
  indent/outdent/连续操作/光标进位，共 37 例全绿。
- **headless 端到端**：在真实 Vditor 中直接调用 `editor.indentLine()` /
  `editor.outdentLine()`，10 个矩阵场景源码正确且**光标留在正确 li（含重复文本场景
  停在嵌套后的第二项，depth 1，不跳到第一项）**，无跳行。

## 后果

- 正向：列表结构操作确定性、可单测、不依赖 DOM 猜测与可信按键时序；编辑器 JS 体积与
  状态变量下降（移除 `armTabRefresh` / `taskRenderBroken` / `outdentSubtree`）。
- 负向 / 待办：
  - 有序列表嵌套受 Lute 限制仍不可用（与本模块无关，属引擎能力）。
  - 光标仍用 v1.94 的 li 相对坐标（`caretLiPos` / `restoreLiPos`）做还原，Sprint 3 将升级为
    逻辑光标模型（BlockPath + TextOffset），并让 transformer 返回的逻辑光标直接驱动 DOM。
  - Sprint 4 将引入 operationId / 去固定延迟，进一步消除连续操作串扰。
