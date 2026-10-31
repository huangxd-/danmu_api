// 日志工具：日志级别过滤、参数拼接与脱敏、logBuffer 裁剪、上海时区时间戳、JSON 格式化

import test from 'node:test';
import assert from 'node:assert';
import { log, formatLogMessage } from '../../utils/log-util.js';
import { globals } from '../../configs/globals.js';

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
