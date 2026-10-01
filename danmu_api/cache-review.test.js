import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const base = new URL('./', import.meta.url).href;
const script = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import os from 'node:os';
  import path from 'node:path';
  const base = ${JSON.stringify(base)};
  const { Globals: g } = await import(base + 'configs/globals.js');
  const redis = await import(base + 'utils/redis-util.js');
  const cache = await import(base + 'utils/cache-util.js');
  const { persistFavorites } = await import(base + 'apis/favorite-api.js');
  const { handleRequest } = await import(base + 'worker.js');
  const fixture = () => ({ results: [{ animeId: 1, animeTitle: 'saved' }], details: [], timestamp: 1,
    refreshSchedule: { frequency: 'weekly', weekday: 3, time: '09:00', nextRunAt: 1790816400000 } });
  const env = (url = 'https://old.invalid', token = 'old-token') => ({
    UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token,
    LOCAL_CACHE_ENABLED: 'false', LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0', TOKEN: '87654321'
  });
  const storeKey = (url, token) => JSON.stringify([url, token]);
  const stores = new Map([
    [storeKey('https://old.invalid', 'old-token'), new Map([['favoriteCache', JSON.stringify({ old: fixture() })]])],
    [storeKey('https://new.invalid', 'new-token'), new Map([['favoriteCache', JSON.stringify({ new: fixture() })]])],
    [storeKey('https://old.invalid', 'new-token'), new Map([['favoriteCache', JSON.stringify({ new: fixture() })]])]
  ]);
  const calls = [];
  let failRead = false;
  let delay = null;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/ping') return Response.json({ result: 'PONG' });
    assert.equal(parsed.pathname, '/pipeline');
    const token = options.headers.Authorization.slice(7);
    const commands = JSON.parse(options.body);
    const store = stores.get(storeKey(parsed.origin, token));
    assert.ok(store);
    const results = commands.map(([op, key, value]) => {
      calls.push({ url: parsed.origin, token, op, key });
      if (op === 'GET' && key === 'favoriteCache' && failRead) return { error: 'temporary read failure' };
      if (op === 'GET') return { result: store.get(key) ?? null };
      assert.equal(op, 'SET'); store.set(key, value); return { result: 'OK' };
    });
    const waiting = delay;
    if (waiting && parsed.origin === 'https://old.invalid'
      && commands.some(([op, key]) => op === waiting.op && key === 'favoriteCache')) {
      delay = null; waiting.started(); await waiting.promise;
    }
    return Response.json(results);
  };
  const setup = async settings => {
    g.init(settings); await redis.judgeRedisValid('/api/config'); await redis.initializePersistentCaches('node');
  };
  const request = (settings, route, method = 'GET', body = undefined, platform = 'vercel') =>
    handleRequest(new Request('https://service.invalid' + route, { method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    }), settings, platform, '127.0.0.1');
  const oldStore = stores.get(storeKey('https://old.invalid', 'old-token'));
  const pause = op => {
    let release, started;
    const promise = new Promise(resolve => { release = resolve; });
    const begun = new Promise(resolve => { started = resolve; });
    delay = { op, promise, started };
    return { release, begun };
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-review-'));
  const cwd = process.cwd(); process.chdir(dir);
  try {
    const scenario = process.argv[1];
    if (['switch-url', 'switch-token', 'switch-empty', 'switch-unreadable'].includes(scenario)) {
      await setup(env());
      const nextEnv = env(scenario === 'switch-token' ? 'https://old.invalid' : 'https://new.invalid', 'new-token');
      const nextStore = stores.get(storeKey(nextEnv.UPSTASH_REDIS_REST_URL, 'new-token'));
      if (scenario === 'switch-empty') nextStore.delete('favoriteCache');
      if (scenario === 'switch-unreadable') failRead = true;
      await setup(nextEnv); await persistFavorites();
      assert.ok(calls.some(x => x.url === nextEnv.UPSTASH_REDIS_REST_URL && x.token === 'new-token' && x.op === 'GET' && x.key === 'favoriteCache'));
      if (scenario === 'switch-unreadable') {
        assert.equal(g.favoriteCacheWritable.upstash, false);
        assert.deepEqual(Object.keys(JSON.parse(nextStore.get('favoriteCache'))), ['new']);
        assert.equal(calls.some(x => x.token === 'new-token' && x.op === 'SET' && x.key === 'favoriteCache'), false);
      } else {
        assert.deepEqual([...g.favoriteCache.keys()], scenario === 'switch-empty' ? [] : ['new']);
        assert.deepEqual(Object.keys(JSON.parse(nextStore.get('favoriteCache'))), scenario === 'switch-empty' ? [] : ['new']);
        if (scenario !== 'switch-empty') assert.ok(g.favoriteCache.get('new').refreshSchedule);
      }
    } else if (scenario === 'disable-upstash') {
      await setup(env());
      const settings = { ...env(), UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '' };
      const response = await request(settings, '/api/favorite/remove', 'POST', { keyword: 'old' }, 'node');
      assert.equal(response.status, 200); assert.equal((await response.json()).success, true);
      assert.equal(g.favoriteCache.has('old'), false);
      assert.deepEqual(Object.keys(JSON.parse(oldStore.get('favoriteCache'))), ['old']);
    } else if (scenario === 'initial-file-fallback') {
      oldStore.delete('favoriteCache');
      await fs.mkdir('.cache');
      await fs.writeFile('.cache/favoritesCache', JSON.stringify(JSON.stringify({ saved: fixture() })));
      await setup({ ...env(), LOCAL_CACHE_ENABLED: 'true' });
      assert.ok(g.favoriteCache.has('saved'));
      assert.equal(await redis.getFavoriteCachesFromRedis(), true);
      assert.ok(g.favoriteCache.has('saved'));
    } else if (scenario === 'temporary-read') {
      oldStore.set('favoriteCache', JSON.stringify({ saved: fixture() }));
      assert.equal((await request(env(), '/api/favorite/list')).status, 200);
      const before = JSON.stringify([...g.favoriteCache]);
      for (const action of ['add', 'remove', 'refresh']) {
        failRead = true; calls.length = 0;
        const response = await request(env(), '/api/favorite/' + action, 'POST', { keyword: 'saved' });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).success, false);
        assert.equal(JSON.stringify([...g.favoriteCache]), before);
        assert.equal(calls.some(x => x.op === 'SET' && x.key === 'favoriteCache'), false);
      }
      failRead = false;
      const retry = await request(env(), '/api/favorite/remove', 'POST', { keyword: 'saved' });
      assert.equal(retry.status, 200); assert.equal((await retry.json()).success, true);
      assert.deepEqual(JSON.parse(oldStore.get('favoriteCache')), {});
      const list = await (await request(env(), '/api/favorite/list')).json();
      assert.deepEqual(list.favorites, []);
    } else if (scenario === 'node-read-protection') {
      failRead = true;
      const response = await request(env(), '/api/favorite/remove', 'POST', { keyword: 'old' }, 'node');
      assert.equal(response.status, 503); assert.equal((await response.json()).success, false);
      assert.deepEqual(Object.keys(JSON.parse(oldStore.get('favoriteCache'))), ['old']);
    } else if (scenario === 'stale-read' || scenario === 'stale-write') {
      await setup(env());
      if (scenario === 'stale-write') g.favoriteCache.set('changed', fixture());
      const waiting = pause(scenario === 'stale-read' ? 'GET' : 'SET');
      const oldOperation = scenario === 'stale-read' ? redis.getFavoriteCachesFromRedis() : redis.updateRedisCaches({ keys: ['favoriteCache'] });
      await waiting.begun;
      await setup(env('https://new.invalid', 'new-token'));
      const hash = g.upstashHashes.favoriteCache;
      waiting.release(); assert.equal(await oldOperation, false);
      assert.deepEqual([...g.favoriteCache.keys()], ['new']);
      assert.equal(g.favoriteCacheWritable.upstash, true);
      assert.equal(g.upstashHashes.favoriteCache, hash);
    } else if (scenario === 'stale-node-request') {
      oldStore.set('favoriteCache', JSON.stringify({ shared: fixture() }));
      const nextStore = stores.get(storeKey('https://new.invalid', 'new-token'));
      nextStore.set('favoriteCache', JSON.stringify({ shared: fixture(), untouched: fixture() }));
      const waiting = pause('GET');
      const oldRequest = request(env(), '/api/favorite/remove', 'POST', { keyword: 'shared' }, 'node');
      await waiting.begun;
      await setup(env('https://new.invalid', 'new-token'));
      const before = nextStore.get('favoriteCache');
      calls.length = 0; waiting.release();
      const response = await oldRequest;
      assert.equal(response.status, 503); assert.equal((await response.json()).success, false);
      assert.deepEqual([...g.favoriteCache.keys()], ['shared', 'untouched']);
      assert.equal(nextStore.get('favoriteCache'), before);
      assert.deepEqual(Object.keys(JSON.parse(oldStore.get('favoriteCache'))), ['shared']);
      assert.equal(calls.some(x => x.op === 'SET' && x.key === 'favoriteCache'), false);
    } else if (scenario === 'stale-initialization') {
      g.init(env()); await redis.judgeRedisValid('/api/config');
      const waiting = pause('GET');
      const oldOperation = redis.initializePersistentCaches('node');
      await waiting.begun;
      await setup(env('https://new.invalid', 'new-token'));
      waiting.release(); assert.equal(await oldOperation, false);
      assert.deepEqual([...g.favoriteCache.keys()], ['new']);
      assert.equal(g.redisCacheInitialized, true);
      assert.equal(g.favoriteCacheWritable.upstash, true);
    } else {
      throw new Error('Unknown scenario: ' + scenario);
    }
  } finally {
    process.chdir(cwd); await fs.rm(dir, { recursive: true, force: true });
  }
`;

for (const scenario of [
  'switch-url', 'switch-token', 'switch-empty', 'switch-unreadable', 'initial-file-fallback',
  'temporary-read', 'node-read-protection', 'disable-upstash', 'stale-read', 'stale-write', 'stale-initialization', 'stale-node-request'
]) {
  test('PR492 favorite regression: ' + scenario, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, scenario], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_TEST_CONTEXT: '' }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

const { Globals } = await import('./configs/globals.js');
const { addAnime, addEpisode, findUrlById, getEpisodeIdFloor } = await import('./utils/cache-util.js');
const { handleClearCache } = await import('./apis/system-api.js');

function resetEpisodeState() {
  Globals.init({ LOCAL_CACHE_ENABLED: 'false', LOG_LEVEL: 'error', SEARCH_CACHE_MINUTES: '30' });
  Object.assign(Globals, {
    deployPlatform: 'node', localCacheValid: false, redisValid: false,
    queryCacheInitialized: true, queryCacheWritable: {}, favoriteCacheWritable: {},
    animes: [], episodeIds: [], episodeNum: 10001, favoriteCache: new Map(), searchCache: new Map()
  });
}

for (const source of ['favorite', 'search']) {
  test('PR492 episode IDs: reset retains ' + source + ' references', async () => {
    resetEpisodeState();
    const reference = { timestamp: Date.now(), details: [{ animeId: 1,
      links: [{ id: 10002, url: 'https://old.invalid/episode', title: 'old' }] }] };
    const store = source === 'favorite' ? Globals.favoriteCache : Globals.searchCache;
    store.set('saved', reference);
    assert.equal(findUrlById(10002), 'https://old.invalid/episode');
    assert.equal((await handleClearCache({ json: async () => ({ items: ['episodeNum'] }) })).status, 200);
    assert.equal(Globals.episodeNum, 10002);
    assert.equal(addEpisode('https://new.invalid/episode', 'new').id, 10003);
    assert.equal(findUrlById(10002), 'https://old.invalid/episode');
  });
}

test('PR492 episode IDs: expired search references do not raise the reset floor', () => {
  resetEpisodeState();
  Globals.searchCache.set('expired', { timestamp: Date.now() - 31 * 60000,
    details: [{ links: [{ id: 90000, url: 'https://old.invalid/episode' }] }] });
  assert.equal(getEpisodeIdFloor(), 10001);
  assert.equal(addEpisode('https://new.invalid/episode', 'new').id, 10002);
});

test('PR492 episode IDs: each anime batch scans references once and keeps existing mappings', () => {
  resetEpisodeState();
  let visits = 0;
  const existing = { get id() { visits++; return 20000; }, url: 'https://old.invalid/episode', title: 'old' };
  Globals.animes = [{ animeId: 1, links: [existing] }];
  const links = Array.from({ length: 100 }, (_, i) => ({ url: 'https://new.invalid/' + i, title: String(i) }));
  assert.equal(addAnime({ animeId: 2, animeTitle: 'new', links }), true);
  assert.ok(visits <= 4, 'the old detail is scanned once per batch, rather than once per new episode');
  assert.equal(Globals.episodeIds[0].id, 20001);
  assert.equal(Globals.episodeIds.at(-1).id, 20100);
  assert.equal(findUrlById(20000), 'https://old.invalid/episode');
});

test('PR492 episode IDs: failed batch retains the corrected floor and publishes no partial links', () => {
  resetEpisodeState();
  const floor = Number.MAX_SAFE_INTEGER - 2;
  Globals.favoriteCache.set('saved', { details: [{ links: [{ id: floor, url: 'https://old.invalid/episode' }] }] });
  const details = new Map();
  assert.equal(addAnime({ animeId: 2, animeTitle: 'new', links: [
    { url: 'https://new.invalid/1', title: '1' }, { url: 'https://new.invalid/2', title: '2' }
  ] }, details), false);
  assert.deepEqual(Globals.episodeIds, []);
  assert.deepEqual(Globals.animes, []);
  assert.equal(details.size, 0);
  assert.equal(Globals.episodeNum, floor);
  assert.match(details.__addAnimeError, /安全范围/);
  assert.equal(addEpisode('https://new.invalid/retry', 'retry').id, floor + 1);
  assert.equal(findUrlById(floor), 'https://old.invalid/episode');
});

test('PR492 Local Redis: serialize once, retain acknowledged hashes, and retry failed writes', () => {
  const redisModule = import.meta.resolve('redis');
  const localScript = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const base = ${JSON.stringify(base)};
    const { Globals: g } = await import(base + 'configs/globals.js');
    const { simpleHash } = await import(base + 'utils/codec-util.js');
    const values = new Map();
    const writes = [];
    let fail = false, pause = null;
    mock.module(${JSON.stringify(redisModule)}, { namedExports: { createClient: () => ({
      isReady: false, isOpen: false, on() {},
      async connect() { this.isReady = this.isOpen = true; },
      destroy() { this.isReady = this.isOpen = false; },
      async quit() { this.destroy(); },
      async get(key) { return values.get(key) ?? null; },
      async set(key, value) {
        writes.push([key, value]);
        if (fail) throw new Error('write failed');
        if (pause) { const waiting = pause; pause = null; waiting.started(); await waiting.promise; }
        values.set(key, value); return 'OK';
      }
    }) } });
    const local = await import(base + 'utils/local-redis-util.js');
    g.init({ LOCAL_REDIS_URL: 'redis://mock', LOCAL_CACHE_ENABLED: 'false', LOG_LEVEL: 'error' });
    g.queryCacheInitialized = true; g.queryCacheWritable.localRedis = true;
    let serializations = 0;
    g.animes = [{ toJSON() { serializations++; return { animeId: 1 }; } }];
    try {
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'] }), true);
      assert.equal(serializations, 1, 'each selected key is serialized once per batch');
      assert.equal(writes.length, 1);
      assert.equal(g.localRedisHashes.animes, simpleHash(values.get('animes')));
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'] }), true);
      assert.equal(writes.length, 1, 'unchanged data sends no SET');
      const savedHash = g.localRedisHashes.animes;
      g.animes = [{ animeId: 2 }]; fail = true;
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'] }), false);
      assert.equal(g.localRedisHashes.animes, savedHash);
      fail = false;
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'] }), true);
      assert.deepEqual(JSON.parse(values.get('animes')), [{ animeId: 2 }]);
      assert.equal(g.localRedisHashes.animes, simpleHash(values.get('animes')));
      const beforeForce = writes.length;
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'], force: true }), true);
      assert.equal(writes.length, beforeForce + 1, 'force still writes unchanged values');
      let release, started;
      const promise = new Promise(resolve => { release = resolve; });
      const begun = new Promise(resolve => { started = resolve; });
      pause = { promise, started };
      g.animes = [{ animeId: 3 }];
      const saving = local.updateLocalRedisCaches({ keys: ['animes'] });
      await begun; g.animes = [{ animeId: 4 }]; release();
      assert.equal(await saving, true);
      assert.deepEqual(JSON.parse(values.get('animes')), [{ animeId: 3 }]);
      assert.equal(g.localRedisHashes.animes, simpleHash(values.get('animes')));
      assert.equal(await local.updateLocalRedisCaches({ keys: ['animes'] }), true);
      assert.deepEqual(JSON.parse(values.get('animes')), [{ animeId: 4 }]);
      assert.equal((await local.setLocalRedisKey('animes', [{ animeId: 5 }])).result, 'OK');
      assert.deepEqual(JSON.parse(values.get('animes')), [{ animeId: 5 }]);
    } finally { await local.closeLocalRedisConnection(); }
  `;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', localScript], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: '' }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
