# serve.ps1 — sdfmodeler (ブラウザの階層 SDF/blob エディタ) を起動する
#   .\serve.ps1            → http://localhost:8642
#   .\serve.ps1 -Port 9000
#   .\serve.ps1 -NoBrowser  (ブラウザを開かない = エージェント/リモート用)
param([int]$Port = 8642, [switch]$NoBrowser)
. "$PSScriptRoot\lib\common.ps1"

$e = Get-SqmEnv
# 探索順は実行ファイルと同じ規則: ソースがあればそちら (常に最新)、
# 無ければ sqmexec 同梱の snapshot (配布先)
$dir = Join-Path $e.SqmRepo 'sdfmodeler'
if (-not (Test-Path $dir)) { $dir = Join-Path $PSScriptRoot 'app\sdfmodeler' }
if (-not (Test-Path $dir)) { throw "sdfmodeler が見つからない — doctor.ps1 を実行" }
Write-Host "app: $dir" -ForegroundColor DarkGray

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python3 -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw "python が見つかりません" }

# serve.py は sqm 本体を呼ぶ経路 (🎬 レンダー / メッシュ焼き) を持つので、
# ここで環境を渡しておく。⚠ serve.py 自身も Windows では sqm.exe を探して
# SQM_SHADER_CORE を補完するが、ここで渡しておくほうが確実
Set-SqmEnvVars $e
$env:SQM_BIN = $e.SqmExe

& $py -c "import numpy, skimage" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "numpy / scikit-image が無い → メッシュ表示のサーバ経路だけ使えません (pip install numpy scikit-image)"
}

Write-Host "sdfmodeler: http://localhost:$Port" -ForegroundColor Cyan
Write-Host "  (終了は Ctrl+C)"
if (-not $NoBrowser) {
    # ⚠ Windows の Chromium は既定で ANGLE→**D3D11** を使う。sdfmodeler の
    #   レイマーチ GLSL は 25 ノードを超えると HLSL コンパイラ (FXC) が
    #   数十秒かかった末に**無音で誤コンパイル**する (リンクは成功を返すのに
    #   全画素が一様色)。ANGLE のバックエンドを **Vulkan** にすると回避できる
    #   (2026-08-26 に実測確認: コンパイルが劇的に速くなる)。
    #   → Chrome があればフラグ付きで開く。無ければ既定のブラウザ。
    # ⚠ **既に Chrome が起動していると新しいプロセスにならずフラグが無視される**。
    #   別プロファイルで開くのはやりすぎなので、その場合は一度 Chrome を
    #   終了してから開き直すこと (chrome://gpu の GL_RENDERER が
    #   "ANGLE (... Vulkan ...)" になっていれば効いている)。
    $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
              Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) {
        Write-Host "  Chrome を --use-angle=vulkan で開きます (D3D の誤コンパイル回避)" -ForegroundColor DarkGray
        Start-Job { Start-Sleep 1
                    Start-Process $using:chrome -ArgumentList '--use-angle=vulkan',
                        "http://localhost:$using:Port" } | Out-Null
    } else {
        Start-Job { Start-Sleep 1; Start-Process "http://localhost:$using:Port" } | Out-Null
    }
}
& $py (Join-Path $dir 'serve.py') $Port $dir
