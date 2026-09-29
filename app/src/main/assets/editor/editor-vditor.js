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
        // 缩进/减缩进由自实现 DOM 按钮提供（IR 下 Vditor 会 hide 原生按钮），故剔除
        return effectiveIds().filter(function (id) {
            return id !== 'indent' && id !== 'outdent';
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

    /** Vditor 渲染是异步的（IR 分块重绘），单次改写赶不上 → 补两次延时兜底 */
    function scheduleImgRewrite() {
        setTimeout(function () { rewriteImgRefs(); }, 0);
        setTimeout(function () { rewriteImgRefs(); }, 80);
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
            // v1.57：Vditor 工具栏 DOM 已生成，往末尾追加用户自定义插入文本按钮
            setTimeout(renderCustomTools, 0);
            // v1.58：追加「图片」等特殊内置工具按钮
            setTimeout(renderSpecialTools, 0);
            // v1.79：追加自实现的「缩进/减缩进」按钮（IR 下原生缩进不可用）
            setTimeout(renderIndentTools, 0);
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
     * v1.93：光标定位改为「单一全局字符偏移」坐标系——与 Vditor 内部 setSelection 同源。
     * 证据（headless Chromium 实测）：IR 渲染后的 ir.element.textContent 是纯内容文字，
     * 完全不含列表 marker（- / 1. ）与行首缩进空格；减缩进/加缩进只动源码层行首空格，
     * 重渲染后 textContent 长度不变 → 光标在 textContent 中的全局偏移零校正即可还原。
     * 因此彻底抛弃 v1.92 的 line+inner 双坐标系、countOwnMarkers 猜行号、li 遍历还原、
     * 文本锚定兜底还原——那些都是绕开官方机制自己造的脆弱换算。
     * 文本锚定（liOwnText）只保留用于「定位要改的源码行」这一件事（见 outdentSubtree）。
     */
    /** 光标在 ir.element 整体 textContent 中的全局字符偏移（单坐标系）。取不到返回 null。 */
    /**
     * v1.94 光标坐标系（第三次重写，前两版都被真机打脸）：
     *  · v1.92 line+inner：li 覆盖行数靠猜，混合文档错位 → 减错行。
     *  · v1.93 全局字符偏移：实测发现 outdent/Tab 改变列表嵌套结构（子项↔同级）时，
     *    Lute 重渲染后 textContent 的字符序列（换行文本节点）跟着变，「同一数字」
     *    在新旧 DOM 里指向不同文字——headless 铁证：off=17 从「观后感开头」漂成
     *    「哈哈哈末尾」。零校正假设不成立，真机表现即「光标跳到别的行」。
     *  · v1.94 相对坐标系 {text, idx, off}：text=光标 li 的自有文字指纹
     *    （liOwnText），idx=第几个同名 li，off=光标在 li 自有文本流内的字符偏移。
     *    减缩进/加缩进只平移结构不改 li 自身文字与行内位置，三个量语义天然不变；
     *    重渲染后按 text+idx 找回 li、按 off 落回字符。找不到（文字被改/折叠）
     *    就放弃，光标留在 Vditor 放置处——绝不错位。 */
    function caretLiPos() {
        try {
            var liEl = currentLiEl();
            if (!liEl) return null;
            var text = liOwnText(liEl);
            if (!text) return null;
            var lis = vd.vditor.ir.element.querySelectorAll('li');
            var idx = 0, hit = false;
            for (var i = 0; i < lis.length; i++) {
                if (liOwnText(lis[i]) === text) {
                    idx++;
                    if (lis[i] === liEl) { hit = true; break; }
                }
            }
            if (!hit) return null;
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount) return null;
            var range0 = sel.getRangeAt(0);
            var node = range0.startContainer, off = range0.startOffset;
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
                if (n !== liEl && n.tagName === 'LI') return false;   // 跳过后代 li 子树
                for (var c = 0; c < n.childNodes.length; c++) if (walk(n.childNodes[c])) return true;
                return false;
            })(liEl);
            return { text: text, idx: idx, off: acc };
        } catch (e) { return null; }
    }

    /** 按 {text,idx,off} 把光标落回：找第 idx 个同名 li，在其自有文本流走 off 个字符；
     *  找不到 li（文字被改/懒延续折叠）或超长则安全降级（落 li 末尾/放弃）。 */
    function restoreLiPos(pos) {
        if (!pos || !pos.text) return;
        try {
            var irEl = vd.vditor.ir.element;
            var lis = irEl.querySelectorAll('li');
            var idx = 0, targetLi = null, off = pos.off;
            for (var i = 0; i < lis.length; i++) {
                if (liOwnText(lis[i]) === pos.text) {
                    idx++;
                    if (idx === pos.idx) { targetLi = lis[i]; break; }
                }
            }
            if (!targetLi) {
                // 降级（v1.94）：Lute 懒延续折叠会把光标 li 吞进父 li 纯文本流
                // （headless 实证：ownText 变成「哈哈哈2.观后感」，精确匹配消失，
                // 光标被 setValue 留在文首——真机表现即「点减缩进后光标跑最顶上」）。
                // 退而找「以光标 li 文字为前缀」的折叠宿主 li：取第 idx 个（不够则
                // 取最后一个），偏移钳制在原文字长度内——落原文字处，绝不落文首。
                var prefTotal = 0, prefLast = null;
                for (var j = 0; j < lis.length; j++) {
                    var own2 = liOwnText(lis[j]);
                    if (own2.length > pos.text.length && own2.indexOf(pos.text) === 0) {
                        prefTotal++;
                        prefLast = lis[j];
                        if (prefTotal === pos.idx) { prefLast = lis[j]; break; }
                    }
                }
                targetLi = prefLast;
                if (off > pos.text.length) off = pos.text.length;
            }
            if (!targetLi) return;                       // 彻底找不到：宁可不动也不落错行
            var acc = 0, spot = null;
            (function walk(n) {
                if (spot) return true;
                if (n.nodeType === 3) {
                    var len = n.textContent.length;
                    if (off <= acc + len) { spot = { node: n, off: off - acc }; return true; }
                    acc += len; return false;
                }
                if (n !== targetLi && n.tagName === 'LI') return false;
                for (var c = 0; c < n.childNodes.length; c++) if (walk(n.childNodes[c])) return true;
                return false;
            })(targetLi);
            var range = document.createRange();
            if (spot) {
                range.setStart(spot.node, spot.off);
                range.collapse(true);
            } else {
                range.selectNodeContents(targetLi);
                range.collapse(false);                   // 偏移超长（行内文字变化）：落 li 末尾
            }
            var sel2 = window.getSelection();
            sel2.removeAllRanges(); sel2.addRange(range);
        } catch (e) {}
    }

    /** 光标所在的 li 元素（用于文本锚定定位源码行）；不在 li 内返回 null。 */
    function currentLiEl() {
        try {
            var irEl = vd.vditor.ir.element;
            var sel = window.getSelection();
            if (!sel || !sel.rangeCount) return null;
            var node = sel.getRangeAt(0).startContainer;
            var el = (node.nodeType === 1) ? node : node.parentElement;
            while (el && el !== irEl && el.tagName !== 'LI') el = el.parentElement;
            return (el && el !== irEl && el.tagName === 'LI') ? el : null;
        } catch (e) { return null; }
    }

    /**
     * v1.86（v1.94 简化）：加缩进用 Vditor 原生 Tab（真机实测源码/结构全对），
     * 仅修其唯一缺陷——嵌套任务列表时 checkbox 渲染成字面 '[ ]'。做法：Tab 派发前
     * 记录光标的 li 相对坐标（caretLiPos，见上方 v1.94 注释）；Tab 生效且源码含任务
     * 标记时 setValue 全量重渲染修复 checkbox，再按 li 相对坐标还原光标（Tab 只平移
     * 结构、不改 li 自身文字）。无序/有序无渲染问题则不刷新。
     * 1.84/1.85 的源码级缩进整体移除；v1.92 的 line+inner 双坐标系于 v1.93 移除。
     */

    /** 任务列表渲染是否真的坏了：源码里的任务项数 > DOM 里的 checkbox 数，说明有项的
     *  '[ ]' 还以字面文本显示（正是 1.83 反馈的「缩进一次后 checkbox 渲染异常」）。
     *  渲染已正常的场景返回 false → 不做 setValue，零闪烁、光标保持 Vditor 原生位置。 */
    function taskRenderBroken(src) {
        var lines = String(src).split('\n'), n = 0;
        for (var i = 0; i < lines.length; i++) {
            // 只统计「有内容」的任务项：纯空项 '- [ ]' 在 IR 里本就不渲染 checkbox
            // （不是渲染异常），算进去会让含空项的文档每次 Tab 都判成坏了、白白全量刷新。
            if (/^\s*[-*+]\s+\[[ xX]\]\s+\S/.test(lines[i])) n++;
        }
        if (!n) return false;
        var boxes = vd.vditor.ir.element.querySelectorAll('input[type=checkbox]').length;
        return boxes < n;
    }

    var tabRefreshTimer = null;
    var indentDiag = '';   // v1.89：最近一次缩进刷新的结果（经 stat 回传 Kotlin，便于真机取证）
    var indentOps = { en: 0, ok: 0, er: 0 };   // v1.89：缩进/减缩进真实计数（面板不再恒为 0）

    /**
     * v1.90：列表减缩进的源码级实现（v1.89 只覆盖任务列表，v1.90 扩到全部列表）。
     * 不再派发 Shift+Tab——真机+headless 双重复现：Vditor 4.0 原生 Shift+Tab 对
     * 「带 ≥2 层后代子树的列表项」减缩进时，会把后代子树复制一份（4 行文档变 5 行：
     * 最深后代被复制到上一层，无序/有序/任务三种列表全部中招，与光标位置无关；
     * 浅树、加缩进 Tab 均正常，Vditor 自身 bug）。
     * 做法：直接改源码——当前行及其整个子树（缩进更深的连续行）统一左移 cut 空格
     * （cut 按当前行 marker 取步长：有序 3、无序/任务 2），各层相对缩进不变 →
     * Lute 解析出的结构与减缩进前完全同构，物理上不可能产生复制；
     * 再 setValue 全量重渲染（checkbox 天然正确）并按 pos 恢复光标。
     */
    /** v1.92：光标 li 的自有文本指纹——摘掉后代 li、去全部空白。
     *  caretSourcePos 的「li 索引→源码行号」累计在混合文档（无序+有序懒延续+任务）
     *  上会偏移（真机实锤：操作有序「第二步」却减缩进了无序「地道」），行号只能当
     *  提示用，动手前必须用文本锚定校验。 */
    function liOwnText(li) {
        var clone = li.cloneNode(true);
        var descs = clone.querySelectorAll('li');
        for (var d = 0; d < descs.length; d++) descs[d].remove();
        var cbs = clone.querySelectorAll('input');
        for (var c = 0; c < cbs.length; c++) cbs[c].remove();
        return (clone.textContent || '').replace(/\s+/g, '');
    }

    /** 剥掉行首 marker 与空白后的行内容（用于与 liOwnText 精确比对）。 */
    function lineCoreText(L) {
        return String(L).replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.\s)/, '').replace(/\s+/g, '');
    }

    /** v1.94：按 li 文字指纹定位源码行——ownText 是第 idx 个同名 li，
     *  取源码里第 idx 个 lineCoreText 一致的列表行（DOM 序==源码序，多处同名也精确命中）。
     *  找不到返回 -1，调用方放弃不动。 */
    function findSourceLineByLi(ownText, idx, lines, MARK) {
        if (!ownText || idx < 1) return -1;
        var c = 0;
        for (var j = 0; j < lines.length; j++) {
            if (MARK.test(lines[j]) && lineCoreText(lines[j]) === ownText) {
                c++;
                if (c === idx) return j;
            }
        }
        return -1;
    }

    /** v1.90：列表减缩进源码级实现（绕开 Vditor 4.0 原生 Shift+Tab 对深层子树的复制 bug）。
     *  liPos：光标的 li 相对坐标 {text, idx, off}（v1.94）——text/idx 定位要平移的源码行，
     *  setValue 重渲染后按同一坐标还原光标（结构平移不改 li 自身文字，坐标语义稳定）。 */
    function outdentSubtree(liPos) {
        if (!vd || !ready) return false;
        var src = getSource();
        if (src == null) return false;
        var lines = src.split('\n');
        var MARK = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.\s)/;
        // 文本锚定定位：光标 li 的文字指纹 + 同名序号 → 源码里精确行（无就近兜底）。
        var target = findSourceLineByLi(liPos.text, liPos.idx, lines, MARK);
        if (target < 0) { indentDiag = 'outdent:notfound'; return false; }
        var line = lines[target];
        var m = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s?)?|\d+\.\s+)/);
        if (!m) return false;                              // 不是列表行：不动
        var cur = m[1].length;
        if (cur === 0) { indentDiag = 'outdent:top'; return true; }   // 已是一级：无事可做
        var cut = Math.min(/^\s*\d+\.\s/.test(line) ? 3 : 2, cur);
        // 子树范围：从下一行起，前导缩进比当前行更深的连续行（空行跳过、跟随其后判定）
        var end = target + 1;
        while (end < lines.length) {
            var l2 = lines[end];
            if (!l2.trim()) { end++; continue; }
            var ind2 = (l2.match(/^(\s*)/) || ['',''])[1].length;
            if (ind2 > cur) { end++; continue; }
            break;
        }
        for (var j = target; j < end; j++) {
            var l3 = lines[j];
            if (!l3.trim()) continue;
            var ind3 = (l3.match(/^(\s*)/) || ['',''])[1].length;
            lines[j] = l3.substring(Math.min(cut, ind3));
        }
        var out = lines.join('\n');
        var l0 = lines.length;
        safe(function () { vd.setValue(out, false); });
        // 膨胀守卫（与 armTabRefresh 同款）：异常立即回滚，绝不把坏内容留在文档里
        var l1 = getSource().split('\n').length;
        if (l1 > l0 + 2) {
            safe(function () { vd.setValue(src, false); });
            indentDiag = 'ROLLBACK ' + l0 + '->' + l1;
            indentOps.er++;
            return false;
        }
        indentDiag = 'src-outdent ' + cur + '->' + (cur - cut) + ' rows=' + (end - target);
        indentOps.ok++;
        restoreLiPos(liPos);              // li 相对坐标还原：结构平移下 text/idx/off 语义不变
        return true;
    }

    // v1.89：已移除 v1.88 的「同一份源码只刷一次」去重（lastFixSrc），原因见下方
    // taskRenderBroken 判定处注释：同一份源码在不同 live DOM 状态下渲染可不同，去重
    // 会让坏渲染留在文档里。空任务项误刷由 taskRenderBroken 内的 \s+\S 过滤解决。
    /**
     * Tab 派发前布防：轮询源码，生效后按需全量重渲染修复 checkbox（详见上方注释），
     * 并把光标还原到 pos（缩进前记录的真实行内位置）。
     * @param pos 由调用方在 caretToBlockStart 归位前记录；未传则就地取当前光标。
     */
    function armTabRefresh(p) {
        if (!vd || !ready) return;
        if (tabRefreshTimer) { clearInterval(tabRefreshTimer); tabRefreshTimer = null; }
        var srcBefore = getSource();
        if (srcBefore == null) return;
        if (p == null) p = caretLiPos();
        var tries = 0;
        indentDiag = 'armed';   // 清空上一次的诊断，避免读到残留值误判
        tabRefreshTimer = setInterval(function () {
            tries++;
            var now = getSource();
            if (now === srcBefore) {
                // Tab 尚未派发/未生效：继续等，超时（约 1.6s，如列表首项 Tab 本就无操作）放弃
                if (tries > 20) {
                    clearInterval(tabRefreshTimer); tabRefreshTimer = null;
                    indentDiag = 'timeout';   // Tab 未改变源码（如已在最深层级）：放弃，不动光标
                }
                return;
            }
            clearInterval(tabRefreshTimer); tabRefreshTimer = null;
            // 先让 Vditor 自己渲染一帧再判定：多数情况它已把 checkbox 渲染好，无需 setValue。
            // 判定/写入都用「最新源码」，避免这 140ms 里用户新输入的内容被旧快照覆盖。
            setTimeout(function () {
                var latest = getSource();
                // v1.89：判定只看「渲染现在坏没坏」，不再按源码去重。
                // v1.88 曾用 latest !== lastFixSrc 去重（同一份源码只刷一次），实测错误：
                // 同一份源码在不同 live DOM 状态下渲染结果可以不同——setValue 只修当次，
                // 之后的 Tab/减缩进会再次把 checkbox 弄坏，而源码没变 → 去重误判"处理过"
                // 而跳过修复，坏渲染就留在文档里（深树实测 boxes 5/6）。
                // 空任务项误刷已由 taskRenderBroken 的 \s+\S 过滤解决，无需源码去重兜底。
                if (taskRenderBroken(latest)) {
                    var l0 = latest.split('\n').length;
                    safe(function () { vd.setValue(latest, false); });   // 全量重渲染修复 checkbox
                    var l1 = getSource().split('\n').length;
                    // 膨胀守卫：若 setValue 让行数异常增长（真机反馈过"莫名多出几十个待办框"），
                    // 立刻用同一份源码回滚并留下证据，绝不把异常内容留在文档里。
                    if (l1 > l0 + 2) {
                        safe(function () { vd.setValue(latest, false); });
                        indentDiag = 'ROLLBACK ' + l0 + '->' + l1;
                        indentOps.er++;
                    } else {
                        indentDiag = 'fix ' + l0 + '->' + l1;
                        indentOps.ok++;
                    }
                } else {
                    indentDiag = 'ok(nofix)';
                }
                // 无论有没有 setValue，都把光标还原到缩进前的行内位置（v1.94 li 相对坐标）：
                // 归位块首是为了让原生 Tab 生效，但缩进完光标留在文字最前面是用户明确抱怨的行为。
                restoreLiPos(p);
            }, 140);
        }, 60);
    }

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
        /** 撤回 / 重做：触发 Vditor 工具栏内置按钮（公共 API 未暴露，走 UI 按钮） */
        undo: function () { clickBar('undo'); },
        redo: function () { clickBar('redo'); },
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
        // v1.86：恢复 1.83 的原生 Tab 缩进（真机实测源码/结构全对，仅渲染不刷新）。
        // 列表：光标归块首 → 经 Kotlin 派发可信 Tab；派发前 armTabRefresh 布防，
        // Tab 生效后按需全量重渲染修复任务列表 checkbox（见 armTabRefresh 注释）。
        // 段落/引用：维持全角空格单元（见 PARA_INDENT_UNIT 说明）。
        indentLine: function () {
            indentOps.en++;                            // v1.89：真实调用计数（面板不再恒为 0）
            var tag = this.currentBlockTag();
            if (tag === null) return;                  // 光标不在内容块内（点到列表空白/容器）：放弃
            if (tag === 'LI') {
                // v1.88：先记下光标「真实位置」（行号 + 行内字符偏移），再归位块首。
                // 归位是原生 Tab 嵌套的前提，但归位后光标就在文字最前面——Tab 生效后
                // 必须按记录把它送回原处，否则用户每缩进一次光标就跳到行首（真机反馈）。
                var p = caretLiPos();            // v1.94：li 相对坐标（结构平移下稳定）
                this.caretToBlockStart();
                armTabRefresh(p);                // Tab 生效后按需刷新渲染 + 还原光标
                pushEvent('indentTab');
            } else {
                // 段落/引用：归位行首再插全角空格单元。缩进是「整行」语义（首行缩进），
                // 不归位的话会插到光标所在位置（行尾点缩进 → 空格跑到文字后面，
                // 减缩进又只认行首，结果加了去不掉）。
                this.caretToBlockStart();
                this.insertText(PARA_INDENT_UNIT);
            }
        },
        outdentLine: function () {
            indentOps.en++;
            var tag = this.currentBlockTag();
            if (tag === null) return;                  // 同上：放弃，不删任何字符
            if (tag === 'LI') {
                // v1.91：列表减缩进只走源码级，永远不派发原生 Shift+Tab（其深层子树复制 bug）。
                // v1.94：光标用 li 相对坐标（caretLiPos）——text/idx 定位源码行 + 还原光标。
                // v1.93 的全局字符偏移被真机/headless 证伪：outdent 改变嵌套结构后
                // textContent 序列变化，同一偏移漂到别的 li（「观后感跳到哈哈哈」）。
                var p = caretLiPos();
                if (!p) { indentDiag = 'outdent:nopos'; indentOps.er++; return; }
                if (!outdentSubtree(p)) {
                    indentOps.er++;                  // 定位失败（找不到一致行）：放弃，不动源码
                }
                return;
            }
            this.outdentParagraph();           // 段落/引用去一个缩进单元
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
