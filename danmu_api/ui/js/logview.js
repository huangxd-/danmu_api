// language=JavaScript
export const logviewJsContent = /* javascript */ `
// 日志相关
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    logs.push({ timestamp, message, type });
    if (logs.length > 100) logs.shift();
    renderLogs();
}

function renderLogs() {
    const container = document.getElementById('log-container');
    container.innerHTML = logs.map(log =>
        \`<div class="log-entry \${log.type}">[\${log.timestamp}] \${log.message}</div>\`
    ).join('');
    container.scrollTop = container.scrollHeight;
}

// 从API获取真实日志数据
async function fetchRealLogs() {
    try {
        // 日志查看使用普通token访问，不需要admin token
        const response = await fetch(buildApiUrl('/api/logs')); // 不使用admin token
        if (!response.ok) {
            throw new Error(\`HTTP error! status: \${response.status}\`);
        }
        const logText = await response.text();
        // 解析日志文本为数组
        const logLines = logText.split('\\n').filter(line => line.trim() !== '');
        // 转换为logs数组格式
        logs = logLines.map(line => {
            // 解析日志行，提取时间戳、级别和消息
            const match = line.match(/\\[([^\\]]+)\\] (\\w+): (.*)/);
            if (match) {
                return {
                    timestamp: match[1],
                    type: match[2],
                    message: match[3]
                };
            }
            // 如果无法解析，返回原始行
            return {
                timestamp: new Date().toLocaleTimeString(),
                type: 'info',
                message: line
            };
        });
        renderLogs();
    } catch (error) {
        console.error('Failed to fetch logs:', error);
        addLog(\`获取日志失败: \${error.message}\`, 'error');
    }
}

function refreshLogs() {
    // 从API获取真实日志数据
    fetchRealLogs();
}

async function clearLogs() {
    // 检查部署平台配置
    const configCheck = await checkDeployPlatformConfig();
    if (!configCheck.success) {
        customAlert(configCheck.message);
        return;
    }

    customConfirm('确定要清空所有日志吗?', '清空确认').then(async confirmed => {
        if (confirmed) {
            try {
                const response = await fetch(buildApiUrl('/api/logs/clear', true), { // 使用admin token
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(\`HTTP error! status: \${response.status}\`);
                }
                
                const result = await response.json();
                if (result.success) {
                    // 清空前端显示的日志
                    logs = [];
                    renderLogs();
                    addLog('日志已清空', 'warn');
                } else {
                    addLog(\`清空日志失败: \${result.message}\`, 'error');
                }
            } catch (error) {
                console.error('Failed to clear logs:', error);
                addLog(\`清空日志失败: \${error.message}\`, 'error');
            }
        }
    });
}

// JSON高亮函数
function highlightJSON(obj) {
    let json = JSON.stringify(obj, null, 2);
    // 转义HTML特殊字符
    json = json.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    
    // 高亮JSON语法
    return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
        let cls = 'number';
        if (/^"/.test(match)) {
            if (/:$/.test(match)) {
                cls = 'key';
            } else {
                cls = 'string';
            }
        } else if (/true|false/.test(match)) {
            cls = 'boolean';
        } else if (/null/.test(match)) {
            cls = 'null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
    });
}
`;
