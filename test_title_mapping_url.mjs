// 远程剧名映射表（TITLE_MAPPING_TABLE_URL）功能测试
import { Globals, globals } from './danmu_api/configs/globals.js';
import {
  normalizeMappingSourceUrl,
  parseRemoteTitleMappings,
  applyRemoteTitleMappingText,
  ensureRemoteTitleMapping
} from './danmu_api/utils/title-mapping-url-util.js';

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} [${label}]${detail ? ' ' + detail : ''}`);
  ok ? pass++ : fail++;
}

Globals.init({
  TITLE_MAPPING_TABLE: '本地剧A->本地映射A;本地剧B->本地映射B',
  TITLE_MAPPING_TABLE_URL: 'https://github.com/user/repo/blob/main/mappings.txt'
});

// 1. 地址归一化
check('1.1 GitHub blob 转 raw',
  normalizeMappingSourceUrl('https://github.com/alice/danmu-maps/blob/main/mappings.txt')
    === 'https://raw.githubusercontent.com/alice/danmu-maps/main/mappings.txt');
check('1.2 Gist 页面转 raw',
  normalizeMappingSourceUrl('https://gist.github.com/alice/abc123def')
    === 'https://gist.githubusercontent.com/alice/abc123def/raw');
check('1.3 普通直链原样保留',
  normalizeMappingSourceUrl('https://cdn.jsdelivr.net/gh/a/b@main/m.txt')
    === 'https://cdn.jsdelivr.net/gh/a/b@main/m.txt');

// 2. 远程内容解析（宽松格式）
const remoteText = [
  '# 共享剧名映射表',
  '// 由用户维护',
  '唐朝诡事录->唐朝诡事录之西行',
  '"国色芳华" -> 锦绣芳华，',       // 引号包裹 + 全角逗号结尾
  '永生－>永生动画',                // 全角箭头
  '庆余年 -> 庆余年(剧集版) # 备注', // 行尾注释
  '',
  '无效行没有箭头',
].join('\n');
const parsed = parseRemoteTitleMappings(remoteText);
check('2.1 解析条数', parsed.size === 4, `实际 ${parsed.size} 条`);
check('2.2 基本规则', parsed.get('唐朝诡事录') === '唐朝诡事录之西行');
check('2.3 引号与尾逗号清理', parsed.get('国色芳华') === '锦绣芳华');
check('2.4 全角箭头', parsed.get('永生') === '永生动画');
check('2.5 行尾注释剥离', parsed.get('庆余年') === '庆余年(剧集版)');

// 2b. 单行分号格式（与本地 TITLE_MAPPING_TABLE 完全一致的写法）
const oneline = parseRemoteTitleMappings('A->B;C->D');
check('2.6 兼容单行分号格式', oneline.size === 2 && oneline.get('A') === 'B' && oneline.get('C') === 'D');

// 3. 合并生效：远程 + 本地，冲突时本地优先
applyRemoteTitleMappingText(
  'https://raw.githubusercontent.com/user/repo/main/mappings.txt',
  '本地剧A->远程覆盖A;远程剧X->远程映射X;远程剧Y->远程映射Y'
);
const merged = globals.titleMappingTable;
check('3.1 远程规则生效', merged.get('远程剧X') === '远程映射X' && merged.get('远程剧Y') === '远程映射Y');
check('3.2 冲突时本地优先', merged.get('本地剧A') === '本地映射A');
check('3.3 本地独有规则保留', merged.get('本地剧B') === '本地映射B');

// 4. ensure 在已生效状态下为纯内存操作且不破坏合并结果
await ensureRemoteTitleMapping();
check('4.1 ensure 后合并结果保持', globals.titleMappingTable.get('远程剧X') === '远程映射X');

// 5. 空内容 / 无效内容应抛错而不污染状态
let threw = false;
try { applyRemoteTitleMappingText('u', '# 只有注释'); } catch (e) { threw = true; }
check('5.1 无效内容抛错', threw);
check('5.2 抛错后原合并结果不受影响', globals.titleMappingTable.get('远程剧X') === '远程映射X');

console.log(`\n==== 结果: ${pass}/${pass + fail} 通过 ====`);
process.exit(fail === 0 ? 0 : 1);

