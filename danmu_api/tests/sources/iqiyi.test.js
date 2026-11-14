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

function seasonBlock(group) {
  return {
    bk_type: 'album_episodes',
    bk_id: 'selector_bk',
    tag: ['episodes', 'super_album'],
    data: { data: [group] },
  };
}

function mockBaseInfo(body) {
  return async (input) => {
    const url = String(input);
    if (url.startsWith(BASE_INFO_PREFIX)) return mockJsonResponse(body, url);
    throw new Error(`unexpected fetch: ${url}`);
  };
}

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
