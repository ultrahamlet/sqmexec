/* meshcache.mjs — メッシュのオブジェクト単位キャッシュ (js/meshcache.js) の検証。
 *   node test/meshcache.mjs
 *
 * 検証すること:
 *   ① mergeMeshes — index の頂点オフセットが正しく繋がる / null・空は飛ぶ
 *   ② gridForObject — 寸法比スケールと clamp [24, grid]
 *   ③ MeshCache — LRU (上限超過で最古が落ちる / get で延命)
 *   ④ 内容ハッシュ — 同一入力で安定、1文字の差で変わる
 *   ⑤ parseMeshBuffer — serve.py の応答レイアウトの読み
 *   ⑥ pooledMap — 順序保存・全要素処理
 */
import {
  fnv1a, gridForObject, spanOfSpheres, mergeMeshes, MeshCache,
  parseMeshBuffer, pooledMap,
} from '../js/meshcache.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

/* ── ① mergeMeshes ── */
const pa = { verts: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
             normals: new Float32Array([0,0,1, 0,0,1, 0,0,1]),
             indices: new Uint32Array([0,1,2]) };
const pb = { verts: new Float32Array([5,5,5, 6,5,5, 5,6,5]),
             normals: new Float32Array([0,1,0, 0,1,0, 0,1,0]),
             indices: new Uint32Array([0,1,2]) };
const m = mergeMeshes([pa, null, pb, { verts: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) }]);
ok(m.verts.length === 18 && m.indices.length === 6, 'merge: 頂点6/三角形2');
ok(m.indices[3] === 3 && m.indices[5] === 5, 'merge: 2枚目の index が +3 オフセット');
ok(m.verts[9] === 5 && m.normals[10] === 1, 'merge: 2枚目の頂点/法線が正位置');
ok(mergeMeshes([]).indices.length === 0, 'merge: 空入力で空メッシュ');

/* ── ② gridForObject ── */
ok(gridForObject(2.0, 2.0, 160) === 160, 'grid: 全体と同寸なら grid そのまま');
ok(gridForObject(0.5, 2.0, 160) === 40, 'grid: 1/4 寸法なら 1/4 (=40)');
ok(gridForObject(0.05, 2.0, 160) === 24, 'grid: 下限 24 で clamp');
ok(gridForObject(4.0, 2.0, 160) === 160, 'grid: 上限は全体 grid');
ok(gridForObject(0, 0, 160) === 64, 'grid: 寸法不明は控えめ (64)');

/* ── spanOfSpheres ── */
ok(Math.abs(spanOfSpheres([[0,0,0,1], [3,0,0,1], null]) - 5) < 1e-12,
   'span: 球2個 (中心距離3, r1) → 5');
ok(spanOfSpheres([null, null]) === 0, 'span: 全 null は 0');

/* ── ③ MeshCache ── */
const c = new MeshCache(2);
c.set('a', 1); c.set('b', 2); c.set('c', 3);
ok(c.get('a') === undefined && c.get('c') === 3, 'cache: 上限2で最古 a が落ちる');
c.get('b');            /* b を延命 */
c.set('d', 4);
ok(c.get('b') === 2 && c.get('c') === undefined, 'cache: get で延命した b が残り c が落ちる');

/* ── ④ ハッシュ ── */
ok(fnv1a('(object "x")') === fnv1a('(object "x")'), 'hash: 安定');
ok(fnv1a('(object "x")') !== fnv1a('(object "y")'), 'hash: 内容差で変わる');

/* ── ⑤ parseMeshBuffer ── */
{
  const nv = 2, nt = 1;
  const buf = new ArrayBuffer(8 + nv*12*2 + nt*12);
  new Uint32Array(buf, 0, 2).set([nv, nt]);
  new Float32Array(buf, 8, 6).set([1,2,3, 4,5,6]);
  new Float32Array(buf, 8 + nv*12, 6).set([0,0,1, 0,1,0]);
  new Uint32Array(buf, 8 + nv*24, 3).set([0,1,0]);
  const p = parseMeshBuffer(buf);
  ok(p.verts[3] === 4 && p.normals[4] === 1 && p.indices[1] === 1,
     'parse: serve.py レイアウト (nv,nt,verts,normals,idx) を正しく読む');
}

/* ── ⑥ pooledMap ── */
{
  const seen = [];
  const out = await pooledMap([10, 20, 30, 40, 50], async (v, i) => {
    await new Promise(r => setTimeout(r, (5 - i) * 3));   /* 逆順に終わらせる */
    seen.push(v);
    return v * 2;
  }, 2);
  ok(out.join(',') === '20,40,60,80,100', 'pool: 完了順に依らず出力順序を保存');
  ok(seen.length === 5, 'pool: 全要素を処理');
}

console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
process.exit(fails ? 1 : 0);
