param(
    [string]$Source = '.\tomato_ranger_final_ol.mp4',
    [string]$Out = '.\tomato_ranger_mtv.mp4'
)

$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath($Source)
$outputPath = [IO.Path]::GetFullPath($Out)
$work = Join-Path $env:TEMP ("sqm-tomato-mtv-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $tile = Join-Path $work 'tile.mp4'
    $negative = Join-Path $work 'negative.mp4'
    $affine = Join-Path $work 'affine.mp4'
    $normal = Join-Path $work 'normal.mp4'
    $list = Join-Path $work 'concat.txt'

    & ffmpeg -y -i $sourcePath -ss 0 -t 3 -filter_complex `
        "[0:v]split=4[a][b][c][d];[a]scale=240:228,eq=saturation=1.8[aa];[b]scale=240:228,hflip,hue=h=45,eq=saturation=1.6[bb];[c]scale=240:228,vflip,hue=h=-35,eq=saturation=1.7[cc];[d]scale=240:228,negate[dd];[aa][bb]hstack[top];[cc][dd]hstack[bottom];[top][bottom]vstack,format=yuv420p[v]" `
        -map "[v]" -an -c:v libx264 -r 12 $tile
    if ($LASTEXITCODE -ne 0) { throw 'Tile segment failed' }

    & ffmpeg -y -i $sourcePath -ss 3 -t 2.5 -vf "negate,eq=contrast=1.35:saturation=2.2,hue=h=90*sin(2*PI*t)" -an -c:v libx264 -pix_fmt yuv420p -r 12 $negative
    if ($LASTEXITCODE -ne 0) { throw 'Negative segment failed' }

    & ffmpeg -y -i $sourcePath -ss 5.5 -t 2.5 -vf "rotate=0.10*sin(2*PI*t):ow=iw:oh=ih:fillcolor=black,eq=saturation=2.0:contrast=1.25,format=yuv420p" -an -c:v libx264 -r 12 $affine
    if ($LASTEXITCODE -ne 0) { throw 'Affine segment failed' }

    & ffmpeg -y -i $sourcePath -ss 8 -t 3.5 -vf "format=yuv420p" -an -c:v libx264 -r 12 $normal
    if ($LASTEXITCODE -ne 0) { throw 'Final segment failed' }

    @("file '$tile'", "file '$negative'", "file '$affine'", "file '$normal'") |
        Set-Content -LiteralPath $list -Encoding ascii
    & ffmpeg -y -f concat -safe 0 -i $list -c copy -movflags +faststart $outputPath
    if ($LASTEXITCODE -ne 0) { throw 'MTV concat failed' }
    Write-Host "OK   $outputPath"
}
finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
