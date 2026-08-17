import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SVG_MIME = 'image/svg+xml';

function badLogo(message, extra = {}) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_LOGO', ...extra });
}

/** Identify an image from its magic bytes so we never trust a caller-supplied extension. */
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';

  const head = buf.subarray(0, 1024).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return SVG_MIME;
  return null;
}

/**
 * Resolve a logo supplied as a data URI, a bare base64 string, or a file path.
 *
 * `allowedDir` confines filesystem reads for requests arriving over HTTP; the CLI
 * passes `allowedDir: null` to read any local path the operator names.
 */
export async function loadLogo(input, { allowedDir } = {}) {
  if (!input) return null;

  let buffer;

  if (input.startsWith('data:')) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input);
    if (!match) throw badLogo('logo looks like a data URI but could not be parsed');
    buffer = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  } else if (looksLikePath(input)) {
    const resolved = path.resolve(input);
    if (allowedDir) {
      const root = path.resolve(allowedDir);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw badLogo(
          `logo file paths are restricted to ${root}. Supply the logo as base64 instead, or place it in that directory.`,
          { code: 'LOGO_PATH_DENIED' }
        );
      }
    }
    try {
      buffer = await readFile(resolved);
    } catch (err) {
      throw badLogo(`could not read logo file: ${resolved} (${err.code ?? err.message})`);
    }
  } else {
    buffer = Buffer.from(input, 'base64');
    if (buffer.length === 0) throw badLogo('logo could not be decoded as base64');
  }

  const mime = sniff(buffer);
  if (!mime) throw badLogo('logo is not a recognised image (expected SVG, PNG, JPEG, WebP or GIF)');

  return { buffer, mime, isVector: mime === SVG_MIME };
}

function looksLikePath(value) {
  if (value.includes('\n')) return false;
  if (value.length > 4096) return false;
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /\.(svg|png|jpe?g|webp|gif)$/i.test(value);
}
