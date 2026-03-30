import { onRequest } from './index.js'; // 改为 onRequest，支持所有方法

export const onRequestGet    = onRequest;
export const onRequestPost   = onRequest;
export const onRequestPut    = onRequest;
export const onRequestPatch  = onRequest;
export const onRequestDelete = onRequest;
export { onRequest }; // 复用 index.js 的 onRequest