// language=JavaScript
export const localDanmuJsContent = /* javascript */ `
let localDanmuStorageReady = globals.localDanmuRedisValid;
let localDanmuIsCloud = globals.localDanmuIsCloud;
let localDanmuGroups = [];
let localDanmuUploadItems = [];
let localDanmuUploading = false;
function localDanmuUrl(path, admin = false) { return buildApiUrl(path, admin); }
function localDanmuRedisUnavailable() {
  return localDanmuIsCloud && !localDanmuStorageReady;
}
function showLocalDanmuRedisRequired() {
  const message = '当前为云端部署，未配置可用 Redis，无法使用本地弹幕。请配置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN 后重试。';
  const status = document.getElementById('local-danmu-upload-status');
  if (status) status.textContent = message;
  customAlert(message, '需要配置 Redis');
  return false;
}
function updateLocalDanmuPermission(config) {
  const file = document.getElementById('local-danmu-file');
  if (!file) return;
  if (config) {
    const deployPlatform = String(config.envs?.deployPlatform || '').trim().toLowerCase();
    localDanmuIsCloud = deployPlatform !== '' && deployPlatform !== 'node';
    localDanmuStorageReady = config.envs?.redisValid === true;
    const adminToken = config.originalEnvVars?.ADMIN_TOKEN || '';
    file.dataset.canUpload = String(config.envs?.LOCAL_DANMU_NOT_REQUIRE_ADMIN === true
      || (!!adminToken && currentToken === adminToken));
  }
  const permission = document.getElementById('local-danmu-permission');
  if (permission) permission.textContent = localDanmuRedisUnavailable()
    ? '当前为云端部署，未配置可用 Redis，无法使用本地弹幕。请先配置 Redis。'
    : file.dataset.canUpload === 'true'
    ? '可查看、上传和删除本地弹幕。'
    : '可查看已导入的本地弹幕；上传和删除需要 ADMIN 权限，请使用 ADMIN_TOKEN 访问。';
}
function checkLocalDanmuWritePermission(action, event) {
  if (localDanmuRedisUnavailable()) {
    if (event) event.preventDefault();
    return showLocalDanmuRedisRequired();
  }
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
  document.getElementById('local-danmu-file').addEventListener('change', updateLocalDanmuUploadFiles);
  document.getElementById('local-danmu-type').addEventListener('change', updateLocalDanmuTypeFields);
  document.getElementById('local-danmu-search')?.addEventListener('input', filterLocalDanmuGroups);
  updateLocalDanmuTypeFields();
  updateLocalDanmuUploadFiles();
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
function localDanmuEpisodeFromFilename(filename) {
  const name = String(filename || '').normalize('NFKC').replace(/\\.(xml|json|ass|ssa|csv|txt)$/i, '').trim();
  const match = name.match(/S[0-9]+[ ._-]*EP?([0-9]+)/i)
    || name.match(/第\\s*([0-9]+)\\s*[集话話回]/)
    || name.match(/(?:^|[^A-Za-z0-9])(?:EP?|Episode)[ ._-]*([0-9]+)/i)
    || name.match(/^([0-9]+)$/)
    || name.match(/(?:^|[\\s._-])([0-9]{1,3})(?=$|[\\s._-]*[[(【])/);
  const episode = match ? Number(match[1]) : null;
  return Number.isSafeInteger(episode) && episode > 0 ? episode : null;
}
function localDanmuSelectedFiles() {
  return Array.from(document.getElementById('local-danmu-file').files || [])
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
}
function updateLocalDanmuUploadFiles() {
  if (localDanmuUploading) return;
  const files = localDanmuSelectedFiles();
  const isBatch = files.length > 1;
  const list = document.getElementById('local-danmu-batch-list');
  localDanmuUploadItems = [];
  list.replaceChildren();
  document.getElementById('local-danmu-batch-preview').hidden = !isBatch;
  document.getElementById('local-danmu-episode-field').hidden = isBatch;
  document.getElementById('local-danmu-fields').dataset.batch = String(isBatch);
  document.getElementById('local-danmu-upload-button').textContent = isBatch ? '批量上传并解析' : '上传并解析';
  document.getElementById('local-danmu-upload-status').textContent = '';
  if (!isBatch) return;
  for (const [index, file] of files.entries()) {
    const row = localDanmuElement('div', 'local-danmu-batch-row');
    const info = localDanmuElement('div', 'local-danmu-batch-file');
    info.append(localDanmuElement('div', 'local-danmu-filename', file.name), localDanmuElement('div', 'local-danmu-file-hint', localDanmuFileSize(file.size)));
    const field = localDanmuElement('div', 'form-group local-danmu-batch-episode');
    const input = localDanmuElement('input');
    input.id = 'local-danmu-batch-episode-' + index;
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.required = true;
    const episode = localDanmuEpisodeFromFilename(file.name);
    input.value = episode === null ? '' : String(episode);
    input.placeholder = '请填写';
    input.setAttribute('aria-label', file.name + ' 的集数');
    const label = localDanmuElement('label', '', '集数');
    label.htmlFor = input.id;
    field.append(label, input);
    const status = localDanmuElement('div', 'local-danmu-batch-status', episode === null ? '未识别，请填写集数' : '待上传');
    input.addEventListener('input', () => { status.textContent = input.value ? '待上传' : '请填写集数'; });
    row.append(info, field, status);
    list.append(row);
    localDanmuUploadItems.push({ file, input, status });
  }
}
function renderLocalDanmuGroups(box, groups, emptyText = '暂无资源') {
  const openStates = new Map(Array.from(box.querySelectorAll('.local-danmu-group'), element => [element.dataset.groupKey, element.open]));
  box.replaceChildren();
  if (!groups.length) { box.append(localDanmuElement('p', 'text-gray', emptyText)); return; }
  const typeNames = { tv: '电视剧', movie: '电影', ova: 'OVA', special: '特别篇' };
  for (const group of groups) {
    const card = localDanmuElement('details', 'local-danmu-group');
    card.dataset.groupKey = group.groupKey;
    card.open = openStates.get(group.groupKey) ?? false;
    const summary = localDanmuElement('summary');
    const seasonText = group.type === 'movie' && group.season === 1 ? '' : ' · 第' + group.season + '季';
    summary.append(
      localDanmuElement('span', 'local-danmu-group-title', group.title),
      localDanmuElement('span', 'local-danmu-group-meta', (group.year || '年份未填写') + ' · ' + (typeNames[group.type] || group.type || '类型未填写') + seasonText),
      localDanmuElement('span', 'local-danmu-group-count', '已上传 ' + group.episodeCount + (group.type === 'movie' ? ' 个文件 · ' : ' 集 · ') + Number(group.count || 0).toLocaleString() + ' 条弹幕')
    );
    const editGroup = localDanmuElement('button', 'btn btn-secondary', '编辑剧集');
    editGroup.type = 'button';
    editGroup.addEventListener('click', () => openLocalDanmuEdit('group', group));
    const removeGroup = localDanmuElement('button', 'btn btn-danger', '删除整个剧集');
    removeGroup.type = 'button';
    removeGroup.addEventListener('click', () => deleteLocalDanmuGroup(group));
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
      const reupload = localDanmuElement('button', 'btn btn-secondary', '重新上传');
      reupload.type = 'button';
      reupload.addEventListener('click', () => prepareLocalDanmuReupload(resource));
      const remove = localDanmuElement('button', 'btn btn-danger', resource.episode == null ? '删除文件' : '删除本集');
      remove.type = 'button';
      remove.addEventListener('click', () => deleteLocalDanmu(resource.resourceKey));
      const actions = localDanmuElement('div', 'local-danmu-episode-actions');
      const edit = localDanmuElement('button', 'btn btn-secondary', '编辑');
      edit.type = 'button';
      edit.addEventListener('click', () => openLocalDanmuEdit('resource', resource));
      actions.append(remove, reupload, edit);
      row.append(info, actions);
      episodes.append(row);
    }
    const groupActions = localDanmuElement('div', 'local-danmu-group-actions');
    groupActions.append(editGroup, removeGroup);
    card.append(summary, episodes, groupActions);
    box.append(card);
  }
}
let localDanmuEditTarget = null;
function openLocalDanmuEdit(scope, target) {
  if (!checkLocalDanmuWritePermission('编辑')) return;
  localDanmuEditTarget = { scope, target };
  const modal = document.getElementById('local-danmu-edit-modal');
  document.getElementById('local-danmu-edit-group-fields').style.display = scope === 'group' ? '' : 'none';
  document.getElementById('local-danmu-edit-resource-fields').style.display = scope === 'resource' ? '' : 'none';
  document.getElementById('local-danmu-edit-name').value = target.title || '';
  document.getElementById('local-danmu-edit-year').value = target.year == null ? '' : String(target.year);
  document.getElementById('local-danmu-edit-type').value = target.type || 'tv';
  document.getElementById('local-danmu-edit-season').value = target.season == null ? '' : String(target.season);
  document.getElementById('local-danmu-edit-episode').value = target.episode == null ? '' : String(target.episode);
  document.getElementById('local-danmu-edit-filename').value = target.filename || '';
  document.getElementById('local-danmu-edit-status').textContent = '';
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}
function closeLocalDanmuEdit() {
  const modal = document.getElementById('local-danmu-edit-modal');
  if (modal) { modal.classList.remove('active'); modal.setAttribute('aria-hidden', 'true'); }
  localDanmuEditTarget = null;
}
async function submitLocalDanmuEdit() {
  if (!localDanmuEditTarget || !checkLocalDanmuWritePermission('编辑')) return;
  const { scope, target } = localDanmuEditTarget;
  const resourceKey = target.resourceKey || target.episodes?.[0]?.resourceKey;
  const status = document.getElementById('local-danmu-edit-status');
  const body = { scope };
  if (scope === 'group') Object.assign(body, { title: document.getElementById('local-danmu-edit-name').value.trim(), year: document.getElementById('local-danmu-edit-year').value.trim(), type: document.getElementById('local-danmu-edit-type').value, season: document.getElementById('local-danmu-edit-season').value.trim() });
  else Object.assign(body, { episode: document.getElementById('local-danmu-edit-episode').value.trim(), filename: document.getElementById('local-danmu-edit-filename').value.trim() });
  try {
    const response = await fetch(localDanmuUrl('/api/local-danmu/' + encodeURIComponent(resourceKey)), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || !data.success) { status.textContent = data.errorMessage || '更新失败'; return; }
    closeLocalDanmuEdit();
    await loadLocalDanmuList();
  } catch { status.textContent = '更新失败，请稍后重试'; }
}
function prepareLocalDanmuReupload(resource) {
  if (localDanmuUploading) return;
  if (!checkLocalDanmuWritePermission('重新上传')) return;
  document.getElementById('local-danmu-title').value = resource.title || '';
  document.getElementById('local-danmu-year').value = resource.year == null ? '' : String(resource.year);
  document.getElementById('local-danmu-type').value = resource.type || 'tv';
  document.getElementById('local-danmu-season').value = resource.season == null ? '' : String(resource.season);
  document.getElementById('local-danmu-episode').value = resource.episode == null ? '' : String(resource.episode);
  updateLocalDanmuTypeFields();
  const file = document.getElementById('local-danmu-file');
  file.value = '';
  updateLocalDanmuUploadFiles();
  document.getElementById('local-danmu-upload-status').textContent = '已填充“' + (resource.title || '') + '”的信息，请选择新文件后上传。';
  file.click?.();
}
function filterLocalDanmuGroups() {
  const box = document.getElementById('local-danmu-list');
  const search = document.getElementById('local-danmu-search');
  if (!box || !search) return;
  const keyword = search.value.trim().toLocaleLowerCase();
  const groups = keyword
    ? localDanmuGroups.filter(group => String(group.title || '').toLocaleLowerCase().includes(keyword))
    : localDanmuGroups;
  renderLocalDanmuGroups(box, groups, keyword ? '未找到匹配标题' : '暂无资源');
}
async function loadLocalDanmuList() {
  const box = document.getElementById('local-danmu-list'); if (!box) return;
  try {
    const r = await fetch(localDanmuUrl('/api/local-danmu/list'));
    if (!r.ok) { box.replaceChildren(localDanmuElement('p', 'text-gray', r.status === 401 || r.status === 403 ? '请使用有效 TOKEN 查看资源列表' : '资源列表加载失败')); return; }
    const d = await r.json();
    localDanmuGroups = d.groups || [];
    filterLocalDanmuGroups();
  } catch { box.replaceChildren(localDanmuElement('p', 'text-gray', '资源列表加载失败，请稍后重试')); }
}
async function uploadLocalDanmu() {
  if (localDanmuUploading) return;
  if (localDanmuRedisUnavailable()) {
    showLocalDanmuRedisRequired();
    return;
  }
  if (!checkLocalDanmuWritePermission('上传')) return;
  const files = localDanmuSelectedFiles();
  const s = document.getElementById('local-danmu-upload-status');
  if (!files.length) { s.textContent = '请选择文件'; return; }
  const isBatch = files.length > 1;
  if (isBatch ? files.length !== localDanmuUploadItems.length || files.some((file, index) => file !== localDanmuUploadItems[index].file) : localDanmuUploadItems.length > 0) {
    updateLocalDanmuUploadFiles();
  }
  const title = document.getElementById('local-danmu-title').value.trim();
  if (!title) { s.textContent = '请填写标题'; return; }
  const year = document.getElementById('local-danmu-year').value.trim();
  if (!year) { s.textContent = '请选择年份'; return; }
  const currentYear = new Date().getFullYear();
  if (!/^[0-9]{4}$/.test(year) || Number(year) < 1900 || Number(year) > currentYear) { s.textContent = '年份必须在 1900–' + currentYear + ' 年之间'; return; }
  const type = document.getElementById('local-danmu-type').value;
  if (type !== 'tv' && type !== 'movie') { s.textContent = '请选择类型（tv 或 movie）'; return; }
  if (isBatch && type !== 'tv') { s.textContent = '批量导入用于同一部电视剧，请选择 tv 类型；电影请逐个上传。'; return; }
  const seasonInput = document.getElementById('local-danmu-season');
  const episodeInput = document.getElementById('local-danmu-episode');
  const seasonValue = seasonInput.value.trim();
  const episodeValue = episodeInput.value.trim();
  const season = seasonValue ? Number(seasonValue) : (type === 'tv' ? 1 : null);
  const episode = isBatch ? null : episodeValue ? Number(episodeValue) : (type === 'tv' ? 1 : null);
  if (seasonInput.validity?.badInput || (season !== null && (!Number.isSafeInteger(season) || season < 1))) { s.textContent = '季数必须是大于 0 的整数'; return; }
  if (!isBatch && (episodeInput.validity?.badInput || (episode !== null && (!Number.isSafeInteger(episode) || episode < 1)))) { s.textContent = '集数必须是大于 0 的整数'; return; }
  if (type === 'tv' && !seasonValue) seasonInput.value = '1';
  if (!isBatch && type === 'tv' && !episodeValue) episodeInput.value = '1';
  const uploads = isBatch
    ? localDanmuUploadItems.map(item => ({ ...item, episode: Number(item.input.value.trim()) }))
    : [{ file: files[0], episode }];
  if (isBatch) {
    const episodes = new Map();
    let invalid = false;
    for (const item of uploads) {
      item.status.textContent = '待上传';
      if (item.input.validity?.badInput || !Number.isSafeInteger(item.episode) || item.episode < 1) {
        item.status.textContent = '请填写有效集数';
        invalid = true;
      } else if (episodes.has(item.episode)) {
        item.status.textContent = '集数重复，请修改';
        episodes.get(item.episode).status.textContent = '集数重复，请修改';
        invalid = true;
      } else episodes.set(item.episode, item);
    }
    if (invalid) { s.textContent = '请先填写有效且不重复的集数，再批量上传。'; return; }
  }
  const controls = ['file', 'title', 'year', 'type', 'season', 'episode', 'upload-button']
    .map(name => document.getElementById('local-danmu-' + name)).concat(isBatch ? uploads.map(item => item.input) : []);
  const disabledStates = controls.map(control => control.disabled === true);
  localDanmuUploading = true;
  controls.forEach(control => { control.disabled = true; });
  let succeeded = 0;
  let failed = 0;
  let totalComments = 0;
  try {
    // 逐个上传，避免并发写入 Redis 索引时相互覆盖。
    for (const [index, item] of uploads.entries()) {
      s.textContent = isBatch ? '正在上传 ' + (index + 1) + ' / ' + uploads.length + '：' + item.file.name : '正在上传并解析…';
      if (item.status) item.status.textContent = '正在上传…';
      let errorMessage = item.file.size > 10 * 1024 * 1024 ? '文件大小不能超过 10 MB' : '';
      let resource;
      if (!errorMessage) {
        try {
          const fd = new FormData();
          fd.append('file', item.file); fd.append('title', title); fd.append('year', year); fd.append('type', type);
          if (season !== null) fd.append('season', String(season));
          if (item.episode !== null) fd.append('episode', String(item.episode));
          const response = await fetch(localDanmuUrl('/api/local-danmu/upload'), { method: 'POST', body: fd });
          const data = await response.json();
          if (!response.ok || !data.success) errorMessage = data.errorMessage || '上传失败';
          else resource = data.resource;
        } catch { errorMessage = '上传失败，请稍后重试'; }
      }
      const count = Number(resource?.count) || 0;
      if (errorMessage) failed++;
      else { succeeded++; totalComments += count; }
      if (item.status) item.status.textContent = errorMessage ? '失败：' + errorMessage : '成功 · ' + count + ' 条弹幕';
      if (!isBatch) s.textContent = errorMessage || (type === 'movie' ? '电影上传成功' : '第' + (resource?.season || season || 1) + '季上传成功') + '，共 ' + count + ' 条弹幕';
    }
    if (isBatch) s.textContent = '批量导入完成：成功 ' + succeeded + ' 个，失败 ' + failed + ' 个，共 ' + totalComments + ' 条弹幕';
    if (succeeded) await loadLocalDanmuList();
  } finally {
    controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
    localDanmuUploading = false;
  }
}
async function deleteLocalDanmu(key) {
  if (localDanmuEditTarget) return;
  if (localDanmuRedisUnavailable()) {
    showLocalDanmuRedisRequired();
    return;
  }
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
async function deleteLocalDanmuGroup(group) {
  if (localDanmuEditTarget) return;
  if (localDanmuRedisUnavailable()) {
    showLocalDanmuRedisRequired();
    return;
  }
  if (!checkLocalDanmuWritePermission('删除')) return;
  const relatedGroups = localDanmuGroups.filter(item => item.title === group.title && item.year === group.year && item.type === group.type);
  const resources = [...new Map(relatedGroups.flatMap(item => item.episodes).map(resource => [resource.resourceKey, resource])).values()];
  if (!confirm('确认删除“' + group.title + '”的全部本地弹幕文件？')) return;
  const status = document.getElementById('local-danmu-upload-status');
  try {
    const responses = await Promise.all(resources.map(resource =>
      fetch(localDanmuUrl('/api/local-danmu/' + encodeURIComponent(resource.resourceKey)), { method: 'DELETE' })
        .then(async response => ({ response, data: await response.json() }))
    ));
    const failed = responses.find(({ response, data }) => !response.ok || !data.success);
    if (failed) { status.textContent = failed.data.errorMessage || '删除失败'; return; }
    status.textContent = '已删除剧集“' + group.title + '”的全部弹幕文件';
    await loadLocalDanmuList();
  } catch { status.textContent = '删除失败，请稍后重试'; }
}
document.addEventListener('DOMContentLoaded', () => {
  initializeLocalDanmuForm();
  updateLocalDanmuPermission();
  loadLocalDanmuList();
});
`;
