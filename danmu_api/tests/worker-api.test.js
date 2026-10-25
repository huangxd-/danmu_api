// 请求级端点测试：欢迎页与请求体（分块/多字节/multipart）处理
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import { parseLocalDanmu } from '../utils/local-danmu-parser.js';
import { handleRequest, netlifyHandler, vercelHandler } from '../worker.js';
import { MockRequest, parseResponse, readRequestBody, urlPrefix } from './helpers/context.js';
import { localDanmuEncodings, localDanmuExpected, localDanmuJson } from './helpers/local-danmu.js';
import { matchAnime, searchAnime } from '../apis/dandan-api.js';
import { Globals } from '../configs/globals.js';
import { SegmentListResponse } from '../models/dandan-model.js';
import BilibiliSource from '../sources/bilibili.js';
import IqiyiSource from '../sources/iqiyi.js';
import TencentSource from '../sources/tencent.js';
import YoukuSource from '../sources/youku.js';
import { addAnime, addEpisode } from '../utils/cache-util.js';
import { createSearchResult, resetSearchState } from './helpers/context.js';

test('GET / should return welcome message', async () => {
    const req = new MockRequest(urlPrefix, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
  });
for (const [encoding, encode] of localDanmuEncodings) {
  test(`multipart upload preserves and parses ${encoding} across byte boundaries`, async () => {
    const fileBytes = encode(localDanmuJson);
    const boundary = 'local-danmu-test-boundary';
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="danmu.json"\r\nContent-Type: application/json\r\n\r\n`);
    const multipart = Buffer.concat([header, fileBytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    // 每块一个字节，覆盖中文、emoji、BOM 和 UTF-16 码元被分块的情况。
    const chunks = Array.from(multipart, (_, index) => multipart.subarray(index, index + 1));
    const body = await readRequestBody(Readable.from(chunks));
    assert.deepEqual(body, multipart);

    const request = new Request('http://localhost/api/local-danmu/upload', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const form = await request.formData();
    const file = form.get('file');
    const uploadedBytes = Buffer.from(await file.arrayBuffer());
    assert.deepEqual(uploadedBytes, fileBytes);
    assert.deepEqual(parseLocalDanmu(uploadedBytes, file.name), localDanmuExpected);
  });
}
test('ordinary JSON request bodies retain multibyte characters across chunks', async () => {
  const payload = { title: '逐玉', text: '中文😀' };
  const bytes = Buffer.from(JSON.stringify(payload));
  const split = bytes.findIndex(byte => byte >= 0x80) + 1;
  const body = await readRequestBody(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]));
  const request = new Request('http://localhost/api/example', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.deepEqual(await request.json(), payload);
});
test('request body read errors are propagated', async () => {
  const failure = new Error('request interrupted');
  const request = Readable.from((async function* () {
    yield Buffer.from('partial');
    throw failure;
  })());
  await assert.rejects(readRequestBody(request), error => error === failure);
});

test('GET /api/v2/comment/:id?format=json&duration=true should use merged max duration', async () => {
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

test('GET /api/v2/comment/:id?format=json&duration=true should prefer explicit duration field', async () => {
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

test('GET /api/v2/bangumi/:id should resolve details from search cache after global eviction', async () => {
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

test('GET /api/v2/comment/:id should resolve cached episode context after global eviction', async () => {
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

test('GET /api/v2/bangumi/:id should prefer latest cached detail snapshot', async () => {
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

test('GET /api/v2/search/episodes should keep colliding cached details separated', async () => {
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

test('GET /api/v2/search/episodes should ignore polluted global detail cache state', async () => {
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

test('POST /api/v2/match should ignore polluted global anime details and use current search snapshot', async () => {
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

test('GET /api/v2/search/anime should filter by request snapshot instead of collided runtime animeId state', async () => {
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

// ============================================================================
// worker.js 路由 / 鉴权 / 限流 / 平台适配层
// 说明：请求级断言全部走 handleRequest，deployPlatform 用 'cloudflare' 以跳过
// 仅在 node 平台生效的本地缓存/本地 Redis 判定；env 里**不要**设置 AI_API_KEY /
// AI_BASE_URL（设置后 handleRequest 会先对 AI 服务发起真实连通性校验）。
// ============================================================================

const routingEnv = (extra = {}) => ({
  LOG_LEVEL: 'error',
  LOCAL_CACHE_ENABLED: 'false',
  RATE_LIMIT_MAX_REQUESTS: '0',
  ...extra,
});

const callWorker = async (url, { method = 'GET', body, headers, env = {}, platform = 'cloudflare', ip = '127.0.0.1' } = {}) => {
  Globals.requestHistory = new Map();
  const response = await handleRequest(
    new Request(url, { method, body, headers }),
    routingEnv(env),
    platform,
    ip,
  );
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { response, status: response.status, text, json };
};

test('worker 边缘入口：favicon / robots.txt / OPTIONS 直接返回 204 与 CORS 头', async () => {
  for (const [label, url, method] of [
    ['favicon', 'http://localhost/favicon.ico', 'GET'],
    ['robots', 'http://localhost/robots.txt', 'GET'],
    ['OPTIONS 预检', 'http://localhost/api/v2/search/anime', 'OPTIONS'],
  ]) {
    const { response, status, text } = await callWorker(url, { method });
    assert.strictEqual(status, 204, `${label} 应返回 204`);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(response.headers.get('access-control-allow-methods'), 'GET, POST, PUT, DELETE, OPTIONS');
    assert.strictEqual(response.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, User-Agent');
    assert.strictEqual(text, '', `${label} 不应有响应体`);
  }
});

test('worker 默认 TOKEN：未知首段视为错误 token 返回 401，已知 API 首段放行', async () => {
  const unknown = await callWorker('http://localhost/not-a-known-path/x');
  assert.strictEqual(unknown.status, 401, '未知首段应按错误 token 处理');
  assert.strictEqual(unknown.json.errorCode, 401);
  assert.strictEqual(unknown.json.errorMessage, 'Unauthorized');

  // 已知 API 首段（api）允许无 token 访问，/api/config 降级为无权限视图
  const limited = await callWorker('http://localhost/api/config');
  assert.strictEqual(limited.status, 200);
  assert.strictEqual(limited.json.message, 'Welcome to the LogVar Danmu API server');
  assert.match(limited.json.envs.TOKEN, /^\*+$/, '无权限时 token 以掩码返回');

  const withToken = await callWorker('http://localhost/87654321/api/does-not-exist');
  assert.strictEqual(withToken.status, 404, '带正确 token 的未知路径应走到 404');
  assert.strictEqual(withToken.json.message, 'Not found');
});

test('worker 自定义 TOKEN：缺 token 401，错 token 401，只有 ADMIN_TOKEN 能看到明文敏感值', async () => {
  const env = { TOKEN: 'user-token-1', ADMIN_TOKEN: 'admin-tok', UPSTASH_REDIS_REST_TOKEN: 'up-secret' };

  const noToken = await callWorker('http://localhost/api/config', { env });
  assert.strictEqual(noToken.status, 200, '/api/config 允许无 token 但只能拿到受限视图');
  assert.match(noToken.json.originalEnvVars.UPSTASH_REDIS_REST_TOKEN, /^\*+$/, '用户视图脱敏');

  const wrongToken = await callWorker('http://localhost/wrong-token/api/config', { env });
  assert.strictEqual(wrongToken.status, 401);
  assert.strictEqual(wrongToken.json.errorMessage, 'Unauthorized');

  const userToken = await callWorker('http://localhost/user-token-1/api/config', { env });
  assert.strictEqual(userToken.status, 200);
  assert.match(userToken.json.originalEnvVars.UPSTASH_REDIS_REST_TOKEN, /^\*+$/, '普通 token 仍脱敏');

  const adminToken = await callWorker('http://localhost/admin-tok/api/config', { env });
  assert.strictEqual(adminToken.status, 200);
  assert.strictEqual(adminToken.json.originalEnvVars.UPSTASH_REDIS_REST_TOKEN, 'up-secret',
    'ADMIN_TOKEN 才返回明文敏感值');
  assert.match(adminToken.json.envs.UPSTASH_REDIS_REST_TOKEN, /^\*+$/, '预览视图始终脱敏');

  const searchWithoutToken = await callWorker('http://localhost/api/v2/search/anime?keyword=test', { env });
  assert.strictEqual(searchWithoutToken.status, 401, '自定义 TOKEN 下业务接口必须带 token');
});

test('worker 收藏写接口：自定义 TOKEN 下必须显式携带 token', async () => {
  const env = { TOKEN: 'user-token-1', ADMIN_TOKEN: 'admin-tok' };
  const { status, json } = await callWorker('http://localhost/api/v2/favorite/add', { method: 'POST', env });
  assert.strictEqual(status, 401);
  assert.strictEqual(json.errorMessage, 'Favorite API requires an explicit token');
});

test('worker FAVORITE_REQUIRE_ADMIN：普通 token 403，ADMIN_TOKEN 才进入处理器', async () => {
  const env = { ADMIN_TOKEN: 'admin-tok', FAVORITE_REQUIRE_ADMIN: 'true' };

  const userPath = await callWorker('http://localhost/87654321/api/v2/favorite/add', { method: 'POST', env });
  assert.strictEqual(userPath.status, 403);
  assert.strictEqual(userPath.json.message, '权限不足');
  assert.strictEqual(userPath.json.errorMessage, 'Favorite API requires ADMIN_TOKEN');

  // 用 ADMIN_TOKEN 通过闸门后会落到处理器，因缺少 keyword 返回 400（证明已进入收藏逻辑而非被拦）
  const adminPath = await callWorker('http://localhost/admin-tok/api/v2/favorite/add', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(adminPath.status, 400);
  assert.strictEqual(adminPath.json.message, '缺少 keyword 或 fileName 参数');
});

test('worker 收藏列表是公开只读接口，不要求 token', async () => {
  const env = { TOKEN: 'user-token-1', ADMIN_TOKEN: 'admin-tok' };
  const { status, json } = await callWorker('http://localhost/api/v2/favorite/list', { env });
  assert.strictEqual(status, 200, '自定义 TOKEN 下收藏列表仍可匿名读取');
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.favoriteSupported, false, '云平台未配置 Redis 时明确标记收藏不可用');
});

test('worker IP 黑名单：精确与正则规则命中即 403，未命中放行', async () => {
  const exact = await callWorker('http://localhost/api/config', { env: { IP_BLACKLIST: '203.0.113.9' }, ip: '203.0.113.9' });
  assert.strictEqual(exact.status, 403);
  assert.strictEqual(exact.json.errorMessage, 'Forbidden');

  const otherIp = await callWorker('http://localhost/api/config', { env: { IP_BLACKLIST: '203.0.113.9' }, ip: '198.51.100.7' });
  assert.strictEqual(otherIp.status, 200, '未命中黑名单的 IP 不应被拦');

  const regexHit = await callWorker('http://localhost/api/config', { env: { IP_BLACKLIST: '/^10\\./' }, ip: '10.1.2.3' });
  assert.strictEqual(regexHit.status, 403, '支持 /pattern/ 形式的正则规则');

  const cidrHit = await callWorker('http://localhost/api/config', { env: { IP_BLACKLIST: '192.168.0.0/16' }, ip: '192.168.5.5' });
  assert.strictEqual(cidrHit.status, 403, '支持 CIDR 规则');
});

test('worker 限流：窗口内已达上限返回 429 且不再记录新请求', async () => {
  Globals.requestHistory = new Map([['9.9.9.9', [Date.now()]]]);
  const response = await handleRequest(
    new Request('http://localhost/api/v2/comment?url=https://v.qq.com/x/cover/a/b.html&format=json'),
    routingEnv({ RATE_LIMIT_MAX_REQUESTS: '1' }),
    'cloudflare',
    '9.9.9.9',
  );
  const body = JSON.parse(await response.text());
  assert.strictEqual(response.status, 429);
  assert.strictEqual(body.errorCode, 429);
  assert.strictEqual(body.errorMessage, 'Too many requests, please try again later');
  assert.deepStrictEqual(Globals.requestHistory.get('9.9.9.9').length, 1, '被限流的请求不应写入历史');
});

test('worker /api/v2/segmentcomment 请求体无法构成 Segment 时返回 400', async () => {
  const { status, json } = await callWorker('http://localhost/api/v2/segmentcomment', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(status, 400);
  assert.strictEqual(json.errorCode, 400);
  assert.strictEqual(json.errorMessage, 'Invalid JSON in request body');
});

test('worker /api/debug/forward-trace 需要显式 token，通过后写入日志缓冲', async () => {
  const env = { TOKEN: 'user-token-1' };
  const anonymous = await callWorker('http://localhost/api/debug/forward-trace', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{"handler":"x"}',
  });
  assert.strictEqual(anonymous.status, 401);
  assert.strictEqual(anonymous.json.errorMessage, 'Unauthorized');

  const authorized = await callWorker('http://localhost/user-token-1/api/debug/forward-trace', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{"handler":"worker-routing-test"}',
  });
  assert.strictEqual(authorized.status, 202);
  assert.strictEqual(authorized.json.success, true);
});

test('worker 平台适配层：netlifyHandler / vercelHandler 映射为标准响应', async () => {
  const netlifyOut = await netlifyHandler(
    { rawUrl: 'http://localhost/favicon.ico', httpMethod: 'GET', headers: {} },
    { ip: '127.0.0.1' },
  );
  assert.strictEqual(netlifyOut.statusCode, 204);
  assert.strictEqual(netlifyOut.headers['access-control-allow-origin'], '*');
  assert.strictEqual(netlifyOut.body, '');

  const captured = { status: null, headers: {}, body: null };
  await vercelHandler(
    { url: 'http://localhost/favicon.ico', method: 'GET', headers: { 'x-forwarded-for': '203.0.113.7' } },
    {
      status(value) { captured.status = value; },
      setHeader(key, value) { captured.headers[key] = value; },
      send(value) { captured.body = value; },
    },
  );
  assert.strictEqual(captured.status, 204);
  assert.strictEqual(captured.headers['access-control-allow-origin'], '*');
  assert.strictEqual(captured.body, '');
});

// ============================================================================
// 系统管理接口鉴权（#531）：默认 TOKEN 的免 token 兼容不适用于管理接口
// ============================================================================

const ADMIN_ONLY_PROBES = [
  ['/api/env/set', 'POST'],
  ['/api/env/add', 'POST'],
  ['/api/env/del', 'POST'],
  ['/api/deploy', 'POST'],
  ['/api/cache/clear', 'POST'],
  ['/api/cache/animes', 'GET'],
  ['/api/logs/clear', 'POST'],
  ['/api/cookie/status', 'GET'],
  ['/api/cookie/save', 'POST'],
  ['/api/cookie/verify', 'POST'],
  ['/api/cookie/qr/generate', 'POST'],
  ['/api/cookie/qr/check', 'POST'],
  ['/api/ai/verify', 'POST'],
  ['/api/nipaplay/verify', 'POST'],
];

test('worker 默认 TOKEN 下管理接口无 token 一律 401（默认 token 不是凭据）', async () => {
  for (const [path, method] of ADMIN_ONLY_PROBES) {
    const tokenless = await callWorker(`http://localhost${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
    });
    assert.strictEqual(tokenless.status, 401, `${path} 无 token 应被拦截`);
    assert.strictEqual(tokenless.json.errorCode, 401);
    assert.match(tokenless.json.errorMessage, /ADMIN_TOKEN/, `${path} 应提示需要 ADMIN_TOKEN`);
    assert.strictEqual(tokenless.json.message, undefined, `${path} 不应进入处理器（处理器会返回业务 message）`);

    // 显式携带公开的默认 token 同样不构成管理凭据
    const withDefaultToken = await callWorker(`http://localhost/87654321${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
    });
    assert.strictEqual(withDefaultToken.status, 401, `${path} 携带默认 token 仍应被拦截`);
  }
});

test('worker 配置 ADMIN_TOKEN 后管理接口放行，普通业务接口的免 token 兼容不受影响', async () => {
  const env = { ADMIN_TOKEN: 'admin-tok' };

  const clearCache = await callWorker('http://localhost/admin-tok/api/cache/clear', { method: 'POST', env });
  assert.strictEqual(clearCache.status, 200);
  assert.strictEqual(clearCache.json.success, true);

  const clearLogs = await callWorker('http://localhost/admin-tok/api/logs/clear', { method: 'POST', env });
  assert.strictEqual(clearLogs.status, 200);

  // 通过闸门后落到处理器自身的参数校验（400），证明已放行而不是被鉴权拦下
  const delEnv = await callWorker('http://localhost/admin-tok/api/env/del', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(delEnv.status, 400);
  assert.strictEqual(delEnv.json.message, '缺少环境变量名称');

  // 默认 TOKEN 下普通业务接口仍可无 token 访问
  const reqRecords = await callWorker('http://localhost/api/reqrecords');
  assert.strictEqual(reqRecords.status, 200);
  const logs = await callWorker('http://localhost/api/logs');
  assert.strictEqual(logs.status, 200, 'GET /api/logs 仍可非 admin 读取（内容脱敏）');
});

test('worker 自定义 TOKEN 下管理接口只接受 ADMIN_TOKEN', async () => {
  const env = { TOKEN: 'user-token-1', ADMIN_TOKEN: 'admin-tok' };

  const userToken = await callWorker('http://localhost/user-token-1/api/env/set', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(userToken.status, 401, '普通 token 不能访问管理接口');
  assert.match(userToken.json.errorMessage, /ADMIN_TOKEN/);

  const noToken = await callWorker('http://localhost/api/env/set', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(noToken.status, 401);

  const adminToken = await callWorker('http://localhost/admin-tok/api/env/set', {
    method: 'POST', env, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(adminToken.status, 400, 'ADMIN_TOKEN 应通过闸门并落到处理器参数校验');
  assert.strictEqual(adminToken.json.message, '缺少环境变量名称');
});
