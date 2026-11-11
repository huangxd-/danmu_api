import { AsyncLocalStorage } from 'node:async_hooks';

// Authentication and deployment metadata belong to a request, not the shared caches.
export const requestContext = new AsyncLocalStorage();

export function runWithRequestContext(task) {
  return requestContext.run({ currentToken: '', deployPlatform: '' }, task);
}
