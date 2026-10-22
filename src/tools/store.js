/**
 * Tiny JSON-file store on the /output volume, for the two tools that keep
 * state (check-in and the brand kit). Writes are atomic (temp file + rename)
 * and mutations of one file are serialised, which is all a single-process
 * service with a handful of coaches needs.
 */
import { mkdir, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DATA_DIR = process.env.QRGEN_DATA_DIR ?? '/output/data';

const locks = new Map();

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

/** Read-modify-write under a per-file lock. `fn` may return a new value or mutate in place. */
export function mutate(file, fallback, fn) {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    const value = await readJson(file, structuredClone(fallback));
    const result = await fn(value);
    await writeJson(file, value);
    return result;
  });
  locks.set(file, next.catch(() => {}));
  return next;
}

export async function remove(file) {
  await rm(file, { force: true, recursive: true });
}

export async function list(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Short, unambiguous IDs (no 0/O/1/I) that are easy to read off a badge. */
export function shortId(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
