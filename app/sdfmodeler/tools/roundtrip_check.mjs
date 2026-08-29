/* roundtrip_check.mjs — .ssq を sdfmodeler のパーサ/直列化に通して往復させ、
 * **編集して保存したときに何が失われるか**を先に知る。
 *
 *   node sdfmodeler/tools/roundtrip_check.mjs scenes/robot.ssq
 *
 * sdfmodeler が知らないノードは raw 保持されることもあれば落ちることもあるので、
 * 大きなモデルを持ち込む前にここで確かめる。⚠ 「開けた」は「保てる」ではない。
 */
import { readFileSync } from 'node:fs';
import { parseScene, serializeScene } from '../js/model.js';

const path = process.argv[2];
if (!path) { console.error('usage: roundtrip_check.mjs <scene.ssq>'); process.exit(2); }
const src = readFileSync(path, 'utf8');

const doc = parseScene(src);
const objs = doc.objects || [];
console.log(`読み込み: object ${objs.length} 個 / light ${(doc.lights || []).length}`);

// 何が raw のまま残ったか (= モデラーが構造として理解していない)
let rawCount = 0;
const walk = (n, f) => { if (!n) return; f(n); (n.children || []).forEach(c => walk(c, f)); };
const types = new Map();
for (const o of objs) walk(o.root, n => {
  types.set(n.type, (types.get(n.type) || 0) + 1);
  if (n.type === 'raw') rawCount++;
});
console.log('ノード種別:', [...types.entries()].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}:${v}`).join(' '));

const out = serializeScene(doc, doc.camera);
const doc2 = parseScene(out);

// ① object の数が保たれるか
const n1 = objs.length, n2 = (doc2.objects || []).length;
// ② 材質テキストが 1 文字も変わっていないか (pbrsurface / constant は
//    モデラーが解釈しないので、文字列として保たれることが条件)
let surfSame = 0, surfDiff = [];
for (let i = 0; i < Math.min(n1, n2); i++) {
  if (objs[i].surface === doc2.objects[i].surface) surfSame++;
  else surfDiff.push(objs[i].name);
}
// ③ 幾何が保たれるか — 2 回目の直列化が 1 回目と一致すれば安定 (不動点)
const out2 = serializeScene(doc2, doc2.camera);
const stable = (out === out2);

const ok = (n1 === n2) && (surfDiff.length === 0) && stable && rawCount === 0;
console.log(`\n  ${n1 === n2 ? 'OK  ' : 'FAIL'} object 数が保たれる          ${n1} → ${n2}`);
console.log(`  ${surfDiff.length === 0 ? 'OK  ' : 'FAIL'} 材質テキストが不変          ` +
            `${surfSame}/${Math.min(n1, n2)}` +
            (surfDiff.length ? `  失った: ${surfDiff.slice(0, 4).join(',')}` : ''));
console.log(`  ${rawCount === 0 ? 'OK  ' : 'WARN'} 未解釈 (raw) ノード          ${rawCount}`);
console.log(`  ${stable ? 'OK  ' : 'FAIL'} 2 回目の直列化が一致 (不動点) ${stable}`);
console.log(`\n${ok ? '往復しても失われない — sdfmodeler で編集して保存してよい'
                    : '⚠ 往復で失われるものがある。上の FAIL/WARN を見ること'}`);
process.exit(ok ? 0 : 1);
