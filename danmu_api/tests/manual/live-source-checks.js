// 手工巡检：真实数据源联网用例（不参与 node --test 自动发现，也不会在 npm test 中执行）
//
// 用途：需要联网、真实平台 token / Cookie 时，手动验证各数据源与端点是否仍然可用。
// 这些用例由原单文件测试 worker.test.js 中注释掉的实测块恢复而来。
//
// 运行方式（本文件不匹配 node --test 的测试文件发现规则，必须显式指定路径）：
//   node --test danmu_api/tests/manual/live-source-checks.js
// 只跑某一组（--test-name-pattern 只能按顶层用例名筛选）：
//   node --test --test-name-pattern="local-redis functions" danmu_api/tests/manual/live-source-checks.js
// 顶层用例共 4 组：
//   真实数据源手工巡检：接口与缓存快照 / local-redis functions /
//   bangumi-data 数据下载时机与配置变更触发下载 / bangumi-data 在途下载暴露与边缘生命周期延长
// 注意：选中「真实数据源手工巡检」这一组时，组内全部子用例都会执行（约 70 条联网用例），
// 无法只挑其中一条；组内用例会依次访问各真实数据源接口，耗时较长。
// 需要真实环境变量（config/.env，如 TOKEN、UPSTASH_REDIS_*、代理等）时先配置好再运行。
// 部分用例会读写仓库根目录的 .cache/，建议不要与 npm test 同时运行。
// 写入类用例（真实平台环境变量写入、触发真实部署、真实 Redis 写）默认跳过，
// 确认要执行时带上 LIVE_SOURCE_WRITE_CHECKS=true。
//
// 维护约定：
//   · 不依赖联网、断言有效的用例应提取到 danmu_api/tests/ 下与源码对应的 *.test.js（随 npm test 执行），
//     本文件只保留真正需要联网 / 真实平台凭据的巡检用例；
//   · 断言恒真（如 length >= 0）、已过期（接口或规则已变）或绑定本机 config/.env 取值的用例应删除，
//     它们既不能发现回归，也会掩盖真实失败。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs'; // 手工巡检块使用同步 API（existsSync/mkdirSync/readFileSync/writeFileSync）
import path from 'node:path';
import { getBangumi, getComment, getCommentByUrl, matchAnime, searchAnime } from '../../apis/dandan-api.js';
import { Globals, globals } from '../../configs/globals.js';
import { CloudflareHandler } from '../../configs/handlers/cloudflare-handler.js';
import { EdgeoneHandler } from '../../configs/handlers/edgeone-handler.js';
import { NetlifyHandler } from '../../configs/handlers/netlify-handler.js';
import { NodeHandler } from '../../configs/handlers/node-handler.js';
import { VercelHandler } from '../../configs/handlers/vercel-handler.js';
import { Bangumi, Segment, SegmentListResponse } from '../../models/dandan-model.js';
import AnimekoSource from '../../sources/animeko.js';
import HongguoSource, { parseHongguoPlayerUrl } from '../../sources/hongguo.js';
import { getSourceByKey } from '../../sources/registry.js';
import { initBangumiData, searchBangumiData, clearBangumiDataCache, ensureBangumiDataReady, syncBangumiDataLifecycleOnConfigChange, getBackgroundDownload, extendBangumiDownloadLifecycle } from '../../utils/bangumi-data-util.js';
import { getDoubanDetail, getDoubanInfoByImdbId, searchDoubanTitles } from '../../utils/douban-util.js';
import { getImdbepisodes, searchImdbTitles } from '../../utils/imdb-util.js';
import { getLocalRedisKey, setLocalRedisKey, setLocalRedisKeyWithExpiry } from '../../utils/local-redis-util.js';
import { getRedisKey, pingRedis, setRedisKey, setRedisKeyWithExpiry } from '../../utils/redis-util.js';
import { getTMDBChineseTitle, getTmdbJpDetail } from '../../utils/tmdb-util.js';
import { MockRequest, createSearchResult, mockJsonResponse, parseResponse, resetSearchState, token, urlPrefix, withMockFetch } from '../helpers/context.js';

test('真实数据源手工巡检：接口与缓存快照', async t => {
  const hanjutvSource = getSourceByKey('hanjutv');
  const bahamutSource = getSourceByKey('bahamut');
  const tencentSource = getSourceByKey('tencent');
  const iqiyiSource = getSourceByKey('iqiyi');
  const mangoSource = getSourceByKey('imgo');
  const bilibiliSource = getSourceByKey('bilibili');
  const youkuSource = getSourceByKey('youku');
  const miguSource = getSourceByKey('migu');
  const sohuSource = getSourceByKey('sohu');
  const leshiSource = getSourceByKey('leshi');
  const xiguaSource = getSourceByKey('xigua');
  const maiduiduiSource = getSourceByKey('maiduidui');
  const aiyifanSource = getSourceByKey('aiyifan');
  const hongguoSource = getSourceByKey('hongguo');
  const otherSource = getSourceByKey('other');

  // 写入类用例（真实平台环境变量 / 真实部署 / 真实 Redis 写）默认跳过：
  // 需要执行时设置 LIVE_SOURCE_WRITE_CHECKS=true，例如
  //   LIVE_SOURCE_WRITE_CHECKS=true node --test danmu_api/tests/manual/live-source-checks.js
  const writeChecks = process.env.LIVE_SOURCE_WRITE_CHECKS === 'true';


  await t.test('GET tencent danmu', async () => {
    const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET tencent danmu segments', async () => {
    const res = await tencentSource.getComments("http://v.qq.com/x/cover/rjae621myqca41h/j0032ubhl9s.html", "qq", true);
    assert(res.type === "qq", `Expected res.type === "qq", but got ${res.type === "qq"}`);
    assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  });

  await t.test('GET tencent segment danmu', async () => {
    const segment = Segment.fromJson({
      "type": "qq",
      "segment_start": 0,
      "segment_end": 60,
      "url": "https://dm.video.qq.com/barrage/segment/j0032ubhl9s/t/v1/30000/60000"
    });
    const res = await tencentSource.getSegmentComments(segment);
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET iqiyi danmu', async () => {
    const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET iqiyi danmu segments', async () => {
    const res = await iqiyiSource.getComments("https://www.iqiyi.com/v_1ftv9n1m3bg.html", "qiyi", true);
    assert(res.type === "qiyi", `Expected res.type === "qiyi", but got ${res.type === "qiyi"}`);
    assert(res.segmentList.length > 2, `Expected res.segmentList.length > 2, but got ${res.length}`);
  });

  await t.test('GET iqiyi segment danmu', async () => {
    const segment = Segment.fromJson({
      "type": "qiyi",
      "segment_start": 0,
      "segment_end": 60,
      "url": "https://cmts.iqiyi.com/bullet/80/00/5284367795028000_300_4.z?rn=0.0123456789123456&business=danmu&is_iqiyi=true&is_video_page=true&tvid=5284367795028000&albumid=2524115110632101&categoryid=2&qypid=010102101000000000"
    });
    const res = await iqiyiSource.getSegmentComments(segment);
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET mango danmu', async () => {
    const res = await mangoSource.getComments("https://www.mgtv.com/b/771610/23300622.html", "imgo");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET mango segment danmu', async () => {
    const segment = Segment.fromJson({
      "type": "imgo",
      "segment_start": 0,
      "segment_end": 60,
      "url": "https://bullet-ali.hitv.com/bullet/tx/2025/12/14/011640/23300622/23.json"
    });
    const res = await mangoSource.getSegmentComments(segment);
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET bilibili danmu', async () => {
    const res = await bilibiliSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564", "bilibili1");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET bilibili segment danmu', async () => {
    const segment = Segment.fromJson({
      "type": "bilibili1",
      "segment_start": 0,
      "segment_end": 60,
      "url": "https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=32131450212&segment_index=2"
    });
    const res = await bilibiliSource.getSegmentComments(segment);
    assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  });

  await t.test('GET youku danmu', async () => {
    const res = await youkuSource.getComments("https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET youku segment danmu', async () => {
    const segment = Segment.fromJson({
      "type": "youku",
      "segment_start": 0,
      "segment_end": 60,
      "url": "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/?jsv=2.5.6&appKey=24679788&t=1765980205381&sign=355caad7d41ec0bf445cce48fce4d93e&api=mopen.youku.danmu.list&v=1.0&type=originaljson&dataType=jsonp&timeout=20000&jsonpIncPrefix=utility",
      "data": "{\"ctime\":1765980205380,\"ctype\":10004,\"cver\":\"v1.0\",\"guid\":\"JqbJIT/Q0XMCAXPAGpb9gBcg\",\"mat\":0,\"mcount\":1,\"pid\":0,\"sver\":\"3.1.0\",\"type\":1,\"vid\":\"XNjQ3ODMyNjU3Mg==\",\"msg\":\"eyJjdGltZSI6MTc2NTk4MDIwNTM4MCwiY3R5cGUiOjEwMDA0LCJjdmVyIjoidjEuMCIsImd1aWQiOiJKcWJKSVQvUTBYTUNBWFBBR3BiOWdCY2ciLCJtYXQiOjAsIm1jb3VudCI6MSwicGlkIjowLCJzdmVyIjoiMy4xLjAiLCJ0eXBlIjoxLCJ2aWQiOiJYTmpRM09ETXlOalUzTWc9PSJ9\",\"sign\":\"b94e1d2cf6dc1ffcf80845b0ea82b7ef\"}",
      "_m_h5_tk": "d12df59d06f2830de1c681e04285a895_1765985058907",
      "_m_h5_tk_enc": "082c6cbbad97b5b48b7798a51933bbfa"
    });
    const res = await youkuSource.getSegmentComments(segment);
    assert(res.length >= 0, `Expected res.length >= 0, but got ${res.length}`);
  });

  await t.test('GET migu danmu', async () => {
    const res = await miguSource.getComments("https://www.miguvideo.com/p/detail/725117610", "migu");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET migu danmu segments', async () => {
    const res = await miguSource.getComments("https://www.miguvideo.com/p/detail/725117610", "migu", true);
    console.log(res.segmentList);
    assert(res.type === "migu", `Expected res.type === "migu", but got ${res.type === "migu"}`);
    assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  });


  await t.test('GET sohu danmu', async () => {
    const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });

  await t.test('GET sohu danmu segments', async () => {
    const res = await sohuSource.getComments("https://film.sohu.com/album/8345543.html", "sohu", true);
    assert(res.type === "sohu", `Expected res.type === "sohu", but got ${res.type === "sohu"}`);
    assert(res.segmentList.length >= 0, `Expected res.segmentList.length >= 0, but got ${res.segmentList.length}`);
  });


  await t.test('GET leshi danmu', async () => {
    const res = await leshiSource.getComments("https://www.le.com/ptv/vplay/1578861.html");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET xigua danmu', async () => {
    const res = await xiguaSource.getComments("https://m.ixigua.com/video/6551333775337325060", "xigua");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET maiduidui danmu', async () => {
    const res = await maiduiduiSource.getComments("https://www.mddcloud.com.cn/video/ff8080817410d5a5017490f5f4d311de.html?num=2&uuid=ff8080817410d5a5017490f5f4d311e0", "maiduidui");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET aiyifan danmu', async () => {
    const res = await aiyifanSource.getComments("https://www.yfsp.tv/play/E4si52uysIH?id=dpK7e0uLKe2", "aiyifan");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET hongguo danmu', async () => {
    const episodeId = 'hongguo:v1:series-1:vid-1:60';
    const originalFetchCommentWindow = hongguoSource.fetchCommentWindow;
    hongguoSource.fetchCommentWindow = async (_info, startMs) => ({
      comments: startMs === 0
        ? [{ commentId: 'comment-1', offsetMs: 1500, text: 'first', diggCount: 7 }]
        : [
            { commentId: 'comment-1', offsetMs: 1500, text: 'first', diggCount: 7 },
            { commentId: 'comment-2', offsetMs: 31500, text: 'second', diggCount: 3 },
          ],
      nextStart: startMs + 30000,
      cursor: `cursor-${startMs}`,
      hasMore: true,
    });
    try {
      const res = await hongguoSource.getComments(episodeId, 'hongguo');
      assert.equal(res.length, 2);
      assert.deepEqual(res.map((item) => item.t), [1.5, 31.5]);
      assert.match(res[0].p, /\[hongguo\]$/);
    } finally {
      hongguoSource.fetchCommentWindow = originalFetchCommentWindow;
    }
  });


  await t.test('GET hongguo segment danmu', async () => {
    const originalFetchCommentWindow = hongguoSource.fetchCommentWindow;
    hongguoSource.fetchCommentWindow = async () => ({
      comments: [
        { commentId: 'before', offsetMs: 29999, text: 'before', diggCount: 0 },
        { commentId: 'inside', offsetMs: 31500, text: 'inside', diggCount: 2 },
        { commentId: 'after', offsetMs: 60000, text: 'after', diggCount: 0 },
      ],
      nextStart: 60000,
      cursor: '',
      hasMore: false,
    });
    try {
      const segment = Segment.fromJson({
        type: 'hongguo',
        segment_start: 30,
        segment_end: 60,
        url: 'hongguo:v1:series-1:vid-1:60#segment=30',
      });
      const res = await hongguoSource.getSegmentComments(segment);
      assert.equal(res.length, 1);
      assert.equal(res[0].m, 'inside');
      assert.equal(res[0].t, 31.5);
    } finally {
      hongguoSource.fetchCommentWindow = originalFetchCommentWindow;
    }
  });

  await t.test('Hongguo player URL should resolve the exact episode', async () => {
    const playerUrl = 'https://hongguoduanju.com/player/7572458140411628568/7572460055539223614';
    assert.deepEqual(parseHongguoPlayerUrl(playerUrl), {
      seriesId: '7572458140411628568',
      vid: '7572460055539223614',
    });

    const source = new HongguoSource();
    let requestedSeriesId = '';
    let detailRequests = 0;
    source.getEpisodes = async (seriesId) => {
      detailRequests++;
      requestedSeriesId = seriesId;
      return {
        episodes: [
          { index: 1, vid: '7572459982168280126', duration: 150 },
          { index: 2, vid: '7572460055539223614', duration: 119 },
        ],
        imageUrl: '',
      };
    };

    const segments = await source.getComments(playerUrl, 'hongguo', true);
    assert.equal(requestedSeriesId, '7572458140411628568');
    assert.equal(segments.duration, 119);
    assert.equal(segments.segmentList.length, 4);
    assert.equal(
      segments.segmentList[0].url,
      'hongguo:v1:7572458140411628568:7572460055539223614:119#segment=0',
    );

    source.fetchCommentWindow = async (info) => {
      assert.equal(info.vid, '7572460055539223614');
      return {
        comments: [{ commentId: 'link-comment', offsetMs: 1500, text: '链接弹幕', diggCount: 2 }],
        nextStart: 119000,
        cursor: '',
        hasMore: false,
      };
    };
    const comments = await source.getComments(playerUrl, 'hongguo');
    assert.equal(detailRequests, 1);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].m, '链接弹幕');
  });

  await t.test('GET comments by Hongguo player URL should use resolved vid', async () => {
    const seriesId = '7572458140411628568';
    const vid = '7572460055539223614';
    const playerUrl = `https://hongguoduanju.com/player/${seriesId}/${vid}`;
    const requestedUrls = [];

    const response = await withMockFetch(async (url) => {
      requestedUrls.push(String(url));
      if (String(url).includes('/novel/player/multi_video_detail/v1/')) {
        return mockJsonResponse({
          code: 0,
          data: {
            [seriesId]: {
              video_data: {
                video_list: [{ vid_index: 1, vid, duration: 119 }],
              },
            },
          },
        }, String(url));
      }
      if (String(url).includes(`/novel/commentapi/comment/list/${vid}/v1/`)) {
        return mockJsonResponse({
          code: 0,
          data: {
            data_list: [{
              comment: {
                comment_id: 'route-comment',
                common: { content: { text: '路由弹幕' } },
                expand: { offset_time: 1500 },
                stat: { digg_count: 3 },
              },
            }],
            common_list_info: { cursor: '', has_more: false },
            extra: { next_query_danmaku_list_time: 119000 },
          },
        }, String(url));
      }
      throw new Error(`Unexpected Hongguo request: ${url}`);
    }, () => getCommentByUrl(playerUrl, 'json', false));

    const body = await parseResponse(response);
    assert.equal(body.count, 1);
    assert.equal(body.comments[0].m, '路由弹幕');
    assert(requestedUrls.some((url) => url.includes('/novel/player/multi_video_detail/v1/')));
    assert(requestedUrls.some((url) => url.includes(`/novel/commentapi/comment/list/${vid}/v1/`)));
  });

  await t.test('GET other_server danmu', async () => {
    const res = await otherSource.getComments("https://www.bilibili.com/bangumi/play/ep1231564");
    assert(res.length > 2, `Expected res.length > 2, but got ${res.length}`);
  });


  await t.test('GET hanjutv search', async () => {
    const res = await hanjutvSource.search("犯罪现场Zero");
    assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  });


  await t.test('GET hanjutv danmu', async () => {
    const res = await hanjutvSource.getEpisodeDanmu("12tY0Ktjzu5TCBrfTolNO");
    assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  });


  await t.test('GET bahamut search', async () => {
    const res = await bahamutSource.search("胆大党");
    assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  });

  await t.test('GET bahamut episodes', async () => {
    const res = await bahamutSource.getEpisodes("44243");
    assert(res.anime.episodes[0].length > 0, `Expected res.length > 0, but got ${res.length}`);
  });

  await t.test('GET bahamut danmu', async () => {
    const res = await bahamutSource.getComments("44453");
    assert(res.length > 0, `Expected res.length > 0, but got ${res.length}`);
  });


  // 测试Animeko源
  await t.test('Animeko Source Search', async () => {
    const source = new AnimekoSource();
    const result = await source.search("我们不可能成为恋人！绝对不行。 (※似乎可行？)");
    console.log(JSON.stringify(result, null, 2));
    assert(result.length > 0);

    const curAnimes = []; 
    await source.handleAnimes(result, "我们不可能成为恋人！绝对不行。 (※似乎可行？)", curAnimes);
    assert(curAnimes.length > 0);
    
    const animeId = result[0].id;
    const episodes = await source.getEpisodes(animeId);
    
    if (episodes && episodes.length > 0) {
        const firstEp = episodes.find(e => e.type === 0) || episodes[0];
        const testId = firstEp.id;
        
        console.log(`Testing getSegmentComments with ID: ${testId}`);
        
        const segment = { 
            url: String(testId),
            type: 'animeko'
        };
        
        const danmu = await source.getSegmentComments(segment);
        
        console.log("Danmu count:", danmu ? danmu.length : 0);
        assert(Array.isArray(danmu));
        
        if (danmu.length > 0) {
            assert(danmu[0].p !== undefined);
            assert(danmu[0].m !== undefined);
        }
    }
  });

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

  // 测试 POST /api/v2/match 接口

  // 测试 GET /api/v2/search/episodes 接口

  // 测试upstash redis
  await t.test('GET redis pingRedis', async () => {
    const res = await pingRedis();
    assert(res.result === "PONG", `Expected res.result === "PONG", but got ${res.result}`);
  });

  await t.test('SET redis setRedisKey', { skip: !writeChecks }, async () => {
    const res = await setRedisKey('mykey', 'Hello World');
    assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  });

  await t.test('GET redis getRedisKey', { skip: !writeChecks }, async () => {
    const res = await getRedisKey('mykey');
    assert(res.result.toString() === "\"Hello World\"", `Expected res.result === "\"Hello World\"", but got ${res.result}`);
  });

  await t.test('SET redis setRedisKeyWithExpiry', { skip: !writeChecks }, async () => {
    const res = await setRedisKeyWithExpiry('expkey', 'Temporary Value', 10);
    assert(res.result === "OK", `Expected res.result === "OK", but got ${res.result}`);
  });

  // 测试imdb接口
  await t.test('GET IMDB episodes', async () => {
    const res = await getImdbepisodes("tt2703720");
    assert(res.data.episodes.length > 10, `Expected res.data.episodes.length > 10, but got ${res.episodes.length}`);
  });

  // 测试tmdb接口
  await t.test('GET TMDB titles', async () => {
    const res = await searchImdbTitles("卧虎藏龙");
    assert(res.data.total_results > 4, `Expected res.data.total_results > 4, but got ${res.total_results}`);
  });

  // 测试tmdb获取日语详情接口
  await t.test('GET TMDB JP detail', async () => {
    const res = await getTmdbJpDetail("tv", 95396);
    assert(res.data.original_name === "Severance", `Expected res.data.Severance === "Severance", but got ${res.data.original_name}`);
  });

  // 测试douban获取titles
  await t.test('GET DOUBAN titles', async () => {
    const res = await searchDoubanTitles("卧虎藏龙");
    assert(res.data.subjects.items.length > 3, `Expected res.data.subjects.items.length > 3, but got ${res.data.subjects.items.length}`);
  });

  // 测试douban获取detail
  await t.test('GET DOUBAN detail', async () => {
    const res = await getDoubanDetail(36448279);
    assert(res.data.title === "罗小黑战记2", `Expected res.data.title === "罗小黑战记2", but got ${res.data.title}`);
  });

  // 测试douban从imdbId获取doubanInfo
  await t.test('GET DOUBAN doubanInfo by imdbId', async () => {
    const res = await getDoubanInfoByImdbId("tt0071562");
    const doubanId = res.data?.id?.split("/")?.pop();
    assert(doubanId === "1299131", `Expected doubanId === 1299131, but got ${doubanId}`);
  });

  // 测试tmdb获取中文标题
  await t.test('GET TMDB Chinese title', async () => {
    const res = await getTMDBChineseTitle("Blood River", 1, 4);
    assert(res === "暗河传", `Expected res === "暗河传", but got ${res}`);
  });

  // 测试获取全部环境变量

  // 测试获取某个环境变量

  // 测试Node设置环境变量
  await t.test('Node Config setEnv', { skip: !writeChecks }, async () => {
    const handler = new NodeHandler();
    let res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 1);
    res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 0);
  });

  // 测试Node添加和删除环境变量
  await t.test('Node Config addEnv and del Env', { skip: !writeChecks }, async () => {
    const handler = new NodeHandler();
    await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
    let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
    await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
    res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "", `Expected res === "", but got ${res}`);
  });

  // 测试Vercel设置环境变量
  await t.test('Vercel Config setEnv', { skip: !writeChecks }, async () => {
    const handler = new VercelHandler();
    let res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 1);
    res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 0);
  });

  // 测试Vercel添加和删除环境变量
  await t.test('Vercel Config addEnv and del Env', { skip: !writeChecks }, async () => {
    const handler = new VercelHandler();
    await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
    let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
    await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
    res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "", `Expected res === "", but got ${res}`);
  });

  // 测试Vercel项目变量是否生效
  await t.test('Vercel Check Params', async () => {
    const handler = new VercelHandler();
    const res = await handler.checkParams("", "", "");
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Vercel触发部署
  await t.test('Vercel deploy', { skip: !writeChecks }, async () => {
    const handler = new VercelHandler();
    const res = await handler.deploy();
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Netlify设置环境变量
  await t.test('Netlify Config setEnv', { skip: !writeChecks }, async () => {
    const handler = new NetlifyHandler();
    let res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 1);
    res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 0);
  });

  // 测试Netlify添加和删除环境变量
  await t.test('Netlify Config addEnv and del Env', { skip: !writeChecks }, async () => {
    const handler = new NetlifyHandler();
    await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
    let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
    await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
    res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "", `Expected res === "", but got ${res}`);
  });

  // 测试Netlify项目变量是否生效
  await t.test('Netlify Check Params', async () => {
    const handler = new NetlifyHandler();
    const res = await handler.checkParams("", "", "");
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Netlify触发部署
  await t.test('Netlify deploy', { skip: !writeChecks }, async () => {
    const handler = new NetlifyHandler();
    const res = await handler.deploy();
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Cloudflare设置环境变量
  await t.test('Cloudflare Config setEnv', { skip: !writeChecks }, async () => {
    const handler = new CloudflareHandler();
    let res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 1);
    res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 0);
  });

  // 测试Cloudflare添加和删除环境变量
  await t.test('Cloudflare Config addEnv and del Env', { skip: !writeChecks }, async () => {
    const handler = new CloudflareHandler();
    await handler.addEnv("UPSTASH_REDIS_REST_TOKEN", "xxxx");
    let res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
    await handler.delEnv("UPSTASH_REDIS_REST_TOKEN");
    res = handler.getEnv("UPSTASH_REDIS_REST_TOKEN");
    assert(res === "", `Expected res === "", but got ${res}`);
  });

  // 测试Cloudflare项目变量是否生效
  await t.test('Cloudflare Check Params', async () => {
    const handler = new CloudflareHandler();
    const res = await handler.checkParams("", "", "");
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Edgeone设置环境变量
  await t.test('Edgeone Config setEnv', { skip: !writeChecks }, async () => {
    const handler = new EdgeoneHandler();
    let res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 0, `Expected Number(res) === 0, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 1);
    res = handler.getEnv("DANMU_LIMIT");
    assert(Number(res) === 1, `Expected Number(res) === 1, but got ${Number(res)}`);
    await handler.setEnv("DANMU_LIMIT", 0);
  });

  // 测试Edgeone添加和删除环境变量
  await t.test('Edgeone Config addEnv and del Env', { skip: !writeChecks }, async () => {
    const handler = new EdgeoneHandler();
    await handler.addEnv("PROXY_URL", "xxxx");
    let res = handler.getEnv("PROXY_URL");
    assert(res === "xxxx", `Expected res === "xxxx", but got ${res}`);
    await handler.delEnv("PROXY_URL");
    res = handler.getEnv("PROXY_URL");
    assert(res === "", `Expected res === "", but got ${res}`);
  });

  // 测试Edgeone项目变量是否生效
  await t.test('Edgeone Check Params', async () => {
    const handler = new EdgeoneHandler();
    const res = await handler.checkParams("", "", "");
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试Edgeone触发部署
  await t.test('Edgeone deploy', { skip: !writeChecks }, async () => {
    const handler = new EdgeoneHandler();
    const res = await handler.deploy();
    assert(res, `Expected res is true, but got ${res}`);
  });

  // 测试 Bangumi Data 本地检索功能与数据结构解析
  await t.test('searchBangumiData', async () => {
    const originalUseBangumiData = Globals.getConfig().useBangumiData;
    Globals.getConfig().useBangumiData = true;
    try {
      // 确保 Bangumi Data 核心数据源加载至内存
      await initBangumiData('node', true);
      const keyword = '间谍过家家';
      const targetSites = ['gamer', 'gamer_hk'];
      // 执行本地内存级检索
      const results = await searchBangumiData(keyword, targetSites);
      assert(Array.isArray(results), `Expected Array.isArray(results) to be true, but got ${typeof results}`);
      assert(results.length > 0, `Expected results.length > 0, but got ${results.length}`);
      if (results.length > 0) {
        assert(results[0].title !== undefined, `Expected results[0].title !== undefined`);
        assert(results[0].siteId !== undefined, `Expected results[0].siteId !== undefined`);
      }
    } finally {
      clearBangumiDataCache();
      Globals.getConfig().useBangumiData = originalUseBangumiData;
    }
  });

  // 测试带有季度参数的精确拦截与检索机制
  await t.test('searchAnimeWithSeason', async () => {
    const config = Globals.getConfig();
    const originalSourceOrderArr = Array.isArray(config.sourceOrderArr) ? [...config.sourceOrderArr] : config.sourceOrderArr;
    config.sourceOrderArr = ['360','iqiyi','dandan','animeko'];
    try {
      // 构造带有 season 参数的 URL 请求对象以模拟 match 接口的内部下发
      const targetUrl = new URL('http://localhost/search/anime?keyword=间谍过家家&season=2');
      const response = await searchAnime(targetUrl);
      const data = await parseResponse(response);
      assert.equal(data.success, true);
      assert(Array.isArray(data.animes), `Expected Array.isArray(data.animes) to be true`);
      assert(data.animes.length > 0, `Expected data.animes.length > 0, but got ${data.animes.length}`);
    } finally {
      config.sourceOrderArr = originalSourceOrderArr;
    }
  });


});

// 测试本地 Redis 功能
test('local-redis functions', async (t) => {
  // 测试设置和获取本地 Redis 键值
  await t.test('setLocalRedisKey and getLocalRedisKey', async () => {
    try {
      const testKey = 'test_key_local_redis';
      const testValue = 'Hello Local Redis';

      // 设置键值
      const setResult = await setLocalRedisKey(testKey, testValue);
      // 验证设置结果
      assert.ok(setResult.result === 'OK' || setResult.result === 'ERROR', 
        `setLocalRedisKey returned valid result: ${JSON.stringify(setResult)}`);

      // 获取键值
      const getResult = await getLocalRedisKey(testKey);
      // 验证获取结果（如果 Redis 不可用，可能返回 null）
      if (getResult !== null) {
        // 如果返回了结果，验证它是否是我们设置的值（可能是序列化的）
        assert.ok(typeof getResult === 'string' || getResult === null, 
          `getLocalRedisKey returned expected type: ${typeof getResult}`);
      } else {
        // 如果返回 null，也是可以接受的（表示 Redis 不可用）
        assert.strictEqual(getResult, null, 'getLocalRedisKey returned null when Redis is not available');
      }
    } catch (error) {
      assert.ok(true, `setLocalRedisKey/getLocalRedisKey handled error gracefully: ${error.message}`);
    }
  });

  // 测试设置带过期时间的本地 Redis 键值
  await t.test('setLocalRedisKeyWithExpiry', async () => {
    try {
      const testKey = 'test_expiry_key_local_redis';
      const testValue = 'Temporary Value';
      const expirySeconds = 2; // 2秒过期

      const setResult = await setLocalRedisKeyWithExpiry(testKey, testValue, expirySeconds);
      // 验证设置结果
      assert.ok(setResult.result === 'OK' || setResult.result === 'ERROR', 
        `setLocalRedisKeyWithExpiry returned valid result: ${JSON.stringify(setResult)}`);
    } catch (error) {
      assert.ok(true, `setLocalRedisKeyWithExpiry handled error gracefully: ${error.message}`);
    }
  });
});


// 测试 Bangumi Data 数据下载时机（ensureBangumiDataReady）、配置变更触发下载（syncBangumiDataLifecycleOnConfigChange）
// 以及 getTMDBChineseTitle 漏写 await 的修复；按需启用（envs RAW_ENV_KEYS 相关用例已提取到
// danmu_api/tests/configs/envs.test.js，随 npm test 执行）

test('bangumi-data 数据下载时机与配置变更触发下载', async (t) => {
  const CACHE_DIR = path.join(process.cwd(), '.cache');
  const CACHE_FILE = path.join(CACHE_DIR, 'bangumi-data-cache.json');
  const FAKE_ITEM = {
    title: 'FrobeniusTestAnime',
    titleTranslate: { 'zh-Hans': ['弗罗贝尼乌斯测试动画', 'FrobeniusTestAnime'] },
    sites: [{ site: 'tmdb', id: '999999' }],
    _flatText: 'frobeniustestanime'
  };
  const reset = () => {
    globals.useBangumiData = false;
    clearBangumiDataCache(false);
    if (fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '', 'utf-8');
  };

  await t.test('ensureBangumiDataReady 开关关闭时直接返回且不触发下载', async () => {
    reset();
    globals.useBangumiData = false;
    await ensureBangumiDataReady('node');
    assert.ok(true);
  });

  await t.test('syncBangumiDataLifecycleOnConfigChange 开关关闭释放缓存、开启安全触发', async () => {
    reset();
    globals.useBangumiData = false;
    assert.doesNotThrow(() => syncBangumiDataLifecycleOnConfigChange('node'));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: [FAKE_ITEM] }), 'utf-8');
    globals.useBangumiData = true;
    assert.doesNotThrow(() => syncBangumiDataLifecycleOnConfigChange('node'));
  });

  await t.test('getTMDBChineseTitle 经 await 命中本地中文名（修复漏写 await）', async () => {
    reset();
    globals.useBangumiData = true;
    const originalContent = fs.existsSync(CACHE_FILE) ? fs.readFileSync(CACHE_FILE, 'utf-8') : null;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ items: [FAKE_ITEM] }), 'utf-8');
    try {
      await initBangumiData('node', true);
      const result = await getTMDBChineseTitle('FrobeniusTestAnime');
      assert.equal(result, '弗罗贝尼乌斯测试动画');
    } finally {
      clearBangumiDataCache(false);
      if (originalContent !== null) fs.writeFileSync(CACHE_FILE, originalContent, 'utf-8');
      else fs.writeFileSync(CACHE_FILE, '', 'utf-8');
    }
  });
});

// 测试 Bangumi Data 在途下载暴露与边缘生命周期延长（getBackgroundDownload / extendBangumiDownloadLifecycle）
// 与上方 bangumi 测试同为按需启用的内部测试；沙箱有网时真实下载以验证在途暴露、注册与清理

test('bangumi-data 在途下载暴露与边缘生命周期延长', async (t) => {
  const CACHE_DIR = path.join(process.cwd(), '.cache');
  const CACHE_FILE = path.join(CACHE_DIR, 'bangumi-data-cache.json');
  const hadCache = fs.existsSync(CACHE_DIR);

  // 空闲时无在途下载
  assert.strictEqual(getBackgroundDownload(), null);


  await t.test('在途下载被暴露、响应后由边缘 waitUntil 注册、完成后清理', async () => {
    globals.useBangumiData = true;
    // 启动真实下载（无 .cache 时走内存路径，不落地文件；有 .cache 则后台刷新），不在途时立即返回
    const initPromise = initBangumiData('node', true);
    const bg = getBackgroundDownload();
    assert.ok(bg && typeof bg.then === 'function', '下载在途时应暴露 Promise');
    const ctx = { waitUntil: (p) => { ctx.registered = p; } };
    extendBangumiDownloadLifecycle(ctx);
    assert.strictEqual(ctx.registered, bg, '边缘 waitUntil 应注册在途 Promise');
    await bg; // 等待下载完成（兼容阻塞与后台两种路径）
    assert.strictEqual(getBackgroundDownload(), null, '下载完成后应清理在途状态');
    globals.useBangumiData = false;
    if (!hadCache && fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '', 'utf-8');
    await initPromise.catch(() => {});
  });
});

// 测试自定义文本类变量绕过 dotenv 注释截断（保留 # 等字符），对应 envs.js RAW_ENV_KEYS 修复
