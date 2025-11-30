import { globals } from "../configs/globals.js";
import { jsonResponse } from "../utils/http-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";
import { formatLogMessage } from "../utils/log-util.js";

export function handleUI() {
  return new Response(HTML_TEMPLATE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function handleConfig() {
  // 获取环境变量配置
  const envVarConfig = globals.envVarConfig;
  
  // 分类环境变量
  const categorizedVars = {
    api: [],
    source: [],
    match: [],
    danmu: [],
    cache: [],
    system: []
  };
  
  // 获取所有环境变量 - 这是用于配置预览的
  const previewEnvVars = {
    ...globals.accessedEnvVars,
    localCacheValid: globals.localCacheValid,
    redisValid: globals.redisValid,
    deployPlatform: globals.deployPlatform
  };
  
  // 将环境变量按分类组织 - 使用原始环境变量进行分类，但保持预览格式
  Object.keys(previewEnvVars).forEach(key => {
    const varConfig = envVarConfig[key] || { category: 'system', type: 'text', description: '未分类配置项' };
    const category = varConfig.category || 'system';
    
    categorizedVars[category].push({
      key: key,
      value: previewEnvVars[key].value || previewEnvVars[key], // 如果是新格式则取value字段，否则直接使用原值
      type: previewEnvVars[key].type || varConfig.type || 'text', // 如果是新格式则取type字段，否则使用配置中的type或默认text
      description: varConfig.description || '无描述',
      options: previewEnvVars[key].options || varConfig.options // 如果是新格式则取options字段
    });
  });
  
  return jsonResponse({
    message: "Welcome to the LogVar Danmu API server",
    version: globals.VERSION,
    envs: previewEnvVars, // 配置预览使用
    categorizedEnvVars: categorizedVars,
    envVarConfig: envVarConfig,
    originalEnvVars: globals.originalEnvVars, // 系统设置使用原始环境变量
    repository: "https://github.com/huangxd-/danmu_api.git",
    description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
    notice: "本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok，TG MSG ROBOT: [https://t.me/ddjdd_bot]; 推荐加互助群咨询，TG GROUP: [https://t.me/logvar_danmu_group]; 关注频道获取最新更新内容，TG CHANNEL: [https://t.me/logvar_danmu_channel]。"
  });
}

/**
 * 处理获取日志的请求
 * @returns {Response} 包含日志文本的响应
 */
export function handleLogs() {
  const logText = globals.logBuffer
    .map(
      (log) =>
        `[${log.timestamp}] ${log.level}: ${formatLogMessage(log.message)}`
    )
    .join("\n");
  return new Response(logText, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * 处理清除日志的请求
 * @returns {Response} 表示操作成功的响应
 */
export function handleClearLogs() {
  globals.logBuffer = [];
  return jsonResponse({ success: true, message: "Logs cleared" }, 200);
}
