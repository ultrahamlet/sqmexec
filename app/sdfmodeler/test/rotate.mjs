/* rotate.mjs — 回転ギズモ数学の検証。
 *   node test/rotate.mjs
 * 核: ワールド軸 n・角 φ のリングドラッグ = S_new = R(nローカル化, φ)·S_old の合成が、
 * 子のワールド位置を「ワールドの pivot を中心に軸角回転した位置」にちょうど写すこと。 */
import { makeNode, eulerToMat, matToEulerDeg } from '../js/model.js';
import {
  worldAnchor, worldPoint, localAnchor, worldToLocalDelta, matmul3, axisAngleMat,
} from '../js/anchor.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-9) =>
  a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const mvec = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const D2R = Math.PI / 180;

/* 1. axisAngleMat 基本: Y軸90° は eulerToMat(0,90,0) と同じ幾何 (x→-z) */
{
  const R = axisAngleMat([0, 1, 0], Math.PI / 2);
  ok(near(mvec(R, [1, 0, 0]), [0, 0, -1], 1e-12), 'axisAngleMat(Y,90°): x→-z');
  ok(near(R, eulerToMat(0, Math.PI / 2, 0), 1e-12), 'axisAngleMat(Y) = eulerToMat(0,ry,0)');
}

/* app.js gizmoRotMove と同じ合成を行うヘルパ */
function composeRotate(root, tgt, axisWorld, ang) {
  const axisL = worldToLocalDelta(root, tgt.id, axisWorld);
  const p = tgt.props;
  const S0 = tgt.type === 'rotate-mat'
    ? [p.m0, p.m1, p.m2, p.m3, p.m4, p.m5, p.m6, p.m7, p.m8]
    : eulerToMat(p.deg[0] * D2R, p.deg[1] * D2R, p.deg[2] * D2R);
  const S = matmul3(axisAngleMat(axisL, ang), S0);
  if (tgt.type === 'rotate-mat') for (let i = 0; i < 9; i++) p['m' + i] = S[i];
  else {
    const e = matToEulerDeg(S);
    if (!e) return false;
    p.deg = e;
  }
  return true;
}

/* 2. 核: 回転祖先チェーン下の rotate ノードへワールド軸回転を合成 →
      子アンカーのワールド位置が「ワールド pivot 中心の軸角回転」に一致 */
{
  const s = makeNode('box', { center: [0.7, 0.9, -0.4], size: [0.3, 0.5, 0.2] });
  const rt = makeNode('rotate', { deg: [10, 20, 30], pivot: [0.2, 0.4, -0.1] }, [s]);
  const t1 = makeNode('translate', { t: [0.5, 1.0, 0] }, [rt]);
  const r1 = makeNode('rotate', { deg: [31, 47, 13], pivot: [0.3, -0.2, 0.5] }, [t1]);
  const root = makeNode('smooth-union', { k: 0.2 }, [r1]);

  const axisW = [1 / 3, 2 / 3, -2 / 3];   /* 単位ベクトル */
  const ang = 0.7;
  const before = worldAnchor(root, s.id);
  const pivW = worldPoint(root, rt.id, rt.props.pivot);
  ok(composeRotate(root, rt, axisW, ang), 'Euler 逆分解が成功');
  const after = worldAnchor(root, s.id);

  const Rw = axisAngleMat(axisW, ang);
  const rel = [before[0] - pivW[0], before[1] - pivW[1], before[2] - pivW[2]];
  const rr = mvec(Rw, rel);
  const expected = [pivW[0] + rr[0], pivW[1] + rr[1], pivW[2] + rr[2]];
  ok(near(after, expected, 1e-9), `回転チェーン下の合成が正しいワールド軸角回転 (Δ=${
    after.map((v, i) => (v - expected[i]).toExponential(1)).join(',')})`);
}

/* 3. rotate-mat ターゲットでも同じ合成が成立 (m0..m8 直接書き戻し) */
{
  const E = eulerToMat(0.3, -0.8, 1.1);
  const s = makeNode('box', { center: [1, 0.5, 0], size: [0.2, 0.2, 0.2] });
  const rm = makeNode('rotate-mat', {
    m0: E[0], m1: E[1], m2: E[2], m3: E[3], m4: E[4], m5: E[5], m6: E[6], m7: E[7], m8: E[8],
    pivot: [0.5, 0, 0],
  }, [s]);
  const r1 = makeNode('rotate', { deg: [-25, 62, 8], pivot: [1, 2, 3] }, [rm]);
  const root = makeNode('union', {}, [r1]);

  const axisW = [0, 0, 1], ang = -1.2;
  const before = worldAnchor(root, s.id);
  const pivW = worldPoint(root, rm.id, rm.props.pivot);
  composeRotate(root, rm, axisW, ang);
  const after = worldAnchor(root, s.id);
  const Rw = axisAngleMat(axisW, ang);
  const rel = [before[0] - pivW[0], before[1] - pivW[1], before[2] - pivW[2]];
  const rr = mvec(Rw, rel);
  ok(near(after, [pivW[0] + rr[0], pivW[1] + rr[1], pivW[2] + rr[2]], 1e-9),
     'rotate-mat ターゲットの合成も一致');
}

/* 4. ラップケース: pivot = 自身のアンカー → 回転してもアンカーは不動点 */
{
  const c = makeNode('capsule', { a: [0.5, 0, 0], b: [0.5, 1.4, 0], radius: 0.3 });
  const root = makeNode('smooth-union', { k: 0.15 }, [c]);
  const pivot = localAnchor(c);
  ok(near(pivot, [0.5, 0.7, 0]), 'localAnchor = a/b 中点');
  const w = makeNode('rotate', { deg: [0, 0, 0], pivot }, [c]);
  root.children[0] = w;
  const before = worldAnchor(root, c.id);
  composeRotate(root, w, [1, 0, 0], 1.0);
  const after = worldAnchor(root, c.id);
  ok(near(after, before, 1e-9), 'pivot=アンカーの回転でアンカー不動');
}

/* 5. 連続合成 (ドラッグを繰り返す) しても直交性が保たれる */
{
  const s = makeNode('box', { center: [1, 0, 0], size: [0.2, 0.2, 0.2] });
  const rt = makeNode('rotate', { deg: [0, 0, 0], pivot: [0, 0, 0] }, [s]);
  const root = makeNode('union', {}, [rt]);
  let allOk = true;
  for (let i = 0; i < 200; i++) {
    if (!composeRotate(root, rt, [Math.sin(i), Math.cos(i * 0.7), 0.5], 0.3)) { allOk = false; break; }
  }
  const S = eulerToMat(rt.props.deg[0] * D2R, rt.props.deg[1] * D2R, rt.props.deg[2] * D2R);
  const det = S[0] * (S[4] * S[8] - S[5] * S[7]) - S[1] * (S[3] * S[8] - S[5] * S[6]) + S[2] * (S[3] * S[7] - S[4] * S[6]);
  ok(allOk && Math.abs(det - 1) < 1e-9, `200回合成後も det=1 (det=${det.toFixed(12)})`);
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
