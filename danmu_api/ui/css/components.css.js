// language=CSS
export const componentsCssContent = /* css */ `
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
    color: #1a2980;
    font-weight: bold;
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

.env-item .env-info {
    flex: 1;
    min-width: 200px;
    word-break: break-word;
    overflow-wrap: break-word;
    word-wrap: break-word;
}

.env-item .env-info strong {
    color: #667eea;
    display: block;
    margin-bottom: 5px;
    word-break: break-all;
}

.env-item .env-info > div.text-dark-gray {
    word-break: break-all;
    white-space: normal;
    background-color: #f1f3f5;
    padding: 8px;
    border-radius: 4px;
    font-family: monospace;
    margin-bottom: 5px;
}

.env-item .env-info span {
    word-break: break-all;
    white-space: normal;
}

.env-item .env-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
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
    word-break: break-word;
    overflow-wrap: break-word;
    word-wrap: break-word;
}

.preview-item .preview-item-content {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
}

.preview-item .preview-key {
    font-weight: bold;
    color: #67eea;
    align-self: flex-start;
}

.preview-item .preview-value {
    word-break: break-all;
    white-space: normal;
    width: 100%;
    background-color: #f8f9fa;
    padding: 8px;
    border-radius: 4px;
    font-family: monospace;
    color: #333; /* 更黑的字体颜色 */
    font-weight: bold; /* 加粗显示 */
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

@keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(40, 167, 69, 0.5); }
    70% { box-shadow: 0 0 0 10px rgba(40, 167, 69, 0); }
    100% { box-shadow: 0 0 0 0 rgba(40, 167, 69, 0); }
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



/* 表单帮助文本 */
.form-help {
    font-size: 12px;
    color: #666;
    margin-top: 5px;
    font-style: italic;
}

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

/* XML响应样式 */
.api-response.xml {
    color: #88ccff;
}

/* JSON高亮样式 */
.json-response {
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

.json-response .key {
    color: #9cdcfe;
}

.json-response .string {
    color: #ce9178;
}

.json-response .number {
    color: #b5cea8;
}

.json-response .boolean {
    color: #569cd6;
}

.json-response .null {
    color: #569cd6;
}

.json-response .undefined {
    color: #569cd6;
}

.error-response {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 15px;
    border-radius: 8px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    white-space: pre-wrap;
    border-left: 4px solid #dc3545;
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
    max-width: 600px;
    width: 100%;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    position: relative;
    top: 0;
    left: 0;
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 25px;
    padding-bottom: 15px;
    border-bottom: 1px solid #eee;
}

.modal-header h3 {
    color: #667eea;
    margin: 0;
}

.modal-body {
    margin-bottom: 25px;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 15px;
    border-top: 1px solid #eee;
}

.confirmation-list {
    padding-left: 20px;
    margin: 0;
    list-style: none;
}

.confirmation-list li {
    position: relative;
    padding-left: 10px;
    margin: 8px 0;
}

.confirmation-list li::before {
    content: "•";
    position: absolute;
    left: 0;
    color: #667eea;
    font-size: 16px;
}

.warning-box {
    background: #fff3cd;
    border-left: 4px solid #ffc107;
    padding: 15px;
    border-radius: 6px;
    margin-top: 15px;
    margin-bottom: 20px;
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 25px;
    padding-bottom: 15px;
    border-bottom: 1px solid #eee;
}

.modal-header h3 {
    color: #667eea;
    margin: 0;
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

/* 确认模态框样式 */
.confirmation-list {
    padding-left: 20px;
    margin: 0;
    list-style: none;
}

.confirmation-list li {
    position: relative;
    padding-left: 10px;
    margin: 8px 0;
}

.confirmation-list li::before {
    content: "•";
    position: absolute;
    left: 0;
    color: #667eea;
    font-size: 16px;
}

.warning-box {
    background: #fff3cd;
    border-left: 4px solid #ffc107;
    padding: 15px;
    border-radius: 6px;
    margin-top: 15px;
    margin-bottom: 20px;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 25px;
    padding-top: 15px;
    border-top: 1px solid #eee;
}

.value-type-badge.multi {
    background: #ff6b6b;
}

.value-type-badge.map {
    background: #9b59b6;
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

.loading-spinner-small {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid #ffffff;
    border-top: 2px solid #667eea;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
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

/* 通用内联样式类 */
.text-center {
    text-align: center;
}

.text-gray {
    color: #bbb; /* 更淡的字体颜色 */
}

.text-red {
    color: #e74c3c;
}

.text-dark-gray {
    color: #333; /* 更黑的字体颜色 */
    font-weight: bold; /* 加粗显示 */
}

.text-purple {
    color: #67eea;
}

.text-yellow-gold {
    color: #ffd700;
}

.padding-20 {
    padding: 20px;
}

.margin-bottom-10 {
    margin-bottom: 10px;
}

.margin-top-3 {
    margin-top: 3px;
}

.margin-top-15 {
    margin-top: 15px;
}

.font-size-12 {
    font-size: 12px;
}

.margin-bottom-15 {
    margin-bottom: 15px;
}

.text-monospace {
    font-family: monospace;
}

/* 推送弹幕相关样式 */
.anime-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 10px;
    margin-top: 15px;
}

.anime-item {
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 8px;
    text-align: center;
    cursor: pointer;
}

.anime-item-img {
    width: 100%;
    height: 150px;
    object-fit: cover;
    border-radius: 4px;
}

.anime-title {
    margin: 8px 0 5px;
    font-size: 12px;
}

.episode-list-container {
    max-height: 400px;
    overflow-y: auto;
}

.episode-item {
    padding: 10px;
    border-bottom: 1px solid #eee;
}

.episode-item-content {
    display: inline-block;
    width: calc(100% - 100px);
    vertical-align: middle;
}

.episode-push-btn {
    width: 80px;
    display: inline-block;
    margin-left: 10px;
}

/* Bilibili Cookie 编辑器样式 */
.bili-cookie-editor {
    display: flex;
    flex-direction: column;
    gap: 15px;
}

.bili-cookie-status {
    background: #f8f9fa;
    padding: 12px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 10px;
    border-left: 4px solid #667eea;
}

.bili-status-icon {
    font-size: 18px;
}

.bili-status-text {
    flex: 1;
    font-weight: 500;
}

.bili-cookie-actions {
    display: flex;
    gap: 10px;
}

.btn-sm {
    padding: 6px 12px;
    font-size: 13px;
}

/* 移动端适配 */
@media (max-width: 768px) {
    .bili-cookie-actions {
        flex-direction: column;
    }
    
    .bili-cookie-actions .btn {
        width: 100%;
    }
}

/* 多选标签与合并模式相关样式 */
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
    
    max-width: 100%;
    height: auto;
    white-space: normal;
    word-break: break-all;
    line-height: 1.4;
}

.merge-mode-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 10px 0;
}

.merge-mode-btn {
    padding: 6px 12px;
    background: #f8f9fa;
    border: 1px solid #ddd;
    border-radius: 20px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: all 0.3s;
    color: #666;
}

.merge-mode-btn.active {
    background: #e3f2fd;
    border-color: #2196f3;
    color: #2196f3;
    font-weight: 500;
}

.staging-area {
    display: none;
    background: #e3f2fd;
    border: 2px dashed #90caf9;
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
    animation: slideDown 0.3s;
}

@keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
}

.staging-area::before {
    content: '合并组暂存区:';
    color: #1976d2;
    font-size: 12px;
    font-weight: bold;
    margin-right: 5px;
}

.staging-tag {
    background: white;
    color: #1976d2;
    border: 1px solid #bbdefb;
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
    background: #bbdefb;
    border-color: #2196f3;
    transform: scale(1.05);
}

.staging-tag.dragging {
    opacity: 0.5;
    transform: scale(0.95);
    background: #e3f2fd;
}

.staging-tag .remove-btn {
    color: #ef5350;
    cursor: pointer;
    font-weight: bold;
    font-size: 14px;
}

.staging-separator {
    color: #999;
    font-weight: bold;
}

.confirm-merge-btn {
    margin-left: auto;
    background: #4caf50;
    color: white;
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
    background: #43a047;
    transform: scale(1.1);
}

.confirm-merge-btn:disabled {
    background: #ccc;
    cursor: not-allowed;
    transform: none;
}

.available-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}

.available-tag {
    padding: 6px 12px;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
    user-select: none;
}

.available-tag:hover {
    background: #f0f0f0;
    border-color: #bbb;
}

.available-tag.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background: #f5f5f5;
    color: #aaa;
    pointer-events: none;
    border-color: #eee;
    box-shadow: none;
}

/* 请求记录样式 */
.request-records-container {
    border-radius: 8px;
}

.no-records {
    text-align: center;
    color: #fff;
    padding: 60px;
    font-style: italic;
    font-size: 16px;
}

.record-item {
    background: linear-gradient(145deg, #ffffff 0%, #f8f9fa 100%);
    border: none;
    border-radius: 16px;
    padding: 10px;
    margin-bottom: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.15);
    transition: transform 0.2s, box-shadow 0.2s;
}

.record-item:hover {
    transform: translateY(-2px);
    box-shadow: 0 12px 40px rgba(0,0,0,0.2);
}

.record-header {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    margin-bottom: 15px;
    flex-wrap: wrap;
    gap: 15px;
}

.record-method {
    background: linear-gradient(135deg, #00b4db 0%, #0083b0 100%);
    color: white;
    padding: 8px 16px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: bold;
    min-width: 60px;
    text-align: center;
    box-shadow: 0 4px 15px rgba(0,180,219,0.3);
}

.record-interface {
    flex: 1;
    font-family: 'Courier New', monospace;
    font-weight: 600;
    color: #2d3748;
    word-break: break-all;
    font-size: 15px;
    background: #edf2f7;
    padding: 8px 16px;
    border-radius: 8px;
}

.record-ip {
    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
    color: white;
    padding: 8px 16px;
    border-radius: 10px;
    font-size: 13px;
    min-width: 120px;
    text-align: center;
    font-weight: 500;
    box-shadow: 0 4px 15px rgba(245,87,108,0.3);
}

.record-timestamp {
    color: #718096;
    font-size: 14px;
    margin-bottom: 15px;
    padding-bottom: 15px;
    border-bottom: 2px dashed #e2e8f0;
    display: flex;
    align-items: center;
    gap: 8px;
}

.record-timestamp.no-params {
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
}

.record-timestamp::before {
    content: '🕐';
    font-size: 16px;
}

.record-params {
    background: #f5f5f5;
    border-radius: 12px;
    padding: 15px;
    border: 1px solid #e0e0e0;
}

.record-params-title {
    color: #667eea;
    font-weight: 600;
    font-size: 14px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

.record-params-title::before {
    content: '📋';
    font-size: 16px;
}

.record-params pre {
    margin: 0;
    padding: 15px;
    background: #ffffff;
    color: #333;
    border-radius: 8px;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-x: auto;
    line-height: 1.6;
    border: 1px solid #ddd;
}

/* 请求记录移动端适配 */
@media (max-width: 768px) {
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
`;
