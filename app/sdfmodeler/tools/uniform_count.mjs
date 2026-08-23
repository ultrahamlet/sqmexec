/* uniform_count.mjs — .ssq が sdfmodeler(WebGL) の uniform 上限に収まるか調べる。
 *
 * 症状「プレビューが真っ暗 / link error: ... exceeds MAX_FRAGMENT_UNIFORM_VECTORS(1024)」の
 * 原因切り分け用。ブラウザを開かずに、生成フラグメントシェーダの uniform 総数を数える。
 * GLSL ES では float 配列の 1 要素が 1 ベクトルを消費する (uPar[N] なら N vectors)。
 *
 * ※2026-07-15: 数値パラメータを float テクスチャ (R32F + texelFetch) に移したので、
 *   かつての主犯だった uPar[] は uniform を消費しなくなった。sweep の密化 (steps) や
 *   制御点数は uniform 数に一切影響しない。
 *   残る要因は uPartCol[]/uMatCol[] で、これは「1ノードあたり2 vectors」で効く
 *   → 実測の上限は約480ノード (500ノードで 1029 となり超過)。
 *
 * 使い方:
 *   cd /Users/user/Projects/sqm/sdfmodeler
 *   node tools/uniform_count.mjs ~/Desktop/model.ssq
 *
 * 詳細: docs/2026-07-15_sdfmodeler_WebGL_uniform上限.md
 */
import { parseScene } from '../js/model.js';
import { buildProgram } from '../js/codegen.js';
import fs from 'fs';

const LIMIT = 1024;                       /* 多くの環境の MAX_FRAGMENT_UNIFORM_VECTORS */
const SIZE = { float: 1, vec2: 1, vec3: 1, vec4: 1, mat3: 3, mat4: 4, int: 1, bool: 1 };

const path = process.argv[2];
if (!path) { console.error('usage: node tools/uniform_count.mjs <file.ssq>'); process.exit(1); }

const doc = parseScene(fs.readFileSync(path, 'utf8'));
const r = buildProgram(doc, null, {});
const src = typeof r === 'string' ? r : (r.frag || r.fs || r.fragment || '');

const rows = [];
let total = 0;
for (const line of src.split('\n')) {
  if (!/^\s*uniform\b/.test(line)) continue;
  const m = /uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+(\w+)\s*(\[\s*(\d+)\s*\])?/.exec(line);
  if (!m) continue;
  const [, type, name, , cnt] = m;
  const vectors = (SIZE[type] ?? 1) * (cnt ? +cnt : 1);
  total += vectors;
  rows.push({ vectors, type, name: name + (cnt ? `[${cnt}]` : '') });
}
rows.sort((a, b) => b.vectors - a.vectors);
for (const x of rows) console.log(`${String(x.vectors).padStart(5)}  ${x.type} ${x.name}`);

let nodes = 0;
const walk = n => { nodes++; (n.children || []).forEach(walk); };
for (const o of doc.objects) walk(o.root);

console.log('-'.repeat(44));
console.log(`ノード数 ${nodes}`);
console.log(`合計 ${total} vectors / 上限 ${LIMIT} → ` +
            (total <= LIMIT ? `✅ 余裕 ${LIMIT - total}` : `❌ ${total - LIMIT} 超過 = プレビューが真っ暗になる`));
if (total > LIMIT)
  console.log('対処: ノードを減らす。uPartCol[]/uMatCol[] が 1ノード=2 vectors で効くのが要因で、\n'
            + '      sweep の steps や制御点数は (float テクスチャ化により) 一切影響しない。');
