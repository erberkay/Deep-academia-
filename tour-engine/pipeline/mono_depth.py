"""Step 8 — dense, metric depth for every capture: Depth Anything V2 + the bundle-adjusted 3D points.

    python -I mono_depth.py <pipelineDir> <cubesDir> <tour.json> <ba.npz> <outDir> [--only id,id] [--model NAME]

Per capture: 10 overlapping 90° views (8 around, up, down) rendered from its cube; the model predicts relative
inverse depth for each; every view is fitted (RANSAC, affine in inverse depth) to metric anchors — the 3D points
this camera observed in the bundle adjustment, plus the floor and ceiling planes — and the views are blended
into one equirect inverse-depth map with feathered weights.
Output <outDir>/<id>.png: RGB, 16-bit inverse depth in R (high) + G (low), linear between 1/DMAX and 1/DMIN,
equirect W x W/2, longitude 0 = cube front (-z), increasing to the right. meta.json has DMIN/DMAX.
"""
import json
import math
import os
import sys

sys.path.insert(0, sys.argv[1])
import numpy as np  # noqa: E402
import cv2  # noqa: E402
import torch  # noqa: E402
from PIL import Image  # noqa: E402
from transformers import AutoImageProcessor, AutoModelForDepthEstimation  # noqa: E402
import depth as D  # noqa: E402

cube_dir, tour_path, ba_path, out_dir = sys.argv[2:6]
only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else None
MODEL = sys.argv[sys.argv.index('--model') + 1] if '--model' in sys.argv else 'depth-anything/Depth-Anything-V2-Base-hf'
DMIN, DMAX = 0.3, 30.0
FLOOR, CEIL = 1.6, 1.5            # below / above the lens, tour units (~metres), from the BA point cloud
CROP = 518
EQ_W = 1024


def crop_dirs(yaw, pitch, size=CROP, fov=90.0):
    """unit directions (cube frame, x right, y up, -z forward) for a pinhole view"""
    f = 0.5 * size / math.tan(math.radians(fov) / 2)
    u, v = np.meshgrid(np.arange(size) + 0.5 - size / 2, np.arange(size) + 0.5 - size / 2)
    d = np.stack([u / f, -v / f, -np.ones_like(u)], axis=-1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    cp, sp, cy, sy = math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])         # yaw > 0 turns right
    return d @ (Ry @ Rx).T, (Ry @ Rx)


def sample_cube(atlas, s, d):
    """colour of the canonical cube along directions d (same mapping as depth.cube_to_equirect)"""
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    fi = np.zeros(x.shape, int)
    a = np.zeros(x.shape)
    b = np.zeros(x.shape)
    for k, m, aa, bb in [
        (0, (az >= ax) & (az >= ay) & (z < 0), x / np.where(z == 0, 1, -z), -y / np.where(z == 0, 1, -z)),
        (1, (ax >= ay) & (ax >= az) & (x > 0), z / np.where(x == 0, 1, x), -y / np.where(x == 0, 1, x)),
        (2, (az >= ax) & (az >= ay) & (z > 0), -x / np.where(z == 0, 1, z), -y / np.where(z == 0, 1, z)),
        (3, (ax >= ay) & (ax >= az) & (x < 0), z / np.where(x == 0, 1, x), y / np.where(x == 0, 1, x)),
        (4, (ay >= ax) & (ay >= az) & (y > 0), x / np.where(y == 0, 1, y), -z / np.where(y == 0, 1, y)),
        (5, (ay >= ax) & (ay >= az) & (y < 0), -x / np.where(y == 0, 1, y), -z / np.where(y == 0, 1, y)),
    ]:
        fi[m], a[m], b[m] = k, aa[m], bb[m]
    u = np.clip((a + 1) / 2 * s, 0, s - 1.001) + fi * s
    v = np.clip((b + 1) / 2 * s, 0, s - 1.001)
    return cv2.remap(atlas, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def fit_affine(pred, target, weight, rng):
    """inverse depth: target ~ s * pred + o, robust to wrong anchors (RANSAC on 2 points + weighted LS)"""
    n = len(pred)
    if n < 20:
        return None
    best, best_score = None, -1
    for _ in range(400):
        i, j = rng.choice(n, 2, replace=False, p=weight / weight.sum())
        if abs(pred[i] - pred[j]) < 1e-4:
            continue
        s = (target[i] - target[j]) / (pred[i] - pred[j])
        if s <= 0:
            continue
        o = target[i] - s * pred[i]
        rel = np.abs(s * pred + o - target) / target
        score = (weight * (rel < 0.12)).sum()
        if score > best_score:
            best_score, best = score, (s, o)
    if best is None:
        return None
    s, o = best
    inl = np.abs(s * pred + o - target) / target < 0.12
    A = np.stack([pred[inl], np.ones(inl.sum())], 1) * weight[inl, None]
    s, o = np.linalg.lstsq(A, target[inl] * weight[inl], rcond=None)[0]
    return (s, o) if s > 0 else best


def main():
    tour = json.load(open(tour_path))
    nodes = {n['id']: n for n in tour['nodes']}
    ba = np.load(ba_path)
    ba_ids = list(ba['ids'])
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    proc = AutoImageProcessor.from_pretrained(MODEL)
    model = AutoModelForDepthEstimation.from_pretrained(MODEL).to(dev).eval()
    views = [(math.radians(k * 45), 0.0) for k in range(8)] + [(0.0, math.radians(90)), (0.0, math.radians(-90))]
    os.makedirs(out_dir, exist_ok=True)
    eq_dirs = D.equirect_dirs(EQ_W, EQ_W // 2)
    report = []
    rng = np.random.default_rng(0)
    for cid in [c for c in nodes if only is None or c in only]:
        faces = [cv2.imread(os.path.join(cube_dir, cid, '1024', f + '.jpg')) for f in D.FACES]
        atlas = np.concatenate(faces, axis=1)
        # metric anchors from the bundle adjustment (this camera's observations)
        anchors_dir, anchors_inv = np.zeros((0, 3)), np.zeros(0)
        if cid in ba_ids:
            k = ba_ids.index(cid)
            sel = ba['obs'][:, 0] == k
            X = ba['points'][ba['obs'][sel, 1]]
            C = ba['C'][k]
            yaw, pitch, roll = ba['ypr'][k]
            cy, sy, cp_, sp_, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
            R = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]) @ np.array([[1, 0, 0], [0, cp_, -sp_], [0, sp_, cp_]]) @ np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
            v = (X - C) @ R                                   # into the camera frame
            dist = np.linalg.norm(v, axis=1)
            ok = (dist > DMIN) & (dist < DMAX)
            anchors_dir, anchors_inv = v[ok] / dist[ok, None], 1.0 / dist[ok]
        acc = np.zeros(eq_dirs.shape[:2])
        wsum = np.zeros(eq_dirs.shape[:2])
        fits = []
        imgs, dirs_all, rots = [], [], []
        for yaw, pitch in views:
            dirs, Rv = crop_dirs(yaw, pitch)
            imgs.append(Image.fromarray(cv2.cvtColor(sample_cube(atlas, 1024, dirs), cv2.COLOR_BGR2RGB)))
            dirs_all.append(dirs)
            rots.append(Rv)
        with torch.no_grad():
            inputs = proc(images=imgs, return_tensors='pt').to(dev)
            pred = model(**inputs).predicted_depth            # relative inverse depth, (10, h, w)
            pred = torch.nn.functional.interpolate(pred[:, None], size=(CROP, CROP), mode='bicubic', align_corners=False)[:, 0]
            pred = pred.float().cpu().numpy()
        for vi, ((yaw, pitch), dirs, Rv) in enumerate(zip(views, dirs_all, rots)):
            p = pred[vi]
            p = (p - p.min()) / (p.max() - p.min() + 1e-6)
            el = np.arcsin(np.clip(dirs[..., 1], -1, 1))
            # the model predicts inverse depth ALONG THE VIEW AXIS (z); ray distance r = z / cos(angle to axis)
            cosv = np.clip(-(dirs @ Rv)[..., 2], 1e-3, 1)
            # plane anchors (sub-sampled): floor below, ceiling above
            ys, xs = np.mgrid[4:CROP:12, 4:CROP:12]
            e = el[ys, xs]
            pv = p[ys, xs]
            cv_ = cosv[ys, xs]
            fm, cm = e < math.radians(-25), e > math.radians(30)
            t_pl = np.concatenate([np.sin(-e[fm]) / FLOOR / cv_[fm], np.sin(e[cm]) / CEIL / cv_[cm]])
            p_pl = np.concatenate([pv[fm], pv[cm]])
            w_pl = np.full(len(t_pl), 1.0)
            # point anchors that fall inside this view
            if len(anchors_dir):
                loc = anchors_dir @ Rv                          # into the view frame (-z forward)
                front = loc[:, 2] < -0.2
                f = 0.5 * CROP / math.tan(math.radians(45))
                u = loc[front, 0] / -loc[front, 2] * f + CROP / 2
                vv = -loc[front, 1] / -loc[front, 2] * f + CROP / 2
                inside = (u >= 0) & (u < CROP) & (vv >= 0) & (vv < CROP)
                cos_pt = -loc[front, 2][inside]
                t_pt = anchors_inv[front][inside] / np.maximum(cos_pt, 1e-3)
                p_pt = p[vv[inside].astype(int), u[inside].astype(int)]
            else:
                t_pt = p_pt = np.zeros(0)
            P_ = np.concatenate([p_pl, p_pt])
            T_ = np.concatenate([t_pl, t_pt])
            W_ = np.concatenate([w_pl, np.full(len(t_pt), 4.0)])  # real 3D points count more
            fit = fit_affine(P_, T_, W_, rng)
            if fit is None:
                continue
            s, o = fit
            inv = np.clip((s * p + o) * cosv, 1 / DMAX, 1 / DMIN)   # inverse ray distance
            fits.append({'view': vi, 'points': int(len(t_pt)), 's': round(float(s), 3), 'o': round(float(o), 4)})
            # splat into the equirect map, feathered toward the view's edges
            loc = eq_dirs @ Rv
            front = loc[..., 2] < -1e-3
            f = 0.5 * CROP / math.tan(math.radians(45))
            u = np.where(front, loc[..., 0] / np.where(front, -loc[..., 2], 1) * f + CROP / 2, -1)
            vv = np.where(front, -loc[..., 1] / np.where(front, -loc[..., 2], 1) * f + CROP / 2, -1)
            inside = front & (u >= 0) & (u < CROP - 1) & (vv >= 0) & (vv < CROP - 1)
            val = cv2.remap(inv.astype(np.float32), u.astype(np.float32), vv.astype(np.float32), cv2.INTER_LINEAR)
            cosang = np.clip(-loc[..., 2], 0, 1)
            w = np.where(inside, cosang ** 6, 0)
            acc += w * val
            wsum += w
        invd = np.where(wsum > 0, acc / np.maximum(wsum, 1e-9), 1 / 5.0)
        q = np.clip((invd - 1 / DMAX) / (1 / DMIN - 1 / DMAX), 0, 1)
        q16 = np.round(q * 65535).astype(np.uint16)
        rgb = np.dstack([np.zeros_like(q16, np.uint8), (q16 & 255).astype(np.uint8), (q16 >> 8).astype(np.uint8)])  # BGR: R=high, G=low
        cv2.imwrite(os.path.join(out_dir, cid + '.png'), rgb)
        report.append({'id': cid, 'views_fitted': len(fits), 'point_anchors': int(len(anchors_inv))})
        print(cid, len(fits), 'views,', len(anchors_inv), 'point anchors', flush=True)
    json.dump({'dmin': DMIN, 'dmax': DMAX, 'width': EQ_W, 'floor': FLOOR, 'ceil': CEIL, 'points': report},
              open(os.path.join(out_dir, 'meta.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
