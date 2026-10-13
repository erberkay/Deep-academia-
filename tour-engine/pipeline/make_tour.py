"""Step 5 — tour.json for tour-engine.

    python -I make_tour.py <pipelineDir> <cubesDir> <work> <out tour.json> <cube url prefix>

- Positions/headings: poses.json (main area + first locker room, solved together).
- Second locker room (behind the orange door off corridor c40) is solved on its own pairs plus the
  doorway pair c24-c54, then placed behind that door: c54 sits DOOR_M beyond c40 in the door's direction,
  turned so that walking in through the door keeps the walking direction. The door step is a portal
  (crossfade, no glide), so the approximate fit cannot show.
- Links come only from pairs that matched visually (points that see each other), never from distance alone,
  so nobody walks through a wall into the neighbouring room.
"""
import json
import math
import sys

sys.path.insert(0, sys.argv[1])
import numpy as np  # noqa: E402
import cv2  # noqa: E402
import poses as P  # noqa: E402

cube_dir, W, out, prefix = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
ROOM_B = ['c19', 'c24', 'c25', 'c30', 'c54']
EXCLUDE = {'c42', 'c51'}          # a locker front and a bare wall: no reliable match to anything placed
DOOR_FROM, DOOR_NODE, DOOR_LOCAL_YAW = 'c40', 'c54', math.pi   # orange door seen from c40 (local yaw 180°)
DOOR_M = 1.8
LINK_MAX = 7.0

poses = json.load(open(W + '/poses.json'))
edges = json.load(open(W + '/pairs_bridged.json'))
ids = json.load(open(W + '/top.json'))['ids']
node = {n['id']: n for n in poses['nodes']}


def match(a, b):
    _, bi_all, di = P.features((cube_dir, a, 1024))
    _, bj_all, dj = P.features((cube_dir, b, 1024))
    fl = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    m1 = fl.knnMatch(di, dj, k=2)
    m2 = fl.knnMatch(dj, di, k=2)
    fwd = {x.queryIdx: x.trainIdx for x, y in (p for p in m1 if len(p) == 2) if x.distance < P.RATIO * y.distance}
    back = {x.queryIdx: x.trainIdx for x, y in (p for p in m2 if len(p) == 2) if x.distance < P.RATIO * y.distance}
    pairs = [(q, t) for q, t in fwd.items() if back.get(t) == q]
    return bi_all[[p[0] for p in pairs]], bj_all[[p[1] for p in pairs]]


def eight_point_pose(a, b):
    bi, bj = match(a, b)
    rng = np.random.default_rng(4)
    best = None
    for _ in range(4000):
        s = rng.choice(len(bi), 8, replace=False)
        e = P.eight_point(bi[s], bj[s])
        inl = P.ang_err(e, bi, bj) < P.ANG_THRESH
        if best is None or inl.sum() > best.sum():
            best = inl
    e = P.eight_point(bi[best], bj[best])
    good, r, t = P.decompose(e, bi[best], bj[best])
    return {'theta': math.atan2(r[0, 2], r[0, 0]), 't': [float(x) for x in t], 'inliers': int(best.sum())}


# ---- second locker room on its own ----
ib = {c: ids.index(c) for c in ROOM_B}
room_edges = [e for e in edges if ids[e['i']] in ROOM_B and ids[e['j']] in ROOM_B]
door_pair = eight_point_pose('c24', 'c54')
room_edges.append(dict(door_pair, i=ib['c24'], j=ib['c54']))
local_ids = ROOM_B
remap = {ib[c]: k for k, c in enumerate(local_ids)}
loc_edges = [dict(e, i=remap[e['i']], j=remap[e['j']]) for e in room_edges]
b_nodes, b_active, _, b_missing = P.solve_graph(local_ids, loc_edges)
if b_missing:
    print('room B not fully connected:', b_missing)
bn = {n['id']: n for n in b_nodes}

# place it behind the door: world yaw of the door seen from c40
c40 = node[DOOR_FROM]
door_yaw = c40['heading'] + DOOR_LOCAL_YAW
fwd = np.array([-math.sin(door_yaw), -math.cos(door_yaw)])           # (x, z)
door_pos = np.array([c40['pos'][0], c40['pos'][2]]) + DOOR_M * fwd
# inside the room, c54 -> c24 is the way in: make that direction the door direction
d_in = np.array([bn['c24']['pos'][0] - bn['c54']['pos'][0], bn['c24']['pos'][2] - bn['c54']['pos'][2]])
yaw_in_local = math.atan2(-d_in[0], -d_in[1])
rot = door_yaw - yaw_in_local                                         # turn the room's frame by this yaw
c, s = math.cos(rot), math.sin(rot)
for n in b_nodes:
    x, z = n['pos'][0] - bn['c54']['pos'][0], n['pos'][2] - bn['c54']['pos'][2]
    # rotating world points by +rot about y (engine yaw sense): (x, z) -> (c x + s z, -s x + c z)
    n['pos'] = [round(float(door_pos[0] + c * x + s * z), 3), 0, round(float(door_pos[1] - s * x + c * z), 3)]
    n['heading'] = round(n['heading'] + rot, 4)
    node[n['id']] = n

# ---- links: visually matched pairs only (plus the door portal) ----
nb = {k: set() for k in node}
for e in edges + room_edges:
    a, b = ids[e['i']], ids[e['j']]
    if a in node and b in node and a not in EXCLUDE and b not in EXCLUDE:
        pa, pb = np.array(node[a]['pos']), np.array(node[b]['pos'])
        if np.linalg.norm(pa - pb) <= LINK_MAX:
            nb[a].add(b)
            nb[b].add(a)

nodes = []
for k in sorted(node):
    if k in EXCLUDE:
        continue
    links = sorted(nb[k])
    if k == DOOR_FROM:
        links.append({'to': DOOR_NODE, 'portal': True})
    if k == DOOR_NODE:
        links.append({'to': DOOR_FROM, 'portal': True})
    nodes.append({'id': k, 'cube': prefix + k + '/{size}/{face}.jpg', 'pos': node[k]['pos'],
                  'heading': node[k]['heading'], 'links': links})
missing = [c for c in ids if c not in node and c not in EXCLUDE]
# start at the entrance looking into the club: toward its first link (the entrance's front face looks at the door)
c02, first = np.array(node['c02']['pos']), sorted(nb['c02'])[0]
d0 = np.array(node[first]['pos']) - c02
tour = {'start': 'c02', 'startYaw': round(math.atan2(-d0[0], -d0[2]), 4), 'sizes': [1024, 2048], 'nodes': nodes}
json.dump(tour, open(out, 'w'), indent=1)
deg = sorted(len(n['links']) for n in nodes)
print(json.dumps({'nodes': len(nodes), 'missing': missing, 'excluded': sorted(EXCLUDE),
                  'links_per_node': {'min': deg[0], 'median': deg[len(deg) // 2], 'max': deg[-1]},
                  'isolated': [n['id'] for n in nodes if not n['links']], 'door_pair_inliers': door_pair['inliers']}))
