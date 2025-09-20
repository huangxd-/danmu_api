import { handleRequest } from '../danmu_api/worker.js';

export const onRequest = async (context) => {
  const { request, env } = context;

  // 获取协议和主机名，使用属性访问而非 get 方法
  const baseUrl = `https://localhost`;

  // 调试：打印 headers 和原始 URL
  console.log('Request URL:', request.url);
  console.log('Request Headers:', request.headers);

  // 构造完整的 URL
  let fullUrl;
  try {
    let targetUrl = request.url;

    // 判断是否包含 node-functions/index.js，如果是则用 / 代替
    if (request.url.includes('node-functions/index.js')) {
      targetUrl = '/';
    }

    fullUrl = new URL(targetUrl, baseUrl).toString();
    console.log('Request fullUrl:', fullUrl);
  } catch (error) {
    console.error('URL Construction Error:', error);
    return new Response('Invalid URL', { status: 400 });
  }

  // 创建新的 request 对象，替换 url
  const modifiedRequest = new Request(fullUrl, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(request.body),
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    mode: request.mode
  });

  // 传递修改后的 request 和 env 给 handleRequest
  return await handleRequest(modifiedRequest, env);
};