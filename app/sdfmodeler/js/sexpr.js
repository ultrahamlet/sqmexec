/* sexpr.js — .ssq 用 S式トークナイザ/パーサ/シリアライザ。
 * 表現: リスト=Array, アトム=string, 文字列リテラル={str:"..."}。
 * 数値もアトム(string)のまま保持し、解釈層で parseFloat する。 */

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ';') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '(' || c === ')') { toks.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') { s += src[j]; j++; }
      toks.push({ str: s }); i = j + 1; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    let j = i, s = '';
    while (j < n && !/[\s()";]/.test(src[j])) { s += src[j]; j++; }
    toks.push(s); i = j;
  }
  return toks;
}

export function parseAll(src) {
  const toks = tokenize(src);
  let pos = 0;
  function parseOne() {
    const t = toks[pos++];
    if (t === '(') {
      const list = [];
      while (pos < toks.length && toks[pos] !== ')') list.push(parseOne());
      pos++; // ')'
      return list;
    }
    return t;
  }
  const out = [];
  while (pos < toks.length) {
    if (toks[pos] === ')') { pos++; continue; }
    out.push(parseOne());
  }
  return out;
}

/* 数値を .ssq らしく整形 (6有効桁, 余分なゼロなし) */
export function fmt(v) {
  if (typeof v === 'string') return v;
  if (!isFinite(v)) return '0';
  const r = Number(v.toPrecision(6));
  return String(r);
}

export function isList(x) { return Array.isArray(x); }

/* コンパクト・シリアライザ (1行) */
export function serialize(sx) {
  if (Array.isArray(sx)) return '(' + sx.map(serialize).join(' ') + ')';
  if (sx && typeof sx === 'object' && 'str' in sx) return '"' + sx.str + '"';
  return String(sx);
}

/* インデント付きシリアライザ: 全要素アトムのリストは1行に */
export function serializePretty(sx, indent = 0, width = 100) {
  const flat = serialize(sx);
  if (!Array.isArray(sx) || flat.length + indent <= width) return flat;
  const pad = '  '.repeat(indent + 1);
  const head = [];
  let i = 0;
  while (i < sx.length && !Array.isArray(sx[i])) { head.push(serialize(sx[i])); i++; }
  const parts = [];
  for (; i < sx.length; i++) parts.push(serializePretty(sx[i], indent + 1, width));
  return '(' + head.join(' ') + (parts.length ? '\n' + pad + parts.join('\n' + pad) : '') + ')';
}
