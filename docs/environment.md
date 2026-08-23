# 実行環境の実測値と導入手順

各マシンで**実際に動いている**構成。`doctor` が検出できなかったときの
突き合わせ用。

## Windows (実測 2026-08-23)

| 項目 | 値 |
|---|---|
| OS | Windows 11 Pro for Workstations 10.0.22631 |
| C++ | MSYS2 UCRT64 GCC **16.2.0** (`C:\msys64\ucrt64\bin\gcc.exe`) |
| SBCL | **2.6.7** (`C:\Users\<user>\sbcl\PFiles\Steel Bank Common Lisp\sbcl.exe`) |
| Python | **3.13.2** (`C:\Python313\python.exe`) + numpy 2.5.2 / scikit-image 0.26.0 |
| ワークスペース | `C:\Users\<user>\Documents\sqm_win\` |

### 導入

```powershell
# MSYS2 (https://www.msys2.org) を入れてから、MSYS2 のシェルで:
pacman -Syu
pacman -S mingw-w64-ucrt-x86_64-gcc make mingw-w64-ucrt-x86_64-freeglut

# SBCL は公式バイナリを展開。PATH に入れないなら sqmexec.config.json に絶対パスを書く
# Python
pip install numpy scikit-image
```

⚠ **`C:\msys64\ucrt64\bin` を PATH に入れること。** 入っていないと
`cc1.exe` が DLL を解決できず、**原因を指さないエラー**でビルドが死ぬ:

- Git Bash から `make` → `Cannot create temporary file in C:\Windows\: Permission denied`
  (TMP/TEMP を書き込み可能にしても直らない = 偽の手がかり)
- `build-all-win.lisp` → 全シェーダーが `!! gcc failed (1)` (理由は一切出ない)

`gcc.exe` 自体は起動するので「gcc はある」と誤判断しがち。
`cc1.exe --version` を直接叩くと真因 (`cannot open shared object file`) が出る。
`doctor.ps1` はこの cc1 直叩きを検査に入れてある。

## mac (Apple Silicon)

| 項目 | 値 |
|---|---|
| C++ | Apple clang |
| OpenMP | Homebrew libomp (`/opt/homebrew/opt/libomp`) |
| SBCL | Homebrew |
| Python | 3.x + numpy / scikit-image |

```bash
xcode-select --install
brew install libomp sbcl
pip3 install numpy scikit-image
```

## GPU オフロード (Windows・任意)

CUDA 経路は **MSVC でビルドする別 DLL (C ABI)** に隔離されている。
`dllexport` が必須で、ビルド用 `.bat` は **ASCII のみ** (日本語コメントを
入れると cmd の codepage で壊れる)。sqm 本体のビルドには不要。

## 環境変数の一覧 (ラッパが設定するもの)

| 変数 | 値 | 無いとどうなるか |
|---|---|---|
| `SQM_SHADER_CORE` | `<ws>/dr_sbcl/lib/shader.core` | **エラーを出さずに** .lisp 材質が全部ネイティブ材質に化ける |
| `SQM_ROOT` | `<ws>/sqm` | シーン内の `$SQM_ROOT/...` が解決できず、mesh/grid だけ黙って落ちる |
| `SQM_SHADOW_SEPS` | `0.002` | 既定 0.05 は接地部に白い三日月 (影の光漏れ) が出る |
| `PATH` | 先頭に `ucrt64\bin` | ビルドが偽の手がかりを出して死ぬ (上記) |

## 手で叩きたいとき (ラッパを使わない場合)

```powershell
$env:SQM_SHADER_CORE = 'C:/Users/<user>/Documents/sqm_win/dr_sbcl/lib/shader.core'
$env:SQM_ROOT        = 'C:\Users\<user>\Documents\sqm_win\sqm'
$env:SQM_SHADOW_SEPS = '0.002'
$env:PATH            = 'C:\msys64\ucrt64\bin;' + $env:PATH
& .\sqm\dist\sqm.exe -i scenes/x.ssq -o out.png -x 800 -y 600 -A 3 -s 2 -D 2
```

**成功の合図は `[DR] shader bridge ready — N light(s)`。** この行が出ない絵は
材質が本物ではないので信用しない。
