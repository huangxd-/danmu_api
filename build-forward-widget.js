import * as esbuild from 'esbuild';
import fs from 'fs';

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
  'danmu_api/utils/local-redis-util.js'
];

let customPolyfillContent = fs.readFileSync('forward/custom-polyfill.js', 'utf8');

(async () => {
  try {
    await esbuild.build({
      entryPoints: ['forward/forward-widget.js'], // 新的入口文件
      bundle: true,
      minify: false, // 暂时关闭压缩以便调试
      sourcemap: false,
      platform: 'neutral', // 改为neutral以避免Node.js特定的全局变量
      target: 'es2020',
      outfile: 'dist/logvar-danmu.js',
      format: 'esm', // 保持ES模块格式
      external: ['redis'],
      plugins: [
        // 插件：排除UI相关模块
        {
          name: 'exclude-ui-modules',
          setup(build) {
            // 拦截对UI相关模块的导入
            build.onResolve({ filter: /.*ui.*\.(css|js)$|.*template\.js$|.*local-redis-util\.js$/ }, (args) => {
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
                let outputContent = fs.readFileSync('dist/logvar-danmu.js', 'utf8');
                
                // // 更通用的模式，匹配包含这四个函数名的导出语句
                const genericExportPattern = /export\s*{\s*(?:\s*(?:getCommentsById|getDanmuWithSegmentTime|getDetailById|searchDanmu)\s*,?\s*){4}\s*};?/g;
                outputContent = outputContent.replace(genericExportPattern, '');

                // 替换 httpGet 和 httpPost
                outputContent = outputContent.replace(/await\s+httpGet/g, 'await Widget.http.get');
                outputContent = outputContent.replace(/await\s+httpPost/g, 'await Widget.http.post');

                // 删除本地redis相关
                outputContent = outputContent.replace(/.*setLocalRedisKey.*\n?/g, '\n');
                outputContent = outputContent.replace(/.*updateLocalRedisCaches.*\n?/g, '\n');
                
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
        js: customPolyfillContent
      },
      logLevel: 'info'
    });
    
    console.log('Forward widget bundle created successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
})();
