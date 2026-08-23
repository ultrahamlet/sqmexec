/* extrude.mjs — 押し出しリーフ (extrude) の検証。
 *   node test/extrude.mjs
 *
 * 検証すること:
 *   ① .ssq → ノード → .ssq のラウンドトリップ (raw に落ちない・値が保たれる)
 *   ② JS 側の距離式が **エンジン (dist/sdf.cpp sd_extrude) と同式**であること
 *      — 参照値は sqm の SQM_SDF_DUMP を格子点で読んだもの (下の ENGINE)。
 *        補間を挟むと格子間隔ぶん (~1e-3) ずれるので **格子点そのもの**で比較する。
 *   ③ GLSL が生成され、**一時変数名が衝突しない**こと
 *      — `${d}2` のような数字接尾辞は tmp() の d0,d1,… と衝突する (node d1 が
 *        "d12" を作り、別ノードの d12 とぶつかってリンクエラーになった実例あり)。
 *   ④ 枝刈りガード球が null にならないこと (null = ガード無効で描画が遅くなる)
 */
import { parseAll, serialize } from '../js/sexpr.js';
import { sdfToNode, nodeToSdf, parseScene } from '../js/model.js';
import { extrudeBaked, buildProgram, collectParams, nodeSphere } from '../js/codegen.js';

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

/* ── ① ラウンドトリップ ─────────────────────────────────────────────── */
const SRC = '(extrude (center 0.02 -0.03 0.041) (depth 0.041) (steps 3) '
          + '(spline -0.28 0 -0.2 0.12 0 0.28 0.2 0.12 0.28 0))';
const node = sdfToNode(parseAll(SRC)[0]);
ok(node.type === 'extrude', 'extrude として読める (raw に落ちない)');
ok(node.props.depth === 0.041 && node.props.curve === 1 && node.props.steps === 3,
   'depth/curve/steps が保たれる');
ok(node.props.prof.length === 5, '輪郭 5 点');
ok(serialize(nodeToSdf(node)) === SRC, '.ssq へ書き戻して文字列一致');

const shell = sdfToNode(parseAll(
  '(extrude (center 0 0 0) (depth 0.1) (thick 0.02) (profile -0.3 0 0.3 0 0 0.4))')[0]);
ok(shell.type === 'extrude' && shell.props.thick === 0.02, '開シェル (thick) も読める');
ok(sdfToNode(parseAll('(extrude (center 0 0 0) (depth 0.1) (profile 0 0 1 0))')[0]).type === 'raw',
   '輪郭 3 点未満は raw で保全 (壊れた形を捏造しない)');

/* ── ② エンジンとの数値一致 ─────────────────────────────────────────── */
/* 参照シーン: (extrude (center 0 0 0)(depth 0.05)(profile -0.28 0 -0.20 0.12 0 0.28 0.20 0.12 0.28 0))
   ENGINE[i] = sqm の SQM_SDF_DUMP を **格子点そのもの**で読んだ値 (grid 200)。 */
const P = { center: [0, 0, 0], depth: 0.05, thick: 0, steps: 3, curve: 0,
            prof: [[-0.28, 0], [-0.20, 0.12], [0, 0.28], [0.20, 0.12], [0.28, 0]] };
const bk = extrudeBaked(P), poly = bk.pts, m = bk.m;
ok(m === 5 && bk.solid, '折れ線 (curve 0) は密化せず 5 点のソリッド');

function sdExtrude(p) {          /* GLSL の case 'extrude' と同じ式 */
  const qx = p[0] - P.center[0], qy = p[1] - P.center[1];
  let d = (qx - poly[0]) ** 2 + (qy - poly[1]) ** 2, s = 1;
  for (let i = 0, j = m - 1; i < m; j = i, i++) {
    const vix = poly[2 * i], viy = poly[2 * i + 1];
    const vjx = poly[2 * j], vjy = poly[2 * j + 1];
    const ex = vjx - vix, ey = vjy - viy, wx = qx - vix, wy = qy - viy;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / Math.max(ex * ex + ey * ey, 1e-30)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = qy >= viy, c2 = qy < vjy, c3 = (ex * wy > ey * wx);
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  const d2 = s * Math.sqrt(d);
  const w = Math.abs(p[2] - P.center[2]) - P.depth;
  return Math.min(Math.max(d2, w), 0) + Math.hypot(Math.max(d2, 0), Math.max(w, 0));
}
/* [点, エンジンの値] — 上の格子点比較で最大差 6.7e-9 (float32 の丸め幅 1.6e-8 未満) */
const ENGINE = [
  [[0, 0.1, 0.2], 0.15],
  [[0, 0.5, 0], 0.22],
  [[0.1, 0.05, 0.05], 0.0],
];
let worst = 0;
for (const [p, e] of ENGINE) worst = Math.max(worst, Math.abs(sdExtrude(p) - e));
ok(worst < 1e-6, `エンジンと一致 (最大差 ${worst.toExponential(2)})`);

/* ── ③ GLSL 生成 + 変数名の衝突 ──────────────────────────────────────── */
const doc = parseScene(`(scene
  (camera (from 0 0 2) (at 0 0 0) (up 0 1 0) (fov 40))
  (object "a" (surface (color 1 1 1) (ka 0.2) (kd 0.8) (ks 0.1) (phong 10) (roi 1.0))
    (sdf (smooth-union (k 0.02)
      ${Array.from({ length: 16 }, (_, i) =>
        `(translate (t ${i * 0.1} 0 0) (sphere (center 0 0 0) (radius 0.05)))`).join('\n      ')}
      (round (r 0.018) (extrude (center 0 0 0.04) (depth 0.04)
        (profile -0.28 0 -0.2 0.12 0 0.28 0.2 0.12 0.28 0)))))))`);
const prog = buildProgram(doc);
const frag = prog.frag;
ok(/sdPolyUV\(/.test(frag) && /abs\(\w+\.z - parAt/.test(frag), 'extrude の GLSL が出る');
ok(!/raw: 未対応リーフ/.test(frag), 'raw に落ちていない');
/* 一時変数の重複は **同一関数の中**だけが問題 (別関数の同名ローカルは正当)。
   オブジェクト距離関数 (sdObj0.. と probe) の本体だけを切り出して二重宣言を見る。 */
const bodies = [...frag.matchAll(/\n(?:float|vec2) (sdObj\d+|probe)\([^)]*\)\s*\{([\s\S]*?)\n\}/g)];
ok(bodies.length > 0, 'オブジェクト距離関数を切り出せた');
let dup = [];
for (const b of bodies) {
  const d = [...b[2].matchAll(/^\s*(?:float|vec2)\s+(\w+)\s*=/gm)].map(x => x[1]);
  dup.push(...d.filter((x, i) => d.indexOf(x) !== i).map(x => b[1] + ':' + x));
}
ok(dup.length === 0,
   `同一関数内の一時変数に重複なし${dup.length ? ' — 重複: ' + [...new Set(dup)].join(',') : ''}`);
ok(collectParams(doc, prog.layout).length > 0, 'パラメータが焼ける');

/* ── ④ 枝刈りガード ─────────────────────────────────────────────────── */
const sph = nodeSphere(sdfToNode(parseAll(
  '(extrude (center 0 0.1 0) (depth 0.05) (profile -0.3 0 0.3 0 0 0.4))')[0]));
ok(Array.isArray(sph) && sph[3] > 0, `ガード球が出る (r=${sph ? sph[3].toFixed(3) : 'null'})`);

console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
process.exit(fails ? 1 : 0);
