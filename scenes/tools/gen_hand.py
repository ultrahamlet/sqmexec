# gen_hand.py — 手のモデルを生成する。
# 参考図の構成をそのまま写す:
#   箱 = 手のひら / 円柱 (capsule) = 指節 / 関節は smooth-union の膨らみ /
#   指先にカップ状の爪 / ナックルラインは指の付け根を弧に並べて作る。
import math, io, sys

def su(k, *shapes):
    """smooth-union で束ねる。sqm の smooth-union は可変長 (例示シーンに 12 子の実例が
    ある) だが、グループごとに k を変えたいので入れ子にして畳み込む。"""
    s = shapes[-1]
    for x in reversed(shapes[:-1]):
        s = '(smooth-union (k %g)\n%s\n%s)' % (k, ind(x), ind(s))
    return s

def ind(s, n=2):
    return '\n'.join(' '*n + l for l in s.split('\n'))

def cap(a, b, r):
    return '(capsule (a %.4f %.4f %.4f)(b %.4f %.4f %.4f)(radius %.4f))' % (a+b+(r,))

def step(p, yaw, pitch, L):
    """p から yaw(XZ の扇) / pitch(下向き) の向きへ L 進んだ点"""
    cy, sy = math.cos(math.radians(yaw)),   math.sin(math.radians(yaw))
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))
    return (p[0] + L*cp*sy, p[1] + L*sp, p[2] + L*cp*cy)

# ── ナックルライン: 付け根を弧に並べる (中指が最も遠く、小指が最も手前) ──
#     name,      x,     z,   yaw,  節の長さ,             半径
FINGERS = [
    ('index',  -0.315, 0.935, -14, (0.430, 0.260, 0.195), (0.090, 0.080, 0.069)),
    ('middle', -0.105, 0.990,  -4, (0.470, 0.295, 0.205), (0.094, 0.084, 0.072)),
    ('ring',   0.105, 0.955,   7, (0.435, 0.275, 0.195), (0.089, 0.079, 0.068)),
    ('pinky',  0.310, 0.855,  20, (0.335, 0.205, 0.165), (0.076, 0.067, 0.059)),
]
PITCH = (-3, -8, -14)           # 節ごとに少しずつ下へ = 力を抜いた自然な指
#   ⚠ 深くしすぎると指先が床を突き抜ける。KY から差し引いた先端高さが
#      末節の半径を下回らないこと (今は先端 y≒0.095 / 半径 0.072 で接地寸前)
KY = 0.200                      # 付け根の高さ

fingers, nails, axes = [], [], []
for name, x, z, yaw, Ls, Rs in FINGERS:
    p = step((x, KY, z), yaw, PITCH[0], -0.090)   # 付け根を手のひら内へ食い込ませる
    parts = []
    for i, (L, r) in enumerate(zip(Ls, Rs)):
        q = step(p, yaw, PITCH[i], L)
        parts.append(cap(p, q, r))
        if i == len(Ls)-1:      # 指先の爪 (図の "Cup"): 背側に薄い楕円体を置く
            m = tuple((p[j]*0.35 + q[j]*0.65) for j in range(3))
            nails.append('(translate (t %.4f %.4f %.4f) (rotate (deg %g %g 0)'
                         ' (ellipsoid (center 0 0 0) (radii %.4f %.4f %.4f))))'
                         % (m[0], m[1] + r*0.48, m[2], PITCH[i], -yaw,
                            r*0.50, r*0.22, L*0.34))
        axes.append(cap(p, q, 0.006))    # Finger Axis (図の赤い軸) — 任意で描ける
        p = q
    # 節どうしは太めの k で繋いで関節を膨らませる
    fingers.append(su(0.045, *parts))

# ── 親指: 手のひらの縁から外へ。付け根の水かき (Thumb Web) は太い k で繋ぐ ──
t0 = (-0.255, 0.190, 0.145)
t1 = step(t0, -58, 0, 0.360)
t2 = step(t1, -47, -7, 0.290)
t3 = step(t2, -38, -15, 0.215)
thumb = su(0.045, cap(t0, t1, 0.104), cap(t1, t2, 0.088), cap(t2, t3, 0.074))
m = tuple((t2[j]*0.35 + t3[j]*0.65) for j in range(3))
nails.append('(translate (t %.4f %.4f %.4f) (rotate (deg -16 34 0)'
             ' (ellipsoid (center 0 0 0) (radii 0.046 0.020 0.072))))' % (m[0], m[1]+0.055, m[2]))

# ⚠ box の (size ..) は**半径 (half-extent)**。全長のつもりで書くと 2 倍の箱になり、
#    手のひらが指を丸ごと飲み込む (最初これで指が1本も見えなかった)。
# ⚠ box の (size ..) は**半径 (half-extent)**。全長のつもりで書くと 2 倍の箱になり、
#    手のひらが指を丸ごと飲み込む (最初これで指が1本も見えなかった)。
palm = su(0.115,
          '(round (r 0.100) (box (center -0.010 0.200 0.715) (size 0.235 0.020 0.135)))',
          '(round (r 0.100) (box (center -0.010 0.200 0.340) (size 0.170 0.018 0.170)))')
wrist = cap((-0.010, 0.195, -0.060), (-0.010, 0.195, 0.140), 0.160)

#   ⚠ 指を全部同じ k で平坦に並べると、隣の指どうしが癒着してミトンになる。
#      指は1本ずつまとめ (k 0.045 = 関節の膨らみ)、手のひらへは小さい k で繋ぐ。
hand = su(0.022, su(0.030, palm, wrist), *fingers)
hand = '(smooth-union (k 0.115)\n%s\n%s)' % (ind(hand), ind(thumb))   # 水かき (太くしすぎると塊になる)

SKIN = ('(surface (color 0.80 0.58 0.47) (ka 0.28) (kd 0.86) (ks 0.16) (phong 26) (roi 1.0)\n'
        '         (shader pbrsurface) (param Ka 0.28) (param Kd 0.86) (param Ks 0.16)\n'
        '         (param roughness 0.46) (param metallic 0.0) (param Kr 0.03))')
NAIL = ('(surface (color 0.86 0.71 0.65) (ka 0.28) (kd 0.80) (ks 0.30) (phong 70) (roi 1.0)\n'
        '         (shader pbrsurface) (param Ka 0.28) (param Kd 0.80) (param Ks 0.30)\n'
        '         (param roughness 0.20) (param metallic 0.0) (param Kr 0.06))')

out = r'''; hand.ssq — 手。参考図 (箱 + 円柱 + カップ) の構成をそのまま sdf に写したもの。
;
;   .\render.ps1 .\scenes\hand.ssq out.png -Width 1200 -Height 900 -AA 6 -Shadow 3 -Depth 3
;
; 対応: 手のひら = round(box) / 指節 = capsule / 関節の膨らみ = smooth-union の k /
;       指先の爪 = 扁平な ellipsoid / 親指の水かき = 親指だけ太い k (0.115) で繋ぐ。
; ナックルラインは指の付け根 z を弧に並べて作る (中指 0.985 が最遠、小指 0.855 が最手前)。
; 指は節ごとに pitch を -5/-13/-22 度と深くしてあり、力を抜いた自然な曲がりになる。
;
; ⚠ このファイルは scenes/tools/gen_hand.py の生成物。手で編集せず、生成側を直すこと。
;   再生成: python scenes/tools/gen_hand.py scenes/hand.ssq

(scene
  (background 0.58 0.62 0.66)
  (camera (from 0.72 2.02 -1.02) (at -0.05 0.14 0.86) (up 0 1 0) (fov 43))

  (light (pos -1.05 2.30 -1.35) (intensity 2.55) (color 1.00 0.96 0.90) (radius 0.06))
  (light (pos  1.60 1.10  0.60) (intensity 0.42) (color 0.74 0.82 0.96) (radius 0.60))
  (light (pos -0.30 0.55  2.30) (intensity 0.55) (color 0.98 0.90 0.84) (radius 0.50))

  (object "floor"
    (surface (color 0.52 0.52 0.54) (ka 0.18) (kd 0.86) (ks 0.03) (phong 12)
             (roi 1.0) (shader plastic)
             (param Ka 0.18) (param Kd 0.86) (param Ks 0.03) (param roughness 0.55))
    (sdf (plane (center 0 0 0) (normal 0 1 0) (offset 0))))

  (object "hand"
    %s
    (sdf %s))

  (object "nails"
    %s
    (sdf %s))
)
''' % (SKIN, ind(hand, 4).strip(), NAIL, su(0.010, *nails))

io.open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(out)
print('wrote', sys.argv[1])
