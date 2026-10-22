/**
 * Name tags, jersey/bag labels and roster sign-in sheets with a QR per person,
 * laid out for common Avery sheets on US Letter.
 *
 * QR payloads default to "HC:<id>", which the check-in scanner understands.
 */
import { rgb } from 'pdf-lib';
import { createDocument, color, onColor, drawQr, drawContained } from './typeset.js';

const IN = 72;
const LETTER = [8.5 * IN, 11 * IN];
const INK = '#14181F';
const MUTED = '#5D6672';

/** Sheet geometry in points: label size, grid, first-label offset and pitch. */
export const TAG_LAYOUTS = {
  'badge-4x3': { label: 'Name badge 4×3 in — 6/sheet (Avery 5392, 74459)', w: 4 * IN, h: 3 * IN, cols: 2, rows: 3, left: 0.25 * IN, top: 1 * IN, px: 4 * IN, py: 3 * IN, kind: 'badge' },
  'badge-5395': { label: 'Name badge 3⅜×2⅓ in — 8/sheet (Avery 5395, 8395)', w: 3.375 * IN, h: 2.333 * IN, cols: 2, rows: 4, left: 0.6875 * IN, top: 0.594 * IN, px: 3.75 * IN, py: 2.5 * IN, kind: 'badge' },
  'square-2x2': { label: 'Square 2×2 in — 12/sheet (Avery 22806), bag & jersey tags', w: 2 * IN, h: 2 * IN, cols: 3, rows: 4, left: 0.625 * IN, top: 0.625 * IN, px: 2.625 * IN, py: 2.583 * IN, kind: 'square' },
  'label-5160': { label: 'Address label 2⅝×1 in — 30/sheet (Avery 5160)', w: 2.625 * IN, h: 1 * IN, cols: 3, rows: 10, left: 0.1875 * IN, top: 0.5 * IN, px: 2.75 * IN, py: 1 * IN, kind: 'label' },
  roster: { label: 'Roster / sign-in sheet', kind: 'roster' }
};

/**
 * @param {object} o  { rows: [{name, group, id}], layout, title, subtitle, primary,
 *                      qrMode: 'checkin'|'url'|'none', urlTemplate, outline, logo (PNG|null), brandName }
 */
export async function buildTags(o) {
  const layout = TAG_LAYOUTS[o.layout] ?? TAG_LAYOUTS['badge-4x3'];
  const { doc, type } = await createDocument(o.title || 'Name tags');
  const ctx = { doc, type, o, logo: o.logo ? await doc.embedPng(o.logo) : null };

  if (layout.kind === 'roster') {
    await roster(ctx);
  } else {
    const perPage = layout.cols * layout.rows;
    let page;
    o.rows.forEach((row, i) => {
      const slot = i % perPage;
      if (slot === 0) page = doc.addPage(LETTER);
      const col = slot % layout.cols;
      const r = Math.floor(slot / layout.cols);
      const x = layout.left + col * layout.px;
      const top = LETTER[1] - layout.top - r * layout.py;
      const box = { x, y: top - layout.h, w: layout.w, h: layout.h };
      if (o.outline) page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: rgb(0.75, 0.78, 0.82), borderWidth: 0.5, borderDashArray: [3, 3] });
      ({ badge, square, label })[layout.kind](ctx, page, box, row);
    });
  }
  return Buffer.from(await doc.save());
}

export function qrPayload(o, row) {
  if (o.qrMode === 'none') return null;
  if (o.qrMode === 'url') {
    if (!o.urlTemplate) return null;
    return o.urlTemplate
      .replaceAll('{id}', encodeURIComponent(row.id ?? ''))
      .replaceAll('{name}', encodeURIComponent(row.name ?? ''))
      .replaceAll('{group}', encodeURIComponent(row.group ?? ''));
  }
  return row.id ? `HC:${row.id}` : null;
}

/**
 * Names read best on one line; only wrap when one line would get too small.
 * Tries 1 line down to 55% of max, then 2 lines, then 3.
 */
function fitName(type, name, width, opts) {
  // Let hyphenated surnames break after the hyphen rather than mid-word.
  const fitted = fitNameLines(type, name.replace(/-(?=\S)/g, '- '), width, opts);
  return { ...fitted, lines: fitted.lines.map((l) => l.replace(/- /g, '-')) };
}

function fitNameLines(type, text, width, { max, maxHeight = Infinity, leading = 1.02 }) {
  const one = type.fit(text, 'black', width, { max, min: Math.max(6, max * 0.55), maxLines: 1, maxHeight });
  if (type.wrap(text, one.size, 'black', width).length === 1) return one;
  const two = type.fit(text, 'black', width, { max: max * 0.8, min: Math.max(6, max * 0.4), maxLines: 2, maxHeight, leading });
  if (type.wrap(text, two.size, 'black', width).length <= 2) return two;
  return type.fit(text, 'black', width, { max: max * 0.6, min: 6, maxLines: 3, maxHeight, leading });
}

function badge({ type, o, logo }, page, b, row) {
  const pad = b.w * 0.06;
  const bandH = b.h * 0.27;
  const fg = color(onColor(o.primary));
  page.drawRectangle({ x: b.x, y: b.y + b.h - bandH, width: b.w, height: bandH, color: color(o.primary) });

  let tx = b.x + pad;
  if (logo) {
    const d = drawContained(page, logo, { x: tx, y: b.y + b.h - bandH + bandH * 0.15, width: bandH * 1.6, height: bandH * 0.7, align: 'left' });
    tx = d.x + d.width + pad * 0.6;
  }
  const bandW = b.x + b.w - pad - tx;
  const title = o.title || o.brandName;
  if (title) {
    const t = type.fit(title, 'bold', bandW, { max: bandH * 0.3, min: 5, maxLines: 1 });
    const sub = o.subtitle ? type.fit(o.subtitle, 'regular', bandW, { max: bandH * 0.2, min: 5, maxLines: 1 }) : null;
    const blockH = t.size + (sub ? sub.size * 1.3 : 0);
    const top = b.y + b.h - (bandH - blockH) / 2;
    const y = type.lines(page, t.lines, { x: tx, top, size: t.size, weight: 'bold', color: fg });
    if (sub) type.lines(page, sub.lines, { x: tx, top: y - sub.size * 0.15, size: sub.size, color: fg, opacity: 0.85 });
  }

  const bodyTop = b.y + b.h - bandH;
  const bodyH = b.h - bandH;
  const data = qrPayload(o, row);
  const qrSize = data ? Math.min(bodyH * 0.74, b.w * 0.32) : 0;
  const textW = b.w - pad * 2 - (qrSize ? qrSize + pad * 0.6 : 0);

  const name = fitName(type, row.name, textW, { max: bodyH * 0.3, maxHeight: bodyH * 0.72 });
  const group = row.group ? type.fit(row.group, 'bold', textW, { max: bodyH * 0.1, min: 6, maxLines: 1 }) : null;
  const blockH = name.lines.length * name.size * 1.02 + (group ? group.size * 1.6 : 0);
  let y = bodyTop - (bodyH - blockH) / 2;
  y = type.lines(page, name.lines, { x: b.x + pad, top: y, size: name.size, weight: 'black', color: color(INK), leading: 1.02 });
  if (group) type.label(page, group.lines[0], { x: b.x + pad, y: y - group.size * 1.15, size: group.size, color: color(o.primary === '#FFFFFF' ? MUTED : o.primary), tracking: 0.1 });

  if (data) {
    const qx = b.x + b.w - pad - qrSize;
    drawQr(page, data, { x: qx, top: bodyTop - (bodyH - qrSize) / 2 + qrSize * 0.04, size: qrSize, dark: INK, margin: 1, ecLevel: 'M' });
    if (o.qrMode === 'checkin' && row.id) {
      const s = Math.max(5, qrSize * 0.075);
      type.lines(page, [row.id], { x: qx, top: bodyTop - (bodyH - qrSize) / 2 - qrSize * 0.96, size: s, color: color(MUTED), align: 'center', width: qrSize });
    }
  }
}

function square({ type, o }, page, b, row) {
  const pad = b.w * 0.07;
  const data = qrPayload(o, row);
  const qrSize = data ? b.w * 0.56 : 0;
  let y = b.y + b.h - pad;
  if (data) {
    drawQr(page, data, { x: b.x + (b.w - qrSize) / 2, top: y, size: qrSize, dark: INK, margin: 1 });
    y -= qrSize + pad * 0.35;
  }
  const w = b.w - pad * 2;
  const room = y - b.y - pad;
  const name = fitName(type, row.name, w, { max: data ? b.h * 0.11 : b.h * 0.2, maxHeight: room * 0.75 });
  y = type.lines(page, name.lines, { x: b.x + pad, top: y, size: name.size, weight: 'black', color: color(INK), align: 'center', width: w, leading: 1.02 });
  const sub = [row.group, o.qrMode === 'checkin' ? row.id : ''].filter(Boolean).join(' · ');
  if (sub) {
    const s = type.fit(sub, 'bold', w, { max: b.h * 0.065, min: 5, maxLines: 1 });
    type.lines(page, s.lines, { x: b.x + pad, top: y - s.size * 0.2, size: s.size, weight: 'bold', color: color(o.primary === '#FFFFFF' ? MUTED : o.primary), align: 'center', width: w });
  }
}

function label({ type, o }, page, b, row) {
  const pad = b.h * 0.1;
  const data = qrPayload(o, row);
  const qrSize = data ? b.h - pad * 2 : 0;
  if (data) drawQr(page, data, { x: b.x + pad, top: b.y + b.h - pad, size: qrSize, dark: INK, margin: 1 });
  const x = b.x + pad + (qrSize ? qrSize + pad : pad * 0.5);
  const w = b.x + b.w - pad - x;
  const name = fitName(type, row.name, w, { max: b.h * 0.24, maxHeight: b.h * 0.62 });
  const sub = [row.group, o.qrMode === 'checkin' ? row.id : ''].filter(Boolean).join(' · ');
  const s = sub ? type.fit(sub, 'regular', w, { max: b.h * 0.14, min: 5, maxLines: 1 }) : null;
  const blockH = name.lines.length * name.size * 1.02 + (s ? s.size * 1.4 : 0);
  let y = b.y + b.h / 2 + blockH / 2;
  y = type.lines(page, name.lines, { x, top: y, size: name.size, weight: 'black', color: color(INK), leading: 1.02 });
  if (s) type.lines(page, s.lines, { x, top: y - s.size * 0.2, size: s.size, color: color(MUTED) });
}

async function roster({ doc, type, o, logo }) {
  const [W, H] = LETTER;
  const m = 0.5 * IN;
  const withQr = o.qrMode !== 'none';
  const rowH = withQr ? 0.78 * IN : 0.36 * IN;
  const headerH = 0.95 * IN;
  const tableTop = H - m - headerH;
  const perPage = Math.floor((tableTop - m - 20) / rowH);
  const pages = Math.max(1, Math.ceil(o.rows.length / perPage));
  const cols = [
    { key: '#', w: 0.4 * IN },
    { key: 'Name', w: 0 },
    { key: 'Group', w: 1.3 * IN },
    ...(withQr ? [{ key: 'QR', w: rowH }] : []),
    { key: 'Present', w: 0.75 * IN },
    { key: 'Signature', w: 1.6 * IN }
  ];
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  cols[1].w = W - m * 2 - fixed;

  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(LETTER);
    // Header.
    page.drawRectangle({ x: 0, y: H - 0.32 * IN, width: W, height: 0.32 * IN, color: color(o.primary) });
    let tx = m;
    if (logo) {
      const d = drawContained(page, logo, { x: m, y: H - m - headerH + 0.3 * IN, width: 1.2 * IN, height: headerH - 0.45 * IN, align: 'left' });
      tx = d.x + d.width + 0.2 * IN;
    }
    const title = type.fit(o.title || 'Roster', 'black', W - tx - m - 1.4 * IN, { max: 22, min: 10, maxLines: 1 });
    let y = type.lines(page, title.lines, { x: tx, top: H - m - 0.15 * IN, size: title.size, weight: 'black', color: color(INK) });
    if (o.subtitle) type.lines(page, [o.subtitle], { x: tx, top: y - 3, size: 11, color: color(MUTED) });
    type.lines(page, [`Page ${p + 1} of ${pages}  ·  ${o.rows.length} names`], { x: W - m - 2.4 * IN, top: H - m - 0.15 * IN, size: 9, color: color(MUTED), align: 'right', width: 2.4 * IN });

    // Column headings.
    let cx = m;
    const headY = tableTop - 12;
    for (const c of cols) {
      if (c.key !== '#') type.label(page, c.key, { x: cx + 4, y: headY, size: 7.5, color: color(MUTED), tracking: 0.12 });
      cx += c.w;
    }
    page.drawLine({ start: { x: m, y: tableTop - 18 }, end: { x: W - m, y: tableTop - 18 }, thickness: 1, color: color(INK) });

    const slice = o.rows.slice(p * perPage, (p + 1) * perPage);
    slice.forEach((row, i) => {
      const top = tableTop - 20 - i * rowH;
      if (i % 2 === 1) page.drawRectangle({ x: m, y: top - rowH, width: W - m * 2, height: rowH, color: rgb(0.96, 0.97, 0.98) });
      const mid = top - rowH / 2;
      let x = m;
      for (const c of cols) {
        if (c.key === '#') type.lines(page, [String(p * perPage + i + 1)], { x: x + 4, top: mid + 5, size: 9, color: color(MUTED) });
        if (c.key === 'Name') {
          const n = type.fit(row.name, 'bold', c.w - 8, { max: 12, min: 7, maxLines: 1 });
          type.lines(page, n.lines, { x: x + 4, top: mid + n.size * 0.45, size: n.size, weight: 'bold', color: color(INK) });
        }
        if (c.key === 'Group' && row.group) {
          const g = type.fit(row.group, 'regular', c.w - 8, { max: 10, min: 6, maxLines: 1 });
          type.lines(page, g.lines, { x: x + 4, top: mid + g.size * 0.45, size: g.size, color: color(INK) });
        }
        if (c.key === 'QR') {
          const data = qrPayload(o, row);
          if (data) drawQr(page, data, { x: x + 3, top: top - 3, size: rowH - 6, dark: INK, margin: 1 });
        }
        if (c.key === 'Present') {
          const s = 12;
          page.drawRectangle({ x: x + (c.w - s) / 2, y: mid - s / 2, width: s, height: s, borderColor: color(INK), borderWidth: 0.8 });
        }
        if (c.key === 'Signature') page.drawLine({ start: { x: x + 4, y: mid - 6 }, end: { x: x + c.w - 4, y: mid - 6 }, thickness: 0.5, color: rgb(0.7, 0.72, 0.75) });
        x += c.w;
      }
    });
  }
}
