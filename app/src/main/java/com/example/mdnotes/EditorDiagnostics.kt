package com.example.mdnotes

import android.content.Intent
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.core.view.WindowInsetsCompat
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * 编辑器诊断（审查 #17 Sprint 5：EditorDiagnostics）。
 *
 * 只负责「让人看见内部状态」，不做任何业务决策：
 * - insets 原始帧环形缓冲 + 详细日志落盘/一键分享（v1.65/v1.66）；
 * - JS 桥探针读数与 JS 诊断文本（pollJsState 的下行镜像）；
 * - 调试浮层渲染（真机证据直接看屏）。
 * 随设置项「调试日志」开关工作：日常零开销，排障时落盘 —— 不再靠猜。
 */
class EditorDiagnostics(private val a: EditActivity) {

    // ---------- insets 详细日志（v1.66：写文件 + logcat） ----------

    private val insetLogBuf = ArrayDeque<String>()   // 内存镜像（最近 400 条，文件超上限时回写）
    private val insetLogLock = Any()
    private val insetLogFile get() = File(a.getExternalFilesDir(null), "mdnotes_insets.log")

    fun appendInsetLog(msg: String) {
        if (!DebugPref.enabled(a)) return   // 随「调试日志」开关：日常零开销，测时落盘
        val ts = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())
        val line = "$ts $msg\n"
        synchronized(insetLogLock) {
            insetLogBuf.addLast(line)
            while (insetLogBuf.size > 400) insetLogBuf.removeFirst()
        }
        Log.d("MdNotesInset", line.trimEnd())
        try {
            val f = insetLogFile
            if (!f.exists()) f.createNewFile()
            f.appendText(line)
            if (f.length() > 256 * 1024) {   // 限大小：超 256KB 回写内存镜像（最近 400 条）
                synchronized(insetLogLock) { f.writeText(insetLogBuf.joinToString("")) }
            }
        } catch (_: Exception) { /* 存储不可用静默 */ }
    }

    /** 点调试浮窗一键把日志发出去 */
    fun shareInsetLog() {
        val f = insetLogFile
        if (!f.exists() || f.length() == 0L) {
            Toast.makeText(a, "日志为空", Toast.LENGTH_SHORT).show(); return
        }
        val uri = FileProvider.getUriForFile(a, "${a.packageName}.fileprovider", f)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        a.startActivity(Intent.createChooser(intent, "分享 insets 日志"))
    }

    // ---------- JS 桥探针读数（pollJsState 每轮更新） ----------

    var jsProbe = "?"          // JS 侧 __bridgeProbe 的下行镜像
        internal set
    var jsProbeMethod = "?"
        internal set
    var jsProbeOk = 0
        internal set
    var jsPollBad = 0          // 轮询结果解析失败计数（>0 说明下行通道有毛病）
        internal set
    var jsDiagText = "?"       // JS 诊断文本：回车计数 / 分块成功失败 / 最近 JS 异常
        internal set
    var jsBridgeErr = "-"      // 桥探针的异常（err 非空 = JS→Java 调用抛过异常）
        internal set
    var jsBridgeLast = "-"
        internal set

    /** v1.88：最近一次上报的缩进刷新诊断，去重后打 logcat */
    private var lastIndentDiag = ""

    fun bumpPollBad() { jsPollBad++ }

    fun recordProbe(probe: org.json.JSONObject?) {
        jsProbe = probe?.optString("hasAndroid") ?: "?"
        jsProbeMethod = probe?.optString("methodType") ?: "?"
        jsProbeOk = probe?.optInt("ok") ?: 0
        jsBridgeErr = probe?.optString("err").orEmpty().ifEmpty { "-" }
        jsBridgeLast = probe?.optString("last").orEmpty().ifEmpty { "-" }
    }

    /** JS 诊断（回车/分块计数 + 最近异常），从 probe/stat 的 d 字段更新 */
    fun updateJsDiag(d: org.json.JSONObject?) {
        if (d == null) {
            jsDiagText = "?"
            return
        }
        val errs = d.optJSONArray("err")
        val lastErr = if (errs != null && errs.length() > 0) {
            var s = ""
            for (i in 0 until errs.length()) {
                val e = errs.optString(i)
                if (e.isNotEmpty()) s = if (s.isEmpty()) e else "$s | $e"
            }
            s
        } else ""
        jsDiagText = buildString {
            append("enter=").append(d.optInt("en"))
            append(" ok=").append(d.optInt("ok"))
            append(" err=").append(d.optInt("er"))
            if (lastErr.isNotEmpty()) append(" last=[").append(lastErr).append(']')
            // v1.88：缩进刷新的结果（ok(nofix) / fix a->b / ROLLBACK a->b）。
            // 真机"莫名多出几十个待办框"无法在 headless 复现，这里把每次刷新的行数变化
            // 落到 logcat，下次复现时可直接取证（adb logcat -s MdNotes）。
            val id = d.optString("id")
            if (id.isNotEmpty()) {
                append(" id=[").append(id).append(']')
                if (id != lastIndentDiag) {
                    lastIndentDiag = id
                    Log.d("MdNotesIndent", "indentDiag=$id")
                }
            }
        }
    }

    // ---------- 原始 insets 帧环形缓冲（v1.65） ----------
    // 每次 ime 分发回调记 "D" 帧、页面就绪实时查询记 "Q" 帧，含相对时间戳与
    // 一个 (v,bottom) 元组。连续同值帧去重（只留状态变迁史），真机打开调试浮层
    // 截一张图即可看到 ROM 给悬浮键盘到底下发了什么 —— 不再靠猜。

    private val insetsRawLog = ArrayDeque<String>()
    private var lastRawKey = ""

    /** 记一条 (来源, 可见, 底高) 到环形缓冲；来源约定 D=分发回调 Q=页面就绪查询 */
    fun logRaw(tag: String, v: Boolean, b: Int) {
        val key = "$tag:$v:$b"
        if (key == lastRawKey) return
        lastRawKey = key
        val t = android.os.SystemClock.elapsedRealtime()
        val sec = (t / 1000) % 100000
        val ms = (t % 1000) / 100
        insetsRawLog.addLast("${sec}.${ms}s $tag v=${if (v) 1 else 0} b=$b")
        while (insetsRawLog.size > 14) insetsRawLog.removeFirst()
        appendInsetLog("$tag v=${if (v) 1 else 0} b=$b")   // v1.66：变化帧同时落盘
    }

    // ---------- 调试浮层 ----------

    /** debug 构建的内部状态浮层：三通道读数 + 最终判定，真机证据直接看屏 */
    fun updateDebugOverlay(
        ime: EditorImeController,
        ri: WindowInsetsCompat?,
        qVisible: Boolean,
        qBottom: Int
    ) {
        val binding = a.binding
        if (binding.debugOverlay.visibility != View.VISIBLE) return
        val r = android.graphics.Rect()
        binding.root.getWindowVisibleDisplayFrame(r)
        val rootH = binding.root.rootView.height
        val ua = binding.editorWeb.settings.userAgentString
        val chromeVer = Regex("Chrome/(\\d+)").find(ua)?.groupValues?.get(1) ?: "?"
        @Suppress("DEPRECATION")
        val verName = a.packageManager.getPackageInfo(a.packageName, 0).versionName
        binding.debugOverlay.text = buildString {
            append("v").append(verName)
            append("  insetsCalls=").append(ime.insetsCalls).append('\n')
            append("分发: ime=").append(ime.insetsImeVisible).append('/').append(ime.insetsImeBottom)
            append("  nav=").append(ime.insetsNavBottom).append('\n')
            append("查询: ime=").append(qVisible).append('/').append(qBottom)
            .append("  ri=").append(ri != null).append('\n')
            append("高差: rootH=").append(rootH).append(" visH=").append(r.height())
            .append(" diff=").append(rootH - r.height())
            .append(" visBottom=").append(r.bottom).append('\n')
            append("判定: imeVisible=").append(ime.lastImeVisible)
            .append(" 悬浮=").append(ime.isFloatingIme())
            .append(" 键上=").append(ime.sawImeUp)   // v1.64：本会话有普通键盘实证（自动退预览资格）
            .append(" jsEditing=").append(a.state.editing)
            .append(" ready=").append(a.state.ready)
            .append(" suppress=").append(a.state.suppressExitEdit).append('\n')
            append("桥: JS内Android=").append(jsProbe)
            .append(" 方法=").append(jsProbeMethod)
            .append(" JS调成功=").append(jsProbeOk)
            .append(" 上行到达=").append(EditorBridge.upCalls).append('\n')
            append("桥err=").append(jsBridgeErr)
            .append(" 最近=").append(jsBridgeLast).append('\n')
            append("JS诊断: ").append(jsDiagText)
            .append(" 轮询坏包=").append(jsPollBad).append('\n')
            append("WebView Chrome/").append(chromeVer).append('\n')
            // v1.65：原始 insets 帧序列（D=分发回调 Q=页面就绪查询，v=可见 b=底高）
            append("原始序列(D=分发 Q=查询):\n")
            if (insetsRawLog.isEmpty()) append("  (无)")
            else insetsRawLog.forEach { append("  ").append(it).append('\n') }
        }
    }
}
