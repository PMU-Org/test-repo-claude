import { loadVideo, probeFrameRate, captureFrames } from './extract.js';
import { packSheet, encode, blobToDataURL, extensionFor, planGrid } from './sprite.js';
import { createZip, blobBytes, textBytes } from './zip.js';
import { buildBannerHtml, buildManifest } from './banner.js';

const PRESETS = [
  ['source', 'Як у джерелі', 0, 0],
  ['300x250', '300×250 — Medium Rectangle', 300, 250],
  ['300x600', '300×600 — Half Page', 300, 600],
  ['336x280', '336×280 — Large Rectangle', 336, 280],
  ['728x90', '728×90 — Leaderboard', 728, 90],
  ['970x250', '970×250 — Billboard', 970, 250],
  ['970x90', '970×90 — Large Leaderboard', 970, 90],
  ['320x50', '320×50 — Mobile Banner', 320, 50],
  ['320x100', '320×100 — Large Mobile Banner', 320, 100],
  ['160x600', '160×600 — Wide Skyscraper', 160, 600],
  ['120x600', '120×600 — Skyscraper', 120, 600],
  ['250x250', '250×250 — Square', 250, 250],
  ['468x60', '468×60 — Banner', 468, 60],
  ['1080x1080', '1080×1080 — Social square', 1080, 1080],
  ['custom', 'Свій розмір', -1, -1],
];

/**
 * What each ad platform actually accepts. The image-format lists are the
 * decisive part: WebP is absent from Google's allowed asset types for HTML5
 * display creatives, so a WebP sprite is rejected on upload no matter how
 * small it is.
 *   Google Ads:  ZIP containing HTML and optionally CSS, JS, GIF, PNG, JPG,
 *                JPEG, SVG — 600 KB, max 40 files.
 *   DV360/CM360: .html .htm .css .js, images .jpg .jpeg .gif .png .svg,
 *                fonts — up to 100 files, no hard size cap, animation <= 30 s.
 */
const PLATFORMS = {
  'google-ads': {
    label: 'Google Ads',
    formats: ['image/jpeg', 'image/png'],
    budget: 600, maxFiles: 40, maxAnimation: 30,
    note: 'Google Ads приймає в ZIP лише HTML/CSS/JS та GIF, PNG, JPG, JPEG, SVG — WebP у переліку немає. Ліміт 600 КБ і до 40 файлів.',
  },
  dv360: {
    label: 'Display & Video 360',
    formats: ['image/jpeg', 'image/png'],
    budget: 600, maxFiles: 100, maxAnimation: 30,
    note: 'DV360 / CM360: дозволені .jpg, .jpeg, .gif, .png, .svg — WebP не в переліку. Жорсткого ліміту ваги немає, анімація до 30 с; 600 КБ тут як розумний дефолт.',
  },
  'iab-lean': {
    label: 'IAB LEAN',
    formats: ['image/jpeg', 'image/png', 'image/webp'],
    budget: 150, maxFiles: null, maxAnimation: 30,
    note: 'IAB LEAN — 150 КБ на весь креатив. Формат зображення не обмежений, але 150 КБ для 2 с фотографічного 300×600 означає 8 fps або нижче.',
  },
  any: {
    label: 'Без профілю',
    formats: ['image/jpeg', 'image/png', 'image/webp'],
    budget: 0, maxFiles: null, maxAnimation: null,
    note: 'Профіль не вибрано — перевірки сумісності вимкнені. Уточніть у майданчика дозволені типи файлів і ліміт ваги.',
  },
};

const $ = (id) => document.getElementById(id);
const el = {
  dropzone: $('dropzone'), fileInput: $('file-input'), sample: $('btn-sample'),
  sourceInfo: $('source-info'), sourceWarn: $('source-warn'),
  settings: $('step-settings'), result: $('step-result'),
  preset: $('opt-preset'), w: $('opt-w'), h: $('opt-h'), ratio: $('opt-ratio'),
  fps: $('opt-fps'), start: $('opt-start'), end: $('opt-end'), loops: $('opt-loops'),
  format: $('opt-format'), quality: $('opt-quality'), qOut: $('q-out'), scale: $('opt-scale'),
  transparent: $('opt-transparent'), bg: $('opt-bg'), wrapBg: $('wrap-bg'),
  click: $('opt-click'), border: $('opt-border'), borderColor: $('opt-border-color'),
  backup: $('opt-backup'), bkOut: $('bk-out'),
  budget: $('opt-budget'), platform: $('opt-platform'), platformNote: $('platform-note'),
  priority: $('opt-priority'), autofit: $('btn-autofit'), convert: $('btn-convert'),
  progress: $('progress'), bar: $('progress-bar'), label: $('progress-label'),
  stage: $('stage'), preview: $('preview'), replay: $('btn-replay'), checker: $('opt-checker'),
  codeOut: $('code-out'), verdict: $('r-verdict'), checks: $('r-checks'),
};

const state = { file: null, url: null, video: null, meta: null, result: null, busy: false };

/* ── helpers ──────────────────────────────────────────────────────── */

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setProgress(fraction, text) {
  el.progress.classList.toggle('hidden', fraction === null);
  if (fraction === null) return;
  el.bar.style.setProperty('--p', `${Math.round(fraction * 100)}%`);
  el.label.textContent = text || '';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function slug(name) {
  return (name.replace(/\.[^.]+$/, '') || 'banner')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'banner';
}

/** `video.duration` is Infinity for some streamed WebM files until you seek past the end. */
async function resolveDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  return new Promise((resolve) => {
    const onSeek = () => {
      video.removeEventListener('timeupdate', onSeek);
      video.currentTime = 0;
      resolve(Number.isFinite(video.duration) ? video.duration : 0);
    };
    video.addEventListener('timeupdate', onSeek);
    video.currentTime = 1e7;
  });
}

/* ── source loading ───────────────────────────────────────────────── */

async function useFile(file) {
  if (state.busy) return;
  state.busy = true;
  el.convert.disabled = true;
  setProgress(0.1, 'Читаю файл…');

  try {
    if (state.url) URL.revokeObjectURL(state.url);
    state.file = file;
    state.url = URL.createObjectURL(file);
    state.video = await loadVideo(state.url);

    const duration = await resolveDuration(state.video);
    setProgress(0.5, 'Визначаю частоту кадрів…');
    const { fps, exact } = await probeFrameRate(state.video);
    setProgress(0.8, 'Перевіряю альфа-канал…');
    const hasAlpha = await sniffAlpha(state.video, duration);

    state.meta = {
      width: state.video.videoWidth, height: state.video.videoHeight,
      duration, fps, fpsExact: exact, hasAlpha,
    };
    applyMeta();
    el.convert.disabled = false;
    el.settings.removeAttribute('aria-disabled');
    el.sourceInfo.classList.remove('hidden');
  } catch (error) {
    el.sourceWarn.textContent = error.message;
    el.sourceWarn.className = 'hint bad';
    el.sourceInfo.classList.remove('hidden');
  } finally {
    state.busy = false;
    setProgress(null);
  }
}

async function sniffAlpha(video, duration) {
  const { hasAlpha } = await captureFrames(video, {
    start: Math.max(0, duration * 0.5), end: Math.max(0.04, duration * 0.5 + 0.04),
    fps: 25, width: video.videoWidth, height: video.videoHeight, background: null,
  });
  return hasAlpha;
}

function applyMeta() {
  const m = state.meta;
  $('m-name').textContent = state.file.name;
  $('m-size').textContent = kb(state.file.size);
  $('m-dim').textContent = `${m.width}×${m.height}`;
  $('m-dur').textContent = `${m.duration.toFixed(2)} с`;
  $('m-fps').textContent = m.fpsExact ? `${m.fps}` : `${m.fps} (оцінка)`;
  const alphaCell = $('m-alpha');
  alphaCell.textContent = m.hasAlpha ? 'є — прозорість збережено' : 'немає';
  alphaCell.className = m.hasAlpha ? 'ok' : '';

  el.w.value = m.width;
  el.h.value = m.height;
  el.end.value = m.duration.toFixed(2);
  el.end.max = m.duration.toFixed(2);
  el.start.max = m.duration.toFixed(2);
  el.transparent.checked = m.hasAlpha;
  syncTransparency();

  const exactPreset = PRESETS.find(([, , w, h]) => w === m.width && h === m.height);
  el.preset.value = exactPreset ? exactPreset[0] : 'source';

  const notes = [];
  if (m.duration > 6) notes.push(`Кліп ${m.duration.toFixed(1)} с — спрайт буде важким. Знижуйте fps або обріжте до 5 с.`);
  if (!m.fpsExact) notes.push('Частоту кадрів визначено приблизно — перевірте, чи анімація не пливе.');
  if (m.hasAlpha) notes.push('Виявлено альфа-канал: обирайте WebP або PNG, щоб не втратити прозорість.');
  el.sourceWarn.textContent = notes.join(' ');
  el.sourceWarn.className = notes.length ? 'hint warn' : 'hint';

  estimate();
}

/* ── settings plumbing ────────────────────────────────────────────── */

function syncTransparency() {
  const transparent = el.transparent.checked;
  el.wrapBg.classList.toggle('hidden', transparent);
  if (el.format.value === 'image/jpeg' && transparent) {
    el.transparent.checked = false;
    el.wrapBg.classList.remove('hidden');
  }
}

function currentOptions() {
  const m = state.meta;
  const fpsChoice = Number(el.fps.value);
  const fps = fpsChoice || m.fps;
  const start = clamp(Number(el.start.value) || 0, 0, m.duration);
  const end = clamp(Number(el.end.value) || m.duration, start + 1 / fps, m.duration);
  const transparent = el.transparent.checked && el.format.value !== 'image/jpeg';

  return {
    width: clamp(Math.round(Number(el.w.value) || m.width), 16, 4096),
    height: clamp(Math.round(Number(el.h.value) || m.height), 16, 4096),
    fps, start, end,
    loops: Number(el.loops.value),
    mime: el.format.value,
    quality: Number(el.quality.value),
    scale: Number(el.scale.value) || 1,
    background: transparent ? null : el.bg.value,
    clickUrl: el.click.value.trim() || 'https://example.com/',
    border: el.border.checked,
    borderColor: el.borderColor.value,
    budget: Number(el.budget.value),
    platform: el.platform.value,
  };
}

/** Frame count and sheet geometry, shown before anything is encoded. */
function estimate() {
  if (!state.meta) return;
  const o = currentOptions();
  const count = Math.max(1, Math.round((o.end - o.start) * o.fps));
  el.backup.max = count;
  el.backup.value = clamp(Number(el.backup.value) || 1, 1, count);
  el.bkOut.textContent = el.backup.value;
  try {
    const grid = planGrid(count, Math.round(o.width * o.scale), Math.round(o.height * o.scale));
    el.convert.textContent = `Конвертувати — ${count} кадрів, спрайт ${grid.sheetW}×${grid.sheetH}`;
    el.convert.disabled = false;
  } catch (error) {
    el.convert.textContent = 'Конвертувати';
    el.convert.disabled = true;
    el.sourceWarn.textContent = error.message;
    el.sourceWarn.className = 'hint bad';
  }
}

/* ── conversion ───────────────────────────────────────────────────── */

async function convert(options) {
  const o = options || currentOptions();
  const spriteW = Math.max(16, Math.round(o.width * o.scale));
  const spriteH = Math.max(16, Math.round(o.height * o.scale));

  const { canvases } = await captureFrames(state.video, { ...o, width: spriteW, height: spriteH }, (fraction, done, total) => {
    setProgress(fraction * 0.7, `Кадр ${done}/${total}`);
  });

  setProgress(0.75, 'Пакую спрайт…');
  const sheet = packSheet(canvases, spriteW, spriteH, o.background);

  setProgress(0.85, 'Кодую зображення…');
  const spriteBlob = await encode(sheet.canvas, o.mime, o.quality);
  const backupIndex = clamp(Number(el.backup.value) - 1, 0, canvases.length - 1);
  const backupBlob = await encode(canvases[backupIndex], o.background ? 'image/jpeg' : 'image/png', 92);

  setProgress(0.95, 'Збираю пакет…');
  const ext = extensionFor(o.mime);
  const base = slug(state.file.name);
  const spriteFile = `sprite.${ext}`;
  const backupFile = `backup.${o.background ? 'jpg' : 'png'}`;

  const shared = {
    name: base, sourceName: state.file.name,
    width: o.width, height: o.height,
    frames: canvases.length, cols: sheet.cols, fps: o.fps, loops: o.loops,
    sheetW: sheet.sheetW, sheetH: sheet.sheetH, scale: o.scale,
    clickUrl: o.clickUrl, border: o.border, borderColor: o.borderColor, background: o.background,
    spriteFile, backupFile,
  };

  const htmlExternal = buildBannerHtml({ ...shared, spriteUrl: spriteFile });
  const spriteDataUrl = await blobToDataURL(spriteBlob);
  const htmlInline = buildBannerHtml({ ...shared, spriteUrl: spriteDataUrl });

  const zipBlob = createZip([
    { name: 'index.html', data: textBytes(htmlExternal) },
    { name: spriteFile, data: await blobBytes(spriteBlob) },
    { name: 'README.txt', data: textBytes(buildManifest(shared)) },
  ]);

  setProgress(null);
  return {
    ...shared, options: o, spriteBlob, backupBlob, zipBlob,
    htmlExternal, htmlInline, base,
    sizes: {
      sprite: spriteBlob.size,
      html: new Blob([htmlInline]).size,
      zip: zipBlob.size,
      memory: sheet.sheetW * sheet.sheetH * 4,
    },
  };
}

function showResult(result) {
  state.result = result;
  el.result.classList.remove('hidden');

  $('r-frames').textContent = `${result.frames} @ ${result.fps} fps (${(result.frames / result.fps).toFixed(2)} с)`;
  $('r-sheet').textContent = `${result.sheetW}×${result.sheetH} · ${result.cols}×${Math.ceil(result.frames / result.cols)}`
    + (result.scale === 1 ? '' : ` · ${Math.round(result.scale * 100)}%`);
  $('r-sprite').textContent = kb(result.sizes.sprite);
  $('r-html').textContent = kb(result.sizes.html);
  $('r-zip').textContent = kb(result.sizes.zip);
  $('r-mem').textContent = `${(result.sizes.memory / 1048576).toFixed(1)} МБ`;

  const budget = result.options.budget;
  const zipKb = result.sizes.zip / 1024;
  const memoryHeavy = result.sizes.memory > 64 * 1048576;
  $('r-zip').className = !budget ? '' : zipKb <= budget ? 'ok' : 'bad';
  $('r-mem').className = memoryHeavy ? 'warn' : '';

  renderChecks(result, zipKb, memoryHeavy);

  $('dl-backup').textContent = `⤓ Backup .${result.backupFile.split('.').pop()}`;
  el.codeOut.textContent = result.htmlExternal;
  renderPreview();
}

/**
 * Platform compliance, stated as pass/fail rather than prose: a rejected
 * upload is the single most expensive thing this tool can produce, and the
 * format check is the one that silently costs a round trip with trafficking.
 */
function renderChecks(result, zipKb, memoryHeavy) {
  const platform = PLATFORMS[result.options.platform] || PLATFORMS.any;
  const mime = result.options.mime;
  const ext = result.spriteFile.split('.').pop().toUpperCase();
  const animation = (result.frames / result.fps) * (result.loops || 1);
  const items = [];

  if (platform.formats.length && !platform.formats.includes(mime)) {
    const allowed = platform.formats.map((m) => m.split('/')[1].toUpperCase()).join(' / ');
    items.push(['bad', `${ext} не входить у перелік дозволених типів ${platform.label} — креатив відхилять на завантаженні. Переключіть формат спрайта на ${allowed}.`]);
  } else if (platform.formats.length) {
    items.push(['ok', `${ext} у переліку дозволених типів ${platform.label}.`]);
  }

  if (budgetOf(platform, result)) {
    const limit = budgetOf(platform, result);
    items.push([zipKb <= limit ? 'ok' : 'bad',
      `ZIP ${zipKb.toFixed(0)} КБ ${zipKb <= limit ? 'вкладається в' : 'перевищує'} ліміт ${limit} КБ.`]);
  }

  if (platform.maxFiles) {
    items.push(['ok', `${ZIP_FILE_COUNT} файли в архіві — ліміт ${platform.label}: ${platform.maxFiles}.`]);
  }

  if (platform.maxAnimation) {
    items.push([animation <= platform.maxAnimation ? 'ok' : 'bad',
      animation <= platform.maxAnimation
        ? `Анімація ${animation.toFixed(1)} с — у межах ліміту ${platform.maxAnimation} с.`
        : `Анімація ${animation.toFixed(1)} с перевищує ліміт ${platform.maxAnimation} с.`]);
  }

  if (result.scale < 1) {
    items.push(['warn', `Спрайт закодовано в ${Math.round(result.scale * 100)}% роздільності — перевірте, чи читається дрібний текст.`]);
  }
  if (memoryHeavy) {
    items.push(['warn', `Спрайт займає ${(result.sizes.memory / 1048576).toFixed(0)} МБ на декод — на слабких пристроях можливі підвисання.`]);
  }
  if (mime === 'image/png' && !result.background) {
    items.push(['warn', 'PNG зі альфою важить у рази більше за WebP. Якщо прозорість не потрібна, JPEG дасть ту саму якість значно дешевше.']);
  }

  el.checks.innerHTML = '';
  for (const [kind, text] of items) {
    const li = document.createElement('li');
    li.className = kind === 'ok' ? '' : kind;
    li.textContent = text;
    el.checks.append(li);
  }

  const blocking = items.filter(([kind]) => kind === 'bad');
  el.verdict.textContent = blocking.length
    ? `${blocking.length} блокуюч${blocking.length === 1 ? 'а проблема' : 'і проблеми'} для ${platform.label}.`
    : platform.formats.length ? `Пакет відповідає вимогам ${platform.label}.` : '';
  el.verdict.className = `hint ${blocking.length ? 'bad' : 'ok'}`;
}

/** The platform limit, or the user's own budget when it is stricter. */
function budgetOf(platform, result) {
  const chosen = result.options.budget;
  if (!platform.budget) return chosen || 0;
  return chosen ? Math.min(chosen, platform.budget) : platform.budget;
}

const ZIP_FILE_COUNT = 3; // index.html + sprite + README.txt

function renderPreview() {
  if (!state.result) return;
  el.preview.style.width = `${state.result.width}px`;
  el.preview.style.height = `${state.result.height}px`;
  el.preview.srcdoc = state.result.htmlInline;
}

/* ── budget autofit ───────────────────────────────────────────────── */

/**
 * Relative sprite weight per quality setting, interpolated from measurements
 * on a photographic 300x600 creative. Only used to skip candidates that
 * cannot possibly fit — every candidate we accept is really encoded.
 */
const Q_ANCHORS = [[28, 0.44], [45, 0.57], [60, 0.69], [80, 1.0], [100, 1.7]];

function qualityFactor(q) {
  if (q <= Q_ANCHORS[0][0]) return Q_ANCHORS[0][1];
  for (let i = 1; i < Q_ANCHORS.length; i++) {
    const [q1, f1] = Q_ANCHORS[i];
    if (q <= q1) {
      const [q0, f0] = Q_ANCHORS[i - 1];
      return f0 + ((f1 - f0) * (q - q0)) / (q1 - q0);
    }
  }
  return Q_ANCHORS[Q_ANCHORS.length - 1][1];
}

/**
 * Candidate ladders, best first. Which quality you sacrifice is a creative
 * decision, not a technical one: a creative carrying legal small print needs
 * full resolution far more than it needs 15 fps, while a fast motion loop is
 * the other way round.
 */
const LADDERS = {
  sharpness: (fps) => [
    [1, fps, 80], [1, fps, 62], [1, fps, 48], [1, 15, 58], [1, 15, 44],
    [1, 12, 50], [1, 12, 38], [1, 10, 42], [1, 10, 32], [1, 8, 36], [1, 8, 26],
    [0.85, 10, 42], [0.75, 10, 45], [0.6, 12, 50],
  ],
  smoothness: (fps) => [
    [1, fps, 80], [1, fps, 58], [0.85, fps, 62], [0.85, fps, 48],
    [0.75, fps, 55], [0.75, fps, 42], [0.6, fps, 50], [0.6, fps, 38],
    [0.5, fps, 46], [0.5, fps, 32],
  ],
  balanced: (fps) => [
    [1, fps, 80], [1, fps, 62], [1, fps, 48], [0.85, fps, 60], [0.85, 15, 62],
    [0.75, 15, 62], [0.75, 15, 48], [0.75, 12, 55], [0.6, 12, 60], [0.6, 12, 45],
    [0.6, 10, 45], [0.5, 12, 50], [0.5, 10, 42], [0.5, 8, 34],
  ],
};

function buildLadder(base) {
  const make = LADDERS[el.priority.value] || LADDERS.balanced;
  const raw = make(base.fps);
  const seen = new Set();
  return raw
    .map(([scale, fps, quality]) => ({ scale, fps: Math.min(fps, base.fps), quality }))
    .filter((c) => {
      const key = `${c.scale}|${c.fps}|${c.quality}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function autofit() {
  const base = currentOptions();
  const platform = PLATFORMS[base.platform] || PLATFORMS.any;
  const budget = platform.budget ? Math.min(base.budget || platform.budget, platform.budget) : base.budget;
  if (!budget) {
    await guardedConvert();
    return;
  }

  const ladder = buildLadder(base);
  const span = base.end - base.start;
  let reference = null; // { zip, frames, scale, quality } from an actual encode
  let smallest = null;
  let tried = 0;

  for (const candidate of ladder) {
    const frames = Math.max(1, Math.round(span * candidate.fps));

    if (reference) {
      const predicted = reference.zip
        * (frames / reference.frames)
        * ((candidate.scale * candidate.scale) / (reference.scale * reference.scale))
        * (qualityFactor(candidate.quality) / qualityFactor(reference.quality));
      // 1.35x leaves room for the predictor being wrong on the optimistic side.
      const isLast = candidate === ladder[ladder.length - 1];
      if (predicted / 1024 > budget * 1.35 && !isLast) continue;
    }

    tried++;
    setProgress(0.5, `${Math.round(candidate.scale * 100)}% · ${candidate.fps} fps · q${candidate.quality}`);
    const result = await convert({ ...base, ...candidate });
    reference = { zip: result.sizes.zip, frames: result.frames, scale: candidate.scale, quality: candidate.quality };
    if (!smallest || result.sizes.zip < smallest.sizes.zip) smallest = result;

    if (result.sizes.zip / 1024 <= budget) {
      applyCandidate(candidate);
      showResult(result);
      const summary = `Підібрано за ${tried} спроб${tried === 1 ? 'у' : 'и'}: `
        + `${Math.round(candidate.scale * 100)}% роздільності, ${candidate.fps} fps, якість ${candidate.quality} — ZIP ${kb(result.sizes.zip)}.`;
      el.verdict.textContent = `${summary} ${el.verdict.textContent}`.trim();
      setProgress(null);
      return;
    }
  }

  setProgress(null);
  if (smallest) {
    showResult(smallest);
    el.verdict.textContent = `Не вдалося вкластися в ${budget} КБ навіть на мінімальних налаштуваннях (${kb(smallest.sizes.zip)}). `
      + 'Обріжте анімацію, зменште розмір баннера або залиште більший бюджет.';
    el.verdict.className = 'hint bad';
    setProgress(null);
    return;
  }
}

/** Reflect an autofit winner back into the form so the user can tweak from there. */
function applyCandidate({ scale, fps, quality }) {
  const scaleOption = [...el.scale.options].find((opt) => Number(opt.value) === scale);
  if (scaleOption) el.scale.value = scaleOption.value;
  const fpsOption = [...el.fps.options].find((opt) => Number(opt.value) === fps);
  el.fps.value = fpsOption ? fpsOption.value : '0';
  el.quality.value = quality;
  el.qOut.textContent = quality;
  estimate();
}

async function guardedConvert() {
  showResult(await convert());
}

/* ── wiring ───────────────────────────────────────────────────────── */

async function guard(action) {
  if (state.busy || !state.meta) return;
  state.busy = true;
  el.convert.disabled = true;
  el.autofit.disabled = true;
  try {
    await action();
  } catch (error) {
    setProgress(null);
    el.verdict.textContent = error.message;
    el.verdict.className = 'hint bad';
    el.result.classList.remove('hidden');
  } finally {
    state.busy = false;
    el.convert.disabled = false;
    el.autofit.disabled = false;
  }
}

el.dropzone.addEventListener('click', (e) => { if (e.target !== el.sample) el.fileInput.click(); });
el.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); } });
el.fileInput.addEventListener('change', () => { if (el.fileInput.files[0]) useFile(el.fileInput.files[0]); });

['dragenter', 'dragover'].forEach((type) => el.dropzone.addEventListener(type, (e) => {
  e.preventDefault();
  el.dropzone.classList.add('over');
}));
['dragleave', 'drop'].forEach((type) => el.dropzone.addEventListener(type, (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('over');
}));
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) useFile(file);
});

el.sample.addEventListener('click', async (e) => {
  e.stopPropagation();
  el.sample.disabled = true;
  el.sample.textContent = 'Завантажую…';
  try {
    const response = await fetch('assets/sample/delia-red-300x600.webm');
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await useFile(new File([blob], 'delia-red-300x600.webm', { type: 'video/webm' }));
  } catch {
    el.sourceWarn.textContent = 'Зразок недоступний у цій збірці — перетягніть власний .webm.';
    el.sourceWarn.className = 'hint warn';
    el.sourceInfo.classList.remove('hidden');
  } finally {
    el.sample.disabled = false;
    el.sample.textContent = 'Завантажити зразок 300×600';
  }
});

PRESETS.forEach(([value, text]) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  el.preset.append(option);
});

function applyPlatform({ resetBudget = true } = {}) {
  const platform = PLATFORMS[el.platform.value] || PLATFORMS.any;
  el.platformNote.textContent = platform.note;

  // Flag, do not silently rewrite: an operator may knowingly target a network
  // that takes WebP, and the checks in the result panel say what it costs.
  const disallowed = platform.formats.length && !platform.formats.includes(el.format.value);
  el.platformNote.className = `hint ${disallowed ? 'bad' : ''}`;
  if (disallowed) {
    el.platformNote.textContent = `${platform.note} Поточний формат спрайта не підійде.`;
  }

  if (resetBudget && platform.budget) {
    const option = [...el.budget.options].find((o) => Number(o.value) === platform.budget);
    if (option) el.budget.value = option.value;
  }
  if (state.result) showResult(state.result);
}

el.platform.addEventListener('change', () => applyPlatform());
el.format.addEventListener('change', () => applyPlatform({ resetBudget: false }));

el.preset.addEventListener('change', () => {
  const preset = PRESETS.find(([value]) => value === el.preset.value);
  if (!preset || !state.meta) return;
  const [, , w, h] = preset;
  if (w === 0) { el.w.value = state.meta.width; el.h.value = state.meta.height; }
  else if (w > 0) { el.w.value = w; el.h.value = h; }
  estimate();
});

function linkRatio(changed) {
  if (!el.ratio.checked || !state.meta) return;
  const ratio = state.meta.width / state.meta.height;
  if (changed === 'w') el.h.value = Math.max(16, Math.round(Number(el.w.value) / ratio));
  else el.w.value = Math.max(16, Math.round(Number(el.h.value) * ratio));
}

el.w.addEventListener('input', () => { linkRatio('w'); el.preset.value = 'custom'; estimate(); });
el.h.addEventListener('input', () => { linkRatio('h'); el.preset.value = 'custom'; estimate(); });
el.quality.addEventListener('input', () => { el.qOut.textContent = el.quality.value; });
el.backup.addEventListener('input', () => { el.bkOut.textContent = el.backup.value; });
el.transparent.addEventListener('change', syncTransparency);
el.format.addEventListener('change', syncTransparency);
[el.fps, el.start, el.end, el.scale].forEach((input) => input.addEventListener('input', estimate));

el.convert.addEventListener('click', () => guard(guardedConvert));
el.autofit.addEventListener('click', () => guard(autofit));
el.replay.addEventListener('click', renderPreview);
el.checker.addEventListener('change', () => el.stage.classList.toggle('checker', el.checker.checked));
el.stage.classList.add('checker');
applyPlatform();

$('dl-zip').addEventListener('click', () => state.result && download(state.result.zipBlob, `${state.result.base}-${state.result.width}x${state.result.height}.zip`));
$('dl-html').addEventListener('click', () => state.result && download(new Blob([state.result.htmlInline], { type: 'text/html' }), 'index.html'));
$('dl-sprite').addEventListener('click', () => state.result && download(state.result.spriteBlob, state.result.spriteFile));
$('dl-backup').addEventListener('click', () => state.result && download(state.result.backupBlob, state.result.backupFile));

/* Expose the pipeline so the demo build script can drive it headlessly. */
window.__converter = { useFile, convert, currentOptions, state };
