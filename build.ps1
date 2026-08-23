# build.ps1 — sqm 本体と shader.core をビルドする
#   .\build.ps1                 全部 (sqm → shader.core の順。依存があるので順序は固定)
#   .\build.ps1 -Target sqm     レンダラーだけ
#   .\build.ps1 -Target core    shader.core だけ (要 libsqm.dll.a = 先に sqm)
param(
    [ValidateSet('all', 'sqm', 'core')] [string]$Target = 'all',
    [int]$Jobs = 0
)
. "$PSScriptRoot\lib\common.ps1"

$e = Get-SqmEnv
if ($Jobs -le 0) { $Jobs = [Math]::Max(1, [Environment]::ProcessorCount) }

if (-not (Test-Path $e.SqmRepo)) { throw "sqm リポジトリが無い: $($e.SqmRepo) — doctor.ps1 を実行" }
Set-SqmEnvVars $e

# ── sqm 本体 ────────────────────────────────────────────────
# MSYS2 UCRT64 の bash 経由で make。⚠ Git Bash や素の cmd から叩くと
# cc1.exe が ucrt64 の DLL を解決できず、権限エラーなど**原因を指さない**
# 失敗をする (CLAUDE.md の「嘘をつく失敗」参照)
if ($Target -eq 'all' -or $Target -eq 'sqm') {
    Write-Host "[sqm] make -j$Jobs" -ForegroundColor Cyan
    $dist = ConvertTo-MsysPath (Join-Path $e.SqmRepo 'dist')
    Invoke-Ucrt64 "cd '$dist' && make -j$Jobs"
    if (Test-Path $e.SqmExe) {
        Write-Ok "sqm.exe  $([int]((Get-Item $e.SqmExe).Length/1KB)) KB"
    } else { throw "make は通ったが sqm.exe が出来ていない" }
}

# ── shader.core ─────────────────────────────────────────────
# ⚠ sqm.exe のリンク時に出る libsqm.dll.a を import lib として使うので、
#   **必ず sqm を先にビルドする**。1シェーダーだけ直しても core 全体が
#   lib/*.o から再リンクされる。
if ($Target -eq 'all' -or $Target -eq 'core') {
    if (-not (Test-Path $e.DrSbclRepo)) { throw "dr_sbcl が無い: $($e.DrSbclRepo)" }
    if (-not $e.Sbcl) { throw "SBCL が見つからない — sqmexec.config.json の sbcl に絶対パスを書く" }
    $implib = Join-Path $e.SqmRepo 'dist\libsqm.dll.a'
    if (-not (Test-Path $implib)) { throw "libsqm.dll.a が無い — 先に .\build.ps1 -Target sqm" }

    $script = if ($IsWindows -ne $false) { 'build-all-win.lisp' } else { 'build-all.lisp' }
    if (-not (Test-Path (Join-Path $e.DrSbclRepo $script))) { $script = 'build-all.lisp' }
    Write-Host "[core] sbcl --script $script" -ForegroundColor Cyan

    # SBCL_HOME は sbcl.exe の置き場 (contrib の解決に要る)
    $env:SBCL_HOME = Split-Path $e.Sbcl -Parent
    Push-Location $e.DrSbclRepo
    try {
        & $e.Sbcl --script $script
        if ($LASTEXITCODE -ne 0) { throw "shader.core のビルドに失敗 (exit $LASTEXITCODE)" }
    } finally { Pop-Location }

    if (Test-Path $e.ShaderCore) {
        Write-Ok "shader.core  $([int]((Get-Item $e.ShaderCore).Length/1KB)) KB"
    } else { throw "ビルドは通ったが shader.core が出来ていない" }
}

Write-Host ""
Write-Host "==> 完了。.\doctor.ps1 で実地テストできます。" -ForegroundColor Green
