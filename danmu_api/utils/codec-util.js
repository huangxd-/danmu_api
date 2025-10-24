
// =====================
// 通用编码/解码工具
// =====================

// 简单的字符串哈希函数
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash >>> 0; // 确保为无符号 32 位整数
  }
  return hash.toString(16); // 转换为十六进制
}

// 辅助函数：序列化值，处理 Map 对象
export function serializeValue(key, value) {
  // 对于 lastSelectMap（Map 对象），需要转换为普通对象后再序列化
  if (key === 'lastSelectMap' && value instanceof Map) {
    return JSON.stringify(Object.fromEntries(value));
  }
  return JSON.stringify(value);
}