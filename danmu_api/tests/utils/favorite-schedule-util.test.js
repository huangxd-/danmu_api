// 收藏定时刷新工具：排程校验、下一次运行时间、缓存归一化、到期刷新执行、调度器启停
// 全部离线：时间一律显式传 now/fromTimestamp，或用 t.mock.timers 驱动；
// 不联网、不读 config/.env、不写 .cache。期望值由「上海时间字面量」独立推导（sh 辅助）。

import test from 'node:test';
import assert from 'node:assert';
import {
  validateFavoriteSchedule,
  calculateNextFavoriteRunAt,
  createFavoriteSchedule,
  normalizeFavoriteSchedule,
  runDueFavoriteSchedules,
  startFavoriteScheduler,
  stopFavoriteScheduler
} from '../../utils/favorite-schedule-util.js';
import { globals } from '../../configs/globals.js';

// Asia/Shanghai 全年固定 UTC+8（无夏令时），因此可直接用 +08:00 偏移推导期望时间戳
const sh = iso => Date.parse(`${iso}+08:00`);

const MISSING_MESSAGE = '缺少定时刷新配置';
const FREQUENCY_MESSAGE = 'frequency 仅支持 daily 或 weekly';
const TIME_MESSAGE = 'time 必须是 HH:mm 格式的有效时间';
const WEEKDAY_MESSAGE = 'weekly 模式的 weekday 必须是 1-7';

// 只做微任务/宏任务冲刷：setImmediate 未被 mock，可安全用于等待 mock 定时器回调里的异步体
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

const dailySchedule = (time, nextRunAt, extra = {}) => ({
  frequency: 'daily',
  time,
  nextRunAt,
  retryAt: null,
  lastRunAt: null,
  lastStatus: '',
  lastError: '',
  ...extra
});

// ---------------------------------------------------------------------------
// validateFavoriteSchedule
// ---------------------------------------------------------------------------

test('validateFavoriteSchedule 非对象输入返回缺少配置', () => {
  for (const bad of [null, undefined, '', 0, false, NaN, 'daily', 12, () => {}]) {
    assert.deepStrictEqual(
      validateFavoriteSchedule(bad),
      { valid: false, message: MISSING_MESSAGE },
      `value=${String(bad)} 应判定为缺少配置`
    );
  }
});

test('validateFavoriteSchedule frequency 仅接受 daily/weekly 且大小写不敏感', () => {
  for (const bad of [undefined, '', 'monthly', 'dail', 'everyday', 'weeklyy', 0, 7, true, null]) {
    assert.deepStrictEqual(
      validateFavoriteSchedule({ frequency: bad, time: '09:00' }),
      { valid: false, message: FREQUENCY_MESSAGE },
      `frequency=${JSON.stringify(bad)} 应被拒绝`
    );
  }
  // 单元素数组经 String() 变成 'daily'，会被当作合法（真实实现的宽松点）
  assert.strictEqual(validateFavoriteSchedule({ frequency: ['daily'], time: '09:00' }).value.frequency, 'daily');
  // 数组合法的 time 也拦不住 frequency 先被拒（数组是 object，frequency 缺失 → ''）
  assert.deepStrictEqual(
    validateFavoriteSchedule([{ frequency: 'daily', time: '09:00' }]),
    { valid: false, message: FREQUENCY_MESSAGE }
  );
  // 大小写归一为小写
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'DAILY', time: '09:00' }), {
    valid: true,
    value: { frequency: 'daily', time: '09:00', timezone: 'Asia/Shanghai' }
  });
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'WeEkLy', time: '23:59', weekday: 7 }), {
    valid: true,
    value: { frequency: 'weekly', time: '23:59', weekday: 7, timezone: 'Asia/Shanghai' }
  });
});

test('validateFavoriteSchedule time 必须是两位 HH:mm 且在 00:00-23:59 内', () => {
  const badTimes = ['1:30', '09:5', '24:00', '23:60', '25:00', '09:300', '0930', '', ' 09:30', '09:30 ', '09-30', 'aa:bb', '-1:00', null, undefined, 930, {}, []];
  for (const time of badTimes) {
    assert.deepStrictEqual(
      validateFavoriteSchedule({ frequency: 'daily', time }),
      { valid: false, message: TIME_MESSAGE },
      `time=${JSON.stringify(time)} 应被拒绝`
    );
  }
  // 边界合法值与原文保留（不做 zero-pad 之外的任何改写）
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'daily', time: '00:00' }).value, {
    frequency: 'daily',
    time: '00:00',
    timezone: 'Asia/Shanghai'
  });
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'daily', time: '23:59' }).value, {
    frequency: 'daily',
    time: '23:59',
    timezone: 'Asia/Shanghai'
  });
  assert.strictEqual(validateFavoriteSchedule({ frequency: 'daily', time: '09:05' }).value.time, '09:05');
});

test('validateFavoriteSchedule weekly 的 weekday 必须是 1-7 的整数', () => {
  const badWeekdays = [0, 8, -1, 1.5, '3.5', 'abc', '', null, undefined, NaN, Infinity, {}, []];
  for (const weekday of badWeekdays) {
    assert.deepStrictEqual(
      validateFavoriteSchedule({ frequency: 'weekly', time: '09:00', weekday }),
      { valid: false, message: WEEKDAY_MESSAGE },
      `weekday=${String(weekday)} 应被拒绝`
    );
  }
  // weekly 缺 weekday 时 Number(undefined) 为 NaN，同样被拒
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'weekly', time: '09:00' }), {
    valid: false,
    message: WEEKDAY_MESSAGE
  });
  // 数字字符串被 Number() 收编为整数（真实实现行为）
  assert.strictEqual(validateFavoriteSchedule({ frequency: 'weekly', time: '09:00', weekday: '3' }).value.weekday, 3);
  // 布尔 true 经 Number() 变成 1，落在合法区间（实现宽松点，非预期输入）
  assert.strictEqual(validateFavoriteSchedule({ frequency: 'weekly', time: '09:00', weekday: true }).value.weekday, 1);
  // 1-7 全部合法
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    assert.strictEqual(
      validateFavoriteSchedule({ frequency: 'weekly', time: '09:00', weekday }).value.weekday,
      weekday
    );
  }
});

test('validateFavoriteSchedule daily 不产出 weekday，daily 下非法 weekday 被忽略', () => {
  assert.deepStrictEqual(validateFavoriteSchedule({ frequency: 'daily', time: '08:30', weekday: 99 }), {
    valid: true,
    value: { frequency: 'daily', time: '08:30', timezone: 'Asia/Shanghai' }
  });
  // daily 结果里不应出现 weekday 键
  assert.strictEqual('weekday' in validateFavoriteSchedule({ frequency: 'daily', time: '08:30', weekday: 3 }).value, false);
});

// ---------------------------------------------------------------------------
// calculateNextFavoriteRunAt
// ---------------------------------------------------------------------------

test('calculateNextFavoriteRunAt 排程非法时返回 0', () => {
  const now = sh('2025-03-10T08:00:00');
  assert.strictEqual(calculateNextFavoriteRunAt(null, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt(undefined, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt({}, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'monthly', time: '09:00' }, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'daily', time: '25:00' }, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 9 }, now), 0);
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00' }, now), 0);
});

test('calculateNextFavoriteRunAt daily：未到点取当天，恰好到点/已过期取次日', () => {
  const schedule = { frequency: 'daily', time: '09:30' };
  const at = sh('2025-03-10T09:30:00');
  // 未到点
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, sh('2025-03-10T08:00:00')), at);
  // 差 1 毫秒仍算未到点
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, at - 1), at);
  // 恰好到点（候选 <= from 即顺延），已过期同理
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, at), sh('2025-03-11T09:30:00'));
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, at + 1), sh('2025-03-11T09:30:00'));
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, sh('2025-03-10T23:59:59')), sh('2025-03-11T09:30:00'));
});

test('calculateNextFavoriteRunAt daily：跨月与跨年顺延', () => {
  // 跨年
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'daily', time: '00:15' }, sh('2024-12-31T23:30:00')),
    sh('2025-01-01T00:15:00')
  );
  // 跨月（1 月 31 日 → 2 月 1 日）
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'daily', time: '00:00' }, sh('2024-01-31T23:59:59')),
    sh('2024-02-01T00:00:00')
  );
  // 跨月且跨到 31 天的月份
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'daily', time: '07:00' }, sh('2024-04-30T08:00:00')),
    sh('2024-05-01T07:00:00')
  );
});

test('calculateNextFavoriteRunAt daily：闰年 2 月 29 日存在，非闰年直接进 3 月', () => {
  const schedule = { frequency: 'daily', time: '23:00' };
  // 闰年：2/28 的 23:00 已过点 → 顺延到真实存在的 2/29
  assert.strictEqual(
    calculateNextFavoriteRunAt(schedule, sh('2024-02-28T23:30:00')),
    sh('2024-02-29T23:00:00')
  );
  // 非闰年：同样输入直接跨进 3/1
  assert.strictEqual(
    calculateNextFavoriteRunAt(schedule, sh('2023-02-28T23:30:00')),
    sh('2023-03-01T23:00:00')
  );
  // 闰日次日再顺延 → 3/1
  assert.strictEqual(
    calculateNextFavoriteRunAt(schedule, sh('2024-02-29T23:30:00')),
    sh('2024-03-01T23:00:00')
  );
  // 同日未到点时不跨日
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'daily', time: '23:45' }, sh('2024-02-28T23:30:00')),
    sh('2024-02-28T23:45:00')
  );
  // 午夜跨日同上：闰年落 2/29，非闰年落 3/1
  const midnight = { frequency: 'daily', time: '00:00' };
  assert.strictEqual(calculateNextFavoriteRunAt(midnight, sh('2024-02-28T23:59:59')), sh('2024-02-29T00:00:00'));
  assert.strictEqual(calculateNextFavoriteRunAt(midnight, sh('2023-02-28T23:59:59')), sh('2023-03-01T00:00:00'));
  // 世纪闰年规则：2000 年是闰年
  assert.strictEqual(calculateNextFavoriteRunAt(midnight, sh('2000-02-28T23:59:59')), sh('2000-02-29T00:00:00'));
});

test('calculateNextFavoriteRunAt 显式 fromTimestamp=0 / 极小值时按 1970 上海时间推导', () => {
  // 1970-01-01 00:00 UTC = 上海 08:00，daily 09:00 当天尚未到点
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'daily', time: '09:00' }, 0), sh('1970-01-01T09:00:00'));
  // 上海 08:00 已过 00:00 → 顺延到 1 月 2 日
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'daily', time: '00:00' }, 0), sh('1970-01-02T00:00:00'));
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'daily', time: '00:00' }, 0), 57600000);
});

test('calculateNextFavoriteRunAt 非法 fromTimestamp（NaN）产出 NaN 而非抛错', () => {
  // fromTimestamp 未做校验：Invalid Date 一路传播为 NaN（垃圾进垃圾出，记录真实行为）
  assert.ok(Number.isNaN(calculateNextFavoriteRunAt({ frequency: 'daily', time: '09:00' }, NaN)));
  assert.ok(Number.isNaN(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 3 }, NaN)));
});

test('calculateNextFavoriteRunAt weekly：同日未到点取当天，到点/过期顺延 7 天', () => {
  // 2025-03-10 是周一（weekday=1）
  const schedule = { frequency: 'weekly', time: '09:00', weekday: 1 };
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, sh('2025-03-10T08:00:00')), sh('2025-03-10T09:00:00'));
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, sh('2025-03-10T09:00:00')), sh('2025-03-17T09:00:00'));
  assert.strictEqual(calculateNextFavoriteRunAt(schedule, sh('2025-03-10T09:00:01')), sh('2025-03-17T09:00:00'));
});

test('calculateNextFavoriteRunAt weekly：本周内后续星期与跨周顺延', () => {
  const from = sh('2025-03-10T08:00:00'); // 周一
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 3 }, from), sh('2025-03-12T09:00:00'));
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 7 }, from), sh('2025-03-16T09:00:00'));
  // 周日（weekday=7）起点：同日 12:00 未到点
  const sunday = sh('2025-03-16T10:00:00');
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '12:00', weekday: 7 }, sunday), sh('2025-03-16T12:00:00'));
  // 周日已过点 → 下周日
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 7 }, sunday), sh('2025-03-23T09:00:00'));
  // 周日求周一 → 次日
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 1 }, sunday), sh('2025-03-17T09:00:00'));
  // 数字字符串 weekday 经校验归一化后同样可用
  assert.strictEqual(calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: '7' }, from), sh('2025-03-16T09:00:00'));
});

test('calculateNextFavoriteRunAt weekly：跨月与跨年', () => {
  // 2024-12-31 是周二，weekday=3（周三 00:15）落在 2025-01-01
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'weekly', time: '00:15', weekday: 3 }, sh('2024-12-31T23:30:00')),
    sh('2025-01-01T00:15:00')
  );
  // 2025-01-31 是周五，weekday=1（周一 09:00）落在 2025-02-03
  assert.strictEqual(
    calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 1 }, sh('2025-01-31T10:00:00')),
    sh('2025-02-03T09:00:00')
  );
});

// ---------------------------------------------------------------------------
// createFavoriteSchedule
// ---------------------------------------------------------------------------

test('createFavoriteSchedule 非法输入原样返回校验失败结果', () => {
  assert.deepStrictEqual(createFavoriteSchedule(null, sh('2025-03-10T08:00:00')), { valid: false, message: MISSING_MESSAGE });
  assert.deepStrictEqual(createFavoriteSchedule({ frequency: 'monthly', time: '09:00' }, sh('2025-03-10T08:00:00')), {
    valid: false,
    message: FREQUENCY_MESSAGE
  });
  assert.deepStrictEqual(createFavoriteSchedule({ frequency: 'daily', time: '9:00' }, sh('2025-03-10T08:00:00')), {
    valid: false,
    message: TIME_MESSAGE
  });
});

test('createFavoriteSchedule daily 产出完整初始字段', () => {
  const now = sh('2025-03-10T08:00:00');
  assert.deepStrictEqual(createFavoriteSchedule({ frequency: 'daily', time: '09:30' }, now), {
    valid: true,
    value: {
      frequency: 'daily',
      time: '09:30',
      timezone: 'Asia/Shanghai',
      nextRunAt: sh('2025-03-10T09:30:00'),
      retryAt: null,
      lastRunAt: null,
      lastStatus: '',
      lastError: ''
    }
  });
});

test('createFavoriteSchedule weekly 保留 weekday 且 nextRunAt 与计算函数一致', () => {
  const now = sh('2025-03-10T08:00:00'); // 周一
  const created = createFavoriteSchedule({ frequency: 'weekly', time: '09:00', weekday: 3 }, now);
  assert.deepStrictEqual(created, {
    valid: true,
    value: {
      frequency: 'weekly',
      time: '09:00',
      weekday: 3,
      timezone: 'Asia/Shanghai',
      nextRunAt: sh('2025-03-12T09:00:00'),
      retryAt: null,
      lastRunAt: null,
      lastStatus: '',
      lastError: ''
    }
  });
  assert.strictEqual(created.value.nextRunAt, calculateNextFavoriteRunAt({ frequency: 'weekly', time: '09:00', weekday: 3 }, now));
});

test('createFavoriteSchedule 的 now 参数决定 nextRunAt 是当天还是次日', () => {
  const schedule = { frequency: 'daily', time: '09:30' };
  assert.strictEqual(createFavoriteSchedule(schedule, sh('2025-03-10T08:00:00')).value.nextRunAt, sh('2025-03-10T09:30:00'));
  assert.strictEqual(createFavoriteSchedule(schedule, sh('2025-03-10T09:30:00')).value.nextRunAt, sh('2025-03-11T09:30:00'));
  assert.strictEqual(createFavoriteSchedule(schedule, sh('2025-12-31T23:00:00')).value.nextRunAt, sh('2026-01-01T09:30:00'));
});

// ---------------------------------------------------------------------------
// normalizeFavoriteSchedule
// ---------------------------------------------------------------------------

test('normalizeFavoriteSchedule 非法输入返回 null', () => {
  const now = sh('2025-03-10T08:00:00');
  assert.strictEqual(normalizeFavoriteSchedule(null, now), null);
  assert.strictEqual(normalizeFavoriteSchedule(undefined, now), null);
  assert.strictEqual(normalizeFavoriteSchedule({}, now), null);
  assert.strictEqual(normalizeFavoriteSchedule({ frequency: 'monthly', time: '09:00' }, now), null);
  assert.strictEqual(normalizeFavoriteSchedule({ frequency: 'daily', time: '24:00' }, now), null);
  assert.strictEqual(normalizeFavoriteSchedule({ frequency: 'weekly', time: '09:00' }, now), null);
});

test('normalizeFavoriteSchedule 保留合法历史字段并补齐 timezone', () => {
  const now = sh('2025-03-10T08:00:00');
  const normalized = normalizeFavoriteSchedule(
    {
      frequency: 'weekly',
      time: '09:00',
      weekday: '3',
      nextRunAt: 111,
      retryAt: 222,
      lastRunAt: 333,
      lastStatus: 'failed',
      lastError: 'boom'
    },
    now
  );
  assert.deepStrictEqual(normalized, {
    frequency: 'weekly',
    time: '09:00',
    weekday: 3,
    timezone: 'Asia/Shanghai',
    nextRunAt: 111,
    retryAt: 222,
    lastRunAt: 333,
    lastStatus: 'failed',
    lastError: 'boom'
  });
  // 数值字符串按 Number() 收编
  assert.strictEqual(normalizeFavoriteSchedule({ frequency: 'daily', time: '09:00', nextRunAt: '4444' }, now).nextRunAt, 4444);
  assert.strictEqual(normalizeFavoriteSchedule({ frequency: 'daily', time: '09:00', retryAt: '5555' }, now).retryAt, 5555);
});

test('normalizeFavoriteSchedule 非法 nextRunAt 回退到按 now 重新计算', () => {
  const now = sh('2025-03-10T09:31:00');
  const expected = calculateNextFavoriteRunAt({ frequency: 'daily', time: '09:30' }, now);
  assert.strictEqual(expected, sh('2025-03-11T09:30:00'));
  for (const nextRunAt of [undefined, null, 0, -1, NaN, Infinity, 'abc', {}, []]) {
    const normalized = normalizeFavoriteSchedule({ frequency: 'daily', time: '09:30', nextRunAt }, now);
    assert.strictEqual(normalized.nextRunAt, expected, `nextRunAt=${String(nextRunAt)} 应回退到重算值`);
  }
});

test('normalizeFavoriteSchedule retryAt/lastRunAt 非正数或非有限数归为 null', () => {
  const now = sh('2025-03-10T08:00:00');
  const base = { frequency: 'daily', time: '09:00' };
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, 'abc', '0', {}]) {
    const normalized = normalizeFavoriteSchedule({ ...base, retryAt: bad, lastRunAt: bad }, now);
    assert.strictEqual(normalized.retryAt, null, `retryAt=${String(bad)} 应为 null`);
    assert.strictEqual(normalized.lastRunAt, null, `lastRunAt=${String(bad)} 应为 null`);
  }
});

test('normalizeFavoriteSchedule lastStatus 仅白名单 success/failed，lastError 仅字符串', () => {
  const now = sh('2025-03-10T08:00:00');
  const base = { frequency: 'daily', time: '09:00' };
  assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastStatus: 'success' }, now).lastStatus, 'success');
  assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastStatus: 'failed' }, now).lastStatus, 'failed');
  for (const bad of ['SUCCESS', 'pending', 'ok', '', 1, null, undefined, {}]) {
    assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastStatus: bad }, now).lastStatus, '', `lastStatus=${String(bad)} 应为空串`);
  }
  assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastError: 'E' }, now).lastError, 'E');
  assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastError: '' }, now).lastError, '');
  for (const bad of [undefined, null, 0, 123, {}, ['E']]) {
    assert.strictEqual(normalizeFavoriteSchedule({ ...base, lastError: bad }, now).lastError, '', `lastError=${String(bad)} 应为空串`);
  }
});

test('normalizeFavoriteSchedule 的 now 影响回退计算出的 nextRunAt', () => {
  const value = { frequency: 'daily', time: '09:30' };
  assert.strictEqual(normalizeFavoriteSchedule(value, sh('2025-03-10T08:00:00')).nextRunAt, sh('2025-03-10T09:30:00'));
  assert.strictEqual(normalizeFavoriteSchedule(value, sh('2025-03-10T09:30:00')).nextRunAt, sh('2025-03-11T09:30:00'));
});

// ---------------------------------------------------------------------------
// runDueFavoriteSchedules
// ---------------------------------------------------------------------------

test('runDueFavoriteSchedules 入参不合法时返回空数组且不调用 refresh', async () => {
  const now = sh('2025-03-10T09:30:00');
  let refreshCalls = 0;
  const refresh = async () => {
    refreshCalls += 1;
  };
  assert.deepStrictEqual(await runDueFavoriteSchedules({ favoriteCache: {}, now, refresh }), []);
  assert.deepStrictEqual(await runDueFavoriteSchedules({ favoriteCache: [], now, refresh }), []);
  assert.deepStrictEqual(await runDueFavoriteSchedules({ favoriteCache: null, now, refresh }), []);
  assert.deepStrictEqual(await runDueFavoriteSchedules({ favoriteCache: undefined, now, refresh }), []);
  // refresh 非函数
  assert.deepStrictEqual(
    await runDueFavoriteSchedules({ favoriteCache: new Map([['kw', { refreshSchedule: dailySchedule('09:00', now) }]]), now }),
    []
  );
  assert.deepStrictEqual(
    await runDueFavoriteSchedules({ favoriteCache: new Map([['kw', { refreshSchedule: dailySchedule('09:00', now) }]]), now, refresh: null }),
    []
  );
  assert.strictEqual(refreshCalls, 0);
});

test('runDueFavoriteSchedules 到期项调用 refresh 并回报成功', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now - 1000) }]]);
  const refreshArgs = [];
  const persistArgs = [];
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async (...args) => {
      refreshArgs.push(args);
    },
    persist: async (...args) => {
      persistArgs.push(args);
    }
  });

  assert.deepStrictEqual(refreshArgs, [['kw']], 'refresh 必须收到 keyword 一个参数');
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: true, retry: false }]);
  assert.strictEqual(persistArgs.length, 1, '有变更时 persist 调用一次');
  assert.deepStrictEqual(persistArgs[0], [], 'persist 不接收参数');

  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.lastRunAt, now);
  assert.strictEqual(schedule.nextRunAt, sh('2025-03-10T10:00:00'), '从当前时间重算下一个正常周期');
  assert.strictEqual(schedule.lastStatus, 'success');
  assert.strictEqual(schedule.lastError, '');
  assert.strictEqual(schedule.retryAt, null);
});

test('runDueFavoriteSchedules 未到期项完全跳过（不刷新、不重算 nextRunAt、不持久化）', async () => {
  const now = sh('2025-03-10T09:30:00');
  const future = now + 1;
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', future) }]]);
  let refreshCalls = 0;
  let persistCalls = 0;
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {
      refreshCalls += 1;
    },
    persist: async () => {
      persistCalls += 1;
    }
  });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(refreshCalls, 0);
  assert.strictEqual(persistCalls, 0, '无变更不落盘');
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.nextRunAt, future, '未到期不改写 nextRunAt');
  assert.strictEqual(schedule.lastRunAt, null);
  assert.strictEqual(schedule.lastStatus, '', '未执行不写状态');
  // 但条目仍被原地归一化（补 timezone）——记录这一副作用
  assert.strictEqual(schedule.timezone, 'Asia/Shanghai');
});

test('runDueFavoriteSchedules 恰好到期（nextRunAt === now）即触发', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now) }]]);
  const calls = [];
  const results = await runDueFavoriteSchedules({ favoriteCache: cache, now, refresh: async k => calls.push(k) });
  assert.deepStrictEqual(calls, ['kw']);
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: true, retry: false }]);
});

test('runDueFavoriteSchedules 无排程/排程非法的条目被跳过，且不抛错', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([
    ['empty', {}],
    ['nullSchedule', { refreshSchedule: null }],
    ['badFrequency', { refreshSchedule: { frequency: 'monthly', time: '09:00' } }],
    ['badTime', { refreshSchedule: { frequency: 'daily', time: '9:00', nextRunAt: now } }],
    ['nullEntry', null]
  ]);
  let refreshCalls = 0;
  let persistCalls = 0;
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {
      refreshCalls += 1;
    },
    persist: async () => {
      persistCalls += 1;
    }
  });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(refreshCalls, 0);
  assert.strictEqual(persistCalls, 0);
  assert.deepStrictEqual(cache.get('empty'), {}, '空条目原样保留');
  assert.strictEqual(cache.get('nullEntry'), null);
});

test('runDueFavoriteSchedules refresh 抛错：记录失败、状态与重试时间，仍持久化', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now) }]]);
  let persistCalls = 0;
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {
      throw new Error('boom');
    },
    persist: async () => {
      persistCalls += 1;
    }
  });
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: false, retry: false, error: 'boom' }]);
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.lastStatus, 'failed');
  assert.strictEqual(schedule.lastError, 'boom');
  assert.strictEqual(schedule.lastRunAt, now);
  assert.strictEqual(schedule.retryAt, now + 10 * 60 * 1000, '普通失败安排 10 分钟后重试');
  assert.strictEqual(schedule.nextRunAt, sh('2025-03-10T10:00:00'), 'nextRunAt 仍已推进');
  assert.strictEqual(persistCalls, 1, '失败也算变更，需要落盘');
});

test('runDueFavoriteSchedules refresh 抛出非 Error 或空消息 Error 时的错误文案', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([
    ['plain', { refreshSchedule: dailySchedule('10:00', now) }],
    ['emptyError', { refreshSchedule: dailySchedule('10:00', now) }]
  ]);
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async keyword => {
      if (keyword === 'plain') throw 'plain-string';
      throw new Error('');
    }
  });
  // 字符串错误走 String(error)；空消息 Error 走 String(error) 得到 'Error'
  assert.deepStrictEqual(results, [
    { keyword: 'plain', success: false, retry: false, error: 'plain-string' },
    { keyword: 'emptyError', success: false, retry: false, error: 'Error' }
  ]);
});

test('runDueFavoriteSchedules 重试到期项：成功清空 retryAt 且不动 nextRunAt', async () => {
  const now = sh('2025-03-10T09:30:00');
  const future = sh('2025-03-10T10:00:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', future, { retryAt: now }) }]]);
  const calls = [];
  const results = await runDueFavoriteSchedules({ favoriteCache: cache, now, refresh: async k => calls.push(k) });
  assert.deepStrictEqual(calls, ['kw']);
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: true, retry: true }]);
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.retryAt, null, '重试成功清除 retryAt');
  assert.strictEqual(schedule.nextRunAt, future, '非正常周期（仅重试）不重算 nextRunAt');
  assert.strictEqual(schedule.lastRunAt, now);
});

test('runDueFavoriteSchedules 重试再次失败：retryAt 置空不再重试', async () => {
  const now = sh('2025-03-10T09:31:00');
  const future = sh('2025-03-10T10:00:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', future, { retryAt: now - 1000, lastStatus: 'failed' }) }]]);
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {
      throw new Error('still broken');
    }
  });
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: false, retry: true, error: 'still broken' }]);
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.retryAt, null, '重试失败不再追加 retryAt');
  assert.strictEqual(schedule.nextRunAt, future);
  assert.strictEqual(schedule.lastStatus, 'failed');
});

test('runDueFavoriteSchedules 正常周期与重试同时到期：重算 nextRunAt，失败也不再重试', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now - 60 * 1000, { retryAt: now - 1000 }) }]]);
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {
      throw new Error('nope');
    }
  });
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: false, retry: true, error: 'nope' }]);
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.retryAt, null);
  assert.strictEqual(schedule.nextRunAt, sh('2025-03-10T10:00:00'));
});

test('runDueFavoriteSchedules persist 返回 false 不改变结果与内存状态', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now) }]]);
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async () => {},
    persist: async () => false
  });
  assert.deepStrictEqual(results, [{ keyword: 'kw', success: true, retry: false }]);
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.lastStatus, 'success');
  assert.strictEqual(schedule.lastRunAt, now);
});

test('runDueFavoriteSchedules persist 抛错会向上冒泡，且内存状态已被改写', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([['kw', { refreshSchedule: dailySchedule('10:00', now) }]]);
  await assert.rejects(
    runDueFavoriteSchedules({
      favoriteCache: cache,
      now,
      refresh: async () => {},
      persist: async () => {
        throw new Error('persist boom');
      }
    }),
    { name: 'Error', message: 'persist boom' }
  );
  // 出错时 schedule 已经写完，仅落盘失败（真实行为：内存与持久化可能不一致）
  const schedule = cache.get('kw').refreshSchedule;
  assert.strictEqual(schedule.lastStatus, 'success');
  assert.strictEqual(schedule.lastRunAt, now);
  assert.strictEqual(schedule.nextRunAt, sh('2025-03-10T10:00:00'));
});

test('runDueFavoriteSchedules 多条目按 Map 顺序串行执行，persist 只调用一次', async () => {
  const now = sh('2025-03-10T09:30:00');
  const cache = new Map([
    ['third', { refreshSchedule: dailySchedule('10:00', now) }],
    ['first', { refreshSchedule: dailySchedule('10:00', now - 1) }],
    ['second', { refreshSchedule: dailySchedule('10:00', now - 2) }]
  ]);
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let persistCalls = 0;
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async keyword => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(keyword);
      await Promise.resolve();
      concurrent -= 1;
    },
    persist: async () => {
      persistCalls += 1;
    }
  });
  assert.deepStrictEqual(order, ['third', 'first', 'second'], '按 Map 插入顺序遍历');
  assert.strictEqual(maxConcurrent, 1, '逐条串行，不并发刷新');
  assert.strictEqual(persistCalls, 1, '多个变更合并为一次持久化');
  assert.deepStrictEqual(
    results.map(item => item.keyword),
    ['third', 'first', 'second']
  );
  assert.deepStrictEqual(
    results.map(item => item.success),
    [true, true, true]
  );
});

test('runDueFavoriteSchedules 混合到期与未到期：只刷新到期项，各自状态隔离', async () => {
  const now = sh('2025-03-10T09:30:00');
  const later = sh('2025-03-10T12:00:00');
  const cache = new Map([
    ['due', { refreshSchedule: dailySchedule('10:00', now - 1) }],
    ['notDue', { refreshSchedule: dailySchedule('12:00', later) }],
    ['failing', { refreshSchedule: dailySchedule('10:30', now - 1) }]
  ]);
  const results = await runDueFavoriteSchedules({
    favoriteCache: cache,
    now,
    refresh: async keyword => {
      if (keyword === 'failing') throw new Error('bad');
    }
  });
  assert.deepStrictEqual(results, [
    { keyword: 'due', success: true, retry: false },
    { keyword: 'failing', success: false, retry: false, error: 'bad' }
  ]);
  assert.strictEqual(cache.get('due').refreshSchedule.lastStatus, 'success');
  assert.strictEqual(cache.get('failing').refreshSchedule.lastStatus, 'failed');
  assert.strictEqual(cache.get('notDue').refreshSchedule.lastRunAt, null);
  assert.strictEqual(cache.get('notDue').refreshSchedule.lastStatus, '');
  assert.strictEqual(cache.get('notDue').refreshSchedule.nextRunAt, later);
});

// ---------------------------------------------------------------------------
// startFavoriteScheduler / stopFavoriteScheduler
// ---------------------------------------------------------------------------

const SCHEDULER_T0 = sh('2025-06-01T10:00:00');

test('startFavoriteScheduler refresh 非函数返回 false 且不注册定时器', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  cache.set('kw', { refreshSchedule: dailySchedule('23:00', SCHEDULER_T0) });

  assert.strictEqual(await startFavoriteScheduler({ refresh: null, persist: async () => {} }), false);
  assert.strictEqual(await startFavoriteScheduler({}), false);
  assert.strictEqual(await startFavoriteScheduler({ refresh: 'nope' }), false);

  // 上一步没有留下定时器/状态：合法启动仍能返回 true 并立即执行一次
  let calls = 0;
  assert.strictEqual(
    await startFavoriteScheduler({
      refresh: async () => {
        calls += 1;
      },
      intervalMs: 60 * 1000
    }),
    true
  );
  assert.strictEqual(calls, 1);

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('startFavoriteScheduler 立即执行一次，之后按 interval 触发，重复 start 幂等', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  const calls = [];
  // immediate：启动时已到期；later：10:01 到期，恰好落在一个 interval 之后
  cache.set('immediate', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });
  cache.set('later', { refreshSchedule: { frequency: 'daily', time: '10:01' } });

  const refresh = async keyword => {
    calls.push([keyword, Date.now()]);
  };
  const persistCalls = [];

  assert.strictEqual(
    await startFavoriteScheduler({
      refresh,
      persist: async () => {
        persistCalls.push(Date.now());
      },
      intervalMs: 60 * 1000
    }),
    true
  );
  assert.deepStrictEqual(calls, [['immediate', SCHEDULER_T0]], '启动时立即执行一次');
  assert.deepStrictEqual(persistCalls, [SCHEDULER_T0]);
  // later 被归一化并排到 10:01
  assert.strictEqual(cache.get('later').refreshSchedule.nextRunAt, SCHEDULER_T0 + 60 * 1000);

  // 重复 start：已有定时器 → false，且不产生额外刷新
  assert.strictEqual(await startFavoriteScheduler({ refresh, intervalMs: 60 * 1000 }), false);
  assert.strictEqual(calls.length, 1, '重复 start 不触发 tick');

  // 第一个 interval：later 到期，只触发一次
  t.mock.timers.tick(60 * 1000);
  await flushMicrotasks();
  assert.deepStrictEqual(
    calls.map(item => item[0]),
    ['immediate', 'later']
  );
  assert.strictEqual(calls[1][1], SCHEDULER_T0 + 60 * 1000, '在第 1 个 interval 触发，而非其它时刻');
  assert.strictEqual(persistCalls.length, 2);

  // 再推进两个 interval：两条排程都排到明天，不应再触发
  t.mock.timers.tick(60 * 1000);
  await flushMicrotasks();
  t.mock.timers.tick(60 * 1000);
  await flushMicrotasks();
  assert.strictEqual(calls.length, 2, '下一次正常周期在明天，不再触发');

  // 一天后（一次 tick 内 mock 会同步连发 1440 次回调，schedulerRunning 守卫把这一批折叠成一轮检查）
  // 两条排程的下一次正常周期都已到点，各触发一次，persist 合并为一次
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushMicrotasks();
  assert.strictEqual(calls.length, 4, '跨到次日窗口后两条排程各触发一次');
  assert.deepStrictEqual(
    calls.map(item => item[0]),
    ['immediate', 'later', 'immediate', 'later']
  );
  assert.strictEqual(persistCalls.length, 3, '该轮只落盘一次（守卫避免并发 tick 重复刷新）');

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('stopFavoriteScheduler 之后不再触发，可再次 start', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  // 三条排程分别在 T0 / T0+1min / T0+2min 到期，用来观察 interval 是否逐拍触发
  const calls = [];
  const refresh = async keyword => {
    calls.push(keyword);
  };
  cache.set('e0', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });
  cache.set('e1', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0 + 60 * 1000) });
  cache.set('e2', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0 + 2 * 60 * 1000) });

  assert.strictEqual(await startFavoriteScheduler({ refresh, intervalMs: 60 * 1000 }), true);
  assert.deepStrictEqual(calls, ['e0'], '启动时只执行当时已到期的 e0');

  t.mock.timers.tick(60 * 1000);
  await flushMicrotasks();
  assert.deepStrictEqual(calls, ['e0', 'e1'], 'stop 前 interval 正常触发');

  assert.strictEqual(stopFavoriteScheduler(), undefined);
  t.mock.timers.tick(60 * 1000);
  await flushMicrotasks();
  assert.deepStrictEqual(calls, ['e0', 'e1'], 'stop 后 e2 到期也不再触发');

  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await flushMicrotasks();
  assert.deepStrictEqual(calls, ['e0', 'e1'], 'stop 后长时间推进同样不触发');

  // stop 后可以重新启动：给一条当前已到期的排程，立即 tick 会再次执行
  const nowAfterStop = SCHEDULER_T0 + 2 * 60 * 1000 + 24 * 60 * 60 * 1000;
  cache.clear();
  cache.set('again', { refreshSchedule: dailySchedule('09:00', nowAfterStop) });
  assert.strictEqual(await startFavoriteScheduler({ refresh, intervalMs: 60 * 1000 }), true);
  assert.deepStrictEqual(calls, ['e0', 'e1', 'again'], '重新启动会立即执行一次');

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('stopFavoriteScheduler 未启动时是空操作，且不影响后续启动', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();

  // 未启动：返回 undefined，重复调用同样安全
  assert.strictEqual(stopFavoriteScheduler(), undefined);
  assert.strictEqual(stopFavoriteScheduler(), undefined);

  // 之后启动仍能正常注册定时器并立即执行
  let calls = 0;
  cache.set('kw', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });
  assert.strictEqual(
    await startFavoriteScheduler({
      refresh: async () => {
        calls += 1;
      },
      intervalMs: 60 * 1000
    }),
    true
  );
  assert.strictEqual(calls, 1);

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('startFavoriteScheduler 空 cache 启动返回 true 且不刷新', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  let calls = 0;
  let persistCalls = 0;
  assert.strictEqual(
    await startFavoriteScheduler({
      refresh: async () => {
        calls += 1;
      },
      persist: async () => {
        persistCalls += 1;
      },
      intervalMs: 1000
    }),
    true
  );
  assert.strictEqual(calls, 0);
  assert.strictEqual(persistCalls, 0);
  t.mock.timers.tick(5000);
  await flushMicrotasks();
  assert.strictEqual(calls, 0);
  assert.strictEqual(persistCalls, 0);

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('startFavoriteScheduler 首次 tick 的 persist 抛错会向上冒泡且不注册定时器', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  cache.set('kw', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });

  let calls = 0;
  await assert.rejects(
    startFavoriteScheduler({
      refresh: async () => {
        calls += 1;
      },
      persist: async () => {
        throw new Error('persist failed at start');
      },
      intervalMs: 60 * 1000
    }),
    { name: 'Error', message: 'persist failed at start' }
  );
  assert.strictEqual(calls, 1, '首次 tick 已执行完刷新');

  // 抛错发生在 setInterval 之前：没有残留定时器（否则再次 start 会因 schedulerTimer 已存在返回 false）
  cache.set('again', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });
  assert.strictEqual(
    await startFavoriteScheduler({
      refresh: async () => {
        calls += 1;
      },
      persist: async () => {},
      intervalMs: 60 * 1000
    }),
    true
  );
  assert.strictEqual(calls, 2, '再次启动只刷新新到期的条目（kw 已排到次日）');

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});

test('startFavoriteScheduler 刷新抛错不会中断调度（runDue 内部已消化）', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  t.mock.timers.setTime(SCHEDULER_T0);
  const cache = globals.favoriteCache;
  cache.clear();
  cache.set('kw', { refreshSchedule: dailySchedule('09:00', SCHEDULER_T0) });

  let attempts = 0;
  assert.strictEqual(
    await startFavoriteScheduler({
      refresh: async () => {
        attempts += 1;
        throw new Error('refresh down');
      },
      intervalMs: 60 * 1000
    }),
    true
  );
  assert.strictEqual(attempts, 1);
  // 失败已排入 10 分钟后的 retryAt，interval 到点会再次尝试
  assert.strictEqual(cache.get('kw').refreshSchedule.retryAt, SCHEDULER_T0 + 10 * 60 * 1000);
  t.mock.timers.tick(10 * 60 * 1000);
  await flushMicrotasks();
  assert.strictEqual(attempts, 2, '重试窗口到点后再次刷新');
  assert.strictEqual(cache.get('kw').refreshSchedule.retryAt, null, '重试失败后不再重试');

  stopFavoriteScheduler();
  cache.clear();
  t.mock.timers.reset();
});
