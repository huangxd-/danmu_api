import BaseSource from './base.js';
import { getLocalDanmu, listLocalDanmu } from '../utils/local-danmu-store.js';
import { groupLocalDanmuResources, normalizeLocalSeason } from '../utils/local-danmu-parser.js';
import { addAnime } from '../utils/cache-util.js';
import { titleMatches } from '../utils/common-util.js';
import { convertToAsciiSum } from '../utils/codec-util.js';
import { SegmentListResponse } from '../models/dandan-model.js';

const seasonTitle = resource => `${resource.title} 第${normalizeLocalSeason(resource.season)}季`;

export default class LocalSource extends BaseSource {
  async search(keyword) {
    if (!String(keyword || '').trim()) return [];
    const resources = await listLocalDanmu();
    return resources.filter(resource => resource?.status === 'ready' && resource.resourceKey && titleMatches(seasonTitle(resource), keyword));
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes, detailStore = null, querySeason = null) {
    if (!Array.isArray(sourceAnimes)) return [];
    const animes = [];
    for (const group of groupLocalDanmuResources(sourceAnimes)) {
      if (querySeason !== null && group.season !== querySeason) continue;
      if (!titleMatches(seasonTitle(group), queryTitle, querySeason)) continue;
      const { year, season, episodes } = group;
      const hasEpisodes = episodes.some(resource => resource.episode !== null);
      const type = group.type || (hasEpisodes ? 'tv' : 'movie');
      const typeDescription = { tv: 'TV', movie: '电影', ova: 'OVA', special: '特别篇' }[type] || group.type;
      const links = episodes.map(resource => {
        const episode = resource.episode;
        const name = episode !== null ? `第${episode}集` : (type === 'movie' ? '正片' : '全集');
        return { name, title: `【local】 ${name}`, url: `local:${resource.resourceKey}` };
      });
      const animeId = convertToAsciiSum(`local:${group.groupKey}`);
      const title = type === 'movie' && season === 1 ? group.title : seasonTitle(group);
      const anime = {
        animeId,
        bangumiId: String(animeId),
        animeTitle: `${title}${year ? `(${year})` : ''}【${typeDescription}】from local`,
        type: type === 'tv' ? 'tvseries' : type,
        typeDescription,
        imageUrl: '',
        startDate: year ? `${year}-01-01` : '',
        episodeCount: links.length,
        rating: 0,
        isFavorited: true,
        source: 'local',
      };
      if (addAnime({ ...anime, links }, detailStore)) animes.push(anime);
    }
    this.sortAndPushAnimesByYear(animes, curAnimes);
    return animes;
  }

  async getEpisodeDanmu(id) { const r = await getLocalDanmu(id); return r?.comments || []; }
  formatComments(comments) { return comments; }

  async getComments(id, sourceName = 'local', segmentFlag = false, progressCallback = null) {
    return super.getComments(id, sourceName, segmentFlag, progressCallback);
  }

  async getEpisodeDanmuSegments(id) {
    return new SegmentListResponse({
      type: 'local',
      segmentList: [{ type: 'local', segment_start: 0, segment_end: 30000, url: id }],
    });
  }

  async getEpisodeSegmentDanmu(segment) { return this.getEpisodeDanmu(segment.url); }
}
