/**
 * The index/ preview folder that Admixer packages carry.
 *
 * Admixer's own template ships a preview rig — index/index.html plus the
 * empty banners/banner/body/ tree its docs tell you to copy the creative
 * into. Their rig pulls the live ad server, and its mock bid response carries
 * template ids that cannot be derived from documentation, so the reliable way
 * to reproduce it is to carry the folder over from a template archive the
 * user already ships (see `carryOver`).
 *
 * Without a template, this fallback occupies the same paths and does the one
 * thing the folder is actually for: open the creative at its declared size.
 */

export const HARNESS_ROOT = 'index';

/** Paths a generated creative owns; anything else in a template is scaffolding. */
const CREATIVE_PATHS = [/^body\.html$/, /^index\.html$/, /^js\//, /^images\//, /^README\.txt$/];

const isCreativePath = (name) => CREATIVE_PATHS.some((pattern) => pattern.test(name));

/**
 * Scaffolding from a user-supplied template archive: everything that is not
 * the template's own creative and not archive noise.
 *
 * @param {Array<{name: string, data: Uint8Array, isDir: boolean}>} entries
 * @param {(name: string) => boolean} isJunk
 */
export function carryOver(entries, isJunk) {
  return entries.filter((entry) => !isJunk(entry.name) && !isCreativePath(entry.name));
}

/**
 * Preview page for the index/ folder.
 *
 * It used to pull a stylesheet and frame the creative in an iframe, which made
 * a page that fails into something worse than nothing: with either sibling
 * missing you get unstyled text around an empty box, and it reads as a broken
 * banner rather than a broken preview. So it now renders the creative itself
 * from one file, referencing the same images one level up — nothing to load
 * but the frames the banner already needs.
 *
 * @param {string} creativeHtml a self-contained render of the creative whose
 *   asset paths are already relative to this folder
 */
export function buildFallbackHarness({ entryFile, creativeHtml, height }) {
  // The creative is positioned out of flow, so the body has no height of its
  // own to push the note below it.
  const note = `<p style="position:absolute;left:0;top:${height}px;margin:12px 0 0;max-width:62ch;`
    + `font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;color:#666;">`
    + `Сторінка перегляду. Сам банер — <b>${entryFile}</b> у корені архіву; ця тека потрібна`
    + ` лише для локального показу і не є частиною креатива.</p>`;

  const html = creativeHtml.replace('</body>', `${note}\n</body>`);

  return [
    { name: `${HARNESS_ROOT}/index.html`, text: html },
    { name: `${HARNESS_ROOT}/banners/banner/body/`, isDir: true },
  ];
}
