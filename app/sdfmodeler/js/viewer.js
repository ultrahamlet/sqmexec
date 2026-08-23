/* viewer.js — WebGL2 フルスクリーン・レイマーチビューア。
 * オービットカメラ (LMBドラッグ=回転, Shift/中/右=パン, ホイール=ズーム)、
 * クリックで GPU ピック (1x1 FBO に leaf id をエンコードして readPixels)。
 * 数値パラメータは R32F テクスチャで渡す (uniform 配列は 1024 ベクトルで頭打ちのため)。 */
import { PAR_TEX_W, colTexRows, GRID_MAX } from './codegen.js';

const VS = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/* ── メッシュプロキシ描画 (serve.py /__mesh__ の marching cubes 結果をラスタライズ) ──
 * レイマーチのコストはピクセル×ノード数だが、ラスタライズは三角形数のみに依存 →
 * 重いモデルでもカメラ/配置操作が 60fps。ボーン/ギズモは従来どおり onDraw オーバーレイ。 */
const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
uniform mat4 uMVP;
uniform mat4 uModel;    /* mesh(OBJ) ノード用のモデル変換。他は恒等 */
uniform mat3 uNrmMat;   /* (R·S)⁻ᵀ = R·S⁻¹ */
out vec3 vNrm;
out vec3 vPos;
out vec3 vCol;
void main(){
  vec3 wp = (uModel * vec4(aPos, 1.0)).xyz;
  vNrm = uNrmMat * aNrm; vPos = wp; vCol = aCol;
  gl_Position = uMVP * vec4(wp, 1.0); }`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vNrm;
in vec3 vPos;
in vec3 vCol;
uniform vec3 uEye;
uniform vec3 uCol;
uniform float uUseVCol;   /* 1 = 頂点色 (blob の evalSurf ブレンド)、0 = 単色 */
uniform float uBackDark;  /* 裏面暗化の強さ。blob/SDFメッシュ=1 (破れの穴を見せる) /
                             mesh(OBJ)=0 — 外部 OBJ は巻きが逆のものが実在し (three_groups)、
                             全面が「裏」と誤判定されて真っ黒になる。法線の向き自体は
                             下の nv<0 反転で照明に正しく効くので暗化だけ切る */
uniform vec3 uBgCol;
uniform int  uNL;         /* シーンライト (レイマーチ shade() と同じ照明式。影/AO 無し) */
uniform vec3 uLP[4];
uniform vec3 uLC[4];
out vec4 frag;
void main(){
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uEye - vPos);
  /* 裏面 (=内側) は法線を返しつつ**暗く**塗る。表と同じ明るさにすると、
     破れた等値面の穴から見える内壁が外面と見分けられず「穴が無い」ように
     見えてしまう (amp>iso の deform blob で実際に誤読された)。
     ⚠ 暗化は smoothstep で「明確に裏を向いた面」だけに掛ける — dot(N,V)<0 の
     硬い閾値だと、補間法線が 0 をまたぐ**すれすれの縁 (トーラスの稜線等) で
     判定がチラつき黒い斑**になる (2026-08-23 ユーザー報告)。すれすれ帯
     (|dot|<0.1) は暗化ゼロ、真の内壁 (正対して dot≈-1) は従来どおり暗い */
  float nv = dot(N, V);
  float back = 0.0;
  if (nv < 0.0) { N = -N; back = smoothstep(0.1, 0.35, -nv) * uBackDark; }
  vec3 alb = mix(uCol, vCol, uUseVCol);
  alb = mix(alb, alb * vec3(0.30, 0.28, 0.30), back);   /* 内側は暗く */
  /* ⚠ かつては固定の擬似2灯で塗っていて、シーンライトで照らされる SDF
     レイマーチ面と並ぶと blob だけ暗く見えた (「タイプ変更すると暗くなる」)。
     以下はレイマーチ shade() の環境項+ライト項の写し (影と AO を省いただけ) */
  vec3 c = alb * mix(vec3(0.22), uBgCol + 0.12, 0.55) * 0.55;
  for (int i = 0; i < 4; i++) {
    if (i >= uNL) break;
    vec3 lv = uLP[i] - vPos;
    vec3 l = normalize(lv);
    float dif = max(dot(N, l), 0.0);
    vec3 h = normalize(l + V);
    float spe = pow(max(dot(N, h), 0.0), 32.0) * 0.35;
    c += (alb * dif + spe * dif) * uLC[i];
  }
  float fre = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  c += fre * (uBgCol + 0.1) * 0.18 * (1.0 - back);
  float fog = clamp(length(uEye - vPos) * 0.012, 0.0, 0.5);
  frag = vec4(mix(c, uBgCol, fog), 1.0);
}`;

/* native blob メッシュの表示色 (プロキシと区別できる暖色ニュートラル) */
const BLOB_COL = [0.78, 0.70, 0.62];

const IDENT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const IDENT3 = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

const LINE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
uniform mat4 uMVP;
out vec3 vCol;
void main(){ vCol = aCol; gl_Position = uMVP * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 frag;
void main(){ frag = vec4(vCol, 1.0); }`;

/* メッシュモードの市松床 (レイマーチ床 codegen.js:1203 と同じ 0.32/0.42 市松+セル境界線)。
 * y=uGridY の大きな quad を描き、遠方はメッシュと同じ距離フォグで背景へ溶かす。 */
const FLOOR_VS = `#version 300 es
layout(location=0) in vec2 aXZ;
uniform mat4 uMVP;
uniform float uGridY;
out vec3 vWorld;
void main(){ vWorld = vec3(aXZ.x, uGridY, aXZ.y); gl_Position = uMVP * vec4(vWorld, 1.0); }`;

const FLOOR_FS = `#version 300 es
precision highp float;
in vec3 vWorld;
uniform vec3 uEye;
uniform vec3 uBgCol;
out vec4 frag;
void main(){
  vec2 p = vWorld.xz;
  float ch = mod(floor(p.x) + floor(p.y), 2.0);
  vec3 alb = mix(vec3(0.32), vec3(0.42), ch);
  vec2 g = abs(fract(p) - 0.5);
  float ln = smoothstep(0.47, 0.5, max(g.x, g.y));
  alb = mix(alb, vec3(0.2), ln * 0.6);
  float fog = clamp(length(uEye - vWorld) * 0.012, 0.0, 1.0);
  frag = vec4(mix(alb, uBgCol, fog), 1.0);
}`;

export class Viewer {
  constructor(canvas, { onPick, onCameraChange, onDraw, onContextRestored } = {}) {
    this.canvas = canvas;
    this.onPick = onPick || (() => {});
    this.onCameraChange = onCameraChange || (() => {});
    this.onDraw = onDraw || (() => {});
    this.onContextRestored = onContextRestored || (() => {});
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 が利用できません');
    this.gl = gl;
    this.prog = null;
    this.uni = {};
    /* シェーダのコンパイル待ちでUIが固まらないための2点 (2026-07-27):
       ①同一ソースのプログラムキャッシュ ②KHR_parallel_shader_compile による非同期リンク。
       ギズモを離すたびに endGizmoDrag→rebuild が正確シェーダを作り直しており、
       getProgramParameter(LINK_STATUS) がドライバのコンパイル完了を待つのでメインスレッドが
       止まっていた (招き猫の首輪のように 1サンプル数千反復のループを含むと数秒級)。 */
    this._progCache = new Map();       /* fragSrc → WebGLProgram (LRU) */
    this._progSeq = 0;                 /* 世代トークン: 古いコンパイルの結果を捨てる */
    this._parallelExt = gl.getExtension('KHR_parallel_shader_compile');
    this._vsShared = null;             /* 頂点シェーダは不変なので1回だけコンパイル */
    this.params = new Float32Array(1);
    this.objSpheres = new Float32Array([0, 0, 0, 1e9]);
    this.partColors = new Float32Array(3);
    this.matColors = new Float32Array(3);
    this.matOn = false;
    this.colors = [[0.7, 0.7, 0.7]];
    this.lights = [];
    this.bg = [0.16, 0.19, 0.24];
    this.selId = -1;
    this.grid = { on: true, y: 0 };
    this.axis = true;
    this.partColor = false;
    this.depth = false;       /* 深度モード (近=白, 遠=黒) */
    this.shadow = false;   /* 影は既定OFF (重いモデルの編集を軽く。UIの「影」で切替) */
    this.quality = 0.75;      /* 描画スケール (devicePixel 基準) */
    this.interactive = false; /* ドラッグ中は低解像度 + 影/AOオフ */
    this.interScale = 0.4;    /* 操作中の描画スケール (フレーム時間で自動調整) */
    this.boneOnly = false;    /* ボーン表示ON: ドラッグ中はレイマーチせず背景クリアのみ */
    this.meshProxy = false;   /* メッシュプロキシ表示 (setMeshParts 済みならラスタライズ) */
    this.meshContext = null;  /* ハイブリッド文脈 (null=オフ / n=object n 以外を重ねる) */
    this.cam = { target: [0, 0.5, 0], dist: 10, az: 0.5, el: 0.35, fov: 42 };
    this.dirty = true;
    this.compileMs = 0;

    this._initPickFbo();

    /* GPUハング (超重量モデルのレイマーチ描画) 等で WebGL コンテキストが失われても
       復旧できるようにする: lost を preventDefault で「復元可」にし、restored で
       GL 資源 (プログラム/テクスチャ/VAO) を全て作り直す。メッシュデータは
       _meshPartsData に typed array で保持しているので再アップロードで戻る。 */
    this._ctxLost = false;
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this._ctxLost = true;
      console.warn('WebGL context lost — 復旧待ち');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._ctxLost = false;
      this._drawErr = null;
      this._reinitGL();
      this.onContextRestored();
    });

    this._initEvents();
    const ro = new ResizeObserver(() => this.requestRender());
    ro.observe(canvas);
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _initPickFbo() {
    const gl = this.gl;
    /* pick 用 1x1 FBO */
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* コンテキスト復旧後: 旧コンテキスト由来の GL オブジェクト参照を全て捨てて作り直す */
  _reinitGL() {
    this.prog = null;
    this.uni = {};
    /* 旧コンテキストのプログラムは無効 — キャッシュごと捨てる (残すと復旧後に
       死んだ WebGLProgram を差し替えて真っ黒になる)。頂点シェーダも作り直す。 */
    this._progCache = new Map();
    this._progSeq++;                   /* 進行中のコンパイルの結果も捨てる */
    this._vsShared = null;
    this._parallelExt = this.gl.getExtension('KHR_parallel_shader_compile');
    this._parTex = null; this._parTexH = 0;
    this._colTex = null; this._colTexH = 0;
    this._meshProg = null; this._meshSlots = null; this._meshCounts = null;
    this._blobSlot = null; this._blobCount = 0;
    this._objSlots = null; this._objCounts = null;
    this._blobSelVao = null; this._blobSelVbo = null; this._blobSelCount = 0;
    this._lineProg = null; this._lineVao = null;
    this._floorProg = null; this._floorVao = null;
    this._initPickFbo();
    if (this._meshPartsData) this.setMeshParts(this._meshPartsData);
    if (this._blobData) this.setBlobMesh(this._blobData);
    if (this._objData) { this._objSlots = null; this._objCounts = null; this.setObjMeshes(this._objData); }
    if (this._blobSelData) this.setBlobSel(this._blobSelData);
    this.requestRender();
  }

  /* fragment uniform の上限 (vec4単位)。環境差があるので GL から実値を取る。
     超過すると link が失敗して真っ暗になるため、app 側で事前に警告する。 */
  get maxFragUniformVectors() {
    if (this._maxFUV == null)
      this._maxFUV = this.gl.getParameter(this.gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 0;
    return this._maxFUV;
  }

  /* ── シェーダ ── */
  /* fragSrc のプログラムを用意して差し替える。
     - 同一ソースが既にあればキャッシュから即差し替え (コンパイルしない)
     - KHR_parallel_shader_compile があればリンク完了をポーリングし、その間は
       **古いプログラムで描画を続ける** (UIが固まらない)
     - 例外を投げないので、リンク失敗は onError(Error) で受け取ること
       (非同期経路では throw が呼び出し元まで届かないため) */
  setProgram(fragSrc, onError, onDone) {
    const gl = this.gl;
    const hit = this._progCache.get(fragSrc);
    if (hit) {
      this._progCache.delete(fragSrc);          /* LRU: 参照したら最後尾へ */
      this._progCache.set(fragSrc, hit);
      this._progSeq++;                          /* 進行中のコンパイルを無効化 */
      this.compileMs = 0;
      this._useProgram(hit);
      if (onDone) onDone();
      return;
    }
    const t0 = performance.now();
    if (!this._vsShared) this._vsShared = this._compile(gl.VERTEX_SHADER, VS);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);                       /* ここでは COMPILE_STATUS を聞かない
                                                   (聞くとドライバの完了待ちで止まる) */
    const prog = gl.createProgram();
    gl.attachShader(prog, this._vsShared);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const token = ++this._progSeq;

    const finish = () => {
      if (token !== this._progSeq) {             /* 新しい要求に追い越された */
        gl.deleteProgram(prog);
        gl.deleteShader(fs);
        return;
      }
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const msg = gl.getProgramInfoLog(prog) ||
                    gl.getShaderInfoLog(fs) || '(no log)';
        gl.deleteProgram(prog);
        gl.deleteShader(fs);
        if (onError) onError(new Error('link error: ' + msg));
        else console.error('link error: ' + msg);
        return;
      }
      gl.deleteShader(fs);                       /* プログラムが参照を持つので解放してよい */
      this.compileMs = performance.now() - t0;
      this._cachePut(fragSrc, prog);
      this._useProgram(prog);
      if (onDone) onDone();
    };

    if (this._parallelExt) {
      /* rAF はタブ非表示で止まるので setTimeout で回す */
      const poll = () => {
        if (token !== this._progSeq) { gl.deleteProgram(prog); gl.deleteShader(fs); return; }
        if (gl.getProgramParameter(prog, this._parallelExt.COMPLETION_STATUS_KHR)) finish();
        else setTimeout(poll, 8);
      };
      poll();
    } else {
      finish();                                  /* 拡張が無ければ従来どおり同期 */
    }
  }
  _useProgram(prog) {
    this.prog = prog;
    this.uni = {};            /* uniform location はプログラム毎 */
    this.requestRender();
  }
  _cachePut(fragSrc, prog) {
    const MAX = 6;
    this._progCache.set(fragSrc, prog);
    while (this._progCache.size > MAX) {
      const [k, v] = this._progCache.entries().next().value;
      this._progCache.delete(k);
      if (v !== this.prog) this.gl.deleteProgram(v);   /* 使用中は消さない */
    }
  }
  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      console.error(src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      throw new Error('shader error: ' + log);
    }
    return sh;
  }
  /* パラメータを R32F テクスチャへ載せる。uniform 配列 (uPar[N]) だと GLSL ES の packing で
     1要素=1ベクトル消費 → MAX_FRAGMENT_UNIFORM_VECTORS(実測1024) で頭打ちになり、sweep の密化や
     ノード数でリンクできず真っ暗になっていた。テクスチャなら実質無制限 (16384² = 2.7億)。
     読み出しは codegen の parAt() = texelFetch (NEAREST・フィルタ無関係)。 */
  _uploadParams() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    if (!this._parTex) {
      this._parTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._parTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._parTexH = 0;
    }
    const h = Math.max(1, Math.ceil(this.params.length / PAR_TEX_W));
    gl.bindTexture(gl.TEXTURE_2D, this._parTex);
    if (h !== this._parTexH) {                    /* 高さが変わった時だけ再確保 */
      this._parTexH = h;
      this._parBuf = new Float32Array(PAR_TEX_W * h);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, PAR_TEX_W, h, 0, gl.RED, gl.FLOAT, null);
    }
    this._parBuf.set(this.params);                /* 余りは読まれないので0詰めのまま */
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PAR_TEX_W, h, gl.RED, gl.FLOAT, this._parBuf);
    gl.uniform1i(this._u('uParTex'), 0);
  }

  /* ── 取込メッシュの SDF グリッドを 3D テクスチャへ (TEXTURE2.. を使う) ──
     grids = [{key, dims:[nx,ny,nz], lo:[x,y,z], h, data:Float32Array}]。
     R32F は WebGL2 では既定でフィルタ不可 (OES_texture_float_linear 依存) なので
     NEAREST で張り、**シェーダ側で手動 trilinear** する (エンジンの sd_grid と同じ式)。
     枚数は GRID_MAX まで。超過分は codegen が箱にフォールバックする。 */
  setGrids(grids) {
    const gl = this.gl;
    this._grids = grids || [];
    if (!this._gridTex) this._gridTex = [];
    for (let i = 0; i < GRID_MAX; i++) {
      const g = this._grids[i];
      if (!g) continue;
      if (!this._gridTex[i]) this._gridTex[i] = gl.createTexture();
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_3D, this._gridTex[i]);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      /* ベイカーは x-major (z が最速) で書く = texelFetch(ivec3(iz,iy,ix)) になるよう
         width=nz, height=ny, depth=nx で張る (codegen の gridAt と対) */
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R32F, g.dims[2], g.dims[1], g.dims[0], 0,
                    gl.RED, gl.FLOAT, g.data);
    }
    this.requestRender();
  }

  /* setProgram の後に呼ぶ (uniform は program 毎) */
  _bindGrids() {
    const gl = this.gl;
    let neps = 0;
    if (this._grids && this._grids.length) {
      for (let i = 0; i < Math.min(GRID_MAX, this._grids.length); i++) {
        const g = this._grids[i];
        if (!this._gridTex[i] || !g) continue;
        gl.activeTexture(gl.TEXTURE2 + i);
        gl.bindTexture(gl.TEXTURE_3D, this._gridTex[i]);
        const loc = this._u('uGridTex' + i);
        if (loc) gl.uniform1i(loc, 2 + i);
        const lo = this._u('uGridLo' + i), dm = this._u('uGridDim' + i),
              hh = this._u('uGridH' + i);
        if (lo) gl.uniform3fv(lo, g.lo);
        if (dm) gl.uniform3f(dm, g.dims[0], g.dims[1], g.dims[2]);
        if (hh) gl.uniform1f(hh, g.h);
        if (g.h > neps) neps = g.h;
      }
    }
    /* 法線の差分幅の下限 = 3ボクセル (これ未満だと trilinear のセル境界が模様になる) */
    const ne = this._u('uGridNEps');
    if (ne) gl.uniform1f(ne, neps * 3.0);
  }

  /* パーツ識別色(上段) + 材質色(下段) を1枚の RGBA32F テクスチャへ載せる。
     uniform vec3 uPartCol[]/uMatCol[] は 1ノード=2 vectors 消費し、ノード数だけで上限1024に
     当たっていた (実測: リーフ480個まで)。テクスチャ化で天井を撤廃。
     段数は codegen と同じ colTexRows() を使うこと (ズレると別ノードの色を拾う)。 */
  _uploadColors() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    if (!this._colTex) {
      this._colTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._colTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._colTexH = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this._colTex);
    const rows = colTexRows(Math.max(1, this.partColors.length / 3));
    const h = rows * 2;
    if (h !== this._colTexH) {
      this._colTexH = h;
      this._colBuf = new Float32Array(PAR_TEX_W * h * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PAR_TEX_W, h, 0, gl.RGBA, gl.FLOAT, null);
    }
    this._colBuf.fill(0);
    const put = (src, rowOff) => {
      for (let i = 0, n = src.length / 3; i < n; i++) {
        const t = (((rowOff + (i >> 10)) * PAR_TEX_W) + (i & 1023)) * 4;
        this._colBuf[t] = src[i * 3]; this._colBuf[t + 1] = src[i * 3 + 1];
        this._colBuf[t + 2] = src[i * 3 + 2]; this._colBuf[t + 3] = 1;
      }
    };
    put(this.partColors, 0);
    put(this.matColors, rows);          /* 材質色は下段 */
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PAR_TEX_W, h, gl.RGBA, gl.FLOAT, this._colBuf);
    gl.uniform1i(this._u('uColTex'), 1);
  }

  _u(name) {
    if (!(name in this.uni)) this.uni[name] = this.gl.getUniformLocation(this.prog, name);
    return this.uni[name];
  }

  setParams(f32) { this.params = f32; this.requestRender(); }
  setObjSpheres(f32) { this.objSpheres = f32; this.requestRender(); }
  setColors(colors) { this.colors = colors; this.requestRender(); }
  setLights(lights) { this.lights = lights; this.requestRender(); }
  setBackground(bg) { this.bg = bg; this.requestRender(); }
  setSelection(idx) { this.selId = idx; this.requestRender(); }
  setGrid(on, y = 0) { this.grid = { on, y }; this.requestRender(); }
  setAxis(on) { this.axis = on; this.requestRender(); }
  setPartColor(on) { this.partColor = on; this.requestRender(); }
  setDepth(on) { this.depth = on; this.requestRender(); }
  setPartColors(f32) { this.partColors = f32; this.requestRender(); }
  setMatColors(f32, on) { this.matColors = f32; this.matOn = !!on; this.requestRender(); }
  setShadow(on) { this.shadow = on; this.requestRender(); }
  setQuality(q) { this.quality = q; this.requestRender(); }
  setBoneOnly(on) { this.boneOnly = on; this.requestRender(); }
  setMeshProxy(on) { this.meshProxy = on; this.requestRender(); }

  _ensureMeshProg() {
    const gl = this.gl;
    if (this._meshProg) return;
    const vs = this._compile(gl.VERTEX_SHADER, MESH_VS);
    const fs = this._compile(gl.FRAGMENT_SHADER, MESH_FS);
    this._meshProg = gl.createProgram();
    gl.attachShader(this._meshProg, vs);
    gl.attachShader(this._meshProg, fs);
    gl.linkProgram(this._meshProg);
    if (!gl.getProgramParameter(this._meshProg, gl.LINK_STATUS))
      throw new Error('mesh link error: ' + gl.getProgramInfoLog(this._meshProg));
    this._meshUni = {
      mvp: gl.getUniformLocation(this._meshProg, 'uMVP'),
      eye: gl.getUniformLocation(this._meshProg, 'uEye'),
      col: gl.getUniformLocation(this._meshProg, 'uCol'),
      useVCol: gl.getUniformLocation(this._meshProg, 'uUseVCol'),
      bg: gl.getUniformLocation(this._meshProg, 'uBgCol'),
      nl: gl.getUniformLocation(this._meshProg, 'uNL'),
      lp: gl.getUniformLocation(this._meshProg, 'uLP[0]'),
      lc: gl.getUniformLocation(this._meshProg, 'uLC[0]'),
      model: gl.getUniformLocation(this._meshProg, 'uModel'),
      nrm: gl.getUniformLocation(this._meshProg, 'uNrmMat'),
      backDark: gl.getUniformLocation(this._meshProg, 'uBackDark'),
    };
  }

  /* VAO 一式 ({vao, vboP, vboN, ebo}) を確保して {verts, normals, colors?, indices} を
     載せる。colors 無しは attrib 2 を定数 (uUseVCol=0 で無視される) にする */
  _uploadTriMesh(slot, { verts, normals, colors, indices }) {
    const gl = this.gl;
    if (!slot.vao) {
      slot.vao = gl.createVertexArray();
      slot.vboP = gl.createBuffer();
      slot.vboN = gl.createBuffer();
      slot.vboC = gl.createBuffer();
      slot.ebo = gl.createBuffer();
    }
    gl.bindVertexArray(slot.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.vboP);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, slot.vboN);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    if (colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.vboC);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      slot.hasCol = true;
    } else {
      gl.disableVertexAttribArray(2);
      slot.hasCol = false;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, slot.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /* marching cubes メッシュを **オブジェクト単位のスロット**で持つ。
     parts[i] = doc.objects[i] の {verts, normals, indices} | null (非表示/未メッシュ)。
     メッシュプロキシ表示は全スロット、ハイブリッド表示 (focus ドラッグ中の文脈)
     は「編集中 object を除く」で描く。データ保持でコンテキスト復旧にも耐える */
  setMeshParts(parts) {
    const gl = this.gl;
    this._meshPartsData = parts;
    if (this._ctxLost || gl.isContextLost()) return;   /* 復旧時に _reinitGL が載せ直す */
    this._ensureMeshProg();
    this._meshSlots = this._meshSlots || [];
    this._meshCounts = this._meshCounts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p || !p.verts || !p.verts.length) { this._meshCounts[i] = 0; continue; }
      this._meshSlots[i] = this._meshSlots[i] || {};
      this._uploadTriMesh(this._meshSlots[i], p);
      this._meshCounts[i] = p.indices.length;
    }
    this._meshCounts.length = parts.length;
    this.requestRender();
  }
  hasMeshParts() { return !!(this._meshCounts && this._meshCounts.some(c => c > 0)); }

  /* 1 スロットだけ差し替える (ドラッグ中の per-frame 更新用 — 全スロット
     再アップロードを避ける) */
  setMeshPart(i, part) {
    const gl = this.gl;
    this._meshPartsData = this._meshPartsData || [];
    this._meshPartsData[i] = part;
    if (this._ctxLost || gl.isContextLost()) return;
    this._ensureMeshProg();
    this._meshSlots = this._meshSlots || [];
    this._meshCounts = this._meshCounts || [];
    if (!part || !part.verts || !part.verts.length) {
      this._meshCounts[i] = 0;
      this.requestRender();
      return;
    }
    this._meshSlots[i] = this._meshSlots[i] || {};
    this._uploadTriMesh(this._meshSlots[i], part);
    this._meshCounts[i] = part.indices.length;
    this.requestRender();
  }

  /* ハイブリッド文脈: null = オフ / n = 「object n 以外」のメッシュをレイマーチに
     深度合成で重ねる (focus ドラッグ中に app が設定)。-1 = 全 object を重ねる */
  setMeshContext(excludeIdx) {
    this.meshContext = excludeIdx;
    this.requestRender();
  }

  /* 選択 blob のハイライト: 可視楕円体の 3 リング (ssq_edit のワイヤ楕円体と同じ)。
     sel = { pos:[3], rotMat:[9 row-major], radii:[3] } | null。
     線データはここで焼いて line プログラムで描く */
  setBlobSel(sel) {
    this._blobSelData = sel;
    if (!sel) { this._blobSelCount = 0; this.requestRender(); return; }
    const gl = this.gl;
    if (this._ctxLost || gl.isContextLost()) return;
    this._ensureLines();                       /* line プログラムを流用 */
    const SEG = 36, pts = [];
    const col = [1.0, 0.62, 0.2];              /* 選択オレンジ */
    if (sel.box) {
      /* mesh(OBJ) の選択枠: ローカル bbox の 12 辺をモデル行列 (col-major 16) で
         ワールドへ。リングでなくワイヤ箱 (三角形メッシュに楕円は嘘になる) */
      const { model: M, lo, hi } = sel.box;
      const P = (x, y, z) => [
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14]];
      const cs = [];
      for (let i = 0; i < 8; i++)
        cs.push(P(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]));
      for (const [a, b] of [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]])
        pts.push(...cs[a], ...col, ...cs[b], ...col);
    } else {
    const R = sel.rotMat, r = sel.radii, c = sel.pos;
    const emit = l => {
      pts.push(
        R[0] * l[0] + R[1] * l[1] + R[2] * l[2] + c[0],
        R[3] * l[0] + R[4] * l[1] + R[5] * l[2] + c[1],
        R[6] * l[0] + R[7] * l[1] + R[8] * l[2] + c[2],
        col[0], col[1], col[2]);
    };
    const ring = mk => {
      for (let i = 0; i < SEG; i++) {
        const a0 = (i / SEG) * 2 * Math.PI, a1 = ((i + 1) / SEG) * 2 * Math.PI;
        emit(mk(a0)); emit(mk(a1));
      }
    };
    ring(a => [r[0] * Math.cos(a), r[1] * Math.sin(a), 0]);
    ring(a => [0, r[1] * Math.cos(a), r[2] * Math.sin(a)]);
    ring(a => [r[0] * Math.cos(a), 0, r[2] * Math.sin(a)]);
    }
    if (!this._blobSelVao) {
      this._blobSelVao = gl.createVertexArray();
      this._blobSelVbo = gl.createBuffer();
      gl.bindVertexArray(this._blobSelVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._blobSelVbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._blobSelVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.DYNAMIC_DRAW);
    this._blobSelCount = pts.length / 6;
    this.requestRender();
  }

  _drawBlobSel(mvp) {
    if (!this._blobSelCount) return;
    const gl = this.gl;
    gl.useProgram(this._lineProg);
    gl.uniformMatrix4fv(this._lineMvp, false, mvp);
    gl.bindVertexArray(this._blobSelVao);
    gl.drawArrays(gl.LINES, 0, this._blobSelCount);
    gl.bindVertexArray(null);
  }

  /* native blob の WASM 再メッシュ結果。レイマーチモードでも常時ラスタライズで
     重ね描きする (blob は GLSL に出せない — 密度場は sphere trace 不能)。
     null でクリア。データ保持でコンテキスト復旧にも耐える */
  setBlobMesh(data) {
    const gl = this.gl;
    this._blobData = data;
    if (!data) { this._blobCount = 0; this.requestRender(); return; }
    if (this._ctxLost || gl.isContextLost()) return;
    this._ensureMeshProg();
    this._blobSlot = this._blobSlot || {};
    this._uploadTriMesh(this._blobSlot, data);
    this._blobCount = data.indices.length;
    this.requestRender();
  }

  /* mesh(OBJ) ノードの表示 (第8弾)。list[i] = { verts, normals, indices,
     model(Float32Array16 col-major), nrm(Float32Array9), col([3]) } | null。
     幾何は verts の参照が変わったときだけ再アップロード — transform 編集は
     行列だけ差し替わるので、ドラッグ中も GPU 転送ゼロで追従する。
     blob メッシュと同じくレイマーチ/メッシュ両モードで常時ラスタライズ */
  setObjMeshes(list) {
    const gl = this.gl;
    this._objData = list;
    if (!list || !list.length) { this._objCounts = []; this.requestRender(); return; }
    if (this._ctxLost || gl.isContextLost()) return;
    this._ensureMeshProg();
    this._objSlots = this._objSlots || [];
    this._objCounts = this._objCounts || [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || !e.verts || !e.verts.length) { this._objCounts[i] = 0; continue; }
      this._objSlots[i] = this._objSlots[i] || {};
      const slot = this._objSlots[i];
      if (slot.src !== e.verts) { this._uploadTriMesh(slot, e); slot.src = e.verts; }
      this._objCounts[i] = e.indices.length;
    }
    this._objCounts.length = list.length;
    this.requestRender();
  }
  _anyObjMesh() { return !!(this._objCounts && this._objCounts.some(c => c > 0)); }
  _drawObjMeshes(mvp) {
    if (!this._objCounts) return;
    for (let i = 0; i < this._objCounts.length; i++)
      if (this._objCounts[i]) {
        const e = this._objData[i];
        this._drawTriMesh(this._objSlots[i], this._objCounts[i], mvp,
                          e.col || [0.72, 0.73, 0.76], e.model, e.nrm, 0);
      }
  }

  /* ── カメラ ── */
  cameraFromScene({ from, at, fov }) {
    const d = [from[0] - at[0], from[1] - at[1], from[2] - at[2]];
    const dist = Math.hypot(...d) || 10;
    this.cam.target = at.slice();
    this.cam.dist = dist;
    this.cam.el = Math.asin(Math.min(1, Math.max(-1, d[1] / dist)));
    this.cam.az = Math.atan2(d[0], d[2]);
    if (fov) this.cam.fov = fov;
    this.requestRender();
  }
  getCamera() {
    const { eye } = this._camVectors();
    return { from: eye, at: this.cam.target.slice(), up: [0, 1, 0], fov: this.cam.fov };
  }
  _camVectors() {
    const c = this.cam;
    const ce = Math.cos(c.el), se = Math.sin(c.el);
    const sa = Math.sin(c.az), ca = Math.cos(c.az);
    const eye = [
      c.target[0] + c.dist * ce * sa,
      c.target[1] + c.dist * se,
      c.target[2] + c.dist * ce * ca,
    ];
    const fwd = norm3(sub3(c.target, eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    return { eye, fwd, right, up };
  }

  /* ── 描画 ── */
  requestRender() { this.dirty = true; }
  _loop() {
    if (this.dirty && this.prog) {
      this.dirty = false;
      /* _draw() の例外を飲まない: 素通しすると次の rAF が登録されずループが永久停止し、
         「エラーも出ず真っ黒」という最悪の症状になる (原因究明を著しく妨げる)。
         捕まえてログし、ループは回し続ける。 */
      try { this._draw(); }
      catch (e) { if (!this._drawErr) { this._drawErr = e; console.error('draw error:', e); } }
      if (this.interactive === 'cooling') { this.interactive = false; }
    }
    requestAnimationFrame(this._loop);
  }
  /* 射影×ビュー行列 (column-major)。cam.fov は縦FOV (レイ生成と同一解釈)。
     ⚠ near/far は codegen.js の DEPTH_NEAR/DEPTH_FAR と一致必須 (レイマーチの
     gl_FragDepth とメッシュの Z を同じ空間で比較するため) */
  _mvp(w, h) {
    const { eye, fwd, right, up } = this._camVectors();
    const aspect = w / h;
    const f = 1 / Math.tan(this.cam.fov * Math.PI / 360);
    const near = 0.02, far = 800;
    const P = [f / aspect, 0, 0, 0, 0, f, 0, 0,
               0, 0, (far + near) / (near - far), -1,
               0, 0, 2 * far * near / (near - far), 0];
    const V = [right[0], up[0], -fwd[0], 0,
               right[1], up[1], -fwd[1], 0,
               right[2], up[2], -fwd[2], 0,
               -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]),
               -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]),
               (fwd[0] * eye[0] + fwd[1] * eye[1] + fwd[2] * eye[2]), 1];
    const M = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += P[k * 4 + r] * V[c * 4 + k];
        M[c * 4 + r] = s;
      }
    return M;
  }

  /* 市松床 quad (メッシュモード。レイマーチ床と同じ見た目) を一度だけ生成 */
  _ensureFloor() {
    if (this._floorVao) return;
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, FLOOR_VS);
    const fs = this._compile(gl.FRAGMENT_SHADER, FLOOR_FS);
    this._floorProg = gl.createProgram();
    gl.attachShader(this._floorProg, vs);
    gl.attachShader(this._floorProg, fs);
    gl.linkProgram(this._floorProg);
    this._floorUni = {
      mvp: gl.getUniformLocation(this._floorProg, 'uMVP'),
      gridY: gl.getUniformLocation(this._floorProg, 'uGridY'),
      eye: gl.getUniformLocation(this._floorProg, 'uEye'),
      bg: gl.getUniformLocation(this._floorProg, 'uBgCol'),
    };
    const E = 200;   /* 遠方はフォグで背景へ溶けるのでエッジは見えない */
    const quad = new Float32Array([-E, -E, E, -E, E, E, -E, -E, E, E, -E, E]);
    this._floorVao = gl.createVertexArray();
    gl.bindVertexArray(this._floorVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /* グリッド (y=0, ±10, 1刻み) + 軸 (X赤/Y緑/Z青) のライン VAO を一度だけ生成 */
  _ensureLines() {
    if (this._lineVao) return;
    const gl = this.gl;
    const vs = this._compile(gl.VERTEX_SHADER, LINE_VS);
    const fs = this._compile(gl.FRAGMENT_SHADER, LINE_FS);
    this._lineProg = gl.createProgram();
    gl.attachShader(this._lineProg, vs);
    gl.attachShader(this._lineProg, fs);
    gl.linkProgram(this._lineProg);
    this._lineMvp = gl.getUniformLocation(this._lineProg, 'uMVP');
    const g = [0.32, 0.36, 0.42], ext = 10;
    const pts = [];
    const put = (p, c) => pts.push(p[0], p[1], p[2], c[0], c[1], c[2]);
    for (let i = -ext; i <= ext; i++) {
      const c = i === 0 ? [0.45, 0.5, 0.58] : g;
      put([i, 0, -ext], c); put([i, 0, ext], c);
      put([-ext, 0, i], c); put([ext, 0, i], c);
    }
    this._lineGridCount = pts.length / 6;
    put([0, 0, 0], [0.9, 0.25, 0.25]); put([2, 0, 0], [0.9, 0.25, 0.25]);
    put([0, 0, 0], [0.25, 0.85, 0.3]); put([0, 2, 0], [0.25, 0.85, 0.3]);
    put([0, 0, 0], [0.3, 0.5, 0.95]);  put([0, 0, 2], [0.3, 0.5, 0.95]);
    this._lineAxisCount = pts.length / 6 - this._lineGridCount;
    this._lineVao = gl.createVertexArray();
    gl.bindVertexArray(this._lineVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  /* メッシュプロキシ描画: ラスタライズなのでドラッグ中も常にフル解像度 */
  _drawMesh() {
    const gl = this.gl, cv = this.canvas;
    const scale = this.quality * Math.min(devicePixelRatio, 2);
    const w = Math.max(2, Math.round(cv.clientWidth * scale));
    const h = Math.max(2, Math.round(cv.clientHeight * scale));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1.0);
    gl.clearDepth(1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const mvp = this._mvp(w, h);
    if (this.grid.on) {                        /* 市松床 (レイマーチ床と同じ見た目) */
      this._ensureFloor();
      gl.useProgram(this._floorProg);
      gl.uniformMatrix4fv(this._floorUni.mvp, false, mvp);
      gl.uniform1f(this._floorUni.gridY, this.grid.y);
      gl.uniform3fv(this._floorUni.eye, this._camVectors().eye);
      gl.uniform3fv(this._floorUni.bg, this.bg);
      gl.bindVertexArray(this._floorVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindVertexArray(null);
    }
    if (this.axis) {                           /* 軸クロス (X赤/Y緑/Z青) */
      this._ensureLines();
      gl.useProgram(this._lineProg);
      gl.uniformMatrix4fv(this._lineMvp, false, mvp);
      gl.bindVertexArray(this._lineVao);
      gl.drawArrays(gl.LINES, this._lineGridCount, this._lineAxisCount);
      gl.bindVertexArray(null);
    }
    if (this._meshProg && this._meshCounts) {
      /* プロキシは単色 (パーツ色は融合メッシュでは表せない)。明るいニュートラルで
         「これは近似表示」と分かる見た目にする */
      for (let i = 0; i < this._meshCounts.length; i++)
        if (this._meshCounts[i])
          this._drawTriMesh(this._meshSlots[i], this._meshCounts[i], mvp, [0.72, 0.73, 0.76]);
    }
    if (this._blobCount) this._drawTriMesh(this._blobSlot, this._blobCount, mvp, BLOB_COL);
    this._drawObjMeshes(mvp);
    gl.disable(gl.DEPTH_TEST);
    this._drawBlobSel(mvp);
    this.onDraw();
  }

  _drawTriMesh(slot, count, mvp, col, model = null, nrm = null, backDark = 1) {
    const gl = this.gl;
    gl.useProgram(this._meshProg);
    gl.uniformMatrix4fv(this._meshUni.mvp, false, mvp);
    gl.uniformMatrix4fv(this._meshUni.model, false, model || IDENT4);
    gl.uniformMatrix3fv(this._meshUni.nrm, false, nrm || IDENT3);
    gl.uniform1f(this._meshUni.backDark, backDark);
    gl.uniform3fv(this._meshUni.eye, this._camVectors().eye);
    gl.uniform3fv(this._meshUni.col, col);
    gl.uniform1f(this._meshUni.useVCol, slot.hasCol ? 1 : 0);
    gl.uniform3fv(this._meshUni.bg, this.bg);
    {   /* シーンライト (レイマーチと同じ強度スケール) */
      const nl = Math.min(4, this.lights.length);
      gl.uniform1i(this._meshUni.nl, nl);
      const lp = new Float32Array(12), lc = new Float32Array(12);
      for (let i = 0; i < nl; i++) {
        lp.set(this.lights[i].pos, i * 3);
        lc.set(this.lights[i].color, i * 3);
      }
      gl.uniform3fv(this._meshUni.lp, lp);
      gl.uniform3fv(this._meshUni.lc, lc);
    }
    gl.bindVertexArray(slot.vao);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  _draw() {
    const gl = this.gl, cv = this.canvas;
    if (this._ctxLost) return;
    /* メッシュモード中はメッシュ未着でもレイマーチに落ちない (超重量モデルの
       レイマーチ描画は GPU ハング→コンテキストロストの実績があるため)。
       未着の間は背景+床/軸だけ描いて待つ */
    if (this.meshProxy) { this._drawMesh(); return; }
    const fast = this.interactive === true;
    if (fast && this.boneOnly) {
      /* ボーン表示中のドラッグ: レイマーチせず背景クリアのみ →
         描画コストがノード数に依存しない (ボーン/ギズモは onDraw で追従) */
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(this.bg[0] * 0.85, this.bg[1] * 0.85, this.bg[2] * 0.85, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.onDraw();
      return;
    }
    const scale = (fast ? this.interScale : this.quality) * Math.min(devicePixelRatio, 2);
    const w = Math.max(2, Math.round(cv.clientWidth * scale));
    const h = Math.max(2, Math.round(cv.clientHeight * scale));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    this._setCommonUniforms(w, h);
    gl.uniform1i(this._u('uPick'), 0);
    /* レイマーチ quad は gl_FragDepth (codegen ndcDepth) を書く → メッシュ文脈 /
       blob メッシュと正しく深度合成できる。quad は必ず全画素を塗るので ALWAYS で
       書き、以降のメッシュは LEQUAL でテストする */
    gl.clearDepth(1.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    const t0 = fast ? performance.now() : 0;
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthFunc(gl.LEQUAL);
    {
      const wantCtx = this.meshContext != null && this._meshCounts;
      if (wantCtx || this._blobCount || this._blobSelCount || this._anyObjMesh()) {
        const mvp = this._mvp(w, h);
        /* ハイブリッド文脈: 編集中 object 以外のキャッシュ済みメッシュを重ねる
           (focus シェーダは編集近傍しかレイマーチしない — 残りをこれが受け持つ) */
        if (wantCtx)
          for (let i = 0; i < this._meshCounts.length; i++)
            if (this._meshCounts[i] && i !== this.meshContext)
              this._drawTriMesh(this._meshSlots[i], this._meshCounts[i], mvp, [0.72, 0.73, 0.76]);
        /* native blob (密度場はレイマーチに出せない) — SDF 面との前後も深度で解決 */
        if (this._blobCount)
          this._drawTriMesh(this._blobSlot, this._blobCount, mvp, BLOB_COL);
        this._drawObjMeshes(mvp);   /* mesh(OBJ) — SDF 面との前後も深度で解決 */
        gl.disable(gl.DEPTH_TEST);
        this._drawBlobSel(mvp);
      } else {
        gl.disable(gl.DEPTH_TEST);
      }
    }
    if (fast) {
      /* 適応解像度: 実フレーム時間 (gl.finish で GPU 完了まで計測) が
         30ms 超なら下げ、13ms 未満なら戻す。ノード数が増えても操作 fps を維持 */
      gl.finish();
      const ms = performance.now() - t0;
      if (ms > 30)      this.interScale = Math.max(0.12, this.interScale * 0.85);
      else if (ms < 13) this.interScale = Math.min(0.6,  this.interScale * 1.1);
    }
    this.onDraw();
  }
  _setCommonUniforms(w, h) {
    const gl = this.gl;
    this._bindGrids();          /* グリッド3Dテクスチャの bind + uniform1i (program 毎) */
    const { eye, fwd, right, up } = this._camVectors();
    gl.uniform2f(this._u('uRes'), w, h);
    gl.uniform3fv(this._u('uCamPos'), eye);
    gl.uniform3fv(this._u('uCamFwd'), fwd);
    gl.uniform3fv(this._u('uCamRight'), right);
    gl.uniform3fv(this._u('uCamUp'), up);
    gl.uniform1f(this._u('uFovTan'), Math.tan(this.cam.fov * Math.PI / 360));
    gl.uniform3fv(this._u('uBg'), this.bg);
    const nl = Math.min(4, this.lights.length);
    gl.uniform1i(this._u('uNLights'), nl);
    const lp = new Float32Array(12), lc = new Float32Array(12);
    for (let i = 0; i < nl; i++) {
      lp.set(this.lights[i].pos, i * 3);
      lc.set(this.lights[i].color, i * 3);
    }
    gl.uniform3fv(this._u('uLightPos[0]'), lp);
    gl.uniform3fv(this._u('uLightCol[0]'), lc);
    this._uploadParams();
    gl.uniform4fv(this._u('uObjSph[0]'), this.objSpheres);
    const colFlat = new Float32Array(this.colors.length * 3);
    this.colors.forEach((c, i) => colFlat.set(c, i * 3));
    gl.uniform3fv(this._u('uObjCol[0]'), colFlat);
    gl.uniform1i(this._u('uSelId'), this.selId);
    gl.uniform1f(this._u('uGridOn'), this.grid.on ? 1 : 0);
    gl.uniform1f(this._u('uGridY'), this.grid.y);
    gl.uniform1f(this._u('uAxisOn'), this.axis ? 1 : 0);
    gl.uniform1f(this._u('uPartOn'), this.partColor ? 1 : 0);
    this._uploadColors();
    gl.uniform1f(this._u('uMatOn'), this.matOn ? 1 : 0);
    gl.uniform1f(this._u('uShadowOn'), this.shadow ? 1 : 0);
    gl.uniform1f(this._u('uFast'), this.interactive === true ? 1 : 0);
    gl.uniform1f(this._u('uDepthOn'), this.depth ? 1 : 0);
    /* 深度レンジはカメラ距離から自動 (近=白, 遠=黒)。注視点± の実用域をカバー */
    gl.uniform2f(this._u('uDepthRange'), this.cam.dist * 0.25, this.cam.dist * 2.2);
  }

  /* 現在のビューを PNG Blob に (描画直後に読み出すので preserveDrawingBuffer 不要) */
  snapshotPNG() {
    this.interactive = false;
    this._draw();
    return new Promise(res => this.canvas.toBlob(res, 'image/png'));
  }

  /* クライアント座標 → ワールドレイ {ro, rd} (pick と同一のレイ生成) */
  rayFromScreen(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width * 2 - 1;
    const py = 1 - (clientY - rect.top) / rect.height * 2;
    const aspect = rect.width / rect.height;
    const { eye, fwd, right, up } = this._camVectors();
    const ft = Math.tan(this.cam.fov * Math.PI / 360);
    const rd = norm3([
      fwd[0] + ft * (px * aspect * right[0] + py * up[0]),
      fwd[1] + ft * (px * aspect * right[1] + py * up[1]),
      fwd[2] + ft * (px * aspect * right[2] + py * up[2]),
    ]);
    return { ro: eye, rd };
  }

  /* ワールド点 → キャンバス CSS px 座標 {x, y, z}。カメラ背後は null */
  project(p) {
    const rect = this.canvas.getBoundingClientRect();
    const { eye, fwd, right, up } = this._camVectors();
    const v = sub3(p, eye);
    const z = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
    if (z < 0.05) return null;
    const ft = Math.tan(this.cam.fov * Math.PI / 360);
    const aspect = rect.width / rect.height;
    const nx = (v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / (z * ft * aspect);
    const ny = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / (z * ft);
    return { x: (nx * 0.5 + 0.5) * rect.width, y: (0.5 - ny * 0.5) * rect.height, z };
  }

  /* ワールド点 p の位置で 1 CSS px が何ワールド単位に当たるか */
  worldPerPixel(p) {
    const rect = this.canvas.getBoundingClientRect();
    const { eye, fwd } = this._camVectors();
    const v = sub3(p, eye);
    const z = Math.max(0.05, v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]);
    return 2 * z * Math.tan(this.cam.fov * Math.PI / 360) / rect.height;
  }

  /* クリック位置のレイで GPU ピック → leaf ノード index (なければ -1) */
  /* 表示を切り替えずに裏でプログラムを焼く (ピック用など)。
     setProgram と違い this.prog を差し替えないので、描画中の絵が乱れない。
     KHR_parallel_shader_compile があればポーリング、無ければ同期。 */
  compileAux(fragSrc, onReady) {
    const gl = this.gl;
    if (this._ctxLost || gl.isContextLost()) return;
    if (!this._vsShared) this._vsShared = this._compile(gl.VERTEX_SHADER, VS);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, this._vsShared);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const finish = () => {
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('aux link error: ' + (gl.getProgramInfoLog(prog) || ''));
        gl.deleteProgram(prog); gl.deleteShader(fs);
        return;
      }
      gl.deleteShader(fs);
      if (onReady) onReady(prog);
    };
    if (this._parallelExt) {
      const poll = () => {
        if (this._ctxLost || gl.isContextLost()) { gl.deleteProgram(prog); return; }
        if (gl.getProgramParameter(prog, this._parallelExt.COMPLETION_STATUS_KHR)) finish();
        else setTimeout(poll, 16);
      };
      poll();
    } else finish();
  }

  /* ピック専用プログラム。描画用は opts.pick=false で焼く (probe の展開が1つ減り
     コンパイルが約2割速い) ので、uPick 分岐はこちらだけが持つ。
     app が用意していなければ従来どおり描画用プログラムで拾う (機能は落ちない)。 */
  setPickProgram(prog) {
    this.pickProg = prog || null;
    /* ⚠ uniform location は**プログラム毎**。差し替えたらキャッシュを必ず捨てる —
       残すと新プログラムに古い location を撃ち、uPar が読めず**ピックが黙って
       全 miss** になる (シーンを開き直すたびに選択できなくなる形で出る)。 */
    this._pickUni = {};
  }

  pick(clientX, clientY) {
    const prog = this.pickProg || this.prog;
    if (!prog) return -1;
    const gl = this.gl;
    const { ro: eye, rd } = this.rayFromScreen(clientX, clientY);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, 1, 1);
    gl.useProgram(prog);
    /* uniform location はプログラム毎 — ピック用に切り替えたら _u のキャッシュを
       そのプログラムのものにする (取り違えると uPar が読めず全 miss になる) */
    const savedProg = this.prog, savedUni = this.uni;
    if (prog !== savedProg) { this.prog = prog; this.uni = this._pickUni || (this._pickUni = {}); }
    this._setCommonUniforms(1, 1);
    gl.uniform1i(this._u('uPick'), 1);
    gl.uniform3fv(this._u('uPickRO'), eye);
    gl.uniform3fv(this._u('uPickRD'), rd);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buf = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (prog !== savedProg) { this.prog = savedProg; this.uni = savedUni; }
    this.requestRender();
    return buf[0] + buf[1] * 256 - 1;
  }

  /* ── 入力 ── */
  _initEvents() {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, btn: e.button, shift: e.shiftKey, moved: false };
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (!drag.moved) return;
      this.interactive = true;
      const c = this.cam;
      if (drag.btn === 0 && !drag.shift) {          /* orbit */
        c.az -= dx * 0.006;
        c.el = Math.min(1.55, Math.max(-1.55, c.el + dy * 0.006));
      } else {                                       /* pan */
        const { right, up } = this._camVectors();
        const s = c.dist * 0.0016;
        for (let i = 0; i < 3; i++) c.target[i] += (-dx * right[i] + dy * up[i]) * s;
      }
      this.requestRender();
    });
    const endDrag = e => {
      if (!drag) return;
      const wasClick = !drag.moved && drag.btn === 0;
      drag = null;
      if (this.interactive === true) {
        this.interactive = 'cooling';
        this.requestRender();          /* フル解像度で再描画 */
        this.onCameraChange();
      }
      if (wasClick) this.onPick(this.pick(e.clientX, e.clientY), e.clientX, e.clientY);
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', () => { drag = null; });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      this.cam.dist *= Math.exp(e.deltaY * 0.0012);
      this.cam.dist = Math.min(500, Math.max(0.1, this.cam.dist));
      /* ホイール中もドラッグ同様の軽量モード (fast/ボーン)。
         160ms 入力が止んだらフル画質で再描画 */
      this.interactive = true;
      clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => {
        this.interactive = 'cooling';
        this.requestRender();
        this.onCameraChange();
      }, 160);
      this.requestRender();
    }, { passive: false });
  }
}

function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
