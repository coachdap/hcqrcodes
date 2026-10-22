/**
 * HTTP routes for the utility tools. Every route sits behind the same flood
 * check and bearer-token check as /generate; uploads are parsed only after
 * both have passed.
 */
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { acceptUploads, field, httpError, heavy, LIMITS, sendFile, sendZip, stem, uniqueNames } from './common.js';
import { convertImage, compressImage, socialPack, faviconPack, renderLogo, SOCIAL_PRESETS } from './images.js';
import { mergePdfs, splitPdf, compressPdf, pdfToImages, imagesToPdf } from './pdf.js';
import { createJob, getJob, view, parseTime } from './video.js';
import { buildFlyer, pdfToPng, FLYER_SIZES } from './flyer.js';
import { buildTags, TAG_LAYOUTS } from './tags.js';
import { luminance, FONT_FAMILY } from './typeset.js';
import * as checkin from './checkin.js';
import * as brand from './brand.js';

const IMAGE_FORMATS = ['webp', 'png', 'jpeg', 'avif'];

/**
 * @param {import('express').Express} app
 * @param {{ pre, auth, post, json }} mw  the guard pieces from server.js
 */
export function registerToolRoutes(app, { pre, auth, post, json }) {
  const guard = [pre, auth, json, post];
  const upload = (opts) => [pre, auth, acceptUploads(opts), post];
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  // Option lists the pages render, so the UI and server never drift apart.
  app.get('/tools/meta', guard, (req, res) => {
    res.json({
      socialPresets: SOCIAL_PRESETS,
      flyerSizes: Object.fromEntries(Object.entries(FLYER_SIZES).map(([k, v]) => [k, v.label])),
      tagLayouts: Object.fromEntries(Object.entries(TAG_LAYOUTS).map(([k, v]) => [k, v.label])),
      fontFamily: FONT_FAMILY,
      limits: { imageMB: LIMITS.imageBytes / 2 ** 20, pdfMB: LIMITS.pdfBytes / 2 ** 20, videoMB: LIMITS.videoBytes / 2 ** 20 }
    });
  });

  // --- images ----------------------------------------------------------------

  const imageUpload = (extra = {}) => upload({ kinds: ['image'], maxBytes: LIMITS.imageBytes, ...extra });

  app.post(
    '/image/convert',
    imageUpload(),
    wrap(async (req, res) => {
      const b = req.body;
      const opts = {
        format: field.oneOf(b.format, IMAGE_FORMATS, 'webp'),
        quality: field.num(b.quality, 85, 1, 100),
        width: field.num(b.width, 0, 0, 8192) || undefined,
        height: field.num(b.height, 0, 0, 8192) || undefined,
        fit: field.oneOf(b.fit, ['inside', 'cover', 'contain'], 'inside'),
        background: b.background === 'transparent' ? undefined : field.hex(b.background, undefined),
        lossless: field.bool(b.lossless)
      };
      const results = await heavy(async () => {
        const out = [];
        for (const f of req.files) out.push(await convertImage(f, opts));
        return out;
      });
      if (results.length === 1) {
        const r = results[0];
        return sendFile(res, { ...r, headers: { 'X-Image-Width': r.width, 'X-Image-Height': r.height } });
      }
      await sendZip(res, 'converted.zip', uniqueNames(results.map((r) => ({ name: r.filename, buffer: r.buffer }))));
    })
  );

  app.post(
    '/image/compress',
    imageUpload(),
    wrap(async (req, res) => {
      const b = req.body;
      const opts = {
        quality: field.num(b.quality, 78, 30, 95),
        maxEdge: field.num(b.maxEdge, 2560, 0, 8192),
        format: field.oneOf(b.format, ['same', 'jpeg', 'webp', 'avif'], 'same')
      };
      const results = await heavy(async () => {
        const out = [];
        for (const f of req.files) out.push(await compressImage(f, opts));
        return out;
      });
      if (results.length === 1) {
        const r = results[0];
        return sendFile(res, {
          ...r,
          headers: {
            'X-Image-Width': r.width,
            'X-Image-Height': r.height,
            'X-Original-Bytes': r.originalBytes,
            'X-Had-Metadata': r.hadMetadata,
            'X-Had-Location': r.hadLocation
          }
        });
      }
      await sendZip(res, 'compressed.zip', uniqueNames(results.map((r) => ({ name: r.filename, buffer: r.buffer }))));
    })
  );

  app.post(
    '/image/social',
    imageUpload({ maxFiles: 1, cost: (files, b) => Math.max(1, String(b.presets ?? '').split(',').length) }),
    wrap(async (req, res) => {
      const b = req.body;
      const presets = String(b.presets ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((id) => SOCIAL_PRESETS[id]);
      if (!presets.length) throw httpError(400, 'NO_PRESETS', 'Pick at least one size.');
      const { entries, warnings } = await heavy(() =>
        socialPack(req.files[0], {
          presets,
          mode: field.oneOf(b.mode, ['smart', 'center', 'top', 'bottom', 'blur', 'color'], 'smart'),
          background: field.hex(b.background, '#0B1F3A'),
          format: field.oneOf(b.format, ['jpeg', 'png', 'webp'], 'jpeg'),
          quality: field.num(b.quality, 88, 40, 100)
        })
      );
      await sendZip(res, `${stem(req.files[0].originalname, 'image')}-social.zip`, entries, { 'X-Image-Warning': warnings.join(' | ') });
    })
  );

  app.post(
    '/image/favicon',
    imageUpload({ maxFiles: 1, cost: () => 5 }),
    wrap(async (req, res) => {
      const b = req.body;
      const { entries } = await heavy(() =>
        faviconPack(req.files[0], {
          padding: field.num(b.padding, 0, 0, 30) / 100,
          background: b.background === 'transparent' ? 'transparent' : field.hex(b.background, '#FFFFFF'),
          appName: field.text(b.appName, 60),
          themeColor: field.hex(b.themeColor, '#0B1F3A')
        })
      );
      await sendZip(res, 'favicon-pack.zip', entries);
    })
  );

  // --- PDF -------------------------------------------------------------------

  const pdfUpload = (extra = {}) => upload({ kinds: ['pdf'], maxBytes: LIMITS.pdfBytes, maxFiles: 1, ...extra });

  app.post(
    '/pdf/merge',
    upload({ kinds: ['pdf', 'image'], maxBytes: LIMITS.pdfBytes, minFiles: 1 }),
    wrap(async (req, res) => {
      const pdf = await heavy(() => mergePdfs(req.files, { pageSize: field.oneOf(req.body.pageSize, ['letter', 'a4'], 'letter') }));
      sendFile(res, { buffer: pdf, contentType: 'application/pdf', filename: 'merged.pdf' });
    })
  );

  app.post(
    '/pdf/split',
    pdfUpload(),
    wrap(async (req, res) => {
      const b = req.body;
      const entries = await heavy(() =>
        splitPdf(req.files[0], {
          mode: field.oneOf(b.mode, ['ranges', 'each'], 'ranges'),
          ranges: field.text(b.ranges, 400),
          combine: field.bool(b.combine),
          rotate: Number(field.oneOf(String(b.rotate ?? '0'), ['0', '90', '180', '270'], '0'))
        })
      );
      if (entries.length === 1) return sendFile(res, { buffer: entries[0].buffer, contentType: 'application/pdf', filename: entries[0].name });
      await sendZip(res, `${stem(req.files[0].originalname, 'document')}-split.zip`, entries);
    })
  );

  app.post(
    '/pdf/compress',
    pdfUpload({ cost: () => 5 }),
    wrap(async (req, res) => {
      const r = await heavy(() => compressPdf(req.files[0], { level: field.oneOf(req.body.level, ['small', 'balanced', 'print'], 'balanced') }));
      sendFile(res, {
        buffer: r.buffer,
        contentType: 'application/pdf',
        filename: `${stem(req.files[0].originalname, 'document')}-compressed.pdf`,
        headers: { 'X-Original-Bytes': r.before, 'X-Compressed-Bytes': r.after, 'X-Improved': r.improved }
      });
    })
  );

  app.post(
    '/pdf/to-images',
    pdfUpload({ cost: () => 5 }),
    wrap(async (req, res) => {
      const b = req.body;
      const entries = await heavy(() =>
        pdfToImages(req.files[0], {
          format: field.oneOf(b.format, ['png', 'jpeg'], 'png'),
          dpi: field.num(b.dpi, 150, 36, 300),
          ranges: field.text(b.ranges, 400) || undefined
        })
      );
      if (entries.length === 1) {
        return sendFile(res, { buffer: entries[0].buffer, contentType: entries[0].name.endsWith('.png') ? 'image/png' : 'image/jpeg', filename: entries[0].name });
      }
      await sendZip(res, `${stem(req.files[0].originalname, 'document')}-pages.zip`, entries);
    })
  );

  app.post(
    '/pdf/from-images',
    upload({ kinds: ['image'], maxBytes: LIMITS.imageBytes }),
    wrap(async (req, res) => {
      const b = req.body;
      const pdf = await heavy(() =>
        imagesToPdf(req.files, {
          pageSize: field.oneOf(b.pageSize, ['letter', 'a4', 'fit'], 'letter'),
          margin: field.num(b.margin, 36, 0, 144)
        })
      );
      sendFile(res, { buffer: pdf, contentType: 'application/pdf', filename: `${stem(req.files[0].originalname, 'images')}.pdf` });
    })
  );

  // --- video (background jobs) -------------------------------------------------

  app.post(
    '/video/jobs',
    upload({ kinds: ['video'], maxBytes: LIMITS.videoBytes, maxFiles: 1, disk: true, cost: () => 20 }),
    wrap(async (req, res) => {
      const b = req.body;
      const op = field.oneOf(b.op, ['compress', 'gif', 'frames', 'mp3'], 'compress');
      const times = String(b.times ?? '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .slice(0, 24)
        .map(parseTime);
      const job = await createJob(req.files[0], {
        op,
        start: parseTime(b.start) ?? 0,
        end: parseTime(b.end) ?? undefined,
        quality: field.oneOf(b.quality, ['small', 'balanced', 'high'], 'balanced'),
        maxHeight: Number(field.oneOf(String(b.maxHeight ?? '720'), ['0', '480', '720', '1080'], '720')),
        mute: field.bool(b.mute),
        width: Number(field.oneOf(String(b.width ?? '480'), ['320', '480', '640', '800'], '480')),
        fps: Number(field.oneOf(String(b.fps ?? '12'), ['8', '10', '12', '15', '20'], '12')),
        count: field.num(b.count, 6, 1, 24),
        times
      });
      res.status(202).json(job);
    })
  );

  app.get('/video/jobs/:id', guard, wrap(async (req, res) => res.json(view(getJob(req.params.id)))));

  app.get(
    '/video/jobs/:id/download',
    guard,
    wrap(async (req, res) => {
      const job = getJob(req.params.id);
      if (job.status !== 'done') throw httpError(409, 'NOT_READY', 'That job has not finished yet.');
      res.setHeader('Content-Type', job.contentType);
      res.setHeader('Content-Length', job.bytes);
      res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
      createReadStream(job.output).pipe(res);
    })
  );

  // --- print: flyers & tags ----------------------------------------------------

  app.post(
    '/print/flyer',
    upload({ kinds: ['image'], maxBytes: LIMITS.imageBytes, maxFiles: 2, minFiles: 0, cost: () => 3 }),
    wrap(async (req, res) => {
      const b = req.body;
      const kit = await brand.brandForPrint(field.text(b.brandId, 80));
      const photo = req.files.find((f) => f.fieldname === 'photo')?.buffer ?? null;
      const logoUpload = req.files.find((f) => f.fieldname === 'logo');
      const primary = field.hex(b.primary, kit.primary);
      const url = field.text(b.url, 1200);
      const f = {
        template: field.oneOf(b.template, ['bold', 'photo', 'clean'], 'bold'),
        size: field.oneOf(b.size, Object.keys(FLYER_SIZES), 'letter'),
        headline: field.text(b.headline, 140) || 'Your headline',
        subheadline: field.text(b.subheadline, 200),
        date: field.text(b.date, 80),
        time: field.text(b.time, 80),
        location: field.text(b.location, 160),
        price: field.text(b.price, 80),
        details: field.text(b.details, 1200),
        cta: field.text(b.cta, 60),
        url,
        urlLabel: field.text(b.urlLabel, 120) || url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\?.*$/, '').replace(/\/$/, ''),
        primary,
        accent: field.hex(b.accent, kit.accent),
        // QR modules must stay dark; fall back to ink if the brand colour is light.
        qrColor: luminance(primary) < 0.2 ? primary : '#14181F',
        brandName: field.bool(b.showBrand, true) ? kit.name : '',
        showBrandName: field.bool(b.showBrandName, false),
        website: field.text(b.website, 120) || kit.website,
        logo: logoUpload
          ? await renderLogo(logoUpload.buffer, { isSvgFile: /\.svg$/i.test(logoUpload.originalname) || logoUpload.mimetype === 'image/svg+xml', size: 600, format: 'png' })
          : field.bool(b.showLogo, true)
            ? kit.logo
            : null,
        photo
      };
      if (f.template === 'photo' && !photo) f.template = 'bold';

      const output = field.oneOf(b.output, ['pdf', 'png', 'preview'], 'pdf');
      const pdf = await heavy(() => buildFlyer(f));
      const name = stem(f.headline.toLowerCase(), 'flyer');
      if (output === 'pdf') return sendFile(res, { buffer: pdf, contentType: 'application/pdf', filename: `${name}-${f.size}.pdf` });
      const size = FLYER_SIZES[f.size];
      const png = await heavy(() => pdfToPng(pdf, output === 'preview' ? { width: 900 } : { dpi: size.dpi }));
      sendFile(res, { buffer: png, contentType: 'image/png', filename: `${name}-${f.size}.png` });
    })
  );

  const tagsSchema = z.object({
    rows: z
      .array(z.object({ name: z.string().trim().min(1).max(120), group: z.string().trim().max(80).default(''), id: z.string().trim().max(40).optional() }))
      .max(2000)
      .default([]),
    eventId: z.string().max(20).optional(),
    layout: z.enum(Object.keys(TAG_LAYOUTS)).default('badge-4x3'),
    title: z.string().trim().max(120).default(''),
    subtitle: z.string().trim().max(120).default(''),
    brandId: z.string().max(80).default('hoops-college'),
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    showLogo: z.boolean().default(true),
    qrMode: z.enum(['checkin', 'url', 'none']).default('checkin'),
    urlTemplate: z.string().trim().max(500).default(''),
    outline: z.boolean().default(false),
    sort: z.enum(['none', 'name', 'group']).default('none')
  });

  app.post(
    '/print/tags',
    guard,
    wrap(async (req, res) => {
      const o = tagsSchema.parse(req.body ?? {});
      let rows = o.rows;
      if (o.eventId) {
        const ev = await checkin.getEvent(o.eventId);
        rows = ev.roster.map((a) => ({ name: a.name, group: a.group, id: a.id }));
        if (!o.title) o.title = ev.name;
        if (!o.subtitle) o.subtitle = [ev.date, ev.location].filter(Boolean).join(' · ');
      }
      if (!rows.length) throw httpError(400, 'EMPTY_ROSTER', 'Add at least one name.');
      if (o.sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
      if (o.sort === 'group') rows = [...rows].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
      const kit = await brand.brandForPrint(o.brandId);
      const pdf = await heavy(() =>
        buildTags({ ...o, rows, primary: (o.primary ?? kit.primary).toUpperCase(), logo: o.showLogo ? kit.logo : null, brandName: kit.name })
      );
      const name = stem((o.title || 'name-tags').toLowerCase(), 'name-tags');
      sendFile(res, { buffer: pdf, contentType: 'application/pdf', filename: `${name}-${o.layout}.pdf` });
    })
  );

  // --- check-in ----------------------------------------------------------------

  app.get('/checkin/events', guard, wrap(async (req, res) => res.json({ events: await checkin.listEvents() })));
  app.post('/checkin/events', guard, wrap(async (req, res) => res.status(201).json(await checkin.createEvent(req.body ?? {}))));
  app.get('/checkin/events/:id', guard, wrap(async (req, res) => res.json(await checkin.getEvent(req.params.id))));
  app.delete('/checkin/events/:id', guard, wrap(async (req, res) => {
    await checkin.deleteEvent(req.params.id);
    res.status(204).end();
  }));
  app.post('/checkin/events/:id/roster', guard, wrap(async (req, res) => res.json(await checkin.importRoster(req.params.id, req.body ?? {}))));
  app.post('/checkin/events/:id/scan', guard, wrap(async (req, res) => res.json(await checkin.scan(req.params.id, z.object({ code: z.string().min(1).max(2000) }).parse(req.body ?? {}).code))));
  app.post('/checkin/events/:id/attendees/:pid', guard, wrap(async (req, res) => {
    const { present } = z.object({ present: z.boolean() }).parse(req.body ?? {});
    res.json(await checkin.setCheckedIn(req.params.id, req.params.pid, present));
  }));
  app.post('/checkin/events/:id/walkin', guard, wrap(async (req, res) => res.json(await checkin.walkIn(req.params.id, req.body ?? {}))));
  app.get('/checkin/events/:id/export.csv', guard, wrap(async (req, res) => {
    const { csv, filename } = await checkin.exportCsv(req.params.id);
    sendFile(res, { buffer: Buffer.from('﻿' + csv, 'utf8'), contentType: 'text/csv; charset=utf-8', filename });
  }));

  // --- brand kit ---------------------------------------------------------------

  app.get('/brand', guard, wrap(async (req, res) => res.json({ brands: await brand.listBrands(), fontFamily: FONT_FAMILY })));
  app.post('/brand', guard, wrap(async (req, res) => res.status(201).json(await brand.createBrand(req.body?.name))));
  app.patch('/brand/:id', guard, wrap(async (req, res) => res.json(await brand.updateBrand(req.params.id, req.body ?? {}))));
  app.delete('/brand/:id', guard, wrap(async (req, res) => {
    await brand.deleteBrand(req.params.id);
    res.status(204).end();
  }));
  app.post(
    '/brand/:id/logos',
    upload({ kinds: ['image'], maxBytes: 10 * 2 ** 20, maxFiles: 1 }),
    wrap(async (req, res) => res.status(201).json(await brand.addLogo(req.params.id, req.files[0], field.text(req.body.name, 60))))
  );
  app.delete('/brand/:id/logos/:logoId', guard, wrap(async (req, res) => {
    await brand.deleteLogo(req.params.id, req.params.logoId);
    res.status(204).end();
  }));
  app.get(
    '/brand/:id/logos/:logoId',
    guard,
    wrap(async (req, res) => {
      const q = req.query;
      const format = field.oneOf(q.format, ['svg', 'png', 'webp', 'jpeg'], 'png');
      const out = await heavy(() =>
        brand.exportLogo(req.params.id, req.params.logoId, {
          format,
          size: field.num(q.size, 1024, 16, 4096),
          background: q.background && q.background !== 'transparent' ? field.hex(`#${String(q.background).replace('#', '')}`, undefined) : format === 'jpeg' ? '#FFFFFF' : undefined
        })
      );
      res.setHeader('Cache-Control', 'private, max-age=60');
      sendFile(res, out);
    })
  );
}
