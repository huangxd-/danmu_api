import { simplized } from './zh-util.js';

// 只识别音轨标记；字幕语言及清晰度不能证明所播放的配音版本。
const AUDIO_TAGS = [
  ['mandarin', /普通版|普通话版|国语(?:配音|版)|(?:普通话|国语|国配|中配|中文配音)(?=$|[\s.()[\]（）【】_-])|\bmandarin\b/gi],
  ['cantonese', /粤语(?:配音|版)|(?:粤语|粤配)(?=$|[\s.()[\]（）【】_-])|\bcantonese\b/gi],
  ['original', /原声版|原版|原音版|(?:原声|原音|日语|日配|英语)(?=$|[\s.()[\]（）【】_-])|(?:日语|英语)(?:配音|版)|\b(?:original|japanese|english|jpn|eng)\b(?=$|[.()[\]（）【】_-])/gi],
];

export function movieAudioVersion(value) {
  const text = simplized(String(value || ''));
  if (/双语|多语|双音轨|多音轨|\b(?:dual|multi)[ ._-]*(?:audio|language)\b/i.test(text)) return null;
  const versions = AUDIO_TAGS.filter(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(text); });
  return versions.length === 1 ? versions[0][0] : null;
}

export function stripMovieAudioTags(value) {
  let text = simplized(String(value || ''));
  text = text.replace(/(?:(?:国语|粤语|英语|日语){1,3}|国英|国粤|国日|中英|中日)?(?:双语|多语|双音轨|多音轨)|\b(?:dual|multi)[ ._-]*(?:audio|language)\b/gi, ' ');
  for (const [, pattern] of AUDIO_TAGS) text = text.replace(pattern, (match, offset) =>
    /^[\s.()（）[\]【】_-]*$/.test(text.slice(offset + match.length)) ? ' ' : match);
  return text
    .replace(/[（(\[【]\s*[）)\]】]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function selectMovieVersions(episodes, animeTitle, version) {
  const classified = episodes.map(episode => ({ episode,
    version: movieAudioVersion(episode.episodeTitle) || movieAudioVersion(animeTitle) }));
  if (version) {
    const exact = classified.filter(item => item.version === version);
    return (exact.length ? exact : classified.filter(item => !item.version)).map(item => item.episode);
  }
  // 平台的普通版也可能只标「正片」；文件名不带音轨时与原版一并获取。
  const versions = classified.filter(item => !item.version || ['mandarin', 'original'].includes(item.version));
  const hasOriginal = versions.some(item => item.version === 'original');
  const hasRegular = versions.some(item => item.version !== 'original');
  return (hasOriginal && hasRegular ? versions : classified.slice(0, 1))
    .map(item => item.episode);
}
