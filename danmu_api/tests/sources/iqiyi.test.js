// iqiyi 源：分集标题的组装、集号判定与分集列表解析

import test from 'node:test';
import assert from 'node:assert';
import IqiyiSource from '../../sources/iqiyi.js';
import { Globals, globals } from '../../configs/globals.js';
import { withMockFetch, mockJsonResponse, resetSearchState } from '../helpers/context.js';

const iqiyi = new IqiyiSource();
const buildTitle = (epData) => iqiyi._buildEpisodeTitle(epData);
const ensureNumber = (title, animeTitle, order) => iqiyi._ensureEpisodeNumber(title, animeTitle, order);
const resolveOrder = (albumOrder) => iqiyi._resolveEpisodeOrder(albumOrder);
const buildEntry = (epData) => iqiyi._buildEpisodeEntry(epData);

test('iqiyi episode title uses short_display_name and appends subtitle', () => {
  assert.strictEqual(buildTitle({ short_display_name: '太古神尊 天魔秘藏' }), '太古神尊 天魔秘藏');
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
  // 分集名已包含副标题时不重复拼接
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集 巨额悬赏', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
});

test('iqiyi episode title falls back when name fields are missing', () => {
  assert.strictEqual(buildTitle({ title: '太古神尊 外门考核' }), '太古神尊 外门考核');
  assert.strictEqual(buildTitle({}), '未知分集');
});

test('iqiyi episode number is inserted after the anime title when missing', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊', 10),
    '太古神尊 第10集 天魔秘藏'
  );
  // 不以作品名开头时集数置于标题前
  assert.strictEqual(ensureNumber('天魔秘藏', '太古神尊', 10), '第10集 天魔秘藏');
  // 作品名带年份与类型后缀时，剥去后缀再比对
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊(2026)【3D动漫】from iqiyi', 10),
    '太古神尊 第10集 天魔秘藏'
  );
});

test('iqiyi episode number keeps titles that already carry an episode number', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 第11集 巨额悬赏', '太古神尊', 11),
    '太古神尊 第11集 巨额悬赏'
  );
  // 接口的其它集数写法同样视为已含集数
  assert.strictEqual(ensureNumber('太古神尊 EP11', '太古神尊', 11), '太古神尊 EP11');
});

test('iqiyi episode number is not added without a valid order', () => {
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', undefined), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', null), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', ''), '太古神尊 天魔秘藏');
});

test('iqiyi episode number is not added when the album declares no episode order', () => {
  // 综艺专辑的 album_order 恒为 0，接口未声明集数顺序
  assert.strictEqual(ensureNumber('第1期上 周深教孟子义唱歌', '奔跑吧', 0), '第1期上 周深教孟子义唱歌');
  assert.strictEqual(ensureNumber('序篇 十个勤天后陡门再集结', '种地吧', 0), '序篇 十个勤天后陡门再集结');
  assert.strictEqual(ensureNumber('第1期上 周深教孟子义唱歌', '奔跑吧', -1), '第1期上 周深教孟子义唱歌');
});

test('iqiyi episode order is resolved only from positive integers', () => {
  assert.strictEqual(resolveOrder(12), 12);
  assert.strictEqual(resolveOrder('12'), 12);
  assert.strictEqual(resolveOrder(0), null);
  assert.strictEqual(resolveOrder(-3), null);
  assert.strictEqual(resolveOrder(''), null);
  assert.strictEqual(resolveOrder(null), null);
  assert.strictEqual(resolveOrder(undefined), null);
  assert.strictEqual(resolveOrder('abc'), null);
});

test('iqiyi episode entry keeps episodes that carry no declared order', () => {
  const entry = buildEntry({
    album_order: 0,
    short_display_name: '第1期上 周深教孟子义唱歌',
    play_url: 'qips://ht=2;ischarge=True;tvid=3955178985781600;',
    page_url: 'https://www.iqiyi.com/v_143py19n3f0.html',
  });
  assert.deepStrictEqual(entry, {
    id: '3955178985781600',
    title: '第1期上 周深教孟子义唱歌',
    order: null,
    link: 'https://www.iqiyi.com/v_143py19n3f0.html',
  });
  // 缺少 tvid 或播放页地址的分集无法生成链接
  assert.strictEqual(buildEntry({ page_url: 'https://www.iqiyi.com/v_1.html' }), null);
  assert.strictEqual(buildEntry({ play_url: 'qips://tvid=3955178985781600;' }), null);
});

test('iqiyi episode titles share one format across all episodes', () => {
  const animeTitle = '太古神尊';
  const withoutNumber = ['太子转生', '天魔秘藏'].map((name, index) =>
    ensureNumber(buildTitle({ short_display_name: `${animeTitle} ${name}` }), animeTitle, index + 1)
  );
  const withNumber = ensureNumber(buildTitle({ short_display_name: `${animeTitle} 第11集`, subtitle: '巨额悬赏' }), animeTitle, 11);
  for (const title of [...withoutNumber, withNumber]) {
    assert.match(title, new RegExp(`^${animeTitle} 第\\d+集 `));
  }
});

// 分集列表的解析：离线 mock iqiyi 接口响应
const BASE_INFO_PREFIX = 'https://www.iqiyi.com/prelw/tvg/v2/lw/base_info?';
const SELECTOR_URL = 'https://mesh.if.iqiyi.com/tvg/v2/selector?album_id=203472101&src=lw';

function baseInfoBody(blocks) {
  return { status_code: 0, data: { template: { tabs: [{ blocks }] } } };
}

function videoListBlock(episodes) {
  return {
    bk_type: 'video_list',
    bk_id: 'source_selector_bk',
    tag: ['episodes', 'super_album'],
    data: { data: [{ tab_name: '正片', videos: [{ tab_name: '2025', data: episodes }] }] },
  };
}

function seasonBlock(groups) {
  const list = Array.isArray(groups) ? groups : [groups];
  return {
    bk_type: 'album_episodes',
    bk_id: 'selector_bk',
    tag: ['episodes', 'super_album'],
    data: { data: list },
  };
}

function mockRoutes(routes) {
  return async (input) => {
    const url = String(input);
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) return mockJsonResponse(body, url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const mockBaseInfo = (body) => mockRoutes([[BASE_INFO_PREFIX, body]]);

test('iqiyi variety episodes keep their own titles when the album declares no episode order', async () => {
  resetSearchState();
  // 综艺专辑的 album_order 恒为 0，分集标题自带「第N期」而未带集数
  const body = baseInfoBody([videoListBlock([
    { content_type: 1, album_order: 0, short_display_name: '第1期上 周深教孟子义唱歌', play_url: 'qips://ht=2;tvid=101;', page_url: 'https://www.iqiyi.com/v_101.html' },
    { content_type: 1, album_order: 0, short_display_name: '第1期下 白鹿孟子义二度翻船', play_url: 'qips://ht=2;tvid=102;', page_url: 'https://www.iqiyi.com/v_102.html' },
    { content_type: 0, album_order: 0, short_display_name: '第2期预告', play_url: 'qips://tvid=103;', page_url: 'https://www.iqiyi.com/v_103.html' },
  ])]);
  const anime = { mediaId: '1ex9nkxt0k8', title: '奔跑吧第9季', year: 2025, type: '综艺', imageUrl: '' };
  await withMockFetch(mockBaseInfo(body), () => iqiyi.handleAnimes([anime], '奔跑吧', []));

  const cached = globals.animes.find(entry => (entry.animeTitle || '').startsWith('奔跑吧第9季'));
  assert.ok(cached, '搜索结果应写入缓存');
  assert.strictEqual(cached.episodeCount, 2);
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【qiyi】 第1期上 周深教孟子义唱歌',
    '【qiyi】 第1期下 白鹿孟子义二度翻船',
  ]);
});

test('iqiyi season episodes are kept when the album order is incomplete', async () => {
  resetSearchState();
  const body = baseInfoBody([seasonBlock({
    tab_name: '第一季',
    entity_id: '3502757444826601',
    videos: {
      feature_paged: {
        1: [
          { content_type: 1, album_order: 1, short_display_name: '自然的馈赠', play_url: 'qips://ht=2;tvid=201;', page_url: 'https://www.iqiyi.com/v_201.html' },
          { content_type: 1, album_order: 0, short_display_name: '主食的故事', play_url: 'qips://ht=2;tvid=202;', page_url: 'https://www.iqiyi.com/v_202.html' },
        ],
      },
    },
  })]);
  const episodes = await withMockFetch(mockBaseInfo(body), () => iqiyi.getEpisodes('2408dc6bmoc'));

  // 集号为 0 的分集同样进入列表；集数序列不完整时整张专辑按未声明处理
  assert.deepStrictEqual(episodes.map(episode => episode.title), ['自然的馈赠', '主食的故事']);
  assert.deepStrictEqual(episodes.map(episode => episode.order), [null, null]);
});

test('iqiyi inline season groups are parsed from segment objects', async () => {
  resetSearchState();
  // 条目自身的分季组内联返回，按索引给出段对象：{ "0": { title, data, feature_count } }
  const body = baseInfoBody([seasonBlock({
    tab_name: '第12季',
    entity_id: '8772184898375501',
    videos: {
      '0': {
        title: '1-26',
        feature_count: 26,
        data: [
          { content_type: 1, album_order: 1, short_display_name: '小猪佩奇 第12季 第1集 更大的房子', play_url: 'qips://ht=2;tvid=501;', page_url: 'https://www.iqiyi.com/v_501.html' },
          { content_type: 1, album_order: 2, short_display_name: '小猪佩奇 第12季 第2集 独角兽的节日', play_url: 'qips://ht=2;tvid=502;', page_url: 'https://www.iqiyi.com/v_502.html' },
        ],
      },
    },
  })]);
  const episodes = await withMockFetch(mockBaseInfo(body), () => iqiyi.getEpisodes('1hl6toeycak'));

  assert.deepStrictEqual(episodes.map(episode => episode.id), ['501', '502']);
  assert.deepStrictEqual(episodes.map(episode => episode.order), [1, 2]);
});

test('iqiyi only requests the season group that belongs to the entry', async () => {
  resetSearchState();
  const body = baseInfoBody([seasonBlock([
    { tab_name: '全集', entity_id: '203472101', videos: SELECTOR_URL },
    {
      tab_name: '第12季',
      entity_id: '8772184898375501',
      videos: {
        '0': {
          title: '1-1',
          data: [
            { content_type: 1, album_order: 1, short_display_name: '小猪佩奇 第12季 第1集 更大的房子', play_url: 'qips://ht=2;tvid=601;', page_url: 'https://www.iqiyi.com/v_601.html' },
          ],
        },
      },
    },
  ])]);
  const requested = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith(BASE_INFO_PREFIX)) return mockJsonResponse(body, url);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const episodes = await withMockFetch(fetchImpl, () => iqiyi.getEpisodes('1hl6toeycak'));

  // 同一专辑的其它分季组属于别的搜索结果，不应请求
  assert.deepStrictEqual(episodes.map(episode => episode.id), ['601']);
  assert.ok(requested.every(url => url.startsWith(BASE_INFO_PREFIX)), '不应请求其它分季组的 URL');
});

test('iqiyi season episodes are collected from segmented data', async () => {
  resetSearchState();
  // 指定季的分季组按集数区间分段返回 data.videos，逐段的 data 数组都要展开
  const body = baseInfoBody([seasonBlock({ tab_name: '第一季', entity_id: '3502757444826601', videos: SELECTOR_URL })]);
  const selectorBody = {
    status_code: 0,
    data: {
      videos: [
        { title: '1-2', data: [
          { content_type: 1, album_order: 1, short_display_name: '粉红猪小妹全集 第1集', play_url: 'qips://ht=2;tvid=401;', page_url: 'https://www.iqiyi.com/v_401.html' },
          { content_type: 1, album_order: 2, short_display_name: '粉红猪小妹全集 第2集', play_url: 'qips://ht=2;tvid=402;', page_url: 'https://www.iqiyi.com/v_402.html' },
        ] },
        { title: '3-3', data: [
          { content_type: 1, album_order: 3, short_display_name: '粉红猪小妹全集 第3集', play_url: 'qips://ht=2;tvid=403;', page_url: 'https://www.iqiyi.com/v_403.html' },
          { content_type: 2, album_order: 4, short_display_name: '花絮', play_url: 'qips://ht=2;tvid=404;', page_url: 'https://www.iqiyi.com/v_404.html' },
        ] },
      ],
    },
  };
  const episodes = await withMockFetch(
    mockRoutes([[BASE_INFO_PREFIX, body], [SELECTOR_URL, selectorBody]]),
    () => iqiyi.getEpisodes('2408dc6bmoc', 1)
  );

  assert.deepStrictEqual(episodes.map(episode => episode.id), ['401', '402', '403']);
  assert.deepStrictEqual(episodes.map(episode => episode.order), [1, 2, 3]);
});

test('iqiyi season group selection follows the entry and the target season', () => {
  const select = (groups, season) => IqiyiSource.prototype._selectSeasonGroup.call({}, groups, season);
  const groups = [
    { tab_name: '全集', videos: 'https://example.com/full' },
    { tab_name: '第12季', videos: { '0': { data: [] } } },
    { tab_name: '第11季', videos: 'https://example.com/season11' },
  ];
  // 未指定季时取条目自身的内联分季组
  assert.strictEqual(select(groups, null).tab_name, '第12季');
  // 指定季时取该季分季组，内联分季组季号一致时优先内联
  assert.strictEqual(select(groups, 12).tab_name, '第12季');
  assert.strictEqual(select(groups, 11).tab_name, '第11季');
  // 目标季没有对应分季组时回退到条目自身的分季组
  assert.strictEqual(select(groups, 5).tab_name, '第12季');
});

test('iqiyi season data expands both paged and segmented structures', () => {
  const collect = (videosData) => iqiyi._collectSeasonEpisodes(videosData);
  const paged = { feature_paged: { 1: [{ album_order: 1 }], 2: [{ album_order: 2 }, { album_order: 3 }] } };
  assert.deepStrictEqual(collect(paged).map(episode => episode.album_order), [1, 2, 3]);
  const segmented = { data: { videos: [{ data: [{ album_order: 1 }] }, { data: [{ album_order: 2 }] }] } };
  assert.deepStrictEqual(collect(segmented).map(episode => episode.album_order), [1, 2]);
  const inlineSegments = { '0': { title: '1-2', data: [{ album_order: 1 }, { album_order: 2 }] } };
  assert.deepStrictEqual(collect(inlineSegments).map(episode => episode.album_order), [1, 2]);
  // 结构缺失时返回空数组
  assert.deepStrictEqual(collect(null), []);
  assert.deepStrictEqual(collect('https://mesh.if.iqiyi.com/tvg/v2/selector'), []);
  assert.deepStrictEqual(collect({ data: {} }), []);
  assert.deepStrictEqual(collect({ data: { videos: '1-50' } }), []);
});

test('iqiyi episodes are numbered when the album declares episode order', async () => {
  resetSearchState();
  // 专辑声明了集数顺序、个别分集标题缺集数时，按集号补齐并置于作品名后
  const body = baseInfoBody([seasonBlock({
    tab_name: '第一季',
    entity_id: '3502757444826601',
    videos: {
      feature_paged: {
        1: [
          { content_type: 1, album_order: 7, short_display_name: '太古神尊 外门考核', play_url: 'qips://ht=2;tvid=501;', page_url: 'https://www.iqiyi.com/v_501.html' },
          { content_type: 1, album_order: 5, short_display_name: '太古神尊 天魔秘藏', play_url: 'qips://ht=2;tvid=502;', page_url: 'https://www.iqiyi.com/v_502.html' },
        ],
      },
    },
  })]);
  const anime = { mediaId: '2dssx9squck', title: '太古神尊', year: 2026, type: '3D动漫', imageUrl: '' };
  await withMockFetch(mockBaseInfo(body), () => iqiyi.handleAnimes([anime], '太古神尊', []));

  const cached = globals.animes.find(entry => (entry.animeTitle || '').startsWith('太古神尊'));
  assert.ok(cached, '搜索结果应写入缓存');
  // 集号唯一即按集号排序，与接口返回顺序无关
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【qiyi】 太古神尊 第5集 天魔秘藏',
    '【qiyi】 太古神尊 第7集 外门考核',
  ]);
});

test('iqiyi episodes are not numbered when the album repeats one order', async () => {
  resetSearchState();
  // 把同一期拆成多段发布的专辑，album_order 恒为同一值，不构成集数序列
  const body = baseInfoBody([videoListBlock([
    { content_type: 1, album_order: 1, short_display_name: '第1期 精编版第1期', play_url: 'qips://ht=2;tvid=301;', page_url: 'https://www.iqiyi.com/v_301.html' },
    { content_type: 1, album_order: 1, short_display_name: '第2期 精编版第2期', play_url: 'qips://ht=2;tvid=302;', page_url: 'https://www.iqiyi.com/v_302.html' },
  ])]);
  const anime = { mediaId: '19rrjt9u8g', title: '中国好声音精编版', year: 2012, type: '综艺', imageUrl: '' };
  await withMockFetch(mockBaseInfo(body), () => iqiyi.handleAnimes([anime], '中国好声音', []));

  const cached = globals.animes.find(entry => (entry.animeTitle || '').startsWith('中国好声音精编版'));
  assert.ok(cached, '搜索结果应写入缓存');
  assert.deepStrictEqual(cached.links.map(link => link.title), [
    '【qiyi】 第1期 精编版第1期',
    '【qiyi】 第2期 精编版第2期',
  ]);
});

// 历史问题回归：接口重试、分季组请求去重、搜索结果过滤与 media_id 转换
const SEARCH_URL_PREFIX = 'https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?';

test('iqiyi search retries once when the response is rate limited', async () => {
  let calls = 0;
  const fetchImpl = async (input) => {
    calls++;
    const url = String(input);
    if (!url.startsWith(SEARCH_URL_PREFIX)) throw new Error(`unexpected fetch: ${url}`);
    // 首次响应为风控码，重试后返回正常结构
    const body = calls === 1 ? { code: '-1' } : { code: '0', data: { templates: [] } };
    return mockJsonResponse(body, url);
  };
  const source = new IqiyiSource();
  const results = await withMockFetch(fetchImpl, () => source.search('奔跑吧'));

  assert.strictEqual(calls, 2, '风控响应后应重试一次');
  assert.deepStrictEqual(results, []);
});

test('iqiyi base info retries once when the response is abnormal', async () => {
  let calls = 0;
  const fetchImpl = async (input) => {
    calls++;
    const url = String(input);
    const body = calls === 1
      ? { status_code: -1 }
      : { status_code: 0, data: { template: { tabs: [] } } };
    return mockJsonResponse(body, url);
  };
  const source = new IqiyiSource();
  const data = await withMockFetch(fetchImpl, () => source._fetchBaseInfoData('203472101'));

  assert.strictEqual(calls, 2, '异常响应后应重试一次');
  assert.strictEqual(data.status_code, 0);
});

test('iqiyi requests the same season group only once across entries', async () => {
  resetSearchState();
  const body = baseInfoBody([seasonBlock([
    {
      tab_name: '第12季',
      entity_id: '8772184898375501',
      videos: {
        '0': {
          title: '1-1',
          data: [
            { content_type: 1, album_order: 1, short_display_name: '小猪佩奇 第12季 第1集', play_url: 'qips://ht=2;tvid=701;', page_url: 'https://www.iqiyi.com/v_701.html' },
          ],
        },
      },
    },
    { tab_name: '第一季', entity_id: '3502757444826601', videos: SELECTOR_URL },
  ])]);
  const selectorBody = {
    status_code: 0,
    data: {
      videos: [{
        title: '1-1',
        data: [
          { content_type: 1, album_order: 1, short_display_name: '第一季 第1集', play_url: 'qips://ht=2;tvid=801;', page_url: 'https://www.iqiyi.com/v_801.html' },
        ],
      }],
    },
  };
  let seasonRequests = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(SELECTOR_URL)) {
      seasonRequests++;
      return mockJsonResponse(selectorBody, url);
    }
    if (url.startsWith(BASE_INFO_PREFIX)) return mockJsonResponse(body, url);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const source = new IqiyiSource();
  const seasonCache = new Map();
  // 两个条目都指向同一季分季组，分季组请求在一次搜索内只应发出一次
  await withMockFetch(fetchImpl, () => source.getEpisodes('1hl6toeycak', 1, seasonCache));
  await withMockFetch(fetchImpl, () => source.getEpisodes('19rrl6d4as', 1, seasonCache));

  assert.strictEqual(seasonRequests, 1, '同一次搜索内同一分季组只应请求一次');
});

test('iqiyi does not cache a failed season group request', async () => {
  resetSearchState();
  const body = baseInfoBody([seasonBlock([
    {
      tab_name: '第12季',
      entity_id: '8772184898375501',
      videos: {
        '0': {
          title: '1-1',
          data: [
            { content_type: 1, album_order: 1, short_display_name: '小猪佩奇 第12季 第1集', play_url: 'qips://ht=2;tvid=901;', page_url: 'https://www.iqiyi.com/v_901.html' },
          ],
        },
      },
    },
    { tab_name: '第一季', entity_id: '3502757444826601', videos: SELECTOR_URL },
  ])]);
  let seasonRequests = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(SELECTOR_URL)) {
      seasonRequests++;
      throw new Error('season group request failed');
    }
    if (url.startsWith(BASE_INFO_PREFIX)) return mockJsonResponse(body, url);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const source = new IqiyiSource();
  const seasonCache = new Map();
  const episodes = await withMockFetch(fetchImpl, () => source.getEpisodes('1hl6toeycak', 1, seasonCache));
  await withMockFetch(fetchImpl, () => source.getEpisodes('1hl6toeycak', 1, seasonCache));

  // 分季组请求失败时该条目没有分集，失败结果也不应留在缓存里
  assert.deepStrictEqual(episodes, []);
  assert.strictEqual(seasonRequests, 2, '失败的分季组请求不应被缓存');
});

test('iqiyi movie video id falls back to the entity id when no video link is present', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    // share_url 为短链接且不含 v_xxx.html，取不到视频ID时回退 entity_id
    const body = { status_code: 0, data: { base_data: { share_url: 'https://www.iqiyi.com/s/abc123' } } };
    return mockJsonResponse(body, url);
  };
  const source = new IqiyiSource();
  const videoId = await withMockFetch(fetchImpl, () => source._getMovieVideoId('203472101'));

  assert.strictEqual(videoId, '203472101');
});

test('iqiyi search items are filtered by media type and 3d tags', () => {
  const filter = (album) => IqiyiSource.prototype._filterIqiyiSearchItem.call({}, album, '测试');
  // 外站付费播放、缺少标题与不支持的频道都不保留
  assert.strictEqual(filter({ title: '付费内容', btnText: '外站付费播放', channel: '电影' }), null);
  assert.strictEqual(filter({ channel: '动漫' }), null);
  assert.strictEqual(filter({ title: '未知频道', channel: '音乐' }), null);

  const anime = filter({
    title: '太古神尊',
    channel: '动漫',
    metaTags: [{ name: '3D' }],
    pageUrl: 'https://www.iqiyi.com/v_abc123.html',
    year: { value: '2026' },
  });
  assert.strictEqual(anime.type, '3D动漫');
  assert.strictEqual(anime.mediaId, 'abc123');
  assert.strictEqual(anime.year, 2026);
});

test('iqiyi media id is converted to an entity id', () => {
  const toEntityId = (videoId) => IqiyiSource.prototype._videoIdToEntityId.call(IqiyiSource.prototype, videoId);

  assert.match(toEntityId('1hl6toeycak'), /^\d+$/);
});

// 并发与失败统计：离线 mock fetch，验证 iqiyi 整集分片分批逻辑
async function runIqiyiConcurrencyTest({ batchSize, concurrency, failIndex = -1 }) {
  Globals.init({ IQIYI_CONCURRENCY: String(concurrency) });
  const source = new IqiyiSource();
  // brotli 解压需要真实压缩数据，用例里直接透传未压缩 payload，聚焦分批与失败统计
  source._decompressBrotli = async (bytes) => bytes;
  let maxInFlight = 0;
  let inFlight = 0;
  const PLAYER_URL = `https://www.iqiyi.com/v_test_concurrency.html`;

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === PLAYER_URL) {
      return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html><title>测试剧集</title></html>' };
    }
    if (url.startsWith('https://pcw-api.iq.com/api/decode/')) {
      return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ code: 'A00000', data: 'decoded_tvid_12345' }) };
    }
    if (url.startsWith('https://pcw-api.iqiyi.com/video/video/baseinfo/')) {
      return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ code: 'A00000', data: { durationSec: batchSize * 60 } }) };
    }
    const bulletMatch = url.match(/bullet\/\w{2}\/\w{2}\/decoded_tvid_12345_60_(\d+)_/);
    if (bulletMatch) {
      const pageNo = Number(bulletMatch[1]);
      const index = pageNo - 1;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (index === failIndex) {
          throw new Error('HTTP error! status: 500');
        }
        // 返回 XML 弹幕 payload（首字节为 '<'，命中 _parseIqiyiXmlDanmu）
        const xml = `<i><d><content>第${index}段弹幕</content><showTime>${index * 10}</showTime><color>ffffff</color><likeCount>1</likeCount></d></i>`;
        const bytes = new TextEncoder().encode(xml);
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const comments = await withMockFetch(fetchImpl, () => source.getEpisodeDanmu(PLAYER_URL));
  Globals.init({});
  return { comments, maxInFlight };
}

test('iqiyi 整集弹幕按 IQIYI_CONCURRENCY 分批且保留分片顺序', async () => {
  const { comments, maxInFlight } = await runIqiyiConcurrencyTest({ batchSize: 12, concurrency: 3 });
  assert.equal(maxInFlight <= 3, true, `峰值并发 ${maxInFlight} 应不超过 3`);
  assert.equal(comments.length, 12);
  for (let i = 0; i < 12; i++) {
    assert.equal(comments[i].content, `第${i}段弹幕`);
  }
});

test('iqiyi 单个分片失败不影响其余分片并输出统计', async () => {
  globals.logBuffer.length = 0;
  const { comments, maxInFlight } = await runIqiyiConcurrencyTest({ batchSize: 6, concurrency: 3, failIndex: 2 });
  assert.equal(maxInFlight <= 3, true);
  assert.equal(comments.length, 5);
  const summary = globals.logBuffer.find((entry) => entry.message.includes('分段下载完成: 5/6'));
  const failure = globals.logBuffer.find((entry) => entry.message.includes('第 3 个分片请求失败'));
  assert.ok(summary, '应输出分段完成统计');
  assert.ok(failure, '应输出失败分片信息');
});
