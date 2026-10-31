// Node 平台 handler：本地 config/.env 的读写与内存同步
//
// 该 handler 的 .env 路径是「相对模块目录」解析的（固定指向仓库 config/.env），
// 因此本文件在跑之前先备份、跑完原样恢复，避免测试污染开发者的真实配置。
// 全新 clone（例如 CI）里没有 config/.env（该文件被 .gitignore 忽略，仓库只跟踪 .env.example），
// 这种情况下先用 .env.example 临时生成一份、跑完删除，使用例不依赖开发机的本地配置。
// 其余云平台 handler 的用例在 handlers.test.js 中（它们只出网、不写本地文件）。

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeHandler } from '../../configs/handlers/node-handler.js';
import { Globals } from '../../configs/globals.js';

const ENV_PATH = path.join(process.cwd(), 'config', '.env');
const ENV_EXAMPLE_PATH = path.join(process.cwd(), 'config', '.env.example');
const backup = { existed: false, data: null, provisioned: false };

test.before(async () => {
  backup.existed = await fs.access(ENV_PATH).then(() => true, () => false);
  if (backup.existed) {
    backup.data = await fs.readFile(ENV_PATH);
    return;
  }

  // 没有 .env 时用示例文件临时生成：NodeHandler.updateConfigValue 在文件缺失时会直接抛错
  await fs.copyFile(ENV_EXAMPLE_PATH, ENV_PATH);
  backup.provisioned = true;
});

test.after(async () => {
  if (backup.existed) await fs.writeFile(ENV_PATH, backup.data);
  else await fs.rm(ENV_PATH, { force: true });
});

const readEnvFile = () => fs.readFile(ENV_PATH, 'utf8');
const envLines = (text, key) => text.split('\n').filter((line) => line.startsWith(`${key}=`));

test('node-handler setEnv 覆盖既有键并同步到内存配置', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const handler = new NodeHandler();
  const before = await readEnvFile();
  const original = envLines(before, 'DANMU_LIMIT');
  assert.strictEqual(original.length, 1, '前置条件：config/.env 中存在唯一的 DANMU_LIMIT 行');

  assert.strictEqual(await handler.setEnv('DANMU_LIMIT', 4242), true);

  const after = await readEnvFile();
  const updated = envLines(after, 'DANMU_LIMIT');
  assert.deepStrictEqual(updated, ['DANMU_LIMIT=4242'], '只保留一行且值被替换');
  assert.strictEqual(after.split('\n').length, before.split('\n').length, '覆盖既有键不改变文件行数');

  const inMemory = handler.getEnv('DANMU_LIMIT');
  assert.strictEqual(String(inMemory.value), '4242', 'getEnv 返回带类型信息的对象，值已同步');
  assert.strictEqual(inMemory.type, 'number', '沿用 envVarConfig 中的类型声明');

  await handler.setEnv('DANMU_LIMIT', 0); // 还原文件值，避免影响后续断言的可读性
});

test('node-handler addEnv 追加新键，delEnv 只删除未注释的同名行', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const handler = new NodeHandler();
  const key = 'DANMU_TEST_TMP_KEY';

  assert.strictEqual(await handler.addEnv(key, 'tmp-value'), true);
  let text = await readEnvFile();
  assert.deepStrictEqual(envLines(text, key), [`${key}=tmp-value`], '新键追加到文件末尾');
  assert.strictEqual(handler.getEnv(key), undefined,
    'getAllEnv 只覆盖 envVarConfig 中声明过的键，临时新键只体现在文件里');

  // 同名注释行不应被删除（delEnv 只过滤未注释的 KEY= 行）
  await fs.writeFile(ENV_PATH, `${text.trimEnd()}\n# ${key}=commented-keep\n`);

  assert.strictEqual(await handler.delEnv(key), true);
  text = await readEnvFile();
  assert.deepStrictEqual(envLines(text, key), [], '未注释的同名行被删除');
  assert.ok(text.includes(`# ${key}=commented-keep`), '注释行保持原样');
});

test('node-handler BLOCKED_WORDS 的值会自动包裹双引号', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const handler = new NodeHandler();

  await handler.setEnv('BLOCKED_WORDS', '测试词,second');
  const text = await readEnvFile();
  assert.deepStrictEqual(envLines(text, 'BLOCKED_WORDS'), ['BLOCKED_WORDS="测试词,second"'],
    '含逗号的关键词列表必须加引号，否则 dotenv 解析会截断');

  await handler.setEnv('BLOCKED_WORDS', '"已带引号"');
  const quoted = await readEnvFile();
  assert.deepStrictEqual(envLines(quoted, 'BLOCKED_WORDS'), ['BLOCKED_WORDS="已带引号"'], '已带引号时不重复包裹');
});

test('node-handler 缺少键时 delEnv 仍返回 true（无法区分键是否存在）', async () => {
  Globals.init({ LOG_LEVEL: 'error' });
  const handler = new NodeHandler();
  const before = await readEnvFile();

  assert.strictEqual(await handler.delEnv('DANMU_NO_SUCH_KEY_XYZ'), true,
    '只要文件存在就会执行一次过滤写回，返回值不表示键确实存在');
  assert.deepStrictEqual(envLines(await readEnvFile(), 'DANMU_NO_SUCH_KEY_XYZ'), []);
  assert.strictEqual((await readEnvFile()).split('\n').length, before.split('\n').length, '无匹配行时文件内容不变');
});

test('node-handler 未实现 checkParams / deploy，调用即报错', async () => {
  const handler = new NodeHandler();
  await assert.rejects(() => handler.checkParams('', '', ''), /Method 'checkParams' must be implemented/);
  await assert.rejects(() => handler.deploy(), /Method 'deploy' must be implemented/);
});
