package com.example.mdnotes

/**
 * 一条便签。
 *
 * deleted 是「墓碑」标记：删除时不真的抹掉数据，而是打个标记 + 更新时间。
 * 这样另一台设备同步时才知道「这条被删了」，而不是以为对面从来没这条。
 * 老数据没有这个字段，Gson 反序列化时会填默认值 false，向下兼容。
 *
 * images 是便签里内嵌的图片：key → 图片数据（JPEG 的 Base64，不带 data URI 前缀），
 * 正文里用 `![说明](img://key)` 引用。图片跟 notes.json 存在一起，
 * 所以 WebDAV 同步完全不用改——换设备也能看到图。
 * 老数据的 json 没这个字段，Gson 反序列化后是 null，统一走 imageMap() 取值。
 *
 * fontSize 是这条便签独立的字号（sp）；null = 跟随设置里的全局字号。
 *
 * pinned 是置顶标记：true 时这条便签永远排在列表最前面（置顶组内部再按更新时间排）。
 * 置顶是独立于内容的标记，切换置顶不改 updatedAt，免得把便签顺带挤到时间序顶端。
 * 老数据没有这个字段，Gson 反序列化时填默认值 false，向下兼容。
 *
 * revision / deviceId 是同步冲突解决的稳定排序键（Sprint 1 数据安全）：
 * 每次落盘 +1，merge 时按 (updatedAt, revision, deviceId) 取最大者，保证同设备后写胜出、
 * 不同设备冲突有确定胜负，避免「同毫秒 maxBy updatedAt」的非确定结果。
 * 老数据缺这俩字段时 Gson 填默认值（0 / 空串），首次保存时补上，向下兼容。
 */
data class Note(
    var id: Long = 0L,
    var title: String = "",
    var content: String = "",
    var updatedAt: Long = System.currentTimeMillis(),
    var deleted: Boolean = false,
    var images: MutableMap<String, String>? = null,
    var fontSize: Int? = null,
    var pinned: Boolean = false,
    var revision: Long = 0L,
    var deviceId: String = ""
) {
    /** 取图片表；老数据没有这个字段时给个空表，省得每处都判空 */
    fun imageMap(): MutableMap<String, String> = images ?: mutableMapOf()
}
