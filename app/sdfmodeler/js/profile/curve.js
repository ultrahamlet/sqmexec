/* curve.js — 2D点列の密化。エンジン sexp_input.cpp の spline_densify (dim=2) と同式。
 * curve: 0=折れ線(そのまま) / 1=Catmull-Rom(制御点を通る) / 2=一様3次Bスプライン(近似)。
 * closed=true で端を wrap (ループ)。返り値は密化済み [[x,y],...]。 */
export function densify(pts, curve, closed, steps) {
  const n = pts.length;
  if (curve < 1 || n < 3 || steps < 2) return pts.map(p => p.slice());
  const bsp = curve === 2;
  const nseg = closed ? n : n - 1;
  const out = [];
  for (let i = 0; i < nseg; i++) {
    let i0, i1, i2, i3;
    if (closed) { i0 = (i - 1 + n) % n; i1 = i; i2 = (i + 1) % n; i3 = (i + 2) % n; }
    else { i0 = Math.max(0, i - 1); i1 = i; i2 = Math.min(n - 1, i + 1); i3 = Math.min(n - 1, i + 2); }
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const o = [0, 0];
      for (let c = 0; c < 2; c++) {
        const p0 = pts[i0][c], p1 = pts[i1][c], p2 = pts[i2][c], p3 = pts[i3][c];
        if (bsp) {
          const b0 = (-t3 + 3 * t2 - 3 * t + 1) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6;
          const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6;
          o[c] = b0 * p0 + b1 * p1 + b2 * p2 + b3 * p3;
        } else {
          o[c] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
        }
      }
      out.push(o);
    }
  }
  if (!closed) out.push(pts[n - 1].slice());
  return out;
}
