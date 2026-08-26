/* sweep_child.mjs — 「リーフが滑らか和から黙って消えていないか」回帰テスト。
 *   node test/sweep_child.mjs
 *
 * 2026-08-26 の障害: 新規シーンで「掃引チューブ」を足すとプレビューに何も出ない
 * (メッシュ表示と sqm 本レンダには出る = GLSL 生成だけの不具合)。
 *
 * 原因は emitEmpty() の二役。sweep は畳み込みの種として
 *     float d0 = 1e9;                     // ← emitEmpty で書いていた
 *     for (..) d0 = min(d0, sdSweepSeg(..));
 * と書くが、emitEmpty は「この変数は空集合 (1e9) だ」という印を this.sentinels に
 * 残す。2026-08-24 に入った smooth-union の番兵フィルタ
 *     kids = kids.filter(x => !this.sentinels.has(x));
 * が、ループで実距離になった後の d0 まで空集合とみなして**子ごと捨てて**いた
 * → 滑らか和の唯一の子が sweep だと kids が空になり sdObj0 が 1e9 を返す = 不可視。
 * (子が2個以上の滑らか和は枝刈り経路 emitOpPruned に入るので露呈しなかった。
 *  新規シーンのルートは子1個の滑らか和なので必ず踏む。)
 *
 * ここでは「sdObjN が返す変数が、線形走査で 1e9 のままか」を見る。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene } from '../js/model.js';
import { buildProgram } from '../js/codegen.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

/* 関数本体を上から舐め、return する変数がまだ 1e9 のままなら「消えた」とみなす。
   for ループ内の代入 (d0 = min(d0, ..)) は番兵解除として拾う。 */
function deadReturns(frag) {
  const bad = [];
  for (const m of frag.matchAll(/float (sdObj\d+)\(vec3 p0\)\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = m;
    const sentinel = new Set();
    let ret = null;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      const asg = /([A-Za-z_]\w*)\s*=\s*([^=;][^;]*);/g;
      let a;
      while ((a = asg.exec(line))) {
        const rhs = a[2].trim();
        if (rhs === '1e9' || sentinel.has(rhs)) sentinel.add(a[1]); else sentinel.delete(a[1]);
      }
      const r = line.match(/^return\s+([A-Za-z_]\w*)\s*;/);
      if (r) ret = r[1];
    }
    if (ret && sentinel.has(ret)) bad.push(name);
  }
  return bad;
}

/* 検出器の自己検査 — 壊れた版で必ず落ちること */
{
  const buggy = 'float sdObj0(vec3 p0){\n  float d0 = 1e9;\n  for (int i_ = 0; i_ < 24; i_++) { d0 = min(d0, sdSweepSeg(p0, 1.0, 2.0)); }\n  float d1 = 1e9;\n  return d1;\n}';
  const fixed = 'float sdObj0(vec3 p0){\n  float d0 = 1e9;\n  for (int i_ = 0; i_ < 24; i_++) { d0 = min(d0, sdSweepSeg(p0, 1.0, 2.0)); }\n  float d1 = d0;\n  return d1;\n}';
  ok(deadReturns(buggy).length === 1, '検出器の自己検査: 壊れた版を検出');
  ok(deadReturns(fixed).length === 0, '検出器の自己検査: 直った版は検出 0 件');
  /* 空の op (子が本当に無い) は 1e9 が正しい → ここは検出してよい。
     テスト対象のシーンには空 op を置かないことで区別する。 */
}

const HEAD = `(scene
  (background 0.16 0.19 0.24)
  (camera (from 4 3 -8) (at 0 0.5 0) (up 0 1 0) (fov 42))
  (light (pos 8 10 -6)(intensity 1.3)(color 1 0.97 0.9))`;

/* 新規シーンで各プリミティブを1個足した直後の形 = 子1個の滑らか和 */
const SOLO = {
  'sweep (円形)':
    '(sweep (spline 0 0.2 0  0.45 0.7 0.3  0 1.4 0)(radii 0.2 0.15 0.09)(steps 12))',
  'sweep (任意断面)':
    '(sweep (spline 0 0.2 0  0.45 0.7 0.3  0 1.4 0)(radii 0.2 0.15 0.09)(steps 12)' +
    '(profile -0.5 -0.5  0.5 -0.5  0.5 0.5  -0.5 0.5))',
  'sweep (折れ線)':
    '(sweep (points 0 0.2 0  0 1.4 0)(radius 0.15))',
  'sphere':  '(sphere (center 0 0.8 0)(radius 0.5))',
  'lathe':   '(lathe (center 0 0 0)(profile 0 0  0.5 0  0.5 1  0 1)(steps 12))',
  'extrude': '(extrude (center 0 0.5 0)(depth 0.2)(profile -0.5 -0.5  0.5 -0.5  0 0.5))',
  'capsule': '(capsule (a 0 0.2 0)(b 0 1.2 0)(radius 0.2))',
};
for (const [label, leaf] of Object.entries(SOLO)) {
  const doc = parseScene(`${HEAD}
  (object "model" (surface (color 0.75 0.62 0.45))
    (sdf (smooth-union (k 0.15) ${leaf}))))`);
  const bad = deadReturns(buildProgram(doc).frag);
  ok(bad.length === 0, `滑らか和の唯一の子が ${label}: 距離が返る` +
     (bad.length ? ` — ${bad[0]} が 1e9 のまま` : ''));
}

/* 変換オプを挟んでも同じ (translate/rotate 越しに種が伝播する) */
{
  const doc = parseScene(`${HEAD}
  (object "model" (surface (color 0.75 0.62 0.45))
    (sdf (smooth-union (k 0.15)
      (translate (t 0 0.5 0)
        (sweep (spline 0 0 0  0.45 0.5 0.3  0 1.2 0)(radii 0.2 0.15 0.09)(steps 12)))))))`);
  const bad = deadReturns(buildProgram(doc).frag);
  ok(bad.length === 0, 'translate 越しの sweep 1個でも距離が返る' +
     (bad.length ? ` — ${bad[0]}` : ''));
}

/* 既存サンプルも巻き添えになっていないか */
for (const name of ['sweep_test', 'rabbit', 'trex', 'ax_tube_rope']) {
  const doc = parseScene(readFileSync(join(here, `../examples/${name}.ssq`), 'utf8'));
  const bad = deadReturns(buildProgram(doc).frag);
  ok(bad.length === 0, `${name}.ssq: 消えた object なし` + (bad.length ? ` — ${bad.join(',')}` : ''));
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
