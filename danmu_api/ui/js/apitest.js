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

// 初始化接口调试界面
function initApiTestInterface() {
    // 为API选择下拉框添加回车事件监听
    const apiSelect = document.getElementById('api-select');
    if (apiSelect) {
        apiSelect.addEventListener('keypress', function(event) {
            if (event.key === 'Enter') {
                loadApiParams();
            }
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
                    <div class="form-group">
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
                <div class="form-group">
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
`;
