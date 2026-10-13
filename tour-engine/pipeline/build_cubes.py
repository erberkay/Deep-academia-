"""Step 3 — write every cube's faces in the tour-engine orientation at the web sizes.

    python3 -I build_cubes.py <groups.json> <facesDir> <outDir> [sizes, default 1024,2048]

For each cube in groups.json (from group_faces.js) and each face f r b l u d: mirror if needed, turn
`rot` quarter turns clockwise, scale, and save <outDir>/<cubeId>/<size>/<face>.jpg (JPEG ~q85).
"""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

groups_path, faces_dir, out_dir = sys.argv[1:4]
sizes = [int(s) for s in (sys.argv[4] if len(sys.argv) > 4 else '1024,2048').split(',')]
cubes = json.load(open(groups_path))['cubes']


def find_face(name):
    for ext in ('.jpg', '.jpeg', '.png'):
        p = os.path.join(faces_dir, name + ext)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(name)


def job(cube_id, face, spec):
    src = find_face(spec['file'])
    base = (['hflip'] if spec.get('flip') else []) + ['transpose=1'] * (spec.get('rot', 0) % 4)
    outs = []
    split = f"split={len(sizes)}" + ''.join(f'[s{i}]' for i in range(len(sizes)))
    chain = ','.join(base + [split]) if base else split
    graph = [f'[0]{chain}']
    for i, s in enumerate(sizes):
        d = os.path.join(out_dir, cube_id, str(s))
        os.makedirs(d, exist_ok=True)
        graph.append(f'[s{i}]scale={s}:{s}:flags=lanczos[o{i}]')
        outs += ['-map', f'[o{i}]', '-q:v', '3', os.path.join(d, face + '.jpg')]
    cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-i', src, '-filter_complex', ';'.join(graph)] + outs
    subprocess.run(cmd, check=True)
    return cube_id + '/' + face


jobs = [(c['id'], f, spec) for c in cubes for f, spec in c['faces'].items()]
with ThreadPoolExecutor(max_workers=8) as ex:
    done = list(ex.map(lambda a: job(*a), jobs))
print(json.dumps({'cubes': len(cubes), 'faces': len(done), 'sizes': sizes, 'out': out_dir}))
