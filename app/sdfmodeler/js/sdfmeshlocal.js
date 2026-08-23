/* sdfmeshlocal.js — SDF ローカル再メッシュのメイン側ラッパ (2026-08-23)
 *
 * ハイブリッド表示 B 案: serve.py /__mesh__ 往復の代わりに sdfmesh.wasm
 * (engine の実パーサ + sdf_eval + marching tetrahedra) を Web Worker で呼ぶ。
 * サーバ経路と同じ「単一 object の .ssq テキスト + grid」を受け、
 * parseMeshBuffer 互換の {verts, normals, indices} を返す。
 *
 * rc の意味 (sdfmesh_wasm.cpp):
 *   -5 = メッシュ化対象なし (床 plane だけ等) → null (正常)
 *   その他の負 = 非対応 (grid リーフ/volume/dsl 変位/パース失敗) → throw
 *               (呼び出し側がサーバへフォールバックする) */
export class LocalSdfMesher {
  constructor() {
    this.dead = false;
    this._seq = 0;
    this._pending = new Map();
    try {
      this._worker = new Worker(new URL('./sdfmesh_worker.js', import.meta.url),
                                { type: 'module' });
    } catch (e) {
      console.warn('sdfmesh worker 起動失敗 (サーバ経路のみ):', e);
      this.dead = true;
      return;
    }
    this._worker.onmessage = e => {
      const { id, rc, verts, normals, colors, indices, error } = e.data;
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (rc === 0) p.resolve(p.op === 'colorize' ? colors
                                                  : { verts, normals, colors, indices });
      else if (rc === -5) p.resolve(null);          /* 対象なし = 空 (正常) */
      else p.reject(new Error(error || ('rc=' + rc)));
    };
    this._worker.onerror = e => {
      console.warn('sdfmesh worker error → サーバ経路へ:', e.message || e);
      this.dead = true;
      for (const p of this._pending.values()) p.reject(new Error('worker died'));
      this._pending.clear();
    };
  }

  /* 単一 object の .ssq テキストをメッシュ化。null = 対象なし。
     結果は {verts, normals, colors, indices} (colors = surface 色 + mcolor
     ブレンドの頂点色) */
  mesh(text, grid) {
    if (this.dead) return Promise.reject(new Error('worker unavailable'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, op: 'mesh' });
      this._worker.postMessage({ id, op: 'mesh', text, grid });
    });
  }

  /* 既存メッシュ (サーバ焼き) の頂点列に色だけ塗る → Float32Array (n*3) */
  colorize(text, verts) {
    if (this.dead) return Promise.reject(new Error('worker unavailable'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, op: 'colorize' });
      /* verts は転送しない (呼び出し側のバッファを生かす) — 構造化クローン */
      this._worker.postMessage({ id, op: 'colorize', text, verts });
    });
  }
}
