/**
 * Raster image tools on sharp: format conversion, compression (which also
 * strips EXIF — GPS included — from phone photos), social-media size packs and
 * favicon packs.
 */
import sharp from 'sharp';
import { assertSafeSvg } from '../svgconvert.js';
import { httpError, stem, hexToRgb } from './common.js';

const MAX_PIXELS = 60_000_000;
const MAX_EDGE = 8192;

const CONTENT_TYPES = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
};
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif' };

export const contentTypeFor = (format) => CONTENT_TYPES[format];

function isSvg(file) {
  return file.mimetype === 'image/svg+xml' || /\.svg$/i.test(file.originalname ?? '');
}

/**
 * Open an upload as a sharp pipeline, EXIF-rotated, with SVG rasterised
 * densely enough that `targetEdge` pixels come out crisp rather than upscaled.
 */
async function open(file, { targetEdge = 2048 } = {}) {
  let input = file.buffer;
  const options = { limitInputPixels: MAX_PIXELS, failOn: 'none' };

  if (isSvg(file)) {
    const markup = assertSafeSvg(input.toString('utf8'));
    input = Buffer.from(markup, 'utf8');
    const meta = await sharp(input).metadata().catch(() => null);
    const longest = Math.max(meta?.width ?? 0, meta?.height ?? 0) || 300;
    options.density = Math.min(2400, Math.max(72, (72 * targetEdge) / longest));
  }

  try {
    const image = sharp(input, options);
    const meta = await image.metadata();
    return { image: image.rotate(), meta };
  } catch (err) {
    if (/heif|heic/i.test(err.message) || /\.hei[cf]$/i.test(file.originalname ?? '')) {
      throw httpError(
        415,
        'UNSUPPORTED_FILE',
        'HEIC photos cannot be decoded here. On iPhone, set Settings → Camera → Formats → Most Compatible, or share/export the photo as JPEG first.'
      );
    }
    throw httpError(422, 'UNREADABLE_IMAGE', `"${file.originalname}" could not be read as an image.`);
  }
}

function encode(image, format, { quality = 82, lossless = false, background } = {}) {
  if (format === 'jpeg') {
    // JPEG has no alpha: flatten onto the background (white by default).
    return image.flatten({ background: background ?? '#FFFFFF' }).jpeg({ quality, mozjpeg: true, chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0' });
  }
  if (background) image = image.flatten({ background });
  if (format === 'png') return image.png({ compressionLevel: 9, effort: 8, palette: !lossless && quality < 100, quality });
  if (format === 'webp') return image.webp({ quality, lossless, effort: 5, smartSubsample: true });
  if (format === 'avif') return image.avif({ quality: Math.max(1, quality - 20), lossless, effort: 4 });
  throw httpError(400, 'BAD_FORMAT', `Unsupported output format "${format}".`);
}

function checkSize(width, height) {
  if (width > MAX_EDGE || height > MAX_EDGE) {
    throw httpError(400, 'OUTPUT_TOO_LARGE', `Output is limited to ${MAX_EDGE}px per side.`);
  }
}

// --- convert -------------------------------------------------------------------

/**
 * @param {object} opts  { format, quality, width, height, fit: 'inside'|'cover'|'contain', background, lossless }
 */
export async function convertImage(file, opts) {
  const { width, height } = opts;
  if (width || height) checkSize(width ?? 0, height ?? 0);
  const { image, meta } = await open(file, { targetEdge: Math.max(width ?? 0, height ?? 0) || 2048 });

  let pipeline = image;
  if (width || height) {
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      fit: opts.fit ?? 'inside',
      withoutEnlargement: !isSvg(file) && (opts.fit ?? 'inside') === 'inside',
      position: sharp.strategy.attention,
      background: opts.background ?? { r: 0, g: 0, b: 0, alpha: 0 }
    });
  }
  const background = opts.format === 'jpeg' ? opts.background ?? '#FFFFFF' : opts.background;
  const { data, info } = await encode(pipeline, opts.format, { quality: opts.quality, lossless: opts.lossless, background }).toBuffer({
    resolveWithObject: true
  });
  return {
    buffer: data,
    contentType: CONTENT_TYPES[opts.format],
    filename: `${stem(file.originalname, 'image')}.${EXT[opts.format]}`,
    width: info.width,
    height: info.height,
    originalWidth: meta.width,
    originalHeight: meta.height
  };
}

// --- compress ------------------------------------------------------------------

/**
 * Re-encode for the web: optional long-edge cap, metadata stripped (sharp never
 * copies EXIF unless asked), orientation baked in.
 *
 * @param {object} opts  { quality, maxEdge, format: 'same'|'jpeg'|'webp'|'avif' }
 */
export async function compressImage(file, opts) {
  const { image, meta } = await open(file, { targetEdge: opts.maxEdge || 2048 });

  let format = opts.format;
  if (format === 'same') {
    const src = meta.format;
    if (src === 'jpeg' || src === 'png' || src === 'webp' || src === 'avif') format = src;
    else format = meta.hasAlpha ? 'png' : 'jpeg';
  }

  let pipeline = image;
  if (opts.maxEdge) {
    pipeline = pipeline.resize({ width: opts.maxEdge, height: opts.maxEdge, fit: 'inside', withoutEnlargement: true });
  }

  const { data, info } = await encode(pipeline, format, { quality: opts.quality }).toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    contentType: CONTENT_TYPES[format],
    filename: `${stem(file.originalname, 'photo')}.${EXT[format]}`,
    width: info.width,
    height: info.height,
    originalBytes: file.size ?? file.buffer.length,
    hadMetadata: Boolean(meta.exif || meta.xmp || meta.iptc),
    hadLocation: hasGps(meta.exif)
  };
}

/**
 * True when the EXIF block has a non-empty GPS IFD. GPS data is binary, so
 * look for IFD0's GPSInfo pointer (tag 0x8825) rather than any text.
 */
function hasGps(exif) {
  try {
    if (!exif || exif.length < 14) return false;
    const base = exif.toString('latin1', 0, 4) === 'Exif' ? 6 : 0;
    const le = exif.toString('latin1', base, base + 2) === 'II';
    const u16 = (o) => (le ? exif.readUInt16LE(base + o) : exif.readUInt16BE(base + o));
    const u32 = (o) => (le ? exif.readUInt32LE(base + o) : exif.readUInt32BE(base + o));
    const ifd0 = u32(4);
    const count = u16(ifd0);
    for (let i = 0; i < count; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) === 0x8825) {
        const gpsIfd = u32(entry + 8);
        return base + gpsIfd + 2 <= exif.length && u16(gpsIfd) > 0;
      }
    }
  } catch {
    /* malformed EXIF: treat as no location */
  }
  return false;
}

// --- social sizes --------------------------------------------------------------

export const SOCIAL_PRESETS = {
  'instagram-square': { label: 'Instagram post (square)', width: 1080, height: 1080 },
  'instagram-portrait': { label: 'Instagram post (portrait)', width: 1080, height: 1350 },
  'instagram-story': { label: 'Story / Reel / TikTok', width: 1080, height: 1920 },
  'facebook-post': { label: 'Facebook / link preview', width: 1200, height: 630 },
  'facebook-cover': { label: 'Facebook page cover', width: 1640, height: 624 },
  'facebook-event': { label: 'Facebook event cover', width: 1920, height: 1005 },
  'x-post': { label: 'X (Twitter) post', width: 1600, height: 900 },
  'x-header': { label: 'X (Twitter) header', width: 1500, height: 500 },
  'youtube-thumbnail': { label: 'YouTube thumbnail', width: 1280, height: 720 },
  'youtube-banner': { label: 'YouTube channel banner', width: 2560, height: 1440 },
  'linkedin-post': { label: 'LinkedIn post', width: 1200, height: 627 },
  'website-hero': { label: 'Website hero (16:9)', width: 1920, height: 1080 },
  'email-header': { label: 'Email header', width: 1200, height: 400 }
};

const POSITIONS = {
  smart: sharp.strategy.attention,
  center: 'centre',
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right'
};

/**
 * @param {object} opts  { presets: string[], mode: keyof POSITIONS | 'blur' | 'color', background, format, quality }
 */
export async function socialPack(file, opts) {
  const largest = Math.max(...opts.presets.map((id) => Math.max(SOCIAL_PRESETS[id].width, SOCIAL_PRESETS[id].height)));
  const { image } = await open(file, { targetEdge: largest });
  // Decode once; every preset starts from the same rotated pixels.
  const source = await image.png().toBuffer();
  const meta = await sharp(source).metadata();

  const entries = [];
  const warnings = new Set();
  for (const id of opts.presets) {
    const p = SOCIAL_PRESETS[id];
    if (meta.width < p.width * 0.6 && meta.height < p.height * 0.6) {
      warnings.add(`The source (${meta.width}×${meta.height}) is much smaller than some sizes, so they will look soft.`);
    }

    let pipeline;
    if (opts.mode === 'blur' || opts.mode === 'color') {
      const fg = await sharp(source).resize(p.width, p.height, { fit: 'inside' }).toBuffer();
      const bg =
        opts.mode === 'blur'
          ? await sharp(source)
              .resize(p.width, p.height, { fit: 'cover' })
              .blur(Math.max(20, Math.round(p.width / 30)))
              .modulate({ brightness: 0.7 })
              .toBuffer()
          : await sharp({ create: { width: p.width, height: p.height, channels: 3, background: hexToRgb(opts.background) } })
              .png()
              .toBuffer();
      pipeline = sharp(bg).composite([{ input: fg, gravity: 'centre' }]);
    } else {
      pipeline = sharp(source).resize(p.width, p.height, { fit: 'cover', position: POSITIONS[opts.mode] ?? POSITIONS.smart });
    }

    const data = await encode(pipeline, opts.format, { quality: opts.quality }).toBuffer();
    entries.push({ name: `${stem(file.originalname, 'image')}-${id}-${p.width}x${p.height}.${EXT[opts.format]}`, buffer: data });
  }
  return { entries, warnings: [...warnings] };
}

// --- favicon pack --------------------------------------------------------------

/**
 * Everything a site needs: multi-size .ico, PNG favicons, Apple touch icon,
 * Android/PWA icons (incl. a maskable one), a web manifest and the <head> tags.
 *
 * @param {object} opts  { padding: 0–0.3, background: 'transparent'|hex, appName, themeColor }
 */
export async function faviconPack(file, opts) {
  const { image } = await open(file, { targetEdge: 1024 });
  const master = await image
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const transparent = opts.background === 'transparent';
  const solid = transparent ? '#FFFFFF' : opts.background;

  async function icon(size, { padding = opts.padding, background = transparent ? null : opts.background } = {}) {
    const inner = Math.max(1, Math.round(size * (1 - padding * 2)));
    const art = await sharp(master).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
    const canvas = sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: background ? { ...hexToRgb(background), alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
    return canvas.composite([{ input: art, gravity: 'centre' }]).png({ compressionLevel: 9 }).toBuffer();
  }

  const png16 = await icon(16, { padding: Math.min(opts.padding, 0.06) });
  const png32 = await icon(32, { padding: Math.min(opts.padding, 0.08) });
  const png48 = await icon(48);

  const entries = [
    { name: 'favicon.ico', buffer: buildIco([[16, png16], [32, png32], [48, png48]]) },
    { name: 'favicon-16x16.png', buffer: png16 },
    { name: 'favicon-32x32.png', buffer: png32 },
    // iOS draws a black square behind transparency, so this one is always opaque.
    { name: 'apple-touch-icon.png', buffer: await icon(180, { padding: Math.max(opts.padding, 0.08), background: solid }) },
    { name: 'android-chrome-192x192.png', buffer: await icon(192) },
    { name: 'android-chrome-512x512.png', buffer: await icon(512) },
    // Maskable icons are cropped to a circle or squircle: keep the art in the inner 80%.
    { name: 'maskable-512x512.png', buffer: await icon(512, { padding: Math.max(opts.padding, 0.12), background: solid }) }
  ];

  const hasSvg = isSvg(file);
  if (hasSvg) entries.push({ name: 'favicon.svg', buffer: Buffer.from(assertSafeSvg(file.buffer.toString('utf8')), 'utf8') });

  const manifest = {
    name: opts.appName || 'Hoops College',
    short_name: (opts.appName || 'Hoops College').slice(0, 12),
    icons: [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    theme_color: opts.themeColor,
    background_color: solid,
    display: 'standalone'
  };
  entries.push({ name: 'site.webmanifest', buffer: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });

  const head = [
    '<link rel="icon" href="/favicon.ico" sizes="48x48">',
    hasSvg ? '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' : null,
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
    '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${opts.themeColor}">`
  ]
    .filter(Boolean)
    .join('\n');
  entries.push({ name: 'head-snippet.html', buffer: Buffer.from(head + '\n') });

  return { entries, head, preview: await icon(180, { background: transparent ? null : opts.background }) };
}

/** PNG-in-ICO container, understood by every browser since IE Vista-era. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const dir = [];
  for (const [size, png] of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...images.map(([, png]) => png)]);
}

/** Rasterise a stored logo for the brand kit and the print tools. */
export async function renderLogo(buffer, { isSvgFile, size, format = 'png', background }) {
  const file = { buffer, originalname: isSvgFile ? 'logo.svg' : 'logo.png', mimetype: isSvgFile ? 'image/svg+xml' : 'image/png' };
  const { image } = await open(file, { targetEdge: size });
  const pipeline = image.resize(size, size, { fit: 'inside', withoutEnlargement: !isSvgFile });
  return encode(pipeline, format, { quality: 92, background }).toBuffer();
}
