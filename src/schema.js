import { z } from 'zod';

/**
 * Byte-mode capacity at QR version 40, per error-correction level.
 * The single "2953 byte" figure only holds at level L; anything stricter
 * has a lower ceiling, so we validate against the level actually in use.
 */
export const BYTE_CAPACITY = { L: 2953, M: 2331, Q: 1663, H: 1273 };

export const MAX_LOGO_SCALE = 0.25;
export const MAX_BATCH_ITEMS = 200;

const hex = z
  .string()
  .regex(
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    'must be a hex colour such as #0B1F3A'
  );

/**
 * Field definitions without defaults. Defaults are applied once, in
 * `generateSchema`, so that partial/override schemas (batch items, the helper
 * endpoints) leave unspecified fields genuinely undefined — a zod `.default()`
 * survives `.partial()`, which would otherwise mask a caller's top-level choice.
 */
const fields = {
  data: z.string().min(1, 'data is required'),
  format: z.enum(['svg', 'png']),
  size: z.number().int().min(64).max(8192),
  margin: z.number().int().min(0).max(32),
  ecLevel: z.enum(['L', 'M', 'Q', 'H']),
  dark: hex,
  light: hex,
  logo: z.string().min(1),
  logoScale: z.number().min(0.05).max(1)
};

export const generateSchema = z.object({
  data: fields.data,
  format: fields.format.default('svg'),
  size: fields.size.default(1024),
  margin: fields.margin.default(4),
  ecLevel: fields.ecLevel.optional(),
  dark: fields.dark.default('#000000'),
  light: fields.light.default('#FFFFFF'),
  logo: fields.logo.optional(),
  logoScale: fields.logoScale.default(0.2)
});

export const wifiSchema = z.object({
  ssid: z.string().min(1, 'ssid is required'),
  password: z.string().optional(),
  encryption: z.enum(['WPA', 'WEP', 'nopass']).default('WPA'),
  hidden: z.boolean().default(false)
});

export const vcardSchema = z.object({
  name: z.string().min(1, 'name is required'),
  org: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional()
});

/** Render options shared by the helper endpoints, minus the `data` they build themselves. */
export const renderOptionsSchema = z.object({
  format: fields.format.optional(),
  size: fields.size.optional(),
  margin: fields.margin.optional(),
  ecLevel: fields.ecLevel.optional(),
  dark: fields.dark.optional(),
  light: fields.light.optional(),
  logo: fields.logo.optional(),
  logoScale: fields.logoScale.optional()
});

export const wifiRequestSchema = wifiSchema.merge(renderOptionsSchema);
export const vcardRequestSchema = vcardSchema.merge(renderOptionsSchema);

export const batchSchema = z.object({
  items: z
    .array(renderOptionsSchema.extend({ data: fields.data, name: z.string().optional() }))
    .min(1, 'items must contain at least one entry')
    .max(MAX_BATCH_ITEMS, `items is limited to ${MAX_BATCH_ITEMS} entries per request`),
  format: fields.format.optional()
});

// --- SVG → raster conversion (utilities) ------------------------------------

/** Longest edge and total pixel ceiling for a converted image. */
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 40_000_000;

const finite = z.number().finite();

/** A rectangle in the SVG's own user-unit coordinate space (viewBox units). */
export const rectSchema = z.object({
  x: finite,
  y: finite,
  width: finite.positive('width must be greater than 0'),
  height: finite.positive('height must be greater than 0')
});

export const svgAnalyzeSchema = z.object({
  svg: z.string().min(1, 'svg is required')
});

export const svgConvertSchema = z
  .object({
    svg: z.string().min(1, 'svg is required'),
    format: z.enum(['webp', 'png']).default('webp'),
    quality: z.number().int().min(1).max(100).default(90),
    lossless: z.boolean().default(false),
    background: z.union([z.literal('transparent'), hex]).default('transparent'),
    crop: z.enum(['original', 'artwork', 'custom']).default('artwork'),
    cropRect: rectSchema.optional(),
    /** Extra room around the crop, in user units. */
    padding: finite.min(0).max(10000).default(0),
    width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION).optional(),
    height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION).optional(),
    /** Pixels per user unit when neither width nor height is given. */
    scale: finite.min(0.01).max(64).default(1),
    /** Filename stem for Content-Disposition. */
    name: z.string().max(200).optional()
  })
  .refine((v) => v.crop !== 'custom' || v.cropRect, {
    message: 'cropRect is required when crop is "custom"',
    path: ['cropRect']
  });

/**
 * Resolve the effective error-correction level. A logo occludes the centre of
 * the symbol, so H is forced whenever one is supplied regardless of the request.
 */
export function resolveEcLevel({ ecLevel, logo }) {
  if (logo) return 'H';
  return ecLevel ?? 'M';
}

export function assertCapacity(data, ecLevel) {
  const bytes = Buffer.byteLength(data, 'utf8');
  const limit = BYTE_CAPACITY[ecLevel];
  if (bytes > limit) {
    const detail =
      ecLevel === 'L'
        ? `${bytes} bytes exceeds the ${limit}-byte QR maximum.`
        : `${bytes} bytes exceeds the ${limit}-byte capacity at ecLevel ${ecLevel} (the 2953-byte maximum applies only at ecLevel L).`;
    throw Object.assign(new Error(`Payload too large: ${detail}`), {
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      details: { bytes, limit, ecLevel }
    });
  }
  return bytes;
}
