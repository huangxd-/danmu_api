// 收藏相关测试夹具
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

import dotenv from 'dotenv';
dotenv.config();

import { Globals } from '../../configs/globals.js';

export function resetFavoriteState(env = {}) {
  Globals.init(env);
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.favoriteCache = new Map();
  Globals.requestHistory = new Map();
  Globals.localCacheValid = false;
  Globals.localCacheInitialized = false;
  Globals.queryCacheInitialized = false;
  Globals.queryCacheWritable = {}; Globals.favoriteCacheWritable = {};
}

export function createFavoriteAnime(title = '收藏测试', episodeCount = 2, id = 910001) {
  return {
    animeId: id,
    bangumiId: String(id),
    animeTitle: title,
    type: 'tvseries',
    typeDescription: 'TV',
    imageUrl: 'https://example.com/favorite.jpg',
    startDate: '2026-01-01T00:00:00.000Z',
    episodeCount,
    rating: 0,
    isFavorited: true,
    source: 'tencent',
    links: Array.from({ length: episodeCount }, (_, index) => ({
      id: id * 10 + index + 1,
      url: `https://v.qq.com/x/cover/favorite/ep${index + 1}.html`,
      title: `【qq】 第${index + 1}集`
    }))
  };
}

export function favoriteSearchResult(anime) {
  const { links, ...result } = anime;
  return result;
}

