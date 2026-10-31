// 本地弹幕测试夹具与固件
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

import dotenv from 'dotenv';
dotenv.config();

import { Request as NodeFetchRequest } from 'node-fetch';
import path from 'node:path';
import { handleLocalDanmuUpload } from '../../apis/local-danmu-api.js';
import { Globals } from '../../configs/globals.js';
import { getSourceByKey } from '../../sources/registry.js';
import { addAnime } from '../../utils/cache-util.js';
import { buildLocalDanmuResourceKey } from '../../utils/local-danmu-parser.js';
import { localDanmuFileName } from '../../utils/local-danmu-store.js';

export const comment = '标题警告‼️ 中文弹幕 😀 \uFFFD';
export const localDanmuJson = JSON.stringify({ count: 1, comments: [{ p: '1.00,1,16777215,[qiyi]', m: comment }] }, null, 2);
export const localDanmuExpected = { format: 'JSON', comments: [{ p: '1.00,1,16777215', m: comment }], errors: [] };
export const localDanmuEncodings = [
  ['UTF-8', text => Buffer.from(text, 'utf8')],
  ['UTF-8 with BOM', text => Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')])],
  ['UTF-16LE', text => Buffer.from(text, 'utf16le')],
  ['UTF-16LE with BOM', text => Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')])],
  ['UTF-16BE', text => Buffer.from(text, 'utf16le').swap16()],
  ['UTF-16BE with BOM', text => Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(text, 'utf16le').swap16()])],
];

export function resetState(sourceOrder = 'local') {
  Globals.init({ SOURCE_ORDER: sourceOrder, LOG_LEVEL: 'error', GROUP_MINUTE: '0' });
  Globals.deployPlatform = 'node';
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.favoriteCache = new Map();
  Globals.lastSelectMap = new Map();
  Globals.requestHistory = new Map();
  Globals.localCacheValid = false;
  Globals.redisValid = false;
  Globals.localRedisValid = false;
  Globals.aiValid = false;
  Globals.envs.mergeSourcePairs = [];
  Globals.envs.customMergeRules = [];
  Globals.envs.enableAnimeEpisodeFilter = false;
}

export function makeResource(title, episode, year = 2026, type = 'tv', status = 'ready') {
  return {
    title, episode, year, type, status,
    resourceKey: buildLocalDanmuResourceKey({ title, episode, year, type }),
    count: 1,
    comments: [{ p: '1.00,1,16777215', m: `第${episode ?? 1}集弹幕` }],
  };
}

export const localDanmuDir = () => path.join(process.cwd(), '.cache', 'local-danmu');
export const localIndexPath = () => path.join(localDanmuDir(), 'index.meta');
export const localDataPath = key => path.join(localDanmuDir(), localDanmuFileName(key));
export function localDanmuSearchUrl(keyword) {
  const url = new URL('http://localhost/api/v2/search/anime');
  url.searchParams.set('keyword', keyword);
  return url;
}

export async function uploadResource(fields, message) {
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify({ comments: [{ p: '1,1,16777215', m: message }] })]), 'danmu.json');
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  return handleLocalDanmuUpload(new NodeFetchRequest('http://localhost/api/local-danmu/upload', { method: 'POST', body: form }));
}

export function mockRemoteSource(t) {
  const remote = getSourceByKey('tencent');
  t.mock.method(remote, 'search', async () => [{}]);
  t.mock.method(remote, 'handleAnimes', async (_results, query, animes, details) => {
    const anime = {
      animeId: 900001, bangumiId: '900001', animeTitle: `${query}(2026)【TV】from tencent`,
      type: 'tvseries', typeDescription: 'TV', imageUrl: '', startDate: '2026-01-01',
      episodeCount: 10, rating: 0, isFavorited: true, source: 'tencent',
    };
    const links = Array.from({ length: 10 }, (_, index) => ({
      name: `第${index + 1}集`, title: `【qq】 第${index + 1}集`, url: `https://v.qq.com/test-episode-${index + 1}`,
    }));
    addAnime({ ...anime, links }, details);
    animes.push(anime);
  });
}

export function makeLocalDanmuResource(season, episode) {
  const fields = { title: '<img src=x> 分季剧', year: 2026, type: 'tv', season, episode };
  return {
    ...fields, resourceKey: buildLocalDanmuResourceKey(fields),
    filename: `第${episode}集 "<script>".json`, size: 1234, count: 2, status: 'ready',
  };
}

