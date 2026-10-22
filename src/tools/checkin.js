/**
 * Event check-in: an event holds a roster; scanning a badge's QR (or tapping a
 * name) marks that person present. One JSON file per event on the data volume,
 * so several phones can scan the same door at once.
 *
 * Badge QR payloads are "HC:<id>" (see the name-tag tool). A scanned URL also
 * works if the attendee ID is its last path segment or an ?id= parameter.
 */
import { z } from 'zod';
import { dataPath, list, mutate, readJson, remove, shortId } from './store.js';
import { httpError } from './common.js';

const DIR = dataPath('checkin');
const fileFor = (id) => {
  if (!/^[A-Z0-9]{6,12}$/.test(id)) throw httpError(404, 'EVENT_NOT_FOUND', 'No such event.');
  return dataPath('checkin', `${id}.json`);
};

const MAX_ATTENDEES = 2000;

export const eventSchema = z.object({
  name: z.string().trim().min(1, 'name the event').max(120),
  date: z.string().trim().max(40).default(''),
  location: z.string().trim().max(120).default('')
});

const personSchema = z.object({
  name: z.string().trim().min(1).max(120),
  group: z.string().trim().max(80).default(''),
  id: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(200).default('')
});

export const rosterSchema = z.object({
  rows: z.array(personSchema).min(1, 'the roster is empty').max(MAX_ATTENDEES),
  mode: z.enum(['append', 'replace']).default('append')
});

const normId = (v) => String(v).trim().toUpperCase();

function summary(ev) {
  const checkedIn = Object.keys(ev.checkins).length;
  return {
    id: ev.id,
    name: ev.name,
    date: ev.date,
    location: ev.location,
    createdAt: ev.createdAt,
    attendees: ev.attendees.length,
    checkedIn
  };
}

export async function listEvents() {
  const files = (await list(DIR)).filter((f) => f.endsWith('.json'));
  const events = [];
  for (const f of files) {
    const ev = await readJson(dataPath('checkin', f), null);
    if (ev) events.push(summary(ev));
  }
  return events.sort((a, b) => (b.date || b.createdAt).localeCompare(a.date || a.createdAt));
}

export async function createEvent(input) {
  const data = eventSchema.parse(input);
  const id = shortId(8);
  const ev = { id, ...data, createdAt: new Date().toISOString(), attendees: [], checkins: {} };
  await mutate(fileFor(id), ev, () => {});
  return summary(ev);
}

export async function getEvent(id) {
  const ev = await readJson(fileFor(id), null);
  if (!ev) throw httpError(404, 'EVENT_NOT_FOUND', 'No such event.');
  return { ...summary(ev), roster: ev.attendees.map((a) => ({ ...a, checkedInAt: ev.checkins[a.id]?.at ?? null })) };
}

export async function deleteEvent(id) {
  await getEvent(id);
  await remove(fileFor(id));
}

function update(id, fn) {
  return mutate(fileFor(id), null, async (ev) => {
    if (!ev) throw httpError(404, 'EVENT_NOT_FOUND', 'No such event.');
    return fn(ev);
  });
}

export async function importRoster(id, input) {
  const { rows, mode } = rosterSchema.parse(input);
  return update(id, (ev) => {
    if (mode === 'replace') {
      ev.attendees = [];
      ev.checkins = {};
    }
    const byId = new Map(ev.attendees.map((a) => [a.id, a]));
    let added = 0;
    let updated = 0;
    for (const row of rows) {
      let pid = row.id ? normId(row.id).replace(/[^A-Z0-9_-]/g, '') : '';
      if (pid && byId.has(pid)) {
        Object.assign(byId.get(pid), { name: row.name, group: row.group, notes: row.notes });
        updated++;
        continue;
      }
      if (!pid) do pid = shortId(6); while (byId.has(pid));
      const person = { id: pid, name: row.name, group: row.group, notes: row.notes };
      ev.attendees.push(person);
      byId.set(pid, person);
      added++;
    }
    if (ev.attendees.length > MAX_ATTENDEES) throw httpError(400, 'ROSTER_TOO_LARGE', `An event holds at most ${MAX_ATTENDEES} people.`);
    return { added, updated, total: ev.attendees.length };
  });
}

/** Pull an attendee ID out of whatever the camera read. */
export function extractId(code) {
  const text = String(code ?? '').trim();
  const prefixed = text.match(/^HC(?:CI)?:(?:[A-Z0-9]+:)?([A-Za-z0-9_-]+)$/i);
  if (prefixed) return normId(prefixed[1]);
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const q = url.searchParams.get('id');
      if (q) return normId(q);
      const last = url.pathname.split('/').filter(Boolean).at(-1);
      if (last) return normId(last);
    } catch {
      /* fall through */
    }
  }
  return normId(text);
}

export async function scan(id, code) {
  const pid = extractId(code);
  return update(id, (ev) => {
    const person = ev.attendees.find((a) => a.id === pid);
    const counts = () => ({ attendees: ev.attendees.length, checkedIn: Object.keys(ev.checkins).length });
    if (!person) return { status: 'unknown', code: String(code).slice(0, 200), id: pid, ...counts() };
    const existing = ev.checkins[pid];
    if (existing) return { status: 'already', person, at: existing.at, ...counts() };
    const at = new Date().toISOString();
    ev.checkins[pid] = { at, via: 'scan' };
    return { status: 'checked-in', person, at, ...counts() };
  });
}

export async function setCheckedIn(id, personId, present) {
  const pid = normId(personId);
  return update(id, (ev) => {
    const person = ev.attendees.find((a) => a.id === pid);
    if (!person) throw httpError(404, 'ATTENDEE_NOT_FOUND', 'That person is not on this roster.');
    if (present) ev.checkins[pid] ??= { at: new Date().toISOString(), via: 'manual' };
    else delete ev.checkins[pid];
    return { person, checkedInAt: ev.checkins[pid]?.at ?? null, attendees: ev.attendees.length, checkedIn: Object.keys(ev.checkins).length };
  });
}

export async function walkIn(id, input) {
  const row = personSchema.omit({ id: true }).parse(input);
  return update(id, (ev) => {
    let pid;
    do pid = shortId(6); while (ev.attendees.some((a) => a.id === pid));
    const person = { id: pid, name: row.name, group: row.group, notes: row.notes || 'walk-in' };
    ev.attendees.push(person);
    ev.checkins[pid] = { at: new Date().toISOString(), via: 'walk-in' };
    return { person, checkedInAt: ev.checkins[pid].at, attendees: ev.attendees.length, checkedIn: Object.keys(ev.checkins).length };
  });
}

export async function exportCsv(id) {
  const ev = await readJson(fileFor(id), null);
  if (!ev) throw httpError(404, 'EVENT_NOT_FOUND', 'No such event.');
  const cell = (v) => {
    const s = String(v ?? '');
    // Leading =,+,-,@ would be evaluated as a formula by Excel/Sheets.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [['Name', 'Group', 'ID', 'Checked in', 'Time', 'How', 'Notes'].join(',')];
  for (const a of ev.attendees) {
    const c = ev.checkins[a.id];
    lines.push([a.name, a.group, a.id, c ? 'yes' : 'no', c?.at ?? '', c?.via ?? '', a.notes].map(cell).join(','));
  }
  const slug = ev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  return { csv: lines.join('\r\n') + '\r\n', filename: `${slug}-attendance.csv` };
}
