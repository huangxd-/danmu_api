// FongMi 兼容接口：季感知集号打分
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { buildFongmiApiBase, extractFongmiSeasonNumber, scoreFongmiEpisodeMatch } from '../../../apis/clients/fongmi-api.js';
import { Globals } from '../../../configs/globals.js';
import { Season } from '../../../models/dandan-model.js';

test('fongmi-api comment base preserves token and strips danmaku route suffixes', () => {
  Globals.init({ TOKEN: 'user-token-1', ADMIN_TOKEN: 'admin-tok' });
  const base = path => buildFongmiApiBase({ url: `https://example.com${path}` });

  assert.equal(base('/'), 'https://example.com');
  assert.equal(base('/danmaku'), 'https://example.com');
  assert.equal(base('/danmaku/'), 'https://example.com');
  assert.equal(base('/api/v2/fongmi/danmaku'), 'https://example.com');
  assert.equal(base('/danmaku/api/v2/fongmi/danmaku'), 'https://example.com');
  assert.equal(base('/danmaku/api/v2/fongmi/danmaku/'), 'https://example.com');
  assert.equal(base('/danmaku//api/v2/fongmi/danmaku/'), 'https://example.com');
  assert.equal(base('//danmaku///api//v2/fongmi/danmaku//'), 'https://example.com');
  assert.equal(base('/api//v2/fongmi/danmaku'), 'https://example.com');
  assert.equal(base('/user-token-1'), 'https://example.com/user-token-1');
  assert.equal(base('/user-token-1/danmaku'), 'https://example.com/user-token-1');
  assert.equal(base('/user-token-1/danmaku/api/v2/fongmi/danmaku'), 'https://example.com/user-token-1');
  assert.equal(base('/user-token-1/danmaku//api/v2/fongmi/danmaku/'), 'https://example.com/user-token-1');
  assert.equal(base('/admin-tok//danmaku/'), 'https://example.com/admin-tok');

  // TOKEN 本身恰好叫 danmaku 时，不能被误当成路由后缀删除。
  Globals.init({ TOKEN: 'danmaku' });
  assert.equal(base('/danmaku'), 'https://example.com/danmaku');
});

test('fongmi-api season aware scoring', () => {
  // 季号提取: SxxExx / 第x季 / Season N / 2x05; 综艺日期与纯集数不误判
  assert.equal(extractFongmiSeasonNumber('人生切割术 S02E05'), 2);
  assert.equal(extractFongmiSeasonNumber('Show.S02.E05.2160p.WEB-DL.mkv'), 2);
  assert.equal(extractFongmiSeasonNumber('庆余年 第2季第03集'), 2);
  assert.equal(extractFongmiSeasonNumber('Show Season 3 EP01'), 3);
  assert.equal(extractFongmiSeasonNumber('剧名 2x05'), 2);
  assert.equal(extractFongmiSeasonNumber('1920x1080'), null);
  assert.equal(extractFongmiSeasonNumber('凡人修仙传 第01集'), null);
  assert.equal(extractFongmiSeasonNumber('奔跑吧 第20180512期'), null);
  assert.equal(extractFongmiSeasonNumber(''), null);

  const mk = (animeTitle, episodeTitle, index) => ({ anime: { animeTitle }, episode: { episodeTitle }, index });
  const scoreOf = (c, target) => scoreFongmiEpisodeMatch(c.anime, c.episode, target, c.index);

  // 跨季同号集: 集数加分对第一/二季完全同分(11196), 修复后第二季必须稳定胜出, 不再由源返回顺序决定
  const targetS2 = '人生切割术 S02E05';
  const s2e5 = mk('人生切割术 第二季(2025)【电视剧】from renren', '【renren】 第05集', 4);
  const s1e5 = mk('人生切割术 第一季(2022)【电视剧】from renren', '【renren】 第05集', 4);
  assert.equal(scoreOf(s2e5, targetS2), 196 + 7000 + 4000 + 5000);
  assert.equal(scoreOf(s1e5, targetS2), 196 + 7000 + 4000 - 12000);
  // 候选枚举顺序翻转也不影响自动首条
  for (const ordered of [[s1e5, s2e5], [s2e5, s1e5]]) {
    const best = ordered.map(c => ({ ...c, score: scoreOf(c, targetS2) }))
      .sort((a, b) => b.score - a.score)[0];
    assert.ok(best.anime.animeTitle.includes('第二季'), 'S02E05 自动首条必须是第二季');
  }

  // 目标 S01 时同样必须回到第一季
  const best = [s1e5, s2e5].map(c => ({ ...c, score: scoreOf(c, '人生切割术 S01E05') }))
    .sort((a, b) => b.score - a.score)[0];
  assert.ok(best.anime.animeTitle.includes('第一季'), 'S01E05 自动首条必须是第一季');

  // 目标带季但候选剧名无季标注: 不调整, 保持原有行为
  const anon = mk('人生切割术(2022)【韩剧】from hanjutv', '【hanjutv】 第5集', 4);
  assert.equal(scoreOf(anon, targetS2), 196 + 7000 + 4000);

  // 目标无季标注: 完全不受影响(向后兼容); 文本包含加分(+4500)为原有行为
  const plain = mk('凡人修仙传', '第05集', 4);
  assert.equal(scoreOf(plain, '凡人修仙传 第05集'), 196 + 7000 + 4000 + 4500);
});
