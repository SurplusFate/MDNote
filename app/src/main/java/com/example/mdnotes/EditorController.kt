package com.example.mdnotes

import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 编辑器核心（审查 #17 Sprint 5：EditorController）。
 *
 * 职责：与 WebView 的双向通道与主题/工具栏配置 ——
 * - [js]：evaluateJavascript 统一门闩（页面没就绪静默丢弃）；
 * - [pollJsState]：轮询下行校准（编辑态/内容/光标/事件队列）；
 * - load / setSource / enterEdit / exitEdit 等编辑器基础动作；
 * - 主题变量、工具栏自定义配置、首屏防闪白 bootstrap CSS。
 *
 * 修 IME / 图片 / 历史问题时**不应触碰本文件**（拆分目标见 #17）。
 */
class EditorController(
    private val a: EditActivity,
    private val state: EditorState,
    private val diag: EditorDiagnostics
) {

    /**
     * 首屏前注入的内联主题样式（v1.52 修深色模式进入闪白）：按当前昼夜资源算好，
     * 经 shouldInterceptRequest 注入 editor.html 的 <head> 最前。
     */
    lateinit var bootstrapThemeCss: String
        private set

    /** evaluateJavascript 的统一门闩：页面没就绪时静默丢弃（onPageFinished 会补做） */
    fun js(script: String) {
        if (state.ready) a.binding.editorWeb.evaluateJavascript(script, null)
    }

    /** 页面就绪装载笔记内容（onPageFinished 首次调用） */
    fun load(content: String) {
        a.binding.editorWeb.evaluateJavascript(
            "editor.loadMarkdown(${JSONObject.quote(content)}, 0, false)", null
        )
    }

    /**
     * 下行校准（两级）：
     * - 未编辑态拉轻探针 probe()（编辑态 + 桥探针 + JS 诊断，不含内容）；
     * - 编辑态拉全量 stat()（内容/光标），走与桥上行相同的 onContentChanged。
     *
     * v1.35.7 修复致命 bug：此前脚本是 JSON.stringify(window.editor.probe())，
     * 表达式结果为字符串，evaluateJavascript 回调会对结果再做一次 JSON 编码，
     * Kotlin 拿到的是「字符串的 JSON 编码」，nextValue 出 String、as? JSONObject
     * 恒为 null，每次轮询都在静默 return —— 下行校准从未生效。现在直接返回对象。
     */
    fun pollJsState() {
        if (!state.ready || a.isFinishing) return
        val script = if (state.editing)
            "(window.editor ? window.editor.stat() : {})"
        else
            "(window.editor ? window.editor.probe() : {})"
        a.binding.editorWeb.evaluateJavascript(script) { s ->
            if (a.isFinishing || s.isNullOrBlank() || s == "null") return@evaluateJavascript
            val obj = try {
                JSONTokener(s).nextValue() as? JSONObject
            } catch (e: Exception) {
                null
            } ?: run {
                diag.bumpPollBad()   // 解析失败计数：浮层可见，别再静默
                return@evaluateJavascript
            }
            diag.recordProbe(obj.optJSONObject("probe"))
            diag.updateJsDiag(obj.optJSONObject("d"))
            a.drainJsEvents(obj.optJSONArray("q"))
            if (obj.optBoolean("e", false)) {
                if (!state.editing) {
                    a.onJsEditModeChanged(true)
                } else {
                    a.onJsContentChanged(obj.optString("s"), obj.optInt("c", 0))
                }
            } else if (state.editing) {
                a.onJsEditModeChanged(false)
            }
        }
    }

    /** 进入编辑态并唤起键盘的统一入口（新建笔记自动编辑 / 点击正文由 JS 侧自行处理） */
    fun enterEditAt(caret: Int) {
        a.binding.editorWeb.evaluateJavascript("editor.enterEditAt($caret)", null)
    }

    /** 退出编辑态回预览（提交当前块） */
    fun exitEdit() {
        a.binding.editorWeb.evaluateJavascript("editor.exitEditMode()", null)
    }

    // ---------- 渲染模式 ----------

    /** 顶栏眼睛按钮：false = 实时渲染（默认），true = 全文源码视图。图标随态切换 */
    private var sourceMode = false

    fun toggleRenderMode() {
        sourceMode = !sourceMode
        js("editor.toggleSourceMode()")
        a.binding.toolbar.menu.findItem(R.id.action_toggle_render)?.setIcon(
            if (sourceMode) R.drawable.ic_eye_off else R.drawable.ic_eye
        )
    }

    // ---------- 主题 / 字号 / 工具栏配置 ----------

    /** 主题变量（昼夜色值由资源系统自动切换）：applyTheme 与首屏 bootstrap 共用，单一真源 */
    private fun themeVarMap(): Map<String, String> {
        val sp = (state.noteFontSize ?: Appearance.textSize(a)).toFloat()
        // v1.49 修字号偏大：原 fontPx = sp * scaledDensity 把 sp 当 dp 又乘了一次密度。
        // 本 App WebView 的 viewport=device-width 且 textZoom=100 → 1 CSS px == 1 dp，
        // CSS 字号直接等于 sp 数值。
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

    /** v1.57：工具栏自定义配置 → editor.setToolbarConfig 所需的 JSON */
    private fun toolbarConfigJson(): String {
        val cfg = ToolPrefs.load(a)
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
    fun pushToolbarConfig() {
        if (!state.ready) return
        val json = toolbarConfigJson()
        if (json == lastToolbarCfg) return
        lastToolbarCfg = json
        js("editor.setToolbarConfig($json)")
    }

    fun applyTheme() {
        if (!state.ready) return   // 页面没就绪：onPageFinished 会补一次
        js("editor.applyTheme(${JSONObject(themeVarMap())})")
    }

    /**
     * v1.52 修深色模式进入便签闪白：在文档首屏解析前就算好同源主题变量，拼成内联
     * <style> 由 shouldInterceptRequest 注入 <head> 最前；Vditor 挂载与首屏绘制直接
     * 拿深色背景/前景，闪白消失。onPageFinished 的 applyTheme 仍保留（幂等）。
     */
    fun buildBootstrapThemeCss() {
        val root = themeVarMap().entries.joinToString(" ") { "--${it.key}:${it.value};" }
        bootstrapThemeCss = "<style id=\"mdnotes-theme-bootstrap\">:root{ $root }" +
            "html,body{background:var(--bg-page) !important;}" +
            ".vditor-reset{color:var(--text) !important;background:var(--paper) !important;}" +
            ".vditor-toolbar{background-color:var(--paper) !important;}" +
            ".vditor-hint{background-color:var(--paper) !important;}</style>"
    }

    private fun colorHex(res: Int): String =
        String.format("#%06X", 0xFFFFFF and androidx.core.content.ContextCompat.getColor(a, res))

    private fun cssFamily(): String = when (Appearance.family(a)) {
        "serif" -> "serif"
        "mono" -> "monospace"
        "light" -> "sans-serif-light"
        "medium" -> "sans-serif-medium"
        else -> "sans-serif"
    }

    // ---------- WebView 请求拦截（主文档主题注入） ----------

    /**
     * 拦截 editor.html 主文档，把 bootstrap 主题注入 <head> 最前。
     * 只处理 file://editor.html，其余返回 null 放行（图片供流见 EditorImageController）。
     */
    fun interceptMainDocument(view: android.webkit.WebView, uri: android.net.Uri): WebResourceResponse? {
        if (uri.scheme == "file" && uri.lastPathSegment == "editor.html") {
            return try {
                val raw = view.context.assets.open("editor/editor.html")
                    .bufferedReader(Charsets.UTF_8).use { it.readText() }
                val html = raw.replaceFirst("<head>", "<head>\n$bootstrapThemeCss\n")
                val bytes = html.toByteArray(Charsets.UTF_8)
                WebResourceResponse(
                    "text/html", "utf-8", 200, "OK",
                    mapOf("Access-Control-Allow-Origin" to "*"),
                    java.io.ByteArrayInputStream(bytes)
                )
            } catch (e: Exception) {
                null   // 兜底：注入失败就退化成默认加载（浅色默认，仅失去防闪）
            }
        }
        return null
    }
}
