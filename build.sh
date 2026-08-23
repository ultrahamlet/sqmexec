#!/usr/bin/env bash
# build.sh — sqm 本体と shader.core をビルドする (mac/Linux)
#   ./build.sh          全部 (sqm → shader.core の順。依存があるので順序は固定)
#   ./build.sh sqm      レンダラーだけ
#   ./build.sh core     shader.core だけ (要 sqm 先行ビルド)
. "$(dirname "$0")/lib/common.sh"

TARGET="${1:-all}"
JOBS="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4 )"

[ -d "$SQM_REPO" ] || { echo "sqm リポジトリが無い: $SQM_REPO — ./doctor.sh を実行"; exit 1; }
sqm_setup_env

if [ "$TARGET" = "all" ] || [ "$TARGET" = "sqm" ]; then
  echo "[sqm] make -j$JOBS"
  ( cd "$SQM_REPO/dist" && make -j"$JOBS" )
  [ -f "$SQM_BIN_PATH" ] && ok "sqm  $(du -k "$SQM_BIN_PATH" | cut -f1) KB" || { echo "make は通ったが sqm が出来ていない"; exit 1; }
fi

# ⚠ shader.core は sqm のリンク成果物 (import lib) に依存するので必ず後。
#   1シェーダーだけ直しても core 全体が lib/*.o から再リンクされる。
if [ "$TARGET" = "all" ] || [ "$TARGET" = "core" ]; then
  [ -d "$DRSBCL_REPO" ] || { echo "dr_sbcl が無い: $DRSBCL_REPO"; exit 1; }
  command -v sbcl >/dev/null || { echo "SBCL が無い — brew install sbcl"; exit 1; }
  script=build-all.lisp
  echo "[core] sbcl --script $script"
  ( cd "$DRSBCL_REPO" && sbcl --script "$script" )
  [ -f "$SHADER_CORE" ] && ok "shader.core  $(du -k "$SHADER_CORE" | cut -f1) KB" || { echo "ビルドは通ったが shader.core が出来ていない"; exit 1; }
fi

echo ""
printf '\033[32m==> 完了。./doctor.sh で実地テストできます。\033[0m\n'
