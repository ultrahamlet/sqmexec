#!/usr/bin/env bash
# scene-from-png.sh — sqm が PNG に埋めたシーンとレンダー条件を取り出す
#
#   ./scene-from-png.sh out.png                 → 埋め込みメタの一覧
#   ./scene-from-png.sh out.png scene.ssq       → シーン本文を .ssq へ書き出す
#
# 詳細は scene-from-png.ps1 の頭のコメントを参照 (同じことをする)。
# ⚠ 書式は app/sdfmodeler/js/pngmeta.js と同じ。片方を変えたら両方直すこと。
# ⚠ チャットや SNS を経由した画像は再エンコードで iTXt が落ちる。原本を使う。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/common.sh"

[ $# -ge 1 ] || { echo "usage: $0 <in.png> [out.ssq]" >&2; exit 2; }
[ -f "$1" ] || { echo "PNG が無い: $1" >&2; exit 1; }

# python3 が無い環境 (Windows 等) では python を使う。
# ⚠ command -v では判定できない — Windows の python3 は Store のスタブが
#   PATH に居て、存在はするのに "Python" と出して 49 で落ちる。実際に走らせて試す。
py=python3; "$py" -c "" >/dev/null 2>&1 || py=python
"$py" - "$@" <<'PY'
import sys, zlib, struct
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

def chunks(d):
    if d[:8] != b'\x89PNG\r\n\x1a\n': sys.exit('PNG ではない')
    p = 8
    while p + 8 <= len(d):
        ln = struct.unpack('>I', d[p:p+4])[0]
        typ = d[p+4:p+8].decode('latin1')
        yield typ, d[p+8:p+8+ln]
        p += 12 + ln
        if typ == 'IEND': break

meta = {}
for typ, data in chunks(open(sys.argv[1], 'rb').read()):
    if typ != 'iTXt' or not data: continue
    kw, rest = data.split(b'\x00', 1)
    compflag = rest[0]                      # rest[1] = compmethod (常に 0)
    rest = rest[2:]
    _lang, rest = rest.split(b'\x00', 1)    # language tag
    _tr,   rest = rest.split(b'\x00', 1)    # translated keyword
    meta[kw.decode()] = (zlib.decompress(rest) if compflag else rest).decode('utf-8')

if not meta:
    sys.exit('  NG   sqm のメタデータが無い — sqm 出力の原本ではありません\n'
             '       チャットや SNS を経由すると再エンコードで iTXt が落ちます')

if len(sys.argv) > 2:
    scene = meta.get('sqm:scene')
    if not scene: sys.exit('sqm:scene が無い (メタはあるがシーン本文が入っていない)')
    open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write(scene)
    print('  OK   %s  (%d 文字)' % (sys.argv[2], len(scene)))

for k, v in meta.items():
    if k == 'sqm:scene':
        if len(sys.argv) <= 2:
            print('--- sqm:scene (%d 文字)' % len(v))
            print('    書き出すには: %s %s <out.ssq>' % (sys.argv[0], sys.argv[1]))
        continue
    print('---', k)
    print(v)

# ⚠ render.sh が渡さない SQM_* (コースティクス等) は手で設定する必要がある
if 'SQM_CAUSTIC' in meta.get('sqm:env', ''):
    print('  警告 コースティクス系の環境変数がある — render.sh は渡さないので手で設定する')
    print("       例: SQM_CAUSTIC_GAIN=30 ./render.sh <scene> <out> -Raw '-K ...'")
PY
