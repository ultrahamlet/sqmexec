/* sunion_sentinel.mjs — 「番兵 1e9 を smooth 合成しない」回帰テスト。
 *   node test/sunion_sentinel.mjs
 *
 * 2026-08-24 の障害: 枝刈り版 smooth-union が累算器を 1e9 で初期化し、最初の子も
 * sUnion(子, 1e9, k) で畳んでいた。数式上は「子の距離」が返るはずだが、GLSL の
 * mix(db,da,h) = db + (da-db)*h は fp32 の 1e9 付近の刻み (64) で桁落ちし、
 * 子の距離が 32 未満だと 0 が返る → オブジェクトが全空間で距離0 = 画面を埋める塊。
 * docs/2026-08-24_sdfmodeler_smooth-union番兵1e9の桁落ち.md 参照。
 *
 * このバグは「生成 GLSL の文字列」も「パラメータ」も正しく GPU 上の数値だけが
 * 壊れていたため、既存の codegen テストでは原理的に捕まらなかった。ここでは
 *   ① 生成 GLSL に「まだ 1e9 の累算器と smooth 合成する行」が現れないこと (静的)
 *   ② 出荷している sUnion/sInter の式が fp32 で桁落ちしないこと (数値)
 * の2方向から押さえる。
 *
 * ⚠ ①は上から下への線形走査なので **分岐の中で番兵になる経路は見えない**
 *   (枝刈り経路の `if (..) { d = <focus外の1e9>; } else d = lb;` は、else の代入で
 *    番兵が解けたように見える)。実行時にその if を通ると db が 1e9 になるが、
 *    ②の書き換えでどの経路でも潰れないので実害は無い。**保証しているのは②で、
 *    ①は「壊れた畳み込みを書き戻していないか」の見張り**、という役割分担。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseScene } from '../js/model.js';
import { buildProgram } from '../js/codegen.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok ' : 'FAIL ') + msg); if (!cond) fails++; };

/* ── ① 静的検査: 番兵のまま smooth 合成していないか ─────────────────── */

/* 括弧の深さを見て第一階層のカンマだけで割る (parAt(49) 等を壊さない) */
function splitArgs(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* line[open] の '(' に対応する ')' までの中身 */
function inner(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 1, i);
  }
  return line.slice(open + 1);
}

/* GLSL を上から舐め、「まだ 1e9 のままの変数」を追跡する。
 * 生成コードは if/else の両枝が同じ変数に代入するので、線形走査で番兵として
 * 見えるのは最初の畳み込みだけ。回帰検出には十分 (1件でも出れば落ちる)。 */
function sentinelFolds(frag) {
  const bad = [];
  const sentinel = new Set();
  for (const raw of frag.split('\n')) {
    const line = raw.trim();
    /* ① この行の smooth 合成を全て調べる。危険なのは第2引数 (db) — h=1 に
       飽和したとき da の情報が消える。第1引数が番兵なら h=0 に飽和して db が
       そのまま返るので安全。union の min も安全なので対象外。 */
    const call = /\b(?:sUnion|sInter)(?:Round|Deep|Cham)?\(/g;
    let m;
    while ((m = call.exec(line))) {
      const args = splitArgs(inner(line, m.index + m[0].length - 1));
      if (args.length >= 2 && (sentinel.has(args[1]) || args[1] === '1e9')) bad.push(line);
    }
    /* ② 代入で番兵状態を更新。1行に複数文が乗る (for 内の代入、{ } 一括) ので
       全部拾う。==/<=/>=/!= は lhs 側の \w+ か [^=;] のどちらかで弾かれる。 */
    const asg = /([A-Za-z_]\w*)\s*=\s*([^=;][^;]*);/g;
    let a;
    while ((a = asg.exec(line))) {
      const rhs = a[2].trim();
      /* 別名 (d4 = d6;) も伝播させる — 枝刈り経路は最初の子を代入で種にするので、
         その子が focus 外の 1e9 だと累算器ごと番兵になる */
      if (rhs === '1e9' || sentinel.has(rhs)) sentinel.add(a[1]); else sentinel.delete(a[1]);
    }
  }
  return bad;
}

/* 検出器そのものが効いているか (旧コードを模した文字列で自己検査) */
{
  const buggy = [
    'float d4 = 1e9;',
    '  d4 = sUnion(d6, d4, parAt(49));',
    '} else d4 = sUnion(lb5, d4, parAt(49));',
  ].join('\n');
  const fixed = [
    'float d4 = 1e9;',
    '  d4 = d6;',
    '} else d4 = lb5;',
    '  d4 = sUnion(d10, d4, parAt(49));',
  ].join('\n');
  ok(sentinelFolds(buggy).length >= 1,
     `検出器の自己検査: 旧コードを検出 (${sentinelFolds(buggy).length} 件)`);
  ok(sentinelFolds(fixed).length === 0, '検出器の自己検査: 修正後コードは検出 0 件');
  /* 番兵が第1引数なら安全 = 誤検出しない */
  ok(sentinelFolds('float d0 = 1e9;\nd1 = sUnion(d0, d2, 0.1);').length === 0,
     '検出器の自己検査: 第1引数の番兵は安全 (誤検出しない)');
  /* union の min は番兵と合成しても安全 = 誤検出しない */
  ok(sentinelFolds('float d0 = 1e9;\nd0 = min(d0, d3);').length === 0,
     '検出器の自己検査: union の min は誤検出しない');
  /* 別名を経由した番兵も追う */
  ok(sentinelFolds([
    'float d0 = 1e9;',
    'float d1 = d0;',
    'd1 = sUnion(d2, d1, 0.1);',
  ].join('\n')).length === 1, '検出器の自己検査: 別名 (d1 = d0) 越しの番兵も検出');
  /* for ループ内の代入で番兵が解ける (sweep の d = 1e9 → ループで min) */
  ok(sentinelFolds([
    'float d5 = 1e9;',
    'for (int i_ = 0; i_ < 24; i_++) d5 = min(d5, sdSweepProfSeg(q3, 19, 25, i_, 4));',
    'float d6 = sUnion(d2, d5, parAt(0));',
  ].join('\n')).length === 0, '検出器の自己検査: for 内の代入も番兵解除として拾う');
}

const SCENES = ['rabbit', 'trex', 'human', 'dog', 'frog', 'spider', 'ant', 'hand',
                'penguin_blob', 'humanbody', '_prunetest'];
for (const name of SCENES) {
  const doc = parseScene(readFileSync(join(here, `../examples/${name}.ssq`), 'utf8'));
  const bad = sentinelFolds(buildProgram(doc).frag);
  ok(bad.length === 0, `${name}.ssq: 番兵との smooth 合成なし` + (bad.length ? ` — ${bad[0]}` : ''));
}

/* フォーカスシェーダ (focus 外リーフが 1e9 になる) も番兵源。
   枝刈り経路の累算器と重なると同じ潰れ方をするので一緒に見張る */
{
  const doc = parseScene(readFileSync(join(here, '../examples/trex.ssq'), 'utf8'));
  const leaves = [];
  const walk = n => { if (!n.children.length) leaves.push(n.id); n.children.forEach(walk); };
  for (const o of doc.objects) walk(o.root);
  for (const [label, set] of [['先頭2', leaves.slice(0, 2)],
                              ['末尾2', leaves.slice(-2)],
                              ['1つ飛ばし', leaves.filter((_, i) => i % 2 === 0)]]) {
    const bad = sentinelFolds(buildProgram(doc, new Set(set)).frag);
    ok(bad.length === 0, `trex focus(${label}): 番兵との smooth 合成なし` +
       (bad.length ? ` — ${bad[0]}` : ''));
  }
}

/* 非表示の子が末尾にある smooth-union。probe/inst 経路の右fold は
   「末尾の子」を種にするので、そこが 1e9 だと番兵合成になる */
{
  const doc = parseScene(`(scene
  (camera (from 0 2 -6) (at 0 1 0) (up 0 1 0) (fov 40))
  (light (pos 5 6 -5)(intensity 1.2))
  (object "m" (surface (color 0.6 0.6 0.6))
    (sdf (smooth-union (k 0.2)
      (sphere (center -0.4 1 0) (radius 0.5))
      (sphere (center  0.4 1 0) (radius 0.5))
      (sphere (center  0.0 1.6 0) (radius 0.3))))))`);
  const kids = doc.objects[0].root.children;
  kids[kids.length - 1].hidden = true;          /* 末尾を非表示 = 1e9 化 */
  const bad = sentinelFolds(buildProgram(doc).frag);
  ok(bad.length === 0, '末尾の子が非表示でも番兵合成にならない' + (bad.length ? ` — ${bad[0]}` : ''));
}

/* 枝刈り経路がブレンド種別を落としていないか (同 2026-08-24。round 指定が
   黙って poly で描かれていた)。子2個 = PRUNE_MIN_CHILDREN で枝刈り経路に入る */
{
  const scene = mode => `(scene
  (camera (from 0 2 -6) (at 0 1 0) (up 0 1 0) (fov 40))
  (light (pos 5 6 -5)(intensity 1.2))
  (object "m" (surface (color 0.6 0.6 0.6))
    (sdf (smooth-union (k 0.2) (mode ${mode})
      (sphere (center -0.4 1 0) (radius 0.5))
      (sphere (center  0.4 1 0) (radius 0.5))))))`;
  for (const [mode, fn] of [['round', 'sUnionRound'], ['deep', 'sUnionDeep'],
                            ['chamfer', 'sUnionCham'], ['poly', 'sUnion']]) {
    const doc = parseScene(scene(mode));
    const obj = buildProgram(doc).frag.match(/float sdObj0\(vec3 p0\)\{[\s\S]*?\n\}/)[0];
    /* poly は素の sUnion。変種は sUnionXxx が出ていること */
    const hit = mode === 'poly'
      ? /[^\w]sUnion\(/.test(obj) && !/sUnion(Round|Deep|Cham)\(/.test(obj)
      : new RegExp(`[^\\w]${fn}\\(`).test(obj);
    ok(hit, `(mode ${mode}) が枝刈り経路でも ${fn} を吐く`);
  }
}

/* ── ② 数値検査: 出荷している式が fp32 で桁落ちしないか ───────────────── */

/* 出荷 GLSL が差分形 (min/max からの差) になっているか。
   mix(db, da, h) 形に戻すと ① を通っても GPU 上で再発する。 */
{
  /* sUnion と sInter の両方が使われるシーンで見る */
  const frag = buildProgram(parseScene(`(scene
  (camera (from 0 2 -6) (at 0 1 0) (up 0 1 0) (fov 40))
  (light (pos 5 6 -5)(intensity 1.2))
  (object "m" (surface (color 0.6 0.6 0.6))
    (sdf (smooth-union (k 0.2)
      (sphere (center -0.4 1 0) (radius 0.5))
      (smooth-intersect (k 0.1)
        (sphere (center 0.4 1 0) (radius 0.5))
        (box (center 0.4 1 0) (size 0.4 0.4 0.4)))))))`)).frag;
  for (const fn of ['sUnion', 'sInter']) {
    const hit = frag.match(new RegExp(`float ${fn}\\(float da, float db, float k\\)\\{[\\s\\S]*?\\n\\}`));
    if (!ok(!!hit, `${fn} が生成シェーダに在る (枝刈りで消えていない)`)) continue;
    const b = hit[0].replace(/\/\*[\s\S]*?\*\//g, '');   /* 注釈は式ではないので剥がす */
    ok(!/\bmix\(/.test(b), `${fn} は mix( を使わない (番兵で桁落ちする形に戻していない)`);
    ok(/min\(da, db\)/.test(b) && /max\(da, db\)/.test(b), `${fn} は min/max からの差分形`);
  }
}

/* fp32 を模した参照実装。GLSL と同じ順序で Math.fround を挟む。 */
const f = Math.fround;
const clamp32 = (x, a, b) => f(Math.min(b, Math.max(a, x)));

/* 旧実装 (バグの再現用): h = clamp(0.5 + 0.5*(db-da)/k), mix(db,da,h) - k*h*(1-h) */
function sUnionOld(da, db, k) {
  k = f(Math.max(k, 1e-6));
  const h = clamp32(f(0.5 + f(f(0.5 * f(db - da)) / k)), 0, 1);
  return f(f(f(db) + f(f(da - db) * h)) - f(k * f(h * f(1 - h))));
}
/* 現行実装: m + g*e - k*g*(1-g) */
function sUnionNew(da, db, k) {
  k = f(Math.max(k, 1e-6));
  const m = f(Math.min(da, db));
  const e = f(f(Math.max(da, db)) - m);
  const g = clamp32(f(0.5 - f(f(0.5 * e) / k)), 0, 0.5);
  return f(f(m + f(g * e)) - f(k * f(g * f(1 - g))));
}
function sInterNew(da, db, k) {
  k = f(Math.max(k, 1e-6));
  const M = f(Math.max(da, db));
  const e = f(M - f(Math.min(da, db)));
  const g = clamp32(f(0.5 - f(f(0.5 * e) / k)), 0, 0.5);
  return f(f(M - f(g * e)) + f(k * f(g * f(1 - g))));
}

/* バグが実在したことの固定 (ここが落ちたら fp32 モデルの方が壊れている) */
ok(sUnionOld(5, 1e9, 0.08) === 0,
   `旧式は fp32 で潰れる: sUnion(5, 1e9, 0.08) = ${sUnionOld(5, 1e9, 0.08)} (期待 0)`);
ok(sUnionOld(50, 1e9, 0.08) === 64,
   `旧式は 64 の倍数に量子化: sUnion(50, 1e9, 0.08) = ${sUnionOld(50, 1e9, 0.08)}`);

/* 現行式は番兵でも da をそのまま返す */
for (const da of [0.001, 0.5, 5, 31.9, 32.1, 300]) {
  ok(sUnionNew(da, 1e9, 0.08) === f(da),
     `sUnion(${da}, 1e9, 0.08) = ${sUnionNew(da, 1e9, 0.08)} (期待 ${f(da)})`);
}
ok(sUnionNew(-2.5, 1e9, 0.2) === f(-2.5), 'sUnion(-2.5, 1e9, 0.2) = -2.5 (内部の負値も保つ)');
ok(sInterNew(5, -1e9, 0.08) === 5, 'sInter(5, -1e9, 0.08) = 5 (交差側の番兵)');

/* 決定的な擬似乱数 (seed 固定 = 失敗が再現する) */
const mkRnd = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/* 通常域では旧式と一致 (書き換えが数式的に同値であること) */
{
  let worst = 0, at = null;
  const rnd = mkRnd(12345);
  for (let i = 0; i < 20000; i++) {
    const k = 0.01 + rnd() * 0.5;
    const da = (rnd() - 0.5) * 20, db = (rnd() - 0.5) * 20;
    const d = Math.abs(sUnionOld(da, db, k) - sUnionNew(da, db, k));
    if (d > worst) { worst = d; at = [da, db, k]; }
  }
  ok(worst < 1e-5, `通常域で旧式と一致 (最大差 ${worst.toExponential(2)}` +
     (at ? ` @ da=${at[0].toFixed(3)} db=${at[1].toFixed(3)} k=${at[2].toFixed(3)}` : '') + ')');
}

/* ── sSub (smooth-subtract) も番兵に安全か ──────────────────────
   2026-08-24 追加。sUnion/sInter を差分形に直したとき sSub だけ旧 mix 形が
   残っていた。踏むのは da が -1e9 のとき = invert が空集合の子を符号反転する
   (smooth-subtract (invert <非表示/blob/mesh>) X) の形。h が 1 に飽和し
   da + (-db - da) が 1e9 の刻み 64 で潰れる (X=50 なら -64 / X<32 なら 0)。
   現在は sSub(da,db,k) = -sUnion(-da,db,k) に委譲して桁落ちしない。 */
function sSubOld(da, db, k) {                    /* 旧式 (再発検出用に残す) */
  k = f(Math.max(k, 1e-6));
  const h = clamp32(f(0.5 - f(f(0.5 * f(da + db)) / k)), 0, 1);
  return f(f(f(da) + f(f(f(-db) - da) * h)) + f(k * f(h * f(1 - h))));
}
const sSubNew = (da, db, k) => f(-sUnionNew(f(-da), db, k));
{
  const K = 0.08;
  ok(sSubOld(-1e9, 5, K) === 0, '旧 sSub は fp32 で潰れる: sSub(-1e9, 5, 0.08) = ' + sSubOld(-1e9, 5, K));
  ok(sSubOld(-1e9, 50, K) === -64, '旧 sSub は 64 の倍数に量子化: ' + sSubOld(-1e9, 50, K));
  for (const b of [0.001, 0.5, 5, 31.9, 50, 300, -2.5]) {
    const got = sSubNew(-1e9, b, K), want = f(-b);
    ok(Math.abs(got - want) <= Math.max(1e-4, Math.abs(want) * 1e-5),
       'sSub(-1e9, ' + b + ') = ' + got + ' (期待 ' + want + ')');
  }
  for (const a of [0.001, 5, 300, -2.5]) {
    const got = sSubNew(a, 1e9, K);
    ok(Math.abs(got - a) <= Math.max(1e-4, Math.abs(a) * 1e-5), 'sSub(' + a + ', 1e9) = ' + got + ' (無変化)');
  }
  ok(sSubNew(1e9, 5, K) >= 1e8, 'sSub(1e9, 5) = ' + sSubNew(1e9, 5, K) + ' (空集合のまま)');
  let worst = 0, at = null;
  const rnd = mkRnd(4242);
  for (let i = 0; i < 20000; i++) {
    const k = 0.01 + rnd() * 0.5;
    const da = (rnd() - 0.5) * 20, db = (rnd() - 0.5) * 20;
    const d = Math.abs(sSubOld(da, db, k) - sSubNew(da, db, k));
    if (d > worst) { worst = d; at = [da, db, k]; }
  }
  ok(worst < 1e-5, 'sSub 通常域で旧式と一致 (最大差 ' + worst.toExponential(2) +
     (at ? ' @ da=' + at[0].toFixed(3) + ' db=' + at[1].toFixed(3) + ' k=' + at[2].toFixed(3) : '') + ')');
}

/* 出荷 GLSL の sSub が桁落ちする mix 形に戻っていないか */
{
  const frag = buildProgram(parseScene('(scene (object "o" (sdf (sphere (center 0 0 0)(radius 1)))))')).frag;
  const m = frag.match(/float sSub\(float da, float db, float k\)\{[\s\S]*?\n\}/);
  ok(!!m, 'sSub が生成シェーダに在る');
  /* コメントは除いて判定する — 説明文に旧式を書いてあるため */
  const body = m ? m[0].replace(/\/\*[\s\S]*?\*\//g, '') : '';
  ok(!!m && !/mix\(\s*da\s*,\s*-db/.test(body), 'sSub が mix(da,-db,h) の桁落ち形に戻っていない');
}

/* sInter(a,b,k) = -sUnion(-a,-b,k) の恒等 */
{
  let worst = 0;
  const rnd = mkRnd(999);
  for (let i = 0; i < 20000; i++) {
    const k = 0.01 + rnd() * 0.5;
    const da = (rnd() - 0.5) * 20, db = (rnd() - 0.5) * 20;
    worst = Math.max(worst, Math.abs(sInterNew(da, db, k) + sUnionNew(-da, -db, k)));
  }
  ok(worst < 1e-5, `sInter(a,b,k) = -sUnion(-a,-b,k) (最大差 ${worst.toExponential(2)})`);
}

/* ブレンドが実際に効いていること (min に退化していない) */
{
  const v = sUnionNew(0.1, 0.1, 0.4);
  ok(v < 0.1 - 1e-4, `k 域内ではブレンドが効く: sUnion(0.1, 0.1, 0.4) = ${v.toFixed(4)} < 0.1`);
  ok(sUnionNew(0.1, 5.0, 0.4) === f(0.1), 'k 域外は min に一致');
}

console.log(fails ? `\n${fails} 件失敗` : '\n全テスト成功');
process.exit(fails ? 1 : 0);
