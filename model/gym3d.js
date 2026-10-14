/* Deep Academia — 3D SALON: walk the gym's photoreal 3D model like a game character.
   Walls, floor and ceiling are the gym's own photos (photo skins: unlit, exact colours); equipment, furniture and
   structure come from gym.glb (PBR, lit by the nearest real 360° photo, which follows the walker smoothly).
   ↑/W forward, ↓/S back, A/D side step, ←/→ (Q/E) turn, Shift faster; drag to look, wheel / pinch to zoom;
   click / tap the floor to walk there (straight line, stops at obstacles).
   Collision: walk.png, a 5 cm grid (R = blocked, already grown by the walker's radius; G = cardio platform).

   API (mirrors tour/walker.js):
     const g = new Gym3D(rootEl, { onProgress(p), onModel(p), onFrame(state) });
     await g.load('model/?v=1');   // resolves when walls / floor / ceiling are ready; the 3D equipment streams in after
     g.pause(); g.resume(); g.focus(); g.press('fwd' | 'back' | 'left' | 'right' | 'turnL' | 'turnR', down);
     g.onKey(e); g.teleport('giris'); g.destroy(); g.canvas
   onProgress(0..1): walls / floor (needed to start); onModel(0..1): the 3D equipment (1 = shown);
   onFrame({ x, z, yaw, hfov, place, map }) after every drawn frame (minimap: drawMap below).
   World: three.js x = east, y = up, z = south (north = -z), metres, floor y = 0. */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/meshopt_decoder.module.js';

const JSM = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';
// over-detailed parts (scans, fine fillets) are thinned on load: ~45% fewer triangles at sub-millimetre to few-mm error
const SIMPLIFIER = 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.21.0/meshopt_simplifier.module.js';
const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (t) => t * t * (3 - 2 * t);

const EYE = 1.6;              // m: eye height above the floor
const WALK = 1.4, RUN = 2.6;  // m/s
const TURN = 1.9;             // rad/s at full turn (keys)
const ACCEL = 8;              // 1/s: how fast the walk speed follows the keys
const ENV_INT = 2.2;          // image-based light strength on the 3D models (LDR photos: a boost matches them; calibrated
                              // so a white part next to the photographed white radiator in the locker room reads the same)
const ENV_FADE = 900;         // ms: crossfade between two captures' light
const CELL = 8;               // m: merged static geometry is grouped per CELL x CELL tile (keeps frustum culling)
const LOD_D = 6;              // m: heavy instanced parts (e.g. the kettlebells) farther than this use a light version
const LOD_TRIS = 4000;        // ... when one copy has more triangles than this
const TILE_LOD_D = 10;        // m: merged tiles (see CELL) farther than this use their coarser version
const CLEAR = 0x5f5a56;       // background: a wall-like grey, so a hairline gap between photos does not show as a black line
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const REDUCE = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEBUG = typeof location !== 'undefined' && /[?&]g3debug\b/.test(location.search);
const MOVE_KEYS = {
  ArrowUp: 'fwd', KeyW: 'fwd', ArrowDown: 'back', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  ArrowLeft: 'turnL', ArrowRight: 'turnR', KeyQ: 'turnL', KeyE: 'turnR', ShiftLeft: 'run', ShiftRight: 'run',
};
const KEY_FALLBACK = { w: 'fwd', s: 'back', a: 'left', d: 'right', q: 'turnL', e: 'turnR' };
const STEP = ['fwd', 'back', 'left', 'right', 'turnL', 'turnR'];
const NB8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [-1, 1, 1.4142], [1, -1, 1.4142], [-1, -1, 1.4142]];

/* ---------- loading helpers ---------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const aborted = (e) => !!e && (e.name === 'AbortError' || e.g3abort);
// a flaky mobile connection (or a busy server) gets two more tries
async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= 2 || e.status === 404 || aborted(e)) throw e; }
    await wait(500 * (i + 1) * (i + 1));
  }
}
// the real file size from the first bytes of a .glb / .ktx2 (a gzip-compressing server such as GitHub Pages
// sends the compressed Content-Length, which says nothing about the bytes the stream delivers)
function sizeFromHead(u8) {
  if (u8.length < 12) return 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) === 0x46546C67) return dv.getUint32(8, true);              // 'glTF': total length
  if (u8[0] === 0xAB && u8[1] === 0x4B && u8[2] === 0x54 && u8[3] === 0x58 && u8[5] === 0x32 && u8[6] === 0x30 && u8.length >= 80) {
    const levels = Math.max(1, dv.getUint32(40, true));                               // KTX2: mip levels come last
    if (u8.length < 80 + levels * 24) return 0;
    let end = 0;
    for (let k = 0; k < levels; k++) {
      const o = 80 + k * 24;
      const off = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296;
      const len = dv.getUint32(o + 8, true) + dv.getUint32(o + 12, true) * 4294967296;
      end = Math.max(end, off + len);
    }
    return end;
  }
  return 0;
}
// fetch with byte progress (onp(loaded, total)); total may be 0 when the size is not known
const fetchBuf = (url, onp, signal) => retry(() => fetchOnce(url, onp, signal));
async function fetchOnce(url, onp, signal) {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) { const e = new Error(url + ' ' + res.status); e.status = res.status; throw e; }
  // a compressed response: Content-Length is the compressed size, not what the stream delivers
  let total = res.headers.get('content-encoding') ? 0 : +res.headers.get('content-length') || 0;
  if (!res.body || !res.body.getReader) {
    const b = await res.arrayBuffer();
    if (onp) onp(b.byteLength, b.byteLength);
    return b;
  }
  const reader = res.body.getReader(), parts = [];
  let got = 0, sniffed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (!sniffed && got >= 512) {
      sniffed = true;
      const head = parts.length === 1 ? value : new Uint8Array(got);
      if (parts.length > 1) { let o = 0; for (const p of parts) { head.set(p, o); o += p.length; } }
      const n = sizeFromHead(head);
      if (n >= got) total = n;
    }
    if (onp) onp(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
// several downloads as one 0..1 figure (estimated sizes until the server tells the real ones); never goes back
class Progress {
  constructor(cb) { this.cb = cb; this.items = new Map(); this.p = 0; }
  add(key, est) { this.items.set(key, { got: 0, total: est }); return (g, t) => this.set(key, g, t); }
  set(key, got, total) {
    const it = this.items.get(key);
    if (!it) return;
    it.got = got; if (total) it.total = Math.max(total, got);
    let g = 0, t = 0;
    this.items.forEach((v) => { g += Math.min(v.got, v.total); t += v.total; });
    const p = t ? g / t : 0;
    if (p > this.p) { this.p = p; if (this.cb) this.cb(Math.min(p, 0.999)); }
  }
}
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

/* ---------- mesh simplification off the main thread ----------
   jobs: [{ idx: Uint32Array, pos: Float32Array (xyz), target: index count, err: relative error }] -> index arrays
   (null where it did not help). A module worker runs meshoptimizer; where that is not possible, the main thread does. */
const SIMPLIFY_SRC = `import { MeshoptSimplifier as S } from '${SIMPLIFIER}';
const run = (j) => S.simplify(j.idx, j.pos, 3, j.target, j.err)[0];
onmessage = async (e) => {
  await S.ready;
  const out = e.data.jobs.map((j) => { try { return run(j); } catch (err) { return null; } });
  postMessage({ id: e.data.id, out }, out.filter(Boolean).map((a) => a.buffer));
};`;
let simplifyWorker = null;
function workerSimplify(jobs) {
  if (typeof Worker !== 'function' || simplifyWorker === false) return Promise.reject(new Error('no worker'));
  if (!simplifyWorker) {
    try {
      const u = URL.createObjectURL(new Blob([SIMPLIFY_SRC], { type: 'text/javascript' }));
      simplifyWorker = { w: new Worker(u, { type: 'module' }), n: 0, wait: new Map() };
      simplifyWorker.w.onmessage = (e) => { const f = simplifyWorker.wait.get(e.data.id); if (f) { simplifyWorker.wait.delete(e.data.id); f.res(e.data.out); } };
      simplifyWorker.w.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        const W = simplifyWorker; simplifyWorker = false;
        W.wait.forEach((f) => f.rej(new Error('worker'))); W.wait.clear(); W.w.terminate();
      };
    } catch (e) { simplifyWorker = false; return Promise.reject(e); }
  }
  const W = simplifyWorker, id = ++W.n;
  return new Promise((res, rej) => {
    W.wait.set(id, { res, rej });
    W.w.postMessage({ id, jobs }, jobs.flatMap((j) => [j.idx.buffer, j.pos.buffer]));
  });
}
let mainSimplifier = null;
async function simplifyJobs(jobs, yieldFn) {
  if (!jobs.length) return [];
  // the worker gets copies, so the main-thread fallback still has the originals
  const copy = jobs.map((j) => ({ idx: j.idx.slice(), pos: j.pos.slice(), target: j.target, err: j.err, sloppy: j.sloppy }));
  try { return await workerSimplify(copy); } catch (e) { /* main thread below */ }
  if (!mainSimplifier) mainSimplifier = import(SIMPLIFIER).then((m) => m.MeshoptSimplifier.ready.then(() => m.MeshoptSimplifier)).catch(() => null);
  const S = await mainSimplifier;
  if (!S || !S.supported) return jobs.map(() => null);
  const out = [];
  let t0 = performance.now();
  for (const j of jobs) {
    try { out.push(S.simplify(j.idx, j.pos, 3, j.target, j.err)[0]); } catch (e) { out.push(null); }
    if (performance.now() - t0 > 12) { await yieldFn(); t0 = performance.now(); }
  }
  return out;
}
// a geometry's (local) positions as a plain Float32Array (xyz)
function positions(g) {
  const n = g.attributes.position.count, P = reader(g.attributes.position), pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const o = P.off + i * P.st; pos[i * 3] = P.arr[o] * P.s; pos[i * 3 + 1] = P.arr[o + 1] * P.s; pos[i * 3 + 2] = P.arr[o + 2] * P.s; }
  return pos;
}
const indexU32 = (I) => (I.array instanceof Uint32Array && I.array.length === I.count ? I.array : Uint32Array.from(I.array.subarray(0, I.count)));
// a coarse version for far away: vertices snapped together per cell (size in the geometry's own units), the triangles
// that collapse dropped. Works on any mesh (also ones made of many separate pieces, which edge collapse cannot thin);
// the kept vertices are original ones, so only a new index buffer is needed
function clusterIndex(I, pos, cell) {
  const n = pos.length / 3, inv = 1 / cell, rep = new Int32Array(n), cells = new Map();
  const K = 131072, H = 65536;
  for (let i = 0; i < n; i++) {
    const key = (Math.floor(pos[i * 3] * inv) + H) + (Math.floor(pos[i * 3 + 1] * inv) + H) * K + (Math.floor(pos[i * 3 + 2] * inv) + H) * K * K;
    let r = cells.get(key);
    if (r === undefined) { r = i; cells.set(key, i); }
    rep[i] = r;
  }
  const a = I.array, c = I.count, out = new Uint32Array(c);
  let o = 0;
  for (let t = 0; t + 2 < c; t += 3) {
    const x = rep[a[t]], y = rep[a[t + 1]], z = rep[a[t + 2]];
    if (x === y || y === z || x === z) continue;
    out[o++] = x; out[o++] = y; out[o++] = z;
  }
  return out.subarray(0, o);
}

/* ---------- merged static geometry: one draw call per tile instead of one per part ----------
   gym.glb has ~450 flat-colour materials. Parts with plain (untextured, opaque, non-glowing) materials are baked into
   world space and joined per tile; their colour, roughness and metalness travel as vertex data. */
const MERGED_VERT_HEAD = 'attribute vec4 g3c;\nattribute float g3m;\nvarying vec3 vG3C;\nvarying vec2 vG3RM;\n';
const MERGED_VERT_BODY = 'vec3 g3s = g3c.rgb;\nvG3C = mix(g3s / 12.92, pow((g3s + 0.055) / 1.055, vec3(2.4)), step(0.04045, g3s));\nvG3RM = vec2(g3c.a, g3m);\n';
function mergedMaterial(side) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side, envMapIntensity: ENV_INT });
  m.name = 'g3-merged';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + MERGED_VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + MERGED_VERT_BODY);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vG3C;\nvarying vec2 vG3RM;\n')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * vG3C, opacity );')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vG3RM.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vG3RM.y;');
  };
  m.customProgramCacheKey = () => 'g3-merged';
  return m;
}
const TEX_SLOTS = ['map', 'normalMap', 'emissiveMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'bumpMap',
  'lightMap', 'displacementMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap',
  'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap'];
function plainMaterial(m) {
  if (!m || !m.isMeshStandardMaterial || m.transparent || m.alphaTest > 0 || m.opacity < 1 || m.vertexColors || m.flatShading) return false;
  if (m.emissive && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) return false;
  if (m.isMeshPhysicalMaterial && (m.transmission > 0 || m.iridescence > 0)) return false;
  return !TEX_SLOTS.some((k) => m[k]);
}
function mergeable(o) {
  const g = o.geometry;
  return o.isMesh && !o.isSkinnedMesh && !Array.isArray(o.material) && plainMaterial(o.material) &&
    g && g.attributes.position && g.attributes.normal && !g.attributes.color && !g.attributes._color &&
    !(g.morphAttributes && g.morphAttributes.position) && g.groups.length <= 1 && g.drawRange.count === Infinity &&
    !(o.isInstancedMesh && o.instanceColor);
}
// typed-array access to a (possibly interleaved, possibly normalised integer) attribute
function reader(a) {
  const ib = !!a.isInterleavedBufferAttribute;
  const arr = ib ? a.data.array : a.array;
  let s = 1;
  if (a.normalized) {
    s = arr instanceof Int8Array ? 1 / 127 : arr instanceof Uint8Array ? 1 / 255
      : arr instanceof Int16Array ? 1 / 32767 : arr instanceof Uint16Array ? 1 / 65535 : 1;
  }
  return { arr, st: ib ? a.data.stride : a.itemSize, off: ib ? a.offset : 0, s };
}
const _m3 = new THREE.Matrix3(), _col = new THREE.Color();
const _pm = new THREE.Matrix4(), _fr = new THREE.Frustum(), _sp = new THREE.Sphere();
// items: [{ geo, matrix (Matrix4 or null = identity), mat, far (optional coarser index of geo, for a far version) }]
// -> geometry; geometry.userData.far: the same vertices with the coarser indices (only when some item has one)
function buildMerged(items) {
  let nv = 0, ni = 0, nf = 0;
  for (const it of items) {
    const n = it.geo.attributes.position.count, c = it.geo.index ? it.geo.index.count : n;
    nv += n; ni += c; nf += it.far ? it.far.length : c;
  }
  const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 4), col = new Uint8Array(nv * 4);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const hasFar = items.some((it) => it.far);
  const fidx = hasFar ? (nv > 65535 ? new Uint32Array(nf) : new Uint16Array(nf)) : null;
  let vo = 0, io = 0, fo = 0;
  for (const it of items) {
    const g = it.geo, P = reader(g.attributes.position), N = reader(g.attributes.normal), n = g.attributes.position.count;
    const e = it.matrix ? it.matrix.elements : null;
    const ne = e ? _m3.getNormalMatrix(it.matrix).elements : null;
    _col.copy(it.mat.color).convertLinearToSRGB();
    const cr = Math.round(clamp(_col.r, 0, 1) * 255), cg = Math.round(clamp(_col.g, 0, 1) * 255), cb = Math.round(clamp(_col.b, 0, 1) * 255);
    const ro = Math.round(clamp(it.mat.roughness, 0, 1) * 255), me = Math.round(clamp(it.mat.metalness, 0, 1) * 127);
    for (let i = 0; i < n; i++) {
      const pi = P.off + i * P.st, ni3 = N.off + i * N.st;
      const x = P.arr[pi] * P.s, y = P.arr[pi + 1] * P.s, z = P.arr[pi + 2] * P.s;
      let a = Math.max(N.arr[ni3] * N.s, -1), b = Math.max(N.arr[ni3 + 1] * N.s, -1), c = Math.max(N.arr[ni3 + 2] * N.s, -1);
      const o3 = (vo + i) * 3, o4 = (vo + i) * 4;
      if (e) {
        pos[o3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[o3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[o3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        const a2 = ne[0] * a + ne[3] * b + ne[6] * c, b2 = ne[1] * a + ne[4] * b + ne[7] * c, c2 = ne[2] * a + ne[5] * b + ne[8] * c;
        a = a2; b = b2; c = c2;
      } else { pos[o3] = x; pos[o3 + 1] = y; pos[o3 + 2] = z; }
      const l = Math.hypot(a, b, c) || 1;
      nrm[o4] = Math.round(a / l * 127); nrm[o4 + 1] = Math.round(b / l * 127); nrm[o4 + 2] = Math.round(c / l * 127); nrm[o4 + 3] = me;
      col[o4] = cr; col[o4 + 1] = cg; col[o4 + 2] = cb; col[o4 + 3] = ro;
    }
    // a mirrored part (negative scale) is drawn flipped by three.js; baked into world space, flip its triangles
    const flip = !!(e && it.matrix.determinant() < 0);
    const put = (dst, o, a, c) => {
      for (let t = 0; t + 2 < c; t += 3) {
        const i0 = a ? a[t] : t, i1 = a ? a[t + 1] : t + 1, i2 = a ? a[t + 2] : t + 2;
        dst[o++] = i0 + vo;
        if (flip) { dst[o++] = i2 + vo; dst[o++] = i1 + vo; } else { dst[o++] = i1 + vo; dst[o++] = i2 + vo; }
      }
      return o;
    };
    const a0 = g.index ? g.index.array : null, c0 = g.index ? g.index.count : n;
    io = put(idx, io, a0, c0);
    if (fidx) fo = it.far ? put(fidx, fo, it.far, it.far.length) : put(fidx, fo, a0, c0);
    vo += n;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nb = new THREE.InterleavedBuffer(nrm, 4);
  geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(nb, 3, 0, true));
  geo.setAttribute('g3m', new THREE.InterleavedBufferAttribute(nb, 1, 3, true));
  geo.setAttribute('g3c', new THREE.BufferAttribute(col, 4, true));
  geo.setIndex(new THREE.BufferAttribute(io < idx.length ? idx.subarray(0, io) : idx, 1));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  if (fidx) geo.userData.far = lodGeometry(geo, fo < fidx.length ? fidx.subarray(0, fo) : fidx);
  return geo;
}
// the same vertices with other (coarser) indices: only an extra index buffer on the GPU
function lodGeometry(geo, index) {
  const g2 = new THREE.BufferGeometry();
  for (const name in geo.attributes) g2.setAttribute(name, geo.attributes[name]);
  g2.setIndex(new THREE.BufferAttribute(index, 1));
  g2.boundingBox = geo.boundingBox; g2.boundingSphere = geo.boundingSphere;
  return g2;
}

/* ---------- fullscreen helpers ---------- */
const FS_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const ENV_BLEND_FRAG = 'uniform sampler2D ta; uniform sampler2D tb; uniform float t; varying vec2 vUv;\n' +
  'void main() { gl_FragColor = mix(texture2D(ta, vUv), texture2D(tb, vUv), t); }';
const FADE_FRAG = 'uniform vec3 color; uniform float opacity; void main() { gl_FragColor = vec4(color, opacity);\n#include <colorspace_fragment>\n}';

export class Gym3D {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.keys = new Set();
    this.x = 0; this.z = 0; this.yaw = 0; this.pitch = 0; this.floorY = 0;
    this.vx = 0; this.vz = 0; this.turnVel = 0; this.zoom = 1; this.bump = 0;
    this.goal = null;
    this.ready = false; this.model = null; this.dirty = true; this.dead = false;
    this.fade = null; this.fadeA = 0;
    this.st = { x: 0, z: 0, yaw: 0, hfov: 1.2, place: null, map: null };
    this.last = performance.now();
    this.rendered = { x: NaN };
    this.perf = { acc: 0, n: 0, lastT: 0, good: 0, cool: 0 };
    this.open = true; this.waiters = []; this.instSets = []; this.tiles = [];

    this.tier = this.pickTier();
    // touch devices (phones and tablets) and low-memory ones: lighter model work (smaller textures, coarser thinning)
    this.light = this.tier === 'lo' || COARSE;
    const dpr = window.devicePixelRatio || 1;
    // a phone's dense screen hides jaggies; multisampling a 2-3x drawing buffer costs ~50 MB of GPU memory
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: !(COARSE && dpr >= 2), powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;          // photo skins must show the photos' own colours
    r.setClearColor(CLEAR, 1);
    // tablets: at most 1.5x (a 2x iPad screen is ~4.6 MP per frame)
    this.prMax = Math.min(dpr, COARSE && this.small ? 2 : 1.5);
    this.prMin = Math.min(1, this.prMax);
    this.pr = this.prMax;
    r.setPixelRatio(this.pr);
    this.canvas = r.domElement;
    this.canvas.className = 'wk-canvas';
    this.canvas.tabIndex = opts.tabIndex == null ? 0 : opts.tabIndex;
    // a lost WebGL context (phones under memory pressure, or after a long time in the background): the browser gives it
    // back later, and the image-based light has to be built again (its render target lost its contents)
    this.canvas.addEventListener('webglcontextlost', this.onLost = (e) => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', this.onRestored = () => { this.lost = false; this.restored = true; this.rebuildEnv(); this.dirty = true; });
    this.canvas.setAttribute('aria-label', '3D salon: yön tuşlarıyla yürüyün');
    root.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 90);
    this.camera.rotation.order = 'YXZ';
    this.skins = [];
    this.raycaster = new THREE.Raycaster();

    // walk target marker (tap / click) and hover marker (mouse)
    const ringGeo = new THREE.RingGeometry(0.17, 0.215, 48).rotateX(-Math.PI / 2);
    const mkRing = (color, opacity) => {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      m.renderOrder = 5; m.visible = false; this.scene.add(m);
      return m;
    };
    this.ring = mkRing(0xD6FB00, 0.95);
    this.hover = mkRing(0xffffff, 0.55);
    // fade to dark for jumps between places
    this.fadeMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0x0b0b0b) }, opacity: { value: 0 } },
      vertexShader: FS_VERT, fragmentShader: FADE_FRAG, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.fadeMesh.frustumCulled = false; this.fadeMesh.renderOrder = 1e6; this.fadeMesh.visible = false;
    this.scene.add(this.fadeMesh);

    this.bind();
    this.resize();
    if (DEBUG) window.__g3 = this;
    this._frame = (t) => this.frame(t);
    this.raf = requestAnimationFrame(this._frame);
  }

  pickTier() {
    const q = /[?&]g3q=(hi|lo)\b/.exec(location.search);
    const mem = navigator.deviceMemory || 8;
    const small = this.small = Math.min(screen.width || 9999, screen.height || 9999) < 820;
    if (q) return q[1];
    return (COARSE && small) || mem <= 4 ? 'lo' : 'hi';
  }
  // loading only goes on while the viewer is shown (closed: no downloads on phones, no main-thread work anywhere)
  whenOpen() { return this.open || this.dead ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); }
  async tick() { await nextFrame(); await this.whenOpen(); if (this.dead) throw Object.assign(new Error('destroyed'), { g3abort: true }); }
  async get(url, onp) {
    for (;;) {
      await this.whenOpen();
      if (this.dead) throw Object.assign(new Error('destroyed'), { g3abort: true });
      if (!this.ac || this.ac.signal.aborted) this.ac = typeof AbortController === 'function' ? new AbortController() : null;
      const ac = this.ac;
      try { return await fetchBuf(url, onp, ac && ac.signal); } catch (e) {
        if (!aborted(e) || !ac || !ac.signal.aborted) throw e;
        // closed while downloading: start again when shown (the HTTP cache keeps what had finished)
      }
    }
  }

  /* ---------- data ---------- */
  async load(baseUrl) {
    // files sit next to each other in baseUrl's folder; its query (e.g. ?v=2) is kept on every file for cache busting
    const base = new URL(baseUrl, location.href), q = base.search;
    this.dir = new URL('.', base).href;
    const url = (f) => new URL(f, this.dir).href + q;
    this.url = url;
    if (this.renderer.capabilities.maxTextureSize < 4096) throw new Error('maxTextureSize');
    const prog = new Progress((p) => { if (this.opts.onProgress) this.opts.onProgress(p); });
    const getJSON = (f) => this.get(url(f)).then((b) => JSON.parse(new TextDecoder().decode(b)));
    const [places, walk, map, skins] = await Promise.all(['places.json', 'walk.json', 'map.json', `skins_${this.tier}.json`].map(getJSON));
    this.places = places; this.walkInfo = walk; this.mapInfo = map;
    this.eye = places.eye || EYE;

    // everything needed to start, downloaded together (progress for the start button)
    const pBin = prog.add('bin', 140e3), pWalk = prog.add('walk', 15e3), pMap = prog.add('map', 60e3);
    const pPages = skins.pages.map((n, k) => prog.add('page' + k, this.tier === 'hi' ? 2.6e6 : 2.9e6));
    const pEnv = prog.add('env', 35e3);
    this.ktx2 = new KTX2Loader().setTranscoderPath(JSM + 'libs/basis/').setWorkerLimit(2).detectSupport(this.renderer);
    const ktx = (buf) => (this.ktx2._createTexture ? this.ktx2._createTexture(buf)
      : this.ktx2.loadAsync(URL.createObjectURL(new Blob([buf]))));
    const pages = Promise.all(skins.pages.map((n, k) => this.get(url(n + '.ktx2'), pPages[k]).then(ktx)));
    const bin = this.get(url(`skins_${this.tier}.bin`), pBin);
    const grid = this.get(url('walk.png'), pWalk).then((b) => this.readGrid(b));
    const mapImg = this.get(url('map.jpg'), pMap).then((b) => this.readMap(b));
    // all run together; whichever fails first fails the load (the others must not end up as unhandled rejections)
    [pages, bin, mapImg].forEach((p) => p.catch(() => {}));
    await grid;
    this.initPlaces();
    // opts.start: where the walker was before the viewer was let go of (it reopens there)
    const start = this.opts.start || this.placeById('giris') || places.places[0];
    const sp = this.nudge(start.x, start.z);
    this.x = sp.x; this.z = sp.z; this.yaw = start.yaw || 0; this.pitch = 0;
    this.floorY = this.platAt(this.x, this.z) ? (walk.platform_h || 0.15) : 0;
    const env = this.initEnv().then(() => pEnv(1, 1));
    const [texs, buf] = await Promise.all([pages, bin, mapImg, env]);
    await this.whenOpen();
    if (this.dead) return;
    this.buildSkins(skins, buf, texs);
    this.ready = true;
    this.dirty = true;
    if (this.opts.onProgress) this.opts.onProgress(1);
    // the 3D equipment streams in behind the photos
    this.modelPromise = this.loadModel().catch((err) => {
      if (this.dead || aborted(err)) return;
      if (this.opts.onModel) this.opts.onModel(1);
      console.warn('3D salon: model', err);
    });
  }

  readGrid(buf) {
    return this.decodeImage(buf, 'image/png').then((img) => {
      const W = this.walkInfo, c = document.createElement('canvas');
      c.width = W.w; c.height = W.h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W.w, W.h);
      const d = ctx.getImageData(0, 0, W.w, W.h).data, n = W.w * W.h;
      const blk = new Uint8Array(n), plat = new Uint8Array(n);
      for (let i = 0; i < n; i++) { blk[i] = d[i * 4] > 127 ? 1 : 0; plat[i] = d[i * 4 + 1] > 127 ? 1 : 0; }
      if (img.close) img.close();
      this.grid = { x0: W.x0, y1: W.y1, res: W.res, w: W.w, h: W.h, blk, plat, reach: null };
    });
  }
  async decodeImage(buf, type, element) {
    const blob = new Blob([buf], { type });
    if (!element && typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { /* older Safari: below */ }
    }
    const img = new Image(), u = URL.createObjectURL(blob);
    img.src = u;
    await img.decode();
    URL.revokeObjectURL(u);
    return img;
  }
  readMap(buf) {
    return this.decodeImage(buf, 'image/jpeg').then((img) => {
      const M = this.mapInfo, c = document.createElement('canvas');
      c.width = M.w; c.height = M.h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, M.w, M.h);
      // crop to the building (the image has a black margin)
      const d = ctx.getImageData(0, 0, M.w, M.h).data;
      let i0 = M.w, i1 = 0, j0 = M.h, j1 = 0;
      for (let j = 0; j < M.h; j += 2) for (let i = 0; i < M.w; i += 2) {
        const k = (j * M.w + i) * 4;
        if (d[k] + d[k + 1] + d[k + 2] > 45) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
      }
      if (i1 <= i0) { i0 = 0; i1 = M.w; j0 = 0; j1 = M.h; }
      // the plan is stored dimmed: lift it so it reads on a small screen
      const im = ctx.getImageData(0, 0, M.w, M.h), px = im.data;
      for (let k = 0; k < px.length; k += 4) { px[k] = Math.min(255, px[k] * 1.7); px[k + 1] = Math.min(255, px[k + 1] * 1.7); px[k + 2] = Math.min(255, px[k + 2] * 1.7); }
      ctx.putImageData(im, 0, 0);
      const pad = 6;
      i0 = Math.max(0, i0 - pad); j0 = Math.max(0, j0 - pad); i1 = Math.min(M.w, i1 + pad); j1 = Math.min(M.h, j1 + pad);
      const sx = (M.x1 - M.x0) / M.w, sz = (M.z1 - M.z0) / M.h;
      this.st.map = { img: c, i0, j0, i1, j1, x0: M.x0 + i0 * sx, x1: M.x0 + i1 * sx, z0: M.z0 + j0 * sz, z1: M.z0 + j1 * sz };
      if (img.close) img.close();
    });
  }

  /* ---------- walk grid ---------- */
  cell(x, z) {
    const g = this.grid;
    const i = Math.floor((x - g.x0) / g.res), j = Math.floor((z + g.y1) / g.res);
    return i < 0 || j < 0 || i >= g.w || j >= g.h ? -1 : j * g.w + i;
  }
  free(x, z) { const c = this.cell(x, z); return c >= 0 && !this.grid.blk[c]; }
  platAt(x, z) { const c = this.cell(x, z); return c >= 0 && !!this.grid.plat[c]; }
  center(c) { const g = this.grid; return { x: g.x0 + ((c % g.w) + 0.5) * g.res, z: ((Math.floor(c / g.w)) + 0.5) * g.res - g.y1 }; }
  // the walkable area reachable from the entrance (a pocket enclosed by equipment is not a place to start in)
  initPlaces() {
    const g = this.grid, n = g.w * g.h, reach = new Uint8Array(n);
    const s = this.placeById('giris') || this.places.places[0];
    let c0 = this.cell(s.x, s.z);
    if (c0 < 0 || g.blk[c0]) c0 = this.search(s.x, s.z, (c) => !g.blk[c], 120);
    if (c0 >= 0) {
      const q = new Int32Array(n);
      let h = 0, t = 0;
      q[t++] = c0; reach[c0] = 1;
      const visit = (d) => { if (!reach[d] && !g.blk[d]) { reach[d] = 1; q[t++] = d; } };
      while (h < t) {
        const c = q[h++], i = c % g.w;
        if (i > 0) visit(c - 1);
        if (i < g.w - 1) visit(c + 1);
        if (c >= g.w) visit(c - g.w);
        if (c + g.w < n) visit(c + g.w);
      }
    }
    g.reach = reach;
    // distance to the nearest blocked cell (in cells, capped): routes keep to the middle of lanes and gaps
    const dist = new Uint8Array(n), W = g.w, H = g.h, CAP = 12;
    for (let c = 0; c < n; c++) dist[c] = g.blk[c] ? 0 : CAP;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i; let d = dist[c];
      if (!d) continue;
      if (i > 0) d = Math.min(d, dist[c - 1] + 1);
      if (j > 0) { d = Math.min(d, dist[c - W] + 1); if (i > 0) d = Math.min(d, dist[c - W - 1] + 1); if (i < W - 1) d = Math.min(d, dist[c - W + 1] + 1); }
      dist[c] = d;
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const c = j * W + i; let d = dist[c];
      if (!d) continue;
      if (i < W - 1) d = Math.min(d, dist[c + 1] + 1);
      if (j < H - 1) { d = Math.min(d, dist[c + W] + 1); if (i < W - 1) d = Math.min(d, dist[c + W + 1] + 1); if (i > 0) d = Math.min(d, dist[c + W - 1] + 1); }
      dist[c] = d;
    }
    g.dist = dist;
    // lighting: only captures in (or right next to) the walkable area
    const caps = this.places.captures || [];
    this.caps = caps.filter((cp) => { const c = this.cell(cp.x, cp.z); return c >= 0 && (reach[c] || g.blk[c]); });
    if (!this.caps.length) this.caps = caps;
  }
  // nearest grid cell (within maxR cells) passing ok(c)
  search(x, z, ok, maxR) {
    const g = this.grid, c = this.cell(x, z);
    if (c < 0) return -1;
    if (ok(c)) return c;
    const ci = c % g.w, cj = Math.floor(c / g.w);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= maxR; r++) {
      for (let dj = -r; dj <= r; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= g.h) continue;
        const step = Math.abs(dj) === r ? 1 : 2 * r;
        for (let di = -r; di <= r; di += step) {
          const i = ci + di;
          if (i < 0 || i >= g.w) continue;
          const k = j * g.w + i;
          if (ok(k)) { const d = di * di + dj * dj; if (d < bd) { bd = d; best = k; } }
        }
      }
      if (best >= 0 && r * r > bd) break;
    }
    return best;
  }
  nudge(x, z) {
    const g = this.grid;
    let c = this.search(x, z, (k) => g.reach[k] === 1, 160);
    if (c < 0) c = this.search(x, z, (k) => !g.blk[k], 160);
    return c < 0 ? { x, z } : (this.cell(x, z) === c ? { x, z } : this.center(c));
  }
  placeById(id) { return this.places && (this.places.places || []).find((p) => p.id === id); }

  /* ---------- photo skins ---------- */
  buildSkins(meta, buf, texs) {
    const aniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), this.tier === 'hi' ? 8 : 4);
    texs.forEach((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.anisotropy = aniso;
      t.needsUpdate = true;
      this.renderer.initTexture(t);
    });
    this.atlases = texs;
    const mats = texs.map((t) => new THREE.MeshBasicMaterial({
      map: t, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    }));
    for (const c of meta.chunks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, c.pos, c.vertices * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, c.uv, c.vertices * 2), 2));
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, c.idx, c.indices), 1));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mats[c.page]);
      m.renderOrder = -1;           // first: the photos hide the plain walls behind them before those are shaded
      m.userData.floor = !!c.floor;
      m.matrixAutoUpdate = false;
      this.scene.add(m);
      this.skins.push(m);
    }
  }

  /* ---------- light from the real 360° photos ---------- */
  async initEnv() {
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envCache = new Map();
    this.blendRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
    this.blendMat = new THREE.ShaderMaterial({
      uniforms: { ta: { value: null }, tb: { value: null }, t: { value: 0 } },
      vertexShader: FS_VERT, fragmentShader: ENV_BLEND_FRAG, depthTest: false, depthWrite: false,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMat);
    q.frustumCulled = false;
    this.blendScene = new THREE.Scene(); this.blendScene.add(q);
    this.blendCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const c = this.nearestCap(this.x, this.z);
    const tex = await this.envTex(c);
    this.envCur = c; this.envWant = c; this.envTr = null;
    this.envRT = this.pmrem.fromEquirectangular(tex);
    this.scene.environment = this.envRT.texture;
    this.prefetchEnv();
  }
  // after a lost WebGL context came back: a fresh PMREM generator and light (the old ones belonged to the lost context)
  rebuildEnv() {
    if (!this.pmrem || this.dead) return;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.blendRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
    this.envTr = null;
    const e = this.envCur && this.envCache.get(this.envCur.id);
    if (!e || !e.tex) return;
    this.envRT = this.pmrem.fromEquirectangular(e.tex);
    this.scene.environment = this.envRT.texture;
  }
  nearestCap(x, z) {
    let best = null, bd = Infinity;
    for (const c of this.caps) { const d = (c.x - x) ** 2 + (c.z - z) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  }
  envTex(c) {
    let e = this.envCache.get(c.id);
    if (!e) {
      e = { tex: null, used: 0 };
      e.p = this.get(this.url('env/' + c.id + '.jpg')).then((b) => this.decodeImage(b, 'image/jpeg', true)).then((img) => {
        const t = new THREE.Texture(img);
        t.needsUpdate = true;
        t.colorSpace = THREE.SRGBColorSpace;
        t.mapping = THREE.EquirectangularReflectionMapping;
        t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
        if (this.dead) { t.dispose(); return t; }
        this.renderer.initTexture(t);
        e.tex = t;
        return t;
      });
      e.p.catch(() => { if (this.envCache && this.envCache.get(c.id) === e) this.envCache.delete(c.id); });   // try again later
      this.envCache.set(c.id, e);
      // keep a handful in memory
      if (this.envCache.size > 10) {
        const old = [...this.envCache.entries()].filter(([id, v]) => v.tex && id !== (this.envCur && this.envCur.id) && id !== (this.envWant && this.envWant.id) && !(this.envTr && (id === this.envTr.from.id || id === this.envTr.to.id)))
          .sort((a, b) => a[1].used - b[1].used);
        if (old.length) { old[0][1].tex.dispose(); this.envCache.delete(old[0][0]); }
      }
    }
    e.used = performance.now();
    return e.p;
  }
  prefetchEnv() {
    const near = [...this.caps].sort((a, b) => ((a.x - this.x) ** 2 + (a.z - this.z) ** 2) - ((b.x - this.x) ** 2 + (b.z - this.z) ** 2));
    near.slice(0, 4).forEach((c) => this.envTex(c).catch(() => {}));
  }
  envReady(c) { const e = this.envCache.get(c.id); return !!(e && e.tex); }
  envApply(a, b, t) {
    if (t >= 1 || a === b) this.pmrem.fromEquirectangular(this.envCache.get(b.id).tex, this.envRT);
    else {
      const u = this.blendMat.uniforms;
      u.ta.value = this.envCache.get(a.id).tex; u.tb.value = this.envCache.get(b.id).tex; u.t.value = t;
      const r = this.renderer, prev = r.getRenderTarget();
      r.setRenderTarget(this.blendRT); r.render(this.blendScene, this.blendCam); r.setRenderTarget(prev);
      this.pmrem.fromEquirectangular(this.blendRT.texture, this.envRT);
    }
  }
  envStep(now) {
    if (!this.envRT || !this.caps.length) return;
    const c = this.nearestCap(this.x, this.z);
    if (c !== this.envWant) {
      const d = (p) => Math.hypot(p.x - this.x, p.z - this.z);
      if (d(c) < d(this.envWant) - 0.5) { this.envWant = c; this.envTex(c).catch(() => {}); this.prefetchEnv(); }
    }
    if (!this.envTr && this.envWant !== this.envCur && this.envReady(this.envWant) && this.envReady(this.envCur)) {
      if (!this.model) { this.envCur = this.envWant; this.envStale = true; return; }   // nothing lit yet: switch quietly
      this.envTr = { from: this.envCur, to: this.envWant, t0: now, k: 0 };
    }
    if (this.envTr) {
      const tr = this.envTr, t = clamp((now - tr.t0) / ENV_FADE, 0, 1);
      // phones: refresh the light every other frame while it fades
      if (t >= 1 || this.tier === 'hi' || (tr.k++ & 1) === 0) { this.envApply(tr.from, tr.to, smooth(t)); this.dirty = true; }
      if (t >= 1) { this.envCur = tr.to; this.envTr = null; }
    } else if (this.envStale && this.model) { this.envStale = false; this.envApply(this.envCur, this.envCur, 1); this.dirty = true; }
  }

  /* ---------- the 3D equipment ---------- */
  async loadModel() {
    const onModel = (p) => { if (this.opts.onModel) this.opts.onModel(p); };
    onModel(0);
    MeshoptDecoder.useWorkers && MeshoptDecoder.useWorkers(Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
    // never 100% before the model is in the scene (the size may be an estimate)
    const buf = await this.get(this.url('gym.glb'), (g, t) => onModel(0.85 * Math.min(0.98, g / (t || 13e6))));
    await this.whenOpen();
    if (this.dead) return;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(this.ktx2);
    const gltf = await loader.parseAsync(buf, this.dir);
    await this.whenOpen();
    if (this.dead) return;
    onModel(0.9);
    const group = gltf.scene;
    await this.prepareModel(group);
    if (this.dead) return;
    onModel(0.96);
    await this.whenOpen();
    try { await this.renderer.compileAsync(group, this.camera, this.scene); } catch (e) { /* compiled on first draw instead */ }
    if (this.dead) return;
    // upload the textures a few at a time, so the first frame with the model does not stall
    const texs = new Set();
    group.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => TEX_SLOTS.forEach((k) => m && m[k] && texs.add(m[k]))); });
    let t0 = performance.now();
    for (const t of texs) {
      this.renderer.initTexture(t);
      if (performance.now() - t0 > 10) { await this.tick(); t0 = performance.now(); }
    }
    await this.whenOpen();
    if (this.dead) return;
    this.scene.add(group);
    this.model = group;
    this.envStale = true;
    this.dirty = true;
    onModel(1);
  }
  // thin over-detailed geometry (relative error: a fraction of each part's size; only the index buffer changes).
  // meshoptimizer runs in a worker, so walking is not interrupted while the equipment loads
  async simplify(root) {
    const err = this.light ? 0.004 : 0.002;
    const geos = new Set(), jobs = [], list = [];
    root.traverse((o) => { if (o.isMesh && o.geometry) geos.add(o.geometry); });
    for (const g of geos) {
      const I = g.index;
      if (!I || I.count < 9000 || g.groups.length > 1 || (g.morphAttributes && g.morphAttributes.position)) continue;
      jobs.push({ idx: indexU32(I), pos: positions(g), target: Math.floor(I.count * 0.2 / 3) * 3, err });
      list.push(g);
    }
    const out = await simplifyJobs(jobs, () => this.tick());
    await this.whenOpen();
    list.forEach((g, k) => {
      const r = out[k], I = g.index, n = g.attributes.position.count;
      if (r && r.length > 0 && r.length < I.count * 0.9) g.setIndex(new THREE.BufferAttribute(n > 65535 ? r : new Uint16Array(r), 1));
    });
  }
  // the separate pieces of a mesh made of many joined parts (triangles linked by shared corners, welded by position: a
  // box's faces do not share vertices), with their world bounds. Only triangles wholly above yMin (m) are looked at.
  // -> { tri: piece of each triangle (-1: not looked at), box: [x0, y0, z0, x1, y1, z1] per piece }
  pieces(o, yMin = -Infinity) {
    const g = o.geometry, I = g.index, n = g.attributes.position.count, pos = positions(g), e = o.matrixWorld.elements;
    const wy = new Float32Array(n), wx = new Float32Array(n), wz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      wx[i] = e[0] * x + e[4] * y + e[8] * z + e[12]; wy[i] = e[1] * x + e[5] * y + e[9] * z + e[13]; wz[i] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const ix = I.array, cnt = I.count, nt = cnt / 3, use = new Uint8Array(nt);
    const id = new Int32Array(n).fill(-1), key = new Map();
    for (let t = 0; t < nt; t++) {
      const a = ix[t * 3], b = ix[t * 3 + 1], c = ix[t * 3 + 2];
      if (wy[a] < yMin || wy[b] < yMin || wy[c] < yMin) continue;
      use[t] = 1;
      for (const v of [a, b, c]) {
        if (id[v] >= 0) continue;
        const k = Math.round(pos[v * 3] * 1e4) + ',' + Math.round(pos[v * 3 + 1] * 1e4) + ',' + Math.round(pos[v * 3 + 2] * 1e4);
        if (!key.has(k)) key.set(k, key.size);
        id[v] = key.get(k);
      }
    }
    const par = new Int32Array(key.size).map((_, i) => i);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let t = 0; t < nt; t++) {
      if (!use[t]) continue;
      const a = find(id[ix[t * 3]]), b = find(id[ix[t * 3 + 1]]);
      par[b] = a; par[find(id[ix[t * 3 + 2]])] = a;
    }
    const tri = new Int32Array(nt).fill(-1), box = new Map();
    for (let t = 0; t < nt; t++) {
      if (!use[t]) continue;
      const r = tri[t] = find(id[ix[t * 3]]);
      let bb = box.get(r);
      if (!bb) box.set(r, bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (let k = 0; k < 3; k++) {
        const v = ix[t * 3 + k];
        bb[0] = Math.min(bb[0], wx[v]); bb[1] = Math.min(bb[1], wy[v]); bb[2] = Math.min(bb[2], wz[v]);
        bb[3] = Math.max(bb[3], wx[v]); bb[4] = Math.max(bb[4], wy[v]); bb[5] = Math.max(bb[5], wz[v]);
      }
    }
    return { tri, box };
  }
  // keep only the triangles where keep(t) is true; the others (if out) go to a new index list
  static split(g, keep) {
    const ix = g.index.array, cnt = g.index.count, a = [], b = [];
    for (let t = 0; t < cnt; t += 3) (keep(t / 3) ? a : b).push(ix[t], ix[t + 1], ix[t + 2]);
    const T = g.attributes.position.count > 65535 ? Uint32Array : Uint16Array;
    return [new T(a), new T(b)];
  }
  // parts that only repeat what the photos already show, and would cover them: the brick cladding and the round lit
  // mirrors on the photographed brick wall, and the flat white boxes (vents, detectors) a few cm below the ceiling photo.
  // And the hanging LED strips: modelled as a 6 cm black bar with a hairline diffuser under it, where the photos show
  // bright bars; the bar above each diffuser is drawn glowing too
  cleanModel(root) {
    const drop = [];
    root.traverse((o) => { if (o.isMesh && /^(brickC|porthole)/.test(o.name || (o.parent && o.parent.name) || '')) drop.push(o); });
    drop.forEach((o) => { o.parent.remove(o); o.geometry.dispose(); });
    root.updateMatrixWorld(true);
    const plainOf = (name) => {
      const l = [];
      root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh && !Array.isArray(o.material) && o.material && o.material.name === name && o.geometry.index) l.push(o); });
      return l;
    };
    for (const o of plainOf('white')) {
      const P = this.pieces(o), g = o.geometry;
      const [keep, out] = Gym3D.split(g, (t) => { const b = P.box.get(P.tri[t]); return !(b && b[1] > 2.6 && b[4] - b[1] < 0.08); });
      if (out.length) g.setIndex(new THREE.BufferAttribute(keep, 1));
    }
    const strips = [];
    let led = null;
    for (const o of plainOf('led_white')) {
      led = led || o.material;
      this.pieces(o, 2.2).box.forEach((b) => { if (b[4] - b[1] < 0.012 && Math.max(b[3] - b[0], b[5] - b[2]) > 0.5) strips.push(b); });
    }
    if (!strips.length) return;
    for (const o of plainOf('matte_black')) {
      const P = this.pieces(o, 2.2), hit = new Set();
      P.box.forEach((b, r) => {
        const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
        if (b[4] - b[1] > 0.09) return;
        if (strips.some((s) => cx > s[0] - 0.03 && cx < s[3] + 0.03 && cz > s[2] - 0.03 && cz < s[5] + 0.03 && Math.abs(b[1] - s[4]) < 0.015)) hit.add(r);
      });
      if (!hit.size) continue;
      const g = o.geometry, [keep, out] = Gym3D.split(g, (t) => !hit.has(P.tri[t]));
      g.setIndex(new THREE.BufferAttribute(keep, 1));
      const g2 = lodGeometry(g, out);
      const m = new THREE.Mesh(g2, led);
      m.name = 'led_bars'; m.matrixAutoUpdate = false; m.matrix.copy(o.matrixWorld); m.matrixWorld.copy(o.matrixWorld);
      if (!g.boundingBox) g.computeBoundingBox();
      g2.boundingBox = null; g2.boundingSphere = null; g2.computeBoundingSphere();
      root.add(m);
    }
  }
  async prepareModel(root) {
    this.cleanModel(root);
    await this.simplify(root);
    if (this.dead) return;
    root.updateMatrixWorld(true);
    const lo = this.light;
    const aniso = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4);
    const plain = [], inst = new Map(), seen = new Set();
    root.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach((m, k) => {
        if (!m || seen.has(m)) return;
        seen.add(m);
        if ('envMapIntensity' in m) m.envMapIntensity = ENV_INT;
        TEX_SLOTS.forEach((s) => { if (m[s] && !lo) m[s].anisotropy = aniso; });
      });
      if (!mergeable(o)) return;
      if (o.isInstancedMesh) {
        const key = o.parent.uuid + ':' + o.count;
        if (!inst.has(key)) inst.set(key, []);
        inst.get(key).push(o);
      } else plain.push(o);
    });
    const mats = new Map();
    const matFor = (side) => { if (!mats.has(side)) mats.set(side, mergedMaterial(side)); return mats.get(side); };
    const out = new THREE.Group();
    out.name = 'g3-merged';
    // static parts: per tile and side
    const groups = new Map(), box = new THREE.Box3(), cen = new THREE.Vector3();
    for (const o of plain) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).getCenter(cen);
      const key = o.material.side + ':' + Math.floor(cen.x / CELL) + ',' + Math.floor(cen.z / CELL);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    // detailed parts also get a coarser version for tiles far away (1.5-2 cm cells: a pixel or two beyond 10 m)
    const farIdx = new Map();
    let t0 = performance.now();
    for (const o of plain) {
      const g = o.geometry, I = g.index;
      if (!I || I.count < 3600 || farIdx.has(g)) continue;
      const r = clusterIndex(I, positions(g), (lo ? 0.02 : 0.015) / (o.matrixWorld.getMaxScaleOnAxis() || 1));
      farIdx.set(g, r.length < I.count * 0.8 ? r : null);
      if (performance.now() - t0 > 12) { await this.tick(); t0 = performance.now(); }
    }
    for (const list of groups.values()) {
      const geo = buildMerged(list.map((o) => ({ geo: o.geometry, matrix: o.matrixWorld, mat: o.material, far: farIdx.get(o.geometry) })));
      const m = new THREE.Mesh(geo, matFor(list[0].material.side));
      m.matrixAutoUpdate = false;
      out.add(m);
      if (geo.userData.far) this.tiles.push({ mesh: m, near: geo, far: geo.userData.far, box: geo.boundingBox });
      list.forEach((o) => { o.parent.remove(o); o.geometry.dispose(); });
      if (performance.now() - t0 > 12) { await this.tick(); t0 = performance.now(); }
    }
    // instanced parts: the plain-coloured pieces of one instanced object become one instanced draw
    for (const list of inst.values()) {
      if (list.length < 2) continue;
      const a0 = list[0].instanceMatrix.array;
      const same = list.filter((o) => { const a = o.instanceMatrix.array; if (a.length !== a0.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== a0[i]) return false; return true; });
      const bySide = new Map();
      same.forEach((o) => { if (!bySide.has(o.material.side)) bySide.set(o.material.side, []); bySide.get(o.material.side).push(o); });
      for (const [side, l] of bySide) {
        if (l.length < 2) continue;
        const parent = l[0].parent;
        const geo = buildMerged(l.map((o) => ({ geo: o.geometry, matrix: o.matrix.equals(new THREE.Matrix4()) ? null : o.matrix, mat: o.material })));
        const im = new THREE.InstancedMesh(geo, matFor(side), l[0].count);
        im.instanceMatrix.array.set(l[0].instanceMatrix.array);
        im.computeBoundingSphere();
        parent.add(im);
        l.forEach((o) => { parent.remove(o); o.geometry.dispose(); });
      }
      if (performance.now() - t0 > 12) { await this.tick(); t0 = performance.now(); }
    }
    root.add(out);
    // materials nothing uses any more
    const used = new Set();
    root.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => used.add(m)); });
    seen.forEach((m) => { if (!used.has(m)) m.dispose(); });
    // phones: model textures at most 512 px (a quarter of the GPU memory; they are small on screen anyway)
    if (lo) {
      const texs = new Set();
      root.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => TEX_SLOTS.forEach((k) => m && m[k] && texs.add(m[k]))); });
      for (const t of texs) {
        const img = t.image, w = img && (img.width || img.naturalWidth), h = img && (img.height || img.naturalHeight);
        if (!w || !h || Math.max(w, h) <= 512) continue;
        const k = 512 / Math.max(w, h), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (img.close) img.close();
        t.image = c; t.needsUpdate = true;
        if (performance.now() - t0 > 12) { await this.tick(); t0 = performance.now(); }
      }
    }
    // phones: the cheaper standard shader for the remaining parts (no clear coat / sheen layers)
    if (lo) {
      root.traverse((o) => {
        if (!o.isMesh || Array.isArray(o.material)) return;
        const m = o.material;
        if (m.isMeshPhysicalMaterial && !(m.transmission > 0)) {
          if (!m.userData.g3std) { m.userData.g3std = new THREE.MeshStandardMaterial().copy(m); m.userData.g3std.name = m.name; }
          o.material = m.userData.g3std;
        }
      });
    }
    // the hanging LED strips: the glowing diffuser sits a hair under the black housing; let it win the depth test
    // (in the photos they read as bright bars). Mirrors: the light photo is coarse (0.7° per pixel), so a perfectly
    // sharp mirror only shows blur; a slightly satin finish makes that blur read as intended
    root.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m) return;
        if (/^led_/.test(m.name)) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -8; }
        if (m.name === 'mirror' && 'roughness' in m) { m.roughness = Math.max(m.roughness, 0.14); m.metalness = Math.min(m.metalness, 0.9); }
      });
    });
    root.updateMatrixWorld(true);
    await this.prepareInstances(root);
  }
  // instanced parts are culled per copy (three.js culls an InstancedMesh as one sphere around all its copies, so a set
  // spread over the gym would always be drawn in full); heavy ones also get a light version for copies far away
  async prepareInstances(root) {
    if (this.dead) return;
    const list = [];
    root.traverse((o) => { if (o.isInstancedMesh && o.count > 1) list.push(o); });
    const m4 = new THREE.Matrix4(), v = new THREE.Vector3();
    let t0 = performance.now();
    for (const o of list) {
      const n = o.count, geo = o.geometry;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const bs = geo.boundingSphere, src = o.instanceMatrix.array.slice(0, n * 16);
      const col = o.instanceColor ? o.instanceColor.array.slice(0, n * 3) : null;
      const sph = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        m4.fromArray(src, i * 16).premultiply(o.matrixWorld);
        v.copy(bs.center).applyMatrix4(m4);
        sph[i * 4] = v.x; sph[i * 4 + 1] = v.y; sph[i * 4 + 2] = v.z; sph[i * 4 + 3] = bs.radius * m4.getMaxScaleOnAxis();
      }
      o.frustumCulled = false;
      o.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const set = { mesh: o, far: null, n, src, col, sph, sig: '' };
      this.instSets.push(set);
      const I = geo.index;
      if (!I || I.count / 3 <= LOD_TRIS || geo.groups.length) continue;
      // 1.2 cm cells in the world (the copies' own scale taken out)
      const sc = bs.radius > 0 ? sph[3] / bs.radius : 1;
      const r = clusterIndex(I, positions(geo), 0.012 / (sc || 1));
      if (performance.now() - t0 > 12) { await this.tick(); t0 = performance.now(); }
      if (!r.length || r.length > I.count * 0.6) continue;
      const far = new THREE.InstancedMesh(lodGeometry(geo, geo.attributes.position.count > 65535 ? r : new Uint16Array(r)), o.material, n);
      far.name = o.name + '_far';
      far.frustumCulled = false; far.count = 0; far.visible = false;
      far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (col) far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      far.matrixAutoUpdate = o.matrixAutoUpdate; far.matrix.copy(o.matrix); far.position.copy(o.position); far.quaternion.copy(o.quaternion); far.scale.copy(o.scale);
      o.parent.add(far);
      set.far = far;
    }
  }
  // which copies of each instanced part are in view, and which of them are far; far tiles use their coarser version
  // (after the camera moved)
  cullInstances() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    for (const t of this.tiles) {
      const g = t.box.distanceToPoint(cam.position) > TILE_LOD_D ? t.far : t.near;
      if (t.mesh.geometry !== g) t.mesh.geometry = g;
    }
    if (!this.instSets.length) return;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm);
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    for (const s of this.instSets) {
      const near = s.mesh, far = s.far, A = near.instanceMatrix.array, B = far && far.instanceMatrix.array;
      let a = 0, b = 0, sig = '';
      for (let i = 0; i < s.n; i++) {
        _sp.center.set(s.sph[i * 4], s.sph[i * 4 + 1], s.sph[i * 4 + 2]); _sp.radius = s.sph[i * 4 + 3];
        if (!_fr.intersectsSphere(_sp)) continue;
        const isFar = !!B && Math.hypot(_sp.center.x - px, _sp.center.y - py, _sp.center.z - pz) - _sp.radius > LOD_D;
        sig += (isFar ? 'f' : 'n') + i;
        if (isFar) {
          for (let k = 0; k < 16; k++) B[b * 16 + k] = s.src[i * 16 + k];
          if (s.col) for (let k = 0; k < 3; k++) far.instanceColor.array[b * 3 + k] = s.col[i * 3 + k];
          b++;
        } else {
          for (let k = 0; k < 16; k++) A[a * 16 + k] = s.src[i * 16 + k];
          if (s.col) for (let k = 0; k < 3; k++) near.instanceColor.array[a * 3 + k] = s.col[i * 3 + k];
          a++;
        }
      }
      if (sig === s.sig) continue;
      s.sig = sig;
      near.count = a; near.visible = a > 0; near.instanceMatrix.needsUpdate = true;
      if (s.col) near.instanceColor.needsUpdate = true;
      if (far) { far.count = b; far.visible = b > 0; far.instanceMatrix.needsUpdate = true; if (s.col) far.instanceColor.needsUpdate = true; }
    }
  }

  /* ---------- frame loop ---------- */
  frame(now) {
    if (this.dead) return;
    this.raf = requestAnimationFrame(this._frame);
    const dt = clamp((now - this.last) / 1000, 0, 0.1);
    this.last = now;
    if (!this.ready) return;
    this.step(dt);
    this.envStep(now);
    this.fadeStep(dt);
    const cam = this.camera;
    const eyeY = this.floorY + this.eye;
    let fov = this.baseFov() * this.zoom;
    if (this.bump > 0) { fov += 3 * Math.sin(Math.PI * this.bump); this.bump = Math.max(0, this.bump - dt * 3.5); this.dirty = true; }
    const R = this.rendered;
    const moved = R.x !== this.x || R.z !== this.z || R.y !== eyeY || R.yaw !== this.yaw || R.pitch !== this.pitch || R.fov !== fov;
    if (!moved && !this.dirty) { this.drewLast = false; return; }
    if (this.lost) return;
    cam.position.set(this.x, eyeY, this.z);
    cam.rotation.set(this.pitch, this.yaw, 0);
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    R.x = this.x; R.z = this.z; R.y = eyeY; R.yaw = this.yaw; R.pitch = this.pitch; R.fov = fov;
    this.dirty = false;
    this.cullInstances();
    this.renderer.render(this.scene, cam);
    this.adapt(now, this.drewLast);
    this.drewLast = true;
    const st = this.st;
    st.x = this.x; st.z = this.z; st.yaw = this.yaw;
    st.hfov = 2 * Math.atan(Math.tan(fov * Math.PI / 360) * cam.aspect);
    st.place = this.nearestPlace();
    if (this.opts.onFrame) this.opts.onFrame(st);
  }
  baseFov() {
    // vertical field of view: wide enough sideways on a tall phone screen without fish-eye
    const a = this.camera.aspect || 1;
    if (a >= 1) return 70;
    return clamp(2 * Math.atan(Math.tan(50 * Math.PI / 360) / a) * 180 / Math.PI, 70, 86);
  }
  nearestPlace() {
    let best = null, bd = Infinity;
    for (const p of this.places.places) { const d = (p.x - this.x) ** 2 + (p.z - this.z) ** 2; if (d < bd) { bd = d; best = p; } }
    return best ? best.id : null;
  }
  step(dt) {
    const k = this.keys;
    // turning: ease in and out like a game camera
    const tt = (k.has('turnL') ? 1 : 0) - (k.has('turnR') ? 1 : 0);
    this.turnVel += (tt * TURN - this.turnVel) * (1 - Math.exp(-dt * 10));
    if (!tt && Math.abs(this.turnVel) < 0.002) this.turnVel = 0;
    if (this.turnVel) this.yaw = wrap(this.yaw + this.turnVel * dt);
    // walking
    let f = (k.has('fwd') ? 1 : 0) - (k.has('back') ? 1 : 0), s = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    let tx = 0, tz = 0;
    if (f || s) {
      this.setGoal(null);
      const n = Math.hypot(f, s), sp = k.has('run') ? RUN : WALK;
      f /= n; s /= n;
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
      tx = (-sy * f + cy * s) * sp; tz = (-cy * f - sy * s) * sp;
    } else if (this.goal) {
      // walking to a tapped point along its waypoints (straight where the way is open)
      const g = this.goal, last = g.route.length - 1;
      // head for the farthest waypoint in clear sight
      while (g.k < last && this.los(this.x, this.z, g.route[g.k + 1].x, g.route[g.k + 1].z, true)) { g.k++; g.best = Infinity; g.idle = 0; }
      let w = g.route[g.k], d = Math.hypot(w.x - this.x, w.z - this.z);
      if (g.k < last && d < 0.04) { g.k++; w = g.route[g.k]; d = Math.hypot(w.x - this.x, w.z - this.z); g.best = Infinity; g.idle = 0; }
      if (g.k === last && d < 0.05) this.setGoal(null);
      else { const v = g.k === last ? Math.min(WALK, d * 2.4 + 0.12) : WALK; tx = (w.x - this.x) / d * v; tz = (w.z - this.z) / d * v; }
    }
    const a = 1 - Math.exp(-dt * (this.goal ? ACCEL * 2 : ACCEL));   // on a route: steer tightly
    this.vx += (tx - this.vx) * a; this.vz += (tz - this.vz) * a;
    if (!tx && !tz && Math.hypot(this.vx, this.vz) < 0.01) { this.vx = 0; this.vz = 0; }
    if (this.vx || this.vz) {
      this.move(this.vx * dt, this.vz * dt);
      const g = this.goal;
      if (g) {
        // stop at whatever is in the way (no 5 cm of progress for 0.7 s)
        const w = g.route[g.k], d = Math.hypot(w.x - this.x, w.z - this.z);
        if (d < g.best - 0.05) { g.best = d; g.idle = 0; }
        else if ((g.idle += dt) > 0.7) { this.setGoal(null); this.vx = 0; this.vz = 0; this.bump = 1; }
      }
    } else this.defSide = 0;
    // the cardio platform is 15 cm up: step onto it smoothly
    const fy = this.platAt(this.x, this.z) ? (this.walkInfo.platform_h || 0.15) : 0;
    if (fy !== this.floorY) { this.floorY += (fy - this.floorY) * (1 - Math.exp(-dt * 9)); if (Math.abs(fy - this.floorY) < 0.001) this.floorY = fy; }
  }
  // a sub-step to (nx, nz) is allowed when that cell is free and, crossing into a diagonal cell, both cells beside
  // the corner are free too (the grid is already grown by the walker's radius: a corner gap is narrower than you)
  canStep(nx, nz) {
    if (!this.free(nx, nz)) return false;
    const g = this.grid;
    const i0 = Math.floor((this.x - g.x0) / g.res), i1 = Math.floor((nx - g.x0) / g.res);
    const j0 = Math.floor((this.z + g.y1) / g.res), j1 = Math.floor((nz + g.y1) / g.res);
    return i0 === i1 || j0 === j1 || (this.free(nx, this.z) && this.free(this.x, nz));
  }
  // collide against the grid in small sub-steps: slide along walls and round corners (a rounded machine footprint
  // or a turnstile post guides you past it instead of stopping you dead); a wall met head-on stops you
  move(dx, dz) {
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.02));
    const sx = dx / n, sz = dz / n;
    let hitX = false, hitZ = false;
    for (let i = 0; i < n; i++) {
      if (this.canStep(this.x + sx, this.z + sz)) { this.x += sx; this.z += sz; continue; }
      if (sx && this.free(this.x + sx, this.z)) { this.x += sx; hitZ = true; continue; }
      if (sz && this.free(this.x, this.z + sz)) { this.z += sz; hitX = true; continue; }
      if (!this.deflect(sx, sz)) { hitX = hitZ = true; break; }
    }
    if (hitX) this.vx *= 0.5;
    if (hitZ) this.vz *= 0.5;
  }
  deflect(sx, sz) {
    const L = Math.hypot(sx, sz) || 1e-9, ux = sx / L, uz = sz / L;
    const pref = this.defSide || 1;
    // round a corner: the step turned a little to either side, if that side stays open a bit further on
    for (const a of [0.35, 0.7, 1.05, 1.35]) {
      for (const sg of [pref, -pref]) {
        const c = Math.cos(a * sg), s = Math.sin(a * sg), k = Math.cos(a);
        const rx = (ux * c - uz * s), rz = (ux * s + uz * c);
        if (!this.canStep(this.x + rx * L * k, this.z + rz * L * k) || !this.free(this.x + rx * 0.3, this.z + rz * 0.3)) continue;
        this.x += rx * L * k; this.z += rz * L * k; this.defSide = sg;
        return true;
      }
    }
    // a narrow opening just beside the way ahead (a door, a turnstile lane): side-step into it
    for (let off = 0.05; off <= 0.451; off += 0.05) {
      for (const sg of [pref, -pref]) {
        const px = -uz * sg, pz = ux * sg;
        const ox = this.x + px * off, oz = this.z + pz * off;
        if (!this.free(ox + ux * 0.06, oz + uz * 0.06)) continue;
        let clear = true;
        for (let t = 0.025; t <= off; t += 0.025) if (!this.free(this.x + px * t, this.z + pz * t)) { clear = false; break; }
        if (!clear || !this.canStep(this.x + px * Math.min(L, off), this.z + pz * Math.min(L, off))) continue;
        this.x += px * Math.min(L, off); this.z += pz * Math.min(L, off); this.defSide = sg;
        return true;
      }
    }
    return false;
  }
  // is the straight way from a to b open? thick: also 3.5 cm to either side (room for small steering errors)
  los(ax, az, bx, bz, thick) {
    const L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 0.0125);
    const px = L ? -(bz - az) / L * 0.035 : 0, pz = L ? (bx - ax) / L * 0.035 : 0;
    for (const o of thick ? [0, 1, -1] : [0]) {
      for (let i = 1; i <= n; i++) {
        const t = i / n, k = o * Math.min(1, t * L / 0.1, (1 - t) * L / 0.1);   // full width away from the two ends
        if (!this.free(ax + (bx - ax) * t + px * k, az + (bz - az) * t + pz * k)) return false;
      }
    }
    return true;
  }
  // waypoints from here to a tapped point: straight when open; else the shortest way round on the walk grid (A*,
  // smoothed by line of sight) unless that is a long detour (then straight, stopping at the obstacle)
  route(sx, sz, tx, tz) {
    const straight = [{ x: tx, z: tz }];
    if (this.los(sx, sz, tx, tz, true)) return straight;
    const g = this.grid, W = g.w, H = g.h, s = this.cell(sx, sz), t = this.cell(tx, tz);
    if (s < 0 || t < 0 || g.blk[s] || g.blk[t]) return straight;
    const N = W * H;
    if (!this.astar) this.astar = { gs: new Float32Array(N), seen: new Int32Array(N), from: new Int32Array(N), run: 0 };
    const A = this.astar, run = ++A.run;
    const si = s % W, sj = (s / W) | 0, ti = t % W, tj = (t / W) | 0, pad = 80;
    const i0 = Math.max(0, Math.min(si, ti) - pad), i1 = Math.min(W - 1, Math.max(si, ti) + pad);
    const j0 = Math.max(0, Math.min(sj, tj) - pad), j1 = Math.min(H - 1, Math.max(sj, tj) + pad);
    const hh = (c) => { const dx = Math.abs(c % W - ti), dy = Math.abs(((c / W) | 0) - tj); return dx + dy - 0.5858 * Math.min(dx, dy); };
    const heap = [], hf = [];
    const push = (c, f) => {
      let i = heap.length; heap.push(c); hf.push(f);
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; heap[i] = heap[p]; hf[i] = hf[p]; i = p; }
      heap[i] = c; hf[i] = f;
    };
    const pop = () => {
      const top = heap[0], lc = heap.pop(), lf = hf.pop();
      if (heap.length) {
        let i = 0; const n = heap.length;
        for (;;) { let m = 2 * i + 1; if (m >= n) break; if (m + 1 < n && hf[m + 1] < hf[m]) m++; if (hf[m] >= lf) break; heap[i] = heap[m]; hf[i] = hf[m]; i = m; }
        heap[i] = lc; hf[i] = lf;
      }
      return top;
    };
    A.seen[s] = run; A.gs[s] = 0; A.from[s] = -1; push(s, 1.5 * hh(s));
    let found = false, iter = 0;
    while (heap.length && iter++ < 150000) {
      const c = pop();
      if (c === t) { found = true; break; }
      const ci = c % W, cj = (c / W) | 0, gc = A.gs[c];
      for (let k = 0; k < 8; k++) {
        const [di, dj, cost] = NB8[k];
        const ni = ci + di, nj = cj + dj;
        if (ni < i0 || ni > i1 || nj < j0 || nj > j1) continue;
        const nc = nj * W + ni;
        if (g.blk[nc]) continue;
        if (k >= 4 && (g.blk[cj * W + ni] || g.blk[nj * W + ci])) continue;   // no cutting corners
        const dw = g.dist[nc], ng = gc + cost * (dw < 6 ? 1 + (6 - dw) * 0.5 : 1);
        if (A.seen[nc] === run && A.gs[nc] <= ng) continue;
        A.seen[nc] = run; A.gs[nc] = ng; A.from[nc] = c;
        push(nc, ng + 1.5 * hh(nc));   // weighted: a quick, near-shortest way
      }
    }
    if (!found) return straight;
    const cells = [];
    for (let c = t; c !== -1; c = A.from[c]) cells.push(c);
    cells.reverse();
    // smooth: from each waypoint, jump to the farthest path cell still in plain sight
    const pts = cells.map((c) => this.center(c));
    pts[pts.length - 1] = { x: tx, z: tz };
    const out = [];
    let cx = sx, cz = sz, i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(cx, cz, pts[j].x, pts[j].z, true)) j--;
      out.push(pts[j]); cx = pts[j].x; cz = pts[j].z; i = j;
    }
    if (!out.length) return straight;
    let len = 0, px = sx, pz = sz;
    for (const q of out) { len += Math.hypot(q.x - px, q.z - pz); px = q.x; pz = q.z; }
    return len > Math.hypot(tx - sx, tz - sz) * 1.6 + 3 ? straight : out;
  }
  setGoal(p) {
    if (p) {
      if (!p.route || !p.route.length) p.route = [{ x: p.x, z: p.z }];
      p.k = 0; p.best = Math.hypot(p.route[0].x - this.x, p.route[0].z - this.z); p.idle = 0;
    }
    this.goal = p;
    this.ring.visible = !!p;
    if (p) this.ring.position.set(p.x, (this.platAt(p.x, p.z) ? (this.walkInfo.platform_h || 0.15) : 0) + 0.03, p.z);
    this.dirty = true;
  }
  fadeStep(dt) {
    const f = this.fade;
    if (!f) return;
    const sp = REDUCE ? 1000 : f.out ? 1 / 0.22 : 1 / 0.35;
    this.fadeA = clamp(this.fadeA + (f.out ? 1 : -1) * dt * sp, 0, 1);
    if (f.out && this.fadeA >= 1) { f.out = false; f.then(); }
    else if (!f.out && this.fadeA <= 0) this.fade = null;
    this.fadeMesh.material.uniforms.opacity.value = this.fadeA;
    this.fadeMesh.visible = this.fadeA > 0;
    this.dirty = true;
  }
  // frame-time driven resolution: drop the pixel ratio when frames are slow, raise it again when they are fast
  adapt(now, consecutive) {
    const P = this.perf, dt = now - P.lastT;
    P.lastT = now;
    if (!consecutive || dt > 500) return;              // after an idle stretch, or a one-off hitch (e.g. a shader compile)
    P.acc += dt; P.n++;
    if (P.acc < 1500) return;
    const avg = P.acc / P.n;
    P.acc = 0; P.n = 0;
    if (avg > 26 && this.pr > this.prMin) { this.setPR(this.pr - 0.25); P.good = 0; P.cool = now + 3000; }
    else if (avg < 18 && this.pr < this.prMax && now > P.cool) {
      if (++P.good >= 3) { this.setPR(this.pr + 0.25); P.good = 0; P.cool = now + 8000; }
    } else P.good = 0;
  }
  setPR(pr) {
    this.pr = clamp(Math.round(pr * 4) / 4, this.prMin, this.prMax);
    this.renderer.setPixelRatio(this.pr);
    this.resize();
  }

  /* ---------- input ---------- */
  bind() {
    this.onKey = (e) => {
      const k = MOVE_KEYS[e.code] || KEY_FALLBACK[(e.key || '').toLowerCase()];
      if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
      if (k !== 'run') e.preventDefault();
      if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k);
      if (k !== 'run' && e.type === 'keydown') this.setGoal(null);
    };
    this.onBlur = () => this.keys.clear();
    const cv = this.canvas;
    cv.addEventListener('keydown', this.onKey);
    cv.addEventListener('keyup', this.onKey);
    cv.addEventListener('blur', this.onBlur);
    // one finger / mouse drag: look around; two fingers: zoom; a tap or click: walk there
    const pts = new Map();
    let drag = null, pinch = null;
    cv.addEventListener('pointerdown', (e) => {
      // skipTap (set by the page in the capture phase): this press closes something over the view, it is not a walk
      const skip = this.skipTap; this.skipTap = false;
      cv.focus({ preventScroll: true });
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* already released */ }
      if (pts.size === 1) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, moved: false, t: performance.now(), skip };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.zoom };
        if (drag) drag.moved = true;
      }
      this.hover.visible = false;
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        this.zoom = clamp(pinch.zoom * pinch.d / (Math.hypot(a.x - b.x, a.y - b.y) || 1), 0.45, 1.25);
        return;
      }
      if (drag && e.pointerId === drag.id) {
        const k = (this.camera.fov * Math.PI / 180) / (cv.clientHeight || 1);
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
        if (drag.moved) {
          this.yaw = wrap(drag.yaw + dx * k);
          this.pitch = clamp(drag.pitch + dy * k, -1.25, 1.25);
        }
        return;
      }
      if (e.pointerType === 'mouse' && !e.buttons && this.ready) this.hoverAt(e);
    });
    const up = (e) => {
      const was = pts.has(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (!was || !drag || e.pointerId !== drag.id) { if (!pts.size) drag = null; return; }
      if (!drag.moved && !drag.skip && performance.now() - drag.t < 600 && e.type === 'pointerup') this.tapAt(e);
      drag = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && this.hover.visible) { this.hover.visible = false; this.dirty = true; } });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 1.25);
    }, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.root);
  }
  // where a screen point lands on the floor (photo skins first; walls and things in the way stop the walk there)
  floorAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const nd = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(nd, this.camera);
    this.raycaster.far = 40;
    const ray = this.raycaster.ray;
    const hit = this.raycaster.intersectObjects(this.skins, false)[0];
    let p = null;
    if (hit && (hit.object.userData.floor || hit.point.y < 0.35)) p = { x: hit.point.x, z: hit.point.z };
    else if (hit && hit.point.y < 2.3) {
      // a wall: walk up to it
      const back = Math.min(0.4, hit.distance * 0.5);
      p = { x: hit.point.x - ray.direction.x * back, z: hit.point.z - ray.direction.z * back, wall: true };
    } else if (!hit && ray.direction.y < -0.02) {
      const t = -(ray.origin.y - 0.0) / ray.direction.y;
      if (t > 0 && t < 40) p = { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
    }
    return p;
  }
  tapAt(e) {
    if (!this.ready || this.fade) return;
    let p = this.floorAt(e);
    if (p) {
      // a point on a machine's footprint: the free spot next to it
      if (!this.free(p.x, p.z)) {
        const c = this.search(p.x, p.z, (k) => this.grid.reach[k] === 1, 16);
        if (c >= 0) p = this.center(c);
      }
      if (Math.hypot(p.x - this.x, p.z - this.z) < 0.25) return;
      this.setGoal({ x: p.x, z: p.z, route: this.route(this.x, this.z, p.x, p.z) });
    } else this.bump = 1;
    this.dirty = true;
  }
  hoverAt(e) {
    if (this.hoverPending) { this.hoverEv = e; return; }
    this.hoverPending = true; this.hoverEv = e;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      if (this.dead) return;
      const p = this.floorAt(this.hoverEv);
      const on = !!p && !p.wall;
      if (on) this.hover.position.set(p.x, (this.platAt(p.x, p.z) ? (this.walkInfo.platform_h || 0.15) : 0) + 0.025, p.z);
      if (on || this.hover.visible) this.dirty = true;
      this.hover.visible = on;
    });
  }
  press(dir, down) {
    if (!STEP.includes(dir) && dir !== 'run') return;
    if (down) { this.keys.add(dir); this.setGoal(null); } else this.keys.delete(dir);
  }
  look(yaw, pitch = 0) { this.yaw = wrap(yaw); this.pitch = clamp(pitch, -1.25, 1.25); this.dirty = true; }
  // jump to a named place (fades through dark); false when there is no such place
  teleport(id) {
    const p = this.placeById(id);
    if (!p || !this.ready) return false;
    this.jump(p.x, p.z, p.yaw || 0, 0, false, true);
    return true;
  }
  // metres to the nearest wall / photo surface straight ahead at eye height (equipment does not count)
  wallDist(x, z, yaw) {
    this.raycaster.set(new THREE.Vector3(x, (this.platAt(x, z) ? 0.15 : 0) + this.eye, z), new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)));
    this.raycaster.far = 30;
    const h = this.raycaster.intersectObjects(this.skins, false)[0];
    return h ? h.distance : 30;
  }
  // a place whose view would start nose-to-wall: turn to the most open direction near the intended one
  openYaw(x, z, yaw) {
    if (this.wallDist(x, z, yaw) >= 2) return yaw;
    let best = yaw, bs = -Infinity;
    for (let k = 1; k < 16; k++) {
      const off = (k <= 8 ? k : k - 16) * Math.PI / 8, y = yaw + off;
      const sc = Math.min(this.wallDist(x, z, y), 12) - Math.abs(off) * 0.8;
      if (sc > bs) { bs = sc; best = y; }
    }
    return wrap(best);
  }
  jump(x, z, yaw, pitch = 0, instant = false, open = false) {
    const go = () => {
      const q = this.nudge(x, z);
      this.x = q.x; this.z = q.z; this.yaw = wrap(open ? this.openYaw(q.x, q.z, yaw) : yaw); this.pitch = pitch;
      this.vx = this.vz = 0; this.turnVel = 0; this.setGoal(null);
      this.floorY = this.platAt(this.x, this.z) ? (this.walkInfo.platform_h || 0.15) : 0;
      // light of the new spot right away (the screen is dark)
      const c = this.nearestCap(this.x, this.z);
      if (c) {
        this.envWant = c; this.envTr = null;
        const apply = () => { if (this.dead || this.envWant !== c) return; this.envCur = c; if (this.model) this.envApply(c, c, 1); else this.envStale = true; this.dirty = true; };
        if (this.envReady(c)) apply(); else this.envTex(c).then(apply).catch(() => {});
        this.prefetchEnv();
      }
      this.dirty = true;
    };
    if (instant || REDUCE) { go(); return; }
    this.fade = { out: true, then: go };
  }
  // stop drawing while hidden (battery) and stop loading (phones: downloads too); carry on where it was when shown
  pause() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.open = false;
    if (this.ac && this.light) this.ac.abort();
    this.keys.clear();
    if (this.ready) this.setGoal(null);
    this.vx = this.vz = 0; this.turnVel = 0;
    // once the overlay has closed, give back the drawing buffer (tens of MB with multisampling)
    clearTimeout(this.shrinkT);
    this.shrinkT = setTimeout(() => { if (!this.open && !this.dead) { this.renderer.setSize(1, 1, false); this.shrunk = true; } }, 1500);
  }
  // (also when already running: draws the next frame, e.g. so the minimap shows straight away)
  resume() {
    this.dirty = true;
    if (this.dead) return;
    clearTimeout(this.shrinkT);
    if (!this.open) {
      this.open = true;
      const w = this.waiters; this.waiters = [];
      w.forEach((f) => f());
    }
    if (this.shrunk) { this.shrunk = false; this.resize(); }
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this._frame);
  }
  focus() { this.canvas.focus({ preventScroll: true }); }
  resize() {
    if (this.shrunk) return;
    const w = this.root.clientWidth || 1, h = this.root.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }
  stats() {
    const i = this.renderer.info;
    return { tier: this.tier, pr: this.pr, calls: i.render.calls, tris: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, x: +this.x.toFixed(2), z: +this.z.toFixed(2), yaw: +this.yaw.toFixed(3), env: this.envCur && this.envCur.id, model: !!this.model };
  }
  destroy() {
    if (this.dead) return;
    this.dead = true;
    cancelAnimationFrame(this.raf); this.raf = 0;
    clearTimeout(this.shrinkT);
    if (this.ac) this.ac.abort();
    const w = this.waiters; this.waiters = []; w.forEach((f) => f());   // pending loads see `dead` and stop
    if (this.ro) this.ro.disconnect();
    // after a lost-and-restored context some GPU objects belong to the old context: losing the whole context below frees
    // everything without the browser warning about each one
    const seen = new Set(), gpu = !this.restored && !this.lost;
    const free = (x) => { if (gpu && x && !seen.has(x)) { seen.add(x); x.dispose(); } };
    this.scene.traverse((o) => {
      if (o.geometry) free(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (!m) return;
        TEX_SLOTS.forEach((s) => free(m[s]));
        if (m.userData && m.userData.g3std) free(m.userData.g3std);
        free(m);
      });
    });
    this.tiles.forEach((t) => { free(t.near); free(t.far); });
    this.instSets.forEach((s) => s.far && free(s.far.geometry));
    if (this.envCache) this.envCache.forEach((e) => free(e.tex));
    [this.envRT, this.blendRT, this.pmrem, this.blendMat].forEach(free);
    if (this.ktx2) this.ktx2.dispose();
    if (this.blendScene) this.blendScene.traverse((o) => free(o.geometry));
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.renderer.dispose();
    // let the browser free the context now, not whenever the garbage collector gets to it
    try { this.renderer.forceContextLoss(); } catch (e) { /* already lost */ }
    this.canvas.remove();
    if (DEBUG && window.__g3 === this) window.__g3 = null;
    // drop the big CPU-side data (geometry and texture copies, the walk grid, the light photos)
    this.scene = this.model = this.skins = this.atlases = this.grid = this.astar = this.envCache = null;
    this.envRT = this.blendRT = this.pmrem = this.blendScene = this.ktx2 = this.places = null;
    this.instSets = []; this.tiles = []; this.st.map = null; this.opts = {};
  }
}

/* ---------- minimap: the floor plan, where you are and where you look (north up) ---------- */
export function drawMap(ctx, w, st) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const m = st && st.map;
  if (!m) return;
  const pad = 6 * w;
  const s = Math.min((W - 2 * pad) / (m.x1 - m.x0), (H - 2 * pad) / (m.z1 - m.z0));
  const ox = (W - (m.x1 - m.x0) * s) / 2, oz = (H - (m.z1 - m.z0) * s) / 2;
  ctx.drawImage(m.img, m.i0, m.j0, m.i1 - m.i0, m.j1 - m.j0, ox, oz, (m.x1 - m.x0) * s, (m.z1 - m.z0) * s);
  const cx = ox + (st.x - m.x0) * s, cy = oz + (st.z - m.z0) * s;
  const a = -st.yaw - Math.PI / 2;            // screen angle of the view direction
  const half = Math.min(st.hfov / 2, 1);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30 * w);
  g.addColorStop(0, 'rgba(214,251,0,.45)'); g.addColorStop(1, 'rgba(214,251,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 30 * w, a - half, a + half); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#D6FB00';
  ctx.strokeStyle = '#111111'; ctx.lineWidth = 1.5 * w;
  ctx.beginPath(); ctx.arc(cx, cy, 4.5 * w, 0, TAU); ctx.fill(); ctx.stroke();
}
