// language=JavaScript
export const pushDanmuJsContent = /* javascript */ `
// 推送弹幕功能相关

// 搜索动漫用于推送
function searchAnimeForPush() {
    const keyword = document.getElementById('push-search-keyword').value.trim();
    const pushUrl = document.getElementById('push-url').value.trim();
    const searchBtn = document.querySelector('#push-section .btn-primary');
    
    if (!keyword) {
        customAlert('请输入搜索关键字');
        return;
    }
    
    // 搜索时不再校验pushUrl是否为空，只在推送时校验
    
    // 添加加载状态
    const originalText = searchBtn.textContent;
    searchBtn.innerHTML = '<span class="loading-spinner-small"></span>';
    searchBtn.disabled = true;
    
    // 构建搜索API请求URL
    const searchUrl = buildApiUrl('/api/v2/search/anime?keyword=' + encodeURIComponent(keyword));
    
    addLog(\`开始搜索动漫: \${keyword}\`, 'info');
    
    // 发送搜索请求
    fetch(searchUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(\`HTTP error! status: \${response.status}\`);
            }
            return response.json();
        })
        .then(data => {
            if (data.success && data.animes.length > 0) {
                displayAnimeListForPush(data.animes, pushUrl);
            } else {
                document.getElementById('push-anime-list').style.display = 'none';
                document.getElementById('push-episode-list').style.display = 'none';
                customAlert('未找到相关动漫');
                addLog('未找到相关动漫', 'warn');
            }
        })
        .catch(error => {
            console.error('搜索动漫失败:', error);
            customAlert('搜索动漫失败: ' + error.message);
            addLog('搜索动漫失败: ' + error.message, 'error');
        })
        .finally(() => {
            // 恢复按钮状态
            searchBtn.innerHTML = originalText;
            searchBtn.disabled = false;
        });
}

// 展示动漫列表用于推送
function displayAnimeListForPush(animes, pushUrl) {
    const container = document.getElementById('push-anime-list');
    let html = '<h3>搜索结果</h3><div class="anime-grid">';

    animes.forEach(anime => {
        const imageUrl = anime.imageUrl || 'https://placehold.co/150x200?text=No+Image';
        html += \`
            <div class="anime-item" onclick="getBangumiForPush(\${anime.animeId}, '\${pushUrl}')">
                <img src="\${imageUrl}" alt="\${anime.animeTitle}" referrerpolicy="no-referrer" class="anime-item-img">
                <h4 class="anime-title">\${anime.animeTitle} - 共\${anime.episodeCount}集</h4>
            </div>
        \`; 
    });
    
    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';
    
    addLog(\`显示 \${animes.length} 个动漫结果\`, 'info');
}

// 获取番剧详情用于推送
function getBangumiForPush(animeId, pushUrl) {
    const bangumiUrl = buildApiUrl('/api/v2/bangumi/' + animeId);
    
    addLog(\`获取番剧详情: \${animeId}\`, 'info');
    
    fetch(bangumiUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error(\`HTTP error! status: \${response.status}\`);
            }
            return response.json();
        })
        .then(data => {
            if (data.success && data.bangumi && data.bangumi.episodes) {
                displayEpisodeListForPush(data.bangumi.animeTitle, data.bangumi.episodes, pushUrl);
            } else {
                customAlert('该动漫暂无剧集信息');
                addLog('该动漫暂无剧集信息', 'warn');
            }
        })
        .catch(error => {
            console.error('获取番剧详情失败:', error);
            customAlert('获取番剧详情失败: ' + error.message);
            addLog('获取番剧详情失败: ' + error.message, 'error');
        });
}

// 展示剧集列表用于推送
function displayEpisodeListForPush(animeTitle, episodes, pushUrl) {
    const container = document.getElementById('push-episode-list');
    let html = \`<h3>剧集列表</h3><h4 class="text-yellow-gold">\${animeTitle}</h4><div class="episode-list-container">\`;

    episodes.forEach(episode => {
        // 生成弹幕URL
        const commentUrl = window.location.origin + buildApiUrl('/api/v2/comment/' + episode.episodeId + '?format=xml');
        html += \`
            <div class="episode-item">
                <div class="episode-item-content">
                    <strong>第\${episode.episodeNumber}集</strong> - \${episode.episodeTitle || '无标题'}
                </div>
                <button class="btn btn-success btn-sm episode-push-btn" onclick="pushDanmu('\${pushUrl}', '\${commentUrl}', '\${episode.episodeTitle || '第' + episode.episodeNumber + '集'}')">推送</button>
            </div>
        \`; 
    });
    
    html += '</div>';
    container.innerHTML = html;
    container.style.display = 'block';
    
    addLog(\`显示 \${episodes.length} 个剧集\`, 'info');
    
    // 自动滚动到剧集列表处
    setTimeout(() => {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 10);
}

// 推送弹幕
async function pushDanmu(pushUrl, commentUrl, episodeTitle) {
    // 获取推送按钮元素
    const pushButton = event.target; // 通过事件对象获取当前点击的按钮

    // 校验推送地址是否为空
    if (!pushUrl || pushUrl.trim() === '') {
        customAlert('请输入推送地址');
        if (pushButton) {
            pushButton.innerHTML = '推送';
            pushButton.disabled = false;
        }
        return;
    }

    if (pushButton) {
        const originalText = pushButton.innerHTML;
        pushButton.innerHTML = '<span class="loading-spinner-small"></span>';
        pushButton.disabled = true;
    }

    try {       
        // 向推送地址发送弹幕数据
        const pushResponse = await fetch(pushUrl + encodeURIComponent(commentUrl), {
            method: 'GET',
            mode: 'no-cors', // 由于跨域限制，使用no-cors模式
        });

        customAlert('弹幕推送成功！' + episodeTitle);
        addLog('弹幕推送成功 - ' + episodeTitle, 'success');
    } catch (error) {
        console.error('推送弹幕失败:', error);
        customAlert('推送弹幕失败: ' + error.message);
        addLog('推送弹幕失败: ' + error.message, 'error');
    } finally {
        // 恢复按钮状态
        if (pushButton) {
            pushButton.innerHTML = '推送';
            pushButton.disabled = false;
        }
    }
}
`;
