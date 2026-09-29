package com.example.mdnotes

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.example.mdnotes.databinding.ItemNoteBinding

class NoteAdapter(
    private val onClick: (Note) -> Unit,
    private val onLongClick: (Note) -> Unit = {},
    private val onSelectionChanged: (Int) -> Unit = {},
    private val onTogglePin: (Note) -> Unit = {}
) : RecyclerView.Adapter<NoteAdapter.VH>() {

    private val data = mutableListOf<Note>()

    /** 便签卡片的柔和底色轮换（白/米黄/浅蓝/浅绿/浅粉/浅紫），夜间自动换深色版本 */
    private val palette = intArrayOf(
        R.color.note_plain, R.color.note_cream, R.color.note_blue,
        R.color.note_green, R.color.note_pink, R.color.note_lilac
    )

    /** 同一条便签颜色永远稳定：id 取模轮换（同步到别的设备也是同色） */
    private fun colorOf(id: Long): Int {
        val idx = (id % palette.size).toInt()
        return palette[if (idx < 0) idx + palette.size else idx]
    }

    /** 已选中的便签 id（按 id 记，列表刷新后不会错位） */
    private val selected = linkedSetOf<Long>()

    /** 是否处于多选状态 */
    var selectionMode = false
        private set

    fun submit(list: List<Note>) {
        data.clear()
        data.addAll(list)
        if (selectionMode) {
            // 已被删除/过滤掉的条目不再计入选中
            selected.retainAll(data.map { it.id }.toSet())
            onSelectionChanged(selected.size)
        }
        notifyDataSetChanged()
    }

    // ---------- 多选 ----------

    val selectedCount: Int get() = selected.size

    fun selectedIds(): List<Long> = selected.toList()

    fun isSelected(id: Long) = selected.contains(id)

    fun allSelected() = data.isNotEmpty() && selected.size >= data.size

    /** 长按某项进入多选并选中它 */
    fun enterSelection(note: Note) {
        selectionMode = true
        selected.clear()
        selected.add(note.id)
        notifyDataSetChanged()
        onSelectionChanged(selected.size)
    }

    fun exitSelection() {
        if (!selectionMode) return
        selectionMode = false
        selected.clear()
        notifyDataSetChanged()
        onSelectionChanged(0)
    }

    fun toggle(id: Long) {
        if (!selectionMode) return
        if (!selected.add(id)) selected.remove(id)
        notifyDataSetChanged()
        onSelectionChanged(selected.size)
    }

    fun selectAll() {
        if (!selectionMode) return
        selected.clear()
        selected.addAll(data.map { it.id })
        notifyDataSetChanged()
        onSelectionChanged(selected.size)
    }

    fun clearSelection() {
        if (!selectionMode) return
        selected.clear()
        notifyDataSetChanged()
        onSelectionChanged(0)
    }

    inner class VH(val binding: ItemNoteBinding) : RecyclerView.ViewHolder(binding.root)

    /** 打开便签的防抖时间戳，避免连点重复进编辑页 */
    private var lastClickAt = 0L

    /** 按当前位置取数据，越界返回 null */
    private fun noteAt(vh: VH): Note? {
        val pos = vh.bindingAdapterPosition
        if (pos == RecyclerView.NO_POSITION || pos >= data.size) return null
        return data[pos]
    }

    /** 点击：多选状态下切换选中，否则打开便签（带防抖） */
    private fun fireClick(vh: VH) {
        val n = noteAt(vh) ?: return
        if (selectionMode) {
            toggle(n.id)
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastClickAt < 350L) return
        lastClickAt = now
        onClick(n)
    }

    /** 长按：进入多选；已在多选中则切换该项 */
    private fun fireLongClick(vh: VH) {
        val n = noteAt(vh) ?: return
        if (!selectionMode) {
            enterSelection(n)
            onLongClick(n)
        } else {
            toggle(n.id)
        }
    }

    /** 点击图钉：切换置顶（不打开便签） */
    private fun fireTogglePin(vh: VH) {
        val n = noteAt(vh) ?: return
        onTogglePin(n)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemNoteBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        val vh = VH(b)
        // 预览 TextView 开了 autoLink，内容含网址时它自身会变成 clickable 并消费触摸，
        // 导致点在预览区域时整行收不到点击（表现为"这条便签点不动"）。
        // 这里把各子 View 的点击/长按统一转发给整行；点到真链接时仍由 LinkMovementMethod 优先处理。
        val click = View.OnClickListener { fireClick(vh) }
        val longClick = View.OnLongClickListener { fireLongClick(vh); true }
        listOf(b.root, b.notePreview, b.noteTitle, b.noteTime).forEach {
            it.setOnClickListener(click)
            it.setOnLongClickListener(longClick)
        }
        // 置顶胶囊：独立点击，切换置顶，不打开便签、不进多选
        b.pinPill.setOnClickListener { fireTogglePin(vh) }
        return vh
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val n = data[position]
        val title = n.title.ifBlank { extractTitle(n.content) }
        if (title.isBlank()) {
            // 无标题便签：直接展示内容，不显示"无标题"占位
            holder.binding.noteTitle.visibility = View.GONE
            // 瀑布流卡片：行数放开一点，让长短卡片错落有致
            holder.binding.notePreview.maxLines = 8
        } else {
            holder.binding.noteTitle.visibility = View.VISIBLE
            holder.binding.noteTitle.text = title
            holder.binding.notePreview.maxLines = 6
        }
        holder.binding.notePreview.text = plainPreview(n.content)
        holder.binding.noteTime.text = formatTime(n.updatedAt)

        // MIUI 便签墙：卡片按 id 稳定轮换柔和底色
        holder.binding.root.setCardBackgroundColor(
            ContextCompat.getColor(holder.itemView.context, colorOf(n.id))
        )

        // 多选态：选中项右上角显示勾选图标，卡片加品牌色描边
        val checked = selectionMode && selected.contains(n.id)
        holder.binding.checkMark.visibility = if (checked) View.VISIBLE else View.GONE
        val density = holder.itemView.resources.displayMetrics.density
        val strokePx = (2 * density).toInt()
        // 未选中亮色模式不留描边（靠轻阴影分层）；深色模式留 1dp 细描边防糊成一片
        val isNight = (holder.itemView.resources.configuration.uiMode and
                android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
                android.content.res.Configuration.UI_MODE_NIGHT_YES
        holder.binding.root.strokeWidth = if (checked) strokePx
        else if (isNight) (1 * density).toInt() else 0
        holder.binding.root.strokeColor = ContextCompat.getColor(
            holder.itemView.context,
            if (checked) R.color.brand else R.color.card_stroke
        )

        // 置顶：仅已置顶的卡片在右下角显示橙色实心「置顶」胶囊（点一下取消置顶）；
        // 未置顶的卡保持干净、右下角留白。置顶操作走长按→顶栏批量按钮。多选态也隐藏。
        val pinned = n.pinned
        val pill = holder.binding.pinPill
        if (pinned && !selectionMode) {
            pill.visibility = View.VISIBLE
            pill.setBackgroundResource(R.drawable.bg_pin_on)
            pill.setTextColor(ContextCompat.getColor(holder.itemView.context, android.R.color.white))
            pill.contentDescription = holder.itemView.context.getString(R.string.unpin)
        } else {
            pill.visibility = View.GONE
        }
    }

    override fun getItemCount() = data.size
}
