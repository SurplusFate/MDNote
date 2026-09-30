package com.example.mdnotes

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.util.Base64
import android.webkit.WebResourceResponse
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/**
 * 图片管理（审查 #17 Sprint 5：EditorImageController）。
 *
 * 职责：本便签内嵌图的存储与发布、WebView 图片请求拦截供流（img://key →
 * https://mdnotes.local/img/<key>）、相册选图导入（压缩→Base64→哈希去重）、
 * 全屏看图。Base64 永不进 JS 字符串（evaluateJavascript 传大字符串会卡主线程）。
 * 修缩进 / IME / 历史问题时**不应触碰本文件**。
 */
class EditorImageController(
    private val a: EditActivity,
    private val state: EditorState
) {

    companion object {
        /** 插入的图片最长边压到多少像素：太大 json 会胖、同步会慢 */
        private const val MAX_IMAGE_DIM = 1440
        /** 插入图片的 JPEG 质量 */
        private const val IMAGE_QUALITY = 82
    }

    /**
     * 本便签内嵌的图片：key（内容哈希）→ Base64(JPEG)。
     * 正文里用 ![说明](img://key) 引用，保存时跟着 Note 一起写进 notes.json。
     */
    val noteImages = LinkedHashMap<String, String>()

    /** shouldInterceptRequest（IO 线程）读的只读快照：主线程增删图片后发布 */
    @Volatile
    private var noteImagesSnapshot: Map<String, String> = emptyMap()

    /** 图片 Base64 → bytes 解码缓存（key 重复请求不重复解码），IO 线程用 */
    private val imgBytesCache = object : LinkedHashMap<String, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean =
            size > 24
    }

    /** 主线程增删图片后调用：发布只读快照给 IO 线程的拦截回调 */
    fun publishImages() {
        noteImagesSnapshot = LinkedHashMap(noteImages)
    }

    /** 保存时裁掉正文里不再引用的图，别让删了图的旧数据一直占着 json */
    fun retainImagesReferencedBy(content: String) {
        val used = IMG_REF.findAll(content).map { it.groupValues[2] }.toSet()
        noteImages.keys.retainAll(used)
        publishImages()
    }

    /** 打开已有笔记时装载自带图片 */
    fun loadFrom(note: Note) {
        noteImages.clear()
        noteImages.putAll(note.imageMap())
        publishImages()
    }

    // ---------- WebView 供流（IO 线程） ----------

    fun imageBytes(key: String): ByteArray? {
        synchronized(imgBytesCache) {
            imgBytesCache[key]?.let { return it }
        }
        val b64 = noteImagesSnapshot[key] ?: return null
        return try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            synchronized(imgBytesCache) { imgBytesCache[key] = bytes }
            bytes
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun imageNotFound() = WebResourceResponse(
        "text/plain", "1.0", 404, "Not Found",
        mapOf("Access-Control-Allow-Origin" to "*"),
        ByteArrayInputStream(ByteArray(0))
    )

    /**
     * 图片供流：JS 把 img://key 翻译成 https://mdnotes.local/img/<key>，
     * 这里拦下来从 noteImages 解码返回 —— Base64 永不进 JS 字符串，
     * 也不会有加载闪烁。只处理 mdnotes.local 的请求，其余返回 null 放行。
     */
    fun interceptImageRequest(requestUrl: Uri): WebResourceResponse? {
        if (requestUrl.host != "mdnotes.local") return null
        val key = requestUrl.lastPathSegment ?: return imageNotFound()
        val bytes = imageBytes(key) ?: return imageNotFound()
        return WebResourceResponse(
            "image/jpeg", "1.0", 200, "OK",
            mapOf("Access-Control-Allow-Origin" to "*"),
            ByteArrayInputStream(bytes)
        )
    }

    // ---------- 桥事件：看图 / 选图 ----------

    fun onJsViewImage(key: String) {
        a.lifecycleScope.launch {
            val bmp = withContext(Dispatchers.IO) {
                val b64 = noteImagesSnapshot[key] ?: return@withContext null
                try {
                    val bytes = Base64.decode(b64, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                } catch (e: Exception) {
                    null
                }
            }
            if (bmp != null) {
                state.suppressExitEdit = true   // 全屏看图返回后别被"键盘收起"误退编辑态
                ImageViewActivity.show(a, bmp)
            }
        }
    }

    /** v1.58：工具栏「图片」按钮经事件队列请求 → 打开系统相册选图（仅图片） */
    fun onJsPickImage() {
        a.runOnUiThread {
            a.launchPickImage()
        }
    }

    // ---------- 相册选图导入 ----------

    /** 相册选一张图：压缩 → Base64 → 存进 noteImages → JS 在光标处插入 img:// 引用 */
    fun importImage(uri: Uri) {
        a.toast("正在处理图片…")
        a.lifecycleScope.launch {
            val encoded = withContext(Dispatchers.IO) { encodeImage(uri) }
            if (encoded == null) {
                a.toast("这张图读不出来，换一张试试")
                return@launch
            }
            val (key, base64, size) = encoded
            noteImages[key] = base64
            publishImages()
            a.editor.js("editor.insertImage(${JSONObject.quote(key)})")
            a.toast("已插入图片（${(size + 1023) / 1024} KB）")
            // 选图回来键盘已收：插图后继续编辑，主动唤回键盘
            a.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                ?.showSoftInput(a.binding.editorWeb, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
    }

    /**
     * 读图 → 压到最长边 MAX_IMAGE_DIM → JPEG → Base64。
     * key 取压缩后内容的 SHA-256 前 16 位：同一张图插几次都只存一份。
     * 返回 (key, base64, 压缩后字节数)，失败返回 null。
     */
    private fun encodeImage(uri: Uri): Triple<String, String, Int>? {
        return try {
            val bytes = a.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null

            // 先探尺寸定采样率：4000×3000 的照片整张读进来要吃掉几十 MB
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_IMAGE_DIM) sample *= 2

            val raw = BitmapFactory.decodeByteArray(
                bytes, 0, bytes.size,
                BitmapFactory.Options().apply { inSampleSize = sample }
            ) ?: return null

            val scaled = scaleDown(flatten(raw), MAX_IMAGE_DIM)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, IMAGE_QUALITY, out)
            val jpeg = out.toByteArray()
            if (jpeg.isEmpty()) return null
            Triple(sha256(jpeg).take(16), Base64.encodeToString(jpeg, Base64.NO_WRAP), jpeg.size)
        } catch (e: Exception) {
            null
        }
    }

    /** PNG 的透明背景压成 JPEG 会变黑，先垫一层白底 */
    private fun flatten(src: Bitmap): Bitmap {
        if (!src.hasAlpha()) return src
        val out = Bitmap.createBitmap(src.width, src.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            drawBitmap(src, 0f, 0f, null)
        }
        src.recycle()
        return out
    }

    /** 最长边超过 maxDim 就等比缩下来 */
    private fun scaleDown(src: Bitmap, maxDim: Int): Bitmap {
        val longest = maxOf(src.width, src.height)
        if (longest <= maxDim) return src
        val ratio = maxDim.toFloat() / longest
        val w = (src.width * ratio).toInt().coerceAtLeast(1)
        val h = (src.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(src, w, h, true).also { if (it !== src) src.recycle() }
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
}
