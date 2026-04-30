import { handleRequest } from '../danmu_api/worker.js';
import { Redis } from '@upstash/redis';

// 初始化 Redis（自动读取 Vercel 环境变量）
let redis = null;
try {
    redis = Redis.fromEnv();
    console.log('Redis initialized successfully');
} catch (error) {
    console.log('Redis not available, running without cache');
}

// 生成缓存键
function getCacheKey(request) {
    const url = new URL(request.url);
    return `danmu:${url.pathname}${url.search}`;
}

export const onRequest = async (context) => {
    context.fetch = fetch;
    context.baseUrl = 'https://localhost';
    
    // 获取请求对象
    let request = context.request;
    
    // 调试：打印 headers 和原始 URL
    console.log('Request URL:', request.url);
    console.log('Request Headers:', request.headers);
    
    // 构造完整的 URL
    let fullUrl;
    try {
        let targetUrl = request.url;
        
        // 判断是否包含 node-functions/index.js，如果是则用 /代替
        if (request.url.includes('/node-functions/index.js')) {
            targetUrl = '/';
        }
        
        fullUrl = new URL(targetUrl, context.baseUrl).toString();
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
    
    // 获取客户端 IP 地址
    let clientIp = 'unknown';
    clientIp = request.headers['e0-connecting-ip'];
    if (!clientIp) {
        const forwardedFor = request.headers['x-forwarded-for'];
        if (forwardedFor) {
            clientIp = forwardedFor.split(',')[0].trim();
        }
    }
    
    // ========== Redis 缓存逻辑 ==========
    const cacheKey = getCacheKey(modifiedRequest);
    
    // 只对 GET 请求进行缓存（弹幕获取通常是 GET 请求）
    if (modifiedRequest.method === 'GET' && redis) {
        try {
            // 尝试从 Redis 读取缓存
            const cachedResponse = await redis.get(cacheKey);
            
            if (cachedResponse) {
                console.log(`Cache HIT: ${cacheKey}`);
                // 缓存命中，返回缓存的数据
                const data = JSON.parse(cachedResponse);
                return new Response(JSON.stringify(data), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Cache': 'HIT'
                    }
                });
            }
            
            console.log(`Cache MISS: ${cacheKey}`);
        } catch (redisError) {
            console.error('Redis read error:', redisError);
            // Redis 出错时继续执行原有逻辑（降级）
        }
    }
    
    // ========== 执行原有逻辑获取弹幕 ==========
    const response = await handleRequest(modifiedRequest, context.env, "edgeone", clientIp);
    
    // ========== 将结果存入 Redis 缓存（仅限成功的 GET 请求） ==========
    if (modifiedRequest.method === 'GET' && redis && response.status === 200) {
        try {
            // 获取响应的 body 内容
            const responseClone = response.clone();
            const responseBody = await responseClone.text();
            
            // 存入 Redis，过期时间 600 秒（10分钟）
            await redis.set(cacheKey, responseBody, { ex: 600 });
            console.log(`Cached: ${cacheKey}`);
        } catch (redisError) {
            console.error('Redis write error:', redisError);
        }
    }
    
    return response;
};
