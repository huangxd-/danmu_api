// 通用测试夹具：请求/响应 mock 与全局状态重置
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

import dotenv from 'dotenv';
dotenv.config();

import { Globals } from '../../configs/globals.js';

export async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Mock Request class for testing
export class MockRequest {
  constructor(url, options = {}) {
    this.url = url;
    this.method = options.method || 'GET';
    this.headers = new Map(Object.entries(options.headers || {}));
    this.json = options.body ? async () => options.body : undefined;  // 模拟 POST 请求的 body
  }
}

// Helper to parse JSON response
export async function parseResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function mockJsonResponse(data, url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(data),
  };
}

export async function withMockFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await run();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
}

export function createSearchResult(anime) {
  return {
    animeId: anime.animeId,
    bangumiId: anime.bangumiId,
    animeTitle: anime.animeTitle,
    type: anime.type,
    typeDescription: anime.typeDescription,
    imageUrl: anime.imageUrl,
    startDate: anime.startDate,
    episodeCount: anime.episodeCount,
    rating: anime.rating,
    isFavorited: anime.isFavorited,
    source: anime.source
  };
}

export function resetSearchState() {
  Globals.init({});
  Globals.animes = [];
  Globals.episodeIds = [];
  Globals.episodeNum = 10001;
  Globals.searchCache = new Map();
  Globals.commentCache = new Map();
  Globals.requestHistory = new Map();
  Globals.envs.rateLimitMaxRequests = 0;
  delete Globals.requestAnimeDetailsMap;
}

export const urlPrefix = "http://localhost:9321";
export const token = "87654321";
