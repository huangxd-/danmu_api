// 弹弹play 数据模型：缺省值与类型校验
// 由原单文件测试 worker.test.js 机械拆分而来，用例名与断言未做改动。

import dotenv from 'dotenv';
dotenv.config();

import test from 'node:test';
import assert from 'node:assert';
import { Anime, AnimeMatch, Bangumi, BangumiEpisode, Episodes, Season, Segment, SegmentListResponse } from '../../models/dandan-model.js';
import { validateType } from '../../utils/common-util.js';

test('dandan-model 数据模型对 null 缺省值取默认值', () => {
  // 弹弹详情接口以 null 表示缺省（startDate 缺失、每集的 seasonId 与 airDate 均为 null）
  const anime = Anime.fromJson({
    animeId: 20417,
    bangumiId: '20417',
    animeTitle: 'これ描いて死ね 2(未知)【TV动画】from dandan',
    aliases: [],
    type: 'tvseries',
    typeDescription: 'TV动画',
    imageUrl: 'https://assets.anixer.net/image/poster/medium/1.jpg',
    startDate: null,
    episodeCount: 12,
    rating: 0,
    isFavorited: true,
    source: 'dandan',
    links: [{ name: '第1话', url: '204170001', title: '【dandan】 第1话' }],
  });
  assert.strictEqual(anime.startDate, '', 'startDate 为 null 时取默认空串');
  assert.strictEqual(anime.imageUrl, 'https://assets.anixer.net/image/poster/medium/1.jpg', '非 null 字段保持原值');

  // 声明了默认值的 number 与 boolean 字段同样对 null 取默认值
  const defaults = new Anime({ episodeCount: null, isFavorited: null });
  assert.strictEqual(defaults.episodeCount, 1, 'number 字段为 null 时取默认值');
  assert.strictEqual(defaults.isFavorited, true, 'boolean 字段为 null 时取默认值');

  const episode = BangumiEpisode.fromJson({
    seasonId: null,
    episodeId: 204170001,
    episodeTitle: '第1话',
    episodeNumber: '1',
    airDate: null,
  });
  assert.strictEqual(episode.seasonId, '', '集 seasonId 为 null 时取默认空串');
  assert.strictEqual(episode.airDate, '', '集 airDate 为 null 时取默认空串');

  // 外部数据中的 __proto__ 键不改写归一结果的原型，字段不被注入
  const withProtoKey = Anime.fromJson(JSON.parse('{"animeId": 20417, "__proto__": {"startDate": "被注入的年份"}}'));
  assert.strictEqual(withProtoKey.startDate, '', '外部数据的 __proto__ 键不注入未声明的字段');

  // Episodes 内的 Episode 实例同样对 null 取默认值
  const episodes = new Episodes({ episodes: [{ episodeId: null, episodeTitle: null }] });
  assert.strictEqual(episodes.episodes[0].episodeId, '', 'Episode 的 episodeId 为 null 时取默认空串');

  assert.throws(
    () => new Segment({ type: 'danmu', segment_start: 0, segment_end: 1, url: 'u', data: null }),
    /必须是 string/,
    '客户端请求模型 Segment 保持严格'
  );
});
test('dandan-model validateType 错误信息给出字段名与实际类型', () => {
  // 字符串、数组、boolean 三类校验分支均给出字段名与实际类型
  assert.throws(() => new Anime({ animeId: '不是数字' }), /animeId 必须是 number，但传入的是 string/, '字符串字段给出字段名与实际类型');
  assert.throws(() => new Anime({ links: '不是数组' }), /links 必须是一个数组，但传入的是 string/, '数组字段给出字段名与实际类型');
  assert.throws(() => new Anime({ isFavorited: '不是布尔' }), /isFavorited 必须是 boolean 或 number，但传入的是 string/, 'boolean 字段给出字段名与实际类型');

  // 各数据模型的字段校验均带字段名
  assert.throws(() => Anime.fromJson({ links: [{ url: 10001 }] }), /url 必须是 string，但传入的是 number/, 'Link 经 Anime 构造时给出字段名');
  assert.throws(() => new AnimeMatch({ shift: '不是数字' }), /shift 必须是 number，但传入的是 string/, 'AnimeMatch 给出字段名');
  assert.throws(() => new Episodes({ episodes: '不是数组' }), /episodes 必须是一个数组，但传入的是 string/, 'Episodes 给出字段名');
  assert.throws(() => new Season({ id: 10001 }), /id 必须是 string，但传入的是 number/, 'Season 给出字段名');
  assert.throws(() => new BangumiEpisode({ seasonId: 10001 }), /seasonId 必须是 string，但传入的是 number/, 'BangumiEpisode 给出字段名');
  assert.throws(() => new Bangumi({ airDay: '不是数字' }), /airDay 必须是 number，但传入的是 string/, 'Bangumi 给出字段名');
  assert.throws(() => new SegmentListResponse({ duration: '不是数字' }), /duration 必须是 number，但传入的是 string/, 'SegmentListResponse 给出字段名');

  // 直接调用校验时 null 与缺省值分别按实际类型给出
  assert.throws(() => validateType(null, 'string', 'startDate'), /startDate 必须是 string，但传入的是 null/, 'null 的实际类型为 null');
  assert.throws(() => validateType(undefined, 'string', 'startDate'), /startDate 必须是 string，但传入的是 undefined/, '缺省值的实际类型为 undefined');
  // 未传字段名时以值本身充当主语
  assert.throws(() => validateType('不是数字', 'number'), /不是数字 必须是 number，但传入的是 string/, '未传字段名时以值本身代替');
});
