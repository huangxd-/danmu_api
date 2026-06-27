import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTitleSeasonEpisode, findEpisodeByNumber } from './apis/dandan-api.js';
import { extractEpisodeNumberFromTitle } from './utils/common-util.js';

test('extractTitleSeasonEpisode parses common release episode names', async () => {
  let parsed = await extractTitleSeasonEpisode('[ANi] 葬送的芙莉莲 - 10 [1080P][Baha][WEB-DL][AAC AVC][CHT].mkv');
  assert.equal(parsed.title, '葬送的芙莉莲');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 10);

  parsed = await extractTitleSeasonEpisode('葬送的芙莉莲 [10][1080p].mkv');
  assert.equal(parsed.title, '葬送的芙莉莲');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 10);

  parsed = await extractTitleSeasonEpisode('Kusuriya no Hitorigoto - 10 [1080p].mkv');
  assert.equal(parsed.title, 'Kusuriya no Hitorigoto');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 10);

  parsed = await extractTitleSeasonEpisode('Title 第01話.mkv');
  assert.equal(parsed.title, 'Title');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 1);
});

test('extractTitleSeasonEpisode keeps existing SxxEyy parsing', async () => {
  assert.deepEqual(
    await extractTitleSeasonEpisode('爱情公寓.ipartment.2009.S02E08.H.265.25fps.mkv'),
    { title: '爱情公寓', season: 2, episode: 8, year: 2009 }
  );

  const parsed = await extractTitleSeasonEpisode('[Lilith-Raws] Kusuriya.no.Hitorigoto.S01E04.1080p.WEB-DL.mkv');
  assert.equal(parsed.title, 'Kusuriya no Hitorigoto');
  assert.equal(parsed.season, 1);
  assert.equal(parsed.episode, 4);
});

test('extractEpisodeNumberFromTitle supports hua and release suffixes', () => {
  assert.equal(extractEpisodeNumberFromTitle('第01話'), 1);
  assert.equal(extractEpisodeNumberFromTitle('[bilibili] 第10话'), 10);
  assert.equal(extractEpisodeNumberFromTitle('#03'), 3);
  assert.equal(extractEpisodeNumberFromTitle('01v2'), 1);
});

test('findEpisodeByNumber prefers structured episodeNumber over array index', () => {
  const episodes = [
    { episodeTitle: 'OP', episodeNumber: '1' },
    { episodeTitle: '番外', episodeNumber: '99' },
    { episodeTitle: '正片', episodeNumber: '2' },
  ];

  assert.equal(findEpisodeByNumber(episodes, 2, 2), episodes[2]);
});

test('findEpisodeByNumber avoids index fallback when structured numbers disagree', () => {
  const episodes = [
    { episodeTitle: '正片', episodeNumber: '1' },
    { episodeTitle: '番外', episodeNumber: '99' },
  ];

  assert.equal(findEpisodeByNumber(episodes, 2, 2), null);
});

test('findEpisodeByNumber still uses index fallback for unnumbered lists', () => {
  const episodes = [
    { episodeTitle: '上' },
    { episodeTitle: '下' },
  ];

  assert.equal(findEpisodeByNumber(episodes, 2, 2), episodes[1]);
});
