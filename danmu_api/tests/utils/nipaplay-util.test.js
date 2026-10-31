// NipaPlay 中转弹弹play服务端工具函数
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import { parseNipaplayRelatedLinks, resolveNipaplayLink, applyShiftToDanmu, fetchNipaplayDanmaku, verifyNipaplayAccount } from '../../utils/nipaplay-util.js';

test('nipaplay 中转弹弹play服务端工具函数', async (t) => {

  // parseNipaplayRelatedLinks：解析 urls（|）与 shift（,），按主机名映射到内部源并还原时间偏移
  const location = 'https://x.test/redirect?urls=https://www.bilibili.com/video/BV1xx|https://ani.gamer.com.tw/animeVideo.php?sn=12345&shift=0,30';
  const parsed = parseNipaplayRelatedLinks(location);
  assert.strictEqual(parsed.bilibili.length, 1, 'bilibili 链接被解析');
  assert.strictEqual(parsed.bilibili[0].url, 'https://www.bilibili.com/video/BV1xx', 'bilibili 仅保留 BV 主体');
  assert.strictEqual(parsed.bilibili[0].shift, 0, 'bilibili shift 为 0');
  assert.strictEqual(parsed.bahamut.length, 1, 'bahamut 链接被解析');
  assert.strictEqual(parsed.bahamut[0].url, 'https://ani.gamer.com.tw/animeVideo.php?sn=12345', 'bahamut 保留原始 URL');
  assert.strictEqual(parsed.bahamut[0].shift, 30, 'bahamut shift 为 30');
  assert.strictEqual(parsed.iqiyi.length, 0, '未提供平台为空');
  for (const k of ['bilibili', 'bahamut', 'iqiyi', 'youku', 'tencent', 'imgo']) {
    assert.deepStrictEqual(parseNipaplayRelatedLinks('')[k], [], `空字符串入参 ${k} 为空数组`);
    assert.deepStrictEqual(parseNipaplayRelatedLinks(null)[k], [], `空入参 ${k} 为空数组`);
  }

  // resolveNipaplayLink：主机名到源路由，bahamut 提取 sn
  assert.deepStrictEqual(resolveNipaplayLink('https://ani.gamer.com.tw/animeVideo.php?sn=999'), { source: 'bahamut', realId: '999' });
  assert.deepStrictEqual(resolveNipaplayLink('https://v.qq.com/x/cover/abc.html'), { source: 'tencent', realId: 'https://v.qq.com/x/cover/abc.html' });
  assert.deepStrictEqual(resolveNipaplayLink('https://www.bilibili.com/video/BVxyz'), { source: 'bilibili', realId: 'https://www.bilibili.com/video/BVxyz' });
  assert.deepStrictEqual(resolveNipaplayLink('https://bilibili.com/video/BVxyz'), { source: 'bilibili', realId: 'https://bilibili.com/video/BVxyz' }, '无 www 前缀的裸域名同样归入 bilibili');
  assert.deepStrictEqual(resolveNipaplayLink('https://b23.tv/BVxyz'), { source: 'bilibili', realId: 'https://b23.tv/BVxyz' }, 'b站短链 b23.tv 经统一映射归入 bilibili');
  assert.deepStrictEqual(resolveNipaplayLink('https://unknown.example/x'), { source: null, realId: 'https://unknown.example/x' });

  // parse 与 resolve 对 b23.tv 的识别保持一致：均归入 bilibili
  const b23Location = 'https://x.test/redirect?urls=https://b23.tv/BV1xx&shift=0';
  const b23Parsed = parseNipaplayRelatedLinks(b23Location);
  assert.strictEqual(b23Parsed.bilibili.length, 1, 'b23.tv 链接经 parse 归入 bilibili');
  assert.deepStrictEqual(resolveNipaplayLink(b23Parsed.bilibili[0].url), { source: 'bilibili', realId: b23Parsed.bilibili[0].url }, 'parse 与 resolve 对 b23.tv 的源识别一致');

  // applyShiftToDanmu：校正时间偏移并标记实时拉取，不污染原对象
  const src = { p: '12.34,1,25,16777215,0', t: 12.34 };
  const shifted = applyShiftToDanmu(src, 5);
  assert.strictEqual(shifted.p, '17.34,1,25,16777215,0', 'p 时间字段加偏移');
  assert.strictEqual(shifted.t, 17.34, 't 加偏移');
  assert.strictEqual(shifted.isRealTimePulled, true, '标记为实时拉取');
  assert.strictEqual(src.p, '12.34,1,25,16777215,0', '原对象未被修改');
  assert.strictEqual(applyShiftToDanmu(null, 5), null, '空对象直接返回');

  // 负偏移使时间小于 0 时按通用偏移工具的行为钳到 0，避免产出负时间戳
  const negative = { p: '5.00,1,25,16777215,0', t: 5 };
  const clamped = applyShiftToDanmu(negative, -20);
  assert.strictEqual(clamped.p, '0.00,1,25,16777215,0', '负偏移导致的负时间钳到 0');
  assert.strictEqual(clamped.t, 0, 't 同步钳到 0');
  assert.strictEqual(clamped.isRealTimePulled, true, '钳制后仍标记为实时拉取');

  await t.test('账号或密码缺失时不请求 NipaPlay 中转弹弹play服务端，并提示先填写', async () => {
    const savedAccount = Globals.envs.dandanplayAccount;
    const savedPassword = Globals.envs.dandanplayPassword;
    Globals.envs.dandanplayAccount = '';
    Globals.envs.dandanplayPassword = '';
    try {
      assert.strictEqual(await fetchNipaplayDanmaku(1), null, '账号未配置时直接返回 null');
      const result = await verifyNipaplayAccount('', '');
      assert.strictEqual(result.ok, false, '缺少凭据时连通性测试不通过');
      assert.match(result.message, /请先填写/, '提示先填写账号与密码');
    } finally {
      Globals.envs.dandanplayAccount = savedAccount;
      Globals.envs.dandanplayPassword = savedPassword;
    }
  });
});
