// language=CSS
export const formsCssContent = /* css */ `
/* 表单样式 */
.form-group {
    margin-bottom: 20px;
}

.form-group label {
    display: block;
    margin-bottom: 8px;
    font-weight: bold;
    color: #333;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group textarea,
.form-group select {
    width: 100%;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;
    transition: border-color 0.3s;
    box-sizing: border-box;
}

.form-group input[type="text"]:focus,
.form-group input[type="number"]:focus,
.form-group textarea:focus,
.form-group select:focus {
    outline: none;
    border-color: #667eea;
    box-shadow: 0 0 2px rgba(102, 126, 234, 0.2);
}

.form-group textarea {
    resize: vertical;
    min-height: 100px;
}

/* 布尔开关样式 */
.switch-container {
    display: flex;
    align-items: center;
    gap: 10px;
}

.switch {
    position: relative;
    display: inline-block;
    width: 50px;
    height: 24px;
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
    border-radius: 24px;
}

.slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    transition: .4s;
    border-radius: 50%;
}

input:checked + .slider {
    background-color: #667eea;
}

input:checked + .slider:before {
    transform: translateX(26px);
}

.switch-label {
    font-weight: bold;
    color: #33;
}

/* 数字选择器样式 */
.number-picker {
    display: flex;
    align-items: center;
    gap: 10px;
}

.number-controls {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.number-btn {
    width: 30px;
    height: 20px;
    padding: 0;
    background: #f0f0f0;
    border: 1px solid #ddd;
    cursor: pointer;
    font-size: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.number-btn:hover {
    background: #e0e0e0;
}

.number-display {
    font-size: 18px;
    font-weight: bold;
    min-width: 40px;
    text-align: center;
    padding: 5px;
}

.number-range {
    margin-top: 10px;
}

.number-range input[type="range"] {
    width: 100%;
}

/* 标签选择器样式 */
.tag-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
}

.tag-option {
    padding: 8px 16px;
    background: #f0f0f0;
    border: 1px solid #ddd;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
}

.tag-option:hover {
    background: #e0e0e0;
}

.tag-option.selected {
    background: #667eea;
    color: white;
    border-color: #667eea;
}

/* 多选标签容器样式 */
.multi-select-container {
    margin-top: 10px;
}

.selected-tags {
    min-height: 40px;
    border: 1px solid #ddd;
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 10px;
    background-color: #f9f9f9;
    transition: all 0.3s;
}

.selected-tags.empty {
    border-style: dashed;
    color: #99;
    min-height: 40px;
}

.selected-tags.drag-over {
    border-color: #667eea;
    background-color: #f0f4ff;
}

.selected-tag {
    display: inline-flex;
    align-items: center;
    padding: 5px 10px;
    margin: 5px;
    background: #667eea;
    color: white;
    border-radius: 20px;
    cursor: move;
    transition: all 0.3s;
}

.selected-tag.dragging {
    opacity: 0.5;
    transform: rotate(5deg);
}

.tag-text {
    margin-right: 5px;
}

.remove-btn {
    background: none;
    border: none;
    color: white;
    cursor: pointer;
    font-size: 16px;
    padding: 0;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
}

.remove-btn:hover {
    background: rgba(255, 255, 255, 0.2);
}

.available-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 10px;
}

.available-tag {
    padding: 8px 16px;
    background: #f0f0;
    border: 1px solid #ddd;
    border-radius: 20px;
    cursor: pointer;
    transition: all 0.3s;
}

.available-tag:hover:not(.disabled) {
    background: #e0e0e0;
}

.available-tag.disabled {
    background: #e0e0e0;
    color: #999;
    cursor: not-allowed;
    opacity: 0.6;
}

/* 映射表样式 */
.map-container {
    margin-top: 10px;
}

.map-item {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 6px;
    background-color: #f9f9f9;
}

.map-input-left, .map-input-right {
    flex: 1;
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
}

.map-separator {
    font-weight: bold;
    color: #666;
}

.map-remove-btn {
    margin-left: 10px;
    padding: 6px 12px;
    font-size: 12px;
}

.map-item-template {
    display: none;
}

/* 必填标记 */
.form-group label:after {
    content: " *";
    color: #e74c3c;
}

/* 表单帮助文本 */
.form-help {
    font-size: 12px;
    color: #666;
    margin-top: 5px;
    font-style: italic;
}
`;
