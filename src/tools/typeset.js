/**
 * Small layout kit over pdf-lib shared by the flyer and name-tag tools: font
 * loading (Inter when installed, Helvetica otherwise), wrapping and
 * shrink-to-fit text, colour helpers and vector QR codes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';

const FONT_ROOTS = [process.env.QRGEN_FONT_DIR, '/usr/share/fonts', '/usr/local/share/fonts'].filter(Boolean);

const WEIGHTS = {
  regular: ['Inter-Regular', 'Inter-Medium'],
  bold: ['Inter-Bold', 'Inter-SemiBold'],
  black: ['Inter-ExtraBold', 'Inter-Black', 'Inter-Bold']
};

// Search the font trees rather than fixed paths: Debian releases have moved
// Inter between opentype/ and truetype/ subdirectories.
function findFonts() {
  const found = new Map();
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (/^Inter-[A-Za-z]+\.(otf|ttf)$/.test(e.name) && !found.has(e.name.replace(/\.\w+$/, ''))) {
        found.set(e.name.replace(/\.\w+$/, ''), full);
      }
    }
  };
  for (const root of FONT_ROOTS) walk(root, 0);
  return found;
}

const available = findFonts();
const fontBytes = {};
for (const [weight, names] of Object.entries(WEIGHTS)) {
  const hit = names.find((n) => available.has(n));
  if (hit) fontBytes[weight] = readFileSync(available.get(hit));
}
export const FONT_FAMILY = fontBytes.regular && fontBytes.bold && fontBytes.black ? 'Inter' : 'Helvetica';

export async function createDocument(title) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('qrgen utilities');
  doc.setCreator('Hoops College utilities');
  doc.registerFontkit(fontkit);

  const fonts = {};
  if (FONT_FAMILY === 'Inter') {
    // CFF fonts must be embedded whole: pdf-lib's subsetter corrupts them.
    for (const w of Object.keys(WEIGHTS)) fonts[w] = await doc.embedFont(fontBytes[w], { subset: false });
  } else {
    fonts.regular = await doc.embedFont(StandardFonts.Helvetica);
    fonts.bold = await doc.embedFont(StandardFonts.HelveticaBold);
    fonts.black = fonts.bold;
  }
  return { doc, type: new Typesetter(fonts, FONT_FAMILY !== 'Inter') };
}

export class Typesetter {
  constructor(fonts, standard) {
    this.fonts = fonts;
    this.standard = standard;
    this.cache = new Map();
  }

  /** Standard fonts only encode WinAnsi; replace anything else rather than throw. */
  clean(text, weight = 'regular') {
    const s = String(text ?? '').replace(/[\r\t]+/g, ' ');
    if (!this.standard) return s;
    const font = this.fonts[weight];
    return [...s]
      .map((ch) => {
        const key = weight + ch;
        if (!this.cache.has(key)) {
          try {
            font.encodeText(ch);
            this.cache.set(key, ch);
          } catch {
            this.cache.set(key, ch === '—' || ch === '–' ? '-' : '');
          }
        }
        return this.cache.get(key);
      })
      .join('');
  }

  width(text, size, weight = 'regular') {
    return this.fonts[weight].widthOfTextAtSize(this.clean(text, weight), size);
  }

  /** Greedy word wrap; words longer than the line are broken by character. */
  wrap(text, size, weight, maxWidth) {
    const lines = [];
    for (const para of String(text ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.width(candidate, size, weight) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        if (this.width(word, size, weight) <= maxWidth) {
          line = word;
        } else {
          let chunk = '';
          for (const ch of word) {
            if (this.width(chunk + ch, size, weight) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Largest size (≤ max) at which `text` fits in `maxLines` lines of `maxWidth`. */
  fit(text, weight, maxWidth, { max, min = 6, maxLines = 1, maxHeight = Infinity, leading = 1.1 }) {
    for (let size = max; size >= min; size -= Math.max(0.5, size * 0.04)) {
      const lines = this.wrap(text, size, weight, maxWidth);
      if (lines.length <= maxLines && lines.length * size * leading <= maxHeight) return { size, lines };
    }
    const lines = this.wrap(text, min, weight, maxWidth);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = this.ellipsize(lines[maxLines - 1], min, weight, maxWidth);
    }
    return { size: min, lines };
  }

  ellipsize(text, size, weight, maxWidth) {
    let s = text;
    while (s.length > 1 && this.width(s + '…', size, weight) > maxWidth) s = s.slice(0, -1);
    return s === text ? s : s.trimEnd() + (this.standard ? '...' : '…');
  }

  /**
   * Draw lines with their first baseline `size` below `top` (pdf y grows up).
   * Returns the y just below the block.
   */
  lines(page, lines, { x, top, size, weight = 'regular', color, leading = 1.15, align = 'left', width = 0, opacity }) {
    let y = top - size * 0.8;
    for (const line of lines) {
      const text = this.clean(line, weight);
      const w = this.fonts[weight].widthOfTextAtSize(text, size);
      const dx = align === 'center' ? (width - w) / 2 : align === 'right' ? width - w : 0;
      page.drawText(text, { x: x + dx, y, size, font: this.fonts[weight], color, opacity });
      y -= size * leading;
    }
    return y + size * leading - size * 0.25;
  }

  /** Letter-spaced uppercase label. */
  label(page, text, { x, y, size, weight = 'bold', color, tracking = 0.12, align = 'left', width = 0 }) {
    const chars = [...this.clean(String(text).toUpperCase(), weight)];
    const font = this.fonts[weight];
    const total = chars.reduce((acc, ch) => acc + font.widthOfTextAtSize(ch, size) + size * tracking, -size * tracking);
    let cx = align === 'center' ? x + (width - total) / 2 : align === 'right' ? x + width - total : x;
    for (const ch of chars) {
      page.drawText(ch, { x: cx, y, size, font, color });
      cx += font.widthOfTextAtSize(ch, size) + size * tracking;
    }
    return total;
  }
}

// --- colour --------------------------------------------------------------------

export function color(hex) {
  const h = hex.replace('#', '');
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

export function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White or near-black, whichever reads better on `bgHex`. */
export function onColor(bgHex) {
  return luminance(bgHex) > 0.4 ? '#14181F' : '#FFFFFF';
}

export const WHITE = rgb(1, 1, 1);

// --- QR ------------------------------------------------------------------------

/**
 * Draw a vector QR (quiet zone included) with its top-left corner at (x, top).
 * Adjacent dark modules in a row are merged into one rectangle.
 */
export function drawQr(page, data, { x, top, size, dark = '#000000', light = '#FFFFFF', margin = 2, ecLevel = 'M' }) {
  const qr = QRCode.create(String(data), { errorCorrectionLevel: ecLevel });
  const n = qr.modules.size;
  const total = n + margin * 2;
  const unit = size / total;
  if (light) page.drawRectangle({ x, y: top - size, width: size, height: size, color: color(light) });
  const fill = color(dark);
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && qr.modules.get(r, c)) c++;
      page.drawRectangle({
        x: x + (margin + start) * unit,
        y: top - (margin + r + 1) * unit,
        // A hair of overlap hides anti-aliasing seams between rows in viewers.
        width: (c - start) * unit + 0.01,
        height: unit + 0.01,
        color: fill
      });
    }
  }
}

/** Fit an embedded image inside a box, centred; returns the drawn rect. */
export function drawContained(page, image, { x, y, width, height, align = 'center' }) {
  const s = Math.min(width / image.width, height / image.height);
  const w = image.width * s;
  const h = image.height * s;
  const dx = align === 'left' ? 0 : align === 'right' ? width - w : (width - w) / 2;
  page.drawImage(image, { x: x + dx, y: y + (height - h) / 2, width: w, height: h });
  return { x: x + dx, y: y + (height - h) / 2, width: w, height: h };
}
