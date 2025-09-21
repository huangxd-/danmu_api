// server.js - 智能启动，根据环境自动选择最优方案
require('./esm-shim'); // 总是加载，但内部会判断是否需要启用

const http = require('http');

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

// 检测是否需要异步启动
function needsAsyncStartup() {
  try {
    const nodeVersion = process.versions.node;
    const isNodeCompatible = compareVersion(nodeVersion, '20.19.0') >= 0;
    
    // 尝试检测 node-fetch 版本
    const packagePath = require.resolve('node-fetch/package.json');
    const pkg = require(packagePath);
    const isNodeFetchV3 = pkg.version.startsWith('3.');
    
    // 核心逻辑：只有在 Node.js < v20.19.0 + node-fetch v3 时才需要异步启动
    const needsAsync = !isNodeCompatible && isNodeFetchV3;
    
    console.log(`[server] Environment check: Node ${nodeVersion}, node-fetch ${pkg.version}`);
    console.log(`[server] Node.js compatible (>=20.19.0): ${isNodeCompatible}`);
    console.log(`[server] node-fetch v3: ${isNodeFetchV3}`);
    console.log(`[server] Needs async startup: ${needsAsync}`);
    
    return needsAsync;
    
  } catch (e) {
    // 无法检测或者 node-fetch 不存在，使用同步启动
    console.log('[server] Cannot detect node-fetch, using sync startup');
    return false;
  }
}

// 核心服务器逻辑（抽取为函数，避免重复）
function createServer() {
  const fetch = require('node-fetch');
  const { Request, Response } = fetch;
  const worker = require('./worker.js');

  return http.createServer(async (req, res) => {
    try {
      // Construct the full URL
      const fullUrl = `http://${req.headers.host}${req.url}`;
      
      // Convert Node.js request body to a string for POST/PUT requests
      let body;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      // Create a Web API-compatible Request object
      const webRequest = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: body || undefined,
      });

      // Call the worker's fetch handler
      const webResponse = await worker.default.fetch(webRequest, {}, {});

      // Convert Web API Response to Node.js response
      res.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const responseText = await webResponse.text();
      res.end(responseText);
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
}

// 同步启动（适用于兼容环境）
function startServerSync() {
  console.log('[server] Starting server synchronously (optimal path)');
  
  const server = createServer();
  
  server.listen(9321, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:9321');
  });
}

// 异步启动（适用于需要兼容的环境：Node.js < v20.19.0 + node-fetch v3）
async function startServerAsync() {
  try {
    console.log('[server] Starting server asynchronously (compatibility mode for Node.js <20.19.0 + node-fetch v3)');
    
    // 预加载 node-fetch v3
    if (typeof global.loadNodeFetch === 'function') {
      console.log('[server] Pre-loading node-fetch v3...');
      await global.loadNodeFetch();
      console.log('[server] node-fetch v3 loaded successfully');
    }

    const server = createServer();
    
    server.listen(9321, '0.0.0.0', () => {
      console.log('Server running on http://0.0.0.0:9321 (compatibility mode)');
    });

  } catch (error) {
    console.error('[server] Failed to start server:', error);
    process.exit(1);
  }
}

// 智能选择启动方式
if (needsAsyncStartup()) {
  startServerAsync();
} else {
  startServerSync();
}
