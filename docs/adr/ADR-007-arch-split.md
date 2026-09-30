# ADR-007：EditActivity 架构拆分（Sprint 5）

- 状态：已采纳（v1.99-arch，versionCode 121）
- 日期：2026-09-30
- 关联：审查 #17（P1 拆分建议）、#81（Sprint 5）、#82 规则 1

## 背景

`EditActivity.kt` 在 v1.98 时已膨胀到 1421 行，单类同时负责：WebView 生命周期、
IME insets 联动、键盘辅助栏、图片存储/供流/导入、撤销历史栈、保存/删除、
主题与工具栏配置、JS 状态轮询、调试诊断……（审查 #17 列举了 9+ 职责）。
后果：**修缩进要碰 IME、修图片要看历史栈**，回归风险随每次修改累积。

## 决策

按审查 #17 的拆分图，把编辑器职责拆成 6 个协作者，`EditActivity` 收窄为
「壳 + 装配 + 事件路由」：

| 组件 | 职责 | 原代码来源（v1.98 EditActivity） |
| ---- | ---- | ---- |
| `EditorState` | 共享可变状态：content / caret / editing / dirty / ready / suppressExitEdit / noteFontSize… | 各散落字段（currentContent、jsEditing、editorReady 等） |
| `EditorController` | JS 通道门闩 js()、轮询下行校准 pollJsState、load/enterEdit/exitEdit、主题变量、工具栏配置、bootstrap 防闪白、主文档拦截 | js/pollJsState/themeVarMap/toolbarConfigJson/pushToolbarConfig/applyTheme/buildBootstrapThemeCss/toggleRenderMode |
| `EditorImeController` | 键盘检测双通道、悬浮闩锁、垫底 padding、自动回预览、轮询循环、onIme 证据推送 | setupKeyboardBar/updateKeyboardBar/liveImeVisible/imeCacheCorroborated/onImeDispatch/isFloatingIme 及全部 insets 缓存字段 |
| `EditorImageController` | 内嵌图存储/发布快照、mdnotes.local 请求供流、相册选图导入（压缩/哈希去重）、全屏看图 | noteImages/imgBytesCache/publishImages/imageBytes/intercept/importImage/encodeImage/flatten/scaleDown/sha256/onJsViewImage/onJsPickImage |
| `EditorHistoryController` | 撤销/前进双栈、词级合并、回放推回 WebView、菜单点亮（Sprint 4 #82-7 单一历史栈唯一归属） | Snapshot/undoStack/redoStack/commitSnapshot/canCoalesce/undoEdit/redoEdit/applySnapshot/updateHistoryMenu |
| `EditorDiagnostics` | insets 原始帧环形缓冲、详细日志落盘/分享、JS 桥探针读数、调试浮层 | appendInsetLog/shareInsetLog/logRaw/updateJsDiag/updateDebugOverlay 及探针字段 |

`EditActivity` 保留：生命周期、菜单、save/delete、字号对话框、返回键、
`drainJsEvents` 事件路由（路由表本身）与桥回调薄委托
（`onJsContentChanged` → history、`onJsViewImage` → image 等）。

1421 行 → 约 560 行（Activity）+ 6 个职责单一的文件。

## 装配与可见性

- Controller 在 `onCreate` 最前装配：`state` → `diag` → `ime` / `image` / `history` / `editor`；
- 互相只持引用，无循环构造（lateinit 的 `editor` 在任何运行时调用前已赋值）；
- Activity 以 `internal` 暴露 `binding / state / editor / ime / image / history / diag`，
  Controller 经构造注入 `state` 与需要的协作方，不新建全局单例（#82 规则 1）。

## 有意不做

- **未引入接口抽象层**：六个组件只有单一实现，先以具体类拆分；等第二个实现
  （如测试替身）真出现再提接口，避免为拆而拆（#82 规则 15 精神）。
- **未拆 JS 侧**（editor-vditor.js 约 80KB，审查 #18）：JS 拆分涉及加载顺序与
  模块边界重排，回归面大，独立成一个 Sprint 更稳；`editor-list.js`（Sprint 2）
  已是第一个拆出的 JS 模块，方向已验证。
- **保存/删除留在 Activity**：它们是页面级业务（依赖 NoteRepository 与 finish()），
  不是编辑器职责，硬塞进 Controller 反而制造新的耦合。

## 验证

- `:app:testDebugUnitTest` + `:app:assembleDebug` 通过；
- JS 资产零改动 → 既有 37 例 transformer 单测与 headless e2e 结论继续有效；
- 真机回归重点见《真机测试清单-v1.99.md》G 层（架构回归专项）。

## 后果

- 修缩进/光标 → 只碰 `assets/editor/` 与（若 Kotlin 侧需要）`EditorHistoryController`；
- 修键盘/工具栏显隐 → 只碰 `EditorImeController`；
- 修图片 → 只碰 `EditorImageController`；
- 新增诊断 → 只碰 `EditorDiagnostics`。
