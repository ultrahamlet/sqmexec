# common.ps1 — ワークスペース解決と環境組み立て (全スクリプト共通)
#
# ⚠ Claude Code のシェルツールは呼び出しごとに新しいシェルなので、
#   環境変数を「設定しておく」ことができない。各ラッパがその場で
#   Get-SqmEnv を呼んで自己完結させる設計にしてある。

$ErrorActionPreference = 'Stop'

# ワークスペース根 (sqm/ dr_sbcl/ が並ぶディレクトリ) を決める。
# 優先順: ①環境変数 SQM_WORKSPACE ②sqmexec.config.json ③このリポジトリの親
function Get-Workspace {
    if ($env:SQM_WORKSPACE -and (Test-Path $env:SQM_WORKSPACE)) {
        return (Resolve-Path $env:SQM_WORKSPACE).Path
    }
    $cfg = Join-Path $PSScriptRoot '..\sqmexec.config.json'
    if (Test-Path $cfg) {
        $j = Get-Content $cfg -Raw | ConvertFrom-Json
        if ($j.workspace -and (Test-Path $j.workspace)) {
            return (Resolve-Path $j.workspace).Path
        }
    }
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

# 設定ファイルの任意項目を読む (無ければ $null)
function Get-Config([string]$key) {
    $cfg = Join-Path $PSScriptRoot '..\sqmexec.config.json'
    if (-not (Test-Path $cfg)) { return $null }
    $j = Get-Content $cfg -Raw | ConvertFrom-Json
    return $j.$key
}

# SBCL の実行ファイルを探す (config > PATH > 既知の場所)
function Find-Sbcl {
    $c = Get-Config 'sbcl'
    if ($c -and (Test-Path $c)) { return $c }
    $p = (Get-Command sbcl -ErrorAction SilentlyContinue).Source
    if ($p) { return $p }
    foreach ($cand in @(
        "$env:USERPROFILE\sbcl\PFiles\Steel Bank Common Lisp\sbcl.exe",
        "C:\Program Files\Steel Bank Common Lisp\sbcl.exe")) {
        if (Test-Path $cand) { return $cand }
    }
    return $null
}

# MSYS2 の根 (config > 既知の場所)
function Find-Msys2 {
    $c = Get-Config 'msys2'
    if ($c -and (Test-Path $c)) { return $c }
    foreach ($cand in @('C:\msys64', 'C:\msys2')) { if (Test-Path $cand) { return $cand } }
    return $null
}

# sqm 実行に必要な情報を1つのオブジェクトにまとめる。
# 実在チェックはしない (doctor がやる) — パスの組み立てだけ担当。
#
# 実行ファイルの探索順:
#   ① ソースからビルドした sqm/dist (開発機。常に最新なので優先)
#   ② sqmexec 同梱の bin/windows-x64 (配布先。ソースを持たない環境)
# ⚠ shader.core は sqm.exe と**同じ出所の組**で使う。混ぜると ABI が
#   食い違って落ちうるので、①②のどちらかに揃える (混成にしない)。
function Get-SqmEnv {
    $ws = Get-Workspace
    $msys = Find-Msys2
    $bundle = Join-Path $PSScriptRoot '..\bin\windows-x64'

    $builtExe  = Join-Path $ws 'sqm\dist\sqm.exe'
    $builtCore = Join-Path $ws 'dr_sbcl\lib\shader.core'
    $bundExe   = Join-Path $bundle 'sqm.exe'
    $bundCore  = Join-Path $bundle 'shader.core'

    if (Test-Path $builtExe) { $exe = $builtExe; $core = $builtCore; $src = 'built' }
    else                     { $exe = $bundExe;  $core = $bundCore;  $src = 'bundled' }

    [PSCustomObject]@{
        Workspace   = $ws
        SqmRepo     = Join-Path $ws 'sqm'
        DrSbclRepo  = Join-Path $ws 'dr_sbcl'
        VclayRepo   = Join-Path $ws 'vclay'
        SqmExe      = $exe
        ShaderCore  = $core
        BinarySource= $src          # 'built' = ソースから / 'bundled' = 同梱
        BundleDir   = $bundle
        BuiltExe    = $builtExe
        BuiltCore   = $builtCore
        Msys2       = $msys
        Ucrt64Bin   = if ($msys) { Join-Path $msys 'ucrt64\bin' } else { $null }
        MsysBash    = if ($msys) { Join-Path $msys 'usr\bin\bash.exe' } else { $null }
        Sbcl        = Find-Sbcl
    }
}

# 現在のプロセスに sqm 実行用の環境変数を設定する。
# ⚠ 呼び出し元のシェルにしか効かない = 各ラッパの中で毎回呼ぶこと。
function Set-SqmEnvVars($e) {
    # ① shader.core: 既定パスが macOS 固定なので必ず渡す。
    #    未設定だと .lisp 材質が黙ってネイティブ材質に落ちる (エラーは出ない)
    if (Test-Path $e.ShaderCore) {
        $env:SQM_SHADER_CORE = ($e.ShaderCore -replace '\\', '/')
    }
    # ② シーン内の $SQM_ROOT/... を解決する根 (Mac⇄Win でパスを焼き込まないため)
    $env:SQM_ROOT = $e.SqmRepo
    # ③ 接地影の光漏れ (白い三日月)。既定 0.05 は漏れる側なので実用値へ
    if (-not $env:SQM_SHADOW_SEPS) { $env:SQM_SHADOW_SEPS = '0.002' }
    # ④ ucrt64/bin を PATH 先頭へ (ビルドだけでなく実行時 DLL 解決にも要る)
    if ($e.Ucrt64Bin -and (Test-Path $e.Ucrt64Bin) -and ($env:PATH -notlike "*$($e.Ucrt64Bin)*")) {
        $env:PATH = $e.Ucrt64Bin + ';' + $env:PATH
    }
    # ⑤ GPU DLL の場所だけ通しておく (あれば)。sqm.exe の既定探索は cwd 相対
    #    "../gpu/sqm_gpu.dll" なので、sqmexec から起動すると見つからない。
    #    プリパス等の GPU 機能自体は opt-in のまま (SQM_SHADOW_PREPASS=1 など。
    #    影が支配的な多ライト+blob シーンで数倍速くなる — 渋谷 2026-08-26: 422s→67s。
    #    no-blend シーンは SQM_GPU_MB_NOBLEND_SHADOW=1 も併せて)
    if (-not $env:SQM_GPU_DLL) {
        $gdll = Join-Path $e.SqmRepo 'gpu\sqm_gpu.dll'
        if (Test-Path $gdll) { $env:SQM_GPU_DLL = $gdll }
    }
}

# MSYS2 UCRT64 の bash でコマンドを実行 (ビルド用)
function Invoke-Ucrt64([string]$cmd, [int]$timeoutSec = 900) {
    $e = Get-SqmEnv
    if (-not $e.MsysBash -or -not (Test-Path $e.MsysBash)) {
        throw "MSYS2 の bash が見つかりません。doctor.ps1 を実行してください"
    }
    $env:MSYSTEM = 'UCRT64'
    & $e.MsysBash -lc $cmd
    if ($LASTEXITCODE -ne 0) { throw "コマンドが失敗しました (exit $LASTEXITCODE): $cmd" }
}

# Windows パス → MSYS2 パス (C:\a\b → /c/a/b)
function ConvertTo-MsysPath([string]$p) {
    $full = (Resolve-Path $p -ErrorAction SilentlyContinue)
    if ($full) { $p = $full.Path }
    if ($p -match '^([A-Za-z]):[\\/](.*)$') {
        return '/' + $Matches[1].ToLower() + '/' + ($Matches[2] -replace '\\', '/')
    }
    return ($p -replace '\\', '/')
}

# sqm を実行して stdout+stderr を1つの文字列で返す。
# ⚠ PowerShell 5.1 では native exe に `2>&1` を使ってはいけない — stderr の各行が
#   ErrorRecord (NativeCommandError) に包まれ、exe が 0 で正常終了しても $? が
#   false になる。$ErrorActionPreference='Stop' と組むとその場で例外になり、
#   「sqm が失敗した」ように見える (実際は成功している)。stderr は一時ファイルへ
#   逃がして読むのが確実。
#   `&` に `2>` を付ける形でも同じ罠を踏むので、Start-Process で PowerShell の
#   stderr 処理を丸ごと迂回する (子プロセスが直接ファイルに書く)。
function Invoke-SqmExe([string]$exe, [string[]]$argv) {
    $o = [IO.Path]::GetTempFileName()
    $r = [IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $exe -ArgumentList $argv -NoNewWindow -Wait -PassThru `
                           -RedirectStandardOutput $o -RedirectStandardError $r
        $so = if (Test-Path $o) { Get-Content $o -Raw -ErrorAction SilentlyContinue } else { '' }
        $se = if (Test-Path $r) { Get-Content $r -Raw -ErrorAction SilentlyContinue } else { '' }
        return [PSCustomObject]@{ Log = "$so`n$se"; ExitCode = $p.ExitCode }
    } finally {
        Remove-Item $o, $r -ErrorAction SilentlyContinue
    }
}

function Write-Ok([string]$m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  警告 $m" -ForegroundColor Yellow }
function Write-Bad([string]$m)  { Write-Host "  NG   $m" -ForegroundColor Red }
