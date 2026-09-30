# ADR-005 列表光标：逻辑光标模型替代 li 文字指纹

- 状态：已采纳（v1.97-logicalcursor / Sprint 3）
- 决策日期：2026-09-30
- 关联：审查文档 #6、#83、#82（规则 3 / 4）；Sprint 3；ADR-004

## 背景

v1.92~v1.94 三版光标坐标系均被真机 / headless 打脸：

- **v1.92 `line+inner`**：li 覆盖行数靠猜，混合文档（无序 + 有序懒延续 + 任务）错位 → 减错行。
- **v1.93 全局 `textContent` 偏移**：headless 铁证——outdent/Tab 改变嵌套结构（子项↔同级）时，Lute 重渲染后 `textContent` 字符序列跟着变，「同一数字」在新旧 DOM 指向不同文字（`off=17` 从「观后感开头」漂成「哈哈哈末尾」）→ 光标跳行。
- **v1.94 `{text, idx, off}` 相对坐标**：用 li 文字指纹 + 第几个同名 li 定位。重复文本 / 懒延续折叠场景下精确匹配消失，需多层降级兜底，仍是脆弱猜测。

根因（审查 #83）：编辑器的「数据模型 / DOM / 光标 / 异步操作 / 渲染刷新」之间**没有稳定的单一真相**。具体两条铁证（headless 实测）：

1. Vditor `getSource()` 是 DOM 反推的**规范化**源码，会在有序嵌套等处**插入空行**（`1. a\n2. b` 后跟 `  - c` 被规范成 `1. a\n2. b\n\n- c`）。因此「扁平行号 ↔ DOM 块序」永远对不齐——不能用行号做光标的稳定身份。
2. 列表项文字在重复文本 / 混合文档下不唯一，「文本 + 第几个」做永久身份会偏移（审查 #82 规则 4 明确禁止）。

审查 #6 建议 `BlockPath + TextOffset`；#6.2 进一步建议由编辑器层维护**临时的 session block identity**（不写入 Markdown），专门服务于「DOM↔Markdown 光标恢复 / 结构变化」。#82 规则 3 禁止用全局 `textContent` offset 恢复列表光标，规则 4 禁止用「文本 + 第几个」做永久唯一身份（只能兜底）。

## 决策

逻辑光标 = **`{ blockIndex, offset }`**：

- **`blockIndex`**：先序遍历 `ir.element` 收集的「有效块」序列索引。有效块 = 每个 `li`（无论嵌套层级）一行 + 每个顶层块级（`P / H1-6 / BLOCKQUOTE / PRE`）一行；`ul`/`ol` 容器本身不算块，`li` 内的 `input`/`span` 等内联元素不算块。这是**结构身份**，不依赖任何文字内容，满足规则 4。
- **`offset`**：光标在该块「可见文字」中的字符偏移。IR 渲染后列表 marker（`-` / `1. `）与行首缩进空格不在 `li.textContent` 里，故 `offset` 天然是「用户可见文字」偏移，重渲染后稳定，且非全局 `textContent` 偏移，满足规则 3。

还原用 **`data-ls-id` 临时标签**（审查 #6.2 session block identity，绝不写入 Markdown 文件）：每次 `setValue` 重建 DOM 后按先序有效块序重打标签，再用 `querySelector` 定位落光标，彻底脱离旧版 li 文字指纹的脆弱猜测。

配套删除 `caretLiPos` / `restoreLiPos` / `findSourceLineByLi` / `liOwnText` / `currentLiEl`。`transformList(op)` 流程改为：
`domToLogicalCursor()`（DOM→逻辑光标）→ `blockIndexToSrcLine()`（块序→源码行）→ `ListStructureTransformer.indent/outdent`（纯源码，只吃 `src+行号`，返回 `src+changed`）→ `setValue` 受控重渲染 → 膨胀守卫 → `logicalCursorToDom()`（按 `data-ls-id` 还原）。

`editor-list.js`（`ListStructureTransformer`）保持纯函数、不触碰 DOM；桥接层只用其 `src+changed`，逻辑光标全程由 DOM 块序维护——因为 **indent/outdent 只平移行首空格、不改块数与块内文字，同一 `li` 的 `blockIndex` 与 `offset` 在结构变换前后保持不变**，这正是「结构变化后光标保持语义位置」（Sprint 3 目标）的保证。

## 关键假设与实测（非猜测）

通过 headless Chromium + 真实 Vditor 实测确认：

- 纯无序 / 任务 / 混合 / 深层嵌套列表下，先序有效块序与「源码内容行序（跳过规范化空行）」逐块对齐；IR 渲染后 `li.textContent` 不含 marker。
- 7 个真实 `indentLine/outdentLine` e2e 全绿：覆盖无序、任务、深层嵌套、重复文本（第 2 个「观后感」indent 后光标留在第 2 个、不跳第 1 个）、混合块、outdent；光标 `blockText` 与 `offset` 前后完全一致（光标不跳），嵌套 `depth` 按预期变化。

## 约束与已知边角

- **`getSource` 规范化空行**：已用「先序有效块序」做逻辑光标身份规避（不再用扁平行号），符合规则 4。
- **续写多行（一个 `li` 跨多行源码）**：为已知边角——此时「有效块数 < 非空行数」，`blockIndex→源码行` 映射会偏移。调用方检测到映射失效时**安全降级**（保留 Vditor 当前光标，绝不错位，规则 4 兜底）。审查测试矩阵（中文 / 重复 / 深层 / 任务 / 粘贴 / 输入后立即 Tab）不含该边角。
- **有序列表嵌套缩进**：属待办 #52（方案 A），本 Sprint 未动；有序项 indent 仍为 no-op，与 Vditor 原生行为一致，无回归（见 ADR-004 反向约束）。

## 验证

- `app/src/test/js/list-transform.test.js`：37 例纯函数单测（Sprint 2 既有，本 Sprint 未改 transformer 接口，全部保持）。
- Sprint 3 真实代码 headless e2e：7 例全绿（见上方证据）。
- `:app:testDebugUnitTest` + `:app:assembleDebug` BUILD SUCCESSFUL。

## 遗留

- Sprint 4（编辑器稳定性）：operationId / dirty / revision / undo-redo / 去除固定 delay。
- Sprint 5（架构拆分）：EditActivity → EditorController 等。
