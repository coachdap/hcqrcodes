import { isInternalRequest } from './auth.js';

/**
 * Dependency-free sliding-window rate limiter.
 *
 * Runs *before* authentication so that unauthenticated floods are shed cheaply
 * rather than after TLS and body parsing have already been paid for.
 *
 * Cost is weighted: generation is CPU-bound (sharp compositing), and a 200-item
 * batch is two hundred times the work of a single QR, so it is charged as such.
 */

const WINDOW_MS = Number(process.env.QRGEN_RATE_WINDOW_MS ?? 60_000);

// Defaults exceed MAX_BATCH_ITEMS (200) so that a single full-size batch, which
// costs one unit per item, always fits inside one window.
const LIMIT_EXTERNAL = Number(process.env.QRGEN_RATE_LIMIT ?? 300);
const LIMIT_INTERNAL = Number(process.env.QRGEN_RATE_LIMIT_INTERNAL ?? 1200);

// Bound memory even if a flood arrives from many distinct addresses.
const MAX_KEYS = Number(process.env.QRGEN_RATE_MAX_KEYS ?? 10_000);

const buckets = new Map();

/**
 * Identify the caller. Behind Cloudflare, CF-Connecting-IP is set by the edge and
 * any client-supplied copy is stripped, so it is trustworthy where X-Forwarded-For
 * (which a client can prepend to) is not.
 */
function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return `cf:${cf}`;

  const xff = req.headers['x-forwarded-for'];
  if (xff) return `xff:${String(xff).split(',')[0].trim()}`;

  return `sock:${req.socket.remoteAddress ?? 'unknown'}`;
}

function costOf(req) {
  const items = req.body?.items;
  if (Array.isArray(items)) return Math.max(1, items.length);
  return 1;
}

function prune(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.reset <= now) buckets.delete(key);
  }
  // Still oversized after pruning expired windows: drop the oldest entries.
  if (buckets.size > MAX_KEYS) {
    const excess = buckets.size - MAX_KEYS;
    let dropped = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

/**
 * @param {object} [opts]
 * @param {'pre'|'post'} [opts.phase]
 *   'pre'  — runs before the body is parsed, so it can only charge a flat unit.
 *            This is the phase that actually sheds floods, since parsing a large
 *            body is the expensive part and must not happen first.
 *   'post' — runs after parsing and charges the remainder for multi-item batches,
 *            which cost one unit per QR.
 */
export function rateLimit({ phase = 'pre' } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    if (buckets.size > MAX_KEYS / 2) prune(now);

    const limit = isInternalRequest(req) ? LIMIT_INTERNAL : LIMIT_EXTERNAL;
    const key = clientKey(req);
    // The pre phase already charged one unit for this request.
    const cost = phase === 'pre' ? 1 : Math.max(0, costOf(req) - 1);

    if (cost === 0) return next();

    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + WINDOW_MS };
      buckets.set(key, bucket);
    }

    const resetSeconds = Math.max(1, Math.ceil((bucket.reset - now) / 1000));

    if (bucket.count + cost > limit) {
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', Math.max(0, limit - bucket.count));
      res.setHeader('RateLimit-Reset', resetSeconds);
      res.setHeader('Retry-After', resetSeconds);
      return next(
        Object.assign(
          new Error(
            `Rate limit exceeded: ${limit} units per ${Math.round(WINDOW_MS / 1000)}s. ` +
              `This request costs ${cost}. Retry in ${resetSeconds}s.`
          ),
          { status: 429, code: 'RATE_LIMITED' }
        )
      );
    }

    bucket.count += cost;
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - bucket.count));
    res.setHeader('RateLimit-Reset', resetSeconds);
    next();
  };
}

/** Exposed for tests. */
export function _reset() {
  buckets.clear();
}
