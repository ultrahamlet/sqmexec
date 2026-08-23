/* app.js — sqm レンダリング設定タブ。sdfmodeler とは別アプリ・同一オリジン。
 * BroadcastChannel 'sqm-render' で sdfmodeler から現在のシーン(.ssq)を取り寄せ、
 * ここで設定したパラメータと共に serve.py /__render__ へ POST → PNG を表示する。
 * パラメータは localStorage に自動保存 (リロードで復元)、JSON 書き出し/読み込みも可。 */

const $ = s => document.querySelector(s);
const LS_KEY = 'sqm-render-params';

/* パラメータ定義 (UI 生成 + 既定値 + サーバー側ホワイトリストと対応) */
const SCHEMA = [
  { group: '基本', fields: [
    { key: 'width',  label: '幅 (px)',   type: 'int', def: 800, min: 16, max: 4096 },
    { key: 'height', label: '高さ (px)', type: 'int', def: 600, min: 16, max: 4096 },
    { key: 'aa',     label: 'アンチエイリアス (-A)', type: 'int', def: 2, min: 1, max: 8 },
    { key: 'shadow', label: '影 (0=無 1=硬 2+=ソフト)', type: 'int', def: 1, min: 0, max: 32 },
    { key: 'depth',  label: '再帰深度 反射/屈折 (-D)', type: 'int', def: 2, min: 0, max: 12 },
  ]},
  { group: '照明 (GI / AO)', fields: [
    { key: 'gi',      label: '擬似GI/AO (-O)', type: 'int', def: 0, min: 0, max: 64 },
    { key: 'colorGi', label: 'カラーGI 色移り (-g)', type: 'int', def: 0, min: 0, max: 64 },
  ]},
  { group: 'トーンマッピング (-T)', fields: [
    { key: 'tonemap',  label: '方式', type: 'enum', def: '',
      options: [['なし', ''], ['reinhard', 'reinhard'], ['reinhard2', 'reinhard2'], ['aces', 'aces'], ['filmic', 'filmic']] },
    { key: 'exposure', label: '露出', type: 'num', def: 1.0, min: 0.01, max: 100, dep: 'tonemap' },
    { key: 'gamma',    label: 'ガンマ', type: 'num', def: 1.0, min: 0.1, max: 4, dep: 'tonemap' },
  ]},
  { group: '後処理', fields: [
    { key: 'fresnel',        label: 'フレネル反射 (-R)', type: 'bool', def: false },
    { key: 'dofOn',          label: '被写界深度 (-P)', type: 'bool', def: false },
    { key: 'dofAperture',    label: 'レンズ半径', type: 'num', def: 0.1, min: 0, max: 5, dep: 'dofOn' },
    { key: 'dofFocus',       label: 'ピント距離 (0=注視点)', type: 'num', def: 0, min: 0, max: 1000, dep: 'dofOn' },
    { key: 'bloomOn',        label: 'ブルーム (-B)', type: 'bool', def: false },
    { key: 'bloomThresh',    label: '閾値', type: 'num', def: 1.0, min: 0, max: 100, dep: 'bloomOn' },
    { key: 'bloomIntensity', label: '強度', type: 'num', def: 0.6, min: 0, max: 10, dep: 'bloomOn' },
    { key: 'bloomRadius',    label: '半径', type: 'num', def: 16, min: 1, max: 128, dep: 'bloomOn' },
    { key: 'lensOn',         label: 'レンズ 色収差+周辺減光 (-L)', type: 'bool', def: false },
    { key: 'lensCa',         label: '色収差', type: 'num', def: 2.0, min: 0, max: 20, dep: 'lensOn' },
    { key: 'lensVignette',   label: '周辺減光', type: 'num', def: 0.4, min: 0, max: 1, dep: 'lensOn' },
    { key: 'fogOn',          label: '深度フォグ (-G)', type: 'bool', def: false },
    { key: 'fogDist',        label: '距離', type: 'num', def: 20, min: 0.1, max: 1000, dep: 'fogOn' },
  ]},
  { group: '詳細', fields: [
    { key: 'dispersion', label: '色分散 (-c, 0=無)', type: 'num', def: 0, min: 0, max: 1 },
    { key: 'shadowSeps', label: '接地影 seps (0=既定)', type: 'num', def: 0, min: 0, max: 1 },
  ]},
];
const ALL_FIELDS = SCHEMA.flatMap(g => g.fields);

const PRESETS = {
  draft:    { width: 640, height: 480, aa: 1, shadow: 1, depth: 2, gi: 0, tonemap: '' },
  standard: { width: 900, height: 600, aa: 2, shadow: 2, depth: 2, gi: 8, tonemap: 'aces' },
  high:     { width: 1400, height: 900, aa: 3, shadow: 2, depth: 3, gi: 12, tonemap: 'aces', bloomOn: true },
};

/* ── 状態 ── */
let params = defaults();
function defaults() { const o = {}; for (const f of ALL_FIELDS) o[f.key] = f.def; return o; }
function load() {
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && typeof s === 'object') Object.assign(params, s); } catch {}
}
function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(params)); } catch {} }

/* ── UI 生成 ── */
function buildUI() {
  const box = $('#panel');
  box.innerHTML = '';
  for (const g of SCHEMA) {
    const h = document.createElement('h4'); h.textContent = g.group; box.appendChild(h);
    for (const f of g.fields) {
      const row = document.createElement('div'); row.className = 'frow';
      const lb = document.createElement('label'); lb.textContent = f.label; row.appendChild(lb);
      let inp;
      if (f.type === 'bool') {
        inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!params[f.key];
        inp.onchange = () => { params[f.key] = inp.checked; save(); refreshDisabled(); };
      } else if (f.type === 'enum') {
        inp = document.createElement('select');
        for (const [lbl, v] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = lbl; if (params[f.key] === v) o.selected = true; inp.appendChild(o); }
        inp.onchange = () => { params[f.key] = inp.value; save(); refreshDisabled(); };
      } else {
        inp = document.createElement('input'); inp.type = 'number';
        inp.step = f.type === 'int' ? 1 : (f.max <= 2 ? 0.01 : 0.1);
        inp.value = params[f.key];
        inp.oninput = () => {
          let v = parseFloat(inp.value); if (isNaN(v)) v = f.def;
          v = Math.max(f.min, Math.min(f.max, v)); if (f.type === 'int') v = Math.round(v);
          params[f.key] = v; save();
        };
      }
      inp.dataset.key = f.key;
      if (f.dep) inp.dataset.dep = f.dep;
      row.appendChild(inp);
      box.appendChild(row);
    }
  }
  refreshDisabled();
}
/* dep 付きフィールドは親が無効なら淡色化 */
function refreshDisabled() {
  for (const el of document.querySelectorAll('[data-dep]')) {
    const dep = el.dataset.dep;
    const on = dep === 'tonemap' ? !!params.tonemap : !!params[dep];
    el.closest('.frow').style.opacity = on ? 1 : 0.4;
    el.disabled = !on;
  }
}
function applyPreset(name) {
  params = defaults();
  Object.assign(params, PRESETS[name] || {});
  save(); buildUI();
  setStatus('プリセット: ' + name);
}

/* ── シーンの取り寄せ (sdfmodeler と BroadcastChannel) ── */
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('sqm-render') : null;
let sceneWaiters = new Map();   /* reqId → resolve */
if (bc) bc.onmessage = ev => {
  const m = ev.data;
  if (m && m.type === 'scene' && sceneWaiters.has(m.reqId)) {
    const r = sceneWaiters.get(m.reqId); sceneWaiters.delete(m.reqId); r(m);
  }
};
let fileScene = null;   /* ファイルから読み込んだ .ssq (sdfmodeler が無いとき) */
function requestScene() {
  return new Promise(resolve => {
    if (!bc) return resolve(fileScene ? { ssq: fileScene } : null);
    const reqId = Math.random().toString(36).slice(2);
    sceneWaiters.set(reqId, resolve);
    bc.postMessage({ type: 'scene-request', reqId });
    setTimeout(() => { if (sceneWaiters.has(reqId)) { sceneWaiters.delete(reqId); resolve(fileScene ? { ssq: fileScene } : null); } }, 700);
  });
}

/* ── レンダリング ── */
let rendering = false;
async function render() {
  if (rendering) return;
  const sc = await requestScene();
  if (!sc || !sc.ssq) {
    setStatus('シーンが取得できません — sdfmodeler タブを同じポートで開くか、.ssq を読み込んでください', true);
    return;
  }
  rendering = true;
  $('#btnRender').disabled = true;
  const t0 = performance.now();
  setStatus(`レンダリング中… (${params.width}×${params.height})`);
  try {
    const res = await fetch('/__render__', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssq: sc.ssq, params }) });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) { const j = await res.json(); throw new Error(j.error || 'レンダリング失敗'); }
    if (!res.ok || !ct.includes('image')) throw new Error('サーバー未対応 — 最新の serve.py を再起動してください');
    const blob = await res.blob();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const url = URL.createObjectURL(blob);
    const img = $('#result'); img.src = url; img.style.display = 'block';   /* '' だと CSS の none が効く */
    $('#placeholder').style.display = 'none';
    $('#btnSavePng').onclick = () => { const a = document.createElement('a'); a.href = url; a.download = 'sqm_render.png'; a.click(); };
    $('#btnSavePng').disabled = false;
    setStatus(`完了 (${secs}s, ${params.width}×${params.height})`);
  } catch (e) {
    setStatus('レンダ失敗: ' + e.message, true);
  } finally {
    rendering = false; $('#btnRender').disabled = false;
  }
}

function setStatus(msg, err) { const el = $('#status'); el.textContent = msg; el.classList.toggle('err', !!err); }

/* ── パラメータ JSON 保存/読み込み ── */
function exportParams() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' }));
  a.download = 'sqm_render_params.json'; a.click();
}
function importParams(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try { const s = JSON.parse(rd.result); params = defaults(); Object.assign(params, s); save(); buildUI(); setStatus('パラメータを読み込みました'); }
    catch (e) { setStatus('JSON 読み込み失敗: ' + e.message, true); }
  };
  rd.readAsText(file);
}

/* ── 配線 ── */
load();
buildUI();
$('#btnRender').onclick = render;
$('#btnSavePng').disabled = true;
$('#preset_draft').onclick = () => applyPreset('draft');
$('#preset_standard').onclick = () => applyPreset('standard');
$('#preset_high').onclick = () => applyPreset('high');
$('#btnReset').onclick = () => { params = defaults(); save(); buildUI(); setStatus('既定値に戻しました'); };
$('#btnExport').onclick = exportParams;
$('#fileImport').onchange = e => { if (e.target.files[0]) importParams(e.target.files[0]); e.target.value = ''; };
$('#fileScene').onchange = e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  f.text().then(t => { fileScene = t; setStatus('シーン読み込み: ' + f.name + ' (sdfmodeler が無くてもこれをレンダ)'); });
};
setStatus(bc ? 'sdfmodeler の現在シーンをレンダします (別タブで開いた場合は .ssq を読み込み)' : 'BroadcastChannel 非対応');
