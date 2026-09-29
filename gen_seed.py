#!/usr/bin/env python3
# 生成演示图 + 默认便签，写入 Seed.kt（由 GSON 解析）
import json, base64, io, datetime
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

# ---------- 1. 画一张演示图（JPEG，离线可显示）----------
W, H = 1000, 560
fig = plt.figure(figsize=(W/100, H/100), dpi=100)
ax = fig.add_axes([0, 0, 1, 1]); ax.axis("off")
ax.set_xlim(0, W); ax.set_ylim(0, H)

# 暖白底 + 顶部品牌橙渐变条（用两块矩形近似）
ax.add_patch(plt.Rectangle((0, 0), W, H, color="#F7F4EF"))
ax.add_patch(plt.Rectangle((0, H-150), W, 150, color="#FBE7D2"))

ax.text(60, H-78, "Markdown Notes", fontsize=40, fontweight="bold",
        color="#A36731", va="center")
ax.text(62, H-128, "local-first . typora-style live preview", fontsize=18,
        color="#9A8E7E", va="center")

chips = ["HEADINGS", "BOLD / ITALIC", "LISTS", "TASKS",
         "CODE", "TABLE", "QUOTE", "MATH", "LINK", "IMAGE"]
n = len(chips); cols = 5
cw, ch = 168, 92
gx, gy = 40, 30
for i, c in enumerate(chips):
    r, col = divmod(i, cols)
    x = gx + col*(cw+18)
    y = 250 - r*(ch+18)
    color = "#A36731" if i % 2 == 0 else "#7A4A1F"
    ax.add_patch(FancyBboxPatch((x, y), cw, ch,
                 boxstyle="round,pad=0.02,rounding_size=18",
                 linewidth=0, facecolor=color, alpha=0.92))
    ax.text(x+cw/2, y+ch/2, c, fontsize=15, fontweight="bold",
            color="white", ha="center", va="center")

ax.text(60, 24, "everything you see is plain Markdown", fontsize=15,
        color="#B7A99A", va="center")

buf = io.BytesIO()
fig.savefig(buf, format="jpeg", dpi=100)
plt.close(fig)
img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

# ---------- 2. 默认便签内容 ----------
notes = []

notes.append({
    "id": 1001,
    "title": "🌟 欢迎使用 Markdown 便签",
    "content": """# 👋 欢迎使用 Markdown 便签

这是一款 **Typora 式即时渲染** 的本地 Markdown 笔记 —— 边写边渲染，不用切预览。

## 它能做什么
- ✍️ 写 **Markdown**，正文即时渲染成美观排版
- 🖼️ 插入图片、🔗 链接、📊 表格、🧮 数学公式
- ☁️ 通过 WebDAV 在多台手机间同步
- 🎨 工具栏可自定义，常用插入文本一键搞定

> 试试：点开下面的便签，看看各种语法是怎么渲染的。

点右上角 **＋** 新建一条便签，开始记录吧。
"""
})

notes.append({
    "id": 1002,
    "title": "✍️ 文本样式",
    "content": """# 文本样式

## 标题层级
# 一级标题
## 二级标题
### 三级标题

## 行内样式
这是 **加粗**、*斜体*、~~删除线~~、<u>下划线</u> 和 `行内代码`。

高亮效果用 ==两个等号== 包住。

## 引用
> 引用可以是一句话。
> 也能写成多行，用来强调重点。

---

上面是一条分割线，用来分隔内容区块。
"""
})

notes.append({
    "id": 1003,
    "title": "📋 列表与任务",
    "content": """# 列表与任务

## 无序列表
- 苹果
- 香蕉
  - 水果里的香蕉（支持嵌套）
- 橙子

## 有序列表
1. 第一步
2. 第二步
3. 第三步

## 任务清单
- [x] 已经完成的任务
- [ ] 待办任务一
- [ ] 待办任务二

勾选框会随编辑实时更新状态。
"""
})

notes.append({
    "id": 1004,
    "title": "💻 代码块",
    "content": """# 代码块

行内代码这样写：`val answer = 42`。

## Kotlin
```kotlin
fun greet(name: String): String {
    return "你好, $name!"
}
```

## Python
```python
def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

## Shell
```bash
git commit -m "初版便签"
```
"""
})

notes.append({
    "id": 1005,
    "title": "📊 表格与引用",
    "content": """# 表格与引用

## 表格
| 功能 | 语法 | 说明 |
| --- | --- | --- |
| 加粗 | `**文字**` | 强调重点 |
| 链接 | `[文字](url)` | 跳转网页 |
| 代码 | `` `code` `` | 行内代码 |

## 引用
> 便签属于你自己：数据存在本机 `notes.json`，
> 同步也只用你自己的 WebDAV，不经过任何第三方服务器。

表格在手机上会自动横向适应屏幕宽度。
"""
})

notes.append({
    "id": 1006,
    "title": "🧮 数学公式",
    "content": """# 数学公式

行内公式用单个美元符号，例如质能方程 $E = mc^2$。

块级公式用两个美元符号：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

矩阵也能写：

$$
\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}
\\begin{bmatrix} x \\\\ y \\end{bmatrix}
=
\\begin{bmatrix} ax + by \\\\ cx + dy \\end{bmatrix}
$$

> 公式由内置的 KaTeX 渲染，离线也能用。
"""
})

notes.append({
    "id": 1007,
    "title": "🖼️ 图片",
    "content": """# 图片

便签里的图片存在本机，跟着笔记一起同步，换设备也能看到。

下面是内置的一张演示图：

![Markdown 便签功能速览](img://seed_features)

## 怎么加图
- 点工具栏的 📷 从相册选图
- 图片会自动压缩并内嵌进这条便签
- 正文里用 `![说明](img://key)` 引用

图片、文字、格式全部是纯 Markdown，导出无障碍。
""",
    "images": {"seed_features": img_b64}
})

# ---------- 3. 写出种子 JSON 资源 + 读取它的 Seed.kt ----------
# 把 JSON 放进 assets/seed_notes.json，运行时直接读 —— 彻底绕开 Kotlin 字符串模板
# 对 $ 的转义问题（代码块里的 $name、公式里的 $E 等），也避免 \n 二次转义。
payload = json.dumps(notes, ensure_ascii=False, indent=0)

assets_dir = "/root/.codebuddy/artifact/MdNotes/MdNotes-Phone/app/src/main/assets"
import os
os.makedirs(assets_dir, exist_ok=True)
with open(os.path.join(assets_dir, "seed_notes.json"), "w", encoding="utf-8") as f:
    f.write(payload)

seed_kt = '''package com.example.mdnotes

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * 首次启动时的内置示例便签（功能展示用）。
 *
 * 只在「从未种过」时写入一次：用 SharedPreferences 标记 gate，
 * 且写入前按标题去重，用户删掉示例后重装也不会凭空再生出来。
 * 图片走和正式便签一样的 images 自托管表（img://key），离线也能显示。
 * 种子内容放在 assets/seed_notes.json，运行时直接读，避免字符串转义坑。
 */
object Seed {
    private const val ASSET = "seed_notes.json"
    private const val PREF = "mdnotes_seed"
    private const val KEY = "seeded"

    fun ensure(ctx: Context) {
        val sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
        if (sp.getBoolean(KEY, false)) return

        val json = ctx.assets.open(ASSET)
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        val type = object : TypeToken<MutableList<Note>>() {}.type
        val list = Gson().fromJson<MutableList<Note>>(json, type) ?: return

        val existing = NoteRepository.loadAll(ctx).map { it.title }.toSet()
        val fresh = list.filter { it.title !in existing }
        if (fresh.isNotEmpty()) {
            // 让示例按加入顺序排在列表顶部，且日期显示为「刚刚 / 几分钟前」
            val base = System.currentTimeMillis()
            fresh.forEachIndexed { i, n -> n.updatedAt = base - (fresh.size - 1 - i) * 60_000L }
            val all = NoteRepository.loadAll(ctx)
            all.addAll(fresh)
            NoteRepository.saveAll(ctx, all)
        }
        sp.edit().putBoolean(KEY, true).apply()
    }
}
'''

out = "/root/.codebuddy/artifact/MdNotes/MdNotes-Phone/app/src/main/java/com/example/mdnotes/Seed.kt"
with open(out, "w", encoding="utf-8") as f:
    f.write(seed_kt)
print("wrote", out, "notes=", len(notes), "img_b64_len=", len(img_b64))
