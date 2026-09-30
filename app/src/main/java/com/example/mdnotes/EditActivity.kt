package com.example.mdnotes

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.widget.Toast
import com.example.mdnotes.databinding.ActivityEditBinding
import com.google.android.material.checkbox.MaterialCheckBox
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

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
 * 渲染与编辑循环全在 assets/editor/（Vditor IR 即时渲染内核 + editor-vditor.js 桥接层）。
 *
 * v1.99（Sprint 5，审查 #17）：本类收窄为「壳 + 路由」——生命周期、菜单、保存/删除、
 * JS 事件路由。全部编辑器职责已按 controller 拆分，修一个问题不再牵动整个编辑器：
 *
 * ```
 * EditActivity
 * ├── EditorState            共享可变状态（content/caret/editing/dirty…）
 * ├── EditorController       JS 通道、下行校准、主题/工具栏配置、渲染模式
 * ├── EditorImeController    键盘检测、悬浮闩锁、垫底 padding、自动回预览、轮询
 * ├── EditorImageController  内嵌图存储/供流/导入/看图
 * ├── EditorHistoryController 撤销/前进单一历史栈（Sprint 4 #82-7）
 * └── EditorDiagnostics      insets/桥诊断日志、调试浮层
 * ```
 */
class EditActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_ID = "id"
    }

    // 各 Controller 可访问（同模块 internal）：编辑器职责的宿主装配点
    internal lateinit var binding: ActivityEditBinding
    internal val state = EditorState()
    internal lateinit var editor: EditorController
    internal lateinit var ime: EditorImeController
    internal lateinit var image: EditorImageController
    internal lateinit var history: EditorHistoryController
    internal lateinit var diag: EditorDiagnostics

    private var noteId: Long = MainActivity.NEW_NOTE

    /** 已执行删除：onPause 别再把输入框里的内容存回来，否则墓碑会被 upsert 覆盖 */
    private var deleted = false

    /** 相册选图：PickVisualMedia 在各版本上都有系统选择器兜底，不用申请读相册权限 */
    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let { image.importImage(it) }
    }
    internal fun launchPickImage() {
        pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    // ---------- 生命周期 ----------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityEditBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Controller 装配（顺序：状态 → 诊断 → 各控制器；互相只持引用无副作用）
        diag = EditorDiagnostics(this)
        ime = EditorImeController(this, state, diag)
        image = EditorImageController(this, state)
        history = EditorHistoryController(this, state)
        editor = EditorController(this, state, diag)
        ime.setPollHook { editor.pollJsState() }

        // 状态栏沉浸：白顶栏顶到状态栏后面，标题不被遮挡
        applyImmersiveStatusBar(binding.toolbar)

        noteId = intent.getLongExtra(EXTRA_ID, MainActivity.NEW_NOTE)
        val existing = try {
            NoteRepository.find(this, noteId)
        } catch (e: CorruptStorageException) {
            toast("数据文件损坏，已恢复上次备份")
            null
        }
        if (existing == null && noteId != MainActivity.NEW_NOTE) {
            // 现有笔记读不出：回列表，别在空白页误存覆盖
            finish()
            return
        }
        existing?.let {
            state.content = it.content
            state.savedContent = it.content   // Sprint 4 #64：打开即视为已保存基线，初始不脏
            state.noteFontSize = it.fontSize
            // 便签自带的图片先装进内存，供 WebView 拦截请求和保存使用
            image.loadFrom(it)
        }

        binding.toolbar.setNavigationIcon(R.drawable.ic_back)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.toolbar.inflateMenu(R.menu.edit_menu)
        binding.toolbar.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.action_toggle_render -> { editor.toggleRenderMode(); true }
                R.id.action_undo -> { history.undoEdit(); true }
                R.id.action_redo -> { history.redoEdit(); true }
                R.id.action_font -> { showFontSizeDialog(); true }
                R.id.action_delete -> { delete(); true }
                else -> false
            }
        }

        // 新建笔记：页面就绪后直接进编辑态（已有笔记进预览，点正文才编辑）
        state.pendingAutoEdit = (noteId == MainActivity.NEW_NOTE)

        editor.buildBootstrapThemeCss()
        initWebView()
        setupKeyboardBar()
        history.setupHistory()
        setupBackHandler()
        // v1.36：格式化改由 Vditor 自带工具栏负责，隐藏原生格式栏避免重复。
        // v1.43：原生键盘辅助栏（含收起键盘键）整体移除——Web 工具栏随键盘
        // 显隐后它成了纯多余物；收起键盘交给系统返回手势。
        // 生命周期驱动的轮询（键盘检测 + JS 状态下行校准），onPause 停
        ime.startPolling()
    }

    override fun onResume() {
        super.onResume()
        // 从设置页改完全局字号/字体/主题回来，这里立即生效
        editor.applyTheme()
        // v1.57：从设置页改完工具栏自定义回来，配置变化则重建工具栏生效
        editor.pushToolbarConfig()
        // 从设置页改完调试日志开关回来，立即生效显隐
        binding.debugOverlay.visibility =
            if (DebugPref.enabled(this)) View.VISIBLE else View.GONE
        // 对话框/外跳期间压下的"键盘收起退预览"在这里解除
        state.suppressExitEdit = false
        // 从设置页返回后重启轮询（onPause 会停掉），否则 editing 校准断流
        if (state.ready && !isFinishing) {
            ime.startPolling()
        }
    }

    /** 离开页面就保存，不用手动点保存 */
    override fun onPause() {
        ime.stopPolling()   // 页面不可见，停轮询
        // 把还没落栈的输入补上，免得刚打的字撤不回来
        history.commitSnapshot()
        if (!deleted && state.dirty) {   // Sprint 4 #64：只有脏了才落盘，统一返回/后台/重建判断
            save()
            // 双保险：JS 侧编辑中的块在 visibilitychange 已即时上报；
            // 这里再从 WebView 拉一次最终内容，有变化就再落一遍盘
            if (state.ready) {
                binding.editorWeb.evaluateJavascript("editor.getSource()") { s ->
                    val text = try {
                        if (s == null) null else JSONTokener(s).nextValue() as? String
                    } catch (e: Exception) {
                        null
                    } ?: return@evaluateJavascript
                    if (text != state.content) {
                        state.content = text
                        if (!deleted) save()
                    }
                }
            }
        }
        super.onPause()
    }

    override fun onDestroy() {
        ime.stopPolling()
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
                val first = !state.ready
                state.ready = true
                if (first) {
                    // v1.57：先注入工具栏自定义配置，再 loadMarkdown —— mount 时
                    // buildToolbar 直接读全局配置，避免首屏用默认后又重建一次
                    editor.pushToolbarConfig()
                    editor.load(state.content)
                    editor.applyTheme()
                }
                // v1.51 修"工具栏时有时无"：推送"实时"键盘态并把边沿缓存对齐到
                // 实时值（ime.pageReadySync），再在布局落定后二次校验，兜住键盘
                // 动画晚于页面就绪到达的时序。
                val live = ime.pageReadySync()
                editor.js("editor.onIme($live, ${live && ime.isFloatingIme()})")
                view.postDelayed({ if (!isFinishing) ime.updateKeyboardBar() }, 200)
                view.postDelayed({ if (!isFinishing) ime.updateKeyboardBar() }, 500)
                if (state.pendingAutoEdit) {
                    state.pendingAutoEdit = false
                    editor.enterEditAt(state.content.length)
                    // 非用户手势的 JS focus 不一定唤得起 IME，Kotlin 侧补一刀
                    view.postDelayed({
                        if (!isFinishing) {
                            getSystemService(InputMethodManager::class.java)
                                ?.showSoftInput(binding.editorWeb, InputMethodManager.SHOW_IMPLICIT)
                        }
                    }, 120)
                }
            }

            /** 主文档主题注入（EditorController）+ 图片供流（EditorImageController） */
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val uri = request.url
                editor.interceptMainDocument(view, uri)?.let { return it }
                return image.interceptImageRequest(uri)
            }
        }
        // v1.52 修深色模式进入便签闪白：把 WebView 表面底色设成页面色，
        // 挡住文档解析前那一瞬的白底窗口（主题 CSS 已由 interceptMainDocument 注入）
        wv.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.bg_page))
        wv.loadUrl("file:///android_asset/editor/editor.html")
    }

    // ---------- 键盘联动 / 返回键（委托 EditorImeController） ----------

    private fun setupKeyboardBar() {
        ime.setupKeyboardBar()
        // 调试浮层：受设置项「调试日志」控制（默认关闭）。出问题想看内部状态时，
        // 打开设置里的开关即可；点浮窗一键分享日志（v1.66）。
        binding.debugOverlay.visibility =
            if (DebugPref.enabled(this)) View.VISIBLE else View.GONE
        binding.debugOverlay.setOnClickListener { diag.shareInsetLog() }
    }

    /**
     * 返回键：编辑态先退回预览（提交当前块），预览态才真正离开页面 ——
     * 与小米便签一致的两段式返回。
     */
    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (state.editing && state.ready) {
                    editor.exitEdit()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    // ---------- JS 事件路由（EditorBridge post 回主线程后调用） ----------

    /** JS 上报全文 + 光标：更新状态镜像并记撤销快照（职责在 EditorHistoryController） */
    fun onJsContentChanged(text: String, caret: Int) {
        history.onContentChanged(text, caret)
    }

    /** 进入/退出编辑态：驱动 IME 补刀、历史菜单与轮询/键盘联动 */
    fun onJsEditModeChanged(editing: Boolean) {
        state.editing = editing
        if (editing) {
            state.editingSince = SystemClock.elapsedRealtime()
            // 统一 IME 补刀（v1.35.10）：点击进入编辑时，JS 的 el.focus() 不在
            // 用户手势栈内，经常唤不起软键盘 → 辅助栏不出、也打不了字。
            // 延迟 200ms：先等 WebView 的原生唤起，已弹起就不重复请求。
            binding.editorWeb.postDelayed({
                if (isFinishing || !state.editing) return@postDelayed
                val ri = ViewCompat.getRootWindowInsets(binding.root)
                val imeUp = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
                if (!imeUp) {
                    getSystemService(InputMethodManager::class.java)
                        ?.showSoftInput(binding.editorWeb, InputMethodManager.SHOW_IMPLICIT)
                }
            }, 200)
        }
        history.updateHistoryMenu()
        // 轮询是 editing / 键盘状态的唯一可靠来源（本机 JS→Kotlin 桥已死）。
        // 绝不能因退出编辑而停 —— 否则再点进编辑态 editing 永远 false，
        // 工具栏再不出现。持续运行：onCreate/onResume 启动、onPause 停止。
        if (!isFinishing) {
            ime.startPolling()
        }
        ime.updateKeyboardBar()
    }

    fun onJsCopyCode(code: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("md-code", code))
        toast("代码已复制")
    }

    fun onJsOpenUrl(url: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        state.suppressExitEdit = true   // 外跳浏览器会触发 onPause + 键盘收起，别误退编辑态
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            toast("打不开这个链接")
        }
    }

    /** 全屏看图（职责在 EditorImageController，桥直呼的兼容委托） */
    fun onJsViewImage(key: String) {
        image.onJsViewImage(key)
    }

    /**
     * 处理 JS 事件队列（v1.35.8）：@JavascriptInterface 在该设备上调用即抛，
     * 低频动作（toast/复制代码/开链接/看图）改为 JS 入队、轮询时在这里取出。
     * 本类只做路由，具体职责在对应 Controller。
     */
    internal fun drainJsEvents(q: JSONArray?) {
        if (q == null) return
        for (i in 0 until q.length()) {
            val ev = q.optJSONObject(i) ?: continue
            when (ev.optString("m")) {
                "toast" -> toast(ev.optString("a"))
                "copyCode" -> onJsCopyCode(ev.optString("a"))
                "openUrl" -> onJsOpenUrl(ev.optString("a"))
                "viewImage" -> image.onJsViewImage(ev.optString("a"))
                "pickImage" -> image.onJsPickImage()
                "undo" -> history.undoEdit()   // Sprint 4 #82-7：格式栏撤销按钮统一走 Kotlin 历史栈
                "redo" -> history.redoEdit()
            }
        }
    }

    // ---------- 保存 / 删除 ----------

    private fun save() {
        val content = state.content
        if (content.isBlank()) return   // 空便签不存

        // 正文里不再引用的图直接丢掉，别让删了图的旧数据一直占着 json
        image.retainImagesReferencedBy(content)

        // 既有的便签：直接取出仓库里那条对象就地改内容字段——pinned 等元数据自然保留，
        // 不会被 upsert 的"删旧加新"冲掉；只有真正的新便签才新建。
        val note = (try {
            NoteRepository.find(this, noteId)
        } catch (e: CorruptStorageException) {
            null
        })?.apply {
            title = extractTitle(content)          // 标题从第一个 H1 自动提取
            this.content = content
            updatedAt = System.currentTimeMillis()
            images = if (image.noteImages.isEmpty()) null else LinkedHashMap(image.noteImages)
            fontSize = state.noteFontSize
        } ?: Note(
            id = System.currentTimeMillis(),
            title = extractTitle(content),
            content = content,
            updatedAt = System.currentTimeMillis(),
            images = if (image.noteImages.isEmpty()) null else LinkedHashMap(image.noteImages),
            fontSize = state.noteFontSize
        )
        try {
            NoteRepository.upsert(this, note)
        } catch (e: CorruptStorageException) {
            toast("保存失败：数据文件损坏，已恢复上次备份")
            return
        }
        noteId = note.id
        state.savedContent = content   // Sprint 4 #64：标记已保存，dirty=false
    }

    /** 删除前确认：防手滑——软删除虽然留了墓碑，但用户侧没有回收站，删了就是没了 */
    private fun delete() {
        if (noteId == MainActivity.NEW_NOTE) {
            // 还没落盘的新便签：没有可删的记录，丢弃内容直接退出
            deleted = true
            finish()
            return
        }
        state.suppressExitEdit = true   // 对话框期间键盘收起，别把编辑态误退了
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.delete_confirm_title)
            .setMessage(R.string.delete_note_msg)
            .setPositiveButton(R.string.action_delete) { _, _ -> doDelete() }
            .setNegativeButton(R.string.action_cancel, null)
            .setOnDismissListener { state.suppressExitEdit = false }
            .show()
    }

    private fun doDelete() {
        deleted = true   // 必须先置位：finish() 触发的 onPause 不能再回写内容
        try {
            NoteRepository.softDelete(this, noteId)
        } catch (e: CorruptStorageException) {
            toast("删除失败：数据文件损坏，已恢复上次备份")
            finish()
            return
        }
        toast("已删除")
        finish()
    }

    // ---------- 字号对话框（页面级 UI，不属于任何 Controller） ----------

    /** 单便签字号：滑条实时预览，勾「跟随全局」即清掉本便签的独立值 */
    private fun showFontSizeDialog() {
        state.suppressExitEdit = true   // 对话框期间键盘收起，别把编辑态误退了
        val view = layoutInflater.inflate(R.layout.dialog_font_size, null)
        val spLabel = view.findViewById<TextView>(R.id.spLabel)
        val spSeek = view.findViewById<SeekBar>(R.id.spSeek)
        val chkFollow = view.findViewById<MaterialCheckBox>(R.id.chkFollow)

        val global = Appearance.textSize(this)
        chkFollow.isChecked = state.noteFontSize == null
        spSeek.max = Appearance.MAX_SP - Appearance.MIN_SP
        spSeek.progress = (state.noteFontSize ?: global) - Appearance.MIN_SP
        spLabel.text = if (state.noteFontSize == null) "跟随全局（$global sp）" else "${state.noteFontSize} sp"

        spSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                if (!fromUser) return
                if (chkFollow.isChecked) chkFollow.isChecked = false   // 动了滑条就脱离跟随
                val sp = p + Appearance.MIN_SP
                spLabel.text = "$sp sp"
                state.noteFontSize = sp
                editor.applyTheme()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) = Unit
            override fun onStopTrackingTouch(sb: SeekBar?) = Unit
        })

        chkFollow.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                spSeek.progress = global - Appearance.MIN_SP
                spLabel.text = "跟随全局（$global sp）"
                state.noteFontSize = null
                editor.applyTheme()
            }
        }

        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle(R.string.title_font_size)
            .setView(view)
            .setPositiveButton("完成", null)
            .setOnDismissListener { state.suppressExitEdit = false }
            .show()
    }
}
