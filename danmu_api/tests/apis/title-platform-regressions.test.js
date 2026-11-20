import test from 'node:test';
import assert from 'node:assert/strict';
import { getBangumi, matchAnime, searchEpisodes } from '../../apis/dandan-api.js';
import { getFongmiDanmaku } from '../../apis/clients/fongmi-api.js';
import { Globals } from '../../configs/globals.js';
import { setSearchCache } from '../../utils/cache-util.js';
import { addFavorite } from '../../utils/favorite-util.js';
import AIClient from '../../utils/ai-util.js';
import VodSource from '../../sources/vod.js';
import { mockJsonResponse, withMockFetch } from '../helpers/context.js';
import { createFavoriteAnime, favoriteSearchResult, resetFavoriteState } from '../helpers/favorites.js';

function makeAnime(title, id, source, labels) {
  const anime = createFavoriteAnime(title, labels.length, id);
  anime.source = source;
  anime.links.forEach((link, index) => { link.title = labels[index]; });
  return anime;
}

function seed(title, records, rule, env = {}) {
  resetFavoriteState({ LOG_LEVEL: 'error', TITLE_PLATFORM_MAP: rule, PLATFORM_ORDER: '', AUTO_MATCH_MAPPING_TABLE: '', TITLE_MAPPING_TABLE: '', ...env });
  Globals.aiValid = false;
  const details = new Map(records.map(record => [String(record.animeId), record]));
  setSearchCache(title, records.map(favoriteSearchResult), details);
  return details;
}

async function match(fileName) {
  const request = new Request('http://localhost/api/v2/match', { method: 'POST', body: JSON.stringify({ fileName }) });
  return (await matchAnime(new URL(request.url), request, 'offline')).json();
}

async function searchEpisode(title, number) {
  const url = new URL('http://localhost/api/v2/search/episodes');
  url.searchParams.set('anime', title);
  url.searchParams.set('episode', number);
  return (await (await searchEpisodes(url)).json()).animes;
}

test('配置来源的聚合条目按标题里的集号查询，与同集来源是否发生重排无关', async () => {
  const labels = ['【qq】第1集', '【qiyi】第1集', '【imgo】第2集'];
  seed('宝珠', [makeAnime('宝珠', 914001, '360', labels)], '宝珠->imgo');
  assert.deepEqual((await searchEpisode('宝珠', 2))[0].episodes.map(item => item.episodeTitle), [labels[2]]);
  assert.deepEqual((await searchEpisode('宝珠', 1))[0].episodes.map(item => item.episodeTitle), labels.slice(0, 2));
  seed('宝珠', [makeAnime('宝珠', 914001, 'imgo', [labels[2]])], '宝珠->imgo');
  assert.deepEqual((await searchEpisode('宝珠', 2))[0].episodes.map(item => item.episodeTitle), [labels[2]]);
});

test('请求的季号可以对应同剧候选的裸数字后缀，但不会匹配其他季或外传', async () => {
  const labels = ['【qq】第1集', '【qq】第2集'];
  const sequel = makeAnime('庆余年2(2024)【电视剧】from tencent', 914002, 'tencent', labels);
  const unrelated = makeAnime('庆余年外传2(2024)【电视剧】from tencent', 914003, 'tencent', labels);
  seed('庆余年', [unrelated, sequel], '庆余年->qq');
  assert.equal((await match('庆余年 S02E01')).matches[0]?.animeId, sequel.animeId);
  assert.equal((await match('庆余年 S01E01')).isMatched, false);
  seed('庆余年', [unrelated], '庆余年->qq');
  assert.equal((await match('庆余年 S02E01')).isMatched, false);
});

test('分集搜索和独立详情对裸数字第二季使用同一规则和季内编号', async () => {
  const labels = ['【qq】第13集', '【imgo】第13集', '【qq】第14集', '【imgo】第14集'];
  const sequel = makeAnime('庆余年2(2024)【电视剧】from 示例采集站', 914130, '360', labels);
  const other = makeAnime('庆余年2(2024)【电视剧】from tencent', 914131, 'tencent', [labels[0], labels[2]]);
  const records = [other, sequel];
  const details = seed('庆余年', records, '庆余年->imgo');
  for (const title of ['庆余年2', '庆余年 第二季']) setSearchCache(title, records.map(favoriteSearchResult), details);
  for (const title of ['庆余年', '庆余年2', '庆余年 第二季']) {
    const results = await searchEpisode(title, 2);
    assert.equal(results[0]?.animeId, sequel.animeId, title);
    assert.deepEqual(results[0].episodes.map(ep => ep.episodeId), [sequel.links[3].id, sequel.links[2].id]);
  }
  const detail = (await (await getBangumi(`/bangumi/${sequel.animeId}`)).json()).bangumi;
  assert.deepEqual(detail.episodes.map(ep => [ep.episodeNumber, ep.episodeId]),
    [1, 0, 3, 2].map(index => [index < 2 ? '1' : '2', sequel.links[index].id]));
});

test('数字季名的完整规则优先，电影、年份、外传和其他季不继承该规则', async () => {
  const labels = ['【qq】第1集', '【imgo】第1集'];
  const create = (name, id) => makeAnime(name, id, '360', labels);
  const sequel = create('庆余年2', 914132);
  const first = create('庆余年', 914133);
  const third = create('庆余年3', 914134);
  const movie = { ...create('庆余年2', 914135), type: 'movie', typeDescription: '电影' };
  const others = ['庆余年外传2', '庆余年2024', '庆余年00'].map((name, index) => create(name, 914136 + index));
  const records = [first, third, movie, ...others, sequel];
  for (const [rule, expected] of [['庆余年->imgo', 1], ['庆余年->imgo;庆余年2->qq', 0]]) {
    const details = seed('庆余年2', records, rule);
    const result = await searchEpisode('庆余年2', 1);
    const ids = anime => result.find(item => item.animeId === anime.animeId).episodes.map(ep => ep.episodeId);
    assert.equal(ids(sequel)[0], sequel.links[expected].id);
    const detailOf = async anime => (await (await getBangumi(`/bangumi/${anime.animeId}`, details)).json()).bangumi.episodes;
    assert.equal((await detailOf(sequel))[0].episodeId, sequel.links[expected].id);
    for (const anime of [first, third, ...others]) assert.deepEqual(ids(anime), [anime.links[0].id]);
    if (expected === 1) {
      assert.deepEqual(ids(movie), [movie.links[0].id]);
      for (const anime of [movie, ...others]) assert.equal((await detailOf(anime))[0].episodeId, anime.links[0].id);
      setSearchCache('庆余年 第二季', records.map(favoriteSearchResult), details);
      const explicit = await searchEpisode('庆余年 第二季', 1);
      assert.deepEqual(explicit.find(anime => anime.animeId === movie.animeId).episodes.map(ep => ep.episodeId), [movie.links[0].id]);
    }
  }
});

test('整剧标签相同时，按本集实际来源选择完整合并弹幕', async () => {
  const title = '宝珠(2024)【电视剧】from dandan&bilibili';
  const partial = makeAnime(title, 914004, 'dandan', ['【dandan&bilibili】第1集', '【dandan】第2集']);
  const full = makeAnime(title, 914005, 'dandan', ['【dandan】第1集', '【dandan&bilibili】第2集']);
  seed('宝珠', [partial, full], '宝珠->dandan&bilibili1');
  for (const [number, expected] of [[1, partial], [2, full]]) {
    assert.equal((await match(`宝珠 S01E0${number}`)).matches[0]?.animeId, expected.animeId);
    assert.equal((await searchEpisode('宝珠', number))[0]?.animeId, expected.animeId);
  }
  seed('宝珠', [partial, full], '', { PLATFORM_ORDER: 'dandan&bilibili1' });
  assert.equal((await match('宝珠 S01E02')).matches[0]?.animeId, partial.animeId);
  const untagged = makeAnime(title, 914008, 'dandan', ['第1集', '第2集']);
  seed('宝珠', [partial, untagged], '宝珠->dandan&bilibili1');
  assert.equal((await match('宝珠 S01E02')).matches[0]?.animeId, untagged.animeId);
});

test('外语名翻译后仍按播放器原名查规则，译名本身的规则不会被继承', async () => {
  const qq = makeAnime('示例剧', 914006, 'tencent', ['【qq】第1集', '【qq】第2集']);
  const mango = makeAnime('示例剧', 914007, 'imgo', ['【imgo】第1集', '【imgo】第2集']);
  await withMockFetch(async url => {
    assert.match(String(url), /\/search\/tv/);
    return mockJsonResponse({ results: [{ id: 17, original_name: 'Example Series', name: '示例剧' }] }, '');
  }, async () => {
    for (const [rule, expected] of [['Example Series->imgo', mango], ['示例剧->imgo', qq]]) {
      seed('示例剧', [qq, mango], rule, { TITLE_TO_CHINESE: 'true', USE_BANGUMI_DATA: 'false', TMDB_API_KEY: 'offline-placeholder' });
      assert.equal((await match('Example Series S01E01')).matches[0]?.animeId, expected.animeId);
    }
  });
});

test('指定平台缺集时先找其他平台的准确集号，而非按首选列表的位置取集', async () => {
  const mango = makeAnime('宝珠', 914010, 'imgo', ['【imgo】第1集', '【imgo】第3集', '【imgo】第4集']);
  const qq = makeAnime('宝珠', 914011, 'tencent', ['【qq】第1集', '【qq】第2集']);
  for (const preferred of [mango, makeAnime('宝珠', 914012, 'imgo', ['【imgo】上篇', '【imgo】下篇'])]) {
    seed('宝珠', [preferred, qq], '宝珠->imgo');
    assert.equal((await match('宝珠 S01E02')).matches[0]?.episodeTitle, '【qq】第2集');
  }
  seed('宝珠', [mango], '宝珠->imgo');
  assert.equal((await match('宝珠 S01E02')).isMatched, false);
});

test('分集搜索使用综艺期号，无期号的日期标题保留原编号', async () => {
  const labels = ['【qq】 第1期 20240501', '【qq】 第2期 20240508', '【qq】 20240515', '【qq】 第20240522期'];
  seed('综艺甲', [makeAnime('综艺甲', 914013, 'tencent', labels)], '综艺甲->qq');
  for (const [index, label] of labels.entries()) {
    assert.deepEqual((await searchEpisode('综艺甲', index + 1)).flatMap(anime => anime.episodes.map(ep => ep.episodeTitle)), [label]);
  }
});

test('同剧裸季号仅在跨季顺延时参与，不会提前匹配下一季或外传', async () => {
  const labels = ['【qq】第1集', '【qq】第2集'];
  const first = makeAnime('庆余年(2019)【电视剧】from tencent', 914014, 'tencent', labels);
  const second = makeAnime('庆余年2(2024)【电视剧】from tencent', 914015, 'tencent', [...labels, '【qq】第3集']);
  const other = makeAnime('庆余年外传2(2024)【电视剧】from tencent', 914016, 'tencent', labels);
  for (const [records, expected] of [[[first, other, second], second], [[first, other], null]]) {
    seed('庆余年', records, '庆余年->qq');
    addFavorite('庆余年_S1', records.map(favoriteSearchResult), records);
    const result = await match('庆余年 S01E03');
    assert.equal(result.matches[0]?.episodeId, expected?.links[0].id);
    assert.equal((await match('庆余年 S01E01')).matches[0]?.animeId, first.animeId);
  }
  const sparse = makeAnime(second.animeTitle, 914022, 'tencent', ['【qq】第1集', '【qq】第3集', '【qq】第4集']);
  const continuous = makeAnime(second.animeTitle, 914023, 'tencent', ['【qq】第3集', '【qq】第4集']);
  for (const [nextSeason, expected] of [[sparse, undefined], [continuous, continuous.links[1].id]]) {
    const records = [first, nextSeason];
    seed('庆余年', records, '庆余年->qq');
    addFavorite('庆余年_S1', records.map(favoriteSearchResult), records);
    assert.equal((await match('庆余年 S01E04')).matches[0]?.episodeId, expected);
  }
});

test('VOD 未提供年份时仍能识别剧名，但不删除剧名本身的括号', async () => {
  seed('甲剧', [], '甲剧->qq', { VOD_ALLOWED_PLATFORMS: 'qq' });
  const records = [];
  const details = new Map();
  await new VodSource().handleAnimes(['甲剧(外传)', '甲剧'].map((name, index) => ({
    vod_name: name, vod_id: 914017 + index, vod_year: '', type_name: '电视剧', vod_play_from: 'qq',
    vod_play_url: '第1集$https://v.qq.com/1#第2集$https://v.qq.com/2'
  })), '甲剧', records, '示例采集站', details);
  setSearchCache('甲剧', records, details);
  assert.equal((await match('甲剧 S01E01')).matches[0]?.animeTitle, '甲剧()【电视剧】from 示例采集站');
});

test('电影在普通和 AI 匹配中都按实际链接选最优单源或合并源', async context => {
  const ask = context.mock.method(AIClient.prototype, 'ask', async () => '{"animeIndex":0}');
  for (const [rule, labels, expected] of [
    ['示例电影->dandan&bilibili1', ['【dandan】正片', '【dandan&bilibili】正片'], 1],
    ['示例电影->imgo', ['【qq】正片', '【imgo】正片'], 1],
    ['宝珠->imgo', ['【qq】正片', '【imgo】正片'], 0]
  ]) {
    const movie = { ...makeAnime('示例电影(2024)【电影】from vod', 914019, 'vod', labels), type: 'movie', typeDescription: '电影' };
    for (const ai of [false, true]) {
      seed('示例电影', [movie], rule);
      Globals.aiValid = ai;
      Globals.aiMatchPrompt = '选择影片';
      assert.equal((await match('示例电影')).matches[0]?.episodeTitle, labels[expected]);
    }
  }
  assert.equal(ask.mock.callCount(), 3);
});

test('配置宝珠不会改变另一部剧的匹配结果或分集顺序', async () => {
  const qq = makeAnime('另一部剧', 914020, 'tencent', ['【qq】第1集', '【qq】第2集']);
  const mango = makeAnime('另一部剧', 914021, 'imgo', ['【imgo】第1集', '【imgo】第2集']);
  const results = [];
  for (const rule of ['', '宝珠->imgo']) {
    seed('另一部剧', [qq, mango], rule);
    results.push([(await match('另一部剧 S01E02')).matches, await searchEpisode('另一部剧', 2)]);
  }
  assert.equal(results[0][0][0].episodeTitle, '【qq】第2集');
  assert.deepEqual(results[1], results[0]);
});

test('跨季顺延按来源自己的编号匹配，季内号和全剧号同时存在也不会错集', async () => {
  const season = (name, id, platform, numbers) => makeAnime(name, id, platform, numbers.map(number => `【${platform}】第${number}集`));
  const first = season('庆余年', 914030, 'qq', [1, 2]);
  const continuous = season('庆余年2', 914031, 'qq', [3, 4, 5, 6, 7, 8]);
  const restarted = season('庆余年2', 914032, 'imgo', [1, 2, 3, 4, 5, 6]);
  const aggregate = makeAnime('庆余年2', 914037, '360', [...restarted.links, ...continuous.links].map(link => link.title));
  for (const [platform, expected] of [['qq', continuous], ['imgo', restarted]]) {
    for (const records of [[first, restarted, continuous], [first, aggregate]]) {
      seed('庆余年', records, `庆余年->${platform}`);
      addFavorite('庆余年_S1', records.map(favoriteSearchResult), records);
      for (const absolute of [5, 6]) {
        assert.equal((await match(`庆余年 S01E0${absolute}`)).matches[0]?.episodeTitle, expected.links[absolute - 3].title);
      }
    }
  }
  const sparse = season('庆余年2', 914033, 'qq', [3, 4, 6, 7, 8]);
  const records = [first, sparse];
  seed('庆余年', records, '庆余年->qq');
  addFavorite('庆余年_S1', records.map(favoriteSearchResult), records);
  assert.equal((await match('庆余年 S01E05')).isMatched, false);
});

test('综艺的上中下是独立分集，仅在同一半期的来源之间择优', async () => {
  const parts = ['第1期上', '第1期下', '第2期上', '第2期下'];
  const mango = parts.map(label => `【imgo】${label}`);
  for (const labels of [mango, [...parts.map(label => `【qq】${label}`), ...mango]]) {
    seed('综艺甲', [makeAnime('综艺甲', 914034, 'imgo', labels)], '综艺甲->imgo');
    for (const [index, label] of mango.entries()) {
      assert.equal((await match(`综艺甲 S01E0${index + 1}`)).matches[0]?.episodeTitle, label);
      assert.equal((await searchEpisode('综艺甲', index + 1))[0]?.episodes[0]?.episodeTitle, label);
    }
  }
  const mixed = ['【imgo】第1期', '【imgo】第2期：周末（上）', '【imgo】第2期：周末（中）', '【imgo】第2期：周末（下）', '【imgo】第3期'];
  seed('综艺甲', [makeAnime('综艺甲', 914035, 'imgo', mixed)], '综艺甲->imgo');
  for (const [index, label] of mixed.entries()) {
    assert.equal((await match(`综艺甲 S01E0${index + 1}`)).matches[0]?.episodeTitle, label);
  }
});

test('无数字的同名分集共享编号，详情、分集搜索和匹配使用同一来源顺序', async () => {
  const labels = ['【qq】序章', '【qq】终章', '【imgo】序章', '【imgo】终章'];
  for (const links of [labels, [labels[0], labels[1], labels[3]]]) {
    const record = makeAnime('甲剧', 914036, '360', links);
    const details = seed('甲剧', [record], '甲剧->imgo');
    const detail = (await (await getBangumi('/bangumi/914036', details)).json()).bangumi;
    for (const [index, name] of ['序章', '终章'].entries()) {
      const expected = [`【imgo】${name}`, `【qq】${name}`].filter(label => links.includes(label));
      assert.deepEqual(detail.episodes.filter(ep => ep.episodeNumber === String(index + 1)).map(ep => ep.episodeTitle), expected);
      assert.deepEqual((await searchEpisode('甲剧', index + 1))[0]?.episodes.map(ep => ep.episodeTitle), expected);
      assert.equal((await match(`甲剧 S01E0${index + 1}`)).matches[0]?.episodeTitle, expected[0]);
    }
  }
  const repeated = makeAnime('甲剧', 914038, '360', ['【qq】正片', '【qq】正片', '【imgo】正片', '【imgo】正片']);
  seed('甲剧', [repeated], '甲剧->imgo');
  assert.equal((await match('甲剧 S01E02')).matches[0]?.episodeId, repeated.links[3].id);
  assert.deepEqual((await searchEpisode('甲剧', 2))[0]?.episodes.map(ep => ep.episodeId), [repeated.links[3].id, repeated.links[1].id]);
});

test('VOD 先列残缺来源时，其他来源的有序集名仍能对齐到同一集', async () => {
  const compare = async (titles, rule, expected) => {
    seed('甲剧', [], rule, { PLATFORM_ORDER: 'imgo' });
    const records = [];
    const details = new Map();
    await new VodSource().handleAnimes([{
      vod_id: 914040, vod_name: '甲剧', vod_year: '2024', type_name: '电视剧', vod_play_from: ['qq', 'mgtv', 'youku'].slice(0, titles.length).join('$$$'),
      vod_play_url: titles.map((episodes, source) => episodes.map((name, index) => `${name}$https://example.test/${source}/${index}`).join('#')).join('$$$')
    }], '甲剧', records, '示例采集站', details);
    setSearchCache('甲剧', records, details);
    const detail = (await (await getBangumi('/bangumi/914040', details)).json()).bangumi;
    for (const [index, title] of expected.entries()) {
      assert.equal((await match(`甲剧 S01E0${index + 1}`)).matches[0]?.episodeTitle, title);
      if (!rule) continue;
      assert.equal((await searchEpisode('甲剧', index + 1))[0]?.episodes[0]?.episodeTitle, title);
      assert.equal(detail.episodes.find(ep => Number(ep.episodeNumber) === index + 1)?.episodeTitle, title);
    }
    if (rule) assert.equal(detail.episodes[0]?.episodeTitle, expected[0]);
  };
  for (const rule of ['', '甲剧->imgo']) {
    await compare([['终章'], ['序章', '终章']], rule, ['【imgo】 序章', '【imgo】 终章']);
  }
  await compare([['中篇', '终章'], ['序章', '中篇']], '甲剧->imgo', ['【imgo】 序章', '【imgo】 中篇', '【qq】 终章']);
  await compare([['下篇', '终章'], ['序章', '中篇'], ['中篇', '下篇']], '甲剧->imgo', ['【imgo】 序章', '【imgo】 中篇', '【qq】 下篇', '【qq】 终章']);
  const repeated = [['幕间', '正片', '终章'], ['序章', '正片', '幕间', '正片', '终章']];
  await compare(repeated, '甲剧->imgo', repeated[1].map(name => `【imgo】 ${name}`));
  for (const index of [1, 3]) {
    assert.equal((await match(`甲剧 S01E0${index + 1}`)).matches[0]?.url, `https://example.test/1/${index}`);
  }
  await compare(repeated, '甲剧->qq', ['【imgo】 序章', '【imgo】 正片', '【qq】 幕间', '【qq】 正片', '【qq】 终章']);
  assert.deepEqual((await searchEpisode('甲剧', 4))[0].episodes.map(ep => ep.episodeTitle), ['【qq】 正片', '【imgo】 正片']);
});

test('无 TMDB 边界时，同一季的不同来源编号只计算一次季长', async () => {
  const labels = (platform, numbers) => numbers.map(number => `【${platform}】第${number}集`);
  const first = makeAnime('庆余年', 914041, 'tencent', labels('qq', [1, 2]));
  const third = makeAnime('庆余年3', 914043, 'tencent', labels('qq', [1, 2, 3]));
  const continuous = labels('qq', [3, 4, 5, 6, 7, 8]);
  const relative = labels('imgo', [1, 2, 3, 4, 5, 6]);
  for (const links of [continuous, [...relative, ...continuous], [...continuous, ...relative], [...relative.slice(0, 3), ...continuous.slice(3)], continuous.filter((_, index) => index !== 2)]) {
    const second = makeAnime('庆余年2', 914042, '360', links);
    const records = [first, second, third];
    seed('庆余年', records, '庆余年->qq', { USE_BANGUMI_DATA: 'false' });
    addFavorite('庆余年_S1', records.map(favoriteSearchResult), records);
    for (const [index, link] of third.links.entries()) {
      assert.equal((await match(`庆余年 S01E${String(9 + index).padStart(2, '0')}`)).matches[0]?.episodeId, link.id);
    }
  }
});

function numberedSeason(title, id, start, length) {
  return makeAnime(title, id, 'tencent', Array.from({ length }, (_, index) => `【qq】第${start + index}集`));
}

function seedSeasonMatch(records, rule) {
  seed('甲剧', records, rule, { USE_BANGUMI_DATA: 'false' });
  for (const season of [1, 2]) addFavorite(`甲剧_S${season}`, records.map(favoriteSearchResult), records);
}

test('直接播放第二季与从第一季顺延，按相同的季内集号选择来源', async context => {
  const ask = context.mock.method(AIClient.prototype, 'ask', async () => '{"animeIndex":0}');
  const first = numberedSeason('甲剧 第一季', 914061, 1, 2);
  const qq = numberedSeason('甲剧 第二季', 914062, 3, 6).links.map(link => link.title);
  const mango = qq.map((_, index) => `【imgo】第${index + 1}集`);
  for (const ai of [false, true]) {
    for (const labels of [[...qq, ...mango], [...mango, ...qq], [...mango, ...qq.filter(title => title !== qq[2])]]) {
      const second = makeAnime('甲剧 第二季', 914063, '360', labels);
      seedSeasonMatch([first, second], '甲剧->qq');
      Globals.aiValid = ai;
      Globals.aiMatchPrompt = '选择剧集';
      for (const number of [3, 1, 6]) {
        const expected = second.links.find(link => link.title === qq[number - 1]) ?? second.links.find(link => link.title === mango[number - 1]);
        for (const file of [`S02E0${number}`, `S01E0${2 + number}`]) {
          assert.equal((await match(`甲剧 ${file}`)).matches[0]?.episodeId, expected.id, `${file} 应为 ${expected.title}`);
        }
      }
      assert.equal((await match('甲剧 S02E07')).isMatched, false);
    }
  }
  assert.ok(ask.mock.callCount() > 0);
});

test('没有第一季和 TMDB 边界时，保留连续全剧编号的本季匹配和顺延，不填补缺集', async () => {
  const second = numberedSeason('甲剧 第二季', 914064, 13, 4);
  const third = numberedSeason('甲剧 第三季', 914065, 1, 3);
  for (const rule of ['', '另一部剧->qq', '甲剧->qq']) {
    seedSeasonMatch([second, third], rule);
    for (const [number, expected] of [[1, second.links[0]], [4, second.links[3]], [5, third.links[0]], [7, third.links[2]]]) {
      assert.equal((await match(`甲剧 S02E0${number}`)).matches[0]?.episodeId, expected.id);
    }
  }
  const thirdContinuous = numberedSeason('甲剧 第三季', 914067, 17, 3);
  seedSeasonMatch([thirdContinuous, second], '甲剧->qq');
  assert.equal((await match('甲剧 S02E06')).matches[0]?.episodeId, thirdContinuous.links[1].id);
  for (const numbers of [[2, 4], [2, 3, 4], [13, 15, 16], [13]]) {
    const sparse = makeAnime('甲剧 第二季', 914066, 'tencent', numbers.map(number => `【qq】第${number}集`));
    seedSeasonMatch([sparse, third], '甲剧->qq');
    assert.equal((await match('甲剧 S02E01')).isMatched, false);
  }
  const partial = makeAnime('甲剧 第二季', 914068, 'imgo', Array.from({ length: 12 }, (_, index) => `【imgo】第${index + 1}集`));
  seedSeasonMatch([second, partial], '甲剧->qq');
  assert.equal((await match('甲剧 S02E01')).matches[0]?.episodeId, partial.links[0].id);
  assert.equal((await match('甲剧 S02E13')).matches[0]?.episodeId, second.links[0].id);
});

test('请求第二季时，裸剧名的第一季不能截走跨季匹配', async () => {
  const first = numberedSeason('甲剧', 914051, 1, 12);
  const second = numberedSeason('甲剧 第二季', 914052, 1, 4);
  const third = numberedSeason('甲剧 第三季', 914053, 1, 3);
  for (const [records, expected] of [[[first, second, third], third.links[0].id], [[first, second], undefined]]) {
    seed('甲剧', records, '甲剧->qq');
    addFavorite('甲剧_S2', records.map(favoriteSearchResult), records);
    assert.equal((await match('甲剧 S02E05')).matches[0]?.episodeId, expected);
    assert.equal((await match('甲剧 S02E01')).matches[0]?.episodeId, second.links[0].id);
  }
});

test('从第二季开始顺延时，全剧集号扣除之前的季长', async () => {
  const first = numberedSeason('甲剧 第一季', 914054, 1, 12);
  const second = numberedSeason('甲剧 第二季', 914055, 13, 4);
  for (const start of [1, 17]) {
    const third = numberedSeason('甲剧 第三季', 914056, start, 3);
    const records = [first, second, third];
    seed('甲剧', records, '甲剧->qq', { USE_BANGUMI_DATA: 'false' });
    addFavorite('甲剧_S2', records.map(favoriteSearchResult), records);
    for (const [number, expected] of [[5, third.links[0]], [6, third.links[1]], [1, second.links[0]], [4, second.links[3]]]) {
      assert.equal((await match(`甲剧 S02E0${number}`)).matches[0]?.episodeId, expected.id);
    }
  }
});

test('显式 S02E03 不扣前季长度，首选源缺集时只回退到同一集', async () => {
  const first = numberedSeason('甲剧 第一季', 914071, 1, 2);
  const qq = [3, 4, 5, 6].map(number => `【qq】S02E0${number}`);
  const mango = Array.from({ length: 6 }, (_, index) => `【imgo】第${index + 1}集`);
  for (const labels of [[...qq, ...mango], [...mango, ...qq], qq]) {
    const second = makeAnime('甲剧 第二季', 914072, '360', labels);
    seedSeasonMatch([first, second], '甲剧->qq');
    for (const number of [1, 2, 3, 6]) {
      const expected = second.links.find(link => link.title === (number < 3 ? mango[number - 1] : qq[number - 3]));
      for (const request of [`S02E0${number}`, `S01E0${number + 2}`]) {
        assert.equal((await match(`甲剧 ${request}`)).matches[0]?.episodeId, expected?.id, request);
      }
    }
  }
});

test('自动匹配、分集搜索与独立详情返回相同的季内编号及链接，保留源站标题', async () => {
  const title = '甲剧 第二季';
  const first = numberedSeason('甲剧 第一季', 914073, 1, 2);
  for (const [previous, numbers, offset] of [[[], [13, 14, 15, 16], 12], [[first], [3, 4, 6], 2], [[], [13, 15], 0]]) {
    const second = makeAnime(title, 914074, 'tencent', numbers.map(number => `【qq】第${number}集`));
    const records = [...previous, second];
    seed('甲剧', records, '甲剧->qq', { USE_BANGUMI_DATA: 'false' });
    setSearchCache(title, [favoriteSearchResult(second)], new Map([[String(second.animeId), second]]));
    const detail = (await (await getBangumi(`/bangumi/${second.animeId}`)).json()).bangumi;
    assert.deepEqual(detail.episodes.map(ep => [Number(ep.episodeNumber), ep.episodeTitle, ep.episodeId]),
      second.links.map((link, index) => [numbers[index] - offset, link.title, link.id]));
    for (const [index, number] of numbers.entries()) {
      const episode = number - offset;
      assert.equal((await match(`甲剧 S02E${String(episode).padStart(2, '0')}`)).matches[0]?.episodeId, second.links[index].id);
      const result = (await searchEpisode(title, episode)).find(anime => anime.animeId === second.animeId);
      assert.deepEqual(result?.episodes.map(ep => ep.episodeId), [second.links[index].id]);
    }
    if (!numbers.includes(3 + offset)) assert.deepEqual(await searchEpisode(title, 3), []);
  }
});

test('没有前季资料时，显式季集号也不作为推算全剧偏移的依据', async () => {
  const title = '甲剧 第二季';
  const labels = ['【qq】S02E13', '【qq】s02e14', '【qq】第二季 第15集', '【qq】S02E16'];
  const second = makeAnime(title, 914075, 'tencent', labels);
  seedSeasonMatch([second], '甲剧->qq');
  assert.equal((await match('甲剧 S02E01')).isMatched, false);
  assert.deepEqual(await searchEpisode(title, 1), []);
  const detail = (await (await getBangumi(`/bangumi/${second.animeId}`)).json()).bangumi;
  assert.deepEqual(detail.episodes.map(ep => ep.episodeNumber), ['13', '14', '15', '16']);
  for (const [index, link] of second.links.entries()) {
    assert.equal((await match(`甲剧 S02E${13 + index}`)).matches[0]?.episodeId, link.id);
    assert.equal((await searchEpisode(title, 13 + index))[0]?.episodes[0]?.episodeId, link.id);
  }
});

test('同剧缓存只补充季长，不把当前结果之外的链接匹配给播放器', async () => {
  const first = numberedSeason('甲剧 第一季', 914076, 1, 2);
  const second = makeAnime('甲剧 第二季', 914077, 'tencent', ['【qq】第3集', '【qq】第5集']);
  const third = numberedSeason('甲剧 第三季', 914078, 1, 2);
  seed('甲剧', [first, second, third], '甲剧->qq', { USE_BANGUMI_DATA: 'false' });
  addFavorite('甲剧_S2', [favoriteSearchResult(second)], [second]);
  assert.equal((await match('甲剧 S02E01')).matches[0]?.episodeId, second.links[0].id);
  assert.equal((await match('甲剧 S02E02')).isMatched, false);
  assert.equal((await match('甲剧 S02E04')).isMatched, false);
});

test('前季只搜到残缺片单时，用缓存补足季长，但不返回缓存独有的集', async () => {
  const partial = numberedSeason('甲剧 第一季', 914080, 1, 2);
  const full = makeAnime('甲剧 第一季', 914082, 'imgo', Array.from({ length: 12 }, (_, index) => `【imgo】第${index + 1}集`));
  const second = numberedSeason('甲剧 第二季', 914084, 13, 4);
  seed('甲剧', [partial, full, second], '甲剧->qq', { USE_BANGUMI_DATA: 'false' });
  const current = [partial, second];
  for (const season of [1, 2]) addFavorite(`甲剧_S${season}`, current.map(favoriteSearchResult), current);
  const detail = (await (await getBangumi(`/bangumi/${second.animeId}`)).json()).bangumi;
  assert.equal(detail.episodes[0].episodeNumber, '1');
  assert.equal((await match('甲剧 S02E01')).matches[0]?.episodeId, detail.episodes[0].episodeId);
  assert.equal((await match('甲剧 S02E11')).isMatched, false);
  assert.equal((await match('甲剧 S01E13')).matches[0]?.episodeId, second.links[0].id);
  assert.equal((await match('甲剧 S01E03')).isMatched, false);
});

async function firstFongmiEpisode(episode, title = '甲剧') {
  const url = new URL('http://localhost/danmaku');
  url.searchParams.set('name', title);
  url.searchParams.set('episode', episode);
  const [first] = await (await getFongmiDanmaku(url, new Request(url))).json();
  return first && Number(new URL(first.url).pathname.split('/').pop());
}

async function seedVarietyIssues(start, rule) {
  const title = '综艺甲第二季';
  const details = seed('综艺甲', [], rule, { VOD_ALLOWED_PLATFORMS: 'qq' });
  const records = [];
  await new VodSource().handleAnimes([{
    vod_id: 914120, vod_name: title, vod_year: '2024', type_name: '综艺', vod_play_from: 'qq',
    vod_play_url: Array.from({ length: 4 }, (_, index) => `第${start + index}期$https://example.test/qq/${start + index}`).join('#')
  }], '综艺甲', records, '示例采集站', details);
  for (const keyword of ['综艺甲', title]) setSearchCache(keyword, records, details);
  const [show] = details.values();
  return show.links;
}

test('FongMi 按基础剧名请求第3期不会把第二季过滤掉', async () => {
  for (const rule of ['', '综艺甲->qq']) {
    const links = await seedVarietyIssues(1, rule);
    for (const target of ['第3期', '第二季第3期', 'S02E03']) {
      assert.equal(await firstFongmiEpisode(target, '综艺甲'), links[2].id, target);
    }
  }
});

test('FongMi 累计期号可按原名第14期点播，也可按季内第2期点播', async () => {
  for (const rule of ['', '综艺甲->qq']) {
    const links = await seedVarietyIssues(13, rule);
    for (const target of ['第14期', '第2期', 'S02E02']) {
      assert.equal(await firstFongmiEpisode(target, '综艺甲第二季'), links[1].id, target);
    }
  }
});

test('同一条目的不同快照都可补季长，收藏匹配不返回新快照独有的链接', async () => {
  const partial = numberedSeason('甲剧 第一季', 914100, 1, 2);
  const full = numberedSeason(partial.animeTitle, partial.animeId, 1, 12);
  const second = numberedSeason('甲剧第二季', 914110, 13, 4);
  seedSeasonMatch([partial, second], '甲剧->qq');
  setSearchCache('甲剧 新片单', [full, second].map(favoriteSearchResult), new Map([[full.animeId, full], [second.animeId, second]]));
  assert.equal((await match('甲剧 S02E01')).matches[0]?.episodeId, second.links[0].id);
  assert.equal((await match('甲剧 S02E11')).isMatched, false);
  assert.equal((await match('甲剧 S01E03')).isMatched, false);
  assert.equal((await match('甲剧 S01E13')).matches[0]?.episodeId, second.links[0].id);
  const detail = (await (await getBangumi(`/bangumi/${second.animeId}`)).json()).bangumi;
  assert.deepEqual(detail.episodes.map(ep => [ep.episodeNumber, ep.episodeId]), second.links.map((link, index) => [String(index + 1), link.id]));
});

test('FongMi 只在季内号不存在时按唯一的源站原集名回退', async () => {
  const second = numberedSeason('甲剧第二季', 914112, 13, 4);
  seed(second.animeTitle, [second], '甲剧->qq');
  for (const [index, link] of second.links.entries()) {
    for (const target of [`S02E0${index + 1}`, `第${index + 1}集`, `第${13 + index}集`, link.title]) {
      assert.equal(await firstFongmiEpisode(target, second.animeTitle), link.id, target);
    }
  }
  for (const target of ['S02E14', '第14集预告', '第14集（预告）']) {
    assert.notEqual(await firstFongmiEpisode(target, second.animeTitle), second.links[1].id, target);
  }
  const fourth = numberedSeason('甲剧第四季', 914114, 12, 4);
  seed('甲剧', [second, fourth], '甲剧->qq');
  assert.equal(await firstFongmiEpisode('第14集'), second.links[0].id);
});

test('FongMi 合并片单也能用非首选链接的原集名定位，再返回同集首选来源', async () => {
  const first = numberedSeason('甲剧第一季', 914116, 1, 12);
  const second = makeAnime('甲剧第二季', 914118, '360', ['【imgo】第1集', '【imgo】第2集', '【qq】第13集', '【qq】第14集']);
  seed('甲剧', [first, second], '甲剧->imgo');
  setSearchCache(second.animeTitle, [favoriteSearchResult(second)], new Map([[second.animeId, second]]));
  assert.equal(await firstFongmiEpisode('第14集', second.animeTitle), second.links[1].id);
});

test('FongMi 首条与自动匹配指向同一集，兼容仅有全剧编号的第二季', async () => {
  const second = numberedSeason('甲剧 第二季', 914086, 13, 4);
  for (const rule of ['', '乙剧->qq', '甲剧->qq']) {
    seedSeasonMatch([second], rule);
    for (const [index, link] of second.links.entries()) {
      const episode = `S02E0${index + 1}`;
      assert.equal((await match(`甲剧 ${episode}`)).matches[0]?.episodeId, link.id);
      assert.equal(await firstFongmiEpisode(episode), link.id, `${rule} ${episode}`);
    }
  }
});

test('FongMi 不按重叠的原始集号去重或抢排，首选缺集时回退到同集', async () => {
  const first = numberedSeason('甲剧 第一季', 914088, 1, 2);
  const qq = ['【qq】第3集', '【qq】第5集', '【qq】第6集'];
  const mango = ['【imgo】第1集', '【imgo】第2集', '【imgo】第3集', '【imgo】第4集'];
  for (const labels of [[...mango, ...qq], [...qq, ...mango]]) {
    const second = makeAnime('甲剧第二季', 914090, '360', labels);
    seedSeasonMatch([first, second], '甲剧->qq');
    setSearchCache(second.animeTitle, [favoriteSearchResult(second)], new Map([[String(second.animeId), second]]));
    for (const [index, title] of [qq[0], mango[1], qq[1], qq[2]].entries()) {
      const expected = second.links.find(link => link.title === title).id;
      assert.equal(await firstFongmiEpisode(`S02E0${index + 1}`), expected, title);
      assert.equal(await firstFongmiEpisode(`甲剧 2024 S02E0${index + 1}`), expected, title);
      assert.equal(await firstFongmiEpisode(`第${index + 1}集`, second.animeTitle), expected, title);
    }
  }
});
