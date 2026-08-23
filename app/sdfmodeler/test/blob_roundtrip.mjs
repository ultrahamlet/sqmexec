/* blob_roundtrip.mjs — blob 対応の入出力検証 (2026-08-23, node で実行)
 *
 *   node test/blob_roundtrip.mjs <scene.ssq> [out.ssq]
 *
 * parseScene → serializeScene の往復で blob パラメータと no-blend ペアが
 * 無損失かを検査し、書き出しを out.ssq へ置く (呼び出し側が mbmesh_test で
 * 原本とメッシュ比較する)。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseScene, serializeScene } from '../js/model.js';

const src = readFileSync(process.argv[2], 'utf8');
const doc = parseScene(src);
const out = serializeScene(doc, doc.camera);
if (process.argv[3]) writeFileSync(process.argv[3], out);

/* 再パースして blob 集合と no-blend を突き合わせ */
const doc2 = parseScene(out);
const key = n => JSON.stringify([
  n.props.center, n.props.scale, n.props.rot, n.props.weight,
  n.props.threshold, n.props.group, n.props.e1, n.props.e2, n.props.e3,
  n.props.isSuper,
  n.props.deformAmp, n.props.deformFreq, n.props.deformPhase, n.props.deformMode]);
const blobsOf = d => {
  const out2 = [];
  const walk = n => { if (n.type === 'blob') out2.push(key(n)); n.children.forEach(walk); };
  d.objects.forEach(o => walk(o.root));
  return out2.sort();
};
const a = blobsOf(doc), b = blobsOf(doc2);
let ok = true;
if (a.length !== b.length) { console.error(`blob数不一致 ${a.length} vs ${b.length}`); ok = false; }
for (let i = 0; i < Math.min(a.length, b.length); i++)
  if (a[i] !== b[i]) { console.error('blob差分:\n  ' + a[i] + '\n  ' + b[i]); ok = false; break; }
const pj = d => JSON.stringify((d.nbPairs || []).slice().sort());
if (pj(doc) !== pj(doc2)) { console.error('no-blend不一致', pj(doc), pj(doc2)); ok = false; }
console.log(`blob ${a.length} 個 / no-blend ${(doc.nbPairs || []).length} ペア / 往復${ok ? '一致' : '不一致'}`);
process.exit(ok ? 0 : 1);
