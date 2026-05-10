import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { titleMatches, normalizeSpaces, getExplicitSeasonNumber, extractSeasonNumberFromAnimeTitle } from './common-util.js';
import { simplized, traditionalized } from './zh-util.js';

// =====================
// Bangumi Data 管理工具（https://github.com/bangumi-data/bangumi-data）
// =====================

let memoryCache = null;
let memoryCacheTime = 0;
let isDownloading = false;
let downloadLockTime = 0;
let memoryFootprintMB = '0.00';
let hasLoggedCacheWarning = false;
let charInvertedIndex = new Map();

// 定义缓存目录/文件名
const CACHE_DIR = path.join(process.cwd(), '.cache');
const CACHE_FILENAME = 'bangumi-data-cache.json';
const DOWNLOAD_TIMEOUT_MS = 20000;
const queryCache = new Map();

// 预编译全局正则表达式
const VALID_DUB_REGEX = /(?:普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽]|日[语語]|日配|原版|原[声聲])(?:版)?/;
const SUFFIX_CLEAN_REGEX = /(?:\s+|^)(?:第?\s*(?:\d+|[一二三四五六七八九十]+)\s*[季期部]|season\s*\d+|s\d+|part\s*\d+|act\s*\d+|phase\s*\d+|the\s+final\s+season|(?:movie|film|ova|oad|sp|剧场版|劇場版|续[篇集]|外传)(?![a-z]))|[:：~～]|\s+.*?篇|(?<=\s|^)\d+$/gi;
const WHITESPACE_REGEX = /\s+/g;
const COMMA_SPLIT_REGEX = /[,，]/;
const COLON_SPLIT_REGEX = /[:：]/;

/**
 * 构建内存级倒排特征索引字典
 * 提取每个条目的指纹字符，映射至该字符关联的条目数组序号中
 * @param {Array<Object>} items - 已精简的条目数组
 */
function buildInvertedIndex(items) {
    const newCharIndex = new Map();
    const len = items.length;

    for (let i = 0; i < len; i++) {
        const flatText = items[i]._flatText;
        if (!flatText) continue;

        const uniqueChars = new Set(flatText);
        for (const char of uniqueChars) {
            if (char.trim() === '') continue; 

            let idArray = newCharIndex.get(char);
            if (!idArray) {
                idArray = []; 
                newCharIndex.set(char, idArray);
            }
            idArray.push(i);
        }
    }

    charInvertedIndex = newCharIndex;
}

/**
 * 初始化 Bangumi Data 数据源
 * 包含内存与磁盘双端缓存的生命周期校验，并在环境允许时持久化缓存数据
 * 若目录未挂载，则自动退化为纯内存模式
 * @param {string} deployPlatform - 部署平台类型 (如 'node', 'vercel', 'netlify')
 * @param {boolean} isDataDependentRequest - 当前是否为强依赖数据的核心接口请求
 * @returns {Promise<void>}
 */
export async function initBangumiData(deployPlatform, isDataDependentRequest = false, ctx = null) {
    if (!globals.useBangumiData) return;

    let cachePath = null;
    const cacheDays = globals.bangumiDataCacheDays !== undefined ? globals.bangumiDataCacheDays : 7;
    const expireMs = cacheDays * 24 * 60 * 60 * 1000;

    if (deployPlatform === 'node') {
        if (fs.existsSync(CACHE_DIR)) {
            cachePath = path.join(CACHE_DIR, CACHE_FILENAME);
        } else if (!hasLoggedCacheWarning) {
            log("warn", "[Bangumi-Data] 未检测到根目录的 .cache 文件夹！");
            log("warn", "[Bangumi-Data] 按照项目规范，请手动挂载或创建 .cache 目录以启用持久化。");
            log("warn", "[Bangumi-Data] 本次运行已退化为纯内存模式 (重启后需重新下载)。");
            hasLoggedCacheWarning = true;
        }
    } else if (!hasLoggedCacheWarning) {
        log("info", `[Bangumi-Data] 检测到 ${deployPlatform} 云环境，当前运行于纯内存加速模式。`);
        hasLoggedCacheWarning = true;
    }

    // 幽灵死锁自愈机制 (针对 Serverless 强杀)
    if (isDownloading && (Date.now() - downloadLockTime > DOWNLOAD_TIMEOUT_MS)) {
        log("warn", "[Bangumi-Data] 检测到下载状态锁死 (由于 Serverless 进程休眠/强杀导致)，强制释放锁...");
        isDownloading = false;
    }

    // 内存数据生命周期校验
    if (memoryCache) {
        if (cacheDays > 0 && (Date.now() - memoryCacheTime < expireMs)) {
            return;
        }

        // 当内存过期或配置强制更新时，仅在核心请求触发后台静默更新
        if (isDataDependentRequest && !isDownloading) {
            log("info", `[Bangumi-Data] 内存数据${cacheDays === 0 ? '强制更新' : '已过期'}，保留老数据服务本次请求，启动后台静默更新...`);
            isDownloading = true;
            downloadLockTime = Date.now();
            downloadAndCache(cachePath).finally(() => { isDownloading = false; });
        }
        return;
    }

    // 磁盘数据生命周期校验
    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const stats = fs.statSync(cachePath);
            const memBefore = process.memoryUsage().heapUsed;
            const startTime = Date.now(); 

            memoryCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));

            // 兼容旧版缓存：静默热升级，应用预处理规则生成特征指纹并更新磁盘文件
            if (memoryCache?.items?.length > 0 && memoryCache.items[0]._flatText === undefined) {
                memoryCache = pruneBangumiData(memoryCache);
                fs.writeFileSync(cachePath, JSON.stringify(memoryCache), 'utf-8');
				buildInvertedIndex(memoryCache.items);
            } else if (memoryCache?.items?.length > 0) {
                // 内存读取流程：倒排索引结构非持久化存储，需依据内存数据触发重建
                buildInvertedIndex(memoryCache.items);
            }

            const memAfter = process.memoryUsage().heapUsed;
            const loadTimeMs = Date.now() - startTime; 
            memoryFootprintMB = Math.max(0, (memAfter - memBefore) / 1024 / 1024).toFixed(2);
            const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
            memoryCacheTime = Date.now(); 

            log("info", `[Bangumi-Data] 成功从本地磁盘加载基础数据，条目数: ${memoryCache.items.length}，解析耗时: ${loadTimeMs} ms，约占内存: ${memoryFootprintMB} MB`);

            if (cacheDays === 0 || (Date.now() - stats.mtimeMs >= expireMs)) {
                if (isDataDependentRequest && !isDownloading) {
                    log("info", `[Bangumi-Data] 磁盘数据${cacheDays === 0 ? '强制更新' : '已过期'}，保留老数据服务本次请求，启动后台静默更新...`);
                    isDownloading = true;
                    downloadLockTime = Date.now();
                    downloadAndCache(cachePath).finally(() => { isDownloading = false; });
                }
            }
            return;
        } catch (e) {
            log("error", "[Bangumi-Data] 磁盘缓存解析失败，准备重新下载", e.message);
            memoryCache = null; 
        }
    }

    // 内存与磁盘均无有效数据时的获取逻辑
    if (!isDownloading) {
        log("info", `[Bangumi-Data] 未命中任何有效缓存，正在获取基础数据...`);
        isDownloading = true;
        downloadLockTime = Date.now();

        const downloadPromise = downloadAndCache(cachePath).finally(() => { isDownloading = false; });

        if (isDataDependentRequest) {
            await downloadPromise; 
        } else {
            log("info", `[Bangumi-Data] 当前非核心请求，数据获取转入后台异步执行`);
            if (ctx && typeof ctx.waitUntil === 'function') {
                log("info", `[Bangumi-Data] 调用 ctx.waitUntil 延长 Serverless 生命周期`);
                ctx.waitUntil(downloadPromise);
            }
        }
    } else if (isDataDependentRequest) {
        log("info", `[Bangumi-Data] 正在等待基础数据下载完成...`);
        let waitCount = 0;
        while (isDownloading) {
            if (waitCount > 150) { // 最多等待 15 秒 (150 * 100ms)
                log("warn", "[Bangumi-Data] 等待排队超时，放弃等待");
                isDownloading = false;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            waitCount++;
        }
    }
}

// 支持检索的有效站点标识集合
const ALLOWED_SITES = new Set([
    'anidb', 'bangumi', 'gamer', 'gamer_hk', 
    'bilibili', 'bilibili_hk_mo_tw', 'bilibili_hk_mo', 'bilibili_tw', 'tmdb'
]);

/**
 * 精简 Bangumi Data 数据结构
 * 提取检索与渲染必需的字段，过滤无关站点，并在此时提取倒排特征文本
 * 预处理后的数据会随主流程落盘，消除运行时的冷启动开销
 * @param {Object} rawData - 原始完整版 Bangumi Data JSON 对象
 * @returns {Object} 包含精简后 items 数组的对象
 */
function pruneBangumiData(rawData) {
    if (!rawData || !rawData.items) return { items: [] };

    const prunedItems = [];

    for (const item of rawData.items) {
        // 筛选当前条目下属于允许列表的站点信息
        const validSites = [];
        if (item.sites) {
            for (const s of item.sites) {
                if (ALLOWED_SITES.has(s.site)) {
                    const prunedSite = { site: s.site, id: s.id };
                    if (s.comment) prunedSite.comment = s.comment;
                    validSites.push(prunedSite);
                }
            }
        }

        // 丢弃不包含任何目标站点的条目，避免占用内存
        if (validSites.length === 0) continue;

        // 构建精简版条目，保留核心数据
        const prunedItem = {
            title: item.title,
            type: item.type,
            sites: validSites
        };
        if (item.begin) prunedItem.begin = item.begin;
        if (item.titleTranslate) prunedItem.titleTranslate = item.titleTranslate;

        // 构建聚合特征指纹：合并所有标题，强制转换为简体，并进行统一字符集规范化及小写转换
        let str = item.title;
        if (item.titleTranslate) {
            for (const lang in item.titleTranslate) {
                const transArr = item.titleTranslate[lang];
                for (let j = 0; j < transArr.length; j++) {
                    str += transArr[j];
                }
            }
        }

        const normalizedStr = simplized(str);
        prunedItem._flatText = normalizeSpaces(normalizedStr).toLowerCase().replace(SUFFIX_CLEAN_REGEX, '');
        prunedItems.push(prunedItem);
    }

    return { items: prunedItems };
}

/**
 * 下载并缓存最新版本的 Bangumi Data
 * 支持多节点并发竞速流式下载写入磁盘或直接解析到内存，并记录细粒度性能指标
 * @param {string|null} cachePath - 缓存文件写入路径，为 null 时仅加载到内存
 * @returns {Promise<void>}
 */
async function downloadAndCache(cachePath) {
    log("info", "[Bangumi-Data] 开始优选节点下载最新数据并执行精简...");
    try {
        const memBefore = process.memoryUsage().heapUsed;
        const startTime = Date.now(); 

        let parseTimeMs = 0;

        // 备选 CDN 节点列表
        const CDNS = [
            "https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json",
            "https://unpkg.com/bangumi-data@0.3/dist/data.json"
        ];

        // 声明压缩头，提升传输效率
        const fetchOptions = {
            headers: {
                'Accept-Encoding': 'br, gzip, deflate'
            }
        };

        // 为每个请求分配独立的终止控制器
        const controllers = CDNS.map(() => new AbortController());

        CDNS.forEach(url => {
            log("info", `[请求模拟] HTTP GET: ${url}`);
        });

        // 构建完整下载任务的 Promise 数组
        const racePromises = CDNS.map(async (url, index) => {
            const controller = controllers[index];

            const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP error ${response.status} from ${url}`);

            // 获取并解析完整的 JSON 数据
            const resultData = await response.json();
            const originalCount = resultData.items ? resultData.items.length : 0;

            if (controller.signal.aborted) throw new Error('Aborted before parsing');

            // 立即执行数据裁剪以释放内存
            const localParseStartTime = Date.now();
            const prunedData = pruneBangumiData(resultData);
            const pruneCost = Date.now() - localParseStartTime;

            let tempFilePath = null;

            if (cachePath && !controller.signal.aborted) {
                // 物理磁盘模式：为每个并发流生成独立的临时文件，写入精简后的数据
                tempFilePath = `${cachePath}.tmp${index}`;
                fs.writeFileSync(tempFilePath, JSON.stringify(prunedData), 'utf-8');
            }

            // 返回胜出者所需的所有上下文信息
            return { index, url, tempFilePath, resultData: prunedData, pruneCost, originalCount };
        });

        // Promise.any 会等待第一个完全执行完毕的 Promise
        const winner = await Promise.any(racePromises);

        // 首个下载完成后，立刻中断所有落后者的网络请求
        controllers.forEach((ctrl, i) => {
            if (i !== winner.index) {
                ctrl.abort(); 
            }
        });

        // 清理落后者的临时文件，避免占用磁盘空间
        if (cachePath) {
            CDNS.forEach((_, i) => {
                if (i !== winner.index) {
                    const loserTempPath = `${cachePath}.tmp${i}`;
                    if (fs.existsSync(loserTempPath)) {
                        try { fs.unlinkSync(loserTempPath); } catch (e) {}
                    }
                }
            });

            // 将胜出者的临时文件正式重命名为缓存文件
            fs.renameSync(winner.tempFilePath, cachePath); 
        }

        const downloadTime = ((Date.now() - startTime) / 1000).toFixed(2);
        log("info", `[Bangumi-Data] 精简数据已成功写入磁盘 (节点: ${new URL(winner.url).hostname} ,阶段耗时: ${downloadTime} 秒)`);

        // 数据处理流
        memoryCache = winner.resultData;
        parseTimeMs = winner.pruneCost;
		buildInvertedIndex(memoryCache.items);
        queryCache.clear();

        const memAfter = process.memoryUsage().heapUsed;
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2); 

        memoryFootprintMB = Math.max(0, (memAfter - memBefore) / 1024 / 1024).toFixed(2);
        const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        memoryCacheTime = Date.now();

        log("info", `[Bangumi-Data] 加载到内存成功，保留/原始条目数: ${memoryCache.items.length} / ${winner.originalCount}，处理耗时: ${parseTimeMs} ms，全链路总耗时: ${totalTime} 秒，净增内存: ${memoryFootprintMB} MB (当前项目总占用: ${totalMemMB} MB)`);
    } catch (e) {
        // 提取所有请求均失败时的具体错误信息
        const errorMessage = e instanceof AggregateError ? e.errors.map(err => err.message).join(' | ') : e.message;
        log("error", "[Bangumi-Data] 下载失败 (所有 CDN 均未响应或报错):", errorMessage);
    }
}

/**
 * 在 Bangumi Data 中搜索匹配的动漫条目
 * 采用倒排索引结合特征词清洗逻辑进行初筛，随后执行精准匹配
 * 支持多语言标题检索、特定站点过滤以及配音/区域版本解析
 * @param {string} keyword - 搜索关键词
 * @param {Array<string>} siteKeys - 需要匹配的源站点标识数组
 * @returns {Array<Object>} 匹配的动漫条目数组
 */
export async function searchBangumiData(keyword, siteKeys) {
    if (!memoryCache || !memoryCache.items) return [];

    let searchPromise = queryCache.get(keyword);

    if (!searchPromise) {
        searchPromise = (async () => {
            const matched = [];

            // 保留完整的繁简变体数组用于最终的精准校验阶段
            let searchTerms = [keyword];
            try {
                searchTerms = [...new Set([keyword, simplized(keyword), traditionalized(keyword)])];
            } catch (e) {}

            // 提取核心检索词：基于底层指纹的简体单向收束特性，仅提取简体核心词用于极速初筛
            const unifiedKeyword = simplized(keyword);
            const coreKws = [unifiedKeyword].map(kw => {
                let core = kw.replace(SUFFIX_CLEAN_REGEX, '');
                core = normalizeSpaces(core).toLowerCase();
                // 当规范化后字符过短时，降级使用仅规范化的原始词作为初筛条件
                return core.length >= 2 ? core : normalizeSpaces(kw).toLowerCase();
            }).filter(k => k.length > 0);

            let candidateIndices = null; 

            // 倒排索引初筛逻辑
            if (typeof charInvertedIndex !== 'undefined' && charInvertedIndex.size > 0 && coreKws.length > 0) {
                const globalCandidates = new Set(); 

                for (const kw of coreKws) {
                    // 剔除空格后，获取当前搜索词的所有去重单字
                    const chars = Array.from(new Set(kw.replace(WHITESPACE_REGEX, '')));
                    if (chars.length === 0) continue;

                    // 按字在库中出现的频率从小到大排序，优先处理包含条目最少的字以减少运算量
                    chars.sort((a, b) => {
                        const lenA = charInvertedIndex.get(a)?.length || 0;
                        const lenB = charInvertedIndex.get(b)?.length || 0;
                        return lenA - lenB;
                    });

                    // 如果出现频率最低的字不存在，表明该词无对应条目
                    const rarestCharArr = charInvertedIndex.get(chars[0]);
                    if (!rarestCharArr || rarestCharArr.length === 0) {
                        continue; 
                    }

                    // 初始化当前词的候选池
                    let localCandidates = new Set(rarestCharArr);

                    // 依次与后续字的集合求交集
                    for (let i = 1; i < chars.length; i++) {
                        const nextCharArr = charInvertedIndex.get(chars[i]);
                        if (!nextCharArr) {
                            localCandidates.clear(); break;
                        }

                        const nextCharSet = new Set(nextCharArr);
                        for (const idx of localCandidates) {
                            if (!nextCharSet.has(idx)) {
                                localCandidates.delete(idx);
                            }
                        }
                        if (localCandidates.size === 0) break;
                    }

                    // 合并到全局候选池
                    for (const idx of localCandidates) {
                        globalCandidates.add(idx);
                    }
                }
                
                candidateIndices = Array.from(globalCandidates);
            } 
            else {
                // 索引未就绪时，降级使用全量扫描
                candidateIndices = memoryCache.items.map((_, i) => i);
            }

            const items = memoryCache.items;
            const termsLen = searchTerms.length;

            // 核心匹配逻辑：校验候选项的主标题及所有多语言翻译版本
            for (let i = 0; i < candidateIndices.length; i++) {
                const item = items[candidateIndices[i]];

                let isMatch = false;
                for (let k = 0; k < termsLen; k++) {
                    const kw = searchTerms[k];

                    if (titleMatches(item.title, kw)) {
                        isMatch = true; break;
                    }

                    if (item.titleTranslate) {
                        for (const lang in item.titleTranslate) {
                            const transArr = item.titleTranslate[lang];
                            for (let j = 0; j < transArr.length; j++) {
                                if (transArr[j] && titleMatches(transArr[j], kw)) {
                                    isMatch = true; break;
                                }
                            }
                            if (isMatch) break;
                        }
                    }
                    if (isMatch) break;
                }

                // 装载匹配结果及其全量标题上下文
                if (isMatch) {
                    const titles = [item.title];
                    if (item.titleTranslate) {
                        for (const lang in item.titleTranslate) {
                            const transArr = item.titleTranslate[lang];
                            for (let j = 0; j < transArr.length; j++) {
                                titles.push(transArr[j]);
                            }
                        }
                    }
                    matched.push({ item, titles });
                }
            }
            return matched;
        })();

        // 维护缓存容量池，基于 LRU 策略淘汰旧任务
        if (queryCache.size > 100) {
            const firstKey = queryCache.keys().next().value;
            queryCache.delete(firstKey);
        }
        queryCache.set(keyword, searchPromise);
    }

    const matchedItems = await searchPromise;
    let finalItems = matchedItems;

    // 基于搜索词提取明确的季度信息并执行结果精准过滤
    const querySeason = getExplicitSeasonNumber(keyword);
    if (querySeason !== null) {
        const tempFiltered = matchedItems.filter(({ item }) => {
            let itemSeason = extractSeasonNumberFromAnimeTitle(item.title).season;
            if (itemSeason === null && item.titleTranslate) {
                for (const lang in item.titleTranslate) {
                    const transArr = item.titleTranslate[lang];
                    for (let j = 0; j < transArr.length; j++) {
                        const s = extractSeasonNumberFromAnimeTitle(transArr[j]).season;
                        if (s !== null) { itemSeason = s; break; }
                    }
                    if (itemSeason !== null) break;
                }
            }

            // 搜索指定续作(>1)时，标题必须明确包含该季度标识
            if (querySeason > 1) {
                return (itemSeason || 1) === querySeason;
            } 
            // 搜索第1季时，拦截明确标明为其他季度(如第2季、第3季)的结果
            else if (querySeason === 1) {
                return itemSeason === null || itemSeason === 1;
            }
            return true;
        });

        // 仅当过滤后结果不为空时应用，防止由于解析缺失导致结果被误杀清空
        if (tempFiltered.length > 0) {
            finalItems = tempFiltered;
        }
    }

    const validDubRegex = VALID_DUB_REGEX;
    const results = [];

    // 特定站点分发与区域版本/配音版本构建
    for (const { item, titles } of finalItems) {
        if (!item.sites) continue;

        const matchedSites = item.sites.filter(s => siteKeys.includes(s.site));
        for (const matchedSite of matchedSites) {
            let typeStr = "TV动画"; let typeId = "tvseries";
            if (item.type === 'movie') { typeStr = "剧场版"; typeId = "movie"; }
            else if (item.type === 'tv') { typeStr = "TV动画"; typeId = "tvseries"; }
            else if (item.type === 'ova') { typeStr = "OVA"; typeId = "ova"; }
            else if (item.type === 'web') { typeStr = "WEB动画"; typeId = "web"; }

            let baseSuffix = "";
            if (['bilibili_hk_mo_tw', 'bilibili_hk_mo', 'bilibili_tw'].includes(matchedSite.site)) {
                baseSuffix = "（港澳台）";
            }

            let additionalDubs = []; 
            let mainItemDubs = [];   

            if (matchedSite.comment) {
                const dubs = matchedSite.comment.split(COMMA_SPLIT_REGEX);
                for (const dub of dubs) {
                    const parts = dub.split(COLON_SPLIT_REGEX);
                    if (parts.length >= 2) {
                        const dubName = parts[0].trim(); const dubId = parts[1].trim();
                        if (dubId && validDubRegex.test(dubName)) {
                            additionalDubs.push({
                                title: item.title, titles: [...titles], begin: item.begin,
                                siteId: dubId, matchedSiteKey: matchedSite.site,
                                type: item.type, typeStr: typeStr, typeId: typeId, titleSuffix: ` ${dubName}${baseSuffix}`
                            });
                        }
                    } else if (parts.length === 1 && parts[0].trim()) {
                        const dubName = parts[0].trim();
                        if (validDubRegex.test(dubName)) {
                            mainItemDubs.push(dubName);
                        }
                    }
                }
            }

            // 组装当前主条目的最终后缀标签
            let currentItemSuffix = "";
            if (mainItemDubs.length > 0) { currentItemSuffix += ` ${mainItemDubs.join(' ')}`; }
            currentItemSuffix += baseSuffix;

            results.push({
                title: item.title, titles: [...titles], begin: item.begin,
                siteId: matchedSite.id, matchedSiteKey: matchedSite.site,
                type: item.type, typeStr: typeStr, typeId: typeId, titleSuffix: currentItemSuffix 
            });

            // 推送提取出的衍生条目
            results.push(...additionalDubs);
        }
    }
    return results;
}

/**
 * 释放本地数据内存缓存
 * 当动态关闭本地数据开关时调用，协助 V8 引擎进行垃圾回收
 */
export function clearBangumiDataCache() {
    if (memoryCache !== null) {
        const itemCount = memoryCache.items ? memoryCache.items.length : 0;
        memoryCache = null; // 切断引用，等待 GC 回收
        memoryCacheTime = 0; // 重置寿命时钟
        queryCache.clear(); // 释放查询缓存
        charInvertedIndex.clear(); // 释放倒排索引内存
        const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        log("info", `[Bangumi-Data] 内存缓存已主动释放 (原条目数: ${itemCount}，释放: ${memoryFootprintMB} MB，当前项目总占用: ${totalMemMB} MB)`);
        memoryFootprintMB = '0.00'; // 重置探针
        hasLoggedCacheWarning = false; // 重置警告标记
    }
}
