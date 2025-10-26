import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet, httpPost } from "../utils/http-util.js";
import { printFirst200Chars } from "../utils/common-util.js";
import { md5 } from "../utils/codec-util.js";

// =====================
// 获取优酷弹幕
// =====================
export default class YoukuSource extends BaseSource {
  convertYoukuUrl(url) {
    // 使用正则表达式提取 vid 参数
    const vidMatch = url.match(/vid=([^&]+)/);
    if (!vidMatch || !vidMatch[1]) {
      return null; // 如果没有找到 vid 参数，返回 null
    }

    const vid = vidMatch[1];
    // 构造新的 URL
    return `https://v.youku.com/v_show/id_${vid}.html`;
  }

  async search(keyword) {}

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {}

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求优酷弹幕...", id);

    if (!id) {
      return [];
    }

    // 处理302场景
    // https://v.youku.com/video?vid=XNjQ4MTIwOTE2NA==&tpa=dW5pb25faWQ9MTAyMjEzXzEwMDAwNl8wMV8wMQ需要转成https://v.youku.com/v_show/id_XNjQ4MTIwOTE2NA==.html
    if (id.includes("youku.com/video?vid")) {
        id = this.convertYoukuUrl(id);
    }

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://openapi.youku.com/v2/videos/show.json";
    const api_danmaku = "https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/";

    // 手动解析 URL（没有 URL 对象的情况下）
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
      path.unshift("");
      log("info", path);
    } else {
      log("error", 'Invalid URL');
      return [];
    }
    const video_id = path[path.length - 1].split(".")[0].slice(3);

    log("info", `video_id: ${video_id}`);

    // 获取页面标题和视频时长
    let res;
    try {
      const videoInfoUrl = `${api_video_info}?client_id=53e6cc67237fc59a&video_id=${video_id}&package=com.huawei.hwvplayer.youku&ext=show`;
      res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });
    } catch (error) {
      log("error", "请求视频信息失败:", error);
      return [];
    }

    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const title = data.title;
    const duration = data.duration;
    log("info", `标题: ${title}, 时长: ${duration}`);

    // 获取 cna 和 tk_enc
    let cna, _m_h5_tk_enc, _m_h5_tk;
    try {
      const cnaUrl = "https://log.mmstat.com/eg.js";
      const tkEncUrl = "https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=24679788";
      const cnaRes = await httpGet(cnaUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });
      log("info", `cnaRes: ${JSON.stringify(cnaRes)}`);
      log("info", `cnaRes.headers: ${JSON.stringify(cnaRes.headers)}`);
      const etag = cnaRes.headers["etag"] || cnaRes.headers["Etag"];
      log("info", `etag: ${etag}`);
      // const match = cnaRes.headers["set-cookie"].match(/cna=([^;]+)/);
      // cna = match ? match[1] : null;
      cna = etag.replace(/^"|"$/g, '');
      log("info", `cna: ${cna}`);

      let tkEncRes;
      while (!tkEncRes) {
        tkEncRes = await httpGet(tkEncUrl, {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
          },
          allow_redirects: false
        });
      }
      log("info", `tkEncRes: ${JSON.stringify(tkEncRes)}`);
      log("info", `tkEncRes.headers: ${JSON.stringify(tkEncRes.headers)}`);
      const tkEncSetCookie = tkEncRes.headers["set-cookie"] || tkEncRes.headers["Set-Cookie"];
      log("info", `tkEncSetCookie: ${tkEncSetCookie}`);

      // 获取 _m_h5_tk_enc
      const tkEncMatch = tkEncSetCookie.match(/_m_h5_tk_enc=([^;]+)/);
      _m_h5_tk_enc = tkEncMatch ? tkEncMatch[1] : null;

      // 获取 _m_h5_tkh
      const tkH5Match = tkEncSetCookie.match(/_m_h5_tk=([^;]+)/);
      _m_h5_tk = tkH5Match ? tkH5Match[1] : null;

      log("info", `_m_h5_tk_enc: ${_m_h5_tk_enc}`);
      log("info", `_m_h5_tk: ${_m_h5_tk}`);
    } catch (error) {
      log("error", "获取 cna 或 tk_enc 失败:", error);
      return [];
    }

    // 计算弹幕分段请求
    const step = 60; // 每60秒一个分段
    const max_mat = Math.floor(duration / step) + 1;
    let contents = [];

    // 将构造请求和解析逻辑封装为函数，返回该分段的弹幕数组
    const requestOneMat = async (mat) => {
      const msg = {
        ctime: Date.now(),
        ctype: 10004,
        cver: "v1.0",
        guid: cna,
        mat: mat,
        mcount: 1,
        pid: 0,
        sver: "3.1.0",
        type: 1,
        vid: video_id,
      };

      const str = JSON.stringify(msg);

      function utf8ToLatin1(str) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
          const charCode = str.charCodeAt(i);
          if (charCode > 255) {
            result += encodeURIComponent(str[i]);
          } else {
            result += str[i];
          }
        }
        return result;
      }

      function base64Encode(input) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let output = '';
        let buffer = 0;
        let bufferLength = 0;
        for (let i = 0; i < input.length; i++) {
          buffer = (buffer << 8) | input.charCodeAt(i);
          bufferLength += 8;
          while (bufferLength >= 6) {
            output += chars[(buffer >> (bufferLength - 6)) & 0x3F];
            bufferLength -= 6;
          }
        }
        if (bufferLength > 0) {
          output += chars[(buffer << (6 - bufferLength)) & 0x3F];
        }
        while (output.length % 4 !== 0) {
          output += '=';
        }
        return output;
      }

      const msg_b64encode = base64Encode(utf8ToLatin1(str));
      msg.msg = msg_b64encode;
      msg.sign = md5(`${msg_b64encode}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toString().toLowerCase();

      const data = JSON.stringify(msg);
      const t = Date.now();
      const params = {
        jsv: "2.5.6",
        appKey: "24679788",
        t: t,
        sign: md5([_m_h5_tk.slice(0, 32), t, "24679788", data].join("&")).toString().toLowerCase(),
        api: "mopen.youku.danmu.list",
        v: "1.0",
        type: "originaljson",
        dataType: "jsonp",
        timeout: "20000",
        jsonpIncPrefix: "utility",
      };

      const queryString = buildQueryString(params);
      const url = `${api_danmaku}?${queryString}`;
      log("info", `piece_url: ${url}`);

      const response = await httpPost(url, buildQueryString({ data: data }), {
        headers: {
          "Cookie": `_m_h5_tk=${_m_h5_tk};_m_h5_tk_enc=${_m_h5_tk_enc};`,
          "Referer": "https://v.youku.com",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
        },
        allow_redirects: false
      });

      const results = [];
      if (response.data?.data && response.data.data.result) {
        const result = JSON.parse(response.data.data.result);
        if (result.code !== "-1") {
          results.push(...result.data.result);
        }
      }
      return results;
    };

    // 并发限制（可通过环境变量 YOUKU_CONCURRENCY 配置，默认 8）
    const concurrency = globals.youkuConcurrency;
    const mats = Array.from({ length: max_mat }, (_, i) => i);
    for (let i = 0; i < mats.length; i += concurrency) {
      const batch = mats.slice(i, i + concurrency).map((m) => requestOneMat(m));
      try {
        const settled = await Promise.allSettled(batch);
        for (const s of settled) {
          if (s.status === "fulfilled" && Array.isArray(s.value)) {
            contents = contents.concat(s.value);
          }
        }
      } catch (e) {
        log("error", "优酷分段批量请求失败:", e.message);
      }
    }

    printFirst200Chars(contents);

    return contents;
  }

  formatComments(comments) {
    return comments.map(item => {
      const content = {
        timepoint: 0,
        ct: 1,
        size: 25,
        color: 16777215,
        unixtime: Math.floor(Date.now() / 1000),
        uid: 0,
        content: "",
      };
      content.timepoint = item.playat / 1000;
      const prop = JSON.parse(item.propertis)
      if (prop?.color) {
        content.color = prop.color;
      }
      if (prop?.pos) {
        const pos = prop.pos;
        if (pos === 1) content.ct = 5;
        else if (pos === 2) content.ct = 4;
      }
      content.content = item.content;
      return content;
    });
  }
}