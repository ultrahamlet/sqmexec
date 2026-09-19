param(
    [string]$Out = '.\tomato_carrot_story_v2.mp4'
)

$ErrorActionPreference = 'Stop'
$outPath = [IO.Path]::GetFullPath($Out)
$work = Join-Path $env:TEMP ("sqm-story-v2-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    $tomatoSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'scenes\tomato_ranger.ssq'))
    $surpriseSource = $tomatoSource.Replace('(radii 0.18 0.17 0.07)', '(radii 0.22 0.22 0.07)').Replace('(radii 0.28 0.14 0.08)', '(radii 0.34 0.22 0.08)')
    $surpriseScene = Join-Path $work 'tomato_surprise.ssq'
    [IO.File]::WriteAllText($surpriseScene, $surpriseSource, [Text.UTF8Encoding]::new($false))
    & "$PSScriptRoot\render.ps1" $surpriseScene (Join-Path $work 'tomato_surprise.png') -Width 800 -Height 760 -AA 1 -Shadow 1 -Depth 2
    $bodyStart = $tomatoSource.IndexOf('; round tomato body')
    $tomatoKeySource = "(scene`n  (background 1.0 0.0 0.85)`n  (camera (from 0.35 1.35 -4.6) (at 0 0.95 0) (up 0 1 0) (fov 38))`n  (light (pos -3.4 4.5 -4.0)(intensity 1.70)(color 1.0 0.95 0.88)(radius 0.9))`n" + $tomatoSource.Substring($bodyStart)
    $tomatoKeyScene = Join-Path $work 'tomato_key.ssq'
    [IO.File]::WriteAllText($tomatoKeyScene, $tomatoKeySource, [Text.UTF8Encoding]::new($false))
    & "$PSScriptRoot\render.ps1" $tomatoKeyScene (Join-Path $work 'tomato_key.png') -Width 480 -Height 456 -AA 1 -Shadow 1 -Depth 1
    & "$PSScriptRoot\render.ps1" (Join-Path $PSScriptRoot 'scenes\carrot_friend.ssq') (Join-Path $PSScriptRoot 'carrot_friend_key.png') -Width 480 -Height 456 -AA 1 -Shadow 1 -Depth 1
    & "$PSScriptRoot\render.ps1" (Join-Path $PSScriptRoot 'scenes\soup_kitchen.ssq') (Join-Path $work 'kitchen.png') -Width 480 -Height 456 -AA 1 -Shadow 1 -Depth 1

    $ass = Join-Path $work 'story.ass'
    @'
[Script Info]
ScriptType: v4.00+
PlayResX: 480
PlayResY: 456
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Bubble, Meiryo, 23, &H00101010, &H00101010, &H00FFFFFF, &H99000000, 1, 0, 2, 14, 14, 22, 1
Style: Title, Meiryo, 32, &H00FFFFFF, &H00FFFFFF, &H00000000, &H99000000, 1, 0, 5, 14, 14, 16, 1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.60,Title,,0,0,0,,森のスープ大作戦
Dialogue: 0,0:00:01.60,0:00:03.50,Bubble,,0,0,18,,トマト：赤い実を落としちゃった…
Dialogue: 0,0:00:03.50,0:00:05.30,Bubble,,0,0,18,,人参：いっしょに探そう！
Dialogue: 0,0:00:05.30,0:00:07.20,Bubble,,0,0,18,,トマト：あっ！鍋を発見！
Dialogue: 0,0:00:07.20,0:00:09.20,Bubble,,0,0,18,,人参：スープにして元気を出そう！
Dialogue: 0,0:00:09.20,0:00:10.70,Bubble,,0,0,18,,トマト：せーの…
Dialogue: 0,0:00:10.70,0:00:12.00,Title,,0,0,0,,いただきます！\NEND CREDITS
'@ | Set-Content -LiteralPath $ass -Encoding utf8
    $assFilter = $ass.Replace('\', '/').Replace(':', '\:')
    $filter = "[0:v]scale=480:456,zoompan=z='min(zoom+0.0015,1.04)':d=144:s=480x456:fps=12,setpts=PTS-STARTPTS[forest];[1:v]colorkey=0xFF00D9:0.20:0.08,scale=190:-1,format=yuva420p,setpts=PTS-STARTPTS[carrot];[2:v]scale=480:456,format=rgb24,setpts=PTS-STARTPTS[kit];[forest][carrot]overlay=x='300+35*sin(PI*t)':y='155-16*max(0,sin(PI*(t-3.5)/0.9))':enable='between(t,3.2,9.2)':eof_action=repeat[act];[act][kit]overlay=0:0:enable='gte(t,9.2)':eof_action=repeat[meal];[meal][carrot]overlay=x=285:y=145:enable='gte(t,9.2)':eof_action=repeat[final];[final]drawbox=x=0:y=0:w=480:h=456:color=0xFFB060@0.12:t=fill:enable='gte(t,9.2)',subtitles='$assFilter'[v]"
    & ffmpeg -y -loop 1 -i (Join-Path $PSScriptRoot 'out_tomato_ranger_forest_toon.png') -i (Join-Path $PSScriptRoot 'carrot_friend_key.png') -loop 1 -i (Join-Path $work 'kitchen.png') -i (Join-Path $PSScriptRoot 'tomato_pop_original.wav') -filter_complex $filter -map "[v]" -map 3:a:0 -t 12 -r 12 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart $outPath
    if ($LASTEXITCODE -ne 0) { throw 'Story v2 creation failed' }
    Write-Host "OK   $outPath"
}
finally {
    if (Test-Path $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
