import { validateType } from "../utils/common-util.js";

// =====================
// 数据模型：Anime
// =====================
export class Anime {
  constructor(rawJson = {}) {
    const {
      animeId = 111, bangumiId = "", animeTitle = "", type = "",
      typeDescription = "", imageUrl = "", startDate = "", episodeCount = 1,
      rating = 0, isFavorited = true, source = "", links = [],
      mergedChildren = [], isHiddenChild = false
    } = nullToUndefined(rawJson);
    // ---- 类型检查 ----
    validateType(animeId, "number", "animeId");
    validateType(bangumiId, "string", "bangumiId");
    validateType(animeTitle, "string", "animeTitle");
    validateType(type, "string", "type");
    validateType(typeDescription, "string", "typeDescription");
    validateType(imageUrl, "string", "imageUrl");
    validateType(startDate, "string", "startDate");
    validateType(episodeCount, "number", "episodeCount");
    validateType(rating, "number", "rating");
    validateType(isFavorited, "boolean", "isFavorited");
    validateType(source, "string", "source");
    validateType(links, "array", "links");
    validateType(mergedChildren, "array", "mergedChildren");
    validateType(isHiddenChild, "boolean", "isHiddenChild");

    // 将 links 转换为 Link 实例数组
    this.links = links.map(linkData => Link.fromJson(linkData));

    // 直接解构并赋值给 this
    Object.assign(this, { animeId, bangumiId, animeTitle, type, typeDescription, imageUrl, startDate,
      episodeCount, rating, isFavorited, source, mergedChildren, isHiddenChild  });
  }

  // ---- 静态方法：从 JSON 创建 Anime 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }

    const links = (json.links || []).map(link => Link.fromJson(link));
    return new Anime({ ...json, links });
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return {
      ...this,  // 将 this 中的其他属性直接展开
      links: this.links.map(link => link.toJson())  // 转换每个 link 为 JSON
    };
  }
}

// 定义 Link 模型
class Link {
  constructor(rawJson = {}) {
    const {
      name = "", url = "", title = "", id = 10001
    } = nullToUndefined(rawJson);
    validateType(name, "string", "name");
    validateType(url, "string", "url");
    validateType(title, "string", "title");
    validateType(id, "number", "id");

    // 直接解构并赋值给 this
    Object.assign(this, { name, url, title, id });
  }

  // ---- 静态方法：从 JSON 创建 Link 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new Link(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return { ...this };
  }
}

// =====================
// 数据模型：AnimeMatch
// =====================
export class AnimeMatch {
  constructor(rawJson = {}) {
    const {
      episodeId = 10001, animeId = 111, animeTitle = "", episodeTitle = "",
      type = "", typeDescription = "", shift = 1, imageUrl = "", url = ""
    } = nullToUndefined(rawJson);
    // ---- 类型检查 ----
    validateType(episodeId, "number", "episodeId");
    validateType(animeId, "number", "animeId");
    validateType(animeTitle, "string", "animeTitle");
    validateType(episodeTitle, "string", "episodeTitle");
    validateType(type, "string", "type");
    validateType(typeDescription, "string", "typeDescription");
    validateType(shift, "number", "shift");
    validateType(imageUrl, "string", "imageUrl");
    validateType(url, "string", "url");

    // 直接解构并赋值给 this
    Object.assign(this, { episodeId, animeId, animeTitle, episodeTitle, type, typeDescription, shift, imageUrl, url });
  }

  // ---- 静态方法：从 JSON 创建 User 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new AnimeMatch(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return { ...this };
  }
}

// =====================
// 数据模型：Episode
// =====================
export class Episode {
  constructor(rawJson = {}) {
    const {
      episodeId = "", episodeTitle = "", url = ""
    } = nullToUndefined(rawJson);
    this.episodeId = episodeId;
    this.episodeTitle = episodeTitle;
    this.url = url;
  }
}

// Episode 的 toJson 方法
Episode.prototype.toJson = function () {
  return {
    episodeId: this.episodeId,
    episodeTitle: this.episodeTitle,
    url: this.url
  };
};

// =====================
// 数据模型：Episodes
// =====================
export class Episodes {
  constructor(rawJson = {}) {
    const {
      animeId = 111, animeTitle = "", type = "", typeDescription = "",
      episodes = []
    } = nullToUndefined(rawJson);
    // ---- 类型检查 ----
    validateType(animeId, "number", "animeId");
    validateType(animeTitle, "string", "animeTitle");
    validateType(type, "string", "type");
    validateType(typeDescription, "string", "typeDescription");
    validateType(episodes, "array", "episodes");

    // 直接解构并赋值给 this
    Object.assign(this, { animeId, animeTitle, type, typeDescription,
      episodes: episodes.map(ep => new Episode(ep)) });
  }

  // ---- 静态方法：从 JSON 创建 Episodes 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new Episodes(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return {
      ...this,
      episodes: this.episodes.map(ep => ep.toJson())
    };
  }
}

// =====================
// 数据模型：Season
// =====================
export class Season {
  constructor(rawJson = {}) {
    const {
      id = "", airDate = "", name = "", episodeCount = 0
    } = nullToUndefined(rawJson);
    validateType(id, "string", "id");
    validateType(airDate, "string", "airDate");
    validateType(name, "string", "name");
    validateType(episodeCount, "number", "episodeCount");

    // 直接解构并赋值给 this
    Object.assign(this, { id, airDate, name, episodeCount });
  }

  // ---- 静态方法：从 JSON 创建 Season 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new Season(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return { ...this };
  }
}

// =====================
// 数据模型：BangumiEpisode
// =====================
export class BangumiEpisode {
  constructor(rawJson = {}) {
    const {
      seasonId = "", episodeId = 10001, episodeTitle = "", episodeNumber = "",
      airDate = "", url = ""
    } = nullToUndefined(rawJson);
    validateType(seasonId, "string", "seasonId");
    validateType(episodeId, "number", "episodeId");
    validateType(episodeTitle, "string", "episodeTitle");
    validateType(episodeNumber, "string", "episodeNumber");
    validateType(airDate, "string", "airDate");
    validateType(url, "string", "url");

    // 直接解构并赋值给 this
    Object.assign(this, { seasonId, episodeId, episodeTitle, episodeNumber, airDate, url });
  }

  // ---- 静态方法：从 JSON 创建 BangumiEpisode 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new BangumiEpisode(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return { ...this };
  }
}

// =====================
// 数据模型：Bangumi
// =====================
export class Bangumi {
  constructor(rawJson = {}) {
    const {
      animeId = 111, bangumiId = "", animeTitle = "", imageUrl = "",
      isOnAir = true, airDay = 1, isFavorited = true, rating = 0,
      type = "", typeDescription = "", seasons = [], episodes = []
    } = nullToUndefined(rawJson);
    validateType(animeId, "number", "animeId");
    validateType(bangumiId, "string", "bangumiId");
    validateType(animeTitle, "string", "animeTitle");
    validateType(imageUrl, "string", "imageUrl");
    validateType(isOnAir, "boolean", "isOnAir");
    validateType(airDay, "number", "airDay");
    validateType(isFavorited, "boolean", "isFavorited");
    validateType(rating, "number", "rating");
    validateType(type, "string", "type");
    validateType(typeDescription, "string", "typeDescription");
    validateType(seasons, "array", "seasons");
    validateType(episodes, "array", "episodes");

    // 将 seasons 转换为 Season 实例数组
    const seasonInstances = seasons.map(seasonData => Season.fromJson(seasonData));

    // 直接解构并赋值给 this
    Object.assign(this, { animeId, bangumiId, animeTitle, imageUrl, isOnAir, airDay, isFavorited, rating,
      type, typeDescription, seasons: seasonInstances, episodes });
  }

  // ---- 静态方法：从 JSON 创建 Bangumi 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }

    // 将 episodes 转换为 BangumiEpisode 实例数组
    const episodes = json.episodes.map(ep => BangumiEpisode.fromJson(ep));

    // 创建 Bangumi 实例
    return new Bangumi({ ...json, episodes });
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return {
      ...this,
      seasons: this.seasons.map(season => season.toJson()),  // 转换每个 season 为 JSON
      episodes: this.episodes.map(ep => ep.toJson())  // 转换每个 episode 为 JSON
    };
  }
}

// =====================
// 数据模型：SegmentListResponse
// =====================
export class SegmentListResponse {
  constructor(rawJson = {}) {
    const {
      type = "", segmentList = [], duration = 0
    } = nullToUndefined(rawJson);
    validateType(type, "string", "type");
    validateType(segmentList, "array", "segmentList");
    validateType(duration, "number", "duration");

    // 将 segmentList 转换为 Segment 实例数组
    this.segmentList = segmentList.map(segmentData => Segment.fromJson(segmentData));

    // 直接解构并赋值给 this
    Object.assign(this, { type, duration });
  }

  // ---- 静态方法：从 JSON 创建 SegmentListResponse 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }

    const segmentList = (json.segmentList || []).map(segment => Segment.fromJson(segment));
    return new SegmentListResponse({ ...json, segmentList });
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return {
      ...this,
      segmentList: this.segmentList.map(segment => segment.toJson())
    };
  }
}

// =====================
// 数据模型：Segment
// =====================
export class Segment {
  constructor({ type, segment_start, segment_end, url, data, _m_h5_tk, _m_h5_tk_enc } = {}) {
    // 必需字段验证
    validateType(type, "string", "type");
    validateType(segment_start, "number", "segment_start");
    validateType(segment_end, "number", "segment_end");
    validateType(url, "string", "url");

    // 可选字段验证
    if (data !== undefined) validateType(data, "string", "data");
    if (_m_h5_tk !== undefined) validateType(_m_h5_tk, "string", "_m_h5_tk");
    if (_m_h5_tk_enc !== undefined) validateType(_m_h5_tk_enc, "string", "_m_h5_tk_enc");

    // 直接解构并赋值给 this
    Object.assign(this, { type, segment_start, segment_end, url, data, _m_h5_tk, _m_h5_tk_enc });
  }

  // ---- 静态方法：从 JSON 创建 Segment 对象 ----
  static fromJson(json) {
    if (typeof json !== "object" || json === null) {
      throw new TypeError("fromJson 参数必须是对象");
    }
    return new Segment(json);
  }

  // ---- 转换为纯 JSON ----
  toJson() {
    return { ...this };
  }
}

// 数据源的缺省值可能写成 null，而解构默认值只在 undefined 时生效；把 null 归一为 undefined，
// 使模型中已声明默认值的字段对 null 与缺省两种写法都取到默认值（客户端请求模型 Segment 不做归一，保持字段校验的严格性）。
function nullToUndefined(json) {
  const source = json || {};
  // 以无原型对象承载归一结果：外部数据中的 __proto__ 键不被当作原型写入
  const normalized = Object.create(null);
  for (const key in source) {
    normalized[key] = source[key] === null ? undefined : source[key];
  }
  return normalized;
}
