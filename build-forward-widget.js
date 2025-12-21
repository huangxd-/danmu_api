const esbuild = require('esbuild');

// 动态获取版本号
const { Globals } = require('./danmu_api/configs/globals.js');

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
  'danmu_api/ui/js/systemsettings.js'
];

// 自定义URL类实现
const customURLImplementation = `
class CustomURL {
  constructor(url, base) {
    if (base) {
      // 如果提供了基础URL，拼接相对路径
      if (url.startsWith('/')) {
        // 处理绝对路径形式
        const baseWithoutPath = base.replace(/\\/[^\\/]*$/, '');
        this._url = baseWithoutPath + url;
      } else if (url.startsWith('./') || !url.startsWith('http')) {
        // 处理相对路径
        const baseWithoutFile = base.replace(/\\/[^\\/]*$/, '');
        this._url = baseWithoutFile + '/' + url.replace('./', '');
      } else {
        this._url = url;
      }
    } else {
      this._url = url;
    }

    // 解析URL组件
    this.parseURL(this._url);
  }

  parseURL(url) {
    // 基础URL解析逻辑
    const match = url.match(/^([^:]+):\\/\\/([^\\/]+)(.*)$/);
    if (match) {
      this.protocol = match[1] + ':';
      this.hostname = match[2];
      const pathAndQuery = match[3] || '';
      const queryIndex = pathAndQuery.indexOf('?');
      
      if (queryIndex !== -1) {
        this.pathname = pathAndQuery.substring(0, queryIndex);
        this.search = pathAndQuery.substring(queryIndex);
      } else {
        this.pathname = pathAndQuery;
        this.search = '';
      }
    } else {
      this.protocol = '';
      this.hostname = '';
      this.pathname = url;
      this.search = '';
    }
  }

  toString() {
    return this._url;
  }

  static createObjectURL(obj) {
    // 简单的模拟实现
    return 'blob:' + Date.now();
  }

  static revokeObjectURL(url) {
    // 简单的模拟实现
  }

  get href() {
    return this._url;
  }

  get origin() {
    return this.protocol + '//' + this.hostname;
  }

  get host() {
    return this.hostname;
  }

  get searchParams() {
    // 创建一个简单的SearchParams实现
    const paramsString = this.search.substring(1); // 移除开头的?
    const params = new (function() {
      const entries = {};
      if (paramsString) {
        paramsString.split('&').forEach(pair => {
          const [key, value] = pair.split('=');
          if (key) {
            entries[decodeURIComponent(key)] = decodeURIComponent(value || '');
          }
        });
      }

      this.get = (name) => entries[name] || null;
      this.set = (name, value) => { entries[name] = value.toString(); };
      this.toString = () => Object.keys(entries).map(key => 
        encodeURIComponent(key) + '=' + encodeURIComponent(entries[key])
      ).join('&');
    })();
    return params;
  }
}
`;

// 自定义AbortController实现
const customAbortControllerImplementation = `
class CustomAbortController {
  constructor() {
    this.signal = new CustomAbortSignal();
  }

  abort() {
    this.signal.abort();
  }
}

class CustomAbortSignal {
  constructor() {
    this.aborted = false;
    this.onabort = null;
    this.listeners = [];
  }

  abort() {
    if (this.aborted) return;
    
    this.aborted = true;
    
    // 触发所有监听器
    this.listeners.forEach(listener => {
      try {
        if (typeof listener === 'function') {
          listener({ type: 'abort' });
        } else if (listener && typeof listener.handleEvent === 'function') {
          listener.handleEvent({ type: 'abort' });
        }
      } catch (e) {
        // 忽略监听器中的错误
      }
    });
    
    // 触发onabort回调
    if (this.onabort) {
      try {
        this.onabort({ type: 'abort' });
      } catch (e) {
        // 忽略onabort回调中的错误
      }
    }
  }

  addEventListener(type, listener) {
    if (type === 'abort') {
      this.listeners.push(listener);
      // 如果已经中止，立即触发监听器
      if (this.aborted) {
        try {
          if (typeof listener === 'function') {
            listener({ type: 'abort' });
          } else if (listener && typeof listener.handleEvent === 'function') {
            listener.handleEvent({ type: 'abort' });
          }
        } catch (e) {
          // 忽略监听器中的错误
        }
      }
    }
  }

  removeEventListener(type, listener) {
    if (type === 'abort') {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    }
  }

  dispatchEvent(event) {
    if (event.type === 'abort') {
      this.abort();
    }
  }
}

// DOMException polyfill for AbortError
class CustomDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name || 'Error';
    this.message = message;
  }
}
`;

(async () => {
  try {
    await esbuild.build({
      entryPoints: ['danmu_api/forward-widget.js'], // 新的入口文件
      bundle: true,
      minify: false, // 暂时关闭压缩以便调试
      sourcemap: false,
      platform: 'neutral', // 改为neutral以避免Node.js特定的全局变量
      target: 'es2020',
      outfile: 'dist/logvar-danmu.js',
      format: 'esm', // 保持ES模块格式
      plugins: [
        // 插件：排除UI相关模块
        {
          name: 'exclude-ui-modules',
          setup(build) {
            // 拦截对UI相关模块的导入
            build.onResolve({ filter: /.*ui.*\.(css|js)$|.*template\.js$/ }, (args) => {
              if (uiModules.some(uiModule => args.path.includes(uiModule.replace('./', '').replace('../', '')))) {
                return { path: args.path, external: true };
              }
            });
          }
        },
        // 插件：合并注入 URL 和 AbortController
        {
          name: 'custom-polyfills',
          setup(build) {
            build.onLoad({ filter: /^.*forward-widget\.js$/ }, async (args) => {
              const fs = require('fs');
              const originalContent = fs.readFileSync(args.path, 'utf8');
              
              // 同时注入 URL 和 AbortController 实现
              const modifiedContent = `
        // 注入自定义URL实现
        ${customURLImplementation}

        // 如果全局环境中没有URL,则使用自定义实现
        if (typeof URL === 'undefined') {
          var URL = CustomURL;
        } else {
          var OriginalURL = URL;
          var URL = CustomURL;
        }

        // 注入自定义AbortController实现
        ${customAbortControllerImplementation}

        // 如果全局环境中没有AbortController,则使用自定义实现
        if (typeof AbortController === 'undefined') {
          var AbortController = CustomAbortController;
          var AbortSignal = CustomAbortSignal;
          var DOMException = CustomDOMException;
        } else {
          var OriginalAbortController = AbortController;
          var OriginalAbortSignal = AbortSignal;
          var OriginalDOMException = DOMException;
          var AbortController = CustomAbortController;
          var AbortSignal = CustomAbortSignal;
          var DOMException = CustomDOMException;
        }

        ${originalContent}
              `;
              
              return {
                contents: modifiedContent,
                loader: 'js'
              };
            });
          }
        },
        // 插件：移除导出语句（仅对输出文件进行处理）
        {
          name: 'remove-exports',
          setup(build) {
            build.onEnd(async (result) => {
              if (result.errors.length === 0) {
                const fs = require('fs');
                let outputContent = fs.readFileSync('dist/logvar-danmu.js', 'utf8');
                
                // 移除指定的导出语句
                const exportPattern = /export\s*{[^}]*getCommentsById[^}]*getDanmuWithSegmentTime[^}]*getDetailById[^}]*searchDanmu[^}]*};?/g;
                outputContent = outputContent.replace(exportPattern, '');
                
                // 也尝试匹配不同的顺序排列
                const exportPattern2 = /export\s*{[^}]*getDanmuWithSegmentTime[^}]*getCommentsById[^}]*getDetailById[^}]*searchDanmu[^}]*};?/g;
                outputContent = outputContent.replace(exportPattern2, '');
                
                const exportPattern3 = /export\s*{[^}]*getDetailById[^}]*getCommentsById[^}]*getDanmuWithSegmentTime[^}]*searchDanmu[^}]*};?/g;
                outputContent = outputContent.replace(exportPattern3, '');
                
                const exportPattern4 = /export\s*{[^}]*searchDanmu[^}]*getDetailById[^}]*getCommentsById[^}]*getDanmuWithSegmentTime[^}]*};?/g;
                outputContent = outputContent.replace(exportPattern4, '');
                
                // 更通用的模式，匹配包含这四个函数名的导出语句
                const genericExportPattern = /export\s*{\s*(?:\s*(?:getCommentsById|getDanmuWithSegmentTime|getDetailById|searchDanmu)\s*,?\s*){4}\s*};?/g;
                outputContent = outputContent.replace(genericExportPattern, '');
                
                // 保存修改后的内容
                fs.writeFileSync('dist/logvar-danmu.js', outputContent);
              }
            });
          }
        }
      ],
      define: {
        'widgetVersion': `"${Globals.VERSION}"`
      },
      banner: {
        js: '// Bundled forward danmu widget with all internal functions (excluding UI)\n'
      },
      logLevel: 'info'
    });
    
    console.log('Forward widget bundle created successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
})();
