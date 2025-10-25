// =====================
// 时间日期处理相关函数
// =====================

// 生成有效的 ISO 8601 日期格式
export function generateValidStartDate(year) {
  // 验证年份是否有效（1900-2100）
  const yearNum = parseInt(year);
  if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2100) {
    // 如果年份无效，使用当前年份
    return `${new Date().getFullYear()}-01-01T00:00:00Z`;
  }
  return `${yearNum}-01-01T00:00:00Z`;
}

export function time_to_second(time) {
  const parts = time.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else {
    seconds = parts[0];
  }
  return seconds;
}