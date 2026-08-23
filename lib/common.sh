# common.sh — ワークスペース解決と環境組み立て (mac/Linux 版・source して使う)
#
# ⚠ Claude Code のシェルツールは呼び出しごとに新しいシェルなので、環境変数を
#   「設定しておく」ことができない。各ラッパがその場で sqm_setup_env を
#   呼んで自己完結させる設計。

set -eu

SQMEXEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ワークスペース根: ①$SQM_WORKSPACE ②sqmexec.config.json ③このリポジトリの親
sqm_workspace() {
  if [ -n "${SQM_WORKSPACE:-}" ] && [ -d "$SQM_WORKSPACE" ]; then
    echo "$SQM_WORKSPACE"; return
  fi
  local cfg="$SQMEXEC_DIR/sqmexec.config.json"
  if [ -f "$cfg" ] && command -v python3 >/dev/null 2>&1; then
    local w
    w=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('workspace',''))" "$cfg" 2>/dev/null || true)
    if [ -n "$w" ] && [ -d "$w" ]; then echo "$w"; return; fi
  fi
  (cd "$SQMEXEC_DIR/.." && pwd)
}

WS="$(sqm_workspace)"
SQM_REPO="$WS/sqm"
DRSBCL_REPO="$WS/dr_sbcl"
VCLAY_REPO="$WS/vclay"
SHADER_CORE="$DRSBCL_REPO/lib/shader.core"
# 実行ファイル名は sqm から変えないこと (改名すると DR が落ちる/segfault)
SQM_BIN_PATH="$SQM_REPO/dist/sqm"
[ -f "$SQM_BIN_PATH" ] || [ ! -f "$SQM_BIN_PATH.exe" ] || SQM_BIN_PATH="$SQM_BIN_PATH.exe"

# sqm 実行に必要な環境変数をこのシェルに設定する
sqm_setup_env() {
  # ① 既定パスが macOS 固定なので必ず渡す。未設定だと .lisp 材質が
  #    エラーも出さずネイティブ材質へ落ちる
  [ -f "$SHADER_CORE" ] && export SQM_SHADER_CORE="$SHADER_CORE"
  # ② シーン内の $SQM_ROOT/... を解決する根 (Mac⇄Win でパスを焼き込まない)
  export SQM_ROOT="$SQM_REPO"
  # ③ 接地影の光漏れ (白い三日月)。既定 0.05 は漏れる側
  : "${SQM_SHADOW_SEPS:=0.002}"; export SQM_SHADOW_SEPS
  # ④ Homebrew libomp (Apple Silicon)
  if [ -d /opt/homebrew/opt/libomp/lib ]; then
    export DYLD_LIBRARY_PATH="/opt/homebrew/opt/libomp/lib:${DYLD_LIBRARY_PATH:-}"
  fi
}

ok()   { printf '  \033[32mOK  \033[0m %s\n' "$1"; }
warn() { printf '  \033[33m警告\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mNG  \033[0m %s\n' "$1"; }
