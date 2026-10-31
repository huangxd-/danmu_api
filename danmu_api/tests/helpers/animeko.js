// Animeko 镜像域名测试夹具
// 共享测试夹具：文件名不匹配 node --test 的发现规则，不会被当作测试执行。

export const MIRROR_PUBLISH_API = 'https://bangumi.wiki/api/v1/mirrors';

export function publishPayload(mirrors) {
  return { mirrors, meta: { total: mirrors.length } };
}

export function apiMirror(id, weight, hosts, recommended = false) {
  return {
    id,
    name: id,
    url: `https://${hosts[0]}`,
    base: hosts[0],
    weight,
    recommended,
    services: [{ id: 'api', name: 'api', label: 'API', hosts }],
  };
}
