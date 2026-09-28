import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('Forward bundles preserve the search-to-comment flow without Node storage', async t => {
  for (const debug of [false, true]) {
    await t.test(debug ? 'debug bundle' : 'release bundle', async () => {
      execFileSync(process.execPath, ['build-forward-widget.js', ...(debug ? ['--debug'] : [])], {
        cwd: projectRoot,
        timeout: 30000,
        stdio: 'pipe',
      });
      const filename = debug ? 'logvar-danmu.debug.js' : 'logvar-danmu.js';
      const bundle = readFileSync(new URL(`../dist/${filename}`, import.meta.url), 'utf8');
      const storage = new Map();
      const requests = [];
      const comments = [{ p: '1,1,16777215', m: '插件构建回归测试' }];
      const context = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        Widget: {
          storage: {
            get: key => storage.get(key) ?? null,
            set: (key, value) => storage.set(key, value),
            remove: key => storage.delete(key),
            clear: () => storage.clear(),
          },
          http: {
            get: async url => {
              const request = new URL(url);
              assert.equal(request.origin, 'https://forward.test');
              requests.push(request.pathname);
              if (request.pathname === '/api/v2/search/anime') {
                return { status: 200, data: { animes: [{
                  animeId: 9001,
                  bangumiId: '9001',
                  animeTitle: '插件构建测试',
                  startDate: '2026-01-01',
                  type: 'tvseries',
                  typeDescription: 'TV',
                }] } };
              }
              if (request.pathname === '/api/v2/bangumi/9001') {
                return { status: 200, data: { bangumi: { episodes: [{
                  episodeId: 900101,
                  episodeTitle: '第1集',
                  episodeNumber: '1',
                }] } } };
              }
              assert.equal(request.pathname, '/api/v2/comment/900101');
              return { status: 200, data: { comments } };
            },
            post: async () => assert.fail('The fixture does not require POST requests'),
          },
        },
      });

      // A script-only runtime has no module loader, process, Buffer, or filesystem.
      new vm.Script(bundle, { filename }).runInContext(context, { timeout: 5000 });
      const params = {
        title: '插件构建测试',
        type: 'tv',
        tmdbId: '9001',
        season: 1,
        episode: 1,
        sourceOrder: 'local,custom',
        customSourceApiUrl: 'https://forward.test',
        tmdbApiKey: '',
      };
      const search = await context.searchDanmu(params);
      assert.deepEqual(Array.from(search.animes, anime => anime.animeId), [9001]);
      const episodes = await context.getDetailById({ ...params, animeId: 9001 });
      assert.equal(episodes.length, 1);
      const segments = await context.getCommentsById({ ...params, commentId: episodes[0].episodeId });
      assert.equal(segments.length, 1);
      const result = await context.getDanmuWithSegmentTime({ ...params, segmentTime: 0 });
      assert.equal(result.count, 1);
      assert.equal(result.comments[0].m, comments[0].m);
      assert.deepEqual(requests, [
        '/api/v2/search/anime',
        '/api/v2/bangumi/9001',
        '/api/v2/comment/900101',
      ]);
    });
  }
});
