import { globals } from '../configs/globals.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let schedulerTimer = null;
let schedulerRunning = false;

function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, value: `${match[1]}:${match[2]}` };
}

function shanghaiDateParts(timestamp) {
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const sundayBasedDay = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    weekday: sundayBasedDay === 0 ? 7 : sundayBasedDay
  };
}

function shanghaiTimestamp(year, month, date, hour, minute) {
  return Date.UTC(year, month, date, hour, minute) - SHANGHAI_OFFSET_MS;
}

export function validateFavoriteSchedule(value) {
  if (!value || typeof value !== 'object') {
    return { valid: false, message: '缺少定时刷新配置' };
  }
  const frequency = String(value.frequency || '').toLowerCase();
  if (frequency !== 'daily' && frequency !== 'weekly') {
    return { valid: false, message: 'frequency 仅支持 daily 或 weekly' };
  }
  const parsedTime = parseTime(value.time);
  if (!parsedTime) {
    return { valid: false, message: 'time 必须是 HH:mm 格式的有效时间' };
  }
  const weekday = Number(value.weekday);
  if (frequency === 'weekly' && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    return { valid: false, message: 'weekly 模式的 weekday 必须是 1-7' };
  }
  return {
    valid: true,
    value: {
      frequency,
      time: parsedTime.value,
      ...(frequency === 'weekly' ? { weekday } : {}),
      timezone: 'Asia/Shanghai'
    }
  };
}

export function calculateNextFavoriteRunAt(schedule, fromTimestamp = Date.now()) {
  const validated = validateFavoriteSchedule(schedule);
  if (!validated.valid) return 0;
  const parsedTime = parseTime(validated.value.time);
  const parts = shanghaiDateParts(fromTimestamp);
  let candidate = shanghaiTimestamp(parts.year, parts.month, parts.date, parsedTime.hour, parsedTime.minute);

  if (validated.value.frequency === 'daily') {
    if (candidate <= fromTimestamp) candidate += DAY_MS;
    return candidate;
  }

  let daysAhead = (validated.value.weekday - parts.weekday + 7) % 7;
  candidate += daysAhead * DAY_MS;
  if (candidate <= fromTimestamp) candidate += 7 * DAY_MS;
  return candidate;
}

export function createFavoriteSchedule(value, now = Date.now()) {
  const validated = validateFavoriteSchedule(value);
  if (!validated.valid) return validated;
  return {
    valid: true,
    value: {
      ...validated.value,
      nextRunAt: calculateNextFavoriteRunAt(validated.value, now),
      retryAt: null,
      lastRunAt: null,
      lastStatus: '',
      lastError: ''
    }
  };
}

export function normalizeFavoriteSchedule(value, now = Date.now()) {
  const created = createFavoriteSchedule(value, now);
  if (!created.valid) return null;
  const numberOrNull = candidate => {
    const number = Number(candidate);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  return {
    ...created.value,
    nextRunAt: numberOrNull(value.nextRunAt) || created.value.nextRunAt,
    retryAt: numberOrNull(value.retryAt),
    lastRunAt: numberOrNull(value.lastRunAt),
    lastStatus: value.lastStatus === 'success' || value.lastStatus === 'failed' ? value.lastStatus : '',
    lastError: typeof value.lastError === 'string' ? value.lastError : ''
  };
}

export async function runDueFavoriteSchedules({
  favoriteCache,
  now = Date.now(),
  refresh,
  persist
}) {
  if (!(favoriteCache instanceof Map) || typeof refresh !== 'function') return [];
  const results = [];
  let changed = false;

  for (const [keyword, entry] of favoriteCache.entries()) {
    const schedule = normalizeFavoriteSchedule(entry?.refreshSchedule, now);
    if (!schedule) continue;
    entry.refreshSchedule = schedule;

    const isRetry = schedule.retryAt !== null && schedule.retryAt <= now;
    const isNormalRun = schedule.nextRunAt <= now;
    if (!isRetry && !isNormalRun) continue;

    // 无论停机多久，每次检查只执行一次，并从当前时间计算下个正常周期。
    if (isNormalRun) schedule.nextRunAt = calculateNextFavoriteRunAt(schedule, now);
    schedule.lastRunAt = now;
    changed = true;

    try {
      await refresh(keyword);
      const currentEntry = favoriteCache.get(keyword);
      if (currentEntry) currentEntry.refreshSchedule = schedule;
      schedule.retryAt = null;
      schedule.lastStatus = 'success';
      schedule.lastError = '';
      results.push({ keyword, success: true, retry: isRetry });
    } catch (error) {
      schedule.lastStatus = 'failed';
      schedule.lastError = error?.message || String(error);
      schedule.retryAt = isRetry ? null : now + 10 * 60 * 1000;
      results.push({ keyword, success: false, retry: isRetry, error: schedule.lastError });
    }
  }

  if (changed && typeof persist === 'function') await persist();
  return results;
}

export async function startFavoriteScheduler({ refresh, persist, intervalMs = 60 * 1000 }) {
  if (schedulerTimer || typeof refresh !== 'function') return false;

  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      await runDueFavoriteSchedules({
        favoriteCache: globals.favoriteCache,
        refresh,
        persist
      });
    } finally {
      schedulerRunning = false;
    }
  };

  await tick();
  schedulerTimer = setInterval(tick, intervalMs);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  return true;
}

export function stopFavoriteScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerRunning = false;
}
