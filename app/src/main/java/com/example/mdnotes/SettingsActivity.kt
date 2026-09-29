package com.example.mdnotes

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.lifecycle.lifecycleScope
import com.example.mdnotes.databinding.ActivitySettingsBinding
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class SettingsActivity : AppCompatActivity() {

    private lateinit var binding: ActivitySettingsBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 状态栏沉浸：白顶栏顶到状态栏后面，标题不被遮挡
        applyImmersiveStatusBar(binding.toolbar)

        binding.toolbar.setNavigationIcon(com.example.mdnotes.R.drawable.ic_back)
        binding.toolbar.setNavigationOnClickListener { finish() }

        // 工具栏自定义：v1.57 恢复。编辑器内 Vditor 工具栏现由 ToolPrefs 驱动，
        // 用户可在此勾选/排序内置工具、新建自定义插入文本按钮。
        binding.entryToolbar.setOnClickListener {
            startActivity(Intent(this, ToolbarEditorActivity::class.java))
        }

        // 调试日志开关：默认关闭。开发/排查问题打开，编辑页底部会出现浮层。
        binding.chkDebug.isChecked = DebugPref.enabled(this)
        binding.rowDebug.setOnClickListener { binding.chkDebug.toggle() }
        binding.chkDebug.setOnCheckedChangeListener { _, checked ->
            DebugPref.save(this, checked)
        }

        setupAppearance()

        // 回填已保存的配置
        binding.urlInput.setText(Config.url(this))
        binding.userInput.setText(Config.user(this))
        binding.pwdInput.setText(Config.pwd(this))

        binding.btnSave.setOnClickListener {
            val url = binding.urlInput.text?.toString()?.trim().orEmpty()
            val user = binding.userInput.text?.toString()?.trim().orEmpty()
            val pwd = binding.pwdInput.text?.toString()?.trim().orEmpty()
            if (url.isBlank() || user.isBlank() || pwd.isBlank()) {
                toast(getString(R.string.toast_fill_three))
                return@setOnClickListener
            }
            Config.save(this, url, user, pwd)
            toast(getString(R.string.toast_saved_sync))
            finish()
        }

        binding.btnTest.setOnClickListener { testConnection() }
    }

    // ---------- 外观 ----------

    private fun setupAppearance() {
        binding.rowTextSize.setOnClickListener { showGlobalTextSizeDialog() }
        binding.rowFamily.setOnClickListener { showFamilyDialog() }
        binding.rowTheme.setOnClickListener { showThemeDialog() }
        refreshAppearanceValues()
    }

    private fun refreshAppearanceValues() {
        binding.valTextSize.text = "${Appearance.textSize(this)} sp"
        binding.valFamily.text = Appearance.familyName(this)
        binding.valTheme.text = Appearance.themeName(this)
    }

    /** 全局字号：滑条即存即生效（编辑页 onResume 会重新套用） */
    private fun showGlobalTextSizeDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_font_size, null)
        val spLabel = view.findViewById<TextView>(R.id.spLabel)
        val spSeek = view.findViewById<SeekBar>(R.id.spSeek)
        view.findViewById<MaterialCheckBox>(R.id.chkFollow).visibility =
            View.GONE   // 全局档没有「跟随」一说

        spSeek.max = Appearance.MAX_SP - Appearance.MIN_SP
        spSeek.progress = Appearance.textSize(this) - Appearance.MIN_SP
        spLabel.text = "${Appearance.textSize(this)} sp"

        spSeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, p: Int, fromUser: Boolean) {
                if (!fromUser) return
                val sp = p + Appearance.MIN_SP
                spLabel.text = "$sp sp"
                Appearance.saveTextSize(this@SettingsActivity, sp)
                refreshAppearanceValues()
            }
            override fun onStartTrackingTouch(sb: SeekBar?) = Unit
            override fun onStopTrackingTouch(sb: SeekBar?) = Unit
        })

        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.row_global_text_size)
            .setView(view)
            .setPositiveButton(R.string.dlg_done, null)
            .show()
    }

    private fun showFamilyDialog() {
        val names = Appearance.families.map { it.second }.toTypedArray()
        val checked = Appearance.families.indexOfFirst { it.first == Appearance.family(this) }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.row_font_family)
            .setSingleChoiceItems(names, checked) { d, which ->
                Appearance.saveFamily(this, Appearance.families[which].first)
                refreshAppearanceValues()
                d.dismiss()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun showThemeDialog() {
        val names = Appearance.themes.map { it.second }.toTypedArray()
        val checked = Appearance.themes.indexOfFirst { it.first == Appearance.themeMode(this) }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.row_theme)
            .setSingleChoiceItems(names, checked) { d, which ->
                val mode = Appearance.themes[which].first
                Appearance.saveTheme(this, mode)
                AppCompatDelegate.setDefaultNightMode(mode)   // 立即生效：活动自动重建
                d.dismiss()
            }
            .setNegativeButton(R.string.action_cancel, null)
            .show()
    }

    private fun testConnection() {
        val url = binding.urlInput.text?.toString()?.trim().orEmpty()
        val user = binding.userInput.text?.toString()?.trim().orEmpty()
        val pwd = binding.pwdInput.text?.toString()?.trim().orEmpty()
        if (url.isBlank() || user.isBlank() || pwd.isBlank()) {
            toast(getString(R.string.toast_test_fill))
            return
        }

        val btn = binding.btnTest
        btn.isEnabled = false
        btn.text = getString(R.string.testing)

        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    WebDav.mkdir(url, user, pwd)        // 目录不存在就建一个
                    WebDav.download(url, user, pwd)     // 拿到 null 说明文件还没建
                }
            }
            result
                .onSuccess { content ->
                    toast(
                        if (content == null) getString(R.string.webdav_empty)
                        else getString(R.string.webdav_has_data)
                    )
                }
                .onFailure { e ->
                    val msg = e.message ?: ""
                    toast(
                        when {
                            msg.contains("401") -> getString(R.string.webdav_err_401)
                            msg.contains("404") -> getString(R.string.webdav_err_404)
                            msg.contains("409") -> getString(R.string.webdav_err_409)
                            else -> getString(R.string.webdav_err_other, msg)
                        }
                    )
                }
            btn.isEnabled = true
            btn.text = getString(R.string.btn_test)
        }
    }
}
