// 自动匹配映射表：规则解析与命中
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { getComment, matchAnime } from '../../apis/dandan-api.js';
import { Globals } from '../../configs/globals.js';
import TencentSource from '../../sources/tencent.js';
import AIClient from '../../utils/ai-util.js';
import { candidateMatchesMappingQualifiers, candidateMatchesMappingTitle, parseAutoMatchMappingRules, resolveAutoMatchMapping } from '../../utils/auto-match-mapping-util.js';
import { hasSeasonSpecificPreference } from '../../utils/cache-util.js';
import { parseResponse } from '../helpers/context.js';
import { createFavoriteAnime, resetFavoriteState } from '../helpers/favorites.js';

test('auto match mapping table', async t => {
    await t.test('falls back when Unicode property escapes are unavailable', async () => {
      const NativeRegExp = globalThis.RegExp;
      globalThis.RegExp = function (pattern, flags) {
        if (String(pattern).includes('\\p{')) throw new SyntaxError('Unicode property escapes are unavailable');
        return new NativeRegExp(pattern, flags);
      };

      try {
        const compat = await import('../../utils/auto-match-mapping-util.js?unicode-properties=unavailable');
        const { rules, warnings } = compat.parseAutoMatchMappingRules('進撃の巨人 S01E01->ＳＰＹ×ＦＡＭＩＬＹ S01E03');

        assert.deepEqual(warnings, []);
        assert.equal(compat.resolveAutoMatchMapping(rules, { title: '進撃の 巨人！', season: 1, episode: 2 }).targetEpisode, 4);
        assert.equal(compat.candidateMatchesMappingTitle({ animeTitle: 'SPY FAMILY' }, rules[0]), true);
      } finally {
        globalThis.RegExp = NativeRegExp;
      }
    });

    await t.test('parses and resolves open, bounded, qualified, and platform rules', () => {
      const { rules, warnings } = parseAutoMatchMappingRules([
        '永生 S05E02->永生 S01E58',
        '永生 S05E02~03->永生 S01E58~59',
        '海贼王 S2E1->航海王(1999)【动漫】 S1E62',
        '航海王 S1E1->航海王 S1E1 @qiyi'
      ].join(';'), Globals.envs.allowedPlatforms);

      assert.deepEqual(warnings, []);
      assert.equal(rules.length, 4);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 2 }).bounded, true);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 3 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 4 }).targetEpisode, 60);
      assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 6, episode: 1 }), null);

      const qualified = rules[2];
      assert.equal(qualified.targetTitle, '航海王');
      assert.equal(qualified.targetYear, 1999);
      assert.equal(qualified.targetType, '动漫');
      assert.equal(rules[3].targetPlatform, 'qiyi');
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '航海王(1999)【动漫】from tencent',
        typeDescription: '动漫',
        startDate: '1999-10-20T00:00:00.000Z'
      }, qualified), true);
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '航海王(2000)【动漫】from tencent',
        typeDescription: '动漫',
        startDate: '2000-01-01T00:00:00.000Z'
      }, qualified), false);
      assert.equal(candidateMatchesMappingTitle({ animeTitle: '航海王 第二季(1999)【动漫】from tencent' }, qualified), true);
      assert.equal(candidateMatchesMappingTitle({ animeTitle: '海贼王(1999)【动漫】from tencent' }, qualified), false);

      const boundedOnly = parseAutoMatchMappingRules('永生 S05E02~03->永生 S01E58~59').rules;
      assert.equal(resolveAutoMatchMapping(boundedOnly, { title: '永生', season: 5, episode: 3 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(boundedOnly, { title: '永生', season: 5, episode: 4 }), null);

      const narutoRule = parseAutoMatchMappingRules('火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59').rules[0];
      assert.equal(resolveAutoMatchMapping([narutoRule], { title: '火影忍者', season: 1, episode: 57 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping([narutoRule], { title: '火影忍者', season: 1, episode: 58 }).targetEpisode, 60);
      assert.equal(candidateMatchesMappingQualifiers({
        animeTitle: '火影忍者疾风传(2007)【动漫】from 360',
        typeDescription: '动漫',
        startDate: '2007-02-15T00:00:00.000Z'
      }, narutoRule), true);
    });

    await t.test('rejects invalid ranges and keeps declaration order for equal specificity', () => {
      const parsed = parseAutoMatchMappingRules([
        '测试 S01E02~04->测试 S01E10~11',
        '测试 S01E02~03->测试 S01E20~21',
        '测试 S01E02~03->测试 S01E30~31'
      ].join(';'));
      assert.equal(parsed.warnings.length, 1);
      assert.equal(parsed.rules.length, 2);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '测试', season: 1, episode: 2 }).targetEpisode, 20);
    });

    await t.test('uses the latest open-rule transition for repeated source title and season', () => {
      const parsed = parseAutoMatchMappingRules([
        '一念永恒 S01E53->一念永恒 S02E01',
        '一念永恒 S01E107->一念永恒 S03E01',
        '一念永恒 S01E166->一念永恒 完结季 S01E01'
      ].join(';'));

      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 52 }), null);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 53 }).targetSeason, 2);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 106 }).targetEpisode, 54);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 107 }).targetSeason, 3);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 165 }).targetEpisode, 59);
      assert.equal(resolveAutoMatchMapping(parsed.rules, { title: '一念永恒', season: 1, episode: 166 }).targetTitle, '一念永恒 完结季');
    });

    await t.test('maps match input, honors qualifiers and manual season preference, then falls back to original', async () => {
      const originalSearch = TencentSource.prototype.search;
      const originalHandleAnimes = TencentSource.prototype.handleAnimes;
      const originalGetComments = TencentSource.prototype.getComments;
      const originalAiAsk = AIClient.prototype.ask;
      const originalOrder = Globals.envs.sourceOrderArr;
      const originalAiValid = Globals.aiValid;
      let searchKeywords = [];
      let aiMatchInput = null;
      let scenario = 'open';

      TencentSource.prototype.search = async keyword => {
        searchKeywords.push(keyword);
        return [{ keyword }];
      };
      TencentSource.prototype.handleAnimes = async (_source, title, results, details) => {
        const add = anime => {
          results.push(anime);
          details.set(String(anime.animeId), anime);
        };
        if (scenario === 'fallback' && title === '缺失目标') return;
        if (scenario === 'qualified' && title === '航海王') {
          add(createFavoriteAnime('无关动漫(1999)【动漫】from tencent', 70, 930000));
          add(createFavoriteAnime('航海王(2000)【动漫】from tencent', 70, 930001));
          add(createFavoriteAnime('航海王(1999)【动漫】from tencent', 70, 930002));
          return;
        }
        if (scenario === 'platform') {
          const qqAnime = createFavoriteAnime(title, 2, 930004);
          const qiyiAnime = createFavoriteAnime(title, 2, 930005);
          qiyiAnime.source = 'iqiyi';
          qiyiAnime.links.forEach(link => { link.title = link.title.replace('【qq】', '【qiyi】'); });
          add(qqAnime);
          add(qiyiAnime);
          return;
        }
        if (scenario === 'naruto') {
          if (title === '火影忍者 疾风传') {
            add(createFavoriteAnime('火影忍者疾风传(2007)【动漫】from 360', 70, 930006));
          } else {
            add(createFavoriteAnime('火影忍者(2002)【动漫】from 360', 70, 930007));
          }
          return;
        }
        add(createFavoriteAnime(title, 70, 930003));
      };
      TencentSource.prototype.getComments = async () => [{ p: '1,1,16777215,test', m: 'mapping-test' }];
      Globals.envs.sourceOrderArr = ['tencent'];

      const runMatch = async (env, fileName, useAi = false) => {
        resetFavoriteState(env);
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.aiValid = useAi;
        const request = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName })
        });
        return parseResponse(await matchAnime(new URL(request.url), request, '127.0.0.1'));
      };

      try {
        searchKeywords = [];
        scenario = 'open';
        let body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S05E03');
        assert.equal(body.matches[0].episodeId, 9300030 + 59);
        assert.deepEqual(searchKeywords, ['永生']);
        await getComment(`/api/v2/comment/${body.matches[0].episodeId}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 5), false);
        await getComment(`/api/v2/comment/${9300030 + 60}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 5), true);
        assert.match(Globals.lastSelectMap.get('永生').offsets['5'], /^3:/);

        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S06E01');
        assert.equal(body.matches[0].episodeId, 9300030 + 1);
        await getComment(`/api/v2/comment/${body.matches[0].episodeId}`, 'json', false, '127.0.0.1');
        assert.equal(hasSeasonSpecificPreference('永生', 6), false);

        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { default: 930003 },
          sourceBySeason: { default: 'tencent' }
        });
        const defaultPreferenceRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(defaultPreferenceRequest.url), defaultPreferenceRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 59);

        AIClient.prototype.ask = async prompt => {
          aiMatchInput = JSON.parse(prompt);
          return JSON.stringify({ animeIndex: 0 });
        };
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' }, '永生 S05E03', true);
        assert.equal(body.matches[0].episodeId, 9300030 + 59);
        assert.deepEqual(
          { title: aiMatchInput.title, season: aiMatchInput.season, episode: aiMatchInput.episode },
          { title: '永生', season: 1, episode: 59 }
        );
        AIClient.prototype.ask = originalAiAsk;
        Globals.aiValid = false;

        scenario = 'qualified';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '海贼王 S02E01->航海王(1999)【动漫】 S01E62' }, '海贼王 S02E01');
        assert.equal(body.matches[0].animeId, 930002);
        assert.equal(body.matches[0].episodeId, 9300020 + 62);

        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '海贼王 S02E01->航海王(1998)【动漫】 S01E62' }, '海贼王 S02E01');
        assert.equal(body.matches[0].animeId, 930001);

        scenario = 'platform';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '航海王 S01E01->航海王 S01E01 @qiyi' }, '航海王 S01E01 @qq');
        assert.equal(body.matches[0].animeId, 930005);

        scenario = 'naruto';
        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '火影忍者 S01E57->火影忍者 疾风传(2007)【日番】 S01E59' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('火影忍者', {
          animeIds: [930007],
          preferBySeason: { 1: 930007 },
          sourceBySeason: { 1: '360' },
          offsets: { 1: '58:【youku】 第58集' }
        });
        assert.equal(hasSeasonSpecificPreference('火影忍者', 1), false);
        const narutoRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '火影忍者 S01E58' })
        });
        body = await parseResponse(await matchAnime(new URL(narutoRequest.url), narutoRequest, '127.0.0.1'));
        assert.equal(body.matches[0].animeId, 930006);
        assert.equal(body.matches[0].episodeId, 9300060 + 60);

        scenario = 'open';
        resetFavoriteState({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58' });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { 5: 930003 },
          sourceBySeason: { 5: 'tencent' },
          offsets: { 5: '2:【qq】 第10集' },
          explicitBySeason: { 5: true }
        });
        assert.equal(hasSeasonSpecificPreference('永生', 5), true);
        const manualRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(manualRequest.url), manualRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 11);
        assert.equal(Globals.lastSelectMap.get('永生').explicitBySeason['5'], true);

        resetFavoriteState({
          AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->永生 S01E58',
          REMEMBER_LAST_SELECT: 'false'
        });
        Globals.envs.sourceOrderArr = ['tencent'];
        Globals.lastSelectMap.set('永生', {
          animeIds: [930003],
          preferBySeason: { 5: 930003 },
          sourceBySeason: { 5: 'tencent' },
          offsets: { 5: '2:【qq】 第10集' },
          explicitBySeason: { 5: true }
        });
        const disabledPreferenceRequest = new Request('http://localhost/api/v2/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: '永生 S05E03' })
        });
        body = await parseResponse(await matchAnime(new URL(disabledPreferenceRequest.url), disabledPreferenceRequest, '127.0.0.1'));
        assert.equal(body.matches[0].episodeId, 9300030 + 59);

        searchKeywords = [];
        scenario = 'fallback';
        body = await runMatch({ AUTO_MATCH_MAPPING_TABLE: '原始剧 S01E01->缺失目标 S01E01' }, '原始剧 S01E01');
        assert.equal(body.matches[0].animeTitle, '原始剧');
        assert.deepEqual(searchKeywords, ['缺失目标', '原始剧']);
      } finally {
        TencentSource.prototype.search = originalSearch;
        TencentSource.prototype.handleAnimes = originalHandleAnimes;
        TencentSource.prototype.getComments = originalGetComments;
        AIClient.prototype.ask = originalAiAsk;
        Globals.envs.sourceOrderArr = originalOrder;
        Globals.aiValid = originalAiValid;
      }
    });
  });
