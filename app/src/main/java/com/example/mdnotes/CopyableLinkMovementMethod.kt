package com.example.mdnotes

import android.text.Layout
import android.text.Spannable
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.MotionEvent
import android.widget.TextView

/**
 * 预览专用 MovementMethod：链接、代码块仍然可以点，但其余触摸事件一律交还给 TextView，
 * 配合 textIsSelectable="true" 就能长按选中普通文字并复制。
 *
 * 系统自带的 LinkMovementMethod 会在 ACTION_DOWN 就返回 true 把事件吃掉，
 * 导致 TextView 永远进不了选择模式 —— 这就是"预览里普通文字没法复制"的根因。
 */
class CopyableLinkMovementMethod : LinkMovementMethod() {

    override fun onTouchEvent(widget: TextView, buffer: Spannable, event: MotionEvent): Boolean {
        // 按下时先让 TextView 拿到焦点，否则第一次长按只会聚焦、选不中文字
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            if (!widget.isFocused) widget.requestFocus()
            return false
        }
        // 只在抬手时判断是否点在可点击 span 上，其余事件不消费
        if (event.actionMasked != MotionEvent.ACTION_UP || buffer.length == 0) return false

        val layout: Layout = widget.layout ?: return false

        var x = event.x.toInt()
        var y = event.y.toInt()
        x -= widget.totalPaddingLeft
        y -= widget.totalPaddingTop
        x += widget.scrollX
        y += widget.scrollY

        val line = layout.getLineForVertical(y)
        if (line < 0 || line >= layout.lineCount) return false
        val off = layout.getOffsetForHorizontal(line, x.toFloat())
        if (off < 0 || off >= buffer.length) return false

        val links = buffer.getSpans(off, off, ClickableSpan::class.java)
        if (links.isEmpty()) return false

        links[0].onClick(widget)
        return true
    }
}
