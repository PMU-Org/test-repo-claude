/**
 * Generates the banner package.
 *
 * Two flavours, because ad platforms disagree on the basics:
 *
 *  - `standard` — Google Ads, DV360, CM360, IAB. Entry point index.html, a
 *    <meta name="ad.size"> declaration, a global clickTag, and the creative
 *    starts on its own.
 *
 *  - `admixer` — Admixer Standard HTML5. Entry point body.html, everything
 *    inside <body> (their docs are explicit that content outside it may not
 *    show), the creative waits for globalHTML5Api's load event, and the exit
 *    goes through globalHTML5Api.click() rather than window.open.
 *
 * Either way the player advances on requestAnimationFrame with an accumulator
 * instead of setInterval, so playback holds the requested fps without
 * drifting, and it parks on the last frame once the loop budget is spent.
 */

/** Core playback, identical in both flavours. */
const PLAYER_CORE = `  var FRAMES = %FRAMES%, COLS = %COLS%, FW = %FW%, FH = %FH%, FPS = %FPS%, LOOPS = %LOOPS%;
  var el = document.getElementById('frame'), ad = document.getElementById('ad');
  var idx = 0, loops = 0, acc = 0, prev = 0, raf = 0, step = 1000 / FPS;

  function show(i) {
    el.style.backgroundPosition = -(i %% COLS) * FW + 'px ' + -Math.floor(i / COLS) * FH + 'px';
  }

  function tick(now) {
    if (!prev) prev = now;
    acc += now - prev;
    prev = now;
    if (acc > step * 5) acc = step; // a backgrounded tab must not fast-forward
    while (acc >= step) {
      acc -= step;
      if (idx + 1 >= FRAMES) {
        loops++;
        if (LOOPS && loops >= LOOPS) { show(FRAMES - 1); raf = 0; return; }
        idx = 0;
      } else {
        idx++;
      }
    }
    show(idx);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    show(0);
    if (FRAMES > 1) raf = requestAnimationFrame(tick);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; prev = 0; }
    else if (!raf && !(LOOPS && loops >= LOOPS)) { raf = requestAnimationFrame(tick); }
  });
`;

const EXIT_STANDARD = `
  if (ad) {
    ad.href = window.clickTag || '#';
    ad.addEventListener('click', function (e) {
      e.preventDefault();
      window.open(window.clickTag, '_blank');
    });
  }
  start();
`;

/**
 * Admixer connects globalHTML5Api itself and expects the creative to wait for
 * its load event. The fallback branch is what makes the exported file still
 * open by double click: with no API present it simply starts and exits through
 * window.open, so local preview behaves like the served creative.
 *
 * click() is called without an argument by default. Admixer's docs warn that a
 * URL in the code outranks the Landing Page field in their UI and that mixing
 * the two is a conflict, so the safe default is to let the UI own the URL.
 */
const EXIT_ADMIXER = `
  function exit() {
    var api = window.globalHTML5Api;
    if (api && typeof api.click === 'function') { api.click(%CLICK_ARG%); return; }
    window.open(CLICK_URL, '_blank'); // local preview, outside Admixer
  }

  if (ad) {
    ad.addEventListener('click', function (e) { e.preventDefault(); exit(); });
    ad.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exit(); }
    });
  }

  var api = window.globalHTML5Api;
  if (api && typeof api.on === 'function') { api.on('load', start); } else { start(); }
`;

/**
 * A missing sprite otherwise renders as a silent white box — the failure you
 * get by opening the entry file straight out of a ZIP viewer, which extracts
 * only the file you clicked. Say so, but only while previewing locally: a
 * served creative must never show diagnostics to an actual viewer.
 */
const SPRITE_GUARD = `
  var probe = new Image();
  probe.onerror = function () {
    cancelAnimationFrame(raf);
    raf = 0;
    if (window.console) { console.error('%SPRITE_FILE% failed to load next to %ENTRY_FILE%'); }
    var host = location.hostname;
    var local = location.protocol === 'file:' || host === '' || host === 'localhost'
      || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) { return; }
    el.style.background = '#fff';
    el.style.cssText += ';display:flex;align-items:center;justify-content:center;padding:18px;'
      + 'font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#c1121f;text-align:center';
    el.textContent = 'Не знайдено %SPRITE_FILE% поруч з %ENTRY_FILE%. '
      + 'Розпакуйте архів повністю — банер складається з двох файлів. '
      + '(Missing %SPRITE_FILE%: extract the whole archive, do not open %ENTRY_FILE% from inside the ZIP.)';
  };
  probe.src = '%SPRITE_FILE%';`;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const jsString = (value) => JSON.stringify(String(value));

function buildStyles({ width, height, background, border, borderColor, spriteUrl, bgW, bgH }) {
  const adRules = [
    'display:block', 'position:relative', `width:${width}px`, `height:${height}px`,
    'overflow:hidden', 'text-decoration:none', 'box-sizing:border-box', 'cursor:pointer',
    background ? `background:${background}` : 'background:transparent',
    border ? `border:1px solid ${borderColor}` : 'border:0',
  ].join(';');

  return `html, body { margin: 0; padding: 0; background: transparent; }
#ad { ${adRules}; }
#frame {
  position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px;
  background-image: url(${spriteUrl});
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: ${bgW}px ${bgH}px;
}`;
}

function buildScript(cfg, bgW, bgH) {
  const { frames, cols, width, height, fps, loops, api, clickUrl, clickInCode, spriteFile, entryFile, inlineSprite } = cfg;

  const exit = api === 'admixer'
    ? EXIT_ADMIXER.replace('%CLICK_ARG%', clickInCode ? 'CLICK_URL' : '')
    : EXIT_STANDARD;

  const guard = inlineSprite
    ? ''
    : SPRITE_GUARD.split('%SPRITE_FILE%').join(spriteFile).split('%ENTRY_FILE%').join(entryFile);

  const core = PLAYER_CORE
    .replace(/%%/g, '%')
    .replace('%FRAMES%', frames)
    .replace('%COLS%', cols)
    .replace('%FW%', width)
    .replace('%FH%', height)
    .replace('%FPS%', fps)
    .replace('%LOOPS%', loops);

  const preamble = api === 'admixer'
    ? `  var CLICK_URL = ${jsString(clickUrl)};\n`
    : '';

  return `(function () {\n${preamble}${core}${exit}${guard}\n})();`;
}

/**
 * @param {object} cfg
 * @param {'standard'|'admixer'} cfg.api
 * @returns {string} the banner document
 */
export function buildBannerHtml(cfg) {
  const { name, width, height, frames, cols, clickUrl, api } = cfg;
  const rows = Math.ceil(frames / cols);
  // The sheet may be encoded below 1:1 to save bytes, so background-size is
  // expressed in CSS pixels — one cell always covers exactly one banner.
  const bgW = cols * width;
  const bgH = rows * height;

  const styles = buildStyles({ ...cfg, bgW, bgH });
  const script = buildScript(cfg, bgW, bgH);
  const title = `${escapeAttr(name)} — ${width}x${height}`;

  // Admixer's docs require the creative to live inside <body>; content placed
  // outside it may not be served, so the styles go in the body for that flavour.
  if (api === 'admixer') {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body>
<style>
${styles}
</style>
<div id="ad" role="link" tabindex="0" aria-label="${escapeAttr(name)}"><div id="frame"></div></div>
<script>
${script}
</script>
</body>
</html>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ad.size" content="width=${width},height=${height}">
<title>${title}</title>
<style>
${styles}
</style>
</head>
<body>
<a id="ad" href="${escapeAttr(clickUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(name)}"><div id="frame"></div></a>
<script>
var clickTag = ${jsString(clickUrl)};
${script}
</script>
</body>
</html>
`;
}

/** Plain-text manifest shipped inside the ZIP where the platform allows it. */
export function buildManifest(cfg) {
  const seconds = (cfg.frames / cfg.fps).toFixed(2);
  const admixer = cfg.api === 'admixer';

  const files = cfg.inlineSprite
    ? `  ${cfg.entryFile.padEnd(15)} the complete creative; the sprite sheet is embedded in it,
                  so this one file is the whole banner`
    : `  ${cfg.entryFile.padEnd(15)} the creative; entry point for the ad server
  ${cfg.spriteFile.padEnd(15)} sprite sheet with every frame

  IMPORTANT: ${cfg.entryFile} and ${cfg.spriteFile} must stay together. Opening
  ${cfg.entryFile} straight out of a ZIP viewer extracts only that one file and
  the banner renders blank — extract the whole archive first.`;

  const platformNotes = admixer
    ? `  - Built for Admixer Standard HTML5: ${cfg.entryFile} sits in the archive
    root, the creative lives inside <body>, playback starts on
    globalHTML5Api.on('load', ...) and the exit calls globalHTML5Api.click(${cfg.clickInCode ? 'URL' : ''}).
  - ${cfg.clickInCode
      ? 'The clickthrough URL is set in the code, so leave the Landing Page field\n    in the creative template empty — a URL in both places is a conflict.'
      : 'No URL is passed in the code, so set the clickthrough in the Landing Page\n    field of the creative template.'}
  - Outside Admixer (double-clicking the file) the creative detects that the API
    is absent, starts immediately and opens the URL directly, so it stays
    previewable.`
    : `  - ${cfg.entryFile} declares <meta name="ad.size"> and a global clickTag
    variable, so Google Ads, Display & Video 360 and Campaign Manager pick up
    both the dimensions and the exit URL automatically.`;

  return `${cfg.name} — HTML5 banner ${cfg.width}x${cfg.height}
${'='.repeat(48)}

Source            ${cfg.sourceName}
Target platform   ${cfg.platformLabel}
Frames            ${cfg.frames} (${cfg.cols} cols x ${Math.ceil(cfg.frames / cfg.cols)} rows)
Frame rate        ${cfg.fps} fps
Animation length  ${seconds} s x ${cfg.loops === 0 ? 'infinite' : cfg.loops} loop(s)
Sprite sheet      ${cfg.inlineSprite ? 'embedded' : cfg.spriteFile} — ${cfg.sheetW}x${cfg.sheetH} px (${Math.round(cfg.scale * 100)}% of display size)
Packaging         ${cfg.inlineSprite ? 'single file, sprite embedded as a data: URI' : `${cfg.entryFile} plus a separate sprite file`}
Backup image      ${cfg.backupFile} — downloaded separately, not in this ZIP
Click-through     ${cfg.clickUrl}

Files
${files}

Notes
${platformNotes}
  - The animation stops on its last frame after the loop budget is spent and
    pauses while the tab is hidden.
  - Archive the files themselves, not a folder containing them.

Generated with WebM -> HTML5 Banner Converter.
`;
}
