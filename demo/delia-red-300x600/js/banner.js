(function () {
  var FRAMES = 20, FPS = 10, LOOPS = 3;
  var box = document.getElementById('animation_container');
  var imgs = box.getElementsByTagName('img');
  var cur = 0, idx = 0, loops = 0, acc = 0, prev = 0, raf = 0, step = 1000 / FPS;

  function show(i) {
    if (i === cur || !imgs[i]) { return; }
    imgs[cur].style.display = 'none';
    imgs[i].style.display = 'block';
    cur = i;
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
    if (FRAMES > 1) { raf = requestAnimationFrame(tick); }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; prev = 0; }
    else if (!raf && !(LOOPS && loops >= LOOPS)) { raf = requestAnimationFrame(tick); }
  });

  window.startBanner = start;
})();
