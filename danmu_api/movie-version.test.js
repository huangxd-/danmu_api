import test from 'node:test';
import assert from 'node:assert/strict';
import { Globals } from './configs/globals.js';
import { handleRequest } from './worker.js';
import { getSourceByKey } from './sources/registry.js';
import { addAnime, findAnimeTitleById, findUrlById } from './utils/cache-util.js';
import { movieAudioVersion, stripMovieAudioTags } from './utils/movie-version-util.js';
import { BLOCKED_WORD_PRESETS } from './utils/blocked-word-presets.js';
import { filterDanmusByBlockedWords } from './utils/danmu-util.js';

test('movie audio markers distinguish dubbing without treating subtitles or titles as audio', () => {
  for (const value of ['电影.普通版.mkv', '电影.国语版.mkv', '电影（普通話版）', '电影.Mandarin.mkv']) assert.equal(movieAudioVersion(value), 'mandarin');
  for (const value of ['电影.原版.mkv', '电影.原声版.mkv', '电影.English.mkv']) assert.equal(movieAudioVersion(value), 'original');
  for (const value of ['电影.中字.mkv', '电影.简繁字幕.mkv', '电影.国语英语双语.mkv', '电影.Dual.Audio.mkv', '英语老师', 'English Teacher.2013.mkv', 'Original Sin.2001.mkv']) assert.equal(movieAudioVersion(value), null);
  assert.equal(stripMovieAudioTags('英语老师'), '英语老师');
  assert.equal(stripMovieAudioTags('冰雪奇缘（普通话版）'), '冰雪奇缘');
  assert.equal(stripMovieAudioTags('English Teacher'), 'English Teacher');
  assert.equal(stripMovieAudioTags('冰雪奇缘 国英双语'), '冰雪奇缘');
});

function reset() {
  Globals.init({ SOURCE_ORDER: 'tencent', PLATFORM_ORDER: 'tencent', MERGE_SOURCE_PAIRS: '',
    CUSTOM_MERGE_RULES: '', TITLE_MAPPING_TABLE: '', TITLE_MAPPING_TABLE_URL: '',
    AUTO_MATCH_MAPPING_TABLE: '', AUTO_MATCH_MAPPING_TABLE_URL: '', TMDB_API_KEY: '', PROXY_URL: '',
    BILIBILI_UGC_ENABLED: 'false', BLOCK_DOMESTIC_CELEBRITIES: 'false', BLOCKED_WORDS: '',
    LOCAL_CACHE_ENABLED: 'false', LOCAL_REDIS_URL: '', USE_BANGUMI_DATA: 'false',
    RATE_LIMIT_MAX_REQUESTS: '0', LOG_LEVEL: 'error' });
  for (const key of ['searchCache', 'commentCache', 'favoriteCache', 'lastSelectMap', 'requestHistory']) Globals[key] = new Map();
  Globals.animes = []; Globals.episodeIds = []; Globals.episodeNum = 10001;
  Globals.localCacheValid = false; Globals.localRedisValid = false;
}

test('movie match selects a named audio version or merges both and serves the merged episode ID', async t => {
  reset();
  const source = getSourceByKey('tencent');
  const urls = ['https://v.qq.com/x/cover/frozen/mandarin.html', 'https://v.qq.com/x/cover/frozen/original.html'];
  let separateVersions = false;
  let unlabelledRegular = false;
  t.mock.method(source, 'search', async () => []);
  t.mock.method(source, 'handleAnimes', async (_raw, _title, results, details) => {
    const anime = { animeId: 81001, bangumiId: 'frozen', source: 'tencent', type: '电影',
      animeTitle: '冰雪奇缘(2013)【电影】from tencent', startDate: '2013-01-01', episodeCount: 1,
      links: [ { title: unlabelledRegular ? '【tencent】 正片' : '【tencent】 普通话版', url: urls[0] }, { title: '【tencent】 原版', url: urls[1] },
        { title: '【tencent】 原版预告片', url: 'https://v.qq.com/x/cover/frozen/trailer.html' } ] };
    const items = separateVersions ? urls.map((url, index) => ({ ...anime, animeId: 81001 + index,
      bangumiId: `frozen-${index}`, animeTitle: `冰雪奇缘（${index ? '原版' : '普通话版'}）(2013)【电影】from tencent`,
      links: [{ title: '【tencent】 正片', url }] })) : [anime];
    for (const item of items) { addAnime(item, details); const { links, ...dto } = item; results.push(dto); }
  });
  const fetched = [];
  t.mock.method(source, 'getEpisodeDanmu', async url => { fetched.push(url); return [{ p: '10,1,25,16777215', m: url === urls[0] ? '普通话弹幕' : '原版弹幕' }]; });
  t.mock.method(source, 'formatComments', raw => raw);
  for (const [fileName, expected] of [
    ['冰雪奇缘（普通话版）.2013.mkv', urls[0]], ['冰雪奇缘.2013.原版.mkv', urls[1]],
    ['冰雪奇缘.2013.mkv', null], ['冰雪奇缘.2013.Dual.Audio.mkv', null],
  ]) {
    const req = new Request('http://localhost/87654321/api/v2/match', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName, mediaType: 'movie' }) });
    const result = await (await handleRequest(req, Globals.env)).json();
    assert.equal(result.isMatched, true, fileName);
    const selected = result.matches[0];
    assert.equal(findUrlById(selected.episodeId), selected.url);
    if (expected) assert.equal(selected.url, expected, fileName);
    else {
      assert.equal(selected.url, urls.map(url => 'tencent:' + url).join('$$$'));
      assert.match(findAnimeTitleById(selected.episodeId), /冰雪奇缘/);
      const comments = await (await handleRequest(new Request(`http://localhost/87654321/api/v2/comment/${selected.episodeId}?format=json`), Globals.env)).json();
      assert.deepEqual(comments.comments.map(item => item.m).sort(), ['原版弹幕', '普通话弹幕'].sort());
    }
  }
  assert.deepEqual([...new Set(fetched)].sort(), [...urls].sort());
  separateVersions = true;
  reset();
  for (const [fileName, expected] of [['冰雪奇缘.2013.原版.mkv', urls[1]], ['冰雪奇缘.2013.mkv', urls.map(url => 'tencent:' + url).join('$$$')]]) {
    const result = await (await handleRequest(new Request('http://localhost/87654321/api/v2/match', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName, mediaType: 'movie' }) }), Globals.env)).json();
    assert.equal(result.matches[0]?.url, expected, '配音版独立条目：' + fileName);
    if (fileName.includes('原版')) assert.equal(result.matches[0].animeId, 81002);
  }
  separateVersions = false;
  unlabelledRegular = true;
  reset();
  const result = await (await handleRequest(new Request('http://localhost/87654321/api/v2/match', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: '冰雪奇缘.2013.WEB-DL.1080p.mkv' }) }), Globals.env)).json();
  assert.equal(result.matches[0]?.url, urls.map(url => 'tencent:' + url).join('$$$'), '不带语言的电影文件名合并正片与原版');
});

test('numeric and symbol presets block whole messages and preserve meaningful text', () => {
  Globals.init({ LOCAL_CACHE_ENABLED: 'false', LOCAL_REDIS_URL: '', LOG_LEVEL: 'error' });
  assert.equal(Globals.envs.blockedWords, BLOCKED_WORD_PRESETS.content.join(','));
  reset();
  assert.equal(Globals.envs.blockedWords, ''); // 显式清空仍能关闭，保存的自定义规则不被强行追加。
  Globals.envs.blockedWords = BLOCKED_WORD_PRESETS.content.join(',');
  const blocked = ['666', '０１２３', '１２ ３４', '123\n456', '！！！', '。。。', '？！～', '🙂', '❤️', '👨‍👩‍👧‍👦'];
  const kept = ['666太强了', '第123集', 'Hello!', '你好！', '3.14', '123!'];
  assert.deepEqual(filterDanmusByBlockedWords([...blocked, ...kept].map(m => ({ m }))).map(item => item.m), kept);
});
