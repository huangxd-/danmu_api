// language=CSS
export const baseCssContent = /* css */ `
/* 基础样式 */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #a0b9e8ff 0%, #e39db4ff 100%);
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
    background: linear-gradient(135deg, #1a2980 0%, #26d0ce 100%);
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
    flex-direction: column;
    align-items: flex-start;
    gap: 15px;
    flex-wrap: wrap;
}

.logo-title-container {
    display: flex;
    align-items: center;
    gap: 15px;
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
`;
