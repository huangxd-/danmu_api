import { globals } from "../configs/globals.js";
import { baseCssContent } from "./css/base.css.js";
import { componentsCssContent } from "./css/components.css.js";
import { formsCssContent } from "./css/forms.css.js";
import { responsiveCssContent } from "./css/responsive.css.js";
import { mainJsContent } from "./js/main.js";
import { previewJsContent } from "./js/preview.js";
import { logviewJsContent } from "./js/logview.js";
import { apitestJsContent } from "./js/apitest.js";
import { pushDanmuJsContent } from "./js/pushdanmu.js";
import { requestRecordsJsContent } from "./js/requestrecords.js";
import { systemSettingsJsContent } from "./js/systemsettings.js";

// language=HTML
export const HTML_TEMPLATE = /* html */ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LogVar弹幕API</title>
    <link rel="icon" type="image/jpg" href="https://i.mji.rip/2025/09/27/eedc7b701c0fa5c1f7c175b22f441ad9.jpeg">
    <link rel="apple-touch-icon" href="https://i.mji.rip/2025/09/27/eedc7b701c0fa5c1f7c175b22f441ad9.jpeg">
    <style>${baseCssContent}</style>
    <style>${componentsCssContent}</style>
    <style>${formsCssContent}</style>
    <style>${responsiveCssContent}</style>
    
</head>
<body>
    <div class="container">
        <!-- 进度条 -->
        <div class="progress-container" id="progress-container">
            <div class="progress-bar" id="progress-bar"></div>
        </div>

        <div class="header">
            <div class="header-left">
                <div class="logo-title-container">
                    <div class="logo"><img src="https://i.mji.rip/2025/09/27/eedc7b701c0fa5c1f7c175b22f441ad9.jpeg" width="500"/></div>
                    <h1>LogVar弹幕API</h1>
                </div>
                <div class="version-info">
                    <span class="version-badge">当前版本: <span id="current-version">v${globals.version}</span></span>
                    <span class="update-badge" id="update-badge">
                        🎉 最新版本: <span id="latest-version">加载中...</span>
                    </span>
                    <span class="api-endpoint-badge">
                        API端点: <span id="api-endpoint" title="点击复制API端点" style="cursor: pointer; color: #4CAF50; font-weight: bold;" onclick="copyApiEndpoint()">加载中...</span>
                    </span>
                </div>
            </div>
            <div class="nav-buttons">
                <button class="nav-btn active" onclick="switchSection('preview', event)">配置预览</button>
                <button class="nav-btn" onclick="switchSection('logs', event)">日志查看</button>
                <button class="nav-btn" onclick="switchSection('api', event)">接口调试</button>
                <button class="nav-btn" onclick="switchSection('push', event)">推送弹幕</button>
                <button class="nav-btn" onclick="switchSection('request-records', event)">请求记录</button>
                <button class="nav-btn" onclick="switchSection('env', event)" id="env-nav-btn">系统配置</button>
            </div>
        </div>

        <div class="content">
            <!-- 配置预览 -->
            <div class="section active" id="preview-section">
                <h2>配置预览</h2>
                
                <div id="proxy-config-container" style="display: none; background: #fff3cd; border: 1px solid #ffeeba; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
                    <h3 style="color: #856404; margin-top: 0; font-size: 16px;">⚠️ 获取配置失败</h3>
                    <p style="color: #856404; margin-bottom: 10px; font-size: 14px;">
                        检测到无法获取配置。如果您使用了复杂的反向代理：例如将 <code>http://{ip}:9321/</code> 代理到了 <code>http://{ip}:9321/danmu_api/</code>，请在此处手动输入完整的反代后链接（不包含TOKEN和ADMIN_TOKEN的）
                    </p>
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <input type="text" id="custom-base-url" placeholder="例如: http://192.168.8.1:2333/danmu_api/ (留空保存即恢复默认)" style="flex: 1; min-width: 200px; padding: 8px; border: 1px solid #ced4da; border-radius: 4px;">
                        <button class="btn btn-primary" onclick="saveBaseUrl()">保存并刷新</button>
                    </div>
                    <p style="color: #666; font-size: 12px; margin-top: 5px;">* 设置将保存在浏览器本地存储中，清除网页的‘本地存储空间’或者输入框中留空并保存可恢复默认</p>
                </div>

                <p style="color: #666; margin-bottom: 20px;">当前生效的环境变量配置</p>
                <div class="preview-area" id="preview-area"></div>
            </div>

            <!-- 日志查看 -->
            <div class="section" id="logs-section">
                <h2>日志查看</h2>
                <div class="log-controls">
                    <div>
                        <button class="btn btn-primary" onclick="refreshLogs()">🔄 刷新日志</button>
                        <button class="btn btn-danger" onclick="clearLogs()">🗑️ 清空日志</button>
                    </div>
                    <span style="color: #666;">实时日志监控</span>
                </div>
                <div class="log-container" id="log-container"></div>
            </div>

            <!-- 接口调试 -->
            <div class="section" id="api-section">
                <h2>接口调试</h2>
                <div class="api-top-tabs">
                    <button class="api-top-tab active" onclick="switchApiTopTab('debug', event)">接口调试</button>
                    <button class="api-top-tab" onclick="switchApiTopTab('danmu-test', event)">弹幕测试</button>
                </div>

                <div class="api-tab-content active" id="api-debug-content">
                    <div class="api-selector">
                        <div class="form-group">
                            <label>选择接口</label>
                            <select id="api-select" onchange="loadApiParams()">
                                <option value="">-- 请选择接口 --</option>
                                <option value="searchAnime">搜索动漫 - /api/v2/search/anime</option>
                                <option value="searchEpisodes">搜索剧集 - /api/v2/search/episodes</option>
                                <option value="matchAnime">匹配动漫 - /api/v2/match</option>
                                <option value="getBangumi">获取番剧详情 - /api/v2/bangumi/:animeId</option>
                                <option value="getComment">获取弹幕 - /api/v2/comment/:commentId</option>
                                <option value="getSegmentComment">获取分片弹幕 - /api/v2/segmentcomment</option>
                            </select>
                        </div>
                    </div>
                    <div class="api-params" id="api-params" style="display: none;">
                        <h3 style="margin-bottom: 15px;">接口参数</h3>
                        <div id="params-form"></div>
                        <button class="btn btn-success" onclick="testApi()">发送请求</button>
                    </div>
                    <div id="api-response-container" style="display: none;">
                        <h3 style="margin: 20px 0 10px;">响应结果</h3>
                        <div class="api-response" id="api-response"></div>
                    </div>
                </div>

                <div class="api-tab-content" id="danmu-test-content">
                    <div class="danmu-test-tabs">
                        <button class="danmu-test-tab active" onclick="switchDanmuTestTab('auto', event)">自动匹配测试</button>
                        <button class="danmu-test-tab" onclick="switchDanmuTestTab('manual', event)">手动匹配测试</button>
                    </div>

                    <div class="danmu-test-panel active" id="auto-match-panel">
                        <p style="color: #666; margin-bottom: 15px;">模拟播放器自动匹配流程：输入文件名 → 匹配剧集 → 获取弹幕</p>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label>文件名</label>
                            <div style="display:flex;gap:10px;margin-top:5px;">
                                <input type="text" id="auto-match-filename" placeholder="示例: 生万物 S02E08, 无忧渡.S02E08.2160p.WEB-DL" style="flex:1;">
                                <button class="btn btn-success" id="auto-match-btn" onclick="autoMatchTest()">开始匹配</button>
                            </div>
                        </div>
                    </div>

                    <div class="danmu-test-panel" id="manual-match-panel">
                        <p style="color: #666; margin-bottom: 15px;">模拟播放器手动搜索流程：搜索动漫 → 选择番剧 → 选择剧集 → 获取弹幕</p>
                        <div class="form-group" style="margin-bottom: 15px;">
                            <label>搜索关键字</label>
                            <div style="display:flex;gap:10px;margin-top:5px;">
                                <input type="text" id="manual-search-keyword" placeholder="请输入动漫名称" style="flex:1;">
                                <button class="btn btn-primary" id="manual-search-btn" onclick="manualSearchAnime()">搜索</button>
                            </div>
                        </div>
                        <div id="manual-anime-list" style="display:none;"></div>
                        <div id="manual-episode-list" style="display:none;"></div>
                    </div>

                    <div id="danmu-result-area" style="display:none;"></div>
                </div>
            </div>

            <!-- 推送弹幕 -->
            <div class="section" id="push-section">
                <h2>推送弹幕</h2>
                <p style="color: #666; margin-bottom: 15px;">支持OK影视等播放器，两端需要在同一局域网或使用公网ip，推送地址格式如 http://127.0.0.1:9978/action?do=refresh&type=danmaku&path=</p>
                <div class="push-controls" style="margin-bottom: 20px;">
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label>推送地址</label>
                        <input type="text" id="push-url" placeholder="请输入推送地址，例如: http://127.0.0.1:9978/action?do=refresh&type=danmaku&path=" style="width: 100%; padding: 8px; margin-top: 5px;">
                    </div>
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label>搜索关键字</label>
                        <div style="margin-top: 5px;">
                            <input type="text" id="push-search-keyword" placeholder="请输入搜索关键字" style="width: calc(100% - 100px); padding: 8px; display: inline-block;">
                            <button class="btn btn-primary" onclick="searchAnimeForPush()" style="width: 80px; display: inline-block; margin-left: 10px;">搜索</button>
                        </div>
                    </div>
                </div>
                <div id="push-anime-list" class="anime-list" style="display: none;"></div>
                <div id="push-episode-list" class="episode-list" style="display: none; margin-top: 20px;"></div>
            </div>

            <!-- 请求记录 -->
            <div class="section" id="request-records-section">
                <h2>请求记录</h2>
                <div class="log-controls">
                    <div>
                        <button class="btn btn-primary" id="refresh-request-records">🔄 刷新记录</button>
                        <span id="total-requests-today" style="color: #ff5722; margin-left: 15px; vertical-align: middle; font-size: 1.2em; font-weight: bold;"></span>
                    </div>
                    <span style="color: #666;">云服务部署需要配置redis</span>
                </div>
                <div class="request-records-container" id="request-records-list"></div>
            </div>

            <!-- 系统配置 -->
            <div class="section" id="env-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
                    <div>
                        <h2 style="margin: 0;">环境变量配置</h2>
                        <p style="margin: 5px 0 0 0; color: #666; font-size: 0.9em;">vercel/netlify/edgeone平台修改变量后需要重新部署</p>
                    </div>
                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                    <button class="btn btn-danger" onclick="showClearCacheModal()" title="清理系统缓存">
                        🗑️ 清理缓存
                    </button>
                    <button class="btn btn-success" onclick="showDeploySystemModal()" title="重新部署系统">
                        🚀 重新部署
                    </button>
                </div>

                <!-- 清理缓存确认模态框 -->
                <div class="modal" id="clear-cache-modal">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h3>确认清理缓存</h3>
                            <button class="close-btn" onclick="hideClearCacheModal()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <p style="margin-bottom: 20px;">确定要清理所有缓存吗？这将清除：</p>
                            <ul class="confirmation-list">
                                <li>动漫搜索缓存 (animes)</li>
                                <li>剧集ID缓存 (episodeIds)</li>
                                <li>剧集编号缓存 (episodeNum)</li>
                                <li>最后选择映射缓存 (lastSelectMap)</li>
                                <li>搜索结果缓存</li>
                                <li>弹幕内容缓存</li>
                                <li>请求历史记录</li>
                            </ul>
                            <p style="color: #666; margin-top: 20px;">清理后可能需要重新登录</p>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-success" onclick="confirmClearCache()">确认清理</button>
                            <button class="btn btn-danger" onclick="hideClearCacheModal()">取消</button>
                        </div>
                    </div>
                </div>

                <!-- 重新部署确认模态框 -->
                <div class="modal" id="deploy-system-modal">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h3>确认重新部署</h3>
                            <button class="close-btn" onclick="hideDeploySystemModal()">&times;</button>
                        </div>
                        <div class="modal-body">
                            <p style="margin-bottom: 20px;">确定要重新部署系统吗？</p>
                            <div class="warning-box">
                                <p style="margin: 0;">部署过程中：</p>
                                <ul class="confirmation-list">
                                    <li>系统将短暂不可用</li>
                                    <li>所有配置将重新加载</li>
                                    <li>服务将自动重启</li>
                                </ul>
                                <p style="margin-top: 10px;">预计耗时：30-90秒</p>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-success" onclick="confirmDeploySystem()">确认部署</button>
                            <button class="btn btn-danger" onclick="hideDeploySystemModal()">取消</button>
                        </div>
                    </div>
                </div>
                </div>

                <div class="env-categories">
                    <button class="category-btn active" onclick="switchCategory('api', event)">🔗 API配置</button>
                    <button class="category-btn" onclick="switchCategory('source', event)">📜 源配置</button>
                    <button class="category-btn" onclick="switchCategory('match', event)">🔍 匹配配置</button>
                    <button class="category-btn" onclick="switchCategory('danmu', event)">🔣 弹幕配置</button>
                    <button class="category-btn" onclick="switchCategory('cache', event)">💾 缓存配置</button>
                    <button class="category-btn" onclick="switchCategory('system', event)">⚙️ 系统配置</button>
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
                    <select id="env-category" disabled>
                        <option value="api">🔗 API配置</option>
                        <option value="source">📜 源配置</option>
                        <option value="match">🔍 匹配配置</option>
                        <option value="danmu">🔣 弹幕配置</option>
                        <option value="cache">💾 缓存配置</option>
                        <option value="system">⚙️ 系统配置</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>变量名</label>
                    <input type="text" id="env-key" placeholder="例如: DB_HOST" required readonly>
                </div>
                <div class="form-group">
                    <label>值类型</label>
                    <select id="value-type" onchange="renderValueInput()" disabled>
                        <option value="text">文本</option>
                        <option value="boolean">布尔值</option>
                        <option value="number">数字 (1-100)</option>
                        <option value="select">单选</option>
                        <option value="multi-select">多选 (可排序)</option>
                        <option value="map">映射</option>
                    </select>
                </div>
                <div class="form-group" id="value-input-container">
                    <!-- 动态渲染的值输入控件 -->
                    </div>
                <div class="form-group">
                    <label>描述</label>
                    <textarea id="env-description" placeholder="配置项说明" readonly></textarea>
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
            一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔咪人韩巴狐乐西埋帆弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/hf等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。
        </p>
        <p class="footer-text">本项目仅为个人学习爱好开发，代码开源。如有任何侵权行为，请联系本人删除。</p>
        <p class="footer-text">本项目完全免费，不收取任何费用，请勿上当受骗。</p>
        <p class="footer-links">
            <a href="https://t.me/ddjdd_bot" target="_blank" class="footer-link">💬 TG MSG ROBOT</a>
            <a href="https://t.me/logvar_danmu_group" target="_blank" class="footer-link">👥 TG GROUP</a>
            <a href="https://t.me/logvar_danmu_channel" target="_blank" class="footer-link">📢 TG CHANNEL</a>
            <a href="https://github.com/huangxd-/danmu_api" target="_blank" class="footer-link github-link">
                <img src="https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg" alt="GitHub" class="github-icon">
                GitHub Repo
            </a>
        </p>
        <p>有问题提issue或私信机器人都ok</p>
    </footer>

    <script>
        ${mainJsContent}
        ${previewJsContent}
        ${logviewJsContent}
        ${apitestJsContent}
        ${pushDanmuJsContent}
        ${requestRecordsJsContent}
        ${systemSettingsJsContent}
    </script>
</body>
</html>
`;
