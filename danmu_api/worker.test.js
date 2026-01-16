// 加载 .env 文件
import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { handleRequest } from './worker.js';
import { extractTitleSeasonEpisode, getBangumi, getComment, searchAnime } from "./apis/dandan-api.js";
import { getRedisKey, pingRedis, setRedisKey, setRedisKeyWithExpiry } from "./utils/redis-util.js";
import { getImdbepisodes } from "./utils/imdb-util.js";
import { getTMDBChineseTitle, getTmdbJpDetail, searchTmdbTitles } from "./utils/tmdb-util.js";
import { getDoubanDetail, getDoubanInfoByImdbId, searchDoubanTitles } from "./utils/douban-util.js";
import RenrenSource from "./sources/renren.js";
import HanjutvSource from "./sources/hanjutv.js";
import BahamutSource from "./sources/bahamut.js";
import TencentSource from "./sources/tencent.js";
import IqiyiSource from "./sources/iqiyi.js";
import MangoSource from "./sources/mango.js";
import BilibiliSource from "./sources/bilibili.js";
import YoukuSource from "./sources/youku.js";
import SohuSource from "./sources/sohu.js";
import LeshiSource from "./sources/leshi.js";
import AnimekoSource from "./sources/animeko.js";
import OtherSource from "./sources/other.js";
import { NodeHandler } from "./configs/handlers/node-handler.js";
import { VercelHandler } from "./configs/handlers/vercel-handler.js";
import { NetlifyHandler } from "./configs/handlers/netlify-handler.js";
import { CloudflareHandler } from "./configs/handlers/cloudflare-handler.js";
import { EdgeoneHandler } from "./configs/handlers/edgeone-handler.js";
import { Segment } from "./models/dandan-model.js"

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
  const renrenSource = new RenrenSource();
  const hanjutvSource = new HanjutvSource();
  const bahamutSource = new BahamutSource();
  const tencentSource = new TencentSource();
  const iqiyiSource = new IqiyiSource();
  const mangoSource = new MangoSource();
  const bilibiliSource = new BilibiliSource();
  const youkuSource = new YoukuSource();
  const sohuSource = new SohuSource();
  const leshiSource = new LeshiSource();
  const animekoSource = new AnimekoSource();
  const otherSource = new OtherSource();

  await t.test('GET / should return welcome message', async () => {
    const req = new MockRequest(urlPrefix, { method: 'GET' });
    const res = await handleRequest(req);
    const body = await parseResponse(res);

    assert.equal(res.status, 200);
  });

  // 测试标题解析
  await t.test('PARSE TitleSeasonEpisode', async () => {
    let title, season, episode;
    ({title, season, episode} = await extractTitleSeasonEpisode("生万物 S02E08"));
    assert(title === "生万物" && season == 2 && episode == 8, `Expected title === "生万物" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("无忧渡.S02E08.2160p.WEB-DL.H265.DDP.5.1"));
    assert(title === "无忧渡" && season == 2 && episode == 8, `Expected title === "无忧渡" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    // ({title, season, episode} = await extractTitleSeasonEpisode("Blood.River.S02E08"));
    // assert(title === "暗河传" && season == 2 && episode == 8, `Expected title === "暗河传" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("爱情公寓.ipartment.2009.S02E08.H.265.25fps.mkv"));
    assert(title === "爱情公寓" && season == 2 && episode == 8, `Expected title === "爱情公寓" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("亲爱的X S02E08"));
    assert(title === "亲爱的X" && season == 2 && episode == 8, `Expected title === "亲爱的X" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);

    ({title, season, episode} = await extractTitleSeasonEpisode("宇宙Marry Me? S02E08"));
    assert(title === "宇宙Marry Me?" && season == 2 && episode == 8, `Expected title === "宇宙Marry Me?" && season == 2 && episode == 8, but got ${title} ${season} ${episode}`);
  });

  // await t.test('GET tencent danmu', async () => {
  //   const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET tencent danmu segments', async () => {
  //   const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq", true);
  //   assert(res.type === "qq", `Expected res.type === "qq", but got ${res.type === "qq"}`);
  //   assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET tencent segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "qq",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://dm.video.qq.com/barrage/segment/j0032ubhl9s/t/v1/30000/60000"
  //   });
  //   const res = await tencentSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi danmu', async () => {
  //   const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi danmu segments', async () => {
  //   const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi", true);
  //   assert(res.type === "qiyi", `Expected res.type === "qiyi", but got ${res.type === "qiyi"}`);
  //   assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET iqiyi segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "qiyi",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://cmts.iqiyi.com/bullet/80/00/5284367795028000_300_4.z?rn=0.0123456789123456&business=danmu&is_iqiyi=true&is_video_page=true&tvid=5284367795028000&albumid=2524115110632101&categoryid=2&qypid=010102101000000000"
  //   });
  //   const res = await iqiyiSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET mango danmu', async () => {
  //   const res = await mangoSource.getComments("https://www.mgtv.com/b/771610/23300622.html", "imgo");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET mango danmu segments', async () => {
  //   const res = await mangoSource.getComments("https://www.mgtv.com/b/771610/23300622.html", "imgo", true);
  //   assert(res.type === "imgo", `Expected res.type === "imgo", but got ${res.type}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET mango segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "imgo",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://bullet-ali.hitv.com/bullet/tx/2025/12/14/011640/23300622/23.json"
  //   });
  //   const res = await mangoSource.getSegmentComments(segment);
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET bilibili danmu', async () => {
  //   const res = await bilibiliSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564", "bilibili1");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET bilibili danmu segments', async () => {
  //   const res = await bilibiliSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564", "bilibili1", true);
  //   assert(res.type === "bilibili1", `Expected res.type === "bilibili1", but got ${res.type}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET bilibili segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "bilibili1",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=32131450212&segment_index=2"
  //   });
  //   const res = await bilibiliSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET youku danmu', async () => {
  //   const res = await youkuSource.getComments("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET youku danmu segments', async () => {
  //   const res = await youkuSource.getComments("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html", "youku", true);
  //   assert(res.type === "youku", `Expected res.type === "youku", but got ${res.type === "youku"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET youku segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "youku",
  //     "segment_start": 0,
  //     "segment_end": 60,
  //     "url": "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/?jsv=2.5.6&appKey=24679788&t=1765980205381&sign=355caad7d41ec0bf445cce48fce4d93e&api=mopen.youku.danmu.list&v=1.0&type=originaljson&dataType=jsonp&timeout=20000&jsonpIncPrefix=utility",
  //     "data": "{\"ctime\":1765980205380,\"ctype\":10004,\"cver\":\"v1.0\",\"guid\":\"JqbJIT/Q0XMCAXPAGpb9gBcg\",\"mat\":0,\"mcount\":1,\"pid\":0,\"sver\":\"3.1.0\",\"type\":1,\"vid\":\"XNjQ3ODMyNjU3Mg==\",\"msg\":\"eyJjdGltZSI6MTc2NTk4MDIwNTM4MCwiY3R5cGUiOjEwMDA0LCJjdmVyIjoidjEuMCIsImd1aWQiOiJKcWJKSVQvUTBYTUNBWFBBR3BiOWdCY2ciLCJtYXQiOjAsIm1jb3VudCI6MSwicGlkIjowLCJzdmVyIjoiMy4xLjAiLCJ0eXBlIjoxLCJ2aWQiOiJYTmpRM09ETXlOalUzTWc9PSJ9\",\"sign\":\"b94e1d2cf6dc1ffcf80845b0ea82b7ef\"}",
  //     "_m_h5_tk": "d12df59d06f2830de1c681e04285a895_1765985058907",
  //     "_m_h5_tk_enc": "082c6cbbad97b5b48b7798a51933bbfa"
  //   });
  //   const res = await youkuSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET sohu danmu', async () => {
  //   const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET sohu danmu segments', async () => {
  //   const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html", "sohu", true);
  //   assert(res.type === "sohu", `Expected res.type === "sohu", but got ${res.type === "sohu"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET sohu segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'sohu',
  //     segment_start: 3000,
  //     segment_end: 3300,
  //     url: 'https://api.danmu.tv.sohu.com/dmh5/dmListAll?act=dmlist_v2&vid=2547437&aid=8345543&pct=2&time_begin=3000&time_end=3300&dct=1&request_from=h5_js',
  //   });
  //   const res = await sohuSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET leshi danmu', async () => {
  //   const res = await leshiSource.getComments("https://www.le.com/ptv/vplay/1578861.html");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET leshi danmu segments', async () => {
  //   const res = await leshiSource.getComments("https://www.le.com/ptv/vplay/1578861.html", "leshi", true);
  //   assert(res.type === "leshi", `Expected res.type === "leshi", but got ${res.type === "leshi"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET leshi segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     type: 'leshi',
  //     segment_start: 1800,
  //     segment_end: 2100,
  //     url: 'https://hd-my.le.com/danmu/list?vid=1578861&start=1800&end=2100&callback=vjs_1768494351290',
  //   });
  //   const res = await leshiSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET other_server danmu', async () => {
  //   const res = await otherSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564");
  //   assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv search', async () => {
  //   const res = await hanjutvSource.search("犯罪现场Zero");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv detail', async () => {
  //   const res = await hanjutvSource.getDetail("Tc9lkfijFSDQ8SiUCB6T");
  //   // assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv episodes', async () => {
  //   const res = await hanjutvSource.getEpisodes("4EuRcD6T6y8XEQePtDsf");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv danmu', async () => {
  //   const res = await hanjutvSource.getEpisodeDanmu("12tY0Ktjzu5TCBrfTolNO");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET hanjutv danmu segments', async () => {
  //   const res = await hanjutvSource.getComments("12tY0Ktjzu5TCBrfTolNO", "hanjutv", true);
  //   console.log(res);
  //   assert(res.type === "hanjutv", `Expected res.type === "hanjutv", but got ${res.type === "hanjutv"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET hanjutv segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "hanjutv",
  //     "segment_start": 0,
  //     "segment_end": 30000,
  //     "url": "12tY0Ktjzu5TCBrfTolNO"
  //   });
  //   const res = await hanjutvSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut search', async () => {
  //   const res = await bahamutSource.search("胆大党");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut episodes', async () => {
  //   const res = await bahamutSource.getEpisodes("44243");
  //   assert(res.anime.episodes[0].length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut danmu', async () => {
  //   const res = await bahamutSource.getComments("44453");
  //   assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  // });

  // await t.test('GET bahamut danmu segments', async () => {
  //   const res = await bahamutSource.getComments("44453", "bahamut", true);
  //   console.log(res);
  //   assert(res.type === "bahamut", `Expected res.type === "bahamut", but got ${res.type === "bahamut"}`);
  //   assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  // });

  // await t.test('GET bahamut segment danmu', async () => {
  //   const segment = Segment.fromJson({
  //     "type": "bahamut",
  //     "segment_start": 0,
  //     "segment_end": 30000,
  //     "url": "44453"
  //   });
  //   const res = await bahamutSource.getSegmentComments(segment);
  //   assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  // });

  // // 测试Animeko源
  // await t.test('Animeko Source Search', async () => {
  //   const source = new AnimekoSource();
  //   const result = await source.search("我们不可能成为恋人！绝对不行。 (※似乎可行？)");
  //   console.log(JSON.stringify(result, null, 2));
  //   assert(result.length > 0);
  //
  //   const curAnimes = []; 
  //   await source.handleAnimes(result, "我们不可能成为恋人！绝对不行。 (※似乎可行？)", curAnimes);
  //   assert(curAnimes.length > 0);
  //   
  //   const animeId = result[0].id;
  //   const episodes = await source.getEpisodes(animeId);
  //   
  //   if (episodes && episodes.length > 0) {
  //       const firstEp = episodes.find(e => e.type === 0) || episodes[0];
  //       const testId = firstEp.id;
  //       
  //       console.log(`Testing getSegmentComments with ID: ${testId}`);
  //       
  //       const segment = { 
  //           url: String(testId),
  //           type: 'animeko'
  //       };
  //       
  //       const danmu = await source.getSegmentComments(segment);
  //       
  //       console.log("Danmu count:", danmu ? danmu.length : 0);
  //       assert(Array.isArray(danmu));
  //       
  //       if (danmu.length > 0) {
  //           assert(danmu[0].p !== undefined);
  //           assert(danmu[0].m !== undefined);
  //       }
  //   }
  // });

  // await t.test('GET realistic danmu', async () => {
  //   // tencent
  //   // const keyword = "子夜归";
  //   // iqiyi
  //   // const keyword = "赴山海";
  //   // mango
  //   // const keyword = "锦月如歌";
  //   // bilibili
  //   // const keyword = "国王排名";
  //   // youku
  //   // const keyword = "黑白局";
  //   // renren
  //   // const keyword = "瑞克和莫蒂";
  //   // hanjutv
  //   // const keyword = "请回答1988";
  //   // bahamut
  //   const keyword = "胆大党";
  //
  //   const searchUrl = new URL(`${urlPrefix}/${token}/api/v2/search/anime?keyword=${keyword}`);
  //   const searchRes = await searchAnime(searchUrl);
  //   const searchData = await searchRes.json();
  //   assert(searchData.animes.length > 0, `Expected searchData.animes.length > 0, but got ${searchData.animes.length}`);
  //
  //   const bangumiUrl = new URL(`${urlPrefix}/${token}/api/v2/bangumi/${searchData.animes[0].animeId}`);
  //   const bangumiRes = await getBangumi(bangumiUrl.pathname);
  //   const bangumiData = await bangumiRes.json();
  //   assert(bangumiData.bangumi.episodes.length > 0, `Expected bangumiData.bangumi.episodes.length > 0, but got ${bangumiData.bangumi.episodes.length}`);
  //
  //   const commentUrl = new URL(`${urlPrefix}/${token}/api/v2/comment/${bangumiData.bangumi.episodes[0].episodeId}?withRelated=true&chConvert=1`);
  //   const commentRes = await getComment(commentUrl.pathname);
  //   const commentData = await commentRes.json();
  //   assert(commentData.count > 0, `Expected commentData.count > 0, but got ${commentData.count}`);
  // });

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
  //
  // await t.test('SET redis setRedisKey', async () => {
  //   const res = await setRedisKey('mykey', 'Hello World');
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });
  //
  // await t.test('GET redis getRedisKey', async () => {
  //   const res = await getRedisKey('mykey');
  //   assert(res.result.toString() === "\"Hello World\"", `Expected res.result === "\"Hello World\"", but got ${res.result}`);
  // });
  //
  // await t.test('SET redis setRedisKeyWithExpiry', async () => {
  //   const res = await setRedisKeyWithExpiry('expkey', 'Temporary Value', 10);
  //   assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  // });

  // // 测试imdb接口
  // await t.test('GET IMDB episodes', async () => {
  //   const res = await getImdbepisodes("tt2703720");
  //   assert(res.data.episodes.length > 10, `Expected res.data.episodes.length > 10, but got ${res.episodes.length}`);
  // });

  // // 测试tmdb接口
  // await t.test('GET TMDB titles', async () => {
  //   const res = await searchImdbTitles("卧虎藏龙");
  //   assert(res.data.total_results > 4, `Expected res.data.total_results > 4, but got ${res.total_results}`);
  // });

  // // 测试tmdb获取日语详情接口
  // await t.test('GET TMDB JP detail', async () => {
  //   const res = await getTmdbJpDetail("tv", 95396);
  //   assert(res.data.original_name === "Severance", `Expected res.data.Severance === "Severance", but got ${res.data.original_name}`);
  // });

  // // 测试douban获取titles
  // await t.test('GET DOUBAN titles', async () => {
  //   const res = await searchDoubanTitles("卧虎藏龙");
  //   assert(res.data.subjects.items.length > 3, `Expected res.data.subjects.items.length > 3, but got ${res.data.subjects.items.length}`);
  // });

  // // 测试douban获取detail
  // await t.test('GET DOUBAN detail', async () => {
  //   const res = await getDoubanDetail(36448279);
  //   assert(res.data.title === "罗小黑战记2", `Expected res.data.title === "罗小黑战记2", but got ${res.data.title}`);
  // });

  // // 测试douban从imdbId获取doubanInfo
  // await t.test('GET DOUBAN doubanInfo by imdbId', async () => {
  //   const res = await getDoubanInfoByImdbId("tt0071562");
  //   const doubanId = res.data?.id?.split("/")?.pop();
  //   assert(doubanId === "1299131", `Expected doubanId === 1299131, but got ${doubanId}`);
  // });

  // // 测试tmdb获取中文标题
  // await t.test('GET TMDB Chinese title', async () => {
  //   const res = await getTMDBChineseTitle("Blood River", 1, 4);
  //   assert(res === "暗河传", `Expected res === "暗河传", but got ${res}`);
  // });

  // // 测试获取全部环境变量
  // await t.test('Config getAllEnv', async () => {
  //   const handler = new NodeHandler();
  //   const res = handler.getAllEnv();
  //   assert(Number(res.DANMU_LIMIT) === 0, `Expected Number(res.DANMU_LIMIT) === 0, but got ${Number(res.DANMU_LIMIT)}`);
  // });

  // // 测试获取某个环境变量
  // await t.test('Config getEnv', async () => {
  //   const handler = new NodeHandler();
  //   const res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  // });

  // // 测试Node设置环境变量
  // await t.test('Node Config setEnv', async () => {
  //   const handler = new NodeHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Node添加和删除环境变量
  // await t.test('Node Config addEnv and del Env', async () => {
  //   const handler = new NodeHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Vercel设置环境变量
  // await t.test('Vercel Config setEnv', async () => {
  //   const handler = new VercelHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Vercel添加和删除环境变量
  // await t.test('Vercel Config addEnv and del Env', async () => {
  //   const handler = new VercelHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Vercel项目变量是否生效
  // await t.test('Vercel Check Params', async () => {
  //   const handler = new VercelHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Vercel触发部署
  // await t.test('Vercel deploy', async () => {
  //   const handler = new VercelHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Netlify设置环境变量
  // await t.test('Netlify Config setEnv', async () => {
  //   const handler = new NetlifyHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });
  //
  // // 测试Netlify添加和删除环境变量
  // await t.test('Netlify Config addEnv and del Env', async () => {
  //   const handler = new NetlifyHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Netlify项目变量是否生效
  // await t.test('Netlify Check Params', async () => {
  //   const handler = new NetlifyHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Netlify触发部署
  // await t.test('Netlify deploy', async () => {
  //   const handler = new NetlifyHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Cloudflare设置环境变量
  // await t.test('Cloudflare Config setEnv', async () => {
  //   const handler = new CloudflareHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });

  // // 测试Cloudflare添加和删除环境变量
  // await t.test('Cloudflare Config addEnv and del Env', async () => {
  //   const handler = new CloudflareHandler();
  //   await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
  //   let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
  //   res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Cloudflare项目变量是否生效
  // await t.test('Cloudflare Check Params', async () => {
  //   const handler = new CloudflareHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Edgeone设置环境变量
  // await t.test('Edgeone Config setEnv', async () => {
  //   const handler = new EdgeoneHandler();
  //   let res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 1);
  //   res = handler.getEnv("DANMU_LIMIT");
  //   assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
  //   await handler.setEnv("DANMU_LIMIT", 0);
  // });

  // // 测试Edgeone添加和删除环境变量
  // await t.test('Edgeone Config addEnv and del Env', async () => {
  //   const handler = new EdgeoneHandler();
  //   await handler.addEnv("PROXY_URL", "xxxx");
  //   let res = handler.getEnv("PROXY_URL");
  //   assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
  //   await handler.delEnv("PROXY_URL");
  //   res = handler.getEnv("PROXY_URL");
  //   assert(res === "", `Expected res === "", but got ${res}`);
  // });

  // // 测试Edgeone项目变量是否生效
  // await t.test('Edgeone Check Params', async () => {
  //   const handler = new EdgeoneHandler();
  //   const res = await handler.checkParams("", "", "");
  //   assert(res, `Expected res is true, but got ${res}`);
  // });

  // // 测试Edgeone触发部署
  // await t.test('Edgeone deploy', async () => {
  //   const handler = new EdgeoneHandler();
  //   const res = await handler.deploy();
  //   assert(res, `Expected res is true, but got ${res}`);
  // });
});
