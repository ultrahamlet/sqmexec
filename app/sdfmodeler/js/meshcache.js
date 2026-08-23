/* meshcache.js — メッシュ表示のオブジェクト単位キャッシュ (2026-08-04)
 *
 * 従来のメッシュ表示は編集のたびに**シーン全体**を /__mesh__ へ送って焼き直して
 * いた (sqm 起動 + 全ボクセル評価 + MC)。だが編集で変わるのは普通1オブジェクト
 * だけ。ここでは
 *   ・オブジェクトごとに「単体シーンの .ssq テキスト + grid」の**内容ハッシュ**を
 *     キーにメッシュをキャッシュし、変わったものだけ再取得する
 *   ・objIdx の追跡はしない — 内容ハッシュなら undo/redo/取込/一括編集の
 *     どの経路でも正しく差分になる
 *   ・per-object の grid は**ボクセル寸法がシーン全体ダンプと揃う**よう
 *     シーン全体との寸法比でスケールする (小物が過剰に細かくならない)
 *   ・取得後はクライアントで1本に結合して viewer.setMeshData へ (viewer 無改修)
 *
 * このファイルは DOM に触らない純関数だけ (node で test/meshcache.mjs から検証)。
 */

/* FNV-1a 32bit — 内容キー用 (暗号強度は不要) */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* オブジェクト単体の grid: シーン全体 grid をオブジェクトの寸法比で縮める。
 * 全体ダンプの h ≈ sceneSpan*1.04/grid に対し、単体ダンプは自分の bbox に
 * grid を張るので、そのままだと小物ほど細かくなり見た目も三角形数も変わる。
 * 下限24 (これ未満は形が崩れる)、上限は全体 grid。 */
export function gridForObject(objSpan, sceneSpan, grid) {
  if (!(objSpan > 0) || !(sceneSpan > 0)) return Math.min(grid, 64);
  const g = Math.ceil(grid * objSpan / sceneSpan);
  return Math.max(24, Math.min(grid, g));
}

/* 球のリスト [[cx,cy,cz,r], ...] から全体スパン (最大軸幅) を出す。null は無視 */
export function spanOfSpheres(spheres) {
  let lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30], any = false;
  for (const s of spheres) {
    if (!s) continue;
    any = true;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], s[k] - s[3]);
      hi[k] = Math.max(hi[k], s[k] + s[3]);
    }
  }
  if (!any) return 0;
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/* 部品メッシュ ({verts,normals,indices} | null) を1本に結合。
 * index は頂点オフセットを足して繋ぐ。null/空は飛ばす。 */
export function mergeMeshes(parts) {
  let nv = 0, nt = 0;
  for (const p of parts) {
    if (!p || !p.verts || !p.verts.length) continue;
    nv += p.verts.length / 3;
    nt += p.indices.length / 3;
  }
  const verts = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  let vo = 0, io = 0;
  for (const p of parts) {
    if (!p || !p.verts || !p.verts.length) continue;
    verts.set(p.verts, vo * 3);
    normals.set(p.normals, vo * 3);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + vo;
    vo += p.verts.length / 3;
    io += p.indices.length;
  }
  return { verts, normals, indices };
}

/* 上限つきキャッシュ (挿入順で古いものから捨てる素朴な LRU もどき)。
 * 1エントリは数百KB〜数MB なので 64 で高々百数十MB。 */
export class MeshCache {
  constructor(limit = 64) { this.limit = limit; this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {          /* 触れたら末尾へ (再挿入) */
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key, v) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.limit)
      this.map.delete(this.map.keys().next().value);
  }
}

/* 応答バイナリ (uint32 nv,nt + f32 verts + f32 normals + u32 idx) → 部品メッシュ */
export function parseMeshBuffer(buf) {
  const [nv, nt] = new Uint32Array(buf, 0, 2);
  return {
    verts: new Float32Array(buf, 8, nv * 3),
    normals: new Float32Array(buf, 8 + nv * 12, nv * 3),
    indices: new Uint32Array(buf, 8 + nv * 24, nt * 3),
  };
}

/* 直列実行数を絞った並列 map (初回ロードで sqm を同時に立てすぎない) */
export async function pooledMap(items, fn, limit = 4) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
