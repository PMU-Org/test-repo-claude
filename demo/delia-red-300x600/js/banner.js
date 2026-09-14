(function () {
  var FRAMES = 20, FPS = 10, LOOPS = 3;
  var box = document.getElementById('animation_container');
  var imgs = box.getElementsByTagName('img');
  var cur = 0, idx = 0, loops = 0, acc = 0, prev = 0, raf = 0, step = 1000 / FPS;
  var order = [];

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
      if (idx + 1 >= order.length) {
        loops++;
        if (LOOPS && loops >= LOOPS) { show(order[order.length - 1]); raf = 0; return; }
        idx = 0;
      } else {
        idx++;
      }
    }
    show(order[idx]);
    raf = requestAnimationFrame(tick);
  }

  function usable(i) {
    var img = imgs[i];
    return img && (!img.complete || img.naturalWidth > 0);
  }

  function begin() {
    // Animate over the frames that decoded. A missing one is skipped rather
    // than freezing playback on the first frame forever.
    order = [];
    for (var i = 0; i < imgs.length; i++) { if (usable(i)) { order.push(i); } }
    if (order.length > 1) { raf = requestAnimationFrame(tick); }
  }

  function start() {
    if (FRAMES < 2) { return; }
    var pending = 0;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].complete) { continue; }
      pending++;
      imgs[i].onload = imgs[i].onerror = function () { if (--pending <= 0) { begin(); } };
    }
    if (pending === 0) { begin(); }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; prev = 0; }
    else if (!raf && !(LOOPS && loops >= LOOPS)) { raf = requestAnimationFrame(tick); }
  });

  window.startBanner = start;
})();
