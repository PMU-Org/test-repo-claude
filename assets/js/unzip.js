/**
 * Minimal ZIP reader, enough to take an Admixer template archive apart in the
 * browser and carry its scaffolding into the generated package.
 *
 * Why read a template at all: the platform's own template is the only
 * authority on what a package must contain — the index/ preview harness
 * carries ids and markup that cannot be reconstructed from documentation.
 * Reusing the archive that already works beats guessing at its contents.
 *
 * Supports stored and deflated entries; deflate is handled by the platform's
 * DecompressionStream, so there is no compression library to ship.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

function findEndOfCentralDirectory(view) {
  // The comment field means the record is not at a fixed offset; it is at most
  // 64 KB from the end, so scan backwards over that window.
  const start = Math.max(0, view.byteLength - 66000);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Браузер не вміє розпаковувати deflate — оновіть браузер або дайте незжатий архів.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{name: string, data: Uint8Array, isDir: boolean}>>}
 */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('Це не схоже на ZIP-архів.');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // The local header repeats the name and extra fields with its own lengths.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    const isDir = name.endsWith('/');
    let data = new Uint8Array(0);
    if (!isDir && compressedSize > 0) {
      data = method === 0 ? raw.slice() : await inflate(raw);
    }
    entries.push({ name, data, isDir });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Archive noise that must never reach a creative package. */
export function isJunk(name) {
  return name.startsWith('__MACOSX/')
    || name.split('/').some((part) => part === '.DS_Store' || part === 'Thumbs.db' || part.startsWith('._'));
}
