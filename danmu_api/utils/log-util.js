import { globals } from '../configs/globals.js';
import fs from 'node:fs';
import path from 'node:path';

const logDir = path.resolve(process.cwd(), 'data', 'log');

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// =====================
// 路由请求相关
// =====================

export function log(level, ...args) {
  // 根据日志级别决定是否输出
  const levels = { error: 0, warn: 1, info: 2 };
  const currentLevelValue = levels[globals.logLevel] !== undefined ? levels[globals.logLevel] : 1;
  if ((levels[level] || 0) > currentLevelValue) {
    return; // 日志级别不符合，不输出
  }

  const message = args
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : arg))
    .join(" ");

  // 获取上海时区时间(UTC+8)
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timestamp = shanghaiTime.toISOString().replace('Z', '+08:00');
  
  // 写入文件
  const logMessage = `${timestamp} [${level.toUpperCase()}] ${message}\n`;
  const logFileName = shanghaiTime.toISOString().split('T')[0] + '.log';
  const logFilePath = path.join(logDir, logFileName);
  fs.appendFile(logFilePath, logMessage, { encoding: 'utf8' }, (err) => {
    if (err) {
      console.error('Failed to write to log file:', err);
    }
  });

  globals.logBuffer.push({ timestamp, level, message });
  if (globals.logBuffer.length > globals.MAX_LOGS) globals.logBuffer.shift();
  console[level](...args);
}

export function formatLogMessage(message) {
  try {
    const parsed = JSON.parse(message);
    return JSON.stringify(parsed, null, 2).replace(/\n/g, "\n    ");
  } catch {
    return message;
  }
}
