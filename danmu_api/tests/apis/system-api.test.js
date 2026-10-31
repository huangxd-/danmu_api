// 系统接口：缓存清理与日志文本输出
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleClearCache, handleLogs } from '../../apis/system-api.js';
import { Globals } from '../../configs/globals.js';
import { addFavorite, resolveFavoriteForKeyword } from '../../utils/favorite-util.js';
import { parseResponse } from '../helpers/context.js';
import { createFavoriteAnime, favoriteSearchResult, resetFavoriteState } from '../helpers/favorites.js';

// 本文件多条用例会触发全量清理，其中「清理 Bangumi-Data」会 unlink 磁盘缓存
// .cache/bangumi-data-cache.json —— 该文件只能联网重新下载（约 4MB），不能让它被测试删掉。
// 因此在本文件范围内备份该文件，跑完恢复（原本不存在则保持不存在）。
const BANGUMI_CACHE_PATH = path.join(process.cwd(), '.cache', 'bangumi-data-cache.json');
const bangumiCacheBackup = { hadCache: false, data: null };

test.before(async () => {
  bangumiCacheBackup.hadCache = await fs.access(BANGUMI_CACHE_PATH).then(() => true, () => false);
  if (bangumiCacheBackup.hadCache) bangumiCacheBackup.data = await fs.readFile(BANGUMI_CACHE_PATH);
});

test.after(async () => {
  if (bangumiCacheBackup.hadCache) {
    await fs.mkdir(path.dirname(BANGUMI_CACHE_PATH), { recursive: true });
    await fs.writeFile(BANGUMI_CACHE_PATH, bangumiCacheBackup.data);
  } else {
    await fs.rm(BANGUMI_CACHE_PATH, { force: true });
  }
});

test('clearing runtime caches preserves favorites and auto match mapping configuration', async () => {
    resetFavoriteState({
      AUTO_MATCH_MAPPING_TABLE: '火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59',
      LOG_LEVEL: 'error'
    });
    // 全量清理会走到 bangumiData 清理分支，该开关打开时清理后还会触发一次真实后台下载；
    // 这里关闭它，磁盘缓存本身的删除副作用由本文件顶部的 before/after 备份恢复兜住。
    Globals.useBangumiData = false;
    const anime = createFavoriteAnime('火影忍者');
    addFavorite('火影忍者', [favoriteSearchResult(anime)], [anime]);
    Globals.lastSelectMap.set('火影忍者', {
      animeIds: [anime.animeId],
      preferBySeason: { 1: anime.animeId },
      sourceBySeason: { 1: 'tencent' },
      explicitBySeason: { 1: true }
    });

    const response = await handleClearCache();
    const body = await parseResponse(response);
    assert.equal(body.success, true);
    assert.equal(Globals.lastSelectMap.size, 0);
    assert.equal(resolveFavoriteForKeyword('火影忍者')?.entry.results[0].animeId, anime.animeId);
    assert.equal(Globals.envs.autoMatchMappingTable.length, 1);
  });
test('handleClearCache clears only the selected cache items', async t => {
    // 各清理项对应的全局状态种子；favorites 不在清理范围内，用于验证不被误清
    const seed = () => {
      Globals.animes = [{ id: 1 }];
      Globals.episodeIds = [{ id: 12000, url: 'https://example.com/retained', title: 'retained' }];
      Globals.episodeNum = 50000;
      Globals.lastSelectMap = new Map([['k', {}]]);
      Globals.searchCache = new Map([['k', {}]]);
      Globals.commentCache = new Map([['k', {}]]);
      Globals.requestHistory = new Map([['ip', []]]);
      Globals.reqRecords = [{ a: 1 }];
      Globals.todayReqNum = 42;
      Globals.favoriteCache = new Map([['fav', {}]]);
      Globals.useBangumiData = false;
    };

    await t.test('single item clears only that item', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['animes'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(body.clearedItems.animes, 0);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.episodeIds.length, 1);
      assert.equal(Globals.lastSelectMap.size, 1);
      assert.equal(Globals.searchCache.size, 1);
      assert.equal(Globals.commentCache.size, 1);
      assert.equal(Globals.requestHistory.size, 1);
    });

    await t.test('invalid keys are filtered out and do not throw', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['animes', 'notARealKey', 'animesX'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.searchCache.size, 1);
      assert.equal(Globals.commentCache.size, 1);
    });

    await t.test('requestHistory folds reqRecords and todayReqNum', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['requestHistory'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(body.clearedItems.requestHistory, 0);
      assert.equal(body.clearedItems.reqRecords, 0);
      assert.equal(body.clearedItems.todayReqNum, 0);
      assert.equal(Globals.requestHistory.size, 0);
      assert.deepEqual(Globals.reqRecords, []);
      assert.equal(Globals.todayReqNum, 0);
      assert.equal(Globals.animes.length, 1);
    });

    await t.test('episodeNum reset respects retained episode references', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['episodeNum'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(body.clearedItems.episodeNum, 12000);
      assert.equal(Globals.episodeNum, 12000);
      assert.equal(Globals.animes.length, 1);
    });

    await t.test('favorites are preserved across full clear', async () => {
      seed();
      const res = await handleClearCache();
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(Globals.favoriteCache.size, 1);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.episodeIds.length, 0);
      assert.equal(Globals.lastSelectMap.size, 0);
      assert.equal(Globals.searchCache.size, 0);
      assert.equal(Globals.commentCache.size, 0);
      assert.equal(Globals.requestHistory.size, 0);
      assert.equal(Globals.todayReqNum, 0);
      assert.deepEqual(Globals.reqRecords, []);
    });

    await t.test('empty items array clears nothing', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: [] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(Globals.animes.length, 1);
      assert.equal(Globals.searchCache.size, 1);
      assert.equal(Globals.commentCache.size, 1);
    });

    await t.test('malformed body (non-array items) triggers full clear', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: 'animes' }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.searchCache.size, 0);
    });

    await t.test('bangumiData is a recognized key and isolated from other caches', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['bangumiData'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(body.clearedItems.bangumiData, 0);
      assert.equal(Globals.animes.length, 1);
      assert.equal(Globals.searchCache.size, 1);
    });

    await t.test('prototype keys like __proto__ are rejected and do not break the clear', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['animes', '__proto__', 'constructor', 'animes'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.searchCache.size, 1);
      assert.equal(Globals.commentCache.size, 1);
    });
  });

test('handleLogs renders each log entry as "[timestamp] level: message"', async t => {
  const saved = Globals.logBuffer;
  t.after(() => { Globals.logBuffer = saved; });
  Globals.logBuffer = [
    { timestamp: '2026-10-31T08:00:00.000+08:00', level: 'info', message: '[system] [tmdb] 中文标题' },
    { timestamp: '2026-10-31T08:00:01.000+08:00', level: 'error', message: '[tencent] 请求失败' },
  ];
  const response = handleLogs();
  assert.equal(await response.text(), [
    '[2026-10-31T08:00:00.000+08:00] info: [system] [tmdb] 中文标题',
    '[2026-10-31T08:00:01.000+08:00] error: [tencent] 请求失败',
  ].join('\n'));
});

test('handleLogs keeps newlines and indentation of multi-line messages', async t => {
  const saved = Globals.logBuffer;
  t.after(() => { Globals.logBuffer = saved; });
  Globals.logBuffer = [{
    timestamp: '2026-10-31T08:00:00.000+08:00',
    level: 'info',
    message: '[merge][Phase 2: Standard] [tencent] 映射详情:\n   [已路由映射] 第1集 <-> 第1集',
  }];
  const response = handleLogs();
  assert.deepEqual((await response.text()).split('\n'), [
    '[2026-10-31T08:00:00.000+08:00] info: [merge][Phase 2: Standard] [tencent] 映射详情:',
    '   [已路由映射] 第1集 <-> 第1集',
  ]);
});
