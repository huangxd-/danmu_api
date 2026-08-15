// language=CSS
export const componentsCssContent = /* css */ `
/* 组件样式 — 参照 Bangumi-syncer ACG 设计系统 */

/* ============ 标签导航 ============ */
.nav-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.nav-btn {
    padding: 10px 24px;
    background: rgba(var(--app-primary-rgb), 0.10);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    border: 1px solid var(--theme-border);
    color: var(--theme-text);
    border-radius: var(--app-radius-btn);
    cursor: pointer;
    transition: all 0.22s var(--app-ease-smooth);
    position: relative;
    z-index: 1;
    font-size: 14px;
    font-weight: 500;
}

.nav-btn:hover {
    background: var(--theme-panel-bg);
    border-color: var(--theme-accent);
    transform: translateY(-1px);
}

.nav-btn:active {
    transform: translateY(0) scale(0.98);
}

.nav-btn.active {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    border-color: var(--theme-accent);
    color: #ffffff;
    font-weight: 600;
    box-shadow: 0 2px 8px rgba(var(--app-primary-rgb), 0.22);
}

/* ============ 环境变量配置 ============ */
.env-categories {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
    flex-wrap: wrap;
}

.category-btn {
    padding: 8px 18px;
    background: var(--theme-panel-strong);
    border: 1px solid transparent;
    border-radius: var(--app-radius-btn);
    cursor: pointer;
    transition: all 0.22s var(--app-ease-smooth);
    font-size: 14px;
    font-weight: 500;
}

.category-btn:hover {
    border-color: var(--theme-accent);
}

.category-btn.active {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    border-color: var(--theme-accent);
}

.env-list {
    margin-bottom: 18px;
}

.env-item {
    background: var(--theme-panel-bg);
    padding: 14px 16px;
    margin-bottom: 8px;
    border-radius: var(--app-radius-card-sm);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    border: 1px solid var(--theme-border);
}

.env-item .env-info {
    flex: 1;
    min-width: 200px;
    word-break: break-word;
    overflow-wrap: break-word;
}

.env-item .env-info strong {
    color: var(--theme-accent);
    display: block;
    margin-bottom: 4px;
    word-break: break-all;
    font-size: 14px;
}

.env-item .env-info > div.text-dark-gray {
    word-break: break-all;
    white-space: normal;
    background: var(--theme-panel-strong);
    padding: 7px 10px;
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    margin-bottom: 4px;
}

.env-item .env-info span {
    word-break: break-all;
    white-space: normal;
}

.env-item .env-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex-shrink: 0;
}

.env-info {
    flex: 1;
    min-width: 200px;
}

.env-info strong {
    color: var(--theme-accent);
    display: block;
    margin-bottom: 4px;
}

.env-actions {
    display: flex;
    gap: 6px;
}

/* ============ 按钮系统 ============ */
.btn {
    padding: 8px 18px;
    border: none;
    border-radius: var(--app-radius-btn);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.22s var(--app-ease-smooth);
    display: inline-block;
    text-align: center;
    line-height: 1.4;
}

.btn:hover {
    transform: translateY(-1px);
}

.btn:active {
    transform: scale(0.97);
}

.favorite-action-btn {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.favorite-action-btn:disabled,
.favorite-action-btn:disabled:hover,
body[data-theme] .favorite-action-btn:disabled,
body[data-theme] .favorite-action-btn:disabled:hover {
    background: #d1d5db !important;
    color: #6b7280 !important;
    border-color: #d1d5db !important;
    cursor: not-allowed;
    opacity: 1;
    box-shadow: none;
    transform: none;
}

.favorite-action-btn:disabled::before {
    display: none;
}

.favorite-cover {
    width: 78px;
    height: auto;
    flex: 0 0 auto;
    align-self: stretch;
    border-radius: 6px;
    object-fit: cover;
    background: #e5e7eb;
}

.favorite-info-row {
    display: flex;
    align-items: stretch;
    gap: 12px;
    min-width: 0;
}

.favorite-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.favorite-meta {
    color: #6b7280;
    font-size: 12px;
    line-height: 1.7;
}

.favorite-schedule-btn {
    min-width: 92px;
}

.favorite-schedule-btn:disabled,
.favorite-schedule-btn:disabled:hover,
body[data-theme] .favorite-schedule-btn:disabled,
body[data-theme] .favorite-schedule-btn:disabled:hover {
    background: #d1d5db !important;
    color: #6b7280 !important;
    border-color: #d1d5db !important;
    cursor: not-allowed;
    opacity: 1;
    box-shadow: none;
    transform: none;
}

.favorite-schedule-hint {
    color: #6b7280;
    font-size: 13px;
    margin: 0 0 16px;
}

.favorite-schedule-modal-content {
    max-width: 460px;
}

.favorite-list {
    margin-top: 8px;
}

.btn-primary {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(var(--app-primary-rgb), 0.22);
}

.btn-primary:hover {
    filter: brightness(1.04);
    box-shadow: 0 4px 14px rgba(var(--app-primary-rgb), 0.28);
    transform: translateY(-1px);
}

.btn-primary:active {
    transform: translateY(0) scale(0.97);
    filter: brightness(0.97);
}

.btn-success {
    background: linear-gradient(135deg, #52a67d, #459670);
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(82, 166, 125, 0.22);
}

.btn-success:hover {
    filter: brightness(1.04);
    box-shadow: 0 4px 14px rgba(82, 166, 125, 0.28);
    transform: translateY(-1px);
}

.btn-danger {
    background: linear-gradient(135deg, #e0707a, #d4626c);
    color: #ffffff;
    box-shadow: 0 2px 8px rgba(224, 112, 122, 0.22);
}

.btn-danger:hover {
    filter: brightness(1.04);
    box-shadow: 0 4px 14px rgba(224, 112, 122, 0.28);
    transform: translateY(-1px);
}

.btn-sm {
    padding: 5px 12px;
    font-size: 12px;
}

.btn-secondary {
    background: var(--theme-panel-strong);
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
}

.btn-secondary:hover {
    border-color: var(--theme-accent);
    color: var(--theme-accent);
}

/* ============ 配置预览 ============ */
.preview-description {
    color: var(--theme-muted);
    margin-bottom: 16px;
    font-size: 13px;
}

.preview-toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0 12px;
    background: var(--theme-content-bg);
    border-bottom: 1px solid var(--theme-border);
}

.preview-categories {
    display: flex;
    flex: 1;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
}

.preview-category-btn {
    min-height: 38px;
    padding: 8px 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--theme-panel-strong);
    color: var(--theme-text);
    border: 1px solid transparent;
    border-radius: var(--app-radius-btn);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    transition: all 0.22s var(--app-ease-smooth);
}

.preview-category-btn:hover {
    border-color: var(--theme-accent);
}

.preview-category-btn.active {
    background: var(--theme-accent-soft);
    border-color: var(--theme-accent);
    color: var(--theme-accent);
    font-weight: 600;
    box-shadow: 0 0 0 2px var(--theme-accent-soft);
    transform: translateY(-1px);
}

.preview-category-btn.active .preview-category-count {
    background: var(--theme-accent-soft);
    color: var(--theme-accent);
}

.preview-category-count {
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    display: inline-grid;
    place-items: center;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.08);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1;
}

.preview-back-btn {
    gap: 4px;
    color: var(--theme-accent);
    border-color: var(--theme-accent);
    background: var(--theme-accent-soft);
}

.preview-back-btn:hover {
    background: var(--theme-accent);
    color: #ffffff;
}

.preview-search {
    position: relative;
    flex: 0 1 260px;
    min-width: 200px;
}

.preview-search input {
    width: 100%;
    height: 38px;
    padding: 8px 38px 8px 16px;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-input);
    background: var(--theme-input-bg);
    color: var(--theme-text);
    font-size: 13px;
    transition: border-color 0.22s var(--app-ease-smooth), box-shadow 0.22s var(--app-ease-smooth);
}

.preview-search input:focus {
    outline: none;
    border-color: var(--theme-accent);
    box-shadow: 0 0 0 3px var(--theme-accent-soft);
}

.preview-search-clear {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 28px;
    height: 28px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--theme-muted);
    cursor: pointer;
    font-size: 18px;
    transition: all 0.2s;
}

.preview-search-clear:hover {
    background: var(--theme-panel-strong);
    color: var(--theme-text);
}

.preview-search-clear[hidden] {
    display: none;
}

.preview-status {
    min-height: 20px;
    margin: 12px 0 4px;
    color: var(--theme-muted);
    font-size: 12px;
}

.preview-area {
    margin-top: 4px;
}

.preview-overview {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
}

.preview-summary {
    position: relative;
    min-height: 100px;
    padding: 14px 100px 14px 16px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    text-align: left;
    background: var(--theme-panel-bg);
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    cursor: pointer;
    transition: all 0.22s var(--app-ease-smooth);
    animation: app-fade-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.preview-summary:nth-child(1) { animation-delay: 0.02s; }
.preview-summary:nth-child(2) { animation-delay: 0.08s; }
.preview-summary:nth-child(3) { animation-delay: 0.14s; }
.preview-summary:nth-child(4) { animation-delay: 0.20s; }
.preview-summary:nth-child(5) { animation-delay: 0.26s; }
.preview-summary:nth-child(6) { animation-delay: 0.32s; }

.preview-summary:hover {
    border-color: var(--theme-accent);
    box-shadow: var(--app-shadow-sm);
    transform: translateY(-1px);
}

.preview-summary-title {
    font-weight: 700;
    font-size: 14px;
}

.preview-summary-count {
    width: 44px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--theme-accent);
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
}

.preview-summary-description {
    color: var(--theme-muted);
    font-size: 12px;
    line-height: 1.5;
}

.preview-summary-side {
    position: absolute;
    inset: 0 10px 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
}

.preview-summary-arrow {
    width: 24px;
    height: 36px;
    display: grid;
    place-items: center;
    color: var(--theme-muted);
    font-size: 24px;
    line-height: 1;
}

.preview-group + .preview-group {
    margin-top: 22px;
}

.preview-group-heading {
    min-height: 32px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 0 2px 8px;
}

.preview-group-heading h3 {
    margin: 0;
    color: var(--theme-text);
    font-size: 15px;
    font-weight: 700;
}

.preview-group-heading span {
    color: var(--theme-muted);
    font-size: 12px;
    white-space: nowrap;
}

.preview-list {
    border-top: 1px solid var(--theme-border);
    border-radius: 8px;
    overflow: hidden;
}

.preview-item {
    padding: 12px 10px;
    background: var(--theme-panel-bg);
    border-bottom: 1px solid var(--theme-border);
    word-break: break-word;
    overflow-wrap: break-word;
}

.preview-item-main {
    display: grid;
    grid-template-columns: minmax(160px, 210px) minmax(0, 1fr);
    align-items: start;
    gap: 16px;
}

.preview-key {
    padding-top: 6px;
    color: var(--theme-accent);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
    word-break: break-all;
}

.preview-value-container {
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 6px;
}

.preview-value {
    min-width: 0;
    flex: 1;
    display: block;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--theme-panel-strong);
    color: var(--theme-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
}

.preview-value.is-collapsed {
    max-height: 4.8em;
    overflow: hidden;
}

.preview-value-actions {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
}

.preview-action-btn {
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    background: var(--theme-input-bg);
    color: var(--theme-muted);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.2s;
}

.preview-action-btn:hover {
    border-color: var(--theme-accent);
    color: var(--theme-accent);
}

.preview-action-btn.is-copied {
    border-color: #52a67d;
    color: #52a67d;
}

.preview-copy-btn {
    padding: 0;
    font-size: 16px;
}

.preview-item-description {
    margin: 6px 36px 0 226px;
    color: var(--theme-muted);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-line;
}

.preview-empty {
    min-height: 140px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--theme-muted);
    text-align: center;
}

.preview-empty strong {
    color: var(--theme-text);
}

/* ============ 日志系统 ============ */
.log-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 8px;
}

.log-container {
    background: var(--theme-code-bg);
    color: var(--theme-code-text);
    padding: 14px;
    border-radius: var(--app-radius-card-sm);
    max-height: 500px;
    overflow-y: auto;
    font-family: ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    line-height: 1.6;
}

.log-entry {
    margin-bottom: 6px;
    padding: 4px;
    border-radius: 4px;
    content-visibility: auto;
    contain-intrinsic-size: auto 31px;
}

.log-entry.log-entry-hidden {
    display: none;
}

.log-entry.info { color: #5ec4db; }
.log-entry.warn { color: #f0a060; }
.log-entry.error { color: #e0707a; }
.log-entry.success { color: #52a67d; }

.log-filters-container {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
}

.filter-btn {
    background: transparent;
    color: var(--theme-code-text);
    opacity: 0.6;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.22s var(--app-ease-smooth);
}

.filter-btn:hover {
    opacity: 0.85;
    border-color: rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.05);
}

.filter-btn.active {
    background: rgba(var(--app-primary-rgb), 0.18);
    color: var(--app-primary);
    border-color: rgba(var(--app-primary-rgb), 0.4);
    opacity: 1;
}

.log-tag {
    color: #bfa1ff;
    font-weight: 600;
    margin-right: 4px;
    display: inline-block;
}

.log-entry.error .log-tag {
    color: #f0a060;
}

/* ============ 表单帮助 ============ */
.form-help {
    font-size: 11px;
    color: var(--theme-muted);
    margin-top: 4px;
}

/* ============ API 调试 ============ */
.api-selector {
    margin-bottom: 18px;
}

.api-params {
    background: var(--theme-panel-bg);
    padding: 18px;
    border-radius: var(--app-radius-card-sm);
    margin-bottom: 18px;
    border: 1px solid var(--theme-border);
}

.api-response {
    background: var(--theme-code-bg);
    color: var(--theme-code-text);
    padding: 14px;
    border-radius: var(--app-radius-card-sm);
    max-height: 400px;
    overflow-y: auto;
    font-family: ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    white-space: pre-wrap;
}

.api-response.xml {
    color: #88ccff;
}

.json-response {
    background: var(--theme-code-bg);
    color: var(--theme-code-text);
    padding: 14px;
    border-radius: var(--app-radius-card-sm);
    max-height: 400px;
    overflow-y: auto;
    font-family: ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    white-space: pre-wrap;
}

.json-response .key { color: #9cdcfe; }
.json-response .string { color: #ce9178; }
.json-response .number { color: #b5cea8; }
.json-response .boolean { color: #569cd6; }
.json-response .null { color: #569cd6; }
.json-response .undefined { color: #569cd6; }

.error-response {
    background: var(--theme-code-bg);
    color: var(--theme-code-text);
    padding: 14px;
    border-radius: var(--app-radius-card-sm);
    max-height: 400px;
    overflow-y: auto;
    font-family: ui-monospace, 'Cascadia Code', SFMono-Regular, Consolas, monospace;
    font-size: 13px;
    white-space: pre-wrap;
    border-left: 3px solid #e0707a;
}

/* ============ 模态框 ============ */
html.modal-open {
    overflow: hidden;
    overflow-y: scroll;
}

body.modal-open {
    position: fixed;
    width: 100%;
    overflow: hidden;
}

.modal {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.55);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    z-index: 1000;
    padding: 20px;
    overflow-y: auto;
}

.modal.active {
    display: flex;
    justify-content: center;
    align-items: center;
    animation: modalEnter 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.modal.closing {
    animation: modalExit 0.22s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes modalEnter {
    from { opacity: 0; }
    to { opacity: 1; }
}
@keyframes modalExit {
    from { opacity: 1; }
    to { opacity: 0; }
}

.modal.active .modal-content {
    animation: modalContentEnter 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
.modal.closing .modal-content {
    animation: modalContentExit 0.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

@keyframes modalContentEnter {
    from { opacity: 0; transform: scale(0.94) translateY(10px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes modalContentExit {
    from { opacity: 1; transform: scale(1) translateY(0); }
    to { opacity: 0; transform: scale(0.94) translateY(10px); }
}

.modal-content {
    background: var(--theme-container-bg);
    padding: 28px;
    border-radius: 20px;
    max-width: 560px;
    width: 100%;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    box-shadow: var(--app-shadow-elevated);
    position: relative;
}

.modal-content::-webkit-scrollbar {
    width: 6px;
}

.modal-content::-webkit-scrollbar-track {
    background: transparent;
    margin: 24px 0;
}

.modal-content::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(var(--app-primary-rgb), 0.30);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 22px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--theme-border);
}

.modal-header h3 {
    color: var(--theme-accent);
    margin: 0;
    font-size: 20px;
    font-weight: 700;
}

.modal-body {
    margin-bottom: 22px;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 14px;
    border-top: 1px solid var(--theme-border);
}

.confirmation-list {
    padding-left: 20px;
    margin: 0;
    list-style: none;
}

.confirmation-list li {
    position: relative;
    margin: 6px 0;
    font-size: 13px;
}

.confirmation-list li::before {
    content: "•";
    position: absolute;
    left: -14px;
    top: 0;
    color: var(--theme-accent);
    font-size: 13px;
}

/* 通用复选框：appearance 自绘控制勾选色；body[data-theme] 前缀将特异性提至 3002，压过 .form-group input 的背景/边框(2002)与尺寸/内边距(1001) */
body[data-theme] input[type="checkbox"].app-checkbox {
    width: 16px;
    height: 16px;
    margin: 0;
    padding: 0;
    flex-shrink: 0;
    vertical-align: middle;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
    position: relative;
    background: var(--theme-panel-bg);
    border: 1px solid var(--theme-muted);
    border-radius: 3px;
}

body[data-theme] input[type="checkbox"].app-checkbox:checked {
    background: var(--theme-accent);
    border-color: var(--theme-accent);
}

body[data-theme] input[type="checkbox"].app-checkbox:checked::after {
    content: "";
    position: absolute;
    left: 5px;
    top: 1px;
    width: 4px;
    height: 9px;
    border: solid var(--theme-check-color);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
}

body[data-theme] input[type="checkbox"].app-checkbox:focus-visible {
    outline: 2px solid var(--theme-accent-soft);
    outline-offset: 1px;
}

.cache-clear-hint {
    margin: 0 0 12px;
    font-size: 16px;
    color: var(--theme-text);
}

.cache-clear-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}

.cache-clear-count {
    font-size: 12px;
    font-weight: 500;
    color: var(--theme-muted);
    background: color-mix(in srgb, var(--theme-muted) 10%, transparent); /* 状态标签底色，非按钮 */
    padding: 5px 10px;
    border-radius: 999px;
}

.cache-clear-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.cache-clear-actions .btn {
    flex-shrink: 0;
    white-space: nowrap;
    min-width: 64px;
}

.cache-clear-options {
    display: flex;
    flex-direction: column;
    margin: 0;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    overflow: hidden;
    background: var(--theme-panel-bg);
}

.cache-clear-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
    padding: 9px 12px;
    border-bottom: 1px solid var(--theme-border);
}

.cache-clear-item:last-child {
    border-bottom: none;
}

.cache-clear-item:hover {
    background: var(--theme-panel-strong);
}

.cache-clear-note {
    margin: 12px 0 0;
    font-size: 12px;
    color: var(--theme-muted);
}

.warning-box {
    background: rgba(240, 160, 96, 0.10);
    border-left: 3px solid #f0a060;
    padding: 12px 14px;
    border-radius: 8px;
    margin-top: 12px;
    margin-bottom: 18px;
    font-size: 13px;
}

.error-config-banner {
    background: var(--theme-panel-strong);
    border: 1px solid var(--theme-border);
    padding: 15px;
    border-radius: var(--app-radius-card-sm);
    margin-bottom: 20px;
}

.error-config-title {
    color: var(--theme-accent);
    margin-top: 0;
    font-size: 16px;
}

.error-config-text {
    color: var(--theme-muted);
    margin-bottom: 10px;
    font-size: 14px;
}

.error-config-banner input {
    padding: 8px 10px;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    background: var(--theme-input-bg);
    color: var(--theme-text);
}

.error-config-banner code {
    background: var(--theme-panel-bg);
    border: 1px solid var(--theme-border);
    border-radius: 4px;
    padding: 0.1em 0.35em;
    font-size: 0.85em;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    word-break: break-all;
}

.close-btn {
    background: var(--theme-panel-strong);
    border: none;
    font-size: 20px;
    cursor: pointer;
    color: var(--theme-muted);
    width: 32px;
    height: 32px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.22s var(--app-ease-smooth);
}

.close-btn:hover {
    color: var(--theme-text);
    background: var(--theme-panel-strong);
    transform: scale(1.1) rotate(90deg);
}

/* ============ 值类型徽章 ============ */
.value-type-badge {
    display: inline-block;
    padding: 2px 8px;
    background: var(--theme-accent);
    color: #ffffff;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    margin-left: 6px;
}

.value-type-badge.multi {
    background: #e0707a;
}

.value-type-badge.map {
    background: #a682e6;
}

/* ============ 进度条 ============ */
.progress-container {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(var(--app-primary-rgb), 0.1);
    z-index: 9999;
    display: none;
}

.progress-container.active {
    display: block;
}

.progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--theme-accent), var(--theme-accent-hover));
    width: 0;
    transition: width 0.3s var(--app-ease-smooth);
    box-shadow: 0 0 6px rgba(var(--app-primary-rgb), 0.4);
}

/* ============ 加载提示 ============ */
.loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: 9998;
}

.loading-overlay.active {
    display: flex;
}

.loading-content {
    background: var(--theme-container-bg);
    padding: 36px;
    border-radius: 18px;
    text-align: center;
    box-shadow: var(--app-shadow-elevated);
    max-width: 380px;
}

.loading-spinner {
    width: 48px;
    height: 48px;
    border: 4px solid var(--theme-border);
    border-top: 4px solid var(--theme-accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 16px;
}

.loading-spinner-small {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top: 2px solid #ffffff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-right: 6px;
    vertical-align: middle;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.loading-text {
    font-size: 16px;
    color: var(--theme-text);
    font-weight: 600;
    margin-bottom: 8px;
}

.loading-detail {
    font-size: 13px;
    color: var(--theme-muted);
}

/* ============ 通用工具类 ============ */
.text-center { text-align: center; }
.text-gray { color: var(--theme-muted); }
.text-red { color: #e0707a; }
.text-dark-gray { color: var(--theme-text); font-weight: 600; }
.text-purple { color: var(--theme-accent); }
.text-yellow-gold { color: var(--theme-accent); }
.padding-20 { padding: 18px; }
.margin-bottom-10 { margin-bottom: 10px; }
.margin-top-3 { margin-top: 3px; }
.margin-top-15 { margin-top: 15px; }
.font-size-12 { font-size: 12px; }
.margin-bottom-15 { margin-bottom: 15px; }
.text-monospace { font-family: ui-monospace, monospace; }

/* ============ 推送弹幕 ============ */
.anime-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
    margin-top: 14px;
}

.anime-item {
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    padding: 8px;
    text-align: center;
    cursor: pointer;
    transition: all 0.22s var(--app-ease-smooth);
    background: var(--theme-panel-bg);
}

.anime-item:hover {
    border-color: var(--theme-accent);
    box-shadow: var(--app-shadow-sm);
    transform: translateY(-2px);
}

.anime-item-img {
    width: 100%;
    height: 150px;
    object-fit: cover;
    border-radius: 8px;
}

.anime-title {
    margin: 6px 0 4px;
    font-size: 12px;
    word-break: normal;
    overflow-wrap: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
}

.episode-list-container {
    max-height: 400px;
    overflow-y: auto;
}

.episode-item {
    padding: 8px 10px;
    border-bottom: 1px solid var(--theme-border);
    display: flex;
    align-items: center;
    gap: 8px;
}

.episode-item-content {
    flex: 1;
    min-width: 0;
}

.episode-push-btn {
    width: 80px;
    flex-shrink: 0;
    justify-content: center;
}

/* ============ Bilibili Cookie ============ */
.bili-cookie-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.bili-cookie-status {
    background: var(--theme-panel-bg);
    padding: 12px;
    border-radius: var(--app-radius-card-sm);
    display: flex;
    align-items: center;
    gap: 10px;
    border-left: 3px solid var(--theme-accent);
}

.bili-status-icon {
    font-size: 18px;
}

.bili-status-text {
    flex: 1;
    font-weight: 500;
    font-size: 13px;
}

.bili-cookie-actions {
    display: flex;
    gap: 8px;
}

/* ============ 多选标签 & 合并模式 ============ */
.selected-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    padding: 6px 12px;
    border-radius: 999px;
    cursor: move;
    user-select: none;
    transition: all 0.22s var(--app-ease-smooth);
    font-size: 13px;
    font-weight: 500;
    max-width: 100%;
    height: auto;
    white-space: normal;
    word-break: break-all;
    line-height: 1.4;
}

.selected-tag:hover {
    filter: brightness(1.05);
    transform: translateY(-1px);
}

.selected-tag.dragging {
    opacity: 0.5;
    transform: rotate(3deg);
}

.selected-tag .tag-text {
    font-weight: 500;
}

.selected-tag .remove-btn {
    width: 16px;
    height: 16px;
    background: rgba(255, 255, 255, 0.3);
    border: none;
    border-radius: 50%;
    color: #ffffff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    transition: all 0.2s;
}

.selected-tag .remove-btn:hover {
    background: rgba(255, 255, 255, 0.5);
    transform: scale(1.1) rotate(90deg);
}

.merge-mode-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
}

.merge-mode-btn {
    padding: 5px 12px;
    background: var(--theme-panel-strong);
    border: 1px solid var(--theme-border);
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.22s var(--app-ease-smooth);
    color: var(--theme-muted);
    font-weight: 500;
}

.merge-mode-btn.active {
    background: var(--theme-accent-soft);
    border-color: var(--theme-accent);
    color: var(--theme-accent);
    font-weight: 600;
}

.merge-mode-btn:hover {
    transform: translateY(-1px);
}

.staging-area {
    display: none;
    background: var(--theme-accent-soft);
    border: 2px dashed rgba(var(--app-primary-rgb), 0.25);
    border-radius: var(--app-radius-card-sm);
    padding: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    min-height: 48px;
    position: relative;
    transition: all 0.22s var(--app-ease-smooth);
}

.staging-area.active {
    display: flex;
    animation: slideDown 0.3s var(--app-ease-smooth);
}

@keyframes slideDown {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
}

.staging-area::before {
    content: '合并组暂存区';
    color: var(--theme-accent);
    font-size: 11px;
    font-weight: 700;
    margin-right: 4px;
}

.staging-tag {
    background: var(--theme-container-bg);
    color: var(--theme-accent);
    border: 1px solid rgba(var(--app-primary-rgb), 0.2);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: move;
    user-select: none;
    max-width: 100%;
    word-break: break-all;
}

.staging-tag:hover {
    transform: translateY(-1px);
}

.staging-tag.drag-over {
    background: var(--theme-accent-soft);
    border-color: var(--theme-accent);
    transform: scale(1.05);
}

.staging-tag.dragging {
    opacity: 0.5;
    transform: scale(0.95);
}

.staging-tag .remove-btn {
    color: #e0707a;
    cursor: pointer;
    font-weight: 700;
    font-size: 13px;
    display: inline-block;
    transition: transform 0.22s var(--app-ease-smooth);
}

.staging-tag .remove-btn:hover {
    transform: scale(1.2) rotate(90deg);
}

.staging-separator {
    color: var(--theme-muted);
    font-weight: 700;
}

.confirm-merge-btn {
    margin-left: auto;
    background: linear-gradient(135deg, #52a67d, #459670);
    color: #ffffff;
    border: none;
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(82, 166, 125, 0.25);
    transition: box-shadow 0.22s var(--app-ease-smooth), filter 0.22s var(--app-ease-smooth), transform 0.22s var(--app-ease-smooth) !important;
}

.confirm-merge-btn:hover {
    filter: brightness(1.1);
    transform: scale(1.1);
}

.confirm-merge-btn:disabled {
    background: var(--theme-panel-strong);
    cursor: not-allowed;
    box-shadow: none;
}

.available-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}

.available-tag {
    padding: 5px 12px;
    background: var(--theme-input-bg);
    border: 1px solid var(--theme-border);
    border-radius: 999px;
    cursor: pointer;
    transition: all 0.2s;
    user-select: none;
    font-size: 13px;
    font-weight: 500;
}

.available-tag:hover {
    border-color: var(--theme-accent);
    background: var(--theme-accent-soft);
}

.available-tag.disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
}

.drag-over {
    background: var(--theme-accent-soft) !important;
    border-color: var(--theme-accent) !important;
}

/* ============ 请求记录 ============ */
.request-records-container {
    border-radius: var(--app-radius-card);
}

.no-records {
    text-align: center;
    color: var(--theme-muted);
    padding: 50px;
    font-size: 15px;
}

.record-item {
    background: var(--theme-panel-bg);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card);
    padding: 14px;
    margin-bottom: 12px;
    box-shadow: var(--app-shadow-sm);
    transition: transform 0.22s var(--app-ease-smooth), box-shadow 0.22s var(--app-ease-smooth);
}

.record-item:hover {
    transform: translateY(-2px);
    box-shadow: var(--app-shadow-md);
}

.record-header {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
    gap: 10px;
}

.record-method {
    background: linear-gradient(135deg, #5ec4db, #4fb8d0);
    color: #ffffff;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    min-width: 50px;
    text-align: center;
}

.record-interface {
    flex: 1;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-weight: 600;
    color: var(--theme-text);
    word-break: break-all;
    font-size: 14px;
    background: var(--theme-panel-strong);
    padding: 6px 14px;
    border-radius: 8px;
}

.record-ip {
    background: linear-gradient(135deg, #a682e6, #9570d8);
    color: #ffffff;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 11px;
    min-width: 100px;
    text-align: center;
    font-weight: 500;
}

.record-timestamp {
    color: var(--theme-muted);
    font-size: 12px;
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--theme-border);
    display: flex;
    align-items: center;
    gap: 6px;
}

.record-timestamp.no-params {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
}

.record-timestamp::before {
    content: '\\1F550';
    font-size: 14px;
}

.record-params {
    background: var(--theme-panel-strong);
    border-radius: var(--app-radius-card-sm);
    padding: 14px;
}

.record-params-title {
    color: var(--theme-accent);
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
}

.record-params-title::before {
    content: '\\1F4CB';
    font-size: 14px;
}

.record-params pre {
    margin: 0;
    padding: 12px;
    background: var(--theme-input-bg);
    color: var(--theme-text);
    border-radius: 8px;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-x: auto;
    line-height: 1.6;
    border: 1px solid var(--theme-border);
}

/* ============ 弹幕测试 ============ */
.api-top-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 18px;
    border-bottom: 2px solid var(--theme-border);
}

.api-top-tab {
    padding: 8px 22px;
    background: none;
    border: none;
    border-bottom: 3px solid transparent;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: var(--theme-muted);
    transition: all 0.22s var(--app-ease-smooth);
    margin-bottom: -2px;
}

.api-top-tab:hover {
    color: var(--theme-accent);
}

.api-top-tab.active {
    color: var(--theme-accent);
    border-bottom-color: var(--theme-accent);
    font-weight: 700;
}

.api-tab-content {
    display: none;
}

.api-tab-content.active {
    display: block;
}

.danmu-test-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
}

.danmu-test-tab {
    padding: 7px 18px;
    background: var(--theme-panel-strong);
    border: 1px solid transparent;
    border-radius: 999px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.22s var(--app-ease-smooth);
    color: var(--theme-muted);
}

.danmu-test-tab:hover {
    border-color: var(--theme-accent);
}

.danmu-test-tab.active {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    border-color: var(--theme-accent);
}

.danmu-test-panel {
    display: none;
}

.danmu-test-panel.active {
    display: block;
}

/* 弹幕统计卡片 */
.danmu-stats {
    margin-bottom: 14px;
}

.danmu-stats-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--theme-accent);
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--theme-border);
}

.danmu-stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
}

.danmu-stat-card {
    background: var(--theme-panel-bg);
    border-radius: var(--app-radius-card-sm);
    padding: 14px;
    text-align: center;
    border: 1px solid var(--theme-border);
    transition: transform 0.22s var(--app-ease-smooth), box-shadow 0.22s var(--app-ease-smooth);
}

.danmu-stat-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--app-shadow-sm);
}

.stat-value {
    font-size: 20px;
    font-weight: 700;
    color: var(--theme-text);
    margin-bottom: 3px;
    word-break: break-all;
}

.stat-label {
    font-size: 11px;
    color: var(--theme-muted);
    font-weight: 500;
}

.danmu-result-error {
    margin-bottom: 14px;
    background: rgba(224, 112, 122, 0.08);
    border: 1px solid rgba(224, 112, 122, 0.2);
    color: #d4626c;
    border-radius: var(--app-radius-card-sm);
    padding: 10px 14px;
    font-size: 13px;
}

/* 弹幕热力图 */
.danmu-heatmap-container {
    margin-bottom: 14px;
    background: var(--theme-panel-bg);
    border-radius: var(--app-radius-card-sm);
    padding: 14px;
    border: 1px solid var(--theme-border);
}

.danmu-section-title {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
}

.danmu-section-title-spaced {
    margin-top: 14px;
}

.danmu-empty-text { color: var(--theme-muted); }
.danmu-empty-list { text-align: center; padding: 18px; }

.heatmap-bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 100px;
    padding: 0 2px;
}

.danmu-heatmap-interactive {
    position: relative;
    padding-top: 32px;
    touch-action: pan-y;
    user-select: none;
}

.danmu-heatmap-tooltip {
    position: absolute;
    top: 0;
    left: 0;
    transform: translateX(-50%) translateY(-4px);
    display: flex;
    align-items: baseline;
    gap: 3px;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(26, 27, 36, 0.92);
    color: #ffffff;
    font-size: 11px;
    line-height: 1.2;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease, transform 0.12s ease;
    z-index: 2;
}

.danmu-heatmap-tooltip.active {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
}

.danmu-heatmap-tooltip strong { font-size: 14px; }
.danmu-heatmap-tooltip em { color: rgba(255,255,255,0.72); font-style: normal; margin-left: 2px; }

.danmu-heatmap-indicator {
    position: absolute;
    top: 32px;
    bottom: 0;
    width: 2px;
    transform: translateX(-50%);
    border-radius: 999px;
    background: rgba(var(--app-primary-rgb), 0.88);
    box-shadow: 0 0 0 3px rgba(var(--app-primary-rgb), 0.14);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
    z-index: 1;
}

.danmu-heatmap-indicator.active { opacity: 1; }

.heatmap-bar {
    flex: 1;
    min-width: 3px;
    height: var(--heatmap-height, 2%);
    background: var(--heatmap-color, var(--theme-accent));
    border-radius: 2px 2px 0 0;
    transition: opacity 0.2s, transform 0.12s ease, box-shadow 0.12s ease;
    cursor: pointer;
}

.heatmap-bar.active {
    opacity: 0.95;
    transform: translateY(-2px);
    box-shadow: 0 0 0 2px rgba(var(--app-primary-rgb), 0.24);
}

.heatmap-bar:hover { opacity: 0.8; }

.heatmap-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 5px;
    font-size: 10px;
    color: var(--theme-muted);
}

/* 弹幕过滤 */
.danmu-filter-tabs {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    margin-bottom: 10px;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
}

.danmu-filter-tabs::-webkit-scrollbar { display: none; }

.danmu-list-tools {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.danmu-search {
    flex: 1 1 260px;
    min-width: 0;
    max-width: 420px;
}

.danmu-search-status {
    color: var(--theme-muted);
    font-size: 12px;
    white-space: nowrap;
}

.danmu-filter-tab {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    padding: 5px 12px;
    background: var(--theme-panel-strong);
    border: 1px solid transparent;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.22s var(--app-ease-smooth);
    color: var(--theme-muted);
}

.danmu-filter-tab:hover { border-color: var(--theme-accent); }

.danmu-filter-tab.active {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    border-color: var(--theme-accent);
}

.danmu-filter-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.08);
    color: inherit;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
}

.danmu-filter-tab.active .danmu-filter-count {
    background: rgba(255, 255, 255, 0.22);
}

/* 弹幕列表 */
.danmu-list-area {
    background: var(--theme-panel-bg);
    border-radius: var(--app-radius-card-sm);
    padding: 14px;
    border: 1px solid var(--theme-border);
}

.danmu-list-area h3 {
    margin: 0 0 10px;
    font-size: 14px;
    font-weight: 600;
}

.danmu-list {
    max-height: 500px;
    overflow-y: auto;
    border: 1px solid var(--theme-border);
    border-radius: 10px;
    background: var(--theme-input-bg);
}

.danmu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--theme-border);
    font-size: 13px;
    transition: background 0.15s;
}

.danmu-item:last-child { border-bottom: none; }
.danmu-item:hover { background: var(--theme-panel-strong); }

.danmu-time {
    color: var(--theme-muted);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    min-width: 48px;
    flex-shrink: 0;
}

.danmu-color-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: var(--danmu-color-dot, #ffffff);
}

.danmu-mode-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 999px;
    flex-shrink: 0;
    font-weight: 600;
}

.episode-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    border-radius: 8px;
    gap: 16px;
    transition: background 0.15s;
}

.episode-item:hover {
    background: var(--theme-panel-bg);
    box-shadow: inset 3px 0 0 var(--theme-accent);
}

.episode-item-content {
    min-width: 0;
    font-size: 14px;
    color: var(--theme-text);
}

.episode-item .btn {
    flex-shrink: 0;
    margin-left: auto;
}

.danmu-mode-scroll { background: rgba(94, 196, 219, 0.15); color: #3aafc8; }
.danmu-mode-top { background: rgba(224, 112, 122, 0.15); color: #d4626c; }
.danmu-mode-bottom { background: rgba(82, 166, 125, 0.15); color: #459670; }

.danmu-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--theme-text);
}

.danmu-load-more {
    display: none;
    width: 100%;
    margin-top: 8px;
}

.jump-to-episode {
    margin-top: 14px;
    margin-bottom: 14px;
    padding: 10px;
    background: var(--theme-panel-bg);
    border-radius: var(--app-radius-card-sm);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    border: 1px solid var(--theme-border);
}

.jump-to-episode > span {
    font-size: 13px;
}

.jump-episode-input {
    padding: 7px 12px;
    width: 110px;
    max-width: 100%;
    min-width: 0;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-input);
    font-size: 13px;
    text-align: center;
    background: var(--theme-input-bg);
    color: var(--theme-text);
}

.jump-episode-btn {
    margin-left: 4px;
    border-radius: var(--app-radius-btn);
}

.jump-episode-total {
    margin-left: 4px;
    color: var(--theme-muted);
    font-size: 13px;
}

.episode-item.episode-item-highlight {
    background: rgba(var(--app-primary-rgb), 0.08);
}

.btn-back {
    padding: 7px 16px;
    background: var(--theme-panel-strong);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-btn);
    cursor: pointer;
    font-size: 13px;
    color: var(--theme-muted);
    transition: all 0.22s var(--app-ease-smooth);
    margin-bottom: 14px;
    display: inline-block;
}

.btn-back:hover {
    border-color: var(--theme-accent);
    color: var(--theme-accent);
}

.danmu-loading {
    text-align: center;
    padding: 50px 20px;
}

.danmu-loading .loading-spinner { margin: 0 auto 14px; }
.danmu-loading .loading-text { color: var(--theme-muted); font-size: 14px; }

.danmu-result-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
    flex-wrap: wrap;
    gap: 8px;
}

.danmu-result-toolbar .btn-back { margin-bottom: 0; }

.danmu-export-btns {
    display: flex;
    gap: 6px;
    margin-left: auto;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.danmu-export-select {
    background-color: var(--theme-panel-strong);
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-btn);
    padding: 5px 12px;
    font-size: 12px;
    line-height: 1.4;
    max-width: 220px;
    cursor: pointer;
}

.danmu-export-select:hover {
    border-color: var(--theme-accent);
}

.danmu-export-select:focus-visible {
    outline: 2px solid var(--theme-accent);
    outline-offset: 2px;
}

.danmu-source-url {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding: 9px 10px;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    background: var(--theme-panel-bg);
}

.danmu-source-url-label {
    color: var(--theme-muted);
    font-size: 12px;
    white-space: nowrap;
}

.danmu-source-url-value {
    min-width: 0;
    overflow: hidden;
    color: var(--theme-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
}

.danmu-source-url-actions {
    display: flex;
    gap: 6px;
}

.danmu-source-url-actions .btn {
    flex: 0 0 auto;
    white-space: nowrap;
}

@media (max-width: 768px) {
    .danmu-list-tools {
        flex-wrap: wrap;
    }

    .preview-search.danmu-search {
        order: 0;
        flex: 1 1 100%;
        width: 100%;
        max-width: none;
    }

    .danmu-search-status {
        order: 1;
        margin-left: auto;
    }

    .danmu-export-btns {
        flex: 1 1 0;
        min-width: 0;
        flex-wrap: nowrap;
    }

    .danmu-export-select {
        flex: 1 1 160px;
        max-width: none;
        min-width: 0;
    }

    .danmu-export-btns .btn {
        flex: 0 0 auto;
        white-space: nowrap;
    }

    .danmu-result-toolbar .btn-back {
        flex: 0 0 auto;
        white-space: nowrap;
    }
}

/* ============ 颜色池配置 ============ */
.color-pool-display {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    min-height: 34px;
    padding: 8px;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    background: var(--theme-panel-strong);
}

.color-pool-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    background: var(--theme-input-bg);
    font-size: 12px;
}

.color-pool-item:hover {
    transform: translateY(-1px);
}

.color-pool-swatch {
    display: inline-block;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid var(--theme-border);
}

.color-pool-value {
    color: var(--theme-muted);
    font-family: ui-monospace, monospace;
    font-size: 10px;
}

.color-pool-remove {
    border: none;
    background: none;
    color: var(--theme-muted);
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    transition: all 0.22s var(--app-ease-smooth);
}

.color-pool-remove:hover {
    color: #e0707a;
    transform: scale(1.2) rotate(90deg);
}

.color-pool-empty {
    color: var(--theme-muted);
    font-size: 12px;
    align-self: center;
}

.color-pool-picker {
    padding: 14px;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    background: var(--theme-panel-bg);
    margin-bottom: 10px;
}

.color-pool-picker-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
}

.color-wheel {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    background: conic-gradient(hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%));
    cursor: crosshair;
    position: relative;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
    flex-shrink: 0;
}

.color-wheel-center {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%,-50%);
    width: 44%;
    height: 44%;
    border-radius: 50%;
    background: var(--theme-panel-bg);
}

.color-wheel-dot {
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2.5px solid #ffffff;
    box-shadow: 0 0 4px rgba(0,0,0,0.35);
    pointer-events: none;
}

.color-pool-preview {
    display: flex;
    align-items: center;
    gap: 8px;
}

.color-pool-preview-swatch {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--theme-border);
    flex-shrink: 0;
}

.color-pool-preview-hex {
    font-family: ui-monospace, monospace;
    font-size: 13px;
    color: var(--theme-muted);
}

.color-pool-lightness {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 240px;
}

.color-pool-lightness span {
    font-size: 11px;
    color: var(--theme-muted);
    flex-shrink: 0;
}

.color-pool-actions {
    display: flex;
    gap: 6px;
    flex-wrap: nowrap;
}

.color-pool-actions .btn { white-space: nowrap; flex-shrink: 0; }
.color-pool-actions .spacer { flex: 1; }

/* 批量颜色弹窗 */
.batch-color-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
}

.batch-color-dialog {
    background: var(--theme-container-bg);
    border-radius: 18px;
    padding: 18px;
    width: 90%;
    max-width: 400px;
    box-shadow: var(--app-shadow-elevated);
}

.batch-color-input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    font-size: 13px;
    font-family: ui-monospace, monospace;
    resize: vertical;
    box-sizing: border-box;
}

.batch-color-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
    min-height: 24px;
}

.batch-color-preview-swatch {
    display: inline-block;
    width: 20px;
    height: 20px;
    border-radius: 4px;
}

/* ============ Bilibili Cookie 扫码弹窗 ============ */
.bili-cookie-dialog {
    background: var(--theme-container-bg);
    border-radius: 18px;
    padding: 24px;
    box-shadow: var(--app-shadow-elevated);
    max-width: 400px;
    text-align: center;
}

/* ============ 暗色模式特殊处理 ============ */
body[data-theme$="-dark"] .heatmap-bar {
    filter: brightness(0.9);
}

/* ============ 弹幕测试响应式 ============ */
@media (max-width: 768px) {
    .danmu-stats-grid {
        grid-template-columns: repeat(2, 1fr);
    }

    .api-top-tab {
        padding: 7px 14px;
        font-size: 13px;
    }

    .danmu-test-tabs {
        flex-wrap: wrap;
    }

    .stat-value {
        font-size: 16px;
    }

    .heatmap-bars {
        height: 70px;
        gap: 1px;
        padding: 0 1px;
    }

    .heatmap-bar {
        min-width: 2px;
    }
}

@media (max-width: 768px) {
    .bili-cookie-actions {
        flex-direction: column;
    }

    .bili-cookie-actions .btn {
        width: 100%;
    }

    .record-header {
        flex-direction: column;
        align-items: stretch;
    }

    .record-method,
    .record-interface,
    .record-ip {
        width: 100%;
        box-sizing: border-box;
    }
}

/* ============ 偏移/合并规则编辑器（offset-* 系列） ============ */
.offset-rule-panel {
    background: var(--theme-panel-bg);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    padding: 16px;
    margin-top: 12px;
}

.offset-form-row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    margin-bottom: 10px;
    flex-wrap: wrap;
}

.offset-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: var(--theme-muted);
    margin-bottom: 4px;
}

.offset-input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    font-size: 13px;
    background: var(--theme-input-bg);
    color: var(--theme-text);
}

.offset-input:focus {
    outline: none;
    border-color: var(--theme-accent);
    box-shadow: 0 0 0 3px var(--theme-accent-soft);
}

.offset-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.offset-source-tag {
    padding: 5px 14px;
    background: var(--theme-panel-strong);
    color: var(--theme-text);
    border: 1px solid var(--theme-border);
    border-radius: 20px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    user-select: none;
    transition: all 0.22s var(--app-ease-smooth);
}

.offset-source-tag:hover {
    border-color: var(--theme-accent);
    background: var(--theme-accent-soft);
    transform: translateY(-1px);
}

.offset-source-tag.selected {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    border-color: var(--theme-accent);
}

.offset-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 8px;
}

/* ============ 最近数据缓存面板（anime-cache-*） ============ */
.recent-data-panel {
    background: var(--theme-panel-bg);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    padding: 14px;
    margin-top: 10px;
    display: none;
}

.anime-cache-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.recent-data-load-more {
    width: 100%;
    margin-top: 10px;
}

.anime-cache-card {
    background: var(--theme-container-bg);
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-card-sm);
    overflow: hidden;
    transition: box-shadow 0.22s var(--app-ease-smooth);
}

.anime-cache-card:hover {
    box-shadow: var(--app-shadow-sm);
}

.anime-cache-card-body {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
}

.anime-cache-cover {
    width: 56px;
    height: 76px;
    border-radius: 8px;
    object-fit: cover;
    background-color: var(--theme-panel-strong);
    flex-shrink: 0;
}

.anime-cache-info {
    flex: 1;
    min-width: 0;
}

.anime-cache-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--theme-text);
    margin-bottom: 4px;
    overflow-wrap: break-word;
}

.anime-cache-meta {
    font-size: 11px;
    color: var(--theme-muted);
    margin-bottom: 6px;
}

.anime-cache-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

.anime-cache-child-item {
    border-top: 1px solid var(--theme-border);
}

.anime-cache-child-main {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
}

.anime-cache-child-cover {
    width: 36px;
    height: 48px;
    border-radius: 6px;
    object-fit: cover;
    background-color: var(--theme-panel-strong);
    flex-shrink: 0;
}

.anime-cache-child-info {
    flex: 1;
    min-width: 0;
}

.anime-cache-child-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--theme-text);
    overflow-wrap: break-word;
}

.anime-cache-child-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
}

.anime-cache-footer {
    padding: 8px 14px;
    font-size: 11px;
    color: var(--theme-muted);
    border-top: 1px solid var(--theme-border);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.btn-xs {
    padding: 3px 8px;
    font-size: 11px;
    border-radius: 8px;
}

/* ============ AI API Key 编辑器 ============ */
.ai-apikey-editor {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.ai-apikey-status {
    background: var(--theme-panel-bg);
    padding: 12px;
    border-radius: var(--app-radius-card-sm);
    display: flex;
    align-items: center;
    gap: 10px;
    border-left: 3px solid var(--theme-accent);
}

.ai-status-icon {
    font-size: 18px;
}

.ai-status-text {
    flex: 1;
    font-weight: 500;
    font-size: 13px;
}

.ai-apikey-actions {
    display: flex;
    gap: 8px;
}

/* ============ 缓存面板 — 剧集列表 / 子源 / 映射详情 ============ */
.episodes-list-container {
    display: none;
    flex-direction: column;
    border-top: 1px solid var(--theme-border);
}

.merged-children-container {
    display: none;
    flex-direction: column;
    border-top: 1px solid var(--theme-border);
}

.child-mapping-container {
    display: none;
    flex-direction: column;
    gap: 2px;
    padding: 6px 10px 10px 12px;
    border-top: 1px solid var(--theme-border);
    background: var(--theme-panel-strong);
}

.child-mapping-toggle {
    padding: 5px 10px;
    font-size: 11px;
    color: var(--theme-accent);
    cursor: pointer;
    user-select: none;
    border-radius: 6px;
    transition: background 0.2s;
}

.child-mapping-toggle:hover {
    background: var(--theme-accent-soft);
}

.mapping-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 4px 6px;
    border-radius: 6px;
}
.mapping-row:nth-child(even) {
    background: var(--theme-panel-bg);
}

.mapping-status {
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
}

.mapping-status.success { color: #52a67d; }
.mapping-status.warning { color: #f0a060; }

.mapping-text {
    color: var(--theme-muted);
    word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

/* 缓存卡片底部切换标签 */
.cache-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
    transition: all 0.22s var(--app-ease-smooth);
    background: var(--theme-panel-strong);
    color: var(--theme-muted);
    border: 1px solid var(--theme-border);
}

.cache-badge:hover {
    border-color: var(--theme-accent);
    color: var(--theme-accent);
}

.cache-badge.active {
    background: var(--theme-accent-soft);
    color: var(--theme-accent);
    border-color: var(--theme-accent);
}

/* ============ 推送弹幕容器 ============ */
.push-controls {
    margin-bottom: 20px;
}

.anime-list {
    display: none;
}

.episode-list {
    display: none;
    margin-top: 20px;
}

/* ============ 批量颜色操作区 ============ */
.batch-color-actions {
    display: flex;
    gap: 6px;
}

/* ============ 环境变量配置工具栏 ============ */
.env-config-toolbar {
    /* 继承 preview-toolbar 样式 */
}
`;
