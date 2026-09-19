"""Generate a deterministic, high-density low-poly mountain OBJ."""
from pathlib import Path
import math

OUT = Path(__file__).resolve().parents[1] / "assets" / "fractal_mountain_dense.obj"
NX, NZ = 256, 192
XMIN, XMAX = -5.5, 5.5
ZMIN, ZMAX = -1.5, 7.5


def hash_noise(ix, iz):
    value = math.sin(ix * 127.1 + iz * 311.7) * 43758.5453
    return value - math.floor(value)


def smooth_noise(x, z, scale):
    x /= scale
    z /= scale
    ix, iz = math.floor(x), math.floor(z)
    fx, fz = x - ix, z - iz
    sx = fx * fx * (3.0 - 2.0 * fx)
    sz = fz * fz * (3.0 - 2.0 * fz)
    a = hash_noise(ix, iz)
    b = hash_noise(ix + 1, iz)
    c = hash_noise(ix, iz + 1)
    d = hash_noise(ix + 1, iz + 1)
    return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz


def height(x, z):
    main = max(0.0, 1.0 - math.sqrt((x / 4.0) ** 2 + ((z - 3.1) / 4.8) ** 2))
    ridge = 0.65 * max(0.0, 1.0 - abs(x + 1.6) / 2.7) * max(0.0, 1.0 - abs(z - 3.8) / 3.2)
    ridge += 0.55 * max(0.0, 1.0 - abs(x - 2.4) / 2.4) * max(0.0, 1.0 - abs(z - 4.2) / 2.8)
    noise = (
        0.55 * smooth_noise(x, z, 2.4)
        + 0.28 * smooth_noise(x, z, 0.95)
        + 0.12 * smooth_noise(x, z, 0.34)
    )
    front_fade = max(0.0, min(1.0, (z - ZMIN) / 2.0))
    return max(0.03, (main * 3.8 + ridge * 2.0 + noise * 0.85) * front_fade)


vertices = []
groups = []
for j in range(NZ + 1):
    z = ZMIN + (ZMAX - ZMIN) * j / NZ
    for i in range(NX + 1):
        x = XMIN + (XMAX - XMIN) * i / NX
        y = height(x, z)
        vertices.append((x, y, z))
        groups.append("snow" if y > 4.05 else ("ridge" if y > 2.4 else "rock"))

faces = {"rock": [], "ridge": [], "snow": []}
def index(i, j):
    return j * (NX + 1) + i + 1

for j in range(NZ):
    for i in range(NX):
        a, b, c, d = index(i, j), index(i + 1, j), index(i, j + 1), index(i + 1, j + 1)
        diagonal = (i + j) % 2
        triangles = [(a, b, d), (a, d, c)] if diagonal == 0 else [(a, b, c), (b, d, c)]
        for triangle in triangles:
            group = max((groups[k - 1] for k in triangle), key=lambda name: {"rock": 0, "ridge": 1, "snow": 2}[name])
            faces[group].append(triangle)

with OUT.open("w", encoding="ascii", newline="\n") as handle:
    handle.write("# Dense deterministic fractal mountain terrain\n")
    handle.write("o mountain\n")
    for x, y, z in vertices:
        handle.write(f"v {x:.5f} {y:.5f} {z:.5f}\n")
    for group in ("rock", "ridge", "snow"):
        handle.write(f"g {group}\n")
        for a, b, c in faces[group]:
            handle.write(f"f {a} {b} {c}\n")

print(f"{OUT} vertices={len(vertices)} triangles={sum(map(len, faces.values()))}")
