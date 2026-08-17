import net from 'node:net';

const PRIVATE_V4 = [
  [10, 0, 0, 0, 8],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [127, 0, 0, 0, 8]
];

function isPrivateAddress(address) {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice(7) : address;

  if (net.isIPv4(addr)) {
    const octets = addr.split('.').map(Number);
    return PRIVATE_V4.some(([a, b, c, d, bits]) => {
      const mask = bits === 8 ? [255, 0, 0, 0] : bits === 12 ? [255, 240, 0, 0] : [255, 255, 0, 0];
      const net4 = [a, b, c, d];
      return octets.every((o, i) => (o & mask[i]) === (net4[i] & mask[i]));
    });
  }

  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    // loopback, unique-local (fc00::/7) and link-local (fe80::/10)
    return lower === '::1' || /^f[cd]/.test(lower) || lower.startsWith('fe80');
  }

  return false;
}

/**
 * A request counts as internal only when it did NOT traverse the public proxy.
 * Apache's mod_proxy_http always stamps X-Forwarded-For, so its presence means the
 * request came in from outside and must carry the bearer token.
 *
 * Note the trust boundary this creates: any container attached to hc-internal can
 * call /generate without a token. That is the intended trade, but it means the
 * Docker network is the security perimeter.
 */
export function isInternalRequest(req) {
  if (req.headers['x-forwarded-for']) return false;
  return isPrivateAddress(req.socket.remoteAddress);
}

export function bearerAuth({ token, trustInternal }) {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';

    // A supplied credential is always verified, even from an internal source.
    // Without this, a caller presenting a WRONG token would be waved through by
    // the internal bypass below — including anything reaching the published
    // loopback port, which is what the public proxy forwards to.
    if (header) {
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token || !supplied || !timingSafeEqual(supplied, token)) {
        return next(
          Object.assign(new Error('Missing or invalid bearer token.'), {
            status: 401,
            code: 'UNAUTHORIZED'
          })
        );
      }
      req.callerScope = 'external';
      return next();
    }

    if (trustInternal && isInternalRequest(req)) {
      req.callerScope = 'internal';
      return next();
    }

    if (!token) {
      return next(
        Object.assign(new Error('QRGEN_TOKEN is not configured, so external requests cannot be authenticated.'), {
          status: 503,
          code: 'AUTH_NOT_CONFIGURED'
        })
      );
    }

    // No credential supplied and the source is not internal.
    next(
      Object.assign(new Error('Missing or invalid bearer token.'), {
        status: 401,
        code: 'UNAUTHORIZED'
      })
    );
  };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export { isPrivateAddress };
