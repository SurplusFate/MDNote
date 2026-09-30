# ADR-006：编辑器稳定性（Sprint 4，v1.98-stability）

## 状态
已采纳，随 v1.98 落地。

## 背景
审查 #81 把 Sprint 4 定为「编辑器稳定性」，目标是 **快速连续操作不会互相覆盖**，含五项：
`operationId / dirty / revision / undo-redo / remove fixed delays`。
审查 #82 的硬性规则（#2 固定 delay 仅作缓冲须配状态校验、#7 任何 setValue 操作须验证
Undo/Redo、#12 异步任务带 operationId/revision）、#64（明确 dirty 状态）、#65（保存防旧
异步覆盖）为本 ADR 的约束来源。

落地前用 headless Chromium 实测得到两个关键证据：
- **证据 A**：连续同步 3 次 `indentLine`（无 delay）结果 `- a / - b /   - c / - d / - e`
  完全正确——Vditor 的 `setValue` 是同步重渲染，当前同步路径下连续操作**不互相覆盖**。
  故 operationId 守卫是防御层（防未来异步化），非当前救命稻草。
- **证据 B**：结构变换（`vd.setValue()`）后点 Vditor 原生 undo 按钮（`clickBar('undo')`）
  内容**不还原**。探查 Vditor 的 `undo` 对象原型只有 `addToUndoStack`/`recordFirstPosition`，
  且 `recordFirstPosition` 在 IR 模式下读 `currentMode` 抛错——逆向调用内部 API 不稳定。
  而项目**已有第二套** Kotlin 历史栈（`commitSnapshot` 经内容回传记录所有变化、含结构变换，
  顶栏 `action_undo` 走此栈可对结构变换撤销）。两套 undo 并存即 #82-7 所指混乱。

## 决策

### 1. operationId 守卫（审查 #82-12 / #3）
- `editor-vditor.js` 新增全局 `var opSeq = 0`。
- `transformList` 入口 `var myOp = ++opSeq`；`setValue` 之后、光标还原之前校验
  `if (myOp !== opSeq) { indentDiag='STALE'; return; }`——若有更新的操作已介入，
  旧的光标还原**直接放弃，绝不覆盖新状态**。
- `scheduleImgRewrite` 的异步 `setTimeout` 同样带 `myOp` 校验（给未来连续图片插入防旧覆盖）。

### 2. 去无状态固定 delay（审查 #82-2）
- 删除 `setTimeout(rewriteImgRefs, 80)` 纯 delay 兜底。图片改写改由**已常驻的**
  `setupImgObserver`（MutationObserver 监听 childList 合并触发）覆盖，首帧保留一次
  `setTimeout(rewriteImgRefs, 0)` 并加 opSeq 校验。验证：去 delay 后 `img://` 仍被改写为
  `https://mdnotes.local/img/`（headless 实证），图片点亮不受影响。

### 3. dirty / savedContent 模型（审查 #64）
- `EditActivity.kt` 新增 `private var savedContent: String = ""` 与
  `private val dirty get() = currentContent != savedContent`。
- 打开已有笔记时 `savedContent = it.content`（初始不脏）；`save()` 成功后 `savedContent = content`。
- `onPause` 落盘判断由无条件 `save()` 收紧为 `if (!deleted && dirty) save()`，统一
  返回/后台/重建的「是否需要保存」判断。

### 4. undo / redo 统一到 Kotlin 栈（审查 #82-7）
- `buildToolbar()` 剔除 `undo`/`redo`（仿 `indent`/`outdent` 剔除原生内置）。
- 新增 `renderHistoryTools()`：往工具栏末尾追加自定义「撤销/前进」按钮，点击
  `pushEvent('undo')` / `pushEvent('redo')`（走既有 JS→Kotlin 队列，与图片同通道）。
- `window.editor.undo/redo` 由 `clickBar('undo'/'redo')`（Vditor 原生、对结构变换无效）
  改为 `pushEvent('undo'/'redo')`。
- `EditActivity.drainJsEvents` 新增 `"undo" -> undoEdit()` / `"redo" -> redoEdit()`，
  复用顶栏 `action_undo` 同一个已验证的 Kotlin 历史栈。
- 结果：格式栏与顶栏撤销按钮指向**同一栈**，结构变换（indent/outdent/task）与
  普通输入都能逐步撤销，消除两套 undo 并存的混乱。

### 5. revision / 防旧异步覆盖（审查 #65 / #82-12）
- 当前 `save()` 为**主线程同步**（`NoteRepository.upsert` 非异步），不存在「旧异步回调覆盖
  新内容」的并发场景，故本轮**不强行加** `contentRevision` 字段（避免为不存在的场景堆补丁，
  违反 #82-15）。
- 已就位的基础：`dirty` 模型（#3）+ `opSeq` 守卫（#1）已可作为未来异步化的版本/操作校验基底。
  一旦保存改为异步，直接复用 `opSeq`/`dirty` 即可加 `contentRevision`，无需另起炉灶。

## 影响与风险
- undo 统一后，格式栏撤销从 Vditor 字符级（原生）变为 Kotlin 整篇 `loadMarkdown` 重载，
  光标会随历史回放定位——与顶栏 `action_undo` **既有行为一致**，非新回归。
- `opSeq` 守卫在同步路径下恒通过（证据 A），仅作防御契约；若未来 `transformList` 改异步，
  该守卫立即生效防覆盖。
- `clickBar` 工具函数因 undo/redo 改道已无调用方，保留未删（低风险，后续清理）。

## 验证
- 37 例 `ListStructureTransformer` 单测全绿（接口未变）。
- headless e2e（真实 Vditor）：
  - (a) 连续快速 indent x3 → 内容完整、无覆盖；
  - (b) 去 80ms 后图片仍点亮（observer 改写）；
  - (c) 自定义 undo 按钮存在、原生按钮已剔除、点击走队列无 pageerror。
- `testDebugUnitTest` + `assembleDebug` 构建通过。
