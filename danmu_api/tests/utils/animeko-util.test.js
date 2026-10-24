// Animeko 镜像域名：发布页解析与镜像回退链路
// 覆盖内置域名优先、备用域名选取（权重排序、排除当前域名、数量上限）、结果缓存与并发请求复用及失败降级行为。

import test from 'node:test';
import assert from 'node:assert';
import {
  BUILTIN_MIRROR_API_BASE,
  MAX_MIRROR_FALLBACK_HOSTS,
  extractHost,
  isValidHostname,
  parseMirrorApiHosts,
  fetchMirrorFallbackHosts,
  getCurrentMirrorBase,
  requestMirror,
  resetMirrorState,
} from '../../utils/animeko-util.js';
import { MIRROR_PUBLISH_API, apiMirror, publishPayload } from '../helpers/animeko.js';
import { withMockFetch, mockJsonResponse } from '../helpers/context.js';

// 记录请求地址并按需返回失败/成功的 mock fetch
function createFetchMock(handler) {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return { calls, mockFetch };
}

function mirrorPublishHandler(payload, { publishStatus = 200 } = {}) {
  return (url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) {
      if (publishStatus !== 200) {
        return { ok: false, status: publishStatus, headers: new Headers(), text: async () => 'error' };
      }
      return mockJsonResponse(payload, url);
    }
    throw new Error(`未预期的请求地址: ${url}`);
  };
}

test.beforeEach(() => {
  resetMirrorState();
});

test('animeko extractHost 提取主机名并忽略大小写', () => {
  assert.strictEqual(extractHost('https://API.Bangumi.LAT/v0/episodes'), 'api.bangumi.lat');
  assert.strictEqual(extractHost('not-a-url'), '');
  assert.strictEqual(extractHost(''), '');
});

test('animeko isValidHostname 仅接受多层级域名', () => {
  assert.strictEqual(isValidHostname('api.bangumi.lat'), true);
  assert.strictEqual(isValidHostname('api.bangumi.lat:443'), false);
  assert.strictEqual(isValidHostname('https://api.bangumi.lat'), false);
  assert.strictEqual(isValidHostname('api.bangumi.lat/v0'), false);
  assert.strictEqual(isValidHostname('localhost'), false);
  assert.strictEqual(isValidHostname('192.168.1.1'), false);
  assert.strictEqual(isValidHostname('-api.bangumi.lat'), false);
  assert.strictEqual(isValidHostname('api..bangumi.lat'), false);
  assert.strictEqual(isValidHostname(''), false);
  const overlongHost = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}`;
  assert.strictEqual(isValidHostname(overlongHost), false);
});

test('animeko parseMirrorApiHosts 仅提取 api 服务域名并按权重降序排列', () => {
  const payload = publishPayload([
    apiMirror('low', 100, ['api.low.example']),
    apiMirror('high', 900, ['api.high.example'], true),
    {
      id: 'main-only',
      weight: 5000,
      services: [{ id: 'main', name: 'main', label: '主站', hosts: ['main.example'] }],
    },
  ]);

  const hosts = parseMirrorApiHosts(payload);
  assert.deepStrictEqual(hosts, ['api.high.example', 'api.low.example'], '仅保留 api 服务且权重降序');
});

test('animeko parseMirrorApiHosts 权重相同时推荐域名优先且同域名去重', () => {
  const payload = publishPayload([
    apiMirror('a', 500, ['api.same.example', 'api.other.example']),
    apiMirror('b', 500, ['api.same.example'], true),
  ]);

  const hosts = parseMirrorApiHosts(payload);
  assert.deepStrictEqual(hosts, ['api.same.example', 'api.other.example'], '同域名只保留一次');
});

test('animeko parseMirrorApiHosts 对异常结构返回空列表', () => {
  assert.deepStrictEqual(parseMirrorApiHosts(null), []);
  assert.deepStrictEqual(parseMirrorApiHosts({}), []);
  assert.deepStrictEqual(parseMirrorApiHosts({ mirrors: 'invalid' }), []);
  assert.deepStrictEqual(parseMirrorApiHosts({ mirrors: [{ weight: 10, services: [{ id: 'api', hosts: 'invalid' }] }] }), []);
  assert.deepStrictEqual(parseMirrorApiHosts({ mirrors: [{ services: [{ id: 'api', hosts: ['  ', null] }] }] }), []);
  assert.deepStrictEqual(parseMirrorApiHosts({ mirrors: [null] }), []);
  assert.deepStrictEqual(parseMirrorApiHosts({ mirrors: [{ services: [null] }] }), []);
});

test('animeko parseMirrorApiHosts 剔除非法主机名', () => {
  const payload = publishPayload([
    apiMirror('mixed', 900, ['api.valid.example', 'https://api.with-scheme.example', 'api.with-port.example:443', 'localhost']),
  ]);

  const hosts = parseMirrorApiHosts(payload);
  assert.deepStrictEqual(hosts, ['api.valid.example'], '仅保留合法主机名');
});

test('animeko fetchMirrorFallbackHosts 排除指定域名并限制候选数量', async () => {
  const payload = publishPayload([
    apiMirror('first', 900, ['api.first.example']),
    apiMirror('second', 800, ['api.second.example']),
    apiMirror('third', 700, ['api.third.example']),
    apiMirror('fourth', 600, ['api.fourth.example']),
  ]);

  const { calls, mockFetch } = createFetchMock(mirrorPublishHandler(payload));
  const hosts = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts(['api.first.example']));

  assert.deepStrictEqual(hosts, ['api.second.example', 'api.third.example'], '排除当前域名并取前两个');
  assert.strictEqual(hosts.length, MAX_MIRROR_FALLBACK_HOSTS, '候选数量不超过上限');
  assert.strictEqual(calls.length, 1, '发布页只请求一次');
});

test('animeko fetchMirrorFallbackHosts 排除域名时忽略大小写', async () => {
  const payload = publishPayload([
    apiMirror('first', 900, ['api.first.example']),
    apiMirror('second', 800, ['api.second.example']),
  ]);
  const { mockFetch } = createFetchMock(mirrorPublishHandler(payload));

  const hosts = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts(['API.FIRST.EXAMPLE']));

  assert.deepStrictEqual(hosts, ['api.second.example'], '排除匹配忽略大小写');
});

test('animeko fetchMirrorFallbackHosts 发布页请求失败时返回空列表', async () => {
  const { calls, mockFetch } = createFetchMock(mirrorPublishHandler(null, { publishStatus: 503 }));
  const hosts = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts([]));

  assert.deepStrictEqual(hosts, []);
  assert.strictEqual(calls.length, 1);
});

test('animeko fetchMirrorFallbackHosts 发布页结果在有效期内复用', async () => {
  const payload = publishPayload([apiMirror('backup', 800, ['api.backup.example'])]);
  const { calls, mockFetch } = createFetchMock(mirrorPublishHandler(payload));

  const first = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts());
  const second = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts());

  assert.deepStrictEqual(first, ['api.backup.example']);
  assert.deepStrictEqual(second, ['api.backup.example']);
  assert.strictEqual(calls.length, 1, '有效期内只请求一次发布页');
});

test('animeko fetchMirrorFallbackHosts 发布页无 api 域名时结果同样进入缓存', async () => {
  const payload = publishPayload([
    { id: 'main-only', name: 'main-only', weight: 500, services: [{ id: 'main', name: 'main', label: '主站', hosts: ['main.example'] }] },
  ]);
  const { calls, mockFetch } = createFetchMock(mirrorPublishHandler(payload));

  const first = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts([]));
  const second = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts([]));

  assert.deepStrictEqual(first, []);
  assert.deepStrictEqual(second, []);
  assert.strictEqual(calls.length, 1, '空结果同样只请求一次发布页');
});

test('animeko fetchMirrorFallbackHosts 并发未命中缓存时共享同一次发布页请求', async () => {
  const payload = publishPayload([apiMirror('backup', 800, ['api.backup.example'])]);
  const { calls, mockFetch } = createFetchMock(mirrorPublishHandler(payload));

  const [first, second] = await withMockFetch(mockFetch, async () => {
    const pending = fetchMirrorFallbackHosts([]);
    return Promise.all([pending, fetchMirrorFallbackHosts([])]);
  });

  assert.deepStrictEqual(first, ['api.backup.example']);
  assert.deepStrictEqual(second, ['api.backup.example']);
  assert.strictEqual(calls.length, 1, '并发未命中缓存时只请求一次发布页');
});

test('animeko fetchMirrorFallbackHosts 发布页请求失败后可重新发起请求', async () => {
  const payload = publishPayload([apiMirror('backup', 800, ['api.backup.example'])]);
  let attempt = 0;
  const { calls, mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
      }
      return mockJsonResponse(payload, url);
    }
    throw new Error(`未预期的请求地址: ${url}`);
  });

  const first = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts([]));
  const second = await withMockFetch(mockFetch, () => fetchMirrorFallbackHosts([]));

  assert.deepStrictEqual(first, [], '首次失败返回空列表');
  assert.deepStrictEqual(second, ['api.backup.example'], '失败后再次调用可重新获取');
  assert.strictEqual(calls.length, 2, '失败不写入缓存，下次调用重新请求');
});

test('animeko requestMirror 内置域名可用时不请求发布页', async () => {
  const { calls, mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) {
      return mockJsonResponse(publishPayload([apiMirror('other', 900, ['api.other.example'])]), url);
    }
    throw new Error('未预期的请求地址');
  });

  const result = await withMockFetch(mockFetch, () => requestMirror(async (base) => {
    assert.strictEqual(base, BUILTIN_MIRROR_API_BASE);
    return { ok: true };
  }));

  assert.strictEqual(result.base, BUILTIN_MIRROR_API_BASE);
  assert.deepStrictEqual(result.result, { ok: true });
  assert.strictEqual(calls.length, 0, '内置域名成功时不访问发布页');
  assert.strictEqual(getCurrentMirrorBase(), BUILTIN_MIRROR_API_BASE, '当前域名保持内置值');
});

test('animeko requestMirror 内置域名失败时切换至发布页备用域名', async () => {
  const payload = publishPayload([
    apiMirror('builtin', 1000, ['api.bangumi.lat']),
    apiMirror('backup', 800, ['api.backup.example']),
  ]);

  const { calls, mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) return mockJsonResponse(payload, url);
    return { ok: false, status: 502, headers: new Headers(), text: async () => 'bad gateway' };
  });

  const attempted = [];
  const result = await withMockFetch(mockFetch, () => requestMirror(async (base) => {
    attempted.push(base);
    if (base === BUILTIN_MIRROR_API_BASE) return null;
    return { host: base };
  }));

  assert.deepStrictEqual(attempted, [BUILTIN_MIRROR_API_BASE, 'https://api.backup.example'], '依次尝试内置域名与备用域名');
  assert.strictEqual(result.base, 'https://api.backup.example');
  assert.deepStrictEqual(result.result, { host: 'https://api.backup.example' });
  assert.strictEqual(getCurrentMirrorBase(), 'https://api.backup.example', '成功后记录为当前域名');
  assert.ok(calls.some(c => c.url.startsWith(MIRROR_PUBLISH_API)), '请求过发布页');
});

test('animeko requestMirror 备用域名请求抛出异常时继续尝试下一个域名', async () => {
  const payload = publishPayload([
    apiMirror('backup1', 900, ['api.backup1.example']),
    apiMirror('backup2', 800, ['api.backup2.example']),
    apiMirror('backup3', 700, ['api.backup3.example']),
  ]);

  const { mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) return mockJsonResponse(payload, url);
    return { ok: false, status: 500, headers: new Headers(), text: async () => 'error' };
  });

  const attempted = [];
  const result = await withMockFetch(mockFetch, () => requestMirror(async (base) => {
    attempted.push(base);
    if (base.endsWith('backup2.example')) return { host: base };
    throw new Error(`域名不可用: ${base}`);
  }));

  assert.deepStrictEqual(attempted, [
    BUILTIN_MIRROR_API_BASE,
    'https://api.backup1.example',
    'https://api.backup2.example',
  ], '备用域名最多尝试两个且互不重复');
  assert.strictEqual(result.base, 'https://api.backup2.example');
  assert.strictEqual(getCurrentMirrorBase(), 'https://api.backup2.example');
});

test('animeko requestMirror 全部域名失败时返回 null', async () => {
  const payload = publishPayload([
    apiMirror('backup1', 900, ['api.backup1.example']),
    apiMirror('backup2', 800, ['api.backup2.example']),
  ]);

  const { mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) return mockJsonResponse(payload, url);
    return { ok: false, status: 500, headers: new Headers(), text: async () => 'error' };
  });

  const result = await withMockFetch(mockFetch, () => requestMirror(async () => {
    throw new Error('全部节点不可用');
  }));

  assert.strictEqual(result, null);
  assert.strictEqual(getCurrentMirrorBase(), BUILTIN_MIRROR_API_BASE, '失败时不改变当前域名');
});

test('animeko requestMirror 发布页仅返回当前域名时不再尝试其它域名', async () => {
  const payload = publishPayload([apiMirror('builtin', 1000, ['api.bangumi.lat'])]);

  const { mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) return mockJsonResponse(payload, url);
    return { ok: false, status: 502, headers: new Headers(), text: async () => 'bad gateway' };
  });

  const attempted = [];
  const result = await withMockFetch(mockFetch, () => requestMirror(async (base) => {
    attempted.push(base);
    throw new Error('节点不可用');
  }));

  assert.deepStrictEqual(attempted, [BUILTIN_MIRROR_API_BASE], '当前域名被排除后无候选域名');
  assert.strictEqual(result, null);
});

test('animeko requestMirror 发布页不可用时返回 null 且保留当前域名', async () => {
  const { mockFetch } = createFetchMock((url) => {
    if (url.startsWith(MIRROR_PUBLISH_API)) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
    }
    return { ok: false, status: 502, headers: new Headers(), text: async () => 'bad gateway' };
  });

  const result = await withMockFetch(mockFetch, () => requestMirror(async () => {
    throw new Error('节点不可用');
  }));

  assert.strictEqual(result, null);
  assert.strictEqual(getCurrentMirrorBase(), BUILTIN_MIRROR_API_BASE);
});
