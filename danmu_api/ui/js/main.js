import { globals } from "../../configs/globals.js";

// language=JavaScript
export const jsContent = /* javascript */ `
// 数据存储
let envVariables = {};
let currentCategory = 'database';
let editingKey = null;
let logs = [];

// 版本信息
let currentVersion = '';
let latestVersion = '';

// API 配置
const apiConfigs = {
    searchAnime: {
        name: '搜索动漫',
        method: 'GET',
        path: '/api/v2/search/anime',
        params: [
            { name: 'keyword', label: '关键词', type: 'text', required: true, placeholder: '示例: 生万物' }
        ]
    },
    searchEpisodes: {
        name: '搜索剧集',
        method: 'GET',
        path: '/api/v2/search/episodes',
        params: [
            { name: 'anime', label: '动漫名称', type: 'text', required: true, placeholder: '示例: 生万物' }
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
            { name: 'format', label: '格式', type: 'select', required: false, placeholder: '可选: json或xml', options: ['json', 'xml'] }
        ]
    }
};

// 初始化
function init() {
    // loadConfig().then(r => {
    //    
    // });
    getDockerVersion();
    loadSampleData();
    renderEnvList();
    renderPreview();
    addLog('系统初始化完成', 'success');
}

// 加载示例数据
function loadSampleData() {
    envVariables = {
        database: [
            { key: 'DB_HOST', value: '${globals.version}', description: '数据库主机地址', type: 'text' },
            { key: 'DB_PORT', value: '3306', description: '数据库端口', type: 'text' },
            { key: 'DB_NAME', value: 'myapp', description: '数据库名称', type: 'text' },
            { key: 'DB_POOL_SIZE', value: '10', description: '连接池大小 (1-100)', type: 'number', min: 1, max: 100 },
            { key: 'DB_SSL_ENABLED', value: 'true', description: '启用SSL连接', type: 'boolean' },
            { key: 'DB_REPLICAS', value: 'master,slave1,slave2', description: '数据库副本顺序', type: 'multi-select',
              options: ['master', 'slave1', 'slave2', 'slave3', 'backup'] }
        ],
        redis: [
            { key: 'REDIS_HOST', value: '127.0.0.1', description: 'Redis主机', type: 'text' },
            { key: 'REDIS_PORT', value: '6379', description: 'Redis端口', type: 'text' },
            { key: 'REDIS_CLUSTER', value: 'false', description: '启用集群模式', type: 'boolean' },
            { key: 'REDIS_MAX_RETRIES', value: '3', description: '最大重试次数 (0-10)', type: 'number', min: 0, max: 10 }
        ],
        api: [
            { key: 'API_URL', value: 'https://api.example.com', description: 'API基础地址', type: 'text' },
            { key: 'API_KEY', value: 'sk-xxxxxxxxxxxxx', description: 'API密钥', type: 'text' },
            { key: 'API_TIMEOUT', value: '30', description: '请求超时时间(秒) (5-60)', type: 'number', min: 5, max: 60 },
            { key: 'API_VERSION', value: 'v2', description: 'API版本', type: 'select', options: ['v1', 'v2', 'v3', 'beta'] },
            { key: 'ALLOWED_ORIGINS', value: 'example.com,app.example.com,admin.example.com',
              description: '允许的跨域来源 (按优先级)', type: 'multi-select',
              options: ['example.com', 'app.example.com', 'admin.example.com', 'api.example.com', 'test.example.com'] }
        ],
        system: [
            { key: 'APP_ENV', value: 'production', description: '运行环境', type: 'select', options: ['development', 'staging', 'production'] },
            { key: 'LOG_LEVEL', value: 'info', description: '日志级别', type: 'select', options: ['debug', 'info', 'warn', 'error'] },
            { key: 'DEBUG_MODE', value: 'false', description: '调试模式', type: 'boolean' },
            { key: 'MAX_WORKERS', value: '4', description: '工作进程数 (1-32)', type: 'number', min: 1, max: 32 },
            { key: 'ENABLED_FEATURES', value: 'auth,payment,analytics', description: '启用的功能模块', type: 'multi-select',
              options: ['auth', 'payment', 'analytics', 'notification', 'export', 'import'] }
        ]
    };
}

// 加载配置信息
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) {
      throw new Error(\`HTTP error! status: \${response.status}\`);
    }
    const config = await response.json();

    currentVersion = config.version;
    // envVariables = config.envs || {};

    console.log('Config loaded:', config);

    await updateVersionInfo();

  } catch (error) {
    console.error('Failed to load config:', error);
    currentVersion = 'Error';
  }
}

// 更新版本信息显示
function updateVersionInfo() {
  const versionElement = document.getElementById('current-version');
  if (versionElement) {
    versionElement.textContent = currentVersion;
  }

  const updateBadge = document.getElementById('update-badge');
  if (updateBadge) {
    updateBadge.style.display = 'inline-block';
  }
}

function getDockerVersion() {
  const url = "https://img.shields.io/docker/v/logvar/danmu-api?sort=semver";

  fetch(url)
    .then(response => response.text())
    .then(svgContent => {
      // 使用正则表达式从 SVG 中提取版本号
      const versionMatch = svgContent.match(/version<\\/text><text.*?>(v[\\d\\.]+)/);

      if (versionMatch && versionMatch[1]) {
        console.log("Version:", versionMatch[1]);
        const latestVersionElement = document.getElementById('latest-version');
        if (latestVersionElement) {
          latestVersionElement.textContent = versionMatch[1];
        }
      } else {
        console.log("Version not found");
      }
    })
    .catch(error => {
      console.error("Error fetching the SVG:", error);
    });
}

// 切换导航
function switchSection(section) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(\`\${section}-section\`).classList.add('active');
    event.target.classList.add('active');

    addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : '接口调试'}模块\`, 'info');
}

// 切换类别
function switchCategory(category) {
    currentCategory = category;
    document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    renderEnvList();
}

// 渲染环境变量列表
function renderEnvList() {
    const list = document.getElementById('env-list');
    const items = envVariables[currentCategory] || [];

    if (items.length === 0) {
        list.innerHTML = '<p style="color: #999; padding: 20px; text-align: center;">暂无配置项</p>';
        return;
    }

    list.innerHTML = items.map((item, index) => {
        const typeLabel = item.type === 'boolean' ? '布尔' :
                         item.type === 'number' ? '数字' :
                         item.type === 'select' ? '单选' :
                         item.type === 'multi-select' ? '多选' : '文本';
        const badgeClass = item.type === 'multi-select' ? 'multi' : '';

        return \`
            <div class="env-item">
                <div class="env-info">
                    <strong>\${item.key}<span class="value-type-badge \${badgeClass}">\${typeLabel}</span></strong>
                    <div style="color: #666;">\${item.value}</div>
                    <div style="color: #999; font-size: 12px; margin-top: 5px;">\${item.description || '无描述'}</div>
                </div>
                <div class="env-actions">
                    <button class="btn btn-primary" onclick="editEnv(\${index})">编辑</button>
                    <button class="btn btn-danger" onclick="deleteEnv(\${index})">删除</button>
                </div>
            </div>
        \`;
    }).join('');
}

// 渲染配置预览
function renderPreview() {
    const preview = document.getElementById('preview-area');
    let html = '';

    Object.keys(envVariables).forEach(category => {
        html += \`<h3 style="color: #667eea; margin-bottom: 10px;">\${getCategoryName(category)}</h3>\`;
        envVariables[category].forEach(item => {
            html += \`
                <div class="preview-item">
                    <strong>\${item.key}</strong> = \${item.value}
                    \${item.description ? \`<div style="color: #999; font-size: 12px; margin-top: 3px;">\${item.description}</div>\` : ''}
                </div>
            \`;
        });
    });

    preview.innerHTML = html || '<p style="color: #999;">暂无配置</p>';
}

// 获取类别名称
function getCategoryName(category) {
    const names = {
        database: '数据库配置',
        redis: 'Redis配置',
        api: 'API配置',
        system: '系统配置'
    };
    return names[category] || category;
}

// 打开添加模态框
function openAddModal() {
    editingKey = null;
    document.getElementById('modal-title').textContent = '添加环境变量';
    document.getElementById('env-category').value = currentCategory;
    document.getElementById('env-form').reset();
    renderValueInput({ type: 'text' }); // 默认文本类型
    document.getElementById('env-modal').classList.add('active');
}

// 编辑环境变量
function editEnv(index) {
    const item = envVariables[currentCategory][index];
    editingKey = index;
    document.getElementById('modal-title').textContent = '编辑环境变量';
    document.getElementById('env-category').value = currentCategory;
    document.getElementById('env-key').value = item.key;
    document.getElementById('env-description').value = item.description || '';
    document.getElementById('value-type').value = item.type || 'text';

    // 渲染对应的值输入控件
    renderValueInput(item);

    document.getElementById('env-modal').classList.add('active');
}

// 删除环境变量
function deleteEnv(index) {
    if (confirm('确定要删除这个配置项吗?')) {
        const item = envVariables[currentCategory][index];
        envVariables[currentCategory].splice(index, 1);
        renderEnvList();
        renderPreview();
        addLog(\`删除配置项: \${item.key}\`, 'warn');
    }
}

// 关闭模态框
function closeModal() {
    document.getElementById('env-modal').classList.remove('active');
}

// 表单提交
document.getElementById('env-form').addEventListener('submit', function(e) {
    e.preventDefault();

    const category = document.getElementById('env-category').value;
    const key = document.getElementById('env-key').value.trim();
    const description = document.getElementById('env-description').value.trim();
    const type = document.getElementById('value-type').value;

    // 根据类型获取值
    let value, itemData;

    if (type === 'boolean') {
        value = document.getElementById('bool-value').checked ? 'true' : 'false';
        itemData = { key, value, description, type };
    } else if (type === 'number') {
        value = document.getElementById('num-value').textContent;
        const min = parseInt(document.getElementById('num-slider').min);
        const max = parseInt(document.getElementById('num-slider').max);
        itemData = { key, value, description, type, min, max };
    } else if (type === 'select') {
        const selected = document.querySelector('.tag-option.selected');
        value = selected ? selected.dataset.value : '';
        const options = Array.from(document.querySelectorAll('.tag-option')).map(el => el.dataset.value);
        itemData = { key, value, description, type, options };
    } else if (type === 'multi-select') {
        const selectedTags = Array.from(document.querySelectorAll('.selected-tag'))
            .map(el => el.dataset.value);
        value = selectedTags.join(',');
        const options = Array.from(document.querySelectorAll('.available-tag')).map(el => el.dataset.value);
        itemData = { key, value, description, type, options };
    } else {
        value = document.getElementById('text-value').value.trim();
        itemData = { key, value, description, type };
    }

    if (!envVariables[category]) {
        envVariables[category] = [];
    }

    if (editingKey !== null) {
        envVariables[currentCategory][editingKey] = itemData;
        addLog(\`更新配置项: \${key} = \${value}\`, 'success');
    } else {
        envVariables[category].push(itemData);
        addLog(\`添加配置项: \${key} = \${value}\`, 'success');
    }

    if (category !== currentCategory) {
        currentCategory = category;
        document.querySelectorAll('.category-btn').forEach((btn, i) => {
            btn.classList.toggle('active', ['database', 'redis', 'api', 'system'][i] === category);
        });
    }

    renderEnvList();
    renderPreview();
    closeModal();
});

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

function refreshLogs() {
    addLog('刷新日志', 'info');
    addLog('系统运行正常', 'success');
    addLog(\`当前配置项总数: \${Object.values(envVariables).reduce((sum, arr) => sum + arr.length, 0)}\`, 'info');
}

function clearLogs() {
    if (confirm('确定要清空所有日志吗?')) {
        logs = [];
        renderLogs();
        addLog('日志已清空', 'warn');
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

    if (config.params.length === 0) {
        formDiv.innerHTML = '<p style="color: #999;">此接口无需参数</p>';
        return;
    }

    formDiv.innerHTML = config.params.map(param => {
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
}

function testApi() {
    const select = document.getElementById('api-select');
    const apiKey = select.value;

    if (!apiKey) {
        alert('请先选择接口');
        return;
    }

    const config = apiConfigs[apiKey];
    const params = {};

    config.params.forEach(param => {
        const value = document.getElementById(\`param-\${param.name}\`).value;
        if (value) params[param.name] = value;
    });

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
        }
    }

    // 配置请求选项
    const requestOptions = {
        method: config.method,
        headers: {
            'Content-Type': 'application/json'
        }
    };

    if (config.method === 'POST') {
        requestOptions.body = JSON.stringify(params);
    }

    // 发送真实API请求
    fetch(url, requestOptions)
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
        });
}

// 渲染值输入控件
function renderValueInput(item) {
    const container = document.getElementById('value-input-container');
    const type = item ? item.type : document.getElementById('value-type').value;
    const value = item ? item.value : '';

    if (type === 'boolean') {
        // 布尔开关
        const checked = value === 'true' || value === true;
        container.innerHTML = \`
            <label>值</label>
            <div class="switch-container">
                <label class="switch">
                    <input type="checkbox" id="bool-value" \${checked ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
                <span class="switch-label" id="bool-label">\${checked ? '启用' : '禁用'}</span>
            </div>
        \`;

        document.getElementById('bool-value').addEventListener('change', function(e) {
            document.getElementById('bool-label').textContent = e.target.checked ? '启用' : '禁用';
        });

    } else if (type === 'number') {
        // 数字滚轮
        const min = item && item.min !== undefined ? item.min : 1;
        const max = item && item.max !== undefined ? item.max : 100;
        const currentValue = value || min;

        container.innerHTML = \`
            <label>值 (\${min}-\${max})</label>
            <div class="number-picker">
                <div class="number-controls">
                    <button type="button" class="number-btn" onclick="adjustNumber(1)">▲</button>
                    <button type="button" class="number-btn" onclick="adjustNumber(-1)">▼</button>
                </div>
                <div class="number-display" id="num-value">\${currentValue}</div>
            </div>
            <div class="number-range">
                <input type="range" id="num-slider" min="\${min}" max="\${max}" value="\${currentValue}"
                       oninput="updateNumberDisplay(this.value)">
            </div>
        \`;

    } else if (type === 'select') {
        // 标签选择
        const options = item && item.options ? item.options : ['option1', 'option2', 'option3'];
        const optionsInput = item ? '' : \`
            <div class="form-group" style="margin-bottom: 15px;">
                <label>可选项 (逗号分隔)</label>
                <input type="text" id="select-options" placeholder="例如: debug,info,warn,error"
                       value="\${options.join(',')}" onchange="updateTagOptions()">
            </div>
        \`;

        container.innerHTML = \`
            \${optionsInput}
            <label>选择值</label>
            <div class="tag-selector" id="tag-selector">
                \${options.map(opt => \`
                    <div class="tag-option \${opt === value ? 'selected' : ''}"
                         data-value="\${opt}" onclick="selectTag(this)">
                        \${opt}
                    </div>
                \`).join('')}
            </div>
        \`;

    } else if (type === 'multi-select') {
        // 多选标签（可拖动排序）
        const options = item && item.options ? item.options : ['option1', 'option2', 'option3', 'option4'];
        const selectedValues = value ? value.split(',').map(v => v.trim()).filter(v => v) : [];

        const optionsInput = item ? '' : \`
            <div class="form-group" style="margin-bottom: 15px;">
                <label>可选项 (逗号分隔)</label>
                <input type="text" id="multi-options" placeholder="例如: auth,payment,analytics"
                       value="\${options.join(',')}" onchange="updateMultiOptions()">
            </div>
        \`;

        container.innerHTML = \`
            \${optionsInput}
            <label>已选择 (拖动调整顺序)</label>
            <div class="multi-select-container">
                <div class="selected-tags \${selectedValues.length === 0 ? 'empty' : ''}" id="selected-tags">
                    \${selectedValues.map(val => \`
                        <div class="selected-tag" draggable="true" data-value="\${val}">
                            <span class="tag-text">\${val}</span>
                            <button type="button" class="remove-btn" onclick="removeSelectedTag(this)">×</button>
                        </div>
                    \`).join('')}
                </div>
                <label>可选项 (点击添加)</label>
                <div class="available-tags" id="available-tags">
                    \${options.map(opt => {
                        const isSelected = selectedValues.includes(opt);
                        return \`
                            <div class="available-tag \${isSelected ? 'disabled' : ''}"
                                 data-value="\${opt}" onclick="addSelectedTag(this)">
                                \${opt}
                            </div>
                        \`;
                    }).join('')}
                </div>
            </div>
        \`;

        // 设置拖动事件
        setupDragAndDrop();

    } else {
        // 文本输入
        container.innerHTML = \`
            <label>变量值</label>
            <input type="text" id="text-value" placeholder="例如: localhost" value="\${value}" required>
        \`;
    }
}

// 调整数字
function adjustNumber(delta) {
    const display = document.getElementById('num-value');
    const slider = document.getElementById('num-slider');
    let value = parseInt(display.textContent) + delta;

    value = Math.max(parseInt(slider.min), Math.min(parseInt(slider.max), value));

    display.textContent = value;
    slider.value = value;
}

// 更新数字显示
function updateNumberDisplay(value) {
    document.getElementById('num-value').textContent = value;
}

// 选择标签
function selectTag(element) {
    document.querySelectorAll('.tag-option').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
}

// 更新标签选项
function updateTagOptions() {
    const input = document.getElementById('select-options');
    const options = input.value.split(',').map(s => s.trim()).filter(s => s);
    const container = document.getElementById('tag-selector');

    container.innerHTML = options.map(opt => \`
        <div class="tag-option" data-value="\${opt}" onclick="selectTag(this)">
            \${opt}
        </div>
    \`).join('');
}

// 添加已选标签
function addSelectedTag(element) {
    if (element.classList.contains('disabled')) return;

    const value = element.dataset.value;
    const container = document.getElementById('selected-tags');

    // 移除empty类
    container.classList.remove('empty');

    // 创建新标签
    const tag = document.createElement('div');
    tag.className = 'selected-tag';
    tag.draggable = true;
    tag.dataset.value = value;
    tag.innerHTML = \`
        <span class="tag-text">\${value}</span>
        <button type="button" class="remove-btn" onclick="removeSelectedTag(this)">×</button>
    \`;

    container.appendChild(tag);

    // 禁用可选项
    element.classList.add('disabled');

    // 重新设置拖动事件
    setupDragAndDrop();
}

// 移除已选标签
function removeSelectedTag(button) {
    const tag = button.parentElement;
    const value = tag.dataset.value;
    const container = document.getElementById('selected-tags');

    // 移除标签
    tag.remove();

    // 如果没有标签了，添加empty类
    if (container.children.length === 0) {
        container.classList.add('empty');
    }

    // 启用对应的可选项
    const availableTag = document.querySelector(\`.available-tag[data-value="\${value}"]\`);
    if (availableTag) {
        availableTag.classList.remove('disabled');
    }
}

// 更新多选选项
function updateMultiOptions() {
    const input = document.getElementById('multi-options');
    const options = input.value.split(',').map(s => s.trim()).filter(s => s);
    const selectedValues = Array.from(document.querySelectorAll('.selected-tag'))
        .map(el => el.dataset.value);

    const container = document.getElementById('available-tags');
    container.innerHTML = options.map(opt => {
        const isSelected = selectedValues.includes(opt);
        return \`
            <div class="available-tag \${isSelected ? 'disabled' : ''}"
                 data-value="\${opt}" onclick="addSelectedTag(this)">
                \${opt}
            </div>
        \`;
    }).join('');
}

// 设置拖放功能
let draggedElement = null;

function setupDragAndDrop() {
    const container = document.getElementById('selected-tags');
    const tags = container.querySelectorAll('.selected-tag');

    tags.forEach(tag => {
        tag.addEventListener('dragstart', handleDragStart);
        tag.addEventListener('dragend', handleDragEnd);
        tag.addEventListener('dragover', handleDragOver);
        tag.addEventListener('drop', handleDrop);
        tag.addEventListener('dragenter', handleDragEnter);
        tag.addEventListener('dragleave', handleDragLeave);
    });
}

function handleDragStart(e) {
    draggedElement = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.selected-tag').forEach(tag => {
        tag.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDragEnter(e) {
    if (this !== draggedElement) {
        this.classList.add('drag-over');
    }
}

function handleDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    if (draggedElement !== this) {
        const container = document.getElementById('selected-tags');
        const allTags = Array.from(container.querySelectorAll('.selected-tag'));
        const draggedIndex = allTags.indexOf(draggedElement);
        const targetIndex = allTags.indexOf(this);

        if (draggedIndex < targetIndex) {
            this.parentNode.insertBefore(draggedElement, this.nextSibling);
        } else {
            this.parentNode.insertBefore(draggedElement, this);
        }
    }

    this.classList.remove('drag-over');
    return false;
}

// 显示清理缓存确认模态框
function showClearCacheModal() {
    document.getElementById('clear-cache-modal').classList.add('active');
}

// 隐藏清理缓存确认模态框
function hideClearCacheModal() {
    document.getElementById('clear-cache-modal').classList.remove('active');
}

// 确认清理缓存
function confirmClearCache() {
    hideClearCacheModal();
    showLoading('正在清理缓存...', '清除中，请稍候');
    addLog('开始清理缓存', 'info');

    // 模拟清理过程
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress >= 100) {
            progress = 100;
            clearInterval(progressInterval);
        }
        updateProgress(progress);
    }, 200);

    setTimeout(() => {
        updateLoadingText('清理Redis缓存...', '已清理 234 个键');
        addLog('Redis缓存清理完成: 234 个键', 'success');
    }, 1000);

    setTimeout(() => {
        updateLoadingText('清理文件缓存...', '扫描临时文件');
        addLog('正在清理文件缓存', 'info');
    }, 2000);

    setTimeout(() => {
        updateLoadingText('清理会话缓存...', '清除过期会话');
        addLog('会话缓存清理完成', 'success');
    }, 3000);

    setTimeout(() => {
        hideLoading();
        addLog('缓存清理完成，释放空间: 125.8 MB', 'success');
        alert('✅ 缓存清理成功！\\n\\n已清理:\\n• Redis: 234 个键\\n• 文件缓存: 1,892 个文件\\n• 释放空间: 125.8 MB');
    }, 4000);
}

// 显示重新部署确认模态框
function showDeploySystemModal() {
    document.getElementById('deploy-system-modal').classList.add('active');
}

// 隐藏重新部署确认模态框
function hideDeploySystemModal() {
    document.getElementById('deploy-system-modal').classList.remove('active');
}

// 确认重新部署系统
function confirmDeploySystem() {
    hideDeploySystemModal();
    showLoading('准备部署...', '正在检查系统状态');
    addLog('===== 开始系统部署 =====', 'info');

    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 8;
        if (progress >= 100) {
            progress = 100;
            clearInterval(progressInterval);
        }
        updateProgress(progress);
    }, 300);

    // 模拟部署步骤
    const steps = [
        { delay: 1000, text: '检查环境变量...', detail: '验证配置文件', log: '配置文件验证通过' },
        { delay: 2000, text: '拉取最新代码...', detail: 'Git pull origin main', log: '代码更新完成: commit abc1234' },
        { delay: 3500, text: '安装依赖...', detail: 'npm install', log: '依赖安装完成: 45 个包' },
        { delay: 5000, text: '构建项目...', detail: 'npm run build', log: '构建完成: 生成 dist 目录' },
        { delay: 6500, text: '重启服务...', detail: 'pm2 restart all', log: '服务重启成功' },
        { delay: 8000, text: '健康检查...', detail: '验证服务状态', log: '所有服务运行正常' },
    ];

    steps.forEach(step => {
        setTimeout(() => {
            updateLoadingText(step.text, step.detail);
            addLog(step.log, 'success');
        }, step.delay);
    });

    setTimeout(() => {
        hideLoading();
        addLog('===== 部署完成 =====', 'success');
        addLog(\`部署版本: \${latestVersion}\`, 'info');
        addLog('系统已更新并重启', 'success');
        alert('🎉 部署成功！\\n\\n✅ 代码已更新\\n✅ 服务已重启\\n✅ 配置已生效\\n\\n系统版本: ' + latestVersion);
    }, 9000);
}

// 显示加载遮罩
function showLoading(text, detail) {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-detail').textContent = detail;
    document.getElementById('loading-overlay').classList.add('active');
    document.getElementById('progress-container').classList.add('active');
    updateProgress(0);
}

// 隐藏加载遮罩
function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
    setTimeout(() => {
        document.getElementById('progress-container').classList.remove('active');
        updateProgress(0);
    }, 300);
}

// 更新加载文本
function updateLoadingText(text, detail) {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-detail').textContent = detail;
}

// 更新进度条
function updateProgress(percent) {
    document.getElementById('progress-bar').style.width = percent + '%';
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

// 页面加载完成后初始化
init();
`;
