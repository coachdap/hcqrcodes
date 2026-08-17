/**
 * True-vector SVG renderer.
 *
 * We render the module matrix ourselves rather than using qrcode's toString('svg')
 * so that the keep-out box, the logo placement and the reported QR version all come
 * from the same matrix, and so the output carries a viewBox that scales cleanly for
 * large-format print.
 */

/** Merge horizontal runs of dark modules into single path commands. */
function modulesToPath(matrix, margin) {
  const { size, data } = matrix;
  const commands = [];

  for (let row = 0; row < size; row++) {
    let run = 0;
    for (let col = 0; col <= size; col++) {
      const dark = col < size && data[row * size + col];
      if (dark) {
        run++;
        continue;
      }
      if (run > 0) {
        const x = col - run + margin;
        const y = row + margin;
        commands.push(run === 1 ? `M${x} ${y}h1v1h-1z` : `M${x} ${y}h${run}v1h-${run}z`);
        run = 0;
      }
    }
  }
  return commands.join('');
}

const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const EVENT_ATTR_RE = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const EXTERNAL_HREF_RE = /\s(?:xlink:)?href\s*=\s*("|')\s*(?!#|data:)[a-z]+:[^"']*\1/gi;

/**
 * Strip active content from a caller-supplied SVG logo. The rendered output is
 * inlined straight into the DOM by Hyperframes templates, so anything executable
 * in the logo would execute in the host page.
 */
function sanitizeSvg(markup) {
  return markup.replace(SCRIPT_RE, '').replace(EVENT_ATTR_RE, '').replace(EXTERNAL_HREF_RE, '');
}

/** Pull the root <svg> element's attributes and inner markup out of a logo file. */
function parseSvgLogo(markup) {
  const open = /<svg\b([^>]*)>/i.exec(markup);
  if (!open) return null;
  const close = markup.lastIndexOf('</svg>');
  if (close === -1) return null;

  const attrs = open[1];
  const inner = markup.slice(open.index + open[0].length, close);

  const viewBox = /\bviewBox\s*=\s*("|')([^"']+)\1/i.exec(attrs)?.[2];
  if (viewBox) return { viewBox, inner };

  const width = parseFloat(/\bwidth\s*=\s*("|')?([\d.]+)/i.exec(attrs)?.[2] ?? '');
  const height = parseFloat(/\bheight\s*=\s*("|')?([\d.]+)/i.exec(attrs)?.[2] ?? '');
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { viewBox: `0 0 ${width} ${height}`, inner };
  }
  return { viewBox: '0 0 100 100', inner };
}

/**
 * @returns {{ svg: string, warnings: string[] }}
 */
export function renderSvg({ matrix, margin, dark, light, size, logo, logoScale }) {
  const total = matrix.size + margin * 2;
  const warnings = [];
  const parts = [];

  const dimensions = size ? ` width="${size}" height="${size}"` : '';
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${dimensions} viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
  );
  parts.push(`<rect width="${total}" height="${total}" fill="${light}"/>`);
  parts.push(`<path fill="${dark}" d="${modulesToPath(matrix, margin)}"/>`);

  if (logo) {
    // logoScale is a fraction of the full rendered width, quiet zone included,
    // so SVG and PNG place the logo identically.
    const logoSide = total * logoScale;
    const boxSide = logoSide * 1.18;
    const boxOrigin = (total - boxSide) / 2;
    const logoOrigin = (total - logoSide) / 2;

    parts.push(
      `<rect x="${round(boxOrigin)}" y="${round(boxOrigin)}" width="${round(boxSide)}" height="${round(boxSide)}" rx="${round(boxSide * 0.08)}" fill="${light}"/>`
    );

    if (logo.isVector) {
      const parsed = parseSvgLogo(sanitizeSvg(logo.buffer.toString('utf8')));
      if (parsed) {
        parts.push(
          `<svg x="${round(logoOrigin)}" y="${round(logoOrigin)}" width="${round(logoSide)}" height="${round(logoSide)}" viewBox="${parsed.viewBox}" preserveAspectRatio="xMidYMid meet" overflow="visible">${parsed.inner}</svg>`
        );
      } else {
        warnings.push('logo could not be parsed as SVG; it was omitted from the output');
      }
    } else {
      parts.push(
        `<image x="${round(logoOrigin)}" y="${round(logoOrigin)}" width="${round(logoSide)}" height="${round(logoSide)}" preserveAspectRatio="xMidYMid meet" href="data:${logo.mime};base64,${logo.buffer.toString('base64')}"/>`
      );
      warnings.push(
        'raster logo embedded as base64; this SVG is not pure vector. Supply an SVG logo for large-format print.'
      );
    }
  }

  parts.push('</svg>');
  return { svg: parts.join(''), warnings };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
