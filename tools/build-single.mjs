/**
 * Bundles the converter into one self-contained .html file.
 *
 * Two reasons this build exists: ES modules cannot be loaded over file://, so
 * the multi-file version only works from a web server; and a single file can be
 * dropped on any host, intranet share or USB stick and just open.
 *
 *   node tools/build-single.mjs [--out dist/converter-standalone.html] [--keep-sample]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const outArg = process.argv.indexOf('--out');
const OUT = join(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'dist/converter-standalone.html');
const KEEP_SAMPLE = process.argv.includes('--keep-sample');

// Dependency order — the modules have no cycles, so a fixed order is enough.
const MODULES = ['extract.js', 'sprite.js', 'zip.js', 'banner.js', 'app.js'];

const read = (p) => readFile(join(ROOT, p), 'utf8');

/** Flatten ESM into one classic script: drop the import lines, keep the bodies. */
function stripModuleSyntax(source) {
  return source
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(const|function|async function|class|let|var)\b)/gm, '')
    .trimStart();
}

/**
 * banner.js emits a document containing a <script> element. Inside an inline
 * script the HTML parser stops at the first `</script`, wherever it appears —
 * string literal or not — so it has to be broken up. `<\/script` is the same
 * string to JavaScript and invisible to the parser.
 */
function escapeForInlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\x21--');
}

let html = await read('index.html');
const css = await read('assets/css/app.css');
const js = escapeForInlineScript(
  (await Promise.all(MODULES.map((m) => read(`assets/js/${m}`))))
    .map((source, i) => `/* ── ${MODULES[i]} ────────────────────────────── */\n${stripModuleSyntax(source)}`)
    .join('\n\n')
);

html = html.replace('<link rel="stylesheet" href="assets/css/app.css">', `<style>\n${css}\n</style>`);
html = html.replace('<script type="module" src="assets/js/app.js"></script>', `<script>\n${js}\n</script>`);
html = html.replace('    <a class="ghlink" href="demo/">Приклад збірки</a>\n', '');

if (!KEEP_SAMPLE) {
  // Nothing to fetch a sample from in a single file.
  html = html.replace(/\s*<button type="button" class="btn ghost" id="btn-sample">[^<]*<\/button>/, '');
  html = html.replace(
    "el.dropzone.addEventListener('click', (e) => { if (e.target !== el.sample) el.fileInput.click(); });",
    "el.dropzone.addEventListener('click', () => el.fileInput.click());"
  );
  // Drop the sample wiring block wholesale; it starts and ends at known markers.
  const start = html.indexOf("el.sample.addEventListener('click'");
  const end = html.indexOf('PRESETS.forEach', start);
  if (start > -1 && end > start) html = html.slice(0, start) + html.slice(end);
  html = html.replace(
    '<p class="dz-sub">',
    '<p class="dz-sub" data-note="standalone">'
  );
}

if (html.includes('assets/')) {
  throw new Error(`bundle still references assets/: ${html.match(/[^"'\s]*assets\/[^"'\s]*/g).join(', ')}`);
}
if (/\bimport\s|\bexport\s/.test(html.slice(html.indexOf('<script>')))) {
  throw new Error('bundle still contains module syntax');
}
// One </script> must remain: the one that closes the inline bundle.
const closers = html.match(/<\/script>/gi) || [];
if (closers.length !== 1) {
  throw new Error(`expected exactly one </script> in the bundle, found ${closers.length}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`${OUT} — ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
