import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { printFirst200Chars } from "../utils/common-util.js";

// =====================
// 获取第三方弹幕服务器弹幕
// =====================
export default class OtherSource extends BaseSource {
  async search(keyword) {}

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {}

  async getEpisodeDanmu(id) {
    try {
      const response = await httpGet(
        `${globals.otherServer}/?url=${id}&ac=dm`,
        {
          headers: {
              "Content-Type": "application/json",
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        }
      );

      log("info", `danmu response from ${globals.otherServer}: ↓↓↓`);
      printFirst200Chars(response.data);

      return response.data;
    } catch (error) {
      log("error", `请求 ${globals.otherServer} 失败:`, error);
      return [];
    }
  }

  formatComments(comments) {
    return comments;
  }
}