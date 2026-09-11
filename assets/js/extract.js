/**
 * Frame extraction from a video file, entirely client-side.
 *
 * Two strategies are used for two different jobs:
 *  - frame rate probing plays a short slice and measures the interval between
 *    frames actually presented by the compositor (requestVideoFrameCallback);
 *  - frame capture seeks to a deterministic timestamp per output frame and
 *    draws into a canvas. Seeking is slower than playback capture but it never
 *    drops or duplicates frames, which matters when a 2 s clip becomes a
 *    fixed-length sprite sheet.
 *
 * The canvas keeps its alpha channel, so VP9 alpha (alpha_mode: 1) survives.
 */

export function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = url;

    const fail = () => reject(new Error('Браузер не зміг декодувати цей файл. Потрібен WebM (VP8/VP9) або інший підтримуваний кодек.'));
    video.addEventListener('error', fail, { once: true });
    video.addEventListener('loadeddata', () => {
      if (!video.videoWidth || !video.videoHeight) return fail();
      resolve(video);
    }, { once: true });
  });
}

/** Median interval between presented frames → source fps. Falls back to 30. */
export async function probeFrameRate(video, maxProbeSeconds = 2) {
  if (typeof video.requestVideoFrameCallback !== 'function') return { fps: 30, exact: false };

  const stamps = [];
  const done = new Promise((resolve) => {
    const onFrame = (_now, meta) => {
      stamps.push(meta.mediaTime);
      if (stamps.length >= 60 || meta.mediaTime > maxProbeSeconds) return resolve();
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    setTimeout(resolve, 3000);
  });

  try {
    video.currentTime = 0;
    await video.play();
    await done;
  } catch {
    /* autoplay blocked — fall through to the default */
  } finally {
    video.pause();
  }

  const deltas = [];
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    if (d > 0.001) deltas.push(d);
  }
  if (deltas.length < 3) return { fps: 30, exact: false };

  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1];
  const raw = 1 / median;

  // Snap to a standard rate when we are within 3% of one.
  for (const std of [60, 50, 30, 29.97, 25, 24, 23.976, 20, 15, 12, 10]) {
    if (Math.abs(raw - std) / std < 0.03) return { fps: std, exact: true };
  }
  return { fps: Math.round(raw * 100) / 100, exact: true };
}

function seek(video, time) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = time;
  });
}

/**
 * Capture `count` frames of size w×h, sampling the source at the midpoint of
 * each output frame's interval — the midpoint avoids landing exactly on a
 * frame boundary, where rounding decides which of two frames you get.
 *
 * @returns {Promise<{canvases: HTMLCanvasElement[], hasAlpha: boolean}>}
 */
export async function captureFrames(video, opts, onProgress) {
  const { start, end, fps, width, height, background } = opts;
  const span = Math.max(end - start, 1 / fps);
  const count = Math.max(1, Math.round(span * fps));
  const step = span / count;

  const canvases = [];
  let hasAlpha = false;

  for (let i = 0; i < count; i++) {
    const t = Math.min(start + step * (i + 0.5), Math.max(end - 1e-3, start));
    await seek(video, t);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: !background });
    ctx.imageSmoothingQuality = 'high';

    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.drawImage(video, 0, 0, width, height);

    if (i === 0 && !background) hasAlpha = detectAlpha(ctx, width, height);
    canvases.push(canvas);

    if (onProgress) onProgress((i + 1) / count, i + 1, count);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }

  return { canvases, hasAlpha, fps, count };
}

/** Sparse grid scan for any non-opaque pixel. */
function detectAlpha(ctx, w, h) {
  const steps = 12;
  for (let y = 0; y < steps; y++) {
    for (let x = 0; x < steps; x++) {
      const px = Math.min(w - 1, Math.floor((x + 0.5) * w / steps));
      const py = Math.min(h - 1, Math.floor((y + 0.5) * h / steps));
      if (ctx.getImageData(px, py, 1, 1).data[3] < 250) return true;
    }
  }
  return false;
}
