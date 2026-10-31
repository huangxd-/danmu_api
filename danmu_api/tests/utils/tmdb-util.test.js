// TMDB 工具：季标记剥离与检索词清洗
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Globals } from '../../configs/globals.js';
import { Bangumi, Season } from '../../models/dandan-model.js';
import { initBangumiData, clearBangumiDataCache, getBackgroundDownload, PRUNED_ITEM_FIELDS } from '../../utils/bangumi-data-util.js';
import { getTmdbJaOriginalTitle, stripSeasonMarker, cleanSearchQuery, smartTitleReplace } from '../../utils/tmdb-util.js';
import { mockJsonResponse, withMockFetch } from '../helpers/context.js';

test('tmdb stripSeasonMarker 剥离季与分部标记', () => {
  assert.strictEqual(stripSeasonMarker('スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE'), 'スティール・ボール・ラン ジョジョの奇妙な冒険', '序数 STAGE 标记被剥离');
  assert.strictEqual(stripSeasonMarker('飙马野郎 JOJO的奇妙冒险 第一赛段'), '飙马野郎 JOJO的奇妙冒险', '中文赛段标记被剥离');
  assert.strictEqual(stripSeasonMarker('ワンパンマン 2nd Season'), 'ワンパンマン', '序数 Season 标记被剥离');
  assert.strictEqual(stripSeasonMarker('無職転生 第2期'), '無職転生', '第X期标记被剥离');
  assert.strictEqual(stripSeasonMarker('ふしぎ遊戯 第二部'), 'ふしぎ遊戯', '中文部标记被剥离');
  assert.strictEqual(stripSeasonMarker('GANTZ 〜the 2nd stage〜'), 'GANTZ 〜the', '夹在波浪号中的序数标记被剥离');
  // 分隔符与影片类型词不属季与分部标记，标题其余部分保留
  assert.strictEqual(stripSeasonMarker('Re:ゼロから始める異世界生活'), 'Re:ゼロから始める異世界生活', '冒号不触发剥离');
  assert.strictEqual(stripSeasonMarker('も～っと！おジャ魔女どれみ'), 'も～っと！おジャ魔女どれみ', '波浪号不触发剥离');
  assert.strictEqual(stripSeasonMarker('ONE PIECE FILM RED'), 'ONE PIECE FILM RED', '影片类型词不触发剥离');
  // 标记位于标题开头时保留原标题，避免检索关键词被清空
  assert.strictEqual(stripSeasonMarker('四季樱'), '四季樱', '含「四季」的标题保留原样');
  assert.strictEqual(stripSeasonMarker('一期一会 恋バナ友バナ'), '一期一会 恋バナ友バナ', '含「一期」的标题保留原样');
  assert.strictEqual(stripSeasonMarker('第九部落'), '第九部落', '含「第九部」的标题保留原样');
});
test('tmdb getTmdbJaOriginalTitle 按 Bangumi Data 原名剥离分部标记', async () => {
  // 真实场景：以「スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE」为检索词会在巴哈命中「頭文字 D 1st stage」
  const cachePath = path.join(process.cwd(), '.cache', 'bangumi-data-cache.json');
  const hadCache = await fs.access(cachePath).then(() => true, () => false);
  const backup = hadCache ? await fs.readFile(cachePath) : null;
  const savedUseBangumiData = Globals.envs.useBangumiData;

  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({
      // 必须带上当前裁剪字段清单：缺 prunedFields 会被 isCacheFormatOutdated 判定为未按当前规则裁剪，
      // 从而触发真实 CDN 版本查询与下载（走 node-fetch，withMockFetch 拦不住）。
      prunedFields: PRUNED_ITEM_FIELDS,
      items: [{
        title: 'スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE',
        type: 'tv',
        sites: [{ site: 'gamer', id: '20144', video_sn: '40245' }, { site: 'bangumi', id: '639938' }],
        begin: '2026-03-18T16:00:00.000Z',
        titleTranslate: { 'zh-Hans': ['飙马野郎 JOJO的奇妙冒险 第一赛段'] },
        _flatText: 'スティール・ボール・ラン ジョジョの奇妙な冒険 1st stage飙马野郎 jojo的奇妙冒险 第一赛段',
      }],
    }));
    Globals.envs.useBangumiData = true;
    await initBangumiData('node', true);
    // 本用例只验证检索词剥离，缓存格式合法时不得启动任何后台下载（防止悄悄打真实 CDN）
    assert.strictEqual(getBackgroundDownload(), null, '按当前规则裁剪的缓存不应触发后台下载');

    const result = await getTmdbJaOriginalTitle('飙马野郎', null, 'Bahamut');
    assert.strictEqual(result.title, 'スティール・ボール・ラン ジョジョの奇妙な冒険', '出站检索词剥离分部标记');
    assert.strictEqual(result.cnAlias, '飙马野郎 JOJO的奇妙冒险 第一赛段', '展示别名保持原样');
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
    clearBangumiDataCache(false);
    if (hadCache) await fs.writeFile(cachePath, backup);
    else await fs.rm(cachePath, { force: true });
  }
});
test('tmdb getTmdbJaOriginalTitle 按 TMDB 原名剥离分部标记', async () => {
  // 与 Bangumi Data 分支同一诉求：出站检索词去除季与分部标记，展示别名保持原样
  Globals.init({ LOG_LEVEL: 'error' });
  const savedUseBangumiData = Globals.envs.useBangumiData;
  const savedTmdbApiKey = Globals.envs.tmdbApiKey;
  const json = (data) => mockJsonResponse(data, '');

  try {
    Globals.envs.useBangumiData = false;
    Globals.envs.tmdbApiKey = 'season-marker-probe';

    const result = await withMockFetch(async (url) => {
      const target = String(url);
      if (target.includes('/search/multi')) {
        return json({ results: [{
          id: 45790,
          media_type: 'tv',
          name: '飙马野郎 JOJO的奇妙冒险 第一赛段',
          original_name: 'スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE',
          genre_ids: [16],
          original_language: 'ja',
        }] });
      }
      if (target.includes('/alternative_titles')) {
        return json({ titles: [{ iso_3166_1: 'CN', title: '飙马野郎 JOJO的奇妙冒险 第一赛段' }] });
      }
      if (/\/3\/tv\/45790/.test(target)) {
        return json({ id: 45790, original_name: 'スティール・ボール・ラン ジョジョの奇妙な冒険 1st STAGE', genres: [{ id: 16 }], original_language: 'ja' });
      }
      throw new Error(`未预期的请求: ${target}`);
    }, () => getTmdbJaOriginalTitle('飙马野郎', null, 'Bahamut'));

    assert.strictEqual(result.title, 'スティール・ボール・ラン ジョジョの奇妙な冒険', '出站检索词剥离分部标记');
    assert.strictEqual(result.cnAlias, '飙马野郎 JOJO的奇妙冒险 第一赛段', '展示别名保持原样');
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
    Globals.envs.tmdbApiKey = savedTmdbApiKey;
  }
});
test('tmdb cleanSearchQuery 识别序数与中文赛段后缀', () => {
  assert.strictEqual(cleanSearchQuery('ワンパンマン 2nd Season'), 'ワンパンマン', '序数 Season 识别为后缀');
  assert.strictEqual(cleanSearchQuery('頭文字 D 1st stage'), '頭文字 D', '序数 stage 识别为后缀');
  assert.strictEqual(cleanSearchQuery('飙马野郎 JOJO的奇妙冒险 第一赛段'), '飙马野郎 JOJO的奇妙冒险', '中文赛段识别为后缀');
  assert.strictEqual(cleanSearchQuery('無職転生 第2期'), '無職転生', '第X期识别为后缀');
  // 后缀判据与出站检索词剥离识别同一套季与分部标记
  assert.strictEqual(cleanSearchQuery('ワンパンマン 2nd Season'), stripSeasonMarker('ワンパンマン 2nd Season'), '与出站剥离对序数标记的处理一致');
  assert.strictEqual(cleanSearchQuery('飙马野郎 JOJO的奇妙冒险 第一赛段'), stripSeasonMarker('飙马野郎 JOJO的奇妙冒险 第一赛段'), '与出站剥离对中文赛段的处理一致');
});
test('tmdb cleanSearchQuery 副标题分隔判定', () => {
  // 词内标点不构成副标题分隔
  assert.strictEqual(cleanSearchQuery('Re:ゼロから始める異世界生活'), 'Re:ゼロから始める異世界生活', '词内冒号不截断');
  assert.strictEqual(cleanSearchQuery('も～っと！おジャ魔女どれみ'), 'も～っと！おジャ魔女どれみ', '词内波浪号不截断');
  assert.strictEqual(cleanSearchQuery('地獄先生ぬ～べ～'), '地獄先生ぬ～べ～', '两端词内波浪号不截断');
  assert.strictEqual(cleanSearchQuery('哆啦A梦：大雄的恐龙'), '哆啦A梦：大雄的恐龙', '中文冒号副标题不截断');
  assert.strictEqual(cleanSearchQuery('CØDE:BREAKER OAD'), 'CØDE:BREAKER', '词内冒号保留而影片类型后缀仍剥离');
  // 真正的副标题仍被剥离
  assert.strictEqual(cleanSearchQuery('Fate/stay night: Unlimited Blade Works'), 'Fate/stay night', '冒号带空白时剥离副标题');
  assert.strictEqual(cleanSearchQuery('進擊的巨人: Wall Sina,Goodbye'), '進擊的巨人', '冒号带空白时剥离中文片名副标题');
  assert.strictEqual(cleanSearchQuery('我們不可能成為戀人！絕對不行。（※似乎可行？）～NextShine～'), '我們不可能成為戀人！絕對不行。（※似乎可行？）', '全角波浪号副标题被剥离');
  assert.strictEqual(cleanSearchQuery('わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）〜ネクストシャイン！〜'), 'わたしが恋人になれるわけないじゃん、ムリムリ!（※ムリじゃなかった!?）', 'U+301C 波浪号副标题被剥离');
  assert.strictEqual(cleanSearchQuery('あした元気にな~れ!~半分のさつまいも~'), 'あした元気にな~れ!', '词内波浪号保留且其后副标题被剥离');
});
test('tmdb cleanSearchQuery 后缀白名单的影片类型与篇分支', () => {
  assert.strictEqual(cleanSearchQuery('呪術廻戦 劇場版'), '呪術廻戦', '剧场版标记被剥离');
  assert.strictEqual(cleanSearchQuery('STEINS;GATE OVA'), 'STEINS;GATE', 'OVA 标记被剥离且分号不触发截断');
  assert.strictEqual(cleanSearchQuery('链锯人 蕾塞篇'), '链锯人', '「篇」标记被剥离');
  assert.strictEqual(cleanSearchQuery('クレヨンしんちゃん 2'), 'クレヨンしんちゃん', '尾部季号数字被剥离');
});
test('tmdb smartTitleReplace 保留季与分部标记后缀', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  // 单条时走 LCP 模式，季与分部标记后缀保留
  const single = [{ title: '進撃の巨人 The Final Season Part 2' }];
  smartTitleReplace(single, '進擊的巨人');
  assert.strictEqual(single[0]._displayTitle, '進擊的巨人 The Final Season Part 2', 'LCP 模式保留季与分部标记后缀');
  // 多条且无公共前缀时走分隔符模式，词内冒号不构成副标题分隔
  const multi = [{ title: 'Re:ゼロから始める異世界生活' }, { title: 'おジャ魔女どれみ' }];
  smartTitleReplace(multi, 'Re:从零开始的异世界生活');
  assert.strictEqual(multi[0]._displayTitle, 'Re:ゼロから始める異世界生活', '词内冒号标题不按分隔符拆分成前后缀');
});
test('tmdb smartTitleReplace 常规标题的替换结果', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  // 单条：整条即公共前缀，替换为别名
  const single = [{ title: 'GNOSIA' }];
  smartTitleReplace(single, '古诺希亚');
  assert.strictEqual(single[0]._displayTitle, '古诺希亚', '整条标题替换为别名');
  // 多条：公共前缀替换为别名，其后的季号与副标题保留
  const multi = [
    { title: 'SPY×FAMILY 間諜家家酒 Season 3' },
    { title: 'SPY×FAMILY 間諜家家酒 CODE: White' },
    { title: 'SPY×FAMILY 間諜家家酒 Season 2' },
    { title: 'SPY×FAMILY 間諜家家酒' },
  ];
  smartTitleReplace(multi, '间谍过家家');
  assert.deepStrictEqual(multi.map((anime) => anime._displayTitle), [
    '间谍过家家 Season 3',
    '间谍过家家 CODE: White',
    '间谍过家家 Season 2',
    '间谍过家家',
  ], '公共前缀替换为别名且保留其后的季号与副标题');
});
test('tmdb smartTitleReplace 分隔符模式与前缀保护模式', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  // 无公共前缀时按首个分隔符拆分为前后缀，前缀替换为别名
  const delimiter = [{ title: 'Re:Zero kara Hajimeru Isekai Seikatsu' }, { title: 'この素晴らしい世界に祝福を!' }];
  smartTitleReplace(delimiter, 'Re:从零开始的异世界生活');
  assert.strictEqual(delimiter[0]._displayTitle, 'Re:从零开始的异世界生活 kara Hajimeru Isekai Seikatsu', '前缀替换为别名并保留其后内容');
  // 前缀本身是季与分部标记时保留前缀
  const prefixed = [{ title: '第2期 無職転生' }, { title: 'この素晴らしい世界に祝福を!' }];
  smartTitleReplace(prefixed, '无职转生');
  assert.strictEqual(prefixed[0]._displayTitle, '第2期 无职转生', '前缀为季号时保留前缀并替换其后内容');
});
