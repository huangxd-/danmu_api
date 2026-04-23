import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import { globals } from '../configs/globals.js';
import { log } from './log-util.js';
import { httpGet } from './http-util.js';
import { titleMatches } from './common-util.js';

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

            log("info", `[Bangumi-Data] 成功从本地磁盘加载基础数据，条目数: ${memoryCache.items.length}，约占内存: ${memoryFootprintMB} MB`);

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

/**
 * 下载并缓存最新版本的 Bangumi Data
 * 支持流式下载写入磁盘或直接解析到内存，并记录细粒度性能指标
 * @param {string|null} cachePath - 缓存文件写入路径，为 null 时仅加载到内存
 * @returns {Promise<void>}
 */
async function downloadAndCache(cachePath) {
    log("info", "[Bangumi-Data] 开始下载最新数据 (约 7MB)...");
    try {
        const url = "https://unpkg.com/bangumi-data@0.3/dist/data.json";
        const memBefore = process.memoryUsage().heapUsed;
        const startTime = Date.now(); 

        let parseStartTime = 0;
        let parseTimeMs = 0;

        if (cachePath) {
            log("info", `[请求模拟] HTTP GET: ${url}`);
            // 原子写入策略
            const tempPath = `${cachePath}.tmp`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            await pipeline(response.body, fs.createWriteStream(tempPath));
            fs.renameSync(tempPath, cachePath); 

            // 单独记录下载文件的分段耗时
            const downloadTime = ((Date.now() - startTime) / 1000).toFixed(2);
            log("info", `[Bangumi-Data] 流式下载并写入磁盘成功 (网络耗时: ${downloadTime} 秒)`);

            // 单独记录解析内存的耗时
            parseStartTime = Date.now();
            memoryCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            parseTimeMs = Date.now() - parseStartTime;
        } else {
            // 纯内存加载，显式声明压缩头榨干 CDN 性能]
            log("info", `[请求模拟] HTTP GET: ${url}`);
            const response = await fetch(url, {
                headers: {
                    // br (Brotli) 的压缩率比 gzip 还要高 15%~20%
                    'Accept-Encoding': 'br, gzip, deflate'
                }
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            parseStartTime = Date.now();
            memoryCache = await response.json();
            parseTimeMs = Date.now() - parseStartTime;
        }

        const memAfter = process.memoryUsage().heapUsed;
        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2); 

        memoryFootprintMB = Math.max(0, (memAfter - memBefore) / 1024 / 1024).toFixed(2);
        const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        memoryCacheTime = Date.now();

        log("info", `[Bangumi-Data] 加载到内存成功，条目数: ${memoryCache.items.length}，解析耗时: ${parseTimeMs} ms，全链路总耗时: ${totalTime} 秒，约占内存: ${memoryFootprintMB} MB (当前项目总占用: ${totalMemMB} MB)`);
    } catch (e) {
        log("error", "[Bangumi-Data] 下载失败:", e.message);
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
    for (const item of memoryCache.items) {
        // 构建完整的搜索标题池
        const titles = [item.title];
        if (item.titleTranslate) {
            for (const lang in item.titleTranslate) {
                titles.push(...item.titleTranslate[lang]);
            }
        }

        const isMatch = titles.some(t => t && titleMatches(t, keyword));
        
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
        // 获取切断引用时的总物理内存
        const totalMemMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
        
        log("info", `[Bangumi-Data] 内存缓存已主动释放 (原条目数: ${itemCount}，释放: ${memoryFootprintMB} MB，当前项目总占用: ${totalMemMB} MB)`);
        memoryFootprintMB = '0.00'; // 重置探针
		hasLoggedCacheWarning = false; // 重置警告标记
    }
}
