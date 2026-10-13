"""Step 4b — attach rooms that only meet the main map through a doorway.

    python -I bridge.py <pipelineDir> <cubesDir> <size> <pairs.json> <counts.json> <out poses.json>

Small groups are joined to the MAIN group only (never small to small: the two locker rooms look alike),
one at a time, through their strongest candidate pairs, with a looser match count but a stricter level
check (tilt <= 3 deg). Repeats until nothing more attaches, then solves the whole graph again."""
import json
import sys

sys.path.insert(0, sys.argv[1])
import cv2  # noqa: E402
import poses as P  # noqa: E402

cube_dir, size, pairs_path, counts_path, out = sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6]
edges = json.load(open(pairs_path))
top = json.load(open(counts_path))
ids, cnt = top['ids'], top['counts']
n = len(ids)
feats = {}


def feat(k):
    if k not in feats:
        feats[k] = P.features((cube_dir, ids[k], size))
    return feats[k]


def comps():
    par = list(range(n))

    def f(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for e in edges:
        par[f(e['i'])] = f(e['j'])
    g = {}
    for k in range(n):
        g.setdefault(f(k), []).append(k)
    return sorted(g.values(), key=len, reverse=True)


P.MIN_INLIERS, P.PEAK_RATIO, P.MAX_TILT = 10, 1.0, 3.0
added = []
while True:
    cs = comps()
    main = set(cs[0])
    best = None
    for c in cs[1:]:
        cand = sorted(((cnt[a][b], a, b) for a in c for b in main), reverse=True)[:8]
        for m, a, b in cand:
            if m < 25:
                break
            i, j = min(a, b), max(a, b)
            _, bi_all, di = feat(i)
            _, bj_all, dj = feat(j)
            flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
            m1 = flann.knnMatch(di, dj, k=2)
            m2 = flann.knnMatch(dj, di, k=2)
            fwd = {x.queryIdx: x.trainIdx for x, y in (p for p in m1 if len(p) == 2) if x.distance < P.RATIO * y.distance}
            back = {x.queryIdx: x.trainIdx for x, y in (p for p in m2 if len(p) == 2) if x.distance < P.RATIO * y.distance}
            pairs = [(q, t) for q, t in fwd.items() if back.get(t) == q]
            if len(pairs) < 16:
                continue
            r = P.upright_search(bi_all[[p[0] for p in pairs]], bj_all[[p[1] for p in pairs]])
            if r and (best is None or r['inliers'] > best['inliers']):
                r.update({'i': i, 'j': j, 'matches': len(pairs), 'bridge': True})
                best = r
    if not best:
        break
    edges.append(best)
    added.append((ids[best['i']], ids[best['j']], best['inliers'], best['tilt']))
    print('bridge', added[-1], flush=True)
json.dump(edges, open(pairs_path.replace('.json', '_bridged.json'), 'w'))
nodes, active, dirs, missing = P.solve_graph(ids, edges)
json.dump({'nodes': nodes, 'missing': missing, 'bridges': added,
           'edges': [{'a': ids[e['i']], 'b': ids[e['j']], 'inliers': e['inliers']} for e in active]}, open(out, 'w'), indent=1)
print(json.dumps({'placed': len(nodes), 'missing': missing, 'bridges': len(added), 'yaw_edges': len(active), 'pos_edges': len(dirs)}))
