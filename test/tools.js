#!/usr/bin/env node
/**
 * Acceptance script for the utilities: boots the app on a free port with a
 * throwaway data directory and drives every tool end to end over HTTP,
 * asserting on the real outputs (magic bytes, pixel sizes, page counts, zip
 * entries, job lifecycle, check-in and brand-kit state).
 *
 *   npm run test:tools
 *   docker compose exec qrgen node test/tools.js
 *
 * Needs ffmpeg, pdftoppm and gs on PATH (all in the Docker image).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'qrgen-tools-test-'));
process.env.QRGEN_DATA_DIR = dataDir;
const { createApp } = await import('../src/server.js');

const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
let failed = 0;
async function check(label, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ✓ ${label.padEnd(44)} ${detail ?? ''}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label.padEnd(44)} ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function form(fields = {}, files = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
  for (const { field = 'files', name, type, buffer } of files) f.append(field, new Blob([buffer], { type }), name);
  return f;
}
async function post(route, body) {
  const json = !(body instanceof FormData);
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: json ? { 'Content-Type': 'application/json' } : {},
    body: json ? JSON.stringify(body) : body
  });
  return res;
}
async function ok(res) {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
const zipNames = (buf) => {
  const names = [];
  for (let i = 0; i < buf.length - 46; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const len = buf.readUInt16LE(i + 28);
      names.push(buf.subarray(i + 46, i + 46 + len).toString('utf8'));
    }
  }
  return names;
};

// --- fixtures ----------------------------------------------------------------

const photo = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#3a6ea5' } })
  .composite([{ input: Buffer.from('<svg width="2400" height="1600"><circle cx="1600" cy="600" r="380" fill="#f5b041"/></svg>') }])
  .withMetadata({ exif: { IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '42/1 20/1 0/1' } } })
  .jpeg({ quality: 95 })
  .toBuffer();
const png = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 11, g: 31, b: 58, alpha: 0.6 } } }).png().toBuffer();
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="58" fill="#0B1F3A"/></svg>');
const pdfOf = async (pages) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 24 });
  return Buffer.from(await doc.save());
};
const pdf5 = await pdfOf(5);
const pdf2 = await pdfOf(2);
const videoPath = path.join(dataDir, 'clip.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoPath]);
const { readFile } = await import('node:fs/promises');
const video = await readFile(videoPath);

const JPG = { name: 'team photo.jpg', type: 'image/jpeg', buffer: photo };
const PNG = { name: 'badge.png', type: 'image/png', buffer: png };
const SVG = { name: 'logo.svg', type: 'image/svg+xml', buffer: svg };

// --- images ------------------------------------------------------------------

console.log('images');
await check('convert JPG → WebP, 800 wide', async () => {
  const out = await ok(await post('/image/convert', form({ format: 'webp', width: 800 }, [JPG])));
  const m = await sharp(out).metadata();
  assert(m.format === 'webp' && m.width === 800 && m.height === 533, `${m.format} ${m.width}×${m.height}`);
  return `${m.width}×${m.height}, ${out.length} B`;
});
await check('convert SVG → PNG at 1024 is crisp', async () => {
  const out = await ok(await post('/image/convert', form({ format: 'png', width: 1024 }, [SVG])));
  const m = await sharp(out).metadata();
  assert(m.width === 1024, `${m.width}`);
  return `${m.width}×${m.height}`;
});
await check('convert two files → zip', async () => {
  const names = zipNames(await ok(await post('/image/convert', form({ format: 'jpeg' }, [JPG, PNG]))));
  assert(names.length === 2 && names.every((n) => n.endsWith('.jpg')), names.join(','));
  return names.join(', ');
});
await check('compress strips EXIF and GPS', async () => {
  const res = await post('/image/compress', form({ quality: 70, maxEdge: 1280 }, [JPG]));
  const out = await ok(res);
  const m = await sharp(out).metadata();
  assert(!m.exif, 'EXIF survived');
  assert(res.headers.get('x-had-location') === 'true', 'GPS not detected in source');
  assert(m.width === 1280, `${m.width}`);
  return `${photo.length} → ${out.length} B`;
});
await check('HEIC is refused with a clear message', async () => {
  const res = await post('/image/compress', form({}, [{ name: 'IMG_0001.HEIC', type: 'image/heic', buffer: Buffer.from('not really heic') }]));
  assert(res.status === 415, `${res.status}`);
});
await check('social pack: 3 presets, exact sizes', async () => {
  const zip = await ok(await post('/image/social', form({ presets: 'instagram-square,instagram-story,youtube-thumbnail', mode: 'blur' }, [JPG])));
  const names = zipNames(zip);
  assert(names.length === 3 && names.some((n) => n.includes('1080x1920')), names.join(','));
  return names.length + ' files';
});
await check('favicon pack contents', async () => {
  const names = zipNames(await ok(await post('/image/favicon', form({ padding: 10, background: '#0B1F3A' }, [SVG]))));
  for (const n of ['favicon.ico', 'apple-touch-icon.png', 'android-chrome-512x512.png', 'site.webmanifest', 'favicon.svg', 'head-snippet.html']) {
    assert(names.includes(n), `missing ${n}`);
  }
  return names.length + ' files';
});
await check('unsafe SVG is refused', async () => {
  const bad = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await post('/image/convert', form({}, [{ name: 'x.svg', type: 'image/svg+xml', buffer: bad }]));
  assert(res.status === 400, `${res.status}`);
});

// --- PDF ---------------------------------------------------------------------

console.log('pdf');
const pages = async (buf) => (await PDFDocument.load(buf)).getPageCount();
await check('merge PDF + PDF + image', async () => {
  const out = await ok(await post('/pdf/merge', form({}, [{ name: 'a.pdf', type: 'application/pdf', buffer: pdf5 }, { name: 'b.pdf', type: 'application/pdf', buffer: pdf2 }, JPG])));
  assert((await pages(out)) === 8, `${await pages(out)} pages`);
  return '8 pages';
});
await check('split "1-2, 4, 5-" → 3 PDFs', async () => {
  const names = zipNames(await ok(await post('/pdf/split', form({ ranges: '1-2, 4, 5-' }, [{ name: 'w.pdf', type: 'application/pdf', buffer: pdf5 }]))));
  assert(names.length === 3, names.join(','));
  return names.join(', ');
});
await check('extract + combine + rotate → one PDF', async () => {
  const out = await ok(await post('/pdf/split', form({ ranges: '2,4', combine: 'true', rotate: 90 }, [{ name: 'w.pdf', type: 'application/pdf', buffer: pdf5 }])));
  const doc = await PDFDocument.load(out);
  assert(doc.getPageCount() === 2 && doc.getPage(0).getRotation().angle === 90, 'wrong pages/rotation');
});
await check('bad range is a 400', async () => {
  const res = await post('/pdf/split', form({ ranges: '9-12' }, [{ name: 'w.pdf', type: 'application/pdf', buffer: pdf5 }]));
  assert(res.status === 400, `${res.status}`);
});
await check('compress (Ghostscript)', async () => {
  const res = await post('/pdf/compress', form({ level: 'small' }, [{ name: 'w.pdf', type: 'application/pdf', buffer: pdf5 }]));
  const out = await ok(res);
  assert(out.subarray(0, 4).toString() === '%PDF', 'not a PDF');
  return `${res.headers.get('x-original-bytes')} → ${res.headers.get('x-compressed-bytes')} B`;
});
await check('PDF → PNG pages 2-3 at 72 dpi', async () => {
  const names = zipNames(await ok(await post('/pdf/to-images', form({ ranges: '2-3', dpi: 72 }, [{ name: 'w.pdf', type: 'application/pdf', buffer: pdf5 }]))));
  assert(names.length === 2 && names[0].endsWith('page-2.png'), names.join(','));
  return names.join(', ');
});
await check('images → PDF', async () => {
  const out = await ok(await post('/pdf/from-images', form({ pageSize: 'a4' }, [JPG, PNG])));
  assert((await pages(out)) === 2, 'page count');
});

// --- video -------------------------------------------------------------------

console.log('video');
async function runJob(fields) {
  const res = await post('/video/jobs', form(fields, [{ name: 'clip.mp4', type: 'video/mp4', buffer: video }]));
  if (res.status !== 202) throw new Error(`${res.status} ${await res.text()}`);
  let job = await res.json();
  for (let i = 0; i < 120 && (job.status === 'queued' || job.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 250));
    job = await (await fetch(`${BASE}/video/jobs/${job.id}`)).json();
  }
  assert(job.status === 'done', `${job.status}: ${job.error}`);
  const out = await ok(await fetch(`${BASE}/video/jobs/${job.id}/download`));
  return { job, out };
}
await check('compress to 480p MP4', async () => {
  const { job, out } = await runJob({ op: 'compress', maxHeight: 480, quality: 'small' });
  assert(job.filename.endsWith('.mp4') && out.length > 1000, job.filename);
  return `${job.source.bytes} → ${out.length} B`;
});
await check('GIF from 1s–3s', async () => {
  const { out } = await runJob({ op: 'gif', start: '1', end: '0:03', width: 320, fps: 10 });
  assert(out.subarray(0, 3).toString() === 'GIF', 'not a GIF');
  return `${out.length} B`;
});
await check('4 thumbnails → zip', async () => {
  const { out } = await runJob({ op: 'frames', count: 4 });
  assert(zipNames(out).length === 4, 'frame count');
});
await check('MP3 audio', async () => {
  const { job } = await runJob({ op: 'mp3' });
  assert(job.filename.endsWith('.mp3'), job.filename);
});
await check('unknown job is a 404', async () => {
  assert((await fetch(`${BASE}/video/jobs/nope`)).status === 404, 'status');
});

// --- print, check-in, brand ----------------------------------------------------

console.log('print · check-in · brand');
await check('brand kit is seeded', async () => {
  const { brands } = await (await fetch(`${BASE}/brand`)).json();
  assert(brands.some((b) => b.id === 'hoops-college' && b.logos.length === 1), 'HC brand/logo missing');
  return brands.map((b) => b.name).join(', ');
});
await check('brand: patch colours, add + export logo', async () => {
  const res = await fetch(`${BASE}/brand/chase-excellence`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colors: [{ name: 'Black', hex: '#111111' }] }) });
  assert(res.ok, `${res.status}`);
  const logo = await (await post('/brand/chase-excellence/logos', form({ name: 'Mark' }, [SVG]))).json();
  const out = await ok(await fetch(`${BASE}/brand/chase-excellence/logos/${logo.id}?format=png&size=256`));
  assert((await sharp(out).metadata()).width === 256, 'logo size');
});
await check('flyer PDF + PNG for every size', async () => {
  for (const size of ['letter', 'square', 'story', 'landscape']) {
    const fields = { headline: 'Fall Tryouts', subheadline: 'Grades 6–12', date: 'Sat Nov 8', location: 'HC Gym', price: '$25', details: 'Bring water\nWear sneakers', url: 'https://hoopscollege.com/tryouts', size };
    const pdf = await ok(await post('/print/flyer', form(fields)));
    assert(pdf.subarray(0, 4).toString() === '%PDF', `${size} pdf`);
    const pngOut = await ok(await post('/print/flyer', form({ ...fields, output: 'png' })));
    assert((await sharp(pngOut).metadata()).format === 'png', `${size} png`);
  }
  return '4 sizes';
});
await check('photo flyer', async () => {
  const out = await ok(await post('/print/flyer', form({ template: 'photo', headline: 'Summer Camp', url: 'https://hoopscollege.com/camp', output: 'preview' }, [{ ...JPG, field: 'photo' }])));
  return `${(await sharp(out).metadata()).width}px preview`;
});

let eventId;
await check('check-in: create event + import roster', async () => {
  const ev = await (await post('/checkin/events', { name: 'Fall Tryouts', date: '2026-11-08' })).json();
  eventId = ev.id;
  const r = await (await post(`/checkin/events/${eventId}/roster`, { rows: [{ name: 'Jordan Lee', group: 'U14' }, { name: 'Sam Rivera', group: 'U16', id: 'mb-1042' }] })).json();
  assert(r.added === 2, JSON.stringify(r));
});
await check('check-in: scan badge, repeat, unknown', async () => {
  const first = await (await post(`/checkin/events/${eventId}/scan`, { code: 'HC:MB-1042' })).json();
  const again = await (await post(`/checkin/events/${eventId}/scan`, { code: 'https://hoopscollege.com/p/mb-1042' })).json();
  const unknown = await (await post(`/checkin/events/${eventId}/scan`, { code: 'HC:NOPE' })).json();
  assert(first.status === 'checked-in' && again.status === 'already' && unknown.status === 'unknown', `${first.status}/${again.status}/${unknown.status}`);
  return `${first.checkedIn}/${first.attendees} here`;
});
await check('check-in: walk-in + CSV export', async () => {
  await post(`/checkin/events/${eventId}/walkin`, { name: '=HYPERLINK("x")' });
  const csv = (await ok(await fetch(`${BASE}/checkin/events/${eventId}/export.csv`))).toString('utf8');
  assert(csv.includes("'=HYPERLINK"), 'formula not neutralised');
  assert(csv.split('\n').filter(Boolean).length === 4, 'row count');
});
await check('name tags from the event, every layout', async () => {
  for (const layout of ['badge-4x3', 'badge-5395', 'square-2x2', 'label-5160', 'roster']) {
    const out = await ok(await post('/print/tags', { eventId, layout }));
    assert(out.subarray(0, 4).toString() === '%PDF', layout);
  }
  return '5 layouts';
});
await check('tags: 31 labels → 2 pages of 5160', async () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ name: `Player ${i + 1}`, id: `P${i + 1}` }));
  const out = await ok(await post('/print/tags', { rows, layout: 'label-5160' }));
  assert((await pages(out)) === 2, 'pages');
});

// --- guards --------------------------------------------------------------------

console.log('guards');
await check('external caller without token → 401', async () => {
  const res = await fetch(`${BASE}/image/convert`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.5' }, body: form({}, [JPG]) });
  assert(res.status === 401 || res.status === 503, `${res.status}`);
});
await check('wrong file type → 415', async () => {
  const res = await post('/pdf/compress', form({}, [JPG]));
  assert(res.status === 415, `${res.status}`);
});

server.close();
await rm(dataDir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} of ${passed + failed} FAILED` : `all ${passed} passed`}`);
process.exit(failed ? 1 : 0);
