/**
 * PDF tools: merge, split/extract, compress (Ghostscript), PDF → images
 * (Poppler's pdftoppm) and images → PDF (pdf-lib).
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, degrees } from 'pdf-lib';
import { httpError, run, withTempDir, stem } from './common.js';

const MAX_PAGES = 500;
const MAX_RENDER_PAGES = 60;

const PAGE_SIZES = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  legal: [612, 1008]
};

async function load(file) {
  try {
    const doc = await PDFDocument.load(file.buffer, { updateMetadata: false });
    if (doc.getPageCount() > MAX_PAGES) throw httpError(400, 'TOO_MANY_PAGES', `PDFs are limited to ${MAX_PAGES} pages.`);
    return doc;
  } catch (err) {
    if (err.status) throw err;
    if (/encrypt/i.test(err.message)) {
      throw httpError(422, 'PDF_ENCRYPTED', `"${file.originalname}" is password-protected. Remove the password and try again.`);
    }
    throw httpError(422, 'UNREADABLE_PDF', `"${file.originalname}" could not be read as a PDF.`);
  }
}

const isPdf = (f) => f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname);

/** Merge PDFs (and images, one per page) in the order given. */
export async function mergePdfs(files, { pageSize = 'letter' } = {}) {
  const out = await PDFDocument.create();
  for (const file of files) {
    if (isPdf(file)) {
      const src = await load(file);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else {
      await addImagePage(out, file, { pageSize, margin: 36 });
    }
  }
  if (out.getPageCount() > MAX_PAGES) throw httpError(400, 'TOO_MANY_PAGES', `The merged PDF would exceed ${MAX_PAGES} pages.`);
  return Buffer.from(await out.save());
}

/**
 * Parse "1-3, 5, 8-" against a page count into 0-based index groups.
 * Each comma-separated part becomes one output document.
 */
export function parseRanges(spec, pageCount) {
  const groups = [];
  for (const raw of String(spec).split(/[,;]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\d*)\s*(?:-|–|to)\s*(\d*)$/i) ?? part.match(/^(\d+)$/);
    if (!m) throw httpError(400, 'BAD_RANGE', `"${part}" is not a page or range. Use forms like 3, 1-4 or 8-.`);
    const single = m.length === 2;
    const from = single ? Number(m[1]) : m[1] ? Number(m[1]) : 1;
    const to = single ? from : m[2] ? Number(m[2]) : pageCount;
    if (from < 1 || to > pageCount || from > to) {
      throw httpError(400, 'BAD_RANGE', `"${part}" is outside this document's ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    }
    groups.push({ label: from === to ? `p${from}` : `p${from}-${to}`, pages: Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i) });
  }
  if (!groups.length) throw httpError(400, 'BAD_RANGE', 'Enter at least one page or range.');
  return groups;
}

/**
 * @param {object} opts  { mode: 'ranges'|'each', ranges, combine: boolean, rotate: 0|90|180|270 }
 * @returns {Promise<Array<{name, buffer}>>}
 */
export async function splitPdf(file, { mode, ranges, combine, rotate = 0 }) {
  const src = await load(file);
  const count = src.getPageCount();
  let groups =
    mode === 'each'
      ? src.getPageIndices().map((i) => ({ label: `p${i + 1}`, pages: [i] }))
      : parseRanges(ranges, count);
  if (combine && groups.length > 1) {
    groups = [{ label: 'extract', pages: groups.flatMap((g) => g.pages) }];
  }

  const base = stem(file.originalname, 'document');
  const entries = [];
  for (const group of groups) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, group.pages);
    for (const p of pages) {
      if (rotate) p.setRotation(degrees((p.getRotation().angle + rotate) % 360));
      out.addPage(p);
    }
    entries.push({ name: `${base}-${group.label}.pdf`, buffer: Buffer.from(await out.save()) });
  }
  return entries;
}

const GS_PRESETS = {
  // Ghostscript's own presets: downsampled image resolution 72 / 150 / 300 dpi.
  small: '/screen',
  balanced: '/ebook',
  print: '/printer'
};

/** Compress with Ghostscript. Returns the original if re-writing made it bigger. */
export async function compressPdf(file, { level = 'balanced' }) {
  await load(file); // validates and gives a clean error for encrypted files
  return withTempDir(async (dir) => {
    const input = path.join(dir, 'in.pdf');
    const output = path.join(dir, 'out.pdf');
    await writeFile(input, file.buffer);
    await run(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.6',
        `-dPDFSETTINGS=${GS_PRESETS[level] ?? GS_PRESETS.balanced}`,
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        '-dSAFER',
        '-dDetectDuplicateImages=true',
        `-sOutputFile=${output}`,
        input
      ],
      { timeoutMs: 100_000 }
    );
    const buffer = await readFile(output);
    const before = file.buffer.length;
    const smaller = buffer.length < before;
    return { buffer: smaller ? buffer : file.buffer, before, after: smaller ? buffer.length : before, improved: smaller };
  });
}

/**
 * Render pages to PNG/JPEG with pdftoppm.
 * @param {object} opts  { format: 'png'|'jpeg', dpi, ranges? }
 */
export async function pdfToImages(file, { format = 'png', dpi = 150, ranges }) {
  const src = await load(file);
  const count = src.getPageCount();
  const pages = ranges ? [...new Set(parseRanges(ranges, count).flatMap((g) => g.pages))].sort((a, b) => a - b) : src.getPageIndices();
  if (pages.length > MAX_RENDER_PAGES) {
    throw httpError(400, 'TOO_MANY_PAGES', `Render at most ${MAX_RENDER_PAGES} pages at a time; pick a page range.`);
  }

  return withTempDir(async (dir) => {
    const input = path.join(dir, 'in.pdf');
    await writeFile(input, file.buffer);
    const base = stem(file.originalname, 'page');
    const entries = [];
    // pdftoppm takes one contiguous range per call; group the selection.
    for (const [first, last] of contiguous(pages)) {
      await run(
        'pdftoppm',
        [
          format === 'jpeg' ? '-jpeg' : '-png',
          ...(format === 'jpeg' ? ['-jpegopt', 'quality=88'] : []),
          '-r',
          String(dpi),
          '-f',
          String(first + 1),
          '-l',
          String(last + 1),
          input,
          path.join(dir, 'out')
        ],
        { timeoutMs: 100_000 }
      );
    }
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const files = (await readdir(dir)).filter((f) => f.startsWith('out-')).sort();
    for (const f of files) {
      const n = Number(f.match(/out-(\d+)\./)?.[1]);
      entries.push({ name: `${base}-page-${String(n).padStart(String(count).length, '0')}.${ext}`, buffer: await readFile(path.join(dir, f)) });
    }
    return entries;
  });
}

function contiguous(sorted) {
  const runs = [];
  for (const p of sorted) {
    const last = runs.at(-1);
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs;
}

/**
 * One image per page. `pageSize: 'fit'` makes each page exactly the image;
 * otherwise the image is fitted inside the page with a margin.
 */
export async function imagesToPdf(files, { pageSize = 'letter', margin = 36 }) {
  const out = await PDFDocument.create();
  for (const file of files) await addImagePage(out, file, { pageSize, margin });
  return Buffer.from(await out.save());
}

async function addImagePage(doc, file, { pageSize, margin }) {
  let image;
  try {
    const pipeline = sharp(file.buffer, { limitInputPixels: 60_000_000, failOn: 'none' }).rotate();
    const meta = await pipeline.metadata();
    // Cap at ~300 dpi on a letter page so phone photos don't balloon the PDF.
    const resized = pipeline.resize({ width: 2550, height: 3300, fit: 'inside', withoutEnlargement: true });
    image = meta.hasAlpha
      ? await doc.embedPng(await resized.png().toBuffer())
      : await doc.embedJpg(await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer());
  } catch {
    throw httpError(422, 'UNREADABLE_IMAGE', `"${file.originalname}" could not be read as an image.`);
  }

  if (pageSize === 'fit') {
    // 150 dpi equivalent page size keeps the physical size sensible.
    const w = (image.width * 72) / 150;
    const h = (image.height * 72) / 150;
    doc.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    return;
  }

  let [pw, ph] = PAGE_SIZES[pageSize] ?? PAGE_SIZES.letter;
  // Landscape images get a landscape page.
  if (image.width > image.height) [pw, ph] = [ph, pw];
  const page = doc.addPage([pw, ph]);
  const scale = Math.min((pw - margin * 2) / image.width, (ph - margin * 2) / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

export async function pageCount(file) {
  return (await load(file)).getPageCount();
}
