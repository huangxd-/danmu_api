import { resolveSegmentCacheKey } from './apis/comment-api.js';
import { BLOCKED_WORD_PRESETS } from './utils/blocked-word-presets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { shouldBlockDomesticCelebrities, splitPersonFilterExcludedTitles, getCurrentWorkFilterTitles } from './utils/person-filter-exclusion-util.js';
import { applyRemoteTitleMappingText, resolveLocalTitleMapping } from './utils/title-mapping-url-util.js';
import { getComment, getCommentByUrl, getSegmentComment } from './apis/player-api.js';
import { getSourceByKey } from './sources/registry.js';
import { convertToDanmakuJson, filterDanmusByBlockedNames, filterDanmusByBlockedWords } from './utils/danmu-util.js';
import { setCommentCache } from './utils/cache-util.js';
import { previewJsContent } from './ui/js/preview.js';
import { cachedPersonSource, personCacheIdentity } from './utils/person-source-cache.js';
import { splitBlockedWords, serializeBlockedWords } from './utils/blocked-word-parser.js';

const enabled = { BLOCK_DOMESTIC_CELEBRITIES: 'true', PERSON_FILTER_EXCLUDED_TITLES: '诛仙4' };

test('逐条编辑的共享分隔逻辑保留长正则、量词逗号与转义斜杠，重新保存仍为同一组规则', () => {
  const rules = ['打卡', '/a{1,3}/u', '/a\\/b,c/i', '/[a,/]/u', '前排', '来了',
    ...BLOCKED_WORD_PRESETS.regions, ...BLOCKED_WORD_PRESETS.dates];
  const parsed = splitBlockedWords(rules.join(','));
  assert.deepEqual(parsed, rules);
  assert.deepEqual(splitBlockedWords(serializeBlockedWords(parsed)), rules);
  assert.equal(serializeBlockedWords([]), '');
  assert.throws(() => serializeBlockedWords(['/bad', '/good/u']), /无法准确分隔/);
  assert.deepEqual(splitBlockedWords('打卡， /签到|报到/u, 前排'), ['打卡', '/签到|报到/u', '前排']);
  assert.deepEqual(splitBlockedWords(''), []);
});

test('屏蔽词支持普通词和正则过滤', () => {
  try {
    Globals.init({ BLOCKED_WORDS: '打卡,/签到|报到/u', LOG_LEVEL: 'error' });
    assert.deepEqual(filterDanmusByBlockedWords(['打卡了', '深圳报到', '剧情很好看'].map(m => ({ m }))).map(item => item.m), ['剧情很好看']);
  } finally {
    Globals.init({});
  }
});

test('当前演员和角色的去姓、前后缀、叠字称呼直接包含屏蔽', () => {
  const samples = [
    '景瑜来了', '小景好帅', '阿瑜', '瑜瑜', '景瑜宝', '黄老板', '老黄',
    '小于', '小于等于', '阿川', '川儿', '川子', '川哥哥', '阿川子',
    '川叔', '川教授', '川崽崽', '川酱', '娜娜', '欧阳老师', '小欧阳',
    '热巴好美', '千玺来了', '小千', '千千',
    '小凡出场', '小宇宙爆发', '阿羨', '羨兒', '羡妹妹', '羡女神'
  ];
  const comments = [...samples, '于', '川', '景', '瑜', '欧阳', '剧情很好看']
    .map(m => ({ m }));
  const options = { actorNames: ['黄景瑜', '于和伟', '陆川', '欧阳娜娜', '迪丽热巴', '易烊千玺'],
    characterNames: ['张小凡', '张小宇', '魏无羡'] };
  const result = filterDanmusByBlockedNames(comments, [], options);
  assert.deepEqual(result.danmus.map(item => item.m), ['于', '川', '景', '瑜', '欧阳', '剧情很好看']);
  assert.equal(result.removedCount, samples.length);
  assert.ok(result.hits.some(hit => hit.name === '演员昵称:景瑜'));
  assert.ok(result.hits.some(hit => hit.name === '角色昵称:小宇'));
  assert.deepEqual(filterDanmusByBlockedNames(comments, [], {}).danmus, comments);
  // 昵称派生仅用于当前作品的两张人物表，不扩大未分类名单的匹配。
  assert.deepEqual(filterDanmusByBlockedNames([{ m: '景瑜来了' }], ['黄景瑜']).danmus, [{ m: '景瑜来了' }]);
});

test('人物免屏蔽名单支持别名、季度、映射优先级及配置更新', async t => {
  await t.test('默认行为与名单分隔符', async () => {
    assert.deepEqual(splitPersonFilterExcludedTitles('诛仙4，凡人修仙传;诛仙4\n斗破苍穹； '), ['诛仙4', '凡人修仙传', '斗破苍穹']);
    Globals.init({});
    assert.equal(await shouldBlockDomesticCelebrities('诛仙4'), false);
    Globals.init(enabled);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙 第四季(2026)【国产动漫】from tencent'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙3'), true);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙'), true);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
    assert.equal(await shouldBlockDomesticCelebrities('新诛仙4'), true);
    assert.equal(await shouldBlockDomesticCelebrities(''), true);
    Globals.init({ ...enabled, PERSON_FILTER_EXCLUDED_TITLES: '86' });
    assert.equal(await shouldBlockDomesticCelebrities('86(2021)【动漫】from bilibili'), false);
  });

  await t.test('本地季号映射及反向填写正式名称', async () => {
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE: '诛仙S04->诛仙完结季' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季(2026)【国产动漫】from tencent'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙 S04'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙 第三季'), true);
    Globals.init({ ...enabled, PERSON_FILTER_EXCLUDED_TITLES: '诛仙完结季', TITLE_MAPPING_TABLE: '诛仙4->诛仙完结季' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙4'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙4(2026)【国产动漫】from tencent'), false);
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE: '诛仙S04->诛仙完结季', PERSON_FILTER_EXCLUDED_TITLES: '' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
  });

  await t.test('远程映射复用、本地优先及热更新', async () => {
    const url = 'https://example.test/person-filter-mapping.txt';
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE_URL: url });
    applyRemoteTitleMappingText(url, '诛仙S04->诛仙完结季');
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), false);
    assert.equal(resolveLocalTitleMapping('诛仙', 4).matched, false);
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE_URL: url, TITLE_MAPPING_TABLE: '诛仙S04->本地完结季' });
    assert.equal(await shouldBlockDomesticCelebrities('本地完结季'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
    applyRemoteTitleMappingText(url, '诛仙S04->新远程完结季');
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE_URL: url });
    assert.equal(await shouldBlockDomesticCelebrities('新远程完结季'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
    Globals.init(enabled);
    assert.equal(await shouldBlockDomesticCelebrities('新远程完结季'), true);
  });

  await t.test('整季季集映射，含范围或歧义时保留精确名称匹配', async () => {
    Globals.init({ ...enabled, AUTO_MATCH_MAPPING_TABLE: '诛仙 S04E01->诛仙完结季 S01E01' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙3'), true);
    Globals.init({ ...enabled, AUTO_MATCH_MAPPING_TABLE: '诛仙 S04E01~E12->诛仙完结季 S01E01~E12' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
    Globals.init({ ...enabled, AUTO_MATCH_MAPPING_TABLE: '诛仙 S04E01->诛仙完结季 S01E01;诛仙 S04E13->诛仙特别篇 S01E01' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
  });

  await t.test('不丢失指定年份且兼容简繁名称', async () => {
    Globals.init({ ...enabled, PERSON_FILTER_EXCLUDED_TITLES: '誅仙4(2026)', TITLE_MAPPING_TABLE: '诛仙S04->诛仙完结季' });
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季(2026)'), false);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季(2025)'), true);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙完结季'), true);
    Globals.init({ ...enabled, TITLE_MAPPING_TABLE: '诛仙->其他标题' });
    assert.equal(await shouldBlockDomesticCelebrities('其他标题'), true);
    assert.equal(await shouldBlockDomesticCelebrities('诛仙3'), true);
  });

  await t.test('配置注册与弹幕分组入口', () => {
    Globals.init(enabled);
    const config = Globals.envs.envVarConfig.PERSON_FILTER_EXCLUDED_TITLES;
    assert.equal(config.category, 'danmu');
    assert.equal(config.type, 'text');
    assert.equal(Globals.envs.personFilterExcludedTitles, '诛仙4');
    assert.ok(previewJsContent.includes("'BLOCK_DOMESTIC_CELEBRITIES', 'PERSON_FILTER_EXCLUDED_TITLES'"));
  });
});

test('同一弹幕缓存随人物名单热更新，其他作品仍屏蔽角色', async () => {
  Globals.init({ ...enabled, TITLE_MAPPING_TABLE: '诛仙S04->诛仙完结季', COMMENT_CACHE_MIN_COUNT: '0' });
  const url = 'https://v.qq.com/x/cover/person-filter-toggle/episode.html';
  const title = '人物屏蔽回归作品';
  const key = await personCacheIdentity([title, '', '', '', Boolean(Globals.envs.useBangumiData)]);
  await cachedPersonSource(`${key}:identity`, async () => ({ id: 990099, media_type: 'tv', name: title,
    original_language: 'zh', origin_country: ['CN'], genre_ids: [] }), () => true);
  await cachedPersonSource(`${key}:tv/990099:credits-v2`, async () => ({ actorNames: ['黄景瑜', '于和伟', '陆川'], characterNames: ['张小凡'] }), () => true);
  await cachedPersonSource(`${key}:wiki`, async () => ({ actorNames: [], characterNames: [] }), () => true);
  Globals.animes = [{ animeTitle: title, aliases: ['測試別名', 'Jade Dynasty'], links: [{ id: 990099, url }] }];
  Globals.commentCache = new Map();
  const texts = ['张小凡出场了', '景瑜来了', '小于', '阿川', '川儿', '川子', '川崽', title + '真好看', '测试别名好看', 'JADE.DYNASTY好看', '剧情很好看'];
  setCommentCache(url, texts.map((m, i) => ({ p: `${i + 1},1,16777215,[test]`, m })));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('测试资料已预置，不应联网'); };
  try {
    const filtered = await (await getCommentByUrl(url, 'json', false)).json();
    assert.deepEqual(filtered.comments.map(item => item.m), ['剧情很好看']);
    const segment = { type: 'tencent', url: 'nickname-cache-segment', animeTitle: title, sourceUrl: url };
    setCommentCache(resolveSegmentCacheKey(segment), texts.map((m, i) => ({ p: `${i + 1},1,16777215,[test]`, m })));
    assert.deepEqual((await (await getComment('/api/v2/comment/990099', 'json', false)).json()).comments.map(item => item.m), ['剧情很好看']);
    assert.deepEqual((await (await getSegmentComment(segment, 'json')).json()).comments.map(item => item.m), ['剧情很好看']);
    Globals.init({ ...enabled, PERSON_FILTER_EXCLUDED_TITLES: title, COMMENT_CACHE_MIN_COUNT: '0' });
    const excluded = await (await getCommentByUrl(url, 'json', false)).json();
    assert.deepEqual(excluded.comments.map(item => item.m), texts);
  } finally {
    globalThis.fetch = originalFetch;
    Globals.init({});
    Globals.animes = [];
    Globals.commentCache = new Map();
  }
});

test('普通、URL、缓存及分段弹幕入口跳过人物查询，保留其他过滤', async () => {
  Globals.init({ ...enabled, TITLE_MAPPING_TABLE: '诛仙S04->诛仙完结季',
    BLOCK_DOMESTIC_REGIONS: 'true', BLOCK_DATES: 'true', BLOCKED_WORDS: '打卡',
    GROUP_MINUTE: '0', DANMU_LIMIT: '0', CONVERT_COLOR: 'default', COMMENT_CACHE_MIN_COUNT: '0' });
  const url = 'https://v.qq.com/x/cover/person-exclusion/episode.html';
  const animeTitle = '诛仙完结季(2026)【国产动漫】from tencent';
  Globals.animes = [{ animeTitle, links: [{ id: 990001, url }] }];
  Globals.episodeIds = [{ id: 990001, url, title: '第1集' }];
  Globals.commentCache = new Map();
  const previousDeployPlatform = Globals.deployPlatform;
  Globals.deployPlatform = 'node';
  const source = getSourceByKey('tencent');
  const originalComments = source.getComments;
  const originalSegments = source.getSegmentComments;
  const originalFetch = globalThis.fetch;
  let metadataRequests = 0;
  let sourceRequests = 0;
  globalThis.fetch = async () => { metadataRequests++; throw new Error('人物免屏蔽作品不应查询人物名单'); };
  const comments = [
    { p: '1,1,16777215,[test]', m: '张小凡出场了' },
    { p: '2,1,16777215,[test]', m: '来自海南的朋友' },
    { p: '3,1,16777215,[test]', m: '2026年9月4日' },
    { p: '4,1,16777215,[test]', m: '打卡' },
    { p: '5,1,16777215,[test]', m: '剧情很好看' }
  ];
  source.getComments = async () => { sourceRequests++; return convertToDanmakuJson(comments, 'test'); };
  source.getSegmentComments = async () => convertToDanmakuJson(comments, 'test');
  const assertComments = async response => {
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.comments.map(item => item.m), ['张小凡出场了', '剧情很好看']);
  };
  try {
    await assertComments(await getCommentByUrl(url, 'json', false));
    await assertComments(await getCommentByUrl(url, 'json', false));
    assert.equal(sourceRequests, 1);
    await assertComments(await getComment('/api/v2/comment/990001', 'json', false));
    const segment = { type: 'tencent', url: 'person-exclusion-segment', animeTitle, sourceUrl: url };
    await assertComments(await getSegmentComment(segment, 'json'));
    setCommentCache(resolveSegmentCacheKey(segment), convertToDanmakuJson(comments, 'test'));
    await assertComments(await getSegmentComment(segment, 'json'));
    assert.equal(metadataRequests, 0);
  } finally {
    source.getComments = originalComments;
    source.getSegmentComments = originalSegments;
    globalThis.fetch = originalFetch;
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.commentCache = new Map();
    Globals.deployPlatform = previousDeployPlatform;
  }
});


test('已缓存的普通、URL和分段弹幕按当前正则列表过滤，删除规则后恢复', async () => {
  const config = { BLOCK_DOMESTIC_CELEBRITIES: 'false', GROUP_MINUTE: '0', DANMU_LIMIT: '0', COMMENT_CACHE_MIN_COUNT: '0' };
  const url = 'https://v.qq.com/x/cover/regex-cache/episode.html';
  const segment = { type: 'tencent', url: 'regex-cache-segment', animeTitle: '缓存过滤回归', sourceUrl: url };
  const comments = ['海南鸡饭', '2026.9.4', '19:18', '普通弹幕'].map((m, i) => ({ p: `${i + 1},1,16777215,[test]`, m }));
  const originalFetch = globalThis.fetch;
  const previousDeployPlatform = Globals.deployPlatform;
  Globals.deployPlatform = 'node';
  globalThis.fetch = async () => { throw new Error('缓存过滤不应联网'); };
  try {
    Globals.init(config);
    Globals.animes = [{ animeTitle: segment.animeTitle, links: [{ id: 990002, url }] }];
    Globals.episodeIds = [{ id: 990002, url, title: '第1集' }];
    Globals.commentCache = new Map();
    setCommentCache(url, comments);
    setCommentCache(resolveSegmentCacheKey(segment), comments);
    for (const [rules, expected] of [['', comments.map(x => x.m)], [[...BLOCKED_WORD_PRESETS.regions, ...BLOCKED_WORD_PRESETS.dates].join(','), ['普通弹幕']], ['', comments.map(x => x.m)]]) {
      Globals.init({ ...config, BLOCKED_WORDS: rules });
      for (const response of [await getCommentByUrl(url, 'json', false), await getComment('/api/v2/comment/990002', 'json', false), await getSegmentComment(segment, 'json')]) {
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).comments.map(x => x.m), expected);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    Globals.init({});
    Globals.animes = [];
    Globals.episodeIds = [];
    Globals.commentCache = new Map();
    Globals.deployPlatform = previousDeployPlatform;
  }
});


test('作品名过滤使用当前作品别名，不派生人名称呼或收集其他版本', () => {
  Globals.init({ BLOCK_DOMESTIC_CELEBRITIES: 'true', TITLE_MAPPING_TABLE: '诛仙S04->诛仙最终季' });
  Globals.animes = [
    { animeTitle: '诛仙最终季(2026)【动漫】from tencent', aliases: ['誅仙', 'Jade Dynasty'] },
    { animeTitle: '诛仙最终季(2025)【动漫】from tencent', aliases: ['其他年份别名'] },
    { animeTitle: '其他作品', aliases: ['无关别名'] }
  ];
  try {
    const workTitles = getCurrentWorkFilterTitles('诛仙最终季(2026)【动漫】from tencent');
    const texts = ['诛仙真好看', 'Jade.Dynasty真好看', '其他年份别名', '无关别名', '小诛好帅', '剧情很好看'];
    const result = filterDanmusByBlockedNames(texts.map(m => ({ m })), [], { workTitles });
    assert.deepEqual(result.danmus.map(item => item.m), texts.slice(2));
    assert.ok(result.hits.every(hit => hit.name.startsWith('作品：')));
  } finally { Globals.init({}); Globals.animes = []; }
});
