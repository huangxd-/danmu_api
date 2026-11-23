// 合并工具：副源匹配与集对齐
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Envs } from '../../configs/envs.js';
import { Globals } from '../../configs/globals.js';
import { Season } from '../../models/dandan-model.js';
import { findSecondaryMatches, applyMergeLogic, resolveDubVersionLinkIndex, mergeLinkEntry, cleanText } from '../../utils/merge-util.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createTrace, runWithTrace, traceStep, useAsyncLocalStorage } from '../../utils/pipeline-trace.js';

test('merge findSecondaryMatches 忽略规则与剧集标题的季度与类型噪声', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedRules = Globals.envs.customMergeRules;
  const savedEnvRules = process.env.CUSTOM_MERGE_RULES;

  const buildAnime = (animeId, animeTitle, source, aliases = []) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases,
    source,
    type: 'web',
    typeDescription: '网络放送',
    startDate: '2026-03-18T16:00:00.000Z',
    links: [],
  });

  try {
    process.env.CUSTOM_MERGE_RULES = [
      '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】@animeko -> 飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】@dandan',
      '剧场版 刀剑神域 进击篇 黯淡黄昏的谐谑曲(2022)【剧场版】@dandan -> 剧场版 刀剑神域 进击篇 无星之夜的咏叹调(2021)【剧场版】@bahamut',
    ].join(';');
    Globals.envs.customMergeRules = Envs.resolveCustomMergeRules();

    // 规则标题含「第X赛段」时，两侧需做一致的季度噪声剥离后才能严格比对命中
    const dandanStage1 = buildAnime(19287, '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】from dandan', 'dandan');
    const animekoStage23 = buildAnime(639938, '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】from animeko', 'animeko');
    assert.deepStrictEqual(
      findSecondaryMatches(dandanStage1, [animekoStage23], new Set(), ['animeko']).map((a) => a.animeId),
      [639938],
      '规则标题含「第二&第三赛段」仍能命中主源「第一赛段」',
    );
    // 传入空的 baseSecondaries 时，只有特权通道能放行：用于判别规则是否真的命中（而非仅靠相似度通过）
    assert.deepStrictEqual(
      findSecondaryMatches(dandanStage1, [animekoStage23], new Set(), []).map((a) => a.animeId),
      [639938],
      '规则命中后不受权限沙箱限制',
    );

    // 规则标题含「剧场版」时，两侧需做一致的类型噪声剥离后才能严格比对命中
    const bahamutMovie = buildAnime(90001, '剧场版 刀剑神域 进击篇 无星之夜的咏叹调(2021)【剧场版】from bahamut', 'bahamut');
    const dandanMovie = buildAnime(90002, '剧场版 刀剑神域 进击篇 黯淡黄昏的谐谑曲(2022)【剧场版】from dandan', 'dandan');
    assert.deepStrictEqual(
      findSecondaryMatches(bahamutMovie, [dandanMovie], new Set(), []).map((a) => a.animeId),
      [90002],
      '规则标题含「剧场版」仍能命中',
    );

    // 规则标题显式写「季」时两侧均不剥离季度噪声：规则所写的季命中，其它季不匹配
    process.env.CUSTOM_MERGE_RULES = '某测试动画 第三季(2026)【TV动画】@bilibili -> 某测试动画 第二季(2026)【TV动画】@dandan';
    Globals.envs.customMergeRules = Envs.resolveCustomMergeRules();
    const seasonPrimary = buildAnime(91001, '某测试动画 第二季(2026)【TV动画】from dandan', 'dandan');
    const seasonSecondary = buildAnime(91002, '某测试动画 第三季(2026)【TV动画】from bilibili', 'bilibili');
    const seasonOther = buildAnime(91003, '某测试动画 第二季(2026)【TV动画】from bilibili', 'bilibili');
    assert.deepStrictEqual(
      findSecondaryMatches(seasonPrimary, [seasonSecondary], new Set(), []).map((a) => a.animeId),
      [91002],
      '规则显式写季时规则所写的季命中',
    );
    assert.strictEqual(
      findSecondaryMatches(seasonPrimary, [seasonOther], new Set(), []).length,
      0,
      '规则显式写季时其它季不匹配',
    );

    // 与规则无关的作品仍按常规相似度判定，不因噪声剥离而被放行
    const unrelatedAnime = buildAnime(90003, '完全无关的测试作品(2026)【TV动画】from dandan', 'dandan');
    assert.strictEqual(
      findSecondaryMatches(unrelatedAnime, [animekoStage23], new Set(), []).length,
      0,
      '无关作品不被放行',
    );
  } finally {
    Globals.envs.customMergeRules = savedRules;
    if (savedEnvRules === undefined) delete process.env.CUSTOM_MERGE_RULES;
    else process.env.CUSTOM_MERGE_RULES = savedEnvRules;
  }
});

test('merge findSecondaryMatches 标题年份一致时豁免类型标签差异', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, typeDescription) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription,
    startDate: '1973-04-06T00:00:00.000Z',
    links: Array.from({ length: 53 }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: 53,
  });
  const matched = (primary, secondary) => findSecondaryMatches(primary, [secondary], new Set(), [secondary.source]).length;

  // 同一部作品在不同源被标注为电视剧与动漫，标题中年份一致时跳过媒体类型冲突检测
  assert.strictEqual(matched(
    buildAnime(1, '泰罗奥特曼(1973)【电视剧】from tencent', 'tencent', '电视剧'),
    buildAnime(2, '泰罗奥特曼(1973)【动漫】from iqiyi', 'iqiyi', '动漫'),
  ), 1, '年份一致时豁免电视剧与动漫的类型差异');

  assert.strictEqual(matched(
    buildAnime(3, '泰罗奥特曼(1973)【电视剧】from tencent', 'tencent', '电视剧'),
    buildAnime(4, '泰罗奥特曼(1996)【动漫】from iqiyi', 'iqiyi', '动漫'),
  ), 0, '年份不同时不豁免类型差异');
});
test('merge findSecondaryMatches 配音版本年份豁免与季标记集证据', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    typeDescription: '电视剧',
    startDate: /\((\d{4})\)/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: titles.map((title) => ({ title })),
    episodeCount: titles.length,
  });
  const epTitles = (count, names) => Array.from({ length: count }, (_, i) => `第${i + 1}集 ${names[i % names.length]}`);
  const matched = (primary, secondary) => findSecondaryMatches(primary, [secondary], new Set(), [secondary.source]).length > 0;

  // 配音版本条目年份取配音版本自身发行年的来源参与时，年份差 10 年以内豁免
  assert.strictEqual(matched(
    buildAnime(1, '工作细胞（中配版）(2021)【电视剧】from bilibili', 'bilibili', epTitles(13, ['红细胞'])),
    buildAnime(2, '工作细胞(2018)【电视剧】from dandan', 'dandan', epTitles(13, ['红细胞'])),
  ), true, 'bilibili 配音版本年份差豁免');

  // 其余来源的配音版本不享有年份豁免
  assert.strictEqual(matched(
    buildAnime(3, '倚天屠龙记[普通话版](2001)【电视剧】from tencent', 'tencent', epTitles(42, ['天涯思君不可忘'])),
    buildAnime(4, '倚天屠龙记(2009)【电视剧】from aiyifan', 'aiyifan', epTitles(40, ['少年张无忌'])),
  ), false, '非 bilibili 配音版本不做年份豁免');

  // 年份差 2 年时季标记豁免需集证据：正片集数相差超过 1 集且集标题不同则不豁免
  assert.strictEqual(matched(
    buildAnime(5, '倚天屠龙记[普通话版](2001)【电视剧】from tencent', 'tencent', epTitles(42, ['天涯思君不可忘'])),
    buildAnime(6, '倚天屠龙记(2003)【电视剧】from aiyifan', 'aiyifan', epTitles(40, ['少年张无忌'])),
  ), false, '集数相差 2 集且集标题不同时不豁免');

  // 正片集数相差不超过 1 集时豁免成立
  assert.strictEqual(matched(
    buildAnime(7, '倚天屠龙记(2001)【电视剧】from tencent', 'tencent', epTitles(42, ['天涯思君不可忘'])),
    buildAnime(8, '倚天屠龙记(2003)【电视剧】from aiyifan', 'aiyifan', epTitles(41, ['少年张无忌'])),
  ), true, '正片集数相差 1 集内豁免成立');

  // 正片集数相差超过 1 集时，集标题字符集不一致的双方不作集证据
  assert.strictEqual(matched(
    buildAnime(13, '咒术回战(2021)【电视剧】from tencent', 'tencent', epTitles(13, ['两面宿傩'])),
    buildAnime(14, '咒术回战(2023)【电视剧】from bahamut', 'bahamut', epTitles(15, ['宿儺のはなし'])),
  ), false, '集标题字符集不一致时不做集标题证据');

  assert.strictEqual(matched(
    buildAnime(15, '咒术回战(2021)【电视剧】from tencent', 'tencent', epTitles(13, ['两面宿傩'])),
    buildAnime(16, '咒术回战(2023)【电视剧】from bilibili', 'bilibili', epTitles(15, ['两面宿傩'])),
  ), true, '集标题同字符集且采样相似时豁免成立');

  // 两侧集标题都是剧名本身（冗余标题字段）时不具备区分能力，不作为集证据
  assert.strictEqual(matched(
    buildAnime(17, '倚天屠龙记[普通话版](2001)【电视剧】from tencent', 'tencent', Array.from({ length: 42 }, () => '倚天屠龙记')),
    buildAnime(18, '倚天屠龙记(2003)【电视剧】from aiyifan', 'aiyifan', Array.from({ length: 40 }, () => '倚天屠龙记')),
  ), false, '集标题为剧名本身时不做集标题证据');
  // EN 集标题：两侧同为拉丁字母时按字符集判定为同一语种，参与采样
  assert.strictEqual(matched(
    buildAnime(19, 'Drama X(2021)【电视剧】from tencent', 'tencent', ['Episode One', 'Episode Two', 'Episode Three']),
    buildAnime(20, 'Drama X(2023)【电视剧】from aiyifan', 'aiyifan', ['Episode One', 'Episode Two', 'Episode Three', 'Episode Four', 'Episode Five']),
  ), true, 'EN 集标题同字符集且采样相似时豁免成立');
  // 集标题既无假名、也无汉字拉丁字母（无脚本）时不作为集证据
  assert.strictEqual(matched(
    buildAnime(21, 'Drama Y(2021)【电视剧】from tencent', 'tencent', ['①②③', '④⑤⑥', '⑦⑧⑨']),
    buildAnime(22, 'Drama Y(2023)【电视剧】from aiyifan', 'aiyifan', ['①②③', '④⑤⑥', '⑦⑧⑨', '⑩⑪⑫', '⑬⑭⑮']),
  ), false, '集标题无脚本时不作为集证据');

  // 年份差 1 年以内不进入豁免链
  assert.strictEqual(matched(
    buildAnime(9, 'FX战士久留美(2026)【TV动画】from dandan', 'dandan', epTitles(4, ['日常'])),
    buildAnime(10, 'FX战士久留美(2027)【TV动画】from bahamut', 'bahamut', epTitles(2, ['日常'])),
  ), true, '年份差 1 年直接通过');

  // 合并映射表特权通道不受年份校验影响
  const savedRules = Globals.envs.customMergeRules;
  const savedEnvRules = process.env.CUSTOM_MERGE_RULES;
  try {
    process.env.CUSTOM_MERGE_RULES = '倚天屠龙记(2003)【电视剧】@aiyifan -> 倚天屠龙记[普通话版](2001)【电视剧】@tencent';
    Globals.envs.customMergeRules = Envs.resolveCustomMergeRules();
    assert.strictEqual(
      findSecondaryMatches(
        buildAnime(11, '倚天屠龙记[普通话版](2001)【电视剧】from tencent', 'tencent', epTitles(42, ['天涯思君不可忘'])),
        [buildAnime(12, '倚天屠龙记(2003)【电视剧】from aiyifan', 'aiyifan', epTitles(40, ['少年张无忌']))],
        new Set(), [],
      ).length, 1, '映射表特权通道照常放行');
  } finally {
    process.env.CUSTOM_MERGE_RULES = savedEnvRules;
    Globals.envs.customMergeRules = savedRules;
  }
});
test('merge findSecondaryMatches hanjutv 年份按无效日期处理', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const epTitles = (count, name) => Array.from({ length: count }, (_, i) => `第${i + 1}集 ${name}`);
  const buildAnime = (animeId, animeTitle, source, startDate, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: '电视剧',
    startDate,
    links: titles.map((title) => ({ title })),
    episodeCount: titles.length,
  });

  // hanjutv 的年份字段不准确，参与比对时按无效日期处理，年份差不参与判定
  assert.strictEqual(
    findSecondaryMatches(
      buildAnime(1, '大奉打更人(2024)【电视剧】from hanjutv', 'hanjutv', '2019-01-01T00:00:00.000Z', epTitles(42, '天涯思君不可忘')),
      [buildAnime(2, '大奉打更人(2024)【电视剧】from youku', 'youku', '2024-12-28T00:00:00.000Z', epTitles(40, '少年张无忌'))],
      new Set(), ['youku'],
    ).length,
    1, 'hanjutv 年份不参与比对',
  );

  assert.strictEqual(
    findSecondaryMatches(
      buildAnime(3, '大奉打更人(2024)【电视剧】from tencent', 'tencent', '2019-01-01T00:00:00.000Z', epTitles(42, '天涯思君不可忘')),
      [buildAnime(4, '大奉打更人(2024)【电视剧】from youku', 'youku', '2024-12-28T00:00:00.000Z', epTitles(40, '少年张无忌'))],
      new Set(), ['youku'],
    ).length,
    0, '其余来源的年份差照常阻断',
  );

  // 副源为 hanjutv 时同样按无效日期处理
  assert.strictEqual(
    findSecondaryMatches(
      buildAnime(5, '大奉打更人(2024)【电视剧】from tencent', 'tencent', '2024-12-28T00:00:00.000Z', epTitles(42, '天涯思君不可忘')),
      [buildAnime(6, '大奉打更人(2024)【电视剧】from hanjutv', 'hanjutv', '2019-01-01T00:00:00.000Z', epTitles(40, '少年张无忌'))],
      new Set(), ['hanjutv'],
    ).length,
    1, '副源为 hanjutv 时年份不参与比对',
  );
});

test('merge findSecondaryMatches 同一配音版本只并入一条', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    typeDescription: /【电影】/.test(animeTitle) ? '电影' : '电视剧',
    startDate: /\((\d{4})\)/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: titles.map((title) => ({ title })),
    episodeCount: titles.length,
  });
  const titlesOf = (list) => findSecondaryMatches(list.primary, list.secondaries, new Set(), ['aiyifan']).map((a) => a.animeTitle);

  // 主源为粤语版时，另一部作品的粤语版不并入，只保留分数最高的同语言一条
  assert.deepStrictEqual(titlesOf({
    primary: buildAnime(1, '倚天屠龙记之圣火雄风粤语(2022)【电影】from iqiyi', 'iqiyi', ['正片']),
    secondaries: [
      buildAnime(2, '倚天屠龙记之九阳神功(粤语)(2022)【电影】from aiyifan', 'aiyifan', ['正片']),
      buildAnime(3, '倚天屠龙记之圣火雄风(粤语)(2022)【电影】from aiyifan', 'aiyifan', ['正片']),
    ],
  }), ['倚天屠龙记之圣火雄风(粤语)(2022)【电影】from aiyifan'], '同配音版本只保留最高分一条');

  // 不同配音版本各保留一条
  assert.strictEqual(titlesOf({
    primary: buildAnime(4, '倚天屠龙记之圣火雄风(2022)【电影】from iqiyi', 'iqiyi', ['正片']),
    secondaries: [
      buildAnime(5, '倚天屠龙记之圣火雄风(粤语)(2022)【电影】from aiyifan', 'aiyifan', ['正片']),
      buildAnime(6, '倚天屠龙记之圣火雄风(国语)(2022)【电影】from aiyifan', 'aiyifan', ['正片']),
    ],
  }).length, 2, '不同配音版本各保留一条');

  // 同一作品的同语言结果来自多个来源时，同样只并入最高分的一条
  assert.deepStrictEqual(titlesOf({
    primary: buildAnime(7, '倚天屠龙记之九阳神功(2022)【电影】from iqiyi', 'iqiyi', ['正片']),
    secondaries: [
      buildAnime(8, '倚天屠龙记之九阳神功(粤语)(2022)【电影】from aiyifan', 'aiyifan', ['正片']),
      buildAnime(9, '倚天屠龙记之九阳神功粤语(2022)【电影】from tencent', 'tencent', ['正片']),
    ],
  }).length, 1, '同一作品的同语言结果只保留最高分一条');
});
test('merge findSecondaryMatches 剧场版阻断按标题与别名全集比对', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, typeDescription, startDate, count, aliases = []) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases,
    source,
    type: typeDescription,
    typeDescription,
    startDate,
    links: Array.from({ length: count }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: count,
  });

  // 电影（bilibili）与动画某季（animeko）因「别名」命中完全一致而得到 1.0 相似度，
  // 剧场版阻断须在「标题 + 别名」全集上判定，才能拦住这类跨类型误合并
  const movie  = buildAnime(1, '银河护卫队(2014)【电影】from bilibili', 'bilibili', '电影', '2014-08-01T00:00:00.000Z', 2);
  const series = buildAnime(2, '银河守护者 第一季(2015)【TV动画】from animeko', 'animeko', 'TV动画', '2015-09-26T00:00:00.000Z', 26, ['银河护卫队']);
  assert.deepStrictEqual(
    findSecondaryMatches(movie, [series], new Set(), ['animeko']).map((a) => a.animeId),
    [],
    '电影与共享别名的动画季不应合并',
  );

  // 同为 TV 动画且标题一致仍正常合并，阻断不影响常规匹配
  const tvPrimary   = buildAnime(3, '银河守护者 第二季(2017)【TV动画】from dandan', 'dandan', 'TV动画', '2017-01-01T00:00:00.000Z', 25);
  const tvSecondary = buildAnime(4, '银河守护者 第二季(2017)【TV动画】from animeko', 'animeko', 'TV动画', '2017-01-01T00:00:00.000Z', 25);
  assert.deepStrictEqual(
    findSecondaryMatches(tvPrimary, [tvSecondary], new Set(), ['animeko']).map((a) => a.animeId),
    [4],
    'TV 动画之间不受剧场版阻断影响',
  );
});

test('merge applyMergeLogic 集对齐不绕过年份校验', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&aiyifan' });
  const epLinks = (count, name) => Array.from({ length: count }, (_, i) => ({
    title: `${name}_${String(i + 1).padStart(2, '0')}`,
    url: `https://example.com/${encodeURIComponent(name)}/${i + 1}`,
  }));
  const buildAnime = (animeId, animeTitle, source, links) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: '电视剧',
    typeDescription: '电视剧',
    startDate: /\((\d{4})\)/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links,
  });

  const primary = buildAnime(1, '倚天屠龙记[普通话版](2001)【电视剧】from tencent', 'tencent', epLinks(42, '倚天屠龙记[普通话版]'));
  const wrong   = buildAnime(2, '倚天屠龙记(2003)【电视剧】from aiyifan', 'aiyifan', epLinks(40, '倚天屠龙记'));

  Globals.animes = [primary, wrong];
  await applyMergeLogic([primary, wrong]);

  // 合并写入的是主源副本，原主源与副源对象不被改写，故按结果列表是否新增合并条目判定
  assert.strictEqual(
    Globals.animes.some((anime) => String(anime.animeTitle).includes('from tencent&aiyifan')), false,
    '年份差 2 年的同名不同作品不因集对齐而关联',
  );
  assert.strictEqual(Globals.animes.length, 2, '未产生合并条目');
});
test('merge resolveDubVersionLinkIndex 按配音版本选择主源链接', () => {
  const filteredLinks = [
    { link: { title: '【qq】 倚天屠龙记之九阳神功(普通话版)', url: 'mandarin' }, originalIndex: 0 },
    { link: { title: '【qq】 倚天屠龙记之九阳神功(粤语版)', url: 'cantonese' }, originalIndex: 1 },
  ];
  const titleOf = (link) => link.title;

  assert.strictEqual(
    resolveDubVersionLinkIndex(filteredLinks, 0, '倚天屠龙记之九阳神功(粤语)(2022)【电影】from aiyifan', titleOf, 'tencent'),
    1, '粤语副源选择粤语主源链接');
  assert.strictEqual(
    resolveDubVersionLinkIndex(filteredLinks, 0, '倚天屠龙记之九阳神功(国语)(2022)【电影】from aiyifan', titleOf, 'tencent'),
    0, '国语副源落在国语主源链接');
  assert.strictEqual(
    resolveDubVersionLinkIndex(filteredLinks, 0, '倚天屠龙记之九阳神功(2022)【电影】from aiyifan', titleOf, 'tencent'),
    0, '副源无配音标识时保持原链接');
  assert.strictEqual(
    resolveDubVersionLinkIndex([filteredLinks[0]], 0, '倚天屠龙记之九阳神功(粤语)(2022)【电影】from aiyifan', titleOf, 'tencent'),
    0, '主源无同配音版本链接时保持原链接');
});
test('merge mergeLinkEntry 拼接复合 URL 并在标题标签中追加来源', () => {
  const target = { url: 'https://v.qq.com/x/cover/abc/1.html', title: '【qq】 倚天屠龙记之九阳神功(普通话版)' };
  const aiyifan = { url: 'https://www.yfsp.tv/play/2hRswEx6yr4?id=x', title: '【aiyifan】 720P' };

  const first = mergeLinkEntry(target, aiyifan, 'aiyifan', 'tencent');
  assert.strictEqual(first.url, 'tencent:https://v.qq.com/x/cover/abc/1.html$$$aiyifan:https://www.yfsp.tv/play/2hRswEx6yr4?id=x', '主源 URL 补来源前缀后再追加副源分段');
  assert.strictEqual(first.title, '【qq&aiyifan】 倚天屠龙记之九阳神功(普通话版)', '标题标签追加副源标签');

  const second = mergeLinkEntry({ url: first.url, title: first.title }, { url: 'u2', title: '【dandan】 1080P' }, 'dandan', 'tencent');
  assert.strictEqual(second.url, first.url + '$$$dandan:u2', '已含复合分隔符时直接追加分段');
  assert.strictEqual(second.title, '【qq&aiyifan&dandan】 倚天屠龙记之九阳神功(普通话版)', '标题标签继续追加');

  const noTag = mergeLinkEntry(target, { url: 'u3', title: '720P' }, 'migu', 'tencent');
  assert.strictEqual(noTag.title, '【qq&migu】 倚天屠龙记之九阳神功(普通话版)', '副源标题无标签时使用来源名');

  const mismatched = mergeLinkEntry(target, { url: 'u4', title: '【other】 720P' }, 'migu', 'tencent');
  assert.strictEqual(mismatched.title, '【qq&other】 倚天屠龙记之九阳神功(普通话版)', '标题标签以副源链接自带标签优先');
});
test('merge findSecondaryMatches 英文别名中的独立 I 不作季度标记', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, aliases) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases,
    source,
    typeDescription: 'TV动画',
    startDate: /(\d{4})/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: 12,
  });
  const matched = (primary, secondary) => findSecondaryMatches(primary, [secondary], new Set(), [secondary.source]).length > 0;
  const englishAliases = ['相反的你和我', 'Seihantai na Kimi to Boku', '正反対な君と僕', 'You and I Are Polar Opposites'];

  const primary = buildAnime(1, '正相反的你与我(2026)【TV动画】from dandan', 'dandan', englishAliases);

  // 别名中的英文标题含独立代词 I，不得被读成第 1 季标记而掩盖与第一季的季度冲突
  assert.strictEqual(matched(primary, buildAnime(2, '正相反的你与我 第二季(2026)【TV动画】from bahamut', 'bahamut',
    [...englishAliases, '相反的你和我 第二季', 'You and I are Polar Opposites Season 2'])), false, '含英文标题别名的第二季仍与第一季冲突');

  assert.strictEqual(matched(primary, buildAnime(3, '正相反的你与我 第二季(2026)【TV动画】from animeko', 'animeko',
    ['相反的你和我 第二季', '正相反的你与我 第二季'])), false, '仅中文别名的第二季与第一季冲突');

  assert.strictEqual(matched(primary, buildAnime(4, '正相反的你与我(2026)【TV动画】from animeko', 'animeko',
    englishAliases)), true, '同季候选不受影响');
});
test('merge findSecondaryMatches 别名参与候选比对', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source, aliases) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases,
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2023-09-29T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: 12,
  });
  const matched = (secondary) => findSecondaryMatches(
    buildAnime(1, '葬送的芙莉莲(2023)【TV动画】from bilibili', 'bilibili', ['Frieren: Beyond the Journey End', '葬送のフリーレン']),
    [secondary], new Set(), [secondary.source],
  ).length;

  assert.strictEqual(matched(buildAnime(2, '葬送的芙莉莲(2023)【TV动画】from dandan', 'dandan', [])), 1, '按主源剧名命中');
  assert.strictEqual(matched(buildAnime(3, 'Frieren: Beyond the Journey End(2023)【TV动画】from dandan', 'dandan', [])), 1, '按主源别名命中');
  assert.strictEqual(matched(buildAnime(4, '葬送のフリーレン(2023)【TV动画】from dandan', 'dandan', [])), 1, '按主源日文别名命中');
});

test('merge findSecondaryMatches 罗马数字 II/III/IV 作季度标记', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    typeDescription: 'TV动画',
    startDate: /(\d{4})/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: Array.from({ length: 13 }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: 13,
  });
  const matched = (primary, secondary) => findSecondaryMatches(primary, [secondary], new Set(), [secondary.source]).length > 0;

  // 独立出现的 I 与英文代词同形不作季度标记，II/III/IV 仍按季度标记解析
  assert.strictEqual(matched(
    buildAnime(1, 'OVERLORD 第二季(2018)【TV动画】from dandan', 'dandan'),
    buildAnime(2, 'OVERLORD II(2018)【TV动画】from bahamut', 'bahamut')),
    true, 'II 读作第 2 季，与同季候选匹配');

  assert.strictEqual(matched(
    buildAnime(3, 'OVERLORD 第二季(2018)【TV动画】from dandan', 'dandan'),
    buildAnime(4, 'OVERLORD III(2018)【TV动画】from bahamut', 'bahamut')),
    false, 'III 读作第 3 季，与第二季冲突');

  assert.strictEqual(matched(
    buildAnime(5, 'OVERLORD 第二季(2018)【TV动画】from dandan', 'dandan'),
    buildAnime(6, 'OVERLORD IV(2022)【TV动画】from bahamut', 'bahamut')),
    false, 'IV 读作第 4 季，与第二季冲突');
});
test('merge findSecondaryMatches 中文数字季号取完整数字', () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const buildAnime = (animeId, animeTitle, source) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    typeDescription: 'TV动画',
    startDate: /(\d{4})/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}集` })),
    episodeCount: 12,
  });
  const matched = (primary, secondary) => findSecondaryMatches(primary, [secondary], new Set(), [secondary.source]).length > 0;

  // 中文季号超过十时须取完整数字，仅取首字会把第十三季与第十五季一同归一为第 10 季
  assert.strictEqual(matched(
    buildAnime(1, '长篇番剧 第十三季(2024)【TV动画】from dandan', 'dandan'),
    buildAnime(2, '长篇番剧 第十五季(2026)【TV动画】from bahamut', 'bahamut')),
    false, '第十三季与第十五季互不匹配');

  assert.strictEqual(matched(
    buildAnime(3, '长篇番剧 第十三季(2024)【TV动画】from dandan', 'dandan'),
    buildAnime(4, '长篇番剧 第十三季(2024)【TV动画】from bahamut', 'bahamut')),
    true, '同为第十三季的候选仍可匹配');
});
test('merge cleanText 对相同输入返回一致的清洗结果', () => {
  const raw = '【bilibili1】 第1話 買東西記';
  const first = cleanText(raw);
  const second = cleanText(raw);
  assert.equal(cleanText(raw), first, '重复清洗同一标题结果一致');
  // 二次调用走缓存路径，结果与首洗一致；清洗结果再清洗保持不变（缓存不改变输出）
  assert.equal(cleanText(raw), second, '缓存命中路径与首洗结果一致');
  assert.equal(cleanText(first), first, '清洗结果幂等');
  assert.notEqual(cleanText('第2話 畫畫記'), first, '不同标题不受缓存串扰');
});
test('merge applyMergeLogic 副源多数集无集号时不产生整体偏移落单', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'bilibili&tencent' });
  const buildAnime = (animeId, animeTitle, source, typeDescription, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription,
    startDate: '1992-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title, url: `${source}:${animeId}:${i}` })),
    episodeCount: titles.length,
  });
  const primary = buildAnime(5048637, '蜡笔小新 中文(1992)【TV动画】from bilibili', 'bilibili', 'TV动画', PRIMARY_TITLES);
  const secondary = buildAnime(3670126, '蜡笔小新 第1季(1992)【2D动漫】from tencent', 'tencent', '2D动漫', SECONDARY_TITLES);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from bilibili&tencent'));
  assert.ok(merged, '产生合并条目');
  // 479 集对齐并入；副源唯一无对应内容的主源跳集区副源集（跟妈妈一起洗澡）落单在尾部
  assert.equal(merged.links.length, 480, '对齐集正常并入，无对应主源集的副源集落单');
  assert.equal(String(merged.links[0].url).includes('tencent:'), true, '首集副源并入对应主集');
  assert.match(merged.links[0].title, /买东西记/, '首集标题保持主源内容');
  assert.equal(String(merged.links[0].url).split('$$$').length, 2, '首集只容纳一个副源链接，尾部数字集号相同的另一集不再重复并入');
  const softballPaired = merged.links.filter(link => /垒球比赛/.test(String(link.title)));
  assert.equal(softballPaired.length, 2, '垒球比赛两话各自独立成条');
  assert.ok(softballPaired.every(link => String(link.url).split('$$$').length === 2), '垒球比赛副源并入对应主源话，尾部数字集号不再造成错配');
  assert.match(merged.links.at(-1).title, /跟妈妈一起洗澡/, '无对应主源内容的副源集落单在列表尾部');
});
test('merge applyMergeLogic 集号基准不同时按季度偏移对齐', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&animeko' });
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-07-05T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const mergedOf = (series, source) => Globals.animes.find((anime) => anime.animeTitle.startsWith(series) && anime.animeTitle.includes(`from dandan&${source}`));
  const mergedPairs = (anime, source) => anime.links.filter((link) => String(link.url).includes('$$$' + source + ':')).length;

  // 主源本季从 1 起编号、副源承接上一季（13 起），双方第 13 集同题
  const primary = buildAnime(1, '正相反的你与我 第二季(2026)【TV动画】from dandan', 'dandan', [
    '第1话 クリスマスイヴ', '第2话 冬の夜のジレンマ', '第3话 行く年来る年', '第4话 新学期', '第5话 バレンタイン',
    '第6话 春の手前', '第7话 グラデーション', '第8话 この先', '第9话 過去と今', '第10话 想いと選択',
    '第11话 居場所', '第12话 スタートライン', '第13话 平安夜', 'C1 Opening', 'C2 Ending',
  ]);
  const secondary = buildAnime(2, '正相反的你与我 第二季(2026)【TV动画】from animeko', 'animeko', [
    '第13话 平安夜', '第14话 冬夜的两难', '第15话 送旧迎新', '第16话 新学期', '第17话 情人节',
    '第18话 春天的前夕', '第19话 渐层', '第20话 在这之后', '第21话 过去和现在', '第22话 想法和选择',
    '第23话 容身之處', '第24话 起点', '第25话 相反的你和我',
  ]);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = mergedOf('正相反的你与我 第二季', 'animeko');
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 15, '13 个正片各自对齐，番外不触发补全');
  assert.strictEqual(mergedPairs(merged, 'animeko'), 13, '副源 13 集全部与主源对应集合并');

  // 反向：主源承接上一季（13 起）、副源本季从 1 起
  const sequelNumbered = buildAnime(3, '无限滑板 第二季(2026)【TV动画】from dandan', 'dandan', [
    '第13话 起始', '第14话 第二次', '第15话 第三次', '第16话 第四次', '第17话 第五次',
    '第18话 第六次', '第19话 第七次', '第20话 第八次', '第21话 第九次', '第22话 第十次',
    '第23话 第十一次', '第24话 第十二次', '第25话 终点',
  ]);
  const seasonNumbered = buildAnime(4, '无限滑板 第二季(2026)【TV动画】from animeko', 'animeko', [
    '第1话 起始', '第2话 第二次', '第3话 第三次', '第4话 第四次', '第5话 第五次',
    '第6话 第六次', '第7话 第七次', '第8话 第八次', '第9话 第九次', '第10话 第十次',
    '第11话 第十一次', '第12话 第十二次', '第13话 终点',
  ]);

  Globals.animes = [sequelNumbered, seasonNumbered];
  await applyMergeLogic([sequelNumbered, seasonNumbered]);

  const reverseMerged = mergedOf('无限滑板 第二季', 'animeko');
  assert.notStrictEqual(reverseMerged, undefined, '反向场景产生合并条目');
  assert.strictEqual(reverseMerged.links.length, 13, '主源顺延编号时同样按季度偏移对齐');
});

test('merge applyMergeLogic 副源分部集号自第二话起时按集号对齐', async () => {
  Globals.init({
    LOG_LEVEL: 'error',
    MERGE_SOURCE_PAIRS: 'dandan&animeko',
    CUSTOM_MERGE_RULES: [
      '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】@animeko -> 飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】@dandan',
      '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【WEB动画】@animeko -> 飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】@dandan',
    ].join(';'),
  });
  const buildAnime = (animeId, animeTitle, source, typeDescription, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'web',
    typeDescription,
    startDate: '2026-03-18T16:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:第(\\d+)`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  // 副源「第二&第三赛段」集号自第 2 话起（第 1 话由同一来源的「第一赛段」提供），两侧最小集号相差 1 时仍按集号对齐
  const primary = buildAnime(19287, '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】from dandan', 'dandan', '网络放送', [
    '第1话 飙马野郎', '第2话 マウンテン・ティムへの依頼', '第3话 砂漠で生まれたならず者', '第4话 悪魔の手のひら',
    '第5话', '第6话', '第7话', '第8话',
  ]);
  const stage1  = buildAnime(551918, '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【WEB动画】from animeko', 'animeko', 'WEB动画', ['第1话 飙马野郎']);
  const stage23 = buildAnime(639938, '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】from animeko', 'animeko', 'WEB动画', [
    '第2话 警长对曼登·提姆的要求', '第3话 沙漠中诞生的法外之徒', '第4话 恶魔之掌', '第5话', '第6话', '第7话',
    '第8话', '第9话', '第10话', '第11话', '第12话',
  ]);

  Globals.animes = [primary, stage1, stage23];
  await applyMergeLogic([primary, stage1, stage23]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from dandan&animeko&animeko'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 12, '主源 8 集按集号对齐，副源多出的 4 集补在末尾');
  assert.deepStrictEqual(numbersOf(merged, 'dandan'), [1, 2, 3, 4, 5, 6, 7, 8], '主源集号保持原有顺序');
  assert.deepStrictEqual(numbersOf(merged, 'animeko'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '副源按集号对应，落单集补在末尾');
});

test('merge applyMergeLogic 多条映射表路由按分部标记各自生效', async () => {
  Globals.init({
    LOG_LEVEL: 'error',
    MERGE_SOURCE_PAIRS: 'dandan&animeko',
    CUSTOM_MERGE_RULES: [
      '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】@animeko -> 飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】@dandan | E2~E12>E2~E12',
      '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【WEB动画】@animeko -> 飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】@dandan | E1>E1',
    ].join(';'),
  });
  const buildAnime = (animeId, animeTitle, source, typeDescription, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'web',
    typeDescription,
    startDate: '2026-03-18T16:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:第(\\d+)`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  // 两条规则的标题剥离分部噪声后相同，按分部标记分别命中各自的副源条目
  const primary = buildAnime(19287, '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【网络放送】from dandan', 'dandan', '网络放送', [
    '第1话 飙马野郎', '第2话 マウンテン・ティムへの依頼', '第3话 砂漠で生まれたならず者', '第4话 悪魔の手のひら',
    '第5话', '第6话', '第7话', '第8话',
  ]);
  const stage1  = buildAnime(551918, '飙马野郎 JOJO的奇妙冒险 第一赛段(2026)【WEB动画】from animeko', 'animeko', 'WEB动画', ['第1话 飙马野郎']);
  const stage23 = buildAnime(639938, '飙马野郎 JOJO的奇妙冒险 第二&第三赛段(2026)【WEB动画】from animeko', 'animeko', 'WEB动画', [
    '第2话 警长对曼登·提姆的要求', '第3话 沙漠中诞生的法外之徒', '第4话 恶魔之掌', '第5话', '第6话', '第7话',
    '第8话', '第9话', '第10话', '第11话', '第12话',
  ]);

  Globals.animes = [primary, stage1, stage23];
  await applyMergeLogic([primary, stage1, stage23]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from dandan&animeko&animeko'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 12, '第一赛段并入第 1 话，第二&第三赛段并入第 2~8 话，落单集补在末尾');
  assert.deepStrictEqual(numbersOf(merged, 'dandan'), [1, 2, 3, 4, 5, 6, 7, 8], '主源集号保持原有顺序');
  assert.deepStrictEqual(numbersOf(merged, 'animeko'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], '两条路由各自生效，副源集号连续');
});
test('merge applyMergeLogic 单集断层按零偏移方向对齐', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&animeko' });
  const buildAnime = (animeId, source, nums) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `断层番剧(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-04-05T00:00:00.000Z',
    links: nums.map((num, i) => ({ title: `【${source}】 第${num}集`, url: `${source}:${animeId}:${i}:${num}` })),
    episodeCount: nums.length,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:(\\d+)`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  // 主源缺第 2 集形成单集断层，副源连续：只按号码相等的方向对齐，不得整体错位
  const gap = [1, ...Array.from({ length: 11 }, (_, i) => i + 3)];
  const primary   = buildAnime(1, 'dandan', gap);
  const secondary = buildAnime(2, 'animeko', Array.from({ length: 13 }, (_, i) => i + 1));

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from dandan&animeko'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 13, '12 集按号码对上，副源多出的 1 集落到末尾');
  assert.deepStrictEqual(numbersOf(merged, 'dandan'), gap, '主源集号保持原有顺序');
  assert.deepStrictEqual(numbersOf(merged, 'animeko'), [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 2], '副源按号码对齐，落单集补在末尾');
});
test('merge applyMergeLogic 多季划分与合集按季切片对齐', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, animeTitle, source, count) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2023-04-12T00:00:00.000Z',
    links: Array.from({ length: count }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}:${i + 1}` })),
    episodeCount: count,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:(\\d+)`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => Number(m[1]));

  // 主源按季划分（S1 11 集 / S2 13 集 / S3 11 集），副源为整部合集（35 集）
  const collection = buildAnime(101, '我推的孩子(2023)【TV动画】from bahamut', 'bahamut', 35);
  const seasons = [
    buildAnime(201, '我推的孩子 第一季(2023)【TV动画】from dandan', 'dandan', 11),
    buildAnime(202, '我推的孩子 第二季(2023)【TV动画】from dandan', 'dandan', 13),
    buildAnime(203, '我推的孩子 第三季(2023)【TV动画】from dandan', 'dandan', 11),
  ];

  Globals.animes = [collection, ...seasons];
  await applyMergeLogic([collection, ...seasons]);

  const merged = (seasonTitle) => Globals.animes.find((anime) => anime.animeTitle.startsWith(seasonTitle) && anime.animeTitle.includes('from dandan&bahamut'));
  for (const [title, count] of [['我推的孩子 第一季', 11], ['我推的孩子 第二季', 13], ['我推的孩子 第三季', 11]]) {
    const entry = merged(title);
    assert.notStrictEqual(entry, undefined, `${title} 与合集关联`);
    assert.strictEqual(entry.links.length, count, `${title} 与合集对应季的集数一致`);
  }
  assert.deepStrictEqual(numbersOf(merged('我推的孩子 第一季'), 'bahamut'), Array.from({ length: 11 }, (_, i) => i + 1), 'S1 对应合集第 1~11 集');
  assert.deepStrictEqual(numbersOf(merged('我推的孩子 第二季'), 'bahamut'), Array.from({ length: 13 }, (_, i) => i + 12), 'S2 对应合集第 12~24 集');
  assert.deepStrictEqual(numbersOf(merged('我推的孩子 第三季'), 'bahamut'), Array.from({ length: 11 }, (_, i) => i + 25), 'S3 对应合集第 25~35 集');
});
test('merge applyMergeLogic 合集探测分离 3D 与 2D', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&iqiyi' });
  const buildAnime = (animeId, animeTitle, source, typeDescription, startDate, count) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription,
    startDate,
    links: Array.from({ length: count }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}:${i + 1}` })),
    episodeCount: count,
  });

  // 组内存在第二季资源时才进入合集探测；3D 短番与 2D 长番分属不同维度组，2D 长番不被判为合集
  const twoD   = buildAnime(1, '择天记(2020)【动漫】from tencent', 'tencent', '动漫', '2020-01-01T00:00:00.000Z', 61);
  const second = buildAnime(2, '择天记 第二季(2026)【动漫】from iqiyi', 'iqiyi', '动漫', '2026-01-01T00:00:00.000Z', 26);
  const threeD = buildAnime(3, '择天记(2026)【3D动漫】from iqiyi', 'iqiyi', '3D动漫', '2026-01-01T00:00:00.000Z', 26);

  Globals.animes = [twoD, second, threeD];
  await applyMergeLogic([twoD, second, threeD]);

  assert.strictEqual(Globals.animes.some((anime) => String(anime.animeTitle).includes('&')), false, '3D 与 2D 不互为合集，不产生合并条目');
  assert.strictEqual(Globals.animes.length, 3, '三个条目各自保留');
});

test('merge applyMergeLogic 非整数集号按番外落单', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `一拳超人 第三季(2025)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2025-10-05T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:([^$]*)`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => m[1]);

  // 副源在正片中间插入非整数集号的番外（巴哈此类番外如「24.5 集」），它不得占用正片位置
  const primary   = buildAnime(1, 'dandan', Array.from({ length: 12 }, (_, i) => `第${i + 1}话`));
  const secondary = buildAnime(2, 'bahamut', [
    '第1集', '第2集', '第3集', '第4集', '第5集', '第5.5集',
    '第6集', '第7集', '第8集', '第9集', '第10集', '第11集', '第12集',
  ]);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 13, '12 集正片各自对齐，番外另占一条链接');
  assert.deepStrictEqual(numbersOf(merged, 'dandan'), Array.from({ length: 12 }, (_, i) => `第${i + 1}话`), '主源正片按原有集号并入');
  assert.deepStrictEqual(numbersOf(merged, 'bahamut'), [...Array.from({ length: 12 }, (_, i) => `第${i + 1}集`), '第5.5集'], '副源正片按集号对应，5.5 集沉至末尾不占用正片位置');
  assert.strictEqual(String(merged.links[12].url).includes('$$$'), false, '番外链接不含副源分段，保持落单');
});
test('merge applyMergeLogic 小数集号不参与集号基准统计', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `一拳超人 第三季(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const numbersOf = (anime, source) => {
    const pattern = new RegExp('(?:^|\\$\\$\\$)' + source + ':\\d+:\\d+:第([\\d.]+)集');
    return anime.links.map((link) => pattern.exec(String(link.url))).filter(Boolean).map((m) => m[1]);
  };

  // 副源首条为 24.5 集番外、正片自第 25 集承接上一季：小数集号不参与最小正片集号统计
  const primary   = buildAnime(1, 'dandan', Array.from({ length: 12 }, (_, i) => `第${i + 1}集`));
  const secondary = buildAnime(2, 'bahamut', ['第24.5集', ...Array.from({ length: 12 }, (_, i) => `第${i + 25}集`)]);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.deepStrictEqual(numbersOf(merged, 'dandan'), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], '主源集号保持原有顺序');
  assert.deepStrictEqual(numbersOf(merged, 'bahamut'), ['25', '26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '24.5'], '副源正片按承接编号对齐，番外沉底');
});

test('merge applyMergeLogic 集号制导定位到已占用主源集时副源集落单', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `占用落单测试(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}` })),
    episodeCount: titles.length,
  });

  // 副源两集声明同一集号且标题不同，两者都经集号制导定位到主源第 3 集
  const primary = buildAnime(1, 'dandan', ['第1集 甲', '第2集 乙', '第3集 丙', '第4集 丁']);
  const secondary = buildAnime(2, 'bahamut', ['第1集 甲', '第2集 乙', '第3集 丙', '第3集 丙之二']);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  const third = merged.links[2];
  assert.strictEqual(String(third.url).split('$$$').length, 2, '主源第3集只并入先定位到的一集');
  assert.match(String(third.url), /bahamut:2:2/, '并入的是先处理且内容对应的一集');
  assert.strictEqual(merged.links.length, 5, '后定位的重复集号集落单为独立条目');
});
test('merge applyMergeLogic 主源跳集时副源尾部数字集号按锚点配对', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `跳集集号测试(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}` })),
    episodeCount: titles.length,
  });

  // 主源缺第 4 集；副源每集标题带尾部数字，集号差投票须按标题命中的对应关系配对，
  // 不能由几何位置偏移推出集号偏移
  const primary = buildAnime(1, 'dandan', [
    '第1集 标题1', '第2集 标题2', '第3集 标题3', '第5集 标题5', '第6集 标题6',
    '第7集 标题7', '第8集 标题8', '第9集 标题9', '第10集 标题10', '第11集 标题11',
  ]);
  const secondary = buildAnime(2, 'bahamut', [
    '标题1 第1', '标题2 第2', '标题3 第3', '标题4 第4', '标题5 第5', '标题6 第6',
    '标题7 第7', '标题8 第8', '标题9 第9', '标题10 第10', '标题11 第11',
  ]);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 11, '主源 10 集全部并入，副源多出的一集落单');
  for (let i = 0; i < 10; i++) {
    const num = i < 3 ? i + 1 : i + 2;
    assert.match(String(merged.links[i].title), new RegExp(`第${num}集`), `主源第 ${num} 集保持原位`);
    assert.match(String(merged.links[i].url), new RegExp(`bahamut:2:${num - 1}`), `第 ${num} 集并入同集号的副源集`);
  }
  assert.match(String(merged.links[10].title), /标题4/, '主源缺第 4 集，对应的副源集落单');
});
test('merge applyMergeLogic 副源重复集号时同一主源集只并入一集', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `重复集号测试(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}` })),
    episodeCount: titles.length,
  });

  // 副源接口偶发把两集标成同一集号：主源同一集只容纳一个副源链接，另一集按位置落到后续主源集
  const primary = buildAnime(1, 'dandan', ['第1集 甲', '第2集 乙', '第3集 丙', '第4集 丁', '第5集 戊', '第6集 己']);
  const secondary = buildAnime(2, 'bahamut', ['第1集 甲', '第2集 乙', '第3集 丙', '第4集 丁', '第5集 戊', '第5集 戊之二']);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 6, '合并条数与主源集数一致，重复集号不额外增加条目');
  const fifth = merged.links[4];
  assert.strictEqual(String(fifth.url).split('$$$').length, 2, '主源第5集只并入一个副源链接');
  assert.match(String(fifth.url), /bahamut:2:4/, '并入第5集的是集号与内容都对应的那一集');
});
test('merge applyMergeLogic 小数番外序列按集号与文本共同对齐', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut' });
  const buildAnime = (animeId, source, unit) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `小数序列测试(2026)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: ['1', '2', '2.5', '3', '3.5', '4'].map((n, i) => ({
      title: `【${source}】 第${n}集 第${n}集内容${i}`,
      url: `${source}:${animeId}:${i}:第${n}集`,
    })),
    episodeCount: 6,
  });

  const primary = buildAnime(1, 'dandan', '话');
  const secondary = buildAnime(2, 'bahamut', '集');

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&bahamut'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.equal(merged.links.length, 6, '六集各自对齐，小数番外不因查重落单');
  for (const link of merged.links) {
    assert.equal(String(link.url).split('$$$').length, 2, `第 ${link.title} 集应并入了对应的副源链接: ${link.url}`);
  }
});
test('merge applyMergeLogic 映射表按拉丁分部标记区分规则', async () => {
  Globals.init({
    LOG_LEVEL: 'error',
    MERGE_SOURCE_PAIRS: 'dandan&animeko',
    CUSTOM_MERGE_RULES: [
      'JOJO的奇妙冒险 石之海 Part.2(2022)【网络放送】@animeko -> JOJO的奇妙冒险 石之海 Part.1(2022)【网络放送】@dandan | E1>E1',
      'JOJO的奇妙冒险 石之海 Part.1(2022)【网络放送】@animeko -> JOJO的奇妙冒险 石之海 Part.1(2022)【网络放送】@dandan | E1~E12>E1~E12',
    ].join(';'),
  });
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'web',
    typeDescription: '网络放送',
    startDate: '2022-12-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });
  const numbersOf = (anime, source) => anime.links
    .map((link) => new RegExp(`(?:^|\\$\\$\\$)${source}:\\d+:\\d+:第(\\d+)集`).exec(String(link.url)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const titles = Array.from({ length: 12 }, (_, i) => `第${i + 1}集`);

  // 两条规则的标题剥离分部写法后相同，Part.1 条目应命中分部一致的规则（E1~E12），不受书写顺序影响
  const primary   = buildAnime(1, 'JOJO的奇妙冒险 石之海 Part.1(2022)【网络放送】from dandan', 'dandan', titles);
  const secondary = buildAnime(2, 'JOJO的奇妙冒险 石之海 Part.1(2022)【网络放送】from animeko', 'animeko', titles);

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => String(anime.animeTitle).includes('from dandan&animeko'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.deepStrictEqual(numbersOf(merged, 'animeko'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'Part.1 条目命中分部一致的规则，12 集全部并入');
});

test('merge applyMergeLogic 配音版本副源并入同配音版本链接', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&aiyifan' });
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: '电视剧',
    typeDescription: '电视剧',
    startDate: '2003-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });

  // 主源同一集含普通话与粤语两条链接，粤语副源落在粤语链接上，普通话链接计入落单
  const primaryTitles = [];
  for (let i = 1; i <= 6; i++) primaryTitles.push(`第${i}集 (普通话版)`, `第${i}集 (粤语版)`);
  const primary   = buildAnime(1, '倚天屠龙记(2003)【电视剧】from tencent', 'tencent', primaryTitles);
  const secondary = buildAnime(2, '倚天屠龙记(粤语)(2003)【电视剧】from aiyifan', 'aiyifan',
    Array.from({ length: 6 }, (_, i) => `第${i + 1}集`));

  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from tencent&aiyifan'));
  assert.notStrictEqual(merged, undefined, '产生合并条目');
  assert.strictEqual(merged.links.length, 12, '主源 12 条链接全部保留');
  assert.strictEqual(merged.links.filter((link) => String(link.url).includes('$$$')).length, 6, '每集只有一条主源链接并入副源');
  assert.deepStrictEqual(merged.links.filter((link) => String(link.url).includes('$$$')).map((link) => link.title),
    Array.from({ length: 6 }, (_, i) => `【tencent&aiyifan】 第${i + 1}集 (粤语版)`), '粤语副源并入粤语链接，普通话链接保持独立');
});
test('merge applyMergeLogic 映射表特权通道不受年份判定约束', async () => {
  const rule = '倚天屠龙记(2009)【电视剧】@aiyifan -> 倚天屠龙记(2001)【电视剧】@tencent';
  const buildAnime = (animeId, animeTitle, source, count) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: '电视剧',
    typeDescription: '电视剧',
    startDate: /\((\d{4})\)/.exec(animeTitle)[1] + '-01-01T00:00:00.000Z',
    links: Array.from({ length: count }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}:${i + 1}` })),
    episodeCount: count,
  });
  const mergedWithRule = async (ruleText, yearA, yearB) => {
    Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&aiyifan', CUSTOM_MERGE_RULES: ruleText });
    const primary   = buildAnime(1, `倚天屠龙记(${yearA})【电视剧】from tencent`, 'tencent', 12);
    const secondary = buildAnime(2, `倚天屠龙记(${yearB})【电视剧】from aiyifan`, 'aiyifan', 12);
    Globals.animes = [primary, secondary];
    await applyMergeLogic([primary, secondary]);
    return Globals.animes.some((anime) => String(anime.animeTitle).includes('from tencent&aiyifan'));
  };

  try {
    // 映射表为用户自定义的最高优先级，命中后标题匹配侧与集对齐侧都不再作年份判定
    assert.strictEqual(await mergedWithRule(rule, 2001, 2009), true, '特权通道下年份差 8 年的同名不同作品照常合并');
    assert.strictEqual(await mergedWithRule(rule, 2001, 2001), true, '年份一致时特权通道合并');
    assert.strictEqual(await mergedWithRule('', 2001, 2009), false, '未命中映射表时仍按年份关系判定');
  } finally {
    Globals.init({ LOG_LEVEL: 'error' });
  }
});
test('merge applyMergeLogic 映射表集路由下的配音版本链接选择', async () => {
  const rule = '倚天屠龙记(粤语)(2003)【电视剧】@aiyifan -> 倚天屠龙记(2003)【电视剧】@tencent | E1~E12>E1~E12';
  const primaryTitles = [];
  for (let i = 1; i <= 12; i++) primaryTitles.push(`第${i}集 (普通话版)`, `第${i}集 (粤语版)`);
  const buildAnime = (animeId, animeTitle, source, titles) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: '电视剧',
    typeDescription: '电视剧',
    startDate: '2003-01-01T00:00:00.000Z',
    links: titles.map((title, i) => ({ title: `【${source}】 ${title}`, url: `${source}:${animeId}:${i}:${title}` })),
    episodeCount: titles.length,
  });

  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'tencent&aiyifan', CUSTOM_MERGE_RULES: rule });
  const primary   = buildAnime(1, '倚天屠龙记(2003)【电视剧】from tencent', 'tencent', primaryTitles);
  const secondary = buildAnime(2, '倚天屠龙记(粤语)(2003)【电视剧】from aiyifan', 'aiyifan',
    Array.from({ length: 12 }, (_, i) => `第${i + 1}集`));

  try {
    Globals.animes = [primary, secondary];
    await applyMergeLogic([primary, secondary]);

    const merged = Globals.animes.find((anime) => anime.animeTitle.includes('from tencent&aiyifan'));
    assert.notStrictEqual(merged, undefined, '产生合并条目');
    const mergedLinks = merged.links.filter((link) => String(link.url).includes('$$$'));
    assert.strictEqual(merged.links.length, 24, '主源 24 条链接全部保留');
    assert.strictEqual(mergedLinks.length, 12, '集路由下 12 集各并入一条主源链接');
    assert.ok(mergedLinks.every((link) => link.title.includes('粤语版')), '粤语副源经集路由并入粤语链接');
  } finally {
    Globals.init({ LOG_LEVEL: 'error' });
  }
});

test('merge applyMergeLogic 单源配置保留原结果', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan,bahamut&dandan' });
  const buildAnime = (animeId, source) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `葬送的芙莉莲(2023)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2023-09-29T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}` })),
    episodeCount: 12,
  });

  // dandan 既是单源配置（保留原结果）又是另一组的副源：作为副源被消费后仍需保留原结果
  const dandan  = buildAnime(1, 'dandan');
  const bahamut = buildAnime(2, 'bahamut');

  Globals.animes = [dandan, bahamut];
  await applyMergeLogic([dandan, bahamut]);

  const titles = Globals.animes.map((anime) => String(anime.animeTitle));
  assert.strictEqual(titles.some((title) => title.includes('from bahamut&dandan')), true, '另一组按主副源合并');
  assert.strictEqual(titles.some((title) => /from dandan$/.test(title)), true, '单源配置的条目保留原结果');
});

test('merge applyMergeLogic 同一源参与不同组合并', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut,dandan&animeko' });
  const buildAnime = (animeId, source) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle: `葬送的芙莉莲(2023)【TV动画】from ${source}`,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2023-09-29T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}` })),
    episodeCount: 12,
  });

  // 同一个源可以出现在多个组中，各组分别合并
  const dandan  = buildAnime(1, 'dandan');
  const bahamut = buildAnime(2, 'bahamut');
  const animeko = buildAnime(3, 'animeko');

  Globals.animes = [dandan, bahamut, animeko];
  await applyMergeLogic([dandan, bahamut, animeko]);

  const titles = Globals.animes.map((anime) => String(anime.animeTitle));
  assert.strictEqual(titles.some((title) => title.includes('from dandan&bahamut')), true, 'dandan 与 bahamut 的组合生效');
  assert.strictEqual(titles.some((title) => title.includes('from dandan&animeko')), true, 'dandan 与 animeko 的组合生效');
});

test('merge applyMergeLogic 映射表动态注入源受权限沙箱约束', async () => {
  const rule = '葬送的芙莉莲@animeko -> 葬送的芙莉莲@dandan';
  const buildAnime = (animeId, animeTitle, source) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'tvseries',
    typeDescription: 'TV动画',
    startDate: '2023-04-12T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ title: `【${source}】 第${i + 1}集`, url: `${source}:${animeId}:${i}` })),
    episodeCount: 12,
  });

  try {
    Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bahamut', CUSTOM_MERGE_RULES: rule });

    // 映射表引入的 animeko 不在常规组内：命中规则的条目走特权通道放行
    const ruledPrimary = buildAnime(1, '葬送的芙莉莲(2023)【TV动画】from dandan', 'dandan');
    assert.strictEqual(
      findSecondaryMatches(ruledPrimary, [buildAnime(2, '葬送的芙莉莲(2023)【TV动画】from animeko', 'animeko')], new Set(), []).length,
      1, '空基础副源下命中规则的候选放行',
    );
    Globals.animes = [ruledPrimary, buildAnime(2, '葬送的芙莉莲(2023)【TV动画】from animeko', 'animeko')];
    await applyMergeLogic(Globals.animes);
    assert.strictEqual(
      Globals.animes.some((anime) => String(anime.animeTitle).includes('from dandan&animeko')), true,
      '命中规则的注入源条目并入',
    );

    // 未命中规则的注入源条目标题与主源相同，仍受权限沙箱阻断
    const plainPrimary = buildAnime(11, '我推的孩子(2023)【TV动画】from dandan', 'dandan');
    const injected     = buildAnime(12, '我推的孩子(2023)【TV动画】from animeko', 'animeko');
    Globals.animes = [plainPrimary, injected];
    await applyMergeLogic([plainPrimary, injected]);
    assert.strictEqual(
      Globals.animes.some((anime) => String(anime.animeTitle).includes('&')), false,
      '未命中规则的注入源条目受权限沙箱阻断',
    );
  } finally {
    Globals.init({ LOG_LEVEL: 'error' });
  }
});

test('merge applyMergeLogic 合并后按最终 links 重算总集数', async () => {
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&animeko' });
  const buildAnime = (animeId, animeTitle, source, count) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source,
    type: 'TV动画',
    typeDescription: 'TV动画',
    startDate: '2026-01-01T00:00:00.000Z',
    links: Array.from({ length: count }, (_, i) => ({ title: `第${i + 1}集`, url: `${source}:${animeId}:${i}:第${i + 1}集` })),
    episodeCount: count,
  });

  // 主源 2 集、副源 5 集、同标题同年：合并后 links 覆盖副源全部集
  const primary   = buildAnime(1, '重算集数测试番剧(2026)【TV动画】from dandan', 'dandan', 2);
  const secondary = buildAnime(2, '重算集数测试番剧(2026)【TV动画】from animeko', 'animeko', 5);
  Globals.animes = [primary, secondary];
  await applyMergeLogic([primary, secondary]);

  const merged = Globals.animes.find((a) => a.animeTitle.startsWith('重算集数测试番剧') && a.animeTitle.includes('from dandan&animeko'));
  assert.ok(merged, '应产生合并条目');
  assert.ok(merged.links.length > 2, '合并后 links 多于主源');
  assert.strictEqual(merged.episodeCount, merged.links.length, '总集数以最终 links 为准');
});

test('applyMergeLogic 登记源合并明细供接口详情展示', async () => {
  useAsyncLocalStorage(AsyncLocalStorage);
  Globals.init({ LOG_LEVEL: 'error', MERGE_SOURCE_PAIRS: 'dandan&bilibili,renren' });
  process.env.CUSTOM_MERGE_RULES = '';

  const buildAnime = (animeId, animeTitle, source, links) => ({
    animeId, bangumiId: String(animeId), animeTitle, aliases: [],
    source, type: 'web', typeDescription: '网络放送',
    startDate: '2026-03-18T16:00:00.000Z', links,
  });
  const buildLinks = (count, platform) => Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    title: `【${platform}】 第${i + 1}集`,
    url: `https://example.com/${platform}/${i + 1}`,
  }));

  // 追踪作用域内执行合并，使登记落到步骤
  const trace = createTrace('GET', '/api/v2/search/anime');
  const curAnimes = [
    buildAnime(1, '合并主源(2026)【网络放送】from dandan', 'dandan', buildLinks(3, 'dandan')),
    buildAnime(2, '合并主源(2026)【网络放送】from bilibili', 'bilibili', buildLinks(3, 'bilibili')),
    buildAnime(3, '独立结果(2026)【网络放送】from renren', 'renren', buildLinks(2, 'renren')),
  ];
  // 合并是异步过程：结束后再归档步骤，登记才能带上合并明细
  await runWithTrace(trace, async () => {
    await applyMergeLogic(curAnimes, new Map());
    traceStep('搜索·源合并与过滤', Date.now(), {});
  });

  const change = trace.steps[0].changes.find(c => c.config === 'MERGE_SOURCE_PAIRS');
  assert.ok(change, '应登记源合并明细');
  assert.equal(change.kind, 'stats');
  assert.equal(change.context.单源保留, 'renren', '单源保留配置应说明');
  assert.match(change.summary, /3 条候选合并为 2 条/);
  assert.ok(change.table.rows.some(row => String(row.结果).includes('副源')), '合并项应列出副源');
  assert.ok(change.table.rows.some(row => String(row.结果).includes('已并入')), '被消费的原始条目应说明去向');
});

// —— 蜡笔小新第 1 季合并回归夹具：真实集标题序列 ——
// 供「副源多数集无集号时不产生整体偏移落单」用例使用。
// 副源标题不含集号，主源带完整集号；序列必须完整保留，裁剪或拼接会破坏
// 锚点密度与相似度分组的上下文，无法复现错配修复行为。
// 主源集号为 1..480 跳过 17（bilibili 缺第 17 话）；副源「赏花真快乐」在
// 真实数据中出现两次，属平台原样
const PRIMARY_TITLES = [
  "【bilibili1】 第1话 买东西记", "【bilibili1】 第2话 妈妈早上忙死了", "【bilibili1】 第3话 画画记", "【bilibili1】 第4话 骑三轮车记",
  "【bilibili1】 第5话 肚子痛记", "【bilibili1】 第6话 爸爸也好辛苦", "【bilibili1】 第7话 看动感超人记", "【bilibili1】 第8话 营养午餐记",
  "【bilibili1】 第9话 看牙医记", "【bilibili1】 第10话 行侠仗义的向日葵班", "【bilibili1】 第11话 野餐记（1）", "【bilibili1】 第12话 野餐记（2）",
  "【bilibili1】 第13话 看电影记", "【bilibili1】 第14话 帮忙记", "【bilibili1】 第15话 整理东西记", "【bilibili1】 第16话 养小蝌蚪记",
  "【bilibili1】 第18话 避难训练记", "【bilibili1】 第19话 拣狗记", "【bilibili1】 第20话 它的名字叫小白", "【bilibili1】 第21话 遛狗记",
  "【bilibili1】 第22话 小白的家", "【bilibili1】 第23话 讨厌的青辣椒", "【bilibili1】 第24话 不要打扰爸爸工作", "【bilibili1】 第25话 玩黏土记",
  "【bilibili1】 第26话 看书记", "【bilibili1】 第27话 跟大姐姐是好朋友", "【bilibili1】 第28话 买泳衣记", "【bilibili1】 第29话 上游泳课",
  "【bilibili1】 第30话 喂小白记", "【bilibili1】 第31话 夫妻吵架", "【bilibili1】 第32话 亲子网鱼记", "【bilibili1】 第33话 小新理发记",
  "【bilibili1】 第34话 护宝记", "【bilibili1】 第35话 摄影记", "【bilibili1】 第36话 到海边去真好玩", "【bilibili1】 第37话 住豪华饭店记",
  "【bilibili1】 第38话 回家的路真远", "【bilibili1】 第39话 妈妈睡午觉", "【bilibili1】 第40话 说英文", "【bilibili1】 第41话 去搭火车",
  "【bilibili1】 第42话 搭过电车了", "【bilibili1】 第43话 今天晚上放烟火", "【bilibili1】 第44话 上公共澡堂玩", "【bilibili1】 第45话 照顾老妈",
  "【bilibili1】 第46话 跟会欺负人的小孩玩", "【bilibili1】 第47话 逛庙会", "【bilibili1】 第48话 跟动感超人会面记", "【bilibili1】 第49话 吉永老师约会记",
  "【bilibili1】 第50话 被遗忘的小白", "【bilibili1】 第51话 妮妮的妈妈很温柔", "【bilibili1】 第52话 爷爷来了", "【bilibili1】 第53话 台风来了",
  "【bilibili1】 第54话 来决斗吧", "【bilibili1】 第55话 寄信记", "【bilibili1】 第56话 饭后刷牙", "【bilibili1】 第57话 连续尿床三次",
  "【bilibili1】 第58话 练习跳舞", "【bilibili1】 第59话 跟妈妈的战斗", "【bilibili1】 第60话 大家来玩吹泡泡", "【bilibili1】 第61话 加油，运动会",
  "【bilibili1】 第62话 跟妈妈赛跑", "【bilibili1】 第63话 接力赛", "【bilibili1】 第64话 逛书店", "【bilibili1】 第65话 暗语是美伢",
  "【bilibili1】 第66话 踩高跷比赛", "【bilibili1】 第67话 我们接爸爸去", "【bilibili1】 第68话 打工真命苦", "【bilibili1】 第69话 演戏记",
  "【bilibili1】 第70话 夫妻吵架的调解记", "【bilibili1】 第71话 蟑螂大决斗", "【bilibili1】 第72话 测量身材日", "【bilibili1】 第73话 跟爸爸一起洗车",
  "【bilibili1】 第74话 在百货公司迷路了", "【bilibili1】 第75话 清扫小鸡的家", "【bilibili1】 第76话 我的七五三", "【bilibili1】 第77话 预防感冒的好方法",
  "【bilibili1】 第78话 老师的好帮手", "【bilibili1】 第79话 买烤番薯", "【bilibili1】 第80话 探病", "【bilibili1】 第81话 捉迷藏",
  "【bilibili1】 第82话 出门去", "【bilibili1】 第83话 动物园快乐游记", "【bilibili1】 第84话 跟妈妈一起去美容院", "【bilibili1】 第85话 我也要年终礼物",
  "【bilibili1】 第86话 银行领钱记", "【bilibili1】 第87话 跟女警官在一起", "【bilibili1】 第88话 跟爸爸一起洗澡", "【bilibili1】 第89话 跟小白一起看家",
  "【bilibili1】 第90话 松阪老师的小秘密", "【bilibili1】 第91话 爷爷又来了", "【bilibili1】 第92话 我的第一次滑雪记", "【bilibili1】 第93话 风间家好好玩",
  "【bilibili1】 第94话 和动感超人共度圣诞夜", "【bilibili1】 第95话 做便当真辛苦", "【bilibili1】 第96话 扮家家酒", "【bilibili1】 第97话 去书店帮忙了",
  "【bilibili1】 第98话 当模特儿记", "【bilibili1】 第99话 快乐温泉旅行", "【bilibili1】 第100话 温泉混浴记", "【bilibili1】 第101话 吃年夜饭",
  "【bilibili1】 第102话 放风筝好好玩", "【bilibili1】 第103话 来做雪人吧", "【bilibili1】 第104话 节分撒豆子", "【bilibili1】 第105话 美伢买衣服记",
  "【bilibili1】 第106话 吃火锅记", "【bilibili1】 第107话 感冒记", "【bilibili1】 第108话 当警察真辛苦", "【bilibili1】 第109话 卡拉OK唱歌记",
  "【bilibili1】 第110话 买红豆饼鲷烧记", "【bilibili1】 第111话 住校保育记", "【bilibili1】 第112话 住校保育之夜", "【bilibili1】 第113话 在图书馆要保持安静",
  "【bilibili1】 第114话 马拉松的练习", "【bilibili1】 第115话 马拉松大赛", "【bilibili1】 第116话 三月三日女儿节", "【bilibili1】 第117话 学游泳记",
  "【bilibili1】 第118话 小白学艺记", "【bilibili1】 第119话 打羽毛球记", "【bilibili1】 第120话 社会观摩记", "【bilibili1】 第121话 外送比萨记",
  "【bilibili1】 第122话 正男的天竺鼠", "【bilibili1】 第123话 晒棉被记", "【bilibili1】 第124话 练习足球", "【bilibili1】 第125话 足球大赛",
  "【bilibili1】 第126话 地震来了", "【bilibili1】 第127话 占位子来赏花", "【bilibili1】 第128话 赏花真快乐", "【bilibili1】 第129话 去爸爸的公司",
  "【bilibili1】 第130话 大家一起来播种", "【bilibili1】 第131话 帮妈妈去买菜", "【bilibili1】 第132话 没有眉毛的脸", "【bilibili1】 第133话 爸爸喝醉了",
  "【bilibili1】 第134话 我的亲手签名", "【bilibili1】 第135话 跟妈妈去买东西", "【bilibili1】 第136话 升起鲤鱼旗", "【bilibili1】 第137话 来玩踢罐子",
  "【bilibili1】 第138话 跟电梯小姐在一起", "【bilibili1】 第139话 突然很想吃拉面", "【bilibili1】 第140话 跟老大玩扮家家酒", "【bilibili1】 第141话 出发去远足",
  "【bilibili1】 第142话 远足遇险记", "【bilibili1】 第143话 玩火真可怕", "【bilibili1】 第144话 收拾玩具真麻烦", "【bilibili1】 第145话 晚上是大人的时间",
  "【bilibili1】 第146话 我的书是畅销书", "【bilibili1】 第147话 妈妈离家出走", "【bilibili1】 第148话 地狱女推销员复仇记", "【bilibili1】 第149话 跟爷爷去东京玩",
  "【bilibili1】 第150话 倒垃圾真辛苦", "【bilibili1】 第151话 去女生学校玩", "【bilibili1】 第152话 回转寿司", "【bilibili1】 第153话 帮助有困难的人",
  "【bilibili1】 第154话 做木工真辛苦", "【bilibili1】 第155话 小白不见了", "【bilibili1】 第156话 向政治家问问题", "【bilibili1】 第157话 服从姐姐大人",
  "【bilibili1】 第158话 今天是父亲节", "【bilibili1】 第159话 男生下厨房", "【bilibili1】 第160话 妈妈牙齿痛", "【bilibili1】 第161话 跟坏小孩玩",
  "【bilibili1】 第162话 婚礼服", "【bilibili1】 第163话 参加婚礼典礼", "【bilibili1】 第164话 去吃喜酒", "【bilibili1】 第165话 小新怕得睡不着",
  "【bilibili1】 第166话 清扫游泳池真快乐", "【bilibili1】 第167话 吹气球", "【bilibili1】 第168话 拾钱包", "【bilibili1】 第169话 小新吃刨冰",
  "【bilibili1】 第170话 小白去打针", "【bilibili1】 第171话 全家去露营", "【bilibili1】 第172话 小新是未来的红歌星", "【bilibili1】 第173话 来画电车铁轨",
  "【bilibili1】 第174话 好热好热的夜晚", "【bilibili1】 第175话 吉永老师的私生活", "【bilibili1】 第176话 最后一次见推销小姐", "【bilibili1】 第177话 买冷气机",
  "【bilibili1】 第178话 去加油站", "【bilibili1】 第179话 好多大西瓜", "【bilibili1】 第180话 切西瓜记", "【bilibili1】 第181话 练习相扑",
  "【bilibili1】 第182话 参加相扑比赛", "【bilibili1】 第183话 去警察局", "【bilibili1】 第184话 去抓昆虫", "【bilibili1】 第185话 跟妈妈一起打扫",
  "【bilibili1】 第186话 水灾记", "【bilibili1】 第187话 和大姐头的大对决", "【bilibili1】 第188话 躲避球比赛", "【bilibili1】 第189话 被救护车送进医院",
  "【bilibili1】 第190话 在医院也很红", "【bilibili1】 第191话 我是刑警", "【bilibili1】 第192话 新娘子来了", "【bilibili1】 第193话 练习赛跑",
  "【bilibili1】 第194话 运动会录影记", "【bilibili1】 第195话 松阪老师去约会", "【bilibili1】 第196话 特级寿司最好吃", "【bilibili1】 第197话 名犬小白散步记",
  "【bilibili1】 第198话 抬神轿", "【bilibili1】 第199话 参加拍卖会", "【bilibili1】 第200话 在拍卖会上卖东西", "【bilibili1】 第201话 修理屋檐记",
  "【bilibili1】 第202话 我的弟弟是小鸡", "【bilibili1】 第203话 寻找小鸡", "【bilibili1】 第204话 帮忙洗衣服", "【bilibili1】 第205话 到新婚夫妇的家",
  "【bilibili1】 第206话 假扮上学", "【bilibili1】 第207话 烤肉", "【bilibili1】 第208话 爸爸，辛苦你了", "【bilibili1】 第209话 穿着高中女生制服的妈妈",
  "【bilibili1】 第210话 在成品屋里玩耍", "【bilibili1】 第211话 全家福照片", "【bilibili1】 第212话 缝衣服", "【bilibili1】 第213话 我讨厌打针",
  "【bilibili1】 第214话 招待客人", "【bilibili1】 第215话 明褒暗贬", "【bilibili1】 第216话 讨厌小猫的爸爸", "【bilibili1】 第217话 到书店玩耍",
  "【bilibili1】 第218话 吃拉面", "【bilibili1】 第219话 溜冰天才", "【bilibili1】 第220话 新婚夫妇吵架了", "【bilibili1】 第221话 做饼干了",
  "【bilibili1】 第222话 松阪老师的相亲", "【bilibili1】 第223话 选举真辛苦", "【bilibili1】 第224话 织毛衣", "【bilibili1】 第225话 坐电车",
  "【bilibili1】 第226话 去爸爸的公司玩", "【bilibili1】 第227话 服装秀表演", "【bilibili1】 第228话 幼稚园大扫除", "【bilibili1】 第229话 除夕夜的钟声",
  "【bilibili1】 第230话 爷爷奶奶来访", "【bilibili1】 第231话 压岁钱", "【bilibili1】 第232话 用压岁钱买东西", "【bilibili1】 第233话 参加滑雪旅行",
  "【bilibili1】 第234话 滑雪后的活动", "【bilibili1】 第235话 全家来滑雪", "【bilibili1】 第236话 防止迟到的战术", "【bilibili1】 第237话 正男的恋情",
  "【bilibili1】 第238话 我有弟弟了", "【bilibili1】 第239话 我是铅笔小新", "【bilibili1】 第240话 学铅笔小新讲话", "【bilibili1】 第241话 彩卷中奖了",
  "【bilibili1】 第242话 去参加葬礼", "【bilibili1】 第243话 来玩雪地大战", "【bilibili1】 第244话 去看风间吧", "【bilibili1】 第245话 课长的新家",
  "【bilibili1】 第246话 改变发型记", "【bilibili1】 第247话 谜般的哈蒂娜", "【bilibili1】 第248话 挖耳朵好舒服", "【bilibili1】 第249话 美伢的同学会",
  "【bilibili1】 第250话 离婚记", "【bilibili1】 第251话 垒球比赛1", "【bilibili1】 第252话 垒球比赛2", "【bilibili1】 第253话 一个人洗澡",
  "【bilibili1】 第254话 都是长舌惹得祸", "【bilibili1】 第255话 抽中了关岛旅行", "【bilibili1】 第256话 到美术馆欣赏艺术", "【bilibili1】 第257话 我是风间",
  "【bilibili1】 第258话 招待经理先生", "【bilibili1】 第259话 爸爸生病了", "【bilibili1】 第260话 愉快的化妆", "【bilibili1】 第261话 小新在强风中出游",
  "【bilibili1】 第262话 悲惨的发薪日", "【bilibili1】 第263话 超级小气大作战", "【bilibili1】 第264话 赏花好危险", "【bilibili1】 第265话 大江户乐园水之篇",
  "【bilibili1】 第266话 大江户乐园火之篇", "【bilibili1】 第267话 妈妈没有驾车执照", "【bilibili1】 第268话 上驾驶训练班", "【bilibili1】 第269话 采贝壳比赛",
  "【bilibili1】 第270话 品尝高级点心", "【bilibili1】 第271话 交通规则特训", "【bilibili1】 第272话 与外星人碰面", "【bilibili1】 第273话 到赛马场玩耍",
  "【bilibili1】 第274话 烤肉大餐", "【bilibili1】 第275话 骑脚踏车上学", "【bilibili1】 第276话 取得驾驶执照", "【bilibili1】 第277话 乖宝宝小新",
  "【bilibili1】 第278话 打保龄球", "【bilibili1】 第279话 疲惫的松阪老师", "【bilibili1】 第280话 跟妈妈开车兜风", "【bilibili1】 第281话 到东京巨蛋球场",
  "【bilibili1】 第282话 严格的红蝎子队教练", "【bilibili1】 第283话 角头老大龙子的情书", "【bilibili1】 第284话 和爸爸一起玩", "【bilibili1】 第285话 爬山好累哦",
  "【bilibili1】 第286话 超市真好玩", "【bilibili1】 第287话 动物园记", "【bilibili1】 第288话 现场直播记", "【bilibili1】 第289话 工人好辛苦",
  "【bilibili1】 第290话 离家出走记", "【bilibili1】 第291话 游泳大赛", "【bilibili1】 第292话 柏青哥高手", "【bilibili1】 第293话 悠闲的妈妈",
  "【bilibili1】 第294话 妮妮迷路了", "【bilibili1】 第295话 参观新车展示会", "【bilibili1】 第296话 夏天去海边真快乐", "【bilibili1】 第297话 和阿呆玩捉迷藏",
  "【bilibili1】 第298话 打败坏小孩", "【bilibili1】 第299话 暑假露营记", "【bilibili1】 第300话 露营惊魂记", "【bilibili1】 第301话 爸爸睡不着",
  "【bilibili1】 第302话 跟大姐姐一起躲雨", "【bilibili1】 第303话 看海狗表演", "【bilibili1】 第304话 天气热来玩水", "【bilibili1】 第305话 当漫画家的助手",
  "【bilibili1】 第306话 和动感超人的重逢", "【bilibili1】 第307话 暑假画图日记", "【bilibili1】 第308话 市立游泳池真好玩", "【bilibili1】 第309话 帮忙搬家",
  "【bilibili1】 第310话 去邮局帮妈妈寄信", "【bilibili1】 第311话 去鬼屋玩", "【bilibili1】 第312话 妈妈罢工记", "【bilibili1】 第313话 种青椒记",
  "【bilibili1】 第314话 爸爸戒烟记", "【bilibili1】 第315话 跟松阪老师一起玩", "【bilibili1】 第316话 洗营养午餐的餐具", "【bilibili1】 第317话 泡各种浴池",
  "【bilibili1】 第318话 去健康俱乐部玩", "【bilibili1】 第319话 照顾迷路的小孩", "【bilibili1】 第320话 香水就是外遇的证据", "【bilibili1】 第321话 在船上钓鱼",
  "【bilibili1】 第322话 跟天才少女对决", "【bilibili1】 第323话 开车接爸爸下班", "【bilibili1】 第324话 品尝正宗咖喱", "【bilibili1】 第325话 小白的散步真辛苦",
  "【bilibili1】 第326话 借东西比赛", "【bilibili1】 第327话 网球大赛", "【bilibili1】 第328话 大家一起离家出走", "【bilibili1】 第329话 跟小baby说话",
  "【bilibili1】 第330话 传真机是玩具", "【bilibili1】 第331话 我是天才小画家", "【bilibili1】 第332话 我的脚坏掉了", "【bilibili1】 第333话 爱捣蛋的乌鸦来了",
  "【bilibili1】 第334话 跟风间吵架", "【bilibili1】 第335话 我就是讨厌吃青椒", "【bilibili1】 第336话 我们来划船", "【bilibili1】 第337话 收拾东西真麻烦",
  "【bilibili1】 第338话 吃大碗拉面", "【bilibili1】 第339话 冰淇淋事件", "【bilibili1】 第340话 跟风间道别", "【bilibili1】 第341话 被遗忘的我",
  "【bilibili1】 第342话 睡午觉也很辛苦哦", "【bilibili1】 第343话 豪华火锅大餐", "【bilibili1】 第344话 跟爸爸去剪头发", "【bilibili1】 第345话 来玩躲猫猫",
  "【bilibili1】 第346话 婴儿小新", "【bilibili1】 第347话 妈妈去打工", "【bilibili1】 第348话 松阪老师的假日", "【bilibili1】 第349话 作妮妮家的小孩",
  "【bilibili1】 第350话 进不了家门", "【bilibili1】 第351话 追踪女人", "【bilibili1】 第352话 妈妈喝醉了", "【bilibili1】 第353话 陪客户喝第二摊",
  "【bilibili1】 第354话 黑漆漆的真好玩", "【bilibili1】 第355话 实习老师来了", "【bilibili1】 第356话 可怜的小麻雀", "【bilibili1】 第357话 提早寄贺年卡",
  "【bilibili1】 第358话 送货员真辛苦", "【bilibili1】 第359话 吉永老师的圣诞夜", "【bilibili1】 第360话 新年好热闹", "【bilibili1】 第361话 滑雪去",
  "【bilibili1】 第362话 滑雪场大骚动", "【bilibili1】 第363话 小心火烛", "【bilibili1】 第364话 正男真有人缘", "【bilibili1】 第365话 好吃的年糕",
  "【bilibili1】 第366话 雅惠阿姨来了", "【bilibili1】 第367话 小孩是风的孩子", "【bilibili1】 第368话 果然感冒了", "【bilibili1】 第369话 去约会了",
  "【bilibili1】 第370话 女子摔跤迷", "【bilibili1】 第371话 铲雪真有趣", "【bilibili1】 第372话 小宝宝真可爱", "【bilibili1】 第373话 风间也想轻松一下",
  "【bilibili1】 第374话 开车真危险", "【bilibili1】 第375话 在墙上涂鸦", "【bilibili1】 第376话 上街买福袋", "【bilibili1】 第377话 照顾准考生",
  "【bilibili1】 第378话 来玩卫生纸", "【bilibili1】 第379话 在幼稚园睡午觉", "【bilibili1】 第380话 观赏冬天的星座", "【bilibili1】 第381话 练习写毛笔字",
  "【bilibili1】 第382话 去电视台参观", "【bilibili1】 第383话 电视坏掉了", "【bilibili1】 第384话 遵守餐桌规矩", "【bilibili1】 第385话 传递联络簿",
  "【bilibili1】 第386话 母子一起白看书", "【bilibili1】 第387话 跟小白一起洗澡", "【bilibili1】 第388话 恋爱拉拉队", "【bilibili1】 第389话 谈恋爱真辛苦",
  "【bilibili1】 第390话 可爱的小白蛇", "【bilibili1】 第391话 在一流大饭店过夜", "【bilibili1】 第392话 去动感游乐园玩", "【bilibili1】 第393话 春天的早晨真舒服",
  "【bilibili1】 第394话 小白生病了", "【bilibili1】 第395话 赏花真快乐", "【bilibili1】 第396话 交换卫生纸", "【bilibili1】 第397话 电视坏了",
  "【bilibili1】 第398话 小白和玩具", "【bilibili1】 第399话 兜风去了", "【bilibili1】 第400话 我想要自己的房间", "【bilibili1】 第401话 恋爱的预感",
  "【bilibili1】 第402话 妈妈开车记", "【bilibili1】 第403话 妈妈的交通事故", "【bilibili1】 第404话 松阪老师的春天", "【bilibili1】 第405话 跟偶像握手",
  "【bilibili1】 第406话 春日部防卫队", "【bilibili1】 第407话 参观约会", "【bilibili1】 第408话 去看相扑比赛", "【bilibili1】 第409话 吉永老师喝醉了",
  "【bilibili1】 第410话 跟爸爸一起加班", "【bilibili1】 第411话 爸爸要出差", "【bilibili1】 第412话 爸爸要离开家里了", "【bilibili1】 第413话 要跟爸爸分别",
  "【bilibili1】 第414话 爸爸不在的晚上", "【bilibili1】 第415话 打棒球真辛苦了", "【bilibili1】 第416话 小新闯祸了", "【bilibili1】 第417话 大人的味道",
  "【bilibili1】 第418话 探望妮妮", "【bilibili1】 第419话 爷爷来帮忙", "【bilibili1】 第420话 老大好恐怖", "【bilibili1】 第421话 爸爸的灾难",
  "【bilibili1】 第422话 到大阪吃好吃的东西", "【bilibili1】 第423话 大采购", "【bilibili1】 第424话 观察鸟类", "【bilibili1】 第425话 寄录影带给爸爸",
  "【bilibili1】 第426话 爸爸回来了", "【bilibili1】 第427话 红蝎子队的老大", "【bilibili1】 第428话 做章鱼丸", "【bilibili1】 第429话 跟小娃娃玩",
  "【bilibili1】 第430话 钓鱼池风波", "【bilibili1】 第431话 在天花板上散步", "【bilibili1】 第432话 大雨大雨一直下", "【bilibili1】 第433话 半夜乐趣多",
  "【bilibili1】 第434话 爱的七夕祭", "【bilibili1】 第435话 泡妞很困难哦", "【bilibili1】 第436话 食物中毒真难过", "【bilibili1】 第437话 夜宿医院",
  "【bilibili1】 第438话 爷爷离家出走", "【bilibili1】 第439话 拜访女子大学", "【bilibili1】 第440话 制造混乱的爷爷", "【bilibili1】 第441话 跟风间玩耍",
  "【bilibili1】 第442话 挑选今年的游泳衣", "【bilibili1】 第443话 给旅馆添麻烦", "【bilibili1】 第444话 松阪老师危险了", "【bilibili1】 第445话 被关在厕所里",
  "【bilibili1】 第446话 跟着去约会", "【bilibili1】 第447话 炒热约会气氛", "【bilibili1】 第448话 我是婴儿保姆", "【bilibili1】 第449话 跟踪爸爸",
  "【bilibili1】 第450话 完成快递的任务", "【bilibili1】 第451话 做梦的爸爸", "【bilibili1】 第452话 妮妮生气了", "【bilibili1】 第453话 求婚纪念日",
  "【bilibili1】 第454话 我的宝贝小裤裤", "【bilibili1】 第455话 小裤裤飞起来了", "【bilibili1】 第456话 炫耀小裤裤", "【bilibili1】 第457话 在运动会大出风头",
  "【bilibili1】 第458话 爸彻夜不归倒大霉", "【bilibili1】 第459话 妈妈去打高尔夫球", "【bilibili1】 第460话 我是小新船长", "【bilibili1】 第461话 爸爸的同学会",
  "【bilibili1】 第462话 同学会真快乐", "【bilibili1】 第463话 企鹅报恩记", "【bilibili1】 第464话 炒面爆炸了", "【bilibili1】 第465话 下雨天接人",
  "【bilibili1】 第466话 爸爸的屁股生病了", "【bilibili1】 第467话 我是正义忍者", "【bilibili1】 第468话 爸爸住院了", "【bilibili1】 第469话 爸爸动手术",
  "【bilibili1】 第470话 爸爸的住院生活", "【bilibili1】 第471话 买高级牛排肉", "【bilibili1】 第472话 我和三个强盗", "【bilibili1】 第473话 动感超人大战可怕的蜘蛛机器人",
  "【bilibili1】 第474话 改进小白的屋子", "【bilibili1】 第475话 打扫枯树叶", "【bilibili1】 第476话 准备过冬天", "【bilibili1】 第477话 小白的爱情故事",
  "【bilibili1】 第478话 愤怒的红蝎子队", "【bilibili1】 第479话 不准站着白看书", "【bilibili1】 第480话 私房钱是最高机密",
];
const SECONDARY_TITLES = [
  "【qq】 蜡笔小新 第1季 买东西记", "【qq】 蜡笔小新 第1季 妈妈早上忙死了", "【qq】 蜡笔小新 第1季 画画记",
  "【qq】 蜡笔小新 第1季 骑三轮车记", "【qq】 蜡笔小新 第1季 肚子痛记", "【qq】 蜡笔小新 第1季 爸爸也好辛苦",
  "【qq】 蜡笔小新 第1季 看动感超人记", "【qq】 蜡笔小新 第1季 营养午餐记", "【qq】 蜡笔小新 第1季 看牙医记",
  "【qq】 蜡笔小新 第1季 行侠仗义的向日葵班", "【qq】 蜡笔小新 第1季 野餐记 1", "【qq】 蜡笔小新 第1季 野餐记 2",
  "【qq】 蜡笔小新 第1季 看电影记", "【qq】 蜡笔小新 第1季 帮忙记", "【qq】 蜡笔小新 第1季 整理东西记",
  "【qq】 蜡笔小新 第1季 养小蝌蚪记", "【qq】 蜡笔小新 第1季 跟妈妈一起洗澡", "【qq】 蜡笔小新 第1季 避难训练记",
  "【qq】 蜡笔小新 第1季 拣狗记", "【qq】 蜡笔小新 第1季 它的名字叫小白", "【qq】 蜡笔小新 第1季 遛狗记",
  "【qq】 蜡笔小新 第1季 小白的家", "【qq】 蜡笔小新 第1季 讨厌的青辣椒", "【qq】 蜡笔小新 第1季 不要打扰爸爸工作",
  "【qq】 蜡笔小新 第1季 玩黏土记", "【qq】 蜡笔小新 第1季 看书记", "【qq】 蜡笔小新 第1季 跟大姐姐是好朋友",
  "【qq】 蜡笔小新 第1季 买泳衣记", "【qq】 蜡笔小新 第1季 上游泳课", "【qq】 蜡笔小新 第1季 喂小白记",
  "【qq】 蜡笔小新 第1季 夫妻吵架", "【qq】 蜡笔小新 第1季 亲子网鱼记", "【qq】 蜡笔小新 第1季 小新理发记",
  "【qq】 蜡笔小新 第1季 护宝记", "【qq】 蜡笔小新 第1季 摄影记", "【qq】 蜡笔小新 第1季 到海边去真好玩",
  "【qq】 蜡笔小新 第1季 住豪华饭店记", "【qq】 蜡笔小新 第1季 回家的路真远", "【qq】 蜡笔小新 第1季 妈妈睡午觉",
  "【qq】 蜡笔小新 第1季 说英文", "【qq】 蜡笔小新 第1季 去搭火车", "【qq】 蜡笔小新 第1季 搭过电车了",
  "【qq】 蜡笔小新 第1季 今天晚上放烟火", "【qq】 蜡笔小新 第1季 上公共澡堂玩", "【qq】 蜡笔小新 第1季 照顾老妈",
  "【qq】 蜡笔小新 第1季 跟会欺负人的小孩玩", "【qq】 蜡笔小新 第1季 蜡笔小新：逛庙会", "【qq】 蜡笔小新 第1季 跟动感超人会面记",
  "【qq】 蜡笔小新 第1季 吉永老师约会记", "【qq】 蜡笔小新 第1季 被遗忘的小白", "【qq】 蜡笔小新 第1季 妮妮的妈妈很温柔",
  "【qq】 蜡笔小新 第1季 爷爷来了 小顽童加老顽童 求妈妈的阴影面积！", "【qq】 蜡笔小新 第1季 台风来了", "【qq】 蜡笔小新 第1季 来决斗吧",
  "【qq】 蜡笔小新 第1季 寄信记 煽情的小新好暖哦！", "【qq】 蜡笔小新 第1季 饭后刷牙", "【qq】 蜡笔小新 第1季 连续尿床三次",
  "【qq】 蜡笔小新 第1季 练习跳舞 新一代舞王小新诞生！", "【qq】 蜡笔小新 第1季 跟妈妈的战斗 长江后浪推前浪 被拍死在沙滩上的妈妈", "【qq】 蜡笔小新 第1季 大家来玩吹泡泡",
  "【qq】 蜡笔小新 第1季 加油，运动会", "【qq】 蜡笔小新 第1季 跟妈妈赛跑", "【qq】 蜡笔小新 第1季 接力赛",
  "【qq】 蜡笔小新 第1季 逛书店", "【qq】 蜡笔小新 第1季 暗语是美伢 好多好多只小新啊！", "【qq】 蜡笔小新 第1季 踩高跷比赛",
  "【qq】 蜡笔小新 第1季 我们接爸爸去", "【qq】 蜡笔小新 第1季 打工真命苦", "【qq】 蜡笔小新 第1季 演戏记",
  "【qq】 蜡笔小新 第1季 夫妻吵架的调解记", "【qq】 蜡笔小新 第1季 蟑螂大决斗", "【qq】 蜡笔小新 第1季 测量身材日",
  "【qq】 蜡笔小新 第1季 跟爸爸一起洗车", "【qq】 蜡笔小新 第1季 在百货公司迷路了", "【qq】 蜡笔小新 第1季 清扫小鸡的家",
  "【qq】 蜡笔小新 第1季 我的七五三", "【qq】 蜡笔小新 第1季 预防感冒的好方法 预防感冒要从便便做起！", "【qq】 蜡笔小新 第1季 老师的好帮手",
  "【qq】 蜡笔小新 第1季 买烤番薯", "【qq】 蜡笔小新 第1季 探病", "【qq】 蜡笔小新 第1季 捉迷藏",
  "【qq】 蜡笔小新 第1季 出门去", "【qq】 蜡笔小新 第1季 动物园快乐游记", "【qq】 蜡笔小新 第1季 跟妈妈一起去美容院 小新和妈妈去美容院 美容院的阿姨疯掉了",
  "【qq】 蜡笔小新 第1季 蜡笔小新：我也要年终礼物", "【qq】 蜡笔小新 第1季 银行领钱记", "【qq】 蜡笔小新 第1季 跟女警官在一起",
  "【qq】 蜡笔小新 第1季 跟爸爸一起洗澡", "【qq】 蜡笔小新 第1季 跟小白一起看家", "【qq】 蜡笔小新 第1季 松阪老师的小秘密",
  "【qq】 蜡笔小新 第1季 爷爷又来了", "【qq】 蜡笔小新 第1季 我的第一次滑雪记", "【qq】 蜡笔小新 第1季 风间家好好玩",
  "【qq】 蜡笔小新 第1季 和动感超人共度圣诞夜", "【qq】 蜡笔小新 第1季 做便当真辛苦", "【qq】 蜡笔小新 第1季 扮家家酒",
  "【qq】 蜡笔小新 第1季 去书店帮忙了", "【qq】 蜡笔小新 第1季 当模特儿记", "【qq】 蜡笔小新 第1季 快乐温泉旅行",
  "【qq】 蜡笔小新 第1季 温泉混浴记", "【qq】 蜡笔小新 第1季 蜡笔小新：吃年夜饭", "【qq】 蜡笔小新 第1季 放风筝好好玩",
  "【qq】 蜡笔小新 第1季 蜡笔小新：来做雪人吧 只有小新才能做得的感谢方式！", "【qq】 蜡笔小新 第1季 节分撒豆子", "【qq】 蜡笔小新 第1季 美伢买衣服记",
  "【qq】 蜡笔小新 第1季 吃火锅记", "【qq】 蜡笔小新 第1季 感冒记 生病的小新战斗力不减分毫！", "【qq】 蜡笔小新 第1季 当警察真辛苦",
  "【qq】 蜡笔小新 第1季 卡拉OK唱歌记", "【qq】 蜡笔小新 第1季 买红豆饼鲷烧记", "【qq】 蜡笔小新 第1季 住校保育记",
  "【qq】 蜡笔小新 第1季 住校保育之夜", "【qq】 蜡笔小新 第1季 在图书馆要保持安静", "【qq】 蜡笔小新 第1季 马拉松的练习",
  "【qq】 蜡笔小新 第1季 马拉松大赛", "【qq】 蜡笔小新 第1季 三月三日女儿节", "【qq】 蜡笔小新 第1季 学游泳记",
  "【qq】 蜡笔小新 第1季 小白学艺记", "【qq】 蜡笔小新 第1季 打羽毛球记", "【qq】 蜡笔小新 第1季 社会观摩记",
  "【qq】 蜡笔小新 第1季 外送比萨记", "【qq】 蜡笔小新 第1季 正男的天竺鼠", "【qq】 蜡笔小新 第1季 晒棉被记",
  "【qq】 蜡笔小新 第1季 练习足球", "【qq】 蜡笔小新 第1季 足球大赛", "【qq】 蜡笔小新 第1季 地震来了",
  "【qq】 蜡笔小新 第1季 占位子来赏花", "【qq】 蜡笔小新 第1季 赏花真快乐", "【qq】 蜡笔小新 第1季 去爸爸的公司",
  "【qq】 蜡笔小新 第1季 大家一起来播种", "【qq】 蜡笔小新 第1季 帮妈妈去买菜", "【qq】 蜡笔小新 第1季 没有眉毛的脸",
  "【qq】 蜡笔小新 第1季 爸爸喝醉了", "【qq】 蜡笔小新 第1季 我的亲手签名", "【qq】 蜡笔小新 第1季 跟妈妈去买东西",
  "【qq】 蜡笔小新 第1季 升起鲤鱼旗", "【qq】 蜡笔小新 第1季 来玩踢罐子", "【qq】 蜡笔小新 第1季 跟电梯小姐在一起",
  "【qq】 蜡笔小新 第1季 突然很想吃拉面", "【qq】 蜡笔小新 第1季 跟老大玩扮家家酒", "【qq】 蜡笔小新 第1季 出发去远足",
  "【qq】 蜡笔小新 第1季 远足遇险记", "【qq】 蜡笔小新 第1季 玩火真可怕", "【qq】 蜡笔小新 第1季 收拾玩具真麻烦",
  "【qq】 蜡笔小新 第1季 晚上是大人的时间", "【qq】 蜡笔小新 第1季 我的书是畅销书", "【qq】 蜡笔小新 第1季 妈妈离家出走",
  "【qq】 蜡笔小新 第1季 地狱女推销员复仇记", "【qq】 蜡笔小新 第1季 跟爷爷去东京玩", "【qq】 蜡笔小新 第1季 倒垃圾真辛苦",
  "【qq】 蜡笔小新 第1季 去女生学校玩", "【qq】 蜡笔小新 第1季 回转寿司", "【qq】 蜡笔小新 第1季 帮助有困难的人",
  "【qq】 蜡笔小新 第1季 做木工真辛苦", "【qq】 蜡笔小新 第1季 小白不见了", "【qq】 蜡笔小新 第1季 向政治家问问题",
  "【qq】 蜡笔小新 第1季 服从姐姐大人", "【qq】 蜡笔小新 第1季 今天是父亲节", "【qq】 蜡笔小新 第1季 男生下厨房",
  "【qq】 蜡笔小新 第1季 妈妈牙齿痛", "【qq】 蜡笔小新 第1季 跟坏小孩玩", "【qq】 蜡笔小新 第1季 婚礼服",
  "【qq】 蜡笔小新 第1季 参加婚礼典礼", "【qq】 蜡笔小新 第1季 去吃喜酒", "【qq】 蜡笔小新 第1季 小新怕得睡不着",
  "【qq】 蜡笔小新 第1季 清扫游泳池真快乐", "【qq】 蜡笔小新 第1季 吹气球", "【qq】 蜡笔小新 第1季 拾钱包",
  "【qq】 蜡笔小新 第1季 小新吃刨冰", "【qq】 蜡笔小新 第1季 小白去打针", "【qq】 蜡笔小新 第1季 全家去露营",
  "【qq】 蜡笔小新 第1季 小新是未来的红歌星", "【qq】 蜡笔小新 第1季 来画电车铁轨", "【qq】 蜡笔小新 第1季 好热好热的夜晚",
  "【qq】 蜡笔小新 第1季 吉永老师的私生活", "【qq】 蜡笔小新 第1季 最后一次见推销小姐", "【qq】 蜡笔小新 第1季 买冷气机",
  "【qq】 蜡笔小新 第1季 去加油站", "【qq】 蜡笔小新 第1季 好多大西瓜", "【qq】 蜡笔小新 第1季 切西瓜记",
  "【qq】 蜡笔小新 第1季 练习相扑", "【qq】 蜡笔小新 第1季 参加相扑比赛", "【qq】 蜡笔小新 第1季 去警察局",
  "【qq】 蜡笔小新 第1季 去抓昆虫", "【qq】 蜡笔小新 第1季 跟妈妈一起打扫", "【qq】 蜡笔小新 第1季 水灾记",
  "【qq】 蜡笔小新 第1季 和大姐头的大对决", "【qq】 蜡笔小新 第1季 躲避球比赛", "【qq】 蜡笔小新 第1季 被救护车送进医院",
  "【qq】 蜡笔小新 第1季 在医院也很红", "【qq】 蜡笔小新 第1季 我是刑警", "【qq】 蜡笔小新 第1季 新娘子来了",
  "【qq】 蜡笔小新 第1季 练习赛跑", "【qq】 蜡笔小新 第1季 运动会录影记", "【qq】 蜡笔小新 第1季 松阪老师去约会",
  "【qq】 蜡笔小新 第1季 特级寿司最好吃", "【qq】 蜡笔小新 第1季 名犬小白散步记", "【qq】 蜡笔小新 第1季 抬神轿",
  "【qq】 蜡笔小新 第1季 参加拍卖会", "【qq】 蜡笔小新 第1季 在拍卖会上卖东西", "【qq】 蜡笔小新 第1季 修理屋檐记",
  "【qq】 蜡笔小新 第1季 我的弟弟是小鸡", "【qq】 蜡笔小新 第1季 寻找小鸡", "【qq】 蜡笔小新 第1季 帮忙洗衣服",
  "【qq】 蜡笔小新 第1季 到新婚夫妇的家", "【qq】 蜡笔小新 第1季 假扮上学", "【qq】 蜡笔小新 第1季 烤肉",
  "【qq】 蜡笔小新 第1季 爸爸，辛苦你了", "【qq】 蜡笔小新 第1季 穿着高中女生制服的妈妈", "【qq】 蜡笔小新 第1季 在成品屋里玩耍",
  "【qq】 蜡笔小新 第1季 全家福照片", "【qq】 蜡笔小新 第1季 缝衣服", "【qq】 蜡笔小新 第1季 我讨厌打针",
  "【qq】 蜡笔小新 第1季 招待客人", "【qq】 蜡笔小新 第1季 明褒暗贬", "【qq】 蜡笔小新 第1季 讨厌小猫的爸爸",
  "【qq】 蜡笔小新 第1季 到书店玩耍", "【qq】 蜡笔小新 第1季 吃拉面", "【qq】 蜡笔小新 第1季 溜冰天才",
  "【qq】 蜡笔小新 第1季 新婚夫妇吵架了", "【qq】 蜡笔小新 第1季 做饼干了", "【qq】 蜡笔小新 第1季 松阪老师的相亲",
  "【qq】 蜡笔小新 第1季 选举真辛苦", "【qq】 蜡笔小新 第1季 织毛衣", "【qq】 蜡笔小新 第1季 坐电车",
  "【qq】 蜡笔小新 第1季 去爸爸的公司玩", "【qq】 蜡笔小新 第1季 服装秀表演", "【qq】 蜡笔小新 第1季 幼稚园大扫除",
  "【qq】 蜡笔小新 第1季 除夕夜的钟声", "【qq】 蜡笔小新 第1季 爷爷奶奶来访", "【qq】 蜡笔小新 第1季 压岁钱",
  "【qq】 蜡笔小新 第1季 用压岁钱买东西", "【qq】 蜡笔小新 第1季 参加滑雪旅行", "【qq】 蜡笔小新 第1季 滑雪后的活动",
  "【qq】 蜡笔小新 第1季 全家来滑雪", "【qq】 蜡笔小新 第1季 防止迟到的战术", "【qq】 蜡笔小新 第1季 正男的恋情",
  "【qq】 蜡笔小新 第1季 我有弟弟了", "【qq】 蜡笔小新 第1季 我是铅笔小新", "【qq】 蜡笔小新 第1季 学铅笔小新讲话",
  "【qq】 蜡笔小新 第1季 彩券中奖了", "【qq】 蜡笔小新 第1季 去参加葬礼", "【qq】 蜡笔小新 第1季 来玩雪地大战",
  "【qq】 蜡笔小新 第1季 去看风间吧", "【qq】 蜡笔小新 第1季 课长的新家", "【qq】 蜡笔小新 第1季 改变发型记",
  "【qq】 蜡笔小新 第1季 谜般的哈蒂娜", "【qq】 蜡笔小新 第1季 挖耳朵好舒服", "【qq】 蜡笔小新 第1季 美伢的同学会",
  "【qq】 蜡笔小新 第1季 离婚记", "【qq】 蜡笔小新 第1季 垒球比赛 1", "【qq】 蜡笔小新 第1季 垒球比赛 2",
  "【qq】 蜡笔小新 第1季 一个人洗澡", "【qq】 蜡笔小新 第1季 都是长舌惹得祸", "【qq】 蜡笔小新 第1季 抽中了关岛旅行",
  "【qq】 蜡笔小新 第1季 到美术馆欣赏艺术", "【qq】 蜡笔小新 第1季 我是风间", "【qq】 蜡笔小新 第1季 招待经理先生",
  "【qq】 蜡笔小新 第1季 爸爸生病了", "【qq】 蜡笔小新 第1季 愉快的化妆", "【qq】 蜡笔小新 第1季 小新在强风中出游",
  "【qq】 蜡笔小新 第1季 悲惨的发薪日", "【qq】 蜡笔小新 第1季 超级小气大作战", "【qq】 蜡笔小新 第1季 赏花好危险",
  "【qq】 蜡笔小新 第1季 大江户乐园水之篇", "【qq】 蜡笔小新 第1季 大江户乐园火之篇", "【qq】 蜡笔小新 第1季 妈妈没有驾车执照",
  "【qq】 蜡笔小新 第1季 上驾驶训练班", "【qq】 蜡笔小新 第1季 采贝壳比赛", "【qq】 蜡笔小新 第1季 品尝高级点心",
  "【qq】 蜡笔小新 第1季 交通规则特训", "【qq】 蜡笔小新 第1季 与外星人碰面", "【qq】 蜡笔小新 第1季 到赛马场玩耍",
  "【qq】 蜡笔小新 第1季 烤肉大餐", "【qq】 蜡笔小新 第1季 骑脚踏车上学", "【qq】 蜡笔小新 第1季 取得驾驶执照",
  "【qq】 蜡笔小新 第1季 乖宝宝小新", "【qq】 蜡笔小新 第1季 打保龄球", "【qq】 蜡笔小新 第1季 疲惫的松阪老师",
  "【qq】 蜡笔小新 第1季 跟妈妈开车兜风", "【qq】 蜡笔小新 第1季 到东京巨蛋球场", "【qq】 蜡笔小新 第1季 严格的红蝎子队教练",
  "【qq】 蜡笔小新 第1季 角头老大龙子的情书", "【qq】 蜡笔小新 第1季 和爸爸一起玩", "【qq】 蜡笔小新 第1季 爬山好累哦",
  "【qq】 蜡笔小新 第1季 超市真好玩", "【qq】 蜡笔小新 第1季 动物园记", "【qq】 蜡笔小新 第1季 现场直播记",
  "【qq】 蜡笔小新 第1季 工人好辛苦", "【qq】 蜡笔小新 第1季 离家出走记", "【qq】 蜡笔小新 第1季 游泳大赛",
  "【qq】 蜡笔小新 第1季 柏青哥高手", "【qq】 蜡笔小新 第1季 悠闲的妈妈", "【qq】 蜡笔小新 第1季 妮妮迷路了",
  "【qq】 蜡笔小新 第1季 参观新车展示会", "【qq】 蜡笔小新 第1季 夏天去海边真快乐", "【qq】 蜡笔小新 第1季 和阿呆玩捉迷藏",
  "【qq】 蜡笔小新 第1季 打败坏小孩", "【qq】 蜡笔小新 第1季 暑假露营记", "【qq】 蜡笔小新 第1季 露营惊魂记",
  "【qq】 蜡笔小新 第1季 爸爸睡不着", "【qq】 蜡笔小新 第1季 跟大姐姐一起躲雨", "【qq】 蜡笔小新 第1季 看海狗表演",
  "【qq】 蜡笔小新 第1季 天气热来玩水", "【qq】 蜡笔小新 第1季 当漫画家的助手", "【qq】 蜡笔小新 第1季 和动感超人的重逢",
  "【qq】 蜡笔小新 第1季 暑假画图日记", "【qq】 蜡笔小新 第1季 市立游泳池真好玩", "【qq】 蜡笔小新 第1季 帮忙搬家",
  "【qq】 蜡笔小新 第1季 去邮局帮妈妈寄信", "【qq】 蜡笔小新 第1季 去鬼屋玩", "【qq】 蜡笔小新 第1季 妈妈罢工记",
  "【qq】 蜡笔小新 第1季 种青椒记", "【qq】 蜡笔小新 第1季 爸爸戒烟记", "【qq】 蜡笔小新 第1季 跟松阪老师一起玩",
  "【qq】 蜡笔小新 第1季 洗营养午餐的餐具", "【qq】 蜡笔小新 第1季 泡各种浴池", "【qq】 蜡笔小新 第1季 去健康俱乐部玩",
  "【qq】 蜡笔小新 第1季 照顾迷路的小孩", "【qq】 蜡笔小新 第1季 香水就是外遇的证据", "【qq】 蜡笔小新 第1季 在船上钓鱼",
  "【qq】 蜡笔小新 第1季 跟天才少女对决", "【qq】 蜡笔小新 第1季 开车接爸爸下班", "【qq】 蜡笔小新 第1季 品尝正宗咖喱",
  "【qq】 蜡笔小新 第1季 小白的散步真辛苦", "【qq】 蜡笔小新 第1季 借东西比赛", "【qq】 蜡笔小新 第1季 网球大赛",
  "【qq】 蜡笔小新 第1季 大家一起离家出走", "【qq】 蜡笔小新 第1季 跟小baby说话", "【qq】 蜡笔小新 第1季 传真机是玩具",
  "【qq】 蜡笔小新 第1季 我是天才小画家", "【qq】 蜡笔小新 第1季 我的脚坏掉了", "【qq】 蜡笔小新 第1季 爱捣蛋的乌鸦来了",
  "【qq】 蜡笔小新 第1季 跟风间吵架", "【qq】 蜡笔小新 第1季 我就是讨厌吃青椒", "【qq】 蜡笔小新 第1季 我们来划船",
  "【qq】 蜡笔小新 第1季 收拾东西真麻烦", "【qq】 蜡笔小新 第1季 吃大碗拉面", "【qq】 蜡笔小新 第1季 冰淇淋事件",
  "【qq】 蜡笔小新 第1季 跟风间道别", "【qq】 蜡笔小新 第1季 被遗忘的我", "【qq】 蜡笔小新 第1季 睡午觉也很辛苦哦",
  "【qq】 蜡笔小新 第1季 豪华火锅大餐", "【qq】 蜡笔小新 第1季 跟爸爸去剪头发", "【qq】 蜡笔小新 第1季 来玩躲猫猫",
  "【qq】 蜡笔小新 第1季 婴儿小新", "【qq】 蜡笔小新 第1季 妈妈去打工", "【qq】 蜡笔小新 第1季 松阪老师的假日",
  "【qq】 蜡笔小新 第1季 做妮妮家的小孩", "【qq】 蜡笔小新 第1季 进不了家门", "【qq】 蜡笔小新 第1季 追踪女人",
  "【qq】 蜡笔小新 第1季 妈妈喝醉了", "【qq】 蜡笔小新 第1季 陪客户喝第二摊", "【qq】 蜡笔小新 第1季 黑漆漆的真好玩",
  "【qq】 蜡笔小新 第1季 实习老师来了", "【qq】 蜡笔小新 第1季 可怜的小麻雀", "【qq】 蜡笔小新 第1季 提早寄贺年卡",
  "【qq】 蜡笔小新 第1季 送货员真辛苦", "【qq】 蜡笔小新 第1季 吉永老师的圣诞夜", "【qq】 蜡笔小新 第1季 新年好热闹",
  "【qq】 蜡笔小新 第1季 滑雪去", "【qq】 蜡笔小新 第1季 滑雪场大骚动", "【qq】 蜡笔小新 第1季 小心火烛",
  "【qq】 蜡笔小新 第1季 正男真有人缘", "【qq】 蜡笔小新 第1季 好吃的年糕", "【qq】 蜡笔小新 第1季 雅惠阿姨来了",
  "【qq】 蜡笔小新 第1季 小孩是风的孩子", "【qq】 蜡笔小新 第1季 果然感冒了", "【qq】 蜡笔小新 第1季 去约会了",
  "【qq】 蜡笔小新 第1季 女子摔跤迷", "【qq】 蜡笔小新 第1季 铲雪真有趣", "【qq】 蜡笔小新 第1季 小宝宝真可爱",
  "【qq】 蜡笔小新 第1季 风间也想轻松一下", "【qq】 蜡笔小新 第1季 开车真危险", "【qq】 蜡笔小新 第1季 在墙上涂鸦",
  "【qq】 蜡笔小新 第1季 上街买福袋", "【qq】 蜡笔小新 第1季 照顾准考生", "【qq】 蜡笔小新 第1季 来玩卫生纸",
  "【qq】 蜡笔小新 第1季 在幼稚园睡午觉", "【qq】 蜡笔小新 第1季 观赏冬天的星座", "【qq】 蜡笔小新 第1季 练习写毛笔字",
  "【qq】 蜡笔小新 第1季 去电视台参观", "【qq】 蜡笔小新 第1季 电视坏掉了", "【qq】 蜡笔小新 第1季 遵守餐桌规矩",
  "【qq】 蜡笔小新 第1季 传递联络簿", "【qq】 蜡笔小新 第1季 母子一起白看书", "【qq】 蜡笔小新 第1季 跟小白一起洗澡",
  "【qq】 蜡笔小新 第1季 恋爱拉拉队", "【qq】 蜡笔小新 第1季 谈恋爱真辛苦", "【qq】 蜡笔小新 第1季 可爱的小白蛇",
  "【qq】 蜡笔小新 第1季 在一流大饭店过夜", "【qq】 蜡笔小新 第1季 去动感游乐园玩", "【qq】 蜡笔小新 第1季 春天的早晨真舒服",
  "【qq】 蜡笔小新 第1季 小白生病了", "【qq】 蜡笔小新 第1季 赏花真快乐", "【qq】 蜡笔小新 第1季 交换卫生纸",
  "【qq】 蜡笔小新 第1季 电视坏了", "【qq】 蜡笔小新 第1季 小白和玩具", "【qq】 蜡笔小新 第1季 兜风去了",
  "【qq】 蜡笔小新 第1季 我想要自己的房间", "【qq】 蜡笔小新 第1季 恋爱的预感", "【qq】 蜡笔小新 第1季 妈妈开车记",
  "【qq】 蜡笔小新 第1季 妈妈的交通事故", "【qq】 蜡笔小新 第1季 松阪老师的春天", "【qq】 蜡笔小新 第1季 跟偶像握手",
  "【qq】 蜡笔小新 第1季 春日部防卫队", "【qq】 蜡笔小新 第1季 参观约会", "【qq】 蜡笔小新 第1季 去看相扑比赛",
  "【qq】 蜡笔小新 第1季 吉永老师喝醉了", "【qq】 蜡笔小新 第1季 跟爸爸一起加班", "【qq】 蜡笔小新 第1季 爸爸要出差",
  "【qq】 蜡笔小新 第1季 爸爸要离开家里了", "【qq】 蜡笔小新 第1季 要跟爸爸分别", "【qq】 蜡笔小新 第1季 爸爸不在的晚上",
  "【qq】 蜡笔小新 第1季 打棒球真辛苦了", "【qq】 蜡笔小新 第1季 小新闯祸了", "【qq】 蜡笔小新 第1季 大人的味道",
  "【qq】 蜡笔小新 第1季 探望妮妮", "【qq】 蜡笔小新 第1季 爷爷来帮忙", "【qq】 蜡笔小新 第1季 老大好恐怖",
  "【qq】 蜡笔小新 第1季 爸爸的灾难", "【qq】 蜡笔小新 第1季 到大阪吃好吃的东西", "【qq】 蜡笔小新 第1季 大采购",
  "【qq】 蜡笔小新 第1季 观察鸟类", "【qq】 蜡笔小新 第1季 寄录影带给爸爸", "【qq】 蜡笔小新 第1季 爸爸回来了",
  "【qq】 蜡笔小新 第1季 红蝎子队的老大", "【qq】 蜡笔小新 第1季 做章鱼丸", "【qq】 蜡笔小新 第1季 跟小娃娃玩",
  "【qq】 蜡笔小新 第1季 钓鱼池风波", "【qq】 蜡笔小新 第1季 在天花板上散步", "【qq】 蜡笔小新 第1季 大雨大雨一直下",
  "【qq】 蜡笔小新 第1季 半夜乐趣多", "【qq】 蜡笔小新 第1季 爱的七夕祭", "【qq】 蜡笔小新 第1季 泡妞很困难哦",
  "【qq】 蜡笔小新 第1季 食物中毒真难过", "【qq】 蜡笔小新 第1季 夜宿医院", "【qq】 蜡笔小新 第1季 爷爷离家出走",
  "【qq】 蜡笔小新 第1季 拜访女子大学", "【qq】 蜡笔小新 第1季 制造混乱的爷爷", "【qq】 蜡笔小新 第1季 跟风间玩耍",
  "【qq】 蜡笔小新 第1季 挑选今年的游泳衣", "【qq】 蜡笔小新 第1季 给旅馆添麻烦", "【qq】 蜡笔小新 第1季 松阪老师危险了",
  "【qq】 蜡笔小新 第1季 被关在厕所里", "【qq】 蜡笔小新 第1季 跟着去约会", "【qq】 蜡笔小新 第1季 炒热约会气氛",
  "【qq】 蜡笔小新 第1季 我是婴儿保姆", "【qq】 蜡笔小新 第1季 跟踪爸爸", "【qq】 蜡笔小新 第1季 完成快递的任务",
  "【qq】 蜡笔小新 第1季 做梦的爸爸", "【qq】 蜡笔小新 第1季 妮妮生气了", "【qq】 蜡笔小新 第1季 求婚纪念日",
  "【qq】 蜡笔小新 第1季 我的宝贝小裤裤", "【qq】 蜡笔小新 第1季 小裤裤飞起来了", "【qq】 蜡笔小新 第1季 炫耀小裤裤",
  "【qq】 蜡笔小新 第1季 在运动会大出风头", "【qq】 蜡笔小新 第1季 爸爸彻夜不归倒大霉", "【qq】 蜡笔小新 第1季 妈妈去打高尔夫球",
  "【qq】 蜡笔小新 第1季 我是小新船长", "【qq】 蜡笔小新 第1季 爸爸的同学会", "【qq】 蜡笔小新 第1季 同学会真快乐",
  "【qq】 蜡笔小新 第1季 企鹅报恩记", "【qq】 蜡笔小新 第1季 炒面爆炸了", "【qq】 蜡笔小新 第1季 下雨天接人",
  "【qq】 蜡笔小新 第1季 爸爸的屁股生病了", "【qq】 蜡笔小新 第1季 我是正义忍者", "【qq】 蜡笔小新 第1季 爸爸住院了",
  "【qq】 蜡笔小新 第1季 爸爸动手术", "【qq】 蜡笔小新 第1季 爸爸的住院生活", "【qq】 蜡笔小新 第1季 买高级牛排肉",
  "【qq】 蜡笔小新 第1季 我和三个强盗", "【qq】 蜡笔小新 第1季 动感超人大战可怕的蜘蛛机器人", "【qq】 蜡笔小新 第1季 改建小白的屋子",
  "【qq】 蜡笔小新 第1季 打扫枯树叶", "【qq】 蜡笔小新 第1季 准备过冬天", "【qq】 蜡笔小新 第1季 小白的爱情故事",
  "【qq】 蜡笔小新 第1季 愤怒的红蝎子队", "【qq】 蜡笔小新 第1季 不准站着白看书", "【qq】 蜡笔小新 第1季 私房钱是最高机密",
];
