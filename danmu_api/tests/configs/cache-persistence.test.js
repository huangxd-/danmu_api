// 持久化缓存回归：Local Redis 优先级与独立后端（子进程隔离）
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getComment } from '../../apis/dandan-api.js';
import { handleClearCache } from '../../apis/system-api.js';
import { Globals } from '../../configs/globals.js';
import TencentSource from '../../sources/tencent.js';
import { addAnime, addEpisode, findUrlById } from '../../utils/cache-util.js';
import { saveLocalDanmu, listLocalDanmu } from '../../utils/local-danmu-store.js';
import { getLocalRedisKey, setLocalRedisKey, setLocalRedisKeyWithExpiry } from '../../utils/local-redis-util.js';
import { setRedisKey, setRedisKeyWithExpiry, updateRedisCaches } from '../../utils/redis-util.js';
import { handleRequest } from '../../worker.js';


// 放在独立子进程中 mock redis，避免影响同进程内的其它用例；随 npm test 一并执行。
test('persistent cache regression: Local Redis priority and independent backends', () => {
  const base = new URL('../../', import.meta.url).href;
  const script = `
    import { test, mock } from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const base = ${JSON.stringify(base)};
    const { Globals } = await import(base + 'configs/globals.js');
    let backend, remote, reads, writes, remoteCommands, unavailable, failedRead, failedWrite, upstashOffline, clients;
    mock.module(${JSON.stringify(import.meta.resolve('redis'))}, { namedExports: { createClient: () => {
      const client = {
        isReady: false, isOpen: false, on() {},
        async connect() {
          if (unavailable) throw new Error('offline');
          this.isOpen = this.isReady = true;
        },
        destroy() { this.isOpen = this.isReady = false; },
        async quit() { this.destroy(); },
        async get(key) {
          reads.push(key);
          if (key === failedRead) throw new Error('read failed');
          return backend.get(key) ?? null;
        },
        async set(key, value) {
          writes.push(key);
          if (key === failedWrite) throw new Error('write failed');
          backend.set(key, value); return 'OK';
        },
        async setEx(key, seconds, value) { return this.set(key, value); }
      };
      clients.push(client); return client;
    } } });
    mock.method(globalThis, 'fetch', async (url, opts) => {
      if (upstashOffline) throw new Error('Upstash offline');
      if (String(url).endsWith('/ping')) return Response.json({ result: 'PONG' });
      const commands = JSON.parse(opts.body);
      remoteCommands.push(...commands);
      return Response.json(commands.map(([op, key, value]) => {
        if (op === 'GET') return { result: remote.get(key) ?? null };
        remote.set(key, value); return { result: 'OK' };
      }));
    });
    const local = await import(base + 'utils/local-redis-util.js');
    const redis = await import(base + 'utils/redis-util.js');
    const cache = await import(base + 'utils/cache-util.js');
    const store = await import(base + 'utils/local-danmu-store.js');
    const { initializePersistentCaches } = redis;
    const { handleRequest } = await import(base + 'worker.js');
    const { getComment } = await import(base + 'apis/dandan-api.js');
    const { persistFavorites, handleFavoriteRemove } = await import(base + 'apis/favorite-api.js');
    const { handleClearCache } = await import(base + 'apis/system-api.js');
    const settings = { LOCAL_REDIS_URL: 'redis://mock', LOCAL_CACHE_ENABLED: 'false', LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0', SOURCE_ORDER: 'tencent' };
    const upstash = { UPSTASH_REDIS_REST_URL: 'https://mock.invalid', UPSTASH_REDIS_REST_TOKEN: 'mock' };
    const favorite = () => ({ results: [], details: [], timestamp: 1, refreshSchedule: null });
    async function isolated(name, overrides, run) {
      await test(name, async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-persistence-'));
        const cwd = process.cwd(); process.chdir(dir);
        const env = { ...settings, ...overrides };
        Globals.init(env);
        Object.assign(Globals, {
          deployPlatform: 'node', localCacheValid: false, localCacheInitialized: false,
          localRedisValid: false, redisValid: Boolean(env.UPSTASH_REDIS_REST_URL), localRedisCacheInitialized: false, redisCacheInitialized: false,
          queryCacheInitialized: false, queryCacheWritable: {}, favoriteCacheWritable: {},
          localFileHashes: {}, upstashHashes: {}, localRedisHashes: {}, animes: [], episodeIds: [], episodeNum: 10001,
          reqRecords: [], todayReqNum: 0, lastSelectMap: new Map(), favoriteCache: new Map(),
          searchCache: new Map(), commentCache: new Map(), requestHistory: new Map()
        });
        backend = new Map(); remote = new Map(); clients = []; reads = []; writes = []; remoteCommands = [];
        unavailable = upstashOffline = false; failedRead = failedWrite = null;
        try { await run(env); }
        finally {
          await local.closeLocalRedisConnection();
          process.chdir(cwd); await fs.rm(dir, { recursive: true, force: true });
        }
      });
    }
    async function file(key, value) {
      await fs.mkdir('.cache', { recursive: true });
      await fs.writeFile('.cache/' + key, JSON.stringify(JSON.stringify(value)));
    }
    const storedFile = async key => JSON.parse(JSON.parse(await fs.readFile('.cache/' + key, 'utf8')));
    const request = (env, route) => handleRequest(new Request('http://localhost' + route), env, 'node', '127.0.0.1');

    await isolated('comment and empty local reads do not create directories', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
      assert.equal((await getComment('/api/v2/comment/999', 'json', false)).status, 404);
      assert.deepEqual(await store.listLocalDanmu(), []);
      await assert.rejects(fs.stat('.cache'), { code: 'ENOENT' });
    });
    await isolated('disabled files are neither read nor written, including direct writes', {}, async () => {
      await file('animes', [{ animeId: 'file' }]);
      const before = await fs.readFile('.cache/animes', 'utf8');
      await initializePersistentCaches('node');
      Globals.animes = [{ animeId: 'memory' }];
      await cache.getLocalCaches(); await cache.updateLocalCaches();
      cache.writeCacheToFile('animes', '[]');
      assert.equal(Globals.animes[0].animeId, 'memory');
      assert.equal(await fs.readFile('.cache/animes', 'utf8'), before);
    });
    await isolated('file writes do not suppress Local Redis; only successful keys update hashes', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await fs.mkdir('.cache');
      await initializePersistentCaches('node');
      Globals.animes = [{ animeId: 1 }];
      await cache.updateLocalCaches();
      failedWrite = 'animes';
      assert.equal(await local.updateLocalRedisCaches(), false);
      assert.equal(Globals.localRedisHashes.animes, undefined);
      assert.equal(writes.length, 6);
      failedWrite = null;
      assert.equal(await local.updateLocalRedisCaches(), true);
      assert.equal(writes.length, 7);
      assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 1);
      await local.updateLocalRedisCaches(); assert.equal(writes.length, 7);
      assert.equal(backend.has('favoriteCache'), false);
    });
    await isolated('Local Redis restores first; other backends independently receive current data', { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'file' }]);
      remote.set('animes', '[{"animeId":"upstash"}]');
      remote.set('favoriteCache', JSON.stringify({ saved: favorite() }));
      backend.set('animes', '[{"animeId":"local"}]');
      await initializePersistentCaches('node');
      assert.equal(Globals.animes[0].animeId, 'local');
      assert.deepEqual(reads, ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum']);
      assert.ok(Globals.favoriteCache.has('saved'));
      assert.deepEqual(remoteCommands, ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum', 'favoriteCache'].map(key => ['GET', key]));
      Globals.animes.push({ animeId: 'new' });
      await cache.updateLocalCaches(); await redis.updateRedisCaches(); await local.updateLocalRedisCaches();
      assert.deepEqual(await storedFile('animes'), Globals.animes);
      assert.deepEqual(JSON.parse(remote.get('animes')), Globals.animes);
      assert.deepEqual(JSON.parse(backend.get('animes')), Globals.animes);
    });
    await isolated('hot enabling files cannot restore stale queries, counters or favorites', {}, async env => {
      await file('animes', [{ animeId: 'stale-file' }]); await file('episodeNum', 9);
      await file('favoritesCache', { old: favorite() });
      backend.set('animes', '[{"animeId":"current-redis"}]'); backend.set('episodeNum', '12000');
      await initializePersistentCaches('node');
      Globals.favoriteCache.set('current', favorite());
      await request({ ...env, LOCAL_CACHE_ENABLED: 'true' }, '/api/config');
      assert.equal(Globals.animes[0].animeId, 'current-redis'); assert.equal(Globals.episodeNum, 12000);
      assert.deepEqual([...Globals.favoriteCache.keys()], ['current']);
      await cache.updateLocalCaches(); await local.updateLocalRedisCaches();
      assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'current-redis');
      assert.equal((await storedFile('animes'))[0].animeId, 'current-redis');
      assert.deepEqual(Object.keys(await storedFile('favoritesCache')), ['current']);
    });
    await isolated('broken query files do not prevent Redis queries or legacy file favorites', { LOCAL_CACHE_ENABLED: 'true' }, async env => {
      await file('favoritesCache', { saved: favorite() });
      await fs.writeFile('.cache/reqRecords', 'invalid json');
      backend.set('animes', '[{"animeId":"redis"}]');
      assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
      assert.deepEqual(reads, ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum']); assert.equal(Globals.animes[0].animeId, 'redis');
      assert.ok(Globals.favoriteCache.has('saved'));
      const remove = await handleFavoriteRemove(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ keyword: 'saved' }) }));
      assert.equal(remove.status, 200);
      assert.deepEqual(await storedFile('favoritesCache'), {});
      assert.equal(backend.has('favoriteCache'), false);
    });
    for (const unreadable of ['animes', 'favoritesCache']) {
      await isolated('unreadable ' + unreadable + ' never erases file favorites during later saves', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
        await file('animes', [{ animeId: 1 }]); await file('favoritesCache', { saved: favorite() });
        const before = await fs.readFile('.cache/favoritesCache', 'utf8');
        const syncFs = (await import('node:fs')).default;
        const { syncBuiltinESMExports } = await import('node:module');
        const read = syncFs.readFileSync; const copy = syncFs.copyFileSync;
        const denied = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const readMock = mock.method(syncFs, 'readFileSync', (name, ...args) => {
          if (String(name).endsWith('/' + unreadable)) throw denied();
          return read(name, ...args);
        });
        const copyMock = mock.method(syncFs, 'copyFileSync', (name, ...args) => {
          if (String(name).endsWith('/' + unreadable)) throw denied();
          return copy(name, ...args);
        });
        syncBuiltinESMExports();
        try { await initializePersistentCaches('node'); }
        finally { readMock.mock.restore(); copyMock.mock.restore(); syncBuiltinESMExports(); }
        if (unreadable === 'animes') {
          assert.ok(Globals.favoriteCache.has('saved'));
          assert.equal(Globals.queryCacheWritable.file, false);
          Globals.favoriteCache.set('new', favorite()); await persistFavorites();
          assert.deepEqual(Object.keys(await storedFile('favoritesCache')), ['saved', 'new']);
        } else {
          assert.equal(Globals.favoriteCacheWritable.file, false);
          Globals.favoriteCache.set('new', favorite()); Globals.animes = [{ animeId: 2 }];
          await persistFavorites(); await cache.getLocalCaches(); await persistFavorites();
          assert.equal(await fs.readFile('.cache/favoritesCache', 'utf8'), before);
          assert.deepEqual(await storedFile('animes'), [{ animeId: 2 }]);
        }
      });
    }
    for (const failedKey of ['animes', 'favoriteCache']) {
      await isolated('Upstash ' + failedKey + ' read failure has an independent favorite write guard', { LOCAL_REDIS_URL: '', ...upstash }, async () => {
        remote.set('animes', '[{"animeId":1}]'); remote.set('favoriteCache', JSON.stringify({ saved: favorite() }));
        const original = globalThis.fetch;
        const fetch = mock.method(globalThis, 'fetch', async (url, opts) => {
          const commands = JSON.parse(opts.body);
          if (commands.some(([op, key]) => op === 'GET' && key === failedKey)) return Response.json(commands.map(() => ({ error: 'unreadable' })));
          return original(url, opts);
        });
        try { await initializePersistentCaches('node'); } finally { fetch.mock.restore(); }
        if (failedKey === 'animes') {
          assert.ok(Globals.favoriteCache.has('saved')); assert.equal(Globals.queryCacheWritable.upstash, false);
          Globals.favoriteCache.set('new', favorite()); await persistFavorites();
          assert.deepEqual(Object.keys(JSON.parse(remote.get('favoriteCache'))), ['saved', 'new']);
        } else {
          assert.equal(Globals.favoriteCacheWritable.upstash, false);
          Globals.favoriteCache.set('new', favorite()); await persistFavorites();
          assert.deepEqual(Object.keys(JSON.parse(remote.get('favoriteCache'))), ['saved']);
          assert.equal(await redis.getFavoriteCachesFromRedis(), true);
          assert.equal(Globals.favoriteCacheWritable.upstash, true);
          assert.deepEqual([...Globals.favoriteCache.keys()], ['saved']);
        }
      });
    }
    for (const invalidCounter of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await isolated('unusable secondary counter ' + invalidCounter + ' cannot poison episode allocation', upstash, async () => {
        const links = [{ id: 12000, url: 'https://example.com/primary', title: 'primary' }];
        backend.set('animes', JSON.stringify([{ animeId: 1, links }])); backend.set('episodeIds', JSON.stringify(links)); backend.set('episodeNum', '12000');
        remote.set('episodeNum', String(invalidCounter));
        await initializePersistentCaches('node');
        assert.equal(Globals.episodeNum, 12000); assert.equal(Globals.queryCacheWritable.upstash, false);
        const a = cache.addEpisode('https://example.com/a', 'a'); const b = cache.addEpisode('https://example.com/b', 'b');
        assert.deepEqual([a.id, b.id], [12001, 12002]);
        assert.equal(cache.findUrlById(a.id), a.url); assert.equal(cache.findUrlById(b.id), b.url);
      });
    }
    await isolated('invalid secondary mappings cannot raise a healthy primary counter', upstash, async () => {
      backend.set('animes', '[{"animeId":1}]'); backend.set('episodeNum', '12000');
      remote.set('episodeNum', '800000000');
      remote.set('episodeIds', '[{"id":50000,"url":"a"},{"id":50000,"url":"b"}]');
      await initializePersistentCaches('node');
      assert.equal(Globals.episodeNum, 12000); assert.equal(Globals.queryCacheWritable.upstash, false);
    });
    for (const primary of ['localRedis', 'upstash']) {
      for (const snapshot of ['complete', 'counter-only']) {
        for (const damagedKey of ['animes', 'episodeIds', 'episodeNum']) {
          await isolated(primary + ' ' + snapshot + ' counter survives damaged file ' + damagedKey, { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
            const target = primary === 'localRedis' ? backend : remote;
            const links = [{ id: 10500, url: 'https://example.com/saved', title: 'saved' }];
            target.set('episodeNum', '10500');
            if (snapshot === 'complete') {
              target.set('animes', JSON.stringify([{ animeId: 1, links }])); target.set('episodeIds', JSON.stringify(links));
            }
            await fs.mkdir('.cache'); await fs.writeFile('.cache/' + damagedKey, 'broken json');
            await initializePersistentCaches('node');
            assert.equal(Globals.episodeNum, 10500);
            assert.equal(cache.addEpisode('https://example.com/new', 'new').id, 10501);
            await cache.updateLocalCaches(); await redis.updateRedisCaches(); await local.updateLocalRedisCaches();
            assert.equal(await storedFile('episodeNum'), 10501);
            assert.equal(remote.get('episodeNum'), '10501'); assert.equal(backend.get('episodeNum'), '10501');
          });
        }
      }
    }
    await isolated('healthy counter-only fallback survives an unreadable primary', upstash, async () => {
      unavailable = true; remote.set('episodeNum', '10500');
      await initializePersistentCaches('node');
      assert.equal(cache.addEpisode('https://example.com/new', 'new').id, 10501);
      assert.equal(Globals.queryCacheWritable.localRedis, false);
    });
    await isolated('damaged files without any known ID floor retain collision protection', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await fs.mkdir('.cache'); await fs.writeFile('.cache/animes', 'broken json');
      const before = Date.now(); await initializePersistentCaches('node');
      assert.ok(Globals.episodeNum >= before);
      assert.equal(Globals.queryCacheWritable.file, true);
    });
    for (const failure of ['overflow', 'conflict']) {
      await isolated('failed anime allocation rolls back new IDs after ' + failure, {}, async () => {
        await initializePersistentCaches('node');
        const saved = { id: 12000, url: 'https://example.com/saved', title: 'saved' };
        const oldAnime = { animeId: 1, links: [saved] };
        Globals.animes = [oldAnime]; Globals.episodeIds = [saved];
        if (failure === 'conflict') Globals.episodeIds.push({ id: 12000, url: 'https://example.com/conflict', title: 'conflict' });
        Globals.episodeNum = failure === 'overflow' ? Number.MAX_SAFE_INTEGER - 2 : 12000;
        const before = { ids: [...Globals.episodeIds], counter: Globals.episodeNum }; const details = new Map();
        const second = failure === 'overflow' ? { url: 'https://example.com/second', title: 'second' } : saved;
        assert.equal(cache.addAnime({ animeId: 1, links: [{ url: 'https://example.com/new', title: 'new' }, second] }, details), false);
        assert.deepEqual(Globals.episodeIds, before.ids); assert.equal(Globals.episodeNum, before.counter);
        assert.equal(Globals.animes[0], oldAnime); assert.equal(details.size, 0);
        assert.ok(cache.getAddAnimeError(details));
        await local.updateLocalRedisCaches();
        assert.deepEqual(JSON.parse(backend.get('episodeIds')), before.ids);
      });
    }
    await isolated('allocator refuses overflow without adding duplicate IDs', { LOCAL_REDIS_URL: '' }, async () => {
      await initializePersistentCaches('node'); Globals.episodeNum = Number.MAX_SAFE_INTEGER - 2;
      const a = cache.addEpisode('https://example.com/a', 'a');
      assert.equal(a.id, Number.MAX_SAFE_INTEGER - 1); assert.ok(Number.isSafeInteger(a.id));
      assert.throws(() => cache.addEpisode('https://example.com/b', 'b'), /安全范围/);
      assert.deepEqual(Globals.episodeIds, [a]); assert.equal(cache.findUrlById(a.id), a.url);
    });
    await isolated('addAnime overflow is reported to search callers instead of only the server log', {}, async env => {
      const { default: TencentSource } = await import(base + 'sources/tencent.js');
      const search = mock.method(TencentSource.prototype, 'search', async () => [{}]);
      const build = (id, url) => ({
        animeId: id, bangumiId: String(id), animeTitle: 'overflow(2026)【TV】from tencent',
        type: 'tvseries', typeDescription: 'TV', imageUrl: '', startDate: '2026-01-01',
        episodeCount: 1, rating: 0, isFavorited: true, source: 'tencent',
        links: [{ name: '第1集', title: '【qq】 第1集', url }]
      });
      // 1) 写入失败且该条目没有进入结果列表：errorMessage 承载可操作原因
      const failOnly = mock.method(TencentSource.prototype, 'handleAnimes', async (_results, _query, animes, details) => {
        if (cache.addAnime(build(900001, 'https://v.qq.com/overflow-1'), details)) animes.push(build(900001, 'https://v.qq.com/overflow-1'));
      });
      try {
        Globals.episodeNum = Number.MAX_SAFE_INTEGER - 1;
        const failed = await (await request(env, '/api/v2/search/anime?keyword=overflow')).json();
        assert.equal(failed.success, true);
        assert.equal(failed.animes.length, 0);
        assert.match(failed.errorMessage, /安全范围/);
      } finally { failOnly.mock.restore(); }

      // 2) 写入失败但同一请求里另有可用结果：错误信息属于提示，不能占用 errorMessage
      const mixed = mock.method(TencentSource.prototype, 'handleAnimes', async (_results, _query, animes, details) => {
        if (cache.addAnime(build(900003, 'https://v.qq.com/ok-3'), details)) animes.push(build(900003, 'https://v.qq.com/ok-3'));
        cache.addAnime(build(900002, 'https://v.qq.com/overflow-2'), details);
      });
      try {
        // 留出一个可用编号：先成功写入一条，随后越界
        Globals.episodeNum = Number.MAX_SAFE_INTEGER - 2;
        const partial = await (await request(env, '/api/v2/search/anime?keyword=overflow')).json();
        assert.equal(partial.success, true);
        assert.equal(partial.animes.length, 1);
        assert.equal(partial.errorMessage, '');
      } finally { search.mock.restore(); mixed.mock.restore(); }
    });
    await isolated('restored animes entries with null links do not fail later cache writes', {}, async env => {
      // 历史快照里 links 为 null 时，写入诊断的序列化不得反过来把成功的写入判成失败
      const { default: TencentSource } = await import(base + 'sources/tencent.js');
      const search = mock.method(TencentSource.prototype, 'search', async () => [{}]);
      const handle = mock.method(TencentSource.prototype, 'handleAnimes', async (_results, _query, animes, details) => {
        Globals.animes.push({ animeId: 970001, animeTitle: '历史条目', links: null });
        const anime = {
          animeId: 970002, bangumiId: '970002', animeTitle: 'null-links(2026)【TV】from tencent',
          type: 'tvseries', typeDescription: 'TV', imageUrl: '', startDate: '2026-01-01',
          episodeCount: 1, rating: 0, isFavorited: true, source: 'tencent',
          links: [{ name: '第1集', title: '【qq】 第1集', url: 'https://v.qq.com/null-links-1' }]
        };
        assert.equal(cache.addAnime(anime, details), true);
        animes.push(anime);
      });
      try {
        const body = await (await request(env, '/api/v2/search/anime?keyword=null-links')).json();
        assert.equal(body.success, true);
        assert.equal(body.animes.length, 1);
        assert.equal(body.errorMessage, '');
        assert.equal(Globals.animes.length, 2);
      } finally { search.mock.restore(); handle.mock.restore(); }
    });
    await isolated('counter-only clear and later allocation preserve existing episode URLs', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      const links = [{ id: 12000, url: 'https://example.com/old', title: 'old' }];
      backend.set('animes', JSON.stringify([{ animeId: 1, links }])); backend.set('episodeIds', JSON.stringify(links)); backend.set('episodeNum', '50000');
      await fs.mkdir('.cache'); await initializePersistentCaches('node');
      const res = await handleClearCache({ json: async () => ({ items: ['episodeNum'] }) });
      assert.equal(res.status, 200); assert.equal((await res.json()).clearedItems.episodeNum, 12000);
      const next = cache.addEpisode('https://example.com/new', 'new');
      assert.equal(next.id, 12001); assert.equal(cache.findUrlById(12000), links[0].url);
      await cache.updateLocalCaches(); await local.updateLocalRedisCaches();
      assert.deepEqual((await storedFile('episodeIds')).map(x => x.id), [12000, 12001]);
      Globals.episodeIds = []; Globals.episodeNum = 10001;
      assert.equal(cache.addEpisode('https://example.com/another', 'another').id, 12001, 'remaining anime links reserve their IDs');
    });
    await isolated('partial clear protects unread keys; failed full clear reports failure and can retry', upstash, async () => {
      backend.set('episodeIds', '[{"id":12000,"url":"a"},{"id":12000,"url":"b"}]');
      backend.set('lastSelectMap', '{"saved":{"prefer":1}}');
      remote.set('favoriteCache', JSON.stringify({ saved: favorite() }));
      await initializePersistentCaches('node');
      const partial = await handleClearCache({ json: async () => ({ items: ['animes', 'episodeIds', 'episodeNum'] }) });
      assert.equal(partial.status, 200); assert.match((await partial.json()).message, /重启/);
      assert.equal(backend.get('episodeIds'), '[]'); assert.equal(backend.get('lastSelectMap'), '{"saved":{"prefer":1}}');
      assert.equal(Globals.queryCacheWritable.localRedis, false);
      failedWrite = 'animes';
      const clear = () => handleClearCache({ json: async () => ({ items: ['animes', 'episodeIds', 'episodeNum', 'lastSelectMap', 'requestHistory'] }) });
      const failed = await clear(); assert.equal(failed.status, 500);
      const failedBody = await failed.json();
      assert.deepEqual(failedBody.failedBackends, ['localRedis']);
      assert.match(failedBody.message, /重启后会重新加载/);
      assert.equal(Globals.queryCacheWritable.localRedis, false);
      failedWrite = null; assert.equal((await clear()).status, 200);
      assert.equal(Globals.queryCacheWritable.localRedis, true);
      assert.deepEqual(Object.keys(JSON.parse(remote.get('favoriteCache'))), ['saved']);
      Globals.animes = [{ animeId: 2 }]; assert.equal(await local.updateLocalRedisCaches(), true);
      assert.deepEqual(JSON.parse(backend.get('animes')), Globals.animes);
    });
    await isolated('unavailable Upstash does not block healthy Local Redis or later replace queries', upstash, async env => {
      upstashOffline = true; backend.set('animes', '[{"animeId":"redis"}]');
      assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
      assert.deepEqual(reads, ['animes', 'episodeIds', 'episodeNum', 'reqRecords', 'lastSelectMap', 'todayReqNum']);
      assert.equal((await request(env, '/api/v2/favorite/list')).status, 200);
      upstashOffline = false; remote.set('animes', '[{"animeId":"stale"}]');
      remote.set('favoriteCache', JSON.stringify({ saved: favorite() }));
      assert.equal((await request(env, '/api/v2/favorite/list')).status, 200);
      assert.equal(Globals.animes[0].animeId, 'redis');
    });
    await isolated('failed primary GET falls back to files without overwriting the failed backend', { LOCAL_CACHE_ENABLED: 'true' }, async env => {
      await file('animes', [{ animeId: 'saved-file' }]);
      backend.set('animes', '[{"animeId":"redis"}]'); failedRead = 'episodeIds';
      assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
      assert.equal(Globals.animes[0].animeId, 'saved-file'); assert.deepEqual(Globals.localRedisHashes, {});
      assert.equal((await local.setLocalRedisKey('animes', [])).result, 'ERROR');
      assert.equal((await local.setLocalRedisKeyWithExpiry('animes', [], 30)).result, 'ERROR');
      Globals.animes = [{ animeId: 'current' }];
      await local.updateLocalRedisCaches(); await cache.updateLocalCaches();
      assert.equal(writes.length, 0); assert.equal((await storedFile('animes'))[0].animeId, 'current');
      failedRead = null;
      assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
      assert.equal(Globals.animes[0].animeId, 'current');
      assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'redis');
    });
    await isolated('initial connection failure uses memory and retries connections after cooldown only', {}, async env => {
      const realNow = Date.now; let now = realNow();
      const clock = mock.method(Date, 'now', () => now);
      try {
        unavailable = true;
        assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
        assert.equal(clients.length, 1, 'validity check and recovery share the failed connection attempt');
        assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
        assert.equal(clients.length, 1, 'requests during cooldown do not connect');
        assert.ok(Globals.episodeNum >= now, 'degraded IDs do not start again at 10001');
        Globals.animes = [{ animeId: 'current' }];
        unavailable = false; backend.set('animes', '[{"animeId":"redis"}]'); now += 30001;
        assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
        assert.equal(clients.length, 2);
        await local.updateLocalRedisCaches();
        assert.equal(Globals.animes[0].animeId, 'current');
        assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'redis');
        assert.equal(writes.length, 0);
      } finally { clock.mock.restore(); }
    });
    await isolated('reconnect after successful restoration keeps current memory and resumes writes', {}, async () => {
      backend.set('animes', '[{"animeId":"redis"}]');
      await initializePersistentCaches('node');
      Globals.animes = [{ animeId: 'current' }]; clients.at(-1).destroy();
      const count = reads.length;
      await initializePersistentCaches('node'); await local.updateLocalRedisCaches();
      assert.equal(reads.length, count); assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'current');
    });
    await isolated('empty primary restores the next populated backend before allowing writes', { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'file' }]);
      remote.set('animes', '[{"animeId":"upstash"}]'); remote.set('episodeNum', '12000');
      await initializePersistentCaches('node');
      assert.equal(Globals.animes[0].animeId, 'upstash'); assert.equal(Globals.episodeNum, 12000);
      await local.updateLocalRedisCaches();
      assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'upstash');
    });
    await isolated('empty Redis retains the entire file snapshot including manual selection', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'file', links: [{ id: 12000, url: 'https://example.com/ep1' }] }]);
      await file('episodeIds', [{ id: 12000, url: 'https://example.com/ep1' }]);
      await file('episodeNum', 12000);
      const preference = { saved: { preferBySeason: { 1: 99 }, offsets: { 1: '2:第10集' }, explicitBySeason: { 1: true } } };
      await file('lastSelectMap', preference);
      await initializePersistentCaches('node');
      await persistFavorites(); await local.updateLocalRedisCaches();
      assert.equal((await storedFile('animes'))[0].animeId, 'file');
      assert.equal(await storedFile('episodeNum'), 12000);
      assert.deepEqual(await storedFile('lastSelectMap'), preference);
      assert.deepEqual(JSON.parse(backend.get('lastSelectMap')), preference);
    });
    for (const primary of ['localRedis', 'upstash']) {
      await isolated(primary + ' counter-only snapshot falls back without erasing files or manual preferences', { ...upstash, LOCAL_REDIS_URL: primary === 'localRedis' ? 'redis://mock' : '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
        const target = primary === 'localRedis' ? backend : remote;
        target.set('animes', '[]'); target.set('episodeIds', '[]'); target.set('episodeNum', '12000');
        const episodes = [{ id: 55000, url: 'https://example.com/saved', title: '第1集' }];
        const animes = [{ animeId: 1, links: episodes }];
        const preference = { saved: { preferBySeason: { 1: 1 }, explicitBySeason: { 1: true } } };
        await file('animes', animes); await file('episodeIds', episodes); await file('episodeNum', 55000); await file('lastSelectMap', preference);
        await initializePersistentCaches('node');
        assert.deepEqual(Globals.animes, animes); assert.deepEqual(Globals.episodeIds, episodes);
        assert.equal(Globals.episodeNum, 55000); assert.deepEqual(Object.fromEntries(Globals.lastSelectMap), preference);
        await cache.updateLocalCaches(); await redis.updateRedisCaches();
        if (primary === 'localRedis') await local.updateLocalRedisCaches();
        assert.deepEqual(await storedFile('animes'), animes); assert.equal(await storedFile('episodeNum'), 55000);
        assert.deepEqual(JSON.parse(target.get('animes')), animes);
      });
    }
    await isolated('complete primary retains episode mapping but respects larger secondary counters', { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
      const localEpisodes = [{ id: 12000, url: 'https://example.com/local', title: '第1集' }];
      backend.set('animes', JSON.stringify([{ animeId: 1, links: localEpisodes }]));
      backend.set('episodeIds', JSON.stringify(localEpisodes)); backend.set('episodeNum', '12000');
      remote.set('episodeNum', '40000'); await file('episodeNum', 55000);
      await file('animes', [{ animeId: 2, links: [{ id: 12000, url: 'https://example.com/file' }] }]);
      await initializePersistentCaches('node');
      assert.equal(cache.findUrlById(12000), 'https://example.com/local');
      assert.equal(Globals.episodeNum, 55000);
      const next = cache.addEpisode('https://example.com/new', '第2集'); assert.equal(next.id, 55001);
      await cache.updateLocalCaches(); await redis.updateRedisCaches(); await local.updateLocalRedisCaches();
      assert.equal(await storedFile('episodeNum'), 55001);
      assert.equal(remote.get('episodeNum'), '55001'); assert.equal(backend.get('episodeNum'), '55001');
    });
    await isolated('independent query keys fall back without replacing primary episode mappings', { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
      const links = [{ id: 12000, url: 'https://example.com/local', title: '第1集' }];
      const animes = [{ animeId: 1, links }];
      const preference = { saved: { preferBySeason: { 1: 1 }, explicitBySeason: { 1: true } } };
      const records = [{ path: '/api/v2/search/anime', time: 123 }];
      backend.set('animes', JSON.stringify(animes)); backend.set('episodeIds', JSON.stringify(links));
      backend.set('lastSelectMap', '{}'); backend.set('reqRecords', '[]'); backend.set('todayReqNum', '0');
      remote.set('lastSelectMap', JSON.stringify(preference));
      await file('animes', [{ animeId: 2, links: [{ id: 12000, url: 'https://example.com/file' }] }]);
      await file('lastSelectMap', { stale: { prefer: 2 } }); await file('reqRecords', records); await file('todayReqNum', 7);
      await initializePersistentCaches('node');
      assert.deepEqual(Globals.animes, animes); assert.deepEqual(Globals.episodeIds, links);
      assert.deepEqual(Object.fromEntries(Globals.lastSelectMap), preference);
      assert.deepEqual(Globals.reqRecords, records); assert.equal(Globals.todayReqNum, 7);
      await local.updateLocalRedisCaches();
      assert.deepEqual(JSON.parse(backend.get('lastSelectMap')), preference);
      assert.deepEqual(JSON.parse(backend.get('reqRecords')), records); assert.equal(backend.get('todayReqNum'), '7');
    });
    await isolated('index-only primary does not mix IDs with a complete file snapshot', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      backend.set('episodeIds', '[{"id":12000,"url":"https://example.com/old-primary"}]');
      backend.set('episodeNum', '60000');
      const links = [{ id: 12000, url: 'https://example.com/file', title: '第1集' }];
      await file('animes', [{ animeId: 1, links }]); await file('episodeIds', links); await file('episodeNum', 55000);
      await initializePersistentCaches('node');
      assert.equal(cache.findUrlById(12000), links[0].url); assert.equal(Globals.episodeNum, 60000);
    });
    await isolated('conflicting IDs within one snapshot are preserved without writeback', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      backend.set('animes', '[{"animeId":1,"links":[{"id":12000,"url":"https://example.com/a"}]}]');
      backend.set('episodeIds', '[{"id":12000,"url":"https://example.com/b"}]');
      await file('animes', [{ animeId: 2, links: [{ id: 55000, url: 'https://example.com/file' }] }]);
      await initializePersistentCaches('node');
      assert.equal(Globals.queryCacheWritable.localRedis, false);
      assert.equal(Globals.animes[0].animeId, 2);
      assert.equal(cache.findUrlById(55000), 'https://example.com/file');
      assert.equal(await local.updateLocalRedisCaches(), false); assert.equal(writes.length, 0);
    });
    await isolated('without Local Redis, files or Upstash restore their own queries and favorites', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'file' }]); await file('favoritesCache', { saved: favorite() });
      await initializePersistentCaches('node');
      assert.equal(Globals.animes[0].animeId, 'file'); assert.ok(Globals.favoriteCache.has('saved'));
      Globals.favoriteCache.delete('saved'); await persistFavorites();
      assert.deepEqual(await storedFile('favoritesCache'), {});
      Globals.queryCacheInitialized = false; Globals.queryCacheWritable = {}; Globals.favoriteCacheWritable = {};
      Globals.envs.redisUrl = upstash.UPSTASH_REDIS_REST_URL; Globals.envs.redisToken = 'mock'; Globals.redisValid = true;
      remote.set('animes', '[{"animeId":"upstash"}]');
      await initializePersistentCaches('node');
      assert.equal(Globals.animes[0].animeId, 'upstash');
    });
    await isolated('Upstash partial read uses memory but protects the unread snapshot', { LOCAL_REDIS_URL: '', ...upstash }, async () => {
      const partial = mock.method(globalThis, 'fetch', async () => Response.json([{ result: '[]' }]));
      try {
        assert.equal(await initializePersistentCaches('node'), true);
        assert.equal(Globals.queryCacheWritable.upstash, false);
        assert.equal((await redis.setRedisKey('animes', [])).result, 'ERROR');
      } finally { partial.mock.restore(); }
      await initializePersistentCaches('node');
      assert.equal((await redis.setRedisKeyWithExpiry('animes', [], 30)).result, 'ERROR');
    });
    await isolated('Upstash partial writes retry failed keys', { LOCAL_REDIS_URL: '', ...upstash }, async () => {
      await initializePersistentCaches('node');
      Globals.animes = [{ animeId: 'new' }];
      const failure = mock.method(globalThis, 'fetch', async (_url, opts) => Response.json(JSON.parse(opts.body).map((_, i) => i ? { result: 'OK' } : { error: 'failed' })));
      try { assert.equal(await redis.updateRedisCaches(), false); assert.equal(Globals.upstashHashes.animes, undefined); }
      finally { failure.mock.restore(); }
      remoteCommands = []; await redis.updateRedisCaches();
      assert.deepEqual(remoteCommands.map(command => command[1]), ['animes']);
      const error = mock.method(globalThis, 'fetch', async () => Response.json({ error: 'failed' }, { status: 503 }));
      try {
        assert.equal((await redis.setRedisKey('animes', [])).result, 'ERROR');
        assert.equal((await redis.setRedisKeyWithExpiry('animes', [], 30)).result, 'ERROR');
      } finally { error.mock.restore(); }
    });
    await isolated('memory-only startup cannot import files when they are enabled later', { LOCAL_REDIS_URL: '' }, async () => {
      await file('animes', [{ animeId: 'stale' }]);
      await initializePersistentCaches('node'); Globals.animes = [{ animeId: 'current' }];
      Globals.envs.localCacheEnabled = true;
      await initializePersistentCaches('node');
      assert.equal(Globals.animes[0].animeId, 'current');
    });
    await isolated('disabling files during an update does not mark unwritten values as saved', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'old' }]);
      await initializePersistentCaches('node');
      Globals.animes = [{ animeId: 'current' }];
      const pending = cache.updateLocalCaches();
      Globals.envs.localCacheEnabled = false;
      await pending;
      assert.notEqual(Globals.localFileHashes.animes, undefined);
      assert.equal((await storedFile('animes'))[0].animeId, 'old');
      Globals.envs.localCacheEnabled = true;
      await cache.updateLocalCaches();
      assert.equal((await storedFile('animes'))[0].animeId, 'current');
    });
    await isolated('all query routes remain usable with an unavailable primary and an existing cache directory', { LOCAL_CACHE_ENABLED: 'true' }, async env => {
      await fs.mkdir('.cache'); unavailable = true;
      const { default: TencentSource } = await import(base + 'sources/tencent.js');
      const search = mock.method(TencentSource.prototype, 'search', async () => []);
      try {
        assert.equal((await request(env, '/api/v2/search/anime?keyword=test')).status, 200);
        const match = await handleRequest(new Request('http://localhost/api/v2/match', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'test S01E01' })
        }), env, 'node', '127.0.0.1');
        assert.equal(match.status, 200);
        assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
        assert.notEqual((await request(env, '/danmaku?name=test&episode=1')).status, 503);
        assert.equal(clients.length, 1);
      } finally { search.mock.restore(); }
    });
    await isolated('corrupt auxiliary file is backed up without blocking healthy query data', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async env => {
      await file('animes', [{ animeId: 'saved' }]);
      await fs.writeFile('.cache/reqRecords', 'broken json');
      assert.equal((await request(env, '/api/v2/comment/999')).status, 404);
      assert.equal(Globals.animes[0].animeId, 'saved');
      assert.equal(Globals.queryCacheWritable.file, true);
      await cache.updateLocalCaches();
      assert.ok(Array.isArray(await storedFile('reqRecords')));
      const backups = (await fs.readdir('.cache')).filter(name => name.startsWith('reqRecords.bak-'));
      assert.equal(backups.length, 1);
      assert.equal(await fs.readFile('.cache/' + backups[0], 'utf8'), 'broken json');
    });
    await isolated('corrupt core file preserves its backup and healthy ID mappings', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('episodeIds', [{ id: 12000, url: 'https://example.com/old', title: '第1集' }]);
      await fs.writeFile('.cache/animes', 'broken json');
      await initializePersistentCaches('node');
      const next = cache.addEpisode('https://example.com/new', '第2集');
      assert.ok(next.id > 12000);
      assert.equal(cache.findUrlById(12000), 'https://example.com/old');
      await cache.updateLocalCaches();
      const backup = (await fs.readdir('.cache')).find(name => name.startsWith('animes.bak-'));
      assert.equal(await fs.readFile('.cache/' + backup, 'utf8'), 'broken json');
    });
    for (const counter of [null, 10001]) {
      await isolated('restored episode counter is repaired when ' + (counter === null ? 'missing' : 'behind'), {}, async () => {
        backend.set('episodeIds', '[{"id":12000,"url":"https://example.com/old","title":"第1集"}]');
        backend.set('animes', '[{"animeId":1,"links":[{"id":13000,"url":"https://example.com/detail"}]}]');
        if (counter !== null) backend.set('episodeNum', String(counter));
        await initializePersistentCaches('node');
        assert.equal(Globals.episodeNum, 13000);
        const next = cache.addEpisode('https://example.com/new', '第2集');
        assert.equal(next.id, 13001);
        assert.equal(cache.findUrlById(next.id), 'https://example.com/new');
        assert.equal(cache.findUrlById(12000), 'https://example.com/old');
        await local.updateLocalRedisCaches();
        assert.equal(backend.get('episodeNum'), '13001');
      });
    }
    await isolated('atomic replacement failure leaves the old file and hash intact', { LOCAL_REDIS_URL: '', LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'old' }]);
      await initializePersistentCaches('node');
      const before = await fs.readFile('.cache/animes', 'utf8');
      assert.equal(cache.writeCacheToFile('animes', JSON.stringify(Globals.animes)), true);
      const hash = Globals.localFileHashes.animes;
      Globals.animes = [{ animeId: 'new' }];
      const syncFs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const fail = mock.method(syncFs, 'renameSync', () => { throw new Error('rename failed'); });
      syncBuiltinESMExports();
      try { assert.equal(await cache.updateLocalCaches(), false); }
      finally { fail.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(await fs.readFile('.cache/animes', 'utf8'), before);
      assert.equal(Globals.localFileHashes.animes, hash);
      assert.equal((await fs.readdir('.cache')).some(name => name.includes('.tmp-')), false);
      await cache.updateLocalCaches();
      assert.equal((await storedFile('animes'))[0].animeId, 'new');
      const backup = (await fs.readdir('.cache')).find(name => name.startsWith('animes.bak-'));
      assert.equal(await fs.readFile('.cache/' + backup, 'utf8'), before);
    });
    await isolated('backup failure prevents overwriting an existing file snapshot', { LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('animes', [{ animeId: 'file' }]);
      backend.set('animes', '[{"animeId":"redis"}]');
      await initializePersistentCaches('node');
      const syncFs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const fail = mock.method(syncFs, 'copyFileSync', () => { throw new Error('disk full'); });
      syncBuiltinESMExports();
      try {
        assert.equal(await cache.updateLocalCaches(), false);
        assert.equal(await cache.updateLocalCaches(), false);
        assert.equal(fail.mock.callCount(), 1, 'backup failures are cooled down');
      } finally { fail.mock.restore(); syncBuiltinESMExports(); }
      assert.equal((await storedFile('animes'))[0].animeId, 'file');
      const now = Date.now(); const clock = mock.method(Date, 'now', () => now + 30001);
      try { await cache.updateLocalCaches(); } finally { clock.mock.restore(); }
      assert.equal((await storedFile('animes'))[0].animeId, 'redis');
    });
    await isolated('changing Redis URLs keeps current memory and rechecks each destination', upstash, async env => {
      backend.set('animes', '[{"animeId":"initial"}]');
      await request(env, '/api/config');
      Globals.animes = [{ animeId: 'current' }];
      backend = new Map([['animes', '[{"animeId":"new-local-old-data"}]']]);
      remote = new Map([['animes', '[{"animeId":"new-upstash-old-data"}]']]);
      await request({ ...env, LOCAL_REDIS_URL: 'redis://second', UPSTASH_REDIS_REST_URL: 'https://second.invalid' }, '/api/config');
      assert.equal(Globals.animes[0].animeId, 'current');
      await local.updateLocalRedisCaches(); await redis.updateRedisCaches();
      assert.equal(JSON.parse(backend.get('animes'))[0].animeId, 'current');
      assert.equal(JSON.parse(remote.get('animes'))[0].animeId, 'current');
    });
    for (const failure of ['data', 'read-index', 'write-index']) {
      await isolated('cloud upload reports ' + failure + ' failure and retries without a false success', { LOCAL_REDIS_URL: '', ...upstash }, async () => {
        Globals.deployPlatform = 'vercel';
        const calls = []; let fail = true;
        const fetch = mock.method(globalThis, 'fetch', async url => {
          const command = new URL(url).pathname; calls.push(command);
          if (fail && (failure === 'data' && command.startsWith('/set/localDanmu:data:')
            || failure === 'read-index' && command === '/get/localDanmu:index'
            || failure === 'write-index' && command === '/set/localDanmu:index')) return Response.json({ error: 'failed' }, { status: 500 });
          return Response.json({ result: command.startsWith('/get/') ? null : 'OK' });
        });
        try {
          const resource = { resourceKey: 'test-upload', title: 'test', comments: [] };
          await assert.rejects(store.saveLocalDanmu(resource), /失败/);
          if (failure === 'data') assert.deepEqual(calls, ['/set/localDanmu:data:test-upload']);
          if (failure === 'read-index') assert.equal(calls.includes('/set/localDanmu:index'), false);
          fail = false;
          assert.deepEqual(await store.saveLocalDanmu(resource), resource);
          assert.equal(calls.at(-1), '/set/localDanmu:index');
        } finally { fetch.mock.restore(); }
      });
    }
    await isolated('file favorites remain available when Upstash has no favorite key', { ...upstash, LOCAL_CACHE_ENABLED: 'true' }, async () => {
      await file('favoritesCache', { saved: favorite() });
      await initializePersistentCaches('node');
      assert.ok(Globals.favoriteCache.has('saved'));
      assert.equal(await redis.getFavoriteCachesFromRedis(), true);
      assert.ok(Globals.favoriteCache.has('saved'), 'missing Upstash key retains the existing favorite snapshot');
      const req = () => new Request('http://localhost', { method: 'POST', body: JSON.stringify({ keyword: 'saved' }) });
      assert.equal((await handleFavoriteRemove(req())).status, 200);
      assert.equal((await handleFavoriteRemove(req())).status, 404, 'legacy missing favorite response is preserved');
      assert.equal(backend.has('favoriteCache'), false);
    });
  `;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_TEST_CONTEXT: '' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
async function checkLocalRedisTimeout(scenario) {
  const base = new URL('../../', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import http from 'node:http';
    import fs from 'node:fs/promises';
    import { mock } from 'node:test';
    const { handleRequest } = await import(${JSON.stringify(base + 'worker.js')});
    const { Globals } = await import(${JSON.stringify(base + 'configs/globals.js')});
    const local = await import(${JSON.stringify(base + 'utils/local-redis-util.js')});
    const { handleClearCache } = await import(${JSON.stringify(base + 'apis/system-api.js')});
    const scenario = ${JSON.stringify(scenario)};
    const clearing = scenario.startsWith('clear-');
    const writing = scenario === 'write';
    // 生产预算（业务命令 30s、握手 5s、批量/清理 5s、Upstash 5s）仅在测试中钳制到 1200ms，
    // 避免每个故障场景等待数秒；budgets 记录原始值，断言仍验证 deadline 真实流逝且有上界。
    const budgets = []; const realTimeout = globalThis.setTimeout;
    mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      budgets.push(ms); return realTimeout(fn, ms > 1200 ? 1200 : ms, ...args);
    });
    const realSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
    mock.method(AbortSignal, 'timeout', ms => realSignalTimeout(ms > 1200 ? 1200 : ms));
    let stalled = !writing; let recovered = false;
    const sockets = new Set(); let connections = 0;
    const server = net.createServer(socket => {
      connections++; sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      let pending = '';
      socket.on('data', chunk => {
        pending += chunk.toString();
        // 测试命令参数不含原始 CR/LF；按 RESP 数组长度处理分片和合并的 TCP 数据。
        while (pending) {
          const fields = pending.split('\\r\\n'); const count = Number(fields[0].slice(1));
          if (fields.length < count * 2 + 2) break;
          const command = fields[2]; pending = fields.slice(count * 2 + 1).join('\\r\\n');
          if (!recovered && scenario.endsWith('handshake')) continue;
          if (command === 'CLIENT' && scenario === 'clear-write') setTimeout(() => socket.write('+OK\\r\\n'), 600); // 慢握手须仍快于钳制后的 1200ms 命令预算
          else if (command === 'CLIENT' || command === 'QUIT') socket.write('+OK\\r\\n');
          else if (command === 'PING') socket.write('+PONG\\r\\n');
          else if (!stalled) socket.write(command === 'GET' ? '$-1\\r\\n' : '+OK\\r\\n');
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { LOCAL_REDIS_URL: 'redis://127.0.0.1:' + server.address().port,
      LOCAL_CACHE_ENABLED: String(scenario === 'read'), LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0' };
    const request = () => handleRequest(new Request('http://localhost/api/config'), env, 'node', '127.0.0.1');
    let upstashServer;
    await (async () => {
    try {
      if (scenario === 'read') {
        await fs.mkdir('.cache');
        await fs.writeFile('.cache/animes', JSON.stringify(JSON.stringify([{ animeId: 7001 }])));
      }
      if (writing) {
        assert.equal((await request()).status, 200);
        Globals.animes = [{ animeId: 7001 }]; stalled = true;
      }
      if (clearing) {
        upstashServer = http.createServer(req => req.resume()); // 接收请求，但不回应 HTTP。
        await new Promise(resolve => upstashServer.listen(0, '127.0.0.1', resolve));
        Globals.init({ ...env, UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + upstashServer.address().port, UPSTASH_REDIS_REST_TOKEN: 'test' });
        Globals.deployPlatform = 'node'; Globals.animes = [{ animeId: 7001 }];
        Globals.queryCacheWritable = { upstash: false, localRedis: false };
        const hashes = { ...Globals.localRedisHashes }; const start = performance.now();
        const response = await handleClearCache({ json: async () => ({ items: ['animes', 'episodeIds', 'episodeNum', 'lastSelectMap', 'requestHistory'] }) });
        const elapsedMs = performance.now() - start; const body = await response.json();
        assert.equal(response.status, 500); assert.equal(body.success, false);
        assert.deepEqual(body.failedBackends, ['upstash', 'localRedis']);
        assert.deepEqual(Globals.animes, []); assert.match(body.message, /内存已清理/);
        assert.deepEqual(Globals.localRedisHashes, hashes); assert.deepEqual(Globals.upstashHashes, {});
        assert.deepEqual(Globals.queryCacheWritable, { upstash: false, localRedis: false });
        assert.ok(elapsedMs >= 1000 && elapsedMs < 4000, 'clear includes connection time: ' + elapsedMs + 'ms');
        if (scenario === 'clear-write') assert.ok(budgets.some(ms => ms > 3500 && ms < 4900), 'remaining budget subtracts connection time: ' + budgets.join(','));
        console.log(JSON.stringify({ clearMs: Math.round(elapsedMs), scenario }));
        return;
      }
      const hashes = { ...Globals.localRedisHashes };
      const start = performance.now();
      if (scenario === 'write') {
        const results = await Promise.all([
          local.updateLocalRedisCaches(), local.setLocalRedisKeyWithExpiry('timeoutProbe', 1, 60),
          local.getLocalRedisKey('timeoutProbe').then(() => false, () => true)
        ]);
        assert.deepEqual(results, [false, { result: 'ERROR' }, true]);
        assert.ok(budgets.includes(30000));
      } else {
        const responses = await Promise.all([request(), request()]);
        assert.ok(responses.every(response => response.status === 200));
      }
      const first = performance.now() - start;
      assert.ok(first >= 1000 && first < 4000, 'first request: ' + first + 'ms');
      assert.deepEqual(Globals.localRedisHashes, hashes, 'failed commands never advance hashes');
      assert.equal(Globals.localRedisValid, false);
      if (scenario === 'read') assert.equal(Globals.animes[0].animeId, 7001, 'healthy files restore after GET timeout');
      const next = performance.now();
      assert.equal((await request()).status, 200);
      if (scenario === 'write') assert.equal(await local.updateLocalRedisCaches(), false);
      const second = performance.now() - next;
      assert.ok(second < 1500, 'cooldown request: ' + second + 'ms');
      assert.equal(connections, 1);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(sockets.size, 0, 'timed-out connection closes before test cleanup');
      recovered = true; stalled = false;
      const realNow = Date.now; mock.method(Date, 'now', () => realNow() + 30001);
      assert.equal((await request()).status, 200); assert.equal(connections, 2);
      if (scenario !== 'handshake') assert.equal(Globals.animes[0].animeId, 7001, 'reconnection keeps current memory');
      if (scenario === 'write') {
        assert.equal(await local.updateLocalRedisCaches(), true);
        assert.notEqual(Globals.localRedisHashes.animes, hashes.animes);
      }
      console.log(JSON.stringify({ firstMs: Math.round(first), secondMs: Math.round(second), connections }));
    } finally {
      if (upstashServer) { upstashServer.closeAllConnections(); await new Promise(resolve => upstashServer.close(resolve)); }
      await local.closeLocalRedisConnection();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
    })();
  `;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-redis-timeout-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, encoding: 'utf8', timeout: 14000, maxBuffer: 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const timing = result.stdout.split('\n').find(line => line.startsWith('{"firstMs"') || line.startsWith('{"clearMs"'));
    if (timing) console.log('Redis ' + scenario + ' timing: ' + timing);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
for (const scenario of ['handshake', 'read', 'write', 'clear-handshake', 'clear-write']) {
  test(`Local Redis ${scenario} timeout is bounded and subsequent requests observe cooldown`, () => checkLocalRedisTimeout(scenario));
}
