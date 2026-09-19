param(
    [string]$Source = '.\tomato_ranger_mtv.mp4',
    [string]$Out = '.\tomato_ranger_mtv_music.mp4'
)

$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath($Source)
$outputPath = [IO.Path]::GetFullPath($Out)

$music = "sine=frequency=330:duration=11.5,volume=0.12,tremolo=f=4:d=0.35,lowpass=f=1800,afade=t=in:st=0:d=0.4,afade=t=out:st=10.7:d=0.8"

& ffmpeg -y -i $sourcePath -f lavfi -i $music -map 0:v:0 -map 1:a:0 -t 11.5 -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart $outputPath
if ($LASTEXITCODE -ne 0) { throw 'Music mix failed' }
Write-Host "OK   $outputPath"
