// 韩剧TV源：移动端身份预热、详情并发保序与同名合并
// 由 danmu_api/tests/manual/live-source-checks.js 中无需联网的用例提取而来，用例名与断言未改。

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import HanjutvSource from '../../sources/hanjutv.js';

for (const method of ['buildMobileHeaders', 'buildTvHeaders']) {
  test(`Hanjutv ${method} should reuse identity until 12 hours and share concurrent refresh`, async (t) => {
    const startedAt = 1700000000000;
    const ttl = 12 * 60 * 60 * 1000;
    let now = startedAt;
    t.mock.method(Date, 'now', () => now);
    const source = new HanjutvSource();

    const firstBatch = await Promise.all(Array.from({ length: 4 }, () => source[method]()));
    const originalUid = firstBatch[0].uid;
    assert.ok(firstBatch.every(item => item.uid === originalUid));

    now = startedAt + ttl / 2;
    assert.equal((await source[method]()).uid, originalUid);
    now = startedAt + ttl - 1;
    assert.equal((await source[method]()).uid, originalUid);

    now = startedAt + ttl;
    const refreshedBatch = await Promise.all(Array.from({ length: 4 }, () => source[method]()));
    const refreshedUid = refreshedBatch[0].uid;
    assert.notEqual(refreshedUid, originalUid);
    assert.ok(refreshedBatch.every(item => item.uid === refreshedUid));

    now += ttl - 1;
    assert.equal((await source[method]()).uid, refreshedUid);
    now++;
    assert.notEqual((await source[method]()).uid, refreshedUid);
  });
}

test('Hanjutv expired mobile identity should warm up once before concurrent searches continue', async (t) => {
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const source = new HanjutvSource();
  let warmups = 0;
  let finishRefresh;
  source.warmupMobileIdentity = async () => {
    warmups++;
    if (warmups === 2) return new Promise(resolve => { finishRefresh = resolve; });
    return true;
  };

  assert.equal(await source.ensureMobileIdentityWarmed(), true);
  const originalUid = (await source.buildMobileHeaders()).uid;
  now += 12 * 60 * 60 * 1000 - 1;
  await source.ensureMobileIdentityWarmed();
  assert.equal(warmups, 1);

  now++;
  let completed = 0;
  const searches = Array.from({ length: 4 }, () => source.ensureMobileIdentityWarmed().then(result => {
    completed++;
    return result;
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warmups, 2);
  assert.equal(completed, 0);
  assert.notEqual((await source.buildMobileHeaders()).uid, originalUid);
  finishRefresh(true);
  assert.deepEqual(await Promise.all(searches), [true, true, true, true]);
  await source.ensureMobileIdentityWarmed();
  assert.equal(warmups, 2);
});

test('Hanjutv warmup should retry after failure and share concurrent promise', async () => {
  const source = new HanjutvSource();
  let attempts = 0;
  let finishFirst;
  source.buildMobileHeaders = async () => ({ uid: 'stable-uid', headers: {} });
  source.warmupMobileIdentity = async () => {
    attempts++;
    if (attempts === 1) return new Promise(resolve => { finishFirst = resolve; });
    return true;
  };

  const concurrent = [source.ensureMobileIdentityWarmed(), source.ensureMobileIdentityWarmed()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  finishFirst(false);
  await Promise.all(concurrent);
  await source.ensureMobileIdentityWarmed();
  await source.ensureMobileIdentityWarmed();
  assert.equal(attempts, 2);
});

test('Hanjutv details should stay fully parallel and preserve candidate order', async () => {
  const source = new HanjutvSource();
  const candidates = Array.from({ length: 6 }, (_, index) => ({ sid: `sid-${index}`, name: `顺序测试剧${index}` }));
  const resolvers = new Map();
  const started = [];
  const previous = { animes: Globals.animes, episodeIds: Globals.episodeIds, episodeNum: Globals.episodeNum };
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  source.buildAnimePayload = anime => new Promise(resolve => {
    started.push(anime.sid);
    resolvers.set(anime.sid, resolve);
  });
  source.sortAndPushAnimesByYear = (items, target) => target.push(...items);

  try {
    const current = [];
    const task = source.handleAnimes(candidates, '顺序测试剧', current, new Map());
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, candidates.map(item => item.sid));
    [...candidates].reverse().forEach(anime => {
      const index = candidates.indexOf(anime);
      resolvers.get(anime.sid)({
        summary: { animeId: 900000 + index, bangumiId: String(900000 + index), animeTitle: anime.name, type: '韩剧', typeDescription: '韩剧', imageUrl: '', startDate: '2025-01-01T00:00:00Z', episodeCount: 1, rating: 0, isFavorited: true, source: 'hanjutv' },
        links: [{ name: '第1集', url: `hxq:${anime.sid}`, title: '【hanjutv】 第1集' }],
      });
    });
    const expected = candidates.map(item => item.name);
    assert.deepEqual((await task).map(item => item.animeTitle), expected);
    assert.deepEqual(current.map(item => item.animeTitle), expected);
    assert.deepEqual(Globals.animes.map(item => item.animeTitle), expected);
  } finally {
    Globals.animes = previous.animes;
    Globals.episodeIds = previous.episodeIds;
    Globals.episodeNum = previous.episodeNum;
  }
});

test('Hanjutv should merge only exact titles and disambiguate duplicate names', async () => {
  const source = new HanjutvSource();
  const getMergedPairs = (keyword, s5Items, tvItems) => source
    .mergeSearchCandidates(keyword, s5Items, tvItems)
    .resultList
    .filter(item => item._variant === 'merged')
    .map(item => [item.sid, item.tvSid])
    .sort((left, right) => left[0].localeCompare(right[0]));

  const taxi = source.mergeSearchCandidates('模范出租车', [
    { sid: 's3', name: '模范出租车3' },
    { sid: 's2', name: '模范出租车2' },
  ], [
    { sid: 't2', name: '模范出租车2' },
    { sid: 't3', name: '模范出租车3' },
  ]).resultList.filter(item => item._variant === 'merged');
  assert.deepEqual(taxi.map(item => [item.name, item.tvSid]), [
    ['模范出租车3', 't3'],
    ['模范出租车2', 't2'],
  ]);

  const duplicate = source.mergeSearchCandidates('配对游戏', [
    { sid: 's-new', name: '配对游戏', playMode: 100, publishTime: '2025-01-01', lastSerialNo: 6 },
    { sid: 's-old', name: '配对游戏', playMode: 101, publishTime: '2024-01-01', lastSerialNo: 63 },
  ], [
    { sid: 't-old', name: '配对游戏', playMode: 101, publishTime: '2024-01-01', lastSerialNo: 63 },
    { sid: 't-new', name: '配对游戏', playMode: 100, publishTime: '2025-01-01', lastSerialNo: 6 },
  ]).resultList.filter(item => item._variant === 'merged');
  assert.deepEqual(duplicate.map(item => item.tvSid), ['t-new', 't-old']);

  const partialS5 = [
    { sid: 's-unknown', name: '同名剧', playMode: 100, category: 1 },
    { sid: 's-2025', name: '同名剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  ];
  const datedTv = [
    { sid: 't-2025', name: '同名剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  ];
  for (const s5Order of [partialS5, [...partialS5].reverse()]) {
    assert.deepEqual(getMergedPairs('同名剧', s5Order, datedTv), [['s-2025', 't-2025']]);
  }

  const ambiguousS5 = [
    { sid: 's-a', name: '歧义剧', playMode: 100, category: 1 },
    { sid: 's-b', name: '歧义剧', playMode: 100, category: 1 },
  ];
  const ambiguousTv = [{ sid: 't-only', name: '歧义剧', playMode: 100, category: 1 }];
  assert.deepEqual(getMergedPairs('歧义剧', ambiguousS5, ambiguousTv), []);
  assert.deepEqual(getMergedPairs('歧义剧', [...ambiguousS5].reverse(), ambiguousTv), []);

  assert.deepEqual(getMergedPairs('待播剧', [
    { sid: 's-upcoming', name: '待播剧', playMode: 100, category: 1 },
  ], [
    { sid: 't-upcoming', name: '待播剧', playMode: 100, category: 1 },
  ]), [['s-upcoming', 't-upcoming']]);

  const eliminationS5 = [
    { sid: 's-known', name: '排除剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
    { sid: 's-left', name: '排除剧', playMode: 100, category: 1 },
  ];
  const eliminationTv = [
    { sid: 't-left', name: '排除剧', playMode: 100, category: 1 },
    { sid: 't-known', name: '排除剧', playMode: 100, publishTime: '2025-01-01', category: 1 },
  ];
  const expectedEliminationPairs = [['s-known', 't-known'], ['s-left', 't-left']];
  for (const s5Order of [eliminationS5, [...eliminationS5].reverse()]) {
    for (const tvOrder of [eliminationTv, [...eliminationTv].reverse()]) {
      assert.deepEqual(getMergedPairs('排除剧', s5Order, tvOrder), expectedEliminationPairs);
    }
  }
});

test('Hanjutv should parse search-pair years without confusing seconds and milliseconds', () => {
  const source = new HanjutvSource();
  assert.equal(source.getSearchPairYear({ publishTime: 888768000000 }), 1998);
  assert.equal(source.getSearchPairYear({ publishTime: '956678400000' }), 2000);
  assert.equal(source.getSearchPairYear({ publishTime: 1735689600 }), 2025);
  assert.equal(source.getSearchPairYear({ publishTime: '20250101' }), 2025);
  assert.equal(source.getSearchPairYear({ releaseTime: '2025-07-11T00:00:00Z' }), 2025);
  assert.equal(source.getSearchPairYear({ publishTime: 0, searchMemo: '1998·韩剧·敬请期待' }), 1998);
  assert.equal(source.getSearchPairYear({ publishTime: 'not-a-date' }), null);
  assert.equal(source.getSearchPairYear({ publishTime: 253402300800000 }), null);

  assert.equal(source.isMergeableSearchPair(
    { name: '千禧剧', publishTime: 974788882000 },
    { name: '千禧剧', publishTime: 974820151000 },
  ), true);
});
