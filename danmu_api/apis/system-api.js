import * as fs from 'fs';
import * as pathModule from 'path';
import { globals } from "../configs/globals.js";
import { log } from "../utils/log-util.js";
import { jsonResponse } from "../utils/http-util.js";
import { getDirname } from "../utils/cache-util.js";
import { HTML_TEMPLATE } from "../ui/template.js";

export function handleUI() {
  // try {
  //   // 读取 HTML 文件
  //   const htmlPath = pathModule.join(getDirname(), '..', 'ui', 'index.html');
  //   const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  //
  //   log("info", "Accessed UI page");
  //
  //   return new Response(htmlContent, {
  //     headers: {
  //       "Content-Type": "text/html; charset=utf-8",
  //       "Access-Control-Allow-Origin": "*"
  //     }
  //   });
  // } catch (error) {
  //   log("error", `Failed to load UI page: ${error.message}`);
  //   return jsonResponse(
  //     { errorCode: 500, success: false, errorMessage: "Failed to load UI page" },
  //     500
  //   );
  // }
  return new Response(HTML_TEMPLATE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function handleConfig() {
  return jsonResponse({
    message: "Welcome to the LogVar Danmu API server",
    version: globals.VERSION,
    envs: {
      ...globals.accessedEnvVars,
      localCacheValid: globals.localCacheValid,
      redisValid: globals.redisValid
    },
    repository: "https://github.com/huangxd-/danmu_api.git",
    description: "一个人人都能部署的基于 js 的弹幕 API 服务器，支持爱优腾芒哔人韩巴弹幕直接获取，兼容弹弹play的搜索、详情查询和弹幕获取接口规范，并提供日志记录，支持vercel/netlify/edgeone/cloudflare/docker/claw等部署方式，不用提前下载弹幕，没有nas或小鸡也能一键部署。",
    notice: "本项目仅为个人爱好开发，代码开源。如有任何侵权行为，请联系本人删除。有问题提issue或私信机器人都ok，TG MSG ROBOT: [https://t.me/ddjdd_bot]; 推荐加互助群咨询，TG GROUP: [https://t.me/logvar_danmu_group]; 关注频道获取最新更新内容，TG CHANNEL: [https://t.me/logvar_danmu_channel]。"
  });
}

export function handleUiStatic(path) {
  try {
    // 移除 /ui/ 前缀，获取相对路径
    const relativePath = path.substring(4); // 去掉 "/ui/"
    const filePath = pathModule.join(getDirname(), '..', 'ui', relativePath);

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return jsonResponse({errorCode: 404, success: false, errorMessage: "File not found"}, 404);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');

    // 根据文件扩展名设置 Content-Type
    const ext = pathModule.extname(filePath).toLowerCase();
    const contentTypeMap = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml'
    };
    const contentType = contentTypeMap[ext] || 'text/plain; charset=utf-8';

    log("info", `Accessed static file: ${relativePath}`);

    return new Response(fileContent, {
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    log("error", `Failed to load static file: ${error.message}`);
    return jsonResponse(
        {errorCode: 500, success: false, errorMessage: "Failed to load file"},
        500
    );
  }
}