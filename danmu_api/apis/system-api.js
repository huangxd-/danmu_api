import { globals } from "../configs/globals.js";
import { jsonResponse } from "../utils/http-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";
import { Envs } from "../configs/envs.js";

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
  const config = Envs.load();
  const envVarConfig = config.envVarConfig;
  
  // 分类环境变量
  const categorizedVars = {
    api: [],
    source: [],
    match: [],
    danmu: [],
    cache: [],
    system: []
  };
  
  // 获取所有环境变量
  const allEnvVars = {
    ...globals.accessedEnvVars,
    localCacheValid: globals.localCacheValid,
    redisValid: globals.redisValid
  };
  
  // 将环境变量按分类组织
  Object.keys(allEnvVars).forEach(key => {
    const varConfig = envVarConfig[key] || { category: 'system', description: '未分类配置项' };
    const category = varConfig.category || 'system';
    
    categorizedVars[category].push({
      key: key,
      value: allEnvVars[key],
      description: varConfig.description || '无描述'
    });
  });
  
  return jsonResponse({
    message: "Welcome to the LogVar Danmu API server",
    version: globals.VERSION,
    envs: allEnvVars,
    categorizedEnvVars: categorizedVars,
    envVarConfig: envVarConfig,
    repository: "https://github.com/huangxd-/danmu_api.git",
    description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
    notice: "本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok，TG MSG ROBOT: [https://t.me/ddjdd_bot]; 推荐加互助群咨询，TG GROUP: [https://t.me/logvar_danmu_group]; 关注频道获取最新更新内容，TG CHANNEL: [https://t.me/logvar_danmu_channel]。"
  });
}
