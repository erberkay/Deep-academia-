/* Deep Academia Fitness Center — site interactions (no dependencies) */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cl = (x) => Math.max(0, Math.min(1, x));

  /* ---------------- hero: Phive-style ribbon slideshow ---------------- */
  // Each scene: the band scrolls its title until every letter has been on screen, then it opens onto
  // the photo/video and the letters start rolling; OPEN_MS later the next scene comes in.
  const bgs = $$('.hero .bg'), cts = $$('.hero .ct'), rbs = $$('.hero .rb'), buls = $$('.hero .bul');
  const hs = { cur: 0, leave: -1, phase: 'band', first: true, run: false, done: -1, entering: false, leaveOpen: false };
  const OPEN_MS = 7500, HOLD_MS = 900;
  let ht = [];
  const at = (ms, fn) => ht.push(setTimeout(fn, Math.max(0, ms)));
  const clearAll = () => { ht.forEach(clearTimeout); ht = []; };
  // band text speed in px/s (the design's 12 s loop is ~200 px/s on a 1440 px screen)
  const rbSpeed = () => Math.max(130, window.innerWidth * 0.14);
  // ms the band needs, once moving, until the last letter of its title is fully on screen, plus a beat
  function readMs(i) {
    const t = rbs[i] && $('.rb-title', rbs[i]);
    if (!t || reduce) return 0;
    const pad = parseFloat(getComputedStyle(t).paddingLeft) || 0;
    return Math.max(0, t.offsetWidth - (window.innerWidth - pad)) / rbSpeed() * 1000 + HOLD_MS;
  }
  function heroApply() {
    const state = (i) => i === hs.cur
      ? ' cur' + (hs.phase === 'open' ? ' open' : ' band') + (hs.first ? ' first' : '') + (hs.entering ? ' in' : '')
      : (i === hs.leave ? ' leave' + (hs.leaveOpen ? ' o' : '') : '');
    bgs.forEach((e, i) => { e.className = 'bg' + state(i); });
    cts.forEach((e, i) => { e.className = 'ct' + state(i); });
    rbs.forEach((e, i) => { e.className = 'rb' + state(i); if (i !== hs.cur && i !== hs.leave) flipOff(i); });
    buls.forEach((e, i) => { e.className = 'bul' + (i === hs.cur && hs.run ? ' run' : '') + (i === hs.done ? ' done' : ''); });
  }
  function heroSet(p) { Object.assign(hs, p); heroApply(); }
  // the band holds still while it slides in (first scene) or while the next scene sweeps in over the old
  // one (.85s close + 1.6s gradient sweep, see .in in styles.css), then scrolls from its first letter
  const SWEEP_END = 2600;
  const stillMs = (first) => (first ? 1300 : SWEEP_END);
  function prepScene(i, first) {
    flipOff(i);
    if (!rbs[i]) return;
    rbs[i].style.setProperty('--rbdl', stillMs(first) / 1000 + 's');
    // a band that is still leaving keeps its running scroll animation: restart it from the first letter
    const row = $('.rb-row', rbs[i]);
    if (row) { row.style.animation = 'none'; void row.offsetWidth; row.style.animation = ''; }
  }
  function runScene(i, first) {
    const runAt = first ? 2000 : SWEEP_END, minOpen = 4500;
    at(runAt, () => {
      const openAt = Math.max(minOpen, stillMs(first) + readMs(i)), nextAt = openAt + OPEN_MS;
      if (buls[i]) buls[i].style.setProperty('--fill', (nextAt - runAt) / 1000 + 's');
      heroSet(first ? { run: true } : { leave: -1, run: true, done: -1, entering: false });
      // a bullet clicked while this scene was sweeping in: go there now that the sweep has finished
      if (hs.queued !== null && hs.queued !== undefined) {
        const q = hs.queued;
        hs.queued = null;
        if (q !== hs.cur) { heroNext(q); return; }
      }
      at(openAt - runAt, () => { heroSet({ phase: 'open', first: false }); flipOn(i); });
      at(nextAt - runAt, () => heroNext());
    });
  }
  function heroNext(i) {
    const n = i === undefined ? (hs.cur + 1) % bgs.length : i;
    if (n === hs.cur) return;
    // never cut a gradient sweep short (that would swap band and photo in one frame): queue the click
    if (hs.entering) { hs.queued = n; return; }
    clearAll();
    prepScene(n, false);
    heroSet({ leave: hs.cur, leaveOpen: hs.phase === 'open', cur: n, phase: 'band', first: false, run: false, done: hs.run ? hs.cur : -1, entering: true });
    runScene(n, false);
  }

  /* band letters roll once the band has opened: .fa chars squash down while .fb chars grow
     (stagger .1s, expo.inOut 2s, yoyo) */
  const flips = new Map();
  function flipOn(i) {
    if (reduce || flips.has(i) || !rbs[i]) return;
    const ex = 'cubic-bezier(0.87, 0, 0.13, 1)', list = [];
    $$('.rb-title', rbs[i]).forEach((t) => {
      const fa = $$('.fa .c', t), fb = $$('.fb .c', t);
      if (!fa.length || !fa[0].animate) return;
      const vis = [];
      fa.forEach((el, k) => { if (el.textContent.trim() !== '') vis.push(k); });
      const n = vis.length, T = 2 + (n - 1) * 0.1, D = 2 * T;
      vis.forEach((idx, j) => {
        const st = 0.1 * j;
        const k = [st / D, (st + 2) / D, (D - st - 2) / D, (D - st) / D].map((v) => Math.min(1, Math.max(0, v)));
        for (let q = 1; q < 4; q++) k[q] = Math.max(k[q], k[q - 1]);
        const mk = (x, y) => [
          { transform: 'scaleY(' + x + ')', offset: 0 },
          { transform: 'scaleY(' + x + ')', offset: k[0], easing: ex },
          { transform: 'scaleY(' + y + ')', offset: k[1] },
          { transform: 'scaleY(' + y + ')', offset: k[2], easing: ex },
          { transform: 'scaleY(' + x + ')', offset: k[3] },
          { transform: 'scaleY(' + x + ')', offset: 1 }
        ];
        list.push(fa[idx].animate(mk(1, 0), { duration: D * 1000, iterations: Infinity }));
        list.push(fb[idx].animate(mk(0, 1), { duration: D * 1000, iterations: Infinity }));
      });
    });
    flips.set(i, list);
  }
  function flipOff(i) {
    const list = flips.get(i);
    if (!list) return;
    list.forEach((an) => an.cancel());
    flips.delete(i);
  }

  if (bgs.length) {
    prepScene(0, true);
    heroApply();
    runScene(0, true);
    buls.forEach((b, i) => b.addEventListener('click', () => heroNext(i)));
    // replay the current scene from its first letter when its timing no longer matches what is on screen
    const replay = () => {
      clearAll();
      const i = hs.cur;
      hs.queued = null;
      prepScene(i, false);
      heroSet({ leave: -1, phase: 'band', first: false, run: false, done: -1, entering: false });
      runScene(i, false);
    };
    // timers are throttled in a background tab while CSS keeps moving
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll(); else replay(); });
    // a rotation / width change during the band changes font size, title width and speed: start over
    // (height-only resizes, like a phone's address bar, are ignored)
    let heroW = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === heroW) return;
      heroW = window.innerWidth;
      if (hs.phase === 'band' && !hs.entering) requestAnimationFrame(replay);
    });
  }

  /* ---------------- sliders: equipment + testimonials ---------------- */
  function slider(items, onCls, dots, prev, next) {
    let i = 0;
    const show = (n) => {
      i = (n + items.length) % items.length;
      items.forEach((e, k) => e.classList.toggle('on', k === i));
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
    };
    dots.forEach((d, k) => d.addEventListener('click', () => show(k)));
    if (prev) prev.addEventListener('click', () => show(i - 1));
    if (next) next.addEventListener('click', () => show(i + 1));
    return () => show(i + 1);
  }
  const allDots = $$('button.dot');
  const eqItems = $$('.eq-slide'), qItems = $$('figure.q');
  const eqNext = slider(eqItems, 'on', allDots.slice(0, eqItems.length), $('[aria-label="Önceki görsel"]'), $('[aria-label="Sonraki görsel"]'));
  const qNext = slider(qItems, 'on', allDots.slice(eqItems.length, eqItems.length + qItems.length), $('[aria-label="Önceki yorum"]'), $('[aria-label="Sonraki yorum"]'));
  setInterval(() => { if (!document.hidden) { eqNext(); qNext(); } }, 6000);

  /* ---------------- full-screen menu ---------------- */
  const menu = $('.menu'), burger = $('.burger'), items = $$('.menu .mi');
  function setMenu(open) {
    if (!menu) return;
    menu.classList.toggle('open', open);
    menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    burger.classList.toggle('x', open);
    burger.setAttribute('aria-label', open ? 'Menüyü kapat' : 'Menüyü aç');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    items.forEach((m, i) => { m.style.transitionDelay = open ? (0.3 + i * 0.07) + 's' : '0s'; m.tabIndex = open ? 0 : -1; });
    menuOpen = open;
  }
  let menuOpen = false;
  if (burger) {
    burger.addEventListener('click', () => setMenu(!menuOpen));
    items.forEach((m) => m.addEventListener('click', () => setMenu(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) setMenu(false); });
    setMenu(false);
  }

  /* ---------------- class cards: 3D tilt ---------------- */
  $$('.ccard').forEach((c, i) => {
    c.addEventListener('mousemove', (e) => {
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2, y = (e.clientY - r.top - r.height / 2) / r.height * 4;
      html.dataset.tilt = String(i + 1);
      html.style.setProperty('--tiltX', String(y));
      html.style.setProperty('--tiltY', String(x / r.width * -8));
    });
    c.addEventListener('mouseleave', () => { html.style.setProperty('--tiltX', '0'); html.style.setProperty('--tiltY', '0'); });
  });

  /* ---------------- scroll engine (ScrollTrigger + Lenis equivalents) ----------------
     Built to stay smooth on phones:
     - positions are measured once in measure() and cached, so a scroll frame does no layout reads;
     - each section's values are written on that section only. Custom properties inherit, so writing them
       on <html> made the browser restyle the whole page (about 1700 band letters included) on every frame;
     - values and attributes that did not change are not written again;
     - on touch screens the address bar showing/hiding does not resize every --V section mid-scroll. */
  const E = { V: 900, w: 0, mdNow: 0, live: false };
  const G = { club: null, bold: null, cls: null, ig: null, ints: [] };
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const elClub = document.getElementById('kulup'), elBold = $('.bold'), elCls = document.getElementById('dersler');
  const elCta = elClub ? $('.cta-btns', elClub) : null;
  const written = new WeakMap();
  const set = (el, k, v) => {
    if (!el) return;
    const sv = String(Math.round(v * 10000) / 10000);
    let m = written.get(el);
    if (!m) { m = {}; written.set(el, m); }
    if (m[k] === sv) return;
    m[k] = sv;
    el.style.setProperty(k, sv);
  };
  const flag = (k, v) => { if (html.dataset[k] !== v) html.dataset[k] = v; };
  const top = (el) => el.getBoundingClientRect().top + window.scrollY;
  const live = () => E.live;
  function measure() {
    const W = window.innerWidth, Vn = window.innerHeight;
    if (!coarse || !E.w || W !== E.w || Math.abs(Vn - E.V) > 160) {
      E.V = Vn;
      html.style.setProperty('--V', Vn + 'px');
    }
    E.w = W;
    const sp = rbSpeed();
    rbs.forEach((rb) => {
      const cp = $('.rb-in', rb);
      if (cp && cp.offsetWidth) rb.style.setProperty('--rbd', (cp.offsetWidth / sp).toFixed(2) + 's');
    });
    const sv = $('.bd-svg');
    if (sv && elBold) {
      let ux = 1000, uy = 560;
      try {
        const t = $('.bd-dal', sv);
        const exr = t && t.getExtentOfChar ? t.getExtentOfChar(2) : null;
        if (exr && exr.width > 0) { ux = exr.x + exr.width * 0.32; uy = exr.y + exr.height * 0.55; }
      } catch (err) { /* estimate */ }
      const SW = sv.clientWidth, SH = sv.clientHeight, k = Math.min(SW / 1440, SH / 900);
      elBold.style.setProperty('--mox', ((SW - 1440 * k) / 2 + ux * k) + 'px');
      elBold.style.setProperty('--moy', ((SH - 900 * k) / 2 + uy * k) + 'px');
    }
    const se = document.scrollingElement || html;
    E.live = !reduce && se.scrollHeight > window.innerHeight + 4;
    if (elClub) {
      const an = $('.cl-anim', elClub), pw = $('.pg-wrap', elClub);
      G.club = { t: top(elClub), h: elClub.offsetHeight, an: an ? top(an) : null, pw: pw ? { t: top(pw), h: pw.offsetHeight } : null };
    }
    if (elBold) G.bold = { t: top(elBold) };
    if (elCls) {
      const t = top(elCls), h = elCls.offsetHeight, grid = $('.cls-grid', elCls);
      G.cls = { t, h, gb: grid ? top(grid) + grid.offsetHeight : t + h, cards: $$('.cc', elCls).map(top) };
    }
    const ig = $('.ig-grid');
    G.ig = ig ? top(ig) : null;
    G.ints = $$('[data-int]').map((s) => { const t = top(s); return { t, b: t + s.offsetHeight, bold: s.classList.contains('bold') }; });
  }
  function tick() {
    const V = E.V, y = window.scrollY;
    if (!E.live) {
      [['--pg', 0], ['--pc', 1], ['--cl', 0.12]].forEach(([k, v]) => set(elClub, k, v));
      [['--bd', 0.6], ['--dly', 0], ['--d1y', -V * 0.3], ['--d1s', 0.5], ['--d1o', 1], ['--mz', 1], ['--dz', 0]].forEach(([k, v]) => set(elBold, k, v));
      [['--cs', 0.12], ['--cp1', 0.3], ['--cp2', 0.3], ['--cp3', 0.3], ['--cp4', 0.3]].forEach(([k, v]) => set(elCls, k, v));
      if (elCta) elCta.classList.add('on');
      flag('cl', 'in'); flag('cta', 'in'); flag('ig', 'in');
      return;
    }
    const C = G.club;
    if (C) {
      set(elClub, '--cl', cl((y - C.t + V) / C.h));
      if (C.an !== null && C.an - y < V / 2) flag('cl', 'in');
      if (C.pw) {
        const p = cl((y - C.pw.t + V) / C.pw.h), pc = cl((p - 0.75) / 0.15);
        set(elClub, '--pg', p);
        set(elClub, '--pc', pc);
        if (p > 0.5) flag('cta', 'in');
        // the CTA buttons only take clicks once they are actually showing
        if (elCta && elCta.classList.contains('on') !== pc > 0.05) elCta.classList.toggle('on', pc > 0.05);
      }
    }
    if (G.bold) {
      const bd = (y - G.bold.t) / V;
      const e1 = 1 - Math.pow(1 - cl(bd), 3);
      const a2 = cl((bd - 1.3) / 2.3);
      set(elBold, '--bd', bd);
      set(elBold, '--dly', 700 * (1 - e1));
      set(elBold, '--d1y', -V * 0.34 * e1);
      set(elBold, '--d1s', 1 - 0.5 * e1);
      set(elBold, '--d1o', 1 - cl((bd - 1.3) / 0.4));
      set(elBold, '--mz', 1 + 79 * a2 * a2 * a2);
      set(elBold, '--dz', a2);
      E.mdNow = a2 > 0.6 ? 1 : 0;
    }
    const K = G.cls;
    if (K) {
      set(elCls, '--cs', cl((y - K.t + V) / K.h));
      K.cards.forEach((ct, i) => {
        const st = ct - V;
        set(elCls, '--cp' + (i + 1), cl((y - st) / Math.max(1, K.gb - st)));
      });
    }
    if (G.ig !== null && G.ig - y < V) flag('ig', 'in');
    const probe = y + V - 50;
    let dark = false;
    G.ints.forEach((s) => { if (s.t <= probe && s.b >= probe) dark = !(s.bold && E.mdNow > 0.5); });
    flag('pill', dark ? 'dark' : 'light');
    flag('hdr', y > V * 0.8 ? 'hide' : 'show');
  }
  let raf = 0;
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tick(); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  let rz = 0;
  const remeasure = () => { if (!rz) rz = requestAnimationFrame(() => { rz = 0; measure(); tick(); }); };
  window.addEventListener('resize', remeasure);
  // images and fonts arriving change section heights: keep the cached positions right
  if (window.ResizeObserver) new ResizeObserver(remeasure).observe(document.body);

  /* smooth wheel scrolling (Lenis-like, lerp 0.1) + smooth anchor jumps */
  const sm = { target: 0, cur: 0, run: false, last: 0, anim: null };
  function step(ts) {
    if (!sm.run) return;
    const dt = sm.last ? Math.min((ts - sm.last) / 1000, 0.05) : 1 / 60;
    sm.last = ts;
    if (sm.anim) {
      const a = sm.anim, k = Math.min(1, (ts - a.t0) / a.dur);
      const e = k < 0.5 ? 4 * k * k * k : (k - 1) * (2 * k - 2) * (2 * k - 2) + 1;
      sm.cur = a.from + (a.to - a.from) * e; sm.target = sm.cur;
      if (k >= 1) { sm.anim = null; sm.run = false; }
    } else {
      sm.cur += (sm.target - sm.cur) * (1 - Math.exp(-0.1 * 60 * dt));
      if (Math.abs(sm.target - sm.cur) < 0.5) { sm.cur = sm.target; sm.run = false; }
    }
    window.scrollTo(0, sm.cur);
    if (sm.run) requestAnimationFrame(step);
  }
  const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!reduce && !isTouch) {
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || menuOpen || tourOpen || !live()) return;
      e.preventDefault();
      const se = document.scrollingElement || html;
      sm.anim = null;
      if (!sm.run) { sm.cur = window.scrollY; sm.target = window.scrollY; }
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
      sm.target = Math.max(0, Math.min(sm.target + d, se.scrollHeight - window.innerHeight));
      if (!sm.run) { sm.run = true; sm.last = 0; requestAnimationFrame(step); }
    }, { passive: false });
  }
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    if (a.getAttribute('href') === '#tur') { e.preventDefault(); setTour(true); return; }
    const id = a.getAttribute('href').slice(1);
    const el = id ? document.getElementById(id) : null;
    if (!el) { if (a.getAttribute('href') === '#') e.preventDefault(); return; }
    e.preventDefault();
    if (reduce) { window.scrollTo(0, top(el)); return; }
    sm.anim = { from: window.scrollY, to: top(el), t0: performance.now(), dur: 1000 };
    if (!sm.run) { sm.run = true; sm.last = 0; requestAnimationFrame(step); }
  });

  /* ---------------- 360° tour: Matterport scan of the club, walked like a game with the keyboard ----------------
     The scan's own viewer handles the walking (↑/W forward, ↓/S back, ←/→ turn, A/D side step, hold to keep going);
     this keeps the keyboard inside it, so the real photos are shown at full quality. */
  const tour = $('.tour'), frame = tour ? $('.tour-frame', tour) : null;
  const tGo = tour ? $('.tour-go', tour) : null, tFs = tour ? $('.tour-fs', tour) : null;
  let tourOpen = false, tourReady = false, tourLive = false, tourBack = null, tourPushed = false;
  const walkKey = (k) => /^(Arrow(Up|Down|Left|Right)|[wasdWASD])$/.test(k);
  function tourSync() {
    if (tour) tour.classList.toggle('away', tourOpen && tourLive && document.activeElement !== frame);
  }
  function tourFocus() {
    if (!frame || !tourLive) return;
    try { frame.focus({ preventScroll: true }); } catch (err) { frame.focus(); }
    setTimeout(tourSync, 0);
  }
  function tourStart() {
    if (!tourReady || tourLive) return;
    tourLive = true;
    tour.classList.add('live');
    frame.removeAttribute('tabindex');
    tourFocus();
  }
  function setTour(open) {
    if (!tour || open === tourOpen) return;
    tourOpen = open;
    if (open) {
      if (menuOpen) setMenu(false);
      tourBack = document.activeElement;
      if (!frame.getAttribute('src')) {
        frame.addEventListener('load', () => setTimeout(() => {
          tourReady = true;
          tour.classList.add('ready');
          if (tGo) { tGo.disabled = false; if (tourOpen && !tourLive) tGo.focus({ preventScroll: true }); }
        }, 1500), { once: true });
        frame.setAttribute('src', frame.dataset.src);
        // no answer from Matterport: say so and offer the tour in a new tab instead of spinning forever
        setTimeout(() => { if (!tourReady) tour.classList.add('fail'); }, 15000);
      }
      tour.removeAttribute('inert');
      tour.setAttribute('aria-hidden', 'false');
      tour.classList.add('open');
      html.classList.add('tour-on');
      // keep keyboard focus inside the dialog: the page behind it is inert while it is open
      [...tour.parentElement.children].forEach((el) => { if (el !== tour) el.inert = true; });
      sm.anim = null; sm.run = false;
      setTimeout(() => {
        if (tourLive) tourFocus();
        else (tGo && !tGo.disabled ? tGo : $('.tour-x', tour)).focus({ preventScroll: true });
      }, 80);
      // a history entry, so the phone's Back button closes the tour instead of leaving the site
      if (location.hash !== '#tur') { history.pushState({ tour: 1 }, '', '#tur'); tourPushed = true; }
    } else {
      if (document.fullscreenElement === tour && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      tour.classList.remove('open');
      tour.setAttribute('aria-hidden', 'true');
      tour.setAttribute('inert', '');
      html.classList.remove('tour-on');
      [...tour.parentElement.children].forEach((el) => { if (el !== tour) el.inert = false; });
      if (location.hash === '#tur') {
        if (tourPushed) history.back();
        else history.replaceState(null, '', location.pathname + location.search);
      }
      tourPushed = false;
      window.focus();
      if (tourBack && tourBack.focus) tourBack.focus({ preventScroll: true });
    }
    tourSync();
  }
  if (tour) {
    $('.tour-x', tour).addEventListener('click', () => setTour(false));
    if (tGo) tGo.addEventListener('click', tourStart);
    $('.tour-hint', tour).addEventListener('click', tourFocus);
    if (tFs) {
      if (!document.fullscreenEnabled || !tour.requestFullscreen) tFs.hidden = true;
      tFs.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else tour.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const fs = document.fullscreenElement === tour;
        tFs.setAttribute('aria-pressed', fs ? 'true' : 'false');
        tFs.setAttribute('aria-label', fs ? 'Tam ekrandan çık' : 'Tam ekran');
        setTimeout(tourFocus, 60);
      });
    }
    // focus moving into / out of the scan shows or hides the "click to walk" hint
    window.addEventListener('blur', () => setTimeout(tourSync, 0));
    window.addEventListener('focus', () => setTimeout(tourSync, 0));
    document.addEventListener('keydown', (e) => {
      if (!tourOpen) return;
      if (e.key === 'Escape') { setTour(false); return; }
      if (!walkKey(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (!tourLive) tourStart(); else tourFocus();
    });
    if (location.hash === '#tur') setTour(true);
    window.addEventListener('hashchange', () => setTour(location.hash === '#tur'));
  }

  measure(); tick();
  const ready = () => { measure(); tick(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready); else window.addEventListener('load', ready);
  window.addEventListener('load', () => { measure(); tick(); });
})();
