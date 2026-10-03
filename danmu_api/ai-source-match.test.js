import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { matchAnime, getComment, searchAnime, buildSearchAnimeUrl } from './apis/dandan-api.js';
import { getSourceByKey } from './sources/registry.js';
import AIClient from './utils/ai-util.js';
import { getLastSearch } from './utils/cache-util.js';

test('S20E1 falls back to AI source search and returns episode 414 comments with original playback context', async t => {
  const originalFetch = globalThis.fetch;
  const originalChat = AIClient.prototype.chat;
  const source = getSourceByKey('tencent');
  const saved = { search: source.search, handleAnimes: source.handleAnimes, getComments: source.getComments };
  t.after(() => { globalThis.fetch = originalFetch; AIClient.prototype.chat = originalChat; Object.assign(source, saved); });
  Globals.init({ AI_MATCH_PROMPT: '', TMDB_API_KEY: 'fixture-key', USE_BANGUMI_DATA: 'false', REMEMBER_LAST_SELECT: 'true', COMMENT_CACHE_MIN_COUNT: '0' });
  Globals.aiValid = true;
  Globals.envs.sourceOrderArr = ['tencent'];
  Globals.searchCache = new Map(); Globals.commentCache = new Map(); Globals.animes = []; Globals.episodeIds = [];
  const title = '火影忍者：疾风传';
  const counts = [32,21,18,17,24,31,8,24,21,25,21,33,20,25,28,13,11,21,20,87];
  const searches = [];
  let numberingOffset = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith('/search/tv') ? { results: [{ id: 31910, name: title }] }
      : url.pathname.endsWith('/season/20') ? { season_number: 20, episodes: Array.from({ length: 87 }, (_, i) => ({ episode_number: 414 + i, name: i === 0 ? '死亡边缘' : '测试' })) }
      : { name: title, seasons: counts.map((n, i) => ({ season_number: i + 1, episode_count: n })) };
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  source.search = async query => { searches.push(query); return [{}]; };
  source.handleAnimes = async (_data, _title, animes, details) => {
    const anime = { animeId: 995001, bangumiId: '995001', animeTitle: title, type: 'tvseries', source: 'tencent', episodeCount: 500,
      links: Array.from({ length: 500 }, (_, i) => ({ id: 99500100 + i, title: `【qq】 第${i + 1 + numberingOffset}集 ${i === 413 ? '死亡边缘' : ''}`, url: `https://v.qq.com/x/cover/shippuden/${i + 1 + numberingOffset}.html` })) };
    animes.push(anime); details.set(String(anime.animeId), anime);
  };
  const commentUrls = [];
  source.getComments = async url => { commentUrls.push(url); return [{ p: '1,1,16777215,test', m: `comments:${url}` }]; };
  let round = 0;
  AIClient.prototype.chat = async (messages, options) => {
    assert.ok(searches.length > 0, 'normal search must precede AI');
    assert.equal(options.thinking, false);
    assert.equal(JSON.parse(messages[1].content).playback.season, 20);
    const actions = [
      { action: 'search', query: title }, { action: 'lookup', query: title },
      { action: 'episodes', candidate: 'c1', ...(numberingOffset ? { title: '死亡边缘' } : { number: 414 }) },
      { action: 'select', candidate: 'c1', episode: 'c1e414', evidence: 'm1' }
    ];
    return JSON.stringify(actions[round++] || { action: 'no_match' });
  };
  const req = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName: `${title} S20E1` }) });
  const result = await (await matchAnime(new URL(req.url), req, 'ai-test')).json();
  assert.equal(result.isMatched, true); assert.equal(round, 4);
  assert.match(result.matches[0].episodeTitle, /第414集/);
  const comment = await (await getComment(`/api/v2/comment/${result.matches[0].episodeId}`, 'json', false, 'ai-test')).json();
  assert.equal(comment.comments.length, 1); assert.match(comment.comments[0].m, /414.html/);
  assert.deepEqual(commentUrls, ['https://v.qq.com/x/cover/shippuden/414.html']);
  const context = getLastSearch('ai-test');
  assert.equal(context.season, 20); assert.equal(context.episode, 1); assert.equal(context.autoMatchMappingApplied, true);
  // A source that continues the original series numbers must use the title
  // evidence; its label 414 is an entirely different episode.
  numberingOffset = 220; round = 0; commentUrls.length = 0;
  Globals.searchCache = new Map(); Globals.commentCache = new Map(); Globals.animes = []; Globals.episodeIds = [];
  const shiftedReq = new Request(req.url, { method: 'POST', body: JSON.stringify({ fileName: `${title} S20E1` }) });
  const shifted = await (await matchAnime(new URL(req.url), shiftedReq, 'ai-test')).json();
  assert.equal(shifted.isMatched, true); assert.equal(round, 4);
  assert.match(shifted.matches[0].episodeTitle, /第634集 死亡边缘/);
  assert.deepEqual(commentUrls, ['https://v.qq.com/x/cover/shippuden/634.html']);
  for (const query of ['example.org', 'example.org/video second.example/video']) {
    const before = searches.length;
    const response = await searchAnime(buildSearchAnimeUrl(req.url, query), null, null, new Map(), null, true, { allowDirectUrls: false });
    const body = await response.json();
    assert.equal(body.success, true);
    assert.ok(searches.length > before, 'title-only search must use configured sources instead of fetching model URLs');
  }
});
