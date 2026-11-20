// language=JavaScript
export const requestRecordsJsContent = /* javascript */ `
// 请求记录相关功能
// 详情请求序号：连续打开多条记录时，只渲染最后一次请求的结果，避免慢响应覆盖新内容
let interfaceDetailSeq = 0;

// 最近一次打开的请求 id，供失败后重试
let interfaceDetailRequestId = '';

// 最近一次渲染的详情，配置筛选切换时按同一份数据重渲染
let currentInterfaceTrace = null;

// 配置覆盖区筛选：all 全部、used 仅已读取、hit 仅已命中
let interfaceConfigFilter = 'all';

// 单条请求记录：接口、方法、IP、时间与参数，带详情入口
function renderRecordRow(record) {
    // 接口路径、IP 与请求参数来自客户端输入，渲染前必须转义，避免请求记录页执行注入内容
    const interfaceName = escapeHtml(decodeURIComponent(record.interface)) || '未知接口';
    const params = record.params || {};
    const timestamp = record.timestamp ? new Date(record.timestamp).toLocaleString('zh-CN') : '未知时间';
    const method = escapeHtml(record.method || 'GET');
    const clientIp = escapeHtml(record.clientIp || '未知IP');
    // 状态码分组着色：2xx 成功、3xx 重定向、其余按失败处理，便于在列表中快速定位异常请求
    const statusCode = Number(record.statusCode) || 0;
    const statusClass = statusCode >= 400 ? ' is-error' : statusCode >= 300 ? ' is-redirect' : '';
    const statusHtml = statusCode
        ? '<div class="record-status' + statusClass + '">' + statusCode + '</div>'
        : '<div class="record-status is-pending">—</div>';

    // 格式化参数显示
    const hasParams = Object.keys(params).length > 0;
    const paramsHtml = hasParams
        ? \`<div class="record-params">
                    <div class="record-params-title">\${uiIcon('braces')} 请求参数</div>
                    <pre>\${escapeHtml(JSON.stringify(params, null, 2))}</pre>
                   </div>\`
        : '';

    // 如果没有参数，给时间戳添加 no-params 类以隐藏虚线
    const timestampClass = hasParams ? 'record-timestamp' : 'record-timestamp no-params';

    const requestId = record.requestId ? escapeHtml(record.requestId) : '';
    const rowAttrs = requestId
        ? ' is-clickable" data-request-id="' + requestId + '" onclick="openInterfaceDetail(this.dataset.requestId)"'
        : '';
    // 按钮不再单独绑定事件，点击冒泡到整行，避免重复触发
    const detailButton = requestId
        ? '<button type="button" class="btn btn-sm btn-primary btn-detail">' + uiIcon('list') + ' 查看详情</button>'
        : '';

    return \`
            <div class="record-item\${rowAttrs}">
                <div class="record-header">
                    <div class="record-method">\${method}</div>
                    \${statusHtml}
                    <div class="record-interface">\${interfaceName}</div>
                    <div class="record-ip">\${clientIp}</div>
                    \${detailButton}
                </div>
                <div class="\${timestampClass}">\${uiIcon('clock')} \${timestamp}</div>
                \${paramsHtml}
            </div>\`;
}

async function renderRequestRecords() {
    const recordsContainer = document.getElementById('request-records-list');
    if (!recordsContainer) {
        console.error('未找到请求记录容器');
        return;
    }

    try {
        // 从API获取请求记录
        const response = await fetch(buildApiUrl('/api/reqrecords'));
        if (!response.ok) {
            throw new Error('获取请求记录失败');
        }
        
        const data = await response.json();
        const records = data.records;
        const todayReqNum = data.todayReqNum;

        // 显示今日请求总数
        const totalRequestsElement = document.getElementById('total-requests-today');
        if (totalRequestsElement) {
            totalRequestsElement.textContent = \`今日请求总数: \${todayReqNum}\`;
        }

        if (records.length === 0) {
            recordsContainer.innerHTML = '<div class="no-records">暂无请求记录</div>';
            return;
        }

        // 生成记录HTML
        const recordsHtml = records.map(renderRecordRow).join('');

        recordsContainer.innerHTML = recordsHtml;
    } catch (error) {
        console.error('获取请求记录时出错:', error);
        recordsContainer.innerHTML = '<div class="no-records">获取请求记录失败: ' + escapeHtml(error.message) + '</div>';
    }
}

// 详情失败态：正文只放错误说明，重试按钮由弹窗 footer 统一承载
function renderInterfaceFailure(message) {
    const content = document.getElementById('interface-detail-content');
    const loading = document.getElementById('interface-detail-loading');
    const footer = document.getElementById('interface-detail-footer');
    content.innerHTML = '<div class="interface-detail-error">' + escapeHtml(message) + '</div>';
    content.hidden = false;
    loading.hidden = true;
    if (footer) footer.hidden = false;
}

// 打开接口详情弹窗：拉取并渲染单条请求的总览 / 结果诊断 / 处理流水线 / 配置覆盖
async function openInterfaceDetail(requestId) {
    const modal = document.getElementById('interface-detail-modal');
    const loading = document.getElementById('interface-detail-loading');
    const content = document.getElementById('interface-detail-content');
    const footer = document.getElementById('interface-detail-footer');
    if (!modal) return;
    const seq = ++interfaceDetailSeq;
    interfaceDetailRequestId = requestId;
    // 每次打开回到全部配置，避免沿用上一条记录的筛选取到空列表
    interfaceConfigFilter = 'all';
    loading.hidden = false;
    content.hidden = true;
    content.innerHTML = '';
    if (footer) footer.hidden = true;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    // 与其它弹窗一致锁定页面滚动，避免滚动详情时背景页面跟着移动
    lockPageScroll();
    modal.onclick = function (e) { if (e.target === modal) closeInterfaceDetail(); };
    try {
        const response = await fetch(buildApiUrl('/api/interface-detail/' + encodeURIComponent(requestId)));
        if (!response.ok) {
            const err = await response.json().catch(function () { return {}; });
            // 404 表示记录已随容量淘汰，重试不可能成功，直接给出说明并隐藏重试按钮
            if (response.status === 404) {
                renderInterfaceFailure('该请求的接口详情已随记录容量淘汰，无法查看');
                if (footer) footer.hidden = true;
                return;
            }
            throw new Error(err.errorMessage || ('HTTP ' + response.status));
        }
        const data = await response.json();
        if (seq !== interfaceDetailSeq) return;
        renderInterfaceDetail(data.trace);
    } catch (error) {
        if (seq !== interfaceDetailSeq) return;
        renderInterfaceFailure('加载失败：' + error.message);
    }
}

// 失败后按最近一次请求 id 重新加载
function retryInterfaceDetail() {
    if (interfaceDetailRequestId) openInterfaceDetail(interfaceDetailRequestId);
}

// 关闭接口详情弹窗
function closeInterfaceDetail() {
    // 关闭后在途响应不得再回填内容
    interfaceDetailSeq++;
    const modal = document.getElementById('interface-detail-modal');
    if (modal) { modal.classList.remove('active'); modal.setAttribute('aria-hidden', 'true'); }
    unlockPageScroll();
}

// 渲染接口详情：总览 / 结果诊断 / 处理流水线 / 配置覆盖
function renderInterfaceDetail(trace) {
    currentInterfaceTrace = trace || null;
    const loading = document.getElementById('interface-detail-loading');
    const content = document.getElementById('interface-detail-content');
    if (!trace) {
        renderInterfaceFailure('未找到该请求的接口详情');
        return;
    }
    const parts = [
        renderInterfaceOverview(trace),
        renderInterfaceDiagnosis(trace.diagnosis),
        renderInterfaceSteps(trace.steps || []),
        renderInterfaceConfigs(trace.configs || [])
    ];
    content.innerHTML = parts.join('');
    content.hidden = false;
    loading.hidden = true;
    const footer = document.getElementById('interface-detail-footer');
    if (footer) footer.hidden = true;
}

// 总览：方法 / 接口 / 请求时间 / 客户端 IP / 耗时分段
function renderInterfaceOverview(trace) {
    const time = trace.timestamp ? new Date(trace.timestamp).toLocaleString('zh-CN') : '未知';
    const total = trace.totalMs != null ? trace.totalMs : 0;
    const prepare = trace.prepareMs != null ? trace.prepareMs : 0;
    const handler = trace.handlerMs != null ? trace.handlerMs : 0;
    return '<div class="id-section"><h4 class="id-section-title">总览</h4>' +
        '<div class="id-overview-grid">' +
        renderOverviewCell('方法', trace.method) +
        renderOverviewCell('状态码', trace.statusCode != null ? trace.statusCode : '未记录') +
        renderOverviewCell('接口', (trace.path || '') + (trace.query || '')) +
        renderOverviewCell('请求时间', time) +
        renderOverviewCell('客户端 IP', trace.clientIp) +
        renderOverviewCell('总耗时', total + ' ms') +
        renderOverviewCell('准备 / 接口处理', prepare + ' ms / ' + handler + ' ms') +
        '</div></div>';
}

function renderOverviewCell(label, value) {
    return '<div class="id-overview-item"><span class="id-label">' + escapeHtml(label) + '</span><span class="id-value">' + escapeHtml(value) + '</span></div>';
}

// 结果诊断：候选数量变化链与结果归零位置
function renderInterfaceDiagnosis(diagnosis) {
    if (!diagnosis) return '';
    const chain = (diagnosis.chain || []).map(function (item) {
        const cls = item.zero ? ' id-diagnosis-zero' : '';
        // 步骤内部有处理过程时并列展示处理前数量，说明本步数量为何与上一步不同
        const countText = item.rawCount !== undefined && item.rawCount !== null
            ? escapeHtml(item.rawCount) + '→' + escapeHtml(item.count)
            : escapeHtml(item.count);
        return '<span class="id-diagnosis-node' + cls + '">' + escapeHtml(item.name) +
            ' <b>' + countText + '</b></span>';
    }).join('<span class="id-diagnosis-arrow">→</span>');
    const level = diagnosis.zeroStep ? ' id-diagnosis-empty' : '';
    return '<div class="id-section"><h4 class="id-section-title">结果诊断</h4>' +
        '<div class="id-diagnosis' + level + '">' +
        '<div class="id-diagnosis-conclusion">' + escapeHtml(diagnosis.conclusion) + '</div>' +
        (chain ? '<div class="id-diagnosis-chain">' + chain + '</div>' : '') +
        '</div></div>';
}

const idConfigCategoryOrder = ['api', 'source', 'match', 'danmu', 'cache', 'system', 'runtime'];
const idConfigCategoryMeta = {
    api: { label: 'API 配置' },
    source: { label: '源配置' },
    match: { label: '匹配配置' },
    danmu: { label: '弹幕配置' },
    cache: { label: '缓存配置' },
    system: { label: '系统配置' },
    runtime: { label: '运行环境' }
};

// 长取值折叠阈值与配置预览一致
const idValueCollapseLength = 180;

// 结构化取值的字段中文名，界面以中文为主、原始键名以次要样式保留给开发者
const idFieldLabels = {
    // 搜索与匹配
    q: '搜索词', keyword: '搜索词', season: '季', episode: '集', year: '年份', animeId: '剧集 ID',
    fileName: '文件名', sources: '检索源', rawCount: '原始候选', removedBy: '剔除',
    filtersApplied: '启用的过滤', beforeCount: '过滤前数量', filteredCount: '过滤后数量',
    cachedCount: '缓存条数', hit: '命中', cacheKey: '缓存键', ttlMinutes: '有效期（分钟）',
    finalCount: '最终条数', searchCacheWritten: '已写入搜索缓存', mergedCount: '合并后条数', crossSeasonApplied: '跨季扩展',
    mappingHit: '映射命中', candidate: '映射结果', mappingApplied: '应用映射',
    finalSubjectId: '最终剧集 ID', isMatched: '是否匹配', matchCount: '匹配条数',
    matched: '是否匹配', episodeId: '集 ID', startSeason: '起始季', endSeason: '结束季',
    boundaryCount: '季边界数',
    // 映射规则
    title: '标题', matchedKey: '匹配键', origin: '规则来源', localRules: '本机规则数',
    remoteRules: '远程规则数', platform: '平台', rule: '命中规则', url: '地址', triedKeys: '尝试过的键',
    titleMappingTable: '本机映射规则数', titleMappingTableUrl: '远程标题映射地址',
    autoMatchMappingTableUrl: '远程季集映射地址', useBangumiData: '使用 Bangumi Data',
    titleToChinese: '标题转中文',
    // 分集与详情
    anime: '剧名', animeTitle: '剧名', requestedEpisode: '请求集数', searchedAnime: '搜索到的剧集数', matchedEpisodeTitles: '命中集标题',
    animeCount: '剧名数', episodeCount: '集数', fromRequestStore: '来自本次请求缓存',
    sourceKey: '源标识', linkCount: '链接数',
    // 弹幕
    commentId: '弹幕库 ID', episodeTitle: '集标题', resourceKey: '本地资源键', found: '是否找到',
    mergedLinks: '合并链接', segment: '分段请求', format: '输出格式', duration: '视频时长',
    attachDuration: '附带视频时长',
    segmentStart: '片段起点（秒）', segmentEnd: '片段终点（秒）',
    linkOffset: '链接偏移', linkOffsetPercent: '链接偏移按百分比', ruleOffset: '规则偏移', percent: '按百分比', matchedTitle: '参与匹配的剧名',
    // 弹幕候选与收藏
    keywords: '检索关键词', candidateKeywords: '候选关键词', candidateCount: '候选数',
    favoriteName: '收藏名', topScore: '最高匹配分',
    favoriteSupported: '收藏功能可用', schedule: '刷新计划', refreshSchedule: '已生效的刷新计划',
    合并组: '合并组', 单源保留: '单源保留', 结果: '结果', 副源: '副源', 说明: '说明',
    // 其他
    count: '数量', error: '错误', source: '源', removed: '已删除'
};

// 步骤状态的中文名，样式类仍沿用原始状态值
const idStepStatusLabels = {
    ok: '成功', empty: '无结果', hit: '命中', miss: '未命中', fail: '失败', skip: '跳过'
};

// 结构化取值中的枚举值中文名
const idValueLabels = {
    origin: { local: '本机规则', remote: '远程规则' }
};

// 取值为默认形态时视觉弱化，让真正有内容的字段在成组输出中优先被看到
function isQuietFieldValue(value) {
    if (value === null || value === undefined || value === '') return true;
    if (value === false || value === 0) return true;
    if (value === '未设置' || value === '—' || value === '否') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (typeof value === 'object' && Object.keys(value).length === 0) return true;
    return false;
}

// 对象按字段逐项渲染：中文名为主，原始键名与原始枚举值以次要样式附后
function renderDetailFields(obj) {
    return Object.keys(obj).map(function (key) {
        const label = idFieldLabels[key];
        const value = obj[key];
        const rawKey = label ? '<span class="id-raw">' + escapeHtml(key) + '</span>' : '';
        const shown = renderFieldValue(key, value);
        const quiet = isQuietFieldValue(value) ? ' is-quiet' : '';
        return '<div class="id-field' + quiet + '">' +
            '<span class="id-field-key">' + escapeHtml(label || key) + rawKey + '</span>' +
            '<div class="id-field-value">' + shown + '</div></div>';
    }).join('');
}

// 单字段取值：枚举映射为中文并保留原始值；数组与对象递归展开
function renderFieldValue(key, value) {
    if (value === null || value === undefined || value === '') {
        return '<span class="id-field-empty">—</span>';
    }
    if (typeof value === 'boolean') return value ? '是' : '否';
    if (Array.isArray(value)) {
        if (value.length === 0) return '<span class="id-field-empty">—</span>';
        return value.map(function (item) {
            if (item && typeof item === 'object') return renderDetailFields(item);
            return escapeHtml(String(item));
        }).join('<span class="id-field-sep">、</span>');
    }
    if (typeof value === 'object') return renderDetailFields(value);
    const mapped = idValueLabels[key] && idValueLabels[key][value];
    if (mapped) {
        return escapeHtml(mapped) + '<span class="id-raw">' + escapeHtml(String(value)) + '</span>';
    }
    return escapeHtml(String(value));
}

// 生成可折叠取值与展开按钮；配置覆盖、步骤输入输出、配置生效记录共用 togglePreviewValue
function renderDetailValue(value, id) {
    if (Array.isArray(value)) {
        return '<div class="id-fields" id="' + escapeHtml(id) + '">' + renderFieldValue('', value) + '</div>';
    }
    if (value !== null && typeof value === 'object') {
        return '<div class="id-fields" id="' + escapeHtml(id) + '">' + renderDetailFields(value) + '</div>';
    }
    const text = value === null || value === undefined ? '' : String(value);
    const hasNewline = text.indexOf(String.fromCharCode(10)) !== -1;
    const isLong = text.length > idValueCollapseLength || hasNewline;
    const collapsed = isLong ? ' is-collapsed' : '';
    const button = isLong
        ? '<button type="button" class="preview-action-btn preview-expand-btn" onclick="togglePreviewValue(this)" aria-controls="' + escapeHtml(id) + '" aria-expanded="false">展开</button>'
        : '';
    // pre-wrap 会把容器宽度造成的视觉折行复制成换行；仅多行取值保留 pre-wrap，单行取值复制时保持一行
    const wrap = hasNewline ? ' id-multiline' : '';
    return '<code class="id-long-value' + collapsed + wrap + '" id="' + escapeHtml(id) + '">' + escapeHtml(text) + '</code>' + button;
}

// 配置项状态：已读取 / 未读取，并在可判定时叠加已命中 / 未命中
function renderConfigBadges(c) {
    const read = c.used
        ? '<span class="id-badge id-badge-used">已读取</span>'
        : '<span class="id-badge id-badge-unused">未读取</span>';
    if (!c.used || typeof c.hit !== 'boolean') return read;
    const verdict = c.hit
        ? '<span class="id-badge id-badge-hit">已命中</span>'
        : '<span class="id-badge id-badge-miss">未命中</span>';
    return read + verdict;
}

// 切换配置筛选：只改变展示范围，不改变数据
function setInterfaceConfigFilter(filter) {
    if (interfaceConfigFilter === filter) return;
    interfaceConfigFilter = filter;
    if (currentInterfaceTrace) renderInterfaceDetail(currentInterfaceTrace);
}

// 配置覆盖：按分类分组、默认折叠，逐项展示取值 / 状态 / 被哪一步读取
function renderInterfaceConfigs(configs) {
    const all = configs || [];
    const visible = all.filter(function (c) {
        if (interfaceConfigFilter === 'used') return c.used;
        if (interfaceConfigFilter === 'hit') return c.hit === true;
        return true;
    });
    const groups = {};
    visible.forEach(function (c) {
        const category = c.category || 'system';
        if (!groups[category]) groups[category] = [];
        groups[category].push(c);
    });
    let seq = 0;
    // 已知分类按顺序在前，其余分类按字母序追加，避免配置目录中的分类未展示
    const present = Object.keys(groups);
    const ordered = idConfigCategoryOrder.filter(function (category) { return present.indexOf(category) !== -1; })
        .concat(present.filter(function (category) { return idConfigCategoryOrder.indexOf(category) === -1; }).sort());
    const sections = ordered.map(function (category) {
        const meta = idConfigCategoryMeta[category] || { label: category };
        const items = groups[category];
        const usedCount = items.filter(function (c) { return c.used; }).length;
        const hitCount = items.filter(function (c) { return c.hit === true; }).length;
        const rows = items.map(function (c) {
            const valueId = 'id-config-value-' + (seq++);
            // 生效步骤优先：它对应流水线里真正产生变化的那一步
            const stepName = c.effectStep || c.step;
            const step = stepName
                ? '<span class="id-config-step">' + escapeHtml(stepName) + '</span>'
                : '<span class="id-config-step id-config-step-empty">—</span>';
            const description = c.description
                ? '<div class="id-config-description">' + escapeHtml(c.description) + '</div>' : '';
            return '<div class="id-config-row">' +
                '<div class="id-config-name">' + escapeHtml(c.name) + '</div>' +
                '<div class="id-config-value"><div class="id-config-value-box">' +
                renderDetailValue(c.value, valueId) + '</div>' + description + '</div>' +
                '<div class="id-config-used">' + renderConfigBadges(c) + '</div>' +
                '<div class="id-config-step-cell">' + step + '</div>' +
                '</div>';
        }).join('');
        return '<details class="id-config-group">' +
            '<summary class="id-config-group-title">' + escapeHtml(meta.label) +
            '<span class="id-config-group-count">' + items.length + ' 项 · 读取 ' + usedCount +
            (hitCount > 0 ? ' · 命中 ' + hitCount : '') + '</span></summary>' +
            '<div class="id-config-list">' + rows + '</div></details>';
    }).join('');
    const total = all.length;
    const usedCount = all.filter(function (c) { return c.used; }).length;
    const hitCount = all.filter(function (c) { return c.hit === true; }).length;
    const filterButton = function (key, label, count) {
        const active = interfaceConfigFilter === key ? ' is-active' : '';
        return '<button type="button" class="id-filter-btn' + active + '"'
            + ' data-config-filter="' + key + '"'
            + ' onclick="setInterfaceConfigFilter(this.dataset.configFilter)">'
            + label + ' ' + count + '</button>';
    };
    const filters = '<div class="id-config-filters">' +
        filterButton('all', '全部', total) +
        filterButton('used', '仅已读取', usedCount) +
        filterButton('hit', '仅已命中', hitCount) +
        '</div>';
    const emptyHint = visible.length === 0
        ? '<div class="id-config-empty">当前筛选下没有配置项，切换为「全部」查看。</div>' : '';
    return '<div class="id-section"><h4 class="id-section-title">配置覆盖（' + total + ' 项，本次读取 ' + usedCount + ' 项）</h4>' +
        '<div class="id-config-hint">按分类折叠展示：已读取表示本次请求读取过该配置，已命中 / 未命中表示它是否真正改变了处理结果。</div>' +
        filters + emptyHint + sections + '</div>';
}

// 处理流水线：步骤时间线，含状态 / 原因 / 输入 / 输出 / 配置生效记录 / 错误，慢步骤高亮
function renderInterfaceSteps(steps) {
    if (steps.length === 0) {
        return '<div class="id-section"><h4 class="id-section-title">处理流水线</h4>' +
            '<div class="id-no-steps">该请求未记录到处理步骤（可能为页面或静态资源请求）。</div></div>';
    }
    let maxMs = 0;
    steps.forEach(function (s) { if ((s.ms || 0) > maxMs) maxMs = s.ms || 0; });
    // 按执行顺序平铺展示：接口流程是线性的（如先搜索后匹配），序号即真实先后
    const rows = steps.map(function (s, index) {
        const status = s.status || 'ok';
        const statusText = idStepStatusLabels[status] || status;
        const statusBadge = '<span class="id-step-status id-step-status-' + escapeHtml(status) + '">' + escapeHtml(statusText) + '</span>';
        const reason = s.reason ? '<div class="id-step-reason">' + escapeHtml(s.reason) + '</div>' : '';
        const slow = maxMs > 0 && (s.ms || 0) >= maxMs ? ' id-step-slow' : '';
        const inputs = renderKvBlock('输入', s.inputs, 'id-kv-' + index + '-in-');
        const outputs = renderKvBlock('输出', s.outputs, 'id-kv-' + index + '-out-');
        const table = s.table ? renderChangeTable(s.table) : '';
        const changes = renderConfigChanges(s.changes, index);
        const error = s.error ? '<div class="id-step-error">错误：' + escapeHtml(String(s.error)) + '</div>' : '';
        // 左侧轨道：序号 + 连接线，最后一步不画线
        const rail = '<div class="id-step-rail">' +
            '<span class="id-step-index id-step-status-' + escapeHtml(status) + '">' + (index + 1) + '</span>' +
            (index === steps.length - 1 ? '' : '<span class="id-step-line"></span>') + '</div>';
        return '<div class="id-step">' + rail +
            '<div class="id-step-card' + slow + '">' +
            '<div class="id-step-head">' +
            '<span class="id-step-name">' + escapeHtml(s.name) + '</span>' +
            statusBadge +
            '<span class="id-step-ms">' + (s.ms || 0) + ' ms</span>' +
            '</div>' + reason + inputs + outputs + table + changes + error + '</div></div>';
    }).join('');
    return '<div class="id-section"><h4 class="id-section-title">处理流水线</h4>' +
        '<div class="id-config-hint">各步骤耗时为该步骤自身耗时，内部触发的其他步骤单独列出，相加约等于总耗时。</div>' +
        '<div class="id-steps">' + rows + '</div></div>';
}

// 渲染一组带标题的输入/输出键值对，字段行与配置生效记录共用同一渲染函数
// prefix 保证同一弹窗内的元素 id 唯一
function renderKvBlock(title, obj, prefix) {
    if (obj === undefined || obj === null) return '';
    if (typeof obj === 'object' && Object.keys(obj).length === 0) return '';
    return '<div class="id-kv-block"><div class="id-kv-block-title">' + escapeHtml(title) + '</div>' +
        renderDetailValue(obj, prefix + 'root') + '</div>';
}

// 渲染配置生效记录：结论摘要、处理前后取值 / 结构化表格、保留与剔除候选项
function renderConfigChanges(changes, stepIndex) {
    if (!changes || changes.length === 0) return '';
    // 同一步骤里既有统计又有判定时，说明统计中的剔除数量由判定明细展开
    const hasDecision = changes.some(function (change) { return change.kind === 'decision'; });
    const items = changes.map(function (change, index) {
        // 仅命中/未命中可判定的配置展示徽标，键值换算类配置不展示
        // 判定类记录没有剔除项时不展示「未命中」，避免与保留数并列产生矛盾
        const hitBadge = (typeof change.hit === 'boolean' && (change.kind !== 'decision' || change.hit))
            ? (change.hit
                ? '<span class="id-change-hit id-change-hit-yes">命中</span>'
                : '<span class="id-change-hit id-change-hit-no">未命中</span>')
            : '';
        const summary = change.summary
            ? '<div class="id-change-summary">' + escapeHtml(change.summary) + '</div>' : '';
        const crossRef = change.kind === 'stats' && hasDecision
            ? '<div class="id-change-cross-ref">剔除的候选由下方的判定记录逐条说明</div>' : '';
        // 统计与判定类记录展示条件与明细，只有值被改写的记录才展示处理前后
        const head = change.kind === 'stats' || change.kind === 'decision'
            ? renderChangeContext(change)
            : renderChangeFlow(change, stepIndex, index);
        const body = head + (change.table ? renderChangeTable(change.table) : '');
        // 标题判定只是众多过滤环节之一，命中不代表进入最终结果，用准确措辞避免误导
        const isDecision = change.kind === 'decision';
        const kept = renderChangeItems(isDecision ? '标题命中' : '保留', change.kept, change.keptCount, 'kept');
        const removed = renderChangeItems(isDecision ? '标题未命中' : '剔除', change.removed, change.removedCount, 'removed');
        // 判定不对应具体配置项（如默认匹配规则）时只展示说明文字
        const configBadge = change.config
            ? '<span class="id-change-config">' + escapeHtml(change.config) + '</span>' : '';
        return '<div class="id-change">' +
            // 配置名与说明处于同一行内文本流，选中复制时保持一句话而不被换行拆开
            '<div class="id-change-head">' +
            '<span class="id-change-title">' + configBadge +
            (configBadge ? ' ' : '') +
            '<span class="id-change-label">' + escapeHtml(change.label || '') + '</span></span>' + hitBadge + '</div>' +
            summary + crossRef + body + kept + removed + '</div>';
    }).join('');
    return '<div class="id-changes"><div class="id-changes-title">配置生效与过滤判定</div>' + items + '</div>';
}

// 记录条件：检索或判定所依据的输入，不构成处理前后关系
function renderChangeContext(change) {
    if (!change.context) return '';
    const label = change.kind === 'decision' ? '判定条件' : '检索条件';
    return '<div class="id-change-context">' +
        '<span class="id-change-context-label">' + label + '</span>' +
        renderDetailFields(change.context) + '</div>';
}

// 处理前 → 处理后：对象按字段中文名展示，标量按原文展示
function renderChangeFlow(change, stepIndex, index) {
    if (change.before === undefined && change.after === undefined) return '';
    const beforeId = 'id-change-before-' + stepIndex + '-' + index;
    const afterId = 'id-change-after-' + stepIndex + '-' + index;
    return '<div class="id-change-flow">' +
        '<div class="id-change-side"><span class="id-change-side-label">处理前</span><div class="id-change-flow-value">' +
        renderDetailValue(change.before, beforeId) + '</div></div>' +
        '<span class="id-change-arrow">→</span>' +
        '<div class="id-change-side"><span class="id-change-side-label">处理后</span><div class="id-change-flow-value">' +
        renderDetailValue(change.after, afterId) + '</div></div></div>';
}

// 结构化表格：列名由后端给出中文表头，逐行展示每个源 / 每条规则的实际结果
function renderChangeTable(table) {
    const columns = table.columns || [];
    const rows = table.rows || [];
    if (columns.length === 0 || rows.length === 0) return '';
    // 按整列判定数值列：表头与所有单元格用同一套对齐，避免值右对齐而表头左对齐的错位
    const numericColumns = new Set(columns.filter(function (column) {
        return rows.some(function (row) { return typeof row[column] === 'number'; });
    }));
    const align = function (column) { return numericColumns.has(column) ? ' class="id-num"' : ''; };
    const head = '<tr>' + columns.map(function (column) {
        return '<th' + align(column) + '>' + escapeHtml(column) + '</th>';
    }).join('') + '</tr>';
    const body = rows.map(function (row) {
        return '<tr>' + columns.map(function (column) {
            const value = row[column];
            const text = value === null || value === undefined ? '—' : String(value);
            return '<td' + align(column) + '>' + escapeHtml(text) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    return '<div class="id-change-table-wrap"><table class="id-change-table">' +
        '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
}

// 渲染保留/剔除候选项；条目可带判定原因与来源
function renderChangeItems(label, items, total, kind) {
    const list = items || [];
    if (list.length === 0 && !total) return '';
    const rows = list.map(function (item) {
        const aliases = item.aliases && item.aliases.length
            ? '<span class="id-change-item-alias">别名：' + item.aliases.map(escapeHtml).join('、') + '</span>' : '';
        const source = item.source
            ? '<span class="id-change-item-source">' + escapeHtml(item.source) + '</span>' : '';
        const reason = item.reason
            ? '<span class="id-change-item-reason">' + escapeHtml(item.reason) + '</span>' : '';
        return '<div class="id-change-item id-change-item-' + kind + '">' +
            '<div class="id-change-item-main">' +
            '<span class="id-change-item-text">' + escapeHtml(String(item.value)) + '</span>' +
            (aliases ? ' ' + aliases : '') + (source ? ' ' + source : '') + '</div>' +
            reason + '</div>';
    }).join('');
    const more = (typeof total === 'number' && total > list.length)
        ? '<div class="id-change-more">另有 ' + (total - list.length) + ' 项未显示</div>' : '';
    // 默认收起，展开按钮显示条目数
    return '<details class="id-change-items"><summary class="id-change-items-label">' + escapeHtml(label) +
        (typeof total === 'number' ? ' ' + total : '') + '</summary>' + rows + more + '</details>';
}

// 初始化请求记录界面
function initRequestRecordsInterface() {
    // 首次加载时若已处于请求记录页则直接刷新；切换页签时的刷新由 main.js 的 switchSection 处理
    if (document.getElementById('request-records-section') &&
        document.querySelector('.nav-btn[data-section="request-records"]') &&
        document.querySelector('.nav-btn[data-section="request-records"]').classList.contains('active')) {
        renderRequestRecords();
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    if (typeof initRequestRecordsInterface === 'function') {
        initRequestRecordsInterface();
    }
    
    // 添加刷新按钮功能
    const refreshBtn = document.getElementById('refresh-request-records');
    if (refreshBtn) {
        refreshBtn.onclick = function() {
            renderRequestRecords();
        };
    }

});
`;