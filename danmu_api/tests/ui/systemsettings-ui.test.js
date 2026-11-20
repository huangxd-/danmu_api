// 系统设置页面：清理缓存与收藏控件
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { apitestJsContent } from '../../ui/js/apitest.js';
import { previewJsContent } from '../../ui/js/preview.js';
import { systemSettingsJsContent } from '../../ui/js/systemsettings.js';
import { HTML_TEMPLATE } from '../../ui/template.js';

test('按剧匹配规则使用当前配置的来源下拉框，其他映射仍可自由输入', () => {
  const container = {};
  const context = vm.createContext({
    document: {
      body: { dataset: {} }, addEventListener() {},
      getElementById: id => id === 'value-input-container' ? container : id === 'env-form' ? { addEventListener() {} } : null
    },
    window: { addEventListener() {} }, editingCategory: 'match', uiIcon: () => '',
    escapeHtml: value => value.replaceAll('&', '&amp;'), previewState: { categorizedVars: {} }
  });
  vm.runInContext(systemSettingsJsContent, context);
  const item = { key: 'TITLE_PLATFORM_MAP', type: 'map', options: ['first'] };
  context.renderValueInput(item);
  assert.match(container.innerHTML, /<select class="map-input-right"[\s\S]*value="first"/);
  context.previewState.categorizedVars.match = [{ key: item.key, options: ['second&third'] }];
  context.renderValueInput(item);
  assert.match(container.innerHTML, /<option value="second&amp;third">/);
  assert.doesNotMatch(container.innerHTML, /value="first"/);
  context.renderValueInput({ key: 'TITLE_MAPPING_TABLE', type: 'map' });
  assert.match(container.innerHTML, /<input type="text" class="map-input-right"/);
});

test('cache clear UI displays recovery instructions and persistence failures', async () => {
  const start = systemSettingsJsContent.indexOf('async function confirmClearCache()');
  const end = systemSettingsJsContent.indexOf('// 显示重新部署确认模态框', start);
  for (const result of [
    { success: true, restartRequired: true, message: '选中项已清理，请重启恢复其他缓存', clearedItems: { episodeIds: 0 } },
    { success: false, message: '内存已清理，但 file 保存失败；未保存的后端仍保留清理前数据，重启后会重新加载，请重试' }
  ]) {
    const alerts = []; const logs = [];
    const context = vm.createContext({
      document: { querySelectorAll: () => [{ value: 'episodeIds' }] },
      checkDeployPlatformConfig: async () => ({ success: true }),
      customAlert: message => alerts.push(message),
      addLog: (message, level) => logs.push({ message, level }),
      hideClearCacheModal() {}, showLoading() {}, updateLoadingText() {}, hideLoading() {}, setTimeout() {},
      buildApiUrl: () => 'http://localhost/api/cache/clear',
      fetch: async () => ({ json: async () => result })
    });
    vm.runInContext(systemSettingsJsContent.slice(start, end), context);
    await context.confirmClearCache();
    if (result.success) assert.deepEqual(alerts, [result.message]);
    else assert.ok(logs.some(entry => entry.level === 'error' && entry.message.includes(result.message)));
  }
});
test('frontend bundle contains working favorite controls', () => {
      assert.match(HTML_TEMPLATE, /id="manual-favorite-btn"/);
      assert.doesNotMatch(HTML_TEMPLATE, /id="auto-favorite-btn"/);
      assert.match(HTML_TEMPLATE, /id="favorite-panel"/);
      assert.match(HTML_TEMPLATE, /switchDanmuTestTab\('favorite'/);
      assert.match(apitestJsContent, /function favoriteManualSearch\(\)/);
      assert.match(apitestJsContent, /function setManualFavoriteButton/);
      assert.match(apitestJsContent, /取消收藏 · /);
      assert.match(apitestJsContent, /removing \? '\/api\/v2\/favorite\/remove'/);
      assert.match(apitestJsContent, /JSON\.stringify\(\{ keyword \}\)/);
      assert.match(apitestJsContent, /\/api\/v2\/favorite\/refresh/);
      assert.match(apitestJsContent, /\/api\/v2\/favorite\/remove/);
      assert.match(apitestJsContent, /最近刷新时间：/);
      assert.match(apitestJsContent, /确认下载红果合集/);
      assert.match(apitestJsContent, /fetchHongguoCollectionDanmu/);
      assert.match(apitestJsContent, /segmentflag=true/);
      assert.match(apitestJsContent, /currentCollectionEpisodeCount/);
      assert.match(apitestJsContent, /获取全集弹幕（/);
      assert.doesNotMatch(systemSettingsJsContent, /switchCategory\('favorite'\)/);
      assert.match(systemSettingsJsContent, /const isMergeSourcePairs = currentKey === 'MERGE_SOURCE_PAIRS'/);
      // 合并模式只禁止同一合并组内重复，已选源需保持可选取才能组合成合并组
      assert.match(systemSettingsJsContent, /if \(stagingTokens\.has\(value\)\) \{\s*shouldDisable = true;/);
      assert.match(systemSettingsJsContent, /String\(element\.dataset\.value \|\| ''\)\.split\('&'\)/);
      assert.doesNotThrow(() => new Function(apitestJsContent));
      assert.doesNotThrow(() => new Function(systemSettingsJsContent));
      assert.doesNotThrow(() => new Function(previewJsContent));
      assert.match(previewJsContent, /AUTO_MATCH_MAPPING_TABLE/);
      // 连通性测试以表单值随请求提交，避免云部署下未重新部署时取不到新配置
      assert.match(systemSettingsJsContent, /function readLocalEnvValue\(key\)/);
      assert.match(systemSettingsJsContent, /aiBaseUrl: readLocalEnvValue\('AI_BASE_URL'\)/);
      assert.match(systemSettingsJsContent, /aiModel: readLocalEnvValue\('AI_MODEL'\)/);
      assert.match(systemSettingsJsContent, /payload\.aiApiKey = apiKey/);
      assert.match(systemSettingsJsContent, /dandanplayAccount: readLocalEnvValue\('DANDANPLAY_ACCOUNT'\)/);
      assert.match(systemSettingsJsContent, /payload\.dandanplayPassword = password/);
      assert.doesNotMatch(systemSettingsJsContent, /JSON\.stringify\(isMasked \? \{\} : \{ 'aiApiKey': apiKey \}\)/);
      assert.doesNotMatch(systemSettingsJsContent, /JSON\.stringify\(isMasked \? \{\} : \{ 'dandanplayPassword': password \}\)/);
    });

test('系统设置页的环境变量写接口统一携带 ADMIN_TOKEN', () => {
    // 服务端对 /api/env/* 强制要求 ADMIN_TOKEN，前端必须使用 buildApiUrl(path, true)
    assert.match(systemSettingsJsContent, /buildApiUrl\(endpoint, true\)/);
    assert.match(systemSettingsJsContent, /buildApiUrl\('\/api\/env\/set', true\)/);
    assert.match(systemSettingsJsContent, /buildApiUrl\('\/api\/env\/add', true\)/);
    assert.match(systemSettingsJsContent, /buildApiUrl\('\/api\/env\/del', true\)/);
    // 不应残留不带 admin token 的调用
    assert.doesNotMatch(systemSettingsJsContent, /buildApiUrl\('\/api\/env\/(?:set|add|del)'\)/);
    // 401 时给出统一提示且不再回落 add 接口
    assert.match(systemSettingsJsContent, /function isAdminAuthError\(status, result\)/);
    assert.match(systemSettingsJsContent, /alertAdminTokenRequired\(\)/);
});
