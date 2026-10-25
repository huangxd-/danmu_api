import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../configs/globals.js';
import { getBangumiChineseTitle } from './bangumi-util.js';
import { getTMDBChineseTitle } from './tmdb-util.js';
import { extractTitleSeasonEpisode } from '../apis/dandan-api.js';

test('Bangumi title lookup ranks seasons, resolves detail aliases and falls back safely', async t => {
  Globals.init({ TITLE_TO_CHINESE: 'true', TMDB_API_KEY: 'fixture-key' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let subjects = [];
  let detail = {};
  let calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'api.bgm.tv') {
      if (options.body) assert.deepEqual(JSON.parse(options.body).filter.type, [2, 6]);
      return Response.json(url.pathname.includes('/search/') ? { data: subjects } : detail);
    }
    const data = url.pathname.includes('/search/')
      ? { results: [{ id: 77, name: 'Fallback Show', original_name: 'Fallback Show', original_language: 'en', media_type: 'tv' }] }
      : { name: '回退剧名', titles: [], results: [] };
    const response = Response.json(data);
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  subjects = [
    { id: 1, name: 'Anime Example', name_cn: '动画示例' },
    { id: 2, name: 'Anime Example 2nd Season', name_cn: '动画示例 第二季' }
  ];
  assert.equal(await getBangumiChineseTitle('Anime Example', 2, 1), '动画示例 第二季');
  subjects = [{ id: 3, name: 'Live Action Example' }];
  detail = { id: 3, name: 'Live Action Example', infobox: [{ key: '别名', value: [{ v: '真人剧示例' }] }] };
  assert.equal(await getBangumiChineseTitle('Live Action Example', 1, 1), '真人剧示例');
  subjects = [{ id: 4, name: 'Unrelated', name_cn: '不相关条目' }];
  detail = subjects[0];
  assert.equal(await getBangumiChineseTitle('Completely Different Show', 1, 1), 'Completely Different Show');
  calls = [];
  assert.equal(await getBangumiChineseTitle('已有中文剧名', 1, 1), '已有中文剧名');
  assert.equal(calls.length, 0);
  subjects = [{ id: 5, name: 'Fallback Show', name_cn: '回退剧名' }];
  detail = subjects[0];
  const parsed = await extractTitleSeasonEpisode('Fallback.Show.S01E02');
  assert.equal(parsed.title, '回退剧名');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 2);
  assert.ok(calls.some(url => url.hostname === 'api.bgm.tv'));
  assert.ok(calls.some(url => url.hostname === 'api.tmdb.org'));
});

test('TMDB resolves an exact foreign result through its Chinese alternative title', async t => {
  Globals.init({ TITLE_TO_CHINESE: 'true', TMDB_API_KEY: 'fixture-key', USE_BANGUMI_DATA: 'false' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const data = url.pathname.endsWith('/search/tv')
      ? { results: [{ id: 77, name: 'Wednesday', original_name: 'Wednesday', original_language: 'en', media_type: 'tv' }] }
      : url.pathname.endsWith('/search/movie')
        ? { results: [{ id: 88, title: 'Arrival', original_title: 'Arrival', original_language: 'en', media_type: 'movie' }] }
        : { results: [
        { iso_3166_1: 'US', title: 'Wednesday Addams' },
        { iso_3166_1: 'CN', title: url.pathname.includes('/movie/') ? '降临' : '星期三' }
      ] };
    const response = Response.json(data);
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };

  assert.equal(await getTMDBChineseTitle('Wednesday', 1, 1), '星期三');
  assert.equal(await getTMDBChineseTitle('Arrival'), '降临');
  assert.deepEqual(calls, [
    '/3/search/tv', '/3/tv/77/alternative_titles',
    '/3/search/movie', '/3/movie/88/alternative_titles'
  ]);
});
