import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSameEpisodeTitle, matchAniAndEp } from './dandan-api.js';
import { Globals } from '../configs/globals.js';

test('episode-number deduplication should preserve matching candidates when needed', () => {
    const episodes = [
      { episodeId: 'imgo-1', episodeTitle: '【imgo】第1集 初遇' },
      { episodeId: 'qq-1', episodeTitle: '【qq】第1集 重逢' },
      { episodeId: 'qq-1-copy', episodeTitle: '【qq】第1集 重逢' },
      { episodeId: 'imgo-2', episodeTitle: '【imgo】第2集' }
    ];

    const defaultFiltered = filterSameEpisodeTitle(episodes);
    assert.deepEqual(defaultFiltered.map(item => item.episodeId), ['imgo-1', 'imgo-2']);

    const preferredFiltered = filterSameEpisodeTitle(episodes, { preferredPlatform: 'qq' });
    assert.deepEqual(preferredFiltered.map(item => item.episodeId), ['qq-1', 'imgo-2']);

    const hintCandidates = filterSameEpisodeTitle(episodes, { preserveNumberVariants: true });
    assert.deepEqual(hintCandidates.map(item => item.episodeId), ['imgo-1', 'qq-1', 'imgo-2']);
  });


test('normal matching keeps the requested platform even when another platform appears first', async () => {
  Globals.init({ REMEMBER_LAST_SELECT: 'false' });
  const anime = { animeId: 7781, bangumiId: '7781', animeTitle: '平台测试', source: '360', type: 'tvseries', episodeCount: 2, links: [
    { id: 11, title: '【imgo】 第1集', url: 'https://www.mgtv.com/b/test/1.html' },
    { id: 12, title: '【qq】 第1集', url: 'https://v.qq.com/x/cover/test/1.html' },
    { id: 13, title: '【qq】 第2集', url: 'https://v.qq.com/x/cover/test/2.html' }
  ] };
  const result = await matchAniAndEp(1, 1, null, { animes: [anime] }, '平台测试', new Request('http://localhost/api/v2/match'), 'qq', null, null, new Map([['7781', anime]]));
  assert.match(result.resEpisode.episodeTitle, /【qq】/);
});
