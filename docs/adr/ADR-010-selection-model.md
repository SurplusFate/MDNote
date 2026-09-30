# ADR-010 点击光标归位：参考 ProseMirror/Lexical 的 Selection 模型重构

- 日期：2026-09-30
- 状态：已采纳（v1.102-selectionmodel）
- 关联：ADR-009（v1.101 光标补丁）、#52、Sprint 3 逻辑光标（ADR-005）

## 背景（为什么不再打补丁）

v1.101 的 `installIRLiCaretFix` 根治了「含子列表的 `<li>` 末尾点击归块首」的 Chromium contenteditable 怪癖，
但实现有三处补丁味（用户明确点出）：

1. **第二套光标机制**：独立 `click` 处理器自己算 `offset` 并 `setStart`，与 Sprint 3 的逻辑光标
   `{blockIndex, offset}` 并存，光标逻辑有了两处来源。
2. **`round(frac * len)` 近似**：用「点击 clientX 在文字包围盒的横向比例」反推字符偏移，比例字体（英文/数字）失真。
3. **`setTimeout(0)` 时序 hack**：依赖「晚于 Vditor 的 click 处理」才不被覆盖，无契约保证。

用户要求「别人都有方案了，直接参考」——业界（ProseMirror / Lexical / Slate）的共识是
**Selection 模型为真（Model-First）+ 自建命中测试（hit-test）**，DOM 只是视图，光标/选区表达为
`{nodeKey, offset}` 而非 DOM 坐标，点击落位由编辑器自己算，不依赖浏览器 `caretRangeFromPoint`
（它在嵌套块边界会撒谎）。W3C 亦于 2025-02 将 ContentEditable 草稿规范定为 Discontinued，推荐 EditContext。

## 决策

在 **Vditor IR（contenteditable）框架内**，把点击光标系统重构为对标 ProseMirror 的 Selection 模型，
**保留 Markdown 存储与 Lute 解析（不换内核）**：

1. **自建逐字符命中测试** `hitOffsetInLi`：逐 text node 测矩形，命中行内按 x 比例映射——
   比例字体也准、支持多行；**跳过 Vditor 注入的 `contenteditable="false"` marker 与任务 `checkbox`**，
   只算「用户可编辑的内容文字」，与 `logicalCursorToDom` 的 `innerOffsetOf` 语义对齐。
   替代原 `caretRangeFromPoint`（撒谎）与 `round(frac*len)`（近似）。
2. **并入 Sprint 3 逻辑光标框架**：命中结果转成逻辑块坐标 `{blockIndex, offset}`，
   **复用 `logicalCursorToDom` 落位**（与缩进/减缩进同一套光标权威），消除第二套光标机制。
3. **测量/落位分离，去 `setTimeout`**：`mousedown` 捕获阶段测精确 offset（此时 `li` 仍是未聚焦的
   干净渲染，无 marker / 编辑态样式，rect 即用户所见）；`click` 阶段用记录的 offset 同步落位。
   彻底消除「测量态（未聚焦）」与「命中态（聚焦）」两套 DOM 不一致导致的误差，也去掉时序 hack。

窄场景不变：仅接管「含子列表的 `<li>`」；框选（非 collapsed）/段落/引用/叶子项零回归（mousedown 不
`preventDefault`，框选原生正常；click 守卫 `!sel.isCollapsed` 放行）。

## 验证证据（headless，playwright + /usr/bin/chromium，真实 Vditor/Lute）

- **首次点击（clean state）**：四步（第一步~第四步）开头/中间/末尾点击 → offset 精确 `0/2/3`，首尾对称，
  根除「前三步开头、第四步末尾」现象。
- **二次点击（已聚焦带 marker 的 `li`）**：连续两次点第三步末尾 → `3/3` 幂等（marker 注入态也稳）。
- **缩进/减缩进 e2e 回归**：10 场景全绿（`logicalCursorToDom` 链路未受重构影响）。
- **真实拖拽框选**：第三步从左拖到右 → `isCollapsed=false`，不被接管代码改写。
- 全程无 pageerror。

## 代价与边界

- 仍运行在 Vditor/contenteditable 底座上：contenteditable 的其它怪癖（跨浏览器 IME、粘贴、协作）不在本 ADR 范围。
- 若未来要彻底脱离 contenteditable，应评估 EditContext（Chrome 121 原生，Firefox/Safari 仍不全支持）
  或换 ProseMirror/Tiptap/Lexical 内核（将改变存储/渲染层，需单独排期，见技术栈演进评估）。
- 本 ADR 是「在现有内核内，把光标/选区统一到模型为真」的收口，而非换内核。
