package com.example.mdnotes

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import androidx.activity.addCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.core.widget.doOnTextChanged
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.StaggeredGridLayoutManager
import com.example.mdnotes.databinding.ActivityMainBinding
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var adapter: NoteAdapter

    /** 首页是否处于多选状态 */
    private var selectionMode = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 首次启动写入内置示例便签（功能展示），之后靠 SharedPreferences 标记不再重复
        Seed.ensure(this)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // 状态栏沉浸：顶栏顶到状态栏后面，标题不被遮挡
        // 底部 inset 用来把 FAB 和列表底部留白抬到导航栏之上
        applyImmersiveStatusBar(binding.toolbar) { bottom ->
            val listBottom = bottom + (72 * resources.displayMetrics.density).toInt()
            binding.recycler.updatePadding(bottom = listBottom)
            binding.fabAdd.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                bottomMargin = bottom + (16 * resources.displayMetrics.density).toInt()
            }
        }

        adapter = NoteAdapter(
            onClick = { note -> openEdit(note.id) },
            onLongClick = { enterSelectionMode() },
            onSelectionChanged = { count -> onSelectionCountChanged(count) },
            onTogglePin = { togglePin(it) }
        )
        // MIUI 便签墙：双列瀑布流，长短卡片错落
        binding.recycler.layoutManager =
            StaggeredGridLayoutManager(2, StaggeredGridLayoutManager.VERTICAL)
        binding.recycler.adapter = adapter

        binding.fabAdd.setOnClickListener { openEdit(NEW_NOTE) }

        binding.searchInput.doOnTextChanged { _, _, _, _ -> refresh() }

        binding.toolbar.inflateMenu(R.menu.main_menu)
        binding.toolbar.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.action_sync -> { doSync(); true }
                R.id.action_settings -> {
                    startActivity(Intent(this, SettingsActivity::class.java)); true
                }
                R.id.action_select_all -> {
                    if (adapter.allSelected()) adapter.clearSelection() else adapter.selectAll()
                    updateSelectionUi(); true
                }
                R.id.action_pin -> { pinSelected(); true }
                R.id.action_delete_selected -> { confirmDeleteSelected(); true }
                R.id.action_cancel_selection -> { exitSelectionMode(); true }
                else -> false
            }
        }

        // 多选状态下按返回键先退出多选，不直接退 App
        onBackPressedDispatcher.addCallback(this) {
            if (selectionMode) {
                exitSelectionMode()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }

        refresh()
        if (Config.ready(this)) doSync()   // 打开 App 自动同步一次
    }

    override fun onResume() {
        super.onResume()
        refresh()   // 从编辑页返回时刷新列表
    }

    private fun refresh() {
        val kw = binding.searchInput.text?.toString()?.trim().orEmpty()
        val list = try {
            NoteRepository.visible(this).filter {
                kw.isBlank() || it.title.contains(kw, true) || it.content.contains(kw, true)
            }
        } catch (e: CorruptStorageException) {
            toast("数据文件损坏，已恢复上次备份；仍异常请看 notes.json.corrupt.*")
            emptyList()
        }
        adapter.submit(list)
        binding.emptyTip.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
    }

    // ---------- 多选模式 ----------

    private fun enterSelectionMode() {
        if (selectionMode) return
        selectionMode = true
        binding.toolbar.menu.clear()
        binding.toolbar.inflateMenu(R.menu.menu_selection)
        updateSelectionUi()
    }

    private fun exitSelectionMode() {
        if (!selectionMode) return
        selectionMode = false
        adapter.exitSelection()
        binding.toolbar.menu.clear()
        binding.toolbar.inflateMenu(R.menu.main_menu)
        // 首页不再显示 App 名标题，退出多选时要把"已选 N 项"清掉
        binding.toolbar.title = null
    }

    private fun onSelectionCountChanged(count: Int) {
        if (selectionMode) updateSelectionUi()
    }

    /** 刷新工具栏标题（已选 N 项）以及全选/删除按钮状态 */
    private fun updateSelectionUi() {
        if (!selectionMode) return
        binding.toolbar.title = getString(R.string.selected_count, adapter.selectedCount)
        binding.toolbar.menu.findItem(R.id.action_select_all)?.title =
            getString(if (adapter.allSelected()) R.string.action_unselect_all else R.string.action_select_all)
        binding.toolbar.menu.findItem(R.id.action_delete_selected)?.isEnabled = adapter.selectedCount > 0
        // 置顶按钮：选中项全部已置顶时显示「取消置顶」，否则「置顶」
        val sel = try {
            NoteRepository.loadAll(this).filter { it.id in adapter.selectedIds() }
        } catch (e: CorruptStorageException) {
            emptyList<Note>()
        }
        val allPinned = sel.isNotEmpty() && sel.all { it.pinned }
        binding.toolbar.menu.findItem(R.id.action_pin)?.title =
            getString(if (allPinned) R.string.action_unpin else R.string.action_pin)
    }

    private fun confirmDeleteSelected() {
        val ids = adapter.selectedIds()
        if (ids.isEmpty()) {
            toast(getString(R.string.nothing_selected))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_confirm_title)
            .setMessage(getString(R.string.delete_confirm_msg, ids.size))
            .setNegativeButton(R.string.action_cancel, null)
            .setPositiveButton(R.string.action_delete) { _, _ ->
                val n = NoteRepository.softDelete(this, ids)
                exitSelectionMode()
                refresh()
                toast(getString(R.string.deleted_count, n))
            }
            .show()
    }

    private fun openEdit(id: Long) {
        startActivity(Intent(this, EditActivity::class.java).putExtra(EditActivity.EXTRA_ID, id))
    }

    /** 单条便签切换置顶（卡片图钉触发）：即时落盘刷新，不弹 toast，靠图标变色反馈 */
    private fun togglePin(note: Note) {
        NoteRepository.togglePin(this, note.id)
        refresh()
    }

    /** 多选态：把选中项统一置顶或取消置顶（全已置顶则反操作），并提示条数 */
    private fun pinSelected() {
        val ids = adapter.selectedIds()
        if (ids.isEmpty()) {
            toast(getString(R.string.nothing_selected))
            return
        }
        val sel = NoteRepository.loadAll(this).filter { it.id in ids }
        val allPinned = sel.isNotEmpty() && sel.all { it.pinned }
        NoteRepository.setPinned(this, ids, !allPinned)
        refresh()
        toast(getString(if (allPinned) R.string.unpinned_count else R.string.pinned_count, ids.size))
    }

    private fun doSync() {
        if (!Config.ready(this)) {
            toast("先在右上角菜单 → 设置里填好 WebDAV")
            return
        }
        val item = binding.toolbar.menu.findItem(R.id.action_sync)
        item.title = "同步中…"
        lifecycleScope.launch {
            NoteRepository.sync(this@MainActivity)
                .onSuccess {
                    refresh()
                    toast("已同步，共 ${it.count { !it.deleted }} 条")
                }
                .onFailure { toast("同步失败：${it.message}") }
            item.title = getString(R.string.action_sync)
        }
    }

    companion object {
        const val NEW_NOTE = 0L
    }
}
