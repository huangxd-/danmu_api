// language=CSS
export const cssContent = /* css */ `
/* 基础样式 */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    padding: 20px;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    background: white;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    overflow: hidden;
}

.header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 15px;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 15px;
    flex-wrap: wrap;
}

.logo {
    width: 50px;
    height: 50px;
    background: white;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    overflow: hidden;                /* 关键：防止溢出 */
}

.logo img {
    width: 100%;                     /* 或 90% 留点内边距更好看 */
    height: 100%;
    object-fit: cover;               /* 图片会被裁剪成正方形，充满容器 */
    /* object-fit: contain;          /* 如果想完整显示图片（会留白）就用这个 */
    border-radius: 12px;             /* 让图片也跟随圆角 */
}

.header-info {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.header h1 {
    font-size: 24px;
    margin: 0;
}

.version-info {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    opacity: 0.95;
}

.version-badge {
    background: rgba(255,255,255,0.2);
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 500;
}

.update-badge {
    background: #ffd700;
    color: #333;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 500;
    animation: pulse 2s infinite;
    cursor: pointer;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
}

.content {
    padding: 20px;
}

.section {
    display: none;
}

.section.active {
    display: block;
    animation: fadeIn 0.3s;
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}

/* footer 样式 */
.footer {
    padding: 20px;
    background: transparent;
    text-align: center;
    font-size: 14px;
}

/* footer 文字样式 */
.footer-text {
    color: #ffeb3b;
    margin: 10px 0;
}

/* footer 链接样式 */
.footer-links {
    margin: 10px 0;
}

.footer-link {
    margin: 0 10px;
    text-decoration: none;
    color: #ffc107;
}

.footer-link:hover {
    color: #ffeb3b;  /* 可选，增加 hover 效果 */
}

/* GitHub 链接特定样式 */
.github-link {
    display: inline-flex;
    align-items: center;
}

.github-icon {
    width: 14px;
    vertical-align: middle;
    margin-right: 5px;
}

/* 组件样式 */
.nav-buttons {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.nav-btn {
    padding: 8px 16px;
    background: rgba(255,255,255,0.2);
    border: 1px solid rgba(255,255,255,0.3);
    color: white;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
}

.nav-btn:hover {
    background: rgba(255,255,255,0.3);
}

.nav-btn.active {
    background: white;
    color: #667eea;
}

/* 环境变量样式 */
.env-categories {
    display: flex;
    gap: 10px;
    margin-bottom: 20px;
    flex-wrap: wrap;
}

.category-btn {
    padding: 10px 20px;
    background: #f0f0f0;
    border: 2px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.3s;
}

.category-btn.active {
    background: #667eea;
    color: white;
    border-color: #667eea;
}

.env-list {
    margin-bottom: 20px;
}

.env-item {
    background: #f8f9fa;
    padding: 15px;
    margin-bottom: 10px;
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
}

.env-info {
    flex: 1;
    min-width: 200px;
}

.env-info strong {
    color: #667eea;
    display: block;
    margin-bottom: 5px;
}

.env-actions {
    display: flex;
    gap: 8px;
}

/* 按钮样式 */
.btn {
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    transition: all 0.3s;
}

.btn-primary {
    background: #667eea;
    color: white;
}

.btn-primary:hover {
    background: #5568d3;
}

.btn-success {
    background: #28a745;
    color: white;
    position: relative;
    overflow: hidden;
}

.btn-success:hover {
    background: #218838;
}

.btn-success::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    border-radius: 50%;
    background: rgba(255,255,255,0.3);
    transform: translate(-50%, -50%);
    transition: width 0.6s, height 0.6s;
}

.btn-success:active::before {
    width: 300px;
    height: 300px;
}

.btn-danger {
    background: #dc3545;
    color: white;
}

.btn-danger:hover {
    background: #c82333;
}

/* 预览区域 */
.preview-area {
    background: #f8f9fa;
    padding: 20px;
    border-radius: 8px;
    margin-top: 20px;
}

.preview-item {
    padding: 10px;
    background: white;
    margin-bottom: 8px;
    border-radius: 6px;
    border-left: 4px solid #667eea;
}

/* 日志样式 */
.log-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
    flex-wrap: wrap;
    gap: 10px;
}

.log-container {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 15px;
    border-radius: 8px;
    max-height: 500px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.6;
}

.log-entry {
    margin-bottom: 8px;
    padding: 5px;
    border-radius: 4px;
}

.log-entry.info { color: #4fc3f7; }
.log-entry.warn { color: #ffb74d; }
.log-entry.error { color: #e57373; }
.log-entry.success { color: #81c784; }

/* API调试样式 */
.api-selector {
    margin-bottom: 20px;
}

.api-params {
    background: #f8f9fa;
    padding: 20px;
    border-radius: 8px;
    margin-bottom: 20px;
}

.api-response {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 15px;
    border-radius: 8px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    white-space: pre-wrap;
}

/* 模态框 */
.modal {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 1000;
    padding: 20px;
    overflow-y: auto;
}

.modal.active {
    display: flex;
    justify-content: center;
    align-items: center;
}

.modal-content {
    background: white;
    padding: 30px;
    border-radius: 12px;
    max-width: 500px;
    width: 100%;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
}

.modal-header h3 {
    color: #667eea;
}

.close-btn {
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: #999;
}

.close-btn:hover {
    color: #333;
}

/* 值类型标识 */
.value-type-badge {
    display: inline-block;
    padding: 2px 8px;
    background: #667eea;
    color: white;
    border-radius: 12px;
    font-size: 11px;
    margin-left: 8px;
}

.value-type-badge.multi {
    background: #ff6b6b;
}

/* 进度条 */
.progress-container {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: rgba(0,0,0,0.1);
    z-index: 9999;
    display: none;
}

.progress-container.active {
    display: block;
}

.progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #667eea, #764ba2);
    width: 0;
    transition: width 0.3s;
    box-shadow: 0 0 10px rgba(102, 126, 234, 0.5);
}

/* 加载提示 */
.loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.7);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: 9998;
}

.loading-overlay.active {
    display: flex;
}

.loading-content {
    background: white;
    padding: 40px;
    border-radius: 12px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    max-width: 400px;
}

.loading-spinner {
    width: 60px;
    height: 60px;
    border: 5px solid #f3f3f3;
    border-top: 5px solid #667eea;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin: 0 auto 20px;
}

@keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

.loading-text {
    font-size: 18px;
    color: #333;
    font-weight: 500;
    margin-bottom: 10px;
}

.loading-detail {
    font-size: 14px;
    color: #666;
}

/* 表单样式 */
.form-group {
    margin-bottom: 15px;
}

.form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: 500;
    color: #333;
}

.form-group input,
.form-group select,
.form-group textarea {
    width: 100%;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;
}

.form-group textarea {
    resize: vertical;
    min-height: 80px;
}

/* 开关按钮 */
.switch-container {
    display: flex;
    align-items: center;
    gap: 10px;
}

.switch {
    position: relative;
    display: inline-block;
    width: 50px;
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
    background-color: #ccc;
    transition: .4s;
    border-radius: 26px;
}

.slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 4px;
    bottom: 4px;
    background-color: white;
    transition: .4s;
    border-radius: 50%;
}

input:checked + .slider {
    background-color: #667eea;
}

input:checked + .slider:before {
    transform: translateX(24px);
}

.switch-label {
    font-weight: 500;
    color: #333;
}

/* 数字滚轮 */
.number-picker {
    display: flex;
    align-items: center;
    gap: 15px;
    background: #f8f9fa;
    padding: 15px;
    border-radius: 8px;
}

.number-display {
    font-size: 32px;
    font-weight: bold;
    color: #667eea;
    min-width: 60px;
    text-align: center;
}

.number-controls {
    display: flex;
    flex-direction: column;
    gap: 5px;
}

.number-btn {
    width: 40px;
    height: 40px;
    border: 2px solid #667eea;
    background: white;
    color: #667eea;
    border-radius: 8px;
    cursor: pointer;
    font-size: 20px;
    font-weight: bold;
    transition: all 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
}

.number-btn:hover {
    background: #667eea;
    color: white;
}

.number-btn:active {
    transform: scale(0.95);
}

.number-range {
    width: 100%;
    margin-top: 10px;
}

.number-range input[type="range"] {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: #ddd;
    outline: none;
    -webkit-appearance: none;
}

.number-range input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
}

.number-range input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #667eea;
    cursor: pointer;
    border: none;
}

/* 标签选择 */
.tag-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.tag-option {
    padding: 10px 20px;
    background: #f0f0f0;
    border: 2px solid transparent;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
    font-weight: 500;
}

.tag-option:hover {
    background: #e0e0e0;
}

.tag-option.selected {
    background: #667eea;
    color: white;
    border-color: #667eea;
}

.tag-option.selected:hover {
    background: #5568d3;
}

/* 多选标签 */
.multi-select-container {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.selected-tags {
    min-height: 60px;
    background: #f8f9fa;
    border: 2px dashed #ddd;
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
}

.selected-tags.empty::before {
    content: '拖动或点击下方选项添加...';
    color: #999;
    font-size: 14px;
    width: 100%;
    text-align: center;
    padding: 15px 0;
}

.selected-tag {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #667eea;
    color: white;
    padding: 8px 12px;
    border-radius: 20px;
    cursor: move;
    user-select: none;
    transition: all 0.3s;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.selected-tag:hover {
    background: #5568d3;
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
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
    background: rgba(255,255,255,0.3);
    border: none;
    border-radius: 50%;
    color: white;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    transition: all 0.2s;
}

.selected-tag .remove-btn:hover {
    background: rgba(255,255,255,0.5);
    transform: scale(1.1);
}

.available-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.available-tag {
    padding: 8px 16px;
    background: #f0f0f0;
    border: 2px solid transparent;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
    font-size: 14px;
    font-weight: 500;
    user-select: none;
}

.available-tag:hover {
    background: #e0e0e0;
    transform: translateY(-2px);
}

.available-tag.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: #f8f9fa;
}

.available-tag.disabled:hover {
    transform: none;
}

.drag-over {
    background: #e8eaf6 !important;
    border-color: #667eea !important;
}

/* 响应式样式 */
@media (max-width: 768px) {
    .logo {
        width: 40px;
        height: 40px;
        font-size: 22px;
    }

    .header-left {
        width: 100%;
    }

    .header h1 {
        font-size: 18px;
    }

    .version-info {
        font-size: 11px;
        flex-wrap: wrap;
    }

    .nav-buttons {
        width: 100%;
    }

    .nav-btn {
        flex: 1;
        text-align: center;
        font-size: 12px;
        padding: 8px 10px;
    }

    .env-item {
        flex-direction: column;
        align-items: flex-start;
    }

    .env-actions {
        width: 100%;
    }

    .btn {
        flex: 1;
    }
}
`;