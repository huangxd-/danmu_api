/**
 * @fileoverview 智能 ESM 兼容层 (Shim)
 * @module esm-shim
 * @description
 * 本模块旨在解决 Node.js 低版本环境下 CommonJS 与 ESM 混用的兼容性问题。
 * * * 技术背景：
 * Node.js 直到 v20.19.0 (以及 v22.12.0+, v23.0.0+) 才正式原生支持
 * `require()` 同步加载 ESM 模块。在此版本之前，若 CommonJS 入口文件尝试
 * 加载 ESM 编写的业务代码或第三方库（如 node-fetch v3），会抛出 `ERR_REQUIRE_ESM` 错误。
 * * * 实现原理：
 * 本模块通过 Hook Node.js 的模块加载系统，利用 esbuild 在运行时即时将 ESM 语法
 * 转译为 CommonJS，从而在旧版 Node.js 环境下“欺骗”系统，实现无缝运行。
 */

const Module = require('module');
const path = require('path');

// ============================================================================
// Constants & Configuration (常量配置)
// ============================================================================

/** 项目根目录，用于限制转译范围 */
const PROJECT_ROOT = path.resolve(__dirname);

/** 目标兼容的最低 Node.js 版本
 * Node.js v20.19.0 是原生支持 require(esm) 的分水岭版本
 */
const TARGET_NODE_VERSION = '20.19.0';

/** 需要特殊兼容处理的纯 ESM 第三方包名 */
const TARGET_PKG_NAME = 'node-fetch';

/** 日志输出前缀 */
const LOG_PREFIX = '[esm-shim]';

/**
 * CommonJS 导出对象同步补丁
 * @constant {string}
 * @description
 * esbuild 将 ESM 转译为 CJS 后，默认使用 module.exports = ... 赋值。
 * 此代码片段追加在转译结果后，确保 module.exports 与 exports 对象保持同步，
 * 防止因导出方式差异导致调用方获取不到预期的方法。
 */
const CJS_EXPORTS_FIX = `
;(function(){
  if(exports!==module.exports && typeof exports==='object'){
    Object.keys(exports).forEach(k=>{
      if(k!=='__esModule' && !(k in module.exports)) module.exports[k]=exports[k]
    })
  };
  if(typeof module.exports==='object' && Object.keys(module.exports).length===0){
    Object.keys(exports).forEach(k=>{
      if(k!=='__esModule') module.exports[k]=exports[k]
    })
  }
})();
`;

// ============================================================================
// Utilities (工具函数)
// ============================================================================

/**
 * 比较两个语义化版本号
 * @param {string} v1 - 当前版本号
 * @param {string} v2 - 目标版本号
 * @returns {number} 1: v1 > v2, -1: v1 < v2, 0: v1 == v2
 */
function compareSemVer(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * 环境检测结果结构体
 * @typedef {Object} EnvCheckResult
 * @property {string} nodeVersion - 当前运行时 Node.js 版本
 * @property {string} nodeFetchVersion - 检测到的 node-fetch 版本
 * @property {boolean} isNodeCompatible - 当前 Node 版本是否原生支持 require(esm)
 * @property {boolean} isNodeFetchV3 - 是否使用了纯 ESM 版的 node-fetch
 * @property {boolean} needsShim - 是否需要激活兼容层
 */

/**
 * 检测当前运行环境并决定兼容策略
 * @returns {EnvCheckResult} 环境检测结果
 */
function detectEnvironment() {
  const nodeVersion = process.versions.node;
  // 判断当前 Node 版本是否 >= 20.19.0 (原生支持 require ESM)
  const isNodeCompatible = compareSemVer(nodeVersion, TARGET_NODE_VERSION) >= 0;
  
  let nodeFetchVersion = 'not found';
  let isNodeFetchV3 = false;
  let needsShim = false;
  
  try {
    const packagePath = require.resolve(`${TARGET_PKG_NAME}/package.json`);
    // eslint-disable-next-line import/no-dynamic-require
    const pkg = require(packagePath);
    nodeFetchVersion = pkg.version;
    // 检测是否为 v3.x (纯 ESM 版本)
    isNodeFetchV3 = pkg.version.startsWith('3.');
    
    // 决策逻辑：仅在 Node 版本过低 且 必须加载 ESM 资源时才激活 Shim
    needsShim = !isNodeCompatible && isNodeFetchV3;
    
  } catch (e) {
    // 依赖未安装或无法解析，默认不启用 Shim
    needsShim = false;
  }
  
  return {
    nodeVersion,
    nodeFetchVersion,
    isNodeCompatible,
    isNodeFetchV3,
    needsShim
  };
}

// ============================================================================
// Main Execution Flow (主执行流程)
// ============================================================================

const env = detectEnvironment();

console.log(`${LOG_PREFIX} Environment: Node ${env.nodeVersion}, node-fetch ${env.nodeFetchVersion}`);
console.log(`${LOG_PREFIX} Node.js compatible (>=${TARGET_NODE_VERSION}): ${env.isNodeCompatible}`);
console.log(`${LOG_PREFIX} node-fetch v3: ${env.isNodeFetchV3}`);
console.log(`${LOG_PREFIX} Needs shim: ${env.needsShim}`);

if (!env.needsShim) {
  // --- 场景 A: 无需激活兼容层 ---
  // 根据不同情况输出提示日志，明确为何不需要 Shim
  if (env.isNodeCompatible && env.isNodeFetchV3) {
    console.log(`${LOG_PREFIX} Node.js >=${TARGET_NODE_VERSION} + node-fetch v3: optimal compatibility, shim disabled`);
  } else if (env.isNodeCompatible && !env.isNodeFetchV3) {
    console.log(`${LOG_PREFIX} Node.js >=${TARGET_NODE_VERSION} + node-fetch v2: native compatibility, shim disabled`);
  } else if (!env.isNodeCompatible && !env.isNodeFetchV3) {
    console.log(`${LOG_PREFIX} Node.js <${TARGET_NODE_VERSION} + node-fetch v2: no ESM issues, shim disabled`);
  } else {
    console.log(`${LOG_PREFIX} Shim disabled for optimal performance`);
  }
  
  // 导出空函数以保持 API 签名一致，防止 Server 代码调用报错
  global.loadNodeFetch = async () => {
    console.log(`${LOG_PREFIX} loadNodeFetch called but not needed in this environment`);
    return Promise.resolve();
  };
  
} else {
  // --- 场景 B: 激活兼容层 ---
  enableShim();
}

/**
 * 激活 ESM 兼容层
 * 注入模块加载钩子，处理第三方 ESM 包和项目内 ESM 源码
 */
function enableShim() {
  console.log(`${LOG_PREFIX} Compatibility shim enabled for Node.js <${TARGET_NODE_VERSION} + node-fetch v3`);

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (err) {
    console.error(`${LOG_PREFIX} missing dependency: run \`npm install esbuild\``);
    throw err;
  }

  // ==========================================================================
  // Part 1: node-fetch v3 Interop (第三方 ESM 包兼容)
  // ==========================================================================

  let fetchCache = null;
  let fetchPromise = null;

  /**
   * 异步加载 node-fetch v3
   * @description
   * 在旧版 Node.js 中，require() 无法加载 ESM。
   * 必须使用 import() 动态导入，并缓存结果供后续同步 require 伪装使用。
   * @returns {Promise<Object>} 加载完成的模块对象
   */
  async function loadNodeFetchV3() {
    if (fetchCache) return fetchCache;
    if (fetchPromise) return fetchPromise;
    
    fetchPromise = (async () => {
      try {
        console.log(`${LOG_PREFIX} Loading node-fetch v3 ESM module...`);
        // 使用 dynamic import 加载 ESM
        const fetchModule = await import(TARGET_PKG_NAME);
        
        fetchCache = {
          default: fetchModule.default,
          fetch: fetchModule.default,
          Request: fetchModule.Request,
          Response: fetchModule.Response, 
          Headers: fetchModule.Headers,
          FormData: fetchModule.FormData,
          AbortError: fetchModule.AbortError,
          FetchError: fetchModule.FetchError
        };
        
        console.log(`${LOG_PREFIX} node-fetch v3 loaded successfully`);
        return fetchCache;
      } catch (error) {
        console.error(`${LOG_PREFIX} Failed to load node-fetch v3:`, error.message);
        throw error;
      }
    })();
    
    return fetchPromise;
  }

  /**
   * 创建同步代理对象
   * @description
   * 构造一个伪装对象，拦截同步调用并转发给已缓存的 ESM 模块。
   * 调用前必须确保 loadNodeFetchV3 已完成。
   */
  function createFetchCompat() {
    const syncFetch = function(...args) {
      if (!fetchCache) {
        throw new Error(
          `${LOG_PREFIX} node-fetch v3 must be loaded asynchronously first. ` +
          'Call await global.loadNodeFetch() in your startup code.'
        );
      }
      return fetchCache.fetch(...args);
    };

    const properties = ['Request', 'Response', 'Headers', 'FormData', 'AbortError', 'FetchError'];
    
    properties.forEach(prop => {
      Object.defineProperty(syncFetch, prop, {
        get() {
          if (!fetchCache) {
            throw new Error(
              `${LOG_PREFIX} node-fetch v3.${prop} must be loaded asynchronously first. ` +
              'Call await global.loadNodeFetch() in your startup code.'
            );
          }
          return fetchCache[prop];
        },
        enumerable: true,
        configurable: true
      });
    });

    // 兼容 CommonJS 的 default 导出习惯
    Object.defineProperty(syncFetch, 'default', {
      get() { return syncFetch; },
      enumerable: true,
      configurable: true
    });

    return syncFetch;
  }

  // ==========================================================================
  // Part 2: Source Code Transformation (项目源码兼容)
  // ==========================================================================

  /**
   * 预处理 ESM 特有语法
   * @param {string} content - 源代码内容
   * @param {string} filename - 文件名
   * @description
   * 处理 esbuild 可能无法直接完美转换的特殊 ESM 语法：
   * 1. 动态 import() -> Promise.resolve(require())
   * 2. import.meta.url -> 手动构建 fileURL
   */
  function preprocessESMFeatures(content, filename) {
    let modified = content;
    const baseName = path.basename(filename);
    
    // Polyfill 1: 动态 import()
    if (modified.includes('import(')) {
       modified = modified.replace(
        /(await\s+)?import\s*\(((?:[^()]|\([^)]*\))*)\)/g,
        (match, awaitKeyword, importArg) => {
          console.log(`${LOG_PREFIX} Converting dynamic import in ${baseName}`);
          return `${awaitKeyword || ''}Promise.resolve(require(${importArg}))`;
        }
      );
    }
    
    // Polyfill 2: import.meta.url
    if (content.includes('import.meta.url')) {
      const injectionKey = '__importMetaUrl';
      if (content.includes(injectionKey)) {
        // 如果已存在注入标记，仅做替换
        modified = modified.replace(/import\.meta\.url/g, injectionKey);
      } else {
        console.log(`${LOG_PREFIX} Fixing import.meta.url in ${baseName}`);
        const metaUrlFix = `const ${injectionKey} = require('url').pathToFileURL(__filename).href;\n`;
        modified = metaUrlFix + modified;
        modified = modified.replace(/import\.meta\.url/g, injectionKey);
      }
    }
    
    return modified;
  }

  // ==========================================================================
  // Part 3: Hooks Installation (注入运行时钩子)
  // ==========================================================================

  // Hook 1: 拦截模块加载请求 (Module._load)
  // 目的：当代码尝试 require('node-fetch') 时，返回我们构造的兼容对象
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === TARGET_PKG_NAME) {
      console.log(`${LOG_PREFIX} Intercepting node-fetch require`);
      return createFetchCompat();
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  // Hook 2: 拦截源码编译过程 (Module.prototype._compile)
  // 目的：在 Node.js 编译 JS 文件前，使用 esbuild 将 ESM 语法转译为 CJS
  const originalCompile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    try {
      // 仅处理项目源码目录下的文件，排除 node_modules
      const isProjectFile = typeof filename === 'string' && 
                            filename.startsWith(PROJECT_ROOT) && 
                            !filename.includes('node_modules');

      const hasESMKeywords = /\b(?:import|export)\b/.test(content);

      if (isProjectFile && hasESMKeywords) {
        console.log(`${LOG_PREFIX} Transforming ESM syntax in: ${path.relative(PROJECT_ROOT, filename)}`);
        
        // 步骤 A: 预处理特殊语法
        const preprocessed = preprocessESMFeatures(content, filename);
        
        // 步骤 B: esbuild 转译 (ESM -> CJS)
        const out = esbuild.transformSync(preprocessed, {
          loader: 'js',
          format: 'cjs',
          target: 'es2018',
          sourcemap: 'inline',
        });
        
        // 步骤 C: 注入 Exports 修复补丁
        const fixedCode = out.code + CJS_EXPORTS_FIX;
        
        return originalCompile.call(this, fixedCode, filename);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} esbuild transform failed:`, filename, e.message || e);
    }
    
    return originalCompile.call(this, content, filename);
  };

  // 暴露全局加载器供 Server 启动时调用
  global.loadNodeFetch = loadNodeFetchV3;
  console.log(`${LOG_PREFIX} ESM compatibility shim active with hooks installed`);
}
