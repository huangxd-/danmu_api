import { globals } from '../configs/globals.js';
import { httpGet } from './http-util.js';
import { log } from './log-util.js';

// =====================================================================
// 远程剧名映射表（TITLE_MAPPING_TABLE_URL）相关函数
// =====================================================================
//
// 【这个文件是做什么的？】
//   用户可以在环境变量里配置一个「远程剧名映射表」的地址（比如 GitHub 上的一个 txt 文件）。
//   这个文件里写的是：
//       原始标题 -> 应该映射成的标题
//   例如：
//       Monster Island.2017 -> 怪物岛
//
//   程序会：
//   1. 定时（每天北京 05:30）从远程地址下载这份映射表；
//   2. 下载成功后保存到本地 .cache 文件夹（下次启动不联网也能用）；
//   3. 遇到用户搜索/匹配剧名时，先看映射表里有没有「原始标题」，
//      有就把标题替换成映射后的标题再去搜索，这样能找到正确弹幕。
//
// 【本地表 vs 远程表】
//   - 本地表（TITLE_MAPPING_TABLE）由用户自己在设置页填写，优先级最高；
//   - 远程表（TITLE_MAPPING_TABLE_URL）从远程下载，只有本地表没命中时才用。
//
// 【给初学者的阅读指引】
//   核心 3 个函数，按顺序读即可：
//   1. parseRemoteTitleMappings()   —— 把文本变成规则表（Map）
//   2. buildMappingCandidateKeys()  —— 根据剧名/季节/年份生成「可能命中」的键
//   3. applyTitleMappingWithLog()   —— 用键去查表，查到了就替换标题
// =====================================================================

// ---------------------------------------------------------------------
// remoteState：远程映射表的「运行内存快照」
// 解释：程序运行期间，远程映射相关的所有关键信息都放在这个对象里。
// 它不会保存到磁盘，程序重启后从 .cache 文件重新加载。
// ---------------------------------------------------------------------
const remoteState = {
  url: '',                // 上次「成功拉取」的地址（用于判断地址是否变了）
  attemptedUrl: '',       // 最近一次「尝试过」的地址（无论成功失败）
  fetchedAt: 0,           // 上次成功拉取的时间戳（毫秒）
  failedAt: 0,            // 上次拉取失败的时间戳（用于失败后短暂退避）
  mappings: new Map(),    // 远程映射内容。格式：{原始标题 -> 映射标题}
                          // 注意：只在本地规则没命中时才会查这个表
  fetching: null,         // 正在进行中的下载任务（Promise）。
                          // 作用：防止两个请求同时下载，造成重复劳动
  mergedRef: null,        // 最近一次「合并后的完整表」的引用。
                          // 作用：如果 globals.titleMappingTable 还是这个引用，说明不用重新合并
  localMappings: null,    // 最近一次读到的「纯本地表」快照
                          // 作用：确保本地表不会被远程规则污染
  diskLoadedUrl: '',      // 已经从磁盘缓存加载过的地址（避免重复读文件）
  initialAttemptedUrl: '',// 首次初始化时尝试过的地址（失败后不再重复联网）
  mergeLogged: false,     // 是否已经记录过“合并生效”日志（每个进程只记一次，避免刷屏）
};

/**
 * 【计算远程映射缓存的存放路径】
 *
 * 缓存放两个文件（都在 .cache 目录下）：
 *   title-mapping-remote.txt  —— 映射表正文内容
 *   title-mapping-remote.json —— 元信息（对应 URL、下载时间）
 *
 * 返回 Promise，因为需要动态加载 node:path 模块。
 */
function remoteCachePaths() {
  // 不在 Node 环境（如边缘服务器）就没文件系统，返回 null
  if (typeof process === 'undefined' || !process.cwd) return null;
  return import('node:path').then(({ default: path }) => ({
    dir: path.join(process.cwd(), '.cache'),                            // 目录
    text: path.join(process.cwd(), '.cache', 'title-mapping-remote.txt'), // 正文文件
    meta: path.join(process.cwd(), '.cache', 'title-mapping-remote.json'), // 元信息文件
  }));
}

/**
 * 【从磁盘缓存恢复远程映射表】
 * 背景：程序上次成功下载后，会把内容存到 .cache 目录。
 *       本次启动时先读缓存，这样即使暂时连不上网，也能正常使用上次的映射表。
 * 参数：url —— 用户配置的远程地址（用于核对缓存是不是这个地址的）
 * 返回：true=成功恢复，false=缓存不存在/不匹配/解析失败
 */
async function loadDiskRemoteMapping(url) {
  // 同一个地址只从磁盘加载一次（避免重复读文件浪费时间）
  if (remoteState.diskLoadedUrl === url) return false;
  remoteState.diskLoadedUrl = url;
  try {
    // 非 Node 环境（如服务器边缘函数）没有文件系统，直接放弃
    if (typeof process === 'undefined' || !process.cwd) return false;
    // 动态导入 Node 的文件系统模块，并拿到缓存文件的路径
    const [{ default: fs }, paths] = await Promise.all([import('node:fs/promises'), remoteCachePaths()]);
    // 读元信息文件（里面记录了这个缓存对应哪个 URL、什么时候下载的）
    const meta = JSON.parse(await fs.readFile(paths.meta, 'utf8'));
    // 如果缓存里的 URL 和当前配置的 URL 不一致，说明缓存是旧的，不能用
    if (meta.url !== url) return false;
    const text = await fs.readFile(paths.text, 'utf8');
    const mappings = parseRemoteTitleMappings(text);
    if (!mappings.size) return false;
    remoteState.url = url;
    remoteState.mappings = mappings;
    remoteState.fetchedAt = Number(meta.fetchedAt) || 0;
    remoteState.failedAt = 0;
    remoteState.mergedRef = null;
    ensureMergedIntoGlobals();
    logRemoteMapping("info", `[system] [remote-mapping] 已加载本地远程映射缓存: ${mappings.size} 条规则, 文件: ${paths.text}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 【把最新下载的内容保存成磁盘缓存】
 *
 * 为什么要“先写临时文件再改名”？
 * 防止写一半断电/崩溃时留下残缺文件。
 * 先写 xxx.tmp.tmp，写完后再 rename 成正式文件名——rename 是原子操作，
 * 要么整个生效，要么不动，绝不会出现“半个文件”。
 *
 * 写失败只警告不报错：因为缓存只是“锦上添花”，
 * 本次内存里已经生效了，只是下次启动没有缓存可用而已。
 */
async function saveDiskRemoteMapping(url, text) {
  try {
    // 非 Node 环境没有文件系统，直接跳过
    if (typeof process === 'undefined' || !process.cwd) return;
    const [{ default: fs }, paths] = await Promise.all([import('node:fs/promises'), remoteCachePaths()]);
    await fs.mkdir(paths.dir, { recursive: true });   // 确保 .cache 目录存在

    // 先写入临时文件（文件名带进程号，防止并发写冲突）
    const tmp = `${paths.text}.${process.pid || 'current'}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    // 原子改名：临时文件 → 正式文件（覆盖旧的）
    await fs.rename(tmp, paths.text);
    // 更新元信息（记录 URL 和下载时间）
    await fs.writeFile(paths.meta, JSON.stringify({ url, fetchedAt: Date.now() }), 'utf8');
    logRemoteMapping("info", `[system] [remote-mapping] 远程映射表已覆盖本地缓存: ${paths.text}`);
  } catch (e) {
    // 写缓存失败不影响本次使用，只记警告
    logRemoteMapping("warn", `[system] [remote-mapping] 写入本地远程映射缓存失败（不影响本次使用）: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------
// 每日自动更新相关的常量
// ---------------------------------------------------------------------
const REMOTE_REFRESH_HOUR = 5;          // 每天更新时刻的「小时」（北京时间 05:00）
const REMOTE_REFRESH_MINUTE = 30;       // 每天更新时刻的「分钟」（北京时间 05:30，即 05:00 之后半小时）
const REMOTE_REFRESH_RETRY_COUNT = 5;   // 下载失败最多重试 5 次
const REMOTE_REFRESH_RETRY_DELAY_MS = 60 * 1000; // 每次重试之间等 60 秒
let remoteSchedulerTimer = null;          // 定时器句柄。用来记住“已安排定时任务”，避免重复安排
let remoteRefreshInProgress = null;       // 正在进行的更新任务（Promise）。
                                          // 若为 null 表示当前没有更新在跑；
                                          // 若非 null，新请求会直接复用这个任务，避免并发下载

// ---------------------------------------------------------------------
// 远程映射日志（供设置页「远程映射日志」查看）
// ---------------------------------------------------------------------
// 最大保留 500 条；超过后把最旧的删掉（先进先出），和系统主日志同一套机制。
const MAX_REMOTE_LOGS = 500;
const remoteLogBuffer = [];  // 日志存放的数组，每项是 { timestamp, level, message }

/**
 * 生成日志时间戳。
 * 说明：服务器可能运行在任何时区，这里统一转成北京时间（UTC+8）
 * 便于用户查看日志时对得上时间。
 */
function remoteLogTimestamp() {
  const now = new Date();
  // 现在的毫秒数 + 8 小时（28800000 毫秒 = 8 * 60 * 60 * 1000），得到北京时间
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  // toISOString 返回 UTC 时间，把结尾的 Z 换成 +08:00 表示“这是北京时间”
  return shanghaiTime.toISOString().replace('Z', '+08:00');
}

/**
 * 记录一条远程映射日志。
 * 会同时写两份：
 *   1. 系统主日志（log()）——和其他日志混在一起的全量日志
 *   2. 独立缓冲区——专门给远程映射功能看的最近 500 条
 */
function logRemoteMapping(level, message) {
  log(level, message);                              // 写入主日志
  remoteLogBuffer.push({ timestamp: remoteLogTimestamp(), level, message }); // 写入独立缓冲区
  // 超过 500 条就把最老的一条挤出去（shift 删除数组开头）
  if (remoteLogBuffer.length > MAX_REMOTE_LOGS) remoteLogBuffer.shift();
}

/**
 * 【返回远程映射的日志文本】
 * 仅供设置页的「远程映射日志」/ /api/logs/remote-mapping 接口读取。
 * 把缓冲区里每条日志格式化成一行行的文本返回。
 *
 * @returns {string} 多行日志文本
 */
export function getRemoteMappingLogText() {
  return remoteLogBuffer
    // 每条日志： [时间] 级别: 消息
    .map(logEntry => `[${logEntry.timestamp}] ${logEntry.level}: ${logEntry.message}`)
    .join('\n');
}

/**
 * 【把用户填的地址转换成“能直接下载的地址”】
 *
 * 用户填的地址可能有三种形态，其中前两种是“网页”，直接下载会拿到 HTML 而不是文本：
 *   1. GitHub 文件页：https://github.com/xxx/yyy/blob/main/a.txt
 *      → 转换成 raw.githubusercontent.com 直链（纯文本，可直接下载）
 *   2. GitHub Gist 页：https://gist.github.com/xxx/123abc
 *      → 转换成 gist.githubusercontent.com 的 raw 直链
 *   3. 其他地址（jsDelivr、自建服务器）：本来就是直链，原样返回
 *
 * @param {string} rawUrl 用户配置的地址
 * @returns {string} 转换后的可直接下载地址（空字符串 = 没填）
 */
export function normalizeMappingSourceUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';  // 没填地址，返回空

  // 情况 1：GitHub blob 页面。正则拆出 {作者}/{仓库}/{分支/路径}
  const blobMatch = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/(.+)$/i);
  if (blobMatch) {
    return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
  }
  const gistMatch = url.match(/^https?:\/\/gist\.github\.com\/([^/\s]+)\/([0-9a-fA-F]+)$/i);
  if (gistMatch) {
    return `https://gist.githubusercontent.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
  }
  return url;
}

/**
 * 【把远程映射表的“文本内容”解析成“规则表”】
 *
 * 远程下载回来的文件是纯文本，例如：
 *
 *     # 这是注释
 *     Monster Island.2017 -> 怪物岛
 *     蜘蛛侠;钢铁侠 -> 复仇者
 *
 * 这个函数负责把这样的文本，变成程序方便查询的结构：
 *     Map { "Monster Island.2017" => "怪物岛", "蜘蛛侠" => "复仇者", "钢铁侠" => "复仇者" }
 *
 * 特点（对使用者宽容）：
 *   - 支持每行一条规则，也支持一行用分号写多条规则
 *   - 支持 @ 分隔、全角箭头（－> —> –>）、引号包裹等写法
 *   - 自动跳过 # 和 // 开头的注释行、空行、没有箭头的行
 *
 * @param {string} text 远程文本内容
 * @returns {Map<string, string>} 解析出的映射表（键=原始标题，值=映射标题）
 */
export function parseRemoteTitleMappings(text) {
  const table = new Map();  // 最终结果：原始标题 -> 映射标题
  if (!text || typeof text !== 'string') return table;  // 空内容直接返回空表

  // 有些文件里用的是全角箭头（－> —> –>），统一替换成半角 ->，方便后面按 -> 切分
  const normalized = text.replace(/－>|—>|–>/g, '->');

  // 清理小工具：去掉字符串首尾的空格、引号（防止"怪物岛"这种带引号的值）
  const cleanField = s => s.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();

  // 逐行处理。注意顺序：先按行拆，再按分号拆；
  // 如果先按分号拆，注释里的分号会污染结果，所以必须“先行后分号”。
  for (const rawLine of normalized.split(/\r?\n/)) {
    let line = rawLine.trim();
    // 跳过空行和整行注释
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // 剥离「行尾注释」：只有 # 或 // 前面有空格时才剥离，
    // 避免把标题本身含的 # 符号（如 "某某#1"）误删
    line = line.replace(/\s+(?:#|\/\/).*$/, '').trim();
    if (!line) continue;

    // 同一行内可能用分号写多条规则（兼容本地单行格式），逐个拆开
    for (const rawRule of line.split(';')) {
      let rule = rawRule.trim();
      if (!rule || rule.startsWith('#') || rule.startsWith('//')) continue;

      // 去掉行尾多余的逗号/分号（中英文都算），避免残留分隔符
      rule = rule.replace(/[,，;；]+$/, '').trim();
      if (!rule) continue;

      // 找到箭头的下标；找不到说明这行不是映射规则（可能是屏蔽词等），跳过
      const arrowIndex = rule.indexOf('->');
      if (arrowIndex === -1) continue;

      // 箭头左边 = 原始标题，右边 = 映射标题，两边都去掉多余空白和引号
      const original = cleanField(rule.slice(0, arrowIndex));
      const mapped = cleanField(rule.slice(arrowIndex + 2));

      // 两边都非空才算有效规则，写入表里
      if (original && mapped) {
        table.set(original, mapped);
      }
    }
  }

  return table;
}

/**
 * 【应用一份新的远程映射内容】
 * 调用时机：每次成功从远程下载到内容后、或测试注入时调用。
 *
 * 流程：
 *   1. 把文本解析成规则表
 *   2. 若解析不到任何有效规则 → 抛异常（让上层知道这次更新失败了）
 *   3. 成功后更新内存状态，并把「本地表 + 远程表」合并进全局
 *
 * @param {string} url  归一化后的来源地址
 * @param {string} text 远程文本内容
 * @returns {boolean} 是否成功解析并生效
 */
export function applyRemoteTitleMappingText(url, text) {
  // 1. 解析文本 → 规则表
  const mappings = parseRemoteTitleMappings(text);

  // 2. 如果本地表快照还不存在（比如第一次使用），先拍一份纯本地表的快照
  if (!remoteState.localMappings) {
    remoteState.localMappings = readPureLocalMappingTable();
  }

  // 3. 校验：一张有效的表里至少要有一条规则，否则拒绝本次更新
  if (mappings.size === 0) {
    throw new Error('远程映射表未解析到有效规则（每条需为 原始标题->映射标题 格式）');
  }

  // 4. 一切正常，更新内存状态
  remoteState.url = url;              // 记住成功地址
  remoteState.mappings = mappings;    // 新规则表替代旧规则表
  remoteState.fetchedAt = Date.now(); // 记住成功时刻
  remoteState.failedAt = 0;           // 清除“上次失败”标记
  remoteState.mergedRef = null;       // 置空合并引用 → 触发下面的合并逻辑重建全局表
  ensureMergedIntoGlobals();
  logRemoteMapping("info", `[system] [remote-mapping] 远程剧名映射表已更新: ${mappings.size} 条规则, 来源: ${url}`);
  return true;
}

/**
 * 【把本地表 + 远程表合并成一份完整表，写入 globals】
 *
 * 合并规则：
 *   const merged = 远程表 + 本地表
 *   （后面写的覆盖前面写的。因为本地表后加入，所以"冲突时本地优先"）
 *
 * 代码小白注意：
 *   Map 展开合并 [...远程, ...本地]，如果同一个键两边都有，
 *   后出现的（本地）会覆盖先出现的（远程）。这正是我们想要的优先级。
 */
function ensureMergedIntoGlobals() {
  // 兜底：如果本地快照丢失，就用全局表里现有的内容
  const currentTable = globals.titleMappingTable instanceof Map ? globals.titleMappingTable : new Map();
  const localTable = remoteState.localMappings || currentTable;

  // 远程表为空就不用合并（没什么可合的）
  if (remoteState.mappings.size === 0) return;

  // 如果全局表已经是我们上次合并出来的那一份，说明没变化，直接跳过（性能优化）
  if (globals.titleMappingTable === remoteState.mergedRef) return;

  // 关键合并：远程先、本地后 → 本地优先
  const merged = new Map([...remoteState.mappings, ...localTable]);
  globals.titleMappingTable = merged;   // 写入全局，后续所有匹配都用这份
  remoteState.mergedRef = merged;       // 记录引用，下次就能判断“没变化，不用重做”

  // 每个进程只记一次合并日志，避免每次启动都刷屏
  if (!remoteState.mergeLogged) {
    remoteState.mergeLogged = true;
    logRemoteMapping("info", `[system] [remote-mapping] 剧名映射表合并生效: 本地 ${localTable.size} 条 + 远程 ${remoteState.mappings.size} 条（冲突时本地优先）`);
  }
}

/**
 * 【从远程地址拉取一次映射表，并使它生效】
 *
 * 步骤：
 *   1. 下载文本（超时 5 秒，不自动重试——重试由上层控制逻辑负责）
 *   2. 校验内容非空
 *   3. 解析 + 校验 + 写入内存（若解析失败会抛异常，不会污染旧数据）
 *   4. 写磁盘缓存（先写临时文件再改名 = 原子替换，绝不会写出半截文件）
 *
 * @param {string} url 归一化后的远程地址
 */
async function fetchRemoteMappings(url) {
  remoteState.attemptedUrl = url;
  logRemoteMapping("info", `[system] [remote-mapping] 拉取远程剧名映射表: ${url}`);

  // 单次请求短超时 5 秒：避免远程站点不可达时卡住更新按钮很久
  const res = await httpGet(url, { timeout: 5000, retries: 0 });
  const text = typeof res?.data === 'string' ? res.data : (res?.data != null ? String(res.data) : '');
  if (!text.trim()) throw new Error('远程映射表内容为空');

  // 先解析并校验，成功后才更新内存与磁盘；失败会向上抛异常，绝不动旧缓存
  applyRemoteTitleMappingText(url, text);
  await saveDiskRemoteMapping(url, text);
}

/**
 * 【带重试的远程表更新】——供「每日定时」和「首次初始化」使用
 *
 * 逻辑：最多尝试 REMOTE_REFRESH_RETRY_COUNT（5）次，
 *       每次失败后等 60 秒再试；5 次全失败就放弃（沿用旧缓存）。
 *
 * 注意：手动更新按钮不走这里（它只试 1 次），走 refreshRemoteTitleMappingNow()。
 *
 * @param {string} url 归一化后的远程地址
 * @param {string} reason 触发原因（用于日志，如“北京时间 05:30 定时”）
 * @returns {boolean} true=成功，false=失败
 */
async function refreshRemoteTitleMapping(url, reason = 'scheduled') {
  if (!url) return false;
  // 如果已经有一个更新在跑，直接复用那个任务（并发保护）
  if (remoteRefreshInProgress) return remoteRefreshInProgress;

  remoteRefreshInProgress = (async () => {
    for (let attempt = 1; attempt <= REMOTE_REFRESH_RETRY_COUNT; attempt++) {
      try {
        logRemoteMapping("info", `[system] [remote-mapping] ${reason} 更新尝试 ${attempt}/${REMOTE_REFRESH_RETRY_COUNT}`);
        await fetchRemoteMappings(url);   // 下载 + 生效 + 写缓存（一步到位）
        remoteState.failedAt = 0;         // 成功：清除失败标记
        logRemoteMapping("info", `[system] [remote-mapping] 远程映射表更新成功（第 ${attempt} 次尝试）`);
        return true;
      } catch (e) {
        remoteState.failedAt = Date.now();
        logRemoteMapping("warn", `[system] [remote-mapping] 更新尝试 ${attempt}/${REMOTE_REFRESH_RETRY_COUNT} 失败: ${e?.message || e}`);
        // 不是最后一次失败，就等 60 秒再试
        if (attempt < REMOTE_REFRESH_RETRY_COUNT) await new Promise(resolve => setTimeout(resolve, REMOTE_REFRESH_RETRY_DELAY_MS));
      }
    }
    // 5 次全失败：记一条错误日志，本次放弃（旧缓存继续用）
    logRemoteMapping("error", `[system] [remote-mapping] 连续 ${REMOTE_REFRESH_RETRY_COUNT} 次下载失败，取消本次更新并沿用本地缓存`);
    return false;
  })().finally(() => { remoteRefreshInProgress = null; });  // 无论如何，结束时清空并发标记

  return remoteRefreshInProgress;
}

// ---------------------------------------------------------------------
// 三种「键的形态」——为什么需要它们？
// ---------------------------------------------------------------------
// 同一部剧，文件名里可能出现很多写法：
//   Monster.Island    （点号）
//   Monster Island    （空格）
//   Monster_Island    （下划线）
//   Monster-Island    （连字符）
// 它们本质都是同一部剧。为了让用户随便哪种写法都能命中，我们准备了 3 种归一化：
//
//   1. 原样保留        Monster.Island
//   2. 分隔符变空格    Monster Island
//   3. 去掉分隔符小写  monsterisland（终极兜底，最宽松）
// ---------------------------------------------------------------------

/**
 * 【归一化：把各种分隔符统一成空格】
 * 例："Monster.Island.2017" → "Monster Island 2017"
 * 正则 [.\s_\-] 表示：点号 / 空白 / 下划线 / 连字符，全部替换成一个空格。
 */
function normalizeSeparators(str) {
  return String(str || '').replace(/[.\s_\-]+/g, ' ').trim();
}

/**
 * 【紧凑化：去掉所有分隔符并转小写】
 * 例："Monster.Island.2017" → "monsterisland2017"
 * 这是最宽松的兜底匹配，只用来最后救场。
 */
function compactKey(str) {
  return String(str || '').replace(/[.\s_\-]+/g, '').toLowerCase();
}

/**
 * 【把一张映射表建成 3 个快速查询索引】
 *
 * 作用：查表时不用每次遍历整张表，直接用键去 Map.get()，速度快很多。
 *
 * 返回三个索引：
 *   rawIndex     —— 用「原样键」查询
 *   normIndex    —— 用「分隔符→空格后的键」查询（Monster.Island ≡ Monster Island）
 *   compactIndex —— 用「去掉分隔符小写后的键」查询（终极兜底）
 *
 * 说明：如果不同键归一化后撞到一起（例如 "A-B" 和 "A B"），
 *       只保留第一个出现的（与业务上「先写优先」的直觉一致）。
 */
function buildMappingIndex(table) {
  const rawIndex = new Map();
  const normIndex = new Map();
  const compactIndex = new Map();
  if (table instanceof Map) {
    for (const [key, value] of table.entries()) {
      const norm = normalizeSeparators(key);
      const compact = compactKey(key);
      if (!rawIndex.has(key)) rawIndex.set(key, value);
      if (key === norm) {
        if (!normIndex.has(key)) normIndex.set(key, value);
      } else if (!normIndex.has(norm)) {
        normIndex.set(norm, value);
      }
      if (compact && !compactIndex.has(compact)) compactIndex.set(compact, value);
    }
  }
  return { rawIndex, normIndex, compactIndex };
}

/**
 * 【根据剧名/季数/年份，生成所有“可能命中”的候选键】
 *
 * 为什么要生成这么多候选键？
 * 因为映射表里同一部剧可能以不同形态出现，例如：
 *   "Monster Island.2017.S01 -> 怪物岛"
 *   "Monster Island S01 -> 怪物岛"
 *   "Monster Island 2017 -> 怪物岛"
 *   "Monster Island -> 怪物岛"
 * 我们不知道用户写的文件名对应哪一种，所以把可能性都列出来挨个查。
 *
 * 候选顺序（从最精确到最宽泛）：
 *   剧名+年份+季  →  剧名+季  →  剧名+年份  →  裸剧名
 * 同时每个组合都生成「空格版」和「点号版」两种写法。
 *
 * @param {string} rawTitle 解析出的原始剧名
 * @param {number|null} season 季数（可为空）
 * @param {number|null} year  年份（可为空）
 * @returns {string[]} 候选键列表（已去重）
 */
export function buildMappingCandidateKeys(rawTitle, season = null, year = null) {
  const title = String(rawTitle || '').trim();
  if (!title) return [];  // 剧名是空的，没法生成任何候选

  // 转成数字并判断是否有效：季数和年份都必须是正整数才算数
  const seasonNumber = Number(season);
  const yearNumber = Number(year);
  const hasSeason = Number.isInteger(seasonNumber) && seasonNumber > 0;
  const hasYear = Number.isInteger(yearNumber) && yearNumber > 0;

  // 季数的两种写法：S1 和 S01 都要（现实中两种都常见）
  const tokens = [];
  if (hasSeason) tokens.push(`S${seasonNumber}`, `S${String(seasonNumber).padStart(2, '0')}`);
  if (hasYear) tokens.push(String(yearNumber));

  // ---------- 拼出各种组合 ----------
  const combos = [];
  const yearToken = hasYear ? String(yearNumber) : null;
  const seasonTokens = hasSeason ? [`S${seasonNumber}`, `S${String(seasonNumber).padStart(2, '0')}`] : [];

  // 组合 1：剧名 年份 季（两种先后顺序都试）
  // 例："Monster Island 2017 S01"、"Monster Island S01 2017"
  if (yearToken && seasonTokens.length) {
    for (const st of seasonTokens) {
      combos.push(`${title} ${yearToken} ${st}`, `${title} ${st} ${yearToken}`);
    }
  }

  // 组合 2：剧名 + 季（例："Monster Island S01"）
  if (seasonTokens.length) {
    for (const st of seasonTokens) combos.push(`${title} ${st}`);
  }

  // 组合 3：剧名 + 年份（例："Monster Island 2017"）
  if (yearToken) combos.push(`${title} ${yearToken}`);

  // 组合 4：裸剧名（例："Monster Island"），最通用的兜底
  combos.push(title);

  // ---------- 给每个组合生成「空格形态」和「归一化形态」两种写法 ----------
  // 例：combo="Monster.Island.2017.S01"
  //   → 原样 "Monster.Island.2017.S01"（有些表里就是这么写的）
  //   → 归一化 "Monster Island 2017 S01"（有些表里是空格）
  const keys = [];
  for (const combo of combos) {
    keys.push(combo, normalizeSeparators(combo));
  }
  // 用 Set 去重（可能有重复），再过滤掉空字符串
  return [...new Set(keys.filter(Boolean))];
}

/**
 * 【核心函数！把剧名映射成另一个剧名】
 *
 * 这个函数是整套映射功能的心脏，逻辑一句话概括：
 *   1. 根据输入剧名（+季数/年份）生成一串「候选关键词」
 *   2. 先在本地表里挨个查（本地优先）
 *   3. 本地没查到，再去远程表里挨个查（远程兜底）
 *   4. 哪一步查到了，就用「映射后的标题」替换原标题返回
 *   5. 全都没查到，返回原标题（不变）
 *
 * 例：输入 "Monster Island.2017.S01"（季=1 年份=2017）
 *   候选键："Monster Island 2017 S01"、"Monster Island S01 2017"、
 *           "Monster Island S01"、"Monster Island 2017"、"Monster Island" ...
 *   若表里有 "Monster Island -> 怪物岛"，则最终返回 "怪物岛"。
 *
 * @param {string} rawTitle 用户输入/解析出的原始剧名
 * @param {string} source   调用来源标识（match/fongmi/favorite/search），只用于日志
 * @param {number|null} season 季数（可为空）
 * @param {number|null} year  年份（可为空）
 * @returns {string} 映射后的标题；没命中就原样返回
 */
export function applyTitleMappingWithLog(rawTitle, source = 'system', season = null, year = null) {
  // 本地表每次实时读取「纯本地配置」而不是缓存快照：
  // 这样用户在设置页改了 TITLE_MAPPING_TABLE，下一次请求立即生效，
  // 也不会把远程的规则错误地当成本地规则。
  const localTable = readPureLocalMappingTable();
  const remoteTable = remoteState.mappings instanceof Map ? remoteState.mappings : new Map();

  // 生成候选键：剧名+年份+季 → 剧名+季 → 剧名+年份 → 裸剧名
  const candidateKeys = buildMappingCandidateKeys(rawTitle, season, year);

  // 把两张表各建成 3 个快速索引（精确/归一化/紧凑），方便下面直接查
  const localIndex = buildMappingIndex(localTable);
  const remoteIndex = buildMappingIndex(remoteTable);

  // ---------- 第一步：查本地表（优先级最高） ----------
  for (const key of candidateKeys) {
    // 先试原样键，再试「分隔符变空格」的键
    const localMapped = localIndex.rawIndex.get(key) ?? localIndex.normIndex.get(normalizeSeparators(key));
    if (localMapped) return localMapped;  // 本地表命中，直接返回
  }
  // 本地表终极兜底：去掉所有分隔符来查（例 "Monster.Island" ≡ "monsterisland"）
  const localCompactInput = compactKey(rawTitle);
  const localCompactMapped = localCompactInput ? localIndex.compactIndex.get(localCompactInput) : undefined;
  if (localCompactMapped !== undefined) return localCompactMapped;

  // ---------- 第二步：查远程表（本地没命中才到这里） ----------
  for (const key of candidateKeys) {
    const remoteMapped = remoteIndex.rawIndex.get(key) ?? remoteIndex.normIndex.get(normalizeSeparators(key));
    if (remoteMapped) {
      // 命中远程表：记一条成功日志（方便用户排查），然后返回映射结果
      logRemoteMapping("info", `[system] [remote-mapping] [远程] [${source}] ✅ 匹配成功: 「${key}」→「${remoteMapped}」`);
      return remoteMapped;
    }
  }

  // ---------- 第三步：远程表终极兜底（忽略所有分隔符） ----------
  const compactInput = compactKey(rawTitle);
  const remoteCompactMapped = compactInput ? remoteIndex.compactIndex.get(compactInput) : undefined;
  if (remoteCompactMapped !== undefined) {
    logRemoteMapping("info", `[system] [remote-mapping] [远程] [${source}] ✅ 匹配成功(紧凑): 「${rawTitle}」→「${remoteCompactMapped}」`);
    return remoteCompactMapped;
  }

  // ---------- 全都没查到：原样返回，并记录一次失败日志（便于排查） ----------
  logRemoteMapping("info", `[system] [remote-mapping] [远程] [${source}] ❌ 匹配失败: 「${rawTitle}」` +
    `（尝试键: ${candidateKeys.map(key => `「${key}」`).join('、') || '无'}）`);

  return rawTitle;  // 没命中就不改标题
}

/**
 * 手动搜索关键词经过映射表（供 GET /api/v2/search/anime 使用）。
 * 若关键词已是某条规则的映射结果（内部调用方已映射过），静默跳过避免重复处理与日志噪音。
 * @param {string} keyword 搜索关键词
 * @returns {string} 映射后的关键词（未命中则原样返回）
 */
/**
 * 【手动搜索关键词时的映射入口】
 * 调用场景：用户在搜索框输入关键词、或播客/第三方调 /api/v2/search/anime 时。
 *
 * 作用：把输入的关键词用映射表转成真实标题后再去搜索。
 * 例：输入 "宝可梦 地平线 烈空坐飞升" → 映射成 "本机目标" → 用 "本机目标" 搜索。
 *
 * 特殊处理：如果关键词本身已经是某条规则的「映射结果」
 * （说明它已经被内部调用方映射过一次了），就不重复映射，直接放行。
 */
export function applySearchKeywordMapping(keyword) {
  const table = globals.titleMappingTable instanceof Map ? globals.titleMappingTable : new Map();
  if (!keyword || table.size === 0) return keyword;  // 空关键词或空表，直接返回
  // 若关键词已经是某条规则的「值」= 已映射过，跳过避免二次映射与日志噪音
  if (new Set(table.values()).has(keyword)) return keyword;
  return applyTitleMappingWithLog(keyword, 'search');
}

/**
 * 【安排每天一次的定时更新】
 *
 * 目标时刻：北京时间 05:30。
 * 实现思路：算出「距离下次 05:30 还要等多少毫秒」，用一个 setTimeout 定住；
 * 到了就执行一次更新，更新完再重新安排下一天（循环）。
 *
 * 备注：Date.UTC 里用了 REMOTE_REFRESH_HOUR - 8，
 *       是因为服务器时间通常用 UTC，北京时间 = UTC + 8，
 *       所以要退 8 小时换算成 UTC 再去定闹钟。
 */
function scheduleRemoteRefresh(url) {
  // 已经安排过闹钟、没配地址、或环境不支持定时器——都直接跳过
  if (remoteSchedulerTimer || !url || typeof setTimeout !== 'function') return;

  const now = new Date();
  // 构造「今天北京时间 05:30 的 UTC 时刻」作为目标
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), REMOTE_REFRESH_HOUR - 8, REMOTE_REFRESH_MINUTE));
  // 如果目标时刻已经过去了（比如现在是 06:00），就把目标推到明天
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  // 距离下次更新要等多少毫秒（至少等 1 秒，避免极端情况为 0/负数）
  const delay = Math.max(1000, target.getTime() - now.getTime());

  remoteSchedulerTimer = setTimeout(async () => {
    remoteSchedulerTimer = null;                          // 闹钟已响，清空句柄
    await refreshRemoteTitleMapping(url, '北京时间 05:30 定时'); // 执行更新（内部最多重试 5 次）
    scheduleRemoteRefresh(url);                           // 更新完，重新安排明天的
  }, delay);

  // unref()：让这个定时器不阻止程序退出（Node 特性，不影响功能）
  if (typeof remoteSchedulerTimer?.unref === 'function') remoteSchedulerTimer.unref();
  logRemoteMapping("info", `[system] [remote-mapping] 已安排每日北京时间 05:30 更新`);
}

/**
 * 【管理员手动刷新远程映射表】——对应设置页的「立即更新」按钮
 *
 * 与每日定时更新不同之处：
 *   - 手动更新只尝试「1 次」，不再重试（用户点了就反馈，不干等）
 *   - 超时 5 秒就放弃，避免按钮一直转圈
 *   - 失败时保留旧缓存，绝不写入半截内容
 *
 * @returns {Promise<{success: boolean, count: number, error?: string}>}
 *           success=true 表示更新成功，count=新规则数量
 */
export async function refreshRemoteTitleMappingNow() {
  const url = normalizeMappingSourceUrl(globals.titleMappingTableUrl);
  // 没配置远程地址：直接告诉前端“没配置”
  if (!url) return { success: false, count: remoteState.mappings.size, error: '未配置 TITLE_MAPPING_TABLE_URL' };

  // 如果刚好有个更新任务在跑（比如定时更新），拒绝并提示，避免并发
  if (remoteRefreshInProgress) {
    logRemoteMapping("warn", '[system] [remote-mapping] 管理员手动更新被拒绝：已有更新任务进行中');
    return { success: false, count: remoteState.mappings.size, error: '已有远程映射表更新任务进行中' };
  }

  logRemoteMapping("info", '[system] [remote-mapping] 管理员手动更新开始（仅尝试 1 次，超时 5 秒）');
  try {
    // 下载 → 解析 → 校验 → 写入内存 → 写磁盘缓存（一条龙）
    await fetchRemoteMappings(url);
    remoteState.failedAt = 0;
    ensureMergedIntoGlobals();
    logRemoteMapping("info", `[system] [remote-mapping] 管理员手动更新成功（${remoteState.mappings.size} 条）`);
    return { success: true, count: remoteState.mappings.size };
  } catch (e) {
    // 失败：记下失败时间，返回具体原因给前端；旧缓存继续保留
    remoteState.failedAt = Date.now();
    const reason = e?.name === 'AbortError' ? '请求超时（5 秒）' : (e?.message || String(e));
    logRemoteMapping("error", `[system] [remote-mapping] 管理员手动更新失败：${reason}；保留旧缓存，不写入新表`);
    return { success: false, count: remoteState.mappings.size, error: reason };
  }
}

/**
 * 【读取“纯本地”映射表】
 *
 * 为什么不能直接用 globals.titleMappingTable？
 * 因为那份可能是「本地+远程合并后的结果」，里面混着远程规则。
 * 而我们想要的是用户自己填的 TITLE_MAPPING_TABLE，必须是纯净的本地规则。
 *
 * 优先读 globals.envs.titleMappingTable（envs 里保存的是解析后的纯本地表）；
 * 万一不存在（边缘情况），才退回用 globals 里的合并表。
 */
function readPureLocalMappingTable() {
  const envsTable = globals.envs?.titleMappingTable;
  if (envsTable instanceof Map) return new Map(envsTable);
  const fallback = globals.titleMappingTable instanceof Map ? globals.titleMappingTable : new Map();
  return new Map(fallback);
}

/**
 * 【确保远程映射表“就绪可用”】——每次匹配前调用一次的“保险开关”
 *
 * 做的事情（按顺序）：
 *   1. 若本地配置变了，刷新本地表快照（防止旧远程键残留）
 *   2. 安排每天 05:30 的定时更新（只安排一次）
 *   3. 如果内存里还没有这个地址的远程表 ——
 *      a. 先试试从磁盘缓存恢复（上次下载过的）
 *      b. 磁盘也没有 → 首次初始化联网下载一次（内部最多重试 5 次）
 *   4. 最后把本地表 + 远程表合并成完整的全局表
 *
 * 注意：正常匹配过程「绝不」因为表过期就联网——只有首次没有缓存时才联网，
 *       其余时候全靠内存/磁盘，保证速度快、且不依赖网络。
 */
export async function ensureRemoteTitleMapping(force = false) {
  const urlSetting = normalizeMappingSourceUrl(globals.titleMappingTableUrl);

  // 1. 本地配置（可能是用户刚改的）始终以纯本地表为准，刷新快照并强制重新合并
  if (globals.envs?.titleMappingTable instanceof Map) {
    remoteState.localMappings = new Map(globals.envs.titleMappingTable);
    remoteState.mergedRef = null;
  }

  // 没配置远程地址：无事可做，直接返回
  if (!urlSetting) return;

  // 2. 安排每天 05:30 的定时更新（内部有“只安排一次”的保护）
  scheduleRemoteRefresh(urlSetting);

  // 3a. 内存里没有这个地址的表 → 尝试从磁盘缓存恢复
  if (remoteState.url !== urlSetting || remoteState.mappings.size === 0) {
    remoteState.localMappings = readPureLocalMappingTable();
    await loadDiskRemoteMapping(urlSetting);
  }

  // 3b. 磁盘恢复也失败 → 首次初始化联网下载（同一地址整个进程只试一次）
  if (remoteState.url !== urlSetting || remoteState.mappings.size === 0) {
    if (remoteState.initialAttemptedUrl !== urlSetting) {
      remoteState.initialAttemptedUrl = urlSetting;
      // remoteState.fetching 去重：如果已有一个下载任务在进行，直接复用而不是再开一个
      if (!remoteState.fetching) {
        remoteState.fetching = refreshRemoteTitleMapping(urlSetting, '首次初始化').finally(() => { remoteState.fetching = null; });
      }
      await remoteState.fetching;
    }
  }

  // 4. 重新合并本地 + 远程，写入全局表（只使用内存/磁盘内容，无网络操作）
  ensureMergedIntoGlobals();
}
