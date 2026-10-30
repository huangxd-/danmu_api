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
import { getTmdbJaOriginalTitle, stripSeasonMarker, cleanSearchQuery, smartTitleReplace, getTMDBChineseTitle, buildTmdbSeasonBoundaries, getTmdbSeasonBoundaries, searchTmdbTitles } from '../../utils/tmdb-util.js';
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
// 构造 getTMDBChineseTitle 的 TMDB 搜索与别名 mock，返回解析结果与别名请求次数
async function runTitleToChinese({ query, season = 1, searchResults, altId, altData = { results: [] } }) {
  const savedUseBangumiData = Globals.envs.useBangumiData;
  const savedTmdbApiKey = Globals.envs.tmdbApiKey;
  Globals.envs.useBangumiData = false;
  Globals.envs.tmdbApiKey = 'title-to-chinese-probe';
  let altRequestCount = 0;
  try {
    const result = await withMockFetch(async (url) => {
      const target = String(url);
      if (target.includes('/search/')) return mockJsonResponse({ results: searchResults }, '');
      if (target.includes(`/${altId}/alternative_titles`)) {
        altRequestCount++;
        return mockJsonResponse(altData, '');
      }
      throw new Error(`未预期的请求: ${target}`);
    }, () => getTMDBChineseTitle(query, season, 1));
    return { result, altRequestCount };
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
    Globals.envs.tmdbApiKey = savedTmdbApiKey;
  }
}

test('tmdb getTMDBChineseTitle 按原名匹配并从别名取中文名', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  // Wednesday：正确条目 119051 的本地化标题为英文，中文名只在别名（CN/TW 星期三）
  const wednesday = await runTitleToChinese({
    query: 'Wednesday',
    searchResults: [
      { id: 11303, name: '周三剧场', original_name: 'The Wednesday Play' },
      { id: 119051, name: 'Wednesday', original_name: 'Wednesday' },
    ],
    altId: 119051,
    altData: { results: [
      { iso_3166_1: 'CN', title: '星期三' },
      { iso_3166_1: 'TW', title: '星期三' },
      { iso_3166_1: 'US', title: 'Wednesday Addams' },
    ] },
  });
  assert.strictEqual(wednesday.result, '星期三', '按 original_name 选中正确条目并取 CN 中文名');

  // RIPLEY：正确条目 94028 的本地化标题为英文，中文名只在别名（CN 雷普利）
  const ripley = await runTitleToChinese({
    query: 'RIPLEY',
    searchResults: [
      { id: 94028, name: 'RIPLEY', original_name: 'RIPLEY' },
      { id: 297659, name: '亲密的雷普利', original_name: '친밀한 리플리' },
    ],
    altId: 94028,
    altData: { results: [
      { iso_3166_1: 'CN', title: '雷普利' },
      { iso_3166_1: 'US', title: 'Ripley' },
    ] },
  });
  assert.strictEqual(ripley.result, '雷普利', '按 original_name 选中正确条目并取 CN 中文名');
});

test('tmdb getTMDBChineseTitle 电影按 original_title 匹配并从别名取中文名', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const { result } = await runTitleToChinese({
    query: 'The Gorge',
    season: null,
    searchResults: [
      { id: 1, title: '错误电影', original_title: 'WrongMovie' },
      { id: 2, title: 'The Gorge', original_title: 'The Gorge' },
    ],
    altId: 2,
    altData: { titles: [{ iso_3166_1: 'CN', title: '峡谷' }] },
  });
  assert.strictEqual(result, '峡谷', '电影按 original_title 选中正确条目并从 titles 别名取中文名');
});

test('tmdb getTMDBChineseTitle 本地化标题为中文时不请求别名', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const { result, altRequestCount } = await runTitleToChinese({
    query: 'SomeForeign',
    searchResults: [{ id: 5, name: '某中文名', original_name: 'SomeForeign' }],
    altId: 5,
    altData: { results: [{ iso_3166_1: 'CN', title: '其它中文名' }] },
  });
  assert.strictEqual(result, '某中文名', '本地化标题为中文时直接使用');
  assert.strictEqual(altRequestCount, 0, '本地化标题为中文时不请求别名');
});

test('tmdb getTMDBChineseTitle 无原名命中时回退首个含中文名结果', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const { result, altRequestCount } = await runTitleToChinese({
    query: 'UnknownQuery',
    searchResults: [
      { id: 1, name: 'English Only', original_name: 'SomethingElse' },
      { id: 2, name: '中文候选', original_name: 'AnotherForeign' },
    ],
    altId: 1,
    altData: { results: [] },
  });
  assert.strictEqual(result, '中文候选', '无原名命中时沿用首个含中文名的结果');
  assert.strictEqual(altRequestCount, 0, '回退分支不请求别名');
});

test('tmdb getTMDBChineseTitle 原名命中但别名无中文时回退本地化标题', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const { result, altRequestCount } = await runTitleToChinese({
    query: 'Ripley2',
    searchResults: [{ id: 9, name: 'Ripley2', original_name: 'Ripley2' }],
    altId: 9,
    altData: { results: [{ iso_3166_1: 'US', title: 'Ripley2' }] },
  });
  assert.strictEqual(result, 'Ripley2', '别名无中文时回退本地化标题');
  assert.strictEqual(altRequestCount, 1, '原名命中且本地化标题非中文时请求 1 次别名');
});
test('tmdb getTMDBChineseTitle 别名按地区优先级取中文名', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const searchResults = [{ id: 119051, name: 'Wednesday', original_name: 'Wednesday' }];
  const pick = async (altResults) => (await runTitleToChinese({
    query: 'Wednesday', searchResults, altId: 119051, altData: { results: altResults },
  })).result;

  assert.strictEqual(await pick([
    { iso_3166_1: 'US', title: 'Wednesday Addams' },
    { iso_3166_1: 'SG', title: '星期三SG' },
    { iso_3166_1: 'HK', title: '星期三HK' },
    { iso_3166_1: 'TW', title: '星期三TW' },
    { iso_3166_1: 'CN', title: '星期三CN' },
  ]), '星期三CN', 'CN 优先于 TW/HK/SG');

  assert.strictEqual(await pick([
    { iso_3166_1: 'SG', title: '星期三SG' },
    { iso_3166_1: 'HK', title: '星期三HK' },
    { iso_3166_1: 'TW', title: '星期三TW' },
  ]), '星期三TW', '无 CN 时 TW 优先于 HK/SG');

  assert.strictEqual(await pick([
    { iso_3166_1: 'US', title: 'Wednesday Addams' },
    { iso_3166_1: 'SG', title: '星期三SG' },
  ]), '星期三SG', '无 CN/TW/HK 时取 SG');

  assert.strictEqual(await pick([
    { iso_3166_1: 'US', title: '星期三US' },
  ]), '星期三US', '无地区匹配时取任意中文别名');
});

test('tmdb getTMDBChineseTitle 别名请求仅针对选中结果', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const { result, altRequestCount } = await runTitleToChinese({
    query: 'Wednesday',
    searchResults: [
      { id: 1, name: '周三剧场', original_name: 'The Wednesday Play' },
      { id: 2, name: 'The Wednesday Thriller', original_name: 'The Wednesday Thriller' },
      { id: 3, name: 'My Wednesday', original_name: 'My Wednesday' },
      { id: 119051, name: 'Wednesday', original_name: 'Wednesday' },
      { id: 5, name: 'Wednesday 9:30', original_name: 'Wednesday 9:30 (8:30 Central)' },
    ],
    altId: 119051,
    altData: { results: [{ iso_3166_1: 'CN', title: '星期三' }] },
  });
  assert.strictEqual(result, '星期三', '选中唯一定名匹配的正确条目');
  assert.strictEqual(altRequestCount, 1, '5 条搜索结果中仅对选中结果发起 1 次别名请求');
});
test('tmdb buildTmdbSeasonBoundaries 按各季起始集推导跨季边界', () => {
  // 同一 tv/{id} 下三季，起始集 1/13/25：按起始集排序并赋 order 1..3
  const bounds = buildTmdbSeasonBoundaries([
    { matchedSiteKey: 'tmdb', siteId: 'tv/123/season/3/episode/25', title: 'S3' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/123/season/1/episode/1', title: 'S1' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/123/season/2/episode/13', title: 'S2' },
  ]);
  assert.deepStrictEqual(bounds, [
    { order: 1, startEpisode: 1, title: 'S1', tmdbId: 'tv/123' },
    { order: 2, startEpisode: 13, title: 'S2', tmdbId: 'tv/123' },
    { order: 3, startEpisode: 25, title: 'S3', tmdbId: 'tv/123' },
  ], '按起始集排序并顺序赋 order');

  // 无 episode 的 siteId 起始集视为 1
  assert.deepStrictEqual(buildTmdbSeasonBoundaries([
    { matchedSiteKey: 'tmdb', siteId: 'tv/9', title: 'Base' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/9/season/2/episode/13', title: 'S2' },
  ]), [
    { order: 1, startEpisode: 1, title: 'Base', tmdbId: 'tv/9' },
    { order: 2, startEpisode: 13, title: 'S2', tmdbId: 'tv/9' },
  ], '缺 episode 时起始集为 1');

  // 仅单季（同一 tv id 只有 1 条）→ null
  assert.strictEqual(buildTmdbSeasonBoundaries([
    { matchedSiteKey: 'tmdb', siteId: 'tv/1/season/1/episode/1', title: 'S1' },
  ]), null, '单季不构成跨季边界');

  // 无 tmdb 站点或非 tv siteId → null
  assert.strictEqual(buildTmdbSeasonBoundaries([
    { matchedSiteKey: 'bangumi', siteId: 'tv/1' },
    { matchedSiteKey: 'tmdb', siteId: 'movie/2' },
  ]), null, '非 tmdb 站点与非 tv siteId 均被跳过');

  assert.strictEqual(buildTmdbSeasonBoundaries([]), null, '空结果返回 null');

  // 多个 tv id 时取条目最多的一组
  const most = buildTmdbSeasonBoundaries([
    { matchedSiteKey: 'tmdb', siteId: 'tv/1/season/1/episode/1', title: 'A1' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/1/season/2/episode/6', title: 'A2' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/2/season/1/episode/1', title: 'B1' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/2/season/2/episode/6', title: 'B2' },
    { matchedSiteKey: 'tmdb', siteId: 'tv/2/season/3/episode/11', title: 'B3' },
  ]);
  assert.deepStrictEqual(most.map(b => b.tmdbId), ['tv/2', 'tv/2', 'tv/2'], '取条目最多的 tv id');
});

test('tmdb getTmdbSeasonBoundaries 受 Bangumi Data 开关与检索结果控制', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedUseBangumiData = Globals.envs.useBangumiData;
  try {
    // 关闭 Bangumi Data 时直接返回 null，且不调用检索函数
    Globals.envs.useBangumiData = false;
    let called = 0;
    const stub = async () => { called++; return []; };
    assert.strictEqual(await getTmdbSeasonBoundaries('某番', stub), null, '关闭时返回 null');
    assert.strictEqual(called, 0, '关闭时不调用检索函数');

    // 开启时用检索结果推导跨季边界
    Globals.envs.useBangumiData = true;
    const bounds = await getTmdbSeasonBoundaries('某番', async () => ([
      { matchedSiteKey: 'tmdb', siteId: 'tv/7/season/1/episode/1', title: 'S1' },
      { matchedSiteKey: 'tmdb', siteId: 'tv/7/season/2/episode/13', title: 'S2' },
    ]));
    assert.deepStrictEqual(bounds.map(b => b.startEpisode), [1, 13], '由检索结果推导边界');

    // 检索函数抛错时回退 null
    const failed = await getTmdbSeasonBoundaries('某番', async () => { throw new Error('boom'); });
    assert.strictEqual(failed, null, '检索异常时回退 null');
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
  }
});

test('tmdb searchTmdbTitles 多页合并与不足一页即停', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedTmdbApiKey = Globals.envs.tmdbApiKey;
  Globals.envs.tmdbApiKey = 'pagination-probe';
  try {
    const make = (count, prefix) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));
    let calls = 0;
    const { data } = await withMockFetch(async (url) => {
      const target = String(url);
      const pageMatch = target.match(/[?&]page=(\d+)/);
      calls++;
      if (pageMatch && pageMatch[1] === '2') return mockJsonResponse({ results: make(5, 'b') }, '');
      return mockJsonResponse({ results: make(20, 'a') }, '');
    }, () => searchTmdbTitles('某番', 'multi'));
    assert.strictEqual(calls, 2, '首页满 20 条继续请求下一页，次页不足 20 条即停');
    assert.strictEqual(data.results.length, 25, '合并两页结果');
  } finally {
    Globals.envs.tmdbApiKey = savedTmdbApiKey;
  }
});
test('tmdb getTmdbJaOriginalTitle 过滤非动画非日语结果', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedUseBangumiData = Globals.envs.useBangumiData;
  const savedTmdbApiKey = Globals.envs.tmdbApiKey;
  const json = (payload) => mockJsonResponse(payload, '');
  try {
    Globals.envs.useBangumiData = false;
    Globals.envs.tmdbApiKey = 'ja-filter-probe';

    // 全部为非动画且非日语：数据清洗后为空，返回 null 且不请求详情
    let detailCalls = 0;
    const onlyNonTarget = await withMockFetch(async (url) => {
      const target = String(url);
      if (target.includes('/search/multi')) return json({ results: [
        { id: 1, media_type: 'tv', name: 'Some Drama', original_name: 'Some Drama', genre_ids: [18], original_language: 'en' },
      ] });
      if (/\/3\/tv\/\d+/.test(target)) { detailCalls++; return json({ id: 1, name: 'Some Drama' }); }
      throw new Error(`未预期的请求: ${target}`);
    }, () => getTmdbJaOriginalTitle('Some Drama', null, 'Test'));
    assert.strictEqual(onlyNonTarget, null, '全部非动画非日语时返回 null');
    assert.strictEqual(detailCalls, 0, '清洗为空时不请求详情');

    // 混合：非动画结果被过滤，仅动画结果参与匹配
    const mixed = await withMockFetch(async (url) => {
      const target = String(url);
      if (target.includes('/search/multi')) return json({ results: [
        { id: 1, media_type: 'tv', name: 'Alpha', original_name: 'Alpha', genre_ids: [18], original_language: 'en' },
        { id: 2, media_type: 'tv', name: 'Alpha', original_name: 'Alpha', genre_ids: [16], original_language: 'ja' },
      ] });
      if (/\/3\/tv\/2\b/.test(target)) return json({ id: 2, original_name: 'アルファ', genres: [{ id: 16 }], original_language: 'ja' });
      throw new Error(`未预期的请求: ${target}`);
    }, () => getTmdbJaOriginalTitle('Alpha', null, 'Test'));
    assert.ok(mixed, '存在动画结果时返回匹配');
    assert.strictEqual(mixed.title, 'アルファ', '同名非动画结果被过滤后取自动画结果（id=2）');
    assert.strictEqual(mixed.cnAlias, 'Alpha', '动画结果名与原检索词一致');
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
    Globals.envs.tmdbApiKey = savedTmdbApiKey;
  }
});
test('tmdb getTmdbJaOriginalTitle 别名精确命中检索词优先于中文别名', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedUseBangumiData = Globals.envs.useBangumiData;
  const savedTmdbApiKey = Globals.envs.tmdbApiKey;
  const json = (payload) => mockJsonResponse(payload, '');
  try {
    Globals.envs.useBangumiData = false;
    Globals.envs.tmdbApiKey = 'ja-alias-exact-probe';

    const result = await withMockFetch(async (url) => {
      const target = String(url);
      if (target.includes('/alternative_titles')) return json({ results: [
        { iso_3166_1: 'US', title: 'Shingeki' },
        { iso_3166_1: 'CN', title: '进击的巨人' },
      ] });
      if (target.includes('/search/multi')) return json({ results: [
        { id: 11, media_type: 'tv', name: 'Shingeki no Kyojin', original_name: '進撃の巨人', genre_ids: [16], original_language: 'ja' },
      ] });
      if (/\/3\/tv\/11\b/.test(target)) return json({ id: 11, original_name: '進撃の巨人', genres: [{ id: 16 }], original_language: 'ja' });
      throw new Error(`未预期的请求: ${target}`);
    }, () => getTmdbJaOriginalTitle('Shingeki', null, 'Test'));

    assert.ok(result, '存在动画结果时返回匹配');
    assert.strictEqual(result.cnAlias, 'Shingeki', '别名精确命中检索词时优先于地区中文别名');
    assert.strictEqual(result.title, '進撃の巨人', '原名来自详情');
  } finally {
    Globals.envs.useBangumiData = savedUseBangumiData;
    Globals.envs.tmdbApiKey = savedTmdbApiKey;
  }
});
