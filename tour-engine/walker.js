/* Deep Academia — panorama walker.
   Walk real 360° captures with the keyboard like a game character:
   ↑/W forward, ↓/S back, ←/→ (or Q/E) turn, A/D side-step; hold a key to keep going.
   Each capture point shows its photos at full quality; moving between points glides the camera from one
   photo cube/sphere to the next while crossfading, so it feels like walking.

   tour.json
   {
     "start": "p01", "startYaw": 0,
     "sizes": [1024, 2048],                       // cube face sizes on the server (smallest first)
     "nodes": [
       { "id": "p01",
         "cube": "cubes/p01/{size}/{face}.jpg",     // faces f r b l u d (see FACES below), or:
         "src": "panos/p01.jpg",                    // a 2:1 equirectangular photo instead
         "pos": [x, y, z],                          // metres, y up, forward/north = -Z (optional)
         "heading": 0,                              // radians: world yaw the front face / photo centre faces
         "links": ["p02"] }                         // optional; computed from positions when omitted
     ]
   }
   Without positions every link needs a direction: "links": [{ "to": "p02", "yaw": 1.57 }].

   Cube faces (canonical, as seen from inside): f = front, r = right, b = back, l = left — upright;
   u = looking up while facing front (front edge at the bottom of the image);
   d = looking down while facing front (front edge at the top of the image). */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

const R = 8;                 // metres: distance the photos are projected at (sphere radius / half cube size)
const LINK_MAX = 6;          // metres: farthest neighbour auto-linked from positions
const CONE = 0.75;           // radians (~43°): how far off-axis a step may go
const TURN_SPEED = 1.9;      // rad/s at full turn
const STEP_DIRS = ['fwd', 'back', 'left', 'right'];
const MOVE_KEYS = {
  ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back',
  KeyA: 'left', KeyD: 'right', ArrowLeft: 'turnL', ArrowRight: 'turnR', KeyQ: 'turnL', KeyE: 'turnR',
};
export const FACES = ['f', 'r', 'b', 'l', 'u', 'd'];
// BoxGeometry material slots: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. With heading 0 the front faces -Z.
// The box is seen from inside (BackSide), which mirrors every face: un-mirror, and turn u/d so their
// "front" edge meets the front face.
const SLOT = {
  f: { i: 5, rot: 0 }, r: { i: 0, rot: 0 }, b: { i: 4, rot: 0 }, l: { i: 1, rot: 0 },
  u: { i: 2, rot: Math.PI }, d: { i: 3, rot: Math.PI },
};

/* one projection surface (sphere for equirect photos, inside-out box for cube faces) */
class Pano {
  constructor(scene, order) {
    const sg = new THREE.SphereGeometry(R, 96, 64);
    sg.scale(-1, 1, 1);
    this.sphere = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
    this.box = new THREE.Mesh(new THREE.BoxGeometry(2 * R, 2 * R, 2 * R),
      Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false })));
    [this.sphere, this.box].forEach((m) => { m.renderOrder = order; m.visible = false; scene.add(m); });
    this.node = null;
  }
  set order(o) { this.sphere.renderOrder = o; this.box.renderOrder = o; }
  set opacity(v) {
    this.sphere.material.opacity = v;
    this.box.material.forEach((m) => { m.opacity = v; });
  }
  hide() { this.sphere.visible = false; this.box.visible = false; this.node = null; }
  show(n, tex) {
    this.node = n;
    const p = n.pos || new THREE.Vector3();
    if (tex.faces) {
      FACES.forEach((f, k) => {
        const m = this.box.material[SLOT[f].i];
        m.map = tex.faces[k];
        m.needsUpdate = true;
      });
      this.box.position.copy(p);
      this.box.rotation.y = n.heading;
      this.box.visible = true; this.sphere.visible = false;
    } else {
      this.sphere.material.map = tex.tex;
      this.sphere.material.needsUpdate = true;
      this.sphere.position.copy(p);
      // three.js maps the image centre to local -X (yaw 90°): turn it to face the node heading
      this.sphere.rotation.y = n.heading - Math.PI / 2;
      this.sphere.visible = true; this.box.visible = false;
    }
  }
  moveTo(p) { this.sphere.position.copy(p); this.box.position.copy(p); }
}

export class Walker {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0; this.turnVel = 0; this.fov = 75;
    this.cur = null; this.move = null; this.bump = 0; this.queued = null;
    this.cache = new Map(); this.loading = new Map();
    this.onChange = opts.onChange || (() => {});
    this.coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'wk-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Sanal tur: yön tuşlarıyla yürüyün');
    root.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.05, 100);
    this.camera.rotation.order = 'YXZ';
    this.A = new Pano(this.scene, 0);
    this.B = new Pano(this.scene, 1);

    this.maxTex = this.renderer.capabilities.maxTextureSize;
    this.aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.bind();
    this.resize();
    this.last = performance.now();
    this.idleSince = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------- data ---------- */
  async load(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('tour.json ' + res.status);
    return this.setData(await res.json(), new URL(url, location.href));
  }
  setData(data, base = new URL(location.href)) {
    this.base = base;
    const sizes = (data.sizes || [1024]).slice().sort((a, b) => a - b);
    // phones start every point at the small size and sharpen the one you stand on; desktops use the larger one
    const fit = (want) => sizes.filter((s) => s <= Math.min(want, this.maxTex)).pop() || sizes[0];
    this.lowSize = this.coarse ? fit(1024) : fit(2048);
    this.highSize = fit(2048);
    this.nodes = new Map();
    data.nodes.forEach((n) => this.nodes.set(n.id, { ...n, pos: n.pos ? new THREE.Vector3(...n.pos) : null, heading: n.heading || 0 }));
    this.hasPos = [...this.nodes.values()].every((n) => n.pos);
    this.nodes.forEach((n) => { n.edges = this.edgesOf(n); });
    const start = this.nodes.get(data.start) || this.nodes.values().next().value;
    if (typeof data.startYaw === 'number') this.yaw = data.startYaw;
    return this.goto(start.id, { instant: true });
  }
  edgesOf(n) {
    // each edge: { to, yaw (world bearing), dist }
    const out = [];
    const add = (id, yaw) => {
      const m = this.nodes.get(id);
      if (!m || m === n) return;
      if (this.hasPos) {
        const d = new THREE.Vector3().subVectors(m.pos, n.pos);
        out.push({ to: id, yaw: Math.atan2(-d.x, -d.z), dist: Math.hypot(d.x, d.z) });
      } else if (typeof yaw === 'number') out.push({ to: id, yaw, dist: 2.5 });
    };
    if (n.links && n.links.length) { n.links.forEach((l) => (typeof l === 'string' ? add(l) : add(l.to, l.yaw))); return out; }
    if (!this.hasPos) return out;
    this.nodes.forEach((m) => {
      if (m === n || Math.abs(m.pos.y - n.pos.y) > 1.2) return;
      if (Math.hypot(m.pos.x - n.pos.x, m.pos.z - n.pos.z) <= LINK_MAX) add(m.id);
    });
    // keep the nearest neighbour per ~30° sector so steps are short and natural
    out.sort((a, b) => a.dist - b.dist);
    const kept = [];
    out.forEach((e) => { if (!kept.some((k) => Math.abs(wrap(k.yaw - e.yaw)) < 0.5)) kept.push(e); });
    return kept;
  }

  /* ---------- textures ---------- */
  image(url, canvas, maxSide) {
    return new Promise((resolve, reject) => {
      const done = (source) => {
        const t = new THREE.Texture(source);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.aniso;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        resolve(t);
      };
      if (canvas) { done(canvas); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (img.naturalWidth <= maxSide) { done(img); return; }
        // GPU limit (phones): scale down instead of failing
        const c = document.createElement('canvas');
        const k = maxSide / img.naturalWidth;
        c.width = maxSide; c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        done(c);
      };
      img.onerror = () => reject(new Error('image ' + url));
      img.src = url;
    });
  }
  texture(id, size = this.lowSize) {
    const n = this.nodes.get(id);
    const key = id + '@' + (n.cube ? size : 'eq');
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.loading.has(key)) return this.loading.get(key);
    let p;
    if (n.cube || n.canvases) {
      p = Promise.all(FACES.map((f, k) => this.image(
        n.canvases ? null : new URL(n.cube.replace('{size}', size).replace('{face}', f), this.base).href,
        n.canvases ? n.canvases[k] : null, this.maxTex)))
        .then((faces) => {
          // the box shows faces from inside, which mirrors them: flip back, and turn u/d into place
          faces.forEach((t, k) => {
            const s = SLOT[FACES[k]];
            t.center.set(0.5, 0.5);
            t.repeat.set(-1, 1);
            t.wrapS = THREE.RepeatWrapping;
            t.rotation = s.rot;
          });
          return { faces, size };
        });
    } else {
      p = this.image(n.canvas ? null : new URL(n.src, this.base).href, n.canvas || null, this.maxTex).then((tex) => ({ tex }));
    }
    p = p.then((t) => { this.cache.set(key, t); this.loading.delete(key); this.trim(); return t; },
      (e) => { this.loading.delete(key); throw e; });
    this.loading.set(key, p);
    return p;
  }
  trim() {
    const keep = new Set();
    [this.cur, this.move && this.move.to].forEach((n) => { if (n) { keep.add(n.id + '@' + this.lowSize); keep.add(n.id + '@' + this.highSize); keep.add(n.id + '@eq'); } });
    if (this.cur) this.cur.edges.forEach((e) => { keep.add(e.to + '@' + this.lowSize); keep.add(e.to + '@eq'); });
    for (const [key, t] of this.cache) {
      if (this.cache.size <= 12) break;
      if (keep.has(key)) continue;
      (t.faces || [t.tex]).forEach((x) => x.dispose());
      this.cache.delete(key);
    }
  }
  preload(n) { n.edges.forEach((e) => this.texture(e.to).catch(() => {})); }
  // standing still: swap the current point to the sharper faces
  async sharpen() {
    const n = this.cur;
    if (!n || !n.cube || this.highSize === this.lowSize || this.sharpening === n.id) return;
    this.sharpening = n.id;
    try {
      const t = await this.texture(n.id, this.highSize);
      if (this.cur === n && !this.move && this.A.node === n) this.A.show(n, t);
    } catch (e) { /* keep the low size */ }
  }

  async goto(id, { instant = false } = {}) {
    const n = this.nodes.get(id);
    if (!n) return;
    const tex = await this.texture(id);
    if (instant || !this.cur) {
      this.cur = n;
      this.A.show(n, tex);
      this.A.opacity = 1;
      this.B.hide();
      this.camera.position.copy(n.pos || new THREE.Vector3());
      this.preload(n);
      this.onChange(n);
      this.idleSince = performance.now();
      return;
    }
    this.startMove(n, tex, null);
  }

  /* ---------- moving ---------- */
  pick(dir) {
    if (!this.cur) return null;
    const want = wrap(this.yaw + { fwd: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[dir]);
    let best = null, score = Infinity;
    this.cur.edges.forEach((e) => {
      const off = Math.abs(wrap(e.yaw - want));
      if (off > CONE) return;
      const s = e.dist * (1 + 2.2 * off);
      if (s < score) { score = s; best = e; }
    });
    return best;
  }
  async step(dir) {
    if (this.move || this.pending) return;
    const e = this.pick(dir);
    if (!e) { this.bump = 1; return; }
    this.pending = true;
    try {
      const n = this.nodes.get(e.to);
      const tex = await this.texture(n.id);
      this.startMove(n, tex, e);
    } catch (err) { this.bump = 1; } finally { this.pending = false; }
  }
  startMove(n, tex, edge) {
    const from = this.cur;
    const dist = edge ? edge.dist : (from.pos && n.pos ? from.pos.distanceTo(n.pos) : 2.5);
    this.B.show(n, tex);
    this.B.opacity = 0;
    this.move = {
      from, to: n, t0: performance.now(),
      dur: clamp(520 + dist * 210, 650, 1500) * (STEP_DIRS.some((d) => this.keys.has(d)) ? 0.9 : 1),
      p0: (from.pos || new THREE.Vector3()).clone(),
      p1: (n.pos || new THREE.Vector3()).clone(),
      // without positions fake the glide 2.5 m along the link direction
      fake: !(from.pos && n.pos) && edge ? edge.yaw : null,
    };
  }
  finishMove() {
    const n = this.move.to;
    // swap: the arrived photos become the base layer
    const a = this.A; this.A = this.B; this.B = a;
    this.A.order = 0; this.B.order = 1;
    this.A.opacity = 1; this.B.hide();
    const p = n.pos || new THREE.Vector3();
    this.camera.position.copy(p);
    this.A.moveTo(p);
    this.cur = n; this.move = null;
    this.idleSince = performance.now();
    this.preload(n);
    this.onChange(n);
    const q = this.queued; this.queued = null;
    if (q && !STEP_DIRS.some((d) => this.keys.has(d))) this.step(q);
  }

  /* ---------- frame loop ---------- */
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    // turning: ease into and out of the turn like a game camera
    const tgt = (this.keys.has('turnL') ? 1 : 0) - (this.keys.has('turnR') ? 1 : 0);
    this.turnVel += (tgt * TURN_SPEED - this.turnVel) * (1 - Math.exp(-dt * 10));
    this.yaw = wrap(this.yaw + this.turnVel * dt);
    // walking: keep stepping while a move key is held
    if (!this.move && !this.pending) {
      for (const d of STEP_DIRS) if (this.keys.has(d)) { this.step(d); break; }
    }
    let fov = this.fov;
    if (this.move) {
      const m = this.move;
      const t = clamp((now - m.t0) / m.dur, 0, 1);
      const e = ease(t);
      if (m.fake !== null) {
        const f = new THREE.Vector3(-Math.sin(m.fake), 0, -Math.cos(m.fake));
        this.camera.position.copy(m.p0).addScaledVector(f, 2.5 * e);
        this.B.moveTo(m.p0.clone().addScaledVector(f, 2.5));
      } else this.camera.position.lerpVectors(m.p0, m.p1, e);
      this.B.opacity = smooth(0.18, 0.82, t);
      fov = this.fov - 6 * Math.sin(Math.PI * t);       // a slight dolly-zoom while striding
      if (t >= 1) this.finishMove();
    } else if (now - this.idleSince > 700) this.sharpen();
    if (this.bump > 0) { fov += 2.5 * this.bump; this.bump = Math.max(0, this.bump - dt * 4); }
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.renderer.render(this.scene, this.camera);
    if (this.opts.onFrame) this.opts.onFrame(this);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------- input ---------- */
  bind() {
    this.onKey = (e) => {
      const k = MOVE_KEYS[e.code];
      if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (e.type !== 'keydown') { this.keys.delete(k); return; }
      this.keys.add(k);
      // a quick tap can start and end inside one frame: step right away, or queue it behind the current stride
      if (!e.repeat && STEP_DIRS.includes(k)) {
        if (this.move || this.pending) this.queued = k; else this.step(k);
      }
    };
    this.onBlur = () => this.keys.clear();
    this.canvas.addEventListener('keydown', this.onKey);
    this.canvas.addEventListener('keyup', this.onKey);
    this.canvas.addEventListener('blur', this.onBlur);
    // drag to look around (mouse and touch); a tap walks toward the tapped direction
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.focus({ preventScroll: true });
      drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false, id: e.pointerId };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = (this.camera.fov * Math.PI / 180) / this.canvas.clientHeight;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      this.yaw = wrap(drag.yaw + dx * k);
      this.pitch = clamp(drag.pitch + dy * k, -1.2, 1.2);
    });
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        const r = this.canvas.getBoundingClientRect();
        const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
        const off = -nx * (this.camera.fov * this.camera.aspect * Math.PI / 360);
        const saved = this.yaw; this.yaw = wrap(this.yaw + off);
        const ed = this.pick('fwd'); this.yaw = saved;
        if (ed) { this.yaw = wrap(saved + off * 0.6); this.step('fwd'); } else this.bump = 1;
      }
      drag = null;
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', () => { drag = null; });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fov = clamp(this.fov + e.deltaY * 0.04, 40, 95);
    }, { passive: false });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.root);
  }
  press(dir, down) {
    if (!down) { this.keys.delete(dir); return; }
    this.keys.add(dir);
    if (STEP_DIRS.includes(dir)) { if (this.move || this.pending) this.queued = dir; else this.step(dir); }
  }
  look(yaw, pitch = 0) { this.yaw = wrap(yaw); this.pitch = clamp(pitch, -1.55, 1.55); }
  focus() { this.canvas.focus({ preventScroll: true }); }
  resize() {
    const w = this.root.clientWidth || 1, h = this.root.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.cache.forEach((t) => (t.faces || [t.tex]).forEach((x) => x.dispose()));
    this.renderer.dispose();
    this.canvas.remove();
  }
}

/* ---------- minimap: top-down dots, current point and view direction ---------- */
export function drawMap(ctx, w, wk) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!wk.nodes || !wk.hasPos) return;
  const ns = [...wk.nodes.values()];
  const xs = ns.map((n) => n.pos.x), zs = ns.map((n) => n.pos.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const pad = 14 * w, s = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxZ - minZ));
  const ox = (W - (maxX - minX) * s) / 2, oz = (H - (maxZ - minZ) * s) / 2;
  const P = (v) => [ox + (v.x - minX) * s, oz + (v.z - minZ) * s];
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ns.forEach((n) => { const [x, y] = P(n.pos); ctx.beginPath(); ctx.arc(x, y, 2.6 * w, 0, TAU); ctx.fill(); });
  const [cx, cy] = P(wk.camera.position);
  const a = -wk.yaw - Math.PI / 2;           // screen angle of the view direction
  const half = (wk.camera.fov * wk.camera.aspect * Math.PI / 180) / 2;
  ctx.fillStyle = 'rgba(214,251,0,.22)';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 34 * w, a - Math.min(half, 1), a + Math.min(half, 1)); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#D6FB00';
  ctx.beginPath(); ctx.arc(cx, cy, 5 * w, 0, TAU); ctx.fill();
}
