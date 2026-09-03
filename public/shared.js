/**
 * Helpers shared by the pages under /ui: bearer-token handling, JSON POSTs with
 * the API's error envelope unpacked, and a few small DOM utilities.
 *
 * Pages that need a token include the standard token field markup
 * (#tokenField, #token, #saveToken, #tokenHint) and call qrgenUI.initToken().
 */
window.qrgenUI = (function () {
  const TOKEN_KEY = 'qrgen.token';
  const $ = (id) => document.getElementById(id);

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
    const field = $('token');
    return normalizeToken(field ? field.value : localStorage.getItem(TOKEN_KEY));
  }

  function showTokenField() {
    const field = $('tokenField');
    if (field) field.hidden = false;
  }

  function initToken() {
    const input = $('token');
    if (!input) return;

    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) input.value = saved;

    input.addEventListener('change', () => { input.value = normalizeToken(input.value); });

    $('saveToken')?.addEventListener('click', () => {
      const v = normalizeToken(input.value);
      input.value = v;
      if (v) {
        localStorage.setItem(TOKEN_KEY, v);
        $('tokenHint').innerHTML = '<span class="ok">Saved in this browser.</span>';
      } else {
        localStorage.removeItem(TOKEN_KEY);
        $('tokenHint').textContent = 'Cleared.';
      }
    });

    // Ask the server whether this browser needs a token, rather than burning a
    // generate call (and a rate-limit unit) on every page load.
    fetch('/auth')
      .then((r) => r.json())
      .then((info) => { if (info.tokenRequired) showTokenField(); })
      .catch(showTokenField);
  }

  /**
   * POST JSON to the API. Resolves with the Response on 2xx; otherwise throws an
   * Error whose message is the API's own (HTML-safe) explanation.
   */
  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = currentToken();
    if ($('token')) $('token').value = token;
    if (token) headers.Authorization = 'Bearer ' + token;

    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });

    if (res.status === 401) {
      showTokenField();
      throw new Error(token
        ? 'That token was rejected. Copy only the value after "QRGEN_TOKEN=", with no quotes or spaces.'
        : 'This browser is outside hc-internal, so an API token is required. Enter it below and try again.');
    }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try {
        const j = await res.json();
        if (j?.error?.message) msg = escapeHtml(j.error.message);
        if (j?.error?.details && Array.isArray(j.error.details)) {
          msg += '<br><small>' + j.error.details.map((d) => escapeHtml(`${d.path}: ${d.message}`)).join('<br>') + '</small>';
        }
      } catch (_) { /* non-JSON error body; keep the status line */ }
      throw new Error(msg);
    }
    return res;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function note(container, kind, html) {
    const el = document.createElement('div');
    el.className = 'note ' + kind;
    el.innerHTML = html;
    container.appendChild(el);
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { $, normalizeToken, currentToken, initToken, showTokenField, api, escapeHtml, note, formatBytes, downloadBlob };
})();
