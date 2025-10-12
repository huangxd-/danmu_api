const test = require('node:test');
const assert = require('node:assert').strict;
const { handleRequest, searchAnime, matchAnime, searchEpisode, getBangumi, getComment, fetchTencentVideo, fetchIqiyi,
  fetchMangoTV, fetchBilibili, fetchYouku, fetchOtherServer, httpGet, httpPost,
  hanjutvSearch, getHanjutvEpisodes, getHanjutvComments, getHanjutvDetail,
  bahamutSearch, getBahamutEpisodes, getBahamutComments, pingRedis, getRedisKey,
  setRedisKey, setRedisKeyWithExpiry} = require('./worker');

// Mock Request class for testing
class MockRequest {
  constructor(url, options = {}) {
    this.url = url;
    this.method = options.method || 'GET';
    this.headers = new Map(Object.entries(options.headers || {}));
    this.json = options.body ? async () => options.body : undefined;  // 模拟 POST 请求的 body
  }
}

// Helper to parse JSON response
async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const urlPrefix = "http://localhost:9321";
const token = "87654321";

test('worker.js API endpoints', async (t) => {
  await t.test('GET / should return welcome message', async () => {
    const req = new MockRequest(urlPrefix, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(body.message, 'Welcome to the LogVar Danmu API server');
  });

  // await t.test('GET tencent danmu', async () => {
  //   const res = await fetchTencentVideo("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi danmu', async () => {
  //   const res = await fetchIqiyi("https://www.iqiyi.com/v_1ftv9n1m3bg.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET mango danmu', async () => {
  //   const res = await fetchMangoTV("https://www.mgtv.com/b/771610/23300622.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET bilibili danmu', async () => {
  //   const res = await fetchBilibili("https://www.bilibili.com/bangumi/play/ep1231564");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET youku danmu', async () => {
  //   const res = await fetchYouku("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET other_server danmu', async () => {
  //   const res = await fetchOtherServer("https://www.bilibili.com/bangumi/play/ep1231564");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv search', async () => {
  //   const res = await hanjutvSearch("犯罪现场Zero");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv detail', async () => {
  //   const res = await gethanjutvDetail("Tc9lkfijFSDQ8SiUCB6T");
  //   // assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv episodes', async () => {
  //   const res = await getHanjutvEpisodes("4EuRcD6T6y8XEQePtDsf");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv danmu', async () => {
  //   const res = await getHanjutvComments("12tY0Ktjzu5TCBrfTolNO");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut search', async () => {
  //   const res = await bahamutSearch("膽大黨");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut episodes', async () => {
  //   const res = await getBahamutEpisodes("44243");
  //   assert(res.anime.episodes[0].length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut danmu', async () => {
  //   const res = await getBahamutComments("44453");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  await t.test('GET realistic danmu', async () => {
    // tencent
    // const keyword = "子夜归";
    // iqiyi
    // const keyword = "赴山海";
    // mango
    // const keyword = "锦月如歌";
    // bilibili
    // const keyword = "国王排名";
    // youku
    // const keyword = "黑白局";
    // renren
    // const keyword = "瑞克和莫蒂";
    // hanjutv
    // const keyword = "请回答1988";
    // bahamut
    const keyword = "胆大党";

    const searchUrl = new URL(`${urlPrefix}/${token}/api/v2/search/anime?keyword=${keyword}`);
    const searchRes = await searchAnime(searchUrl);
    const searchData = await searchRes.json();
    assert(searchData.animes.length > 0, `Expected searchData.animes.length > 0, but got ${searchData.animes.length}`);

    const bangumiUrl = new URL(`${urlPrefix}/${token}/api/v2/bangumi/${searchData.animes[0].animeId}`);
    const bangumiRes = await getBangumi(bangumiUrl.pathname);
    const bangumiData = await bangumiRes.json();
    assert(bangumiData.bangumi.episodes.length > 0, `Expected bangumiData.bangumi.episodes.length > 0, but got ${bangumiData.bangumi.episodes.length}`);

    const commentUrl = new URL(`${urlPrefix}/${token}/api/v2/comment/${bangumiData.bangumi.episodes[0].episodeId}?withRelated=true&chConvert=1`);
    const commentRes = await getComment(commentUrl.pathname);
    const commentData = await commentRes.json();
    assert(commentData.count > 0, `Expected commentData.count > 0, but got ${commentData.count}`);
  });

  // // 测试 POST /api/v2/match 接口
  // await t.test('POST /api/v2/match for matching anime', async () => {
  //   // 构造请求体
  //   const requestBody = {
  //     "fileName": "生万物 S01E28",
  //     "fileHash": "1234567890",
  //     "fileSize": 0,
  //     "videoDuration": 0,
  //     "matchMode": "fileNameOnly"
  //   };
  //
  //   // 模拟 POST 请求
  //   const matchUrl = `${urlPrefix}/${token}/api/v2/match`;  // 注意路径与 handleRequest 中匹配
  //   const req = new MockRequest(matchUrl, { method: 'POST', body: requestBody });
  //
  //   // 调用 handleRequest 来处理 POST 请求
  //   const res = await handleRequest(req);
  //
  //   // 解析响应
  //   const responseBody = await parseResponse(res);
  //   console.log(responseBody);
  //
  //   // 验证响应状态
  //   assert.equal(res.status, 200);
  //   assert.deepEqual(responseBody.success, true);
  // });

  // // 测试 GET /api/v2/search/episodes 接口
  // await t.test('GET /api/v2/search/episodes for search episodes', async () => {
  //   // 构造请求体
  //   const requestBody = {
  //     "fileName": "生万物 S01E28",
  //     "fileHash": "1234567890",
  //     "fileSize": 0,
  //     "videoDuration": 0,
  //     "matchMode": "fileNameOnly"
  //   };
  //
  //   const matchUrl = `${urlPrefix}/${token}/api/v2/search/episodes?anime=子夜归`;
  //   const req = new MockRequest(matchUrl, { method: 'GET' });
  //
  //   const res = await handleRequest(req);
  //
  //   // 解析响应
  //   const responseBody = await parseResponse(res);
  //   console.log(responseBody);
  //
  //   // 验证响应状态
  //   assert.equal(res.status, 200);
  //   assert.deepEqual(responseBody.success, true);
  // });

  // 测试upstash redis
  // await t.test('GET redis pingRedis', async () => {
  //   const res = await pingRedis();
  //   assert(res.result === "PONG", `Expected res.result === "PONG", but got ${res.result}`);
  // });

  // await t.test('SET redis setRedisKey', async () => {
  //   const res = await setRedisKey('mykey', 'Hello World');
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });

  // await t.test('GET redis getRedisKey', async () => {
  //   const res = await getRedisKey('mykey');
  //   assert(res.result.toString() === "\"Hello World\"", `Expected res.result === "\"Hello World\"", but got ${res.result}`);
  // });

  // await t.test('SET redis setRedisKeyWithExpiry', async () => {
  //   const res = await setRedisKeyWithExpiry('expkey', 'Temporary Value', 10);
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });
});