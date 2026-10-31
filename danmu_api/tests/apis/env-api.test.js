// 环境变量接口：弹弹play 与 AI 连通性验证
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { handleAiVerify, handleDandanplayVerify } from '../../apis/env-api.js';
import { Globals } from '../../configs/globals.js';
import AIClient from '../../utils/ai-util.js';
import { mockJsonResponse, parseResponse, token, withMockFetch } from '../helpers/context.js';

test('弹弹play连通性验证使用请求体中的账号与密码', async () => {
      const loginRequests = [];
      const originalAccount = Globals.envs.dandanplayAccount;
      const originalPassword = Globals.envs.dandanplayPassword;

      try {
        // 运行期配置与请求体不同，用于验证请求体优先
        Globals.envs.dandanplayAccount = 'runtime@example.com';
        Globals.envs.dandanplayPassword = 'runtime-password';

        await withMockFetch(async (url, options) => {
          loginRequests.push({ url: String(url), body: JSON.parse(options.body) });
          return mockJsonResponse({
            success: true,
            token: 'mock-token',
            tokenExpireTime: '2099-01-01T00:00:00Z',
            screenName: '请求体账号'
          });
        }, async () => {
          const response = await handleDandanplayVerify({
            json: async () => ({ dandanplayAccount: 'body@example.com', dandanplayPassword: 'body-password' })
          });
          const body = await parseResponse(response);

          assert.equal(body.ok, true);
          assert.match(body.message, /请求体账号/);
          assert.equal(loginRequests.length, 1);
          assert.match(loginRequests[0].url, /\/api\/v2\/login$/);
          assert.equal(loginRequests[0].body.userName, 'body@example.com');
          assert.equal(loginRequests[0].body.password, 'body-password');
        });
      } finally {
        Globals.envs.dandanplayAccount = originalAccount;
        Globals.envs.dandanplayPassword = originalPassword;
      }
    });
test('AI 连通性验证使用请求体中的密钥与地址模型', async () => {
      const originalVerify = AIClient.prototype.verify;
      const originalApiKey = Globals.envs.aiApiKey;
      const originalBaseUrl = Globals.envs.aiBaseUrl;
      const originalModel = Globals.envs.aiModel;
      let captured = null;

      AIClient.prototype.verify = async function () {
        captured = { apiKey: this.apiKey, baseURL: this.baseURL, model: this.model };
        return { ok: true };
      };

      try {
        // 运行期配置与请求体不同，用于验证请求体优先
        Globals.envs.aiApiKey = 'runtime-key';
        Globals.envs.aiBaseUrl = 'https://runtime.example/v1';
        Globals.envs.aiModel = 'runtime-model';

        const response = await handleAiVerify({
          json: async () => ({ aiApiKey: 'body-key', aiBaseUrl: 'https://body.example/v1', aiModel: 'body-model' })
        });
        const body = await parseResponse(response);

        assert.equal(body.ok, true);
        assert.equal(captured.apiKey, 'body-key');
        assert.equal(captured.baseURL, 'https://body.example/v1');
        assert.equal(captured.model, 'body-model');
      } finally {
        AIClient.prototype.verify = originalVerify;
        Globals.envs.aiApiKey = originalApiKey;
        Globals.envs.aiBaseUrl = originalBaseUrl;
        Globals.envs.aiModel = originalModel;
      }
    });
