import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Globals } from '../../configs/globals.js';
import { resolveAutoMatchMapping } from '../../utils/auto-match-mapping-util.js';
import {
  ensureRemoteAutoMatchMapping,
  getEffectiveAutoMatchMappingRules,
  normalizeRemoteSeasonMappingUrl,
  parseRemoteAutoMatchMappingRules,
  refreshRemoteAutoMatchMappingNow,
  resetRemoteAutoMatchMappingForTests,
} from '../../utils/auto-match-mapping-url-util.js';
import { withMockFetch } from '../helpers/context.js';

function resetState(env = {}) {
  resetRemoteAutoMatchMappingForTests();
  Globals.init(env);
}

test.afterEach(() => {
  resetState();
  Globals.deployPlatform = '';
});

test('远程季集映射表：URL、注释与规则解析', () => {
  Globals.init({});
  assert.equal(
    normalizeRemoteSeasonMappingUrl('https://github.com/alice/danmu-maps/blob/main/season.txt'),
    'https://raw.githubusercontent.com/alice/danmu-maps/main/season.txt',
  );
  assert.equal(
    normalizeRemoteSeasonMappingUrl('https://gist.github.com/alice/abc123def'),
    'https://gist.githubusercontent.com/alice/abc123def/raw',
  );
  assert.equal(
    normalizeRemoteSeasonMappingUrl('https://cdn.jsdelivr.net/gh/a/b@main/season.txt'),
    'https://cdn.jsdelivr.net/gh/a/b@main/season.txt',
  );
  assert.equal(normalizeRemoteSeasonMappingUrl('file:///tmp/season.txt'), '');
  assert.equal(normalizeRemoteSeasonMappingUrl('not-a-url'), '');

  const rules = parseRemoteAutoMatchMappingRules([
    '# 注释',
    '// 注释',
    '',
    '永生 S05E02 -> 永生 S01E58 # 行内注释',
    '一念永恒 S01E53 -> 一念永恒 S02E01',
    '火影忍者 S01E57 -> 火影忍者 疾风传(2007)【日番】 S01E59 @qiyi',
  ].join('\r\n'));
  assert.equal(rules.length, 3);
  assert.equal(rules[0].order, 0);
  assert.equal(rules[2].targetPlatform, 'qiyi');
});

test('远程季集映射表：本机规则优先于远程规则', async () => {
  const sourceUrl = 'https://maps.example.test/season-priority.txt';
  resetState({
    AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->本地目标 S01E10',
    AUTO_MATCH_MAPPING_TABLE_URL: sourceUrl,
  });
  Globals.deployPlatform = 'vercel';

  const result = await withMockFetch(
    async () => new Response([
      '永生 S05E02->远程目标 S01E58',
      '一念永恒 S01E53->一念永恒 S02E01',
    ].join('\n'), { status: 200 }),
    () => refreshRemoteAutoMatchMappingNow(),
  );

  assert.deepEqual(result, { success: true, count: 2, status: 200 });
  const rules = getEffectiveAutoMatchMappingRules();
  assert.equal(resolveAutoMatchMapping(rules, { title: '永生', season: 5, episode: 2 }).targetTitle, '本地目标');
  assert.equal(resolveAutoMatchMapping(rules, { title: '一念永恒', season: 1, episode: 54 }).targetEpisode, 2);
});

test('远程季集映射表：Serverless 首次请求不等待后台下载', async () => {
  const sourceUrl = 'https://maps.example.test/season-serverless.txt';
  resetState({
    AUTO_MATCH_MAPPING_TABLE: '永生 S05E02->本地目标 S01E10',
    AUTO_MATCH_MAPPING_TABLE_URL: sourceUrl,
  });
  Globals.deployPlatform = 'vercel';

  let releaseFetch;
  let requests = 0;
  const pendingResponse = new Promise(resolve => {
    releaseFetch = () => resolve(new Response([
      '永生 S05E02->远程目标 S01E58',
      '一念永恒 S01E53->一念永恒 S02E01',
    ].join('\n'), { status: 200 }));
  });

  try {
    await withMockFetch(
      async () => {
        requests++;
        return pendingResponse;
      },
      async () => {
        const race = await Promise.race([
          ensureRemoteAutoMatchMapping().then(() => 'returned'),
          new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
        ]);
        assert.equal(race, 'returned', 'Serverless 首次初始化不应等待网络');

        const beforeDownload = getEffectiveAutoMatchMappingRules();
        assert.equal(resolveAutoMatchMapping(beforeDownload, { title: '永生', season: 5, episode: 2 }).targetTitle, '本地目标');
        assert.equal(resolveAutoMatchMapping(beforeDownload, { title: '永生', season: 5, episode: 2 }).origin, 'local');

        releaseFetch();
        await ensureRemoteAutoMatchMapping({ waitForInitial: true });
        const afterDownload = getEffectiveAutoMatchMappingRules();
        assert.equal(resolveAutoMatchMapping(afterDownload, { title: '永生', season: 5, episode: 2 }).targetTitle, '本地目标');
        assert.equal(resolveAutoMatchMapping(afterDownload, { title: '永生', season: 5, episode: 2 }).origin, 'local');
        assert.equal(resolveAutoMatchMapping(afterDownload, { title: '一念永恒', season: 1, episode: 54 }).targetEpisode, 2);
        assert.equal(requests, 1);
      },
    );
  } finally {
    releaseFetch?.();
  }
});

test('远程季集映射表：Node 复用磁盘缓存且不联网', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-api-season-cache-'));
  const originalCwd = process.cwd();
  const sourceUrl = 'https://maps.example.test/season-disk.txt';
  try {
    process.chdir(cacheRoot);
    await fs.mkdir(path.join(cacheRoot, '.cache'), { recursive: true });
    await fs.writeFile(
      path.join(cacheRoot, '.cache', 'auto-match-mapping-remote.json'),
      JSON.stringify({
        url: sourceUrl,
        text: '缓存剧 S01E01 -> 缓存目标 S02E01',
        fetchedAt: Date.now(),
      }),
      'utf8',
    );

    resetState({
      AUTO_MATCH_MAPPING_TABLE: '本地剧 S01E01 -> 本地目标 S02E01',
      AUTO_MATCH_MAPPING_TABLE_URL: sourceUrl,
    });
    Globals.deployPlatform = 'node';

    let requests = 0;
    await withMockFetch(
      async () => {
        requests++;
        throw new Error('有效磁盘缓存存在时不应联网');
      },
      () => ensureRemoteAutoMatchMapping({ waitForInitial: true }),
    );

    assert.equal(requests, 0);
    const rules = getEffectiveAutoMatchMappingRules();
    assert.equal(resolveAutoMatchMapping(rules, { title: '缓存剧', season: 1, episode: 1 }).targetSeason, 2);
    assert.equal(resolveAutoMatchMapping(rules, { title: '本地剧', season: 1, episode: 1 }).targetTitle, '本地目标');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('远程季集映射表：手动刷新写入缓存，失败时保留旧规则', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'danmu-api-season-refresh-'));
  const originalCwd = process.cwd();
  const sourceUrl = 'https://maps.example.test/season-refresh.txt';
  try {
    process.chdir(cacheRoot);
    resetState({ AUTO_MATCH_MAPPING_TABLE_URL: sourceUrl });
    Globals.deployPlatform = 'node';

    const downloadedText = '永生 S05E02->永生 S01E58\n一念永恒 S01E53->一念永恒 S02E01';
    const first = await withMockFetch(
      async () => new Response(downloadedText, { status: 200 }),
      () => refreshRemoteAutoMatchMappingNow(),
    );
    assert.deepEqual(first, { success: true, count: 2, status: 200 });

    const cachePath = path.join(cacheRoot, '.cache', 'auto-match-mapping-remote.json');
    const cacheText = await fs.readFile(cachePath, 'utf8');
    const cache = JSON.parse(cacheText);
    assert.equal(cache.url, sourceUrl);
    assert.equal(cache.text, downloadedText);
    assert.ok(Number.isFinite(cache.fetchedAt));

    const failed = await withMockFetch(
      async () => { throw new Error('simulated mapping download failure'); },
      () => refreshRemoteAutoMatchMappingNow(),
    );
    assert.equal(failed.success, false);
    assert.equal(failed.status, 502);
    assert.equal(failed.count, 2);
    assert.match(failed.errorMessage, /simulated mapping download failure/);
    assert.equal(await fs.readFile(cachePath, 'utf8'), cacheText);
    assert.equal(
      resolveAutoMatchMapping(getEffectiveAutoMatchMappingRules(), { title: '一念永恒', season: 1, episode: 54 }).targetEpisode,
      2,
    );
  } finally {
    process.chdir(originalCwd);
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test('远程季集映射表：并发手动刷新返回 409 且只下载一次', async () => {
  const sourceUrl = 'https://maps.example.test/season-concurrent.txt';
  resetState({ AUTO_MATCH_MAPPING_TABLE_URL: sourceUrl });
  Globals.deployPlatform = 'node';

  let releaseFetch;
  let requests = 0;
  const pendingResponse = new Promise(resolve => {
    releaseFetch = () => resolve(new Response('永生 S05E02->永生 S01E58', { status: 200 }));
  });

  try {
    await withMockFetch(
      async () => {
        requests++;
        return pendingResponse;
      },
      async () => {
        const first = refreshRemoteAutoMatchMappingNow();
        await new Promise(resolve => setTimeout(resolve, 0));
        const second = await refreshRemoteAutoMatchMappingNow();
        assert.equal(second.success, false);
        assert.equal(second.status, 409);

        releaseFetch();
        const result = await first;
        assert.equal(result.success, true);
        assert.equal(requests, 1);
      },
    );
  } finally {
    releaseFetch?.();
  }
});
