package com.example.mdnotes

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 本地存储 + 同步。
 *
 * 存储方案：整个便签库是一个 notes.json 文件。
 * 好处是 WebDAV 同步天然就是「下载一个文件 → 合并 → 上传一个文件」，不用处理增量。
 * 便签是纯文本，几百条也只有几十 KB，完全撑得住。
 */
object NoteRepository {
    private const val FILE_NAME = "notes.json"
    private val gson = Gson()
    private val listType = object : TypeToken<MutableList<Note>>() {}.type

    private fun file(ctx: Context) = File(ctx.filesDir, FILE_NAME)

    fun loadAll(ctx: Context): MutableList<Note> {
        val f = file(ctx)
        if (!f.exists()) return mutableListOf()
        return try {
            gson.fromJson<MutableList<Note>>(f.readText(), listType) ?: mutableListOf()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    fun saveAll(ctx: Context, list: List<Note>) {
        file(ctx).writeText(gson.toJson(list))
    }

    /** 列表页要的数据：没删的，置顶的排在最前，其余按更新时间倒序 */
    fun visible(ctx: Context): List<Note> =
        loadAll(ctx).filter { !it.deleted }
            .sortedWith(compareByDescending<Note> { it.pinned }.thenByDescending { it.updatedAt })

    fun find(ctx: Context, id: Long): Note? = loadAll(ctx).find { it.id == id }

    fun upsert(ctx: Context, note: Note) {
        val all = loadAll(ctx)
        all.removeAll { it.id == note.id }
        all.add(note)
        saveAll(ctx, all)
    }

    /** 软删除：打墓碑，不真删 */
    fun softDelete(ctx: Context, id: Long) {
        val all = loadAll(ctx)
        val n = all.find { it.id == id } ?: return
        n.deleted = true
        n.updatedAt = System.currentTimeMillis()
        saveAll(ctx, all)
    }

    /** 批量软删除：首页多选删除用，一次性落盘，避免逐条写文件 */
    fun softDelete(ctx: Context, ids: Collection<Long>): Int {
        if (ids.isEmpty()) return 0
        val idSet = ids.toSet()
        val all = loadAll(ctx)
        val now = System.currentTimeMillis()
        var n = 0
        all.forEach {
            if (!it.deleted && it.id in idSet) {
                it.deleted = true
                it.updatedAt = now
                n++
            }
        }
        if (n > 0) saveAll(ctx, all)
        return n
    }

    /** 切换单条置顶，返回切换后的置顶状态 */
    fun togglePin(ctx: Context, id: Long): Boolean {
        val all = loadAll(ctx)
        val n = all.find { it.id == id } ?: return false
        n.pinned = !n.pinned
        // 置顶是独立标记，不改动 updatedAt，免得把便签顺带挤到时间序顶端
        saveAll(ctx, all)
        return n.pinned
    }

    /** 批量设置置顶/取消置顶，一次性落盘，返回受影响条数 */
    fun setPinned(ctx: Context, ids: Collection<Long>, pinned: Boolean): Int {
        if (ids.isEmpty()) return 0
        val idSet = ids.toSet()
        val all = loadAll(ctx)
        var n = 0
        all.forEach {
            if (!it.deleted && it.id in idSet && it.pinned != pinned) {
                it.pinned = pinned
                n++
            }
        }
        if (n > 0) saveAll(ctx, all)
        return n
    }

    /**
     * 合并本地与远端：按 id 分组，同一条保留 updatedAt 最大的那个版本。
     * 30 天前的墓碑清掉，免得文件越攒越大。
     */
    fun merge(local: List<Note>, remote: List<Note>): List<Note> {
        val cutoff = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
        return (local + remote)
            .groupBy { it.id }
            .map { (_, versions) -> versions.maxByOrNull { it.updatedAt }!! }
            .filter { !it.deleted || it.updatedAt > cutoff }
            .sortedByDescending { it.updatedAt }
    }

    /** 一次完整同步。内部已切到 IO 线程，外面直接调就行 */
    suspend fun sync(ctx: Context): Result<List<Note>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = Config.url(ctx)
            val user = Config.user(ctx)
            val pwd = Config.pwd(ctx)

            val remoteJson = WebDav.download(url, user, pwd)
            val remote: List<Note> = if (remoteJson.isNullOrBlank()) {
                emptyList()
            } else {
                gson.fromJson<List<Note>>(remoteJson, listType) ?: emptyList()
            }

            val merged = merge(loadAll(ctx), remote)
            saveAll(ctx, merged)

            WebDav.mkdir(url, user, pwd) // 目录不存在时建一下
            WebDav.upload(url, user, pwd, gson.toJson(merged))
            merged
        }
    }
}
