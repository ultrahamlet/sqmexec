# sqmexec — sqm レンダラー実行環境

**sqm** は 1999 年由来のメタボール・レイトレーサーです。CPU + OpenMP で動き、
大量のメタボール (blob) を高速に描くこと、そして材質を RenderMan 風の
シェーダー言語で設計できることを特徴にしています。

このリポジトリは **sqm を動かすための実行環境**です。レンダラー本体のソースは
含みません。入っているのは実行スクリプト・ブラウザエディタ・サンプル・手順で、
**実行バイナリは [Releases](https://github.com/ultrahamlet/sqmexec/releases)** に置いています。

- `sqm.exe` — レンダラー本体 (Releases)
- `shader.core` — シェーダーライブラリ (材質・ライト・変位・ボリューム・後処理。Releases)
- `app/sdfmodeler/` — ブラウザの階層 SDF/blob エディタ一式
- `doctor` / `render` / `serve` / `build` — 環境を組み立てるラッパ (.ps1 / .sh)
- `scenes/` — 動作確認用のサンプルシーン

`shader.core` は `sqm.exe` が起動時に読み込む動的ライブラリです。
**`shader.core` を差し替えるだけで材質のバージョンアップを受け取れます** —
レンダラー本体を入れ替える必要はありません。

---

## 導入 (Windows)

```powershell
git clone https://github.com/ultrahamlet/sqmexec.git
cd sqmexec
```

[Releases](https://github.com/ultrahamlet/sqmexec/releases) から `sqm.exe` と
`shader.core` をダウンロードし、`bin\windows-x64\` に置きます。あとは:

```powershell
.\doctor.ps1                              # 診断 (同梱シーンで実地テストまで通す)
.\render.ps1 .\scenes\bear_blob.ssq out.png
.\serve.ps1                               # SDF/blob エディタ → http://localhost:8642
```

mac/Linux は同名の `.sh`。**Windows は MSYS2 もコンパイラも不要** —
`sqm.exe` は静的リンクで Windows 標準の UCRT だけで動きます
(MSYS2 を含まない最小 PATH で実測確認済み)。Python は sdfmodeler を使うときだけ要ります。

### ラッパを通さず直接叩く場合

**環境変数 `SQM_SHADER_CORE` に `shader.core` の場所を指定してください。**

```powershell
$env:SQM_SHADER_CORE = "C:\path\to\shader.core"
```

> ⚠ **`SQM_SHADER_CORE` の設定は必須です。** 未設定だとビルド時に埋め込まれた
> 既定パス (macOS 固定) を見にいくため、シェーダーが読み込めません。読み込めないと
> `(shader ..)` を指定した材質が黙ってエンジン内蔵の単純な材質に落ち、
> **エラーは出ないまま絵だけが変わります**。
>
> `render.ps1` / `render.sh` はこれを毎回自動で組み立て、レンダー後に
> `[DR] shader bridge ready` が出たかまで検査します。ラッパを勧める理由がこれです。

## 最初の1枚

```powershell
.\render.ps1 .\scenes\bear_blob.ssq out.png -x 800 -y 600 -A 2 -s 2 -D 2
```

素の実行なら `sqm.exe -i scenes\bear_blob.ssq -o out.png -x 800 -y 600 -A 2 -s 2 -D 2`。
`-i` 入力シーン / `-o` 出力 PNG / `-x` `-y` 解像度。

## よく使うオプション

| | 意味 |
|---|---|
| `-A n` | アンチエイリアス (1 = 無し。仕上げは 3〜4) |
| `-s n` | 影。`1` = ハードシャドウ / `n≥2` = ソフトシャドウ (光源の `radius` で面光源化) |
| `-D n` | 反射・屈折の再帰深度。**既定 0 では透明・鏡面が真っ黒になります** (ガラスは 2〜3) |
| `-T op[:露出[:ガンマ]]` | トーンマッピング。`aces` / `aces2` / `reinhard` / `filmic`。発光や白飛びを抑える |
| `-R` | フレネル反射 (掠め角ほど強く映り込む) |
| `-O n` | 擬似 GI (半球 AO) |
| `-g n` | 1バウンス拡散間接光 (色移り)。`-O` より重いが自然 |
| `-P 絞り[:距離]` | 被写界深度 |
| `-B しきい値[:強さ[:半径]]` | ブルーム |
| `-G 距離` | 深度フォグ |
| `-Q spp[:バウンス[:seed]]` | パストレーシング。`-T aces:1.7:2.2` と併用推奨 |
| `-K フォトン数[:半径]` | コースティクス (ガラス越しの集光) |

パストレーシングは他のオプション (`-A` / `-s`) を使いません。
`-Q 128:20:1` のように spp・バウンス・乱数種を与えます。同じ条件・同じ種なら
結果は再現します。

## サンプルシーン

| ファイル | 内容 |
|---|---|
| `bear_blob.ssq` | ネイティブ blob 151 個で作ったクマ。融合する等値面 |
| `akame_frog.ssq` | SDF プリミティブと CSG で組んだカエル |
| `superquad_zoo.ssq` | 超楕円体の標本箱 (指数を振ると球↔箱↔八面体↔星) |
| `ceramictiles_test.ssq` | 浴室タイル (シェーダーによる手続き的な材質) |
| `brushedmetal_test.ssq` | ヘアライン金属 (Ward 異方性反射) |
| `caustic_test.ssq` | コースティクス。`-K` を付けて焼きます |
| `smoke.ssq` | 自己診断用の最小シーン (`doctor` が使う) |

```powershell
.\render.ps1 .\scenes\caustic_test.ssq caustic.png -x 800 -y 600 -A 2 -s 2 -D 3 -K 2000000 -T aces:1.2
```

## sdfmodeler — ブラウザの SDF/blob エディタ

```powershell
.\serve.ps1     # → http://localhost:8642
```

階層的な SDF (符号付き距離場) と blob を組み合わせて形を作り、その場で
`.ssq` に書き出してレンダーまで通せます。WebGL2 のレイマーチングで
プレビューし、確定した形は wasm でメッシュ化します。Python が要ります。

## 中身

| パス | 中身 |
|---|---|
| `bin/<platform>/` | `sqm.exe` + `shader.core` を置く場所 (中身は Releases から) |
| `bin/VERSION.json` | どのコミットから焼いたバイナリかの記録 |
| `app/sdfmodeler/` | ブラウザの階層 SDF/blob エディタ一式 (html/js/wasm/serve.py) |
| `scenes/` | サンプルシーンと自己診断用の最小シーン |
| `assets/` | サンプルが参照する地面・空のメッシュ |
| `CLAUDE.md` | **引継ぎ文書 (本体)**。落とし穴の対応表つき |
| `doctor` / `build` / `render` / `serve` / `publish` | 各種スクリプト (.ps1 / .sh) |

**レンダラーとシェーダーのソースは入っていません** (本体は
[sqm](https://github.com/ultrahamlet/sqm)、シェーダーは
[dr_sbcl](https://github.com/ultrahamlet/dr_sbcl))。

## ソースからビルドしたい場合

sqmexec を sqm / dr_sbcl と同じ階層に置いて `.\build.ps1`。
ビルド済みの `sqm/dist/sqm.exe` があればそちらが優先されます。
配布物の更新は `.\publish.ps1` (由来を `bin/VERSION.json` に記録)。

## Claude Code で使う

このリポジトリを開いて「**sqm を実行したい**」と言えば `CLAUDE.md` が
読まれ、診断からセットアップまで進みます。

## 出力される PNG について

sqm は PNG に**レンダリング時のコマンドライン・環境変数・シーン本文**を
テキストチャンクとして埋め込みます (画素データは変わりません)。
後から「この絵はどう焼いたか」を辿れます。タイムスタンプは入れないので、
同じ条件で焼き直せば同じファイルになります。

埋め込みを止めたい場合は `SQM_PNG_META=0` を設定してください。

## ライセンス

**非商用に限り利用できます。クレジットに `DeepAlaya.ai` を入れてください。**

本ソフトウェアで生成した画像を公開・展示するとき、および本ソフトウェアを
再配布するときが対象です。記載例:

```
Rendered with sqm — DeepAlaya.ai
```

商業利用には個別の許諾が必要です。全文は [LICENSE](LICENSE) を参照してください。

Copyright (c) DeepAlaya.ai
