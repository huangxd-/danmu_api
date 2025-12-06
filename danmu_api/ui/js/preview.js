// language=JavaScript
export const previewJsContent = /* javascript */ `
// 渲染配置预览
function renderPreview() {
    const preview = document.getElementById('preview-area');
    
    // 从API获取真实配置数据
    fetch('/api/config')
        .then(response => response.json())
        .then(config => {
            // 使用从API获取的分类环境变量
            const categorizedVars = config.categorizedEnvVars || {};
            
            // 渲染预览内容
            let html = '';
            
            Object.keys(categorizedVars).forEach(category => {
                const items = categorizedVars[category];
                if (items && items.length > 0) {
                    html += \`<h3 class="text-purple margin-bottom-10">\${getCategoryName(category)}</h3>\`;
                    items.forEach(item => {
                        html += \`
                            <div class="preview-item">
                                <div class="preview-item-content">
                                    <div class="preview-key"><strong>\${item.key}</strong></div>
                                    <div class="preview-value">\${item.value}</div>
                                </div>
                                \${item.description ? \`<div class="text-gray font-size-12 margin-top-3">\${item.description}</div>\` : ''}
                            </div>
                        \`;
                    });
                }
            });
            
            preview.innerHTML = html || '<p class="text-gray">暂无配置</p>';
        })
        .catch(error => {
            console.error('Failed to load config for preview:', error);
            preview.innerHTML = '<p class="text-red">加载配置失败: ' + error.message + '</p>';
        });
}

// 获取类别名称
function getCategoryName(category) {
    const names = {
        api: '🔗 API配置',
        source: '📜 源配置',
        match: '🔍 匹配配置',
        danmu: '🔣 弹幕配置',
        cache: '💾 缓存配置',
        system: '⚙️ 系统配置'
    };
    return names[category] || category;
}
`;
