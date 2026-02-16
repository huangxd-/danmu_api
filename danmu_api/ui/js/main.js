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

// 反向代理/API基础路径配置
// 从LocalStorage获取用户自定义的Base URL
let customBaseUrl = localStorage.getItem('logvar_api_base_url') || '';

// 保存自定义Base URL (为空则清除)
function saveBaseUrl() {
    const input = document.getElementById('custom-base-url').value.trim();
    if (input) {
        // 确保URL不以斜杠结尾，方便后续拼接
        let formattedUrl = input;
        if (formattedUrl.endsWith('/')) {
            formattedUrl = formattedUrl.slice(0, -1);
        }
        localStorage.setItem('logvar_api_base_url', formattedUrl);
        customBaseUrl = formattedUrl;
        customAlert('API地址配置已保存，即将刷新页面。', '保存成功');
        setTimeout(() => {
            location.reload();
        }, 1000);
    } else {
        // 输入为空，视为清除配置/重置为默认
        localStorage.removeItem('logvar_api_base_url');
        customBaseUrl = '';
        customAlert('配置已重置为默认状态，即将刷新页面。', '操作成功');
        setTimeout(() => {
            location.reload();
        }, 1000);
    }
}

// 构建带token的API请求路径
function buildApiUrl(path, isSystemPath = false) {
    let res;
    // 如果是系统管理路径且有admin token,则使用admin token
    if (isSystemPath && currentAdminToken && currentAdminToken.trim() !== '' && currentAdminToken.trim() !== '*'.repeat(currentAdminToken.length)) {
        res = '/' + currentAdminToken + path;
    } else {
        // 否则使用普通token
        res = (currentToken ? '/' + currentToken : "") + path;
    }
    
    // 如果配置了自定义基础URL (解决反代问题)
    if (customBaseUrl) {
        // 确保路径以/开头
        const cleanPath = res.startsWith('/') ? res : '/' + res;
        return customBaseUrl + cleanPath;
    }

    return res;
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
    .then(response => {
        // 检查ContentType，如果是HTML说明可能是404页面或反代错误页面
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") === -1) {
             throw new Error("Received HTML instead of JSON. Possible 404 or Proxy Error.");
        }
        if (!response.ok) {
            throw new Error(\`HTTP error! status: \${response.status}\`);
        }
        return response.json();
    })
    .then(config => {
      let _reverseProxy = customBaseUrl; // 使用全局配置

      // 获取当前页面的协议、主机和端口
      const protocol = window.location.protocol;
      const host = window.location.host;
      const token = config.originalEnvVars?.TOKEN || '87654321'; // 默认token值
      const adminToken = config.originalEnvVars?.ADMIN_TOKEN;

      // 获取URL路径并提取token
      let urlPath = window.location.pathname;
      if(_reverseProxy) {
          try {
              let proxyPath = _reverseProxy.startsWith('http') 
                  ? new URL(_reverseProxy).pathname 
                  : _reverseProxy;
              
              if (proxyPath.endsWith('/')) {
                  proxyPath = proxyPath.slice(0, -1);
              }
              if(proxyPath && urlPath.startsWith(proxyPath)) {
                  urlPath = urlPath.substring(proxyPath.length);
              }
          } catch(e) { /* ignore */ }
      }

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
      let baseUrlStr;
      if (_reverseProxy) {
          // 如果配置了反代，且是相对路径，则补全协议和主机，确保显示为绝对路径
          baseUrlStr = _reverseProxy.startsWith('http') 
              ? _reverseProxy 
              : (protocol + '//' + host + _reverseProxy);
      } else {
          baseUrlStr = protocol + '//' + host;
      }

      // 确保 baseUrlStr 不以斜杠结尾
      let cleanBaseUrl = baseUrlStr;
      if (cleanBaseUrl.endsWith('/')) {
          cleanBaseUrl = cleanBaseUrl.slice(0, -1);
      }
      const apiEndpoint = cleanBaseUrl + '/' + apiToken;
      
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
      let _reverseProxy = customBaseUrl;
      
      // 构造显示用的BaseUrl
      let baseUrlStr;
      if (_reverseProxy) {
          baseUrlStr = _reverseProxy.startsWith('http') 
              ? _reverseProxy 
              : (protocol + '//' + host + _reverseProxy);
      } else {
          baseUrlStr = protocol + '//' + host;
      }

      let cleanBaseUrl = baseUrlStr;
      if (cleanBaseUrl.endsWith('/')) {
          cleanBaseUrl = cleanBaseUrl.slice(0, -1);
      }
      const apiEndpoint = cleanBaseUrl + '/********';
      
      const apiEndpointElement = document.getElementById('api-endpoint');
      if (apiEndpointElement) {
        apiEndpointElement.textContent = apiEndpoint;
      }
      
      // 如果是因为反代导致的问题，显示输入框 (交由renderPreview处理，或者在这里也可以触发)
      const proxyContainer = document.getElementById('proxy-config-container');
      if(proxyContainer) {
          proxyContainer.style.display = 'block';
          // 填充当前输入框（如果有值）
          if(customBaseUrl) {
              document.getElementById('custom-base-url').value = customBaseUrl;
          }
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
function switchSection(section, event = null) {
    // 检查是否尝试访问受token保护的section（日志查看、接口调试、推送弹幕、请求记录、系统配置需要token访问）
    if (section === 'logs' || section === 'api' || section === 'env' || section === 'push' || section === 'request-records') {
        let _reverseProxy = customBaseUrl; // 使用全局配置

        // 获取URL路径并提取token
        let urlPath = window.location.pathname;
        if(_reverseProxy) {
            // 严谨地移除BaseUrl中的path部分
            try {
                // 如果_reverseProxy包含完整URL，提取pathname
                // 如果只是相对路径，直接使用
                let proxyPath = _reverseProxy.startsWith('http') 
                    ? new URL(_reverseProxy).pathname 
                    : _reverseProxy;
                
                // 确保移除尾部斜杠，防止匹配失败
                if (proxyPath.endsWith('/')) {
                    proxyPath = proxyPath.slice(0, -1);
                }
                
                if(proxyPath && urlPath.startsWith(proxyPath)) {
                    urlPath = urlPath.substring(proxyPath.length);
                }
            } catch(e) {
                console.error("解析反代路径失败", e);
            }
        }
        
        const pathParts = urlPath.split('/').filter(part => part !== '');
        const urlToken = pathParts.length > 0 ? pathParts[0] : '';
        
        // 检查URL中是否有token
        if (!urlToken && originalToken !== "87654321") {
            // 提示用户需要在URL中配置TOKEN
            setTimeout(() => {
                // 获取当前页面的协议、主机和端口
                const protocol = window.location.protocol;
                const host = window.location.host;
                
                // 构造显示的BaseUrl，确保是绝对路径
                let displayBase;
                if (_reverseProxy) {
                    displayBase = _reverseProxy.startsWith('http') 
                        ? _reverseProxy 
                        : (protocol + '//' + host + _reverseProxy);
                } else {
                    displayBase = protocol + '//' + host;
                }
                
                if (displayBase.endsWith('/')) {
                    displayBase = displayBase.slice(0, -1);
                }
                
                // 根据section类型显示不同的token提示
                const tokenType = section === 'env' ? 'ADMIN_TOKEN' : 'TOKEN';
                customAlert('请在URL中配置相应的' + tokenType + '以访问此功能！\\n\\n访问方式：' + displayBase + '/{' + tokenType + '}');
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
                    // 在异步回调中使用传入的event参数来设置按钮的active状态
                    if (event && event.target) {
                        event.target.classList.add('active');
                    }

                    addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : section === 'request-records' ? '请求记录' : '接口调试'}模块\`, 'info');
                }
            });
        } else {
            // 对于日志查看、接口调试和推送弹幕页面，只要URL中有token就可以访问
            document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

            document.getElementById(\`\${section}-section\`).classList.add('active');
            if (event && event.target) {
                event.target.classList.add('active');
            }

            addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : section === 'request-records' ? '请求记录' : '接口调试'}模块\`, 'info');
            
            // 如果切换到日志查看页面，则立即刷新日志
            if (section === 'logs') {
                if (typeof fetchRealLogs === 'function') {
                    fetchRealLogs();
                }
            }
        }
    } else {
        // 对于非受保护页面（如配置预览），正常切换
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

        document.getElementById(\`\${section}-section\`).classList.add('active');
        if (event && event.target) {
            event.target.classList.add('active');
        }

        addLog(\`切换到\${section === 'env' ? '环境变量' : section === 'preview' ? '配置预览' : section === 'logs' ? '日志查看' : section === 'push' ? '推送弹幕' : '接口调试'}模块\`, 'info');
    }
}

// 切换类别
function switchCategory(category, event = null) {
    currentCategory = category;
    document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }
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
        const config = await fetchAndSetConfig();

        // 设置默认推送地址
        setDefaultPushUrl(config);

        // 检查并处理管理员令牌
        checkAndHandleAdminToken();
        
        loadEnvVariables(); // 从API加载真实环境变量数据
        renderEnvList();
        renderPreview();
        addLog('系统初始化完成', 'success');
        // 获取真实日志数据
        fetchRealLogs();
        
        // 初始化推送弹幕界面
        if (typeof initPushDanmuInterface === 'function') {
            initPushDanmuInterface();
        }
        
        // 初始化接口调试界面
        if (typeof initApiTestInterface === 'function') {
            initApiTestInterface();
        }
        
    } catch (error) {
        console.error('初始化失败:', error);
        addLog('系统初始化失败: ' + error.message, 'error');
        
        // 确保反代配置框显示
        const proxyContainer = document.getElementById('proxy-config-container');
        if(proxyContainer) {
            proxyContainer.style.display = 'block';
            if(customBaseUrl) {
                document.getElementById('custom-base-url').value = customBaseUrl;
            }
        }
        
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

function escapeHtml(text) {
    // 如果是 null 或 undefined，返回空字符串
    if (text === null || text === undefined) {
        return '';
    }
    
    // 将非字符串值转换为字符串
    const str = String(text);
    
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, m => map[m]);
}


// 页面加载完成后初始化
init();
`;
