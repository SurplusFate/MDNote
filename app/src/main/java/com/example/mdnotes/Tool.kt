package com.example.mdnotes

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 键盘辅助栏的一个工具：内置工具或用户自定义的文本片段。
 */
sealed class Tool {
    abstract val id: String
    abstract val label: String

    /** 内置工具：id 固定，行为在 EditActivity.applyTool 里分发 */
    data class BuiltIn(override val id: String, override val label: String) : Tool()

    /** 自定义工具：往光标处插入任意文本（如 --- 分割线、签名片段） */
    data class Custom(override val id: String, override val label: String, val text: String) : Tool()
}

/**
 * 全部内置工具注册表。顺序即"从未配置过"时的默认工具栏顺序。
 * v1.57：从原"键盘辅助栏"时代命名（h1/h2/task/softbreak/codeblock/image…）
 * 对齐到 Vditor 实际接受的 toolbar type（headings/bold/italic/strike/link/
 * list/ordered-list/check/quote/line/code/inline-code/indent/outdent/undo/
 * redo/fullscreen），id 即 Vditor toolbar 数组项名，editor 侧 buildToolbar
 * 直接透传，无需额外映射。
 * 例外：image 是 v1.58 新增的「特殊内置工具」——走 Kotlin 相册（非 Vditor type），
 * buildToolbar 会把它排除在 Vditor 数组外，由 editor 侧 renderSpecialTools 单独渲染。
 */
object Tools {

    val builtIns: List<Tool.BuiltIn> = listOf(
        Tool.BuiltIn("headings", "标题"),
        Tool.BuiltIn("bold", "加粗"),
        Tool.BuiltIn("italic", "斜体"),
        Tool.BuiltIn("strike", "删除线"),
        Tool.BuiltIn("link", "链接"),
        Tool.BuiltIn("list", "无序列表"),
        Tool.BuiltIn("ordered-list", "有序列表"),
        Tool.BuiltIn("check", "任务列表"),
        Tool.BuiltIn("quote", "引用"),
        Tool.BuiltIn("line", "分割线"),
        Tool.BuiltIn("code", "代码块"),
        Tool.BuiltIn("inline-code", "行内代码"),
        Tool.BuiltIn("indent", "缩进"),
        Tool.BuiltIn("outdent", "减缩进"),
        Tool.BuiltIn("undo", "撤销"),
        Tool.BuiltIn("redo", "重做"),
        Tool.BuiltIn("fullscreen", "全屏"),
        // v1.58：插入图片是 Kotlin 驱动的「特殊内置工具」（打开相册 → 光标处插 img://），
        // 不是 Vditor toolbar type，故单独列出、在 editor 侧单独渲染按钮，点击经事件队列唤起相册。
        Tool.BuiltIn("image", "图片"),
    )

    fun builtIn(id: String): Tool.BuiltIn? = builtIns.firstOrNull { it.id == id }
}

/**
 * 工具栏配置：哪些工具启用、按什么顺序排，外加用户自建的工具。
 * JSON 存 SharedPreferences，结构和便签数据一样走 org.json，不引新依赖。
 */
data class ToolConfig(
    /** 启用中的工具 id，顺序 = 工具栏从左到右的顺序 */
    val enabledIds: List<String>,
    /** 用户自建的工具（含未启用的） */
    val customs: List<Tool.Custom>
) {
    /** 未启用的工具：内置 + 自建里没进 enabledIds 的，按注册表顺序 */
    fun disabledTools(): List<Tool> {
        val enabledSet = enabledIds.toSet()
        val disabledBuiltIns = Tools.builtIns.filter { it.id !in enabledSet }
        val disabledCustoms = customs.filter { it.id !in enabledSet }
        return disabledBuiltIns + disabledCustoms
    }

    /** 解析出工具栏实际要显示的工具；失效 id（已被删除的自定义工具）自动跳过 */
    fun resolve(): List<Tool> {
        return enabledIds.mapNotNull { id ->
            Tools.builtIn(id) ?: customs.firstOrNull { it.id == id }
        }
    }

    fun find(id: String): Tool? =
        Tools.builtIn(id) ?: customs.firstOrNull { it.id == id }
}

object ToolPrefs {

    private const val PREFS = "tool_prefs"
    private const val KEY_CFG = "config"

    /**
     * v1.57 迁移：v1.43 前键盘辅助栏时代的工具 id → Vditor toolbar type。
     * 无对应项的（softbreak 软换行）映射为 null，读取时丢弃。
     * image 图片虽走 Kotlin，但 v1.58 起已是正规的内置工具 id，故原地映射保留。
     * 其余（bold/italic/.../link）保持原名即已是 Vditor type，无需映射。
     */
    private val LEGACY_TOOL_MAP = mapOf(
        "h1" to "headings",
        "h2" to "headings",
        "task" to "check",
        "codeblock" to "inline-code",
        "softbreak" to null,
        "image" to "image"
    )

    /** 读取配置；没存过 → 全部内置工具按注册表顺序（与出厂工具栏一致） */
    fun load(ctx: Context): ToolConfig {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_CFG, null) ?: return defaultConfig()
        return try {
            val obj = JSONObject(raw)
            // 兼容旧配置：先把 v1.43 前辅助栏时代的 id 归一化到 Vditor type，再只留有效项
            val enabledRaw = ArrayList<String>()
            JSONArray(obj.optString("enabled")).let { arr ->
                for (i in 0 until arr.length()) enabledRaw.add(arr.getString(i))
            }
            val enabled = enabledRaw.mapNotNull { LEGACY_TOOL_MAP[it] ?: it }
                .filter { it.isNotBlank() && Tools.builtIn(it) != null }
                .distinct()
            val enabledFinal = if (enabled.isEmpty()) defaultConfig().enabledIds else enabled
            val customs = ArrayList<Tool.Custom>()
            JSONArray(obj.optString("custom")).let { arr ->
                for (i in 0 until arr.length()) {
                    val c = arr.getJSONObject(i)
                    customs.add(
                        Tool.Custom(
                            id = c.optString("id"),
                            label = c.optString("label"),
                            text = c.optString("text")
                        )
                    )
                }
            }
            // 数据自愈：空 id / 空 label 的脏数据直接丢
            ToolConfig(
                enabledFinal,
                customs.filter { it.id.isNotBlank() && it.label.isNotBlank() }
            )
        } catch (e: Exception) {
            defaultConfig()
        }
    }

    fun save(ctx: Context, cfg: ToolConfig) {
        val obj = JSONObject()
            .put("enabled", JSONArray(cfg.enabledIds))
            .put("custom", JSONArray(cfg.customs.map {
                JSONObject().put("id", it.id).put("label", it.label).put("text", it.text)
            }))
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_CFG, obj.toString()).apply()
    }

    /**
     * 默认启用集：v1.57 起对齐到 Vditor 后，默认只点亮窄屏放得下的精选 9 项
     * （与其余禁用）。保证老用户升级后工具栏观感与 v1.39 一致，且窄屏不拥挤；
     * 想加更多工具去设置→编辑工具栏里勾选即可。
     */
    private fun defaultConfig() = ToolConfig(
        enabledIds = listOf(
            "headings", "bold", "italic", "strike",
            "list", "ordered-list", "check", "quote", "code",
            // v1.58：插入图片快捷方式默认进栏，避免「工具栏里没有图片入口」（窄屏多一项无妨，可去设置关）
            "image"
        ),
        customs = emptyList()
    )
}
