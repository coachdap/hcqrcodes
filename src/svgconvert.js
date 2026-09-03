/**
 * SVG → WebP/PNG conversion with a vector-accurate crop.
 *
 * The crop is applied by rewriting the root <svg> viewBox to the chosen
 * rectangle BEFORE rasterising, so the editor in the UI, the artwork bounds
 * reported by /convert/svg/analyze and the exported pixels all share one
 * coordinate system: the SVG's own user units. Moving a crop handle by one unit
 * moves the export by exactly `scale` pixels.
 *
 * Rendering is resvg first (crisp, deterministic, no network access), with
 * sharp's librsvg as a fallback for the handful of documents resvg rejects.
 */
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import {
  svgAnalyzeSchema,
  svgConvertSchema,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS
} from './schema.js';

export const IMAGE_CONTENT_TYPES = {
  webp: 'image/webp',
  png: 'image/png'
};

// Inside the container the only fonts are the ones the Dockerfile installs
// (Liberation + DejaVu); loadSystemFonts picks them up from /usr/share/fonts.
const FONT_OPTIONS = { loadSystemFonts: true };

/**
 * Inspect an SVG without rendering it.
 *
 * @returns {{ width: number, height: number,
 *             canvas: {x,y,width,height}, bbox: {x,y,width,height}|null,
 *             hasText: boolean }}
 *   `width`/`height` are the rendered pixel size at scale 1. `canvas` is the
 *   viewBox (or `0 0 width height` when there is none) and `bbox` the visible
 *   artwork's bounds, stroke included — both in user units.
 */
export function analyzeSvg(input) {
  const { svg } = svgAnalyzeSchema.parse(input);
  const markup = prepareSvg(svg);
  const resvg = parse(markup, { font: FONT_OPTIONS });
  const canvas = canvasOf(markup, resvg);
  return {
    width: resvg.width,
    height: resvg.height,
    canvas,
    bbox: artworkBounds(resvg),
    hasText: /<text\b/i.test(markup)
  };
}

/**
 * @param {object} input  raw, unvalidated request body (see svgConvertSchema)
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string,
 *                    width: number, height: number, bytes: number,
 *                    region: {x,y,width,height}, filename: string, warnings: string[]}>}
 */
export async function convertSvg(input) {
  const opts = svgConvertSchema.parse(input);
  const warnings = [];
  const markup = prepareSvg(opts.svg);

  const probe = parse(markup, { font: FONT_OPTIONS });
  const canvas = canvasOf(markup, probe);

  let region = canvas;
  if (opts.crop === 'artwork') {
    const bbox = artworkBounds(probe);
    // Artwork hanging off the canvas is invisible in a browser, so keep to
    // what the caller can actually see.
    const visible = bbox && intersect(bbox, canvas);
    if (visible) region = visible;
    else warnings.push('no visible artwork was found; the full canvas was exported');
  } else if (opts.crop === 'custom') {
    region = opts.cropRect;
  }

  if (opts.padding > 0) {
    region = {
      x: region.x - opts.padding,
      y: region.y - opts.padding,
      width: region.width + opts.padding * 2,
      height: region.height + opts.padding * 2
    };
  }

  // Always normalise the root viewport, even for a full-canvas export: it turns
  // physical units (mm, in, %) into "one user unit = one pixel at scale 1".
  const working = setRootViewport(markup, region);
  const target = resolveOutputSize(region, opts);

  let png;
  try {
    const resvg = parse(working, {
      fitTo: target.fitTo,
      font: FONT_OPTIONS,
      shapeRendering: 2, // geometric precision
      textRendering: 1, // optimize legibility
      imageRendering: 0 // optimize quality
    });
    png = resvg.render().asPng();
  } catch (err) {
    if (err.code) throw err;
    warnings.push(`resvg could not render this document (${err.message}); librsvg was used instead`);
    png = await renderWithLibrsvg(working, region, target);
  }

  const background = opts.background === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : hexToRgb(opts.background);

  let image = sharp(png, { limitInputPixels: MAX_IMAGE_PIXELS });
  if (opts.width && opts.height) {
    // Both edges fixed: fit inside and letterbox with the background.
    image = image.resize({ width: opts.width, height: opts.height, fit: 'contain', background });
  }
  if (background.alpha === 1) image = image.flatten({ background });

  image =
    opts.format === 'png'
      ? image.png({ compressionLevel: 9 })
      : image.webp({ quality: opts.quality, alphaQuality: opts.quality, lossless: opts.lossless, effort: 4 });

  const { data, info } = await image.toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    contentType: IMAGE_CONTENT_TYPES[opts.format],
    extension: opts.format,
    width: info.width,
    height: info.height,
    bytes: data.length,
    region,
    filename: `${sanitizeFilename(opts.name ?? 'image')}.${opts.format}`,
    warnings
  };
}

// --- helpers ---------------------------------------------------------------

const UNSAFE_ELEMENT_RE = /<\s*(script|iframe|object|embed|foreignObject)\b/i;
const EXTERNAL_HREF_RE = /<\s*([a-zA-Z][\w:-]*)\b[^>]*?\s(?:xlink:)?href\s*=\s*["']\s*(?:https?|file|ftp|javascript):/gi;
const EXTERNAL_URL_RE = /url\(\s*["']?\s*(?:https?|file|ftp):/i;

function prepareSvg(svg) {
  const markup = svg.replace(/^\uFEFF/, '');
  if (!/<svg[\s>]/i.test(markup) || /<\s*(html|body)[\s>]/i.test(markup)) {
    throw httpError(400, 'INVALID_SVG', 'The document does not contain an <svg> root element.');
  }
  if (UNSAFE_ELEMENT_RE.test(markup) || EXTERNAL_URL_RE.test(markup)) {
    throw httpError(400, 'UNSAFE_SVG', 'SVG contains scripts, embedded documents or external resources, which are not rendered.');
  }
  // Links (<a href="https://…">) are harmless — they are never followed when
  // rasterising — but images, fonts, patterns and <use> must not reach out.
  for (const match of markup.matchAll(EXTERNAL_HREF_RE)) {
    if (match[1].toLowerCase() !== 'a') {
      throw httpError(400, 'UNSAFE_SVG', `<${match[1]}> references an external resource; inline it as a data: URI instead.`);
    }
  }
  return markup;
}

function parse(markup, options) {
  try {
    return new Resvg(markup, options);
  } catch (err) {
    throw httpError(422, 'RENDER_FAILED', `Unable to parse this SVG: ${err.message}`);
  }
}

/** The SVG's user-unit coordinate space: its viewBox, or `0 0 w h` without one. */
function canvasOf(markup, resvg) {
  const root = markup.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  const vb = root.match(/\bviewBox\s*=\s*["']\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*["']/i);
  if (vb) {
    const [x, y, width, height] = vb.slice(1).map(Number);
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) return { x, y, width, height };
  }
  return { x: 0, y: 0, width: resvg.width, height: resvg.height };
}

/** Visible artwork bounds including strokes; null for an empty document. */
function artworkBounds(resvg) {
  const box = resvg.getBBox() ?? resvg.innerBBox();
  if (!box) return null;
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x <= 0 || bottom - y <= 0) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Rewrite the root element's viewBox/width/height to `rect`, leaving every
 * other attribute and the artwork untouched. Exported for the acceptance test
 * and mirrored client-side so the preview shows exactly what will render.
 */
export function setRootViewport(markup, rect) {
  const match = markup.match(/<svg\b[^>]*>/i);
  if (!match) return markup;
  let root = match[0];
  root = upsertAttribute(root, 'viewBox', `${num(rect.x)} ${num(rect.y)} ${num(rect.width)} ${num(rect.height)}`);
  root = upsertAttribute(root, 'width', num(rect.width));
  root = upsertAttribute(root, 'height', num(rect.height));
  // preserveAspectRatio can no longer matter once width/height match the
  // viewBox, but a stray "none" or "slice" would still distort; drop it.
  root = root.replace(/\spreserveAspectRatio\s*=\s*("[^"]*"|'[^']*')/i, '');
  return markup.slice(0, match.index) + root + markup.slice(match.index + match[0].length);
}

function upsertAttribute(root, name, value) {
  const escaped = String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const re = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'i');
  if (re.test(root)) return root.replace(re, ` ${name}="${escaped}"`);
  return root.replace(/\s*(\/?)>$/, ` ${name}="${escaped}"$1>`);
}

function num(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * Work out the pixel size resvg should render at. Only one of width/height is
 * ever handed to resvg (it keeps the aspect ratio); when both are given the
 * image is fitted inside and letterboxed afterwards by sharp.
 */
function resolveOutputSize(region, { width, height, scale }) {
  let fitTo;
  let renderWidth;
  let renderHeight;

  if (width && height) {
    const s = Math.min(width / region.width, height / region.height);
    fitTo = { mode: 'zoom', value: s };
    renderWidth = Math.round(region.width * s);
    renderHeight = Math.round(region.height * s);
  } else if (width) {
    fitTo = { mode: 'width', value: width };
    renderWidth = width;
    renderHeight = Math.round((width * region.height) / region.width);
  } else if (height) {
    fitTo = { mode: 'height', value: height };
    renderHeight = height;
    renderWidth = Math.round((height * region.width) / region.height);
  } else {
    fitTo = { mode: 'zoom', value: scale };
    renderWidth = Math.round(region.width * scale);
    renderHeight = Math.round(region.height * scale);
  }

  renderWidth = Math.max(1, renderWidth);
  renderHeight = Math.max(1, renderHeight);

  if (renderWidth > MAX_IMAGE_DIMENSION || renderHeight > MAX_IMAGE_DIMENSION || renderWidth * renderHeight > MAX_IMAGE_PIXELS) {
    throw httpError(
      400,
      'OUTPUT_TOO_LARGE',
      `Output of ${renderWidth}×${renderHeight} px exceeds the ${MAX_IMAGE_DIMENSION} px edge / ${(
        MAX_IMAGE_PIXELS / 1e6
      ).toFixed(0)} MP ceiling. Lower the scale or output size.`,
      { width: renderWidth, height: renderHeight }
    );
  }

  return { fitTo, width: renderWidth, height: renderHeight };
}

async function renderWithLibrsvg(markup, region, target) {
  // librsvg treats one user unit as one CSS px at 72 dpi.
  const density = Math.min(100_000, Math.max(1, (72 * target.width) / region.width));
  try {
    return await sharp(Buffer.from(markup, 'utf8'), { density, limitInputPixels: MAX_IMAGE_PIXELS })
      .resize(target.width, target.height, { fit: 'fill' })
      .png()
      .toBuffer();
  } catch (err) {
    throw httpError(422, 'RENDER_FAILED', `Neither renderer could rasterise this SVG: ${err.message}`);
  }
}

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, alpha };
}

export function sanitizeFilename(name) {
  return (
    String(name)
      .replace(/\.(svg|webp|png)$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'image'
  );
}

function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}
