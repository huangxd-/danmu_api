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
`;
