const API_ROOTS = new Set(['api', 'v1', 'v2', 'search', 'match', 'bangumi', 'comment', 'danmaku']);

export function resolveRequestAuth(path, token, disabled = false) {
  const parts = path.split('/').filter(Boolean);
  const explicit = parts[0] === token;
  const defaultAccess = token === '87654321' && API_ROOTS.has(parts[0]);
  return {
    authorized: disabled || explicit || defaultAccess,
    path: explicit ? '/' + parts.slice(1).join('/') : path,
    currentToken: disabled ? '' : (explicit || defaultAccess ? token : ''),
  };
}
