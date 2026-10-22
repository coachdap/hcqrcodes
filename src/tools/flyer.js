/**
 * Flyer maker: a branded, print-ready event flyer (or social graphic) with a
 * vector QR. Built as a PDF; PNG output is the same page rasterised by Poppler,
 * so the preview, the PNG and the print file always match.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { rgb } from 'pdf-lib';
import { createDocument, color, onColor, drawQr, drawContained, WHITE } from './typeset.js';
import { run, withTempDir } from './common.js';

/** Page sizes in PDF points. Social sizes are half their pixel size (rendered at 144 dpi). */
export const FLYER_SIZES = {
  letter: { label: 'Letter 8.5×11 in', width: 612, height: 792, dpi: 200 },
  tabloid: { label: 'Tabloid 11×17 in (poster)', width: 792, height: 1224, dpi: 150 },
  a4: { label: 'A4', width: 595.28, height: 841.89, dpi: 200 },
  half: { label: 'Half letter 5.5×8.5 in (handout)', width: 396, height: 612, dpi: 250 },
  square: { label: 'Instagram post 1080×1080', width: 540, height: 540, dpi: 144 },
  portrait: { label: 'Instagram portrait 1080×1350', width: 540, height: 675, dpi: 144 },
  story: { label: 'Story 1080×1920', width: 540, height: 960, dpi: 144 },
  landscape: { label: 'Landscape 1920×1080 (screens, Facebook)', width: 960, height: 540, dpi: 144 }
};

const INK = '#14181F';
const MUTED = '#5D6672';

/**
 * @param {object} f  normalised fields: template, size, headline, subheadline, date, time,
 *                    location, price, details, cta, url, urlLabel, primary, accent,
 *                    brandName, website, logo (PNG buffer|null), photo (buffer|null)
 */
export async function buildFlyer(f) {
  const size = FLYER_SIZES[f.size] ?? FLYER_SIZES.letter;
  const { doc, type } = await createDocument(f.headline || 'Flyer');
  const W = size.width;
  const H = size.height;
  const page = doc.addPage([W, H]);
  const ctx = { doc, page, type, f, W, H, m: Math.min(W, H) * 0.065 };

  ctx.logo = f.logo ? await doc.embedPng(f.logo) : null;

  if (W / H > 1.2) await landscape(ctx);
  else await portrait(ctx);

  return Buffer.from(await doc.save());
}

// --- portrait & square -----------------------------------------------------------

async function portrait(ctx) {
  const { page, type, f, W, H, m } = ctx;
  const ratio = H / W;
  const heroH = H * (ratio > 1.6 ? 0.47 : ratio < 1.1 ? 0.47 : 0.48);
  const heroBottom = H - heroH;
  const onHero = await paintHero(ctx, { x: 0, y: heroBottom, width: W, height: heroH });

  // Logo and brand line.
  const logoH = Math.min(W, H) * 0.1;
  const brandTop = H - m;
  const brandBottom = drawBrandLine(ctx, { x: m, top: brandTop, height: logoH, width: W - m * 2, onHero });

  // Headline block, anchored to the bottom of the hero.
  const textW = W - m * 2;
  const room = brandBottom - (heroBottom + m * 0.9) - m * 0.4;
  const block = headlineBlock(ctx, { width: textW, maxHeight: room, maxSize: W * (ratio < 1.1 ? 0.11 : 0.125) });
  let y = heroBottom + m * 0.9 + block.height;
  y = drawHeadlineBlock(ctx, block, { x: m, top: y, onHero, width: textW });

  // Accent stripe.
  const stripe = Math.max(4, H * 0.012);
  page.drawRectangle({ x: 0, y: heroBottom - stripe, width: W, height: stripe, color: color(f.accent) });

  // Footer band.
  const footerText = [f.website, f.brandName].find(Boolean) ?? '';
  const footerH = footerText ? Math.max(18, H * 0.05) : 0;
  if (footerH) {
    page.drawRectangle({ x: 0, y: 0, width: W, height: footerH, color: color(f.primary) });
    const fs = Math.min(footerH * 0.38, W * 0.024);
    type.label(page, footerText, { x: 0, y: footerH / 2 - fs * 0.35, size: fs, color: color(onColor(f.primary)), align: 'center', width: W, tracking: 0.14 });
  }

  // Info area.
  const top = heroBottom - stripe - m * 0.85;
  const bottom = footerH + m * 0.7;
  const areaH = top - bottom;
  let infoW = W - m * 2;

  // Sparse flyers ("Open Gym", a date) get a bigger QR and bigger type, so
  // the bottom half doesn't sit empty.
  const lines = infoItems(f).length + f.details.split('\n').filter((l) => l.trim()).length;
  const sparse = lines <= 3;
  if (f.url) {
    const qrSize = Math.min(W * (sparse ? 0.38 : 0.3), areaH * (sparse ? 0.78 : 0.72));
    const colW = Math.max(qrSize, W * 0.3);
    const qx = W - m - colW;
    drawQrCard(ctx, { x: qx, top, width: colW, height: areaH, qrSize, onDark: false, center: true });
    infoW = qx - m - m * 0.6;
  }
  const maxScale = (ratio < 1.1 ? 1.3 : ratio > 1.6 ? 1.5 : 1.2) * (sparse ? 1.35 : 1);
  drawInfo(ctx, { x: m, top, width: infoW, height: areaH, onDark: false, maxScale, center: true });
}

// --- landscape -----------------------------------------------------------------

async function landscape(ctx) {
  const { page, f, W, H, m } = ctx;
  const panelW = f.url ? W * 0.62 : W;
  const onHero = await paintHero(ctx, { x: 0, y: 0, width: panelW, height: H });

  const logoH = H * 0.11;
  const brandBottom = drawBrandLine(ctx, { x: m, top: H - m, height: logoH, width: panelW - m * 2, onHero });

  const textW = panelW - m * 2;
  const block = headlineBlock(ctx, { width: textW, maxHeight: (brandBottom - m) * 0.5, maxSize: H * 0.13 });
  const after = drawHeadlineBlock(ctx, block, { x: m, top: brandBottom - m * 0.5, onHero, width: textW });
  drawInfo(ctx, { x: m, top: after - m * 0.5, width: textW, height: after - m * 1.5, onDark: onHero === WHITE_HEX, maxScale: 1.9 });

  if (f.url) {
    const stripe = Math.max(4, W * 0.008);
    page.drawRectangle({ x: panelW, y: 0, width: stripe, height: H, color: color(f.accent) });
    const colX = panelW + stripe + m * 0.8;
    const colW = W - colX - m * 0.8;
    const qrSize = Math.min(colW, H * 0.5);
    const footer = f.website || f.brandName;
    drawQrCard(ctx, { x: colX, top: H - m * 1.2, width: colW, height: H - m * 2.4 - (footer ? H * 0.06 : 0), qrSize, onDark: false, center: true });
    if (footer) {
      const fs = H * 0.026;
      ctx.type.label(page, footer, { x: colX, y: m, size: fs, color: color(f.primary), align: 'center', width: colW, tracking: 0.12 });
    }
  }
}

// --- pieces --------------------------------------------------------------------

const WHITE_HEX = '#FFFFFF';

/** Paint the hero background; returns the hex colour text on it should use. */
async function paintHero(ctx, box) {
  const { page, doc, f } = ctx;
  if (f.template === 'photo' && f.photo) {
    // Crop the photo to the hero box at ~200 dpi, focusing on the busiest area.
    const px = Math.round((box.width / 72) * 200);
    const py = Math.round((box.height / 72) * 200);
    const jpg = await sharp(f.photo).rotate().resize(Math.min(px, 3000), Math.min(py, 3000), { fit: 'cover', position: sharp.strategy.attention }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    const img = await doc.embedJpg(jpg);
    page.drawImage(img, { x: box.x, y: box.y, width: box.width, height: box.height });
    // Brand tint, then a dark ramp under the headline for legibility.
    page.drawRectangle({ ...box, color: color(f.primary), opacity: 0.28 });
    const steps = 14;
    const rampH = box.height * 0.62;
    for (let i = 0; i < steps; i++) {
      const h = rampH / steps;
      page.drawRectangle({ x: box.x, y: box.y + i * h, width: box.width, height: h + 0.5, color: rgb(0, 0, 0), opacity: 0.62 * (1 - i / steps) });
    }
    page.drawRectangle({ x: box.x, y: box.y + box.height - box.height * 0.22, width: box.width, height: box.height * 0.22, color: rgb(0, 0, 0), opacity: 0.25 });
    return WHITE_HEX;
  }
  if (f.template === 'clean') {
    page.drawRectangle({ x: box.x, y: box.y, width: Math.max(6, ctx.W * 0.018), height: box.height, color: color(f.primary) });
    return f.primary;
  }
  page.drawRectangle({ ...box, color: color(f.primary) });
  // A large, faint court-circle motif gives the flat colour some depth.
  const r = Math.max(box.width, box.height) * 0.42;
  const tone = onColor(f.primary) === WHITE_HEX ? rgb(1, 1, 1) : rgb(0, 0, 0);
  page.drawCircle({ x: box.x + box.width * 0.92, y: box.y + box.height * 0.28, size: r, borderColor: tone, borderWidth: r * 0.06, borderOpacity: 0.07 });
  page.drawCircle({ x: box.x + box.width * 0.92, y: box.y + box.height * 0.28, size: r * 0.55, borderColor: tone, borderWidth: r * 0.03, borderOpacity: 0.06 });
  return onColor(f.primary);
}

function drawBrandLine(ctx, { x, top, height, width, onHero }) {
  const { page, type, f, logo } = ctx;
  let textX = x;
  if (logo) {
    const drawn = drawContained(page, logo, { x, y: top - height, width: height * 2.4, height, align: 'left' });
    textX = drawn.x + drawn.width + height * 0.3;
  }
  if (f.brandName && (!logo || ctx.f.showBrandName)) {
    const size = Math.min(height * 0.32, width * 0.05);
    type.label(page, f.brandName, { x: textX, y: top - height / 2 - size * 0.35, size, color: color(onHero), tracking: 0.16 });
  }
  return logo || f.brandName ? top - height : top;
}

function headlineBlock(ctx, { width, maxHeight, maxSize }) {
  const { type, f } = ctx;
  const upper = f.template !== 'clean';
  const headline = upper ? f.headline.toUpperCase() : f.headline;
  const subMax = maxSize * 0.36;
  const sub = f.subheadline ? type.fit(f.subheadline, 'bold', width, { max: subMax, min: 7, maxLines: 2 }) : null;
  const subH = sub ? sub.lines.length * sub.size * 1.2 + sub.size * 0.5 : 0;
  const head = type.fit(headline, 'black', width, { max: maxSize, min: 10, maxLines: 3, maxHeight: Math.max(20, maxHeight - subH), leading: 0.98 });
  return { head, sub, height: head.lines.length * head.size * 0.98 + subH };
}

function drawHeadlineBlock(ctx, block, { x, top, onHero, width }) {
  const { page, type, f } = ctx;
  let y = type.lines(page, block.head.lines, { x, top, size: block.head.size, weight: 'black', color: color(onHero), leading: 0.98, width });
  if (block.sub) {
    const subColor = f.template === 'clean' ? f.accent === WHITE_HEX ? INK : f.accent : onHero;
    y = type.lines(page, block.sub.lines, { x, top: y - block.sub.size * 0.45, size: block.sub.size, weight: 'bold', color: color(subColor), leading: 1.2, width, opacity: f.template === 'clean' ? 1 : 0.92 });
  }
  return y;
}

function infoItems(f) {
  const when = [f.date, f.time].filter(Boolean).join('  ·  ');
  return [
    when && { label: 'When', value: when },
    f.location && { label: 'Where', value: f.location },
    f.price && { label: 'Cost', value: f.price }
  ].filter(Boolean);
}

/** Label/value rows then bullet details, shrunk together until they fit. */
function drawInfo(ctx, { x, top, width, height, onDark, maxScale = 1.2, center = false }) {
  const { page, type, f, W, H } = ctx;
  const items = infoItems(f);
  const bullets = f.details.split('\n').map((s) => s.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  if (!items.length && !bullets.length) return;

  const base = Math.min(W, H);
  // Largest scale that fits: grows to fill roomy layouts, shrinks for busy ones.
  let plan;
  for (let scale = maxScale; scale >= 0.45; scale -= 0.05) {
    plan = layoutInfo(type, items, bullets, { width, scale, base });
    if (plan.height <= height) break;
  }

  const ink = color(onDark ? WHITE_HEX : INK);
  const muted = onDark ? color(WHITE_HEX) : color(MUTED);
  const mark = color(onDark ? WHITE_HEX : f.accent === WHITE_HEX ? f.primary : f.accent);
  let y = center && plan.height < height ? top - (height - plan.height) / 2 : top;
  for (const row of plan.rows) {
    if (row.kind === 'item') {
      type.label(page, row.label, { x, y: y - row.labelSize * 0.8, size: row.labelSize, color: muted, tracking: 0.16 });
      y -= row.labelSize * 1.45;
      y = type.lines(page, row.lines, { x, top: y, size: row.size, weight: 'bold', color: ink, leading: 1.18 });
      y -= row.gap;
    } else {
      const dot = row.size * 0.32;
      page.drawRectangle({ x, y: y - row.size * 0.62, width: dot, height: dot, color: mark });
      y = type.lines(page, row.lines, { x: x + row.indent, top: y, size: row.size, weight: 'regular', color: ink, leading: 1.25 });
      y -= row.gap;
    }
    if (y < top - height) break;
  }
}

function layoutInfo(type, items, bullets, { width, scale, base }) {
  const labelSize = base * 0.019 * scale;
  const valueSize = base * 0.038 * scale;
  const bulletSize = base * 0.028 * scale;
  const rows = [];
  let height = 0;
  for (const it of items) {
    const lines = type.wrap(it.value, valueSize, 'bold', width).slice(0, 3);
    const gap = valueSize * 0.75;
    rows.push({ kind: 'item', label: it.label, labelSize, size: valueSize, lines, gap });
    height += labelSize * 1.45 + lines.length * valueSize * 1.18 + gap;
  }
  if (bullets.length && items.length) height += bulletSize * 0.3;
  const indent = bulletSize * 1.1;
  for (const b of bullets) {
    const lines = type.wrap(b, bulletSize, 'regular', width - indent);
    const gap = bulletSize * 0.45;
    rows.push({ kind: 'bullet', size: bulletSize, lines, gap, indent });
    height += lines.length * bulletSize * 1.25 + gap;
  }
  return { rows, height };
}

function drawQrCard(ctx, { x, top, width, height, qrSize, center = false }) {
  const { page, type, f } = ctx;
  const ctaSize = Math.min(width * 0.1, qrSize * 0.12);
  const cta = f.cta ? type.fit(f.cta.toUpperCase(), 'black', width, { max: ctaSize, min: 6, maxLines: 2 }) : null;
  const ctaH = cta ? cta.lines.length * cta.size * 1.05 + cta.size * 0.5 : 0;
  const urlSize = Math.max(6, Math.min(qrSize * 0.065, 12));
  const label = f.urlLabel;
  const urlH = label ? urlSize * 2 : 0;
  const total = ctaH + qrSize + urlH;
  let y = center ? top - (height - total) / 2 : top;

  const qx = x + (width - qrSize) / 2;
  if (cta) {
    y = type.lines(page, cta.lines, { x, top: y, size: cta.size, weight: 'black', color: color(f.primary), leading: 1.05, align: 'center', width });
    y -= cta.size * 0.5;
  }
  drawQr(page, f.url, { x: qx, top: y, size: qrSize, dark: f.qrColor, light: '#FFFFFF', margin: 2, ecLevel: 'Q' });
  y -= qrSize;
  if (label) {
    const fitted = type.fit(label, 'bold', width, { max: urlSize, min: 5, maxLines: 1 });
    type.lines(page, fitted.lines, { x, top: y - urlSize * 0.5, size: fitted.size, weight: 'bold', color: color(MUTED), align: 'center', width });
  }
}

// --- rasterise -----------------------------------------------------------------

/** Render the first page of a PDF to PNG. `width` pins the pixel width. */
export async function pdfToPng(pdf, { dpi, width }) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, 'in.pdf');
    await writeFile(input, pdf);
    const sizing = width ? ['-scale-to-x', String(width), '-scale-to-y', '-1'] : ['-r', String(dpi)];
    await run('pdftoppm', ['-png', '-singlefile', '-aa', 'yes', '-aaVector', 'yes', ...sizing, input, path.join(dir, 'out')], { timeoutMs: 60_000 });
    return readFile(path.join(dir, 'out.png'));
  });
}
