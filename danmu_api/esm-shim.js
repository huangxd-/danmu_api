// danmu_api/esm-shim.js
// 智能兼容 shim - 只在需要时才启用
// 兼容 Node.js < v20.19.0 + node-fetch v3 的情况

const Module = require('module');
const path = require('path');
const projectRoot = path.resolve(__dirname);

// 比较版本号的辅助函数
function compareVersion(version1, version2) {
  const v1Parts = version1.split('.').map(Number);
  const v2Parts = version2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;
    
    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }
  
  return 0;
}

// 环境检测函数
function detectEnvironment() {
  const nodeVersion = process.versions.node;
  const isNodeCompatible = compareVersion(nodeVersion, '20.19.0') >= 0;
  
  let nodeFetchVersion = '2';
  let isNodeFetchV3 = false;
  let needsShim = false;
  
  try {
    // 尝试检测 node-fetch 版本
    const packagePath = require.resolve('node-fetch/package.json');
    const pkg = require(packagePath);
    nodeFetchVersion = pkg.version;
    isNodeFetchV3 = pkg.version.startsWith('3.');
    
    // 核心逻辑：只有在 Node.js < v20.19.0 且使用 node-fetch v3 时才需要 shim
    needsShim = !isNodeCompatible && isNodeFetchV3;
    
  } catch (e) {
    // node-fetch 未安装或无法检测，假设不需要 shim
    needsShim = false;
    nodeFetchVersion = 'not found';
  }
  
  return {
    nodeVersion,
    nodeFetchVersion,
    isNodeCompatible,
    isNodeFetchV3,
    needsShim
  };
}

// 检测环境
const env = detectEnvironment();

console.log(`[esm-shim] Environment: Node ${env.nodeVersion}, node-fetch ${env.nodeFetchVersion}`);
console.log(`[esm-shim] Node.js compatible (>=20.19.0): ${env.isNodeCompatible}`);
console.log(`[esm-shim] node-fetch v3: ${env.isNodeFetchV3}`);
console.log(`[esm-shim] Needs shim: ${env.needsShim}`);

// 只在需要时才启用 shim
if (!env.needsShim) {
  if (env.isNodeCompatible && env.isNodeFetchV3) {
    console.log('[esm-shim] Node.js >=20.19.0 + node-fetch v3: optimal compatibility, shim disabled');
  } else if (env.isNodeCompatible && !env.isNodeFetchV3) {
    console.log('[esm-shim] Node.js >=20.19.0 + node-fetch v2: native compatibility, shim disabled');
  } else if (!env.isNodeCompatible && !env.isNodeFetchV3) {
    console.log('[esm-shim] Node.js <20.19.0 + node-fetch v2: no ESM issues, shim disabled');
  } else {
    console.log('[esm-shim] Shim disabled for optimal performance');
  }
  
  // 导出空的加载函数，保持接口一致性
  global.loadNodeFetch = async () => {
    console.log('[esm-shim] loadNodeFetch called but not needed in this environment');
    return Promise.resolve();
  };
  
  // 直接返回，不安装任何 hook
  return;
}

console.log('[esm-shim] Compatibility shim enabled for Node.js <20.19.0 + node-fetch v3');

// 以下是 shim 逻辑，只在 Node.js < v20.19.0 + node-fetch v3 时执行
let esbuild;
try {
  esbuild = require('esbuild');
} catch (err) {
  console.error('[esm-shim] missing dependency: run `npm install esbuild`');
  throw err;
}

// ------------------- _compile hook -------------------
const origCompile = Module.prototype._compile;
Module.prototype._compile = function (content, filename) {
  try {
    if (
      typeof filename === 'string' &&
      filename.startsWith(projectRoot) &&
      !filename.includes('node_modules') &&
      /\b(?:import|export)\b/.test(content)
    ) {
      console.log(`[esm-shim] Transforming ESM syntax in: ${path.relative(projectRoot, filename)}`);
      const out = esbuild.transformSync(content, {
        loader: 'js',
        format: 'cjs',
        target: 'es2018',
        sourcemap: 'inline',
      });
      return origCompile.call(this, out.code, filename);
    }
  } catch (e) {
    console.error('[esm-shim] esbuild transform failed:', filename, e.message || e);
  }
  return origCompile.call(this, content, filename);
};

// ------------------- _load hook for node-fetch v3 -------------------
let fetchCache = null;
let fetchPromise = null;

// 异步加载 node-fetch v3
async function loadNodeFetchV3() {
  if (fetchCache) return fetchCache;
  if (fetchPromise) return fetchPromise;
  
  fetchPromise = (async () => {
    try {
      console.log('[esm-shim] Loading node-fetch v3 ESM module...');
      const fetchModule = await import('node-fetch');
      
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
      
      console.log('[esm-shim] node-fetch v3 loaded successfully');
      return fetchCache;
    } catch (error) {
      console.error('[esm-shim] Failed to load node-fetch v3:', error.message);
      throw error;
    }
  })();
  
  return fetchPromise;
}

// 创建 node-fetch v3 兼容层
function createFetchCompat() {
  const syncFetch = function(...args) {
    if (!fetchCache) {
      throw new Error(
        '[esm-shim] node-fetch v3 must be loaded asynchronously first. ' +
        'Call await global.loadNodeFetch() in your startup code.'
      );
    }
    return fetchCache.fetch(...args);
  };

  // 为兼容层添加所有 node-fetch v3 的属性
  const properties = ['Request', 'Response', 'Headers', 'FormData', 'AbortError', 'FetchError'];
  
  properties.forEach(prop => {
    Object.defineProperty(syncFetch, prop, {
      get() {
        if (!fetchCache) {
          throw new Error(
            `[esm-shim] node-fetch v3.${prop} must be loaded asynchronously first. ` +
            'Call await global.loadNodeFetch() in your startup code.'
          );
        }
        return fetchCache[prop];
      },
      enumerable: true,
      configurable: true
    });
  });

  // 添加 default 属性以保持兼容性
  Object.defineProperty(syncFetch, 'default', {
    get() { return syncFetch; },
    enumerable: true,
    configurable: true
  });

  return syncFetch;
}

// 拦截 node-fetch 的 require 调用
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') {
    console.log('[esm-shim] Intercepting node-fetch require');
    
    // 在这个环境下，我们知道是 node-fetch v3，直接返回兼容层
    return createFetchCompat();
  }

  return origLoad.call(this, request, parent, isMain);
};

// 导出加载函数
global.loadNodeFetch = loadNodeFetchV3;

console.log('[esm-shim] ESM compatibility shim active with hooks installed');