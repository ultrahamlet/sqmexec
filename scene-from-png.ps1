# scene-from-png.ps1 — sqm が PNG に埋めたシーンとレンダー条件を取り出す
#
#   .\scene-from-png.ps1 out.png                 → 埋め込みメタの一覧
#   .\scene-from-png.ps1 out.png scene.ssq       → シーン本文を .ssq へ書き出す
#
# sqm は出力 PNG の IEND 直前に iTXt を挿している (dist/png_meta.cpp):
#   sqm:cmdline / sqm:cwd / sqm:env / sqm:scene-path / sqm:scene (zlib 圧縮)
# → **レンダー結果の PNG さえあれば、.ssq を無くしても絵を再現できる。**
#   画像がシーンを持ち歩いているので、別マシンで描いた絵も手元で再レンダーできる。
#
# ⚠ 書式は app/sdfmodeler/js/pngmeta.js と同じものを読んでいる。
#   片方の書式を変えたら両方直すこと (モデラーは PNG のドロップで同じ復元をする)。
# ⚠ チャットや SNS を経由した画像は再エンコードで iTXt が落ちる。**原本を使う。**
param(
    [Parameter(Mandatory=$true, Position=0)] [string]$Png,
    [Parameter(Position=1)] [string]$Out = ''
)
. "$PSScriptRoot\lib\common.ps1"

if (-not (Test-Path $Png)) { throw "PNG が無い: $Png" }
$bytes = [IO.File]::ReadAllBytes((Resolve-Path $Png).Path)

$sig = @(0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A)
for ($i = 0; $i -lt 8; $i++) {
    if ($bytes.Length -lt 8 -or $bytes[$i] -ne $sig[$i]) { throw "PNG ではない: $Png" }
}

# ビッグエンディアンの 4 バイト長 (PNG は常に BE)
function Get-BE32($b, [int]$p) {
    return ([uint32]$b[$p] -shl 24) -bor ([uint32]$b[$p+1] -shl 16) -bor
           ([uint32]$b[$p+2] -shl 8)  -bor  [uint32]$b[$p+3]
}

# zlib ストリームを展開する。.NET Framework 4.x (PS 5.1) には ZLibStream が
# 無いので、2 バイトの zlib ヘッダを飛ばして raw deflate として食わせる。
# (末尾の adler32 は DeflateStream が無視する)
function Expand-Zlib([byte[]]$z) {
    $ms  = New-Object IO.MemoryStream(,$z[2..($z.Length-1)])
    $ds  = New-Object IO.Compression.DeflateStream($ms, [IO.Compression.CompressionMode]::Decompress)
    $out = New-Object IO.MemoryStream
    $ds.CopyTo($out); $ds.Dispose()
    return $out.ToArray()
}

# iTXt のレイアウト: keyword \0 compflag(1) compmethod(1) langtag \0 translated \0 text
function Read-ITXt([byte[]]$d) {
    $k = [Array]::IndexOf($d, [byte]0)
    if ($k -lt 0) { return $null }
    $key = [Text.Encoding]::ASCII.GetString($d, 0, $k)
    $compflag = $d[$k+1]
    $p = $k + 3
    for ($n = 0; $n -lt 2; $n++) {                    # langtag と translated を読み飛ばす
        $z = [Array]::IndexOf($d, [byte]0, $p)
        if ($z -lt 0) { return $null }
        $p = $z + 1
    }
    $raw = $d[$p..($d.Length-1)]
    if ($compflag -eq 1) { $raw = Expand-Zlib $raw }
    return @{ Key = $key; Text = [Text.Encoding]::UTF8.GetString($raw) }
}

$meta = [ordered]@{}
$p = 8
while ($p + 8 -le $bytes.Length) {
    $len  = [int](Get-BE32 $bytes $p)
    $type = [Text.Encoding]::ASCII.GetString($bytes, $p+4, 4)
    if ($type -eq 'iTXt' -and $len -gt 0) {
        $r = Read-ITXt $bytes[($p+8)..($p+7+$len)]
        if ($r) { $meta[$r.Key] = $r.Text }
    }
    $p += 12 + $len
    if ($type -eq 'IEND') { break }
}

if ($meta.Count -eq 0) {
    Write-Bad "sqm のメタデータが無い — sqm 出力の原本ではありません"
    Write-Host "     チャットや SNS を経由すると再エンコードで iTXt が落ちます"
    exit 1
}

if ($Out) {
    if (-not $meta.Contains('sqm:scene')) { throw "sqm:scene が無い (メタはあるがシーン本文が入っていない)" }
    $enc = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Out, ($meta['sqm:scene'] -replace "`r`n", "`n"), $enc)
    Write-Ok "$Out  ($($meta['sqm:scene'].Length) 文字)"
}

# シーン本文以外は必ず出す — 再現には環境変数と引数が要るため
foreach ($k in $meta.Keys) {
    if ($k -eq 'sqm:scene') { continue }
    Write-Host "--- $k" -ForegroundColor Cyan
    Write-Host $meta[$k]
}
if (-not $Out -and $meta.Contains('sqm:scene')) {
    Write-Host "--- sqm:scene ($($meta['sqm:scene'].Length) 文字)" -ForegroundColor Cyan
    Write-Host "    書き出すには: .\scene-from-png.ps1 $Png <out.ssq>"
}

# ⚠ sqm:env の SQM_* は render.ps1 が渡さないものがある (コースティクス等)。
#   再現するときは同じ呼び出しの中で $env: に入れてから render.ps1 を叩く。
if ($meta.Contains('sqm:env') -and $meta['sqm:env'] -match 'SQM_CAUSTIC') {
    Write-Warn2 "コースティクス系の環境変数がある — render.ps1 は渡さないので手で設定する"
    Write-Host '     例: $env:SQM_CAUSTIC_GAIN=''30''; .\render.ps1 <scene> <out> -Raw "-K ..."'
}
