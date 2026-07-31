// language=CSS
export const themesCssContent = /* css */ `
/* 用户界面主题变量与覆盖层 */
body {
    --theme-page-bg: #dfe9f1;
    --theme-container-bg: #ffffff;
    --theme-content-bg: #ffffff;
    --theme-panel-bg: #f5f8fa;
    --theme-panel-strong: #edf2f5;
    --theme-header: #145b6f;
    --theme-header-accent: #159b8f;
    --theme-accent: #1769aa;
    --theme-accent-hover: #12578e;
    --theme-accent-soft: #e5f1f8;
    --theme-text: #24323b;
    --theme-muted: #66747d;
    --theme-border: #d5dfe5;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #18232b;
    --theme-code-text: #d9f0f0;
    --theme-link: #1769aa;
    background: var(--theme-page-bg);
    color: var(--theme-text);
    transition: background-color 0.25s ease, color 0.25s ease;
}

body[data-theme="ocean"] {
    --theme-page-bg: #dfe9f1;
    --theme-container-bg: #ffffff;
    --theme-content-bg: #ffffff;
    --theme-panel-bg: #f5f8fa;
    --theme-panel-strong: #edf2f5;
    --theme-header: #145b6f;
    --theme-header-accent: #159b8f;
    --theme-accent: #1769aa;
    --theme-accent-hover: #12578e;
    --theme-accent-soft: #e5f1f8;
    --theme-text: #24323b;
    --theme-muted: #66747d;
    --theme-border: #d5dfe5;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #18232b;
    --theme-code-text: #d9f0f0;
    --theme-link: #1769aa;
    color-scheme: light;
}

body[data-theme="forest"] {
    --theme-page-bg: #e5eee8;
    --theme-container-bg: #fbfdfb;
    --theme-content-bg: #fbfdfb;
    --theme-panel-bg: #f0f6f1;
    --theme-panel-strong: #e5efe7;
    --theme-header: #245c45;
    --theme-header-accent: #b36a3c;
    --theme-accent: #2f7d5b;
    --theme-accent-hover: #256347;
    --theme-accent-soft: #e3f1e8;
    --theme-text: #26372e;
    --theme-muted: #69786e;
    --theme-border: #d0ddd3;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #1e2923;
    --theme-code-text: #d9efdf;
    --theme-link: #2f6f91;
    color-scheme: light;
}

body[data-theme="graphite"] {
    --theme-page-bg: #14171b;
    --theme-container-bg: #20242a;
    --theme-content-bg: #20242a;
    --theme-panel-bg: #292e35;
    --theme-panel-strong: #323841;
    --theme-header: #0e1115;
    --theme-header-accent: #c08a4b;
    --theme-accent: #55b8c9;
    --theme-accent-hover: #3e9eaf;
    --theme-accent-soft: #243e45;
    --theme-text: #edf1f3;
    --theme-muted: #aab4bb;
    --theme-border: #444c55;
    --theme-input-bg: #1b1f24;
    --theme-code-bg: #101317;
    --theme-code-text: #d8f2f1;
    --theme-link: #75c7d4;
    color-scheme: dark;
}

body[data-theme="berry"] {
    --theme-page-bg: #f1e5eb;
    --theme-container-bg: #fffdfd;
    --theme-content-bg: #fffdfd;
    --theme-panel-bg: #faf0f4;
    --theme-panel-strong: #f4e4eb;
    --theme-header: #702846;
    --theme-header-accent: #bd5a78;
    --theme-accent: #a83c68;
    --theme-accent-hover: #8c3157;
    --theme-accent-soft: #f7e5ed;
    --theme-text: #3b2931;
    --theme-muted: #7d6870;
    --theme-border: #e5cfd9;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #292027;
    --theme-code-text: #f8dce8;
    --theme-link: #315b8a;
    color-scheme: light;
}

body[data-theme="monochrome"] {
    --theme-page-bg: #eceff1;
    --theme-container-bg: #ffffff;
    --theme-content-bg: #ffffff;
    --theme-panel-bg: #f5f5f5;
    --theme-panel-strong: #e8e8e8;
    --theme-header: #111111;
    --theme-header-accent: #767676;
    --theme-accent: #242424;
    --theme-accent-hover: #000000;
    --theme-accent-soft: #e2e2e2;
    --theme-text: #171717;
    --theme-muted: #686868;
    --theme-border: #cecece;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #111111;
    --theme-code-text: #f5f5f5;
    --theme-link: #242424;
    color-scheme: light;
}

body[data-theme="sunset"] {
    --theme-page-bg: #ebeef2;
    --theme-container-bg: #fffdfd;
    --theme-content-bg: #fffdfd;
    --theme-panel-bg: #f8f1f1;
    --theme-panel-strong: #f2e5e3;
    --theme-header: #4d344b;
    --theme-header-accent: #f0795b;
    --theme-accent: #b54132;
    --theme-accent-hover: #913326;
    --theme-accent-soft: #f7e1dc;
    --theme-text: #352d35;
    --theme-muted: #776b73;
    --theme-border: #dfd1d3;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #2c252c;
    --theme-code-text: #f8e8e3;
    --theme-link: #28627f;
    color-scheme: light;
}

body[data-theme="aurora"] {
    --theme-page-bg: #dfe8e6;
    --theme-container-bg: #fbfdfd;
    --theme-content-bg: #fbfdfd;
    --theme-panel-bg: #eef5f3;
    --theme-panel-strong: #e2eeeb;
    --theme-header: #164a4a;
    --theme-header-accent: #d49a3a;
    --theme-accent: #08736d;
    --theme-accent-hover: #075b57;
    --theme-accent-soft: #dcefeb;
    --theme-text: #263735;
    --theme-muted: #687a77;
    --theme-border: #ccdcda;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #172a29;
    --theme-code-text: #d9f2eb;
    --theme-link: #8a5a16;
    color-scheme: light;
}

body[data-theme="lavender"] {
    --theme-page-bg: linear-gradient(135deg, #a0b9e8 0%, #e39db4 100%);
    --theme-container-bg: #ffffff;
    --theme-content-bg: #ffffff;
    --theme-panel-bg: #f8f9fa;
    --theme-panel-strong: #f1f3f5;
    --theme-header: #1a2980;
    --theme-header-accent: #26d0ce;
    --theme-accent: #667eea;
    --theme-accent-hover: #5568d3;
    --theme-accent-soft: #e8eaf6;
    --theme-text: #333333;
    --theme-muted: #666666;
    --theme-border: #dddddd;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #1e1e1e;
    --theme-code-text: #d4d4d4;
    --theme-link: #ffc107;
    color-scheme: light;
}

body[data-theme="mist"] {
    --theme-page-bg: #e7ebef;
    --theme-container-bg: #fcfdfe;
    --theme-content-bg: #fcfdfe;
    --theme-panel-bg: #f1f4f6;
    --theme-panel-strong: #e4e9ed;
    --theme-header: #40566b;
    --theme-header-accent: #c16b58;
    --theme-accent: #476f8c;
    --theme-accent-hover: #385a72;
    --theme-accent-soft: #e1ebf1;
    --theme-text: #2b343c;
    --theme-muted: #68747e;
    --theme-border: #d2dbe1;
    --theme-input-bg: #ffffff;
    --theme-code-bg: #222b32;
    --theme-code-text: #e2edf2;
    --theme-link: #a1473a;
    color-scheme: light;
}

body[data-theme="terminal"] {
    --theme-page-bg: #0c100e;
    --theme-container-bg: #151a17;
    --theme-content-bg: #151a17;
    --theme-panel-bg: #1d231f;
    --theme-panel-strong: #262e29;
    --theme-header: #050706;
    --theme-header-accent: #d3a84a;
    --theme-accent: #4faf75;
    --theme-accent-hover: #3e915f;
    --theme-accent-soft: #1d3a29;
    --theme-text: #e4ebe6;
    --theme-muted: #a7b4aa;
    --theme-border: #414b44;
    --theme-input-bg: #101411;
    --theme-code-bg: #060806;
    --theme-code-text: #8ee4aa;
    --theme-link: #e0b85c;
    color-scheme: dark;
}

body[data-theme] .container {
    background: var(--theme-container-bg);
    color: var(--theme-text);
}

body[data-theme] .header {
    background: var(--theme-header);
    border-bottom: 4px solid var(--theme-header-accent);
}

body[data-theme="lavender"] .header {
    background: linear-gradient(135deg, #1a2980 0%, #26d0ce 100%);
}

body[data-theme] .content {
    background: var(--theme-content-bg);
}

body[data-theme] .footer {
    color: var(--theme-muted);
}

body[data-theme] .footer-text,
body[data-theme] .footer-link {
    color: var(--theme-link);
}

body[data-theme] .nav-btn.active {
    color: var(--theme-header);
}

body[data-theme] .category-btn,
body[data-theme] .tag-option,
body[data-theme] .available-tag,
body[data-theme] .filter-btn {
    background: var(--theme-panel-strong);
    color: var(--theme-text);
    border-color: var(--theme-border);
}

body[data-theme] .category-btn.active,
body[data-theme] .tag-option.selected,
body[data-theme] .selected-tag,
body[data-theme] .btn-primary,
body[data-theme] .number-btn:hover,
body[data-theme] .jump-episode-btn,
body[data-theme] .offset-source-tag.selected {
    background: var(--theme-accent);
    border-color: var(--theme-accent);
    color: #ffffff;
}

body[data-theme] .btn-primary:hover,
body[data-theme] .tag-option.selected:hover,
body[data-theme] .selected-tag:hover,
body[data-theme] .number-btn:active {
    background: var(--theme-accent-hover);
}

body[data-theme] .env-item,
body[data-theme] .preview-area,
body[data-theme] .preview-item,
body[data-theme] .api-params,
body[data-theme] .api-selector,
body[data-theme] .number-picker,
body[data-theme] .selected-tags,
body[data-theme] .multi-select-container,
body[data-theme] .recent-data-panel,
body[data-theme] .anime-cache-card,
body[data-theme] .anime-cache-child-item,
body[data-theme] .danmu-list-area,
body[data-theme] .jump-to-episode,
body[data-theme] .request-records-container {
    background: var(--theme-panel-bg);
    color: var(--theme-text);
    border-color: var(--theme-border);
}

body[data-theme] .preview-item,
body[data-theme] .env-item {
    border-left-color: var(--theme-accent);
}

body[data-theme] .env-info strong,
body[data-theme] .preview-key,
body[data-theme] .number-display,
body[data-theme] .env-section h2,
body[data-theme] .section h2 {
    color: var(--theme-accent);
}

body[data-theme] .env-info > div.text-dark-gray,
body[data-theme] .preview-value,
body[data-theme] .env-item .env-info > div.text-dark-gray {
    background: var(--theme-panel-strong);
    color: var(--theme-text) !important;
}

body[data-theme] .form-group label,
body[data-theme] .switch-label,
body[data-theme] .form-help,
body[data-theme] .text-gray,
body[data-theme] .text-dark-gray,
body[data-theme] .anime-cache-meta,
body[data-theme] .mapping-text {
    color: var(--theme-muted) !important;
}

body[data-theme] .form-group input,
body[data-theme] .form-group select,
body[data-theme] .form-group textarea,
body[data-theme] .offset-input,
body[data-theme] .map-input-left,
body[data-theme] .map-input-right,
body[data-theme] .jump-episode-input,
body[data-theme] .batch-color-input {
    background: var(--theme-input-bg);
    color: var(--theme-text);
    border-color: var(--theme-border);
}

body[data-theme] .number-btn {
    background: var(--theme-input-bg);
    color: var(--theme-accent);
    border-color: var(--theme-accent);
}

body[data-theme] .number-range input[type="range"] {
    background: var(--theme-border);
}

body[data-theme] .number-range input[type="range"]::-webkit-slider-thumb,
body[data-theme] .number-range input[type="range"]::-moz-range-thumb,
body[data-theme] input:checked + .slider {
    background: var(--theme-accent);
}

body[data-theme] .modal-content,
body[data-theme] .batch-color-dialog,
body[data-theme] .bili-cookie-dialog {
    background: var(--theme-container-bg);
    color: var(--theme-text);
}

body[data-theme] .theme-settings {
    background: var(--theme-panel-bg);
    border-color: var(--theme-border);
}

body[data-theme] .theme-option {
    background: var(--theme-input-bg);
    color: var(--theme-text);
    border-color: var(--theme-border);
}

body[data-theme] .theme-option[aria-checked="true"] {
    background: var(--theme-accent-soft);
    border-color: var(--theme-accent);
    box-shadow: 0 0 0 2px var(--theme-accent-soft);
}

body[data-theme] .theme-current-label {
    color: var(--theme-accent);
}

body[data-theme] .log-container,
body[data-theme] .api-response,
body[data-theme] .json-response,
body[data-theme] .error-response {
    background: var(--theme-code-bg);
    color: var(--theme-code-text);
}

body[data-theme="graphite"] .logo,
body[data-theme="terminal"] .logo {
    background: #f4f6f7;
}

body[data-theme="graphite"] .update-badge,
body[data-theme="terminal"] .update-badge {
    background: #c08a4b;
    color: #17191d;
}

body[data-theme="graphite"] .modal-body,
body[data-theme="graphite"] .modal-footer,
body[data-theme="terminal"] .modal-body,
body[data-theme="terminal"] .modal-footer {
    border-color: var(--theme-border);
}

body[data-theme] .theme-option:focus-visible,
body[data-theme] .btn:focus-visible,
body[data-theme] .category-btn:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
}

/* Theme picker */
.theme-settings {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 14px 16px;
    margin-bottom: 18px;
    border: 1px solid #d5dfe5;
    border-radius: 8px;
}

.theme-settings[hidden] {
    display: none;
}

.theme-settings-copy {
    min-width: 150px;
}

.theme-settings-copy h3 {
    margin-bottom: 4px;
    font-size: 15px;
}

.theme-settings-copy p {
    margin: 0;
    color: #66747d;
    font-size: 12px;
}

.theme-current-label {
    color: #1769aa;
    font-size: 12px;
    font-weight: 600;
}

.theme-options {
    display: grid;
    grid-template-columns: repeat(5, minmax(100px, 1fr));
    gap: 8px;
    flex: 1;
}

.theme-option {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 7px 9px;
    border: 1px solid #d5dfe5;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.2s, background 0.2s, box-shadow 0.2s;
}

.theme-option:hover {
    border-color: var(--theme-accent);
}

.theme-option:disabled {
    cursor: wait;
    opacity: 0.65;
}

.theme-swatches {
    display: flex;
    flex-shrink: 0;
    width: 25px;
    height: 25px;
    overflow: hidden;
    border-radius: 5px;
    border: 1px solid rgba(0, 0, 0, 0.12);
}

.theme-swatches i {
    flex: 1;
}

.theme-option-label {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
}

.config-transfer-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
}

.env-toolbar-actions .btn {
    align-items: center;
    display: inline-flex;
    justify-content: center;
    gap: 7px;
    line-height: 1.2;
    min-height: 38px;
    white-space: nowrap;
}

.config-transfer-icon {
    font-size: 20px;
    font-weight: 700;
    line-height: 1;
}

@media (max-width: 980px) {
    .theme-options {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
}

@media (max-width: 768px) {
    .env-section-header {
        align-items: stretch !important;
    }

    .env-section-header > div:first-child {
        min-width: 0;
        width: 100%;
    }

    .env-toolbar-actions {
        display: grid !important;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        width: 100%;
    }

    .env-toolbar-actions .btn {
        flex: none;
        min-height: 44px;
        padding: 10px 8px;
        width: 100%;
    }

    .theme-settings {
        align-items: stretch;
        flex-direction: column;
    }

    .theme-options {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}
`;
