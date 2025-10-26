import BaseSource from './base.js';
import { log } from "../utils/log-util.js";
import { httpGet} from "../utils/http-util.js";
import { printFirst200Chars } from "../utils/common-util.js";
import { time_to_second } from "../utils/time-util.js";
import { rgbToInt } from "../utils/danmu-util.js";

// =====================
// 获取芒果TV弹幕
// =====================
export default class MangoSource extends BaseSource {
  // 处理 v2_color 对象的转换逻辑
  transformV2Color(v2_color) {
    // 默认颜色值
    const DEFAULT_COLOR_INT = -1;

    // 如果 v2_color 不存在，返回默认值
    if (!v2_color) {
      return DEFAULT_COLOR_INT;
    }
    // 计算左右颜色的整数值
    const leftColor = rgbToInt(v2_color.color_left);
    const rightColor = rgbToInt(v2_color.color_right);
    // 如果左右颜色均为 -1，返回默认值
    if (leftColor === -1 && rightColor === -1) {
      return DEFAULT_COLOR_INT;
    }
    // 如果左颜色无效，返回右颜色
    if (leftColor === -1) {
      return rightColor;
    }
    // 如果右颜色无效，返回左颜色
    if (rightColor === -1) {
      return leftColor;
    }
    // 返回左右颜色的平均值
    return Math.floor((leftColor + rightColor) / 2);
  }

  async search(keyword) {}

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {}

  async getEpisodeDanmu(id) {
    log("info", "开始从本地请求芒果TV弹幕...", id);

    // 弹幕和视频信息 API 基础地址
    const api_video_info = "https://pcweb.api.mgtv.com/video/info";
    const api_ctl_barrage = "https://galaxy.bz.mgtv.com/getctlbarrage";

    // 解析 URL 获取 cid 和 vid
    // 手动解析 URL（没有 URL 对象的情况下）
    const regex = /^(https?:\/\/[^\/]+)(\/[^?#]*)/;
    const match = id.match(regex);

    let path;
    if (match) {
      path = match[2].split('/').filter(Boolean);  // 分割路径并去掉空字符串
      log("info", path);
    } else {
      log("error", 'Invalid URL');
      return [];
    }
    const cid = path[path.length - 2];
    const vid = path[path.length - 1].split(".")[0];

    log("info", `cid: ${cid}, vid: ${vid}`);

    // 获取页面标题和视频时长
    let res;
    try {
      const videoInfoUrl = `${api_video_info}?cid=${cid}&vid=${vid}`;
      res = await httpGet(videoInfoUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
    } catch (error) {
      log("error", "请求视频信息失败:", error);
      return [];
    }

    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    const title = data.data.info.videoName;
    const time = data.data.info.time;
    log("info", `标题: ${title}`);

    // 计算弹幕分段请求
    const promises = [];
    try {
      const ctlBarrageUrl = `${api_ctl_barrage}?version=8.1.39&abroad=0&uuid=&os=10.15.7&platform=0&mac=&vid=${vid}&pid=&cid=${cid}&ticket=`;
      const res = await httpGet(ctlBarrageUrl, {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      const ctlBarrage = typeof res.data === "string" ? JSON.parse(res.data) : res.data;

      // 每1分钟一个分段
      for (let i = 0; i < Math.ceil(time_to_second(time) / 60); i += 1) {
        const danmakuUrl = `https://${ctlBarrage.data?.cdn_list.split(',')[0]}/${ctlBarrage.data?.cdn_version}/${i}.json`;
        promises.push(
          httpGet(danmakuUrl, {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            },
          })
        );
      }
    } catch (error) {
      log("error", "请求弹幕分片失败:", error);
      return [];
    }

    log("info", `弹幕分段数量: ${promises.length}`);

    // 解析弹幕数据
    let contents = [];
    try {
      const results = await Promise.allSettled(promises);
      const datas = results
        .filter(result => result.status === "fulfilled")
        .map(result => result.value.data);

      datas.forEach(data => {
        const dataJson = typeof data === "string" ? JSON.parse(data) : data;
        if (dataJson.data?.items) {
          contents.push(...dataJson.data.items);
        }
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
      if (item?.v2_color) {
        content.color = this.transformV2Color(item?.v2_color);
      }
      if (item?.v2_position) {
        if (item?.v2_position === 1) {
          content.ct = 5;
        } else if (item?.v2_position === 2) {
          content.ct = 4;
        }
      }
      content.timepoint = item.time / 1000;
      content.content = item.content;
      content.uid = item.uid;
      return content;
    });
  }
}