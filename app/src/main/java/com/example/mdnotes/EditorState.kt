package com.example.mdnotes

/**
 * 编辑器共享可变状态（审查 #17 Sprint 5：EditorState）。
 *
 * 单一职责：只存数据，不含任何行为。各 Controller（IME/图片/历史/编辑器）
 * 与 Activity 共持同一实例，读写同一份真相 —— 杜绝「同一状态散落多处副本、
 * 修一处忘三处」的历史包袱（审查 #82 规则 1：状态机必须可见）。
 *
 * 命名对齐审查 #17 的 EditorState：editing / caret / content / dirty。
 */
class EditorState {

    /** 内容真理源镜像：装载前 = 笔记原文；装载后跟随 JS 的 onContentChanged */
    var content: String = ""

    /** 最近一次成功保存的内容；dirty = (content != savedContent)（Sprint 4 #64） */
    var savedContent: String = ""
    val dirty: Boolean get() = content != savedContent

    /** JS 是否处于编辑态（桥回报，驱动辅助栏显隐 / 返回键 / insets 联动） */
    var editing: Boolean = false

    /** JS 上报的最近光标 offset（undo 恢复定位用） */
    var caret: Int = 0

    /** WebView 页面就绪（onPageFinished），evaluateJavascript 的门闩 */
    var ready: Boolean = false

    /** 抑制"键盘收起→退预览"：对话框、外跳浏览器、全屏看图、选图期间置位 */
    var suppressExitEdit: Boolean = false

    /** 最近一次进入编辑态的时刻（elapsedRealtime），宽限期用 */
    var editingSince: Long = 0L

    /** 新建笔记：页面就绪后直接进入编辑态并唤起键盘 */
    var pendingAutoEdit: Boolean = false

    /** 本便签独立字号（sp）；null = 跟随设置里的全局字号 */
    var noteFontSize: Int? = null
}
