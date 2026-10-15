// iqiyi 源：分集标题的组装与集数补齐

import test from 'node:test';
import assert from 'node:assert';
import IqiyiSource from '../../sources/iqiyi.js';

const buildTitle = (epData) => IqiyiSource.prototype._buildEpisodeTitle.call({}, epData);
const ensureNumber = (title, animeTitle, order) =>
  IqiyiSource.prototype._ensureEpisodeNumber.call({}, title, animeTitle, order);

test('iqiyi episode title uses short_display_name and appends subtitle', () => {
  assert.strictEqual(buildTitle({ short_display_name: '太古神尊 天魔秘藏' }), '太古神尊 天魔秘藏');
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
  // 分集名已包含副标题时不重复拼接
  assert.strictEqual(
    buildTitle({ short_display_name: '太古神尊 第11集 巨额悬赏', subtitle: '巨额悬赏' }),
    '太古神尊 第11集 巨额悬赏'
  );
});

test('iqiyi episode title falls back when name fields are missing', () => {
  assert.strictEqual(buildTitle({ title: '太古神尊 外门考核' }), '太古神尊 外门考核');
  assert.strictEqual(buildTitle({}), '未知分集');
});

test('iqiyi episode number is inserted after the anime title when missing', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊', 10),
    '太古神尊 第10集 天魔秘藏'
  );
  // 不以作品名开头时集数置于标题前
  assert.strictEqual(ensureNumber('天魔秘藏', '太古神尊', 10), '第10集 天魔秘藏');
  // 作品名带年份与类型后缀时，剥去后缀再比对
  assert.strictEqual(
    ensureNumber('太古神尊 天魔秘藏', '太古神尊(2026)【3D动漫】from iqiyi', 10),
    '太古神尊 第10集 天魔秘藏'
  );
});

test('iqiyi episode number keeps titles that already carry an episode number', () => {
  assert.strictEqual(
    ensureNumber('太古神尊 第11集 巨额悬赏', '太古神尊', 11),
    '太古神尊 第11集 巨额悬赏'
  );
  // 接口的其它集数写法同样视为已含集数
  assert.strictEqual(ensureNumber('太古神尊 EP11', '太古神尊', 11), '太古神尊 EP11');
});

test('iqiyi episode number is not added without a valid order', () => {
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', undefined), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', null), '太古神尊 天魔秘藏');
  assert.strictEqual(ensureNumber('太古神尊 天魔秘藏', '太古神尊', ''), '太古神尊 天魔秘藏');
});

test('iqiyi episode titles share one format across all episodes', () => {
  const animeTitle = '太古神尊';
  const withoutNumber = ['太子转生', '天魔秘藏'].map((name, index) =>
    ensureNumber(buildTitle({ short_display_name: `${animeTitle} ${name}` }), animeTitle, index + 1)
  );
  const withNumber = ensureNumber(buildTitle({ short_display_name: `${animeTitle} 第11集`, subtitle: '巨额悬赏' }), animeTitle, 11);
  for (const title of [...withoutNumber, withNumber]) {
    assert.match(title, new RegExp(`^${animeTitle} 第\\d+集 `));
  }
});
