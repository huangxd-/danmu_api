// language=CSS
export const formsCssContent = /* css */ `
/* 表单控件样式 — 保持 danmu_api 原有交互形态 + Bangumi-syncer 配色 */

/* ============ 表单基础 ============ */
.form-group {
    margin-bottom: 14px;
}

.form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.02em;
    color: var(--theme-muted);
}

.form-group input,
.form-group select,
.form-group textarea {
    width: 100%;
    padding: 9px 14px;
    border: 1px solid var(--theme-border);
    border-radius: var(--app-radius-input);
    font-size: 13px;
    background: var(--theme-input-bg);
    color: var(--theme-text);
    transition: border-color 0.22s var(--app-ease-smooth), box-shadow 0.22s var(--app-ease-smooth);
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
    outline: none;
    border-color: var(--theme-accent);
    box-shadow: 0 0 0 3px var(--theme-accent-soft);
}

.form-group textarea {
    resize: vertical;
    min-height: 80px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    line-height: 1.5;
    border-radius: var(--app-radius-card-sm);
}

/* ============ 开关按钮 ============ */
.switch-container {
    display: flex;
    align-items: center;
    gap: 10px;
}

.switch {
    position: relative;
    display: inline-block;
    width: 48px;
    height: 26px;
}

.switch input {
    opacity: 0;
    width: 0;
    height: 0;
}

.slider {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: var(--theme-border);
    transition: 0.3s var(--app-ease-smooth);
    border-radius: 999px;
}

.slider:before {
    position: absolute;
    content: "";
    height: 20px;
    width: 20px;
    left: 3px;
    bottom: 3px;
    background-color: #ffffff;
    transition: 0.3s var(--app-ease-smooth);
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

input:checked + .slider {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    box-shadow: 0 0 0 3px var(--theme-accent-soft);
}

input:checked + .slider:before {
    transform: translateX(22px);
}

.switch-label {
    font-weight: 500;
    font-size: 13px;
    color: var(--theme-text);
}

/* ============ 数字滚轮 ============ */
.number-picker {
    display: flex;
    align-items: center;
    gap: 14px;
    background: var(--theme-panel-bg);
    padding: 14px;
    border-radius: var(--app-radius-card-sm);
    border: 1px solid var(--theme-border);
}

.number-display {
    font-size: 30px;
    font-weight: 700;
    color: var(--theme-accent);
    min-width: 60px;
    text-align: center;
    font-variant-numeric: tabular-nums;
}

.number-controls {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.number-btn {
    width: 38px;
    height: 38px;
    border: 1.5px solid var(--theme-accent);
    background: var(--theme-input-bg);
    color: var(--theme-accent);
    border-radius: 10px;
    cursor: pointer;
    font-size: 18px;
    font-weight: 700;
    transition: all 0.22s var(--app-ease-smooth);
    display: flex;
    align-items: center;
    justify-content: center;
}

.number-btn:hover {
    background: var(--theme-accent);
    color: #ffffff;
    transform: scale(1.05);
}

.number-btn:active {
    transform: scale(0.95);
}

.number-range {
    width: 100%;
    margin-top: 8px;
}

.number-range input[type="range"],
.color-pool-lightness input[type="range"] {
    width: 100%;
    height: 6px;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
    background: transparent;
}

.number-range input[type="range"]::-webkit-slider-runnable-track,
.color-pool-lightness input[type="range"]::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 3px;
    background: var(--theme-panel-strong);
}

.number-range input[type="range"]::-moz-range-track,
.color-pool-lightness input[type="range"]::-moz-range-track {
    height: 6px;
    border-radius: 3px;
    background: var(--theme-panel-strong);
    border: none;
}

.number-range input[type="range"]::-webkit-slider-thumb,
.color-pool-lightness input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--theme-accent);
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(var(--app-primary-rgb), 0.3);
    margin-top: -6px;
}

.number-range input[type="range"]::-moz-range-thumb,
.color-pool-lightness input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--theme-accent);
    cursor: pointer;
    border: none;
    box-shadow: 0 1px 4px rgba(var(--app-primary-rgb), 0.3);
}

.number-range input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--theme-accent);
    cursor: pointer;
    border: none;
}

/* ============ 标签选择（单选） ============ */
.tag-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.tag-option {
    padding: 10px 20px;
    background: var(--theme-panel-strong);
    border: 2px solid transparent;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
    font-weight: 500;
}

.tag-option:hover {
    background: var(--theme-panel-bg);
    transform: translateY(-1px);
}

.tag-option.selected {
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    border-color: var(--theme-accent);
}

/* ============ 多选标签（保持原有椭圆包裹形态，仅改配色） ============ */
.multi-select-container {
    display: flex;
    flex-direction: column;
    gap: 15px;
    background: transparent !important;
    border: none;
    box-shadow: none;
}

.selected-tags {
    min-height: 60px;
    background: var(--theme-container-bg);
    border: 2px dashed var(--theme-border);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
}

.selected-tags.empty::before {
    content: '拖动或点击下方选项添加...';
    color: var(--theme-muted);
    font-size: 14px;
    width: 100%;
    text-align: center;
    padding: 15px 0;
}

.selected-tag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: linear-gradient(135deg, var(--theme-accent), var(--theme-accent-hover));
    color: #ffffff;
    padding: 8px 12px;
    border-radius: 20px;
    cursor: move;
    user-select: none;
    transition: all 0.3s;
    max-width: 100%;
    height: auto;
    white-space: normal;
    word-break: break-all;
    line-height: 1.4;
    touch-action: none;
}

.selected-tag:hover {
    filter: brightness(1.05);
    transform: translateY(-2px);
}

.selected-tag.dragging {
    opacity: 0.5;
    transform: rotate(5deg);
}

.selected-tag .tag-text {
    font-weight: 500;
}

.selected-tag .remove-btn {
    width: 18px;
    height: 18px;
    background: rgba(255, 255, 255, 0.3);
    border: none;
    border-radius: 50%;
    color: #ffffff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    transition: all 0.2s;
    touch-action: manipulation;
}

.selected-tag .remove-btn:hover {
    background: rgba(255, 255, 255, 0.5);
    transform: scale(1.1);
}

.available-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
}

.available-tag {
    padding: 8px 16px;
    background: var(--theme-panel-strong);
    border: 2px solid transparent;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
    font-weight: 500;
    user-select: none;
}

.available-tag:hover {
    background: var(--theme-panel-bg);
    border-color: var(--theme-accent);
    transform: translateY(-2px);
}

.available-tag.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
}

.available-tag.disabled:hover {
    transform: none;
}

.drag-over {
    background: var(--theme-accent-soft) !important;
    border-color: var(--theme-accent) !important;
}

/* ============ 合并模式控件 ============ */
.merge-mode-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0;
}

.merge-mode-btn {
    padding: 6px 12px;
    background: var(--theme-panel-strong);
    border: 1px solid var(--theme-border);
    border-radius: 20px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: all 0.3s;
    color: var(--theme-muted);
}

.merge-mode-btn.active {
    background: var(--theme-accent-soft);
    border-color: var(--theme-accent);
    color: var(--theme-accent);
    font-weight: 500;
}

.staging-area {
    display: none;
    background: var(--theme-accent-soft);
    border: 2px dashed rgba(var(--app-primary-rgb), 0.25);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 15px;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    min-height: 52px;
    position: relative;
    transition: all 0.3s;
}

.staging-area.active {
    display: flex;
    animation: slideDown 0.3s var(--app-ease-smooth);
}

@keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
}

.staging-area::before {
    content: '合并组暂存区:';
    color: var(--theme-accent);
    font-size: 12px;
    font-weight: bold;
    margin-right: 5px;
}

.staging-tag {
    background: var(--theme-input-bg);
    color: var(--theme-accent);
    border: 1px solid rgba(var(--app-primary-rgb), 0.2);
    padding: 4px 10px;
    border-radius: 15px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 5px;
    cursor: move;
    user-select: none;
    max-width: 100%;
    word-break: break-all;
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
    font-weight: bold;
    font-size: 14px;
}

.staging-separator {
    color: var(--theme-muted);
    font-weight: bold;
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
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    transition: all 0.2s;
}

.confirm-merge-btn:hover {
    background: #459670;
    transform: scale(1.1);
}

.confirm-merge-btn:disabled {
    background: var(--theme-panel-strong);
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
}

/* ============ 映射表 ============ */
.map-container {
    margin-top: 10px;
}

.map-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid var(--theme-border);
    border-radius: 6px;
    background: var(--theme-panel-bg);
}

.map-input-left,
.map-input-right {
    flex: 1;
    padding: 8px;
    border: 1px solid var(--theme-border);
    border-radius: 4px;
    font-size: 13px;
}

.map-separator {
    font-weight: bold;
    color: var(--theme-muted);
}

.map-remove-btn {
    margin-left: 10px;
    padding: 6px 12px;
    font-size: 12px;
    transition: transform 0.22s var(--app-ease-smooth);
}
.map-remove-btn:hover {
    transform: rotate(90deg);
}

.map-item-template {
    display: none;
}

/* Read-only config fields in edit modal */
.readonly-field {
    width: 100%;
    padding: 10px 12px;
    background: var(--theme-panel-bg, #f5f6f8);
    border: 1px dashed var(--theme-border, #d5d7db);
    border-radius: 6px;
    color: var(--theme-text, #333);
    font-size: 14px;
    line-height: 1.5;
    word-break: break-word;
    white-space: pre-wrap;
    cursor: default;
    user-select: text;
}

.readonly-field:empty::before {
    content: '—';
    color: var(--theme-muted, #999);
}
`;
