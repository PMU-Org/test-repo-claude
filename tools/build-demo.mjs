/**
 * Drives the converter in headless Chromium to regenerate demo/ from the
 * bundled sample. Doubles as the end-to-end test: if the pipeline breaks, this
 * script fails instead of shipping a stale demo.
 *
 *   node tools/build-demo.mjs [--port 8123] [--keep-shots]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8123;
const OUT = join(ROOT, 'demo', 'delia-red-300x600');
const SHOTS = process.argv.includes('--keep-shots') ? join(ROOT, 'demo', 'shots') : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.webm': 'video/webm',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));

await page.goto(`http://127.0.0.1:${PORT}/index.html`);
await page.click('#btn-sample');
await page.waitForSelector('#source-info:not(.hidden)', { timeout: 60000 });
await page.waitForFunction(() => !window.__converter.state.busy && window.__converter.state.meta, null, { timeout: 60000 });

const meta = await page.evaluate(() => window.__converter.state.meta);
console.log('source:', meta);

// Build against the Google Ads profile: JPEG sprite (WebP is not in Google's
// allowed asset types) inside the 600 KB limit, picked by the budget autofit.
await page.fill('#opt-click', 'https://example.com/delia');
await page.selectOption('#opt-platform', 'google-ads');
await page.click('#btn-autofit');
await page.waitForSelector('#step-result:not(.hidden)', { timeout: 180000 });
await page.waitForFunction(() => !window.__converter.state.busy, null, { timeout: 180000 });

const payload = await page.evaluate(async () => {
  const r = window.__converter.state.result;
  const b64 = (blob) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result.split(',')[1]);
    fr.readAsDataURL(blob);
  });
  return {
    htmlExternal: r.htmlExternal, htmlInline: r.htmlInline,
    sprite: await b64(r.spriteBlob), backup: await b64(r.backupBlob), zip: await b64(r.zipBlob),
    spriteFile: r.spriteFile, backupFile: r.backupFile,
    frames: r.frames, cols: r.cols, fps: r.fps, sheetW: r.sheetW, sheetH: r.sheetH,
    sizes: r.sizes, width: r.width, height: r.height, scale: r.scale,
    verdict: document.getElementById('r-verdict').textContent,
    checks: [...document.querySelectorAll('#r-checks li')].map((li) => `${li.className || 'ok'} — ${li.textContent}`),
  };
});

console.log('autofit:', payload.verdict);
console.log('compliance:', payload.checks.join('\n            '));
console.log('result:', {
  frames: payload.frames, grid: `${payload.cols}x${Math.ceil(payload.frames / payload.cols)}`,
  sheet: `${payload.sheetW}x${payload.sheetH}`, scale: payload.scale,
  sprite: `${(payload.sizes.sprite / 1024).toFixed(1)} KB`,
  zip: `${(payload.sizes.zip / 1024).toFixed(1)} KB`,
  singleHtml: `${(payload.sizes.html / 1024).toFixed(1)} KB`,
});

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'index.html'), payload.htmlExternal);
await writeFile(join(OUT, payload.spriteFile), Buffer.from(payload.sprite, 'base64'));
await writeFile(join(OUT, payload.backupFile), Buffer.from(payload.backup, 'base64'));
await writeFile(join(OUT, 'banner-inline.html'), payload.htmlInline);
await writeFile(join(OUT, `delia-red-${payload.width}x${payload.height}.zip`), Buffer.from(payload.zip, 'base64'));

// Verify the written banner actually animates: sample the sprite offset over time.
const check = await browser.newPage({ viewport: { width: 420, height: 700 } });
await check.goto(`http://127.0.0.1:${PORT}/demo/delia-red-300x600/index.html`);
await check.waitForSelector('#frame');
const offsets = [];
for (let i = 0; i < 6; i++) {
  offsets.push(await check.evaluate(() => getComputedStyle(document.getElementById('frame')).backgroundPosition));
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true });
    await check.locator('#ad').screenshot({ path: join(SHOTS, `frame-${i}.png`), omitBackground: true });
  }
  await check.waitForTimeout(120);
}
console.log('background-position samples:', offsets.join(' | '));
if (new Set(offsets).size < 3) problems.push('banner does not appear to animate');

const adSize = await check.getAttribute('meta[name="ad.size"]', 'content');
const clickTag = await check.evaluate(() => window.clickTag);
console.log('ad.size:', adSize, '| clickTag:', clickTag);
if (adSize !== `width=${payload.width},height=${payload.height}`) problems.push('ad.size meta is wrong');
if (!clickTag) problems.push('clickTag is missing');

// A scaled sprite must still lay out at exactly the declared banner size.
const box = await check.locator('#ad').boundingBox();
console.log('rendered box:', box.width + 'x' + box.height);
if (Math.abs(box.width - payload.width) > 2 || Math.abs(box.height - payload.height) > 2) {
  problems.push(`banner renders at ${box.width}x${box.height}, expected ${payload.width}x${payload.height}`);
}
if (payload.sizes.zip / 1024 > 600) {
  problems.push(`ZIP is ${(payload.sizes.zip / 1024).toFixed(1)} KB, over the 600 KB Google Ads limit`);
}
if (!payload.spriteFile.endsWith('.jpg') && !payload.spriteFile.endsWith('.png')) {
  problems.push(`sprite is ${payload.spriteFile}, which Google Ads does not accept`);
}
const blocking = await page.locator('#r-checks li.bad').count();
console.log('blocking compliance checks:', blocking);
if (blocking) problems.push(`${blocking} blocking compliance check(s) on the demo build`);

await browser.close();
server.close();

if (problems.length) {
  console.error('\nFAILED:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nOK — demo written to demo/delia-red-300x600/');
