package com.example.mdnotes

import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 统一日志工具（v1.104：取代散落的 android.util.Log 调用）。
 *
 * 设计要点：
 * - 每条日志自动带：日期时间(毫秒) + 级别 + 线程名 + 调用者 Tag(Class.method(L行))；
 * - 双写：logcat（始终、全级别）+ 文件 mdnotes.log（受「调试日志」开关控制，默认关，排障才落盘）；
 * - JS 控制台经 WebChromeClient.onConsoleMessage 桥接进来，统一 tag=JS，原生也能看见编辑器内核日志；
 * - 文件超 2MB 自动滚动（保留最近 200KB），避免无限增长占用存储；
 * - share() 一键把日志文件发出去（复用现有 fileprovider authority）。
 *
 * 用法：AppLog.d("msg") / AppLog.e("msg", throwable) / AppLog.js(level, "msg")
 */
object AppLog {

    private const val TAG = "MdNotes"
    private const val FILE_NAME = "mdnotes.log"
    private const val MAX_FILE_BYTES = 2 * 1024 * 1024
    private const val ROLLBACK_KEEP = 200 * 1024

    private val dateFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)

    @Volatile
    private var appCtx: Context? = null

    /** 进程启动时（MdApp.onCreate）注入 Application Context，之后写文件即可定位目录 */
    fun init(ctx: Context) {
        appCtx = ctx.applicationContext
        i("AppLog", "init ok; logFile=${fileOf(ctx.applicationContext).absolutePath}")
    }

    private fun fileOf(c: Context) = File(c.getExternalFilesDir(null), FILE_NAME)

    /** 文件落盘是否开启（受「调试日志」开关控制）。开关关闭时仍打 logcat */
    private fun fileEnabled(): Boolean {
        val c = appCtx ?: return false
        return DebugPref.enabled(c)
    }

    /** 跳过 AppLog/系统栈帧，取第一个业务调用者：返回 (类名, 方法名, 行号) */
    private fun caller(): Triple<String, String, Int> {
        val st = Throwable().stackTrace
        for (i in st.indices) {
            val cn = st[i].className
            if (cn != "com.example.mdnotes.AppLog" &&
                !cn.startsWith("java.") && !cn.startsWith("android.") &&
                !cn.startsWith("kotlin.") && !cn.startsWith("com.android.")
            ) {
                val simple = cn.substringAfterLast('.').substringBefore('$')
                return Triple(simple, st[i].methodName, st[i].lineNumber)
            }
        }
        return Triple("?", "?", 0)
    }

    private fun lvChar(level: Int) = when (level) {
        Log.VERBOSE -> "V"
        Log.DEBUG -> "D"
        Log.INFO -> "I"
        Log.WARN -> "W"
        else -> "E"
    }

    private fun emit(level: Int, tag: String, msg: String, tr: Throwable? = null) {
        val (cls, method, line) = caller()
        val ts = dateFmt.format(Date())
        val thread = Thread.currentThread().name
        val head = "$ts [${lvChar(level)}] $thread $tag<$cls.$method(L$line)>"
        val body = if (tr != null) "$msg\n${Log.getStackTraceString(tr)}" else msg
        Log.println(level, TAG, "$head: $body")
        if (fileEnabled()) appendFile("$head: $body\n")
    }

    private fun appendFile(line: String) {
        val c = appCtx ?: return
        try {
            val f = fileOf(c)
            if (!f.exists()) f.createNewFile()
            if (f.length() > MAX_FILE_BYTES) {
                val tail = f.readText().takeLast(ROLLBACK_KEEP)
                f.writeText(tail)
            }
            f.appendText(line)
        } catch (_: Exception) { /* 存储不可用静默 */ }
    }

    fun v(tag: String, msg: String) = emit(Log.VERBOSE, tag, msg)
    fun d(tag: String, msg: String) = emit(Log.DEBUG, tag, msg)
    fun i(tag: String, msg: String) = emit(Log.INFO, tag, msg)
    fun w(tag: String, msg: String) = emit(Log.WARN, tag, msg)
    fun e(tag: String, msg: String, tr: Throwable? = null) = emit(Log.ERROR, tag, msg, tr)

    /** JS 控制台桥接入口：WebChromeClient.onConsoleMessage 调用，tag 固定 JS */
    fun js(level: Int, msg: String) {
        val ts = dateFmt.format(Date())
        val thread = Thread.currentThread().name
        val head = "$ts [${lvChar(level)}] $thread JS"
        Log.println(level, TAG, "$head: $msg")
        if (fileEnabled()) appendFile("$head: $msg\n")
    }

    /** 一键分享日志文件（空则提示）。复用 fileprovider authority */
    fun share(ctx: Context) {
        val f = fileOf(ctx)
        if (!f.exists() || f.length() == 0L) {
            Toast.makeText(ctx, "日志为空（调试日志开关未开启？）", Toast.LENGTH_SHORT).show()
            return
        }
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", f)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(Intent.createChooser(intent, "分享日志"))
    }
}
