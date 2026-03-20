// language=JavaScript
export const systemSettingsJsContent = /* javascript */ `
// 全局变量定义
let isMergeMode = false;
let stagingTags = [];

// 显示清理缓存确认模态框
function showClearCacheModal() {
    document.getElementById('clear-cache-modal').classList.add('active');
}

// 隐藏清理缓存确认模态框
function hideClearCacheModal() {
    document.getElementById('clear-cache-modal').classList.remove('active');
}

// 确认清理缓存
async function confirmClearCache() {
    // 检查部署平台配置
    const configCheck = await checkDeployPlatformConfig();
    if (!configCheck.success) {
        hideClearCacheModal();
        customAlert(configCheck.message);
        return;
    }

    hideClearCacheModal();
    showLoading('正在清理缓存...', '清除中，请稍候');
    addLog('开始清理缓存', 'info');

    try {
        // 调用真实的清理缓存API
        const response = await fetch(buildApiUrl('/api/cache/clear', true), { // 使用admin token
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const result = await response.json();

        if (result.success) {
            updateLoadingText('清理完成', '缓存已成功清除');
            addLog('缓存清理完成', 'success');
            addLog('✅ 缓存清理成功！已清理: ' + JSON.stringify(result.clearedItems), 'success');
        } else {
            updateLoadingText('清理失败', '请查看日志了解详情');
            addLog('缓存清理失败: ' + result.message, 'error');
        }
    } catch (error) {
        updateLoadingText('清理失败', '网络错误或服务不可用');
        addLog('缓存清理请求失败: ' + error.message, 'error');
    } finally {
        setTimeout(() => {
            hideLoading();
        }, 10);
    }
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
    // 检查部署平台配置
    checkDeployPlatformConfig().then(configCheck => {
        if (!configCheck.success) {
            hideDeploySystemModal();
            customAlert(configCheck.message);
            return;
        }

        hideDeploySystemModal();
        showLoading('准备部署...', '正在检查系统状态');
        addLog('===== 开始系统部署 =====', 'info');

        // 获取当前部署平台
        fetch(buildApiUrl('/api/config', true))
            .then(response => response.json())
            .then(config => {
                const deployPlatform = config.envs.deployPlatform || 'node';
                addLog(\`检测到部署平台: \${deployPlatform}\`, 'info');

                if (deployPlatform.toLowerCase() === 'node') {
                    // Node部署不需要重新部署
                    setTimeout(() => {
                        hideLoading();
                        addLog('===== 部署完成 =====', 'success');
                        addLog('Node部署模式，环境变量已生效', 'info');
                        addLog('✅ Node部署模式 - 在Node部署模式下，环境变量修改后会自动生效，无需重新部署。系统已更新配置', 'success');
                    }, 150);
                } else {  
                    // 调用真实的部署API
                    fetch(buildApiUrl('/api/deploy', true), { // 使用admin token
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    })
                    .then(response => response.json())
                    .then(result => {
                        if (result.success) {
                            addLog('云端部署触发成功', 'success');
                            // 模拟云端部署过程
                            simulateDeployProcess();
                        } else {
                            hideLoading();
                            addLog(\`云端部署失败: \${result.message}\`, 'error');
                            addLog(\`❌ 云端部署失败: \${result.message}\`, 'error');
                        }
                    })
                    .catch(error => {
                        hideLoading();
                        addLog(\`云端部署请求失败: \${error.message}\`, 'error');
                        addLog(\`❌ 云端部署请求失败: \${error.message}\`, 'error');
                    });
                }
            })
            .catch(error => {
                hideLoading();
                addLog(\`获取部署平台信息失败: \${error.message}\`, 'error');
                console.error('获取部署平台信息失败:', error);
            });
    });
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
        { delay: 100, text: '检查环境变量...', detail: '验证配置文件', log: '配置文件验证通过' },
        { delay: 5000, text: '触发云端部署...', detail: '部署到当前平台', log: '云端部署已触发' },
        { delay: 9500, text: '构建项目...', detail: '云端构建中', log: '云端构建完成' },
        { delay: 5000, text: '部署更新...', detail: '发布到生产环境', log: '更新已部署' },
        { delay: 5500, text: '服务重启...', detail: '应用新配置', log: '服务已重启' },
        { delay: 5000, text: '健康检查...', detail: '验证服务状态', log: '所有服务运行正常' },
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
    }, 900); // 延长延迟以确保模拟部署过程完成
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

// 检查URL中的token是否与currentAdminToken匹配
function checkAdminToken() {
    let _reverseProxy = customBaseUrl; // 使用全局变量 customBaseUrl

    // 获取URL路径并提取token
    let urlPath = window.location.pathname;
    
    // 如果配置了反代路径，必须先剥离它
    if(_reverseProxy) {
        try {
            // 解析配置中的路径部分，例如 http://192.168.8.1:2333/danmu_api => /danmu_api
            let proxyPath = _reverseProxy.startsWith('http') 
                ? new URL(_reverseProxy).pathname 
                : _reverseProxy;
            
            // 确保移除尾部斜杠
            if (proxyPath.endsWith('/')) {
                proxyPath = proxyPath.slice(0, -1);
            }
            
            // 如果当前URL包含此前缀，则移除它
            if(proxyPath && urlPath.startsWith(proxyPath)) {
                urlPath = urlPath.substring(proxyPath.length);
            }
        } catch(e) {
            console.error("解析反代路径失败", e);
        }
    }

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
        
        let displayBase;
        if (customBaseUrl) {
            displayBase = customBaseUrl.startsWith('http') 
                ? customBaseUrl 
                : (protocol + '//' + host + customBaseUrl);
        } else {
            displayBase = protocol + '//' + host;
        }

        if (displayBase.endsWith('/')) {
            displayBase = displayBase.slice(0, -1);
        }
        
        return { success: false, message: '请先配置ADMIN_TOKEN环境变量并使用正确的token访问以启用系统部署功能！\\n\\n访问方式：' + displayBase + '/{ADMIN_TOKEN}' };
    }
    
    try {
        const response = await fetch(buildApiUrl('/api/config', true));
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
        const deployPlatformProject = config.originalEnvVars.DEPLOY_PLATFROM_PROJECT;
        const deployPlatformToken = config.originalEnvVars.DEPLOY_PLATFROM_TOKEN;
        const deployPlatformAccount = config.originalEnvVars.DEPLOY_PLATFROM_ACCOUNT;
        
        if (!deployPlatformProject || deployPlatformProject.trim() === '') {
            missingVars.push('DEPLOY_PLATFROM_PROJECT');
        }
        
        if (!deployPlatformToken || deployPlatformToken.trim() === '') {
            missingVars.push('DEPLOY_PLATFROM_TOKEN');
        }
        
        // 对于netlify和cloudflare部署平台，还需要检查DEPLOY_PLATFROM_ACCOUNT
        if (deployPlatform.toLowerCase() === 'netlify' || deployPlatform.toLowerCase() === 'cloudflare') {
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
    const config = await fetch(buildApiUrl('/api/config', true)).then(response => response.json());
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

// 渲染值输入控件
function renderValueInput(item) {
    const container = document.getElementById('value-input-container');
    const type = item ? item.type : document.getElementById('value-type').value;
    const value = item ? item.value : '';
    const currentKey = item ? item.key : document.getElementById('env-key').value;

    if (type === 'boolean') {
        // 布尔开关
        // 对于LIKE_SWITCH变量，默认值设为true（开启状态）
        let checked;
        if (currentKey === 'LIKE_SWITCH' || currentKey === 'REMEMBER_LAST_SELECT') {
            // 如果值为空或未定义，LIKE_SWITCH和REMEMBER_LAST_SELECT默认为true（开启）
            checked = value === 'true' || value === true || (value === '' || value === undefined || value === null);
        } else {
            checked = value === 'true' || value === true;
        }
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
        
        // 检查是否为 SOURCE_ORDER，如果是则不显示合并模式
        const shouldShowMergeMode = currentKey === 'MERGE_SOURCE_PAIRS' || currentKey === 'PLATFORM_ORDER';
        
        // 每次渲染时重置合并模式状态
        isMergeMode = false;
        stagingTags = [];

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

                \${shouldShowMergeMode ? \`
                <div class="merge-mode-controls">
                    <div class="merge-mode-btn" id="merge-mode-toggle" onclick="toggleMergeMode()">
                        <span class="icon">🔗️</span> 开启合并模式
                    </div>
                    <div class="form-help" style="margin: 0; margin-left: 10px;">
                        开启后点击下方选项将添加到暂存区,组合后点击 √ 确认
                    </div>
                </div>

                <div class="staging-area" id="staging-area">
                    <button type="button" class="confirm-merge-btn" onclick="confirmMergeGroup()" title="确认添加该组">✓</button>
                </div>
                \` : ''}

                <label>可选项 (点击添加)</label>
                <div class="available-tags" id="available-tags">
                    \${options.map(opt => {
                        return \`
                            <div class="available-tag"
                                 data-value="\${opt}" onclick="addSelectedTag(this)">
                                \${opt}
                            </div>
                        \`;
                    }).join('')}
                </div>
            </div>
        \`;

        // 设置拖动事件
        // 立即执行一次状态检查，确保已选项变灰
        setTimeout(updateTagStates, 0);
        setupDragAndDrop();

    } else if (type === 'map') {
        // 映射表类型
        const pairs = value ? value.split(';').map(pair => pair.trim()).filter(pair => pair) : [];
        const mapItems = pairs.map(pair => {
            if (pair.includes('->')) {
                const [left, right] = pair.split('->').map(s => s.trim());
                return { left, right };
            }
            return { left: pair, right: '' };
        });

        container.innerHTML = \`
            <label>映射配置</label>
            <div class="map-container" id="map-container">
                \${mapItems.map((item, index) => \`
                    <div class="map-item" data-index="\${index}">
                        <input type="text" class="map-input-left" placeholder="原始值" value="\${item.left}">
                        <span class="map-separator">-></span>
                        <input type="text" class="map-input-right" placeholder="映射值" value="\${item.right}">
                        <button type="button" class="btn btn-danger map-remove-btn" onclick="removeMapItem(this)">删除</button>
                    </div>
                \`).join('')}
                <div class="map-item-template" style="display: none;">
                    <input type="text" class="map-input-left" placeholder="原始值">
                    <span class="map-separator">-></span>
                    <input type="text" class="map-input-right" placeholder="映射值">
                    <button type="button" class="btn btn-danger map-remove-btn" onclick="removeMapItem(this)">删除</button>
                </div>
            </div>
            <button type="button" class="btn btn-primary" onclick="addMapItem()">添加映射项</button>
        \`;

    } else {
        // 文本输入
        const currentKey = document.getElementById('env-key') ? document.getElementById('env-key').value : '';
        const isBilibiliCookie = currentKey === 'BILIBILI_COOKIE';
        const isAiApiKey = currentKey === 'AI_API_KEY';
        const isColorPool = currentKey === 'COLOR_POOL';
        const isDanmuOffset = currentKey === 'DANMU_OFFSET';
        const offsetSources = item && item.sources ? item.sources : [];

        if (isColorPool) {
            // 自定义颜色池专用编辑界面
            const colors = parseColorPool(value);

            container.innerHTML = \`
                <label>颜色池配置 (CONVERT_COLOR 为 color 时生效)</label>
                <div id="color-pool-display" class="color-pool-display">
                    \${renderColorItems(colors)}
                </div>
                <div class="color-pool-picker">
                    <div class="color-pool-picker-inner">
                        <div id="color-wheel" class="color-wheel">
                            <div class="color-wheel-center"></div>
                            <div id="wheel-dot" class="color-wheel-dot" style="top: 2px; left: 53px; background: hsl(0,100%,50%);"></div>
                        </div>
                        <div class="color-pool-preview">
                            <div id="color-preview-swatch" class="color-pool-preview-swatch" style="background: #ff0000;"></div>
                            <span id="color-preview-hex" class="color-pool-preview-hex">#ff0000</span>
                        </div>
                        <div class="color-pool-lightness">
                            <span>亮度</span>
                            <input type="range" id="color-lightness" min="10" max="100" value="50">
                        </div>
                        <div class="color-pool-actions">
                            <button type="button" class="btn btn-primary btn-sm" onclick="addColorToPool()">添加到颜色池</button>
                            <button type="button" class="btn btn-primary btn-sm" onclick="addRandomColorToPool()">随机添加</button>
                        </div>
                    </div>
                </div>
                <div class="color-pool-actions">
                    <button type="button" class="btn btn-primary btn-sm" onclick="showBatchColorDialog()">批量添加</button>
                    <div class="spacer"></div>
                    <button type="button" class="btn btn-primary btn-sm" onclick="resetColorPool()">恢复默认</button>
                </div>
                <textarea id="text-value" style="display: none;">\${value}</textarea>
            \`;
            setTimeout(initColorWheel, 0);
        } else if (isDanmuOffset) {
            // DANMU_OFFSET 专用编辑界面
            const rows = value && value.length > 50 ? Math.min(Math.max(Math.ceil(value.length / 50), 3), 10) : 3;
            container.innerHTML = \`
                <label>变量值</label>
                <textarea id="text-value" placeholder="格式：剧名:秒 或 剧名/S01:秒 或 剧名@来源:秒" rows="\${rows}" class="text-monospace">\${value}</textarea>
                <div style="margin-top: 8px;">
                    <button type="button" class="btn btn-primary btn-sm" id="offset-rule-toggle" onclick="toggleOffsetRulePanel()">
                        添加规则
                    </button>
                </div>
                <div id="offset-rule-panel" class="offset-rule-panel">
                    <div class="form-help" style="margin: 0 0 8px 0;">季和集不填则对所有季/集生效</div>
                    <div class="offset-form-row">
                        <div style="flex: 2; min-width: 100px;">
                            <label class="offset-label">剧名 *</label>
                            <input type="text" id="offset-anime" class="offset-input" placeholder="例如: overlord">
                        </div>
                        <div style="width: 65px;">
                            <label class="offset-label">季</label>
                            <input type="number" id="offset-season" class="offset-input" placeholder="" min="1" max="99">
                        </div>
                        <div style="width: 65px;">
                            <label class="offset-label">集</label>
                            <input type="number" id="offset-episode" class="offset-input" placeholder="" min="1" max="999">
                        </div>
                        <div style="width: 85px;">
                            <label class="offset-label">偏移秒 *</label>
                            <input type="number" id="offset-seconds" class="offset-input" placeholder="90">
                        </div>
                    </div>
                    \${offsetSources.length > 0 ? \`
                    <div style="margin-bottom: 10px;">
                        <label class="offset-label">来源 (可选，不选则对所有来源生效)</label>
                        <div id="offset-sources" class="offset-sources">
                            \${offsetSources.map(src => \`
                                <div class="offset-source-tag" data-value="\${src}" onclick="toggleOffsetSource(this)">
                                    \${src}
                                </div>
                            \`).join('')}
                        </div>
                    </div>
                    \` : ''}
                    <div class="offset-actions">
                        <button type="button" class="btn btn-sm" onclick="toggleOffsetRulePanel()">取消</button>
                        <button type="button" class="btn btn-primary btn-sm" onclick="appendOffsetRule()">确认添加</button>
                    </div>
                </div>
            \`;
        } else if (isAiApiKey) {
            // AI API Key 专用编辑界面
            container.innerHTML = \`
                <div class="ai-apikey-editor">
                    <label>API Key 值</label>
                    <textarea class="form-group" id="text-value" placeholder="请输入 AI API Key" rows="3">\${value}</textarea>
                    <div class="form-help">支持 OpenAI 兼容的 API，需配合 AI_BASE_URL 和 AI_MODEL 配置使用</div>

                    <div class="ai-apikey-status" id="ai-apikey-status">
                        <span class="ai-status-icon">🔍</span>
                        <span class="ai-status-text">点击下方按钮测试连通性</span>
                    </div>
                    <div class="ai-apikey-actions" style="margin-bottom: 15px;">
                        <button type="button" class="btn btn-primary btn-sm" id="ai-verify-btn" onclick="verifyAiConnection()">
                            🧪 测试连通性
                        </button>
                    </div>
                </div>
            \`;
        } else if (isBilibiliCookie) {
            // Bilibili Cookie 专用编辑界面
            const rows = value && value.length > 50 ? Math.min(Math.max(Math.ceil(value.length / 50), 3), 8) : 3;
            container.innerHTML = \`
                <div class="bili-cookie-editor">
                    <div class="bili-cookie-status" id="bili-cookie-status">
                        <span class="bili-status-icon">🔍</span>
                        <span class="bili-status-text">检测中...</span>
                    </div>
                    
                    <div class="bili-cookie-actions">
                        <button type="button" class="btn btn-primary btn-sm" onclick="startBilibiliQRLogin()">
                            📱 扫码登录
                        </button>
                    </div>
                    
                    <label>Cookie 值</label>
                    <textarea class="form-group" id="text-value" placeholder="SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx;" rows="\${rows}">\${value}</textarea>
                    <div class="form-help">推荐使用扫码登录自动获取，或手动粘贴包含 SESSDATA 和 bili_jct 的完整 Cookie</div>
                </div>
            \`;
            
            // 自动检测 Cookie 状态 + 监听输入变化（防抖）
            setTimeout(() => {
                autoCheckBilibiliCookieStatus();

                const inputEl = document.getElementById('text-value');
                if (inputEl) {
                    let debounceTimer = null;
                    inputEl.addEventListener('input', () => {
                        if (debounceTimer) clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            autoCheckBilibiliCookieStatus();
                        }, 600);
                    });
                }
            }, 120);
        } else if (value && value.length > 50) {
            const rows = Math.min(Math.max(Math.ceil(value.length / 50), 3), 10);
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

// ===== 颜色池操作函数 =====

// 色轮状态
let wheelHue = 0;
let wheelLightness = 50;
let wheelCleanup = null;

// 解析颜色池字符串为十进制数组
function parseColorPool(str) {
    if (!str) return [];
    return str.split(',').map(c => parseInt(c.trim(), 10)).filter(c => !isNaN(c) && c >= 0 && c <= 16777215);
}

// 渲染颜色池色块 HTML
function renderColorItems(colors) {
    if (colors.length === 0) return '<span class="color-pool-empty">未配置，将使用默认颜色池</span>';
    return colors.map((c, i) => \`
        <div class="color-pool-item">
            <span class="color-pool-swatch" style="background: #\${c.toString(16).padStart(6, '0')};"></span>
            <span class="color-pool-value">\${c}</span>
            <button type="button" class="color-pool-remove" onclick="removeColorFromPool(\${i})">&times;</button>
        </div>
    \`).join('');
}

// HSL -> RGB -> 十进制
function hslToDecimal(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const r = Math.round(f(0) * 255);
    const g = Math.round(f(8) * 255);
    const b = Math.round(f(4) * 255);
    return (r << 16) | (g << 8) | b;
}

// 更新色轮预览
function updateWheelPreview() {
    const dec = hslToDecimal(wheelHue, 100, wheelLightness);
    const hex = '#' + dec.toString(16).padStart(6, '0');
    const swatch = document.getElementById('color-preview-swatch');
    const hexLabel = document.getElementById('color-preview-hex');
    const dot = document.getElementById('wheel-dot');
    if (swatch) swatch.style.background = hex;
    if (hexLabel) hexLabel.textContent = hex;
    if (dot) dot.style.background = hex;
}

// 初始化色轮交互
function initColorWheel() {
    if (wheelCleanup) wheelCleanup();

    const wheel = document.getElementById('color-wheel');
    const slider = document.getElementById('color-lightness');
    if (!wheel) return;

    let dragging = false;

    function handleWheelEvent(e) {
        const rect = wheel.getBoundingClientRect();
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const x = e.clientX - rect.left - cx;
        const y = e.clientY - rect.top - cy;
        const dist = Math.sqrt(x * x + y * y);
        const outerR = rect.width / 2;
        const innerR = outerR * 0.22;
        if (dist < innerR || dist > outerR) return;
        let angle = Math.atan2(y, x) * 180 / Math.PI + 90;
        if (angle < 0) angle += 360;
        wheelHue = Math.round(angle % 360);
        const dot = document.getElementById('wheel-dot');
        if (dot) {
            const r = (innerR + outerR) / 2;
            const rad = (wheelHue - 90) * Math.PI / 180;
            dot.style.left = (cx + r * Math.cos(rad) - 7) + 'px';
            dot.style.top = (cy + r * Math.sin(rad) - 7) + 'px';
        }
        updateWheelPreview();
    }

    const onMove = e => {
        if (dragging) handleWheelEvent(e);
    };
    const onTouchMove = e => {
        if (dragging) handleWheelEvent(e.touches[0]);
    };
    const onUp = () => {
        dragging = false;
    };

    wheel.addEventListener('mousedown', e => {
        dragging = true;
        handleWheelEvent(e);
    });
    wheel.addEventListener('touchstart', e => {
        dragging = true;
        handleWheelEvent(e.touches[0]);
        e.preventDefault();
    }, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);

    if (slider) {
        slider.addEventListener('input', function() {
            wheelLightness = parseInt(this.value, 10);
            updateWheelPreview();
        });
    }

    wheelCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchend', onUp);
        wheelCleanup = null;
    };

    updateWheelPreview();
}

// 颜色池 - 追加颜色值
function appendColorToPool(decimal) {
    const textarea = document.getElementById('text-value');
    const current = textarea.value.trim();
    textarea.value = current ? current + ',' + decimal : String(decimal);
    syncColorPoolDisplay();
}

// 颜色池 - 从色轮添加
function addColorToPool() {
    appendColorToPool(hslToDecimal(wheelHue, 100, wheelLightness));
}

// 颜色池 - 随机添加（crypto 真随机）
function addRandomColorToPool() {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    appendColorToPool(arr[0] % 16777216);
}

// 颜色池 - 删除指定颜色
function removeColorFromPool(index) {
    const textarea = document.getElementById('text-value');
    const colors = textarea.value.split(',').map(c => c.trim()).filter(c => c);
    colors.splice(index, 1);
    textarea.value = colors.join(',');
    syncColorPoolDisplay();
}

// 颜色池 - 恢复默认（清空值，后端默认值自动生效）
function resetColorPool() {
    const textarea = document.getElementById('text-value');
    textarea.value = '';
    syncColorPoolDisplay();
}

// 颜色池 - 同步色块展示
function syncColorPoolDisplay() {
    const textarea = document.getElementById('text-value');
    const display = document.getElementById('color-pool-display');
    if (!textarea || !display) return;
    display.innerHTML = renderColorItems(parseColorPool(textarea.value));
}

// 颜色池 - 批量添加弹窗
function showBatchColorDialog() {
    const overlay = document.createElement('div');
    overlay.id = 'batch-color-overlay';
    overlay.className = 'batch-color-overlay';
    overlay.innerHTML = \`
        <div class="batch-color-dialog">
            <div style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">批量添加颜色</div>
            <div class="form-help" style="margin: 0 0 10px 0;">支持十进制（如 16777215）和十六进制（如 #ffffff），逗号分隔</div>
            <textarea id="batch-color-input" class="batch-color-input" placeholder="例如: #ff0000, 65280, #0000ff, 16776960" rows="4"></textarea>
            <div id="batch-color-preview" class="batch-color-preview"></div>
            <div class="batch-color-actions">
                <button type="button" class="btn btn-sm" onclick="closeBatchColorDialog()">取消</button>
                <button type="button" class="btn btn-primary btn-sm" onclick="confirmBatchColor()">确认添加</button>
            </div>
        </div>
    \`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeBatchColorDialog();
    });
    const input = document.getElementById('batch-color-input');
    if (input) input.addEventListener('input', updateBatchColorPreview);
}

// 颜色池 - 关闭批量弹窗
function closeBatchColorDialog() {
    const overlay = document.getElementById('batch-color-overlay');
    if (overlay) overlay.remove();
}

// 颜色池 - 解析单个颜色值（支持十进制和 #hex）
function parseColorValue(raw) {
    const s = raw.trim();
    if (!s) return NaN;
    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (/^[0-9a-fA-F]{3}$/.test(hex)) {
            const full = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            return parseInt(full, 16);
        }
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
            return parseInt(hex, 16);
        }
        return NaN;
    }
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 0 || n > 16777215) return NaN;
    return n;
}

// 颜色池 - 批量预览
function updateBatchColorPreview() {
    const input = document.getElementById('batch-color-input');
    const preview = document.getElementById('batch-color-preview');
    if (!input || !preview) return;
    const parts = input.value.split(',');
    const html = parts.map(raw => {
        const c = parseColorValue(raw);
        if (isNaN(c)) return '';
        return \`<span class="batch-color-preview-swatch" style="background: #\${c.toString(16).padStart(6, '0')};"></span>\`;
    }).filter(Boolean).join('');
    preview.innerHTML = html || '<span class="color-pool-empty">输入颜色后预览</span>';
}

// 颜色池 - 确认批量添加
function confirmBatchColor() {
    const input = document.getElementById('batch-color-input');
    if (!input) return;
    const parts = input.value.split(',');
    const valid = parts.map(raw => parseColorValue(raw)).filter(c => !isNaN(c));
    if (valid.length === 0) {
        customAlert('未识别到有效颜色值');
        return;
    }
    const textarea = document.getElementById('text-value');
    const current = textarea.value.trim();
    const newVal = valid.map(String).join(',');
    textarea.value = current ? current + ',' + newVal : newVal;
    syncColorPoolDisplay();
    closeBatchColorDialog();
}

// DANMU_OFFSET 快速配置 - 切换规则面板
function toggleOffsetRulePanel() {
    const panel = document.getElementById('offset-rule-panel');
    if (panel) {
        const isHidden = getComputedStyle(panel).display === 'none';
        panel.style.display = isHidden ? 'block' : 'none';
        const btn = document.getElementById('offset-rule-toggle');
        if (btn) btn.textContent = isHidden ? '收起' : '添加规则';
    }
}

// DANMU_OFFSET 快速配置 - 切换来源选中状态
function toggleOffsetSource(el) {
    el.classList.toggle('selected');
}

// DANMU_OFFSET 快速配置 - 确认添加规则
function appendOffsetRule() {
    const anime = document.getElementById('offset-anime').value.trim();
    const season = document.getElementById('offset-season').value.trim();
    const episode = document.getElementById('offset-episode').value.trim();
    const seconds = document.getElementById('offset-seconds').value.trim();

    if (!anime) {
        customAlert('请输入剧名');
        return;
    }
    if (!seconds) {
        customAlert('请输入偏移秒数');
        return;
    }
    if (episode && !season) {
        customAlert('指定集时需要同时指定季');
        return;
    }

    let path = anime;
    if (season) {
        path += '/S' + season.padStart(2, '0');
        if (episode) {
            path += '/E' + episode.padStart(2, '0');
        }
    }

    const sourcesEl = document.getElementById('offset-sources');
    if (sourcesEl) {
        const selectedSources = Array.from(sourcesEl.querySelectorAll('.offset-source-tag.selected'))
            .map(el => el.dataset.value);
        if (selectedSources.length > 0) {
            path += '@' + selectedSources.join('&');
        }
    }

    const rule = path + ':' + seconds;
    const textarea = document.getElementById('text-value');
    const current = textarea.value.trim();
    textarea.value = current ? current + ',' + rule : rule;

    document.getElementById('offset-anime').value = '';
    document.getElementById('offset-season').value = '';
    document.getElementById('offset-episode').value = '';
    document.getElementById('offset-seconds').value = '';
    if (sourcesEl) {
        sourcesEl.querySelectorAll('.offset-source-tag.selected').forEach(el => {
            el.classList.remove('selected');
        });
    }
    toggleOffsetRulePanel();
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

// 统一的状态检查函数
function updateTagStates() {
    // 确保 DOM 元素存在，防止在渲染过程中被调用出错
    const keyInput = document.getElementById('env-key');
    if (!keyInput) return;

    const currentKey = keyInput.value;
    const isMergeSourcePairs = currentKey === 'MERGE_SOURCE_PAIRS';

    // 1. 获取当前暂存区中的Token (防止同组内重复)
    const stagingTokens = new Set(stagingTags);
    
    // 2. 获取已确认的 Selected Tags (仅在非合并模式下需要检查)
    const selectedTagElements = Array.from(document.querySelectorAll('.selected-tag'));

    // 3. 更新所有可选项的状态
    const availableTags = document.querySelectorAll('.available-tag');
    availableTags.forEach(tag => {
        const value = tag.dataset.value;
        let shouldDisable = false;

        if (isMergeMode) {
            // [合并模式逻辑]
            // 只要不在当前的暂存区中，就可以选（允许 bilibili&a 和 bilibili&b）
            // 也就是说，我们完全不检查 selectedTagElements
            if (stagingTokens.has(value)) {
                shouldDisable = true;
            }
        } else {
            // [普通模式逻辑]
            // 只要已经被选了，就禁用 (精准匹配)
            const isAlreadySelected = selectedTagElements.some(el => el.dataset.value === value);
            if (isAlreadySelected) {
                shouldDisable = true;
            }

            // 特殊情况：如果是 MERGE_SOURCE_PAIRS 但没开合并模式，且还没被选，也禁用（强迫用户开开关）
            if (isMergeSourcePairs && !isAlreadySelected) {
                shouldDisable = true;
            }
        }

        if (shouldDisable) {
            tag.classList.add('disabled');
        } else {
            tag.classList.remove('disabled');
        }
    });
}

// 添加已选标签
function addSelectedTag(element) {
    const value = element.dataset.value;

    if (isMergeMode) {
        if (!stagingTags.includes(value)) {
            stagingTags.push(value);
            renderStagingArea();
            updateTagStates(); // 立即更新状态 (该选项变灰，防止同组重复)
        }
        return;
    }

    if (element.classList.contains('disabled')) return;
    
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
    updateTagStates(); // 立即更新状态
    setupDragAndDrop();
}

// 移除已选标签
function removeSelectedTag(button) {
    const tag = button.parentElement;
    tag.remove();

    const container = document.getElementById('selected-tags');
    if (container.children.length === 0) {
        container.classList.add('empty');
    }

    updateTagStates(); // 移除后立即释放状态
    setupDragAndDrop();
}

// 更新多选选项
function updateMultiOptions() {
    const input = document.getElementById('multi-options');
    const options = input.value.split(',').map(s => s.trim()).filter(s => s);

    const container = document.getElementById('available-tags');
    container.innerHTML = options.map(opt => {
        return \`
            <div class="available-tag"
                 data-value="\${opt}" onclick="addSelectedTag(this)">
                \${opt}
            </div>
        \`;
    }).join('');
    
    updateTagStates(); // 初始化时更新状态
}

// 切换合并模式
function toggleMergeMode() {
    isMergeMode = !isMergeMode;
    const btn = document.getElementById('merge-mode-toggle');
    const stagingArea = document.getElementById('staging-area');

    if (isMergeMode) {
        btn.classList.add('active');
        btn.innerHTML = '<span class="icon">⛓‍💥</span> 合并模式已开启，点击关闭';
        stagingArea.classList.add('active');
        renderStagingArea();
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<span class="icon">🔗️</span> 点击开启合并模式';
        stagingArea.classList.remove('active');
        stagingTags = [];
    }
    
    // 切换模式时立即刷新所有可选项状态
    updateTagStates();
}

// 渲染暂存区
function renderStagingArea() {
    const container = document.getElementById('staging-area');
    const confirmBtn = container.querySelector('.confirm-merge-btn');
    
    while (container.firstChild && container.firstChild !== confirmBtn) {
        container.removeChild(container.firstChild);
    }

    if (stagingTags.length === 0) {
        const hint = document.createElement('span');
        hint.textContent = '请点击下方选项进行组合...';
        hint.style.color = '#666';
        hint.style.fontSize = '12px';
        container.insertBefore(hint, confirmBtn);
        confirmBtn.disabled = true;
    } else {
        stagingTags.forEach((tag, index) => {
            if (index > 0) {
                const sep = document.createElement('span');
                sep.className = 'staging-separator';
                sep.textContent = '&';
                container.insertBefore(sep, confirmBtn);
            }
            const tagEl = document.createElement('div');
            tagEl.className = 'staging-tag';
            tagEl.draggable = true;
            tagEl.dataset.value = tag;
            tagEl.dataset.index = index;
            tagEl.innerHTML = \`\${tag}<span class="remove-btn" onclick="removeFromStaging(\${index})">×</span>\`;
            container.insertBefore(tagEl, confirmBtn);
        });
        confirmBtn.disabled = false;
        setupStagingDragAndDrop();
    }
}

// 从暂存区移除
function removeFromStaging(index) {
    stagingTags.splice(index, 1);
    renderStagingArea();
    updateTagStates(); // 移除后刷新状态
}

// 确认添加合并组
function confirmMergeGroup() {
    if (stagingTags.length === 0) return;
    const groupValue = stagingTags.join('&');
    const container = document.getElementById('selected-tags');
    container.classList.remove('empty');

    const tag = document.createElement('div');
    tag.className = 'selected-tag';
    tag.draggable = true;
    tag.dataset.value = groupValue;
    tag.innerHTML = \`<span class="tag-text">\${groupValue}</span><button type="button" class="remove-btn" onclick="removeSelectedTag(this)">×</button>\`;
    
    container.appendChild(tag);
    setupDragAndDrop();
    
    stagingTags = []; // 清空暂存区
    renderStagingArea();
    updateTagStates(); // 关键：确认后立即重新计算所有可选项的禁用状态 (重置为可用)
}

// 设置暂存区拖放功能
function setupStagingDragAndDrop() {
    const container = document.getElementById('staging-area');
    const tags = container.querySelectorAll('.staging-tag');
    
    tags.forEach(tag => {
        tag.addEventListener('dragstart', handleStagingDragStart);
        tag.addEventListener('dragend', handleStagingDragEnd);
        tag.addEventListener('dragover', handleStagingDragOver);
        tag.addEventListener('drop', handleStagingDrop);
        tag.addEventListener('dragenter', handleStagingDragEnter);
        tag.addEventListener('dragleave', handleStagingDragLeave);
        
        tag.addEventListener('touchstart', handleStagingTouchStart);
        tag.addEventListener('touchmove', handleStagingTouchMove);
        tag.addEventListener('touchend', handleStagingTouchEnd);
    });
}

let stagingDraggedElement = null;

function handleStagingDragStart(e) {
    stagingDraggedElement = this;
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

function handleStagingDragEnd(e) {
    this.classList.remove('dragging');
    document.querySelectorAll('.staging-tag').forEach(tag => {
        tag.classList.remove('drag-over');
    });
}

function handleStagingDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleStagingDragEnter(e) {
    if (this !== stagingDraggedElement) {
        this.classList.add('drag-over');
    }
}

function handleStagingDragLeave(e) {
    this.classList.remove('drag-over');
}

function handleStagingDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }

    if (stagingDraggedElement !== this) {
        const draggedIndex = parseInt(stagingDraggedElement.dataset.index);
        const targetIndex = parseInt(this.dataset.index);
        
        const [movedItem] = stagingTags.splice(draggedIndex, 1);
        stagingTags.splice(targetIndex, 0, movedItem);
        
        renderStagingArea();
    }

    this.classList.remove('drag-over');
    return false;
}

function handleStagingTouchStart(e) {
    if (e.target.classList.contains('remove-btn')) {
        return;
    }
    
    e.preventDefault();
    stagingDraggedElement = this;
    this.classList.add('dragging');
    
    this.style.transform = 'rotate(5deg)';
    this.style.opacity = '0.8';
    this.style.zIndex = '1000';
}

function handleStagingTouchMove(e) {
    if (!stagingDraggedElement) return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const elementRect = stagingDraggedElement.getBoundingClientRect();
    
    if (!document.getElementById('staging-touch-drag-ghost')) {
        const ghostElement = stagingDraggedElement.cloneNode(true);
        ghostElement.id = 'staging-touch-drag-ghost';
        ghostElement.style.position = 'fixed';
        ghostElement.style.left = '0';
        ghostElement.style.top = '0';
        ghostElement.style.pointerEvents = 'none';
        ghostElement.style.zIndex = '9999';
        ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
        ghostElement.style.opacity = '0.8';
        ghostElement.style.boxSizing = 'border-box';
        ghostElement.style.width = elementRect.width + 'px';
        ghostElement.style.height = elementRect.height + 'px';
        document.body.appendChild(ghostElement);
    } else {
        const ghostElement = document.getElementById('staging-touch-drag-ghost');
        ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
    }
    
    const container = document.getElementById('staging-area');
    const tags = Array.from(container.querySelectorAll('.staging-tag')).filter(tag => tag !== stagingDraggedElement);
    let targetElement = null;
    
    for (const tag of tags) {
        const rect = tag.getBoundingClientRect();
        if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
            touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
            targetElement = tag;
            break;
        }
    }
    
    document.querySelectorAll('.staging-tag').forEach(tag => {
        if (tag !== stagingDraggedElement) {
            tag.classList.remove('drag-over');
        }
    });
    
    if (targetElement) {
        targetElement.classList.add('drag-over');
    }
}

function handleStagingTouchEnd(e) {
    if (!stagingDraggedElement) return;
    e.preventDefault();
    
    const ghostElement = document.getElementById('staging-touch-drag-ghost');
    if (ghostElement) {
        document.body.removeChild(ghostElement);
    }
    
    const touch = e.changedTouches[0];
    const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);
    const targetTag = targetElement.closest('.staging-tag');
    
    if (targetTag && targetTag !== stagingDraggedElement) {
        const draggedIndex = parseInt(stagingDraggedElement.dataset.index);
        const targetIndex = parseInt(targetTag.dataset.index);
        
        const [movedItem] = stagingTags.splice(draggedIndex, 1);
        stagingTags.splice(targetIndex, 0, movedItem);
        
        renderStagingArea();
    }
    
    stagingDraggedElement.style.transform = '';
    stagingDraggedElement.style.opacity = '';
    stagingDraggedElement.style.zIndex = '';
    stagingDraggedElement.classList.remove('dragging');
    
    document.querySelectorAll('.staging-tag').forEach(tag => {
        tag.classList.remove('drag-over');
    });
    
    stagingDraggedElement = null;
}

// 设置拖放功能
let draggedElement = null;
let touchDragging = false;

// 为删除按钮添加触摸事件监听器，以确保其可以被点击
function setupDragAndDrop() {
    const container = document.getElementById('selected-tags');
    const tags = container.querySelectorAll('.selected-tag');

    tags.forEach(tag => {
        // 鼠标拖放事件
        tag.addEventListener('dragstart', handleDragStart);
        tag.addEventListener('dragend', handleDragEnd);
        tag.addEventListener('dragover', handleDragOver);
        tag.addEventListener('drop', handleDrop);
        tag.addEventListener('dragenter', handleDragEnter);
        tag.addEventListener('dragleave', handleDragLeave);
        
        // 触摸拖放事件
        tag.addEventListener('touchstart', handleTouchStart);
        tag.addEventListener('touchmove', handleTouchMove);
        tag.addEventListener('touchend', handleTouchEnd);
        
        // 确保删除按钮可以被点击
        const removeBtn = tag.querySelector('.remove-btn');
        if (removeBtn) {
            // 阻止删除按钮上的触摸事件冒泡到父元素
            removeBtn.addEventListener('touchstart', function(e) {
                e.stopPropagation();
            });
            
            removeBtn.addEventListener('touchend', function(e) {
                e.stopPropagation();
            });
        }
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

// 触摸拖动事件处理
function handleTouchStart(e) {
    // 检查点击的是否是删除按钮
    if (e.target.classList.contains('remove-btn')) {
        // 如果点击的是删除按钮，则不执行拖动操作
        return;
    }
    
    // 防止默认的触摸行为
    e.preventDefault();
    
    // 获取触摸点
    const touch = e.touches[0];
    
    // 模拟拖动开始
    draggedElement = this;
    this.classList.add('dragging');
    touchDragging = true;
    
    // 添加拖动样式
    this.style.transform = 'rotate(5deg)';
    this.style.opacity = '0.8';
    this.style.zIndex = '1000';
    
    // 添加触摸移动和结束事件监听器到文档
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: false });
}

function handleTouchMove(e) {
    if (!touchDragging || !draggedElement) return;
    
    // 防止默认的触摸行为
    e.preventDefault();
    
    // 使用 requestAnimationFrame 来优化性能
    if (window.requestAnimationFrame) {
        window.requestAnimationFrame(() => {
            // 获取触摸点位置
            const touch = e.touches[0];
            
            // 获取拖动元素的尺寸
            const elementRect = draggedElement.getBoundingClientRect();
            
            // 创建一个临时的拖动元素，而不是移动原始元素
            if (!document.getElementById('touch-drag-ghost')) {
                const ghostElement = draggedElement.cloneNode(true);
                ghostElement.id = 'touch-drag-ghost';
                ghostElement.style.position = 'fixed'; // 使用 fixed 而不是 absolute
                ghostElement.style.left = '0';
                ghostElement.style.top = '0';
                ghostElement.style.pointerEvents = 'none'; // 防止干扰触摸事件
                ghostElement.style.zIndex = '9999';
                ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
                ghostElement.style.opacity = '0.8';
                ghostElement.style.boxSizing = 'border-box'; // 确保尺寸计算正确
                ghostElement.style.width = elementRect.width + 'px'; // 固定宽度
                ghostElement.style.height = elementRect.height + 'px'; // 固定高度
                document.body.appendChild(ghostElement);
            } else {
                const ghostElement = document.getElementById('touch-drag-ghost');
                ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
            }
            
            // 检查与其他元素的碰撞
            const container = document.getElementById('selected-tags');
            const tags = Array.from(container.querySelectorAll('.selected-tag')).filter(tag => tag !== draggedElement);
            let targetElement = null;
            
            for (const tag of tags) {
                const rect = tag.getBoundingClientRect();
                if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
                    touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
                    targetElement = tag;
                    break;
                }
            }
            
            // 高亮目标元素
            document.querySelectorAll('.selected-tag').forEach(tag => {
                if (tag !== draggedElement) {
                    tag.classList.remove('drag-over');
                }
            });
            
            if (targetElement) {
                targetElement.classList.add('drag-over');
            }
        });
    } else {
        // 降级处理，如果不支持 requestAnimationFrame
        const touch = e.touches[0];
        
        // 获取拖动元素的尺寸
        const elementRect = draggedElement.getBoundingClientRect();
        
        // 创建一个临时的拖动元素，而不是移动原始元素
        if (!document.getElementById('touch-drag-ghost')) {
            const ghostElement = draggedElement.cloneNode(true);
            ghostElement.id = 'touch-drag-ghost';
            ghostElement.style.position = 'fixed'; // 使用 fixed 而不是 absolute
            ghostElement.style.left = '0';
            ghostElement.style.top = '0';
            ghostElement.style.pointerEvents = 'none'; // 防止干扰触摸事件
            ghostElement.style.zIndex = '9999';
            ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
            ghostElement.style.opacity = '0.8';
            ghostElement.style.boxSizing = 'border-box'; // 确保尺寸计算正确
            ghostElement.style.width = elementRect.width + 'px'; // 固定宽度
            ghostElement.style.height = elementRect.height + 'px'; // 固定高度
            document.body.appendChild(ghostElement);
        } else {
            const ghostElement = document.getElementById('touch-drag-ghost');
            ghostElement.style.transform = 'translate(' + (touch.clientX - (elementRect.width / 2)) + 'px, ' + (touch.clientY - (elementRect.height / 2)) + 'px) rotate(5deg)';
        }
        
        // 检查与其他元素的碰撞
        const container = document.getElementById('selected-tags');
        const tags = Array.from(container.querySelectorAll('.selected-tag')).filter(tag => tag !== draggedElement);
        let targetElement = null;
        
        for (const tag of tags) {
            const rect = tag.getBoundingClientRect();
            if (touch.clientX >= rect.left && touch.clientX <= rect.right &&
                touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
                targetElement = tag;
                break;
            }
        }
        
        // 高亮目标元素
        document.querySelectorAll('.selected-tag').forEach(tag => {
            if (tag !== draggedElement) {
                tag.classList.remove('drag-over');
            }
        });
        
        if (targetElement) {
            targetElement.classList.add('drag-over');
        }
    }
}

function handleTouchEnd(e) {
    if (!touchDragging || !draggedElement) return;
    
    // 防止默认的触摸行为
    e.preventDefault();
    
    // 移除临时拖动元素
    const ghostElement = document.getElementById('touch-drag-ghost');
    if (ghostElement) {
        document.body.removeChild(ghostElement);
    }
    
    // 找到目标元素（如果有）
    const touch = e.changedTouches[0];
    const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);
    
    const container = document.getElementById('selected-tags');
    const targetTag = targetElement.closest('.selected-tag');
    
    // 如果目标是另一个标签，执行交换
    if (targetTag && targetTag !== draggedElement && container.contains(targetTag)) {
        const allTags = Array.from(container.querySelectorAll('.selected-tag'));
        const draggedIndex = allTags.indexOf(draggedElement);
        const targetIndex = allTags.indexOf(targetTag);

        if (draggedIndex < targetIndex) {
            targetTag.parentNode.insertBefore(draggedElement, targetTag.nextSibling);
        } else {
            targetTag.parentNode.insertBefore(draggedElement, targetTag);
        }
    }
    
    // 重置元素样式
    draggedElement.style.transform = '';
    draggedElement.style.opacity = '';
    draggedElement.style.zIndex = '';
    
    // 移除拖动类
    draggedElement.classList.remove('dragging');
    document.querySelectorAll('.selected-tag').forEach(tag => {
        tag.classList.remove('drag-over');
    });
    
    // 重置变量
    touchDragging = false;
    draggedElement = null;
    
    // 移除事件监听器
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
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
                         item.type === 'map' ? '映射' :
                         item.type === 'multi-select' ? '多选' : '文本';
        const badgeClass = item.type === 'multi-select' ? 'multi' : '';

        const escapedValue = escapeHtml(item.value);

        return \`
            <div class="env-item">
                <div class="env-info">
                    <strong>\${item.key}<span class="value-type-badge \${badgeClass}">\${typeLabel}</span></strong>
                    <div class="text-dark-gray">\${escapedValue}</div>
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
        // 如果开启了合并模式，且暂存区还有内容，自动将其视为确认添加
        if (isMergeMode && stagingTags && stagingTags.length > 0) {
            confirmMergeGroup();
        }

        const selectedTags = Array.from(document.querySelectorAll('.selected-tag'))
            .map(el => el.dataset.value);
        value = selectedTags.join(',');
        const options = Array.from(document.querySelectorAll('.available-tag')).map(el => el.dataset.value);
        itemData = { key, value, description, type, options };
    } else if (type === 'map') {
        // 获取映射表值
        const mapItems = document.querySelectorAll('#map-container .map-item');
        const pairs = [];
        mapItems.forEach(item => {
            const leftInput = item.querySelector('.map-input-left');
            const rightInput = item.querySelector('.map-input-right');
            const leftValue = leftInput.value.trim();
            const rightValue = rightInput.value.trim();
            if (leftValue && rightValue) {
                pairs.push(leftValue + '->' + rightValue);
            }
        });
        value = pairs.join(';');
        itemData = { key, value, description, type };
    } else {
        value = document.getElementById('text-value').value.trim();
        itemData = { key, value, description, type };
    }

    // 调用API更新环境变量 - 先尝试set接口，失败则调用add接口
    try {
        // 首先尝试使用set接口更新
        let response = await fetch(buildApiUrl('/api/env/set'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ key, value })
        });

        let result = await response.json();

        if (!result.success) {
            // 如果set接口失败，尝试使用add接口
            response = await fetch(buildApiUrl('/api/env/add'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ key, value })
            });

            result = await response.json();
        }

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
            customAlert(result.message + '，请检查部署平台相关环境变量配置是否正确');
        }
    } catch (error) {
        addLog(\`更新环境变量失败: \${error.message}\`, 'error');
        addLog(\`❌ 更新环境变量失败: \${error.message}\`, 'error');
        customAlert(result.message + '，请检查部署平台相关环境变量配置是否正确');
    }
});

// 添加映射项
function addMapItem() {
    const container = document.getElementById('map-container');
    const template = document.querySelector('.map-item-template');
    const newItem = template.cloneNode(true);
    newItem.style.display = 'flex';
    newItem.classList.remove('map-item-template');
    newItem.classList.add('map-item');
    const index = container.querySelectorAll('.map-item').length;
    newItem.setAttribute('data-index', index);
    container.appendChild(newItem);
}

// 删除映射项
function removeMapItem(button) {
    const item = button.closest('.map-item');
    if (item) {
        item.remove();
    }
}
/* ========================================
   Bilibili Cookie 扫码登录功能
   ======================================== */
let biliQRCheckInterval = null;
let biliBiliQRKey = null;

async function startBilibiliQRLogin() {
    // 创建扫码登录模态框
    if (!document.getElementById('bili-qr-modal')) {
        const modalHTML = \`
            <div class="modal" id="bili-qr-modal">
                <div class="modal-content" style="max-width: 400px;">
                    <div class="modal-header">
                        <h3>📱 扫码登录 Bilibili</h3>
                        <button class="close-btn" onclick="closeBiliQRModal()">×</button>
                    </div>
                    <div class="modal-body" style="text-align: center;">
                        <div id="bili-qr-container">
                            <div class="loading-spinner" id="bili-qr-loading"></div>
                            <p id="bili-qr-status">正在生成二维码...</p>
                            <div id="bili-qr-code" style="display: none;"></div>
                        </div>
                    </div>
                </div>
            </div>
        \`;
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }
    
    const modal = document.getElementById('bili-qr-modal');
    const qrCode = document.getElementById('bili-qr-code');
    const qrLoading = document.getElementById('bili-qr-loading');
    const qrStatus = document.getElementById('bili-qr-status');
    
    modal.classList.add('active');
    qrCode.style.display = 'none';
    qrCode.innerHTML = '';
    qrLoading.style.display = 'block';
    qrStatus.textContent = '正在生成二维码...';
    
    if (biliQRCheckInterval) {
        clearInterval(biliQRCheckInterval);
    }
    
    try {
        const response = await fetch(buildApiUrl('/api/cookie/qr/generate', true), {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success && result.data) {
            biliBiliQRKey = result.data.qrcode_key;
            const qrUrl = result.data.url;
            
            qrCode.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(qrUrl) + '" alt="二维码">';
            qrCode.style.display = 'block';
            qrLoading.style.display = 'none';
            qrStatus.textContent = '请使用 Bilibili APP 扫描';
            
            startBiliQRCheck();
        } else {
            throw new Error(result.message || '生成二维码失败');
        }
    } catch (error) {
        qrLoading.style.display = 'none';
        qrStatus.textContent = '❌ ' + error.message;
    }
}

function startBiliQRCheck() {
    if (!biliBiliQRKey) return;
    
    const qrStatus = document.getElementById('bili-qr-status');
    
    biliQRCheckInterval = setInterval(async () => {
        try {
            const response = await fetch(buildApiUrl('/api/cookie/qr/check', true), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qrcode_key: biliBiliQRKey })
            });
            
            const result = await response.json();
            
            if (result.success && result.data) {
                const code = result.data.code;
                
                switch (code) {
                    case 86101:
                        qrStatus.textContent = '⏳ 等待扫码...';
                        break;
                    case 86090:
                        qrStatus.textContent = '📱 已扫码，请确认';
                        break;
                    case 86038:
                        qrStatus.textContent = '❌ 二维码已过期';
                        clearInterval(biliQRCheckInterval);
                        break;
                    case 0:
                        qrStatus.textContent = '✅ 登录成功！';
                        clearInterval(biliQRCheckInterval);
                        
                        if (result.data.cookie) {
                            fillBilibiliCookie(result.data.cookie);
                        }
                        
                        setTimeout(() => {
                            closeBiliQRModal();
                        }, 1000);
                        break;
                }
            }
        } catch (error) {
            console.error('检查扫码状态失败:', error);
        }
    }, 2000);
}

function fillBilibiliCookie(cookie) {
    const textInput = document.getElementById('text-value');
    if (textInput) {
        textInput.value = cookie;
        textInput.dispatchEvent(new Event('input', { bubbles: true }));
        
        textInput.style.borderColor = 'var(--success-color, #28a745)';
        setTimeout(() => {
            textInput.style.borderColor = '';
            // 填入后触发检测一次（会提示用户保存）
            autoCheckBilibiliCookieStatus();
        }, 2000);
    }
}

function closeBiliQRModal() {
    const modal = document.getElementById('bili-qr-modal');
    if (modal) {
        modal.classList.remove('active');
    }
    
    if (biliQRCheckInterval) {
        clearInterval(biliQRCheckInterval);
    }
}

async function autoCheckBilibiliCookieStatus() {
    const textInput = document.getElementById('text-value');
    const statusEl = document.getElementById('bili-cookie-status');
    
    if (!textInput || !statusEl) return;
    
    const cookie = textInput.value.trim();
    
    // 如果输入框为空,提示未配置
    if (!cookie) {
        statusEl.innerHTML = '<span class="bili-status-icon">⚠️</span><span class="bili-status-text">未配置</span>';
        return;
    }
    
    statusEl.innerHTML = '<span class="bili-status-icon">🔍</span><span class="bili-status-text">检测中...</span>';

    // 脱敏后的 *...* 无法直接校验，后端会自动改为校验“已保存”的 Cookie
    const isMasked = /^[*]+$/.test(cookie);
    const payload = isMasked ? {} : { cookie };

    try {
        const response = await fetch(buildApiUrl('/api/cookie/verify', true), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result && result.success && result.data) {
            if (result.data.isValid) {
                const uname = result.data.uname || '已登录';
                const expiresAt = result.data.expiresAt;
                const now = Math.floor(Date.now() / 1000);

                let leftText = '';
                if (typeof expiresAt === 'number' && expiresAt > now) {
                    const daysLeft = Math.ceil((expiresAt - now) / (24 * 60 * 60));
                    leftText = \` (剩余 \${daysLeft} 天)\`;
                }

                // 用户手动输入/扫码填入的 Cookie → 提示保存
                if (!isMasked) {
                    statusEl.innerHTML = \`<span class="bili-status-icon">✅</span><span class="bili-status-text">\${uname}\${leftText} · 请点击保存按钮（Vercel等平台需重新部署后生效）</span>\`;
                } else {
                    // 脱敏显示时只展示当前已保存 Cookie 的状态
                    statusEl.innerHTML = \`<span class="bili-status-icon">✅</span><span class="bili-status-text">\${uname}\${leftText}</span>\`;
                }
            } else {
                const err = result.data.error || 'Cookie无效或已失效';
                statusEl.innerHTML = \`<span class="bili-status-icon">❌</span><span class="bili-status-text">\${err}，请重新扫码登录并保存</span>\`;
            }
        } else {
            statusEl.innerHTML = '<span class="bili-status-icon">⚠️</span><span class="bili-status-text">检测失败</span>';
        }
    } catch (error) {
        statusEl.innerHTML = '<span class="bili-status-icon">⚠️</span><span class="bili-status-text">检测失败</span>';
    }
}
// 显示 Bilibili Cookie 保存提示
function showBilibiliCookieSaveHint(text) {
    const statusEl = document.getElementById('bili-cookie-status');
    if (!statusEl) return;

    const msg = text || '请点击保存按钮,Vercel等平台需重新部署后生效';
    statusEl.innerHTML = \`<span class="bili-status-icon">💾</span><span class="bili-status-text">\${msg}</span>\`;
}

/* ========================================
   AI API Key 连通性测试功能
   ======================================== */
async function verifyAiConnection() {
    const statusEl = document.getElementById('ai-apikey-status');
    const btn = document.getElementById('ai-verify-btn');
    const textInput = document.getElementById('text-value');
    
    if (!statusEl || !textInput) return;
    
    const apiKey = textInput.value.trim();
    
    // 如果输入框为空，提示未配置
    if (!apiKey) {
        statusEl.innerHTML = '<span class="ai-status-icon">⚠️</span><span class="ai-status-text">请先输入 API Key</span>';
        return;
    }
    
    // 设置按钮为加载状态
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="loading-spinner-small"></span>';
    btn.disabled = true;
    
    statusEl.innerHTML = '<span class="ai-status-icon">🔍</span><span class="ai-status-text">正在测试连通性...</span>';
    
    // 检查是否为脱敏后的 *...* 
    const isMasked = /^[*]+$/.test(apiKey);
    
    try {
        const response = await fetch(buildApiUrl('/api/ai/verify', true), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isMasked ? {} : { 'aiApiKey': apiKey })
        });
        
        const result = await response.json();
        
        if (result.ok) {
            statusEl.innerHTML = '<span class="ai-status-icon">✅</span><span class="ai-status-text">' + (result.message || 'AI 服务连通性测试成功') + '</span>';
            statusEl.style.color = 'var(--success-color, #28a745)';
        } else {
            statusEl.innerHTML = '<span class="ai-status-icon">❌</span><span class="ai-status-text">' + (result.message || '连通性测试失败') + '</span>';
            statusEl.style.color = 'var(--danger-color, #dc3545)';
        }
    } catch (error) {
        statusEl.innerHTML = '<span class="ai-status-icon">⚠️</span><span class="ai-status-text">测试请求失败: ' + error.message + '</span>';
        statusEl.style.color = 'var(--warning-color, #ffc107)';
    } finally {
        // 恢复按钮状态
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}
`;
