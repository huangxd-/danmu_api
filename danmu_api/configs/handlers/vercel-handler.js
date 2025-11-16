import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpPost, httpPatch, httpDelete } from "../../utils/http-util.js";

// =====================
// Vercel环境变量处理类
// =====================

export class VercelHandler extends BaseHandler {
  API_URL = 'https://api.vercel.com';

  async _getAllEnvs(projectId, token) {
    const url = `${(this.API_URL)}/v10/projects/${projectId}/env`;
    const options = {
      headers: { Authorization: `Bearer ${token}` },
    };
    const res = await httpGet(url, options);
    const allEnv = res.data.envs;
    return allEnv;
  }

  async _getEevId(key) {
    try {
      const allEnv = await this._getAllEnvs(globals.deployPlatformProject, globals.deployPlatformToken);

      // 查找第一个 key 字段匹配的元素
      const envItem = allEnv.find(env => env.key === key);

      // 如果找到了，返回 id
      if (envItem) {
        return envItem;
      } else {
        // 如果没有找到匹配的元素，返回一个合适的值（比如 null）
        return null;
      }
    } catch (error) {
      log("error", '[server] ✗ Failed to _getEevId:', error.message);
    }
  }

  async setEnv(key, value) {
    // 首先获取云端环境变量
    const envItem = await this._getEevId(key);
    if (!envItem) {
      log("error", '[server] Error setEnv: 没有找到对应的环境变量！');
      return;
    }

    try {
      // 更新云端环境变量
      const url = `${this.API_URL}/v9/projects/${globals.deployPlatformProject}/env/${envItem.id}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = {
        key: key,
        value: value.toString(),
        target: envItem.target,
        type: envItem.type,
      };
      await httpPatch(url, JSON.stringify(data), options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  async addEnv(key, value) {
    try {
      // 更新云端环境变量
      const url = `${this.API_URL}/v10/projects/${globals.deployPlatformProject}/env`;
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
      };
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
      const url = `${this.API_URL}/v9/projects/${globals.deployPlatformProject}/env/${envItem.id}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      await httpDelete(url, options);

      return this.delLocalEnv(key);
    } catch (error) {
      log("error", '[server] ✗ Failed to add environment variable:', error.message);
    }
  }

  async checkParams(accountId, projectId, token) {
    try {
      await this._getAllEnvs(projectId, token);
      return true;
    } catch (error) {
      log("error", 'checkParams failed! projectId or token is not valid:', error.message);
      return false;
    }
  }
}