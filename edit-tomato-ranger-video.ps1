param(
    [string]$Out = '.\tomato_ranger_final.mp4'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib\common.ps1"

$scene = Join-Path $PSScriptRoot 'scenes\tomato_ranger.ssq'
$orbit = Join-Path $PSScriptRoot 'tomato_ranger_orbit.mp4'
$work = Join-Path $env:TEMP ("sqm-tomato-edit-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $source = [IO.File]::ReadAllText($scene)
    $frontScene = Join-Path $work 'front.ssq'
    $frontPng = Join-Path $work 'front.png'
    $frontCamera = '(camera (from 0 1.35 -4.6) (at 0 0.95 0) (up 0 1 0) (fov 38))'
    $frontText = [regex]::Replace($source, '\(camera[^\r\n]*\)', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $frontCamera }, 1)
    [IO.File]::WriteAllText($frontScene, $frontText, [Text.UTF8Encoding]::new($false))
    & "$PSScriptRoot\render.ps1" $frontScene $frontPng -Width 480 -Height 456 -AA 1 -Shadow 1 -Depth 2
    if ($LASTEXITCODE -ne 0) { throw 'Front frame render failed' }

    $front3 = Join-Path $work 'front3.mp4'
    $frontOl = Join-Path $work 'front_ol.mp4'
    $reverse = Join-Path $work 'reverse.mp4'
    $end5 = Join-Path $work 'end5.mp4'

    & ffmpeg -y -loop 1 -i $frontPng -t 3 -r 12 -c:v libx264 -pix_fmt yuv420p $front3
    if ($LASTEXITCODE -ne 0) { throw 'Front still segment failed' }
    & ffmpeg -y -i $front3 -i $orbit -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=2.5,format=yuv420p[v]" -map "[v]" -an -c:v libx264 -r 12 $frontOl
    if ($LASTEXITCODE -ne 0) { throw 'Front overlap transition failed' }
    & ffmpeg -y -i $orbit -vf reverse -an -c:v libx264 -pix_fmt yuv420p $reverse
    if ($LASTEXITCODE -ne 0) { throw 'Reverse segment failed' }
    & ffmpeg -y -loop 1 -i $frontPng -t 5 -r 12 -vf "drawtext=font='Arial':text='END':fontcolor=white:fontsize=42:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-28" -c:v libx264 -pix_fmt yuv420p $end5
    if ($LASTEXITCODE -ne 0) { throw 'End segment failed' }

    $list = Join-Path $work 'concat.txt'
    @("file '$frontOl'", "file '$reverse'", "file '$end5'") |
        Set-Content -LiteralPath $list -Encoding ascii
    $outputPath = [IO.Path]::GetFullPath($Out)
    & ffmpeg -y -f concat -safe 0 -i $list -c copy -movflags +faststart $outputPath
    if ($LASTEXITCODE -ne 0) { throw 'Final concat failed' }
    Write-Host "OK   $outputPath"
}
finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
