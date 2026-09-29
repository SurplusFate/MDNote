package com.example.mdnotes

import android.app.AlertDialog
import android.os.Bundle
import android.text.InputFilter
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.example.mdnotes.databinding.ActivityToolbarEditorBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import java.util.Collections

/**
 * 工具栏编辑器：决定键盘辅助栏上有哪些按钮、什么顺序。
 *
 * 三段式列表：
 * 1. 工具栏中 —— 长按拖动排序，垃圾桶移出；
 * 2. 未启用  —— 点 + 加回来（内置 + 自建里没启用的都在这）；
 * 3. 自定义工具 —— 新建"名称 + 插入文本"的工具，建好即上栏，铅笔可改可删。
 *
 * 数据只有一个来源：rows 里的 Enabled 行顺序 = 工具栏顺序，
 * 拖动交换后从 rows 重提 enabledIds 存盘，永远不会出现两处顺序打架。
 */
class ToolbarEditorActivity : AppCompatActivity() {

    private lateinit var binding: ActivityToolbarEditorBinding
    private lateinit var adapter: ToolRowAdapter
    private var cfg: ToolConfig = ToolConfig(emptyList(), emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityToolbarEditorBinding.inflate(layoutInflater)
        setContentView(binding.root)

        applyImmersiveStatusBar(binding.toolbar)
        binding.toolbar.setNavigationIcon(com.example.mdnotes.R.drawable.ic_back)
        binding.toolbar.setNavigationOnClickListener { finish() }

        cfg = ToolPrefs.load(this)
        adapter = ToolRowAdapter()
        binding.list.layoutManager = LinearLayoutManager(this)
        binding.list.adapter = adapter
        ItemTouchHelper(dragHelper).attachToRecyclerView(binding.list)
        adapter.rebuild()
    }

    // ---------- 行模型 ----------

    private sealed class Row {
        class Header(val title: String) : Row()
        class Enabled(val tool: Tool) : Row()
        class Disabled(val tool: Tool) : Row()
        object AddCustom : Row()
    }

    // ---------- Adapter ----------

    private class HeaderHolder(v: View) : RecyclerView.ViewHolder(v) {
        val title: TextView = v.findViewById(R.id.title)
    }

    private class EnabledHolder(v: View) : RecyclerView.ViewHolder(v) {
        val label: TextView = v.findViewById(R.id.label)
        val btnEdit: ImageButton = v.findViewById(R.id.btnEdit)
        val btnRemove: ImageButton = v.findViewById(R.id.btnRemove)
    }

    private class DisabledHolder(v: View) : RecyclerView.ViewHolder(v) {
        val label: TextView = v.findViewById(R.id.label)
        val btnEdit: ImageButton = v.findViewById(R.id.btnEdit)
        val btnAdd: ImageButton = v.findViewById(R.id.btnAdd)
    }

    private class AddCustomHolder(v: View) : RecyclerView.ViewHolder(v)

    inner class ToolRowAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

        private var rows: MutableList<Row> = mutableListOf()

        fun rebuild() {
            rows = mutableListOf()
            rows.add(Row.Header(getString(R.string.toolbar_header_enabled)))
            cfg.resolve().forEach { rows.add(Row.Enabled(it)) }
            rows.add(Row.Header(getString(R.string.toolbar_header_disabled)))
            cfg.disabledTools().forEach { rows.add(Row.Disabled(it)) }
            rows.add(Row.Header(getString(R.string.toolbar_header_custom)))
            rows.add(Row.AddCustom)
            notifyDataSetChanged()
        }

        /** 从行表重提启用顺序（拖动交换后调用），顺带存盘 */
        fun syncOrderFromRows() {
            cfg = cfg.copy(enabledIds = rows.filterIsInstance<Row.Enabled>().map { it.tool.id })
            ToolPrefs.save(this@ToolbarEditorActivity, cfg)
        }

        /** 拖动换位：rows 交换 + 启用顺序落盘；不 rebuild，别打断拖动手感 */
        fun moveRow(from: Int, to: Int) {
            Collections.swap(rows, from, to)
            syncOrderFromRows()
        }

        override fun getItemViewType(position: Int): Int = when (rows[position]) {
            is Row.Header -> 0
            is Row.Enabled -> 1
            is Row.Disabled -> 2
            Row.AddCustom -> 3
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val inf = LayoutInflater.from(parent.context)
            return when (viewType) {
                0 -> HeaderHolder(inf.inflate(R.layout.item_tool_header, parent, false))
                1 -> EnabledHolder(inf.inflate(R.layout.item_tool_enabled, parent, false))
                2 -> DisabledHolder(inf.inflate(R.layout.item_tool_disabled, parent, false))
                else -> AddCustomHolder(inf.inflate(R.layout.item_tool_add_custom, parent, false))
            }
        }

        override fun getItemCount(): Int = rows.size

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            when (val row = rows[position]) {
                is Row.Header -> (holder as HeaderHolder).title.text = row.title
                is Row.Enabled -> bindEnabled(holder as EnabledHolder, row.tool)
                is Row.Disabled -> bindDisabled(holder as DisabledHolder, row.tool)
                Row.AddCustom -> holder.itemView.setOnClickListener { showCustomDialog(null) }
            }
        }

        private fun bindEnabled(h: EnabledHolder, tool: Tool) {
            h.label.text = tool.label
            h.btnEdit.isVisible = tool is Tool.Custom
            h.btnEdit.setOnClickListener { showCustomDialog(tool as Tool.Custom) }
            h.btnRemove.setOnClickListener {
                cfg = cfg.copy(enabledIds = cfg.enabledIds - tool.id)
                persist()
            }
        }

        private fun bindDisabled(h: DisabledHolder, tool: Tool) {
            h.label.text = tool.label
            h.btnEdit.isVisible = tool is Tool.Custom
            h.btnEdit.setOnClickListener { showCustomDialog(tool as Tool.Custom) }
            h.btnAdd.setOnClickListener {
                // 启用 = 排到工具栏末尾
                cfg = cfg.copy(enabledIds = cfg.enabledIds + tool.id)
                persist()
            }
        }
    }

    // ---------- 拖拽排序：只在"工具栏中"区域内换位 ----------

    private val dragHelper = object : ItemTouchHelper.Callback() {
        override fun getMovementFlags(rv: RecyclerView, vh: RecyclerView.ViewHolder): Int =
            if (vh is EnabledHolder)
                makeMovementFlags(ItemTouchHelper.UP or ItemTouchHelper.DOWN, 0)
            else 0

        override fun onMove(
            rv: RecyclerView, vh: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder
        ): Boolean {
            val from = vh.adapterPosition
            val to = target.adapterPosition
            if (from == RecyclerView.NO_POSITION || to == RecyclerView.NO_POSITION) return false
            // 只允许 Enabled 行之间交换：header / 未启用 / 新建入口都拦在外面
            if (target !is EnabledHolder) return false
            val adapter = rv.adapter as ToolRowAdapter
            adapter.notifyItemMoved(from, to)
            // 行表换位后同步启用顺序；不走 rebuild，避免打断拖动手感
            adapter.moveRow(from, to)
            return true
        }

        override fun onSwiped(vh: RecyclerView.ViewHolder, dir: Int) = Unit

        override fun canDropOver(
            rv: RecyclerView, current: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder
        ): Boolean = target is EnabledHolder

        override fun isLongPressDragEnabled(): Boolean = true
    }

    // ---------- 增删改 ----------

    private fun persist() {
        ToolPrefs.save(this, cfg)
        adapter.rebuild()
    }

    /** 新建 / 编辑自定义工具；existing == null 时是新建 */
    private fun showCustomDialog(existing: Tool.Custom?) {
        val view = layoutInflater.inflate(R.layout.dialog_custom_tool, null)
        val nameInput = view.findViewById<TextInputEditText>(R.id.nameInput)
        val textInput = view.findViewById<TextInputEditText>(R.id.textInput)
        nameInput.filters = arrayOf(InputFilter.LengthFilter(6))
        existing?.let {
            nameInput.setText(it.label)
            textInput.setText(it.text)
        }

        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(if (existing == null) getString(R.string.custom_tool_new_title) else getString(R.string.custom_tool_edit_title))
            .setView(view)
            .setPositiveButton(R.string.dlg_save, null)   // 校验失败时不能关，点了再自己接管
            .setNegativeButton(R.string.action_cancel, null)
            .apply {
                if (existing != null) {
                    setNeutralButton(R.string.action_delete) { _, _ -> deleteCustom(existing) }
                }
            }
            .create()

        dialog.show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
            val label = nameInput.text?.toString()?.trim().orEmpty()
            val text = textInput.text?.toString() ?: ""
            if (label.isEmpty() || text.isEmpty()) {
                toast(getString(R.string.toast_name_text_required))
                return@setOnClickListener
            }
            if (existing == null) {
                // 新建即启用：直接排到工具栏末尾，立刻可见
                val tool = Tool.Custom("c_${System.currentTimeMillis()}", label, text)
                cfg = cfg.copy(
                    customs = cfg.customs + tool,
                    enabledIds = cfg.enabledIds + tool.id
                )
            } else {
                cfg = cfg.copy(customs = cfg.customs.map {
                    if (it.id == existing.id) it.copy(label = label, text = text) else it
                })
            }
            persist()
            dialog.dismiss()
        }
    }

    private fun deleteCustom(tool: Tool.Custom) {
        cfg = cfg.copy(
            customs = cfg.customs.filter { it.id != tool.id },
            enabledIds = cfg.enabledIds - tool.id
        )
        persist()
        toast(getString(R.string.toast_deleted_custom, tool.label))
    }
}
