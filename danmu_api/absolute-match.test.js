import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('absolute episode matching keeps TMDB numbering and returns the correct source comments', async t => {
  const cwd = process.cwd();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-absolute-'));
  const originalFetch = globalThis.fetch;
  await fs.mkdir(path.join(temp, '.cache'));
  await fs.copyFile(new URL('./test-fixtures/rezero-bangumi.json', import.meta.url), path.join(temp, '.cache/bangumi-data-cache.json'));
  process.chdir(temp);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    process.chdir(cwd);
    await fs.rm(temp, { recursive: true, force: true });
  });
  const { Globals } = await import('./configs/globals.js');
  const { matchAnime, getComment } = await import('./apis/dandan-api.js');
  const { getSourceByKey } = await import('./sources/registry.js');
  const { initBangumiData } = await import('./utils/bangumi-data-util.js');
  const { default: AIClient } = await import('./utils/ai-util.js');
  const source = getSourceByKey('tencent');
  const otherSource = getSourceByKey('other');
  const originalOtherComments = otherSource?.getComments;
  if (otherSource) otherSource.getComments = async () => [];
  const originalMethods = { search: source.search, handleAnimes: source.handleAnimes, getComments: source.getComments };
  const originalChat = AIClient.prototype.chat;
  t.after(() => { Object.assign(source, originalMethods); AIClient.prototype.chat = originalChat; if (otherSource) otherSource.getComments = originalOtherComments; });
  const title = 'Re：从零开始的异世界生活';
  let sourceSeasons = [];
  let tmdbSeasons = [];
  let scenario = 'normal';
  let aiCalls = 0;
  let commentCalls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    let data = {};
    if (url.pathname === '/3/search/tv') data = { results: [{ id: 65942, name: title }] };
    else if (/\/3\/tv\/65942\/season\//.test(url.pathname)) {
      const season = Number(url.pathname.split('/').at(-1));
      tmdbSeasons.push(season);
      data = { name: `第${season}季`, air_date: '2016-04-03', episodes: Array.from({ length: 100 }, (_, i) => ({ episode_number: i + 1, name: '拉姆' })) };
    }
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  source.search = async () => [{}];
  source.handleAnimes = async (_data, _title, animes, details, season) => {
    sourceSeasons.push(season);
    const add = (name, candidateSeason, count, id) => {
      const anime = {
        animeId: id, bangumiId: String(id), animeTitle: name, type: 'tvseries', source: 'tencent',
        episodeCount: count, startDate: '2026-01-01',
        links: Array.from({ length: count }, (_, i) => ({
          id: id * 100 + i + 1, title: `【qq】 第${i + 1}集 ラム`, url: `https://v.qq.com/x/cover/test/s${candidateSeason}e${i + 1}.html?source=${id}`
        }))
      };
      if (scenario === 'gap' || scenario === 'unnumbered-gap') anime.links = anime.links.filter((_, i) => i !== 17);
      if (scenario === 'unnumbered-gap') anime.links.forEach(link => { link.title = '【qq】 ラム'; });
      animes.push(anime);
      details.set(String(id), anime);
    };
    if (scenario === 'no-boundaries') {
      add('没有季边界', 1, 13, 990006);
      add('没有季边界 第二季', 2, 25, 990007);
      return;
    }
    // Put misleading candidates first: shared title/episode numbers must not win.
    add(`${title} 休息时间 第四季`, 4, 30, 990001);
    add(`${title} 第四季 Part 2`, 4, 30, 990004);
    add(`${title} 第四季 休息时间`, 4, 30, 990005);
    add(`${title} 第三季`, 3, 30, 990002);
    if (scenario !== 'spinoff-only') add(`${title} 第四季`, 4, scenario === 'short' ? 17 : 24, 990003);
    if (scenario === 'empty-primary') add(`${title} 第四季 丧失篇`, 4, 24, 990008);
  };
  source.getComments = async url => {
    commentCalls.push(url);
    if (scenario === 'empty-all' || (scenario === 'empty-primary' && url.includes('source=990003'))) return [];
    return [{ p: '1,1,16777215,test', m: `comments:${url}` }];
  };
  AIClient.prototype.chat = async () => { aiCalls++; return '{"action":"no_match"}'; };
  const run = async (fileName, env = {}) => {
    Globals.init({ USE_BANGUMI_DATA: 'true', TMDB_API_KEY: 'fixture-key', REMEMBER_LAST_SELECT: 'false', COMMENT_CACHE_MIN_COUNT: '0', ...env });
    Globals.deployPlatform = 'node';
    Globals.envs.sourceOrderArr = ['tencent'];
    Globals.aiValid = true;
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.searchCache = new Map();
    Globals.commentCache = new Map();
    sourceSeasons = [];
    tmdbSeasons = [];
    commentCalls = [];
    await initBangumiData('node', true);
    const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName }) });
    return (await matchAnime(new URL(req.url), req, '127.0.0.1')).json();
  };
  await t.test('S1E84 searches S4, matches E18, then fetches E18 comments', async () => {
    const result = await run(`${title} S1E84`);
    assert.equal(result.isMatched, true);
    assert.equal(aiCalls, 0);
    assert.equal(sourceSeasons[0], 4);
    assert.deepEqual(tmdbSeasons, []);
    assert.equal(result.matches[0].animeTitle, `${title} 第四季`);
    assert.match(result.matches[0].episodeTitle, /第18集/);
    const comments = await (await getComment(`/api/v2/comment/${result.matches[0].episodeId}`, 'json', false, '127.0.0.1')).json();
    assert.match(JSON.stringify(comments), /s4e18/);
  });
  for (const mode of ['short', 'gap', 'unnumbered-gap', 'spinoff-only', 'empty-all']) {
    await t.test(`no wrong episode or spinoff fallback when ${mode}`, async () => {
      scenario = mode;
      const result = await run(`${title} S1E84`);
      assert.equal(result.isMatched, false);
    });
  }
  await t.test('empty preferred comments fall back to the same episode and cache the usable source', async () => {
    scenario = 'empty-primary';
    const result = await run(`${title} S1E84`);
    assert.equal(result.isMatched, true);
    assert.equal(result.matches[0].animeTitle, `${title} 第四季 丧失篇`);
    assert.match(result.matches[0].episodeTitle, /第18集/);
    const comments = await (await getComment(`/api/v2/comment/${result.matches[0].episodeId}`, 'json', false, '127.0.0.1')).json();
    assert.match(JSON.stringify(comments), /source=990008/);
    assert.equal(commentCalls.filter(url => url.includes('source=990008')).length, 1);
  });
  await t.test('real S4E18 is not converted a second time', async () => {
    scenario = 'normal';
    const result = await run(`${title} S4E18`, { TMDB_API_KEY: '' });
    assert.equal(result.isMatched, true);
    assert.equal(sourceSeasons[0], 4);
    assert.match(result.matches[0].episodeTitle, /第18集/);
  });
  await t.test('missing boundaries do not guess season lengths from partial sources', async () => {
    scenario = 'no-boundaries';
    const result = await run('没有季边界 S1E27', { TMDB_API_KEY: '' });
    assert.equal(result.isMatched, false);
  });
});
