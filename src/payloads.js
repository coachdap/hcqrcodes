/**
 * Payload builders for the helper endpoints. These only produce the encoded
 * *string*; rendering is handed to the same core generator as /generate.
 */

/** Escape the characters that terminate fields in the WIFI: scheme. */
function escapeWifi(value = '') {
  return String(value).replace(/([\\;,:"])/g, '\\$1');
}

export function buildWifiPayload({ ssid, password, encryption = 'WPA', hidden = false }) {
  const type = encryption === 'nopass' ? 'nopass' : encryption;
  const parts = [`T:${type}`, `S:${escapeWifi(ssid)}`];
  if (type !== 'nopass' && password) parts.push(`P:${escapeWifi(password)}`);
  if (hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}

/** vCard 3.0 escaping: backslash, semicolon, comma and newline are structural. */
function escapeVcard(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Split a display name into the five N: components. Anything beyond
 * "First Last" is left in the given/family slots rather than guessed at.
 */
function structuredName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

export function buildVcardPayload({ name, org, title, phone, email, url }) {
  const { family, given } = structuredName(name);
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escapeVcard(family)};${escapeVcard(given)};;;`,
    `FN:${escapeVcard(name)}`
  ];
  if (org) lines.push(`ORG:${escapeVcard(org)}`);
  if (title) lines.push(`TITLE:${escapeVcard(title)}`);
  if (phone) lines.push(`TEL;TYPE=CELL:${escapeVcard(phone)}`);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVcard(email)}`);
  if (url) lines.push(`URL:${escapeVcard(url)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}
