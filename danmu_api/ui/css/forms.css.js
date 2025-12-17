// language=CSS
export const formsCssContent = /* css */ `
/* 表单样式 */
.form-group {
    margin-bottom: 15px;
}

.form-group label {
    display: block;
    margin-bottom: 5px;
    font-weight: bold;
    color: #33;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group select,
.form-group textarea {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
    transition: border-color 0.3s;
    box-sizing: border-box;
}

.form-group input[type="text"]:focus,
.form-group input[type="number"]:focus,
.form-group select:focus,
.form-group textarea:focus {
    outline: none;
    border-color: #4CAF50;
    box-shadow: 0 2px rgba(76, 175, 80, 0.2);
}

.form-group textarea {
    resize: vertical;
    min-height: 100px;
}

.form-help {
    margin-top: 5px;
    font-size: 12px;
    color: #666;
}

.api-selector {
    background: #f9f9f9;
    padding: 15px;
    border-radius: 8px;
    margin-bottom: 20px;
}

.api-params {
    background: #f8f9fa;
    padding: 20px;
    border-radius: 8px;
    margin-top: 15px;
    color: #333;
}

.api-response {
    background: #1e1e1e;
    color: #d4d4d4;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 15px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.4;
}

.api-response.xml {
    background: #1e1e1e;
    color: #d4d4d4;
    font-family: 'Courier New', monospace;
    white-space: pre;
}

.json-response {
    background: #1e1e1e;
    color: #d4d4d4;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 15px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    line-height: 1.4;
}

.error-response {
    background: #1e1e1e;
    border: 1px solid #f44336;
    color: #e57373; /* 使用日志查看中的错误颜色 */
    padding: 15px;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    white-space: pre-wrap;
    word-wrap: break-word;
    border-left: 4px solid #dc3545;
}

/* 参数和请求体部分样式 */
.params-section, .body-section {
    margin-bottom: 20px;
    padding: 15px;
    background: #f8f9fa;
    border-radius: 6px;
    border: 1px solid #e0e0e0;
    color: #333;
}

.params-section h4, .body-section h4 {
    margin-top: 0;
    margin-bottom: 15px;
    padding-bottom: 8px;
    border-bottom: 1px solid #eee;
    color: #444;
    font-size: 16px;
}

.body-section textarea {
    font-family: 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
}

/* JSON高亮样式 */
.json-key {
    color: #922B2B;
}

.json-string {
    color: #2A7E38;
}

.json-number {
    color: #1F5C9A;
}

.json-boolean {
    color: #D67B00;
}

.json-null {
    color: #800080;
}

/* 响应格式切换按钮样式 */
.response-format-buttons {
    margin-bottom: 10px;
}

.response-format-buttons button {
    margin-right: 10px;
    padding: 5px 10px;
    border: 1px solid #ddd;
    background: #f5f5f5;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.3s;
    color: #333;
}

.response-format-buttons button.active {
    background: #4CAF50;
    color: white;
    border-color: #4CAF50;
}

.response-format-buttons button:hover {
    background: #e0e0;
}

/* 代码块样式 */
pre {
    margin: 0;
    padding: 10px;
    background: #f8f9fa;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
}

/* 高亮文本 */
.highlight {
    background: #fff3cd;
    padding: 2px 4px;
    border-radius: 3px;
    font-weight: bold;
}
`;
