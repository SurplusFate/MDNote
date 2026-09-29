package com.example.mdnotes

import android.content.Context
import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** WebDAV 配置。存 SharedPreferences，个人自用够了（别拿它存公司生产密码） */
object Config {
    private const val PREF = "webdav"
    private const val K_URL = "url"
    private const val K_USER = "user"
    private const val K_PWD = "pwd"

    private fun pref(ctx: Context) = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun save(ctx: Context, url: String, user: String, pwd: String) {
        // 注意：密码属于 opaque credential，不擅自 trim，否则可能破坏含首尾空格的合法密码（P1#39）
        pref(ctx).edit()
            .putString(K_URL, url.trim())
            .putString(K_USER, user.trim())
            .putString(K_PWD, pwd)
            .apply()
    }

    fun url(ctx: Context) = pref(ctx).getString(K_URL, "") ?: ""
    fun user(ctx: Context) = pref(ctx).getString(K_USER, "") ?: ""
    fun pwd(ctx: Context) = pref(ctx).getString(K_PWD, "") ?: ""

    /** 三项都非空才认为配置可用（含密码，避免同步时才 401）（P1#40） */
    fun ready(ctx: Context) =
        url(ctx).isNotBlank() && user(ctx).isNotBlank() && pwd(ctx).isNotBlank()
}

/**
 * 极简 WebDAV 客户端。
 * 便签同步只需要三个动作：建目录(MKCOL)、下载(GET)、上传(PUT)。
 *
 * 冲突保护（Sprint 1，P0#27）：下载时读取远端 ETag，上传时通过 If-Match 校验——
 * 远端已被别人改过会返回 412，上层据此重新合并再传，避免「后上传者整体覆盖」丢更新。
 * 不支持 ETag 的服务器（ETag 为空）则按普通 PUT 处理，行为不变。
 */
object WebDav {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun auth(user: String, pwd: String) = Credentials.basic(user, pwd)

    /** 建目录。目录已存在返回 405，忽略；其他错误（权限/网络/证书）抛出，让上层知道（P1#41） */
    fun mkdir(url: String, user: String, pwd: String) {
        val dir = url.substringBeforeLast('/') + "/"
        val req = Request.Builder()
            .url(dir)
            .header("Authorization", auth(user, pwd))
            .method("MKCOL", null)
            .build()
        client.newCall(req).execute().use { r ->
            if (r.isSuccessful || r.code == 405) return
            throw IOException("建目录失败 HTTP ${r.code}")
        }
    }

    /** 下载。远端文件不存在返回 null（首次同步的正常情况）。 */
    fun download(url: String, user: String, pwd: String): String? = downloadWithMeta(url, user, pwd).first

    /** 下载并返回 (内容, ETag)。ETag 用于上传时的 If-Match 冲突校验 */
    fun downloadWithMeta(url: String, user: String, pwd: String): Pair<String?, String?> {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", auth(user, pwd))
            .get()
            .build()
        client.newCall(req).execute().use { r ->
            return when {
                r.isSuccessful -> r.body?.string() to r.header("ETag")
                r.code == 404 -> null to null
                else -> throw IOException("下载失败 HTTP ${r.code}")
            }
        }
    }

    /**
     * 上传，整体覆盖。返回 HTTP 状态码。
     * ifMatch 非空时带 If-Match 头：远端 ETag 已变会返回 412，提示冲突需重新合并。
     */
    fun upload(url: String, user: String, pwd: String, text: String, ifMatch: String? = null): Int {
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", auth(user, pwd))
            .put(text.toRequestBody("application/json; charset=utf-8".toMediaType()))
        if (!ifMatch.isNullOrBlank()) builder.header("If-Match", ifMatch)
        client.newCall(builder.build()).execute().use { r -> return r.code }
    }
}
