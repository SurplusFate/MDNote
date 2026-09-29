package com.example.mdnotes

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import kotlin.math.abs

/**
 * 预览图片的全屏查看器：黑底、单击关闭、双击放大/还原、双指缩放、放大后可拖动。
 *
 * 图片经 companion 的 pending 传递（Bitmap 走 Intent 会触发 TransactionTooLargeException，
 * 1440px 的 JPEG 解码后动辄几 MB，绝不能塞 Bundle）。本进程内静态引用最简单可靠；
 * 仅在用户真正关闭（isFinishing）时清掉，屏幕旋转重建时图片不丢。
 */
class ImageViewActivity : AppCompatActivity() {

    companion object {
        private var pending: Bitmap? = null

        fun show(ctx: Context, bmp: Bitmap) {
            pending = bmp
            ctx.startActivity(Intent(ctx, ImageViewActivity::class.java))
        }
    }

    private lateinit var imageView: ImageView
    private var lastX = 0f
    private var lastY = 0f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 纯黑全屏（沉浸），状态栏图标用亮色
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        WindowCompat.getInsetsController(window, window.decorView)
            .isAppearanceLightStatusBars = false

        imageView = ImageView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(Color.BLACK)
        }
        setContentView(imageView)
        pending?.let { imageView.setImageBitmap(it) }

        setupGestures()
    }

    /** 单击关 / 双击 2.5x 与还原 / 双指缩放 1x~5x / 放大后单指拖动 */
    private fun setupGestures() {
        val gd = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                finish()
                return true
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                val zoomed = imageView.scaleX > 1.05f
                val target = if (zoomed) 1f else 2.5f
                imageView.pivotX = e.x   // 以双击点为中心缩放，看哪放大哪
                imageView.pivotY = e.y
                imageView.animate()
                    .scaleX(target).scaleY(target)
                    .translationX(0f).translationY(0f)
                    .setDuration(180)
                    .start()
                return true
            }
        })

        val sd = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val s = (imageView.scaleX * detector.scaleFactor).coerceIn(1f, 5f)
                imageView.scaleX = s
                imageView.scaleY = s
                clampTranslation()
                return true
            }
        })

        imageView.setOnTouchListener { _, ev ->
            sd.onTouchEvent(ev)
            gd.onTouchEvent(ev)
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = ev.x
                    lastY = ev.y
                }
                MotionEvent.ACTION_MOVE -> {
                    // 放大态下拖动浏览细节；缩放手势进行中让位给双指
                    if (!sd.isInProgress && imageView.scaleX > 1.05f) {
                        imageView.translationX += ev.x - lastX
                        imageView.translationY += ev.y - lastY
                        clampTranslation()
                    }
                    lastX = ev.x
                    lastY = ev.y
                }
            }
            true
        }
    }

    /** 放大后不许把图拖出屏幕：平移量钳制在「多出来的那部分」之内 */
    private fun clampTranslation() {
        val w = imageView.width
        val h = imageView.height
        if (w <= 0 || h <= 0) return
        val maxX = w * (imageView.scaleX - 1f) / 2f
        val maxY = h * (imageView.scaleY - 1f) / 2f
        imageView.translationX = imageView.translationX.coerceIn(-maxX, maxX)
        imageView.translationY = imageView.translationY.coerceIn(-maxY, maxY)
    }

    override fun onDestroy() {
        // 用户主动关闭才释放静态引用；旋转重建（isFinishing=false）不丢图
        if (isFinishing) pending = null
        super.onDestroy()
    }
}
