package com.example.mdnotes

import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * 键盘 / IME 联动（审查 #17 Sprint 5：EditorImeController）。
 *
 * 只负责「键盘在不在、多高、悬浮还是普通」这一件事及由此派生的：
 * 1. 垫底 padding（键盘态垫键盘高度、非键盘态垫导航栏高度）；
 * 2. 自动回预览（键盘收起防抖确认，仅限本会话见过普通键盘实证的会话）；
 * 3. onIme 证据推送（JS 工具栏定位用；显隐本身已由 JS 编辑态驱动）。
 *
 * 修缩进 / 保存 / 图片问题时**不应触碰本文件**（拆分目标：修一个问题不再牵动整个编辑器）。
 * 悬浮键盘判定史（v1.60~v1.67 四代方案与教训）见各字段注释，此处不赘述。
 */
class EditorImeController(
    private val a: EditActivity,
    private val state: EditorState,
    private val diag: EditorDiagnostics
) {

    companion object {
        /** 键盘收起后多久确认自动退回预览：IME 动画期间 insets 逐帧回落，防误判 */
        private const val IME_SETTLE_MS = 250L
        private const val IME_POLL_MS = 300L
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

    private val imeExitHandler = Handler(Looper.getMainLooper())
    private val imeExitTask = Runnable {
        if (state.editing && !state.suppressExitEdit && state.ready) {
            a.binding.editorWeb.evaluateJavascript("editor.exitEditMode()", null)
        }
    }

    /**
     * 键盘状态轮询：MIUI 等 ROM 可能改写 adjustResize（布局不随键盘变化），
     * OnGlobalLayoutListener 收不到回调 —— 以 300ms 轮询兜底。幂等，重复无害。
     * 每轮同时执行 [onPoll]（JS 状态下行校准，归属 EditorController）。
     * 由生命周期驱动（onCreate 启动 / onPause 停止），不依赖 state.editing ——
     * 否则桥断时 editing 永远 false，轮询自己就停了。
     */
    private val imePollHandler = Handler(Looper.getMainLooper())
    private var pollHook: (() -> Unit)? = null
    private val imePollTask = object : Runnable {
        override fun run() {
            updateKeyboardBar()
            pollHook?.invoke()
            if (!a.isFinishing) imePollHandler.postDelayed(this, IME_POLL_MS)
        }
    }

    /** 轮询挂钩（由 Activity 注入 JS 下行校准），拆分保持原「每轮两件事」节奏 */
    fun setPollHook(hook: () -> Unit) { pollHook = hook }

    /** 轮询启停（onCreate/onResume 启动，onPause 停止） */
    fun startPolling() {
        imePollHandler.removeCallbacks(imePollTask)
        imePollTask.run()
    }
    fun stopPolling() { imePollHandler.removeCallbacks(imePollTask) }

    /**
     * v1.51：页面就绪时取实时键盘态并对齐边沿缓存（lastImeVisible）。
     * 若只推缓存态，键盘稳态下边沿不触发 → 工具栏卡在过期态（时有时无的根因）。
     */
    fun pageReadySync(): Boolean {
        val live = liveImeVisible()
        lastImeVisible = live
        return live
    }

    // ---------- insets 分发缓存 ----------
    internal var lastImeVisible = false   // 边沿检测：轮询高频触发下只认状态变化
        private set
    internal var lastFloatingPushed = false   // v1.63：最近推送的悬浮标志（悬浮⇄普通切换也要推送）
        private set
    internal var lastImePushAt = 0L       // v1.54：最近一次 onIme 推送时间（收起态保活重推）
        private set
    internal var insetsUpdatedAt = 0L     // v1.55：insets 分发缓存最近刷新时间
        private set
    internal var insetsImeVisible = false
        private set
    internal var insetsImeBottom = 0
        private set
    internal var insetsNavBottom = 0
        private set
    internal var insetsCalls = 0          // 分发到达计数（0 = 分发根本没来，证据）
        private set

    // v1.60 悬浮键盘：ime 可见但不占窗口高度（insets.bottom == 0）。
    // v1.64 降级为"定位参考信号"：只参与 onIme 推送的 floating 标志与调试浮层，
    // 不再参与工具栏显隐 —— 悬浮键盘的显隐判定已整体改道（编辑焦点驱动）。
    internal var floatingIme = false
        private set

    // v1.64：本编辑会话内见过「占窗口高度的键盘」（普通键盘实证 bottom>0）。
    // 自动退预览只在有此实证的会话里生效：悬浮键盘会话从无 bottom>0，其 (false,0)
    // 帧与真收起在系统层面不可区分，绝不能据此退编辑（否则悬浮键盘打着字被误退）。
    // 悬浮会话的收尾交给返回键两段式。
    internal var sawImeUp = false
        private set

    // ---------- 键盘检测挂点 ----------

    /**
     * 键盘检测（v1.43 起原生辅助栏已移除，只服务 padding / 自动回预览 / onIme 推送）。
     * 通道一（Android 11+）：ime insets 是唯一可靠信号；root 与 editorWeb 各挂一份
     * （幂等写缓存），防单点分发缺失。通道二（Android 10- 兜底）：布局变化监听。
     */
    fun setupKeyboardBar() {
        // root 与 editorWeb 各挂一份（幂等写缓存），防单点分发缺失
        val imeListener = { _: View, insets: WindowInsetsCompat ->
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
        ViewCompat.setOnApplyWindowInsetsListener(a.binding.root, imeListener)
        ViewCompat.setOnApplyWindowInsetsListener(a.binding.editorWeb, imeListener)
        // 通道二（Android 10- 兜底）：adjustResize 下键盘弹出必然引起根布局变化
        a.binding.root.viewTreeObserver.addOnGlobalLayoutListener { updateKeyboardBar() }
        updateKeyboardBar()
    }

    /**
     * 键盘状态与自动退预览判定（v1.64 起职责收窄），每轮做四件事：
     * 1. 垫底 padding：键盘态垫键盘高度、非键盘态垫导航栏高度；
     * 2. 自动回预览：仅在「本会话见过普通键盘实证（bottom>0）」的编辑会话里，
     *    键盘收起（防抖 IME_SETTLE_MS，期间复现则取消）→ 退出编辑回预览；
     * 3. onIme 推送：只给 JS 承载「键盘占窗口高度」证据 —— 工具栏显隐已改由
     *    JS 编辑态驱动（悬浮键盘 insets 零证据，v1.60~v1.63 四连败的根因）；
     * 4. 防误判：宽限期（刚进编辑态键盘还没弹出）、suppressExitEdit
     *    （对话框/外跳/选图）、编辑态判据用 JS 的真实状态（state.editing）。
     */
    fun updateKeyboardBar() {
        val root = a.binding.root
        // 退编辑态：清悬浮闩锁与会话证据（下次编辑重新取证）
        if (!state.editing) {
            floatingIme = false
            sawImeUp = false
        }
        val ri = ViewCompat.getRootWindowInsets(root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0

        // 合并：主动查询与分发缓存。v1.53 修「预览态工具栏时有时无」：主动查询是
        // 实时系统读数，最可信；查询说无而分发缓存说有时，缓存可能是 ROM 残留的
        // 过期帧（MIUI 键盘收起后 insets 缓存不清零），必须有可见区高度差佐证才采信。
        val byQuery = qVisible && qBottom > 0
        // v1.55：分发缓存加时效 —— 键盘收起后部分 ROM（MIUI）不再派发 insets 回调，
        // 缓存里留着"键盘在"的过期帧永不刷新；超过 30s 无刷新的缓存不再采信。
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
        //（日志实锤：伪帧触发 250ms 退预览 = 「时而隐藏」根因）。
        var imeVisible = imeByInsets || floatingIme
        // v1.67：悬浮在场（闩锁）一律垫 0 —— 实测悬浮帧 b=2，垫 2px 会让
        // imeBottom 在 2↔0 之间抖、floating 标志跟着横跳。
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
        // 判据从 imeBottom>0 收紧为 imeBottom > 屏高/4：日志实锤悬浮帧 b=2 也会
        // 中「>0」，导致悬浮会话误获退预览资格、伪帧一来就被退回预览。
        if (state.editing && imeVisible && imeBottom > root.rootView.height / 4) sawImeUp = true

        // e2e 下内容延伸到导航栏后面：非键盘态垫导航栏高度，键盘态垫键盘高度
        root.updatePadding(bottom = if (imeVisible) imeBottom else insetsNavBottom)

        // v1.64/v1.67：floating 定位标志 = 键盘在但不占窗口高度（悬浮键盘）。
        val floating = imeVisible && imeBottom == 0
        if (imeVisible != lastImeVisible || floating != lastFloatingPushed) {
            lastImeVisible = imeVisible
            lastFloatingPushed = floating
            lastImePushAt = SystemClock.elapsedRealtime()
            // v1.64：推送只承载证据（JS 显隐由编辑态驱动）。(true,false)=普通
            // 键盘占高实证 → JS 工具栏立即入流；其余组合不影响 JS 显隐。
            a.editor.js("editor.onIme($imeVisible, $floating)")
            // 自动退预览：只在有普通键盘实证的会话生效（sawImeUp）。
            if (!imeVisible && state.editing && sawImeUp && !state.suppressExitEdit && state.ready &&
                SystemClock.elapsedRealtime() - state.editingSince > EDIT_GRACE_MS
            ) {
                imeExitHandler.removeCallbacks(imeExitTask)
                imeExitHandler.postDelayed(imeExitTask, IME_SETTLE_MS)
            } else {
                imeExitHandler.removeCallbacks(imeExitTask)
            }
        } else if (!imeVisible && state.ready &&
            SystemClock.elapsedRealtime() - lastImePushAt > 1500
        ) {
            // 收起态保活重推（幂等）。v1.64 起 JS 显隐已解耦，此推送仅兜底触发
            // 一次 apply / 菜单重扫。
            lastImePushAt = SystemClock.elapsedRealtime()
            a.editor.js("editor.onIme(false, false)")
        }
        // v1.66 详细日志：每轮把完整状态落盘（随调试开关），手动测时序列一目了然
        val rl = Rect(); root.getWindowVisibleDisplayFrame(rl)
        val rH = root.rootView.height
        diag.appendInsetLog(
            "BAR q=$qVisible/$qBottom disp=${insetsImeVisible}/${insetsImeBottom} nav=$insetsNavBottom " +
            "rootH=$rH visH=${rl.height()} diff=${rH - rl.height()} edit=${state.editing} saw=$sawImeUp " +
            "float=$floating imeVis=$imeVisible →onIme($imeVisible,$floating)"
        )
        diag.updateDebugOverlay(this, ri, qVisible, qBottom)
    }

    /**
     * v1.51：实时键盘态查询，供 onPageFinished 在页面就绪时推送权威态——不依赖
     * updateKeyboardBar 的"变化边沿"门闩。只读实时读数，不触发 padding/推送副作用。
     * v1.53：合并判定改为主动查询优先，过期分发缓存需高度差佐证（同 updateKeyboardBar）。
     */
    fun liveImeVisible(): Boolean {
        val root = a.binding.root
        val ri = ViewCompat.getRootWindowInsets(root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        diag.logRaw("Q", qVisible, qBottom)    // v1.65：记录页面就绪实时查询帧
        if (qVisible && qBottom > 0) return true
        // v1.60：qVisible 但 bottom==0 = 悬浮键盘（键盘确实在，只是不占窗口高度）。
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
        // updateKeyboardBar 同源。
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
     * v1.61/v1.67：insets 分发 → 维护悬浮键盘闩锁。
     * 1. 悬浮判定 bottom < FLOAT_IME_MAX_PX（这台设备悬浮在场报 v=1 b=2）；
     * 2. v=0 帧不翻转闩锁：ROM 周期性发 v=0 b=0 伪帧（与真收起不可区分），
     *    闩锁只由「普通键盘帧（b 大）」清除，v=0 一律忽略。悬浮真收起后工具栏
     *    留屏顶（既定取舍），退编辑由返回键两段式。
     */
    private fun onImeDispatch(visible: Boolean, bottom: Int) {
        diag.logRaw("D", visible, bottom)      // v1.65：记录每次真实分发帧
        if (!visible) return              // v1.67：伪帧/真收起帧均不翻闩锁
        floatingIme = bottom < FLOAT_IME_MAX_PX
    }

    /**
     * v1.61：当前是否处于悬浮键盘态（ime 可见但不占窗口高度）。
     * 闩锁（onImeDispatch 维护）为主，实时查询为辅 —— 两者取或。
     * v1.60 的教训：当时要求「查询先说可见」才肯看闩锁，结果这台 ROM 的实时查询
     * 对悬浮键盘返回 false，闩锁被一句 return false 短路。闩锁是分发事件驱动的，
     * 不会过期，必须独立生效。
     */
    fun isFloatingIme(): Boolean {
        val ri = ViewCompat.getRootWindowInsets(a.binding.root)
        val qVisible = ri?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val qBottom = ri?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
        if (qVisible && qBottom < FLOAT_IME_MAX_PX) {
            floatingIme = true   // 查询证实 → 顺带保鲜闩锁（v1.67：b=2 实测）
        }
        return floatingIme
    }
}
