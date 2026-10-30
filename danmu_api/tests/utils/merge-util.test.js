// 合并工具：副源匹配与集对齐
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Envs } from '../../configs/envs.js';
import { Globals } from '../../configs/globals.js';
import { Season } from '../../models/dandan-model.js';
import { findSecondaryMatches, applyMergeLogic, resolveDubVersionLinkIndex, mergeLinkEntry } from '../../utils/merge-util.js';

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
