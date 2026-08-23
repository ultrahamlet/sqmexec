/* sdfmesh_worker.js — SDF ローカル再メッシュの Web Worker (2026-08-23)
 *
 * sdfmesh.wasm (= engine の実パーサ sexp_input + 実評価器 sdf.cpp +
 * marching tetrahedra) をワーカースレッドで回す。human 84ノード grid96 で
 * 数百 ms 級なのでメインスレッドでは呼ばない。
 * 受信: { id, text, grid } / 返信: { id, rc, verts?, normals?, indices?, error? }
 * (typed array は transfer で無コピー)
 *
 * ⚠ sdfmesh.wasm の sexp_parse_active はパースごとに sdinfo (≈100MB超) を
 *   リークする版が配布されている (修正は tools/sdfmesh_wasm.cpp 2026-08-23 —
 *   要 emcc 再ビルド)。約8回でヒープが尽き「out of memory allocating initial
 *   surface slots」になり、colorize 全滅 → メッシュ表示が単色プロキシに落ちて
 *   白化する。ここでは OOM を検知したらモジュールを作り直して 1 回だけ
 *   リトライする (新インスタンス = まっさらなヒープ)。 */
import SdfMesh from './sdfmesh.js';

let modP = SdfMesh();

const isOom = s => /out of memory|OOM|Cannot enlarge memory|abort/i.test(String(s || ''));

/* 1 リクエスト分の実行。成功なら postMessage 済みで true、失敗なら
   {rc, error} を返す (呼び出し側がリトライ判定する) */
async function runOnce(mod, e) {
  const { id, op, text, grid, verts: inVerts } = e.data;
  if (op === 'colorize') {
    /* サーバ焼きメッシュに色だけ塗る (頂点列を渡して mcolor ブレンド評価) */
    const tp = mod.stringToNewUTF8(text);
    const n = (inVerts.length / 3) | 0;
    const vp = mod._malloc(inVerts.length * 4);
    mod.HEAPF32.set(inVerts, vp >> 2);
    const rc = mod._smw_colorize(tp, vp, n);
    mod._free(vp);
    mod._free(tp);
    if (rc !== 0) return { rc, error: mod.UTF8ToString(mod._smw_error()) };
    const cp = mod._smw_colors() >> 2;
    const colors = mod.HEAPF32.slice(cp, cp + n * 3);
    postMessage({ id, rc: 0, colors }, [colors.buffer]);
    return true;
  }
  const tp = mod.stringToNewUTF8(text);
  const rc = mod._smw_mesh(tp, grid);
  mod._free(tp);
  if (rc !== 0) return { rc, error: mod.UTF8ToString(mod._smw_error()) };
  const nv = mod._smw_nvtx(), nt = mod._smw_ntri();
  const pp = mod._smw_positions() >> 2;
  const np = mod._smw_normals() >> 2;
  const cp = mod._smw_colors() >> 2;
  const ip = mod._smw_indices() >> 2;
  const verts   = mod.HEAPF32.slice(pp, pp + nv * 3);
  const normals = mod.HEAPF32.slice(np, np + nv * 3);
  const colors  = mod.HEAPF32.slice(cp, cp + nv * 3);
  const indices = mod.HEAPU32.slice(ip, ip + nt * 3);
  postMessage({ id, rc: 0, verts, normals, colors, indices },
              [verts.buffer, normals.buffer, colors.buffer, indices.buffer]);
  return true;
}

onmessage = async e => {
  const { id } = e.data;
  try {
    let mod;
    let res;
    try {
      mod = await modP;
      res = await runOnce(mod, e);
    } catch (err) {
      res = { rc: -100, error: String(err) };   /* abort 等はモジュール死 → 作り直し対象 */
    }
    if (res !== true && isOom(res.error)) {
      /* ヒープ枯渇 → 新インスタンス (まっさらなヒープ) で 1 回だけリトライ */
      modP = SdfMesh();
      mod = await modP;
      res = await runOnce(mod, e);
    }
    if (res !== true) postMessage({ id, rc: res.rc, error: res.error });
  } catch (err) {
    postMessage({ id, rc: -100, error: String(err) });
  }
};
