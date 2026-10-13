"""Step 6 — a depth map for every capture point, from the neighbouring photos (multi-view stereo).

    python -I depth.py <cubesDir> <tour.json> <outDir> [--size 512] [--only id,id]

For each point: build an equirectangular image from its cube, then plane-sweep: for many depths along every
pixel's ray, project the 3D point into the nearest linked neighbours, compare small patches (ZNCC), keep the
depth that agrees best. Unreliable pixels (no texture, occluded, no agreement) are filled from the floor /
ceiling planes and their surroundings, then the map is smoothed while keeping edges.
Output: <outDir>/<id>.png — 8-bit, inverse depth between 1/DMAX (0) and 1/DMIN (255), equirect W x W/2,
longitude 0 = the cube's front (-z), increasing to the right; plus depth.json with camera/floor heights.
Units are the tour's (positions in tour.json).
"""
import json
import math
import os
import sys
from multiprocessing import Pool

import cv2
import numpy as np

FACES = ['f', 'r', 'b', 'l', 'u', 'd']
DMIN, DMAX = 0.35, 25.0
NDEP = 96
WIN = 7


def equirect_dirs(w, h):
    lon = (np.arange(w) + 0.5) / w * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(h) + 0.5) / h * np.pi
    lon, lat = np.meshgrid(lon, lat)
    return np.stack([np.sin(lon) * np.cos(lat), np.sin(lat), -np.cos(lon) * np.cos(lat)], axis=-1)


def dir_to_lonlat(d):
    lon = np.arctan2(d[..., 0], -d[..., 2])
    lat = np.arcsin(np.clip(d[..., 1] / np.linalg.norm(d, axis=-1), -1, 1))
    return lon, lat


def cube_to_equirect(cube_dir, cid, size, w):
    """sample the 6 canonical faces into an equirect image (face mapping = tour-engine / poses.py)"""
    faces = [cv2.imread(os.path.join(cube_dir, cid, str(size), f + '.jpg')) for f in FACES]
    s = faces[0].shape[0]
    atlas = np.concatenate(faces, axis=1)
    d = equirect_dirs(w, w // 2)
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    fi = np.zeros(x.shape, int)
    a = np.zeros(x.shape)
    b = np.zeros(x.shape)
    m = (az >= ax) & (az >= ay) & (z < 0)
    fi[m], a[m], b[m] = 0, x[m] / -z[m], -y[m] / -z[m]
    m = (ax >= ay) & (ax >= az) & (x > 0)
    fi[m], a[m], b[m] = 1, z[m] / x[m], -y[m] / x[m]
    m = (az >= ax) & (az >= ay) & (z > 0)
    fi[m], a[m], b[m] = 2, -x[m] / z[m], -y[m] / z[m]
    m = (ax >= ay) & (ax >= az) & (x < 0)
    fi[m], a[m], b[m] = 3, z[m] / x[m], y[m] / x[m]
    m = (ay >= ax) & (ay >= az) & (y > 0)
    fi[m], a[m], b[m] = 4, x[m] / y[m], -z[m] / y[m]
    m = (ay >= ax) & (ay >= az) & (y < 0)
    fi[m], a[m], b[m] = 5, -x[m] / y[m], -z[m] / y[m]
    u = np.clip((a + 1) / 2 * s, 0, s - 1.001) + fi * s
    v = np.clip((b + 1) / 2 * s, 0, s - 1.001)
    return cv2.remap(atlas, u.astype(np.float32), v.astype(np.float32), cv2.INTER_AREA if w < s else cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_REFLECT)


def ry(h):
    c, s = math.cos(h), math.sin(h)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def box(img, k):
    return cv2.boxFilter(img, -1, (k, k), borderType=cv2.BORDER_REFLECT)


def zncc_cost(ref, ref_mu, ref_sd, warped, valid):
    mu = box(warped, WIN)
    sd = np.sqrt(np.maximum(box(warped * warped, WIN) - mu * mu, 1e-6))
    cov = box(ref * warped, WIN) - ref_mu * mu
    c = 1.0 - cov / (ref_sd * sd + 1e-6)
    c[~valid] = 2.0
    return c


def solve(args):
    cid, cube_dir, nodes_json, out_dir, size, csize = args
    nodes = {n['id']: n for n in json.loads(nodes_json)}
    n = nodes[cid]
    W, H = size, size // 2
    C = np.array(n['pos'], float)
    R = ry(n['heading'])
    # neighbours: linked points first, nearest first, up to 4
    links = [l if isinstance(l, str) else l['to'] for l in n['links']]
    cand = sorted((m for m in nodes.values() if m['id'] != cid),
                  key=lambda m: (m['id'] not in links, np.linalg.norm(np.array(m['pos']) - C)))
    nbs = [m for m in cand if np.linalg.norm(np.array(m['pos']) - C) < 8.0][:4]
    ref_col = cube_to_equirect(cube_dir, cid, csize, W)
    ref = cv2.cvtColor(ref_col, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    ref_mu = box(ref, WIN)
    ref_sd = np.sqrt(np.maximum(box(ref * ref, WIN) - ref_mu * ref_mu, 1e-6))
    nb_imgs = [cv2.cvtColor(cube_to_equirect(cube_dir, m['id'], csize, W), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0 for m in nbs]
    dirs = equirect_dirs(W, H)
    wdirs = dirs @ R.T                                          # world directions of every pixel
    inv = np.linspace(1 / DMIN, 1 / DMAX, NDEP)
    best = np.full((H, W), np.inf, np.float32)
    second = np.full((H, W), np.inf, np.float32)
    bestd = np.zeros((H, W), np.float32)
    for k, iv in enumerate(inv):
        d = 1.0 / iv
        X = C + wdirs * d
        costs = []
        for m, img in zip(nbs, nb_imgs):
            local = (X - np.array(m['pos'])) @ ry(m['heading'])  # world -> neighbour frame (R^T x == x @ R)
            lon, lat = dir_to_lonlat(local)
            mx = ((lon + np.pi) / (2 * np.pi) * W - 0.5).astype(np.float32)
            my = ((np.pi / 2 - lat) / np.pi * H - 0.5).astype(np.float32)
            warped = cv2.remap(img, mx % W, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            # a point closer than 0.3 to the neighbour can't be compared
            valid = np.linalg.norm(local, axis=-1) > 0.3
            costs.append(zncc_cost(ref, ref_mu, ref_sd, warped, valid))
        cs = np.sort(np.stack(costs), axis=0)
        c = cs[:min(2, len(cs))].mean(axis=0)                  # best two views: occlusion tolerant
        upd = c < best
        second = np.where(upd, best, np.minimum(second, c))
        bestd = np.where(upd, d, bestd)
        best = np.where(upd, c, best)
    lat = np.pi / 2 - (np.arange(H) + 0.5) / H * np.pi
    latg = np.repeat(lat[:, None], W, axis=1)
    good = (best < 0.45) & (ref_sd > 0.025) & ((second - best) > 0.02)
    # floor / ceiling heights from the reliable pixels
    fl = good & (latg < -0.6)
    floor_h = float(np.median(bestd[fl] * np.sin(-latg[fl]))) if fl.sum() > 200 else 1.5
    ce = good & (latg > 0.6)
    ceil_h = float(np.median(bestd[ce] * np.sin(latg[ce]))) if ce.sum() > 200 else 1.6
    depth = np.where(good, bestd, 0.0).astype(np.float32)
    # fill: floor and ceiling planes where unreliable, the rest from the surroundings (in inverse depth)
    plane = np.where(latg < -0.05, floor_h / np.maximum(np.sin(-latg), 0.05),
                     np.where(latg > 0.05, ceil_h / np.maximum(np.sin(latg), 0.05), DMAX))
    plane = np.minimum(plane, DMAX)
    near_planes = (np.abs(latg) > 0.55)
    depth = np.where(~good & near_planes, plane, depth)
    invd = np.where(depth > 0, 1.0 / np.maximum(depth, DMIN), 0).astype(np.float32)
    hole = (invd == 0).astype(np.uint8)
    enc = np.clip((invd - 1 / DMAX) / (1 / DMIN - 1 / DMAX), 0, 1)
    enc8 = (enc * 255).astype(np.uint8)
    filled = cv2.inpaint(enc8, hole, 9, cv2.INPAINT_TELEA)
    # smooth while keeping edges (guided by the photo)
    sm = cv2.medianBlur(filled, 5)
    if hasattr(cv2, 'ximgproc'):
        sm = cv2.ximgproc.guidedFilter(ref_col, sm, 6, 40)
    else:
        sm = cv2.bilateralFilter(sm, 9, 30, 9)
    os.makedirs(out_dir, exist_ok=True)
    cv2.imwrite(os.path.join(out_dir, cid + '.png'), sm)
    return {'id': cid, 'good': round(float(good.mean()), 3), 'floor': round(floor_h, 3), 'ceil': round(ceil_h, 3),
            'neighbours': [m['id'] for m in nbs]}


def main():
    cube_dir, tour_path, out_dir = sys.argv[1:4]
    size = int(sys.argv[sys.argv.index('--size') + 1]) if '--size' in sys.argv else 512
    only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
    csize = int(sys.argv[sys.argv.index('--cube-size') + 1]) if '--cube-size' in sys.argv else 1024
    tour = json.load(open(tour_path))
    nodes_json = json.dumps(tour['nodes'])
    ids = [n['id'] for n in tour['nodes'] if not only or n['id'] in only]
    with Pool(8) as pool:
        res = pool.map(solve, [(c, cube_dir, nodes_json, out_dir, size, csize) for c in ids])
    meta = {'dmin': DMIN, 'dmax': DMAX, 'size': size, 'points': res}
    json.dump(meta, open(os.path.join(out_dir, 'depth.json'), 'w'), indent=1)
    g = [r['good'] for r in res]
    print(json.dumps({'points': len(res), 'reliable_share': {'min': min(g), 'median': sorted(g)[len(g) // 2]},
                      'floor_median': sorted(r['floor'] for r in res)[len(res) // 2]}))


if __name__ == '__main__':
    main()
