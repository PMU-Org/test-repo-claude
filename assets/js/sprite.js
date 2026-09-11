/**
 * Sprite sheet packing and encoding.
 *
 * Frames go into a near-square grid: a single strip would blow past the
 * 16 383 px WebP dimension limit after ~54 frames of a 300 px-wide creative,
 * and a square sheet also decodes into less wasted memory.
 */

const MAX_DIM = 16383; // WebP hard limit; PNG/JPEG are looser but this is a safe common bound

export function planGrid(count, frameW, frameH) {
  const maxCols = Math.max(1, Math.floor(MAX_DIM / frameW));
  const maxRows = Math.max(1, Math.floor(MAX_DIM / frameH));

  let cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt((count * frameH) / frameW))));
  let rows = Math.ceil(count / cols);

  while (rows > maxRows && cols < maxCols) {
    cols++;
    rows = Math.ceil(count / cols);
  }
  if (rows > maxRows) {
    throw new Error(`Занадто багато кадрів для одного спрайта (${count}). Зменште fps, розмір або обріжте анімацію.`);
  }
  return { cols, rows, sheetW: cols * frameW, sheetH: rows * frameH };
}

export function packSheet(canvases, frameW, frameH, background) {
  const { cols, rows, sheetW, sheetH } = planGrid(canvases.length, frameW, frameH);
  const sheet = document.createElement('canvas');
  sheet.width = sheetW;
  sheet.height = sheetH;

  const ctx = sheet.getContext('2d', { alpha: !background });
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, sheetW, sheetH);
  }
  canvases.forEach((c, i) => {
    ctx.drawImage(c, (i % cols) * frameW, Math.floor(i / cols) * frameH);
  });

  return { canvas: sheet, cols, rows, sheetW, sheetH };
}

/**
 * Each frame as its own file.
 *
 * A sheet is smaller, but it hides its only asset reference inside a CSS
 * url(), and it is one image whose geometry every frame depends on — an ad
 * server that rewrites or recompresses assets breaks the whole animation.
 * Separate frames referenced by <img src> survive that, which is how the
 * creatives these platforms actually serve are built.
 */
export async function encodeFrames(canvases, mime, quality) {
  const blobs = [];
  for (const canvas of canvases) blobs.push(await encode(canvas, mime, quality));
  return blobs;
}

export function encode(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Браузер не підтримує кодування ${mime}.`))),
      mime,
      mime === 'image/png' ? undefined : quality / 100
    );
  });
}

export async function blobToDataURL(blob) {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function extensionFor(mime) {
  return { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[mime] || 'bin';
}
