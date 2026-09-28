import test from 'node:test';
import assert from 'node:assert/strict';
import { findAiMatch } from './ai-match-util.js';

const request = { title: '火影忍者：疾风传', season: 20, episode: 1 };
const anime = { animeId: 1, animeTitle: '火影忍者疾风传(2007) from dandan', type: 'tvseries', source: 'dandan', episodeCount: 500 };
const episodes = Array.from({ length: 500 }, (_, i) => ({ episodeId: 1000 + i, episodeTitle: `第${i + 1}话 ${i === 413 ? '死亡边缘' : ''}` }));
const evidence = { titles: [request.title], season: 20, episode: 1, absoluteEpisode: 414, totalEpisodes: 500 };
const actions = [
  { action: 'search', query: request.title },
  { action: 'lookup', query: request.title },
  { action: 'episodes', candidate: 'c1', number: 414 },
  { action: 'select', candidate: 'c1', episode: 'c1e414', evidence: 'm1' }
];
async function run(steps = actions, overrides = {}) {
  let calls = 0;
  const comments = [];
  const result = await findAiMatch(request, {
    chat: async (_messages, options) => {
      assert.equal(options.thinking, false);
      calls++;
      return JSON.stringify(steps[calls - 1] || { action: 'no_match' });
    },
    search: async () => [anime], lookup: async () => evidence,
    getEpisodes: async () => episodes,
    hasComments: async ep => { comments.push(ep.episodeId); return true; },
    ...overrides
  });
  return { result, calls, comments };
}

test('AI searches sources, reads metadata and selects inspected absolute episode 414 with comments', async () => {
  const { result, comments } = await run();
  assert.equal(result.resEpisode, episodes[413]);
  assert.deepEqual(comments, [1413]);
});

test('reject invented keys, uninspected episodes and wrong numbering before requesting comments', async () => {
  for (const select of [
    { candidate: 'unknown' }, { episode: 'https://evil.invalid/episode' }, { episode: 'c1e1' }, { evidence: 'invented' }
  ]) {
    const { result, comments } = await run([...actions.slice(0, 3), { ...actions[3], ...select }]);
    assert.equal(result, null); assert.deepEqual(comments, []);
  }
  const wrong = await run([actions[0], actions[1], { ...actions[2], number: 1 }, { ...actions[3], episode: 'c1e1' }]);
  assert.equal(wrong.result, null); assert.deepEqual(wrong.comments, []);
});

test('reject spinoffs, mixed collections, missing metadata and list-position episode numbers', async () => {
  for (const overrides of [
    { search: async () => [{ ...anime, animeTitle: '火影忍者疾风传 外传', aliases: [request.title] }] },
    { search: async () => [{ ...anime, episodeCount: 720 }] },
    { search: async () => [{ ...anime, type: 'movie' }] },
    { lookup: async () => null },
    { lookup: async () => ({ ...evidence, titles: ['其他作品'] }) },
    { getEpisodes: async () => episodes.map(ep => ({ ...ep, episodeTitle: '死亡边缘', episodeNumber: 414 })) }
  ]) {
    const { result, comments } = await run(actions, overrides);
    assert.equal(result, null); assert.deepEqual(comments, []);
  }
});

test('empty comments lead AI to inspect another source for the same episode', async () => {
  const probed = [];
  const { result } = await run([...actions, { ...actions[2], candidate: 'c2' }, { ...actions[3], candidate: 'c2', episode: 'c2e414' }], {
    search: async () => [anime, { ...anime, animeId: 2 }],
    getEpisodes: async a => episodes.map(ep => ({ ...ep, sourceId: a.animeId })),
    hasComments: async ep => { probed.push(ep.sourceId); return ep.sourceId === 2; }
  });
  assert.equal(result.resAnime.animeId, 2); assert.deepEqual(probed, [1, 2]);
});

test('same-season direct match requires real episode numbers and supports no metadata', async () => {
  const { result } = await run([actions[0], { ...actions[2], number: 1 }, { ...actions[3], episode: 'c1e1', evidence: undefined }], {
    search: async () => [{ ...anime, animeTitle: `${request.title} 第二十季`, episodeCount: 87 }]
  });
  assert.equal(result.resEpisode, episodes[0]);
});

test('invalid JSON and repetitive actions have a bounded workflow', async () => {
  let calls = 0;
  const { result } = await run([], { chat: async () => { calls++; return '{'; } });
  assert.equal(result, null); assert.equal(calls, 10);
  let searches = 0;
  const repeated = await run(Array(20).fill(actions[0]), { search: async () => { searches++; return []; } });
  assert.equal(repeated.result, null); assert.equal(searches, 3); assert.equal(repeated.calls, 10);
});

test('AI resolves predecessor numbering from a unique actual episode title, not an invented offset', async () => {
  const shifted = episodes.map((ep, i) => ({ ...ep, episodeTitle: `第${i + 221}话 ${i === 413 ? '死亡边缘' : '其他标题'}` }));
  const steps = [actions[0], actions[1], { action: 'episodes', candidate: 'c1', title: '死亡边缘' }, actions[3]];
  const options = { getEpisodes: async () => shifted, lookup: async () => ({ ...evidence, episodeTitle: '死亡边缘' }) };
  const { result } = await run(steps, options);
  assert.match(result.resEpisode.episodeTitle, /第634话 死亡边缘/);
  // Repeated episode titles at different numbers are ambiguous.
  shifted[0].episodeTitle = '第221话 死亡边缘';
  assert.equal((await run(steps, options)).result, null);
});

test('conflicting and duplicate metadata title matches veto numerical selection', async () => {
  for (const duplicate of [false, true]) {
    const rows = episodes.map((ep, i) => ({ ...ep, episodeTitle: `第${i + 1}话 ${i === 414 || (duplicate && i === 415) ? '死亡边缘' : '别的故事'}` }));
    const { result, comments } = await run(actions, { getEpisodes: async () => rows, lookup: async () => ({ ...evidence, episodeTitle: '死亡边缘' }) });
    assert.equal(result, null); assert.deepEqual(comments, []);
  }
});

test('AI cannot send arbitrary URLs to source search', async () => {
  let calls = 0;
  const { result } = await run([{ action: 'search', query: 'https://example.org/not-a-title' }], { search: async () => { calls++; return []; } });
  assert.equal(result, null); assert.equal(calls, 0);
});

test('empty named source proves predecessor numbering for a complete source with the same end', async () => {
  const named = episodes.map((ep, i) => ({ ...ep, sourceId: 1, episodeTitle: `第${i + 221}话 ${i === 413 ? '死亡边缘' : '其他标题'}` }));
  named.push({ episodeTitle: 'C1 Opening 1' }, { episodeTitle: 'O1 忍活劇' });
  const numbered = Array.from({ length: 720 }, (_, i) => ({ sourceId: 2, episodeId: 2000 + i, episodeTitle: `火影忍者疾风传_${String(i + 1).padStart(3, '0')}` }));
  const steps = [actions[0], actions[1], { ...actions[2], title: '死亡边缘' }, actions[3], { ...actions[2], candidate: 'c2', number: 634 }, { ...actions[3], candidate: 'c2', episode: 'c2e634' }];
  const options = {
    search: async () => [anime, { ...anime, animeId: 2, episodeCount: 720 }],
    getEpisodes: async a => a.animeId === 1 ? named : numbered,
    lookup: async () => ({ ...evidence, episodeTitle: '死亡边缘' }),
    hasComments: async ep => ep.sourceId === 2
  };
  assert.equal((await run(steps, options)).result.resEpisode.episodeId, 2633);
  // Same numeric label alone is insufficient without the named source proof.
  assert.equal((await run([steps[0], steps[1], steps[4], steps[5]], options)).result, null);
  numbered[633].episodeTitle = '第634集 OVA';
  assert.equal((await run(steps, options)).result, null);
  numbered[633].episodeTitle = '火影忍者疾风传_634';
  numbered.pop();
  assert.equal((await run(steps, options)).result, null);
});
