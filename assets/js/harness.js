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

export function buildFallbackHarness({ width, height, entryFile, name }) {
  const indexHtml = `<!DOCTYPE html>
<html>
<head lang="en">
  <meta charset="UTF-8">
  <link href="css/index.css" media="all" rel="stylesheet" type="text/css"/>
  <title>${name} ${width}x${height}</title>
  <script type="text/javascript" src="settings.js"></script>
</head>
<body>
<div class="page">
  <p class="ttl">${name} — ${width}x${height}</p>
  <div class="wrapper-table" style="width: ${width}px; height: ${height}px;">
    <iframe id="banner" src="../${entryFile}" width="${width}" height="${height}" frameborder="0" scrolling="no"></iframe>
  </div>
  <p class="note">
    Локальний перегляд креатива. Щоб подивитись його так, як віддає сервер
    Admixer, скопіюйте файли банера в <code>banners/banner/body/</code> і
    відкрийте цю сторінку через localhost із штатним шаблоном Admixer.
  </p>
</div>
</body>
</html>
`;

  const settingsJs = `window.zones = {
    'top-right' : 'banner'
};
location.href.replace(/\\[(.+?)=(.*?)]/g,function(all,name,value){
    window.zones[name] = value || void 0;
});
`;

  const indexCss = `@charset "utf-8";

html, body {
    height: 100%;
    margin: 0 0 0 0;
    font: 12px/1.33 Arial, Helvetica, sans-serif;
    background: #ededed;
}

.page {
    max-width: 1178px;
    margin: 0 auto;
    padding: 24px 16px;
}

.ttl {
    font-size: 13px;
    color: #555;
    margin: 0 0 8px;
}

.wrapper-table {
    background: #fff;
    border: 1px solid #d9d9d9;
    display: inline-block;
    line-height: 0;
}

.note {
    max-width: 62ch;
    color: #666;
    margin-top: 16px;
    line-height: 1.5;
}

.note code {
    background: #fff;
    border: 1px solid #ddd;
    padding: 1px 4px;
}
`;

  return [
    { name: `${HARNESS_ROOT}/index.html`, text: indexHtml },
    { name: `${HARNESS_ROOT}/settings.js`, text: settingsJs },
    { name: `${HARNESS_ROOT}/css/index.css`, text: indexCss },
    { name: `${HARNESS_ROOT}/banners/banner/body/`, isDir: true },
  ];
}
