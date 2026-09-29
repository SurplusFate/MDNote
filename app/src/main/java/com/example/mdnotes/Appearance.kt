package com.example.mdnotes

import android.content.Context
import android.graphics.Typeface
import androidx.appcompat.app.AppCompatDelegate

/**
 * 全局外观配置：字号 / 字体族 / 深浅色主题。
 *
 * 单便签可以覆盖字号（Note.fontSize），字体族和主题只有全局档。
 * 存 SharedPreferences；字号单位 sp，主题存 AppCompatDelegate 的常量值。
 */
object Appearance {

    private const val PREFS = "appearance_prefs"
    private const val K_TEXT_SP = "text_sp"
    private const val K_FAMILY = "family"
    private const val K_THEME = "theme"

    const val MIN_SP = 12
    const val MAX_SP = 26
    const val DEFAULT_SP = 16

    /** 字体族选项：id → 显示名 */
    val families = listOf(
        "default" to "默认",
        "serif" to "衬线",
        "mono" to "等宽",
        "light" to "细体",
        "medium" to "中黑"
    )

    /** 主题选项：AppCompatDelegate 常量值 → 显示名 */
    val themes = listOf(
        AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM to "跟随系统",
        AppCompatDelegate.MODE_NIGHT_NO to "浅色",
        AppCompatDelegate.MODE_NIGHT_YES to "深色"
    )

    fun textSize(ctx: Context): Int {
        val v = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(K_TEXT_SP, DEFAULT_SP)
        return v.coerceIn(MIN_SP, MAX_SP)
    }

    fun family(ctx: Context): String =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(K_FAMILY, "default") ?: "default"

    fun themeMode(ctx: Context): Int =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(K_THEME, AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

    fun saveTextSize(ctx: Context, sp: Int) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(K_TEXT_SP, sp.coerceIn(MIN_SP, MAX_SP)).apply()
    }

    fun saveFamily(ctx: Context, family: String) {
        if (families.none { it.first == family }) return
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(K_FAMILY, family).apply()
    }

    fun saveTheme(ctx: Context, mode: Int) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(K_THEME, mode).apply()
    }

    /** 全局字体族对应的 Typeface（编辑区与预览共用） */
    fun typeface(ctx: Context): Typeface = when (family(ctx)) {
        "serif" -> Typeface.SERIF
        "mono" -> Typeface.MONOSPACE
        "light" -> Typeface.create("sans-serif-light", Typeface.NORMAL)
        "medium" -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
        else -> Typeface.DEFAULT
    }

    fun familyName(ctx: Context): String =
        families.firstOrNull { it.first == family(ctx) }?.second ?: "默认"

    fun themeName(ctx: Context): String =
        themes.firstOrNull { it.first == themeMode(ctx) }?.second ?: "跟随系统"
}