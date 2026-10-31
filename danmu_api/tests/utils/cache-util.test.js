// 缓存与 ID 解析工具：弹幕缓存 TTL/最小条数、动漫与剧集上下文解析、
// 偏好记录（含旧结构兼容）、IP 限流历史清理与缓存容量兜底。全部离线，只操作 Globals 内存状态。

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import {
  resolveAnimeById, resolveAnimeByIdFromDetailStore, resolveEpisodeContextById,
  isCommentCacheValid, getCommentCache, setCommentCache, findAnimeIdByCommentId, findTitleById,
  setPreferByAnimeId, getPreferAnimeId, hasLegacySeasonPreference, setPreferForTitle, storeAnimeIdsToMap,
  cleanupExpiredIPs, removeEarliestAnime, removeEpisodeByUrl, getEpisodeIdFloor,
  canPersistCacheKey, mergeAddAnimeError, queryCacheKeys,
} from '../../utils/cache-util.js';

const reset = (extra = {}) => {
  Globals.init({ LOG_LEVEL: 'error', ...extra });
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.lastSelectMap = new Map();
  Globals.requestHistory = new Map();
  Globals.favoriteCache = new Map();
};

const makeAnime = (animeId, { source = 'tencent', links = [], title = `番剧${animeId}` } = {}) => ({
  animeId,
  bangumiId: String(animeId),
  animeTitle: title,
  source,
  links,
});

test('cache-util 弹幕缓存：命中返回评论、低于最小条数或过期则作废', () => {
  reset({ COMMENT_CACHE_MINUTES: '30', COMMENT_CACHE_MIN_COUNT: '3' });
  const url = 'https://v.qq.com/x/cover/a/b.html';

  assert.strictEqual(getCommentCache(url), null, '未缓存时返回 null');

  setCommentCache(url, [{ m: '1' }, { m: '2' }, { m: '3' }]);
  assert.deepStrictEqual(getCommentCache(url), [{ m: '1' }, { m: '2' }, { m: '3' }], '条数达标且新鲜时命中');
  assert.strictEqual(isCommentCacheValid(url), true);

  // 条数不足：判为无效并直接删除该条目
  const few = 'https://v.qq.com/x/cover/few.html';
  setCommentCache(few, [{ m: 'only' }]);
  assert.strictEqual(isCommentCacheValid(few), false, '低于最小条数视为无效');
  assert.strictEqual(Globals.commentCache.has(few), false, '无效条目应被清理，避免反复判定');

  // 过期：timestamp 早于 TTL
  const stale = 'https://v.qq.com/x/cover/stale.html';
  Globals.commentCache.set(stale, { comments: [{ m: '1' }, { m: '2' }, { m: '3' }], timestamp: Date.now() - 31 * 60 * 1000 });
  assert.strictEqual(isCommentCacheValid(stale), false, '超过 TTL 视为无效');
  assert.strictEqual(Globals.commentCache.has(stale), false, '过期条目应被清理');

  // 最小条数配置为 0 时关闭该限制
  reset({ COMMENT_CACHE_MINUTES: '30', COMMENT_CACHE_MIN_COUNT: '0' });
  setCommentCache(few, [{ m: 'only' }]);
  assert.strictEqual(isCommentCacheValid(few), true, 'COMMENT_CACHE_MIN_COUNT=0 表示不限条数');
});

test('cache-util 弹幕缓存：容量兜底按插入顺序淘汰最早条目', () => {
  reset({ COMMENT_CACHE_MINUTES: '30', COMMENT_CACHE_MIN_COUNT: '0' });
  for (let i = 0; i < 501; i++) setCommentCache(`https://v.qq.com/x/cover/${i}.html`, [{ m: String(i) }]);
  assert.strictEqual(Globals.commentCache.size, 500, '超过 500 条后维持上限');
  assert.strictEqual(Globals.commentCache.has('https://v.qq.com/x/cover/0.html'), false, '最早插入的条目被淘汰');
  assert.strictEqual(Globals.commentCache.has('https://v.qq.com/x/cover/500.html'), true, '最新条目保留');
});

test('cache-util resolveAnimeById 依次查 animes、detailStore 与未过期的 searchCache', () => {
  reset({ SEARCH_CACHE_MINUTES: '3' });
  const fromAnimes = makeAnime(101);
  const fromStore = makeAnime(202);
  const fromSearch = makeAnime(303);
  Globals.animes = [fromAnimes];
  const detailStore = new Map([['k', fromStore]]);
  Globals.searchCache.set('query', { details: [fromSearch], timestamp: Date.now() });

  assert.strictEqual(resolveAnimeById(101, detailStore), fromAnimes);
  assert.strictEqual(resolveAnimeById('202', detailStore), fromStore, '字符串 id 也能命中 detailStore');
  assert.strictEqual(resolveAnimeById(303, detailStore), fromSearch, '命中 searchCache 详情');
  assert.strictEqual(resolveAnimeById(999, detailStore), null, '都不命中时返回 null');
  assert.strictEqual(resolveAnimeByIdFromDetailStore(202, detailStore), fromStore);
  assert.strictEqual(resolveAnimeByIdFromDetailStore(101, detailStore), null, '只查 detailStore，不回落到 animes');

  // 过期 searchCache 不参与解析
  Globals.searchCache.set('stale', { details: [makeAnime(404)], timestamp: Date.now() - 4 * 60 * 1000 });
  assert.strictEqual(resolveAnimeById(404, detailStore), null, '过期搜索缓存不再提供详情');

  // 同一个 anime 出现在多个 Map key 下时按身份去重
  const dupStore = new Map([['a', fromStore], ['b', fromStore]]);
  assert.strictEqual(resolveAnimeByIdFromDetailStore(202, dupStore), fromStore);
});

test('cache-util resolveEpisodeContextById / findAnimeIdByCommentId / findTitleById', () => {
  reset();
  const anime = makeAnime(500, {
    source: 'tencent',
    title: '缓存详情番剧',
    links: [
      { id: 30001, url: 'https://v.qq.com/x/cover/cache/ep1.html', title: '【qq】 第1集' },
      { id: 30002, url: 'https://v.qq.com/x/cover/cache/ep2.html', title: '【qq】 第2集' },
    ],
  });
  anime.aliases = ['缓存别名'];
  Globals.animes = [anime];
  Globals.episodeIds = [{ id: 30001, url: anime.links[0].url, title: '【qq】 第1集' }];

  const context = resolveEpisodeContextById(30002);
  assert.strictEqual(context.anime, anime);
  assert.strictEqual(context.index, 1);
  assert.strictEqual(context.link.title, '【qq】 第2集');
  assert.strictEqual(resolveEpisodeContextById(40000), null, '未命中返回 null');
  assert.strictEqual(resolveEpisodeContextById('not-a-number'), null, '非数字 id 返回 null');

  assert.deepStrictEqual(findAnimeIdByCommentId(30002), [500, 'tencent', '【qq】 第2集', ['缓存别名']]);
  assert.deepStrictEqual(findAnimeIdByCommentId(40000), [null, null, null, []], '未命中时给出空占位元组');

  assert.strictEqual(findTitleById(30001), '【qq】 第1集', '优先取 episodeIds 里的标题');
  Globals.episodeIds = [];
  assert.strictEqual(findTitleById(30002), '【qq】 第2集', 'episodeIds 缺失时从缓存的动漫详情解析');
  assert.strictEqual(findTitleById(40000), null);
});

test('cache-util 偏好记录：setPreferByAnimeId / getPreferAnimeId / hasLegacySeasonPreference', () => {
  reset({ MAX_LAST_SELECT_MAP: '100' });
  Globals.lastSelectMap.set('番剧A', { animeIds: [700, 701] });

  assert.strictEqual(setPreferByAnimeId(701, 'bilibili', 2, 90), '番剧A', '命中 animeIds 时返回被修改的 key');
  assert.strictEqual(setPreferByAnimeId(999, 'bilibili', 2), null, '未命中任何 key 时返回 null');

  const [prefer, source, offsets] = getPreferAnimeId('番剧A', 2);
  assert.strictEqual(prefer, 701);
  assert.strictEqual(source, 'bilibili');
  assert.deepStrictEqual(offsets, { 2: 90 }, '带偏移时记录到 offsets');
  assert.deepStrictEqual(getPreferAnimeId('番剧A', 3), [null, null, { 2: 90 }],
    '未记录的季度偏好为空，offsets 整表返回');
  assert.deepStrictEqual(getPreferAnimeId('不存在', 1), [null, null, null]);

  // season=null 落到 default 桶
  setPreferByAnimeId(700, 'tencent', null);
  assert.strictEqual(getPreferAnimeId('番剧A')[0], 700, '未指定季度时写入 default 桶');

  // 旧结构（有 preferBySeason 但没有 explicitBySeason 标记）视为历史偏好；上面显式选择过的季度不算
  assert.strictEqual(hasLegacySeasonPreference('番剧A', 2), false, '显式选择过的季度不是历史偏好');
  Globals.lastSelectMap.set('旧偏好', { preferBySeason: { 2: 111 }, sourceBySeason: { 2: 'tencent' } });
  assert.strictEqual(hasLegacySeasonPreference('旧偏好', 2), true, '只有旧结构时判为历史偏好');
  Globals.lastSelectMap.get('旧偏好').explicitBySeason = { 2: true };
  assert.strictEqual(hasLegacySeasonPreference('旧偏好', 2), false, '补上显式标记后不再是历史偏好');
  assert.strictEqual(hasLegacySeasonPreference('旧偏好', null), false, '不传季度直接判否');
  assert.strictEqual(hasLegacySeasonPreference('不存在的标题', 1), false);
});

test('cache-util setPreferForTitle 合并 animeIds、trim 标题并按上限淘汰最早记录', () => {
  reset({ MAX_LAST_SELECT_MAP: '2' });
  Globals.lastSelectMap.set('旧记录', { animeIds: [1] });

  assert.strictEqual(setPreferForTitle('  番剧B  ', 801, 'tencent', 1, 30), '番剧B', '返回 trim 后的标题 key');
  assert.deepStrictEqual(Globals.lastSelectMap.get('番剧B').animeIds, [801], '标题被 trim 后作为 key');
  assert.strictEqual(setPreferForTitle('番剧B', 802, 'bilibili', 1), '番剧B');
  assert.deepStrictEqual(Globals.lastSelectMap.get('番剧B').animeIds, [801, 802], '同标题重复写入时合并 id');
  assert.strictEqual(setPreferForTitle('番剧B', null, 'bilibili'), null, '缺少 animeId 时不写入');
  assert.strictEqual(setPreferForTitle('   ', 803, 'tencent'), null, '空标题不写入');

  assert.strictEqual(Globals.lastSelectMap.size, 2, '两个不同标题时刚好达到上限，不触发淘汰');
  assert.deepStrictEqual([...Globals.lastSelectMap.keys()], ['旧记录', '番剧B']);

  // 写入第三个标题才超过 MAX_LAST_SELECT_MAP=2，按 FIFO 淘汰最早写入的 key
  assert.strictEqual(setPreferForTitle('番剧C', 803, 'tencent', 1), '番剧C');
  assert.deepStrictEqual([...Globals.lastSelectMap.keys()], ['番剧B', '番剧C'], '最早写入的 key 被淘汰');
  assert.strictEqual(Globals.lastSelectMap.size, 2);
});

test('cache-util storeAnimeIdsToMap 合并旧 id 并保留已有偏好字段', () => {
  reset({ MAX_LAST_SELECT_MAP: '10' });
  Globals.lastSelectMap.set('关键词', {
    animeIds: [11, 12],
    preferBySeason: { 1: 11 },
    offsets: { 1: 45 },
    explicitBySeason: { 1: true },
  });

  storeAnimeIdsToMap([{ animeId: 13 }, { animeId: 12 }], '关键词');
  const entry = Globals.lastSelectMap.get('关键词');
  assert.deepStrictEqual(entry.animeIds, [11, 12, 13], '旧 id 保留且去重');
  assert.deepStrictEqual(entry.preferBySeason, { 1: 11 }, '偏好字段原样保留');
  assert.deepStrictEqual(entry.offsets, { 1: 45 });
  assert.deepStrictEqual(entry.explicitBySeason, { 1: true });
  assert.deepStrictEqual([...Globals.lastSelectMap.keys()], ['关键词'], '更新后仍是同一个 key');
});

test('cache-util cleanupExpiredIPs 只保留 1 分钟窗口内的记录', () => {
  reset();
  const now = 1_700_000_000_000;
  Globals.requestHistory = new Map([
    ['a', [now - 30_000, now - 61_000]],
    ['b', [now - 120_000]],
    ['c', [now - 1_000]],
  ]);

  cleanupExpiredIPs(now);
  assert.deepStrictEqual([...Globals.requestHistory.keys()].sort(), ['a', 'c'], '整条过期的 IP 记录被删除');
  assert.deepStrictEqual(Globals.requestHistory.get('a'), [now - 30_000], '部分过期时只保留窗口内时间戳');
  assert.deepStrictEqual(Globals.requestHistory.get('c'), [now - 1_000]);
});

test('cache-util removeEarliestAnime / removeEpisodeByUrl / getEpisodeIdFloor', () => {
  reset({ SEARCH_CACHE_MINUTES: '3' });
  const first = makeAnime(900, { links: [{ id: 9101, url: 'https://a/ep1', title: 'e1' }, { id: 9102, url: 'https://a/ep2', title: 'e2' }] });
  const second = makeAnime(901, { links: [{ id: 9201, url: 'https://b/ep1', title: 'e1' }] });
  Globals.animes = [first, second];
  Globals.episodeIds = [
    { id: 9101, url: 'https://a/ep1', title: 'e1' },
    { id: 9102, url: 'https://a/ep2', title: 'e2' },
    { id: 9201, url: 'https://b/ep1', title: 'e1' },
  ];

  assert.strictEqual(removeEarliestAnime(), true);
  assert.deepStrictEqual(Globals.animes.map((anime) => anime.animeId), [901], '移除最早加入的动漫');
  assert.deepStrictEqual(Globals.episodeIds.map((episode) => episode.id), [9201], '同时清理其链接对应的 episodeIds');
  assert.strictEqual(removeEpisodeByUrl('https://b/ep1'), true);
  assert.strictEqual(removeEpisodeByUrl('https://b/ep1'), false, '重复删除返回 false');
  assert.strictEqual(Globals.episodeIds.length, 0);

  Globals.animes = [second];
  Globals.episodeIds = [{ id: 9201, url: 'https://b/ep1', title: 'e1' }];
  Globals.favoriteCache = new Map([['fav', { details: [makeAnime(800, { links: [{ id: 50000, url: 'https://c/ep1', title: 'e1' }] })] }]]);
  Globals.searchCache.set('fresh', { details: [makeAnime(801, { links: [{ id: 60000, url: 'https://d/ep1', title: 'e1' }] })], timestamp: Date.now() });
  Globals.searchCache.set('stale', { details: [makeAnime(802, { links: [{ id: 70000, url: 'https://e/ep1', title: 'e1' }] })], timestamp: Date.now() - 10 * 60 * 1000 });

  assert.strictEqual(getEpisodeIdFloor(), 60000, '取 episodeIds/收藏/新鲜搜索缓存中的最大 id，忽略过期搜索缓存');

  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.favoriteCache = new Map();
  Globals.searchCache = new Map();
  assert.strictEqual(getEpisodeIdFloor(), 10001, '无任何引用时回落 10001');
});

test('cache-util canPersistCacheKey 依据后端可写状态判定可持久化', () => {
  reset();
  Globals.favoriteCacheWritable = { upstash: false, file: true };
  Globals.queryCacheWritable = { upstash: false, file: true };
  Globals.queryCacheInitialized = false;

  assert.strictEqual(canPersistCacheKey('favoriteCache', 'upstash'), false, '收藏缓存尊重后端只读标记');
  assert.strictEqual(canPersistCacheKey('favoritesCache', 'file'), true, '兼容旧键名');
  assert.strictEqual(canPersistCacheKey('animes', 'file'), false, '查询缓存未初始化完成前不可写');
  Globals.queryCacheInitialized = true;
  assert.strictEqual(canPersistCacheKey('animes', 'file'), true);
  assert.strictEqual(canPersistCacheKey('animes', 'upstash'), false, '按后端分别判定');
  assert.strictEqual(canPersistCacheKey('bangumiData', 'upstash'), true, '非查询缓存键不受查询缓存标记限制');
  assert.deepStrictEqual(queryCacheKeys.includes('animes'), true);
});

test('cache-util mergeAddAnimeError 只在目标缺少错误时补齐来源错误', () => {
  reset();
  const target = new Map();
  const source = new Map();
  source.__addAnimeError = '来源错误';

  assert.strictEqual(mergeAddAnimeError(target, source), target, '原样返回目标 Map');
  assert.strictEqual(target.__addAnimeError, '来源错误');

  const kept = new Map();
  kept.__addAnimeError = '已有错误';
  mergeAddAnimeError(kept, source);
  assert.strictEqual(kept.__addAnimeError, '已有错误', '目标已有错误时不被覆盖');

  const noError = new Map();
  const clean = new Map();
  mergeAddAnimeError(noError, clean);
  assert.strictEqual(noError.__addAnimeError, undefined, '来源无错误时不做任何写入');
});
