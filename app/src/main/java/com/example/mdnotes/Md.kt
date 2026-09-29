package com.example.mdnotes

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ClickableSpan
import android.text.style.ImageSpan
import android.util.Base64
import android.util.LruCache
import android.view.View
import android.widget.TextView
import android.widget.Toast
import io.noties.markwon.Markwon
import io.noties.markwon.core.spans.CodeBlockSpan
import io.noties.markwon.movement.MovementMethodPlugin
import io.noties.markwon.editor.MarkwonEditor
import io.noties.markwon.editor.MarkwonEditorTextWatcher
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tasklist.TaskListPlugin
import io.noties.markwon.ext.tasklist.TaskListSpan

/**
 * Markdown 渲染统一入口（基于 Markwon）。
 * - setMarkdown(): 把 Markdown 渲染成富文本给预览用，并让代码块点击即复制
 * - watcher(): 挂在 EditText 上，边打字边高亮 #、**、> 这些符号
 */
object Md {
    private var markwon: Markwon? = null
    private var editor: MarkwonEditor? = null

    /**
     * 内嵌图片的占位符（U+FFFC，专门用来占位「被替换掉的对象」的字符）。
     * 思路：先把 `![说明](img://key)` 整段换成这个字符再交给 Markwon 排版，
     * 渲染完在结果里把占位符逐个替换成 ImageSpan。这样 Markwon 完全不用管
     * 图片从哪来，我们也不用给它塞自定义 SchemeHandler。
     */
    private const val IMG_PLACEHOLDER = '\uFFFC'

    /** 解码后的图按「图片 key + 目标宽度」缓存，翻来覆去看同一篇笔记不用反复解码 */
    private val imageCache = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    private fun build(ctx: Context): Markwon = Markwon.builder(ctx.applicationContext)
        .usePlugin(MovementMethodPlugin.create())   // 链接可点
        .usePlugin(TablePlugin.create(ctx))         // | 表格 |
        .usePlugin(TaskListPlugin.create(ctx))      // - [ ] 待办
        .usePlugin(StrikethroughPlugin.create())    // ~~删除线~~
        .build()

    fun render(ctx: Context): Markwon {
        return markwon ?: build(ctx).also { markwon = it }
    }

    fun editor(ctx: Context): MarkwonEditor {
        return editor ?: MarkwonEditor.create(render(ctx)).also { editor = it }
    }

    /** 编辑框实时高亮。笔记很长时若觉得卡，可改成 withPreRender（需要传 Executor） */
    fun watcher(ctx: Context) = MarkwonEditorTextWatcher.withProcess(editor(ctx))

    fun setMarkdown(tv: TextView, md: String) {
        render(tv.context).setMarkdown(tv, md)
        attachCodeBlockCopy(tv)
    }

    // ---------- 预览态待办打钩 ----------

    /**
     * 预览态待办可交互打钩：给每个 TaskListSpan 的行首叠一个透明的 ClickableSpan。
     *
     * 命中原理：勾选框画在行首 leading margin（文本左侧空白区），点击那里时
     * Layout.getOffsetForHorizontal 会把坐标钳制到行首字符 → 恰好落在我们
     * 覆盖行首的 span 区间上。这条路完全走 CopyableLinkMovementMethod 的
     * 现有分发，不额外消费触摸事件，长按选中文字不受影响。
     *
     * 视觉更新策略：不在原地改 span。setDone+invalidate 与反射切 drawable
     * state 两条路都实测无效（尽管字节码显示 drawLeadingMargin 绘制时会按
     * isDone 重设 state，理论上应当生效——深因难追，不再纠缠）。
     * 改由调用方在收到回调后按新源码整篇重渲染：工厂从新文本建全新 span，
     * 勾选状态必然与源码一致，行为等价于「重进一次预览」但保住滚动位置。
     *
     * @param onToggle (第几个任务, 新勾选态)——调用方改源文本后负责重渲染预览
     */
    fun attachTaskToggles(tv: TextView, onToggle: (index: Int, done: Boolean) -> Unit) {
        val text = tv.text as? Spannable ?: return
        val spans = text.getSpans(0, text.length, TaskListSpan::class.java)
            .sortedBy { text.getSpanStart(it) }   // getSpans 不保证文档序，span 顺序必须和源文本任务顺序一致
        spans.forEachIndexed { index, span ->
            val start = text.getSpanStart(span)
            val end = minOf(start + 4, text.getSpanEnd(span))
            if (start < 0 || end <= start) return@forEachIndexed
            text.setSpan(
                object : ClickableSpan() {
                    override fun onClick(widget: View) {
                        onToggle(index, !span.isDone)
                    }

                    override fun updateDrawState(ds: android.text.TextPaint) {
                        // 纯热区，不带任何视觉样式
                    }
                },
                start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
        }
    }

    /**
     * 预览带内嵌图片的便签。images 是 key → Base64(JPEG) 的映射。
     * 没有图、或正文里没引用图时走原路，一点额外开销都不加。
     */
    fun setMarkdownWithImages(tv: TextView, md: String, images: Map<String, String>) {
        val matches = IMG_REF.findAll(md).toList()
        if (matches.isEmpty()) {
            setMarkdown(tv, md)
            return
        }
        // 宽度不等 View 测量：预览区可用宽度就是「屏幕宽 - 两侧留白」，先直接算好
        val maxWidth = availableWidth(tv)
        val mdw = render(tv.context)
        val out = SpannableStringBuilder()
        var cursor = 0

        for (m in matches) {
            // 图片前后的正文照常交给 Markwon 渲染，逐段拼进来
            appendRendered(mdw, out, md.substring(cursor, m.range.first))
            cursor = m.range.last + 1

            val key = m.groupValues[2]
            val b64 = images[key]
            val bmp = if (b64 == null) null else decodeImage(key, b64, maxWidth)
            if (bmp == null) {
                // 数据缺失或解码失败都必须看得见，绝不静默留白
                appendRendered(mdw, out, if (b64 == null) "`[图片丢失]`" else "`[图片解码失败]`")
                continue
            }
            if (out.isNotEmpty() && !out.endsWith("\n")) out.append("\n")
            // 占位符由我们自己插入、自己贴图，完全不经过 Markwon，
            // 也就没有「Markwon 排版后占位符还在不在」这个不确定性
            val at = out.length
            out.append(IMG_PLACEHOLDER)
            // 关键：ImageSpan(Drawable) 不会自动设置 bounds，TextView 按
            // bounds 决定图片的占位宽高；不设置就是 0×0，图片完全不可见
            val drawable = BitmapDrawable(tv.resources, bmp)
            drawable.setBounds(0, 0, bmp.width, bmp.height)
            out.setSpan(
                ImageSpan(drawable),
                at, at + 1,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
            // 点击图片 → 全屏查看（占位符就一个字符，点图片任意位置都会命中）
            out.setSpan(
                object : ClickableSpan() {
                    override fun onClick(widget: View) {
                        ImageViewActivity.show(widget.context, bmp)
                    }

                    override fun updateDrawState(ds: android.text.TextPaint) {}
                },
                at, at + 1,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
            out.append("\n")
        }
        appendRendered(mdw, out, md.substring(cursor))

        // 图在 setText 之前就贴好了，TextView 会带着图片一起重新排版
        tv.setText(out, TextView.BufferType.SPANNABLE)
        attachCodeBlockCopy(tv)
    }

    /** 渲染一段 Markdown 并追加到目标文本；span 显式搬过去，不赌 append 的隐式行为 */
    private fun appendRendered(mdw: Markwon, out: SpannableStringBuilder, segment: String) {
        if (segment.isEmpty()) return
        if (out.isEmpty() && segment.isBlank()) return
        val rendered = mdw.render(mdw.parse(segment))
        val at = out.length
        out.append(rendered)
        if (rendered is Spanned) {
            for (s in rendered.getSpans(0, rendered.length, Any::class.java)) {
                val st = rendered.getSpanStart(s)
                val en = rendered.getSpanEnd(s)
                if (st < 0 || en < st) continue
                out.setSpan(s, at + st, at + en, rendered.getSpanFlags(s))
            }
        }
    }

    /** 预览区一行能放多宽；还没布局量不到时，退回到「屏幕宽 - 两侧留白」 */
    private fun availableWidth(tv: TextView): Int {
        val w = tv.width - tv.paddingLeft - tv.paddingRight
        if (w > 0) return w
        val dm = tv.resources.displayMetrics
        return (dm.widthPixels - 40 * dm.density).toInt().coerceAtLeast(1)
    }

    /** 解码内嵌图片并按可用宽度等比缩放；同一张图同一宽度只解一次 */
    private fun decodeImage(key: String, base64: String, maxWidth: Int): Bitmap? {
        val cacheKey = "$key@$maxWidth"
        imageCache.get(cacheKey)?.let { return it }

        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            return null
        }

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        // 先按 2 的幂次粗采样：大图别整张读进内存再缩，省得白白吃一截峰值
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2

        val raw = BitmapFactory.decodeByteArray(
            bytes, 0, bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample }
        ) ?: return null

        val bmp = if (raw.width > maxWidth) {
            val h = (raw.height.toFloat() * maxWidth / raw.width).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(raw, maxWidth, h, true).also { if (it !== raw) raw.recycle() }
        } else raw

        // 只放进缓存、不主动 recycle 旧图：可能还有 ImageSpan 正引用着它
        imageCache.put(cacheKey, bmp)
        return bmp
    }

    /** 预览里的代码块可以直接点击复制，不用长按选中 */
    private fun attachCodeBlockCopy(tv: TextView) {
        val text = tv.text as? Spannable ?: return
        val spans = text.getSpans(0, text.length, CodeBlockSpan::class.java)
        if (spans.isEmpty()) return

        for (span in spans) {
            val start = text.getSpanStart(span)
            val end = text.getSpanEnd(span)
            if (start < 0 || end <= start) continue

            val code = text.subSequence(start, end).toString().trim('\n', '\r', ' ')
            if (code.isEmpty()) continue

            text.setSpan(
                object : ClickableSpan() {
                    override fun onClick(widget: View) {
                        copyCode(tv.context, code)
                    }

                    override fun updateDrawState(ds: android.text.TextPaint) {
                        // 保持代码块原有样式，不画下划线、不改色
                        ds.isUnderlineText = false
                    }
                },
                start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
            )
        }
    }

    private fun copyCode(context: Context, code: String) {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("md-code", code))
        Toast.makeText(context, "代码已复制", Toast.LENGTH_SHORT).show()
    }
}
