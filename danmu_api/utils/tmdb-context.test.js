import test from 'node:test';
import assert from 'node:assert/strict';

test('TMDB context validates relative and absolute season numbering, excluding specials and gaps', async t => {
  const { Globals } = await import('../configs/globals.js');
  const { getTMDBEpisodeContext } = await import('./tmdb-util.js');
  Globals.init({ TMDB_API_KEY: 'fixture-key' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let counts = [32,21,18,17,24,31,8,24,21,25,21,33,20,25,28,13,11,21,20,87];
  let seasons;
  let episodes;
  let start = 414;
  const reset = () => {
    seasons = [{ season_number: 0, episode_count: 99 }, ...counts.map((count, i) => ({ season_number: i + 1, episode_count: count }))];
    episodes = Array.from({ length: 87 }, (_, i) => ({ episode_number: start + i, season_number: 20, name: i === 0 ? '死亡边缘' : '测试' }));
  };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith('/search/tv') ? { results: [{ id: 31910, name: '火影忍者：疾风传' }] }
      : url.pathname.endsWith('/season/20') ? { season_number: 20, episodes }
      : { name: '火影忍者：疾风传', seasons };
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  };
  for (start of [414, 1]) {
    reset();
    const result = await getTMDBEpisodeContext('火影忍者：疾风传', 20, 1);
    assert.equal(result.absoluteEpisode, 414); assert.equal(result.priorEpisodeCount, 413);
    assert.equal(result.totalEpisodes, 500); assert.equal(result.episodeTitle, '死亡边缘');
    assert.equal(result.numbering, start === 1 ? 'season-relative' : 'absolute');
  }
  for (const mutate of [
    () => seasons.splice(3, 1), () => seasons.push(seasons[1]), () => { seasons[1].episode_count = 0; },
    () => episodes.splice(4, 1), () => { episodes[1].episode_number = episodes[0].episode_number; },
    () => { episodes[2].season_number = 19; }
  ]) {
    reset(); mutate(); assert.equal(await getTMDBEpisodeContext('火影忍者：疾风传', 20, 1), null);
  }
  reset(); assert.equal(await getTMDBEpisodeContext('火影忍者：疾风传', 20, 88), null);
});
