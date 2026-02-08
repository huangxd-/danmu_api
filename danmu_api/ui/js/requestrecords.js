// language=JavaScript
export const requestRecordsJsContent = /* javascript */ `
// 请求记录相关功能
async function renderRequestRecords() {
    const recordsContainer = document.getElementById('request-records-list');
    if (!recordsContainer) {
        console.error('未找到请求记录容器');
        return;
    }

    try {
        // 从API获取请求记录
        const response = await fetch(buildApiUrl('/api/reqrecords'));
        if (!response.ok) {
            throw new Error('获取请求记录失败');
        }
        
        const data = await response.json();
        const records = data.records;
        const todayReqNum = data.todayReqNum;

        // 显示今日请求总数
        const totalRequestsElement = document.getElementById('total-requests-today');
        if (totalRequestsElement) {
            totalRequestsElement.textContent = \`今日请求总数: \${todayReqNum}\`;
        }

        if (records.length === 0) {
            recordsContainer.innerHTML = '<div class="no-records">暂无请求记录</div>';
            return;
        }

        // 生成记录HTML
        const recordsHtml = records.map(record => {
            const interfaceName = decodeURIComponent(record.interface) || '未知接口';
            const params = record.params || {};
            const timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString('zh-CN') : '未知时间';
            const method = record.method || 'GET';
            const clientIp = record.clientIp || '未知IP';

            // 格式化参数显示
            const hasParams = Object.keys(params).length > 0;
            const paramsHtml = hasParams 
                ? \`<div class="record-params">
                    <div class="record-params-title">请求参数</div>
                    <pre>\${JSON.stringify(params, null, 2)}</pre>
                   </div>\` 
                : '';

            // 如果没有参数，给时间戳添加 no-params 类以隐藏虚线
            const timestampClass = hasParams ? 'record-timestamp' : 'record-timestamp no-params';

            return \`
            <div class="record-item">
                <div class="record-header">
                    <div class="record-method">\${method}</div>
                    <div class="record-interface">\${interfaceName}</div>
                    <div class="record-ip">\${clientIp}</div>
                </div>
                <div class="\${timestampClass}">\${timestamp}</div>
                \${paramsHtml}
            </div>\`;
        }).join('');

        recordsContainer.innerHTML = recordsHtml;
    } catch (error) {
        console.error('获取请求记录时出错:', error);
        recordsContainer.innerHTML = '<div class="no-records">获取请求记录失败: ' + error.message + '</div>';
    }
}

// 初始化请求记录界面
function initRequestRecordsInterface() {
    // 确保在切换到请求记录标签页时也更新记录
    const originalSwitchSection = window.switchSection;
    if (originalSwitchSection && typeof originalSwitchSection === 'function') {
        window.switchSection = function(section, event = null) {
            // 调用原函数
            originalSwitchSection(section, event);
            
            // 如果切换到请求记录页面，则刷新记录
            if (section === 'request-records') {
                setTimeout(renderRequestRecords, 100);
            }
        };
    }

    // 首次初始化
    if (document.getElementById('request-records-section') && 
        document.querySelector('.nav-btn[data-section="request-records"]') &&
        document.querySelector('.nav-btn[data-section="request-records"]').classList.contains('active')) {
        renderRequestRecords();
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    if (typeof initRequestRecordsInterface === 'function') {
        initRequestRecordsInterface();
    }
    
    // 添加刷新按钮功能
    const refreshBtn = document.getElementById('refresh-request-records');
    if (refreshBtn) {
        refreshBtn.onclick = function() {
            renderRequestRecords();
        };
    }

});
`;