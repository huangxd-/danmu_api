import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from '../../configs/globals.js';
import { getSourceLabel, getSourceMetaByKey, initSources } from '../../sources/registry.js';

function initRegistry() {
  Globals.init({ LOG_LEVEL: 'error' });
  initSources();
}

test('getSourceMetaByKey 标记采集源与官源', () => {
  initRegistry();
  // 采集源聚合多个播放平台；官源只产出自身平台资源
  for (const key of ['360', 'vod', 'tmdb', 'douban']) {
    assert.equal(getSourceMetaByKey(key)?.aggregator, true, `${key} 应为采集源`);
  }
  for (const key of ['tencent', 'youku', 'bilibili', 'local']) {
    assert.equal(getSourceMetaByKey(key)?.aggregator, false, `${key} 应为官源`);
  }
});

test('getSourceLabel 为采集源附加标注，官源保持展示名', () => {
  initRegistry();
  assert.equal(getSourceLabel('douban'), '豆瓣（采集源）');
  assert.equal(getSourceLabel('360'), '360 影视（采集源）');
  assert.equal(getSourceLabel('tencent'), '腾讯视频');
  assert.equal(getSourceLabel('local'), '本地弹幕');
});

test('getSourceLabel 对未注册的键返回原值', () => {
  initRegistry();
  assert.equal(getSourceLabel('unknown-source'), 'unknown-source');
});
