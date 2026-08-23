/* objsphere.mjs — オブジェクト境界球 (map ガード) の保守性検証。
 *   node test/objsphere.mjs
 * ガードの正しさ = 「球がオブジェクト表面を完全に含む」。ここでは各サンプルの
 * 全リーフについて anchor.js の worldPoint で端点/中心を出し、寸法マージン込みで
 * 球内に収まることを確認する (mirror は鏡像点も検査)。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene, SCHEMA } from '../js/model.js';
import { objSphere, collectObjSpheres } from '../js/codegen.js';
import { worldPoint } from '../js/anchor.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};

function maxDim(p) {
  let d = 0.05;
  for (const k of ['radius', 'major', 'minor', 'height', 'r1', 'r2', 'size', 'radii', 'thick']) {
    const v = p[k];
    if (v == null) continue;
    d = Math.max(d, Array.isArray(v) ? Math.max(...v.map(Math.abs)) : Math.abs(v));
  }
  return d;
}

/* オブジェクトの全リーフ代表点 (mirror 恒等近似の worldPoint 側) が球に入るか */
function checkContained(obj, sph, name) {
  let worst = -1e9;
  const walk = n => {
    const sc = SCHEMA[n.type];
    if (sc && sc.kind === 'leaf' && n.type !== 'plane' && n.type !== 'raw') {
      const p = n.props;
      const locs = (p.a && p.b) ? [p.a, p.b] : p.center ? [p.center] : [];
      for (const l of locs) {
        const w = worldPoint(obj.root, n.id, l);
        const d = Math.hypot(w[0] - sph[0], w[1] - sph[1], w[2] - sph[2]) + maxDim(p);
        worst = Math.max(worst, d - sph[3]);
      }
    }
    n.children.forEach(walk);
  };
  walk(obj.root);
  ok(worst <= 0, `${name}: 全リーフが球内 (worst margin ${worst.toFixed(3)})`);
}

for (const file of ['trex.ssq', 'human.ssq', 'dog.ssq']) {
  const doc = parseScene(readFileSync(join(here, '../examples/', file), 'utf8'));
  const model = doc.objects.find(o => o.name !== 'ground');
  const ground = doc.objects.find(o => o.name === 'ground');
  const s = objSphere(model);
  ok(s && s[3] < 100, `${file}: モデルの球が有限 (r=${s ? s[3].toFixed(2) : '-'})`);
  ok(objSphere(ground) == null, `${file}: ground (plane) はガード無効`);
  if (s) checkContained(model, s, file);
}

/* mirror: 鏡像側の点も球に入るか (rabbit) */
{
  const doc = parseScene(readFileSync(join(here, '../examples/rabbit.ssq'), 'utf8'));
  for (const obj of doc.objects) {
    if (obj.name === 'ground') continue;
    const s = objSphere(obj);
    if (!s) continue;
    /* 手検査: ミラー下の葉の鏡像点 (x 反転が主) が球内か — 代表として
       x を反転した位置 +寸法 が半径以内かを全 center/a/b 葉で確認 */
    let worst = -1e9;
    const walk = n => {
      const sc = SCHEMA[n.type];
      if (sc && sc.kind === 'leaf' && n.props.center) {
        const w = worldPoint(obj.root, n.id, n.props.center);
        const m = [-w[0], w[1], w[2]];   /* rabbit の mirror は x 面 */
        const d = Math.hypot(m[0] - s[0], m[1] - s[1], m[2] - s[2]) + maxDim(n.props);
        worst = Math.max(worst, d - s[3]);
      }
      n.children.forEach(walk);
    };
    walk(obj.root);
    ok(worst <= 0.5, `rabbit/${obj.name}: 鏡像側もほぼ球内 (worst ${worst.toFixed(3)})`);
  }
}

/* collectObjSpheres: 可視オブジェクト順で plane 持ちは 1e9 */
{
  const doc = parseScene(readFileSync(join(here, '../examples/human.ssq'), 'utf8'));
  const arr = collectObjSpheres(doc);
  ok(arr.length >= 8 && arr[3] >= 1e8, 'collectObjSpheres: ground が 1e9');
  ok(arr[7] < 100, 'collectObjSpheres: human が有限半径');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
