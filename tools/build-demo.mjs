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
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

// Build against the Admixer Standard HTML5 profile: body.html in the archive
// root, JPEG sprite as a separate file, inside 300 KB, picked by the autofit.
await page.fill('#opt-click', 'https://example.com/delia');
await page.selectOption('#opt-platform', 'admixer');
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
    entryFile: r.entryFile, inlineSprite: r.inlineSprite, zipFiles: r.zipFiles, api: r.api,
    zipNames: r.zipNames, extraFiles: r.extraFiles,
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
// The demo folder mirrors the ZIP exactly: the entry file the platform expects
// plus the separate sprite it references.
const ENTRY = payload.entryFile;

/** Writes the package the same way the ZIP lays it out, subfolders included. */
async function writePackage(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ENTRY), payload.inlineSprite ? payload.htmlInline : payload.htmlExternal);
  if (payload.inlineSprite) return;
  for (const file of payload.extraFiles) {
    await mkdir(dirname(join(dir, file.name)), { recursive: true });
    await writeFile(join(dir, file.name), file.text);
  }
  await mkdir(dirname(join(dir, payload.spriteFile)), { recursive: true });
  await writeFile(join(dir, payload.spriteFile), Buffer.from(payload.sprite, 'base64'));
}

await writePackage(OUT);
await writeFile(join(OUT, payload.backupFile), Buffer.from(payload.backup, 'base64'));
await writeFile(join(OUT, `delia-red-${payload.width}x${payload.height}.zip`), Buffer.from(payload.zip, 'base64'));

// Verify the written banner actually animates: sample the sprite offset over time.
const check = await browser.newPage({ viewport: { width: 420, height: 700 } });
await check.goto(`http://127.0.0.1:${PORT}/demo/delia-red-300x600/${ENTRY}`);
await check.waitForSelector('#frame');
const offsets = [];
for (let i = 0; i < 6; i++) {
  offsets.push(await check.evaluate(() => getComputedStyle(document.getElementById('frame')).backgroundPosition));
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true });
    await check.locator('#frame').screenshot({ path: join(SHOTS, `frame-${i}.png`), omitBackground: true });
  }
  await check.waitForTimeout(120);
}
console.log('background-position samples:', offsets.join(' | '));
if (new Set(offsets).size < 3) problems.push('banner does not appear to animate');

// Same origin over http, so the sprite pixels are readable: confirm the frame
// carries real contrast rather than a flat or blank surface.
const contrast = await check.evaluate(async () => {
  const url = getComputedStyle(document.getElementById('frame')).backgroundImage.slice(5, -2).replace(/^"|"$/g, '');
  const img = new Image();
  const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
  if (!ok) return { ok: false };
  const canvas = document.createElement('canvas');
  canvas.width = 60; canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, 300, 600, 0, 0, 60, 120);
  const data = ctx.getImageData(0, 0, 60, 120).data;
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) { if (data[i] < min) min = data[i]; if (data[i] > max) max = data[i]; }
  return { ok: true, contrast: max - min };
});
console.log('first-frame contrast:', contrast);
if (!contrast.ok) problems.push('served banner could not load its sprite');
else if (contrast.contrast < 30) problems.push('served banner renders a flat/blank frame');

if (payload.api === 'admixer') {
  const shape = await check.evaluate(() => ({
    stylesInBody: !!document.querySelector('body > style'),
    creativeInBody: !!document.querySelector('body > #container'),
    headHasStyle: !!document.querySelector('head style'),
  }));
  console.log('admixer document shape:', shape);
  if (!shape.stylesInBody || !shape.creativeInBody) problems.push('Admixer build must keep styles and creative inside <body>');
  if (shape.headHasStyle) problems.push('Admixer build still has a <style> in <head>');
} else {
  const adSize = await check.getAttribute('meta[name="ad.size"]', 'content');
  const clickTag = await check.evaluate(() => window.clickTag);
  console.log('ad.size:', adSize, '| clickTag:', clickTag);
  if (adSize !== `width=${payload.width},height=${payload.height}`) problems.push('ad.size meta is wrong');
  if (!clickTag) problems.push('clickTag is missing');
}

// A scaled sprite must still lay out at exactly the declared banner size.
// Admixer's layout has the outer container follow the slot at 100%, so the
// creative box is the inner element there.
const BOX = payload.api === 'admixer' ? '#animation_container' : '#container';
const box = await check.locator(BOX).boundingBox();
console.log('rendered box:', box.width + 'x' + box.height);
if (Math.abs(box.width - payload.width) > 2 || Math.abs(box.height - payload.height) > 2) {
  problems.push(`banner renders at ${box.width}x${box.height}, expected ${payload.width}x${payload.height}`);
}
if (payload.api === 'admixer') {
  if (payload.sizes.zip / 1024 > 300) problems.push(`ZIP is ${(payload.sizes.zip / 1024).toFixed(1)} KB, over Admixer's 300 KB`);
  if (payload.entryFile !== 'body.html') problems.push(`Admixer entry file must be body.html, got ${payload.entryFile}`);
  if (payload.inlineSprite) problems.push('Admixer requires the sprite as a separate file');

  const expected = [
    'body.html', 'js/banner.js', 'js/body.js', 'images/sprite.jpg',
    'index/index.html', 'index/settings.js', 'index/css/index.css',
  ];
  console.log('zip entries:', payload.zipNames);
  for (const want of expected) {
    if (!payload.zipNames.includes(want)) problems.push(`Admixer ZIP is missing ${want}`);
  }
  if (!payload.zipNames.some((n) => n === 'index/banners/banner/body/')) {
    problems.push('Admixer ZIP is missing the index/banners/banner/body/ preview folder');
  }

  // The glue file is the contract with the platform — check its shape, not
  // just that it exists.
  const glue = payload.extraFiles.find((f) => f.name === 'js/body.js')?.text || '';
  const wants = [
    ['globalHTML5Api.on("load"', 'load-event registration'],
    ['globalHTML5Api.init(', 'init() call'],
    ['globalHTML5Api.click(', 'click() exit'],
    [`'width': '${payload.width}px'`, 'declared width'],
    [`'height': '${payload.height}px'`, 'declared height'],
    ['startBanner();', 'playback start'],
  ];
  for (const [needle, what] of wants) {
    if (!glue.includes(needle)) problems.push(`js/body.js is missing the ${what}`);
  }
}
if (!payload.spriteFile.endsWith('.jpg') && !payload.spriteFile.endsWith('.png')) {
  problems.push(`sprite is ${payload.spriteFile}, which Google Ads does not accept`);
}
const blocking = await page.locator('#r-checks li.bad').count();
console.log('blocking compliance checks:', blocking);
if (blocking) problems.push(`${blocking} blocking compliance check(s) on the demo build`);

// The regression that matters most: the package extracted somewhere on its
// own, opened over file://, must render the creative rather than a blank box.
const solo = join(tmpdir(), `banner-solo-${Date.now()}`);
await writePackage(solo);
const alone = await browser.newPage({ viewport: { width: 400, height: 700 } });
await alone.goto(pathToFileURL(join(solo, ENTRY)).href);
await alone.waitForSelector('#frame');
// Pixel reads are not possible here — a file:// image taints the canvas — so
// this page proves the sprite loads and plays; the contrast check runs on the
// http-served copy above.
const render = await alone.evaluate(async () => {
  const url = getComputedStyle(document.getElementById('frame')).backgroundImage.slice(5, -2).replace(/^"|"$/g, '');
  const img = new Image();
  const ok = await new Promise((res) => { img.onload = () => res(true); img.onerror = () => res(false); img.src = url; });
  return { ok, scheme: url.slice(0, 5), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
});
console.log(`extracted ${ENTRY} over file://:`, render);
if (!render.ok) problems.push(`extracted ${ENTRY} could not load its sprite`);
if (render.naturalWidth !== payload.sheetW) {
  problems.push(`extracted ${ENTRY} loaded a sprite of ${render.naturalWidth}px, expected ${payload.sheetW}px`);
}
// Without the platform API present the creative must start by itself.
const soloOffsets = [];
for (let i = 0; i < 4; i++) {
  soloOffsets.push(await alone.locator('#frame').evaluate((e) => getComputedStyle(e).backgroundPosition));
  await alone.waitForTimeout(160);
}
console.log('  animates without the platform API:', new Set(soloOffsets).size > 2 ? 'yes' : 'NO');
if (new Set(soloOffsets).size < 3) problems.push(`extracted ${ENTRY} does not animate without the platform API`);
await alone.close();
await rm(solo, { recursive: true, force: true });

// And the separate-sprite build must explain itself rather than go white.
const orphanDir = join(tmpdir(), `banner-orphan-${Date.now()}`);
await mkdir(orphanDir, { recursive: true });
await writeFile(join(orphanDir, ENTRY), payload.htmlExternal);
const orphan = await browser.newPage({ viewport: { width: 400, height: 700 } });
await orphan.goto(pathToFileURL(join(orphanDir, ENTRY)).href);
await orphan.waitForTimeout(600);
const notice = (await orphan.locator('#frame').innerText()).trim();
console.log(`orphaned ${ENTRY} shows:`, JSON.stringify(notice.slice(0, 60) + '…'));
if (!notice) problems.push(`orphaned ${ENTRY} still renders silently blank`);
await orphan.close();
await rm(orphanDir, { recursive: true, force: true });

// A supplied template must contribute its scaffolding and nothing else: its
// own creative files are replaced, its archive junk dropped.
if (payload.api === 'admixer') {
  const tpl = await page.evaluate(async () => {
    const r = window.__converter.state.result;
    return { before: r.zipNames };
  });
  await page.setInputFiles('#opt-template', join(ROOT, 'tools/fixtures/admixer-template.zip'));
  await page.waitForFunction(() => document.getElementById('template-note').className.includes('ok'), null, { timeout: 15000 });
  await page.click('#btn-convert');
  await page.waitForFunction(() => !window.__converter.state.busy, null, { timeout: 240000 });
  const withTemplate = await page.evaluate(async () => {
    const r = window.__converter.state.result;
    const text = await r.zipBlob.slice(0).text();
    return { names: r.zipNames, carriesMarker: text.includes('TEMPLATE HARNESS MARKER') };
  });
  console.log('with a supplied template:', withTemplate.names);
  if (!withTemplate.carriesMarker) problems.push("the supplied template's index/ harness was not carried over");
  if (withTemplate.names.some((n) => n.includes('__MACOSX') || n.includes('.DS_Store'))) {
    problems.push('archive junk from the template reached the package');
  }
  if (!withTemplate.names.includes('images/sprite.jpg') || withTemplate.names.includes('images/old.jpg')) {
    problems.push("the template's own creative assets were not replaced");
  }
  if (tpl.before.length === withTemplate.names.length && !withTemplate.carriesMarker) {
    problems.push('supplying a template changed nothing');
  }
  // Leave the build that ships in demo/ free of the fixture.
  await page.evaluate(() => { document.getElementById('opt-template').value = ''; });
  await page.dispatchEvent('#opt-template', 'change');
  await page.click('#btn-convert');
  await page.waitForFunction(() => !window.__converter.state.busy, null, { timeout: 240000 });
}

// Admixer's API cannot be exercised for real from here, so stand in a mock
// that records the contract: playback must wait for its load event and the
// exit must go through click() instead of opening a window itself.
if (payload.api === 'admixer') {
  const mockDir = join(tmpdir(), `banner-mock-${Date.now()}`);
  await writePackage(mockDir);
  const mock = await browser.newPage({ viewport: { width: 400, height: 700 } });
  await mock.addInitScript(() => {
    window.__calls = { on: [], click: [], windowOpen: 0 };
    window.__fire = null;
    window.__calls.init = [];
    window.globalHTML5Api = {
      on: (event, handler) => { window.__calls.on.push(event); if (event === 'load') window.__fire = handler; },
      init: (config) => { window.__calls.init.push(JSON.stringify(config)); },
      close: () => {},
      click: (url) => { window.__calls.click.push(url === undefined ? '(no argument)' : url); },
    };
    const open = window.open;
    window.open = function (...args) { window.__calls.windowOpen++; return open.apply(window, args); };
  });
  await mock.goto(pathToFileURL(join(mockDir, ENTRY)).href);
  await mock.waitForSelector('#frame');
  await mock.waitForTimeout(400);

  const held = await mock.evaluate(() => ({
    subscribed: window.__calls.on,
    positionBeforeLoad: getComputedStyle(document.getElementById('frame')).backgroundPosition,
  }));
  await mock.evaluate(() => window.__fire && window.__fire());
  await mock.waitForTimeout(400);
  await mock.click('#container');
  const after = await mock.evaluate(() => ({
    calls: window.__calls,
    positionAfterLoad: getComputedStyle(document.getElementById('frame')).backgroundPosition,
  }));

  console.log('mock globalHTML5Api:', { subscribed: held.subscribed, ...after.calls });
  if (!held.subscribed.includes('load')) problems.push('Admixer build does not subscribe to globalHTML5Api load');
  if (held.positionBeforeLoad !== '0px 0px') problems.push('Admixer build animated before the load event fired');
  if (after.positionAfterLoad === '0px 0px') problems.push('Admixer build did not start after the load event');
  if (after.calls.click.length !== 1) problems.push(`expected one globalHTML5Api.click() call, got ${after.calls.click.length}`);
  if (after.calls.windowOpen !== 0) problems.push('Admixer build opened a window instead of using globalHTML5Api.click()');
  const initConfig = after.calls.init[0] ? JSON.parse(after.calls.init[0]) : null;
  if (!initConfig) problems.push('Admixer build never called globalHTML5Api.init()');
  else {
    const state = initConfig.resize && initConfig.resize[0];
    if (!state || state.width !== `${payload.width}px` || state.height !== `${payload.height}px`) {
      problems.push(`init() declared ${JSON.stringify(state)}, expected ${payload.width}x${payload.height}`);
    }
  }
  await mock.close();
  await rm(mockDir, { recursive: true, force: true });
}

await browser.close();
server.close();

if (problems.length) {
  console.error('\nFAILED:\n' + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log('\nOK — demo written to demo/delia-red-300x600/');
