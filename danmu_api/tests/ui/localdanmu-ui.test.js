// 本地弹幕页面：权限、上传、列表与批量操作
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { HTML_TEMPLATE } from '../../ui/template.js';
import { buildLocalDanmuResourceKey, groupLocalDanmuResources } from '../../utils/local-danmu-parser.js';
import { handleRequest } from '../../worker.js';
import { token } from '../helpers/context.js';
import { TestElement, fillUploadForm, makePage } from '../helpers/dom-page.js';
import { makeLocalDanmuResource } from '../helpers/local-danmu.js';

test('local danmu upload and deletion permissions apply before config loads and match the upload API', async t => {
  const userToken = 'local-user-token';
  const adminToken = 'local-admin-token';
  for (const scenario of [
    { name: 'ordinary user is denied by default', token: userToken, allowed: false },
    { name: 'ordinary user is denied when false', setting: 'false', token: userToken, allowed: false },
    { name: 'ordinary user is allowed when true', setting: 'true', token: userToken, allowed: true },
    { name: 'admin is allowed when false', setting: 'false', token: adminToken, allowed: true },
    { name: 'admin is allowed when true', setting: 'true', token: adminToken, allowed: true },
    { name: 'missing ADMIN_TOKEN does not grant admin access', setting: 'false', token: userToken, adminToken: '', allowed: false },
  ]) {
    await t.test(scenario.name, async () => {
      const env = { TOKEN: userToken, ADMIN_TOKEN: scenario.adminToken ?? adminToken, LOG_LEVEL: 'error', RATE_LIMIT_MAX_REQUESTS: '0' };
      if (scenario.setting !== undefined) env.LOCAL_DANMU_NOT_REQUIRE_ADMIN = scenario.setting;
      const baseUrl = 'http://localhost/' + scenario.token;
      const request = req => handleRequest(req, env, 'node', '127.0.0.1');
      const response = await request(new Request(baseUrl));
      assert.equal(response.status, 200);
      const alerts = [];
      let browserRequests = 0;
      let confirmations = 0;
      const { context, elements, chooseFile, box } = makePage(async () => { browserRequests++; throw new Error('Unexpected request'); }, {
        currentToken: scenario.token,
        customAlert: (message, title) => alerts.push({ message, title }),
        confirm: () => { confirmations++; return false; },
      }, await response.text());
      const checkFilePicker = () => {
        const event = new Event('click', { cancelable: true });
        assert.equal(chooseFile(event), scenario.allowed);
        assert.equal(event.defaultPrevented, !scenario.allowed);
      };
      checkFilePicker();
      context.renderLocalDanmuGroups(box, groupLocalDanmuResources([makeLocalDanmuResource(1, 1)]));
      const deleteButton = box.querySelectorAll('button')[0];
      await deleteButton.listeners.get('click')();
      assert.equal(confirmations, scenario.allowed ? 1 : 0);
      const config = await (await request(new Request(baseUrl + '/api/config'))).json();
      assert.equal(config.envs.LOCAL_DANMU_NOT_REQUIRE_ADMIN, scenario.setting === 'true');
      assert.equal(config.envVarConfig.LOCAL_DANMU_NOT_REQUIRE_ADMIN.type, 'boolean');
      context.updateLocalDanmuPermission(config);
      checkFilePicker();
      await deleteButton.listeners.get('click')();
      assert.equal(confirmations, scenario.allowed ? 2 : 0);
      if (!scenario.allowed) {
        await context.uploadLocalDanmu();
        assert.match(elements.get('local-danmu-upload-status').textContent, /需要 ADMIN 权限/);
        assert.ok(alerts.every(alert => alert.title === '权限不足' && alert.message.includes('需要 ADMIN 权限')));
        assert.equal(alerts.length, 5);
      } else {
        assert.equal(alerts.length, 0);
      }
      assert.equal(browserRequests, 0);

      for (const prefix of ['/api', '/api/v2']) {
        let bodyReads = 0;
        const upload = new Request(baseUrl + prefix + '/local-danmu/upload', { method: 'POST' });
        upload.formData = async () => { bodyReads++; return new FormData(); };
        const result = await request(upload);
        const body = await result.json();
        // Allowed requests reach file validation; denied requests never read the upload body.
        assert.equal(result.status, scenario.allowed ? 400 : 403);
        assert.equal(bodyReads, scenario.allowed ? 1 : 0);
        assert.match(body.errorMessage, scenario.allowed ? /缺少 file/ : /ADMIN_TOKEN.*LOCAL_DANMU_NOT_REQUIRE_ADMIN=true/);
      }
    });
  }
});
test('cloud local danmu requires Redis before file selection or upload', async () => {
  let requests = 0;
  const alerts = [];
  const { context, elements, chooseFile } = makePage(async (_url, options = {}) => {
    requests++;
    return options.method === 'POST'
      ? { ok: true, json: async () => ({ success: true, resource: { season: 1, count: 1 } }) }
      : { ok: true, json: async () => ({ success: true, groups: [] }) };
  }, {
    customAlert: (message, title) => alerts.push({ message, title }),
  });

  const config = {
    envs: { deployPlatform: 'vercel', redisValid: false, LOCAL_DANMU_NOT_REQUIRE_ADMIN: true },
    originalEnvVars: { ADMIN_TOKEN: 'admin-token' },
  };
  context.updateLocalDanmuPermission(config);
  const event = new Event('click', { cancelable: true });
  assert.equal(chooseFile(event), false);
  assert.equal(event.defaultPrevented, true);
  assert.equal(alerts.at(-1).title, '需要配置 Redis');
  assert.match(alerts.at(-1).message, /UPSTASH_REDIS_REST_URL/);

  fillUploadForm(elements);
  await context.uploadLocalDanmu();
  assert.equal(requests, 0);
  assert.match(elements.get('local-danmu-upload-status').textContent, /未配置可用 Redis/);

  config.envs.redisValid = true;
  context.updateLocalDanmuPermission(config);
  const readyEvent = new Event('click', { cancelable: true });
  assert.equal(chooseFile(readyEvent), true);
  await context.uploadLocalDanmu();
  assert.equal(requests, 2);
});
test('cloud local danmu page embeds Redis readiness before config refresh', async () => {
  const response = await handleRequest(
    new Request('http://localhost/87654321'),
    { TOKEN: '87654321', LOG_LEVEL: 'error' },
    'vercel',
    '127.0.0.1'
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /let localDanmuStorageReady = false;/);
  assert.match(html, /let localDanmuIsCloud = true;/);
});
test('refreshing local danmu config updates permission and an enabled flag still requires a valid token', async () => {
  const { context, chooseFile } = makePage(async () => { throw new Error('Unexpected request'); });
  for (const allowed of [false, true, false]) {
    context.updateLocalDanmuPermission({ envs: { LOCAL_DANMU_NOT_REQUIRE_ADMIN: allowed }, originalEnvVars: { ADMIN_TOKEN: '*****************' } });
    const event = new Event('click', { cancelable: true });
    assert.equal(chooseFile(event), allowed);
    assert.equal(event.defaultPrevented, !allowed);
  }
  for (const [endpoint, method] of [['upload', 'POST'], ['list', 'GET'], ['test-resource', 'DELETE']]) {
    const response = await handleRequest(new Request('http://localhost/api/local-danmu/' + endpoint, { method }), {
      TOKEN: 'local-user-token', ADMIN_TOKEN: 'local-admin-token', LOCAL_DANMU_NOT_REQUIRE_ADMIN: 'true', LOG_LEVEL: 'error',
    }, 'cloudflare', '127.0.0.1');
    assert.equal(response.status, 401);
  }
});
test('ordinary users can view imported episodes and delete them when upload permission is enabled', async () => {
  const row = makeLocalDanmuResource(1, 1);
  let groups = groupLocalDanmuResources([row]);
  const requests = [];
  const alerts = [];
  let confirmations = 0;
  const { context, box } = makePage(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (options.method === 'DELETE') {
      groups = [];
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ success: true, groups }) };
  }, {
    buildApiUrl: (url, admin) => { assert.equal(admin, false); return url; },
    customAlert: message => alerts.push(message),
    confirm: () => { confirmations++; return true; },
  });
  const config = { envs: { LOCAL_DANMU_NOT_REQUIRE_ADMIN: false }, originalEnvVars: { ADMIN_TOKEN: '*****************' } };
  context.updateLocalDanmuPermission(config);
  await context.loadLocalDanmuList();
  assert.equal(box.querySelectorAll('.local-danmu-episode').length, 1);
  const deleteButton = box.querySelectorAll('button')[0];
  await deleteButton.listeners.get('click')();
  assert.equal(confirmations, 0);
  assert.deepEqual(requests.map(request => request.method), ['GET']);
  assert.match(alerts[0], /删除本地弹幕需要 ADMIN 权限/);

  config.envs.LOCAL_DANMU_NOT_REQUIRE_ADMIN = true;
  context.updateLocalDanmuPermission(config);
  await deleteButton.listeners.get('click')();
  assert.equal(confirmations, 1);
  assert.deepEqual(requests.map(request => request.method), ['GET', 'DELETE', 'GET']);
  assert.equal(requests[1].url, '/api/local-danmu/' + encodeURIComponent(row.resourceKey));
  assert.equal(box.querySelectorAll('.local-danmu-episode').length, 0);
});
test('group cards preserve collapse state and delete only the selected season episode', async () => {
  const rows = [makeLocalDanmuResource(1, 10), makeLocalDanmuResource(1, 5), makeLocalDanmuResource(2, 5)];
  let groups = groupLocalDanmuResources(rows);
  const requests = [];
  const { context, box } = makePage(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (options.method === 'DELETE') {
      groups = groupLocalDanmuResources(rows.slice(0, 2));
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ success: true, groups }) };
  });
  await context.loadLocalDanmuList();
  let cards = box.querySelectorAll('.local-danmu-group');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].open, false);
  assert.equal(cards[1].open, false);
  assert.equal(cards[0].querySelectorAll('.local-danmu-episode').length, 2);
  assert.deepEqual(cards[0].querySelectorAll('.local-danmu-episode-title').map(element => element.textContent), ['第5集', '第10集']);
  assert.ok(cards[1].querySelectorAll('summary')[0].textContent.includes('2026 · 电视剧 · 第2季'));
  assert.ok(box.textContent.includes('<img src=x> 分季剧'));
  assert.equal(box.querySelectorAll('img').length, 0);
  cards[0].open = true;
  await context.loadLocalDanmuList();
  cards = box.querySelectorAll('.local-danmu-group');
  assert.equal(cards[0].open, true);
  await cards[1].querySelectorAll('button')[0].listeners.get('click')();
  assert.equal(requests.find(request => request.method === 'DELETE').url, '/api/local-danmu/' + encodeURIComponent(rows[2].resourceKey));
  assert.equal(box.querySelectorAll('.local-danmu-group').length, 1);
  assert.equal(box.querySelectorAll('.local-danmu-episode').length, 2);
});
test('local danmu list filters uploaded groups by title', async () => {
  const groups = groupLocalDanmuResources([makeLocalDanmuResource(1, 1), { ...makeLocalDanmuResource(1, 2), title: '另一部作品', resourceKey: buildLocalDanmuResourceKey({ ...makeLocalDanmuResource(1, 2), title: '另一部作品' }) }]);
  const { context, box, elements } = makePage(async () => ({ ok: true, json: async () => ({ success: true, groups }) }));
  context.initializeLocalDanmuForm();
  await context.loadLocalDanmuList();
  assert.equal(box.querySelectorAll('.local-danmu-group').length, 2);
  elements.get('local-danmu-search').value = '分季';
  elements.get('local-danmu-search').listeners.get('input')();
  assert.equal(box.querySelectorAll('.local-danmu-group').length, 1);
  assert.equal(box.querySelectorAll('.local-danmu-group-title')[0].textContent, '<img src=x> 分季剧');
  elements.get('local-danmu-search').value = '不存在';
  elements.get('local-danmu-search').listeners.get('input')();
  assert.match(box.textContent, /未找到匹配标题/);
  elements.get('local-danmu-search').value = '';
  elements.get('local-danmu-search').listeners.get('input')();
  assert.equal(box.querySelectorAll('.local-danmu-group').length, 2);
});
test('local danmu can delete an entire series in one action', async () => {
  const rows = [makeLocalDanmuResource(1, 1), makeLocalDanmuResource(1, 2)];
  let groups = groupLocalDanmuResources(rows);
  const requests = [];
  let confirmations = 0;
  const { context, box } = makePage(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    if (options.method === 'DELETE') {
      groups = [];
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: true, json: async () => ({ success: true, groups }) };
  }, { confirm: () => { confirmations++; return true; } });
  await context.loadLocalDanmuList();
  const card = box.querySelectorAll('.local-danmu-group')[0];
  const removeGroup = card.querySelectorAll('button').at(-1);
  await removeGroup.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(confirmations, 1);
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 2);
  assert.equal(box.querySelectorAll('.local-danmu-group').length, 0, JSON.stringify(requests));
});
test('local danmu re-upload fills the original resource metadata', async () => {
  const row = makeLocalDanmuResource(2, 7);
  const { context, elements, box } = makePage(async () => ({ ok: true, json: async () => ({ success: true, groups: [] }) }));
  context.renderLocalDanmuGroups(box, groupLocalDanmuResources([row]));
  const reupload = box.querySelectorAll('button')[1];
  await reupload.listeners.get('click')();
  assert.equal(elements.get('local-danmu-title').value, row.title);
  assert.equal(elements.get('local-danmu-year').value, String(row.year));
  assert.equal(elements.get('local-danmu-type').value, row.type);
  assert.equal(elements.get('local-danmu-season').value, String(row.season));
  assert.equal(elements.get('local-danmu-episode').value, String(row.episode));
  assert.match(elements.get('local-danmu-upload-status').textContent, /请选择新文件/);
});
test('local danmu edit dialogs save metadata, close and refresh the list', async () => {
  const row = makeLocalDanmuResource(2, 7);
  const groups = groupLocalDanmuResources([row]);
  const requests = [];
  const { context, elements, box } = makePage(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    return Response.json({ success: true, groups });
  });
  context.renderLocalDanmuGroups(box, groups);
  const modal = elements.get('local-danmu-edit-modal');
  const scenarios = [
    {
      button: '编辑剧集', fields: { name: '修改标题', year: '2025', type: 'tv', season: '3' },
      body: { scope: 'group', title: '修改标题', year: '2025', type: 'tv', season: '3' },
    },
    {
      button: '编辑', fields: { episode: '8', filename: '新文件名.xml' },
      body: { scope: 'resource', episode: '8', filename: '新文件名.xml' },
    },
  ];
  for (const scenario of scenarios) {
    requests.length = 0;
    const edit = box.querySelectorAll('button').find(button => button.textContent === scenario.button);
    edit.listeners.get('click')();
    assert.equal(modal.classList.contains('active'), true);
    assert.equal(modal.attributes['aria-hidden'], 'false');
    for (const [field, value] of Object.entries(scenario.fields)) elements.get('local-danmu-edit-' + field).value = value;
    await context.submitLocalDanmuEdit();
    assert.deepEqual(requests, [
      { url: '/api/local-danmu/' + encodeURIComponent(row.resourceKey), method: 'PATCH', body: scenario.body },
      { url: '/api/local-danmu/list', method: 'GET', body: undefined },
    ]);
    assert.equal(modal.classList.contains('active'), false);
    assert.equal(modal.attributes['aria-hidden'], 'true');
    assert.equal(elements.get('local-danmu-edit-status').textContent, '');
  }
});
test('local danmu edit failures keep the dialog and input without refreshing', async t => {
  const conflict = '目标资源已存在，无法覆盖';
  const genericError = '更新失败，请稍后重试';
  for (const scenario of [
    { name: 'conflict', respond: () => Response.json({ success: false, errorMessage: conflict }, { status: 409 }), message: conflict },
    { name: 'unsuccessful result', respond: () => Response.json({ success: false }), message: '更新失败' },
    { name: 'non-JSON response', respond: () => new Response('<html>Bad gateway</html>', { status: 502 }), message: genericError },
    { name: 'network failure', respond: () => { throw new Error('offline'); }, message: genericError },
  ]) {
    await t.test(scenario.name, async () => {
      const requests = [];
      const { context, elements } = makePage(async (url, options = {}) => {
        requests.push({ url, method: options.method || 'GET' });
        return scenario.respond();
      });
      const row = makeLocalDanmuResource(2, 7);
      context.openLocalDanmuEdit('resource', row);
      elements.get('local-danmu-edit-filename').value = '未保存.xml';
      await context.submitLocalDanmuEdit();
      assert.deepEqual(requests, [{ url: '/api/local-danmu/' + encodeURIComponent(row.resourceKey), method: 'PATCH' }]);
      assert.equal(elements.get('local-danmu-edit-modal').classList.contains('active'), true);
      assert.equal(elements.get('local-danmu-edit-modal').attributes['aria-hidden'], 'false');
      assert.equal(elements.get('local-danmu-edit-filename').value, '未保存.xml');
      assert.equal(elements.get('local-danmu-edit-status').textContent, scenario.message);
    });
  }
});
test('local danmu edits block episode and group deletion until cancelled', async () => {
  const row = makeLocalDanmuResource(2, 7);
  const groups = groupLocalDanmuResources([row]);
  const requests = [];
  let confirmations = 0;
  const { context, elements } = makePage(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET' });
    return Response.json({ success: true, groups });
  }, { confirm: () => { confirmations++; return true; } });
  await context.loadLocalDanmuList();
  for (const scope of ['resource', 'group']) {
    requests.length = 0;
    confirmations = 0;
    context.openLocalDanmuEdit(scope, scope === 'group' ? groups[0] : row);
    await context.deleteLocalDanmu(row.resourceKey);
    await context.deleteLocalDanmuGroup(groups[0]);
    assert.equal(confirmations, 0);
    assert.deepEqual(requests, []);
    context.closeLocalDanmuEdit();
    assert.equal(elements.get('local-danmu-edit-modal').classList.contains('active'), false);
    assert.equal(elements.get('local-danmu-edit-modal').attributes['aria-hidden'], 'true');
    if (scope === 'group') await context.deleteLocalDanmuGroup(groups[0]);
    else await context.deleteLocalDanmu(row.resourceKey);
    assert.equal(confirmations, 1);
    assert.deepEqual(requests, [
      { url: '/api/local-danmu/' + encodeURIComponent(row.resourceKey), method: 'DELETE' },
      { url: '/api/local-danmu/list', method: 'GET' },
    ]);
  }
});
test('batch local danmu recognizes explicit and numbered filenames without guessing release years', () => {
  const { context } = makePage(async () => { throw new Error('Unexpected request'); });
  for (const [filename, episode] of [
    ['Show.S02E08.1080p.xml', 8], ['Show.S02EP09.json', 9], ['Show.EP010.ass', 10],
    ['Show.E11.ssa', 11], ['剧名 第 12 集.csv', 12], ['剧名第13話.txt', 13],
    ['014.xml', 14], ['剧名 - 15 (1080p).xml', 15], ['剧名_16.json', 16],
    ['剧名.ＥＰ１７.xml', 17], ['Show.Episode 18.xml', 18],
    ['Show.2026.1080p.xml', null], ['Show.2026.xml', null], ['unknown.xml', null],
    ['Show.E00.xml', null], ['Show.E9007199254740992.xml', null],
  ]) assert.equal(context.localDanmuEpisodeFromFilename(filename), episode, filename);
  assert.match(HTML_TEMPLATE, /<input\b[^>]*id="local-danmu-file"[^>]*\bmultiple\b/);
});
test('batch local danmu previews editable episodes and uploads serially with shared metadata', async () => {
  const posts = [];
  let active = 0;
  let maxActive = 0;
  let listLoads = 0;
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const { context, elements } = makePage(async (url, options = {}) => {
    if (options.method !== 'POST') {
      assert.equal(url, '/api/local-danmu/list');
      listLoads++;
      return Response.json({ success: true, groups: [] });
    }
    assert.equal(url, '/api/local-danmu/upload');
    posts.push(options.body);
    maxActive = Math.max(maxActive, ++active);
    if (posts.length === 1) await firstResponse;
    active--;
    return Response.json({ success: true, resource: { season: 2, count: 2 } });
  });
  context.initializeLocalDanmuForm();
  fillUploadForm(elements, { title: '批量剧集', season: '2' });
  const file = elements.get('local-danmu-file');
  file.files = ['Series.S02E10.xml', 'Series.S02E02.xml', 'Series.unknown.xml'].map(name => new File(['<i/>'], name));
  file.listeners.get('change')();
  const inputs = elements.get('local-danmu-batch-list').querySelectorAll('input');
  assert.deepEqual(inputs.map(input => input.value), ['2', '10', '']);
  assert.equal(elements.get('local-danmu-batch-preview').hidden, false);
  assert.equal(elements.get('local-danmu-episode-field').hidden, true);
  await context.uploadLocalDanmu();
  assert.equal(posts.length, 0);
  assert.match(elements.get('local-danmu-upload-status').textContent, /有效且不重复/);
  inputs[2].value = '12';
  inputs[2].listeners.get('input')();
  const pending = context.uploadLocalDanmu();
  try {
    assert.equal(posts.length, 1);
    assert.equal(file.disabled, true);
    assert.equal(elements.get('local-danmu-title').disabled, true);
    assert.equal(elements.get('local-danmu-upload-button').disabled, true);
    assert.ok(inputs.every(input => input.disabled));
    await context.uploadLocalDanmu();
    context.prepareLocalDanmuReupload(makeLocalDanmuResource(3, 4));
    assert.equal(posts.length, 1);
    assert.equal(elements.get('local-danmu-title').value, '批量剧集');
  } finally { releaseFirst(); }
  await pending;
  assert.equal(maxActive, 1);
  assert.equal(listLoads, 1);
  assert.deepEqual(posts.map(body => body.get('episode')), ['2', '10', '12']);
  for (const body of posts) {
    assert.equal(body.get('title'), '批量剧集');
    assert.equal(body.get('year'), '2026');
    assert.equal(body.get('type'), 'tv');
    assert.equal(body.get('season'), '2');
    assert.equal(body.getAll('file').length, 1);
  }
  assert.equal(file.disabled, false);
  assert.equal(elements.get('local-danmu-upload-button').disabled, false);
  assert.ok(inputs.every(input => !input.disabled));
  assert.match(elements.get('local-danmu-upload-status').textContent, /成功 3 个，失败 0 个，共 6 条弹幕/);
});
test('batch local danmu rejects invalid or duplicate episodes before uploading any files', async t => {
  for (const scenario of [
    { name: 'duplicate filenames', names: ['A.E01.xml', 'B.E01.json'] },
    { name: 'duplicate manual episode', value: '1' },
    { name: 'empty episode', value: '' },
    { name: 'zero episode', value: '0' },
    { name: 'fractional episode', value: '1.5' },
    { name: 'invalid numeric input', badInput: true },
    { name: 'movie batch', type: 'movie' },
  ]) {
    await t.test(scenario.name, async () => {
      let requests = 0;
      const { context, elements } = makePage(async () => { requests++; throw new Error('Unexpected request'); });
      fillUploadForm(elements, { type: scenario.type || 'tv' });
      elements.get('local-danmu-file').files = (scenario.names || ['E01.xml', 'E02.xml']).map(name => new File(['<i/>'], name));
      context.updateLocalDanmuUploadFiles();
      const input = elements.get('local-danmu-batch-list').querySelectorAll('input')[1];
      if (scenario.value !== undefined) input.value = scenario.value;
      if (scenario.badInput) input.validity.badInput = true;
      await context.uploadLocalDanmu();
      assert.equal(requests, 0);
      assert.match(elements.get('local-danmu-upload-status').textContent, scenario.type ? /tv/ : /有效且不重复/);
      assert.notEqual(elements.get('local-danmu-upload-button').disabled, true);
    });
  }
});
test('batch local danmu continues after failed or oversized files and reports each result', async () => {
  const uploads = [];
  let listLoads = 0;
  const { context, elements } = makePage(async (_url, options = {}) => {
    if (options.method !== 'POST') {
      listLoads++;
      return Response.json({ success: true, groups: [] });
    }
    const episode = Number(options.body.get('episode'));
    uploads.push(episode);
    if (episode === 2) return Response.json({ success: false, errorMessage: '文件中没有有效弹幕' }, { status: 400 });
    if (episode === 3) return new Response('<html>Bad gateway</html>', { status: 502 });
    if (episode === 4) throw new Error('offline');
    return Response.json({ success: true, resource: { count: 3 } });
  });
  fillUploadForm(elements);
  elements.get('local-danmu-file').files = [
    ...[1, 2, 3, 4].map(episode => new File(['<i/>'], 'E0' + episode + '.xml')),
    { name: 'E05.xml', size: 10 * 1024 * 1024 + 1 },
    new File(['<i/>'], 'E06.xml'),
  ];
  await context.uploadLocalDanmu();
  assert.deepEqual(uploads, [1, 2, 3, 4, 6]);
  assert.equal(listLoads, 1);
  const statuses = elements.get('local-danmu-batch-list').querySelectorAll('.local-danmu-batch-status').map(element => element.textContent);
  assert.match(statuses[0], /成功/);
  assert.match(statuses[1], /文件中没有有效弹幕/);
  assert.match(statuses[2], /失败/);
  assert.match(statuses[3], /失败/);
  assert.match(statuses[4], /10 MB/);
  assert.match(statuses[5], /成功/);
  assert.match(elements.get('local-danmu-upload-status').textContent, /成功 2 个，失败 4 个，共 6 条弹幕/);
  assert.equal(elements.get('local-danmu-file').disabled, false);
});
test('switching back to one local danmu file restores the manual episode field', async () => {
  let uploaded;
  const { context, elements } = makePage(async (_url, options = {}) => {
    if (options.method === 'POST') uploaded = options.body;
    return Response.json({ success: true, resource: { season: 1, count: 1 }, groups: [] });
  });
  context.initializeLocalDanmuForm();
  fillUploadForm(elements, { episode: '9' });
  const file = elements.get('local-danmu-file');
  file.files = ['E01.xml', 'E02.xml'].map(name => new File(['<i/>'], name));
  file.listeners.get('change')();
  file.files = [file.files[0]];
  file.listeners.get('change')();
  assert.equal(elements.get('local-danmu-batch-preview').hidden, true);
  assert.equal(elements.get('local-danmu-episode-field').hidden, false);
  assert.equal(elements.get('local-danmu-batch-list').children.length, 0);
  assert.equal(elements.get('local-danmu-upload-button').textContent, '上传并解析');
  await context.uploadLocalDanmu();
  assert.equal(uploaded.get('episode'), '9');
});
test('upload sends the selected season and retains series fields for the next episode', async () => {
  let uploaded = null;
  const { context, elements } = makePage(async (_url, options = {}) => {
    if (options.method === 'POST') {
      uploaded = options.body;
      return { ok: true, json: async () => ({ success: true, resource: { season: 2, count: 4 } }) };
    }
    return { ok: true, json: async () => ({ success: true, groups: [] }) };
  });
  fillUploadForm(elements, { title: ' 分季剧 ', season: '2' });
  await context.uploadLocalDanmu();
  assert.equal(uploaded.get('title'), '分季剧');
  assert.equal(uploaded.get('season'), '2');
  assert.equal(uploaded.get('episode'), '5');
  assert.equal(uploaded.get('year'), '2026');
  assert.equal(uploaded.get('type'), 'tv');
  assert.equal(elements.get('local-danmu-season').value, '2');
  assert.equal(elements.get('local-danmu-title').value, ' 分季剧 ');
  assert.equal(elements.get('local-danmu-upload-button').disabled, false);
  assert.ok(elements.get('local-danmu-upload-status').textContent.includes('第2季上传成功'));
  uploaded = null;
  elements.get('local-danmu-season').value = '0';
  await context.uploadLocalDanmu();
  assert.equal(uploaded, null);
  assert.ok(elements.get('local-danmu-upload-status').textContent.includes('季数'));
});
test('upload form labels and initial year options match the current year', () => {
  const currentYear = new Date().getFullYear();
  const select = HTML_TEMPLATE.match(/<select id="local-danmu-year" required>([\s\S]*?)<\/select>/)[1];
  const options = Array.from(select.matchAll(/<option value="(\d{4})"( selected)?>/g));
  assert.deepEqual(options.map(option => Number(option[1])), Array.from({ length: currentYear - 1900 + 1 }, (_, index) => currentYear - index));
  assert.equal(options[0][2], ' selected');
  assert.equal(options.filter(option => option[2]).length, 1);
  assert.match(HTML_TEMPLATE, /<label for="local-danmu-title">标题（必填）<\/label>/);
  assert.match(HTML_TEMPLATE, /<label id="local-danmu-season-label" for="local-danmu-season">季<\/label>/);
  assert.match(HTML_TEMPLATE, /<label id="local-danmu-episode-label" for="local-danmu-episode">集<\/label>/);
});
test('opening the page defaults to the current browser year and updates optional movie fields', () => {
  const { elements, documentListeners } = makePage(async () => ({ ok: true, json: async () => ({ groups: [] }) }), {
    Date: class extends Date { getFullYear() { return 2034; } },
  });
  const staleOption = new TestElement('option');
  staleOption.value = '2050';
  elements.get('local-danmu-year').append(staleOption);
  documentListeners.get('DOMContentLoaded')();
  assert.equal(elements.get('local-danmu-year').value, '2034');
  const options = elements.get('local-danmu-year').children;
  assert.equal(options[0].value, '2034');
  assert.equal(options.at(-1).value, '1900');
  assert.deepEqual(options.map(option => Number(option.value)), Array.from({ length: 2034 - 1900 + 1 }, (_, index) => 2034 - index));
  assert.equal(elements.get('local-danmu-season').value, '1');
  assert.equal(elements.get('local-danmu-episode').value, '1');
  const type = elements.get('local-danmu-type');
  type.value = 'movie';
  type.listeners.get('change')();
  assert.equal(elements.get('local-danmu-season').value, '');
  assert.equal(elements.get('local-danmu-episode').value, '');
  assert.ok(elements.get('local-danmu-season-label').textContent.includes('可选'));
  assert.ok(elements.get('local-danmu-episode-label').textContent.includes('可选'));
  type.value = 'tv';
  type.listeners.get('change')();
  assert.equal(elements.get('local-danmu-season').value, '1');
  assert.equal(elements.get('local-danmu-episode').value, '1');
  assert.equal(elements.get('local-danmu-episode-label').textContent, '集');
});
test('missing or invalid upload metadata is rejected before sending any request', async () => {
  let requests = 0;
  const { context, elements } = makePage(async () => { requests++; throw new Error('Unexpected request'); });
  for (const [fields, message] of [
    [{ year: '' }, /年份/],
    [{ year: String(new Date().getFullYear() + 1) }, /年份/],
    [{ year: '1899' }, /年份/],
    [{ year: '2026abc' }, /年份/],
    [{ type: '' }, /类型/],
    [{ type: 'ova' }, /类型/],
    [{ type: 'special' }, /类型/],
    [{ type: 'movie', season: '0' }, /季数/],
    [{ type: 'movie', episode: '1.5' }, /集数/],
  ]) {
    fillUploadForm(elements, fields);
    await context.uploadLocalDanmu();
    assert.match(elements.get('local-danmu-upload-status').textContent, message);
  }
  fillUploadForm(elements, { type: 'movie', season: '' });
  elements.get('local-danmu-season').validity.badInput = true;
  await context.uploadLocalDanmu();
  assert.match(elements.get('local-danmu-upload-status').textContent, /季数/);
  assert.equal(requests, 0);
});
test('movies may omit season and episode while TV uploads default both to one', async () => {
  const currentYear = String(new Date().getFullYear());
  const uploads = [];
  const { context, elements, box } = makePage(async (_url, options = {}) => {
    if (options.method === 'POST') {
      uploads.push(options.body);
      return { ok: true, json: async () => ({ success: true, resource: { season: Number(options.body.get('season') || 1), count: 4 } }) };
    }
    return { ok: true, json: async () => ({ success: true, groups: [] }) };
  });
  fillUploadForm(elements, { type: 'movie', year: currentYear, season: '', episode: '' });
  await context.uploadLocalDanmu();
  assert.equal(uploads[0].get('year'), currentYear);
  assert.equal(uploads[0].get('type'), 'movie');
  assert.equal(uploads[0].has('season'), false);
  assert.equal(uploads[0].has('episode'), false);
  assert.equal(elements.get('local-danmu-season').value, '');
  assert.equal(elements.get('local-danmu-year').value, currentYear);
  assert.match(elements.get('local-danmu-upload-status').textContent, /电影上传成功/);

  const movie = { ...makeLocalDanmuResource(1, null), type: 'movie' };
  movie.resourceKey = buildLocalDanmuResourceKey(movie);
  context.renderLocalDanmuGroups(box, groupLocalDanmuResources([movie]));
  assert.equal(box.querySelectorAll('.local-danmu-episode-title')[0].textContent, '正片');
  assert.ok(!box.querySelectorAll('.local-danmu-group-meta')[0].textContent.includes('第1季'));

  fillUploadForm(elements, { type: 'movie', season: '2', episode: '1' });
  await context.uploadLocalDanmu();
  assert.equal(uploads[1].get('season'), '2');
  assert.equal(uploads[1].get('episode'), '1');

  fillUploadForm(elements, { type: 'tv', season: '', episode: '' });
  await context.uploadLocalDanmu();
  assert.equal(uploads[2].get('season'), '1');
  assert.equal(elements.get('local-danmu-season').value, '1');
  assert.equal(uploads[2].get('episode'), '1');
  assert.equal(elements.get('local-danmu-episode').value, '1');
  assert.match(elements.get('local-danmu-upload-status').textContent, /第1季上传成功/);
});
