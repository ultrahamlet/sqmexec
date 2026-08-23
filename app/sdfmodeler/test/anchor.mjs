/* anchor.mjs — worldAnchor / worldToLocalDelta の数学検証。
 *   node test/anchor.mjs
 * 要: 回転祖先チェーンの下でも「ローカルデルタを適用 → ワールドアンカーが
 * ちょうど dWorld 動く」こと (ギズモ移動の正しさの核)。 */
import { makeNode } from '../js/model.js';
import { worldAnchor, worldToLocalDelta } from '../js/anchor.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ok ' : 'FAIL ') + msg);
  if (!cond) fails++;
};
const near = (a, b, eps = 1e-9) =>
  a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

/* 1. 素の leaf: anchor = center */
{
  const s = makeNode('sphere', { center: [1, 2, 3], radius: 1 });
  const root = makeNode('union', {}, [s]);
  ok(near(worldAnchor(root, s.id), [1, 2, 3]), 'leaf anchor = center');
}

/* 2. translate 祖先: anchor は +t */
{
  const s = makeNode('sphere', { center: [0, 1, 0], radius: 1 });
  const t = makeNode('translate', { t: [1, 0, 0] }, [s]);
  const root = makeNode('union', {}, [t]);
  ok(near(worldAnchor(root, s.id), [1, 1, 0]), 'translate 祖先で anchor が +t');
  ok(near(worldAnchor(root, t.id), [1, 1, 0]), 'translate 自身の anchor は子の代表点');
}

/* 3. rotate 90°Y: 幾何は R 回転 (codegen の Rᵀ クエリと同型) */
{
  const s = makeNode('sphere', { center: [1, 0, 0], radius: 1 });
  const r = makeNode('rotate', { deg: [0, 90, 0], pivot: [0, 0, 0] }, [s]);
  const root = makeNode('union', {}, [r]);
  ok(near(worldAnchor(root, s.id), [0, 0, -1], 1e-9), 'rotate 90°Y で (1,0,0)→(0,0,-1)');
  const dl = worldToLocalDelta(root, s.id, [0, 0, -1]);
  ok(near(dl, [1, 0, 0], 1e-9), 'worldToLocalDelta は Rᵀ (world -z → local +x)');
}

/* 4. a/b 端点系: anchor = 中点 */
{
  const c = makeNode('capsule', { a: [0, 0, 0], b: [0, 2, 0], radius: 0.3 });
  const root = makeNode('union', {}, [c]);
  ok(near(worldAnchor(root, c.id), [0, 1, 0]), 'capsule anchor = a/b 中点');
}

/* 5. mirror は恒等扱い */
{
  const s = makeNode('sphere', { center: [-1, 0, 0], radius: 1 });
  const m = makeNode('mirror', { normal: [-1, 0, 0], d: 0 }, [s]);
  const root = makeNode('union', {}, [m]);
  ok(near(worldAnchor(root, s.id), [-1, 0, 0]), 'mirror 下の anchor は元定義側そのまま');
}

/* 6. op グループ: anchor = 子の平均。ラップ translate の t 移動も往復一致 */
{
  const s1 = makeNode('sphere', { center: [0, 0, 0], radius: 1 });
  const s2 = makeNode('sphere', { center: [2, 0, 0], radius: 1 });
  const g = makeNode('smooth-union', { k: 0.2 }, [s1, s2]);
  const root = makeNode('union', {}, [g]);
  ok(near(worldAnchor(root, g.id), [1, 0, 0]), 'グループ anchor = 子の平均');
}

/* 7. 核: 回転祖先チェーンの下での往復一致。
      dl = worldToLocalDelta(dW) を center に足すと anchor がちょうど dW 動く */
{
  const s = makeNode('sphere', { center: [0.4, 1.1, -0.6], radius: 0.5 });
  const r2 = makeNode('rotate', { deg: [15, -70, 42], pivot: [0.1, 0.2, -0.3] }, [s]);
  const t1 = makeNode('translate', { t: [0.5, 1.0, 0] }, [r2]);
  const r1 = makeNode('rotate', { deg: [31, 47, 13], pivot: [0.3, -0.2, 0.5] }, [t1]);
  const root = makeNode('smooth-union', { k: 0.2 }, [r1]);

  const dW = [0.2, -0.3, 0.7];
  const before = worldAnchor(root, s.id);
  const dl = worldToLocalDelta(root, s.id, dW);
  for (let i = 0; i < 3; i++) s.props.center[i] += dl[i];
  const after = worldAnchor(root, s.id);
  const moved = after.map((v, i) => v - before[i]);
  ok(near(moved, dW, 1e-9), `回転チェーン下の往復一致: moved=(${moved.map(v => v.toFixed(6))})`);
}

/* 8. translate ノード自身を動かす場合も往復一致 (t は祖先フレーム) */
{
  const s = makeNode('sphere', { center: [0, 0.5, 0], radius: 0.5 });
  const t = makeNode('translate', { t: [1, 0, 0] }, [s]);
  const r = makeNode('rotate', { deg: [0, 30, 60], pivot: [1, 2, 3] }, [t]);
  const root = makeNode('union', {}, [r]);

  const dW = [-0.4, 0.25, 0.1];
  const before = worldAnchor(root, t.id);
  const dl = worldToLocalDelta(root, t.id, dW);
  for (let i = 0; i < 3; i++) t.props.t[i] += dl[i];
  const after = worldAnchor(root, t.id);
  ok(near(after.map((v, i) => v - before[i]), dW, 1e-9), 'translate.t 移動の往復一致');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
