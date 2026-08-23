/* app.js — 2Dプロファイルエディタ。sweep断面 / lathe輪郭 / extrude輪郭 の (profile ...) を
 * キャンバス上で編集して書き出す。sdfmodeler とは別アプリだが同一オリジンで、BroadcastChannel
 * 'sqm-profile' で編集結果を送る (受信側の配線は後日)。単体でも動く (file配信前提)。
 *
 * 座標: ワールドは y-up。キャンバスはピクセル (y は上下反転)。mode で意味が変わる:
 *   sweep   = 断面 (u,v) 自由・閉ポリゴン / 書き出し (profile|profile-spline|profile-bspline)
 *   lathe   = 輪郭 (r,y) r>=0 半平面・軸線表示 / 書き出し (profile|spline|bspline)
 *   extrude = 輪郭 (x,y) 自由・閉ポリゴン / 書き出し lathe と同じキーワード
 */
import { fmt } from '../sexpr.js';
import { densify } from './curve.js';

const $ = s => document.querySelector(s);

/* ── 状態 ── */
const state = {
  points: [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]],
  curve: 0,           /* 0=折れ線 1=spline 2=bspline */
  closed: true,
  mode: 'sweep',      /* sweep | lathe | extrude */
  steps: 12,
  incomingId: null,   /* sdfmodeler から渡されたノードID (往復用) */
};
let sel = -1;         /* 選択中の点 index */

/* ── ビュー (ワールド↔スクリーン) ── */
const view = { cx: 0, cy: 0, scale: 380 };   /* scale = px / ワールド単位 */
const canvas = $('#cv');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  W = r.width; H = r.height;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  draw();
}
const w2s = p => [W / 2 + (p[0] - view.cx) * view.scale, H / 2 - (p[1] - view.cy) * view.scale];
const s2w = (sx, sy) => [view.cx + (sx - W / 2) / view.scale, view.cy - (sy - H / 2) / view.scale];

/* ── mode 制約 ── */
function constrain(p) {
  if (state.mode === 'lathe' && p[0] < 0) p[0] = 0;   /* r>=0 半平面 */
  return p;
}

/* ── 描画 ── */
function draw() {
  ctx.clearRect(0, 0, W, H);
  drawGrid();
  drawCurve();
  drawPoints();
}
function drawGrid() {
  const cssv = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const line = cssv('--line') || '#333845', dim = cssv('--dim') || '#8a90a0';
  /* グリッド線 (0.1 単位) */
  const step = 0.1;
  const [wx0, wy1] = s2w(0, 0), [wx1, wy0] = s2w(W, H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = line;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
    const s = w2s([x, 0]); ctx.moveTo(s[0], 0); ctx.lineTo(s[0], H);
  }
  for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
    const s = w2s([0, y]); ctx.moveTo(0, s[1]); ctx.lineTo(W, s[1]);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  /* 軸 */
  const ox = w2s([0, 0]);
  ctx.strokeStyle = dim;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (state.mode === 'lathe') {
    /* 回転軸 (r=0) を強調 */
    ctx.moveTo(ox[0], 0); ctx.lineTo(ox[0], H);
    ctx.stroke();
    ctx.save();
    ctx.strokeStyle = cssv('--acc') || '#e8973a';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ox[0], 0); ctx.lineTo(ox[0], H); ctx.stroke();
    ctx.restore();
  } else {
    ctx.moveTo(ox[0], 0); ctx.lineTo(ox[0], H);
    ctx.moveTo(0, ox[1]); ctx.lineTo(W, ox[1]);
    ctx.stroke();
  }
}
function drawCurve() {
  const cssv = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const acc = cssv('--acc') || '#e8973a';
  const dense = densify(state.points, state.curve, state.closed, state.steps);
  if (dense.length < 2) return;
  /* 塗り (閉じているとき) */
  ctx.beginPath();
  dense.forEach((p, i) => { const s = w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
  if (state.closed) ctx.closePath();
  if (state.closed) { ctx.fillStyle = acc + '22'; ctx.fill(); }
  ctx.strokeStyle = acc; ctx.lineWidth = 2; ctx.stroke();
  /* lathe: 回転で得られるシルエットのヒント (軸で鏡映) */
  if (state.mode === 'lathe') {
    const ox = w2s([0, 0])[0];
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    dense.forEach((p, i) => { const s = w2s(p); const x = 2 * ox - s[0]; i ? ctx.lineTo(x, s[1]) : ctx.moveTo(x, s[1]); });
    if (state.closed) ctx.closePath();
    ctx.strokeStyle = acc; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }
  /* 制御点を結ぶ薄い折れ線 (spline時の骨組み) */
  if (state.curve >= 1) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = cssv('--dim') || '#8a90a0';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    state.points.forEach((p, i) => { const s = w2s(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
    if (state.closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
function drawPoints() {
  state.points.forEach((p, i) => {
    const s = w2s(p);
    ctx.beginPath();
    ctx.arc(s[0], s[1], i === sel ? 7 : 5, 0, 7);
    ctx.fillStyle = i === sel ? '#aff5b4' : '#7ce38b';
    ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#0009'; ctx.stroke();
    /* index ラベル */
    ctx.fillStyle = '#0009'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), s[0], s[1] - 9);
  });
}

/* ── ヒットテスト ── */
function hitPoint(sx, sy) {
  for (let i = 0; i < state.points.length; i++) {
    const s = w2s(state.points[i]);
    if ((s[0] - sx) ** 2 + (s[1] - sy) ** 2 <= 100) return i;   /* 10px */
  }
  return -1;
}
/* 最近接エッジ (挿入用)。返り: {seg, dist(px)} */
function nearestEdge(sx, sy) {
  const n = state.points.length;
  const nseg = state.closed ? n : n - 1;
  let best = { seg: -1, dist: 1e9 };
  for (let i = 0; i < nseg; i++) {
    const a = w2s(state.points[i]), b = w2s(state.points[(i + 1) % n]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    let t = ((sx - a[0]) * dx + (sy - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + dx * t, py = a[1] + dy * t;
    const d = Math.hypot(sx - px, sy - py);
    if (d < best.dist) best = { seg: i, dist: d };
  }
  return best;
}

/* ── 入力 ── */
let dragging = false, panning = false, panStart = null;
canvas.addEventListener('pointerdown', e => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (e.button === 1 || e.button === 2 || e.spaceKey) {   /* パン */
    panning = true; panStart = { sx, sy, cx: view.cx, cy: view.cy };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  const hit = hitPoint(sx, sy);
  if (hit >= 0) { sel = hit; dragging = true; }
  else {
    /* エッジの近くならその上に挿入、遠ければ末尾に追加 */
    const ne = nearestEdge(sx, sy);
    const w = constrain(s2w(sx, sy));
    if (ne.seg >= 0 && ne.dist < 12) {
      state.points.splice(ne.seg + 1, 0, w); sel = ne.seg + 1;
    } else {
      state.points.push(w); sel = state.points.length - 1;
    }
    dragging = true;
    onChange();
  }
  canvas.setPointerCapture(e.pointerId);
  draw(); syncSel();
});
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  if (panning) {
    view.cx = panStart.cx - (sx - panStart.sx) / view.scale;
    view.cy = panStart.cy + (sy - panStart.sy) / view.scale;
    draw(); return;
  }
  if (dragging && sel >= 0) {
    let w = s2w(sx, sy);
    if (e.shiftKey) w = [Math.round(w[0] / 0.05) * 0.05, Math.round(w[1] / 0.05) * 0.05];   /* 0.05 スナップ */
    state.points[sel] = constrain(w);
    onChange(); syncSel();
  }
});
canvas.addEventListener('pointerup', () => { dragging = false; panning = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());   /* 右クリックはパン用 */
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const before = s2w(sx, sy);
  view.scale *= Math.exp(-e.deltaY * 0.001);
  view.scale = Math.max(40, Math.min(4000, view.scale));
  const after = s2w(sx, sy);
  view.cx += before[0] - after[0]; view.cy += before[1] - after[1];   /* カーソル位置を固定 */
  draw();
}, { passive: false });

window.addEventListener('keydown', e => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0 && state.points.length > 3) {
    state.points.splice(sel, 1); sel = -1; onChange(); draw(); syncSel();
  }
});

/* ── 書き出し ── */
function curveKw() {
  return state.mode === 'sweep'
    ? ['profile', 'profile-spline', 'profile-bspline'][state.curve]
    : ['profile', 'spline', 'bspline'][state.curve];   /* lathe / extrude */
}
function exportClause() {
  const nums = state.points.flatMap(p => [fmt(p[0]), fmt(p[1])]);
  return `(${curveKw()} ${nums.join(' ')})`;
}
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sqm-profile') : null;
/* 適用の受信確認 (ACK)。sdfmodeler 側が受信すると profile-ack を返す。
   返ってこない = タブが無い/別ポート(オリジン違い)/古いタブ — を明示する */
let ackTimer = null;
if (bc) bc.onmessage = ev => {
  const m = ev.data;
  if (!m || m.type !== 'profile-ack') return;
  clearTimeout(ackTimer); ackTimer = null;
  setStatus(m.ok ? `sdfmodeler に適用されました (${m.msg || ''})` : 'sdfmodeler 側: ' + (m.msg || '適用先なし'), !m.ok);
};
/* 編集中はローカル描画+書き出し欄の更新のみ。送信は「sdfmodeler へ適用」ボタンで明示的に
   (毎編集で送ると受信側がそのたびシェーダ再構築して重いため) */
function onChange() {
  $('#out').value = exportClause();
  draw();
}
function sendToModeler() {
  if (!bc) return false;
  bc.postMessage({ type: 'profile', id: state.incomingId, mode: state.mode,
                   curve: state.curve, closed: state.closed, points: state.points });
  return true;
}

/* ── インスペクタ (点の数値行) ── */
function syncSel() {
  const box = $('#ptlist');
  box.innerHTML = '';
  state.points.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'ptrow' + (i === sel ? ' sel' : '');
    const mk = (idx) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.01'; inp.value = +p[idx].toFixed(4);
      inp.oninput = () => { p[idx] = parseFloat(inp.value) || 0; constrain(p); onChange(); };
      return inp;
    };
    const lbl = document.createElement('span');
    lbl.textContent = (i + 1) + ':';
    row.append(lbl, mk(0), mk(1));
    row.onclick = ev => { if (ev.target.tagName !== 'INPUT') { sel = i; draw(); syncSel(); } };
    box.appendChild(row);
  });
}

/* ── mode 別プリセット (断面/輪郭) ──
   各プリセットは pts のほか curve(0折れ線/1spline/2bspline)・closed も持つ。
   sweep/extrude = 閉ポリゴン断面 / lathe = (r,y) 開輪郭 (回転体は spline 開曲線が定石)。 */
const PRESETS = {
  sweep: {
    square: { label: '□ 四角', curve: 0, closed: true,
              pts: [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]] },
    L:      { label: 'L字', curve: 0, closed: true,
              pts: [[-0.1, -0.1], [0.1, -0.1], [0.1, 0], [0, 0], [0, 0.1], [-0.1, 0.1]] },
    star:   { label: '★ 星', curve: 0, closed: true,
              pts: [[0, 0.3], [-0.09, 0.09], [-0.3, 0.09], [-0.14, -0.05], [-0.19, -0.26],
                    [0, -0.12], [0.19, -0.26], [0.14, -0.05], [0.3, 0.09], [0.09, 0.09]] },
  },
  lathe: {
    /* 古代土器の壺 (ancient_jar.ssq と同一輪郭)。底→高台→胴→肩→頸→外反口縁。
       開シェル(thick)前提の (r,y) 開曲線。膨らみ/くびれを変えて器類の雛形に。 */
    jar:    { label: '壺 (古代土器)', curve: 1, closed: false,
              pts: [[0.00, 0.04], [0.26, 0.02], [0.32, 0.13], [0.48, 0.33], [0.60, 0.60],
                    [0.57, 0.82], [0.42, 0.99], [0.31, 1.10], [0.31, 1.19], [0.40, 1.30], [0.43, 1.35]] },
  },
};
PRESETS.extrude = PRESETS.sweep;   /* extrude も閉ポリゴン断面 */

/* ── ツールバー配線 ── */
function initUI() {
  $('#selMode').onchange = e => { state.mode = e.target.value; document.body.dataset.mode = state.mode; renderPresets(); onChange(); };
  $('#selCurve').onchange = e => { state.curve = +e.target.value; onChange(); };
  $('#chkClosed').onchange = e => { state.closed = e.target.checked; onChange(); };
  $('#btnFit').onclick = fitView;
  $('#btnCopy').onclick = () => { navigator.clipboard?.writeText($('#out').value); setStatus('コピーしました'); };
  $('#btnApply').onclick = () => {
    if (!sendToModeler()) { setStatus('BroadcastChannel 非対応ブラウザ', true); return; }
    setStatus('sdfmodeler へ送信中…');
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      setStatus('sdfmodeler が受信していません — 同じ URL (同じポート) で開いた sdfmodeler タブを' +
                'リロードしてから、掃引チューブの「✎ 断面を編集」で開き直してください', true);
    }, 600);
  };
  renderPresets();
}

/* 現在の mode に応じたプリセットボタンを描き直す */
function renderPresets() {
  const box = $('#presets');
  if (!box) return;
  box.innerHTML = '';
  const set = PRESETS[state.mode] || {};
  for (const k of Object.keys(set)) {
    const p = set[k];
    const btn = document.createElement('button');
    btn.textContent = p.label;
    btn.onclick = () => {
      state.points = p.pts.map(q => q.slice());
      state.curve = p.curve; state.closed = p.closed;
      $('#selCurve').value = String(p.curve);
      $('#chkClosed').checked = p.closed;
      sel = -1; fitView(); onChange(); syncSel();
    };
    box.appendChild(btn);
  }
}
function fitView() {
  if (!state.points.length) return;
  let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
  for (const p of state.points) { mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); }
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
  const span = Math.max(mxx - mnx, mxy - mny, 0.1) * 1.6;
  view.cx = cx; view.cy = cy;
  view.scale = Math.min(W, H) / span;
  draw();
}
function setStatus(msg, err) {
  const el = $('#status'); el.textContent = msg; el.classList.toggle('err', !!err);
}

/* ── 起動: hash から初期値 (sdfmodeler が開くとき #mode=..&curve=..&closed=..&id=..&pts=u,v,..) ── */
function parseHash() {
  const q = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (q.has('mode')) state.mode = q.get('mode');
  if (q.has('curve')) state.curve = +q.get('curve');
  if (q.has('closed')) state.closed = q.get('closed') !== '0';
  if (q.has('id')) state.incomingId = q.get('id');
  if (q.has('pts')) {
    const a = q.get('pts').split(',').map(Number);
    const pts = [];
    for (let i = 0; i + 1 < a.length; i += 2) pts.push([a[i], a[i + 1]]);
    if (pts.length >= 3) state.points = pts;
  }
}

parseHash();
document.body.dataset.mode = state.mode;
$('#selMode').value = state.mode;
$('#selCurve').value = String(state.curve);
$('#chkClosed').checked = state.closed;
initUI();
new ResizeObserver(resize).observe(canvas);
resize();
fitView();
onChange();
syncSel();
