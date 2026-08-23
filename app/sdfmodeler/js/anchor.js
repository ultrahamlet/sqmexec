/* anchor.js — ノードの「代表点 (アンカー)」のワールド座標と、
 * ワールド空間の移動量→ノードローカル移動量の変換。
 * ギズモ/矢印キー移動が回転祖先 (rotate/rotate-mat) の下でも正しく動くための数学。
 *
 * 変換の幾何学 (codegen.js emitXform と同一規約):
 *   translate t     : ジオメトリは +t 移動          w = l + t
 *   rotate / -mat S : w = pivot + S·(l - pivot)     (S は row-major 9成分。
 *                     クエリ点は Sᵀ で回すので、見た目のジオメトリは S 回転)
 *   mirror          : 折り畳み。元定義側 (負側) は恒等 → アンカー/デルタは恒等扱い
 */
import { SCHEMA, eulerToMat } from './model.js';

const D2R = Math.PI / 180;

/* row-major 3x3 の v への作用と、転置の作用 */
const mvec = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const mvecT = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

export function matmul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

/* 軸角回転 (Rodrigues) → row-major。axis は内部で正規化 */
export function axisAngleMat(axis, ang) {
  let [x, y, z] = axis;
  const L = Math.hypot(x, y, z) || 1;
  x /= L; y /= L; z /= L;
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  return [
    t * x * x + c,     t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c,     t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

function rotMatOf(node) {
  if (node.type === 'rotate') {
    const d = node.props.deg;
    return eulerToMat(d[0] * D2R, d[1] * D2R, d[2] * D2R);
  }
  const p = node.props;   /* rotate-mat */
  return [p.m0, p.m1, p.m2, p.m3, p.m4, p.m5, p.m6, p.m7, p.m8];
}

/* xform ノード1段のジオメトリ写像 (子ローカル点 → このノードの外側フレーム) */
function xformPoint(node, p) {
  if (node.type === 'translate') {
    const t = node.props.t;
    return [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
  }
  if (node.type === 'rotate' || node.type === 'rotate-mat') {
    const pv = node.props.pivot || [0, 0, 0];
    const r = mvec(rotMatOf(node), [p[0] - pv[0], p[1] - pv[1], p[2] - pv[2]]);
    return [r[0] + pv[0], r[1] + pv[1], r[2] + pv[2]];
  }
  return p;   /* mirror ほか: 恒等扱い */
}

/* root→id のパス (両端含む)。見つからなければ null */
export function nodePath(root, id, path = []) {
  path.push(root);
  if (root.id === id) return path;
  for (const c of root.children) {
    const r = nodePath(c, id, path);
    if (r) return r;
  }
  path.pop();
  return null;
}

/* ノード自身のフレームでの代表点。leaf=center/中点、xform=子を自写像で持ち上げ、
 * op=子の平均。raw や空グループは null (アンカー無し) */
function repPoint(node) {
  const sc = SCHEMA[node.type] || { kind: 'leaf' };
  const p = node.props;
  if (sc.kind === 'leaf') {
    if (p.center) return p.center.slice();
    if (p.a && p.b) return [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    if (node.type === 'sweep' && p.points && p.points.length >= 3) {   /* 経路点の重心 */
      const acc = [0, 0, 0], n = Math.floor(p.points.length / 3);
      for (let q = 0; q < n; q++) for (let i = 0; i < 3; i++) acc[i] += p.points[3 * q + i];
      return [acc[0] / n, acc[1] / n, acc[2] / n];
    }
    return null;   /* raw */
  }
  if (sc.kind === 'xform') {
    const r = node.children.length ? repPoint(node.children[0]) : null;
    if (r) return xformPoint(node, r);
    return node.type === 'translate' ? p.t.slice() : null;
  }
  /* op: 子の代表点の平均 */
  let acc = [0, 0, 0], n = 0;
  for (const c of node.children) {
    const r = repPoint(c);
    if (r) { acc[0] += r[0]; acc[1] += r[1]; acc[2] += r[2]; n++; }
  }
  return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
}

/* ノードの外側フレームの点 p をワールドへ (祖先 xform を厳密に上だけ適用) */
export function worldPoint(root, nodeId, p) {
  const path = nodePath(root, nodeId);
  if (!path) return p.slice();
  let q = p.slice();
  for (let i = path.length - 2; i >= 0; i--) q = xformPoint(path[i], q);
  return q;
}

/* ノード自身の外側フレームでの代表点 (rotate ラップの pivot 初期値などに) */
export function localAnchor(node) { return repPoint(node); }

/* ノードのアンカーのワールド座標 (祖先 xform を全て適用)。無ければ null */
export function worldAnchor(root, nodeId) {
  const path = nodePath(root, nodeId);
  if (!path) return null;
  const p = repPoint(path[path.length - 1]);
  return p ? worldPoint(root, nodeId, p) : null;
}

/* ワールド空間の移動量 dWorld を、nodeId のプロパティ (center/a/b/t) が住む
 * ローカルフレームの移動量へ変換。回転祖先 (ノード自身は含まない) の転置を
 * 外側から順に適用。translate/mirror はデルタに影響しない */
export function worldToLocalDelta(root, nodeId, dWorld) {
  const path = nodePath(root, nodeId);
  let d = dWorld.slice();
  if (!path) return d;
  for (let i = 0; i < path.length - 1; i++) {
    const n = path[i];
    if (n.type === 'rotate' || n.type === 'rotate-mat') d = mvecT(rotMatOf(n), d);
  }
  return d;
}

/* 逆変換: ノードローカルの方向ベクトルをワールドへ (回転祖先を内→外に適用)。
 * worldToLocalDelta と往復恒等。スケールギズモの軸ハンドル方向に使う */
export function localToWorldDelta(root, nodeId, dLocal) {
  const path = nodePath(root, nodeId);
  let d = dLocal.slice();
  if (!path) return d;
  for (let i = path.length - 2; i >= 0; i--) {
    const n = path[i];
    if (n.type === 'rotate' || n.type === 'rotate-mat') d = mvec(rotMatOf(n), d);
  }
  return d;
}
