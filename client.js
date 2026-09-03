/**
 * Thin HTTP client for qrgen, dependency-free so Hyperframes templates can import
 * it directly. Works against either the internal hostname (no token needed) or the
 * public URL with a bearer token — configured by env var, so the same template code
 * runs in both places.
 *
 *   import { createClient } from 'qrgen/client';
 *   const qrgen = createClient();
 *   const svg = await qrgen.svg({ data: 'https://hoopscollege.com/tryouts' });
 *   element.innerHTML = svg;   // inline vector, no <img> round-trip
 */

const DEFAULT_BASE_URL = 'http://qrgen:3000';

export function createClient(options = {}) {
  const baseUrl = (options.baseUrl ?? process.env.QRGEN_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const token = options.token ?? process.env.QRGEN_TOKEN ?? null;
  const timeoutMs = options.timeoutMs ?? Number(process.env.QRGEN_TIMEOUT_MS ?? 15000);

  async function request(pathname, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) message = `${payload.error.message} (${payload.error.code})`;
      } catch {
        /* non-JSON error body; keep the status line */
      }
      throw Object.assign(new Error(`qrgen: ${message}`), { status: response.status });
    }

    const warning = response.headers.get('x-qr-warning');
    return {
      response,
      version: Number(response.headers.get('x-qr-version')),
      ecLevel: response.headers.get('x-qr-ec-level'),
      warnings: warning ? warning.split(' | ') : []
    };
  }

  /** Full result: `data` is a string for SVG, a Uint8Array for PNG. */
  async function generate(options) {
    const { response, ...meta } = await request('/generate', options);
    const isSvg = (options.format ?? 'svg') === 'svg';
    return { ...meta, data: isSvg ? await response.text() : new Uint8Array(await response.arrayBuffer()) };
  }

  /** SVG markup, ready to assign to innerHTML. */
  async function svg(options) {
    const { response } = await request('/generate', { ...options, format: 'svg' });
    return response.text();
  }

  async function png(options) {
    const { response } = await request('/generate', { ...options, format: 'png' });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** SVG as a data URI, for cases where an <img src> is easier than inlining. */
  async function svgDataUri(options) {
    const markup = await svg(options);
    return `data:image/svg+xml;base64,${base64(markup)}`;
  }

  async function wifi(options) {
    const { response, ...meta } = await request('/generate/wifi', options);
    const isSvg = (options.format ?? 'svg') === 'svg';
    return { ...meta, data: isSvg ? await response.text() : new Uint8Array(await response.arrayBuffer()) };
  }

  async function vcard(options) {
    const { response, ...meta } = await request('/generate/vcard', options);
    const isSvg = (options.format ?? 'svg') === 'svg';
    return { ...meta, data: isSvg ? await response.text() : new Uint8Array(await response.arrayBuffer()) };
  }

  /** Zip archive bytes. */
  async function batch(options) {
    const { response } = await request('/generate/batch', options);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * SVG → WebP/PNG bytes (the utilities endpoint). `svg` is the markup string;
   * the other options match POST /convert/svg. Returns
   * `{ data, width, height, warnings }` with `data` a Uint8Array.
   */
  async function convertSvg(options) {
    const { response } = await request('/convert/svg', options);
    const warning = response.headers.get('x-image-warning');
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      width: Number(response.headers.get('x-image-width')),
      height: Number(response.headers.get('x-image-height')),
      warnings: warning ? warning.split(' | ') : []
    };
  }

  async function health() {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`qrgen: health check failed (${response.status})`);
    return response.json();
  }

  return { baseUrl, generate, svg, svgDataUri, png, wifi, vcard, batch, convertSvg, health };
}

function base64(text) {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  return btoa(unescape(encodeURIComponent(text)));
}

export default createClient;
