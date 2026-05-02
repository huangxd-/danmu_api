import zlib from 'zlib';

// 模拟 iOS JavaScriptBridge 的 Widget 对象 - 模拟 iOS 环境
global.Widget = {
  http: {
    get: async (url, options) => {
      console.log(`[iOS模拟] HTTP GET: ${url}`);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            ...options.headers,
            // 'User-Agent': 'ForwardWidgets/1.0.0'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        let data;

        if (options.base64Data) {
          console.log("base64模式");

          // 先拿二进制
          const arrayBuffer = await response.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          // 转换为 Base64
          let binary = '';
          const chunkSize = 0x8000; // 分块防止大文件卡死
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            let chunk = uint8Array.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, chunk);
          }
          data = btoa(binary); // 得到 base64 字符串

        } else if (options.zlibMode) {
          console.log("zlib模式")

          data = await response.arrayBuffer();

          // 使用 zlib 解压数据
          const buffer = Buffer.from(data);  // 将二进制数据转成 Buffer（Node.js 中使用）

          let decompressedData;
          try {
            decompressedData = zlib.inflateSync(buffer); // 使用同步的 inflate 解压数据
          } catch (e) {
            console.error("[iOS模拟] 解压缩失败", e);
            throw e;
          }

          // 将解压的数据转回字符串
          const decodedData = decompressedData.toString('utf-8');
          data = decodedData;  // 更新解压后的数据
        } else {
          data = await response.text();
        }

        let parsedData;
        try {
          parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
        } catch (e) {
          parsedData = data;  // 如果解析失败，保留原始文本
        }
        if (verbose) {
          console.log(`[iOS模拟] API响应:`, JSON.stringify(parsedData, null, 2));
        }

        // 获取所有 headers，但特别处理 set-cookie
        const headers = {};
        let setCookieValues = [];

        // 遍历 headers 条目
        for (const [key, value] of response.headers.entries()) {
          if (key.toLowerCase() === 'set-cookie') {
            setCookieValues.push(value);
          } else {
            headers[key] = value;
          }
        }

        // 如果存在 set-cookie 头，将其合并为分号分隔的字符串
        if (setCookieValues.length > 0) {
          headers['set-cookie'] = setCookieValues.join(';');
        }
        // 模拟 iOS 环境：返回 { data: ... } 结构
        return {
          data: parsedData,
          status: response.status,
          headers: headers
        };

      } catch (error) {
        console.error(`[iOS模拟] 请求失败:`, error.message);
        throw error;
      }
    },
    post: async (url, body, options = {}) => {
      console.log(`[iOS模拟] HTTP POST: ${url}`);

      // 处理请求头、body 和其他参数
      const { headers = {}, params, allow_redirects = true } = options;
      const fetchOptions = {
        method: 'POST',
        headers: {
          ...headers,
          // 'Content-Type': 'application/json', // 默认使用 JSON 格式
          // 'User-Agent': 'ForwardWidgets/1.0.0'
        },
        body: body
      };

      if (!allow_redirects) {
        fetchOptions.redirect = 'manual';  // 禁止重定向
      }

      try {
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.text();
        let parsedData;
        try {
          parsedData = JSON.parse(data);  // 尝试将文本解析为 JSON
        } catch (e) {
          parsedData = data;  // 如果解析失败，保留原始文本
        }
        if (verbose) {
          console.log(`[iOS模拟] API响应:`, JSON.stringify(parsedData, null, 2));
        }

        // 模拟 iOS 环境：返回 { data: ... } 结构
        return {
          data: parsedData,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries())
        };

      } catch (error) {
        console.error(`[iOS模拟] 请求失败:`, error.message);
        throw error;
      }
    }
  },
  // 新增 storage 模拟
  storage: {
    _store: {},  // 内部存储对象

    get: (key) => {
      console.log(`[iOS模拟] storage.get: ${key}`);
      return Widget.storage._store[key] ?? null;
    },

    set: (key, value) => {
      console.log(`[iOS模拟] storage.set: ${key} = ${JSON.stringify(value)}`);
      Widget.storage._store[key] = value;
    },

    remove: (key) => {
      console.log(`[iOS模拟] storage.remove: ${key}`);
      delete Widget.storage._store[key];
    },

    clear: () => {
      console.log(`[iOS模拟] storage.clear`);
      Widget.storage._store = {};
    },
  },
};

// 模拟 WidgetMetadata
global.WidgetMetadata = {
  id: "forward.danmu",
  title: "弹幕",
  version: "1.0.0",
  description: "获取弹幕数据"
};

// 配置变量
const verbose = false; // 设置为 true 时打印详细结果

// 加载 forward-widget.js 模块
async function runTest() {
  try {
    const module = await import('./forward-widget.js');
    // const module = await import('../dist/logvar-danmu.js');
    // 将模块导出的函数添加到全局作用域，以便测试函数可以访问它们
    global.searchDanmu = module.searchDanmu;
    global.getDetailById = module.getDetailById;
    global.getCommentsById = module.getCommentsById;
    global.getDanmuWithSegmentTime = module.getDanmuWithSegmentTime;

    // 运行测试
    await testNewFlow();
  } catch (error) {
    console.error('Failed to load module:', error);
  }
}

async function testNewFlow() {
  console.log('=== 测试新的弹幕获取链路 ===\n');
  console.log(`[配置] 详细输出: ${verbose ? '开启' : '关闭'}\n`);

  try {
    const commonParams = {
      type: 'tv',
      tmdbId: '242762',
      season: 1,
      episode: 21,
      airDate: '2025-07-18',
      episodeName: '第2期上：首次大约会！温柔医生为爱冲锋',
      sourceOrder: 'douban',
      otherServer: 'https://api.danmu.icu',
      customSourceApiUrl: '',
      vodServers: '金蝉@https://zy.jinchancaiji.com,789@https://www.caiji.cyou,听风@https://gctf.tfdh.top',
      vodReturnMode: 'fastest',
      vodRequestTimeout: 10000,
      bilibiliCookie: '',
      doubanCookie: '',
      platformOrder: [],
      episodeTitleFilter: '',
      enableAnimeEpisodeFilter: 'false',
      strictTitleMatch: 'false',
      animeTitleFilter: '',
      animeTitleSimplified: 'false',
      blockedWords: '',
      groupMinute: 1,
      danmuLimit: 0,
      danmuSimplifiedTraditional: 'false',
      danmuOffset: '',
      convertTopBottomToScroll: 'false',
      convertColor: 'default',
      colorPool: '16777215,16744319,16752762,16774799,9498256,8388564,8900346,14204888,16758465',
      likeSwitch: 'true',
      proxyUrl: '',
      tmdbApiKey: '',
    };

    // 测试自动获取分片弹幕
    console.log('🔍 测试自动获取分片弹幕');
    const searchRes = await searchDanmu({
      // title: "https://m.v.qq.com/x/m/play?cid=53q0eh78q97e4d1&vid=x00174aq5no&ptag=hippySearch&pageType=long",
      // title: "https://v.qq.com/x/cover/53q0eh78q97e4d1/x00174aq5no.html",
      // title: "https://v.qq.com/x/cover/mzc002009y0nzq8/f4101bay23t.html",
      // title: "https://m.iqiyi.com/v_1ftv9n1m3bg.html",
      // title: "https://www.iqiyi.com/v_1ftv9n1m3bg.html",
      // title: "https://m.youku.com/alipay_video/id_cbff0b0703e54d659628.html?spm=a2hww.12518357.drawer4.2",
      // title: "https://v.youku.com/v_show/id_XNjQ3ODMyNjU3Mg==.html",
      // title: "https://m.mgtv.com/b/771610/23300622.html?fpa=0&fpos=0",
      // title: "https://www.mgtv.com/b/771610/23300622.html",
      // title: "https://m.bilibili.com/bangumi/play/ep1231564",
      // title: "https://www.bilibili.com/bangumi/play/ep1231564",
      // title: "https://www.bilibili.com/video/av170001?p=2",
      // title: "https://www.bilibili.com/video/BV17x411w7KC?p=3",
      title: '寻秦记',
      ...commonParams,
    });
    if (verbose) {
      console.log('✅ 搜索结果:', JSON.stringify(searchRes, null, 2));
    } else {
      console.log(`✅ 搜索结果: 找到 ${searchRes.animes ? searchRes.animes.length : 0} 个动漫`);
    }

    if (searchRes.animes && searchRes.animes.length > 0) {
      const anime = searchRes.animes[0];
      console.log(`📺 找到动漫: ${anime.animeTitle} (ID: ${anime.animeId})`);

      // 获取弹幕评论
      console.log('💬 获取弹幕评论...');
      const bangumi = await getDetailById({
        animeId: anime.animeId,
        ...commonParams,
      });
      const commentId = bangumi[0].episodeId;
      const sgementList = await getCommentsById({
        commentId: commentId,
        ...commonParams,
      });
      if (verbose) {
        console.log('✅ 弹幕分片:', JSON.stringify(sgementList, null, 2));
      } else {
        console.log(`✅ 弹幕分片: 获取到 ${sgementList ? sgementList.length : 0} 个分片`);
      }

      if (sgementList.length > 0) {
        const comments = await getDanmuWithSegmentTime({
          segmentTime: 450,
          ...commonParams,
        });
        if (verbose) {
          console.log('✅ 弹幕评论:', JSON.stringify(comments, null, 2));
        } else {
          console.log(`✅ 弹幕评论: 获取到 ${comments && comments.comments ? comments.comments.length : 0} 条弹幕`);
        }
      }
    }
    console.log('\n' + '='.repeat(50) + '\n');

    console.log('\n=== 所有测试完成 ===');

  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

// 启动测试
runTest();
