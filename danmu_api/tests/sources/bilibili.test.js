// B站源：短链解析、分集顺序、类型识别与弹幕格式化

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals, globals } from '../../configs/globals.js';
import BilibiliSource from '../../sources/bilibili.js';
import { withMockFetch, mockJsonResponse, resetSearchState } from '../helpers/context.js';

const SEASON_URL_PREFIX = 'https://api.bilibili.com/pgc/view/web/season?season_id=';

test('BilibiliSource should resolve b23.tv short links from redirect location', async () => {
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

test('BilibiliSource should return the original short link when no redirect location is present', async () => {
  Globals.init({});
  const source = new BilibiliSource();
  const shortUrl = 'https://b23.tv/BV1GJ411x7h7';

  await withMockFetch(async () => ({
    ok: true,
    status: 200,
    url: shortUrl,
    headers: new Headers(),
    text: async () => '',
  }), async () => {
    assert.equal(await source.resolveB23Link(shortUrl), shortUrl);
  });
});

test('BilibiliSource should return the original short link when the request fails', async () => {
  Globals.init({});
  const source = new BilibiliSource();
  const shortUrl = 'https://b23.tv/BV1GJ411x7h7';

  await withMockFetch(async () => {
    throw new Error('network down');
  }, async () => {
    assert.equal(await source.resolveB23Link(shortUrl), shortUrl);
  });
});

test('BilibiliSource should map season type names to media types', () => {
  const source = new BilibiliSource();

  assert.equal(source._extractMediaType('电影'), '电影');
  assert.equal(source._extractMediaType('番剧'), '动漫');
  assert.equal(source._extractMediaType('国创'), '动漫');
  assert.equal(source._extractMediaType('纪录片'), '纪录片');
  assert.equal(source._extractMediaType('综艺'), '综艺');
  assert.equal(source._extractMediaType('电视剧'), '电视剧');
  assert.equal(source._extractMediaType(''), '电视剧');
});

test('BilibiliSource should sort season episodes by their episode number when the interface order is scrambled', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  // 详情接口返回的分集顺序可能被打乱，且底层主键与集号逆序
  const episodes = [
    { id: 1719147, title: '2', show_title: '2', aid: 2, cid: 12 },
    { id: 1719146, title: '3', show_title: '3', aid: 3, cid: 13 },
    { id: 1719148, title: '1', show_title: '1', aid: 1, cid: 11 },
  ];
  const body = { code: 0, result: { main_section: { episodes } } };

  await withMockFetch(async (url) => {
    assert.ok(String(url).startsWith(SEASON_URL_PREFIX), `不应请求其它接口: ${url}`);
    return mockJsonResponse(body, String(url));
  }, async () => {
    await source.handleAnimes(
      [{ mediaId: 'ss96905', title: '我爱我家', year: 2004, type: '电视剧', imageUrl: '' }],
      '我爱我家',
      []
    );
  });

  const anime = globals.animes[0];
  assert.ok(anime, '应写入缓存');
  assert.deepStrictEqual(anime.links.map(link => link.title), [
    '【bilibili1】 1',
    '【bilibili1】 2',
    '【bilibili1】 3',
  ]);
  // 链接与集号对应：第 1 集指向接口返回中 title 为 1 的那条
  assert.deepStrictEqual(anime.links.map(link => link.url), [
    'https://www.bilibili.com/bangumi/play/ep1719148?season_id=96905',
    'https://www.bilibili.com/bangumi/play/ep1719147?season_id=96905',
    'https://www.bilibili.com/bangumi/play/ep1719146?season_id=96905',
  ]);
});

test('BilibiliSource should keep season episodes ordered when ids run against the episode numbers', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  // 详情接口按集号正序返回分集，但底层主键随集号递减
  const episodes = [
    { id: 1719148, title: '1', show_title: '1', aid: 1, cid: 11 },
    { id: 1719147, title: '2', show_title: '2', aid: 2, cid: 12 },
    { id: 1719146, title: '3', show_title: '3', aid: 3, cid: 13 },
  ];
  const body = { code: 0, result: { main_section: { episodes } } };

  await withMockFetch(async (url) => {
    assert.ok(String(url).startsWith(SEASON_URL_PREFIX), `不应请求其它接口: ${url}`);
    return mockJsonResponse(body, String(url));
  }, async () => {
    await source.handleAnimes(
      [{ mediaId: 'ss96905', title: '我爱我家', year: 2004, type: '电视剧', imageUrl: '' }],
      '我爱我家',
      []
    );
  });

  const anime = globals.animes[0];
  assert.ok(anime, '应写入缓存');
  assert.deepStrictEqual(anime.links.map(link => link.title), [
    '【bilibili1】 1',
    '【bilibili1】 2',
    '【bilibili1】 3',
  ]);
});

test('BilibiliSource should keep season episodes ordered when episode titles carry no episode number', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  // 集标题为「第N期」「第N期会员版」「衍生《…》第N期」等形态时提取不到集号
  const episodes = [
    { id: 785272, title: '第1期', show_title: '第1期', aid: 1, cid: 11 },
    { id: 785273, title: '第1期会员版', show_title: '第1期会员版', aid: 2, cid: 12 },
    { id: 786641, title: '第2期', show_title: '第2期', aid: 3, cid: 13 },
    { id: 786996, title: '面试舞台精华版', show_title: '面试舞台精华版', aid: 4, cid: 14 },
  ];
  const body = { code: 0, result: { main_section: { episodes } } };

  await withMockFetch(async (url) => {
    assert.ok(String(url).startsWith(SEASON_URL_PREFIX), `不应请求其它接口: ${url}`);
    return mockJsonResponse(body, String(url));
  }, async () => {
    await source.handleAnimes(
      [{ mediaId: 'ss96906', title: '爱唱歌的大学生', year: 2024, type: '综艺', imageUrl: '' }],
      '爱唱歌的大学生',
      []
    );
  });

  const anime = globals.animes[0];
  assert.ok(anime, '应写入缓存');
  // 提取不到集号时保持接口返回顺序
  assert.deepStrictEqual(anime.links.map(link => link.title), [
    '【bilibili1】 第1期',
    '【bilibili1】 第1期会员版',
    '【bilibili1】 第2期',
    '【bilibili1】 面试舞台精华版',
  ]);
});

test('BilibiliSource should keep episodes sharing an episode number next to each other', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  // 正片与衍生篇共用集号，排序后同号相邻
  const episodes = [
    { id: 2584317, title: '1', show_title: '1', aid: 1, cid: 11 },
    { id: 2623339, title: '衍生《爱唱同学会》第1期', show_title: '衍生《爱唱同学会》第1期', aid: 2, cid: 12 },
    { id: 2623340, title: '2', show_title: '2', aid: 3, cid: 13 },
  ];
  const body = { code: 0, result: { main_section: { episodes } } };

  await withMockFetch(async (url) => {
    assert.ok(String(url).startsWith(SEASON_URL_PREFIX), `不应请求其它接口: ${url}`);
    return mockJsonResponse(body, String(url));
  }, async () => {
    await source.handleAnimes(
      [{ mediaId: 'ss96907', title: '中国奇谭', year: 2018, type: '综艺', imageUrl: '' }],
      '中国奇谭',
      []
    );
  });

  const anime = globals.animes[0];
  assert.ok(anime, '应写入缓存');
  // 衍生篇的「第1期」与正片「第1集」集号相同，按集号排序后相邻
  assert.deepStrictEqual(anime.links.map(link => link.title), [
    '【bilibili1】 1',
    '【bilibili1】 衍生《爱唱同学会》第1期',
    '【bilibili1】 2',
  ]);
});

test('BilibiliSource should sort search result episodes by index title', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  const anime = {
    mediaId: 'ss46844',
    title: '我爱我家',
    year: 1993,
    type: '电视剧',
    imageUrl: '',
    _eps: [
      { id: 799121, index_title: '第3话', title: '第3话' },
      { id: 799120, index_title: '第1话', title: '第1话' },
      { id: 799119, index_title: '第2话', title: '第2话' },
    ],
  };

  await source.handleAnimes([anime], '我爱我家', []);

  const cached = globals.animes[0];
  assert.ok(cached, '应写入缓存');
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【bilibili1】 第1话',
    '【bilibili1】 第2话',
    '【bilibili1】 第3话',
  ]);
});

test('BilibiliSource should fall back to ep id order when index titles carry no episode number', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  const anime = {
    mediaId: 'ss46844',
    title: '我爱我家',
    year: 1993,
    type: '电视剧',
    imageUrl: '',
    _eps: [
      { id: 799121, index_title: '精华版', title: '精华版' },
      { id: 799119, index_title: '正片', title: '正片' },
    ],
  };

  await source.handleAnimes([anime], '我爱我家', []);

  const cached = globals.animes[0];
  assert.ok(cached, '应写入缓存');
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【bilibili1】 正片',
    '【bilibili1】 精华版',
  ]);
});

test('BilibiliSource should take oversea episode numbers from position', async () => {
  resetSearchState();
  const source = new BilibiliSource();
  const anime = {
    mediaId: 'ss46844',
    title: '我爱我家',
    year: 1993,
    type: '电视剧',
    imageUrl: '',
    isOversea: true,
    _eps: [
      // 港澳台条目的 index 字段不可靠，集号取自 position
      { id: 799121, index_title: '第1话', position: 3, title: '第1话' },
      { id: 799119, index_title: '第2话', position: 1, title: '第2话' },
    ],
  };

  await source.handleAnimes([anime], '我爱我家', []);

  const cached = globals.animes[0];
  assert.ok(cached, '应写入缓存');
  // 集号取自 position（1、3），排序按 position 升序
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【bilibili1】 第2话',
    '【bilibili1】 第1话',
  ]);
  assert.ok(cached.links[0].url.includes('area=hkmt'), '港澳台条目应带区域标记');
});

test('BilibiliSource should map comment like counts', () => {
  const source = new BilibiliSource();
  const comments = [{ like_num: 12 }, { like_num: 0 }];

  const formatted = source.formatComments(comments);

  assert.strictEqual(formatted[0].like, 12);
  assert.strictEqual(formatted[1].like, 0);
});
