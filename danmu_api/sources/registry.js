// =====================
// 源注册表 (Source Registry)
// =====================
// 集中管理所有弹幕源的元数据与实例化，消除散落在 dandan-api.js / worker.test.js 中的
// import + new + if/else 分发三段重复代码。
//
// 新增一个源只需：
//   1. 在 sources/ 下新建 xxx.js 并 export default class XxxSource extends BaseSource
//   2. 在下方 SOURCE_REGISTRY 数组里加一条 { key, factory, ... } 配置
//
// 所有"按 sourceKey 查实例"的分发点改为调用 getSourceByKey(key) 即可，
// 无需再改动 dandan-api.js 的 import 区、实例化区或 if/else 分发链。
// =====================

import { globals } from '../configs/globals.js';

import Kan360Source from './kan360.js';
import VodSource from './vod.js';
import TmdbSource from './tmdb.js';
import DoubanSource from './douban.js';
import RenrenSource from './renren.js';
import HanjutvSource from './hanjutv.js';
import BahamutSource from './bahamut.js';
import DandanSource from './dandan.js';
import CustomSource from './custom.js';
import TencentSource from './tencent.js';
import IqiyiSource from './iqiyi.js';
import MangoSource from './mango.js';
import BilibiliSource from './bilibili.js';
import MiguSource from './migu.js';
import YoukuSource from './youku.js';
import SohuSource from './sohu.js';
import LeshiSource from './leshi.js';
import XiguaSource from './xigua.js';
import MaiduiduiSource from './maiduidui.js';
import AiyifanSource from './aiyifan.js';
import HongguoSource from './hongguo.js';
import AnimekoSource from './animeko.js';
import OtherSource from './other.js';

// 源注册表：每条记录描述一个源的调度身份与实例化方式。
// 字段说明：
//   key             —— sourceOrderArr 中的调度键名（如 "360"、"imgo"、"tencent"）
//   logName         —— 日志标签规范名称；为空时默认等于 key。处理 360→360kan、imgo→mango 这类别名
//   factory         —— 实例工厂 (ctx) => instance。ctx 是已建好实例的 Map（key->instance），供有依赖的源取依赖
//   extraSearchArgs —— search 调用是否需要额外参数 (preferAnimeId, preferSource)；仅 vod 为 true
//   deps            —— 该源依赖的其他源 key 列表（用于排序），无依赖为空
//   handleAdapter   —— 把各源签名不一致的 handleAnimes 统一为
//                      (searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason) 的适配器；
//                      未提供时默认调用 instance.handleAnimes(searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason)
//                      新增源若 handleAnimes 签名标准（5 参），可不提供 handleAdapter
const SOURCE_REGISTRY = [
  { key: '360',       logName: '360kan',  factory: () => new Kan360Source(), deps: [] },
  { key: 'vod',       logName: '',        factory: () => new VodSource(), deps: [], extraSearchArgs: true,
    handleAdapter: async (instance, searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason) => {
      // vod 源: search 返回多服务器结果数组，需逐个遍历并传入 serverName
      if (searchResult && Array.isArray(searchResult)) {
        for (const vodResult of searchResult) {
          if (vodResult && vodResult.list && vodResult.list.length > 0) {
            await instance.handleAnimes(vodResult.list, queryTitle, isolatedAnimes, vodResult.serverName, isolatedDetailStore, targetSeason);
          }
        }
      }
    } },
  { key: 'tmdb',      logName: '',        factory: (ctx) => new TmdbSource(ctx.get('douban')), deps: ['douban'] },
  { key: 'douban',    logName: '',        factory: (ctx) => new DoubanSource(ctx.get('tencent'), ctx.get('iqiyi'), ctx.get('youku'), ctx.get('bilibili'), ctx.get('migu')), deps: ['tencent', 'iqiyi', 'youku', 'bilibili', 'migu'] },
  { key: 'renren',    logName: '',        factory: () => new RenrenSource(), deps: [] },
  { key: 'hanjutv',   logName: '',        factory: () => new HanjutvSource(), deps: [] },
  { key: 'bahamut',   logName: '',        factory: () => new BahamutSource(), deps: [] },
  { key: 'dandan',    logName: '',        factory: () => new DandanSource(), deps: [] },
  { key: 'custom',    logName: '',        factory: () => new CustomSource(), deps: [],
    handleAdapter: (instance, searchResult, queryTitle, isolatedAnimes) => instance.handleAnimes(searchResult, queryTitle, isolatedAnimes) },
  { key: 'tencent',   logName: '',        factory: () => new TencentSource(), deps: [] },
  { key: 'iqiyi',     logName: '',        factory: () => new IqiyiSource(), deps: [] },
  { key: 'imgo',      logName: 'mango',   factory: () => new MangoSource(), deps: [] },
  { key: 'bilibili',  logName: '',        factory: () => new BilibiliSource(), deps: [] },
  { key: 'migu',      logName: '',        factory: () => new MiguSource(), deps: [] },
  { key: 'youku',     logName: '',        factory: () => new YoukuSource(), deps: [] },
  { key: 'sohu',      logName: '',        factory: () => new SohuSource(), deps: [] },
  { key: 'leshi',     logName: '',        factory: () => new LeshiSource(), deps: [] },
  { key: 'xigua',     logName: '',        factory: () => new XiguaSource(), deps: [] },
  { key: 'maiduidui', logName: '',        factory: () => new MaiduiduiSource(), deps: [] },
  { key: 'aiyifan',   logName: '',        factory: () => new AiyifanSource(), deps: [] },
  { key: 'hongguo',   logName: '',        factory: () => new HongguoSource(), deps: [] },
  { key: 'animeko',   logName: '',        factory: () => new AnimekoSource(), deps: [] },
  { key: 'other',     logName: '',        factory: () => new OtherSource(), deps: [] },
];

// ---- 实例缓存（按 key 索引）----
const instanceMap = new Map();
const metaMap = new Map();
let initialized = false;

/**
 * 按依赖拓扑顺序一次性构建所有源实例。
 * 无依赖源先建，有依赖源从已建实例中取依赖；同层按注册顺序。
 * 幂等：重复调用不会重复实例化。
 */
export function initSources() {
  if (initialized) return;
  const built = new Set();

  // 多趟扫描：每趟把"依赖已全部就绪"的源建出来，直到全部建完或无法推进
  let progress = true;
  while (built.size < SOURCE_REGISTRY.length && progress) {
    progress = false;
    for (const entry of SOURCE_REGISTRY) {
      if (built.has(entry.key)) continue;
      const depsReady = (entry.deps || []).every(d => built.has(d));
      if (!depsReady) continue;
      const instance = entry.factory(instanceMap);
      const handleAdapter = entry.handleAdapter || ((inst, searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason) =>
        inst.handleAnimes(searchResult, queryTitle, isolatedAnimes, isolatedDetailStore, targetSeason));
      instanceMap.set(entry.key, instance);
      metaMap.set(entry.key, {
        key: entry.key,
        logName: entry.logName || entry.key,
        instance,
        extraSearchArgs: !!entry.extraSearchArgs,
        handleAdapter,
      });
      built.add(entry.key);
      progress = true;
    }
  }

  if (built.size < SOURCE_REGISTRY.length) {
    const unresolved = SOURCE_REGISTRY.filter(e => !built.has(e.key)).map(e => e.key);
    throw new Error(`[registry] 源实例化存在未解决的循环依赖: ${unresolved.join(', ')}`);
  }

  initialized = true;
}

/** 确保已初始化（懒初始化，供按需取实例的场景使用）*/
function ensureInit() {
  if (!initialized) initSources();
}

/**
 * 按 sourceKey 取源实例。未注册返回 null。
 * @param {string} key sourceOrderArr 中的调度键名
 * @returns {BaseSource|null}
 */
export function getSourceByKey(key) {
  ensureInit();
  return instanceMap.get(key) || null;
}

/**
 * 按 sourceKey 取源元数据 { key, logName, instance, extraSearchArgs }。未注册返回 null。
 * 用于分发点同时需要实例与日志标签的场景。
 */
export function getSourceMetaByKey(key) {
  ensureInit();
  return metaMap.get(key) || null;
}

/**
 * 按 sourceKey 取日志标签规范名称。未注册返回原值。
 * 兼容 http-util.js 旧 toLogSourceName 的查询需求。
 */
export function getLogNameByKey(key) {
  ensureInit();
  const meta = metaMap.get(key);
  return meta ? meta.logName : key;
}

/**
 * 取所有已注册源的元数据列表，按注册顺序。
 * 用于需要遍历全部源的场景。
 */
export function getAllSourceMetas() {
  ensureInit();
  return SOURCE_REGISTRY.map(e => metaMap.get(e.key));
}

/**
 * 取所有已注册源实例，按注册顺序。
 */
export function getAllSourceInstances() {
  ensureInit();
  return SOURCE_REGISTRY.map(e => instanceMap.get(e.key));
}

/**
 * 判断某 sourceKey 是否已注册。
 */
export function isRegisteredSource(key) {
  return SOURCE_REGISTRY.some(e => e.key === key);
}

// 模块加载时立即完成实例化，保证 import 完成后即可直接取用
initSources();
