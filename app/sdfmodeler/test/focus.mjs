/* focus.mjs — フォーカスシェーダ (buildProgram の focusSet) の検証。
 *   node test/focus.mjs
 * focus 外リーフの距離関数呼び出しが GLSL から消え (d=1e9 化)、layout は不変で
 * params が流用できることを確認する。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene, SCHEMA } from '../js/model.js';
import { buildProgram, collectParams, buildLayout } from '../js/codegen.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

const doc = parseScene(readFileSync(join(here, '../examples/trex.ssq'), 'utf8'));

/* 全リーフ id を集める + 尾の付け根の1リーフだけを focus に */
const leafIds = [];
const walk = n => { if ((SCHEMA[n.type] || {}).kind === 'leaf' && n.type !== 'plane') leafIds.push(n.id); n.children.forEach(walk); };
for (const o of doc.objects) walk(o.root);
ok(leafIds.length > 15, `trex リーフ数 ${leafIds.length}`);

const focus = new Set(leafIds.slice(0, 2));   /* 先頭2リーフだけ */
const full = buildProgram(doc);
const foc = buildProgram(doc, focus);

/* layout 不変 = params 流用可 */
ok(full.layout.parCount === foc.layout.parCount, 'layout.parCount が focus で不変');
const p1 = collectParams(doc, full.layout), p2 = collectParams(doc, foc.layout);
ok(p1.length === p2.length, 'collectParams 長さ一致 (params 流用可)');

/* focus シェーダは実距離関数呼び出しが激減、d=1e9 が大量に増える */
const cntCall = s => (s.match(/sdCapsule|sdRoundConeAB|sdBox|sdEllipsoid|length\(/g) || []).length;
const cnt1e9 = s => (s.match(/= 1e9;/g) || []).length;
ok(cntCall(foc.frag) < cntCall(full.frag), `距離関数呼び出しが減る (full ${cntCall(full.frag)} → focus ${cntCall(foc.frag)})`);
ok(cnt1e9(foc.frag) > cnt1e9(full.frag) + 10, `d=1e9 が増える (full ${cnt1e9(full.frag)} → focus ${cnt1e9(foc.frag)})`);

/* focus=全リーフなら full と実質同等 (呼び出し数一致) */
const allFocus = buildProgram(doc, new Set(leafIds));
ok(cntCall(allFocus.frag) === cntCall(full.frag), 'focus=全リーフは full と同じ距離関数数');

/* 引数なし buildProgram は従来通り (回帰なし) */
ok(!full.frag.includes('undefined') && full.frag.includes('sdObj0'), 'focus無し buildProgram は健全');

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
