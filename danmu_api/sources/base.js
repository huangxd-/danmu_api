import { log } from "../utils/log-util.js";
import { convertToDanmakuJson } from "../utils/danmu-util.js";
import { extractYear } from "../utils/common-util.js";

// =====================
// 源基类
// =====================

export default class BaseSource {
  constructor() {
    // 构造函数，初始化通用配置
  }

  async search(keyword) {
    throw new Error("Method 'search' must be implemented");
  }

  async getEpisodes(id) {
    throw new Error("Method 'Episodes' must be implemented");
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, vodName) {
    throw new Error("Method 'handleAnimes' must be implemented");
  }

  async getEpisodeDanmu(id) {
    throw new Error("Method 'getEpisodeDanmu' must be implemented");
  }

  formatComments(comments) {
    throw new Error("Method 'formatComments' must be implemented");
  }

  async getComments(id, sourceName, progressCallback=null) {
    if(progressCallback) await progressCallback(5, `开始获取弹幕${sourceName}弹幕`);
    log("info", `开始获取弹幕${sourceName}弹幕`);
    const raw = await this.getEpisodeDanmu(id);
    if(progressCallback) await progressCallback(85,`原始弹幕 ${raw.length} 条，正在规范化`);
    log("info", `原始弹幕 ${raw.length} 条，正在规范化`);
    const formatted = this.formatComments(raw);
    if(progressCallback) await progressCallback(100,`弹幕处理完成，共 ${formatted.length} 条`);
    log("info", `弹幕处理完成，共 ${formatted.length} 条`);
    return convertToDanmakuJson(formatted, sourceName);
  }

  // 按年份降序排序并添加到curAnimes
  sortAndPushAnimesByYear(processedAnimes, curAnimes) {
    processedAnimes
      .filter(anime => anime !== null)
      .sort((a, b) => {
        const yearA = extractYear(a.animeTitle);
        const yearB = extractYear(b.animeTitle);

        // 如果都有年份，按年份降序排列
        if (yearA !== null && yearA !== undefined && yearB !== null && yearB !== undefined) {
          return yearB - yearA;
        }
        // 如果只有a有年份，a排在前面
        if ((yearA !== null && yearA !== undefined) && (yearB === null || yearB === undefined)) {
          return -1;
        }
        // 如果只有b有年份，b排在前面
        if ((yearA === null || yearA === undefined) && (yearB !== null && yearB !== undefined)) {
          return 1;
        }
        // 如果都没有年份，保持原顺序
        return 0;
      })
      .forEach(anime => {
        // 检查 curAnimes 中是否已存在相同 animeId 的动漫
        const existingIndex = curAnimes.findIndex(a => a.animeId === anime.animeId);
        if (existingIndex === -1) {
          // 不存在则添加
          curAnimes.push(anime);
        }
        // 如果已存在则跳过，避免重复
      });
  }
}