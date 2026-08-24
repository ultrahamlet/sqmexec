# sqmexec — sqm の実行環境セットアップ (エージェント向け引継ぎ文書)

**このリポジトリはレンダラー本体を含まない。** sqm / dr_sbcl / vclay を
**動く状態に組み立てて実行する**ための手順・ラッパ・診断だけを持つ。

## このリポジトリの境界 — 入れるもの / 入れないもの

sqm の配布モデル (**ソースを公開せず、バイナリ + shader.core だけ配れば
受け取った側がレンダーでき、`.lisp` を書いて独自シェーダーも作れる**) を
そのまま形にしたもの。したがって:

**入れる (配布物)**
- `bin/<platform>/sqm.exe` + `shader.core` — 実行に必要な2つ
- `app/sdfmodeler/` — ブラウザエディタ一式 (html/js/wasm/serve.py)
- `scenes/smoke.ssq` — 自己診断用の最小シーン
- 手順・ラッパ・診断・文書

**入れない**
- **レンダラーのソース (.c/.cpp/.h) とシェーダーのソース (.lisp)** —
  本体は sqm / dr_sbcl リポジトリの持ち物。`.gitignore` が拒否する
- 巨大な生成データ (`*.f32`、`examples/grids/`)

⚠ **`bin/` と `app/` は snapshot であって原本ではない。** 編集は必ず
sqm / dr_sbcl 側で行い、`.\publish.ps1` でここへ流す。逆流させると
「どちらが本物か」が分からなくなる。由来 (どのコミットから焼いたか) は
`bin/VERSION.json` に記録される。

ユーザーが「**sqm を実行したい**」「レンダーしたい」「sdfmodeler を開きたい」と
言ったら、**まず下の「最初にやること」を実行する**。推測でパスを組み立てない。

---

## 最初にやること

```powershell
.\doctor.ps1
```
```bash
./doctor.sh
```

環境を診断して「何が揃っていて何が足りないか」を出す。足りないものがあれば
そこに対処コマンドが書いてあるので、それに従う。**診断を飛ばして
いきなりビルドやレンダーをしない** — このプロジェクトは失敗の出方が
原因を指さない (下記「嘘をつく失敗」) ので、切り分けを先にやるのが最短。

---

## ⚠ 最重要 — 3つの落とし穴

この3つを外すと「**エラーにならずに間違った結果が出る**」。時間を溶かすのは
いつもここなので、レンダー前に必ず確認する。

### ① SQM_SHADER_CORE を指定しないと材質が黙って別物になる (Mac 以外)

`dist/main.cpp` の既定パスが **macOS 固定でハードコード**されている:

```c
#define DR_SHADER_CORE "/Users/user/Projects/dr_sbcl/lib/shader.core"
```

Windows/Linux ではこのパスが無いので dlopen が失敗するが、**エラー終了せず**
`ネイティブシェーディングで続行` と出して描いてしまう。`tintglass` / `velvet` /
タイル床など `.lisp` 定義の材質が全部ネイティブ材質に置き換わり、
Mac と絵が変わるのに**一見成功したように見える**。

→ 環境変数 `SQM_SHADER_CORE` を必ず渡す。**このリポジトリの `render.ps1` /
`render.sh` は自動で渡す**ので、素の `sqm.exe` を直接叩かずラッパを使う。

**成功の合図**: 起動時に stderr へ `[DR] shader bridge ready — N light(s)` が出る。
この行が無い、または「非対応」が出たら**絵を信用しない**。

### ② 実行ファイル名は `sqm` / `sqm.exe` から変えてはいけない

A/B 比較のつもりで `sqm_old.exe` などに改名すると **DR シェーダーが落ちるか
segfault する**。別バージョンを置きたいときは**別ディレクトリに同じ名前で**置く。

理由は実測で確定している: `shader.core` のインポート表に
**`DLL Name: sqm.exe`** が入っている (shader.core はホスト実行ファイルから
`stf` / `sqm_dr_sgv_get` 等を import する構造)。exe を改名するとこの解決が
外れる。`objdump -p shader.core` で確認できる。

### ③ 環境変数はコール間で保持されない (エージェント向け)

Claude Code のシェルツールは**呼び出しごとに新しいシェル**で、`export` や
`$env:X = ...` は次の呼び出しに残らない。`env.ps1` を dot-source しても
その1回きり。

→ **必ず `render.ps1` / `build.ps1` / `serve.ps1` を使う。** これらは
内部で環境を組み立てる自己完結ラッパなので、単発呼び出しで正しく動く。

---

## やりたいこと別の入口

| やりたいこと | コマンド |
|---|---|
| 環境診断 | `.\doctor.ps1` |
| ビルド (sqm + shader.core) | `.\build.ps1` |
| sqm だけビルド | `.\build.ps1 -Target sqm` |
| shader.core だけ再リンク | `.\build.ps1 -Target core` |
| レンダー | `.\render.ps1 <scene.ssq> <out.png>` |
| 高品質レンダー | `.\render.ps1 <scene.ssq> <out.png> -Quality hq` |
| sdfmodeler (ブラウザ SDF エディタ) | `.\serve.ps1` → http://localhost:8642 |
| 素の sqm に任意引数 | `.\render.ps1 <scene> <out> -Raw "-Q 128:20:1 -T aces:1.7:2.2"` |

mac/Linux は同名の `.sh` (`./doctor.sh` など)。引数は同じ並び。

---

## 2つの使い方 — 実行するだけ / ソースからビルドする

### (A) 実行するだけ (配布先。ソース不要)

**sqmexec をクローンするだけで動く。** バイナリは `bin/windows-x64/` に同梱。
追加のダウンロードは要らない (Releases 方式は採らなかった — 公開の手間が
毎回かかるため。代わりに数 MB が履歴に積み上がるので、更新は publish.ps1
を通して必要なときだけにすること)。

sqm.exe は静的リンクで、**Windows 標準の UCRT だけで動く** —
MSYS2 もコンパイラも要らない (MSYS2 を含まない最小 PATH で実測確認済み)。
Python は sdfmodeler を使うときだけ必要。

```powershell
.\doctor.ps1                                   # 診断 + 実地テスト
.\render.ps1 .\scenes\smoke.ssq out.png        # レンダー
.\serve.ps1                                    # エディタ (同梱 app/sdfmodeler)
```

### (B) ソースからビルドする (開発機)

sqmexec を **sqm / dr_sbcl / vclay と同じ階層**に置く (自動検出する):

```
<workspace>/
  sqm/        github.com/ultrahamlet/sqm      レンダラー本体 (C++17)
  dr_sbcl/    github.com/ultrahamlet/dr_sbcl  シェーダー DSL → shader.core
  vclay/      github.com/ultrahamlet/vclay    1992年の先祖 + ssq_edit (blob エディタ)
  sqmexec/    ← このリポジトリ
```

sqm/dist にビルド済みの exe があれば**bin/ のバイナリより優先**される
(開発中は常に最新を見るため)。別の場所に置くなら `sqmexec.config.json`
(example をコピー) か環境変数 `SQM_WORKSPACE` で根を教える。
**vclay は sqm のビルドには不要** (リンクも include もしていない)。

ビルド用の依存 (doctor が全部チェックする):

| 用途 | Windows | mac |
|---|---|---|
| C++ コンパイラ | MSYS2 UCRT64 の GCC (`C:\msys64\ucrt64\bin`) | Apple clang + Homebrew libomp |
| shader.core | SBCL | SBCL |
| sdfmodeler | Python 3 + numpy + scikit-image | 同左 |
| blob エディタ (任意) | MSYS2 の freeglut | GLUT |

**Windows で `C:\msys64\ucrt64\bin` が PATH に無いと、ビルドが原因を指さない
エラーで死ぬ** (下記)。ラッパは自動で PATH に足す。

### 配布物を更新する (開発機で)

```powershell
.\build.ps1      # ソースからビルド
.\publish.ps1    # bin/ と app/ へ流し込み、VERSION.json に由来を記録
git add -A; git commit
```

---

## 嘘をつく失敗 (原因を指さないエラーの対応表)

| 症状 | 本当の原因 | 対処 |
|---|---|---|
| 絵は出るが材質が違う / `[DR] shader bridge ready` が出ない | SQM_SHADER_CORE 未設定 | `render.ps1` を使う |
| `Cannot create temporary file in C:\Windows\: Permission denied` | **権限ではない**。cc1.exe が ucrt64 の DLL を解決できない | PATH に `C:\msys64\ucrt64\bin` |
| shader ビルドで全シェーダーが `!! gcc failed (1)` (理由なし) | 同上 (gcc.exe 自体は起動するので「gcc はある」と誤判断しがち) | 同上。`cc1.exe --version` を直接叩くと真因が出る |
| 接地部に白い三日月 | 影の光漏れ (Peter-Panning)。既定 `SQM_SHADOW_SEPS=0.05` は漏れる側 | ラッパが `0.002` を渡す |
| メッシュ経路が 500 / `field2obj の import 失敗` | numpy / scikit-image 未導入 | `pip install numpy scikit-image` |
| シーンの mesh/grid だけ描かれず真っ黒にならない | 絶対パス焼き込み or 相対パス。Mac⇄Win で必ず片方が開けない | シーン側で `$SQM_ROOT/...` を使う。ラッパは `SQM_ROOT` を渡す |
| exe を改名したら DR が落ちる/segfault | ②の制約 | 名前は `sqm.exe` のまま・別ディレクトリに置く |

---

## レンダーの基本形 (ラッパが組み立てる内容)

```
sqm -i <scene.ssq> -o <out.png> -x 800 -y 600 -A 3 -s 2 -D 2
```
`-A` アンチエイリアス / `-s` 影 (2以上でソフト) / `-D` 再帰深度 (透過・反射に必須)。
細かい指定は `-Raw` でそのまま渡せる。**オプションの意味と設計思想は
`sqm/CLAUDE.md`** (本体リポジトリ) に全部書いてある — 絵作りの相談を
されたらそちらを読む。このリポジトリは「動かすまで」が守備範囲。

---

## このリポジトリのスクリプトを直すとき (Windows PowerShell 5.1 の罠)

`.ps1` を編集したら必ず `.\doctor.ps1` を通してから commit する。5.1 特有の
罠を2つ踏んだので、同じ形を再発させないこと:

1. **`.ps1` は UTF-8 **BOM 付き** で保存する。** BOM 無しだと 5.1 が ANSI と
   誤読して日本語コメントが化け、**引用符が壊れて構文エラー**になる
   (`Missing closing ')'` が並ぶ)。書き換えたら:
   ```powershell
   $enc = New-Object System.Text.UTF8Encoding($true)
   foreach ($f in (Get-ChildItem -Recurse -Include *.ps1 -File)) {
     $t = [IO.File]::ReadAllText($f.FullName, [Text.UTF8Encoding]::new($false))
     [IO.File]::WriteAllText($f.FullName, $t, $enc) }
   ```
2. **native exe の stderr を `2>&1` でも `2> file` でも受けてはいけない。**
   5.1 は stderr の各行を ErrorRecord (NativeCommandError) に包むので、
   exe が 0 で正常終了しても `$ErrorActionPreference='Stop'` と組むと例外に
   なり「**sqm が失敗した**」ように見える (実際は成功していて画像も出ている)。
   → `lib/common.ps1` の **`Invoke-SqmExe`** を使う (Start-Process で
   子プロセスに直接ファイルへ書かせて PowerShell の stderr 処理を迂回する)。

## このリポジトリを更新するとき

環境まわりで新しい落とし穴を踏んだら、**`doctor` のチェック項目**か
上の「嘘をつく失敗」表に足す。ここは「同じ罠に二度はまらないための場所」なので、
再現手順より**症状 → 真因 → 対処**の形で書く。
