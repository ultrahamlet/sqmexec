/* codegen.js — ノードツリー → WebGL2 フラグメントシェーダ生成。
 * 距離関数・CSG・変換は sqm/dist/sdf.cpp と同一式 (プレビュー = 本レンダの近似一致)。
 * 数値パラメータは全て uniform float uPar[] に載せ、値変更は再コンパイル不要。 */
import { SCHEMA, eulerToMat, surfaceColor } from './model.js';

const D2R = Math.PI / 180;

/* ── sweep の焼き込み (sqm sexp_input.cpp のパース時ベイクの JS ミラー) ──────────
   spline 密化は spline_densify と同式。点座標の編集は uniform 更新のみで済むが、
   点数/steps/curve/closed/profile の変更はスロット数が変わる = 構造変更 (シェーダ再構築)。 */

/* 汎用スプライン密化 (stride=dim)。closed=1 でループ (末尾点を付加しない) */
function densifyN(cp, n, steps, closed, bsp, dim) {
  const nseg = closed ? n : n - 1;
  const o = [];
  for (let i = 0; i < nseg; i++) {
    let i0, i1, i2, i3;
    if (closed) { i0 = (i - 1 + n) % n; i1 = i; i2 = (i + 1) % n; i3 = (i + 2) % n; }
    else { i0 = Math.max(0, i - 1); i1 = i; i2 = Math.min(n - 1, i + 1); i3 = Math.min(n - 1, i + 2); }
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < dim; c++) {
        const p0 = cp[dim * i0 + c], p1 = cp[dim * i1 + c], p2 = cp[dim * i2 + c], p3 = cp[dim * i3 + c];
        if (bsp) {
          const b0 = (-t3 + 3 * t2 - 3 * t + 1) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6;
          const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6;
          o.push(b0 * p0 + b1 * p1 + b2 * p2 + b3 * p3);
        } else {
          o.push(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
        }
      }
    }
  }
  if (!closed) for (let c = 0; c < dim; c++) o.push(cp[dim * (n - 1) + c]);   /* 末尾点 */
  return o;
}

/* 経路 (x,y,z,s)*n の密化。radiusMul = 半径列の一括倍率 (近似チューブの外接半径掛け用) */
function bakePath(p, radiusMul) {
  const n = Math.floor((p.points ? p.points.length : 0) / 3);
  const cp = [];
  for (let q = 0; q < n; q++)
    cp.push(p.points[3 * q], p.points[3 * q + 1], p.points[3 * q + 2],
            (p.radii[q] ?? p.radii[p.radii.length - 1] ?? 0.15) * radiusMul);
  const steps = effSteps(p.steps, 12);
  const closed = p.closed ? 1 : 0;
  if (!(p.curve >= 1) || n < 3) return { pts: cp, n, closed };
  const o = densifyN(cp, n, steps, closed, p.curve === 2, 4);
  return { pts: o, n: o.length / 4, closed };
}

/* 断面の外接半径 (プレビュー近似チューブと包絡半径に使う) */
function profileRmax(p) {
  let pr = 0;
  for (const q of p.profile) pr = Math.max(pr, Math.hypot(q[0], q[1]));
  return pr < 1e-6 ? 1e-6 : pr;
}

/* 近似モード (円形 / 断面付きは外接半径のチューブ)。従来の sweepBaked と同じ出力 */
export function sweepBaked(p) {
  const pr = (p.profile && p.profile.length >= 3) ? profileRmax(p) : 1;
  return bakePath(p, pr);
}

/* ── 正確モード (任意断面, Phase 2): エンジンと同じ RMF/twist細分/マイタpad/fac を焼く ──
   返り値の uniform レイアウト順: path(4n) → frames N(3n) → pads(n) → fac(nseg) → poly(2m)。
   sd_sweep_prof_chunk (dist/sdf.cpp) の評価と同じデータ。 */
export function sweepProfBaked(p) {
  const bk = bakePath(p, 1);
  let path = bk.pts.slice(), n = bk.n;
  const closed = bk.closed;
  const twr = (p.twist || 0) * D2R;
  /* (twists ..) = 点毎ねじり (2026-07-29)。経路と同じパラメータで密化したいので、
     半径チャンネルにねじり角を載せた bakePath をもう一度呼んで拾う
     (エンジンは dim=1 の spline_densify を別に通している。結果は同じ)。 */
  let tws = null;
  if (p.twists && p.twists.length) {
    const npc = Math.floor((p.points ? p.points.length : 0) / 3);
    const pad = [];
    for (let q = 0; q < npc; q++) pad.push(p.twists[q] ?? p.twists[p.twists.length - 1] ?? 0);
    const bkT = bakePath({ ...p, radii: pad }, 1);
    tws = []; for (let i = 0; i < bkT.n; i++) tws.push(bkT.pts[4 * i + 3]);
    if (tws.length !== n) tws = null;   /* 念のため (起きない想定) */
  }
  /* twist 自動細分: 1セグ 9° 以下 (エンジンと同じ) */
  if ((Math.abs(p.twist || 0) > 1e-9 || tws) && n >= 2) {
    const nseg0 = closed ? n : n - 1;
    let total0 = 0;
    const segL = [];
    for (let i = 0; i < nseg0; i++) {
      const ib = (i + 1) % n;
      const L = Math.hypot(path[4 * ib] - path[4 * i], path[4 * ib + 1] - path[4 * i + 1], path[4 * ib + 2] - path[4 * i + 2]);
      segL.push(L); total0 += L;
    }
    if (total0 > 1e-9) {
      const o = [], ot = tws ? [] : null;
      for (let i = 0; i < nseg0; i++) {
        const ib = (i + 1) % n;
        const segtw = tws ? Math.abs(tws[ib] - tws[i]) : Math.abs(p.twist) * segL[i] / total0;
        const k = Math.floor(segtw / 9) + 1;
        for (let j = 0; j < k; j++) {
          const t = j / k;
          for (let c = 0; c < 4; c++) o.push(path[4 * i + c] + (path[4 * ib + c] - path[4 * i + c]) * t);
          if (ot) ot.push(tws[i] + (tws[ib] - tws[i]) * t);
        }
      }
      if (!closed) {
        for (let c = 0; c < 4; c++) o.push(path[4 * (n - 1) + c]);
        if (ot) ot.push(tws[n - 1]);
      }
      path = o; n = o.length / 4;
      if (ot) tws = ot;
    }
  }
  const nseg = closed ? n : n - 1;
  /* 断面の密化 (常に閉) */
  let poly = p.profile.flatMap(q => [q[0], q[1]]);
  let m = p.profile.length;
  if (p.profileCurve >= 1 && m >= 3) {
    const st = Math.max(2, Math.round(p.profileSteps || 8));
    poly = densifyN(poly, m, st, 1, p.profileCurve === 2, 2);
    m = poly.length / 2;
  }
  const rmax = profileRmax(p);
  /* 点毎タンジェント (隣接平均) */
  const tg = new Array(3 * n);
  for (let i = 0; i < n; i++) {
    const ia = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const ib = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    let dx = path[4 * ib] - path[4 * ia], dy = path[4 * ib + 1] - path[4 * ia + 1], dz = path[4 * ib + 2] - path[4 * ia + 2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-12) { dx = 0; dy = 1; dz = 0; }
    else { dx /= L; dy /= L; dz /= L; }
    tg[3 * i] = dx; tg[3 * i + 1] = dy; tg[3 * i + 2] = dz;
  }
  /* RMF (double reflection) */
  const frames = new Array(3 * n);
  {
    const ax = Math.abs(tg[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const d0 = ax[0] * tg[0] + ax[1] * tg[1] + ax[2] * tg[2];
    let nx = ax[0] - tg[0] * d0, ny = ax[1] - tg[1] * d0, nz = ax[2] - tg[2] * d0;
    const nl = Math.hypot(nx, ny, nz) || 1;
    frames[0] = nx / nl; frames[1] = ny / nl; frames[2] = nz / nl;
  }
  const transport = (x0, t0, r0, x1, t1) => {   /* 1ステップの double reflection */
    const v1 = [x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]];
    const c1 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
    let rl, tl;
    if (c1 < 1e-16) { rl = r0.slice(); tl = t0.slice(); }
    else {
      const dr = (v1[0] * r0[0] + v1[1] * r0[1] + v1[2] * r0[2]) * 2 / c1;
      const dt = (v1[0] * t0[0] + v1[1] * t0[1] + v1[2] * t0[2]) * 2 / c1;
      rl = [r0[0] - v1[0] * dr, r0[1] - v1[1] * dr, r0[2] - v1[2] * dr];
      tl = [t0[0] - v1[0] * dt, t0[1] - v1[1] * dt, t0[2] - v1[2] * dt];
    }
    const v2 = [t1[0] - tl[0], t1[1] - tl[1], t1[2] - tl[2]];
    const c2 = v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2];
    let rn;
    if (c2 < 1e-16) rn = rl;
    else {
      const dr2 = (v2[0] * rl[0] + v2[1] * rl[1] + v2[2] * rl[2]) * 2 / c2;
      rn = [rl[0] - v2[0] * dr2, rl[1] - v2[1] * dr2, rl[2] - v2[2] * dr2];
    }
    const dt1 = rn[0] * t1[0] + rn[1] * t1[1] + rn[2] * t1[2];
    rn = [rn[0] - t1[0] * dt1, rn[1] - t1[1] * dt1, rn[2] - t1[2] * dt1];
    const nl = Math.hypot(rn[0], rn[1], rn[2]);
    return nl < 1e-12 ? r0.slice() : [rn[0] / nl, rn[1] / nl, rn[2] / nl];
  };
  const pt = i => [path[4 * i], path[4 * i + 1], path[4 * i + 2]];
  const tgv = i => [tg[3 * i], tg[3 * i + 1], tg[3 * i + 2]];
  for (let i = 1; i < n; i++) {
    const r = transport(pt(i - 1), tgv(i - 1), [frames[3 * (i - 1)], frames[3 * (i - 1) + 1], frames[3 * (i - 1) + 2]], pt(i), tgv(i));
    frames[3 * i] = r[0]; frames[3 * i + 1] = r[1]; frames[3 * i + 2] = r[2];
  }
  /* 弧長 */
  const arc = [0];
  for (let i = 1; i <= nseg; i++) {
    const ib = i % n;
    arc.push(arc[i - 1] + Math.hypot(path[4 * ib] - path[4 * (i - 1)], path[4 * ib + 1] - path[4 * (i - 1) + 1], path[4 * ib + 2] - path[4 * (i - 1) + 2]));
  }
  const arct = arc[nseg] > 1e-12 ? arc[nseg] : 1;
  /* 閉ループのホロノミー角 */
  let hol = 0;
  if (closed) {
    const rw = transport(pt(n - 1), tgv(n - 1), [frames[3 * (n - 1)], frames[3 * (n - 1) + 1], frames[3 * (n - 1) + 2]], pt(0), tgv(0));
    const r0 = [frames[0], frames[1], frames[2]], t0 = tgv(0);
    const cr = [r0[1] * rw[2] - r0[2] * rw[1], r0[2] * rw[0] - r0[0] * rw[2], r0[0] * rw[1] - r0[1] * rw[0]];
    hol = Math.atan2(cr[0] * t0[0] + cr[1] * t0[1] + cr[2] * t0[2], r0[0] * rw[0] + r0[1] * rw[1] + r0[2] * rw[2]);
  }
  /* twist + ホロノミー補正 (Rodrigues) */
  for (let i = 0; i < n; i++) {
    const u = arc[Math.min(i, nseg)] / arct;
    const a = tws ? (tws[i] * D2R - hol * u) : (twr - hol) * u;
    if (Math.abs(a) < 1e-12) continue;
    const axv = tgv(i), v = [frames[3 * i], frames[3 * i + 1], frames[3 * i + 2]];
    const c = Math.cos(a), s = Math.sin(a);
    const d = axv[0] * v[0] + axv[1] * v[1] + axv[2] * v[2];
    const cr = [axv[1] * v[2] - axv[2] * v[1], axv[2] * v[0] - axv[0] * v[2], axv[0] * v[1] - axv[1] * v[0]];
    for (let k = 0; k < 3; k++) frames[3 * i + k] = v[k] * c + cr[k] * s + axv[k] * d * (1 - c);
  }
  /* マイタ pad (関節毎) */
  const pads = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const hasA = closed || i > 0, hasB = closed || i < n - 1;
    if (!hasA || !hasB) continue;
    const ia = (i - 1 + n) % n, ib = (i + 1) % n;
    const d1 = [path[4 * i] - path[4 * ia], path[4 * i + 1] - path[4 * ia + 1], path[4 * i + 2] - path[4 * ia + 2]];
    const d2 = [path[4 * ib] - path[4 * i], path[4 * ib + 1] - path[4 * i + 1], path[4 * ib + 2] - path[4 * i + 2]];
    const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
    if (l1 < 1e-12 || l2 < 1e-12) continue;
    let cth = (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (l1 * l2);
    cth = Math.min(1, Math.max(-1, cth));
    const tn = Math.min(2, Math.tan(Math.acos(cth) * 0.5));
    pads[i] = tn * rmax * path[4 * i + 3];
  }
  /* fac (セグメント毎保守係数) */
  const fac = new Array(nseg).fill(1);
  for (let i = 0; i < nseg; i++) {
    const ib = (i + 1) % n;
    const L = arc[i + 1] - arc[i];
    if (L < 1e-12) continue;
    const dN = Math.hypot(frames[3 * ib] - frames[3 * i], frames[3 * ib + 1] - frames[3 * i + 1], frames[3 * ib + 2] - frames[3 * i + 2]);
    const dT = Math.hypot(tg[3 * ib] - tg[3 * i], tg[3 * ib + 1] - tg[3 * i + 1], tg[3 * ib + 2] - tg[3 * i + 2]);
    const smax = Math.max(path[4 * i + 3], path[4 * ib + 3]);
    const slack = (dN + dT) * smax * rmax + Math.abs(path[4 * ib + 3] - path[4 * i + 3]) * rmax;
    fac[i] = L / Math.sqrt(L * L + slack * slack);
  }
  return { path, frames, pads, fac, poly, n, nseg, m, closed,
           slots: 4 * n + 3 * n + n + nseg + 2 * m };
}
function isProfileSweep(p) { return !!(p.profile && p.profile.length >= 3); }

/* lathe 輪郭の密化 (r,y)。closed = ソリッド(thick<=0)は閉ポリゴン, シェル(thick>0)は開折れ線 —
   エンジン sexp_input.cpp の spline_densify(closed=thick<=0) と一致。返り: (r,y) の平坦配列 */
export function latheBaked(p) {
  const solid = !(p.thick > 0);
  const cp = p.prof.flatMap(q => [q[0], q[1]]);
  const n = p.prof.length;
  if (!(p.curve >= 1) || n < 3) return { pts: cp, m: n, solid };
  const steps = effSteps(p.steps, 16);
  const o = densifyN(cp, n, steps, solid ? 1 : 0, p.curve === 2, 2);
  return { pts: o, m: o.length / 2, solid };
}

/* extrude 輪郭の密化 (x,y)。ソリッド(thick<=0)は閉ポリゴン, シェル(thick>0)は開折れ線。
   lathe と同じ規約 — エンジン側 (dist/sexp_input.cpp) も同じ spline_densify を使う。 */
export function extrudeBaked(p) {
  const solid = !(p.thick > 0);
  const cp = p.prof.flatMap(q => [q[0], q[1]]);
  const n = p.prof.length;
  if (!(p.curve >= 1) || n < 3) return { pts: cp, m: n, solid };
  const steps = effSteps(p.steps, 8);
  const o = densifyN(cp, n, steps, solid ? 1 : 0, p.curve === 2, 2);
  return { pts: o, m: o.length / 2, solid };
}

/* ── 葉ごとの描画コスト見積もり (シーン読込時の重量パーツ自動除外用) ─────────
   「1サンプルあたりのループ反復数」を静的に数える — GLSL emit が出す定数長ループの
   長さそのもの (sweep=密化後セグ数, 任意断面はさらに×断面点数, lathe=輪郭点数)。
   repeat/repeat3 は子を隣接コピーぶん複数回評価するので乗数で効かせる。
   実測の裏付け (2026-07-27, maneki_neko): 撚り紐 sweep 1本=1680 で、3本が
   シーン全体 5217 の 97% を占め GPU プロセスが落ちた。腕 tube=36 / 胴 lathe=11 は無害。 */
export function collectLeafCosts(root) {
  const out = [];
  const walk = (n, mul) => {
    const sc = SCHEMA[n.type];
    if (sc && sc.kind === 'leaf') {
      let c = 1;
      if (n.type === 'sweep') {
        if (isProfileSweep(n.props)) {
          const bk = sweepProfBaked(n.props);
          c = Math.max(1, bk.nseg) * Math.max(1, bk.m);   /* セグ×断面ポリゴン */
        } else {
          const bk = sweepBaked(n.props);
          c = Math.max(1, bk.closed ? bk.n : bk.n - 1);
        }
      } else if (n.type === 'lathe') {
        c = Math.max(1, latheBaked(n.props).m);
      } else if (n.type === 'extrude') {
        c = Math.max(1, extrudeBaked(n.props).m);
      } else if (n.type === 'grid') {
        c = 8;                                            /* 3Dテクスチャfetch＋補間ぶん */
      }
      out.push({ node: n, cost: c * mul });
      return;
    }
    let m = mul;
    if (n.type === 'repeat') m *= 2;                      /* 隣接2コピーの min */
    if (n.type === 'repeat3' || n.type === 'repeat-inf') m *= 2;
    n.children.forEach(ch => walk(ch, m));
  };
  walk(root, 1);
  return out;
}

/* ノード型ごとの uniform スロット数。approx=true は sweep 任意断面を近似チューブで数える
   (ドラッグ中の軽量モード。レイアウトが変わるので collectParams と同じフラグを使うこと) */
function slotCount(node, approx) {
  switch (node.type) {
    case 'sphere': case 'octahedron': case 'mirror': return 4;
    case 'box': case 'ellipsoid': case 'round-cone': case 'capped-cone': return 6;
    case 'superquad': return 9;
    case 'torus': case 'cylinder': case 'cone': return 5;
    case 'torus-ellipse': return 6;   /* center(3)+radii(2)+minor(1) */
    case 'grid': return 7;            /* center(3)+scale(1)+size(3) */
    case 'translate': return 3;
    case 'plane': return 7;    /* center(3) + normal(3) + offset(1) */
    case 'box-frame': case 'capsule': case 'cylinder-ab': return 7;
    case 'round-cone-ab': case 'capped-cone-ab': return 8;
    case 'sweep':   /* 円形/近似=4*n, 任意断面(正確)=path+frames+pads+fac+poly (可変長) */
      return (isProfileSweep(node.props) && !approx)
        ? sweepProfBaked(node.props).slots
        : sweepBaked(node.props).pts.length;
    case 'lathe':   /* center(3)+axis(1)+thick(1)+輪郭(2*m) */
      return 5 + latheBaked(node.props).pts.length;
    case 'extrude': /* center(3)+depth(1)+thick(1)+輪郭(2*m) */
      return 5 + extrudeBaked(node.props).pts.length;
    case 'rotate': case 'rotate-mat': return 12;
    case 'repeat': return 4;   /* offset(3) + count(1) */
    case 'repeat3': return 6;  /* spacing(3) + count(3) */
    case 'repeat-inf': return 3;  /* spacing(3) */
    case 'scale': return 3;    /* s(3) */
    case 'round': case 'onion': return 1;
    case 'elongate': return 3;
    case 'twist': case 'bend': return 2;   /* rate(rad) + 1/Lipschitz */
    case 'smooth-union': case 'smooth-intersect': case 'smooth-subtract': case 'blend': return 1;
    default: return 0; /* union/intersect/subtract/invert/raw */
  }
}

/* パーツ識別色の自動割当 (黄金比で回すパステル。自動専用 — 手動色は材質色 mcolor で) */
/* パラメータ・テクスチャの幅 (2の冪)。codegen の parAt() と viewer のアップロードで共有する。 */
export const PAR_TEX_W = 1024, PAR_TEX_SHIFT = 10;
/* 取込メッシュの SDF グリッド (3Dテクスチャ) の最大枚数。超過分は bbox の箱で代用する。
   sampler3D は uniform 1個ずつなので数を絞る (実用上、取り込みモデルは数個)。 */
export const GRID_MAX = 4;

/* doc 内の grid リーフを出現順に列挙 (file でユニーク化)。viewer と codegen が
   同じ順番でスロットを割り当てるための単一情報源。 */
export function collectGrids(doc) {
  const seen = new Map();
  const walk = n => {
    if (!n) return;
    if (n.type === 'grid' && n.props.file && !seen.has(n.props.file))
      seen.set(n.props.file, { file: n.props.file });
    (n.children || []).forEach(walk);
  };
  (doc.objects || []).filter(o => o.visible).forEach(o => walk(o.root));
  return [...seen.values()].slice(0, GRID_MAX);
}
/* 色テクスチャの段数 (ノード数 → 何行必要か)。part色を上段・材質色を下段に積むので
   実際のテクスチャ高さは この2倍。codegen(シェーダに焼く定数) と viewer(アップロード) が
   必ず同じ値を使う必要があるため、式をここに一本化する。 */
export function colTexRows(nodeCount) { return Math.max(1, Math.ceil(nodeCount / PAR_TEX_W)); }

/* 密化に使う実効 steps。下限2 = エンジン (dist/sexp_input.cpp) が steps<2 で折れ線化するのに揃える。
   ※かつてここに「uniform 上限を超えたらプレビューの steps を自動降格する」機構があったが、
   数値パラメータを float テクスチャ化して uPar の 1024 制限が消え、steps は uniform 数に
   一切影響しなくなった (= 降格しても無意味) ため撤去した。 */
function effSteps(raw, dflt) {
  return Math.max(2, Math.round(raw || dflt));
}

/* 生成済みフラグメントシェーダの uniform ベクタ数。GLSL ES の packing では float 配列の
   1要素が1ベクトルを消費するので parAt(N) は N vectors (N/4 ではない)。
   MAX_FRAGMENT_UNIFORM_VECTORS (多くの環境で1024) と比較して、超過なら link が失敗し
   プレビューが真っ暗になる。詳細: docs/2026-07-15_sdfmodeler_WebGL_uniform上限.md */
const UNI_VEC_SIZE = { float: 1, vec2: 1, vec3: 1, vec4: 1, mat3: 3, mat4: 4, int: 1, bool: 1 };
export function countUniformVectors(fragSrc) {
  let total = 0;
  for (const line of fragSrc.split('\n')) {
    if (!/^\s*uniform\b/.test(line)) continue;
    const m = /uniform\s+(\w+)\s+\w+\s*(\[\s*(\d+)\s*\])?/.exec(line);
    if (!m) continue;
    total += (UNI_VEC_SIZE[m[1]] ?? 1) * (m[3] ? +m[3] : 1);
  }
  return total;
}

export function autoPartColor(idx) {
  const h = (idx * 0.61803) % 1;
  const f = o => Math.min(1, Math.max(0, 0.55 + 0.45 * Math.cos(2 * Math.PI * (h + o))));
  return [f(0), f(0.33), f(0.67)];
}
export function collectPartColors(layout) {
  const arr = new Float32Array(Math.max(1, layout.order.length) * 3);
  layout.order.forEach(n => {
    const i = layout.indices.get(n.id);
    arr.set(autoPartColor(i), i * 3);   /* 旧 .json の props.partColor は無視 (自動専用) */
  });
  return arr;
}

/* 材質色 (mcolor 継承) を葉ごとに解決。戻り: { arr: Float32Array, hasAny: bool } */
export function collectMatColors(doc, layout) {
  const arr = new Float32Array(Math.max(1, layout.order.length) * 3);
  let hasAny = false;
  for (const obj of doc.objects) {
    const base = surfaceColor(obj.surface);
    const walk = (n, inh) => {
      const own = n.props.mcolor || inh;
      if (n.props.mcolor) hasAny = true;
      if (layout.indices.has(n.id)) arr.set(own, layout.indices.get(n.id) * 3);
      n.children.forEach(c => walk(c, own));
    };
    walk(obj.root, base);
  }
  return { arr, hasAny };
}

/* twist/bend の Lipschitz 係数用: 子部分木が原点からどこまで届くかの雑な上界。
   厳密な bbox ではなく加算で包む保守的見積り (プレビューで穴を出さないのが目的) */
function roughExtent(node) {
  if (!node) return 1;
  const p = node.props, sc = SCHEMA[node.type];
  const len3 = v => Math.hypot(v[0], v[1], v[2]);
  if (sc && sc.kind === 'leaf') {
    let c = 0, dim = 0.3;
    if (p.center) c = len3(p.center);
    else if (p.a && p.b) c = Math.max(len3(p.a), len3(p.b));
    else if (node.type === 'sweep' && p.points)
      for (let q = 0; q + 2 < p.points.length; q += 3)
        c = Math.max(c, len3([p.points[q], p.points[q + 1], p.points[q + 2]]));
    for (const k of ['radius', 'major', 'minor', 'height', 'r1', 'r2', 'size', 'radii', 'thick']) {
      const v = p[k];
      if (v == null) continue;
      dim = Math.max(dim, Array.isArray(v) ? Math.max(...v.map(Math.abs)) : Math.abs(v));
    }
    return c + dim * 2;
  }
  let m = 0;
  for (const ch of node.children) m = Math.max(m, roughExtent(ch));
  if (node.type === 'translate') m += len3(p.t);
  if (node.type === 'rotate' || node.type === 'rotate-mat') m += len3(p.pivot || [0, 0, 0]) * 2;
  if (node.type === 'elongate') m += len3(p.h);
  if (node.type === 'round') m += Math.abs(p.r || 0);
  if (node.type === 'repeat') m += len3(p.offset) * Math.max(0, Math.round(p.count || 1) - 1);
  if (node.type === 'repeat3') { const c = p.count || [2,2,2], s = p.spacing || [1,1,1];
    m += Math.hypot(s[0]*(Math.round(c[0])-1), s[1]*(Math.round(c[1])-1), s[2]*(Math.round(c[2])-1)); }
  if (node.type === 'scale') { const s = p.s || [1,1,1];
    m *= Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2])); }
  return m;
}

/* ── オブジェクト単位の保守的バウンディング球 (map() の早期スキップガード用) ──
   リーフの代表点を祖先写像で列挙して包む。mirror=両側 / repeat=先頭+終端コピー /
   elongate=±h の2点。plane/raw/twist/bend を含むオブジェクトは null (ガード無効)。
   ガードの正しさは「球がオブジェクト表面を完全に含む」こと — 半径は常に過大評価側に */
const mv3 = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/* バウンディング球の安全マージン (相対倍率 + 絶対下駄)。計測/チューニング用に
   window.__SPH_REL / __SPH_ABS で上書き可。緩めると枝刈りガードが成立しなくなり、
   詰めすぎると球が実体を包めず穴が出る (必ず出力ビット一致で検証すること)。 */
const SPH_REL = () => (typeof window !== 'undefined' && window.__SPH_REL) || 1.12;
const SPH_ABS = () => (typeof window !== 'undefined' && window.__SPH_ABS != null)
  ? window.__SPH_ABS : 0.02;

/* ノードのローカル座標系 (node に渡される座標) での保守的バウンディング球 [cx,cy,cz,r]。
   objSphere をノード単位に一般化 (union/smooth-union の子ごとの枝刈りガードに使う)。
   ガード不可 (plane/raw/twist/bend を含む) は null。半径は常に過大評価側。 */
export function nodeSphere(node) {
  let bad = false, pad = 0;
  const pts = [];
  const walk = (n, mapP) => {
    if (bad) return;
    if (n.hidden) return;   /* 非表示サブツリーは評価されない (emit が 1e9) ので球にも入れない */
    const sc = SCHEMA[n.type];
    const p = n.props;
    if (sc && sc.kind === 'leaf') {
      if (n.type === 'plane' || n.type === 'raw') { bad = true; return; }
      let locs = (p.a && p.b) ? [p.a, p.b] : p.center ? [p.center] : null;
      if (n.type === 'sweep') {   /* 焼き込み経路点そのもの (spline 密化後 = 正確に包める) */
        const bk = sweepBaked(p);
        locs = [];
        for (let q = 0; q < bk.n; q++) locs.push([bk.pts[4 * q], bk.pts[4 * q + 1], bk.pts[4 * q + 2]]);
      }
      if (n.type === 'extrude') {   /* 押し出し: 輪郭の xy 範囲 × z±(depth+厚み) を包む */
        let xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9;
        for (const q of p.prof) {
          xmin = Math.min(xmin, q[0]); xmax = Math.max(xmax, q[0]);
          ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]);
        }
        const hz = Math.abs(p.depth) + (p.thick || 0);
        locs = [[p.center[0] + xmax, p.center[1] + ymax, p.center[2] + hz],
                [p.center[0] + xmin, p.center[1] + ymin, p.center[2] - hz]];
      }
      if (n.type === 'lathe') {   /* 回転体: 中心±(最大半径+axis+厚み, 高さ範囲) を包む */
        let rmax = 0, ymin = 1e9, ymax = -1e9;
        for (const q of p.prof) { rmax = Math.max(rmax, Math.abs(q[0])); ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]); }
        const rr = rmax + Math.abs(p.axis) + (p.thick || 0);
        locs = [[p.center[0] + rr, p.center[1] + ymax, p.center[2] + rr],
                [p.center[0] - rr, p.center[1] + ymin, p.center[2] - rr]];
      }
      if (!locs || !locs.length) { bad = true; return; }
      let dim = 0.05;
      /* blob の 'scale' は支持半径そのもの (leaf 以外に scale prop を持つものは無い) */
      for (const k of ['radius', 'major', 'minor', 'height', 'r1', 'r2', 'size', 'radii', 'thick', 'scale']) {
        const v = p[k];
        if (v == null || k === 'thick' && n.type === 'lathe') continue;   /* lathe は locs に反映済 */
        dim = Math.max(dim, Array.isArray(v) ? Math.max(...v.map(Math.abs)) : Math.abs(v));
      }
      if (n.type === 'cone')   /* 底面半径 h·tanθ は 2·max を超えうる */
        dim = Math.max(dim, Math.abs(p.height) * Math.tan(Math.min(85, Math.abs(p.angle)) * D2R));
      for (const l of locs) for (const w of mapP(l)) pts.push([w, dim * 2]);
      return;
    }
    /* ★ intersect / smooth-intersect は **子の和でなく最小の子**で包む。
       結果の立体は各子の立体に含まれる (max(a,b)<=0 ⇔ a<=0 かつ b<=0) ので、
       いちばん小さい子の球がそのまま妥当な包囲になる。和で包むと decal
       (= ホストの殻 ∩ 小さなカッター) の球が**ホスト全体より大きくなり**、
       枝刈りが完全に無効化される (実測 r=2.892 vs ホスト 2.260)。
       smooth-intersect も硬い交差の内側なので同じ扱いで安全 (場は max より
       最大 k/4 過大評価 = 形は縮む側)。
       ※ invert の子は「外側が中身」で球が意味を持たないため候補から外す。
         intersect(A, invert(B)) = A∖B ⊆ A なので、A だけ見れば正しい。 */
    if (n.type === 'intersect' || n.type === 'smooth-intersect') {
      const cand = [];
      for (const ch of n.children) {
        if (ch.hidden || ch.type === 'invert') continue;
        const sp = nodeSphere(ch);          /* 子のローカル系 = このノードと同じ */
        if (sp) cand.push(sp);
      }
      if (cand.length) {
        const best = cand.reduce((a, b) => (b[3] < a[3] ? b : a));
        for (const w of mapP([best[0], best[1], best[2]])) pts.push([w, best[3]]);
        return;                              /* 子は歩かない (この球で十分) */
      }
      /* 候補が無い (invert だけ/ガード不可) ときは従来どおり和で包む */
    }
    let m = mapP;
    if (n.type === 'translate') {
      const t = p.t;
      m = q => mapP([q[0] + t[0], q[1] + t[1], q[2] + t[2]]);
    } else if (n.type === 'rotate' || n.type === 'rotate-mat') {
      const S = n.type === 'rotate'
        ? eulerToMat(p.deg[0] * D2R, p.deg[1] * D2R, p.deg[2] * D2R)
        : [p.m0, p.m1, p.m2, p.m3, p.m4, p.m5, p.m6, p.m7, p.m8];
      const pv = p.pivot || [0, 0, 0];
      m = q => {
        const r = mv3(S, [q[0] - pv[0], q[1] - pv[1], q[2] - pv[2]]);
        return mapP([r[0] + pv[0], r[1] + pv[1], r[2] + pv[2]]);
      };
    } else if (n.type === 'mirror') {
      const N = p.normal, d = p.d || 0;
      const L = Math.hypot(N[0], N[1], N[2]) || 1;
      const nn = [N[0] / L, N[1] / L, N[2] / L];
      m = q => {
        const md = q[0] * nn[0] + q[1] * nn[1] + q[2] * nn[2] - d;
        return [...mapP(q), ...mapP([q[0] - 2 * md * nn[0], q[1] - 2 * md * nn[1], q[2] - 2 * md * nn[2]])];
      };
    } else if (n.type === 'repeat') {
      const o2 = p.offset, c = Math.max(1, Math.round(p.count)) - 1;
      m = q => [...mapP(q), ...mapP([q[0] + o2[0] * c, q[1] + o2[1] * c, q[2] + o2[2] * c])];
    } else if (n.type === 'repeat3') {
      const s = p.spacing, cc = (p.count || [2,2,2]).map(v => Math.max(1, Math.round(v)) - 1);
      m = q => {                                    /* 8隅の格子コピーを列挙 */
        const out = [];
        for (const ix of [0, cc[0]]) for (const iy of [0, cc[1]]) for (const iz of [0, cc[2]])
          out.push(...mapP([q[0] + s[0]*ix, q[1] + s[1]*iy, q[2] + s[2]*iz]));
        return out;
      };
    } else if (n.type === 'elongate') {
      const h = p.h;
      m = q => [...mapP([q[0] - h[0], q[1] - h[1], q[2] - h[2]]),
                ...mapP([q[0] + h[0], q[1] + h[1], q[2] + h[2]])];
    } else if (n.type === 'scale') {
      const s = p.s;
      m = q => mapP([q[0] * s[0], q[1] * s[1], q[2] * s[2]]);
    } else if (n.type === 'twist' || n.type === 'bend' || n.type === 'repeat-inf') { bad = true; return; }
    else if (n.type === 'round' || n.type === 'onion') pad += Math.abs(p.r ?? p.t ?? 0);
    n.children.forEach(ch => walk(ch, m));
  };
  walk(node, q => [q.slice()]);
  if (bad || !pts.length) return null;
  const c = [0, 0, 0];
  for (const [w] of pts) { c[0] += w[0]; c[1] += w[1]; c[2] += w[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  let r = 0;
  for (const [w, dim] of pts)
    r = Math.max(r, Math.hypot(w[0] - c[0], w[1] - c[1], w[2] - c[2]) + dim);
  /* 安全マージン。旧 `r*1.05 + pad + 0.3` は絶対値 0.3 が効きすぎて、モデルが小さいと
     球が実体の2倍近くに膨れ枝刈りガードがまるで成立しなかった (human は全身の半径が 1.35 しか
     ないのに各ガード球が 0.63 = 全身の半分)。leaf の寸法は既に `dim*2` で二重に見積もって
     いるので、絶対値ではなく相対マージン + 小さな下駄にする。 */
  return [c[0], c[1], c[2], r * SPH_REL() + pad + SPH_ABS()];
}

export function objSphere(obj) { return nodeSphere(obj.root); }

/* 枝刈りを発火させる union/smooth-union の最小子数。
   遠方代用 (GUARD_FAR) を入れる前は子が少ないとガードのコストが勝っていたので 8 にしていたが、
   代用ありなら 2子の関節チェーンでも効く (human 3.2倍/frog 2.0倍) ので 2 が既定。
   計測/チューニング用に window.__PRUNE_MIN で上書き可。 */
export const PRUNE_MIN_CHILDREN = () =>
  (typeof window !== 'undefined' && window.__PRUNE_MIN) || 2;

export function collectObjSpheres(doc) {
  const objs = doc.objects.filter(o => o.visible);
  const arr = new Float32Array(Math.max(1, objs.length) * 4);
  arr[3] = 1e9;
  objs.forEach((o, i) => arr.set(objSphere(o) || [0, 0, 0, 1e9], i * 4));
  return arr;
}

/* パラメータ値を layout 順に書き込む (collectParams と emit で順序共有) */
function pushParams(node, out, approx) {
  const p = node.props;
  const v3 = a => out.push(a[0], a[1], a[2]);
  switch (node.type) {
    case 'sphere': v3(p.center); out.push(p.radius); break;
    case 'box': v3(p.center); v3(p.size); break;
    case 'ellipsoid': v3(p.center); v3(p.radii); break;
    case 'torus': v3(p.center); out.push(p.major, p.minor); break;
    case 'torus-ellipse': v3(p.center); out.push(p.radii[0], p.radii[1], p.minor); break;
    /* grid: GLSL レイマーチは 3Dテクスチャ未対応なので、プレビューでは
       サーバーから貰った bbox を箱として出す (正確な形はメッシュ表示で見る) */
    case 'grid': v3(p.center); out.push(p.scale ?? 1); v3(p.size || [1,1,1]); break;
    case 'plane': v3(p.center); v3(p.normal || [0,1,0]); out.push(p.offset ?? 0); break;
    case 'box-frame': v3(p.center); v3(p.size); out.push(p.thick); break;
    case 'capsule': case 'cylinder-ab': v3(p.a); v3(p.b); out.push(p.radius); break;
    case 'cylinder': v3(p.center); out.push(p.radius, p.height); break;
    case 'round-cone': v3(p.center); out.push(p.r1, p.r2, p.height); break;
    case 'round-cone-ab': case 'capped-cone-ab': v3(p.a); v3(p.b); out.push(p.r1, p.r2); break;
    case 'capped-cone': v3(p.center); out.push(p.height, p.r1, p.r2); break;
    case 'cone': v3(p.center); out.push(p.angle * D2R, p.height); break;
    case 'octahedron': v3(p.center); out.push(p.size); break;
    case 'superquad': v3(p.center); v3(p.radii); out.push(p.e1, p.e2, p.e3 ?? p.e2); break;
    case 'sweep':
      if (isProfileSweep(p) && !approx) {
        const bk = sweepProfBaked(p);   /* 順序 = emit のオフセット計算と一致必須 */
        out.push(...bk.path, ...bk.frames, ...bk.pads, ...bk.fac, ...bk.poly);
      } else out.push(...sweepBaked(p).pts);
      break;
    case 'lathe': { v3(p.center); out.push(p.axis, p.thick); out.push(...latheBaked(p).pts); break; }
    case 'extrude': { v3(p.center); out.push(p.depth, p.thick); out.push(...extrudeBaked(p).pts); break; }
    case 'translate': v3(p.t); break;
    case 'rotate': {
      v3(p.pivot);
      const m = eulerToMat(p.deg[0] * D2R, p.deg[1] * D2R, p.deg[2] * D2R);
      out.push(...m);
      break;
    }
    case 'rotate-mat': {
      v3(p.pivot);
      for (let i = 0; i < 9; i++) out.push(p['m' + i]);
      break;
    }
    case 'mirror': {
      const n = p.normal;
      let L = Math.hypot(n[0], n[1], n[2]); if (L < 1e-9) L = 1;
      out.push(n[0] / L, n[1] / L, n[2] / L, p.d);
      break;
    }
    case 'repeat': {
      const o = p.offset;
      const L = Math.hypot(o[0], o[1], o[2]);
      if (L < 1e-9) { out.push(1, 0, 0); } else v3(o);
      out.push(Math.max(1, Math.round(p.count)));
      break;
    }
    case 'repeat-inf': v3(p.spacing); break;
    case 'repeat3': {
      v3(p.spacing);
      const c = p.count || [2, 2, 2];
      out.push(Math.max(1, Math.round(c[0])), Math.max(1, Math.round(c[1])), Math.max(1, Math.round(c[2])));
      break;
    }
    case 'scale': v3(p.s); break;
    case 'round': out.push(Math.abs(p.r)); break;
    case 'onion': out.push(Math.abs(p.t)); break;
    case 'elongate': out.push(Math.abs(p.h[0]), Math.abs(p.h[1]), Math.abs(p.h[2])); break;
    case 'twist': case 'bend': {
      /* 非Lipschitz → 子部分木の雑な半径上界から 1/L を計算 (プレビューの穴防止) */
      const k = (p.rate || 0) * D2R;
      out.push(k, 1 / (1 + Math.abs(k) * roughExtent(node.children[0])));
      break;
    }
    case 'smooth-union': case 'smooth-intersect': case 'smooth-subtract':
      out.push(Math.max(p.k, 1e-6)); break;
    case 'blend': out.push(Math.min(1, Math.max(0, p.u))); break;
  }
}

/* この部分木はレイマーチに 1e9 (空) としてしか出ないか?
   blob (WASM メッシュが担当) と hidden のリーフしか含まなければ真。
   emitOpPruned はこれをガード球にしてはいけない — 実体の無い部分木の
   境界球下界を union に合成すると、blob の球集合が亡霊として描かれる */
export function raymarchEmpty(n) {
  if (n.hidden || n.type === 'blob' || n.type === 'mesh') return true;
  const sc = SCHEMA[n.type];
  if (sc && sc.kind === 'leaf') return false;
  return n.children.length ? n.children.every(raymarchEmpty) : true;
}

/* ── レイアウト計算 ─────────────────────────────────────────── */
export function buildLayout(doc, sweepApprox = false) {
  const offsets = new Map();   /* nodeId → uPar offset */
  const indices = new Map();   /* nodeId → int (uSelId/pick 用) */
  const order = [];            /* 走査順ノード列 */
  let off = 0, idx = 0;
  const walk = n => {
    /* blob は GLSL に出ない (WASM メッシュが担当) — スロットも識別色も
       消費させない。97 blob のシーンで param ~1300 スロットと色テクスチャが
       死荷重になり、シェーダ肥大とコンパイル時間の主因だった */
    if (n.type === 'blob' || n.type === 'mesh') return;   /* mesh(OBJ) も同じ扱い (第8弾) */
    offsets.set(n.id, off);
    indices.set(n.id, idx++);
    order.push(n);
    off += slotCount(n, sweepApprox);
    n.children.forEach(walk);
  };
  for (const obj of doc.objects) if (obj.visible) walk(obj.root);
  return { offsets, indices, order, parCount: Math.max(1, off), sweepApprox };
}

export function collectParams(doc, layout) {
  const arr = [];
  for (const n of layout.order) pushParams(n, arr, layout.sweepApprox);
  while (arr.length < (layout.subSphBase ?? layout.parCount)) arr.push(0);
  /* 枝刈りガードの球を末尾に (ドラッグ後の props で再計算 → 追従)。null は無効球 */
  for (const g of (layout.guards || [])) {
    const s = nodeSphere(g) || [0, 0, 0, 1e9];
    arr.push(s[0], s[1], s[2], s[3]);
  }
  while (arr.length < layout.parCount) arr.push(0);
  return new Float32Array(arr);
}

/* ── GLSL 生成 ──────────────────────────────────────────────── */
class Emitter {
  constructor(layout, instrumented, focusSet) {
    this.layout = layout;
    this.inst = instrumented;
    this.focusSet = focusSet || null;   /* 非nullなら集合外リーフは d=1e9 (距離関数呼び出しをスキップ) */
    this.lines = [];
    this.vc = 0;
    this.objIdx = 0;   /* probe 生成時: 現在 emit 中のオブジェクト index (材質色のobject内ブレンド用) */
  }
  P(node, i) { return `parAt(${this.layout.offsets.get(node.id) + i})`; }
  V3(node, i) { return `vec3(${this.P(node, i)},${this.P(node, i + 1)},${this.P(node, i + 2)})`; }
  tmp(prefix) { return prefix + (this.vc++); }
  push(s) { this.lines.push('  ' + s); }

  emit(node, pv) {
    /* 非表示ノード (ツリーの👁トグル): 空集合 = 1e9 として評価する (focusSet と
       同じ流儀 — union/smooth-union/subtract の減数側に中立)。サブツリーへ
       **再帰しない**のが要点で、重いリーフ (例: 招き猫の首輪 = 1680セグの sweep)
       のループがシェーダから丸ごと消える = コンパイルも毎フレームも軽くなる。
       ※intersect の片側を隠すと全体が消える (空集合との交差) が、これは仕様。 */
    if (node.hidden || node.type === 'blob' || node.type === 'mesh') {
      /* blob / mesh(OBJ) はレイマーチに出ない (密度場/三角形は sphere trace 不能 — ラスタが
         描く)。hidden と同じ union 中立の 1e9 にし、選択/色分けの計測コードも
         出さない (97 blob × 5文 の死コードがコンパイルを重くしていた) */
      const d = this.tmp('d');
      this.push(`float ${d} = 1e9;`);
      return d;
    }
    const sc = SCHEMA[node.type] || { kind: 'leaf' };
    let d;
    if (sc.kind === 'leaf') d = this.emitLeaf(node, pv);
    else if (sc.kind === 'xform') d = this.emitXform(node, pv);
    else d = this.emitOp(node, pv);
    if (this.inst) {
      const idx = this.layout.indices.get(node.id);
      this.push(`if(uSelId==${idx}) selD = min(selD, ${d});`);
      if (sc.kind === 'leaf' && node.type !== 'raw') {
        this.push(`if(${d} < bestD){ bestD = ${d}; bestId = ${idx}; }`);
        /* 色分け用: 距離の指数重みで識別色を集計 (ブレンド域でグラデーション) */
        this.push(`{ float w_ = exp(-max(${d}, 0.0) * 12.0); pcAcc += partColAt(${idx}) * w_; pwAcc += w_; }`);
        /* 材質色 (mcolor 継承): ヒットしたオブジェクト内の葉だけで重み付きブレンド。
           減衰は識別色より鋭く (小パーツの色が滲まないよう) */
        this.push(`if (objSel == ${this.objIdx}) { float w2_ = exp(-max(${d}, 0.0) * 48.0); mcAcc += matColAt(${idx}) * w2_; mwAcc += w2_; }`);
      }
    }
    return d;
  }

  emitLeaf(node, pv) {
    const d = this.tmp('d');
    if (this.focusSet && !this.focusSet.has(node.id)) {
      /* フォーカス外: 距離関数呼び出しを省き定数に (union/smooth-union/subtract に中立) */
      this.push(`float ${d} = 1e9;`);
      return d;
    }
    const q = `(${pv} - ${this.V3(node, 0)})`;
    switch (node.type) {
      case 'sphere': this.push(`float ${d} = length${q} - ${this.P(node, 3)};`); break;
      case 'box': this.push(`float ${d} = sdBox(${q}, ${this.V3(node, 3)});`); break;
      case 'ellipsoid': this.push(`float ${d} = sdEllipsoid(${q}, ${this.V3(node, 3)});`); break;
      case 'torus': this.push(`float ${d} = sdTorus(${q}, ${this.P(node, 3)}, ${this.P(node, 4)});`); break;
      case 'torus-ellipse': this.push(`float ${d} = sdTorusEllipse(${q}, vec2(${this.P(node, 3)}, ${this.P(node, 4)}), ${this.P(node, 5)});`); break;
      case 'plane': this.push(`float ${d} = dot(${q}, normalize(${this.V3(node, 3)})) - ${this.P(node, 6)};`); break;
      case 'box-frame': this.push(`float ${d} = sdBoxFrame(${q}, ${this.V3(node, 3)}, ${this.P(node, 6)});`); break;
      case 'capsule': this.push(`float ${d} = sdCapsule(${pv}, ${this.V3(node, 0)}, ${this.V3(node, 3)}, ${this.P(node, 6)});`); break;
      case 'cylinder': this.push(`float ${d} = sdCylinder(${q}, ${this.P(node, 3)}, ${this.P(node, 4)});`); break;
      case 'cylinder-ab': this.push(`float ${d} = sdCylinderAB(${pv}, ${this.V3(node, 0)}, ${this.V3(node, 3)}, ${this.P(node, 6)});`); break;
      case 'round-cone': this.push(`float ${d} = sdRoundCone(${q}, ${this.P(node, 3)}, ${this.P(node, 4)}, ${this.P(node, 5)});`); break;
      case 'round-cone-ab': this.push(`float ${d} = sdRoundConeAB(${pv}, ${this.V3(node, 0)}, ${this.V3(node, 3)}, ${this.P(node, 6)}, ${this.P(node, 7)});`); break;
      case 'capped-cone': this.push(`float ${d} = sdCappedCone(${q}, ${this.P(node, 3)}, ${this.P(node, 4)}, ${this.P(node, 5)});`); break;
      case 'capped-cone-ab': this.push(`float ${d} = sdCappedConeAB(${pv}, ${this.V3(node, 0)}, ${this.V3(node, 3)}, ${this.P(node, 6)}, ${this.P(node, 7)});`); break;
      case 'cone': this.push(`float ${d} = sdCone(${q}, ${this.P(node, 3)}, ${this.P(node, 4)});`); break;
      case 'octahedron': this.push(`float ${d} = sdOctahedron(${q}, ${this.P(node, 3)});`); break;
      /* grid (取込メッシュ): 3Dテクスチャのスロットがあれば実物をサンプル、
         無ければ (GRID_MAX 超過・データ未着) bbox の箱で代用する。
         箱は実体を必ず包む = 球面追跡は安全 (形が太るだけ) */
      case 'grid': {
        const slot = this.layout.gridSlots ? this.layout.gridSlots.get(node.props.file) : undefined;
        if (slot === undefined)
          this.push(`float ${d} = sdBox(${q}, 0.5*${this.V3(node, 4)});`);
        else
          this.push(`float ${d} = sdGrid${slot}(${pv}, ${this.V3(node, 0)}, ${this.P(node, 3)});`);
        break;
      }
      case 'superquad': this.push(`float ${d} = sdSuperquad(${q}, ${this.V3(node, 3)}, ${this.P(node, 6)}, ${this.P(node, 7)}, ${this.P(node, 8)});`); break;
      case 'sweep': {
        /* 焼き込み点列 (x,y,z,r)*n の丸錐カプセル連鎖 min (定数長ループ)。
           点数はレイアウトと同じ sweepBaked/sweepProfBaked で決まる (座標値だけが uniform) */
        const off = this.layout.offsets.get(node.id);
        if (isProfileSweep(node.props) && !this.layout.sweepApprox) {
          /* 任意断面 (正確): sd_sweep_prof_chunk (dist/sdf.cpp) と同式。
             uniform 配列内オフセット: path→frames→pads→fac→poly (pushParams と一致) */
          const bk = sweepProfBaked(node.props);
          const npt = bk.n, nseg = bk.nseg, m = bk.m;
          const fOff = off + 4 * npt, pdOff = fOff + 3 * npt,
                fcOff = pdOff + npt, plOff = fcOff + nseg;
          if (npt < 2 || m < 3) this.push(`float ${d} = 1e9;`);
          else {
            this.push(`float ${d} = 1e9;`);
            this.push(`for (int i_ = 0; i_ < ${nseg}; i_++) ` +
              `${d} = min(${d}, sdSweepProfSeg(${pv}, ${off}, ${npt}, i_, ${fOff}, ${pdOff}, ${fcOff}, ${plOff}, ${m}));`);
          }
          break;
        }
        const bak = sweepBaked(node.props);
        const npt = bak.n, nseg = bak.closed ? npt : npt - 1;
        if (npt <= 0) this.push(`float ${d} = 1e9;`);
        else if (npt === 1)
          this.push(`float ${d} = length(${pv} - vec3(parAt(${off}),parAt(${off + 1}),parAt(${off + 2}))) - parAt(${off + 3});`);
        else {
          this.push(`float ${d} = 1e9;`);
          this.push(`for (int i_ = 0; i_ < ${nseg}; i_++) { ` +
            `int o_ = ${off} + 4 * i_; int p_ = ${off} + 4 * ((i_ + 1) % ${npt}); ` +
            `${d} = min(${d}, sdSweepSeg(${pv}, ` +
            `vec3(parAt(o_),parAt(o_+1),parAt(o_+2)), vec3(parAt(p_),parAt(p_+1),parAt(p_+2)), ` +
            `parAt(o_+3), parAt(p_+3))); }`);
        }
        break;
      }
      case 'lathe': {
        /* 回転体: 3D点を (半径-axis, 高さ) の2Dへ落とし輪郭距離。ソリッド=閉ポリゴン(sdPolyUV)/
           シェル=開折れ線距離-thick。輪郭は parAt(off+5 ..) に (r,y)*m (latheBaked と一致) */
        const off = this.layout.offsets.get(node.id);
        const bk = latheBaked(node.props);
        const m = bk.m, plOff = off + 5;
        if (m < 2) { this.push(`float ${d} = 1e9;`); break; }
        this.push(`vec2 ${d}q = vec2(length(${pv}.xz - vec2(parAt(${off}),parAt(${off + 2}))) - parAt(${off + 3}), ${pv}.y - parAt(${off + 1}));`);
        if (bk.solid && m >= 3)
          this.push(`float ${d} = sdPolyUV(${d}q, ${plOff}, ${m});`);
        else
          this.push(`float ${d} = sdLatheShell(${d}q, ${plOff}, ${m}, parAt(${off + 4}));`);
        break;
      }
      case 'extrude': {
        /* 押し出し板: (x,y) の輪郭距離と z スラブを opExtrusion で結合。
           dist/sdf.cpp sd_extrude と同式 (ソリッド=閉ポリゴン sdPolyUV /
           シェル=開折れ線距離-thick は lathe と共用の sdLatheShell)。
           輪郭は parAt(off+5 ..) に (x,y)*m */
        const off = this.layout.offsets.get(node.id);
        const bk = extrudeBaked(node.props);
        const m = bk.m, plOff = off + 5;
        if (m < 3) { this.push(`float ${d} = 1e9;`); break; }
        /* ★接尾辞は必ず数字以外にする: tmp() は d0,d1,… を作るので `${d}2` は
           ノード d1 で "d12" となり **別ノード d12 と衝突**してリンクエラーになる
           (152ノードの招き猫で実際に踏んだ)。lathe が `${d}q` を使っているのも同じ理由。 */
        this.push(`vec2 ${d}q = ${pv}.xy - vec2(parAt(${off}), parAt(${off + 1}));`);
        if (bk.solid)
          this.push(`float ${d}e = sdPolyUV(${d}q, ${plOff}, ${m});`);
        else
          this.push(`float ${d}e = sdLatheShell(${d}q, ${plOff}, ${m}, parAt(${off + 4}));`);
        this.push(`float ${d}w = abs(${pv}.z - parAt(${off + 2})) - parAt(${off + 3});`);
        this.push(`float ${d} = min(max(${d}e, ${d}w), 0.0) + length(max(vec2(${d}e, ${d}w), 0.0));`);
        break;
      }
      default: this.push(`float ${d} = 1e9; /* raw: 未対応リーフ */`); break;
    }
    return d;
  }

  emitXform(node, pv) {
    if (node.type === 'round' || node.type === 'onion') {
      /* 距離変形: round = d-r / onion = |d|-t (子コードを先に出して後段で変形) */
      const d = this.tmp('d');
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const da = this.emit(node.children[0], pv);
      this.push(`float ${d} = ${node.type === 'onion' ? `abs(${da})` : da} - ${this.P(node, 0)};`);
      return d;
    }
    if (node.type === 'twist' || node.type === 'bend') {
      /* 非Lipschitz 変換: クエリ回転 + 距離に 1/L (uPar[1]) を乗じて安全化 */
      const d = this.tmp('d');
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const q = this.tmp('q');
      const rate = this.P(node, 0), invL = this.P(node, 1);
      if (node.type === 'twist')
        this.push(`vec3 ${q}; { float a_=${rate}*${pv}.y, c_=cos(a_), s_=sin(a_); ` +
                  `${q}=vec3(c_*${pv}.x - s_*${pv}.z, ${pv}.y, s_*${pv}.x + c_*${pv}.z); }`);
      else
        this.push(`vec3 ${q}; { float a_=${rate}*${pv}.x, c_=cos(a_), s_=sin(a_); ` +
                  `${q}=vec3(c_*${pv}.x - s_*${pv}.y, s_*${pv}.x + c_*${pv}.y, ${pv}.z); }`);
      const da = this.emit(node.children[0], q);
      this.push(`float ${d} = ${da} * ${invL};`);
      return d;
    }
    if (node.type === 'repeat') {
      /* 有限線形反復: 射影を挟む隣接2コピーの min (エンジン sdf.cpp SDF_REPEAT と同式)。
         子コードを2回インライン展開する (probe 集計も2コピー分=意味的に正しい) */
      const d = this.tmp('d');
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const v = this.tmp('rv'), s = this.tmp('rs'), ta = this.tmp('rt'), tb = this.tmp('rt');
      const pa = this.tmp('q'), pb = this.tmp('q');
      this.push(`vec3 ${v} = ${this.V3(node, 0)};`);
      this.push(`float ${s} = dot(${pv}, ${v}) / max(dot(${v}, ${v}), 1e-12);`);
      this.push(`float ${ta} = clamp(floor(${s}), 0.0, ${this.P(node, 3)} - 1.0);`);
      this.push(`float ${tb} = min(${ta} + 1.0, ${this.P(node, 3)} - 1.0);`);
      this.push(`vec3 ${pa} = ${pv} - ${v} * ${ta};`);
      this.push(`vec3 ${pb} = ${pv} - ${v} * ${tb};`);
      const da = this.emit(node.children[0], pa);
      const db = this.emit(node.children[0], pb);
      this.push(`float ${d} = min(${da}, ${db});`);
      return d;
    }
    if (node.type === 'repeat-inf') {
      /* 無限反復: 各軸で隣接2コピー (添字クランプ無し)。エンジン SDF_REPEAT_INF と同式 */
      const d = this.tmp('d');
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const spc = this.tmp('rsp');
      this.push(`vec3 ${spc} = ${this.V3(node, 0)};`);
      const sp = node.props.spacing || [1, 0, 1];
      const idx = [];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(sp[a]) < 1e-9) { idx.push(['0.0']); continue; }
        const f = this.tmp('rf'), t1 = this.tmp('rt1');
        this.push(`float ${f} = floor(${pv}[${a}] / ${spc}[${a}]);`);
        this.push(`float ${t1} = ${f} + 1.0;`);
        idx.push([f, t1]);
      }
      let first = true;
      for (const ix of idx[0]) for (const iy of idx[1]) for (const iz of idx[2]) {
        const q = this.tmp('q');
        this.push(`vec3 ${q} = ${pv} - vec3(${spc}.x*${ix}, ${spc}.y*${iy}, ${spc}.z*${iz});`);
        const dc = this.emit(node.children[0], q);
        if (first) { this.push(`float ${d} = ${dc};`); first = false; }
        else this.push(`${d} = min(${d}, ${dc});`);
      }
      return d;
    }
    if (node.type === 'repeat3') {
      /* 軸整列3Dグリッド: 各軸で隣接2コピー → 有効軸のみ 2^k 組合せの min
         (エンジン SDF_REPEAT3 と同式)。有効軸数ぶんだけ子コードを展開 */
      const d = this.tmp('d');
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const sp = this.V3(node, 0);
      const cnt = [this.P(node, 3), this.P(node, 4), this.P(node, 5)];
      const spc = this.tmp('rsp');
      this.push(`vec3 ${spc} = ${sp};`);
      const cn = (node.props.count || [2,2,2]).map(v => Math.max(1, Math.round(v)));
      // 各軸の代表インデックス配列 (count<=1 は [0], else [t0,t1])
      const idx = [];
      for (let a = 0; a < 3; a++) {
        if (cn[a] <= 1) { idx.push(['0.0']); continue; }
        const s = this.tmp('rs'), t0 = this.tmp('rt0'), t1 = this.tmp('rt1');
        this.push(`float ${s} = clamp(floor(${pv}[${a}] / ${spc}[${a}]), 0.0, ${cnt[a]} - 1.0);`);
        this.push(`float ${t0} = ${s}; float ${t1} = min(${s} + 1.0, ${cnt[a]} - 1.0);`);
        idx.push([t0, t1]);
      }
      let first = true;
      for (const ix of idx[0]) for (const iy of idx[1]) for (const iz of idx[2]) {
        const q = this.tmp('q');
        this.push(`vec3 ${q} = ${pv} - vec3(${spc}.x*${ix}, ${spc}.y*${iy}, ${spc}.z*${iz});`);
        const dc = this.emit(node.children[0], q);
        if (first) { this.push(`float ${d} = ${dc};`); first = false; }
        else this.push(`${d} = min(${d}, ${dc});`);
      }
      return d;
    }
    if (node.type === 'scale') {
      /* 拡縮: child(p/s)·min(|s|) (エンジン SDF_SCALE と同式。一様=厳密/非一様=保守下界) */
      const d = this.tmp('d');
      const sv = this.V3(node, 0);
      const s = this.tmp('rsc');
      this.push(`vec3 ${s} = ${sv};`);
      const q = this.tmp('q');
      this.push(`vec3 ${q} = ${pv} / ${s};`);
      if (!node.children.length) { this.push(`float ${d} = 1e9;`); return d; }
      const dc = this.emit(node.children[0], q);
      this.push(`float ${d} = ${dc} * min(abs(${s}.x), min(abs(${s}.y), abs(${s}.z)));`);
      return d;
    }
    const p2 = this.tmp('q');
    if (node.type === 'translate') {
      this.push(`vec3 ${p2} = ${pv} - ${this.V3(node, 0)};`);
    } else if (node.type === 'elongate') {
      /* q = P - clamp(P,-h,h) (IQ opElongate。外部厳密・内部保守的下界) */
      this.push(`vec3 ${p2} = ${pv} - clamp(${pv}, -${this.V3(node, 0)}, ${this.V3(node, 0)});`);
    } else if (node.type === 'rotate' || node.type === 'rotate-mat') {
      /* sqm eval: p' = pivot + Rᵀ(p-pivot)。row-major R をそのまま mat3() に
         列挙すると GLSL では列優先解釈 = Rᵀ になり同型。 */
      const piv = this.V3(node, 0);
      const m = [];
      for (let i = 0; i < 9; i++) m.push(this.P(node, 3 + i));
      this.push(`vec3 ${p2}; { vec3 pv_ = ${piv}; ${p2} = pv_ + mat3(${m.join(',')}) * (${pv} - pv_); }`);
    } else { /* mirror */
      const nn = this.tmp('mn');
      this.push(`vec3 ${nn} = ${this.V3(node, 0)};`);
      this.push(`float ${nn}m = dot(${pv}, ${nn}) - ${this.P(node, 3)};`);
      this.push(`vec3 ${p2} = ${pv} - (${nn}m > 0.0 ? 2.0*${nn}m : 0.0) * ${nn};`);
    }
    if (!node.children.length) { const d = this.tmp('d'); this.push(`float ${d} = 1e9;`); return d; }
    return this.emit(node.children[0], p2);
  }

  /* union/smooth-union で子が多いとき、各子を保守バウンディング球でガードして
     「現在の最小に寄与しない遠い子」の距離関数呼び出しを丸ごとスキップ (sqm の
     bbox枝刈り/BVH の GLSL 版)。描画パスのみ (probe は色/ピック精度のため全評価)。
     ・union: 子の距離下界 lb=length(p-c)-r が現在の running d 以上ならスキップ (exact)
     ・smooth-union: +k マージンでスキップ (sUnion のブレンド域外を保証=穴なし)。
       右fold を保つため子を逆順に畳む (running=末尾から sUnion で合成)。
     ・さらに lb >= GUARD_FAR なら d の大小に依らずスキップし lb で代用する (下記②)。
       これが無いと表面近傍でしかスキップできず関節階層モデルにほぼ効かない。
     球は nodeSphere をパラメータテクスチャ末尾 (guards) に載せる → ドラッグ追従。 */
  emitOpPruned(node, pv) {
    const t = node.type, isSmooth = t === 'smooth-union';
    const d = this.tmp('d');
    this.push(`float ${d} = 1e9;`);
    const k = isSmooth ? this.P(node, 0) : null;
    const kids = isSmooth ? [...node.children].reverse() : node.children;
    for (const c of kids) {
      /* 非表示の子と blob だけの部分木はループごとスキップ。emit() の 1e9 化
         だけに任せると、遠方で「ガード球の下界 lb で代用」する else 枝が
         実体の無い子の lb を合成してしまう — blob では境界球の union が
         そのまま亡霊の塊として描かれる (blob 97 個のペンギンで実測) */
      if (raymarchEmpty(c)) continue;
      const sph = nodeSphere(c);
      const combine = cd => isSmooth
        ? `${d} = sUnion(${cd}, ${d}, ${k});`
        : `${d} = min(${d}, ${cd});`;
      if (sph) {
        const gi = this.layout.guards.length;
        this.layout.guards.push(c);
        const margin = isSmooth ? ` + ${k}` : '';
        /* 球は gGuard[] (main 冒頭で1回だけ parAt から読む) を参照。ここで直接 parAt すると
           マーチの全ステップで texelFetch が走り枝刈りの利得を食い潰す */
        const lb = this.tmp('lb');
        this.push(`float ${lb} = length(${pv} - gGuard[${gi}].xyz) - gGuard[${gi}].w;`);
        /* 下界 lb をそのまま合成するのは「常に保守的」(lb <= 子の真距離)。
           つまり子を評価する必要があるのは
             ①lb が running d に食い込む (lb < d+k) → 最小値を左右しうる
             ②かつ lb が絶対的にも近い (lb < GUARD_FAR) → 下界で代用すると歩幅が落ちる
           の両方を満たすときだけ。②を入れると「d がまだ大きい遠方マーチ中」でも
           遠い子を下界で代用して丸ごとスキップできる (関節階層モデルの本命。
           ①だけだと d が小さくならない遠方では一切スキップできなかった)。
           表面近傍では d≈0 なので ① が効き従来と同一 → 見た目は変わらない。 */
        this.push(`if (${lb} < ${d}${margin} && ${lb} < GUARD_FAR) {`);
        const cd = this.emit(c, pv);
        this.push('  ' + combine(cd));
        this.push(`} else ` + combine(lb));
      } else {
        const cd = this.emit(c, pv);   /* ガード不可 (plane/twist等) → 無条件 */
        this.push(combine(cd));
      }
    }
    return d;
  }

  emitOp(node, pv) {
    const t = node.type;
    /* 子が多い union/smooth-union は枝刈り版へ (probe/inst は精度優先で従来経路) */
    if (!this.inst && (t === 'union' || t === 'smooth-union') && node.children.length >= PRUNE_MIN_CHILDREN())
      return this.emitOpPruned(node, pv);
    if (raymarchEmpty(node)) {   /* blob/hidden だけの op — 子コードごと省く */
      const d = this.tmp('d');
      this.push(`float ${d} = 1e9;`);
      return d;
    }
    const kids = node.children.map(c => this.emit(c, pv));
    const d = this.tmp('d');
    if (!kids.length) { this.push(`float ${d} = 1e9;`); return d; }
    if (t === 'invert') { this.push(`float ${d} = -${kids[0]};`); return d; }
    if (t === 'blend') {
      if (kids.length === 1) { this.push(`float ${d} = ${kids[0]};`); return d; }
      this.push(`float ${d} = mix(${kids[0]}, ${kids[1]}, ${this.P(node, 0)});`);
      return d;
    }
    if (kids.length === 1) { this.push(`float ${d} = ${kids[0]};`); return d; }
    let expr;
    if (t === 'union') {
      expr = kids.reduce((a, b) => `min(${a}, ${b})`);
    } else if (t === 'intersect') {
      expr = kids.reduce((a, b) => `max(${a}, ${b})`);
    } else if (t === 'subtract') {
      expr = kids[0];
      for (let i = 1; i < kids.length; i++) expr = `max(${expr}, -${kids[i]})`;
    } else if (t === 'smooth-union' || t === 'smooth-intersect') {
      /* 右fold (元ファイルの入れ子方向と一致) */
      const base = t === 'smooth-union' ? 'sUnion' : 'sInter';
      const suf  = { round: 'Round', deep: 'Deep', chamfer: 'Cham' }[node.props.mode] || '';
      const fn = base + suf;
      expr = kids[kids.length - 1];
      for (let i = kids.length - 2; i >= 0; i--) expr = `${fn}(${kids[i]}, ${expr}, ${this.P(node, 0)})`;
    } else { /* smooth-subtract: 左fold */
      expr = kids[0];
      for (let i = 1; i < kids.length; i++) expr = `sSub(${expr}, ${kids[i]}, ${this.P(node, 0)})`;
    }
    this.push(`float ${d} = ${expr};`);
    return d;
  }
}

const PRELUDE = /* glsl */ `
/* 超楕円体 (sqm sd_superquad 移植): ゲージ/Lᵖ和 F の一次近似距離 (F-1)/|∇F|。
   e1=縦, e2=横x, e3=横z の角ばり。e3==e2 は従来の入れ子Lᵖノルム (2指数)、
   e3!=e2 は軸独立3指数 Lᵖ和。e=2 球 / 大→箱 / 1 八面体 / <1 星 (非凸は近似が粗い) */
float sdSuperquad(vec3 q, vec3 r, float e1, float e2, float e3){
  e1 = max(e1, 0.05); e2 = max(e2, 0.05); e3 = max(e3, 0.05);
  vec3 n = q / r;
  vec3 a = abs(n);
  vec3 ae = max(a, vec3(1e-4));
  vec3 sgn = vec3(n.x < 0.0 ? -1.0 : 1.0, n.y < 0.0 ? -1.0 : 1.0, n.z < 0.0 ? -1.0 : 1.0);
  if (abs(e3 - e2) > 1e-6) {
    float F = pow(a.x, e2) + pow(a.y, e1) + pow(a.z, e3);
    if (F < 1e-9) return -min(r.x, min(r.y, r.z));
    vec3 g3 = vec3(e2*pow(ae.x, e2-1.0)*sgn.x/r.x,
                   e1*pow(ae.y, e1-1.0)*sgn.y/r.y,
                   e3*pow(ae.z, e3-1.0)*sgn.z/r.z);
    return (F - 1.0) / max(length(g3), 1e-9);
  }
  float A = pow(a.x, e2) + pow(a.z, e2);
  float rr = pow(A, 1.0/e2);
  float F = pow(pow(rr, e1) + pow(a.y, e1), 1.0/e1);
  if (F < 1e-9) return -min(r.x, min(r.y, r.z));
  float Ae = max(pow(ae.x, e2) + pow(ae.z, e2), 1e-12);
  float re = pow(Ae, 1.0/e2);
  float Be = max(pow(re, e1) + pow(ae.y, e1), 1e-12);
  float Bp = pow(Be, 1.0/e1 - 1.0), rp = pow(re, e1 - 1.0), Ap = pow(Ae, 1.0/e2 - 1.0);
  vec3 g = vec3(Bp*rp*Ap*pow(ae.x, e2-1.0)*sgn.x/r.x,
                Bp*pow(ae.y, e1-1.0)*sgn.y/r.y,
                Bp*rp*Ap*pow(ae.z, e2-1.0)*sgn.z/r.z);
  return (F - 1.0) / max(length(g), 1e-9);
}
float sdBox(vec3 q, vec3 b){
  vec3 d = abs(q) - b;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}
float sdEllipsoid(vec3 q, vec3 r){
  float k0 = length(q / r);
  float k1 = length(q / (r * r));
  if (k1 < 1e-9) return -min(r.x, min(r.y, r.z));
  return k0 * (k0 - 1.0) / k1;
}
/* 2D: 点から楕円「曲線」までの符号付き距離 (IQ sdEllipse)。4次方程式の解析解。
   近似だと過大評価して球面追跡が貫通するので厳密解を使う。a==b は l=0 で0除算 → 円で返す。
   エンジン dist/sdf.cpp の sd_ellipse_2d と同式 */
float sdEllipse2D(vec2 p, vec2 ab){
  p = abs(p);
  if (abs(ab.x-ab.y) < 1e-6) return length(p) - ab.x;
  if (p.x > p.y){ p = p.yx; ab = ab.yx; }
  float l = ab.y*ab.y - ab.x*ab.x;
  float m = ab.x*p.x/l; float m2 = m*m;
  float n = ab.y*p.y/l; float n2 = n*n;
  float c = (m2+n2-1.0)/3.0; float c3 = c*c*c;
  float q2 = c3 + m2*n2*2.0;
  float d = c3 + m2*n2;
  float g = m + m*n2;
  float co;
  if (d < 0.0){
    float h = acos(clamp(q2/c3, -1.0, 1.0))/3.0;
    float s = cos(h);
    float t = sin(h)*sqrt(3.0);
    float rx = sqrt(max(0.0, -c*(s+t+2.0) + m2));
    float ry = sqrt(max(0.0, -c*(s-t+2.0) + m2));
    co = (ry + sign(l)*rx + abs(g)/(rx*ry + 1e-30) - m)*0.5;
  } else {
    float h  = 2.0*m*n*sqrt(d);
    float s  = sign(q2+h)*pow(abs(q2+h), 1.0/3.0);
    float u  = sign(q2-h)*pow(abs(q2-h), 1.0/3.0);
    float rx = -s - u - c*4.0 + 2.0*m2;
    float ry = (s - u)*sqrt(3.0);
    float rm = length(vec2(rx, ry));
    co = (ry/sqrt(max(1e-30, rm-rx)) + 2.0*g/(rm + 1e-30) - m)*0.5;
  }
  co = clamp(co, -1.0, 1.0);
  vec2 r = ab * vec2(co, sqrt(max(0.0, 1.0-co*co)));
  return length(r-p) * (p.y < r.y ? -1.0 : 1.0);
}
/* 楕円トーラス: リングは y=const 平面上 → 点→リング曲線の距離は
   「xz射影から楕円曲線までの2D距離」と「yのずれ」の直交合成 (厳密) */
float sdTorusEllipse(vec3 q, vec2 ab, float mi){
  return length(vec2(sdEllipse2D(q.xz, ab), q.y)) - mi;
}
float sdTorus(vec3 q, float ma, float mi){
  return length(vec2(length(q.xz) - ma, q.y)) - mi;
}
float sdBoxFrame(vec3 pq, vec3 b, float e){
  vec3 p = abs(pq) - b;
  vec3 q = abs(p + e) - e;
  float t1 = length(max(vec3(p.x,q.y,q.z),0.0)) + min(max(p.x,max(q.y,q.z)),0.0);
  float t2 = length(max(vec3(q.x,p.y,q.z),0.0)) + min(max(q.x,max(p.y,q.z)),0.0);
  float t3 = length(max(vec3(q.x,q.y,p.z),0.0)) + min(max(q.x,max(q.y,p.z)),0.0);
  return min(min(t1,t2),t3);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-12), 0.0, 1.0);
  return length(pa - ba*h) - r;
}
float sdCylinder(vec3 q, float r, float h){
  vec2 d = vec2(length(q.xz) - r, abs(q.y) - h);
  return min(max(d.x,d.y),0.0) + length(max(d,0.0));
}
float sdCylinderAB(vec3 p, vec3 a, vec3 b, float r){
  vec3 ba = b - a, pa = p - a;
  float baba = dot(ba,ba), paba = dot(pa,ba);
  float x = length(pa*baba - ba*paba) - r*baba;
  float y = abs(paba - baba*0.5) - baba*0.5;
  float x2 = x*x, y2 = y*y*baba;
  float d = (max(x,y) < 0.0) ? -min(x2,y2) : ((x>0.0?x2:0.0)+(y>0.0?y2:0.0));
  return sign(d)*sqrt(abs(d))/baba;
}
float sdRoundCone(vec3 l, float r1, float r2, float h){
  vec2 q = vec2(length(l.xz), l.y);
  float b = (r1-r2)/h, a = sqrt(max(1.0-b*b,0.0));
  float k = dot(q, vec2(-b,a));
  if (k < 0.0) return length(q) - r1;
  if (k > a*h) return length(q - vec2(0.0,h)) - r2;
  return dot(q, vec2(a,b)) - r1;
}
float sdRoundConeAB(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a;
  float l2 = dot(ba,ba), rr = r1-r2, a2 = l2-rr*rr, il2 = 1.0/max(l2,1e-12);
  vec3 pa = p - a;
  float y = dot(pa,ba), z = y - l2;
  vec3 xv = pa*l2 - ba*y;
  float x2 = dot(xv,xv), y2 = y*y*l2, z2 = z*z*l2;
  float k = sign(rr)*rr*rr*x2;
  if (sign(z)*a2*z2 > k) return sqrt(x2+z2)*il2 - r2;
  if (sign(y)*a2*y2 < k) return sqrt(x2+y2)*il2 - r1;
  return (sqrt(x2*a2*il2)+y*rr)*il2 - r1;
}
/* sweep のセグメント: 零長は大きい方の球に退化 (エンジン sd_sweep と同じ) */
float sdSweepSeg(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a;
  if (dot(ba,ba) < 1e-12) return length(p - a) - max(r1, r2);
  return sdRoundConeAB(p, a, b, r1, r2);
}
/* 2D閉ポリゴンの符号付き距離 (IQ sdPolygon, dist/sdf.cpp sd_polygon2 と同式)。
   頂点は parAt(plOff + 2*i) から m 個 (sweep 任意断面用) */
float sdPolyUV(vec2 q, int plOff, int m){
  vec2 v0 = vec2(parAt(plOff), parAt(plOff+1));
  float d = dot(q - v0, q - v0);
  float s = 1.0;
  for (int i = 0, j = m - 1; i < m; j = i, i++){
    vec2 vi = vec2(parAt(plOff+2*i), parAt(plOff+2*i+1));
    vec2 vj = vec2(parAt(plOff+2*j), parAt(plOff+2*j+1));
    vec2 e = vj - vi, w = q - vi;
    vec2 b = w - e * clamp(dot(w,e) / max(dot(e,e), 1e-30), 0.0, 1.0);
    d = min(d, dot(b,b));
    bvec3 c = bvec3(q.y >= vi.y, q.y < vj.y, e.x*w.y > e.y*w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
/* lathe 開シェル: 開折れ線(r,y)*m への無符号距離 - 厚み (dist/sdf.cpp sd_lathe thick>0 と同式) */
float sdLatheShell(vec2 q, int plOff, int m, float thick){
  float d = 1e30;
  for (int i = 0; i < m - 1; i++){
    vec2 a = vec2(parAt(plOff+2*i),   parAt(plOff+2*i+1));
    vec2 b = vec2(parAt(plOff+2*i+2), parAt(plOff+2*i+3));
    vec2 e = b - a, w = q - a;
    vec2 pr = w - e * clamp(dot(w,e) / max(dot(e,e), 1e-30), 0.0, 1.0);
    d = min(d, dot(pr,pr));
  }
  return sqrt(d) - thick;
}
/* sweep 任意断面のセグメント距離 (dist/sdf.cpp sd_sweep_prof_chunk と同式):
   最近接t → RMFフレーム補間(Tに直交化) → 断面2D距離×スケール → マイタpad付き
   opExtrusion 結合 → fac 保守化。off=path(x,y,z,s)*n, fOff=フレームN*3n,
   pdOff=pad*n, fcOff=fac*nseg, plOff=断面(u,v)*m */
float sdSweepProfSeg(vec3 p, int off, int n, int i, int fOff, int pdOff, int fcOff, int plOff, int m){
  int i1 = (i + 1) % n;
  vec3 A = vec3(parAt(off+4*i),  parAt(off+4*i+1),  parAt(off+4*i+2));
  vec3 B = vec3(parAt(off+4*i1), parAt(off+4*i1+1), parAt(off+4*i1+2));
  vec3 ba = B - A;
  float l2 = dot(ba, ba);
  if (l2 < 1e-12) return 1e9;
  float L = sqrt(l2);
  vec3 T = ba / L;
  vec3 q = p - A;
  float w = dot(q, T);
  float tc = clamp(w / L, 0.0, 1.0);
  float padA = parAt(pdOff+i), padB = parAt(pdOff+i1);
  float es = abs(w - (L + padB - padA)*0.5) - (L + padA + padB)*0.5;
  vec3 r = q - T*w;
  vec3 N = mix(vec3(parAt(fOff+3*i),  parAt(fOff+3*i+1),  parAt(fOff+3*i+2)),
               vec3(parAt(fOff+3*i1), parAt(fOff+3*i1+1), parAt(fOff+3*i1+2)), tc);
  N -= T * dot(N, T);
  float nl = length(N);
  if (nl < 1e-9) return 1e9;
  N /= nl;
  vec3 Bv = cross(T, N);
  float s = max(mix(parAt(off+4*i+3), parAt(off+4*i1+3), tc), 1e-6);
  float d2 = sdPolyUV(vec2(dot(r,N), dot(r,Bv)) / s, plOff, m) * s;
  float di = min(max(d2, es), 0.0) + length(max(vec2(d2, es), 0.0));
  return di * parAt(fcOff+i);
}
float sdCappedCone(vec3 l, float h, float r1, float r2){
  vec2 q = vec2(length(l.xz), l.y);
  vec2 k1 = vec2(r2,h), k2 = vec2(r2-r1, 2.0*h);
  vec2 ca = vec2(q.x - min(q.x, (q.y<0.0)?r1:r2), abs(q.y)-h);
  vec2 cb = q - k1 + k2*clamp(dot(k1-q,k2)/max(dot(k2,k2),1e-12), 0.0, 1.0);
  float s = (cb.x<0.0 && ca.y<0.0) ? -1.0 : 1.0;
  return s*sqrt(min(dot(ca,ca), dot(cb,cb)));
}
float sdCappedConeAB(vec3 p, vec3 a, vec3 b, float ra, float rb){
  float rba = rb-ra;
  vec3 ba = b - a;
  float baba = dot(ba,ba);
  vec3 pa = p - a;
  float papa = dot(pa,pa), paba = dot(pa,ba)/max(baba,1e-12);
  float x = sqrt(max(papa - paba*paba*baba, 0.0));
  float cax = max(0.0, x - ((paba<0.5)?ra:rb));
  float cay = abs(paba-0.5)-0.5;
  float k = rba*rba + baba;
  float f = clamp((rba*(x-ra)+paba*baba)/k, 0.0, 1.0);
  float cbx = x-ra-f*rba, cby = paba-f;
  float s = (cbx<0.0 && cay<0.0) ? -1.0 : 1.0;
  return s*sqrt(min(cax*cax+cay*cay*baba, cbx*cbx+cby*cby*baba));
}
float sdCone(vec3 l, float ang, float h){
  vec2 c = vec2(sin(ang), cos(ang));
  vec2 q = h*vec2(c.x/max(c.y,1e-6), -1.0);
  vec2 w = vec2(length(l.xz), l.y);
  vec2 av = w - q*clamp(dot(w,q)/max(dot(q,q),1e-12), 0.0, 1.0);
  vec2 bv = w - q*vec2(clamp(w.x/q.x, 0.0, 1.0), 1.0);
  float kk = sign(q.y);
  float d = min(dot(av,av), dot(bv,bv));
  float s = max(kk*(w.x*q.y - w.y*q.x), kk*(w.y - q.y));
  return sqrt(d)*sign(s);
}
float sdOctahedron(vec3 pq, float s){
  vec3 p = abs(pq);
  float m = p.x+p.y+p.z-s;
  vec3 q;
  if (3.0*p.x < m) q = p.xyz;
  else if (3.0*p.y < m) q = p.yzx;
  else if (3.0*p.z < m) q = p.zxy;
  else return m*0.57735027;
  float k = clamp(0.5*(q.z-q.y+s), 0.0, s);
  return length(vec3(q.x, q.y-s+k, q.z-k));
}
/* sqm と同一の滑らかCSG */
float sUnion(float da, float db, float k){
  k = max(k, 1e-6);
  float h = clamp(0.5 + 0.5*(db-da)/k, 0.0, 1.0);
  return mix(db, da, h) - k*h*(1.0-h);
}
/* ブレンド種別 (エンジン sdf.cpp の sunion_variant/sinter_variant と同式)。
   round = hg_sdf fOpUnionRound (= Head の smin2) / deep = poly と round の深い方 (smin3) /
   chamfer = fOpUnionChamfer */
float sUnionRound(float a, float b, float k){
  k = max(k, 1e-6);
  return max(k, min(a,b)) - length(vec2(max(k-a,0.0), max(k-b,0.0)));
}
float sUnionDeep(float a, float b, float k){ return min(sUnion(a,b,k), sUnionRound(a,b,k)); }
float sUnionCham(float a, float b, float k){
  k = max(k, 1e-6);
  return min(min(a,b), (a - k + b) * 0.70710678);
}
float sInterRound(float a, float b, float k){
  k = max(k, 1e-6);
  return min(-k, max(a,b)) + length(vec2(max(k+a,0.0), max(k+b,0.0)));
}
/* smooth-intersect = -sUnion(-da,-db,k) を展開したもの (エンジン SDF_SINTER と同式) */
float sInter(float da, float db, float k){
  k = max(k, 1e-6);
  float h = clamp(0.5 + 0.5*(da-db)/k, 0.0, 1.0);
  return mix(db, da, h) + k*h*(1.0-h);
}
float sInterDeep(float a, float b, float k){ return max(sInter(a,b,k), sInterRound(a,b,k)); }
float sInterCham(float a, float b, float k){
  k = max(k, 1e-6);
  return max(max(a,b), (a + k + b) * 0.70710678);
}
float sSub(float da, float db, float k){
  k = max(k, 1e-6);
  float h = clamp(0.5 - 0.5*(da+db)/k, 0.0, 1.0);
  return mix(da, -db, h) + k*h*(1.0-h);
}
`;

/* focusSet: 非null時、集合外リーフは距離関数を省いて d=1e9 に。ドラッグ中に
   編集パーツ+隣接だけをレイマーチする「フォーカスシェーダ」用 (layout は不変)。 */
export function buildProgram(doc, focusSet, opts) {
  /* opts.sweepApprox: sweep 任意断面を近似チューブで出す軽量モード (ドラッグ中用)。
     レイアウトが変わるので呼び側は setParams(collectParams(doc, prog.layout)) も行うこと
     opts.lite: 影/AO をスタブ化してコンパイル時間を縮める (下の ${lite} 参照)。
     **レイアウトは lite でも変わらない**ので、精密版と params/テクスチャを共有でき、
     プログラムの差し替えだけで往復できる (app.js の2段コンパイル) */
  const lite = !!(opts && opts.lite);
  const layout = buildLayout(doc, !!(opts && opts.sweepApprox));
  /* 枝刈りガードのバウンディング球は node params の直後 (subSphBase) からパラメータ
     テクスチャに相乗りさせる (emit が guards を埋め、下で parCount を延長)。
     → collectParams が球値を追記し、ドラッグ (updateParams) でも自動更新。viewer 無改修 */
  /* 取込グリッドのスロット割当は emit より前に決める (リーフ発行で参照するため)。
     viewer.setGrids と同じ順序 (collectGrids が単一情報源) */
  const grids = collectGrids(doc);
  layout.gridSlots = new Map(grids.map((g, i) => [g.file, i]));
  layout.guards = [];
  layout.subSphBase = layout.parCount;
  /* 色テクスチャの段数 (part色=上段 / 材質色=下段)。viewer 側と必ず同じ式を使うこと
     (ズレると材質色が別のノードの色を拾う)。collectPartColors と同じ max(1, order.length)。 */
  const colRows = colTexRows(Math.max(1, layout.order.length));
  const visObjs = doc.objects.filter(o => o.visible);
  const nObj = Math.max(1, visObjs.length);

  /* per-object クリーン関数 (emit がガードを layout.guards に積む) */
  const objFns = [];
  visObjs.forEach((obj, i) => {
    const em = new Emitter(layout, false, focusSet);
    const d = em.emit(obj.root, 'p0');
    objFns.push(`float sdObj${i}(vec3 p0){\n${em.lines.join('\n')}\n  return ${d};\n}`);
  });
  if (!visObjs.length) objFns.push('float sdObj0(vec3 p0){ return 1e9; }');
  layout.parCount = layout.subSphBase + layout.guards.length * 4;   /* 球分を確保 */

  /* 計測付き probe (選択ハイライト + ピック + 材質色ブレンド) */
  const probeEm = new Emitter(layout, true, focusSet);
  visObjs.forEach((obj, i) => { probeEm.objIdx = i; probeEm.emit(obj.root, 'p0'); });
  const probeFn = `float probe(vec3 p0, int objSel, out float bestD, out int bestId, out vec3 blendCol, out vec4 matCol){
  float selD = 1e9; bestD = 1e9; bestId = -1;
  vec3 pcAcc = vec3(0.0); float pwAcc = 0.0;
  vec3 mcAcc = vec3(0.0); float mwAcc = 0.0;
${probeEm.lines.join('\n')}
  blendCol = pcAcc / max(pwAcc, 1e-9);
  matCol = vec4(mcAcc, mwAcc);
  return selD;
}`;

  /* オブジェクト単位の境界球ガード: 球までの距離が現在の最小値以上なら
     そのオブジェクトは min に寄与できない → サブツリー評価を丸ごとスキップ。
     スキップしても res.x は真距離の下界のまま (球距離 ≤ 真距離) = trace 安全 */
  const mapBody = visObjs.map((obj, i) => {
    const inner = `float db = length(p - uObjSph[${i}].xyz) - uObjSph[${i}].w;
    if (db < res.x) { float dd = sdObj${i}(p); if (dd < res.x) res = vec2(dd, ${i}.0); }`;
    /* root が plane leaf のオブジェクト = 床 (ground plane) → 「床」チェックに連動させる。
       床OFF で消える → 下からモデルを覗ける (エディタ市松床も uGridOn=0 で消えるので床が完全に無くなる)。
       床ON では市松床が +1e-3 バイアスでこの平面に勝つので、見えるのは市松。 */
    return obj.root && obj.root.type === 'plane'
      ? `  if (uGridOn > 0.5) { ${inner} }`
      : `  { ${inner} }`;
  }).join('\n')
    || '  { float dd = sdObj0(p); if (dd < res.x) res = vec2(dd, 0.0); }';

  /* 枝刈りガード球は「ピクセル毎に1回」だけテクスチャから読んでグローバルに持つ。
     ガード式の中で直接 parAt() すると 1子あたり4 texelFetch × マーチ全ステップ ×
     法線/影の map 呼び出し分だけ読みが走り、枝刈りで浮いた距離関数より高くつく
     (実測: 散布60球で 0.70倍= 逆に遅い → ホイストで 1.93倍)。 */
  const nGuard = layout.guards.length;
  /* GUARD_FAR: 「この距離より遠い子は距離関数を呼ばず下界で代用する」しきい値。
     小さすぎると代用だらけで歩幅が落ちて遅くなり、大きすぎると従来と同じ (代用しない)。
     シーンの大きさに比例させる (絶対値だとモデルのスケールで意味が変わる)。 */
  const sceneR = Math.max(0.5, ...doc.objects.filter(o => o.visible)
    .map(o => { const s = objSphere(o); return s ? s[3] : 0.5; }), 0.5);
  const guardFar = ((typeof window !== 'undefined' && window.__GUARD_FAR_K) || 0.5) * sceneR;
  const guardDecl = nGuard ? `
#define GUARD_FAR ${guardFar.toPrecision(6)}` + `
vec4 gGuard[${nGuard}];   /* 枝刈り用バウンディング球 (xyz=中心, w=半径) */
void initGuards(){ for(int i=0;i<${nGuard};i++){ int b=${layout.subSphBase}+i*4;
  gGuard[i]=vec4(parAt(b),parAt(b+1),parAt(b+2),parAt(b+3)); } }` : '';
  const guardInit = nGuard ? '  initGuards();\n' : '';

  /* ── 取込メッシュの SDF グリッド (3Dテクスチャ) ──
     R32F は WebGL2 既定でフィルタ不可なので NEAREST で張り**手動 trilinear** する
     (dist/sdf.cpp の sd_grid と同じ式)。ベイカーは x-major (z が最速) なので
     texelFetch は ivec3(iz,iy,ix) — viewer の texImage3D(w=nz,h=ny,d=nx) と対。
     格子外は「箱までの距離」と三角不等式 d(C)-|Q-C| の大きい方 = 真距離の下界
     (球面追跡が安全)。エンジンと同じ扱い。 */
  const gridDecl = grids.length ? grids.map((g, i) => `
uniform highp sampler3D uGridTex${i};
uniform vec3  uGridLo${i};      /* 格子原点 (world) */
uniform vec3  uGridDim${i};     /* dims */
uniform float uGridH${i};       /* ボクセル幅 */
float gridAt${i}(ivec3 c){ return texelFetch(uGridTex${i}, ivec3(c.z, c.y, c.x), 0).r; }
float sdGrid${i}(vec3 p, vec3 ctr, float s){
  vec3 f = ((p - ctr) / s - uGridLo${i}) / uGridH${i};
  vec3 mx = uGridDim${i} - 1.0;
  vec3 c  = clamp(f, vec3(0.0), mx);
  float od = length(f - c) * uGridH${i};         /* 格子外なら箱までの距離 (out はGLSL予約語) */
  vec3 i0 = clamp(floor(c), vec3(0.0), mx - 1.0);
  vec3 w  = clamp(c - i0, 0.0, 1.0);
  ivec3 a = ivec3(i0);
  float c00 = mix(gridAt${i}(a+ivec3(0,0,0)), gridAt${i}(a+ivec3(0,0,1)), w.z);
  float c01 = mix(gridAt${i}(a+ivec3(0,1,0)), gridAt${i}(a+ivec3(0,1,1)), w.z);
  float c10 = mix(gridAt${i}(a+ivec3(1,0,0)), gridAt${i}(a+ivec3(1,0,1)), w.z);
  float c11 = mix(gridAt${i}(a+ivec3(1,1,0)), gridAt${i}(a+ivec3(1,1,1)), w.z);
  float d = mix(mix(c00, c01, w.y), mix(c10, c11, w.y), w.x);
  if (od > 0.0) d = max(od, d - od);
  return d * s;
}`).join('\n') : '';
  /* 法線の中心差分幅の下限。trilinear の勾配はセル境界で不連続なので、差分幅が
     ボクセル幅より十分小さいと「セル毎のファセット」が出る。エンジン側で同じ問題を
     踏んで 3ボクセルで消えると実測済み (docs/2026-07-21) → ここでも 3 を使う。 */


  const frag = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uGridNEps;   /* 取込グリッドの法線差分幅の下限 (0=グリッド無し) */
uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uFovTan;
uniform vec3  uBg;
uniform int   uNLights;
uniform vec3  uLightPos[4];
uniform vec3  uLightCol[4];
uniform highp sampler2D uParTex;   /* 数値パラメータ (R32F テクスチャ) */
/* uniform float uPar[] だと GLSL ES の packing で 1要素=1ベクトル消費 → MAX_FRAGMENT_UNIFORM_VECTORS
   (実測1024) で頭打ちになり、sweep の密化やノード数でシェーダがリンクできず真っ暗になっていた。
   テクスチャなら MAX_TEXTURE_SIZE² (実測 16384²=2.7億) まで載る = 実質無制限。
   幅は 2の冪 (PAR_TEX_W) にして & / >> で割り出す。texelFetch なのでフィルタリングは無関係。 */
float parAt(int i){ return texelFetch(uParTex, ivec2(i & ${PAR_TEX_W - 1}, i >> ${PAR_TEX_SHIFT}), 0).r; }${guardDecl}
${gridDecl}
uniform vec4  uObjSph[${nObj}];   /* オブジェクト境界球 (xyz=中心, w=半径。1e9=ガード無効) */
uniform vec3  uObjCol[${nObj}];
uniform highp sampler2D uColTex;   /* パーツ識別色(上段) + 材質色(下段) の RGBA32F */
/* uniform vec3 uPartCol[]/uMatCol[] だと 1ノード=2 vectors 消費し、ノード数だけで上限1024に
   当たっていた (実測: リーフ480個まで。500個で超過)。テクスチャ化して天井を撤廃。
   上段 row=[0,${colRows}) が part 色、下段 row=[${colRows},${colRows * 2}) が材質色。 */
vec3 partColAt(int i){ return texelFetch(uColTex, ivec2(i & ${PAR_TEX_W - 1}, i >> ${PAR_TEX_SHIFT}), 0).rgb; }
vec3 matColAt(int i){ return texelFetch(uColTex, ivec2(i & ${PAR_TEX_W - 1}, (i >> ${PAR_TEX_SHIFT}) + ${colRows}), 0).rgb; }
uniform float uMatOn;
uniform int   uSelId;
uniform float uGridOn, uGridY;
uniform float uAxisOn;
uniform float uPartOn;
uniform float uShadowOn;
uniform float uFast;         /* 1 = 操作中の軽量モード (影/AO をスキップ) */
uniform float uDepthOn;
uniform vec2  uDepthRange;   /* (near, far): 深度の白黒正規化レンジ */
uniform int   uPick;
uniform vec3  uPickRO, uPickRD;

${PRELUDE}
${objFns.join('\n')}
${probeFn}

vec2 map(vec3 p){
  vec2 res = vec2(1e9, -1.0);
${mapBody}
  /* エディタ市松床。同位置 (y=uGridY) の ground plane オブジェクトと距離が等しいとき
     床チェックON なら市松側を優先表示する (+1e-3 バイアス)。→ 床ON=市松グリッド /
     床OFF=シーンの ground plane、と使い分けられる (メッシュモードの床と見た目が揃う)。 */
  if (uGridOn > 0.5) { float dg = p.y - uGridY; if (dg < res.x + 1e-3) res = vec2(dg, 98.0); }
  return res;
}

vec3 calcNormal(vec3 p, float t){
  /* 取込グリッドがあると trilinear の勾配がセル境界で不連続 → 差分幅がボクセル幅より
     十分小さいとセル毎のファセットが出る。エンジンで 3ボクセルなら消えると実測済み
     (docs/2026-07-21) なので、その値を下限にする。 */
  float h = max(max(3e-4, t * 2e-4), uGridNEps);
  /* ⚠ 4タップは**ループで回す** (IQ の定石)。べた書きすると map() の静的呼び出し
     箇所が 4 つになり、ANGLE→HLSL→FXC が SDF ツリーを 4 回インライン展開する。
     コンパイル時間は展開コピー数に対して**超線形**に伸びるので、ここだけで
     効き方が大きい (RTX 3090 / 24リーフ 34KB で実測 55.1秒 → 32.4秒 = −41%。
     ソース長はほぼ不変 34.1→34.2KB なので、効いているのは長さでなく展開回数)。
     方向ベクトルは元のべた書きと同一: i=0..3 が (+,-,-) (-,-,+) (-,+,-) (+,+,+)
     = 従来の e.xyy / e.yyx / e.yxy / e.xxx に一致し、加算順序も同じ。 */
  vec3 nsum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 e = 0.5773 * (2.0 * vec3(float((i+3)>>1 & 1), float((i>>1) & 1), float(i & 1)) - 1.0) * h;
    nsum += e * map(p + e).x;
  }
  return normalize(nsum);
}

vec2 march(vec3 ro, vec3 rd){
  float t = 0.02, m = -1.0;
  for (int i = 0; i < 200; i++) {
    vec2 h = map(ro + rd * t);
    if (h.x < max(6e-4, t * 4e-4)) { m = h.y; break; }
    t += h.x * 0.85;   /* CSG max による下界崩れ対策 (sqm と同係数) */
    if (t > 250.0) break;
  }
  return vec2(t, m);
}

${lite ? `/* ── 軽量モード (opts.lite) ──────────────────────────────────
   影と AO を**コンパイル時に**落としてスタブ化する。狙いは実行速度ではなく
   **コンパイル時間**: この2つは map() の静的呼び出し箇所を2つ占め、
   ANGLE→HLSL→FXC は呼び出しごとに SDF ツリーを丸ごとインライン展開するため、
   コンパイル時間が展開コピー数に対して超線形に伸びる。
   実測 (RTX 3090 / 24リーフ 34KB): 呼び出し 5箇所 32.4秒 → 3箇所 11.3秒。
   構造編集のたびに走る再コンパイルをこれで短縮し、精密版 (影/AO あり) は
   編集が落ち着いてから裏で焼いて差し替える (app.js の2段コンパイル)。 */
float softShadow(vec3 ro, vec3 rd, float tmax){ return 1.0; }
float calcAO(vec3 p, vec3 n){ return 1.0; }` : `float softShadow(vec3 ro, vec3 rd, float tmax){
  float res = 1.0, t = 0.03;
  for (int i = 0; i < 48; i++) {
    float h = map(ro + rd * t).x;
    if (h < 5e-4) return 0.0;
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.01, 0.6);
    if (t > tmax) break;
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n){
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.02 + 0.11 * float(i);
    float d = map(p + n * h).x;
    occ += (h - d) * sca;
    sca *= 0.75;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}`}

vec3 shade(vec3 ro, vec3 rd, float t, float m, out float selD){
  vec3 p = ro + rd * t;
  vec3 n = calcNormal(p, t);
  float bd; int bi; vec3 bc; vec4 mc;
  selD = probe(p, (m > 97.5 ? -1 : int(m + 0.5)), bd, bi, bc, mc);
  vec3 alb;
  if (m > 97.5) {  /* グリッド床 */
    float ch = mod(floor(p.x) + floor(p.z), 2.0);
    alb = mix(vec3(0.32), vec3(0.42), ch);
    vec2 g = abs(fract(p.xz) - 0.5);
    float ln = smoothstep(0.47, 0.5, max(g.x, g.y));
    alb = mix(alb, vec3(0.2), ln * 0.6);
  } else if (uPartOn > 0.5 && bi >= 0) {
    alb = bc;   /* パーツ識別色 (ブレンド域は距離比のグラデーション) */
  } else if (uMatOn > 0.5 && mc.a > 1e-7) {
    alb = mc.rgb / mc.a;   /* 材質色: object内の葉の重み付きブレンド (融合面はグラデ) */
  } else {
    alb = uObjCol[int(m + 0.5)];
  }
  float ao = uFast > 0.5 ? 1.0 : calcAO(p, n);   /* 操作中はAOスキップ */
  vec3 col = alb * mix(vec3(0.22), uBg + 0.12, 0.55) * 0.55 * ao;  /* 環境項 */
  for (int i = 0; i < 4; i++) {
    if (i >= uNLights) break;
    vec3 lv = uLightPos[i] - p;
    float ld = length(lv);
    vec3 l = lv / ld;
    float dif = max(dot(n, l), 0.0);
    float sh = 1.0;
    if (i == 0 && uShadowOn > 0.5 && uFast < 0.5 && dif > 0.0) sh = softShadow(p + n * 2e-3, l, ld);
    vec3 h = normalize(l - rd);
    float spe = pow(max(dot(n, h), 0.0), 32.0) * 0.35;
    col += (alb * dif + spe * dif) * uLightCol[i] * sh;
  }
  float fre = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
  col += fre * (uBg + 0.1) * 0.18 * ao;
  return col;
}

/* レイと線分の最短距離 (tRay = レイ側の最近接パラメータ) — 軸クロス描画用 */
float distRaySeg(vec3 ro, vec3 rd, vec3 a, vec3 b, out float tRay){
  vec3 ba = b - a, oa = ro - a;
  float B = dot(rd, ba), C = dot(ba, ba);
  float D = dot(rd, oa), E = dot(ba, oa);
  float den = max(C - B * B, 1e-9);
  float s = clamp((E - D * B) / den, 0.0, 1.0);
  tRay = max(0.0, s * B - D);
  return length(ro + rd * tRay - (a + ba * s));
}
/* 軸1本 (dir 方向 ±2, 負側は減光) を col に合成 */
vec3 axisSeg(vec3 col, vec3 ro, vec3 rd, float tHit, vec3 dir, vec3 acol){
  for (int s = 0; s < 2; s++) {
    vec3 b = dir * (s == 0 ? 2.0 : -2.0);
    float tR;
    float d = distRaySeg(ro, rd, vec3(0.0), b, tR);
    if (tR < tHit && tR > 0.0) {
      float w = tR * 2.0 * uFovTan / uRes.y * 1.6;   /* ≈1.6px 幅 */
      float a = (1.0 - smoothstep(w * 0.4, w, d)) * (s == 0 ? 0.85 : 0.3);
      col = mix(col, acol, a);
    }
  }
  return col;
}
/* 原点の三次元クロスライン (X=赤 Y=緑 Z=青, シーンに遮蔽される) */
vec3 axisOverlay(vec3 col, vec3 ro, vec3 rd, float tHit){
  col = axisSeg(col, ro, rd, tHit, vec3(1.0,0.0,0.0), vec3(0.9,0.28,0.28));
  col = axisSeg(col, ro, rd, tHit, vec3(0.0,1.0,0.0), vec3(0.3,0.8,0.32));
  col = axisSeg(col, ro, rd, tHit, vec3(0.0,0.0,1.0), vec3(0.3,0.55,0.95));
  return col;
}

vec3 render(vec3 ro, vec3 rd, out float tHit){
  vec2 h = march(ro, rd);
  float vgrad = 0.5 + 0.5 * rd.y;
  vec3 bg = uBg * (0.85 + 0.3 * vgrad);
  tHit = (h.y < -0.5) ? 1e9 : h.x;
  if (h.y < -0.5) return bg;
  float selD;
  vec3 col = shade(ro, rd, h.x, h.y, selD);
  if (uSelId >= 0 && selD < max(0.012, h.x * 0.004))
    col = mix(col, vec3(1.0, 0.62, 0.15), 0.5);
  /* 距離フォグ的な奥行きなじませ */
  col = mix(col, bg, 1.0 - exp(-0.00035 * h.x * h.x));
  return col;
}

/* レイマーチのヒット距離を Z バッファ深度へ (viewer._mvp の near/far と一致必須 —
   メッシュ文脈/blobメッシュとの深度合成に使う)。miss は 1.0 */
#define DEPTH_NEAR 0.02
#define DEPTH_FAR  800.0
float ndcDepth(vec3 rd, float tHit){
  if (tHit > 1e8) return 1.0;
  float zd = max(dot(rd, uCamFwd) * tHit, DEPTH_NEAR);   /* 視線前方距離 */
  float nf = DEPTH_NEAR - DEPTH_FAR;
  float ndc = -(DEPTH_FAR + DEPTH_NEAR) / nf + 2.0 * DEPTH_FAR * DEPTH_NEAR / (nf * zd);
  return clamp(0.5 * ndc + 0.5, 0.0, 1.0);
}

void main(){
${guardInit}  if (uPick == 1) {
    vec2 h = march(uPickRO, uPickRD);
    int id = -1;
    if (h.y > -0.5 && h.y < 97.5) {
      float bd; int bi; vec3 bc; vec4 mcp;
      probe(uPickRO + uPickRD * h.x, -1, bd, bi, bc, mcp);
      id = bi;
    }
    float enc = float(id + 1);
    fragColor = vec4(mod(enc, 256.0) / 255.0, floor(enc / 256.0) / 255.0, 0.0, 1.0);
    gl_FragDepth = 1.0;
    return;
  }
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 rd = normalize(uCamFwd + uFovTan * (uv.x * uCamRight + uv.y * uCamUp));
  float tHit;
  vec3 col = render(uCamPos, rd, tHit);
  gl_FragDepth = ndcDepth(rd, tHit);
  if (uDepthOn > 0.5) {   /* 深度モード: 近=白, 遠=黒 (sqm depth シェーダー相当, リニア出力) */
    float v = tHit > 1e8 ? 0.0
            : clamp(1.0 - (tHit - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-6), 0.0, 1.0);
    fragColor = vec4(vec3(v), 1.0);
    return;
  }
  if (uAxisOn > 0.5) col = axisOverlay(col, uCamPos, rd, tHit);
  col = col / (1.0 + col * 0.15);           /* 弱トーンマップ */
  col = pow(max(col, 0.0), vec3(1.0 / 2.2)); /* ガンマ */
  fragColor = vec4(col, 1.0);
}
`;

  const colors = visObjs.map(o => surfaceColor(o.surface));
  if (!colors.length) colors.push([0.7, 0.7, 0.7]);
  return { frag, layout, colors, nObj };
}
