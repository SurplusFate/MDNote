package com.example.mdnotes

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * 本地存储 + 同步。
 *
 * 存储方案：整个便签库是一个 notes.json 文件。
 * 好处是 WebDAV 同步天然就是「下载一个文件 → 合并 → 上传一个文件」，不用处理增量。
 * 便签是纯文本，几百条也只有几十 KB，完全撑得住。
 *
 * 数据安全底线（Sprint 1，对应审查 P0#25/#26/#27/#29）：
 * - saveAll 走「写临时文件 → 原子 rename」，绝不留下半截文件被后续读取当损坏；
 * - loadAll 解析失败不再静默当空库（那会触发 saveAll 覆盖、真丢笔记），改为备份损坏文件 +
 *   回退内存缓存，缓存也没有才抛 CorruptStorageException 让上层明确提示；
 * - 每条 Note 带 revision / deviceId，merge 用 (updatedAt, revision, deviceId) 确定性排序，
 *   且 sync 上传带 If-Match 冲突保护（见 WebDav）。
 */
object NoteRepository {
    private const val FILE_NAME = "notes.json"
    private const val PREF = "mdnotes_store"
    private const val K_DEVICE_ID = "device_id"
    private val gson = Gson()
    private val listType = object : TypeToken<MutableList<Note>>() {}.type

    /** 内存缓存：成功 load/save 后更新。损坏且无磁盘缓存时用于兜底恢复，避免静默丢库 */
    @Volatile private var cachedNotes: MutableList<Note>? = null

    /** 仓库级单调版本号：每次保存 +1，作为 note.revision 的下界，保证同设备后写胜出 */
    @Volatile private var storeRevision = 0L

    private fun file(ctx: Context) = File(ctx.filesDir, FILE_NAME)
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    /** 本机稳定身份：首次生成 UUID 持久化，用于多设备冲突的确定性兜底 */
    private fun deviceId(ctx: Context): String {
        val p = prefs(ctx)
        var id = p.getString(K_DEVICE_ID, null)
        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString()
            p.edit().putString(K_DEVICE_ID, id).apply()
        }
        return id
    }

    /** 解析 notes.json。失败返回 failure（不静默空库），由 loadAll 决定兜底策略 */
    fun loadAllResult(ctx: Context): Result<MutableList<Note>> {
        val f = file(ctx)
        if (!f.exists()) return Result.success(mutableListOf())
        return runCatching {
            gson.fromJson<MutableList<Note>>(f.readText(), listType)
                ?: throw IOException("notes.json 反序列化为 null")
        }.onSuccess { cachedNotes = ArrayList(it) }
    }

    /**
     * 读全部便签。损坏时：
     * 1) 备份损坏文件为 notes.json.corrupt.<ts>（绝不覆盖原文件）；
     * 2) 若有内存缓存（上次成功保存/加载过），回退缓存——数据来自最近一次已知好状态；
     * 3) 缓存也没有，抛 CorruptStorageException，让上层明确提示，而不是返回空库被后续保存覆盖。
     */
    fun loadAll(ctx: Context): MutableList<Note> {
        return loadAllResult(ctx).getOrElse { e ->
            backupCorrupt(ctx)
            cachedNotes?.let { return ArrayList(it) }
            throw CorruptStorageException("notes.json 解析失败且无可用缓存，已备份为 .corrupt", e)
        }
    }

    private fun backupCorrupt(ctx: Context) {
        runCatching {
            val f = file(ctx)
            if (f.exists()) {
                val bak = File(f.parent, "notes.json.corrupt.${System.currentTimeMillis()}")
                f.copyTo(bak, overwrite = false)
            }
        }
    }

    /** 原子保存：写临时文件 → rename 替换。rename 在同分区是原子操作，不留半截文件。
     *  @Synchronized 保证 storeRevision 推进与缓存写入的原子性，避免 IO/主线程并发写竞态 */
    @Synchronized
    fun saveAll(ctx: Context, list: List<Note>) {
        val dev = deviceId(ctx)
        storeRevision++
        val stamped = list.map { n ->
            if (n.deviceId.isBlank()) n.deviceId = dev
            if (n.revision < storeRevision) n.revision = storeRevision
            n
        }
        val json = gson.toJson(stamped)
        val f = file(ctx)
        f.parentFile?.mkdirs()
        val tmp = File(f.parent, f.name + ".tmp")
        tmp.writeText(json)
        if (!tmp.renameTo(f)) {
            // 极少数文件系统 rename 失败，回退覆盖写（仍有风险但保证不丢）
            f.writeText(json)
        }
        cachedNotes = ArrayList(stamped)
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
     * 合并本地与远端：按 id 分组，每组取 (updatedAt, revision, deviceId) 最大者。
     * 30 天前的墓碑清掉，免得文件越攒越大。
     * 排序键确定性，避免「同毫秒 maxBy updatedAt」的非确定结果（P0#29）。
     */
    fun merge(local: List<Note>, remote: List<Note>): List<Note> {
        val cutoff = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
        return (local + remote)
            .groupBy { it.id }
            .map { (_, versions) ->
                versions.maxWithOrNull(
                    compareBy<Note> { it.updatedAt }
                        .thenBy { it.revision }
                        .thenBy { it.deviceId }
                )!!
            }
            .filter { !it.deleted || it.updatedAt > cutoff }
            .sortedByDescending { it.updatedAt }
    }

    /** 一次完整同步。内部已切到 IO 线程，外面直接调就行 */
    suspend fun sync(ctx: Context): Result<List<Note>> = withContext(Dispatchers.IO) {
        runCatching {
            val url = Config.url(ctx)
            val user = Config.user(ctx)
            val pwd = Config.pwd(ctx)

            val (remoteJson, remoteETag) = WebDav.downloadWithMeta(url, user, pwd)
            val remote: List<Note> = if (remoteJson.isNullOrBlank()) {
                emptyList()
            } else {
                gson.fromJson<List<Note>>(remoteJson, listType) ?: emptyList()
            }

            val merged = merge(loadAll(ctx), remote)
            saveAll(ctx, merged)

            // 冲突保护：上传带 If-Match，远端已变(412)则重新下载/合并/再传，最多重试若干次
            var etag = remoteETag
            var attempt = 0
            val maxAttempts = 5
            while (true) {
                val code = WebDav.upload(url, user, pwd, gson.toJson(merged), ifMatch = etag)
                if (code in 200..299) break
                if (code == 412 && attempt < maxAttempts) {
                    attempt++
                    val (r2, e2) = WebDav.downloadWithMeta(url, user, pwd)
                    val remote2: List<Note> = if (r2.isNullOrBlank()) emptyList()
                    else gson.fromJson(r2, listType) ?: emptyList()
                    val reMerged = merge(loadAll(ctx), remote2)
                    saveAll(ctx, reMerged)
                    etag = e2
                    continue
                }
                if (code !in 200..299) throw IOException("上传失败 HTTP $code")
            }
            loadAll(ctx)
        }
    }
}

/** notes.json 损坏且无可用缓存时抛出，区别于普通异常，便于上层给出明确提示 */
class CorruptStorageException(message: String, cause: Throwable? = null) : IOException(message, cause)
