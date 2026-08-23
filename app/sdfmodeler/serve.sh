#!/bin/sh
# sdfmodeler 起動スクリプト: http サーバを立ててブラウザで開く
cd "$(dirname "$0")" || exit 1
PORT="${1:-8642}"
# 🎬/⚙ レンダで使う sqm エンジン。SQM_BIN 未設定なら (あれば) sqm リポジトリの最新ビルドを既定に
# 使う。これで Desktop 配布コピーからでも常にプロジェクト側の最新バイナリでレンダされる。
# 別環境ではこのパスを合わせるか、起動前に SQM_BIN を明示指定 (未存在なら自動スキップ)。
if [ -z "$SQM_BIN" ] && [ -x "/Users/user/Projects/sqm/dist/sqm" ]; then
  export SQM_BIN="/Users/user/Projects/sqm/dist/sqm"
fi
echo "sdfmodeler: http://localhost:$PORT"
(sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null) &
exec python3 serve.py "$PORT"
