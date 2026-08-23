#!/usr/bin/env python3
"""sdfmodeler 配信サーバ — http.server に Cache-Control: no-store を足しただけ。

素の `python3 -m http.server` は Cache-Control を送らないため、ブラウザが
JS モジュールをヒューリスティックキャッシュして「コードを更新したのに
リロードで反映されない」事故が起きる (実際に何度も踏んだ)。
no-store なら常に最新が読まれる (ローカル配信なので速度影響なし)。

使い方:  python3 serve.py [port] [dir]   (既定 8642, カレントディレクトリ)
"""
import functools
import json
import os
import re
import subprocess
import sys
import tempfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs


class NoStoreHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _examples_dir(self):
        return os.path.join(self.directory, "examples")

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # examples/ の .ssq 一覧 (ユーザー保存分を含む) を JSON で返す
        if urlparse(self.path).path == "/__examples__":
            try:
                files = sorted(f for f in os.listdir(self._examples_dir())
                               if f.endswith(".ssq"))
            except OSError:
                files = []
            return self._send_json(200, files)
        return super().do_GET()

    def _build_sqm_args(self, p):
        """レンダ設定タブの params(dict) から sqm 引数リストを組み立てる。
        すべてホワイトリスト+型チェック。返り: (args_list, env_extra_dict)。
        任意文字列を shell に渡さないため、数値は float/int 変換・enum は限定候補のみ。"""
        def num(key, dflt, lo, hi):
            try: v = float(p.get(key, dflt))
            except (ValueError, TypeError): v = dflt
            if v != v: v = dflt   # NaN
            return max(lo, min(hi, v))
        def inum(key, dflt, lo, hi):
            return str(int(num(key, dflt, lo, hi)))
        def fnum(v):
            return ("%g" % v)
        a = []
        a += ["-x", inum("width", 800, 16, 4096), "-y", inum("height", 600, 16, 4096)]
        a += ["-A", inum("aa", 2, 1, 8)]
        sh = int(num("shadow", 1, 0, 64))
        if sh > 0: a += ["-s", str(sh)]
        gi = int(num("gi", 0, 0, 256))
        if gi > 0: a += ["-O", str(gi)]
        cgi = int(num("colorGi", 0, 0, 256))
        if cgi > 0: a += ["-g", str(cgi)]
        dep = int(num("depth", 2, 0, 12))
        a += ["-D", str(dep)]
        tm = str(p.get("tonemap", "")).lower()
        if tm in ("reinhard", "reinhard2", "aces", "filmic"):
            expo = fnum(num("exposure", 1.0, 0.01, 100))
            gam = fnum(num("gamma", 1.0, 0.1, 4))
            a += ["-T", "%s:%s:%s" % (tm, expo, gam)]
        if p.get("fresnel"): a += ["-R"]
        disp = p.get("dispersion")
        if disp not in (None, "", 0, "0"):
            a += ["-c", fnum(num("dispersion", 0.03, 0, 1))]
        if p.get("dofOn"):
            a += ["-P", "%s:%s" % (fnum(num("dofAperture", 0.1, 0, 5)), fnum(num("dofFocus", 0, 0, 1000)))]
        if p.get("bloomOn"):
            a += ["-B", "%s:%s:%s" % (fnum(num("bloomThresh", 1.0, 0, 100)),
                                      fnum(num("bloomIntensity", 0.6, 0, 10)),
                                      fnum(num("bloomRadius", 16, 1, 128)))]
        if p.get("lensOn"):
            a += ["-L", "%s:%s" % (fnum(num("lensCa", 2.0, 0, 20)), fnum(num("lensVignette", 0.4, 0, 1)))]
        if p.get("fogOn"):
            a += ["-G", fnum(num("fogDist", 20, 0.1, 1000))]
        env = {}
        seps = p.get("shadowSeps")
        if seps not in (None, ""):
            env["SQM_SHADOW_SEPS"] = fnum(num("shadowSeps", 0.006, 0.0, 1.0))
        return a, env

    def do_POST(self):
        # 現在のモデルを examples/<name>.ssq に保存
        parsed = urlparse(self.path)
        if parsed.path == "/__save__":
            qs = parse_qs(parsed.query)
            raw = (qs.get("name", [""])[0]) or ""
            name = re.sub(r"[^A-Za-z0-9_\-]", "_", os.path.basename(raw)).strip("_")
            if not name:
                return self._send_json(400, {"ok": False, "error": "invalid name"})
            if not name.endswith(".ssq"):
                name += ".ssq"
            length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(length) if length else b""
            try:
                os.makedirs(self._examples_dir(), exist_ok=True)
                with open(os.path.join(self._examples_dir(), name), "wb") as f:
                    f.write(data)
            except OSError as e:
                return self._send_json(500, {"ok": False, "error": str(e)})
            return self._send_json(200, {"ok": True, "name": name})
        # 現在のモデルを sqm でテストレンダリング → PNG を返す
        #   (A) 簡易: POST /__render__?w=640&h=420&q=draft|hq  (body = .ssq テキスト)  ← 🎬ボタン
        #   (B) 詳細: POST /__render__  (Content-Type: application/json,
        #        body = {"ssq": "...", "params": {...}})                           ← レンダ設定タブ
        #   sqm バイナリは SQM_BIN 環境変数 → 配信 dir の ../dist/sqm の順で探す。
        #   引数はホワイトリストから型チェックして組み立てる (任意文字列を shell に渡さない)。
        #   ローカル専用ツールの前提 (任意シーンの subprocess 実行なので公開網には出さないこと)
        if parsed.path == "/__render__":
            sqm = os.environ.get("SQM_BIN") or os.path.abspath(
                os.path.join(self.directory, "..", "dist", "sqm"))
            if not os.path.isfile(sqm) and os.path.isfile(sqm + ".exe"):
                sqm += ".exe"   # Windows
            if not (os.path.isfile(sqm) and os.access(sqm, os.X_OK)):
                return self._send_json(501, {"ok": False, "error":
                    "sqm が見つかりません (" + sqm + ")。レンダラーの dist/ と並んだ配置で"
                    "起動するか、環境変数 SQM_BIN で場所を指定してください"})
            length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(length) if length else b""
            ctype = (self.headers.get("Content-Type") or "").lower()
            scene = b""
            env = dict(os.environ)
            if "SQM_SHADER_CORE" not in env:
                # 既定パスは main.cpp の macOS 固定値なので、Windows 等では隣の
                # dr_sbcl を探して渡す (無指定だと .lisp 材質が黙ってネイティブに落ちる)
                core = os.path.abspath(os.path.join(
                    self.directory, "..", "..", "dr_sbcl", "lib", "shader.core"))
                if os.path.isfile(core):
                    env["SQM_SHADER_CORE"] = core
            if "application/json" in ctype:
                try:
                    obj = json.loads(data.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as e:
                    return self._send_json(400, {"ok": False, "error": "JSON 解析失敗: " + str(e)})
                scene = (obj.get("ssq") or "").encode("utf-8")
                args_tail, env_extra = self._build_sqm_args(obj.get("params") or {})
                env.update(env_extra)
            else:
                scene = data
                qs = parse_qs(parsed.query)
                def qint(key, dflt, lo, hi):
                    try: v = int(qs.get(key, [dflt])[0])
                    except (ValueError, TypeError): v = dflt
                    return max(lo, min(hi, v))
                w = qint("w", 640, 64, 2400); h = qint("h", 420, 64, 2400)
                hq = (qs.get("q", ["draft"])[0]) == "hq"
                args_tail = ["-x", str(w), "-y", str(h), "-D", "2"]
                args_tail += ["-A", "2", "-s", "2", "-O", "8"] if hq else ["-A", "1", "-s", "1"]
            if not scene:
                return self._send_json(400, {"ok": False, "error": "empty scene"})
            with tempfile.TemporaryDirectory() as td:
                ssq = os.path.join(td, "scene.ssq")
                png = os.path.join(td, "out.png")
                with open(ssq, "wb") as f:
                    f.write(scene)
                args = [sqm, "-i", ssq, "-o", png] + args_tail
                try:
                    r = subprocess.run(args, capture_output=True, timeout=600, env=env)
                except subprocess.TimeoutExpired:
                    return self._send_json(504, {"ok": False, "error": "レンダリングが600秒を超えました"})
                if r.returncode != 0 or not os.path.isfile(png):
                    tail = (r.stderr or r.stdout or b"").decode("utf-8", "replace")[-400:]
                    return self._send_json(500, {"ok": False, "error": "sqm 失敗: " + tail})
                with open(png, "rb") as f:
                    body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # 現在のモデルを marching cubes でメッシュ化して返す (メッシュプロキシ表示用)
        #   POST /__mesh__?grid=180  (body = .ssq テキスト)
        #   応答 (application/octet-stream, little-endian):
        #     uint32 nVerts, uint32 nTris,
        #     float32 verts[nVerts*3], float32 normals[nVerts*3], uint32 idx[nTris*3]
        #   実装は tools/field2obj.py の mesh_from_scene() (SQM_SDF_DUMP → skimage MC)。
        #   エンジン (dist/) 無改修: 既存の場ダンプ経路を subprocess で叩くだけ。
        if parsed.path == "/__mesh__":
            sqm = os.environ.get("SQM_BIN") or os.path.abspath(
                os.path.join(self.directory, "..", "dist", "sqm"))
            if not os.path.isfile(sqm) and os.path.isfile(sqm + ".exe"):
                sqm += ".exe"   # Windows
            if not (os.path.isfile(sqm) and os.access(sqm, os.X_OK)):
                return self._send_json(501, {"ok": False, "error":
                    "sqm が見つかりません (" + sqm + ")"})
            try:
                sys.path.insert(0, os.path.abspath(
                    os.path.join(self.directory, "..", "tools")))
                import numpy as np
                from field2obj import mesh_from_scene
            except ImportError as e:
                return self._send_json(501, {"ok": False, "error":
                    "field2obj の import 失敗 (" + str(e) +
                    ") — pip で numpy / scikit-image が必要です"})
            qs = parse_qs(parsed.query)
            try:
                grid = int(qs.get("grid", ["180"])[0])
            except (ValueError, TypeError):
                grid = 180
            grid = max(32, min(400, grid))
            length = int(self.headers.get("Content-Length", 0))
            scene = self.rfile.read(length) if length else b""
            if not scene:
                return self._send_json(400, {"ok": False, "error": "empty scene"})
            with tempfile.TemporaryDirectory() as td:
                ssq = os.path.join(td, "scene.ssq")
                with open(ssq, "wb") as f:
                    f.write(scene)
                try:
                    verts, faces, normals, meta = mesh_from_scene(
                        ssq, kind=None, grid=grid, sqm=sqm)
                except RuntimeError as e:
                    return self._send_json(500, {"ok": False, "error": str(e)})
                except Exception as e:   # MC の "no surface" (空シーン) 等
                    return self._send_json(500, {"ok": False, "error":
                        type(e).__name__ + ": " + str(e)})
            head = np.array([len(verts), len(faces)], dtype="<u4").tobytes()
            body = (head
                    + np.ascontiguousarray(verts, dtype="<f4").tobytes()
                    + np.ascontiguousarray(normals, dtype="<f4").tobytes()
                    + np.ascontiguousarray(faces, dtype="<u4").tobytes())
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # ── OBJ 取込 (モデル取込ボタンで .obj を選んだとき) ────────────────
        #   POST /__objimport__?grid=128&name=bear  (body = OBJ のバイト列)
        #   応答 (JSON) = {ok, file(絶対パス), dims, lo, h, center, size}
        #   OBJ は三角形メッシュなので SDF ノード木にはならない。tools/obj2sdfgrid.py で
        #   **符号付き距離場グリッド**に焼き、(grid (file ..)) リーフ1個として取り込む。
        #   楕円体近似 (旧実装, obj_to_ellipsoids.py) は被覆率7割程度で形が別物だったため
        #   置き換えた。グリッドは三角形数に依存しない O(1) サンプルで忠実度が桁違い。
        #   .f32 は examples/grids/ に永続化する (モデラーが保存する .ssq から参照するため。
        #   一時ディレクトリだとレンダや再読込で消えてしまう)。
        if parsed.path == "/__objimport__":
            tools = os.path.abspath(os.path.join(self.directory, "..", "tools"))
            script = os.path.join(tools, "obj2sdfgrid.py")
            if not os.path.isfile(script):
                return self._send_json(501, {"ok": False, "error":
                    "obj2sdfgrid.py が見つかりません (" + script + ")"})
            qs = parse_qs(parsed.query)
            try:
                gn = int(qs.get("grid", ["128"])[0])
            except (ValueError, TypeError):
                gn = 128
            gn = max(32, min(320, gn))
            raw = (qs.get("name", ["model"])[0]) or "model"
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(raw))[:64] or "model"
            if name.lower().endswith(".obj"):
                name = name[:-4]
            length = int(self.headers.get("Content-Length", 0))
            obj = self.rfile.read(length) if length else b""
            if not obj:
                return self._send_json(400, {"ok": False, "error": "empty obj"})

            gdir = os.path.join(self._examples_dir(), "grids")
            os.makedirs(gdir, exist_ok=True)
            out = os.path.join(gdir, name + ".f32")
            with tempfile.TemporaryDirectory() as td:
                src = os.path.join(td, "in.obj")
                with open(src, "wb") as f:
                    f.write(obj)
                try:
                    r = subprocess.run(
                        [sys.executable, script, src, "-o", out, "--grid", str(gn)],
                        capture_output=True, text=True, timeout=600)
                except subprocess.TimeoutExpired:
                    return self._send_json(504, {"ok": False, "error":
                        "ベイクが 600 秒を超えました (--grid を下げてください)"})
            if r.returncode != 0 or not os.path.isfile(out + ".json"):
                err = ((r.stderr or "") + "\n" + (r.stdout or "")).strip()
                last = ([ln for ln in err.splitlines() if ln.strip()] or [""])[-1]
                if "NoneType" in err:
                    last = "OBJ として読めませんでした (三角形メッシュの .obj か確認してください)"
                return self._send_json(500, {"ok": False, "error":
                    "グリッド化に失敗: " + last[:300]})
            with open(out + ".json") as f:
                meta = json.load(f)
            dims, lo, h = meta["dims"], meta["lo"], meta["h"]
            size = [(dims[k] - 1) * h for k in range(3)]
            return self._send_json(200, {
                "ok": True, "file": os.path.abspath(out),
                "dims": dims, "lo": lo, "h": h, "size": size,
                "center": [lo[k] + 0.5 * size[k] for k in range(3)]})
        # ── グリッド本体の取得 (GLSL プレビューの 3D テクスチャ用) ───────────
        #   POST /__gridfile__  (body = 絶対パス)  → 応答: [uint32 nx,ny,nz][float32 lo*3]
        #                                                  [float32 h][float32 data...]
        #   .ssq は絶対パスで grid を参照するが、ブラウザは絶対パスを fetch できないので
        #   サーバー経由で読む。プロジェクト配下の .f32 に限定する。
        if parsed.path == "/__gridfile__":
            import struct
            length = int(self.headers.get("Content-Length", 0))
            path = (self.rfile.read(length) if length else b"").decode("utf-8").strip()
            root = os.path.abspath(os.path.join(self.directory, ".."))
            ap = os.path.abspath(path)
            if not ap.endswith(".f32") or not (ap + os.sep).startswith(root + os.sep):
                return self._send_json(400, {"ok": False, "error":
                    "プロジェクト外/非.f32 は読めません: " + path})
            if not (os.path.isfile(ap) and os.path.isfile(ap + ".json")):
                return self._send_json(404, {"ok": False, "error":
                    "グリッドが見つかりません: " + path})
            with open(ap + ".json") as f:
                meta = json.load(f)
            with open(ap, "rb") as f:
                raw = f.read()
            d, lo, h = meta["dims"], meta["lo"], meta["h"]
            head = (struct.pack("<3I", d[0], d[1], d[2])
                    + struct.pack("<4f", lo[0], lo[1], lo[2], h))
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(head) + len(raw)))
            self.end_headers()
            self.wfile.write(head)
            self.wfile.write(raw)
            return
        # ── OBJ の保存 (モデル取込「メッシュのまま置く」) ─────────────────
        #   POST /__objupload__?name=bear  (body = OBJ のバイト列)
        #   examples/objs/<name>.obj に保存し絶対パスを返す (grid の .f32 と同じ流儀 —
        #   モデラーが保存する .ssq から参照するため永続化する)。
        if parsed.path == "/__objupload__":
            raw = (parse_qs(parsed.query).get("name", ["model"])[0]) or "model"
            name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(raw))[:64] or "model"
            if name.lower().endswith(".obj"):
                name = name[:-4]
            length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(length) if length else b""
            if not data:
                return self._send_json(400, {"ok": False, "error": "empty obj"})
            odir = os.path.join(self._examples_dir(), "objs")
            try:
                os.makedirs(odir, exist_ok=True)
                out = os.path.join(odir, name + ".obj")
                with open(out, "wb") as f:
                    f.write(data)
            except OSError as e:
                return self._send_json(500, {"ok": False, "error": str(e)})
            return self._send_json(200, {"ok": True, "file": os.path.abspath(out)})
        # ── OBJ 本体の取得 ((mesh (file ..)) ノードの表示用) ────────────────
        #   POST /__objfile__  (body = パス。$SQM_ROOT/ 接頭辞と相対パスはリポジトリ根で解決)
        #   応答: OBJ テキストそのまま。__gridfile__ と同じくプロジェクト配下に限定する。
        if parsed.path == "/__objfile__":
            length = int(self.headers.get("Content-Length", 0))
            path = (self.rfile.read(length) if length else b"").decode("utf-8").strip()
            root = os.path.abspath(os.path.join(self.directory, ".."))
            if path.startswith("$SQM_ROOT/") or path.startswith("$SQM_ROOT\\"):
                path = os.path.join(root, path[len("$SQM_ROOT/"):])
            elif not os.path.isabs(path):
                path = os.path.join(root, path)
            ap = os.path.abspath(path)
            if not ap.lower().endswith(".obj") or not (ap + os.sep).startswith(root + os.sep):
                return self._send_json(400, {"ok": False, "error":
                    "プロジェクト外/非.obj は読めません: " + path})
            if not os.path.isfile(ap):
                return self._send_json(404, {"ok": False, "error":
                    "OBJ が見つかりません: " + ap})
            with open(ap, "rb") as f:
                raw = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if parsed.path == "/__delete__":
            # examples/<name>.ssq を削除 (Shift+サンプル選択から)
            raw = (parse_qs(parsed.query).get("name", [""])[0]) or ""
            name = os.path.basename(raw)
            if "/" in raw or ".." in raw or not name.endswith(".ssq"):
                return self._send_json(400, {"ok": False, "error": "invalid name"})
            try:
                os.remove(os.path.join(self._examples_dir(), name))
            except OSError as e:
                return self._send_json(404, {"ok": False, "error": str(e)})
            return self._send_json(200, {"ok": True, "name": name})
        return self._send_json(404, {"ok": False, "error": "not found"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
    directory = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    print(f"sdfmodeler: http://localhost:{port}  (Cache-Control: no-store, dir={directory})")
    handler = functools.partial(NoStoreHandler, directory=directory)
    ThreadingHTTPServer(("", port), handler).serve_forever()
