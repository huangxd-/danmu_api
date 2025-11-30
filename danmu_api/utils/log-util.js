import { globals } from '../configs/globals.js';

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

  // 处理日志参数，隐藏敏感信息
  const processedArgs = args.map(arg => {
    if (typeof arg === "object") {
      // 如果是对象，转换为字符串并隐藏敏感信息
      const jsonString = JSON.stringify(arg);
      return hideSensitiveInfo(jsonString);
    } else {
      // 如果是字符串，直接隐藏敏感信息
      return typeof arg === 'string' ? hideSensitiveInfo(arg) : arg;
    }
  });

  const message = processedArgs
    .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
    .join(" ");

  // 获取上海时区时间(UTC+8)
  const now = new Date();
  const shanghaiTime = new Date(now.getTime() + (8 * 60 * 1000));
  const timestamp = shanghaiTime.toISOString().replace('Z', '+08:00');

  globals.logBuffer.push({ timestamp, level, message });
  if (globals.logBuffer.length > globals.MAX_LOGS) globals.logBuffer.shift();
  console[level](...processedArgs);
}

// 隐藏敏感信息的辅助函数
function hideSensitiveInfo(message) {
  let processedMessage = message;

  // 从 globals.originalEnvVars 获取被加密的环境变量值并替换
  // 通过比较 globals.originalEnvVars 和 globals.accessedEnvVars 来识别加密变量
  // 如果 originalEnvVars 中的值与 accessedEnvVars 中的值不同，且 accessedEnvVars 中是星号，则说明该变量被加密
  if (globals.originalEnvVars && globals.accessedEnvVars) {
    for (const [envVar, originalValue] of Object.entries(globals.originalEnvVars)) {
      const accessedValue = globals.accessedEnvVars[envVar];
      
      // 检查是否为加密变量：原始值存在、访问值存在、访问值是星号且与原始值不同
      if (originalValue && typeof originalValue === 'string' && originalValue.length > 0 &&
          accessedValue && typeof accessedValue === 'string' &&
          accessedValue.match(/^\*+$/) && accessedValue.length === originalValue.length) {
        // 这是一个加密变量，需要隐藏
        const mask = '*'.repeat(originalValue.length);
        // 创建正则表达式来匹配环境变量值，使用全局替换
        const regex = new RegExp(originalValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        processedMessage = processedMessage.replace(regex, mask);
      }
    }
  }

  return processedMessage;
}

export function formatLogMessage(message) {
  try {
    const parsed = JSON.parse(message);
    return JSON.stringify(parsed, null, 2).replace(/\n/g, "\n    ");
  } catch {
    return message;
  }
}
