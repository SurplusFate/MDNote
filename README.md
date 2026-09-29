# MD便签 · 手机版（Android Code Studio 专用）

Kotlin + XML 原生项目，**Groovy DSL** 构建脚本，专为手机上的
**Android Code Studio（nullij）** 适配。支持 Markdown 编辑/预览 + WebDAV 多设备同步。

---

## 一、三步在手机上跑起来

### 1. 放到正确目录（这步错了就会报 PROJECT_NOT_FOUND）

用 ZArchiver / MT 管理器把 `MdNotes-Phone` 整个文件夹解压移动到：

```
/storage/emulated/0/AndroidCSProjects/MdNotes-Phone/
```

新版 ACS 用 **AndroidCSProjects**，老版用 **AndroidIDEProjects**，
两个都试一下（就是「内部存储」根目录下那个文件夹）。

> 关键：打开时要选到 **MdNotes-Phone 这一层**，进去就能看到
> `settings.gradle` 和 `build.gradle` 两层文件。选它的父目录一定报错。

### 2. 确认 JDK 17

设置 → Build & Run → Gradle Options → JDK Version → 选 **17**。
（ACS 自带 JDK 11 和 17，默认就是 17；AGP 8.x 必须要 17。）

### 3. 同步 → 运行

打开项目 → 等 Gradle Sync（第一次会下 Gradle 8.9 + 一堆依赖，走腾讯镜像，
Wi-Fi 下大概几分钟，**别断网**）→ 点运行，装到你手机上。

编译好的 APK 在：
```
/storage/emulated/0/AndroidCSProjects/MdNotes-Phone/app/build/outputs/apk/debug/
```

---

## 二、和电脑版的区别（为什么重做一版）

| 改动 | 原因 |
|---|---|
| 构建脚本改成 **Groovy DSL**（`build.gradle` 而非 `.kts`） | 手机 IDE 的 Gradle 解析器对 Groovy 兼容更好，是 PROJECT_NOT_FOUND 最常见的原因 |
| 去掉 `android.nonTransitiveRClass` | 避免手机端 R 类解析异常 |
| 返回键图标改成自带 `ic_back.xml` | 不再引用 appcompat 内部资源，少一个出错点 |
| 去掉 `androidx.preference` 依赖 | 本项目没用到，手机上能少下载一个库 |
| `org.gradle.jvmargs` 降到 1536m、关 daemon | 手机内存有限，防 OOM |
| `lintOptions.abortOnError false` | 手机端 lint 常误报，别让它拦住构建 |

---

## 三、依赖源（国内直连，已实测）

全部走 `https://mirrors.cloud.tencent.com/nexus/repository/maven-public/`，
18 个依赖逐个 curl 验证过 HTTP 200：

AGP 8.7.3 · Kotlin 1.9.25 · Gradle 8.9 · androidx 全家桶 · Material 1.12.0 ·
Markwon 4.6.2（core/editor/tables/tasklist/strikethrough）· OkHttp 4.12.0 · Gson 2.11.0

Gradle 发行版也走腾讯：`gradle-8.9-bin.zip`，实测 8 秒 90MB。

---

## 四、可能遇到的坑

**① 报 "Failed to find Build Tools revision 35.0.0"**
说明手机的 Android SDK 里没装编译工具。开底部 Terminal 执行：

```bash
sdkmanager "platforms;android-35" "build-tools;35.0.0"
```

装完重启 IDE。如果嫌麻烦，把 `app/build.gradle` 里的
`compileSdk 35` 和 `targetSdk 35` 都改成手机 SDK 已有的版本（32/33/34 都行）。

**② 报 "SDK location not found"**
在文件管理器里建一个 `local.properties` 放到项目根目录，内容：
```
sdk.dir=/storage/emulated/0/Android/Sdk
```
（具体路径在 ACS 设置 → IDE Configuration 里能看到。）

**③ Gradle 下载卡住**
第一次同步最慢，因为要下 Gradle + 全部依赖。保持在 Wi-Fi 下、别锁屏。
如果一直卡，关掉 IDE 重开让它重试。

**④ 编译成功但装不上**
Android 16 上装第三方 APK 需要授权「允许来自此来源的应用」，
另外本 App minSdk 26，你的设备 API 36，向下兼容没问题。

---

## 五、目录结构

```
app/src/main/java/com/example/mdnotes/
├── Note.kt              数据模型（deleted 墓碑标记）
├── Util.kt              toast / 时间格式化 / 列表预览
├── WebDav.kt            Config（配置存取）+ WebDav（MKCOL/GET/PUT）
├── NoteRepository.kt    本地 notes.json 读写 + 同步合并
├── Md.kt                Markwon 渲染封装
├── NoteAdapter.kt       列表适配器
├── MainActivity.kt      列表：搜索、新建、同步
├── EditActivity.kt      编辑：Markdown 快捷栏 + 预览
└── SettingsActivity.kt  WebDAV 设置 + 测试连接
```

---

## 六、WebDAV 怎么填

App 内：右上角菜单 → **设置** → 填三项 → **测试连接** → 保存 → 回列表点 **同步**。

| 服务商 | 地址 | 免费额度 |
|---|---|---|
| 坚果云 | `https://dav.jianguoyun.com/dav/notes/notes.json` | 月上传 1GB / 下载 3GB |
| InfiniCLOUD | My Page → 打开 Apps Connection 才给 | 20GB 永久，不限流量 |

两个坑：
- 坚果云要用「安全选项 → 第三方应用管理」生成的**应用密码**，不是登录密码
- 路径里的文件夹（如 `notes`）要先在网页端建好

同步合并规则：按 id 分组，保留更新时间最晚的版本。
同一条在两台机器都改过 → 时间晚的赢，早的那次编辑会丢。改之前先同步一次可降低风险。
