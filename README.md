# qrgen

Print-ready and web-ready QR code generation for Hoops College and Chase Excellence —
flyers, gym signage, jersey tags, registration links, WiFi access and vCards — plus a
utilities page with a crop-accurate SVG → WebP/PNG converter.

One generator, three ways in: HTTP (n8n, Hyperframes), a local CLI, and an importable
JS client. All generation happens locally — no external API calls, no telemetry, no
redirect domains.

- Node 22 · Express · `qrcode` · `sharp` · `@resvg/resvg-js` · `zod` · `archiver`
- Deployed on **hc-new** as a container on the `hc-internal` Docker network,
  published to `127.0.0.1:3020` and reverse-proxied by Apache at
  `https://qr.hoopscollege.com`

---

## Quick start

```bash
cp .env.example .env
openssl rand -hex 32          # paste into QRGEN_TOKEN
docker network create hc-internal
docker compose up -d --build
curl localhost:3020/health
```

Generate a sample of every output type into the `/output` volume:

```bash
docker compose exec qrgen node test/generate-all.js
```

---

## API

Every endpoint returns **raw file bytes** with the correct `Content-Type`, plus:

| Header | Meaning |
| --- | --- |
| `X-QR-Version` | QR version (1–40) actually used |
| `X-QR-EC-Level` | Error-correction level after the logo rule is applied |
| `X-QR-Warning` | Present only when something was adjusted; ` \| `-separated |

Errors are JSON: `{ "error": { "code", "message", "details? } }`.

### `POST /generate`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `data` | string | — | **required** |
| `format` | `svg` \| `png` | `svg` | |
| `size` | int 64–8192 | `1024` | PNG pixel size; on SVG it only sets `width`/`height`, the `viewBox` stays authoritative |
| `margin` | int 0–32 | `4` | quiet zone in modules |
| `ecLevel` | `L`\|`M`\|`Q`\|`H` | `M` | forced to `H` when `logo` is set |
| `dark` | hex | `#000000` | 3-, 6- or 8-digit |
| `light` | hex | `#FFFFFF` | also fills the logo keep-out box |
| `logo` | string | — | data URI, bare base64, or a path inside `QRGEN_LOGO_DIR` |
| `logoScale` | 0.05–1 | `0.2` | fraction of the **full rendered width**, quiet zone included; capped at `0.25` |

```bash
curl -X POST https://qr.hoopscollege.com/generate \
  -H "Authorization: Bearer $QRGEN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"data":"https://hoopscollege.com/tryouts","dark":"#0B1F3A"}' \
  -o flyer.svg
```

Large-format signage at 2048 px:

```bash
curl -X POST http://qrgen:3000/generate \
  -H 'Content-Type: application/json' \
  -d '{"data":"https://hoopscollege.com/tryouts","format":"png","size":2048,"dark":"#0B1F3A"}' \
  -o signage.png
```

With a centre logo (ecLevel is raised to H automatically):

```bash
curl -X POST http://qrgen:3000/generate \
  -H 'Content-Type: application/json' \
  -d '{"data":"https://hoopscollege.com/tryouts","logo":"/output/logos/hc.svg","logoScale":0.2}' \
  -o branded.svg
```

### `POST /generate/wifi`

`{ ssid, password, encryption: WPA|WEP|nopass, hidden }` plus any render option above.

```bash
curl -X POST http://qrgen:3000/generate/wifi \
  -H 'Content-Type: application/json' \
  -d '{"ssid":"HC Gym","password":"hoops2026","encryption":"WPA","hidden":false,"format":"png","size":1200}' \
  -o gym-wifi.png
```

### `POST /generate/vcard`

`{ name, org, title, phone, email, url }` plus any render option.

```bash
curl -X POST http://qrgen:3000/generate/vcard \
  -H 'Content-Type: application/json' \
  -d '{"name":"Aram Parunak","org":"Hoops College","title":"Director","phone":"+1-555-0142","email":"info@hoopscollege.com","url":"https://hoopscollege.com"}' \
  -o coach.svg
```

Both helpers build a correctly escaped payload string — `\ ; , : "` for WiFi, vCard 3.0
escaping with CRLF line endings — then hand off to the same core generator.

### `POST /generate/batch`

`{ items: [...], format }` → a zip. Each item takes the full `/generate` body plus an
optional `name` used as the filename. A per-item `format` overrides the top-level one.
Max 200 items. The zip includes a `manifest.json` listing every file's QR version,
EC level, byte size and warnings.

```bash
curl -X POST http://qrgen:3000/generate/batch \
  -H 'Content-Type: application/json' \
  -d '{"format":"svg","items":[
        {"name":"tryouts","data":"https://hoopscollege.com/tryouts"},
        {"name":"camps","data":"https://hoopscollege.com/camps"},
        {"name":"chase-register","data":"https://chaseexcellence.org/register","format":"png"}]}' \
  -o batch.zip
```

Rendering happens fully before the zip streams, so one bad item fails the request
cleanly instead of producing a half-written archive.

### `POST /convert/svg` — SVG → WebP/PNG (utilities)

Rasterises an SVG with a vector-accurate crop. The markup travels as a JSON string,
so the same guard chain (flood check, token, body limit) applies.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `svg` | string | — | **required**; the SVG markup |
| `format` | `webp` \| `png` | `webp` | |
| `crop` | `artwork` \| `original` \| `custom` | `artwork` | `artwork` = visible bounds incl. strokes, clipped to the canvas |
| `cropRect` | `{x,y,width,height}` | — | required with `custom`; in the SVG's **user units** (viewBox space) |
| `padding` | number ≥ 0 | `0` | extra room around the crop, user units |
| `scale` | 0.01–64 | `1` | pixels per user unit, used when neither `width` nor `height` is set |
| `width`, `height` | int 1–8192 | — | one keeps the aspect ratio; both fit inside and letterbox with `background` |
| `quality` | int 1–100 | `90` | WebP only |
| `lossless` | bool | `false` | WebP only |
| `background` | `transparent` \| hex | `transparent` | |
| `name` | string | `image` | filename stem for `Content-Disposition` |

Response headers: `X-Image-Width`, `X-Image-Height`, and `X-Image-Warning` when a
fallback or adjustment happened. Output is capped at 8192 px per edge and 40 MP
(`OUTPUT_TOO_LARGE`).

```bash
curl -X POST http://qrgen:3000/convert/svg \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile svg logo.svg '{svg:$svg, crop:"artwork", padding:8, width:1200, background:"#FFFFFF"}')" \
  -o logo.webp
```

The crop is applied by rewriting the root `viewBox` **before** rasterising, so the
editor in the UI, the bounds from `/analyze` and the exported pixels share one
coordinate system. Physical units (`mm`, `in`, `%`) are normalised to "one user unit =
one pixel at scale 1". Scripts, `<foreignObject>` and external `href`/`url()` resources
are refused (`UNSAFE_SVG`); inline them as `data:` URIs. Plain `<a href>` links are fine.

### `POST /convert/svg/analyze`

`{ svg }` → `{ width, height, canvas, bbox, hasText }`. `canvas` is the viewBox (or
`0 0 w h` without one) and `bbox` the visible artwork's bounds, stroke included, both in
user units. `hasText` flags live `<text>`, which renders with the container's fonts
(Liberation + DejaVu) — convert type to outlines in the source for an exact match.

### `GET /health`

Open, no token. `{"status":"ok","service":"qrgen","uptime":123}`.

### `GET /ui` — browser interface

A single self-contained page for generating a QR from a link by hand: paste a link,
pick format and colours, optionally attach a logo, then preview and download. It shows
the QR version, EC level, file size and any warnings, and has a live byte counter that
tracks the real per-EC-level capacity.

Same-origin with the API, so there is no CORS setup and nothing separate to deploy.
`GET /` redirects browsers here; API clients sending `Accept: */*` still get the JSON
index instead. The UI is confined to `/ui` deliberately, so a Cloudflare Access policy
can protect the page by path prefix without also covering the API routes.

From outside `hc-internal` the page asks for the bearer token once and keeps it in that
browser's `localStorage`. Loading the page is not gated; generating is.

### `GET /ui/utilities` — SVG → WebP

The utilities page, reached from the tool switcher in the masthead. Drop, choose or
paste an SVG; the artwork bounds are detected and shown as a draggable crop box (eight
handles, drag to move, arrow keys to nudge, optional locked ratio, exact X/Y/W/H
fields, padding). Pick WebP or PNG, a scale preset or explicit pixel size, quality or
lossless, and a background, then convert and download. The source is editable in
place — edits re-analyse the artwork and are what gets exported. The preview is the
SVG with its root viewport normalised exactly as the server does it, so the crop you
see is the crop you get, including offset viewBoxes and `mm` documents.

Shared styles and token handling live in `public/shared.css` and `public/shared.js`,
served under `/ui/` so the same Cloudflare Access path prefix covers them.

### `GET /auth`

Reports whether the caller needs a token: `{"scope":"external","tokenRequired":true}`.
Lets the UI decide whether to show its token field without spending a generate call.

### Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | body failed zod validation; `details` lists each field |
| `BAD_JSON` | 400 | body is not valid JSON |
| `INVALID_LOGO` / `LOGO_PATH_DENIED` | 400 | logo unreadable, or path outside `QRGEN_LOGO_DIR` |
| `UNAUTHORIZED` | 401 | missing or invalid bearer token |
| `METHOD_NOT_ALLOWED` | 405 | right path, wrong method — every generation route is POST |
| `PAYLOAD_TOO_LARGE` | 413 | data exceeds byte capacity at the effective EC level |
| `BODY_TOO_LARGE` | 413 | request body exceeds `QRGEN_BODY_LIMIT` |
| `RATE_LIMITED` | 429 | see `Retry-After` |
| `AUTH_NOT_CONFIGURED` | 503 | `QRGEN_TOKEN` unset, so external callers cannot be authenticated |
| `INVALID_SVG` / `UNSAFE_SVG` | 400 | `/convert/svg`: no `<svg>` root, or scripts / external resources present |
| `OUTPUT_TOO_LARGE` | 400 | `/convert/svg`: requested raster exceeds 8192 px per edge or 40 MP |
| `RENDER_FAILED` | 422 | `/convert/svg`: neither resvg nor librsvg could rasterise the document |

---

## Behaviour worth knowing

**Payload limits are per EC level.** The familiar 2953-byte maximum only holds at
level L. qrgen validates against the level actually in use and says so:

| EC level | Max bytes |
| --- | --- |
| L | 2953 |
| M (default) | 2331 |
| Q | 1663 |
| H (forced with a logo) | 1273 |

A long vCard plus a logo is the case that bites — the logo forces H, which drops the
ceiling to 1273 bytes.

**Logo handling.** A logo forces `ecLevel: H`, caps `logoScale` at `0.25`, and punches a
keep-out box (18% larger than the logo, filled with `light`) behind it so the finder
patterns stay readable. Both adjustments are reported in `X-QR-Warning`.

**SVG and vector purity.** SVG output is a true vector `<path>` with a `viewBox`, so it
scales cleanly for large-format print. An **SVG logo is inlined as vector** and the
output stays pure vector. A **raster logo (PNG/JPEG) is embedded as a base64 `<image>`**
— the only way to put one in an SVG — and the response carries:

> `raster logo embedded as base64; this SVG is not pure vector. Supply an SVG logo for large-format print.`

For print work, supply an SVG logo. Logo SVGs are sanitised (`<script>`, `on*` handlers
and external `href`s stripped) before inlining, since the output goes straight into the
DOM in Hyperframes templates.

**Auth model.** Requests through the public proxy carry `X-Forwarded-For` (Apache's
`mod_proxy_http` sets it) and must present `Authorization: Bearer $QRGEN_TOKEN`.
Requests with no `X-Forwarded-For` from an RFC1918 source are treated as internal and
skip the token — that is how Hyperframes and n8n call `qrgen:3000` directly. A supplied
token is *always* verified, so a wrong token fails even from an internal source.

> **Trust boundary:** any container on `hc-internal`, and anything on hc-new that can
> reach `127.0.0.1:3020`, can generate without a token. The Docker network is the
> perimeter. Set `QRGEN_TRUST_INTERNAL=false` to require the token from everyone.

**Request ordering.** Body parsing sits *behind* the flood check and the token check,
not in front of them. Parsing a multi-megabyte body is the expensive part of an abusive
request, so an unauthenticated caller must never be able to trigger it: at the origin, a
9MB anonymous POST is rejected in ~0.002s rather than ~5.7s.

**Resource ceiling.** A single 8192px render peaks near 560MB inside sharp. The compose
file caps the container (`QRGEN_MEM_LIMIT`, `QRGEN_CPUS`, `pids_limit`) so a burst of
large renders cannot starve n8n or the live sites sharing hc-new — the container is
OOM-killed and restarted instead of the host suffering.

**Rate limiting.** A sliding window guards the generation endpoints (`/health` and `/`
are exempt). It runs *before* the token check, so unauthenticated floods are shed before
any real work is done. Cost is weighted — generation is CPU-bound, so a 50-item batch
costs 50 units, not 1. Callers are keyed on `CF-Connecting-IP` where present (set by
Cloudflare and unspoofable, unlike `X-Forwarded-For`), falling back to XFF then the
socket address. Exceeding it returns `429` with `RateLimit-*` and `Retry-After` headers.

This is the origin-side half. Pair it with a Cloudflare rate-limiting rule so floods are
dropped at the edge before they reach hc-new at all.

**Logo file paths over HTTP** are confined to `QRGEN_LOGO_DIR` (`/output/logos`);
anything outside is rejected with `LOGO_PATH_DENIED`. Base64 is always accepted. The
CLI, being operator-driven, reads any local path.

---

## CLI

```bash
npm link                      # or: node bin/qrgen.js …
qrgen "https://example.com" --out flyer.svg --ec H --logo logo.png
```

The CLI imports the generator directly — no server needed.

```bash
qrgen "https://hoopscollege.com/tryouts" --out flyer.svg --ec H --logo assets/hc-logo.svg
qrgen "https://hoopscollege.com/camps"   --out signage.png --size 2048 --dark '#0B1F3A'
qrgen wifi  --ssid "HC Gym" --password "hoops2026" --out wifi.png
qrgen vcard --name "Aram Parunak" --org "Hoops College" --email info@hoopscollege.com --out card.svg
qrgen "https://example.com" > piped.svg          # stdout when --out is omitted
```

Format is inferred from the `--out` extension. Run `qrgen --help` for all flags.

---

## Using it from Hyperframes

`client.js` is dependency-free and wraps the HTTP call, so a template can inline the
returned SVG into the DOM before render — no `<img>` round-trip, no external fetch at
render time.

```js
import { createClient } from 'qrgen/client';

const qrgen = createClient();   // reads QRGEN_URL and QRGEN_TOKEN from env

const svg = await qrgen.svg({
  data: 'https://hoopscollege.com/tryouts',
  dark: '#0B1F3A',
  logo: '/output/logos/hc.svg'
});

document.querySelector('#qr').innerHTML = svg;   // true vector, scales at print DPI
```

The same code works internally and externally — only the env vars change:

```bash
# Hyperframes container on hc-internal
QRGEN_URL=http://qrgen:3000

# anywhere else
QRGEN_URL=https://qr.hoopscollege.com
QRGEN_TOKEN=<token>
```

Methods: `svg()`, `png()`, `svgDataUri()`, `generate()`, `wifi()`, `vcard()`, `batch()`,
`convertSvg()`, `health()`. `generate()`/`wifi()`/`vcard()` return
`{ data, version, ecLevel, warnings }`; `svg()` returns markup, `png()`/`batch()` return a
`Uint8Array`; `convertSvg({ svg, ...options })` returns `{ data, width, height, warnings }`
with `data` a `Uint8Array`. Override the config explicitly if you prefer:
`createClient({ baseUrl, token, timeoutMs })`.

---

## Using it from n8n

n8n must be on `hc-internal` to use the hostname (see Deployment). **HTTP Request** node:

| Setting | Value |
| --- | --- |
| Method | `POST` |
| URL | `http://qrgen:3000/generate` |
| Authentication | None (internal) — or Header Auth `Authorization: Bearer {{$env.QRGEN_TOKEN}}` if calling the public URL |
| Send Body | on |
| Body Content Type | JSON |
| Specify Body | Using JSON |
| JSON | `{ "data": "{{ $json.url }}", "format": "png", "size": 1024, "dark": "#0B1F3A" }` |
| Response → Format | **File** |
| Response → Put Output in Field | `data` |

Setting Response Format to **File** is the important part — otherwise n8n tries to parse
the image bytes as text. The binary lands in `$binary.data`, ready for a Write Binary
File, an email attachment, or a Google Drive upload. QR version and warnings are
available via `Include Response Headers` as `x-qr-version` / `x-qr-warning`.

---

## Deployment on hc-new

hc-new runs Apache on :80/:443 (Coolify's Traefik is installed but stopped), so public
routing is an Apache vhost, not Caddy. `deploy/Caddyfile.snippet` is included for
portability but is **not** the active config.

```bash
# 1. network — create once, then attach the services that need the hostname
ssh hc-new 'docker network create hc-internal'
ssh hc-new 'docker network connect hc-internal n8n-n8n-1'   # live, no restart

# 2. code + config
ssh hc-new 'mkdir -p /opt/qrgen'
rsync -a --exclude node_modules --exclude output ./ hc-new:/opt/qrgen/
ssh hc-new 'cd /opt/qrgen && cp .env.example .env && sed -i "s|^QRGEN_TOKEN=|QRGEN_TOKEN=$(openssl rand -hex 32)|" .env'

# 3. build and run (hc-new is x86_64)
ssh hc-new 'cd /opt/qrgen && docker compose up -d --build'
ssh hc-new 'curl -s localhost:3020/health'

# 4. public vhost — the *.hoopscollege.com wildcard cert already covers qr.
scp deploy/qr.hoopscollege.com.conf hc-new:/etc/apache2/sites-available/
ssh hc-new 'a2ensite qr.hoopscollege.com && apache2ctl configtest && systemctl reload apache2'
```

**DNS:** add `qr.hoopscollege.com` → the hc-new origin IP in Cloudflare. Nothing resolves
until that record exists. (The IP is omitted here deliberately: hoopscollege.com is
proxied through Cloudflare, which masks the origin.)

**Port 3020** is free on hc-new; 3000/3001/3010/3011/3031/8000/8080/8088/8099 are taken.

**Building from an Apple Silicon Mac** for hc-new needs an explicit platform:

```bash
docker buildx build --platform linux/amd64 -t qrgen:latest .
```

Verify container-to-container reachability:

```bash
ssh hc-new 'docker run --rm --network hc-internal alpine/curl -s http://qrgen:3000/health'
```

---

## Environment variables

See `.env.example` for the annotated list. Summary:

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | listen port inside the container |
| `HOST` | `0.0.0.0` | bind interface |
| `QRGEN_HOST_PORT` | `3020` | loopback port published on the host |
| `QRGEN_TOKEN` | — | bearer token for external callers; unset ⇒ external requests get 503 |
| `QRGEN_TRUST_INTERNAL` | `true` | allow RFC1918/no-XFF callers to skip the token |
| `QRGEN_RATE_LIMIT` | `300` | units per window for external callers |
| `QRGEN_RATE_LIMIT_INTERNAL` | `1200` | units per window for internal callers |
| `QRGEN_RATE_WINDOW_MS` | `60000` | rate-limit window |
| `QRGEN_RATE_MAX_KEYS` | `10000` | distinct callers tracked |
| `QRGEN_MEM_LIMIT` | `1536m` | container memory ceiling |
| `QRGEN_CPUS` | `1.5` | container CPU ceiling |
| `QRGEN_LOGO_DIR` | `/output/logos` | directory HTTP callers may reference by path |
| `QRGEN_BODY_LIMIT` | `10mb` | max JSON body |
| `OUTPUT_DIR` | `/output` | where the acceptance script writes |
| `QRGEN_URL` | `http://qrgen:3000` | **client-side**: base URL for `client.js` |
| `QRGEN_TIMEOUT_MS` | `15000` | **client-side**: request timeout |

---

## Acceptance

```bash
npm test                                        # local, writes ./output
docker compose exec qrgen node test/generate-all.js   # container, writes /output volume
docker compose exec qrgen node test/convert-svg.js    # the SVG → WebP utility
```

`generate-all.js` generates one of every output type — plain SVG, plain PNG, SVG with a
vector logo, SVG with a raster logo, PNG with a logo, WiFi, vCard and a batch zip — then
prints the file sizes, QR versions and EC levels, flags whether each SVG stayed pure
vector, and checks that an over-capacity payload is rejected.

`convert-svg.js` (also `npm run test:convert`) pushes the HC logo and two synthetic
documents through every conversion path — artwork crop, custom crop with padding, fixed
width, fixed box with letterbox, PNG, lossless, `mm` units with an offset viewBox — and
asserts the pixel sizes, the stroke-inclusive bounds, and that unsafe or oversized
requests are refused.
