/* pngmeta.js — sqm が PNG に埋めた iTXt メタデータを読む。
 *
 * sqm は出力 PNG の IEND 直前に iTXt チャンクを挿し込む (dist/png_meta.cpp):
 *
 *   sqm:cmdline     再現コマンド
 *   sqm:cwd         実行ディレクトリ
 *   sqm:env         SQM_* 環境変数
 *   sqm:scene-path  シーンファイルのパス
 *   sqm:scene       **シーン本文** (zlib 圧縮)
 *
 * これを読めると、**レンダリング結果の PNG をそのままモデラーに投げ込んで
 * 元のシーンを開ける**。画像がシーンを持ち歩いているのと同じで、.ssq を
 * 別に管理しなくてよくなる。
 *
 * iTXt のレイアウト (PNG 仕様):
 *   keyword \0 compflag(1) compmethod(1) langtag \0 translated \0 text
 * compflag=1 のとき text は **zlib ストリーム** (compmethod=0)。
 * ブラウザの DecompressionStream('deflate') が zlib ラッパ付きを解けるので
 * 外部ライブラリは要らない (raw deflate は 'deflate-raw' で別物 — 取り違えると
 * 「不正なストリーム」で落ちる)。
 *
 * ⚠ tools/png_meta.py と同じものを読んでいる。片方の書式を変えたら両方直すこと。
 */

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 8) return false;
  return SIG.every((v, i) => b[i] === v);
}

/* PNG のチャンクを順に返す (type, data) */
function* chunks(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  let p = 8;                                    /* シグネチャの後ろから */
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const start = p + 8;
    if (start + len > b.length) return;         /* 壊れている: 黙って終わる */
    yield { type, data: b.subarray(start, start + len) };
    p = start + len + 4;                        /* +4 = CRC */
    if (type === 'IEND') return;
  }
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function')
    throw new Error('このブラウザは DecompressionStream に未対応です');
  const ds = new DecompressionStream('deflate');     /* zlib ラッパ付き */
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* iTXt を1つ解く → {keyword, text} (text は展開後) */
async function readItxt(data) {
  let i = data.indexOf(0);
  if (i < 0) return null;
  const dec = new TextDecoder('utf-8');
  const keyword = dec.decode(data.subarray(0, i));
  const compFlag = data[i + 1];
  const compMethod = data[i + 2];
  let p = i + 3;
  const skipZ = () => { const q = data.indexOf(0, p); p = (q < 0 ? data.length : q + 1); };
  skipZ();                                       /* language tag */
  skipZ();                                       /* translated keyword */
  const raw = data.subarray(p);
  if (!compFlag) return { keyword, text: dec.decode(raw) };
  if (compMethod !== 0) throw new Error(`未知の圧縮方式 ${compMethod} (${keyword})`);
  return { keyword, text: dec.decode(await inflate(raw)) };
}

/**
 * PNG の ArrayBuffer から sqm のメタデータを全部読む。
 * @returns {Promise<Object>} keyword → text の辞書 (無ければ空)
 */
export async function readPngMeta(buf) {
  if (!isPng(buf)) throw new Error('PNG ではありません');
  const out = {};
  for (const c of chunks(buf)) {
    if (c.type !== 'iTXt' && c.type !== 'tEXt') continue;
    if (c.type === 'tEXt') {                     /* 非圧縮の古い形式も一応読む */
      const i = c.data.indexOf(0);
      if (i < 0) continue;
      const dec = new TextDecoder('latin1');
      out[dec.decode(c.data.subarray(0, i))] = dec.decode(c.data.subarray(i + 1));
      continue;
    }
    try {
      const kv = await readItxt(c.data);
      if (kv) out[kv.keyword] = kv.text;
    } catch (e) {
      console.warn('iTXt を読めません:', e);     /* 1つ壊れても他は読む */
    }
  }
  return out;
}

/**
 * PNG からシーン本文 (.ssq) を取り出す。
 * @returns {Promise<{scene: string, meta: Object}>}
 * @throws sqm が埋めたシーンが無いとき (他のツールで作った PNG など)
 */
export async function readPngScene(buf) {
  const meta = await readPngMeta(buf);
  const scene = meta['sqm:scene'];
  if (!scene)
    throw new Error('この PNG に sqm のシーンが埋まっていません '
      + '(sqm 以外で作った画像か、SQM_PNG_META=0 で焼いた画像です)');
  return { scene, meta };
}
