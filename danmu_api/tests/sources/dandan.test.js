// 弹弹源：详情兜底、Bangumi Data 补全与关联链接分发
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import { Bangumi } from '../../models/dandan-model.js';
import BilibiliSource from '../../sources/bilibili.js';
import DandanSource, { fillMissingEpisodes, extractBroadcastStart, selectBangumiDataItem } from '../../sources/dandan.js';
import TencentSource from '../../sources/tencent.js';
import { clearBangumiDataCache } from '../../utils/bangumi-data-util.js';
import { fetchNipaplayBangumiDetail } from '../../utils/nipaplay-util.js';
import { mockJsonResponse, token, withMockFetch } from '../helpers/context.js';

test('dandan formatComments 按实时拉取标记区分处理', () => {
  const dandan = new DandanSource();
  const realtime = { cid: 1, p: '12.34,1,25,16777215,0', m: 'x', isRealTimePulled: true };
  assert.strictEqual(dandan.formatComments([realtime])[0], realtime, '实时拉取弹幕原样返回');

  const native = { cid: 1, p: '12.34,1,25,aFFFFFF,0', m: 'y' };
  assert.strictEqual(dandan.formatComments([native])[0].p, '12.34,1,25,a16777215,0', '原生弹幕执行颜色转换');
});
test('dandan fillMissingEpisodes 详情集缺失时按 Bangumi Data 放送区间补全', async () => {
  // 库兹马唱歌的话家里哆啰啰：详情接口 11 集（末集 2026-06-18），Bangumi Data 放送区间 2026-04-09 ~ 2026-06-25
  const buildEpisode = (n, airDate) => ({
    seasonId: null,
    episodeId: Number(`18622${String(n).padStart(4, '0')}`),
    episodeTitle: `第${n}话`,
    episodeNumber: String(n),
    lastWatched: null,
    airDate,
  });
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const kujimaBegin = Date.UTC(2026, 3, 9);
  const kujimaEpisodes = Array.from({ length: 11 }, (_, i) => buildEpisode(i + 1, new Date(kujimaBegin + i * weekMs).toISOString()));
  const kujimaDetail = {
    animeTitle: '库兹马唱歌的话家里哆啰啰',
    bangumiUrl: 'https://bangumi.tv/subject/493804',
    titles: [{ language: '主标题', title: '库兹马唱歌的话家里哆啰啰' }],
    metadata: ['话数: 12', '放送开始: 2026年4月9日'],
  };
  const kujimaItem = { siteId: '493804', begin: '2026-04-09T13:30:00.000Z', end: '2026-06-25T14:00:00.000Z' };
  const lookupKujima = async () => kujimaItem;

  // 末集放送日期与放送结束相差一周：按放送区间补齐第 12 话
  const filled = await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, lookupKujima);
  assert.strictEqual(filled.length, 12, '按放送区间补齐至 12 话');
  assert.deepStrictEqual(filled.slice(0, 11), kujimaEpisodes, '已有集保持原样且顺序不变');
  assert.strictEqual(filled[11].episodeId, 186220012, '集 id 为 animeId + 4 位集号');
  assert.strictEqual(filled[11].episodeNumber, '12');
  assert.strictEqual(`【dandan】 ${filled[11].episodeTitle}`, '【dandan】 第12话 （系统补全）', '标题沿用既有格式并标记系统补全');

  // 重复调用：已补齐的集不重复补全
  const refilled = await fillMissingEpisodes(18622, kujimaDetail, filled, lookupKujima);
  assert.strictEqual(refilled.length, 12, '重复调用不重复补全');
  assert.deepStrictEqual(refilled.slice(0, 12), filled, '重复调用保持集列表不变');

  // 末集放送日期与放送结束相同或相差不超过两天：中途有周未放送，集数正确，不补全
  const aligned = await fillMissingEpisodes(
    18622, kujimaDetail, [...kujimaEpisodes.slice(0, 10), buildEpisode(11, '2026-06-25T00:00:00')], lookupKujima,
  );
  assert.strictEqual(aligned.length, 11, '末集与放送结束对齐时不补全');

  // 放送结束不可知且已存在集：不补全
  const noEnd = await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, async () => ({ siteId: '493804', begin: '2026-04-09T13:30:00.000Z', end: '' }));
  assert.strictEqual(noEnd.length, 11, '放送结束不可知时不补全');

  // 放送开始不可知（Bangumi Data 无 begin，详情接口 metadata 仅到年）：不补全
  const fxDetail = {
    animeTitle: 'FX战士久留美',
    bangumiUrl: 'https://bangumi.tv/subject/622288',
    titles: [{ language: '主标题', title: 'FX战士久留美' }],
    metadata: ['话数: *', '放送开始: 2026年'],
  };
  const unknownBegin = await fillMissingEpisodes(18622, fxDetail, kujimaEpisodes, async () => ({ siteId: '622288', begin: '', end: '' }));
  assert.strictEqual(unknownBegin.length, 11, '放送开始不可知时不补全');

  // Bangumi Data 无放送开始但详情接口 metadata 提供完整日期：回退到 metadata 补全
  const fromMetadata = await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, async () => ({ siteId: '493804', begin: '', end: '2026-06-25T14:00:00.000Z' }));
  assert.strictEqual(fromMetadata.length, 12, '回退到详情接口 metadata 的放送开始');

  // 末集放送日期为空：按一周一集计算
  const nullAirDate = [...kujimaEpisodes];
  nullAirDate[10] = { ...nullAirDate[10], airDate: null };
  assert.strictEqual((await fillMissingEpisodes(18622, kujimaDetail, nullAirDate, lookupKujima)).length, 12, '末集放送日期为空时按一周一集计算');

  // 整部无集且放送结束可知：按放送区间推算总集数
  const fxWithEnd = await fillMissingEpisodes(19847, fxDetail, [], async () => ({ siteId: '622288', begin: '2026-10-01T12:30:00.000Z', end: '2026-10-22T12:30:00.000Z' }));
  assert.strictEqual(fxWithEnd.length, 4, '整部无集时按放送区间补全');
  assert.strictEqual(fxWithEnd[0].episodeId, 198470001, '首集 id 为 animeId + 0001');
  assert.strictEqual(`【dandan】 ${fxWithEnd[0].episodeTitle}`, '【dandan】 第1话 （系统补全）', '首集标题沿用既有格式');
  assert.deepStrictEqual(fxWithEnd.map((ep) => ep.episodeNumber), ['1', '2', '3', '4'], '集号自 1 顺延');

  // 整部无集且放送结束不可知：按当前周推算并额外多补两集（3 周 + 当周 + 额外 2）
  const beginThreeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const fxNoEnd = await fillMissingEpisodes(19847, fxDetail, [], async () => ({ siteId: '622288', begin: beginThreeWeeksAgo, end: '' }));
  assert.strictEqual(fxNoEnd.length, 6, '按当前周推算并额外多补两集');

  // 末集放送日期在一周内：不可能缺集，不查询 Bangumi Data 直接返回
  let lookupCalled = false;
  const recentEpisodes = [...kujimaEpisodes];
  recentEpisodes[10] = { ...recentEpisodes[10], airDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() };
  const recentResult = await fillMissingEpisodes(18622, kujimaDetail, recentEpisodes, async () => { lookupCalled = true; return kujimaItem; });
  assert.strictEqual(recentResult.length, 11, '末集放送日期在一周内时不补全');
  assert.strictEqual(lookupCalled, false, '末集放送日期在一周内时不查询 Bangumi Data');

  // 按放送区间推算的集数未超过现有正片集数：不补全，并记录跳过原因
  const savedLogLevel = Globals.envs.logLevel;
  const savedLogBuffer = Globals.envs.logBuffer;
  Globals.envs.logLevel = 'info';
  Globals.envs.logBuffer = [];
  const notExceeded = await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, async () => ({ siteId: '493804', begin: '2026-04-09T13:30:00.000Z', end: '2026-06-11T14:00:00.000Z' }));
  const skipReasonLogged = Globals.envs.logBuffer.some((entry) => String(entry.message).includes('未超过现有 11 集'));
  Globals.envs.logLevel = savedLogLevel;
  Globals.envs.logBuffer = savedLogBuffer;
  assert.strictEqual(notExceeded.length, 11, '按放送区间推算集数未超过现有集数时不补全');
  assert.strictEqual(skipReasonLogged, true, '记录推算集数未超过现有集数的跳过原因');

  // 番外集不参与正片集数计算，补全集插入在正片之后、番外之前
  const withSpecials = [...kujimaEpisodes, { seasonId: null, episodeId: 186229001, episodeTitle: 'S1 特番', episodeNumber: 'S1', lastWatched: null, airDate: null }];
  const specialsFilled = await fillMissingEpisodes(18622, kujimaDetail, withSpecials, lookupKujima);
  assert.strictEqual(specialsFilled.length, 13, '番外不参与正片集数计算');
  assert.strictEqual(specialsFilled[11].episodeId, 186220012, '补全集插入在正片之后');
  assert.strictEqual(specialsFilled[12].episodeNumber, 'S1', '番外保持在末尾');

  // 查不到对应条目：维持原集列表
  assert.strictEqual((await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, async () => null)).length, 11, '查不到对应条目时不补全');

  // 放送截止与用户系统时间均不可知：按默认集数补全（运行期时间不可用时的兜底）
  const defaultCount = await fillMissingEpisodes(18622, kujimaDetail, [], async () => ({ siteId: '493804', begin: '', end: '' }), Number.NaN);
  assert.strictEqual(defaultCount.length, 26, '放送截止与系统时间均不可知时按默认集数补全');

  // 条目定位：优先 anidb 站点 id 与弹弹play 作品 id 一致且唯一的一条
  const anidbOnly = [{ matchedSiteKey: 'anidb', siteId: '18622', begin: 'anidb-begin', end: 'anidb-end' }];
  assert.strictEqual(selectBangumiDataItem(anidbOnly, 18622, '493804').begin, 'anidb-begin', '按 anidb 站点 id 对齐');
  // 同一 anidb id 对应多个分部条目时回退到 bangumi 站点 id
  const ambiguous = [
    { matchedSiteKey: 'anidb', siteId: '19287', begin: 'stage1' },
    { matchedSiteKey: 'anidb', siteId: '19287', begin: 'stage23' },
    { matchedSiteKey: 'bangumi', siteId: '551918', begin: 'stage1-by-bangumi' },
  ];
  assert.strictEqual(selectBangumiDataItem(ambiguous, 19287, '551918').begin, 'stage1-by-bangumi', 'anidb 不唯一时回退 bangumi 站点 id');
  // 作品在 Bangumi Data 中没有 anidb 站点记录时回退到 bangumi 站点 id
  const bangumiOnly = [{ matchedSiteKey: 'bangumi', siteId: '622288', begin: 'bangumi-begin' }];
  assert.strictEqual(selectBangumiDataItem(bangumiOnly, 19847, '622288').begin, 'bangumi-begin', '无 anidb 条目时回退 bangumi 站点 id');
  // 两种站点 id 都无法对应
  assert.strictEqual(selectBangumiDataItem(bangumiOnly, 19847, '999999'), null, '站点 id 均不匹配时不定位');
  assert.strictEqual(selectBangumiDataItem([], 19847, '622288'), null, '无搜索结果时不定位');

  // 本地条目不可得时经默认查表回退：整部无集仍按详情接口 metadata 的放送开始推算
  clearBangumiDataCache(false);
  const savedUseBangumiData = Globals.envs.useBangumiData;
  Globals.envs.useBangumiData = false;
  const withoutLocalItem = await fillMissingEpisodes(18622, kujimaDetail, []);
  Globals.envs.useBangumiData = savedUseBangumiData;
  assert.ok(withoutLocalItem.length > 0, '本地条目不可得时按详情接口 metadata 的放送开始补全');
  assert.strictEqual(withoutLocalItem[0].episodeId, 186220001, '补全集首集 id 为 animeId + 0001');
  assert.strictEqual(`【dandan】 ${withoutLocalItem[0].episodeTitle}`, '【dandan】 第1话 （系统补全）', '补全集首集标题沿用既有格式');

  // 推算集数上限：放送开始取自真实长寿番条目（サザエさん，1969-10-05），整部无集时按放送区间线性推集不会超过上限
  const ancientBegin = new Date(Date.UTC(1969, 9, 5)).toISOString();
  Globals.envs.logLevel = 'info';
  Globals.envs.logBuffer = [];
  const cappedNoEnd = await fillMissingEpisodes(18622, kujimaDetail, [], async () => ({ siteId: '493804', begin: ancientBegin, end: '' }));
  const capLogged = Globals.envs.logBuffer.some((entry) => String(entry.message).includes('超过上限按 100 集补全'));
  Globals.envs.logLevel = savedLogLevel;
  Globals.envs.logBuffer = savedLogBuffer;
  assert.strictEqual(cappedNoEnd.length, 100, '按当前周推算超过上限时按上限补全');
  assert.strictEqual(capLogged, true, '补全日志标注集数上限');
  // 已有集时按放送区间推算同样受上限约束
  const cappedTail = await fillMissingEpisodes(18622, kujimaDetail, kujimaEpisodes, async () => ({ siteId: '493804', begin: ancientBegin, end: new Date(Date.UTC(2099, 0, 1)).toISOString() }));
  assert.strictEqual(cappedTail.length, 100, '补齐末集之后的集同样受上限约束');
  assert.strictEqual(cappedTail[99].episodeId, 186220100, '上限处的集 id 为 animeId + 0100');

  // 详情接口 metadata 的「放送开始」解析
  assert.notStrictEqual(extractBroadcastStart(['放送开始: 2026年4月9日']), null, '完整日期可解析');
  assert.strictEqual(extractBroadcastStart(['放送开始: 2026年']), null, '仅到年不可解析');
  assert.strictEqual(extractBroadcastStart(['放送开始: 2026年4月']), null, '缺日不可解析');
  assert.strictEqual(extractBroadcastStart(['话数: 12']), null, '无放送开始不可解析');
  assert.strictEqual(extractBroadcastStart(null), null, '空入参不可解析');
});
test('dandan getEpisodes 详情接口集为空或不可用时经 NipaPlay 中转弹弹play服务端兜底', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedAccount = Globals.envs.dandanplayAccount;
  const savedPassword = Globals.envs.dandanplayPassword;
  const savedUseBangumiData = Globals.envs.useBangumiData;
  try {
    // 账号未配置时不请求详情接口
    Globals.envs.dandanplayAccount = '';
    Globals.envs.dandanplayPassword = '';
    assert.strictEqual(await fetchNipaplayBangumiDetail(18622), null, '账号未配置时返回 null');

    // 账号配置后：详情接口返回 401 时清除令牌重新登录并重试一次
    Globals.envs.useBangumiData = false;
    Globals.envs.dandanplayAccount = `detail-probe-${Date.now()}`;
    Globals.envs.dandanplayPassword = 'detail-probe-password';
    let loginCount = 0;
    let detailCount = 0;
    const episodes = [{ seasonId: null, episodeId: 186220001, episodeTitle: '第1话', episodeNumber: '1', lastWatched: null, airDate: null }];
    const mockFetch = async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith('/api/v2/login')) {
        loginCount++;
        return mockJsonResponse({ token: `detail-token-${loginCount}`, tokenExpireTime: '2099-01-01T00:00:00Z' }, url);
      }
      if (target.endsWith('/api/v2/bangumi/18622')) {
        detailCount++;
        if (detailCount === 1) {
          return { ok: false, status: 401, url, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ errorMessage: '登录已失效' }) };
        }
        return mockJsonResponse({ bangumi: { animeId: 18622, episodes }, success: true }, url);
      }
      throw new Error(`未预期的请求: ${target}`);
    };

    // 弹弹详情接口返回空集 → 走 NipaPlay 详情兜底（含 401 重登重试）
    const mirrorEmpty = mockJsonResponse({ bangumi: { animeId: 18622, titles: [], episodes: [], relateds: [], metadata: [] }, success: true }, 'danmaku-anywhere 镜像弹弹play服务端');
    const routedFetch = async (url, options = {}) => {
      if (String(url).includes('api.danmaku.weeblify.app')) return mirrorEmpty;
      return mockFetch(url, options);
    };
    const result = await withMockFetch(routedFetch, () => new DandanSource().getEpisodes(18622));
    assert.deepStrictEqual(result.episodes, episodes, 'danmaku-anywhere 镜像弹弹play服务端无集时取 NipaPlay 中转弹弹play服务端详情');
    assert.strictEqual(detailCount, 2, '401 后重试一次详情请求');
    assert.strictEqual(loginCount, 2, '401 后重新登录');

    // 镜像详情请求经重试后仍不可用（httpGet 以异常抛出）→ 同一兜底路径，详情连同标签与类型描述取自 NipaPlay
    const nipaplayDetail = {
      animeId: 18622,
      titles: [{ language: '主标题', title: '库兹马唱歌的话家里哆啰啰' }],
      episodes,
      relateds: [],
      tags: [{ name: '3D' }],
      type: 'tvseries',
      typeDescription: 'TV动画',
      metadata: [],
    };
    const detailOkFetch = async (url) => {
      const target = String(url);
      if (target.endsWith('/api/v2/login')) return mockJsonResponse({ token: 'detail-ok-token', tokenExpireTime: '2099-01-01T00:00:00Z' }, url);
      if (target.endsWith('/api/v2/bangumi/18622')) return mockJsonResponse({ bangumi: nipaplayDetail, success: true }, url);
      throw new Error(`未预期的请求: ${target}`);
    };
    const throwingMirrorFetch = async (url, options = {}) => {
      if (String(url).includes('api.danmaku.weeblify.app')) throw new Error('镜像详情接口不可用');
      return detailOkFetch(url, options);
    };
    const fromThrow = await withMockFetch(throwingMirrorFetch, () => new DandanSource().getEpisodes(18622));
    assert.deepStrictEqual(fromThrow.episodes, episodes, '镜像详情请求抛出异常时经 NipaPlay 中转弹弹play服务端兜底');
    assert.strictEqual(fromThrow.typeDescription, '3DTV动画', '详情标签识别的 3D 追加至类型描述');

    // 镜像返回 200 但无 bangumi 数据 → 同一兜底路径
    const noBangumiMirror = mockJsonResponse({ success: true }, 'danmaku-anywhere 镜像弹弹play服务端');
    const noBangumiFetch = async (url, options = {}) => {
      if (String(url).includes('api.danmaku.weeblify.app')) return noBangumiMirror;
      return detailOkFetch(url, options);
    };
    const fromNoBangumi = await withMockFetch(noBangumiFetch, () => new DandanSource().getEpisodes(18622));
    assert.deepStrictEqual(fromNoBangumi.episodes, episodes, '镜像无 bangumi 数据时经 NipaPlay 中转弹弹play服务端兜底');

    // 镜像返回 200 但无 data → 同一兜底路径
    const noDataMirror = mockJsonResponse(null, 'danmaku-anywhere 镜像弹弹play服务端');
    const noDataFetch = async (url, options = {}) => {
      if (String(url).includes('api.danmaku.weeblify.app')) return noDataMirror;
      return detailOkFetch(url, options);
    };
    const fromNoData = await withMockFetch(noDataFetch, () => new DandanSource().getEpisodes(18622));
    assert.deepStrictEqual(fromNoData.episodes, episodes, '镜像无 data 时经 NipaPlay 中转弹弹play服务端兜底');

    // 详情请求失败：返回 null，由调用方沿用原详情数据
    Globals.envs.dandanplayAccount = `detail-fail-${Date.now()}`;
    const failingFetch = async (url, options = {}) => {
      if (String(url).endsWith('/api/v2/login')) return mockJsonResponse({ token: 'detail-token', tokenExpireTime: '2099-01-01T00:00:00Z' }, url);
      return { ok: false, status: 500, url, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ errorMessage: '详情服务不可用' }) };
    };
    assert.strictEqual(await withMockFetch(failingFetch, () => fetchNipaplayBangumiDetail(18622)), null, '详情请求失败时返回 null');
  } finally {
    Globals.envs.dandanplayAccount = savedAccount;
    Globals.envs.dandanplayPassword = savedPassword;
    Globals.envs.useBangumiData = savedUseBangumiData;
  }
});
test('dandan resolveUnavailableDetail 详情不可用时按 Bangumi Data 兜底', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const savedAccount = Globals.envs.dandanplayAccount;
  const savedPassword = Globals.envs.dandanplayPassword;
  try {
    // NipaPlay 账号未配置：兜底直接落到 Bangumi Data
    Globals.envs.dandanplayAccount = '';
    Globals.envs.dandanplayPassword = '';
    const source = new DandanSource();
    // 描绘直至生命尽头：Bangumi Data 放送区间 2026-07-03 ~ 2026-09-25（一周一集共 12 集）
    const item = {
      siteId: '19232',
      begin: '2026-07-03T14:30:00.000Z',
      end: '2026-09-25T14:59:00.000Z',
      typeId: 'tvseries',
      typeStr: 'TV动画',
      titles: ['描绘直至生命尽头', '画完这个就去死', '畫完這個再去死', 'これ描いて死ね'],
    };

    // 常规：镜像命中条目（不带 _bangumiDataHit）由 Bangumi Data 补全集列表与标题别名
    const mirrored = await source.resolveUnavailableDetail(
      19232, { animeTitle: '描绘直至生命尽头(2026)【TV动画】from dandan', aliases: [] }, async () => item,
    );
    assert.strictEqual(mirrored.episodes.length, 13, '按放送区间推算 13 集（含首尾各一周）');
    assert.strictEqual(mirrored.episodes[0].episodeId, 192320001, '补全集 id 为 animeId + 4 位集号');
    assert.strictEqual(`【dandan】 ${mirrored.episodes[0].episodeTitle}`, '【dandan】 第1话 （系统补全）', '补全集标题沿用既有格式');
    assert.deepStrictEqual(mirrored.titles, item.titles, '镜像命中时由 Bangumi Data 补标题别名');
    assert.strictEqual(mirrored.type, 'tvseries', '类型沿用 Bangumi Data 映射');
    assert.strictEqual(mirrored.typeDescription, 'TV动画', '类型描述沿用 Bangumi Data 映射');
    assert.deepStrictEqual(mirrored.relateds, [], '相关作品无来源');
    assert.strictEqual(mirrored.imageUrl, null, '封面无来源');

    // 边缘：Bangumi Data 本地命中条目已携带标题别名，不重复补全
    const local = await source.resolveUnavailableDetail(
      19232, { animeTitle: '描绘直至生命尽头(2026)【TV动画】from dandan', aliases: ['画完这个再去死'], _bangumiDataHit: true }, async () => item,
    );
    assert.strictEqual(local.episodes.length, 13, '本地命中条目同样补全集列表');
    assert.deepStrictEqual(local.titles, [], '本地命中时标题别名已由条目携带，不重复补全');

    // 缺失：Bangumi Data 检索不到条目时记录日志并返回空结构，不构造残缺条目
    const savedLogLevel = Globals.envs.logLevel;
    const savedLogBuffer = Globals.envs.logBuffer;
    Globals.envs.logLevel = 'info';
    Globals.envs.logBuffer = [];
    const missing = await source.resolveUnavailableDetail(
      19232, { animeTitle: '检索不到的作品(2026)【TV动画】from dandan', aliases: [] }, async () => null,
    );
    const missLogged = Globals.envs.logBuffer.some((entry) => String(entry.message).includes('Bangumi Data 未命中条目'));
    Globals.envs.logLevel = savedLogLevel;
    Globals.envs.logBuffer = savedLogBuffer;
    assert.strictEqual(missLogged, true, '检索不到条目时记录未命中日志');
    assert.deepStrictEqual(
      missing, { episodes: [], titles: [], relateds: [], type: null, typeDescription: null, imageUrl: null },
      '检索不到条目时返回空结构',
    );
    // 默认查表：未注入查表函数时按搜索条目的标题与别名在本地索引逐个检索；本地索引为空时同样返回空结构
    const savedUseBangumiData = Globals.envs.useBangumiData;
    Globals.envs.useBangumiData = false;
    clearBangumiDataCache(false);
    const byDefaultLookup = await source.resolveUnavailableDetail(
      19232, { animeTitle: '检索不到的作品(2026)【TV动画】from dandan', aliases: ['检索不到的作品'] },
    );
    Globals.envs.useBangumiData = savedUseBangumiData;
    assert.deepStrictEqual(
      byDefaultLookup, { episodes: [], titles: [], relateds: [], type: null, typeDescription: null, imageUrl: null },
      '经默认查表未命中条目时返回空结构',
    );
  } finally {
    Globals.envs.dandanplayAccount = savedAccount;
    Globals.envs.dandanplayPassword = savedPassword;
  }
});
test('dandan 关联链接分发仅限已在 SOURCE_ORDER 开启的源', async () => {
  const location = 'https://x.test/redirect?urls=https://www.bilibili.com/video/BV1xx|https://v.qq.com/x/cover/abc.html&shift=0,0';
  const originalOrder = Globals.envs.sourceOrderArr;
  const originalAccount = Globals.envs.dandanplayAccount;
  const originalPassword = Globals.envs.dandanplayPassword;
  const originalBilibiliGet = BilibiliSource.prototype.getEpisodeDanmu;
  const originalBilibiliFormat = BilibiliSource.prototype.formatComments;
  const originalTencentGet = TencentSource.prototype.getEpisodeDanmu;
  const originalTencentFormat = TencentSource.prototype.formatComments;
  const pulled = [];

  // 网关登录应答、评论接口回传 302 关联链接、原生弹幕地址应答
  const gatewayFetch = async (url) => {
    const target = String(url);
    if (target.endsWith('/api/v2/login')) {
      return mockJsonResponse({ success: true, token: 'mock-token', tokenExpireTime: '2099-01-01T00:00:00Z' });
    }
    if (target.includes('/api/v2/comment/')) {
      return { ok: false, status: 302, url: target, headers: new Headers({ location }), text: async () => '' };
    }
    return mockJsonResponse({ comments: [] });
  };

  try {
    Globals.envs.dandanplayAccount = 'account@example.com';
    Globals.envs.dandanplayPassword = 'password';
    BilibiliSource.prototype.getEpisodeDanmu = async () => {
      pulled.push('bilibili');
      return [{ cid: 1, p: '1.00,1,25,16777215,0', t: 1, m: '来自B站' }];
    };
    BilibiliSource.prototype.formatComments = (list) => list;
    TencentSource.prototype.getEpisodeDanmu = async () => { pulled.push('tencent'); return []; };
    TencentSource.prototype.formatComments = (list) => list;

    await withMockFetch(gatewayFetch, async () => {
      // 仅开启 bilibili：只拉取 bilibili，跳过未开启的 tencent
      Globals.envs.sourceOrderArr = ['bilibili'];
      const onlyBilibili = await new DandanSource().getEpisodeDanmu('ep-1');
      assert.deepStrictEqual(pulled, ['bilibili'], '仅分发已开启的源');
      assert.strictEqual(onlyBilibili.length, 1, '分发结果来自已开启的源');
      assert.strictEqual(onlyBilibili[0].realTimeSource, 'bilibili1', '标记实时拉取来源');

      // 仅开启 tencent：分发目标随之切换
      pulled.length = 0;
      Globals.envs.sourceOrderArr = ['tencent'];
      await new DandanSource().getEpisodeDanmu('ep-2');
      assert.deepStrictEqual(pulled, ['tencent'], '开启源变化后分发目标随之切换');

      // 两个关联源都未开启：全部跳过
      pulled.length = 0;
      Globals.envs.sourceOrderArr = ['douban'];
      const none = await new DandanSource().getEpisodeDanmu('ep-3');
      assert.deepStrictEqual(pulled, [], '未开启关联源时不拉取');
      assert.deepStrictEqual(none, [], '未开启关联源时无关联弹幕');

      // 源已开启但已被独立选择的合并源覆盖：同样跳过，避免重复拉取
      pulled.length = 0;
      Globals.envs.sourceOrderArr = ['bilibili', 'tencent'];
      await new DandanSource().getEpisodeDanmu('ep-4', ['bilibili:123']);
      assert.deepStrictEqual(pulled, ['tencent'], '已开启但被合并源覆盖的平台仍跳过');
    });
  } finally {
    Globals.envs.sourceOrderArr = originalOrder;
    Globals.envs.dandanplayAccount = originalAccount;
    Globals.envs.dandanplayPassword = originalPassword;
    BilibiliSource.prototype.getEpisodeDanmu = originalBilibiliGet;
    BilibiliSource.prototype.formatComments = originalBilibiliFormat;
    TencentSource.prototype.getEpisodeDanmu = originalTencentGet;
    TencentSource.prototype.formatComments = originalTencentFormat;
  }
});
