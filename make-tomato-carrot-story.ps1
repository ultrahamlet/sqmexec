param(
    [string]$Out = '.\tomato_carrot_story.mp4'
)

$ErrorActionPreference = 'Stop'
$outPath = [IO.Path]::GetFullPath($Out)
$work = Join-Path $env:TEMP ("sqm-story-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $ass = Join-Path $work 'story.ass'
    @'
[Script Info]
ScriptType: v4.00+
PlayResX: 960
PlayResY: 456

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bubble, Meiryo, 25, &H00101010, &H00101010, &H00FFFFFF, &H99000000, 1, 0, 2, 20, 20, 28, 1
Style: Title, Meiryo, 38, &H00FFFFFF, &H00FFFFFF, &H00000000, &H99000000, 1, 0, 5, 20, 20, 20, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.20,Title,,0,0,0,,森のスープ大作戦
Dialogue: 0,0:00:02.00,0:00:04.20,Bubble,,0,0,22,,トマト：赤い実を落としちゃった！
Dialogue: 0,0:00:04.20,0:00:06.30,Bubble,,0,0,22,,人参：一緒に探そう！
Dialogue: 0,0:00:06.30,0:00:08.50,Bubble,,0,0,22,,トマト：あっちに鍋があるよ！
Dialogue: 0,0:00:08.50,0:00:10.60,Bubble,,0,0,22,,人参：森のみんなのスープを作ろう！
Dialogue: 0,0:00:10.60,0:00:12.00,Title,,0,0,0,,いただきます！\NEND CREDITS
'@ | Set-Content -LiteralPath $ass -Encoding utf8

    $music = Join-Path $PSScriptRoot 'tomato_pop_original.wav'
    if (-not (Test-Path $music)) { throw "Music file not found: $music" }
    $assFilter = $ass.Replace('\', '/').Replace(':', '\:')
    $filter = "[1:v]colorkey=0xFF00D9:0.18:0.08,scale=360:-1,format=yuva420p[carrot];[0:v][carrot]overlay=x='430+80*sin(PI*t/2)':y='155-18*max(0,sin(PI*(t-4)/1.4))':enable='gte(t,3.5)'[scene];[scene]subtitles='$assFilter'[v]"
    & ffmpeg -y -loop 1 -i "$PSScriptRoot\out_tomato_ranger_forest_toon.png" -loop 1 -i "$PSScriptRoot\carrot_friend_key.png" -i $music -filter_complex $filter -map "[v]" -map 2:a:0 -t 12 -r 12 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart $outPath
    if ($LASTEXITCODE -ne 0) { throw 'Story video creation failed' }
    Write-Host "OK   $outPath"
}
finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
