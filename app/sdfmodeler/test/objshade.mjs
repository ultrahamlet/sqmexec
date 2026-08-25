/* objshade.mjs — mesh(OBJ) のシェーディング (flat / smooth) がエンジンと一致するか。
 *   node test/objshade.mjs
 *
 * 直す前の症状: モデラーは vn を読まず面法線を無条件に加算平均していたので、
 * **常にスムーズに見えるのに sqm でレンダーするとフラット**になっていた。
 * 食い違いは3つ重なっていた:
 *   ① .ssq に (smooth 1) を書き出していない
 *   ② クリース角が無い (エンジンは 60°)
 *   ③ 頂点の共有が「添字」単位 (エンジンは「位置」単位)
 * この3つを固定する。
 *
 * 参照はエンジン dist/obj_loader.cpp:
 *   - (smooth ..) 無し → vn があればそれ / 無ければ面法線 = フラット
 *   - obj_compute_smooth_normals() → 位置で溶接・crease_cos = 0.5 (60°)・
 *     **単位**面法線の和
 * dolphin.obj について sqm は起動時に
 *   "[obj] smooth normals recomputed (1992 unique verts, crease 60°)"
 * と報告する。その 1992 をここで突き合わせる。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseObjText, buildShaded } from '../js/objmesh.js';
import { parseScene, serializeScene } from '../js/model.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

const uniqPos = g => new Set([...Array(g.verts.length / 3).keys()].map(i =>
  [0, 1, 2].map(k => Math.round(g.verts[i * 3 + k] * 1e5)).join(','))).size;
const uniqNrm = g => new Set([...Array(g.normals.length / 3).keys()].map(i =>
  [0, 1, 2].map(k => Math.round(g.normals[i * 3 + k] * 1e3)).join(','))).size;

/* ── 1) 立方体: 90° の稜線は 60° クリースを超えるので smooth でも平滑化されない ── */
{
  const m = parseObjText(readFileSync(join(here, '../../assets/cube.obj'), 'utf8'));
  const fl = buildShaded(m, 'file'), sm = buildShaded(m, 'smooth');
  ok(uniqNrm(fl) === 6, `立方体 flat の法線は6種 (実際 ${uniqNrm(fl)})`);
  ok(uniqNrm(sm) === 6, `立方体 smooth も6種 = クリースが効いている (実際 ${uniqNrm(sm)})`);
  ok(fl.verts.length === sm.verts.length,
     `立方体は smooth にしても頂点数が変わらない (${fl.verts.length / 3})`);
}

/* ── 2) イルカ: 位置での溶接数がエンジンの報告 (1992) と一致するか ── */
{
  const m = parseObjText(readFileSync(join(here, '../../assets/dolphin.obj'), 'utf8'));
  const sm = buildShaded(m, 'smooth');
  ok(uniqPos(sm) === 1992,
     `dolphin smooth の一意な頂点位置 = 1992 (エンジンの報告と一致。実際 ${uniqPos(sm)})`);
  const fl = buildShaded(m, 'file');
  ok(uniqNrm(fl) > uniqNrm(sm),
     `flat の方が法線の種類が多い (${uniqNrm(fl)} > ${uniqNrm(sm)})`);
  ok(sm.verts.length < fl.verts.length,
     `smooth は角が溶接されて頂点が減る (${sm.verts.length / 3} < ${fl.verts.length / 3})`);
  ok(sm.indices.length === m.indices.length && fl.indices.length === m.indices.length,
     '三角形の数と順序は変わらない (group-surface の triGroup が使い回せる)');
}

/* ── 2b) 球: vn の有無で 'file' モードの結果が変わる (vn まかせの分岐) ──
   立方体・イルカはどちらも vn を持たないので、この枝はここでしか通らない。 */
{
  const noVN = parseObjText(readFileSync(join(here, '../../assets/sphere_novn.obj'), 'utf8'));
  const wiVN = parseObjText(readFileSync(join(here, '../../assets/sphere_vn.obj'), 'utf8'));
  ok(!noVN.hasVN, 'sphere_novn.obj は vn を持たない');
  ok(wiVN.hasVN,  'sphere_vn.obj は vn を持つ');

  const a = buildShaded(noVN, 'file'), b = buildShaded(wiVN, 'file');
  /* ⚠ UV 球は頂点ごとに法線が違うので「法線の種類が減る」では smooth を検出できない
     (flat 504 種 → smooth 478 種としか動かない)。効くのは **頂点の重複が畳まれるか**。
     flat は面ごとに角を割るので 478 → 2024 に膨らむ。 */
  ok(a.verts.length / 3 === 2024,
     `vn 無し + file = フラット: 角が面ごとに割れる (478 → ${a.verts.length / 3})`);
  ok(b.verts.length / 3 === 478,
     `vn 有り + file = vn をそのまま使うので分裂しない (${b.verts.length / 3} = 元の頂点数)`);
  ok(uniqNrm(b) < uniqNrm(a), `vn 有りの方が法線の種類が少ない (${uniqNrm(b)} < ${uniqNrm(a)})`);

  /* 球は稜線が 60° 未満なので smooth で全部溶接される (立方体は 90° で1つも溶接されない) */
  const c = buildShaded(noVN, 'smooth');
  ok(c.verts.length / 3 === 478,
     `球は smooth で全部溶接される (${c.verts.length / 3} = 478 = 元の頂点数)`);
  ok(c.verts.length < a.verts.length / 4,
     `smooth は flat の 1/4 未満の頂点数 (${c.verts.length / 3} < ${a.verts.length / 3})`);
}

/* ── 3) .ssq 往復: (smooth 1) を書き出し、読み直して復元し、二重に出さない ── */
{
  const txt = readFileSync(join(here, '../examples/objshade_test.ssq'), 'utf8');
  const doc = parseScene(txt);
  const meshNodes = d => { const out = []; const w = n => { if (!n) return;
      if (n.type === 'mesh') out.push(n); (n.children || []).forEach(w); };
    d.objects.forEach(o => w(o.root)); return out; };

  const before = serializeScene(doc);
  ok(!/\(smooth/.test(before), 'smooth=0 のときは (smooth ..) を書かない');

  meshNodes(doc).forEach(n => n.props.smooth = 1);
  const after = serializeScene(doc);
  ok((after.match(/\(smooth 1\)/g) || []).length === 1, '(smooth 1) をちょうど1回書く');

  const back = meshNodes(parseScene(after));
  ok(back.length === 1 && back[0].props.smooth === 1, '読み直して smooth が復元される');
  ok(back[0].props.extra.every(x => !/smooth/.test(x)),
     'smooth は extra に残らない (残ると次の書き出しで二重になる)');
}

console.log(fails ? `\n${fails} FAILED` : '\nすべて通過');
process.exit(fails ? 1 : 0);
