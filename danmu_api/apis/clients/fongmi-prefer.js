import { globals } from "../../configs/globals.js";
import { log } from "../../utils/log-util.js";
import {
  findAnimeIdByCommentId,
  getLastSearch,
  setLastSearch,
  setPreferByAnimeId,
  writeCacheToFile
} from "../../utils/cache-util.js";
import { setRedisKey } from "../../utils/redis-util.js";
import { setLocalRedisKey } from "../../utils/local-redis-util.js";
import { titleMatches } from "../../utils/common-util.js";

function persistLastSelectMap() {
  if (globals.localCacheValid) {
    writeCacheToFile("lastSelectMap", JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
  }
  if (globals.redisValid) {
    setRedisKey("lastSelectMap", globals.lastSelectMap).catch(e => log("error", "Redis set error", e));
  }
  if (globals.localRedisValid) {
    setLocalRedisKey("lastSelectMap", globals.lastSelectMap);
  }
}

export function rememberFongmiCommentPreference(commentId, animeTitle, clientIp) {
  if (!clientIp) return;

  const lastSearch = getLastSearch(clientIp);
  if (!lastSearch?.title || !titleMatches(animeTitle, lastSearch.title)) return;

  const [animeId, source] = findAnimeIdByCommentId(commentId);
  if (!animeId || !source) return;

  const updatedKey = setPreferByAnimeId(animeId, source, lastSearch.season ?? null, null);
  if (!updatedKey) return;

  log("info", `[Fongmi][Prefer] remembered manual selection: key=${updatedKey}, animeId=${animeId}, source=${source || ""}`);
  persistLastSelectMap();
}

export function rememberFongmiSearchContext(clientIp, title, candidate) {
  if (!clientIp || !title || !candidate) return;

  setLastSearch(clientIp, {
    title,
    season: null,
    episode: null,
    episodeId: candidate?.episode?.episodeId
  });
}
