import { handleRequest } from '../danmu_api/worker.js';

export async function onRequest(context) {  // 修改为 onRequest 以支持所有请求类型
    try {
        const url = new URL(context.request.url);
        console.log('Request path:', url.pathname);  // 调试：日志中查看路径是否到达

        const workerResponse = await handleRequest(context.request, context.env, context);
        console.log('Worker response status:', workerResponse.status);  // 调试 worker 返回

        return workerResponse;
    } catch (error) {
        console.error('Error in index.js:', error);  // 调试错误
        return new Response(JSON.stringify({ error: `处理失败: ${error.message}` }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        });
    }
}