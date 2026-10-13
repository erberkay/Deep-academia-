"""Step 4 — where was each 360° capture taken, and which way does it face?

    python -I poses.py <cubesDir> <size> <out.json> [--pairs pairs.json]

<cubesDir>/<id>/<size>/{f,r,b,l,u,d}.jpg are cube faces in the tour-engine orientation (build_cubes.py).

1. SIFT features on all six faces of every cube, turned into unit bearing vectors in the cube's frame
   (x right, y up, z back; forward = -z).
2. For every pair of cubes: match features, then RANSAC an essential matrix on the bearing vectors
   (8-point, angular error). Decompose into rotation + translation direction, keep the solution with the
   points in front of both cameras, and require the rotation to be (almost) a turn about the vertical,
   since Matterport captures are level.
3. Pose graph: a yaw per cube (spanning tree + iterative circular averaging, outlier edges dropped), then
   positions from the translation directions (alternating least squares with positive edge lengths).
   Scale: the median nearest-neighbour distance is set to 2.0 m.
Output: { nodes: [{ id, pos: [x, 0, z], heading }], edges: [...] } with heading in tour-engine terms
(world yaw the front face looks along; forward(yaw) = (-sin yaw, 0, -cos yaw)).
"""
import json
import math
import os
import sys
from multiprocessing import Pool

import cv2
import numpy as np

FACES = ['f', 'r', 'b', 'l', 'u', 'd']
FEATS_PER_FACE = 4000
RATIO = 0.8
ANG_THRESH = 0.006      # rad: epipolar angular error for an inlier (final, tilt allowed)
SEARCH_THRESH = 0.02    # rad: looser error for the level-camera search (real captures tilt 1-2 deg)
MIN_INLIERS = 15
PEAK_RATIO = 1.1        # best turn angle vs the best one elsewhere
MAX_TILT = 5.0          # deg: captures are level within a couple of degrees
MIN_INLIER_SHARE = 0.3   # inliers / mutual matches: rejects coincidental agreement
STEP_M = 2.0            # metres: median nearest-neighbour distance


def bearings(face, pts, size):
    """unit vectors (cube frame) for pixel coordinates on one canonical face"""
    a = 2.0 * (pts[:, 0] + 0.5) / size - 1.0      # -1 left .. +1 right
    b = 2.0 * (pts[:, 1] + 0.5) / size - 1.0      # -1 top  .. +1 bottom
    one = np.ones_like(a)
    v = {
        'f': (a, -b, -one), 'r': (one, -b, a), 'b': (-a, -b, one), 'l': (-one, -b, -a),
        'u': (a, one, -b), 'd': (a, -one, b),
    }[face]
    v = np.stack(v, axis=1)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def features(args):
    cube_dir, cid, size = args
    sift = cv2.SIFT_create(nfeatures=FEATS_PER_FACE)
    bs, ds = [], []
    for f in FACES:
        img = cv2.imread(os.path.join(cube_dir, cid, str(size), f + '.jpg'), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise FileNotFoundError(cid + '/' + f)
        # skip the blurred tripod spot in the middle of the floor face
        mask = None
        if f == 'd':
            mask = np.full(img.shape, 255, np.uint8)
            cv2.circle(mask, (img.shape[1] // 2, img.shape[0] // 2), int(img.shape[0] * 0.22), 0, -1)
        kp, de = sift.detectAndCompute(img, mask)
        if de is None or not kp:
            continue
        pts = np.array([k.pt for k in kp], np.float64)
        bs.append(bearings(f, pts, img.shape[0]))
        ds.append(de)
    return cid, np.concatenate(bs), np.concatenate(ds).astype(np.float32)


def eight_point(bi, bj):
    a = np.einsum('ni,nj->nij', bj, bi).reshape(len(bi), 9)
    _, _, vt = np.linalg.svd(a)
    e = vt[-1].reshape(3, 3)
    u, _, vt = np.linalg.svd(e)
    return u @ np.diag([1.0, 1.0, 0.0]) @ vt


def ang_err(e, bi, bj):
    n = bi @ e.T                                   # rows: E b_i
    return np.abs(np.sum(n * bj, axis=1)) / np.maximum(np.linalg.norm(n, axis=1), 1e-12)


def decompose(e, bi, bj):
    u, _, vt = np.linalg.svd(e)
    if np.linalg.det(u) < 0:
        u = -u
    if np.linalg.det(vt) < 0:
        vt = -vt
    w = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], float)
    best = None
    for r in (u @ w @ vt, u @ w.T @ vt):
        for t in (u[:, 2], -u[:, 2]):
            # depths along both bearings: lj*bj - li*R bi = t
            rb = bi @ r.T
            m = np.stack([bj, -rb], axis=2)        # n x 3 x 2
            sol = np.array([np.linalg.lstsq(m[k], t, rcond=None)[0] for k in range(len(bi))])
            good = int(np.sum((sol[:, 0] > 0) & (sol[:, 1] > 0)))
            if best is None or good > best[0]:
                best = (good, r, t)
    return best


def solve_pair(args):
    i, j, bi_all, di, bj_all, dj = args
    flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    m1 = flann.knnMatch(di, dj, k=2)
    m2 = flann.knnMatch(dj, di, k=2)
    fwd = {a.queryIdx: a.trainIdx for a, b in (p for p in m1 if len(p) == 2) if a.distance < RATIO * b.distance}
    back = {a.queryIdx: a.trainIdx for a, b in (p for p in m2 if len(p) == 2) if a.distance < RATIO * b.distance}
    pairs = [(q, t) for q, t in fwd.items() if back.get(t) == q]
    if len(pairs) < MIN_INLIERS:
        return None
    bi = bi_all[[p[0] for p in pairs]]
    bj = bj_all[[p[1] for p in pairs]]
    res = upright_search(bi, bj)
    if res is None:
        return None
    res.update({'i': i, 'j': j, 'matches': len(pairs)})
    return res


def upright_search(bi, bj):
    """Captures are level and taken at one tripod height, so the relative pose has two unknowns:
    the turn theta about the vertical and the horizontal direction phi of the step (t = (sin phi, 0, cos phi)).
    Score every (theta, phi) on a grid by how many matches fit, refine around the peak, and demand that the
    peak clearly beats any other solution (repetitive gym equipment produces many false matches)."""
    A = -bj[:, 0] * bi[:, 1]
    Pp = bj[:, 1] * bi[:, 0]
    Qq = bj[:, 1] * bi[:, 2]
    Zz = bj[:, 2] * bi[:, 1]
    by2 = bi[:, 1] ** 2

    def scores(th, ph):                     # th, ph: 1-D arrays of the same length -> inlier counts
        c, s = np.cos(th)[:, None], np.sin(th)[:, None]
        tx, tz = np.sin(ph)[:, None], np.cos(ph)[:, None]
        num = tz * (A + c * Pp + s * Qq) + tx * (s * Pp - c * Qq + Zz)
        e1 = (tz * c + tx * s) * bi[:, 0] + (tz * s - tx * c) * bi[:, 2]
        err = np.abs(num) / np.sqrt(by2 + e1 ** 2 + 1e-12)
        return err < SEARCH_THRESH

    T, F = np.meshgrid(np.radians(np.arange(-180, 180, 2.0)), np.radians(np.arange(0, 180, 2.0)), indexing='ij')
    th, ph = T.ravel(), F.ravel()
    cnt = np.concatenate([scores(th[k:k + 2000], ph[k:k + 2000]).sum(axis=1) for k in range(0, len(th), 2000)])
    grid = cnt.reshape(T.shape)
    bi_, bf_ = np.unravel_index(int(np.argmax(grid)), grid.shape)
    best = int(grid[bi_, bf_])
    if best < MIN_INLIERS:
        return None
    # the best turn angle elsewhere (more than 12 deg away) must be clearly weaker. Only the turn is
    # tested: with distant points the step direction barely changes the fit, so it cannot be judged here.
    dth = np.abs((np.arange(grid.shape[0]) - bi_ + 90) % 180 - 90) * 2.0
    per_theta = grid.max(axis=1)
    second = int(per_theta[dth > 12].max())
    # with the loose search error other turn angles also score; the tight polish below (tilt, points in
    # front, agreement with the search) is the real test, so only drop clearly ambiguous cases here
    if best < PEAK_RATIO * second:
        return None
    # refine around the peak
    t0, p0 = T[bi_, bf_], F[bi_, bf_]
    T2, F2 = np.meshgrid(t0 + np.radians(np.arange(-3, 3.01, 0.25)), p0 + np.radians(np.arange(-3, 3.01, 0.25)), indexing='ij')
    m2 = scores(T2.ravel(), F2.ravel())
    k = int(np.argmax(m2.sum(axis=1)))
    theta0, inl = float(T2.ravel()[k]), m2[k]
    if inl.sum() < MIN_INLIERS:
        return None
    # polish with the general model (small tilt allowed) on the matches the search accepted
    sel = inl.copy()
    for _ in range(4):
        e = eight_point(bi[sel], bj[sel])
        new = (ang_err(e, bi, bj) < ANG_THRESH) & inl
        if new.sum() < MIN_INLIERS:
            return None
        sel = new
    good, r, t = decompose(e, bi[sel], bj[sel])
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, r[1, 1]))))
    theta = math.atan2(r[0, 2], r[0, 0])
    if tilt > MAX_TILT or good < 0.85 * sel.sum() or abs(wrap(theta - theta0)) > math.radians(6):
        return None
    return {'theta': wrap(theta), 't': [float(x) for x in t], 'inliers': int(sel.sum()),
            'cheiral': good, 'tilt': round(tilt, 2), 'peak': round(best / max(second, 1), 2)}


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def wrap(a):
    return math.atan2(math.sin(a), math.cos(a))


def solve_graph(ids, edges):
    n = len(ids)
    # --- yaw per cube: R_ij = Ry(alpha_j - alpha_i) ---
    adj = {k: [] for k in range(n)}
    for e in edges:
        adj[e['i']].append((e['j'], e['theta'], e['inliers']))
        adj[e['j']].append((e['i'], -e['theta'], e['inliers']))
    # largest connected component, rooted at its best-connected node
    seen, comps = set(), []
    for s in range(n):
        if s in seen:
            continue
        comp, stack = [], [s]
        seen.add(s)
        while stack:
            k = stack.pop()
            comp.append(k)
            for m, _, _ in adj[k]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        comps.append(comp)
    comp = max(comps, key=len)
    root = max(comp, key=lambda k: sum(w for _, _, w in adj[k]))
    alpha = {root: 0.0}
    # maximum spanning tree (Prim) for the first guess
    import heapq
    heap = [(-w, root, m, th) for m, th, w in adj[root]]
    heapq.heapify(heap)
    while heap:
        w, k, m, th = heapq.heappop(heap)
        if m in alpha:
            continue
        alpha[m] = wrap(alpha[k] + th)
        for q, th2, w2 in adj[m]:
            if q not in alpha:
                heapq.heappush(heap, (-w2, m, q, th2))
    active = [e for e in edges if e['i'] in alpha and e['j'] in alpha]
    for rnd in range(3):
        for _ in range(60):
            for k in alpha:
                if k == root:
                    continue
                sx = sy = 0.0
                for e in active:
                    if e['j'] == k:
                        est, w = alpha[e['i']] + e['theta'], e['inliers']
                    elif e['i'] == k:
                        est, w = alpha[e['j']] - e['theta'], e['inliers']
                    else:
                        continue
                    sx += w * math.cos(est)
                    sy += w * math.sin(est)
                if sx or sy:
                    alpha[k] = math.atan2(sy, sx)
        res = [abs(wrap(alpha[e['j']] - alpha[e['i']] - e['theta'])) for e in active]
        keep = [e for e, r in zip(active, res) if r < math.radians(10 if rnd < 2 else 6)]
        if len(keep) == len(active):
            break
        active = keep
    # --- positions: C_i - C_j = s_ij * Ry(alpha_j)^T t_ij ---
    idx = {k: q for q, k in enumerate(sorted(alpha))}
    dirs = []
    for e in active:
        d = ry(alpha[e['j']]).T @ np.array(e['t'])
        d2 = np.array([d[0], d[2]])
        if np.linalg.norm(d2) < 0.3:              # mostly vertical: no horizontal direction
            continue
        dirs.append((idx[e['i']], idx[e['j']], d2 / np.linalg.norm(d2), e['inliers']))
    m = len(idx)
    pos = np.zeros((m, 2))
    # first guess along the spanning structure (BFS with unit steps)
    placed = {idx[root]}
    changed = True
    while changed:
        changed = False
        for a, b, d, _ in dirs:
            if b in placed and a not in placed:
                pos[a] = pos[b] + d
                placed.add(a)
                changed = True
            elif a in placed and b not in placed:
                pos[b] = pos[a] - d
                placed.add(b)
                changed = True
    for rnd in range(3):
        for _ in range(80):
            s = [max(0.25, float(np.dot(pos[a] - pos[b], d))) for a, b, d, _ in dirs]
            rows, rhs, wts = [], [], []
            for (a, b, d, w), sl in zip(dirs, s):
                for ax in range(2):
                    row = np.zeros(2 * m)
                    row[2 * a + ax] = 1
                    row[2 * b + ax] = -1
                    rows.append(row)
                    rhs.append(sl * d[ax])
                    wts.append(math.sqrt(w))
            for ax in range(2):                    # gauge: root at the origin
                row = np.zeros(2 * m)
                row[2 * idx[root] + ax] = 1
                rows.append(row)
                rhs.append(0.0)
                wts.append(100.0)
            a_ = np.array(rows) * np.array(wts)[:, None]
            b_ = np.array(rhs) * np.array(wts)
            pos = np.linalg.lstsq(a_, b_, rcond=None)[0].reshape(m, 2)
        res = []
        for a, b, d, _ in dirs:
            v = pos[a] - pos[b]
            nv = np.linalg.norm(v)
            res.append(math.degrees(math.acos(max(-1, min(1, float(np.dot(v / nv, d)))))) if nv > 1e-9 else 180)
        keep = [x for x, r in zip(dirs, res) if r < (25 if rnd < 2 else 15)]
        if len(keep) == len(dirs):
            break
        dirs = keep
    # scale: median nearest-neighbour distance = STEP_M
    dd = np.linalg.norm(pos[:, None, :] - pos[None, :, :], axis=2)
    np.fill_diagonal(dd, np.inf)
    scale = STEP_M / float(np.median(dd.min(axis=1)))
    pos *= scale
    inv = {q: k for k, q in idx.items()}
    nodes = [{'id': ids[inv[q]], 'pos': [round(float(pos[q, 0]), 3), 0, round(float(pos[q, 1]), 3)],
              'heading': round(-alpha[inv[q]], 4)} for q in range(m)]
    missing = [ids[k] for k in range(n) if k not in alpha]
    return nodes, active, dirs, missing


def main():
    cube_dir, size, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    pairs_file = sys.argv[sys.argv.index('--pairs') + 1] if '--pairs' in sys.argv else None
    ids = sorted(d for d in os.listdir(cube_dir) if os.path.isdir(os.path.join(cube_dir, d)))
    if pairs_file and os.path.exists(pairs_file):
        edges = json.load(open(pairs_file))
        print('pairs from cache:', len(edges), flush=True)
    else:
        with Pool(8) as pool:
            feats = pool.map(features, [(cube_dir, c, size) for c in ids])
        print('features:', sum(len(f[1]) for f in feats), 'over', len(feats), 'cubes', flush=True)
        jobs = [(i, j, feats[i][1], feats[i][2], feats[j][1], feats[j][2])
                for i in range(len(ids)) for j in range(i + 1, len(ids))]
        with Pool(8) as pool:
            edges = [e for e in pool.imap_unordered(solve_pair, jobs, chunksize=4) if e]
        print('pairs with a pose:', len(edges), 'of', len(jobs), flush=True)
        if pairs_file:
            json.dump(edges, open(pairs_file, 'w'))
    nodes, active, dirs, missing = solve_graph(ids, edges)
    json.dump({'nodes': nodes, 'missing': missing,
               'edges': [{'a': ids[e['i']], 'b': ids[e['j']], 'inliers': e['inliers']} for e in active]},
              open(out, 'w'), indent=1)
    print(json.dumps({'placed': len(nodes), 'missing': missing, 'yaw_edges': len(active), 'pos_edges': len(dirs)}))


if __name__ == '__main__':
    main()
