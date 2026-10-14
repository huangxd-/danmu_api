// language=CSS
export const themesCssContent = /* css */ `
/* 设计令牌与七色主题 + 独立明暗切换 — 参照 Bangumi-syncer 柔和圆角设计风格 */

/* ============ 全局设计令牌 ============ */
:root {
    --app-ease-smooth: cubic-bezier(0.22, 1, 0.36, 1);
    --app-radius-card: 16px;
    --app-radius-card-sm: 12px;
    --app-radius-btn: 14px;
    --app-radius-input: 999px;
    --app-radius-shell: 24px;
    --app-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.03), 0 2px 8px rgba(15, 23, 42, 0.04);
    --app-shadow-md: 0 2px 4px rgba(15, 23, 42, 0.04), 0 8px 18px rgba(15, 23, 42, 0.06);
    --app-shadow-lg: 0 4px 12px rgba(15, 23, 42, 0.06), 0 12px 28px rgba(15, 23, 42, 0.05);
    --app-shadow-elevated: 0 8px 24px rgba(15, 23, 42, 0.08);
}

/* ============ 浅色模式默认值（无 data-color-scheme 或 data-color-scheme="light"） ============ */
/* 变量定义在根元素上，主题属性缺失时页面底色与强调色仍有可用值 */
:root {
    --app-primary: #8cb48c;
    --app-primary-rgb: 140, 180, 140;
    --app-primary-hover: #7aa37a;
    --app-primary-soft: rgba(140, 180, 140, 0.10);

    --theme-page-bg: #e8efe8;
    --theme-container-bg: #ffffff;
    --theme-content-bg: #ffffff;
    --theme-panel-bg: rgba(140, 180, 140, 0.04);
    --theme-panel-strong: rgba(140, 180, 140, 0.08);
    --theme-header: #ffffff;
    --theme-header-accent: #8cb48c;
    --theme-accent: #8cb48c;
    --theme-accent-hover: #7aa37a;
    --theme-accent-soft: rgba(140, 180, 140, 0.10);
    --theme-text: #1a1a22;
    --theme-muted: #6e6e7a;
    --theme-border: rgba(30, 30, 36, 0.08);
    --theme-input-bg: #ffffff;
    --theme-code-bg: #1a1b24;
    --theme-code-text: #e2e4ea;
    --theme-link: #8cb48c;
    --theme-check-color: #ffffff;
    color-scheme: light;
}

body {
    color: var(--theme-text);
    transition: background-color 0.3s ease, color 0.3s ease;
}

/* ============ 七色强调色（仅定义颜色相关变量，不碰背景/文字） ============ */
:is(html, body)[data-theme="shinyo"] {
    --app-primary: #8cb48c; --app-primary-rgb: 140,180,140; --app-primary-hover: #7aa37a; --app-primary-soft: rgba(140,180,140,0.10);
    --theme-header-accent: #8cb48c; --theme-accent: #8cb48c; --theme-accent-hover: #7aa37a; --theme-accent-soft: rgba(140,180,140,0.10);
    --theme-page-bg: #e8efe8; --theme-panel-bg: rgba(140,180,140,0.04); --theme-panel-strong: rgba(140,180,140,0.08);
    --theme-link: #8cb48c;
}
:is(html, body)[data-theme="sakura"] {
    --app-primary: #f09199; --app-primary-rgb: 240,145,153; --app-primary-hover: #e08189; --app-primary-soft: rgba(240,145,153,0.10);
    --theme-header-accent: #f09199; --theme-accent: #f09199; --theme-accent-hover: #e08189; --theme-accent-soft: rgba(240,145,153,0.10);
    --theme-page-bg: #ece6ef; --theme-panel-bg: rgba(240,145,153,0.04); --theme-panel-strong: rgba(240,145,153,0.08);
    --theme-link: #f09199;
}
:is(html, body)[data-theme="tianyi"] {
    --app-primary: #00a2ff; --app-primary-rgb: 0,162,255; --app-primary-hover: #0090e8; --app-primary-soft: rgba(0,162,255,0.10);
    --theme-header-accent: #00a2ff; --theme-accent: #00a2ff; --theme-accent-hover: #0090e8; --theme-accent-soft: rgba(0,162,255,0.10);
    --theme-page-bg: #e7edf5; --theme-panel-bg: rgba(0,162,255,0.04); --theme-panel-strong: rgba(0,162,255,0.08);
    --theme-link: #00a2ff;
}
:is(html, body)[data-theme="hatsune"] {
    --app-primary: #39c5bb; --app-primary-rgb: 57,197,187; --app-primary-hover: #2eb3a9; --app-primary-soft: rgba(57,197,187,0.10);
    --theme-header-accent: #39c5bb; --theme-accent: #39c5bb; --theme-accent-hover: #2eb3a9; --theme-accent-soft: rgba(57,197,187,0.10);
    --theme-page-bg: #e6f2f0; --theme-panel-bg: rgba(57,197,187,0.04); --theme-panel-strong: rgba(57,197,187,0.08);
    --theme-link: #39c5bb;
}
:is(html, body)[data-theme="sakuragi"] {
    --app-primary: #e9485e; --app-primary-rgb: 233,72,94; --app-primary-hover: #d63d52; --app-primary-soft: rgba(233,72,94,0.10);
    --theme-header-accent: #e9485e; --theme-accent: #e9485e; --theme-accent-hover: #d63d52; --theme-accent-soft: rgba(233,72,94,0.10);
    --theme-page-bg: #f0e7e9; --theme-panel-bg: rgba(233,72,94,0.04); --theme-panel-strong: rgba(233,72,94,0.08);
    --theme-link: #e9485e;
}
:is(html, body)[data-theme="violet"] {
    --app-primary: #a682e6; --app-primary-rgb: 166,130,230; --app-primary-hover: #9570d8; --app-primary-soft: rgba(166,130,230,0.10);
    --theme-header-accent: #a682e6; --theme-accent: #a682e6; --theme-accent-hover: #9570d8; --theme-accent-soft: rgba(166,130,230,0.10);
    --theme-page-bg: #ede8f5; --theme-panel-bg: rgba(166,130,230,0.04); --theme-panel-strong: rgba(166,130,230,0.08);
    --theme-link: #a682e6;
}
:is(html, body)[data-theme="amber"] {
    --app-primary: #f78c50; --app-primary-rgb: 247,140,80; --app-primary-hover: #e67a40; --app-primary-soft: rgba(247,140,80,0.10);
    --theme-header-accent: #f78c50; --theme-accent: #f78c50; --theme-accent-hover: #e67a40; --theme-accent-soft: rgba(247,140,80,0.10);
    --theme-page-bg: #f0ebe6; --theme-panel-bg: rgba(247,140,80,0.04); --theme-panel-strong: rgba(247,140,80,0.08);
    --theme-link: #f78c50;
}

/* 经典默认 — 原版紫蓝渐变 */
:is(html, body)[data-theme="lavender"] {
    --app-primary: #667eea; --app-primary-rgb: 102,126,234; --app-primary-hover: #5a6fd6; --app-primary-soft: rgba(102,126,234,0.10);
    --theme-header-accent: #667eea; --theme-accent: #667eea; --theme-accent-hover: #5a6fd6; --theme-accent-soft: rgba(102,126,234,0.10);
    --theme-page-bg: #eef0f8; --theme-panel-bg: rgba(102,126,234,0.04); --theme-panel-strong: rgba(102,126,234,0.08);
    --theme-link: #667eea;
}

/* ============ 暗色模式覆盖层（共用的背景/文字/边框变量） ============ */
:is(html, body)[data-color-scheme="dark"] {
    --theme-page-bg: #1a1b24;
    --theme-container-bg: #24262f;
    --theme-content-bg: #24262f;
    --theme-panel-bg: rgba(255, 255, 255, 0.04);
    --theme-panel-strong: rgba(255, 255, 255, 0.07);
    --theme-header: #24262f;
    --theme-text: #f7f3ff;
    --theme-muted: #ada8c1;
    --theme-border: rgba(255, 255, 255, 0.14);
    --theme-input-bg: rgba(255, 255, 255, 0.07);
    --theme-code-bg: #111118;
    --theme-code-text: #e2e4ea;
    --theme-check-color: #000000;
    /* 暗色下背景与浮层的明度接近，阴影加深并由边框共同体现层次 */
    --app-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.07), 0 2px 8px rgba(0, 0, 0, 0.06);
    --app-shadow-md: 0 2px 4px rgba(0, 0, 0, 0.09), 0 8px 18px rgba(0, 0, 0, 0.08);
    --app-shadow-lg: 0 4px 12px rgba(0, 0, 0, 0.11), 0 12px 28px rgba(0, 0, 0, 0.10);
    --app-shadow-elevated: 0 8px 24px rgba(0, 0, 0, 0.14);
    color-scheme: dark;
}

/* Keep native select controls and their popup menus in sync with the theme. */
:is(html, body)[data-color-scheme="dark"] select {
    color-scheme: dark;
}
body:not([data-color-scheme="dark"]) select {
    color-scheme: light;
}

/* 暗色模式下各强调色饱和度降低 */
:is(html, body)[data-color-scheme="dark"][data-theme="shinyo"] {
    --app-primary: #7da67d; --app-primary-hover: #6f966f; --app-primary-soft: rgba(125,166,125,0.12);
    --theme-accent: #7da67d; --theme-accent-hover: #6f966f; --theme-accent-soft: rgba(125,166,125,0.12); --theme-header-accent: #7da67d;
}
:is(html, body)[data-color-scheme="dark"][data-theme="sakura"] {
    --app-primary: #c88692; --app-primary-hover: #b87884; --app-primary-soft: rgba(200,134,146,0.12);
    --theme-accent: #c88692; --theme-accent-hover: #b87884; --theme-accent-soft: rgba(200,134,146,0.12); --theme-header-accent: #c88692;
}
:is(html, body)[data-color-scheme="dark"][data-theme="tianyi"] {
    --app-primary: #5a9ecc; --app-primary-hover: #4f8eb8; --app-primary-soft: rgba(90,158,204,0.12);
    --theme-accent: #5a9ecc; --theme-accent-hover: #4f8eb8; --theme-accent-soft: rgba(90,158,204,0.12); --theme-header-accent: #5a9ecc;
}
:is(html, body)[data-color-scheme="dark"][data-theme="hatsune"] {
    --app-primary: #45b5ad; --app-primary-hover: #3da39c; --app-primary-soft: rgba(69,181,173,0.12);
    --theme-accent: #45b5ad; --theme-accent-hover: #3da39c; --theme-accent-soft: rgba(69,181,173,0.12); --theme-header-accent: #45b5ad;
}
:is(html, body)[data-color-scheme="dark"][data-theme="sakuragi"] {
    --app-primary: #c54e62; --app-primary-hover: #b44558; --app-primary-soft: rgba(197,78,98,0.12);
    --theme-accent: #c54e62; --theme-accent-hover: #b44558; --theme-accent-soft: rgba(197,78,98,0.12); --theme-header-accent: #c54e62;
}
:is(html, body)[data-color-scheme="dark"][data-theme="violet"] {
    --app-primary: #9a7cc4; --app-primary-hover: #8a6eb2; --app-primary-soft: rgba(154,124,196,0.12);
    --theme-accent: #9a7cc4; --theme-accent-hover: #8a6eb2; --theme-accent-soft: rgba(154,124,196,0.12); --theme-header-accent: #9a7cc4;
}
:is(html, body)[data-color-scheme="dark"][data-theme="amber"] {
    --app-primary: #d08858; --app-primary-hover: #bf7a4c; --app-primary-soft: rgba(208,136,88,0.12);
    --theme-accent: #d08858; --theme-accent-hover: #bf7a4c; --theme-accent-soft: rgba(208,136,88,0.12); --theme-header-accent: #d08858;
}
:is(html, body)[data-color-scheme="dark"][data-theme="lavender"] {
    --app-primary: #8b9cf7; --app-primary-hover: #7a8ce6; --app-primary-soft: rgba(139,156,247,0.12);
    --theme-accent: #8b9cf7; --theme-accent-hover: #7a8ce6; --theme-accent-soft: rgba(139,156,247,0.12); --theme-header-accent: #8b9cf7;
}

/* 暗色下主容器以内外配合体现边界：外阴影加深 + 细内描边 */
:is(html, body)[data-color-scheme="dark"] .container {
    box-shadow: var(--app-shadow-lg), inset 0 0 0 0.5px var(--theme-border);
}

/* 暗色模式下减弱发光和光晕 */
:is(html, body)[data-color-scheme="dark"] .btn-primary { box-shadow: none; }
:is(html, body)[data-color-scheme="dark"] .form-group input:focus,
:is(html, body)[data-color-scheme="dark"] .form-group select:focus,
:is(html, body)[data-color-scheme="dark"] .form-group textarea:focus,
:is(html, body)[data-color-scheme="dark"] .preview-search input:focus,
:is(html, body)[data-color-scheme="dark"] .offset-input:focus {
    box-shadow: 0 0 0 3px rgba(var(--app-primary-rgb), 0.12);
}
:is(html, body)[data-color-scheme="dark"] .logo { background: #3a3d48; }

/* ============ 通用主题变量覆盖 ============ */
:is(html, body)[data-theme] .container { background: var(--theme-container-bg); color: var(--theme-text); }
:is(html, body)[data-theme] .header { background: var(--theme-header); border-bottom: 3px solid var(--theme-header-accent); }
:is(html, body)[data-theme] .content { background: var(--theme-content-bg); }
:is(html, body)[data-theme] .footer { color: var(--theme-muted); }
:is(html, body)[data-theme] .footer-text, :is(html, body)[data-theme] .footer-link { color: var(--theme-link); }
:is(html, body)[data-theme] .nav-btn.active { color: #ffffff; }
:is(html, body)[data-theme] .category-btn, :is(html, body)[data-theme] .tag-option, :is(html, body)[data-theme] .available-tag, :is(html, body)[data-theme] .filter-btn { background: var(--theme-panel-strong); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .category-btn.active, :is(html, body)[data-theme] .tag-option.selected, :is(html, body)[data-theme] .selected-tag, :is(html, body)[data-theme] .btn-primary, :is(html, body)[data-theme] .number-btn:hover, :is(html, body)[data-theme] .jump-episode-btn, :is(html, body)[data-theme] .offset-source-tag.selected { background: var(--theme-accent); border-color: var(--theme-accent); color: #ffffff; }
:is(html, body)[data-theme] .btn-primary:hover, :is(html, body)[data-theme] .tag-option.selected:hover, :is(html, body)[data-theme] .selected-tag:hover, :is(html, body)[data-theme] .number-btn:active { background: var(--theme-accent-hover); }
:is(html, body)[data-theme] .env-item, :is(html, body)[data-theme] .preview-item, :is(html, body)[data-theme] .api-params, :is(html, body)[data-theme] .api-selector, :is(html, body)[data-theme] .number-picker, :is(html, body)[data-theme] .selected-tags, :is(html, body)[data-theme] .multi-select-container, :is(html, body)[data-theme] .recent-data-panel, :is(html, body)[data-theme] .anime-cache-card, :is(html, body)[data-theme] .anime-cache-child-item, :is(html, body)[data-theme] .danmu-list-area, :is(html, body)[data-theme] .jump-to-episode, :is(html, body)[data-theme] .request-records-container { background: var(--theme-panel-bg); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .preview-item, :is(html, body)[data-theme] .env-item { border-left-color: var(--theme-accent); }
:is(html, body)[data-theme] .preview-toolbar { background: var(--theme-content-bg); border-color: var(--theme-border); }
:is(html, body)[data-theme] .preview-category-btn, :is(html, body)[data-theme] .preview-search input, :is(html, body)[data-theme] .preview-action-btn { background: var(--theme-panel-strong); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .preview-category-btn:hover, :is(html, body)[data-theme] .preview-search-clear:hover, :is(html, body)[data-theme] .preview-summary:hover { background: var(--theme-panel-bg); }
:is(html, body)[data-theme] .preview-category-btn.active { background: var(--theme-accent-soft); border-color: var(--theme-accent); color: var(--theme-accent); font-weight: 600; box-shadow: 0 0 0 2px var(--theme-accent-soft); transform: translateY(-1px); }
:is(html, body)[data-theme] .preview-summary, :is(html, body)[data-theme] .preview-item { background: var(--theme-panel-bg); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .preview-summary:hover, :is(html, body)[data-theme] .preview-action-btn:hover { border-color: var(--theme-accent); }
:is(html, body)[data-theme] .preview-value { background: var(--theme-panel-strong); color: var(--theme-text); }
:is(html, body)[data-theme] .preview-list, :is(html, body)[data-theme] .preview-group-heading { border-color: var(--theme-border); }
:is(html, body)[data-theme] .preview-description, :is(html, body)[data-theme] .preview-status, :is(html, body)[data-theme] .preview-summary-description, :is(html, body)[data-theme] .preview-summary-arrow, :is(html, body)[data-theme] .preview-group-heading span, :is(html, body)[data-theme] .preview-item-description, :is(html, body)[data-theme] .preview-empty, :is(html, body)[data-theme] .preview-search-clear { color: var(--theme-muted); }
:is(html, body)[data-theme] .preview-summary-count, :is(html, body)[data-theme] .preview-group-heading h3, :is(html, body)[data-theme] .preview-empty strong { color: var(--theme-accent); }
:is(html, body)[data-theme] .env-info strong, :is(html, body)[data-theme] .preview-key, :is(html, body)[data-theme] .number-display, :is(html, body)[data-theme] .env-section h2, :is(html, body)[data-theme] .section h2 { color: var(--theme-accent); }
:is(html, body)[data-theme] .env-info > div.text-dark-gray, :is(html, body)[data-theme] .preview-value, :is(html, body)[data-theme] .env-item .env-info > div.text-dark-gray { background: var(--theme-panel-strong); color: var(--theme-text) !important; }
:is(html, body)[data-theme] .form-group label, :is(html, body)[data-theme] .switch-label, :is(html, body)[data-theme] .form-help, :is(html, body)[data-theme] .text-gray, :is(html, body)[data-theme] .text-dark-gray, :is(html, body)[data-theme] .anime-cache-meta, :is(html, body)[data-theme] .mapping-text { color: var(--theme-muted) !important; }
:is(html, body)[data-theme] .form-group input, :is(html, body)[data-theme] .form-group select, :is(html, body)[data-theme] .form-group textarea, :is(html, body)[data-theme] .offset-input, :is(html, body)[data-theme] .map-input-left, :is(html, body)[data-theme] .map-input-right, :is(html, body)[data-theme] .jump-episode-input, :is(html, body)[data-theme] .batch-color-input { background: var(--theme-input-bg); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .number-btn { background: var(--theme-input-bg); color: var(--theme-accent); border-color: var(--theme-accent); }
:is(html, body)[data-theme] .number-range input[type="range"]::-webkit-slider-thumb, :is(html, body)[data-theme] .number-range input[type="range"]::-moz-range-thumb, :is(html, body)[data-theme] input:checked + .slider { background: var(--theme-accent); }
:is(html, body)[data-theme] .modal-content, :is(html, body)[data-theme] .batch-color-dialog, :is(html, body)[data-theme] .bili-cookie-dialog { background: var(--theme-container-bg); color: var(--theme-text); }
:is(html, body)[data-theme] .theme-settings { background: var(--theme-panel-bg); border-color: var(--theme-border); }
:is(html, body)[data-theme] .theme-option { background: var(--theme-input-bg); color: var(--theme-text); border-color: var(--theme-border); }
:is(html, body)[data-theme] .theme-option[aria-checked="true"] { background: var(--theme-container-bg); border-color: var(--theme-accent); color: var(--theme-accent); box-shadow: var(--app-shadow-sm); transform: translateY(-1px); }
:is(html, body)[data-theme] .theme-current-label { color: var(--theme-accent); }
:is(html, body)[data-theme] .log-container, :is(html, body)[data-theme] .api-response, :is(html, body)[data-theme] .json-response, :is(html, body)[data-theme] .error-response { background: var(--theme-code-bg); color: var(--theme-code-text); }
:is(html, body)[data-theme] .modal-body, :is(html, body)[data-theme] .modal-footer { border-color: var(--theme-border); }
:is(html, body)[data-theme] .theme-option:focus-visible, :is(html, body)[data-theme] .btn:focus-visible, :is(html, body)[data-theme] .category-btn:focus-visible, :is(html, body)[data-theme] .preview-category-btn:focus-visible, :is(html, body)[data-theme] .preview-summary:focus-visible, :is(html, body)[data-theme] .preview-action-btn:focus-visible, :is(html, body)[data-theme] .preview-search-clear:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: 2px; }

/* ============ 主题选择器 ============ */
.theme-settings { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 16px; margin-bottom: 18px; border: 1px solid var(--theme-border); border-radius: 12px; animation: none !important; }
.theme-settings[hidden] { display: none; }
.theme-settings-copy { min-width: 150px; }
.theme-settings-copy h3 { margin-bottom: 4px; font-size: 15px; }
.theme-settings-copy p { margin: 0; color: var(--theme-muted); font-size: 12px; }
.theme-current-label { color: var(--theme-accent); font-size: 12px; font-weight: 600; }
.theme-options { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 6px; flex: 1; }
.theme-option { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 6px 8px; border: 1px solid var(--theme-border); border-radius: 10px; cursor: pointer; text-align: left; transition: border-color 0.22s var(--app-ease-smooth), background 0.22s var(--app-ease-smooth), box-shadow 0.22s var(--app-ease-smooth); }
.theme-option:hover { border-color: var(--theme-accent); }
.theme-option:disabled { cursor: wait; opacity: 0.65; }
.theme-swatches { display: flex; flex-shrink: 0; width: 24px; height: 24px; overflow: hidden; border-radius: 6px; border: 1px solid rgba(0, 0, 0, 0.10); }
.theme-swatches i { flex: 1; }
.theme-option-label { font-size: 11px; font-weight: 600; white-space: nowrap; }
.config-transfer-btn { display: inline-flex; align-items: center; gap: 7px; }
.env-toolbar-actions .btn { align-items: center; display: inline-flex; justify-content: center; gap: 7px; line-height: 1.2; min-height: 38px; white-space: nowrap; }

/* ============ 自定义滚动条 ============ */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(var(--app-primary-rgb), 0.35); border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(var(--app-primary-rgb), 0.55); background-clip: padding-box; }

/* ============ 弹幕动画 ============ */
@keyframes danmakuScroll2 { from { transform: translateX(0); } to { transform: translateX(calc(-100vw - 100%)); } }
:is(html, body)[data-color-scheme="dark"] #bg-danmaku-layer span { opacity: 0.08 !important; }

/* ============ 响应式 ============ */
@media (max-width: 1200px) { .theme-options { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 980px) { .theme-options { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 768px) {
    .env-section-header { align-items: stretch !important; }
    .env-section-header > div:first-child { min-width: 0; width: 100%; }
    .env-toolbar-actions { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
    .env-toolbar-actions .btn { flex: none; min-height: 34px; padding: 6px 10px; width: 100%; }
    .theme-settings { align-items: stretch; flex-direction: column; }
    .theme-options { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 480px) { .theme-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;
