import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { matchAnime } from './apis/dandan-api.js';
import { getSourceByKey } from './sources/registry.js';
import { getTMDBEpisodeTitle } from './utils/tmdb-util.js';

test('episode metadata resolves renamed seasons without positional guesses', async t => {
  const originalFetch = globalThis.fetch;
  const sources = ['tencent', 'iqiyi'].map(getSourceByKey);
  const saved = sources.map(source => ({ search: source.search, handleAnimes: source.handleAnimes }));
  t.after(() => { globalThis.fetch = originalFetch; sources.forEach((source, i) => Object.assign(source, saved[i])); });
  let mode;
  let title;
  let calls;
  let sourceCalls;
  let nextId = 882000;
  const targetName = '谜城消失的时钟（下）';
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    let data = {};
    if (url.pathname.endsWith('/search/tv')) {
      data = { results: [{ id: 771, name: mode === 'unrelated' ? '完全不相关作品' : title }] };
    } else if (url.pathname.endsWith('/season/2')) {
      data = { name: '第二季', season_number: 2, air_date: '2025-01-01', episodes: [
        { episode_number: 1, name: mode === 'generic' ? '第1集' : targetName }
      ] };
    } else if (url.pathname.endsWith('/alternative_titles')) {
      data = { results: mode === 'renamed' ? [{ title: `${title}新名`, type: '改名', iso_3166_1: 'CN' }] : [] };
    } else if (url.hostname === 'api.bgm.tv') {
      const query = options.body && JSON.parse(options.body);
      if (query) assert.deepEqual(query.filter.type, [6]);
      data = { data: ['expanded', 'strict'].includes(mode) ? [
        { id: 81, name: `${title}之谜城`, name_cn: `${title}之谜城`, date: '2025-01-01' },
        { id: 82, name: `${title}旧版`, date: '2024-01-01' }
      ] : [] };
    }
    const response = Response.json(data);
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  sources.forEach((source, sourceIndex) => {
    source.search = async query => [{ query }];
    source.handleAnimes = async (data, query, animes, details, season) => {
      sourceCalls.push({ source: sourceIndex, query, season });
      const expandedQuery = query.endsWith('之谜城');
      if (expandedQuery && sourceIndex === 0) return;
      if (expandedQuery && (mode !== 'expanded' || season !== 1)) return;
      if (sourceIndex === 1 && !expandedQuery) return;
      const id = ++nextId;
      const correct = mode === 'direct' || mode === 'renamed' || expandedQuery;
      const links = [
        { id: id * 10 + 1, title: '【qq】 第1集 完全不同的故事', url: `https://v.qq.com/x/cover/test/${id}-1.html` },
        { id: id * 10 + 2, title: '【qq】 第7集 谜城消失的时钟（上）', url: `https://v.qq.com/x/cover/test/${id}-7a.html` },
        { id: id * 10 + 3, title: `【qq】 第7集 ${correct ? targetName : '无关故事'}`, url: `https://v.qq.com/x/cover/test/${id}-7b.html` }
      ];
      const anime = { animeId: id, bangumiId: String(id), animeTitle: `${query}${query.endsWith('第二季') || expandedQuery ? '' : ' 第二季'}`, type: 'tvseries', source: sourceIndex ? 'iqiyi' : 'tencent', episodeCount: 3, links };
      animes.push(anime); details.set(String(id), anime);
    };
  });
  const run = async scenario => {
    mode = scenario; title = `推理节目${scenario}`; calls = []; sourceCalls = [];
    Globals.init({ TMDB_API_KEY: 'fixture-key', REMEMBER_LAST_SELECT: 'false', TITLE_TO_CHINESE: 'false', USE_BANGUMI_DATA: 'false' });
    Globals.envs.sourceOrderArr = ['tencent']; Globals.envs.platformOrderArr = ['qq']; Globals.aiValid = false;
    Globals.searchCache = new Map(); Globals.animes = []; Globals.episodeIds = [];
    const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName: `${title} S2E1` }) });
    const response = await matchAnime(new URL(req.url), req, null);
    assert.equal(response.status, 200);
    assert.deepEqual(Globals.envs.sourceOrderArr, ['tencent'], 'extra sources stay request-local');
    return response.json();
  };
  await t.test('named episode wins over numeric position and preserves upper/lower variants', async () => {
    const result = await run('direct');
    assert.equal(result.isMatched, true);
    assert.equal(result.matches[0].episodeTitle, `【qq】 第7集 ${targetName}`);
  });
  await t.test('explicit TMDB renamed title is searched using its season name', async () => {
    const result = await run('renamed');
    assert.equal(result.isMatched, true);
    assert.equal(sourceCalls[0].query, `${title}新名第二季`);
    assert.equal(result.matches[0].episodeTitle, `【qq】 第7集 ${targetName}`);
  });
  await t.test('same-year related title refresh uses the source first season without changing playback season', async () => {
    const result = await run('expanded');
    assert.equal(result.isMatched, true);
    assert.equal(result.matches[0].animeTitle, `${title}之谜城`);
    assert.ok(sourceCalls.some(call => call.source === 1 && call.season === 1));
    assert.ok(!sourceCalls.some(call => call.query.endsWith('旧版')));
  });
  await t.test('related-title evidence prevents falling back to the old title first episode', async () => {
    const result = await run('strict');
    assert.equal(result.isMatched, false);
  });
  await t.test('generic episode title preserves ordinary numeric matching', async () => {
    const result = await run('generic');
    assert.equal(result.isMatched, true);
    assert.match(result.matches[0].episodeTitle, /第1集/);
    assert.ok(!calls.some(url => url.hostname === 'api.bgm.tv'));
  });
  await t.test('unrelated TMDB search result is not treated as evidence', async () => {
    await run('unrelated');
    assert.equal(await getTMDBEpisodeTitle(title, 2, 1), null);
    assert.ok(!calls.some(url => url.pathname.endsWith('/season/2')));
  });
});
