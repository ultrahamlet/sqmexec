/* mbblob.js — native blob (メタボール) のパースと WASM 再メッシュ (2026-08-23)
 *
 * vclay のメッシュ化コア (1992 年評価器 + Bloomenthal ポリゴナイザ) を
 * Emscripten でコンパイルした mbmesh.wasm を呼ぶ。場・等値面・行列規約は
 * sqm / ssq_edit と同一 (ネイティブ mbmesh_test で faces バイト一致を検証済み)。
 *
 * blob 1 個 = double 23 個 (mbmesh.h の MBM_STRIDE):
 *   pos3 scale3 rot3(度) weight threshold super3 is_super group_no color3 deform(amp freq phase mode)
 * threshold 0 は C 側が weight から二分法で導出する (sqm fill_blob と同一)。 */
import MbMesh from './mbmesh.js';

export const MBM_STRIDE = 23;

/* ---- .ssq パース (vclay/ssq_edit.c parse_blob_line と同じ規約) ---------- */

function num3(src, key, dflt) {
  const m = src.match(new RegExp('\\(' + key + '\\s+([-0-9.eE]+)(?:\\s+([-0-9.eE]+)\\s+([-0-9.eE]+))?'));
  if (!m) return dflt.slice();
  if (m[2] === undefined) { const v = parseFloat(m[1]); return [v, v, v]; }
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

function num1(src, key, dflt) {
  const m = src.match(new RegExp('\\(' + key + '\\s+([-0-9.eE]+)'));
  return m ? parseFloat(m[1]) : dflt;
}

/* 1 行の (blob ...) → blob オブジェクト。該当しない行は null */
export function parseBlobLine(line) {
  const i = line.indexOf('(blob ') >= 0 ? line.indexOf('(blob ') : line.indexOf('(blob(');
  if (i < 0 || line.includes('blob-bulk')) return null;
  const p = line.slice(i);
  if (p.includes('(deform')) return null;   /* deform 付きは未対応 (ssq_edit と同じ) */
  const b = {
    pos:   num3(p, 'pos',   [0, 0, 0]),
    scale: num3(p, 'scale', [1, 1, 1]),
    rot:   num3(p, 'rot',   [0, 0, 0]),
    weight:    num1(p, 'weight', 1.0),
    threshold: num1(p, 'threshold', 0.0),
    super:  num3(p, 'super', [2, 2, 2]),
    isSuper: /\(super\s/.test(p) ? 1 : 0,
    group:  Math.round(num1(p, 'group', 0)),
  };
  return b;
}

/* .ssq 本文 → { blobs, nbPairs } 。nbPairs は group_no の [a,b] ペア列。
 * (no-blend a b [c ..]) は列挙群の**全ペア**・複数行は累積 (sqm パーサと同じ)。 */
export function parseSsqBlobs(text) {
  const blobs = [], nbPairs = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    const b = parseBlobLine(line);
    if (b) blobs.push(b);
    const m = line.match(/\(no-blend\s+([^)]*)\)/);
    if (m) {
      const gs = m[1].trim().split(/\s+/).map(Number).filter(Number.isFinite);
      for (let a = 0; a < gs.length; a++)
        for (let c = a + 1; c < gs.length; c++) {
          const lo = Math.min(gs[a], gs[c]), hi = Math.max(gs[a], gs[c]);
          const key = lo + ':' + hi;
          if (lo !== hi && !seen.has(key)) { seen.add(key); nbPairs.push([lo, hi]); }
        }
    }
  }
  return { blobs, nbPairs };
}

/* ---- WASM 再メッシュ ---------------------------------------------------- */

export class BlobMesher {
  constructor(mod) {
    this.mod = mod;
    this._blobPtr = 0; this._blobCap = 0;
    this._pairPtr = 0; this._pairCap = 0;
  }

  static async create() {
    const mod = await MbMesh();
    return new BlobMesher(mod);
  }

  _ensure(field, capField, need, elem) {
    if (this[capField] >= need) return;
    if (this[field]) this.mod._free(this[field]);
    const cap = Math.max(need, 64);
    this[field] = this.mod._malloc(cap * elem);
    this[capField] = cap;
  }

  /* blobs: parseBlobLine の形の配列 / nbPairs: [[g1,g2],..] / level: 3..9
   * 戻り値: { positions: Float32Array, normals: Float32Array,
   *           indices: Uint32Array }  (すべてコピー — 次回呼び出しと独立) */
  mesh(blobs, nbPairs = [], level = 6) {
    const rec = [];
    for (const b of blobs) {
      const c = b.color || [0.7, 0.7, 0.7];
      const df = b.deform || [0, 0, 0, 0];
      rec.push(b.pos[0], b.pos[1], b.pos[2],
               b.scale[0], b.scale[1], b.scale[2],
               b.rot[0], b.rot[1], b.rot[2],
               b.weight, b.threshold,
               b.super[0], b.super[1], b.super[2],
               b.isSuper ? 1 : 0, b.group,
               c[0], c[1], c[2],
               df[0], df[1], df[2], df[3]);
    }
    return this.meshRecords(rec, nbPairs, level);
  }

  /* flat レコード (mbmesh.h 準拠 23 double/個) を直接渡す口 (blobnode.collectSceneBlobs 用) */
  meshRecords(records, nbPairs = [], level = 6) {
    const n = (records.length / MBM_STRIDE) | 0;
    this._ensure('_blobPtr', '_blobCap', n * MBM_STRIDE, 8);
    this.mod.HEAPF64.set(records, this._blobPtr >> 3);
    this._ensure('_pairPtr', '_pairCap', Math.max(nbPairs.length * 2, 2), 4);
    {
      const H = this.mod.HEAP32;
      let o = this._pairPtr >> 2;
      for (const [a, b] of nbPairs) { H[o++] = a; H[o++] = b; }
    }
    const rc = this.mod._mbm_mesh(this._blobPtr, n, this._pairPtr,
                                  nbPairs.length, level);
    if (rc !== 0) throw new Error('mbm_mesh error ' + rc);
    const nv = this.mod._mbm_nvtx(), nt = this.mod._mbm_ntri();
    /* HEAP ビューはメモリ成長で無効になるので呼び出しごとに取り直してコピー */
    const pp = this.mod._mbm_positions() >> 2;
    const np = this.mod._mbm_normals() >> 2;
    const cp = this.mod._mbm_colors() >> 2;
    const ip = this.mod._mbm_indices() >> 2;
    return {
      positions: this.mod.HEAPF32.slice(pp, pp + nv * 3),
      normals:   this.mod.HEAPF32.slice(np, np + nv * 3),
      colors:    this.mod.HEAPF32.slice(cp, cp + nv * 3),
      indices:   this.mod.HEAPU32.slice(ip, ip + nt * 3),
    };
  }
}
