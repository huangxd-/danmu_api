// language=JavaScript
export const localDanmuJsContent = /* javascript */ `
function localDanmuUrl(path, admin = false) { return buildApiUrl(path, admin); }
function updateLocalDanmuPermission(config) {
  const file = document.getElementById('local-danmu-file');
  if (!file) return;
  if (config) {
    const adminToken = config.originalEnvVars?.ADMIN_TOKEN || '';
    file.dataset.canUpload = String(config.envs?.LOCAL_DANMU_NOT_REQUIRE_ADMIN === true
      || (!!adminToken && currentToken === adminToken));
  }
  const permission = document.getElementById('local-danmu-permission');
  if (permission) permission.textContent = file.dataset.canUpload === 'true'
    ? '可查看、上传和删除本地弹幕。'
    : '可查看已导入的本地弹幕；上传和删除需要 ADMIN 权限，请使用 ADMIN_TOKEN 访问。';
}
function checkLocalDanmuWritePermission(action, event) {
  if (document.getElementById('local-danmu-file').dataset.canUpload === 'true') return true;
  if (event) event.preventDefault();
  const message = action + '本地弹幕需要 ADMIN 权限，请使用 ADMIN_TOKEN 访问。';
  document.getElementById('local-danmu-upload-status').textContent = message;
  customAlert(message, '权限不足');
  return false;
}
function updateLocalDanmuTypeFields() {
  const isMovie = document.getElementById('local-danmu-type').value === 'movie';
  const season = document.getElementById('local-danmu-season');
  const episode = document.getElementById('local-danmu-episode');
  document.getElementById('local-danmu-season-label').textContent = isMovie ? '季（可选）' : '季';
  document.getElementById('local-danmu-episode-label').textContent = isMovie ? '集（可选）' : '集';
  season.placeholder = isMovie ? '可不填' : '默认 1';
  episode.placeholder = isMovie ? '可不填' : '默认 1';
  for (const input of [season, episode]) {
    if (isMovie && input.value === '1') input.value = '';
    else if (!isMovie && !input.value) input.value = '1';
  }
}
function initializeLocalDanmuForm() {
  const year = document.getElementById('local-danmu-year');
  if (!year) return;
  // 按打开页面时的年份重新生成选项，服务跨年运行时也能选择今年。
  const currentYear = new Date().getFullYear();
  year.replaceChildren();
  for (let value = currentYear; value >= 1900; value--) {
    const option = localDanmuElement('option', '', value + '年');
    option.value = String(value);
    year.append(option);
  }
  year.value = String(currentYear);
  document.getElementById('local-danmu-type').addEventListener('change', updateLocalDanmuTypeFields);
  updateLocalDanmuTypeFields();
}
function localDanmuElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function localDanmuFileSize(size) {
  const bytes = Number(size) || 0;
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
function renderLocalDanmuGroups(box, groups) {
  const openStates = new Map(Array.from(box.querySelectorAll('.local-danmu-group'), element => [element.dataset.groupKey, element.open]));
  box.replaceChildren();
  if (!groups.length) { box.append(localDanmuElement('p', 'text-gray', '暂无资源')); return; }
  const typeNames = { tv: '电视剧', movie: '电影', ova: 'OVA', special: '特别篇' };
  for (const group of groups) {
    const card = localDanmuElement('details', 'local-danmu-group');
    card.dataset.groupKey = group.groupKey;
    card.open = openStates.get(group.groupKey) ?? true;
    const summary = localDanmuElement('summary');
    const seasonText = group.type === 'movie' && group.season === 1 ? '' : ' · 第' + group.season + '季';
    summary.append(
      localDanmuElement('span', 'local-danmu-group-title', group.title),
      localDanmuElement('span', 'local-danmu-group-meta', (group.year || '年份未填写') + ' · ' + (typeNames[group.type] || group.type || '类型未填写') + seasonText),
      localDanmuElement('span', 'local-danmu-group-count', '已上传 ' + group.episodeCount + (group.type === 'movie' ? ' 个文件 · ' : ' 集 · ') + Number(group.count || 0).toLocaleString() + ' 条弹幕')
    );
    const episodes = localDanmuElement('div', 'local-danmu-episodes');
    for (const resource of group.episodes) {
      const row = localDanmuElement('div', 'local-danmu-episode');
      const info = localDanmuElement('div', 'local-danmu-episode-info');
      const episodeName = resource.episode == null ? (group.type === 'movie' ? '正片' : '全集') : '第' + resource.episode + '集';
      const state = resource.status === 'ready' ? '已解析' : (resource.status === 'failed' ? '解析失败' : '待解析');
      info.append(
        localDanmuElement('div', 'local-danmu-episode-title', episodeName),
        localDanmuElement('div', 'local-danmu-filename', resource.filename || '弹幕文件'),
        localDanmuElement('div', 'local-danmu-episode-meta', Number(resource.count || 0).toLocaleString() + ' 条弹幕 · ' + localDanmuFileSize(resource.size) + ' · ' + state)
      );
      const remove = localDanmuElement('button', 'btn btn-danger', resource.episode == null ? '删除文件' : '删除本集');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteLocalDanmu(resource.resourceKey));
      row.append(info, remove);
      episodes.append(row);
    }
    card.append(summary, episodes);
    box.append(card);
  }
}
async function loadLocalDanmuList() {
  const box = document.getElementById('local-danmu-list'); if (!box) return;
  try {
    const r = await fetch(localDanmuUrl('/api/local-danmu/list'));
    if (!r.ok) { box.replaceChildren(localDanmuElement('p', 'text-gray', r.status === 401 || r.status === 403 ? '请使用有效 TOKEN 查看资源列表' : '资源列表加载失败')); return; }
    const d = await r.json();
    renderLocalDanmuGroups(box, d.groups || []);
  } catch { box.replaceChildren(localDanmuElement('p', 'text-gray', '资源列表加载失败，请稍后重试')); }
}
async function uploadLocalDanmu() {
  if (!checkLocalDanmuWritePermission('上传')) return;
  const f = document.getElementById('local-danmu-file').files[0]; const s = document.getElementById('local-danmu-upload-status');
  if (!f) { s.textContent = '请选择文件'; return; }
  const title = document.getElementById('local-danmu-title').value.trim();
  if (!title) { s.textContent = '请填写标题'; return; }
  const year = document.getElementById('local-danmu-year').value.trim();
  if (!year) { s.textContent = '请选择年份'; return; }
  const currentYear = new Date().getFullYear();
  if (!/^[0-9]{4}$/.test(year) || Number(year) < 1900 || Number(year) > currentYear) { s.textContent = '年份必须在 1900–' + currentYear + ' 年之间'; return; }
  const type = document.getElementById('local-danmu-type').value;
  if (type !== 'tv' && type !== 'movie') { s.textContent = '请选择类型（tv 或 movie）'; return; }
  const seasonInput = document.getElementById('local-danmu-season');
  const episodeInput = document.getElementById('local-danmu-episode');
  const seasonValue = seasonInput.value.trim();
  const episodeValue = episodeInput.value.trim();
  const season = seasonValue ? Number(seasonValue) : (type === 'tv' ? 1 : null);
  const episode = episodeValue ? Number(episodeValue) : (type === 'tv' ? 1 : null);
  if (seasonInput.validity?.badInput || (season !== null && (!Number.isSafeInteger(season) || season < 1))) { s.textContent = '季数必须是大于 0 的整数'; return; }
  if (episodeInput.validity?.badInput || (episode !== null && (!Number.isSafeInteger(episode) || episode < 1))) { s.textContent = '集数必须是大于 0 的整数'; return; }
  if (type === 'tv' && !seasonValue) seasonInput.value = '1';
  if (type === 'tv' && !episodeValue) episodeInput.value = '1';
  const fd = new FormData(); fd.append('file', f); fd.append('title', title); fd.append('year', year); fd.append('type', type);
  if (season !== null) fd.append('season', String(season));
  if (episode !== null) fd.append('episode', String(episode));
  const button = document.getElementById('local-danmu-upload-button');
  button.disabled = true;
  s.textContent = '正在上传并解析…';
  try {
    const r = await fetch(localDanmuUrl('/api/local-danmu/upload'), { method: 'POST', body: fd });
    const d = await r.json();
    s.textContent = d.success ? (type === 'movie' ? '电影上传成功' : '第' + d.resource.season + '季上传成功') + '，共 ' + d.resource.count + ' 条弹幕' : (d.errorMessage || '上传失败');
    if (d.success) await loadLocalDanmuList();
  } catch { s.textContent = '上传失败，请稍后重试'; }
  finally { button.disabled = false; }
}
async function deleteLocalDanmu(key) {
  if (!checkLocalDanmuWritePermission('删除')) return;
  if (!confirm('确认删除这个弹幕文件？')) return;
  const status = document.getElementById('local-danmu-upload-status');
  try {
    const r = await fetch(localDanmuUrl('/api/local-danmu/' + encodeURIComponent(key)), { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok || !d.success) { status.textContent = d.errorMessage || '删除失败'; return; }
    status.textContent = '已删除弹幕文件';
    await loadLocalDanmuList();
  } catch { status.textContent = '删除失败，请稍后重试'; }
}
document.addEventListener('DOMContentLoaded', () => {
  initializeLocalDanmuForm();
  updateLocalDanmuPermission();
  loadLocalDanmuList();
});
`;
