import { globals } from "../configs/globals.js";
import { baseCssContent } from "./css/base.css.js";
import { componentsCssContent } from "./css/components.css.js";
import { formsCssContent } from "./css/forms.css.js";
import { responsiveCssContent } from "./css/responsive.css.js";
import { themesCssContent } from "./css/themes.css.js";
import { dashboardCssContent } from "./css/dashboard.css.js";
import { iconJsContent, iconsSpriteContent, renderIcon } from "./js/icons.js";
import { mainJsContent } from "./js/main.js";
import { previewJsContent } from "./js/preview.js";
import { logviewJsContent } from "./js/logview.js";
import { systemSettingsJsContent } from "./js/systemsettings.js";
import { dashboardJsContent } from "./js/dashboard.js";

// language=HTML
export const HTML_TEMPLATE = /* html */ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="darkreader-lock">
    <meta name="color-scheme" content="light dark">
    <title>Xdanmu</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%20fill='none'%3E%3Crect%20width='64'%20height='64'%20rx='16'%20fill='%23667eea'/%3E%3Crect%20x='28'%20y='10'%20width='22'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.85'/%3E%3Crect%20x='14'%20y='10'%20width='9'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.45'/%3E%3Ccircle%20cx='54'%20cy='12.25'%20r='2.25'%20fill='white'/%3E%3Ccircle%20cx='10'%20cy='51.75'%20r='2.25'%20fill='white'/%3E%3Crect%20x='15'%20y='49.5'%20width='22'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.85'/%3E%3Crect%20x='41'%20y='49.5'%20width='9'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.45'/%3E%3Cpath%20d='M17%2018L47%2046'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3Cpath%20d='M47%2018L35.5%2028.5'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3Cpath%20d='M28.5%2035.5L17%2046'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3C/svg%3E">
    <link rel="apple-touch-icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%20fill='none'%3E%3Crect%20width='64'%20height='64'%20rx='16'%20fill='%23667eea'/%3E%3Crect%20x='28'%20y='10'%20width='22'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.85'/%3E%3Crect%20x='14'%20y='10'%20width='9'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.45'/%3E%3Ccircle%20cx='54'%20cy='12.25'%20r='2.25'%20fill='white'/%3E%3Ccircle%20cx='10'%20cy='51.75'%20r='2.25'%20fill='white'/%3E%3Crect%20x='15'%20y='49.5'%20width='22'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.85'/%3E%3Crect%20x='41'%20y='49.5'%20width='9'%20height='4.5'%20rx='2.25'%20fill='white'%20fill-opacity='0.45'/%3E%3Cpath%20d='M17%2018L47%2046'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3Cpath%20d='M47%2018L35.5%2028.5'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3Cpath%20d='M28.5%2035.5L17%2046'%20stroke='white'%20stroke-width='7'%20stroke-linecap='round'/%3E%3C/svg%3E">
    <style>${baseCssContent}</style>
    <style>${componentsCssContent}</style>
    <style>${formsCssContent}</style>
    <style>${responsiveCssContent}</style>
    <style>${themesCssContent}</style>
    <style>${dashboardCssContent}</style>


</head>
<body data-theme="globals.uiTheme">
    ${iconsSpriteContent}
    <script>
        try {
            var storedTheme = localStorage.getItem('logvar_ui_theme');
            var validThemes = ['lavender','shinyo','sakura','tianyi','hatsune','sakuragi','violet','amber'];
            if (validThemes.indexOf(storedTheme) !== -1) { document.body.dataset.theme = storedTheme; }
            var storedScheme = localStorage.getItem('logvar_ui_color_scheme');
            if (storedScheme === 'dark' || storedScheme === 'light') {
                document.body.dataset.colorScheme = storedScheme;
            }
        } catch (error) {
            // localStorage may be unavailable in restricted browser contexts.
        }
    </script>
    <div class="container">
        <div class="corner-fold"></div>
        <button class="theme-corner-toggle" id="theme-corner-toggle" onclick="toggleColorScheme()" title="切换明暗模式" aria-label="切换明暗模式">${renderIcon('moon')}</button>
        <!-- 进度条 -->
        <div class="progress-container" id="progress-container">
            <div class="progress-bar" id="progress-bar"></div>
        </div>

        <div class="header">
            <div class="header-left">
                <div class="logo-title-container">
                    <div class="logo" aria-hidden="true" title="Xdanmu"><svg class="logo-mark" viewBox="0 0 64 64" fill="none"><rect x="28" y="10" width="22" height="4.5" rx="2.25" fill="currentColor" fill-opacity="0.85"/><rect x="14" y="10" width="9" height="4.5" rx="2.25" fill="currentColor" fill-opacity="0.45"/><circle cx="54" cy="12.25" r="2.25" fill="currentColor" fill-opacity="0.9"/><circle cx="10" cy="51.75" r="2.25" fill="currentColor" fill-opacity="0.9"/><rect x="15" y="49.5" width="22" height="4.5" rx="2.25" fill="currentColor" fill-opacity="0.85"/><rect x="41" y="49.5" width="9" height="4.5" rx="2.25" fill="currentColor" fill-opacity="0.45"/><path d="M17 18L47 46" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M47 18L35.5 28.5" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><path d="M28.5 35.5L17 46" stroke="currentColor" stroke-width="7" stroke-linecap="round"/></svg></div>
                    <h1>Xdanmu</h1>
                </div>
                <div class="version-info">
                    <span class="version-badge">${renderIcon('tag')} 当前版本: <span id="current-version">globals.currentVersion</span></span>
                    <a class="update-badge" id="update-badge" href="https://github.com/xlmc/danmu_api/releases" target="_blank" rel="noopener" title="有新版本可用" style="display: none;">
                        ${renderIcon('sparkles')} 最新版本: <span id="latest-version"></span>
                    </a>
                    <span class="api-endpoint-badge" onclick="copyApiEndpoint()" title="点击复制API端点" style="cursor: pointer;">
                        ${renderIcon('link')} API端点: <span id="api-endpoint" style="color: #4CAF50; font-weight: bold;">加载中...</span>
                    </span>
                </div>
            </div>
            <div class="nav-buttons">
                <button class="nav-btn active" onclick="switchSection('dashboard', event)">信息汇总</button>
                <button class="nav-btn" onclick="switchSection('preview', event)">配置预览</button>
                <button class="nav-btn" onclick="switchSection('logs', event)">日志查看</button>



                <button class="nav-btn" onclick="switchSection('env', event)" id="env-nav-btn">系统配置</button>
            </div>
        </div>

        <div class="content">
            <!-- 信息汇总 (Dashboard 首页) -->
            <div class="section active" id="dashboard-section">
                <!-- 1. 顶部 4 大核心指标卡片 -->
                <div class="dash-grid-4">
                    <!-- 卡片 1: 系统运行状态 -->
                    <div class="dash-card">
                        <div class="dash-card-header">
                            <span class="dash-card-title">系统运行状态</span>
                            <span class="dash-status-dot normal" id="dash-service-dot" title="服务正常运行"></span>
                        </div>
                        <div class="dash-card-body">
                            <div class="dash-big-text" id="dash-service-text">服务正常</div>
                            <div class="dash-sub-line" style="color: #10b981; font-weight: 600;">
                                Node.js · 端口 <span id="dash-port-val">9321</span>
                            </div>
                            <div class="dash-sub-line" style="margin-top: 10px;">
                                <div class="dash-latency-trigger">
                                    <span class="dash-big-num" style="font-size: 26px; color: #10b981;">16.4</span>
                                    <span class="dash-big-unit">ms</span>
                                    <div class="dash-latency-tooltip">平均解析延迟 · P95: 22ms · P99: 35ms</div>
                                </div>
                            </div>
                        </div>
                        <div class="dash-card-footer">
                            <span>在线时长: 3天 14小时</span>
                            <button class="dash-card-btn" onclick="copyDashboardEndpoint()">复制端点</button>
                        </div>
                    </div>

                    <!-- 卡片 2: 今日请求总量 -->
                    <div class="dash-card">
                        <div class="dash-card-header">
                            <span class="dash-card-title">今日请求总量</span>
                            <span class="dash-card-pill">24H 统计</span>
                        </div>
                        <div class="dash-card-body">
                            <div class="dash-big-num">24,850</div>
                            <div class="dash-sub-line">
                                <span class="dash-trend-up">↑ 14.2%</span> 较昨日同时段
                            </div>
                        </div>
                        <div class="dash-card-footer">
                            <span>峰值吞吐: 38 req/s</span>
                        </div>
                    </div>

                    <!-- 卡片 3: 今日弹幕获取 -->
                    <div class="dash-card">
                        <div class="dash-card-header">
                            <span class="dash-card-title">今日弹幕获取</span>
                            <span class="dash-card-pill">已捕获</span>
                        </div>
                        <div class="dash-card-body">
                            <div class="dash-big-num" style="color: var(--theme-accent);">210.3 <span class="dash-big-unit">万条</span></div>
                            <div class="dash-sub-line">
                                <span class="dash-trend-up">↑ 12.8%</span> 较昨日
                            </div>
                            <div class="dash-sub-line" style="margin-top: 4px; font-weight: 500;">
                                今日已成功获取 1,698 集弹幕
                            </div>
                        </div>
                        <div class="dash-card-footer">
                            <span>多源聚合去重 · 高并发响应</span>
                        </div>
                    </div>

                    <!-- 卡片 4: 缓存命中率 -->
                    <div class="dash-card">
                        <div class="dash-card-header">
                            <span class="dash-card-title">缓存命中率</span>
                            <span class="dash-card-pill">已启用</span>
                        </div>
                        <div class="dash-card-body">
                            <div class="dash-big-num" style="color: var(--theme-accent);">99.4 <span class="dash-big-unit">%</span></div>
                            <div class="dash-sub-line">
                                已累计节省 24.7k 次请求
                            </div>
                        </div>
                        <div class="dash-card-footer">
                            <span>内存 + Redis 缓存</span>
                            <button class="dash-card-btn" onclick="showClearCacheModal()">清理缓存</button>
                        </div>
                    </div>
                </div>

                <!-- 2. 请求趋势模块 (彻底去除红框多余胶囊与冗余代码) -->
                <div class="dash-trend-section">
                    <div class="dash-trend-header">
                        <div class="dash-trend-title-box">
                            <h2 class="dash-trend-title">请求趋势</h2>
                        </div>
                        <div class="dash-trend-controls">
                            <button class="dash-trend-tab-btn active" data-mode="hourly" onclick="renderDashboardTrend('hourly')">今日分时</button>
                            <button class="dash-trend-tab-btn" data-mode="daily" onclick="renderDashboardTrend('daily')">近 7 天</button>
                        </div>
                    </div>
                    <div class="dash-chart-tooltip-bar" id="dash-chart-info">
                        <strong>10:00</strong> · <span>1,140 次请求</span> · <span>74 集弹幕</span> · <span>8.9 万条弹幕</span> · <span>回源 12</span> · <span style="color:#10b981;font-weight:700;">命中率 98.9%</span>
                    </div>
                    <div class="dash-chart-container" id="dash-trend-bars"></div>
                    <div class="dash-chart-axis-x" id="dash-trend-axis"></div>
                </div>
            </div>

            <!-- 配置预览 -->
            <div class="section" id="preview-section">
                <h2>配置预览</h2>

                <div id="proxy-config-container" class="error-config-banner" style="display: none;">
                    <h3 class="error-config-title ui-icon-label">${renderIcon('alert-triangle')} 获取配置失败</h3>
                    <p class="error-config-text">
                        检测到无法获取配置。如果您使用了复杂的反向代理：例如将 <code>http://{ip}:9321/</code> 代理到了 <code>http://{ip}:9321/danmu_api/</code>，请在此处手动输入完整的反代后链接（不包含TOKEN的）
                    </p>
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <input type="text" id="custom-base-url" placeholder="例如: http://192.168.8.1:2333/danmu_api/ (留空保存即恢复默认)" style="flex: 1; min-width: 200px;">
                        <button class="btn btn-primary" onclick="saveBaseUrl()">保存并刷新</button>
                    </div>
                    <p style="color: var(--theme-muted); font-size: 12px; margin-top: 5px;">* 设置将保存在浏览器本地存储中，清除网页的"本地存储空间"或者输入框中留空并保存可恢复默认</p>
                </div>

                <p class="preview-description">当前生效的环境变量配置</p>
                <div class="preview-toolbar">
                    <nav class="preview-categories" id="preview-categories" aria-label="配置分类"></nav>
                    <div class="preview-search">
                        <input
                            type="text"
                            id="preview-search-input"
                            placeholder="搜索键名、值或说明"
                            aria-label="搜索配置"
                            autocomplete="off"
                            oninput="handlePreviewSearch(event)"
                        >
                        <button
                            type="button"
                            class="preview-search-clear"
                            id="preview-search-clear"
                            onclick="clearPreviewSearch()"
                            title="清除搜索"
                            aria-label="清除搜索"
                            hidden
                        >&times;</button>
                    </div>
                </div>
                <div class="preview-status" id="preview-status" aria-live="polite"></div>
                <div class="preview-area" id="preview-area" aria-live="polite">
                    <p class="text-gray">正在加载配置...</p>
                </div>
            </div>

            <!-- 日志查看 -->
            <div class="section" id="logs-section">
                <h2>日志查看</h2>
                <div class="log-controls">
                    <div>
                        <button class="btn btn-primary" onclick="refreshLogs()">${renderIcon('refresh-cw')} 刷新日志</button>
                        <button class="btn btn-danger" onclick="clearLogs()">${renderIcon('trash-2')} 清空日志</button>
                    </div>
                    <span class="lv-note" id="log-update-state" aria-live="polite">尚未获取日志</span>
                </div>
                <div class="lv-tabs" role="tablist" aria-label="日志视图">
                    <button type="button" class="filter-btn active" data-log-view="all" role="tab" aria-selected="true" aria-controls="log-container">全部日志</button>
                    <button type="button" class="filter-btn" data-log-view="match" role="tab" aria-selected="false" aria-controls="log-container">匹配追踪</button>
                </div>
                <div id="log-categories" class="log-filters-container" aria-label="日志分类"></div>
                <div class="lv-toolbar">
                    <input id="log-query" type="search" aria-label="搜索日志" placeholder="搜索作品、错误信息或请求编号…">
                    <select id="log-level" aria-label="日志级别"><option value="all">全部级别</option><option value="warn">警告及错误</option><option value="error">仅错误</option><option value="info">仅信息</option><option value="debug">仅调试</option></select>
                    <details class="lv-source-picker"><summary id="log-source-label">全部来源</summary><div id="log-sources"></div></details>
                    <select id="log-sort" aria-label="匹配排序" hidden><option value="new">最新匹配优先</option><option value="slow">耗时最长优先</option></select>
                    <button type="button" class="btn btn-small" id="log-reset">重置筛选</button>
                </div>
                <div class="lv-reading"><label><input id="log-auto" type="checkbox"> 自动更新（3秒）</label><label><input id="log-follow" type="checkbox" checked> 跟随最新</label><button type="button" class="btn btn-small" id="log-latest">跳到最新</button><button type="button" class="btn btn-small" id="log-export">导出筛选结果</button></div>
                <p id="log-context" class="lv-note" hidden>当前只看请求 #<span id="log-context-id"></span> · 点击“重置筛选”恢复全部记录</p>
                <p id="log-count" class="lv-note" aria-live="polite"></p>
                <div id="log-column-head" class="lv-column-head" aria-hidden="true"><span>时间</span><span>级别</span><span>分类</span><span>来源</span><span>内容 · 点击展开</span></div>
                <div class="log-container" id="log-container"></div>
            </div>




            <!-- 系统配置 -->
            <div class="section" id="env-section">
                <div class="env-section-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <h2 style="margin: 0;">环境变量配置</h2>
                        <p style="margin: 5px 0 0 0; color: #666; font-size: 0.9em;">NAS 配置文件支持热更新；修改 Compose 环境变量后需重建容器</p>
                </div>
                <div class="env-toolbar-actions" style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button class="btn btn-primary config-transfer-btn" onclick="exportSystemConfig()" title="下载当前环境变量配置文件">
                        ${renderIcon('upload')} 导出配置
                    </button>
                    <button class="btn btn-primary config-transfer-btn" onclick="triggerConfigImport()" title="上传 JSON 文件并导入环境变量配置">
                        ${renderIcon('download')} 导入配置
                    </button>
                    <input type="file" id="config-import-file" accept=".json,application/json" style="display: none;" onchange="importSystemConfigFile(this.files[0])">
                    <button class="btn btn-danger" onclick="showClearCacheModal()" title="清理系统缓存">
                        ${renderIcon('trash-2')} 清理缓存
                    </button>

                </div>

                <!-- 清理缓存确认模态框 -->
                <div class="modal" id="clear-cache-modal">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h3>选择要清理的缓存</h3>
                            <button class="close-btn" onclick="hideClearCacheModal()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <p class="cache-clear-hint">请勾选需要清理的缓存项：</p>
                            <div class="cache-clear-toolbar">
                                <span class="cache-clear-count" id="cache-clear-count"></span>
                                <div class="cache-clear-actions">
                                    <button type="button" class="btn btn-secondary btn-sm" onclick="selectAllCacheItems(true)">全选</button>
                                    <button type="button" class="btn btn-secondary btn-sm" onclick="selectAllCacheItems(false)">全不选</button>
                                </div>
                            </div>
                            <div class="cache-clear-options">
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="searchCache" checked onchange="updateCacheClearCount()"> 搜索结果缓存</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="commentCache" checked onchange="updateCacheClearCount()"> 弹幕内容缓存</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="requestHistory" checked onchange="updateCacheClearCount()"> 限流状态</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="animes" checked onchange="updateCacheClearCount()"> 动漫搜索缓存 (animes)</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="bangumiData" checked onchange="updateCacheClearCount()"> 动画元数据缓存 (bangumiData)</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="episodeIds" checked onchange="updateCacheClearCount()"> 剧集ID缓存 (episodeIds)</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="episodeNum" checked onchange="updateCacheClearCount()"> 剧集编号缓存 (episodeNum)</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="lastSelectMap" checked onchange="updateCacheClearCount()"> 最后选择映射缓存 (lastSelectMap)</label>
                                <label class="cache-clear-item"><input type="checkbox" class="app-checkbox" name="cacheItem" value="personSources" checked onchange="updateCacheClearCount()"> 人物名单缓存 (personSources)</label>
                            </div>
                            <p class="cache-clear-note">清理后可能需要重新登录</p>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-success" onclick="confirmClearCache()">确认清理</button>
                            <button class="btn btn-danger" onclick="hideClearCacheModal()">取消</button>
                        </div>
                    </div>
                </div>

                <!-- 重新部署确认模态框 -->

                </div>

                <div class="preview-toolbar env-config-toolbar">
                    <nav class="preview-categories" id="env-categories" aria-label="系统配置分类"></nav>
                    <div class="preview-search">
                        <input
                            type="text"
                            id="env-search-input"
                            placeholder="搜索键名、值或说明"
                            aria-label="搜索系统配置"
                            autocomplete="off"
                            oninput="handleEnvSearch(event)"
                        >
                        <button
                            type="button"
                            class="preview-search-clear"
                            id="env-search-clear"
                            onclick="clearEnvSearch()"
                            title="清除搜索"
                            aria-label="清除搜索"
                            hidden
                        >&times;</button>
                    </div>
                </div>
                <div class="preview-status" id="env-search-status" aria-live="polite"></div>

                <div class="theme-settings" id="theme-settings" hidden>
                    <div class="theme-settings-copy">
                        <h3>界面主题</h3>
                        <span class="theme-current-label" id="theme-current-label">UI_THEME · 经典默认</span>
                    </div>
                    <div class="theme-options" role="radiogroup" aria-label="界面主题选择">
                        <button type="button" role="radio" class="theme-option" data-theme-option="lavender" aria-checked="false" onclick="selectTheme('lavender')" title="经典默认">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#667eea"></i><i style="background:#5a6fd6"></i><i style="background:#eef0f8"></i></span><span class="theme-option-label">经典默认</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="shinyo" aria-checked="false" onclick="selectTheme('shinyo')" title="新叶绿">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#8cb48c"></i><i style="background:#7aa37a"></i><i style="background:#e8efe8"></i></span><span class="theme-option-label">新叶绿</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="sakura" aria-checked="false" onclick="selectTheme('sakura')" title="哔哩粉">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#f09199"></i><i style="background:#e08189"></i><i style="background:#ece6ef"></i></span><span class="theme-option-label">哔哩粉</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="tianyi" aria-checked="false" onclick="selectTheme('tianyi')" title="天依蓝">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#00a2ff"></i><i style="background:#0090e8"></i><i style="background:#e7edf5"></i></span><span class="theme-option-label">天依蓝</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="hatsune" aria-checked="false" onclick="selectTheme('hatsune')" title="初音青">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#39c5bb"></i><i style="background:#2eb3a9"></i><i style="background:#e6f2f0"></i></span><span class="theme-option-label">初音青</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="sakuragi" aria-checked="false" onclick="selectTheme('sakuragi')" title="樱木红">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#e9485e"></i><i style="background:#d63d52"></i><i style="background:#f0e7e9"></i></span><span class="theme-option-label">樱木红</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="violet" aria-checked="false" onclick="selectTheme('violet')" title="罗兰紫">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#a682e6"></i><i style="background:#9570d8"></i><i style="background:#ede8f5"></i></span><span class="theme-option-label">罗兰紫</span>
                        </button>
                        <button type="button" role="radio" class="theme-option" data-theme-option="amber" aria-checked="false" onclick="selectTheme('amber')" title="LCL橘">
                            <span class="theme-swatches" aria-hidden="true"><i style="background:#f78c50"></i><i style="background:#e67a40"></i><i style="background:#f0ebe6"></i></span><span class="theme-option-label">LCL橘</span>
                        </button>
                    </div>
                </div>

                <div class="env-list" id="env-list"></div>
            </div>
        </div>
    </div>

    <!-- 加载遮罩层 -->
    <div class="loading-overlay" id="loading-overlay">
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <div class="loading-text" id="loading-text">正在处理...</div>
            <div class="loading-detail" id="loading-detail">请稍候</div>
        </div>
    </div>



    <!-- 编辑模态框 -->
    <div class="modal" id="env-modal">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="modal-title">编辑配置项</h3>
                <button class="close-btn" onclick="closeModal()">&times;</button>
            </div>
            <form id="env-form">
                <div class="form-group">
                    <label>变量类别</label>
                    <div class="readonly-field" id="env-category-display"></div>
                </div>
                <div class="form-group">
                    <label>变量名</label>
                    <div class="readonly-field" id="env-key-display"></div>
                </div>
                <div class="form-group">
                    <label>值类型</label>
                    <div class="readonly-field" id="value-type-display"></div>
                </div>
                <div class="form-group" id="value-input-container">
                    <!-- 动态渲染的值输入控件 -->
                </div>
                <div class="form-group">
                    <label>描述</label>
                    <div class="readonly-field" id="env-description-display"></div>
                </div>
                <div style="display: flex; gap: 10px;">
                    <button type="submit" class="btn btn-success" style="flex: 1;">保存</button>
                    <button type="button" class="btn btn-danger" onclick="closeModal()" style="flex: 1;">取消</button>
                </div>
            </form>
        </div>
    </div>

    <!-- 项目声明 -->
    <footer class="footer">
        <p class="footer-text">
            基于上游 danmu_api 的个人自用弹幕 API，保留自用映射、过滤与日志功能，兼容弹弹play接口；仅维护 NAS Docker Compose 部署，镜像由本仓库 GitHub Actions 发布到 GHCR。
        </p>
        <p class="footer-text">本项目仅为个人学习爱好开发，代码开源。如有任何侵权行为，请联系本人删除。</p>
        <p class="footer-text">本项目完全免费，不收取任何费用，请勿上当受骗。</p>
    </footer>

    <script>
        ${iconJsContent}
        ${mainJsContent}
        ${previewJsContent}
        ${logviewJsContent}
        ${systemSettingsJsContent}
        ${dashboardJsContent}
    </script>
</body>
</html>
`;
