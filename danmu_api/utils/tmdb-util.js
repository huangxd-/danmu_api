import { globals } from '../configs/globals.js';
import { log } from './log-util.js'
import { httpGet } from "./http-util.js";
import { isNonChinese } from "./zh-util.js";

// ---------------------
// TMDB API 工具方法
// ---------------------

// 全局任务队列，用于管理并发请求的合并与中断
// Key: title, Value: { promise, controller, refCount }
const TMDB_PENDING = new Map();

// TMDB API 请求基础函数
async function tmdbApiGet(url, options = {}) {
  const tmdbApi = "https://api.tmdb.org/3/";
  const tartgetUrl = `${tmdbApi}${url}`;
  // 修改：使用统一的代理 URL 构建方法
  const nextUrl = globals.makeProxyUrl(tartgetUrl);

  try {
    const response = await httpGet(nextUrl, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      },
      signal: options.signal // 透传中断信号
    });
    if (response.status != 200) return null;

    return response;
  } catch (error) {
    // 如果是中断信号，抛出以供上层处理
    if (error.name === 'AbortError') {
       throw error;
    }
    log("error", "[TMDB] Api error:", {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    return null;
  }
}

// 使用 TMDB API 查询片名
export async function searchTmdbTitles(title, mediaType = "multi", options = {}) {
  const {
    page = 1,          // 起始页码
    maxPages = 3,      // 最多获取几页结果
    signal = null      // 中断信号
  } = options;
  
  // 如果指定了具体页码，只获取单页
  if (options.page !== undefined) {
    const url = `search/${mediaType}?api_key=${globals.tmdbApiKey}&query=${encodeURIComponent(title)}&language=zh-CN&page=${page}`;
    return await tmdbApiGet(url, { signal });
  }
  
  // 默认获取多页合并结果
  const allResults = [];
  
  for (let currentPage = 1; currentPage <= maxPages; currentPage++) {
    // 检查是否中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    
    const url = `search/${mediaType}?api_key=${globals.tmdbApiKey}&query=${encodeURIComponent(title)}&language=zh-CN&page=${currentPage}`;
    const response = await tmdbApiGet(url, { signal });
    
    if (!response || !response.data) {
      break;
    }
    
    const data = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    
    if (!data.results || data.results.length === 0) {
      break;
    }
    
    allResults.push(...data.results);
    
    // 如果当前页结果少于20条，说明没有更多结果了
    if (data.results.length < 20) {
      break;
    }
  }
  
  log("info", `[TMDB] 共获取到 ${allResults.length} 条搜索结果（最多${maxPages}页）`);
  
  // 返回与原格式兼容的结构
  return {
    data: {
      results: allResults
    },
    status: 200
  };
}

// 使用 TMDB API 获取日语详情
export async function getTmdbJpDetail(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}?api_key=${globals.tmdbApiKey}&language=ja-JP`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取external_ids
export async function getTmdbExternalIds(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/external_ids?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 使用 TMDB API 获取别名
async function getTmdbAlternativeTitles(mediaType, tmdbId, options = {}) {
  const url = `${mediaType}/${tmdbId}/alternative_titles?api_key=${globals.tmdbApiKey}`;
  return await tmdbApiGet(url, options);
}

// 从别名中提取中文别名相关函数
function extractChineseTitleFromAlternatives(altData, mediaType) {
  if (!altData || !altData.data) return null;
  
  // TV 剧集的别名在 results 字段，电影在 titles 字段
  const titles = altData.data.results || altData.data.titles || [];
  
  if (!Array.isArray(titles) || titles.length === 0) {
    return null;
  }
  
  // 优先级：CN（中国大陆）> TW（台湾）> HK（香港）> SG（新加坡）
  const priorityRegions = ['CN', 'TW', 'HK', 'SG'];
  
  for (const region of priorityRegions) {
    const match = titles.find(t => {
      const iso = t.iso_3166_1 || t.iso_639_1;
      const title = t.title || t.name || "";
      return iso === region && title && !isNonChinese(title);
    });
    
    if (match) {
      const chineseTitle = match.title || match.name;
      log("info", `[TMDB] 从别名中找到中文标题 (${region}): ${chineseTitle}`);
      return chineseTitle;
    }
  }
  
  // 如果没有找到指定地区的，查找任何包含中文的别名
  const anyChineseTitle = titles.find(t => {
    const title = t.title || t.name || "";
    return title && !isNonChinese(title);
  });
  
  if (anyChineseTitle) {
    const title = anyChineseTitle.title || anyChineseTitle.name;
    log("info", `[TMDB] 从别名中找到中文标题 (其他地区): ${title}`);
    return title;
  }
  
  return null;
}

// 别名获取判断相关函数
async function getChineseTitleForResult(result, signal) {
  const resultTitle = result.name || result.title || "";
  
  // 如果已经是中文标题，直接返回
  if (!isNonChinese(resultTitle)) {
    return resultTitle;
  }
  
  // 非中文标题，尝试获取中文别名
  log("info", `[TMDB] 检测到非中文标题 "${resultTitle}", 尝试获取中文别名`);
  
  const mediaType = result.media_type || (result.name ? "tv" : "movie");
  
  try {
    // 在发起别名请求前检查是否已中断
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    
    const altResp = await getTmdbAlternativeTitles(mediaType, result.id, { signal });
    
    // 别名请求返回后再次检查（请求期间可能被中断）
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    
    const chineseTitle = extractChineseTitleFromAlternatives(altResp, mediaType);
    
    if (chineseTitle) {
      log("info", `[TMDB] 将使用中文别名进行相似匹配: ${chineseTitle}`);
      return chineseTitle;
    } else {
      log("info", `[TMDB] 未找到中文别名，使用原标题: ${resultTitle}`);
      return resultTitle;
    }
  } catch (error) {
    // 遇到中断信号直接抛出
    if (error.name === 'AbortError') {
      throw error;
    }
    log("error", `[TMDB] 获取别名失败: ${error.message}`);
    return resultTitle; // 失败则返回原标题
  }
}

// 使用TMDB API 查询日语原名，支持请求合并与引用计数控制
export async function getTmdbJaOriginalTitle(title, signal = null, sourceLabel = 'Unknown') {
  if (!globals.tmdbApiKey) {
    log("info", "[TMDB] 未配置API密钥，跳过TMDB搜索");
    return null;
  }

  // 检查是否已有相同关键词的搜索任务正在进行
  let task = TMDB_PENDING.get(title);

  if (!task) {
    // 创建一个新的控制器，用于控制真正的后台网络请求
    const masterController = new AbortController();
    
    // 定义搜索核心逻辑
    const executeSearch = async () => {
      try {
        const backgroundSignal = masterController.signal;

        // 内部函数：判断单个媒体是否为动画或日语内容
        const isValidContent = (mediaInfo) => {
          const genreIds = mediaInfo.genre_ids || [];
          const genres = mediaInfo.genres || [];
          const allGenreIds = genreIds.length > 0 ? genreIds : genres.map(g => g.id);
          const originalLanguage = mediaInfo.original_language || '';
          const ANIMATION_GENRE_ID = 16;
          
          // 动画类型直接通过
          if (allGenreIds.includes(ANIMATION_GENRE_ID)) {
            return { isValid: true, reason: "明确动画类型(genre_id: 16)" };
          }
          
          // 日语内容通过（涵盖日剧、日影、日综艺）
          if (originalLanguage === 'ja') {
            return { isValid: true, reason: `原始语言为日语(ja),可能是日剧/日影/日综艺` };
          }
          
          return { 
            isValid: false, 
            reason: `非动画且非日语内容(language: ${originalLanguage}, genres: ${allGenreIds.join(',')})` 
          };
        };

        // 内部函数：批量验证搜索结果
        const validateResults = (results) => {
          if (!results || results.length === 0) {
            return { 
              hasValid: false, 
              validCount: 0, 
              totalCount: 0, 
              details: "搜索结果为空" 
            };
          }
          
          let validCount = 0;
          const validItems = [];
          
          for (const item of results) {
            const validation = isValidContent(item);
            if (validation.isValid) {
              validCount++;
              const itemTitle = item.name || item.title || "未知";
              validItems.push(`${itemTitle}(${validation.reason})`);
            }
          }
          
          return {
            hasValid: validCount > 0,
            validCount: validCount,
            totalCount: results.length,
            details: validCount > 0 
              ? `找到${validCount}个符合条件的内容: ${validItems.slice(0, 3).join(', ')}${validCount > 3 ? '...' : ''}`
              : `所有${results.length}个结果均不符合条件(非动画且非日语)`
          };
        };

        // 相似度计算函数
        const similarity = (s1, s2) => {
          // 标准化处理
          const normalize = (str) => {
            return str.toLowerCase()
              .replace(/\s+/g, '')
              .replace(/[：:、，。！？；""''（）【】《》]/g, '')
              .trim();
          };
          
          const n1 = normalize(s1);
          const n2 = normalize(s2);
          
          // 完全匹配
          if (n1 === n2) return 1.0;
          
          // 包含关系检查
          const shorter = n1.length < n2.length ? n1 : n2;
          const longer = n1.length >= n2.length ? n1 : n2;
          
          if (longer.includes(shorter) && shorter.length > 0) {
            // 如果有连词则得到一定加分
            const lengthRatio = shorter.length / longer.length;
            return 0.6 + (lengthRatio * 0.30);
          }
          
          // 编辑距离计算
          const longer2 = s1.length > s2.length ? s1 : s2;
          const shorter2 = s1.length > s2.length ? s2 : s1;
          if (longer2.length === 0) return 1.0;
          
          const editDistance = (str1, str2) => {
            str1 = str1.toLowerCase();
            str2 = str2.toLowerCase();
            const costs = [];
            for (let i = 0; i <= str1.length; i++) {
              let lastValue = i;
              for (let j = 0; j <= str2.length; j++) {
                if (i === 0) {
                  costs[j] = j;
                } else if (j > 0) {
                  let newValue = costs[j - 1];
                  if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                  }
                  costs[j - 1] = lastValue;
                  lastValue = newValue;
                }
              }
              if (i > 0) costs[str2.length] = lastValue;
            }
            return costs[str2.length];
          };
          
          return (longer2.length - editDistance(longer2, shorter2)) / longer2.length;
        };

        // 第一步：TMDB搜索
        log("info", `[TMDB] 正在搜索 (Shared Task): ${title}`);
        
        // 检查 masterController 是否已被中断
        if (backgroundSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        const respZh = await searchTmdbTitles(title, "multi", { signal: backgroundSignal });
        
        if (!respZh || !respZh.data) {
          log("info", "[TMDB] TMDB搜索结果为空");
          return null;
        }

        const dataZh = typeof respZh.data === "string" ? JSON.parse(respZh.data) : respZh.data;

        if (!dataZh.results || dataZh.results.length === 0) {
          log("info", "[TMDB] TMDB未找到任何结果");
          return null;
        }

        // 第二步：类型验证（宽松策略：只要有一个符合就继续）
        const validationResult = validateResults(dataZh.results);
        
        if (!validationResult.hasValid) {
          log("info", `[TMDB] 类型判断未通过,跳过后续搜索: ${validationResult.details}`);
          return null;
        }
        
        log("info", `[TMDB] 类型判断通过: ${validationResult.details}`);

        // 第三步：找到最相似的结果
        let bestMatch = null;
        let bestScore = -1;
        let bestMatchChineseTitle = null;
        let alternativeTitleFetchCount = 0; // 别名获取计数器
        const MAX_ALTERNATIVE_FETCHES = 5; // 最多获取5个别名
        let skipAlternativeFetch = false; // 是否跳过后续别名获取

        for (const result of dataZh.results) {
          const resultTitle = result.name || result.title || "";
          if (!resultTitle) continue;
          
          // 先计算原标题的相似度
          const directScore = similarity(title, resultTitle);
          const originalTitle = result.original_name || result.original_title || "";
          const originalScore = originalTitle ? similarity(title, originalTitle) : 0;
          const initialScore = Math.max(directScore, originalScore);
          
          // 如果原标题已经100%匹配，标记跳过后续所有别名搜索
          if (initialScore === 1.0 && !skipAlternativeFetch) {
            skipAlternativeFetch = true;
            log("info", `[TMDB] 匹配检查 "${resultTitle}" - 相似度: 100.00% (完全匹配，跳过后续所有别名搜索)`);
            if (initialScore > bestScore) {
              bestScore = initialScore;
              bestMatch = result;
              bestMatchChineseTitle = resultTitle;
            }
            continue;
          }
          
          // 获取可用的中文标题
          let chineseTitle;
          let finalScore;
          
          // 如果已经找到100%匹配或已是中文，直接使用原标题不获取别名
          if (skipAlternativeFetch || !isNonChinese(resultTitle)) {
            chineseTitle = resultTitle;
            finalScore = initialScore;
            
            if (skipAlternativeFetch && isNonChinese(resultTitle)) {
              log("info", `[TMDB] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}% (已找到完全匹配，跳过别名搜索)`);
            } else {
              log("info", `[TMDB] 匹配检查 "${resultTitle}" - 相似度: ${(finalScore * 100).toFixed(2)}%`);
            }
          } else {
            // 非中文且未达到别名获取上限，尝试获取别名
            if (alternativeTitleFetchCount < MAX_ALTERNATIVE_FETCHES) {
              try {
                // 使用 backgroundSignal
                chineseTitle = await getChineseTitleForResult(result, backgroundSignal);
                if (chineseTitle !== resultTitle) {
                  alternativeTitleFetchCount++;
                }
              } catch (error) {
                // 如果是中断错误，抛出
                if (error.name === 'AbortError') throw error;
                log("error", `[TMDB] 处理结果失败: ${error.message}`);
                chineseTitle = resultTitle;
              }
            } else {
              chineseTitle = resultTitle;
              log("info", `[TMDB] 已达到别名获取上限(${MAX_ALTERNATIVE_FETCHES})，使用原标题: ${resultTitle}`);
            }
            
            const finalDirectScore = similarity(title, chineseTitle);
            finalScore = Math.max(finalDirectScore, originalScore);
            
            const displayInfo = chineseTitle !== resultTitle 
              ? `"${resultTitle}" (别名: ${chineseTitle})` 
              : `"${resultTitle}"`;
            log("info", `[TMDB] 匹配检查 ${displayInfo} - 相似度: ${(finalScore * 100).toFixed(2)}%`);
            
            if (finalScore === 1.0 && !skipAlternativeFetch) {
              skipAlternativeFetch = true;
              log("info", `[TMDB] 通过别名找到完全匹配，跳过后续所有别名搜索`);
            }
          }
          
          if (finalScore > bestScore) {
            bestScore = finalScore;
            bestMatch = result;
            bestMatchChineseTitle = chineseTitle;
          }
        }

        const MIN_SIMILARITY = 0.2;
        if (!bestMatch || bestScore < MIN_SIMILARITY) {
          log("info", `[TMDB] 最佳匹配相似度过低或未找到匹配 (${bestMatch ? (bestScore * 100).toFixed(2) + '%' : 'N/A'}),跳过`);
          return null;
        }

        log("info", `[TMDB] TMDB最佳匹配: ${bestMatchChineseTitle}, 相似度: ${(bestScore * 100).toFixed(2)}%`);

        // 第四步：获取日语详情
        const mediaType = bestMatch.media_type || (bestMatch.name ? "tv" : "movie");

        const detailResp = await getTmdbJpDetail(mediaType, bestMatch.id, { signal: backgroundSignal });

        if (!detailResp || !detailResp.data) {
          const fallbackTitle = bestMatch.name || bestMatch.title;
          log("info", `[TMDB] 使用中文搜索结果标题: ${fallbackTitle}`);
          return fallbackTitle;
        }

        const detail = typeof detailResp.data === "string" ? JSON.parse(detailResp.data) : detailResp.data;

        const jaOriginalTitle = detail.original_name || detail.original_title || detail.name || detail.title;
        log("info", `[TMDB] 找到日语原名: ${jaOriginalTitle}`);

        return jaOriginalTitle;

      } catch (error) {
         if (error.name === 'AbortError') {
             log("info", `[TMDB] 后台搜索任务已完全终止 (${title})`);
             throw error;
         }
         log("error", "[TMDB] Background Search error:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
         });
         return null;
      }
    };

    // 初始化任务结构
    task = {
      controller: masterController,
      refCount: 0,
      promise: executeSearch().finally(() => {
        // 无论成功失败，移除 Map 记录
        TMDB_PENDING.delete(title);
      })
    };
    
    TMDB_PENDING.set(title, task);
    log("info", `[TMDB] 启动新搜索任务: ${title}`);
  } else {
    log("info", `[TMDB] 加入正在进行的搜索: ${title} (${sourceLabel})`);
  }

  // 增加引用计数
  task.refCount++;

  // 定义退出任务的逻辑
  const leaveTask = () => {
    // 再次获取任务确认其仍存在
    const currentTask = TMDB_PENDING.get(title);
    if (currentTask === task) {
        task.refCount--;
        if (task.refCount <= 0) {
            log("info", `[TMDB] 所有调用者已取消，终止后台请求: ${title}`);
            task.controller.abort();
        }
    }
  };

  // 处理用户中断监听
  if (signal) {
    if (signal.aborted) {
        leaveTask();
        log("info", `[TMDB] 搜索已被中断 (Source: ${sourceLabel})`);
        return null;
    }
    signal.addEventListener('abort', leaveTask, { once: true });
  }

  // 使用 Race 机制等待结果或用户中断
  try {
    const userAbortPromise = new Promise((_, reject) => {
        if (signal) {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }
    });

    return await Promise.race([task.promise, userAbortPromise]);

  } catch (error) {
    if (error.name === 'AbortError') {
      log("info", `[TMDB] 搜索已被中断 (Source: ${sourceLabel})`);
      return null;
    }
    log("error", `[TMDB] 搜索异常: ${error.message}`);
    return null;
  }
}

/**
 * 查询 TMDB 获取中文标题
 * @param {string} title - 标题
 * @param {number|string} season - 季数（可选）
 * @param {number|string} episode - 集数（可选）
 * @returns {Promise<string>} 返回中文标题，如果查询失败则返回原标题
 */
export async function getTMDBChineseTitle(title, season = null, episode = null) {
  // 如果包含中文，直接返回原标题
  if (!isNonChinese(title)) {
    return title;
  }

  // 判断是电影还是电视剧
  const isTV = season !== null && season !== undefined;
  const mediaType = isTV ? 'tv' : 'movie';

  try {
    // 搜索媒体内容
    const searchResponse = await searchTmdbTitles(title, mediaType);

    // 检查是否有结果
    if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
      log("info", '[TMDB] TMDB未找到任何结果');
      return title;
    }

    // 获取第一个匹配结果的 ID
    // 查找第一个 name/title 包含中文的结果
    const firstResult = searchResponse.data.results.find(result => {
      const resultName = isTV ? result.name : result.title;
      return resultName && !isNonChinese(resultName);
    });

    // 如果没有找到包含中文的结果，使用第一个结果
    const selectedResult = firstResult || searchResponse.data.results[0];

    // 电视剧使用 name 字段，电影使用 title 字段
    const chineseTitle = isTV ? selectedResult.name : selectedResult.title;

    // 如果有中文标题则返回，否则返回原标题
    if (chineseTitle) {
      log("info", `原标题: ${title} -> 中文标题: ${chineseTitle}`);
      return chineseTitle;
    } else {
      return title;
    }

  } catch (error) {
    log("error", '查询 TMDB 时出错:', error);
    return title;
  }
}
