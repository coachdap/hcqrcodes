import QRCode from 'qrcode';
import sharp from 'sharp';

/**
 * PNG renderer. qrcode draws the symbol at an exact integer module scale, then
 * sharp resizes with a nearest-neighbour kernel so module edges stay hard, and
 * composites the keep-out box and logo.
 */
export async function renderPng({ data, version, ecLevel, margin, dark, light, size, logo, logoScale }) {
  const warnings = [];

  const base = await QRCode.toBuffer(data, {
    type: 'png',
    errorCorrectionLevel: ecLevel,
    version,
    margin,
    width: size,
    color: { dark, light }
  });

  let image = sharp(base).resize(size, size, { kernel: 'nearest' });

  if (logo) {
    const logoSide = Math.max(1, Math.round(size * logoScale));
    const boxSide = Math.max(1, Math.round(logoSide * 1.18));
    const boxOffset = Math.round((size - boxSide) / 2);
    const logoOffset = Math.round((size - logoSide) / 2);

    const keepOut = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${boxSide}" height="${boxSide}"><rect width="${boxSide}" height="${boxSide}" rx="${Math.round(boxSide * 0.08)}" fill="${light}"/></svg>`
      )
    )
      .png()
      .toBuffer();

    let logoBuffer;
    try {
      // High density so an SVG logo rasterises sharply at the target size.
      logoBuffer = await sharp(logo.buffer, logo.isVector ? { density: 600 } : {})
        .resize(logoSide, logoSide, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } catch (err) {
      throw Object.assign(new Error(`logo could not be rendered: ${err.message}`), {
        status: 400,
        code: 'INVALID_LOGO'
      });
    }

    image = sharp(await image.png().toBuffer()).composite([
      { input: keepOut, top: boxOffset, left: boxOffset },
      { input: logoBuffer, top: logoOffset, left: logoOffset }
    ]);
  }

  return { buffer: await image.png({ compressionLevel: 9 }).toBuffer(), warnings };
}
