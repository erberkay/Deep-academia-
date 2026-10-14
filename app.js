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
  // phones and tablets skip the letter roll: ~190 separately animated letters per band each get their own
  // compositor layer, which made scrolling stutter on phones (257 layers at the top of the page vs 88)
  const lightHero = !!(window.matchMedia && window.matchMedia('(pointer: coarse), (max-width: 900px)').matches);
  function flipOn(i) {
    if (reduce || lightHero || flips.has(i) || !rbs[i]) return;
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
    dalSize();
    if (elCls) {
      const t = top(elCls), h = elCls.offsetHeight, grid = $('.cls-grid', elCls);
      G.cls = { t, h, gb: grid ? top(grid) + grid.offsetHeight : t + h, cards: $$('.cc', elCls).map(top) };
    }
    const ig = $('.ig-grid');
    G.ig = ig ? top(ig) : null;
    G.ints = $$('[data-int]').map((s) => { const t = top(s); return { t, b: t + s.offsetHeight, bold: s.classList.contains('bold') }; });
  }
  /* DERİNLERE DAL: the lime sheet with "DAL" cut out, drawn on a canvas. As an SVG mask whose text slides and
     whose layer zooms 80x, phones had to re-rasterize the whole screen on the CPU every frame (heavy stutter);
     the canvas fills one rectangle and three letters, and only when the values change. The SVG stays as the
     fallback (no canvas, reduced motion). */
  const dal = { cv: null, ctx: null, ok: false, r: 1, ly: NaN, lz: NaN };
  const DAL_FONT = '600px Anton, Kanit, sans-serif';
  function dalSetup() {
    const wrap = $('.bd-maskwrap');
    if (!wrap || dal.cv) return;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    cv.className = 'bd-cv';
    cv.setAttribute('aria-hidden', 'true');
    wrap.appendChild(cv);
    dal.cv = cv; dal.ctx = ctx;
    dal.lime = (getComputedStyle(html).getPropertyValue('--lime') || '#D6FB00').trim() || '#D6FB00';
    const go = () => { dal.ok = true; dalSize(); wrap.classList.add('cv'); tick(); };
    if (document.fonts && document.fonts.load) document.fonts.load(DAL_FONT).then(go, go); else go();
  }
  function dalSize() {
    if (!dal.cv) return;
    const W = dal.cv.parentElement.clientWidth, H = dal.cv.parentElement.clientHeight;
    if (!W || !H) return;
    dal.r = Math.min(window.devicePixelRatio || 1, 2);
    dal.cv.width = Math.round(W * dal.r); dal.cv.height = Math.round(H * dal.r);
    // the word laid out exactly like the SVG: viewBox 1440x900 "meet", centred, baseline 760, letter-spacing 10
    const k = Math.min(W / 1440, H / 900), c = dal.ctx;
    c.font = DAL_FONT;
    const ws = ['D', 'A', 'L'].map((ch) => c.measureText(ch).width);
    let x = 720 - (ws[0] + ws[1] + ws[2] + 30) / 2;
    dal.glyphs = ws.map((w, i) => { const g = { ch: 'DAL'[i], x }; x += w + 10; return g; });
    const m = c.measureText('L');
    const asc = m.fontBoundingBoxAscent || 600 * 0.9, desc = m.fontBoundingBoxDescent || 600 * 0.25;
    dal.k = k; dal.ox = (W - 1440 * k) / 2; dal.oy = (H - 900 * k) / 2;
    // we dive into the L's stem (same point the SVG zoom used)
    dal.O = { x: dal.ox + (dal.glyphs[2].x + ws[2] * 0.32) * k, y: dal.oy + (760 - asc + (asc + desc) * 0.55) * k };
    dal.ly = NaN;
  }
  function dalDraw(dly, mz) {
    if (!dal.ok || !dal.O || (dly === dal.ly && mz === dal.lz)) return;
    dal.ly = dly; dal.lz = mz;
    const c = dal.ctx, r = dal.r, O = dal.O, s = r * mz * dal.k;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = dal.lime;
    c.fillRect(0, 0, dal.cv.width, dal.cv.height);
    c.globalCompositeOperation = 'destination-out';
    // screen = O + mz * (svgLayout - O)
    c.setTransform(s, 0, 0, s, r * (O.x * (1 - mz) + mz * dal.ox), r * (O.y * (1 - mz) + mz * dal.oy));
    c.font = DAL_FONT;
    c.textBaseline = 'alphabetic';
    c.fillStyle = '#000000';
    dal.glyphs.forEach((g) => c.fillText(g.ch, g.x, 760 + dly));
    c.globalCompositeOperation = 'source-over';
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
      // clamped: outside the section the value stops changing, so the section is not restyled while away
      const bd = Math.max(-1.2, Math.min(5.2, (y - G.bold.t) / V));
      const e1 = 1 - Math.pow(1 - cl(bd), 3);
      const a2 = cl((bd - 1.3) / 2.3);
      set(elBold, '--bd', bd);
      set(elBold, '--dly', 700 * (1 - e1));
      set(elBold, '--d1y', -V * 0.34 * e1);
      set(elBold, '--d1s', 1 - 0.5 * e1);
      set(elBold, '--d1o', 1 - cl((bd - 1.3) / 0.4));
      set(elBold, '--mz', 1 + 79 * a2 * a2 * a2);
      set(elBold, '--dz', a2);
      dalDraw(700 * (1 - e1), 1 + 79 * a2 * a2 * a2);
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
      if (e.ctrlKey || e.metaKey || menuOpen || tourOpen || s3Open || ovlOpen() || !live()) return;
      e.preventDefault();
      const se = document.scrollingElement || html;
      sm.anim = null;
      if (!sm.run) { sm.cur = window.scrollY; sm.target = window.scrollY; }
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
      sm.target = Math.max(0, Math.min(sm.target + d, se.scrollHeight - window.innerHeight));
      if (!sm.run) { sm.run = true; sm.last = 0; requestAnimationFrame(step); }
    }, { passive: false });
  }
  function scrollToEl(el) {
    if (reduce) { window.scrollTo(0, top(el)); return; }
    sm.anim = { from: window.scrollY, to: top(el), t0: performance.now(), dur: 1000 };
    if (!sm.run) { sm.run = true; sm.last = 0; requestAnimationFrame(step); }
  }
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (href === '#tur') { e.preventDefault(); if (s3Open) swapOverlay('#tur'); else setTour(true); return; }
    if (href === '#salon3d') { e.preventDefault(); if (tourOpen) swapOverlay('#salon3d'); else setSalon(true); return; }
    if (isPanelRoute(href)) { e.preventDefault(); openRoute(href); return; }
    const id = href.slice(1);
    const el = id ? document.getElementById(id) : null;
    if (!el) { if (href === '#') e.preventDefault(); return; }
    e.preventDefault();
    if (ovlOpen()) {
      closePanels(() => {
        scrollToEl(el);
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
      });
      return;
    }
    scrollToEl(el);
  });

  /* ---------------- 360° tour: the club's real 360° captures, walked like a game ----------------
     tour/walker.js shows every capture point's photo cube at full quality and glides from point to point:
     ↑/W forward (hold to keep walking), ↓/S back, ←/→ turn, A/D side step; drag to look, tap to walk.
     It runs inside this page, so the keyboard (and Escape) stay with the site. */
  const tour = document.getElementById('tur'), stage = tour ? $('.tour-walk', tour) : null;
  const tGo = tour ? $('.tour-go', tour) : null, tFs = tour ? $('.tour-fs', tour) : null;
  let tourOpen = false, tourReady = false, tourLive = false, tourBack = null, tourPushed = false;
  let wk = null, wkLoading = null;
  const walkKey = (k) => /^(Arrow(Up|Down|Left|Right)|[wasdqeWASDQE])$/.test(k);
  function loadWalker() {
    if (wkLoading) return wkLoading;
    wkLoading = import('./tour/walker.js?v=2')
      .then(({ Walker, drawMap }) => {
        const map = $('.tour-map', tour), mctx = map.getContext('2d');
        wk = new Walker(stage, { onFrame: (w) => { if (tourLive) drawMap(mctx, map.width / 180, w); } });
        wk.canvas.addEventListener('focus', tourSync);
        wk.canvas.addEventListener('blur', () => setTimeout(tourSync, 0));
        if (!tourOpen) wk.pause();
        return wk.load('tour/tour.json?v=2');
      })
      .then(() => {
        tourReady = true;
        tour.classList.add('ready');
        if (tGo) { tGo.disabled = false; if (tourOpen && !tourLive) tGo.focus({ preventScroll: true }); }
      })
      .catch(() => tour.classList.add('fail'));
    return wkLoading;
  }
  function tourSync() {
    if (tour) tour.classList.toggle('away', tourOpen && tourLive && !!wk && document.activeElement !== wk.canvas);
  }
  function tourFocus() {
    if (!wk || !tourLive || !tourOpen) return;
    wk.focus();
    setTimeout(tourSync, 0);
  }
  function tourStart() {
    if (!tourReady || tourLive) return;
    tourLive = true;
    tour.classList.add('live');
    tourFocus();
  }
  function setTour(open, swap) {
    if (!tour || open === tourOpen) return;
    tourOpen = open;
    if (open) {
      if (menuOpen) setMenu(false);
      tourBack = document.activeElement;
      loadWalker();
      if (wk) wk.resume();
      document.dispatchEvent(new CustomEvent('da:tour-open'));   // the 3D salon frees its viewer on phones
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
      if (wk) wk.pause();                       // no drawing while hidden
      tour.classList.remove('open');
      tour.setAttribute('aria-hidden', 'true');
      tour.setAttribute('inert', '');
      html.classList.remove('tour-on');
      [...tour.parentElement.children].forEach((el) => { if (el !== tour) el.inert = (el.classList.contains('ovl') || el.classList.contains('tour')) && !el.classList.contains('open'); });
      if (swap) history.replaceState({ tour: 1 }, '', swap);
      else if (location.hash === '#tur') {
        if (tourPushed) history.back();
        else history.replaceState(null, '', location.pathname + location.search);
      }
      tourPushed = false;
      if (!swap && tourBack && tourBack.focus) tourBack.focus({ preventScroll: true });
    }
    tourSync();
  }
  if (tour) {
    $('.tour-x', tour).addEventListener('click', () => setTour(false));
    if (tGo) tGo.addEventListener('click', tourStart);
    $('.tour-hint', tour).addEventListener('click', tourFocus);
    // touch arrows: press and hold to keep walking / turning
    $$('.tour-dpad button', tour).forEach((btn) => {
      const d = btn.dataset.d;
      const on = (e) => { e.preventDefault(); if (wk && tourLive) wk.press(d, true); };
      const off = () => { if (wk) wk.press(d, false); };
      btn.addEventListener('pointerdown', on);
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, off));
    });
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
    document.addEventListener('keydown', (e) => {
      if (!tourOpen) return;
      if (e.key === 'Escape') { setTour(false); return; }
      if (!walkKey(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (wk && document.activeElement === wk.canvas) return;   // the walker handles it
      e.preventDefault();
      if (!tourLive) { tourStart(); return; }
      // focus was elsewhere (e.g. a toolbar button): hand this key straight to the walker too
      tourFocus();
      if (wk) wk.onKey(e);
    });
    if (location.hash === '#tur') setTour(true);
    window.addEventListener('hashchange', () => setTour(location.hash === '#tur'));
  }

  /* ---------------- 3D SALON: the gym's photoreal 3D model, walked like a game ----------------
     model/gym3d.js: walls, floor and ceiling are the gym's own photos, the equipment is 3D. Same keys as the 360° tour,
     plus click / tap the floor to walk there and a menu that jumps to the main areas. Built like the tour overlay:
     its own history entry (Back / Escape / ✕ close it), the page behind is inert, focus comes back to the opener. */
  const s3 = document.getElementById('salon3d'), s3Stage = s3 ? $('.tour-walk', s3) : null;
  const s3Go = s3 ? $('.tour-go', s3) : null, s3Fs = s3 ? $('.tour-fs', s3) : null;
  const s3PlBtn = s3 ? $('.s3d-pl-btn', s3) : null, s3PlList = s3 ? $('.s3d-pl-list', s3) : null;
  let s3Open = false, s3Ready = false, s3Live = false, s3Back = null, s3Pushed = false, s3Place = '';
  let gv = null, gvLoading = null, s3Pos = null, s3DropT = 0;
  const S3_V = '2', S3_DATA = '1';   // the viewer module / the model data (cache busting)
  function loadGym() {
    if (gvLoading) return gvLoading;
    const pc = $('.s3d-pc', s3), mpc = $('.s3d-mpc', s3);
    // the start card's backdrop: only now (an image in a hidden fixed overlay would load with the page)
    const bg = $('.tour-start>img[data-src]', s3);
    if (bg && !bg.getAttribute('src')) bg.src = bg.dataset.src;
    if (pc) pc.textContent = '%0';
    // the three.js add-ons need import maps (Safari 16.4+); older browsers get the 360° tour link instead
    const maps = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'));
    let me = null;
    const p = gvLoading = (maps ? import('./model/gym3d.js?v=' + S3_V) : Promise.reject(new Error('import maps')))
      .then(({ Gym3D, drawMap }) => {
        if (gvLoading !== p) return null;
        const map = $('.tour-map', s3), mctx = map.getContext('2d');
        me = gv = new Gym3D(s3Stage, {
          // out of the Tab order until the walk starts (keys must not move the view behind the start card)
          tabIndex: s3Live ? 0 : -1,
          start: s3Pos,
          onProgress: (q) => { if (pc && gv === me) pc.textContent = '%' + Math.round(q * 100); },
          onModel: (q) => {
            if (gv !== me) return;
            s3.classList.toggle('s3d-loading', q < 1);
            if (mpc) mpc.textContent = '%' + Math.round(q * 100);
          },
          onFrame: (st) => {
            if (!s3Live || gv !== me) return;
            s3Pos = { x: st.x, z: st.z, yaw: st.yaw };
            drawMap(mctx, map.width / 200, st);
            if (st.place !== s3Place) s3SetPlace(st.place);
          },
        });
        gv.canvas.addEventListener('focus', s3Sync);
        gv.canvas.addEventListener('blur', () => setTimeout(s3Sync, 0));
        if (!s3Open) gv.pause();
        return gv.load('model/?v=' + S3_DATA).then(() => true);
      })
      .then((ok) => {
        if (!ok || gv !== me) return;
        s3Ready = true;
        s3.classList.add('ready');
        if (s3Go) { s3Go.disabled = false; if (s3Open && !s3Live) s3Go.focus({ preventScroll: true }); }
      })
      .catch((err) => {
        if (gvLoading !== p || (me && me !== gv)) return;    // a viewer that was let go of meanwhile
        s3.classList.add('fail');
        if (window.console) console.warn('3D salon:', err && err.message ? err.message : err);
      });
    return gvLoading;
  }
  // let go of the viewer (its WebGL context, ~150 MB of GPU memory on a phone, and its data); the next open builds a new
  // one from the HTTP cache and starts where the walker was
  function s3Drop() {
    clearTimeout(s3DropT);
    if (!gv || s3Open) return;
    gv.destroy();
    gv = null; gvLoading = null; s3Ready = false; s3Live = false;
    s3.classList.remove('ready', 'live', 'fail', 's3d-loading', 'away');
    if (s3Go) s3Go.disabled = true;
  }
  // phones and low-memory devices: drop the viewer a while after it was closed
  const s3Light = () => !!gv && (gv.tier === 'lo' || isTouch);
  // the 360° tour opens: one WebGL context at a time on phones (after the closing animation)
  document.addEventListener('da:tour-open', () => {
    if (!gv || s3Open || !s3Light()) return;
    clearTimeout(s3DropT);
    s3DropT = setTimeout(s3Drop, 1000);
  });
  function s3SetPlace(id) {
    s3Place = id || '';
    const b = s3PlList && $('[data-place="' + s3Place + '"]', s3PlList);
    if (b) $('.s3d-pl-cur', s3).textContent = b.textContent;
    if (s3PlList) $$('button', s3PlList).forEach((x) => x.setAttribute('aria-current', x === b ? 'true' : 'false'));
  }
  function s3Sync() {
    if (s3) s3.classList.toggle('away', s3Open && s3Live && !!gv && document.activeElement !== gv.canvas && !s3Menu());
  }
  const s3Cred = s3 ? $('.s3d-cred', s3) : null;
  function s3Focus() {
    if (!gv || !s3Live || !s3Open) return;
    if (s3Cred) s3Cred.open = false;     // back to walking: the credits panel would sit over the view
    gv.focus();
    setTimeout(s3Sync, 0);
  }
  function s3Start() {
    if (!s3Ready || s3Live) return;
    s3Live = true;
    s3.classList.add('live');
    if (gv) { gv.canvas.tabIndex = 0; gv.resume(); }    // draws a frame now, so the minimap and the place name show at once
    s3Focus();
  }
  const s3Menu = () => !!s3PlList && !s3PlList.hidden;
  function s3SetMenu(open, focusFirst) {
    if (!s3PlList || s3Menu() === open) return;
    s3PlList.hidden = !open;
    s3PlBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && s3Cred) s3Cred.open = false;
    if (open && focusFirst) { const b = $('[aria-current="true"]', s3PlList) || $('button', s3PlList); if (b) b.focus({ preventScroll: true }); }
    s3Sync();
  }
  function setSalon(open, swap) {
    if (!s3 || open === s3Open) return;
    s3Open = open;
    if (open) {
      if (menuOpen) setMenu(false);
      s3Back = document.activeElement;
      // a link in the (now closing) burger menu hands focus back to the burger
      if (!s3Back || s3Back === document.body || (s3Back.closest && s3Back.closest('.menu'))) s3Back = $('.burger');
      clearTimeout(s3DropT);
      loadGym();
      if (gv) gv.resume();
      s3.removeAttribute('inert');
      s3.setAttribute('aria-hidden', 'false');
      s3.classList.add('open');
      html.classList.add('tour-on');
      [...s3.parentElement.children].forEach((el) => { if (el !== s3) el.inert = true; });
      sm.anim = null; sm.run = false;
      setTimeout(() => {
        if (!s3Open) return;
        if (s3Live) s3Focus();
        else (s3Go && !s3Go.disabled ? s3Go : $('.tour-x', s3)).focus({ preventScroll: true });
      }, 80);
      if (location.hash !== '#salon3d') { history.pushState({ salon: 1 }, '', '#salon3d'); s3Pushed = true; }
    } else {
      if (document.fullscreenElement === s3 && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      s3SetMenu(false);
      if (gv) gv.pause();       // stops drawing and loading (nothing runs behind the page)
      // phones: let go of the viewer when handing over to the 360° tour (one WebGL context at a time), else after a while
      clearTimeout(s3DropT);
      if (s3Light()) s3DropT = setTimeout(s3Drop, swap ? 1100 : 45000);
      s3.classList.remove('open');
      s3.setAttribute('aria-hidden', 'true');
      s3.setAttribute('inert', '');
      html.classList.remove('tour-on');
      [...s3.parentElement.children].forEach((el) => { if (el !== s3) el.inert = (el.classList.contains('ovl') || el.classList.contains('tour')) && !el.classList.contains('open'); });
      if (swap) history.replaceState({ tour: 1 }, '', swap);
      else if (location.hash === '#salon3d') {
        if (s3Pushed) history.back();
        else history.replaceState(null, '', location.pathname + location.search);
      }
      s3Pushed = false;
      if (!swap && s3Back && s3Back.focus) s3Back.focus({ preventScroll: true });
    }
    s3Sync();
  }
  // from the 360° tour to the 3D salon and back: one overlay hands over to the other on the same history entry
  function swapOverlay(to) {
    if (to === '#salon3d' && tourOpen) {
      const pushed = tourPushed, back = tourBack;
      setTour(false, '#salon3d');
      setSalon(true);
      s3Pushed = pushed; s3Back = back;
    } else if (to === '#tur' && s3Open) {
      const pushed = s3Pushed, back = s3Back;
      setSalon(false, '#tur');
      setTour(true);
      tourPushed = pushed; tourBack = back;
    }
  }
  if (s3) {
    $('.tour-x', s3).addEventListener('click', () => setSalon(false));
    if (s3Go) s3Go.addEventListener('click', s3Start);
    $('.tour-hint', s3).addEventListener('click', s3Focus);
    $$('.tour-dpad button', s3).forEach((btn) => {
      const d = btn.dataset.d;
      const on = (e) => { e.preventDefault(); if (gv && s3Live) gv.press(d, true); };
      const off = () => { if (gv) gv.press(d, false); };
      btn.addEventListener('pointerdown', on);
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, off));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    if (s3PlBtn) {
      s3PlBtn.addEventListener('click', (e) => s3SetMenu(!s3Menu(), e.detail === 0));
      // menu button: ↓ / ↑ open the list on the current (or the first / last) place
      s3PlBtn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault(); e.stopPropagation();
        s3SetMenu(true);
        const bs = $$('button', s3PlList);
        (bs.find((x) => x.getAttribute('aria-current') === 'true') || (e.key === 'ArrowDown' ? bs[0] : bs[bs.length - 1])).focus({ preventScroll: true });
      });
      $$('button', s3PlList).forEach((b) => b.addEventListener('click', () => {
        s3SetMenu(false);
        if (gv && s3Live && gv.teleport(b.dataset.place)) s3SetPlace(b.dataset.place);
        s3Focus();
      }));
      // arrow keys move through the list; Tab out or a click elsewhere closes it
      s3PlList.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault(); e.stopPropagation();
        const bs = $$('button', s3PlList), i = bs.indexOf(document.activeElement);
        bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length].focus({ preventScroll: true });
      });
      s3.addEventListener('focusout', (e) => { if (s3Menu() && e.relatedTarget && !e.relatedTarget.closest('.s3d-places')) s3SetMenu(false); });
    }
    // a tap on the view while the places list or the credits are open only closes them (it does not walk there too)
    s3.addEventListener('pointerdown', (e) => {
      let used = false;
      if (s3Menu() && !e.target.closest('.s3d-places')) { s3SetMenu(false); used = true; }
      if (s3Cred && s3Cred.open && !e.target.closest('.s3d-cred')) { s3Cred.open = false; used = true; }
      if (used && gv && e.target === gv.canvas) gv.skipTap = true;
    }, true);   // capture: before the viewer takes focus (which would close the list first) and reads the tap
    if (s3Fs) {
      if (!document.fullscreenEnabled || !s3.requestFullscreen) s3Fs.hidden = true;
      s3Fs.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else s3.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', () => {
        const fs = document.fullscreenElement === s3;
        s3Fs.setAttribute('aria-pressed', fs ? 'true' : 'false');
        s3Fs.setAttribute('aria-label', fs ? 'Tam ekrandan çık' : 'Tam ekran');
        setTimeout(s3Focus, 60);
      });
    }
    document.addEventListener('keydown', (e) => {
      if (!s3Open) return;
      if (e.key === 'Escape') {
        if (s3Menu()) { s3SetMenu(false); s3PlBtn.focus({ preventScroll: true }); return; }
        setSalon(false); return;
      }
      if (!walkKey(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (gv && document.activeElement === gv.canvas) return;   // the viewer handles it
      if (s3Menu() && /^Arrow(Up|Down)$/.test(e.key)) return;   // moving through the places list
      if (document.activeElement === s3PlBtn && /^Arrow(Up|Down)$/.test(e.key)) return;   // opens the list
      e.preventDefault();
      if (!s3Live) { s3Start(); return; }
      s3SetMenu(false);
      s3Focus();
      if (gv) gv.onKey(e);
    });
    if (location.hash === '#salon3d') setSalon(true);
    window.addEventListener('hashchange', () => setSalon(location.hash === '#salon3d'));
  }

  /* ---------------- weekly timetable (#program) and class details (#ders-<slug>) ----------------
     Full-screen panels filled from data/program.json (taken from deepacademia.com.tr). Each one opens with its
     own history entry, so the phone's Back button, Escape and ✕ all close it; a class opened from the
     timetable goes back to the timetable. */
  const cal = document.getElementById('program'), dz = document.getElementById('ders');
  const DAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
  const SHORT = ['PZT', 'SAL', 'ÇAR', 'PER', 'CUM', 'CMT', 'PAZ'];
  const PALETTE = ['#D6FB00', '#FF7A1A', '#3EE0FF', '#FF4FA3', '#A57CFF', '#FFD23F', '#4BE38A', '#FF5A5A'];
  let prog = null, progLoading = null, afterClose = null, skipRestore = false, calFilter = 'all', calDay = -1;
  // who opened each panel (one per open panel), so closing one puts focus back where the user was
  const openers = [];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isOpen = (el) => !!el && el.classList.contains('open');
  function ovlOpen() { return isOpen(cal) || isOpen(dz); }
  function isPanelRoute(h) { return h === '#program' || /^#ders-[a-z0-9-]+$/.test(h || ''); }
  const todayIdx = () => (new Date().getDay() + 6) % 7;
  const colorOf = (slug) => {
    const i = prog && prog.order ? prog.order.indexOf(slug) : -1;
    return PALETTE[(i < 0 ? PALETTE.length - 1 : i) % PALETTE.length];
  };
  // a session can belong to more than one class (e.g. "Step & Fat Burn")
  const slugsOf = (s) => s.slugs || (s.slug ? [s.slug] : []);
  const byTime = (a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start);
  const timeOf = (s) => esc(s.start) + (s.end ? ' – ' + esc(s.end) : '');
  const ARR = '<svg class="arr" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';

  function ensureData() {
    if (progLoading) return progLoading;
    progLoading = fetch('data/program.json?v=1')
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((d) => { prog = d; renderTeaser(); renderCal(); if (isOpen(dz)) renderClass(dz.dataset.slug); })
      .catch(() => { [cal, dz].forEach((el) => el && el.classList.add('fail')); });
    return progLoading;
  }

  // the weekly teaser on the page: written into the HTML for first paint, refreshed here from the same data
  function renderTeaser() {
    const g = $('#takvim .sched-grid');
    if (!g || !prog) return;
    g.innerHTML = DAYS.map((d) => {
      const list = prog.sessions.filter((s) => s.day === d).sort(byTime);
      return list.length ? '<div class="day"><span class="dn">' + d + '</span>' + list.map((s) => '<span class="dl"><span class="dt">' + esc(s.start) + '</span><span class="dc">' + esc(s.name) + '</span></span>').join('') + '</div>' : '';
    }).join('');
  }
  function renderCal() {
    if (!prog || !cal || cal.dataset.done) return;
    cal.dataset.done = '1';
    const days = DAYS.map((d, i) => ({ d, i, list: prog.sessions.filter((s) => s.day === d).sort(byTime) })).filter((x) => x.list.length);
    const slugs = (prog.order || []).filter((sl) => prog.sessions.some((s) => slugsOf(s).includes(sl)));
    prog.sessions.forEach((s) => slugsOf(s).forEach((sl) => { if (!slugs.includes(sl)) slugs.push(sl); }));
    const nameOf = (sl) => (prog.classes[sl] && prog.classes[sl].title) || sl;
    const t = todayIdx();
    calDay = days.some((x) => x.i === t) ? t : (days.find((x) => x.i > t) || days[0] || { i: -1 }).i;
    const ses = (s) => {
      const inner = '<span class="ses-t">' + timeOf(s) + '</span><span class="ses-n" lang="en">' + esc(s.name) + '</span>' +
        ((s.trainer || s.place) ? '<span class="ses-m">' + esc([s.trainer, s.place].filter(Boolean).join(' · ')) + '</span>' : '');
      const own = slugsOf(s), main = (s.link && prog.classes[s.link]) ? s.link : own.find((sl) => prog.classes[sl]);
      const st = ' style="--c:' + colorOf(own[0]) + '" data-slugs="' + esc(own.join(' ')) + '"';
      return main
        ? '<a class="ses" href="#ders-' + esc(main) + '"' + st + ' aria-label="' + esc(s.day + ' ' + s.start + ', ' + s.name + ': ders içeriği') + '">' + inner + '</a>'
        : '<div class="ses"' + st + '>' + inner + '</div>';
    };
    $('.ovl-in', cal).innerHTML =
      '<div class="cal-head"><div><div class="ovl-eyebrow">HAFTALIK GRUP DERSLERİ</div><h2 class="ovl-h" id="cal-h" tabindex="-1">DERS PROGRAMI</h2></div>' +
      (prog.intro ? '<p class="cal-lead">' + esc(prog.intro) + '</p>' : '') + '</div>' +
      '<div class="cal-filters" role="group" aria-label="Derse göre süz"><button class="chip" type="button" data-f="all" aria-pressed="true">Tümü</button>' +
      slugs.map((sl) => '<button class="chip" type="button" data-f="' + esc(sl) + '" aria-pressed="false" style="--c:' + colorOf(sl) + '"><i></i><span lang="en">' + esc(nameOf(sl)) + '</span></button>').join('') + '</div>' +
      '<div class="cal-tabs" role="group" aria-label="Gün seç">' +
      days.map((x) => '<button class="cal-tab" type="button" data-day="' + x.i + '" aria-pressed="' + (x.i === calDay) + '"><b>' + SHORT[x.i] + '</b><small>' + (x.i === t ? 'BUGÜN' : x.list.length + ' DERS') + '</small></button>').join('') + '</div>' +
      '<div class="cal-week" style="--n:' + Math.max(1, days.length) + '">' +
      days.map((x) => '<section class="cal-day' + (x.i === t ? ' today' : '') + (x.i === calDay ? ' sel' : '') + '" data-day="' + x.i + '" aria-label="' + x.d + '">' +
        '<div class="cal-dh"><b>' + x.d + '</b>' + (x.i === t ? '<em>BUGÜN</em>' : '') + '</div>' +
        x.list.map(ses).join('') + '<div class="cal-none">Bu gün bu ders yok.</div></section>').join('') + '</div>' +
      '<div class="cal-foot"><span>' + esc(prog.note || '') + (prog.source ? ' Kaynak: <a class="src" href="' + esc(prog.source) + '" target="_blank" rel="noopener">deepacademia.com.tr/takvim</a>' : '') + '</span>' +
      '<a class="btn btn-lime" href="#kayit" style="padding: 16px 28px; border-radius: 40px; font-size: 13px; font-weight: 700; letter-spacing: .14em">KAYIT OL ' + ARR + '</a></div>';
    $$('.cal-filters .chip', cal).forEach((b) => b.addEventListener('click', () => { calFilter = b.dataset.f; applyCal(); }));
    $$('.cal-tab', cal).forEach((b) => b.addEventListener('click', () => { calDay = +b.dataset.day; applyCal(); }));
    applyCal();
  }
  function applyCal() {
    $$('.cal-filters .chip', cal).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === calFilter)));
    $$('.cal-tab', cal).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.day === calDay)));
    $$('.cal-day', cal).forEach((d) => {
      let shown = 0;
      $$('.ses', d).forEach((s) => { const on = calFilter === 'all' || s.dataset.slugs.split(' ').includes(calFilter); s.hidden = !on; if (on) shown++; });
      d.classList.toggle('empty', !shown);
      d.dataset.shown = String(shown);
    });
    // phones: the day tabs follow the filter, and jump to a day that has the chosen class
    const counts = {};
    $$('.cal-day', cal).forEach((d) => { counts[d.dataset.day] = +d.dataset.shown; });
    if (calFilter !== 'all' && !counts[calDay]) { const first = Object.keys(counts).find((k) => counts[k]); if (first !== undefined) calDay = +first; }
    const t = todayIdx();
    $$('.cal-tab', cal).forEach((b) => {
      const n = counts[b.dataset.day] || 0;
      $('small', b).textContent = +b.dataset.day === t ? 'BUGÜN' : n ? n + ' DERS' : '—';
      b.classList.toggle('none', !n);
      b.setAttribute('aria-pressed', String(+b.dataset.day === calDay));
    });
    $$('.cal-day', cal).forEach((d) => d.classList.toggle('sel', +d.dataset.day === calDay));
  }

  function renderClass(slug) {
    if (!dz) return;
    dz.dataset.slug = slug;
    const box = $('.ovl-in', dz);
    const hid = '<h2 class="ovl-h" id="dz-h" tabindex="-1" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">Ders içeriği</h2>';
    if (!prog) { box.innerHTML = hid + '<div class="ovl-load">Yükleniyor…</div><p class="ovl-fail">Ders içeriği yüklenemedi. <a href="https://www.deepacademia.com.tr/derslerimiz/" target="_blank" rel="noopener">deepacademia.com.tr/derslerimiz</a> sayfasına bakabilirsiniz.</p>'; return; }
    const c = prog.classes[slug];
    if (!c) { box.innerHTML = hid + '<p class="dz-none">Bu ders bulunamadı.</p>'; return; }
    const times = prog.sessions.filter((s) => slugsOf(s).includes(slug)).sort(byTime);
    const col = colorOf(slug);
    box.innerHTML =
      '<article class="dz-art">' +
      '<figure class="dz-media">' + (c.img ? '<img src="' + esc(c.img) + '" alt="' + esc(c.imgAlt || c.title) + '">' : '') + '</figure>' +
      '<div class="dz-text">' +
      (c.tag ? '<span class="ctag" style="color:' + col + '">' + esc(c.tag) + '</span>' : '') +
      '<h2 class="ovl-h" id="dz-h" lang="en" tabindex="-1">' + esc(c.title) + '</h2>' +
      (c.tagline ? '<p class="dz-tagline">' + esc(c.tagline) + '</p>' : '') +
      (c.paragraphs || []).map((t) => '<p class="dz-p">' + esc(t) + '</p>').join('') +
      ((c.benefits || []).length ? '<h3 class="dz-sh">Öne çıkanlar</h3><ol class="dz-ben">' + c.benefits.map((it) => '<li>' + esc(it) + '</li>').join('') + '</ol>' : '') +
      '<h3 class="dz-sh">Haftalık ders saatleri</h3>' +
      (times.length
        ? '<ul class="dz-times">' + times.map((s) => '<li style="--c:' + col + '"><span class="d">' + esc(s.day) + '</span><span class="t">' + timeOf(s) + '</span>' + '<span class="w">' + esc([slugsOf(s).length > 1 ? s.name : '', s.trainer, s.place].filter(Boolean).join(' · ')) + '</span></li>').join('') + '</ul>'
        : '<p class="dz-none">Bu ders şu an haftalık programda yer almıyor. Güncel saatler için bizi arayın: <a class="f-link" href="tel:+905449403729">0544 940 37 29</a></p>') +
      '<div class="dz-ctas"><a class="btn btn-lime" href="#program">TÜM PROGRAM ' + ARR + '</a><a class="btn btn-ghost" href="#kayit">KAYIT OL</a></div>' +
      ((c.faq || []).length ? '<h3 class="dz-sh">Sıkça sorulan sorular</h3><div class="dz-faq">' + c.faq.map((f) => '<details><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>').join('') + '</div>' : '') +
      '</div></article>' +
      '<nav class="dz-more" aria-label="Diğer dersler"><h3 class="dz-sh" style="margin-top:0">Diğer dersler</h3><div class="dz-chips">' +
      (prog.order || Object.keys(prog.classes)).filter((sl) => prog.classes[sl]).map((sl) => '<a class="chip" href="#ders-' + esc(sl) + '" style="--c:' + colorOf(sl) + '"' + (sl === slug ? ' aria-current="page"' : '') + '><i></i><span lang="en">' + esc(prog.classes[sl].title) + '</span></a>').join('') +
      '</div></nav>';
    $('.ovl-body', dz).scrollTop = 0;
  }

  function showPanel(el, on) {
    if (!el || isOpen(el) === on) return;
    el.classList.toggle('open', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
    // a fresh open starts at the top (returning to the timetable from a class keeps its place: it never closed)
    if (on) { el.removeAttribute('inert'); $('.ovl-body', el).scrollTop = 0; if (menuOpen) setMenu(false); ensureData(); } else el.setAttribute('inert', '');
  }
  function route() {
    const h = location.hash || '';
    const m = /^#ders-([a-z0-9-]+)$/.exec(h);
    const wasOpen = ovlOpen(), prevTop = isOpen(dz) ? dz : isOpen(cal) ? cal : null;
    if (h === '#program') { showPanel(cal, true); showPanel(dz, false); renderCal(); }
    else if (m) { if (dz.dataset.slug !== m[1] || !dz.dataset.slug || !$('.dz-art', dz)) renderClass(m[1]); showPanel(dz, true); }
    else { showPanel(dz, false); showPanel(cal, false); }
    const open = ovlOpen(), topEl = isOpen(dz) ? dz : isOpen(cal) ? cal : null;
    html.classList.toggle('ovl-on', open);
    if (cal) cal.inert = !isOpen(cal) || topEl === dz;
    // the page behind is inert while a panel is open (only on a change: the tour manages it while it is open)
    if (open !== wasOpen) {
      [...(cal || dz).parentElement.children].forEach((el) => {
        if (el === cal || el === dz || el === tour || el === s3) return;
        el.inert = open;
      });
    }
    const head = (el) => el && $('.ovl-h[tabindex]', el);
    const usable = (el) => el && el.isConnected && el.focus && !el.closest('[inert],[aria-hidden="true"]');
    if (open) {
      sm.anim = null; sm.run = false;
      if (prevTop === dz && topEl === cal) {
        // back from a class to the timetable: to the card that opened it
        const o = openers.pop();
        const f = usable(o) && cal.contains(o) ? o : head(cal);
        if (f) f.focus({ preventScroll: true });
      } else if (topEl !== prevTop || !topEl.contains(document.activeElement) || document.activeElement === document.body) {
        const el = topEl;
        setTimeout(() => { const f = head(el); if (f && isOpen(el)) f.focus({ preventScroll: true }); }, wasOpen ? 0 : 60);
      }
    } else if (wasOpen) {
      const o = openers[0];
      openers.length = 0;
      if (skipRestore) skipRestore = false;
      else if (usable(o)) o.focus({ preventScroll: true });
    }
  }
  function openRoute(h) {
    if (location.hash === h) { route(); return; }
    const depth = (history.state && history.state.ovl) || 0;
    // one class to another inside the details panel: replace, so ✕ / Back still close in one step
    if (/^#ders-/.test(location.hash) && /^#ders-/.test(h) && depth) history.replaceState({ ovl: depth }, '', h);
    else {
      // the opener; a link in the (now closing) burger menu hands focus back to the burger
      let o = document.activeElement;
      if (!o || o === document.body || o.closest('.menu,[aria-hidden="true"]')) o = $('.burger');
      openers.push(o);
      history.pushState({ ovl: depth + 1 }, '', h);
    }
    route();
  }
  function closeTop() {
    if (history.state && history.state.ovl) { history.back(); return; }
    // opened straight from a link to this address: there is nothing to go back to
    history.replaceState(null, '', isOpen(dz) && isOpen(cal) ? '#program' : location.pathname + location.search);
    route();
  }
  function closePanels(then) {
    const n = (history.state && history.state.ovl) || 0;
    if (then) skipRestore = true;       // focus goes to where the link leads, not back to the opener
    if (n) { afterClose = then || null; history.go(-n); return; }
    history.replaceState(null, '', location.pathname + location.search);
    route();
    if (then) setTimeout(then, 0);
  }
  if (cal && dz) {
    $$('.ovl-x', cal).concat($$('.ovl-x', dz)).forEach((b) => b.addEventListener('click', closeTop));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ovlOpen() && !tourOpen && !s3Open) { e.preventDefault(); closeTop(); } });
    const onNav = () => {
      route();
      if (!ovlOpen() && afterClose) { const f = afterClose; afterClose = null; setTimeout(f, 0); }
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    if (isPanelRoute(location.hash)) route();
    // fetch the data once the page is idle, so the first open is instant
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 2500));
    window.addEventListener('load', () => idle(() => ensureData()));
  }

  measure(); if (E.live) dalSetup(); tick();
  const ready = () => { measure(); tick(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready); else window.addEventListener('load', ready);
  window.addEventListener('load', () => { measure(); tick(); });
})();
