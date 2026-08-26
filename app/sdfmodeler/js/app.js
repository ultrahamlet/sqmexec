/* app.js — UIグルー: シーンツリー編集 / インスペクタ / ファイルI/O / undo */
import {
  SCHEMA, makeNode, cloneNode, defaultDoc,
  parseScene, serializeScene, surfaceColor, setSurfaceColor,
  parseLightForm, docToJSON, docFromJSON, lastExportWarnings,
  eulerToMat, matToEulerDeg,
} from './model.js';
import {
  buildProgram, collectParams, collectPartColors, collectMatColors, autoPartColor,
  collectObjSpheres, objSphere, countUniformVectors, collectGrids, collectLeafCosts,
} from './codegen.js';
import { Viewer } from './viewer.js';
import { Gizmo } from './gizmo.js';
import { BoneOverlay } from './bones.js';
import {
  worldAnchor, worldPoint, localAnchor, worldToLocalDelta, localToWorldDelta,
  matmul3, axisAngleMat,
} from './anchor.js';
import { scaleAxesFor, applyScale } from './scale.js';
import { isPng, readPngScene } from './pngmeta.js';
import { fmt, parseAll } from './sexpr.js';
import {
  fnv1a, gridForObject, spanOfSpheres, mergeMeshes, MeshCache,
  parseMeshBuffer, pooledMap,
} from './meshcache.js';
import { BlobMesher } from './mbblob.js';
import { LocalSdfMesher } from './sdfmeshlocal.js';
import { collectSceneBlobs, collectObjectBlobs, rayPickBlob, blobRotMat, blobMatToEulerDeg, visibleRatio, threshFromWeight } from './blobnode.js';
import { loadObj, objCacheGet, objCacheDrop, meshModelMat, meshNrmMat, rayPickObjMesh, buildGroupColored, buildShaded} from './objmesh.js';

const $ = s => document.querySelector(s);
const LS_KEY = 'sdfmodeler.autosave.v1';

/* ── 状態 ─────────────────────────────────────────────────── */
let doc = defaultDoc();
let sel = { objIdx: 0, nodeId: null };   /* nodeId=null → オブジェクト自体 */
let layout = null;
let partColorOn = false;
let undoStack = [], redoStack = [];
let viewer, gizmo, boneOverlay;

const PRIM_TYPES = ['sphere', 'box', 'ellipsoid', 'torus', 'capsule', 'cylinder', 'cylinder-ab',
  'round-cone', 'round-cone-ab', 'capped-cone', 'capped-cone-ab', 'cone', 'octahedron', 'superquad', 'sweep', 'lathe', 'extrude', 'box-frame', 'plane', 'torus-ellipse', 'blob'];
const OP_TYPES = ['union', 'smooth-union', 'subtract', 'smooth-subtract', 'intersect', 'smooth-intersect', 'blend', 'invert'];
const WRAP_TYPES = ['— 変換', 'translate', 'rotate', 'scale',
  '— 変形', 'mirror', 'repeat', 'repeat3', 'repeat-inf', 'round', 'onion', 'elongate', 'twist', 'bend',
  '— 演算', 'smooth-union', 'smooth-subtract', 'smooth-intersect', 'union', 'subtract', 'intersect', 'invert'];

/* ── 検索ヘルパ ───────────────────────────────────────────── */
function findNode(root, id, parent = null) {
  if (root.id === id) return { node: root, parent };
  for (const c of root.children) {
    const r = findNode(c, id, root);
    if (r) return r;
  }
  return null;
}
function selectedObj() { return doc.objects[sel.objIdx] || doc.objects[0]; }
function selectedNode() {
  if (sel.nodeId == null) return null;
  const obj = selectedObj();
  const r = obj && findNode(obj.root, sel.nodeId);
  return r ? r.node : null;
}

/* ── undo ─────────────────────────────────────────────────── */
function snapshot() {
  undoStack.push(docToJSON(doc));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(docToJSON(doc));
  doc = docFromJSON(undoStack.pop());
  afterDocReplace();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(docToJSON(doc));
  doc = docFromJSON(redoStack.pop());
  afterDocReplace();
}
function afterDocReplace() {
  sel = { objIdx: Math.min(sel.objIdx, doc.objects.length - 1), nodeId: null };
  refreshBlobPairRef();   /* undo/redo 後は差分の基準を取り直す (stale ref の誤同期防止) */
  rebuild();
  renderTree();
  renderInspector();
  autosave();
}

/* ── ビルド/更新 ──────────────────────────────────────────── */
/* uniform 上限を超えると link が失敗して真っ暗になる。GL の生エラーでは原因が分からないので、
   焼く前に検査して警告する。
   ※数値パラメータは float テクスチャに載せたので uPar 由来の超過はもう起きない。残る要因は
     uPartCol[]/uMatCol[] が「1ノードあたり2 vectors」で効くこと (概ね500ノード弱が上限)。
     したがって原因はノード数しかあり得ず、steps を下げても1個も減らない (自動降格は撤去済)。
   詳細: docs/2026-07-15_sdfmodeler_WebGL_uniform上限.md */
function uniformOverflowMsg(need, max) {
  let n = 0;
  const walk = x => { n++; (x.children || []).forEach(walk); };
  for (const o of doc.objects) walk(o.root);
  /* 「更新できません」= 表示は直前の正常なモデルのまま (初回読み込み時は何も無いので真っ暗)。
     ツリーは新しいモデルなのに絵が古い、という食い違いを文言で明示しておく。 */
  return `uniform ${need}/${max} 超過のためプレビューを更新できません (表示は前のまま)` +
         ` — ノードが多すぎます (${n}個)。パーツを減らしてください`;
}

/* ── メッシュプロキシ (serve.py /__mesh__ = SQM_SDF_DUMP → marching cubes) ──────
 * 重いモデルの編集用: レイマーチ (ピクセル×ノード数) の代わりに三角形ラスタライズ。
 * 編集は 0.4s デバウンスで再メッシュ化 (取得中に来た要求は pending で1回に集約)。
 * uniform 上限超過モデルでも動く (レイマーチと独立の経路) — rebuild() の早期returnより
 * 前に scheduleMesh() を置いているのはそのため。 */
/* 表示モードはツールバーの「表示」セレクタ (#selView) に集約 (チェックボックスは廃止):
 *   value=0    → SDF (レイマーチ, 色/影/色分けが出る。軽いモデル向き)
 *   value>=100 → メッシュプロキシ (grid=値。三角形数だけに依存=重いモデルでもハングしない)
 * 既定はメッシュ標準 (起動時からメッシュで俯瞰・配置)。SDF詳細タブは常に SDF レイマーチ。
 * serve.py が無い/失敗した環境ではメッシュ取得が失敗するので、自動で SDF に落とす。 */
let meshOn = false, meshBusy = false, meshPending = false, meshTimer = null;
function currentGrid() { return parseInt($('#selView').value, 10) || 0; }
/* セレクタ値を表示モードへ反映 (0=SDF / >=100=メッシュ) */
function applyViewMode() {
  meshOn = currentGrid() >= 100;
  viewer.setMeshProxy(meshOn);
  updateObjBtn();
  if (meshOn) refreshMesh(); else viewer.requestRender();
  saveViewPref();
}
/* OBJ 書き出しボタンはメッシュ表示中かつメッシュ到着済みのときだけ出す
   (SDF レイマーチ中は書き出す三角形が無い) */
function updateObjBtn() {
  const b = $('#btnExportObj');
  if (b) b.hidden = !(meshOn && (viewer.hasMeshParts() || viewer._blobData));
}
function saveViewPref() {
  try { localStorage.setItem('sdfm_view', $('#selView').value); } catch {}
}
/* オブジェクト単位キャッシュ (2026-08-04, js/meshcache.js):
 * 編集で変わるのは普通1オブジェクトだけなので、オブジェクトごとに
 * 「単体 .ssq テキスト + grid」の内容ハッシュをキーにメッシュを持ち、
 * **変わったものだけ** /__mesh__ へ投げてクライアントで結合する。
 * objIdx は追跡しない — 内容ハッシュなら undo/redo/取込のどの経路でも
 * 正しく差分になる。per-object grid はボクセル寸法が全体ダンプと揃うよう
 * シーン寸法比でスケール。サーバ (serve.py) は無改修。 */
const meshCache = new MeshCache(64);
/* SDF ローカル再メッシュ (B案): engine パーサ+評価器の WASM を Web Worker で。
   使えないとき (worker 不可 / 非対応ノード) はサーバ /__mesh__ に落ちる */
const localMesher = new LocalSdfMesher();

/* 純 blob オブジェクトはメッシュ化ジョブに出さない (WASM 再メッシュの重ね描きが
   受け持つ)。混在オブジェクトは blob 行だけ落として sdf 部を投げる —
   落とさないと field2obj が「blob と SDF の両方」で kind 判定に失敗する */
/* この object に **marching cubes に掛けられる** リーフが在るか。
   ⚠ blob と mesh(OBJ) は数えない — どちらも距離場に出ないので、数えると
     「(mesh ..) だけの object」にジョブが作られ、(sdf も blob も無いテキストが
     field2obj.detect_kind に渡って "blob も SDF も無いシーン" で落ちる。
     すると refreshMesh 全体が失敗し、**表示セレクタが SDF に押し戻されて
     メッシュ表示に切り替えられなくなる** (2026-08-25 修正)。
     mesh(OBJ) は元から三角形なので refreshObjMeshes が直接ラスタライズする。
     mesh が leaf 型になったのは第8弾 (2026-08-23) で、この判定が追随していなかった。 */
function objHasSdfLeaf(o) {
  let f = false;
  const walk = n => {
    if (f) return;
    const sc = SCHEMA[n.type];
    if (sc && sc.kind === 'leaf') { if (n.type !== 'blob' && n.type !== 'mesh') f = true; return; }
    n.children.forEach(walk);
  };
  if (o && o.root) walk(o.root);
  return f;
}
/* メッシュ化に投げるテキスト。blob と mesh(OBJ) の行は落とす —
   場に出ないので無駄なだけでなく、(mesh ..) はローカル WASM が
   "obj_load はWASMでは非対応" で落ちる (= sdf と mesh が同居する object が
   毎回サーバ経路へ落ちる)。 */
function objMeshText(o) {
  return serializeScene({ ...doc, objects: [o] }, viewer.getCamera())
    .split('\n').filter(l => !/^\s*\((blob|mesh) /.test(l)).join('\n');
}

/* ハイブリッド表示 (focus ドラッグ中の文脈メッシュ) のために、リーフが多い
   シーンでは SDF レイマーチ表示中でもメッシュを温めておく。serve.py が無い
   環境では一度失敗したら黙って諦める (SDF 表示の邪魔をしない) */
let hybridMeshDead = false;
let meshParts = null;          /* doc.objects 対応の {verts,normals,indices}|null 配列 */
function meshWanted() {
  return meshOn || (!hybridMeshDead && totalLeafCount() > FOCUS_LEAF_THRESHOLD);
}

async function refreshMesh() {
  if (!meshWanted()) return;
  if (meshBusy) { meshPending = true; return; }
  meshBusy = true;
  /* ハイブリッド温め (SDF 表示中) は文脈用なので控えめな grid = ローカル WASM が
     数十〜百ms で回る帯に収める。メッシュ表示は従来どおりセレクタの値 */
  const grid = meshOn ? (currentGrid() || 160) : 96;
  const t0 = performance.now();
  try {
    const spheres = doc.objects.map(o => { try { return objSphere(o); } catch { return null; } });
    const sceneSpan = spanOfSpheres(spheres);
    const jobs = doc.objects.map((o, i) => {
      if (!objHasSdfLeaf(o)) return null;
      const text = objMeshText(o);
      const g = gridForObject(spheres[i] ? spheres[i][3] * 2 : 0, sceneSpan, grid);
      return { text, g, key: fnv1a(text) + ':' + g };
    });
    let fetched = 0;
    /* 取得は 2 経路: ①ローカル WASM (sdfmesh = engine パーサ+評価器, worker)
       ②サーバ /__mesh__ (sqm 起動 + skimage MC)。ローカルは低〜中 grid で速く
       serve.py 不要、サーバは高 grid で速い (ネイティブ+numpy)。
       → grid<=112 はローカル優先 / それ超はサーバ優先・サーバ不達ならローカルが
       受け皿。grid リーフ (.f32 が要る) と非対応ノード (volume/dsl変位) は
       ローカル不可 → サーバのみ。統計は window.__smwStats (デバッグ用) */
    const stats = () => (window.__smwStats ||= { local: 0, server: 0, fail: [] });
    const tryLocal = async job => {
      const part = await localMesher.mesh(job.text, job.g);
      meshCache.set(job.key, part);
      fetched++;
      stats().local++;
      return part;
    };
    const tryServer = async job => {
      const res = await fetch('/__mesh__?grid=' + job.g,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: job.text });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const j = await res.json();
        /* 「メッシュ化対象が無い」(床plane だけ等) は正常系 — 空で覚える。
           ⚠ field2obj は "blob も SDF も無いシーン" という別の文言でも投げるので
              両方拾う (「対象」だけだと当たらず、シーン全体の失敗になっていた) */
        if (/対象|blob も SDF も無い/.test(j.error || '')) {
          meshCache.set(job.key, null); return null;
        }
        throw new Error(j.error || 'メッシュ化失敗');
      }
      if (!res.ok) throw new Error('サーバが未対応 (serve.py 経由で開いていない可能性)');
      const part = parseMeshBuffer(await res.arrayBuffer());
      /* サーバ焼きは色を持たない → ローカル WASM で頂点色 (surface 色 + mcolor
         ブレンド) を後付けする。失敗しても形はそのまま (単色表示) */
      if (!localMesher.dead && !job.text.includes('(grid ')) {
        try { part.colors = await localMesher.colorize(job.text, part.verts); }
        catch (e) { /* 非対応 → 単色のまま */ }
      }
      meshCache.set(job.key, part);
      fetched++;
      stats().server++;
      return part;
    };
    const parts = await pooledMap(jobs, async job => {
      if (!job) return null;
      const hit = meshCache.get(job.key);
      if (hit !== undefined) return hit;
      const canLocal = !localMesher.dead && !job.text.includes('(grid ');
      if (canLocal && job.g <= 112) {
        try { return await tryLocal(job); }
        catch (e) { stats().fail.push(String(e.message).slice(0, 120)); }
      }
      try { return await tryServer(job); }
      catch (e) {
        if (canLocal && job.g > 112) {          /* サーバ不達 → ローカルが受け皿 */
          try { return await tryLocal(job); }
          catch (e2) { stats().fail.push(String(e2.message).slice(0, 120)); }
        }
        throw e;
      }
    }, 4);
    /* object 単位のスロットで viewer へ (非表示 object は null に落とす)。
       ハイブリッド表示が「編集中 object 以外」を選んで描けるようにする */
    meshParts = parts.map((p, i) => (doc.objects[i] && doc.objects[i].visible) ? p : null);
    viewer.setMeshParts(meshParts);
    const nt = meshParts.reduce((s, p) => s + (p ? p.indices.length / 3 : 0), 0);
    const ms = (performance.now() - t0).toFixed(0);
    updateObjBtn();          /* メッシュ到着 → OBJ 書き出し可 */
    if (meshOn)              /* ハイブリッド温め (SDF 表示中) では status を汚さない */
      setStatus(`メッシュ ${nt.toLocaleString()} tris / grid ${grid} / ${ms}ms`
        + ` (${fetched ? `再計算 ${fetched}/${jobs.length} obj` : '全キャッシュ'})`);
  } catch (e) {
    if (!meshOn) {
      /* ハイブリッド温めの失敗 (serve.py 無し等) は SDF 表示の邪魔をしない —
         黙って諦める (以後この判定で温めない)。文脈はボーンにフォールバック */
      hybridMeshDead = true;
    } else {
      /* serve.py 無し等でメッシュ化できない → SDF レイマーチへ自動フォールバック
         (メインが真っ白にならないように)。セレクタも SDF に戻す。 */
      meshOn = false;
      viewer.setMeshProxy(false);
      updateObjBtn();
      if ($('#selView').value !== '0') { $('#selView').value = '0'; saveViewPref(); }
      viewer.requestRender();
      setStatus('メッシュ化不可 (' + e.message + ') → SDF 表示に切替。'
        + 'メッシュ表示は serve.py 経由で開くと使えます', true);
    }
  } finally {
    meshBusy = false;
    if (meshPending) { meshPending = false; refreshMesh(); }
  }
}
function scheduleMesh() {
  if (!meshWanted()) return;
  clearTimeout(meshTimer);
  /* ローカル WASM が使えるなら短いデバウンスで追従 (サーバ往復は 400ms のまま)。
     ギズモドラッグ中は延期 — per-frame のドラッグドラフト (scheduleDragMesh) が
     受け持ち、途中位置の full-grid 結果が後から届いて巻き戻るのを防ぐ */
  meshTimer = setTimeout(() => {
    if (viewer && viewer.interactive === true) { scheduleMesh(); return; }
    refreshMesh();
  }, localMesher.dead ? 400 : 120);
}

/* ── SDF ドラッグ中の per-frame 再メッシュ (メッシュ表示モード) ──
 * blob の level5 相当: 編集中 object だけ低 grid でローカル WASM に毎イベント
 * 投げる。worker は直列なので latest-wins で合流 (処理中に来た分は最新だけ保持)。
 * ドラッグが終わると scheduleMesh の full-grid 再取得が上書きする。 */
const DRAG_GRID = 48;
let dragMeshBusy = false, dragMeshNext = null;
function scheduleDragMesh() {
  if (!meshOn || localMesher.dead) return;        /* メッシュ表示モードのみ */
  if (!viewer || viewer.interactive !== true) return;
  const oi = sel.objIdx;
  const obj = doc.objects[oi];
  if (!obj || !obj.visible || !objHasSdfLeaf(obj)) return;
  const text = objMeshText(obj);
  if (text.includes('(grid ')) return;            /* .f32 はローカル不可 */
  dragMeshNext = { oi, text };
  pumpDragMesh();
}
async function pumpDragMesh() {
  if (dragMeshBusy || !dragMeshNext) return;
  const job = dragMeshNext;
  dragMeshNext = null;
  dragMeshBusy = true;
  try {
    const part = await localMesher.mesh(job.text, DRAG_GRID);
    if (!meshParts) meshParts = doc.objects.map(() => null);
    if (job.oi < meshParts.length) {
      meshParts[job.oi] = part;
      viewer.setMeshPart(job.oi, part);
    }
  } catch (e) { /* 非対応ノード等 → 静的メッシュのまま */ }
  dragMeshBusy = false;
  pumpDragMesh();
}

/* ── native blob: WASM (mbmesh = vclay 1992 評価器) でクライアント内再メッシュ ──
 * blob は GLSL レイマーチに出せない (密度場は sphere trace 不能) ので、
 * 場・等値面が sqm と厳密に同じ WASM ポリゴナイザで常時メッシュ表示する。
 * ドラッグ中は level 5 (実測 ~10ms/97blob) で即時、確定時は level 6。 */
let blobMesher = null, blobMesherLoading = false;
let blobPicks = [];          /* クリックピック用 (collectSceneBlobs の picks) */
let objPicks = [];           /* mesh(OBJ) ノードのピック用 (refreshObjMeshes が焼く) */
let blobTimer = null;
let blobWarned = '';
/* ── Pair: 対称配置 blob の鏡映同時編集 (ssq_edit の Pair 移植) ──
 * blobPair = { selId, partnerId, axis, ref } 。selId への編集差分を
 * partner へ鏡映で適用する: 移動=軸成分反転 / 回転=軸成分同符号・他2成分逆符号 /
 * scale=比で同一 / weight・threshold・e=差分で同一。差分は ref (直前の同期後
 * スナップショット) との差 — 初期の非対称は保たれる。 */
let blobPair = null;
let pairArm = null;           /* ペア相手待ちの selId (次の blob クリックで確定) */
/* findNodeAnywhere (既存, {node, objIdx} を返す) の node だけ欲しい版 */
const blobNodeById = id => (findNodeAnywhere(id) || {}).node || null;
const blobPropsCopy = p => ({
  center: p.center.slice(), scale: p.scale.slice(), rot: p.rot.slice(),
  weight: p.weight, threshold: p.threshold, e1: p.e1, e2: p.e2, e3: p.e3,
});
function refreshBlobPairRef() {
  if (!blobPair) return;
  const a = blobNodeById(blobPair.selId);
  if (a && a.type === 'blob') blobPair.ref = blobPropsCopy(a.props);
  else blobPair = null;
}
function syncBlobPair() {
  if (!blobPair) return;
  const a = blobNodeById(blobPair.selId);
  const b = blobNodeById(blobPair.partnerId);
  if (!a || !b || a.type !== 'blob' || b.type !== 'blob') { blobPair = null; return; }
  const p = a.props, q = b.props, ref = blobPair.ref, ax = blobPair.axis;
  let touched = false;
  for (let i = 0; i < 3; i++) {
    const d = p.center[i] - ref.center[i];
    if (d) { q.center[i] += (i === ax ? -d : d); touched = true; }
    const dr = p.rot[i] - ref.rot[i];
    if (dr) { q.rot[i] += (i === ax ? dr : -dr); touched = true; }
    const r = ref.scale[i] !== 0 ? p.scale[i] / ref.scale[i] : 1;
    if (r !== 1) { q.scale[i] *= r; touched = true; }
  }
  for (const k of ['weight', 'threshold', 'e1', 'e2', 'e3']) {
    const d = p[k] - ref[k];
    if (d) { q[k] += d; touched = true; }
  }
  if (touched) blobPair.ref = blobPropsCopy(p);
}

/* 選択 blob のハイライトリング (可視楕円体)。選択変更と再メッシュ後に追従 */
function updateBlobSelRing() {
  if (!viewer) return;
  const node = selectedNode();
  if (node && node.type === 'mesh') {   /* mesh(OBJ) はワイヤ bbox で枠を出す */
    const e = objPicks.find(q => q.node.id === node.id);
    viewer.setBlobSel(e ? { box: { model: e.model, lo: e.mesh.lo, hi: e.mesh.hi } } : null);
    return;
  }
  const pk = node && node.type === 'blob'
    ? blobPicks.find(p => p.node.id === node.id) : null;
  viewer.setBlobSel(pk ? { pos: pk.pos, rotMat: pk.rotMat,
                           radii: pk.scale.map((s, i) => s * pk.vr) } : null);
}
/* ── mesh(OBJ) ノードの表示同期 (第8弾) ──────────────────────
   幾何は objmesh.js のキャッシュ (fetch は file ごとに1回)。ここは行列と色を
   焼き直すだけなので、ギズモドラッグの per-frame 呼び出しでも軽い
   (viewer 側も verts 参照が同じ間は GPU 再転送しない) */
/* mesh ノードの extra から group-surface の (color ..) を引く: 名前 → [r,g,b] */
function meshGroupColors(node) {
  const out = new Map();
  for (const x of (node.props.extra || [])) {
    if (!/^\(group-surface/.test(x)) continue;
    try {
      const f = parseAll(x)[0];
      let name = f[1];
      name = (name && typeof name === 'object' && 'str' in name) ? name.str : String(name ?? '');
      const c = f.find(q => Array.isArray(q) && String(q[0]) === 'color');
      if (name && c) out.set(name, [parseFloat(c[1]) || 0, parseFloat(c[2]) || 0, parseFloat(c[3]) || 0]);
    } catch {}
  }
  return out;
}
function refreshObjMeshes() {
  if (!viewer) return;
  const entries = [];
  objPicks = [];
  for (let oi = 0; oi < doc.objects.length; oi++) {
    const obj = doc.objects[oi];
    if (!obj.visible) continue;
    const { meshes = [] } = collectObjectBlobs(obj.root);
    if (!meshes.length) continue;
    const col = surfaceColor(obj.surface);
    for (const m of meshes) {
      const st = loadObj(m.node.props.file, () => { refreshObjMeshes(); updateBlobSelRing(); });
      if (st.status === 'loading') continue;
      if (st.status !== 'ok') {
        if (!st.warned) {
          st.warned = true;
          setStatus('mesh(OBJ) 読めない: ' + m.node.props.file + ' — ' + st.error, true);
        }
        continue;
      }
      let g = st.mesh;
      /* シェーディング: エンジンの規約で法線を焼き直す (objmesh.buildShaded)。
         これをしないとモデラーだけ常にスムーズ = sqm でフラットになる食い違いが出る。
         キャッシュはファイル単位なので mode ごとに持つ (同じ OBJ を別モードで
         参照する2ノードがありうる) */
      const shadeMode = m.node.props.smooth ? 'smooth' : 'file';
      if (!st.shaded) st.shaded = new Map();
      if (!st.shaded.has(shadeMode)) st.shaded.set(shadeMode, buildShaded(g, shadeMode));
      g = st.shaded.get(shadeMode);
      /* group-surface 色分け: extra に (color ..) 付き group-surface があれば
         グループごとに頂点色を焼いた複製ジオメトリで表示する (エンジンの
         塗り分けと同じ o/g 一致規則)。写像が変わったときだけ焼き直し =
         キャッシュエントリに (キー, ジオメトリ) で持つ。ピック/選択枠は
         元ジオメトリ (mesh: g) のまま */
      let geom = g;
      const gcols = meshGroupColors(m.node);
      if (gcols.size && g.groupNames.length) {
        const key = JSON.stringify([...gcols]) + '|' + col.join(',') + '|' + shadeMode;
        if (!st.colored || st.colored.key !== key) {
          st.colored = { key, geom: buildGroupColored(g,
            gi => gcols.get(g.groupNames[gi]) || null, col) };
        }
        geom = st.colored.geom;
      }
      const e = {
        verts: geom.verts, normals: geom.normals, colors: geom.colors || null,
        indices: geom.indices,
        model: meshModelMat(m.pos, m.rotMat, m.node.props.scale),
        nrm: meshNrmMat(m.rotMat, m.node.props.scale),
        col, node: m.node, objIdx: oi,
        pos: m.pos, rotMat: m.rotMat, scale: m.node.props.scale, mesh: g,
      };
      entries.push(e);
      objPicks.push(e);
    }
  }
  viewer.setObjMeshes(entries);
}
function refreshBlobMesh() {
  if (!viewer) return;
  const { records, picks, warnings } = collectSceneBlobs(doc);
  blobPicks = picks;
  updateBlobSelRing();
  if (!records.length) { viewer.setBlobMesh(null); return; }
  if (!blobMesher) {
    if (!blobMesherLoading) {
      blobMesherLoading = true;
      BlobMesher.create()
        .then(m => { blobMesher = m; refreshBlobMesh(); })
        .catch(e => {
          console.error(e);
          setStatus('blob メッシャ (mbmesh.wasm) 初期化失敗: ' + e.message, true);
        });
    }
    return;
  }
  /* deform 付き blob があるときは確定メッシュを 1 段細かく焼く —
     高周波の凹凸は level 6 だと鈍って sqm レンダーと見た目がずれる。
     blob Lv セレクタ (>0) はそれを明示上書きする: 低 = 粗い格子で場を均す
     (amp>iso の deform でも破れが閉じる) / 高 = 真の等値面に近い */
  const anyDeform = (() => {
    for (let i = 19; i < records.length; i += 23) if (records[i]) return true;
    return false;
  })();
  const lvSel = document.querySelector('#selBlobLv');
  if (lvSel && lvSel.hidden) lvSel.hidden = false;   /* blob のあるシーンで出す */
  const override = lvSel ? (parseInt(lvSel.value, 10) || 0) : 0;
  const settle = override || (anyDeform ? 7 : 6);
  const level = viewer.interactive === true ? Math.min(5, settle) : settle;
  try {
    const t0 = performance.now();
    const m = blobMesher.meshRecords(records, doc.nbPairs || [], level);
    viewer.setBlobMesh({ verts: m.positions, normals: m.normals,
                         colors: m.colors, indices: m.indices });
    if (viewer.interactive !== true)
      setStatus(`blob ${picks.length} 個 → ${(m.indices.length / 3).toLocaleString()} tris`
        + ` / level ${level} / ${(performance.now() - t0).toFixed(0)}ms (wasm)`);
    const w = warnings.join(' / ');
    if (w && w !== blobWarned) { blobWarned = w; setStatus(w, true); }
  } catch (e) {
    console.error(e);
    setStatus('blob 再メッシュ失敗: ' + e.message, true);
  }
}
function scheduleBlobMesh() {
  if (viewer && viewer.interactive === true) { refreshBlobMesh(); return; }   /* ドラッグ: 即時追従 */
  clearTimeout(blobTimer);
  blobTimer = setTimeout(refreshBlobMesh, 60);
}

/* 取込グリッド (.f32) を serve.py 経由で取得して viewer に載せる。
   一度読んだファイルはキャッシュ (6MB級なので毎回は取らない)。取得完了後に
   再アップロードするので、初回だけ一瞬 bbox の箱で描かれる。 */
const gridCache = new Map();
let gridsPending = false;
async function ensureGrids() {
  const want = collectGrids(doc);
  if (!want.length) { viewer.setGrids([]); return; }
  const missing = want.filter(g => !gridCache.has(g.file));
  if (!missing.length) { viewer.setGrids(want.map(g => gridCache.get(g.file))); return; }
  if (gridsPending) return;
  gridsPending = true;
  try {
    for (const g of missing) {
      const res = await fetch('/__gridfile__', { method: 'POST', body: g.file });
      if (!res.ok) throw new Error('グリッド取得失敗: ' + g.file);
      const buf = await res.arrayBuffer();
      const dims = [...new Uint32Array(buf, 0, 3)];
      const f = new Float32Array(buf, 12, 4);
      gridCache.set(g.file, { file: g.file, dims, lo: [f[0], f[1], f[2]], h: f[3],
                              data: new Float32Array(buf, 28) });
    }
    viewer.setGrids(collectGrids(doc).map(g => gridCache.get(g.file)).filter(Boolean));
    rebuild();                     /* スロットが埋まったので箱→実物へ焼き直す */
  } catch (e) {
    console.error(e);
    setStatus('取込グリッドの読み込みに失敗 (SDF表示は bbox の箱): ' + e.message, true);
  } finally { gridsPending = false; }
}

/* 非同期リンク待ちの間 true。パラメータ/色テクスチャは**新プログラムの
   スロット配置**で作るので、リンク完了前にアップロードすると「古いプログラム +
   新しいパラメータ」のミスマッチになり、コンパイルの数秒間だけ画面が化ける
   (2026-08-23 ユーザー報告: 滑らか和の子にトーラスを追加すると壊れて見える —
   兄弟追加はプログラムキャッシュ命中=即時切替なので化けなかった)。
   リンク完了 (onDone) までアップロードを遅延し、古いプログラムには古い
   パラメータを残す。ドラッグ等の updateParams もこの間はスキップし、
   完了時に最新 doc から作り直すので編集は取りこぼさない。 */
let layoutPending = false;
/* 影 / AO は uniform では切れない (HLSL が map をインライン展開するのでコンパイル代は
   実行時のON/OFFに関係なく満額かかる) → **生成時のフラグ**にしている。チェックを
   変えたら rebuild() が要る = その1回だけ再コンパイル待ちが入る。プログラムキャッシュ
   (LRU) に両方載るので、以後のトグルは即時。実測 rabbit 11.9s->8.2s / scale_test 3.5s->1.8s。
   単一情報源はチェックボックスそのもの (状態を二重に持たない) */
/* シェーダのコンパイル中バッジ。setProgram は KHR_parallel_shader_compile で
   非同期になり、ノード数と距離関数のインライン展開でシーンによっては十数秒かかる
   → 何も出さないと「固まった」と誤解される。ステータス行はメッシュ再生成などに
   上書きされてしまう (実測: 「コンパイル中…」がメッシュの完了メッセージに消された)
   ので、ビューポート上に独立したバッジを出す。
   キャッシュ命中時は onDone が同期で走る = 表示→非表示が同一タックで完結し描画されない。 */
let compileTimer = null;
function showCompiling(on, note) {
  const el = $('#compiling');
  if (!el) return;
  clearInterval(compileTimer);
  compileTimer = null;
  if (!on) { el.hidden = true; return; }
  if (!el.firstChild) {
    const b = document.createElement('b');
    b.textContent = 'シェーダをコンパイル中';
    const dots = document.createElement('span');
    dots.className = 'dots';
    const sub = document.createElement('span');
    sub.className = 'sub';
    el.append(b, dots, document.createElement('br'), sub);
  }
  const sub = el.querySelector('.sub');
  const t0 = performance.now();
  const paint = () => {
    sub.textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' 秒経過'
      + (note ? ' / ' + note : '') + '  (ノードが多いほど長くかかります)';
  };
  paint();
  el.hidden = false;
  compileTimer = setInterval(paint, 100);
}

function progOpts(extra) {
  return Object.assign({
    shadow: !!($('#chkShadow') || {}).checked,
    ao:     !!($('#chkAO')     || {}).checked,
    /* 描画用からは uPick 分岐を外す = probe の2つ目のインライン展開を払わない。
       probe は木をもう一度展開する上に計測文のぶん sdObj より本体が大きく、
       静的集計で**展開総量の 38〜43%** を占めていた (rabbit 33KB のうち 14KB)。
       片方消すだけで 19〜21% 減る。ピックは別プログラムに逃がす (下の schedulePickProg)。 */
    pick: false,
  }, extra);
}

/* ── ピック専用プログラム ────────────────────────────────────
   uPick 分岐だけを持つプログラムを、編集の手が止まってから裏で焼く。
   クリックするまで要らないので、描画の初回表示を待たせない。
   未完成のうちは viewer.pick() が描画用プログラムに落ちる (uPick 分岐が無いので
   -1 = 何も選べない) ため、焼き上がるまでの数秒はピックだけが効かない。 */
let pickProgTimer = null;
const PICK_PROG_IDLE_MS = 900;
function schedulePickProg() {
  clearTimeout(pickProgTimer);
  viewer.setPickProgram(null);          /* 古いレイアウトのものは使わない */
  pickProgTimer = setTimeout(() => {
    try {
      const p = buildProgram(doc, null, progOpts({ pick: true }));
      /* レイアウトは pick の有無で変わらない = 描画用と params を共有できる */
      viewer.compileAux(p.frag, prog => viewer.setPickProgram(prog));
    } catch (e) { console.error(e); }
  }, PICK_PROG_IDLE_MS);
}

function rebuild() {
  sticky = null;
  scheduleMesh();          /* uniform 超過で早期 return しても メッシュ側は更新する */
  scheduleBlobMesh();      /* native blob は WASM 再メッシュ (GLSL に出ない) */
  refreshObjMeshes();      /* mesh(OBJ) も GLSL に出ない — ラスタ表示を同期 */
  schedulePickProg();      /* ピック用は手が止まってから裏で焼く */
  try {
    const prog = buildProgram(doc, null, progOpts());
    const need = countUniformVectors(prog.frag);
    const max = viewer.maxFragUniformVectors;
    if (max && need > max) {
      /* 焼くと link 失敗で真っ暗になるので焼かない (直前の正常なプレビューを残す) */
      sticky = { msg: uniformOverflowMsg(need, max), err: true };
      setStatus(sticky.msg, true);
      showCompiling(false);
      return;
    }
    layout = prog.layout;
    /* setProgram は非同期になりうる (KHR_parallel_shader_compile)。
       ①リンク失敗は例外でなく onError で来る ②完了時刻が後になるので status は
       onDone で確定させる。**暫定表示は呼び出しの前**に出すこと — キャッシュ命中時は
       onDone が同期で走るので、後に置くと確定表示を「コンパイル中…」で潰す。 */
    const info = (tail) => setStatus(`ノード ${layout.order.length}`
                                     + ` / パラメータ ${layout.parCount} / ${tail}`);
    info('コンパイル中…');
    showCompiling(true, `ノード ${layout.order.length}`);
    layoutPending = true;
    viewer.setProgram(
      prog.frag,
      (e) => { showCompiling(false); console.error(e); setStatus('シェーダエラー: ' + e.message, true); },
      () => {
        showCompiling(false);
        /* 新プログラムが有効になった今、対応するスロット配置で焼く。
           collectParams は最新 doc を読むのでリンク中の編集も反映される */
        layoutPending = false;
        viewer.setParams(collectParams(doc, layout));
        viewer.setObjSpheres(collectObjSpheres(doc));
        viewer.setPartColors(collectPartColors(layout));
        const mc = collectMatColors(doc, layout);
        viewer.setMatColors(mc.arr, mc.hasAny);
        viewer.setColors(prog.colors);
        updateSelUniform();
        info(`コンパイル ${viewer.compileMs.toFixed(0)}ms`);
      });
    ensureGrids();                 /* 取込グリッドの3Dテクスチャを用意 (非同期・初回のみ取得) */
    viewer.setLights(doc.lights);        /* 配置に依存しない uniform は即時でよい */
    viewer.setBackground(doc.background);
    /* ※ここで status を出し直さないこと: 非同期リンク中は viewer.compileMs が
       **前回のビルドの値**なので、古い数字で「コンパイル中…」を潰してしまう。
       確定表示は上の onDone が受け持つ。 */
  } catch (e) {
    showCompiling(false);
    console.error(e);
    setStatus('シェーダエラー: ' + e.message, true);
  }
}
function updateParams() {
  scheduleMesh();          /* ギズモドラッグ中もデバウンスで再メッシュ化 */
  scheduleDragMesh();      /* メッシュ表示中のドラッグ: 低gridで per-frame 追従 */
  syncBlobPair();          /* Pair: 選択 blob への編集差分を相手へ鏡映 */
  scheduleBlobMesh();      /* blob はドラッグ中も WASM 即時再メッシュ (level5) */
  refreshObjMeshes();      /* mesh(OBJ): 行列だけ焼き直し (GPU 転送なし) */
  updateBlobSelRing();     /* 選択枠 (blob リング / mesh bbox) を追従 */
  if (!layout || layoutPending) return;   /* リンク待ち中は上の onDone がまとめて焼く */
  viewer.setParams(collectParams(doc, layout));
  viewer.setObjSpheres(collectObjSpheres(doc));   /* パラメータ移動でも境界球を追従 */
}
function updateSelUniform() {
  if (layoutPending) return;   /* リンク待ち中は旧プログラムに新 index を撃たない */
  const idx = (layout && sel.nodeId != null && layout.indices.has(sel.nodeId))
    ? layout.indices.get(sel.nodeId) : -1;
  viewer.setSelection(idx);
}
/* uniform 上限まわりの常時表示メッセージ (正常時は null)。rebuild() が更新する。
   {err:true}=超過でプレビュー不可 / {err:false}=自動降格中の通知。 */
let sticky = null;
function setStatus(msg, isErr = false) {
  /* 超過/降格中は成功メッセージ (「読み込みました」等) でこれを消さない。プレビューが
     真っ暗/近似である理由を出し続ける方が優先。importText など rebuild の後に status を
     上書きする呼び出し側があるため (= 最も知らせたい読み込み直後に消えてしまう)。 */
  if (sticky && !isErr) { msg = sticky.msg; isErr = sticky.err; }
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}
let autosaveTimer = null;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, docToJSON(doc)); } catch {}
  }, 400);
}
function mutated(structural = true) {
  if (structural) { rebuild(); renderTree(); } else updateParams();
  autosave();
}

/* ── 空シーン用クイック追加オーバーレイ ───────────────────── */
/* 全プリミティブを「床の上に載る」初期配置で置く */
const QUICK_PROPS = {
  'sphere':         { center: [0, 0.6, 0], radius: 0.6 },
  'box':            { center: [0, 0.5, 0], size: [0.5, 0.5, 0.5] },
  'ellipsoid':      { center: [0, 0.55, 0], radii: [0.75, 0.5, 0.55] },
  'torus':          { center: [0, 0.6, 0], major: 0.6, minor: 0.2 },
  'torus-ellipse':  { center: [0, 0.6, 0], radii: [0.7, 0.45], minor: 0.15 },
  'capsule':        { a: [0, 0.35, 0], b: [0, 1.3, 0], radius: 0.32 },
  'cylinder':       { center: [0, 0.6, 0], radius: 0.45, height: 0.6 },
  'cylinder-ab':    { a: [0, 0.3, 0], b: [0, 1.3, 0], radius: 0.35 },
  'round-cone':     { center: [0, 0.2, 0], r1: 0.5, r2: 0.2, height: 1 },
  'round-cone-ab':  { a: [0, 0.4, 0], b: [0, 1.3, 0], r1: 0.4, r2: 0.15 },
  'capped-cone':    { center: [0, 0.6, 0], height: 0.5, r1: 0.5, r2: 0.25 },
  'capped-cone-ab': { a: [0, 0.3, 0], b: [0, 1.3, 0], r1: 0.5, r2: 0.25 },
  'cone':           { center: [0, 1.1, 0], angle: 25, height: 1 },
  'octahedron':     { center: [0, 0.7, 0], size: 0.7 },
  'box-frame':      { center: [0, 0.6, 0], size: [0.5, 0.5, 0.5], thick: 0.06 },
  'sweep':          { points: [0, 0.2, 0,  0.45, 0.7, 0.3,  0, 1.4, 0], radii: [0.2, 0.15, 0.09], curve: 1, steps: 12, closed: 0 },
  'extrude':        { center: [0, 0, 0], depth: 0.1, thick: 0, steps: 8, curve: 0,
                      prof: [[-0.3, -0.22], [0.3, -0.22], [0.3, 0.22], [-0.3, 0.22]] },
  'lathe':          { center: [0, 0, 0], axis: 0, thick: 0, steps: 16, curve: 1,
                      prof: [[0, 0], [0.42, 0], [0.42, 0.07], [0.1, 0.14], [0.09, 0.55], [0.4, 0.62], [0.46, 1.05], [0, 1.1]] },
  'plane':          { center: [0, 0, 0] },
  'blob':           { center: [0, 0.6, 0], scale: [0.6, 0.6, 0.6] },
};
function countLeaves(n) {
  const sc = SCHEMA[n.type];
  return (sc && sc.kind === 'leaf' ? 1 : 0) + n.children.reduce((s, c) => s + countLeaves(c), 0);
}
function updateQuickAdd() {
  const empty = doc.objects.every(o => countLeaves(o.root) === 0);
  $('#quickadd').hidden = !empty;
}
function initQuickAdd() {
  const box = $('#quickadd .qa-btns');
  for (const type of PRIM_TYPES) {
    const props = QUICK_PROPS[type] || {};
    box.appendChild(button(SCHEMA[type].label, () => {
      snapshot();
      const obj = selectedObj() || doc.objects[0];
      const nn = makeNode(type, props);
      const sc = SCHEMA[obj.root.type];
      if (sc.kind === 'op' && (!sc.maxChildren || obj.root.children.length < sc.maxChildren)) {
        obj.root.children.push(nn);
      } else {
        obj.root = makeNode('smooth-union', { k: 0.15 }, [obj.root, nn]);
      }
      sel = { objIdx: doc.objects.indexOf(obj), nodeId: nn.id };
      mutated();
      renderInspector();
      updateSelUniform();
    }));
  }
}

/* ── ツリーパネル ─────────────────────────────────────────── */
const TYPE_ICON = {
  leaf: '●', op: '⊕', xform: '↳',
};
function nodeLabel(n) {
  const sc = SCHEMA[n.type];
  let extra = '';
  if (n.type === 'smooth-union' || n.type === 'smooth-intersect' || n.type === 'smooth-subtract') {
    extra = ` k=${fmt(n.props.k)}`;
    if (n.props.mode && n.props.mode !== 'poly') extra += ` ${n.props.mode}`;   /* ブレンド種別 */
  }
  if (n.type === 'translate') extra = ` (${n.props.t.map(fmt).join(' ')})`;
  if (n.type === 'rotate') extra = ` (${n.props.deg.map(v => fmt(Math.round(v * 10) / 10)).join(' ')})°`;
  if (n.type === 'repeat') extra = ` ×${Math.max(1, Math.round(n.props.count))}`;
  if (n.type === 'repeat3') { const c = n.props.count || [2,2,2];
    extra = ` ${Math.round(c[0])}×${Math.round(c[1])}×${Math.round(c[2])}`; }
  if (n.type === 'round') extra = ` r=${fmt(n.props.r)}`;
  if (n.type === 'onion') extra = ` t=${fmt(n.props.t)}`;
  if (n.type === 'twist' || n.type === 'bend') extra = ` ${fmt(Math.round(n.props.rate * 10) / 10)}°/u`;
  return (n.name ? n.name + ' — ' : '') + (sc ? sc.label : n.type) + extra;
}
function renderTree() {
  const box = $('#tree');
  box.innerHTML = '';
  doc.objects.forEach((obj, oi) => {
    const hdr = document.createElement('div');
    hdr.className = 'obj-row' + (sel.objIdx === oi && sel.nodeId == null ? ' sel' : '');
    const eye = document.createElement('span');
    eye.className = 'eye';
    /* ⚠ ここを絵文字にしないこと (2026-08-24)。👁 (U+1F441) は macOS の
       絵文字フォントへフォールバックし、**行を作り直すたびのレイアウトが
       1行あたり約1.9ms** になる。ツリー73行のシーンでクリック→編集可能まで
       146ms のうち 140ms がこれだった (ASCII/記号なら 0.4ms)。
       詳細: docs/2026-08-24_sdfmodeler_ツリーの絵文字がクリック応答を支配していた.md */
    eye.textContent = obj.visible ? '◉' : '–';
    eye.title = '表示/非表示';
    eye.onclick = e => { e.stopPropagation(); snapshot(); obj.visible = !obj.visible; mutated(); };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    const c = surfaceColor(obj.surface);
    sw.style.background = `rgb(${c.map(v => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255)).join(',')})`;
    const nm = document.createElement('span');
    nm.textContent = obj.name;
    hdr.append(eye, sw, nm);
    hdr.onclick = () => { sel = { objIdx: oi, nodeId: null }; onSelChange(); };
    hdr.draggable = true;                    /* オブジェクトごとドラッグ→別オブジェクトへ統合 */
    hdr.ondragstart = e => {
      dragSrc = { oi, obj: true };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', obj.name);
      hdr.classList.add('dragging');
    };
    hdr.ondragend = () => { dragSrc = null; renderTree(); };
    wireDropTarget(hdr, oi, null);           /* オブジェクト行へドロップ=ルート直下末尾 */
    box.appendChild(hdr);
    renderNodeRow(box, obj.root, oi, 1);
  });
  const addObj = document.createElement('div');
  addObj.className = 'add-obj';
  addObj.textContent = '＋ オブジェクト追加';
  addObj.onclick = () => {
    snapshot();
    doc.objects.push({
      name: 'obj' + (doc.objects.length + 1), visible: true,
      surface: '(surface (color 0.7 0.6 0.5)(ka 0.22)(kd 0.8)(ks 0.35)(phong 24))',
      root: makeNode('smooth-union', { k: 0.15 }),
    });
    sel = { objIdx: doc.objects.length - 1, nodeId: null };
    mutated();
    renderInspector();
  };
  box.appendChild(addObj);
  updateQuickAdd();
}
/* 材質色 (mcolor): 未設定は親から継承、既定はオブジェクトの surface 色 */
function effectiveMColor(obj, node) {
  let eff = surfaceColor(obj.surface);
  const walk = (n, cur) => {
    const c = n.props.mcolor || cur;
    if (n === node) { eff = c; return true; }
    return n.children.some(ch => walk(ch, c));
  };
  walk(obj.root, eff);
  return eff;
}
function refreshMatColors() {
  scheduleBlobMesh();   /* blob の材質色は WASM 頂点色 → 再メッシュで反映 */
  scheduleMesh();       /* メッシュ表示の SDF も頂点色に焼き込み — 呼ばないと
                           色ピックが「移動するまで反映されない」(mcolor 込みの
                           テキストハッシュが変わるので変更 object だけ再ベイク。
                           SDF レイマーチ表示では meshWanted()=false で no-op) */
  if (!layout) return;
  const mc = collectMatColors(doc, layout);
  viewer.setMatColors(mc.arr, mc.hasAny);
}
function rgbHex(c) {
  return '#' + c.map(v => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}
function hexRgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); }

/* 色クリップボード (スポイト/ペースト)。リロード後も使えるよう localStorage に保持 */
let colorClipboard = null;
try { colorClipboard = JSON.parse(localStorage.getItem('sdfmodeler.colorclip')) || null; } catch {}

/* パーツ識別色 (自動割当専用。旧 .json の props.partColor は読み飛ばす。
   手動で色を付けたいときは材質色「色」を使う) */
function partColorCss(node, idx) {
  const c = autoPartColor(idx);
  return `rgb(${c.map(v => Math.round(255 * Math.min(1, Math.max(0, v)))).join(',')})`;
}
function renderNodeRow(box, n, oi, depth, dimmed = false) {
  const row = document.createElement('div');
  const sc = SCHEMA[n.type] || { kind: 'leaf' };
  const off = !!n.hidden;
  row.className = 'node-row k-' + sc.kind
    + (sel.objIdx === oi && sel.nodeId === n.id ? ' sel' : '')
    + (off || dimmed ? ' off' : '');
  row.style.paddingLeft = (depth * 14 + 6) + 'px';
  /* ノード単位の表示トグル (2026-07-27)。重いパーツ (例: 撚り紐 sweep) を
     **レイマーチ表示だけ**から外すための view 状態 — オブジェクト行の◉と同じ規約で、
     .ssq 書き出し / メッシュ化 / 🎬sqm レンダには含まれたまま。
     サブツリーごとシェーダから消えるので、コンパイルも毎フレームも軽くなる。 */
  const eye = document.createElement('span');
  eye.className = 'eye';
  eye.textContent = off ? '–' : '◉';   /* ⚠ 絵文字にしない (上の obj-row の注記参照) */
  eye.title = 'レイマーチ表示から除外/復帰 (書き出し・メッシュ・sqmレンダには含まれる)';
  eye.onclick = e => { e.stopPropagation(); snapshot(); n.hidden = !n.hidden; mutated(); };
  const icon = document.createElement('span');
  icon.textContent = TYPE_ICON[sc.kind];
  if (partColorOn && sc.kind === 'leaf' && n.type !== 'raw' && layout && layout.indices.has(n.id))
    icon.style.color = partColorCss(n, layout.indices.get(n.id));
  row.append(eye, icon, ' ' + nodeLabel(n));
  if (n.props.mcolor) {                      /* 材質色チップ (継承の起点) */
    const chip = document.createElement('span');
    chip.className = 'mchip';
    chip.style.background = rgbHex(n.props.mcolor);
    chip.title = '材質色 (子へ継承)';
    row.appendChild(chip);
  }
  row.onclick = () => { sel = { objIdx: oi, nodeId: n.id }; onSelChange(); };
  if (n !== doc.objects[oi].root) {          /* ルート以外はドラッグ可 */
    row.draggable = true;
    row.ondragstart = e => {
      dragSrc = { oi, nodeId: n.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', nodeLabel(n));  /* Firefox は setData 必須 */
      row.classList.add('dragging');
    };
    row.ondragend = () => { dragSrc = null; renderTree(); };
  }
  wireDropTarget(row, oi, n);
  box.appendChild(row);
  n.children.forEach(c => renderNodeRow(box, c, oi, depth + 1, off || dimmed));
}
function onSelChange() {
  renderTree();
  renderInspector();
  updateSelUniform();
  updateBlobSelRing();
  const row = $('#tree .sel');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/* ── ドラッグ数値入力 ─────────────────────────────────────── */
function numInput(value, onChange, { step = 0.01 } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'num';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = fmt(value);
  let startX = 0, startV = 0, dragging = false, snapped = false;
  const commit = v => { onChange(v); };
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) { snapshot(); commit(v); }
    inp.value = fmt(isNaN(v) ? value : v);
    autosave();
  });
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.textContent = '↔';
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    dragging = true; snapped = false;
    startX = e.clientX;
    startV = parseFloat(inp.value) || 0;
  });
  grip.addEventListener('pointermove', e => {
    if (!dragging) return;
    if (!snapped) { snapshot(); snapped = true; }
    const scale = e.shiftKey ? 0.1 : 1;
    const v = startV + (e.clientX - startX) * step * scale;
    inp.value = fmt(v);
    commit(v);
  });
  grip.addEventListener('pointerup', () => { dragging = false; autosave(); });
  wrap.append(inp, grip);
  return wrap;
}

/* ── sweep 専用エディタ ───────────────────────────────────────
   経路点 (x,y,z,r) の行編集。座標/半径の変更は uniform 更新のみ (mutated(false))、
   点の追加/削除・種類・分割・ループはスロット数が変わる = 構造変更 (mutated()) */
function renderSweepFields(box, node) {
  const p = node.props;
  const n = Math.floor(p.points.length / 3);

  const row = fieldRow('種類');
  const selEl = document.createElement('select');
  [['折れ線', 0], ['スプライン', 1], ['Bスプライン', 2]].forEach(([lb, v]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = lb;
    if ((p.curve ?? 0) === v) o.selected = true;
    selEl.appendChild(o);
  });
  selEl.onchange = () => { snapshot(); p.curve = +selEl.value; mutated(); renderInspector(); };
  row.appendChild(selEl);
  box.appendChild(row);

  const crow = fieldRow('ループ');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!p.closed;
  cb.title = '端を結ぶ閉ループ (リング)';
  cb.onchange = () => { snapshot(); p.closed = cb.checked ? 1 : 0; mutated(); };
  crow.appendChild(cb);
  box.appendChild(crow);

  /* ── 断面 (任意断面 Phase 2)。プロファイルエディタ (別タブ) と BroadcastChannel 連携 ── */
  const hasProf = p.profile && p.profile.length >= 3;
  const prow = fieldRow('断面');
  const stateLbl = document.createElement('span');
  stateLbl.className = 'flabel';
  stateLbl.style.width = 'auto';
  stateLbl.textContent = hasProf ? `多角形 ${p.profile.length}点` : '円形';
  prow.appendChild(stateLbl);
  prow.appendChild(button('✎ 断面を編集', () => openProfileEditor(node)));
  if (hasProf) prow.appendChild(button('円形に戻す', () => {
    snapshot(); p.profile = []; p.twist = 0; mutated(); renderInspector();
  }));
  box.appendChild(prow);
  if (hasProf) {
    const trow = fieldRow('ねじり°');
    trow.appendChild(numInput(p.twist, v => { p.twist = v; mutated(); }, { step: 5 }));
    box.appendChild(trow);
  }

  if (p.curve) {
    const srow = fieldRow('分割');
    srow.appendChild(numInput(p.steps, v => {
      p.steps = Math.max(2, Math.round(v));
      mutated();                        /* 密化点数が変わる */
    }, { step: 1 }));
    box.appendChild(srow);
  }

  for (let i = 0; i < n; i++) {
    const prow = fieldRow(`点${i + 1} xyz r`);
    for (let c = 0; c < 3; c++) {
      prow.appendChild(numInput(p.points[3 * i + c], v => {
        p.points[3 * i + c] = v; mutated(false);
      }, { step: 0.02 }));
    }
    prow.appendChild(numInput(p.radii[i], v => {
      p.radii[i] = Math.max(0.001, v); mutated(false);
    }, { step: 0.01 }));
    if (i < n - 1 || p.closed) {   /* 次の点との中間に挿入 (closed は末尾→先頭間も可) */
      const j = (i + 1) % n;
      const ins = button('◇', () => {
        snapshot();
        const mid = [0, 1, 2].map(c => (p.points[3 * i + c] + p.points[3 * j + c]) / 2);
        p.points.splice(3 * (i + 1), 0, ...mid);
        p.radii.splice(i + 1, 0, (p.radii[i] + p.radii[j]) / 2);
        mutated(); renderInspector();
      });
      ins.title = '次の点との中間に挿入';
      prow.appendChild(ins);
    }
    if (n > 2) {
      const del = button('✕', () => {
        snapshot();
        p.points.splice(3 * i, 3);
        p.radii.splice(i, 1);
        mutated(); renderInspector();
      });
      del.title = 'この点を削除';
      prow.appendChild(del);
    }
    box.appendChild(prow);
  }
  const arow = document.createElement('div');
  arow.className = 'btnrow';
  arow.appendChild(button('＋ 点を追加', () => {
    snapshot();
    /* 終点の1個先へ外挿 */
    const q = p.points, m = q.length;
    const last = q.slice(m - 3);
    const prev = m >= 6 ? q.slice(m - 6, m - 3) : [last[0], last[1] - 0.4, last[2]];
    p.points.push(2 * last[0] - prev[0], 2 * last[1] - prev[1], 2 * last[2] - prev[2]);
    p.radii.push(p.radii[p.radii.length - 1] ?? 0.15);
    mutated(); renderInspector();
  }));
  box.appendChild(arow);
}

/* ── 回転体 (lathe) 専用エディタ ──────────────────────────────
   中心/軸オフセット/厚み。輪郭 (r,y) は別タブのプロファイルエディタ (latheモード) で編集。 */
function renderLatheFields(box, node) {
  const p = node.props;
  const numRow = (label, get, set, step) => {
    const row = fieldRow(label);
    row.appendChild(numInput(get(), v => { set(v); mutated(); }, { step }));
    box.appendChild(row);
  };
  numRow('軸半径', () => p.axis, v => p.axis = v, 0.02);       /* 回転半径オフセット (リング用) */
  numRow('厚み', () => p.thick, v => p.thick = Math.max(0, v), 0.01);  /* >0 で開シェル (ボウル/笠) */
  const srow = fieldRow('種類');
  const selEl = document.createElement('select');
  [['折れ線', 0], ['スプライン', 1], ['Bスプライン', 2]].forEach(([lb, v]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = lb;
    if ((p.curve ?? 0) === v) o.selected = true; selEl.appendChild(o);
  });
  selEl.onchange = () => { snapshot(); p.curve = +selEl.value; mutated(); };
  srow.appendChild(selEl);
  box.appendChild(srow);
  if (p.curve) numRow('分割', () => p.steps, v => p.steps = Math.max(2, Math.round(v)), 1);

  const prow = fieldRow('輪郭');
  const lbl = document.createElement('span');
  lbl.className = 'flabel'; lbl.style.width = 'auto';
  lbl.textContent = `${p.prof.length}点 (${p.thick > 0 ? '開シェル' : 'ソリッド'})`;
  prow.appendChild(lbl);
  prow.appendChild(button('✎ 輪郭を編集', () => openProfileEditor(node)));
  box.appendChild(prow);
}

/* ── 押し出し (extrude) 専用エディタ ──────────────────────────
   半厚/厚み。輪郭 (x,y) は別タブのプロファイルエディタ (extrudeモード) で編集。
   ※ depth は **半厚** (エンジンの (depth h) と同じで z は ±h)。全長ではない。 */
/* blob 専用フィールド: Pair (対称配置の鏡映同時編集, ssq_edit 移植) */
/* mesh(OBJ) ノード専用フィールド: file (編集可) と三角形数/状態の表示。
   頂点編集は不可 — transform (center/scale/rot は上の汎用フィールド) だけ */
function renderMeshFields(box, node) {
  const row = fieldRow('file');
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = node.props.file;
  inp.style.width = '100%';
  inp.addEventListener('change', () => {
    const f = inp.value.trim();
    if (!f || f === node.props.file) return;
    snapshot();
    objCacheDrop(node.props.file);
    node.props.file = f;
    refreshObjMeshes();
    updateBlobSelRing();
    autosave();
    renderInspector();
  });
  row.appendChild(inp);
  box.appendChild(row);
  const st = objCacheGet(node.props.file);
  const info = fieldRow('情報');
  const span = document.createElement('span');
  span.style.opacity = '0.75';
  span.textContent = !st ? '未読込'
    : st.status === 'loading' ? '読み込み中…'
    : st.status === 'err' ? ('読めない: ' + st.error)
    : `${st.mesh.nTris.toLocaleString()} tris / ${(st.mesh.verts.length / 3).toLocaleString()} verts`;
  info.appendChild(span);
  box.appendChild(info);
  /* ── シェーディング (2026-08-25) ─────────────────────────────────────
     モデラーの表示と sqm のレンダーを一致させるための切り替え。
     エンジンが表現できるのはこの2状態だけ (「フラット強制」のキーは無い):
       (smooth ..) 無し → OBJ に vn があればそれ、無ければ面法線 = フラット
       (smooth 1)       → obj_compute_smooth_normals (クリース 60°) */
  {
    const srow = fieldRow('シェーディング');
    const sel = document.createElement('select');
    [['フラット / vn まかせ', 0], ['スムーズ (smooth 1)', 1]].forEach(([lb, v]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = lb;
      if ((node.props.smooth ? 1 : 0) === v) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      const v = +sel.value ? 1 : 0;
      if (v === (node.props.smooth ? 1 : 0)) return;
      snapshot();
      node.props.smooth = v;
      refreshObjMeshes();
      updateBlobSelRing();
      autosave();
      renderInspector();
    });
    srow.appendChild(sel);
    box.appendChild(srow);

    /* sqm 側が実際に何をするかを明示する (ここが食い違いの発生源だったので) */
    const hint = fieldRow('sqm');
    const hs = document.createElement('span');
    hs.style.opacity = '0.7';
    hs.style.fontSize = '11px';
    const hasVN = st && st.status === 'ok' && st.mesh.hasVN;
    hs.textContent = node.props.smooth
      ? '(smooth 1) — 位置で溶接しクリース60°で平滑化'
      : (hasVN ? 'OBJ の vn をそのまま使用 (この OBJ は vn を持つ)'
               : '面法線 = フラット (この OBJ は vn を持たない)');
    hint.appendChild(hs);
    box.appendChild(hint);
  }
  if (node.props.extra && node.props.extra.length) {
    const ex = fieldRow('保全');
    const s2 = document.createElement('span');
    s2.style.opacity = '0.6';
    s2.style.fontSize = '11px';
    s2.textContent = node.props.extra.join(' ');
    ex.appendChild(s2);
    box.appendChild(ex);
  }
}

function renderBlobFields(box, node) {
  const row = fieldRow('Pair');
  if (pairArm === node.id) {
    row.appendChild(button('相手の blob をクリック… (キャンセル)', () => {
      pairArm = null; renderInspector();
    }));
  } else if (blobPair && (blobPair.selId === node.id || blobPair.partnerId === node.id)) {
    const other = blobPair.selId === node.id ? blobPair.partnerId : blobPair.selId;
    const lbl = document.createElement('span');
    lbl.textContent = `鏡映軸 ${'XYZ'[blobPair.axis]} `;
    lbl.style.marginRight = '6px';
    row.appendChild(lbl);
    row.appendChild(button('解除', () => { blobPair = null; renderInspector(); }));
    if (blobPair.partnerId === node.id) {
      row.appendChild(button('この blob を編集側に', () => {
        blobPair = { selId: node.id, partnerId: other,
                     axis: blobPair.axis, ref: blobPropsCopy(node.props) };
        renderInspector();
      }));
    }
  } else {
    row.appendChild(button('◇ 相手を選ぶ', () => {
      pairArm = node.id;
      setStatus('Pair: 鏡映で同期する相手の blob をクリックしてください');
      renderInspector();
    }));
  }
  box.appendChild(row);
}

function renderExtrudeFields(box, node) {
  const p = node.props;
  const numRow = (label, get, set, step) => {
    const row = fieldRow(label);
    row.appendChild(numInput(get(), v => { set(v); mutated(); }, { step }));
    box.appendChild(row);
  };
  numRow('半厚 z', () => p.depth, v => p.depth = Math.max(1e-4, v), 0.01);
  numRow('厚み', () => p.thick, v => p.thick = Math.max(0, v), 0.01);   /* >0 で開シェル (枠) */
  const srow = fieldRow('種類');
  const selEl = document.createElement('select');
  [['折れ線', 0], ['スプライン', 1], ['Bスプライン', 2]].forEach(([lb, v]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = lb;
    if ((p.curve ?? 0) === v) o.selected = true; selEl.appendChild(o);
  });
  selEl.onchange = () => { snapshot(); p.curve = +selEl.value; mutated(); };
  srow.appendChild(selEl);
  box.appendChild(srow);
  if (p.curve) numRow('分割', () => p.steps, v => p.steps = Math.max(2, Math.round(v)), 1);

  const prow = fieldRow('輪郭');
  const lbl = document.createElement('span');
  lbl.className = 'flabel'; lbl.style.width = 'auto';
  lbl.textContent = `${p.prof.length}点 (${p.thick > 0 ? '開シェル' : 'ソリッド'})`;
  prow.appendChild(lbl);
  prow.appendChild(button('✎ 輪郭を編集', () => openProfileEditor(node)));
  box.appendChild(prow);
}

/* ── プロファイルエディタ (profile.html, 別タブ) 連携 ────────────
   同一オリジンで window.open → hash で現在の断面を渡す。編集結果は BroadcastChannel
   'sqm-profile' で node.id をキーに受信して該当 sweep の profile を更新する。 */
const profileBC = ('BroadcastChannel' in window) ? new BroadcastChannel('sqm-profile') : null;
/* レンダ設定タブ (render.html) 連携: 別タブから 'scene-request' が来たら現在のシーンを .ssq で返す */
const renderBC = ('BroadcastChannel' in window) ? new BroadcastChannel('sqm-render') : null;
if (renderBC) renderBC.onmessage = ev => {
  const m = ev.data;
  if (!m || m.type !== 'scene-request') return;
  doc.camera = viewer.getCamera();
  renderBC.postMessage({ type: 'scene', reqId: m.reqId, ssq: serializeScene(doc, doc.camera) });
};
function openRenderTab() {
  const w = window.open('render.html', 'sqm-render-settings');
  if (!w) { setStatus('ポップアップがブロックされました。許可してください', true); return; }
  setStatus('レンダリング設定タブを開きました (パラメータ設定→「レンダリング開始」)');
}
let profileWin = null;
/* node.type に応じて editor mode/現在の点列を渡して開く (sweep=断面 / lathe=輪郭) */
function openProfileEditor(node) {
  const p = node.props;
  const q = new URLSearchParams();
  q.set('id', node.id);
  if (node.type === 'lathe' || node.type === 'extrude') {
    q.set('mode', node.type);
    q.set('curve', String(p.curve || 0));
    if (node.type === 'extrude') q.set('closed', '1');   /* 閉輪郭 */
    if (p.prof && p.prof.length >= 2) q.set('pts', p.prof.flatMap(uv => uv).join(','));
  } else {
    q.set('mode', 'sweep');
    q.set('curve', String(p.profileCurve || 0));
    q.set('closed', '1');
    if (p.profile && p.profile.length >= 3) q.set('pts', p.profile.flatMap(uv => uv).join(','));
  }
  profileWin = window.open('profile.html#' + q.toString(), 'sqm-profile-editor');
  if (!profileWin) { setStatus('ポップアップがブロックされました。許可してください', true); return; }
  setStatus('プロファイルエディタを開きました (別タブで編集→「sdfmodeler へ適用」)');
}
if (profileBC) profileBC.onmessage = ev => {
  const m = ev.data;
  if (!m || m.type !== 'profile') return;
  if (m.mode === 'lathe') return applyLatheProfile(m);
  if (m.mode === 'extrude') return applyExtrudeProfile(m);
  /* ── sweep 断面 ── id で対象を探す。無ければ選択中 sweep へフォールバック ── */
  let loc = m.id ? findNodeAnywhere(m.id) : null;
  if (!loc || loc.node.type !== 'sweep') {
    const s = selectedNode();
    if (s && s.type === 'sweep') loc = { node: s, objIdx: sel.objIdx };
    else {
      setStatus('断面の適用先がありません — 掃引チューブを選択するか「✎ 断面を編集」から開いてください', true);
      profileBC.postMessage({ type: 'profile-ack', ok: false, id: m.id,
        msg: '適用先の掃引チューブがありません (ノードを選択してください)' });
      return;
    }
  }
  snapshot();
  const p = loc.node.props;
  const hadProfile = p.profile && p.profile.length >= 3;
  p.profile = (m.points || []).map(uv => uv.slice());
  p.profileCurve = m.curve || 0;
  if (p.profile.length < 3) { p.profile = []; }
  else if (!hadProfile) {   /* 円形→断面: radii(半径)をスケール1へ初期化 */
    p.radii = p.radii.map(() => 1);
  }
  sel = { objIdx: loc.objIdx, nodeId: loc.node.id };
  mutated();
  renderTree();
  renderInspector();
  setStatus(`断面を更新: ${p.profile.length ? p.profile.length + '点 (ドラッグ中は近似チューブ+ボーンに簡略化)' : '円形'}`);
  profileBC.postMessage({ type: 'profile-ack', ok: true, id: loc.node.id,
    msg: p.profile.length ? p.profile.length + '点' : '円形' });
};
/* extrude 輪郭の適用: id で extrude を探し、無ければ選択中 extrude、それも無ければ
   「輪郭から押し出しパーツを新規追加」。閉輪郭なので3点以上を要求する。 */
function applyExtrudeProfile(m) {
  const pts = (m.points || []).filter(uv => Array.isArray(uv)).map(uv => uv.slice());
  if (pts.length < 3) {
    setStatus('押し出し: 閉輪郭は3点以上必要です', true);
    profileBC.postMessage({ type: 'profile-ack', ok: false, id: m.id, msg: '輪郭が不足' });
    return;
  }
  snapshot();
  let loc = m.id ? findNodeAnywhere(m.id) : null;
  if (!loc || loc.node.type !== 'extrude') {
    const s2 = selectedNode();
    if (s2 && s2.type === 'extrude') loc = { node: s2, objIdx: sel.objIdx };
  }
  let created = false;
  if (!loc) {
    const obj = selectedObj() || doc.objects[0];
    if (!obj) { setStatus('押し出しの追加先オブジェクトがありません', true); return; }
    const nn = makeNode('extrude', { prof: pts, curve: m.curve || 0 });
    const sc = SCHEMA[obj.root.type];
    if (sc.kind === 'op' && (!sc.maxChildren || obj.root.children.length < sc.maxChildren)) obj.root.children.push(nn);
    else obj.root = makeNode('smooth-union', { k: 0.05 }, [obj.root, nn]);
    loc = { node: nn, objIdx: doc.objects.indexOf(obj) };
    created = true;
  } else {
    loc.node.props.prof = pts;
    loc.node.props.curve = m.curve || 0;
  }
  sel = { objIdx: loc.objIdx, nodeId: loc.node.id };
  mutated();
  renderTree();
  renderInspector();
  setStatus(`押し出し輪郭を${created ? '新規追加' : '更新'}: ${pts.length}点`);
  profileBC.postMessage({ type: 'profile-ack', ok: true, id: loc.node.id,
    msg: `${pts.length}点${created ? ' (新規パーツ)' : ''}` });
}

/* lathe 輪郭の適用: id で lathe を探し、無ければ選択中 lathe、それも無ければ
   「線から回転体パーツを新規追加」(現オブジェクトのルートに smooth-union で足す) */
function applyLatheProfile(m) {
  const pts = (m.points || []).filter(uv => Array.isArray(uv)).map(uv => uv.slice());
  if (pts.length < 2) {
    setStatus('回転体: 輪郭は2点以上必要です', true);
    profileBC.postMessage({ type: 'profile-ack', ok: false, id: m.id, msg: '輪郭が不足' });
    return;
  }
  snapshot();
  let loc = m.id ? findNodeAnywhere(m.id) : null;
  if (!loc || loc.node.type !== 'lathe') {
    const s = selectedNode();
    if (s && s.type === 'lathe') loc = { node: s, objIdx: sel.objIdx };
  }
  let created = false;
  if (!loc) {   /* 新規回転体パーツを追加 */
    const obj = selectedObj() || doc.objects[0];
    if (!obj) { setStatus('回転体の追加先オブジェクトがありません', true); return; }
    const nn = makeNode('lathe', { prof: pts, curve: m.curve || 0 });
    const sc = SCHEMA[obj.root.type];
    if (sc.kind === 'op' && (!sc.maxChildren || obj.root.children.length < sc.maxChildren)) obj.root.children.push(nn);
    else obj.root = makeNode('smooth-union', { k: 0.05 }, [obj.root, nn]);
    loc = { node: nn, objIdx: doc.objects.indexOf(obj) };
    created = true;
  } else {
    loc.node.props.prof = pts;
    loc.node.props.curve = m.curve || 0;
  }
  sel = { objIdx: loc.objIdx, nodeId: loc.node.id };
  mutated();
  renderTree();
  renderInspector();
  updateSelUniform();
  setStatus(`回転体を${created ? '追加' : '更新'}: 輪郭${pts.length}点`);
  profileBC.postMessage({ type: 'profile-ack', ok: true, id: loc.node.id,
    msg: (created ? '新規回転体 ' : '') + pts.length + '点' });
}
/* 全オブジェクト横断でノードIDを探す */
function findNodeAnywhere(id) {
  for (let oi = 0; oi < doc.objects.length; oi++) {
    const r = findNode(doc.objects[oi].root, id);
    if (r) return { node: r.node, objIdx: oi };
  }
  return null;
}

/* ── インスペクタ ─────────────────────────────────────────── */
function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  const node = selectedNode();
  if (!node) { renderObjectInspector(box); return; }
  const obj = selectedObj();
  const sc = SCHEMA[node.type];

  const title = document.createElement('h3');
  title.textContent = sc.label + ` (${node.type})`;
  box.appendChild(title);

  /* 名前 */
  const nameRow = fieldRow('名前');
  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.value = node.name || '';
  nameInp.placeholder = '(JSON保存のみ)';
  nameInp.onchange = () => { node.name = nameInp.value; renderTree(); autosave(); };
  nameRow.appendChild(nameInp);
  box.appendChild(nameRow);

  /* パラメータ */
  for (const f of sc.fields) {
    const row = fieldRow(f.label);
    if (f.type === 'vec3' || f.type === 'vec2') {
      for (let i = 0, n = f.type === 'vec2' ? 2 : 3; i < n; i++) {
        row.appendChild(numInput(node.props[f.key][i], v => {
          node.props[f.key][i] = v;
          mutated(false);
          if (node.type === 'translate' || node.type === 'rotate') renderTreeLabelOnly();
        }, { step: f.key === 'deg' ? 1 : 0.02 }));
      }
    } else {
      row.appendChild(numInput(node.props[f.key], v => {
        node.props[f.key] = v;
        mutated(false);
        if (f.key === 'count') renderTreeLabelOnly();   /* 反復 ×n ラベル */
      }, { step: f.key === 'angle' ? 0.5 : f.key === 'count' ? 1 : 0.01 }));
    }
    box.appendChild(row);
  }
  if (node.type === 'sweep') renderSweepFields(box, node);
  if (node.type === 'lathe') renderLatheFields(box, node);
  if (node.type === 'extrude') renderExtrudeFields(box, node);
  if (node.type === 'blob') renderBlobFields(box, node);
  if (node.type === 'mesh') renderMeshFields(box, node);
  /* 材質色 (実レンダ色)。未設定=親から継承 (既定=オブジェクト色)。
     .ssq 書き出しは色ごとにオブジェクト分割 (subtract/intersect/blend 内は分割不可)。
     mesh(OBJ) は対象外 — 表示は object surface 色で、mesh 行には色の載せ場が無い
     (色を変えたのにレンダーに出ない、を作らない) */
  if (node.type !== 'raw' && node.type !== 'mesh') {
    const row = fieldRow('色');
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.title = node.props.mcolor ? '材質色 (子へ継承)' : '継承中 (クリックで独自色を設定)';
    inp.value = rgbHex(node.props.mcolor || effectiveMColor(obj, node));
    inp.oninput = () => {
      node.props.mcolor = hexRgb(inp.value);
      refreshMatColors(); renderTree(); autosave();
    };
    inp.onchange = () => renderInspector();
    row.appendChild(inp);
    if (node.props.mcolor) {
      row.appendChild(button('継承に戻す', () => {
        delete node.props.mcolor;
        refreshMatColors(); renderTree(); renderInspector(); autosave();
      }));
    }
    /* スポイト: このパーツの見えている色 (継承解決後) をクリップボードへ */
    const cpy = button('💉', () => {
      colorClipboard = (node.props.mcolor || effectiveMColor(obj, node)).slice();
      try { localStorage.setItem('sdfmodeler.colorclip', JSON.stringify(colorClipboard)); } catch {}
      setStatus('色をコピーしました: ' + rgbHex(colorClipboard));
      renderInspector();
    });
    cpy.title = 'スポイト: このパーツの色をコピー';
    row.appendChild(cpy);
    /* ペースト: コピー済みの色を材質色として適用 (ボタンにスウォッチ表示) */
    if (colorClipboard) {
      const pst = button('', () => {
        node.props.mcolor = colorClipboard.slice();
        refreshMatColors(); renderTree(); renderInspector(); autosave();
      });
      pst.innerHTML = `<span class="mchip" style="background:${rgbHex(colorClipboard)};margin:0 5px 0 0"></span>ペースト`;
      pst.title = 'コピーした色を適用: ' + rgbHex(colorClipboard);
      row.appendChild(pst);
    }
    box.appendChild(row);
  }

  /* 識別色 (色分けモード) は自動割当専用に純化 — 手動上書きは材質色「色」で行う */

  if (node.type === 'raw') {
    const ta = document.createElement('textarea');
    ta.value = node.props.text;
    ta.rows = 4;
    ta.onchange = () => { snapshot(); node.props.text = ta.value; mutated(); };
    box.appendChild(ta);
  }

  box.appendChild(document.createElement('hr'));

  /* 操作ボタン群 */
  const r = findNode(obj.root, node.id);
  const parent = r ? r.parent : null;

  /* タイプ変更 (同種間: 位置/サイズ/子を引き継ぐ) */
  if (node.type !== 'raw' && node.type !== 'mesh') box.appendChild(typeMenu('⇄ タイプ変更', convertCandidates(node), t => {
    snapshot();
    convertNode(node, t);
    mutated();
    renderInspector();
  }));

  if (sc.kind !== 'xform' || true) {
    /* 子を追加 (op/xform で子数上限未満のとき) */
    const canChild = (sc.kind === 'op' && (!sc.maxChildren || node.children.length < sc.maxChildren))
                  || (sc.kind === 'xform' && node.children.length < 1);
    if (canChild) box.appendChild(typeMenu('＋ 子を追加', [...PRIM_TYPES, '—', ...OP_TYPES], t => {
      snapshot();
      /* 参照 = 既存の最後の子。隣に配置して埋まりを防ぐ */
      const ref = node.children[node.children.length - 1];
      const nn = defaultChildNode(t, ref);
      if (!ref && node === obj.root) {
        /* 空オブジェクトの最初のパーツ: 他オブジェクトの既存形と重ならないよう
           「前のオブジェクトの最後のリーフの隣」(ワールド座標=新規ルートのローカル) へ */
        for (let oi = doc.objects.length - 1; oi >= 0; oi--) {
          const po = doc.objects[oi];
          if (po === obj || !po.visible) continue;
          const pl = lastLeafNode(po.root);
          if (pl) { placeNodeAt(nn, worldAnchor(po.root, pl.id), nodeDim(pl)); break; }
        }
      }
      node.children.push(nn);
      sel.nodeId = nn.id;
      mutated();
      renderInspector();
    }));
  }
  /* 兄弟を追加 */
  box.appendChild(typeMenu('＋ 兄弟を追加', [...PRIM_TYPES, '—', ...OP_TYPES], t => {
    snapshot();
    const nn = defaultChildNode(t, node);   /* 選択ノードの隣に配置 */
    if (parent) parent.children.splice(parent.children.indexOf(node) + 1, 0, nn);
    else { /* root: union でラップ */
      obj.root = makeNode('union', {}, [node, nn]);
    }
    sel.nodeId = nn.id;
    mutated();
    renderInspector();
  }));
  /* ラップ */
  box.appendChild(typeMenu('◇ ラップ', WRAP_TYPES, t => {
    snapshot();
    const w = makeNode(t, {}, [node]);
    if (t === 'rotate') w.props.pivot = guessCenter(node);
    if (parent) parent.children.splice(parent.children.indexOf(node), 1, w);
    else obj.root = w;
    sel.nodeId = w.id;
    mutated();
    renderInspector();
  }));

  const btns = document.createElement('div');
  btns.className = 'btnrow';
  btns.appendChild(button('DUP', () => {
    snapshot();
    const c = cloneNode(node);
    if (parent) parent.children.splice(parent.children.indexOf(node) + 1, 0, c);
    else obj.root = makeNode('union', {}, [node, c]);
    sel.nodeId = c.id;
    mutated();
    renderInspector();
  }));
  if (node.children.length === 1) btns.appendChild(button('アンラップ', () => {
    snapshot();
    const c = node.children[0];
    if (parent) parent.children.splice(parent.children.indexOf(node), 1, c);
    else obj.root = c;
    sel.nodeId = c.id;
    mutated();
    renderInspector();
  }));
  if (parent) {
    btns.appendChild(button('▲', () => reorder(parent, node, -1)));
    btns.appendChild(button('▼', () => reorder(parent, node, +1)));
  }
  btns.appendChild(button('DEL', () => { deleteNode(obj, node); }, 'danger'));
  box.appendChild(btns);
}
/* ── タイプ変更: 位置/サイズ/子を引き継いで別ノード型に置換 ── */
function convertNode(node, newType) {
  const newSc = SCHEMA[newType];
  let p = node.props;
  /* sweep 発: 経路の両端点を a/b、最大半径を radius として汎用量推定に流す */
  if (node.type === 'sweep' && p.points && p.points.length >= 3) {
    const n = Math.floor(p.points.length / 3);
    p = { a: p.points.slice(0, 3), b: p.points.slice(3 * (n - 1), 3 * n),
          radius: Math.max(0.02, ...p.radii), mcolor: p.mcolor };
  }
  /* 旧ノードから汎用量 (中心・軸端点・半径・半高・サイズ) を推定 */
  let center = p.center ? p.center.slice() : null;
  let a = p.a ? p.a.slice() : null;
  let b = p.b ? p.b.slice() : null;
  if (!center && a && b) center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  if (!center) center = [0, 0, 0];
  let size = p.size ? p.size.slice() : (p.radii ? p.radii.slice() : null);
  let radius = p.radius ?? (size ? (size[0] + size[2]) / 2 : null) ?? p.r1 ?? null;
  if (p.major !== undefined) radius = p.major + (p.minor ?? 0);
  if (radius == null) radius = p.size ?? 0.5;           /* octahedron 等の size(num) */
  if (typeof radius !== 'number') radius = 0.5;
  let height = p.height ?? (size ? size[1] : null)
    ?? (a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 2 : null) ?? radius;
  /* blob 発: scale は支持半径 — 可視半径 (scale×vr, weight3で≈0.614) に換算して
     他プリミティブの寸法に流す */
  if (node.type === 'blob' && p.scale) {
    const vr = visibleRatio(p);
    size = p.scale.map(v => Math.max(0.02, v * vr));
    radius = (size[0] + size[2]) / 2;
    height = size[1];
  }
  if (!size) size = [radius, height, radius];
  if (!a || !b) {
    a = [center[0], center[1] - height, center[2]];
    b = [center[0], center[1] + height, center[2]];
  }
  const np = makeNode(newType).props;   /* 新型の既定値から開始 */
  for (const f of newSc.fields) {
    switch (f.key) {
      case 'center': np.center = center.slice(); break;
      case 'a': np.a = a.slice(); break;
      case 'b': np.b = b.slice(); break;
      case 'radius': np.radius = radius; break;
      case 'size': np.size = f.type === 'vec3' ? size.slice() : radius; break;
      case 'radii': np.radii = size.slice(); break;
      case 'major': np.major = Math.max(radius * 0.75, 0.05); break;
      case 'minor': np.minor = Math.max(radius * 0.25, 0.02); break;
      case 'r1': np.r1 = p.r1 ?? radius; break;
      case 'r2': np.r2 = p.r2 ?? radius * 0.4; break;
      case 'height': np.height = p.height ?? height; break;
      case 'thick': np.thick = p.thick ?? np.thick; break;
      case 'k': np.k = p.k ?? p.u ?? np.k; break;
      case 'u': np.u = p.u ?? p.k ?? np.u; break;
      case 'deg': if (p.deg) np.deg = p.deg.slice(); break;
      case 'pivot': np.pivot = p.pivot ? p.pivot.slice() : (p.t ? p.t.slice() : np.pivot); break;
      case 't': if (p.t) np.t = p.t.slice(); break;
      case 'normal': if (p.normal) np.normal = p.normal.slice(); break;
      case 'd': np.d = p.d ?? np.d; break;
      case 'scale': {   /* blob 着: 可視寸法 → 支持半径 (weight 3 の較正 ≈/0.614) */
        const vr = threshFromWeight(3);
        np.scale = size.map(v => Math.max(0.03, v / vr));
        break;
      }
    }
  }
  /* sweep 着: a/b (端点系や中心±height から推定済) を2点折れ線の経路に */
  if (newType === 'sweep') {
    np.points = [...a, ...b];
    np.radii = [radius, radius];
    np.curve = 0;
  }
  /* 回転へ変換するとき pivot の手がかりがなければ子の中心を使う */
  if (newType === 'rotate' && !p.pivot && !p.t && node.children[0])
    np.pivot = guessCenter(node.children[0]);
  if (p.mcolor) np.mcolor = p.mcolor.slice();   /* 材質色はタイプ変換をまたいで維持 */
  node.type = newType;
  node.props = np;
}
const XFORM_TYPES = ['translate', 'rotate', 'mirror', 'repeat', 'repeat3', 'repeat-inf', 'round', 'onion', 'elongate', 'scale', 'twist', 'bend'];
function convertCandidates(node) {
  const sc = SCHEMA[node.type];
  if (sc.kind === 'leaf') return PRIM_TYPES.filter(t => t !== node.type);
  /* ラップ系 (演算/変換) は子数が許す範囲で種類をまたいで入れ替え可能:
     変換(子1) → 演算は常にOK / 演算 → 変換は子が1つ以下のときOK */
  const list = OP_TYPES.filter(t =>
    !SCHEMA[t].maxChildren || node.children.length <= SCHEMA[t].maxChildren);
  if (node.children.length <= 1) list.push(...XFORM_TYPES);
  return list.filter(t => t !== node.type);
}

/* ── 選択パーツの移動 (矢印キー / ギズモ共通) ─────────────────
   移動対象の解決: center を持つ leaf はその center、a/b 端点系は両端、
   translate ノードは t。どれも無いグループ等は「親が translate ならその t、
   さもなくば translate(0,0,0) でラップ」(構造変更)。
   ワールド移動量は worldToLocalDelta で回転祖先の逆を掛けてローカル化する。 */
function resolveMoveTarget(obj, node) {
  const p = node.props;
  if (p.center) return { node, keys: ['center'] };
  if (p.a && p.b) return { node, keys: ['a', 'b'] };
  if (p.points) return { node, keys: ['points'] };   /* sweep: 全経路点を平行移動 */
  if (node.type === 'translate') return { node, keys: ['t'] };
  const r = findNode(obj.root, node.id);
  if (r && r.parent && r.parent.type === 'translate') return { node: r.parent, keys: ['t'] };
  const w = makeNode('translate', { t: [0, 0, 0] }, [node]);
  if (r && r.parent) r.parent.children.splice(r.parent.children.indexOf(node), 1, w);
  else obj.root = w;
  return { node: w, keys: ['t'], wrapped: true };
}

let lastArrow = { time: 0, nodeId: null };
function nudgeSelected(delta) {
  const node = selectedNode();
  if (!node) return false;
  const obj = selectedObj();
  /* 連続キー入力は1回の undo 単位にまとめる */
  const now = performance.now();
  if (now - lastArrow.time > 800 || lastArrow.nodeId !== node.id) snapshot();
  lastArrow = { time: now, nodeId: node.id };

  const tgt = resolveMoveTarget(obj, node);
  const dl = worldToLocalDelta(obj.root, tgt.node.id, delta);
  for (const k of tgt.keys) {
    const v = tgt.node.props[k];
    for (let j = 0; j < v.length; j++) v[j] += dl[j % 3];   /* points 等の可変長にも */
  }
  if (tgt.wrapped) { mutated(); renderInspector(); }
  else { mutated(false); if (tgt.keys[0] === 't') renderTree(); }
  return true;
}

/* ── ギズモドラッグ ── */
let gmove = null;   /* { obj, node, keys, orig } */
/* ── ギズモドラッグの軽量化 (フォーカスシェーディング) ──────────
   ドラッグ中は (a) interactive=true で影/AOオフ+適応解像度を効かせ、
   (b) リーフ数がしきい値超なら「編集パーツ+隣接」だけをレイマーチする
   フォーカスシェーダに差し替え、残りはボーンで文脈表示 (ノード数非依存)。
   離したら endGizmoDrag でフルシェーダ+フル画質へ復帰。 */
const FOCUS_LEAF_THRESHOLD = 40;   /* これ超で focus 発動 (rig単体は interactive だけで十分軽い) */
let focusActive = false, focusRestore = null;

function totalLeafCount() {
  let n = 0;
  const walk = x => {
    const sc = SCHEMA[x.type];
    /* blob は数えない — レイマーチに出ないのでドラッグを重くしない。
       数えると blob 97 個のシーンで focus が発動し、ドラッグ開始のたびに
       シェーダ再コンパイル (=フリーズ) が走っていた */
    if (sc && sc.kind === 'leaf' && x.type !== 'plane' && x.type !== 'raw' && x.type !== 'blob' && x.type !== 'mesh') n++;
    x.children.forEach(walk);
  };
  for (const obj of doc.objects) if (obj.visible) walk(obj.root);
  return n;
}
function collectLeafIds(node, set) {
  const sc = SCHEMA[node.type] || { kind: 'leaf' };
  if (sc.kind === 'leaf') { if (node.type !== 'raw' && node.type !== 'blob' && node.type !== 'mesh') set.add(node.id); return; }
  node.children.forEach(c => collectLeafIds(c, set));
}
/* 単項ラップを降りて到達する単一リーフ (opに当たったら null = 別チェーンへは踏み込まない) */
function shallowLeafId(node) {
  let n = node;
  while (n) {
    const sc = SCHEMA[n.type] || { kind: 'leaf' };
    if (sc.kind === 'leaf') return n.type === 'raw' ? null : n.id;
    if (sc.kind === 'op') return null;
    n = n.children[0];
  }
  return null;
}
/* フォーカス集合 = 選択サブツリーの全リーフ + 「土台ボーン」。
   土台 = 単項ラップ (translate/rotate/mirror…) を遡って最初に当たる包含op の
   兄弟の shallow リーフ。リグは leaf→translate→rotate→smooth-union 構造なので
   遡らないと関節の付け根 (上流の親カプセル) が骨のままになる。
   包含op の子が少数 (≤6) の時だけ足す — 多数リーフのフラット union で兄弟全部を
   巻き込まないための上限。 */
const FOCUS_SIBLING_CAP = 6;
function computeFocusSet() {
  const node = selectedNode();
  if (!node) return null;
  const obj = selectedObj();
  const set = new Set();
  collectLeafIds(node, set);
  /* 単項ラップを遡って包含op を探し、兄弟の土台ボーンを足す */
  let cur = node, r = findNode(obj.root, cur.id);
  while (r && r.parent) {
    const parent = r.parent;
    const psc = SCHEMA[parent.type] || {};
    if (psc.kind === 'op') {
      if (parent.children.length <= FOCUS_SIBLING_CAP)
        for (const sib of parent.children) {
          if (sib === cur) continue;
          const id = shallowLeafId(sib);
          if (id) set.add(id);
        }
      break;
    }
    cur = parent;                      /* 単項xform: さらに上へ */
    r = findNode(obj.root, cur.id);
  }
  return set;
}
/* 任意断面 (profile) 付き sweep が可視シーンにあるか — ドラッグ中の近似降格の判定 */
let sweepApproxActive = false;
function docHasProfileSweep() {
  let found = false;
  const walk = n => {
    if (found) return;
    if (n.type === 'sweep' && n.props.profile && n.props.profile.length >= 3) { found = true; return; }
    n.children.forEach(walk);
  };
  for (const obj of doc.objects) { if (obj.visible) walk(obj.root); if (found) break; }
  return found;
}
function beginGizmoDrag() {
  viewer.interactive = true;   /* ギズモドラッグは従来これが立たず毎回フル画質だった */
  /* 任意断面 sweep の正確評価 (断面点数×セグメント/距離評価) はドラッグには重い →
     ドラッグ中だけ近似チューブ+ボーン表示に降格し、離すと正確表示へ復帰 */
  const approx = docHasProfileSweep();
  /* focus 発動条件: リーフ多数 OR ボーン表示ON (ボーンONのギズモ操作で編集対象まで
     boneOnly=全クリアで消えてしまうのを防ぐ — 対象+隣接だけは実体で見せる) */
  const wantFocus = totalLeafCount() > FOCUS_LEAF_THRESHOLD || viewer.boneOnly;
  if (!focusActive && wantFocus) {
    const focus = computeFocusSet();
    if (focus && focus.size) {
      focusRestore = { bonesEnabled: boneOverlay.enabled, boneOnly: viewer.boneOnly };
      viewer.boneOnly = false;          /* focus は実体をレイマーチ (bones全停止ではない) */
      boneOverlay.setEnabled(true);     /* 残りは骨格で文脈表示 */
      const prog = buildProgram(doc, focus, progOpts({ sweepApprox: approx }));
      layout = prog.layout;             /* focusSet のみなら layout 不変 (params 流用可) */
      if (approx) viewer.setParams(collectParams(doc, layout));   /* approx はレイアウトが変わる */
      showCompiling(true, '編集中パーツだけの軽量シェーダ');
      viewer.setProgram(prog.frag, e => { showCompiling(false); console.error(e); },
                        () => showCompiling(false));
      focusActive = true;
      sweepApproxActive = approx;
      /* ハイブリッド文脈: focus 外はボーンだけだったのを、キャッシュ済みメッシュが
         あれば「編集中 object 以外」を深度合成で重ねる (A案)。メッシュが未着なら
         従来どおりボーンのみ */
      viewer.setMeshContext(sel.objIdx);
    }
  } else if (!focusActive && !sweepApproxActive && approx) {
    focusRestore = { bonesEnabled: boneOverlay.enabled, boneOnly: viewer.boneOnly };
    boneOverlay.setEnabled(true);       /* 経路の制御ポリラインを文脈表示 */
    const prog = buildProgram(doc, null, progOpts({ sweepApprox: true }));
    layout = prog.layout;
    viewer.setParams(collectParams(doc, layout));
    showCompiling(true, 'ドラッグ用の近似シェーダ');
    viewer.setProgram(prog.frag, e => { showCompiling(false); console.error(e); },
                      () => showCompiling(false));
    sweepApproxActive = true;
  }
  viewer.requestRender();
}
function endGizmoDrag() {
  if (focusActive || sweepApproxActive) {
    focusActive = false;
    sweepApproxActive = false;
    viewer.setMeshContext(null);        /* ハイブリッド文脈を外す */
    boneOverlay.setEnabled(focusRestore.bonesEnabled);
    viewer.boneOnly = focusRestore.boneOnly;
    focusRestore = null;
    rebuild();                          /* フルシェーダ (正確表示) 再構築 */
  }
  if (viewer.interactive === true) {
    viewer.interactive = 'cooling';     /* フル画質で1枚再描画 */
    viewer.requestRender();
  }
  scheduleBlobMesh();                   /* ドラッグ終わり: level 6 で焼き直す */
}

function gizmoStart() {
  const node = selectedNode();
  if (!node) return false;
  const obj = selectedObj();
  snapshot();
  const tgt = resolveMoveTarget(obj, node);
  if (tgt.wrapped) { mutated(); renderInspector(); }
  gmove = { obj, node: tgt.node, keys: tgt.keys, orig: tgt.keys.map(k => tgt.node.props[k].slice()) };
  beginGizmoDrag();
  return true;
}
function gizmoMove(dWorld, ev) {
  if (!gmove) return;
  /* Shift = 0.1 グリッドスナップ (ワールド軸) */
  const dw = ev.shiftKey ? dWorld.map(v => Math.round(v / 0.1) * 0.1) : dWorld;
  const dl = worldToLocalDelta(gmove.obj.root, gmove.node.id, dw);
  gmove.keys.forEach((k, i) => {
    const v = gmove.node.props[k];
    for (let j = 0; j < v.length; j++) v[j] = gmove.orig[i][j] + dl[j % 3];   /* points 可変長対応 */
  });
  mutated(false);
  const p = gmove.node.props[gmove.keys[0]].slice(0, 3);
  setStatus(`移動: ${gmove.keys[0]} = (${p.map(v => fmt(Math.round(v * 1000) / 1000)).join(' ')})` +
            (ev.shiftKey ? ' [0.1 スナップ]' : ''));
}
function gizmoEnd() {
  if (!gmove) return;
  gmove = null;
  endGizmoDrag();
  renderTree();
  renderInspector();
}

/* ── ボーン (スケルトン) 表示: 全リーフの骨格をワールド座標で列挙 ──
   a/b 端点系 = 線分、center 系 = 点、rotate 関節 = pivot リング。
   plane と raw は除外。worldPoint が祖先 xform を適用 (mirror は恒等近似) */
function collectBones() {
  const out = [];
  for (const obj of doc.objects) {
    if (!obj.visible) continue;
    const walk = n => {
      const sc = SCHEMA[n.type];
      if (sc && sc.kind === 'leaf') {
        if (n.type === 'plane' || n.type === 'raw') return;
        const p = n.props;
        if (p.a && p.b) out.push({ a: worldPoint(obj.root, n.id, p.a), b: worldPoint(obj.root, n.id, p.b) });
        else if (p.center) out.push({ a: worldPoint(obj.root, n.id, p.center) });
        else if (n.type === 'sweep' && p.points) {   /* 経路の制御点列をポリラインで */
          for (let q = 0; q + 5 < p.points.length; q += 3)
            out.push({ a: worldPoint(obj.root, n.id, p.points.slice(q, q + 3)),
                       b: worldPoint(obj.root, n.id, p.points.slice(q + 3, q + 6)) });
        }
        return;
      }
      if (n.type === 'rotate' || n.type === 'rotate-mat')
        out.push({ pivot: worldPoint(obj.root, n.id, n.props.pivot || [0, 0, 0]) });
      n.children.forEach(walk);
    };
    walk(obj.root);
  }
  return out;
}

/* ── ギズモ回転 ───────────────────────────────────────────────
   回転ターゲット: 選択が rotate/rotate-mat ならそれ自身、親が rotate系なら親
   (=関節。リングはその pivot に出る)。どちらも無ければ「自身のアンカーを
   pivot にした rotate(0,0,0)」でラップ。
   ドラッグはワールド軸 n・角 φ → S_new = R(nをローカル化, φ)·S_start を合成し、
   rotate は Euler 逆分解して deg へ、rotate-mat は m0..m8 へ直接書き戻す。 */
function peekRotateTarget(obj, node) {
  if (node.type === 'rotate' || node.type === 'rotate-mat') return node;
  const r = findNode(obj.root, node.id);
  if (r && r.parent && (r.parent.type === 'rotate' || r.parent.type === 'rotate-mat'))
    return r.parent;
  return null;
}
/* rotate ターゲットを取得。無ければ自身のアンカーを pivot にした rotate(0,0,0) でラップ */
function ensureRotateTarget(obj, node) {
  const tgt = peekRotateTarget(obj, node);
  if (tgt) return { node: tgt };
  const pivot = localAnchor(node) || [0, 0, 0];
  const r = findNode(obj.root, node.id);
  const w = makeNode('rotate', { deg: [0, 0, 0], pivot }, [node]);
  if (r && r.parent) r.parent.children.splice(r.parent.children.indexOf(node), 1, w);
  else obj.root = w;
  return { node: w, wrapped: true };
}

const D2R = Math.PI / 180;
let grot = null;   /* { obj, node, isMat, S } — S = ドラッグ開始時の回転行列 */
function gizmoRotStart() {
  const node = selectedNode();
  if (!node) return false;
  const obj = selectedObj();
  snapshot();
  /* blob は rot が intrinsic — rotate ノードでラップせず props.rot を直接回す
     (ツリーが変わらないので Pair 鏡映同期も効く)。⚠ 合成は blobRotMat (ZYX) */
  if (node.type === 'blob' || node.type === 'mesh') {   /* mesh(OBJ) も同じ ZYX 規約 */
    grot = { obj, node, isBlob: true,
             S: blobRotMat(node.props.rot[0], node.props.rot[1], node.props.rot[2]) };
    beginGizmoDrag();
    return true;
  }
  const t = ensureRotateTarget(obj, node);
  if (t.wrapped) { mutated(); renderInspector(); }
  const tgt = t.node;
  const p = tgt.props;
  const isMat = tgt.type === 'rotate-mat';
  const S = isMat ? [p.m0, p.m1, p.m2, p.m3, p.m4, p.m5, p.m6, p.m7, p.m8]
                  : eulerToMat(p.deg[0] * D2R, p.deg[1] * D2R, p.deg[2] * D2R);
  grot = { obj, node: tgt, isMat, S };
  beginGizmoDrag();
  return true;
}
function gizmoRotMove(axisWorld, angle, ev) {
  if (!grot) return;
  /* Shift = 15° スナップ */
  const a = ev.shiftKey ? Math.round(angle / (Math.PI / 12)) * (Math.PI / 12) : angle;
  const axisL = worldToLocalDelta(grot.obj.root, grot.node.id, axisWorld);
  const S = matmul3(axisAngleMat(axisL, a), grot.S);
  if (grot.isBlob) {
    const e = blobMatToEulerDeg(S);
    if (!e) return;
    grot.node.props.rot = e;
    mutated(false);
    setStatus(`回転: ${(a / D2R).toFixed(1)}° → rot=(${e.map(v => fmt(Math.round(v * 10) / 10)).join(' ')})` +
      (ev.shiftKey ? ' [15°スナップ]' : ''));
    return;
  }
  if (grot.isMat) {
    for (let i = 0; i < 9; i++) grot.node.props['m' + i] = S[i];
  } else {
    const e = matToEulerDeg(S);
    if (!e) return;   /* 数値端で分解不能なら直前値を保持 */
    grot.node.props.deg = e;
  }
  mutated(false);
  setStatus(`回転: ${(a / D2R).toFixed(1)}°` +
    (grot.isMat ? '' : ` → deg=(${grot.node.props.deg.map(v => fmt(Math.round(v * 10) / 10)).join(' ')})`) +
    (ev.shiftKey ? ' [15°スナップ]' : ''));
}
function gizmoRotEnd() {
  if (!grot) return;
  grot = null;
  endGizmoDrag();
  renderTree();
  renderInspector();
}

/* ── ギズモ pivot 移動 (回転モードの中央ドット。ビュー平面ドラッグ) ──
   関節の「曲がる位置」を決める。deg≠0 だと pivot 移動で子の見た目も動く点に注意
   (関節を組むときは deg=0 のうちに置くのが基本)。rotate が無ければ自動ラップ
   (deg=0 なので見た目は不変 = 関節の仕込みだけができる) */
let gpivot = null;
function gizmoPivotStart() {
  const node = selectedNode();
  if (!node) return false;
  const obj = selectedObj();
  snapshot();
  const t = ensureRotateTarget(obj, node);
  if (t.wrapped) { mutated(); renderInspector(); }
  gpivot = { obj, node: t.node, orig: (t.node.props.pivot || [0, 0, 0]).slice() };
  beginGizmoDrag();
  return true;
}
function gizmoPivotMove(dWorld, ev) {
  if (!gpivot) return;
  const dw = ev.shiftKey ? dWorld.map(v => Math.round(v / 0.1) * 0.1) : dWorld;
  const dl = worldToLocalDelta(gpivot.obj.root, gpivot.node.id, dw);
  gpivot.node.props.pivot = gpivot.orig.map((v, i) => v + dl[i]);
  mutated(false);
  setStatus(`pivot = (${gpivot.node.props.pivot.map(v => fmt(Math.round(v * 1000) / 1000)).join(' ')})` +
    (ev.shiftKey ? ' [0.1スナップ]' : ''));
}
function gizmoPivotEnd() {
  if (!gpivot) return;
  gpivot = null;
  endGizmoDrag();
  renderTree();
  renderInspector();
}

/* ── ギズモ制御点ドラッグ (sweep の経路点。移動モードの緑ドット) ──
   各制御点をビュー平面ドラッグで個別に動かす (ギズモ本体=全点平行移動とは別)。
   座標変更のみ = uniform 更新 (スロット数不変) なので mutated(false) で軽い */
let gpt = null;
function sweepPointsNode() {
  const node = selectedNode();
  return node && node.type === 'sweep' ? node : null;
}
function gizmoPointStart(idx) {
  const node = sweepPointsNode();
  if (!node || idx < 0 || 3 * idx + 2 >= node.props.points.length) return false;
  snapshot();
  gpt = { obj: selectedObj(), node, idx, orig: node.props.points.slice() };
  beginGizmoDrag();
  return true;
}
function gizmoPointMove(idx, dWorld, ev) {
  if (!gpt) return;
  const dw = ev.shiftKey ? dWorld.map(v => Math.round(v / 0.1) * 0.1) : dWorld;
  const dl = worldToLocalDelta(gpt.obj.root, gpt.node.id, dw);
  const pts = gpt.node.props.points;
  for (let i = 0; i < 3; i++) pts[3 * idx + i] = gpt.orig[3 * idx + i] + dl[i];
  mutated(false);
  setStatus(`点${idx + 1} = (${pts.slice(3 * idx, 3 * idx + 3).map(v => fmt(Math.round(v * 1000) / 1000)).join(' ')})` +
    (ev.shiftKey ? ' [0.1スナップ]' : ''));
}
function gizmoPointEnd() {
  if (!gpt) return;
  gpt = null;
  endGizmoDrag();
  renderInspector();
}

/* ── ギズモスケール ─────────────────────────────────────────
   対象はプリミティブ (グループには scale 相当の SDF オペが無い)。仕様は js/scale.js。
   関節 (rotate) やグループ選択時は「サブツリー最初のスケール可能リーフ」に委譲
   (リグでは = その節のカプセル)。軸ハンドルはリーフのローカル軸をワールド化した方向 */
function scaleTargetFor(node) {
  if (!node) return null;
  if (scaleAxesFor(node) != null) return node;
  for (const c of node.children) {
    const t = scaleTargetFor(c);
    if (t) return t;
  }
  return null;
}
let gscale = null;
function gizmoScaleStart() {
  const node = scaleTargetFor(selectedNode());
  if (!node) return false;
  snapshot();
  if (node !== selectedNode()) {   /* 委譲先リーフを選択に (インスペクタと一致させる) */
    sel = { objIdx: sel.objIdx, nodeId: node.id };
    renderTree();
    renderInspector();
    updateSelUniform();
  }
  gscale = { obj: selectedObj(), node, orig: JSON.parse(JSON.stringify(node.props)) };
  beginGizmoDrag();   /* sel は委譲先リーフに更新済 → focus 集合もそれ基準 */
  return true;
}
function gizmoScaleMove(axis, s, ev) {
  if (!gscale) return;
  let sc = ev.shiftKey ? Math.max(0.1, Math.round(s * 10) / 10) : s;
  sc = Math.min(100, Math.max(0.01, sc));   /* applyScale と同じクランプ (表示も一致させる) */
  if (!applyScale(gscale.node, gscale.orig, axis, sc)) return;
  mutated(false);
  setStatus(`スケール: ×${sc.toFixed(2)}` + (ev.shiftKey ? ' [0.1スナップ]' : ''));
}
function gizmoScaleEnd() {
  if (!gscale) return;
  gscale = null;
  endGizmoDrag();
  renderTree();
  renderInspector();
}
/* カメラの右/前ベクトルを最寄りのワールド軸 (XZ) にスナップ */
function camAxis(vec) {
  return Math.abs(vec[0]) > Math.abs(vec[2])
    ? [Math.sign(vec[0]), 0, 0] : [0, 0, Math.sign(vec[2])];
}
function handleArrowKey(e) {
  const step = e.shiftKey ? 0.01 : 0.1;
  const { right, fwd } = viewer._camVectors();
  let d = null;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const s = (e.key === 'ArrowRight' ? 1 : -1) * step;
    d = camAxis(right).map(v => v * s);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const s = (e.key === 'ArrowUp' ? 1 : -1) * step;
    d = e.altKey ? camAxis(fwd).map(v => v * s) : [0, s, 0];  /* Alt=奥行き */
  }
  if (!d) return false;
  if (!nudgeSelected(d)) return false;
  e.preventDefault();
  return true;
}

/* ノード削除。ルートを消した場合は空の滑らか和ルートに戻す (新規シーンと同じ状態) */
function deleteNode(obj, node) {
  const r = findNode(obj.root, node.id);
  snapshot();
  if (r && r.parent) {
    r.parent.children.splice(r.parent.children.indexOf(node), 1);
    sel.nodeId = r.parent.id;
  } else {
    obj.root = makeNode('smooth-union', { k: 0.15 });
    sel.nodeId = obj.root.id;
  }
  mutated();
  renderInspector();
}

function reorder(parent, node, dir) {
  const i = parent.children.indexOf(node);
  const j = i + dir;
  if (j < 0 || j >= parent.children.length) return;
  snapshot();
  [parent.children[i], parent.children[j]] = [parent.children[j], parent.children[i]];
  mutated();
}

/* ── ツリーの Drag & Drop 移動 ────────────────────────────────
   行をドラッグ→別の行へドロップ: その行の直後 (同じ階層) に移動。
   オブジェクト行 or ルート行へドロップ: そのオブジェクトのルート直下末尾へ。
   別オブジェクトへの移動も可。ルート自身は動かせない。
   オブジェクト行のドラッグ→別オブジェクトへドロップ: 統合
   (ツリーを移し元オブジェクトは削除。surface は統合先が適用される)。 */
let dragSrc = null;  /* ノード { oi, nodeId } / オブジェクト { oi, obj: true } */

/* 移動先親の子数上限チェック (xform/invert=1, blend=2)。同一親内は並べ替えなので常に可 */
function dropCapacityOk(parent, sourceParent) {
  if (parent === sourceParent) return true;
  const sc = SCHEMA[parent.type] || {};
  if (sc.kind !== 'op' && sc.kind !== 'xform') return false;   /* leaf は子を持てない */
  const cap = sc.kind === 'xform' ? 1 : (sc.maxChildren || Infinity);
  return parent.children.length < cap;
}
/* ドロップ先を解決。target=null はオブジェクト行 (ルート直下末尾)。不可なら null */
function resolveDrop(toi, target) {
  if (!dragSrc) return null;
  const sObj = doc.objects[dragSrc.oi];
  if (!sObj) return null;
  let node, sourceParent = null;
  if (dragSrc.obj) {                        /* オブジェクト統合: ルートごと移す */
    if (toi === dragSrc.oi) return null;    /* 自オブジェクト内へは不可 */
    node = sObj.root;
  } else {
    const sr = findNode(sObj.root, dragSrc.nodeId);
    if (!sr || !sr.parent) return null;                       /* ルートは移動不可 */
    node = sr.node;
    sourceParent = sr.parent;
    if (target && (target === node || findNode(node, target.id))) return null;  /* 自分/子孫へは不可 */
  }
  const tObj = doc.objects[toi];
  let parent = tObj.root, after = null;
  if (target) {
    const tr = findNode(tObj.root, target.id);
    if (!tr) return null;
    if (tr.parent) { parent = tr.parent; after = target; }    /* 同階層=ターゲット直後 */
  }
  const mergeObj = dragSrc.obj ? sObj : null;
  if (!dropCapacityOk(parent, sourceParent)) {
    /* オブジェクト統合でルート直下に空きが無ければ union ラップで受ける */
    if (mergeObj && !after) return { node, mergeObj, tObj, wrapRoot: true };
    return null;
  }
  return { node, sourceParent, parent, after, mergeObj, tObj };
}
function performDrop(toi, target) {
  const d = resolveDrop(toi, target);
  if (!d) return;
  let si = -1;
  if (d.sourceParent) {
    si = d.sourceParent.children.indexOf(d.node);
    if (si < 0) return;                     /* 消せないなら挿入もしない (複製防止) */
  }
  snapshot();
  if (d.sourceParent) d.sourceParent.children.splice(si, 1);
  if (d.wrapRoot) {
    d.tObj.root = makeNode('union', {}, [d.tObj.root, d.node]);
  } else {
    const idx = d.after ? d.parent.children.indexOf(d.after) + 1 : d.parent.children.length;
    d.parent.children.splice(idx, 0, d.node);
  }
  if (d.mergeObj) {
    /* 統合で色が失われないよう、移したツリーに元オブジェクトの色を材質色として付与 */
    if (!d.node.props.mcolor) d.node.props.mcolor = surfaceColor(d.mergeObj.surface);
    doc.objects.splice(doc.objects.indexOf(d.mergeObj), 1);
  }
  sel = { objIdx: doc.objects.indexOf(d.tObj), nodeId: d.node.id };
  mutated();
  renderInspector();
}
function wireDropTarget(row, toi, target) {
  row.ondragover = e => {
    if (!resolveDrop(toi, target)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  };
  row.ondragleave = () => row.classList.remove('drop-target');
  row.ondrop = e => {
    e.preventDefault();
    row.classList.remove('drop-target');
    performDrop(toi, target);
    dragSrc = null;
  };
}
function guessCenter(node) {
  const c = node.props.center || node.props.a || node.props.t;
  if (c) return c.slice();
  const pts = node.props.points;   /* sweep: 経路の重心 */
  if (pts && pts.length >= 3) {
    const acc = [0, 0, 0], n = Math.floor(pts.length / 3);
    for (let q = 0; q < n; q++) for (let i = 0; i < 3; i++) acc[i] += pts[3 * q + i];
    return [acc[0] / n, acc[1] / n, acc[2] / n];
  }
  return [0, 0, 0];
}
/* リーフ/サブツリーの概算最大寸法 (新規ノードの配置オフセット用) */
function nodeDim(n) {
  const sc = SCHEMA[n.type];
  if (sc && sc.kind === 'leaf') {
    let d = 0.05;
    for (const k of ['radius', 'major', 'minor', 'height', 'r1', 'r2', 'size', 'radii', 'thick']) {
      const v = n.props[k];
      if (v == null) continue;
      d = Math.max(d, Array.isArray(v) ? Math.max(...v.map(Math.abs)) : Math.abs(v));
    }
    return d;
  }
  let m = 0.05;
  for (const c of n.children) m = Math.max(m, nodeDim(c));
  return m;
}

/* 新ノードをアンカー点 a の隣 (+x, refDim ぶん離す) に配置する。
   従来はローカル原点 (0,0,0) 生成で既存ジオメトリや床下に埋まり
   「追加したのに見えない」現象になっていた (ギズモだけ原点に出る)。 */
function placeNodeAt(nn, a, refDim) {
  const target = (SCHEMA[nn.type] || {}).kind === 'leaf' ? nn : nn.children[0];
  if (!target || !a) return;
  /* 参照よりだいぶ大きい既定寸法は参照に比例縮小 (リグ内で新パーツが巨大化しない) */
  const td = nodeDim(target);
  if (td > refDim * 1.5 && scaleAxesFor(target) != null)
    applyScale(target, JSON.parse(JSON.stringify(target.props)), -1, (refDim * 1.2) / td);
  const dx = refDim + nodeDim(target) + 0.06;
  const p = target.props;
  if (p.center) {
    p.center = [a[0] + dx, a[1], a[2]];
  } else if (p.a && p.b) {
    const mid = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2];
    const t = [a[0] + dx - mid[0], a[1] - mid[1], a[2] - mid[2]];
    p.a = p.a.map((v, i) => v + t[i]);
    p.b = p.b.map((v, i) => v + t[i]);
  } else if (p.points && p.points.length >= 3) {   /* sweep: 始点をアンカー隣へ (全点平行移動) */
    const t = [a[0] + dx - p.points[0], a[1] - p.points[1], a[2] - p.points[2]];
    for (let q = 0; q < p.points.length; q++) p.points[q] += t[q % 3];
  }
}
function placeNodeNear(nn, ref) {
  const a = ref && localAnchor(ref);   /* 参照の代表点 (同じローカルフレーム) */
  if (a) placeNodeAt(nn, a, nodeDim(ref));
}
/* サブツリーの「最後のリーフ」(plane/raw を除く)。空オブジェクトの初手配置の参照用 */
function lastLeafNode(n) {
  const sc = SCHEMA[n.type];
  if (sc && sc.kind === 'leaf') return (n.type === 'raw' || n.type === 'plane') ? null : n;
  for (let i = n.children.length - 1; i >= 0; i--) {
    const l = lastLeafNode(n.children[i]);
    if (l) return l;
  }
  return null;
}

function defaultChildNode(t, ref) {
  const sc = SCHEMA[t];
  const nn = sc.kind === 'op'
    ? makeNode(t, {}, [makeNode('sphere', { center: [0, 0.5, 0], radius: 0.6 })])
    : makeNode(t, QUICK_PROPS[t] ? JSON.parse(JSON.stringify(QUICK_PROPS[t])) : {});
  if (ref) placeNodeNear(nn, ref);   /* 参照ノードの隣に (埋まり防止) */
  return nn;
}
function renderTreeLabelOnly() { renderTree(); }

function renderObjectInspector(box) {
  const obj = selectedObj();
  if (!obj) return;
  const title = document.createElement('h3');
  title.textContent = 'オブジェクト';
  box.appendChild(title);

  const nameRow = fieldRow('名前');
  const nameInp = document.createElement('input');
  nameInp.type = 'text';
  nameInp.value = obj.name;
  nameInp.onchange = () => { snapshot(); obj.name = nameInp.value; renderTree(); autosave(); };
  nameRow.appendChild(nameInp);
  box.appendChild(nameRow);

  const colRow = fieldRow('色');
  const colInp = document.createElement('input');
  colInp.type = 'color';
  const c = surfaceColor(obj.surface);
  colInp.value = rgbToHex(c);
  colInp.oninput = () => {
    obj.surface = setSurfaceColor(obj.surface, hexToRgb(colInp.value));
    rebuild();
    autosave();
  };
  colRow.appendChild(colInp);
  box.appendChild(colRow);

  const surfLabel = document.createElement('div');
  surfLabel.className = 'flabel';
  surfLabel.textContent = 'surface (.ssq raw)';
  box.appendChild(surfLabel);
  const ta = document.createElement('textarea');
  ta.value = obj.surface;
  ta.rows = 6;
  ta.onchange = () => { snapshot(); obj.surface = ta.value; rebuild(); renderTree(); autosave(); };
  box.appendChild(ta);

  box.appendChild(document.createElement('hr'));
  const btns = document.createElement('div');
  btns.className = 'btnrow';
  btns.appendChild(button('DUP', () => {
    snapshot();
    const copy = {
      name: obj.name + '_copy',
      visible: obj.visible,
      surface: obj.surface,
      extras: (obj.extras || []).slice(),
      root: cloneNode(obj.root),
    };
    doc.objects.splice(sel.objIdx + 1, 0, copy);
    sel = { objIdx: sel.objIdx + 1, nodeId: null };
    mutated();
    renderInspector();
  }));
  if (doc.objects.length > 1) btns.appendChild(button('DEL', () => {
    snapshot();
    doc.objects.splice(sel.objIdx, 1);
    sel = { objIdx: 0, nodeId: null };
    mutated();
    renderInspector();
  }, 'danger'));
  box.appendChild(btns);

  /* シーン設定 */
  box.appendChild(document.createElement('hr'));
  const st = document.createElement('h3');
  st.textContent = 'シーン';
  box.appendChild(st);
  const bgRow = fieldRow('背景色');
  const bgInp = document.createElement('input');
  bgInp.type = 'color';
  bgInp.value = rgbToHex(doc.background);
  bgInp.oninput = () => { doc.background = hexToRgb(bgInp.value); viewer.setBackground(doc.background); autosave(); };
  bgRow.appendChild(bgInp);
  box.appendChild(bgRow);
  const liLabel = document.createElement('div');
  liLabel.className = 'flabel';
  liLabel.textContent = 'ライト (.ssq raw, 1行1灯)';
  box.appendChild(liLabel);
  const lta = document.createElement('textarea');
  lta.rows = 4;
  lta.value = doc.lights.map(l => l.raw).join('\n');
  lta.onchange = () => {
    snapshot();
    try {
      const forms = parseAll(lta.value).filter(f => Array.isArray(f) && String(f[0]) === 'light');
      doc.lights = forms.map(parseLightForm);
    } catch (e) { setStatus('ライト解析エラー: ' + e.message, true); }
    viewer.setLights(doc.lights);
    autosave();
  };
  box.appendChild(lta);

  /* ── no-blend (native blob の非融合ペア) — blob のあるシーンだけ出す ──
     ssq_edit の群チップと同じ操作系: 群を2つ順にクリックでペアを切替。
     ペアは group 番号の組で、sqm へは 1 ペア 1 行の (no-blend a b) で出る */
  const groups = collectBlobGroups();
  if (groups.length >= 2 || (doc.nbPairs || []).length) {
    const nbLabel = document.createElement('div');
    nbLabel.className = 'flabel';
    nbLabel.textContent = 'no-blend (blob 非融合: 群を2つクリックでペア切替)';
    box.appendChild(nbLabel);
    const chipRow = document.createElement('div');
    chipRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 4px';
    for (const g of groups) {
      const b = button('群' + g, () => {
        if (nbPick == null) { nbPick = g; renderInspector(); return; }
        if (nbPick === g) { nbPick = null; renderInspector(); return; }
        snapshot();
        const lo = Math.min(nbPick, g), hi = Math.max(nbPick, g);
        const i = doc.nbPairs.findIndex(q => q[0] === lo && q[1] === hi);
        if (i >= 0) doc.nbPairs.splice(i, 1); else doc.nbPairs.push([lo, hi]);
        nbPick = null;
        mutated(false);
        renderInspector();
      });
      if (nbPick === g) b.style.outline = '2px solid #539bf5';
      else if (nbPick != null &&
               doc.nbPairs.some(q => q[0] === Math.min(nbPick, g) && q[1] === Math.max(nbPick, g)))
        b.style.outline = '2px solid #e5534b';
      chipRow.appendChild(b);
    }
    box.appendChild(chipRow);
    if ((doc.nbPairs || []).length) {
      const prow = document.createElement('div');
      prow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
      for (const [a, b2] of doc.nbPairs) {
        prow.appendChild(button(`${a}×${b2} ✕`, () => {
          snapshot();
          doc.nbPairs = doc.nbPairs.filter(q => !(q[0] === a && q[1] === b2));
          mutated(false);
          renderInspector();
        }));
      }
      box.appendChild(prow);
    }
  }
}
/* シーン内の blob の (group n) を昇順ユニークで集める (no-blend UI 用) */
let nbPick = null;
function collectBlobGroups() {
  const set = new Set();
  const walk = n => { if (n.type === 'blob') set.add(n.props.group); n.children.forEach(walk); };
  for (const o of doc.objects) if (o.root) walk(o.root);
  return [...set].sort((a, b) => a - b);
}
function fieldRow(label) {
  const row = document.createElement('div');
  row.className = 'frow';
  const l = document.createElement('div');
  l.className = 'flabel';
  l.textContent = label;
  row.appendChild(l);
  return row;
}
function button(txt, fn, cls = '') {
  const b = document.createElement('button');
  b.textContent = txt;
  b.className = cls;
  b.onclick = fn;
  return b;
}
function typeMenu(label, types, fn) {
  const selEl = document.createElement('select');
  const first = document.createElement('option');
  first.textContent = label;
  first.value = '';
  selEl.appendChild(first);
  for (const t of types) {
    const o = document.createElement('option');
    if (t[0] === '—') { o.disabled = true; const lbl = t.slice(1).trim(); o.textContent = lbl ? `──── ${lbl} ────` : '────'; }
    else { o.value = t; o.textContent = (SCHEMA[t] ? SCHEMA[t].label : t) + '  ' + t; }
    selEl.appendChild(o);
  }
  selEl.onchange = () => { if (selEl.value) fn(selEl.value); selEl.value = ''; };
  return selEl;
}
function rgbToHex(c) {
  const h = v => Math.round(Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}
function hexToRgb(hex) {
  const v = i => Math.pow(parseInt(hex.slice(i, i + 2), 16) / 255, 2.2);
  return [v(1), v(3), v(5)].map(x => Math.round(x * 1000) / 1000);
}

/* ── ファイルI/O ──────────────────────────────────────────── */
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
/* ── シーン読込時の重量パーツ自動除外 (2026-07-27) ─────────────────────────
   明らかに重い葉を最初から◉OFF (hidden) で開く。招き猫の撚り紐 (sweep 1680反復×3
   = シーンの97%) を SDF レイマーチのまま開いて GPU が落ちた事故の再発防止。
   「明らかに」の判定は絶対と相対の両方:
     - 絶対 HEAVY_ABS (既定300): これ未満は隠さない。実測の目安 — 撚り紐1680は
       ハング圏 / 密化後の胴 lathe≈280・腕 tube=36 は実用上無害
     - 相対 HEAVY_FRAC (既定0.15): シーン総コストに占める割合。**中央値比は不可** —
       小さい楕円体が多数のシーンでは中央値が1になり、主役の胴 (lathe≈280) まで
       「相対的に重い」と誤爆して頭だけが浮いた (実際に踏んだ)。割合なら
       「全パーツが一様に重い」シーンでも誰も 15% を超えず全消しにならない
   window.__HEAVY_ABS / __HEAVY_FRAC で上書き可 (SPH_REL と同じ流儀)。
   view 状態なので書き出し/メッシュ/sqmレンダには含まれる。ツリーの◉で個別復帰。 */
const HEAVY_ABS = () => (window.__HEAVY_ABS != null ? window.__HEAVY_ABS : 300);
const HEAVY_FRAC = () => (window.__HEAVY_FRAC != null ? window.__HEAVY_FRAC : 0.15);
const HEAVY_MAX_FRAC = () => (window.__HEAVY_MAX_FRAC != null ? window.__HEAVY_MAX_FRAC : 0.55);
function autoHideHeavy(d) {
  const leaves = [];
  for (const obj of d.objects) leaves.push(...collectLeafCosts(obj.root));
  if (leaves.length < 2) return [];
  const total = leaves.reduce((a, l) => a + l.cost, 0);
  /* ★上限も要る: 総コストの大半を占める葉は「外れ値」ではなく**モデル本体**で、
     隠すと胴ごと消えてしまう (埴輪の胴を 1 lathe で作ると 1パーツで8割を占める)。
     撚り紐は1本32%なので下の 0.55 は通り、本体は弾かれる。 */
  const hit = leaves.filter(l => l.cost >= HEAVY_ABS()
                              && l.cost >= HEAVY_FRAC() * total
                              && l.cost <= HEAVY_MAX_FRAC() * total);
  hit.forEach(l => { l.node.hidden = true; });
  return hit;
}

/* 開くファイルを種別で振り分ける。**判定は名前でなく先頭8バイト**で行う —
   レンダー結果をリネームして持ってくることがあり、拡張子は当てにならない
   (.png のテキスト・.txt の PNG、どちらも実際に起こる)。 */
async function openFile(f) {
  if (!isPng(await f.slice(0, 8).arrayBuffer())) {
    importText(await f.text(), f.name);
    return;
  }
  try {
    const { scene, meta } = await readPngScene(await f.arrayBuffer());
    importText(scene, f.name);
    const src = meta['sqm:scene-path'] || '';
    /* ⚠ sticky にしないと、直後に完了する非同期コンパイルの status に潰されて
       「PNG から開けた」ことがユーザーに見えない (importText と同じ扱い)。 */
    const msg = `${f.name} に埋まっていたシーンを開きました`
      + (src ? ` (元: ${src})` : '')
      + ' — 画像そのものがシーンを持っています';
    if (!sticky || !sticky.err) sticky = { msg, err: false };
    setStatus(msg);
  } catch (err) {
    console.error(err);
    setStatus('PNG からシーンを読めません: ' + err.message, true);
  }
}

function importText(text, fileName = '') {
  snapshot();
  try {
    let autoHidden = [];
    if (fileName.endsWith('.json') || text.trimStart().startsWith('{')) {
      doc = docFromJSON(text);   /* .json はモデラー文書 = 保存済みの hidden を尊重 */
    } else {
      doc = parseScene(text);
      autoHidden = autoHideHeavy(doc);
    }
    viewer.cameraFromScene(doc.camera);
    viewer.setGrid($('#chkGrid').checked = false, 0);
    afterDocReplace();
    if (autoHidden.length) {
      /* sticky にして直後の非同期コンパイル完了 status に潰されないようにする
         (次の構造変更 = rebuild で自然に解除される)。ただし rebuild が
         uniform 超過の error sticky を立てていたらそちらが優先 (上書きすると
         「プレビュー不可の理由」を隠してしまう)。 */
      const total = autoHidden.reduce((a, l) => a + l.cost, 0);
      const msg = `読み込みました: ${fileName || '(テキスト)'} — 重いパーツ `
          + `${autoHidden.length}個 (${total.toLocaleString()}反復/サンプル) を`
          + `レイマーチ表示から自動除外しました。ツリーの◉で復帰できます`
          + ` (書き出し・メッシュ・sqmレンダには含まれます)`;
      if (!sticky || !sticky.err) sticky = { msg, err: false };
      setStatus(msg);
    } else {
      setStatus('読み込みました: ' + (fileName || '(テキスト)'));
    }
  } catch (e) {
    console.error(e);
    setStatus('読み込み失敗: ' + e.message, true);
  }
}

/* ── ペイン幅のリサイズ (スプリッタ) ──────────────────────── */
function initSplitters() {
  const saved = JSON.parse(localStorage.getItem('sdfmodeler.panes') || '{}');
  const setW = (v, px) => document.body.style.setProperty(v, px + 'px');
  if (saved.tree) setW('--treew', saved.tree);
  if (saved.insp) setW('--inspw', saved.insp);
  const save = () => {
    try {
      localStorage.setItem('sdfmodeler.panes', JSON.stringify({
        tree: $('#tree').getBoundingClientRect().width,
        insp: $('#inspector').getBoundingClientRect().width,
      }));
    } catch {}
  };
  const hook = (id, varName, min, max, fromRight) => {
    const el = $(id);
    let drag = null;
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const cur = fromRight ? $('#inspector').getBoundingClientRect().width
                            : $('#tree').getBoundingClientRect().width;
      drag = { x: e.clientX, w: cur };
    });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const w = Math.min(max, Math.max(min, drag.w + (fromRight ? -dx : dx)));
      setW(varName, w);
    });
    el.addEventListener('pointerup', () => { drag = null; el.classList.remove('dragging'); save(); });
    el.addEventListener('pointercancel', () => { drag = null; el.classList.remove('dragging'); });
    el.addEventListener('dblclick', () => {   /* ダブルクリックで既定幅に戻す */
      setW(varName, fromRight ? 300 : 270);
      save();
    });
  };
  hook('#sp1', '--treew', 150, 560, false);
  hook('#sp2', '--inspw', 220, 560, true);
}

/* ── 初期化 ───────────────────────────────────────────────── */
/* 黙って黒画面にならないよう、未捕捉エラーはステータスバーへ */
window.addEventListener('error', e => setStatus('エラー: ' + e.message, true));
window.addEventListener('unhandledrejection', e => setStatus('エラー: ' + (e.reason?.message || e.reason), true));

/* WebGL2 コンテキストが取得できない (GPUプロセスが死んでいる/復旧待ち等) 場合の
   復旧バナー。canvas/gl に依存しない素の DOM だけで組む — devtools を開かずに
   復帰できるようにする (2026-07-27: 重いモデル(招き猫の首輪)を SDF レイマーチの
   まま保存すると、次回起動時に sdfm_view='0' の復元で「起動時は既定メッシュ表示」の
   ガードを迂回していきなり重いレイマーチを描き、GPUが落ちて以後 getContext が
   null を返し続ける事故が実際に起きた)。 */
function showWebglRecovery(err) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;'
    + 'align-items:center;justify-content:center;background:#1a1a1aee;color:#eee;'
    + 'font:14px sans-serif;padding:24px;';
  box.innerHTML = `
    <div style="max-width:560px;background:#242424;border:1px solid #444;
                border-radius:8px;padding:20px 24px;line-height:1.6;">
      <h2 style="margin:0 0 8px;font-size:16px;">WebGL2 が利用できません</h2>
      <p style="margin:0 0 10px;">${err.message}</p>
      <p style="margin:0 0 14px;color:#bbb;">
        重いモデルのレイマーチ描画で GPU プロセスが落ち、まだ復旧していない可能性が
        あります。まずブラウザ本体を完全に終了して起動し直してください
        (タブを閉じるだけでは直らないことがあります)。それでも直らない場合は
        自動保存されたモデルが原因の可能性があるので、下のボタンで消せます
        (次回はサンプルの rabbit から起動します)。
      </p>
      <button id="wgRecoverClear" style="margin-right:8px;padding:8px 14px;
              cursor:pointer;">自動保存をクリアして再読み込み</button>
      <button id="wgRecoverReload" style="padding:8px 14px;cursor:pointer;">
              再読み込みのみ</button>
    </div>`;
  document.body.appendChild(box);
  box.querySelector('#wgRecoverClear').onclick = () => {
    try {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem('sdfm_view');   /* SDF復元で再度ガードを迂回しないよう */
    } catch {}
    location.reload();
  };
  box.querySelector('#wgRecoverReload').onclick = () => location.reload();
}

function init() {
  try {
    viewer = new Viewer($('#view'), {
    onPick: (idx, cx, cy) => {
      if (idx >= 0 && layout) {
        for (const [nid, i] of layout.indices) {
          if (i === idx) {
            for (let oi = 0; oi < doc.objects.length; oi++) {
              if (findNode(doc.objects[oi].root, nid)) { sel = { objIdx: oi, nodeId: nid }; break; }
            }
            onSelChange();
            return;
          }
        }
      }
      /* GPU ピック外れ (または blob) → CPU で可視楕円体レイキャスト。
         blob はレイマーチに出ないので GPU ピックには決して掛からない */
      if ((blobPicks.length || objPicks.length) && cx != null) {
        const { ro, rd } = viewer.rayFromScreen(cx, cy);
        const hb = blobPicks.length ? rayPickBlob(blobPicks, ro, rd) : null;
        const hm = objPicks.length ? rayPickObjMesh(objPicks, ro, rd) : null;
        const hit = (hb && hm) ? (hb.pickT <= hm.pickT ? hb : hm) : (hb || hm);
        if (hit) {
          if (pairArm != null && hit === hb && hit.node.id !== pairArm) {
            /* Pair 相手の確定: 鏡映軸 = pos 差が最大の軸 (ssq_edit と同じ自動判定) */
            const a = blobNodeById(pairArm);
            if (a && a.type === 'blob') {
              const d = a.props.center.map((v, i) => Math.abs(v - hit.node.props.center[i]));
              const axis = d.indexOf(Math.max(...d));
              blobPair = { selId: pairArm, partnerId: hit.node.id, axis,
                           ref: blobPropsCopy(a.props) };
              setStatus(`Pair 設定: 鏡映軸 ${'XYZ'[axis]} — 選択 blob への編集が相手に鏡映されます`);
            }
            pairArm = null;
            renderInspector();
            return;
          }
          sel = { objIdx: hit.objIdx, nodeId: hit.node.id };
          onSelChange();
        }
      }
    },
    onCameraChange: () => { doc.camera = viewer.getCamera(); autosave(); },
    onDraw: () => { if (boneOverlay) boneOverlay.update(); if (gizmo) gizmo.update(); },
    /* GPUハング等でコンテキストが失われても復旧して再構築 (メッシュはデータ保持
       から自動復元されるが、鮮度のため取り直しもかける) */
    onContextRestored: () => {
      setStatus('WebGL コンテキストを復旧しました — 再構築中…');
      rebuild();
      if (meshOn) refreshMesh();
    },
  });
  } catch (e) {
    console.error(e);
    showWebglRecovery(e);
    return;             /* viewer が無いので以降の初期化 (gizmo/doc復元/rebuild等) は行わない */
  }

  boneOverlay = new BoneOverlay($('#bones'), viewer, { getBones: collectBones });

  gizmo = new Gizmo($('#gizmo'), viewer, {
    getAnchor: mode => {
      const node = selectedNode();
      if (!node || !layout) return null;
      const obj = selectedObj();
      if (mode === 'rotate') {   /* リング中心 = 回転ターゲットの pivot */
        const t = peekRotateTarget(obj, node);
        if (t) return worldPoint(obj.root, t.id, t.props.pivot || [0, 0, 0]);
      }
      if (mode === 'scale') {   /* 関節/グループ選択時は最初のスケール可能リーフに委譲 */
        const t = scaleTargetFor(node);
        return t ? worldAnchor(obj.root, t.id) : null;
      }
      return worldAnchor(obj.root, node.id);
    },
    getScaleAxes: () => {
      const node = scaleTargetFor(selectedNode());
      if (!node) return [];
      const obj = selectedObj();
      return (scaleAxesFor(node) || []).map(d => localToWorldDelta(obj.root, node.id, d));
    },
    getPoints: () => {   /* sweep 選択時: 制御点のワールド座標列 (緑ドット) */
      const node = sweepPointsNode();
      if (!node) return null;
      const obj = selectedObj();
      const pts = node.props.points, out = [];
      for (let q = 0; q + 2 < pts.length; q += 3)
        out.push(worldPoint(obj.root, node.id, [pts[q], pts[q + 1], pts[q + 2]]));
      return out;
    },
    onStart: gizmoStart,
    onMove: gizmoMove,
    onEnd: gizmoEnd,
    onRotStart: gizmoRotStart,
    onRotMove: gizmoRotMove,
    onRotEnd: gizmoRotEnd,
    onPivotStart: gizmoPivotStart,
    onPivotMove: gizmoPivotMove,
    onPivotEnd: gizmoPivotEnd,
    onScaleStart: gizmoScaleStart,
    onScaleMove: gizmoScaleMove,
    onScaleEnd: gizmoScaleEnd,
    onPointStart: gizmoPointStart,
    onPointMove: gizmoPointMove,
    onPointEnd: gizmoPointEnd,
  });

  /* toolbar */
  $('#btnNew').onclick = () => {
    if (!confirm('新規シーンを作成します (現在の内容は破棄)。よろしいですか?')) return;
    snapshot();
    doc = defaultDoc();
    viewer.cameraFromScene(doc.camera);
    $('#chkGrid').checked = true;
    viewer.setGrid(true, 0);
    afterDocReplace();
  };
  const loadSample = async name => {
    try {
      const t = await (await fetch('examples/' + name)).text();
      importText(t, name);
    } catch (e) { setStatus('サンプル読込失敗 (http サーバ経由で開いてください): ' + e.message, true); }
  };
  /* ドロップダウンに examples の .ssq を追加 (既存の組込みサンプルは重複追加しない) */
  const addSampleOption = name => {
    const sel = $('#selSample');
    if ([...sel.options].some(o => o.value === name)) return;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.replace(/\.ssq$/, '') + ' (保存)';
    opt.dataset.user = '1';   /* ＋サンプル保存で作ったユーザー分 = Shift削除可 */
    sel.appendChild(opt);
  };
  /* 起動時に examples/ を走査してユーザー保存サンプルも一覧に出す (serve.py の /__examples__) */
  const refreshSampleList = async () => {
    try {
      const res = await fetch('/__examples__');
      if (res.ok) (await res.json()).forEach(addSampleOption);
    } catch { /* serve.py 以外で配信時は静かに無視 (組込み一覧のみ) */ }
  };
  refreshSampleList();
  /* examples/<name>.ssq を削除 (Shift+サンプル選択。要 serve.py) */
  const deleteSample = async name => {
    if (!confirm('examples/' + name + ' を削除しますか?')) return;
    try {
      const res = await fetch('/__delete__?name=' + encodeURIComponent(name), { method: 'POST' });
      if (!(res.headers.get('content-type') || '').includes('json'))
        throw new Error('サーバが未対応です。最新の serve.py を再起動して開き直してください (http.server や旧サーバでは不可)');
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '失敗');
      [...$('#selSample').options].forEach(o => { if (o.value === name) o.remove(); });
      setStatus('examples/' + name + ' を削除しました');
    } catch (e) {
      setStatus('削除失敗: ' + e.message, true);
    }
  };
  /* Shift の押下状態を追跡 (プルダウン選択時に削除モードか判定) */
  let sampleShift = false;
  window.addEventListener('keydown', e => { if (e.key === 'Shift') sampleShift = true; });
  window.addEventListener('keyup',   e => { if (e.key === 'Shift') sampleShift = false; });
  window.addEventListener('blur',    () => { sampleShift = false; });
  $('#selSample').onchange = e => {
    const val = e.target.value;
    const opt = [...e.target.options].find(o => o.value === val);
    const shift = sampleShift || e.shiftKey;
    e.target.selectedIndex = 0;  /* プレースホルダに戻す (同じサンプルの再選択を可能に) */
    if (!val) return;
    if (shift) {                  /* Shift+選択 = 削除 (ユーザー保存分のみ) */
      if (opt && opt.dataset.user === '1') deleteSample(val);
      else setStatus('組込みサンプルは削除できません (＋サンプル保存で作ったもののみ削除可)', true);
      return;
    }
    loadSample(val);
  };
  $('#fileOpen').onchange = async e => {
    const f = e.target.files[0];
    if (f) await openFile(f);
    e.target.value = '';
  };
  $('#btnExport').onclick = () => {
    doc.camera = viewer.getCamera();
    download((doc.objects[0]?.name || 'scene') + '.ssq', serializeScene(doc, doc.camera));
    if (lastExportWarnings.length)
      setStatus('.ssq 書き出し (注意: ' + lastExportWarnings.join(' / ') + ')', true);
    else
      setStatus('.ssq を書き出しました (sqm -i でレンダリング可能)');
  };
  /* 表示中のメッシュプロキシ (serve.py /__mesh__ の marching cubes 結果) を OBJ 書き出し。
     データは既に viewer._meshData に届いているのでサーバー往復は不要 = 表示そのままが出る。
     法線も marching cubes の勾配normalをそのまま vn に載せる (f は v//vn 形式)。 */
  $('#btnExportObj').onclick = () => {
    /* サーバ焼きメッシュ (object 単位) + WASM blob メッシュを結合して書き出す
       (blob だけのシーンでも OBJ が出る)。両方無ければエラー */
    const parts = [...(meshParts || []), viewer._blobData]
      .filter(p => p && p.verts && p.verts.length);
    if (!parts.length) { setStatus('メッシュがまだありません (メッシュ表示に切り替えてください)', true); return; }
    const t0 = performance.now();
    const { verts, normals, indices } = parts.length === 1 ? parts[0] : mergeMeshes(parts);
    const nv = verts.length / 3, nt = indices.length / 3;
    /* 数十万三角形になるので 1行1要素の配列に貯めて最後に join (文字列 += は O(n²)) */
    const out = [`# sdfmodeler mesh export (marching cubes, grid ${currentGrid()})`,
                 `# ${nv} verts / ${nt} tris`];
    for (let i = 0; i < nv; i++)
      out.push(`v ${verts[3*i].toFixed(5)} ${verts[3*i+1].toFixed(5)} ${verts[3*i+2].toFixed(5)}`);
    for (let i = 0; i < nv; i++)
      out.push(`vn ${normals[3*i].toFixed(5)} ${normals[3*i+1].toFixed(5)} ${normals[3*i+2].toFixed(5)}`);
    for (let i = 0; i < nt; i++) {   /* OBJ は 1-origin */
      const a = indices[3*i] + 1, b = indices[3*i+1] + 1, c = indices[3*i+2] + 1;
      out.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    const name = (doc.objects[0]?.name || 'model') + '.obj';
    download(name, out.join('\n') + '\n');
    setStatus(`${name} を書き出しました (${nt.toLocaleString()} tris / `
      + `${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  };
  $('#btnSaveJson').onclick = () => {
    doc.camera = viewer.getCamera();
    download('project.json', docToJSON(doc));
  };
  /* 現在のモデルを examples/ に保存 → サンプル一覧に追加 (serve.py の /__save__ が必要) */
  $('#btnSaveExample').onclick = async () => {
    const name = prompt('サンプル名 (examples/ に .ssq 保存):', doc.objects[0]?.name || 'model');
    if (!name) return;
    doc.camera = viewer.getCamera();
    const ssq = serializeScene(doc, doc.camera);
    try {
      const res = await fetch('/__save__?name=' + encodeURIComponent(name),
                              { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ssq });
      if (!(res.headers.get('content-type') || '').includes('json'))
        throw new Error('サーバが未対応です。最新の serve.py を再起動して開き直してください (http.server や旧サーバでは不可)');
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '失敗');
      addSampleOption(j.name);
      setStatus('examples/' + j.name + ' に保存 (サンプル一覧から読めます)');
    } catch (e) {
      setStatus('サンプル保存失敗: ' + e.message, true);
    }
  };
  /* sqm テストレンダリング: 現在のドキュメント+カメラを serve.py /__render__ へ POST →
     dist/sqm で本レンダした PNG をモーダル表示。プレビューの単色近似と本レンダの見た目
     (シェーダ/影/GI) の突き合わせ用。Shift+クリック=高品質 */
  $('#btnRender').onclick = ev => runSqmRender(ev.shiftKey ? 'hq' : 'draft');
  {   /* blob 再メッシュ解像度 (表示と ⬇OBJ の両方に効く)。選択は永続化 */
    const lv = $('#selBlobLv');
    try { const v = localStorage.getItem('sdfm_bloblv'); if (v) lv.value = v; } catch {}
    lv.onchange = () => {
      try { localStorage.setItem('sdfm_bloblv', lv.value); } catch {}
      refreshBlobMesh();
    };
  }
  $('#btnRenderSettings').onclick = openRenderTab;
  async function runSqmRender(q) {
    const btn = $('#btnRender');
    if (btn.disabled) return;
    doc.camera = viewer.getCamera();
    const ssq = serializeScene(doc, doc.camera);
    /* ビューポートのアスペクトに合わせる (レイアウト未確定で幅0のときは 3:2 に退避、
       極端な縦横比は [0.25, 2.5] にクランプ = サーバ側の上限とも整合) */
    const r = $('#view').getBoundingClientRect();
    const aspect = (r.width > 8 && r.height > 8)
      ? Math.min(2.5, Math.max(0.25, r.height / r.width)) : 2 / 3;
    const w = q === 'hq' ? 1000 : 640;
    const h = Math.max(64, Math.round(w * aspect));
    const label = q === 'hq' ? '高品質' : 'ドラフト';
    btn.disabled = true;
    const t0 = performance.now();
    setStatus(`sqm レンダリング中… (${w}×${h} ${label})`);
    try {
      const res = await fetch(`/__render__?w=${w}&h=${h}&q=${q}`,
                              { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: ssq });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const j = await res.json();
        throw new Error(j.error || 'レンダリング失敗');
      }
      if (!res.ok || !ct.includes('image'))
        throw new Error('サーバが未対応です。最新の serve.py を再起動して開き直してください');
      const blob = await res.blob();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      showRenderModal(URL.createObjectURL(blob), `sqm ${w}×${h} ${label} — ${secs}s`);
      setStatus(`sqm レンダリング完了 (${secs}s)`);
    } catch (e) {
      setStatus('sqm レンダ失敗: ' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }
  function showRenderModal(url, caption) {
    let m = document.getElementById('rendermodal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'rendermodal';
      m.onclick = e => { if (e.target === m) m.hidden = true; };   /* 背景クリックで閉じる */
      m.appendChild(document.createElement('div')).className = 'rbox';
      document.body.appendChild(m);
    }
    const box = m.querySelector('.rbox');
    box.innerHTML = '';
    const img = document.createElement('img');
    img.src = url;
    const bar = document.createElement('div');
    bar.className = 'rbar';
    const cap = document.createElement('span');
    cap.textContent = caption;
    bar.append(cap,
      button('PNG保存', () => {
        const a = document.createElement('a');
        a.href = url;
        a.download = (doc.objects[0]?.name || 'render') + '_sqm.png';
        a.click();
      }),
      button('閉じる', () => { m.hidden = true; }));
    box.append(img, bar);
    m.hidden = false;
  }

  /* 別 .ssq からモデル(オブジェクト)だけを現在のシーンに取り込む (カメラ/ライト/背景は維持) */
  $('#fileImportModel').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      if (f.name.toLowerCase().endsWith('.obj')) {
        /* 取り込み方は2択 (第8弾で mesh 一級ノードが入ったので選ばせる):
           - メッシュのまま置く = (mesh ..) ノード1個。三角形そのまま表示・
             transform 編集可。sqm レンダーも実三角形 (BVH)。CSG/融合には使えない
           - SDF グリッドに焼く = 従来 (obj2sdfgrid → (grid ..) リーフ)。
             CSG や smooth-union に混ぜられるが形は近似 */
        const asMesh = confirm('OBJ の取り込み方を選んでください。\n\n'
          + 'OK = メッシュのまま置く (三角形そのまま。移動/回転/スケール編集可)\n'
          + 'キャンセル = SDF グリッドに焼く (CSG・融合に使える近似)');
        if (asMesh) {
          setStatus(`OBJ を保存しています… (${f.name})`);
          const res = await fetch(
            `/__objupload__?name=${encodeURIComponent(f.name)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
              body: await f.arrayBuffer() });
          let j = null;
          try { j = await res.json(); } catch {}
          if (!res.ok || !j || !j.ok)
            throw new Error((j && j.error) || 'サーバが未対応 (serve.py を再起動してください)');
          snapshot();
          const name = f.name.replace(/\.obj$/i, '');
          const node = makeNode('mesh', { file: j.file });
          const startIdx = doc.objects.length;
          doc.objects.push({ name, visible: true, root: node,
                             surface: defaultDoc().objects[0].surface });
          sel = { objIdx: startIdx, nodeId: node.id };
          afterDocReplace();
          setStatus(`モデル取込: ${name} (メッシュのまま — 移動/回転/スケール編集可)`);
          return;
        }
        /* OBJ を SDF にする従来経路: serve.py 経由で tools/obj2sdfgrid.py に
           **符号付き距離場グリッド**として焼かせ、(grid (file ..)) リーフ1個として
           取り込む。三角形数に依存しない O(1) サンプル。
           (旧実装の楕円体近似は被覆率7割程度で形が別物だったため置き換えた) */
        const ans = prompt('OBJ を SDF グリッドに焼いて取り込みます。\n'
          + 'グリッド解像度 (最長軸のボクセル数。大きいほど忠実だがメモリを食う):', '128');
        if (ans === null) return;                 /* キャンセル */
        const gn = Math.max(32, Math.min(320, parseInt(ans, 10) || 128));
        setStatus(`OBJ を ${gn}³ の距離場に焼いています… (${f.name})`);
        const res = await fetch(
          `/__objimport__?grid=${gn}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: await f.arrayBuffer() });
        let j = null;
        try { j = await res.json(); } catch {}
        if (!res.ok || !j || !j.ok)
          throw new Error((j && j.error) || 'サーバが未対応 (serve.py 経由で開いていない可能性)');
        snapshot();
        const name = f.name.replace(/\.obj$/i, '');
        const node = makeNode('grid', { file: j.file, center: [0, 0, 0], scale: 1,
                                        size: j.size });
        const startIdx = doc.objects.length;
        doc.objects.push({ name, visible: true, root: node,
                           surface: defaultDoc().objects[0].surface });
        sel = { objIdx: startIdx, nodeId: node.id };
        afterDocReplace();
        setStatus(`モデル取込: ${name} (${gn}³ グリッド ${j.dims.join('x')})`);
        return;
      }
      const text = await f.text();
      const parsed = (f.name.endsWith('.json') || text.trimStart().startsWith('{'))
        ? docFromJSON(text) : parseScene(text);
      if (!parsed.objects || !parsed.objects.length) throw new Error('モデルが見つかりません');
      snapshot();
      const startIdx = doc.objects.length;
      doc.objects.push(...parsed.objects);        /* カメラ/ライト/背景は現状維持 */
      sel = { objIdx: startIdx, nodeId: null };
      afterDocReplace();
      setStatus('モデル取込: ' + parsed.objects.length + ' オブジェクト追加 (' + f.name + ')');
    } catch (err) {
      console.error(err);
      setStatus('モデル取込失敗: ' + err.message, true);
    }
  };
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#selQuality').onchange = e => viewer.setQuality(parseFloat(e.target.value));
  $('#chkGrid').onchange = e => viewer.setGrid(e.target.checked, 0);
  $('#chkAxis').onchange = e => viewer.setAxis(e.target.checked);
  $('#chkPart').onchange = e => {
    partColorOn = e.target.checked;
    viewer.setPartColor(partColorOn);
    renderTree();
  };
  $('#chkDepth').onchange = e => viewer.setDepth(e.target.checked);
  $('#chkGizmo').onchange = e => gizmo.setEnabled(e.target.checked);
  $('#selGizmoMode').onchange = e => gizmo.setMode(e.target.value);
  /* 表示セレクタ (SDF / メッシュ各精度) — 選択で表示モードを切替 (永続化) */
  $('#selView').onchange = applyViewMode;
  /* ボーンON = 重いモデルの編集中 → 影も自動OFF (静止時レンダも軽く)。OFFで元に戻す */
  let shadowBeforeBones = null;
  $('#chkBones').onchange = e => {
    const on = e.target.checked;
    boneOverlay.setEnabled(on);
    viewer.setBoneOnly(on);                 /* ON中のドラッグはレイマーチ停止 */
    const sh = $('#chkShadow');
    if (on) {
      shadowBeforeBones = sh.checked;
      if (sh.checked) { sh.checked = false; viewer.setShadow(false); rebuild(); }
    } else if (shadowBeforeBones != null) {
      const back = shadowBeforeBones;
      shadowBeforeBones = null;
      if (sh.checked !== back) { sh.checked = back; viewer.setShadow(back); rebuild(); }
    }
  };
  /* ボーン表示中に影を手動で入れ直したらその選択を記憶 (OFF復帰時に尊重) */
  $('#chkShadow').onchange = e => {
    viewer.setShadow(e.target.checked);
    if ($('#chkBones').checked) shadowBeforeBones = e.target.checked;
    rebuild();   /* 影は生成時フラグ → シェーダを作り直す (初回だけ待ちが入る) */
  };
  /* AO も同じ理由で生成時フラグ。OFF は接地部/付け根の陰りが浅くなる代わりに速い */
  $('#chkAO').onchange = () => rebuild();
  $('#btnSavePng').onclick = async () => {
    const blob = await viewer.snapshotPNG();
    if (!blob) { setStatus('PNG 生成に失敗しました', true); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (doc.objects[0]?.name || 'scene')
               + ($('#chkDepth').checked ? '_depth' : '') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus('ビューポートを PNG 保存しました: ' + a.download);
  };
  initQuickAdd();
  initSplitters();
  window.__sdfm = { viewer, gizmo, getDoc: () => doc };   /* コンソールデバッグ用 */
  /* 不具合診断: 黒化した瞬間にコンソールで __sdfm.diag() — スクショと内部状態を
     serve.py 経由で examples/diag_*.ssq に落とす (開発機のローカル解析用) */
  window.__sdfm.diag = async () => {
    try {
      const blob = await viewer.snapshotPNG();
      await fetch('/__save__?name=diag_shot_png', { method: 'POST', body: blob });
      const srcs = [...viewer._progCache.keys()];
      const cur = srcs[srcs.length - 1] || '';
      let nan = 0; for (const x of (viewer.params || [])) if (!Number.isFinite(x)) nan++;
      const info = {
        time: new Date().toISOString(),
        status: $('#status').textContent,
        compileMs: viewer.compileMs,
        interactive: viewer.interactive,
        matOn: viewer.matOn, partColor: viewer.partColor,
        paramsLen: viewer.params ? viewer.params.length : null,
        nanParams: nan,
        layout: layout ? { parCount: layout.parCount, subSphBase: layout.subSphBase,
                           order: layout.order.length, guards: (layout.guards || []).length } : null,
        selNode: (() => { const n = selectedNode(); return n ? { type: n.type, props: n.props } : null; })(),
        objects: doc.objects.map(o => ({ name: o.name, visible: o.visible,
                                         surf: surfaceColor(o.surface) })),
        smwStats: window.__smwStats || null,
        meshParts: (viewer._meshPartsData || []).map((p, i) => {
          if (!p) return null;
          const st = a => { if (!a) return null;
            let s = [0, 0, 0], mn = [9e9, 9e9, 9e9], mx = [-9e9, -9e9, -9e9], n = a.length / 3;
            for (let k = 0; k < a.length; k += 3) for (let j = 0; j < 3; j++) {
              const x = a[k + j]; s[j] += x; if (x < mn[j]) mn[j] = x; if (x > mx[j]) mx[j] = x; }
            return { mean: s.map(x => +(x / n).toFixed(3)), min: mn.map(x => +x.toFixed(3)),
                     max: mx.map(x => +x.toFixed(3)) }; };
          return { i, nv: p.verts ? p.verts.length / 3 : 0,
                   colType: p.colors ? p.colors.constructor.name : null,
                   colHead: p.colors ? [...p.colors.slice(0, 9)].map(x => +(+x).toFixed(3)) : null,
                   col: st(p.colors), nrm: st(p.normals) };
        }),
        progTail: cur.slice(cur.indexOf('float sdObj'), cur.indexOf('float sdObj') + 4000),
      };
      await fetch('/__save__?name=diag_info_json', { method: 'POST',
        body: JSON.stringify(info, null, 1) });
      setStatus('診断データを保存しました (diag_shot_png / diag_info_json)');
      return 'ok';
    } catch (e) { console.error(e); return 'diag failed: ' + e.message; }
  };

  /* W/E/R = ギズモを移動/回転/スケールモードに (OFF時はONにして切替) */
  const setGizmoMode = m => {
    $('#selGizmoMode').value = m;
    if (!$('#chkGizmo').checked) { $('#chkGizmo').checked = true; gizmo.setEnabled(true); }
    gizmo.setMode(m);
    if (m === 'scale') {
      const node = selectedNode();
      if (!node) setStatus('スケール: パーツを選択してください');
      else if (!scaleTargetFor(node)) setStatus('スケール対象のプリミティブがありません');
    }
  };

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key.startsWith('Arrow') && handleArrowKey(e)) return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'w' || e.key === 'W')) { setGizmoMode('move'); return; }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'e' || e.key === 'E')) { setGizmoMode('rotate'); return; }
    if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'r' || e.key === 'R')) { setGizmoMode('scale'); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      const node = selectedNode();
      if (node) deleteNode(selectedObj(), node);
    }
  });

  /* 復元 or 初期シーン (自動保存が無ければサンプルの rabbit を表示) */
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try { doc = docFromJSON(saved); } catch { doc = defaultDoc(); }
  } else {
    loadSample('rabbit.ssq');  /* 非同期。失敗時 (file:// 直開き等) は既定シーンのまま */
  }
  viewer.cameraFromScene(doc.camera);
  viewer.setGrid($('#chkGrid').checked, 0);
  viewer.setAxis($('#chkAxis').checked);
  viewer.setShadow($('#chkShadow').checked);
  viewer.setQuality(parseFloat($('#selQuality').value));
  /* 表示モード決定 (rebuild より前 = 最初の描画からメッシュ経路に乗せ、重量モデルの
     レイマーチ初回描画=GPUハング原因を踏まない)。前回選択を復元、無ければ既定
     「メッシュ標準」(起動時メッシュ)。失敗時は refreshMesh 内で SDF に自動フォールバック */
  const savedView = localStorage.getItem('sdfm_view');
  if (savedView != null && [...$('#selView').options].some(o => o.value === savedView))
    $('#selView').value = savedView;
  meshOn = currentGrid() >= 100;
  viewer.setMeshProxy(meshOn);
  if (meshOn) refreshMesh();
  rebuild();
  renderTree();
  renderInspector();
}

init();
