// 通用工具：季号标记识别
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。
// 追加部分为标题/集数解析、标题匹配与平台顺序的离线回归用例。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Season } from '../../models/dandan-model.js';
import { Globals } from '../../configs/globals.js';
import {
  extractSeasonNumberFromAnimeTitle, extractYear, convertChineseNumber, parseFileName,
  createDynamicPlatformOrder, sanitizeSearchKeyword, stripNonTitleChars, strictTitleMatch,
  getExplicitSeasonNumber, titleMatches, extractEpisodeNumberFromTitle, extractAnimeInfo,
  extractEpisodeTitle, extractAnimeTitle, printFirst200Chars, normalizeTitleForMatch,
  settleWithConcurrency,
} from '../../utils/common-util.js';

test('settleWithConcurrency limits workers, keeps order, and isolates failures', async () => {
  let active = 0;
  let peak = 0;
  const results = await settleWithConcurrency([0, 1, 2, 3, 4], async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, value === 2 ? 5 : 1));
    active--;
    if (value === 3) throw new Error('segment failed');
    return value * 10;
  }, 2);

  assert.equal(peak, 2);
  assert.deepStrictEqual(results.map(result => result.status), [
    'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled',
  ]);
  assert.deepStrictEqual(
    results.filter(result => result.status === 'fulfilled').map(result => result.value),
    [0, 10, 20, 40],
  );
});

test('season extraction recognizes season markers', () => {
  // 尾部阿拉伯数字、中文数字、S/Season/Part、罗马数字均识别为季号
  assert.equal(extractSeasonNumberFromAnimeTitle('赛马娘2').season, 2);
  assert.equal(extractSeasonNumberFromAnimeTitle('赛马娘 2').season, 2);
  assert.equal(extractSeasonNumberFromAnimeTitle('孤独摇滚 12').season, 12);
  assert.equal(extractSeasonNumberFromAnimeTitle('为美好的世界献上祝福3').season, 3);
  assert.equal(extractSeasonNumberFromAnimeTitle('辉夜大小姐想让我告白 二').season, 2);
  assert.equal(extractSeasonNumberFromAnimeTitle('咒术回战 S2').season, 2);
  assert.equal(extractSeasonNumberFromAnimeTitle('咒术回战 Part 2').season, 2);
  assert.equal(extractSeasonNumberFromAnimeTitle('无职转生 第三季').season, 3);
  assert.equal(extractSeasonNumberFromAnimeTitle('無職転生Ⅲ ～異世界行ったら本気だす～').season, 3);
  assert.equal(extractSeasonNumberFromAnimeTitle('无职转生Ⅲ ～到了异世界就拿出真本事～').season, 3);
  assert.equal(extractSeasonNumberFromAnimeTitle('OVERLORD Ⅳ').season, 4);
  assert.equal(extractSeasonNumberFromAnimeTitle('约会大作战Ⅴ').season, 5);

  // 拉丁字母形式的罗马数字与英文缩写无法区分，不参与季号识别
  assert.equal(extractSeasonNumberFromAnimeTitle('机动战士V高达').season, null);
  assert.equal(extractSeasonNumberFromAnimeTitle('MAD MAX').season, null);

  // 季号剥离后余下部分作为 baseTitle
  assert.equal(extractSeasonNumberFromAnimeTitle('無職転生Ⅲ ～異世界行ったら本気だす～').baseTitle, '無職転生異世界行ったら本気だす');
});

// 静默日志级别：仅在断言日志缓冲的用例里临时改成 info
const quietEnv = { LOG_LEVEL: 'error', TITLE_NOISE_FILTER: '', STRICT_TITLE_MATCH: 'false' };

test('common-util extractYear 只识别括号内的四位年份', () => {
  assert.strictEqual(extractYear('生万物(2024)'), 2024);
  assert.strictEqual(extractYear('剧名 (2018) 第二季'), 2018);
  assert.strictEqual(extractYear('生万物 2024'), null, '裸数字年份不识别');
  assert.strictEqual(extractYear('生万物(24)'), null, '两位年份不识别');
  assert.strictEqual(extractYear('生万物'), null);
});

test('common-util convertChineseNumber 支持简体/繁体数字与阿拉伯数字', () => {
  assert.strictEqual(convertChineseNumber('12'), 12, '阿拉伯数字直接转数字');
  for (const [input, expected] of [
    ['一', 1], ['十', 10], ['十一', 11], ['二十', 20], ['二十三', 23],
    ['一百零五', 105], ['二千', 2000], ['壹拾貳', 12], ['參佰', 300],
  ]) {
    assert.strictEqual(convertChineseNumber(input), expected, `${input} 应解析为 ${expected}`);
  }
  assert.strictEqual(convertChineseNumber('abc'), 0, '无有效数字/单位的输入解析为 0');
});

test('common-util parseFileName 分离 @ 平台标识与季集标记', () => {
  Globals.init(quietEnv);
  assert.deepStrictEqual(parseFileName('剧名@qq S01E02'),
    { cleanFileName: '剧名 S01E02', preferredPlatform: 'qq' }, '@ 后带季集：平台在 @ 后');
  assert.deepStrictEqual(parseFileName('剧名 S01E02@qq'),
    { cleanFileName: '剧名 S01E02', preferredPlatform: 'qq' }, '@ 前带季集：平台在 @ 后');
  assert.deepStrictEqual(parseFileName('剧名@qq'),
    { cleanFileName: '剧名', preferredPlatform: 'qq' }, '无季集时只剥离平台');
  assert.deepStrictEqual(parseFileName('剧名@不存在的平台'),
    { cleanFileName: '剧名', preferredPlatform: '' }, '非法平台名归一化为空串');
  assert.deepStrictEqual(parseFileName('  剧名  '),
    { cleanFileName: '剧名', preferredPlatform: '' }, '无 @ 时仅 trim');
  assert.deepStrictEqual(parseFileName(''), { cleanFileName: '', preferredPlatform: '' });
  assert.deepStrictEqual(parseFileName(null), { cleanFileName: '', preferredPlatform: '' });
  assert.deepStrictEqual(parseFileName(12345), { cleanFileName: '', preferredPlatform: '' }, '非字符串入参直接返回空');
});

test('common-util stripNonTitleChars 只留标题字符，normalizeTitleForMatch 统一繁简', () => {
  assert.strictEqual(stripNonTitleChars('无职转生 ～到了异世界～'), '无职转生到了异世界', '空格与波浪号被清理');
  assert.strictEqual(stripNonTitleChars('【测试】标题 (2024)'), '测试标题2024', '括号与年份保留数字');
  assert.strictEqual(stripNonTitleChars('ワンパンマン Ⅳ'), 'ワンパンマンⅣ', '假名与罗马数字保留');
  assert.strictEqual(stripNonTitleChars(''), '');
  assert.strictEqual(stripNonTitleChars(null), '');

  assert.strictEqual(normalizeTitleForMatch('無職轉生 ～到了異世界～'), '无职转生到了异世界',
    '繁体标题归一化为简体并清理符号');
});

test('common-util extractEpisodeNumberFromTitle 覆盖 第N集/EPN/纯数字', () => {
  assert.strictEqual(extractEpisodeNumberFromTitle('【qq】 第1集'), 1);
  assert.strictEqual(extractEpisodeNumberFromTitle('第01话'), 1);
  assert.strictEqual(extractEpisodeNumberFromTitle('第12回'), 12);
  assert.strictEqual(extractEpisodeNumberFromTitle('EP05'), 5);
  assert.strictEqual(extractEpisodeNumberFromTitle('S01E07'), 7);
  assert.strictEqual(extractEpisodeNumberFromTitle(' 3 '), 3, '首尾空白的裸数字按集号');
  assert.strictEqual(extractEpisodeNumberFromTitle('第2季'), null, '季号不算集号');
  assert.strictEqual(extractEpisodeNumberFromTitle('无集号信息'), null);
  assert.strictEqual(extractEpisodeNumberFromTitle(''), null);
});

test('common-util extractAnimeTitle/extractEpisodeTitle/extractAnimeInfo 组合解析', () => {
  assert.strictEqual(extractAnimeTitle('剧名(2024)'), '剧名');
  assert.strictEqual(extractAnimeTitle('  剧名  '), '剧名');
  assert.strictEqual(extractEpisodeTitle('【qq】 第3集'), 'qq', '取【】内的平台标识');
  assert.strictEqual(extractEpisodeTitle('无方括号'), null);
  assert.strictEqual(extractEpisodeTitle('【】'), '', '空方括号返回空串');

  assert.deepStrictEqual(extractAnimeInfo('剧名 第二季', '【qq】 第3集'),
    { baseTitle: '剧名', season: 2, episode: 3 });
  assert.deepStrictEqual(extractAnimeInfo('剧名(2024)', 'EP12'),
    { baseTitle: '剧名', season: null, episode: 12 });
});

test('common-util getExplicitSeasonNumber 只认显式季标记', () => {
  for (const [input, expected] of [
    ['第2季', 2], ['第三期', 3], ['S02', 2], ['Season 3', 3], ['Part 4', 4], ['第十二部', 12],
  ]) {
    assert.strictEqual(getExplicitSeasonNumber(input), expected, `${input} → ${expected}`);
  }
  for (const input of ['剧名', '第2集', '', null]) {
    assert.strictEqual(getExplicitSeasonNumber(input), null, `${input} 不应识别出季号`);
  }
});

test('common-util strictTitleMatch 完全/头部匹配放行，非季号后缀拒绝', () => {
  Globals.init(quietEnv);
  assert.strictEqual(strictTitleMatch('无职转生', '无职转生'), true);
  assert.strictEqual(strictTitleMatch('無職轉生', '无职转生'), true, '繁简归一后相同');
  assert.strictEqual(strictTitleMatch('无职转生 第二季', '无职转生'), true, '季号后缀允许通过');
  assert.strictEqual(strictTitleMatch('无职转生 S02', '无职转生'), true, 'S 季号后缀允许通过');
  assert.strictEqual(strictTitleMatch('无职转生 到了异世界', '无职转生'), false, '非季号后缀不放行');
  assert.strictEqual(strictTitleMatch('某某无职转生', '无职转生'), false, '非头部匹配不放行');
  assert.strictEqual(strictTitleMatch('', '无职转生'), false);
  assert.strictEqual(strictTitleMatch('无职转生', ''), false);
});

test('common-util titleMatches 宽松模式按归一化包含匹配，严格模式收紧', () => {
  Globals.init({ ...quietEnv, STRICT_TITLE_MATCH: 'false' });
  assert.strictEqual(titleMatches('无职转生', '无职转生'), true);
  assert.strictEqual(titleMatches('無職轉生 ～到了異世界～', '无职转生'), true, '繁简与符号差异不影响命中');
  assert.strictEqual(titleMatches('间谍过家家 第一季', '间谍过家家'), true, '源标题带季号仍命中');
  assert.strictEqual(titleMatches('某某无职转生', '无职转生'), true, '宽松模式允许包含匹配');
  assert.strictEqual(titleMatches('无职转生', '进击的巨人'), false);
  assert.strictEqual(titleMatches(null, '无职转生'), false);
  assert.strictEqual(titleMatches('无职转生', ''), false);

  Globals.init({ ...quietEnv, STRICT_TITLE_MATCH: 'true' });
  assert.strictEqual(titleMatches('某某无职转生', '无职转生'), false, '严格模式下非头部匹配被拒绝');
  assert.strictEqual(titleMatches('无职转生 第二季', '无职转生'), true, '严格模式仍允许季号后缀');
  assert.strictEqual(titleMatches('某某无职转生', '无职转生', null, true), true,
    'forceNonStrict 为 true 时跳过严格模式（用于偏好记录等场景）');
});

test('common-util sanitizeSearchKeyword 去掉零宽字符并 trim，保留合法标点', () => {
  assert.strictEqual(sanitizeSearchKeyword('  生万物  '), '生万物');
  assert.strictEqual(sanitizeSearchKeyword('\u200B生\uFEFF万\u200E物\u200F'), '生万物', '零宽字符与 BOM 全部清理');
  assert.strictEqual(sanitizeSearchKeyword('Love & Death'), 'Love & Death', '空格与 & 保留');
  assert.strictEqual(sanitizeSearchKeyword(''), '');
  assert.strictEqual(sanitizeSearchKeyword(null), '');
});

test('common-util createDynamicPlatformOrder 偏好平台置顶并补齐 null 回退位', () => {
  Globals.init({ ...quietEnv, PLATFORM_ORDER: 'qq,qiyi,bilibili1' });
  assert.deepStrictEqual(createDynamicPlatformOrder('qiyi'), ['qiyi', 'qq', 'bilibili1', null]);
  assert.deepStrictEqual(createDynamicPlatformOrder(null), ['qq', 'qiyi', 'bilibili1', null], '无偏好时返回默认顺序副本');
  assert.deepStrictEqual(createDynamicPlatformOrder('不存在的平台'), ['qq', 'qiyi', 'bilibili1', null],
    '非法平台回退默认顺序');

  const first = createDynamicPlatformOrder(null);
  first.push('污染');
  assert.deepStrictEqual(createDynamicPlatformOrder(null), ['qq', 'qiyi', 'bilibili1', null],
    '返回的是副本，修改结果不得污染全局顺序');
});

test('common-util printFirst200Chars 截断到 200 字符并写入日志缓冲', () => {
  Globals.init({ ...quietEnv, LOG_LEVEL: 'info' });
  const buffer = Globals.getConfig().logBuffer;
  buffer.length = 0;

  printFirst200Chars('a'.repeat(300));
  assert.strictEqual(buffer.length, 1, 'info 级别下写入一条日志');
  assert.strictEqual(buffer[0].level, 'info');
  assert.strictEqual(buffer[0].message.split(' ').pop().length, 200, '只保留前 200 个字符');

  buffer.length = 0;
  const result = printFirst200Chars(42);
  assert.strictEqual(result, undefined, '不支持的入参类型不返回内容');
  assert.deepStrictEqual(buffer.map((entry) => entry.level), ['error'], '不支持的入参类型只写一条 error 日志');
  assert.match(buffer[0].message, /Unsupported data type/);

  // LOG_LEVEL=error 时 info 级日志应被过滤掉，不写入缓冲
  Globals.init({ ...quietEnv, LOG_LEVEL: 'error' });
  Globals.getConfig().logBuffer.length = 0;
  printFirst200Chars('静默');
  assert.strictEqual(Globals.getConfig().logBuffer.length, 0, 'error 级别下 info 日志不写缓冲');
});
