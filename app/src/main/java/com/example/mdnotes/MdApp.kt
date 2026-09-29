package com.example.mdnotes

import android.app.Application
import androidx.appcompat.app.AppCompatDelegate

/**
 * 进程启动时把存储的主题模式套上。
 * 之后改主题走 AppCompatDelegate.setDefaultNightMode（会自动重建活动）。
 */
class MdApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppCompatDelegate.setDefaultNightMode(Appearance.themeMode(this))
    }
}