// 加载 .env 文件
import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { handleRequest } from './worker.js';
import { extractTitleSeasonEpisode, getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime, buildSearchAnimeUrl } from "./apis/dandan-api.js";
import { stripLinkOffset, applyOffset } from "./utils/offset-util.js";
import { handleFavoriteRefresh } from './apis/favorite-api.js';
import { handleClearCache } from './apis/system-api.js';
import { getRedisCaches, getRedisKey, pingRedis, setRedisKey, setRedisKeyWithExpiry, updateRedisCaches } from "./utils/redis-util.js";
import { getLocalRedisKey, setLocalRedisKey, setLocalRedisKeyWithExpiry } from "./utils/local-redis-util.js";
import { getImdbepisodes } from "./utils/imdb-util.js";
import { getTMDBChineseTitle, getTmdbJpDetail, searchTmdbTitles } from "./utils/tmdb-util.js";
import { getDoubanDetail, getDoubanInfoByImdbId, searchDoubanTitles } from "./utils/douban-util.js";
import AIClient from './utils/ai-util.js';
import { getSourceByKey } from './sources/registry.js';
import BilibiliSource from "./sources/bilibili.js";
import { parseHongguoPlayerUrl } from "./sources/hongguo.js";
import { NodeHandler } from "./configs/handlers/node-handler.js";
import { VercelHandler } from "./configs/handlers/vercel-handler.js";
import { NetlifyHandler } from "./configs/handlers/netlify-handler.js";
import { CloudflareHandler } from "./configs/handlers/cloudflare-handler.js";
import { EdgeoneHandler } from "./configs/handlers/edgeone-handler.js";
import { HuggingfaceHandler } from "./configs/handlers/huggingface-handler.js";
import { HandlerFactory } from "./configs/handlers/handler-factory.js";
import { Globals } from "./configs/globals.js";
import { addAnime, addEpisode, getSearchCache, hasSeasonSpecificPreference, isSearchCacheValid, setSearchCache } from "./utils/cache-util.js";
import { addFavorite, listFavorites, loadFavorites, removeFavorite, resolveFavoriteForKeyword, saveFavorites } from './utils/favorite-util.js';
import { candidateMatchesMappingQualifiers, candidateMatchesMappingTitle, parseAutoMatchMappingRules, resolveAutoMatchMapping } from './utils/auto-match-mapping-util.js';
import { HTML_TEMPLATE } from './ui/template.js';
import { apitestJsContent } from './ui/js/apitest.js';
import { systemSettingsJsContent } from './ui/js/systemsettings.js';
import { previewJsContent } from './ui/js/preview.js';
import { convertToAsciiSum } from "./utils/codec-util.js";
import { convertToDanmakuJson, handleDanmusLike, splitBlockedWords, parseBlockedWord } from "./utils/danmu-util.js";
import { Segment, SegmentListResponse } from "./models/dandan-model.js"
import { initBangumiData, searchBangumiData, clearBangumiDataCache, dedupeBangumiSearchResults } from "./utils/bangumi-data-util.js";
import { generateNipaplaySignature, parseNipaplayRelatedLinks, resolveNipaplayLink, applyShiftToDanmu } from "./utils/nipaplay-util.js";

// Mock Request class for testing
class MockRequest {
  constructor(url, options = {}) {
    this.url = url;
    this.method = options.method || 'GET';
    this.headers = new Map(Object.entries(options.headers || {}));
    this.json = options.body ? async () => options.body : undefined;  // 模拟 POST 请求的 body
  }
}

// Helper to parse JSON response
async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function mockJsonResponse(data, url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(data),
  };
}

async function withMockFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

function createSearchResult(anime) {
  return {
    animeId: anime.animeId,
    bangumiId: anime.bangumiId,
    animeTitle: anime.animeTitle,
    type: anime.type,
    typeDescription: anime.typeDescription,
    imageUrl: anime.imageUrl,
    startDate: anime.startDate,
    episodeCount: anime.episodeCount,
    rating: anime.rating,
    isFavorited: anime.isFavorited,
    source: anime.source
  };
}

function resetSearchState() {
  Globals.init({});
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.requestHistory = new Map();
  Globals.envs.rateLimitMaxRequests = 0;
  delete Globals.requestAnimeDetailsMap;
}

function resetFavoriteState(env = {}) {
  Globals.init(env);
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.favoriteCache = new Map();
  Globals.requestHistory = new Map();
  Globals.localCacheValid = false;
  Globals.localCacheInitialized = false;
}

function createFavoriteAnime(title = '收藏测试', episodeCount = 2, id = 910001) {
  return {
    animeId: id,
    bangumiId: String(id),
    animeTitle: title,
    type: 'tvseries',
    typeDescription: 'TV',
    imageUrl: 'https://example.com/favorite.jpg',
    startDate: '2026-01-01T00:00:00.000Z',
    episodeCount,
    rating: 0,
    isFavorited: true,
    source: 'tencent',
    links: Array.from({ length: episodeCount }, (_, index) => ({
      id: id * 10 + index + 1,
      url: `https://v.qq.com/x/cover/favorite/ep${index + 1}.html`,
      title: `【qq】 第${index + 1}集`
    }))
  };
}

function favoriteSearchResult(anime) {
  const { links, ...result } = anime;
  return result;
}

const urlPrefix = "http://localhost:9321";
const token = "87654321";

test('worker.js API endpoints', async (t) => {
  const renrenSource = getSourceByKey('renren');
  const hanjutvSource = getSourceByKey('hanjutv');
  const bahamutSource = getSourceByKey('bahamut');
  const tencentSource = getSourceByKey('tencent');
  const iqiyiSource = getSourceByKey('iqiyi');
  const mangoSource = getSourceByKey('imgo');
  const bilibiliSource = getSourceByKey('bilibili');
  const youkuSource = getSourceByKey('youku');
  const miguSource = getSourceByKey('migu');
  const sohuSource = getSourceByKey('sohu');
  const leshiSource = getSourceByKey('leshi');
  const xiguaSource = getSourceByKey('xigua');
  const maiduiduiSource = getSourceByKey('maiduidui');
  const aiyifanSource = getSourceByKey('aiyifan');
  const hongguoSource = getSourceByKey('hongguo');
  const animekoSource = getSourceByKey('animeko');
  const otherSource = getSourceByKey('other');

  await t.test('GET / should return welcome message', async () => {
    const req = new MockRequest(urlPrefix, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
  });

  await t.test('HandlerFactory should support Hugging Face Spaces', async () => {
    const handler = await HandlerFactory.getHandler('huggingface');

    assert(handler instanceof HuggingfaceHandler);
    assert(HandlerFactory.getSupportedPlatforms().includes('huggingface'));
  });

  await t.test('HuggingfaceHandler should call Space variables and restart APIs', async () => {
    const env = {
      DEPLOY_PLATFROM_ACCOUNT: 'hf-user',
      DEPLOY_PLATFROM_PROJECT: 'hf-space',
      DEPLOY_PLATFROM_TOKEN: 'hf-token'
    };
    Globals.init(env);
    const globals = Globals.getConfig();
    const handler = new HuggingfaceHandler();

    await withMockFetch(async (url, options) => {
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/variables' && options.method === 'POST') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        assert.deepEqual(JSON.parse(options.body), { key: 'DANMU_LIMIT', value: '1' });
        return mockJsonResponse({}, url);
      }
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/variables' && options.method === 'DELETE') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        assert.deepEqual(JSON.parse(options.body), { key: 'DANMU_LIMIT' });
        return mockJsonResponse({}, url);
      }
      if (url === 'https://huggingface.co/api/spaces/hf-user/hf-space/restart' && options.method === 'POST') {
        assert.equal(options.headers.Authorization, 'Bearer hf-token');
        return mockJsonResponse({}, url);
      }
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    }, async () => {
      assert.equal(await handler.setEnv('DANMU_LIMIT', 1), true);
      assert.equal(globals.env.DANMU_LIMIT, 1);
      assert.equal(await handler.delEnv('DANMU_LIMIT'), true);
      assert.equal(await handler.deploy(), true);
    });
  });

  await t.test('BilibiliSource should resolve b23.tv short links from redirect location', async () => {
    Globals.init({});
    const source = new BilibiliSource();
    const shortUrl = 'https://b23.tv/BV1GJ411x7h7';
    const targetUrl = 'https://www.bilibili.com/video/BV1GJ411x7h7';
    let seenRedirectMode;

    await withMockFetch(async (url, options) => {
      assert.equal(url, shortUrl);
      seenRedirectMode = options.redirect;
      return {
        ok: false,
        status: 302,
        url: shortUrl,
        headers: new Headers({ location: targetUrl }),
        text: async () => '',
      };
    }, async () => {
      const resolvedUrl = await source.resolveB23Link(shortUrl);
      assert.equal(resolvedUrl, targetUrl);
    });

    assert.equal(seenRedirectMode, 'manual');
  });

  await t.test('buildSearchAnimeUrl should preserve special characters in keyword', async () => {
    const searchUrl = buildSearchAnimeUrl(`${urlPrefix}/api/v2/match`, 'Love & Death', 1, 2);

    assert.equal(searchUrl.pathname, '/api/v2/search/anime');
    assert.equal(searchUrl.searchParams.get('keyword'), 'Love & Death');
    assert.equal(searchUrl.searchParams.get('season'), '1');
    assert.equal(searchUrl.searchParams.get('episode'), '2');
    assert.equal(searchUrl.searchParams.has(' Death'), false);
  });

  await t.test('buildSearchAnimeUrl should derive /search/anime from /search/episodes requests', async () => {
    const searchUrl = buildSearchAnimeUrl(`${urlPrefix}/api/v2/search/episodes?anime=Love%20%26%20Death&episode=2`, 'Love & Death');

    assert.equal(searchUrl.pathname, '/api/v2/search/anime');
    assert.equal(searchUrl.searchParams.get('keyword'), 'Love & Death');
    assert.equal(searchUrl.searchParams.has('season'), false);
    assert.equal(searchUrl.searchParams.has('episode'), false);
  });

  // 测试标题解析
  await t.test('PARSE TitleSeasonEpisode', async () => {
    let title, season, episode;
    ({title, season, episode} = await extractTitleSeasonEpisode("生万物 S02E08"));
    assert(title === "生万物" && season == 2 && episode == 8, `Expected title === "生万物" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("无忧渡.S02E08.2160p.WEB-DL.H265.DDP.5.1"));
    assert(title === "无忧渡" && season == 2 && episode == 8, `Expected title === "无忧渡" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    // ({title, season, episode} = await extractTitleSeasonEpisode("Blood.River.S02E08"));
    // assert(title === "暗河传" && season == 2 && episode == 8, `Expected title === "暗河传" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("爱情公寓.ipartment.2009.S02E08.H.265.25fps.mkv"));
    assert(title === "爱情公寓" && season == 2 && episode == 8, `Expected title === "爱情公寓" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("亲爱的X S02E08"));
    assert(title === "亲爱的X" && season == 2 && episode == 8, `Expected title === "亲爱的X" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("宇宙Marry Me? S02E08"));
    assert(title === "宇宙Marry Me?" && season == 2 && episode == 8, `Expected title === "宇宙Marry Me?" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);
  });

  await t.test('auto match mapping table', async t => {
    await t.test('falls back when Unicode property escapes are unavailable', async () => {
      const NativeRegExp = globalThis.RegExp;
      globalThis.RegExp = function (pattern, flags) {
        if (String(pattern).includes('\\p{')) throw new SyntaxError('Unicode property escapes are unavailable');
        return new NativeRegExp(pattern, flags);
      };

      try {
        const compat = await import('./utils/auto-match-mapping-util.js?unicode-properties=unavailable');
        const { rules, warnings } = compat.parseAutoMatchMappingRules('進撃の巨人 S01E01->ＳＰＹ×ＦＡＭＩＬＹ S01E03');

        assert.deepEqual(warnings, []);
        assert.equal(compat.resolveAutoMatchMapping(rules, { title: '進撃の 巨人！', season: 1, episode: 2 }).targetEpisode, 4);
        assert.equal(compat.candidateMatchesMappingTitle({ animeTitle: 'SPY FAMILY' }, rules[0]), true);
      } finally {
        globalThis.RegExp = NativeRegExp;
      }
    });

    await t.test('parses and resolves open, bounded, qualified, and platform rules', () => {
      const { rules, warnings } = parseAutoMatchMappingRules([
        '永生 S05E02->永生 S01E58',
        '永生 S05E02~03->永生 S01E58~59',
        '海贼王 S2E1->航海王(1999)【动漫】 S1E62',
        '航海王 S1E1->航海王 S1E1 @qiyi'
      ].join(';'), Globals.envs.allowedPlatforms);

      assert.deepEqual(warnings, []);
      assert.equal(rules.length, 4);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 2 }).bounded, true);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 3 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 4 }).targetEpisode, 60);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 6, episode: 1 }), null);

      const qualified = rules[2];
      assert.equal(qualified.targetTitle, '航海王');
      assert.equal(qualified.targetYear, 1999);
      assert.equal(qualified.targetType, '动漫');
      assert.equal(rules[3].targetPlatform, 'qiyi');
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '航海王(1999)【动漫】from tencent',
        typeDescription: '动漫',
        startDate: '1999-10-20T00:00:00.000Z'
      }, qualified), true);
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '航海王(2000)【动漫】from tencent',
        typeDescription: '动漫',
        startDate: '2000-01-01T00:00:00.000Z'
      }, qualified), false);
      assert.equal(candidateMatchesMappingTitle({ animeTitle: '航海王 第二季(1999)【动漫】from tencent' }, qualified), true);
      assert.equal(candidateMatchesMappingTitle({ animeTitle: '海贼王(1999)【动漫】from tencent' }, qualified), false);

      const boundedOnly = parseAutoMatchMappingRules('永生 S05E02~03->永生 S01E58~59').rules;
      assert.equal(resolveAutoMatchMapping(boundedOnly, { title: '永生', season: 5, episode: 3 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(boundedOnly, { title: '永生', season: 5, episode: 4 }), null);

      const narutoRule = parseAutoMatchMappingRules('火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59').rules[0];
      assert.equal(resolveAutoMatchMapping([narutoRule], { title: '火影忍者', season: 1, episode: 57 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping([narutoRule], { title: '火影忍者', season: 1, episode: 58 }).targetEpisode, 60);
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '火影忍者疾风传(2007)【动漫】from 360',
        typeDescription: '动漫',
        startDate: '2007-02-15T00:00:00.000Z'
      }, narutoRule), true);
    });

    await t.test('rejects invalid ranges and keeps declaration order for equal specificity', () => {
      const parsed = parseAutoMatchMappingRules([
        '测试 S01E02~04->测试 S01E10~11',
        '测试 S01E02~03->测试 S01E20~21',
        '测试 S01E02~03->测试 S01E30~31'
      ].join(';'));
      assert.equal(parsed.warnings.length, 1);
      assert.equal(parsed.rules.length, 2);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '测试', season: 1, episode: 2 }).targetEpisode, 20);
    });

    await t.test('uses the latest open-rule transition for repeated source title and season', () => {
      const parsed = parseAutoMatchMappingRules([
        '一念永恒 S01E53->一念永恒 S02E01',
        '一念永恒 S01E107->一念永恒 S03E01',
        '一念永恒 S01E166->一念永恒 完结季 S01E01'
      ].join(';'));

      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 52 }), null);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 53 }).targetSeason, 2);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 106 }).targetEpisode, 54);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 107 }).targetSeason, 3);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 165 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 166 }).targetTitle, '一念永恒 完结季');
    });

    await t.test('maps match input, honors qualifiers and manual season preference, then falls back to original', async () => {
      const originalSearch = TencentSource.prototype.search;
      const originalHandleAnimes = TencentSource.prototype.handleAnimes;
      const originalGetComments = TencentSource.prototype.getComments;
      const originalAiAsk = AIClient.prototype.ask;
      const originalOrder = Globals.envs.sourceOrderArr;
      const originalAiValid = Globals.aiValid;
      let searchKeywords = [];
      let aiMatchInput = null;
      let scenario = 'open';

      TencentSource.prototype.search = async keyword => {
        searchKeywords.push(keyword);
        return [{ keyword }];
      };
      TencentSource.prototype.handleAnimes = async (_source, title, results, details) => {
        const add = anime => {
          results.push(anime);
          details.set(String(anime.animeId), anime);
        };
        if (scenario === 'fallback' && title === '缺失目标') return;
        if (scenario === 'qualified' && title === '航海王') {
          add(createFavoriteAnime('无关动漫(1999)【动漫】from tencent', 70, 930000));
          add(createFavoriteAnime('航海王(2000)【动漫】from tencent', 70, 930001));
          add(createFavoriteAnime('航海王(1999)【动漫】from tencent', 70, 930002));
          return;
        }
        if (scenario === 'platform') {
          const qqAnime = createFavoriteAnime(title, 2, 930004);
          const qiyiAnime = createFavoriteAnime(title, 2, 930005);
          qiyiAnime.source = 'iqiyi';
          qiyiAnime.links.forEach(link => { link.title = link.title.replace('【qq】', '【qiyi】'); });
          add(qqAnime);
          add(qiyiAnime);
          return;
        }
        if (scenario === 'naruto') {
          if (title === '火影忍者 疾风传') {
            add(createFavoriteAnime('火影忍者疾风传(2007)【动漫】from 360', 70, 930006));
          } else {
            add(createFavoriteAnime('火影忍者(2002)【动漫】from 360', 70, 930007));
          }
          return;
        }
        add(createFavoriteAnime(title, 70, 930003));
      };
      TencentSource.prototype.getComments = async () => [{ p: '1,1,16777215,test', m: 'mapping-test' }];
      Globals.envs.sourceOrderArr = ['tencent'];

      const runMatch = async (env, fileName, useAi = false) => {
        resetFavoriteState(env);
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.aiValid = useAi;
        const request = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName })
        });
        return parseResponse(await matchAnime(new URL(request.url), request, '127.0.0.1'));
      };

      try {
        searchKeywords = [];
        scenario = 'open';
        let body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S05E03');
        assert.equal(body.matches[0].episodeId, 9300030 + 59);
        assert.deepEqual(searchKeywords, ['永生']);
        await getComment(`/api/v2/comment/${body.matches[0].episodeId}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 5), false);
        await getComment(`/api/v2/comment/${9300030 + 60}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 5), true);
        assert.match(Globals.lastSelectMap.get('永生').offsets['5'], /^3:/);

        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S06E01');
        assert.equal(body.matches[0].episodeId, 9300030 + 1);
        await getComment(`/api/v2/comment/${body.matches[0].episodeId}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 6), false);

        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { default: 930003 },
          sourceBySeason: { default: 'tencent' }
        });
        const defaultPreferenceRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(defaultPreferenceRequest.url), defaultPreferenceRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 59);

        AIClient.prototype.ask = async prompt => {
          aiMatchInput = JSON.parse(prompt);
          return JSON.stringify({ animeIndex: 0 });
        };
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S05E03', true);
        assert.equal(body.matches[0].episodeId, 9300030 + 59);
        assert.deepEqual(
          { title: aiMatchInput.title, season: aiMatchInput.season, episode: aiMatchInput.episode },
          { title: '永生', season: 1, episode: 59 }
        );
        AIClient.prototype.ask = originalAiAsk;
        Globals.aiValid = false;

        scenario = 'qualified';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '海贼王 S02E01->航海王(1999)【动漫】 S01E62' }, '海贼王 S02E01');
        assert.equal(body.matches[0].animeId, 930002);
        assert.equal(body.matches[0].episodeId, 9300020 + 62);

        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '海贼王 S02E01->航海王(1998)【动漫】 S01E62' }, '海贼王 S02E01');
        assert.equal(body.matches[0].animeId, 930001);

        scenario = 'platform';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '航海王 S01E01->航海王 S01E01 @qiyi' }, '航海王 S01E01 @qq');
        assert.equal(body.matches[0].animeId, 930005);

        scenario = 'naruto';
        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('火影忍者', {
          animeIds: [930007],
          preferBySeason: { 1: 930007 },
          sourceBySeason: { 1: '360' },
          offsets: { 1: '58:【youku】 第58集' }
        });
        assert.equal(hasSeasonSpecificPreference('火影忍者', 1), false);
        const narutoRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '火影忍者 S01E58' })
        });
        body = await parseResponse(await matchAnime(new URL(narutoRequest.url), narutoRequest, '127.0.0.1'));
        assert.equal(body.matches[0].animeId, 930006);
        assert.equal(body.matches[0].episodeId, 9300060 + 60);

        scenario = 'open';
        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { 5: 930003 },
          sourceBySeason: { 5: 'tencent' },
          offsets: { 5: '2:【qq】 第10集' },
          explicitBySeason: { 5: true }
        });
        assert.equal(hasSeasonSpecificPreference('永生', 5), true);
        const manualRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(manualRequest.url), manualRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 11);
        assert.equal(Globals.lastSelectMap.get('永生').explicitBySeason['5'], true);

        resetFavoriteState({
          AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58',
          REMEMBER_LAST_SELECT: 'false'
        });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { 5: 930003 },
          sourceBySeason: { 5: 'tencent' },
          offsets: { 5: '2:【qq】 第10集' },
          explicitBySeason: { 5: true }
        });
        const disabledPreferenceRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(disabledPreferenceRequest.url), disabledPreferenceRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 59);

        searchKeywords = [];
        scenario = 'fallback';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '原始剧 S01E01->缺失目标 S01E01' }, '原始剧 S01E01');
        assert.equal(body.matches[0].animeTitle, '原始剧');
        assert.deepEqual(searchKeywords, ['缺失目标', '原始剧']);
      } finally {
        TencentSource.prototype.search = originalSearch;
        TencentSource.prototype.handleAnimes = originalHandleAnimes;
        TencentSource.prototype.getComments = originalGetComments;
        AIClient.prototype.ask = originalAiAsk;
        Globals.envs.sourceOrderArr = originalOrder;
        Globals.aiValid = originalAiValid;
      }
    });
  });

  await t.test('danmu text conversion should run after normalization and before filtering and grouping', () => {
    const baseEnv = {
      BLOCKED_WORDS: '',
      GROUP_MINUTE: '0',
      DANMU_LIMIT: '0',
      CONVERT_COLOR: 'default'
    };

    Globals.init({ ...baseEnv, DANMU_SIMPLIFIED_TRADITIONAL: 'simplified' });
    const simplified = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看能不能發彈幕' },
      { p: '2,1,16777215,[test]', m: '繁體彈幕' }
    ], 'bilibili1');
    assert.deepEqual(simplified.map(item => item.m), ['来看能不能发弹幕', '繁体弹幕']);

    Globals.init({
      ...baseEnv,
      DANMU_SIMPLIFIED_TRADITIONAL: 'simplified',
      BLOCKED_WORDS: '/来看/'
    });
    const filtered = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看' }
    ], 'bilibili1');
    assert.equal(filtered.length, 0);

    Globals.init({
      ...baseEnv,
      DANMU_SIMPLIFIED_TRADITIONAL: 'simplified',
      GROUP_MINUTE: '1'
    });
    const grouped = convertToDanmakuJson([
      { progress: 1000, mode: 1, color: 16777215, content: '來看' },
      { p: '2,1,16777215,[test]', m: '来看' }
    ], 'bilibili1');
    assert.equal(grouped.length, 1);
    assert.match(grouped[0].m, /^来看.*2$/);

    Globals.init({ ...baseEnv, DANMU_SIMPLIFIED_TRADITIONAL: 'traditional' });
    const traditional = convertToDanmakuJson([
      { p: '1,1,16777215,[test]', m: '来看能不能发弹幕' }
    ], 'test');
    assert.equal(traditional[0].m, '來看能不能發彈幕');

    resetSearchState();
  });

  await t.test('BLOCKED_WORDS 屏蔽词解析与过滤', async () => {
    const baseEnv = {
      GROUP_MINUTE: '0',
      DANMU_LIMIT: '0',
      CONVERT_COLOR: 'default'
    };
    const sample = [
      { timepoint: '1.00', ct: 1, color: 16777215, content: '前方剧透警告' },
      { timepoint: '2.00', ct: 1, color: 16777215, content: '测试弹幕一' },
      { timepoint: '3.00', ct: 1, color: 16777215, content: 'AD广告内容' },
      { timepoint: '4.00', ct: 1, color: 16777215, content: '正常弹幕' },
    ];

    const filterWith = async (blockedWords, expectGone, expectKeep = ['正常弹幕']) => {
      Globals.init({ ...baseEnv, BLOCKED_WORDS: blockedWords });
      const out = await convertToDanmakuJson(structuredClone(sample), 'test');
      const texts = out.map(d => d.m);
      for (const word of expectGone) {
        assert.ok(!texts.some(t => t.includes(word)), `「${word}」应被屏蔽，实际剩余: ${JSON.stringify(texts)}`);
      }
      for (const word of expectKeep) {
        assert.ok(texts.some(t => t.includes(word)), `「${word}」不应被误屏蔽，实际剩余: ${JSON.stringify(texts)}`);
      }
    };

    // 标准正则 / 纯文本词 / 全角逗号 / 正则带 i 标志 / 逗号带空格 / 混合写法
    await filterWith('/剧透/,/广告/', ['剧透', '广告']);
    await filterWith('剧透,广告', ['剧透', '广告']);
    await filterWith('/剧透/，/广告/', ['剧透', '广告']);
    await filterWith('/ad/i,/^测试/', ['AD广告', '测试']);
    await filterWith('/剧透/, /广告/', ['剧透', '广告']);
    await filterWith('/^测试/, 剧透 ，/广告/', ['剧透', '广告', '测试']);

    // README 官方示例兼容性：应解析出 16 个正则且不抛错
    const readmeSample = "/.{20,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\\u4e00-\\u9fa5])\\1{2,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{6,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{5,}$/,/^(\\d)\\1{2,}/,/^\\d{1,4}$/,/(20[0-3][0-9])/,/(0?[1-9]|1[0-2])月/,/\\d{1,2}[.-]\\d{1,2}/,/[@#&$%^*+\\|/\\-_=<>°◆◇■□●○★☆▼▲♥♦♠♣①②③④⑤⑥⑦⑧⑨⑩]/,/[一二三四五六七八九十百\\d]+刷/,/第[一二三四五六七八九十百\\d]+/,/(全体成员|报到|报道|来啦|签到|刷|打卡|我在|来了|考古|爱了|挖坟|留念|你好|回来|哦哦|重温|复习|重刷|再看|在看|前排|沙发|有人看|板凳|末排|我老婆|我老公|撅了|后排|周目|重看|包养|DVD|同上|同样|我也是|俺也|算我|爱豆|我家爱豆|我家哥哥|加我|三连|币|新人|入坑|补剧|冲了|硬了|看完|舔屏|万人|牛逼|煞笔|傻逼|卧槽|tm|啊这|哇哦)/";
    const segs = splitBlockedWords(readmeSample);
    assert.equal(segs.length, 16, `README 官方示例应解析出 16 条规则，实际 ${segs.length}`);
    const regexes = segs.map(parseBlockedWord);
    assert.ok(regexes.every(r => r instanceof RegExp), '所有词条均应解析为正则');

    resetSearchState();
  });

  await t.test('Upstash Redis persists favorites without storing search or comment caches', async () => {
    resetFavoriteState({
      UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
      LOG_LEVEL: 'error'
    });
    Globals.redisValid = true;
    Globals.redisCacheInitialized = false;
    Globals.lastHashes = {
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
        json: async () => commands.map(command => {
          if (command[0] === 'SET') {
            redisData.set(command[1], command[2]);
            return { result: 'OK' };
          }
          return { result: redisData.get(command[1]) ?? null };
        })
      };
    }, async () => {
      await updateRedisCaches();
      assert.ok(redisData.has('favoriteCache'));
      assert.equal(redisData.has('searchCache'), false);
      assert.equal(redisData.has('commentCache'), false);

      Globals.searchCache = new Map();
      Globals.commentCache = new Map();
      Globals.favoriteCache = new Map();
      Globals.redisCacheInitialized = false;
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

  await t.test('clearing runtime caches preserves favorites and auto match mapping configuration', async () => {
    resetFavoriteState({
      AUTO_MATCH_MAPPING_TABLE: '火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59',
      LOG_LEVEL: 'error'
    });
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

  await t.test('favorite cache', async t => {
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

    await t.test('frontend bundle contains working favorite controls', () => {
      assert.match(HTML_TEMPLATE, /id="manual-favorite-btn"/);
      assert.doesNotMatch(HTML_TEMPLATE, /id="auto-favorite-btn"/);
      assert.match(HTML_TEMPLATE, /id="favorite-panel"/);
      assert.match(HTML_TEMPLATE, /switchDanmuTestTab\('favorite'/);
      assert.match(apitestJsContent, /function favoriteManualSearch\(\)/);
      assert.match(apitestJsContent, /function setManualFavoriteButton/);
      assert.match(apitestJsContent, /取消收藏 · /);
      assert.match(apitestJsContent, /removing \? '\/api\/v2\/favorite\/remove'/);
      assert.match(apitestJsContent, /JSON\.stringify\(\{ keyword \}\)/);
      assert.match(apitestJsContent, /\/api\/v2\/favorite\/refresh/);
      assert.match(apitestJsContent, /\/api\/v2\/favorite\/remove/);
      assert.match(apitestJsContent, /最近刷新时间：/);
      assert.doesNotMatch(systemSettingsJsContent, /switchCategory\('favorite'\)/);
      assert.match(systemSettingsJsContent, /const isMergeSourcePairs = currentKey === 'MERGE_SOURCE_PAIRS'/);
      assert.match(systemSettingsJsContent, /preventDuplicateSources && selectedSourceTokens\.has\(value\)/);
      assert.match(systemSettingsJsContent, /String\(element\.dataset\.value \|\| ''\)\.split\('&'\)/);
      assert.doesNotThrow(() => new Function(apitestJsContent));
      assert.doesNotThrow(() => new Function(systemSettingsJsContent));
      assert.doesNotThrow(() => new Function(previewJsContent));
      assert.match(previewJsContent, /AUTO_MATCH_MAPPING_TABLE/);
    });

  await t.test('handleClearCache clears only the selected cache items', async t => {
    // 各清理项对应的全局状态种子；favorites 不在清理范围内，用于验证不被误清
    const seed = () => {
      Globals.animes = [{ id: 1 }];
      Globals.episodeIds = ['ep1'];
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

    await t.test('episodeNum resets to the initial value 10001', async () => {
      seed();
      const res = await handleClearCache({ json: async () => ({ items: ['episodeNum'] }) });
      const body = await parseResponse(res);
      assert.equal(body.success, true);
      assert.equal(body.clearedItems.episodeNum, 10001);
      assert.equal(Globals.episodeNum, 10001);
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

  await t.test('stripLinkOffset 解析 @偏移 后缀（@秒数 / @%百分比 / 无偏移 / 合并链接仅取末段）', async () => {
    assert.deepEqual(stripLinkOffset('https://x.com/v/1'), { cleanUrl: 'https://x.com/v/1', offset: 0, percent: false });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@3197'), { cleanUrl: 'https://x.com/v/1', offset: 3197, percent: false });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@%50'), { cleanUrl: 'https://x.com/v/1', offset: 50, percent: true });
    assert.deepEqual(stripLinkOffset('https://x.com/v/1@-50'), { cleanUrl: 'https://x.com/v/1', offset: -50, percent: false });
    // 合并链接仅从整条 URL 尾部取末段子链接的 @偏移
    const merged = 'https://x.com/v/A$$$https://x.com/v/B@3197';
    assert.deepEqual(stripLinkOffset(merged), { cleanUrl: 'https://x.com/v/A$$$https://x.com/v/B', offset: 3197, percent: false });
    // 容错：非字符串入参不抛错
    assert.deepEqual(stripLinkOffset(null), { cleanUrl: '', offset: 0, percent: false });
  });

  await t.test('applyOffset 应用 @偏移 的端点语义（绝对 = 时间+偏移，百分比端点 = 最大时间+偏移）', async () => {
    const danmus = [{ p: '10,1,16777215,b' }, { p: '20,1,16777215,b' }];
    // 绝对偏移：每条弹幕时间整体平移 offset 秒
    assert.deepEqual(applyOffset(danmus, 50).map(d => d.p), ['60.00,1,16777215,b', '70.00,1,16777215,b']);
    // 百分比偏移：按时间轴缩放，scaleRatio=(maxTime+offset)/maxTime，端点 maxTime → maxTime+offset
    assert.deepEqual(applyOffset(danmus, 50, { usePercent: true, videoDuration: 20 }).map(d => d.p), ['35.00,1,16777215,b', '70.00,1,16777215,b']);
    // 合并时长端点一致性：单链接时长 3266、偏移 3197 时，合并时间轴末端为 6463
    assert.equal(applyOffset([{ t: 3266 }], 3197, { usePercent: false, videoDuration: 3266 })[0].t, 6463);
  });
    
  // 测试 Bangumi Data 本地检索结果的同源去重
  await t.test('dedupeBangumiSearchResults should dedupe same-source results and skip tmdb', () => {
    const makeResult = (siteKey, siteId, titles) => ({ matchedSiteKey: siteKey, siteId, titles });

    // 同源多条目：保留标题精确命中检索词的一条，其余标题并入别名
    const merged = dedupeBangumiSearchResults([
      makeResult('anidb', '19242', ['Re：从零开始的异世界生活 第四季 丧失篇(2026)']),
      makeResult('anidb', '19242', ['Re：从零开始的异世界生活 第四季 夺还篇(2026)']),
    ], 'Re：从零开始的异世界生活 第四季 夺还篇(2026)');
    assert.equal(merged.length, 1, `Expected merged.length === 1, but got ${merged.length}`);
    assert.equal(merged[0].titles[0], 'Re：从零开始的异世界生活 第四季 夺还篇(2026)');
    assert.ok(merged[0].titles.includes('Re：从零开始的异世界生活 第四季 丧失篇(2026)'), 'Expected merged titles to include the secondary title');

    // tmdb 不参与去重，同 id 多条均保留
    const tmdbOnly = dedupeBangumiSearchResults([
      makeResult('tmdb', '123', ['标题A']),
      makeResult('tmdb', '123', ['标题B']),
    ], '检索词');
    assert.equal(tmdbOnly.length, 2, `Expected tmdbOnly.length === 2, but got ${tmdbOnly.length}`);

    // 不同源 id 空间重叠（同 siteId 不同 matchedSiteKey）不合并
    const crossSite = dedupeBangumiSearchResults([
      makeResult('anidb', '19242', ['丧失篇']),
      makeResult('bangumi', '19242', ['夺还篇']),
    ], '检索词');
    assert.equal(crossSite.length, 2, `Expected crossSite.length === 2, but got ${crossSite.length}`);
  });

  // await t.test('GET /api/v2/comment/:id?format=json&duration=true should return segment duration and reuse comment cache', async () => {
  //   Globals.init({});
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   Globals.commentCache = new Map();

  //   const originalTencentGetComments = TencentSource.prototype.getComments;
  //   let commentRequestCount = 0;
  //   let durationRequestCount = 0;

  //   TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     if (segmentFlag) {
  //       durationRequestCount++;
  //       return {
  //         type: 'qq',
  //         segmentList: [
  //           { type: 'qq', segment_start: 0, segment_end: 60, url: 'mock-1' },
  //           { type: 'qq', segment_start: 60, segment_end: 2760, url: 'mock-2' }
  //         ]
  //       };
  //     }

  //     commentRequestCount++;
  //     return [
  //       { p: '12.3,1,16777215,qq', m: '测试弹幕1' },
  //       { p: '45.6,1,16777215,qq', m: '测试弹幕2' }
  //     ];
  //   };

  //   try {
  //     const episode = addEpisode('https://v.qq.com/x/cover/a/b.html', '【qq】测试样例');
  //     const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
  //     const res = await handleRequest(req);
  //     const body = await parseResponse(res);
  //     const cachedRes = await handleRequest(req);
  //     const cachedBody = await parseResponse(cachedRes);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.videoDuration, 2760);
  //     assert.equal(body.count, 2);
  //     assert.equal(body.comments.length, 2);
  //     assert.equal(cachedRes.status, 200);
  //     assert.equal(cachedBody.videoDuration, 2760);
  //     assert.equal(commentRequestCount, 1);
  //     assert.equal(durationRequestCount, 2);
  //     assert.equal(Globals.commentCache.size, 1);
  //   } finally {
  //     TencentSource.prototype.getComments = originalTencentGetComments;
  //     Globals.episodeIds = [];
  //     Globals.commentCache = new Map();
  //   }
  // });

  // await t.test('GET /api/v2/comment/:id?format=json&duration=true should use merged max duration', async () => {
  //   Globals.init({});
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   Globals.commentCache = new Map();

  //   const originalTencentGetComments = TencentSource.prototype.getComments;
  //   const originalIqiyiGetComments = IqiyiSource.prototype.getComments;
  //   const originalYoukuGetComments = YoukuSource.prototype.getComments;

  //   TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     if (segmentFlag) {
  //       return {
  //         type: 'qq',
  //         segmentList: [
  //           { type: 'qq', segment_start: 0, segment_end: 2760, url: 'mock-qq' }
  //         ]
  //       };
  //     }
  //     return [
  //       { p: '12.3,1,16777215,qq', m: '腾讯弹幕' }
  //     ];
  //   };

  //   IqiyiSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     if (segmentFlag) {
  //       return {
  //         type: 'qiyi',
  //         segmentList: [
  //           { type: 'qiyi', segment_start: 0, segment_end: 1200, url: 'mock-qiyi-1' },
  //           { type: 'qiyi', segment_start: 1200, segment_end: 2682, url: 'mock-qiyi-2' }
  //         ]
  //       };
  //     }
  //     return [
  //       { p: '15.0,1,16777215,qiyi', m: '爱奇艺弹幕' }
  //     ];
  //   };

  //   YoukuSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     if (segmentFlag) {
  //       return {
  //         type: 'youku',
  //         segmentList: [
  //           { type: 'youku', segment_start: 0, segment_end: 1800, url: 'mock-youku-1' },
  //           { type: 'youku', segment_start: 1800, segment_end: 3000, url: 'mock-youku-2' }
  //         ]
  //       };
  //     }
  //     return [
  //       { p: '18.0,1,16777215,youku', m: '优酷弹幕' }
  //     ];
  //   };

  //   try {
  //     const episode = addEpisode(
  //       'tencent:https://v.qq.com/x/cover/a/b.html$$$iqiyi:https://www.iqiyi.com/v_test.html$$$youku:https://v.youku.com/v_show/id_test.html',
  //       '【qq＆qiyi＆youku】合并测试'
  //     );
  //     const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
  //     const res = await handleRequest(req);
  //     const body = await parseResponse(res);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.videoDuration, 3000);
  //     assert.ok(Array.isArray(body.comments));
  //   } finally {
  //     TencentSource.prototype.getComments = originalTencentGetComments;
  //     IqiyiSource.prototype.getComments = originalIqiyiGetComments;
  //     YoukuSource.prototype.getComments = originalYoukuGetComments;
  //     Globals.episodeIds = [];
  //     Globals.commentCache = new Map();
  //   }
  // });

  // await t.test('GET /api/v2/comment/:id?format=json&duration=true should prefer explicit duration field', async () => {
  //   Globals.init({});
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   Globals.commentCache = new Map();

  //   const originalBilibiliGetComments = BilibiliSource.prototype.getComments;
  //   BilibiliSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     if (segmentFlag) {
  //       return new SegmentListResponse({
  //         type: 'bilibili1',
  //         duration: 1312.76,
  //         segmentList: [
  //           { type: 'bilibili1', segment_start: 0, segment_end: 360, url: 'mock-bili-1' },
  //           { type: 'bilibili1', segment_start: 360, segment_end: 720, url: 'mock-bili-2' },
  //           { type: 'bilibili1', segment_start: 720, segment_end: 1080, url: 'mock-bili-3' },
  //           { type: 'bilibili1', segment_start: 1080, segment_end: 1440, url: 'mock-bili-4' }
  //         ]
  //       });
  //     }
  //     return [
  //       { p: '20.0,1,16777215,bilibili1', m: 'B站弹幕1' },
  //       { p: '30.0,1,16777215,bilibili1', m: 'B站弹幕2' }
  //     ];
  //   };

  //   try {
  //     const episode = addEpisode('https://www.bilibili.com/bangumi/play/ep_test.html', '【bilibili】测试样例');
  //     const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
  //     const res = await handleRequest(req);
  //     const body = await parseResponse(res);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.videoDuration, 1312.76);
  //     assert.equal(body.count, 2);
  //   } finally {
  //     BilibiliSource.prototype.getComments = originalBilibiliGetComments;
  //     Globals.episodeIds = [];
  //     Globals.commentCache = new Map();
  //   }
  // });

  // await t.test('GET /api/v2/bangumi/:id should resolve details from search cache after global eviction', async () => {
  //   Globals.init({});
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   Globals.searchCache = new Map();
  //   Globals.requestHistory = new Map();
  //   Globals.envs.rateLimitMaxRequests = 0;
  //   delete Globals.requestAnimeDetailsMap;

  //   const cachedAnime = {
  //     animeId: 500001,
  //     bangumiId: '500001',
  //     animeTitle: '缓存详情番剧',
  //     type: 'tvseries',
  //     typeDescription: 'TV',
  //     imageUrl: 'https://example.com/poster.jpg',
  //     startDate: '2024-01-01T00:00:00.000Z',
  //     episodeCount: 2,
  //     rating: 0,
  //     isFavorited: true,
  //     source: 'tencent',
  //     links: [
  //       { id: 30001, url: 'https://v.qq.com/x/cover/cache/ep1.html', title: '【qq】 第1集' },
  //       { id: 30002, url: 'https://v.qq.com/x/cover/cache/ep2.html', title: '【qq】 第2集' }
  //     ]
  //   };

  //   Globals.searchCache.set('缓存详情番剧', {
  //     results: [
  //       {
  //         animeId: cachedAnime.animeId,
  //         bangumiId: cachedAnime.bangumiId,
  //         animeTitle: cachedAnime.animeTitle,
  //         type: cachedAnime.type,
  //         typeDescription: cachedAnime.typeDescription,
  //         imageUrl: cachedAnime.imageUrl,
  //         startDate: cachedAnime.startDate,
  //         episodeCount: cachedAnime.episodeCount,
  //         rating: cachedAnime.rating,
  //         isFavorited: cachedAnime.isFavorited,
  //         source: cachedAnime.source
  //       }
  //     ],
  //     details: [cachedAnime],
  //     timestamp: Date.now()
  //   });

  //   const req = new MockRequest(urlPrefix + '/api/v2/bangumi/' + cachedAnime.animeId, { method: 'GET' });
  //   const res = await handleRequest(req);
  //   const body = await parseResponse(res);

  //   assert.equal(res.status, 200);
  //   assert.equal(body.success, true);
  //   assert.equal(body.bangumi.animeTitle, cachedAnime.animeTitle);
  //   assert.equal(body.bangumi.episodes.length, 2);
  //   assert.equal(body.bangumi.episodes[0].episodeId, 30001);
  //   assert.equal(Globals.animes.length, 0);
  //   assert.equal(Globals.episodeIds.length, 0);
  // });

  // await t.test('GET /api/v2/comment/:id should resolve cached episode context after global eviction', async () => {
  //   Globals.init({});
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   Globals.searchCache = new Map();
  //   Globals.commentCache = new Map();
  //   Globals.requestHistory = new Map();
  //   Globals.envs.rateLimitMaxRequests = 0;
  //   delete Globals.requestAnimeDetailsMap;

  //   const cachedAnime = {
  //     animeId: 500002,
  //     bangumiId: '500002',
  //     animeTitle: '缓存弹幕番剧',
  //     type: 'tvseries',
  //     typeDescription: 'TV',
  //     imageUrl: 'https://example.com/poster2.jpg',
  //     startDate: '2024-01-01T00:00:00.000Z',
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: true,
  //     source: 'tencent',
  //     links: [
  //       { id: 31001, url: 'https://v.qq.com/x/cover/cache/comment-ep1.html', title: '【qq】 第1集' }
  //     ]
  //   };

  //   Globals.searchCache.set('缓存弹幕番剧', {
  //     results: [
  //       {
  //         animeId: cachedAnime.animeId,
  //         bangumiId: cachedAnime.bangumiId,
  //         animeTitle: cachedAnime.animeTitle,
  //         type: cachedAnime.type,
  //         typeDescription: cachedAnime.typeDescription,
  //         imageUrl: cachedAnime.imageUrl,
  //         startDate: cachedAnime.startDate,
  //         episodeCount: cachedAnime.episodeCount,
  //         rating: cachedAnime.rating,
  //         isFavorited: cachedAnime.isFavorited,
  //         source: cachedAnime.source
  //       }
  //     ],
  //     details: [cachedAnime],
  //     timestamp: Date.now()
  //   });

  //   const originalTencentGetComments = TencentSource.prototype.getComments;
  //   let requestCount = 0;

  //   TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
  //     requestCount++;
  //     assert.equal(url, cachedAnime.links[0].url);
  //     assert.equal(plat, 'qq');
  //     assert.equal(segmentFlag, false);
  //     return [
  //       { p: '12.3,1,16777215,qq', m: '缓存弹幕命中' }
  //     ];
  //   };

  //   try {
  //     const req = new MockRequest(urlPrefix + '/api/v2/comment/' + cachedAnime.links[0].id + '?format=json', { method: 'GET' });
  //     const res = await handleRequest(req);
  //     const body = await parseResponse(res);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.count, 1);
  //     assert.equal(body.comments[0].m, '缓存弹幕命中');
  //     assert.equal(requestCount, 1);
  //     assert.equal(Globals.animes.length, 0);
  //     assert.equal(Globals.episodeIds.length, 0);
  //   } finally {
  //     TencentSource.prototype.getComments = originalTencentGetComments;
  //     Globals.commentCache = new Map();
  //   }
  // });
  // await t.test('GET /api/v2/bangumi/:id should prefer latest cached detail snapshot', async () => {
  //   resetSearchState();

  //   const oldAnime = {
  //     animeId: 500003,
  //     bangumiId: "500003",
  //     animeTitle: "旧缓存详情番剧",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "https://example.com/old-poster.jpg",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: true,
  //     source: "tencent",
  //     links: [
  //       { id: 32001, url: "https://v.qq.com/x/cover/cache-old/ep1.html", title: "【qq】 旧快照 第1集" }
  //     ]
  //   };

  //   const latestAnime = {
  //     ...oldAnime,
  //     animeTitle: "新缓存详情番剧",
  //     episodeCount: 2,
  //     links: [
  //       { id: 32002, url: "https://v.qq.com/x/cover/cache-new/ep1.html", title: "【qq】 新快照 第1集" },
  //       { id: 32003, url: "https://v.qq.com/x/cover/cache-new/ep2.html", title: "【qq】 新快照 第2集" }
  //     ]
  //   };

  //   Globals.searchCache.set("旧缓存详情番剧", {
  //     results: [createSearchResult(oldAnime)],
  //     details: [oldAnime],
  //     timestamp: Date.now() - 5_000
  //   });
  //   Globals.searchCache.set("新缓存详情番剧", {
  //     results: [createSearchResult(latestAnime)],
  //     details: [latestAnime],
  //     timestamp: Date.now()
  //   });

  //   const req = new MockRequest(urlPrefix + "/api/v2/bangumi/" + latestAnime.animeId, { method: "GET" });
  //   const res = await handleRequest(req);
  //   const body = await parseResponse(res);

  //   assert.equal(res.status, 200);
  //   assert.equal(body.success, true);
  //   assert.equal(body.bangumi.animeTitle, latestAnime.animeTitle);
  //   assert.equal(body.bangumi.episodes.length, 2);
  //   assert.equal(body.bangumi.episodes[0].episodeId, 32002);
  //   assert.equal(body.bangumi.episodes[1].episodeId, 32003);
  // });

  // await t.test('GET /api/v2/search/episodes should keep colliding cached details separated', async () => {
  //   resetSearchState();

  //   const renrenAnime = {
  //     animeId: 888,
  //     bangumiId: "123",
  //     animeTitle: "缓存冲突番剧A",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "https://example.com/renren.jpg",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: true,
  //     source: "renren",
  //     links: [
  //       { id: 33001, url: "renren://cache-a-ep1", title: "【renren】 第1集" }
  //     ]
  //   };

  //   const iqiyiAnime = {
  //     animeId: 123,
  //     bangumiId: "999",
  //     animeTitle: "缓存冲突番剧B",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "https://example.com/iqiyi.jpg",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: true,
  //     source: "iqiyi",
  //     links: [
  //       { id: 33002, url: "https://www.iqiyi.com/v_cache_b.html", title: "【qiyi】 第1集" }
  //     ]
  //   };

  //   const keyword = "缓存冲突测试";
  //   Globals.searchCache.set(keyword, {
  //     results: [createSearchResult(renrenAnime), createSearchResult(iqiyiAnime)],
  //     details: [renrenAnime, iqiyiAnime],
  //     timestamp: Date.now()
  //   });

  //   const req = new MockRequest(urlPrefix + "/api/v2/search/episodes?anime=" + encodeURIComponent(keyword), { method: "GET" });
  //   const res = await handleRequest(req);
  //   const body = await parseResponse(res);

  //   assert.equal(res.status, 200);
  //   assert.equal(body.success, true);
  //   assert.equal(body.animes.length, 2);

  //   const renrenResult = body.animes.find(item => item.animeId === renrenAnime.animeId);
  //   const iqiyiResult = body.animes.find(item => item.animeId === iqiyiAnime.animeId);

  //   assert.ok(renrenResult);
  //   assert.ok(iqiyiResult);
  //   assert.equal(renrenResult.episodes.length, 1);
  //   assert.equal(renrenResult.episodes[0].episodeId, renrenAnime.links[0].id);
  //   assert.equal(renrenResult.episodes[0].episodeTitle, renrenAnime.links[0].title);
  //   assert.equal(iqiyiResult.episodes.length, 1);
  //   assert.equal(iqiyiResult.episodes[0].episodeId, iqiyiAnime.links[0].id);
  //   assert.equal(iqiyiResult.episodes[0].episodeTitle, iqiyiAnime.links[0].title);
  // });

  // await t.test('GET /api/v2/search/episodes should ignore polluted global detail cache state', async () => {
  //   resetSearchState();

  //   const cachedAnime = {
  //     animeId: 700001,
  //     bangumiId: "700001",
  //     animeTitle: "全局污染回归番剧",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "https://example.com/cache-correct.jpg",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: true,
  //     source: "tencent",
  //     links: [
  //       { id: 34001, url: "https://v.qq.com/x/cover/cache-correct/ep1.html", title: "【qq】 正确第1集" }
  //     ]
  //   };

  //   const pollutedAnime = {
  //     ...cachedAnime,
  //     animeTitle: "错误污染番剧",
  //     links: [
  //       { id: 34999, url: "https://v.qq.com/x/cover/cache-polluted/ep1.html", title: "【qq】 错误第1集" }
  //     ]
  //   };

  //   const keyword = "全局污染测试";
  //   Globals.searchCache.set(keyword, {
  //     results: [createSearchResult(cachedAnime)],
  //     details: [cachedAnime],
  //     timestamp: Date.now()
  //   });
  //   Globals.requestAnimeDetailsMap = new Map([
  //     [String(cachedAnime.bangumiId), pollutedAnime],
  //     [String(cachedAnime.animeId), pollutedAnime]
  //   ]);

  //   try {
  //     const req = new MockRequest(urlPrefix + "/api/v2/search/episodes?anime=" + encodeURIComponent(keyword), { method: "GET" });
  //     const res = await handleRequest(req);
  //     const body = await parseResponse(res);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.success, true);
  //     assert.equal(body.animes.length, 1);
  //     assert.equal(body.animes[0].animeId, cachedAnime.animeId);
  //     assert.equal(body.animes[0].episodes[0].episodeId, cachedAnime.links[0].id);
  //     assert.equal(body.animes[0].episodes[0].episodeTitle, cachedAnime.links[0].title);
  //   } finally {
  //     delete Globals.requestAnimeDetailsMap;
  //   }
  // });

  // await t.test('POST /api/v2/match should ignore polluted global anime details and use current search snapshot', async () => {
  //   resetSearchState();

  //   const correctLinks = Array.from({ length: 50 }, (_, index) => ({
  //     id: 35001 + index,
  //     url: `https://www.iqiyi.com/v_match_correct_${index + 1}.html`,
  //     title: `【qiyi】 太平年第${index + 1}集`
  //   }));

  //   const cachedAnime = {
  //     animeId: 700002,
  //     bangumiId: "700002",
  //     animeTitle: "太平年(2024)【TV】from iqiyi",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "https://example.com/tp.jpg",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 50,
  //     rating: 0,
  //     isFavorited: true,
  //     source: "iqiyi",
  //     links: correctLinks
  //   };

  //   const pollutedAnime = {
  //     ...cachedAnime,
  //     links: correctLinks.map(link => ({ ...link }))
  //   };
  //   pollutedAnime.links[41] = {
  //     id: 35999,
  //     url: "https://www.iqiyi.com/v_match_polluted_45.html",
  //     title: "【qiyi】 太平年第45集 金陵落日"
  //   };

  //   Globals.searchCache.set("太平年", {
  //     results: [createSearchResult(cachedAnime)],
  //     details: [cachedAnime],
  //     timestamp: Date.now()
  //   });
  //   Globals.animes = [pollutedAnime];

  //   const req = {
  //     url: urlPrefix + "/api/v2/match",
  //     async json() {
  //       return {
  //         fileName: "太平年 S01E42"
  //       };
  //     }
  //   };

  //   const res = await matchAnime(new URL(req.url), req, "127.0.0.1");
  //   const body = await parseResponse(res);

  //   assert.equal(res.status, 200);
  //   assert.equal(body.success, true);
  //   assert.equal(body.isMatched, true);
  //   assert.equal(body.matches.length, 1);
  //   assert.equal(body.matches[0].episodeId, cachedAnime.links[41].id);
  //   assert.equal(body.matches[0].episodeTitle, cachedAnime.links[41].title);
  // });

  // await t.test('GET /api/v2/search/anime should filter by request snapshot instead of collided runtime animeId state', async () => {
  //   resetSearchState();

  //   const originalTencentSearch = TencentSource.prototype.search;
  //   const originalTencentHandleAnimes = TencentSource.prototype.handleAnimes;
  //   const originalIqiyiSearch = IqiyiSource.prototype.search;
  //   const originalIqiyiHandleAnimes = IqiyiSource.prototype.handleAnimes;
  //   const originalSourceOrderArr = Array.isArray(Globals.envs.sourceOrderArr) ? [...Globals.envs.sourceOrderArr] : Globals.envs.sourceOrderArr;
  //   const originalEnableAnimeEpisodeFilter = Globals.envs.enableAnimeEpisodeFilter;
  //   const originalEpisodeTitleFilter = Globals.envs.episodeTitleFilter;
  //   const originalAnimeTitleFilter = Globals.envs.animeTitleFilter;

  //   const sharedAnimeId = 880001;
  //   const tencentAnime = {
  //     animeId: sharedAnimeId,
  //     bangumiId: "tx-880001",
  //     animeTitle: "同ID跨源番剧",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: false,
  //     source: "tencent",
  //     links: [
  //       { url: "https://v.qq.com/x/cover/collision/ep1.html", title: "【qq】 正片第1集" }
  //     ]
  //   };
  //   const iqiyiAnime = {
  //     animeId: sharedAnimeId,
  //     bangumiId: "iqiyi-880001",
  //     animeTitle: "同ID跨源番剧",
  //     type: "tvseries",
  //     typeDescription: "TV",
  //     imageUrl: "",
  //     startDate: "2024-01-01T00:00:00.000Z",
  //     episodeCount: 1,
  //     rating: 0,
  //     isFavorited: false,
  //     source: "iqiyi",
  //     links: [
  //       { url: "https://www.iqiyi.com/v_collision_extra.html", title: "【qiyi】 花絮" }
  //     ]
  //   };

  //   Globals.envs.sourceOrderArr = ["tencent", "iqiyi"];
  //   Globals.envs.enableAnimeEpisodeFilter = true;
  //   Globals.envs.episodeTitleFilter = /花絮/;
  //   Globals.envs.animeTitleFilter = null;

  //   TencentSource.prototype.search = async () => [createSearchResult(tencentAnime)];
  //   TencentSource.prototype.handleAnimes = async (_results, _queryTitle, curAnimes, detailStore) => {
  //     curAnimes.push(createSearchResult(tencentAnime));
  //     addAnime(tencentAnime, detailStore);
  //   };
  //   IqiyiSource.prototype.search = async () => [createSearchResult(iqiyiAnime)];
  //   IqiyiSource.prototype.handleAnimes = async (_results, _queryTitle, curAnimes, detailStore) => {
  //     curAnimes.push(createSearchResult(iqiyiAnime));
  //     addAnime(iqiyiAnime, detailStore);
  //   };

  //   try {
  //     const req = new MockRequest(urlPrefix + "/api/v2/search/anime?keyword=" + encodeURIComponent("同ID跨源番剧"), { method: "GET" });
  //     const res = await searchAnime(new URL(req.url), null, null, new Map());
  //     const body = await parseResponse(res);

  //     assert.equal(res.status, 200);
  //     assert.equal(body.success, true);
  //     assert.equal(body.animes.length, 1);
  //     assert.equal(body.animes[0].animeId, tencentAnime.animeId);
  //     assert.equal(body.animes[0].source, tencentAnime.source);
  //     assert.equal(body.animes[0].animeTitle, tencentAnime.animeTitle);
  //   } finally {
  //     TencentSource.prototype.search = originalTencentSearch;
  //     TencentSource.prototype.handleAnimes = originalTencentHandleAnimes;
  //     IqiyiSource.prototype.search = originalIqiyiSearch;
  //     IqiyiSource.prototype.handleAnimes = originalIqiyiHandleAnimes;
  //     Globals.envs.sourceOrderArr = Array.isArray(originalSourceOrderArr) ? [...originalSourceOrderArr] : originalSourceOrderArr;
  //     Globals.envs.enableAnimeEpisodeFilter = originalEnableAnimeEpisodeFilter;
  //     Globals.envs.episodeTitleFilter = originalEpisodeTitleFilter;
  //     Globals.envs.animeTitleFilter = originalAnimeTitleFilter;
  //   }
  // });
  // await t.test('Test ai cilent', async () => {
  //   const ai = new AIClient({
  //     apiKey: 'xxxxxxxxxxxxxxxxxxxxx',
  //     baseURL: 'https://open.bigmodel.cn/api/paas/v4', // 换成任意兼容 OpenAI 协议的地址
  //     model: 'GLM-4.7-FlashX',
  //     systemPrompt: '回答尽量简洁',
  //   })

  //   // const answer = await ai.ask('你好')
  //   // console.log(answer);

  //   const status = await ai.verify()
  //   if (status.ok) {
  //     console.log('连接正常:', status)
  //   } else {
  //     console.log('连接失败:', status.error)
  //   }
  // });

  // await t.test('GET tencent danmu', async () => {
  //   const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET tencent danmu segments', async () => {
  //   const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq", true);
  //   assert(res.type === "qq", `Expected res.type === "qq", but got ${res.type === "qq"}`);
  //   assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET tencent segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "qq",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://dm.video.qq.com/barrage/segment/j0032ubhl9s/t/v1/30000/60000"
  //   });
  //   const res = await tencentSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi danmu', async () => {
  //   const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi danmu segments', async () => {
  //   const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi", true);
  //   assert(res.type === "qiyi", `Expected res.type === "qiyi", but got ${res.type === "qiyi"}`);
  //   assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "qiyi",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://cmts.iqiyi.com/bullet/80/00/5284367795028000_300_4.z?rn=0.0123456789123456&business=danmu&is_iqiyi=true&is_video_page=true&tvid=5284367795028000&albumid=2524115110632101&categoryid=2&qypid=010102101000000000"
  //   });
  //   const res = await iqiyiSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET mango danmu', async () => {
  //   const res = await mangoSource.getComments("https://www.mgtv.com/b/771610/23300622.html", "imgo");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET mango danmu segments', async () => {
  //   const res = await mangoSource.getComments("https://www.mgtv.com/b/771610/23300622.html", "imgo", true);
  //   assert(res.type === "imgo", `Expected res.type === "imgo", but got ${res.type}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET mango segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "imgo",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://bullet-ali.hitv.com/bullet/tx/2025/12/14/011640/23300622/23.json"
  //   });
  //   const res = await mangoSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET bilibili danmu', async () => {
  //   const res = await bilibiliSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564", "bilibili1");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET bilibili danmu segments', async () => {
  //   const res = await bilibiliSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564", "bilibili1", true);
  //   assert(res.type === "bilibili1", `Expected res.type === "bilibili1", but got ${res.type}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET bilibili segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "bilibili1",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=32131450212&segment_index=2"
  //   });
  //   const res = await bilibiliSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET youku danmu', async () => {
  //   const res = await youkuSource.getComments("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET youku danmu segments', async () => {
  //   const res = await youkuSource.getComments("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html", "youku", true);
  //   assert(res.type === "youku", `Expected res.type === "youku", but got ${res.type === "youku"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET youku segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "youku",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/?jsv=2.5.6&appKey=24679788&t=1765980205381&sign=355caad7d41ec0bf445cce48fce4d93e&api=mopen.youku.danmu.list&v=1.0&type=originaljson&dataType=jsonp&timeout=20000&jsonpIncPrefix=utility",
  //     "data": "{\"ctime\":1765980205380,\"ctype\":10004,\"cver\":\"v1.0\",\"guid\":\"JqbJIT/Q0XMCAXPAGpb9gBcg\",\"mat\":0,\"mcount\":1,\"pid\":0,\"sver\":\"3.1.0\",\"type\":1,\"vid\":\"XNjQ3ODMyNjU3Mg==\",\"msg\":\"eyJjdGltZSI6MTc2NTk4MDIwNTM4MCwiY3R5cGUiOjEwMDA0LCJjdmVyIjoidjEuMCIsImd1aWQiOiJKcWJKSVQvUTBYTUNBWFBBR3BiOWdCY2ciLCJtYXQiOjAsIm1jb3VudCI6MSwicGlkIjowLCJzdmVyIjoiMy4xLjAiLCJ0eXBlIjoxLCJ2aWQiOiJYTmpRM09ETXlOalUzTWc9PSJ9\",\"sign\":\"b94e1d2cf6dc1ffcf80845b0ea82b7ef\"}",
  //     "_m_h5_tk": "d12df59d06f2830de1c681e04285a895_1765985058907",
  //     "_m_h5_tk_enc": "082c6cbbad97b5b48b7798a51933bbfa"
  //   });
  //   const res = await youkuSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET migu danmu', async () => {
  //   const res = await miguSource.getComments("https://www.miguvideo.com/p/detail/725117610", "migu");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET migu danmu segments', async () => {
  //   const res = await miguSource.getComments("https://www.miguvideo.com/p/detail/725117610", "migu", true);
  //   console.log(res.segmentList);
  //   assert(res.type === "migu", `Expected res.type === "migu", but got ${res.type === "migu"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET migu segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'migu',
  //     segment_start: 0,
  //     segment_end: 300,
  //     url: 'https://webapi.miguvideo.com/gateway/live_barrage/videox/barrage/v2/list/760834922/760835542/0/30/020',
  //   });
  //   const res = await miguSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET sohu danmu', async () => {
  //   const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET sohu danmu segments', async () => {
  //   const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html", "sohu", true);
  //   assert(res.type === "sohu", `Expected res.type === "sohu", but got ${res.type === "sohu"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET sohu segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'sohu',
  //     segment_start: 3000,
  //     segment_end: 3300,
  //     url: 'https://api.danmu.tv.sohu.com/dmh5/dmListAll?act=dmlist_v2&vid=2547437&aid=8345543&pct=2&time_begin=3000&time_end=3300&dct=1&request_from=h5_js',
  //   });
  //   const res = await sohuSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET leshi danmu', async () => {
  //   const res = await leshiSource.getComments("https://www.le.com/ptv/vplay/1578861.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET leshi danmu segments', async () => {
  //   const res = await leshiSource.getComments("https://www.le.com/ptv/vplay/1578861.html", "leshi", true);
  //   assert(res.type === "leshi", `Expected res.type === "leshi", but got ${res.type === "leshi"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET leshi segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'leshi',
  //     segment_start: 1800,
  //     segment_end: 2100,
  //     url: 'https://hd-my.le.com/danmu/list?vid=1578861&start=1800&end=2100&callback=vjs_1768494351290',
  //   });
  //   const res = await leshiSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET xigua danmu', async () => {
  //   const res = await xiguaSource.getComments("https://m.ixigua.com/video/6551333775337325060", "xigua");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET xigua danmu segments', async () => {
  //   const res = await xiguaSource.getComments("https://m.ixigua.com/video/6551333775341519368", "xigua", true);
  //   assert(res.type === "xigua", `Expected res.type === "xigua", but got ${res.type === "xigua"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET xigua segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'xigua',
  //     segment_start: 1200000,
  //     segment_end: 1500000,
  //     url: 'https://ib.snssdk.com/vapp/danmaku/list/v1/?item_id=6551333775341519368&start_time=1200000&end_time=1500000&format=json'
  //   });
  //   const res = await xiguaSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET maiduidui danmu', async () => {
  //   const res = await maiduiduiSource.getComments("https://www.mddcloud.com.cn/video/ff8080817410d5a5017490f5f4d311de.html?num=2&uuid=ff8080817410d5a5017490f5f4d311e0", "maiduidui");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET maiduidui danmu segments', async () => {
  //   const res = await maiduiduiSource.getComments("https://www.mddcloud.com.cn/video/ff8080817410d5a5017490f5f4d311de.html?num=2&uuid=ff8080817410d5a5017490f5f4d311e0", "maiduidui", true);
  //   console.log(res.segmentList);
  //   assert(res.type === "maiduidui", `Expected res.type === "maiduidui", but got ${res.type === "maiduidui"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET maiduidui segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'maiduidui',
  //     segment_start: 120,
  //     segment_end: 180,
  //     url: 'https://www.mddcloud.com.cn/video/ff8080817410d5a5017490f5f4d311de.html?num=2&uuid=ff8080817410d5a5017490f5f4d311e0'
  //   });
  //   const res = await maiduiduiSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET aiyifan danmu', async () => {
  //   const res = await aiyifanSource.getComments("https://www.yfsp.tv/play/E4si52uysIH?id=dpK7e0uLKe2", "aiyifan");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET aiyifan danmu segments', async () => {
  //   const res = await aiyifanSource.getComments("https://www.yfsp.tv/play/E4si52uysIH?id=dpK7e0uLKe2", "aiyifan", true);
  //   console.log(res.segmentList);
  //   assert(res.type === "aiyifan", `Expected res.type === "aiyifan", but got ${res.type === "aiyifan"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET aiyifan segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'aiyifan',
  //     segment_start: 0,
  //     segment_end: 0,
  //     url: 'https://app-m10.tripdata.app/api/video/getBarrage?uniqueKey=https://www.yfsp.tv/play/E4si52uysIH?id=dpK7e0uLKe2'
  //   });
  //   const res = await aiyifanSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET hongguo danmu', async () => {
  //   const episodeId = 'hongguo:v1:series-1:vid-1:60';
  //   const originalFetchCommentWindow = hongguoSource.fetchCommentWindow;
  //   hongguoSource.fetchCommentWindow = async (_info, startMs) => ({
  //     comments: startMs === 0
  //       ? [{ commentId: 'comment-1', offsetMs: 1500, text: 'first', diggCount: 7 }]
  //       : [
  //           { commentId: 'comment-1', offsetMs: 1500, text: 'first', diggCount: 7 },
  //           { commentId: 'comment-2', offsetMs: 31500, text: 'second', diggCount: 3 },
  //         ],
  //     nextStart: startMs + 30000,
  //     cursor: `cursor-${startMs}`,
  //     hasMore: true,
  //   });
  //   try {
  //     const res = await hongguoSource.getComments(episodeId, 'hongguo');
  //     assert.equal(res.length, 2);
  //     assert.deepEqual(res.map((item) => item.t), [1.5, 31.5]);
  //     assert.match(res[0].p, /\[hongguo\]$/);
  //   } finally {
  //     hongguoSource.fetchCommentWindow = originalFetchCommentWindow;
  //   }
  // });

  // await t.test('GET hongguo danmu segments', async () => {
  //   const episodeId = 'hongguo:v1:series-1:vid-1:60';
  //   const res = await hongguoSource.getComments(episodeId, 'hongguo', true);
  //   assert.equal(res.type, 'hongguo');
  //   assert.equal(res.duration, 60);
  //   assert.equal(res.segmentList.length, 2);
  //   assert.notEqual(res.segmentList[0].url, res.segmentList[1].url);
  // });

  // await t.test('GET hongguo segment danmu', async () => {
  //   const originalFetchCommentWindow = hongguoSource.fetchCommentWindow;
  //   hongguoSource.fetchCommentWindow = async () => ({
  //     comments: [
  //       { commentId: 'before', offsetMs: 29999, text: 'before', diggCount: 0 },
  //       { commentId: 'inside', offsetMs: 31500, text: 'inside', diggCount: 2 },
  //       { commentId: 'after', offsetMs: 60000, text: 'after', diggCount: 0 },
  //     ],
  //     nextStart: 60000,
  //     cursor: '',
  //     hasMore: false,
  //   });
  //   try {
  //     const segment = Segment.fromJson({
  //       type: 'hongguo',
  //       segment_start: 30,
  //       segment_end: 60,
  //       url: 'hongguo:v1:series-1:vid-1:60#segment=30',
  //     });
  //     const res = await hongguoSource.getSegmentComments(segment);
  //     assert.equal(res.length, 1);
  //     assert.equal(res[0].m, 'inside');
  //     assert.equal(res[0].t, 31.5);
  //   } finally {
  //     hongguoSource.fetchCommentWindow = originalFetchCommentWindow;
  //   }
  // });

  // await t.test('Hongguo player URL should resolve the exact episode', async () => {
  //   const playerUrl = 'https://hongguoduanju.com/player/7572458140411628568/7572460055539223614';
  //   assert.deepEqual(parseHongguoPlayerUrl(playerUrl), {
  //     seriesId: '7572458140411628568',
  //     vid: '7572460055539223614',
  //   });

  //   const source = new HongguoSource();
  //   let requestedSeriesId = '';
  //   let detailRequests = 0;
  //   source.getEpisodes = async (seriesId) => {
  //     detailRequests++;
  //     requestedSeriesId = seriesId;
  //     return {
  //       episodes: [
  //         { index: 1, vid: '7572459982168280126', duration: 150 },
  //         { index: 2, vid: '7572460055539223614', duration: 119 },
  //       ],
  //       imageUrl: '',
  //     };
  //   };

  //   const segments = await source.getComments(playerUrl, 'hongguo', true);
  //   assert.equal(requestedSeriesId, '7572458140411628568');
  //   assert.equal(segments.duration, 119);
  //   assert.equal(segments.segmentList.length, 4);
  //   assert.equal(
  //     segments.segmentList[0].url,
  //     'hongguo:v1:7572458140411628568:7572460055539223614:119#segment=0',
  //   );

  //   source.fetchCommentWindow = async (info) => {
  //     assert.equal(info.vid, '7572460055539223614');
  //     return {
  //       comments: [{ commentId: 'link-comment', offsetMs: 1500, text: '链接弹幕', diggCount: 2 }],
  //       nextStart: 119000,
  //       cursor: '',
  //       hasMore: false,
  //     };
  //   };
  //   const comments = await source.getComments(playerUrl, 'hongguo');
  //   assert.equal(detailRequests, 1);
  //   assert.equal(comments.length, 1);
  //   assert.equal(comments[0].m, '链接弹幕');
  // });

  // await t.test('GET comments by Hongguo player URL should use resolved vid', async () => {
  //   const seriesId = '7572458140411628568';
  //   const vid = '7572460055539223614';
  //   const playerUrl = `https://hongguoduanju.com/player/${seriesId}/${vid}`;
  //   const requestedUrls = [];

  //   const response = await withMockFetch(async (url) => {
  //     requestedUrls.push(String(url));
  //     if (String(url).includes('/novel/player/multi_video_detail/v1/')) {
  //       return mockJsonResponse({
  //         code: 0,
  //         data: {
  //           [seriesId]: {
  //             video_data: {
  //               video_list: [{ vid_index: 1, vid, duration: 119 }],
  //             },
  //           },
  //         },
  //       }, String(url));
  //     }
  //     if (String(url).includes(`/novel/commentapi/comment/list/${vid}/v1/`)) {
  //       return mockJsonResponse({
  //         code: 0,
  //         data: {
  //           data_list: [{
  //             comment: {
  //               comment_id: 'route-comment',
  //               common: { content: { text: '路由弹幕' } },
  //               expand: { offset_time: 1500 },
  //               stat: { digg_count: 3 },
  //             },
  //           }],
  //           common_list_info: { cursor: '', has_more: false },
  //           extra: { next_query_danmaku_list_time: 119000 },
  //         },
  //       }, String(url));
  //     }
  //     throw new Error(`Unexpected Hongguo request: ${url}`);
  //   }, () => getCommentByUrl(playerUrl, 'json', false));

  //   const body = await parseResponse(response);
  //   assert.equal(body.count, 1);
  //   assert.equal(body.comments[0].m, '路由弹幕');
  //   assert(requestedUrls.some((url) => url.includes('/novel/player/multi_video_detail/v1/')));
  //   assert(requestedUrls.some((url) => url.includes(`/novel/commentapi/comment/list/${vid}/v1/`)));
  // });

  // await t.test('GET other_server danmu', async () => {
  //   const res = await otherSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('Hanjutv warmup should retry after failure and share concurrent promise', async () => {
  //   const source = new HanjutvSource();
  //   let attempts = 0;
  //   let finishFirst;
  //   source.buildMobileHeaders = async () => ({ uid: 'stable-uid', headers: {} });
  //   source.warmupMobileIdentity = async () => {
  //     attempts++;
  //     if (attempts === 1) return new Promise(resolve => { finishFirst = resolve; });
  //     return true;
  //   };

  //   const concurrent = [source.ensureMobileIdentityWarmed(), source.ensureMobileIdentityWarmed()];
  //   await new Promise(resolve => setImmediate(resolve));
  //   assert.equal(attempts, 1);
  //   finishFirst(false);
  //   await Promise.all(concurrent);
  //   await source.ensureMobileIdentityWarmed();
  //   await source.ensureMobileIdentityWarmed();
  //   assert.equal(attempts, 2);
  // });

  // await t.test('Hanjutv details should stay fully parallel and preserve candidate order', async () => {
  //   const source = new HanjutvSource();
  //   const candidates = Array.from({ length: 6 }, (_, index) => ({ sid: `sid-${index}`, name: `顺序测试剧${index}` }));
  //   const resolvers = new Map();
  //   const started = [];
  //   const previous = { animes: Globals.animes, episodeIds: Globals.episodeIds, episodeNum: Globals.episodeNum };
  //   Globals.animes = [];
  //   Globals.episodeIds = [];
  //   Globals.episodeNum = 10001;
  //   source.buildAnimePayload = anime => new Promise(resolve => {
  //     started.push(anime.sid);
  //     resolvers.set(anime.sid, resolve);
  //   });
  //   source.sortAndPushAnimesByYear = (items, target) => target.push(...items);

  //   try {
  //     const current = [];
  //     const task = source.handleAnimes(candidates, '顺序测试剧', current, new Map());
  //     await new Promise(resolve => setImmediate(resolve));
  //     assert.deepEqual(started, candidates.map(item => item.sid));
  //     [...candidates].reverse().forEach(anime => {
  //       const index = candidates.indexOf(anime);
  //       resolvers.get(anime.sid)({
  //         summary: { animeId: 900000 + index, bangumiId: String(900000 + index), animeTitle: anime.name, type: '韩剧', typeDescription: '韩剧', imageUrl: '', startDate: '2025-01-01T00:00:00Z', episodeCount: 1, rating: 0, isFavorited: true, source: 'hanjutv' },
  //         links: [{ name: '第1集', url: `hxq:${anime.sid}`, title: '【hanjutv】 第1集' }],
  //       });
  //     });
  //     const expected = candidates.map(item => item.name);
  //     assert.deepEqual((await task).map(item => item.animeTitle), expected);
  //     assert.deepEqual(current.map(item => item.animeTitle), expected);
  //     assert.deepEqual(Globals.animes.map(item => item.animeTitle), expected);
  //   } finally {
  //     Globals.animes = previous.animes;
  //     Globals.episodeIds = previous.episodeIds;
  //     Globals.episodeNum = previous.episodeNum;
  //   }
  // });

  // await t.test('Hanjutv should merge only exact titles and disambiguate duplicate names', async () => {
  //   const source = new HanjutvSource();
  //   const getMergedPairs = (keyword, s5Items, tvItems) => source
  //     .mergeSearchCandidates(keyword, s5Items, tvItems)
  //     .resultList
  //     .filter(item => item._variant === 'merged')
  //     .map(item => [item.sid, item.tvSid])
  //     .sort((left, right) => left[0].localeCompare(right[0]));

  //   const taxi = source.mergeSearchCandidates('模范出租车', [
  //     { sid: 's3', name: '模范出租车3' },
  //     { sid: 's2', name: '模范出租车2' },
  //   ], [
  //     { sid: 't2', name: '模范出租车2' },
  //     { sid: 't3', name: '模范出租车3' },
  //   ]).resultList.filter(item => item._variant === 'merged');
  //   assert.deepEqual(taxi.map(item => [item.name, item.tvSid]), [
  //     ['模范出租车3', 't3'],
  //     ['模范出租车2', 't2'],
  //   ]);

  //   const duplicate = source.mergeSearchCandidates('配对游戏', [
  //     { sid: 's-new', name: '配对游戏', playMode: 100, publishTime: '2025-01-01', lastSerialNo: 6 },
  //     { sid: 's-old', name: '配对游戏', playMode: 101, publishTime: '2024-01-01', lastSerialNo: 63 },
  //   ], [
  //     { sid: 't-old', name: '配对游戏', playMode: 101, publishTime: '2024-01-01', lastSerialNo: 63 },
  //     { sid: 't-new', name: '配对游戏', playMode: 100, publishTime: '2025-01-01', lastSerialNo: 6 },
  //   ]).resultList.filter(item => item._variant === 'merged');
  //   assert.deepEqual(duplicate.map(item => item.tvSid), ['t-new', 't-old']);

  //   const partialS5 = [
  //     { sid: 's-unknown', name: '同名剧', playMode: 100, category: 1 },
  //     { sid: 's-2025', name: '同名剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  //   ];
  //   const datedTv = [
  //     { sid: 't-2025', name: '同名剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  //   ];
  //   for (const s5Order of [partialS5, [...partialS5].reverse()]) {
  //     assert.deepEqual(getMergedPairs('同名剧', s5Order, datedTv), [['s-2025', 't-2025']]);
  //   }

  //   const ambiguousS5 = [
  //     { sid: 's-a', name: '歧义剧', playMode: 100, category: 1 },
  //     { sid: 's-b', name: '歧义剧', playMode: 100, category: 1 },
  //   ];
  //   const ambiguousTv = [{ sid: 't-only', name: '歧义剧', playMode: 100, category: 1 }];
  //   assert.deepEqual(getMergedPairs('歧义剧', ambiguousS5, ambiguousTv), []);
  //   assert.deepEqual(getMergedPairs('歧义剧', [...ambiguousS5].reverse(), ambiguousTv), []);

  //   assert.deepEqual(getMergedPairs('待播剧', [
  //     { sid: 's-upcoming', name: '待播剧', playMode: 100, category: 1 },
  //   ], [
  //     { sid: 't-upcoming', name: '待播剧', playMode: 100, category: 1 },
  //   ]), [['s-upcoming', 't-upcoming']]);

  //   const eliminationS5 = [
  //     { sid: 's-known', name: '排除剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  //     { sid: 's-left', name: '排除剧', playMode: 100, category: 1 },
  //   ];
  //   const eliminationTv = [
  //     { sid: 't-left', name: '排除剧', playMode: 100, category: 1 },
  //     { sid: 't-known', name: '排除剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  //   ];
  //   const expectedEliminationPairs = [['s-known', 't-known'], ['s-left', 't-left']];
  //   for (const s5Order of [eliminationS5, [...eliminationS5].reverse()]) {
  //     for (const tvOrder of [eliminationTv, [...eliminationTv].reverse()]) {
  //       assert.deepEqual(getMergedPairs('排除剧', s5Order, tvOrder), expectedEliminationPairs);
  //     }
  //   }
  // });

  // await t.test('Hanjutv should parse search-pair years without confusing seconds and milliseconds', () => {
  //   const source = new HanjutvSource();
  //   assert.equal(source.getSearchPairYear({ publishTime: 888768000000 }), 1998);
  //   assert.equal(source.getSearchPairYear({ publishTime: '956678400000' }), 2000);
  //   assert.equal(source.getSearchPairYear({ publishTime: 1735689600 }), 2025);
  //   assert.equal(source.getSearchPairYear({ publishTime: '20250101' }), 2025);
  //   assert.equal(source.getSearchPairYear({ releaseTime: '2025-07-11T00:00:00Z' }), 2025);
  //   assert.equal(source.getSearchPairYear({ publishTime: 0, searchMemo: '1998·韩剧·敬请期待' }), 1998);
  //   assert.equal(source.getSearchPairYear({ publishTime: 'not-a-date' }), null);
  //   assert.equal(source.getSearchPairYear({ publishTime: 253402300800000 }), null);

  //   assert.equal(source.isMergeableSearchPair(
  //     { name: '千禧剧', publishTime: 974788882000 },
  //     { name: '千禧剧', publishTime: 974820151000 },
  //   ), true);
  // });

  // await t.test('GET hanjutv search', async () => {
  //   const res = await hanjutvSource.search("犯罪现场Zero");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv detail', async () => {
  //   const res = await hanjutvSource.getDetail("Tc9lkfijFSDQ8SiUCB6T");
  //   // assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv episodes', async () => {
  //   const res = await hanjutvSource.getEpisodes("4EuRcD6T6y8XEQePtDsf");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv danmu', async () => {
  //   const res = await hanjutvSource.getEpisodeDanmu("12tY0Ktjzu5TCBrfTolNO");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv danmu segments', async () => {
  //   const res = await hanjutvSource.getComments("12tY0Ktjzu5TCBrfTolNO", "hanjutv", true);
  //   console.log(res);
  //   assert(res.type === "hanjutv", `Expected res.type === "hanjutv", but got ${res.type === "hanjutv"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET hanjutv segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "hanjutv",
  //     "segment_start": 0,
  //     "segment_end": 30000,
  //     "url": "12tY0Ktjzu5TCBrfTolNO"
  //   });
  //   const res = await hanjutvSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut search', async () => {
  //   const res = await bahamutSource.search("胆大党");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut episodes', async () => {
  //   const res = await bahamutSource.getEpisodes("44243");
  //   assert(res.anime.episodes[0].length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut danmu', async () => {
  //   const res = await bahamutSource.getComments("44453");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut danmu segments', async () => {
  //   const res = await bahamutSource.getComments("44453", "bahamut", true);
  //   console.log(res);
  //   assert(res.type === "bahamut", `Expected res.type === "bahamut", but got ${res.type === "bahamut"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET bahamut segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "bahamut",
  //     "segment_start": 0,
  //     "segment_end": 30000,
  //     "url": "44453"
  //   });
  //   const res = await bahamutSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // // 测试Animeko源
  // await t.test('Animeko Source Search', async () => {
  //   const source = new AnimekoSource();
  //   const result = await source.search("我们不可能成为恋人！绝对不行。 (※似乎可行？)");
  //   console.log(JSON.stringify(result, null, 2));
  //   assert(result.length > 0);
  //
  //   const curAnimes = []; 
  //   await source.handleAnimes(result, "我们不可能成为恋人！绝对不行。 (※似乎可行？)", curAnimes);
  //   assert(curAnimes.length > 0);
  //   
  //   const animeId = result[0].id;
  //   const episodes = await source.getEpisodes(animeId);
  //   
  //   if (episodes && episodes.length > 0) {
  //       const firstEp = episodes.find(e => e.type === 0) || episodes[0];
  //       const testId = firstEp.id;
  //       
  //       console.log(`Testing getSegmentComments with ID: ${testId}`);
  //       
  //       const segment = { 
  //           url: String(testId),
  //           type: 'animeko'
  //       };
  //       
  //       const danmu = await source.getSegmentComments(segment);
  //       
  //       console.log("Danmu count:", danmu ? danmu.length : 0);
  //       assert(Array.isArray(danmu));
  //       
  //       if (danmu.length > 0) {
  //           assert(danmu[0].p !== undefined);
  //           assert(danmu[0].m !== undefined);
  //       }
  //   }
  // });

  // await t.test('GET realistic danmu', async () => {
  //   // tencent
  //   // const keyword = "子夜归";
  //   // iqiyi
  //   // const keyword = "赴山海";
  //   // mango
  //   // const keyword = "锦月如歌";
  //   // bilibili
  //   // const keyword = "国王排名";
  //   // youku
  //   // const keyword = "黑白局";
  //   // renren
  //   // const keyword = "瑞克和莫蒂";
  //   // hanjutv
  //   // const keyword = "请回答1988";
  //   // bahamut
  //   const keyword = "胆大党";
  //
  //   const searchUrl = new URL(`${urlPrefix}/${token}/api/v2/search/anime?keyword=${keyword}`);
  //   const searchRes = await searchAnime(searchUrl);
  //   const searchData = await searchRes.json();
  //   assert(searchData.animes.length > 0, `Expected searchData.animes.length > 0, but got ${searchData.animes.length}`);
  //
  //   const bangumiUrl = new URL(`${urlPrefix}/${token}/api/v2/bangumi/${searchData.animes[0].animeId}`);
  //   const bangumiRes = await getBangumi(bangumiUrl.pathname);
  //   const bangumiData = await bangumiRes.json();
  //   assert(bangumiData.bangumi.episodes.length > 0, `Expected bangumiData.bangumi.episodes.length > 0, but got ${bangumiData.bangumi.episodes.length}`);
  //
  //   const commentUrl = new URL(`${urlPrefix}/${token}/api/v2/comment/${bangumiData.bangumi.episodes[0].episodeId}?withRelated=true&chConvert=1`);
  //   const commentRes = await getComment(commentUrl.pathname);
  //   const commentData = await commentRes.json();
  //   assert(commentData.count > 0, `Expected commentData.count > 0, but got ${commentData.count}`);
  // });

  // // 测试 POST /api/v2/match 接口
  // await t.test('POST /api/v2/match for matching anime', async () => {
  //   // 构造请求体
  //   const requestBody = {
  //     "fileName": "生万物 S01E28",
  //     "fileHash": "1234567890",
  //     "fileSize": 0,
  //     "videoDuration": 0,
  //     "matchMode": "fileNameOnly"
  //   };
  //
  //   // 模拟 POST 请求
  //   const matchUrl = `${urlPrefix}/${token}/api/v2/match`;  // 注意路径与 handleRequest 中匹配
  //   const req = new MockRequest(matchUrl, { method: 'POST', body: requestBody });
  //
  //   // 调用 handleRequest 来处理 POST 请求
  //   const res = await handleRequest(req);
  //
  //   // 解析响应
  //   const responseBody = await parseResponse(res);
  //   console.log(responseBody);
  //
  //   // 验证响应状态
  //   assert.equal(res.status, 200);
  //   assert.deepEqual(responseBody.success, true);
  // });

  // // 测试 GET /api/v2/search/episodes 接口
  // await t.test('GET /api/v2/search/episodes for search episodes', async () => {
  //   // 构造请求体
  //   const requestBody = {
  //     "fileName": "生万物 S01E28",
  //     "fileHash": "1234567890",
  //     "fileSize": 0,
  //     "videoDuration": 0,
  //     "matchMode": "fileNameOnly"
  //   };
  //
  //   const matchUrl = `${urlPrefix}/${token}/api/v2/search/episodes?anime=子夜归`;
  //   const req = new MockRequest(matchUrl, { method: 'GET' });
  //
  //   const res = await handleRequest(req);
  //
  //   // 解析响应
  //   const responseBody = await parseResponse(res);
  //   console.log(responseBody);
  //
  //   // 验证响应状态
  //   assert.equal(res.status, 200);
  //   assert.deepEqual(responseBody.success, true);
  // });

  // 测试upstash redis
  // await t.test('GET redis pingRedis', async () => {
  //   const res = await pingRedis();
  //   assert(res.result === "PONG", `Expected res.result === "PONG", but got ${res.result}`);
  // });
  //
  // await t.test('SET redis setRedisKey', async () => {
  //   const res = await setRedisKey('mykey', 'Hello World');
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });
  //
  // await t.test('GET redis getRedisKey', async () => {
  //   const res = await getRedisKey('mykey');
  //   assert(res.result.toString() === "\"Hello World\"", `Expected res.result === "\"Hello World\"", but got ${res.result}`);
  // });
  //
  // await t.test('SET redis setRedisKeyWithExpiry', async () => {
  //   const res = await setRedisKeyWithExpiry('expkey', 'Temporary Value', 10);
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });

  // // 测试imdb接口
  // await t.test('GET IMDB episodes', async () => {
  //   const res = await getImdbepisodes("tt2703720");
  //   assert(res.data.episodes.length > 10, `Expected res.data.episodes.length > 10, but got ${res.episodes.length}`);
  // });

  // // 测试tmdb接口
  // await t.test('GET TMDB titles', async () => {
  //   const res = await searchImdbTitles("卧虎藏龙");
  //   assert(res.data.total_results > 4, `Expected res.data.total_results > 4, but got ${res.total_results}`);
  // });

  // // 测试tmdb获取日语详情接口
  // await t.test('GET TMDB JP detail', async () => {
  //   const res = await getTmdbJpDetail("tv", 95396);
  //   assert(res.data.original_name === "Severance", `Expected res.data.Severance === "Severance", but got ${res.data.original_name}`);
  // });

  // // 测试douban获取titles
  // await t.test('GET DOUBAN titles', async () => {
  //   const res = await searchDoubanTitles("卧虎藏龙");
  //   assert(res.data.subjects.items.length > 3, `Expected res.data.subjects.items.length > 3, but got ${res.data.subjects.items.length}`);
  // });

  // // 测试douban获取detail
  // await t.test('GET DOUBAN detail', async () => {
  //   const res = await getDoubanDetail(36448279);
  //   assert(res.data.title === "罗小黑战记2", `Expected res.data.title === "罗小黑战记2", but got ${res.data.title}`);
  // });

  // // 测试douban从imdbId获取doubanInfo
  // await t.test('GET DOUBAN doubanInfo by imdbId', async () => {
  //   const res = await getDoubanInfoByImdbId("tt0071562");
  //   const doubanId = res.data?.id?.split("/")?.pop();
  //   assert(doubanId === "1299131", `Expected doubanId === 1299131, but got ${doubanId}`);
  // });

  // // 测试tmdb获取中文标题
  // await t.test('GET TMDB Chinese title', async () => {
  //   const res = await getTMDBChineseTitle("Blood River", 1, 4);
  //   assert(res === "暗河传", `Expected res === "暗河传", but got ${res}`);
  // });

  // // 测试获取全部环境变量
  // await t.test('Config getAllEnv', async () => {
  //   const handler = new NodeHandler();
  //   const res = handler.getAllEnv();
  //   assert(Number(res.DANMU_LIMIT) === 0, `Expected Number(res.DANMU_LIMIT) === 0, but got ${Number(res.DANMU_LIMIT)}`);
  // });

  // // 测试获取某个环境变量
  // await t.test('Config getEnv', async () => {
  //   const handler = new NodeHandler();
  //   const res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  // });

  // // 测试Node设置环境变量
  // await t.test('Node Config setEnv', async () => {
  //   const handler = new NodeHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Node添加和删除环境变量
  // await t.test('Node Config addEnv and del Env', async () => {
  //   const handler = new NodeHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Vercel设置环境变量
  // await t.test('Vercel Config setEnv', async () => {
  //   const handler = new VercelHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Vercel添加和删除环境变量
  // await t.test('Vercel Config addEnv and del Env', async () => {
  //   const handler = new VercelHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Vercel项目变量是否生效
  // await t.test('Vercel Check Params', async () => {
  //   const handler = new VercelHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Vercel触发部署
  // await t.test('Vercel deploy', async () => {
  //   const handler = new VercelHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Netlify设置环境变量
  // await t.test('Netlify Config setEnv', async () => {
  //   const handler = new NetlifyHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Netlify添加和删除环境变量
  // await t.test('Netlify Config addEnv and del Env', async () => {
  //   const handler = new NetlifyHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Netlify项目变量是否生效
  // await t.test('Netlify Check Params', async () => {
  //   const handler = new NetlifyHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Netlify触发部署
  // await t.test('Netlify deploy', async () => {
  //   const handler = new NetlifyHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Cloudflare设置环境变量
  // await t.test('Cloudflare Config setEnv', async () => {
  //   const handler = new CloudflareHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });

  // // 测试Cloudflare添加和删除环境变量
  // await t.test('Cloudflare Config addEnv and del Env', async () => {
  //   const handler = new CloudflareHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Cloudflare项目变量是否生效
  // await t.test('Cloudflare Check Params', async () => {
  //   const handler = new CloudflareHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Edgeone设置环境变量
  // await t.test('Edgeone Config setEnv', async () => {
  //   const handler = new EdgeoneHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });

  // // 测试Edgeone添加和删除环境变量
  // await t.test('Edgeone Config addEnv and del Env', async () => {
  //   const handler = new EdgeoneHandler();
  //   await handler.addEnv("PROXY_URL", "xxxx");
  //   let res = handler.getEnv("PROXY_URL");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("PROXY_URL");
  //   res = handler.getEnv("PROXY_URL");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Edgeone项目变量是否生效
  // await t.test('Edgeone Check Params', async () => {
  //   const handler = new EdgeoneHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Edgeone触发部署
  // await t.test('Edgeone deploy', async () => {
  //   const handler = new EdgeoneHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试 Bangumi Data 本地检索功能与数据结构解析
  // await t.test('searchBangumiData', async () => {
  //   const originalUseBangumiData = Globals.getConfig().useBangumiData;
  //   Globals.getConfig().useBangumiData = true;
  //   try {
  //     // 确保 Bangumi Data 核心数据源加载至内存
  //     await initBangumiData('node', true);
  //     const keyword = '间谍过家家';
  //     const targetSites = ['gamer', 'gamer_hk'];
  //     // 执行本地内存级检索
  //     const results = await searchBangumiData(keyword, targetSites);
  //     assert(Array.isArray(results), `Expected Array.isArray(results) to be true, but got ${typeof results}`);
  //     assert(results.length > 0, `Expected results.length > 0, but got ${results.length}`);
  //     if (results.length > 0) {
  //       assert(results[0].title !== undefined, `Expected results[0].title !== undefined`);
  //       assert(results[0].siteId !== undefined, `Expected results[0].siteId !== undefined`);
  //     }
  //   } finally {
  //     clearBangumiDataCache();
  //     Globals.getConfig().useBangumiData = originalUseBangumiData;
  //   }
  // });

  // // 测试带有季度参数的精确拦截与检索机制
  // await t.test('searchAnimeWithSeason', async () => {
  //   const config = Globals.getConfig();
  //   const originalSourceOrderArr = Array.isArray(config.sourceOrderArr) ? [...config.sourceOrderArr] : config.sourceOrderArr;
  //   config.sourceOrderArr = ['360','iqiyi','dandan','animeko'];
  //   try {
  //     // 构造带有 season 参数的 URL 请求对象以模拟 match 接口的内部下发
  //     const targetUrl = new URL('http://localhost/search/anime?keyword=间谍过家家&season=2');
  //     const response = await searchAnime(targetUrl);
  //     const data = await parseResponse(response);
  //     assert.equal(data.success, true);
  //     assert(Array.isArray(data.animes), `Expected Array.isArray(data.animes) to be true`);
  //     assert(data.animes.length > 0, `Expected data.animes.length > 0, but got ${data.animes.length}`);
  //   } finally {
  //     config.sourceOrderArr = originalSourceOrderArr;
  //   }
  // });

});

// // 测试本地 Redis 功能
// test('local-redis functions', async (t) => {
//   // 测试设置和获取本地 Redis 键值
//   await t.test('setLocalRedisKey and getLocalRedisKey', async () => {
//     try {
//       const testKey = 'test_key_local_redis';
//       const testValue = 'Hello Local Redis';

//       // 设置键值
//       const setResult = await setLocalRedisKey(testKey, testValue);
//       // 验证设置结果
//       assert.ok(setResult.result === 'OK' || setResult.result === 'ERROR', 
//         `setLocalRedisKey returned valid result: ${JSON.stringify(setResult)}`);

//       // 获取键值
//       const getResult = await getLocalRedisKey(testKey);
//       // 验证获取结果（如果 Redis 不可用，可能返回 null）
//       if (getResult !== null) {
//         // 如果返回了结果，验证它是否是我们设置的值（可能是序列化的）
//         assert.ok(typeof getResult === 'string' || getResult === null, 
//           `getLocalRedisKey returned expected type: ${typeof getResult}`);
//       } else {
//         // 如果返回 null，也是可以接受的（表示 Redis 不可用）
//         assert.strictEqual(getResult, null, 'getLocalRedisKey returned null when Redis is not available');
//       }
//     } catch (error) {
//       assert.ok(true, `setLocalRedisKey/getLocalRedisKey handled error gracefully: ${error.message}`);
//     }
//   });

//   // 测试设置带过期时间的本地 Redis 键值
//   await t.test('setLocalRedisKeyWithExpiry', async () => {
//     try {
//       const testKey = 'test_expiry_key_local_redis';
//       const testValue = 'Temporary Value';
//       const expirySeconds = 2; // 2秒过期

//       const setResult = await setLocalRedisKeyWithExpiry(testKey, testValue, expirySeconds);
//       // 验证设置结果
//       assert.ok(setResult.result === 'OK' || setResult.result === 'ERROR', 
//         `setLocalRedisKeyWithExpiry returned valid result: ${JSON.stringify(setResult)}`);
//     } catch (error) {
//       assert.ok(true, `setLocalRedisKeyWithExpiry handled error gracefully: ${error.message}`);
//     }
//   });
// });

});

// // 测试 Bangumi Data 数据下载时机（ensureBangumiDataReady）、配置变更触发下载（syncBangumiDataLifecycleOnConfigChange）
// // 以及 getTMDBChineseTitle 漏写 await 的修复；与 envs RAW_ENV_KEYS 测试同为按需启用的内部测试
// import { globals } from './configs/globals.js';
// import { ensureBangumiDataReady, syncBangumiDataLifecycleOnConfigChange, initBangumiData, clearBangumiDataCache } from './utils/bangumi-data-util.js';
// import fs from 'node:fs';
// import path from 'node:path';
//
// test('bangumi-data 数据下载时机与配置变更触发下载', async (t) => {
//   const CACHE_DIR = path.join(process.cwd(), '.cache');
//   const CACHE_FILE = path.join(CACHE_DIR, 'bangumi-data-cache.json');
//   const FAKE_ITEM = {
//     title: 'FrobeniusTestAnime',
//     titleTranslate: { 'zh-Hans': ['弗罗贝尼乌斯测试动画', 'FrobeniusTestAnime'] },
//     sites: [{ site: 'tmdb', id: '999999' }],
//     _flatText: 'frobeniustestanime'
//   };
//   const reset = () => {
//     globals.useBangumiData = false;
//     clearBangumiDataCache(false);
//     if (fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '', 'utf-8');
//   };
//
//   await t.test('ensureBangumiDataReady 开关关闭时直接返回且不触发下载', async () => {
//     reset();
//     globals.useBangumiData = false;
//     await ensureBangumiDataReady('node');
//     assert.ok(true);
//   });
//
//   await t.test('syncBangumiDataLifecycleOnConfigChange 开关关闭释放缓存、开启安全触发', async () => {
//     reset();
//     globals.useBangumiData = false;
//     assert.doesNotThrow(() => syncBangumiDataLifecycleOnConfigChange('node'));
//     fs.mkdirSync(CACHE_DIR, { recursive: true });
//     fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: [FAKE_ITEM] }), 'utf-8');
//     globals.useBangumiData = true;
//     assert.doesNotThrow(() => syncBangumiDataLifecycleOnConfigChange('node'));
//   });
//
//   await t.test('getTMDBChineseTitle 经 await 命中本地中文名（修复漏写 await）', async () => {
//     reset();
//     globals.useBangumiData = true;
//     const originalContent = fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf-8') : null;
//     fs.mkdirSync(CACHE_DIR, { recursive: true });
//     fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: [FAKE_ITEM] }), 'utf-8');
//     try {
//       await initBangumiData('node', true);
//       const result = await getTMDBChineseTitle('FrobeniusTestAnime');
//       assert.equal(result, '弗罗贝尼乌斯测试动画');
//     } finally {
//       clearBangumiDataCache(false);
//       if (originalContent !== null) fs.writeFileSync(CACHE_FILE, originalContent, 'utf-8');
//       else fs.writeFileSync(CACHE_FILE, '', 'utf-8');
//     }
//   });
// });

// // 测试 Bangumi Data 在途下载暴露与边缘生命周期延长（getBackgroundDownload / extendBangumiDownloadLifecycle）
// // 与上方 bangumi 测试同为按需启用的内部测试；沙箱有网时真实下载以验证在途暴露、注册与清理
// import { globals } from './configs/globals.js';
// import { initBangumiData, getBackgroundDownload, extendBangumiDownloadLifecycle } from './utils/bangumi-data-util.js';
// import assert from 'node:assert';
// import fs from 'node:fs';
// import path from 'node:path';
//
// test('bangumi-data 在途下载暴露与边缘生命周期延长', async (t) => {
//   const CACHE_DIR = path.join(process.cwd(), '.cache');
//   const CACHE_FILE = path.join(CACHE_DIR, 'bangumi-data-cache.json');
//   const hadCache = fs.existsSync(CACHE_DIR);
//
//   // 空闲时无在途下载
//   assert.strictEqual(getBackgroundDownload(), null);
//
//   await t.test('extendBangumiDownloadLifecycle 在无在途或 ctx 缺失时不注册', async () => {
//     const calls = [];
//     extendBangumiDownloadLifecycle(null);
//     extendBangumiDownloadLifecycle({ waitUntil: (p) => calls.push(p) });
//     assert.strictEqual(calls.length, 0);
//   });
//
//   await t.test('在途下载被暴露、响应后由边缘 waitUntil 注册、完成后清理', async () => {
//     globals.useBangumiData = true;
//     // 启动真实下载（无 .cache 时走内存路径，不落地文件；有 .cache 则后台刷新），不在途时立即返回
//     const initPromise = initBangumiData('node', true);
//     const bg = getBackgroundDownload();
//     assert.ok(bg && typeof bg.then === 'function', '下载在途时应暴露 Promise');
//     const ctx = { waitUntil: (p) => { ctx.registered = p; } };
//     extendBangumiDownloadLifecycle(ctx);
//     assert.strictEqual(ctx.registered, bg, '边缘 waitUntil 应注册在途 Promise');
//     await bg; // 等待下载完成（兼容阻塞与后台两种路径）
//     assert.strictEqual(getBackgroundDownload(), null, '下载完成后应清理在途状态');
//     globals.useBangumiData = false;
//     if (!hadCache && fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '', 'utf-8');
//     await initPromise.catch(() => {});
//   });
// // 测试自定义文本类变量绕过 dotenv 注释截断（保留 # 等字符），对应 envs.js RAW_ENV_KEYS 修复
// import { Envs } from './configs/envs.js';
//
// test('envs RAW_ENV_KEYS 保留 # 不被 dotenv 截断', async (t) => {
//   const reset = () => { Envs.systemEnvBackup = null; Envs.rawEnvValues = null; Envs.env = undefined; };
//
//   await t.test('parseRawEnvText 保留行内 # 与剥除外层双引号', () => {
//     const parsed = Envs.parseRawEnvText('K1=v1\nK2=v with # hash\nK3="q # v"');
//     assert.strictEqual(parsed.K2, 'v with # hash');
//     assert.strictEqual(parsed.K3, 'q # v');
//   });
//
//   await t.test('CUSTOM_MERGE_RULES / COLOR_POOL / URL 类变量含 # 完整保留', () => {
//     reset();
//     Envs.systemEnvBackup = {};
//     Envs.rawEnvValues = {
//       CUSTOM_MERGE_RULES: 'A #1 revival@bili',
//       COLOR_POOL: '#FF0000,#00FF00',
//       DANMU_PUSH_URL: 'http://h.com/cb#frag',
//     };
//     assert.strictEqual(Envs.get('CUSTOM_MERGE_RULES', '', 'string'), 'A #1 revival@bili');
//     assert.strictEqual(Envs.get('COLOR_POOL', '', 'string'), '#FF0000,#00FF00');
//     assert.strictEqual(Envs.get('DANMU_PUSH_URL', '', 'string'), 'http://h.com/cb#frag');
//   });
//
//   await t.test('!encrypt 守卫：加密变量不走原始解析，防止绕过加密', () => {
//     reset();
//     Envs.systemEnvBackup = {};
//     Envs.rawEnvValues = { DANMU_PUSH_URL: 'http://x.com/cb#frag' };
//     assert.strictEqual(Envs.get('DANMU_PUSH_URL', 'DEF', 'string', true), 'DEF');
//   });

// test('nipaplay 弹弹302关联工具函数', async (t) => {
//
//   // generateNipaplaySignature：相同入参确定性产出，输出为 sha256 的 base64（44 字符）
//   const sig1 = generateNipaplaySignature('app', '1700000000', '/api/v2/comment/1', 'secret');
//   const sig2 = generateNipaplaySignature('app', '1700000000', '/api/v2/comment/1', 'secret');
//   assert.strictEqual(sig1, sig2, '相同入参签名一致');
//   assert.strictEqual(sig1.length, 44, 'sha256 base64 长度为 44');
//   const sig3 = generateNipaplaySignature('app', '1700000001', '/api/v2/comment/1', 'secret');
//   assert.notStrictEqual(sig1, sig3, 'timestamp 不同签名不同');
//
//   // parseNipaplayRelatedLinks：解析 urls（|）与 shift（,），按主机名映射到内部源并还原时间偏移
//   const location = 'https://x.test/redirect?urls=https://www.bilibili.com/video/BV1xx|https://ani.gamer.com.tw/animeVideo.php?sn=12345&shift=0,30';
//   const parsed = parseNipaplayRelatedLinks(location);
//   assert.strictEqual(parsed.bilibili.length, 1, 'bilibili 链接被解析');
//   assert.strictEqual(parsed.bilibili[0].url, 'https://www.bilibili.com/video/BV1xx', 'bilibili 仅保留 BV 主体');
//   assert.strictEqual(parsed.bilibili[0].shift, 0, 'bilibili shift 为 0');
//   assert.strictEqual(parsed.bahamut.length, 1, 'bahamut 链接被解析');
//   assert.strictEqual(parsed.bahamut[0].url, 'https://ani.gamer.com.tw/animeVideo.php?sn=12345', 'bahamut 保留原始 URL');
//   assert.strictEqual(parsed.bahamut[0].shift, 30, 'bahamut shift 为 30');
//   assert.strictEqual(parsed.iqiyi.length, 0, '未提供平台为空');
//   for (const k of ['bilibili', 'bahamut', 'iqiyi', 'youku', 'tencent', 'imgo']) {
//     assert.deepStrictEqual(parseNipaplayRelatedLinks('')[k], [], `空字符串入参 ${k} 为空数组`);
//     assert.deepStrictEqual(parseNipaplayRelatedLinks(null)[k], [], `空入参 ${k} 为空数组`);
//   }
//
//   // resolveNipaplayLink：主机名到源路由，bahamut 提取 sn
//   assert.deepStrictEqual(resolveNipaplayLink('https://ani.gamer.com.tw/animeVideo.php?sn=999'), { source: 'bahamut', realId: '999' });
//   assert.deepStrictEqual(resolveNipaplayLink('https://v.qq.com/x/cover/abc.html'), { source: 'tencent', realId: 'https://v.qq.com/x/cover/abc.html' });
//   assert.deepStrictEqual(resolveNipaplayLink('https://www.bilibili.com/video/BVxyz'), { source: 'bilibili', realId: 'https://www.bilibili.com/video/BVxyz' });
//   assert.deepStrictEqual(resolveNipaplayLink('https://bilibili.com/video/BVxyz'), { source: 'bilibili', realId: 'https://bilibili.com/video/BVxyz' }, '无 www 前缀的裸域名同样归入 bilibili');
//   assert.deepStrictEqual(resolveNipaplayLink('https://b23.tv/BVxyz'), { source: 'bilibili', realId: 'https://b23.tv/BVxyz' }, 'b站短链 b23.tv 经统一映射归入 bilibili');
//   assert.deepStrictEqual(resolveNipaplayLink('https://unknown.example/x'), { source: null, realId: 'https://unknown.example/x' });
//
//   // parse 与 resolve 对 b23.tv 的识别保持一致：均归入 bilibili
//   const b23Location = 'https://x.test/redirect?urls=https://b23.tv/BV1xx&shift=0';
//   const b23Parsed = parseNipaplayRelatedLinks(b23Location);
//   assert.strictEqual(b23Parsed.bilibili.length, 1, 'b23.tv 链接经 parse 归入 bilibili');
//   assert.deepStrictEqual(resolveNipaplayLink(b23Parsed.bilibili[0].url), { source: 'bilibili', realId: b23Parsed.bilibili[0].url }, 'parse 与 resolve 对 b23.tv 的源识别一致');
//
//   // applyShiftToDanmu：校正时间偏移并标记实时拉取，不污染原对象
//   const src = { p: '12.34,1,25,16777215,0', t: 12.34 };
//   const shifted = applyShiftToDanmu(src, 5);
//   assert.strictEqual(shifted.p, '17.34,1,25,16777215,0', 'p 时间字段加偏移');
//   assert.strictEqual(shifted.t, 17.34, 't 加偏移');
//   assert.strictEqual(shifted.isRealTimePulled, true, '标记为实时拉取');
//   assert.strictEqual(src.p, '12.34,1,25,16777215,0', '原对象未被修改');
//   assert.strictEqual(applyShiftToDanmu(null, 5), null, '空对象直接返回');
// });
