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
    
    let request = context.request;
    
    console.log('Request URL:', request.url);
    console.log('Request Headers:', request.headers);
    
    let fullUrl;
    try {
        let targetUrl = request.url;
        if (request.url.includes('/node-functions/index.js')) {
            targetUrl = '/';
        }
        fullUrl = new URL(targetUrl, context.baseUrl).toString();
        console.log('Request fullUrl:', fullUrl);
    } catch (error) {
        console.error('URL Construction Error:', error);
        return new Response('Invalid URL', { status: 400 });
    }
    
    const modifiedRequest = new Request(fullUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: request.redirect,
        credentials: request.credentials,
        cache: request.cache,
        mode: request.mode
    });
    
    let clientIp = 'unknown';
    clientIp = request.headers['e0-connecting-ip'];
    if (!clientIp) {
        const forwardedFor = request.headers['x-forwarded-for'];
        if (forwardedFor) {
            clientIp = forwardedFor.split(',')[0].trim();
        }
    }
    
    // Redis 缓存逻辑
    const cacheKey = getCacheKey(modifiedRequest);
    
    if (modifiedRequest.method === 'GET' && redis) {
        try {
            const cachedResponse = await redis.get(cacheKey);
            if (cachedResponse) {
                console.log(`Cache HIT: ${cacheKey}`);
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
        }
    }
    
    const response = await handleRequest(modifiedRequest, context.env, "edgeone", clientIp);
    
    if (modifiedRequest.method === 'GET' && redis && response.status === 200) {
        try {
            const responseClone = response.clone();
            const responseBody = await responseClone.text();
            await redis.set(cacheKey, responseBody, { ex: 600 });
            console.log(`Cached: ${cacheKey}`);
        } catch (redisError) {
            console.error('Redis write error:', redisError);
        }
    }
    
    return response;
};
    
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
