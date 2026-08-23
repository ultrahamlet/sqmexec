/* objmesh.js — (mesh (file ..)) ノードの表示・ピック支援 (第8弾, 2026-08-23)。
 *
 * OBJ メッシュは SDF ではないのでレイマーチに出せない (blob と同じ立場)。
 * 表示はラスタライズ (viewer.setObjMeshes)、ピックは CPU レイ・三角形。
 * エンジン (dist/obj_loader.cpp apply_transform) の変換規約:
 *   world = Rz·Ry·Rx · (scale ⊙ p) + pos
 * これは blob の幾何回転 (blobnode.blobRotMat = ZYX) と**同じ合成順**なので、
 * 回転まわりは blobRotMat / blobMatToEulerDeg をそのまま流用できる。
 *
 * 頂点法線は vn を読まず面法線の加算平均で作る (v//vn の添字分裂で頂点を
 * 複製するコストを避ける。プレビュー用途には十分)。 */

const cache = new Map();   /* file 文字列 → {status:'loading'|'ok'|'err', mesh, error} */

/* OBJ テキスト → { verts, normals, indices, lo, hi, nTris } */
export function parseObjText(text) {
  const vs = [];             /* flat x,y,z */
  const idx = [];
  const triGroup = [];       /* 三角形ごとのグループ index (-1 = なし) */
  const groupNames = [];
  let curGroup = -1;
  const groupId = name => {
    let i = groupNames.indexOf(name);
    if (i < 0) { i = groupNames.length; groupNames.push(name); }
    return i;
  };
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 3) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32) {
      const t = line.trim().split(/\s+/);
      vs.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
    } else if ((c0 === 111 /* o */ || c0 === 103 /* g */) && line.charCodeAt(1) === 32) {
      /* engine obj_loader と同じ: o/g とも同名なら同じグループに畳む */
      const nm = line.slice(2).trim();
      curGroup = nm ? groupId(nm) : -1;
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
      const t = line.trim().split(/\s+/);
      const nv = vs.length / 3;
      const face = [];
      for (let k = 1; k < t.length; k++) {
        const s = t[k];
        if (!s) continue;
        const sl = s.indexOf('/');
        const i = parseInt(sl >= 0 ? s.slice(0, sl) : s, 10);
        if (!i) continue;                       /* 0 や NaN (行末 \r 等) は捨てる */
        face.push(i > 0 ? i - 1 : nv + i);      /* 負添字 = 相対 (-1 が最後) */
      }
      for (let k = 2; k < face.length; k++) {   /* n-gon は扇形分割 */
        idx.push(face[0], face[k - 1], face[k]);
        triGroup.push(curGroup);
      }
    }
  }
  const verts = new Float32Array(vs);
  const indices = new Uint32Array(idx);
  const n = verts.length / 3;
  const normals = new Float32Array(verts.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    if (a >= verts.length || b >= verts.length || c >= verts.length) continue;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const wx = verts[c] - verts[a], wy = verts[c + 1] - verts[a + 1], wz = verts[c + 2] - verts[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const q of [a, b, c]) { normals[q] += nx; normals[q + 1] += ny; normals[q + 2] += nz; }
  }
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const l = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (l > 1e-20) { normals[o] /= l; normals[o + 1] /= l; normals[o + 2] /= l; }
    else normals[o + 1] = 1;
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (verts[i + k] < lo[k]) lo[k] = verts[i + k];
      if (verts[i + k] > hi[k]) hi[k] = verts[i + k];
    }
  if (!n) { lo.fill(0); hi.fill(0); }
  return { verts, normals, indices, lo, hi, nTris: indices.length / 3,
           triGroup: Int32Array.from(triGroup), groupNames };
}

/* group-surface 色分け表示用: 三角形のグループごとに頂点色を焼いた複製ジオメトリ。
 * 色の境界を硬くするため、複数グループに共有される頂点は (頂点, グループ) 対で
 * 分裂させる (通常の OBJ はグループ毎に頂点が分かれているので増分はごく僅か)。
 * colorOf(groupIdx) が null を返すグループは defCol (= object surface 色) */
export function buildGroupColored(mesh, colorOf, defCol) {
  const map = new Map();
  const ng = mesh.groupNames.length + 1;
  const outV = [], outN = [], outC = [];
  const outI = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const g = mesh.triGroup[t / 3];
    const col = (g >= 0 ? colorOf(g) : null) || defCol;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k];
      const key = v * ng + (g + 1);
      let ni = map.get(key);
      if (ni === undefined) {
        ni = outV.length / 3;
        map.set(key, ni);
        outV.push(mesh.verts[v * 3], mesh.verts[v * 3 + 1], mesh.verts[v * 3 + 2]);
        outN.push(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
        outC.push(col[0], col[1], col[2]);
      }
      outI[t + k] = ni;
    }
  }
  return { verts: new Float32Array(outV), normals: new Float32Array(outN),
           colors: new Float32Array(outC), indices: outI };
}

/* file パスの OBJ を取得 (serve.py /__objfile__ 経由 — $SQM_ROOT を展開し
 * プロジェクト配下に限定する)。読めたら onReady() を1回呼ぶ (再表示のトリガ)。
 * 返り: { status, mesh?, error? } — 'loading' の間は表示スキップ */
export function loadObj(file, onReady) {
  let e = cache.get(file);
  if (e) return e;
  e = { status: 'loading' };
  cache.set(file, e);
  fetch('/__objfile__', { method: 'POST', body: file })
    .then(async r => {
      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { msg = (await r.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return r.text();
    })
    .then(text => {
      e.mesh = parseObjText(text);
      e.status = e.mesh.nTris ? 'ok' : 'err';
      if (!e.mesh.nTris) e.error = '三角形が読めませんでした';
      onReady && onReady(e);
    })
    .catch(err => { e.status = 'err'; e.error = err.message; onReady && onReady(e); });
  return e;
}
export function objCacheGet(file) { return cache.get(file); }
export function objCacheDrop(file) { cache.delete(file); }

/* world = R·S·p + t の column-major 4x4 (R = 9値 row-major) */
export function meshModelMat(t, R, s) {
  return new Float32Array([
    R[0] * s[0], R[3] * s[0], R[6] * s[0], 0,
    R[1] * s[1], R[4] * s[1], R[7] * s[1], 0,
    R[2] * s[2], R[5] * s[2], R[8] * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}
/* 法線行列 = (R·S)⁻ᵀ = R·S⁻¹ (column-major 3x3) */
export function meshNrmMat(R, s) {
  const inv = k => 1 / (Math.abs(s[k]) > 1e-12 ? s[k] : 1);
  const i0 = inv(0), i1 = inv(1), i2 = inv(2);
  return new Float32Array([
    R[0] * i0, R[3] * i0, R[6] * i0,
    R[1] * i1, R[4] * i1, R[7] * i1,
    R[2] * i2, R[5] * i2, R[8] * i2,
  ]);
}

/* CPU ピック: entries = [{ pos, rotMat(9 row-major), scale, mesh, node, objIdx }]。
 * レイをローカルへ (p_l = S⁻¹·Rᵀ·(p−t))。アフィンなのでローカルの t パラメータは
 * ワールドの t と同一 → エントリ間で直接比較できる。bbox スラブで棄却してから
 * Möller–Trumbore の線形走査 (クリック1回なので 10万tri 級でも数ms)。 */
export function rayPickObjMesh(entries, ro, rd) {
  let best = null, bestT = Infinity;
  for (const e of entries) {
    const m = e.mesh;
    if (!m || !m.nTris) continue;
    const R = e.rotMat, s = e.scale;
    const ox = ro[0] - e.pos[0], oy = ro[1] - e.pos[1], oz = ro[2] - e.pos[2];
    const inv = k => 1 / (Math.abs(s[k]) > 1e-12 ? s[k] : 1);
    const i0 = inv(0), i1 = inv(1), i2 = inv(2);
    /* Rᵀ·v は row-major R の列ドット */
    const lox = (R[0] * ox + R[3] * oy + R[6] * oz) * i0;
    const loy = (R[1] * ox + R[4] * oy + R[7] * oz) * i1;
    const loz = (R[2] * ox + R[5] * oy + R[8] * oz) * i2;
    const ldx = (R[0] * rd[0] + R[3] * rd[1] + R[6] * rd[2]) * i0;
    const ldy = (R[1] * rd[0] + R[4] * rd[1] + R[7] * rd[2]) * i1;
    const ldz = (R[2] * rd[0] + R[5] * rd[1] + R[8] * rd[2]) * i2;
    /* bbox スラブ */
    let t0 = 0.02, t1 = bestT;
    let ok = true;
    const lov = [lox, loy, loz], ldv = [ldx, ldy, ldz];
    for (let k = 0; k < 3 && ok; k++) {
      if (Math.abs(ldv[k]) < 1e-12) {
        if (lov[k] < m.lo[k] || lov[k] > m.hi[k]) ok = false;
      } else {
        let a = (m.lo[k] - lov[k]) / ldv[k], b = (m.hi[k] - lov[k]) / ldv[k];
        if (a > b) { const q = a; a = b; b = q; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) ok = false;
      }
    }
    if (!ok) continue;
    const V = m.verts, I = m.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
      const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
      const px = ldy * e2z - ldz * e2y, py = ldz * e2x - ldx * e2z, pz = ldx * e2y - ldy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const idet = 1 / det;
      const tx = lox - V[a], ty = loy - V[a + 1], tz = loz - V[a + 2];
      const u = (tx * px + ty * py + tz * pz) * idet;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (ldx * qx + ldy * qy + ldz * qz) * idet;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * idet;
      if (tt > 0.02 && tt < bestT) { bestT = tt; best = e; }
    }
  }
  if (best) best.pickT = bestT;
  return best;
}
