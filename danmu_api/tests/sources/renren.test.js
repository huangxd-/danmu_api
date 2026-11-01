// 人人视频源：身份指纹、协议签名、搜索/详情/弹幕解析与降级
// 纯函数与格式化用例离线执行；网络链路通过 mock fetch 覆盖四端接口的解析、降级与日志。

import test from 'node:test';
import assert from 'node:assert';
import RenrenSource, { normalizeCoverUrl, getUnavailableReason } from '../../sources/renren.js';
import { Globals } from '../../configs/globals.js';
import { withMockFetch } from '../helpers/context.js';

const reset = () => {
  Globals.init({});
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.commentCache = new Map();
  Globals.logBuffer.length = 0;
};

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
});

const mockRoute = (routes, fallback = { code: '0000', msg: 'Success', data: {} }) => async (url) => {
  const target = String(url);
  for (const [needle, payload, status] of routes) {
    if (target.includes(needle)) return response(payload, status || 200);
  }
  return response(fallback);
};

const detailData = ({ episodes = [{ sid: '100', episodeNo: 1, title: '第1集' }], dramaInfo = {}, watchInfo = null } = {}) => ({
  code: '0000',
  msg: 'Success',
  data: {
    authorityInfo: { playRestricted: 1 },
    dramaInfo: { serialStatus: 'END', playStatus: '已完结·全1集', ...dramaInfo },
    episodeList: episodes,
    watchInfo,
  },
});

const logMessages = () => Globals.logBuffer.map(entry => entry.message);

test('renren 身份指纹生成符合各端格式', () => {
  const source = new RenrenSource();
  assert.match(source.generateRandomAliId(), /^aY[A-Za-z0-9+/]{22}$/);
  assert.match(source.generateMacAliId(), /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.match(source.generateWinAliId(), /^[0-9A-F]{32}$/);
  assert.match(source.generateDeviceId(), /^[0-9A-Z]+$/);
});

test('renren generateTvHeaders 输出 TV 端协议头', () => {
  const headers = new RenrenSource().generateTvHeaders(1700000000, 'sign-value');
  assert.equal(headers.clientVersion, '1.2.2');
  assert.equal(headers.clienttype, 'android_qwtv_RRSP');
  assert.equal(headers.pkt, 'rrmj');
  assert.equal(headers.t, '1700000000');
  assert.equal(headers.sign, 'sign-value');
  assert.equal(headers.token, '');
  assert.equal(headers.umid, '');
  assert.match(headers.aliid, /^aY[A-Za-z0-9+/]{22}$/);
});

test('renren buildMacHeaders/buildWinHeaders 携带各自端特征', () => {
  const source = new RenrenSource();
  const mac = source.buildMacHeaders();
  assert.equal(mac.ct, 'mac_rrsp');
  assert.equal(mac.cv, '1.2.3');
  assert.match(mac['User-Agent'], /CFNetwork/);
  assert.match(mac.aliId, /^[0-9A-F-]{36}$/);

  const win = source.buildWinHeaders();
  assert.equal(win.ct, 'win_rrsp_gw');
  assert.equal(win.cv, '1.24.2');
  assert.equal(win['User-Agent'], 'Boost.Beast/351');
  assert.match(win.aliId, /^[0-9A-F]{32}$/);
});

test('renren generateSignature 对请求要素敏感且可复现', () => {
  const source = new RenrenSource();
  const base = ['GET', 'ali', 'web_pc', '1.0.0', 1700000000, '/m-station/drama/page', 'a=1&b=2', 'secret'];
  const first = source.generateSignature(...base);
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(source.generateSignature(...base), first, '同入参签名稳定');
  assert.notEqual(source.generateSignature('POST', ...base.slice(1)), first);
  assert.notEqual(source.generateSignature(...base.slice(0, 6), 'a=2&b=2', 'secret'), first);
  assert.notEqual(source.generateSignature(...base.slice(0, 7), 'other-secret'), first);
});

test('renren buildSignedHeaders 输出网页端签名头', () => {
  const headers = new RenrenSource().buildSignedHeaders({
    method: 'GET',
    url: 'https://api.rrmj.plus/m-station/drama/page',
    params: { dramaId: '19947' },
    deviceId: 'DEVICE01',
  });
  assert.equal(headers.deviceId, 'DEVICE01');
  assert.equal(headers.aliId, 'DEVICE01');
  assert.equal(headers.umid, 'DEVICE01');
  assert.equal(headers.Origin, 'https://rrsp.com.cn');
  assert.equal(headers.Referer, 'https://rrsp.com.cn/');
  assert.match(headers['x-ca-sign'], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.match(headers.t, /^\d+$/);
});

test('renren AliID 初始化、批量模式与轮换计数', () => {
  reset();
  const source = new RenrenSource();
  source.rotateAliId();
  const id = source.getAliId();
  assert.match(id, /^aY[A-Za-z0-9+/]{22}$/);
  const increments = () => Globals.logBuffer.filter(entry => entry.message.includes('AliID 计数增加')).length;
  const before = increments();

  source.isBatchMode = true;
  assert.equal(source.getAliId(), id, '批量模式复用当前 ID');
  assert.equal(increments(), before, '批量模式不增加计数');
  source.isBatchMode = false;

  source.rotateAliId();
  assert.ok(Globals.logBuffer.some(entry => entry.message.includes('AliID 轮换完成')));
  source.getAliId();
  assert.ok(Globals.logBuffer.some(entry => entry.message.includes('AliID 计数增加: 1/')));
});

test('renren AliID 达到阈值时自动轮换', () => {
  reset();
  const source = new RenrenSource();
  source.rotateAliId();
  for (let i = 0; i < 61; i++) source.getAliId();
  assert.ok(logMessages().some(message => message.includes('AliID 触发阈值')));
  assert.ok(logMessages().some(message => message.includes('AliID 轮换完成')), '触发阈值后完成轮换');
  assert.ok(logMessages().some(message => message.includes('AliID 计数增加: 1/')), '轮换后计数归零重新累计');
});

test('renren parseRRSPPFields 解析属性并安全回退默认值', () => {
  const source = new RenrenSource();
  assert.deepEqual(source.parseRRSPPFields('12.5,1,25,16777215,0,0,user1,777'), {
    timestamp: 12.5, mode: 1, size: 25, color: 16777215, userId: 'user1', contentId: '777',
  });
  assert.deepEqual(source.parseRRSPPFields(',,,'), {
    timestamp: 0, mode: 1, size: 25, color: 16777215, userId: '', contentId: '0:',
  });
  assert.deepEqual(source.parseRRSPPFields('abc,xyz,?,bad'), {
    timestamp: 0, mode: 1, size: 25, color: 16777215, userId: '', contentId: '0:',
  });
  assert.equal(source.parseRRSPPFields('1.5,2,30,255,0,0,u').contentId, '1.5:u');
});

test('renren formatComments 应用广告偏移并过滤无效弹幕', () => {
  reset();
  const source = new RenrenSource();
  const comments = [
    { d: '第一条', p: '10,1,25,16777215,0,0,u,11' },
    { content: '第二条', p: '2,5,25,255,0,0,u,12' },
    { d: '', p: '1,1,25,1,0,0,u,13' },
    { d: '缺少属性' },
  ];
  comments.adDurationMs = 3000;
  comments.episodeId = '40356-100';

  const formatted = source.formatComments(comments);
  assert.equal(formatted.length, 1);
  assert.deepEqual(formatted[0], { cid: 11, p: '7.00,1,16777215,[renren]', m: '第一条', t: 7 });
  assert.ok(logMessages().some(message => message.includes('识别到前置广告(3000ms)')));
});

test('renren getEpisodeDanmuSegments 返回单段结构并委托分片解析', async () => {
  const source = new RenrenSource();
  const segments = await source.getEpisodeDanmuSegments('40356-100');
  assert.equal(segments.type, 'renren');
  assert.equal(segments.segmentList.length, 1);
  assert.equal(segments.segmentList[0].segment_start, 0);
  assert.equal(segments.segmentList[0].segment_end, 30000);
  assert.equal(segments.segmentList[0].url, '40356-100');

  const original = source.getEpisodeDanmu;
  source.getEpisodeDanmu = async () => ['segment-danmu'];
  try {
    assert.deepEqual(await source.getEpisodeSegmentDanmu({ url: '40356-100' }), ['segment-danmu']);
  } finally {
    source.getEpisodeDanmu = original;
  }
});

test('renren normalizeCoverUrl 将无 Referer 直连 403 的封面域名替换为可访问域名', () => {
  assert.equal(normalizeCoverUrl('http://img.bwcgee.cn/seasonCover/a.webp'), 'http://img.duoduoshipin.vip/seasonCover/a.webp');
  assert.equal(normalizeCoverUrl('https://img.bwcgee.cn/video/b.jpg'), 'https://img.duoduoshipin.vip/video/b.jpg');
  assert.equal(normalizeCoverUrl('https://img.bwcgee.cn/a.jpg?imageMogr2/thumbnail/400x'),
    'https://img.duoduoshipin.vip/a.jpg?imageMogr2/thumbnail/400x', '查询参数保持不变');
  assert.equal(normalizeCoverUrl('http://img.ranaesport.cn/x.webp'), 'http://img.ranaesport.cn/x.webp', '已可直连的域名保持不变');
  assert.equal(normalizeCoverUrl(''), '');
  assert.equal(normalizeCoverUrl(null), null);
  assert.equal(normalizeCoverUrl('not-a-url'), 'not-a-url');
});

test('renren getUnavailableReason 依据播出状态区分未上线、未开播与无资源', () => {
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: null, playStatus: '' } }), '尚未上线');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: 'NOT_BROADCAST', playStatus: '即将开播' } }), '尚未开播');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: null, playStatus: '即将开播' } }), '尚未开播', '缺少档期状态时按播出文案判断');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: 'END', playStatus: '已完结·全14集' } }), '无播放资源');
  assert.equal(getUnavailableReason({ dramaInfo: { serialStatus: 'UN_PERIODIC', playStatus: '连载中·更新至1集' } }), '无播放资源');
  assert.equal(getUnavailableReason(null), '尚未上线');
});

test('renren 四端搜索解析统一字段、别名与封面', async () => {
  reset();
  const source = new RenrenSource();
  const winPayload = {
    code: '0000',
    msg: 'Success',
    data: {
      seasonList: [{
        id: '1', title: '钢铁侠:崛起', cover: 'http://img.bwcgee.cn/seasonCover/a.webp', year: '2014', classify: '电影',
        highlights: { alias: '<em>Iron Man</em>, 钢一', original_name: '<em>Iron Man: Rise</em>' },
      }],
      fuzzySeasonList: [{ id: '2', title: '钢铁侠2', cover: 'http://img.ranaesport.cn/b.webp' }],
      seriesList: [{ seasonList: [{ id: '3', title: '钢铁侠3', cover: 'http://img.duoduoshipin.vip/c.webp' }] }],
    },
  };
  const macPayload = {
    code: '0000',
    data: [{ id: '4', title: 'MAC剧', cover: '', cover3: 'http://img.bwcgee.cn/d.webp', classify: 'TV', highlights: { alias: 'M1', original_name: '<em>MAC EN</em>' } }],
  };
  const tvPayload = {
    code: '0000',
    data: [{ id: '5', title: 'TV剧', cover: 'http://img.bwcgee.cn/e.webp', classify: 'DOCUMENTARY', highlights: { alias: 'T1', original_name: '<em>TV EN</em>' } }],
  };
  const webPayload = {
    code: '0000',
    data: {
      searchDramaList: [{
        id: '6', title: 'WEB剧', cover: 'http://img.bwcgee.cn/f.webp', classify: '电影', episodeTotal: 12,
        highlights: { alias: '<em>W1</em>', original_name: '<em>WEB EN</em>' },
      }],
    },
  };

  await withMockFetch(mockRoute([
    ['/search/comprehensive/precise-mixed', winPayload],
    ['/search/v5/season', macPayload],
    ['/qwtv/search', tvPayload],
    ['/m-station/search/drama', webPayload],
  ]), async () => {
    const win = await source.performWinSearch('钢铁侠', 30);
    assert.equal(win.length, 3);
    assert.equal(win[0].title, '钢铁侠：崛起', '标题冒号统一为全角');
    assert.deepEqual(win[0].aliases, ['Iron Man', '钢一', 'Iron Man: Rise']);
    assert.equal(win[0].imageUrl, 'http://img.duoduoshipin.vip/seasonCover/a.webp');
    assert.equal(win[1].imageUrl, 'http://img.ranaesport.cn/b.webp', '可直连域名保持不变');
    assert.equal(win[2].imageUrl, 'http://img.duoduoshipin.vip/c.webp');

    const mac = await source.performMacSearch('MAC剧');
    assert.equal(mac.length, 1);
    assert.equal(mac[0].imageUrl, 'http://img.duoduoshipin.vip/d.webp', 'cover 为空时回退 cover3');
    assert.deepEqual(mac[0].aliases, ['M1', 'MAC EN']);

    const tv = await source.searchAppContent('TV剧');
    assert.equal(tv.length, 1);
    assert.equal(tv[0].type, 'DOCUMENTARY');
    assert.equal(tv[0].imageUrl, 'http://img.duoduoshipin.vip/e.webp');
    assert.deepEqual(tv[0].aliases, ['T1', 'TV EN']);

    const web = await source.performNetworkSearch('WEB剧', { minInterval: 0 });
    assert.equal(web.length, 1);
    assert.equal(web[0].episodeCount, 12);
    assert.equal(web[0].imageUrl, 'http://img.duoduoshipin.vip/f.webp');
    assert.deepEqual(web[0].aliases, ['W1', 'WEB EN']);
  });
});

test('renren 搜索接口异常时返回 null 并记录日志', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([], { code: '9999', msg: 'denied', data: {} }), async () => {
    assert.equal(await source.performWinSearch('剧'), null);
    assert.equal(await source.performMacSearch('剧'), null);
    assert.equal(await source.searchAppContent('剧'), null);
  });
  assert.ok(logMessages().some(message => message.includes('Win端搜索接口异常: code=9999')));
  assert.ok(logMessages().some(message => message.includes('Mac端搜索接口异常: code=9999')));
  assert.ok(logMessages().some(message => message.includes('TV搜索接口异常: code=9999')));
});

test('renren 搜索请求异常时各端捕获并返回 null', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => { throw new Error('boom'); }, async () => {
    assert.equal(await source.performWinSearch('异常'), null);
    assert.equal(await source.performMacSearch('异常'), null);
    assert.equal(await source.searchAppContent('异常'), null);
  });
  assert.ok(logMessages().some(message => message.includes('performWinSearch error: boom')));
  assert.ok(logMessages().some(message => message.includes('performMacSearch error: boom')));
  assert.ok(logMessages().some(message => message.includes('searchAppContent error: boom')));
});

test('renren 本地搜索按 WIN → TV 降级并更新健康状态', async () => {
  reset();
  const source = new RenrenSource();
  const calls = [];
  await withMockFetch(async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('/search/comprehensive/precise-mixed')) return response({ code: '9999', msg: 'denied', data: {} });
    if (target.includes('/qwtv/search')) {
      return response({ code: '0000', data: [{ id: '7', title: 'TV命中', classify: '电影' }] });
    }
    return response({ code: '9999', data: {} });
  }, async () => {
    const result = await source.search('命中');
    assert.equal(result.length, 1);
    assert.equal(result[0].mediaId, '7');
  });
  const winAttempted = calls.some(url => url.includes('/search/comprehensive/precise-mixed'));
  assert.ok(calls.some(url => url.includes('/qwtv/search')), 'TV 端接口最终被调用');
  if (winAttempted) {
    assert.ok(logMessages().some(message => message.includes('搜索域接口健康状态更新: WIN -> TV')));
  }
});

test('renren 搜索全部异常时返回空数组并重置健康状态', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([
    ['/m-station/search/drama', { error: 'bad gateway' }, 500],
  ], { code: '9999', msg: 'denied', data: {} }), async () => {
    assert.deepEqual(await source.search('无结果'), []);
  });
  assert.ok(logMessages().some(message => message.includes('搜索域所有降级接口均异常失败，重置健康状态至 WIN 端')));
});

test('renren 云环境搜索 TV 优先并记录连通性', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([
    ['/qwtv/search', { code: '0000', data: [{ id: '8', title: 'TV云', classify: '电影' }] }],
    ['/search/comprehensive/precise-mixed', { code: '9999', data: {} }],
  ], { code: '9999', data: {} }), async () => {
    const result = await source._searchCloud('云');
    assert.equal(result.length, 1);
    assert.equal(result[0].mediaId, '8');
  });
  assert.equal(source._searchConnectivity.TV, 'ok');
  assert.ok(logMessages().some(message => message.includes('搜索连通性记录')));
});

test('renren 云环境搜索全部失败时记录超时并返回空数组', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([
    ['/m-station/search/drama', { error: 'bad gateway' }, 500],
  ], { code: '9999', data: {} }), async () => {
    assert.deepEqual(await source._searchCloud('无'), []);
  });
  assert.deepEqual(source._searchConnectivity, {
    TV: 'timeout', WIN: 'timeout', MAC: 'timeout', WEB: 'timeout',
  });
});

test('renren 云环境搜索入口在非 node 部署平台生效', async () => {
  reset();
  const source = new RenrenSource();
  Globals.deployPlatform = 'vercel';
  try {
    await withMockFetch(mockRoute([
      ['/qwtv/search', { code: '0000', data: [{ id: '9', title: '云入口', classify: '电影' }] }],
    ], { code: '9999', data: {} }), async () => {
      const result = await source.search('云入口');
      assert.equal(result.length, 1);
      assert.equal(result[0].mediaId, '9');
    });
  } finally {
    Globals.deployPlatform = undefined;
  }
});

test('renren TV/Gateway/WEB 详情解析成功与失败分支', async () => {
  reset();
  const source = new RenrenSource();
  let payload = detailData();
  await withMockFetch(async () => response(payload), async () => {
    const tv = await source.getAppDramaDetail('40356', '100');
    assert.equal(tv.episodeList.length, 1);

    payload = { code: '0000', msg: '该剧暂不可播', data: null };
    assert.equal(await source.getAppDramaDetail('40356'), null);

    payload = { code: '1001', msg: 'error', data: null };
    assert.equal(await source.getAppDramaDetail('40356'), null);

    payload = detailData({ episodes: [], dramaInfo: { serialStatus: 'NOT_BROADCAST', playStatus: '即将开播' } });
    const upcoming = await source.getAppDramaDetail('40356');
    assert.deepEqual(upcoming.episodeList, [], '即将开播保留空分集结果');

    payload = detailData({ episodes: [], dramaInfo: { serialStatus: null, playStatus: '' } });
    const diagnostics = {};
    assert.equal(await source.getGatewayDramaDetail('api.cluuid.cn', '40356', '', diagnostics), null);
    assert.equal(diagnostics.reason, '尚未上线');

    payload = { code: '0000', msg: 'Success', data: { dramaInfo: {}, episodeList: [{ sid: '1' }] } };
    const web = await source.getWebDramaDetailFallback('40356');
    assert.equal(web.episodeList.length, 1);

    payload = { code: '0000', msg: 'Success', data: { dramaInfo: { serialStatus: 'END', playStatus: '已完结·全1集' }, episodeList: [] } };
    const webDiagnostics = {};
    assert.equal(await source.getWebDramaDetailFallback('40356', webDiagnostics), null);
    assert.equal(webDiagnostics.reason, '无播放资源');
  });
  assert.ok(logMessages().some(message => message.includes("TV接口提示'该剧暂不可播'")));
  assert.ok(logMessages().some(message => message.includes("TV详情接口提示'即将开播'")));
});

test('renren 云环境详情优先使用搜索阶段已验证的 TV 端点', async () => {
  reset();
  const source = new RenrenSource();
  source._searchConnectivity = { TV: 'ok', WEB: 'unknown' };
  const calls = [];
  await withMockFetch(async (url) => {
    calls.push(String(url));
    return response(detailData());
  }, async () => {
    const detail = await source._getDetailCloud('40356', '100');
    assert.equal(detail.episodeList.length, 1);
  });
  assert.equal(calls[0].includes('/qwtv/drama/details'), true, '搜索阶段已验证的 TV 端点优先');
});

test('renren 云环境详情在首组不可用时进入第二组', async () => {
  reset();
  const source = new RenrenSource();
  source._searchConnectivity = { WEB: 'timeout', TV: 'timeout' };
  await withMockFetch(mockRoute([
    ['/qwtv/drama/details', detailData({ episodes: [] })],
    ['/m-station/drama/page', detailData({ episodes: [] })],
  ]), async () => {
    assert.equal(await source._getDetailCloud('40356', '100'), null);
  });
  assert.ok(logMessages().some(message => message.includes('第一组并行详情均未返回结果，继续第二组')));
});

test('renren 详情接口无响应数据时记录日志并返回 null', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => response(''), async () => {
    assert.equal(await source.getAppDramaDetail('40356'), null);
    assert.equal(await source.getGatewayDramaDetail('api.cluuid.cn', '40356'), null);
    assert.equal(await source.performNetworkSearch('剧', { minInterval: 0 }), null);
  });
  assert.ok(logMessages().some(message => message.includes('TV详情接口网络无响应或数据为空: ID=40356')));
  assert.ok(logMessages().some(message => message.includes('详情接口网络无响应或数据为空 (api.cluuid.cn): ID=40356')));
  assert.ok(logMessages().some(message => message.includes('网页版搜索无响应数据')));
});

test('renren getEpisodes 映射复合 ID、标题回退与详情元数据', async () => {
  reset();
  const source = new RenrenSource();
  const payload = detailData({
    episodes: [
      { sid: '', episodeNo: 1 },
      { sid: '101', episodeNo: 2 },
      { sid: '102', episodeNo: 3, title: '自定义标题' },
    ],
    dramaInfo: { enName: 'Iron Man', year: 2010, dramaType: 'TV' },
  });
  await withMockFetch(async () => response(payload), async () => {
    const episodes = await source.getEpisodes('40356');
    assert.equal(episodes.length, 2, '缺少 sid 的条目被跳过');
    assert.equal(episodes[0].episodeId, '40356-101');
    assert.equal(episodes[0].title, '第02集');
    assert.equal(episodes[0].url, null);
    assert.equal(episodes[1].title, '自定义标题');
    assert.equal(episodes.enName, 'Iron Man');
    assert.equal(episodes.year, 2010);
    assert.equal(episodes.type, '电视剧');
  });

  await withMockFetch(async () => response(detailData({ episodes: [] })), async () => {
    assert.deepEqual(await source.getEpisodes('40356'), []);
  });
});

test('renren getEpisodes 全接口无分集时在失败日志中附带接口原因', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([], detailData({ episodes: [], dramaInfo: { serialStatus: null, playStatus: '' } })), async () => {
    assert.deepEqual(await source.getEpisodes('19947'), []);
  });
  assert.ok(logMessages().includes('[renren] 获取分集失败: 详情对象为空 ID=19947 接口返回：“尚未上线”'));
});

test('renren getEpisodes 在详情缺少分集字段时记录日志', async () => {
  reset();
  const source = new RenrenSource();
  const original = source.getDetail;
  source.getDetail = async () => ({ dramaInfo: {} });
  try {
    assert.deepEqual(await source.getEpisodes('40356'), []);
  } finally {
    source.getDetail = original;
  }
  assert.ok(logMessages().includes('[renren] 获取分集失败: episodeList 字段缺失或非数组 ID=40356'));
});

test('renren getEpisodes 按详情类型输出剧场版/动画/综艺/纪录片', async () => {
  reset();
  const source = new RenrenSource();
  const cases = [
    [{ dramaType: 'MOVIE', plotType: '动画' }, '剧场版'],
    [{ dramaType: 'MOVIE', plotType: '动作' }, '电影'],
    [{ dramaType: 'COMIC', plotType: '' }, '动画'],
    [{ dramaType: 'VARIETY', plotType: '' }, '综艺'],
    [{ dramaType: 'DOCUMENTARY', plotType: '' }, '纪录片'],
  ];
  for (const [dramaInfo, expected] of cases) {
    await withMockFetch(async () => response(detailData({ dramaInfo })), async () => {
      const episodes = await source.getEpisodes('40356');
      assert.equal(episodes.type, expected);
    });
  }
});

test('renren fetchStandardDanmu 兼容数组包装、无数据与 404 语义', async () => {
  reset();
  const source = new RenrenSource();
  let payload = [{ d: 'a' }, { d: 'b' }];
  await withMockFetch(async () => response(payload), async () => {
    assert.deepEqual(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), [{ d: 'a' }, { d: 'b' }]);
    payload = { data: [{ d: 'c' }] };
    assert.deepEqual(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), [{ d: 'c' }]);
    payload = { foo: 'bar' };
    assert.deepEqual(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), []);
  });

  await withMockFetch(async () => response({ error: 'Document not found' }, 404), async () => {
    assert.deepEqual(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), [], '确认无弹幕的 404 返回空数组');
  });
  reset();
  await withMockFetch(async () => response({ error: 'bad gateway' }, 404), async () => {
    assert.equal(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), null, '未知 404 视为接口异常');
  });
  assert.ok(logMessages().some(message => message.includes('MAC 弹幕接口返回未知 404 响应')));
});

test('renren getAppDanmu 区分确认无弹幕与接口异常', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => response({ error: 'Document not found' }, 404), async () => {
    assert.deepEqual(await source.getAppDanmu('40356-100'), [], 'Document not found 视为该集无弹幕');
  });
  reset();
  await withMockFetch(async () => response({ error: 'bad gateway' }, 404), async () => {
    assert.equal(await source.getAppDanmu('40356-100'), null, '未知 404 视为接口异常');
  });
  assert.ok(logMessages().some(message => message.includes('TV 弹幕接口返回未知 404 响应')));
});

test('renren getWebDanmuFallback 兼容数组与 data 包装', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => response([{ d: '数组弹幕' }]), async () => {
    assert.deepEqual(await source.getWebDanmuFallback('40356-100'), [{ d: '数组弹幕' }]);
  });
  await withMockFetch(async () => response({ data: [{ d: '包装弹幕' }] }), async () => {
    assert.deepEqual(await source.getWebDanmuFallback('40356-100'), [{ d: '包装弹幕' }]);
  });
});

test('renren getEpisodeDanmu 从详情读取广告时长并附带分集信息', async () => {
  reset();
  const source = new RenrenSource();
  const detail = detailData({ watchInfo: { m3u8: { startingLength: 5000, openingLength: 3000 } } });
  const danmuPayload = [{ d: '第一条', p: '10,1,25,16777215,0,0,u,11' }];
  await withMockFetch(mockRoute([
    ['/qwtv/drama/details', detail],
    ['/m-station/drama/page', detail],
    ['static-dm.qwdjapp.com', danmuPayload],
    ['static-dm.lequkeji.com', danmuPayload],
    ['static-dm.rrmj.plus', danmuPayload],
  ]), async () => {
    const danmu = await source.getEpisodeDanmu('40356-100');
    assert.equal(danmu.length, 1);
    assert.equal(danmu.adDurationMs, 5000, 'startingLength 优先');
    assert.equal(danmu.episodeId, '40356-100');
  });
});

test('renren getEpisodeDanmu 在 TV 失败后降级到其他端', async () => {
  reset();
  const source = new RenrenSource();
  const fallbackPayload = [{ d: '降级端弹幕', p: '5,1,25,16777215,0,0,u,21' }];
  await withMockFetch(mockRoute([
    ['static-dm.qwdjapp.com', { error: 'bad gateway' }, 404],
    ['static-dm.lequkeji.com', fallbackPayload],
    ['static-dm.rrmj.plus', fallbackPayload],
  ]), async () => {
    const danmu = await source.getEpisodeDanmu('40356');
    assert.equal(danmu.length, 1, 'TV 失败后由后续端提供弹幕');
    assert.equal(danmu[0].d, '降级端弹幕');
  });
});

test('renren getEpisodeDanmu 在接口正常返回空数组时报暂无弹幕', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([
    ['static-dm.qwdjapp.com', []],
    ['static-dm.lequkeji.com', []],
    ['static-dm.rrmj.plus', []],
  ]), async () => {
    const danmu = await source.getEpisodeDanmu('40356');
    assert.equal(danmu.length, 0);
  });
  assert.ok(logMessages().some(message => message.includes('该剧集暂无弹幕')));
});

test('renren getEpisodeDanmu 全部失败时返回带元数据的空数组', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(mockRoute([
    ['static-dm.qwdjapp.com', { error: 'bad gateway' }, 404],
    ['static-dm.lequkeji.com', { error: 'bad gateway' }, 404],
    ['static-dm.rrmj.plus', { error: 'bad gateway' }, 404],
  ], { error: 'bad gateway' }), async () => {
    const danmu = await source.getEpisodeDanmu('40356');
    assert.equal(danmu.length, 0, '降级全部失败返回空数组');
    assert.equal(danmu.adDurationMs, 0);
    assert.equal(danmu.episodeId, '40356');
  });
  assert.ok(logMessages().some(message => message.includes('弹幕域所有降级接口均失败，重置健康状态至 TV 端')));
});

test('renren 弹幕接口网络异常时各端捕获并返回 null', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => { throw new Error('boom'); }, async () => {
    assert.equal(await source.fetchStandardDanmu('https://x/danmu', {}, 'MAC'), null);
    assert.equal(await source.getAppDanmu('40356-100'), null);
    assert.equal(await source.getWebDanmuFallback('40356-100'), null);
  });
  assert.ok(logMessages().some(message => message.includes('MAC 端弹幕拉取异常: boom')));
  assert.ok(logMessages().some(message => message.includes('getAppDanmu error: boom')));
  assert.ok(logMessages().some(message => message.includes('网页版弹幕降级失败: boom')));
});

test('renren WEB 弹幕 404 区分该集无弹幕与接口异常', async () => {
  reset();
  const source = new RenrenSource();
  await withMockFetch(async () => response({ error: 'Document not found' }, 404), async () => {
    assert.deepEqual(await source.getWebDanmuFallback('40356-100'), []);
  });
  reset();
  await withMockFetch(async () => response({ error: 'bad gateway' }, 404), async () => {
    assert.equal(await source.getWebDanmuFallback('40356-100'), null);
  });
  assert.ok(logMessages().some(message => message.includes('WEB 弹幕接口返回未知 404 响应')));
});

test('renren getComments 完成详情、弹幕与广告偏移的完整链路', async () => {
  reset();
  const source = new RenrenSource();
  const detail = detailData({ watchInfo: { m3u8: { openingLength: 2000 } } });
  await withMockFetch(mockRoute([
    ['/qwtv/drama/details', detail],
    ['/m-station/drama/page', detail],
    ['static-dm.qwdjapp.com', [
      { d: '弹幕一', p: '3,1,25,16777215,0,0,u,31' },
      { d: '弹幕二', p: '5,1,25,16777215,0,0,u,32' },
    ]],
  ]), async () => {
    const comments = await source.getComments('40356-100', 'renren', false);
    assert.equal(comments.length, 2);
    assert.equal(comments[0].p.startsWith('1.00'), true, '按 openingLength 前移 2 秒');
    assert.ok(comments[0].p.includes('[renren]'));
    assert.equal(comments[0].m, '弹幕一');
  });
});

test('renren handleAnimes 过滤非目标季并忽略非法输入', async () => {
  reset();
  const source = new RenrenSource();
  assert.deepEqual(await source.handleAnimes(null, '剧', [], null), []);
  assert.ok(logMessages().some(message => message.includes('sourceAnimes is not a valid array')));

  const detail = detailData();
  const sourceAnimes = [
    { provider: 'renren', mediaId: '11', title: '剧集 第一季', aliases: [], year: '2024', imageUrl: '' },
    { provider: 'renren', mediaId: '12', title: '剧集 第二季', aliases: [], year: '2024', imageUrl: '' },
  ];
  const result = await withMockFetch(async () => response(detail), () => source.handleAnimes(sourceAnimes, '剧集 第二季', [], null));
  assert.equal(result.length, 1);
  assert.ok(result[0].animeTitle.includes('第二季'));
  assert.ok(logMessages().some(message => message.includes('结果已命中目标季(第2季)')));
});

test('renren handleAnimes 跳过无分集条目并捕获处理异常', async () => {
  reset();
  const source = new RenrenSource();
  const emptyDetail = detailData({ episodes: [] });
  const withoutEpisodes = { provider: 'renren', mediaId: '77', title: '无分集', year: '2024' };
  const unrelated = { provider: 'renren', mediaId: '78', title: '其它剧', year: '2024' };
  const result = await withMockFetch(async () => response(emptyDetail), () => source.handleAnimes([withoutEpisodes, unrelated], '无分集', [], null));
  assert.equal(result.length, 0, '没有分集的条目不入池');
  assert.ok(logMessages().some(message => message.includes('过滤无关结果后数量：1')));

  reset();
  const original = source.getEpisodes;
  source.getEpisodes = async () => { throw new Error('episodes boom'); };
  try {
    const errored = await source.handleAnimes([{ provider: 'renren', mediaId: '79', title: '异常剧', aliases: [], year: '2024' }], '异常剧', [], null);
    assert.equal(errored.length, 0);
  } finally {
    source.getEpisodes = original;
  }
  assert.ok(logMessages().some(message => message.includes('Error processing anime: episodes boom')));
});

test('renren handleAnimes 日志输出过滤无关结果后的数量', async () => {
  reset();
  const source = new RenrenSource();
  const detail = detailData();
  const sourceAnimes = [
    { provider: 'renren', mediaId: '40356', title: '黄石', aliases: [], year: '2024', imageUrl: 'http://img.bwcgee.cn/a.webp' },
    { provider: 'renren', mediaId: '99999', title: '完全无关的剧', aliases: [], year: '2024', imageUrl: '' },
  ];

  const result = await withMockFetch(async () => response(detail), () => source.handleAnimes(sourceAnimes, '黄石', [], null));

  assert.equal(result.length, 1);
  assert.ok(logMessages().some(message => /\[renren\] (Win|TV|Mac|网页)端搜索提取结果数量: 2 过滤无关结果后数量：1/.test(message)));
});
