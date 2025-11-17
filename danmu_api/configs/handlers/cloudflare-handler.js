import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpDelete, httpPatch } from "../../utils/http-util.js";

// =====================
// Cloudflare环境变量处理类
// =====================

export class CloudflareHandler extends BaseHandler {
  API_URL = 'https://api.cloudflare.com';

  async _getAllEnvs(accountId, projectId, token) {
    const url = `${this.API_URL}/client/v4/accounts/${accountId}/workers/scripts/${projectId}/settings`;
    const options = {
      headers: { Authorization: `Bearer ${token}` },
    };
    const res = await httpGet(url, options);
    if (res && res?.data && res?.data?.result && res?.data?.result?.bindings) {
      return res?.data?.result?.bindings;
    } else {
      return null;
    }
  }

  _setEnv(envs, key, value) {
    // 遍历环境变量列表，查找是否存在 key
    for (let i = 0; i < envs.length; i++) {
      if (envs[i].name === key) {
        // 存在则修改 text 字段
        envs[i].text = value;
        return envs; // 返回修改后的列表
      }
    }

    // 不存在则新增一条
    envs.push({
      name: key,
      text: value,
      type: "plain_text"
    });

    return envs;
  }

  async setEnv(key, value) {
    try {
      // 获取所有环境变量
      const envs = await this._getAllEnvs(globals.deployPlatformAccount, globals.deployPlatformProject, globals.deployPlatformToken);
      if (envs === null) {
        log("error", '[server] ✗ Failed to set environment variable: envs is null');
        return;
      }

      // 更新云端环境变量
      const url = `${this.API_URL}/client/v4/accounts/${globals.deployPlatformAccount}/workers/scripts/${globals.deployPlatformProject}/settings`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}` },
      };
      const formData = new FormData();
      const settings = {
        bindings: this._setEnv(envs, key, value.toString())
      };
      formData.append(
        "settings",
        new Blob([JSON.stringify(settings)], { type: "application/json" }),
        "settings.json"
      );
      await httpPatch(url, formData, options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  async addEnv(key, value) {
    // addEnv 和 setEnv 在这个场景下逻辑相同
    return await this.setEnv(key, value);
  }

  async delEnv(key) {
    try {
      // 更新云端环境变量
      const url = `${this.API_URL}/api/v1/accounts/${globals.deployPlatformAccount}/env/${key}?site_id=${globals.deployPlatformProject}`;
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
      await this._getAllEnvs(accountId, projectId, token);
      return true;
    } catch (error) {
      log("error", 'checkParams failed! accountId, projectId or token is not valid:', error.message);
      return false;
    }
  }
}