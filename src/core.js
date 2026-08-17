import QRCode from 'qrcode';
import { generateSchema, resolveEcLevel, assertCapacity, MAX_LOGO_SCALE } from './schema.js';
import { loadLogo } from './logo.js';
import { renderSvg } from './svg.js';
import { renderPng } from './png.js';

export const CONTENT_TYPES = {
  svg: 'image/svg+xml; charset=utf-8',
  png: 'image/png'
};

/**
 * The single generator. Every entry point — /generate, the helper endpoints,
 * /generate/batch and the CLI — funnels through here so validation, the forced
 * ecLevel and the logo rules behave identically everywhere.
 *
 * @param {object} input   raw, unvalidated request body
 * @param {object} [ctx]
 * @param {string|null} [ctx.allowedLogoDir]  confine logo file reads to this directory
 *                                            (pass null to allow any path, as the CLI does)
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string,
 *                    version: number, ecLevel: string, warnings: string[], bytes: number}>}
 */
export async function generate(input, { allowedLogoDir } = {}) {
  const parsed = generateSchema.parse(input);
  const warnings = [];

  const ecLevel = resolveEcLevel(parsed);
  if (parsed.logo && parsed.ecLevel && parsed.ecLevel !== 'H') {
    warnings.push(`ecLevel raised from ${parsed.ecLevel} to H because a logo was supplied`);
  }

  let logoScale = parsed.logoScale;
  if (logoScale > MAX_LOGO_SCALE) {
    warnings.push(`logoScale capped at ${MAX_LOGO_SCALE} (requested ${logoScale})`);
    logoScale = MAX_LOGO_SCALE;
  }

  assertCapacity(parsed.data, ecLevel);

  const logo = parsed.logo ? await loadLogo(parsed.logo, { allowedDir: allowedLogoDir }) : null;

  // One matrix, one version — shared by both renderers and the X-QR-Version header.
  const qr = QRCode.create(parsed.data, { errorCorrectionLevel: ecLevel });

  const shared = {
    matrix: qr.modules,
    margin: parsed.margin,
    dark: parsed.dark,
    light: parsed.light,
    logo,
    logoScale
  };

  if (parsed.format === 'svg') {
    const { svg, warnings: svgWarnings } = renderSvg({ ...shared, size: parsed.size });
    warnings.push(...svgWarnings);
    return {
      buffer: Buffer.from(svg, 'utf8'),
      contentType: CONTENT_TYPES.svg,
      extension: 'svg',
      version: qr.version,
      ecLevel,
      warnings,
      bytes: Buffer.byteLength(svg, 'utf8')
    };
  }

  const { buffer, warnings: pngWarnings } = await renderPng({
    ...shared,
    data: parsed.data,
    version: qr.version,
    ecLevel,
    size: parsed.size
  });
  warnings.push(...pngWarnings);

  return {
    buffer,
    contentType: CONTENT_TYPES.png,
    extension: 'png',
    version: qr.version,
    ecLevel,
    warnings,
    bytes: buffer.length
  };
}

export { buildWifiPayload, buildVcardPayload } from './payloads.js';
export { BYTE_CAPACITY, MAX_LOGO_SCALE } from './schema.js';
