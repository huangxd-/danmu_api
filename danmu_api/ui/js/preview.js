// language=JavaScript
export const previewJsContent = /* javascript */ `
const previewCategoryOrder = ['api', 'source', 'match', 'danmu', 'cache', 'system'];

const previewCategoryMeta = {
    api: { label: '🔗 API 配置', description: '访问凭证与请求控制' },
    source: { label: '📜 源配置', description: '弹幕源、VOD 服务与平台凭证' },
    match: { label: '🔍 匹配配置', description: '标题处理、匹配策略与 AI 服务' },
    danmu: { label: '🔣 弹幕配置', description: '过滤、转换、输出与时间调整' },
    cache: { label: '💾 缓存配置', description: '缓存时效、容量与 Redis 服务' },
    system: { label: '⚙️ 系统配置', description: '界面、网络、部署与安全设置' }
};

const previewGroupDefinitions = {
    api: [
        { name: '访问认证', keys: ['TOKEN', 'ADMIN_TOKEN'] },
        { name: '请求控制', keys: ['RATE_LIMIT_MAX_REQUESTS'] }
    ],
    source: [
        { name: '源选择与合并', keys: ['SOURCE_ORDER', 'MERGE_SOURCE_PAIRS', 'CUSTOM_MERGE_RULES'] },
        { name: '第三方与 VOD 服务', keys: ['OTHER_SERVER', 'CUSTOM_SOURCE_API_URL', 'VOD_SERVERS', 'VOD_RETURN_MODE', 'VOD_REQUEST_TIMEOUT'] },
        { name: '平台凭证与并发', keys: ['BILIBILI_COOKIE', 'DOUBAN_COOKIE', 'YOUKU_CONCURRENCY'] }
    ],
    match: [
        { name: '匹配策略', keys: ['PLATFORM_ORDER', 'STRICT_TITLE_MATCH', 'ENABLE_ANIME_EPISODE_FILTER'] },
        { name: '标题处理', keys: ['ANIME_TITLE_FILTER', 'EPISODE_TITLE_FILTER', 'TITLE_TO_CHINESE', 'ANIME_TITLE_SIMPLIFIED', 'TITLE_MAPPING_TABLE', 'TITLE_NOISE_FILTER'] },
        { name: 'AI 匹配', keys: ['AI_BASE_URL', 'AI_MODEL', 'AI_API_KEY', 'AI_MATCH_PROMPT'] },
        { name: '动画元数据', keys: ['USE_BANGUMI_DATA'] }
    ],
    danmu: [
        { name: '过滤与数量', keys: ['BLOCKED_WORDS', 'GROUP_MINUTE', 'DANMU_LIMIT'] },
        { name: '显示与转换', keys: ['DANMU_SIMPLIFIED_TRADITIONAL', 'CONVERT_TOP_BOTTOM_TO_SCROLL', 'CONVERT_COLOR', 'COLOR_POOL', 'LIKE_SWITCH'] },
        { name: '输出与推送', keys: ['DANMU_OUTPUT_FORMAT', 'DANMU_PUSH_URL'] },
        { name: '时间与来源适配', keys: ['DANMU_OFFSET', 'HONGGUO_MERGE_ALL_EPISODES'] }
    ],
    cache: [
        { name: '缓存时效', keys: ['SEARCH_CACHE_MINUTES', 'COMMENT_CACHE_MINUTES', 'BANGUMI_DATA_CACHE_DAYS'] },
        { name: '容量与历史', keys: ['REMEMBER_LAST_SELECT', 'MAX_LAST_SELECT_MAP', 'MAX_ANIMES'] },
        { name: 'Redis 服务', keys: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_REDIS_URL'] }
    ],
    system: [
        { name: '界面与运行', keys: ['UI_THEME', 'LOG_LEVEL'] },
        { name: '网络与数据服务', keys: ['PROXY_URL', 'TMDB_API_KEY'] },
        { name: '部署平台', keys: ['DEPLOY_PLATFROM_ACCOUNT', 'DEPLOY_PLATFROM_PROJECT', 'DEPLOY_PLATFROM_TOKEN', 'deployPlatform'] },
        { name: '安全策略', keys: ['NODE_TLS_REJECT_UNAUTHORIZED', 'IP_BLACKLIST'] },
        { name: '运行状态', keys: ['localCacheValid', 'redisValid', 'localRedisValid', 'aiValid'] }
    ]
};

const previewState = {
    categorizedVars: {},
    activeCategory: 'overview',
    query: ''
};

// 渲染配置预览
function renderPreview() {
    const preview = document.getElementById('preview-area');
    const proxyConfigContainer = document.getElementById('proxy-config-container');

    if (preview) {
        preview.innerHTML = '<p class="text-gray">正在加载配置...</p>';
    }

    fetch(buildApiUrl('/api/config'))
        .then(response => {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.indexOf('application/json') === -1) {
                return response.text().then(text => {
                    throw new Error('Expected JSON, got ' + contentType + '. Content: ' + text.substring(0, 50) + '...');
                });
            }
            if (!response.ok) {
                throw new Error('HTTP error! status: ' + response.status);
            }
            return response.json();
        })
        .then(config => {
            if (proxyConfigContainer) {
                proxyConfigContainer.style.display = 'none';
            }

            previewState.categorizedVars = config.categorizedEnvVars || {};
            if (previewState.activeCategory !== 'overview' && !previewCategoryOrder.includes(previewState.activeCategory)) {
                previewState.activeCategory = 'overview';
            }
            renderPreviewNavigation();
            renderPreviewContent();
        })
        .catch(error => {
            console.error('Failed to load config for preview:', error);

            if (proxyConfigContainer) {
                proxyConfigContainer.style.display = 'block';
                const savedUrl = localStorage.getItem('logvar_api_base_url');
                if (savedUrl) {
                    document.getElementById('custom-base-url').value = savedUrl;
                }
            }

            const navigation = document.getElementById('preview-categories');
            const status = document.getElementById('preview-status');
            if (navigation) navigation.innerHTML = '';
            if (status) status.textContent = '';
            if (preview) preview.innerHTML = '<p class="text-red">加载配置失败: ' + escapeHtml(error.message) + '</p>';
            addLog('加载配置失败: ' + error.message, 'error');
        });
}

function renderPreviewNavigation() {
    const navigation = document.getElementById('preview-categories');
    if (!navigation) return;

    const categories = [
        ...previewCategoryOrder.map(category => ({
            key: category,
            label: previewCategoryMeta[category].label,
            count: (previewState.categorizedVars[category] || []).length
        }))
    ];

    navigation.innerHTML = categories.map(category => {
        const isActive = !previewState.query && previewState.activeCategory === category.key;
        return \`
            <button
                type="button"
                class="preview-category-btn\${isActive ? ' active' : ''}"
                onclick="selectPreviewCategory('\${category.key}')"
                aria-pressed="\${isActive}"
            >
                <span>\${category.label}</span>
                <span class="preview-category-count">\${category.count}</span>
            </button>
        \`;
    }).join('');
}

function renderPreviewContent() {
    const preview = document.getElementById('preview-area');
    const status = document.getElementById('preview-status');
    if (!preview || !status) return;

    if (previewState.query) {
        const searchResult = renderPreviewSearchResults(previewState.query);
        preview.innerHTML = searchResult.html;
        status.textContent = '搜索结果 · ' + searchResult.count + ' 项';
        return;
    }

    if (previewState.activeCategory === 'overview') {
        preview.innerHTML = renderPreviewOverview();
        status.textContent = '共 ' + getPreviewTotalCount() + ' 项配置';
        return;
    }

    const category = previewState.activeCategory;
    const items = previewState.categorizedVars[category] || [];
    preview.innerHTML = renderPreviewCategory(category, items);
    status.textContent = previewCategoryMeta[category].label + ' · ' + items.length + ' 项';
}

function renderPreviewOverview() {
    return '<div class="preview-overview">' + previewCategoryOrder.map(category => {
        const meta = previewCategoryMeta[category];
        const count = (previewState.categorizedVars[category] || []).length;
        return \`
            <button type="button" class="preview-summary" onclick="selectPreviewCategory('\${category}')">
                <span class="preview-summary-title">\${meta.label}</span>
                <span class="preview-summary-description">\${meta.description}</span>
                <span class="preview-summary-side">
                    <span class="preview-summary-count">\${count}</span>
                    <span class="preview-summary-arrow" aria-hidden="true">&rsaquo;</span>
                </span>
            </button>
        \`;
    }).join('') + '</div>';
}

function renderPreviewCategory(category, items) {
    if (!items.length) {
        return '<p class="preview-empty">该分类暂无配置</p>';
    }

    const groupedItems = [];
    const groupIndexes = new Map();
    items.forEach((item, index) => {
        const groupName = getPreviewGroupName(category, item.key);
        if (!groupIndexes.has(groupName)) {
            groupIndexes.set(groupName, groupedItems.length);
            groupedItems.push({ name: groupName, records: [] });
        }
        groupedItems[groupIndexes.get(groupName)].records.push({ item, index });
    });

    return groupedItems.map(group => \`
        <section class="preview-group">
            <div class="preview-group-heading">
                <h3>\${group.name}</h3>
                <span>\${group.records.length} 项</span>
            </div>
            <div class="preview-list">
                \${group.records.map(record => renderPreviewItem(record.item, category, record.index)).join('')}
            </div>
        </section>
    \`).join('');
}

function renderPreviewSearchResults(query) {
    const normalizedQuery = query.toLocaleLowerCase();
    let total = 0;
    let html = '';

    previewCategoryOrder.forEach(category => {
        const items = previewState.categorizedVars[category] || [];
        const matches = items
            .map((item, index) => ({ item, index }))
            .filter(record => {
                const item = record.item;
                const searchableText = [
                    item.key,
                    formatPreviewValue(item.value),
                    item.description,
                    previewCategoryMeta[category].label,
                    getPreviewGroupName(category, item.key)
                ].join(' ').toLocaleLowerCase();
                return searchableText.includes(normalizedQuery);
            });

        if (!matches.length) return;
        total += matches.length;
        html += \`
            <section class="preview-group preview-search-group">
                <div class="preview-group-heading">
                    <h3>\${previewCategoryMeta[category].label}</h3>
                    <span>\${matches.length} 项</span>
                </div>
                <div class="preview-list">
                    \${matches.map(record => renderPreviewItem(record.item, category, record.index)).join('')}
                </div>
            </section>
        \`;
    });

    if (!total) {
        html = '<div class="preview-empty"><strong>未找到匹配配置</strong><span>请尝试其他关键词</span></div>';
    }

    return { html, count: total };
}

function renderPreviewItem(item, category, index) {
    const value = formatPreviewValue(item.value);
    const isLong = value.length > 180 || value.includes('\\n');
    const valueId = 'preview-value-' + category + '-' + index;
    return \`
        <div class="preview-item">
            <div class="preview-item-main">
                <div class="preview-key"><strong>\${escapeHtml(item.key)}</strong></div>
                <div class="preview-value-container">
                    <code class="preview-value\${isLong ? ' is-collapsed' : ''}" id="\${valueId}">\${escapeHtml(value)}</code>
                    <div class="preview-value-actions">
                        \${isLong ? \`<button type="button" class="preview-action-btn preview-expand-btn" onclick="togglePreviewValue(this)" aria-controls="\${valueId}" aria-expanded="false">展开</button>\` : ''}
                        <button type="button" class="preview-action-btn preview-copy-btn" onclick="copyPreviewValue('\${category}', \${index}, this)" title="复制配置值" aria-label="复制 \${escapeHtml(item.key)} 的值"><span aria-hidden="true">⧉</span></button>
                    </div>
                </div>
            </div>
            \${item.description ? \`<div class="preview-item-description">\${escapeHtml(item.description)}</div>\` : ''}
        </div>
    \`;
}

function getPreviewGroupName(category, key) {
    const definitions = previewGroupDefinitions[category] || [];
    const matchedGroup = definitions.find(group => group.keys.includes(key));
    return matchedGroup ? matchedGroup.name : '其他配置';
}

function formatPreviewValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value, null, 2);
        } catch (error) {
            return String(value);
        }
    }
    return String(value);
}

function getPreviewTotalCount() {
    return previewCategoryOrder.reduce((total, category) => {
        return total + (previewState.categorizedVars[category] || []).length;
    }, 0);
}

function selectPreviewCategory(category) {
    previewState.activeCategory = category;
    clearPreviewSearch(false);
    renderPreviewNavigation();
    renderPreviewContent();
}

function handlePreviewSearch(event) {
    previewState.query = event.target.value.trim();
    const clearButton = document.getElementById('preview-search-clear');
    if (clearButton) clearButton.hidden = !previewState.query;
    renderPreviewNavigation();
    renderPreviewContent();
}

function clearPreviewSearch(shouldRender = true) {
    previewState.query = '';
    const input = document.getElementById('preview-search-input');
    const clearButton = document.getElementById('preview-search-clear');
    if (input) input.value = '';
    if (clearButton) clearButton.hidden = true;
    if (shouldRender) {
        renderPreviewNavigation();
        renderPreviewContent();
        if (input) input.focus();
    }
}

function togglePreviewValue(button) {
    const item = button.closest('.preview-item');
    const value = item ? item.querySelector('.preview-value') : null;
    if (!value) return;

    const willExpand = value.classList.contains('is-collapsed');
    value.classList.toggle('is-collapsed', !willExpand);
    button.textContent = willExpand ? '收起' : '展开';
    button.setAttribute('aria-expanded', String(willExpand));
}

async function copyPreviewValue(category, index, button) {
    const item = (previewState.categorizedVars[category] || [])[index];
    if (!item) return;

    const value = formatPreviewValue(item.value);
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            if (!copied) throw new Error('浏览器不支持复制');
        }

        const originalContent = button.innerHTML;
        button.textContent = '✓';
        button.classList.add('is-copied');
        button.setAttribute('title', '已复制');
        setTimeout(() => {
            button.innerHTML = originalContent;
            button.classList.remove('is-copied');
            button.setAttribute('title', '复制配置值');
        }, 1500);
    } catch (error) {
        customAlert('复制失败: ' + error.message);
    }
}

// 获取类别名称，保留给其他页面调用
function getCategoryName(category) {
    return previewCategoryMeta[category]?.label || category;
}
`;
