// language=JavaScript
export const logviewJsContent = /* javascript */ `
// 日志全局过滤状态
let currentLogFilter = 'ALL';

// 获取日志的严格归属分类
function getLogCategory(message) {
    // 匹配行首的连续方括号标签 (需双重转义)
    const prefixMatch = message.match(/^(?:\\s*\\[[^\\]]+\\])+/);
    if (!prefixMatch) {
        // 无标签行作为续行继承上一行的分类
        return '_inherit_';
    }
    
    const tags = prefixMatch[0].match(/\\[([^\\]]+)\\]/g).map(t => t.replace(/[\\[\\]]/g, '').trim());
    
    // 归类合并工具日志
    // 只要行首包含 Merge，或者包含合并映射独有的子标签，强行将其收束至 Merge 专属分类
    if (tags.some(t => t.toLowerCase() === 'merge' || ['匹配', '落单', '补全', '合集', '略过', 'Merge-Check'].some(key => t.includes(key)))) {
        return 'merge';
    }
    
    // 排除时间戳和底层无意义标签，抓取真正的业务源
    const validTags = tags.filter(t => 
        !/^\\d{4}-\\d{2}-\\d{2}[T ]/.test(t) && // 排除 ISO 时间戳格式（YYYY-MM-DDTHH:MM:SS）
        !/^\\d{2}:\\d{2}(:\\d{2})?$/.test(t) &&  // 排除 HH:MM:SS 时间格式（JSON 续行）
        !t.includes('08:00') &&
        t !== '请求模拟' && 
        t !== '网络请求'
    );
    
    if (validTags.length === 0) {
        // 全部标签被时间戳等过滤规则排除，作为续行继承上一行的分类
        return '_inherit_';
    }
    
    // 统一转换为小写，确保大小写变体(如 Bahamut 和 bahamut)收束至同一内部标识符
    let category = validTags[0].toLowerCase();
    
    // 标签归一化：将变体标签映射到标准分类
    const normalizationMap = {
        'vod fastest mode': 'vod',
        'custom source': 'custom',
        'bilibili-proxy': 'bilibili',
        'tmdb-source': 'tmdb',
        'path check': 'system',
        'path fix': 'system',
        'base': 'system',
        'fongmi': 'system',
    };
    if (normalizationMap[category]) {
        category = normalizationMap[category];
    }
    
    return category;
}

// 日志相关
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    logs.push({ timestamp, message, type });
    if (logs.length > 100) logs.shift();
    renderLogs();
}

function renderLogs() {
    const container = document.getElementById('log-container');
    const filterContainer = document.getElementById('log-filters') || createFilterContainer();
    
    let filteredLogs = logs;
    if (currentLogFilter !== 'ALL') {
        // 采用严格归属校验，同时支持续行上下文继承
        let lastCategory = 'system';
        filteredLogs = logs.filter(log => {
            let category = getLogCategory(log.message);
            if (category === '_inherit_') {
                // 续行继承上一个明确分类行
                category = lastCategory;
            } else {
                lastCategory = category;
            }
            return category === currentLogFilter;
        });
    }

    container.innerHTML = filteredLogs.map(log => {
        let highlightedMessage = log.message;
        
        // 行首连续标签高亮 (需双重转义)
        const prefixMatch = log.message.match(/^(?:\\s*\\[[^\\]]+\\])+/);
        if (prefixMatch) {
            const prefix = prefixMatch[0];
            const rest = log.message.slice(prefix.length);
            const coloredPrefix = prefix.replace(/\\[([^\\]]+)\\]/g, '<span class="log-tag">[$1]</span>');
            highlightedMessage = coloredPrefix + rest;
        }
        
        return \`<div class="log-entry \${log.type}">[\${log.timestamp}] \${highlightedMessage}</div>\`;
    }).join('');
    container.scrollTop = container.scrollHeight;
    
    updateFilterUI();
}

function createFilterContainer() {
    const controls = document.querySelector('.log-controls');
    const filterDiv = document.createElement('div');
    filterDiv.id = 'log-filters';
    filterDiv.className = 'log-filters-container';
    controls.parentNode.insertBefore(filterDiv, document.getElementById('log-container'));
    return filterDiv;
}

// 标签显示顺序：ALL → 系统 → 工具 → 源，组内字母序
const tagGroupOrder = [
    ['system', 'ai'],
    ['utils', 'cache', 'merge'],
    ['360kan', 'aiyifan', 'animeko', 'bahamut', 'bilibili', 'custom', 'dandan', 'douban', 'hanjutv', 'iqiyi', 'leshi', 'maiduidui', 'mango', 'migu', 'other', 'renren', 'sohu', 'tencent', 'tmdb', 'vod', 'xigua', 'youku'],
];
const tagOrderMap = {};
tagGroupOrder.forEach((group, gi) => group.forEach((tag, ti) => tagOrderMap[tag] = gi * 1000 + ti));

function updateFilterUI() {
    const filterContainer = document.getElementById('log-filters');
    let html = \`<button class="filter-btn \${currentLogFilter === 'ALL' ? 'active' : ''}" onclick="setLogFilter('ALL')">ALL</button>\`;
    
    const currentTags = new Set();
    let lastCategory = 'system';
    logs.forEach(log => {
        let category = getLogCategory(log.message);
        // 续行继承上一个明确分类行
        if (category === '_inherit_') {
            category = lastCategory;
        } else {
            lastCategory = category;
        }
        // 所有分类标签均生成筛选按钮
        currentTags.add(category);
    });

    [...currentTags].sort((a, b) => {
        const ai = tagOrderMap[a] ?? 99999, bi = tagOrderMap[b] ?? 99999;
        return ai !== bi ? ai - bi : a.localeCompare(b);
    }).forEach(tag => {
        html += \`<button class="filter-btn \${currentLogFilter === tag ? 'active' : ''}" onclick="setLogFilter('\${tag}')">\${tag}</button>\`;
    });
    
    filterContainer.innerHTML = html;
}

window.setLogFilter = function(tag) {
    currentLogFilter = tag;
    renderLogs();
};

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
