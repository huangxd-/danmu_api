// 部署平台 handler：Hugging Face Space 变量与重启
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import { HandlerFactory } from '../../configs/handlers/handler-factory.js';
import { HuggingfaceHandler } from '../../configs/handlers/huggingface-handler.js';
import { VercelHandler } from '../../configs/handlers/vercel-handler.js';
import { NetlifyHandler } from '../../configs/handlers/netlify-handler.js';
import { CloudflareHandler } from '../../configs/handlers/cloudflare-handler.js';
import { EdgeoneHandler } from '../../configs/handlers/edgeone-handler.js';
import { mockJsonResponse, token, withMockFetch } from '../helpers/context.js';

test('HandlerFactory should support Hugging Face Spaces', async () => {
    const handler = await HandlerFactory.getHandler('huggingface');

    assert(handler instanceof HuggingfaceHandler);
    assert(HandlerFactory.getSupportedPlatforms().includes('huggingface'));
  });
test('HuggingfaceHandler should call Space variables and restart APIs', async () => {
    const env = {
      DEPLOY_PLATFROM_ACCOUNT: 'hf-user',
      DEPLOY_PLATFROM_PROJECT: 'hf-space',
      DEPLOY_PLATFROM_TOKEN: 'hf-token'
    };
    Globals.init(env);
    const globals = Globals.getConfig();
    const handler = new HuggingfaceHandler();

    await withMockFetch(async (url, options) => {
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/variables' && options.method === 'POST') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        assert.deepEqual(JSON.parse(options.body), { key: 'DANMU_LIMIT', value: '1' });
        return mockJsonResponse({}, url);
      }
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/variables' && options.method === 'DELETE') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        assert.deepEqual(JSON.parse(options.body), { key: 'DANMU_LIMIT' });
        return mockJsonResponse({}, url);
      }
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/restart' && options.method === 'POST') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        return mockJsonResponse({}, url);
      }
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    }, async () => {
      assert.equal(await handler.setEnv('DANMU_LIMIT', 1), true);
      assert.equal(globals.env.DANMU_LIMIT, 1);
      assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
      assert.equal(await handler.deploy(), true);
    });
  });

// =====================
// 云平台部署 handler：Vercel / Netlify / Cloudflare / Edgeone
// 全部离线：统一用 withMockFetch 替换全局 fetch，断言请求 URL / method / 鉴权头 / body 与解析分支，
// 不发起任何真实网络请求，也不读写 config/.env。
// =====================

// 云平台部署参数：每个用例开始都重新 init 一次，避免用例之间相互影响
function deployEnv(extra = {}) {
  return {
    DEPLOY_PLATFROM_ACCOUNT: 'acc',
    DEPLOY_PLATFROM_PROJECT: 'proj',
    DEPLOY_PLATFROM_TOKEN: 'tok',
    LOG_LEVEL: 'error',
    ...extra
  };
}

// 非 2xx 响应：http-util 会据此抛错，用于覆盖 checkParams / deploy 的失败分支
function mockErrorResponse(status, data = {}) {
  return {
    ok: false,
    status,
    url: 'mock',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(data)
  };
}

// ---------- Vercel ----------

test('VercelHandler should read env list from res.data.envs and expose typed getEnv', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();
  const calls = [];
  const cloudEnvs = [
    { id: 'env_1', key: 'DANMU_LIMIT', value: '1', target: ['production'], type: 'encrypted' },
    { id: 'env_2', key: 'TOKEN', value: 'abc', target: ['production'], type: 'plain' }
  ];

  await withMockFetch(async (url, options) => {
    calls.push({ url, method: options.method });
    assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse({ envs: cloudEnvs }, url);
  }, async () => {
    assert.deepEqual(await handler._getAllEnvs('proj', 'tok'), cloudEnvs);
    // 命中既有项 → 返回该项本身（id 供后续 PATCH / DELETE 使用）
    assert.deepEqual(await handler._getEevId('DANMU_LIMIT'), cloudEnvs[0]);
    // 未命中 → null
    assert.equal(await handler._getEevId('NOT_EXIST'), null);
  });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'GET']);

  const projectVar = handler.getEnv('DEPLOY_PLATFROM_PROJECT');
  assert.equal(projectVar.value, 'proj');
  assert.equal(projectVar.category, 'system');
  assert.equal(projectVar.type, 'text');
  assert.equal(projectVar.description, '部署平台项目名称');
});

test('VercelHandler setEnv should PATCH the matched env id with its target/type and update local env', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
      assert.equal(options.headers.Authorization, 'Bearer tok');
      return mockJsonResponse({
        envs: [{ id: 'env_1', key: 'DANMU_LIMIT', target: ['production'], type: 'encrypted' }]
      }, url);
    }
    assert.equal(options.method, 'PATCH');
    assert.equal(url, 'https://api.vercel.com/v9/projects/proj/env/env_1');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      key: 'DANMU_LIMIT',
      value: '5',
      target: ['production'],
      type: 'encrypted'
    });
    return mockJsonResponse({}, url);
  }, async () => {
    assert.equal(await handler.setEnv('DANMU_LIMIT', 5), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 5);
  });
  assert.deepEqual(calls, ['GET', 'PATCH']);
});

test('VercelHandler setEnv/delEnv should skip mutation requests when the key is absent', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
    assert.equal(options.method, 'GET');
    return mockJsonResponse({ envs: [{ id: 'env_9', key: 'OTHER_KEY', target: ['production'], type: 'plain' }] }, url);
  }, async () => {
    // 未命中：只做了枚举，没有 PATCH / DELETE，返回 undefined
    assert.equal(await handler.setEnv('DANMU_LIMIT', 5), undefined);
    assert.equal(await handler.delEnv('DANMU_LIMIT'), undefined);
  });
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('VercelHandler addEnv should POST a new encrypted env targeting all environments', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      key: 'DANMU_LIMIT',
      value: '5',
      target: ['production', 'preview', 'development'],
      type: 'encrypted'
    });
    return mockJsonResponse({ created: { id: 'env_new' } }, url);
  }, async () => {
    assert.equal(await handler.addEnv('DANMU_LIMIT', 5), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 5);
  });
  assert.deepEqual(calls, ['POST']);
});

test('VercelHandler delEnv should DELETE the matched env id and drop the local value', async () => {
  Globals.init(deployEnv({ DANMU_LIMIT: 3 }));
  const handler = new VercelHandler();
  assert.equal(Globals.getConfig().envs.danmuLimit, 3);

  await withMockFetch(async (url, options) => {
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
      return mockJsonResponse({
        envs: [{ id: 'env_1', key: 'DANMU_LIMIT', target: ['production'], type: 'encrypted' }]
      }, url);
    }
    assert.equal(options.method, 'DELETE');
    assert.equal(url, 'https://api.vercel.com/v9/projects/proj/env/env_1');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.body, undefined);
    return mockJsonResponse({}, url);
  }, async () => {
    assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 0);
  });
});

test('VercelHandler checkParams should return true for valid params and false when the API rejects them', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.vercel.com/v10/projects/proj/env');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse({ envs: [] }, url);
  }, async () => {
    assert.equal(await handler.checkParams('acc', 'proj', 'tok'), true);
  });

  await withMockFetch(async (url, options) => {
    // 空值原样拼进 URL 与鉴权头（本地不做校验），失败由服务端状态码决定
    assert.equal(url, 'https://api.vercel.com/v10/projects//env');
    assert.equal(options.headers.Authorization, 'Bearer ');
    return mockErrorResponse(403, { error: 'forbidden' });
  }, async () => {
    assert.equal(await handler.checkParams('', '', ''), false);
  });
});

test('VercelHandler deploy should reuse the latest deployment id and return false on invalid responses', async () => {
  Globals.init(deployEnv());
  const handler = new VercelHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.vercel.com/v6/deployments?projectId=proj&limit=1');
      assert.equal(options.headers.Authorization, 'Bearer tok');
      return mockJsonResponse({ deployments: [{ uid: 'dpl_123' }] }, url);
    }
    assert.equal(url, 'https://api.vercel.com/v13/deployments');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      name: 'proj',
      deploymentId: 'dpl_123',
      target: 'production'
    });
    return mockJsonResponse({ id: 'dpl_new' }, url);
  }, async () => {
    assert.equal(await handler.deploy(), true);
  });
  assert.deepEqual(calls, ['GET', 'POST']);

  // 没有历史部署 → 失败，且不再发起部署请求
  const noHistoryCalls = [];
  await withMockFetch(async (url, options) => {
    noHistoryCalls.push(options.method);
    return mockJsonResponse({ deployments: [] }, url);
  }, async () => {
    assert.equal(await handler.deploy(), false);
  });
  assert.deepEqual(noHistoryCalls, ['GET']);

  // 部署响应缺少 id → 失败
  await withMockFetch(async (url, options) => {
    if (options.method === 'GET') return mockJsonResponse({ deployments: [{ uid: 'dpl_123' }] }, url);
    return mockJsonResponse({ error: { code: 'forbidden' } }, url);
  }, async () => {
    assert.equal(await handler.deploy(), false);
  });
});

// ---------- Netlify ----------

test('NetlifyHandler should GET the account env list and expose typed getEnv', async () => {
  Globals.init(deployEnv());
  const handler = new NetlifyHandler();
  const cloudEnvs = [{ key: 'DANMU_LIMIT', values: [{ context: 'all', value: '1' }] }];

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts/acc/env?site_id=proj');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse(cloudEnvs, url);
  }, async () => {
    const res = await handler._getAllEnvs('acc', 'proj', 'tok');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, cloudEnvs);
  });

  const accountVar = handler.getEnv('DEPLOY_PLATFROM_ACCOUNT');
  assert.equal(accountVar.value, 'acc');
  assert.equal(accountVar.category, 'system');
  assert.equal(accountVar.type, 'text');
  assert.equal(accountVar.description, '部署平台账号ID');
});

test('NetlifyHandler setEnv should PUT the value as an all-context string', async () => {
  Globals.init(deployEnv());
  const handler = new NetlifyHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(options.method, 'PUT');
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts/acc/env/DANMU_LIMIT?site_id=proj');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      key: 'DANMU_LIMIT',
      values: [{ context: 'all', value: '5' }]
    });
    return mockJsonResponse({}, url);
  }, async () => {
    assert.equal(await handler.setEnv('DANMU_LIMIT', 5), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 5);
  });
});

test('NetlifyHandler addEnv should POST an array payload keeping the raw value', async () => {
  Globals.init(deployEnv());
  const handler = new NetlifyHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts/acc/env?site_id=proj');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    // 与 setEnv 的区别：addEnv 是数组结构且不做 toString
    assert.deepEqual(JSON.parse(options.body), [{
      key: 'DANMU_LIMIT',
      values: [{ context: 'all', value: 5 }]
    }]);
    return mockJsonResponse([{ key: 'DANMU_LIMIT' }], url);
  }, async () => {
    assert.equal(await handler.addEnv('DANMU_LIMIT', 5), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 5);
  });
});

test('NetlifyHandler delEnv should DELETE the key scoped to the site and drop the local value', async () => {
  Globals.init(deployEnv({ DANMU_LIMIT: 3 }));
  const handler = new NetlifyHandler();
  assert.equal(Globals.getConfig().envs.danmuLimit, 3);

  await withMockFetch(async (url, options) => {
    assert.equal(options.method, 'DELETE');
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts/acc/env/DANMU_LIMIT?site_id=proj');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.body, undefined);
    return mockJsonResponse({}, url);
  }, async () => {
    assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 0);
  });
});

test('NetlifyHandler checkParams should return true for valid params and false when the API rejects them', async () => {
  Globals.init(deployEnv());
  const handler = new NetlifyHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts/acc/env?site_id=proj');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse([], url);
  }, async () => {
    assert.equal(await handler.checkParams('acc', 'proj', 'tok'), true);
  });

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.netlify.com/api/v1/accounts//env?site_id=');
    assert.equal(options.headers.Authorization, 'Bearer ');
    return mockErrorResponse(401, { message: 'unauthorized' });
  }, async () => {
    assert.equal(await handler.checkParams('', '', ''), false);
  });
});

test('NetlifyHandler deploy should POST a build request and return false when no build id comes back', async () => {
  Globals.init(deployEnv());
  const handler = new NetlifyHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.netlify.com/api/v1/sites/proj/builds');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {});
    return mockJsonResponse({ id: 'build_1' }, url);
  }, async () => {
    assert.equal(await handler.deploy(), true);
  });

  await withMockFetch(async (url) => mockJsonResponse({ error: 'nope' }, url), async () => {
    assert.equal(await handler.deploy(), false);
  });

  await withMockFetch(async () => mockErrorResponse(500, { message: 'boom' }), async () => {
    assert.equal(await handler.deploy(), false);
  });
});

// ---------- Cloudflare ----------

test('CloudflareHandler should parse result.bindings and expose typed getEnv', async () => {
  Globals.init(deployEnv());
  const handler = new CloudflareHandler();
  const bindings = [
    { name: 'DANMU_LIMIT', text: '1', type: 'plain_text' },
    { name: 'TOKEN', text: 'abc', type: 'plain_text' }
  ];

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/proj/settings');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse({ result: { bindings }, success: true }, url);
  }, async () => {
    assert.deepEqual(await handler._getAllEnvs('acc', 'proj', 'tok'), bindings);
  });

  // 响应缺少 result.bindings → null（而非抛错）
  await withMockFetch(async (url) => mockJsonResponse({ success: false, errors: [{ code: 10000 }] }, url), async () => {
    assert.equal(await handler._getAllEnvs('acc', 'proj', 'tok'), null);
  });

  const tokenVar = handler.getEnv('DEPLOY_PLATFROM_TOKEN');
  assert.equal(tokenVar.value, 'tok');
  assert.equal(tokenVar.category, 'system');
  assert.equal(tokenVar.type, 'text');
  assert.equal(tokenVar.description, '部署平台访问令牌');
});

test('CloudflareHandler _setEnv should update, delete and append bindings', () => {
  Globals.init(deployEnv());
  const handler = new CloudflareHandler();
  // _setEnv 就地修改入参数组，每个分支用一份全新数据
  const bindings = () => [
    { name: 'DANMU_LIMIT', text: '0', type: 'plain_text' },
    { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
  ];

  // 命中既有项 → 原地改 text
  assert.deepEqual(handler._setEnv(bindings(), 'DANMU_LIMIT', '9'), [
    { name: 'DANMU_LIMIT', text: '9', type: 'plain_text' },
    { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
  ]);
  // value 为 null → 删除该项
  assert.deepEqual(handler._setEnv(bindings(), 'DANMU_LIMIT', null), [
    { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
  ]);
  // 未命中且 value 非空 → 追加 plain_text 绑定
  assert.deepEqual(handler._setEnv(bindings(), 'NEW_KEY', 'v'), [
    { name: 'DANMU_LIMIT', text: '0', type: 'plain_text' },
    { name: 'KEEP_ME', text: 'x', type: 'plain_text' },
    { name: 'NEW_KEY', text: 'v', type: 'plain_text' }
  ]);
  // 删除不存在的 key → 数组不变
  assert.deepEqual(handler._setEnv(bindings(), 'MISSING', null), bindings());
  // 返回的就是被就地修改的同一个数组引用
  const original = bindings();
  assert.equal(handler._setEnv(original, 'DANMU_LIMIT', '7'), original);
  assert.deepEqual(original, [
    { name: 'DANMU_LIMIT', text: '7', type: 'plain_text' },
    { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
  ]);
});

test('CloudflareHandler setEnv should PATCH settings.json multipart when the key already exists', async () => {
  Globals.init(deployEnv());
  const handler = new CloudflareHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    if (options.method === 'GET') {
      assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/proj/settings');
      assert.equal(options.headers.Authorization, 'Bearer tok');
      return mockJsonResponse({
        result: {
          bindings: [
            { name: 'DANMU_LIMIT', text: '0', type: 'plain_text' },
            { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
          ]
        }
      }, url);
    }
    assert.equal(options.method, 'PATCH');
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/proj/settings');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    // FormData 自带 multipart 边界，handler 不设置 Content-Type
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body instanceof FormData, true);
    const part = options.body.get('settings');
    assert.equal(part.name, 'settings.json');
    assert.equal(part.type, 'application/json');
    assert.deepEqual(JSON.parse(await part.text()), {
      bindings: [
        { name: 'DANMU_LIMIT', text: '1', type: 'plain_text' },
        { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
      ]
    });
    return mockJsonResponse({ success: true }, url);
  }, async () => {
    assert.equal(await handler.setEnv('DANMU_LIMIT', 1), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 1);
  });
  assert.deepEqual(calls, ['GET', 'PATCH']);
});

test('CloudflareHandler addEnv should PATCH a freshly appended binding', async () => {
  Globals.init(deployEnv());
  const handler = new CloudflareHandler();

  await withMockFetch(async (url, options) => {
    if (options.method === 'GET') {
      return mockJsonResponse({ result: { bindings: [{ name: 'KEEP_ME', text: 'x', type: 'plain_text' }] } }, url);
    }
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(await options.body.get('settings').text()), {
      bindings: [
        { name: 'KEEP_ME', text: 'x', type: 'plain_text' },
        { name: 'DANMU_LIMIT', text: '2', type: 'plain_text' }
      ]
    });
    return mockJsonResponse({ success: true }, url);
  }, async () => {
    assert.equal(await handler.addEnv('DANMU_LIMIT', 2), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 2);
  });
});

test('CloudflareHandler setEnv should not PATCH when the settings response has no bindings', async () => {
  Globals.init(deployEnv({ DANMU_LIMIT: 3 }));
  const handler = new CloudflareHandler();
  const calls = [];

  await withMockFetch(async (url, options) => {
    calls.push(options.method);
    return mockJsonResponse({ success: true, result: {} }, url);
  }, async () => {
    // envs 为 null → 直接返回 undefined，不构造 PATCH
    assert.equal(await handler.setEnv('DANMU_LIMIT', 1), undefined);
    // delEnv 复用 setEnv，同样不会发出 PATCH；本地删除仍然生效
    await handler.delEnv('DANMU_LIMIT');
  });
  assert.deepEqual(calls, ['GET', 'GET']);
  assert.equal(Globals.getConfig().envs.danmuLimit, 0);
});

test('CloudflareHandler delEnv should PATCH without the removed binding and drop the local value', async () => {
  Globals.init(deployEnv({ DANMU_LIMIT: 3 }));
  const handler = new CloudflareHandler();
  assert.equal(Globals.getConfig().envs.danmuLimit, 3);

  await withMockFetch(async (url, options) => {
    if (options.method === 'GET') {
      return mockJsonResponse({
        result: {
          bindings: [
            { name: 'DANMU_LIMIT', text: '3', type: 'plain_text' },
            { name: 'KEEP_ME', text: 'x', type: 'plain_text' }
          ]
        }
      }, url);
    }
    assert.equal(options.method, 'PATCH');
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/proj/settings');
    assert.deepEqual(JSON.parse(await options.body.get('settings').text()), {
      bindings: [{ name: 'KEEP_ME', text: 'x', type: 'plain_text' }]
    });
    return mockJsonResponse({ success: true }, url);
  }, async () => {
    assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 0);
  });
});

test('CloudflareHandler checkParams should validate via the settings endpoint and deploy should be a no-op', async () => {
  Globals.init(deployEnv());
  const handler = new CloudflareHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/proj/settings');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return mockJsonResponse({ result: { bindings: [] } }, url);
  }, async () => {
    assert.equal(await handler.checkParams('acc', 'proj', 'tok'), true);
  });

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts//workers/scripts//settings');
    assert.equal(options.headers.Authorization, 'Bearer ');
    return mockErrorResponse(401, { success: false });
  }, async () => {
    assert.equal(await handler.checkParams('', '', ''), false);
  });

  // 修改环境变量后平台自动部署，deploy 只记录日志
  let fetched = false;
  await withMockFetch(async () => {
    fetched = true;
    throw new Error('CloudflareHandler.deploy 不应发起请求');
  }, async () => {
    assert.equal(await handler.deploy(), true);
  });
  assert.equal(fetched, false);
});

// ---------- Edgeone ----------

test('EdgeoneHandler should POST ModifyPagesProjectEnvs and map EnvVars into an object', async () => {
  Globals.init(deployEnv());
  const handler = new EdgeoneHandler();
  const bodies = [];

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    bodies.push(JSON.parse(options.body));
    return mockJsonResponse({
      Code: 0,
      Data: {
        Response: {
          EnvVars: [
            { Key: 'DANMU_LIMIT', Value: '1' },
            { Key: 'TOKEN', Value: 'abc' }
          ]
        }
      }
    }, url);
  }, async () => {
    assert.deepEqual(await handler._getAllEnvs('proj', 'tok'), { DANMU_LIMIT: '1', TOKEN: 'abc' });
  });
  assert.deepEqual(bodies, [{ Action: 'ModifyPagesProjectEnvs', ProjectId: 'proj' }]);

  // Code !== 0 → null（平台级错误不以 HTTP 状态码表达）
  await withMockFetch(async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer bad-token');
    return mockJsonResponse({ Code: 1, Message: 'invalid token' }, url);
  }, async () => {
    assert.equal(await handler._getAllEnvs('proj', 'bad-token'), null);
  });

  // 响应缺少 Data.Response → 空对象
  await withMockFetch(async (url) => mockJsonResponse({ Code: 0 }, url), async () => {
    assert.deepEqual(await handler._getAllEnvs('proj', 'tok'), {});
  });

  const projectVar = handler.getEnv('DEPLOY_PLATFROM_PROJECT');
  assert.equal(projectVar.value, 'proj');
  assert.equal(projectVar.category, 'system');
  assert.equal(projectVar.type, 'text');
  assert.equal(projectVar.description, '部署平台项目名称');
});

test('EdgeoneHandler setEnv should POST ModifyPagesProjectEnvs with the stringified value', async () => {
  Globals.init(deployEnv());
  const handler = new EdgeoneHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      Action: 'ModifyPagesProjectEnvs',
      ProjectId: 'proj',
      EnvVars: [{ Key: 'DANMU_LIMIT', Value: '5' }]
    });
    return mockJsonResponse({ Code: 0 }, url);
  }, async () => {
    assert.equal(await handler.setEnv('DANMU_LIMIT', 5), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 5);
  });
});

test('EdgeoneHandler addEnv should send the same ModifyPagesProjectEnvs payload as setEnv', async () => {
  Globals.init(deployEnv());
  const handler = new EdgeoneHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {
      Action: 'ModifyPagesProjectEnvs',
      ProjectId: 'proj',
      EnvVars: [{ Key: 'DANMU_LIMIT', Value: '6' }]
    });
    return mockJsonResponse({ Code: 0 }, url);
  }, async () => {
    assert.equal(await handler.addEnv('DANMU_LIMIT', 6), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 6);
  });
});

test('EdgeoneHandler delEnv should POST DeletePagesProjectEnvs with the key list', async () => {
  Globals.init(deployEnv({ DANMU_LIMIT: 3 }));
  const handler = new EdgeoneHandler();
  assert.equal(Globals.getConfig().envs.danmuLimit, 3);

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(options.body), {
      Action: 'DeletePagesProjectEnvs',
      ProjectId: 'proj',
      EnvVars: ['DANMU_LIMIT']
    });
    return mockJsonResponse({ Code: 0 }, url);
  }, async () => {
    assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
    assert.equal(Globals.getConfig().envs.danmuLimit, 0);
  });
});

test('EdgeoneHandler checkParams should return true for valid params and false when the request fails', async () => {
  Globals.init(deployEnv());
  const handler = new EdgeoneHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(options.body), { Action: 'ModifyPagesProjectEnvs', ProjectId: 'proj' });
    return mockJsonResponse({ Code: 0, Data: { Response: { EnvVars: [] } } }, url);
  }, async () => {
    assert.equal(await handler.checkParams('acc', 'proj', 'tok'), true);
  });

  await withMockFetch(async (url, options) => {
    // 空值原样进入请求体与鉴权头（本地不做校验）
    assert.equal(options.headers.Authorization, 'Bearer ');
    assert.deepEqual(JSON.parse(options.body), { Action: 'ModifyPagesProjectEnvs', ProjectId: '' });
    return mockErrorResponse(401, { Code: 1, Message: 'unauthorized' });
  }, async () => {
    assert.equal(await handler.checkParams('', '', ''), false);
  });
});

test('EdgeoneHandler deploy should POST CreatePagesDeployment and return false on a non-zero Code', async () => {
  Globals.init(deployEnv());
  const handler = new EdgeoneHandler();

  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://pages-api.cloud.tencent.com/v1');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {
      Action: 'CreatePagesDeployment',
      ProjectId: 'proj',
      RepoBranch: 'main',
      ViaMeta: 'Github',
      Provider: 'Github'
    });
    return mockJsonResponse({ Code: 0, Data: { Response: { Id: 'deploy_1' } } }, url);
  }, async () => {
    assert.equal(await handler.deploy(), true);
  });

  // 平台返回非 0 Code → 失败
  await withMockFetch(async (url) => mockJsonResponse({ Code: 1, Message: 'build failed' }, url), async () => {
    assert.equal(await handler.deploy(), false);
  });

  // 传输层失败 → 失败
  await withMockFetch(async () => mockErrorResponse(500, { Code: 500 }), async () => {
    assert.equal(await handler.deploy(), false);
  });
});
