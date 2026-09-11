/**
 * Generates the banner package: an HTML document that animates the sprite
 * sheet, plus the metadata ad platforms look for (ad.size meta tag, a global
 * clickTag, a backup image).
 *
 * The player advances on requestAnimationFrame with an accumulator instead of
 * setInterval, so playback keeps the requested fps without drifting, and it
 * parks on the last frame once the loop budget is spent — the behaviour
 * Google Ads and IAB expect from display creatives.
 */

const PLAYER = `(function () {
  var FRAMES = %FRAMES%, COLS = %COLS%, FW = %FW%, FH = %FH%, FPS = %FPS%, LOOPS = %LOOPS%;
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

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; prev = 0; }
    else if (!raf && !(LOOPS && loops >= LOOPS)) { raf = requestAnimationFrame(tick); }
  });

  show(0);
  if (FRAMES > 1) raf = requestAnimationFrame(tick);

  if (ad) {
    ad.href = window.clickTag || '#';
    ad.addEventListener('click', function (e) {
      e.preventDefault();
      window.open(window.clickTag, '_blank');
    });
  }
%SPRITE_GUARD%
})();`;

/**
 * A missing sprite otherwise renders as a silent white box — the failure you
 * get by opening index.html straight out of a ZIP viewer, which extracts only
 * the file you clicked. Say so, but only while previewing locally: a served
 * creative must never show diagnostics to an actual viewer.
 */
const SPRITE_GUARD = `
  var probe = new Image();
  probe.onerror = function () {
    cancelAnimationFrame(raf);
    raf = 0;
    if (window.console) { console.error('%SPRITE_FILE% failed to load next to index.html'); }
    var host = location.hostname;
    var local = location.protocol === 'file:' || host === '' || host === 'localhost'
      || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) { return; }
    el.style.background = '#fff';
    el.style.cssText += ';display:flex;align-items:center;justify-content:center;padding:18px;'
      + 'font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#c1121f;text-align:center';
    el.textContent = 'Не знайдено %SPRITE_FILE% поруч з index.html. '
      + 'Розпакуйте архів повністю — банер складається з двох файлів. '
      + '(Missing %SPRITE_FILE%: extract the whole archive, do not open index.html from inside the ZIP.)';
  };
  probe.src = '%SPRITE_FILE%';`;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeJsString(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {object} cfg
 * @param {string} cfg.spriteUrl  sprite.webp or a data: URL for single-file output
 * @returns {string} the banner document
 */
export function buildBannerHtml(cfg) {
  const {
    name, width, height, frames, cols, fps, loops,
    spriteUrl, spriteFile, inlineSprite, clickUrl, border, borderColor, background,
  } = cfg;

  // The sheet may be encoded below 1:1 to save bytes, so background-size is
  // expressed in CSS pixels — one cell always covers exactly one banner.
  const rows = Math.ceil(frames / cols);
  const bgW = cols * width;
  const bgH = rows * height;

  const guard = inlineSprite ? '' : SPRITE_GUARD.split('%SPRITE_FILE%').join(spriteFile);
  const player = PLAYER
    .replace('%SPRITE_GUARD%', guard)
    .replace(/%%/g, '%')
    .replace('%FRAMES%', frames)
    .replace('%COLS%', cols)
    .replace('%FW%', width)
    .replace('%FH%', height)
    .replace('%FPS%', fps)
    .replace('%LOOPS%', loops);

  const adRules = [
    'display:block',
    'position:relative',
    `width:${width}px`,
    `height:${height}px`,
    'overflow:hidden',
    'text-decoration:none',
    'box-sizing:border-box',
    'cursor:pointer',
    background ? `background:${background}` : 'background:transparent',
    border ? `border:1px solid ${borderColor}` : 'border:0',
  ].join(';');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ad.size" content="width=${width},height=${height}">
<title>${escapeAttr(name)} — ${width}x${height}</title>
<style>
html, body { margin: 0; padding: 0; background: transparent; }
#ad { ${adRules}; }
#frame {
  position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px;
  background-image: url(${spriteUrl});
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: ${bgW}px ${bgH}px;
}
</style>
</head>
<body>
<a id="ad" href="${escapeAttr(clickUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(name)}"><div id="frame"></div></a>
<script>
var clickTag = ${escapeJsString(clickUrl)};
${player}
</script>
</body>
</html>
`;
}

/** README shipped inside the ZIP so whoever uploads the creative knows what it is. */
export function buildManifest(cfg) {
  const seconds = (cfg.frames / cfg.fps).toFixed(2);
  return `${cfg.name} — HTML5 banner ${cfg.width}x${cfg.height}
${'='.repeat(48)}

Source            ${cfg.sourceName}
Frames            ${cfg.frames} (${cfg.cols} cols x ${Math.ceil(cfg.frames / cfg.cols)} rows)
Frame rate        ${cfg.fps} fps
Animation length  ${seconds} s x ${cfg.loops === 0 ? 'infinite' : cfg.loops} loop(s)
Sprite sheet      ${cfg.inlineSprite ? 'embedded' : cfg.spriteFile} — ${cfg.sheetW}x${cfg.sheetH} px (${Math.round(cfg.scale * 100)}% of display size)
Packaging         ${cfg.inlineSprite ? 'single file, sprite embedded as a data: URI' : 'index.html plus a separate sprite file'}
Backup image      ${cfg.backupFile} — downloaded separately, not in this ZIP
Click-through     ${cfg.clickUrl}

Files
${cfg.inlineSprite
  ? `  index.html      the complete creative; the sprite sheet is embedded in it,
                  so this one file is the whole banner`
  : `  index.html      the creative; entry point for the ad server
  ${cfg.spriteFile.padEnd(15)} sprite sheet with every frame

  IMPORTANT: index.html and ${cfg.spriteFile} must stay together. Opening
  index.html straight out of a ZIP viewer extracts only that one file and the
  banner renders blank — extract the whole archive first.`}

Notes
  - index.html declares <meta name="ad.size"> and a global clickTag variable,
    so Google Ads, Display & Video 360 and Campaign Manager pick up both the
    dimensions and the exit URL automatically.
  - The animation stops on its last frame after the loop budget is spent and
    pauses while the tab is hidden.
  - ${cfg.inlineSprite
      ? 'Everything is in index.html, so the banner cannot be broken by a\n    partial extraction. Upload the ZIP as-is.'
      : 'Keep index.html and the sprite in the same folder; upload the ZIP as-is.'}

Generated with WebM -> HTML5 Banner Converter.
`;
}
