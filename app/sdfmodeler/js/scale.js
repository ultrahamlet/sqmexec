/* scale.js — スケールギズモのリーフ別仕様 (DOM 非依存 = node テスト可)。
 * 「どの軸ハンドルを出すか (ノードローカル方向)」と「倍率 s の適用」を定義する。
 *
 * 軸の意味 (axis 引数): -1 = 一様 / 0,1,2 = scaleAxesFor が返す方向の index。
 *   center 系リーフ: 0/1/2 = ローカル X/Y/Z
 *   a/b 端点系:      0 = 部品軸 u (長さの伸縮),  1/2 = 垂直 (radius)
 * 一様スケールは全対応リーフで可 (sphere/octahedron は一様のみ = 軸ハンドル無し)。
 * plane / raw / CSG / 変換ノードは null (スケール不可 → ギズモ非表示)。 */

import { blobRotMat } from './blobnode.js';

const MIN_DIM = 1e-3;
const D2R = Math.PI / 180;
const clampDim = v => Math.max(MIN_DIM, v);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/* a/b 端点系の直交基底: [部品軸 u, 垂直 v, 垂直 w] */
function abBasis(a, b) {
  const u = norm(sub(b, a));
  const ref = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v = norm(cross(u, ref));
  return [u, v, cross(u, v)];
}

/* 軸ハンドルのノードローカル方向の配列。[] = 一様のみ / null = スケール不可 */
export function scaleAxesFor(node) {
  const p = node.props;
  if (p.a && p.b) return abBasis(p.a, p.b);
  switch (node.type) {
    case 'sphere': case 'octahedron':
      return [];
    case 'box': case 'box-frame': case 'ellipsoid': case 'superquad':
    case 'torus': case 'cylinder': case 'round-cone': case 'capped-cone': case 'cone':
    case 'sweep':
      return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    case 'blob': case 'mesh': {
      /* blob / mesh は rot が intrinsic なので、軸ハンドルは回転後のローカル軸に出す */
      const R = blobRotMat(p.rot[0], p.rot[1], p.rot[2]);
      return [[R[0], R[3], R[6]], [R[1], R[4], R[7]], [R[2], R[5], R[8]]];
    }
    default:
      return null;
  }
}

/* 倍率 s を orig (ドラッグ開始時の props の深いコピー) 基準で node.props に適用。
 * 適用したら true。s は [0.01, 100] にクランプ、寸法は MIN_DIM 未満にしない */
export function applyScale(node, orig, axis, s) {
  s = Math.min(100, Math.max(0.01, s));
  const p = node.props;
  const uni = axis < 0;
  const mul1 = k => { p[k] = clampDim(orig[k] * s); };
  /* ベクトル寸法: 一様なら全成分、軸指定ならその成分だけ s 倍 */
  const mulVec = k => {
    p[k] = orig[k].map((v, i) => (uni || i === axis) ? clampDim(v * s) : v);
  };

  if (orig.a && orig.b) {
    const mid = [(orig.a[0] + orig.b[0]) / 2, (orig.a[1] + orig.b[1]) / 2, (orig.a[2] + orig.b[2]) / 2];
    const stretch = () => {
      for (const k of ['a', 'b'])
        p[k] = orig[k].map((v, i) => mid[i] + (v - mid[i]) * s);
    };
    const rkeys = orig.radius != null ? ['radius'] : ['r1', 'r2'];
    if (uni) { stretch(); rkeys.forEach(mul1); }
    else if (axis === 0) stretch();
    else rkeys.forEach(mul1);
    return true;
  }

  switch (node.type) {
    case 'sphere': if (!uni) return false; mul1('radius'); return true;
    case 'octahedron': if (!uni) return false; mul1('size'); return true;
    case 'box':
      mulVec('size'); return true;
    case 'box-frame':
      mulVec('size');
      if (uni) mul1('thick');
      return true;
    case 'ellipsoid': case 'superquad':
      mulVec('radii'); return true;
    case 'blob': case 'mesh':
      mulVec('scale'); return true;
    case 'torus':
      if (uni) { mul1('major'); mul1('minor'); }
      else if (axis === 1) mul1('minor');
      else mul1('major');
      return true;
    case 'cylinder':
      if (uni) { mul1('radius'); mul1('height'); }
      else if (axis === 1) mul1('height');
      else mul1('radius');
      return true;
    case 'round-cone': case 'capped-cone':
      if (uni) { mul1('r1'); mul1('r2'); mul1('height'); }
      else if (axis === 1) mul1('height');
      else { mul1('r1'); mul1('r2'); }
      return true;
    case 'cone':
      /* 一様 = height のみ (角度不変が正しい一様拡大)。
         横 = 底面半径 s 倍相当の角度変換 tanθ' = s·tanθ */
      if (uni || axis === 1) mul1('height');
      else p.angle = Math.min(85, Math.max(0.5, Math.atan(s * Math.tan(orig.angle * D2R)) / D2R));
      return true;
    case 'sweep': {
      /* 経路点を重心まわりに拡縮。一様=全軸+半径も s 倍 / 軸指定=その成分のみ (半径不変) */
      const pts = orig.points, n = Math.floor(pts.length / 3);
      if (!n) return false;
      const c = [0, 0, 0];
      for (let q = 0; q < n; q++) for (let i = 0; i < 3; i++) c[i] += pts[3 * q + i] / n;
      p.points = pts.map((v, j) => {
        const ax = j % 3;
        return (uni || ax === axis) ? c[ax] + (v - c[ax]) * s : v;
      });
      if (uni) p.radii = orig.radii.map(r => clampDim(r * s));
      return true;
    }
    default:
      return false;
  }
}
