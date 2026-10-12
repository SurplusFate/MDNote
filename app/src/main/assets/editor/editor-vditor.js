/**
 * editor-vditor.js —— Vditor IR 即时渲染内核的桥接层（v1.36 起替换自研 editor.js）
 *
 * 设计：暴露与旧 editor.js 同名的 window.editor API（loadMarkdown/getSource/
 * stat/probe/exitEditMode/enterEditAt/applyTheme/insertImage/undo/redo/
 * toggleSourceMode/indentLine/outdentLine/softBreak/insertText/wrapSelection/
 * applyLinePrefix），内部用 Vditor 实现。Kotlin 侧（EditActivity 的轮询/保存/
 * 主题/图片/眼睛按钮）几乎零改动即可接入。
 *
 * 为什么换内核：自研块级 live rendering 命中了所有经典坑（失焦选区、IME、虚拟块、
 * 分项渲染、缩进/换行），逐版试错成本高且易回归。Vditor 的 IR 模式是成熟的
 * Typora 式即时渲染，标题/列表/待办/缩进/换行/回车分块/撤回重做全是内置且经过
 * 大量生产验证的，从根上消除"一个一个调"。
 */
(function () {
    'use strict';

    // file:// 下离线加载 Vditor 的资源（lute/i18n/highlight.js/icons 都从这里取）。
    // 注意：Vditor 内部拼接是 ${cdn}/dist/js/...，cdn 不能带 /dist，否则变成 dist/dist 404。
    var CDN = 'file:///android_asset/editor/vditor';

    var vd = null;            // Vditor 实例
    var ready = false;        // lute 加载完、编辑器可用
    var editing = false;      // 是否处于编辑焦点（驱动工具栏/辅助栏）
    var currentMode = 'ir';   // ir（即时渲染）/ sv（源码）
    var currentNight = false; // 当前昼夜
    var pendingValue = '';    // 就绪前的待装载内容（防止轮询回写空串清掉笔记）
    var pendingTheme = null;  // 就绪前的待应用主题
    var pendingFocus = false; // 就绪前的待聚焦（新笔记自动进编辑）
    var diagTimer = null;     // v1.37 启动诊断计时器
    var mounting = false;     // v1.37 等待 Lute 期间的防重入标志

    function safe(fn) { try { return fn(); } catch (e) { return null; } }

    /** 由主题 CSS 变量推断昼夜（bg-page 亮度低即暗色） */
    function isNight(vars) {
        var bg = (vars && vars['bg-page']) || '#ffffff';
        var c = bg.replace('#', '');
        if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
        if (c.length !== 6) return false;
        var r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
        return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    }

    /** 把字号/配色注入为 CSS 变量 + 覆盖样式，让 Vditor 贴合便签主题 */
    function injectTheme(vars) {
        if (!vars) return;
        var root = document.documentElement.style;
        for (var k in vars) {
            if (k === 'night') continue;
            root.setProperty('--' + k, String(vars[k]));
        }
        var px = vars['font-px'] || '18px';
        var fam = vars['font-family'] || 'sans-serif';
        var css =
            '.vditor-reset{font-size:' + px + ' !important;font-family:' + fam + ' !important;}' +
            '.vditor-ir pre,.vditor-ir code,.vditor-reset pre,.vditor-reset code{font-size:' + px + ' !important;}' +
            '.vditor-reset{color:var(--text,#222) !important;background:var(--paper,transparent) !important;}' +
            '.vditor{border-color:transparent !important;}' +
            // v1.51 深色模式内容元素适配：Vditor 表格/引用/分割线的背景与边框是写死
            // 浅色（#fafbfc/#fff/#dfe2e5/#c6cbd1），深色模式下本 App 把正文改成浅字、
            // 页面改成深色 → 浅字落浅底"看不清"。这里用主题变量 + !important 覆盖：
            // --table-border 由 applyTheme 按昼夜注入；斑马纹/表头用半透明灰，昼夜间都清晰。
            '.vditor-reset table tr{background-color:transparent !important;border-top:1px solid var(--table-border,#d0d0d0) !important;}' +
            '.vditor-reset table td,.vditor-reset table th{border:1px solid var(--table-border,#d0d0d0) !important;' +
            'padding:6px 13px !important;color:var(--text,#222) !important;white-space:normal !important;}' +
            '.vditor-reset table th{background-color:rgba(128,128,128,0.18) !important;font-weight:600 !important;}' +
            '.vditor-reset table tbody tr:nth-child(2n){background-color:rgba(128,128,128,0.08) !important;}' +
            '.vditor-reset blockquote{border-left:4px solid var(--table-border,#d0d0d0) !important;' +
            'color:var(--text-sub,#8E8E93) !important;background:rgba(128,128,128,0.06) !important;}' +
            '.vditor-reset hr{border-color:var(--table-border,#d0d0d0) !important;}';
        var tag = document.getElementById('mdnotes-theme');
        if (!tag) {
            tag = document.createElement('style');
            tag.id = 'mdnotes-theme';
            document.head.appendChild(tag);
        }
        tag.textContent = css;
    }

    /**
     * v1.39 手机适配：窄屏 toolbar 裁到单行放得下的最小集。
     * 注：Vditor 自带 @media(max-width:520px){.vditor-toolbar__item{padding:0 12px}}
     * ——每项默认 48px 宽，十几项必然折三行。故这里同步收紧 padding（见 injectMobileCss）。
     */
    /**
     * 计算「生效的工具栏 id 列表」（用户自定义优先；否则按屏宽给内置默认）。
     * 注意：此列表含 indent/outdent——但 IR 下 Vditor 会把它们 display:none 且
     * 原生缩进失效，故 buildToolbar 会把它们剔除、改由 renderIndentTools 自绘按钮。
     */
    function effectiveIds() {
        if (__toolbarCfg && __toolbarCfg.enabled && __toolbarCfg.enabled.length) {
            var valid = __toolbarCfg.enabled.filter(function (id) {
                return TOOL_TYPES.indexOf(id) >= 0;
            });
            if (valid.length) return groupWithDividers(valid, 5);
        }
        var w = window.innerWidth || document.documentElement.clientWidth || 0;
        if (w && w < 640) {
            // 常规手机：砍掉链接/行内代码/分割线/全屏（图片走 Kotlin 工具，
            // 源码模式走顶栏眼睛按钮，全屏对手机无意义）。撤回/重做顶栏已有，
            // v1.43 起不再重复放。缩进/减缩进 v1.79 起自实现可用，放回默认栏。
            return ['headings', 'bold', 'italic', 'strike', '|',
                'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
                'quote', 'code'];
        }
        return ['headings', 'bold', 'italic', 'strike', '|',
            'link', '|',
            'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
            'quote', 'line', 'code', 'inline-code', '|',
            'undo', 'redo', '|',
            'fullscreen'];
    }

    function buildToolbar() {
        // 缩进/减缩进由自实现 DOM 按钮提供（IR 下 Vditor 会 hide 原生按钮），故剔除；
        // undo/redo 改由自实现按钮走 Kotlin 历史栈（Sprint 4 #82-7：统一单一 undo 栈，
        // 使结构变换可撤销——Vditor 原生 undo 不记录我们的 setValue 结构变换）。
        return effectiveIds().filter(function (id) {
            return id !== 'indent' && id !== 'outdent'
                && id !== 'undo' && id !== 'redo';
        });
    }

    // v1.57：用户自定义工具栏配置（由 Kotlin 经 editor.setToolbarConfig 注入）。
    // 为 null 时 buildToolbar 走上方内置默认。格式 {enabled:[type…], customs:[{id,label,text}…]}。
    var __toolbarCfg = null;

    /**
     * v1.58：JS→Kotlin 事件队列。图片这类 Kotlin 动作在这里入队，
     * 由轮询 stat() 出队、Kotlin 侧 drainJsEvents 取出执行——
     * 规避该设备 @JavascriptInterface 上行不稳的问题（与 viewImage 同通道）。
     */
    var __jsQueue = [];
    function pushEvent(m, a) { __jsQueue.push({ m: m, a: a || '' }); }

    /** Vditor 接受的内置 toolbar type 全集（与 Tool.kt builtIns 对齐）。
     *  自定义配置里非此列表的失效 id 直接过滤，避免出现 Vditor 不认识的按钮。 */
    var TOOL_TYPES = ['headings', 'bold', 'italic', 'strike', 'link', 'list',
        'ordered-list', 'check', 'quote', 'line', 'code', 'inline-code',
        'indent', 'outdent', 'undo', 'redo', 'fullscreen'];

    /** 在工具序列里每 step 项注入一个 '|' 分隔符，仅作视觉分组，不打乱用户顺序。 */
    function groupWithDividers(ids, step) {
        var out = [];
        for (var i = 0; i < ids.length; i++) {
            if (i > 0 && i % step === 0) out.push('|');
            out.push(ids[i]);
        }
        return out;
    }

    /** v1.57：把用户自建「插入文本」工具渲染成工具栏按钮。
     *  Vditor 原生 toolbar 数组不支持自定义项，故在其生成工具栏后往 .vditor-toolbar
     *  末尾追加 DOM。按钮落在工具栏内，受 editorGuardDock 的 mousedown 拦截覆盖；
     *  额外 mousedown preventDefault 防止焦点离开导致工具栏收起，点击时插入文本到光标。 */
    function renderCustomTools() {
        if (!__toolbarCfg || !__toolbarCfg.customs || !__toolbarCfg.customs.length) return;
        var tb = document.querySelector('.vditor-toolbar');
        if (!tb) return;
        var old = tb.querySelectorAll('.mdnotes-custom-tool');
        for (var k = 0; k < old.length; k++) old[k].parentNode.removeChild(old[k]);
        __toolbarCfg.customs.forEach(function (tool) {
            if (!tool || !tool.id) return;
            var item = document.createElement('div');
            item.className = 'vditor-toolbar__item mdnotes-custom-tool';
            var btn = document.createElement('div');
            btn.className = 'vditor-tooltipped vditor-tooltipped__n';
            btn.setAttribute('aria-label', tool.label || tool.text || '自定义');
            var shown = (tool.label && tool.label.length <= 4) ? tool.label
                : (tool.text && tool.text.length <= 4 ? tool.text : '★');
            btn.textContent = shown;
            btn.style.maxWidth = '44px';
            btn.style.overflow = 'hidden';
            btn.style.textOverflow = 'ellipsis';
            btn.style.whiteSpace = 'nowrap';
            item.appendChild(btn);
            item.addEventListener('mousedown', function (e) { e.preventDefault(); });
            item.addEventListener('click', function (e) {
                e.preventDefault();
                if (window.editor && window.editor.insertText && tool.text != null) {
                    window.editor.insertText(tool.text);
                }
            });
            tb.appendChild(item);
        });
    }

    /**
     * v1.58：把「图片」这类 Kotlin 驱动的「特殊内置工具」渲染成工具栏按钮。
     * 它们不是 Vditor toolbar type，buildToolbar 已把它们排除在 Vditor 数组外，
     * 这里往工具栏末尾追加 DOM；点击经事件队列回调 Kotlin 打开相册。
     * 与自定义工具同款样式、同款 mousedown 防失焦，确保点击后光标不丢、图片插在光标处。
     */
    function renderSpecialTools() {
        if (!__toolbarCfg || !__toolbarCfg.enabled) return;
        var tb = document.querySelector('.vditor-toolbar');
        if (!tb) return;
        // 先清旧的（rebuildToolbar 重挂后不会出现重复）
        var old = tb.querySelectorAll('.mdnotes-special-tool');
        for (var k = 0; k < old.length; k++) old[k].parentNode.removeChild(old[k]);
        __toolbarCfg.enabled.forEach(function (id) {
            if (id !== 'image') return;   // 目前仅有 image 一种特殊工具
            var item = document.createElement('div');
            item.className = 'vditor-toolbar__item mdnotes-special-tool';
            var btn = document.createElement('div');
            btn.className = 'vditor-tooltipped vditor-tooltipped__n';
            btn.setAttribute('aria-label', '插入图片');
            // v1.59 修「按钮能点到但完全看不见」：v1.58 这里写的是纯文本
            // textContent='图片'。工具栏里的文字被 Vditor 图标区样式吃掉
            // （.vditor-tooltipped 是给 SVG 图标用的容器，字号被压成 0），
            // 结果按钮占位可点、视觉上却是空白。改画 SVG 图标：
            // stroke/fill 用 currentColor，自动跟随工具栏图标配色（灰 / 按下橙）。
            btn.innerHTML =
                '<svg viewBox="0 0 32 32" width="16" height="16" fill="none"' +
                ' stroke="currentColor" stroke-width="2.5" aria-hidden="true">' +
                '<rect x="4" y="6" width="24" height="20" rx="2"></rect>' +
                '<circle cx="11" cy="13" r="2.5" fill="currentColor" stroke="none"></circle>' +
                '<path d="M6 23l6-7 4 4.5 3-3.5 7 6" stroke-linejoin="round"' +
                ' stroke-linecap="round"></path>' +
                '</svg>';
            item.appendChild(btn);
            item.addEventListener('mousedown', function (e) { e.preventDefault(); });
            item.addEventListener('click', function (e) {
                e.preventDefault();
                pushEvent('pickImage');   // Kotlin 轮询取出 → 打开相册
            });
            tb.appendChild(item);
        });
    }

    /** v1.79：自绘「缩进/减缩进」工具栏按钮。IR 下 Vditor 原生缩进按钮被隐藏且
     *  失效，这里用独立 DOM 按钮直连 window.editor.indentLine/outdentLine（自实现，
     *  不依赖 Vditor 的原生处理）。图标用 currentColor 跟随工具栏配色。 */
    var INDENT_SVG = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"'
        + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'
        + ' stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M7 5h10M7 10h10M7 15h10"/>'
        + '<path d="M3 7l3 3-3 3"/></svg>';
    var OUTDENT_SVG = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none"'
        + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'
        + ' stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M7 5h10M7 10h10M7 15h10"/>'
        + '<path d="M10 7l-3 3 3 3"/></svg>';

    function renderIndentTools() {
        var ids = effectiveIds();
        if (ids.indexOf('indent') < 0 && ids.indexOf('outdent') < 0) return;
        var tb = document.querySelector('.vditor-toolbar');
        if (!tb) return;
        ['outdent', 'indent'].forEach(function (type) {
            if (ids.indexOf(type) < 0) return;
            if (tb.querySelector('.mdnotes-indent-tool[data-type="' + type + '"]')) return;
            var item = document.createElement('div');
            item.className = 'vditor-toolbar__item mdnotes-indent-tool';
            item.setAttribute('data-type', type);
            var btn = document.createElement('div');
            btn.className = 'vditor-tooltipped vditor-tooltipped__n';
            btn.setAttribute('aria-label', type === 'indent' ? '缩进' : '减缩进');
            btn.innerHTML = (type === 'indent') ? INDENT_SVG : OUTDENT_SVG;
            item.appendChild(btn);
            item.addEventListener('mousedown', function (e) { e.preventDefault(); });
            item.addEventListener('click', function (e) {
                e.preventDefault();
                if (type === 'indent') window.editor.indentLine();
                else window.editor.outdentLine();
            });
            tb.appendChild(item);
        });
    }

    /** Sprint 4：自实现 撤销/前进 按钮（替代 Vditor 原生 undo/redo，后者不记录
     *  我们的 setValue 结构变换）。点击经 JS→Kotlin 队列调 Kotlin 历史栈（undoEdit/
     *  redoEdit），与顶栏 action_undo 同一个栈，统一单一 undo 来源（#82-7）。 */
    var UNDO_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/></svg>';
    var REDO_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h1"/></svg>';
    function renderHistoryTools() {
        var ids = effectiveIds();
        if (ids.indexOf('undo') < 0 && ids.indexOf('redo') < 0) return;
        var tb = document.querySelector('.vditor-toolbar');
        if (!tb) return;
        ['undo', 'redo'].forEach(function (type) {
            if (ids.indexOf(type) < 0) return;
            if (tb.querySelector('.mdnotes-history-tool[data-type="' + type + '"]')) return;
            var item = document.createElement('div');
            item.className = 'vditor-toolbar__item mdnotes-history-tool';
            item.setAttribute('data-type', type);
            var btn = document.createElement('div');
            btn.className = 'vditor-tooltipped vditor-tooltipped__n';
            btn.setAttribute('aria-label', type === 'undo' ? '撤销' : '前进');
            btn.innerHTML = (type === 'undo') ? UNDO_SVG : REDO_SVG;
            item.appendChild(btn);
            item.addEventListener('mousedown', function (e) { e.preventDefault(); });
            item.addEventListener('click', function (e) {
                e.preventDefault();
                pushEvent(type);   // 'undo' / 'redo' → Kotlin undoEdit/redoEdit（统一历史栈）
            });
            tb.appendChild(item);
        });
    }

    /** v1.57：配置变更后重建工具栏——销毁并重建 Vditor 实例，内容用当前源回填
     *  （与 toggleSourceMode 同模式）。重建后 doMount 会重新生成工具栏并渲染自定义按钮。 */
    function rebuildToolbar() {
        if (!vd || !ready) return;
        var src = getSource();
        try { vd.destroy(); } catch (e) {}
        vd = null; ready = false;
        mount(src || '');
    }

    /** v1.39 手机适配 + v1.43 主题统一：压掉 Vditor 的 12px padding、配色跟 App 主题走 */
    function injectMobileCss() {
        var css =
            // v1.43 UI 统一：工具栏/面板配色不再用 Vditor 默认灰蓝，跟 App 主题
            // （纸面色/正文次色/品牌橙）走，昼夜主题自动跟随（变量由 applyTheme 注入）
            '.vditor-toolbar { background-color: var(--paper, #F7F4EF) !important; }' +
            '.vditor-toolbar__item .vditor-tooltipped { color: var(--text-sub, #8E8E93) !important; }' +
            '.vditor-toolbar__item .vditor-tooltipped:focus,' +
            '.vditor-toolbar__item .vditor-tooltipped:active,' +
            '.vditor-toolbar__item .vditor-tooltipped:hover { color: var(--brand, #FF6A00) !important; }' +
            '.vditor-menu--current { color: var(--brand, #FF6A00) !important; }' +
            '.vditor-hint { background-color: var(--paper, #F7F4EF) !important; }' +
            '.vditor-hint button { color: var(--text, #1C1C1E) !important; }' +
            // 源码模式 textarea 的类名是 "vditor-sv vditor-reset"：injectTheme 的
            // .vditor-reset 字号命中它，而它自带 line-height:22px 写死——字号一大
            // 行高不动，文字全部叠在一起。改为相对行高，随主题字号缩放。
            '.vditor-sv { line-height: 1.75 !important; }' +
            '@media (max-width: 640px) {' +
            '  .vditor-toolbar { padding: 0 2px; }' +
            '  .vditor-toolbar__item { padding: 0 2px; }' +
            '  .vditor-toolbar__item .vditor-tooltipped { width: 26px; padding: 10px 2px; }' +
            '  .vditor-toolbar__item svg { width: 15px; height: 15px; }' +
            '  .vditor-toolbar__divider { margin: 10px 2px; }' +
            '  .vditor-reset { padding: 10px 14px; }' +
            '}' +
            '/* ≤360px（小屏机型）：再压一档，保证 11 项仍单行 */' +
            '@media (max-width: 360px) {' +
            '  .vditor-toolbar__item { padding: 0 1px; }' +
            '  .vditor-toolbar__item .vditor-tooltipped { width: 22px; padding: 10px 1px; }' +
            '  .vditor-toolbar__item svg { width: 13px; height: 13px; }' +
            '}';
        var tag = document.createElement('style');
        tag.id = 'mdnotes-mobile';
        tag.textContent = css;
        document.head.appendChild(tag);
    }
    injectMobileCss();

    // ------------------------------------------------------------------
    // v1.64 工具栏显隐架构重写（悬浮键盘 v1.60~v1.63 四连败后的换道）：
    //   显示 = JS 编辑态（editing，即 Vditor focus/blur）直接驱动；
    //   键盘 insets 只决定「贴键盘上沿（入流）」还是「钉可视区顶部」。
    //
    // 为什么换道：这台 ROM + 搜狗悬浮键盘对 ime insets 几乎零证据 —— 实时查询
    // 恒报 false、分发只剩 (false,0) 伪帧、窗口不 resize，且调试浮层关闭后连
    // (true,0) 帧都没有（v1.61 实测浮层重布局会"保鲜"分发）。四代闩锁/防抖/
    // 会话保持全部建立在"系统会给证据"这个不成立的前提上，遂全部拆除。
    //
    // 新模型：
    //   editing=false  → 工具栏隐藏（预览态绝不出现）
    //   editing=true 且 Kotlin 推送 onIme(true,false)（普通键盘占高实证）→
    //                  工具栏入流，贴键盘上沿
    //   editing=true 且无占高证据（悬浮键盘/外接键盘）→ 宽限 400ms 后钉可视区顶部
    //   v1.69：占高证据唯一来源是 Kotlin 推送 —— 原"视口缩水"推断被调试浮层
    //   污染（浮层占文档流高度 → innerHeight 缩水被误判为键盘占高），删除。
    //   编辑会话内 imeHasHeight 一旦置位不回退（收键盘由 Kotlin 自动退预览收
    //   尾，退出编辑整体复位）——收键盘瞬间工具栏不闪顶。
    // ------------------------------------------------------------------
    var dockUpdate = function () {};   // doMount 后会再调一次（工具栏那时才存在）
    var editorImePush = null;          // Kotlin 推送入口（只承载"占高"证据）
    var editorGuardMount = null;       // v1.45：工具栏就绪后挂拦截 + 菜单守卫
    function setupToolbarDock() {
        var imeHasHeight = false;      // 本编辑会话：键盘占窗口高度的确认证据（v1.69 起 Kotlin 推送唯一来源）
        var menuOpen = false;          // v1.45：标题/代码等浮层菜单是否开着
        var floatGrace = 0;            // v1.64：占高证据宽限定时器
        var graceDone = false;         // 宽限已过 → 可以钉顶
        var prevEditing = false;       // 编辑会话边沿检测（复位会话证据用）
        var sweepFn = null;            // v1.55：sweep 供收键盘推送重扫 menuOpen
        function setKbd(open, pinTop) {
            var cl = document.body.classList;
            cl.toggle('mdnotes-kbd-on', open);
            cl.toggle('mdnotes-kbd-off', !open);
            // pinTop：钉在可视区顶部（悬浮/无占高键盘）；否则入流贴键盘上沿
            cl.toggle('mdnotes-kbd-float', open && !!pinTop);
        }
        function apply() {
            var tb = document.querySelector('.vditor-toolbar');
            if (tb && editorGuardMount) editorGuardMount(tb);
            // 进入新编辑会话：复位占高证据与宽限（上一会话的收尾态不串场）
            if (editing && !prevEditing) { imeHasHeight = false; graceDone = false; }
            prevEditing = editing;
            if (!editing) {
                // v1.64：editing 是总闸 —— 预览态无论 ROM 的 insets 缓存/推送
                // 说什么一律隐藏，顺手清掉菜单残留与宽限定时器
                menuOpen = false;
                if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
                setKbd(false, false);
                return;
            }
            if (menuOpen) { setKbd(true, !imeHasHeight); return; }
            // v1.69：占高证据唯一来源 = Kotlin 推送 onIme(true,false)。
            // 删除视口缩水推断（原 `max(closedH, availH()) - h > 160 → imeHasHeight`）：
            // 调试浮层是 WebView 上方的文档流 TextView，一打开 innerHeight 就缩
            // 500px+，被误判成"普通键盘占高"且会话内不回退 → 工具栏被钉死在底部
            // 入流位（v1.68 截图实锤：调试开着时悬浮键盘工具栏在底部而非钉顶）。
            // Kotlin 的 root 级判定不受浮层影响，且 v1.67/1.68 日志已证明其稳定
            // （float/imeVis 恒定、边沿推送 804 行）。视口 resize 仅触发 apply 重算。
            if (imeHasHeight) {
                if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
                graceDone = false;
                setKbd(true, false);
                return;
            }
            if (graceDone) { setKbd(true, true); return; }   // 宽限已过：钉顶
            if (!floatGrace) {
                floatGrace = setTimeout(function () {
                    floatGrace = 0;
                    graceDone = true;
                    if (editing) apply();
                }, 400);
            }
            setKbd(true, false);   // 宽限中先按常规入流（钉顶前不闪跳）
        }
        dockUpdate = apply;
        // 初始态：页面刚打开时必然是预览态 → 工具栏先藏起来
        document.body.classList.add('mdnotes-kbd-off');
        if (window.visualViewport) window.visualViewport.addEventListener('resize', apply);
        window.addEventListener('resize', apply);
        // v1.64（自 v1.44 收窄）：Kotlin ime 推送不再决定显隐（editing 是显隐
        // 真源，悬浮键盘的 insets 零证据使推送不可信），只承载「键盘占窗口高度」
        // 证据：
        //   onIme(true, false) —— 普通键盘（bottom 大实证）→ 会话内置
        //                         imeHasHeight，工具栏立即入流，不等 400ms 宽限；
        //   onIme(true, true)  —— v1.68：悬浮实证 → 清占高证据并立即钉顶。
        //                         此前 imeHasHeight 会话内不回退，而搜狗实测会话
        //                         中途普通(b=794)→悬浮(b=2)切换（v1.66/1.67 日志
        //                         实锤），普通模式置位的证据把悬浮钉顶永久压住
        //                         ——v1.67 日志显示 onIme(true,true) 已推但工具
        //                         栏仍钉在底部入流位置。Kotlin 的 floating 判定
        //                         已据日志校准（b<40px），JS 直接信任。
        //   onIme(true, 未传)  —— 旧式单参调用 → 不动证据，交给宽限定时器裁决
        //                         （普通键盘弹出首帧也可能是 (true,0)，立即钉顶会闪）；
        //   onIme(false, …) —— 键盘收起 → 显示已解耦（编辑中保持显示，收尾由
        //                         Kotlin 自动退预览走 exitEditMode），仅重扫菜单残留。
        editorImePush = function (open, floating) {
            if (open && floating === false) { imeHasHeight = true; graceDone = false; }
            if (open && floating === true) {
                imeHasHeight = false;
                graceDone = true;
                if (floatGrace) { clearTimeout(floatGrace); floatGrace = 0; }
            }
            if (!open && sweepFn) {
                var o = sweepFn();
                if (o !== menuOpen) menuOpen = o;
            }
            apply();
        };
        // v1.45：工具栏就绪后挂两件事
        // ① 拦截工具栏区域 mousedown 的默认焦点转移 —— 标题/代码等带浮层菜单的
        //    工具点击时，按钮/菜单项默认会抢走编辑区 textarea 焦点 → blur → 软键盘
        //    收起 → 本 App 工具栏随之隐藏（死循环：菜单一并消失、选不了）。
        // ② v1.47：浮层面板（标题 H1~H6 / 代码语言 / @提及 等）类名是
        //    .vditor-hint / .vditor-panel，挂在 .vditor 根内而非 toolbar 内 ——
        //    v1.45 用 tb.querySelector('.vditor-menu') 检测菜单，类名根本不存在，
        //    "菜单开着强制显示工具栏"的兜底从未生效。改为观察 body 全局：
        //    面板可见 → menuOpen=true 强制显示工具栏（与键盘显隐解耦）。
        //    同时顺手把面板项文本尾部的快捷键提示（" <Alt+Ctrl+1>" 之类）清掉 ——
        //    手机没有物理键盘，快捷键纯噪音（用户反馈：把这快捷键提示删除）。
        editorGuardMount = function (tb) {
            if (tb.__kbdGuard) return;
            tb.__kbdGuard = true;
            // v1.46 修复「工具栏能看不能用」：v1.45 对 touchstart 也 preventDefault，
            // 触摸端浏览器就不再合成 click，而 Vditor 工具栏靠 click 触发命令 → 点不动。
            // 只拦 mousedown（捕获）：既能阻止按钮/菜单项抢走 textarea 焦点（防 blur 收键盘），
            // 又不影响后续 click 生成，Vditor 插入逻辑照常；移动端合成的 mousedown 同样生效。
            // 例外：工具栏内可输入元素（如 @提及 hint 的 input）需正常获得焦点，放行不拦。
            function block(e) {
                var t = e.target;
                if (t && t.closest && t.closest('input, textarea, [contenteditable="true"]')) return;
                e.preventDefault();
                // v1.48：点工具栏是打开面板的必经之路，延迟一拍全量清洗一次，
                // 作为独立于 MutationObserver 的保险（observer 漏触发也能清干净）
                setTimeout(sweep, 60);
            }
            tb.addEventListener('mousedown', block, true);
            if (typeof MutationObserver === 'undefined') return;
            // 去掉面板项尾部的快捷键提示（如 " <Alt+Ctrl+1>"、" <⌘E>"）。
            // ① 文本形式：Vditor 转义后拼在项尾，删文本节点尾缀（不动 value/data）；
            // ② 元素形式（v1.48 兜底）：若 " <...>" 未转义会被 HTML 解析成未知元素，
            //    其标签名必含 "+"（正常 HTML 标签不可能），整节点移除。
            function stripHotkeys(root) {
                var walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null, false);
                var nodes = [];
                while (walker.nextNode()) nodes.push(walker.currentNode);
                for (var i = 0; i < nodes.length; i++) {
                    var v = nodes[i].nodeValue || '';
                    var m = v.match(/\s*<[^<>]{1,24}>$/);
                    if (m) nodes[i].nodeValue = v.slice(0, v.length - m[0].length);
                }
                var all = root.getElementsByTagName('*'), dead = [];
                for (i = 0; i < all.length; i++) {
                    if (all[i].tagName.indexOf('+') >= 0) dead.push(all[i]);
                }
                for (i = 0; i < dead.length; i++) {
                    if (dead[i].parentNode) dead[i].parentNode.removeChild(dead[i]);
                }
            }
            // v1.50 性能修复：v1.48 的全局 attributes 监听（document.body, subtree）
            // 是长文档卡顿元凶 —— Vditor 重渲染长内容时会给全文每个节点重设
            // style/class，逐节点属性监听产生数万条 mutation 记录，叠加在渲染之上
            // 把「卡一下」拖成「卡半天」。改为：全局只看 childList（捕获面板增删，
            // 正文 innerHTML 替换只产生批量 childList，开销远低于逐节点属性监听）；
            // 面板可见后单独对它挂 attributes 监听（面板很短，开销可忽略），检测其
            // display 切换。sweep 范围限定在 .vditor 内，进一步缩小查询。
            var panelObservers = [];
            function trackPanel(node) {
                if (node.__hotkeyTracked) return;
                node.__hotkeyTracked = true;
                // v1.50 修复：面板级 observer 必须和全局 mo 一样翻 menuOpen，
                // 否则 display 切换（开/关浮层）只跑 sweep 却丢弃返回值，工具栏
                // 状态不会跟着变。复用同一 raf 节流与 menuOpen/apply 闭包。
                var po = new MutationObserver(function () {
                    if (raf) return;
                    raf = 1;
                    schedule(function () {
                        raf = 0;
                        var open = sweep();
                        if (open !== menuOpen) { menuOpen = open; apply(); }
                    });
                });
                po.observe(node, {
                    attributes: true, attributeFilter: ['style', 'class'],
                    subtree: true, childList: true
                });
                panelObservers.push({ po: po, node: node });
            }
            // 清洗所有可见面板（幂等无害）；menuOpen 只认可见面板。Vditor 隐藏面板
            // 用 style.display="none"（bundle 内 46 处），不看 offsetParent —— jsdom
            // 恒为 null、真机 fixed/无定位容器下也会误判，不可靠。
            function sweep() {
                var root = document.querySelector('.vditor') || document.body;
                var panels = root.querySelectorAll('.vditor-hint, .vditor-panel');
                var open = false;
                for (var i = 0; i < panels.length; i++) {
                    var p = panels[i];
                    if (!p.childElementCount) continue;
                    stripHotkeys(p);
                    trackPanel(p);
                    // v1.56 修「收键盘不收工具栏」（headless 真渲染复现）：
                    // Vditor 预渲染面板关闭态有两套 —— 内联 style.display="none"
                    //（打开过再关的）和 CSS 类 vditor-panel--none（从未打开的，
                    // 内联 display 为空、computed=none）。旧判定只认内联 →
                    // --none 面板被恒判"开着" → menuOpen 恒 true → apply 菜单
                    // 分支吞掉所有收键盘推送，工具栏恒显示。改计算样式判定
                    // （内联+样式表一起算）并直判 --none 类，双覆盖。
                    if (/\bvditor-panel--none\b/.test(p.className)) continue;
                    var cs = window.getComputedStyle ? getComputedStyle(p) : null;
                    if (cs ? (cs.display === 'none' || cs.visibility === 'hidden')
                           : (p.style.display === 'none' || p.style.visibility === 'hidden')) continue;
                    open = true;
                }
                // 清理已脱离文档的面板 observer（避免游离节点持续占用）
                panelObservers = panelObservers.filter(function (rec) {
                    if (!rec.node.isConnected) { rec.po.disconnect(); return false; }
                    return true;
                });
                return open;
            }
            sweepFn = sweep;   // v1.55：供 editorImePush 收键盘时强制重扫纠正 menuOpen
            var raf = 0;
            var schedule = window.requestAnimationFrame
                ? function (fn) { window.requestAnimationFrame(fn); }
                : function (fn) { setTimeout(fn, 16); };
            var mo = new MutationObserver(function () {
                if (raf) return;                    // rAF 节流：渲染/打字高频变更下每帧只跑一次
                raf = 1;
                schedule(function () {
                    raf = 0;
                    var open = sweep();
                    if (open !== menuOpen) { menuOpen = open; apply(); }
                });
            });
            // v1.50：全局只听 childList（去掉 v1.48 的 attributes 全文档监听）。
            // 面板是预渲染常驻、打开时只切 style.display（46 处 display:none），其
            // display 切换由各面板自己的 trackPanel observer 捕获，不靠全局属性监听。
            mo.observe(document.body, { childList: true, subtree: true });
            sweep();   // 面板可能在 guard 挂载前就已渲染 → 挂载时先清一次
        };
    }
    setupToolbarDock();

    /** 配套样式：收起隐藏 / 弹出时入流排到键盘上沿 + 下拉面板往上弹 */
    function injectDockCss() {
        var css =
            '/* 键盘收起：工具栏整体隐藏，不留在顶部占位 */' +
            '.mdnotes-kbd-off .vditor-toolbar { display: none !important; }' +
            '/* 键盘弹出：工具栏入流排到内容区之后 → 出现在键盘上沿，不遮挡正文 */' +
            '.mdnotes-kbd-on .vditor-toolbar { order: 99; position: static !important;' +
            '  border-top: 1px solid var(--table-border, #d0d0d0); }' +
            // 只翻工具栏里的下拉面板（标题/代码等）；正文内嵌的 hint（如 :表情）不动
            '.mdnotes-kbd-on .vditor-toolbar .vditor-hint { top: auto !important; bottom: 42px !important; }' +
            // 弹出态收紧纸面底部留白，让工具栏贴住键盘上沿
            '.mdnotes-kbd-on .paper { padding-bottom: 8px; margin-bottom: 4px; }' +
            // v1.60 悬浮键盘：窗口不 resize，工具栏按常规排到内容末尾会落在屏幕
            // 最底部、恰好被（一般在下方的）悬浮键盘盖住 → 改钉在可视区顶部。
            '.mdnotes-kbd-float .vditor-toolbar { position: fixed !important; top: 0;' +
            '  left: 0; right: 0; z-index: 30;' +
            '  border-bottom: 1px solid var(--table-border, #d0d0d0);' +
            '  box-shadow: 0 2px 6px rgba(0,0,0,.12); }' +
            // 工具栏回到顶部 → 下拉面板（标题/代码语言等）改为向下展开
            '.mdnotes-kbd-float .vditor-toolbar .vditor-hint { top: 100% !important;' +
            '  bottom: auto !important; }' +
            // 顶部固定会压住正文首行，给纸面补一段顶距
            '.mdnotes-kbd-float .paper { padding-top: 42px; }';
        var tag = document.createElement('style');
        tag.id = 'mdnotes-dock-css';
        tag.textContent = css;
        document.head.appendChild(tag);
    }
    injectDockCss();

    // ============================================================
    // v1.59：图片引用改写（修「插图后无法渲染」）
    // 正文里图片以 ![说明](img://key) 存储（Kotlin IMG_REF 认这个形式），但
    // WebView 不认 img:// 协议 —— Vditor 渲染出的 <img src="img://key"> 永远
    // 请求不出去，表现为插图后空白/裂图。开发文档写的是「渲染前 JS 替换成
    // https://mdnotes.local/img/<key>，再由 shouldInterceptRequest 拦下供流」，
    // 但这段 JS 此前根本没落地（mdnotes.local 只出现在 Kotlin 与文档里），
    // 图片链路一直是断的。这里补上：只改渲染 DOM 的 src，不动源文本。
    // 注：Vditor 序列化回源码时可能把 https 形式回写进正文，Kotlin 侧 IMG_REF
    // 已同步放宽为两种形式都认（否则「未引用图片回收」会误删已插入的图）。
    // ============================================================
    var IMG_PREFIX = 'img://';
    var IMG_BASE = 'https://mdnotes.local/img/';

    /** 把作用域内所有未改写的 img:// 引用换成可加载的 https 地址（幂等） */
    function rewriteImgRefs(root) {
        var imgs = (root || document).querySelectorAll('img[src^="' + IMG_PREFIX + '"]');
        for (var i = 0; i < imgs.length; i++) {
            var key = (imgs[i].getAttribute('src') || '').slice(IMG_PREFIX.length);
            if (key) imgs[i].setAttribute('src', IMG_BASE + key);
        }
    }

    /** 首帧立即改写一次（Vditor 首次渲染 img:// 占位）；后续每次重绘由常驻
     *  MutationObserver（setupImgObserver）合并触发改写，无需固定 delay 兜底
     *  （审查 #82-2：delay 只能做缓冲、必须配状态/版本校验，此处用 opSeq 校验）。
     *  80ms 那次纯 delay 兜底已移除——它和 observer 重复改写且无法防旧覆盖。 */
    function scheduleImgRewrite() {
        var myOp = ++opSeq;
        setTimeout(function () { if (myOp !== opSeq) return; rewriteImgRefs(); }, 0);
    }

    /**
     * 常驻监听：打字/分块重绘会不断重建 <img>，只靠挂载后改写一次会漏。
     * 改写后 src 不再以 img:// 开头 → 不会再命中，不会自激循环。
     */
    function setupImgObserver() {
        if (typeof MutationObserver === 'undefined') return;
        var pending = 0;
        var ob = new MutationObserver(function () {
            if (pending) return;                 // 高频变更下合并成一次
            pending = setTimeout(function () { pending = 0; rewriteImgRefs(); }, 16);
        });
        ob.observe(document.body, { childList: true, subtree: true });
    }
    setupImgObserver();

    function makeOptions(value, night) {
        return {
            mode: currentMode,
            cdn: CDN,
            value: value || '',
            // v1.36.2：不传 lang/icon——lang 会触发 i18n 文件运行时加载，icon 会触发
            // icons 文件加载（加载失败会 reject 掉整个初始化链）。两者已内联进
            // editor.html：window.VditorI18n（i18n 传入即跳过文件加载）+ SVG symbols。
            i18n: (typeof window.VditorI18n === 'object' && window.VditorI18n) || undefined,
            // v1.39：图标 symbols 已内联在 editor.html 里，传空串让 Vditor 跳过
            // icons/ant.js 的 XHR 请求（file:// 下必失败，还会抛 unhandledrejection）
            icon: '',
            theme: night ? 'dark' : 'classic',
            cache: { enable: false },       // 关键：禁用 localStorage 缓存，避免跨笔记串内容
            counter: { enable: false },
            outline: { enable: false },
            height: '100%',
            // v1.39 手机适配：preview.mode 默认是 'both'（分栏出 Desktop/Tablet/
            // Mobile/Wechat 设备预览面板，桌面行为）。手机屏只有几百 css px，分栏
            // 把编辑区挤成半屏；且 IR 本身就是 Typora 式即时渲染，预览冗余。
            // 'editor' = 单栏编辑；眼睛按钮切的源码模式(sv)也变成纯源码单栏。
            // v1.74：==高亮== 等扩展语法必须放 preview.markdown —— 这个 Vditor 版本
            // 构建 lute 实例时读的是 options.preview.markdown.*，顶层 markdown 键
            // 根本不被消费（v1.73 放顶层导致高亮无效，headless 打桩 SetMark(false) 实锤）。
            preview: { mode: 'editor', markdown: { mark: true } },
            toolbar: buildToolbar(),
            toolbarConfig: { pin: true, hide: false },
            upload: { url: '', linkToImgUrl: '', accept: 'image/*' },
            // v1.53：编辑态变化即刷新工具栏显隐（配合 apply 的预览态强制隐藏）
            input: function (v) { pendingValue = v || ''; },
            focus: function () { editing = true; safe(function () { dockUpdate(); }); },
            blur: function () { editing = false; safe(function () { dockUpdate(); }); },
            after: function () {
                ready = true;
                window.__vd = vd;   // 调试句柄：headless 探查 / 真机取证可直接访问 Vditor 实例
                // v1.59：首次渲染完成，立即把正文里的 img:// 引用换成可加载地址
                // （历史笔记里已有的图片也要在这一刻点亮）
                rewriteImgRefs();
                scheduleImgRewrite();
                if (diagTimer) { clearTimeout(diagTimer); diagTimer = null; }
                if (pendingTheme) { applyTheme(pendingTheme); pendingTheme = null; }
                if (pendingFocus) { pendingFocus = false; safe(function () { vd.focus(); }); }
            }
        };
    }

    function mount(value) {
        var paper = document.getElementById('paper');
        // v1.37 时序修复：lute 内联段（Go 引擎）的全局 Lute 是由 GopherJS 的
        // 协程异步 init 的——Vditor 加载器检测到 vditorLuteScript 节点会立刻
        // resolve，其 then 回调里 Lute.New() 可能在 Lute 就绪前执行，抛
        // "Lute is not defined" 后整条初始化链静默断死（真机表现：图标空/
        // 布局乱/预览面板外露）。因此这里轮询等 window.Lute 就绪后再 mount。
        if (typeof window.Lute !== 'undefined') { doMount(paper, value); return; }
        if (mounting) return;   // 已在等待中，防 Kotlin 轮询重复触发
        mounting = true;
        var waited = 0;
        var timer = setInterval(function () {
            if (typeof window.Lute !== 'undefined') {
                clearInterval(timer); mounting = false;
                doMount(paper, value);
            } else if ((waited += 50) >= 10000) {
                clearInterval(timer); mounting = false;
                paper.textContent = '编辑器启动超时诊断：Vditor=' + (typeof Vditor)
                    + ' Lute=' + (typeof window.Lute)
                    + ' luteScript节点=' + !!document.getElementById('vditorLuteScript')
                    + ' i18n=' + (typeof window.VditorI18n);
            }
        }, 50);
    }

    function doMount(paper, value) {
        if (typeof Vditor === 'undefined') {
            paper.textContent = '编辑器内核加载失败：Vditor 未找到';
            return;
        }
        // v1.37 启动诊断：after 8 秒未触发就把关键状态直接写到纸面。
        if (diagTimer) clearTimeout(diagTimer);
        diagTimer = setTimeout(function () {
            if (ready) return;
            paper.textContent = '编辑器启动超时诊断：Vditor=' + (typeof Vditor)
                + ' Lute=' + (typeof window.Lute)
                + ' luteScript节点=' + !!document.getElementById('vditorLuteScript')
                + ' i18n=' + (typeof window.VditorI18n)
                + ' 实例已创建=' + !!vd;
        }, 8000);
        try {
            vd = new Vditor(paper, makeOptions(value, currentNight));
            dockUpdate();   // 键盘若已弹出，立即吸附新工具栏（重挂载后工具栏是新建的）
            if (vd.vditor && vd.vditor.ir && vd.vditor.ir.element) {
                installIRLiCaretFix(vd.vditor.ir.element);   // 嵌套父项点击光标归位修复
            }
            // v1.57：Vditor 工具栏 DOM 已生成，往末尾追加用户自定义插入文本按钮
            setTimeout(renderCustomTools, 0);
            // v1.58：追加「图片」等特殊内置工具按钮
            setTimeout(renderSpecialTools, 0);
            // v1.79：追加自实现的「缩进/减缩进」按钮（IR 下原生缩进不可用）
            setTimeout(renderIndentTools, 0);
            setTimeout(renderHistoryTools, 0);
        } catch (e) {
            // 不再静默吞掉初始化异常：直接显示在纸面上，真机可直读排障
            if (diagTimer) { clearTimeout(diagTimer); diagTimer = null; }
            paper.textContent =
                '编辑器初始化失败：' + (e && e.message ? e.message : e);
        }
    }

    function getSource() {
        if (vd && ready) return safe(function () { return vd.getValue(); }) || pendingValue;
        return pendingValue;
    }

    /**
     * 段落/引用缩进单元：全角空格 U+3000。
     * 实测证据：Vditor IR 的 Lute 会归一化掉段落/列表的普通前导空格（'  x'→'x'），
     * 但全角空格与 &nbsp;/&emsp; 能完整保留在源码里（保存/重开都保留）。其中全角空格
     * 视觉为 1 字宽，最贴合中文段落缩进；普通空格转普通字符有被吃风险、不可靠，故选全角空格。
     * 每次缩进加 1 个单元，可叠加（点 2 下 = 2 字首行缩进，即中文标准排版）。
     */
    var PARA_INDENT_UNIT = '　';

    /**
     * setValue 重建 DOM 后，按【源码行号】把光标放回正确的列表项内、对应子行的文本开头
     * （marker 之后）。不能用「第 i 个 li 索引」：Lute 对有序列表的嵌套子项做「懒延续」渲染
     * ——把子项以纯文本并入父 li（无独立 li 元素，li 数量变少），旧索引会指向不存在的 li 致光标丢失。
     * 本函数按源码行号重新定位，对三种列表统一：
     *  - 遍历文档序 li，对每个 li 计算其「覆盖源码行数」= 1（自身）+ 自有文本里出现的 marker 行数
     *    （按 \n 切分、对每行用列表正则判断；任务/无序真实嵌套时子项有独立 li，故从克隆里摘掉后代 li
     *    再统计，避免重复计数；有序懒延续时子项就在父母本里，直接统计）。
     *  - 累计到覆盖 lineNo 的 li，落在其第 subLine 个子行；subLine=0 置于首个自有文本节点开头
     *    （已在 marker 之后）；subLine>0 仅见于有序懒延续，沿文本流数到第 subLine 个换行后跳过
     *    marker 即内容开头。最后用 createRange + getSelection 落光标。
     */
    /**
     * Sprint 3：逻辑光标模型（审查 #6 / #82 规则 3、4）
     *
     * 逻辑光标 = { blockIndex, offset }
     *  - blockIndex：先序遍历 ir.element 收集的「有效块」序列中的索引。
     *    有效块 = 每个 li（无论嵌套层级）一行 + 每个顶层块级（P/H1-6/BLOCKQUOTE/PRE）一行；
     *    ul/ol 容器本身不算块；li 内的 input/span 等内联元素不算块。
     *    这个序号是「结构身份」，不依赖任何文字内容（满足规则 4：不以文本+第几个做永久身份），
     *    也不依赖全局 textContent 偏移（满足规则 3）。
     *  - offset：光标在该块「可见文字」中的字符偏移。IR 渲染后列表 marker（- / 1. ）与行首
     *    缩进空格不在 li.textContent 里，故 offset 天然是「用户可见文字」偏移，重渲染后稳定。
     *
     * 缩进/减缩进只平移行首空格、不改块数与块内文字，故同一 li 的 blockIndex 与 offset 在
     * 结构变换前后保持不变——这正是「结构变化后光标保持语义位置」（Sprint 3 目标）的保证。
     *
     * 还原用 data-ls-id 临时标签（审查 #6.2 session block identity，绝不写入 Markdown 文件）：
     * 每次 setValue 重建 DOM 后按先序有效块序重打标签，再用 querySelector 定位，彻底脱离
     * 旧版 li 文字指纹（caretLiPos/restoreLiPos/findSourceLineByLi/liOwnText）的脆弱猜测。
     * 旧方案（v1.92~v1.94）三版坐标系均被真机/headless 打脸，根因见 ADR-005。
     */
    /** 先序收集「有效块」（每个 li=一行；顶层块级 p/h/blockquote/pre=一行；ul/ol 容器与内联元素不算块）。 */
    function collectBlocks(root) {
        var out = [];
        (function walk(el) {
            var kids = el.children;
            for (var i = 0; i < kids.length; i++) {
                var c = kids[i];
                if (c.tagName === 'LI') { out.push(c); walk(c); }
                else if (c.tagName === 'UL' || c.tagName === 'OL') { walk(c); }
                else if (/^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(c.tagName)) { out.push(c); }
                else { walk(c); }   // 内联/装饰元素（input/span/div）不收，递归兜底
            }
        })(root);
        return out;
    }

    /** setValue 重建 DOM 后按先序有效块序重打 data-ls-id 标签（session 身份，不写 markdown）。 */
    function rebuildBlockIds(root) {
        if (!root) return 0;
        var bs = collectBlocks(root);
        for (var k = 0; k < bs.length; k++) bs[k].setAttribute('data-ls-id', String(k));
        return bs.length;
    }

    /** 块内可见文字偏移：从 (node, off) 累计到该点的文字数；遇后代 LI 停止（偏移不跨子列表）。 */
    function innerOffsetOf(block, node, off) {
        var acc = 0, done = false;
        (function walk(n) {
            if (done) return true;
            if (n === node) {
                if (n.nodeType === 3) acc += Math.min(off, n.textContent.length);
                else for (var k = 0; k < off && k < n.childNodes.length; k++)
                    acc += (n.childNodes[k].textContent || '').length;
                done = true; return true;
            }
            if (n.nodeType === 3) { acc += n.textContent.length; return false; }
            if (n !== block && n.tagName === 'LI') return false;   // 跳过后代 li 子树
            for (var c = 0; c < n.childNodes.length; c++) if (walk(n.childNodes[c])) return true;
            return false;
        })(block);
        return acc;
    }

    /** 光标所在的有效块元素（li 或顶层块级）；在列表空白/容器上返回 null。 */
    function currentBlockEl() {
        if (!vd || !ready) return null;
        var irEl = vd.vditor.ir.element;
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        var r0 = sel.getRangeAt(0);
        var el = (r0.startContainer.nodeType === 1) ? r0.startContainer : r0.startContainer.parentElement;
        while (el && el !== irEl && !/^(LI|P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(el.tagName)) {
            el = el.parentElement;
        }
        return (el && el !== irEl) ? el : null;
    }

    /** DOM → 逻辑光标：取光标所在块的先序索引 + 块内可见文字偏移。取不到返回 null。 */
    function domToLogicalCursor() {
        try {
            var irEl = vd.vditor.ir.element;
            var bs = collectBlocks(irEl);
            var el = currentBlockEl();
            if (!el) return null;
            var idx = bs.indexOf(el);
            if (idx < 0) return null;
            var sel = window.getSelection();
            var r0 = sel.getRangeAt(0);
            return { blockIndex: idx, offset: innerOffsetOf(el, r0.startContainer, r0.startOffset) };
        } catch (e) { return null; }
    }

    /** 逻辑光标 → DOM：setValue 后按 data-ls-id 找目标块，落块内 offset 个字符；
     *  结构真变导致标签缺失则安全降级（保持 Vditor 当前光标，规则 4 兜底）。 */
    function logicalCursorToDom(cur) {
        if (!cur) return false;
        try {
            var irEl = vd.vditor.ir.element;
            rebuildBlockIds(irEl);
            var el = irEl.querySelector('[data-ls-id="' + cur.blockIndex + '"]');
            if (!el) return false;                      // 降级：不落错行
            var acc = 0, spot = null;
            (function walk(n) {
                if (spot) return true;
                if (n.nodeType === 3) {
                    var len = n.textContent.length;
                    if (cur.offset <= acc + len) { spot = { node: n, off: cur.offset - acc }; return true; }
                    acc += len; return false;
                }
                if (n !== el && n.tagName === 'LI') return false;
                for (var c = 0; c < n.childNodes.length; c++) if (walk(n.childNodes[c])) return true;
                return false;
            })(el);
            var range = document.createRange();
            if (spot) { range.setStart(spot.node, spot.off); range.collapse(true); }
            else { range.selectNodeContents(el); range.collapse(false); }   // 偏移超长：落块末尾
            var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            return true;
        } catch (e) { return false; }
    }

    /** 逻辑光标的 blockIndex（先序有效块序）→ getSource 源码行号。
     *  getSource 是 DOM 反推的规范化源码，可能在有序嵌套等处插入空行，故不能用扁平行号做身份；
     *  这里用「第 blockIndex 个非空内容行」对应（无续写多行时，有效块序 == 非空行序，精确）。
     *  续写多行（一个 li 跨多行源码）为已知边角：此处映射会偏移，调用方应降级（规则 4 兜底）。 */
    function blockIndexToSrcLine(blockIndex) {
        if (blockIndex < 0) return -1;
        var lines = getSource().split('\n');
        var k = 0;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '') continue;       // 跳过 Vditor 规范化空行
            if (k === blockIndex) return i;
            k++;
        }
        return -1;
    }

    /**
     * 点击光标归位 —— 参考 ProseMirror / Lexical「Selection 模型为真 + 自建命中测试」范式重写
     * （替代 v1.101 的横向比例近似 + setTimeout 时序 hack，并并入 Sprint 3 逻辑光标框架，
     *  消除「第二套光标机制」补丁味）：
     *   - 浏览器 caretRangeFromPoint 在嵌套 <li> 边界会撒谎（归块首），故自建「逐字符命中测试」
     *     算精确偏移：逐 text node 测矩形，命中行内按 x 比例映射 —— 比例字体也准、支持多行；
     *   - 命中结果转成逻辑块坐标 {blockIndex, offset}，复用 logicalCursorToDom 落位
     *     （与缩进/减缩进用同一套光标权威，统一 Selection 模型，不再直接 setStart）；
     *   - 关键的「态一致性」修复：测量在 mousedown 捕获阶段进行（此时 li 仍是未聚焦的干净渲染，
     *     无 Vditor 注入的 marker / 编辑态样式，rect 即用户所见），落位在 click 阶段用记录的
     *     offset 执行 —— 避免「测量态(未聚焦)」与「命中态(聚焦)」两套 DOM 不一致导致的误差；
     *     并彻底去掉 setTimeout(0) 时序 hack。框选（非 collapsed）/段落/引用/叶子项零回归。
     */
    var _liCaretFixDone = false;
    function installIRLiCaretFix(irEl) {
        if (!irEl || _liCaretFixDone) return;
        _liCaretFixDone = true;

        // 逐字符命中：在 li 自身文字节点（不含后代子列表）上，按点击 (x,y) 算精确字符偏移。
        // 对标 ProseMirror 的 hit-test：逐 text node 测矩形，命中行内按 x 比例映射。
        function hitOffsetInLi(li, x, y) {
            var nodes = [];
            (function walk(n) {
                if (n === li) { for (var c = 0; c < n.childNodes.length; c++) walk(n.childNodes[c]); return; }
                if (n.tagName === 'LI') return;                       // 后代 li 子树跳过
                if (n.nodeType === 1) {                               // 跳过 Vditor 注入的 marker（contenteditable=false）与任务 checkbox
                    if ((n.getAttribute && n.getAttribute('contenteditable') === 'false') || n.tagName === 'INPUT') return;
                    for (var c = 0; c < n.childNodes.length; c++) walk(n.childNodes[c]);
                    return;
                }
                if (n.nodeType === 3) { if (n.textContent.length) nodes.push(n); }
            })(li);
            if (!nodes.length) return -1;
            var acc = 0;
            for (var i = 0; i < nodes.length; i++) {
                var node = nodes[i], len = node.textContent.length;
                var range = document.createRange();
                range.setStart(node, 0); range.setEnd(node, len);
                var rects = range.getClientRects();
                for (var r = 0; r < rects.length; r++) {
                    var rect = rects[r];
                    if (y >= rect.top && y <= rect.bottom) {          // 命中该行
                        if (x <= rect.left) return acc;               // 行首（含左侧空白）→ 块内首
                        if (x >= rect.right) { acc += len; break; }   // 行右侧之外 → 本节点末尾，续下一节点
                        var frac = (x - rect.left) / Math.max(rect.width, 1);
                        return acc + Math.round(Math.max(0, Math.min(1, frac)) * len);
                    }
                }
                acc += len;                                            // 该行在点击 y 之下：累计后继续
            }
            return acc;   // 点击 y 不在任何文字行（落在块内空白）→ 落块末
        }

        var pendingHit = null;   // mousedown 测量的未聚焦态命中（click 时消费）
        // 测量阶段：mousedown 捕获 —— li 此时未聚焦，rect 干净即用户所见，命中精确
        irEl.addEventListener('mousedown', function (e) {
            if (e.button !== 0 || e.detail > 1) { pendingHit = null; return; }   // 仅左键单击
            var li = e.target && e.target.closest ? e.target.closest('li') : null;
            if (!li || li === irEl || !li.querySelector('ol, ul')) { pendingHit = null; return; }
            pendingHit = { li: li, offset: hitOffsetInLi(li, e.clientX, e.clientY) };
        }, true);
        // 落位阶段：click 同步执行（此时已聚焦，用记录的 offset 走逻辑光标框架，无 setTimeout hack）
        irEl.addEventListener('click', function (e) {
            var ph = pendingHit; pendingHit = null;
            if (!ph || !ph.li) return;
            var li = e.target && e.target.closest ? e.target.closest('li') : null;
            if (li !== ph.li) return;                                  // 拖拽框选跨 li：放行
            var sel = window.getSelection();
            if (!sel || !sel.isCollapsed) return;                      // 框选（非 collapsed）：放行
            if (ph.offset < 0) return;
            var bs = collectBlocks(irEl);
            var idx = bs.indexOf(ph.li);
            if (idx < 0) return;
            logicalCursorToDom({ blockIndex: idx, offset: ph.offset });   // 复用逻辑光标框架（统一 Selection 权威）
        }, false);
    }

    var indentDiag = '';   // 最近一次列表缩进/减缩进的结果（经 stat 回传 Kotlin，便于真机取证）
    var indentOps = { en: 0, ok: 0, er: 0 };   // 列表缩进/减缩进真实计数（面板不再恒为 0）
    var opSeq = 0;         // Sprint 4：异步操作序号（审查 #82-12 / #3）——每次触发 setValue/改写的
                          //   操作递增；异步回调落地前校验 myOp===opSeq，旧任务不覆盖新状态

    /**
     * Sprint 2+3：列表加/减缩进统一走 ListStructureTransformer（纯源码变换），
     * 光标用「逻辑光标」模型（审查 #6 / #82 规则 3、4）还原：
     *  DOM → 逻辑光标 {blockIndex, offset}（先序有效块序，不依赖文字指纹）→
     *  blockIndex 映射成源码行 → transformer 计算新源码 → setValue 受控重渲染 →
     *  膨胀守卫 → 按 data-ls-id 标签把逻辑光标还原到目标块（结构平移下 blockIndex/offset 不变）。
     *  彻底脱离旧版 caretLiPos/restoreLiPos（文本+第几个 做身份，违反规则 4）与全局 textContent offset（违反规则 3）。
     */
    function transformList(op) {
        if (!vd || !ready) return;
        var myOp = ++opSeq;                       // Sprint 4 opId 守卫：同步路径下无覆盖风险
                                                  //   （setValue 同步重渲染，A 探针实证），但作为
                                                  //   契约保留，防未来异步化旧任务覆盖新状态
        var cur = domToLogicalCursor();           // 逻辑光标 {blockIndex, offset}
        if (!cur) { indentDiag = op + ':nopos'; indentOps.er++; return; }
        var srcLine = blockIndexToSrcLine(cur.blockIndex);
        if (srcLine < 0) { indentDiag = op + ':notfound'; indentOps.er++; return; }
        var src = getSource();
        if (src == null) return;
        var lines = src.split('\n');
        var res = (op === 'indent')
            ? window.ListTransformer.indent(src, srcLine)
            : window.ListTransformer.outdent(src, srcLine);
        if (!res.changed) { indentDiag = op + ':noop'; return; }
        var l0 = lines.length;
        safe(function () { vd.setValue(res.src, false); });
        var l1 = getSource().split('\n').length;
        if (l1 > l0 + 2) {                       // 膨胀守卫：异常立即回滚，绝不把坏内容留在文档
            safe(function () { vd.setValue(src, false); });
            indentDiag = 'ROLLBACK ' + l0 + '->' + l1; indentOps.er++; return;
        }
        if (myOp !== opSeq) {                     // Sprint 4：setValue 期间有更新操作介入，
            indentDiag = 'STALE ' + op; indentOps.er++; return;  // 旧光标还原放弃，绝不覆盖新状态
        }
        indentDiag = op + ' src rows=' + (l1 - l0);
        indentOps.ok++;
        logicalCursorToDom(cur);                  // 逻辑光标还原：结构平移下 blockIndex/offset 不变
    }

    /**
     * Sprint 2+3：加/减缩进统一入口见 transformList()（上方）。减缩进不再自己改源码，
     * 改由 ListStructureTransformer.outdent 计算（基于源码行变换，确定性、可单测，
     * 不再依赖 Vditor 原生 Shift+Tab——后者对深层子树有复制 bug）。
     * 原 liOwnText / lineCoreText / findSourceLineByLi（v1.92~v1.94 的 li 文字指纹定位）
     * 已被 Sprint 3 逻辑光标模型（collectBlocks / domToLogicalCursor / logicalCursorToDom /
     * blockIndexToSrcLine）取代并删除——文字指纹身份违反审查 #82 规则 4，详见 ADR-005。
     */

    /**
     * v1.86：缩进用的「当前块」判定——块首归位、分支判定、段落减缩进三处共用。规则：
     *  1) 列表优先：光标在 li 内（含 li 内嵌文本/多行续写）一律返回该 li，按列表处理，
     *     不会因 li 内出现的 P/BLOCKQUOTE 等被误判成段落；
     *  2) IR 的根容器本身就是 PRE.vditor-reset，绝不能当内容块。光标落在列表容器（ul/ol）
     *     或根容器上时（真机常见：点到列表左侧缩进空白、项与项之间的空隙），旧代码会把
     *     它判成 PRE/null → 走段落分支 → 光标被甩到整篇最开头并插/删全角空格
     *     （用户反馈：待办缩进时光标跳到首行、还增减空格）。现统一返回 null 放弃操作；
     *  3) 其余取最近的 P / H1-6 / BLOCKQUOTE / PRE（代码块）内容块。
     */
    function indentBlockEl() {
        if (!vd || !ready) return null;
        var ir = vd.vditor.ir.element;
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return null;
        var node = sel.getRangeAt(0).startContainer;
        var el = (node.nodeType === 1) ? node : node.parentElement;
        if (!el) return null;
        var li = el.closest ? el.closest('li') : null;
        if (li && ir.contains(li)) return li;                 // 列表优先
        var block = el;
        while (block && block !== ir &&
            !/^(BLOCKQUOTE|P|H1|H2|H3|H4|H5|H6|PRE)$/.test(block.tagName)) {
            block = block.parentElement;
        }
        if (!block || block === ir) return null;              // 容器/文首：放弃，不误操作
        return block;
    }

    // ============================================================
    // 暴露给 Kotlin 的 window.editor（与旧 editor.js 同名，复用轮询/保存链路）
    // ============================================================
    window.editor = {
        /** 装载/初始化全文：首次进入创建 Vditor，之后 setValue 热更新 */
        loadMarkdown: function (src, sel, keepEditing) {
            pendingValue = src || '';
            if (vd && ready) {
                safe(function () { vd.setValue(src || '', true); });
                scheduleImgRewrite();   // v1.59：切笔记后重渲染的图也要改写
            } else if (!vd) {
                mount(src || '');
            }
        },
        getSource: getSource,
        /** 轮询探针（未编辑态用）：编辑态 + 轻量诊断，不含内容。
         *  v1.91：诊断必须返回真实计数——之前硬编码 0，真机面板永远显示
         *  enter=0，掩盖了「JS 到底跑没跑」这个关键取证信息。 */
        probe: function () {
            return { e: editing, d: { en: indentOps.en, ok: indentOps.ok, er: indentOps.er, id: indentDiag }, q: [] };
        },
        /** 轮询全量（编辑态用）：内容 + 光标，走与旧桥相同的 onJsContentChanged */
        stat: function () {
            // v1.58：出队 JS→Kotlin 事件（图片等），避免被重复消费
            var q = __jsQueue;
            __jsQueue = [];
            return {
                e: editing,
                s: getSource(),
                c: 0,
                d: { en: indentOps.en, ok: indentOps.ok, er: indentOps.er, id: indentDiag },
                q: q
            };
        },
        /** 退出编辑态（键盘收起时）：Vditor IR 始终可编辑，这里仅失焦 */
        exitEditMode: function () {
            if (vd && ready) safe(function () { vd.blur(); });
            editing = false;
            // v1.53：立即刷新工具栏 —— 预览态强制隐藏，不等下一次键盘/轮询事件
            safe(function () { dockUpdate(); });
        },
        /** 进入编辑态（新笔记自动进编辑）：聚焦编辑器 */
        enterEditAt: function (sel) {
            if (vd && ready) safe(function () { vd.focus(); });
            else pendingFocus = true;
        },
        /** 主题落地：注入 CSS 变量 + 切换 Vditor 昼夜主题 + 字号 */
        applyTheme: function (vars) {
            injectTheme(vars);
            if (!vars) return;
            currentNight = isNight(vars);
            if (vd && ready) safe(function () { vd.setTheme(currentNight ? 'dark' : 'classic'); });
            else pendingTheme = vars;
        },
        /** 插入图片（Kotlin 图片工具回填 img://key）：Vditor 渲染为本地图 */
        insertImage: function (key) {
            if (!vd || !ready) return;
            safe(function () { vd.insertValue('![图片](img://' + key + ')'); });
            // v1.59：插图后 Vditor 异步重绘出 <img>，改写它的 src 才加载得出来
            scheduleImgRewrite();
        },
        /** 源码 ⇄ 即时渲染 切换（顶栏眼睛按钮） */
        toggleSourceMode: function () {
            if (!vd) return;
            var val = getSource();
            currentMode = (currentMode === 'ir') ? 'sv' : 'ir';
            safe(function () { vd.destroy(); });
            vd = null; ready = false;
            mount(val);
        },
        /** 撤回 / 重做：Sprint 4 统一走 Kotlin 历史栈（commitSnapshot 记录所有内容
         *  变化、含结构变换），经 JS→Kotlin 队列发事件——不再调 Vditor 原生 undo
         *  （其栈不记录 setValue 结构变换，#82-7 实证不可撤销）。 */
        undo: function () { pushEvent('undo'); },
        redo: function () { pushEvent('redo'); },
        /**
         * v1.44：Kotlin 推送键盘状态（ime insets：边沿触发 + 页面就绪补推）。
         * v1.64：显隐已与键盘解耦（editing 驱动，悬浮键盘 insets 零证据），
         * 推送只承载「键盘占窗口高度」证据 —— (true,false)=普通键盘实证 →
         * 工具栏立即入流贴键盘上沿；其余组合不影响显示。
         */
        onIme: function (open, floating) { if (editorImePush) editorImePush(open, floating); },
        focus: function () { if (vd && ready) safe(function () { vd.focus(); }); else pendingFocus = true; },
        blur: function () { if (vd && ready) safe(function () { vd.blur(); }); },

        // ---- 兼容旧工具栏工具（原生格式栏已隐藏，以下为兜底/可被 Vditor 接管）----
        insertText: function (t) { if (vd && ready) safe(function () { vd.insertValue(t); }); },
        wrapSelection: function (b, a) {
            if (!vd || !ready) return;
            safe(function () {
                var sel = vd.getSelection();
                if (sel) vd.updateValue(b + sel + a); else vd.insertValue(b + a);
            });
        },
        applyLinePrefix: function (p) { if (vd && ready) safe(function () { vd.insertValue(p); }); },
        /**
         * v1.82：把光标移到「当前块的最开头（列表标记之前）」。
         * 实测：Vditor IR 的原生 Tab 嵌套只在光标位于块开头时才触发——光标在行尾/
         * 行中时按 Tab 不会嵌套（任务列表尤其明显）。缩进按钮要让用户光标在行内任意
         * 位置都能缩进，故派发 Tab 前先把光标归到块首，确保原生嵌套稳定生效。
         */
        caretToBlockStart: function () {
            var block = indentBlockEl();
            if (!block) return;          // 光标不在任何内容块内：保持不动（旧版会甩到整篇最开头）
            var sel = window.getSelection();
            var range = document.createRange();
            try { range.selectNodeContents(block); range.collapse(true); } catch (e) { return; }
            sel.removeAllRanges();
            sel.addRange(range);
        },
        // 返回光标所在块的标签名，用于缩进分支（LI 走原生 Tab，其余走全角空格）；
        // 不在任何内容块内返回 null，缩进/减缩进据此放弃操作，避免误改文档。
        currentBlockTag: function () {
            var b = indentBlockEl();
            return b ? b.tagName : null;
        },
        // 段落/引用减缩进：删除行首一个缩进单元（全角空格）。走 Vditor 原生
        // deleteValue（对选中内容 execCommand('delete') 并触发 IR 重渲染），光标自然
        // 落在删除后位置，不会跑最前、也不会丢字。
        outdentParagraph: function () {
            if (!vd || !ready) return;
            var block = indentBlockEl();
            if (!block) return;                       // 不在内容块内：不动（旧版会删掉文首字符）
            var sel = window.getSelection();
            // 找块内首个文本节点（含行首全角空格缩进）
            var firstText = null;
            (function walk(n) {
                if (firstText) return;
                if (n.nodeType === 3 && n.textContent.length) { firstText = n; return; }
                for (var i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]);
            })(block);
            if (!firstText) return;
            var m = firstText.textContent.match(/^[　]+/);
            if (!m) return;                       // 无缩进可去，no-op
            var remove = Math.min(PARA_INDENT_UNIT.length, m[0].length);
            var range = document.createRange();
            range.setStart(firstText, 0);
            range.setEnd(firstText, remove);
            sel.removeAllRanges();
            sel.addRange(range);
            safe(function () { vd.deleteValue(); });
        },
        // Sprint 2：列表加/减缩进统一走 transformList（ListStructureTransformer 纯源码变换），
        // 不再依赖 Vditor 原生 Tab + Kotlin 可信按键派发 + 60/140ms 轮询布防（去除时序风险）。
        // 段落/引用缩进仍用全角空格单元（见 PARA_INDENT_UNIT 说明）。
        indentLine: function () {
            indentOps.en++;
            var tag = this.currentBlockTag();
            if (tag === null) return;                  // 光标不在内容块内（点到列表空白/容器）：放弃
            if (tag === 'LI') {
                transformList('indent');              // 源码级缩进 + 受控重渲染 + 光标还原
            } else {
                this.caretToBlockStart();
                this.insertText(PARA_INDENT_UNIT);
            }
        },
        outdentLine: function () {
            indentOps.en++;
            var tag = this.currentBlockTag();
            if (tag === null) return;                  // 同上：放弃，不删任何字符
            if (tag === 'LI') {
                transformList('outdent');             // 源码级减缩进 + 受控重渲染 + 光标还原
            } else {
                this.outdentParagraph();              // 段落/引用去一个缩进单元
            }
        },
        softBreak: function () { if (vd && ready) safe(function () { vd.insertValue('\n'); }); },
        /** v1.57：注入自定义工具栏配置；vd 已就绪则立即重建生效，否则仅存全局（mount 时读取） */
        setToolbarConfig: function (cfg) {
            __toolbarCfg = cfg || null;
            if (vd && ready) rebuildToolbar();
        },
        /** v1.57：按当前配置重建工具栏（设置返回编辑页时由 Kotlin 调用；
         *  setToolbarConfig 已顺带重建，这里额外暴露便于强制刷新 */
        rebuildToolbar: function () { rebuildToolbar(); }
    };

    function clickBar(type) {
        if (!vd || !ready) return;
        safe(function () {
            var btn = document.querySelector('.vditor-toolbar [data-type="' + type + '"]');
            if (btn) btn.click();
        });
    }

    /**
     * v1.82：缩进/减缩进改为驱动 Vditor 原生 Tab 嵌套。
     *
     * 背景（实测证据，headless Chromium 加载内联 editor.html 复现）：
     *  - Vditor IR（Typora 式即时渲染）内核会把「段落/列表的前导空格」在重渲染时
     *    归一化掉：'  hello' → 'hello'、'  - a' → '- a'，'>> quoted' → '>> quoted\n>>\n'
     *    （引用多层还会错乱多出空行）。因此 v1.80/1.81 的「setValue 前导空格」自实现
     *    方案在 IR 下根本不生效，且每次 setValue 会把光标重置到文首、重渲染后光标落在
     *    非法位置 → 表现为「缩进没发生、光标跑到最前、编辑器卡死」。
     *  - 正确做法：IR 下只有 Vditor 自带的 Tab 键嵌套（列表/任务/有序）既能被 Lute
     *    正确保留、又能正确处理光标（不会跳到文首）。但页面内 JS 无法合成「可信」按键
     *    事件——Chromium 只把原生按键送进编辑器的键处理管线（合成 KeyboardEvent 实测
     *    不触发 Vditor 的嵌套逻辑，而真实按键/C dp Input.dispatchKeyEvent 可以）。
     *  - 故这里只把意图入队，由 Kotlin 经 WebView.dispatchKeyEvent 派发可信
     *    Tab（缩进）/ Shift+Tab（减缩进）事件，与 pickImage 同一条 JS→Kotlin 队列。
     *  - 引用 / 段落：原生 Tab 无操作，属 IR（Typora）模型限制，此时按钮不破坏光标。
     *  - 撤销：Vditor 的 Tab 会写进它自己的撤销栈，且本 App 的快照轮询也会记录新源码，
     *    因此 Ctrl/⌘+Z 仍可按步撤销。
     */
})();
