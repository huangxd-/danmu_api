import { handleRequest } from '../danmu_api/worker.js';

function getClientIp(request) {
  const eoIp = request.headers?.get?.('eo-connecting-ip');
  if (eoIp) return eoIp;

  const forwardedFor = request.headers?.get?.('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();

  return 'unknown';
}

export async function onApiRequest(context) {
  const { request, env } = context;
  return handleRequest(request, env, 'edgeone', getClientIp(request));
}
