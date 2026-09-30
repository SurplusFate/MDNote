package com.example.mdnotes

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * merge 确定性排序的纯函数单测（不依赖 Android Context）。
 * 对应审查 P0#29：同毫秒 maxBy updatedAt 必须是确定性胜负，不能随集合顺序变化。
 */
class NoteRepositoryMergeTest {

    private fun note(
        id: Long,
        updatedAt: Long,
        revision: Long = 0,
        deviceId: String = ""
    ) = Note(id = id, updatedAt = updatedAt, revision = revision, deviceId = deviceId)

    @Test
    fun `同 id 取 updatedAt 最大者`() {
        val merged = NoteRepository.merge(
            listOf(note(1, 100)),
            listOf(note(1, 200))
        )
        assertEquals(1, merged.size)
        assertEquals(200, merged[0].updatedAt)
    }

    @Test
    fun `同毫秒 updatedAt 取 revision 最大者`() {
        val merged = NoteRepository.merge(
            listOf(note(1, 100, revision = 1, deviceId = "A")),
            listOf(note(1, 100, revision = 2, deviceId = "B"))
        )
        assertEquals(2, merged[0].revision)
    }

    @Test
    fun `同毫秒同 revision 取 deviceId 字典序大者_确定性`() {
        val merged = NoteRepository.merge(
            listOf(note(1, 100, revision = 1, deviceId = "A")),
            listOf(note(1, 100, revision = 1, deviceId = "B"))
        )
        assertEquals("B", merged[0].deviceId)
    }

    @Test
    fun `超过30天墓碑被清掉`() {
        val cutoff = System.currentTimeMillis() - 31L * 24 * 3600 * 1000
        val merged = NoteRepository.merge(
            listOf(note(1, cutoff).apply { deleted = true }),
            emptyList()
        )
        assertEquals(0, merged.size)
    }

    @Test
    fun `未超期墓碑保留`() {
        val now = System.currentTimeMillis()
        val merged = NoteRepository.merge(
            listOf(note(1, now).apply { deleted = true }),
            emptyList()
        )
        assertEquals(1, merged.size)
    }

    @Test
    fun `不同 id 全部保留`() {
        val merged = NoteRepository.merge(
            listOf(note(1, 100), note(2, 200)),
            listOf(note(3, 300))
        )
        assertEquals(3, merged.size)
    }
}
