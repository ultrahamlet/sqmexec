/* blobnode.js — native blob (メタボール) ノードの幾何と収集 (2026-08-23)
 *
 * ⚠ 回転規約: blob の (rot ..) は sqm の row-vector p·(S·Rx·Ry·Rz) 規約。
 *   列ベクトルで書くとジオメトリ回転は R_geo = Rzᵐ·Ryᵐ·Rxᵐ (ᵐ = model.js の
 *   個別行列) — eulerToMat (= Rx·Ry·Rz) と**合成順が逆**なので専用関数を持つ。
 *   検証: 書き出した .ssq を ssq_edit --obj / mbmesh_test でメッシュ比較。
 *
 * DOM 非依存 (scale.js / model.js から import される)。 */
import { SCHEMA, surfaceColor } from './model.js';
import { matmul3 } from './anchor.js';

const D2R = Math.PI / 180;

/* blob の (rot rx ry rz) [度] → ジオメトリ回転 (row-major, 列ベクトル作用) */
export function blobRotMat(rxDeg, ryDeg, rzDeg) {
  const rx = rxDeg * D2R, ry = ryDeg * D2R, rz = rzDeg * D2R;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const mx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const my = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const mz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return matmul3(mz, matmul3(my, mx));   /* ZYX = (row-vector Rx·Ry·Rz)ᵀ */
}

/* R = Rz·Ry·Rx の分解 (度)。復元一致しなければ null */
export function blobMatToEulerDeg(m) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ry = Math.asin(clamp(-m[6], -1, 1));
  let rx, rz;
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(m[7], m[8]);
    rz = Math.atan2(m[3], m[0]);
  } else {
    rz = 0;
    rx = Math.atan2(-m[5], m[4]);
  }
  const d = 180 / Math.PI;
  const r = blobRotMat(rx * d, ry * d, rz * d);
  for (let i = 0; i < 9; i++) if (Math.abs(r[i] - m[i]) > 1e-4) return null;
  return [rx * d, ry * d, rz * d];
}

/* weight → 正規化可視半径 (thresh_ratio)。sqm fill_blob / mbmesh.c と同じ二分法。
 * weight 3 で ≈0.614 (「表面較正 0.614×scale」の出所) */
export function threshFromWeight(weight) {
  const wr = Math.abs(weight);
  if (wr <= 1.0) return 0;
  const wyvill2 = r2 => {                 /* vclay VC_wyvill2 と同じ多項式 */
    if (r2 >= 1) return 0;
    const r4 = r2 * r2;
    return 1 - (4 / 9) * r4 * r2 + (17 / 9) * r4 - (22 / 9) * r2;
  };
  let cur = 1 - 1 / wr, left = 0, right = 1;
  for (let i = 0; i < 5; i++) {
    let wy = wyvill2(cur * cur);
    if (wy < 1e-12) wy = 1e-12;
    if (1 / wy < wr) { left = cur; cur = (left + right) / 2; }
    else             { right = cur; cur = (left + right) / 2; }
  }
  return cur;
}

/* 可視半径係数 (threshold 明示ならそれ、無ければ weight から) */
export function visibleRatio(props) {
  return props.threshold !== 0 ? Math.abs(props.threshold)
                               : threshFromWeight(props.weight);
}

/* ── 収集: 1 object の blob を「ワールドに焼いた」形で列挙する ──
 * 祖先 xform は translate / rotate / rotate-mat を合成して pos と rot に畳む。
 * mirror / repeat / scale / elongate 等の祖先は blob には畳めない → tainted。
 * mcolor は SDF と同じ継承則 (最も近い祖先の材質色) で解決して mcolor に入れる
 * (無ければ null = object surface 色に落ちる)。
 * mesh リーフ ((mesh (file ..)) — 第8弾) も同じ walk で焼く: engine obj_loader の
 * 変換 (scale→Rx→Ry→Rz→translate) は blob と同じ ZYX 合成なので回転の畳みは共通。
 * 返り値: { blobs: [{node, pos, rotDeg, rotMat, mcolor, tainted}],
 *           meshes: [{node, pos, rotDeg, rotMat, tainted}], warnings: [..] } */
export function collectObjectBlobs(root, { includeHidden = false } = {}) {
  const blobs = [], meshes = [], warnings = [];
  if (!root) return { blobs, meshes, warnings };
  const walk = (n, off, R, tainted, mcol) => {
    if (n.hidden && !includeHidden) return;
    if (n.type === 'mesh') {
      if (tainted && !warnings.includes(tainted)) warnings.push(tainted);
      const p = n.props;
      const Rm = matmul3(R, blobRotMat(p.rot[0], p.rot[1], p.rot[2]));
      const e = blobMatToEulerDeg(Rm) || p.rot.slice();
      const c = p.center;
      meshes.push({ node: n, tainted,
        pos: [R[0] * c[0] + R[1] * c[1] + R[2] * c[2] + off[0],
              R[3] * c[0] + R[4] * c[1] + R[5] * c[2] + off[1],
              R[6] * c[0] + R[7] * c[1] + R[8] * c[2] + off[2]],
        rotDeg: e, rotMat: Rm });
      return;
    }
    const sc = SCHEMA[n.type] || { kind: 'leaf' };
    if (n.props && n.props.mcolor) mcol = n.props.mcolor;
    if (n.type === 'blob') {
      if (tainted && !warnings.includes(tainted)) warnings.push(tainted);
      const p = n.props;
      const Rb = matmul3(R, blobRotMat(p.rot[0], p.rot[1], p.rot[2]));
      const e = blobMatToEulerDeg(Rb) || p.rot.slice();
      const c = p.center;
      const w = [
        R[0] * c[0] + R[1] * c[1] + R[2] * c[2] + off[0],
        R[3] * c[0] + R[4] * c[1] + R[5] * c[2] + off[1],
        R[6] * c[0] + R[7] * c[1] + R[8] * c[2] + off[2],
      ];
      blobs.push({ node: n, pos: w, rotDeg: e, rotMat: Rb,
                   mcolor: mcol ? mcol.slice() : null, tainted });
      return;
    }
    if (sc.kind === 'leaf') return;
    let off2 = off, R2 = R, taint2 = tainted;
    if (n.type === 'translate') {
      const t = n.props.t;
      off2 = [
        off[0] + R[0] * t[0] + R[1] * t[1] + R[2] * t[2],
        off[1] + R[3] * t[0] + R[4] * t[1] + R[5] * t[2],
        off[2] + R[6] * t[0] + R[7] * t[1] + R[8] * t[2]];
    } else if (n.type === 'rotate' || n.type === 'rotate-mat') {
      const p = n.props;
      let S;
      if (n.type === 'rotate') {
        const d = p.deg, dd = Math.PI / 180;
        /* SDF rotate は eulerToMat = Rx·Ry·Rz (model.js) — import 循環を
           避けるため個別行列でここに再構成 */
        const cx = Math.cos(d[0] * dd), sx = Math.sin(d[0] * dd);
        const cy = Math.cos(d[1] * dd), sy = Math.sin(d[1] * dd);
        const cz = Math.cos(d[2] * dd), sz = Math.sin(d[2] * dd);
        S = matmul3([1, 0, 0, 0, cx, -sx, 0, sx, cx],
              matmul3([cy, 0, sy, 0, 1, 0, -sy, 0, cy],
                      [cz, -sz, 0, sz, cz, 0, 0, 0, 1]));
      } else {
        S = [p.m0, p.m1, p.m2, p.m3, p.m4, p.m5, p.m6, p.m7, p.m8];
      }
      const pv = p.pivot || [0, 0, 0];
      /* x' = pivot + S(x - pivot) を off/R に合成 */
      const t = [
        pv[0] - (S[0] * pv[0] + S[1] * pv[1] + S[2] * pv[2]),
        pv[1] - (S[3] * pv[0] + S[4] * pv[1] + S[5] * pv[2]),
        pv[2] - (S[6] * pv[0] + S[7] * pv[1] + S[8] * pv[2])];
      off2 = [
        off[0] + R[0] * t[0] + R[1] * t[1] + R[2] * t[2],
        off[1] + R[3] * t[0] + R[4] * t[1] + R[5] * t[2],
        off[2] + R[6] * t[0] + R[7] * t[1] + R[8] * t[2]];
      R2 = matmul3(R, S);
    } else if (sc.kind === 'xform') {
      taint2 = `blob は ${n.type} 祖先を畳めない (位置だけ近似)`;
    }
    n.children.forEach(c => walk(c, off2, R2, taint2, mcol));
  };
  walk(root, [0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], null, null);
  return { blobs, meshes, warnings };
}

/* doc の可視 blob を mbmesh.h 準拠のレコード (23 double/個) にする。
 * 色 = ノードの材質色 (mcolor) があればそれ、なければオブジェクトの surface 色 —
 * vclay evalSurf が密度寄与でブレンドするので sqm の「色が場で混ざる」に一致する。
 * 返り値: { records: number[], picks: [{node, objIdx, pos, rotMat, scale, vr}],
 *           warnings: [..] } */
export function collectSceneBlobs(doc) {
  const recs = [], picks = [], warnings = [];
  doc.objects.forEach((obj, objIdx) => {
    if (!obj.visible) return;
    const objCol = surfaceColor(obj.surface);
    const { blobs, warnings: w } = collectObjectBlobs(obj.root);
    for (const msg of w) if (!warnings.includes(msg)) warnings.push(msg);
    for (const b of blobs) {
      const p = b.node.props;
      const isSuper = (p.isSuper || p.e1 !== 2 || p.e2 !== 2 || p.e3 !== 2) ? 1 : 0;
      const col = b.mcolor || objCol;
      recs.push(
        b.pos[0], b.pos[1], b.pos[2],
        p.scale[0], p.scale[1], p.scale[2],
        b.rotDeg[0], b.rotDeg[1], b.rotDeg[2],
        p.weight, p.threshold,
        p.e1, p.e2, p.e3, isSuper, p.group,
        col[0], col[1], col[2],
        p.deformAmp || 0, p.deformFreq || 0, p.deformPhase || 0, p.deformMode || 0);
      picks.push({ node: b.node, objIdx, pos: b.pos, rotMat: b.rotMat,
                   scale: p.scale.slice(), vr: visibleRatio(p) });
    }
  });
  return { records: recs, picks, warnings };
}

/* レイ (ro, rd) と可視楕円体の交差で blob をピック。最近ヒットの pick 要素か null */
export function rayPickBlob(picks, ro, rd) {
  let best = null, bestT = Infinity;
  for (const pk of picks) {
    /* ローカルへ: v = Rᵀ(p - pos), 半径 = scale*vr の楕円体 */
    const R = pk.rotMat;
    const o = [ro[0] - pk.pos[0], ro[1] - pk.pos[1], ro[2] - pk.pos[2]];
    const lo = [R[0] * o[0] + R[3] * o[1] + R[6] * o[2],
                R[1] * o[0] + R[4] * o[1] + R[7] * o[2],
                R[2] * o[0] + R[5] * o[1] + R[8] * o[2]];
    const ld = [R[0] * rd[0] + R[3] * rd[1] + R[6] * rd[2],
                R[1] * rd[0] + R[4] * rd[1] + R[7] * rd[2],
                R[2] * rd[0] + R[5] * rd[1] + R[8] * rd[2]];
    const rr = pk.scale.map(s => Math.max(1e-6, s * pk.vr));
    const so = [lo[0] / rr[0], lo[1] / rr[1], lo[2] / rr[2]];
    const sd = [ld[0] / rr[0], ld[1] / rr[1], ld[2] / rr[2]];
    const a = sd[0] * sd[0] + sd[1] * sd[1] + sd[2] * sd[2];
    const b = 2 * (so[0] * sd[0] + so[1] * sd[1] + so[2] * sd[2]);
    const c = so[0] * so[0] + so[1] * so[1] + so[2] * so[2] - 1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t > 0.02 && t < bestT) { bestT = t; best = pk; }
  }
  if (best) best.pickT = bestT;   /* mesh(OBJ) ピックとの最近傍比較用 */
  return best;
}

/* .ssq の 1 行に焼く (%.9g 相当。rot の桁落ちで保存ごとに形が動く事故を防ぐ) */
const g9 = v => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return String(parseFloat(n.toPrecision(9)));
};

export function blobLine(props, pos = null, rotDeg = null) {
  const p = props;
  const c = pos || p.center, r = rotDeg || p.rot;
  const isSuper = p.isSuper || p.e1 !== 2 || p.e2 !== 2 || p.e3 !== 2;
  let s = `(blob (weight ${g9(p.weight)})`;
  if (p.threshold !== 0) s += `(threshold ${g9(p.threshold)})`;
  s += `(group ${Math.round(p.group)})`;
  s += `(pos ${c.map(g9).join(' ')})`;
  s += `(scale ${p.scale.map(g9).join(' ')})`;
  s += `(rot ${r.map(g9).join(' ')})`;
  if (isSuper) s += `(super ${[p.e1, p.e2, p.e3].map(g9).join(' ')})`;
  if (p.deformAmp)
    s += `(deform ${g9(p.deformAmp)} ${g9(p.deformFreq)} ${g9(p.deformPhase)}` +
         (p.deformMode ? ` ${Math.round(p.deformMode)})` : ')');
  return s + ')';
}

/* (mesh ..) の 1 行に焼く。smooth は props から (smooth 1) を起こし、
 * その他の extra (use-mtl/group-surface 等) はそのまま戻す */
export function meshLine(props, pos = null, rotDeg = null) {
  const p = props;
  const c = pos || p.center, r = rotDeg || p.rot;
  let s = `(mesh (file "${p.file}")`;
  if (c.some(v => v)) s += ` (pos ${c.map(g9).join(' ')})`;
  if (p.scale.some(v => v !== 1)) s += ` (scale ${p.scale.map(g9).join(' ')})`;
  if (r.some(v => v)) s += ` (rot ${r.map(g9).join(' ')})`;
  if (p.smooth) s += ' (smooth 1)';
  for (const x of (p.extra || [])) s += ' ' + x;
  return s + ')';
}
