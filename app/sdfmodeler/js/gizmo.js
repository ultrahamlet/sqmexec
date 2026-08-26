/* gizmo.js — ビューポート移動/回転ギズモ (SVG オーバーレイ)。
 * 移動モード: XYZ 矢印 + 3枚の平面ハンドル + 中央円 (ビュー平面移動) →
 *   ドラッグでワールド空間の移動量を onMove に渡す。
 * 回転モード: ワールド軸まわりの3リング → ドラッグで軸と角度を onRotMove に渡す
 *   (リング中心 = getAnchor('rotate') が返す pivot)。
 * 描画はワールド軸固定 (global gizmo)。座標変換は viewer.project / rayFromScreen。 */

const AXES = [
  { dir: [1, 0, 0], color: '#e5534b' },   /* X */
  { dir: [0, 1, 0], color: '#57ab5a' },   /* Y */
  { dir: [0, 0, 1], color: '#539bf5' },   /* Z */
];
const PIX_LEN = 78;        /* 矢印の画面長 (px) */
const PLANE_LO = 0.34, PLANE_HI = 0.60;   /* 平面ハンドルの位置 (軸長比) */
const RING_PIX = 84;       /* リング半径 (px) */
const RING_SEGS = 48;

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export class Gizmo {
  /* hooks: getAnchor(mode) → [x,y,z]|null
   *        onStart() → bool / onMove(dWorld, ev) / onEnd()                (移動)
   *        onRotStart() → bool / onRotMove(axisWorld, rad, ev) / onRotEnd() (回転)
   *        getPoints() → [[x,y,z]..]|null (sweep 等の制御点。移動モードでドット表示) /
   *        onPointStart(idx) → bool / onPointMove(idx, dWorld, ev) / onPointEnd() */
  constructor(svg, viewer, hooks) {
    this.svg = svg;
    this.viewer = viewer;
    this.hooks = hooks;
    this.enabled = true;
    this.mode = 'move';
    this.drag = null;
    this._build();
  }

  _el(tag, attrs, parent = this.svg) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e);
    return e;
  }

  _build() {
    this.parts = { axes: [], planes: [] };
    /* 平面ハンドル (軸の下に敷く): i = 法線軸 index */
    for (let i = 0; i < 3; i++) {
      const poly = this._el('polygon', {
        fill: AXES[i].color, 'fill-opacity': 0.28,
        stroke: AXES[i].color, 'stroke-opacity': 0.7, 'stroke-width': 1,
        class: 'ghandle',
      });
      poly.dataset.mode = 'plane' + i;
      this.parts.planes.push(poly);
    }
    for (let i = 0; i < 3; i++) {
      const g = { };
      g.line = this._el('line', { stroke: AXES[i].color, 'stroke-width': 2.5, 'stroke-linecap': 'round' });
      g.head = this._el('polygon', { fill: AXES[i].color });
      g.hit = this._el('line', {
        stroke: '#fff', 'stroke-opacity': 0, 'stroke-width': 14,
        'stroke-linecap': 'round', class: 'ghandle',
      });
      g.hit.dataset.mode = 'axis' + i;
      this.parts.axes.push(g);
    }
    this.parts.center = this._el('circle', {
      r: 7, fill: '#ffffff30', stroke: '#fff', 'stroke-width': 1.5, class: 'ghandle',
    });
    this.parts.center.dataset.mode = 'view';

    /* 回転リング (i = 回転軸 index)。奥半分は減光した back パス + 太い透明ヒットパス */
    this.parts.rings = [];
    for (let i = 0; i < 3; i++) {
      const g = {};
      g.back = this._el('path', {
        fill: 'none', stroke: AXES[i].color, 'stroke-width': 1.8, 'stroke-opacity': 0.28,
      });
      g.path = this._el('path', {
        fill: 'none', stroke: AXES[i].color, 'stroke-width': 2.5,
        'stroke-linejoin': 'round',
      });
      g.hit = this._el('path', {
        fill: 'none', stroke: '#fff', 'stroke-opacity': 0, 'stroke-width': 12,
        class: 'ghandle',
      });
      g.hit.dataset.mode = 'ring' + i;
      this.parts.rings.push(g);
    }
    /* 回転ドラッグ中の角度インジケータ (中心→現在位置) と pivot 印 (ドラッグで pivot 移動) */
    this.parts.rotLine = this._el('line', {
      stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'stroke-opacity': 0.8,
    });
    this.parts.pivotDot = this._el('circle', {
      r: 3.5, fill: '#fff', stroke: '#0008', 'stroke-width': 1,
    });
    this.parts.pivotHit = this._el('circle', {
      r: 10, fill: '#fff', 'fill-opacity': 0, class: 'ghandle',
    });
    this.parts.pivotHit.dataset.mode = 'pivot';

    /* スケール: 軸ライン+四角チップ (方向は getScaleAxes が返すワールド方向) + 中央四角=一様 */
    this.parts.scale = { axes: [], center: null };
    for (let i = 0; i < 3; i++) {
      const g = {};
      g.line = this._el('line', { stroke: AXES[i].color, 'stroke-width': 2.5, 'stroke-linecap': 'round' });
      g.tip = this._el('rect', { width: 9, height: 9, fill: AXES[i].color });
      g.hit = this._el('line', {
        stroke: '#fff', 'stroke-opacity': 0, 'stroke-width': 14,
        'stroke-linecap': 'round', class: 'ghandle',
      });
      g.hit.dataset.mode = 'scale' + i;
      this.parts.scale.axes.push(g);
    }
    this.parts.scale.center = this._el('rect', {
      width: 13, height: 13, fill: '#ffffff30', stroke: '#fff', 'stroke-width': 1.5, class: 'ghandle',
    });
    this.parts.scale.center.dataset.mode = 'scaleU';

    /* 制御点ドット (sweep の経路点など)。数が可変なのでプールを必要に応じて伸ばす */
    this.parts.points = [];

    this.svg.addEventListener('pointerdown', e => this._down(e));
    this.svg.addEventListener('pointermove', e => this._move(e));
    this.svg.addEventListener('pointerup', e => this._up(e));
    this.svg.addEventListener('pointercancel', e => this._up(e));
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.svg.style.display = 'none';
    this.update();
  }

  setMode(m) {
    this.mode = m;
    this.update();
  }

  /* 毎描画フレーム呼ばれる。アンカーを取得し直してハンドルを再配置 */
  update() {
    if (!this.enabled) return;
    /* 表示は常に最新アンカー (ドラッグ中はオブジェクトに追従)。
       ドラッグの数学は drag.anchor (開始時) に固定 */
    const anchor = this.hooks.getAnchor(this.mode);
    const p0 = anchor && this.viewer.project(anchor);
    if (!p0) { this.svg.style.display = 'none'; return; }
    this.svg.style.display = '';
    this.anchor = anchor;
    const L = this.viewer.worldPerPixel(anchor) * PIX_LEN;
    this.axisLen = L;

    const proj = q => this.viewer.project(q);
    const add = (p, d, s) => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
    const mode = this.mode;

    /* モード別のパーツ表示 */
    const show = (els, on) => { for (const el of els) el.style.display = on ? '' : 'none'; };
    for (const g of this.parts.axes) show([g.line, g.head, g.hit], mode === 'move');
    show(this.parts.planes, mode === 'move');
    show([this.parts.center], mode === 'move');
    for (const g of this.parts.rings) show([g.back, g.path, g.hit], mode === 'rotate');
    show([this.parts.pivotDot, this.parts.pivotHit], mode === 'rotate');
    for (const g of this.parts.scale.axes) show([g.line, g.tip, g.hit], mode === 'scale');
    show([this.parts.scale.center], mode === 'scale');
    if (!(this.drag && this.drag.kind === 'rot')) this.parts.rotLine.style.display = 'none';

    /* 制御点ドット (移動モードのみ)。掴んだ点はハイライト */
    const cps = (mode === 'move' && this.hooks.getPoints) ? (this.hooks.getPoints() || []) : [];
    this.ctrlPts = cps;
    while (this.parts.points.length < cps.length) {
      const i = this.parts.points.length;
      const g = {};
      g.dot = this._el('circle', { r: 4, fill: '#7ce38b', stroke: '#0008', 'stroke-width': 1.2 });
      g.hit = this._el('circle', { r: 11, fill: '#fff', 'fill-opacity': 0, class: 'ghandle' });
      g.hit.dataset.mode = 'pt' + i;
      this.parts.points.push(g);
    }
    for (let i = 0; i < this.parts.points.length; i++) {
      const g = this.parts.points[i];
      const pr = i < cps.length ? proj(cps[i]) : null;
      g.dot.style.display = g.hit.style.display = pr ? '' : 'none';
      if (!pr) continue;
      const held = this.drag && this.drag.kind === 'point' && this.drag.idx === i;
      g.dot.setAttribute('r', held ? 5.5 : 4);
      g.dot.setAttribute('fill', held ? '#aff5b4' : '#7ce38b');
      g.dot.setAttribute('cx', pr.x); g.dot.setAttribute('cy', pr.y);
      g.hit.setAttribute('cx', pr.x); g.hit.setAttribute('cy', pr.y);
    }

    if (mode === 'rotate') {
      const R = this.viewer.worldPerPixel(anchor) * RING_PIX;
      for (let i = 0; i < 3; i++) {
        const u = AXES[(i + 1) % 3].dir, v = AXES[(i + 2) % 3].dir;
        const g = this.parts.rings[i];
        /* 深度キュー: アンカーより手前のセグメント=通常、奥=減光。区間ごとに M..L で分ける */
        let dF = '', dB = '', dHit = '', okAll = true, prev = null;
        for (let s = 0; s <= RING_SEGS; s++) {
          const th = 2 * Math.PI * s / RING_SEGS;
          const q = add(add(anchor, u, R * Math.cos(th)), v, R * Math.sin(th));
          const pr = proj(q);
          if (!pr) { okAll = false; break; }
          dHit += (s ? 'L' : 'M') + pr.x.toFixed(1) + ',' + pr.y.toFixed(1);
          if (prev) {
            const seg = `M${prev.x.toFixed(1)},${prev.y.toFixed(1)}L${pr.x.toFixed(1)},${pr.y.toFixed(1)}`;
            if ((prev.z + pr.z) / 2 <= p0.z) dF += seg; else dB += seg;
          }
          prev = pr;
        }
        show([g.back, g.path, g.hit], okAll);
        if (okAll) {
          g.path.setAttribute('d', dF || 'M0,0');
          g.back.setAttribute('d', dB || 'M0,0');
          g.hit.setAttribute('d', dHit + 'Z');
        }
      }
      for (const el of [this.parts.pivotDot, this.parts.pivotHit]) {
        el.setAttribute('cx', p0.x);
        el.setAttribute('cy', p0.y);
      }
      return;
    }

    if (mode === 'scale') {
      /* 軸方向は app から (リーフのローカル軸をワールド化したもの)。
         [] = 一様のみ (球/八面体) → 白いハンドル1本 (カメラ右方向) を出し、
         ドラッグは一様スケール扱いにする (中央四角だけだと見落とされる) */
      let dirs = this.hooks.getScaleAxes ? (this.hooks.getScaleAxes() || []) : [];
      this.scaleUniformOnly = dirs.length === 0;
      if (this.scaleUniformOnly) dirs = [this.viewer._camVectors().right];
      this.scaleDirs = dirs;
      for (let i = 0; i < 3; i++) {
        const g = this.parts.scale.axes[i];
        const dir = dirs[i];
        const pe = dir && proj(add(anchor, dir, L));
        const vis = !!pe;
        show([g.line, g.tip, g.hit], vis);
        if (!vis) continue;
        const uni = this.scaleUniformOnly && i === 0;
        g.line.setAttribute('stroke', uni ? '#fff' : AXES[i].color);
        g.tip.setAttribute('fill', uni ? '#fff' : AXES[i].color);
        const dx = pe.x - p0.x, dy = pe.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const sx = p0.x + ux * 14, sy = p0.y + uy * 14;
        g.line.setAttribute('x1', sx); g.line.setAttribute('y1', sy);
        g.line.setAttribute('x2', pe.x); g.line.setAttribute('y2', pe.y);
        g.hit.setAttribute('x1', sx); g.hit.setAttribute('y1', sy);
        g.hit.setAttribute('x2', pe.x + ux * 8); g.hit.setAttribute('y2', pe.y + uy * 8);
        g.tip.setAttribute('x', pe.x - 4.5); g.tip.setAttribute('y', pe.y - 4.5);
      }
      const c = this.parts.scale.center;
      c.setAttribute('x', p0.x - 6.5);
      c.setAttribute('y', p0.y - 6.5);
      return;
    }

    for (let i = 0; i < 3; i++) {
      const dir = AXES[i].dir;
      const g = this.parts.axes[i];
      const pe = proj(add(anchor, dir, L));
      const vis = pe != null;
      for (const el of [g.line, g.head, g.hit]) el.style.display = vis ? '' : 'none';
      if (!vis) continue;
      const dx = pe.x - p0.x, dy = pe.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      /* 中央円と重ならないよう根元を少し空ける */
      const sx = p0.x + ux * 12, sy = p0.y + uy * 12;
      g.line.setAttribute('x1', sx); g.line.setAttribute('y1', sy);
      g.line.setAttribute('x2', pe.x); g.line.setAttribute('y2', pe.y);
      g.hit.setAttribute('x1', sx); g.hit.setAttribute('y1', sy);
      g.hit.setAttribute('x2', pe.x + ux * 10); g.hit.setAttribute('y2', pe.y + uy * 10);
      /* 矢頭 (三角形) */
      const hw = 5.5, hl = 11;
      g.head.setAttribute('points',
        `${pe.x + ux * hl},${pe.y + uy * hl} ${pe.x - uy * hw},${pe.y + ux * hw} ${pe.x + uy * hw},${pe.y - ux * hw}`);
    }

    /* 平面ハンドル: 法線軸 i を除く2軸で張る小さな四角形 */
    for (let i = 0; i < 3; i++) {
      const a = AXES[(i + 1) % 3].dir, b = AXES[(i + 2) % 3].dir;
      const poly = this.parts.planes[i];
      const corners = [
        add(add(anchor, a, L * PLANE_LO), b, L * PLANE_LO),
        add(add(anchor, a, L * PLANE_HI), b, L * PLANE_LO),
        add(add(anchor, a, L * PLANE_HI), b, L * PLANE_HI),
        add(add(anchor, a, L * PLANE_LO), b, L * PLANE_HI),
      ].map(proj);
      if (corners.some(c => !c)) { poly.style.display = 'none'; continue; }
      poly.style.display = '';
      poly.setAttribute('points', corners.map(c => `${c.x},${c.y}`).join(' '));
    }

    this.parts.center.setAttribute('cx', p0.x);
    this.parts.center.setAttribute('cy', p0.y);
  }

  /* ── ドラッグ ── */
  _paramOnAxis(ray, A, dir) {
    /* レイ O+s·r と直線 A+t·dir の最近接点の t */
    const u = [A[0] - ray.ro[0], A[1] - ray.ro[1], A[2] - ray.ro[2]];
    const b = dot3(dir, ray.rd);
    const denom = Math.max(1e-6, 1 - b * b);
    return (b * dot3(ray.rd, u) - dot3(dir, u)) / denom;
  }
  _hitOnPlane(ray, A, n) {
    const dn = dot3(ray.rd, n);
    if (Math.abs(dn) < 1e-6) return null;
    const s = (dot3(A, n) - dot3(ray.ro, n)) / dn;
    return [ray.ro[0] + ray.rd[0] * s, ray.ro[1] + ray.rd[1] * s, ray.ro[2] + ray.rd[2] * s];
  }

  _down(e) {
    const mode = e.target.dataset && e.target.dataset.mode;
    if (!mode || !this.anchor) return;
    const kind = mode.startsWith('ring') ? 'rot'
               : mode === 'pivot' ? 'pivot'
               : mode.startsWith('scale') ? 'scale'
               : mode.startsWith('pt') ? 'point' : 'move';
    const ptIdx = kind === 'point' ? +mode.slice(2) : -1;
    const started = kind === 'rot' ? this.hooks.onRotStart()
                  : kind === 'pivot' ? this.hooks.onPivotStart()
                  : kind === 'scale' ? this.hooks.onScaleStart()
                  : kind === 'point' ? this.hooks.onPointStart(ptIdx)
                  : this.hooks.onStart(e);   /* 移動だけ e を渡す (Shift+ドラッグ=複製) */
    if (!started) return;
    const endHook = kind === 'rot' ? this.hooks.onRotEnd
                  : kind === 'pivot' ? this.hooks.onPivotEnd
                  : kind === 'scale' ? this.hooks.onScaleEnd
                  : kind === 'point' ? this.hooks.onPointEnd
                  : this.hooks.onEnd;
    e.preventDefault();
    e.stopPropagation();
    try { this.svg.setPointerCapture(e.pointerId); } catch {}
    const ray = this.viewer.rayFromScreen(e.clientX, e.clientY);
    /* 制御点ドラッグは掴んだ点自身を基準面のアンカーに (中央ギズモではなく) */
    const A = kind === 'point' ? this.ctrlPts[ptIdx].slice() : this.anchor.slice();
    const drag = { mode, anchor: A, kind, idx: ptIdx };
    if (kind === 'point') {
      /* ビュー平面ドラッグ (pivot と同じ) */
      drag.n = this.viewer._camVectors().fwd;
      drag.hit0 = this._hitOnPlane(ray, A, drag.n);
      if (!drag.hit0) { endHook(); return; }
    } else if (kind === 'rot') {
      /* リング面 (アンカー通過・軸⊥) 上の掴み点 → 基準ベクトル */
      drag.n = AXES[+mode[4]].dir;
      const hit0 = this._hitOnPlane(ray, A, drag.n);
      if (!hit0) { endHook(); return; }
      drag.v0 = norm3([hit0[0] - A[0], hit0[1] - A[1], hit0[2] - A[2]]);
    } else if (kind === 'pivot') {
      /* pivot はビュー平面移動 */
      drag.n = this.viewer._camVectors().fwd;
      drag.hit0 = this._hitOnPlane(ray, A, drag.n);
      if (!drag.hit0) { endHook(); return; }
    } else if (kind === 'scale') {
      if (mode === 'scaleU') {
        /* 一様: 右/上ドラッグ=拡大, 左/下=縮小 の指数マッピング (±140px で ×2 / ×0.5)。
           中央掴みだと距離比方式は開始距離が小さすぎて過敏になるため */
        drag.sx = e.clientX; drag.sy = e.clientY;
      } else {
        drag.dir = (this.scaleDirs || [])[+mode[5]];
        if (!drag.dir) { endHook(); return; }
        drag.t0 = this._paramOnAxis(ray, A, drag.dir);
        if (Math.abs(drag.t0) < 1e-6) { endHook(); return; }
        /* 一様専用リーフの代替ハンドル: 軸ドラッグの数学で一様スケール */
        drag.uniform = this.scaleUniformOnly && +mode[5] === 0;
      }
    } else if (mode.startsWith('axis')) {
      drag.dir = AXES[+mode[4]].dir;
      drag.t0 = this._paramOnAxis(ray, A, drag.dir);
    } else {
      const { fwd } = this.viewer._camVectors();
      drag.n = mode === 'view' ? fwd : AXES[+mode[5]].dir;
      drag.hit0 = this._hitOnPlane(ray, A, drag.n);
      if (!drag.hit0) { endHook(); return; }
    }
    this.drag = drag;
    this.svg.classList.add('dragging');
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    const ray = this.viewer.rayFromScreen(e.clientX, e.clientY);
    if (d.kind === 'pivot' || d.kind === 'point') {
      const hit = this._hitOnPlane(ray, d.anchor, d.n);
      if (!hit) return;
      const dw = [hit[0] - d.hit0[0], hit[1] - d.hit0[1], hit[2] - d.hit0[2]];
      if (d.kind === 'point') this.hooks.onPointMove(d.idx, dw, e);
      else this.hooks.onPivotMove(dw, e);
      return;
    }
    if (d.kind === 'scale') {
      let s;
      if (d.mode === 'scaleU') {
        const t = (e.clientX - d.sx) - (e.clientY - d.sy);
        s = Math.pow(2, t / 140);
        this.hooks.onScaleMove(-1, s, e);
      } else {
        s = this._paramOnAxis(ray, d.anchor, d.dir) / d.t0;
        this.hooks.onScaleMove(d.uniform ? -1 : +d.mode[5], s, e);
      }
      return;
    }
    if (d.kind === 'rot') {
      const hit = this._hitOnPlane(ray, d.anchor, d.n);
      if (!hit) return;
      const v1 = norm3([hit[0] - d.anchor[0], hit[1] - d.anchor[1], hit[2] - d.anchor[2]]);
      const ang = Math.atan2(dot3(cross3(d.v0, v1), d.n), dot3(d.v0, v1));
      /* 角度インジケータ: pivot→現在の掴み点 */
      const pA = this.viewer.project(d.anchor), pH = this.viewer.project(hit);
      if (pA && pH) {
        const rl = this.parts.rotLine;
        rl.style.display = '';
        rl.setAttribute('x1', pA.x); rl.setAttribute('y1', pA.y);
        rl.setAttribute('x2', pH.x); rl.setAttribute('y2', pH.y);
      }
      this.hooks.onRotMove(d.n, ang, e);
      return;
    }
    let dw;
    if (d.mode.startsWith('axis')) {
      const t = this._paramOnAxis(ray, d.anchor, d.dir);
      const s = t - d.t0;
      dw = [d.dir[0] * s, d.dir[1] * s, d.dir[2] * s];
    } else {
      const hit = this._hitOnPlane(ray, d.anchor, d.n);
      if (!hit) return;
      dw = [hit[0] - d.hit0[0], hit[1] - d.hit0[1], hit[2] - d.hit0[2]];
    }
    this.hooks.onMove(dw, e);
  }

  _up(e) {
    if (!this.drag) return;
    const kind = this.drag.kind;
    this.drag = null;
    this.svg.classList.remove('dragging');
    this.parts.rotLine.style.display = 'none';
    if (kind === 'rot') this.hooks.onRotEnd();
    else if (kind === 'pivot') this.hooks.onPivotEnd();
    else if (kind === 'scale') this.hooks.onScaleEnd();
    else if (kind === 'point') this.hooks.onPointEnd();
    else this.hooks.onEnd();
    this.update();
  }
}
