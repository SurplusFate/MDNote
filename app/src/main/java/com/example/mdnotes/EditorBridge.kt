package com.example.mdnotes

import android.content.Context
import android.webkit.JavascriptInterface
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * WebView 编辑器与 Kotlin 的双向桥（JS 侧对象名：window.Android）。
 *
 * 注意：@JavascriptInterface 的回调跑在 WebView 的 JavaBridge 线程，
 * 一律 post 回主线程、且确认 Activity 未 finish 再动它——
 * 回调可能晚于 onDestroy 到达（比如退出页面瞬间 JS 还在防抖上报）。
 */
class EditorBridge(activity: EditActivity) {

    companion object {
        /** 调试：上行方法调用总计数（调试浮层显示，判断 JS→Kotlin 通道是否断裂） */
        @Volatile
        var upCalls = 0
    }

    private val ref = WeakReference(activity)

    private fun post(run: (EditActivity) -> Unit) {
        upCalls++
        val a = ref.get() ?: return
        ContextCompat.getMainExecutor(a).execute {
            if (!a.isFinishing && !a.isDestroyed) run(a)
        }
    }

    /** JS 防抖上报全文（编辑中的块实时拼接好了）+ 最近光标 offset */
    @JavascriptInterface
    fun onContentChanged(text: String, caret: Int) = post { it.onJsContentChanged(text, caret) }

    /** 进入/退出编辑态（点击块 / 键盘联动 / exitEditMode） */
    @JavascriptInterface
    fun onEditModeChanged(editing: Boolean) = post { it.onJsEditModeChanged(editing) }

    /** 预览里点代码块复制按钮 */
    @JavascriptInterface
    fun copyCode(code: String) = post { it.onJsCopyCode(code) }

    /** 预览里点链接 → 系统浏览器打开 */
    @JavascriptInterface
    fun openUrl(url: String) = post { it.onJsOpenUrl(url) }

    /** 预览里点图片 → 全屏查看 */
    @JavascriptInterface
    fun viewImage(key: String) = post { it.onJsViewImage(key) }

    /** JS 侧提示（错误信息兜底） */
    @JavascriptInterface
    fun toast(msg: String) = post { it.toast(msg) }
}
