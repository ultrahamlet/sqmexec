#!/usr/bin/env bash
# serve.sh — sdfmodeler (ブラウザの階層 SDF/blob エディタ) を起動 (mac/Linux)
#   ./serve.sh          → http://localhost:8642
#   ./serve.sh 9000
. "$(dirname "$0")/lib/common.sh"

PORT="${1:-8642}"
# 探索順は実行ファイルと同じ規則 (serve.ps1 と揃える): ソースがあればそちら
# (常に最新)、無ければ sqmexec 同梱の snapshot。
# ⚠ フォールバックが無いと、**ソースを持たない配布先では同梱した app/sdfmodeler を
#   配っているのに起動できない** (2026-08-25 に serve.ps1 とのズレとして発見)。
DIR="$SQM_REPO/sdfmodeler"
[ -d "$DIR" ] || DIR="$SQMEXEC_DIR/app/sdfmodeler"
[ -d "$DIR" ] || { echo "sdfmodeler が見つからない — ./doctor.sh を実行"; exit 1; }
echo "app: $DIR"
command -v python3 >/dev/null || { echo "python3 が見つかりません"; exit 1; }

# serve.py は sqm 本体を呼ぶ経路 (🎬 レンダー / メッシュ焼き) を持つので環境を渡す
sqm_setup_env
export SQM_BIN="$SQM_BIN_PATH"

python3 -c "import numpy, skimage" 2>/dev/null || \
  warn "numpy / scikit-image が無い → メッシュ表示のサーバ経路だけ使えません (pip3 install numpy scikit-image)"

echo "sdfmodeler: http://localhost:$PORT  (終了は Ctrl+C)"
( sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
exec python3 "$DIR/serve.py" "$PORT" "$DIR"
