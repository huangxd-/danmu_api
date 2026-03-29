// 加载 .env 文件
import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { handleRequest } from './worker.js';
import { extractTitleSeasonEpisode, getBangumi, getComment, matchAnime, searchAnime } from "./apis/dandan-api.js";
import { getRedisKey, pingRedis, setRedisKey, setRedisKeyWithExpiry } from "./utils/redis-util.js";
import { getLocalRedisKey, setLocalRedisKey, setLocalRedisKeyWithExpiry } from "./utils/local-redis-util.js";
import { getImdbepisodes } from "./utils/imdb-util.js";
import { getTMDBChineseTitle, getTmdbJpDetail, searchTmdbTitles } from "./utils/tmdb-util.js";
import { getDoubanDetail, getDoubanInfoByImdbId, searchDoubanTitles } from "./utils/douban-util.js";
import AIClient from './utils/ai-util.js';
import RenrenSource from "./sources/renren.js";
import HanjutvSource from "./sources/hanjutv.js";
import BahamutSource from "./sources/bahamut.js";
import TencentSource from "./sources/tencent.js";
import IqiyiSource from "./sources/iqiyi.js";
import MangoSource from "./sources/mango.js";
import BilibiliSource from "./sources/bilibili.js";
import YoukuSource from "./sources/youku.js";
import MiguSource from "./sources/migu.js";
import SohuSource from "./sources/sohu.js";
import LeshiSource from "./sources/leshi.js";
import XiguaSource from "./sources/xigua.js";
import MaiduiduiSource from "./sources/maiduidui.js";
import AnimekoSource from "./sources/animeko.js";
import OtherSource from "./sources/other.js";
import { NodeHandler } from "./configs/handlers/node-handler.js";
import { VercelHandler } from "./configs/handlers/vercel-handler.js";
import { NetlifyHandler } from "./configs/handlers/netlify-handler.js";
import { CloudflareHandler } from "./configs/handlers/cloudflare-handler.js";
import { EdgeoneHandler } from "./configs/handlers/edgeone-handler.js";
import { Globals } from "./configs/globals.js";
import { addAnime, addEpisode } from "./utils/cache-util.js";
import { convertToAsciiSum } from "./utils/codec-util.js";
import { handleDanmusLike } from "./utils/danmu-util.js";
import { Segment, SegmentListResponse } from "./models/dandan-model.js"

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

const urlPrefix = "http://localhost:9321";
const token = "87654321";

test('worker.js API endpoints', async (t) => {
  const renrenSource = new RenrenSource();
  const hanjutvSource = new HanjutvSource();
  const bahamutSource = new BahamutSource();
  const tencentSource = new TencentSource();
  const iqiyiSource = new IqiyiSource();
  const mangoSource = new MangoSource();
  const bilibiliSource = new BilibiliSource();
  const youkuSource = new YoukuSource();
  const miguSource = new MiguSource();
  const sohuSource = new SohuSource();
  const leshiSource = new LeshiSource();
  const xiguaSource = new XiguaSource();
  const maiduiduiSource = new MaiduiduiSource();
  const animekoSource = new AnimekoSource();
  const otherSource = new OtherSource();

  await t.test('GET / should return welcome message', async () => {
    const req = new MockRequest(urlPrefix, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
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

  await t.test('GET /api/v2/comment/:id?format=json&duration=true should return segment duration and reuse comment cache', async () => {
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.episodeNum = 10001;
    Globals.commentCache = new Map();

    const originalTencentGetComments = TencentSource.prototype.getComments;
    let commentRequestCount = 0;
    let durationRequestCount = 0;

    TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
      if (segmentFlag) {
        durationRequestCount++;
        return {
          type: 'qq',
          segmentList: [
            { type: 'qq', segment_start: 0, segment_end: 60, url: 'mock-1' },
            { type: 'qq', segment_start: 60, segment_end: 2760, url: 'mock-2' }
          ]
        };
      }

      commentRequestCount++;
      return [
        { p: '12.3,1,16777215,qq', m: '测试弹幕1' },
        { p: '45.6,1,16777215,qq', m: '测试弹幕2' }
      ];
    };

    try {
      const episode = addEpisode('https://v.qq.com/x/cover/a/b.html', '【qq】测试样例');
      const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
      const res = await handleRequest(req);
      const body = await parseResponse(res);
      const cachedRes = await handleRequest(req);
      const cachedBody = await parseResponse(cachedRes);

      assert.equal(res.status, 200);
      assert.equal(body.videoDuration, 2760);
      assert.equal(body.count, 2);
      assert.equal(body.comments.length, 2);
      assert.equal(cachedRes.status, 200);
      assert.equal(cachedBody.videoDuration, 2760);
      assert.equal(commentRequestCount, 1);
      assert.equal(durationRequestCount, 2);
      assert.equal(Globals.commentCache.size, 1);
    } finally {
      TencentSource.prototype.getComments = originalTencentGetComments;
      Globals.episodeIds = [];
      Globals.commentCache = new Map();
    }
  });

  await t.test('GET /api/v2/comment/:id?format=json&duration=true should use merged max duration', async () => {
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.episodeNum = 10001;
    Globals.commentCache = new Map();

    const originalTencentGetComments = TencentSource.prototype.getComments;
    const originalIqiyiGetComments = IqiyiSource.prototype.getComments;
    const originalYoukuGetComments = YoukuSource.prototype.getComments;

    TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
      if (segmentFlag) {
        return {
          type: 'qq',
          segmentList: [
            { type: 'qq', segment_start: 0, segment_end: 2760, url: 'mock-qq' }
          ]
        };
      }
      return [
        { p: '12.3,1,16777215,qq', m: '腾讯弹幕' }
      ];
    };

    IqiyiSource.prototype.getComments = async function(url, plat, segmentFlag) {
      if (segmentFlag) {
        return {
          type: 'qiyi',
          segmentList: [
            { type: 'qiyi', segment_start: 0, segment_end: 1200, url: 'mock-qiyi-1' },
            { type: 'qiyi', segment_start: 1200, segment_end: 2682, url: 'mock-qiyi-2' }
          ]
        };
      }
      return [
        { p: '15.0,1,16777215,qiyi', m: '爱奇艺弹幕' }
      ];
    };

    YoukuSource.prototype.getComments = async function(url, plat, segmentFlag) {
      if (segmentFlag) {
        return {
          type: 'youku',
          segmentList: [
            { type: 'youku', segment_start: 0, segment_end: 1800, url: 'mock-youku-1' },
            { type: 'youku', segment_start: 1800, segment_end: 3000, url: 'mock-youku-2' }
          ]
        };
      }
      return [
        { p: '18.0,1,16777215,youku', m: '优酷弹幕' }
      ];
    };

    try {
      const episode = addEpisode(
        'tencent:https://v.qq.com/x/cover/a/b.html$$$iqiyi:https://www.iqiyi.com/v_test.html$$$youku:https://v.youku.com/v_show/id_test.html',
        '【qq＆qiyi＆youku】合并测试'
      );
      const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
      const res = await handleRequest(req);
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.videoDuration, 3000);
      assert.ok(Array.isArray(body.comments));
    } finally {
      TencentSource.prototype.getComments = originalTencentGetComments;
      IqiyiSource.prototype.getComments = originalIqiyiGetComments;
      YoukuSource.prototype.getComments = originalYoukuGetComments;
      Globals.episodeIds = [];
      Globals.commentCache = new Map();
    }
  });

  await t.test('GET /api/v2/comment/:id?format=json&duration=true should prefer explicit duration field', async () => {
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.episodeNum = 10001;
    Globals.commentCache = new Map();

    const originalBilibiliGetComments = BilibiliSource.prototype.getComments;
    BilibiliSource.prototype.getComments = async function(url, plat, segmentFlag) {
      if (segmentFlag) {
        return new SegmentListResponse({
          type: 'bilibili1',
          duration: 1312.76,
          segmentList: [
            { type: 'bilibili1', segment_start: 0, segment_end: 360, url: 'mock-bili-1' },
            { type: 'bilibili1', segment_start: 360, segment_end: 720, url: 'mock-bili-2' },
            { type: 'bilibili1', segment_start: 720, segment_end: 1080, url: 'mock-bili-3' },
            { type: 'bilibili1', segment_start: 1080, segment_end: 1440, url: 'mock-bili-4' }
          ]
        });
      }
      return [
        { p: '20.0,1,16777215,bilibili1', m: 'B站弹幕1' },
        { p: '30.0,1,16777215,bilibili1', m: 'B站弹幕2' }
      ];
    };

    try {
      const episode = addEpisode('https://www.bilibili.com/bangumi/play/ep_test.html', '【bilibili】测试样例');
      const req = new MockRequest(urlPrefix + '/api/v2/comment/' + episode.id + '?format=json&duration=true', { method: 'GET' });
      const res = await handleRequest(req);
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.videoDuration, 1312.76);
      assert.equal(body.count, 2);
    } finally {
      BilibiliSource.prototype.getComments = originalBilibiliGetComments;
      Globals.episodeIds = [];
      Globals.commentCache = new Map();
    }
  });

  await t.test('GET /api/v2/bangumi/:id should resolve details from search cache after global eviction', async () => {
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.episodeNum = 10001;
    Globals.searchCache = new Map();
    Globals.requestHistory = new Map();
    Globals.envs.rateLimitMaxRequests = 0;
    delete Globals.requestAnimeDetailsMap;

    const cachedAnime = {
      animeId: 500001,
      bangumiId: '500001',
      animeTitle: '缓存详情番剧',
      type: 'tvseries',
      typeDescription: 'TV',
      imageUrl: 'https://example.com/poster.jpg',
      startDate: '2024-01-01T00:00:00.000Z',
      episodeCount: 2,
      rating: 0,
      isFavorited: true,
      source: 'tencent',
      links: [
        { id: 30001, url: 'https://v.qq.com/x/cover/cache/ep1.html', title: '【qq】 第1集' },
        { id: 30002, url: 'https://v.qq.com/x/cover/cache/ep2.html', title: '【qq】 第2集' }
      ]
    };

    Globals.searchCache.set('缓存详情番剧', {
      results: [
        {
          animeId: cachedAnime.animeId,
          bangumiId: cachedAnime.bangumiId,
          animeTitle: cachedAnime.animeTitle,
          type: cachedAnime.type,
          typeDescription: cachedAnime.typeDescription,
          imageUrl: cachedAnime.imageUrl,
          startDate: cachedAnime.startDate,
          episodeCount: cachedAnime.episodeCount,
          rating: cachedAnime.rating,
          isFavorited: cachedAnime.isFavorited,
          source: cachedAnime.source
        }
      ],
      details: [cachedAnime],
      timestamp: Date.now()
    });

    const req = new MockRequest(urlPrefix + '/api/v2/bangumi/' + cachedAnime.animeId, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.bangumi.animeTitle, cachedAnime.animeTitle);
    assert.equal(body.bangumi.episodes.length, 2);
    assert.equal(body.bangumi.episodes[0].episodeId, 30001);
    assert.equal(Globals.animes.length, 0);
    assert.equal(Globals.episodeIds.length, 0);
  });

  await t.test('GET /api/v2/comment/:id should resolve cached episode context after global eviction', async () => {
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.episodeNum = 10001;
    Globals.searchCache = new Map();
    Globals.commentCache = new Map();
    Globals.requestHistory = new Map();
    Globals.envs.rateLimitMaxRequests = 0;
    delete Globals.requestAnimeDetailsMap;

    const cachedAnime = {
      animeId: 500002,
      bangumiId: '500002',
      animeTitle: '缓存弹幕番剧',
      type: 'tvseries',
      typeDescription: 'TV',
      imageUrl: 'https://example.com/poster2.jpg',
      startDate: '2024-01-01T00:00:00.000Z',
      episodeCount: 1,
      rating: 0,
      isFavorited: true,
      source: 'tencent',
      links: [
        { id: 31001, url: 'https://v.qq.com/x/cover/cache/comment-ep1.html', title: '【qq】 第1集' }
      ]
    };

    Globals.searchCache.set('缓存弹幕番剧', {
      results: [
        {
          animeId: cachedAnime.animeId,
          bangumiId: cachedAnime.bangumiId,
          animeTitle: cachedAnime.animeTitle,
          type: cachedAnime.type,
          typeDescription: cachedAnime.typeDescription,
          imageUrl: cachedAnime.imageUrl,
          startDate: cachedAnime.startDate,
          episodeCount: cachedAnime.episodeCount,
          rating: cachedAnime.rating,
          isFavorited: cachedAnime.isFavorited,
          source: cachedAnime.source
        }
      ],
      details: [cachedAnime],
      timestamp: Date.now()
    });

    const originalTencentGetComments = TencentSource.prototype.getComments;
    let requestCount = 0;

    TencentSource.prototype.getComments = async function(url, plat, segmentFlag) {
      requestCount++;
      assert.equal(url, cachedAnime.links[0].url);
      assert.equal(plat, 'qq');
      assert.equal(segmentFlag, false);
      return [
        { p: '12.3,1,16777215,qq', m: '缓存弹幕命中' }
      ];
    };

    try {
      const req = new MockRequest(urlPrefix + '/api/v2/comment/' + cachedAnime.links[0].id + '?format=json', { method: 'GET' });
      const res = await handleRequest(req);
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.count, 1);
      assert.equal(body.comments[0].m, '缓存弹幕命中');
      assert.equal(requestCount, 1);
      assert.equal(Globals.animes.length, 0);
      assert.equal(Globals.episodeIds.length, 0);
    } finally {
      TencentSource.prototype.getComments = originalTencentGetComments;
      Globals.commentCache = new Map();
    }
  });
  await t.test('GET /api/v2/bangumi/:id should prefer latest cached detail snapshot', async () => {
    resetSearchState();

    const oldAnime = {
      animeId: 500003,
      bangumiId: "500003",
      animeTitle: "旧缓存详情番剧",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "https://example.com/old-poster.jpg",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: true,
      source: "tencent",
      links: [
        { id: 32001, url: "https://v.qq.com/x/cover/cache-old/ep1.html", title: "【qq】 旧快照 第1集" }
      ]
    };

    const latestAnime = {
      ...oldAnime,
      animeTitle: "新缓存详情番剧",
      episodeCount: 2,
      links: [
        { id: 32002, url: "https://v.qq.com/x/cover/cache-new/ep1.html", title: "【qq】 新快照 第1集" },
        { id: 32003, url: "https://v.qq.com/x/cover/cache-new/ep2.html", title: "【qq】 新快照 第2集" }
      ]
    };

    Globals.searchCache.set("旧缓存详情番剧", {
      results: [createSearchResult(oldAnime)],
      details: [oldAnime],
      timestamp: Date.now() - 5_000
    });
    Globals.searchCache.set("新缓存详情番剧", {
      results: [createSearchResult(latestAnime)],
      details: [latestAnime],
      timestamp: Date.now()
    });

    const req = new MockRequest(urlPrefix + "/api/v2/bangumi/" + latestAnime.animeId, { method: "GET" });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.bangumi.animeTitle, latestAnime.animeTitle);
    assert.equal(body.bangumi.episodes.length, 2);
    assert.equal(body.bangumi.episodes[0].episodeId, 32002);
    assert.equal(body.bangumi.episodes[1].episodeId, 32003);
  });

  await t.test('GET /api/v2/search/episodes should keep colliding cached details separated', async () => {
    resetSearchState();

    const renrenAnime = {
      animeId: 888,
      bangumiId: "123",
      animeTitle: "缓存冲突番剧A",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "https://example.com/renren.jpg",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: true,
      source: "renren",
      links: [
        { id: 33001, url: "renren://cache-a-ep1", title: "【renren】 第1集" }
      ]
    };

    const iqiyiAnime = {
      animeId: 123,
      bangumiId: "999",
      animeTitle: "缓存冲突番剧B",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "https://example.com/iqiyi.jpg",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: true,
      source: "iqiyi",
      links: [
        { id: 33002, url: "https://www.iqiyi.com/v_cache_b.html", title: "【qiyi】 第1集" }
      ]
    };

    const keyword = "缓存冲突测试";
    Globals.searchCache.set(keyword, {
      results: [createSearchResult(renrenAnime), createSearchResult(iqiyiAnime)],
      details: [renrenAnime, iqiyiAnime],
      timestamp: Date.now()
    });

    const req = new MockRequest(urlPrefix + "/api/v2/search/episodes?anime=" + encodeURIComponent(keyword), { method: "GET" });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.animes.length, 2);

    const renrenResult = body.animes.find(item => item.animeId === renrenAnime.animeId);
    const iqiyiResult = body.animes.find(item => item.animeId === iqiyiAnime.animeId);

    assert.ok(renrenResult);
    assert.ok(iqiyiResult);
    assert.equal(renrenResult.episodes.length, 1);
    assert.equal(renrenResult.episodes[0].episodeId, renrenAnime.links[0].id);
    assert.equal(renrenResult.episodes[0].episodeTitle, renrenAnime.links[0].title);
    assert.equal(iqiyiResult.episodes.length, 1);
    assert.equal(iqiyiResult.episodes[0].episodeId, iqiyiAnime.links[0].id);
    assert.equal(iqiyiResult.episodes[0].episodeTitle, iqiyiAnime.links[0].title);
  });

  await t.test('GET /api/v2/search/episodes should ignore polluted global detail cache state', async () => {
    resetSearchState();

    const cachedAnime = {
      animeId: 700001,
      bangumiId: "700001",
      animeTitle: "全局污染回归番剧",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "https://example.com/cache-correct.jpg",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: true,
      source: "tencent",
      links: [
        { id: 34001, url: "https://v.qq.com/x/cover/cache-correct/ep1.html", title: "【qq】 正确第1集" }
      ]
    };

    const pollutedAnime = {
      ...cachedAnime,
      animeTitle: "错误污染番剧",
      links: [
        { id: 34999, url: "https://v.qq.com/x/cover/cache-polluted/ep1.html", title: "【qq】 错误第1集" }
      ]
    };

    const keyword = "全局污染测试";
    Globals.searchCache.set(keyword, {
      results: [createSearchResult(cachedAnime)],
      details: [cachedAnime],
      timestamp: Date.now()
    });
    Globals.requestAnimeDetailsMap = new Map([
      [String(cachedAnime.bangumiId), pollutedAnime],
      [String(cachedAnime.animeId), pollutedAnime]
    ]);

    try {
      const req = new MockRequest(urlPrefix + "/api/v2/search/episodes?anime=" + encodeURIComponent(keyword), { method: "GET" });
      const res = await handleRequest(req);
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.animes.length, 1);
      assert.equal(body.animes[0].animeId, cachedAnime.animeId);
      assert.equal(body.animes[0].episodes[0].episodeId, cachedAnime.links[0].id);
      assert.equal(body.animes[0].episodes[0].episodeTitle, cachedAnime.links[0].title);
    } finally {
      delete Globals.requestAnimeDetailsMap;
    }
  });

  await t.test('POST /api/v2/match should ignore polluted global anime details and use current search snapshot', async () => {
    resetSearchState();

    const correctLinks = Array.from({ length: 50 }, (_, index) => ({
      id: 35001 + index,
      url: `https://www.iqiyi.com/v_match_correct_${index + 1}.html`,
      title: `【qiyi】 太平年第${index + 1}集`
    }));

    const cachedAnime = {
      animeId: 700002,
      bangumiId: "700002",
      animeTitle: "太平年(2024)【TV】from iqiyi",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "https://example.com/tp.jpg",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 50,
      rating: 0,
      isFavorited: true,
      source: "iqiyi",
      links: correctLinks
    };

    const pollutedAnime = {
      ...cachedAnime,
      links: correctLinks.map(link => ({ ...link }))
    };
    pollutedAnime.links[41] = {
      id: 35999,
      url: "https://www.iqiyi.com/v_match_polluted_45.html",
      title: "【qiyi】 太平年第45集 金陵落日"
    };

    Globals.searchCache.set("太平年", {
      results: [createSearchResult(cachedAnime)],
      details: [cachedAnime],
      timestamp: Date.now()
    });
    Globals.animes = [pollutedAnime];

    const req = {
      url: urlPrefix + "/api/v2/match",
      async json() {
        return {
          fileName: "太平年 S01E42"
        };
      }
    };

    const res = await matchAnime(new URL(req.url), req, "127.0.0.1");
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.isMatched, true);
    assert.equal(body.matches.length, 1);
    assert.equal(body.matches[0].episodeId, cachedAnime.links[41].id);
    assert.equal(body.matches[0].episodeTitle, cachedAnime.links[41].title);
  });

  await t.test('GET /api/v2/search/anime should filter by request snapshot instead of collided runtime animeId state', async () => {
    resetSearchState();

    const originalTencentSearch = TencentSource.prototype.search;
    const originalTencentHandleAnimes = TencentSource.prototype.handleAnimes;
    const originalIqiyiSearch = IqiyiSource.prototype.search;
    const originalIqiyiHandleAnimes = IqiyiSource.prototype.handleAnimes;
    const originalSourceOrderArr = Array.isArray(Globals.envs.sourceOrderArr) ? [...Globals.envs.sourceOrderArr] : Globals.envs.sourceOrderArr;
    const originalEnableAnimeEpisodeFilter = Globals.envs.enableAnimeEpisodeFilter;
    const originalEpisodeTitleFilter = Globals.envs.episodeTitleFilter;
    const originalAnimeTitleFilter = Globals.envs.animeTitleFilter;

    const sharedAnimeId = 880001;
    const tencentAnime = {
      animeId: sharedAnimeId,
      bangumiId: "tx-880001",
      animeTitle: "同ID跨源番剧",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: false,
      source: "tencent",
      links: [
        { url: "https://v.qq.com/x/cover/collision/ep1.html", title: "【qq】 正片第1集" }
      ]
    };
    const iqiyiAnime = {
      animeId: sharedAnimeId,
      bangumiId: "iqiyi-880001",
      animeTitle: "同ID跨源番剧",
      type: "tvseries",
      typeDescription: "TV",
      imageUrl: "",
      startDate: "2024-01-01T00:00:00.000Z",
      episodeCount: 1,
      rating: 0,
      isFavorited: false,
      source: "iqiyi",
      links: [
        { url: "https://www.iqiyi.com/v_collision_extra.html", title: "【qiyi】 花絮" }
      ]
    };

    Globals.envs.sourceOrderArr = ["tencent", "iqiyi"];
    Globals.envs.enableAnimeEpisodeFilter = true;
    Globals.envs.episodeTitleFilter = /花絮/;
    Globals.envs.animeTitleFilter = null;

    TencentSource.prototype.search = async () => [createSearchResult(tencentAnime)];
    TencentSource.prototype.handleAnimes = async (_results, _queryTitle, curAnimes, detailStore) => {
      curAnimes.push(createSearchResult(tencentAnime));
      addAnime(tencentAnime, detailStore);
    };
    IqiyiSource.prototype.search = async () => [createSearchResult(iqiyiAnime)];
    IqiyiSource.prototype.handleAnimes = async (_results, _queryTitle, curAnimes, detailStore) => {
      curAnimes.push(createSearchResult(iqiyiAnime));
      addAnime(iqiyiAnime, detailStore);
    };

    try {
      const req = new MockRequest(urlPrefix + "/api/v2/search/anime?keyword=" + encodeURIComponent("同ID跨源番剧"), { method: "GET" });
      const res = await searchAnime(new URL(req.url), null, null, new Map());
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.animes.length, 1);
      assert.equal(body.animes[0].animeId, tencentAnime.animeId);
      assert.equal(body.animes[0].source, tencentAnime.source);
      assert.equal(body.animes[0].animeTitle, tencentAnime.animeTitle);
    } finally {
      TencentSource.prototype.search = originalTencentSearch;
      TencentSource.prototype.handleAnimes = originalTencentHandleAnimes;
      IqiyiSource.prototype.search = originalIqiyiSearch;
      IqiyiSource.prototype.handleAnimes = originalIqiyiHandleAnimes;
      Globals.envs.sourceOrderArr = Array.isArray(originalSourceOrderArr) ? [...originalSourceOrderArr] : originalSourceOrderArr;
      Globals.envs.enableAnimeEpisodeFilter = originalEnableAnimeEpisodeFilter;
      Globals.envs.episodeTitleFilter = originalEpisodeTitleFilter;
      Globals.envs.animeTitleFilter = originalAnimeTitleFilter;
    }
  });
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

  // await t.test('GET other_server danmu', async () => {
  //   const res = await otherSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
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

  await t.test('hanjutv danmu fetching should paginate correctly across variants and fallback hosts', async () => {
    const source = new HanjutvSource();
    const originalTvGet = source.tvGet;
    const tvCalls = [];

    source.tvGet = async (path) => {
      tvCalls.push(path);
      if (tvCalls.length === 1) return { bulletchats: [{ did: 1, t: 0, tp: 1, sc: 16777215, con: 'page-1', lc: 0 }], more: 1, nextAxis: 12002, lastId: 111 };
      if (tvCalls.length === 2) return { bulletchats: [{ did: 2, t: 12002, tp: 1, sc: 16777215, con: 'page-2', lc: 0 }], more: 0, nextAxis: 60000, lastId: 222 };
      if (tvCalls.length === 3) return { bulletchats: [{ did: 3, t: 61000, tp: 1, sc: 16777215, con: 'page-3', lc: 0 }], more: 0, nextAxis: 120000, lastId: 333 };
      return { bulletchats: [], more: 0, nextAxis: 100000000, lastId: 333 };
    };

    try {
      const danmus = await source.getEpisodeDanmu('tv:legacy-eid');
      assert.equal(danmus.length, 3);
      assert.deepEqual(tvCalls, [
        '/api/v1/bulletchat/episode/get?eid=legacy-eid&prevId=0&fromAxis=0&toAxis=100000000&offset=0',
        '/api/v1/bulletchat/episode/get?eid=legacy-eid&prevId=111&fromAxis=12002&toAxis=100000000&offset=0',
        '/api/v1/bulletchat/episode/get?eid=legacy-eid&prevId=0&fromAxis=60000&toAxis=100000000&offset=0',
        '/api/v1/bulletchat/episode/get?eid=legacy-eid&prevId=0&fromAxis=120000&toAxis=100000000&offset=0',
      ]);
    } finally {
      source.tvGet = originalTvGet;
    }

    await withMockFetch(async (url, options = {}) => {
      const targetUrl = String(url);
      const headers = options?.headers || {};

      if (targetUrl.includes('/api/danmu/playItem/list?')) {
        assert.equal('uk' in headers, false);
        assert.equal('sign' in headers, false);

        if (targetUrl.includes('pid=play-1')) {
          if (targetUrl.includes('fromAxis=0&toAxis=60000')) return mockJsonResponse({ danmus: [{ did: 11, t: 0, tp: 1, sc: 16777215, con: 'hxq-page-1', lc: 0 }], more: 1, nextAxis: 12345, lastId: 111 }, targetUrl);
          if (targetUrl.includes('fromAxis=12345&toAxis=60000')) return mockJsonResponse({ danmus: [{ did: 12, t: 12345, tp: 1, sc: 16777215, con: 'hxq-page-2', lc: 0 }], more: 0, nextAxis: 60000, lastId: 222 }, targetUrl);
          if (targetUrl.includes('fromAxis=60000&toAxis=120000')) return mockJsonResponse({ danmus: [{ did: 13, t: 61000, tp: 1, sc: 16777215, con: 'hxq-page-3', lc: 0 }], more: 0, nextAxis: 120000, lastId: 333 }, targetUrl);
          return mockJsonResponse({ danmus: [], more: 0, nextAxis: 180000, lastId: 333 }, targetUrl);
        }

        if (targetUrl.startsWith('https://hxqapi.hiyun.tv/')) throw new Error('primary host down');
        if (targetUrl === 'https://hxqapi.zmdcq.com/api/danmu/playItem/list?pid=play-2&prevId=0&fromAxis=0&toAxis=60000&offset=0') {
          return mockJsonResponse({ danmus: [{ did: 21, t: 0, tp: 1, sc: 16777215, con: 'fallback-ok', lc: 0 }], more: 0, nextAxis: 60000, lastId: 21 }, targetUrl);
        }
        if (targetUrl === 'https://hxqapi.zmdcq.com/api/danmu/playItem/list?pid=play-2&prevId=21&fromAxis=60000&toAxis=120000&offset=0') {
          return mockJsonResponse({ danmus: [], more: 0, nextAxis: 120000, lastId: 21 }, targetUrl);
        }
      }

      throw new Error(`unexpected fetch: ${targetUrl}`);
    }, async () => {
      const hxqDanmus = await source.getEpisodeDanmu('hxq:play-1');
      const fallbackDanmus = await source.getEpisodeDanmu('play-2');
      const segments = await source.getComments('play-1', 'hanjutv', true);

      assert.equal(hxqDanmus.length, 3);
      assert.equal(fallbackDanmus.length, 1);
      assert.equal(fallbackDanmus[0].con, 'fallback-ok');
      assert.equal(segments.duration, 0);
      assert.deepEqual(segments.segmentList, []);
    });
  });

  await t.test('hanjutv search should reuse identities and merge matched variants while dropping noisy fallbacks', async () => {
    const source = new HanjutvSource();
    const originalNow = Date.now;
    let now = 1700000000000;
    const configRequests = [];
    const searchRequests = [];

    try {
      Date.now = () => now;
      await withMockFetch(async (url, options = {}) => {
        const targetUrl = String(url);
        if (targetUrl === 'https://hxqapi.hiyun.tv/api/common/configs') {
          configRequests.push({
            uk: options?.headers?.uk || '',
            said: options?.headers?.said || '',
            sign: options?.headers?.sign || '',
          });
          now += 1;
          return mockJsonResponse({ ok: true }, targetUrl);
        }
        if (targetUrl.includes('/api/search/s5?')) {
          searchRequests.push({
            url: targetUrl,
            uk: options?.headers?.uk || '',
            said: options?.headers?.said || '',
            sign: options?.headers?.sign || '',
          });
          return mockJsonResponse({ seriesList: [{ sid: 'hxq-sid-1', name: '信号 第2季', image: { thumb: 'https://img/a.jpg' } }] }, targetUrl);
        }
        throw new Error(`unexpected fetch: ${targetUrl}`);
      }, async () => {
        await source.searchWithS5Api('信号 第2季');
        now += 1000;
        await source.searchWithS5Api('秘密森林');
      });

      const firstTvHeaders = await source.buildTvHeaders();
      now += 1000;
      const secondTvHeaders = await source.buildTvHeaders();

      assert.equal(searchRequests.length, 2);
      assert.equal(configRequests.length, 2);
      assert.equal(searchRequests[0].url, 'https://hxqapi.hiyun.tv/api/search/s5?k=%E4%BF%A1%E5%8F%B7%20%E7%AC%AC2%E5%AD%A3&srefer=search_input&type=0&page=1');
      assert.equal(searchRequests[0].uk, searchRequests[1].uk);
      assert.equal(searchRequests[0].said, searchRequests[1].said);
      assert.notEqual(searchRequests[0].sign, searchRequests[1].sign);
      assert.equal(configRequests[0].uk, searchRequests[0].uk);
      assert.equal(configRequests[0].said, searchRequests[0].said);
      assert.notEqual(configRequests[0].sign, searchRequests[0].sign);
      assert.equal(firstTvHeaders.uid, secondTvHeaders.uid);
      assert.notEqual(firstTvHeaders.headers.rp, secondTvHeaders.headers.rp);

      const originalS5 = source.searchWithS5Api;
      const originalTv = source.searchWithTvApi;

      source.searchWithS5Api = async () => ([
        { sid: 'hxq-sid-1', name: '信号 第2季', image: { thumb: 'https://img/a.jpg' } },
        { sid: 'hxq-sid-2', name: '信号 特辑', image: { thumb: 'https://img/b.jpg' } },
      ]);
      source.searchWithTvApi = async () => ([
        { sid: 'tv-sid-1', name: '信号 第2季', image: { thumb: 'https://img/c.jpg' } },
      ]);

      const mergedResult = await source.search('信号 第2季');
      assert.equal(mergedResult.length, 2);
      assert.equal(mergedResult[0]._variant, 'merged');
      assert.equal(mergedResult[0].animeId, convertToAsciiSum('hxq:hxq-sid-1|tv:tv-sid-1'));
      assert.equal(mergedResult[1]._variant, 'hxq');

      source.searchWithS5Api = async () => ([
        { sid: 'sid-1', name: '有点敏感也没关系' },
        { sid: 'sid-2', name: '不是机器人啊' },
      ]);
      source.searchWithTvApi = async () => ([]);
      assert.deepEqual(await source.search('不存在的关键字'), []);

      source.searchWithS5Api = originalS5;
      source.searchWithTvApi = originalTv;
    } finally {
      Date.now = originalNow;
    }
  });

  await t.test('hanjutv merged payloads should keep source-specific episode ids and stable anime ids', async () => {
    resetSearchState();

    const source = new HanjutvSource();
    const hxqEpisodes = source.normalizeHxqEpisodes([{ id: 'shared-ep', serialNo: 1, title: '第一集' }]);
    const tvEpisodes = source.normalizeTvEpisodes([{ id: 'shared-ep', serialNo: 1, title: '第一集' }, { pid: 'tv-only-pid', serialNo: 2, title: '第二集' }]);
    assert.deepEqual(source.mergeVariantEpisodes(hxqEpisodes, tvEpisodes).map(item => item.url), [
      'hanjutv:hxq:shared-ep$$$hanjutv:tv:shared-ep',
      'tv:tv-only-pid',
    ]);

    const compositeAnimeId = convertToAsciiSum('hxq:hxq-sid-1|tv:tv-sid-1');
    const originalGetHxqDetail = source.getHxqDetail;
    const originalGetHxqEpisodes = source.getHxqEpisodes;
    const originalGetTvDetail = source.getTvDetail;
    const originalGetTvEpisodes = source.getTvEpisodes;

    source.getHxqDetail = async () => ({ category: 1, rank: 9.5 });
    source.getHxqEpisodes = async () => ([{ pid: 'pid-1', serialNo: 1, title: '第一集' }, { pid: 'pid-2', serialNo: 2, title: '第二集' }]);
    source.getTvDetail = async () => ({ category: 1, rank: 8.8 });
    source.getTvEpisodes = async () => ([{ eid: 'eid-1', serialNo: 1, title: '第一集' }, { eid: 'eid-3', serialNo: 3, title: '第三集' }]);

    try {
      const firstBatch = [];
      await source.handleAnimes([{ sid: 'hxq-sid-1', tvSid: 'tv-sid-1', animeId: compositeAnimeId, name: '稳定ID测试', image: { thumb: 'https://img/a.jpg' }, updateTime: '2024-01-01T00:00:00.000Z', _variant: 'merged' }], '稳定ID测试', firstBatch, new Map());
      source.getTvEpisodes = async () => ([]);
      const secondBatch = [];
      await source.handleAnimes([{ sid: 'hxq-sid-1', tvSid: 'tv-sid-1', animeId: compositeAnimeId, name: '稳定ID测试', image: { thumb: 'https://img/a.jpg' }, _variant: 'merged' }], '稳定ID测试', secondBatch, new Map());

      assert.equal(firstBatch[0].animeId, compositeAnimeId);
      assert.equal(secondBatch[0].animeId, compositeAnimeId);
      assert.equal(Globals.animes.length, 1);
      assert.deepEqual(Globals.animes[0].links.map(item => item.url), ['hxq:pid-1', 'hxq:pid-2']);
    } finally {
      source.getHxqDetail = originalGetHxqDetail;
      source.getHxqEpisodes = originalGetHxqEpisodes;
      source.getTvDetail = originalGetTvDetail;
      source.getTvEpisodes = originalGetTvEpisodes;
      resetSearchState();
    }
  });

  await t.test('GET /api/v2/comment/:id should apply hanjutv offsets before deduping', async () => {
    resetSearchState();
    Globals.episodeNum = 43010;

    const episode = addEpisode('hanjutv:hxq:pid-1$$$hanjutv:tv:eid-1', '【hanjutv】 第1集');
    Globals.animes.push({
      animeId: 930010,
      bangumiId: '930010',
      animeTitle: '偏移测试(2024)【韩剧】from hanjutv',
      type: '韩剧',
      typeDescription: '韩剧',
      imageUrl: '',
      startDate: '2024-01-01T00:00:00.000Z',
      episodeCount: 1,
      rating: 9.5,
      isFavorited: true,
      source: 'hanjutv',
      links: [episode]
    });

    const originalGetEpisodeDanmu = HanjutvSource.prototype.getEpisodeDanmu;
    HanjutvSource.prototype.getEpisodeDanmu = async function(id) {
      if (id === 'hxq:pid-1') return [{ did: 1, t: 1000, tp: 1, sc: 16777215, con: '双端同步', lc: 0 }];
      if (id === 'tv:eid-1') return [{ did: 2, t: 1000, tp: 1, sc: 16777215, con: '双端同步', lc: 0 }];
      throw new Error(`unexpected hanjutv id: ${id}`);
    };

    try {
      const req = new MockRequest(urlPrefix + `/api/v2/comment/${episode.id}`, { method: 'GET' });
      const res = await handleRequest(req, { DANMU_OFFSET: '偏移测试@hanjutv:20' });
      const body = await parseResponse(res);

      assert.equal(res.status, 200);
      assert.equal(body.count, 1);
      assert.match(body.comments[0].p, /^21\.00,1,16777215,\[韩小圈＆极速版\]$/);
      assert.equal(body.comments[0].m, '双端同步');
    } finally {
      HanjutvSource.prototype.getEpisodeDanmu = originalGetEpisodeDanmu;
      resetSearchState();
    }
  });

  await t.test('hanjutv source labels should keep low-threshold like behavior', async () => {
    Globals.init({});
    Globals.likeSwitch = true;

    const likedDanmus = handleDanmusLike([
      { p: '1.00,1,16777215,[hanjutv]', m: '旧标签', like: 150 },
      { p: '1.00,1,16777215,[韩小圈]', m: '韩小圈标签', like: 150 },
      { p: '1.00,1,16777215,[极速版]', m: '极速版标签', like: 150 },
      { p: '1.00,1,16777215,[韩小圈＆极速版]', m: '双链路标签', like: 150 },
    ]);

    likedDanmus.forEach(item => assert.match(item.m, /🔥150$/));
  });

  await t.test('hanjutv single-source comments should expose precise source labels', async () => {
    const source = new HanjutvSource();
    const originalGetEpisodeDanmu = source.getEpisodeDanmu;

    source.getEpisodeDanmu = async (id) => {
      if (id === 'hxq:play-1') return [{ did: 1, t: 1000, tp: 1, sc: 16777215, con: 'hxq-comment', lc: 0, _sourceLabel: '韩小圈' }];
      if (id === 'tv:play-2') return [{ did: 2, t: 1000, tp: 1, sc: 16777215, con: 'tv-comment', lc: 0, _sourceLabel: '极速版' }];
      throw new Error(`unexpected id: ${id}`);
    };

    try {
      const hxqComments = await source.getComments('hxq:play-1', 'hanjutv', false);
      const tvComments = await source.getComments('tv:play-2', 'hanjutv', false);

      assert.equal(hxqComments.length, 1);
      assert.equal(tvComments.length, 1);
      assert.match(hxqComments[0].p, /^\d+\.\d{2},1,16777215,\[韩小圈\]$/);
      assert.match(tvComments[0].p, /^\d+\.\d{2},1,16777215,\[极速版\]$/);
    } finally {
      source.getEpisodeDanmu = originalGetEpisodeDanmu;
    }
  });
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
