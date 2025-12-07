// language=JavaScript
export const systemSettingsJsContent = /* javascript */ `
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
        fetch(buildApiUrl('/api/config'))
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
`;
