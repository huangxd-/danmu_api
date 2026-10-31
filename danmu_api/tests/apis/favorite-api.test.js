// 收藏接口：缓存、增删查、刷新与鉴权
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { matchAnime, searchAnime } from '../../apis/dandan-api.js';
import { handleFavoriteRefresh } from '../../apis/favorite-api.js';
import { Globals } from '../../configs/globals.js';
import TencentSource from '../../sources/tencent.js';
import { getSearchCache, isSearchCacheValid, setSearchCache } from '../../utils/cache-util.js';
import { addFavorite, listFavorites, loadFavorites, removeFavorite, resolveFavoriteForKeyword, saveFavorites } from '../../utils/favorite-util.js';
import { getRedisCaches, updateRedisCaches } from '../../utils/redis-util.js';
import { handleRequest } from '../../worker.js';
import { parseResponse, token, withMockFetch } from '../helpers/context.js';
import { createFavoriteAnime, favoriteSearchResult, resetFavoriteState } from '../helpers/favorites.js';

test('Upstash Redis persists favorites without storing search or comment caches', async () => {
    resetFavoriteState({
      UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
      LOG_LEVEL: 'error'
    });
    Globals.redisValid = true;
    Globals.redisCacheInitialized = false;
    Globals.upstashHashes = {
      animes: null,
      episodeIds: null,
      episodeNum: null,
      lastSelectMap: null,
      reqRecords: null,
      todayReqNum: null,
      favoriteCache: null
    };

    const anime = createFavoriteAnime('Redis cache test');
    Globals.searchCache.set('Redis search', {
      results: [favoriteSearchResult(anime)],
      details: [anime],
      timestamp: Date.now()
    });
    Globals.commentCache.set('https://example.com/video', {
      comments: [{ p: '1,1,16777215,test', m: 'cached' }],
      timestamp: Date.now()
    });
    addFavorite('Redis favorite', [favoriteSearchResult(anime)], [anime]);
    Globals.favoriteCache.get('Redis favorite').timestamp = Date.now() - 24 * 60 * 60 * 1000;
    Globals.lastSelectMap.set('Redis preference', {
      animeIds: [anime.animeId],
      preferBySeason: { 1: anime.animeId },
      sourceBySeason: { 1: 'tencent' },
      explicitBySeason: { 1: true }
    });

    const redisData = new Map();
    const redisCommands = [];
    await withMockFetch(async (_url, options) => {
      const commands = JSON.parse(options.body);
      redisCommands.push(...commands);
      return {
        ok: true,
        json: async () => commands.map(command => {
          if (command[0] === 'SET') {
            redisData.set(command[1], command[2]);
            return { result: 'OK' };
          }
          return { result: redisData.get(command[1]) ?? null };
        })
      };
    }, async () => {
      assert.equal(await getRedisCaches(), true);
      Globals.queryCacheInitialized = true;
      await updateRedisCaches();
      assert.ok(redisData.has('favoriteCache'));
      assert.equal(redisData.has('searchCache'), false);
      assert.equal(redisData.has('commentCache'), false);

      Globals.searchCache = new Map();
      Globals.commentCache = new Map();
      Globals.favoriteCache = new Map();
      Globals.redisCacheInitialized = false;
      Globals.queryCacheInitialized = false;
      Globals.queryCacheWritable = {}; Globals.favoriteCacheWritable = {};
      await getRedisCaches();
    });

    assert.equal(Globals.searchCache.size, 0);
    assert.equal(Globals.commentCache.size, 0);
    assert.equal(redisCommands.some(command => command[1] === 'searchCache'), false);
    assert.equal(redisCommands.some(command => command[1] === 'commentCache'), false);
    assert.equal(resolveFavoriteForKeyword('Redis favorite')?.entry.results[0].animeId, anime.animeId);
    assert.equal(getSearchCache('Redis favorite')[0].animeId, anime.animeId);
    assert.equal(Globals.lastSelectMap.get('Redis preference').explicitBySeason['1'], true);

    Globals.redisValid = false;
  });
test('favorite cache', async t => {
    await t.test('add/list/remove and serialization round trip', () => {
      resetFavoriteState();
      const anime = createFavoriteAnime();
      const entry = addFavorite('收藏测试_S1', [favoriteSearchResult(anime)], [anime]);

      assert.equal(entry.results.length, 1);
      assert.equal(Globals.favoriteCache.size, 1);
      assert.equal(listFavorites()[0].episodeCount, 2);
      assert.equal(listFavorites()[0].lastRefreshAt, entry.lastRefreshAt);
      assert.equal(resolveFavoriteForKeyword('收藏测试剧场版')?.entry, entry);

      const snapshot = saveFavorites();
      Globals.favoriteCache = new Map();
      loadFavorites(JSON.stringify(snapshot));
      assert.deepEqual(saveFavorites(), snapshot);
      assert.equal(removeFavorite('收藏测试 第二季'), true);
      assert.equal(Globals.favoriteCache.size, 0);
    });

    await t.test('favorite entries ignore search TTL, sweep, and count limits', () => {
      resetFavoriteState({ SEARCH_CACHE_MINUTES: '1', LOG_LEVEL: 'error' });
      const anime = createFavoriteAnime();
      const oldTimestamp = Date.now() - 24 * 60 * 60 * 1000;
      addFavorite('收藏测试', [favoriteSearchResult(anime)], [anime]);
      Globals.favoriteCache.get('收藏测试').timestamp = oldTimestamp;
      Globals.searchCache.set('收藏测试', { results: [], details: [], timestamp: oldTimestamp });
      Globals.searchCache.set('普通过期缓存', { results: [], details: [], timestamp: oldTimestamp });

      setSearchCache('新缓存', [], new Map());

      assert.equal(isSearchCacheValid('收藏测试_S9'), true);
      assert.equal(getSearchCache('收藏测试_S9')[0].animeId, anime.animeId);
      assert.equal(Globals.favoriteCache.has('收藏测试'), true);
      assert.equal(Globals.searchCache.has('收藏测试'), true);
      assert.equal(Globals.searchCache.has('普通过期缓存'), false);

      for (let index = 0; index < 510; index++) addFavorite(`无限收藏${index}`, [], []);
      assert.equal(Globals.favoriteCache.size, 511);
    });

    await t.test('search and match short-circuit external sources and expose isFavorite', async () => {
      resetFavoriteState();
      const anime = createFavoriteAnime();
      addFavorite('收藏测试', [favoriteSearchResult(anime)], [anime]);
      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetchCount++;
        throw new Error('favorite hit must not use fetch');
      };

      try {
        const searchResponse = await searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=收藏测试&season=1&episode=2'));
        const searchBody = await parseResponse(searchResponse);
        assert.equal(searchBody.animes[0].animeId, anime.animeId);

        const request = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '收藏测试 S01E02' })
        });
        const matchBody = await parseResponse(await matchAnime(new URL(request.url), request, '127.0.0.1'));
        assert.equal(matchBody.isMatched, true);
        assert.equal(matchBody.matches[0].episodeId, anime.links[1].id);
        assert.equal(matchBody.matches[0].isFavorite, true);
        assert.equal(fetchCount, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await t.test('partial search keyword does not reuse a longer favorite title', async () => {
      resetFavoriteState();
      const favoriteAnime = createFavoriteAnime('火影忍者', 2, 910011);
      const searchAnimeResult = createFavoriteAnime('忍者战士飞影', 2, 910012);
      addFavorite('火影忍者', [favoriteSearchResult(favoriteAnime)], [favoriteAnime]);
      Globals.searchCache.set('忍者', {
        results: [favoriteSearchResult(searchAnimeResult)],
        details: [searchAnimeResult],
        timestamp: Date.now()
      });

      assert.equal(getSearchCache('火影忍者_S1')[0].animeId, favoriteAnime.animeId);
      assert.equal(getSearchCache('忍者')[0].animeId, searchAnimeResult.animeId);

      const response = await searchAnime(new URL('http://localhost/api/v2/search/anime?keyword=忍者'));
      const body = await parseResponse(response);
      assert.equal(body.animes[0].animeId, searchAnimeResult.animeId);
    });

    await t.test('favorite API add/list/remove follows token path normalization', async () => {
      resetFavoriteState();
      const anime = createFavoriteAnime('路由收藏测试');
      Globals.searchCache.set('路由收藏测试_S1', {
        results: [favoriteSearchResult(anime)],
        details: [anime],
        timestamp: Date.now()
      });

      const defaultTokenResponse = await handleRequest(
        new Request('http://localhost/api/v2/favorite/list'),
        {}, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(defaultTokenResponse.status, 200);

      const customTokenEnv = { TOKEN: 'favorite-user-token' };
      const publicListResponse = await handleRequest(
        new Request('http://localhost/api/v2/favorite/list'),
        customTokenEnv, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(publicListResponse.status, 200);

      const unauthorizedResponse = await handleRequest(
        new Request('http://localhost/api/v2/favorite/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keyword: '路由收藏测试' })
        }),
        customTokenEnv, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(unauthorizedResponse.status, 401);

      const addResponse = await handleRequest(new Request('http://localhost/api/v2/favorite/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: '路由收藏测试 S01E01' })
      }), {}, 'cloudflare', '127.0.0.1', {});
      assert.equal(addResponse.status, 200);
      assert.equal((await parseResponse(addResponse)).isFavorite, true);

      const listResponse = await handleRequest(
        new Request('http://localhost/87654321/api/favorite/list'),
        {}, 'cloudflare', '127.0.0.1', {}
      );
      const listBody = await parseResponse(listResponse);
      assert.equal(listBody.favorites.length, 1);
      assert.equal(listBody.favorites[0].animeTitle, '路由收藏测试');

      const removeResponse = await handleRequest(new Request('http://localhost/87654321/api/favorite/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyword: listBody.favorites[0].keyword })
      }), {}, 'cloudflare', '127.0.0.1', {});
      assert.equal(removeResponse.status, 200);
      assert.equal(Globals.favoriteCache.size, 0);
      assert.equal(Globals.searchCache.has('路由收藏测试_S1'), false);
    });

    await t.test('favorite API can require ADMIN_TOKEN', async () => {
      const env = {
        TOKEN: '87654321',
        ADMIN_TOKEN: 'favorite-admin-token',
        FAVORITE_REQUIRE_ADMIN: 'true'
      };
      resetFavoriteState(env);

      const publicListResponse = await handleRequest(
        new Request('http://localhost/api/v2/favorite/list'),
        env, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(publicListResponse.status, 200);

      const userResponse = await handleRequest(
        new Request('http://localhost/87654321/api/v2/favorite/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keyword: '权限测试' })
        }),
        env, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(userResponse.status, 403);
      assert.equal((await parseResponse(userResponse)).message, '权限不足');

      const adminResponse = await handleRequest(
        new Request('http://localhost/favorite-admin-token/api/v2/favorite/list'),
        env, 'cloudflare', '127.0.0.1', {}
      );
      assert.equal(adminResponse.status, 200);
      assert.deepEqual((await parseResponse(adminResponse)).favorites, []);
    });

    await t.test('manual favorite keeps the search keyword and uses the first result image', async () => {
      resetFavoriteState();
      const anime = createFavoriteAnime('火影忍者 疾风传', 720, 915001);
      Globals.searchCache.set('火影忍者', {
        results: [favoriteSearchResult(anime)],
        details: [anime],
        timestamp: Date.now()
      });

      const addResponse = await handleRequest(new Request('http://localhost/api/v2/favorite/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keyword: '火影忍者' })
      }), {}, 'cloudflare', '127.0.0.1', {});
      const addBody = await parseResponse(addResponse);
      assert.equal(addResponse.status, 200);
      assert.equal(addBody.keyword, '火影忍者');
      assert.equal(addBody.animeTitle, '火影忍者');
      assert.equal(addBody.imageUrl, anime.imageUrl);

      const listBody = await parseResponse(await handleRequest(
        new Request('http://localhost/api/v2/favorite/list'),
        {}, 'cloudflare', '127.0.0.1', {}
      ));
      assert.equal(listBody.favorites[0].keyword, '火影忍者');
      assert.equal(listBody.favorites[0].animeTitle, '火影忍者');
      assert.equal(listBody.favorites[0].imageUrl, anime.imageUrl);
      assert.equal(listBody.favorites[0].resultsCount, 1);
    });

    await t.test('refresh always performs a new source search and rebuilds the favorite', async () => {
      resetFavoriteState();
      const oldAnime = createFavoriteAnime('刷新测试', 1, 920001);
      const refreshedAnime = createFavoriteAnime('刷新测试', 3, 920002);
      const originalTimestamp = Date.now() - 60_000;
      const favorite = addFavorite('刷新测试', [favoriteSearchResult(oldAnime)], [oldAnime]);
      favorite.timestamp = originalTimestamp;
      favorite.lastRefreshAt = originalTimestamp;

      const originalSearch = TencentSource.prototype.search;
      const originalHandleAnimes = TencentSource.prototype.handleAnimes;
      const originalOrder = Globals.envs.sourceOrderArr;
      let searchCount = 0;
      TencentSource.prototype.search = async () => {
        searchCount++;
        return [{}];
      };
      TencentSource.prototype.handleAnimes = async (_source, _title, results, details) => {
        results.push(refreshedAnime);
        details.set(String(refreshedAnime.animeId), refreshedAnime);
      };
      Globals.envs.sourceOrderArr = ['tencent'];

      try {
        const refreshRequest = new Request('http://localhost/api/v2/favorite/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keyword: '刷新测试' })
        });
        const refreshResponse = await handleFavoriteRefresh(refreshRequest, new URL(refreshRequest.url));
        assert.equal(refreshResponse.status, 200);
        assert.equal(searchCount, 1);
        assert.equal(resolveFavoriteForKeyword('刷新测试').entry.results[0].animeId, refreshedAnime.animeId);
        assert.equal(resolveFavoriteForKeyword('刷新测试').entry.details[0].links.length, 3);
        assert.equal(resolveFavoriteForKeyword('刷新测试').entry.timestamp, originalTimestamp);
        assert.ok(resolveFavoriteForKeyword('刷新测试').entry.lastRefreshAt > originalTimestamp);
        assert.equal(listFavorites()[0].lastRefreshAt, resolveFavoriteForKeyword('刷新测试').entry.lastRefreshAt);
      } finally {
        TencentSource.prototype.search = originalSearch;
        TencentSource.prototype.handleAnimes = originalHandleAnimes;
        Globals.envs.sourceOrderArr = originalOrder;
      }
    });

});
