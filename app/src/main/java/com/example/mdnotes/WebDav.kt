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
        pref(ctx).edit()
            .putString(K_URL, url.trim())
            .putString(K_USER, user.trim())
            .putString(K_PWD, pwd.trim())
            .apply()
    }

    fun url(ctx: Context) = pref(ctx).getString(K_URL, "") ?: ""
    fun user(ctx: Context) = pref(ctx).getString(K_USER, "") ?: ""
    fun pwd(ctx: Context) = pref(ctx).getString(K_PWD, "") ?: ""
    fun ready(ctx: Context) = url(ctx).isNotBlank() && user(ctx).isNotBlank()
}

/**
 * 极简 WebDAV 客户端。
 * 便签同步只需要三个动作：建目录(MKCOL)、下载(GET)、上传(PUT)。
 */
object WebDav {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun auth(user: String, pwd: String) = Credentials.basic(user, pwd)

    /** 建目录。目录已存在会返回 405，忽略就行 */
    fun mkdir(url: String, user: String, pwd: String) {
        val dir = url.substringBeforeLast('/') + "/"
        val req = Request.Builder()
            .url(dir)
            .header("Authorization", auth(user, pwd))
            .method("MKCOL", null)
            .build()
        runCatching { client.newCall(req).execute().close() }
    }

    /** 下载。远端文件不存在返回 null（首次同步的正常情况） */
    fun download(url: String, user: String, pwd: String): String? {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", auth(user, pwd))
            .get()
            .build()
        client.newCall(req).execute().use { r ->
            return when {
                r.isSuccessful -> r.body?.string()
                r.code == 404 -> null
                else -> throw IOException("下载失败 HTTP ${r.code}")
            }
        }
    }

    /** 上传，整体覆盖 */
    fun upload(url: String, user: String, pwd: String, text: String) {
        val req = Request.Builder()
            .url(url)
            .header("Authorization", auth(user, pwd))
            .put(text.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        client.newCall(req).execute().use { r ->
            if (!r.isSuccessful) throw IOException("上传失败 HTTP ${r.code}")
        }
    }
}
