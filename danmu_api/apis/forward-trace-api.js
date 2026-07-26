import { jsonResponse } from '../utils/http-util.js';
import { globals } from '../configs/globals.js';

export const FORWARD_TRACE_LIMITS = Object.freeze({
  maxPayloadBytes: 64 * 1024,
});

function payloadByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

function appendForwardRemoteLog(handler, level, message, timestamp = new Date().toISOString()) {
  const normalizedLevel = ['info', 'warn', 'error'].includes(level) ? level : 'info';
  const formattedMessage = `[ForwardRemote][${handler}] ${String(message || '')}`;
  globals.logBuffer.push({ timestamp, level: normalizedLevel, message: formattedMessage });
  if (globals.logBuffer.length > globals.MAX_LOGS) globals.logBuffer.shift();
  console[normalizedLevel](formattedMessage);
}

function formatTraceValue(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_) {
    return '"[unserializable]"';
  }
}

function appendForwardTraceEvent(payload, handler) {
  const eventType = String(payload.eventType || 'handlerComplete');
  const durationMs = Number(payload.durationMs) || 0;

  if (eventType === 'logBatch') {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    logs.slice(0, 50).forEach((entry) => {
      appendForwardRemoteLog(
        handler,
        entry?.level,
        entry?.message,
        entry?.timestamp || new Date().toISOString()
      );
    });
    return logs.length;
  }

  if (eventType === 'handlerStart') {
    appendForwardRemoteLog(handler, 'info', `START params=${formatTraceValue(payload.params || {})}`, payload.timestamp);
    return 1;
  }

  const level = payload.status === 'error' ? 'error' : 'info';
  const detail = payload.status === 'error'
    ? `error=${formatTraceValue(payload.error)}`
    : `result=${formatTraceValue(payload.result)}`;
  appendForwardRemoteLog(
    handler,
    level,
    `COMPLETE status=${payload.status || 'unknown'} duration=${durationMs}ms ${detail}`,
    payload.timestamp
  );
  return 1;
}

export async function handleForwardTrace(req) {
  const body = await req.text();
  if (payloadByteLength(body) > FORWARD_TRACE_LIMITS.maxPayloadBytes) {
    return jsonResponse({ success: false, errorMessage: 'Forward trace payload is too large' }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (_) {
    return jsonResponse({ success: false, errorMessage: 'Invalid JSON payload' }, 400);
  }

  const handler = String(payload?.handler || '').trim();
  if (!handler || handler.length > 64) {
    return jsonResponse({ success: false, errorMessage: 'handler is required' }, 400);
  }

  const logCount = appendForwardTraceEvent(payload, handler);
  return jsonResponse({ success: true, logCount }, 202);
}
