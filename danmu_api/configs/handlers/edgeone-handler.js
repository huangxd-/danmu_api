import BaseHandler from "./base-handler.js";
import { globals } from '../globals.js';
import { log } from "../../utils/log-util.js";
import { httpPost } from "../../utils/http-util.js";

// =====================
// Edgeone环境变量处理类
// =====================

export class EdgeoneHandler extends BaseHandler {
  API_URL = 'https://pages-api.cloud.tencent.com/v1';

  async _httpPost(token, data) {
    const url = `${this.API_URL}`;
    const options = {
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    };
    return await httpPost(url, JSON.stringify(data), options);
  }

  async _getAllEnvs(projectId, token) {
    const data = {
      Action: "ModifyPagesProjectEnvs",
      ProjectId: projectId
    };
    const res = await this._httpPost(token, data);

    if (res?.data?.Code !== 0) return null;

    const list = res?.data.Data?.Response?.EnvVars ?? [];

    return Object.fromEntries(list.map(({Key, Value}) => [Key, Value]));
  }

  async setEnv(key, value) {
    try {
      // 更新云端环境变量
      const data = {
        Action: "ModifyPagesProjectEnvs",
        ProjectId: globals.deployPlatformProject,
        EnvVars: [
          {
            Key: key,
            Value: value.toString()
          }
        ]
      };

      await this._httpPost(globals.deployPlatformToken, data);

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
      // 删除云端环境变量
      const data = {
        Action: "DeletePagesProjectEnvs",
        ProjectId: globals.deployPlatformProject,
        EnvVars: [key]
      };

      await this._httpPost(globals.deployPlatformToken, data);

      return this.delLocalEnv(key);
    } catch (error) {
      log("error", '[server] ✗ Failed to del environment variable:', error.message);
    }
  }

  async checkParams(accountId, projectId, token) {
    try {
      await this._getAllEnvs(projectId, token);
      return true;
    } catch (error) {
      log("error", 'checkParams failed! accountId, projectId or token is not valid:', error.message);
      return false;
    }
  }

  async deploy() {
    try {
      // 触发云端部署
      const data = {
        Action: "CreatePagesDeployment",
        ProjectId: globals.deployPlatformProject,
        RepoBranch: "main",
        ViaMeta: "Github",
        Provider: "Github"
      };

      const res = await this._httpPost(globals.deployPlatformToken, data);
      if (res?.data?.Code !== 0) {
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