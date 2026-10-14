// language=CSS
export const baseCssContent = /* css */ `
/* 基础布局样式 — 参照 Bangumi-syncer 柔和圆角设计风格 */

/* ============ 全局重置 ============ */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    -webkit-tap-highlight-color: transparent; /* 消除移动端点击时的蓝色框 */
}

:root {
    color-scheme: light dark;
    /* 头部尺寸基准：头部内边距、logo 尺寸与主标题字号由变量统一给出，明暗切换开关据此对齐主标题行 */
    --header-pad-y: 18px;
    --header-pad-x: 28px;
    --logo-size: 44px;
    --title-size: 24px;
    --toggle-track-w: calc(var(--title-size) * 1.75);
    --toggle-track-h: var(--title-size);
    --toggle-inset: 2px;
}

html {
    overflow-x: hidden;
    overflow-y: scroll;
    scrollbar-gutter: stable;
    background: var(--theme-page-bg);
}

html.modal-open {
    overflow-y: hidden;
}

/* 首帧引导与明暗切换期间关闭元素自身的颜色过渡：前者避免已存主题与默认主题之间出现渐变，后者避免切换过程出现中间态 */
html.theme-booting body,
html.theme-booting .header,
html.theme-switching body,
html.theme-switching .header {
    transition: none;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    min-height: 100vh;
    min-height: 100dvh;
    padding: 10px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    position: relative;
}

/* 氛围背景光晕 — 参照 Bangumi-syncer 的 ambient background */
body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
        radial-gradient(ellipse 78% 58% at 0% 0%, rgba(var(--app-primary-rgb), 0.10), transparent 68%),
        radial-gradient(ellipse 62% 48% at 100% 8%, rgba(var(--app-primary-rgb), 0.06), transparent 66%),
        radial-gradient(ellipse 70% 52% at 50% 100%, rgba(var(--app-primary-rgb), 0.04), transparent 70%);
}

/* ============ 主容器 ============ */
.container {
    max-width: 1360px;
    margin: 0 auto;
    background: var(--theme-container-bg);
    border-radius: var(--app-radius-shell);
    box-shadow: var(--app-shadow-lg);
    overflow: hidden;
    position: relative;
    transition: box-shadow 0.3s ease;
}

/* ============ 悬浮式明暗切换开关（左右结构）============ */
/* 与主标题行垂直居中，边距与 logo 对称，尺寸由主标题字号换算 */
.theme-float-toggle {
    position: absolute;
    top: calc(var(--header-pad-y) + (var(--logo-size) - var(--toggle-track-h)) / 2);
    right: var(--header-pad-x);
    z-index: 12;
    width: var(--toggle-track-w);
    height: var(--toggle-track-h);
    padding: var(--toggle-inset);
    border-radius: 999px;
    border: 1px solid var(--theme-border);
    background: rgba(var(--app-primary-rgb), 0.10);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.10);
    cursor: pointer;
    transition: background-color 0.22s var(--app-ease-smooth), border-color 0.22s var(--app-ease-smooth),
        box-shadow 0.22s var(--app-ease-smooth), transform 0.22s var(--app-ease-smooth);
}

/* 触摸命中区扩大，不改变开关的视觉尺寸 */
.theme-float-toggle::before {
    content: '';
    position: absolute;
    inset: -6px -12px;
}

/* 滑块：浅色停在左端（太阳），暗色滑到右端（月亮） */
.theme-toggle-thumb {
    position: absolute;
    left: var(--toggle-inset);
    top: var(--toggle-inset);
    /* 6px = 两侧内边距与边框之和 */
    width: calc(var(--toggle-track-h) - 6px);
    height: calc(var(--toggle-track-h) - 6px);
    border-radius: 50%;
    background: var(--theme-header);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    transition: transform 0.30s var(--app-ease-smooth), background-color 0.30s var(--app-ease-smooth);
}

:is(html, body)[data-color-scheme="dark"] .theme-toggle-thumb {
    transform: translateX(calc(var(--toggle-track-w) - var(--toggle-track-h)));
}

/* 两端图标：未选中的一端淡化，选中的一端用强调色高亮 */
.theme-toggle-icon {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: calc(var(--toggle-track-h) - 6px);
    height: calc(var(--toggle-track-h) - 6px);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(var(--title-size) * 0.6);
    line-height: 1;
    color: var(--theme-muted);
    opacity: 0.45;
    z-index: 1;
    transition: opacity 0.30s var(--app-ease-smooth), color 0.30s var(--app-ease-smooth);
}

.theme-toggle-icon-light { left: var(--toggle-inset); }
.theme-toggle-icon-dark { right: var(--toggle-inset); }

:is(html, body)[data-color-scheme="light"] .theme-toggle-icon-light,
:is(html, body)[data-color-scheme="dark"] .theme-toggle-icon-dark {
    color: var(--theme-accent);
    opacity: 1;
}

.theme-float-toggle:hover {
    transform: scale(1.15);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16);
}

/* 明暗切换过渡：新主题以圆形裁剪自开关位置展开，逐层覆盖旧主题（裁剪动画由脚本按开关位置驱动） */
::view-transition-old(root),
::view-transition-new(root) {
    animation: none;
    mix-blend-mode: normal;
}

/* ============ Header ============ */
.header {
    background: var(--theme-header);
    color: var(--theme-text);
    padding: var(--header-pad-y) var(--header-pad-x);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    border-bottom: 3px solid var(--theme-header-accent);
    transition: border-color 0.3s ease;
    position: relative;
    overflow: hidden;
}

/* 顶部微光持续扫过动效 */
.header::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 50%;
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--theme-accent-soft), transparent);
    animation: headerShimmer 4s linear infinite;
    pointer-events: none;
    will-change: transform;
}

@keyframes headerShimmer {
    from { transform: translateX(-120%); }
    to { transform: translateX(240%); }
}

/* header 内浮动点缀文字 */
.header-danmaku-item {
    position: absolute;
    white-space: nowrap;
    pointer-events: none;
    font-weight: 500;
    animation: hdFloat linear both;
    will-change: transform, opacity;
}

@keyframes hdFloat {
    from { transform: translateX(100vw); opacity: 0; }
    5% { opacity: 0.10; }
    95% { opacity: 0.10; }
    to { transform: translateX(-100%); opacity: 0; }
}

.header-left {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    flex-wrap: wrap;
}

.logo-title-container {
    display: flex;
    align-items: center;
    gap: 14px;
}

.logo {
    width: var(--logo-size);
    height: var(--logo-size);
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    box-shadow: 0 2px 10px rgba(var(--app-primary-rgb), 0.28);
    overflow: hidden;
}

.logo img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.header h1 {
    font-size: var(--title-size);
    margin: 0;
    font-weight: 700;
    color: var(--theme-text);
}

.version-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
}

.version-badge {
    background: var(--theme-accent);
    color: #ffffff;
    padding: 3px 12px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 11px;
    position: relative;
    z-index: 1;
}

.update-badge {
    background: var(--theme-accent-soft);
    color: var(--theme-accent);
    padding: 3px 12px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 11px;
    cursor: pointer;
    text-decoration: none;
    animation: badge-breathe 2.4s ease-in-out infinite;
    transition: box-shadow 0.2s ease;
    position: relative;
    z-index: 1;
    will-change: transform;
}

.update-badge:hover {
    box-shadow: var(--app-shadow-sm);
}

@keyframes badge-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
}

.api-endpoint-badge {
    background: rgba(107, 138, 255, 0.10);
    color: #6B8AFF;
    padding: 3px 12px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 11px;
    cursor: pointer;
    position: relative;
    z-index: 1;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
}

/* ============ 内容区 ============ */
.content {
    padding: 24px 28px;
}

.section {
    display: none;
}

.section.active {
    display: block;
    animation: sectionEnter 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

/* 所有 section 直接子元素错峰入场 */
.section.active > * {
    animation: app-fade-up 0.38s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.section.active > *:nth-child(1) { animation-delay: 0.03s; }
.section.active > *:nth-child(2) { animation-delay: 0.08s; }
.section.active > *:nth-child(3) { animation-delay: 0.13s; }
.section.active > *:nth-child(4) { animation-delay: 0.18s; }
.section.active > *:nth-child(5) { animation-delay: 0.23s; }
.section.active > *:nth-child(6) { animation-delay: 0.28s; }
.section.active > *:nth-child(7) { animation-delay: 0.33s; }
.section.active > *:nth-child(8) { animation-delay: 0.38s; }
.section.active > *:nth-child(n+9) { animation-delay: 0.42s; }

@keyframes sectionEnter {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

@keyframes app-fade-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
}

/* ============ Footer ============ */
.footer {
    width: 100%;
    max-width: 1360px;
    margin: 10px auto 0;
    padding: 18px 28px;
    background: var(--theme-container-bg);
    border-radius: var(--app-radius-shell);
    box-shadow: var(--app-shadow-md);
    text-align: center;
    font-size: 13px;
    box-sizing: border-box;
}

.footer-text {
    color: var(--theme-muted);
    margin: 8px 0;
}

/* 底部链接独立悬浮栏 */
.footer-bar {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 6px 16px;
    max-width: 1360px;
    margin: 6px auto 0;
    padding: 8px 20px;
    font-size: 12px;
    opacity: 0.75;
}

.footer-bar-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    text-decoration: none;
    color: var(--theme-muted);
    transition: color 0.2s ease;
}

.footer-bar-link:hover {
    color: var(--theme-accent);
}

/* 图标取正文色，不随链接文字弱化 */
.footer-bar-link .ui-icon {
    color: var(--theme-text);
}

/* ============ 响应式 ============ */
@media (max-width: 1400px) {
    .container {
        max-width: 100%;
    }
}

@media (prefers-reduced-motion: reduce) {
    .section.active,
    .section.active > *,
    .preview-summary,
    .nav-btn,
    .btn,
    .theme-float-toggle,
    .theme-toggle-thumb,
    .theme-toggle-icon,
    .header::after {
        animation: none !important;
        transition: none !important;
    }
    body::before {
        display: none;
    }
    #bg-danmaku-layer span {
        display: none;
    }
}

`;

