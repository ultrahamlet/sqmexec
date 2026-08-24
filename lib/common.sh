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

# 実行ファイルの探索順 (common.ps1 の Get-SqmEnv と同じ規約):
#   ① ソースからビルドした sqm/dist (開発機。常に最新なので優先)
#   ② sqmexec 同梱の bin/<platform> (配布先。ソースを持たない環境)
# ⚠ shader.core は sqm と**同じ出所の組**で使う。混ぜると ABI が食い違って
#   落ちうるので、①②のどちらかに揃える (混成にしない)。
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) SQM_PLATFORM=darwin-arm64 ;;
  Darwin/*)     SQM_PLATFORM=darwin-x64 ;;
  Linux/aarch64) SQM_PLATFORM=linux-arm64 ;;
  *)            SQM_PLATFORM=linux-x64 ;;
esac
BUNDLE_DIR="$SQMEXEC_DIR/bin/$SQM_PLATFORM"

# 実行ファイル名は sqm から変えないこと (改名すると DR が落ちる/segfault)
if [ -f "$SQM_REPO/dist/sqm" ]; then
  SQM_BIN_PATH="$SQM_REPO/dist/sqm"
  SHADER_CORE="$DRSBCL_REPO/lib/shader.core"
  SQM_BINARY_SOURCE=built
else
  SQM_BIN_PATH="$BUNDLE_DIR/sqm"
  SHADER_CORE="$BUNDLE_DIR/shader.core"
  SQM_BINARY_SOURCE=bundled
fi

# sqm 実行に必要な環境変数をこのシェルに設定する
sqm_setup_env() {
  # ① 既定パスが macOS 固定なので必ず渡す。未設定だと .lisp 材質が
  #    エラーも出さずネイティブ材質へ落ちる
  [ -f "$SHADER_CORE" ] && export SQM_SHADER_CORE="$SHADER_CORE"
  # ② シーン内の $SQM_ROOT/... を解決する根 (Mac⇄Win でパスを焼き込まない)。
  #    配布先には sqm リポジトリが無いので、その場合は sqmexec 自身を根にする
  #    (同梱の scenes/ と assets/ がこの下にある)
  if [ -d "$SQM_REPO" ]; then export SQM_ROOT="$SQM_REPO"
  else                        export SQM_ROOT="$SQMEXEC_DIR"; fi
  # ③ 接地影の光漏れ (白い三日月)。既定 0.05 は漏れる側
  : "${SQM_SHADOW_SEPS:=0.002}"; export SQM_SHADOW_SEPS
  # ④ Homebrew libomp (Apple Silicon)。同梱バイナリは静的リンク済みで不要だが、
  #    ソースからのビルドは動的リンクなので残す
  if [ "$SQM_BINARY_SOURCE" = built ] && [ -d /opt/homebrew/opt/libomp/lib ]; then
    export DYLD_LIBRARY_PATH="/opt/homebrew/opt/libomp/lib:${DYLD_LIBRARY_PATH:-}"
  fi
}

ok()   { printf '  \033[32mOK  \033[0m %s\n' "$1"; }
warn() { printf '  \033[33m警告\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mNG  \033[0m %s\n' "$1"; }
