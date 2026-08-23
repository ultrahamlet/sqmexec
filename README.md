# sqmexec

**sqm (メタボール・レイトレーサー) を動かすための配布パッケージ。**
実行バイナリ・ブラウザエディタ・手順・診断が入っていて、
**クローンすればソースもコンパイラも無しにレンダーできる。**

これは sqm の配布モデルそのもの — レンダラーのソースは公開せず、
**バイナリと `shader.core` だけ配れば、受け取った側はレンダーでき、
`.lisp` を書いて独自シェーダーも作れる**。

## 実行するだけなら (ソース不要)

```powershell
git clone https://github.com/ultrahamlet/sqmexec.git
cd sqmexec
.\doctor.ps1                              # 診断 (同梱バイナリで実地テストまで通る)
.\render.ps1 .\scenes\smoke.ssq out.png   # レンダー
.\serve.ps1                               # SDF/blob エディタ → http://localhost:8642
```

mac/Linux は同名の `.sh`。**Windows は MSYS2 もコンパイラも不要** —
同梱の `sqm.exe` は静的リンクで Windows 標準の UCRT だけで動く
(MSYS2 を含まない最小 PATH で実測確認済み)。Python は
sdfmodeler を使うときだけ要る。

## 中身

| パス | 中身 |
|---|---|
| `bin/<platform>/` | `sqm.exe` + `shader.core` (実行に要るのはこの2つだけ) |
| `bin/VERSION.json` | どのコミットから焼いたバイナリかの記録 |
| `app/sdfmodeler/` | ブラウザの階層 SDF/blob エディタ一式 (html/js/wasm/serve.py) |
| `scenes/smoke.ssq` | 自己診断用の最小シーン |
| `CLAUDE.md` | **引継ぎ文書 (本体)**。落とし穴の対応表つき |
| `doctor` / `build` / `render` / `serve` / `publish` | 各種スクリプト (.ps1 / .sh) |

**ソースコードは入っていない** (レンダラー本体は
[sqm](https://github.com/ultrahamlet/sqm)、シェーダーは
[dr_sbcl](https://github.com/ultrahamlet/dr_sbcl))。

## ソースからビルドしたい場合

sqmexec を sqm / dr_sbcl と同じ階層に置いて `.\build.ps1`。
ビルド済みの `sqm/dist/sqm.exe` があればそちらが同梱バイナリより優先される。
配布物の更新は `.\publish.ps1` (由来を `bin/VERSION.json` に記録)。

## Claude Code で使う

このリポジトリを開いて「**sqm を実行したい**」と言えば `CLAUDE.md` が
自動で読まれ、診断からセットアップまで進む。

## なぜラッパを通すのか

素の `sqm` を直接叩くと、**`SQM_SHADER_CORE` 未設定のときにエラーを出さずに
材質だけ別物になる** (既定パスが macOS 固定でハードコードされているため)。
ラッパは必要な環境変数を毎回組み立て、レンダー後に
`[DR] shader bridge ready` が出たかまで検査する。詳細は `CLAUDE.md`。
