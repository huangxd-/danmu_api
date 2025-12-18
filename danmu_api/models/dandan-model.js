import { validateType } from "../utils/common-util.js";

// =====================
// 数据模型：Anime
// =====================
export class Anime {
  constructor({ animeId = 111, bangumiId = "", animeTitle = "", type = "",
                typeDescription = "", imageUrl = "", startDate = "", episodeCount = 1,
                rating = 0, isFavorited = true, source = "", links = [] } = {}) {
    // ---- 类型检查 ----
    validateType(animeId, "number");
    validateType(bangumiId, "string");
    validateType(animeTitle, "string");
    validateType(type, "string", "type");
    validateType(typeDescription, "string");
    validateType(imageUrl, "string");
    validateType(startDate, "string");
    validateType(episodeCount, "number");
    validateType(rating, "number");
    validateType(isFavorited, "boolean");
    validateType(source, "string");
    validateType(links, "array");

    // 将 links 转换为 Link 实例数组
    this.links = links.map(linkData => Link.fromJson(linkData));

    // 直接解构并赋值给 this
    Object.assign(this, { animeId, bangumiId, animeTitle, type, typeDescription, imageUrl, startDate,
      episodeCount, rating, isFavorited, source });
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
  constructor({ name = "", url = "", title = "", id = 10001 } = {}) {
    validateType(name, "string");
    validateType(url, "string");
    validateType(title, "string");
    validateType(id, "number");

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
  constructor({ episodeId = 10001, animeId = 111, animeTitle = "", episodeTitle = "",
                type = "", typeDescription = "", shift = 1, imageUrl = "" } = {}) {
    // ---- 类型检查 ----
    validateType(episodeId, "number");
    validateType(animeId, "number");
    validateType(animeTitle, "string");
    validateType(episodeTitle, "string");
    validateType(type, "string", "type");
    validateType(typeDescription, "string");
    validateType(shift, "number");
    validateType(imageUrl, "string");

    // 直接解构并赋值给 this
    Object.assign(this, { episodeId, animeId, animeTitle, episodeTitle, type, typeDescription, shift, imageUrl });
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
  constructor({ episodeId = "", episodeTitle = "" } = {}) {
    this.episodeId = episodeId;
    this.episodeTitle = episodeTitle;
  }
}

// Episode 的 toJson 方法
Episode.prototype.toJson = function () {
  return {
    episodeId: this.episodeId,
    episodeTitle: this.episodeTitle
  };
};

// =====================
// 数据模型：Episodes
// =====================
export class Episodes {
  constructor({ animeId = 111, animeTitle = "", type = "", typeDescription = "",
                episodes = [] } = {}) {
    // ---- 类型检查 ----
    validateType(animeId, "number");
    validateType(animeTitle, "string");
    validateType(type, "string");
    validateType(typeDescription, "string");
    validateType(episodes, "array");

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
  constructor({ id = "", airDate = "", name = "", episodeCount = 0 } = {}) {
    validateType(id, "string");
    validateType(airDate, "string");
    validateType(name, "string");
    validateType(episodeCount, "number");

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
  constructor({ seasonId = "", episodeId = 10001, episodeTitle = "", episodeNumber = "",
                airDate = "" } = {}) {
    validateType(seasonId, "string");
    validateType(episodeId, "number");
    validateType(episodeTitle, "string");
    validateType(episodeNumber, "string");
    validateType(airDate, "string");

    // 直接解构并赋值给 this
    Object.assign(this, { seasonId, episodeId, episodeTitle, episodeNumber, airDate });
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
  constructor({ animeId = 111, bangumiId = "", animeTitle = "", imageUrl = "",
                isOnAir = true, airDay = 1, isFavorited = true, rating = 0,
                type = "", typeDescription = "", seasons = [], episodes = [] } = {}) {
    validateType(animeId, "number");
    validateType(bangumiId, "string");
    validateType(animeTitle, "string");
    validateType(imageUrl, "string");
    validateType(isOnAir, "boolean");
    validateType(airDay, "number");
    validateType(isFavorited, "boolean");
    validateType(rating, "number");
    validateType(type, "string");
    validateType(typeDescription, "string");
    validateType(seasons, "array");
    validateType(episodes, "array");

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
  constructor({ type = "", segmentList = [] } = {}) {
    validateType(type, "string");
    validateType(segmentList, "array");

    // 将 segmentList 转换为 Segment 实例数组
    this.segmentList = segmentList.map(segmentData => Segment.fromJson(segmentData));

    // 直接解构并赋值给 this
    Object.assign(this, { type });
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
