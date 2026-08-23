/* ops2.mjs — round / onion / elongate / twist / bend の検証。
 *   node test/ops2.mjs
 * .ssq 往復一致 + codegen スモーク (twist/bend の 1/Lipschitz が uPar に載ること)。 */
import { parseScene, serializeScene } from '../js/model.js';
import { buildProgram, collectParams } from '../js/codegen.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};

const SRC = `(scene
  (camera (from 0 3 -7) (at 0 0.5 0) (up 0 1 0) (fov 48))
  (light (pos -6 9 -5)(intensity 1.2))
  (object "round" (surface (color 0.8 0.3 0.3))
    (sdf (round (r 0.12) (box (center 0 0.5 0)(size 0.38 0.38 0.38)))))
  (object "onion" (surface (color 0.8 0.7 0.3))
    (sdf (onion (t 0.05) (sphere (center 0 0.55 0)(radius 0.55)))))
  (object "elong" (surface (color 0.5 0.75 0.5))
    (sdf (elongate (h 0.45 0 0.2) (sphere (center 0 0 0)(radius 0.35)))))
  (object "twist" (surface (color 0.4 0.6 0.85))
    (sdf (translate (t 1 0.8 0)
      (twist (rate 90) (box (center 0 0 0)(size 0.28 0.8 0.28))))))
  (object "bend" (surface (color 0.75 0.45 0.75))
    (sdf (bend (rate 40) (box (center 0 0.5 0)(size 0.8 0.12 0.25)))))
)`;

/* 1. パース: 各ノードの型と props */
const doc = parseScene(SRC);
{
  const types = doc.objects.map(o => o.root.type);
  ok(JSON.stringify(types) === JSON.stringify(['round', 'onion', 'elongate', 'translate', 'bend']),
     `ルート型: ${types.join(' / ')}`);
  ok(Math.abs(doc.objects[0].root.props.r - 0.12) < 1e-12, 'round r=0.12');
  ok(Math.abs(doc.objects[1].root.props.t - 0.05) < 1e-12, 'onion t=0.05');
  const h = doc.objects[2].root.props.h;
  ok(Math.abs(h[0] - 0.45) < 1e-12 && h[2] === 0.2, 'elongate h=(0.45 0 0.2)');
  ok(doc.objects[3].root.children[0].props.rate === 90, 'twist rate=90');
  ok(doc.objects[4].root.props.rate === 40, 'bend rate=40');
}

/* 2. 往復一致 */
{
  const out = serializeScene(doc, doc.camera);
  ok(/\(round \(r 0\.12\)/.test(out) && /\(onion \(t 0\.05\)/.test(out) &&
     /\(elongate \(h 0\.45 0 0\.2\)/.test(out) && /\(twist \(rate 90\)/.test(out) &&
     /\(bend \(rate 40\)/.test(out), '書き出し形 5種');
  const doc2 = parseScene(out);
  const canon = n => JSON.stringify(n, (k, v) => (k === 'id' || k === 'name') ? undefined : v);
  let same = doc.objects.length === doc2.objects.length;
  for (let i = 0; same && i < doc.objects.length; i++)
    same = canon(doc.objects[i].root) === canon(doc2.objects[i].root);
  ok(same, 'ラウンドトリップで木が一致');
}

/* 3. codegen: twist/bend の rate(rad) と 1/L が uPar に載り、GLSL が生成される */
{
  const prog = buildProgram(doc);
  ok(/cos\(a_\)/.test(prog.frag) || /c_=cos/.test(prog.frag), 'GLSL に twist/bend の回転');
  ok(prog.frag.includes('clamp(') && prog.frag.includes('abs('), 'GLSL に elongate/onion');
  const pars = [...collectParams(doc, prog.layout)];
  ok(pars.every(Number.isFinite), 'パラメータ全て有限値');
  const rad90 = 90 * Math.PI / 180;
  const i = pars.findIndex(v => Math.abs(v - rad90) < 1e-6);
  ok(i >= 0, 'twist rate がラジアンで uPar に載る');
  ok(i >= 0 && pars[i + 1] > 0 && pars[i + 1] <= 1, `1/Lipschitz ∈ (0,1] (=${i >= 0 ? pars[i + 1].toFixed(3) : '-'})`);
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
