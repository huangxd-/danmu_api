// 自动匹配接口 POST /api/v2/match 的离线端到端测试：请求校验、响应契约、fileName 解析、平台优选、映射、spillover、AI 与收藏联动
// 全部用例只依赖打桩的源实例与本地缓存，不发起任何真实网络请求。

import test from 'node:test';
import assert from 'node:assert';
import { matchAnime } from '../../apis/dandan-api.js';
import { Globals } from '../../configs/globals.js';
import TencentSource from '../../sources/tencent.js';
import AIClient from '../../utils/ai-util.js';
import { addFavorite } from '../../utils/favorite-util.js';
import { getLastSearch, setLastSearch } from '../../utils/cache-util.js';
import { parseResponse } from '../helpers/context.js';
import { createFavoriteAnime, resetFavoriteState } from '../helpers/favorites.js';

test('POST /api/v2/match 自动匹配接口（离线）', async t => {

  const originalSearch = TencentSource.prototype.search;
  const originalHandleAnimes = TencentSource.prototype.handleAnimes;
  const originalGetComments = TencentSource.prototype.getComments;
  const originalAiAsk = AIClient.prototype.ask;
  const originalAiValid = Globals.aiValid;
  const originalAiMatchPrompt = Globals.aiMatchPrompt;

  // 打桩状态：scenario 决定造哪些候选，episodeCount 决定候选集数
  let scenario = 'basic';
  let episodeCount = 3;
  let searchCalls = [];

  const addCandidate = (results, details, anime) => {
    results.push(anime);
    details.set(String(anime.animeId), anime);
  };

  TencentSource.prototype.search = async (keyword, preferAnimeId, preferSource) => {
    searchCalls.push({ keyword, preferAnimeId, preferSource });
    return [{ keyword }];
  };

  TencentSource.prototype.handleAnimes = async (_source, title, results, details) => {
    if (scenario === 'empty') return;
    if (scenario === 'cacheWarning') {
      // 隔离 detailStore 上的缓存写入失败原因会被合并回主 detailStore
      details.__addAnimeError = 'mock 缓存写入失败';
      return;
    }
    if (scenario === 'platform') {
      const qqAnime = createFavoriteAnime(title, episodeCount, 930004);
      const qiyiAnime = createFavoriteAnime(title, episodeCount, 930005);
      qiyiAnime.source = 'iqiyi';
      qiyiAnime.links.forEach(link => { link.title = link.title.replace('【qq】', '【qiyi】'); });
      addCandidate(results, details, qqAnime);
      addCandidate(results, details, qiyiAnime);
      return;
    }
    if (scenario === 'year') {
      addCandidate(results, details, createFavoriteAnime('剧名(1999)【TV】from tencent', 3, 930010));
      addCandidate(results, details, createFavoriteAnime('剧名(2000)【TV】from tencent', 3, 930011));
      return;
    }
    if (scenario === 'year2000') {
      addCandidate(results, details, createFavoriteAnime('剧名(2000)【TV】from tencent', 3, 930011));
      return;
    }
    if (scenario === 'twoSeasons') {
      // 两个候选的标题都不含季号，resolveCandidateSeason 都解析为第 1 季
      addCandidate(results, details, createFavoriteAnime('测试剧 第二季', 12, 930020));
      addCandidate(results, details, createFavoriteAnime('测试剧 第三季', 12, 930021));
      return;
    }
    if (scenario === 'cacheWarningHit') {
      details.__addAnimeError = 'mock 缓存写入失败';
      addCandidate(results, details, createFavoriteAnime(title, episodeCount, 930003));
      return;
    }
    addCandidate(results, details, createFavoriteAnime(title, episodeCount, 930003));
  };

  TencentSource.prototype.getComments = async () => [{ p: '1,1,16777215', m: 'x' }];
  AIClient.prototype.ask = async () => { throw new Error('AI 不应在未开启时被调用'); };

  // 每个用例开始都重置全局状态；requestHistory 清空保证不会提前命中测试外的最近搜索记录
  const runMatch = async ({
    env = {},
    clientIp = '127.0.0.1',
    body = {},
    scn = 'basic',
    epCount = 3,
    ai = null,
    table = '',
    prepare = null
  } = {}) => {
    resetFavoriteState({
      AUTO_MATCH_MAPPING_TABLE: table,
      ANIME_TITLE_SIMPLIFIED: 'false',
      LOG_LEVEL: 'error',
      ...env
    });
    Globals.envs.sourceOrderArr = ['tencent'];
    Globals.requestHistory = new Map();
    scenario = scn;
    episodeCount = epCount;
    searchCalls = [];
    Globals.aiValid = ai === null ? false : true;
    if (ai !== null) Globals.aiMatchPrompt = ai;
    if (prepare) prepare();
    const request = new Request('http://localhost/api/v2/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const response = await matchAnime(new URL(request.url), request, clientIp);
    return { status: response.status, body: await parseResponse(response) };
  };

  const runRawBody = async (rawBody, clientIp = 'raw-ip') => {
    resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '', LOG_LEVEL: 'error' });
    Globals.envs.sourceOrderArr = ['tencent'];
    Globals.requestHistory = new Map();
    scenario = 'basic';
    episodeCount = 3;
    Globals.aiValid = false;
    const request = new Request('http://localhost/api/v2/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody
    });
    const response = await matchAnime(new URL(request.url), request, clientIp);
    return { status: response.status, body: await parseResponse(response) };
  };

  try {
    await t.test('A 请求校验：非法 JSON、空请求体与缺失 fileName', async () => {
      const invalidJson = await runRawBody('not-json', 'a1-ip');
      assert.equal(invalidJson.status, 400);
      assert.equal(invalidJson.body.success, false);
      assert.equal(invalidJson.body.errorCode, 400);
      assert.equal(typeof invalidJson.body.errorMessage, 'string');
      assert.ok(invalidJson.body.errorMessage.length > 0);

      const nullBody = await runRawBody('null', 'a2-ip');
      assert.equal(nullBody.status, 400);
      assert.deepStrictEqual(nullBody.body, {
        errorCode: 400,
        success: false,
        errorMessage: 'Empty request body'
      });

      const missingFileName = await runMatch({ body: {}, clientIp: 'a3-ip' });
      assert.equal(missingFileName.status, 400);
      assert.deepStrictEqual(missingFileName.body, {
        errorCode: 400,
        success: false,
        errorMessage: 'Missing fileName parameter'
      });
    });

    await t.test('A 额外字段被忽略：只读 fileName', async () => {
      const fileName = '无忧渡.S01E01.2160p.WEB-DL.H265.DDP.5.1';
      const onlyFileName = await runMatch({ body: { fileName }, clientIp: 'a4a-ip' });
      const withExtras = await runMatch({
        body: { fileName, matchMode: 'fileNameOnly', fileHash: 'deadbeef', fileSize: 0, videoDuration: 0 },
        clientIp: 'a4b-ip'
      });

      assert.equal(withExtras.status, 200);
      assert.equal(withExtras.body.isMatched, true);
      assert.deepStrictEqual(withExtras.body, onlyFileName.body);
    });

    await t.test('B 响应契约：命中时字段与源候选一致且 shift 为 0', async () => {
      const { status, body } = await runMatch({
        body: { fileName: '无忧渡.S01E01.2160p.WEB-DL.H265.DDP.5.1' },
        clientIp: 'b1-ip'
      });

      assert.equal(status, 200);
      assert.equal(body.errorCode, 0);
      assert.equal(body.success, true);
      assert.equal(body.isMatched, true);
      assert.equal(body.errorMessage, '');
      assert.equal(body.matches.length, 1);

      const [match] = body.matches;
      assert.deepStrictEqual(match, {
        episodeId: 9300031,
        animeId: 930003,
        animeTitle: '无忧渡',
        episodeTitle: '【qq】 第1集',
        type: 'tvseries',
        typeDescription: 'TV',
        shift: 0,
        imageUrl: 'https://example.com/favorite.jpg',
        url: 'https://v.qq.com/x/cover/favorite/ep1.html'
      });
    });

    await t.test('B 空候选：不匹配且不写最近搜索', async () => {
      const { status, body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'b2-ip',
        scn: 'empty'
      });

      assert.equal(status, 200);
      assert.equal(body.errorCode, 0);
      assert.equal(body.success, true);
      assert.equal(body.isMatched, false);
      assert.deepStrictEqual(body.matches, []);
      assert.equal(body.errorMessage, '');
      assert.equal(getLastSearch('b2-ip'), undefined);
    });

    await t.test('C fileName 解析：搜索关键词与集号', async () => {
      const { body } = await runMatch({
        body: { fileName: '无忧渡.S01E01.2160p.WEB-DL.H265.DDP.5.1' },
        clientIp: 'c1-ip'
      });

      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
      assert.equal(body.matches[0].episodeTitle, '【qq】 第1集');
      assert.deepStrictEqual(searchCalls.map(call => call.keyword), ['无忧渡']);
    });

    await t.test('C/G 平台优选：@qiyi 选中 qiyi 候选，无 @ 时选中 qq 候选', async () => {
      const preferred = await runMatch({
        body: { fileName: '航海王 S01E01 @qiyi' },
        clientIp: 'c2-ip',
        scn: 'platform'
      });
      // 平台标签由 parseFileName 剥离，不进搜索关键词；preferredPlatform 变为平台遍历首位
      assert.deepStrictEqual(preferred.body.matches[0], {
        episodeId: 9300051,
        animeId: 930005,
        animeTitle: '航海王',
        episodeTitle: '【qiyi】 第1集',
        type: 'tvseries',
        typeDescription: 'TV',
        shift: 0,
        imageUrl: 'https://example.com/favorite.jpg',
        url: 'https://v.qq.com/x/cover/favorite/ep1.html'
      });
      assert.deepStrictEqual(searchCalls.map(call => call.keyword), ['航海王']);
      assert.equal(searchCalls[0].preferSource, undefined);

      const noPreference = await runMatch({
        body: { fileName: '航海王 S01E01' },
        clientIp: 'g1-ip',
        scn: 'platform'
      });
      assert.equal(noPreference.body.matches[0].animeId, 930004);
      assert.equal(noPreference.body.matches[0].episodeTitle, '【qq】 第1集');
    });

    await t.test('C 只有标题：季集为 null 且仍能命中', async () => {
      const { body } = await runMatch({ body: { fileName: '无忧渡' }, clientIp: 'c3-ip' });

      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
      const lastSearch = getLastSearch('c3-ip');
      assert.equal(lastSearch.title, '无忧渡');
      assert.equal(lastSearch.season, null);
      assert.equal(lastSearch.episode, null);
      assert.equal(lastSearch.episodeId, 9300031);
    });

    await t.test('C 年份过滤：命中同年候选，只有异年候选时不匹配', async () => {
      const matched = await runMatch({
        body: { fileName: '剧名(1999) S01E01' },
        clientIp: 'c4-ip',
        scn: 'year'
      });
      assert.equal(matched.body.isMatched, true);
      assert.equal(matched.body.matches[0].animeId, 930010);
      assert.equal(matched.body.matches[0].animeTitle, '剧名(1999)【TV】from tencent');

      const yearMismatch = await runMatch({
        body: { fileName: '剧名(1999) S01E01' },
        clientIp: 'c5-ip',
        scn: 'year2000'
      });
      assert.equal(yearMismatch.body.isMatched, false);
      assert.deepStrictEqual(yearMismatch.body.matches, []);
    });

    await t.test('D 普通命中写入最近搜索且不带映射标记', async () => {
      const { body } = await runMatch({
        body: { fileName: '无忧渡.S01E01.2160p.WEB-DL.H265.DDP.5.1' },
        clientIp: 'd1-ip'
      });

      const lastSearch = getLastSearch('d1-ip');
      assert.deepStrictEqual(Object.keys(lastSearch).sort(), ['episode', 'episodeId', 'season', 'timestamp', 'title']);
      assert.equal(lastSearch.title, '无忧渡');
      assert.equal(lastSearch.season, 1);
      assert.equal(lastSearch.episode, 1);
      assert.equal(lastSearch.episodeId, body.matches[0].episodeId);
      assert.equal(lastSearch.episodeId, 9300031);
      assert.equal('autoMatchMappingApplied' in lastSearch, false);
    });

    await t.test('D 映射命中写入原始标题季集与映射后集 id', async () => {
      const { body } = await runMatch({
        table: '永生 S05E02->永生 S01E58',
        body: { fileName: '永生 S05E03' },
        clientIp: 'd2-ip',
        epCount: 70
      });

      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300089);
      assert.equal(body.matches[0].episodeTitle, '【qq】 第59集');

      const lastSearch = getLastSearch('d2-ip');
      assert.equal(lastSearch.title, '永生');
      assert.equal(lastSearch.season, 5);
      assert.equal(lastSearch.episode, 3);
      assert.equal(lastSearch.episodeId, 9300089);
      assert.equal(lastSearch.autoMatchMappingApplied, true);
      assert.equal(lastSearch.mappingTargetTitle, '永生');
    });

    await t.test('D clientIp 为空时不写最近搜索', async () => {
      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: ''
      });

      assert.equal(body.isMatched, true);
      assert.equal(getLastSearch(''), undefined);
    });

    await t.test('D 超出本季集数：跨季顺延到下一季并写入最近搜索', async () => {
      const sentinel = { title: '旧', season: 1, episode: 1, episodeId: 1 };

      // 两个候选的季号都无法从标题解析，resolveCandidateSeason 均为第 1 季，
      // 与请求的 S2 不一致 → 常规季集匹配落空，走 findCrossSeasonEpisodeMap 顺延
      const { status, body } = await runMatch({
        body: { fileName: '测试剧 S02E15' },
        clientIp: 'd4-ip',
        scn: 'twoSeasons',
        epCount: 12,
        prepare: () => { setLastSearch('d4-ip', sentinel); }
      });

      assert.equal(status, 200);
      assert.equal(body.isMatched, true);
      // 第二季 12 集，S02E15 相对排位顺延到第三季第 3 集（animeId 930021 的第 3 条 link）
      assert.equal(body.matches[0].animeTitle, '测试剧 第三季');
      assert.equal(body.matches[0].animeId, 930021);
      assert.equal(body.matches[0].episodeId, 9300213);
      assert.equal(body.matches[0].episodeTitle, '【qq】 第3集');

      // 实测：该路由经 matchAniAndEp 内部的跨季顺延，spilloverMatched 保持 false，
      // 因此最近搜索仍按普通命中写入，覆盖调用方此前的值。
      const lastSearch = getLastSearch('d4-ip');
      assert.equal(lastSearch.title, '测试剧');
      assert.equal(lastSearch.season, 2);
      assert.equal(lastSearch.episode, 15);
      assert.equal(lastSearch.episodeId, 9300213);
      assert.equal('autoMatchMappingApplied' in lastSearch, false);
    });

    await t.test('E 缓存写入告警：未命中时经 errorMessage 暴露', async () => {
      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'e1-ip',
        scn: 'cacheWarning'
      });

      assert.equal(body.isMatched, false);
      assert.deepStrictEqual(body.matches, []);
      assert.equal(body.errorMessage, 'mock 缓存写入失败');
    });

    await t.test('E 缓存写入告警：命中时不暴露', async () => {
      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'e2-ip',
        scn: 'cacheWarningHit'
      });

      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
      assert.equal(body.errorMessage, '');
    });

    await t.test('F AI 分支：未开启时不调用模型', async () => {
      let aiCalls = 0;
      AIClient.prototype.ask = async () => { aiCalls++; return JSON.stringify({ animeIndex: 0 }); };

      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'f1-ip'
      });

      assert.equal(aiCalls, 0);
      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
    });

    await t.test('F AI 分支：开启后选中候选，结果与普通匹配一致', async () => {
      let aiCalls = 0;
      AIClient.prototype.ask = async () => { aiCalls++; return JSON.stringify({ animeIndex: 0 }); };

      const normal = await runMatch({ body: { fileName: '无忧渡 S01E01' }, clientIp: 'f2a-ip' });
      const withAi = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'f2b-ip',
        ai: '你是匹配专家'
      });

      assert.equal(aiCalls, 1);
      assert.deepStrictEqual(withAi.body.matches, normal.body.matches);
      assert.equal(withAi.body.matches[0].episodeId, 9300031);
    });

    await t.test('F AI 分支：模型抛错时回落普通匹配', async () => {
      let aiCalls = 0;
      AIClient.prototype.ask = async () => { aiCalls++; throw new Error('mock AI 不可用'); };

      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'f3a-ip',
        ai: '你是匹配专家'
      });

      assert.equal(aiCalls, 1);
      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
    });

    await t.test('F AI 分支：返回非 JSON 时回落普通匹配', async () => {
      let aiCalls = 0;
      AIClient.prototype.ask = async () => { aiCalls++; return 'not a json'; };

      const { body } = await runMatch({
        body: { fileName: '无忧渡 S01E01' },
        clientIp: 'f3b-ip',
        ai: '你是匹配专家'
      });

      assert.equal(aiCalls, 1);
      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].episodeId, 9300031);
    });

    await t.test('H 收藏联动：普通命中按 标题_S季 命中收藏', async () => {
      const { body } = await runMatch({
        body: { fileName: 'X S01E02' },
        clientIp: 'h1-ip',
        prepare: () => {
          const favoriteAnime = createFavoriteAnime('X', 3, 930050);
          const { links, ...favoriteResult } = favoriteAnime;
          addFavorite('X_S1', [favoriteResult], [favoriteAnime]);
        }
      });

      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].animeTitle, 'X');
      assert.equal(body.matches[0].episodeId, 9300502);
      assert.equal(body.matches[0].isFavorite, true);
    });

    await t.test('H 收藏联动：映射命中用原始标题季查收藏', async () => {
      const { body } = await runMatch({
        table: '原始剧 S05E01->目标剧 S01E01',
        body: { fileName: '原始剧 S05E01' },
        clientIp: 'h2-ip',
        epCount: 70,
        prepare: () => {
          const favoriteAnime = createFavoriteAnime('原始剧', 70, 930060);
          const { links, ...favoriteResult } = favoriteAnime;
          addFavorite('原始剧_S5', [favoriteResult], [favoriteAnime]);
        }
      });

      // 映射目标标题是"目标剧"，收藏键是"原始剧_S5"：命中说明查收藏用的是原始标题 + 原始季
      assert.equal(body.isMatched, true);
      assert.equal(body.matches[0].animeTitle, '目标剧');
      assert.equal(body.matches[0].episodeId, 9300031);
      assert.equal(body.matches[0].isFavorite, true);
      // 对照：收藏键换成一个既不等于原始标题季、也不等于映射目标的键时不应带 isFavorite
      const unmatchedFavorite = await runMatch({
        table: '原始剧 S05E01->目标剧 S01E01',
        body: { fileName: '原始剧 S05E01' },
        clientIp: 'h3-ip',
        epCount: 70,
        prepare: () => {
          const favoriteAnime = createFavoriteAnime('无关剧', 70, 930060);
          const { links, ...favoriteResult } = favoriteAnime;
          addFavorite('无关剧_S5', [favoriteResult], [favoriteAnime]);
        }
      });
      assert.equal(unmatchedFavorite.body.isMatched, true);
      assert.equal('isFavorite' in unmatchedFavorite.body.matches[0], false);
    });

    await t.test('I 源搜索抛错：降级为未匹配且不抛异常', async () => {
      resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '', LOG_LEVEL: 'error' });
      Globals.envs.sourceOrderArr = ['tencent'];
      Globals.requestHistory = new Map();
      Globals.aiValid = false;

      const failingSearch = async () => { throw new Error('mock 源搜索失败'); };
      TencentSource.prototype.search = failingSearch;

      try {
        const request = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '无忧渡 S01E01' })
        });
        const response = await matchAnime(new URL(request.url), request, 'i-ip');
        const body = await parseResponse(response);

        assert.equal(response.status, 200);
        assert.equal(body.errorCode, 0);
        assert.equal(body.success, true);
        assert.equal(body.isMatched, false);
        assert.deepStrictEqual(body.matches, []);
        assert.equal(getLastSearch('i-ip'), undefined);
      } finally {
        TencentSource.prototype.search = originalSearch;
      }
    });
  } finally {
    TencentSource.prototype.search = originalSearch;
    TencentSource.prototype.handleAnimes = originalHandleAnimes;
    TencentSource.prototype.getComments = originalGetComments;
    AIClient.prototype.ask = originalAiAsk;
    Globals.aiValid = originalAiValid;
    Globals.aiMatchPrompt = originalAiMatchPrompt;
  }
});
