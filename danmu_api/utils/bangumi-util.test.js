import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../configs/globals.js';
import { getBangumiChineseTitle } from './bangumi-util.js';
import { extractTitleSeasonEpisode } from '../apis/dandan-api.js';

test('Bangumi title lookup ranks seasons, resolves detail aliases and falls back safely', async t => {
  Globals.init({ TITLE_TO_CHINESE: 'true', TMDB_API_KEY: 'fixture-key' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let subjects = [];
  let detail = {};
  let fail = false;
  let calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'api.bgm.tv') {
      if (fail) throw new Error('fixture unavailable');
      if (options.body) assert.deepEqual(JSON.parse(options.body).filter.type, [2, 6]);
      return Response.json(url.pathname.includes('/search/') ? { data: subjects } : detail);
    }
    const data = url.pathname.includes('/search/')
      ? { results: [{ id: 77, name: '回退剧名', original_name: 'Fallback Show', original_language: 'zh', media_type: 'tv' }] }
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
  fail = true;
  const parsed = await extractTitleSeasonEpisode('Fallback.Show.S01E02');
  assert.equal(parsed.title, '回退剧名');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 2);
  assert.ok(calls.some(url => url.hostname === 'api.bgm.tv'));
  assert.ok(calls.some(url => url.hostname === 'api.tmdb.org'));
});
