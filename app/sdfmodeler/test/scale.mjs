/* scale.mjs — スケールギズモ仕様 (js/scale.js) と localToWorldDelta の検証。
 *   node test/scale.mjs */
import { makeNode } from '../js/model.js';
import { worldToLocalDelta, localToWorldDelta } from '../js/anchor.js';
import { scaleAxesFor, applyScale } from '../js/scale.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-9) =>
  a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const orig = node => JSON.parse(JSON.stringify(node.props));

/* 1. box: 軸別スケールは該当成分のみ、一様は全成分 */
{
  const n = makeNode('box', { center: [1, 2, 3], size: [1, 2, 4] });
  applyScale(n, orig(n), 1, 1.5);
  ok(near(n.props.size, [1, 3, 4]), 'box 軸1スケールで size.y のみ ×1.5');
  ok(near(n.props.center, [1, 2, 3]), 'center は不変');
  applyScale(n, orig(n), -1, 2);
  ok(near(n.props.size, [2, 6, 8]), 'box 一様スケールで全成分 ×2');
}

/* 2. a/b 端点系: 軸0 = 中点固定の伸縮 (方向保存)、垂直 = radius のみ */
{
  const n = makeNode('capsule', { a: [1, 0, 0], b: [1, 2, 0], radius: 0.3 });
  const o = orig(n);   /* 初期状態を1回だけ捕捉 (applyScale は毎回 orig 基準で書く) */
  const axes = scaleAxesFor(n);
  ok(near(axes[0], [0, 1, 0]), 'capsule 軸0 = 部品軸 u');
  ok(Math.abs(axes[0][0] * axes[1][0] + axes[0][1] * axes[1][1] + axes[0][2] * axes[1][2]) < 1e-12,
     '垂直軸は u と直交');
  applyScale(n, o, 0, 2);
  ok(near(n.props.a, [1, -1, 0]) && near(n.props.b, [1, 3, 0]), '軸0 ×2 で中点固定伸縮');
  ok(Math.abs(n.props.radius - 0.3) < 1e-12, '軸0 では radius 不変');
  applyScale(n, o, 1, 0.5);
  ok(Math.abs(n.props.radius - 0.15) < 1e-12, '垂直軸で radius ×0.5');
  applyScale(n, o, -1, 2);
  ok(near(n.props.a, [1, -1, 0]) && Math.abs(n.props.radius - 0.6) < 1e-12, '一様 = 伸縮+radius');
}

/* 3. round-cone-ab: 垂直軸で r1/r2 両方 */
{
  const n = makeNode('round-cone-ab', { a: [0, 0, 0], b: [0, 1, 0], r1: 0.4, r2: 0.1 });
  applyScale(n, orig(n), 2, 3);
  ok(Math.abs(n.props.r1 - 1.2) < 1e-12 && Math.abs(n.props.r2 - 0.3) < 1e-12,
     'ab円錐の垂直軸で r1/r2 ×3');
}

/* 4. cylinder / torus の軸マッピング */
{
  const c = makeNode('cylinder', { center: [0, 0, 0], radius: 0.5, height: 1 });
  applyScale(c, orig(c), 1, 2);
  ok(c.props.height === 2 && c.props.radius === 0.5, 'cylinder 軸1 = height');
  applyScale(c, orig(c), 0, 2);
  ok(c.props.radius === 1, 'cylinder 軸0 = radius');
  const t = makeNode('torus', { center: [0, 0, 0], major: 1, minor: 0.3 });
  applyScale(t, orig(t), 1, 2);
  ok(t.props.minor === 0.6 && t.props.major === 1, 'torus 軸1 = minor');
  applyScale(t, orig(t), 2, 2);
  ok(t.props.major === 2, 'torus 軸2 = major');
}

/* 5. cone: 横軸は tanθ 変換、一様は角度不変 */
{
  const n = makeNode('cone', { center: [0, 0, 0], angle: 30, height: 1 });
  applyScale(n, orig(n), 0, 2);
  const expect = Math.atan(2 * Math.tan(30 * Math.PI / 180)) * 180 / Math.PI;
  ok(Math.abs(n.props.angle - expect) < 1e-9, `cone 横軸 tanθ'=2tanθ (${expect.toFixed(2)}°)`);
  const n2 = makeNode('cone', { center: [0, 0, 0], angle: 30, height: 1 });
  applyScale(n2, orig(n2), -1, 2);
  ok(Math.abs(n2.props.angle - 30) < 1e-12 && n2.props.height === 2, 'cone 一様 = height のみ (角度不変)');
}

/* 6. スケール不可判定と最小寸法クランプ */
{
  ok(scaleAxesFor(makeNode('plane', { center: [0, 0, 0] })) == null, 'plane はスケール不可');
  ok(scaleAxesFor(makeNode('union', {})) == null, 'CSG ノードはスケール不可');
  ok(scaleAxesFor(makeNode('translate', { t: [0, 0, 0] })) == null, '変換ノードはスケール不可');
  ok(scaleAxesFor(makeNode('sphere', { center: [0, 0, 0], radius: 1 })).length === 0,
     'sphere は一様のみ (軸ハンドル無し)');
  const n = makeNode('sphere', { center: [0, 0, 0], radius: 1 });
  applyScale(n, orig(n), -1, 0.0001);   /* s は 0.01 に、寸法は 1e-3 にクランプ */
  ok(n.props.radius >= 1e-3, '最小寸法クランプ');
}

/* 7. localToWorldDelta: worldToLocalDelta と往復恒等 (回転チェーン下) */
{
  const s = makeNode('box', { center: [0, 0, 0], size: [1, 1, 1] });
  const r2 = makeNode('rotate', { deg: [15, -70, 42], pivot: [0.1, 0.2, -0.3] }, [s]);
  const r1 = makeNode('rotate', { deg: [31, 47, 13], pivot: [0.3, -0.2, 0.5] }, [r2]);
  const root = makeNode('union', {}, [r1]);
  const v = [0.3, -0.7, 0.2];
  const back = worldToLocalDelta(root, s.id, localToWorldDelta(root, s.id, v));
  ok(near(back, v, 1e-12), 'localToWorld → worldToLocal 往復恒等');
  const w = localToWorldDelta(root, s.id, [1, 0, 0]);
  ok(Math.abs(Math.hypot(...w) - 1) < 1e-12, '回転のみなので長さ保存');
}

/* 8. sweep: 重心まわり拡縮 (一様=半径も / 軸=その成分のみ) */
{
  const n = makeNode('sweep', { points: [0, 0, 0,  2, 0, 0,  2, 2, 0], radii: [0.2, 0.15, 0.1], curve: 0 });
  ok(scaleAxesFor(n).length === 3, 'sweep は XYZ 軸ハンドルあり');
  const o = orig(n);
  applyScale(n, o, -1, 2);   /* 一様×2: 重心 (4/3, 2/3, 0) 固定 */
  const c = [4 / 3, 2 / 3, 0];
  const exp = [];
  for (let q = 0; q < 3; q++) for (let i = 0; i < 3; i++)
    exp.push(c[i] + (o.points[3 * q + i] - c[i]) * 2);
  ok(near(n.props.points, exp, 1e-12), 'sweep 一様: 経路点が重心まわりに2倍');
  ok(near(n.props.radii, [0.4, 0.3, 0.2], 1e-12), 'sweep 一様: 半径も2倍');
  const n2 = makeNode('sweep', { points: [0, 0, 0,  2, 0, 0,  2, 2, 0], radii: [0.2, 0.15, 0.1], curve: 0 });
  const o2 = orig(n2);
  applyScale(n2, o2, 1, 3);   /* y 軸のみ×3 */
  ok(Math.abs(n2.props.points[7] - (2 / 3 + (2 - 2 / 3) * 3)) < 1e-12 &&
     n2.props.points[6] === 2 && near(n2.props.radii, o2.radii, 1e-12),
     'sweep 軸: y 成分のみ伸縮・半径不変');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
