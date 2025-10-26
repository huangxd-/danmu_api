import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { buildQueryString, httpGet} from "../utils/http-util.js";
import { printFirst200Chars } from "../utils/common-util.js";

// =====================
// 获取爱奇艺弹幕
// =====================
export default class IqiyiSource extends BaseSource {
  async search(keyword) {}

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {}

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求爱奇艺弹幕...", id);

    // 弹幕 API 基础地址
    const api_decode_base = "https://pcw-api.iq.com/api/decode/";
    const api_video_info = "https://pcw-api.iqiyi.com/video/video/baseinfo/";
    const api_danmaku_base = "https://cmts.iqiyi.com/bullet/";

    // 解析 URL 获取 tvid
    let tvid;
    try {
      const idMatch = id.match(/v_(\w+)/);
      if (!idMatch) {
        log("error", "无法从 URL 中提取 tvid");
        return [];
      }
      tvid = idMatch[1];
      log("info", `tvid: ${tvid}`);

      // 获取 tvid 的解码信息
      const decodeUrl = `${api_decode_base}${tvid}?platformId=3&modeCode=intl&langCode=sg`;
      let res = await httpGet(decodeUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      tvid = data.data.toString();
      log("info", `解码后 tvid: ${tvid}`);
    } catch (error) {
      log("error", "请求解码信息失败:", error);
      return [];
    }

    // 获取视频基础信息
    let title, duration, albumid, categoryid;
    try {
      const videoInfoUrl = `${api_video_info}${tvid}`;
      const res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
      const videoInfo = data.data;
      title = videoInfo.name || videoInfo.tvName || "未知标题";
      duration = videoInfo.durationSec;
      albumid = videoInfo.albumId;
      categoryid = videoInfo.channelId || videoInfo.categoryId;
      log("info", `标题: ${title}, 时长: ${duration}`);
    } catch (error) {
      log("error", "请求视频基础信息失败:", error);
      return [];
    }

    // 计算弹幕分段数量（每5分钟一个分段）
    const page = Math.ceil(duration / (60 * 5));
    log("info", `弹幕分段数量: ${page}`);

    // 构建弹幕请求
    const promises = [];
    for (let i = 0; i < page; i++) {
      const params = {
          rn: "0.0123456789123456",
          business: "danmu",
          is_iqiyi: "true",
          is_video_page: "true",
          tvid: tvid,
          albumid: albumid,
          categoryid: categoryid,
          qypid: "01010021010000000000",
      };
      let queryParams = buildQueryString(params);
      const api_url = `${api_danmaku_base}${tvid.slice(-4, -2)}/${tvid.slice(-2)}/${tvid}_300_${i + 1}.z?${queryParams.toString()}`;
      promises.push(
          httpGet(api_url, {
            headers: {
              "Accpet-Encoding": "gzip",
              "Content-Type": "application/xml",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
            zlibMode: true
          })
      );
    }

    // 提取 XML 标签内容的辅助函数
    function extract(xml, tag) {
        const reg = new RegExp(`<${tag}>(.*?)</${tag}>`, "g");
        const res = xml.match(reg)?.map((x) => x.substring(tag.length + 2, x.length - tag.length - 3));
        return res || [];
    }

    // 解析弹幕数据
    let contents = [];
    try {
      const results = await Promise.allSettled(promises);
      const datas = results
          .filter((result) => result.status === "fulfilled")
          .map((result) => result.value);

      datas.forEach(data => {
        const xml = data.data;
        const danmaku = extract(xml, "content");
        const showTime = extract(xml, "showTime");
        const color = extract(xml, "color");

        contents.push(...danmaku.map((content, i) => ({
          content,
          showTime: showTime[i],
          color: color[i],
        })));
      });
    } catch (error) {
        log("error", "解析弹幕数据失败:", error);
        return [];
    }

    printFirst200Chars(contents);

    return contents;
  }

  formatComments(comments) {
    return comments.map(item => {
      const content = {
          timepoint: 0,	// 弹幕发送时间（秒）
          ct: 1,	// 弹幕类型，1-3 为滚动弹幕、4 为底部、5 为顶端、6 为逆向、7 为精确、8 为高级
          size: 25,	//字体大小，25 为中，18 为小
          color: 16777215,	//弹幕颜色，RGB 颜色转为十进制后的值，16777215 为白色
          unixtime: Math.floor(Date.now() / 1000),	//Unix 时间戳格式
          uid: 0,		//发送人的 id
          content: "",
      };
      content.timepoint = parseFloat(item["showTime"]);
      content.color = parseInt(item["color"], 16);
      content.content = item["content"];
      content.size = 25;
      return content;
    });
  }
}