package com.example.mdnotes

import android.content.Context
import android.widget.Toast

/**
 * 正文里内嵌图片的引用写法：![说明](img://key)，key 是图片内容哈希。
 *
 * v1.59 放宽第二种形式：编辑器渲染时 JS 会把 DOM 里 <img src="img://key"> 改写成
 * https://mdnotes.local/img/<key>（WebView 不认 img:// 协议，否则图永远加载不出来），
 * Vditor 序列化回源码时可能把这个 https 形式回写进正文。若正则只认 img://，
 * 回写后的图就匹配不上 —— 列表预览会露出一长串 URL，更糟的是 EditActivity 的
 * 「未引用图片回收」会以为这张图没人用而把它删掉（丢数据）。两种形式都认，
 * 捕获组结构不变（1=说明，2=key），三处调用无需改动。
 */
val IMG_REF = Regex("!\\[([^\\]]*)\\]\\((?:img://|https://mdnotes\\.local/img/)([A-Za-z0-9_\\-]+)\\)")

fun Context.toast(msg: String) {
    Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}

/** 把 Markdown 源码压成一行纯文本，给列表当预览用（不渲染，省性能） */
fun plainPreview(md: String, max: Int = 60): String {
    val s = md
        // 内嵌图片先换成「[图片]」，别让列表里露出一长串 img:// 哈希
        .replace(IMG_REF) { if (it.groupValues[1].isBlank()) "[图片]" else "[${it.groupValues[1]}]" }
        .replace(Regex("^\\s*#{1,6}\\s*", RegexOption.MULTILINE), "")
        .replace(Regex("[*`~>\\[\\]()!]"), "")
        .replace(Regex("\\s+"), " ")
        .trim()
    return if (s.isBlank()) "（空）" else if (s.length > max) s.substring(0, max) + "…" else s
}

/** 从内容中提取第一个 H1（`# 标题`）作为便签标题；没有就返回空串 */
fun extractTitle(content: String): String =
    content.lineSequence()
        .firstOrNull { it.startsWith("# ") }
        ?.removePrefix("# ")
        ?.trim()
        .orEmpty()

/** 任务列表标记：前导换行 + 缩进 + "- [x]"（嵌套缩进的也算，顺序与渲染出的勾选框一致） */
private val TASK_MARK = Regex("(^|\\n)([ \\t]*[-*+] \\[)([ xX])(\\])")

/**
 * 把第 n 个（0 起）任务标记换成指定勾选态，其余原样保留。
 * 预览里点击勾选框时用它同步修改源文本。找不到（标记数与勾选框对不上）返回 null。
 */
fun toggleNthTask(src: String, n: Int, done: Boolean): String? {
    var idx = -1
    TASK_MARK.findAll(src).forEach { m ->
        idx++
        if (idx == n) {
            val sb = StringBuilder(src.length + 2)
            sb.append(src, 0, m.range.first)
            sb.append(m.groupValues[1])          // 前导换行（文首为空）
            sb.append(m.groupValues[2])          // 缩进 + "- ["
            sb.append(if (done) "x" else " ")    // 勾选态
            sb.append("]")
            sb.append(src, m.range.last + 1, src.length)
            return sb.toString()
        }
    }
    return null
}

private val FMT by lazy { java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.getDefault()) }

fun formatTime(t: Long): String = FMT.format(java.util.Date(t))
