// 弹弹play 兼容接口：标题/季集解析、匹配与检索 URL
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { extractTitleSeasonEpisode, buildSearchAnimeUrl, matchSeason, matchAniAndEp, fallbackMatchAniAndEp, filterSameEpisodeTitle, buildBangumiData, resolveEpisodeCount, applyEpisodeTitleFilter, filterEpisodesByTitle, withAvailableEpisodeCount } from '../../apis/dandan-api.js';
import { getSearchCache, setSearchCache } from '../../utils/cache-util.js';
import { addFavorite, removeFavorite, saveFavorites } from '../../utils/favorite-util.js';
import { Globals, globals } from '../../configs/globals.js';
import { normalizeTitleForMatch } from '../../utils/common-util.js';
import { urlPrefix } from '../helpers/context.js';

test('buildSearchAnimeUrl should preserve special characters in keyword', async () => {
    const searchUrl = buildSearchAnimeUrl(`${urlPrefix}/api/v2/match`, 'Love & Death', 1, 2);

    assert.equal(searchUrl.pathname, '/api/v2/search/anime');
    assert.equal(searchUrl.searchParams.get('keyword'), 'Love & Death');
    assert.equal(searchUrl.searchParams.get('season'), '1');
    assert.equal(searchUrl.searchParams.get('episode'), '2');
    assert.equal(searchUrl.searchParams.has(' Death'), false);
  });
test('buildSearchAnimeUrl should derive /search/anime from /search/episodes requests', async () => {
    const searchUrl = buildSearchAnimeUrl(`${urlPrefix}/api/v2/search/episodes?anime=Love%20%26%20Death&episode=2`, 'Love & Death');

    assert.equal(searchUrl.pathname, '/api/v2/search/anime');
    assert.equal(searchUrl.searchParams.get('keyword'), 'Love & Death');
    assert.equal(searchUrl.searchParams.has('season'), false);
    assert.equal(searchUrl.searchParams.has('episode'), false);
  });
  // 测试标题解析
test('PARSE TitleSeasonEpisode', async () => {
    let title, season, episode;
    ({title, season, episode} = await extractTitleSeasonEpisode("生万物 S02E08"));
    assert(title === "生万物" && season == 2 && episode == 8, `Expected title === "生万物" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("无忧渡.S02E08.2160p.WEB-DL.H265.DDP.5.1"));
    assert(title === "无忧渡" && season == 2 && episode == 8, `Expected title === "无忧渡" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    // ({title, season, episode} = await extractTitleSeasonEpisode("Blood.River.S02E08"));
    // assert(title === "暗河传" && season == 2 && episode == 8, `Expected title === "暗河传" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("爱情公寓.ipartment.2009.S02E08.H.265.25fps.mkv"));
    assert(title === "爱情公寓" && season == 2 && episode == 8, `Expected title === "爱情公寓" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("亲爱的X S02E08"));
    assert(title === "亲爱的X" && season == 2 && episode == 8, `Expected title === "亲爱的X" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("宇宙Marry Me? S02E08"));
    assert(title === "宇宙Marry Me?" && season == 2 && episode == 8, `Expected title === "宇宙Marry Me?" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);
  });
test('season matching unifies traditional and simplified titles', () => {
  const queryTitle = '无职转生 ～到了异世界就拿出真本事～';

  // 繁体别名与简体查询词指向同一作品同一季时必须命中；季号不一致则不得命中
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事～第三季', source: 'dandan' }, queryTitle, 3), true);
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事～第3季', source: 'dandan' }, queryTitle, 3), true);
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事～第三季', source: 'dandan' }, queryTitle, 2), false);

  // 季号标识插在主体名称中间时查询词不是标题前缀，不得命中
  assert.equal(matchSeason({ animeTitle: '无职转生Ⅲ ～到了异世界就拿出真本事～', source: 'dandan' }, queryTitle, 3), false);
  assert.equal(matchSeason({ animeTitle: '无职转生 第三季 ～到了异世界就拿出真本事～', source: 'dandan' }, queryTitle, 3), false);

  // 主体一致但无季号：仅第 1 季命中；有其它季号则不得命中
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事～', source: 'dandan' }, queryTitle, 1), true);
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事～', source: 'dandan' }, queryTitle, 3), false);
  assert.equal(matchSeason({ animeTitle: '無職轉生～到了異世界就拿出真本事 第二季', source: 'dandan' }, queryTitle, 3), false);

  // 归一化不得把不同作品视为同一作品
  assert.equal(normalizeTitleForMatch('无职英雄 技能什么的毫无用处').includes(normalizeTitleForMatch(queryTitle)), false);
  assert.equal(matchSeason({ animeTitle: '无职英雄 技能什么的毫无用处(2025)', source: 'dandan' }, queryTitle, 3), false);
});
test('movie matching unifies traditional and simplified titles', async () => {
  Globals.init({ LOG_LEVEL: 'error' });

  const buildMovie = (animeId, animeTitle) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases: [],
    source: 'dandan',
    startDate: '2020-01-01T00:00:00.000Z',
    links: [{ id: animeId * 10 + 1, title: '【测试源】 正片', url: `test-${animeId}-1` }]
  });

  const traditional = buildMovie(3001, '某電影(2020)【电影】');
  const withColon = buildMovie(3002, '某电影：终章(2020)【电影】');
  const different = buildMovie(3003, '另一部电影(2020)【电影】');
  const sequel = buildMovie(3004, '某电影2(2020)【电影】');
  const detailStore = new Map([[3001, traditional], [3002, withColon], [3003, different], [3004, sequel]]);

  const matchMovie = async (animes, title) => {
    const result = await matchAniAndEp(null, null, null, { animes }, title, null, null, null, null, detailStore);
    return result.resAnime ? result.resAnime.animeId : null;
  };

  // 繁简与全半角/冒号写法差异不影响电影标题相等判定
  assert.equal(await matchMovie([traditional], '某电影'), 3001);
  assert.equal(await matchMovie([withColon], '某电影: 终章'), 3002);

  // 不同作品与续作编号仍视为不同作品
  assert.equal(await matchMovie([different], '某电影'), null);
  assert.equal(await matchMovie([sequel], '某电影'), null);
});
test('fallback matching prefers the candidate of the target season', async () => {
  Globals.init({ LOG_LEVEL: 'error' });

  const buildAnime = (animeId, animeTitle, aliases = []) => ({
    animeId,
    bangumiId: String(animeId),
    animeTitle,
    aliases,
    source: 'dandan',
    startDate: '2020-01-01T00:00:00.000Z',
    links: Array.from({ length: 12 }, (_, i) => ({ id: animeId * 100 + i + 1, title: `【测试源】 第${i + 1}话`, url: `test-${animeId}-${i + 1}` }))
  });

  const secondSeason = buildAnime(2001, '某测试动画 第二季(2023)【TV动画】from dandan');
  const thirdSeason = buildAnime(2002, '某测试动画 第三季(2026)【TV动画】from dandan');
  const thirdSeasonByAlias = buildAnime(2003, '某测试动画(2026)【TV动画】from dandan', ['某测试动画 第三季']);
  const detailStore = new Map([[2001, secondSeason], [2002, thirdSeason], [2003, thirdSeasonByAlias]]);

  const matchFallback = async (animes, season) => {
    const result = await fallbackMatchAniAndEp({ animes }, null, season, 12, null, '某测试动画', null, null, null, detailStore);
    return result.resAnime ? result.resAnime.animeId : null;
  };

  // 目标季优先于候选列表顺序
  assert.equal(await matchFallback([secondSeason, thirdSeason], 3), 2002);
  assert.equal(await matchFallback([thirdSeason, secondSeason], 3), 2002);
  assert.equal(await matchFallback([secondSeason, thirdSeason], 2), 2001);

  // 季号仅出现在别名中时同样参与优先判断
  assert.equal(await matchFallback([secondSeason, thirdSeasonByAlias], 3), 2003);

  // 无同季候选或未指定季号时保持原有取值顺序
  assert.equal(await matchFallback([secondSeason], 3), 2001);
  assert.equal(await matchFallback([secondSeason, thirdSeason], null), 2001);
});

test('episode-number deduplication prefers the requested platform', () => {
  const episodes = [
    { episodeId: 'imgo-1', episodeTitle: '【imgo】第1集 初遇' },
    { episodeId: 'qq-1', episodeTitle: '【qq】第1集 重逢' },
    { episodeId: 'qq-1-copy', episodeTitle: '【qq】第1集 重逢' },
    { episodeId: 'imgo-2', episodeTitle: '【imgo】第2集' }
  ];

  assert.deepEqual(
    filterSameEpisodeTitle(episodes).map(item => item.episodeId),
    ['imgo-1', 'imgo-2']
  );
  assert.deepEqual(
    filterSameEpisodeTitle(episodes, { preferredPlatform: 'qq' }).map(item => item.episodeId),
    ['qq-1', 'imgo-2']
  );
});

test('normal matching keeps the requested platform and exact episode', async () => {
  Globals.init({ REMEMBER_LAST_SELECT: 'false', LOG_LEVEL: 'error' });

  const anime = {
    animeId: 7781,
    bangumiId: '7781',
    animeTitle: '平台测试',
    source: '360',
    type: 'tvseries',
    episodeCount: 2,
    links: [
      { id: 11, title: '【imgo】 第1集', url: 'https://www.mgtv.com/b/test/1.html' },
      { id: 12, title: '【qq】 第1集', url: 'https://v.qq.com/x/cover/test/1.html' },
      { id: 13, title: '【qq】 第2集', url: 'https://v.qq.com/x/cover/test/2.html' }
    ]
  };

  const result = await matchAniAndEp(
    1,
    1,
    null,
    { animes: [anime] },
    '平台测试',
    new Request('http://localhost/api/v2/match'),
    'qq',
    null,
    null,
    new Map([['7781', anime]])
  );

  assert.equal(result.resAnime?.animeId, 7781);
  assert.equal(result.resEpisode?.episodeId, 12);
  assert.equal(result.resEpisode?.episodeTitle, '【qq】 第1集');
});

// 真实数据样本：腾讯《现在就出发 第4季》第5话，21 集里 11 集是「先导片」「加更」，过滤后剩 10 集正片
const episodeFilterSample = () => {
  const titles = [
    '第1期上：出发团变落汤鸡', '第1期下：目击狼人杀升级',
    '第2期上：腾腾公主飙戏', '第2期下：编瞎话大赏爆笑来袭',
    '第3期上：小白安宇笨狼合体', '第3期下：空降龙餐馆',
    '第4期上：现发KTV全员唱到发了狠', '第4期下：全员黑脸',
    '第5期上：沈腾踩着范丞丞起飞', '第5期下：沈腾满地滚',
    '先导片上：沈腾沙滩十八滚', '先导片下：贾冰爆炒沈腾',
    '第1期加更：王楚然猜词', '第1期还有加更：王安宇脑力下线',
    '第2期加更：沈腾胡先煦范丞丞', '第2期还有加更：沈腾陷入跳舞循环',
    '第3期加更：王安宇被打开心扉', '第3期还有加更：沈腾范丞丞炫酒瓶',
    '第4期加更：沈腾黄景瑜双簧帮唱', '第4期还有加更：白敬亭林一雷霆',
    '第5期加更：王楚然山东话表白',
  ];
  return {
    animeId: 6568352,
    bangumiId: 'mzc002001bk7moh',
    animeTitle: '现在就出发 第4季(2026)【综艺】',
    startDate: '2026-01-01T00:00:00Z',
    type: '综艺',
    typeDescription: '综艺',
    isFavorited: true,
    rating: 0,
    source: 'tencent',
    episodeCount: 21,
    links: titles.map((title, index) => ({ id: 41021 + index, title: `【qq】${title}`, url: `https://v.qq.com/x/cover/mzc002001bk7moh/ep${index + 1}.html` })),
  };
};

test('buildBangumiData 过滤开启时按过滤后的可用集数上报总集数', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const result = buildBangumiData(episodeFilterSample());

  assert.equal(result.bangumi.episodes.length, 10, '过滤后只剩 10 集正片');
  assert.equal(result.bangumi.seasons[0].episodeCount, 10, '总集数应与实际返回的集数一致');
});

test('buildBangumiData 过滤关闭时保持平台声明的总集数', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'false', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const result = buildBangumiData(episodeFilterSample());

  assert.equal(result.bangumi.episodes.length, 21, '未开启过滤时返回全部集数');
  assert.equal(result.bangumi.seasons[0].episodeCount, 21, '未开启过滤时保持平台声明值');
});

test('buildBangumiData 过滤开启时声明集数更小则以声明值为准', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  anime.episodeCount = 1;
  anime.links = anime.links.slice(0, 3);
  const result = buildBangumiData(anime);

  assert.equal(result.bangumi.seasons[0].episodeCount, 1, '声明值更小时以声明值为准');
});

test('resolveEpisodeCount 取声明值与可用集数中的较小值', () => {
  assert.equal(resolveEpisodeCount(21, 10), 10);
  assert.equal(resolveEpisodeCount(21, 21), 21);
  assert.equal(resolveEpisodeCount(1, 3), 1);
  assert.equal(resolveEpisodeCount(0, 5), 5);
  assert.equal(resolveEpisodeCount(21, 0), 21);
});

test('applyEpisodeTitleFilter 过滤剧集并把可用集数写回动漫', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  const episodes = applyEpisodeTitleFilter(anime, anime.links);

  assert.equal(episodes.length, 10, '过滤后只剩 10 集正片');
  assert.equal(anime.episodeCount, 10, '动漫的集数写回为过滤后的可用集数');
});

test('filterEpisodesByTitle 按集标题过滤剧集', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const episodes = [{ episodeTitle: '第1期上：正片' }, { episodeTitle: '第1期加更：加更' }, { episodeTitle: '先导片上：先导' }];
  const filtered = filterEpisodesByTitle(episodes);

  assert.deepStrictEqual(filtered.map(ep => ep.episodeTitle), ['第1期上：正片'], '加更与先导片按集标题过滤规则被剔除');
});

test('withAvailableEpisodeCount 为缓存命中的动漫上报过滤后的可用集数', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  const reported = withAvailableEpisodeCount([anime], () => ({ links: anime.links }));

  assert.strictEqual(reported.length, 1, '不改变动漫数量');
  assert.strictEqual(reported[0].episodeCount, 10, '缓存命中的动漫上报过滤后的可用集数');
  assert.strictEqual(anime.episodeCount, 21, '不改写缓存里的动漫对象');
});

test('withAvailableEpisodeCount 过滤关闭时保持平台声明的集数', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'false', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  const reported = withAvailableEpisodeCount([anime], () => ({ links: anime.links }));

  assert.strictEqual(reported[0].episodeCount, 21, '过滤关闭时保持平台声明值');
});

test('withAvailableEpisodeCount 不改写搜索缓存里的动漫对象', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  const detailsMap = new Map();
  setSearchCache('集过滤缓存用例', [anime], detailsMap);
  const cached = getSearchCache('集过滤缓存用例', detailsMap);
  assert.strictEqual(cached[0], anime, '搜索缓存返回的是缓存里的同一批对象');

  const reported = withAvailableEpisodeCount(cached, () => ({ links: anime.links }));

  assert.strictEqual(reported[0].episodeCount, 10, '上报的是过滤后的可用集数');
  assert.strictEqual(cached[0].episodeCount, 21, '缓存里的动漫对象不被改写');

  globals.searchCache.delete('集过滤缓存用例');
});

test('withAvailableEpisodeCount 返回的副本保留动漫的其余字段', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  const reported = withAvailableEpisodeCount([anime], () => ({ links: anime.links }));

  assert.notStrictEqual(reported[0], anime, '返回的是副本而不是原对象');
  assert.strictEqual(reported[0].animeId, anime.animeId);
  assert.strictEqual(reported[0].animeTitle, anime.animeTitle);
  assert.strictEqual(reported[0].source, anime.source);
});

test('withAvailableEpisodeCount 不改写收藏缓存的持久化内容', () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', BLOCKED_WORDS: '' });
  const anime = episodeFilterSample();
  addFavorite('集过滤收藏用例', [anime], []);
  const persistedBefore = JSON.stringify(saveFavorites());

  withAvailableEpisodeCount([anime], () => ({ links: anime.links }));

  assert.strictEqual(JSON.stringify(saveFavorites()), persistedBefore, '收藏缓存的持久化内容不被改写');

  removeFavorite('集过滤收藏用例');
});

test('回填可用集数后匹配到的剧集与平台声明集数时一致', async () => {
  Globals.init({ ENABLE_ANIME_EPISODE_FILTER: 'true', LOG_LEVEL: 'error' });
  const buildAnime = (episodeCount) => ({
    animeId: 4001,
    bangumiId: '4001',
    animeTitle: '某测试剧集(2026)【TV动画】from dandan',
    aliases: [],
    source: 'dandan',
    type: 'TV动画',
    typeDescription: 'TV动画',
    episodeCount,
    startDate: '2026-01-01T00:00:00.000Z',
    links: Array.from({ length: 10 }, (_, i) => ({ id: 40010 + i, title: `【测试源】 第${i + 1}话`, url: `test-${i + 1}` }))
  });
  const matchWith = async (anime) => {
    const detailStore = new Map([[4001, anime]]);
    const result = await matchAniAndEp(1, 3, 2026, { animes: [anime] }, '某测试剧集', null, null, null, null, detailStore);
    return { animeId: result.resAnime?.animeId, episodeId: result.resEpisode?.episodeId };
  };

  const withDeclaredCount = await matchWith(buildAnime(21));
  const withAvailableCount = await matchWith(buildAnime(10));

  assert.equal(withDeclaredCount.episodeId, 40012, '声明集数为 21 时匹配到第 3 话');
  assert.deepStrictEqual(withAvailableCount, withDeclaredCount, '可用集数为 10 时匹配结果不变');
});
