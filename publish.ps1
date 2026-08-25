# publish.ps1 — 開発機で「配布物」を更新する (開発者用。配布先では使わない)
#
#   .\publish.ps1
#
# ソースからビルドした成果物を sqmexec に取り込み、由来を VERSION.json に記録する:
#   bin/windows-x64/sqm.exe      ← sqm/dist/sqm.exe
#   bin/windows-x64/shader.core  ← dr_sbcl/lib/shader.core
#   app/sdfmodeler/              ← sqm/sdfmodeler (**git 管理下のファイルだけ**)
#
# ⚠ app/sdfmodeler は snapshot であって原本ではない。編集は必ず sqm 側で行い、
#   ここへは publish で流す (逆流させると「どちらが本物か」が分からなくなる)。
# ⚠ 複製は `git ls-files` 経由 = 未追跡の作業ファイル・生成データ (examples/grids
#   の .f32、デバッグ出力など) は自動で除外される。
param([switch]$SkipApp, [switch]$SkipBin)

# ⚠ PS 5.1 の ConvertTo-Json は独自の階段状インデントと CRLF で書く。macOS 側は
#   4 スペース + LF なので、値が同じでも**ファイル全体が毎回衝突する**。
#   -Compress で 1 行にしてから、macOS 側と同じ体裁に組み直す。
function Format-JsonPlain([string]$compact) {
    $sb = New-Object Text.StringBuilder
    $depth = 0; $inStr = $false; $esc = $false
    foreach ($ch in $compact.ToCharArray()) {
        if ($esc)          { [void]$sb.Append($ch); $esc = $false; continue }
        if ($ch -eq '')   { [void]$sb.Append($ch); $esc = $true;  continue }
        if ($ch -eq '"')   { $inStr = -not $inStr; [void]$sb.Append($ch); continue }
        if ($inStr)        { [void]$sb.Append($ch); continue }
        switch ($ch) {
            '{'     { $depth++; [void]$sb.Append("{`n" + (' ' * 4 * $depth)) }
            '['     { $depth++; [void]$sb.Append("[`n" + (' ' * 4 * $depth)) }
            '}'     { $depth--; [void]$sb.Append("`n" + (' ' * 4 * $depth) + '}') }
            ']'     { $depth--; [void]$sb.Append("`n" + (' ' * 4 * $depth) + ']') }
            ','     { [void]$sb.Append(",`n" + (' ' * 4 * $depth)) }
            ':'     { [void]$sb.Append(': ') }
            default { if ($ch -notmatch '\s') { [void]$sb.Append($ch) } }
        }
    }
    $sb.ToString()
}
. "$PSScriptRoot\lib\common.ps1"

$e = Get-SqmEnv
if (-not (Test-Path $e.SqmRepo))    { throw "sqm リポジトリが無い — publish は開発機で実行する" }
if (-not (Test-Path $e.BuiltExe))   { throw "sqm.exe が未ビルド — .\build.ps1 を先に" }
if (-not (Test-Path $e.BuiltCore))  { throw "shader.core が未ビルド — .\build.ps1 -Target core を先に" }

$binDir = Join-Path $PSScriptRoot 'bin\windows-x64'
$appDir = Join-Path $PSScriptRoot 'app\sdfmodeler'

# ── バイナリ ────────────────────────────────────────────────
if (-not $SkipBin) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item $e.BuiltExe  (Join-Path $binDir 'sqm.exe')     -Force
    Copy-Item $e.BuiltCore (Join-Path $binDir 'shader.core') -Force
    Write-Ok "bin/windows-x64  sqm.exe + shader.core"
}

# ── sdfmodeler (ブラウザエディタ一式) ───────────────────────
if (-not $SkipApp) {
    if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    # ⚠ `git ls-files` は非 ASCII のファイル名 (起動.command) を 8 進エスケープ付き
    #    の引用文字列で返すので、パスとして使うと "Illegal characters in path" になる。
    #    git archive なら符号化を git が扱うので安全 (かつ追跡ファイルだけが出る)。
    $tar = Join-Path $env:TEMP 'sqmexec_app.tar'
    try {
        # ⚠ *.command (Mac 専用ランチャ。1つは日本語ファイル名) を除外する —
        #    Windows 同梱の bsdtar が非 ASCII 名で "Invalid empty pathname" を出して
        #    展開ごと失敗する。sqmexec は独自の serve.ps1/serve.sh を持つので不要。
        git -C $e.SqmRepo archive --format=tar -o $tar HEAD sdfmodeler `
            ':(exclude)sdfmodeler/*.command'
        if ($LASTEXITCODE -ne 0) { throw "git archive に失敗" }
        # sdfmodeler/ の一段を剥がして app/sdfmodeler に展開
        tar -x -f $tar -C $appDir --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw "tar 展開に失敗" }
    } finally { Remove-Item $tar -ErrorAction SilentlyContinue }
    # マシン固有の設定は配らない
    Remove-Item (Join-Path $appDir '.claude') -Recurse -Force -ErrorAction SilentlyContinue
    $n = (Get-ChildItem $appDir -Recurse -File).Count
    $kb = [int](((Get-ChildItem $appDir -Recurse -File | Measure-Object Length -Sum).Sum)/1KB)
    Write-Ok "app/sdfmodeler  $n ファイル / $kb KB"
}

# ── 由来の記録 ──────────────────────────────────────────────
# ⚠ Windows PowerShell 5.1 はネイティブコマンドの出力を [Console]::OutputEncoding
#   (日本語環境では CP932) で復号する。git は UTF-8 で出しているので、そのままだと
#   `git log --format=%s` の日本語が文字化けして VERSION.json に焼き付く
#   (2026-08-25 に実際に混入した)。git を呼ぶ間だけ UTF-8 に切り替える。
$jsonPath = Join-Path $PSScriptRoot 'bin\VERSION.json'
# ⚠ **既存の VERSION.json を読んで、自分が更新した欄だけ差し替える。**
#   ゼロから組み直すと、他のマシンが足した欄が消える。実際 Windows でこれを
#   実行すると macOS 側が同梱した darwin-arm64 のブロックが丸ごと消えていた。
#   同じ理由で -SkipBin / -SkipApp のときは**その欄に触らない** — バイナリを
#   差し替えていないのに commit だけ今の HEAD に書き換えると、メタデータが
#   同梱物と食い違う (2026-08-25 に実際に起きた。sqm が別ブランチにいたため
#   main に無いコミットが焼き付いた)。
$old = $null
if (Test-Path $jsonPath) {
    try { $old = Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Write-Warn2 "VERSION.json を読めなかった — 新規に作り直します" }
}

# sqm がどのブランチに居るかを見せる。publish は main の状態を配る前提。
$sqmBranch = (git -C $e.SqmRepo rev-parse --abbrev-ref HEAD)
if ($sqmBranch -ne 'main') {
    Write-Warn2 "sqm が '$sqmBranch' ブランチです — main の状態を配るつもりなら切り替えてください"
}

$prevOutEnc = [Console]::OutputEncoding
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
try {

# 既存の platforms を順序ごと引き継ぐ
$platforms = [ordered]@{}
if ($old -and $old.platforms) {
    foreach ($p in $old.platforms.PSObject.Properties) { $platforms[$p.Name] = $p.Value }
}
if (-not $SkipBin) {
    $platforms['windows-x64'] = [ordered]@{
        sqm = [ordered]@{
            commit  = (git -C $e.SqmRepo rev-parse --short HEAD)
            subject = (git -C $e.SqmRepo log -1 --format=%s)
            bytes   = (Get-Item (Join-Path $binDir 'sqm.exe')).Length
        }
        shader_core = [ordered]@{
            commit  = (git -C $e.DrSbclRepo rev-parse --short HEAD)
            subject = (git -C $e.DrSbclRepo log -1 --format=%s)
            bytes   = (Get-Item (Join-Path $binDir 'shader.core')).Length
        }
        built_with   = "MSYS2 UCRT64 GCC 16.2.0 (static link)"
        runtime_deps = "Windows 10/11 のシステム DLL のみ (UCRT)。MSYS2 不要 — 実測確認済み"
    }
} elseif (-not $platforms.Contains('windows-x64')) {
    Write-Warn2 "-SkipBin だが VERSION.json に windows-x64 が無い — 欄は空のままです"
}

if (-not $SkipApp) {
    $app = [ordered]@{
        sdfmodeler = [ordered]@{
            commit = (git -C $e.SqmRepo rev-parse --short HEAD)
            note   = "sqm/sdfmodeler の追跡ファイルの snapshot。原本は sqm 側"
        }
    }
} elseif ($old -and $old.app) {
    $app = $old.app
} else {
    $app = [ordered]@{}
}

$v = [ordered]@{
    updated   = (Get-Date -Format 'yyyy-MM-dd')
    platforms = $platforms
    app       = $app
}
} finally { [Console]::OutputEncoding = $prevOutEnc }
# ⚠ Set-Content -Encoding utf8 は PS 5.1 では **BOM 付き**になる。macOS 側の
#   生成物は BOM 無しなので、BOM が付くだけで毎回ファイル全体が衝突する。
[IO.File]::WriteAllText($jsonPath,
                        ((Format-JsonPlain ($v | ConvertTo-Json -Depth 6 -Compress)) + "`n"),
                        (New-Object Text.UTF8Encoding $false))
Write-Ok "bin/VERSION.json を更新"

Write-Host ""
Write-Host "==> 配布物を更新しました。git add -A してコミットしてください。" -ForegroundColor Green
