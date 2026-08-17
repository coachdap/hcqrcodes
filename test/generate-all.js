#!/usr/bin/env node
/**
 * Acceptance script: generates one of every output type into OUTPUT_DIR and prints
 * file sizes plus the QR version used, so the results can be checked visually.
 *
 *   npm test                       # writes to ./output
 *   OUTPUT_DIR=/output npm test    # inside the container
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import sharp from 'sharp';
import { generate } from '../src/core.js';
import { buildWifiPayload, buildVcardPayload } from '../src/payloads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(here, '..', 'output');
const LOGO_SVG = path.join(here, '..', 'assets', 'hc-logo.svg');

const HC_NAVY = '#0B1F3A';

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // A raster logo, derived from the vector one, to exercise the embed-and-warn path.
  const logoPngPath = path.join(OUTPUT_DIR, 'hc-logo.png');
  await sharp(await readFile(LOGO_SVG), { density: 600 }).resize(512, 512).png().toBuffer().then((b) => writeFile(logoPngPath, b));

  const cases = [
    {
      file: 'flyer-tryouts.svg',
      label: 'SVG · plain (flyer)',
      options: { data: 'https://hoopscollege.com/tryouts', format: 'svg', dark: HC_NAVY }
    },
    {
      file: 'signage-tryouts.png',
      label: 'PNG · plain (gym signage)',
      options: { data: 'https://hoopscollege.com/tryouts', format: 'png', size: 2048, dark: HC_NAVY }
    },
    {
      file: 'flyer-logo-vector.svg',
      label: 'SVG · SVG logo (pure vector)',
      options: { data: 'https://hoopscollege.com/tryouts', format: 'svg', dark: HC_NAVY, logo: LOGO_SVG, logoScale: 0.2 }
    },
    {
      file: 'flyer-logo-raster.svg',
      label: 'SVG · PNG logo (embeds raster)',
      options: { data: 'https://hoopscollege.com/tryouts', format: 'svg', dark: HC_NAVY, logo: logoPngPath }
    },
    {
      file: 'jersey-tag-logo.png',
      label: 'PNG · logo + capped scale',
      options: {
        data: 'https://chaseexcellence.org/register',
        format: 'png',
        size: 1024,
        dark: HC_NAVY,
        logo: LOGO_SVG,
        logoScale: 0.4 // deliberately over the cap; should clamp to 0.25 and warn
      }
    },
    {
      file: 'gym-wifi.svg',
      label: 'SVG · WiFi helper',
      options: {
        data: buildWifiPayload({ ssid: 'HC Gym; Guest', password: 'hoops:2026', encryption: 'WPA', hidden: false }),
        format: 'svg',
        dark: HC_NAVY
      }
    },
    {
      file: 'coach-vcard.svg',
      label: 'SVG · vCard helper',
      options: {
        data: buildVcardPayload({
          name: 'Aram Parunak',
          org: 'Hoops College',
          title: 'Director',
          phone: '+1-555-0142',
          email: 'info@hoopscollege.com',
          url: 'https://hoopscollege.com'
        }),
        format: 'svg',
        dark: HC_NAVY
      }
    }
  ];

  const rows = [];
  const allWarnings = [];

  for (const { file, label, options } of cases) {
    const result = await generate(options, { allowedLogoDir: null });
    const target = path.join(OUTPUT_DIR, file);
    await writeFile(target, result.buffer);

    rows.push({
      file,
      label,
      bytes: result.buffer.length,
      version: result.version,
      ecLevel: result.ecLevel,
      vector: file.endsWith('.svg') ? (result.buffer.includes('<image') ? 'raster embedded' : 'pure vector') : '—'
    });
    for (const w of result.warnings) allWarnings.push(`${file}: ${w}`);
  }

  // Batch zip, matching what POST /generate/batch produces.
  const batchItems = [
    { name: 'tryouts', data: 'https://hoopscollege.com/tryouts' },
    { name: 'camps', data: 'https://hoopscollege.com/camps' },
    { name: 'chase-register', data: 'https://chaseexcellence.org/register' }
  ];
  const zipPath = path.join(OUTPUT_DIR, 'batch.zip');
  const zipBytes = await buildZip(batchItems, zipPath);
  rows.push({
    file: 'batch.zip',
    label: `ZIP · batch of ${batchItems.length} + manifest`,
    bytes: zipBytes,
    version: '—',
    ecLevel: '—',
    vector: '—'
  });

  print(rows, allWarnings);

  // Capacity guard: this must be rejected, since a logo forces ecLevel H (1273 bytes).
  try {
    await generate({ data: 'x'.repeat(1500), logo: LOGO_SVG }, { allowedLogoDir: null });
    console.error('\nFAIL: oversized payload at ecLevel H was accepted');
    process.exitCode = 1;
  } catch (err) {
    console.log(`\nCapacity guard OK — ${err.message}`);
  }
}

async function buildZip(items, target) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  archive.on('data', (c) => chunks.push(c));

  const manifest = [];
  for (const { name, ...options } of items) {
    const result = await generate({ ...options, format: 'svg', dark: HC_NAVY }, { allowedLogoDir: null });
    archive.append(result.buffer, { name: `${name}.svg` });
    manifest.push({ filename: `${name}.svg`, version: result.version, ecLevel: result.ecLevel, bytes: result.bytes });
  }
  archive.append(JSON.stringify({ count: manifest.length, items: manifest }, null, 2), { name: 'manifest.json' });
  await archive.finalize();

  const buffer = Buffer.concat(chunks);
  await writeFile(target, buffer);
  return buffer.length;
}

function print(rows, warnings) {
  const widths = {
    file: Math.max(4, ...rows.map((r) => r.file.length)),
    label: Math.max(6, ...rows.map((r) => r.label.length)),
    bytes: Math.max(5, ...rows.map((r) => r.bytes.toLocaleString().length))
  };

  console.log(`\nqrgen output → ${OUTPUT_DIR}\n`);
  console.log(
    `${'FILE'.padEnd(widths.file)}  ${'TYPE'.padEnd(widths.label)}  ${'BYTES'.padStart(widths.bytes)}  VER  EC   NOTE`
  );
  console.log('-'.repeat(widths.file + widths.label + widths.bytes + 22));
  for (const r of rows) {
    console.log(
      `${r.file.padEnd(widths.file)}  ${r.label.padEnd(widths.label)}  ${r.bytes
        .toLocaleString()
        .padStart(widths.bytes)}  ${String(r.version).padStart(3)}  ${String(r.ecLevel).padEnd(3)}  ${r.vector}`
    );
  }

  if (warnings.length) {
    console.log('\nWarnings (returned as X-QR-Warning over HTTP):');
    for (const w of warnings) console.log(`  · ${w}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
