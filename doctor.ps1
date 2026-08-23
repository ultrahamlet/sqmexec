# doctor.ps1 — sqm 実行環境の診断。何が足りないかと対処を出す。
#   .\doctor.ps1
. "$PSScriptRoot\lib\common.ps1"

$e = Get-SqmEnv
$problems = @()
$warnings = @()

Write-Host ""
Write-Host "sqm 実行環境の診断" -ForegroundColor Cyan
Write-Host "workspace: $($e.Workspace)"
Write-Host ""

# ── 0. 使う実行ファイル (同梱バイナリだけでも動く) ──────────
Write-Host "[0] 実行ファイル"
if ($e.BinarySource -eq 'bundled') {
    Write-Host "  種別 同梱バイナリ (sqmexec/bin) — ソース不要で実行できます" -ForegroundColor Cyan
} else {
    Write-Host "  種別 ソースからビルドした sqm/dist (同梱より優先)" -ForegroundColor Cyan
}
$vj = Join-Path $e.BundleDir '..\VERSION.json'
if (Test-Path $vj) {
    $v = Get-Content $vj -Raw | ConvertFrom-Json
    $w = $v.platforms.'windows-x64'
    if ($w) { Write-Host "  同梱 sqm=$($w.sqm.commit) / shader.core=$($w.shader_core.commit)  (更新 $($v.updated))" }
}

# ── 1. リポジトリ (ソースからビルドする場合のみ必要) ────────
Write-Host ""
Write-Host "[1] リポジトリ (ソースからビルドする場合のみ必要)"
$srcNeeded = ($e.BinarySource -eq 'built')
foreach ($r in @(
    @{n='sqm';     p=$e.SqmRepo;    url='https://github.com/ultrahamlet/sqm.git'},
    @{n='dr_sbcl'; p=$e.DrSbclRepo; url='https://github.com/ultrahamlet/dr_sbcl.git'},
    @{n='vclay';   p=$e.VclayRepo;  url='https://github.com/ultrahamlet/vclay.git'})) {
    if (Test-Path $r.p) {
        $branch = git -C $r.p rev-parse --abbrev-ref HEAD 2>$null
        $head   = git -C $r.p log --oneline -1 2>$null
        Write-Ok "$($r.n)  [$branch] $head"
    } else {
        # 同梱バイナリで実行するだけなら無くてよい (ソース非公開の配布モデル)
        Write-Host "  --   $($r.n) 無し (実行だけなら不要。ビルドするなら: git clone $($r.url))" -ForegroundColor DarkGray
    }
}

# ── 2. ツールチェイン (ビルドする場合のみ必要) ──────────────
# ⚠ 実行だけなら丸ごと不要。sqm.exe / shader.core は静的リンクで、
#   Windows 標準の UCRT だけで動く (MSYS2 無しの最小 PATH で実測確認済み)
Write-Host ""
Write-Host "[2] ツールチェイン (ソースからビルドする場合のみ必要)"
if (-not (Test-Path $e.SqmRepo)) {
    Write-Host "  --   sqm リポジトリが無いので検査を省略 (同梱バイナリで実行する構成)" -ForegroundColor DarkGray
} elseif ($e.Ucrt64Bin -and (Test-Path (Join-Path $e.Ucrt64Bin 'gcc.exe'))) {
    $v = (& (Join-Path $e.Ucrt64Bin 'gcc.exe') --version | Select-Object -First 1)
    Write-Ok "gcc  $v"
    # ⚠ 「gcc.exe はあるのに cc1.exe が DLL を解決できない」= 原因を指さない失敗の温床
    $cc1 = Get-ChildItem (Join-Path $e.Ucrt64Bin '..\lib\gcc') -Recurse -Filter cc1.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cc1) {
        $env:PATH = $e.Ucrt64Bin + ';' + $env:PATH
        & $cc1.FullName --version > $null 2>&1
        if ($LASTEXITCODE -eq 0) { Write-Ok "cc1  実行可 (DLL 解決 OK)" }
        else { Write-Bad "cc1 が起動できない — ucrt64/bin の DLL 解決に失敗"; $problems += "MSYS2 を更新: pacman -Syu" }
    }
} else {
    Write-Bad "MSYS2 UCRT64 の gcc が無い"
    $problems += "MSYS2 を入れて: pacman -S mingw-w64-ucrt-x86_64-gcc make"
}
if ($e.Sbcl) { Write-Ok "sbcl $((& $e.Sbcl --version 2>&1))" }
else { Write-Bad "SBCL が無い (shader.core のビルドに必要)"; $problems += "SBCL を導入し sqmexec.config.json の sbcl に絶対パスを書く" }

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python3 -ErrorAction SilentlyContinue).Source }
if ($py) {
    Write-Ok "python $((& $py --version 2>&1))"
    & $py -c "import numpy, skimage" 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Ok "numpy / scikit-image  あり (sdfmodeler のメッシュ経路)" }
    else { Write-Warn2 "numpy / scikit-image が無い (sdfmodeler のメッシュ表示だけ不可)"; $warnings += "pip install numpy scikit-image" }
} else {
    Write-Warn2 "python が無い (sdfmodeler を使わないなら不要)"
}

# ── 3. ビルド成果物 ─────────────────────────────────────────
Write-Host ""
Write-Host "[3] ビルド成果物"
if (Test-Path $e.SqmExe) {
    $f = Get-Item $e.SqmExe
    Write-Ok "sqm.exe  $([int]($f.Length/1KB)) KB  $($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
    # ⚠ 実行ファイル名を変えると DR が落ちる/segfault する
    if ($f.Name -ne 'sqm.exe') { Write-Bad "実行ファイル名が sqm.exe でない — DR が壊れる" }
} else {
    Write-Bad "sqm.exe が未ビルド"
    $problems += ".\build.ps1 -Target sqm"
}
if (Test-Path $e.ShaderCore) {
    $f = Get-Item $e.ShaderCore
    Write-Ok "shader.core  $([int]($f.Length/1KB)) KB  $($f.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))"
} else {
    Write-Bad "shader.core が未ビルド — .lisp 材質が全部ネイティブ材質に化ける"
    $problems += ".\build.ps1 -Target core   (先に sqm のビルドが要る)"
}

# ── 4. 実地テスト (実際に1枚レンダーして DR ブリッジを確認) ──
Write-Host ""
Write-Host "[4] 実地テスト"
if ((Test-Path $e.SqmExe) -and (Test-Path $e.ShaderCore)) {
    Set-SqmEnvVars $e
    # 同梱の smoke.ssq を優先 (sqm リポジトリが無い配布先でも実地テストできる)
    $scene = Join-Path $PSScriptRoot 'scenes\smoke.ssq'
    if (-not (Test-Path $scene)) { $scene = Join-Path $e.SqmRepo 'scenes\bear_blob.ssq' }
    if (-not (Test-Path $scene)) {
        $scene = Get-ChildItem (Join-Path $e.SqmRepo 'scenes') -Filter *.ssq -ErrorAction SilentlyContinue |
                 Select-Object -First 1 -ExpandProperty FullName
    }
    if ($scene) {
        $out = Join-Path $env:TEMP 'sqmexec_doctor.png'
        $r = Invoke-SqmExe $e.SqmExe @('-i', $scene, '-o', $out, '-x', '120', '-y', '90', '-A', '1')
        $log = $r.Log
        if ($log -match '\[DR\] shader bridge ready') {
            Write-Ok "レンダー成功 + DR シェーダーブリッジ有効"
        } elseif (Test-Path $out) {
            Write-Bad "レンダーは通ったが DR ブリッジが無効 — .lisp 材質がネイティブに化ける"
            $problems += "shader.core を再ビルド: .\build.ps1 -Target core"
        } else {
            Write-Bad "レンダーが失敗した"
            Write-Host ($log -split "`n" | Select-Object -First 5 | Out-String)
        }
        Remove-Item $out -ErrorAction SilentlyContinue
    } else { Write-Warn2 "テスト用シーンが見つからない" }
} else {
    Write-Warn2 "ビルドが揃っていないので実地テストは省略"
}

# ── まとめ ─────────────────────────────────────────────────
Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "==> 実行できます。" -ForegroundColor Green
    Write-Host "    レンダー   : .\render.ps1 <scene.ssq> <out.png>"
    Write-Host "    エディタ   : .\serve.ps1   (http://localhost:8642)"
    if ($warnings.Count) { Write-Host ""; Write-Host "任意の追加:" -ForegroundColor Yellow; $warnings | ForEach-Object { Write-Host "    $_" } }
} else {
    Write-Host "==> 対処が必要です (上から順に):" -ForegroundColor Yellow
    $problems | ForEach-Object { Write-Host "    $_" }
    if ($warnings.Count) { Write-Host ""; Write-Host "任意の追加:"; $warnings | ForEach-Object { Write-Host "    $_" } }
    exit 1
}
