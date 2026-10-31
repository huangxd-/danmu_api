// 本地弹幕解析：XML/ASS 与季数、分组
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Season } from '../../models/dandan-model.js';
import { logviewJsContent } from '../../ui/js/logview.js';
import { buildLocalDanmuResourceKey, groupLocalDanmuResources, parseLocalDanmu, normalizeLocalSeason } from '../../utils/local-danmu-parser.js';
import { localDanmuExpected, localDanmuJson } from '../helpers/local-danmu.js';

test('UTF-8 JSON preserves a literal replacement character without changing encoding', () => {
  assert.deepEqual(parseLocalDanmu(Buffer.from(localDanmuJson, 'utf8'), 'danmu.json'), localDanmuExpected);
});
test('local XML reads the Bilibili color field instead of the font size', () => {
  const xml = '<i>'
    + '<d p="1.00,1,25,16777215,1700000000,0,abc,1001">白色弹幕</d>'
    + '<d p="2.00,1,25,16711680,1700000001,0,abc,1002">红色弹幕</d>'
    + '<d p="3.00,1,16711680,0">旧四段格式</d>'
    + '</i>';
  assert.deepEqual(parseLocalDanmu(Buffer.from(xml, 'utf8'), 'bili.xml').comments, [
    { p: '1.00,1,16777215', m: '白色弹幕' },
    { p: '2.00,1,16711680', m: '红色弹幕' },
    { p: '3.00,1,16711680', m: '旧四段格式' },
  ]);
});
const assFixture = (events, styles = '', wrapStyle = 2) => `[Script Info]
ScriptType: v4.00+
WrapStyle: ${wrapStyle}
[V4+ Styles]
Format: Name, PrimaryColour, Alignment
${styles}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.map(text => `Dialogue: 0,0:00:01.18,0:00:06.18,Default,,0,0,0,,${text}`).join('\n')}`;
const parseAssFixture = (...args) => parseLocalDanmu(Buffer.from(assFixture(...args)), 'test.ass');
test('local ASS strips override tags while preserving literal text and commas', () => {
  const ass = assFixture([String.raw`{\move(1280,0,-288,0)}滚动,弹幕`, String.raw`{\move(1280,329,-124,329)}<(ºOº)>`])
    .replace('Dialogue: 0,0:00:01.18,0:00:06.18', 'Dialogue: 0,0:00:01.09,0:00:10.09');
  const result = parseLocalDanmu(Buffer.from(ass), 'test.ass');
  assert.deepEqual(result.comments, [
    { p: '1.09,1,16777215', m: '滚动,弹幕' },
    { p: '1.18,1,16777215', m: '<(ºOº)>' },
  ]);
  assert.deepEqual(result.errors, []);
});
test('local ASS maps primary colors and fixed alignment with movement taking precedence', () => {
  const result = parseAssFixture([
    String.raw`{\an8\pos(640,47)\c&H02F1FE&}顶部`,
    String.raw`{\an2\1c&H000000&}黑色底部`,
    String.raw`{\an8\move(1280,0,-100,0)}滚动`,
    '样式继承',
  ], 'Style: Default,&H320000FF,8');
  assert.deepEqual(result.comments.map(x => x.p), [`1.18,5,${0xFEF102}`, '1.18,4,0', '1.18,1,16711680', '1.18,5,16711680']);
});
test('local ASS skips drawings and decodes line breaks and hard spaces', () => {
  const result = parseAssFixture([
    String.raw`{\p1}m 0 0 l 100 100{\p0}甲\h乙\n丙\N丁`,
    String.raw`{\p1}m 0 0 l 10 10`,
  ]);
  assert.deepEqual(result.comments.map(x => x.m), ['甲\u00a0乙\n丙\n丁']);
  assert.equal(parseAssFixture([String.raw`甲\n乙`], '', 0).comments[0].m, '甲 乙');
  assert.equal(parseAssFixture([String.raw`{\q2}甲\n乙`], '', 0).comments[0].m, '甲\n乙');
});
test('local ASS uses first visible text color and supports style resets', () => {
  const result = parseAssFixture([
    String.raw`{\c&H0000FF&}红{\c&HFF0000&}蓝`,
    String.raw`{\c&H0000FF&\r}默认`,
    String.raw`{\rTop}顶部`,
    String.raw`{\t(0,100,\clip(0,0,100,100)\c&H0000FF&)}默认`,
    String.raw`{\c&H000000&\clip(0,0,100,100)}黑色`,
  ], 'Style: Default,&H00FFFFFF,2\nStyle: Top,&H0000FF00,8');
  assert.deepEqual(result.comments.map(x => x.p), ['1.18,4,16711680', '1.18,4,16777215', '1.18,4,65280', '1.18,4,16777215', '1.18,4,0']);
});
test('local ASS preserves escaped braces and unmatched literal braces', () => {
  const result = parseAssFixture([
    String.raw`文字\{括号\}与<(ºOº)>`,
    String.raw`\{\an8\}字面标签`,
    String.raw`{\an8}顶部\{文本\}`,
    '文字{未闭合',
  ]);
  assert.deepEqual(result.comments.map(x => x.m), ['文字{括号}与<(ºOº)>', String.raw`{\an8}字面标签`, '顶部{文本}', '文字{未闭合']);
});
test('local ASS style resets preserve line alignment, wrapping and drawing mode', () => {
  const result = parseAssFixture([
    String.raw`{\an8\r}顶部`,
    String.raw`{\p1\r}m 0 0 l 100 100{\p0}文字`,
    String.raw`{\q2\r}甲\n乙`,
    String.raw`{\an8}甲{\an2}乙`,
  ], 'Style: Default,&H00FFFFFF,2', 0);
  assert.equal(result.comments[0].p, '1.18,5,16777215');
  assert.equal(result.comments[1].m, '文字');
  assert.equal(result.comments[2].m, '甲\n乙');
  assert.equal(result.comments[3].p, '1.18,5,16777215');
});
test('local ASS color resets use the currently selected style', () => {
  const result = parseAssFixture([
    String.raw`{\rGreen\c}绿色`,
    String.raw`{\rGreen\c&H0000FF&\1c}绿色`,
    String.raw`{\rGreen\r\c}白色`,
  ], 'Style: Default,&H00FFFFFF,2\nStyle: Green,&H0000FF00,8');
  assert.deepEqual(result.comments.map(x => x.p), ['1.18,4,65280', '1.18,4,65280', '1.18,4,16777215']);
});
test('local ASS literal markup remains text in the API JSON response viewer', () => {
  const result = parseAssFixture(['<svg onload=alert(1)>', '<(ºOº)> &lt;b&gt; & "正文"']);
  const context = vm.createContext({ window: {} });
  vm.runInContext(logviewJsContent, context);
  const html = context.highlightJSON(result);
  // 唯一允许的 HTML 是高亮器自己生成的 span，弹幕标记必须被转义。
  const encoded = html.replace(/<\/?span(?: class="[a-z]+")?>/g, '');
  assert.doesNotMatch(encoded, /[<>]/);
  const displayed = encoded.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(displayed), result);
});
test('local ASS bounds work for unmatched braces and oversized Format declarations', () => {
  // 放到有超时和堆上限的子进程，回归时不会阻塞测试进程或耗尽宿主内存。
  const parserUrl = new URL('../../utils/local-danmu-parser.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { parseLocalDanmu } from ${JSON.stringify(parserUrl)};
    const text = '{'.repeat(320000);
    const line = 'Dialogue: 0,0:00:01,0:00:02,Default,,0,0,0,,';
    assert.equal(parseLocalDanmu(Buffer.from(line + text), 'test.ass').comments[0].m, text);
    const format = Array.from({ length: 10000 }, (_, i) => 'unused' + i).join(',');
    const oversized = ['[Events]', 'Format: ' + format + ',Start,Text', ...Array(500).fill('Dialogue: ,')].join(String.fromCharCode(10));
    assert.throws(() => parseLocalDanmu(Buffer.from(oversized), 'test.ass'), /没有有效弹幕/);
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
test('local ASS reads declared style fields and preserves SSA alignment compatibility', () => {
  const ass = `[V4+ Styles]
Format: Alignment, Name, PrimaryColour
Style: 2,Default,&H00000000
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,黑色底部`;
  assert.deepEqual(parseLocalDanmu(Buffer.from(ass), 'test.ass').comments, [{ p: '1.00,4,0', m: '黑色底部' }]);
  const ssa = ass.replace('[V4+ Styles]', '[V4 Styles]').replace('Style: 2,Default,&H00000000', 'Style: 6,Default,255');
  assert.equal(parseLocalDanmu(Buffer.from(ssa), 'test.ssa').comments[0].p, '1.00,5,16711680');
  const bare = String.raw`Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\a6}顶部`;
  assert.equal(parseLocalDanmu(Buffer.from(bare), 'test.ssa').comments[0].p, '1.00,5,16777215');
});
test('local seasons default to one and reject invalid season numbers', () => {
  for (const value of [undefined, null, '', '  ']) assert.equal(normalizeLocalSeason(value), 1);
  for (const value of [2, '2', 'S02', '第2季', 'Season 2']) assert.equal(normalizeLocalSeason(value), 2);
  for (const value of [0, -1, '2.5', 'abc', '9007199254740992']) assert.equal(normalizeLocalSeason(value), null);
});
test('season keys preserve legacy first-season links and isolate later seasons', () => {
  const fields = { title: '逐玉', year: 2026, type: 'TV', episode: 5 };
  assert.equal(buildLocalDanmuResourceKey(fields), '逐玉|2026|tv|5');
  assert.equal(buildLocalDanmuResourceKey({ ...fields, season: 1 }), '逐玉|2026|tv|5');
  assert.notEqual(buildLocalDanmuResourceKey({ ...fields, season: 2 }), buildLocalDanmuResourceKey(fields));
  assert.throws(() => buildLocalDanmuResourceKey({ ...fields, season: -1 }), /季数/);
});
test('grouping uses title, year, type and season while sorting actual episode numbers', () => {
  const fields = { title: '逐玉', year: 2026, type: 'TV', season: 1, episode: 10, count: 3, size: 100 };
  const rows = [
    fields,
    { ...fields, title: ' 逐玉 ', type: '电视剧', episode: 5, count: 2 },
    { ...fields, season: 2 },
    { ...fields, year: 2025 },
    { ...fields, type: 'movie' },
    { ...fields, title: '其他剧' },
  ].map(row => ({ ...row, resourceKey: buildLocalDanmuResourceKey(row), comments: [{ m: 'private payload' }] }));
  const groups = groupLocalDanmuResources(rows);
  assert.equal(groups.length, 5);
  const firstSeason = groups.find(group => group.title === '逐玉' && group.year === 2026 && group.type === 'tv' && group.season === 1);
  assert.deepEqual(firstSeason.episodes.map(resource => resource.episode), [5, 10]);
  assert.equal(firstSeason.episodeCount, 2);
  assert.equal(firstSeason.count, 5);
  assert.equal(firstSeason.size, 200);
  assert.ok(groups.every(group => group.episodes.every(resource => !('comments' in resource))));
});
