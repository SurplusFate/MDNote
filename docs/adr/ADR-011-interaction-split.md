# ADR-011 编辑交互职责重划分（v1.103-interaction）

- 状态：Accepted
- 日期：2026-09-30
- 关联：待办 #52 已收口；v1.101/v1.102 光标修复复盘；用户《MDNote v1.103 手机编辑交互与光标系统重构方案》

## 1. 背景与问题

v1.101/v1.102 虽修复了"嵌套列表父项末尾点击归块首"，但仍是**反人类设计**，根因不在算法，而在架构：

> 同一编辑器里存在两套光标定位机制——① 浏览器/WebView 原生 Selection；② MDNote 自己计算的 Selection。
> 且 MDNote 只接管"嵌套列表父项"这一窄场景，造成**行为分裂（双标）**：点某些行走我的逻辑，点其他行走浏览器逻辑。

v1.102 还保留了 `mousedown → preventDefault → 自己算 offset → Range.setStart()` 的机制，依赖"未聚焦态几何"，与 Vditor 聚焦后注入 marker 的"已聚焦态"不一致，脆弱。

用户明确方向（方案第 1/4/9/10/42/43 节）：

> 正常编辑交给 Android/WebView（原生 Selection）；MDNote 只负责 Markdown 结构变化后的状态恢复；
> DOM 重建时才进行 Selection 恢复。

## 2. 决策

**职责重划分（单一原则）**：

| 职责 | 负责方 |
|---|---|
| 普通点击 / 输入 / 左右上下移动 / 长按 / 拖动选择 / Shift 选择 / 中文输入法 / 复制粘贴 | **WebView / Chromium 原生 Selection**（MDNote 不干预） |
| Markdown 结构变化（Tab / Shift+Tab / Enter / Backspace / 粘贴 / 撤销重做）后的光标恢复 | **MDNote LogicalCursor**（结构重建后恢复，非主光标系统） |

**LogicalCursor 降级**：`domToLogicalCursor()` / `logicalCursorToDom()` 不再是"主光标系统"，明确为**「DOM 重建后的光标恢复机制」**。仅 `transformList`（缩进/减缩进）在 setValue 结构变化后调用。

**`hitOffsetInLi()` 降级为 Fallback**（不删、不主路径）：
- 仅针对**嵌套列表父 LI 末尾点击被 Chromium 归到块首**这一已实锤的明确 Bug；
- 触发条件极窄：`li.querySelector('ol, ul')` 且 `原生落位 offset===0 && 用户意图 want>=1`；
- 其余一切（段落/标题/引用/普通 li/有序/无序/任务/checkbox/框选）**零接管**，交回原生。

## 3. 约束（方案第 32/49 节，本次落实）

- 禁止 `mousedown` 接管普通点击；禁止 `preventDefault` 自定义命中。
- 禁止 `setTimeout` 解决 Selection（本修复无 setTimeout）。
- 禁止每次点击都计算 logical cursor（Fallback 仅在嵌套父项 click 时读一次原生 offset）。
- 禁止普通点击 `setValue()`（普通点击零接管，不触发任何 DOM 重建）。
- 禁止"为每种特殊情况加 if"：Fallback 只有一处 `!li.querySelector('ol,ul')` 窄场景。

## 4. 实现

`editor-vditor.js` 的 `installIRLiCaretFix` 重写：

- 移除 `mousedown` + `pendingHit` 测量阶段；
- 仅保留 `click` 监听（不 preventDefault、不 setTimeout）；
- 监听体：`INPUT`（checkbox）即 return → `!isCollapsed` 即 return（框选不接管）→ 非 `li`/非嵌套父项即 return → 读 `domToLogicalCursor()`（只读原生落位）→ 仅当 `原生 offset===0 && want>=1` 调 `logicalCursorToDom` 纠正。

JS 桥接层与 Kotlin 侧**零改动**；`transformList` / LogicalCursor 链路原样保留（结构恢复职责未变）。

## 5. 验证

headless（playwright + `/usr/bin/chromium`，真实 Vditor/Lute）：

- **普通段落零接管**：开头 / 中间点击 offset = 0 / 4（8 字段落，原生精准），代码不干预；
- **嵌套父项 step1-3**：开头 / 中 / 末 = 0 / 2 / 2-3（开头中走原生，末尾原生落末字、Fallback 不误触发）；
- **缩进/减缩进 e2e 回归**：10 场景全绿（LogicalCursor 结构恢复链路零回归）；
- 无 pageerror。

**明确限制**：Android 真机的 IME 输入、长按选择手柄、拖拽选择、Emoji/中英文混排等交互方案第 11-23 节强制要求真机验证，headless 仅能验证逻辑职责划分，需用户真机确认。

## 6. 后续（方案第 44-53 节，非本版）

- Phase 2：统一 Enter / Backspace / 自动列表 / Tab / Shift+Tab 的 Selection Mapping；
- Phase 3：粘贴 / Undo / Redo / IME 协同；
- Phase 4：`blockKey` 替代 `blockIndex`、复杂结构映射、性能；
- 数据层整改（方案第 46-48 节）：原子保存、WebDAV ETag 弱同步、pendingCommands 队列——建议 v1.104 处理。
