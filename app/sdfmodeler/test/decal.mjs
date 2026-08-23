/* decal.mjs — 「別の SDF の表面に沿わせる」decal の検証。
 *   node test/decal.mjs
 *
 * decal はモデラーに**専用ノードを足していない** — 既存オペの組み合わせで書ける:
 *
 *     shell = (onion (t T) (round (r R) <ホストのSDF>))   ← 表面から [R-T,R+T] の殻
 *     decal = (intersect shell <法線方向に伸ばしたカッター>)
 *
 * 距離場そのものを使うので厚みがホストの曲率に完全追従する。よってここで検証
 * するのは「その木がモデラーで壊れずに扱えるか」と、**枝刈りガードが実用的か**。
 *
 * 検証すること:
 *   ① scenes/sdf_decal_test.ssq が raw に落ちず読める / GLSL が出る / 書き戻せる
 *   ② intersect のガード球が **最小の子**で包まれる (和で包むと decal の球が
 *      ホスト全体より大きくなり枝刈りが死ぬ。実測 r=2.892 → 1.906, 体積 0.286倍)
 *   ③ ガードが**保守的である** (実体を球からはみ出させない) こと
 *      — 参照はエンジン (SQM_SDF_DUMP) の内側格子点 14.9万個で外れゼロを確認済み。
 *        ここでは代表点で「球に含まれる」ことを再確認する。
 *   ④ invert の子は候補から外す (intersect(A,invert(B)) = A∖B ⊆ A なので A で包む)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene, serializeScene, sdfToNode } from '../js/model.js';
import { parseAll } from '../js/sexpr.js';
import { buildProgram, nodeSphere } from '../js/codegen.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

/* ── ① デモシーンが扱えるか ─────────────────────────────────────────── */
const src = readFileSync(join(here, '../../scenes/sdf_decal_test.ssq'), 'utf8');
const doc = parseScene(src);
let raw = 0, types = {};
const walk = n => { types[n.type] = (types[n.type] || 0) + 1; if (n.type === 'raw') raw++; (n.children || []).forEach(walk); };
doc.objects.forEach(o => walk(o.root));
ok(raw === 0, 'raw に落ちるノードが無い');
ok(types.onion >= 1 && types.round >= 1 && types.intersect >= 1,
   `decal の3オペが揃う (onion:${types.onion} round:${types.round} intersect:${types.intersect})`);
const frag = buildProgram(doc).frag;
ok(!/raw: 未対応リーフ/.test(frag) && frag.length > 1000, 'GLSL が生成される');
let raw2 = 0;
parseScene(serializeScene(doc, doc.camera)).objects
  .forEach(o => { const w = n => { if (n.type === 'raw') raw2++; (n.children || []).forEach(w); }; w(o.root); });
ok(raw2 === 0, '.ssq へ書き戻して再パースしても raw が出ない');

/* ── ② intersect のガード球は最小の子で包む ─────────────────────────── */
const byName = Object.fromEntries(doc.objects.map(o => [o.name, o]));
const sHost = nodeSphere(byName['host'].root);
const sDecal = nodeSphere(byName['decal'].root);
ok(sHost && sDecal, 'host / decal ともガード球が出る (null = 枝刈り無効)');
ok(sDecal[3] < sHost[3],
   `decal の球がホストより小さい (decal r=${sDecal[3].toFixed(3)} < host r=${sHost[3].toFixed(3)})`);

/* ── ③ 保守性: 実体の代表点が球に含まれる ───────────────────────────── */
/* decal は球 (中心 0,1.02,0 半径 1) の表面 [0.007,0.033] 外側にある薄い殻の一部。
   カッターの中心方向 (azimuth 0/35/65/85 度) の表面点を代表点にする。 */
const R = 1.0, C0 = [0, 1.02, 0];
let outside = 0, worst = 0;
for (const deg of [0, 35, 65, 85]) {
  const th = deg * Math.PI / 180;
  for (const off of [0.007, 0.020, 0.033]) {          /* 殻の内側〜外側 */
    const r = R + off;
    const P = [C0[0] + r * Math.cos(th), C0[1], C0[2] - r * Math.sin(th)];
    const d = Math.hypot(P[0] - sDecal[0], P[1] - sDecal[1], P[2] - sDecal[2]);
    worst = Math.max(worst, d);
    if (d > sDecal[3]) outside++;
  }
}
ok(outside === 0, `実体の代表点 12 個すべてが球内 (最遠 ${worst.toFixed(3)} <= r ${sDecal[3].toFixed(3)})`);

/* ── ④ invert の子は候補にしない ─────────────────────────────────────── */
/* intersect(小さい球, invert(大きい球)) = 小さい球から大きい球を抜いた形 ⊆ 小さい球。
   invert 側を採ってしまうと球が実体を包まない (穴が出る) ので、必ず A 側で包む。 */
const cut = sdfToNode(parseAll(`(intersect
  (sphere (center 0 0 0) (radius 0.5))
  (invert (sphere (center 0 0 0) (radius 3.0))))`)[0]);
const sCut = nodeSphere(cut);
ok(sCut && sCut[3] < 1.5,
   `invert の子を無視して小さい方で包む (r=${sCut ? sCut[3].toFixed(3) : 'null'} < 1.5)`);

console.log(fails ? `\n${fails} 件失敗` : '\nすべて通過');
process.exit(fails ? 1 : 0);
