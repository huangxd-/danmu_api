// 验证 applyTitleMappingWithLog 的 剧名×季 组合键优先级
import { globals } from './danmu_api/configs/globals.js';

globals.titleMappingTable = new Map([
  ['Moving', '搬家(通用错误目标)'],
  ['Moving S01', '超异能族'],
  ['Moving S02', '超异能族 第二季'],
]);

const mod = await import('./danmu_api/utils/title-mapping-url-util.js');
const { applyTitleMappingWithLog } = mod;

let pass = 0, fail = 0;
const check = (name, ok) => { console.log((ok ? 'PASS' : 'FAIL') + ' [' + name + ']'); ok ? pass++ : fail++; };

check('1.1 S1 命中组合键', applyTitleMappingWithLog('Moving', 'match', 1) === '超异能族');
check('1.2 S2 命中另一季规则', applyTitleMappingWithLog('Moving', 'match', 2) === '超异能族 第二季');
check('1.3 S3 无该季规则退回裸键', applyTitleMappingWithLog('Moving', 'match', 3) === '搬家(通用错误目标)');
check('1.4 不传季数退回裸键', applyTitleMappingWithLog('Moving') === '搬家(通用错误目标)');
check('1.5 season=null 安全', applyTitleMappingWithLog('Moving', 'favorite', null) === '搬家(通用错误目标)');

console.log(`\n==== 结果: ${pass}/${pass + fail} 通过 ====`);
process.exit(fail === 0 ? 0 : 1);
