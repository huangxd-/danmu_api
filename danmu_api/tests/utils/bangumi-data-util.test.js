// Bangumi Data：去重与缓存格式裁剪判定
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Bangumi } from '../../models/dandan-model.js';
import { dedupeBangumiSearchResults, isCacheFormatOutdated, PRUNED_ITEM_FIELDS } from '../../utils/bangumi-data-util.js';
import { extendBangumiDownloadLifecycle } from '../../utils/bangumi-data-util.js';

    
  // 测试 Bangumi Data 本地检索结果的同源去重
test('dedupeBangumiSearchResults should dedupe same-source results and skip tmdb', () => {
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
test('Bangumi Data isCacheFormatOutdated 缓存未按当前规则裁剪时触发重新下载', () => {
  // 判定依据为缓存内登记的字段清单：缺少清单登记或清单与当前不一致时，缓存即缺少当前规则保留的字段
  assert.strictEqual(isCacheFormatOutdated({ items: [{ title: 'x', _flatText: 'x' }] }), true, '无字段清单登记的缓存需重新下载');
  assert.strictEqual(isCacheFormatOutdated({ items: [{ title: 'x' }], prunedFields: null }), true, '字段清单为空时需重新下载');
  assert.strictEqual(isCacheFormatOutdated({ items: [{ title: 'x' }], prunedFields: ['title', 'type'] }), true, '字段清单与当前不一致需重新下载');
  assert.strictEqual(isCacheFormatOutdated({ items: [{ title: 'x' }], prunedFields: PRUNED_ITEM_FIELDS }), false, '字段清单一致无需重新下载');
  assert.strictEqual(isCacheFormatOutdated({ items: [] }), false, '空缓存不触发');
  assert.strictEqual(isCacheFormatOutdated(null), false, '无缓存不触发');
});

test('extendBangumiDownloadLifecycle 在无在途或 ctx 缺失时不注册', async () => {
  const calls = [];
  extendBangumiDownloadLifecycle(null);
  extendBangumiDownloadLifecycle({ waitUntil: (p) => calls.push(p) });
  assert.strictEqual(calls.length, 0);
});
