import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { titleMatches } from './common-util.js';
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

// 定义缓存目录和文件名
const CACHE_DIR = path.join(process.cwd(), '.cache');
const CACHE_FILENAME = 'bangumi-data-cache.json';
const DOWNLOAD_TIMEOUT_MS = 20000;

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
 * 提取搜索逻辑必须的字段，并过滤掉不包含目标站点标识的动漫条目，控制常驻内存占用
 * * @param {Object} rawData - 原始完整版 Bangumi Data JSON 对象
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

        // 构建精简版条目，仅保留核心检索字段
        const prunedItem = {
            title: item.title,
            type: item.type,
            sites: validSites
        };
        if (item.begin) prunedItem.begin = item.begin;
        if (item.titleTranslate) prunedItem.titleTranslate = item.titleTranslate;

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

            // 立即执行数据裁剪以释放内存
            const localParseStartTime = Date.now();
            const prunedData = pruneBangumiData(resultData);
            const pruneCost = Date.now() - localParseStartTime;

            let tempFilePath = null;

            if (cachePath) {
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
 * 支持多语言标题检索、特定站点过滤以及配音/区域版本解析
 * @param {string} keyword - 搜索关键词
 * @param {Array<string>} siteKeys - 需要匹配的源站点标识数组
 * @returns {Array<Object>} 匹配的动漫条目数组，包含解析后的展示标题、ID及类型等元数据
 */
export function searchBangumiData(keyword, siteKeys) {
    if (!memoryCache || !memoryCache.items) return [];

    const validDubRegex = /(?:普通[话話]|[国國][语語]|中文配音|中配|中文|[粤粵][语語]配音|[粤粵]配|[粤粵][语語]|[台臺]配|[台臺][语語]|港配|港[语語]|字幕|助[听聽]|日[语語]|日配|原版|原[声聲])(?:版)?/;
    const results = [];

    // 简繁转换搜索关键词
    let searchTerms = [keyword];
    try {
        searchTerms = [...new Set([keyword, simplized(keyword), traditionalized(keyword)])];
    } catch (e) {
    }

    for (const item of memoryCache.items) {
        // 构建完整的搜索标题池
        const titles = [item.title];
        if (item.titleTranslate) {
            for (const lang in item.titleTranslate) {
                titles.push(...item.titleTranslate[lang]);
            }
        }

        const isMatch = titles.some(t => t && searchTerms.some(kw => titleMatches(t, kw)));

        if (isMatch && item.sites) {
            // 捕获所有符合条件的站点记录，支持同源多区域版本（如大陆版和港澳台版共存）
            const matchedSites = item.sites.filter(s => siteKeys.includes(s.site));

            for (const matchedSite of matchedSites) {
                // 标准化媒体类型映射
                let typeStr = "TV动画";
                let typeId = "tvseries";
                if (item.type === 'movie') { typeStr = "剧场版"; typeId = "movie"; }
                else if (item.type === 'tv') { typeStr = "TV动画"; typeId = "tvseries"; }
                else if (item.type === 'ova') { typeStr = "OVA"; typeId = "ova"; }
                else if (item.type === 'web') { typeStr = "WEB动画"; typeId = "web"; }

                // 提取区域版本基础后缀
                let baseSuffix = "";
                if (['bilibili_hk_mo_tw', 'bilibili_hk_mo', 'bilibili_tw'].includes(matchedSite.site)) {
                    baseSuffix = "（港澳台）";
                }

                // 解析衍生配音版本与当前主条目的附加描述
                let additionalDubs = []; 
                let mainItemDubs = [];   

                if (matchedSite.comment) {
                    const dubs = matchedSite.comment.split(/[,，]/);
                    for (const dub of dubs) {
                        const parts = dub.split(/[:：]/);
                        if (parts.length >= 2) {
                            const dubName = parts[0].trim();
                            const dubId = parts[1].trim();
                            if (dubId && validDubRegex.test(dubName)) {
                                additionalDubs.push({
                                    title: item.title,
                                    titles: [...titles],
                                    begin: item.begin,
                                    siteId: dubId, 
                                    matchedSiteKey: matchedSite.site,
                                    type: item.type,
                                    typeStr: typeStr,
                                    typeId: typeId,
                                    titleSuffix: ` ${dubName}${baseSuffix}`
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
                if (mainItemDubs.length > 0) {
                    currentItemSuffix += ` ${mainItemDubs.join(' ')}`;
                }
                currentItemSuffix += baseSuffix;

                results.push({
                    title: item.title,
                    titles: [...titles],
                    begin: item.begin,
                    siteId: matchedSite.id,
                    matchedSiteKey: matchedSite.site,
                    type: item.type,
                    typeStr: typeStr,
                    typeId: typeId,
                    titleSuffix: currentItemSuffix 
                });

                // 推送提取出的衍生条目
                results.push(...additionalDubs);
            }
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
        const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        log("info", `[Bangumi-Data] 内存缓存已主动释放 (原条目数: ${itemCount}，释放: ${memoryFootprintMB} MB，当前项目总占用: ${totalMemMB} MB)`);
        memoryFootprintMB = '0.00'; // 重置探针
        hasLoggedCacheWarning = false; // 重置警告标记
    }
}
