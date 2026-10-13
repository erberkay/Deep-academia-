// Step 1 — sort shuffled cube faces into cubes and give every face its role.
//   node group_faces.js <edgesDir> <out.json>
// <edgesDir> holds <name>.T/.B/.L/.R: the 1-px border row/column of each face resampled to N RGB samples
// (T, B left→right; L, R top→bottom), made by edge_strips.sh.
// Adjacent faces of one cube continue each other pixel for pixel along their shared edge, so mutual best
// edge matches join faces into cubes. Side faces are upright: the one face that meets four T edges is the
// ceiling, the one meeting four B edges is the floor, and R→L matches give the order around the room.
// Output per cube: { faces: { f, r, b, l, u, d: { file, rot (quarter turns clockwise), flip } }, score }
// in the canonical orientation used by tour-engine (see walker.js header).
const fs = require('fs');
const path = require('path');
const [, , dir, outFile] = process.argv;
const N = 128;
const SIDES = ['T', 'B', 'L', 'R'];

const names = [...new Set(fs.readdirSync(dir).filter((f) => /\.[TBLR]$/.test(f)).map((f) => f.slice(0, -2)))].sort();
const strip = {};
names.forEach((n) => { strip[n] = {}; SIDES.forEach((s) => {
  const b = fs.readFileSync(path.join(dir, n + '.' + s));
  if (b.length !== N * 3) throw new Error('bad strip ' + n + '.' + s);
  strip[n][s] = Float32Array.from(b);
}); });
const rev = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) o[i * 3 + c] = a[(N - 1 - i) * 3 + c]; return o; };
const msd = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s / N; };

// 1) mutual best edge matches (either direction) -> cubes
const E = [];
names.forEach((n) => SIDES.forEach((s) => E.push({ n, s, a: strip[n][s], r: rev(strip[n][s]) })));
const best = E.map(() => ({ j: -1, d: Infinity }));
for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
  if (E[i].n === E[j].n) continue;
  const d = Math.min(msd(E[i].a, E[j].a), msd(E[i].a, E[j].r));
  if (d < best[i].d) best[i] = { j, d };
  if (d < best[j].d) best[j] = { j: i, d };
}
const parent = Object.fromEntries(names.map((n) => [n, n]));
const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
best.forEach((b, i) => { if (b.j >= 0 && best[b.j].j === i) parent[find(E[i].n)] = find(E[b.j].n); });
const groups = {};
names.forEach((n) => { (groups[find(n)] = groups[find(n)] || []).push(n); });
const cubes = Object.values(groups);
const bad = cubes.filter((g) => g.length !== 6);

// 2) roles inside one cube
// edges of a face after rotating it q quarter turns clockwise (and mirroring first when flip)
function edgesOf(n, q, flip) {
  let e = { T: strip[n].T, R: strip[n].R, B: strip[n].B, L: strip[n].L };
  if (flip) e = { T: rev(e.T), B: rev(e.B), L: e.R, R: e.L };
  for (let k = 0; k < q; k++) e = { T: rev(e.L), R: e.T, B: rev(e.R), L: e.B }; // 90° clockwise
  return e;
}
function solveCube(g) {
  const ups = [], sides = {};
  // the face whose edges best match the T edges of four others is the ceiling (likewise B / floor)
  const tScore = (u, key) => g.filter((x) => x !== u).map((x) => Math.min(...SIDES.map((s) =>
    Math.min(msd(strip[u][s], strip[x][key]), msd(strip[u][s], rev(strip[x][key])))))).sort((a, b) => a - b).slice(0, 4).reduce((a, b) => a + b, 0);
  const byT = g.map((u) => ({ u, d: tScore(u, 'T') })).sort((a, b) => a.d - b.d);
  const U = byT[0].u;
  const byB = g.filter((x) => x !== U).map((u) => ({ u, d: tScore(u, 'B') })).sort((a, b) => a.d - b.d);
  const D = byB[0].u;
  const S = g.filter((x) => x !== U && x !== D);
  // ring order: a side face's right edge continues into the next face's left edge
  const nextOf = (a) => S.filter((x) => x !== a).map((b) => ({ b, d: msd(strip[a].R, strip[b].L) })).sort((p, q) => p.d - q.d)[0];
  const f = S[0], r = nextOf(f).b, b = nextOf(r).b, l = nextOf(b).b;
  const ring = [f, r, b, l];
  const ringOk = new Set(ring).size === 4 && nextOf(l).b === f;
  const ringD = ring.reduce((s, x) => s + nextOf(x).d, 0);
  // orient ceiling / floor: try 8 transforms, keep the one whose edges meet the side tops / bottoms
  const fit = (n, want) => {
    let bestT = null;
    for (const flip of [false, true]) for (let q = 0; q < 4; q++) {
      const e = edgesOf(n, q, flip);
      const d = want(e);
      if (!bestT || d < bestT.d) bestT = { q, flip, d };
    }
    return bestT;
  };
  const up = fit(U, (e) => msd(e.B, strip[f].T) + msd(e.R, rev(strip[r].T)) + msd(rev(e.T), strip[b].T) + msd(e.L, strip[l].T));
  const dn = fit(D, (e) => msd(e.T, strip[f].B) + msd(e.R, strip[r].B) + msd(rev(e.B), strip[b].B) + msd(rev(e.L), strip[l].B));
  return {
    faces: {
      f: { file: f, rot: 0, flip: false }, r: { file: r, rot: 0, flip: false },
      b: { file: b, rot: 0, flip: false }, l: { file: l, rot: 0, flip: false },
      u: { file: U, rot: up.q, flip: up.flip }, d: { file: D, rot: dn.q, flip: dn.flip },
    },
    score: { ringOk, ring: +ringD.toFixed(1), up: +up.d.toFixed(1), down: +dn.d.toFixed(1) },
  };
}
const out = cubes.filter((g) => g.length === 6).map((g, i) => ({ id: 'c' + String(i + 1).padStart(2, '0'), ...solveCube(g) }));
fs.writeFileSync(outFile, JSON.stringify({ cubes: out, ungrouped: bad }, null, 1));
const sizes = {};
cubes.forEach((g) => { sizes[g.length] = (sizes[g.length] || 0) + 1; });
console.log(JSON.stringify({ faces: names.length, groupSizes: sizes, cubes: out.length,
  ringProblems: out.filter((c) => !c.score.ringOk).map((c) => c.id),
  worst: out.map((c) => ({ id: c.id, ...c.score })).sort((a, b) => (b.up + b.down) - (a.up + a.down)).slice(0, 5) }));
