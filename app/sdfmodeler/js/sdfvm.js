/* sdfvm.js — SDF を「線形ノード列 + 固定サイズのインタプリタ」で評価する (2026-08-24)
 *
 * 動機: 現行 codegen はツリーを GLSL に特化展開するので、HLSL/FXC が map() の
 * 呼び出し箇所ごとにツリーを丸ごとインライン展開し、コンパイル時間がノード数に
 * 対して超線形に伸びる (実測 rabbit コールド 8.7s / human 30s 超)。構造編集の
 * たびにこれを払う。VM ならシェーダのソースがシーンに依らず固定になり、
 * 編集は「ノードのテクスチャを差し替えるだけ」= 再コンパイルが消える
 * (実測: VM のコンパイルは 875〜958ms でシーン規模によらずほぼ一定)。
 *
 * ⚠ 「GPU の解釈実行は分岐発散で遅い」は当てはまらない — 全画素が同じノードを
 *   同じ順で評価するので switch は warp 内で一様。実測の実行時コストは 4.58 倍で、
 *   ノードあたりのテクセル取得とループ制御が主。編集中だけ使う想定なら吸収できる。
 *
 * ── 特化版と厳密に一致させるための2点 ─────────────────────────
 * ① 畳み込みは逆順走査。codegen の smooth-union は右 fold
 *      sU(c0, sU(c1, ... sU(c_m-1, cm)))
 *    なので、葉を逆順に出して累算器へ積むと同じ式になる (スタック不要):
 *      acc = cm; acc = sU(c_m-1, acc, k); ... ; acc = sU(c0, acc, k)
 *    k はその葉の親ノードの k を使う (入れ子で k が違っても正しく効く)。
 *    smooth-union は可換だが結合的ではないので、順序を守ることが一致の条件。
 * ② mirror は変換チェーンの途中で折る。mirror(rotate(leaf)) と
 *    rotate(mirror(leaf)) は別物なので、行列を全部掛けてから折ってはいけない。
 *    1 ノードを「A0 → 折り0 → A1 → 折り1 → A2 → プリミティブ」の順序付き
 *    ステップとして持つ (mirror は 2 枚まで)。
 *
 * オブジェクト同士は min で合成する (融合しない)。累算器を obj / scene の 2 本にし、
 * object の切れ目で scene = min(scene, obj) する。
 *
 * 対象外は linearize() が {ok:false} を返すので、呼び側は特化パスへフォールバックする。 */

import { SCHEMA, eulerToMat } from './model.js';

const D2R = Math.PI / 180;

/* GLSL 側の switch と必ず一致させる */
/* ⚠ ここを増やすときは **必ず GPU で特化版と突き合わせてから**にする。
   引数の詰め方を codegen の pushParams と合わせ損ねると、リンクも通り絵も出るが
   **黙って違う形になる** (2026-08-24 に cone 系 4 種で 3.5〜8.8% ずれるのを実測して
   差し戻した)。検証手順は test/sdfvm.mjs の CPU 突き合わせ + 1プリミティブだけの
   合成シーンを特化版と深度比較する、の2段。 */
export const OP = { sphere: 0, ellipsoid: 1, box: 2, torus: 3, capsule: 4, plane: 5 };
/* 命令の種別。スタックマシン (RPN) — 右 fold の入れ子が「種でない位置」にも
   置けるようにするため (human の 12 union 中 2 つが該当。累算器1本では表せない)。
     PUSH        : リーフを評価して積む
     FUSE_MIN/SU : リーフを評価し、直ちに頂上と合成する (葉+合成の常用形を1命令に)
     COMB_MIN/SU : リーフ無し。積んである2値を合成する (部分木を子に持つとき)
   スタック深さは linearize が数えて STACK_MAX を超えたら不可を返す。 */
export const CB = { push: 0, fuseMin: 1, fuseSU: 2, combMin: 3, combSU: 4 };
export const STACK_MAX = 8;

/* 1ノード = 64 float = RGBA32F 16 テクセル
   [ 0..11] A0  [12..23] A1  [24..35] A2   (各 3x4 行優先、点をローカルへ移す)
   [36..39] 折り平面0 (nx,ny,nz,d)  [40..43] 折り平面1
   [44] op  [45] combine  [46] k  [47] 折りの枚数
   [48..55] プリミティブ引数 a0,a1
   [56] gridGated (1=床。uGridOn が 0 なら評価しない)  [57..63] 予備 */
export const STRIDE = 64;
export const TEXELS = STRIDE / 4;

function mul34(a, b) {                       /* out = a ∘ b (先に b、次に a) */
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++)
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    o[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return o;
}
const IDENT34 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const invTranslate = t => [1, 0, 0, -t[0], 0, 1, 0, -t[1], 0, 0, 1, -t[2]];
function invRotate(deg, pivot) {
  const R = eulerToMat(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R);   /* 行優先 3x3 */
  const T = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]; /* 逆回転 = 転置 */
  const p = pivot || [0, 0, 0];
  const o = [T[0], T[1], T[2], 0, T[3], T[4], T[5], 0, T[6], T[7], T[8], 0];
  for (let r = 0; r < 3; r++)
    o[r * 4 + 3] = p[r] - (T[r * 3] * p[0] + T[r * 3 + 1] * p[1] + T[r * 3 + 2] * p[2]);
  return o;
}

function leafOf(n) {
  const p = n.props;
  switch (n.type) {
    case 'sphere':    return { op: OP.sphere,    args: [...p.center, p.radius, 0, 0, 0, 0] };
    case 'ellipsoid': return { op: OP.ellipsoid, args: [...p.center, 0, ...p.radii, 0] };
    case 'box':       return { op: OP.box,       args: [...p.center, 0, ...p.size, 0] };
    case 'torus':     return { op: OP.torus,     args: [...p.center, 0, p.major, p.minor, 0, 0] };
    case 'capsule':   return { op: OP.capsule,   args: [...p.a, 0, ...p.b, p.radius] };
    case 'plane':     return { op: OP.plane,     args: [...p.center, 0,
                                 ...(p.normal || [0, 1, 0]), (p.offset || 0)] };
    default: return null;
  }
}

/* doc → RPN 命令列。対応外なら {ok:false, reason} */
export function linearize(doc) {
  const out = [];
  let bad = null, depth = 0, maxDepth = 0;
  const push = () => { depth++; if (depth > maxDepth) maxDepth = depth; };
  const pop  = () => { depth--; };

  const emitLeaf = (n, chain, cb, k, gridGated) => {
    const L = leafOf(n);
    if (!L) { bad = '未対応リーフ: ' + n.type; return; }
    if (chain.length > 3) { bad = 'mirror は 2 枚まで'; return; }
    out.push({ chain, op: L.op, args: L.args, cb, k, gridGated });
    /* PUSH は 1 つ積む。FUSE_* は積まずに頂上を書き換えるだけなので差引 0 */
    if (cb === CB.push) push();
  };
  const emitComb = (cb, k) => { out.push({ chain: [], op: 0, args: [], cb, k, gridGated: false }); pop(); };

  /* 値を1つスタックに積む。cbAfter が非 null なら、積んだ直後に合成する */
  const emit = (n, chain, cbAfter, k, gridGated) => {
    if (bad) return false;
    if (n.hidden || n.type === 'blob' || n.type === 'mesh') return false;
    const sc = SCHEMA[n.type] || { kind: 'leaf' };

    if (sc.kind === 'leaf') {
      /* リーフは「評価して積む」か「評価して即合成」の1命令で済む */
      emitLeaf(n, chain, cbAfter === null ? CB.push
               : (cbAfter === CB.combMin ? CB.fuseMin : CB.fuseSU), k, gridGated);
      return true;
    }
    if (n.type === 'translate' || n.type === 'rotate') {
      const A = n.type === 'translate' ? invTranslate(n.props.t)
                                       : invRotate(n.props.deg, n.props.pivot);
      const last = chain[chain.length - 1];
      const c2 = chain.slice();
      if (last.fold) c2.push({ M: A, fold: null });
      else c2[c2.length - 1] = { M: mul34(A, last.M), fold: null };
      return emit(n.children[0], c2, cbAfter, k, gridGated);
    }
    if (n.type === 'mirror') {
      const N = n.props.normal || (n.props.axis === 'x' ? [1, 0, 0]
                : n.props.axis === 'y' ? [0, 1, 0] : n.props.axis === 'z' ? [0, 0, 1] : null);
      if (!N) { bad = 'mirror の平面が読めない'; return false; }
      const c2 = chain.slice();
      const last = c2[c2.length - 1];
      const plane = [N[0], N[1], N[2], n.props.d || 0];
      if (last.fold) c2.push({ M: IDENT34(), fold: plane });
      else c2[c2.length - 1] = { M: last.M, fold: plane };
      c2.push({ M: IDENT34(), fold: null });
      if (c2.length > 3) { bad = 'mirror は 2 枚まで'; return false; }
      return emit(n.children[0], c2, cbAfter, k, gridGated);
    }
    if (n.type === 'union' || n.type === 'smooth-union') {
      const isS = n.type === 'smooth-union';
      if (isS && n.props.mode && n.props.mode !== 'poly') {
        bad = 'smooth-union の mode ' + n.props.mode + ' は未対応'; return false;
      }
      const kk = isS ? Math.max(n.props.k || 0, 1e-6) : 0;
      const cbSelf = isS ? CB.combSU : CB.combMin;
      const kids = n.children.filter(c => !(c.hidden || c.type === 'blob' || c.type === 'mesh'));
      if (!kids.length) return false;
      /* ★ 右 fold なので逆順: 末尾の子を種として積み、手前の子から順に合成する */
      let placed = false;
      for (let i = kids.length - 1; i >= 0; i--) {
        const after = placed ? cbSelf : null;    /* 最初に積めた子だけは合成しない */
        if (emit(kids[i], chain, after, kk, gridGated)) placed = true;
        if (bad) return false;
      }
      if (!placed) return false;
      /* 自分の値が積まれた。親から合成を頼まれていればここで実行 */
      if (cbAfter !== null) emitComb(cbAfter, k);
      return true;
    }
    bad = '未対応ノード: ' + n.type;
    return false;
  };

  const objs = doc.objects.filter(o => o.visible);
  let placedObj = false;
  for (let oi = objs.length - 1; oi >= 0; oi--) {
    let gridGated = false;                        /* 床 plane の object はグリッド連動 */
    (function chk(n) { if (n.type === 'plane') gridGated = true; (n.children || []).forEach(chk); })(objs[oi].root);
    /* object 同士は min (融合しない) */
    const okd = emit(objs[oi].root, [{ M: IDENT34(), fold: null }],
                     placedObj ? CB.combMin : null, 0, gridGated);
    if (bad) return { ok: false, reason: bad };
    if (okd) placedObj = true;
  }
  if (!out.length) return { ok: false, reason: '対象ノードなし' };
  if (depth !== 1) return { ok: false, reason: 'スタックが釣り合わない (' + depth + ')' };
  if (maxDepth > STACK_MAX) return { ok: false, reason: 'ネストが深すぎる (' + maxDepth + ')' };

  const data = new Float32Array(out.length * STRIDE);
  out.forEach((e, i) => {
    const b = i * STRIDE;
    for (let s2 = 0; s2 < 3; s2++) {
      const M = e.chain[s2] ? e.chain[s2].M : IDENT34();
      for (let j = 0; j < 12; j++) data[b + s2 * 12 + j] = M[j];
    }
    let nf = 0;
    for (let s2 = 0; s2 < 2; s2++) {
      const F = e.chain[s2] && e.chain[s2].fold;
      if (F) { for (let j = 0; j < 4; j++) data[b + 36 + s2 * 4 + j] = F[j]; nf = s2 + 1; }
    }
    data[b + 44] = e.op; data[b + 45] = e.cb; data[b + 46] = e.k; data[b + 47] = nf;
    for (let j = 0; j < 8; j++) data[b + 48 + j] = e.args[j] || 0;
    data[b + 56] = e.gridGated ? 1 : 0;
  });
  return { ok: true, count: out.length, data, stack: maxDepth };
}

/* シーンに依らず固定サイズの評価器。sUnion / sdEllipsoid 等は PRELUDE のものを使う */
export const VM_GLSL = `
uniform sampler2D uVmTex;
uniform int uVmCount;
vec4 vmT(int n, int s){ return texelFetch(uVmTex, ivec2(s, n), 0); }

vec3 vmApply(int n, int base, vec3 q){
  vec4 h = vec4(q, 1.0);
  return vec3(dot(vmT(n,base), h), dot(vmT(n,base+1), h), dot(vmT(n,base+2), h));
}
vec3 vmFold(vec3 q, vec4 f){ float s = dot(q, f.xyz) - f.w; return q - 2.0*max(s, 0.0)*f.xyz; }

float vmPrim(int op, vec3 q, vec4 a0, vec4 a1){
  /* 分岐は warp 内で一様 (全画素が同じ命令を同じ順に実行する) ので発散しない */
  if (op == 0) return length(q - a0.xyz) - a0.w;
  if (op == 1) return sdEllipsoid(q - a0.xyz, a1.xyz);
  if (op == 2) return sdBox(q - a0.xyz, a1.xyz);
  if (op == 3) return sdTorus(q - a0.xyz, a1.x, a1.y);
  if (op == 4) return sdCapsule(q, a0.xyz, a1.xyz, a1.w);
  return dot(q - a0.xyz, normalize(a1.xyz)) - a1.w;
}

/* RPN スタックマシン。命令は
     0 PUSH / 1 FUSE_MIN / 2 FUSE_SU / 3 COMB_MIN / 4 COMB_SU
   FUSE_* は「リーフを評価して即座に頂上と合成」= 常用形を1命令に畳んだもの。
   COMB_* は部分木を子に持つときだけ出る (積んだ2値を合成)。 */
float vmEval(vec3 p){
  float st[8];
  int sp = 0;
  for (int i = 0; i < uVmCount; i++) {
    vec4 hdr = vmT(i, 11);                     /* op, cb, k, nfold */
    int cb = int(hdr.y + 0.5);
    if (cb >= 3) {                             /* リーフ無しの合成 */
      float a = st[sp-1]; sp--;
      st[sp-1] = (cb == 3) ? min(a, st[sp-1]) : sUnion(a, st[sp-1], hdr.z);
      continue;
    }
    float d;
    if (vmT(i,14).x > 0.5 && uGridOn < 0.5) {
      d = 1e9;                                 /* 床 plane はグリッド連動で無効化。
                                                  object 同士は min なので番兵でも安全 */
    } else {
      int nf = int(hdr.w + 0.5);
      vec3 q = vmApply(i, 0, p);
      if (nf > 0) { q = vmFold(q, vmT(i, 9));  q = vmApply(i, 3, q); }
      if (nf > 1) { q = vmFold(q, vmT(i,10));  q = vmApply(i, 6, q); }
      d = vmPrim(int(hdr.x + 0.5), q, vmT(i,12), vmT(i,13));
    }
    if (cb == 0) { st[sp] = d; sp++; }
    else st[sp-1] = (cb == 1) ? min(d, st[sp-1]) : sUnion(d, st[sp-1], hdr.z);
  }
  return sp > 0 ? st[sp-1] : 1e9;
}
`;
