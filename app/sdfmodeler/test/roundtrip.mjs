/* roundtrip.mjs — node で実行するラウンドトリップ検証。
 *   node test/roundtrip.mjs
 * frog.ssq → モデル → .ssq 書き出し → 再パース → 構造/数値一致を確認。
 * さらに codegen がシェーダ文字列を生成できることを smoke テスト。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene, serializeScene } from '../js/model.js';
import { buildProgram, collectParams } from '../js/codegen.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../examples/frog.ssq'), 'utf8');

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};

/* ノードを比較用の正規形に (id/name を除去) */
function canon(n) {
  const props = {};
  for (const k of Object.keys(n.props)) {
    const v = n.props[k];
    props[k] = Array.isArray(v) ? v.map(x => +(+x).toPrecision(5)) : (typeof v === 'number' ? +v.toPrecision(5) : v);
  }
  return { type: n.type, props, children: n.children.map(canon) };
}
function countNodes(n) { return 1 + n.children.reduce((s, c) => s + countNodes(c), 0); }

const doc1 = parseScene(src);
ok(doc1.objects.length === 2, `オブジェクト数 = ${doc1.objects.length} (期待 2: water, frog)`);
const frog = doc1.objects.find(o => o.name === 'frog');
ok(!!frog, 'frog オブジェクトあり');
const n1 = countNodes(frog.root);
ok(n1 > 30, `frog ノード数 = ${n1}`);
const rawCount = JSON.stringify(canon(frog.root)).split('"raw"').length - 1;
ok(rawCount === 0, `raw(未対応) ノード数 = ${rawCount} (期待 0)`);

const out1 = serializeScene(doc1, doc1.camera);
const doc2 = parseScene(out1);
const out2 = serializeScene(doc2, doc2.camera);
ok(out1 === out2, '書き出しの固定点 (export→import→export が一致)');
ok(JSON.stringify(doc1.objects.map(o => canon(o.root))) ===
   JSON.stringify(doc2.objects.map(o => canon(o.root))), 'ツリー構造・数値のラウンドトリップ一致');

/* rotate-mat が Euler rotate に復元されていること (frog は全て直交行列) */
const hasRotMat = JSON.stringify(canon(frog.root)).includes('"rotate-mat"');
ok(!hasRotMat, 'rotate-mat は全て rotate(deg) に復元');

/* codegen smoke */
const prog = buildProgram(doc1);
ok(prog.frag.includes('void main()'), `シェーダ生成 (${prog.frag.length} chars, uPar[${prog.layout.parCount}])`);
const pars = collectParams(doc1, prog.layout);
ok(pars.length === prog.layout.parCount, `パラメータ配列長 = ${pars.length}`);
ok([...pars].every(v => isFinite(v)), 'パラメータ全て有限値');

/* ── sweep リーフのラウンドトリップ ── */
{
  const src3 = `(scene (object "tube" (surface (color 0.5 0.6 0.7))
    (sdf (union
      (sweep (spline -0.7 0.1 0  -0.2 0.5 0.7  0.4 1.1 0.1) (radii 0.2 0.15 0.1) (steps 10))
      (sweep (points 1 0.2 0  1 1.2 0  2 1.2 0) (radius 0.12))
      (sweep (spline 3 0.5 0  3.6 1.1 0.5  4.2 0.5 0  3.6 0.35 -0.5) (radius 0.1) (closed) (steps 12))))))`;
  const d1 = parseScene(src3);
  const root = d1.objects[0].root;
  ok(root.children.length === 3 && root.children.every(c => c.type === 'sweep'),
     'sweep×3 をパース (raw に落ちない)');
  ok(root.children[0].props.curve === 1 && root.children[0].props.radii.length === 3,
     'spline/radii を保持');
  ok(root.children[2].props.closed === 1, 'closed を保持');
  const o1 = serializeScene(d1, d1.camera);
  const d2 = parseScene(o1);
  ok(JSON.stringify(d1.objects.map(o => canon(o.root))) ===
     JSON.stringify(d2.objects.map(o => canon(o.root))), 'sweep ラウンドトリップ一致');
  const pr = buildProgram(d1);
  ok(pr.frag.includes('sdSweepSeg'), 'sweep GLSL 生成');
  const ps = collectParams(d1, pr.layout);
  ok(ps.length === pr.layout.parCount && [...ps].every(v => isFinite(v)),
     `sweep パラメータ有限 (uPar[${pr.layout.parCount}])`);
}

/* ── sweep 任意断面 (Phase 2) を一級ノードで取り込み+ラウンドトリップ ── */
{
  const src4 = `(scene (object "p2" (surface (color 0.5 0.6 0.7))
    (sdf (union
      (sweep (spline 0 0 0  1 1 0  2 0 0) (profile -0.1 -0.1  0.1 -0.1  0.1 0.1  -0.1 0.1) (steps 10))
      (sweep (points 3 0 0  3 2 0) (profile-bspline -0.2 -0.2  0.2 -0.2  0.2 0.2  -0.2 0.2) (profile-steps 6) (twist 360))))))`;
  const d1 = parseScene(src4);
  const kids = d1.objects[0].root.children;
  ok(kids.length === 2 && kids.every(c => c.type === 'sweep'),
     'profile付きsweepは一級ノードに取り込む (raw に落とさない)');
  ok(kids[0].props.profile.length === 4 && kids[0].props.profileCurve === 0,
     'profile 点列/種別を保持');
  ok(kids[1].props.profileCurve === 2 && Math.abs(kids[1].props.twist - 360) < 1e-9 && kids[1].props.profileSteps === 6,
     'profile-bspline/twist/profile-steps を保持');
  const o1 = serializeScene(d1, d1.camera);
  ok(o1.includes('profile ') && o1.includes('profile-bspline') && o1.includes('twist'),
     '書き出しに profile/profile-bspline/twist が出る');
  const d2 = parseScene(o1);
  ok(JSON.stringify(d1.objects.map(o => canon(o.root))) ===
     JSON.stringify(d2.objects.map(o => canon(o.root))), 'Phase2 一級 ラウンドトリップ一致');
  /* codegen: profile sweep は正確モード (sdSweepProfSeg) で GLSL 生成される */
  const callRe = /sdSweepProfSeg\(p/;   /* 定義は PRELUDE に常在 → 呼び出しの有無で判定 */
  const pr = buildProgram(d1);
  ok(callRe.test(pr.frag), 'profile sweep は正確モードで GLSL 生成 (呼び出しあり)');
  const pars = [...collectParams(d1, pr.layout)];
  ok(pars.length === pr.layout.parCount && pars.every(v => isFinite(v)),
     `正確モードのパラメータ有限 (uPar[${pr.layout.parCount}])`);
  /* 近似モード (ドラッグ中の降格): レイアウトが小さくなり sdSweepSeg (円形) に落ちる */
  const pa = buildProgram(d1, null, { sweepApprox: true });
  ok(!callRe.test(pa.frag) && pa.layout.parCount < pr.layout.parCount &&
     [...collectParams(d1, pa.layout)].every(v => isFinite(v)),
     `近似モード降格 (uPar ${pr.layout.parCount}→${pa.layout.parCount})`);
  /* twist 付きは自動細分でセグメント数が増える */
  const tw = d1.objects[0].root.children[1];
  ok(tw.props.twist === 360, 'twist ノード確認');
}

/* ── lathe 回転体を一級ノードで取り込み+ラウンドトリップ ── */
{
  const src5 = `(scene (object "pots" (surface (color 0.6 0.5 0.4))
    (sdf (union
      (lathe (center -1 0 0) (spline 0 0  0.45 0  0.5 0.15  0.32 0.45  0.12 1.25  0 1.25))
      (lathe (center 1 0 0) (axis 0.4) (thick 0.05) (steps 20) (profile -0.16 -0.16  0.16 -0.16  0.16 0.16  -0.16 0.16))))))`;
  const d1 = parseScene(src5);
  const kids = d1.objects[0].root.children;
  ok(kids.length === 2 && kids.every(c => c.type === 'lathe'),
     'lathe を一級ノードに取り込む (raw に落とさない)');
  ok(kids[0].props.curve === 1 && kids[0].props.prof.length === 6, 'spline輪郭/点数を保持');
  ok(Math.abs(kids[1].props.axis - 0.4) < 1e-9 && Math.abs(kids[1].props.thick - 0.05) < 1e-9 && kids[1].props.steps === 20,
     'axis/thick/steps を保持');
  const o1 = serializeScene(d1, d1.camera);
  ok(o1.includes('lathe') && o1.includes('axis') && o1.includes('thick') && o1.includes('spline'),
     '書き出しに lathe/axis/thick/spline が出る');
  const d2 = parseScene(o1);
  ok(JSON.stringify(d1.objects.map(o => canon(o.root))) ===
     JSON.stringify(d2.objects.map(o => canon(o.root))), 'lathe ラウンドトリップ一致');
  const pr = buildProgram(d1);
  ok(pr.frag.includes('sdLatheShell') && /sdPolyUV\(/.test(pr.frag),
     'lathe GLSL (ソリッド=sdPolyUV / シェル=sdLatheShell) 生成');
  ok([...collectParams(d1, pr.layout)].every(v => isFinite(v)), 'lathe パラメータ有限');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
