/** Coalesce verification per configuration and ignore stale completions. */
export function createAiVerifier({ verify, onStatus, onError = () => {}, now = Date.now, retryIntervalMs = 5 * 60 * 1000 }) {
  let configuration = '';
  let generation = 0;
  let pending = null;
  let valid = false;
  let lastAttempt = null;

  return function schedule(config) {
    const key = JSON.stringify([config.baseURL, config.model, config.apiKey]);
    if (key !== configuration) {
      configuration = key;
      generation++;
      pending = null;
      valid = false;
      lastAttempt = null;
      onStatus(false);
    }
    if (!config.baseURL || !config.model || !config.apiKey) return null;
    if (pending) return pending;
    if (valid || (lastAttempt !== null && now() - lastAttempt < retryIntervalMs)) return null;
    lastAttempt = now();
    const attempt = generation;
    pending = Promise.resolve().then(() => verify(config)).then(result => {
      if (attempt !== generation) return;
      valid = result.ok === true;
      onStatus(valid);
      if (!valid) onError(result.error || 'AI verification failed');
    }).catch(error => {
      if (attempt !== generation) return;
      onStatus(false);
      onError(error.message);
    }).finally(() => {
      if (attempt === generation) pending = null;
    });
    return pending;
  };
}
