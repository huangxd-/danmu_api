// iqiyi 源：分集标题的组装与集数补齐

import test from 'node:test';
import assert from 'node:assert';
import IqiyiSource from '../../sources/iqiyi.js';
import { Globals, globals } from '../../configs/globals.js';
import { withMockFetch } from '../helpers/context.js';

const buildTitle = (epData) => IqiyiSource.prototype._buildEpisodeTitle.call({}, epData);
const ensureNumber = (title, animeTitle, order) =>
  IqiyiSource.prototype._ensureEpisodeNumber.call({}, title, animeTitle, order);

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
