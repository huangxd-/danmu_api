import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpPost, httpDelete, httpPut } from "../../utils/http-util.js";

// =====================
// Netlify环境变量处理类
// =====================

export class NetlifyHandler extends BaseHandler {
  API_URL = 'https://api.netlify.com';

  async _getAllEnvs(accountId, projectId, token) {
    const url = `${this.API_URL}/api/v1/accounts/${accountId}/env?site_id=${projectId}`;
    const options = {
      headers: { Authorization: `Bearer ${token}` },
    };
    return await httpGet(url, options);
  }

  async setEnv(key, value) {
    try {
      // 更新云端环境变量
      const url = `${this.API_URL}/api/v1/accounts/${globals.deployPlatformAccount}/env/${key}?site_id=${globals.deployPlatformProject}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = {
        key: key,
        values: [
          { context: 'all', value: value.toString() },
        ]
      };
      await httpPut(url, JSON.stringify(data), options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  async addEnv(key, value) {
    try {
      // 更新云端环境变量
      const url = `${this.API_URL}/api/v1/accounts/${globals.deployPlatformAccount}/env?site_id=${globals.deployPlatformProject}`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = [{
        key: key,
        values: [
          { context: 'all', value: value },
        ],
      }];
      await httpPost(url, JSON.stringify(data), options);

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to add environment variable:', error.message);
    }
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

  async deploy() {
    try {
      // 触发云端部署
      const url = `${this.API_URL}/api/v1/sites/${globals.deployPlatformProject}/builds`;
      const options = {
        headers: { Authorization: `Bearer ${globals.deployPlatformToken}`, 'Content-Type': 'application/json' },
      };
      const data = {};

      const res = await httpPost(url, JSON.stringify(data), options);

      if (!res?.data?.id) {
        log("error", '[server] ✗ Failed to deploy:', JSON.stringify(res?.data));
        return false;
      }
      return true;
    } catch (error) {
      log("error", '[server] ✗ Failed to deploy:', error.message);
      return false;
    }
  }
}