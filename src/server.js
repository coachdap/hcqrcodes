import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import archiver from 'archiver';
import { z } from 'zod';
import { generate } from './core.js';
import { buildWifiPayload, buildVcardPayload } from './payloads.js';
import { wifiRequestSchema, vcardRequestSchema, batchSchema } from './schema.js';
import { bearerAuth, isInternalRequest } from './auth.js';
import { rateLimit } from './ratelimit.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const TOKEN = process.env.QRGEN_TOKEN ?? '';
const TRUST_INTERNAL = (process.env.QRGEN_TRUST_INTERNAL ?? 'true') !== 'false';
const LOGO_DIR = process.env.QRGEN_LOGO_DIR ?? '/output/logos';
const BODY_LIMIT = process.env.QRGEN_BODY_LIMIT ?? '10mb';

const UI_HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html'),
  'utf8'
);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: BODY_LIMIT }));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'qrgen', uptime: Math.round(process.uptime()) });
  });

  const ui = (req, res) => res.type('html').send(UI_HTML);
  app.get('/ui', ui);

  // Lets the UI show or hide its token field without generating a throwaway QR.
  app.get('/auth', (req, res) => {
    const internal = isInternalRequest(req);
    res.json({ scope: internal ? 'internal' : 'external', tokenRequired: !(TRUST_INTERNAL && internal) });
  });

  // The UI lives only at /ui so that a Cloudflare Access policy can protect it by
  // path prefix without also covering the API routes. Browsers are redirected
  // there; API clients (curl sends Accept: */*) still get the JSON index here.
  app.get('/', (req, res) => {
    if ((req.headers.accept ?? '').includes('text/html')) return res.redirect(302, '/ui');
    res.json({
      service: 'qrgen',
      description: 'QR code generation for Hoops College and Chase Excellence.',
      docs: 'https://github.com/coachdap/hcqrcodes',
      ui: 'https://qr.hoopscollege.com/ui',
      note: 'All generation endpoints are POST with a JSON body. GET returns 405.',
      auth: 'Bearer token required for external callers; callers on hc-internal are exempt.',
      endpoints: {
        'GET  /health': 'liveness, no auth',
        'POST /generate': 'core generator — { data, format, size, margin, ecLevel, dark, light, logo, logoScale }',
        'POST /generate/wifi': '{ ssid, password, encryption, hidden } + render options',
        'POST /generate/vcard': '{ name, org, title, phone, email, url } + render options',
        'POST /generate/batch': '{ items: [...], format } — returns a zip'
      }
    });
  });

  const auth = bearerAuth({ token: TOKEN, trustInternal: TRUST_INTERNAL });
  // Limiter precedes auth so floods are shed before any real work is done.
  const guard = [rateLimit(), auth];

  app.post('/generate', guard, async (req, res, next) => {
    try {
      send(res, await generate(req.body ?? {}, { allowedLogoDir: LOGO_DIR }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/generate/wifi', guard, async (req, res, next) => {
    try {
      const { ssid, password, encryption, hidden, ...render } = wifiRequestSchema.parse(req.body ?? {});
      const data = buildWifiPayload({ ssid, password, encryption, hidden });
      send(res, await generate({ ...render, data }, { allowedLogoDir: LOGO_DIR }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/generate/vcard', guard, async (req, res, next) => {
    try {
      const { name, org, title, phone, email, url, ...render } = vcardRequestSchema.parse(req.body ?? {});
      const data = buildVcardPayload({ name, org, title, phone, email, url });
      send(res, await generate({ ...render, data }, { allowedLogoDir: LOGO_DIR }));
    } catch (err) {
      next(err);
    }
  });

  app.post('/generate/batch', guard, async (req, res, next) => {
    try {
      const { items, format } = batchSchema.parse(req.body ?? {});

      // Render everything before streaming, so one bad item fails the whole
      // request cleanly instead of producing a half-written zip.
      const results = [];
      for (const [index, item] of items.entries()) {
        const { name, ...options } = item;
        try {
          const result = await generate(
            { ...options, format: options.format ?? format ?? 'svg' },
            { allowedLogoDir: LOGO_DIR }
          );
          results.push({ name, index, result });
        } catch (err) {
          err.message = `items[${index}]: ${err.message}`;
          throw err;
        }
      }

      const used = new Set();
      const manifest = results.map(({ name, index, result }) => {
        const base = sanitizeFilename(name ?? `qr-${String(index + 1).padStart(3, '0')}`);
        let filename = `${base}.${result.extension}`;
        let n = 2;
        while (used.has(filename)) filename = `${base}-${n++}.${result.extension}`;
        used.add(filename);
        return {
          filename,
          version: result.version,
          ecLevel: result.ecLevel,
          bytes: result.bytes,
          warnings: result.warnings
        };
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="qrgen-batch.zip"');

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', next);
      archive.pipe(res);

      results.forEach(({ result }, i) => archive.append(result.buffer, { name: manifest[i].filename }));
      archive.append(JSON.stringify({ count: manifest.length, items: manifest }, null, 2), {
        name: 'manifest.json'
      });
      await archive.finalize();
    } catch (err) {
      next(err);
    }
  });

  const POST_ROUTES = ['/generate', '/generate/wifi', '/generate/vcard', '/generate/batch'];

  app.use((req, res) => {
    // Right path, wrong method — say so, rather than implying the endpoint is missing.
    if (POST_ROUTES.includes(req.path)) {
      return res.status(405).set('Allow', 'POST').json({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `${req.path} accepts POST, not ${req.method}. Send a JSON body; see GET / for the endpoint list.`
        }
      });
    }
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.path}. See GET / for the endpoint list.`
      }
    });
  });

  app.use((err, req, res, _next) => {
    if (res.headersSent) return res.end();

    if (err instanceof z.ZodError) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request body failed validation.',
          details: err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }))
        }
      });
    }

    const status = err.status ?? 500;
    if (status >= 500) console.error('[qrgen]', err);

    res.status(status).json({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: status >= 500 ? 'Internal error generating QR code.' : err.message,
        ...(err.details ? { details: err.details } : {})
      }
    });
  });

  return app;
}

function send(res, result) {
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Length', result.buffer.length);
  res.setHeader('X-QR-Version', String(result.version));
  res.setHeader('X-QR-EC-Level', result.ecLevel);
  if (result.warnings.length) res.setHeader('X-QR-Warning', result.warnings.join(' | '));
  res.status(200).end(result.buffer);
}

function sanitizeFilename(name) {
  return (
    String(name)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'qr'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, HOST, () => {
    console.log(`[qrgen] listening on ${HOST}:${PORT}`);
    console.log(`[qrgen] internal callers trusted: ${TRUST_INTERNAL}; token configured: ${Boolean(TOKEN)}`);
  });
}
