// 复现 + 验证 BLOCKED_WORDS 屏蔽词解析
import { Globals, globals } from './danmu_api/configs/globals.js';
import { convertToDanmakuJson, splitBlockedWords, parseBlockedWord } from './danmu_api/utils/danmu-util.js';

Globals.init({}); // 加载默认配置 (groupMinute=1, danmuLimit=0 ...)

const sample = [
  { timepoint: '1.00', ct: 1, color: 16777215, content: '前方剧透警告' },
  { timepoint: '2.00', ct: 1, color: 16777215, content: '测试弹幕一' },
  { timepoint: '3.00', ct: 1, color: 16777215, content: 'AD广告内容' },
  { timepoint: '4.00', ct: 1, color: 16777215, content: '正常弹幕' },
];

async function run(label, blockedWords, expectGone, expectKeep = ['正常弹幕']) {
  globals.blockedWords = blockedWords;
  const out = await convertToDanmakuJson(structuredClone(sample), 'test');
  const texts = out.map(d => d.m);
  const stillThere = expectGone.filter(w => texts.some(t => t.includes(w)));
  const lost = expectKeep.filter(w => !texts.some(t => t.includes(w)));
  const ok = stillThere.length === 0 && lost.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${label}] 输入=${JSON.stringify(blockedWords)}`);
  console.log(`      剩余弹幕: ${JSON.stringify(texts)}`);
  if (stillThere.length) console.log(`      >> 未屏蔽: ${JSON.stringify(stillThere)}`);
  if (lost.length) console.log(`      >> 误屏蔽: ${JSON.stringify(lost)}`);
  return ok;
}

const results = [];
results.push(await run('A 标准正则', '/剧透/,/广告/', ['剧透', '广告']));
results.push(await run('B 纯文本词', '剧透,广告', ['剧透', '广告']));
results.push(await run('C 全角逗号', '/剧透/，/广告/', ['剧透', '广告']));
results.push(await run('D 正则带i标志', '/ad/i,/^测试/', ['AD广告', '测试']));
results.push(await run('E 逗号带空格', '/剧透/, /广告/', ['剧透', '广告']));
// F. 混合：正则+纯文本+全角逗号+空格
results.push(await run('F 混合写法', '/^测试/, 剧透 ，/广告/', ['剧透', '广告', '测试'], ['正常弹幕']));

// G. README 官方示例兼容性：应解析出 16 个正则且不抛错
const readmeSample = "/.{20,}/,/^\\d{2,4}[-/.]\\d{1,2}[-/.]\\d{1,2}([日号.]*)?$/,/^(?!哈+$)([a-zA-Z\\u4e00-\\u9fa5])\\1{2,}/,/[0-9]+\\.*[0-9]*\\s*(w|万)+\\s*(\\+|个|人|在看)+/,/^[a-z]{6,}$/,/^(?:qwertyuiop|asdfghjkl|zxcvbnm)$/,/^\\d{5,}$/,/^(\\d)\\1{2,}$/,/^\\d{1,4}$/,/(20[0-3][0-9])/,/(0?[1-9]|1[0-2])月/,/\\d{1,2}[.-]\\d{1,2}/,/[@#&$%^*+\\|/\\-_=<>°◆◇■□●○★☆▼▲♥♦♠♣①②③④⑤⑥⑦⑧⑨⑩]/,/[一二三四五六七八九十百\\d]+刷/,/第[一二三四五六七八九十百\\d]+/,/(全体成员|报到|报道|来啦|签到|刷|打卡|我在|来了|考古|爱了|挖坟|留念|你好|回来|哦哦|重温|复习|重刷|再看|在看|前排|沙发|有人看|板凳|末排|我老婆|我老公|撅了|后排|周目|重看|包养|DVD|同上|同样|我也是|俺也|算我|爱豆|我家爱豆|我家哥哥|加我|三连|币|新人|入坑|补剧|冲了|硬了|看完|舔屏|万人|牛逼|煞笔|傻逼|卧槽|tm|啊这|哇哦)/";
const segs = splitBlockedWords(readmeSample);
const regexes = segs.map(parseBlockedWord);
const gOk = segs.length === 16 && regexes.every(r => r instanceof RegExp);
console.log(`${gOk ? 'PASS' : 'FAIL'} [G README官方示例] 解析出 ${segs.length} 条规则（期望16）`);
if (!gOk) segs.forEach((s, i) => console.log(`   [${i}] ${s.length > 50 ? s.slice(0, 50) + '...' : s}`));
results.push(gOk);

console.log(`\n==== 结果: ${results.filter(Boolean).length}/${results.length} 通过 ====`);
process.exit(results.every(Boolean) ? 0 : 1);
