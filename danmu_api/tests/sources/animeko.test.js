// Animeko 源：镜像域名路由与发布页回退
// 通过 mock fetch 验证搜索与详情两条链路的镜像节点选择、发布页备用域名切换与官方节点兜底。

import test from 'node:test';
import assert from 'node:assert';
import AnimekoSource from '../../sources/animeko.js';
import { BUILTIN_MIRROR_API_BASE, resetMirrorState } from '../../utils/animeko-util.js';
import { MIRROR_PUBLISH_API, apiMirror, publishPayload } from '../helpers/animeko.js';
import { withMockFetch, mockJsonResponse, resetSearchState } from '../helpers/context.js';

const OFFICIAL = 'https://api.bgm.tv';

function searchPayload(name) {
  return { data: [{ id: 1, name, name_cn: name, date: '2024-01-01', type: 2 }] };
}

// 统一的请求分发：发布页、镜像域名、官方域名与 Animeko 弹幕节点
function createDispatch({ publishMirrors }) {
  const calls = [];
  const dispatch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET' });

    if (target.startsWith(MIRROR_PUBLISH_API)) {
      return mockJsonResponse(publishPayload(publishMirrors), target);
    }

    if (target.includes('api.animeko.org') || target.includes('myani.org') || target.includes('openani.org')) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
    }

    if (target.startsWith(BUILTIN_MIRROR_API_BASE)) {
      return { ok: false, status: 502, headers: new Headers(), text: async () => 'bad gateway' };
    }

    if (target.startsWith(OFFICIAL)) {
      return mockJsonResponse(searchPayload('测试条目'), target);
    }

    return { ok: false, status: 500, headers: new Headers(), text: async () => 'unexpected' };
  };
  return { calls, dispatch };
}

test.beforeEach(() => {
  resetSearchState();
  resetMirrorState();
});

test('animeko search 优先使用内置镜像域名', async () => {
  const source = new AnimekoSource();
  const calls = [];

  await withMockFetch(async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET' });

    if (target.startsWith(BUILTIN_MIRROR_API_BASE)) {
      return mockJsonResponse(searchPayload('测试条目'), target);
    }
    return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
  }, () => source.search('测试条目'));

  const mirrorCall = calls.find(c => c.url.startsWith(BUILTIN_MIRROR_API_BASE));
  assert.ok(mirrorCall, '内置镜像域名被请求');
  assert.strictEqual(mirrorCall.method, 'POST', '搜索走 POST 接口');
  assert.ok(!calls.some(c => c.url.startsWith(OFFICIAL)), '镜像可用时不请求官方域名');
});

test('animeko search 内置镜像失败时切换至发布页备用域名', async () => {
  const source = new AnimekoSource();
  const { calls, dispatch } = createDispatch({
    publishMirrors: [apiMirror('backup', 800, ['api.backup.example'])],
  });

  const result = await withMockFetch(async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET' });

    if (target.startsWith('https://api.backup.example')) {
      return mockJsonResponse(searchPayload('测试条目'), target);
    }
    return dispatch(url, options);
  }, () => source.search('测试条目'));

  assert.strictEqual(result.length, 1, '备用域名返回搜索结果');
  assert.ok(calls.some(c => c.url.startsWith(MIRROR_PUBLISH_API)), '请求过发布页');
  assert.ok(calls.some(c => c.url.startsWith('https://api.backup.example')), '备用域名被请求');
  assert.ok(!calls.some(c => c.url.startsWith(OFFICIAL)), '备用域名可用时不请求官方域名');
});

test('animeko search 镜像域名全部失败时降级至官方域名', async () => {
  const source = new AnimekoSource();
  const { calls, dispatch } = createDispatch({
    publishMirrors: [apiMirror('backup', 800, ['api.backup.example'])],
  });

  const result = await withMockFetch(dispatch, () => source.search('测试条目'));

  assert.strictEqual(result.length, 1, '官方域名返回搜索结果');
  assert.ok(calls.some(c => c.url.startsWith(OFFICIAL)), '官方域名被请求');
});

test('animeko search 发布页无可用备用域名时直接降级至官方域名', async () => {
  const source = new AnimekoSource();
  const { calls, dispatch } = createDispatch({
    publishMirrors: [apiMirror('builtin', 1000, ['api.bangumi.lat'])],
  });

  const result = await withMockFetch(dispatch, () => source.search('测试条目'));

  assert.strictEqual(result.length, 1);
  assert.ok(calls.some(c => c.url.startsWith(OFFICIAL)), '官方域名被请求');
});

test('animeko getEpisodes 详情链路的镜像节点失败后切换至备用域名', async () => {
  const source = new AnimekoSource();
  const calls = [];

  const result = await withMockFetch(async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET' });

    if (target.startsWith(MIRROR_PUBLISH_API)) {
      return mockJsonResponse(publishPayload([apiMirror('backup', 800, ['api.backup.example'])]), target);
    }

    if (target.includes('api.animeko.org') || target.includes('myani.org') || target.includes('openani.org')) {
      return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
    }

    if (target.startsWith('https://api.backup.example')) {
      if (target.includes('/v0/episodes')) {
        return mockJsonResponse({ data: [{ id: 900, sort: 1, ep: 1, type: 0, name: '第一话' }] }, target);
      }
      if (target.includes('/subjects')) {
        return mockJsonResponse({ data: [] }, target);
      }
    }

    return { ok: false, status: 502, headers: new Headers(), text: async () => 'bad gateway' };
  }, () => source.getEpisodes(12345));

  assert.strictEqual(result.length, 1, '备用域名返回剧集列表');
  assert.strictEqual(result[0].id, 900);
  assert.ok(calls.some(c => c.url.startsWith('https://api.backup.example')), '备用域名被请求');
  assert.ok(calls.some(c => c.url.startsWith(BUILTIN_MIRROR_API_BASE)), '内置镜像域名先被尝试');
});
