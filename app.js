/* Deep Academia Fitness Center — site interactions (no dependencies) */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const html = document.documentElement;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cl = (x) => Math.max(0, Math.min(1, x));

  /* ---------------- hero: Phive-style ribbon slideshow ---------------- */
  const bgs = $$('.hero .bg'), cts = $$('.hero .ct'), rbs = $$('.hero .rb'), buls = $$('.hero .bul');
  const hs = { cur: 0, leave: -1, phase: 'band', first: true, run: false, done: -1 };
  let ht = [];
  const at = (ms, fn) => ht.push(setTimeout(fn, ms));
  const clearAll = () => { ht.forEach(clearTimeout); ht = []; };
  function heroApply() {
    const state = (i) => i === hs.cur
      ? ' cur' + (hs.phase === 'open' ? ' open' : ' band') + (hs.first ? ' first' : '')
      : (i === hs.leave ? ' leave' : '');
    bgs.forEach((e, i) => { e.className = 'bg' + state(i); });
    cts.forEach((e, i) => { e.className = 'ct' + state(i); });
    rbs.forEach((e, i) => { e.className = 'rb' + state(i); });
    buls.forEach((e, i) => { e.className = 'bul' + (i === hs.cur && hs.run ? ' run' : '') + (i === hs.done ? ' done' : ''); });
  }
  function heroSet(p) { Object.assign(hs, p); heroApply(); }
  function heroNext(i) {
    const n = i === undefined ? (hs.cur + 1) % bgs.length : i;
    if (n === hs.cur) return;
    clearAll();
    heroSet({ leave: hs.cur, cur: n, phase: 'band', first: false, run: false, done: hs.cur });
    at(1000, () => heroSet({ leave: -1, run: true, done: -1 }));
    at(3500, () => heroSet({ phase: 'open' }));
    at(11000, () => heroNext());
  }
  if (bgs.length) {
    heroApply();
    at(2000, () => heroSet({ run: true }));
    at(4500, () => heroSet({ phase: 'open', first: false }));
    at(12000, () => heroNext());
    buls.forEach((b, i) => b.addEventListener('click', () => heroNext(i)));
  }

  /* ribbon letters: .first chars squash down while .last chars grow (stagger .1s, expo.inOut 2s, yoyo) */
  function flip() {
    if (reduce) return;
    const ex = 'cubic-bezier(0.87, 0, 0.13, 1)';
    $$('.rb-title').forEach((t) => {
      if (t.dataset.flip === '1') return;
      const fa = $$('.fa .c', t), fb = $$('.fb .c', t);
      if (!fa.length || !fa[0].animate) return;
      t.dataset.flip = '1';
      const vis = [];
      fa.forEach((el, i) => { if (el.textContent.trim() !== '') vis.push(i); });
      const n = vis.length, T = 2 + (n - 1) * 0.1, D = 2 * T;
      vis.forEach((idx, j) => {
        const s = 0.1 * j;
        const k = [s / D, (s + 2) / D, (D - s - 2) / D, (D - s) / D].map((v) => Math.min(1, Math.max(0, v)));
        for (let q = 1; q < 4; q++) k[q] = Math.max(k[q], k[q - 1]);
        const mk = (a, b) => [
          { transform: 'scaleY(' + a + ')', offset: 0 },
          { transform: 'scaleY(' + a + ')', offset: k[0], easing: ex },
          { transform: 'scaleY(' + b + ')', offset: k[1] },
          { transform: 'scaleY(' + b + ')', offset: k[2], easing: ex },
          { transform: 'scaleY(' + a + ')', offset: k[3] },
          { transform: 'scaleY(' + a + ')', offset: 1 }
        ];
        fa[idx].animate(mk(1, 0), { duration: D * 1000, iterations: Infinity });
        fb[idx].animate(mk(0, 1), { duration: D * 1000, iterations: Infinity });
      });
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

  /* ---------------- scroll engine (ScrollTrigger + Lenis equivalents) ---------------- */
  const E = { V: 900, s1: 2.5, mdNow: 0 };
  const set = (k, v) => html.style.setProperty(k, String(Math.round(v * 10000) / 10000));
  const top = (el) => el.getBoundingClientRect().top + window.scrollY;
  const live = () => {
    const se = document.scrollingElement || html;
    return !reduce && se.scrollHeight > window.innerHeight + 4;
  };
  function measure() {
    const V = window.innerHeight;
    E.V = V;
    html.style.setProperty('--V', V + 'px');
    const sv = $('.bd-svg');
    if (sv) {
      let ux = 1000, uy = 560;
      try {
        const t = $('.bd-dal', sv);
        const exr = t && t.getExtentOfChar ? t.getExtentOfChar(2) : null;
        if (exr && exr.width > 0) { ux = exr.x + exr.width * 0.32; uy = exr.y + exr.height * 0.55; }
      } catch (err) { /* estimate */ }
      const W = sv.clientWidth, H = sv.clientHeight, k = Math.min(W / 1440, H / 900);
      html.style.setProperty('--mox', ((W - 1440 * k) / 2 + ux * k) + 'px');
      html.style.setProperty('--moy', ((H - 900 * k) / 2 + uy * k) + 'px');
    }
  }
  function tick() {
    if (!live()) {
      const V = E.V;
      [['--pg', 0], ['--pc', 1], ['--cl', 0.12], ['--cs', 0.12], ['--bd', 0.6], ['--dly', 0], ['--d1y', -V * 0.3], ['--d1s', 0.5], ['--d1o', 1], ['--mz', 1], ['--dz', 0], ['--cp1', 0.3], ['--cp2', 0.3], ['--cp3', 0.3], ['--cp4', 0.3]].forEach(([k, v]) => set(k, v));
      html.dataset.cl = 'in'; html.dataset.cta = 'in'; html.dataset.ig = 'in';
      return;
    }
    const V = E.V, y = window.scrollY;
    const club = document.getElementById('kulup');
    if (club) {
      const t = top(club), H = club.offsetHeight;
      set('--cl', cl((y - t + V) / H));
      const an = $('.cl-anim', club);
      if (an && an.getBoundingClientRect().top < V / 2) html.dataset.cl = 'in';
      const pw = $('.pg-wrap', club);
      if (pw) {
        const p = cl((y - top(pw) + V) / pw.offsetHeight);
        set('--pg', p);
        set('--pc', cl((p - 0.75) / 0.15));
        if (p > 0.5) html.dataset.cta = 'in';
      }
    }
    const bold = $('.bold');
    if (bold) {
      const bd = (y - top(bold)) / V;
      const e1 = 1 - Math.pow(1 - cl(bd), 3);
      const a2 = cl((bd - 1.3) / 2.3);
      set('--bd', bd);
      set('--dly', 700 * (1 - e1));
      set('--d1y', -V * 0.34 * e1);
      set('--d1s', 1 - 0.5 * e1);
      set('--d1o', 1 - cl((bd - 1.3) / 0.4));
      set('--mz', 1 + 79 * a2 * a2 * a2);
      set('--dz', a2);
      E.mdNow = a2 > 0.6 ? 1 : 0;
    }
    const cls = document.getElementById('dersler');
    if (cls) {
      const t = top(cls), H = cls.offsetHeight;
      set('--cs', cl((y - t + V) / H));
      const grid = $('.cls-grid', cls);
      const gb = grid ? top(grid) + grid.offsetHeight : t + H;
      $$('.cc', cls).forEach((c, i) => {
        const st = top(c) - V;
        set('--cp' + (i + 1), cl((y - st) / Math.max(1, gb - st)));
      });
    }
    const ig = $('.ig-grid');
    if (ig && ig.getBoundingClientRect().top < V) html.dataset.ig = 'in';
    const probe = V - 50;
    let dark = false;
    $$('[data-int]').forEach((s) => {
      const r = s.getBoundingClientRect();
      if (r.top <= probe && r.bottom >= probe) dark = !(s.classList.contains('bold') && E.mdNow > 0.5);
    });
    html.dataset.pill = dark ? 'dark' : 'light';
    html.dataset.hdr = y > V * 0.8 ? 'hide' : 'show';
  }
  let raf = 0;
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; tick(); }); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { measure(); tick(); });

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
      if (e.ctrlKey || e.metaKey || menuOpen || !live()) return;
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
    const id = a.getAttribute('href').slice(1);
    const el = id ? document.getElementById(id) : null;
    if (!el) { if (a.getAttribute('href') === '#') e.preventDefault(); return; }
    e.preventDefault();
    if (reduce) { window.scrollTo(0, top(el)); return; }
    sm.anim = { from: window.scrollY, to: top(el), t0: performance.now(), dur: 1000 };
    if (!sm.run) { sm.run = true; sm.last = 0; requestAnimationFrame(step); }
  });

  measure(); tick();
  const ready = () => { measure(); tick(); flip(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(ready); else window.addEventListener('load', ready);
  window.addEventListener('load', () => { measure(); tick(); });
})();
