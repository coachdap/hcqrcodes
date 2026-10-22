/**
 * Shared by every page under /ui: the tool registry and app shell (sidebar,
 * phone drawer, token dialog), API helpers that unpack the error envelope, and
 * small UI utilities (drop zones, downloads, a store-only zip writer).
 *
 * A page is a `<main class="wrap" data-tool="slug">` plus this script; the
 * shell is built around it.
 */
window.qrgenUI = (function () {
  const TOKEN_KEY = 'qrgen.token';
  const $ = (id) => document.getElementById(id);

  // --- icons (24×24, stroke) -------------------------------------------------

  const ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
    pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.59 7.59"/><circle cx="11" cy="11" r="2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
    layout: '<rect x="2" y="4" width="9" height="16" rx="1.5"/><rect x="13" y="4" width="9" height="7" rx="1.5"/><rect x="13" y="13" width="9" height="7" rx="1.5"/>',
    compress: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
    star: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 7.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1-2.8-1.5-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/>',
    flyer: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M8 12l3 3 5-6"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6M12 12v6"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.5"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A5.6 5.6 0 0 0 22 9.8C22 5.5 17.5 2 12 2z"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M16 7l3 3M19 4l2 2"/>'
  };

  function icon(name, size = 24) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  // --- tool registry: the sidebar, the home page and page headers all read this.

  const TOOLS = [
    {
      group: 'QR & links',
      items: [
        { slug: 'qr', name: 'QR code', icon: 'qr', desc: 'Print-ready QR codes for links, Wi-Fi and contact cards.' },
        { slug: 'links', name: 'Link builder', icon: 'link', desc: 'Tracked links for every flyer, sign and post, each with its own QR.' }
      ]
    },
    {
      group: 'Images',
      items: [
        { slug: 'svg', name: 'SVG → WebP', icon: 'pen', desc: 'Crop vector artwork exactly and export a clean WebP or PNG.' },
        { slug: 'convert', name: 'Image converter', icon: 'image', desc: 'Convert between JPG, PNG, WebP, AVIF and SVG, resizing on the way.' },
        { slug: 'social', name: 'Social sizes', icon: 'layout', desc: 'One image in, every Instagram, Facebook, X and YouTube size out.' },
        { slug: 'compress', name: 'Compress photos', icon: 'compress', desc: 'Shrink photos for the web and strip hidden GPS location data.' },
        { slug: 'favicon', name: 'Favicon pack', icon: 'star', desc: 'Every favicon and app icon a website needs, from one logo.' }
      ]
    },
    {
      group: 'Print & events',
      items: [
        { slug: 'flyer', name: 'Flyer maker', icon: 'flyer', desc: 'Branded event flyers and social graphics with a QR code.' },
        { slug: 'tags', name: 'Name tags & rosters', icon: 'tag', desc: 'Badges, bag and jersey labels, and sign-in sheets from a roster.' },
        { slug: 'checkin', name: 'Check-in', icon: 'scan', desc: 'Scan badges at the door and watch attendance update live.' }
      ]
    },
    {
      group: 'Documents & media',
      items: [
        { slug: 'pdf', name: 'PDF tools', icon: 'pdf', desc: 'Merge, split, compress and convert PDFs and scans.' },
        { slug: 'video', name: 'Video tools', icon: 'film', desc: 'Compress clips, make GIFs, grab thumbnails and pull audio.' }
      ]
    },
    {
      group: 'Brand',
      items: [{ slug: 'brand', name: 'Brand kit', icon: 'palette', desc: 'Logos, colours and fonts for each brand, in every format.' }]
    }
  ];
  const ALL_TOOLS = TOOLS.flatMap((g) => g.items);

  // --- shell ---------------------------------------------------------------------

  function buildShell() {
    const main = document.querySelector('main.wrap');
    if (!main) return;
    const current = main.dataset.tool || 'home';
    const tool = ALL_TOOLS.find((t) => t.slug === current);

    const side = document.createElement('aside');
    side.className = 'side';
    side.id = 'side';
    side.setAttribute('aria-label', 'Tools');
    side.innerHTML =
      `<a class="side-brand" href="/ui"><span class="mark">HC</span><span><b>Utilities</b><small>Hoops College · Chase Excellence</small></span></a>` +
      `<div class="side-group"><a class="tool" href="/ui"${current === 'home' ? ' aria-current="page"' : ''}>${icon('home')}All tools</a></div>` +
      TOOLS.map(
        (g) =>
          `<div class="side-group"><h3>${g.group}</h3>` +
          g.items.map((t) => `<a class="tool" href="/ui/${t.slug}"${t.slug === current ? ' aria-current="page"' : ''}>${icon(t.icon)}${t.name}</a>`).join('') +
          '</div>'
      ).join('') +
      `<div class="side-foot"><button type="button" class="tokenstatus" id="tokenStatus"><span class="dot"></span><span>Checking access…</span></button></div>`;

    const top = document.createElement('div');
    top.className = 'topbar';
    top.innerHTML =
      `<button type="button" id="navToggle" aria-label="Open tools menu" aria-controls="side" aria-expanded="false">${icon('menu', 22)}</button>` +
      `<a href="/ui">Utilities</a>${tool ? `<span class="here">/ ${tool.name}</span>` : ''}`;

    const scrim = document.createElement('div');
    scrim.className = 'scrim';

    document.body.prepend(side, top, scrim);
    const setOpen = (open) => {
      document.body.classList.toggle('nav-open', open);
      $('navToggle').setAttribute('aria-expanded', String(open));
    };
    $('navToggle').addEventListener('click', () => setOpen(!document.body.classList.contains('nav-open')));
    scrim.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));

    // Page header: icon + the registry's name/description unless the page wrote its own.
    const header = main.querySelector('header.page');
    if (header && tool && !header.querySelector('.ico')) {
      header.insertAdjacentHTML('afterbegin', `<span class="ico">${icon(tool.icon)}</span>`);
    }
    if (tool) document.title = `${tool.name} · Utilities`;

    $('tokenStatus').addEventListener('click', () => openTokenDialog());
    refreshAccess();
  }

  // --- token handling --------------------------------------------------------------

  // Be forgiving about how the token was copied: pasting a whole `.env` line or a
  // quoted value is the obvious mistake, and it fails as an opaque 401 otherwise.
  function normalizeToken(raw) {
    return String(raw || '')
      .trim()
      .replace(/^QRGEN_TOKEN\s*=\s*/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  }

  function currentToken() {
    try {
      return normalizeToken(localStorage.getItem(TOKEN_KEY));
    } catch (_) {
      return '';
    }
  }

  function saveToken(v) {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* private mode: the token lasts for this page only */ }
  }

  let access = null;
  function refreshAccess() {
    fetch('/auth')
      .then((r) => r.json())
      .then((info) => { access = info; paintAccess(); })
      .catch(() => { access = { tokenRequired: true }; paintAccess(); });
  }

  function paintAccess() {
    const el = $('tokenStatus');
    if (!el || !access) return;
    let dot, text, sub;
    if (!access.tokenRequired) { dot = 'ok'; text = 'On the HC network'; sub = 'No token needed'; }
    else if (currentToken()) { dot = 'ok'; text = 'Token saved'; sub = 'Click to change'; }
    else { dot = 'warn'; text = 'Token needed'; sub = 'Click to add it'; }
    el.innerHTML = `<span class="dot ${dot}"></span><span>${text}<small>${sub}</small></span>`;
  }

  function openTokenDialog(reason) {
    let dlg = $('tokenDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'tokenDialog';
      dlg.className = 'modal';
      dlg.innerHTML = `
        <form method="dialog">
          <h2>API token</h2>
          <p id="tokenReason"></p>
          <div class="field">
            <label for="tokenInput">Token</label>
            <input type="password" id="tokenInput" autocomplete="off" placeholder="paste the value of QRGEN_TOKEN">
            <div class="hint">Saved in this browser only. Every tool uses it.</div>
          </div>
          <div class="actions">
            <button value="save" id="tokenSave">Save token</button>
            <button value="clear" class="ghost" type="submit">Forget</button>
            <button value="cancel" class="ghost" type="submit" formnovalidate>Cancel</button>
          </div>
        </form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener('close', () => {
        if (dlg.returnValue === 'save') saveToken(normalizeToken($('tokenInput').value));
        if (dlg.returnValue === 'clear') saveToken('');
        paintAccess();
        if (dlg.returnValue === 'save') toast('Token saved. Try again.');
      });
    }
    $('tokenReason').textContent =
      reason === 'rejected'
        ? 'That token was rejected. Copy only the value after "QRGEN_TOKEN=" in /opt/qrgen/.env on hc-new, with no quotes or spaces.'
        : reason === 'required'
          ? 'You are outside the Hoops College network, so the tools need the access token before they can run.'
          : 'Needed only when you are outside the Hoops College network. It is the QRGEN_TOKEN value from /opt/qrgen/.env on hc-new.';
    $('tokenInput').value = currentToken();
    dlg.showModal();
    $('tokenInput').focus();
  }

  // --- API helpers -----------------------------------------------------------------

  async function errorFrom(res) {
    if (res.status === 401) {
      const had = Boolean(currentToken());
      openTokenDialog(had ? 'rejected' : 'required');
      return new Error(had ? 'The saved token was rejected. Update it and try again.' : 'An access token is needed from outside the HC network. Add it and try again.');
    }
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = escapeHtml(j.error.message);
      if (j?.error?.details && Array.isArray(j.error.details)) {
        msg += '<br><small>' + j.error.details.map((d) => escapeHtml(`${d.path}: ${d.message}`)).join('<br>') + '</small>';
      }
    } catch (_) {
      if (res.status === 413) msg = 'That upload is too large for the server.';
      if (res.status === 502 || res.status === 504 || res.status === 524) msg = 'The server took too long to answer. Try a smaller file.';
    }
    return new Error(msg);
  }

  /**
   * fetch() with the bearer token and the API's error envelope unpacked.
   * Resolves with the Response on 2xx; throws an Error with HTML-safe text otherwise.
   */
  async function request(path, { method = 'GET', json, form } = {}) {
    const headers = {};
    const token = currentToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    let res;
    try {
      res = await fetch(path, { method, headers, body });
    } catch (_) {
      throw new Error('Could not reach the server. Check your connection and try again.');
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  const api = (path, body) => request(path, { method: 'POST', json: body });
  const upload = (path, form) => request(path, { method: 'POST', form });
  const getJson = (path) => request(path).then((r) => r.json());

  /** Upload with progress events (fetch has none). Resolves with parsed JSON. */
  function uploadWithProgress(path, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      const token = currentToken();
      if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'));
      xhr.onload = async () => {
        const res = new Response(xhr.response, { status: xhr.status, statusText: xhr.statusText });
        if (xhr.status >= 200 && xhr.status < 300) resolve(await res.json());
        else reject(await errorFrom(res));
      };
      xhr.send(form);
    });
  }

  function filenameFrom(res, fallback) {
    return (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || fallback;
  }

  // --- small utilities ---------------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function note(container, kind, html) {
    const el = document.createElement('div');
    el.className = 'note ' + kind;
    el.innerHTML = html;
    container.appendChild(el);
    return el;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  let toastTimer;
  function toast(text) {
    let el = $('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /** Disable a button and swap its label while `task` runs. */
  async function busy(button, label, task) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
      return await task();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /**
   * Make `el` a file drop target: click/Enter to browse, drag-and-drop, and
   * (with paste: true) pasted files. `accept` filters by MIME/extension.
   */
  function dropzone(el, { accept = '', multiple = false, paste = false, onFiles }) {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.accept = accept;
    input.multiple = multiple;
    el.appendChild(input);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');

    const matches = (f) => {
      if (!accept) return true;
      return accept.split(',').map((s) => s.trim().toLowerCase()).some((a) =>
        a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a);
    };
    const take = (list) => {
      let files = [...list].filter(matches);
      if (!files.length) return toast('That file type is not supported here.');
      if (!multiple) files = files.slice(0, 1);
      onFiles(files);
    };

    el.addEventListener('click', (e) => { if (e.target === input) return; input.click(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { take(input.files); input.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); take(e.dataTransfer.files); });
    if (paste) {
      document.addEventListener('paste', (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === 'TEXTAREA' || tag === 'INPUT') return;
        if (e.clipboardData?.files?.length) { e.preventDefault(); take(e.clipboardData.files); }
      });
    }
    return { open: () => input.click() };
  }

  /** Standard drop-zone markup. */
  function dropMarkup(title, sub) {
    return `<div class="icon">${icon('upload', 22)}</div><div><strong>${title}</strong><br><span>${sub}</span></div>`;
  }

  // --- zip (store only; inputs are already-compressed media) ------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function zip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const used = new Set();
    for (const e of entries) {
      let name = e.name;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = e.name.replace(/(\.[^.]+)?$/, `-${n}$1`);
      used.add(name.toLowerCase());
      const data = new Uint8Array(await e.blob.arrayBuffer());
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(local, nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // Kept for pages written before the shell owned the token: it now lives in the sidebar.
  function initToken() {}
  function showTokenField() { openTokenDialog('required'); }

  buildShell();

  return {
    $, icon, TOOLS, ALL_TOOLS,
    normalizeToken, currentToken, initToken, showTokenField, openTokenDialog,
    request, api, upload, getJson, uploadWithProgress, filenameFrom,
    escapeHtml, note, formatBytes, downloadBlob, toast, debounce, busy, dropzone, dropMarkup, zip
  };
})();
