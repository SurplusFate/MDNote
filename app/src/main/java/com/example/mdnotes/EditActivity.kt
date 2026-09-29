package com.example.mdnotes

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.SeekBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.content.FileProvider
import android.widget.Toast
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.example.mdnotes.databinding.ActivityEditBinding
import com.google.android.material.checkbox.MaterialCheckBox
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.security.MessageDigest

/**
 * 便签编辑页 —— WebView 版迷你 Typora（块级实时渲染）。
 *
 * 交互模型（小米便签 × Typora）：
 * 1. 打开笔记 = 纯预览（全部块渲染显示）；
 * 2. 点击任意块 = 该块变源码态（contenteditable），光标落在点击处，键盘弹出，
 *    其余块保持渲染 —— 与 Typora 的块级 live rendering 同款；
 * 3. 键盘收起（返回键 / 辅助栏收起键 / 切到别的块）= 自动提交并回到预览；
 * 4. 编辑内容经 EditorBridge 防抖回传，onPause 兜底落盘。
 *
 * 渲染与编辑循环全在 assets/editor/（Vditor IR 即时渲染内核 + editor-vditor.js 桥接层，
 * v1.36 起替换自研 editor.js）；本类只负责壳：
 * WebView 生命周期、IME insets 联动、工具栏/撤销/图片/主题的桥接。
 */
class EditActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_ID = "id"

        /** 撤回/前进历史栈的最大深度 */
        private const val MAX_HISTORY = 100
        /** 撤销粒度：同词内连续打字/退格合并成一个点，遇空格/换行/粘贴另起一步 */

        /** 插入的图片最长边压到多少像素：太大 json 会胖、同步会慢 */
        private const val MAX_IMAGE_DIM = 1440
        /** 插入图片的 JPEG 质量 */
        private const val IMAGE_QUALITY = 82

        /** 键盘收起后多久确认自动退回预览：IME 动画期间 insets 逐帧回落，防误判 */
        private const val IME_SETTLE_MS = 250L
        private const val IME_POLL_MS = 300L
        /** v1.88：两次 Tab 派发之间的最小间隔 —— 给 Vditor 消化上一次嵌套重渲染的时间 */
        private const val TAB_GAP_MS = 160L
        /** 进入编辑态后的宽限期：键盘弹出有时延，宽限内不判"键盘收起" */
        private const val EDIT_GRACE_MS = 600L
        /**
         * v1.67（有实锤）：悬浮键盘的 ime insets「高度小到算不占窗口」的阈值。
         * v1.66 日志实测这台设备 + 搜狗悬浮键盘：悬浮在场报 v=1 b=2（不是 0！），
         * 普通模式弹出资 b=794；此前 b==0 判定永不成立 → 悬浮态恒判 false。
         * 40px 以下不可能是有交互能力的键盘高度，普通键盘最小也有几百 px。
         */
        private const val FLOAT_IME_MAX_PX = 40
    }

    private lateinit var binding: ActivityEditBinding
    private var noteId: Long = MainActivity.NEW_NOTE

    // ---------- WebView 编辑器状态 ----------

    /** 内容真理源镜像：装载前 = 笔记原文；装载后跟随 JS 的 onContentChanged */
    private var currentContent: String = ""

    /** JS 是否处于编辑态（桥回报，驱动辅助栏显隐 / 返回键 / insets 联动） */
    private var jsEditing = false

    /** WebView 页面就绪（onPageFinished），evaluateJavascript 的门闩 */
    private var editorReady = false

    /** 首屏前注入的内联主题样式（v1.52 修深色模式进入闪白）：按当前昼夜资源算好，
     *  经 shouldInterceptRequest 注入 editor.html 的 <head> 最前，使 Vditor 挂载与
     *  首屏绘制直接拿深色背景/前景，杜绝「先浅后深」的闪一下。 */
    private lateinit var bootstrapThemeCss: String

    /** 新建笔记：页面就绪后直接进入编辑态并唤起键盘 */
    private var pendingAutoEdit = false

    /** 抑制"键盘收起→退预览"：对话框、外跳浏览器、全屏看图、选图期间置位 */
    private var suppressExitEdit = false

    /** 最近一次进入编辑态的时刻（elapsedRealtime），宽限期用 */
    private var editingSince = 0L

    /** JS 上报的最近光标 offset（undo 恢复定位用） */
    private var lastCaret = 0

    /** 本便签独立字号（sp）；null = 跟随设置里的全局字号 */
    private var noteFontSize: Int? = null

    /**
     * 本便签内嵌的图片：key（内容哈希）→ Base64(JPEG)。
     * 正文里用 ![说明](img://key) 引用，保存时跟着 Note 一起写进 notes.json。
     */
    private val noteImages = LinkedHashMap<String, String>()

    /** shouldInterceptRequest（IO 线程）读的只读快照：主线程增删图片后发布 */
    @Volatile
    private var noteImagesSnapshot: Map<String, String> = emptyMap()

    /** 图片 Base64 → bytes 解码缓存（key 重复请求不重复解码），IO 线程用 */
    private val imgBytesCache = object : LinkedHashMap<String, ByteArray>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ByteArray>?): Boolean =
            size > 24
    }

    /** 相册选图：PickVisualMedia 在各版本上都有系统选择器兜底，不用申请读相册权限 */
    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let { importImage(it) }
    }

    // ---------- 撤回 / 前进历史 ----------

    /** 一步可回退的状态：正文 + 光标位置 */
    private class Snapshot(val text: String, val selStart: Int, val selEnd: Int)

    /** 栈顶永远是「当前状态」，它的前一个才是「上一步」；redoStack 存被撤回掉的状态 */
    private val undoStack = ArrayDeque<Snapshot>()
    private val redoStack = ArrayDeque<Snapshot>()

    /** 回放历史时也会触发桥上报，用它挡住、别把自己的回放记成新编辑 */
    private var applyingHistory = false

    private val historyHandler = Handler(Looper.getMainLooper())

    /** 键盘收起 → 退预览的防抖任务 */
    private val imeExitHandler = Handler(Looper.getMainLooper())
    private var lastImeVisible = false   // 边沿检测：轮询高频触发下只认状态变化
    private var lastFloatingPushed = false   // v1.63：最近推送的悬浮标志（悬浮⇄普通切换也要推送）
    private var lastImePushAt = 0L       // v1.54：最近一次 onIme 推送时间（收起态保活重推）
    private var insetsUpdatedAt = 0L     // v1.55：insets 分发缓存最近刷新时间（收起后 ROM 不再分发 → 旧缓存过期）
    // insets 分发通道缓存（root/editorWeb 两个挂点幂等写）
    private var insetsImeVisible = false
    private var insetsImeBottom = 0
    private var insetsNavBottom = 0
    private var insetsCalls = 0          // 分发到达计数（0 = 分发根本没来，证据）
    // v1.65 证据采集：原始 insets 帧环形缓冲（最多 14 条）。每次 ime 分发回调记
    // "D" 帧、页面就绪实时查询记 "Q" 帧，含相对时间戳与一个 (v,bottom) 元组。
    // 连续同值帧去重（只留状态变迁史），真机打开调试浮层截一张图即可看到 ROM 给
    // 悬浮键盘到底下发了什么 —— 不再靠猜。lastRawKey 用于去重。
    private val insetsRawLog = ArrayDeque<String>()
    private var lastRawKey = ""
    // v1.66：详细事件日志（写文件 + logcat）—— 替代浮窗只能看 14 条的限制。
    // 手动反复唤起/收起键盘测工具栏时，每次 insets 分发、页面就绪查询、每轮最终
    // 判定（含可见/底高/高差/编辑态/推送值）完整落盘，点击浮窗即可一键分享发我。
    private val insetLogBuf = ArrayDeque<String>()   // 内存镜像（最近 400 条，文件超上限时回写）
    private val insetLogLock = Any()
    private val insetLogFile get() = File(getExternalFilesDir(null), "mdnotes_insets.log")
    private fun appendInsetLog(msg: String) {
        if (!DebugPref.enabled(this)) return   // 随「调试日志」开关：日常零开销，测时落盘
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
    private fun shareInsetLog() {
        val f = insetLogFile
        if (!f.exists() || f.length() == 0L) {
            Toast.makeText(this, "日志为空", Toast.LENGTH_SHORT).show(); return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(intent, "分享 insets 日志"))
    }
    // v1.60 悬浮键盘：ime 可见但不占窗口高度（insets.bottom == 0）。
    // v1.64 降级为"定位参考信号"：只参与 onIme 推送的 floating 标志与调试浮层，
    // 不再参与工具栏显隐 —— 悬浮键盘的显隐判定已整体改道（编辑焦点驱动，
    // 见 editor-vditor.js setupToolbarDock v1.64 注释）：本 ROM 对悬浮键盘近乎
    // 零 insets 证据（查询恒 false、分发只剩伪帧），任何基于 insets 的显隐判定
    // 都不可靠，v1.60~v1.63 四代方案（闩锁/防抖/会话保持）已全部拆除。
    private var floatingIme = false
    // v1.64：本编辑会话内见过「占窗口高度的键盘」（普通键盘实证 bottom>0）。
    // 自动退预览（键盘收起 → 退回预览）只在有此实证的会话里生效：悬浮键盘
    // 会话从无 bottom>0，其 (false,0) 帧与真收起在系统层面不可区分，绝不能据
    // 此退编辑（否则悬浮键盘打着字被误退回预览）。悬浮会话的收尾交给返回键
    // 两段式：第一次收键盘、第二次退编辑回预览。
    private var sawImeUp = false
    // 桥探针（JS 侧 __bridgeProbe 的下行镜像 + EditorBridge 上行计数）
    private var jsProbe = "?"
    private var jsProbeMethod = "?"
    private var jsProbeOk = 0
    // 轮询结果解析失败计数（>0 说明下行通道有毛病，浮层直接可见）
    private var jsPollBad = 0
    // JS 诊断文本：回车计数 / 分块成功失败 / 最近 JS 异常
    private var jsDiagText = "?"
    /** v1.88：最近一次上报的缩进刷新诊断，去重后打 logcat */
    private var lastIndentDiag = ""
    // 桥探针的异常与最近方法名（err 非空 = JS→Java 调用抛过异常）
    private var jsBridgeErr = "-"
    private var jsBridgeLast = "-"
    private val imeExitTask = Runnable {
        if (jsEditing && !suppressExitEdit && editorReady) {
            binding.editorWeb.evaluateJavascript("editor.exitEditMode()", null)
        }
    }

    /**
     * 键盘状态轮询：MIUI 等 ROM 可能改写 adjustResize（布局不随键盘变化），
     * OnGlobalLayoutListener 收不到回调 —— 以 300ms 轮询兜底。幂等，重复无害。
     * 同时下行校准 JS 编辑态/内容：@JavascriptInterface 上行在该设备疑似断裂，
     * 用已验证可靠的 evaluateJavascript 通道反向驱动全部联动。
     * 由生命周期驱动（onCreate 启动 / onPause 停止），不依赖 jsEditing ——
     * 否则桥断时 jsEditing 永远 false，轮询自己就停了。
     */
    private val imePollHandler = Handler(Looper.getMainLooper())
    private val imePollTask = object : Runnable {
        override fun run() {
            updateKeyboardBar()
            pollJsState()
            if (!isFinishing) imePollHandler.postDelayed(this, IME_POLL_MS)
        }
    }

    /**
     * 下行校准（两级）：
     * - 未编辑态拉轻探针 probe()（编辑态 + 桥探针 + JS 诊断，不含内容）；
     * - 编辑态拉全量 stat()（内容/光标），走与桥上行相同的 onJsContentChanged。
     *
     * v1.35.7 修复致命 bug：此前脚本是 JSON.stringify(window.editor.probe())，
     * 表达式结果为字符串，evaluateJavascript 回调会对结果再做一次 JSON 编码，
     * Kotlin 拿到的是「字符串的 JSON 编码」，nextValue 出 String、as? JSONObject
     * 恒为 null，每次轮询都在静默 return —— 下行校准从未生效（jsEditing 永远
     * false → 工具栏永不出现 / 收键盘不退预览 / currentContent 不更新丢内容）。
     * 现在直接返回对象，回调一层编码即得 JSONObject。
     */
    private fun pollJsState() {
        if (!editorReady || isFinishing) return
        val script = if (jsEditing)
            "(window.editor ? window.editor.stat() : {})"
        else
            "(window.editor ? window.editor.probe() : {})"
        binding.editorWeb.evaluateJavascript(script) { s ->
            if (isFinishing || s.isNullOrBlank() || s == "null") return@evaluateJavascript
            val obj = try {
                JSONTokener(s).nextValue() as? JSONObject
            } catch (e: Exception) {
                null
            } ?: run {
                jsPollBad++   // 解析失败计数：浮层可见，别再静默
                return@evaluateJavascript
            }
            val probe = obj.optJSONObject("probe")
            jsProbe = probe?.optString("hasAndroid") ?: "?"
            jsProbeMethod = probe?.optString("methodType") ?: "?"
            jsProbeOk = probe?.optInt("ok") ?: 0
            jsBridgeErr = probe?.optString("err").orEmpty().ifEmpty { "-" }
            jsBridgeLast = probe?.optString("last").orEmpty().ifEmpty { "-" }
            updateJsDiag(obj.optJSONObject("d"))
            drainJsEvents(obj.optJSONArray("q"))
            if (obj.optBoolean("e", false)) {
                if (!jsEditing) {
                    onJsEditModeChanged(true)
                } else {
                    onJsContentChanged(obj.optString("s"), obj.optInt("c", 0))
                }
            } else if (jsEditing) {
                onJsEditModeChanged(false)
            }
        }
    }

    /** JS 诊断（回车/分块计数 + 最近异常），从 probe/stat 的 d 字段更新 */
    private fun updateJsDiag(d: JSONObject?) {
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

    /**
     * 处理 JS 事件队列（v1.35.8）：@JavascriptInterface 在该设备上调用即抛，
     * 低频动作（toast/复制代码/开链接/看图）改为 JS 入队、轮询时在这里取出。
     */
    private fun drainJsEvents(q: org.json.JSONArray?) {
        if (q == null) return
        for (i in 0 until q.length()) {
            val ev = q.optJSONObject(i) ?: continue
            when (ev.optString("m")) {
                "toast" -> toast(ev.optString("a"))
                "copyCode" -> onJsCopyCode(ev.optString("a"))
                "openUrl" -> onJsOpenUrl(ev.optString("a"))
                "viewImage" -> onJsViewImage(ev.optString("a"))
                "pickImage" -> onJsPickImage()
                "indentTab" -> onJsIndentTab()
                "outdentTab" -> onJsOutdentTab()
            }
        }
    }

    /**
     * v1.82 缩进/减缩进：JS 把意图入队（页面内无法合成「可信」按键事件，Chromium 只把
     * 原生按键送进编辑器键处理管线），这里向 WebView 派发可信 Tab / Shift+Tab 事件，
     * 由 Vditor IR 原生嵌套逻辑处理（列表/任务/有序能正确嵌套且保留、光标不跳文首）。
     * 引用/段落原生 Tab 无操作，属 IR（Typora）模型限制，不破坏光标。
     * 工具栏按钮的 mousedown 已 preventDefault，IR 仍聚焦，事件会落到当前列表项上。
     */
    private fun dispatchTabToEditor(shift: Boolean) {
        val web = binding.editorWeb
        // v1.88：仅在 WebView 确实没焦点时才申请焦点。旧版无条件 requestFocus() 会
        // 触发软键盘弹出/收起与布局剧变（真机日志可见 IME 反复 true/false），键盘动画
        // 期间 Vditor 正在处理 Tab 易导致结构错乱与光标异常；编辑中本来就已聚焦，无需再抢。
        if (!web.hasFocus()) web.requestFocus()
        val meta = if (shift) KeyEvent.META_SHIFT_ON else 0
        val now = SystemClock.uptimeMillis()
        web.dispatchKeyEvent(
            KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_TAB, 0, meta)
        )
        web.dispatchKeyEvent(
            KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_TAB, 0, meta)
        )
    }

    /**
     * v1.88：Tab 派发排队，两次之间至少隔 TAB_GAP_MS。
     * 旧版 drainJsEvents 是把队列里的 indentTab 在**同一轮 for 循环里连续派发**——
     * 用户连点 3 下就会在同一毫秒收到 3 个 Tab，Vditor 还在处理上一次的重渲染就被下一次打断，
     * 真机上表现为结构错乱（待办框异常增多/渲染卡顿）。现在改成串行排队、给足消化时间；
     * 堆积上限 ±3，避免连点十几下后 Tab 还在后台持续乱飞。
     */
    private val tabHandler = Handler(Looper.getMainLooper())
    private var tabPending = 0          // >0 待缩进次数，<0 待减缩进次数
    private var tabDraining = false

    private fun requestTab(shift: Boolean) {
        tabPending += if (shift) -1 else 1
        if (tabPending > 3) tabPending = 3
        if (tabPending < -3) tabPending = -3
        if (!tabDraining) drainTabQueue()
    }

    private fun drainTabQueue() {
        if (tabPending == 0) { tabDraining = false; return }
        tabDraining = true
        val shift = tabPending < 0
        dispatchTabToEditor(shift)
        tabPending += if (shift) 1 else -1
        tabHandler.postDelayed({ drainTabQueue() }, TAB_GAP_MS)
    }

    private fun onJsIndentTab() = requestTab(false)
    private fun onJsOutdentTab() = requestTab(true)

    // ---------- 生命周期 ----------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityEditBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 状态栏沉浸：白顶栏顶到状态栏后面，标题不被遮挡
        applyImmersiveStatusBar(binding.toolbar)

        noteId = intent.getLongExtra(EXTRA_ID, MainActivity.NEW_NOTE)
        NoteRepository.find(this, noteId)?.let {
            currentContent = it.content
            noteFontSize = it.fontSize
            // 便签自带的图片先装进内存，供 WebView 拦截请求和保存使用
            noteImages.clear()
            noteImages.putAll(it.imageMap())
            publishImages()
        }

        binding.toolbar.setNavigationIcon(R.drawable.ic_back)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.toolbar.inflateMenu(R.menu.edit_menu)
        binding.toolbar.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.action_toggle_render -> { toggleRenderMode(); true }
                R.id.action_undo -> { undoEdit(); true }
                R.id.action_redo -> { redoEdit(); true }
                R.id.action_font -> { showFontSizeDialog(); true }
                R.id.action_delete -> { delete(); true }
                else -> false
            }
        }

        // 新建笔记：页面就绪后直接进编辑态（已有笔记进预览，点正文才编辑）
        pendingAutoEdit = (noteId == MainActivity.NEW_NOTE)

        initWebView()
        setupKeyboardBar()
        setupHistory()
        setupBackHandler()
        // v1.36：格式化改由 Vditor 自带工具栏负责，隐藏原生格式栏避免重复。
        // v1.43：原生键盘辅助栏（含收起键盘键）整体移除——Web 工具栏随键盘
        // 显隐后它成了纯多余物；收起键盘交给系统返回手势。
        // 生命周期驱动的轮询（键盘检测 + JS 状态下行校准），onPause 停
        imePollTask.run()
    }

    override fun onResume() {
        super.onResume()
        // 从设置页改完全局字号/字体/主题回来，这里立即生效
        applyTheme()
        // v1.57：从设置页改完工具栏自定义回来，配置变化则重建工具栏生效
        pushToolbarConfig()
        // 从设置页改完调试日志开关回来，立即生效显隐
        binding.debugOverlay.visibility =
            if (DebugPref.enabled(this)) View.VISIBLE else View.GONE
        // 对话框/外跳期间压下的"键盘收起退预览"在这里解除
        suppressExitEdit = false
        // 从设置页返回后重启轮询（onPause 会停掉），否则 jsEditing 校准断流
        if (editorReady && !isFinishing) {
            imePollHandler.removeCallbacks(imePollTask)
            imePollTask.run()
        }
    }

    /** 已执行删除：onPause 别再把输入框里的内容存回来，否则墓碑会被 upsert 覆盖 */
    private var deleted = false

    /** 离开页面就保存，不用手动点保存 */
    override fun onPause() {
        imePollHandler.removeCallbacks(imePollTask)   // 页面不可见，停轮询
        // 把还没落栈的输入补上，免得刚打的字撤不回来
        commitSnapshot()
        if (!deleted) {
            save()
            // 双保险：JS 侧编辑中的块在 visibilitychange 已即时上报；
            // 这里再从 WebView 拉一次最终内容，有变化就再落一遍盘
            if (editorReady) {
                binding.editorWeb.evaluateJavascript("editor.getSource()") { s ->
                    val text = try {
                        if (s == null) null else JSONTokener(s).nextValue() as? String
                    } catch (e: Exception) {
                        null
                    } ?: return@evaluateJavascript
                    if (text != currentContent) {
                        currentContent = text
                        if (!deleted) save()
                    }
                }
            }
        }
        super.onPause()
    }

    override fun onDestroy() {
        imePollHandler.removeCallbacks(imePollTask)
        // WebView 脱离窗口树再销毁，避免持有 Activity 泄漏
        binding.editorWeb.destroy()
        super.onDestroy()
    }

    // ---------- WebView 编辑器 ----------

    private fun initWebView() {
        val wv = binding.editorWeb
        wv.settings.javaScriptEnabled = true
        // v1.37：file:// 访问全放行。Vditor 运行时仍可能按需加载残余资源
        // （highlight 等）走 file:// 的 XHR/脚本；API 30+ 默认拦截 file 子资源，
        // 一旦被拦 Vditor 内部 Promise 直接 reject，初始化链静默断掉（after 不触发）。
        // lute 等核心资源虽已内联进 editor.html，这里兜底保证任何 file 请求不失败。
        wv.settings.allowFileAccess = true
        wv.settings.allowFileAccessFromFileURLs = true
        wv.settings.allowUniversalAccessFromFileURLs = true
        wv.settings.domStorageEnabled = true
        // 系统字体缩放（textZoom）会让 CSS px 和 WebView 内排版二次放大，钉死 100
        wv.settings.textZoom = 100
        if (Build.VERSION.SDK_INT in 29..32) {
            // 29-32 的"强制深色"会把 WebView 整页反色砸掉 CSS 主题，关掉；
            // 暗色模式由 applyTheme 的 CSS 变量接管（33+ 系统已移除该机制）
            @Suppress("DEPRECATION")
            wv.settings.forceDark = WebSettings.FORCE_DARK_OFF
        }
        wv.addJavascriptInterface(EditorBridge(this), "Android")

        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                val first = !editorReady
                editorReady = true
                if (first) {
                    // v1.57：先注入工具栏自定义配置，再 loadMarkdown —— mount 时
                    // buildToolbar 直接读全局配置，避免首屏用默认后又重建一次
                    pushToolbarConfig()
                    view.evaluateJavascript(
                        "editor.loadMarkdown(${JSONObject.quote(currentContent)}, 0, false)", null
                    )
                    applyTheme()
                }
                // v1.51 修"工具栏时有时无"：原先推的是缓存态 lastImeVisible，而
                // updateKeyboardBar 只在 ime 状态"变化边沿"才补推。若键盘在页面就绪
                // 前后已处于稳态（弹起后一直弹 / 收起后一直收），边沿不触发 → 唯一一次
                // 推送用的是可能过期的缓存值，工具栏就卡在错态（有时出现有时不出现）。
                // 这里改为推送"实时"键盘态，并把 lastImeVisible 对齐到实时值，使后续
                // 边沿判定能正常工作；再在布局落定后二次校验，兜住键盘动画晚于页面
                // 就绪到达的时序（此时 insets 还没派发，实时查询也会误判）。
                val live = liveImeVisible()
                lastImeVisible = live
                js("editor.onIme($live, ${live && isFloatingIme()})")
                view.postDelayed({ if (!isFinishing) updateKeyboardBar() }, 200)
                view.postDelayed({ if (!isFinishing) updateKeyboardBar() }, 500)
                if (pendingAutoEdit) {
                    pendingAutoEdit = false
                    view.evaluateJavascript("editor.enterEditAt(${currentContent.length})", null)
                    // 非用户手势的 JS focus 不一定唤得起 IME，Kotlin 侧补一刀
                    view.postDelayed({
                        if (!isFinishing) {
                            getSystemService(InputMethodManager::class.java)
                                ?.showSoftInput(binding.editorWeb, InputMethodManager.SHOW_IMPLICIT)
                        }
                    }, 120)
                }
            }

            /**
             * 图片供流：JS 把 img://key 翻译成 https://mdnotes.local/img/<key>，
             * 这里拦下来从 noteImages 解码返回 —— Base64 永不进 JS 字符串
             * （evaluateJavascript 传大字符串会卡主线程），也不会有加载闪烁。
             * 注意：本回调在 IO 线程，只读 volatile 快照 + 解码缓存。
             */
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val uri = request.url
                // v1.52 修深色模式进入便签闪白：在文档首屏解析前，把按当前昼夜算好的
                // 主题变量以一段内联 <style> 注入 editor.html 的 <head> 最前，Vditor 挂载
                // 与首屏绘制直接拿深色背景/前景，不再「先浅后深」。仅拦截主文档本身。
                if (uri.scheme == "file" && uri.lastPathSegment == "editor.html") {
                    return try {
                        val raw = view.context.assets.open("editor/editor.html")
                            .bufferedReader(Charsets.UTF_8).use { it.readText() }
                        val html = raw.replaceFirst("<head>", "<head>\n$bootstrapThemeCss\n")
                        val bytes = html.toByteArray(Charsets.UTF_8)
                        WebResourceResponse(
                            "text/html", "utf-8", 200, "OK",
                            mapOf("Access-Control-Allow-Origin" to "*"),
                            ByteArrayInputStream(bytes)
                        )
                    } catch (e: Exception) {
                        null   // 兜底：注入失败就退化成默认加载（浅色默认，仅失去防闪）
                    }
                }
                if (uri.host != "mdnotes.local") return null
                val key = uri.lastPathSegment ?: return imageNotFound()
                val bytes = imageBytes(key) ?: return imageNotFound()
                return WebResourceResponse(
                    "image/jpeg", "1.0", 200, "OK",
                    mapOf("Access-Control-Allow-Origin" to "*"),
                    ByteArrayInputStream(bytes)
                )
            }
        }
        // v1.52 修深色模式进入便签闪白：按当前昼夜算好首屏主题（注入 <head> 前生效），
        // 并把 WebView 表面底色设成页面色，挡住文档解析前那一瞬的白底窗口。
        bootstrapThemeCss = buildBootstrapThemeCss()
        wv.setBackgroundColor(ContextCompat.getColor(this, R.color.bg_page))
        wv.loadUrl("file:///android_asset/editor/editor.html")
    }

    /** evaluateJavascript 的统一门闩：页面没就绪时静默丢弃（onPageFinished 会补做） */
    private fun js(script: String) {
        if (editorReady) binding.editorWeb.evaluateJavascript(script, null)
    }

    private fun publishImages() {
        noteImagesSnapshot = LinkedHashMap(noteImages)
    }

    private fun imageBytes(key: String): ByteArray? {
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

    // ---------- 桥回调（EditorBridge post 回主线程后调用） ----------

    /** JS 上报全文 + 光标：更新镜像内容，并立即记一步撤销快照（词级合并在 commitSnapshot 内） */
    fun onJsContentChanged(text: String, caret: Int) {
        currentContent = text
        lastCaret = caret
        // 每次改动都记，靠 commitSnapshot 里的「同词合并」把连续打字压成词级粒度，
        // 避免整段输入被压成一个撤销点、一撤到底。回放历史时 JS 的回传不记。
        if (!applyingHistory) commitSnapshot()
    }

    /** 进入/退出编辑态：驱动辅助栏显隐与返回键行为 */
    fun onJsEditModeChanged(editing: Boolean) {
        jsEditing = editing
        if (editing) {
            editingSince = SystemClock.elapsedRealtime()
            // 统一 IME 补刀（v1.35.10）：点击进入编辑时，JS 的 el.focus() 不在
            // 用户手势栈内，经常唤不起软键盘 → imeVisible=false → 辅助栏不出、
            // 也打不了字。新建笔记路径原本就有补刀，这里覆盖所有进入编辑的路径。
            // 延迟 200ms：先等 WebView 的原生唤起，已弹起就不重复请求。
            binding.editorWeb.postDelayed({
                if (isFinishing || !jsEditing) return@postDelayed
                val ri = ViewCompat.getRootWindowInsets(binding.root)
                val imeUp = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
                if (!imeUp) {
                    getSystemService(InputMethodManager::class.java)
                        ?.showSoftInput(binding.editorWeb, InputMethodManager.SHOW_IMPLICIT)
                }
            }, 200)
        }
        updateHistoryMenu()
        // 轮询是 jsEditing / 键盘状态的唯一可靠来源（本机 JS→Kotlin 桥已死，
        // 上行桥与调试浮层都靠它下行校准）。绝不能因退出编辑而停 —— 否则轮询
        // 一旦停掉，后续再点进编辑态 jsEditing 永远 false，工具栏再不出现
        // （「只有首次编辑能唤醒工具栏」的根因）。持续运行：onCreate/onResume
        // 启动、onPause 停止，编辑态切换期间保持轮转。
        if (!isFinishing) {
            imePollHandler.removeCallbacks(imePollTask)
            imePollTask.run()
        }
        updateKeyboardBar()
    }

    fun onJsCopyCode(code: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("md-code", code))
        toast("代码已复制")
    }

    fun onJsOpenUrl(url: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        suppressExitEdit = true   // 外跳浏览器会触发 onPause + 键盘收起，别误退编辑态
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            toast("打不开这个链接")
        }
    }

    fun onJsViewImage(key: String) {
        lifecycleScope.launch {
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
                suppressExitEdit = true   // 全屏看图返回后别被"键盘收起"误退编辑态
                ImageViewActivity.show(this@EditActivity, bmp)
            }
        }
    }

    /** v1.58：工具栏「图片」按钮经事件队列请求 → 打开系统相册选图（仅图片）。
     *  选完走既有 importImage 流程：压缩→Base64→存 noteImages→光标处插 img:// 引用。 */
    fun onJsPickImage() {
        runOnUiThread {
            pickImage.launch(
                androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        }
    }

    // ---------- 键盘联动 ----------

    /**
     * 键盘检测（v1.43 起原生辅助栏已移除，只服务两件事）：
     *
     * 1. 自动回预览：键盘收起（返回键/其他任何原因）且处于编辑态时，
     *    防抖 IME_SETTLE_MS 后确认 —— 等动画逐帧回落结束，期间键盘复现则取消；
     * 2. 防误判三件套：宽限期（刚进编辑态键盘还没弹出）、suppressExitEdit
     *    （对话框/外跳/选图）、编辑态判据用 JS 的真实状态（jsEditing）。
     */
    private fun setupKeyboardBar() {
        // 通道一（Android 11+，含 Android 15+ 强制 edge-to-edge 的机型）：
        // ime insets 是唯一可靠信号 —— e2e 下窗口不随键盘缩放，高度差恒为零。
        // root 与 editorWeb 各挂一份（幂等写缓存），防单点分发缺失
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { _, insets ->
            insetsCalls++
            val imeVis = insets.isVisible(WindowInsetsCompat.Type.ime())
            val imeBot = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            insetsImeVisible = imeVis
            insetsImeBottom = imeBot
            insetsNavBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
            insetsUpdatedAt = SystemClock.elapsedRealtime()
            onImeDispatch(imeVis, imeBot)   // v1.60：悬浮键盘边沿判定
            updateKeyboardBar()
            insets
        }
        ViewCompat.setOnApplyWindowInsetsListener(binding.editorWeb) { _, insets ->
            insetsCalls++
            val imeVis = insets.isVisible(WindowInsetsCompat.Type.ime())
            val imeBot = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            insetsImeVisible = imeVis
            insetsImeBottom = imeBot
            insetsNavBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
            insetsUpdatedAt = SystemClock.elapsedRealtime()
            onImeDispatch(imeVis, imeBot)   // v1.60：悬浮键盘边沿判定
            updateKeyboardBar()
            insets
        }
        // 通道二（Android 10- 兜底）：adjustResize 下键盘弹出必然引起根布局变化
        binding.root.viewTreeObserver.addOnGlobalLayoutListener { updateKeyboardBar() }
        // 调试浮层：受设置项「调试日志」控制（默认关闭）。
        // 出问题想看内部状态时，打开设置里的开关即可；不再绑 BuildConfig.DEBUG，
        // release 包一样能看到，方便真机排障。
        binding.debugOverlay.visibility =
            if (DebugPref.enabled(this)) View.VISIBLE else View.GONE
        binding.debugOverlay.setOnClickListener { shareInsetLog() }   // v1.66：点浮窗一键分享日志
        updateKeyboardBar()
    }

    /**
     * 键盘状态与自动退预览判定（v1.64 起职责收窄）：
     *
     * 1. 垫底 padding：键盘态垫键盘高度、非键盘态垫导航栏高度；
     * 2. 自动回预览：仅在「本会话见过普通键盘实证（bottom>0）」的编辑会话里，
     *    键盘收起（防抖 IME_SETTLE_MS，期间复现则取消）→ 退出编辑回预览；
     * 3. onIme 推送：只给 JS 承载「键盘占窗口高度」证据 —— 工具栏显隐已改由
     *    JS 编辑态驱动（悬浮键盘 insets 零证据，v1.60~v1.63 四连败的根因）。
     * 4. 防误判：宽限期（刚进编辑态键盘还没弹出）、suppressExitEdit
     *    （对话框/外跳/选图）、编辑态判据用 JS 的真实状态（jsEditing）。
     */
    private fun updateKeyboardBar() {
        val root = binding.root
        // 退编辑态：清悬浮闩锁与会话证据（下次编辑重新取证）
        if (!jsEditing) {
            floatingIme = false
            sawImeUp = false
        }
        val ri = ViewCompat.getRootWindowInsets(root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0

        // 合并：主动查询与分发缓存。v1.53 修「预览态工具栏时有时无」：主动查询是
        // 实时系统读数，最可信；查询说无而分发缓存说有时，缓存可能是 ROM 残留的
        // 过期帧（MIUI 键盘收起后 insets 缓存不清零），必须有可见区高度差佐证才
        // 采信 —— 否则预览态被误判为"键盘在"，padding 凭空垫高。
        val byQuery = qVisible && qBottom > 0
        // v1.55：分发缓存加时效 —— 键盘收起后部分 ROM（MIUI）不再派发 insets 回调，
        // 缓存里留着"键盘在"的过期帧永不刷新；超过 30s 无刷新的缓存不再采信
        //（正常交互中键盘弹出/收起必伴随新的 insets 分发，30s 足够宽裕）。
        val byCache = insetsImeVisible && insetsImeBottom > 0 &&
            SystemClock.elapsedRealtime() - insetsUpdatedAt < 30_000
        val imeByInsets = when {
            byQuery -> true
            byCache && !qVisible -> imeCacheCorroborated(root)
            else -> false
        }
        val imeBottomFromInsets = if (byQuery) qBottom else insetsImeBottom
        // v1.60：悬浮键盘 ime 可见但不占窗口高度 → 闩锁纳入（只影响 floating
        // 标志与"不垫高度"：悬浮键盘垫了 padding 屏幕底部会凭空空一块）。
        // v1.67：伪帧压制成 —— 闩锁在场时 v=0 b=0 伪帧不再把 imeVisible 翻 false
        //（日志实锤：伪帧触发 250ms 退预览 = 「时而隐藏」根因；imeVisible 抖动
        // 还会造成 onIme 推送边沿抖动）。
        var imeVisible = imeByInsets || floatingIme
        // v1.67：悬浮在场（闩锁）一律垫 0 —— 实测悬浮帧 b=2（不是 0），垫 2px
        // 会让 imeBottom 在 2↔0 之间抖、floating 标志跟着在 false↔true 抖，
        // 工具栏定位在「入流↔钉顶」之间横跳。
        var imeBottom = if (imeByInsets && !floatingIme) imeBottomFromInsets else 0
        if (!imeByInsets && !floatingIme) {   // insets 双源都不可信、且非悬浮键盘时才看高度差
            val r = Rect()
            root.getWindowVisibleDisplayFrame(r)
            val rootH = root.rootView.height
            if (rootH == 0 || r.height() == 0) return   // 布局未就绪/异常帧
            val diff = (rootH - r.height()).coerceAtLeast(0)
            imeVisible = diff > rootH / 4
            imeBottom = if (imeVisible) (rootH - r.bottom).coerceAtLeast(0) else 0
        }
        // v1.64/v1.67：普通键盘实证（占窗口高度）—— 自动退预览的会话资格证。
        // 判据从 imeBottom>0 收紧为 imeBottom > 屏高/4：日志实锤悬浮帧 b=2 也
        // 会中「>0」，导致悬浮会话误获退预览资格、伪帧一来就被退回预览。
        // 真普通键盘 b=794（rootH=2400），稳过；悬浮 b=2、导航栏装饰 diff≈105，稳不过。
        if (jsEditing && imeVisible && imeBottom > root.rootView.height / 4) sawImeUp = true

        // e2e 下内容延伸到导航栏后面：非键盘态垫导航栏高度，键盘态垫键盘高度
        root.updatePadding(bottom = if (imeVisible) imeBottom else insetsNavBottom)

        // v1.64/v1.67：floating 定位标志 = 键盘在但不占窗口高度（悬浮键盘）。
        // v1.67：悬浮在场时 imeBottom 恒 0（上面已垫 0），此标志稳定为 true，
        // 工具栏稳定钉屏顶；伪帧被闩锁压制，不再产生 (false,·) 推送边沿。
        val floating = imeVisible && imeBottom == 0
        if (imeVisible != lastImeVisible || floating != lastFloatingPushed) {
            lastImeVisible = imeVisible
            lastFloatingPushed = floating
            lastImePushAt = SystemClock.elapsedRealtime()
            // v1.64：推送只承载证据（JS 显隐由编辑态驱动）。(true,false)=普通
            // 键盘占高实证 → JS 工具栏立即入流；其余组合不影响 JS 显隐。
            js("editor.onIme($imeVisible, $floating)")
            // 自动退预览：只在有普通键盘实证的会话生效（sawImeUp）。悬浮键盘
            // 会话恒无实证：其 (false,0) 帧与真收起不可区分，宁可不退（返回键
            // 两段式收尾），也不能在打字时把用户误退回预览。
            if (!imeVisible && jsEditing && sawImeUp && !suppressExitEdit && editorReady &&
                SystemClock.elapsedRealtime() - editingSince > EDIT_GRACE_MS
            ) {
                imeExitHandler.removeCallbacks(imeExitTask)
                imeExitHandler.postDelayed(imeExitTask, IME_SETTLE_MS)
            } else {
                imeExitHandler.removeCallbacks(imeExitTask)
            }
        } else if (!imeVisible && editorReady &&
            SystemClock.elapsedRealtime() - lastImePushAt > 1500
        ) {
            // 收起态保活重推（幂等）。v1.64 起 JS 显隐已解耦，此推送仅兜底触发
            // 一次 apply / 菜单重扫。
            lastImePushAt = SystemClock.elapsedRealtime()
            js("editor.onIme(false, false)")
        }
        // v1.66 详细日志：每轮把完整状态落盘（随调试开关），手动测时序列一目了然
        val rl = Rect(); binding.root.getWindowVisibleDisplayFrame(rl)
        val rH = binding.root.rootView.height
        appendInsetLog(
            "BAR q=$qVisible/$qBottom disp=${insetsImeVisible}/${insetsImeBottom} nav=$insetsNavBottom " +
            "rootH=$rH visH=${rl.height()} diff=${rH - rl.height()} edit=$jsEditing saw=$sawImeUp " +
            "float=$floating imeVis=$imeVisible →onIme($imeVisible,$floating)"
        )
        updateDebugOverlay(ri, qVisible, qBottom)
    }

    /**
     * v1.51：实时键盘态查询（与 updateKeyboardBar 同源），供 onPageFinished 在页面
     * 就绪时推送权威态——不依赖 updateKeyboardBar 的"变化边沿"门闩，避免键盘处于
     * 稳态时工具栏卡在过期缓存态。只读实时读数，不触发 padding/推送等副作用。
     * v1.53：合并判定改为主动查询优先，过期分发缓存需高度差佐证（同 updateKeyboardBar）。
     */
    private fun liveImeVisible(): Boolean {
        val root = binding.root
        val ri = ViewCompat.getRootWindowInsets(root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        logRaw("Q", qVisible, qBottom)    // v1.65：记录页面就绪实时查询帧
        if (qVisible && qBottom > 0) return true
        // v1.60：qVisible 但 bottom==0 = 悬浮键盘（键盘确实在，只是不占窗口高度）。
        // 原逻辑在此直接 return false，把悬浮键盘误杀 —— 页面就绪补推也报"无键盘"。
        if (qVisible) return isFloatingIme()
        // v1.55：缓存时效同 updateKeyboardBar —— ROM 不再分发后旧缓存不可信
        if (insetsImeVisible && insetsImeBottom > 0 &&
            SystemClock.elapsedRealtime() - insetsUpdatedAt < 30_000 &&
            imeCacheCorroborated(root)
        ) return true
        val r = Rect()
        root.getWindowVisibleDisplayFrame(r)
        val rootH = root.rootView.height
        if (rootH == 0 || r.height() == 0) return false
        // v1.62：悬浮闩锁在场 = 最近分发证明键盘悬浮在场 —— 必须与
        // updateKeyboardBar 同源。此前 liveImeVisible 不认闩锁（查询 false +
        // 缓存 bottom=0 + 无高差全落空）→ onPageFinished 补推 onIme(false)
        // 把刚显示的工具栏收掉。v1.64：只影响推送标志，不再影响显隐。
        if (floatingIme) return true
        return (rootH - r.height()).coerceAtLeast(0) > rootH / 4
    }

    /**
     * v1.53：分发缓存说键盘在、实时查询说不在 —— 用可见区高度差佐证缓存是否可信。
     * 键盘真实弹出时可见区必然大幅缩水（> 1/8 屏高）；残留的过期缓存帧没有高度差
     * 佐证（e2e 模式下窗口不随键盘缩放，而键盘收起后缓存未清），判不可信。
     */
    private fun imeCacheCorroborated(root: View): Boolean {
        val r = Rect()
        root.getWindowVisibleDisplayFrame(r)
        val rootH = root.rootView.height
        if (rootH == 0 || r.height() == 0) return false
        return (rootH - r.height()) > rootH / 8
    }

    /**
     * v1.61：insets 分发 → 维护悬浮键盘闩锁。
     * 每次分发都刷新（visible && bottom==0），不再要求「不可见→可见」边沿：
     * 编辑中把普通键盘原地切成悬浮时 IME 重启，中间不一定有不可见帧，只认边沿会漏。
     * v1.64：闩锁降级为定位参考信号（推送 floating 标志 / 不垫 padding），
     * 不再参与工具栏显隐与自动退预览。
     */
    /**
     * v1.65 原始 insets 帧采集：记一条 (来源, 可见, 底高) 到环形缓冲。
     * 连续同值帧去重 —— 我们只关心状态如何变迁（弹起/收起序列），重复帧无信息量。
     * 来源约定：D = onApplyWindowInsets 分发回调；Q = onPageFinished 实时查询。
     */
    private fun logRaw(tag: String, v: Boolean, b: Int) {
        val key = "$tag:$v:$b"
        if (key == lastRawKey) return
        lastRawKey = key
        val t = SystemClock.elapsedRealtime()
        val sec = (t / 1000) % 100000
        val ms = (t % 1000) / 100
        insetsRawLog.addLast("${sec}.${ms}s $tag v=${if (v) 1 else 0} b=$b")
        while (insetsRawLog.size > 14) insetsRawLog.removeFirst()
        appendInsetLog("$tag v=${if (v) 1 else 0} b=$b")   // v1.66：变化帧同时落盘
    }

    /**
     * v1.61：insets 分发 → 维护悬浮键盘闩锁。
     * v1.67（v1.66 日志实锤）改两条：
     * 1. 悬浮判定 bottom==0 → bottom < FLOAT_IME_MAX_PX：这台设备悬浮在场报
     *    v=1 b=2，==0 判定永不成立；
     * 2. v=0 帧不再翻转闩锁：日志实测悬浮键盘在场时 ROM 周期性发 v=0 b=0 伪帧
     *    （12:55:56.254 → 1s 后自动退预览 = 用户「时而隐藏」的直接根因），伪帧
     *    与真收起在系统层面不可区分 → 闩锁只由「普通键盘帧（b 大）」清除，v=0
     *    一律忽略。悬浮真收起后工具栏留屏顶（既定取舍），退编辑由返回键两段式；
     *    普通键盘会话 floatingIme 本就为 false，收起判定不受影响。
     */
    private fun onImeDispatch(visible: Boolean, bottom: Int) {
        logRaw("D", visible, bottom)      // v1.65：记录每次真实分发帧
        if (!visible) return              // v1.67：伪帧/真收起帧均不翻闩锁
        floatingIme = bottom < FLOAT_IME_MAX_PX
    }

    /**
     * v1.61：当前是否处于悬浮键盘态（ime 可见但不占窗口高度）。
     * 闩锁（onImeDispatch 维护）为主，实时查询为辅 —— 两者取或。
     *
     * v1.60 的教训：当时要求「查询先说可见」才肯看闩锁，结果这台 ROM 的实时查询
     * 对悬浮键盘返回 false，闩锁被一句 return false 短路。而调试浮层在文档流里
     * 占高度、每次 setText 都触发重布局 → insets 反复重分发 → 查询被"保鲜"
     * （visible=true/bottom=0），于是调试开着就正常、关了就失灵 —— 用户实测
     * 正是这样。闩锁是分发事件驱动的，不会过期，必须独立生效。
     *
     * v1.64：本函数只服务推送 floating 标志与调试浮层，不再影响工具栏显隐
     * （显隐已改由 JS 编辑态驱动，见 editor-vditor.js v1.64 注释）。
     * 悬浮键盘不占窗口空间 → 不垫 padding，否则屏幕底部凭空留出一块空白。
     */
    private fun isFloatingIme(): Boolean {
        val ri = ViewCompat.getRootWindowInsets(binding.root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        if (qVisible && qBottom < FLOAT_IME_MAX_PX) {
            floatingIme = true   // 查询证实 → 顺带保鲜闩锁（v1.67：b=2 实测）
        }
        return floatingIme
    }

    /** debug 构建的内部状态浮层：三通道读数 + 最终判定，真机证据直接看屏 */
    private fun updateDebugOverlay(ri: WindowInsetsCompat?, qVisible: Boolean, qBottom: Int) {
        if (binding.debugOverlay.visibility != View.VISIBLE) return
        val r = Rect()
        binding.root.getWindowVisibleDisplayFrame(r)
        val rootH = binding.root.rootView.height
        val ua = binding.editorWeb.settings.userAgentString
        val chromeVer = Regex("Chrome/(\\d+)").find(ua)?.groupValues?.get(1) ?: "?"
        @Suppress("DEPRECATION")
        val verName = packageManager.getPackageInfo(packageName, 0).versionName
        binding.debugOverlay.text = buildString {
            append("v").append(verName)
            append("  insetsCalls=").append(insetsCalls).append('\n')
            append("分发: ime=").append(insetsImeVisible).append('/').append(insetsImeBottom)
            append("  nav=").append(insetsNavBottom).append('\n')
            append("查询: ime=").append(qVisible).append('/').append(qBottom)
            .append("  ri=").append(ri != null).append('\n')
            append("高差: rootH=").append(rootH).append(" visH=").append(r.height())
            .append(" diff=").append(rootH - r.height())
            .append(" visBottom=").append(r.bottom).append('\n')
            append("判定: imeVisible=").append(lastImeVisible)
            .append(" 悬浮=").append(isFloatingIme())
            .append(" 键上=").append(sawImeUp)   // v1.64：本会话有普通键盘实证（自动退预览资格）
            .append(" jsEditing=").append(jsEditing)
            .append(" ready=").append(editorReady)
            .append(" suppress=").append(suppressExitEdit).append('\n')
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
            // 悬浮键盘下打开调试、截一张图发我 —— 直接看 ROM 到底发了什么帧
            append("原始序列(D=分发 Q=查询):\n")
            if (insetsRawLog.isEmpty()) append("  (无)")
            else insetsRawLog.forEach { append("  ").append(it).append('\n') }
        }
    }

    /**
     * 返回键：编辑态先退回预览（提交当前块），预览态才真正离开页面 ——
     * 与小米便签一致的两段式返回。
     */
    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (jsEditing && editorReady) {
                    binding.editorWeb.evaluateJavascript("editor.exitEditMode()", null)
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    // ---------- 保存 / 删除 ----------

    private fun save() {
        val content = currentContent
        if (content.isBlank()) return   // 空便签不存

        // 正文里不再引用的图直接丢掉，别让删了图的旧数据一直占着 json
        val used = IMG_REF.findAll(content).map { it.groupValues[2] }.toSet()
        noteImages.keys.retainAll(used)
        publishImages()

        // 既有的便签：直接取出仓库里那条对象就地改内容字段——pinned 等元数据自然保留，
        // 不会被 upsert 的"删旧加新"冲掉（之前每次退出编辑都重建 Note、pinned 默认
        // false，导致置顶一进编辑页就丢）；只有真正的新便签才新建。
        val note = NoteRepository.find(this, noteId)?.apply {
            title = extractTitle(content)          // 标题从第一个 H1 自动提取
            this.content = content
            updatedAt = System.currentTimeMillis()
            images = if (noteImages.isEmpty()) null else LinkedHashMap(noteImages)
            fontSize = noteFontSize
        } ?: Note(
            id = System.currentTimeMillis(),
            title = extractTitle(content),
            content = content,
            updatedAt = System.currentTimeMillis(),
            images = if (noteImages.isEmpty()) null else LinkedHashMap(noteImages),
            fontSize = noteFontSize
        )
        NoteRepository.upsert(this, note)
        noteId = note.id
    }

    /** 删除前确认：防手滑——软删除虽然留了墓碑，但用户侧没有回收站，删了就是没了 */
    private fun delete() {
        if (noteId == MainActivity.NEW_NOTE) {
            // 还没落盘的新便签：没有可删的记录，丢弃内容直接退出
            deleted = true
            finish()
            return
        }
        suppressExitEdit = true   // 对话框期间键盘收起，别把编辑态误退了
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.delete_confirm_title)
            .setMessage(R.string.delete_note_msg)
            .setPositiveButton(R.string.action_delete) { _, _ -> doDelete() }
            .setNegativeButton(R.string.action_cancel, null)
            .setOnDismissListener { suppressExitEdit = false }
            .show()
    }

    private fun doDelete() {
        deleted = true   // 必须先置位：finish() 触发的 onPause 不能再回写内容
        NoteRepository.softDelete(this, noteId)
        toast("已删除")
        finish()
    }

    // ---------- 撤回 / 前进 ----------

    /** 挂上历史基线（打开时的内容记成第一个状态） */
    private fun setupHistory() {
        undoStack.clear()
        redoStack.clear()
        undoStack.addLast(currentSnapshot())
        updateHistoryMenu()
    }

    private fun currentSnapshot(): Snapshot {
        val caret = lastCaret.coerceIn(0, currentContent.length)
        return Snapshot(currentContent, caret, caret)
    }

    /**
     * 把当前状态记进历史栈。正文没变就跳过；同一词内连续打字/退格合并成同一个
     * 撤销点（原地更新栈顶），遇到空格/换行/粘贴等结构性改动则另起一步，这样整段
     * 输入不会被压成一个点、一撤到底。栈底基线永远保留、不会被覆盖。
     */
    private fun commitSnapshot() {
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
    private fun undoEdit() {
        commitSnapshot()   // 先把还在缓冲区里的输入补上，否则刚打的字撤不回来
        if (undoStack.size < 2) return
        redoStack.addLast(undoStack.removeLast())
        applySnapshot(undoStack.last())
    }

    /** 前进：回到被撤回的那一步 */
    private fun redoEdit() {
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
        currentContent = snap.text
        js(
            "editor.loadMarkdown(${JSONObject.quote(snap.text)}, ${snap.selStart}, true)"
        )
        historyHandler.postDelayed({ applyingHistory = false }, 500)
        updateHistoryMenu()
    }

    /** 有得撤/有得进时才把按钮点亮（预览态同样可用，和 Typora 一致） */
    private fun updateHistoryMenu() {
        binding.toolbar.menu.findItem(R.id.action_undo)?.isEnabled = undoStack.size >= 2
        binding.toolbar.menu.findItem(R.id.action_redo)?.isEnabled = redoStack.isNotEmpty()
    }

    // ---------- Markdown 快捷栏 ----------

    /** 顶栏眼睛按钮：false = 实时渲染（默认），true = 全文源码视图。图标随态切换 */
    private var sourceMode = false

    private fun toggleRenderMode() {
        sourceMode = !sourceMode
        js("editor.toggleSourceMode()")
        binding.toolbar.menu.findItem(R.id.action_toggle_render)?.setIcon(
            if (sourceMode) R.drawable.ic_eye_off else R.drawable.ic_eye
        )
    }

    /** 主题变量（昼夜色值由资源系统自动切换）：applyTheme 与首屏 bootstrap 共用，单一真源 */
    private fun themeVarMap(): Map<String, String> {
        val sp = (noteFontSize ?: Appearance.textSize(this)).toFloat()
        // v1.49 修字号偏大：原 fontPx = sp * scaledDensity 把 sp 当 dp 又乘了一次密度，
        // density≥2 的手机上正文被放 2~3 倍（如 16sp→48px）。本 App WebView 的
        // viewport=device-width 且 textZoom=100 → 1 CSS px == 1 dp，CSS 字号本就该
        // 直接等于 sp 数值，WebView 会自行按设备密度渲染成对应物理像素。
        val fontPx = sp.toInt()
        return mapOf(
            "bg-page" to colorHex(R.color.bg_page),
            "paper" to colorHex(R.color.bg_page),
            "text" to colorHex(R.color.text_main),
            "text-sub" to colorHex(R.color.text_sub),
            "brand" to colorHex(R.color.brand),
            "code-bg" to colorHex(R.color.search_bg),
            "table-border" to colorHex(R.color.edit_table_border),
            "font-px" to "${fontPx}px",
            "font-family" to cssFamily()
        )
    }

    /** 字号/字体/主题落地为 CSS 变量注入（昼夜色值由资源系统自动切换） */
    /** v1.57：工具栏自定义配置 → editor.setToolbarConfig 所需的 JSON
     *  {enabled:[type…], customs:[{id,label,text}…}]，字段名与 editor 侧 __toolbarCfg 对齐 */
    private fun toolbarConfigJson(): String {
        val cfg = ToolPrefs.load(this)
        val enabled = JSONArray().apply { cfg.enabledIds.forEach { put(it) } }
        val customs = JSONArray().apply {
            cfg.customs.forEach { c ->
                val o = JSONObject()
                o.put("id", c.id as Any)
                o.put("label", c.label as Any)
                o.put("text", c.text as Any)
                put(o)
            }
        }
        val root = JSONObject()
        root.put("enabled", enabled as Any)
        root.put("customs", customs as Any)
        return root.toString()
    }

    /** v1.57：注入工具栏自定义配置。仅在配置实际变化时才推送，避免每次 onResume
     *  都无谓重建 Vditor（重建会销毁实例、回填内容）。首屏 onPageFinished 也会调用。 */
    private var lastToolbarCfg: String? = null
    private fun pushToolbarConfig() {
        if (!editorReady) return
        val json = toolbarConfigJson()
        if (json == lastToolbarCfg) return
        lastToolbarCfg = json
        js("editor.setToolbarConfig($json)")
    }

    private fun applyTheme() {
        if (!editorReady) return   // 页面没就绪：onPageFinished 会补一次
        js("editor.applyTheme(${JSONObject(themeVarMap())})")
    }

    /**
     * v1.52 修深色模式进入便签闪白：editor.html 默认 --bg-page 浅色，applyTheme 在
     * onPageFinished（页面已渲染完）才注入深色变量 → 先浅后深闪一下。这里在文档首屏
     * 解析前就算好同源主题变量，拼成内联 <style> 由 shouldInterceptRequest 注入 <head>
     * 最前；Vditor 挂载与首屏绘制直接拿深色背景/前景，闪白消失。onPageFinished 的
     * applyTheme 仍保留（幂等，负责后续字号/主题切换），二者变量完全一致故无二次跳变。
     */
    private fun buildBootstrapThemeCss(): String {
        val root = themeVarMap().entries.joinToString(" ") { "--${it.key}:${it.value};" }
        return "<style id=\"mdnotes-theme-bootstrap\">:root{ $root }" +
            "html,body{background:var(--bg-page) !important;}" +
            ".vditor-reset{color:var(--text) !important;background:var(--paper) !important;}" +
            ".vditor-toolbar{background-color:var(--paper) !important;}" +
            ".vditor-hint{background-color:var(--paper) !important;}</style>"
    }

    private fun colorHex(res: Int): String =
        String.format("#%06X", 0xFFFFFF and ContextCompat.getColor(this, res))

    private fun cssFamily(): String = when (Appearance.family(this)) {
        "serif" -> "serif"
        "mono" -> "monospace"
        "light" -> "sans-serif-light"
        "medium" -> "sans-serif-medium"
        else -> "sans-serif"
    }

    /** 单便签字号：滑条实时预览，勾「跟随全局」即清掉本便签的独立值 */
    private fun showFontSizeDialog() {
        suppressExitEdit = true   // 对话框期间键盘收起，别把编辑态误退了
        val view = layoutInflater.inflate(R.layout.dialog_font_size, null)
        val spLabel = view.findViewById<TextView>(R.id.spLabel)
        val spSeek = view.findViewById<SeekBar>(R.id.spSeek)
        val chkFollow = view.findViewById<MaterialCheckBox>(R.id.chkFollow)

        val global = Appearance.textSize(this)
        chkFollow.isChecked = noteFontSize == null
        spSeek.max = Appearance.MAX_SP - Appearance.MIN_SP
        spSeek.progress = (noteFontSize ?: global) - Appearance.MIN_SP
        spLabel.text = if (noteFontSize == null) "跟随全局（$global sp）" else "${noteFontSize} sp"

        spSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                if (!fromUser) return
                if (chkFollow.isChecked) chkFollow.isChecked = false   // 动了滑条就脱离跟随
                val sp = p + Appearance.MIN_SP
                spLabel.text = "$sp sp"
                noteFontSize = sp
                applyTheme()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) = Unit
            override fun onStopTrackingTouch(sb: SeekBar?) = Unit
        })

        chkFollow.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                spSeek.progress = global - Appearance.MIN_SP
                spLabel.text = "跟随全局（$global sp）"
                noteFontSize = null
                applyTheme()
            }
        }

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.title_font_size)
            .setView(view)
            .setPositiveButton("完成", null)
            .setOnDismissListener { suppressExitEdit = false }
            .show()
    }

    // v1.43：原生键盘辅助栏（rebuildBarButtons / applyTool / 收起键盘键）随
    // activity_edit.xml 里的 mdKeyboardBar 一起移除——格式工具由 WebView 内
    // Vditor 工具栏负责（随键盘显隐），设置页的"工具栏自定义"入口也已隐藏。

    // ---------- 插入图片 ----------

    /** 相册选一张图：压缩 → Base64 → 存进 noteImages → JS 在光标处插入 img:// 引用 */
    private fun importImage(uri: Uri) {
        toast("正在处理图片…")
        lifecycleScope.launch {
            val encoded = withContext(Dispatchers.IO) { encodeImage(uri) }
            if (encoded == null) {
                toast("这张图读不出来，换一张试试")
                return@launch
            }
            val (key, base64, size) = encoded
            noteImages[key] = base64
            publishImages()
            js("editor.insertImage(${JSONObject.quote(key)})")
            toast("已插入图片（${(size + 1023) / 1024} KB）")
            // 选图回来键盘已收：插图后继续编辑，主动唤回键盘
            getSystemService(InputMethodManager::class.java)
                ?.showSoftInput(binding.editorWeb, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    /**
     * 读图 → 压到最长边 MAX_IMAGE_DIM → JPEG → Base64。
     * key 取压缩后内容的 SHA-256 前 16 位：同一张图插几次都只存一份。
     * 返回 (key, base64, 压缩后字节数)，失败返回 null。
     */
    private fun encodeImage(uri: Uri): Triple<String, String, Int>? {
        return try {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null

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
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
