"""Step 7 — bundle adjustment: refine every capture's position + orientation together with the 3D points.

    python -I ba.py <pipelineDir> <cubesDir> <tour.json> <pairs.json> <counts.json> <out.npz> [--ids id,id,...]

Pairwise poses chained through a graph drift (a few degrees, uneven scale). Here all cameras and thousands of
triangulated feature points are optimised at once: each observation's bearing must point at its 3D point.
Cameras: position (x, y, z) and rotation yaw/pitch/roll (world_from_cam = Ry(yaw) Rx(pitch) Rz(roll));
the yaw starts from tour.json's heading. Soft priors: same tripod height for all (y ~ 0), small tilt, and
the mean distance between linked cameras stays as it was (keeps the tour's units). Robust (Huber) loss,
two rounds with outlier removal.
Output npz: ids, C (n,3), ypr (n,3), points (m,3), obs (k,3: cam, point, -), bearings (k,3).
"""
import json
import math
import sys
from multiprocessing import Pool

sys.path.insert(0, sys.argv[1])
import numpy as np  # noqa: E402
import cv2  # noqa: E402
from scipy.optimize import least_squares  # noqa: E402
from scipy.sparse import lil_matrix  # noqa: E402
import poses as P  # noqa: E402

cube_dir, tour_path, pairs_path, counts_path, out = sys.argv[2:7]
only = sys.argv[sys.argv.index('--ids') + 1].split(',') if '--ids' in sys.argv else None
tour = json.load(open(tour_path))
nodes = {n['id']: n for n in tour['nodes']}
all_ids = json.load(open(counts_path))['ids']
edges = json.load(open(pairs_path))
ids = [c for c in all_ids if c in nodes and (only is None or c in only)]
ix = {c: k for k, c in enumerate(ids)}
n = len(ids)


def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def feat(c):
    return P.features((cube_dir, c, 1024))


def match(args):
    a, b, ba, da, bb, db, Ra, Ca, Rb, Cb = args
    fl = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    m1 = fl.knnMatch(da, db, k=2)
    m2 = fl.knnMatch(db, da, k=2)
    fwd = {x.queryIdx: x.trainIdx for x, y in (p for p in m1 if len(p) == 2) if x.distance < P.RATIO * y.distance}
    back = {x.queryIdx: x.trainIdx for x, y in (p for p in m2 if len(p) == 2) if x.distance < P.RATIO * y.distance}
    pairs = np.array([(q, t) for q, t in fwd.items() if back.get(t) == q], int)
    if len(pairs) < 8:
        return a, b, np.zeros((0, 2), int)
    # keep matches consistent with the current relative pose (epipolar angle)
    R = Rb.T @ Ra
    t = Rb.T @ (Ca - Cb)
    tn = t / (np.linalg.norm(t) + 1e-12)
    tx = np.array([[0, -tn[2], tn[1]], [tn[2], 0, -tn[0]], [-tn[1], tn[0], 0]])
    E = tx @ R
    err = P.ang_err(E, ba[pairs[:, 0]], bb[pairs[:, 1]])
    return a, b, pairs[err < 0.012]


def main():
    with Pool(8) as pool:
        F = pool.map(feat, ids)
    bear = [f[1] for f in F]
    desc = [f[2] for f in F]
    C0 = np.array([nodes[c]['pos'] for c in ids], float)
    ypr0 = np.array([[nodes[c]['heading'], 0.0, 0.0] for c in ids])
    Rs = [rot(*v) for v in ypr0]
    pairs = [(ix[all_ids[e['i']]], ix[all_ids[e['j']]]) for e in edges if all_ids[e['i']] in ix and all_ids[e['j']] in ix]
    jobs = [(a, b, bear[a], desc[a], bear[b], desc[b], Rs[a], C0[a], Rs[b], C0[b]) for a, b in pairs]
    with Pool(8) as pool:
        res = pool.map(match, jobs)
    # tracks: union-find over (camera, keypoint)
    parent = {}

    def f(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b, pm in res:
        for qa, qb in pm:
            ra, rb = f((a, int(qa))), f((b, int(qb)))
            if ra != rb:
                parent[ra] = rb
    groups = {}
    for key in list(parent):
        groups.setdefault(f(key), []).append(key)
    tracks = []
    for g in groups.values():
        cams = [k[0] for k in g]
        if len(g) >= 2 and len(set(cams)) == len(cams):      # one observation per camera
            tracks.append(g)
    # triangulate (closest point to all rays), keep well-conditioned points in front of every camera
    pts, obs, bvec = [], [], []
    for g in tracks:
        A = np.zeros((3, 3))
        rhs = np.zeros(3)
        dirs = []
        for cam, kp in g:
            d = Rs[cam] @ bear[cam][kp]
            dirs.append(d)
            M = np.eye(3) - np.outer(d, d)
            A += M
            rhs += M @ C0[cam]
        try:
            X = np.linalg.solve(A, rhs)
        except np.linalg.LinAlgError:
            continue
        ok = all(np.dot(X - C0[cam], d) > 0.2 for (cam, _), d in zip(g, dirs))
        ang = max(math.acos(min(1, abs(np.dot(dirs[0], d)))) for d in dirs[1:])
        if not ok or ang < math.radians(2) or np.linalg.norm(X - C0[g[0][0]]) > 40:
            continue
        p = len(pts)
        pts.append(X)
        for cam, kp in g:
            obs.append((cam, p))
            bvec.append(bear[cam][kp])
    pts = np.array(pts)
    obs = np.array(obs, int)
    bvec = np.array(bvec)
    print('cameras', n, 'tracks', len(tracks), 'points', len(pts), 'observations', len(obs), flush=True)

    link_pairs = np.array(pairs, int)
    d0 = np.linalg.norm(C0[link_pairs[:, 0]] - C0[link_pairs[:, 1]], axis=1).mean()
    ref = int(np.argmax(np.bincount(obs[:, 0], minlength=n)))

    def unpack(x):
        cams = x[:6 * n].reshape(n, 6)
        return cams[:, :3], cams[:, 3:], x[6 * n:].reshape(-1, 3)

    def residuals(x, obs, bvec):
        C, ypr, X = unpack(x)
        R = np.array([rot(*v) for v in ypr])
        v = X[obs[:, 1]] - C[obs[:, 0]]
        d = np.einsum('kji,kj->ki', R[obs[:, 0]], v)          # R^T v
        d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-12
        r_obs = np.cross(bvec, d).ravel()
        r_h = (C[:, 1] / 0.05)                                 # same tripod height
        r_tilt = (ypr[:, 1:] / math.radians(3)).ravel()        # level within a few degrees
        dl = np.linalg.norm(C[link_pairs[:, 0]] - C[link_pairs[:, 1]], axis=1).mean()
        r_scale = np.array([(dl - d0) / (0.01 * d0)])
        r_gauge = np.concatenate([(C[ref] - C0[ref]) / 0.001, [(ypr[ref, 0] - ypr0[ref, 0]) / 0.001]])
        return np.concatenate([r_obs, r_h, r_tilt, r_scale, r_gauge])

    def sparsity(obs):
        m = len(obs) * 3 + n + 2 * n + 1 + 4
        A = lil_matrix((m, 6 * n + 3 * len(pts)), dtype=int)
        k = np.arange(len(obs))
        for r in range(3):
            for c in range(6):
                A[3 * k + r, 6 * obs[:, 0] + c] = 1
            for c in range(3):
                A[3 * k + r, 6 * n + 3 * obs[:, 1] + c] = 1
        base = 3 * len(obs)
        for i in range(n):
            A[base + i, 6 * i + 1] = 1
            A[base + n + 2 * i, 6 * i + 4] = 1
            A[base + n + 2 * i + 1, 6 * i + 5] = 1
        A[base + 3 * n, :6 * n] = 1
        for c in range(3):
            A[base + 3 * n + 1 + c, 6 * ref + c] = 1
        A[base + 3 * n + 4, 6 * ref + 3] = 1
        return A

    x = np.concatenate([np.hstack([C0, ypr0]).ravel(), pts.ravel()])
    keep = np.ones(len(obs), bool)
    for rnd in range(2):
        o, b = obs[keep], bvec[keep]
        r0 = residuals(x, o, b)[:3 * len(o)].reshape(-1, 3)
        print(f'round {rnd}: median angle before {math.degrees(np.median(np.linalg.norm(r0, axis=1))):.3f} deg', flush=True)
        sol = least_squares(residuals, x, jac_sparsity=sparsity(o), args=(o, b), loss='huber', f_scale=0.004,
                            x_scale='jac', method='trf', max_nfev=60, verbose=0)
        x = sol.x
        r = residuals(x, obs, bvec)[:3 * len(obs)].reshape(-1, 3)
        ang = np.linalg.norm(r, axis=1)
        keep = ang < 0.008
        print(f'round {rnd}: median angle after {math.degrees(np.median(ang[keep])):.3f} deg, kept {keep.mean():.2%}', flush=True)
    C, ypr, X = unpack(x)
    shift = np.linalg.norm(C - C0, axis=1)
    dyaw = np.degrees(np.abs(np.arctan2(np.sin(ypr[:, 0] - ypr0[:, 0]), np.cos(ypr[:, 0] - ypr0[:, 0]))))
    print(json.dumps({'moved_median': round(float(np.median(shift)), 3), 'moved_max': round(float(shift.max()), 3),
                      'yaw_change_median_deg': round(float(np.median(dyaw)), 2), 'yaw_change_max_deg': round(float(dyaw.max()), 2),
                      'tilt_max_deg': round(float(np.degrees(np.abs(ypr[:, 1:]).max())), 2), 'height_spread': round(float(np.ptp(C[:, 1])), 3)}))
    np.savez(out, ids=np.array(ids), C=C, ypr=ypr, points=X, obs=obs[keep], bearings=bvec[keep])


if __name__ == '__main__':
    main()
