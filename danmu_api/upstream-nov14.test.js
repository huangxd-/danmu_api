import test from 'node:test';
import assert from 'node:assert/strict';

import { Globals } from './configs/globals.js';
import { groupDanmusByMinute } from './utils/danmu-util.js';
import {
  applyEpisodeTitleFilter,
  filterEpisodesByTitle,
  resolveEpisodeCount,
  withAvailableEpisodeCount
} from './apis/player-api.js';
import { parseAutoMatchMappingRules } from './utils/auto-match-mapping-util.js';
import { applyTitleMappingWithLog } from './utils/title-mapping-url-util.js';

function reset(extra = {}) {
  Globals.init({ TOKEN_AUTH_DISABLED: 'true', LOG_LEVEL: 'error', ...extra });
}

const comment = (time, message, source) => ({ p: `${time},1,16777215,[${source}]`, m: message });

// ---------- 多源时点去重（上游 #558） ----------

test('多源相邻百分位的时间聚成同一时间点并去重', () => {
  const merged = groupDanmusByMinute([
    comment('251.25', '同一句弹幕', 'bilibili'),
    comment('251.26', '同一句弹幕', 'dandan')
  ], 0, true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].m, '同一句弹幕');
  assert.equal(merged[0].p, '251.25,1,16777215,[bilibili＆dandan]');
});

test('超出容差的时间点不合并', () => {
  const merged = groupDanmusByMinute([
    comment('251.25', '同一句弹幕', 'bilibili'),
    comment('251.30', '同一句弹幕', 'dandan')
  ], 0, true);
  assert.equal(merged.length, 2);
});

test('先按时间排序再聚簇，乱序输入也能合并', () => {
  const merged = groupDanmusByMinute([
    comment('300.10', '另一句', 'tencent'),
    comment('251.26', '同一句弹幕', 'dandan'),
    comment('251.25', '同一句弹幕', 'bilibili')
  ], 0, true);
  assert.deepEqual(merged.map(item => item.m), ['同一句弹幕', '另一句']);
  assert.deepEqual(merged.map(item => item.t), [251.25, 300.1]);
});

test('单源 n=0 只按时间排序，不改动传入数组', () => {
  const input = [comment('20', '后', 'tencent'), comment('10', '前', 'tencent')];
  const before = input.map(item => item.p);
  const merged = groupDanmusByMinute(input, 0, false);
  assert.deepEqual(merged.map(item => item.m), ['前', '后']);
  assert.deepEqual(input.map(item => item.p), before);
});

// ---------- 集数按过滤后可用集数上报（上游 #559） ----------

test('集数取声明值与可用集数的较小值', () => {
  assert.equal(resolveEpisodeCount(21, 10), 10);
  assert.equal(resolveEpisodeCount(10, 21), 10);
  assert.equal(resolveEpisodeCount(0, 5), 5);
  assert.equal(resolveEpisodeCount(21, 0), 21);
  assert.equal(resolveEpisodeCount(undefined, 3), 3);
});

test('集标题过滤统一走 filterEpisodesByTitle', () => {
  reset({ EPISODE_TITLE_FILTER: '预告|花絮' });
  const episodes = [
    { episodeTitle: '第1集' },
    { episodeTitle: '第1集 预告' },
    { episodeTitle: '第2集' }
  ];
  assert.deepEqual(filterEpisodesByTitle(episodes).map(item => item.episodeTitle), ['第1集', '第2集']);
});

test('过滤链接时把可用集数写回动漫', () => {
  reset({ EPISODE_TITLE_FILTER: '预告' });
  const anime = { animeId: 1, animeTitle: '测试作品', episodeCount: 21 };
  const episodes = applyEpisodeTitleFilter(anime, [
    { id: 'a', title: '第1集' },
    { id: 'b', title: '第1集 预告' },
    { id: 'c', title: '第2集' }
  ]);
  assert.deepEqual(episodes.map(item => [item.episodeId, item.episodeNumber]), [['a', 1], ['c', 3]]);
  assert.equal(anime.episodeCount, 2);
});

test('缓存命中按可用集数上报且不改写缓存对象', () => {
  reset({ EPISODE_TITLE_FILTER: '预告', ENABLE_ANIME_EPISODE_FILTER: 'true' });
  const cached = { animeId: 7, animeTitle: '缓存作品', episodeCount: 21 };
  const details = new Map([[7, { links: [{ id: 'a', title: '第1集' }, { id: 'b', title: '第1集 预告' }] }]]);
  const reported = withAvailableEpisodeCount([cached], anime => details.get(anime.animeId));
  assert.equal(reported[0].episodeCount, 1);
  assert.equal(reported[0].animeTitle, '缓存作品');
  assert.equal(cached.episodeCount, 21);
  assert.equal(reported[0] === cached, false);
  reset({ EPISODE_TITLE_FILTER: '预告' });
  assert.equal(withAvailableEpisodeCount([cached], anime => details.get(anime.animeId))[0], cached);
});

// ---------- 特别篇 S00 映射（上游 #560） ----------

test('源侧支持 S00 特别篇映射到正常季集', () => {
  const { rules, warnings } = parseAutoMatchMappingRules('灵笼 S00E01~01 -> 灵笼 S01E07~07');
  assert.deepEqual(warnings, []);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].sourceSeason, 0);
  assert.equal(rules[0].sourceStartEpisode, 1);
  assert.equal(rules[0].targetSeason, 1);
  assert.equal(rules[0].targetStartEpisode, 7);
});

test('目标侧仍拒绝 S00', () => {
  const { rules, warnings } = parseAutoMatchMappingRules('灵笼 S01E01 -> 灵笼 S00E02');
  assert.equal(rules.length, 0);
  assert.equal(warnings.length, 1);
});

test('剧名映射未精确命中时忽略尾部年份重试', () => {
  reset({ TITLE_MAPPING_TABLE: '变形金刚3：月黑之时->变形金刚3 月黑之时' });
  assert.equal(applyTitleMappingWithLog('变形金刚3：月黑之时(2011)'), '变形金刚3 月黑之时');
  assert.equal(applyTitleMappingWithLog('变形金刚3：月黑之时'), '变形金刚3 月黑之时');
});

test('带年份的精确键优先于忽略年份的键', () => {
  reset({ TITLE_MAPPING_TABLE: '变形金刚3：月黑之时(2011)->精确年份;变形金刚3：月黑之时->忽略年份' });
  assert.equal(applyTitleMappingWithLog('变形金刚3：月黑之时(2011)'), '精确年份');
  assert.equal(applyTitleMappingWithLog('变形金刚3：月黑之时'), '忽略年份');
});
