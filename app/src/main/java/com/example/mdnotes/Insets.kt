package com.example.mdnotes

import android.content.res.Configuration
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding

/**
 * 状态栏沉浸统一处理（Android 15 强制 edge-to-edge，必须显式适配）。
 *
 * 做法（固定高度版，空间精确可控）：
 * 1. enableEdgeToEdge() 让内容铺满整屏，状态栏透明浮在上面；
 * 2. 顶栏高度 = 操作区高度 + 状态栏高度，paddingTop = 状态栏高度，
 *    于是图标恰好排在状态栏下沿的操作区里 —— 一分多余空间都没有；
 * 3. 状态栏图标颜色跟随昼夜模式；
 * 4. 返回 CONSUMED，避免同一个 inset 被子 View 再消费一次。
 *
 * 为什么不用 wrap_content + minimumHeight：
 * MaterialToolbar 在 wrap_content 下会按内部内容（标题/菜单/内置 padding）自行撑高，
 * 与 minimumHeight 叠加后高度不可控，容易出现"顶栏下方一大片空白"。
 * 固定高度是精确可控的，多高的顶栏就是多高。
 *
 * 注意：调用方 layout_height 写 wrap_content 或固定值都行，运行时会被覆盖成精确值。
 *
 * @param toolbar 需要"顶到状态栏后面"的顶栏 View
 * @param onBottomInset 可选的底部 inset 回调（导航栏高度），给需要自己留白的列表用
 */
fun ComponentActivity.applyImmersiveStatusBar(
    toolbar: View,
    onBottomInset: ((Int) -> Unit)? = null
) {
    enableEdgeToEdge()

    val nightMode = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
    // 状态栏图标：亮色背景用深色图标，夜间反过来
    WindowCompat.getInsetsController(window, window.decorView)
        .isAppearanceLightStatusBars = !nightMode

    val density = resources.displayMetrics.density
    // 顶栏操作区高度：紧凑版 56dp（Material 1/2 手机标准）。
    // 改这一行即可在 56dp（紧凑）/ 64dp（M3 舒展）间切换。
    val actionBarSize = (56 * density).toInt()

    // 图标垂直居中在操作区里，再做 2dp 视觉重心微上提
    val lift = (2 * density).toInt()

    ViewCompat.setOnApplyWindowInsetsListener(toolbar) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        // 高度精确等于「操作区 + 状态栏」，不留任何多余空间
        v.updateLayoutParams { height = actionBarSize + bars.top }
        v.updatePadding(top = (bars.top - lift).coerceAtLeast(0), bottom = lift)
        onBottomInset?.invoke(bars.bottom)
        WindowInsetsCompat.CONSUMED
    }
}
