// 本地弹幕接口：本地源配置与搜索
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Request as NodeFetchRequest } from 'node-fetch';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getBangumi, getComment, getSegmentComment, matchAnime, searchAnime } from '../../apis/dandan-api.js';
import { handleLocalDanmuList, handleLocalDanmuDelete, handleLocalDanmuGet, handleLocalDanmuUpdate } from '../../apis/local-danmu-api.js';
import { handleConfig } from '../../apis/system-api.js';
import { Globals } from '../../configs/globals.js';
import { Season } from '../../models/dandan-model.js';
import { getSourceByKey } from '../../sources/registry.js';
import { addAnime } from '../../utils/cache-util.js';
import { buildLocalDanmuResourceKey } from '../../utils/local-danmu-parser.js';
import { saveLocalDanmu, getLocalDanmu, listLocalDanmu, findLocalDanmu, removeLocalDanmu } from '../../utils/local-danmu-store.js';
import { handleRequest } from '../../worker.js';
import { token } from '../helpers/context.js';
import { localDanmuDir, localDanmuSearchUrl, localDataPath, localIndexPath, makeResource, mockRemoteSource, resetState, uploadResource } from '../helpers/local-danmu.js';

test('local source configuration and search', async t => {
  const tempRoot = path.resolve(os.tmpdir());
  const testDir = await fs.mkdtemp(path.join(tempRoot, 'danmu-local-source-'));
  t.mock.method(process, 'cwd', () => testDir);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(testDir)), tempRoot);
    assert.ok(path.basename(testDir).startsWith('danmu-local-source-'));
    await fs.rm(testDir, { recursive: true, force: true });
  });

  resetState();
  for (const resource of [
    makeResource('逐玉', 10),
    makeResource('逐玉', 5),
    makeResource('单集上传', 5),
    makeResource('逐玉失败资源', 1, 2026, 'tv', 'failed'),
    makeResource('其他剧', 1),
    makeResource('同名作品', null, 2025, 'movie'),
    makeResource('同名作品', null, 2026, 'movie'),
    makeResource('同名作品', 1, 2026, 'tv'),
  ]) await saveLocalDanmu(resource);

  await t.test('SOURCE_ORDER retains local and exposes it to the settings UI', async () => {
    resetState('local,douban');
    assert.deepEqual(Globals.envs.sourceOrderArr, ['local', 'douban']);
    const config = await handleConfig().json();
    assert.ok(config.envVarConfig.SOURCE_ORDER.options.includes('local'));
    assert.ok(config.categorizedEnvVars.source.find(item => item.key === 'SOURCE_ORDER').options.includes('local'));
  });

  await t.test('local-only search exposes uploaded episodes and retrieves their comments', async () => {
    resetState();
    const result = await (await searchAnime(localDanmuSearchUrl('逐玉'))).json();
    assert.equal(result.success, true);
    assert.equal(result.animes.length, 1);
    assert.equal(result.animes[0].source, 'local');
    assert.equal(result.animes[0].episodeCount, 2);

    const details = await (await getBangumi(`/api/v2/bangumi/${result.animes[0].bangumiId}`)).json();
    assert.deepEqual(details.bangumi.episodes.map(episode => episode.episodeNumber), ['5', '10']);
    const episode = details.bangumi.episodes[0];
    assert.equal(episode.url, `local:${buildLocalDanmuResourceKey({ title: '逐玉', year: 2026, type: 'tv', episode: 5 })}`);
    const comments = await (await getComment(`/api/v2/comment/${episode.episodeId}`, 'json', false)).json();
    assert.equal(comments.count, 1);
    assert.equal(comments.comments[0].m, '第5集弹幕');

    const segments = await (await getComment(`/api/v2/comment/${episode.episodeId}`, 'json', true)).json();
    assert.equal(segments.segmentList[0].type, 'local');
    const segmentComments = await (await getSegmentComment(segments.segmentList[0], 'json')).json();
    assert.equal(segmentComments.comments[0].m, '第5集弹幕');
  });

  await t.test('same-title uploads remain separate across years and types', async () => {
    resetState();
    const result = await (await searchAnime(localDanmuSearchUrl('同名作品'))).json();
    assert.equal(result.animes.length, 3);
    assert.equal(new Set(result.animes.map(anime => anime.animeId)).size, 3);
    assert.deepEqual(result.animes.map(anime => anime.startDate).sort(), ['2025-01-01', '2026-01-01', '2026-01-01']);
    assert.deepEqual(result.animes.map(anime => anime.type).sort(), ['movie', 'movie', 'tvseries']);
  });

  await t.test('automatic matching respects the actual numbers of partial local uploads', async () => {
    for (const episode of [5, 1]) {
      resetState();
      const request = new NodeFetchRequest('http://localhost/api/v2/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: `逐玉(2026) S01E${String(episode).padStart(2, '0')}.mkv` }),
      });
      const result = await (await matchAnime(new URL(request.url), request, '127.0.0.1')).json();
      if (episode === 5) {
        assert.equal(result.matches.length, 1);
        assert.equal(result.matches[0].episodeTitle, '【local】 第5集');
      } else {
        assert.deepEqual(result.matches, [], 'an unuploaded episode must not match a different local episode by array index');
      }
    }
  });

  await t.test('one uploaded TV episode keeps its configured priority against a complete remote series', async child => {
    mockRemoteSource(child);
    for (const fileName of ['单集上传 S01E05.mkv', '单集上传(2026) S01E05.mkv']) {
      resetState('local,tencent');
      const request = new NodeFetchRequest('http://localhost/api/v2/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName }),
      });
      const result = await (await matchAnime(new URL(request.url), request, '127.0.0.1')).json();
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].episodeTitle, '【local】 第5集');
    }
  });

  for (const [order, expectedSources] of [
    ['local,tencent', ['local', 'tencent']],
    ['tencent,local', ['tencent', 'local']],
    ['tencent', ['tencent']],
  ]) {
    await t.test(`search follows SOURCE_ORDER=${order}`, async child => {
      resetState(order);
      mockRemoteSource(child);
      const localSearch = child.mock.method(getSourceByKey('local'), 'search');
      const result = await (await searchAnime(localDanmuSearchUrl('逐玉'))).json();
      assert.deepEqual(result.animes.map(anime => anime.source), expectedSources);
      assert.equal(localSearch.mock.callCount(), expectedSources.includes('local') ? 1 : 0);
    });
  }

  await t.test('unmatched local searches return an empty successful result', async () => {
    resetState();
    const result = await (await searchAnime(localDanmuSearchUrl('不存在的资源'))).json();
    assert.equal(result.success, true);
    assert.deepEqual(result.animes, []);
  });

  await t.test('first-season uploads replace legacy files and later seasons remain independent', async () => {
    resetState();
    const legacy = makeResource('旧季兼容', 5);
    await saveLocalDanmu(legacy);
    const oldMetadata = await (await handleLocalDanmuGet(legacy.resourceKey)).json();
    assert.equal(oldMetadata.resource.season, 1);
    assert.ok(!('comments' in oldMetadata.resource));
    const fields = { title: legacy.title, year: 2026, type: 'tv', episode: 5 };
    const first = await (await uploadResource(fields, 'first season updated')).json();
    const second = await (await uploadResource({ ...fields, season: 2 }, 'second season')).json();
    assert.equal(first.resource.season, 1);
    assert.equal(first.resource.resourceKey, legacy.resourceKey);
    assert.notEqual(first.resource.resourceKey, second.resource.resourceKey);
    assert.equal((await getLocalDanmu(legacy.resourceKey)).comments[0].m, 'first season updated');
    assert.equal((await getLocalDanmu(second.resource.resourceKey)).comments[0].m, 'second season');
    const listing = await (await handleLocalDanmuList()).json();
    assert.equal(listing.resources.filter(resource => resource.title === legacy.title).length, 2);
    assert.equal(listing.groups.filter(group => group.title === legacy.title).length, 2);
    const invalid = await uploadResource({ ...fields, season: 0 }, 'invalid season');
    assert.equal(invalid.status, 400);
  });

  await t.test('uploads require a valid year and a supported type without saving invalid resources', async () => {
    resetState();
    const fields = { title: '必填项校验', year: 2026, type: 'tv', episode: 5 };
    const before = await (await handleLocalDanmuList()).json();
    for (const [overrides, message] of [
      [{ year: undefined }, /年份/],
      [{ year: '' }, /年份/],
      [{ year: ' ' }, /年份/],
      [{ year: 1899 }, /年份/],
      [{ year: new Date().getFullYear() + 1 }, /年份/],
      [{ year: '2026abc' }, /年份/],
      [{ year: '2026.5' }, /年份/],
      [{ type: undefined }, /类型/],
      [{ type: '' }, /类型/],
      [{ type: 'ova' }, /类型/],
      [{ type: 'special' }, /类型/],
      [{ type: 'unknown' }, /类型/],
      [{ type: 'movie', episode: 0 }, /集数/],
      [{ type: 'movie', episode: '1.5' }, /集数/],
      [{ type: 'movie', season: 0 }, /季数/],
    ]) {
      const response = await uploadResource({ ...fields, ...overrides }, 'must not be saved');
      assert.equal(response.status, 400, JSON.stringify(overrides));
      assert.match((await response.json()).errorMessage, message);
    }
    const after = await (await handleLocalDanmuList()).json();
    assert.deepEqual(after.resources.map(resource => resource.resourceKey), before.resources.map(resource => resource.resourceKey));
  });

  await t.test('TV uploads accept years through this year and default missing or empty season and episode to one', async () => {
    resetState();
    for (const [year, optionalValue] of [[1900, undefined], [new Date().getFullYear(), '']]) {
      const fields = { title: '年份边界', year, type: 'tv', season: optionalValue, episode: optionalValue };
      const response = await uploadResource(fields, 'year boundary');
      assert.equal(response.status, 200);
      const { resource } = await response.json();
      assert.equal(resource.year, year);
      assert.equal(resource.season, 1);
      assert.equal(resource.episode, 1);
    }
  });

  await t.test('movies upload without season or episode and expose playable comments', async () => {
    resetState();
    const fields = { title: '电影可选字段', year: 2026, type: 'movie' };
    let resource;
    for (const optionalFields of [{}, { season: '', episode: '' }]) {
      const response = await uploadResource({ ...fields, ...optionalFields }, 'movie comment');
      assert.equal(response.status, 200);
      resource = (await response.json()).resource;
      assert.equal(resource.episode, null);
      assert.equal(resource.resourceKey, buildLocalDanmuResourceKey(fields));
    }
    const listing = await (await handleLocalDanmuList()).json();
    assert.equal(listing.resources.filter(item => item.title === fields.title).length, 1);
    const result = await (await searchAnime(localDanmuSearchUrl(fields.title))).json();
    assert.equal(result.animes.length, 1);
    assert.equal(result.animes[0].type, 'movie');
    assert.ok(!result.animes[0].animeTitle.includes('第1季'));
    const details = await (await getBangumi(`/api/v2/bangumi/${result.animes[0].bangumiId}`)).json();
    assert.equal(details.bangumi.episodes[0].url, `local:${resource.resourceKey}`);
    const comments = await (await getComment(`/api/v2/comment/${details.bangumi.episodes[0].episodeId}`, 'json', false)).json();
    assert.equal(comments.comments[0].m, 'movie comment');
  });

  const seasonFields = { title: '分季资源', year: 2026, type: 'tv' };
  await t.test('uploads group episodes per season and refresh cached search results', async () => {
    resetState();
    for (const [season, episode] of [[1, 5], [2, 10]]) {
      const response = await uploadResource({ ...seasonFields, season, episode }, `S${season}E${episode}`);
      assert.equal(response.status, 200);
    }
    await searchAnime(localDanmuSearchUrl(seasonFields.title));
    assert.ok(Globals.searchCache.size > 0);
    await uploadResource({ ...seasonFields, season: 2, episode: 5 }, 'S2E5');
    assert.equal(Globals.searchCache.size, 0);
    const listing = await (await handleLocalDanmuList()).json();
    const groups = listing.groups.filter(group => group.title === seasonFields.title);
    assert.deepEqual(groups.map(group => group.season), [1, 2]);
    assert.deepEqual(groups.map(group => group.episodeCount), [1, 2]);
    assert.deepEqual(groups[1].episodes.map(resource => resource.episode), [5, 10]);
    assert.ok(listing.resources.every(resource => !('comments' in resource)));
    assert.ok(groups.every(group => group.episodes.every(resource => !('comments' in resource))));
  });

  await t.test('local metadata edits migrate resource keys and reject conflicts', async () => {
    resetState();
    const first = await uploadResource({ title: '编辑剧集', year: 2026, type: 'tv', season: 1, episode: 1 }, 'edit first');
    await uploadResource({ title: '编辑剧集', year: 2026, type: 'tv', season: 1, episode: 2 }, 'edit second');
    const firstResource = (await first.json()).resource;
    const groupEdit = await handleLocalDanmuUpdate(new Request('http://localhost/api/local-danmu/' + encodeURIComponent(firstResource.resourceKey), { method: 'PATCH', body: JSON.stringify({ scope: 'group', title: '编辑后的剧集', year: '2025', type: 'tv', season: '3' }), headers: { 'content-type': 'application/json' } }), firstResource.resourceKey);
    assert.equal(groupEdit.status, 200);
    assert.equal((await getLocalDanmu(firstResource.resourceKey)), null);
    // 整组编辑会重写每条资源，弹幕内容必须原样保留（列表只提供元数据）。
    const movedEpisode = await getLocalDanmu(buildLocalDanmuResourceKey({ title: '编辑后的剧集', year: 2025, type: 'tv', season: 3, episode: 1 }));
    assert.equal(movedEpisode.comments.length, 1);
    assert.equal(movedEpisode.comments[0].m, 'edit first');
    const movedList = await (await handleLocalDanmuList()).json();
    assert.deepEqual(movedList.resources.filter(resource => resource.title === '编辑后的剧集').map(resource => resource.season), [3, 3]);
    const conflictSource = await uploadResource({ title: '冲突剧集', year: 2026, type: 'tv', season: 1, episode: 1 }, 'conflict');
    const conflictResource = (await conflictSource.json()).resource;
    await uploadResource({ title: '冲突剧集', year: 2026, type: 'tv', season: 1, episode: 2 }, 'conflict target');
    const conflict = await handleLocalDanmuUpdate(new Request('http://localhost/api/local-danmu/' + encodeURIComponent(conflictResource.resourceKey), { method: 'PATCH', body: JSON.stringify({ scope: 'resource', episode: 2, filename: '冲突文件.txt' }), headers: { 'content-type': 'application/json' } }), conflictResource.resourceKey);
    assert.equal(conflict.status, 409);
    assert.equal((await getLocalDanmu(conflictResource.resourceKey)).filename, 'danmu.json');
  });

  await t.test('local list uses a metadata-only index and rebuilds it when it is broken', async () => {
    resetState();
    const before = (await listLocalDanmu()).length;
    await uploadResource({ title: '索引剧集', year: 2026, type: 'tv', season: 1, episode: 1 }, 'index one');
    await uploadResource({ title: '索引剧集', year: 2026, type: 'tv', season: 1, episode: 2 }, 'index two');
    const indexPath = path.join(process.cwd(), '.cache', 'local-danmu', 'index.meta');

    const listed = await listLocalDanmu();
    assert.equal(listed.length, before + 2);
    assert.ok(listed.every(resource => !('comments' in resource)));
    const onDisk = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    assert.equal(onDisk.length, before + 2);
    assert.ok(onDisk.every(resource => !('comments' in resource)));

    // 索引丢了或坏了都要能自愈，不能因为缓存文件异常就看不到已导入的资源。
    await fs.rm(indexPath);
    assert.equal((await listLocalDanmu()).length, before + 2);
    assert.equal(JSON.parse(await fs.readFile(indexPath, 'utf8')).length, before + 2);
    await fs.writeFile(indexPath, 'not json', 'utf8');
    assert.equal((await listLocalDanmu()).length, before + 2);
    assert.equal(JSON.parse(await fs.readFile(indexPath, 'utf8')).length, before + 2);
    // 索引必须是不可被当成资源的文件名：旧版本按 *.json 扫目录时不能把索引当成一集弹幕。
    assert.ok(!indexPath.endsWith('.json'));
  });

  await t.test('a failed index write rolls the data file back', async () => {
    resetState();
    // 用同名目录占住索引路径，索引写入必定失败（rename 到目录会报错）。
    const indexPath = path.join(process.cwd(), '.cache', 'local-danmu', 'index.meta');
    await fs.rm(indexPath, { recursive: true, force: true });
    await fs.mkdir(indexPath, { recursive: true });
    const resourceKey = buildLocalDanmuResourceKey({ title: '回滚剧集', year: 2026, type: 'tv', season: 1, episode: 1 });
    await assert.rejects(() => saveLocalDanmu({
      resourceKey, videoId: 'rollback-1', title: '回滚剧集', year: 2026, type: 'tv', season: 1, episode: 1,
      filename: 'danmu.json', size: 1, format: 'json', status: 'ready', count: 1, matchKeys: [], comments: [],
      updatedAt: new Date().toISOString(),
    }));
    assert.equal(await getLocalDanmu(resourceKey), null);
    await fs.rm(indexPath, { recursive: true, force: true });
  });

  await t.test('a failed index write keeps the previous version of an existing resource', async () => {
    resetState();
    const fields = { title: '覆盖回滚剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(fields, 'old comment');
    const key = buildLocalDanmuResourceKey(fields);
    const previous = await getLocalDanmu(key);
    // 覆盖已有资源时索引写入失败：必须恢复旧文件，不能把上一次可用的弹幕删掉。
    await fs.rm(localIndexPath(), { recursive: true, force: true });
    await fs.mkdir(localIndexPath(), { recursive: true });
    await assert.rejects(() => saveLocalDanmu({
      ...previous,
      comments: [{ p: '1,1,16777215', m: 'new comment' }],
      count: 1,
      updatedAt: new Date().toISOString(),
    }));
    const restored = await getLocalDanmu(key);
    assert.equal(restored.comments.length, 1);
    assert.equal(restored.comments[0].m, 'old comment');
    await fs.rm(localIndexPath(), { recursive: true, force: true });
  });

  await t.test('a failed index update keeps the data file for deletion', async () => {
    resetState();
    const fields = { title: '删除回滚剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(fields, 'keep me');
    const key = buildLocalDanmuResourceKey(fields);
    // 删除先改索引再删数据：索引失败时文件必须还在，否则接口报错但资源已经丢了。
    await fs.rm(localIndexPath(), { recursive: true, force: true });
    await fs.mkdir(localIndexPath(), { recursive: true });
    await assert.rejects(() => removeLocalDanmu(key));
    const kept = await getLocalDanmu(key);
    assert.equal(kept.comments[0].m, 'keep me');
    await fs.rm(localIndexPath(), { recursive: true, force: true });
  });

  await t.test('list falls back to scanning when the index cannot be written', async () => {
    resetState();
    const fields = { title: '索引降级剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(fields, 'fallback comment');
    const key = buildLocalDanmuResourceKey(fields);
    await fs.rm(localIndexPath(), { recursive: true, force: true });
    await fs.mkdir(localIndexPath(), { recursive: true });
    const listed = await listLocalDanmu();
    assert.ok(listed.some(resource => resource.resourceKey === key));
    assert.ok(listed.every(resource => !('comments' in resource)));
    await fs.rm(localIndexPath(), { recursive: true, force: true });
  });

  await t.test('list self-heals orphan and phantom entries by comparing the directory', async () => {
    resetState();
    const orphanFields = { title: '自愈孤儿剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    const phantomFields = { title: '自愈幻影剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(orphanFields, 'orphan comment');
    await uploadResource(phantomFields, 'phantom comment');
    const orphanKey = buildLocalDanmuResourceKey(orphanFields);
    const phantomKey = buildLocalDanmuResourceKey(phantomFields);
    const indexPath = localIndexPath();
    // 模拟数据已落盘但索引更新前进程退出：索引里没有，目录里有。
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    await fs.writeFile(indexPath, JSON.stringify(index.filter(item => item.resourceKey !== orphanKey)), 'utf8');
    const healed = await listLocalDanmu();
    assert.ok(healed.some(resource => resource.resourceKey === orphanKey));
    assert.ok(healed.some(resource => resource.resourceKey === phantomKey));
    // 模拟索引里有但数据文件被外部删掉：列表要剔除幻影条目并修复索引。
    await fs.unlink(localDataPath(phantomKey));
    const cleaned = await listLocalDanmu();
    assert.ok(cleaned.some(resource => resource.resourceKey === orphanKey));
    assert.ok(!cleaned.some(resource => resource.resourceKey === phantomKey));
    assert.ok(JSON.parse(await fs.readFile(indexPath, 'utf8')).every(item => item.resourceKey !== phantomKey));
  });

  await t.test('a concurrent upload during index rebuild is not lost', async t => {
    resetState();
    const baseFields = { title: '并发索引剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(baseFields, 'base comment');
    const baseKey = buildLocalDanmuResourceKey(baseFields);
    await fs.rm(localIndexPath(), { force: true }); // 索引缺失，接下来的列表会触发重建

    const dirPath = localDanmuDir();
    const realReaddir = fs.readdir.bind(fs);
    const before = (await realReaddir(dirPath)).filter(name => name.endsWith('.json')).length;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let capturedResolve;
    const captured = new Promise(resolve => { capturedResolve = resolve; });
    let gated = false;
    // 让列表先拿到旧目录快照并停住，再放上传进来，复现重建与上传交错的时序。
    t.mock.method(fs, 'readdir', async (...args) => {
      const names = await realReaddir(...args);
      if (!gated) { gated = true; capturedResolve(); await gate; }
      return names;
    });

    const listing = listLocalDanmu();
    await captured;
    const newFields = { ...baseFields, episode: 2 };
    const upload = uploadResource(newFields, 'concurrent comment');
    // 等新数据文件落盘；此时上传会卡在重建锁后面，索引还没更新。
    for (let i = 0; i < 200; i++) {
      const count = (await realReaddir(dirPath)).filter(name => name.endsWith('.json')).length;
      if (count > before) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    release();
    const response = await upload;
    assert.equal(response.status, 200);
    await listing;

    const newKey = buildLocalDanmuResourceKey(newFields);
    const listed = await listLocalDanmu();
    assert.ok(listed.some(resource => resource.resourceKey === baseKey));
    assert.ok(listed.some(resource => resource.resourceKey === newKey));
    const stored = await getLocalDanmu(newKey);
    assert.equal(stored.comments[0].m, 'concurrent comment');
    assert.ok(JSON.parse(await fs.readFile(localIndexPath(), 'utf8')).some(item => item.resourceKey === newKey));
  });

  await t.test('a concurrent upload during directory verification does not break listing', async t => {
    resetState();
    const baseFields = { title: '并发校验剧集', year: 2026, type: 'tv', season: 1, episode: 1 };
    await uploadResource(baseFields, 'base comment'); // 上传刚写完索引，indexCache 为空

    const dirPath = localDanmuDir();
    const realReaddir = fs.readdir.bind(fs);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let capturedResolve;
    const captured = new Promise(resolve => { capturedResolve = resolve; });
    let gated = false;
    t.mock.method(fs, 'readdir', async (...args) => {
      const names = await realReaddir(...args);
      if (!gated) { gated = true; capturedResolve(); await gate; }
      return names;
    });

    const listing = listLocalDanmu();
    await captured;
    const newFields = { ...baseFields, episode: 2 };
    await uploadResource(newFields, 'concurrent verify comment'); // 校验期间重写索引并清空缓存
    release();
    await listing; // 修复前这里会因为 indexCache 已被清空而抛 TypeError

    const newKey = buildLocalDanmuResourceKey(newFields);
    const listed = await listLocalDanmu();
    assert.ok(listed.some(resource => resource.resourceKey === newKey));
  });

  await t.test('parallel uploads keep every entry in the index', async () => {
    resetState();
    const episodes = [1, 2, 3, 4, 5];
    await Promise.all(episodes.map(episode => saveLocalDanmu({
      resourceKey: buildLocalDanmuResourceKey({ title: '并发剧集', year: 2026, type: 'tv', season: 1, episode }),
      videoId: `parallel-${episode}`, title: '并发剧集', year: 2026, type: 'tv', season: 1, episode,
      filename: 'danmu.json', size: 1, format: 'json', status: 'ready', count: 1, matchKeys: [], comments: [],
      updatedAt: new Date().toISOString(),
    })));
    const listed = await listLocalDanmu();
    assert.equal(listed.filter(resource => resource.title === '并发剧集').length, episodes.length);
  });

  await t.test('search, details and matching isolate each season', async () => {
    resetState();
    const all = await (await searchAnime(localDanmuSearchUrl(seasonFields.title))).json();
    assert.equal(all.animes.length, 2);
    assert.equal(new Set(all.animes.map(anime => anime.animeId)).size, 2);
    for (const season of [1, 2, 3]) {
      resetState();
      const url = localDanmuSearchUrl(seasonFields.title);
      url.searchParams.set('season', String(season));
      const result = await (await searchAnime(url)).json();
      assert.equal(result.animes.length, season === 3 ? 0 : 1);
      if (season !== 3) {
        assert.ok(result.animes[0].animeTitle.includes(`第${season}季`));
        const details = await (await getBangumi(`/api/v2/bangumi/${result.animes[0].bangumiId}`)).json();
        assert.equal(details.bangumi.seasons[0].name, `Season ${season}`);
      }
      const request = new NodeFetchRequest('http://localhost/api/v2/match', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: `${seasonFields.title} S0${season}E05.mkv` }),
      });
      const match = await (await matchAnime(new URL(request.url), request, '127.0.0.1')).json();
      assert.equal(match.matches.length, season === 3 ? 0 : 1);
      if (season !== 3) {
        const comments = await (await getComment(`/api/v2/comment/${match.matches[0].episodeId}`, 'json', false)).json();
        assert.equal(comments.comments[0].m, `S${season}E5`);
      }
    }
  });

  await t.test('title matching for remote episode fallback also uses the requested season', async child => {
    resetState();
    const fields = { ...seasonFields, episode: 5 };
    assert.equal((await findLocalDanmu(fields)).season, 1);
    assert.equal((await findLocalDanmu({ ...fields, season: 2 })).season, 2);
    assert.equal(await findLocalDanmu({ ...fields, season: 3 }), null);
    const remoteComments = child.mock.method(getSourceByKey('tencent'), 'getComments', async () => [{ p: '1,1,16777215', m: 'wrong remote fallback' }]);
    addAnime({
      animeId: 910005, bangumiId: '910005', animeTitle: `${seasonFields.title} 第2季(2026)【TV】from tencent`,
      type: 'tvseries', typeDescription: 'TV', source: 'tencent',
      links: [{ title: '【qq】 第5集', url: 'https://v.qq.com/season-two-episode-five' }],
    });
    const episode = Globals.animes.find(anime => anime.animeId === 910005).links[0];
    const result = await (await getComment(`/api/v2/comment/${episode.id}`, 'json', false)).json();
    assert.equal(result.comments[0].m, 'S2E5');
    assert.equal(remoteComments.mock.callCount(), 0);
  });

  await t.test('deleting one episode preserves its siblings and removes an empty season group', async () => {
    resetState();
    for (const episode of [5, 10]) {
      const key = buildLocalDanmuResourceKey({ ...seasonFields, season: 2, episode });
      await handleLocalDanmuDelete(key);
      const listing = await (await handleLocalDanmuList()).json();
      const secondSeason = listing.groups.find(group => group.title === seasonFields.title && group.season === 2);
      if (episode === 5) {
        assert.equal(secondSeason.episodeCount, 1);
        assert.equal(secondSeason.episodes[0].episode, 10);
      } else assert.equal(secondSeason, undefined);
      assert.ok(listing.groups.some(group => group.title === seasonFields.title && group.season === 1));
    }
  });

  await t.test('authenticated users can read local resources while deletion follows upload permission', async () => {
    const userToken = 'local-user-token';
    const adminToken = 'local-admin-token';
    for (const scenario of [
      { token: userToken, allowed: false },
      { token: userToken, setting: 'false', allowed: false },
      { token: userToken, setting: 'true', allowed: true },
      { token: adminToken, setting: 'false', allowed: true },
      { token: adminToken, setting: 'true', allowed: true },
    ]) {
      resetState();
      Globals.localCacheInitialized = true;
      const env = { TOKEN: userToken, ADMIN_TOKEN: adminToken, LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0' };
      if (scenario.setting !== undefined) env.LOCAL_DANMU_NOT_REQUIRE_ADMIN = scenario.setting;
      for (const prefix of ['/api', '/api/v2']) {
        const selected = makeResource('列表与删除权限测试', 1);
        const sibling = makeResource('列表与删除权限测试', 2);
        await saveLocalDanmu(selected);
        await saveLocalDanmu(sibling);
        const baseUrl = 'http://localhost/' + scenario.token + prefix + '/local-danmu/';
        const request = (endpoint, method = 'GET') => handleRequest(new NodeFetchRequest(baseUrl + endpoint, { method }), env, 'node', '127.0.0.1');
        const list = await request('list');
        assert.equal(list.status, 200);
        const listing = await list.json();
        assert.ok(listing.resources.some(resource => resource.resourceKey === selected.resourceKey));
        assert.ok(listing.groups.some(group => group.title === selected.title && group.episodeCount === 2));
        assert.ok(listing.resources.every(resource => !('comments' in resource)));
        const resourcePath = encodeURIComponent(selected.resourceKey);
        const detail = await request(resourcePath);
        assert.equal(detail.status, 200);
        assert.equal((await detail.json()).resource.resourceKey, selected.resourceKey);

        const deletion = await request(resourcePath, 'DELETE');
        assert.equal(deletion.status, scenario.allowed ? 200 : 403);
        if (scenario.allowed) {
          assert.equal((await deletion.json()).success, true);
          assert.equal(await getLocalDanmu(selected.resourceKey), null);
        } else {
          assert.match((await deletion.json()).errorMessage, /ADMIN_TOKEN.*LOCAL_DANMU_NOT_REQUIRE_ADMIN=true/);
          assert.deepEqual(await getLocalDanmu(selected.resourceKey), selected);
        }
        assert.deepEqual(await getLocalDanmu(sibling.resourceKey), sibling);
      }
    }
  });
});
