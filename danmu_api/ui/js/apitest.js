// language=JavaScript
export const apitestJsContent = /* javascript */ `
// API 配置
const apiConfigs = {
    searchAnime: {
        name: '搜索动漫',
        method: 'GET',
        path: '/api/v2/search/anime',
        params: [
            { name: 'keyword', label: '关键词 或 播放链接URL', type: 'text', required: true, placeholder: '示例: 生万物 或 http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html' }
        ]
    },
    searchEpisodes: {
        name: '搜索剧集',
        method: 'GET',
        path: '/api/v2/search/episodes',
        params: [
            { name: 'anime', label: '动漫名称', type: 'text', required: true, placeholder: '示例: 生万物' },
            { name: 'episode', label: '集', type: 'text', required: false, placeholder: '示例: 1, movie' }
        ]
    },
    matchAnime: {
        name: '匹配动漫',
        method: 'POST',
        path: '/api/v2/match',
        params: [
            { name: 'fileName', label: '文件名', type: 'text', required: true, placeholder: '示例: 生万物 S02E08, 无忧渡.S02E08.2160p.WEB-DL.H265.DDP.5.1, 爱情公寓.ipartment.2009.S02E08.H.265.25fps.mkv, 亲爱的X S02E08, 宇宙Marry Me? S02E08' }
        ]
    },
    getBangumi: {
        name: '获取番剧详情',
        method: 'GET',
        path: '/api/v2/bangumi/:animeId',
        params: [
            { name: 'animeId', label: '动漫ID', type: 'text', required: true, placeholder: '示例: 236379' }
        ]
    },
    getComment: {
        name: '获取弹幕',
        method: 'GET',
        path: '/api/v2/comment/:commentId',
        params: [
            { name: 'commentId', label: '弹幕ID', type: 'text', required: true, placeholder: '示例: 10009' },
            { name: 'format', label: '格式', type: 'select', required: false, placeholder: '可选: json或xml', options: ['json', 'xml'] },
            { name: 'duration', label: '附带时长', type: 'select', required: false, placeholder: '可选: true或false', options: ['true', 'false'] },
            { name: 'segmentflag', label: '分片标志', type: 'select', required: false, placeholder: '可选: true或false', options: ['true', 'false'] }
        ]
    },
    getSegmentComment: {
        name: '获取分片弹幕',
        method: 'POST',
        path: '/api/v2/segmentcomment',
        params: [
            { name: 'format', label: '格式', type: 'select', required: false, placeholder: '可选: json或xml', options: ['json', 'xml'] },
        ],
        hasBody: true,
        bodyType: 'json'
    }
};

// 弹幕测试全局状态
let danmuTestState = {
    allComments: [],
    filteredComments: [],
    currentFilter: 'all',
    displayedCount: 0,
    pageSize: 100,
    currentEpisodeId: null,
    currentTitle: '',
    currentDuration: 0,
    currentCallTrace: null,
    currentManualSearchCallTraceBase: null,
    currentManualEpisodeCallTraceBase: null,
    nextDanmuRequestId: 0,
    activeDanmuRequestId: 0,
    nextDanmuFlowRequestId: 0,
    activeDanmuFlowRequestId: 0,
    nextManualBangumiRequestId: 0,
    activeManualBangumiRequestId: 0
};

// 初始化接口调试界面
function initApiTestInterface() {
    const apiSelect = document.getElementById('api-select');
    if (apiSelect) {
        apiSelect.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') { loadApiParams(); }
        });
    }
    const autoInput = document.getElementById('auto-match-filename');
    if (autoInput) {
        autoInput.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') { autoMatchTest(); }
        });
    }
    const manualInput = document.getElementById('manual-search-keyword');
    if (manualInput) {
        manualInput.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') { manualSearchAnime(); }
        });
    }
}

// 为参数输入框添加回车事件监听
function attachEnterEventToParams() {
    // 延迟执行，确保DOM元素已经渲染
    setTimeout(() => {
        // 获取所有参数输入框
        const paramInputs = document.querySelectorAll('#params-form input[type="text"], #params-form textarea, #params-form select');
        paramInputs.forEach(input => {
            // 移除之前的事件监听器（避免重复绑定）
            input.removeEventListener('keypress', handleParamInputEnter);
            // 添加新的事件监听器
            input.addEventListener('keypress', handleParamInputEnter);
        });
    }, 100);
}

function updateCommentDurationFieldVisibility() {
    const apiSelect = document.getElementById('api-select');
    const durationGroup = document.querySelector('#params-form [data-param-name="duration"]');
    const durationInput = document.getElementById('param-duration');
    const formatInput = document.getElementById('param-format');

    if (!durationGroup) return;

    const isCommentApi = apiSelect && apiSelect.value === 'getComment';
    const formatValue = formatInput ? formatInput.value.toLowerCase() : '';
    const shouldShowDuration = isCommentApi && (formatValue === '' || formatValue === 'json');

    durationGroup.style.display = shouldShowDuration ? '' : 'none';
    if (!shouldShowDuration && durationInput) {
        durationInput.value = '';
    }
}

function bindCommentDurationFieldVisibility() {
    const formatInput = document.getElementById('param-format');
    if (!formatInput) return;
    formatInput.addEventListener('change', updateCommentDurationFieldVisibility);
    updateCommentDurationFieldVisibility();
}

// 处理参数输入框的回车事件
function handleParamInputEnter(event) {
    if (event.key === 'Enter') {
        // 触发测试API按钮的点击事件
        const testButton = document.querySelector('#api-params .btn-success');
        if (testButton) {
            testButton.click();
        }
    }
}

// 接口调试相关
function loadApiParams() {
    const select = document.getElementById('api-select');
    const apiKey = select.value;
    const paramsDiv = document.getElementById('api-params');
    const formDiv = document.getElementById('params-form');

    if (!apiKey) {
        paramsDiv.style.display = 'none';
        return;
    }

    const config = apiConfigs[apiKey];
    paramsDiv.style.display = 'block';

    let html = '';

    // 添加查询参数部分
    if (config.params && config.params.length > 0) {
        html += '<div class="params-section">';
        html += '<h4>查询参数</h4>';
        html += config.params.map(param => {
            if (param.type === 'select') {
                // 为select类型参数添加默认选项
                let optionsHtml = '<option value="">-- 请选择 --</option>';
                if (param.options) {
                    optionsHtml += param.options.map(opt => \`<option value="\${opt}">\${opt}</option>\`).join('');
                }
                return \`
                    <div class="form-group" data-param-name="\${param.name}">
                        <label>\${param.label}\${param.required ? ' *' : ''}</label>
                        <select id="param-\${param.name}">
                            \${optionsHtml}
                        </select>
                        \${param.placeholder ? \`<div class="form-help">\${param.placeholder}</div>\` : ''}
                    </div>
                \`; 
            }
            // 使用placeholder属性显示示例参数
            const placeholder = param.placeholder ? param.placeholder : "请输入" + param.label;
            return \`
                <div class="form-group" data-param-name="\${param.name}">
                    <label>\${param.label}\${param.required ? ' *' : ''}</label>
                    <input type="\${param.type}" id="param-\${param.name}" placeholder="\${placeholder}" \${param.required ? 'required' : ''}>
                </div>
            \`; 
        }).join('');
        html += '</div>';
    }

    // 添加请求体部分（如果接口有请求体）
    if (config.hasBody) {
        html += '<div class="body-section">';
        html += '<h4>请求体</h4>';
        html += \`<div class="form-group">
            <label>请求体内容 * (JSON格式)</label>
            <textarea id="body-content" rows="6" placeholder='输入JSON格式的请求体，例如：{"type": "qq","segment_start":0,"segment_end":30000,"url":"https://dm.video.qq.com/barrage/segment/j0032ubhl9s/t/v1/0/30000"}'></textarea>
            <div class="form-help">输入JSON格式的请求体内容</div>
        </div>\`;
        html += '</div>';
    }

    if (!html) {
        html = '<p class="text-gray">此接口无需参数</p>';
    }

    formDiv.innerHTML = html;
    
    // 为参数输入框添加回车事件监听
    attachEnterEventToParams();
    bindCommentDurationFieldVisibility();
}

function testApi() {
    const select = document.getElementById('api-select');
    const apiKey = select.value;
    const sendButton = document.querySelector('#api-params .btn-success'); // 获取发送请求按钮

    if (!apiKey) {
        addLog('请先选择接口', 'error');
        return;
    }

    // 设置按钮为加载状态
    const originalText = sendButton.innerHTML;
    sendButton.innerHTML = '<span class="loading-spinner-small"></span>';
    sendButton.disabled = true;

    const config = apiConfigs[apiKey];
    const params = {};

    // 获取查询参数
    if (config.params) {
        config.params.forEach(param => {
            const value = document.getElementById(\`param-\${param.name}\`).value;
            if (value) params[param.name] = value;
        });
    }

    addLog(\`调用接口: \${config.name} (\${config.method} \${config.path})\`, 'info');
    addLog(\`请求参数: \${JSON.stringify(params)}\`, 'info');

    // 构建请求URL
    let url = config.path;
    
    // 检查是否为路径参数接口
    const isPathParameterApi = config.path.includes(':');
    
    if (isPathParameterApi) {
        // 处理路径参数接口 (/api/v2/comment 和 /api/v2/bangumi)
        // 先分离路径参数和查询参数
        const pathParams = {};
        const queryParams = {};
        
        // 分类参数
        for (const [key, value] of Object.entries(params)) {
            // 检查参数是否为路径参数
            if (config.path.includes(':' + key)) {
                pathParams[key] = value;
            } else {
                // 其他参数作为查询参数
                queryParams[key] = value;
            }
        }
        
        // 替换路径参数
        for (const [key, value] of Object.entries(pathParams)) {
            url = url.replace(':' + key, encodeURIComponent(value));
        }
        
        // 添加查询参数
        if (config.method === 'GET' && Object.keys(queryParams).length > 0) {
            const queryString = new URLSearchParams(queryParams).toString();
            url = url + '?' + queryString;
        }
    } else {
        // 保持原来的逻辑，用于 search/anime 等接口
        if (config.method === 'GET') {
            const queryString = new URLSearchParams(params).toString();
            url = url + '?' + queryString;
        } else if (config.method === 'POST' && apiKey === 'getSegmentComment') {
            // 对于 getSegmentComment 接口，需要将 format 参数添加到 URL 查询参数中
            const queryParams = {};
            if (params.format) {
                queryParams.format = params.format;
            }
            if (Object.keys(queryParams).length > 0) {
                const queryString = new URLSearchParams(queryParams).toString();
                url = url + '?' + queryString;
            }
        }
    }

    // 配置请求选项
    const requestOptions = {
        method: config.method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    // 处理请求体
    if (config.hasBody) {
        // 从请求体输入框获取内容
        const bodyContent = document.getElementById('body-content').value;
        if (bodyContent) {
            try {
                // 尝试解析用户输入的JSON
                const bodyData = JSON.parse(bodyContent);
                requestOptions.body = JSON.stringify(bodyData);
            } catch (e) {
                addLog('请求体JSON格式错误: ' + e.message, 'error');
                sendButton.innerHTML = originalText;
                sendButton.disabled = false;
                return;
            }
        } else {
            // 如果没有在请求体输入框中输入内容，则使用参数构建请求体（向后兼容）
            if (apiKey === 'getSegmentComment') {
                // 对于 getSegmentComment 接口，创建 segment 对象
                const segmentData = { url: params.url };
                if (params.format) {
                    segmentData.format = params.format;
                }
                requestOptions.body = JSON.stringify(segmentData);
            } else {
                requestOptions.body = JSON.stringify(params);
            }
        }
    } else if (config.method === 'POST') {
        // 对于没有特殊请求体配置的POST接口，使用参数构建请求体
        requestOptions.body = JSON.stringify(params);
    }

    // 发送真实API请求
    fetch(buildApiUrl(url), requestOptions)
        .then(response => {
            if (!response.ok) {
                throw new Error(\`HTTP error! status: \${response.status}\`);
            }
            
            // 检查format参数以确定如何处理响应
            const formatParam = params.format || 'json';
            
            if (formatParam.toLowerCase() === 'xml') {
                // 对于XML格式，返回文本内容
                return response.text().then(text => ({
                    data: text,
                    format: 'xml'
                }));
            } else {
                // 对于JSON格式或其他情况，返回JSON对象
                return response.json().then(json => ({
                    data: json,
                    format: 'json'
                }));
            }
        })
        .then(result => {
            // 显示响应结果
            document.getElementById('api-response-container').style.display = 'block';
            
            if (result.format === 'xml') {
                // 显示XML响应
                document.getElementById('api-response').textContent = result.data;
                document.getElementById('api-response').className = 'api-response xml'; // 使用XML专用样式类
            } else {
                // 显示JSON响应
                document.getElementById('api-response').className = 'json-response';
                document.getElementById('api-response').innerHTML = highlightJSON(result.data);
            }
            
            addLog('接口调用成功', 'success');
        })
        .catch(error => {
            // 处理错误
            const errorMessage = \`API请求失败: \${error.message}\`;
            document.getElementById('api-response-container').style.display = 'block';
            document.getElementById('api-response').textContent = errorMessage;
            // 添加错误信息的CSS类
            document.getElementById('api-response').className = 'error-response';
            addLog(errorMessage, 'error');
        })
        .finally(() => {
            // 恢复按钮状态
            sendButton.innerHTML = originalText;
            sendButton.disabled = false;
        });
}

// =====================
// 标签页切换
// =====================
function switchApiTopTab(tab, event) {
    document.querySelectorAll('.api-top-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.api-tab-content').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    if (tab === 'debug') {
        document.getElementById('api-debug-content').classList.add('active');
    } else {
        document.getElementById('danmu-test-content').classList.add('active');
    }
}

function switchDanmuTestTab(tab, event) {
    document.querySelectorAll('.danmu-test-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.danmu-test-panel').forEach(el => el.classList.remove('active'));
    event.target.classList.add('active');
    if (tab === 'auto') {
        document.getElementById('auto-match-panel').classList.add('active');
    } else {
        document.getElementById('manual-match-panel').classList.add('active');
    }
}

// =====================
// 工具函数
// =====================
function decColorToHex(dec) {
    const n = parseInt(dec) || 16777215;
    return '#' + n.toString(16).padStart(6, '0');
}

function parseDanmuMode(p) {
    const parts = p.split(',');
    return parseInt(parts[1]) || 1;
}

function parseDanmuColor(p) {
    const parts = p.split(',');
    return parseInt(parts[2]) || 16777215;
}

function parseDanmuTime(p) {
    return parseFloat(p.split(',')[0]) || 0;
}

function getModeLabel(mode) {
    switch (mode) {
        case 4: return '底部';
        case 5: return '顶部';
        default: return '滚动';
    }
}

function formatDuration(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
    return m + ':' + String(sec).padStart(2,'0');
}

function getValidDanmuTimes(comments) {
    return comments
        .map(c => c.t !== undefined ? Number(c.t) : parseDanmuTime(c.p))
        .filter(time => Number.isFinite(time) && time >= 0)
        .sort((a, b) => a - b);
}

function getPercentileValue(sortedValues, percentile) {
    if (!sortedValues.length) return 0;
    const safePercentile = Math.min(Math.max(percentile, 0), 1);
    const index = Math.floor((sortedValues.length - 1) * safePercentile);
    return sortedValues[index] || 0;
}

function getMedian(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function buildTailGapThreshold(sortedValues) {
    if (sortedValues.length < 2) return 45;

    const gaps = [];
    const startIndex = Math.max(1, sortedValues.length - 80);
    for (let i = startIndex; i < sortedValues.length; i++) {
        const gap = sortedValues[i] - sortedValues[i - 1];
        if (gap > 0) {
            gaps.push(gap);
        }
    }

    if (!gaps.length) return 45;

    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = getMedian(sortedGaps);
    const p90Gap = getPercentileValue(sortedGaps, 0.9);
    return Math.min(240, Math.max(45, medianGap * 12, p90Gap * 3));
}

function estimateVideoDurationFromComments(comments) {
    const validTimes = getValidDanmuTimes(comments);
    if (!validTimes.length) return 0;
    if (validTimes.length < 200) return validTimes[validTimes.length - 1];

    const p995Time = getPercentileValue(validTimes, 0.995);
    const p998Time = getPercentileValue(validTimes, 0.998);
    const gapThreshold = buildTailGapThreshold(validTimes);
    const trimBaseline = p998Time + Math.max(90, gapThreshold * 2);
    let endIndex = validTimes.length - 1;

    while (endIndex > 0) {
        let tailStartIndex = endIndex;
        while (tailStartIndex > 0) {
            const gap = validTimes[tailStartIndex] - validTimes[tailStartIndex - 1];
            if (gap > gapThreshold) break;
            tailStartIndex--;
        }

        const tailClusterSize = endIndex - tailStartIndex + 1;
        const tailClusterSpan = validTimes[endIndex] - validTimes[tailStartIndex];
        const previousGap = tailStartIndex > 0 ? validTimes[tailStartIndex] - validTimes[tailStartIndex - 1] : 0;
        const isIsolatedTail = tailStartIndex > 0
            && tailClusterSize <= 2
            && tailClusterSpan <= 15
            && previousGap > gapThreshold;

        if (!isIsolatedTail || validTimes[endIndex] <= trimBaseline) {
            break;
        }

        endIndex = tailStartIndex - 1;
    }

    return Math.max(validTimes[Math.max(endIndex, 0)] || 0, p995Time);
}

function getEffectiveDuration(comments, explicitDuration) {
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
        return explicitDuration;
    }
    return estimateVideoDurationFromComments(comments);
}

function setBtnLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
        btn._origText = btn.innerHTML;
        btn.innerHTML = '<span class="loading-spinner-small"></span>';
        btn.disabled = true;
    } else {
        btn.innerHTML = btn._origText || '按钮';
        btn.disabled = false;
    }
}

// 通用：显示指定面板，隐藏同级其他面板
function showDanmuView(showIds, hideIds) {
    hideIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    showIds.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; });
}

// 生成返回按钮HTML
function backBtnHtml(text, onclick) {
    return '<button class="btn btn-back" onclick="' + onclick + '">&larr; ' + escapeHtml(text) + '</button>';
}

function inlineJsString(value) {
    return escapeHtml(JSON.stringify(String(value || '')));
}

function createDanmuCallTrace(mode, inputText) {
    return {
        mode: mode || 'manual',
        inputText: inputText || '',
        steps: [],
        startedAt: performance.now()
    };
}

function cloneDanmuCallTrace(trace) {
    if (!trace) return null;
    return {
        mode: trace.mode,
        inputText: trace.inputText,
        startedAt: performance.now(),
        steps: (trace.steps || []).map(step => Object.assign({}, step))
    };
}

function createDanmuCallStep(step) {
    return Object.assign({
        name: '',
        method: 'GET',
        url: '',
        params: '',
        result: '',
        elapsed: 0,
        status: 'success'
    }, step);
}

function addDanmuCallStep(trace, step) {
    if (!trace) return;
    trace.steps.push(createDanmuCallStep(step));
}

function finishDanmuCallStep(trace, startedAt, step) {
    addDanmuCallStep(trace, Object.assign({}, step, {
        elapsed: performance.now() - startedAt
    }));
}

function finishDanmuCallFailure(trace, startedAt, step, error) {
    const message = error && error.message ? error.message : String(error || '未知错误');
    finishDanmuCallStep(trace, startedAt, Object.assign({
        status: 'error',
        result: '失败：' + message
    }, step));
}

function finishDanmuCallEmpty(trace, startedAt, step, message) {
    finishDanmuCallStep(trace, startedAt, Object.assign({
        status: 'empty',
        result: message || '无结果'
    }, step));
}

function safeDanmuApiPath(path) {
    return String(path || '').replace(new RegExp('^/[^/]+/api/'), '/<TOKEN>/api/');
}

function renderDanmuCallTrace(trace) {
    return '';
}

function getDanmuCallTraceTotalMs(trace) {
    if (!trace || !Array.isArray(trace.steps) || trace.steps.length === 0) return 0;
    return trace.steps.reduce((sum, step) => sum + (Number(step.elapsed) || 0), 0);
}

function renderDanmuCallFailure(trace, title, message, source) {
    let html = '<div class="danmu-result-toolbar">';
    if (source === 'manual-episode') {
        html += backBtnHtml('返回列表', 'backToEpisodeList()');
    } else if (source === 'manual-anime') {
        html += backBtnHtml('返回搜索结果', 'backToManualSearch()');
    }
    html += '</div>';
    html += '<div class="danmu-result-error">' + escapeHtml(title || '调用失败') + '：' + escapeHtml(message || '请求失败') + '</div>';
    html += renderDanmuCallTrace(trace);
    return html;
}

function showDanmuCallTraceFailure(trace, title, message, source) {
    const resultArea = document.getElementById('danmu-result-area');
    if (!resultArea) return;
    resultArea.innerHTML = renderDanmuCallFailure(trace, title, message, source);
    resultArea.style.display = 'block';
}

function getDanmuCallTraceTotalSeconds(trace, fallbackSeconds) {
    const totalMs = getDanmuCallTraceTotalMs(trace);
    if (totalMs > 0) return (totalMs / 1000).toFixed(2);
    return fallbackSeconds || '0.00';
}

function formatCallElapsed(ms) {
    if (!Number.isFinite(ms)) return '--';
    return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : Math.round(ms) + 'ms';
}

function startDanmuFlowRequest() {
    const requestId = ++danmuTestState.nextDanmuFlowRequestId;
    danmuTestState.activeDanmuFlowRequestId = requestId;
    danmuTestState.activeManualBangumiRequestId = 0;
    invalidateActiveDanmuRequest();
    return requestId;
}

function isCurrentDanmuFlowRequest(requestId) {
    return danmuTestState.activeDanmuFlowRequestId === requestId;
}

function startManualBangumiRequest() {
    const requestId = ++danmuTestState.nextManualBangumiRequestId;
    danmuTestState.activeManualBangumiRequestId = requestId;
    danmuTestState.activeDanmuFlowRequestId = 0;
    invalidateActiveDanmuRequest();
    return requestId;
}

function isCurrentManualBangumiRequest(requestId) {
    return danmuTestState.activeManualBangumiRequestId === requestId;
}

function invalidateActiveDanmuRequest() {
    danmuTestState.activeDanmuRequestId = 0;
}

function setDanmuFlowButtonLoading(btn, requestId, loading) {
    if (!btn) return;
    if (loading) {
        btn._danmuFlowRequestId = requestId;
        setBtnLoading(btn, true);
        return;
    }
    if (btn._danmuFlowRequestId === requestId) {
        setBtnLoading(btn, false);
        btn._danmuFlowRequestId = 0;
    }
}

// =====================
// 自动匹配测试
// =====================
async function autoMatchTest() {
    const fileName = document.getElementById('auto-match-filename').value.trim();
    if (!fileName) { customAlert('请输入文件名'); return; }

    const flowRequestId = startDanmuFlowRequest();
    const btn = document.getElementById('auto-match-btn');
    setDanmuFlowButtonLoading(btn, flowRequestId, true);
    document.getElementById('danmu-result-area').style.display = 'none';
    addLog('自动匹配测试: ' + fileName, 'info');
    const trace = createDanmuCallTrace('auto', fileName);
    danmuTestState.currentCallTrace = trace;
    danmuTestState.currentManualSearchCallTraceBase = null;
    danmuTestState.currentManualEpisodeCallTraceBase = null;

    let matchStartedAt = 0;
    try {
        matchStartedAt = performance.now();
        const resp = await fetch(buildApiUrl('/api/v2/match'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: fileName })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!isCurrentDanmuFlowRequest(flowRequestId)) return;

        if (data.isMatched && data.matches && data.matches.length > 0) {
            const best = data.matches[0];
            const title = (best.animeTitle || '') + ' ' + (best.episodeTitle || '');
            finishDanmuCallStep(trace, matchStartedAt, {
                name: '匹配',
                method: 'POST',
                url: '/api/v2/match',
                params: '文件名：' + fileName,
                result: '命中 ' + data.matches.length + ' 个结果，episodeId: ' + best.episodeId
            });
            addLog('自动匹配命中: ' + title + ' (共' + data.matches.length + '个结果，取第1个)', 'success');
            setDanmuFlowButtonLoading(btn, flowRequestId, false);
            fetchDanmuForTest(best.episodeId, title, 'auto', trace);
            return;
        } else {
            finishDanmuCallEmpty(trace, matchStartedAt, {
                name: '匹配',
                method: 'POST',
                url: '/api/v2/match',
                params: '文件名：' + fileName
            }, '未匹配到任何结果');
            customAlert('未匹配到任何结果');
            addLog('自动匹配无结果', 'warn');
            showDanmuCallTraceFailure(trace, '自动匹配无结果', '未匹配到任何结果', 'auto');
        }
    } catch (e) {
        if (!isCurrentDanmuFlowRequest(flowRequestId)) return;
        finishDanmuCallFailure(trace, matchStartedAt || performance.now(), {
            name: '匹配',
            method: 'POST',
            url: '/api/v2/match',
            params: '文件名：' + fileName
        }, e);
        customAlert('匹配失败: ' + e.message);
        addLog('自动匹配失败: ' + e.message, 'error');
        showDanmuCallTraceFailure(trace, '自动匹配失败', e.message, 'auto');
    } finally {
        setDanmuFlowButtonLoading(btn, flowRequestId, false);
    }
}

// =====================
// 手动匹配测试
// =====================
async function manualSearchAnime() {
    const keyword = document.getElementById('manual-search-keyword').value.trim();
    if (!keyword) { customAlert('请输入搜索关键字'); return; }

    const flowRequestId = startDanmuFlowRequest();
    const btn = document.getElementById('manual-search-btn');
    setDanmuFlowButtonLoading(btn, flowRequestId, true);
    document.getElementById('manual-anime-list').style.display = 'none';
    document.getElementById('manual-episode-list').style.display = 'none';
    document.getElementById('danmu-result-area').style.display = 'none';
    addLog('手动搜索: ' + keyword, 'info');
    const trace = createDanmuCallTrace('manual', keyword);
    danmuTestState.currentCallTrace = trace;
    danmuTestState.currentManualSearchCallTraceBase = null;
    danmuTestState.currentManualEpisodeCallTraceBase = null;

    let searchStartedAt = 0;
    let searchUrl = '';
    try {
        searchUrl = '/api/v2/search/anime?keyword=' + encodeURIComponent(keyword);
        searchStartedAt = performance.now();
        const resp = await fetch(buildApiUrl(searchUrl));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!isCurrentDanmuFlowRequest(flowRequestId)) return;

        if (data.success && data.animes && data.animes.length > 0) {
            finishDanmuCallStep(trace, searchStartedAt, {
                name: '搜索',
                method: 'GET',
                url: searchUrl,
                params: '关键词：' + keyword,
                result: '找到 ' + data.animes.length + ' 个动漫'
            });
            danmuTestState.currentManualSearchCallTraceBase = cloneDanmuCallTrace(trace);
            displayManualAnimeList(data.animes);
            addLog('搜索到 ' + data.animes.length + ' 个动漫', 'success');
        } else {
            finishDanmuCallEmpty(trace, searchStartedAt, {
                name: '搜索',
                method: 'GET',
                url: searchUrl,
                params: '关键词：' + keyword
            }, '未找到相关动漫');
            customAlert('未找到相关动漫');
            addLog('搜索无结果', 'warn');
            showDanmuCallTraceFailure(trace, '搜索无结果', '未找到相关动漫', 'manual-search');
        }
    } catch (e) {
        if (!isCurrentDanmuFlowRequest(flowRequestId)) return;
        finishDanmuCallFailure(trace, searchStartedAt || performance.now(), {
            name: '搜索',
            method: 'GET',
            url: searchUrl || '/api/v2/search/anime',
            params: '关键词：' + keyword
        }, e);
        customAlert('搜索失败: ' + e.message);
        addLog('搜索失败: ' + e.message, 'error');
        showDanmuCallTraceFailure(trace, '搜索失败', e.message, 'manual-search');
    } finally {
        setDanmuFlowButtonLoading(btn, flowRequestId, false);
    }
}

function displayManualAnimeList(animes) {
    const container = document.getElementById('manual-anime-list');
    let html = '<h3 class="danmu-section-title danmu-section-title-spaced">搜索结果</h3><div class="anime-grid">';
    animes.forEach(anime => {
        const animeId = Number.parseInt(anime.animeId, 10);
        if (!Number.isFinite(animeId)) return;
        const img = escapeHtml(anime.imageUrl || 'https://placehold.co/150x200?text=No+Image');
        html += '<div class="anime-item" onclick="manualGetBangumi(' + animeId + ')">';
        html += '<img src="' + img + '" alt="' + escapeHtml(anime.animeTitle) + '" referrerpolicy="no-referrer" class="anime-item-img">';
        html += '<h4 class="anime-title">' + escapeHtml(anime.animeTitle) + ' - 共' + (anime.episodeCount || '?') + '集</h4>';
        html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';
}

async function manualGetBangumi(animeId) {
    const detailRequestId = startManualBangumiRequest();
    const requestTrace = danmuTestState.currentManualSearchCallTraceBase
        ? cloneDanmuCallTrace(danmuTestState.currentManualSearchCallTraceBase)
        : createDanmuCallTrace('manual', String(animeId || ''));
    danmuTestState.currentCallTrace = requestTrace;
    addLog('获取番剧详情: ' + animeId, 'info');
    // 隐藏搜索结果，显示剧集列表区域
    showDanmuView(['manual-episode-list'], ['manual-anime-list', 'danmu-result-area']);

    let bangumiStartedAt = 0;
    const bangumiUrl = '/api/v2/bangumi/' + animeId;
    try {
        bangumiStartedAt = performance.now();
        const resp = await fetch(buildApiUrl(bangumiUrl));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!isCurrentManualBangumiRequest(detailRequestId)) return;

        const episodes = data && data.bangumi && Array.isArray(data.bangumi.episodes) ? data.bangumi.episodes : [];
        if (data.success && data.bangumi && episodes.length > 0) {
            finishDanmuCallStep(requestTrace, bangumiStartedAt, {
                name: '番剧详情',
                method: 'GET',
                url: bangumiUrl,
                params: 'animeId: ' + animeId,
                result: '获取到 ' + episodes.length + ' 个剧集'
            });
            danmuTestState.currentManualEpisodeCallTraceBase = cloneDanmuCallTrace(requestTrace);
            displayManualEpisodeList(data.bangumi.animeTitle, episodes);
            addLog('获取到 ' + episodes.length + ' 个剧集', 'success');
        } else {
            finishDanmuCallEmpty(requestTrace, bangumiStartedAt, {
                name: '番剧详情',
                method: 'GET',
                url: bangumiUrl,
                params: 'animeId: ' + animeId
            }, '该动漫暂无剧集信息');
            customAlert('该动漫暂无剧集信息');
            showDanmuCallTraceFailure(requestTrace, '番剧详情无剧集', '该动漫暂无剧集信息', 'manual-anime');
            // 恢复搜索结果
            showDanmuView(['manual-anime-list'], ['manual-episode-list']);
        }
    } catch (e) {
        if (!isCurrentManualBangumiRequest(detailRequestId)) return;
        finishDanmuCallFailure(requestTrace, bangumiStartedAt || performance.now(), {
            name: '番剧详情',
            method: 'GET',
            url: bangumiUrl,
            params: 'animeId: ' + animeId
        }, e);
        customAlert('获取番剧详情失败: ' + e.message);
        addLog('获取番剧详情失败: ' + e.message, 'error');
        showDanmuCallTraceFailure(requestTrace, '获取番剧详情失败', e.message, 'manual-anime');
        showDanmuView(['manual-anime-list'], ['manual-episode-list']);
    }
}

function displayManualEpisodeList(animeTitle, episodes) {
    const container = document.getElementById('manual-episode-list');
    let html = backBtnHtml('返回搜索结果', 'backToManualSearch()');
    html += '<h3 class="danmu-section-title danmu-section-title-spaced">剧集列表</h3>';
    html += '<h4 class="text-yellow-gold">' + escapeHtml(animeTitle) + '</h4>';
    
    // 添加跳转到指定集数的功能
    html += \`
    <div class="jump-to-episode">
        <span>跳转到第</span>
        <input type="number" id="jump-episode-input" class="jump-episode-input" placeholder="输入集数" min="1">
        <span>集</span>
        <button class="btn btn-primary btn-sm jump-episode-btn" onclick="jumpToEpisode()">跳转</button>
        <span class="jump-episode-total">共\${episodes.length}集</span>
    </div>\`;
    
    html += '<div class="episode-list-container">';
    episodes.forEach(ep => {
        const episodeId = Number.parseInt(ep.episodeId, 10);
        const episodeNumber = Number.parseInt(ep.episodeNumber, 10);
        if (!Number.isFinite(episodeId) || !Number.isFinite(episodeNumber)) return;
        const title = String(animeTitle || '') + ' 第' + episodeNumber + '集';
        html += '<div class="episode-item" id="episode-item-' + episodeNumber + '">';
        html += '<div class="episode-item-content"><strong>第' + episodeNumber + '集</strong> - ' + escapeHtml(ep.episodeTitle || '无标题') + '</div>';
        html += '<button class="btn btn-success btn-sm" onclick="fetchDanmuForTest(' + episodeId + ', ' + inlineJsString(title) + ', \\'manual\\')">获取弹幕</button>';
        html += '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';
    setTimeout(() => container.scrollIntoView({ behavior: 'smooth', block: 'start' }), 10);
}

// 返回搜索结果
function backToManualSearch() {
    showDanmuView(['manual-anime-list'], ['manual-episode-list', 'danmu-result-area']);
}

// 返回剧集列表
function backToEpisodeList() {
    showDanmuView(['manual-episode-list'], ['danmu-result-area']);
}

// 跳转到指定集数
function jumpToEpisode() {
    const episodeInput = document.getElementById('jump-episode-input');
    const episodeNumber = parseInt(episodeInput.value);
    
    if (!episodeNumber || episodeNumber <= 0) {
        customAlert('请输入有效的集数（正整数）');
        return;
    }
    
    // 查找对应集数的元素
    const episodeElement = document.getElementById('episode-item-' + episodeNumber);
    if (episodeElement) {
        // 滚动到指定元素位置
        episodeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 添加高亮效果以便识别
        episodeElement.classList.add('episode-item-highlight');
        setTimeout(() => {
            episodeElement.classList.remove('episode-item-highlight');
        }, 2000);
    } else {
        customAlert('找不到第' + episodeNumber + '集');
    }
}

function isCurrentDanmuRequest(requestId) {
    return danmuTestState.activeDanmuRequestId === requestId;
}

// =====================
// 获取弹幕并展示结果
// =====================
async function fetchDanmuForTest(episodeId, title, source, traceBase) {
    addLog('获取弹幕: ' + episodeId + ' (' + title + ')', 'info');
    const requestId = ++danmuTestState.nextDanmuRequestId;
    danmuTestState.activeDanmuRequestId = requestId;
    let requestTrace = null;
    if (traceBase) {
        requestTrace = cloneDanmuCallTrace(traceBase);
        danmuTestState.currentCallTrace = requestTrace;
    } else if (source === 'manual' && danmuTestState.currentManualEpisodeCallTraceBase) {
        danmuTestState.currentCallTrace = cloneDanmuCallTrace(danmuTestState.currentManualEpisodeCallTraceBase);
        requestTrace = danmuTestState.currentCallTrace;
    } else {
        requestTrace = cloneDanmuCallTrace(danmuTestState.currentCallTrace);
        danmuTestState.currentCallTrace = requestTrace;
    }
    danmuTestState.currentEpisodeId = episodeId;
    danmuTestState.currentTitle = title;
    danmuTestState.currentDuration = 0;

    // 隐藏上级面板
    if (source === 'manual') {
        showDanmuView([], ['manual-episode-list', 'manual-anime-list', 'danmu-result-area']);
    } else {
        showDanmuView([], ['danmu-result-area']);
    }

    // 显示加载动画
    const resultArea = document.getElementById('danmu-result-area');
    resultArea.innerHTML = '<div class="danmu-loading"><div class="loading-spinner"></div><div class="loading-text">正在获取弹幕数据...</div></div>';
    resultArea.style.display = 'block';

    const startTime = performance.now();
    try {
        const commentUrl = '/api/v2/comment/' + episodeId + '?format=json&duration=true';
        const data = await fetch(buildApiUrl(commentUrl))
            .then(resp => {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            });
        if (!isCurrentDanmuRequest(requestId)) return;
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        const durationSeconds = Number((data && data.videoDuration) || 0);

        if (!data.comments || data.comments.length === 0) {
            finishDanmuCallEmpty(requestTrace, startTime, {
                name: '弹幕',
                method: 'GET',
                url: commentUrl,
                params: 'episodeId: ' + episodeId + '，format=json，duration=true'
            }, '该剧集暂无弹幕数据');
            customAlert('该剧集暂无弹幕数据');
            addLog('无弹幕数据', 'warn');
            const failureSource = source === 'manual' ? 'manual-episode' : source;
            resultArea.innerHTML = renderDanmuCallFailure(requestTrace, '无弹幕数据', '该剧集暂无弹幕数据', failureSource);
            resultArea.style.display = 'block';
            return;
        }

        finishDanmuCallStep(requestTrace, startTime, {
            name: '弹幕',
            method: 'GET',
            url: commentUrl,
            params: 'episodeId: ' + episodeId + '，format=json，duration=true',
            result: data.comments.length + ' 条弹幕'
        });

        addLog('获取到 ' + data.comments.length + ' 条弹幕, 耗时 ' + elapsed + 's', 'success');

        danmuTestState.allComments = data.comments;
        danmuTestState.currentFilter = 'all';
        danmuTestState.displayedCount = 0;
        danmuTestState.currentDuration = durationSeconds;

        // 重建结果区内容：auto模式只有导出按钮，manual模式有返回+导出
        let toolbarHtml = '<div class="danmu-result-toolbar">';
        if (source === 'manual') {
            toolbarHtml += backBtnHtml('返回列表', 'backToEpisodeList()');
        }
        toolbarHtml += '<div class="danmu-export-btns">' +
                '<button class="btn btn-sm btn-primary" onclick="exportDanmu(\\'json\\')">导出 JSON</button>' +
                '<button class="btn btn-sm btn-primary" onclick="exportDanmu(\\'xml\\')">导出 XML</button>' +
            '</div></div>';

        const filterCounts = getDanmuFilterCounts(data.comments);
        resultArea.innerHTML =
            toolbarHtml +
            '<div class="danmu-stats" id="danmu-stats"></div>' +
            renderDanmuCallTrace(requestTrace) +
            '<div class="danmu-heatmap-container"><h3 class="danmu-section-title">弹幕热力图</h3><div class="danmu-heatmap" id="danmu-heatmap"></div></div>' +
            '<div class="danmu-list-area"><h3 class="danmu-section-title">弹幕列表</h3>' +
                renderDanmuFilterTabs(filterCounts) +
                '<div class="danmu-list" id="danmu-list"></div>' +
                '<button class="btn btn-primary danmu-load-more" id="danmu-load-more" onclick="loadMoreDanmu()">加载更多</button>' +
            '</div>';

        applyDanmuFilter();
        renderDanmuStats(data, elapsed, title, durationSeconds, filterCounts);
        renderDanmuHeatmap(data.comments, durationSeconds);
        renderDanmuList();

        setTimeout(() => resultArea.scrollIntoView({ behavior: 'smooth', block: 'start' }), 10);
    } catch (e) {
        if (!isCurrentDanmuRequest(requestId)) return;
        const commentUrl = '/api/v2/comment/' + episodeId + '?format=json&duration=true';
        finishDanmuCallFailure(requestTrace, startTime, {
            name: '弹幕',
            method: 'GET',
            url: commentUrl,
            params: 'episodeId: ' + episodeId + '，format=json，duration=true'
        }, e);
        customAlert('获取弹幕失败: ' + e.message);
        addLog('获取弹幕失败: ' + e.message, 'error');
        const failureSource = source === 'manual' ? 'manual-episode' : source;
        resultArea.innerHTML = renderDanmuCallFailure(requestTrace, '获取弹幕失败', e.message, failureSource);
        resultArea.style.display = 'block';
    }
}

// =====================
// 导出弹幕（直接请求后端获取格式化数据）
// =====================
async function exportDanmu(format) {
    const id = danmuTestState.currentEpisodeId;
    if (!id) { customAlert('无弹幕数据可导出'); return; }

    const title = danmuTestState.currentTitle || ('danmu_' + id);
    // 清理文件名中的非法字符
    const safeTitle = title.replace(/[\\\\/:*?"<>|]/g, '_');

    addLog('导出弹幕 ' + format.toUpperCase() + '...', 'info');
    try {
        const resp = await fetch(buildApiUrl('/api/v2/comment/' + id + '?format=' + format));
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        let content, mimeType;
        if (format === 'xml') {
            content = await resp.text();
            mimeType = 'application/xml';
        } else {
            const data = await resp.json();
            content = JSON.stringify(data, null, 2);
            mimeType = 'application/json';
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = safeTitle + '.' + format;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        addLog('导出弹幕 ' + format.toUpperCase() + ' 成功', 'success');
    } catch (e) {
        customAlert('导出失败: ' + e.message);
        addLog('导出失败: ' + e.message, 'error');
    }
}

// =====================
// 弹幕统计
// =====================
function renderDanmuStats(data, elapsed, title, durationSeconds, filterCounts) {
    const comments = data.comments;
    const count = comments.length;

    const maxTime = getEffectiveDuration(comments, durationSeconds);

    // 平均密度
    const durationMin = maxTime / 60;
    const avgDensity = durationMin > 0 ? (count / durationMin).toFixed(1) : '0';

    // 高能时刻：找密度最高的30秒区间
    const segLen = 30;
    const segCount = Math.ceil(maxTime / segLen) || 1;
    const segs = new Array(segCount).fill(0);
    comments.forEach(c => {
        const t = c.t !== undefined ? c.t : parseDanmuTime(c.p);
        if (t > maxTime) return; // 跳过异常时间点
        const idx = Math.min(Math.floor(t / segLen), segCount - 1);
        segs[idx]++;
    });
    let hotIdx = 0;
    for (let i = 1; i < segs.length; i++) {
        if (segs[i] > segs[hotIdx]) hotIdx = i;
    }
    const hotStart = hotIdx * segLen;
    const hotMoment = formatDuration(hotStart) + ' - ' + formatDuration(hotStart + segLen);

    const coloredCount = comments.reduce((sum, comment) => {
        if (!comment || !comment.p) return sum;
        const color = parseInt(String(comment.p).split(',')[2], 10);
        return Number.isFinite(color) && color !== 16777215 ? sum + 1 : sum;
    }, 0);
    const coloredRatio = count > 0 ? ((coloredCount / count) * 100).toFixed(1) + '%' : '--';

    const container = document.getElementById('danmu-stats');
    container.innerHTML =
        '<div class="danmu-stats-title">' + escapeHtml(title) + '</div>' +
        '<div class="danmu-stats-grid">' +
            '<div class="danmu-stat-card"><div class="stat-value">' + count + '</div><div class="stat-label">弹幕数</div></div>' +
            '<div class="danmu-stat-card"><div class="stat-value">' + formatDuration(maxTime) + '</div><div class="stat-label">时长</div></div>' +
            '<div class="danmu-stat-card"><div class="stat-value">' + hotMoment + '</div><div class="stat-label">高能时刻</div></div>' +
            '<div class="danmu-stat-card"><div class="stat-value">' + avgDensity + ' 条/分</div><div class="stat-label">平均密度</div></div>' +
            '<div class="danmu-stat-card"><div class="stat-value">' + elapsed + 's</div><div class="stat-label">请求耗时</div></div>' +
            '<div class="danmu-stat-card"><div class="stat-value">' + coloredRatio + '</div><div class="stat-label">彩色占比</div></div>' +
        '</div>';
}

// =====================
// 弹幕热力图
// =====================
function renderDanmuHeatmap(comments, durationSeconds) {
    const container = document.getElementById('danmu-heatmap');
    const maxTime = getEffectiveDuration(comments, durationSeconds);
    if (maxTime === 0) { container.innerHTML = '<p class="danmu-empty-text">无数据</p>'; return; }

    const barCount = Math.min(60, Math.max(20, Math.ceil(maxTime / 30)));
    const segLen = maxTime / barCount;
    const segs = new Array(barCount).fill(0);
    comments.forEach(c => {
        const t = c.t !== undefined ? c.t : parseDanmuTime(c.p);
        if (t > maxTime) return; // 跳过异常时间点
        const idx = Math.min(Math.floor(t / segLen), barCount - 1);
        segs[idx]++;
    });

    const maxSeg = Math.max(...segs, 1);
    let html = '<div class="danmu-heatmap-interactive">';
    html += '<div class="heatmap-bars">';
    for (let i = 0; i < barCount; i++) {
        const pct = Math.max(2, (segs[i] / maxSeg) * 100);
        const intensity = segs[i] / maxSeg;
        // 从蓝到红的渐变
        const r = Math.round(66 + intensity * 189);
        const g = Math.round(126 - intensity * 80);
        const b = Math.round(234 - intensity * 180);
        const start = i * segLen;
        const end = Math.min((i + 1) * segLen, maxTime);
        const timeLabel = formatDuration(start) + ' - ' + formatDuration(end);
        html += '<div class="heatmap-bar" data-index="' + i + '" data-count="' + segs[i] + '" style="--heatmap-height:' + pct + '%;--heatmap-color:rgb(' + r + ',' + g + ',' + b + ');" aria-label="' + timeLabel + ' | ' + segs[i] + '条弹幕"></div>';
    }
    html += '</div>';
    html += '<div class="danmu-heatmap-indicator"></div><div class="danmu-heatmap-tooltip"></div>';
    html += '</div>';
    html += '<div class="heatmap-axis"><span>00:00</span><span>' + formatDuration(maxTime / 2) + '</span><span>' + formatDuration(maxTime) + '</span></div>';
    container.innerHTML = html;
    bindDanmuHeatmapScrub(container, segs, segLen, maxTime);
}

function bindDanmuHeatmapScrub(container, segs, segLen, maxTime) {
    const interactive = container.querySelector('.danmu-heatmap-interactive');
    const bars = container.querySelector('.heatmap-bars');
    const tooltip = container.querySelector('.danmu-heatmap-tooltip');
    const indicator = container.querySelector('.danmu-heatmap-indicator');
    if (!interactive || !bars || !tooltip || !indicator) return;

    let rafId = null;
    let latestEvent = null;
    const scheduleUpdate = event => {
        latestEvent = event;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            if (!latestEvent) return;
            updateDanmuHeatmapTooltip(latestEvent, interactive, bars, tooltip, indicator, segs, segLen, maxTime);
        });
    };

    const hideTooltip = () => hideDanmuHeatmapTooltip(bars, tooltip, indicator, () => {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        latestEvent = null;
    });

    interactive.addEventListener('pointermove', scheduleUpdate, { passive: true });
    interactive.addEventListener('pointerdown', scheduleUpdate, { passive: true });
    interactive.addEventListener('pointerup', hideTooltip, { passive: true });
    interactive.addEventListener('pointercancel', hideTooltip, { passive: true });
    interactive.addEventListener('pointerleave', hideTooltip);
}

function hideDanmuHeatmapTooltip(bars, tooltip, indicator, beforeHide) {
    if (beforeHide) beforeHide();
    tooltip.classList.remove('active');
    indicator.classList.remove('active');
    const activeBar = bars.querySelector('.heatmap-bar.active');
    if (activeBar) activeBar.classList.remove('active');
}

function updateDanmuHeatmapTooltip(event, interactive, bars, tooltip, indicator, segs, segLen, maxTime) {
    if (!event) return;
    const rect = bars.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const index = Math.max(0, Math.min(segs.length - 1, Math.floor(ratio * segs.length)));
    const start = index * segLen;
    const end = Math.min((index + 1) * segLen, maxTime);
    const leftPct = ((index + 0.5) / segs.length) * 100;

    const activeBar = bars.querySelector('.heatmap-bar.active');
    if (activeBar) activeBar.classList.remove('active');
    const currentBar = bars.querySelector('.heatmap-bar[data-index="' + index + '"]');
    if (currentBar) currentBar.classList.add('active');

    tooltip.innerHTML = '<strong>' + segs[index] + '</strong><span>条弹幕</span><em>' + formatDuration(start) + ' - ' + formatDuration(end) + '</em>';
    tooltip.classList.add('active');
    indicator.classList.add('active');

    const clampedLeft = clampHeatmapTooltipLeft(interactive, tooltip, leftPct);
    tooltip.style.left = clampedLeft + 'px';
    indicator.style.left = leftPct + '%';
}

function clampHeatmapTooltipLeft(interactive, tooltip, leftPct) {
    const width = interactive.clientWidth || 0;
    const tooltipWidth = tooltip.offsetWidth || 0;
    const padding = 8;
    const rawLeft = (leftPct / 100) * width;
    const minLeft = (tooltipWidth / 2) + padding;
    const maxLeft = width - (tooltipWidth / 2) - padding;
    if (width <= tooltipWidth + padding * 2) return width / 2;
    return Math.max(minLeft, Math.min(maxLeft, rawLeft));
}

function getDanmuFilterCounts(comments) {
    const counts = { all: comments.length, scroll: 0, top: 0, bottom: 0 };
    comments.forEach(c => {
        const mode = parseDanmuMode(c.p);
        if (mode === 5) counts.top++;
        else if (mode === 4) counts.bottom++;
        else counts.scroll++;
    });
    return counts;
}

function renderDanmuFilterTabs(counts) {
    const items = [
        { key: 'all', label: '全部' },
        { key: 'scroll', label: '滚动' },
        { key: 'top', label: '顶部' },
        { key: 'bottom', label: '底部' }
    ];
    let html = '<div class="danmu-filter-tabs">';
    items.forEach(item => {
        const active = item.key === 'all' ? ' active' : '';
        html += '<button class="danmu-filter-tab' + active + '" data-count="' + counts[item.key] + '" onclick="filterDanmuList(\\'' + item.key + '\\', event)">' + item.label + '<span class="danmu-filter-count">' + counts[item.key] + '</span></button>';
    });
    html += '</div>';
    return html;
}

// =====================
// 弹幕列表过滤与懒加载
// =====================
function applyDanmuFilter() {
    const filter = danmuTestState.currentFilter;
    if (filter === 'all') {
        danmuTestState.filteredComments = danmuTestState.allComments;
    } else {
        const modeMap = { scroll: 1, top: 5, bottom: 4 };
        const targetMode = modeMap[filter];
        danmuTestState.filteredComments = danmuTestState.allComments.filter(c => {
            const mode = parseDanmuMode(c.p);
            if (filter === 'scroll') return mode !== 4 && mode !== 5;
            return mode === targetMode;
        });
    }
    danmuTestState.displayedCount = 0;
}

function filterDanmuList(type, event) {
    document.querySelectorAll('.danmu-filter-tab').forEach(btn => btn.classList.remove('active'));
    const tab = event.currentTarget || event.target.closest('.danmu-filter-tab');
    if (tab) tab.classList.add('active');
    danmuTestState.currentFilter = type;
    applyDanmuFilter();
    renderDanmuList();
}

function renderDanmuList() {
    const list = danmuTestState.filteredComments;
    const end = Math.min(danmuTestState.displayedCount + danmuTestState.pageSize, list.length);
    let html = '';

    for (let i = danmuTestState.displayedCount; i < end; i++) {
        const c = list[i];
        const time = c.t !== undefined ? c.t : parseDanmuTime(c.p);
        const mode = parseDanmuMode(c.p);
        const color = parseDanmuColor(c.p);
        const hexColor = decColorToHex(color);
        const modeLabel = getModeLabel(mode);

        html += '<div class="danmu-item">' +
            '<span class="danmu-time">' + formatDuration(time) + '</span>' +
            '<span class="danmu-color-dot" style="--danmu-color-dot:' + hexColor + ';" title="' + hexColor + '"></span>' +
            '<span class="danmu-mode-tag danmu-mode-' + (mode === 5 ? 'top' : mode === 4 ? 'bottom' : 'scroll') + '">' + modeLabel + '</span>' +
            '<span class="danmu-text">' + escapeHtml(c.m) + '</span>' +
            '</div>';
    }

    const container = document.getElementById('danmu-list');
    if (danmuTestState.displayedCount === 0) {
        container.innerHTML = html || '<p class="danmu-empty-text danmu-empty-list">无弹幕数据</p>';
    } else {
        container.insertAdjacentHTML('beforeend', html);
    }
    danmuTestState.displayedCount = end;

    // 控制加载更多按钮
    const loadMoreBtn = document.getElementById('danmu-load-more');
    if (end < list.length) {
        loadMoreBtn.style.display = 'block';
        loadMoreBtn.textContent = '加载更多 (' + end + '/' + list.length + ')';
    } else {
        loadMoreBtn.style.display = 'none';
    }
}

function loadMoreDanmu() {
    renderDanmuList();
}
`;
