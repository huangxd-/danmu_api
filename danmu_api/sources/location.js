import { isSupportedLocation, isSupportedSource, sourceForUrl } from './policy.js';
import { canonicalPlatformName } from '../utils/platform-util.js';
import { stripLinkOffset } from '../utils/offset-util.js';

// Resolve routing once for URL, stored episode, merged download and duration lookup.
// Domain matching deliberately ignores paths and query parameters.
export function resolveSourceLocation(value, fallbackSource = '') {
  const { cleanUrl, offset, percent } = stripLinkOffset(String(value || '').trim());
  let realId = cleanUrl;
  let source = canonicalPlatformName(fallbackSource);
  const prefix = cleanUrl.match(/^([^:]+):/)?.[1];
  if (isSupportedSource(prefix)) {
    source = canonicalPlatformName(prefix);
    realId = cleanUrl.slice(prefix.length + 1);
    if (source === 'hongguo') realId = `hongguo:${realId}`;
  }
  if (/^https?:\/\//i.test(realId)) {
    source = sourceForUrl(realId);
    if (!source) return null;
    if (source === 'bahamut') realId = new URL(realId).searchParams.get('sn') || realId;
  } else if (!isSupportedLocation(realId, source)) {
    return null;
  }
  if (!isSupportedSource(source)) return null;
  return { source, realId, offset, percent };
}
