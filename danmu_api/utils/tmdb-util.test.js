import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTmdbSeasonBoundaries } from './tmdb-util.js';
import { resolveTmdbEpisodeMapping, matchesSeasonBoundary } from './episode-mapping-util.js';

const fixture = JSON.parse(readFileSync(new URL('../test-fixtures/rezero-bangumi.json', import.meta.url)));
const matches = fixture.items.flatMap(item => item.sites.map(site => ({
  ...item, titles: [item.title, ...Object.values(item.titleTranslate || {}).flat()],
  matchedSiteKey: site.site, siteId: site.id
})));

test('TMDB boundaries merge Re:Zero cours and duplicate series links into real seasons', () => {
  const boundaries = buildTmdbSeasonBoundaries(matches);
  assert.deepEqual(boundaries.map(b => [b.order, b.startEpisode]), [[1, 1], [2, 26], [3, 51], [4, 67]]);
  for (const [absolute, season, episode] of [[25, 1, 25], [26, 2, 1], [27, 2, 2], [39, 2, 14], [40, 2, 15], [50, 2, 25], [51, 3, 1], [55, 3, 5], [66, 3, 16], [67, 4, 1], [68, 4, 2], [78, 4, 12], [84, 4, 18]]) {
    const mapped = resolveTmdbEpisodeMapping(boundaries, 1, absolute);
    if (season === 1) assert.equal(mapped, null);
    else assert.deepEqual([mapped.season, mapped.episode], [season, episode], `E${absolute}`);
  }
  assert.equal(resolveTmdbEpisodeMapping(boundaries, 4, 18), null);
  assert.equal(resolveTmdbEpisodeMapping(null, 1, 84), null);
  const fourth = boundaries[3];
  assert.equal(matchesSeasonBoundary({ animeTitle: 'Re：从零开始的异世界生活 第四季' }, fourth), true);
  assert.equal(matchesSeasonBoundary({ animeTitle: 'Re：从零开始的异世界生活 第四季 丧失篇' }, fourth), true);
  for (const suffix of [' Part 2', ' 休息时间', ' 夺还篇']) {
    assert.equal(matchesSeasonBoundary({ animeTitle: `Re：从零开始的异世界生活 第四季${suffix}`, aliases: ['Re：从零开始的异世界生活 第四季'] }, fourth), false);
  }
  for (const extra of ['休息时间 ', 'Part 2 ']) {
    assert.equal(matchesSeasonBoundary({ animeTitle: `Re：从零开始的异世界生活 ${extra}第四季`, aliases: ['Re：从零开始的异世界生活 第四季'] }, fourth), false);
  }
  assert.deepEqual(buildTmdbSeasonBoundaries([...matches].reverse()), boundaries);
});

test('TMDB boundaries reject ambiguous or incomplete evidence', () => {
  const row = (title, start, titles = [title], id = '65942') => ({
    title, titles, type: 'tv', matchedSiteKey: 'tmdb', siteId: start === 1 ? `tv/${id}` : `tv/${id}/season/1/episode/${start}`
  });
  const base = row('Example', 1);
  const second = row('Example 2nd Season', 26);
  assert.equal(buildTmdbSeasonBoundaries([base, row('Example Part 2', 26)]), null);
  assert.equal(buildTmdbSeasonBoundaries([base, row('Example Season 3', 51)]), null);
  assert.equal(buildTmdbSeasonBoundaries([base, second, row('Example Season 3', 26)]), null);
  assert.equal(buildTmdbSeasonBoundaries([base, row('Example Season 2', 26, ['Example Season 2', 'Example 第三季'])]), null);
  assert.equal(buildTmdbSeasonBoundaries([base, second, row('Example Season 2 Part 2', 60), row('Example Season 3', 51)]), null);
  assert.equal(buildTmdbSeasonBoundaries([base, second, { ...second, siteId: 'tv/65942/season/1/episode/29' }]), null);
  const other = [row('Other', 1, ['Other'], '123'), row('Other Season 2', 13, ['Other Season 2'], '123')];
  assert.equal(buildTmdbSeasonBoundaries([base, second, ...other]), null);
  assert.deepEqual(buildTmdbSeasonBoundaries([base, second, ...other], { tvId: 65942 }).map(b => b.startEpisode), [1, 26]);
  assert.equal(buildTmdbSeasonBoundaries([base, second], { tvId: 999 }), null);
  assert.equal(buildTmdbSeasonBoundaries([base, { ...second, siteId: 'tv/65942/season/2/episode/1' }]), null);
});

