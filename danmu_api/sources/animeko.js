import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet, httpPost } from "../utils/http-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { simplized } from "../utils/zh-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取Animeko弹幕(https://github.com/open-ani/animeko)
// =====================

/**
 * Animeko 源适配器 (基于 Bangumi API V0)
 * 提供深度元数据搜索、结果过滤及条目关系检测功能
 */
export default class AnimekoSource extends BaseSource {
  
  /**
   * 获取标准 HTTP 请求头
   * @returns {Object} 请求头对象
   */
  get headers() {
    return {
      "Content-Type": "application/json",
      "User-Agent": `huangxd-/danmu_api/${globals.version}(https://github.com/huangxd-/danmu_api)`,
    };
  }

  /**
   * 搜索动画条目
   * 使用 Bangumi V0 POST 接口进行搜索，并进行后置过滤和关系检测
   * @param {string} keyword 搜索关键词
   * @returns {Promise<Array>} 转换后的搜索结果列表
   */
  async search(keyword) {
    try {
      log("info", `[Animeko] 开始搜索 (V0): ${keyword}`);

      const searchUrl = `https://api.bgm.tv/v0/search/subjects?limit=5`;
      
      const payload = {
        keyword: keyword,
        filter: {
          type: [2] // 2 代表动画类型
        }
      };

      const resp = await httpPost(searchUrl, JSON.stringify(payload), {
        headers: this.headers
      });

      if (!resp || !resp.data) {
        log("info", "[Animeko] 搜索请求失败或无数据返回");
        return [];
      }

      let resultsList = resp.data.data || [];

      if (resultsList.length === 0) {
        log("info", "[Animeko] 未找到相关条目");
        return [];
      }

      // 执行结果相关度过滤
      resultsList = this.filterSearchResults(resultsList, keyword);

      if (resultsList.length === 0) {
        log("info", "[Animeko] 过滤后无匹配结果");
        return [];
      }

      // 检测条目间关系 (如处理续篇、剧场版等层级关系)
      if (resultsList.length > 1) {
        resultsList = await this.checkRelationsAndModifyTitles(resultsList);
      }
      
      log("info", `[Animeko] 搜索完成，找到 ${resultsList.length} 个有效结果`);
      return this.transformResults(resultsList);
    } catch (error) {
      log("error", "[Animeko] Search error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  /**
   * 从文本中提取明确的季度数字
   * @param {string} text 标题文本
   * @returns {number|null} 季度数字，未找到返回 null
   */
  getExplicitSeasonNumber(text) {
    if (!text) return null;
    const cleanText = simplized(text);

    // 1. 匹配阿拉伯数字 (S2, Season 2, 第2季)
    // 排除 S01 或 第1季，因为通常第一季不带标号，需要特殊处理
    const arabicMatch = cleanText.match(/(?:^|\s|\[|\(|（|【)(?:Season|S|第)\s*(\d+)(?:\s*季|期|部|Season|\]|\)|）|】)?/i);
    if (arabicMatch && arabicMatch[1]) {
      return parseInt(arabicMatch[1], 10);
    }

    // 2. 匹配中文数字 (第二季)
    const cnNums = {'一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9, '十':10};
    const cnMatch = cleanText.match(/第([一二三四五六七八九十]+)[季期部]/);
    if (cnMatch && cnNums[cnMatch[1]]) {
      return cnNums[cnMatch[1]];
    }

    return null;
  }

  /**
   * 过滤搜索结果
   * 包含基础相似度过滤和智能季度匹配逻辑
   * @param {Array} list 原始 API 返回结果列表
   * @param {string} keyword 用户搜索关键词
   * @returns {Array} 过滤后的结果列表
   */
  filterSearchResults(list, keyword) {
    const threshold = 0.6; // 相似度阈值
    const normalizedKeyword = simplized(keyword).toLowerCase().trim();

    // 1. 基础相似度过滤 (获取所有潜在相关结果)
    const candidates = list.filter(item => {
      const titles = new Set();
      if (item.name) titles.add(item.name);
      if (item.name_cn) titles.add(item.name_cn);

      // 解析 infobox 获取更多别名信息
      if (item.infobox && Array.isArray(item.infobox)) {
        item.infobox.forEach(info => {
          if (info.key === '别名' && Array.isArray(info.value)) {
            info.value.forEach(v => { if(v.v) titles.add(v.v); });
          }
          if (info.key === '中文名' && typeof info.value === 'string') {
            titles.add(info.value);
          }
        });
      }

      // 计算最高相似度得分
      let maxScore = 0;
      for (const t of titles) {
        const normalizedTitle = simplized(t).toLowerCase().trim();
        const score = this.calculateSimilarity(normalizedKeyword, normalizedTitle);
        if (score > maxScore) maxScore = score;
      }

      return maxScore >= threshold;
    });

    if (candidates.length === 0) return [];

    // 2. 智能季度匹配逻辑
    // 尝试从关键词中提取目标季度
    const targetSeason = this.getExplicitSeasonNumber(keyword);

    // 规则1: 如果关键词包含明确的季度信息（且大于1，排除S1干扰），则执行严格匹配
    if (targetSeason !== null && targetSeason > 1) {
      log("info", `[Animeko] 检测到指定季度搜索: 第 ${targetSeason} 季`);

      const strictMatches = candidates.filter(item => {
        // 尝试从结果标题中提取季度，如果提取不到，默认为第 1 季
        const seasonInName = this.getExplicitSeasonNumber(item.name);
        const seasonInCn = this.getExplicitSeasonNumber(item.name_cn);
        
        // 只要任一标题匹配季度即可
        // 注意：如果标题中没有季度标识（返回null），我们视为第1季
        const itemSeason = (seasonInName !== null ? seasonInName : (seasonInCn !== null ? seasonInCn : 1));
        
        return itemSeason === targetSeason;
      });

      // 规则3: 如果有符合条件的结果，返回所有符合项
      if (strictMatches.length > 0) {
        return strictMatches;
      }

      // 规则2: 如果包含季度信息但找不到对应结果，返回最优选（第1个）
      log("info", `[Animeko] 未找到第 ${targetSeason} 季对应条目，回退至最优结果`);
      return [candidates[0]];
    }

    // 规则1(反向): 如果关键词不包含季度信息，走原原本本的逻辑 (返回所有高相似度结果)
    return candidates;
  }

  /**
   * 计算字符串相似度
   * 结合包含关系与编辑距离算法
   * @param {string} s1 字符串1
   * @param {string} s2 字符串2
   * @returns {number} 相似度得分 (0.0 - 1.0)
   */
  calculateSimilarity(s1, s2) {
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) {
      const lenRatio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
      return 0.8 + (lenRatio * 0.2); 
    }
    
    // Levenshtein 距离计算
    const len1 = s1.length;
    const len2 = s2.length;
    const matrix = [];
    for (let i = 0; i <= len1; i++) matrix[i] = [i];
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = s1.charAt(i - 1) === s2.charAt(j - 1) ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i-1][j]+1, matrix[i][j-1]+1, matrix[i-1][j-1]+cost);
      }
    }
    const distance = matrix[len1][len2];
    const maxLength = Math.max(len1, len2);
    return maxLength === 0 ? 1.0 : 1.0 - (distance / maxLength);
  }

  /**
   * 检查标题是否包含明确的季度或类型标识
   * @param {string} title 标题文本
   * @returns {boolean} 是否包含明确标识
   */
  hasExplicitSeasonInfo(title) {
    if (!title) return false;
    
    const patterns = [
      /第\s*[0-9一二三四五六七八九十]+\s*[季期部]/i, // 第2季
      /Season\s*\d+/i,          // Season 2
      /S\d+/i,                  // S2
      /Part\s*\d+/i,            // Part 2
      /OVA/i, /OAD/i,
      /剧场版|Movie|Film/i,
      /续篇|续集/i,
      /SP/i,
      /(?<!\d)\d+$/,            // 末尾数字
      /\S+篇/i,                 // 篇章标识 (如: 柱训练篇)
      /\S+章/i,
      /Act\s*\d+/i,
      /Phase\s*\d+/i
    ];

    return patterns.some(p => p.test(title));
  }

  /**
   * 批量检查条目关系并修正标题
   * 对于检测到的续作或衍生关系，在标题后追加标识
   * @param {Array} list 条目列表
   * @returns {Promise<Array>} 修正后的列表
   */
  async checkRelationsAndModifyTitles(list) {
    const checkLimit = Math.min(list.length, 3);

    for (let i = 0; i < checkLimit; i++) {
      for (let j = 0; j < checkLimit; j++) {
        if (i === j) continue;
        
        const subjectA = list[i];
        const subjectB = list[j];
        const nameA = subjectA.name_cn || subjectA.name;
        const nameB = subjectB.name_cn || subjectB.name;

        // 简单的包含关系预检
        if (nameB.includes(nameA) && nameB.length > nameA.length) {
          
          // 如果标题已有明确区分，跳过耗时的 API 检查
          if (this.hasExplicitSeasonInfo(nameB)) {
            continue;
          }

          // 查询 API 确认具体关系
          const relations = await this.getSubjectRelations(subjectA.id);
          const relationInfo = relations.find(r => r.id === subjectB.id);
          
          if (relationInfo) {
            log("info", `[Animeko] 检测到关系: [${nameA}] -> ${relationInfo.relation} -> [${nameB}]`);
            
            const targetRelations = ["续集", "番外篇", "主线故事", "前传", "不同演绎", "衍生"];
            
            if (targetRelations.includes(relationInfo.relation)) {
               let mark = relationInfo.relation;
               if (mark === '续集') mark = '续篇'; // 归一化处理

               subjectB._relation_mark = `(${mark})`; 
            }
          }
        }
      }
    }
    return list;
  }

  /**
   * 获取指定条目的关联条目列表
   * @param {number} subjectId 条目 ID
   * @returns {Promise<Array>} 关联条目数组
   */
  async getSubjectRelations(subjectId) {
    try {
      const url = `https://api.bgm.tv/v0/subjects/${subjectId}/subjects`;
      const resp = await httpGet(url, { headers: this.headers });
      
      if (!resp || !resp.data || !Array.isArray(resp.data)) return [];

      return resp.data.filter(item => item.type === 2).map(item => ({
        id: item.id,
        name: item.name_cn || item.name,
        relation: item.relation 
      }));
    } catch (e) {
      log("warn", `[Animeko] 获取关系失败 ID:${subjectId}: ${e.message}`);
      return [];
    }
  }

  /**
   * 将 API 结果转换为统一的数据格式
   * @param {Array} results API 原始结果
   * @returns {Array} 转换后的数据
   */
  transformResults(results) {
    return results.map(item => {
      let typeDesc = "动漫";
      if (item.platform) {
        switch (item.platform) {
          case "TV": typeDesc = "TV动画"; break;
          case "Web": typeDesc = "Web动画"; break;
          case "OVA": typeDesc = "OVA"; break;
          case "Movie": typeDesc = "剧场版"; break;
          default: typeDesc = item.platform;
        }
      }

      const titleSuffix = item._relation_mark ? ` ${item._relation_mark}` : "";
      
      return {
        id: item.id,
        name: item.name,
        name_cn: (item.name_cn || item.name) + titleSuffix,
        images: item.images,
        air_date: item.date, 
        score: item.score,
        typeDescription: typeDesc
      };
    });
  }

  /**
   * 获取剧集列表
   * @param {number} subjectId 条目 ID
   * @returns {Promise<Array>} 剧集数组
   */
  async getEpisodes(subjectId) {
    try {
      const resp = await httpGet(`https://api.bgm.tv/v0/episodes?subject_id=${subjectId}`, {
        headers: this.headers,
      });

      if (!resp || !resp.data) {
        log("info", `[Animeko] Subject ${subjectId} 无剧集数据`);
        return [];
      }

      const body = resp.data;
      if (Array.isArray(body.data)) return body.data;
      
      return [];
    } catch (error) {
      log("error", "[Animeko] GetEpisodes error:", {
        message: error.message,
        id: subjectId
      });
      return [];
    }
  }

  /**
   * 处理并存储番剧及剧集信息
   * @param {Array} sourceAnimes 搜索到的番剧列表
   * @param {string} queryTitle 原始查询标题
   * @param {Array} curAnimes 当前缓存的番剧列表
   */
  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      if (sourceAnimes) log("error", "[Animeko] sourceAnimes is not a valid array");
      return [];
    }

    const processAnimekoAnimes = await Promise.all(sourceAnimes.map(async (anime) => {
        try {
          const eps = await this.getEpisodes(anime.id);
          let links = [];
          
          let effectiveStartDate = anime.air_date || "";

          if (Array.isArray(eps)) {
            eps.sort((a, b) => (a.sort || 0) - (b.sort || 0));

            for (const ep of eps) {
              if (ep.type !== 0) continue; // 仅保留本篇

              if (!effectiveStartDate && ep.airdate) {
                effectiveStartDate = ep.airdate;
              }

              const epNum = ep.sort || ep.ep; 
              const epName = ep.name_cn || ep.name || "";
              const fullTitle = `EP${epNum} ${epName}`.trim();
              
              links.push({
                "name": `${epNum}`, 
                "url": ep.id.toString(), 
                "title": `【animeko】 ${fullTitle}` 
              });
            }
          }

          if (links.length > 0) {
            const yearStr = effectiveStartDate ? new Date(effectiveStartDate).getFullYear() : "";

            let transformedAnime = {
              animeId: anime.id,
              bangumiId: String(anime.id),
              animeTitle: `${anime.name_cn || anime.name}(${yearStr})【${anime.typeDescription || '动漫'}】from animeko`,
              type: "动漫",
              typeDescription: anime.typeDescription || "动漫",
              imageUrl: anime.images ? (anime.images.common || anime.images.large) : "",
              startDate: effectiveStartDate, 
              episodeCount: links.length,
              rating: anime.score || 0,
              isFavorited: true,
              source: "animeko",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});

            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[Animeko] Error processing anime ${anime.id}: ${error.message}`);
        }
      })
    );

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);
    return processAnimekoAnimes;
  }

  /**
   * 获取完整弹幕列表
   * 支持传入纯数字ID或完整URL
   * @param {string} episodeId 剧集 ID 或 完整 API URL
   * @returns {Promise<Array>} 弹幕数组
   */
  async getEpisodeDanmu(episodeId) {
    try {
      // 兼容分片请求传递过来的完整 URL
      const url = episodeId.startsWith('http') 
        ? episodeId 
        : `https://danmaku-global.myani.org/v1/danmaku/${episodeId}`;
        // 目前使用的服务器是全球区域的，备用大陆区域：https://danmaku-cn.myani.org

      const resp = await httpGet(url, { headers: this.headers });

      if (!resp || !resp.data) return [];
      const body = resp.data;
      if (body.danmakuList) return body.danmakuList;
      return [];
    } catch (error) {
      log("error", "[Animeko] GetDanmu error:", { message: error.message, url: episodeId });
      return [];
    }
  }

  /**
   * 获取分段弹幕列表定义
   * 使用完整的 API URL 填充 url 字段，以通过 format 校验
   */
  async getEpisodeDanmuSegments(id) {
    return new SegmentListResponse({
      "type": "animeko",
      "segmentList": [{
        "type": "animeko",
        "segment_start": 0,
        "segment_end": 30000, 
        "url": `https://danmaku-global.myani.org/v1/danmaku/${id}` // 使用完整 URL
      }]
    });
  }

  /**
   * 获取具体分片的弹幕数据
   * 标准实现：返回原始数据，格式化交由父类统一处理
   */
  async getEpisodeSegmentDanmu(segment) {
    // 增加 trim 防止 URL 意外空格
    const url = (segment.url || '').trim();
    if (!url) return [];
    
    // 返回原始数据
    return this.getEpisodeDanmu(url);
  }

  /**
   * 格式化弹幕为标准格式
   * @param {Array} comments 原始弹幕数据
   * @returns {Array} 格式化后的弹幕
   */
  formatComments(comments) {
    if (!Array.isArray(comments)) return [];
    const locationMap = { "NORMAL": 1, "TOP": 5, "BOTTOM": 4 };
    
    return comments
      .filter(item => item && item.danmakuInfo)
      .map(item => {
        const info = item.danmakuInfo;
        const time = (Number(info.playTime) / 1000).toFixed(2);
        const mode = locationMap[info.location] || 1;
        const color = info.color === -1 ? 16777215 : info.color;
        const text = globals.danmuSimplified ? simplized(info.text) : info.text;

        return {
          cid: item.id,
          p: `${time},${mode},${color},[animeko]`, 
          m: text
        };
      });
  }
}
