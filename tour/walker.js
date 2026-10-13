/* Deep Academia — panorama walker.
   Walk real 360° captures with the keyboard like a game character:
   ↑/W forward, ↓/S back, ←/→ (or Q/E) turn, A/D side-step; hold a key to keep going.
   Each capture point shows its photos at full quality. With depth maps, moving between points walks the
   camera through both captures' 3D shapes (near things slide past faster than far ones) and blends them per
   pixel; without depth it glides from one photo cube/sphere to the next while crossfading.

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

// A capture shown on its own 3D shape: every vertex sits at the real distance (depth map) along its ray, and its
// colour is read from the cube faces in that same direction — so from the capture point the image is exactly the
// photo, and while walking, near things slide past faster than far ones, as in real life.
const COARSE = typeof window !== 'undefined' && !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
// phones: a lighter walking mesh (the photo at rest is unaffected)
const DEPTH_SEG = COARSE ? [256, 128] : [384, 192];
// radians: how fast a capture loses trust as the viewing ray turns away from the ray its photo was taken along
const ANG_S = 0.35;
// relative bend in inverse depth where the mesh starts to count as stretched, and how quickly it gets there
const EDGE_LO = 0.03, EDGE_SPAN = 0.09;
// blend sharpness between the two captures (1 = plain crossfade)
const SHARP = 3;
// photo sets kept in memory (a set = the 6 faces of one point at one size)
const CACHE_MAX = COARSE ? 7 : 12;
const DEPTH_VERT = `
attribute vec3 dir;
attribute float edge;
varying vec3 vDir;
varying float vEdge;
varying vec3 vWorld;
varying vec3 vCenter;
void main() {
  vDir = dir;
  vEdge = edge;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vCenter = modelMatrix[3].xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const DEPTH_FRAG = `
uniform sampler2D tf;
uniform sampler2D tr;
uniform sampler2D tb;
uniform sampler2D tl;
uniform sampler2D tu;
uniform sampler2D td;
uniform float opacity;
uniform float edgeFade;
uniform float weight;
uniform float weighted;
uniform float angS;
uniform float sharp;
varying vec3 vDir;
varying float vEdge;
varying vec3 vWorld;
varying vec3 vCenter;
// WebGL 2 only (the walker falls back to plain photos on WebGL 1)
#if __VERSION__ >= 300
#define SET_DEPTH(z) gl_FragDepth = (z)
#define SAMPLE(t) textureGrad(t, uv, gx, gy)
#else
#define SET_DEPTH(z)
#define SAMPLE(t) texture2D(t, uv)
#endif
vec2 fuv(float a, float b) { return vec2((a + 1.0) * 0.5, 1.0 - (b + 1.0) * 0.5); }
// where direction d lands on face f (0 front, 1 back, 2 right, 3 left, 4 up, 5 down); scale-invariant
vec2 onFace(int f, vec3 d) {
  if (f == 0) return fuv(d.x / -d.z, -d.y / -d.z);
  if (f == 1) return fuv(-d.x / d.z, -d.y / d.z);
  if (f == 2) return fuv(d.z / d.x, -d.y / d.x);
  if (f == 3) return fuv(d.z / d.x, d.y / d.x);
  if (f == 4) return fuv(d.x / d.y, -d.z / d.y);
  return fuv(-d.x / d.y, -d.z / d.y);
}
void main() {
  vec3 q = abs(vDir);
  int f;
  if (q.z >= q.x && q.z >= q.y) f = vDir.z < 0.0 ? 0 : 1;
  else if (q.x >= q.y) f = vDir.x > 0.0 ? 2 : 3;
  else f = vDir.y > 0.0 ? 4 : 5;
  vec2 uv = onFace(f, vDir);
#if __VERSION__ >= 300
  // texture gradients from the smooth ray direction, on this pixel's own face: the hardware's own estimate
  // jumps where neighbouring pixels sit on different faces and leaves a blurry seam line
  vec2 gx = onFace(f, vDir + dFdx(vDir)) - uv;
  vec2 gy = onFace(f, vDir + dFdy(vDir)) - uv;
#endif
  vec4 c;
  if (f == 0) c = SAMPLE(tf);
  else if (f == 1) c = SAMPLE(tb);
  else if (f == 2) c = SAMPLE(tr);
  else if (f == 3) c = SAMPLE(tl);
  else if (f == 4) c = SAMPLE(tu);
  else c = SAMPLE(td);
  if (weighted > 0.5) {
    if (vEdge > 0.4) {
      // the stretched sheet across a depth jump is not real surface: push it behind everything real (so it
      // never hides a surface this capture did see) and flag it with a negative weight; the composite uses
      // it only where neither capture saw anything
      float ws = 0.01 * weight;
      gl_FragColor = vec4(c.rgb * ws, -ws);
      SET_DEPTH(1.0);
    } else {
      // real surface: trust it by camera closeness, edge quality, and how close the viewing ray is to the
      // ray the photo was taken along (near things seen from a new angle drift first)
      vec3 a = normalize(vWorld - vCenter);
      vec3 b = normalize(vWorld - cameraPosition);
      float ang = acos(clamp(dot(a, b), -1.0, 1.0));
      float wa = max(exp(-(ang * ang) / (angS * angS)), 0.02);
      // raised to a power: wherever one capture is clearly the better source it wins outright, so the two
      // photos overlap (ghost) only briefly mid-step; floored so a real surface never reads as missing
      float w = max(pow(weight * (1.0 - 1.5 * vEdge) * wa, sharp), 1e-4);
      gl_FragColor = vec4(c.rgb * w, w);
      SET_DEPTH(gl_FragCoord.z);
    }
  } else {
    gl_FragColor = vec4(c.rgb, opacity * (1.0 - edgeFade * vEdge));
    SET_DEPTH(gl_FragCoord.z);
  }
  #include <colorspace_fragment>
}`;
// final pass: per-pixel weighted average of the two captures' renders
const BLEND_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BLEND_FRAG = `
uniform sampler2D ta;
uniform sampler2D tb;
uniform vec2 px;
uniform float fill;
varying vec2 vUv;
// x: weighted colour of real surfaces, y: their weight; sheets are flagged by a negative weight
vec4 real(vec2 uv) {
  vec4 a = texture2D(ta, uv), b = texture2D(tb, uv);
  return vec4((a.a > 0.0 ? a.rgb : vec3(0.0)) + (b.a > 0.0 ? b.rgb : vec3(0.0)), max(a.a, 0.0) + max(b.a, 0.0));
}
void main() {
  vec4 s = real(vUv);
  if (s.a > 0.0) {
    gl_FragColor = vec4(s.rgb / s.a, 1.0);
  } else {
    // seen by neither capture (behind something close): the stretched sheets, or the nearest real surroundings
    vec4 a = texture2D(ta, vUv), b = texture2D(tb, vUv);
    float ws = max(-a.a, 0.0) + max(-b.a, 0.0);
    vec3 sheet = ws > 0.0 ? ((a.a < 0.0 ? a.rgb : vec3(0.0)) + (b.a < 0.0 ? b.rgb : vec3(0.0))) / ws : vec3(0.0);
    vec4 acc = vec4(0.0);
    if (fill > 0.5) {
      for (int r = 1; r <= 5; r++) {
        float rad = exp2(float(r));
        for (int k = 0; k < 8; k++) {
          float an = float(k) * 0.785398 + float(r) * 0.3;
          vec4 q = real(vUv + vec2(cos(an), sin(an)) * rad * px);
          if (q.a > 0.0) acc += vec4(q.rgb / q.a, 1.0);
        }
        if (acc.a > 2.0) break;
      }
    }
    gl_FragColor = vec4(acc.a > 0.0 ? acc.rgb / acc.a : sheet, 1.0);
  }
  #include <colorspace_fragment>
}`;

/* one projection surface (sphere for equirect photos, inside-out box for cube faces, depth mesh when known) */
class Pano {
  constructor(scene, order) {
    const uniforms = { opacity: { value: 1 }, edgeFade: { value: 0 }, weight: { value: 1 }, weighted: { value: 0 }, angS: { value: ANG_S }, sharp: { value: SHARP } };
    FACES.forEach((f) => { uniforms['t' + f] = { value: null }; });
    this.dm = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
      uniforms, vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.order0 = order;
    this.dm.frustumCulled = false;
    this.dm.renderOrder = order; this.dm.visible = false; scene.add(this.dm);
    this.isDepth = false;
    const sg = new THREE.SphereGeometry(R, 96, 64);
    sg.scale(-1, 1, 1);
    this.sphere = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false }));
    this.box = new THREE.Mesh(new THREE.BoxGeometry(2 * R, 2 * R, 2 * R),
      Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false })));
    [this.sphere, this.box].forEach((m) => { m.renderOrder = order; m.visible = false; scene.add(m); });
    this.node = null;
  }
  set order(o) { this.sphere.renderOrder = o; this.box.renderOrder = o; this.dm.renderOrder = o; }
  set opacity(v) {
    this.sphere.material.opacity = v;
    this.box.material.forEach((m) => { m.opacity = v; });
    this.dm.material.uniforms.opacity.value = v;
  }
  set edgeFade(v) { this.dm.material.uniforms.edgeFade.value = v; }
  // weighted pass: opaque, depth-tested (the mesh's own front surface wins), output premultiplied by weight
  setWeighted(on, w = 1) {
    const m = this.dm.material;
    m.uniforms.weighted.value = on ? 1 : 0;
    m.uniforms.weight.value = w;
    m.uniforms.edgeFade.value = on ? 1 : 0;
    m.transparent = !on; m.depthTest = on; m.depthWrite = on;
    m.blending = on ? THREE.NoBlending : THREE.NormalBlending;
  }
  hide() { this.sphere.visible = false; this.box.visible = false; this.dm.visible = false; this.node = null; }
  show(n, tex, geo) {
    this.node = n;
    const p = n.pos || new THREE.Vector3();
    this.geo = geo || null;
    this.isDepth = !!(geo && tex.faces);
    if (this.isDepth) {
      const u = this.dm.material.uniforms;
      FACES.forEach((f, k) => { u['t' + f].value = tex.faces[k]; });
      this.dm.geometry = geo;
      this.dm.position.copy(p);
      this.dm.rotation.y = n.heading;
      this.dm.visible = true; this.box.visible = false; this.sphere.visible = false;
      return;
    }
    this.dm.visible = false;
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
  moveTo(p) { this.sphere.position.copy(p); this.box.position.copy(p); this.dm.position.copy(p); }
}

export class Walker {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.keys = new Set();
    this.yaw = 0; this.pitch = 0; this.turnVel = 0; this.fov = 75;
    this.cur = null; this.move = null; this.bump = 0; this.queued = null;
    this.cache = new Map(); this.loading = new Map();
    this.geos = new Map(); this.geoLoading = new Map();
    this.upQ = [];
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
    const rtType = this.renderer.capabilities.isWebGL2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const mkRT = () => new THREE.WebGLRenderTarget(1, 1, { type: rtType, depthBuffer: true });
    this.rtA = mkRT(); this.rtB = mkRT();
    this.blendScene = new THREE.Scene();
    this.blendCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.blendMat = new THREE.ShaderMaterial({ uniforms: { ta: { value: this.rtA.texture }, tb: { value: this.rtB.texture }, px: { value: new THREE.Vector2(1, 1) }, fill: { value: COARSE ? 0 : 1 } },
      vertexShader: BLEND_VERT, fragmentShader: BLEND_FRAG, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMat);
    quad.frustumCulled = false;
    this.blendScene.add(quad);

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
    // walking through the 3D shape needs WebGL 2 (float render targets, depth writes); otherwise plain photos
    this.depthRange = this.renderer.capabilities.isWebGL2 ? (data.depthRange || null) : null;
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
    const add = (id, yaw, portal = false) => {
      const m = this.nodes.get(id);
      if (!m || m === n) return;
      if (this.hasPos) {
        const d = new THREE.Vector3().subVectors(m.pos, n.pos);
        out.push({ to: id, yaw: Math.atan2(-d.x, -d.z), dist: Math.hypot(d.x, d.z), portal });
      } else if (typeof yaw === 'number') out.push({ to: id, yaw, dist: 2.5, portal });
    };
    if (n.links && n.links.length) {
      n.links.forEach((l) => (typeof l === 'string' ? add(l) : add(l.to, l.yaw, !!l.portal)));
      // several links in one direction: keep the nearest per ~30° sector so steps stay short (portals always stay)
      out.sort((a, b) => a.dist - b.dist);
      const kept = [];
      out.forEach((e) => { if (e.portal || !kept.some((k) => !k.portal && Math.abs(wrap(k.yaw - e.yaw)) < 0.5)) kept.push(e); });
      return kept;
    }
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
        // phones show the faces at or above their own resolution: mipmaps would only cost memory and upload time
        t.minFilter = COARSE ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = !COARSE;
        t.needsUpdate = true;
        resolve(t);
      };
      if (canvas) { done(canvas); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        // decode off the main thread now, so the later GPU upload doesn't have to
        if (img.naturalWidth <= maxSide) { (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => done(img)); return; }
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
          if (n.depth && this.depthRange) return { faces, size };   // depth mesh samples by direction: no transforms
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
    p = p.then((t) => { this.cache.set(key, t); this.loading.delete(key); this.trim(); this.queueUpload(t); return t; },
      (e) => { this.loading.delete(key); throw e; });
    this.loading.set(key, p);
    return p;
  }
  // sending a big photo to the GPU stalls a frame: spread a set over several frames (one face each), before
  // it is needed
  queueUpload(t) { (t.faces || [t.tex]).forEach((x) => { if (!x.userData.up && !this.upQ.includes(x)) this.upQ.push(x); }); }
  uploadNext() {
    while (this.upQ.length) {
      const x = this.upQ.shift();
      if (x.userData.dead || x.userData.up) continue;
      this.renderer.initTexture(x);
      x.userData.up = true;
      return;
    }
  }
  // resolves once the whole set is on the GPU (moved to the front of the queue)
  uploaded(t) {
    const need = (t.faces || [t.tex]).filter((x) => !x.userData.up && !x.userData.dead);
    if (!need.length) return Promise.resolve();
    this.upQ = need.concat(this.upQ.filter((x) => !need.includes(x)));
    return new Promise((res) => {
      const chk = () => (need.every((x) => x.userData.up || x.userData.dead) ? res() : requestAnimationFrame(chk));
      chk();
    });
  }
  trim() {
    const keep = new Set();
    [this.cur, this.move && this.move.to].forEach((n) => { if (n) { keep.add(n.id + '@' + this.lowSize); keep.add(n.id + '@' + this.highSize); keep.add(n.id + '@eq'); } });
    if (this.cur) this.cur.edges.forEach((e) => { keep.add(e.to + '@' + this.lowSize); keep.add(e.to + '@eq'); });
    for (const [key, t] of this.cache) {
      if (this.cache.size <= CACHE_MAX) break;
      if (keep.has(key)) continue;
      (t.faces || [t.tex]).forEach((x) => { x.userData.dead = true; x.dispose(); });
      this.cache.delete(key);
    }
  }
  preload(n) { n.edges.forEach((e) => { this.texture(e.to).catch(() => {}); this.depthGeometry(e.to).catch(() => {}); }); }
  // depth map (16-bit inverse depth in R high / G low, equirect) -> displaced sphere with per-vertex ray direction
  depthGeometry(id) {
    const n = this.nodes.get(id);
    if (!n || !n.depth || !this.depthRange) return Promise.resolve(null);
    if (this.geos.has(id)) return Promise.resolve(this.geos.get(id));
    if (this.geoLoading.has(id)) return this.geoLoading.get(id);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const W = img.naturalWidth, H = img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, W, H).data;
        const i0 = 1 / this.depthRange[1], i1 = 1 / this.depthRange[0];
        const at = (x, y) => { const k = 4 * (y * W + x); return i0 + ((px[k] * 256 + px[k + 1]) / 65535) * (i1 - i0); };
        const invAt = (fx, fy) => {
          fy = clamp(fy, 0, H - 1);
          const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
          const xa = ((x0 % W) + W) % W, xb = (xa + 1) % W, yb = Math.min(y0 + 1, H - 1);
          return (at(xa, y0) * (1 - tx) + at(xb, y0) * tx) * (1 - ty) + (at(xa, yb) * (1 - tx) + at(xb, yb) * tx) * ty;
        };
        const [SX, SY] = DEPTH_SEG;
        const nv = (SX + 1) * (SY + 1);
        const pos = new Float32Array(nv * 3), dir = new Float32Array(nv * 3), inv = new Float32Array(nv), edge = new Float32Array(nv);
        for (let j = 0; j <= SY; j++) {
          const lat = Math.PI / 2 - (j / SY) * Math.PI;
          for (let i = 0; i <= SX; i++) {
            const k = j * (SX + 1) + i;
            const lon = (i / SX) * 2 * Math.PI - Math.PI;
            const dx = Math.sin(lon) * Math.cos(lat), dy = Math.sin(lat), dz = -Math.cos(lon) * Math.cos(lat);
            const iv = invAt((i / SX) * W - 0.5, (j / SY) * H - 0.5);
            inv[k] = iv;
            const r = 1 / iv;
            dir[3 * k] = dx; dir[3 * k + 1] = dy; dir[3 * k + 2] = dz;
            pos[3 * k] = dx * r; pos[3 * k + 1] = dy * r; pos[3 * k + 2] = dz * r;
          }
        }
        // where the depth jumps (an object in front of a wall) the mesh is stretched: mark it. A plane has inverse
        // depth linear in the ray direction, so a floor seen at a grazing angle changes steadily; only a bend in
        // the profile (second difference) is a jump
        const I = (i, j) => inv[j * (SX + 1) + ((i % SX) + SX) % SX];
        for (let j = 0; j <= SY; j++) for (let i = 0; i <= SX; i++) {
          const k = j * (SX + 1) + i, c = inv[k];
          let jump = Math.abs(I(i + 1, j) - 2 * c + I(i - 1, j)) / c;
          if (j > 0 && j < SY) jump = Math.max(jump, Math.abs(I(i, j + 1) - 2 * c + I(i, j - 1)) / c);
          edge[k] = clamp((jump - EDGE_LO) / EDGE_SPAN, 0, 1);
        }
        const idx = new Uint32Array(SX * SY * 6);
        let q = 0;
        for (let j = 0; j < SY; j++) for (let i = 0; i < SX; i++) {
          const a = j * (SX + 1) + i, b = a + SX + 1;
          idx[q++] = a; idx[q++] = b; idx[q++] = a + 1;
          idx[q++] = a + 1; idx[q++] = b; idx[q++] = b + 1;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
        geo.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        this.geos.set(id, geo);
        this.geoLoading.delete(id);
        if (this.geos.size > 16) {                     // keep memory bounded
          const keep = new Set([this.cur && this.cur.id, this.move && this.move.to.id, id]);
          for (const [gid, gg] of this.geos) { if (this.geos.size <= 12) break; if (!keep.has(gid)) { gg.dispose(); this.geos.delete(gid); } }
        }
        resolve(geo);
      };
      img.onerror = () => { this.geoLoading.delete(id); reject(new Error('depth ' + id)); };
      img.src = new URL(n.depth, this.base).href;
    });
    this.geoLoading.set(id, p);
    return p;
  }
  // standing still: swap the current point to the sharper faces
  async sharpen() {
    const n = this.cur;
    if (!n || !n.cube || this.highSize === this.lowSize || this.sharpening === n.id) return;
    this.sharpening = n.id;
    try {
      const t = await this.texture(n.id, this.highSize);
      await this.uploaded(t);
      if (this.cur === n && !this.move && this.A.node === n) this.A.show(n, t, this.A.geo);
    } catch (e) { /* keep the low size */ }
  }

  async goto(id, { instant = false } = {}) {
    const n = this.nodes.get(id);
    if (!n) return;
    const [tex, geo] = await Promise.all([this.texture(id), this.depthGeometry(id).catch(() => null)]);
    if (instant || !this.cur) {
      this.cur = n;
      this.A.show(n, tex, geo);
      this.A.opacity = 1;
      this.B.hide();
      this.camera.position.copy(n.pos || new THREE.Vector3());
      // compile the walking shaders now (behind the start screen) rather than on the first step
      if (geo && !this.warmed) { this.warmed = true; this.renderBlend(0); }
      this.preload(n);
      this.onChange(n);
      this.idleSince = performance.now();
      return;
    }
    this.startMove(n, tex, null, geo);
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
      const [tex, geo] = await Promise.all([this.texture(n.id), this.depthGeometry(n.id).catch(() => null)]);
      await this.uploaded(tex);
      this.startMove(n, tex, e, geo);
    } catch (err) { this.bump = 1; } finally { this.pending = false; }
  }
  startMove(n, tex, edge, geo) {
    const from = this.cur;
    const dist = edge ? edge.dist : (from.pos && n.pos ? from.pos.distanceTo(n.pos) : 2.5);
    this.B.show(n, tex, geo);
    const depth = this.B.isDepth && this.A.isDepth;
    if (depth) {
      // both captures in 3D: the destination underneath, the one we leave on top fading out (its stretched
      // depth edges first), the camera walking through the scene between them
      this.B.order = 0; this.A.order = 1;
      this.B.opacity = 1; this.A.opacity = 1; this.A.edgeFade = 1; this.B.edgeFade = 0;
    } else this.B.opacity = 0;
    const portal = !!(edge && edge.portal);
    const chained = performance.now() - (this.lastStepEnd || 0) < 80 && STEP_DIRS.some((d) => this.keys.has(d));
    // through a door into another room: no glide; the new room fades in around the viewer
    if (portal) this.B.moveTo(from.pos || new THREE.Vector3());
    this.move = {
      portal, depth, chained,
      from, to: n, t0: performance.now(),
      // walking pace (~1.7 m/s); with real 3D the stride needs no extra effects
      dur: depth ? clamp((dist / 1.7) * 1000 + (chained ? 0 : 250), 600, 2800)
        : clamp(520 + dist * 210, 650, 1500) * (STEP_DIRS.some((d) => this.keys.has(d)) ? 0.9 : 1),
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
    this.A.opacity = 1; this.A.edgeFade = 0; this.B.edgeFade = 0; this.B.hide();
    this.lastStepEnd = performance.now();
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
    this.uploadNext();
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
      // held key: constant walking speed through the points (no slowing down at each one)
      const e = m.depth ? (m.chained ? (STEP_DIRS.some((d) => this.keys.has(d)) ? t : 1 - Math.pow(1 - t, 2))
        : (STEP_DIRS.some((d) => this.keys.has(d)) ? t * t * (3 - 2 * t) * 0.5 + t * 0.5 : ease(t))) : ease(t);
      if (m.depth) {
        if (!m.portal) this.camera.position.lerpVectors(m.p0, m.p1, e);
        m.wB = smooth(m.portal ? 0.15 : 0.05, m.portal ? 0.85 : 0.95, t);
        if (m.portal) fov = this.fov - 10 * Math.sin(Math.PI * t);
        if (t >= 1) this.finishMove();
      } else if (m.portal) {
        this.B.opacity = smooth(0.15, 0.85, t);
        fov = this.fov - 12 * Math.sin(Math.PI * t);
        if (t >= 1) this.finishMove();
      } else if (m.fake !== null) {
        const f = new THREE.Vector3(-Math.sin(m.fake), 0, -Math.cos(m.fake));
        this.camera.position.copy(m.p0).addScaledVector(f, 2.5 * e);
        this.B.moveTo(m.p0.clone().addScaledVector(f, 2.5));
      } else this.camera.position.lerpVectors(m.p0, m.p1, e);
      if (!m.portal && !m.depth) {
        this.B.opacity = smooth(0.18, 0.82, t);
        fov = this.fov - 6 * Math.sin(Math.PI * t);     // a slight dolly-zoom while striding
        if (t >= 1) this.finishMove();
      }
    } else if (now - this.idleSince > 700) this.sharpen();
    if (this.bump > 0) { fov += 2.5 * this.bump; this.bump = Math.max(0, this.bump - dt * 4); }
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    if (this.move && this.move.depth) this.renderBlend(this.move.wB || 0);
    else this.renderer.render(this.scene, this.camera);
    if (this.opts.onFrame) this.opts.onFrame(this);
    if (this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // two captures, each from its own 3D shape, averaged per pixel by weight (camera closeness x mesh quality)
  renderBlend(wB) {
    const A = this.A, B = this.B, r = this.renderer;
    const visA = A.dm.visible, visB = B.dm.visible;
    A.setWeighted(true, Math.max(1 - wB, 0.002)); B.setWeighted(true, Math.max(wB, 0.002));
    B.dm.visible = false; A.dm.visible = visA;
    r.setRenderTarget(this.rtA); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, this.camera);
    A.dm.visible = false; B.dm.visible = visB;
    r.setRenderTarget(this.rtB); r.clear(); r.render(this.scene, this.camera);
    A.dm.visible = visA;
    r.setRenderTarget(null);
    r.render(this.blendScene, this.blendCam);
    A.setWeighted(false); B.setWeighted(false);
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
  // stop drawing while the tour is hidden (battery), carry on where it was when shown again
  pause() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; this.keys.clear(); }
  resume() { if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); } }
  focus() { this.canvas.focus({ preventScroll: true }); }
  resize() {
    const w = this.root.clientWidth || 1, h = this.root.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    if (this.rtA) {
      const k = COARSE ? Math.max(0.75, 1 / pr) : 1;  // phones: in-between frames at 75% of a dense screen
      const W = Math.round(w * pr * k), H = Math.round(h * pr * k);
      this.rtA.setSize(W, H); this.rtB.setSize(W, H);
      this.blendMat.uniforms.px.value.set(1 / W, 1 / H);
    }
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
