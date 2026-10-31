// 日志工具：日志级别过滤、参数拼接与脱敏、logBuffer 裁剪、上海时区时间戳、JSON 格式化、日志首标签归属与行解析

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { log, formatLogMessage } from '../../utils/log-util.js';
import { globals } from '../../configs/globals.js';
import { logviewJsContent } from '../../ui/js/logview.js';
import { getAllSourceMetas } from '../../sources/registry.js';
import { toLogSourceName } from '../../utils/http-util.js';

// 临时接管 console 以收集真实输出，结束后恢复，避免污染测试输出
function captureConsole(levels, fn) {
    const captured = [];
    const saved = new Map();
    for (const level of levels) {
        saved.set(level, console[level]);
        console[level] = (...args) => { captured.push([level, args]); };
    }
    try {
        fn();
    } finally {
        for (const [level, original] of saved) console[level] = original;
    }
    return captured;
}

// 隔离本轮用例改动的全局日志状态，返回复原函数
function setupLogState({ logLevel = 'info', maxLogs = 1000 } = {}) {
    const saved = {
        logLevel: globals.logLevel,
        MAX_LOGS: globals.MAX_LOGS,
        logBuffer: globals.logBuffer,
        originalEnvVars: globals.originalEnvVars,
        accessedEnvVars: globals.accessedEnvVars
    };
    globals.logLevel = logLevel;
    globals.MAX_LOGS = maxLogs;
    globals.logBuffer = [];
    globals.originalEnvVars = {};
    globals.accessedEnvVars = {};
    return () => {
        globals.logLevel = saved.logLevel;
        globals.MAX_LOGS = saved.MAX_LOGS;
        globals.logBuffer = saved.logBuffer;
        globals.originalEnvVars = saved.originalEnvVars;
        globals.accessedEnvVars = saved.accessedEnvVars;
    };
}

test('log 按 globals.logLevel 过滤：error(0) < warn(1) < info(2)，未知级别按 warn', () => {
    const levels = ['error', 'warn', 'info'];

    const restoreError = setupLogState({ logLevel: 'error' });
    try {
        const captured = captureConsole(levels, () => {
            log('error', 'E');
            log('warn', 'W');
            log('info', 'I');
        });
        assert.deepEqual(captured.map(([level, args]) => [level, args[0]]), [['error', 'E']]);
        assert.deepEqual(globals.logBuffer.map(entry => entry.level), ['error']);
    } finally {
        restoreError();
    }

    const restoreWarn = setupLogState({ logLevel: 'warn' });
    try {
        const captured = captureConsole(levels, () => {
            log('error', 'E');
            log('warn', 'W');
            log('info', 'I');
        });
        assert.deepEqual(captured.map(([level, args]) => [level, args[0]]), [['error', 'E'], ['warn', 'W']]);
    } finally {
        restoreWarn();
    }

    const restoreInfo = setupLogState({ logLevel: 'info' });
    try {
        const captured = captureConsole(levels, () => {
            log('error', 'E');
            log('warn', 'W');
            log('info', 'I');
        });
        assert.deepEqual(captured.map(([level, args]) => [level, args[0]]), [['error', 'E'], ['warn', 'W'], ['info', 'I']]);
        assert.deepEqual(globals.logBuffer.map(entry => entry.message), ['E', 'W', 'I']);
    } finally {
        restoreInfo();
    }

    // logLevel 未配置或取值非法时回退为 1（warn）：info 被过滤，warn 放行
    const restoreUnknown = setupLogState({ logLevel: 'nosuchlevel' });
    try {
        const captured = captureConsole(levels, () => {
            log('warn', 'W');
            log('info', 'I');
        });
        assert.deepEqual(captured.map(([level, args]) => [level, args[0]]), [['warn', 'W']]);
    } finally {
        restoreUnknown();
    }
});

test('log 写入 logBuffer 的条目含级别、消息与上海时区(+08:00)时间戳', () => {
    const restore = setupLogState({ logLevel: 'info' });
    try {
        const before = Date.now();
        captureConsole(['info'], () => log('info', 'hello'));
        const after = Date.now();

        assert.equal(globals.logBuffer.length, 1);
        const entry = globals.logBuffer[0];
        assert.equal(entry.level, 'info');
        assert.equal(entry.message, 'hello');
        assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
        // 时间戳是「当前时刻 +8 小时后标注 +08:00」，按 ISO 解析回来应正好落在本次调用区间内
        const parsed = Date.parse(entry.timestamp);
        assert.ok(parsed >= before, `时间戳早于调用时刻: ${entry.timestamp}`);
        assert.ok(parsed <= after, `时间戳晚于调用时刻: ${entry.timestamp}`);
    } finally {
        restore();
    }
});

test('log 拼接参数：对象序列化为 JSON、null 变字符串 "null"、原始值透传', () => {
    const restore = setupLogState({ logLevel: 'info' });
    try {
        const captured = captureConsole(['info'], () => log('info', 'a', 42, true, null, { k: 1 }, [1, 2]));
        assert.equal(globals.logBuffer[0].message, 'a 42 true null {"k":1} [1,2]');
        assert.deepEqual(captured[0][1], ['a', 42, true, 'null', '{"k":1}', '[1,2]']);
    } finally {
        restore();
    }
});

test('log 依赖 originalEnvVars/accessedEnvVars 的等长星号掩码做敏感信息脱敏', () => {
    const restore = setupLogState({ logLevel: 'info' });
    try {
        globals.originalEnvVars = { TOKEN: 's3cr3t', PLAIN: 'plain-text', SHORT: 'abc', EMPTY: '', NONSTR: 7 };
        globals.accessedEnvVars = { TOKEN: '******', PLAIN: 'plain-text', SHORT: '**', EMPTY: '', NONSTR: 7 };

        const captured = captureConsole(['info'], () => log('info', 'token=s3cr3t', { url: 's3cr3t' }));
        assert.equal(globals.logBuffer[0].message, 'token=****** {"url":"******"}');
        assert.deepEqual(captured[0][1], ['token=******', '{"url":"******"}']);

        // PLAIN 访问值等于原值（非加密变量）、SHORT 掩码长度与原值不符、EMPTY/NONSTR 不满足条件：均不脱敏
        const captured2 = captureConsole(['info'], () => log('info', 'plain-text abc 7'));
        assert.equal(globals.logBuffer[1].message, 'plain-text abc 7');
        assert.deepEqual(captured2[0][1], ['plain-text abc 7']);
    } finally {
        restore();
    }
});

test('log 脱敏时原值中的正则元字符按字面量匹配，不误伤相似文本', () => {
    const restore = setupLogState({ logLevel: 'info' });
    try {
        globals.originalEnvVars = { SPECIAL: 'a.b*c' };
        globals.accessedEnvVars = { SPECIAL: '*****' };
        captureConsole(['info'], () => log('info', 'x a.b*c y axbxc'));
        // 若未对元字符转义，正则 a.b*c 也会命中 axbxc
        assert.equal(globals.logBuffer[0].message, 'x ***** y axbxc');
    } finally {
        restore();
    }
});

test('logBuffer 超过 MAX_LOGS 时从头部丢弃最旧记录', () => {
    const restore = setupLogState({ logLevel: 'info', maxLogs: 3 });
    try {
        captureConsole(['info'], () => {
            for (let i = 0; i < 5; i++) log('info', `n${i}`);
        });
        assert.deepEqual(globals.logBuffer.map(entry => entry.message), ['n2', 'n3', 'n4']);
    } finally {
        restore();
    }
});

test('formatLogMessage 对合法 JSON 做两空格缩进并整体再缩进四空格', () => {
    assert.equal(formatLogMessage('{"a":1}'), '{\n      "a": 1\n    }');
    assert.equal(formatLogMessage('[1,2]'), '[\n      1,\n      2\n    ]');
    assert.equal(formatLogMessage('{"a":{"b":2}}'), '{\n      "a": {\n        "b": 2\n      }\n    }');
});

test('formatLogMessage 对非 JSON 与非法/边缘入参的行为', () => {
    assert.equal(formatLogMessage('not json'), 'not json');
    assert.equal(formatLogMessage('{bad'), '{bad');
    assert.equal(formatLogMessage(''), '');
    // JSON 标量可被解析，随后原样序列化
    assert.equal(formatLogMessage('42'), '42');
    assert.equal(formatLogMessage('"abc"'), '"abc"');
    // JSON.parse 的强制转换：null → "null" → null；undefined 解析失败，原样返回
    assert.equal(formatLogMessage(null), 'null');
    assert.equal(formatLogMessage(undefined), undefined);
});

// 日志标签与行解析测试：在 vm 中执行 ui/js/logview.js 片段，直接取用其分类函数、分类表与行解析
const logviewContext = vm.createContext({ window: {} });
vm.runInContext(logviewJsContent, logviewContext);
const { getLogCategory, parseLogLines } = logviewContext;
const LOG_CATEGORIES = new Set(vm.runInContext('tagGroupOrder.flat()', logviewContext));

function walkSourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'tests' || entry.name === 'node_modules') continue;
            walkSourceFiles(full, out);
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
            out.push(full);
        }
    }
    return out;
}

test('log 标签：生产日志首标签均落在 logview 归属分类内', () => {
    const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const aliens = [];
    for (const file of walkSourceFiles(srcRoot)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const call of source.matchAll(/\blog\(\s*['"](?:info|warn|error|debug|success)['"]\s*,\s*/g)) {
            const rest = source.slice(call.index + call[0].length).replace(/^[`'"]/, '');
            const prefix = rest.match(/^(\s*(?:\[[^\]]*\])+)/);
            if (!prefix) continue;
            const firstTag = prefix[1].match(/\[([^\]]*)\]/)[1].trim();
            // 由模板变量或字符串拼接构造的标签在运行时才确定，静态扫描跳过
            if (/\$\{|['`+]/.test(firstTag)) continue;
            const category = getLogCategory(prefix[1]);
            if (category !== '_inherit_' && !LOG_CATEGORIES.has(category)) {
                aliens.push(`${path.relative(srcRoot, file)}: [${firstTag}] -> ${category}`);
            }
        }
    }
    assert.deepEqual(aliens, [], `存在未归属的日志首标签：${aliens.join(', ')}`);
});

test('log 标签：源、接口、配置与 worker 的日志均带首标签', () => {
    const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const files = ['sources', 'apis', 'configs']
        .flatMap(layer => walkSourceFiles(path.join(pkgRoot, layer)))
        .concat(path.join(pkgRoot, 'worker.js'));
    const missing = [];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        for (const call of source.matchAll(/\blog\(\s*['"](?:info|warn|error|debug|success)['"]\s*,\s*/g)) {
            const rest = source.slice(call.index + call[0].length);
            // 首参为方括号标签，或运行时拼出的标签变量，均视为带标签
            if (/^[`'"]\s*\[/.test(rest) || /^[`'"]\s*\$\{/.test(rest) || /^['"]\s*\+/.test(rest)) continue;
            const line = source.slice(0, call.index).split('\n').length;
            missing.push(`${path.relative(pkgRoot, file)}:${line}`);
        }
    }
    assert.deepEqual(missing, [], `缺少首标签的日志：${missing.join(', ')}`);
});

test('log 标签：源的日志规范名映射均落在 logview 归属分类内', () => {
    // 注册表与 http-util 各自维护调度键到日志名的映射，两处结果都要落在分类集内
    const names = getAllSourceMetas().flatMap(meta => [meta.logName, toLogSourceName(meta.key)]);
    const aliens = names.filter(name => !LOG_CATEGORIES.has(getLogCategory(`[${name}]`)));
    assert.deepEqual(aliens, [], `存在未归属的源日志规范名：${aliens.join(', ')}`);
});

test('log 标签：多行日志的续行沿用所属记录的分类', () => {
    const text = [
        '[2026-10-31T08:00:00.000+08:00] info: [merge][Phase 2: Standard] [tencent] 映射详情:',
        '   [已路由映射] 第1集 <-> 第1集 (Rule: E1>E1)',
        '   [路由失败] 主源找不到 E2 <-> 第3集',
        '',
        '[2026-10-31T08:00:01.000+08:00] warn: [system] [redis] 连接未就绪',
    ].join('\n');
    assert.deepEqual(parseLogLines(text).map(row => [row.type, row._category]), [
        ['info', 'merge'],
        ['info', '_inherit_'],
        ['info', '_inherit_'],
        ['warn', 'system'],
    ]);
});

test('log 标签：前端通知归入 system，带标签的通知按标签归类', () => {
    const context = vm.createContext({ window: {}, document: { getElementById: () => null } });
    vm.runInContext('var logs = [];', context);
    vm.runInContext(logviewJsContent, context);
    context.addLog('日志已清空');
    context.addLog('[tencent] 手动标记');
    assert.deepEqual(vm.runInContext('logs', context).map(entry => entry._category), ['system', 'tencent']);
});

test('log 标签：渲染时续行与记录同组，筛选按钮按分类顺序生成', () => {
    const container = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
    // 供 applyLogFilter 遍历：按已生成的 HTML 还原出带 data-category 的行对象
    Object.defineProperty(container, 'children', {
        get() {
            return [...this.innerHTML.matchAll(/data-category="([^"]+)"/g)].map(m => ({
                dataset: { category: m[1] },
                classList: { toggle() {} }
            }));
        }
    });
    const filters = { innerHTML: '' };
    const elements = { 'log-container': container, 'log-filters': filters, 'log-logs': { style: { display: 'block' } } };
    const context = vm.createContext({ window: {}, document: { getElementById: id => elements[id] || null } });
    vm.runInContext('var logs = [];', context);
    vm.runInContext(logviewJsContent, context);
    context.rows = context.parseLogLines([
        '[2026-10-31T08:00:00.000+08:00] info: [merge][Phase 2: Standard] [tencent] 映射详情:',
        '   [已路由映射] 第1集 <-> 第1集',
        '[2026-10-31T08:00:01.000+08:00] info: [system] [redis] 连接就绪',
    ].join('\n'));
    vm.runInContext('logs = rows', context);
    context.renderLogs();
    assert.deepEqual([...container.innerHTML.matchAll(/data-category="([^"]+)"/g)].map(m => m[1]), ['merge', 'merge', 'system']);
    assert.deepEqual([...filters.innerHTML.matchAll(/setLogFilter\('([^']+)'\)/g)].map(m => m[1]), ['ALL', 'system', 'merge']);
});
