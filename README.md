# sqmexec

**sqm (メタボール・レイトレーサー) の実行環境を、マシン間で共有するためのリポジトリ。**
レンダラー本体は含まない — 「クローンして数コマンドで動く状態にする」ための
診断・ビルド・実行ラッパと、罠の対応表だけが入っている。

Mac と Windows の両方で同じ手順が通るようにしてある。

## クイックスタート

```bash
# 1. ワークスペースを作って 3 つのリポジトリを並べる
mkdir sqm_ws && cd sqm_ws
git clone https://github.com/ultrahamlet/sqm.git
git clone https://github.com/ultrahamlet/dr_sbcl.git
git clone https://github.com/ultrahamlet/sqmexec.git
git clone https://github.com/ultrahamlet/vclay.git   # 任意 (blob エディタ用)

# 2. 診断 → 足りないものが対処コマンド付きで出る
cd sqmexec
./doctor.sh          # Windows: .\doctor.ps1

# 3. ビルド (sqm → shader.core の順に自動で回る)
./build.sh           # Windows: .\build.ps1

# 4. レンダー
./render.sh ../sqm/scenes/bear_blob.ssq /tmp/out.png
```

配置を変えたい場合は `sqmexec.config.example.json` を
`sqmexec.config.json` にコピーしてパスを書く (このファイルは gitignore 済み =
マシン固有の設定を共有しない)。

## Claude Code で使う

このリポジトリを開いて「**sqm を実行したい**」と言えば、`CLAUDE.md` が
自動で読まれて診断からセットアップまで進む。**`CLAUDE.md` が引継ぎ文書の本体**で、
「エラーにならずに間違った結果が出る」落とし穴の対応表もそこにある。

## 中身

| ファイル | 役割 |
|---|---|
| `CLAUDE.md` | 引継ぎ文書 (エージェント向け)。**落とし穴の対応表はここ** |
| `doctor.ps1` / `.sh` | 環境診断。実際に 1 枚レンダーして DR シェーダーの有効性まで確認 |
| `build.ps1` / `.sh` | sqm + shader.core のビルド (依存順を強制) |
| `render.ps1` / `.sh` | 環境変数を組み立ててレンダーする自己完結ラッパ |
| `serve.ps1` / `.sh` | sdfmodeler (ブラウザの SDF/blob エディタ) 起動 |
| `docs/environment.md` | 各マシンの実測環境と、依存の導入手順 |

## なぜラッパを通すのか

素の `sqm` を直接叩くと、**`SQM_SHADER_CORE` 未設定のときにエラーを出さずに
材質だけ別物になる** (既定パスが macOS 固定でハードコードされているため)。
ラッパはこれを含む 4 つの環境変数を毎回組み立て、レンダー後に
`[DR] shader bridge ready` が出たかまで検査する。詳細は `CLAUDE.md`。
