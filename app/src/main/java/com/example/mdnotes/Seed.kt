package com.example.mdnotes

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * 首次启动时的内置示例便签（功能展示用）。
 *
 * 只在「从未种过」时写入一次：用 SharedPreferences 标记 gate，
 * 且写入前按标题去重，用户删掉示例后重装也不会凭空再生出来。
 * 图片走和正式便签一样的 images 自托管表（img://key），离线也能显示。
 * 种子内容放在 assets/seed_notes.json，运行时直接读，避免字符串转义坑。
 */
object Seed {
    private const val ASSET = "seed_notes.json"
    private const val PREF = "mdnotes_seed"
    private const val KEY = "seeded"

    fun ensure(ctx: Context) {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        if (sp.getBoolean(KEY, false)) return

        val json = ctx.assets.open(ASSET)
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        val type = object : TypeToken<MutableList<Note>>() {}.type
        val list = Gson().fromJson<MutableList<Note>>(json, type) ?: return

        val existing = NoteRepository.loadAll(ctx).map { it.title }.toSet()
        val fresh = list.filter { it.title !in existing }
        if (fresh.isNotEmpty()) {
            // 让示例按加入顺序排在列表顶部，且日期显示为「刚刚 / 几分钟前」
            val base = System.currentTimeMillis()
            fresh.forEachIndexed { i, n -> n.updatedAt = base - (fresh.size - 1 - i) * 60_000L }
            val all = NoteRepository.loadAll(ctx)
            all.addAll(fresh)
            NoteRepository.saveAll(ctx, all)
        }
        sp.edit().putBoolean(KEY, true).apply()
    }
}
