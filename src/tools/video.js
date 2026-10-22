/**
 * Video tools on ffmpeg, run as background jobs.
 *
 * Encoding a highlight clip can outlast both Apache's ProxyTimeout and
 * Cloudflare's 100 s origin limit, so a request only uploads and queues; the
 * browser polls for progress and fetches the result when it is ready. Jobs and
 * their files live in memory/tmp and expire after JOB_TTL_MS.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { gate, httpError, run, stem } from './common.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const MAX_DURATION_S = Number(process.env.QRGEN_VIDEO_MAX_SECONDS ?? 600);
const FFMPEG_TIMEOUT_MS = Number(process.env.QRGEN_VIDEO_TIMEOUT_MS ?? 15 * 60 * 1000);

// One encode at a time: ffmpeg will happily take every core on the box.
const encoder = gate(1, 6);
const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
      if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 60_000).unref();

const QUALITY_CRF = { small: 30, balanced: 26, high: 21 };

export async function probe(file) {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 20_000 }
  ).catch((err) => {
    if (err.code === 'TOOL_MISSING') throw err;
    throw httpError(422, 'UNREADABLE_VIDEO', 'That file could not be read as a video.');
  });
  const info = JSON.parse(out.toString('utf8'));
  const video = info.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw httpError(422, 'UNREADABLE_VIDEO', 'That file has no video track.');
  return {
    duration: Number(info.format?.duration) || 0,
    width: video.width,
    height: video.height,
    hasAudio: info.streams.some((s) => s.codec_type === 'audio')
  };
}

/** Accepts "75", "1:15", "0:01:15.5". */
export function parseTime(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const parts = String(v).trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) throw httpError(400, 'BAD_TIME', `"${v}" is not a time. Use seconds or m:ss.`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Queue a job for an uploaded file (already on disk). Returns the public view.
 * @param {object} opts  { op, start, end, quality, maxHeight, mute, width, fps, count, times }
 */
export async function createJob(upload, opts) {
  const meta = await probe(upload.path);
  if (meta.duration > MAX_DURATION_S) {
    throw httpError(400, 'VIDEO_TOO_LONG', `Videos are limited to ${Math.round(MAX_DURATION_S / 60)} minutes.`);
  }

  const id = randomBytes(12).toString('hex');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qrgen-video-'));
  const job = {
    id,
    op: opts.op,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
    source: { name: upload.originalname, bytes: upload.size, ...meta },
    dir,
    input: path.join(dir, 'input'),
    output: null,
    filename: null,
    contentType: null,
    bytes: 0,
    error: null
  };
  // Move the upload out of multer's hands so its cleanup doesn't delete it.
  await rename(upload.path, job.input);
  jobs.set(id, job);

  encoder(() => runJob(job, opts)).catch((err) => {
    job.status = 'error';
    job.error = err.status && err.status < 500 ? err.message : err.code === 'TIMEOUT' ? err.message : 'ffmpeg could not process this video.';
    if (err.stderr) console.error('[qrgen] video', id, err.stderr);
    else if (!err.status) console.error('[qrgen] video', id, err);
  });
  return view(job);
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) throw httpError(404, 'JOB_NOT_FOUND', 'That job does not exist or has expired (results are kept 30 minutes).');
  return job;
}

export function view(job) {
  return {
    id: job.id,
    op: job.op,
    status: job.status,
    progress: Math.round(job.progress * 100) / 100,
    source: job.source,
    filename: job.filename,
    bytes: job.bytes,
    error: job.error,
    expiresAt: new Date(job.createdAt + JOB_TTL_MS).toISOString()
  };
}

async function runJob(job, opts) {
  job.status = 'running';
  const { duration } = job.source;
  const start = Math.min(opts.start ?? 0, Math.max(0, duration - 0.1));
  const end = opts.end && opts.end > start ? Math.min(opts.end, duration) : duration;
  const span = Math.max(0.1, end - start);
  const base = stem(job.source.name, 'video');
  const trim = [...(start ? ['-ss', String(start)] : []), '-i', job.input, ...(end < duration ? ['-t', String(span)] : [])];

  const progress = (expected) => (chunk) => {
    const m = String(chunk).match(/out_time_(?:us|ms)=(\d+)/g);
    if (!m) return;
    const us = Number(m.at(-1).split('=')[1]);
    job.progress = Math.min(0.99, us / 1e6 / expected);
  };
  const ff = (args, expected = span) =>
    run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args], {
      timeoutMs: FFMPEG_TIMEOUT_MS,
      onStdout: progress(expected)
    });

  if (opts.op === 'compress') {
    const out = path.join(job.dir, 'out.mp4');
    const h = opts.maxHeight;
    // Never upscale; keep dimensions even for yuv420p.
    const scale = h ? `scale=-2:'min(${h},ih)':flags=lanczos` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    await ff([
      ...trim,
      '-vf', scale,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(QUALITY_CRF[opts.quality] ?? 26),
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      ...(opts.mute || !job.source.hasAudio ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']),
      '-movflags', '+faststart',
      out
    ]);
    return finish(job, out, `${base}-compressed.mp4`, 'video/mp4');
  }

  if (opts.op === 'gif') {
    const out = path.join(job.dir, 'out.gif');
    const seconds = Math.min(span, 20);
    const filter =
      `fps=${opts.fps},scale=${opts.width}:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    await ff([...(start ? ['-ss', String(start)] : []), '-t', String(seconds), '-i', job.input, '-filter_complex', filter, '-loop', '0', out], seconds);
    return finish(job, out, `${base}.gif`, 'image/gif');
  }

  if (opts.op === 'mp3') {
    if (!job.source.hasAudio) throw httpError(422, 'NO_AUDIO', 'This video has no audio track.');
    const out = path.join(job.dir, 'out.mp3');
    await ff([...trim, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', out]);
    return finish(job, out, `${base}.mp3`, 'audio/mpeg');
  }

  if (opts.op === 'frames') {
    // Explicit timestamps, or N frames spread evenly across the clip.
    const times = opts.times?.length
      ? opts.times.filter((t) => t >= 0 && t <= duration)
      : Array.from({ length: opts.count }, (_, i) => start + (span * (i + 0.5)) / opts.count);
    if (!times.length) throw httpError(400, 'BAD_TIME', 'None of those times are inside the video.');
    for (const [i, t] of times.entries()) {
      await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-ss', String(t), '-i', job.input, '-frames:v', '1', '-q:v', '2', path.join(job.dir, `frame-${String(i + 1).padStart(2, '0')}.jpg`)], {
        timeoutMs: 60_000
      });
      job.progress = (i + 1) / times.length;
    }
    const frames = (await readdir(job.dir)).filter((f) => f.startsWith('frame-')).sort();
    if (frames.length === 1) return finish(job, path.join(job.dir, frames[0]), `${base}-${stamp(times[0])}.jpg`, 'image/jpeg');
    const out = path.join(job.dir, 'frames.zip');
    await zipFiles(
      out,
      frames.map((f, i) => ({ path: path.join(job.dir, f), name: `${base}-${stamp(times[i])}.jpg` }))
    );
    return finish(job, out, `${base}-frames.zip`, 'application/zip');
  }

  throw httpError(400, 'BAD_OPERATION', `Unknown operation "${opts.op}".`);
}

async function finish(job, file, filename, contentType) {
  job.output = file;
  job.filename = filename;
  job.contentType = contentType;
  job.bytes = (await stat(file)).size;
  job.progress = 1;
  job.status = 'done';
  await rm(job.input, { force: true }).catch(() => {});
}

function stamp(t) {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0').replace('.', '_');
  return `${m}m${s}s`;
}

function zipFiles(out, files) {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(out);
    const archive = archiver('zip', { store: true });
    archive.on('error', reject);
    stream.on('close', resolve);
    archive.pipe(stream);
    for (const f of files) archive.file(f.path, { name: f.name });
    archive.finalize();
  });
}
