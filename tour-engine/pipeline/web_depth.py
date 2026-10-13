"""Shrink the 16-bit inverse-depth maps for the web and add them to tour.json.
    python -I web_depth.py <mdepthDir> <outDir> <tour.json in> <tour.json out> <url prefix> [width]"""
import json, os, sys
import numpy as np, cv2
src, dst, tin, tout, prefix = sys.argv[1:6]
w = int(sys.argv[6]) if len(sys.argv) > 6 else 512
OPEN_K = int(sys.argv[7]) if len(sys.argv) > 7 else 9
meta = json.load(open(os.path.join(src, 'meta.json')))
os.makedirs(dst, exist_ok=True)
tour = json.load(open(tin))
for n in tour['nodes']:
    im = cv2.imread(os.path.join(src, n['id'] + '.png'))
    q = (im[..., 2].astype(np.float32) * 256 + im[..., 1]) / 65535
    small = cv2.resize(q, (w, w // 2), interpolation=cv2.INTER_AREA)
    # thin things close to the camera (truss lattices, cables, equipment frames) break the walking mesh into
    # fragments: fold them onto the surface behind (grey opening on inverse depth = remove narrow near peaks),
    # wrapping around the panorama seam; then a light median. Only the in-between geometry changes.
    # (Snapping depth edges to the photo's colour edges was tried: it splits surfaces into many small pieces.)
    k = max(3, int(round(w / 512 * OPEN_K)) | 1)
    pad = np.concatenate([small[:, -k:], small, small[:, :k]], axis=1)
    pad = cv2.morphologyEx(pad, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    pad = cv2.medianBlur(pad.astype(np.float32), 5)
    small = pad[:, k:-k]
    q16 = np.round(np.clip(small, 0, 1) * 65535).astype(np.uint16)
    out = np.dstack([np.zeros_like(q16, np.uint8), (q16 & 255).astype(np.uint8), (q16 >> 8).astype(np.uint8)])
    cv2.imwrite(os.path.join(dst, n['id'] + '.png'), out, [cv2.IMWRITE_PNG_COMPRESSION, 9])
    n['depth'] = prefix + n['id'] + '.png'
tour['depthRange'] = [meta['dmin'], meta['dmax']]
json.dump(tour, open(tout, 'w'), indent=1)
print('depth maps', len(tour['nodes']), 'width', w)
