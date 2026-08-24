# インストール — Claude Code で動かすまで

**3 ステップで、レンダリングとエディタの両方が動きます。**
コンパイラもレンダラーのソースも要りません (実行バイナリは同梱)。

| 要るもの | 何に使うか |
|---|---|
| git | クローン |
| [Claude Code](https://claude.com/claude-code) | 環境の組み立てと実行 (手順は `CLAUDE.md` に書いてある) |
| Python 3 | sdfmodeler (エディタ) を使うときだけ |
| Chrome | 同上 |

Windows は **MSYS2 もコンパイラも不要**です。同梱の `sqm.exe` は静的リンクで、
Windows 標準の UCRT だけで動きます (MSYS2 を含まない最小 PATH で実測確認済み)。

---

## 1. クローンする

```bash
git clone https://github.com/ultrahamlet/sqmexec.git
```

これだけです。バイナリ (`bin/windows-x64/sqm.exe` と `shader.core`) は
リポジトリに入っているので、追加のダウンロードはありません。

## 2. Claude Code で開いて、テストレンダリング

Claude Code を起動して **「新規」→ いまクローンした `sqmexec` フォルダを選択**。
入力欄にこう打ちます:

```
sqm でテストレンダリングして
```

`CLAUDE.md` が読まれ、診断 → 環境変数の組み立て → `scenes/smoke.ssq` の
レンダリングまで自動で進み、PNG が出ます。

> **確認してほしいこと** — ログに `[DR] shader bridge ready` が出ていること。
> これが出ないと `shader.core` が読み込まれておらず、**エラーを出さないまま
> 材質だけがエンジン内蔵の単純なものに差し替わります**。絵は出るのに質感が
> 違う、という気づきにくい壊れ方をするので、最初の 1 回は目視してください。

うまくいったら、サンプルシーンで遊べます:

```
scenes/bear_blob.ssq をレンダリングして
```

`scenes/` の中身は [README](README.md#サンプルシーン) の表を参照してください。

## 3. sdfeditor (エディタ) を起動する

同じ入力欄に:

```
sdfeditor を起動して、chrome は vulkan のオプションをつけて
```

ローカルサーバが `http://localhost:8642` で立ち、Chrome が次のフラグ付きで
開きます:

```
chrome --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist
```

### なぜ Vulkan を指定するのか

sdfmodeler は形を編集するたびに WebGL のシェーダーを組み立て直します。
Windows Chrome の既定 (ANGLE → HLSL → FXC / D3D11) では、この
コンパイルがシーンの複雑さに対して**急激に遅くなり**、複雑なシーンでは
数十秒フリーズすることがあります。Vulkan バックエンドは HLSL を経由せず
SPIR-V を吐くため、この経路を避けられます。

> **Chrome が既に起動していると、フラグは黙って無視されます。**
> 2 つ目の Chrome プロセスは URL を既存のプロセスに渡して終了するだけなので、
> 新しいフラグは効きません。**Chrome を全部閉じてから**起動してください。

### 本当に Vulkan になったかの確認

フラグを付けてもドライバ側の事情で D3D11 に戻ることがあります。**戻っても
警告は出ません。**DevTools のコンソール (F12) でこれを実行してください:

```javascript
(()=>{const g=document.createElement('canvas').getContext('webgl2');const e=g.getExtension('WEBGL_debug_renderer_info');return g.getParameter(e.UNMASKED_RENDERER_WEBGL)})()
```

- `..., Vulkan 1.x.xxx, ...` → 切り替わっています
- `..., Direct3D11 vs_5_0 ps_5_0, D3D11)` → **効いていません**。
  `chrome://gpu` の先頭に理由が出ています

---

## Claude Code を使わない場合

スクリプトを直接叩いても同じことができます。

```powershell
.\doctor.ps1                                   # 診断 + 実地テスト
.\render.ps1 .\scenes\smoke.ssq out.png        # レンダリング
.\serve.ps1                                    # エディタ → http://localhost:8642
```

mac / Linux は同名の `.sh` です。

素の `sqm.exe` を直に呼ぶときは、**環境変数 `SQM_SHADER_CORE` の設定が必須**です
(未設定だとビルド時に埋め込まれた macOS 固定の既定パスを見にいって失敗し、
上に書いた「黙って材質が変わる」状態になります)。ラッパはこれを毎回組み立て、
実行後に `[DR] shader bridge ready` が出たかまで検査します。

```powershell
$env:SQM_SHADER_CORE = "C:\path\to\shader.core"
```

## つまずいたら

| 症状 | 原因 | 対処 |
|---|---|---|
| 絵は出るが質感が違う / のっぺりする | `shader.core` が読めていない | ラッパ (`render.ps1`) 経由で実行する。ログの `[DR] shader bridge ready` を確認 |
| エディタがブラウザで開かない | Python が無い / 8642 番が塞がっている | `python --version` を確認。別プロセスが 8642 を使っていないか確認 |
| Chrome が D3D11 のまま | Chrome が既に起動していた | Chrome を全部閉じてから起動し直す |
| エディタの編集がカクつく・数秒固まる | シェーダーの再コンパイル | Vulkan バックエンドになっているか上の方法で確認 |
| `sqm.exe` が起動しない | ウイルス対策ソフトの隔離 | 隔離されていないか確認 (署名のない実行ファイルのため) |

## ライセンス

**非商用に限り利用できます。クレジットに `DeepAlaya.ai` を入れてください。**
詳細は [LICENSE](LICENSE) を参照してください。
