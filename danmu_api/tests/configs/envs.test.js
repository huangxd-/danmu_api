// 环境变量解析：TITLE_NOISE_FILTER 默认规则
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Envs } from '../../configs/envs.js';
import { Globals } from '../../configs/globals.js';

test('TITLE_NOISE_FILTER 默认规则为合法正则，且文档默认值与其一致', async () => {
    const savedEnv = Envs.env;
    const savedSystemEnv = process.env.TITLE_NOISE_FILTER;
    try {
      // 未设置该变量时应回退到内置默认规则，而不是因默认规则非法而返回 null（禁用整个清理）
      Envs.env = {};
      delete process.env.TITLE_NOISE_FILTER;
      const pattern = Envs.resolveTitleNoiseFilter();
      assert.ok(pattern instanceof RegExp, '未设置 TITLE_NOISE_FILTER 时应返回可用的默认正则');

      // 半角/全角圆括号与方括号均需命中
      assert.strictEqual('百花杀（真彩）'.replace(pattern, '').trim(), '百花杀');
      assert.strictEqual('百花杀(真彩)'.replace(pattern, '').trim(), '百花杀');
      assert.strictEqual('百花杀[真彩]'.replace(pattern, '').trim(), '百花杀');
      assert.strictEqual('百花杀［真彩］'.replace(pattern, '').trim(), '百花杀');

      // 原版规则不含年份分支，年份不参与清理；无杂音词时保持原样
      assert.strictEqual('吞噬星空（2024）'.replace(pattern, '').trim(), '吞噬星空（2024）');
      assert.strictEqual('百花杀'.replace(pattern, '').trim(), '百花杀');

      // 对外记录的默认值须与代码默认值一致，且可直接编译
      assert.strictEqual(Envs.accessedEnvVars.get('TITLE_NOISE_FILTER'), pattern.source);
      assert.doesNotThrow(() => new RegExp(pattern.source, 'gi'));

      // README 与默认配置文件中的默认值必须与代码默认值完全一致，否则用户照抄会得到非法正则
      for (const docUrl of [new URL('../../../README.md', import.meta.url), new URL('../../../config/.env.example', import.meta.url)]) {
        const text = await fs.readFile(docUrl, 'utf8');
        assert.ok(text.includes(pattern.source), `${docUrl.pathname} 中的默认值应与代码默认值一致`);
      }

      // 显式设为空值表示禁用
      Envs.env = { TITLE_NOISE_FILTER: '' };
      assert.strictEqual(Envs.resolveTitleNoiseFilter(), null);
    } finally {
      Envs.env = savedEnv;
      if (savedSystemEnv === undefined) delete process.env.TITLE_NOISE_FILTER;
      else process.env.TITLE_NOISE_FILTER = savedSystemEnv;
    }
  });

test('envs RAW_ENV_KEYS 保留 # 不被 dotenv 截断', async (t) => {
  const reset = () => { Envs.systemEnvBackup = null; Envs.rawEnvValues = null; Envs.env = undefined; };

  await t.test('parseRawEnvText 保留行内 # 与剥除外层双引号', () => {
    const parsed = Envs.parseRawEnvText('K1=v1\nK2=v with # hash\nK3="q # v"');
    assert.strictEqual(parsed.K2, 'v with # hash');
    assert.strictEqual(parsed.K3, 'q # v');
  });

  await t.test('CUSTOM_MERGE_RULES / COLOR_POOL / URL 类变量含 # 完整保留', () => {
    reset();
    Envs.systemEnvBackup = {};
    Envs.rawEnvValues = {
      CUSTOM_MERGE_RULES: 'A #1 revival@bili',
      COLOR_POOL: '#FF0000,#00FF00',
      DANMU_PUSH_URL: 'http://h.com/cb#frag',
    };
    assert.strictEqual(Envs.get('CUSTOM_MERGE_RULES', '', 'string'), 'A #1 revival@bili');
    assert.strictEqual(Envs.get('COLOR_POOL', '', 'string'), '#FF0000,#00FF00');
    assert.strictEqual(Envs.get('DANMU_PUSH_URL', '', 'string'), 'http://h.com/cb#frag');
  });

  await t.test('加密变量保留 # 且仅以掩码写入预览集合', () => {
    reset();
    Envs.systemEnvBackup = {};
    Envs.rawEnvValues = { DANDANPLAY_PASSWORD: 'p#w' };
    assert.strictEqual(Envs.get('DANDANPLAY_PASSWORD', 'DEF', 'string', true), 'p#w');
    assert.strictEqual(Envs.accessedEnvVars.get('DANDANPLAY_PASSWORD'), '***');
    assert.strictEqual(Envs.originalEnvVars.get('DANDANPLAY_PASSWORD'), 'p#w');
  });
});


// ==================== 以下为补充用例 ====================
// 全部离线：不读写仓库 config/.env、不发起网络请求、不写 .cache。
// 每个用例通过 Globals.init({...}) 重置 Envs 状态，并在 finally 还原进程环境与被替换的静态字段。

const TEST_ENV_KEYS = [
  'ADMIN_TOKEN', 'B_NO', 'B_ONE', 'B_TEXT', 'B_YES', 'B_ZERO', 'COLOR_POOL',
  'CUSTOM_MERGE_RULES', 'DANMU_PUSH_URL', 'DANDANPLAY_PASSWORD', 'EPISODE_TITLE_FILTER',
  'MERGE_SOURCE_PAIRS', 'OTHER_SERVER', 'PLATFORM_ORDER', 'RAW_ONE', 'RAW_ONE_IN_PROCESS',
  'RAW_TWO', 'RAW_TWO_IN_PROCESS', 'SOURCE_ORDER', 'TEST_NUM', 'TEST_TOKEN',
  'TITLE_NOISE_FILTER', 'TOKEN', 'UNDEFINED_IN_BACKUP', 'VOD_SERVERS',
];

// 解析 raw 变量的键不在 RAW_ENV_KEYS 中，取值会落到 process.env，需一并还原
const TEST_RAW_KEYS = ['RAW_ONE', 'RAW_TWO', 'RAW_ONE_IN_PROCESS', 'RAW_TWO_IN_PROCESS'];

function snapshotProcessEnv() {
  const saved = new Map();
  for (const key of [...TEST_ENV_KEYS, ...TEST_RAW_KEYS]) {
    saved.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
  }
  return saved;
}

function restoreProcessEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** 重置 Envs 全部可变静态状态，并用给定 env 注入（等价于一次冷启动） */
function initEnvs(env = {}) {
  Globals.init(env);
  Envs.originalEnvVars = new Map();
  Envs.accessedEnvVars = new Map();
  Envs.sensitiveKeys = new Set();
  Envs.systemEnvBackup = null;
  Envs.rawEnvValues = null;
}

/** 捕获 console.warn 文本，避免非法正则用例污染测试输出 */
function captureWarn(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => { messages.push(args.join(' ')); };
  try {
    return { value: fn(), messages };
  } finally {
    console.warn = original;
  }
}

test('parseRawEnvText 处理 CRLF、整行注释、空行与非法行', () => {
  const parsed = Envs.parseRawEnvText(
    '# 整行注释\r\n' +
    '\r\n' +
    'KEEP=1\r\n' +
    '   \r\n' +
    '  SPACED  =  v  \r\n' +
    'NO_EQUALS_SIGN\r\n' +
    '=empty-key\r\n' +
    '#TRAILING=v\n' +
    'TAIL=end'
  );

  assert.deepStrictEqual(parsed, { KEEP: '1', SPACED: 'v', TAIL: 'end' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A=1\r\nB=2'), { A: '1', B: '2' });
});

test('parseRawEnvText 行内 # 与非字符串输入', () => {
  assert.deepStrictEqual(Envs.parseRawEnvText('A=1#tail'), { A: '1#tail' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A="quoted # not comment"'), { A: 'quoted # not comment' });
  assert.deepStrictEqual(Envs.parseRawEnvText('URL=http://x.test/p#frag'), { URL: 'http://x.test/p#frag' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A=""'), { A: '' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A='), { A: '' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A="1'), { A: '"1' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A=1"'), { A: '1"' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A="x'), { A: '"x' });
  assert.deepStrictEqual(Envs.parseRawEnvText('A="say "hi""'), { A: 'say "hi"' });

  for (const bad of [null, undefined, 42]) {
    assert.deepStrictEqual(Envs.parseRawEnvText(bad), {});
  }
});

test('Envs.get 类型转换、非法数字报错、默认值回退与记账', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ TEST_NUM: '42', TEST_TOKEN: 'abcde', ADMIN_TOKEN: 'secret' });
    for (const key of ['TEST_NUM', 'TEST_TOKEN', 'ADMIN_TOKEN']) delete process.env[key];

    assert.strictEqual(Envs.get('TEST_NUM', 7, 'number'), 42);
    assert.strictEqual(Envs.get('TEST_TOKEN', 'x', 'string'), 'abcde');
    assert.strictEqual(Envs.get('MISSING_NUM', '12', 'number'), 12);
    assert.strictEqual(Envs.get('MISSING_STR', 'fallback', 'string'), 'fallback');
    assert.strictEqual(Envs.get('MISSING_BOOL', true, 'boolean'), true);
    assert.strictEqual(Envs.get('MISSING_BOOL2', false, 'boolean'), false);

    // 未命中时 originalEnvVars 记为 ''，accessedEnvVars 记录最终值
    assert.strictEqual(Envs.originalEnvVars.get('MISSING_STR'), '');
    assert.strictEqual(Envs.accessedEnvVars.get('MISSING_STR'), 'fallback');
    assert.strictEqual(Envs.accessedEnvVars.get('MISSING_NUM'), 12);
    assert.strictEqual(Envs.originalEnvVars.get('TEST_NUM'), '42');

    // 多余实参不影响行为（返回值仍是数字 42）
    assert.strictEqual(Envs.get('TEST_NUM', 7, 'number', false, 'ignored'), 42);

    // 非法数字必须抛出错误，而不是静默返回 NaN 或默认值
    Envs.env.TEST_NUM = 'abc';
    assert.throws(
      () => Envs.get('TEST_NUM', 7, 'number'),
      (error) => error instanceof Error
        && error.name === 'Error'
        && error.message === 'Environment variable TEST_NUM must be a valid number'
    );
    // 抛错前已记账原始值；accessedEnvVars 保留上一次成功读取的 42
    assert.strictEqual(Envs.originalEnvVars.get('TEST_NUM'), 'abc');
    assert.strictEqual(Envs.accessedEnvVars.get('TEST_NUM'), 42);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('Envs.get 布尔转换仅认 true/1，encrypt 按掩码登记敏感键', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ B_YES: 'true', B_ONE: '1', B_NO: 'false', B_ZERO: '0', B_TEXT: 'yes', ADMIN_TOKEN: 'secret' });
    for (const key of ['B_YES', 'B_ONE', 'B_NO', 'B_ZERO', 'B_TEXT', 'ADMIN_TOKEN']) delete process.env[key];

    assert.strictEqual(Envs.get('B_YES', false, 'boolean'), true);
    assert.strictEqual(Envs.get('B_ONE', false, 'boolean'), true);
    assert.strictEqual(Envs.get('B_NO', true, 'boolean'), false);
    assert.strictEqual(Envs.get('B_ZERO', true, 'boolean'), false);
    assert.strictEqual(Envs.get('B_TEXT', false, 'boolean'), false);

    assert.strictEqual(Envs.get('ADMIN_TOKEN', '', 'string', true), 'secret');
    assert.strictEqual(Envs.accessedEnvVars.get('ADMIN_TOKEN'), '******');
    assert.strictEqual(Envs.originalEnvVars.get('ADMIN_TOKEN'), 'secret');
    assert.strictEqual(Envs.sensitiveKeys.has('ADMIN_TOKEN'), true);
    assert.strictEqual(Envs.sensitiveKeys.has('B_YES'), false);

    assert.strictEqual(Envs.encryptStr('abc'), '***');
    assert.strictEqual(Envs.encryptStr(''), '');

    // encrypt 只影响预览记账，返回值仍是原始值
    Envs.env.TEST_NUM = '1234';
    assert.strictEqual(Envs.get('TEST_NUM', 0, 'number', true), 1234);
    assert.strictEqual(Envs.originalEnvVars.get('TEST_NUM'), '1234');
    // 未断言 accessedEnvVars.get('TEST_NUM')：数字类型经 encryptStr 会得到空掩码（见文件末尾说明）

    // 非 string 类型不触发 RAW_ENV_KEYS 的 raw 查询，走普通 Number 转换
    Envs.env.VOD_SERVERS = '9';
    assert.strictEqual(Envs.get('VOD_SERVERS', '0', 'number'), 9);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('Envs.getRawEnv 优先级：系统快照 > .env 原始值 > process.env > 默认值', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ VOD_SERVERS: 'from-env' });
    for (const key of TEST_RAW_KEYS) delete process.env[key];

    // 非 Node 运行时（无 systemEnvBackup）：env 优先，rawEnvValues 不参与
    Envs.systemEnvBackup = null;
    Envs.rawEnvValues = { VOD_SERVERS: 'raw-ignored-without-backup' };
    assert.strictEqual(Envs.getRawEnv('VOD_SERVERS', 'def'), 'from-env');
    assert.strictEqual(Envs.originalEnvVars.get('VOD_SERVERS'), 'from-env');
    delete Envs.env.VOD_SERVERS;
    assert.strictEqual(Envs.getRawEnv('MISSING_RAW', 'def'), 'def');

    // Node 运行时：系统快照最高优先级，且 hasOwnProperty 语义下 undefined 也算命中
    Envs.systemEnvBackup = { RAW_ONE: 'sys#value', UNDEFINED_IN_BACKUP: undefined };
    Envs.rawEnvValues = { RAW_ONE: 'raw', RAW_TWO: 'raw#two' };
    assert.strictEqual(Envs.getRawEnv('RAW_ONE', 'def'), 'sys#value');
    assert.strictEqual(Envs.getRawEnv('RAW_TWO', 'def'), 'raw#two');
    assert.strictEqual(Envs.getRawEnv('RAW_ONE_IN_PROCESS', 'def'), 'def');

    assert.strictEqual(Envs.getRawEnv('UNDEFINED_IN_BACKUP', 'def'), undefined);
    assert.strictEqual(Envs.originalEnvVars.get('UNDEFINED_IN_BACKUP'), undefined);
    assert.strictEqual(Envs.accessedEnvVars.get('UNDEFINED_IN_BACKUP'), undefined);

    // 系统快照与 rawEnvValues 都不含该键时，回退 process.env
    process.env.RAW_TWO_IN_PROCESS = 'process#value';
    assert.strictEqual(Envs.getRawEnv('RAW_TWO_IN_PROCESS', 'def'), 'process#value');
    assert.strictEqual(Envs.accessedEnvVars.get('RAW_TWO_IN_PROCESS'), 'process#value');

    // 三者都不命中时回退默认值，并按最终值记账
    assert.strictEqual(Envs.getRawEnv('RAW_ONE_IN_PROCESS', 'def'), 'def');
    assert.strictEqual(Envs.originalEnvVars.get('RAW_ONE_IN_PROCESS'), 'def');
    assert.strictEqual(Envs.accessedEnvVars.get('RAW_ONE_IN_PROCESS'), 'def');
  } finally {
    restoreProcessEnv(saved);
  }
});

test('RAW_ENV_KEYS 边界：URL 带 #、含引号、多行值、加密掩码', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({});
    delete process.env.TEST_TOKEN;
    // 手工构造原始解析结果，全程不读取任何 .env 文件
    Envs.systemEnvBackup = {};
    Envs.rawEnvValues = {
      DANMU_PUSH_URL: 'http://127.0.0.1:9978/action?do=refresh#frag',
      AI_MATCH_PROMPT: 'line1\nline2 # keep',
      DANDANPLAY_PASSWORD: 'p#w',
    };

    assert.strictEqual(
      Envs.get('DANMU_PUSH_URL', 'd', 'string'),
      'http://127.0.0.1:9978/action?do=refresh#frag'
    );
    assert.strictEqual(Envs.get('AI_MATCH_PROMPT', 'd', 'string'), 'line1\nline2 # keep');
    assert.strictEqual(Envs.get('DANDANPLAY_PASSWORD', 'd', 'string', true), 'p#w');
    assert.strictEqual(Envs.accessedEnvVars.get('DANDANPLAY_PASSWORD'), '***');
    assert.strictEqual(Envs.originalEnvVars.get('DANDANPLAY_PASSWORD'), 'p#w');
    assert.strictEqual(Envs.sensitiveKeys.has('DANDANPLAY_PASSWORD'), true);

    // RAW_ENV_KEYS 的绕过只在 type === 'string' 时生效：
    // RAW_ENV_KEYS 内的 VOD_SERVERS 按 boolean 读取会回落到默认值而非 rawEnvValues 中的 'yes'；
    // 非 RAW 键（TEST_TOKEN）按 string 读取走普通 get 路径，取到默认值 'def'
    Envs.rawEnvValues.VOD_SERVERS = 'yes';
    assert.strictEqual(Envs.get('VOD_SERVERS', false, 'boolean'), false);
    assert.strictEqual(Envs.get('TEST_TOKEN', 'def', 'string'), 'def');
  } finally {
    restoreProcessEnv(saved);
  }
});

test('parseRawEnvText 的解析结果直接驱动 RAW_ENV_KEYS 取值', async () => {
  const saved = snapshotProcessEnv();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'envs-raw-'));
  try {
    // 只在系统临时目录内写文件，仓库 config/ 与真实环境变量均不受影响
    const file = path.join(dir, 'raw.env');
    await fs.writeFile(file, '# comment\nCOLOR_POOL="#FF0000,#00FF00"\nDANMU_PUSH_URL=http://h/cb#frag\n', 'utf8');
    const parsed = Envs.parseRawEnvText(await fs.readFile(file, 'utf8'));
    assert.deepStrictEqual(parsed, {
      COLOR_POOL: '#FF0000,#00FF00',
      DANMU_PUSH_URL: 'http://h/cb#frag',
    });

    initEnvs({});
    Envs.systemEnvBackup = {};
    Envs.rawEnvValues = parsed;
    assert.strictEqual(Envs.get('COLOR_POOL', '', 'string'), '#FF0000,#00FF00');
    assert.strictEqual(Envs.get('DANMU_PUSH_URL', '', 'string'), 'http://h/cb#frag');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    restoreProcessEnv(saved);
  }
});

test('resolveVodServers 名称/URL 解析，缺省与空值均不启用上游', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ VOD_SERVERS: '金蝉@https://a.test, https://b.test ,789@https://c.test' });
    assert.deepStrictEqual(Envs.resolveVodServers(), [
      { name: '金蝉', url: 'https://a.test' },
      { name: 'vod-2', url: 'https://b.test' },
      { name: '789', url: 'https://c.test' },
    ]);

    for (const config of [{}, { VOD_SERVERS: '' }, { VOD_SERVERS: '   ' }, { VOD_SERVERS: ', ,名称@' }]) {
      initEnvs(config);
      assert.deepStrictEqual(Envs.resolveVodServers(), []);
    }
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveSourceOrder 过滤非法源并回退默认顺序', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ SOURCE_ORDER: ' dandan , nope , local,,  ' });
    assert.deepStrictEqual(Envs.resolveSourceOrder(), ['dandan', 'local']);
    assert.deepStrictEqual(Envs.accessedEnvVars.get('SOURCE_ORDER'), ['dandan', 'local']);

    initEnvs({ SOURCE_ORDER: 'nope,unknown' });
    assert.deepStrictEqual(Envs.resolveSourceOrder(), ['douban', '360', 'renren', 'hanjutv']);
    assert.deepStrictEqual(Envs.accessedEnvVars.get('SOURCE_ORDER'), []);

    initEnvs({});
    assert.deepStrictEqual(Envs.resolveSourceOrder(), ['douban', '360', 'renren', 'hanjutv']);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolvePlatformOrder 单个/组合平台、空值与记账', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ PLATFORM_ORDER: 'bilibili1&dandan,youku,nope,qiyi&' });
    assert.deepStrictEqual(Envs.resolvePlatformOrder(), ['bilibili1&dandan', 'youku', null]);
    assert.deepStrictEqual(Envs.accessedEnvVars.get('PLATFORM_ORDER'), ['bilibili1&dandan', 'youku']);

    // 仅做首尾 trim：'&' 两侧的内部空格会保留在返回项中，但校验时逐段 trim
    initEnvs({ PLATFORM_ORDER: ' custom & animeko , qiyi&nope ' });
    assert.deepStrictEqual(Envs.resolvePlatformOrder(), ['custom & animeko', null]);

    initEnvs({ PLATFORM_ORDER: ',,,,' });
    assert.deepStrictEqual(Envs.resolvePlatformOrder(), [null]);

    initEnvs({});
    assert.deepStrictEqual(Envs.resolvePlatformOrder(), [null]);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveMergeSourcePairs 主源校验、自我合并排除与分隔符', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ MERGE_SOURCE_PAIRS: ' dandan&bahamut&animeko ; renren&hanjutv, dandan&dandan&nope ' });
    assert.deepStrictEqual(Envs.resolveMergeSourcePairs(), [
      { primary: 'dandan', secondaries: ['bahamut', 'animeko'] },
      { primary: 'renren', secondaries: ['hanjutv'] },
      { primary: 'dandan', secondaries: [] },
    ]);

    initEnvs({ MERGE_SOURCE_PAIRS: 'nope&dandan' });
    assert.deepStrictEqual(Envs.resolveMergeSourcePairs(), []);

    initEnvs({});
    assert.deepStrictEqual(Envs.resolveMergeSourcePairs(), []);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveCustomMergeRules 合并/阻断/路由与非法实体', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({
      CUSTOM_MERGE_RULES: '天气之子@bilibili -> 天气之子@dandan;' +
        '我推的孩子/S01@bahamut -> 我推的孩子/S03@dandan | E25~E35>E25~E35,E01>E01;' +
        '辉夜大小姐@bilibili × 辉夜大小姐 OVA@dandan;' +
        '无箭头规则@bilibili;' +
        '没有来源标记 -> 也没有来源标记',
    });
    assert.deepStrictEqual(Envs.resolveCustomMergeRules(), [
      {
        action: 'merge',
        secondary: { title: '天气之子', season: null, source: 'bilibili' },
        primary: { title: '天气之子', season: null, source: 'dandan' },
        routes: [],
        hasRoutes: false,
      },
      {
        action: 'merge',
        secondary: { title: '我推的孩子', season: 1, source: 'bahamut' },
        primary: { title: '我推的孩子', season: 3, source: 'dandan' },
        routes: [
          { sec: { start: 25, end: 35 }, prim: { start: 25, end: 35 } },
          { sec: { start: 1, end: 1 }, prim: { start: 1, end: 1 } },
        ],
        hasRoutes: true,
      },
      {
        action: 'block',
        secondary: { title: '辉夜大小姐', season: null, source: 'bilibili' },
        primary: { title: '辉夜大小姐 OVA', season: null, source: 'dandan' },
        routes: [],
        hasRoutes: false,
      },
    ]);

    initEnvs({ CUSTOM_MERGE_RULES: '天气之子@bilibili->天气之子@dandan | E1' });
    const [rule] = Envs.resolveCustomMergeRules();
    assert.strictEqual(rule.hasRoutes, true);
    assert.deepStrictEqual(rule.routes, []);

    initEnvs({});
    assert.deepStrictEqual(Envs.resolveCustomMergeRules(), []);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveAnimeTitleFilter 未设置/非法/显式空值', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({});
    assert.strictEqual(Envs.resolveAnimeTitleFilter(), null);
    assert.strictEqual(Envs.accessedEnvVars.get('ANIME_TITLE_FILTER'), '');

    initEnvs({ ANIME_TITLE_FILTER: '   ' });
    assert.strictEqual(Envs.resolveAnimeTitleFilter(), null);

    initEnvs({ ANIME_TITLE_FILTER: '[（(]臻彩[)）]' });
    const filter = Envs.resolveAnimeTitleFilter();
    assert.strictEqual(filter.source, '^(.*?)(?:[（(]臻彩[)）])(.*?)$');
    assert.strictEqual(filter.flags, 'i');
    assert.strictEqual('百花杀（臻彩）'.replace(filter, '$1$2'), '百花杀');
    assert.strictEqual(Envs.accessedEnvVars.get('ANIME_TITLE_FILTER'), '[（(]臻彩[)）]');

    initEnvs({ ANIME_TITLE_FILTER: '[unclosed' });
    assert.strictEqual(Envs.resolveAnimeTitleFilter(), null);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveEpisodeTitleFilter 未设置走默认、自定义覆盖、非法回退默认', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({});
    const fallback = Envs.resolveEpisodeTitleFilter();
    const defaultKeywords = Envs.accessedEnvVars.get('EPISODE_TITLE_FILTER');
    assert.strictEqual(fallback.source, `^(.*?)(?:${defaultKeywords})(.*?)$`);
    assert.strictEqual(defaultKeywords.includes('先导预告'), true);
    assert.strictEqual(defaultKeywords.includes('番外彩蛋'), true);
    assert.strictEqual(fallback.flags, 'i');
    // 正则以 ^ 开头且替换为空串，因此命中后整行（含集数前缀）都被移除
    assert.strictEqual('第01集 先导预告'.replace(fallback, ''), '');

    // 纯空白经 trim 后视为未设置，同样回退默认规则
    initEnvs({ EPISODE_TITLE_FILTER: '   ' });
    assert.strictEqual(Envs.resolveEpisodeTitleFilter().source, fallback.source);

    initEnvs({ EPISODE_TITLE_FILTER: '(剧评)' });
    const custom = Envs.resolveEpisodeTitleFilter();
    assert.strictEqual(custom.source, '^(.*?)(?:(剧评))(.*?)$');
    assert.strictEqual(Envs.accessedEnvVars.get('EPISODE_TITLE_FILTER'), '(剧评)');
    assert.strictEqual('第01集 剧评'.replace(custom, ''), '');

    // 非法自定义正则：回退默认规则，且 accessedEnvVars 记录用户填写的原始串
    initEnvs({ EPISODE_TITLE_FILTER: '(unclosed' });
    const recovered = Envs.resolveEpisodeTitleFilter();
    assert.strictEqual(recovered.source, fallback.source);
    assert.strictEqual(Envs.accessedEnvVars.get('EPISODE_TITLE_FILTER'), '(unclosed');
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveTitleNoiseFilter 默认/覆盖/非法回退/显式空值禁用', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({});
    const byDefault = Envs.resolveTitleNoiseFilter();
    const defaultPattern = String.raw`[（(\[［](?:臻彩|真彩|高清|标清|超清|国配|中配|日配|粤语|原声|台配|无修|未删减|完整版|日语版|国语版|英语版|中字|字幕|助听|原版)[\])）］]`;
    assert.strictEqual(byDefault.source, defaultPattern);
    assert.strictEqual(byDefault.flags, 'gi');
    // 未设置时 accessedEnvVars 记录内置默认规则（与返回的正则同源）
    assert.strictEqual(Envs.accessedEnvVars.get('TITLE_NOISE_FILTER'), defaultPattern);
    assert.strictEqual('百花杀（真彩）'.replace(byDefault, '').trim(), '百花杀');
    assert.strictEqual('百花杀［原声］'.replace(byDefault, '').trim(), '百花杀');
    assert.strictEqual('百花杀'.replace(byDefault, '').trim(), '百花杀');

    initEnvs({ TITLE_NOISE_FILTER: '（真彩）' });
    const custom = Envs.resolveTitleNoiseFilter();
    assert.strictEqual(custom.source, '（真彩）');
    assert.strictEqual(Envs.accessedEnvVars.get('TITLE_NOISE_FILTER'), '（真彩）');
    assert.strictEqual('百花杀（真彩）'.replace(custom, '').trim(), '百花杀');
    assert.strictEqual('百花杀[真彩]'.replace(custom, '').trim(), '百花杀[真彩]');

    initEnvs({ TITLE_NOISE_FILTER: '[unclosed' });
    const recovered = captureWarn(() => Envs.resolveTitleNoiseFilter());
    assert.strictEqual(recovered.value.source, byDefault.source);
    assert.strictEqual(recovered.messages.length, 1);
    assert.match(recovered.messages[0], /Invalid TITLE_NOISE_FILTER regex, using default\./);

    initEnvs({ TITLE_NOISE_FILTER: '   ' });
    assert.strictEqual(Envs.resolveTitleNoiseFilter(), null);
    assert.strictEqual(Envs.accessedEnvVars.get('TITLE_NOISE_FILTER'), '');
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveTitleMappingTable 解析与空值', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ TITLE_MAPPING_TABLE: ' 唐朝诡事录 -> 唐朝诡事录之西行 ; 国色芳华->锦绣芳华;只有左边;->缺左边' });
    const table = Envs.resolveTitleMappingTable();
    assert.strictEqual(table instanceof Map, true);
    assert.strictEqual(table.size, 2);
    assert.deepStrictEqual([...table.entries()], [
      ['唐朝诡事录', '唐朝诡事录之西行'],
      ['国色芳华', '锦绣芳华'],
    ]);

    initEnvs({});
    const empty = Envs.resolveTitleMappingTable();
    assert.strictEqual(empty instanceof Map, true);
    assert.strictEqual(empty.size, 0);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('resolveAutoMatchMappingTable 合法规则与非法规则告警', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ AUTO_MATCH_MAPPING_TABLE: '永生 S05E02 -> 永生 S01E58' });
    const rules = Envs.resolveAutoMatchMappingTable();
    assert.strictEqual(rules.length, 1);
    assert.deepStrictEqual(
      {
        order: rules[0].order,
        bounded: rules[0].bounded,
        sourceTitle: rules[0].sourceTitle,
        sourceSeason: rules[0].sourceSeason,
        sourceStartEpisode: rules[0].sourceStartEpisode,
        sourceEndEpisode: rules[0].sourceEndEpisode,
        targetTitle: rules[0].targetTitle,
        targetSeason: rules[0].targetSeason,
        targetStartEpisode: rules[0].targetStartEpisode,
        targetEndEpisode: rules[0].targetEndEpisode,
        targetPlatform: rules[0].targetPlatform,
        raw: rules[0].raw,
      },
      {
        order: 0,
        bounded: false,
        sourceTitle: '永生',
        sourceSeason: 5,
        sourceStartEpisode: 2,
        sourceEndEpisode: null,
        targetTitle: '永生',
        targetSeason: 1,
        targetStartEpisode: 58,
        targetEndEpisode: null,
        targetPlatform: '',
        raw: '永生 S05E02 -> 永生 S01E58',
      }
    );

    initEnvs({ AUTO_MATCH_MAPPING_TABLE: '海贼王 S02E01~E02 -> 航海王(1999)【动漫】 S01E62~E63' });
    const [rangeRule] = Envs.resolveAutoMatchMappingTable();
    assert.strictEqual(rangeRule.bounded, true);
    assert.strictEqual(rangeRule.sourceEndEpisode, 2);
    assert.strictEqual(rangeRule.targetTitle, '航海王');
    assert.strictEqual(rangeRule.targetYear, 1999);
    assert.strictEqual(rangeRule.targetType, '动漫');
    assert.strictEqual(rangeRule.targetEndEpisode, 63);

    initEnvs({ AUTO_MATCH_MAPPING_TABLE: '缺箭头;永生 S05E02 -> 永生 S01E58 -> 多余;永生 S05E02 -> 永生 S01E58~E60' });
    const warned = captureWarn(() => Envs.resolveAutoMatchMappingTable());
    assert.deepStrictEqual(warned.value, []);
    assert.strictEqual(warned.messages.length, 3);
    assert.match(warned.messages[0], /规则 1 缺少唯一的 -> 分隔符: 缺箭头/);
    assert.match(warned.messages[1], /规则 2 缺少唯一的 -> 分隔符/);
    assert.match(warned.messages[2], /规则 3 的源和目标必须同时声明范围/);

    initEnvs({ AUTO_MATCH_MAPPING_TABLE: '航海王 S01E01 -> 航海王 S01E01 @nope' });
    const platformWarn = captureWarn(() => Envs.resolveAutoMatchMappingTable());
    assert.deepStrictEqual(platformWarn.value, []);
    assert.match(platformWarn.messages[0], /使用了不支持的平台 nope/);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('isValidIpv4 / isValidIpv6 精确判定', () => {
  assert.strictEqual(Envs.isValidIpv4('127.0.0.1'), true);
  assert.strictEqual(Envs.isValidIpv4('0.0.0.0'), true);
  assert.strictEqual(Envs.isValidIpv4('255.255.255.255'), true);
  assert.strictEqual(Envs.isValidIpv4('256.1.1.1'), false);
  assert.strictEqual(Envs.isValidIpv4('1.2.3'), false);
  assert.strictEqual(Envs.isValidIpv4('1.2.3.4.5'), false);
  assert.strictEqual(Envs.isValidIpv4('1.2.3.04a'), false);
  assert.strictEqual(Envs.isValidIpv4(''), false);
  assert.strictEqual(Envs.isValidIpv4(null), false);
  assert.strictEqual(Envs.isValidIpv4(123), false);

  assert.strictEqual(Envs.isValidIpv6('::1'), true);
  assert.strictEqual(Envs.isValidIpv6('2001:db8::1'), true);
  assert.strictEqual(Envs.isValidIpv6('::ffff:192.168.0.1'), true);
  assert.strictEqual(Envs.isValidIpv6('1.2.3.4'), false);
  assert.strictEqual(Envs.isValidIpv6('12345::'), false);
  assert.strictEqual(Envs.isValidIpv6('1::2::3'), false);
  // 未断言 ':::'：当前源码会把 ':::' 误判为合法 IPv6（见文件末尾说明），此处不固化该错误行为
  assert.strictEqual(Envs.isValidIpv6('2001:db8::/64'), false);
  assert.strictEqual(Envs.isValidIpv6(''), false);
});

test('resolveIpBlacklist 精确/CIDR/斜杠正则/字面量转义', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({ IP_BLACKLIST: ' 10.0.0.1 \n2001:db8::/64\n1.2.3.4/99\n/^10\\.0\\./i' });
    const rules = Envs.resolveIpBlacklist();
    assert.strictEqual(rules.length, 4);
    assert.deepStrictEqual(rules[0], { type: 'exact', value: '10.0.0.1' });
    assert.deepStrictEqual(rules[1], { type: 'cidr', ip: '2001:db8::', prefix: 64 });
    assert.strictEqual(rules[2].type, 'regex');
    assert.strictEqual(rules[2].value.source, '^1\\.2\\.3\\.4\\/99$');
    assert.strictEqual(rules[2].value.test('1.2.3.4/99'), true);
    assert.strictEqual(rules[2].value.test('1.2.3.4'), false);
    assert.strictEqual(rules[3].type, 'regex');
    assert.strictEqual(rules[3].value.source, '^10\\.0\\.');
    assert.strictEqual(rules[3].value.flags, 'i');
    assert.strictEqual(rules[3].value.test('10.0.1.5'), true);
    assert.strictEqual(rules[3].value.test('110.0.1.5'), false);
    assert.deepStrictEqual(
      Envs.accessedEnvVars.get('IP_BLACKLIST'),
      ['10.0.0.1', '2001:db8::/64', '1.2.3.4/99', '/^10\\.0\\./i']
    );

    initEnvs({ IP_BLACKLIST: '10.0.0.0/8;192.168.1.1\n\n1.2.3.4/24' });
    assert.deepStrictEqual(Envs.resolveIpBlacklist(), [
      { type: 'cidr', ip: '10.0.0.0', prefix: 8 },
      { type: 'exact', value: '192.168.1.1' },
      { type: 'cidr', ip: '1.2.3.4', prefix: 24 },
    ]);

    // '/*/' 会被当作 /regex/ 且 pattern 取成空串，RegExp 构造失败后该条被跳过
    initEnvs({ IP_BLACKLIST: '/*/' });
    const starRule = captureWarn(() => Envs.resolveIpBlacklist());
    assert.deepStrictEqual(starRule.value, []);
    assert.match(starRule.messages[0], /Invalid IP_BLACKLIST entry: \/\*\/, skipped\./);

    initEnvs({});
    assert.deepStrictEqual(Envs.resolveIpBlacklist(), []);
    assert.strictEqual(Envs.accessedEnvVars.get('IP_BLACKLIST').length, 0);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('Envs.set 写入 process.env 与 accessedEnvVars（值统一转字符串）', () => {
  const saved = snapshotProcessEnv();
  try {
    initEnvs({});
    for (const key of ['SOURCE_ORDER', 'TEST_NUM']) delete process.env[key];

    Envs.set('SOURCE_ORDER', 'dandan');
    Envs.set('TEST_NUM', 12);

    assert.strictEqual(process.env.SOURCE_ORDER, 'dandan');
    assert.strictEqual(process.env.TEST_NUM, '12');
    assert.strictEqual(Envs.accessedEnvVars.get('SOURCE_ORDER'), 'dandan');
    assert.strictEqual(Envs.accessedEnvVars.get('TEST_NUM'), 12);
    assert.strictEqual(Envs.getAccessedEnvVars(), Envs.accessedEnvVars);
    assert.strictEqual(Envs.getOriginalEnvVars(), Envs.originalEnvVars);
  } finally {
    restoreProcessEnv(saved);
  }
});

test('Globals.init 基于 Envs 生成配置并区分 RAW_ENV_KEYS 与非 RAW 变量', () => {
  const saved = snapshotProcessEnv();
  try {
    Globals.init({ OTHER_SERVER: 'https://other.test', COLOR_POOL: '#FF0000,#00FF00' });

    assert.strictEqual(Globals.envs.otherServer, 'https://other.test');
    // COLOR_POOL 在 RAW_ENV_KEYS 中：绕过 dotenv 注释截断，完整保留 #
    assert.strictEqual(Globals.envs.colorPool, '#FF0000,#00FF00');
    assert.strictEqual(Globals.envs.token, '87654321');
    assert.deepStrictEqual(Globals.envs.platformOrderArr, [null]);
    assert.deepStrictEqual(Globals.envs.sourceOrderArr, ['douban', '360', 'renren', 'hanjutv']);
    assert.strictEqual(Globals.envs.episodeTitleFilter instanceof RegExp, true);
    assert.strictEqual(Globals.envs.animeTitleFilter, null);
    // Globals 快照来自 Envs 记账，敏感键以掩码形式出现在预览中
    assert.strictEqual(Globals.accessedEnvVars.TOKEN, '********');
    assert.strictEqual(Globals.originalEnvVars.TOKEN, '87654321');
  } finally {
    restoreProcessEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// 撰写这些用例时发现的两处源码缺陷（未修改源码，也未用断言固化错误行为）：
//
// 1. Envs.isValidIpv6(':::') === true（danmu_api/configs/envs.js:551-586）
//    ':::' 会被 split('::') 拆成 ['', ':']，右半段 ':' 经 split(':').filter(Boolean)
//    变成空数组，于是 totalParts === 0，最终返回 true。
//    影响：resolveIpBlacklist 中 ':::/0' 会被当作合法 CIDR 规则接受
//    （实测返回 [{ type: 'cidr', ip: ':::', prefix: 0 }]）。
//    因此本文件不包含 ':::' 的断言。
//
// 2. Envs.encryptStr(1234) === ''（danmu_api/configs/envs.js:134-136）
//    encryptStr 直接访问 str.length，传入 number 时得到 undefined，
//    '*'.repeat(undefined) 返回空串。
//    影响：类型为 number 且 encrypt=true 的键，其 accessedEnvVars 掩码会变成空串。
//    当前 load() 中所有 encrypt 键都是 string，故线上尚未触发；
//    本文件因此只断言 string 掩码，不断言该错误返回值。
// ---------------------------------------------------------------------------
