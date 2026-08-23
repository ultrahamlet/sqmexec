# render.ps1 — 環境を組み立てて sqm でレンダーする自己完結ラッパ
#
#   .\render.ps1 scene.ssq out.png
#   .\render.ps1 scene.ssq out.png -Quality hq
#   .\render.ps1 scene.ssq out.png -Width 1600 -Height 1200 -AA 4
#   .\render.ps1 scene.ssq out.png -Raw "-Q 128:20:1 -T aces:1.7:2.2"
#
# ⚠ 素の sqm.exe を直接叩かないこと — SQM_SHADER_CORE 未設定だと .lisp 材質が
#   **エラーも出さずに**ネイティブ材質へ落ちる (Mac と絵が変わる)。
param(
    [Parameter(Mandatory=$true, Position=0)] [string]$Scene,
    [Parameter(Position=1)] [string]$Out = '',
    [ValidateSet('draft', 'normal', 'hq')] [string]$Quality = 'normal',
    [int]$Width = 0, [int]$Height = 0, [int]$AA = 0,
    [int]$Shadow = -1, [int]$Depth = -1,
    [string]$Raw = ''
)
. "$PSScriptRoot\lib\common.ps1"

$e = Get-SqmEnv
if (-not (Test-Path $e.SqmExe)) { throw "sqm.exe が無い — .\build.ps1 を実行 (診断は .\doctor.ps1)" }
if (-not (Test-Path $Scene))    { throw "シーンが無い: $Scene" }
$Scene = (Resolve-Path $Scene).Path
if (-not $Out) { $Out = [IO.Path]::ChangeExtension($Scene, '.png') }

# 品質プリセット (個別指定があればそちらが勝つ)
$preset = switch ($Quality) {
    'draft'  { @{ x=480;  y=360;  A=1; s=1; D=2 } }
    'normal' { @{ x=800;  y=600;  A=3; s=2; D=2 } }
    'hq'     { @{ x=1600; y=1200; A=4; s=3; D=4 } }
}
if ($Width  -gt 0) { $preset.x = $Width }
if ($Height -gt 0) { $preset.y = $Height }
if ($AA     -gt 0) { $preset.A = $AA }
if ($Shadow -ge 0) { $preset.s = $Shadow }
if ($Depth  -ge 0) { $preset.D = $Depth }

# ここで環境を組み立てる (シェル状態は呼び出し間で残らないので毎回やる)
Set-SqmEnvVars $e
if (-not (Test-Path $e.ShaderCore)) {
    Write-Warn2 "shader.core が無い — .lisp 材質はネイティブ材質に化けます (.\build.ps1 -Target core)"
}

$args = @('-i', $Scene, '-o', $Out,
          '-x', $preset.x, '-y', $preset.y, '-A', $preset.A, '-s', $preset.s, '-D', $preset.D)
if ($Raw) { $args += ($Raw -split '\s+' | Where-Object { $_ }) }

Write-Host "sqm $($args -join ' ')" -ForegroundColor DarkGray
$t0 = Get-Date
$r = Invoke-SqmExe $e.SqmExe $args
$log = $r.Log
$sec = ((Get-Date) - $t0).TotalSeconds

# ⚠ 「絵は出たが材質が違う」を見逃さないための検査。この行が無ければ
#   DR シェーダーが読めていない = 出力を信用してはいけない
if ($log -notmatch '\[DR\] shader bridge ready') {
    Write-Bad "DR シェーダーブリッジが無効のまま描画されました — 材質が本物ではありません"
    Write-Host "     SQM_SHADER_CORE = $env:SQM_SHADER_CORE"
    Write-Host "     対処: .\build.ps1 -Target core"
} else {
    # ダッシュは環境で文字化けしうるので \D+ で吸収する
    $m = [regex]::Match($log, 'shader bridge ready\D+(\d+)\s*light')
    Write-Ok ("DR シェーダー有効" + $(if ($m.Success) { " (light $($m.Groups[1].Value))" } else { "" }))
}
if (-not (Test-Path $Out)) {
    Write-Bad "出力が作られませんでした"
    Write-Host ($log -split "`n" | Select-Object -First 12 | Out-String)
    exit 1
}
# シーンが外部ファイル (mesh/grid) を開けなかったときは真っ黒にならず黙って欠ける
foreach ($pat in @('cannot open', 'mesh load failed', 'parse failed')) {
    if ($log -match $pat) { Write-Warn2 "stderr に '$pat' — 一部のジオメトリが落ちている可能性があります" }
}
Write-Ok "$Out  ($([int]((Get-Item $Out).Length/1KB)) KB / $([Math]::Round($sec,1)) 秒)"
