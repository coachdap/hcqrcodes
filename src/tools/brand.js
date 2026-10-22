/**
 * Brand kit: logos, colours and fonts per brand, editable from the UI and used
 * by the flyer and name-tag tools. Seeded once from assets/brand.json; after
 * that the copy on the data volume is the source of truth.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertSafeSvg } from '../svgconvert.js';
import { dataPath, mutate, readJson, remove, shortId, writeJson } from './store.js';
import { httpError } from './common.js';
import { renderLogo } from './images.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const FILE = dataPath('brand', 'brand.json');
const LOGO_DIR = dataPath('brand', 'logos');
const EMPTY = { brands: [] };

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colours are #RRGGBB').transform((v) => v.toUpperCase());

export const brandPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  website: z.string().trim().max(120).optional(),
  tagline: z.string().trim().max(160).optional(),
  notes: z.string().max(2000).optional(),
  colors: z.array(z.object({ name: z.string().trim().max(40), hex })).max(16).optional(),
  fonts: z.array(z.object({ name: z.string().trim().min(1).max(60), usage: z.string().trim().max(80).default('') })).max(8).optional()
});

let seeded = null;
function ensureSeeded() {
  seeded ??= (async () => {
    if (await readJson(FILE, null)) return;
    const seed = JSON.parse(await readFile(path.join(ASSETS, 'brand.json'), 'utf8'));
    await mkdir(LOGO_DIR, { recursive: true });
    for (const brand of seed.brands) {
      for (const logo of brand.logos) {
        const stored = `${brand.id}-${logo.id}${path.extname(logo.file)}`;
        await copyFile(path.join(ASSETS, logo.file), path.join(LOGO_DIR, stored));
        logo.file = stored;
      }
    }
    await writeJson(FILE, seed);
  })().catch((err) => {
    seeded = null;
    throw err;
  });
  return seeded;
}

export async function listBrands() {
  await ensureSeeded();
  return (await readJson(FILE, EMPTY)).brands;
}

export async function getBrand(id) {
  const brand = (await listBrands()).find((b) => b.id === id);
  if (!brand) throw httpError(404, 'BRAND_NOT_FOUND', `No brand "${id}".`);
  return brand;
}

export async function createBrand(name) {
  await ensureSeeded();
  const clean = z.string().trim().min(1).max(80).parse(name);
  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brand';
  return mutate(FILE, EMPTY, (data) => {
    let id = base;
    let n = 2;
    while (data.brands.some((b) => b.id === id)) id = `${base}-${n++}`;
    const brand = { id, name: clean, website: '', tagline: '', colors: [], fonts: [], notes: '', logos: [] };
    data.brands.push(brand);
    return brand;
  });
}

export async function updateBrand(id, patch) {
  await ensureSeeded();
  const changes = brandPatchSchema.parse(patch);
  return mutate(FILE, EMPTY, (data) => {
    const brand = data.brands.find((b) => b.id === id);
    if (!brand) throw httpError(404, 'BRAND_NOT_FOUND', `No brand "${id}".`);
    Object.assign(brand, changes);
    return brand;
  });
}

export async function deleteBrand(id) {
  await ensureSeeded();
  const brand = await mutate(FILE, EMPTY, (data) => {
    const i = data.brands.findIndex((b) => b.id === id);
    if (i < 0) throw httpError(404, 'BRAND_NOT_FOUND', `No brand "${id}".`);
    return data.brands.splice(i, 1)[0];
  });
  for (const logo of brand.logos) await remove(path.join(LOGO_DIR, logo.file));
}

export async function addLogo(id, file, name) {
  await ensureSeeded();
  const svg = file.mimetype === 'image/svg+xml' || /\.svg$/i.test(file.originalname);
  let buffer = file.buffer;
  let ext = '.png';
  if (svg) {
    buffer = Buffer.from(assertSafeSvg(buffer.toString('utf8')), 'utf8');
    ext = '.svg';
  } else {
    // Normalise rasters to PNG (keeps transparency) and cap their size.
    buffer = await renderLogo(buffer, { isSvgFile: false, size: 2048, format: 'png' });
  }
  const logoId = shortId(8).toLowerCase();
  const stored = `${id}-${logoId}${ext}`;
  await mkdir(LOGO_DIR, { recursive: true });
  await writeFile(path.join(LOGO_DIR, stored), buffer);
  return mutate(FILE, EMPTY, (data) => {
    const brand = data.brands.find((b) => b.id === id);
    if (!brand) throw httpError(404, 'BRAND_NOT_FOUND', `No brand "${id}".`);
    const logo = { id: logoId, name: String(name || file.originalname.replace(/\.[^.]+$/, '')).slice(0, 60), file: stored };
    brand.logos.push(logo);
    return logo;
  });
}

export async function deleteLogo(id, logoId) {
  await ensureSeeded();
  const logo = await mutate(FILE, EMPTY, (data) => {
    const brand = data.brands.find((b) => b.id === id);
    const i = brand?.logos.findIndex((l) => l.id === logoId) ?? -1;
    if (i < 0) throw httpError(404, 'LOGO_NOT_FOUND', 'No such logo.');
    return brand.logos.splice(i, 1)[0];
  });
  await remove(path.join(LOGO_DIR, logo.file));
}

/** Raw stored logo bytes. */
export async function logoFile(id, logoId) {
  const brand = await getBrand(id);
  const logo = logoId ? brand.logos.find((l) => l.id === logoId) : brand.logos[0];
  if (!logo) throw httpError(404, 'LOGO_NOT_FOUND', logoId ? 'No such logo.' : `${brand.name} has no logo yet.`);
  return { logo, buffer: await readFile(path.join(LOGO_DIR, logo.file)), isSvg: logo.file.endsWith('.svg') };
}

/** Logo in the requested format and size, for downloads and previews. */
export async function exportLogo(id, logoId, { format, size, background }) {
  const { logo, buffer, isSvg } = await logoFile(id, logoId);
  const name = `${id}-${logo.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (format === 'svg') {
    if (!isSvg) throw httpError(400, 'NOT_VECTOR', 'This logo was uploaded as a raster image, so there is no SVG version.');
    return { buffer, contentType: 'image/svg+xml', filename: `${name}.svg` };
  }
  const out = await renderLogo(buffer, { isSvgFile: isSvg, size, format, background });
  const ext = format === 'jpeg' ? 'jpg' : format;
  return { buffer: out, contentType: `image/${format}`, filename: `${name}-${size}.${ext}` };
}

/**
 * What the print tools need from a brand: a palette with sensible fallbacks and
 * the first logo as a PNG.
 */
export async function brandForPrint(id) {
  const brand = await getBrand(id).catch(() => null);
  const colors = (brand?.colors ?? []).map((c) => c.hex);
  const nonWhite = colors.filter((c) => !/^#F[0-9A-F]F[0-9A-F]F[0-9A-F]$/i.test(c));
  let logo = null;
  if (brand?.logos.length) {
    const { buffer, isSvg } = await logoFile(brand.id);
    logo = await renderLogo(buffer, { isSvgFile: isSvg, size: 600, format: 'png' });
  }
  return {
    name: brand?.name ?? '',
    website: brand?.website ?? '',
    primary: nonWhite[0] ?? '#0B1F3A',
    accent: nonWhite[1] ?? nonWhite[0] ?? '#0B1F3A',
    logo
  };
}
