const IPV6_UNAVAILABLE_ERROR_CODES = new Set([
  'EAFNOSUPPORT',
  'EADDRNOTAVAIL'
]);

function listenOnce(server, options) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onListening = () => {
      cleanup();
      resolve(server.address());
    };

    server.once('error', onError);

    try {
      server.listen(options, onListening);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function createBinding(address, requestedHost, requestedPort, fallback) {
  if (address && typeof address === 'object') {
    return {
      address: address.address,
      family: address.family,
      port: address.port,
      fallback
    };
  }

  return {
    address: requestedHost,
    family: requestedHost === '::' ? 'IPv6' : 'IPv4',
    port: requestedPort,
    fallback
  };
}

/**
 * Listen on all IPv6 and IPv4 interfaces through a dual-stack IPv6 socket.
 * IPv4-only environments fall back to 0.0.0.0, while unrelated bind errors
 * are propagated to the caller.
 */
export async function listenOnAllInterfaces(server, port, options = {}) {
  const logger = options.logger || console;
  const serviceName = options.serviceName || 'server';

  try {
    const address = await listenOnce(server, {
      port,
      host: '::',
      ipv6Only: false
    });
    return createBinding(address, '::', port, false);
  } catch (error) {
    if (!IPV6_UNAVAILABLE_ERROR_CODES.has(error?.code)) {
      throw error;
    }

    logger.warn(
      `[server] ${serviceName} cannot bind to IPv6 (${error.code}); falling back to IPv4`
    );
    const address = await listenOnce(server, {
      port,
      host: '0.0.0.0'
    });
    return createBinding(address, '0.0.0.0', port, true);
  }
}

export function formatHostForUrl(host) {
  return String(host).includes(':') ? `[${host}]` : String(host);
}
