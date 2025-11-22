import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpPatch } from "../../utils/http-util.js";

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

  /**
   * 设置/删除环境变量
   * @param {Array} envs   环境变量数组（每个元素 {name, text, type}）
   * @param {string} key    变量名
   * @param {string|null|undefined} value
   *        - 字符串：新增或修改为该值
   * @returns {Array} 返回处理后的 envs（直接修改原数组并返回）
   */
  _setEnv(envs, key, value) {
    // 查找已有项的索引
    const idx = envs.findIndex(item => item.name === key);

    if (value === null || value === undefined) {
      // 删除：value 为 null/undefined 时删除该变量
      if (idx !== -1) {
        envs.splice(idx, 1);
      }
    } else if (idx !== -1) {
      // 已存在 → 修改
      envs[idx].text = value;
    } else {
      // 不存在 → 新增
      envs.push({
        name: key,
        text: value,
        type: "plain_text"
      });
    }

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
        bindings: this._setEnv(envs, key, value == null ? null : value.toString())
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
    // addEnv 和 setEnv 在这个场景下逻辑相同，只是不存在该key
    return await this.setEnv(key, value);
  }

  async delEnv(key) {
    // addEnv 和 setEnv 在这个场景下逻辑相同，只是value设置为null
    await this.setEnv(key, null);
    return this.delLocalEnv(key);
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

  async deploy() {
    log("log", 'After modifying the environment variables on the cloudflare platform, it will be automatically deployed.');
    return true;
  }
}