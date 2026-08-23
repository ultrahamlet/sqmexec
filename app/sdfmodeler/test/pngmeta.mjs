/* pngmeta.mjs — sqm が PNG に埋めた iTXt メタデータの読み出し検証。
 *   node test/pngmeta.mjs
 *
 * fixtures/sqm_meta.png は sqm で焼いた小さな画像で、examples/arm.ssq の本文が
 * zlib 圧縮 iTXt として入っている。**このテストが守っているのは相互運用**:
 * 書き手は dist/png_meta.cpp、読み手は js/pngmeta.js と tools/png_meta.py の3つあり、
 * どれか1つの書式が変わると黙って読めなくなる。
 *
 * ⚠ DecompressionStream は Node 18+ にある (ブラウザと同じ実装を通す)。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isPng, readPngMeta, readPngScene } from '../js/pngmeta.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

const buf = readFileSync(join(here, 'fixtures/sqm_meta.png'));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

ok(isPng(ab), 'PNG シグネチャを認識する');
ok(!isPng(new TextEncoder().encode('(scene )').buffer), 'テキストは PNG でない');

const meta = await readPngMeta(ab);
ok(!!meta['sqm:cmdline'], 'sqm:cmdline がある');
ok(meta['sqm:scene-path'].endsWith('arm.ssq'), 'sqm:scene-path が arm.ssq');

const { scene } = await readPngScene(ab);
ok(scene.startsWith(';'), 'シーン本文が取れた (先頭はコメント)');
ok(scene.includes('(scene'), 'シーン本文に (scene がある');

/* 元の .ssq と**バイト単位で一致**することまで見る (zlib 展開の取りこぼし検出) */
const orig = readFileSync(join(here, '../examples/arm.ssq'), 'utf8');
ok(scene === orig, '埋め込みシーンが examples/arm.ssq と完全一致');

/* メタの無い PNG は例外で落ちること (前のモデルを壊さないための分岐) */
let threw = false;
try {
  await readPngScene(readFileSync(join(here, 'fixtures/plain.png')).buffer);
} catch { threw = true; }
ok(threw, 'メタ無し PNG は例外になる');

console.log(fails ? `\n${fails} 件 FAIL` : '\nすべて ok');
process.exit(fails ? 1 : 0);
