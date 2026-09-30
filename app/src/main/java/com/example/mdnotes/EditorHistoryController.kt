package com.example.mdnotes

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * 撤回 / 前进历史（审查 #17 Sprint 5：EditorHistoryController）。
 *
 * 单一职责：维护「栈顶=当前状态」的撤销/前进双栈，词级合并连续打字，
 * 回放时把全文 + 光标推回 WebView。所有会触发内容变化的上游（打字、
 * 结构变换、粘贴）统一经 [onContentChanged] / [commitSnapshot] 落栈 ——
 * Sprint 4 #82-7 的单一历史栈就在这里，别处不得自建栈。
 */
class EditorHistoryController(
    private val a: EditActivity,
    private val state: EditorState
) {

    companion object {
        /** 撤回/前进历史栈的最大深度 */
        private const val MAX_HISTORY = 100
    }

    /** 一步可回退的状态：正文 + 光标位置 */
    private class Snapshot(val text: String, val selStart: Int, val selEnd: Int)

    /** 栈顶永远是「当前状态」，它的前一个才是「上一步」；redoStack 存被撤回掉的状态 */
    private val undoStack = ArrayDeque<Snapshot>()
    private val redoStack = ArrayDeque<Snapshot>()

    /** 回放历史时也会触发桥上报，用它挡住、别把自己的回放记成新编辑 */
    private var applyingHistory = false

    private val historyHandler = Handler(Looper.getMainLooper())

    /** JS 上报全文 + 光标：更新镜像内容，并立即记一步撤销快照（词级合并在 commitSnapshot 内） */
    fun onContentChanged(text: String, caret: Int) {
        state.content = text
        state.caret = caret
        // 每次改动都记，靠 commitSnapshot 里的「同词合并」把连续打字压成词级粒度，
        // 避免整段输入被压成一个撤销点、一撤到底。回放历史时 JS 的回传不记。
        if (!applyingHistory) commitSnapshot()
    }

    /** 挂上历史基线（打开时的内容记成第一个状态） */
    fun setupHistory() {
        undoStack.clear()
        redoStack.clear()
        undoStack.addLast(currentSnapshot())
        updateHistoryMenu()
    }

    private fun currentSnapshot(): Snapshot {
        val caret = state.caret.coerceIn(0, state.content.length)
        return Snapshot(state.content, caret, caret)
    }

    /**
     * 把当前状态记进历史栈。正文没变就跳过；同一词内连续打字/退格合并成同一个
     * 撤销点（原地更新栈顶），遇到空格/换行/粘贴等结构性改动则另起一步，这样整段
     * 输入不会被压成一个点、一撤到底。栈底基线永远保留、不会被覆盖。
     */
    fun commitSnapshot() {
        val snap = currentSnapshot()
        val last = undoStack.lastOrNull() ?: run {
            undoStack.addLast(snap); afterCommit(); return
        }
        if (last.text == snap.text) return
        if (canCoalesce(last.text, snap.text) && undoStack.size >= 2) {
            undoStack[undoStack.lastIndex] = snap   // 同词续打/退格：原地更新栈顶
        } else {
            undoStack.addLast(snap)                 // 新词/粘贴/删除块：新的一步
        }
        while (undoStack.size > MAX_HISTORY) undoStack.removeFirst()
        redoStack.clear()   // 有新编辑发生，「前进」就此作废
        afterCommit()
    }

    /** 同词判定：在词尾单次增/删一个非空白字符（连续打字或退格） */
    private fun canCoalesce(prev: String, cur: String): Boolean {
        val d = cur.length - prev.length
        return when {
            d == 1 -> cur.startsWith(prev) && !cur.last().isWhitespace()
            d == -1 -> prev.startsWith(cur) && !prev.last().isWhitespace()
            else -> false
        }
    }

    private fun afterCommit() = updateHistoryMenu()

    /** 撤回：退回上一步 */
    fun undoEdit() {
        commitSnapshot()   // 先把还在缓冲区里的输入补上，否则刚打的字撤不回来
        if (undoStack.size < 2) return
        redoStack.addLast(undoStack.removeLast())
        applySnapshot(undoStack.last())
    }

    /** 前进：回到被撤回的那一步 */
    fun redoEdit() {
        commitSnapshot()
        if (redoStack.isEmpty()) return
        undoStack.addLast(redoStack.removeLast())
        applySnapshot(undoStack.last())
    }

    /**
     * 把历史状态推给 WebView：全文重载 + 光标定位到变化处并保持编辑态。
     * applyingHistory 延时复位：loadMarkdown 里 JS 会立即回传一次内容，
     * 桥回调异步 post 主线程，要确保到达时闸门仍然关着（500ms > 400ms 防抖）。
     */
    private fun applySnapshot(snap: Snapshot) {
        applyingHistory = true
        state.content = snap.text
        a.editor.js(
            "editor.loadMarkdown(${JSONObject.quote(snap.text)}, ${snap.selStart}, true)"
        )
        historyHandler.postDelayed({ applyingHistory = false }, 500)
        updateHistoryMenu()
    }

    /** 有得撤/有得进时才把按钮点亮（预览态同样可用，和 Typora 一致） */
    fun updateHistoryMenu() {
        a.binding.toolbar.menu.findItem(R.id.action_undo)?.isEnabled = undoStack.size >= 2
        a.binding.toolbar.menu.findItem(R.id.action_redo)?.isEnabled = redoStack.isNotEmpty()
    }
}
