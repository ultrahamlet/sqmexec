/* repeat.mjs — repeat (有限線形反復) ノードの検証。
 *   node test/repeat.mjs
 * .ssq パース → ノード → 書き出し → 再パースの往復一致と、codegen が
 * 隣接2コピー min の GLSL を生成できることのスモーク。 */
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
  (object "fence" (surface (color 0.6 0.4 0.2))
    (sdf (translate (t -1 0 0)
           (repeat (count 8) (offset 0.34 0 0)
             (cylinder-ab (a 0 0 0)(b 0 1.1 0)(radius 0.05))))))
  (object "stairs" (surface (color 0.4 0.6 0.85))
    (sdf (repeat (count 6) (offset 0.46 0.26 0)
           (box (center 0 0 0)(size 0.2 0.115 0.55)))))
  (object "tiles" (surface (color 0.85 0.55 0.3))
    (sdf (repeat (count 3) (offset 0 0 0.62)
           (repeat (count 4) (offset 0.62 0 0)
             (box (center 0 0 0)(size 0.27 0.06 0.27))))))
)`;

/* 1. パース: repeat ノードの props */
const doc = parseScene(SRC);
const fence = doc.objects[0].root;
{
  /* translate → repeat → leaf */
  const rep = fence.children ? (fence.type === 'translate' ? fence.children[0] : null) : null;
  ok(rep && rep.type === 'repeat', 'translate 下に repeat をパース');
  ok(rep && rep.props.count === 8, 'count=8');
  ok(rep && Math.abs(rep.props.offset[0] - 0.34) < 1e-12, 'offset.x=0.34');
  ok(rep && rep.children[0].type === 'cylinder-ab', '子リーフ保持');
}
{
  const t = doc.objects[2].root;
  ok(t.type === 'repeat' && t.children[0].type === 'repeat', 'ネスト repeat (タイル) をパース');
}

/* 2. 往復一致: 書き出し → 再パースで構造/数値一致 */
{
  const out = serializeScene(doc, doc.camera);
  ok(/\(repeat \(count 8\) \(offset 0\.34 0 0\)/.test(out), '書き出し形 (repeat (count)(offset))');
  const doc2 = parseScene(out);
  const canon = n => JSON.stringify(n, (k, v) => (k === 'id' || k === 'name') ? undefined : v);
  let same = doc.objects.length === doc2.objects.length;
  for (let i = 0; same && i < doc.objects.length; i++)
    same = canon(doc.objects[i].root) === canon(doc2.objects[i].root);
  ok(same, 'ラウンドトリップで木が一致');
}

/* 3. codegen スモーク: 隣接2コピー min を含む GLSL が生成される */
{
  const prog = buildProgram(doc);
  ok(prog.frag.includes('min(') && /clamp\(floor\(/.test(prog.frag), 'GLSL に floor+clamp+min');
  const pars = collectParams(doc, prog.layout);
  ok([...pars].every(Number.isFinite), 'パラメータ全て有限値');
  ok([...pars].includes(8) && [...pars].includes(6), 'count が uPar に載る');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
