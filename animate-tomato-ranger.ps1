param(
    [int]$Frames = 24,
    [int]$Width = 480,
    [int]$Height = 456,
    [int]$Fps = 12,
    [string]$Out = '.\tomato_ranger_orbit.mp4'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib\common.ps1"

$scene = Join-Path $PSScriptRoot 'scenes\tomato_ranger.ssq'
$work = Join-Path $env:TEMP ("sqm-tomato-orbit-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $source = [IO.File]::ReadAllText($scene)
    $centerY = 0.95
    $radius = 4.6
    for ($i = 0; $i -lt $Frames; $i++) {
        $angle = 2.0 * [Math]::PI * $i / $Frames
        $x = [Math]::Round($radius * [Math]::Sin($angle), 5)
        $z = [Math]::Round(-$radius * [Math]::Cos($angle), 5)
        $frameScene = Join-Path $work ("frame_{0:D4}.ssq" -f $i)
        $framePng = Join-Path $work ("frame_{0:D4}.png" -f $i)
        $camera = "(camera (from $x 1.35 $z) (at 0 $centerY 0) (up 0 1 0) (fov 38))"
        $frameText = [regex]::Replace($source, '\(camera[^\r\n]*\)', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $camera }, 1)
        [IO.File]::WriteAllText($frameScene, $frameText, [Text.UTF8Encoding]::new($false))
        & "$PSScriptRoot\render.ps1" $frameScene $framePng -Width $Width -Height $Height -AA 1 -Shadow 1 -Depth 2
        if ($LASTEXITCODE -ne 0) { throw "Frame $i failed" }
    }

    $outputPath = [IO.Path]::GetFullPath($Out)
    & ffmpeg -y -framerate $Fps -i (Join-Path $work 'frame_%04d.png') -c:v libx264 -pix_fmt yuv420p -movflags +faststart $outputPath
    if ($LASTEXITCODE -ne 0) { throw 'ffmpeg failed' }
    Write-Host "OK   $outputPath"
}
finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
