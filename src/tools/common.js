/**
 * Plumbing shared by the utility tools: multipart uploads, a concurrency gate
 * for CPU-heavy work, child-process execution with a timeout, temp directories
 * and response helpers.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import archiver from 'archiver';

const MB = 1024 * 1024;

export const LIMITS = {
  imageBytes: Number(process.env.QRGEN_UPLOAD_IMAGE_MB ?? 25) * MB,
  pdfBytes: Number(process.env.QRGEN_UPLOAD_PDF_MB ?? 50) * MB,
  videoBytes: Number(process.env.QRGEN_UPLOAD_VIDEO_MB ?? 95) * MB,
  maxFiles: 40
};

export function httpError(status, code, message, details) {
  return Object.assign(new Error(message), { status, code, expose: true, ...(details ? { details } : {}) });
}

// --- uploads -----------------------------------------------------------------

export const KINDS = {
  image: {
    mime: /^image\//,
    ext: /\.(jpe?g|png|webp|avif|gif|tiff?|svg|heic|heif|bmp)$/i,
    label: 'an image (JPG, PNG, WebP, AVIF, GIF, TIFF or SVG)'
  },
  pdf: { mime: /^application\/pdf$/, ext: /\.pdf$/i, label: 'a PDF' },
  video: {
    mime: /^video\//,
    ext: /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i,
    label: 'a video (MP4, MOV, WebM, MKV or AVI)'
  }
};

/**
 * Build the middleware that accepts multipart uploads. Files may use any field
 * name (the flyer tool tells its photo and logo apart that way); each keeps
 * its `fieldname`.
 *
 * @param {object} opts
 * @param {Array<keyof KINDS>} opts.kinds   accepted file kinds
 * @param {number} opts.maxBytes            per-file ceiling
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.minFiles]
 * @param {boolean} [opts.disk]             stream to a temp file instead of memory (video)
 * @param {(files, fields) => number} [opts.cost]  rate-limit units for this request
 */
export function acceptUploads({ kinds, maxBytes, maxFiles = LIMITS.maxFiles, minFiles = 1, disk = false, cost }) {
  const storage = disk
    ? multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => cb(null, `qrgen-upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      })
    : multer.memoryStorage();

  const upload = multer({
    storage,
    limits: { fileSize: maxBytes, files: maxFiles, fields: 60, fieldSize: 2 * MB },
    fileFilter: (req, file, cb) => {
      const ok = kinds.some((k) => KINDS[k].mime.test(file.mimetype) || KINDS[k].ext.test(file.originalname));
      if (ok) return cb(null, true);
      const wanted = kinds.map((k) => KINDS[k].label).join(' or ');
      cb(httpError(415, 'UNSUPPORTED_FILE', `"${file.originalname}" is not ${wanted}.`));
    }
  }).any();

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(httpError(413, 'FILE_TOO_LARGE', `Each file is limited to ${Math.round(maxBytes / MB)} MB.`));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(httpError(400, 'TOO_MANY_FILES', `Send at most ${maxFiles} file${maxFiles === 1 ? '' : 's'}.`));
        }
        return next(httpError(400, 'BAD_UPLOAD', err.message));
      }
      if (err) return next(err);

      req.files ??= [];
      if (req.files.length < minFiles) {
        cleanupUploads(req);
        return next(httpError(400, 'NO_FILE', minFiles === 1 ? 'Attach a file.' : `Attach at least ${minFiles} files.`));
      }
      // Weighted like /generate/batch: the post-phase limiter charges this.
      req.rateCost = cost ? cost(req.files, req.body ?? {}) : req.files.length;
      res.on('close', () => cleanupUploads(req));
      next();
    });
  };
}

function cleanupUploads(req) {
  for (const f of req.files ?? []) if (f.path) rm(f.path, { force: true }).catch(() => {});
}

// --- concurrency -------------------------------------------------------------

/**
 * At most `size` tasks run at once; up to `queue` more wait their turn and
 * anything beyond that is refused, so a burst cannot pile up unbounded work.
 */
export function gate(size, queue = 10) {
  let active = 0;
  const waiting = [];
  return async function run(task) {
    if (active >= size) {
      if (waiting.length >= queue) {
        throw httpError(503, 'BUSY', 'The server is busy with other jobs. Try again in a minute.');
      }
      await new Promise((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Shared by the sharp/pdf/ghostscript tools; video has its own, narrower gate. */
export const heavy = gate(Number(process.env.QRGEN_HEAVY_CONCURRENCY ?? 2), 20);

// --- child processes ---------------------------------------------------------

/**
 * Run a command, resolving with stdout. Rejects with a clean HTTP error on
 * timeout, on a missing binary, or on a non-zero exit (with the stderr tail).
 */
export function run(cmd, args, { timeoutMs = 90_000, onStdout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (onStdout ? onStdout(d) : out.push(d)));
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') reject(httpError(501, 'TOOL_MISSING', `${cmd} is not installed on this server.`));
      else reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(httpError(504, 'TIMEOUT', `${cmd} took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`));
      if (code !== 0) {
        const tail = err.trim().split('\n').slice(-3).join(' ').slice(0, 400);
        return reject(Object.assign(httpError(422, 'PROCESSING_FAILED', `${cmd} could not process this file.`), { stderr: tail }));
      }
      resolve(Buffer.concat(out));
    });
  });
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qrgen-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- responses ---------------------------------------------------------------

export function sendFile(res, { buffer, contentType, filename, headers = {} }) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== '') res.setHeader(k, String(v));
  res.status(200).end(buffer);
}

/** Stream a zip of in-memory entries. Already-compressed media is stored, not deflated. */
export async function sendZip(res, filename, entries, headers = {}) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== '') res.setHeader(k, String(v));
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    archive.on('error', reject);
    res.on('close', resolve);
  });
  archive.pipe(res);
  for (const e of entries) {
    const stored = /\.(jpe?g|png|webp|avif|gif|mp4|mp3|pdf|ico)$/i.test(e.name);
    archive.append(e.buffer, { name: e.name, store: stored });
  }
  await archive.finalize();
  await done;
}

export function stem(name, fallback = 'file') {
  return (
    String(name ?? '')
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 80) || fallback
  );
}

/** Give every entry a distinct filename, suffixing -2, -3… on collisions. */
export function uniqueNames(entries) {
  const used = new Set();
  return entries.map((e) => {
    const dot = e.name.lastIndexOf('.');
    const base = dot > 0 ? e.name.slice(0, dot) : e.name;
    const ext = dot > 0 ? e.name.slice(dot) : '';
    let name = e.name;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base}-${n++}${ext}`;
    used.add(name.toLowerCase());
    return { ...e, name };
  });
}

/** Multipart fields arrive as strings; these coerce them leniently. */
export const field = {
  num(v, def, min, max) {
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  },
  bool(v, def = false) {
    if (v === undefined || v === '') return def;
    return v === true || v === 'true' || v === '1' || v === 'on';
  },
  oneOf(v, options, def) {
    return options.includes(v) ? v : def;
  },
  hex(v, def) {
    return /^#[0-9a-fA-F]{6}$/.test(v ?? '') ? v.toUpperCase() : def;
  },
  text(v, max = 500) {
    return String(v ?? '').trim().slice(0, max);
  }
};

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
