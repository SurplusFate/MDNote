package com.example.mdnotes

import android.content.Context
import android.content.SharedPreferences

/**
 * 编辑页调试浮层的开关设置。
 *
 * 历史：v1.35.4 起为 BuildConfig.DEBUG 强制显示的真机定位工具。
 * v1.35.6 改为设置项可开关 —— 用户反馈「键盘弹出把调试信息盖了，看个毛线看」，
 * 默认关闭，普通用户用不到；出问题时再在「设置 → 编辑 → 调试日志」勾选打开。
 *
 * 浮层本身仍只在 debug 构建里编译进布局（release 包根本不存在那个 TextView），
 * 这里只决定 EditActivity 启动时是否把它 VISIBLE 出来。
 */
object DebugPref {

    private const val FILE = "mdnotes_debug"
    private const val KEY = "overlay_enabled"

    /** 默认关闭：不是开发者就别看到这一坨黑底绿字 */
    fun enabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY, false)

    fun save(ctx: Context, enabled: Boolean) {
        prefs(ctx).edit().putBoolean(KEY, enabled).apply()
    }

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}