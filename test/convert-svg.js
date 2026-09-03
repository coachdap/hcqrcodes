#!/usr/bin/env node
/**
 * Acceptance script for the SVG → WebP/PNG utility. Converts the HC logo and a
 * couple of synthetic documents through every code path — artwork crop, custom
 * crop with padding, explicit output size, PNG, opaque background — writes the
 * results into OUTPUT_DIR and checks the pixel sizes against what was asked for.
 *
 *   npm run test:convert                      # writes to ./output
 *   docker compose exec qrgen node test/convert-svg.js
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { analyzeSvg, convertSvg } from '../src/svgconvert.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(here, '..', 'output');
const LOGO_SVG = path.join(here, '..', 'assets', 'hc-logo.svg');

// A 100-unit viewBox whose artwork is a 30×40 stroked rect at (10,20); with the
// 4-unit stroke the visible bounds are (8,18)–(42,62).
const RECT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="500" height="500">' +
  '<rect x="10" y="20" width="30" height="40" fill="#0B1F3A" stroke="#e0a020" stroke-width="4"/></svg>';

// Millimetre units and an offset viewBox: the two cases that break naive px maths.
const MM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="200 100 100 50">' +
  '<circle cx="250" cy="125" r="20" fill="#0B1F3A"/></svg>';

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const logo = await readFile(LOGO_SVG, 'utf8');

  console.log('analyze');
  const rect = analyzeSvg({ svg: RECT_SVG });
  check('viewBox canvas', `${rect.canvas.width}×${rect.canvas.height}`, '100×100');
  check('artwork bounds include stroke', `${rect.bbox.x},${rect.bbox.y} ${rect.bbox.width}×${rect.bbox.height}`, '8,18 34×44');
  const mm = analyzeSvg({ svg: MM_SVG });
  check('mm document px size', `${mm.width}×${mm.height}`, '378×189');
  check('offset viewBox canvas origin', `${mm.canvas.x},${mm.canvas.y}`, '200,100');
  check('bbox in viewBox space', `${mm.bbox.x},${mm.bbox.y}`, '230,105');

  const cases = [
    { file: 'hc-logo.webp', label: 'WebP · artwork crop, 2×', input: { svg: logo, crop: 'artwork', scale: 2 } },
    { file: 'hc-logo-1024.webp', label: 'WebP · width 1024, white bg', input: { svg: logo, width: 1024, background: '#FFFFFF' }, expect: { width: 1024 } },
    { file: 'hc-logo.png', label: 'PNG · full canvas', input: { svg: logo, crop: 'original', format: 'png' } },
    { file: 'hc-logo-lossless.webp', label: 'WebP · lossless', input: { svg: logo, lossless: true } },
    {
      file: 'rect-custom.webp',
      label: 'WebP · custom crop + padding, 10×',
      input: { svg: RECT_SVG, crop: 'custom', cropRect: { x: 8, y: 18, width: 34, height: 44 }, padding: 3, scale: 10 },
      expect: { width: 400, height: 500 }
    },
    {
      file: 'rect-boxed.webp',
      label: 'WebP · fixed 300×300 letterbox',
      input: { svg: RECT_SVG, crop: 'artwork', width: 300, height: 300, background: '#0B1F3A' },
      expect: { width: 300, height: 300 }
    },
    { file: 'mm-artwork.png', label: 'PNG · mm units + offset viewBox, 4×', input: { svg: MM_SVG, crop: 'artwork', format: 'png', scale: 4 }, expect: { width: 160, height: 160 } }
  ];

  console.log('\nconvert');
  const rows = [];
  for (const { file, label, input, expect } of cases) {
    const result = await convertSvg(input);
    await writeFile(path.join(OUTPUT_DIR, file), result.buffer);
    const meta = await sharp(result.buffer).metadata();
    rows.push({ file, label, bytes: result.bytes, size: `${meta.width}×${meta.height}`, format: meta.format, warnings: result.warnings });
    if (expect?.width) check(`${file} width`, meta.width, expect.width);
    if (expect?.height) check(`${file} height`, meta.height, expect.height);
  }

  console.log(`\nutility output → ${OUTPUT_DIR}\n`);
  const w = Math.max(...rows.map((r) => r.file.length));
  const l = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(`${r.file.padEnd(w)}  ${r.label.padEnd(l)}  ${r.bytes.toLocaleString().padStart(9)}  ${r.size.padStart(10)}  ${r.format}`);
    for (const warning of r.warnings) console.log(`${''.padEnd(w)}  · ${warning}`);
  }

  console.log('\nguards');
  await expectError('external image is refused', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>' }, 'UNSAFE_SVG');
  await expectError('script is refused', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>' }, 'UNSAFE_SVG');
  await expectError('oversized output is refused', { svg: RECT_SVG, scale: 64, crop: 'original' }, 'OUTPUT_TOO_LARGE');
  await expectError('custom crop needs a rect', { svg: RECT_SVG, crop: 'custom' }, 'ZodError');

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

async function expectError(label, input, code) {
  try {
    await convertSvg(input);
    failures++;
    console.log(`  FAIL ${label}: accepted`);
  } catch (err) {
    const got = err.code ?? err.name;
    check(label, got, code);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
