/* model.js — エディタのノードモデルと .ssq (sqm) との相互変換。
 * セマンティクスは sqm/dist/sexp_input.cpp + sdf.cpp に厳密に一致させる:
 *  - rotate: R = Rx·Ry·Rz (row-major)。eval は p' = pivot + Rᵀ(p-pivot)
 *    (列ストライド参照なので GLSL では mat3(R row-major列挙)*(p-pivot) と同型)
 *  - rotate-mat: 9値をそのまま R(row-major) として格納
 *  - mirror: m = dot(N,p)-d が正の側を鏡映 (N はパース時に正規化)
 *  - smooth-union: mix(db,da,h)-k h(1-h), h=clamp(.5+.5(db-da)/k)
 *  - smooth-subtract: mix(da,-db,h)+k h(1-h), h=clamp(.5-.5(da+db)/k)
 */
import { parseAll, serialize, fmt } from './sexpr.js';
import { blobLine, meshLine, collectObjectBlobs } from './blobnode.js';

let idCounter = 1;
export function newId() { return 'n' + (idCounter++); }

const N = v => { const f = parseFloat(v); return isNaN(f) ? 0 : f; };

function v3(key, def = [0, 0, 0], label = null) { return { key, type: 'vec3', def, label: label || key }; }
function n1(key, def = 0, label = null) { return { key, type: 'num', def, label: label || key }; }
/* 2成分ベクトル (楕円トーラスの radii a,b 用)。UI は数値ボックス2個 */
function v2(key, def = [1, 1], label = null) { return { key, type: 'vec2', def, label: label || key }; }

/* ── ノードスキーマ ─────────────────────────────────────────── */
export const SCHEMA = {
  /* leaves */
  'sphere':        { kind: 'leaf', label: '球',            fields: [v3('center'), n1('radius', 1)] },
  'box':           { kind: 'leaf', label: '箱',            fields: [v3('center'), v3('size', [1, 1, 1])] },
  'ellipsoid':     { kind: 'leaf', label: '楕円体',        fields: [v3('center'), v3('radii', [1, 0.7, 0.7])] },
  'torus':         { kind: 'leaf', label: 'トーラス',      fields: [v3('center'), n1('major', 1), n1('minor', 0.3)] },
  /* 楕円トーラス: xz平面の楕円(a,b)に沿うチューブ。厳密SDF (dist/sdf.cpp の sd_torus_ellipse)。
     a=b で円トーラスに一致。断面が円でない束を締めるのに使う */
  'torus-ellipse': { kind: 'leaf', label: '楕円トーラス',  fields: [v3('center'), v2('radii', [1, 0.6]), n1('minor', 0.15)] },
  /* ベイク済み SDF グリッド (OBJ 取り込み)。file は文字列 props (fields 外, raw と同じ扱い)。
     三角形数に依存しない O(1) サンプルなので、何万ポリゴンの OBJ でも 1 リーフで載る。
     旧・楕円体近似 (obj_to_ellipsoids) は被覆率7割程度で形が別物だったため置き換えた。 */
  'grid':          { kind: 'leaf', label: 'グリッド(取込)', fields: [v3('center'), n1('scale', 1)] },
  /* plane: 半空間 dot(P-center, n̂) - offset。normal 既定 (0,1,0) で従来の水平面 (床)。
     2026-07-29 にエンジン側が任意法線対応 → モデラーも保持する (落とすと保存で床に戻る) */
  'plane':         { kind: 'leaf', label: '平面(半空間)',  fields: [v3('center'), v3('normal', [0, 1, 0]), n1('offset', 0)] },
  'box-frame':     { kind: 'leaf', label: '箱フレーム',    fields: [v3('center'), v3('size', [1, 1, 1]), n1('thick', 0.08)] },
  'capsule':       { kind: 'leaf', label: 'カプセル',      fields: [v3('a'), v3('b', [0, 1, 0]), n1('radius', 0.3)] },
  'cylinder':      { kind: 'leaf', label: '円柱',          fields: [v3('center'), n1('radius', 0.5), n1('height', 1)] },
  'cylinder-ab':   { kind: 'leaf', label: '円柱AB',        fields: [v3('a'), v3('b', [0, 1, 0]), n1('radius', 0.3)] },
  'round-cone':    { kind: 'leaf', label: '丸錐',          fields: [v3('center'), n1('r1', 0.4), n1('r2', 0.15), n1('height', 1)] },
  'round-cone-ab': { kind: 'leaf', label: '丸錐AB',        fields: [v3('a'), v3('b', [0, 1, 0]), n1('r1', 0.4), n1('r2', 0.15)] },
  'capped-cone':   { kind: 'leaf', label: '切頂円錐',      fields: [v3('center'), n1('height', 0.5), n1('r1', 0.5), n1('r2', 0.25)] },
  'capped-cone-ab':{ kind: 'leaf', label: '切頂円錐AB',    fields: [v3('a'), v3('b', [0, 1, 0]), n1('r1', 0.5), n1('r2', 0.25)] },
  'cone':          { kind: 'leaf', label: '円錐',          fields: [v3('center'), n1('angle', 30), n1('height', 1)] },
  'octahedron':    { kind: 'leaf', label: '八面体',        fields: [v3('center'), n1('size', 0.7)] },
  'superquad':     { kind: 'leaf', label: '超楕円体',      fields: [v3('center'), v3('radii', [0.7, 0.7, 0.7]), n1('e1', 2), n1('e2', 2), n1('e3', 2)] },
  /* sweep: 3D経路点列に沿う円形断面の掃引 (丸錐カプセル連鎖 = 厳密SDF)。
     props: points=flat[x,y,z...], radii=点毎半径, curve(0=折れ線/1=spline/2=bspline),
     steps=スプライン分割, closed=ループ。可変長のため fields ではなくカスタムUI */
  'sweep':         { kind: 'leaf', label: '掃引チューブ',  fields: [] },
  /* lathe: 2D輪郭(r,y)をy軸回転した回転体 (壺/ゴブレット/駒/ボウル)。prof=[[r,y]..]・
     axis=回転半径オフセット・thick>0で開シェル・curve/steps。輪郭は profile.html(latheモード)で編集 */
  'lathe':         { kind: 'leaf', label: '回転体',        fields: [] },
  /* extrude: 2D閉輪郭(x,y)を z±depth へ押し出した板 (IQ opExtrusion, dist/sdf.cpp sd_extrude と同式)。
     prof=[[x,y]..]・depth=半厚・thick>0で開シェル・curve/steps。輪郭は profile.html(extrudeモード)で編集。
     用途: 角のある板 (額縁/銘板) と、円錐では尖ってしまう葉っぱ形 (猫の耳) */
  'extrude':       { kind: 'leaf', label: '押し出し',      fields: [] },
  'raw':           { kind: 'leaf', label: 'raw(未対応)',   fields: [] },
  /* native blob (メタボール)。SDF ではなく Wyvill 加算場 — GLSL には出さず (d=1e9)、
     表示は WASM (mbmesh = vclay 1992 評価器) の再メッシュを viewer が
     ラスタライズする。scale は**支持半径** (可視半径は ≈0.614×scale @weight3)。
     rot は sqm row-vector Rx·Ry·Rz 規約 (blobnode.js blobRotMat)。
     threshold 0 = weight から導出。e1..e3 は superquadric 指数 (2=通常楕円体) */
  'blob':          { kind: 'leaf', label: 'blob(メタボール)', fields: [v3('center'), v3('scale', [0.5, 0.5, 0.5]), v3('rot'), n1('weight', 3), n1('threshold', 0), n1('group', 0), n1('e1', 2), n1('e2', 2), n1('e3', 2), n1('deformAmp', 0), n1('deformFreq', 8), n1('deformPhase', 0), n1('deformMode', 0)] },
  /* OBJ メッシュ ((mesh (file ..))。blob と同じく GLSL には出さず (SDF ではない)、
     表示はラスタライズ (objmesh.js)・ピックは CPU レイ・三角形。頂点は編集不可 =
     transform (center/scale/rot) と材質だけ編集できる。rot は engine
     obj_loader の scale→Rx→Ry→Rz→translate = blob と同じ ZYX 合成。
     file / extra (use-mtl・group-surface の保全) は文字列 props。
     smooth は UI で切り替えるので extra でなく数値 props (0/1) に分離してある */
  'mesh':          { kind: 'leaf', label: 'メッシュ(OBJ)', fields: [v3('center'), v3('scale', [1, 1, 1]), v3('rot')] },
  /* ops (エディタ上は n-ary。エクスポート時に2項へ畳む) */
  'union':           { kind: 'op', label: '和 ∪',          fields: [] },
  'intersect':       { kind: 'op', label: '積 ∩',          fields: [] },
  'subtract':        { kind: 'op', label: '差 −',          fields: [] },
  'smooth-union':    { kind: 'op', label: '滑らか和',      fields: [n1('k', 0.2)] },
  /* smooth-intersect: smax(a,b,k) = -smin(-a,-b,k)。「箱で滑らかに削る」= 手彫りの主役 op。
     場は max(a,b) を最大 k/4 上回る過大評価なので、k を厚みに対して大きくしすぎない */
  'smooth-intersect':{ kind: 'op', label: '滑らか積',      fields: [n1('k', 0.2)] },
  'smooth-subtract': { kind: 'op', label: '滑らか差',      fields: [n1('k', 0.2)] },
  'blend':           { kind: 'op', label: 'ブレンド',      fields: [n1('u', 0.5)], maxChildren: 2 },
  'invert':          { kind: 'op', label: '反転',          fields: [], maxChildren: 1 },
  /* xforms (子1つ) */
  'translate':  { kind: 'xform', label: '移動',            fields: [v3('t')] },
  'rotate':     { kind: 'xform', label: '回転',            fields: [v3('deg'), v3('pivot')] },
  'rotate-mat': { kind: 'xform', label: '回転行列',        fields: [n1('m0',1),n1('m1'),n1('m2'),n1('m3'),n1('m4',1),n1('m5'),n1('m6'),n1('m7'),n1('m8',1), v3('pivot')] },
  'mirror':     { kind: 'xform', label: 'ミラー',          fields: [v3('normal', [-1, 0, 0]), n1('d', 0)] },
  'repeat':     { kind: 'xform', label: '反復',            fields: [n1('count', 3), v3('offset', [0.8, 0, 0])] },
  'repeat3':    { kind: 'xform', label: '反復3D',          fields: [v3('count', [2, 2, 2]), v3('spacing', [1, 1, 1])] },
  /* 無限反復: 間隔 0 の軸は反復しない。子はセル内に収めること (はみ出すと隣コピーと干渉) */
  'repeat-inf': { kind: 'xform', label: '無限反復',        fields: [v3('spacing', [1, 0, 1])] },
  'round':      { kind: 'xform', label: '角丸め',          fields: [n1('r', 0.1)] },
  'onion':      { kind: 'xform', label: '殻化',            fields: [n1('t', 0.05)] },
  'elongate':   { kind: 'xform', label: '引き伸ばし',      fields: [v3('h', [0.5, 0, 0])] },
  'scale':      { kind: 'xform', label: 'スケール',        fields: [v3('s', [1, 1, 1])] },
  'twist':      { kind: 'xform', label: 'ねじり',          fields: [n1('rate', 60)] },
  'bend':       { kind: 'xform', label: '曲げ',            fields: [n1('rate', 30)] },
};

export function makeNode(type, props = {}, children = []) {
  const sc = SCHEMA[type];
  if (!sc) throw new Error('unknown node type: ' + type);
  const p = {};
  for (const f of sc.fields) {
    const v = props[f.key];
    p[f.key] = v !== undefined ? (Array.isArray(v) ? v.slice() : v)
                               : (Array.isArray(f.def) ? f.def.slice() : f.def);
  }
  if (type === 'raw') p.text = props.text || '(sphere (center 0 0 0) (radius 0.5))';
  /* blob: (super ..) の有無は数値でなくフラグ (e=2,2,2 でも super 明示はありうる) */
  if (type === 'blob') p.isSuper = props.isSuper ?? 0;
  if (type === 'mesh') {
    p.file = props.file || '';
    p.extra = props.extra ? props.extra.slice() : [];
    /* 0 = (smooth ..) を書かない = エンジンは vn があればそれ・無ければフラット
       1 = (smooth 1) = obj_compute_smooth_normals (クリース 60°) */
    p.smooth = props.smooth ? 1 : 0;
  }
  /* ブレンド種別は UI フィールドではなく文字列 props (poly/round/deep/chamfer)。
     fields に無いので makeNode で明示的に写す (raw.text や sweep.points と同じ扱い) */
  if (type === 'smooth-union' || type === 'smooth-intersect') p.mode = props.mode || 'poly';
  /* grid の file は文字列なので fields (数値) の外で持つ。bbox はプレビュー用に
     サーバーから貰った値を保持 (GLSL が箱を出すのと、ギズモの当たり判定に使う) */
  if (type === 'grid') {
    p.file = props.file || '';
    p.size = props.size ? props.size.slice() : [1, 1, 1];
  }
  if (type === 'sweep') {   /* 可変長 props (fields 外) の既定値 */
    p.points = props.points ? props.points.slice() : [0, 0.15, 0,  0.35, 0.7, 0.25,  0, 1.3, 0];
    p.radii  = props.radii  ? props.radii.slice()  : [0.15, 0.12, 0.08];
    p.curve  = props.curve  ?? 1;   /* 0=折れ線 1=Catmull-Rom 2=Bスプライン */
    p.steps  = props.steps  ?? 12;
    p.closed = props.closed ?? 0;
    /* 任意断面 (Phase 2)。profile=[[u,v]..] 空=円形。radii は断面スケール扱いになる。
       プロファイルエディタ (profile.html) から BroadcastChannel で設定される */
    p.profile      = props.profile ? props.profile.map(q => q.slice()) : [];
    p.profileCurve = props.profileCurve ?? 0;   /* 0=折れ線 1=spline 2=bspline */
    p.profileSteps = props.profileSteps ?? 8;
    p.twist        = props.twist ?? 0;          /* 度 */
    /* twists = 制御点ごとのねじり角 (度)。指定時は twist より優先 (エンジンと同じ)。
       落とすと保存で一様ねじりに化けるので必ず持ち回す */
    p.twists       = props.twists ? props.twists.slice() : [];
  }
  if (type === 'extrude') {   /* 押し出し: 2D閉輪郭(x,y)を z±depth へ */
    p.center = props.center ? props.center.slice() : [0, 0, 0];
    p.depth  = props.depth ?? 0.1;   /* **半厚** (エンジンの (depth h) と同じ) */
    p.thick  = props.thick ?? 0;     /* >0 で開シェル (枠) */
    p.steps  = props.steps ?? 8;
    p.curve  = props.curve ?? 0;     /* 0=折れ線 1=spline 2=bspline */
    /* prof=[[x,y]..] 閉輪郭。既定=角丸の四角 */
    p.prof = props.prof ? props.prof.map(q => q.slice())
      : [[-0.3, -0.22], [0.3, -0.22], [0.3, 0.22], [-0.3, 0.22]];
  }
  if (type === 'lathe') {   /* 回転体: 2D輪郭(r,y)をy軸回転 */
    p.center = props.center ? props.center.slice() : [0, 0, 0];
    p.axis   = props.axis  ?? 0;    /* 回転半径オフセット w (0=y軸回転) */
    p.thick  = props.thick ?? 0;    /* >0 で開シェル (ボウル/笠) */
    p.steps  = props.steps ?? 16;
    p.curve  = props.curve ?? 1;    /* 0=折れ線 1=spline 2=bspline */
    /* prof=[[r,y]..] 輪郭点列。既定=ゴブレット (下端が軸 r=0 から立ち上がる) */
    p.prof = props.prof ? props.prof.map(q => q.slice())
      : [[0, 0], [0.42, 0], [0.42, 0.07], [0.1, 0.14], [0.09, 0.55], [0.4, 0.62], [0.46, 1.05], [0, 1.1]];
  }
  return { id: newId(), type, name: '', props: p, children };
}

export function cloneNode(node) {
  const c = makeNode(node.type, {}, node.children.map(cloneNode));
  c.name = node.name;
  for (const k of Object.keys(node.props)) {
    const v = node.props[k];
    c.props[k] = Array.isArray(v) ? v.map(e => Array.isArray(e) ? e.slice() : e) : v;   /* profile は入れ子 */
  }
  return c;
}

/* ── 回転行列ユーティリティ (row-major 3x3) ─────────────────── */
function matmul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
    r[i * 3 + j] = s;
  }
  return r;
}
/* sqm sdf_euler_matrix と同一: R = Rx·Ry·Rz (引数はラジアン, row-major) */
export function eulerToMat(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const mz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const my = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const mx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  return matmul3(mx, matmul3(my, mz));
}
/* R = Rx·Ry·Rz を分解。復元一致しなければ null (→ rotate-mat のまま保持) */
export function matToEulerDeg(m) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  let ry = Math.asin(clamp(m[2], -1, 1)), rx, rz;
  if (Math.abs(Math.cos(ry)) > 1e-6) {
    rx = Math.atan2(-m[5], m[8]);
    rz = Math.atan2(-m[1], m[0]);
  } else { /* ジンバル: rz=0 に固定 */
    rz = 0;
    rx = Math.atan2(m[3], m[4]);
  }
  const r = eulerToMat(rx, ry, rz);
  for (let i = 0; i < 9; i++) if (Math.abs(r[i] - m[i]) > 1e-4) return null;
  const d = 180 / Math.PI;
  return [rx * d, ry * d, rz * d];
}

/* ── .ssq (sdf subtree) → ノード ────────────────────────────── */
const isL = Array.isArray;
const numsOf = sx => sx.filter(x => !isL(x)).map(N);

/* leaf の (key v...) 群を {key:[...]} に */
function kvMap(sx) {
  const m = {};
  for (const e of sx.slice(1)) if (isL(e) && e.length) m[String(e[0])] = e.slice(1).map(N);
  return m;
}
const LEAF_KEYS = {
  'sphere':         [['center', 'center', 3], ['radius', 'radius', 1]],
  'box':            [['center', 'center', 3], ['size', 'size', 3]],
  'ellipsoid':      [['center', 'center', 3], ['radii', 'radii', 3]],
  'torus':          [['center', 'center', 3], ['major', 'major', 1], ['minor', 'minor', 1]],
  'torus-ellipse':  [['center', 'center', 3], ['radii', 'radii', 2], ['minor', 'minor', 1]],
  'plane':          [['center', 'center', 3], ['normal', 'normal', 3], ['offset', 'offset', 1]],
  'box-frame':      [['center', 'center', 3], ['size', 'size', 3], ['thick', 'thick', 1]],
  'capsule':        [['a', 'a', 3], ['b', 'b', 3], ['radius', 'radius', 1]],
  'cylinder':       [['center', 'center', 3], ['radius', 'radius', 1], ['height', 'height', 1]],
  'cylinder-ab':    [['a', 'a', 3], ['b', 'b', 3], ['radius', 'radius', 1]],
  'round-cone':     [['center', 'center', 3], ['r1', 'r1', 1], ['r2', 'r2', 1], ['height', 'height', 1]],
  'round-cone-ab':  [['a', 'a', 3], ['b', 'b', 3], ['r1', 'r1', 1], ['r2', 'r2', 1], ['ra', 'r1', 1], ['rb', 'r2', 1]],
  'capped-cone':    [['center', 'center', 3], ['height', 'height', 1], ['r1', 'r1', 1], ['r2', 'r2', 1]],
  'capped-cone-ab': [['a', 'a', 3], ['b', 'b', 3], ['r1', 'r1', 1], ['r2', 'r2', 1], ['ra', 'r1', 1], ['rb', 'r2', 1]],
  'cone':           [['center', 'center', 3], ['angle', 'angle', 1], ['height', 'height', 1]],
  'octahedron':     [['center', 'center', 3], ['size', 'size', 1]],
  /* superquad: (e v) は e1=e2=e3 一括 (エイリアスを後置=同時指定なら e が勝つ)。
     e3 未指定→e2 追従は sdfToNode の特例で処理 */
  'superquad':      [['center', 'center', 3], ['radii', 'radii', 3], ['e1', 'e1', 1], ['e2', 'e2', 1], ['e3', 'e3', 1], ['e', 'e1', 1], ['e', 'e2', 1], ['e', 'e3', 1]],
};
const OPS = { 'union': 1, 'intersect': 1, 'subtract': 1, 'smooth-union': 1, 'smooth-intersect': 1, 'smooth-subtract': 1, 'blend': 1, 'invert': 1 };

export function sdfToNode(sx) {
  if (!isL(sx) || !sx.length) return makeNode('raw', { text: serialize(sx) });
  const head = String(sx[0]);

  if (head === 'sweep') {
    /* (sweep (points|spline|bspline x y z ...)(radius r)(radii ...)(steps n)(closed)
              [(profile|profile-spline|profile-bspline u v ...)(profile-steps n)(twist deg)])
       steps 既定 12 = エンジン sexp_input.cpp と一致必須。任意断面 (profile/twist) も一級に取り込む */
    const props = { points: [], radii: [], curve: 0, steps: 12, closed: 0,
                    profile: [], profileCurve: 0, profileSteps: 8, twist: 0, twists: [] };
    let radius = null;
    for (const e of sx.slice(1)) {
      if (!isL(e) || !e.length) continue;
      const k = String(e[0]), nums = e.slice(1).map(N);
      if (k === 'points' || k === 'spline' || k === 'bspline') {
        props.curve = k === 'spline' ? 1 : k === 'bspline' ? 2 : 0;
        props.points = nums.slice(0, Math.floor(nums.length / 3) * 3);
      }
      else if (k === 'profile' || k === 'profile-spline' || k === 'profile-bspline') {
        props.profileCurve = k === 'profile-spline' ? 1 : k === 'profile-bspline' ? 2 : 0;
        for (let i = 0; i + 1 < nums.length; i += 2) props.profile.push([nums[i], nums[i + 1]]);
      }
      else if (k === 'radii')  props.radii = nums;
      else if (k === 'radius') radius = nums[0];
      else if (k === 'steps')  props.steps = nums[0] ?? 12;
      else if (k === 'profile-steps') props.profileSteps = nums[0] ?? 8;
      else if (k === 'twist')  props.twist = nums[0] ?? 0;
      else if (k === 'twists') props.twists = nums.slice();
      else if (k === 'closed') props.closed = 1;
    }
    if (radius == null) radius = props.profile.length >= 3 ? 1 : 0.15;   /* 断面時はスケール既定1 */
    const n = props.points.length / 3;
    while (props.radii.length < n) props.radii.push(radius);
    props.radii.length = n;
    return makeNode('sweep', props);
  }

  if (head === 'extrude') {
    /* (extrude (center x y z)(depth h)(thick t)(steps n)(profile|spline|bspline x0 y0 ...)) */
    const props = { center: [0, 0, 0], depth: 0.1, thick: 0, steps: 8, curve: 0, prof: [] };
    for (const e of sx.slice(1)) {
      if (!isL(e) || !e.length) continue;
      const k = String(e[0]), nums = e.slice(1).map(N);
      if (k === 'profile' || k === 'spline' || k === 'bspline') {
        props.curve = k === 'spline' ? 1 : k === 'bspline' ? 2 : 0;
        for (let i = 0; i + 1 < nums.length; i += 2) props.prof.push([nums[i], nums[i + 1]]);
      }
      else if (k === 'center') props.center = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
      else if (k === 'depth') props.depth = nums[0] ?? 0.1;
      else if (k === 'thick') props.thick = nums[0] ?? 0;
      else if (k === 'steps') props.steps = nums[0] ?? 8;
    }
    if (props.prof.length < 3) return makeNode('raw', { text: serialize(sx) });   /* 壊れた輪郭は raw で保全 */
    return makeNode('extrude', props);
  }

  if (head === 'lathe') {
    /* (lathe (center x y z)(axis w)(thick t)(steps n)(profile|spline|bspline r0 y0 ...)) */
    const props = { center: [0, 0, 0], axis: 0, thick: 0, steps: 16, curve: 1, prof: [] };
    for (const e of sx.slice(1)) {
      if (!isL(e) || !e.length) continue;
      const k = String(e[0]), nums = e.slice(1).map(N);
      if (k === 'profile' || k === 'spline' || k === 'bspline') {
        props.curve = k === 'spline' ? 1 : k === 'bspline' ? 2 : 0;
        for (let i = 0; i + 1 < nums.length; i += 2) props.prof.push([nums[i], nums[i + 1]]);
      }
      else if (k === 'center') props.center = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
      else if (k === 'axis')  props.axis = nums[0] ?? 0;
      else if (k === 'thick') props.thick = nums[0] ?? 0;
      else if (k === 'steps') props.steps = nums[0] ?? 16;
    }
    if (props.prof.length < 2) return makeNode('raw', { text: serialize(sx) });   /* 壊れた輪郭は raw で保全 */
    return makeNode('lathe', props);
  }

  if (LEAF_KEYS[head]) {
    const kv = kvMap(sx), props = {};
    for (const [ssqKey, propKey, cnt] of LEAF_KEYS[head]) {
      const v = kv[ssqKey];
      if (!v) continue;
      /* cnt=2 (楕円トーラスの radii) にも対応するため成分数で一般化 */
      props[propKey] = cnt === 1 ? (v[0] ?? 0) : Array.from({ length: cnt }, (_, i) => v[i] ?? 0);
    }
    /* superquad: e3 未指定は e2 に追従 (sqm パーサーと同じ既定) */
    if (head === 'superquad' && props.e3 === undefined && props.e2 !== undefined) props.e3 = props.e2;
    return makeNode(head, props);
  }

  if (head === 'mcolor') {
    /* (mcolor (c r g b) <child>) → 子ノードの props.mcolor に畳む (エディタは prop 方式) */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let col = [1, 1, 1];
    if (lists.length >= 2) {
      const p = lists[0];
      const nums = numsOf(p[0] === 'c' ? p.slice(1) : p);
      col = [nums[0] ?? 1, nums[1] ?? 1, nums[2] ?? 1];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    child.props.mcolor = col;
    return child;
  }

  if (head === 'translate') {
    /* (translate (t x y z) <child>) または (translate (x y z) <child>) —
       最後のリスト=子, その前のリスト=パラメータ */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let t = [0, 0, 0];
    if (lists.length >= 2) {
      const p = lists[0];
      const nums = numsOf(p[0] === 't' ? p.slice(1) : p);
      t = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('translate', { t }, [child]);
  }

  if (head === 'rotate') {
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let deg = [0, 0, 0], pivot = null;
    if (lists.length >= 2) {
      const p = lists[0];
      const nums = numsOf(p[0] === 'deg' ? p.slice(1) : p);
      deg = [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
      if (nums.length >= 6) pivot = [nums[3], nums[4], nums[5]];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    if (!pivot) pivot = defaultPivot(child);
    return makeNode('rotate', { deg, pivot }, [child]);
  }

  if (head === 'rotate-mat') {
    const nums = [];
    let child = null;
    for (let i = 1; i < sx.length; i++) {
      if (isL(sx[i])) { child = sdfToNode(sx[i]); break; }
      nums.push(N(sx[i]));
    }
    const m = nums.slice(0, 9);
    while (m.length < 9) m.push(m.length % 4 === 0 ? 1 : 0);
    const pivot = nums.length >= 12 ? nums.slice(9, 12) : [0, 0, 0];
    if (!child) child = makeNode('sphere');
    const eul = matToEulerDeg(m);
    if (eul) return makeNode('rotate', { deg: eul, pivot }, [child]);
    const props = { pivot };
    m.forEach((v, i) => props['m' + i] = v);
    return makeNode('rotate-mat', props, [child]);
  }

  if (head === 'mirror') {
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let normal = [1, 0, 0], d = 0;
    if (lists.length >= 2) {
      const p = lists[0], k = String(p[0]);
      if (k === 'axis') {
        const ax = String(p[1] || 'x')[0];
        normal = ax === 'x' ? [1, 0, 0] : ax === 'y' ? [0, 1, 0] : [0, 0, 1];
      } else {
        const nums = numsOf((k === 'plane' || k === 'normal') ? p.slice(1) : p);
        normal = [nums[0] ?? 1, nums[1] ?? 0, nums[2] ?? 0];
        d = nums[3] ?? 0;
      }
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('mirror', { normal, d }, [child]);
  }

  if (head === 'repeat') {
    /* (repeat (count n) (offset dx dy dz) <child>) — パラメータ2リストは順不同 */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let count = 1, offset = [1, 0, 0];
    for (const p of lists.slice(0, -1)) {
      const k = String(p[0]);
      if (k === 'count') count = N(p[1]);
      else {
        const nums = numsOf(k === 'offset' ? p.slice(1) : p);
        if (nums.length >= 3) offset = [nums[0], nums[1], nums[2]];
        else if (nums.length) count = nums[0];
      }
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('repeat', { count: Math.max(1, Math.round(count)), offset }, [child]);
  }

  if (head === 'repeat-inf') {
    /* (repeat-inf (spacing sx sy sz) <child>) — 間隔 0 の軸は反復しない */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let spacing = [1, 0, 1];
    for (const q of lists.slice(0, -1)) {
      const k = String(q[0]);
      const nums = numsOf(k === 'spacing' ? q.slice(1) : q);
      if (nums.length >= 1) spacing = [nums[0] ?? 1, nums[1] ?? 0, nums[2] ?? 0];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('repeat-inf', { spacing }, [child]);
  }

  if (head === 'repeat3') {
    /* (repeat3 (count nx ny nz) (spacing sx sy sz) <child>) */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let count = [2, 2, 2], spacing = [1, 1, 1];
    for (const p of lists.slice(0, -1)) {
      const k = String(p[0]);
      const nums = numsOf(p.slice(1));
      if (k === 'count')   count   = [nums[0] ?? 2, nums[1] ?? 1, nums[2] ?? 1];
      else if (k === 'spacing') spacing = [nums[0] ?? 1, nums[1] ?? 1, nums[2] ?? 1];
    }
    count = count.map(v => Math.max(1, Math.round(v)));
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('repeat3', { count, spacing }, [child]);
  }

  /* round/onion/twist/bend: スカラー1個の単項ラップ ((r v)/(t v)/(rate v)/(k v)) */
  if (head === 'round' || head === 'onion' || head === 'twist' || head === 'bend') {
    const KEYS = { round: 'r', onion: 't', twist: 'rate', bend: 'rate' };
    const DEF = { round: 0.1, onion: 0.05, twist: 60, bend: 30 };
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let v = DEF[head];
    if (lists.length >= 2) {
      const p = lists[0];
      const kw = String(p[0]);
      const nums = numsOf((kw === KEYS[head] || kw === 'k' || kw === 'rate') ? p.slice(1) : p);
      if (nums.length) v = nums[0];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode(head, { [KEYS[head]]: v }, [child]);
  }

  if (head === 'elongate') {
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let h = [0.5, 0, 0];
    if (lists.length >= 2) {
      const p = lists[0];
      const nums = numsOf(String(p[0]) === 'h' ? p.slice(1) : p);
      h = [Math.abs(nums[0] ?? 0), Math.abs(nums[1] ?? 0), Math.abs(nums[2] ?? 0)];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('elongate', { h }, [child]);
  }

  if (head === 'scale') {
    /* (scale (s sx sy sz) <child>) / (s v)1値=一様 */
    const lists = sx.slice(1).filter(isL);
    const last = lists[lists.length - 1];
    let s = [1, 1, 1];
    if (lists.length >= 2) {
      const p = lists[0];
      const nums = numsOf(String(p[0]) === 's' ? p.slice(1) : p);
      if (nums.length >= 3) s = [nums[0], nums[1], nums[2]];
      else if (nums.length) s = [nums[0], nums[0], nums[0]];
    }
    const child = last ? sdfToNode(last) : makeNode('sphere');
    return makeNode('scale', { s }, [child]);
  }

  /* (grid (file "..") (center x y z) (scale s)) — file は文字列なので kvMap (数値化) を通せない */
  if (head === 'grid') {
    const props = { file: '' };
    for (const e of sx.slice(1)) {
      if (!isL(e) || !e.length) continue;
      const k = String(e[0]);
      /* 文字列リテラルは sexpr.js が {str:".."} に落とす (裸トークンではない)。
         String(e[1]) だと "[object Object]" になり /__gridfile__ が 404 → SDF表示が
         bbox の箱に落ちていた (モデラーが保存した .ssq の再読込が壊れていた)。 */
      if (k === 'file') props.file = (e[1] && typeof e[1] === 'object' && 'str' in e[1])
                                     ? e[1].str : String(e[1]).replace(/^"|"$/g, '');
      else if (k === 'center') props.center = e.slice(1, 4).map(N);
      else if (k === 'scale') props.scale = N(e[1]);
    }
    return makeNode('grid', props);
  }

  if (OPS[head]) {
    let k = head === 'blend' ? 0.5 : 0.25;
    let mode = 'poly';
    const kids = [];
    for (const e of sx.slice(1)) {
      if (!isL(e)) continue;
      const h = String(e[0]);
      if ((h === 'k' || h === 'u') && e.length === 2 && !isL(e[1])) { k = N(e[1]); continue; }
      /* ブレンド種別 (2026-07-29)。拾わないと (mode round) が子ノード扱いになり
         raw ノードが紛れ込んでツリーが壊れる */
      if (h === 'mode' && e.length === 2 && !isL(e[1])) { mode = String(e[1]); continue; }
      kids.push(sdfToNode(e));
    }
    const props = {};
    if (head === 'smooth-union' || head === 'smooth-intersect' || head === 'smooth-subtract') props.k = k;
    if (head === 'smooth-union' || head === 'smooth-intersect') props.mode = mode;
    if (head === 'blend') props.u = k;
    const node = makeNode(head, props, kids);
    return flattenOp(node);
  }

  return makeNode('raw', { text: serialize(sx) });
}

function defaultPivot(child) {
  /* sqm: 子がリーフなら p[0..2] (center または a) が pivot 既定 */
  const sc = SCHEMA[child.type];
  if (sc && sc.kind === 'leaf') {
    const c = child.props.center || child.props.a;
    if (c) return c.slice();
    if (child.type === 'sweep' && child.props.points.length >= 3)
      return child.props.points.slice(0, 3);   /* 経路の始点 */
  }
  return [0, 0, 0];
}

/* 入れ子2項チェーンを n-ary に平坦化。fold 方向を保存する向きだけ:
 *  union/intersect: 完全結合的 → 両側可 / smooth-union: 末尾のみ (右fold) /
 *  subtract, smooth-subtract: 先頭のみ (左fold), k 一致時のみ */
function flattenOp(node) {
  const t = node.type;
  if (t === 'union' || t === 'intersect') {
    const kids = [];
    for (const c of node.children) {
      if (c.type === t) kids.push(...c.children);
      else kids.push(c);
    }
    node.children = kids;
  } else if (t === 'smooth-union' || t === 'smooth-intersect') {
    while (node.children.length) {
      const last = node.children[node.children.length - 1];
      if (last.type === t && Math.abs((last.props.k ?? 0) - (node.props.k ?? 0)) < 1e-12
          && (last.props.mode ?? 'poly') === (node.props.mode ?? 'poly')) {
        node.children.pop();
        node.children.push(...last.children);
      } else break;
    }
  } else if (t === 'subtract' || t === 'smooth-subtract') {
    while (node.children.length) {
      const first = node.children[0];
      const kMatch = t === 'subtract' || Math.abs((first.props.k ?? 0) - (node.props.k ?? 0)) < 1e-12;
      if (first.type === t && kMatch) node.children.splice(0, 1, ...first.children);
      else break;
    }
  }
  return node;
}

/* ── ノード → .ssq sexp ─────────────────────────────────────── */
export function nodeToSdf(node) {
  if (!node) return null;   /* 子の無い単項op等で undefined が渡る → 空として除外 */
  const sx = nodeToSdfCore(node);
  /* 材質色: (mcolor (c r g b) <sub>) ラップで書き出し (sqm がヒット時に色ブレンド) */
  if (sx && node.props.mcolor)
    return ['mcolor', ['c', ...node.props.mcolor.map(fmt)], sx];
  return sx;
}
const UNARY_OPS = new Set(['translate', 'rotate', 'rotate-mat', 'mirror', 'repeat', 'repeat3', 'repeat-inf',
  'round', 'onion', 'elongate', 'scale', 'twist', 'bend']);
function nodeToSdfCore(node) {
  const t = node.type, p = node.props, sc = SCHEMA[t];

  if (t === 'raw') {
    try { return parseAll(p.text)[0] ?? ['sphere', ['center', '0', '0', '0'], ['radius', '0.5']]; }
    catch { return ['sphere', ['center', '0', '0', '0'], ['radius', '0.5']]; }
  }
  /* file は絶対パスで書く: モデラーの .ssq は examples/ に保存され、レンダは一時ディレクトリ
     から走ることもあるので、相対だと解決先が変わってしまう */
  if (t === 'grid') {
    const out = ['grid', ['file', '"' + (p.file || '') + '"']];
    if (p.center && p.center.some(v => v !== 0)) out.push(['center', ...p.center.map(fmt)]);
    if (p.scale != null && Math.abs(p.scale - 1) > 1e-12) out.push(['scale', fmt(p.scale)]);
    return out;
  }
  if (t === 'sweep') {
    const key = p.curve === 1 ? 'spline' : p.curve === 2 ? 'bspline' : 'points';
    const out = ['sweep', [key, ...p.points.map(fmt)]];
    const hasProfile = p.profile && p.profile.length >= 3;
    const r0 = p.radii[0] ?? (hasProfile ? 1 : 0.15);
    if (p.radii.every(r => Math.abs(r - r0) < 1e-12)) out.push(['radius', fmt(r0)]);
    else out.push(['radii', ...p.radii.map(fmt)]);
    if (p.curve) out.push(['steps', fmt(Math.max(2, Math.round(p.steps)))]);
    if (p.closed) out.push(['closed']);
    if (hasProfile) {   /* 任意断面 (Phase 2) */
      const pk = p.profileCurve === 1 ? 'profile-spline' : p.profileCurve === 2 ? 'profile-bspline' : 'profile';
      out.push([pk, ...p.profile.flatMap(q => [fmt(q[0]), fmt(q[1])])]);
      if (p.profileCurve) out.push(['profile-steps', fmt(Math.max(2, Math.round(p.profileSteps)))]);
      if (p.twists && p.twists.length) out.push(['twists', ...p.twists.map(fmt)]);
      else if (Math.abs(p.twist) > 1e-9) out.push(['twist', fmt(p.twist)]);
    }
    return out;
  }
  if (t === 'extrude') {
    const key = p.curve === 1 ? 'spline' : p.curve === 2 ? 'bspline' : 'profile';
    const out = ['extrude', ['center', ...p.center.map(fmt)], ['depth', fmt(p.depth)]];
    if (p.thick > 1e-12) out.push(['thick', fmt(p.thick)]);
    if (p.curve) out.push(['steps', fmt(Math.max(2, Math.round(p.steps)))]);
    out.push([key, ...p.prof.flatMap(q => [fmt(q[0]), fmt(q[1])])]);
    return out;
  }
  if (t === 'lathe') {
    const key = p.curve === 1 ? 'spline' : p.curve === 2 ? 'bspline' : 'profile';
    const out = ['lathe', ['center', ...p.center.map(fmt)]];
    if (Math.abs(p.axis) > 1e-12) out.push(['axis', fmt(p.axis)]);
    if (p.thick > 1e-12) out.push(['thick', fmt(p.thick)]);
    if (p.curve || Math.round(p.steps) !== 16) out.push(['steps', fmt(Math.max(2, Math.round(p.steps)))]);
    out.push([key, ...p.prof.flatMap(q => [fmt(q[0]), fmt(q[1])])]);
    return out;
  }
  if (sc.kind === 'leaf') {
    const out = [t];
    const emitted = new Set();
    for (const [ssqKey, propKey, cnt] of LEAF_KEYS[t]) {
      if (emitted.has(propKey)) continue;
      emitted.add(propKey);
      const v = p[propKey];
      if (v === undefined) continue;   /* スキーマ拡張前に保存された doc の欠損キー */
      out.push([ssqKey, ...(cnt === 1 ? [fmt(v)] : v.map(fmt))]);
    }
    return out;
  }
  /* 単項オプ (子が1つ): 子を先に直列化し、空(子なし)なら op ごと省略 = null */
  if (UNARY_OPS.has(t)) {
    const kid = nodeToSdf(node.children[0]);
    if (kid == null) return null;
    switch (t) {
      case 'translate': return ['translate', ['t', ...p.t.map(fmt)], kid];
      case 'rotate':    return ['rotate', ['deg', ...p.deg.map(fmt), ...p.pivot.map(fmt)], kid];
      case 'rotate-mat': {
        const m = []; for (let i = 0; i < 9; i++) m.push(fmt(p['m' + i]));
        return ['rotate-mat', ...m, ...p.pivot.map(fmt), kid];
      }
      case 'mirror': {
        const pl = ['normal', ...p.normal.map(fmt)];
        if (Math.abs(p.d) > 1e-12) pl.push(fmt(p.d));
        return ['mirror', pl, kid];
      }
      case 'repeat':  return ['repeat', ['count', fmt(Math.max(1, Math.round(p.count)))],
                              ['offset', ...p.offset.map(fmt)], kid];
      case 'repeat3': return ['repeat3', ['count', ...p.count.map(v => fmt(Math.max(1, Math.round(v))))],
                              ['spacing', ...p.spacing.map(fmt)], kid];
      case 'repeat-inf': return ['repeat-inf', ['spacing', ...p.spacing.map(fmt)], kid];
      case 'round':    return ['round', ['r', fmt(p.r)], kid];
      case 'onion':    return ['onion', ['t', fmt(p.t)], kid];
      case 'elongate': return ['elongate', ['h', ...p.h.map(fmt)], kid];
      case 'scale':    return ['scale', ['s', ...p.s.map(fmt)], kid];
      case 'twist':    return ['twist', ['rate', fmt(p.rate)], kid];
      case 'bend':     return ['bend', ['rate', fmt(p.rate)], kid];
    }
  }
  /* ops → 2項へ畳む (空op等の null 子は除外 = "(union null ..)" 不正出力防止) */
  const kids = node.children.map(nodeToSdf).filter(k => k != null);
  if (t === 'invert') return kids.length ? ['invert', kids[0]] : null;
  if (t === 'blend') {
    if (kids.length < 2) return kids[0] ?? null;
    return ['blend', ['u', fmt(p.u)], kids[0], kids[1]];
  }
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  if (t === 'union' || t === 'intersect' || t === 'smooth-union' || t === 'smooth-intersect') {
    /* 右fold: (op a (op b (op c d))) */
    let acc = kids[kids.length - 1];
    for (let i = kids.length - 2; i >= 0; i--) acc = opPair(t, p, kids[i], acc);
    return acc;
  }
  /* subtract / smooth-subtract: 左fold */
  let acc = kids[0];
  for (let i = 1; i < kids.length; i++) acc = opPair(t, p, acc, kids[i]);
  return acc;
}
function opPair(t, p, a, b) {
  if (t === 'smooth-union' || t === 'smooth-intersect' || t === 'smooth-subtract') {
    const out = [t, ['k', fmt(p.k)]];
    if ((t === 'smooth-union' || t === 'smooth-intersect') && p.mode && p.mode !== 'poly')
      out.push(['mode', p.mode]);
    out.push(a, b);
    return out;
  }
  return [t, a, b];
}

/* ── シーン全体 ─────────────────────────────────────────────── */
export function defaultDoc() {
  return {
    version: 1,
    background: [0.16, 0.19, 0.24],
    camera: { from: [4, 3, -8], at: [0, 0.5, 0], up: [0, 1, 0], fov: 42 },
    lights: [
      { raw: '(light (pos 8 10 -6)(intensity 1.3)(color 1 0.97 0.9)(radius 0.6))', pos: [8, 10, -6], color: [1.3, 1.26, 1.17] },
      { raw: '(light (pos -7 4 -4)(intensity 0.35)(color 0.6 0.8 1.0))', pos: [-7, 4, -4], color: [0.21, 0.28, 0.35] },
    ],
    extras: [],
    nbPairs: [],   /* (no-blend a b) の group 番号ペア (native blob の非融合) */
    objects: [{
      name: 'model', visible: true,
      surface: '(surface (color 0.75 0.62 0.45)(ka 0.22)(kd 0.8)(ks 0.35)(phong 24)(roi 1.0))',
      /* 空の smooth-union ルート: パーツを足すと滑らかに融合していく器 */
      root: makeNode('smooth-union', { k: 0.15 }),
    }],
  };
}

export function parseScene(text) {
  const forms = parseAll(text);
  const scene = forms.find(f => isL(f) && f[0] === 'scene');
  if (!scene) throw new Error('(scene ...) が見つかりません');
  const doc = defaultDoc();
  doc.lights = [];
  doc.objects = [];
  for (const item of scene.slice(1)) {
    if (!isL(item)) continue;
    const head = String(item[0]);
    if (head === 'background') {
      const n = numsOf(item.slice(1));
      doc.background = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
    } else if (head === 'camera') {
      const kv = kvMap(item);
      if (kv.from) doc.camera.from = kv.from;
      if (kv.at) doc.camera.at = kv.at;
      if (kv.up) doc.camera.up = kv.up;
      if (kv.fov) doc.camera.fov = kv.fov[0];
    } else if (head === 'light') {
      doc.lights.push(parseLightForm(item));
    } else if (head === 'object') {
      doc.objects.push(parseObjectForm(item));
    } else if (head === 'no-blend') {
      /* (no-blend a b [c ..]) = 列挙群の**全ペア**が非融合。複数行は累積
         (sqm パーサと同じ。⚠ ssq_edit は 2026-08-23 まで最初の 1 行しか
         読まないバグがあった — ここは全行読む) */
      const gs = item.slice(1).filter(x => !isL(x)).map(N).filter(Number.isFinite);
      for (let a = 0; a < gs.length; a++)
        for (let b = a + 1; b < gs.length; b++) {
          const lo = Math.min(gs[a], gs[b]), hi = Math.max(gs[a], gs[b]);
          if (lo !== hi && !doc.nbPairs.some(q => q[0] === lo && q[1] === hi))
            doc.nbPairs.push([lo, hi]);
        }
    } else {
      doc.extras.push(serialize(item));
    }
  }
  if (!doc.objects.length) doc.objects = defaultDoc().objects;
  return doc;
}

/* (light (pos ...)(intensity i)(color ...)) → {raw, pos, color(強度込み)} */
export function parseLightForm(item) {
  const kv = kvMap(item);
  const inten = kv.intensity ? kv.intensity[0] : 1;
  const col = kv.color || [1, 1, 1];
  return { raw: serialize(item), pos: kv.pos || [5, 8, -5], color: col.map(c => c * inten) };
}

function parseObjectForm(item) {
  const obj = { name: 'object', visible: true, surface: '(surface (color 0.7 0.7 0.7)(ka 0.2)(kd 0.75)(ks 0.3)(phong 24))', root: null, extras: [] };
  const blobNodes = [];
  for (const e of item.slice(1)) {
    if (!isL(e)) continue;
    if (e && typeof e === 'object' && 'str' in e) continue;
    const h = String(e[0]);
    if (h === 'surface') obj.surface = serialize(e);
    else if (h === 'sdf') obj.root = e[1] ? sdfToNode(e[1]) : null;
    else if (h === 'blob') {
      const bn = blobFromForm(e);
      if (bn) blobNodes.push(bn); else obj.extras.push(serialize(e));
    }
    else if (h === 'mesh') {
      const mn = meshFromForm(e);
      if (mn) blobNodes.push(mn); else obj.extras.push(serialize(e));
    }
    else obj.extras.push(serialize(e));
  }
  const nameTok = item[1];
  if (nameTok && typeof nameTok === 'object' && 'str' in nameTok) obj.name = nameTok.str;
  else if (nameTok && !isL(nameTok)) obj.name = String(nameTok);
  /* blob は object 直下の行 = ツリー上は union 直下のリーフとして持つ。
     sdf も同居していれば同じ union にぶら下げる (export 側で再び分離する) */
  if (blobNodes.length) {
    obj.root = obj.root ? makeNode('union', {}, [...blobNodes, obj.root])
                        : makeNode('union', {}, blobNodes);
  }
  if (!obj.root) obj.root = makeNode('sphere');
  return obj;
}

/* (blob (weight w)(threshold t)(group g)(pos ..)(scale ..)(rot ..)(super ..)) → node。
 * deform 付きは未対応 (raw 保全に落とす → null を返す) */
function blobFromForm(e) {
  const kv = {};
  let hasSuper = false, deformList = false;
  for (const q of e.slice(1)) {
    if (!isL(q) || !q.length) continue;
    const k = String(q[0]);
    if (k === 'super') hasSuper = true;
    /* deform のリスト形式 ((mode dsl)/(term ..) 一般形) は未対応 → raw 保全。
       旧記法 (deform amp freq phase [mode 0..3]) は一級で持つ */
    if (k === 'deform' && q.slice(1).some(x => isL(x))) deformList = true;
    kv[k] = q.slice(1).map(N);
  }
  if (deformList) return null;
  const sc = kv.scale || [1];
  const scale = sc.length >= 3 ? sc.slice(0, 3) : [sc[0], sc[0], sc[0]];
  const sup = kv.super || [2, 2, 2];
  return makeNode('blob', {
    center: (kv.pos || [0, 0, 0]).slice(0, 3),
    scale,
    rot: (kv.rot || [0, 0, 0]).slice(0, 3),
    weight: kv.weight ? kv.weight[0] : 1,
    threshold: kv.threshold ? kv.threshold[0] : 0,
    group: kv.group ? Math.round(kv.group[0]) : 0,
    e1: sup[0] ?? 2, e2: sup[1] ?? 2, e3: sup[2] ?? 2,
    isSuper: hasSuper ? 1 : 0,
    deformAmp:   kv.deform ? (kv.deform[0] || 0) : 0,
    deformFreq:  kv.deform ? (kv.deform[1] || 0) : 8,
    deformPhase: kv.deform ? (kv.deform[2] || 0) : 0,
    deformMode:  kv.deform ? Math.round(kv.deform[3] || 0) : 0,
  });
}

/* (mesh (file "..")(pos ..)(scale ..)(rot ..)[(smooth 1)(use-mtl)(group-surface ..)..]) → node。
 * file 以外の未知サブフォームは extra に文字列で保全し、書き出しでそのまま戻す */
function meshFromForm(e) {
  let file = '';
  const kv = {}, extra = [];
  for (const q of e.slice(1)) {
    if (!isL(q) || !q.length) continue;
    const k = String(q[0]);
    if (k === 'file') {
      const v = q[1];
      file = (v && typeof v === 'object' && 'str' in v) ? v.str : String(v ?? '');
    } else if (k === 'pos' || k === 'scale' || k === 'rot') {
      kv[k] = q.slice(1).map(N);
    } else if (k === 'smooth') {
      /* シェーディングは extra に埋めず props にする (UI で切り替えるため。
         extra のままだと書き出しで二重に出る) */
      kv.smooth = N(q[1]) ? 1 : 0;
    } else {
      extra.push(serialize(q));
    }
  }
  if (!file) return null;
  const sc = kv.scale || [1, 1, 1];
  return makeNode('mesh', {
    center: (kv.pos || [0, 0, 0]).slice(0, 3),
    scale: sc.length >= 3 ? sc.slice(0, 3) : [sc[0] ?? 1, sc[0] ?? 1, sc[0] ?? 1],
    rot: (kv.rot || [0, 0, 0]).slice(0, 3),
    file, extra, smooth: kv.smooth ?? 0,
  });
}

/* 材質色は (mcolor (c r g b) <sub>) ラップとして書き出す (nodeToSdf が付与)。
 *  sqm 側はヒット時に葉の距離重みで色をブレンド (融合したまま色が混ざる=Phase B)。
 *  旧 Phase A の色分割書き出しは不要になった。警告も現状なし (互換のため export は維持)。 */
export let lastExportWarnings = [];

export function serializeScene(doc, camera) {
  const cam = camera || doc.camera;
  const warnings = [];
  const L = [];
  L.push('(scene');
  L.push(`  (background ${doc.background.map(fmt).join(' ')})`);
  L.push(`  (camera (from ${cam.from.map(fmt).join(' ')}) (at ${cam.at.map(fmt).join(' ')}) (up ${(cam.up || [0, 1, 0]).map(fmt).join(' ')}) (fov ${fmt(cam.fov)}))`);
  /* no-blend は 1 ペア 1 行 (sqm パーサは累積するので必ず正しく再現できる) */
  for (const [a, b] of (doc.nbPairs || [])) L.push(`  (no-blend ${a} ${b})`);
  for (const l of doc.lights) L.push('  ' + l.raw);
  for (const x of doc.extras) L.push('  ' + x);
  for (const obj of doc.objects) {
    /* blob リーフは object 直下の (blob ..) 行として書く (祖先 xform は
       pos/rot に焼き込む)。残りのサブツリーだけを (sdf ..) にする */
    const { blobs, meshes = [], warnings: bw } = collectObjectBlobs(obj.root, { includeHidden: true });
    warnings.push(...bw);
    const stripped = (blobs.length || meshes.length) ? stripBlobLeaves(obj.root) : obj.root;
    const sx = stripped ? nodeToSdf(stripped) : null;
    if (!sx && !blobs.length && !meshes.length) { L.push(`  ; (object "${obj.name}") は空のためスキップ`); continue; }
    /* blob の材質色 (mcolor) は .ssq の blob 行には乗らない — sqm の per-blob 色の
       流儀どおり**色別オブジェクトに分割**する (blob は object をまたいで融合し、
       色は場の寄与で混ざる = プレビューの evalSurf ブレンドと同じ見え方になる)。
       object surface 色と同じ mcolor は分割しない */
    const baseCol = surfaceColor(obj.surface);
    const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-3;
    const baseBlobs = [], colGroups = [];
    for (const b of blobs) {
      if (!b.mcolor || near(b.mcolor, baseCol)) { baseBlobs.push(b); continue; }
      let g = colGroups.find(q => near(q.col, b.mcolor));
      if (!g) { g = { col: b.mcolor, list: [] }; colGroups.push(g); }
      g.list.push(b);
    }
    if (sx || baseBlobs.length || meshes.length) {
      L.push(`  (object "${obj.name}"`);
      L.push('    ' + obj.surface);
      for (const x of (obj.extras || [])) L.push('    ' + x);
      for (const b of baseBlobs) L.push('    ' + blobLine(b.node.props, b.pos, b.rotDeg));
      for (const m of meshes) L.push('    ' + meshLine(m.node.props, m.pos, m.rotDeg));
      if (sx) L.push('    (sdf ' + sdfPretty(sx, 3) + ')');
      L.push('  )');
    }
    colGroups.forEach((g, gi) => {
      L.push(`  (object "${obj.name}~c${gi + 1}"`);
      L.push('    ' + setSurfaceColor(obj.surface, g.col));
      for (const b of g.list) L.push('    ' + blobLine(b.node.props, b.pos, b.rotDeg));
      L.push('  )');
    });
  }
  L.push(')');
  lastExportWarnings = warnings;
  return L.join('\n') + '\n';
}

/* blob / mesh リーフを取り除いた複製ツリーを返す (元は不変)。空になった op/xform は落とす */
function stripBlobLeaves(node) {
  if (!node) return null;
  if (node.type === 'blob' || node.type === 'mesh') return null;
  const sc = SCHEMA[node.type];
  if (!sc || sc.kind === 'leaf') return node;
  const kids = node.children.map(stripBlobLeaves).filter(Boolean);
  if (!kids.length) return null;
  if (kids.length === node.children.length &&
      kids.every((k, i) => k === node.children[i])) return node;   /* 無変更 = 共有 */
  /* union が 1 子になったら子を直接返す (余計な入れ子を作らない) */
  if (kids.length === 1 && (node.type === 'union' || node.type === 'smooth-union'))
    return kids[0];
  return { ...node, children: kids };
}

function sdfPretty(sx, indent) {
  if (!Array.isArray(sx)) return String(sx);
  const flat = serialize(sx);
  if (flat.length + indent * 2 <= 110) return flat;
  const pad = '  '.repeat(indent + 1);
  const head = [];
  let i = 0;
  while (i < sx.length && !Array.isArray(sx[i])) { head.push(String(sx[i])); i++; }
  /* パラメータ的な短いリストはヘッダ行に残す */
  while (i < sx.length && Array.isArray(sx[i]) && serialize(sx[i]).length < 50 && sx[i].every(x => !Array.isArray(x))) {
    head.push(serialize(sx[i])); i++;
  }
  const parts = [];
  for (; i < sx.length; i++) parts.push(sdfPretty(sx[i], indent + 1));
  return '(' + head.join(' ') + (parts.length ? '\n' + pad + parts.join('\n' + pad) : '') + ')';
}

/* surface テキストから (color r g b) を抽出 (プレビュー色) */
export function surfaceColor(surfaceText) {
  const m = /\(color\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/.exec(surfaceText || '');
  return m ? [N(m[1]), N(m[2]), N(m[3])] : [0.7, 0.7, 0.7];
}
export function setSurfaceColor(surfaceText, rgb) {
  const rep = `(color ${rgb.map(fmt).join(' ')})`;
  if (/\(color\s[^)]*\)/.test(surfaceText)) return surfaceText.replace(/\(color\s[^)]*\)/, rep);
  return surfaceText.replace(/^\(surface/, '(surface ' + rep);
}

/* JSON 直列化 (ノードidは保存し、読込時に idCounter を進める) */
export function docToJSON(doc) { return JSON.stringify(doc); }
export function docFromJSON(json) {
  const doc = JSON.parse(json);
  if (!doc.nbPairs) doc.nbPairs = [];   /* blob 対応前の autosave にも耐える */
  let maxId = 0;
  const walk = n => { const m = /^n(\d+)$/.exec(n.id); if (m) maxId = Math.max(maxId, +m[1]); (n.children || []).forEach(walk); };
  doc.objects.forEach(o => walk(o.root));
  idCounter = maxId + 1;
  return doc;
}
