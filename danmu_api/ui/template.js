import { globals } from "../configs/globals.js";
import { baseCssContent } from "./css/base.css.js";
import { componentsCssContent } from "./css/components.css.js";
import { formsCssContent } from "./css/forms.css.js";
import { responsiveCssContent } from "./css/responsive.css.js";
import { jsContent } from "./js/main.js";

// language=HTML
export const HTML_TEMPLATE = /* html */ `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LogVar弹幕API后台配置管理系统</title>
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
                <div class="logo"><img src="https://i.mji.rip/2025/09/27/eedc7b701c0fa5c1f7c175b22f441ad9.jpeg" width="500"/></div>
                <div class="header-info">
                    <h1>LogVar弹幕API后台配置管理系统</h1>
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
            </div>
            <div class="nav-buttons">
                <button class="nav-btn active" onclick="switchSection('preview')">配置预览</button>
                <button class="nav-btn" onclick="switchSection('logs')">日志查看</button>
                <button class="nav-btn" onclick="switchSection('api')">接口调试</button>
                <button class="nav-btn" onclick="switchSection('push')">推送弹幕</button>
                <button class="nav-btn" onclick="switchSection('env')" id="env-nav-btn">系统配置</button>
            </div>
        </div>

        <div class="content">
            <!-- 配置预览 -->
            <div class="section active" id="preview-section">
                <h2>配置预览</h2>
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
                <div class="api-selector">
                    <div class="form-group">
                        <label>选择接口</label>
                        <select id="api-select" onchange="loadApiParams()">
                            <option value="">请选择接口</option>
                            <option value="searchAnime">搜索动漫 - /api/v2/search/anime</option>
                            <option value="searchEpisodes">搜索剧集 - /api/v2/search/episodes</option>
                            <option value="matchAnime">匹配动漫 - /api/v2/match</option>
                            <option value="getBangumi">获取番剧详情 - /api/v2/bangumi/:animeId</option>
                            <option value="getComment">获取弹幕 - /api/v2/comment/:commentId</option>
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

            <!-- 推送弹幕 -->
            <div class="section" id="push-section">
                <h2>推送弹幕</h2>
                <div class="push-controls" style="margin-bottom: 20px;">
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label>推送地址</label>
                        <input type="text" id="push-url" placeholder="请输入推送地址，例如: http://192.168.1.1:8080/api/danmu" style="width: 100%; padding: 8px; margin-top: 5px;">
                    </div>
                    <div class="form-group" style="margin-bottom: 15px;">
                        <label>搜索关键字</label>
                        <div style="display: flex; gap: 10px; margin-top: 5px;">
                            <input type="text" id="push-search-keyword" placeholder="请输入搜索关键字" style="flex: 1; padding: 8px;">
                            <button class="btn btn-primary" onclick="searchAnimeForPush()">搜索</button>
                        </div>
                    </div>
                </div>
                <div id="push-anime-list" class="anime-list" style="display: none;"></div>
                <div id="push-episode-list" class="episode-list" style="display: none; margin-top: 20px;"></div>
            </div>

            <!-- 系统配置 -->
            <div class="section" id="env-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
                    <h2 style="margin: 0;">环境变量配置</h2>
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
                    <button class="category-btn active" onclick="switchCategory('api')">🔗 API配置</button>
                    <button class="category-btn" onclick="switchCategory('source')">📜 源配置</button>
                    <button class="category-btn" onclick="switchCategory('match')">🔍 匹配配置</button>
                    <button class="category-btn" onclick="switchCategory('danmu')">🔣 弹幕配置</button>
                    <button class="category-btn" onclick="switchCategory('cache')">💾 缓存配置</button>
                    <button class="category-btn" onclick="switchCategory('system')">⚙️ 系统配置</button>
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
            一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。
        </p>
        <p class="footer-text">本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。</p>
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

    <script>${jsContent}</script>
</body>
</html>
`;
