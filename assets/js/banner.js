/**
 * Generates the creative package.
 *
 * Two flavours, because ad platforms disagree on the basics:
 *
 *  - `standard` — Google Ads, DV360, CM360, IAB. One index.html carrying a
 *    <meta name="ad.size"> declaration and a global clickTag; the creative
 *    starts by itself.
 *
 *  - `admixer` — Admixer Standard HTML5 API 2.0, laid out the way their own
 *    template is: body.html in the archive root, assets under images/, the
 *    platform glue in js/body.js and the player in js/banner.js. Everything
 *    sits inside <body>, because their docs are explicit that markup outside
 *    it may not show. The glue registers on globalHTML5Api's load event,
 *    declares the banner's size through init({resize: [...]}) and exits via
 *    globalHTML5Api.click().
 *
 * Either way the player advances on requestAnimationFrame with an accumulator
 * instead of setInterval, so playback holds the requested fps without
 * drifting, and it parks on the last frame once the loop budget is spent.
 */

const escapeAttr = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const jsString = (value) => JSON.stringify(String(value));

/* ── player ───────────────────────────────────────────────────────────── */

function buildPlayer(cfg, { exposeStart }) {
  const { frames, cols, width, height, fps, loops, spriteFile, entryFile, inlineSprite } = cfg;

  const guard = inlineSprite ? '' : `
  var probe = new Image();
  probe.onerror = function () {
    cancelAnimationFrame(raf);
    raf = 0;
    if (window.console) { console.error('${spriteFile} failed to load next to ${entryFile}'); }
    var host = location.hostname;
    var local = location.protocol === 'file:' || host === '' || host === 'localhost'
      || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) { return; }
    el.style.background = '#fff';
    el.style.cssText += ';display:flex;align-items:center;justify-content:center;padding:18px;'
      + 'font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#c1121f;text-align:center';
    el.textContent = 'Не знайдено ${spriteFile} поруч з ${entryFile}. '
      + 'Розпакуйте архів повністю — банер складається з кількох файлів. '
      + '(Missing ${spriteFile}: extract the whole archive, do not open ${entryFile} from inside the ZIP.)';
  };
  probe.src = '${spriteFile}';
`;

  // `startBanner` is what js/body.js calls once Admixer fires its load event;
  // the standard flavour has nothing to wait for and starts immediately.
  const tail = exposeStart
    ? '  window.startBanner = start;\n'
    : '  start();\n';

  return `(function () {
  var FRAMES = ${frames}, COLS = ${cols}, FW = ${width}, FH = ${height}, FPS = ${fps}, LOOPS = ${loops};
  var el = document.getElementById('frame');
  var idx = 0, loops = 0, acc = 0, prev = 0, raf = 0, step = 1000 / FPS;

  function show(i) {
    el.style.backgroundPosition = -(i % COLS) * FW + 'px ' + -Math.floor(i / COLS) * FH + 'px';
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
${guard}${tail}})();`;
}

/* ── Admixer glue, shaped like the platform's own template ────────────── */

function buildAdmixerGlue(cfg) {
  const clickArg = cfg.clickInCode ? jsString(cfg.clickUrl) : '';
  return `globalHTML5Api.on("load", function () {
\tfunction $(id) {
\t\treturn document.getElementById(id);
\t}
\t$("container").onclick = function (_event) {
\t\tglobalHTML5Api.click(${clickArg});
\t};
\tdocument.body.onselectstart = function () {
\t\treturn false;
\t};
\tglobalHTML5Api.init({
\t\t'resize': [
\t\t{
\t\t\t'name': 'state-1',
\t\t\t'width': '${cfg.width}px',
\t\t\t'height': '${cfg.height}px'
\t\t}
\t\t]
\t});
\tstartBanner();
});
`;
}

/**
 * With the player in a sibling file, a partial extraction leaves no script to
 * report it — so this check has to be inline in the entry file. It fires only
 * when the player never registered, and only during local preview.
 */
function buildAssetCheck(entryFile) {
  return `(function () {
  var host = location.hostname;
  var local = location.protocol === 'file:' || host === '' || host === 'localhost'
    || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!local) { return; }
  window.addEventListener('load', function () {
    if (window.startBanner) { return; }
    var el = document.getElementById('frame');
    if (!el) { return; }
    el.style.cssText += ';background:#fff;display:flex;align-items:center;justify-content:center;'
      + 'padding:18px;font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#c1121f;text-align:center';
    el.textContent = 'Не завантажились js/banner.js та js/body.js поруч з ${entryFile}. '
      + 'Розпакуйте архів повністю, зі збереженням теки js/ та images/. '
      + '(Sibling scripts missing: extract the whole archive, keeping its folders.)';
  });
})();`;
}

/**
 * Stand-in API for opening the exported file directly. Admixer injects the
 * real globalHTML5Api before the creative's scripts run — js/body.js in their
 * own template calls it at parse time — so this only ever defines anything
 * when the creative is outside the platform, and is inert when served.
 */
function buildPreviewShim(clickUrl) {
  return `if (typeof globalHTML5Api === 'undefined') {
  window.globalHTML5Api = {
    on: function (event, handler) {
      if (event !== 'load') { return; }
      if (document.readyState === 'complete') { handler(); }
      else { window.addEventListener('load', handler); }
    },
    init: function () {},
    close: function () {},
    click: function (url) { window.open(url || ${jsString(clickUrl)}, '_blank'); }
  };
}`;
}

/* ── styles ───────────────────────────────────────────────────────────── */

function buildStyles(cfg, rootId) {
  const { width, height, background, border, borderColor, spriteUrl, bgW, bgH, api } = cfg;
  const boxRules = [
    'position:absolute', 'left:0', 'top:0',
    `width:${width}px`, `height:${height}px`,
    'overflow:hidden', 'box-sizing:border-box', 'cursor:pointer', 'text-decoration:none',
    background ? `background-color:${background}` : 'background-color:transparent',
    border ? `border:1px solid ${borderColor}` : 'border:0',
  ].join('; ');

  // Admixer sizes the slot itself through init(), so the outer container
  // follows the slot at 100% and the creative box keeps the declared pixels.
  const shell = api === 'admixer'
    ? `#container { position:absolute; left:0; top:0; width:100%; height:100%; }
#animation_container { ${boxRules}; }`
    : `#${rootId} { ${boxRules}; }`;

  return `html, body { margin: 0 0 0 0; }
${shell}
#frame {
  position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px;
  background-image: url(${spriteUrl});
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: ${bgW}px ${bgH}px;
}`;
}

/* ── package assembly ─────────────────────────────────────────────────── */

/**
 * @param {object} cfg
 * @param {'standard'|'admixer'} cfg.api
 * @param {boolean} cfg.inlineSprite  sprite as a data: URI rather than a file
 * @param {boolean} cfg.inlineAll     fold the scripts into the HTML too
 * @returns {{entryFile: string, html: string, files: Array<{name: string, text: string}>}}
 */
export function buildCreative(cfg) {
  const rows = Math.ceil(cfg.frames / cfg.cols);
  // The sheet may be encoded below 1:1 to save bytes, so background-size is
  // expressed in CSS pixels — one cell always covers exactly one banner.
  const geometry = { ...cfg, bgW: cfg.cols * cfg.width, bgH: rows * cfg.height };

  return cfg.api === 'admixer' ? admixerPackage(geometry) : standardPackage(geometry);
}

function admixerPackage(cfg) {
  const { width, height, name, entryFile, inlineAll } = cfg;
  const styles = buildStyles(cfg, 'container');
  const player = buildPlayer(cfg, { exposeStart: true });
  const glue = buildAdmixerGlue(cfg);
  const shim = buildPreviewShim(cfg.clickUrl);

  const scripts = inlineAll
    ? `<script type="text/javascript">
// Local preview only — inert once Admixer provides the real API.
${shim}
</script>
<script type="text/javascript">
${player}
</script>
<script type="text/javascript">
${glue}</script>`
    : `<script type="text/javascript">
// Local preview only — inert once Admixer provides the real API.
${shim}
</script>
<script type="text/javascript" src="js/banner.js"></script>
<script type="text/javascript" src="js/body.js"></script>
<script type="text/javascript">
// Local preview only — reports a partial extraction instead of a blank box.
${buildAssetCheck(cfg.entryFile)}
</script>`;

  const html = `<!DOCTYPE html>
<html>
<head lang="en">
  <meta charset="UTF-8">
  <title>${escapeAttr(name)} ${width}x${height}</title>
</head>
<body>
  <style type="text/css">
${styles}
  </style>
  <div id="container">
    <div id="animation_container"><div id="frame"></div></div>
  </div>
  ${scripts}
</body>
</html>
`;

  return {
    entryFile,
    html,
    files: inlineAll ? [] : [
      { name: 'js/banner.js', text: `${player}\n` },
      { name: 'js/body.js', text: glue },
    ],
  };
}

function standardPackage(cfg) {
  const { width, height, name, clickUrl, entryFile } = cfg;
  const styles = buildStyles(cfg, 'container');
  const player = buildPlayer(cfg, { exposeStart: false });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ad.size" content="width=${width},height=${height}">
<title>${escapeAttr(name)} — ${width}x${height}</title>
<style>
${styles}
</style>
</head>
<body>
<a id="container" href="${escapeAttr(clickUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(name)}"><div id="frame"></div></a>
<script>
var clickTag = ${jsString(clickUrl)};
${player}
(function () {
  var ad = document.getElementById('container');
  ad.href = window.clickTag || '#';
  ad.addEventListener('click', function (e) {
    e.preventDefault();
    window.open(window.clickTag, '_blank');
  });
})();
</script>
</body>
</html>
`;

  return { entryFile, html, files: [] };
}

/** Plain-text manifest shipped inside the ZIP where the platform allows it. */
export function buildManifest(cfg) {
  const seconds = (cfg.frames / cfg.fps).toFixed(2);
  const admixer = cfg.api === 'admixer';

  const files = cfg.inlineSprite
    ? `  ${cfg.entryFile.padEnd(18)} the complete creative; the sprite sheet is embedded
                     in it, so this one file is the whole banner`
    : [
      `  ${cfg.entryFile.padEnd(18)} the creative; entry point for the ad server`,
      admixer ? `  js/banner.js       sprite playback, exposes startBanner()` : null,
      admixer ? `  js/body.js         Admixer glue: load event, init(), click()` : null,
      `  ${cfg.spriteFile.padEnd(18)} sprite sheet with every frame`,
      '',
      `  IMPORTANT: these files must stay together. Opening ${cfg.entryFile} straight`,
      '  out of a ZIP viewer extracts only that one file and the banner renders',
      '  blank — extract the whole archive first.',
    ].filter(Boolean).join('\n');

  const platformNotes = admixer
    ? `  - Built for Admixer Standard HTML5 API 2.0, following their template
    layout: ${cfg.entryFile} in the archive root, assets under images/ and
    scripts under js/, everything rendered from inside <body>.
  - js/body.js registers globalHTML5Api.on('load', ...), declares the size
    through init({resize: [{name: 'state-1', width: '${cfg.width}px',
    height: '${cfg.height}px'}]}) and exits via globalHTML5Api.click(${cfg.clickInCode ? 'URL' : ''}).
  - ${cfg.clickInCode
      ? 'The clickthrough URL is set in the code, so leave the Landing Page field\n    in the creative template empty — a URL in both places is a conflict.'
      : 'No URL is passed in the code, so set the clickthrough in the Landing Page\n    field of the creative template.'}
  - Opened outside Admixer the creative detects that the API is absent, falls
    back to a preview stub and runs anyway, so it stays previewable.`
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
