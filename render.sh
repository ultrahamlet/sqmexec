#!/usr/bin/env bash
# render.sh — 環境を組み立てて sqm でレンダーする自己完結ラッパ (mac/Linux)
#
#   ./render.sh scene.ssq out.png
#   ./render.sh scene.ssq out.png hq
#   ./render.sh scene.ssq out.png normal "-Q 128:20:1 -T aces:1.7:2.2"
#
# ⚠ 素の sqm を直接叩かないこと — SQM_SHADER_CORE 未設定だと .lisp 材質が
#   エラーも出さずネイティブ材質へ落ちる (Mac 既定パス以外の配置のとき)。
. "$(dirname "$0")/lib/common.sh"

SCENE="${1:?使い方: ./render.sh <scene.ssq> [out.png] [draft|normal|hq] [\"追加オプション\"]}"
OUT="${2:-${SCENE%.ssq}.png}"
QUALITY="${3:-normal}"
RAW="${4:-}"

[ -f "$SQM_BIN_PATH" ] || { echo "sqm が無い — ./build.sh を実行 (診断は ./doctor.sh)"; exit 1; }
[ -f "$SCENE" ] || { echo "シーンが無い: $SCENE"; exit 1; }

case "$QUALITY" in
  draft)  X=480;  Y=360;  A=1; S=1; D=2 ;;
  normal) X=800;  Y=600;  A=3; S=2; D=2 ;;
  hq)     X=1600; Y=1200; A=4; S=3; D=4 ;;
  *) echo "品質は draft|normal|hq"; exit 1 ;;
esac

sqm_setup_env
[ -f "$SHADER_CORE" ] || warn "shader.core が無い — .lisp 材質はネイティブ材質に化けます (./build.sh core)"

echo "sqm -i $SCENE -o $OUT -x $X -y $Y -A $A -s $S -D $D $RAW"
t0=$(date +%s)
# shellcheck disable=SC2086
log=$("$SQM_BIN_PATH" -i "$SCENE" -o "$OUT" -x $X -y $Y -A $A -s $S -D $D $RAW 2>&1 || true)
t1=$(date +%s)

# ⚠ 「絵は出たが材質が違う」を見逃さない検査
if echo "$log" | grep -q '\[DR\] shader bridge ready'; then
  ok "DR シェーダー有効 ($(echo "$log" | grep -o '\[DR\] shader bridge ready.*' | head -1))"
else
  bad "DR シェーダーブリッジが無効のまま描画されました — 材質が本物ではありません"
  echo "     SQM_SHADER_CORE = ${SQM_SHADER_CORE:-(未設定)}"
  echo "     対処: ./build.sh core"
fi
[ -f "$OUT" ] || { bad "出力が作られませんでした"; echo "$log" | head -12; exit 1; }
for pat in 'cannot open' 'mesh load failed' 'parse failed'; do
  echo "$log" | grep -q "$pat" && warn "stderr に '$pat' — 一部のジオメトリが落ちている可能性があります"
done
ok "$OUT  ($(du -k "$OUT" | cut -f1) KB / $((t1-t0)) 秒)"
