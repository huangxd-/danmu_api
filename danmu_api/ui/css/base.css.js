// language=CSS
export const baseCssContent = /* css */ `
/* 基础布局样式 — 参照 Bangumi-syncer 设计系统 */

/* ============ 全局重置 ============ */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

:root {
    color-scheme: light dark;
}

html {
    overflow-x: hidden;
    overflow-y: scroll;
    scrollbar-gutter: stable;
    background: var(--theme-page-bg);
    color-scheme: light !important;
}

html.modal-open {
    overflow-y: hidden;
    background: rgba(0, 0, 0, 0.59);
}

html:has(body[data-color-scheme="dark"]).modal-open {
    background: rgba(0, 0, 0, 0.95);
}

body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
    background: var(--theme-page-bg);
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

/* ============ 右上角折页式明暗切换 ============ */
.corner-fold {
    position: absolute;
    top: 0;
    right: 0;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0 52px 52px 0;
    border-color: transparent var(--theme-accent-soft) transparent transparent;
    z-index: 5;
    pointer-events: none;
}

.theme-corner-toggle {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 10;
    width: 30px;
    height: 30px;
    border-radius: 0 0 0 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    line-height: 1;
    color: var(--theme-accent);
    transition: all 0.22s var(--app-ease-smooth);
}

.theme-corner-toggle:hover {
    transform: scale(1.15);
    color: #ffffff;
    text-shadow: 0 0 6px rgba(0,0,0,0.2);
}

/* ============ Header ============ */
.header {
    background: var(--theme-header);
    color: var(--theme-text);
    padding: 18px 28px;
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
    width: 44px;
    height: 44px;
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
    border-radius: 12px;
}

.header h1 {
    font-size: 24px;
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
    background: var(--theme-accent-soft);
    color: var(--theme-accent);
    padding: 3px 12px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 11px;
    position: relative;
    z-index: 1;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
}

.update-badge {
    background: var(--theme-accent);
    color: #ffffff;
    padding: 3px 12px;
    border-radius: 999px;
    font-weight: 600;
    font-size: 11px;
    animation: pulse 2s infinite;
    cursor: pointer;
    text-decoration: none;
    transition: transform 0.2s ease, box-shadow 0.2s ease;
    position: relative;
    z-index: 1;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
}

.update-badge:hover {
    transform: scale(1.04);
    box-shadow: var(--app-shadow-sm);
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

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
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
    text-decoration: none;
    color: var(--theme-muted);
    transition: color 0.2s ease;
}

.footer-bar-link:hover {
    color: var(--theme-accent);
}

.github-link {
    display: inline-flex;
    align-items: center;
}

.github-icon {
    width: 14px;
    vertical-align: middle;
    margin-right: 5px;
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
    .theme-corner-toggle,
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

@media (max-width: 768px) {
    body {
        padding: 0;
    }

    .container {
        border-radius: 0;
        box-shadow: none;
    }

    .header {
        padding: 12px 14px;
    }

    .content {
        padding: 16px;
    }

    .logo {
        width: 36px;
        height: 36px;
        font-size: 20px;
    }

    .header h1 {
        font-size: 17px;
    }
}
`;