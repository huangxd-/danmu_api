import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { httpGet } from "../utils/http-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";

// =====================
// 获取360看源播放链接
// =====================
export default class Kan360Source extends BaseSource {
  // 查询360kan综艺详情
  async get360Zongyi(title, entId, site, year) {
    try {
      let links = [];
      for (let j = 0; j <= 10; j++) {
        const response = await httpGet(
            `https://api.so.360kan.com/episodeszongyi?entid=${entId}&site=${site}&y=${year}&count=20&offset=${j * 20}`,
            {
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              },
            }
        );

        const data = await response.data;
        log("info", `360kan zongyi response: ${JSON.stringify(data)}`);

        const episodeList = data.data.list;
        if (!episodeList) {
          break;
        }
        for (const episodeInfo of episodeList) {
          // Extract episode number from episodeInfo.name (e.g., "第10期下：地球团熟人局大胆开麦，做晚宴超催泪" -> "10")
          const epNumMatch = episodeInfo.name.match(/第(\d+)期([上中下])?/) || episodeInfo.period.match(/第(\d+)期([上中下])?/);
          let epNum = epNumMatch ? epNumMatch[1] : null;
          if (epNum && epNumMatch[2]) {
            epNum = epNumMatch[2] === "上" ? `${epNum}.1` :
                    epNumMatch[2] === "中" ? `${epNum}.2` : `${epNum}.3`;
          }

          links.push({
              "name": episodeInfo.id,
              "url": episodeInfo.url,
              "title": `【${site}】 ${episodeInfo.name} ${episodeInfo.period}`,
              "sort": epNum || episodeInfo.sort || null
          });
        }

        log("info", `links.length: ${links.length}`);
      }
      // Sort links by pubdate numerically
      links.sort((a, b) => {
        if (!a.sort || !b.sort) return 0;
        const aNum = parseFloat(a.sort);
        const bNum = parseFloat(b.sort);
        return aNum - bNum;
      });

      return links;
    } catch (error) {
      log("error", "get360Animes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async search(keyword) {
    try {
      const response = await httpGet(
        `https://api.so.360kan.com/index?force_v=1&kw=${encodeURIComponent(keyword)}&from=&pageno=1&v_ap=1&tab=all`,
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        }
      );

      const data = response.data;
      log("info", `360kan response: ${JSON.stringify(data)}`);

      let tmpAnimes = [];
      if ('rows' in data.data.longData) {
        tmpAnimes = data.data.longData.rows;
      }

      log("info", `360kan animes.length: ${tmpAnimes.length}`);

      return tmpAnimes;
    } catch (error) {
      log("error", "get360Animes error:", {
        message: error.message,
        name: error.name,
        stack: error.stack,
      });
      return [];
    }
  }

  async getEpisodes(id) {}

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    // 添加错误处理，确保sourceAnimes是数组
    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("error", "[360kan] sourceAnimes is not a valid array");
      return [];
    }

    const process360Animes = await Promise.all(sourceAnimes
      .filter(anime => titleMatches(anime.titleTxt, queryTitle))
      .map(async (anime) => {
        try {
          let links = [];
          if (anime.cat_name === "电影") {
            for (const key of Object.keys(anime.playlinks)) {
              if (globals.vodAllowedPlatforms.includes(key)) {
                links.push({
                  "name": key.toString(),
                  "url": anime.playlinks[key],
                  "title": `【${key}】 ${anime.titleTxt}(${anime.year})`
                });
              }
            }
          } else if (anime.cat_name === "电视剧" || anime.cat_name === "动漫") {
            if (globals.vodAllowedPlatforms.includes(anime.seriesSite)) {
              for (let i = 0; i < anime.seriesPlaylinks.length; i++) {
                const item = anime.seriesPlaylinks[i];
                links.push({
                  "name": (i + 1).toString(),
                  "url": item.url,
                  "title": `【${anime.seriesSite}】 第${i + 1}集`
                });
              }
            }
          } else if (anime.cat_name === "综艺") {
            const zongyiLinks = await Promise.all(
                Object.keys(anime.playlinks_year).map(async (site) => {
                  if (globals.vodAllowedPlatforms.includes(site)) {
                    const yearLinks = await Promise.all(
                        anime.playlinks_year[site].map(async (year) => {
                          return await this.get360Zongyi(anime.titleTxt, anime.id, site, year);
                        })
                    );
                    return yearLinks.flat(); // 将每个年份的子链接合并到一个数组
                  }
                  return [];
                })
            );
            links = zongyiLinks.flat(); // 扁平化所有返回的子链接
          }

          if (links.length > 0) {
            let transformedAnime = {
              animeId: Number(anime.id),
              bangumiId: String(anime.id),
              animeTitle: `${anime.titleTxt}(${anime.year})【${anime.cat_name}】from 360`,
              type: anime.cat_name,
              typeDescription: anime.cat_name,
              imageUrl: anime.cover,
              startDate: generateValidStartDate(anime.year),
              episodeCount: links.length,
              rating: 0,
              isFavorited: true,
              source: "360",
            };

            tmpAnimes.push(transformedAnime);
            addAnime({...transformedAnime, links: links});
            if (globals.animes.length > globals.MAX_ANIMES) removeEarliestAnime();
          }
        } catch (error) {
          log("error", `[360kan] Error processing anime: ${error.message}`);
        }
      }));

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return process360Animes;
  }

  async getEpisodeDanmu(id) {}

  formatComments(comments) {}
}