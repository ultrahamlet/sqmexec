/* bones.js — ボーン (スケルトン) オーバーレイ。
 * a/b 端点系リーフ (カプセル/丸錐AB等) = 線分+端点ドット、center 系リーフ = ドット、
 * rotate 関節の pivot = アンバーのリング、を SVG に描く (ギズモと同じ project())。
 * 「ボーン」トグン ON 中のドラッグはレイマーチを止めてこれだけ追従させる
 * (viewer.boneOnly) → 描画コストがノード数に依存しない。
 * 注意: mirror は恒等近似なので鏡像側のボーンは表示されない (リグは通常 mirror 不使用)。 */

const NS = 'http://www.w3.org/2000/svg';

const dotPath = (p, r) =>
  `M${(p.x - r).toFixed(1)},${p.y.toFixed(1)}` +
  `a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;

export class BoneOverlay {
  /* hooks: getBones() → [{a,b?}|{a}|{pivot}] (ワールド座標) */
  constructor(svg, viewer, hooks) {
    this.svg = svg;
    this.viewer = viewer;
    this.hooks = hooks;
    this.enabled = false;
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      svg.appendChild(e);
      return e;
    };
    /* 描画順: 黒フチ → 白ライン → 端点 → pivot リング (要素4つを毎フレーム d 更新) */
    this.under = el('path', { fill: 'none', stroke: '#0007', 'stroke-width': 4.5, 'stroke-linecap': 'round' });
    this.lines = el('path', { fill: 'none', stroke: '#fff', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-opacity': 0.95 });
    this.dots = el('path', { fill: '#fff', stroke: '#0007', 'stroke-width': 1 });
    this.pivots = el('path', { fill: 'none', stroke: '#f6a623', 'stroke-width': 1.6, 'stroke-opacity': 0.95 });
  }

  setEnabled(on) {
    this.enabled = on;
    this.svg.style.display = on ? '' : 'none';
    if (on) this.update();
  }

  /* 毎描画フレーム呼ばれる (viewer.onDraw 経由) */
  update() {
    if (!this.enabled) return;
    const bones = this.hooks.getBones() || [];
    const proj = p => this.viewer.project(p);
    let dl = '', dd = '', dp = '';
    for (const b of bones) {
      if (b.pivot) {
        const pp = proj(b.pivot);
        if (pp) dp += dotPath(pp, 4);
        continue;
      }
      const pa = proj(b.a);
      if (!pa) continue;
      if (b.b) {
        const pb = proj(b.b);
        if (!pb) continue;
        dl += `M${pa.x.toFixed(1)},${pa.y.toFixed(1)}L${pb.x.toFixed(1)},${pb.y.toFixed(1)}`;
        dd += dotPath(pa, 2.4) + dotPath(pb, 2.4);
      } else {
        dd += dotPath(pa, 3);
      }
    }
    this.under.setAttribute('d', dl || 'M0,0');
    this.lines.setAttribute('d', dl || 'M0,0');
    this.dots.setAttribute('d', dd || 'M0,0');
    this.pivots.setAttribute('d', dp || 'M0,0');
  }
}
