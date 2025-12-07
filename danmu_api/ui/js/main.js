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
let originalToken = '';

// 构建带token的API请求路径
function buildApiUrl(path, isSystemPath = false) {
    // 如果是系统管理路径且有admin token，则使用admin token
    if (isSystemPath && currentAdminToken && currentAdminToken.trim() !== '' && currentAdminToken.trim() !== '*'.repeat(currentAdminToken.length)) {
        return '/' + currentAdminToken + path;
    }
    // 否则使用普通token
    return (currentToken ? '/' + currentToken : "") + path;
}

// 从API加载真实环境变量数据
function loadEnvVariables() {
    // 从API获取真实配置数据
    fetch(buildApiUrl('/api/config', true))
        .then(response => response.json())
        .then(config => {
            // 从配置中获取admin token
            currentAdminToken = config.originalEnvVars?.ADMIN_TOKEN || '';

            originalToken = config.originalEnvVars?.TOKEN || '';
            
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
  return fetch(buildApiUrl('/api/config', true))
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
      let apiToken = '********';
      
      // 判断是否使用默认token
      if (token === '87654321') {
        // 如果是默认token，则显示真实token
        apiToken = token;
      } else {
        // 如果不是默认token，则检查URL中的token是否匹配，匹配则显示真实token，否则显示星号
        if (urlToken === token || (adminToken !== "" && urlToken === adminToken)) {
          apiToken = token; // 更新全局token变量
        }
      }
      
      // 构造API端点URL
      const apiEndpoint = protocol + '//' + host + '/' + apiToken;
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
        if (!urlToken && originalToken !== "87654321") {
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

// 关闭模态框
function closeModal() {
    document.getElementById('env-modal').classList.remove('active');
    
    // 重置表单字段状态
    document.getElementById('env-category').disabled = false;
    document.getElementById('env-key').readOnly = false;
    document.getElementById('value-type').disabled = false;
    document.getElementById('env-description').readOnly = false;
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
