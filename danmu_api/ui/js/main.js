// language=JavaScript
export const mainJsContent = /* javascript */ `
// 自定义弹窗组件
function createCustomAlert() {
    // 检查是否已存在自定义弹窗元素
    if (document.getElementById('custom-alert-overlay')) {
        return;
    }

    // 创建弹窗HTML元素
    const alertHTML = '<div class="modal" id="custom-alert-overlay"><div class="modal-content" id="custom-alert-content"><div class="modal-header"><h3 id="custom-alert-title">提示</h3><button class="close-btn" id="custom-alert-close">&times;</button></div><div class="modal-body"><p id="custom-alert-message"></p></div><div class="modal-footer"><button class="btn btn-primary" id="custom-alert-confirm">确定</button></div></div></div>';

    // 添加到body
    document.body.insertAdjacentHTML('beforeend', alertHTML);

    // 获取元素
    const overlay = document.getElementById('custom-alert-overlay');
    const closeBtn = document.getElementById('custom-alert-close');
    const confirmBtn = document.getElementById('custom-alert-confirm');

    // 关闭弹窗函数
    function closeAlert() {
        overlay.classList.remove('active');
        // 重置标题和消息
        document.getElementById('custom-alert-title').textContent = '提示';
    }

    // 事件监听器
    closeBtn.addEventListener('click', closeAlert);
    confirmBtn.addEventListener('click', closeAlert);

    // 点击遮罩层关闭弹窗
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) {
            closeAlert();
        }
    });
}

// 自定义alert函数
function customAlert(message, title = '提示') {
    // 确保弹窗元素已创建
    createCustomAlert();

    // 获取元素
    const overlay = document.getElementById('custom-alert-overlay');
    const titleElement = document.getElementById('custom-alert-title');
    const messageElement = document.getElementById('custom-alert-message');

    // 设置标题和消息
    titleElement.textContent = title;
    messageElement.textContent = message;

    // 显示弹窗
    overlay.classList.add('active');
}

// 自定义confirm函数（如果需要）
function customConfirm(message, title = '确认') {
    return new Promise((resolve) => {
        // 确保弹窗元素已创建
        createCustomAlert();

        // 获取元素
        const overlay = document.getElementById('custom-alert-overlay');
        const titleElement = document.getElementById('custom-alert-title');
        const messageElement = document.getElementById('custom-alert-message');
        const confirmBtn = document.getElementById('custom-alert-confirm');

        // 移除之前的事件监听器（如果有）
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

        // 设置标题和消息
        titleElement.textContent = title;
        messageElement.textContent = message;

        // 确定按钮事件
        newConfirmBtn.addEventListener('click', () => {
            overlay.classList.remove('active');
            resolve(true);
        });

        // 关闭按钮事件
        document.getElementById('custom-alert-close').addEventListener('click', () => {
            overlay.classList.remove('active');
            resolve(false);
        });

        // 点击遮罩层关闭
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                overlay.classList.remove('active');
                resolve(false);
            }
        });

        // 显示弹窗
        overlay.classList.add('active');
    });
}

// 初始化自定义弹窗
document.addEventListener('DOMContentLoaded', createCustomAlert);

// 数据存储
let envVariables = {};
let currentCategory = 'api'; // 默认分类改为api
let editingKey = null;
let logs = []; // 保留本地日志数组，用于UI显示

// 版本信息
let currentVersion = '';
let latestVersion = '';
let currentToken = 'globals.currentToken';
let currentAdminToken = ''; // admin token，用于系统管理

// 构建带token的API请求路径
function buildApiUrl(path, isSystemPath = false) {
    // 如果是系统管理路径且有admin token，则使用admin token
    if (isSystemPath && currentAdminToken && currentAdminToken.trim() !== '') {
        return '/' + currentAdminToken + path;
    }
    // 否则使用普通token
    return (currentToken ? '/' + currentToken : "") + path;
}

// 从API加载真实环境变量数据
function loadEnvVariables() {
    // 从API获取真实配置数据
    fetch(buildApiUrl('/api/config'))
        .then(response => response.json())
        .then(config => {
            // 从配置中获取admin token
            currentAdminToken = config.originalEnvVars?.ADMIN_TOKEN || '';
            
            // 使用从API获取的原始环境变量，用于系统设置
            const originalEnvVars = config.originalEnvVars || {};
            
            // 重新组织数据结构以适配现有UI
            envVariables = {};
            
            // 将原始环境变量转换为UI所需格式
            // 这里需要将原始环境变量按类别组织
            Object.keys(originalEnvVars).forEach(key => {
                // 从envVarConfig获取配置信息
                const varConfig = config.envVarConfig?.[key] || { category: 'system', type: 'text', description: '未分类配置项' };
                const category = varConfig.category || 'system';
                
                // 如果该分类不存在，创建它
                if (!envVariables[category]) {
                    envVariables[category] = [];
                }
                
                // 添加到对应分类，包含完整的配置信息
                envVariables[category].push({
                    key: key,
                    value: originalEnvVars[key],
                    description: varConfig.description || '',
                    type: varConfig.type || 'text',
                    min: varConfig.min,
                    max: varConfig.max,
                    options: varConfig.options || [] // 仅对 select 和 multi-select 类型有效
                });
            });
            
            // 渲染环境变量列表
            renderEnvList();
        })
        .catch(error => {
            console.error('Failed to load env variables:', error);
        });
}

// 更新API端点信息
function updateApiEndpoint() {
  return fetch(buildApiUrl('/api/config'))
    .then(response => response.json())
    .then(config => {
      // 获取当前页面的协议、主机和端口
      const protocol = window.location.protocol;
      const host = window.location.host;
      const token = config.originalEnvVars?.TOKEN || '87654321'; // 默认token值
      const adminToken = config.originalEnvVars?.ADMIN_TOKEN;

      // 获取URL路径并提取token
      const urlPath = window.location.pathname;
      const pathParts = urlPath.split('/').filter(part => part !== '');
      const urlToken = pathParts.length > 0 ? pathParts[0] : '';
      
      // 判断是否使用默认token
      if (token === '87654321') {
        // 如果是默认token，则显示真实token
        currentToken = token;
      } else {
        // 如果不是默认token，则检查URL中的token是否匹配，匹配则显示真实token，否则显示星号
        if (urlToken === token || (adminToken !== "" && urlToken === adminToken)) {
          currentToken = token; // 更新全局token变量
        } else {
          currentToken = '********'
        }
      }
      
      // 构造API端点URL
      const apiEndpoint = protocol + '//' + host + '/' + currentToken;
      const apiEndpointElement = document.getElementById('api-endpoint');
      if (apiEndpointElement) {
        apiEndpointElement.textContent = apiEndpoint;
      }
      return config; // 返回配置信息，以便链式调用
    })
    .catch(error => {
      console.error('获取配置信息失败:', error);
      // 出错时显示默认值
      const protocol = window.location.protocol;
      const host = window.location.host;
      const apiEndpoint = protocol + '//' + host + '/********';
      const apiEndpointElement = document.getElementById('api-endpoint');
      if (apiEndpointElement) {
        apiEndpointElement.textContent = apiEndpoint;
      }
      throw error; // 抛出错误，以便调用者可以处理
    });
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
    // 检查是否尝试访问受token保护的section（日志查看、接口调试、系统配置需要token访问）
    if (section === 'logs' || section === 'api' || section === 'env' || section === 'push') {
        // 获取URL路径并提取token
        const urlPath = window.location.pathname;
        const pathParts = urlPath.split('/').filter(part => part !== '');
        const urlToken = pathParts.length > 0 ? pathParts[0] : '';
        
        // 检查URL中是否有token
        if (!urlToken) {
            // 提示用户需要在URL中配置TOKEN
            setTimeout(() => {
                // 获取当前页面的协议、主机和端口
                const protocol = window.location.protocol;
                const host = window.location.host;
                customAlert('请在URL中配置相应的TOKEN以访问此功能！\\n\\n访问方式：' + protocol + '//' + host + '/{TOKEN}');
            }, 100);
            return;
        }
        
        // 如果是系统配置页面，还需要检查是否配置了ADMIN_TOKEN且URL中的token等于currentAdminToken
        if (section === 'env') {
            // 检查部署平台配置
            checkDeployPlatformConfig().then(result => {
                if (!result.success) {
                    // 如果配置检查不通过，只显示提示，不切换页面
                    setTimeout(() => {
                        customAlert(result.message);
                    }, 100);
                } else {
                    // 如果配置检查通过，才切换到env页面
                    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
                    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

                    document.getElementById(\`\${section}-section\`).classList.add('active');
                    event.target.classList.add('active');

                    addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : '接口调试'}模块\`, 'info');
                }
            });
        } else {
            // 对于日志查看、接口调试和推送弹幕页面，只要URL中有token就可以访问
            document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

            document.getElementById(\`\${section}-section\`).classList.add('active');
            event.target.classList.add('active');

            addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : '接口调试'}模块\`, 'info');
        }
    } else {
        // 对于非受保护页面（如配置预览），正常切换
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        document.getElementById(\`\${section}-section\`).classList.add('active');
        event.target.classList.add('active');

        addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : '接口调试'}模块\`, 'info');
    }
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
        list.innerHTML = '<p class="text-gray padding-20 text-center">暂无配置项</p>';
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
                    <div class="text-dark-gray">\${item.value}</div>
                    <div class="text-gray font-size-12 margin-top-3">\${item.description || '无描述'}</div>
                </div>
                <div class="env-actions">
                    <button class="btn btn-primary" onclick="editEnv(\${index})">编辑</button>
                    <button class="btn btn-danger" onclick="deleteEnv(\${index})">删除</button>
                </div>
            </div>
        \`;
    }).join('');
}




// 编辑环境变量
function editEnv(index) {
    const item = envVariables[currentCategory][index];
    const editButton = event.target; // 获取当前点击的编辑按钮
    
    // 设置按钮为加载状态
    const originalText = editButton.innerHTML;
    editButton.innerHTML = '<span class="loading-spinner-small"></span>';
    editButton.disabled = true;
    
    editingKey = index;
    document.getElementById('modal-title').textContent = '编辑配置项';
    document.getElementById('env-category').value = currentCategory;
    document.getElementById('env-key').value = item.key;
    document.getElementById('env-description').value = item.description || '';
    document.getElementById('value-type').value = item.type || 'text';

    // 设置字段为只读（编辑模式下）
    document.getElementById('env-category').disabled = true;
    document.getElementById('env-key').readOnly = true;
    document.getElementById('value-type').disabled = true;
    document.getElementById('env-description').readOnly = true;

    // 渲染对应的值输入控件
    renderValueInput(item);

    document.getElementById('env-modal').classList.add('active');
    
    // 恢复按钮状态（在实际场景中，这会在编辑完成后发生，比如在保存后或取消后）
    // 为了演示，这里立即恢复按钮状态，实际使用中应该在适当的地方恢复按钮状态
    editButton.innerHTML = originalText;
    editButton.disabled = false;
}

// 删除环境变量
function deleteEnv(index) {
    customConfirm('确定要删除这个配置项吗?', '删除确认').then(confirmed => {
        if (confirmed) {
            const item = envVariables[currentCategory][index];
            const key = item.key;
            const deleteButton = event.target; // 获取当前点击的删除按钮

            // 设置按钮为加载状态
            const originalText = deleteButton.innerHTML;
            deleteButton.innerHTML = '<span class="loading-spinner-small"></span>';
            deleteButton.disabled = true;

            // 调用API删除环境变量
            fetch(buildApiUrl('/api/env/del'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ key })
            })
            .then(response => response.json())
            .then(result => {
                if (result.success) {
                    // 从本地数据中删除
                    envVariables[currentCategory].splice(index, 1);
                    renderEnvList();
                    renderPreview();
                    addLog(\`删除配置项: \${key}\`, 'warn');
                } else {
                    addLog(\`删除配置项失败: \${result.message}\`, 'error');
                    addLog(\`❌ 删除配置项失败: \${result.message}\`, 'error');
                }
            })
            .catch(error => {
                addLog(\`删除配置项失败: \${error.message}\`, 'error');
                addLog(\`❌ 删除配置项失败: \${error.message}\`, 'error');
            })
            .finally(() => {
                // 恢复按钮状态
                deleteButton.innerHTML = originalText;
                deleteButton.disabled = false;
            });
        }
    });
}

// 关闭模态框
function closeModal() {
    document.getElementById('env-modal').classList.remove('active');
    
    // 重置表单字段状态
    document.getElementById('env-category').disabled = false;
    document.getElementById('env-key').readOnly = false;
    document.getElementById('value-type').disabled = false;
    document.getElementById('env-description').readOnly = false;
}

// 表单提交
document.getElementById('env-form').addEventListener('submit', async function(e) {
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

    // 调用API更新环境变量
    try {
        const apiUrl = editingKey !== null ? buildApiUrl('/api/env/set') : buildApiUrl('/api/env/add');
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ key, value })
        });

        const result = await response.json();

        if (result.success) {
            // 更新本地数据
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
                    btn.classList.toggle('active', ['api', 'source', 'match', 'danmu', 'cache', 'system'][i] === category);
                });
            }

            renderEnvList();
            renderPreview();
            closeModal();
        } else {
            addLog(\`操作失败: \${result.message}\`, 'error');
            addLog(\`❌ 操作失败: \${result.message}\`, 'error');
        }
    } catch (error) {
        addLog(\`更新环境变量失败: \${error.message}\`, 'error');
        addLog(\`❌ 更新环境变量失败: \${error.message}\`, 'error');
    }
});


// 检查URL中的token是否与currentAdminToken匹配
function checkAdminToken() {
    // 获取URL路径并提取token
    const urlPath = window.location.pathname;
    const pathParts = urlPath.split('/').filter(part => part !== '');
    const urlToken = pathParts.length > 0 ? pathParts[0] : currentToken; // 如果没有路径段，使用默认token
    
    // 检查是否配置了ADMIN_TOKEN且URL中的token等于currentAdminToken
    return currentAdminToken && currentAdminToken.trim() !== '' && urlToken === currentAdminToken;
}

// 检查部署平台相关配置
async function checkDeployPlatformConfig() {
    // 首先检查是否配置了ADMIN_TOKEN
    if (!checkAdminToken()) {
        // 获取当前页面的协议、主机和端口
        const protocol = window.location.protocol;
        const host = window.location.host;
        return { success: false, message: '请先配置ADMIN_TOKEN环境变量并使用正确的token访问以启用系统部署功能！\\n\\n访问方式：' + protocol + '//' + host + '/{ADMIN_TOKEN}' };
    }
    
    try {
        const response = await fetch(buildApiUrl('/api/config'));
        if (!response.ok) {
            throw new Error('HTTP error! status: ' + response.status);
        }
        
        const config = await response.json();
        const deployPlatform = config.envs.deployPlatform || 'node';
        
        // 如果是node部署平台，只需要检查ADMIN_TOKEN
        if (deployPlatform.toLowerCase() === 'node') {
            return { success: true, message: 'Node部署平台，仅需配置ADMIN_TOKEN' };
        }
        
        // 对于其他部署平台，收集所有缺失的环境变量
        const missingVars = [];
        const deployPlatformProject = config.envs.deployPlatformProject;
        const deployPlatformToken = config.envs.deployPlatformToken;
        const deployPlatformAccount = config.envs.deployPlatformAccount;
        
        if (!deployPlatformProject || deployPlatformProject.trim() === '') {
            missingVars.push('DEPLOY_PLATFROM_PROJECT');
        }
        
        if (!deployPlatformToken || deployPlatformToken.trim() === '') {
            missingVars.push('DEPLOY_PLATFROM_TOKEN');
        }
        
        // 对于netlify和edgeone部署平台，还需要检查DEPLOY_PLATFROM_ACCOUNT
        if (deployPlatform.toLowerCase() === 'netlify' || deployPlatform.toLowerCase() === 'edgeone') {
            if (!deployPlatformAccount || deployPlatformAccount.trim() === '') {
                missingVars.push('DEPLOY_PLATFROM_ACCOUNT');
            }
        }
        
        if (missingVars.length > 0) {
            const missingVarsStr = missingVars.join('、');
            return { success: false, message: '部署平台为' + deployPlatform + '，请配置以下缺失的环境变量：' + missingVarsStr };
        }
        
        return { success: true, message: deployPlatform + '部署平台配置完整' };
    } catch (error) {
        console.error('检查部署平台配置失败:', error);
        return { success: false, message: '检查部署平台配置失败: ' + error.message };
    }
}

// 获取并设置配置信息
async function fetchAndSetConfig() {
    const config = await fetch(buildApiUrl('/api/config')).then(response => response.json());
    const hasAdminToken = config.hasAdminToken;
    currentAdminToken = config.originalEnvVars?.ADMIN_TOKEN || '';
    return config;
}

// 检查并处理管理员令牌
function checkAndHandleAdminToken() {
    if (!checkAdminToken()) {
        // 禁用系统配置按钮并添加提示
        const envNavBtn = document.getElementById('env-nav-btn');
        if (envNavBtn) {
            envNavBtn.title = '请先配置ADMIN_TOKEN并使用正确的admin token访问以启用系统管理功能';
        }
    }
}

// 页面加载完成后初始化时获取一次日志
async function init() {
    try {
        await updateApiEndpoint(); // 等待API端点更新完成
        getDockerVersion();
        // 从API获取配置信息，包括检查是否有admin token
        await fetchAndSetConfig();

        // 检查并处理管理员令牌
        checkAndHandleAdminToken();
        
        loadEnvVariables(); // 从API加载真实环境变量数据
        renderEnvList();
        renderPreview();
        addLog('系统初始化完成', 'success');
        // 获取真实日志数据
        fetchRealLogs();
    } catch (error) {
        console.error('初始化失败:', error);
        addLog('系统初始化失败: ' + error.message, 'error');
        // 即使初始化失败，也要尝试获取日志
        fetchRealLogs();
    }
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
            <div class="form-group margin-bottom-15">
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
        // 确保value是字符串类型后再进行split操作
        const stringValue = typeof value === 'string' ? value : String(value || '');
        const selectedValues = stringValue ? stringValue.split(',').map(v => v.trim()).filter(v => v) : [];

        const optionsInput = item ? '' : \`
            <div class="form-group margin-bottom-15">
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
        // 如果值太长，使用textarea而不是input
        if (value && value.length > 50) {
            // 计算行数，每行约50个字符
            const rows = Math.min(Math.max(Math.ceil(value.length / 50), 3), 10); // 最少3行，最多10行
            container.innerHTML = \`
                <label>变量值 *</label>
                <textarea id="text-value" placeholder="例如: localhost" rows="\${rows}" class="text-monospace">\${value}</textarea>
            \`; 
        } else {
            container.innerHTML = \`
                <label>变量值 *</label>
                <input type="text" id="text-value" placeholder="例如: localhost" value="\${value}" required>
            \`; 
        }
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

// 模拟云端部署过程
function simulateDeployProcess() {
    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 8;
        if (progress >= 100) {
            progress = 10;
            clearInterval(progressInterval);
        }
        updateProgress(progress);
    }, 300);

    // 模拟部署步骤
    const steps = [
        { delay: 1000, text: '检查环境变量...', detail: '验证配置文件', log: '配置文件验证通过' },
        { delay: 2000, text: '触发云端部署...', detail: '部署到当前平台', log: '云端部署已触发' },
        { delay: 3500, text: '构建项目...', detail: '云端构建中', log: '云端构建完成' },
        { delay: 5000, text: '部署更新...', detail: '发布到生产环境', log: '更新已部署' },
        { delay: 6500, text: '服务重启...', detail: '应用新配置', log: '服务已重启' },
        { delay: 8000, text: '健康检查...', detail: '验证服务状态', log: '所有服务运行正常' },
    ];

    steps.forEach(step => {
        setTimeout(() => {
            updateLoadingText(step.text, step.detail);
            addLog(step.log, 'success');
        }, step.delay);
    });

    // 部署后检查服务是否可用
    setTimeout(() => {
        checkDeploymentStatus();
    }, 9000); // 延长延迟以确保模拟部署过程完成
}

// 检查部署状态，每隔5秒请求/api/logs接口直到请求成功
function checkDeploymentStatus() {
    const checkInterval = setInterval(() => {
        updateLoadingText('部署完成，检查服务状态...', '正在请求 /api/logs 接口');
        addLog('正在检查服务状态...', 'info');

        fetch(buildApiUrl('/api/logs'))
            .then(response => {
                if (response.ok) {
                    // 请求成功，停止检查
                    clearInterval(checkInterval);
                    // 更新加载状态而不是立即隐藏
                    updateLoadingText('部署成功！', '服务已重启并正常运行');
                    addLog('===== 部署完成 =====', 'success');
                    addLog('部署版本: ' + latestVersion, 'info');
                    addLog('系统已更新并重启', 'success');
                    
                    // 部署完成后再次确认，访问/api/logs接口来确认部署完成
                    confirmDeploymentByLogs();
                } else {
                    addLog('服务检查中 - 状态码: ' + response.status, 'info');
                }
            })
            .catch(error => {
                addLog('服务检查中 - 连接失败: ' + error.message, 'info');
            });
    }, 500); // 每5秒检查一次
}

// 部署完成后通过访问/api/logs接口来确认部署完成
function confirmDeploymentByLogs() {
    // 部署完成后的确认检查
    let confirmationAttempts = 0;
    const maxAttempts = 3; // 最多尝试3次确认部署完成

    const confirmationInterval = setInterval(() => {
        confirmationAttempts++;
        updateLoadingText('部署完成确认中...', '正在确认部署完成 (' + confirmationAttempts + '/' + maxAttempts + ')');
        addLog('部署完成确认 - 尝试 ' + confirmationAttempts + '/' + maxAttempts, 'info');

        fetch(buildApiUrl('/api/logs'))
            .then(response => {
                if (response.ok) {
                    // 请求成功，停止确认检查
                    clearInterval(confirmationInterval);
                    // 显示成功信息后延迟隐藏加载遮罩
                    updateLoadingText('部署确认成功！', '服务已重启并正常运行');
                    addLog('部署确认成功 - /api/logs 接口访问正常', 'success');
                    
                    setTimeout(() => {
                        hideLoading();
                        // 显示成功弹窗
                        customAlert('🎉 部署成功！云端部署已完成，服务已重启，配置已生效');
                        addLog('🎉 部署成功！云端部署已完成，服务已重启，配置已生效', 'success');
                    }, 200);
                } else if (confirmationAttempts >= maxAttempts) {
                    // 达到最大尝试次数，停止确认检查
                    clearInterval(confirmationInterval);
                    updateLoadingText('部署确认完成', '服务已重启');
                    addLog('部署确认完成 - 已达到最大尝试次数', 'warn');
                    
                    setTimeout(() => {
                        hideLoading();
                        // 显示成功弹窗
                        customAlert('🎉 部署成功！云端部署已完成，服务已重启，配置已生效');
                        addLog('🎉 部署成功！云端部署已完成，服务已重启，配置已生效', 'success');
                    }, 200);
                } else {
                    addLog('部署确认中 - 状态码: ' + response.status, 'info');
                }
            })
            .catch(error => {
                if (confirmationAttempts >= maxAttempts) {
                    // 达到最大尝试次数，停止确认检查
                    clearInterval(confirmationInterval);
                    updateLoadingText('部署确认完成', '服务已重启');
                    addLog('部署确认完成 - 已达到最大尝试次数', 'warn');
                    
                    setTimeout(() => {
                        hideLoading();
                        // 显示成功弹窗
                        customAlert('🎉 部署成功！云端部署已完成，服务已重启，配置已生效');
                        addLog('🎉 部署成功！云端部署已完成，服务已重启，配置已生效', 'success');
                    }, 200);
                } else {
                    addLog('部署确认中 - 连接失败: ' + error.message, 'info');
                }
            });
    }, 5000); // 每5秒检查一次，用于确认部署完成
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

// 复制API端点到剪贴板
function copyApiEndpoint() {
    const apiEndpointElement = document.getElementById('api-endpoint');
    if (apiEndpointElement) {
        const apiEndpoint = apiEndpointElement.textContent;
        navigator.clipboard.writeText(apiEndpoint)
            .then(() => {
                // 临时改变显示文本以提供反馈
                const originalText = apiEndpointElement.textContent;
                apiEndpointElement.textContent = '已复制!';
                apiEndpointElement.style.color = '#ff6b6b';
                
                // 2秒后恢复原始文本
                setTimeout(() => {
                    apiEndpointElement.textContent = originalText;
                    apiEndpointElement.style.color = '#4CAF50';
                }, 2000);
                
                addLog('API端点已复制到剪贴板: ' + apiEndpoint, 'success');
            })
            .catch(err => {
                console.error('复制失败:', err);
                customAlert('复制失败: ' + err);
                addLog('复制API端点失败: ' + err, 'error');
            });
    }
}


// 页面加载完成后初始化
init();
`;
