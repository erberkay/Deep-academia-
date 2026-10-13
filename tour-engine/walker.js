/* Deep Academia — panorama walker.
   Walk a set of real 360° photos with the keyboard like a game character:
   ↑/W forward, ↓/S back, ←/→ (or Q/E) turn, A/D side-step; hold a key to keep going.
   Each capture point shows its photo at full quality; moving between points glides the camera
   from one photo sphere to the next while crossfading, so it feels like walking.

   Data (tour.json):
   {
     "start": "p01",
     "nodes": [
       { "id": "p01", "src": "panos/p01.jpg", "pos": [x, y, z],   // metres, y up (optional)
         "heading": 0,                                         // radians: world yaw the photo centre faces
         "links": ["p02", "p05"] }                             // optional; computed from positions if omitted
     ]
   }
   Without positions every link needs a direction: "links": [{ "to": "p02", "yaw": 1.57 }]. */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a, b, t) => { const x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

const SPHERE_R = 8;          // metres: distance the photo is projected at
const LINK_MAX = 6;          // metres: farthest neighbour auto-linked from positions
const CONE = 0.75;           // radians (~43°): how far off-axis a step may go
const TURN_SPEED = 1.9;      // rad/s at full turn
const STEP_DIRS = ['fwd', 'back', 'left', 'right'];
const MOVE_KEYS = {
  ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back',
  KeyA: 'left', KeyD: 'right', ArrowLeft: 'turnL', ArrowRight: 'turnR', KeyQ: 'turnL', KeyE: 'turnR',
};

export class Walker {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0; this.turnVel = 0; this.fov = 75;
    this.cur = null; this.move = null; this.bump = 0;
    this.cache = new Map(); this.loading = new Map();
    this.onChange = opts.onChange || (() => {});

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
    const geo = new THREE.SphereGeometry(SPHERE_R, 96, 64);
    geo.scale(-1, 1, 1);
    const mk = (order) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, depthTest: false, depthWrite: false }));
      m.renderOrder = order; m.visible = false; this.scene.add(m); return m;
    };
    this.sphA = mk(0); this.sphB = mk(1);

    this.maxTex = this.renderer.capabilities.maxTextureSize;
    this.aniso = this.renderer.capabilities.getMaxAnisotropy();
    this.bind();
    this.resize();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------- data ---------- */
  async load(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('tour.json ' + res.status);
    this.setData(await res.json(), new URL(url, location.href));
  }
  setData(data, base = new URL(location.href)) {
    this.base = base;
    this.nodes = new Map();
    data.nodes.forEach((n) => this.nodes.set(n.id, { ...n, pos: n.pos ? new THREE.Vector3(...n.pos) : null, heading: n.heading || 0 }));
    this.hasPos = [...this.nodes.values()].every((n) => n.pos);
    this.nodes.forEach((n) => { n.edges = this.edgesOf(n, data); });
    const start = this.nodes.get(data.start) || this.nodes.values().next().value;
    if (typeof data.startYaw === 'number') this.yaw = data.startYaw;
    return this.goto(start.id, { instant: true });
  }
  edgesOf(n, data) {
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
    if (n.links && n.links.length) n.links.forEach((l) => (typeof l === 'string' ? add(l) : add(l.to, l.yaw)));
    else if (this.hasPos) {
      this.nodes.forEach((m) => {
        if (m === n || Math.abs(m.pos.y - n.pos.y) > 1.2) return;
        const dist = Math.hypot(m.pos.x - n.pos.x, m.pos.z - n.pos.z);
        if (dist <= LINK_MAX) add(m.id);
      });
      // keep the nearest neighbour per ~30° sector so steps are short and natural
      out.sort((a, b) => a.dist - b.dist);
      const kept = [];
      out.forEach((e) => { if (!kept.some((k) => Math.abs(wrap(k.yaw - e.yaw)) < 0.5)) kept.push(e); });
      return kept;
    }
    return out;
  }

  /* ---------- textures ---------- */
  texture(id) {
    if (this.cache.has(id)) return Promise.resolve(this.cache.get(id));
    if (this.loading.has(id)) return this.loading.get(id);
    const n = this.nodes.get(id);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        let source = img;
        if (img.naturalWidth > this.maxTex) {           // phones: scale 8K photos down to what the GPU takes
          const c = document.createElement('canvas');
          c.width = this.maxTex; c.height = this.maxTex / 2;
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          source = c;
        }
        const t = new THREE.Texture(source);
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = this.aniso;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.needsUpdate = true;
        this.cache.set(id, t);
        this.loading.delete(id);
        this.trim();
        resolve(t);
      };
      img.onerror = () => { this.loading.delete(id); reject(new Error('pano ' + id)); };
      img.src = n.canvas ? n.canvas.toDataURL('image/jpeg', 0.92) : new URL(n.src, this.base).href;
    });
    this.loading.set(id, p);
    return p;
  }
  trim() {
    const keep = new Set([this.cur && this.cur.id, this.move && this.move.to.id]);
    if (this.cur) this.cur.edges.forEach((e) => keep.add(e.to));
    for (const [id, t] of this.cache) {
      if (this.cache.size <= 14) break;
      if (!keep.has(id)) { t.dispose(); this.cache.delete(id); }
    }
  }
  preload(n) { n.edges.forEach((e) => this.texture(e.to).catch(() => {})); }

  /* ---------- placing a photo sphere ---------- */
  place(mesh, n, tex) {
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;
    mesh.position.copy(n.pos || new THREE.Vector3());
    // three.js maps the image centre to local -X (yaw 90°): turn it to face the node heading
    mesh.rotation.y = n.heading - Math.PI / 2;
    mesh.visible = true;
  }

  async goto(id, { instant = false } = {}) {
    const n = this.nodes.get(id);
    if (!n) return;
    const tex = await this.texture(id);
    if (instant || !this.cur) {
      this.cur = n;
      this.place(this.sphA, n, tex);
      this.sphA.material.opacity = 1;
      this.sphB.visible = false;
      this.camera.position.copy(n.pos || new THREE.Vector3());
      this.preload(n);
      this.onChange(n);
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
    this.place(this.sphB, n, tex);
    this.sphB.material.opacity = 0;
    const chain = this.move && this.move.chained;
    this.move = {
      from, to: n, t0: performance.now(),
      dur: clamp(520 + dist * 210, 650, 1500) * (this.keys.size ? 0.9 : 1),
      p0: (from.pos || new THREE.Vector3()).clone(),
      p1: (n.pos || new THREE.Vector3()).clone(),
      // without positions fake the glide 2.5 m along the link direction
      fake: !(from.pos && n.pos) && edge ? edge.yaw : null,
      chained: chain,
    };
  }
  finishMove() {
    const n = this.move.to;
    // swap: the arrived photo becomes the base sphere
    const a = this.sphA; this.sphA = this.sphB; this.sphB = a;
    this.sphA.renderOrder = 0; this.sphB.renderOrder = 1;
    this.sphA.material.opacity = 1; this.sphB.visible = false;
    this.camera.position.copy(n.pos || new THREE.Vector3());
    this.sphA.position.copy(n.pos || new THREE.Vector3());
    this.cur = n; this.move = null;
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
      for (const d of ['fwd', 'back', 'left', 'right']) if (this.keys.has(d)) { this.step(d); break; }
    }
    let fov = this.fov;
    if (this.move) {
      const m = this.move;
      const t = clamp((now - m.t0) / m.dur, 0, 1);
      const e = ease(t);
      if (m.fake !== null) {
        const f = new THREE.Vector3(-Math.sin(m.fake), 0, -Math.cos(m.fake));
        this.camera.position.copy(m.p0).addScaledVector(f, 2.5 * e);
        this.sphB.position.copy(m.p0).addScaledVector(f, 2.5);
      } else this.camera.position.lerpVectors(m.p0, m.p1, e);
      this.sphB.material.opacity = smooth(0.18, 0.82, t);
      fov = this.fov - 6 * Math.sin(Math.PI * t);       // a slight dolly-zoom while striding
      if (t >= 1) this.finishMove();
    }
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
    // drag to look around (mouse and touch)
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
      // a tap (no drag) walks toward the tapped direction
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
    this.cache.forEach((t) => t.dispose());
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
