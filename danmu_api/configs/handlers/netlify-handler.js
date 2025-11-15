import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpPost, httpPatch, httpDelete } from "../../utils/http-util.js";

// =====================
// Netlify环境变量处理类
// =====================

export class NetlifyHandler extends BaseHandler {
  async setEnv(key, value) {
    try {
      // 更新云端环境变量
      const url = `https://api.netlify.com/api/v1/accounts/${globals.deployPlatformAccount}/env?site_id=${globals.deployPlatformProject}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = {
        key: key,
        value: value.toString(),
        target: envItem.target,
        type: envItem.type,
      }
      await httpPatch(url, JSON.stringify(data), options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  async addEnv(key, value) {
    try {
      // 更新云端环境变量
      const url = `https://api.vercel.com/v10/projects/${globals.deployPlatformProject}/env`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = {
        key: key,
        value: value.toString(),
        target: [
          'production',
          'preview',
          'development',
        ],
        type: 'encrypted',
      }
      await httpPost(url, JSON.stringify(data), options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to add environment variable:', error.message);
    }
  }

  async delEnv(key) {
    // 首先获取云端环境变量
    const envItem = await this._getEevId(key);
    if (!envItem) {
      log("error", '[server] Error setEnv: 没有找到对应的环境变量！');
      return;
    }

    try {
      // 更新云端环境变量
      const url = `https://api.vercel.com/v9/projects/${globals.deployPlatformProject}/env/${envItem.id}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      await httpDelete(url, options);

      return this.delLocalEnv(key);
    } catch (error) {
      log("error", '[server] ✗ Failed to add environment variable:', error.message);
    }
  }
}