import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpGet, httpPost, httpDelete } from "../../utils/http-util.js";

// =====================
// Hugging Face Spaces环境变量处理类
// =====================

export class HuggingfaceHandler extends BaseHandler {
  API_URL = 'https://huggingface.co';

  get repoId() {
    return `${globals.deployPlatformAccount}/${globals.deployPlatformProject}`;
  }

  _getOptions(token = globals.deployPlatformToken) {
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
  }

  _getVariablesUrl(repoId) {
    return `${this.API_URL}/api/spaces/${repoId}/variables`;
  }

  async _getAllEnvs(accountId, projectId, token) {
    const repoId = `${accountId}/${projectId}`;
    const url = this._getVariablesUrl(repoId);
    const res = await httpGet(url, this._getOptions(token));
    return res?.data;
  }

  async setEnv(key, value) {
    try {
      const url = this._getVariablesUrl(this.repoId);
      const data = {
        key: key,
        value: value.toString()
      };
      await httpPost(url, JSON.stringify(data), this._getOptions());

      return this.updateLocalEnv(key, value);
    } catch (error) {
      log("error", '[server] ✗ Failed to set environment variable:', error.message);
    }
  }

  async addEnv(key, value) {
    return await this.setEnv(key, value);
  }

  async delEnv(key) {
    try {
      const url = this._getVariablesUrl(this.repoId);
      await httpDelete(url, {
        ...this._getOptions(),
        body: JSON.stringify({ key: key })
      });

      return this.delLocalEnv(key);
    } catch (error) {
      log("error", '[server] ✗ Failed to del environment variable:', error.message);
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
      const url = `${this.API_URL}/api/spaces/${this.repoId}/restart`;
      await httpPost(url, undefined, this._getOptions());
      return true;
    } catch (error) {
      log("error", '[server] ✗ Failed to deploy:', error.message);
      return false;
    }
  }
}
