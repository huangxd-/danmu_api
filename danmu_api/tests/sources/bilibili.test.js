// B站源：b23.tv 短链解析
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Globals } from '../../configs/globals.js';
import BilibiliSource from '../../sources/bilibili.js';
import { withMockFetch } from '../helpers/context.js';

test('BilibiliSource should resolve b23.tv short links from redirect location', async () => {
    Globals.init({});
    const source = new BilibiliSource();
    const shortUrl = 'https://b23.tv/BV1GJ411x7h7';
    const targetUrl = 'https://www.bilibili.com/video/BV1GJ411x7h7';
    let seenRedirectMode;

    await withMockFetch(async (url, options) => {
      assert.equal(url, shortUrl);
      seenRedirectMode = options.redirect;
      return {
        ok: false,
        status: 302,
        url: shortUrl,
        headers: new Headers({ location: targetUrl }),
        text: async () => '',
      };
    }, async () => {
      const resolvedUrl = await source.resolveB23Link(shortUrl);
      assert.equal(resolvedUrl, targetUrl);
    });

    assert.equal(seenRedirectMode, 'manual');
  });
