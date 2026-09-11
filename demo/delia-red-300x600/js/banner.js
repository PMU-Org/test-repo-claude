(function () {
  var FRAMES = 20, COLS = 7, FW = 300, FH = 600, FPS = 10, LOOPS = 3;
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

  var probe = new Image();
  probe.onerror = function () {
    cancelAnimationFrame(raf);
    raf = 0;
    if (window.console) { console.error('images/sprite.jpg failed to load next to body.html'); }
    var host = location.hostname;
    var local = location.protocol === 'file:' || host === '' || host === 'localhost'
      || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (!local) { return; }
    el.style.background = '#fff';
    el.style.cssText += ';display:flex;align-items:center;justify-content:center;padding:18px;'
      + 'font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#c1121f;text-align:center';
    el.textContent = 'Не знайдено images/sprite.jpg поруч з body.html. '
      + 'Розпакуйте архів повністю — банер складається з кількох файлів. '
      + '(Missing images/sprite.jpg: extract the whole archive, do not open body.html from inside the ZIP.)';
  };
  probe.src = 'images/sprite.jpg';
  window.startBanner = start;
})();
