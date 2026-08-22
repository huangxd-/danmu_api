// =====================
// build-for-uzn.mjs - UZN app 单文件打包脚本
// 使用 esbuild 把 danmu_api/server.js 及其全部依赖打包成单个可直接运行的 dist/danmu_api_server.cjs
// =====================

import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev =
    process.argv.includes('--dbg') || process.env.NODE_ENV === 'development';

const ENTRY = path.join(__dirname, 'danmu_api', 'server.js');
const SRC_DIR = path.join(__dirname, 'danmu_api');
const DIST_DIR = path.join(__dirname, 'dist');
const OUTFILE = path.join(DIST_DIR, 'danmu_api_server.cjs');

// banner 注入的变量名：打包后 import.meta.url 的替代品（CJS 下 import.meta 为空）
const BUNDLE_FILE_URL_VAR = '__bundle_file_url';

// ----------------------------------------------------------------------------
// 工具：执行字符串替换并断言命中次数（防止源码演进后正则静默失效）
// ----------------------------------------------------------------------------
function replaceAndAssert(contents, pattern, replacement, label, { minCount = 1 } = {}) {
    let count = 0;
    const next = contents.replace(pattern, (...args) => {
        count += 1;
        return replacement;
    });
    if (count < minCount) {
        throw new Error(
            `[build] 替换断言失败：${label} 期望至少命中 ${minCount} 次，实际 ${count} 次。\n` +
            `可能是源码已变更，请检查 build-for-uzn.mjs 中的正则。`
        );
    }
    return next;
}

// ----------------------------------------------------------------------------
// Plugin 1: stubEsmShim
// 把 esm-shim.cjs 的 side-effect import 置空。
// 打包后代码已统一为 CJS，运行时不再需要 ESM/CJS 兼容 hook。
// ----------------------------------------------------------------------------
function stubEsmShim() {
    return {
        name: 'stub-esm-shim',
        setup(build) {
            build.onResolve({ filter: /esm-shim\.cjs$/ }, () => ({
                path: 'stub',
                namespace: 'esm-shim-stub',
            }));
            build.onLoad({ filter: /.*/, namespace: 'esm-shim-stub' }, () => ({
                contents: '// esm-shim stubbed by build-for-uzn.mjs (bundled CJS 不再需要运行时 ESM hook)',
                loader: 'js',
            }));
        },
    };
}

// ----------------------------------------------------------------------------
// Plugin 2: rewriteSources
// 统一改写项目源码（仅 danmu_api/ 下，不动 node_modules），解决三类 CJS 打包兼容问题：
//   (A) import.meta.url 在 CJS 输出下为空 -> 替换为 banner 注入的 __bundle_file_url
//   (B) node-handler.js: 打包后 __dirname 塌缩到 dist/，config 路径需从 ../../../config 改为 ../config
//   (C) cache-util.js: getDirname() 在 CJS 下命中 __dirname 分支，强制走 process.cwd() fallback
//   (D) handler-factory.js: 拼接路径动态 import 无法被 esbuild 静态分析，改写字面量
//   (E) server.js: top-level await 在 CJS 输出下不受支持；且 esm-shim 已被 stub，
//       loadNodeFetch 预加载分支在打包产物中不可达，直接移除
// ----------------------------------------------------------------------------
function rewriteSources() {
    return {
        name: 'rewrite-sources',
        setup(build) {
            build.onLoad({ filter: /\.js$/ }, async (args) => {
                // 只处理项目源码，node_modules 原样放行
                if (!args.path.startsWith(SRC_DIR)) return undefined;

                let contents = await fs.promises.readFile(args.path, 'utf8');
                let changed = false;

                // (A) 通用：import.meta.url -> __bundle_file_url
                if (contents.includes('import.meta.url')) {
                    contents = contents.replace(
                        /\bimport\.meta\.url\b/g,
                        BUNDLE_FILE_URL_VAR
                    );
                    changed = true;
                }

                // (B) node-handler.js: config 路径深度调整
                //     B1: delEnv 的完整 .env 路径；B2: updateConfigValue 的 config 目录路径
                //     （B2 要求 'config' 后紧跟右括号，不会误匹配 B1 的五参数形状）
                if (args.path.endsWith('node-handler.js')) {
                    contents = replaceAndAssert(
                        contents,
                        /path\.join\(\s*__dirname\s*,\s*(['"])\.\.\1\s*,\s*(['"])\.\.\2\s*,\s*(['"])\.\.\3\s*,\s*(['"])config\4\s*,\s*(['"])\.env\5\s*\)/g,
                        `path.join(__dirname, '..', 'config', '.env')`,
                        'node-handler.js config .env 路径',
                        { minCount: 1 }
                    );
                    contents = replaceAndAssert(
                        contents,
                        /path\.join\(\s*__dirname\s*,\s*(['"])\.\.\1\s*,\s*(['"])\.\.\2\s*,\s*(['"])\.\.\3\s*,\s*(['"])config\4\s*\)/g,
                        `path.join(__dirname, '..', 'config')`,
                        'node-handler.js config 目录路径',
                        { minCount: 1 }
                    );
                    changed = true;
                }

                // (C) cache-util.js: getDirname() 去掉 __dirname 分支，恒返回 fallback
                if (args.path.endsWith('cache-util.js')) {
                    contents = replaceAndAssert(
                        contents,
                        /export function getDirname\(\)\s*\{[\s\S]*?return path\.join\(process\.cwd\(\),\s*(['"])danmu_api\1,\s*(['"])utils\2\);\s*\}/,
                        `export function getDirname() {\n  return path.join(process.cwd(), 'danmu_api', 'utils');\n}`,
                        'cache-util.js getDirname',
                        { minCount: 1 }
                    );
                    changed = true;
                }

                // (D) handler-factory.js: 拼接 import -> 字面量 import
                if (args.path.endsWith('handler-factory.js')) {
                    contents = replaceAndAssert(
                        contents,
                        // 匹配 import(['./node-handler', '.js'].join('')) —— 三个字符串用同一引号风格
                        /import\(\s*\[\s*(['"])\.\/node-handler\1\s*,\s*\1\.js\1\s*\]\s*\.\s*join\(\s*\1\1\s*\)\s*\)/g,
                        `import('./node-handler.js')`,
                        'handler-factory.js 拼接 import',
                        { minCount: 1 }
                    );
                    changed = true;
                }

                // (E) server.js: 移除 loadNodeFetch 预加载的 top-level await（CJS 不支持；
                //     且 esm-shim 已被 stub，该分支在打包产物中本就不可达）
                if (args.path.endsWith('server.js')) {
                    contents = replaceAndAssert(
                        contents,
                        /if \(typeof global\.loadNodeFetch === 'function'\) \{\s*await global\.loadNodeFetch\(\);\s*\}/,
                        '/* loadNodeFetch 预加载已由 build-for-uzn.mjs 移除（esm-shim 被 stub，该分支不可达） */',
                        'server.js loadNodeFetch top-level await',
                        { minCount: 1 }
                    );
                    changed = true;
                }

                return changed ? { contents, loader: 'js' } : undefined;
            });
        },
    };
}

// ----------------------------------------------------------------------------
// Plugin 3: genMd5（可选）—— 输出产物 md5，便于发布版本校验
// ----------------------------------------------------------------------------
function genMd5() {
    return {
        name: 'gen-output-md5',
        setup(build) {
            build.onEnd(() => {
                if (!fs.existsSync(OUTFILE)) return;
                const md5 = createHash('md5')
                    .update(fs.readFileSync(OUTFILE))
                    .digest('hex');
                fs.writeFileSync(OUTFILE + '.md5', md5);
                console.log(`[build] md5: ${md5}`);
            });
        },
    };
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------
async function main() {
    // 清理并重建 dist
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });

    const result = await esbuild.build({
        entryPoints: [ENTRY],
        outfile: OUTFILE,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        minify: !isDev,
        sourcemap: isDev ? 'inline' : false,
        treeShaking: true,
        metafile: true,
        write: true,
        logOverride: { 'direct-eval': 'silent' },
        // 在 bundle 顶部注入 import.meta.url 的 CJS 替代品：
        // __filename 由 Node 在 CJS 模块注入，指向 dist/danmu_api_server.cjs 本身
        banner: {
            js: `var ${BUNDLE_FILE_URL_VAR}=require("url").pathToFileURL(__filename).href;`,
        },
        plugins: [stubEsmShim(), rewriteSources(), genMd5()],
    });

    // 输出 metafile 用于体积分析
    fs.writeFileSync(
        path.join(DIST_DIR, 'meta.json'),
        JSON.stringify(result.metafile)
    );

    const sizeKb = (fs.statSync(OUTFILE).size / 1024).toFixed(1);
    const sizeMb = (sizeKb / 1024).toFixed(2);
    console.log(`[build] ${isDev ? 'DEV' : 'PROD'} 产物: ${path.relative(__dirname, OUTFILE)} (${sizeKb} KB / ${sizeMb} MB)`);
    console.log('[build] 运行方式: 在项目根目录执行 node dist/danmu_api_server.cjs');
    console.log('[build] 注意: 需从项目根目录运行，以确保 config/.env 与 .cache 路径正确');
}

main().catch((err) => {
    console.error('[build] 打包失败:', err);
    process.exit(1);
});
