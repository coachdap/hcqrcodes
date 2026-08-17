#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { generate } from '../src/core.js';
import { buildWifiPayload, buildVcardPayload } from '../src/payloads.js';

const USAGE = `qrgen — generate a QR code locally (no server required)

Usage:
  qrgen "<data>" [options]
  qrgen wifi  --ssid <name> [--password <pw>] [--encryption WPA|WEP|nopass] [--hidden] [options]
  qrgen vcard --name "<name>" [--org <o>] [--title <t>] [--phone <p>] [--email <e>] [--url <u>] [options]

Options:
  -o, --out <file>      Write to file (format inferred from extension). Omit to write to stdout.
  -f, --format <fmt>    svg | png            (default: svg, or inferred from --out)
  -s, --size <px>       PNG pixel size       (default: 1024)
  -m, --margin <n>      Quiet zone, modules  (default: 4)
      --ec <level>      L | M | Q | H        (default: M; forced to H with --logo)
      --dark <hex>      Foreground colour    (default: #000000)
      --light <hex>     Background colour    (default: #FFFFFF)
      --logo <file>     Centre logo (SVG keeps the output pure vector)
      --logo-scale <n>  Fraction of width    (default: 0.2, capped at 0.25)
  -h, --help            Show this help

Examples:
  qrgen "https://hoopscollege.com/tryouts" --out flyer.svg --ec H --logo logo.svg
  qrgen wifi --ssid "HC Gym" --password "hoops2026" --out wifi.png --size 2048
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const aliases = { o: 'out', f: 'format', s: 'size', m: 'margin', h: 'help' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const raw = arg.replace(/^--?/, '');
    const [name, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null];
    const key = camel(aliases[name] ?? name);

    if (inline !== null) {
      flags[key] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
      flags[key] = argv[++i];
    } else {
      flags[key] = true;
    }
  }
  return { flags, positional };
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function renderOptions(flags, out) {
  const format = flags.format ?? (out ? path.extname(out).slice(1).toLowerCase() : null) ?? 'svg';
  const options = { format };
  if (flags.size !== undefined) options.size = Number(flags.size);
  if (flags.margin !== undefined) options.margin = Number(flags.margin);
  if (flags.ec !== undefined) options.ecLevel = String(flags.ec).toUpperCase();
  if (flags.dark !== undefined) options.dark = String(flags.dark);
  if (flags.light !== undefined) options.light = String(flags.light);
  if (flags.logo !== undefined) options.logo = String(flags.logo);
  if (flags.logoScale !== undefined) options.logoScale = Number(flags.logoScale);
  return options;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help || (positional.length === 0 && !flags.ssid && !flags.name)) {
    process.stdout.write(USAGE);
    process.exit(positional.length === 0 && !flags.help ? 1 : 0);
  }

  const [first, ...rest] = positional;
  const subcommand = ['wifi', 'vcard'].includes(first) ? first : null;
  const out = flags.out ? String(flags.out) : null;

  let data;
  if (subcommand === 'wifi') {
    data = buildWifiPayload({
      ssid: required(flags.ssid, '--ssid'),
      password: flags.password ? String(flags.password) : undefined,
      encryption: flags.encryption ? String(flags.encryption) : 'WPA',
      hidden: flags.hidden === true || flags.hidden === 'true'
    });
  } else if (subcommand === 'vcard') {
    data = buildVcardPayload({
      name: required(flags.name, '--name'),
      org: str(flags.org),
      title: str(flags.title),
      phone: str(flags.phone),
      email: str(flags.email),
      url: str(flags.url)
    });
  } else {
    data = [first, ...rest].join(' ');
  }

  // The CLI is operator-driven, so logo paths are not confined to QRGEN_LOGO_DIR.
  const result = await generate({ ...renderOptions(flags, out), data }, { allowedLogoDir: null });

  if (out) {
    await writeFile(out, result.buffer);
    console.error(
      `${out}  ${result.buffer.length.toLocaleString()} bytes  QR version ${result.version}  ecLevel ${result.ecLevel}`
    );
  } else {
    process.stdout.write(result.buffer);
  }

  for (const warning of result.warnings) console.error(`warning: ${warning}`);
}

const str = (v) => (v === undefined ? undefined : String(v));

function required(value, flag) {
  if (value === undefined || value === true) {
    console.error(`error: ${flag} is required`);
    process.exit(1);
  }
  return String(value);
}

main().catch((err) => {
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) console.error(`error: ${issue.path.join('.') || 'input'}: ${issue.message}`);
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exit(1);
});
