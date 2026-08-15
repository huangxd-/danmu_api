import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'node:path';

// 动态获取版本号
import { Globals } from './danmu_api/configs/globals.js';

// 定义要排除的UI相关模块
const uiModules = [
  './ui/template.js',
  '../ui/template.js',
  '../../ui/template.js',
  './ui/css/base.css.js',
  './ui/css/components.css.js',
  './ui/css/forms.css.js',
  './ui/css/responsive.css.js',
  './ui/js/main.js',
  './ui/js/preview.js',
  './ui/js/logview.js',
  './ui/js/apitest.js',
  './ui/js/pushdanmu.js',
  './ui/js/systemsettings.js',
  './utils/local-redis-util.js',
  './utils/bangumi-data-util.js',
  'danmu_api/ui/template.js',
  'danmu_api/ui/css/base.css.js',
  'danmu_api/ui/css/components.css.js',
  'danmu_api/ui/css/forms.css.js',
  'danmu_api/ui/css/responsive.css.js',
  'danmu_api/ui/js/main.js',
  'danmu_api/ui/js/preview.js',
  'danmu_api/ui/js/logview.js',
  'danmu_api/ui/js/apitest.js',
  'danmu_api/ui/js/pushdanmu.js',
  'danmu_api/ui/js/systemsettings.js',
  'danmu_api/utils/local-redis-util.js',
  'danmu_api/utils/bangumi-data-util.js'
];

let customPolyfillContent = fs.readFileSync('forward/custom-polyfill.js', 'utf8');
const debugBuild = process.argv.includes('--debug');
const outputFile = debugBuild ? 'dist/logvar-danmu.debug.js' : 'dist/logvar-danmu.js';

// ForwardWidget runs in a browser-like JS runtime, so Node built-ins must not
// leak into the bundle. The server still imports the native implementations.
const forwardRuntimeCompatPlugin = {
  name: 'forward-runtime-compat',
  setup(build) {
    const danAnyModulePath = path.resolve('danmu_api/utils/dan-any.js');

    // Forward only consumes the native JSON/XML response paths. Keep dan-any
    // available to the server while removing it and its transitive dependencies
    // from the standalone widget bundle.
    build.onResolve({ filter: /(?:^|[\\/])dan-any\.js$/ }, (args) => {
      if (path.resolve(args.resolveDir, args.path) !== danAnyModulePath) return;
      return { path: 'dan-any', namespace: 'forward-optional-modules' };
    });

    build.onResolve({ filter: /^node:async_hooks$/ }, () => ({
      path: 'async-hooks',
      namespace: 'forward-node-builtins'
    }));

    build.onResolve({ filter: /^node:(?:http|https)$/ }, (args) => ({
      path: args.path.slice('node:'.length),
      namespace: 'forward-node-builtins'
    }));

    // brotli ships a compressed dictionary specifically for browser bundles.
    build.onResolve({ filter: /^\.\/dictionary-data$/ }, (args) => {
      if (/[\\/]node_modules[\\/]brotli[\\/]dec[\\/]dictionary\.js$/.test(args.importer)) {
        return { path: path.resolve('node_modules/brotli/dec/dictionary-browser.js') };
      }
    });

    build.onLoad({ filter: /^async-hooks$/, namespace: 'forward-node-builtins' }, () => ({
      loader: 'js',
      contents: `
        export class AsyncLocalStorage {
          constructor() {
            this.store = undefined;
          }

          getStore() {
            return this.store;
          }

          run(store, callback, ...args) {
            const previousStore = this.store;
            this.store = store;
            try {
              return callback(...args);
            } finally {
              this.store = previousStore;
            }
          }
        }
      `
    }));

    build.onLoad({ filter: /^(?:http|https)$/, namespace: 'forward-node-builtins' }, () => ({
      loader: 'js',
      contents: `export default { Agent: class Agent {} };`
    }));

    build.onLoad({ filter: /^dan-any$/, namespace: 'forward-optional-modules' }, () => ({
      loader: 'js',
      contents: `
        export const danAnyFormats = [];
        export function convertDanAny() {
          return null;
        }
      `
    }));
  }
};

(async () => {
  try {
    await esbuild.build({
      entryPoints: ['forward/forward-widget.js'], // 新的入口文件
      bundle: true,
      minify: false, // 暂时关闭压缩以便调试
      minifySyntax: true, // 折叠 debug 编译期开关，但保留可读变量名
      sourcemap: false,
      platform: 'neutral', // 改为neutral以避免Node.js特定的全局变量
      target: 'es2020',
      outfile: outputFile,
      format: 'esm', // 保持ES模块格式
      external: ['redis', 'fs', 'path', 'stream/promises', 'node-fetch'],
      plugins: [
        forwardRuntimeCompatPlugin,
        // 插件：排除UI相关模块
        {
          name: 'exclude-ui-modules',
          setup(build) {
            // 拦截对UI相关模块的导入
            build.onResolve({ filter: /.*ui.*\.(css|js)$|.*template\.js$|.*local-redis-util\.js$|.*bangumi-data-util\.js$/ }, (args) => {
              // 直接匹配 bangumi-data-util.js 和 local-redis-util.js
              if (args.path.includes('bangumi-data-util.js') || args.path.includes('local-redis-util.js')) {
                return { path: args.path, external: true };
              }
              if (uiModules.some(uiModule => args.path.includes(uiModule.replace('./', '').replace('../', '')))) {
                return { path: args.path, external: true };
              }
            });
          }
        },
        // 插件：移除导出语句（仅对输出文件进行处理）
        {
          name: 'remove-exports',
          setup(build) {
            build.onEnd(async (result) => {
              if (result.errors.length === 0) {
                let outputContent = fs.readFileSync(outputFile, 'utf8');
                
                // 更通用的模式，匹配包含这四个函数名的导出语句
                const genericExportPattern = /export\s*{\s*(?:\s*(?:getCommentsById|getDanmuWithSegmentTime|getDetailById|searchDanmu)\s*,?\s*){4}\s*};?/g;
                outputContent = outputContent.replace(genericExportPattern, '');

                // 替换 httpGet 和 httpPost
                const httpGetReplacement = debugBuild ? 'forwardDebugHttpGet' : 'Widget.http.get';
                const httpPostReplacement = debugBuild ? 'forwardDebugHttpPost' : 'Widget.http.post';
                // Replace awaited and promise-style calls while preserving the bundled declarations.
                outputContent = outputContent.replace(/(?<!function\s)\bhttpGet\s*\(/g, `${httpGetReplacement}(`);
                outputContent = outputContent.replace(/(?<!function\s)\bhttpPost\s*\(/g, `${httpPostReplacement}(`);

                // Keep line removal linear even when dependencies contain very
                // large single-line dictionaries (for example, opencc-js).
                const excludedLineFragments = [
                  'setLocalRedisKey',
                  'updateLocalRedisCaches',
                  'bangumi-data-util.js'
                ];
                outputContent = outputContent
                  .split(/\r?\n/)
                  .filter(line => !excludedLineFragments.some(fragment => line.includes(fragment)))
                  .join('\n');
                
                // 保存修改后的内容
                fs.writeFileSync(outputFile, outputContent);
              }
            });
          }
        }
      ],
      define: {
        'widgetVersion': `"${Globals.VERSION}"`,
        'globalThis.__FORWARD_WIDGET__': 'true',
        'globalThis.__FORWARD_WIDGET_DEBUG__': debugBuild ? 'true' : 'false'
      },
      banner: {
        js: customPolyfillContent
      },
      logLevel: 'info'
    });
    
    console.log(`Forward widget ${debugBuild ? 'debug ' : ''}bundle created successfully: ${outputFile}`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exitCode = 1;
  } finally {
    await esbuild.stop();
  }
})();
