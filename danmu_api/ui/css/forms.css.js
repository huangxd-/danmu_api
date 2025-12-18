// language=CSS
export const formsCssContent = /* css */ `
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
    font-family: 'Courier New', Consolas, monospace;
    line-height: 1.5;
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
`;