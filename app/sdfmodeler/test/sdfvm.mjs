/* sdfvm.mjs — 線形化した VM が特化版と同じ距離場を返すか、CPU で突き合わせる。
 *
 * なぜ CPU か: GPU で絵を見比べると「色が違う/床が違う」で本質が埋もれる上、
 * ブラウザペインが非表示だと画素そのものが信用できない (docs 参照)。
 * 距離場は数値なので、同じ点を両方で評価して差を見るのが最短で確実。
 *
 * 参照側 (evalRef) は .ssq のツリーを JS で素直に評価する。codegen の GLSL とは
 * 別実装なので、両者が一致すれば「線形化の順序・mirror の位置・k の割り当て」が
 * 正しいことの独立した確認になる。
 *   - smooth-union は **右 fold** (codegen と同じ)
 *   - mirror はそのノードのローカル系で折る
 *   - object 同士は min
 */
import { parseScene, SCHEMA, eulerToMat } from '../js/model.js';
import { linearize, OP, CB, STRIDE } from '../js/sdfvm.js';
import fs from 'fs';

let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok ' : 'FAIL ') + m); if (!c) fails++; };
const D2R = Math.PI / 180;

/* ── 参照実装 (ツリーをそのまま評価) ───────────────────────── */
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const sUnion = (da, db, k) => {                 /* PRELUDE と同じ差分形 */
  k = Math.max(k, 1e-6);
  const m = Math.min(da, db), e = Math.max(da, db) - m;
  const g = Math.min(Math.max(0.5 - 0.5 * e / k, 0), 0.5);
  return m + g * e - k * g * (1 - g);
};
const sdEllipsoid = (p, r) => {
  const k0 = len([p[0]/r[0], p[1]/r[1], p[2]/r[2]]);
  const k1 = len([p[0]/(r[0]*r[0]), p[1]/(r[1]*r[1]), p[2]/(r[2]*r[2])]);
  return k0 === 0 ? -Math.min(...r) : k0 * (k0 - 1.0) / k1;
};
const sdCapsule = (p, a, b, r) => {
  const pa = sub(p, a), ba = sub(b, a);
  const h = Math.min(Math.max(dot(pa, ba) / dot(ba, ba), 0), 1);
  return len([pa[0]-ba[0]*h, pa[1]-ba[1]*h, pa[2]-ba[2]*h]) - r;
};
const sdTorus = (p, R, r) => Math.hypot(Math.hypot(p[0], p[2]) - R, p[1]) - r;
const sdBox = (p, b) => {
  const q = [Math.abs(p[0])-b[0], Math.abs(p[1])-b[1], Math.abs(p[2])-b[2]];
  const o = len([Math.max(q[0],0), Math.max(q[1],0), Math.max(q[2],0)]);
  return o + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0);
};
const leafDist = (n, p) => {
  const k = n.props;
  switch (n.type) {
    case 'sphere':    return len(sub(p, k.center)) - k.radius;
    case 'ellipsoid': return sdEllipsoid(sub(p, k.center), k.radii);
    case 'box':       return sdBox(sub(p, k.center), k.size);
    case 'torus':     return sdTorus(sub(p, k.center), k.major, k.minor);
    case 'capsule':   return sdCapsule(p, k.a, k.b, k.radius);
    case 'plane': {
      const N = k.normal || [0,1,0], L = len(N);
      return dot(sub(p, k.center), [N[0]/L, N[1]/L, N[2]/L]) - (k.offset || 0);
    }
    default: throw new Error('ref: 未対応 ' + n.type);
  }
};
function evalNode(n, p) {
  if (n.hidden || n.type === 'blob' || n.type === 'mesh') return null;   /* 空集合 */
  const sc = SCHEMA[n.type] || { kind: 'leaf' };
  if (sc.kind === 'leaf') return leafDist(n, p);
  if (n.type === 'translate') return evalNode(n.children[0], sub(p, n.props.t));
  if (n.type === 'rotate') {
    const d = n.props.deg, pv = n.props.pivot || [0,0,0];
    const R = eulerToMat(d[0]*D2R, d[1]*D2R, d[2]*D2R);   /* 行優先 */
    const v = sub(p, pv);                                  /* 逆回転 = 転置を掛ける */
    const q = [R[0]*v[0]+R[3]*v[1]+R[6]*v[2], R[1]*v[0]+R[4]*v[1]+R[7]*v[2],
               R[2]*v[0]+R[5]*v[1]+R[8]*v[2]];
    return evalNode(n.children[0], [q[0]+pv[0], q[1]+pv[1], q[2]+pv[2]]);
  }
  if (n.type === 'mirror') {
    const N = n.props.normal || (n.props.axis === 'x' ? [1,0,0]
              : n.props.axis === 'y' ? [0,1,0] : [0,0,1]);
    const s = dot(p, N) - (n.props.d || 0);
    const q = s > 0 ? [p[0]-2*s*N[0], p[1]-2*s*N[1], p[2]-2*s*N[2]] : p;
    return evalNode(n.children[0], q);
  }
  if (n.type === 'union' || n.type === 'smooth-union') {
    const vals = n.children.map(c => evalNode(c, p)).filter(v => v !== null);
    if (!vals.length) return null;
    if (n.type === 'union') return Math.min(...vals);
    /* 右 fold (codegen と同じ) */
    let acc = vals[vals.length - 1];
    for (let i = vals.length - 2; i >= 0; i--) acc = sUnion(vals[i], acc, Math.max(n.props.k, 1e-6));
    return acc;
  }
  throw new Error('ref: 未対応 ' + n.type);
}
const evalRef = (doc, p, gridOn) => {
  let best = Infinity, any = false;
  for (const o of doc.objects) {
    if (!o.visible) continue;
    let isPlane = false;
    (function chk(n){ if (n.type === 'plane') isPlane = true; (n.children||[]).forEach(chk); })(o.root);
    if (isPlane && !gridOn) continue;
    const v = evalNode(o.root, p);
    if (v !== null) { best = Math.min(best, v); any = true; }
  }
  return any ? best : 1e9;
};

/* ── VM 側 (RPN 命令列を JS で解釈 = GLSL の vmEval と同じ手順) ── */
function evalVm(lin, p, gridOn) {
  const D = lin.data;
  const st = new Array(16).fill(0);
  let sp = 0;
  for (let i = 0; i < lin.count; i++) {
    const b = i * STRIDE;
    const cb = D[b + 45] | 0, k = D[b + 46];
    if (cb >= CB.combMin) {                       /* リーフ無しの合成 */
      const a = st[sp - 1]; sp--;
      st[sp - 1] = (cb === CB.combMin) ? Math.min(a, st[sp - 1]) : sUnion(a, st[sp - 1], k);
      continue;
    }
    let d;
    if (D[b + 56] > 0.5 && !gridOn) d = 1e9;      /* 床はグリッド連動 (min なので安全) */
    else {
      const nf = D[b + 47] | 0;
      const ap = (base, q) => {
        const o = [0, 0, 0];
        for (let r = 0; r < 3; r++)
          o[r] = D[b+base+r*4]*q[0] + D[b+base+r*4+1]*q[1] + D[b+base+r*4+2]*q[2] + D[b+base+r*4+3];
        return o;
      };
      const fold = (q, off) => {
        const N = [D[b+off], D[b+off+1], D[b+off+2]], dd = D[b+off+3];
        const t = dot(q, N) - dd;
        return t > 0 ? [q[0]-2*t*N[0], q[1]-2*t*N[1], q[2]-2*t*N[2]] : q;
      };
      let q = ap(0, p);
      if (nf > 0) { q = fold(q, 36); q = ap(12, q); }
      if (nf > 1) { q = fold(q, 40); q = ap(24, q); }
      const a0 = [D[b+48], D[b+49], D[b+50], D[b+51]], a1 = [D[b+52], D[b+53], D[b+54], D[b+55]];
      const op = D[b + 44] | 0;
      if (op === OP.sphere)         d = len(sub(q, a0)) - a0[3];
      else if (op === OP.ellipsoid) d = sdEllipsoid(sub(q, a0), a1);
      else if (op === OP.box)       d = sdBox(sub(q, a0), a1);
      else if (op === OP.torus)     d = sdTorus(sub(q, a0), a1[0], a1[1]);
      else if (op === OP.capsule)   d = sdCapsule(q, a0, a1, a1[3]);
      else { const L = len(a1); d = dot(sub(q, a0), [a1[0]/L, a1[1]/L, a1[2]/L]) - a1[3]; }
    }
    if (cb === CB.push) { st[sp] = d; sp++; }
    else st[sp - 1] = (cb === CB.fuseMin) ? Math.min(d, st[sp - 1]) : sUnion(d, st[sp - 1], k);
  }
  return sp > 0 ? st[sp - 1] : 1e9;
}

/* ── 突き合わせ ───────────────────────────────────────────── */
const mkRnd = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
/* 参照実装 (evalRef) が持つプリミティブに限って突き合わせる。
   VM が対応を増やしても、参照が知らないリーフのシーンは静かに飛ばす
   (「参照が無いのに一致した」と誤解しないため、飛ばした数を最後に出す)。 */
let skipped = 0;
/* ⚠ human.ssq (素の capsule) は 2026-08-25 に examples から削除された。
   humanbody.ssq は round-cone-ab を使っており evalRef が非対応なので、
   同規模の関節リグとして dog.ssq (28ノード) に差し替えてある。 */
for (const name of ['rabbit', 'dog', 'bear', 'arm']) {
  const doc = parseScene(fs.readFileSync(new URL('../examples/' + name + '.ssq', import.meta.url), 'utf8'));
  const lin = linearize(doc);
  if (!lin.ok) { ok(false, name + ': 線形化できない (' + lin.reason + ')'); continue; }
  for (const gridOn of [true, false]) {
    let worst = 0, at = null;
    const rnd = mkRnd(7);
    for (let i = 0; i < 4000; i++) {
      const p = [(rnd()-0.5)*12, rnd()*8 - 1, (rnd()-0.5)*12];
      const a = evalRef(doc, p, gridOn), b = evalVm(lin, p, gridOn);
      const d = Math.abs(a - b);
      if (d > worst) { worst = d; at = p; }
    }
    ok(worst < 1e-5, name + ' (grid ' + (gridOn ? 'ON' : 'OFF') + ') 参照と一致: ' +
       lin.count + ' ノード / 4000 点 最大差 ' + worst.toExponential(2) +
       (worst >= 1e-5 && at ? ' @ ' + at.map(x => x.toFixed(2)) : ''));
  }
}

/* 非表示ノードが空集合として扱われるか (番兵を算術に流さない設計の確認) */
{
  const doc = parseScene(fs.readFileSync(new URL('../examples/rabbit.ssq', import.meta.url), 'utf8'));
  const hideFirstLeaf = (o) => { let done = false;
    (function w(n){ if (done) return; if (!n.children || !n.children.length) { n.hidden = true; done = true; }
      (n.children||[]).forEach(w); })(o.root); };
  doc.objects.forEach(hideFirstLeaf);
  const lin = linearize(doc);
  if (lin.ok) {
    let worst = 0; const rnd = mkRnd(11);
    for (let i = 0; i < 2000; i++) {
      const p = [(rnd()-0.5)*12, rnd()*8 - 1, (rnd()-0.5)*12];
      worst = Math.max(worst, Math.abs(evalRef(doc, p, true) - evalVm(lin, p, true)));
    }
    ok(worst < 1e-5, '非表示リーフ込みでも一致 (最大差 ' + worst.toExponential(2) + ')');
    ok(Number.isFinite(evalVm(lin, [0, 100, 0], true)) && evalVm(lin, [0, 100, 0], true) < 1e8,
       '遠方でも番兵が漏れない: ' + evalVm(lin, [0, 100, 0], true).toFixed(2));
  } else ok(false, '非表示込みで線形化できない: ' + lin.reason);
}

/* 未対応構成は必ず ok:false を返すこと (呼び側が特化パスへ落ちられるように)。
   ⚠ VM が対応を増やしたらここも入れ替える — 「弾くはずが通った」は
   フォールバックが効かず**黙って別の絵になる**ので、通ってしまう方が危険。 */
for (const [name, why] of [['ancient_jar', 'lathe'], ['ant', 'sweep'], ['frog', 'smooth-subtract'],
                           ['trex', 'round-cone-ab'], ['leaf', 'superquad']]) {
  const doc = parseScene(fs.readFileSync(new URL('../examples/' + name + '.ssq', import.meta.url), 'utf8'));
  const lin = linearize(doc);
  ok(!lin.ok, name + ' (' + why + ') は未対応として弾く' + (lin.ok ? ' ★通ってしまった' : ': ' + lin.reason));
}

console.log(fails ? '\n' + fails + ' 件失敗' : '\n全テスト成功');
process.exit(fails ? 1 : 0);
