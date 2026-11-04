import test from 'node:test';
import assert from 'node:assert/strict';
import { getComment, getSegmentComment } from '../../apis/dandan-api.js';
import { Globals } from '../../configs/globals.js';
import { getSourceByKey } from '../../sources/registry.js';
import { createHongguoEpisodeId, createHongguoSeriesId } from '../../sources/hongguo.js';
import { addAnime } from '../../utils/cache-util.js';
import { resetSearchState } from '../helpers/context.js';

const seriesId = '7675687876633316377';
const episodeId = createHongguoEpisodeId(seriesId, '111', 30);
const allEpisodesId = createHongguoSeriesId(seriesId);
const playerUrl = 'https://hongguoduanju.com/player/' + seriesId + '/111';

for (const scenario of [
  { name: '全集 ID 开启合并', url: allEpisodesId, mergeAll: true, merged: true },
  { name: '已缓存的全集 ID 关闭合并', url: allEpisodesId, mergeAll: false, merged: true },
  { name: '全集 ID 带链接偏移', url: allEpisodesId + '@10', mergeAll: true, merged: true, offset: 10 },
  { name: '单集 ID', url: episodeId, mergeAll: false, merged: false },
  { name: '单集 ID 开启合并', url: episodeId, mergeAll: true, merged: true },
  { name: '播放链接', url: playerUrl, mergeAll: false, merged: false },
  { name: '播放链接开启合并', url: playerUrl, mergeAll: true, merged: true },
]) {
  test('hongguo comment API: ' + scenario.name, async (t) => {
    resetSearchState();
    Globals.envs.logLevel = 'error';
    Globals.envs.hongguoMergeAllEpisodes = scenario.mergeAll;
    const originalDeployPlatform = Globals.deployPlatform;
    Globals.deployPlatform = 'node';
    t.after(() => {
      Globals.deployPlatform = originalDeployPlatform;
      resetSearchState();
    });
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Hongguo regression tests must not access the network');
    });

    const source = getSourceByKey('hongguo');
    source.playerEpisodeResolutions.clear();
    source.seriesDanmuCache.clear();
    t.mock.method(source, 'getEpisodes', async (id) => {
      assert.equal(id, seriesId);
      return { episodes: [
        { vid: '111', duration: 30, index: 1 },
        { vid: '222', duration: 60, index: 2 },
      ] };
    });
    const fetchWindow = t.mock.method(source, 'fetchCommentWindow', async (info, startMs) => {
      assert.equal(info.seriesId, seriesId);
      return {
        comments: [{ id: info.vid + ':' + startMs, text: 'episode-' + info.vid + '-' + startMs, offsetMs: startMs + 5000, diggCount: 0 }],
        nextStart: startMs + 30000, cursor: '', hasMore: false,
      };
    });

    const animeId = 99001;
    assert.equal(addAnime({
      animeId, bangumiId: seriesId, animeTitle: '红果合并回归测试【短剧】from hongguo',
      source: 'hongguo', type: '短剧',
      links: [{ title: '【hongguo】 全集', url: scenario.url }],
    }), true);
    const id = Globals.animes.find(anime => anime.animeId === animeId).links[0].id;
    const commentPath = '/api/v2/comment/' + id;
    const response = await getComment(commentPath, 'json', false, undefined, true);
    assert.equal(response.status, 200);
    const body = await response.json();
    const expectedTimes = scenario.merged ? [5, 35, 65] : [5];
    assert.equal(body.count, expectedTimes.length);
    assert.deepEqual(body.comments.map(comment => Number(comment.p.split(',')[0])),
      expectedTimes.map(time => time + (scenario.offset || 0)));
    assert.equal(body.videoDuration, (scenario.merged ? 90 : 30) + (scenario.offset || 0));
    assert.equal(fetchWindow.mock.callCount(), expectedTimes.length);

    Globals.commentCache.clear();
    const segmentResponse = await getComment(commentPath, 'json', true);
    const segments = (await segmentResponse.json()).comments;
    assert.equal(segments.type, 'hongguo');
    assert.equal(segments.duration, scenario.merged ? 90 : 30);
    assert.deepEqual(segments.segmentList.map(segment => [segment.segment_start, segment.segment_end]),
      scenario.merged ? [[0, 30], [30, 60], [60, 90]] : [[0, 30]]);
    if (scenario.merged) {
      assert.equal(segments.segmentList[1].url,
        createHongguoEpisodeId(seriesId, '222', 60) + '#segment=0&offset=30');
      const segmentBody = await (await getSegmentComment(segments.segmentList[1], 'json')).json();
      assert.equal(segmentBody.count, 1);
      assert.equal(Number(segmentBody.comments[0].p.split(',')[0]), 35);
      assert.equal(segmentBody.comments[0].m, 'episode-222-0');
    }
  });
}
