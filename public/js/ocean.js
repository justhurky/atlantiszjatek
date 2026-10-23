// Élő, animált tenger a háttérben (WebGL). Procedurális, ezért bármilyen felbontáson éles (4K-n is),
// a letöltendő mérete pár kilobájt. Ugyanazokat a színeket használja, mint a CSS (felszín → mély → Atlantisz).
//
// Felépítés, a teljesítmény miatt:
//  1. „víztest": színátmenet, fényoszlopok, fodrozódó fényháló (kausztika), mélytengeri derengés.
//     Lágy tartalom, ezért kisebb belső felbontáson, félsebességgel számoljuk, és simán felnagyítjuk.
//  2. kompozit teljes felbontáson: a felnagyított víztest + dithering (nincs sávosodás a sötét átmenetekben).
//  3. lebegő részecskék (mélytengeri „hó", arany szemcsék, életlen előtér) teljes felbontáson, élesen.
// Takarékosság: legfeljebb 30 képkocka/mp, rejtett lapon áll, lassú gépen magától visszavesz a minőségből,
// végső esetben állóképre vált. Csökkentett mozgás beállításnál csak állókép. WebGL nélkül a CSS-háttér marad.

const SEA = { top: [58, 183, 217], mid: [10, 42, 74], deep: [1, 6, 18] };

// Minőségi szintek: a víztest pixelkerete és a kimenet felső határa (megapixel), a pixelsűrűség plafonja
const LEVELS = [
  { field: 0.9e6, out: 3840 * 2160, dpr: 3 },
  { field: 0.5e6, out: 2560 * 1440, dpr: 2 },
  { field: 0.28e6, out: 1600 * 1000, dpr: 1.5 },
  { field: 0.15e6, out: 1000 * 700, dpr: 1 },
];
const FRAME_MS = 1000 / 30;

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const FIELD_FRAG = `${PRECISION}
uniform float uTime;
uniform float uDepth;
uniform float uAspect;
varying vec2 vUv;

vec3 seaAt(float r) {
  r = clamp(r, 0.0, 1.0);
  vec3 top = vec3(${SEA.top.map((v) => (v / 255).toFixed(4)).join(',')});
  vec3 mid = vec3(${SEA.mid.map((v) => (v / 255).toFixed(4)).join(',')});
  vec3 deep = vec3(${SEA.deep.map((v) => (v / 255).toFixed(4)).join(',')});
  return r < 0.5 ? mix(top, mid, r * 2.0) : mix(mid, deep, (r - 0.5) * 2.0);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

// fodrozódó fényháló a felszín alatt
float caustic(vec2 q, float t) {
  vec2 p = q * 6.2831 - 250.0;
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

// a felszínen át beeső, lassan ringó fényoszlopok
float beams(vec2 q, float t) {
  vec2 src = vec2(uAspect * (0.36 + 0.05 * sin(t * 0.045)), -0.55);
  vec2 d = q - src;
  float ang = atan(d.x, d.y);
  float a = noise(vec2(ang * 9.0 + t * 0.06, t * 0.04));
  float b = noise(vec2(ang * 24.0 - t * 0.09, 3.0 + t * 0.05));
  float shafts = pow(a, 3.0) * 0.85 + pow(b, 4.0) * 0.55;
  return shafts * smoothstep(1.2, 0.0, q.y) * smoothstep(0.0, 0.15, length(d) - 0.5);
}

void main() {
  float t = uTime;
  float r = uDepth;
  vec2 q = vec2(vUv.x * uAspect, 1.0 - vUv.y); // y lefelé nő

  // alapszín: ugyanaz az átmenet, mint a CSS-ben (felül az aktuális mélység, alul kicsit mélyebb)
  vec3 col = mix(seaAt(r), seaAt(min(1.0, r + 0.2)), smoothstep(0.0, 1.0, q.y));

  // lassan áramló víztömeg: finom fényesség-hullámzás
  float haze = fbm(q * 1.5 + vec2(t * 0.012, -t * 0.006));
  col *= 0.9 + 0.2 * haze;

  float light = max(0.08, 1.0 - r * 1.1);
  col += vec3(0.55, 0.85, 0.95) * 0.08 * light * exp(-q.y * 3.2);
  col += vec3(1.0, 0.93, 0.72) * 0.15 * light * beams(q, t);
  float cz = caustic(q * vec2(1.1, 1.6) + vec2(0.0, t * 0.01), t * 0.32);
  col += vec3(0.85, 0.97, 1.0) * 0.2 * cz * light * light * smoothstep(0.6, 0.0, q.y);

  // a mélyben: halvány, arany derengés (élőlények fénye)
  float deep = smoothstep(0.45, 1.0, r);
  float g = smoothstep(0.6, 0.92, fbm(q * 2.1 + vec2(t * 0.004, t * 0.018)));
  col += vec3(0.84, 0.66, 0.29) * 0.045 * deep * g;

  // Atlantisz: alulról felszűrődő arany fény
  float city = smoothstep(0.88, 1.0, r);
  float pulse = 0.85 + 0.15 * sin(t * 0.45);
  col += vec3(0.84, 0.62, 0.26) * 0.14 * city * pulse * exp(-(1.0 - q.y) * 3.5) * (0.7 + 0.3 * haze);

  // keret-sötétítés: a tekintet középre kerül
  vec2 v = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(v, v);

  gl_FragColor = vec4(col, 1.0);
}`;

const COMPOSITE_FRAG = `${PRECISION}
uniform sampler2D uField;
varying vec2 vUv;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec3 c = texture2D(uField, vUv).rgb;
  // háromszög-eloszlású dithering: sima átmenet sötétben is, sávok nélkül
  float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 17.0) - 1.0;
  gl_FragColor = vec4(c + n / 255.0, 1.0);
}`;

const POINT_VERT = `
attribute vec4 aSeed;
uniform float uTime;
uniform float uShift;
uniform float uDpr;
uniform float uSnow;
uniform float uDeep;
varying float vAlpha;
varying vec3 vColor;
varying float vSoft;
void main() {
  float layer = aSeed.z;        // 0 = távoli, 1 = közeli
  float kind = aSeed.w;
  float par = mix(0.35, 1.6, layer); // közelebb gyorsabbnak látszik
  float y = fract(aSeed.y + uShift * par);
  float x = fract(aSeed.x + 0.012 * sin(uTime * (0.18 + 0.25 * layer) + kind * 40.0));
  gl_Position = vec4(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);

  bool bokeh = layer > 0.975;
  float size = bokeh ? mix(14.0, 30.0, fract(kind * 7.3)) : mix(0.9, 3.0, layer * layer);
  gl_PointSize = size * uDpr;
  vSoft = bokeh ? 1.0 : 0.0;

  float twinkle = 0.75 + 0.25 * sin(uTime * (0.6 + kind * 1.7) + aSeed.x * 50.0);
  float a = mix(0.22, 0.85, uSnow) * mix(0.35, 1.0, layer) * twinkle;
  if (bokeh) a *= 0.07;
  vec3 ink = vec3(0.96, 0.94, 0.88);
  vec3 gold = vec3(0.97, 0.84, 0.5);
  bool isGold = kind > 0.86;
  vColor = isGold ? mix(ink, gold, 0.4 + 0.6 * uDeep) : ink;
  if (isGold) a *= 0.6 + 0.8 * uDeep;
  // a képernyő szélein elhalványul (nincs hirtelen fel- és eltűnés)
  a *= smoothstep(0.0, 0.08, y) * smoothstep(1.0, 0.9, y);
  vAlpha = a;
}`;

const POINT_FRAG = `
precision mediump float;
varying float vAlpha;
varying vec3 vColor;
varying float vSoft;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  float disc = mix(core * core, exp(-d * d * 4.0) * (1.0 - d * d), vSoft);
  float a = disc * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader');
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(gl.getProgramInfoLog(p) || 'link');
  }
  const loc = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const { name } = gl.getActiveUniform(p, i);
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

/**
 * Elindítja az animált hátteret. Ha nincs WebGL (vagy hiba van), null-t ad: ilyenkor marad a CSS-háttér.
 * @returns {{ setDepth(r:number, instant?:boolean):void, dive(ms:number):void, destroy():void } | null}
 */
export function startOcean({ depth = 0, parent = document.body } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ocean';
  canvas.setAttribute('aria-hidden', 'true');
  const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power' };
  const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
  if (!gl) return null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const root = document.documentElement;
  let res = null; // GPU-erőforrások
  let level = 0;
  let target = depth;
  let current = depth;
  let shift = 0; // a részecskék függőleges eltolása (képernyőmagasságban)
  let diveUntil = 0;
  let diveLen = 1;
  let raf = 0;
  let last = 0;
  let lastField = -1;
  let fieldDirty = true;
  let slow = 0;
  let frames = 0;
  let staticMode = reduced.matches;
  let destroyed = false;
  const t0 = performance.now();

  function init() {
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    res = {
      quad,
      tex,
      fbo,
      field: program(gl, VERT, FIELD_FRAG),
      comp: program(gl, VERT, COMPOSITE_FRAG),
      points: program(gl, POINT_VERT, POINT_FRAG),
      seeds: gl.createBuffer(),
      count: 0,
      fw: 0,
      fh: 0,
    };
    gl.disable(gl.DEPTH_TEST);
    resize();
  }

  function seedParticles(cssW, cssH) {
    const count = Math.round(Math.min(280, Math.max(80, (cssW * cssH) / 5200)));
    const data = new Float32Array(count * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.random();
    gl.bindBuffer(gl.ARRAY_BUFFER, res.seeds);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    res.count = count;
  }

  function resize() {
    if (!res) return;
    const L = LEVELS[level];
    const cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, L.dpr);
    const area = cssW * cssH * dpr * dpr;
    if (area > L.out) dpr *= Math.sqrt(L.out / area);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    res.dpr = dpr;
    const fs = Math.min(1, Math.sqrt(L.field / (canvas.width * canvas.height)));
    res.fw = Math.max(16, Math.round(canvas.width * fs));
    res.fh = Math.max(16, Math.round(canvas.height * fs));
    gl.bindTexture(gl.TEXTURE_2D, res.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, res.fw, res.fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    seedParticles(cssW, cssH);
    fieldDirty = true;
  }

  function quad(prog) {
    gl.bindBuffer(gl.ARRAY_BUFFER, res.quad);
    const a = gl.getAttribLocation(prog.p, 'aPos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(a);
  }

  function draw(now) {
    const t = ((now - t0) / 1000) % 3600;
    const snow = Math.min(1, current * 1.3);
    const deep = Math.min(1, Math.max(0, (current - 0.45) / 0.55));

    // 1. víztest (fél sebességgel elég: lassan változik)
    if (fieldDirty || staticMode || now - lastField > FRAME_MS * 1.9) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo);
      gl.viewport(0, 0, res.fw, res.fh);
      gl.useProgram(res.field.p);
      gl.uniform1f(res.field.loc.uTime, t);
      gl.uniform1f(res.field.loc.uDepth, current);
      gl.uniform1f(res.field.loc.uAspect, canvas.width / canvas.height);
      gl.disable(gl.BLEND);
      quad(res.field);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      lastField = now;
      fieldDirty = false;
    }

    // 2. kompozit teljes felbontáson
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(res.comp.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, res.tex);
    gl.uniform1i(res.comp.loc.uField, 0);
    quad(res.comp);

    // 3. részecskék, additív keveréssel
    const pp = res.points;
    gl.useProgram(pp.p);
    gl.uniform1f(pp.loc.uTime, t);
    gl.uniform1f(pp.loc.uShift, shift);
    gl.uniform1f(pp.loc.uDpr, res.dpr);
    gl.uniform1f(pp.loc.uSnow, snow);
    gl.uniform1f(pp.loc.uDeep, deep);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.seeds);
    const a = gl.getAttribLocation(pp.p, 'aSeed');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, res.count);
    gl.disableVertexAttribArray(a);
    gl.disable(gl.BLEND);

    if (!root.classList.contains('gl')) root.classList.add('gl');
  }

  // Lassú gép: néhány másodpercnyi akadozás után egy szinttel lejjebb, a végén állókép
  function adapt(dt) {
    frames += 1;
    if (frames < 20) return; // indulás, betűtöltés: még nem mérünk
    slow = dt > FRAME_MS * 1.6 ? slow + 1 : Math.max(0, slow - 0.5);
    if (slow < 45) return;
    slow = 0;
    frames = 0;
    if (level < LEVELS.length - 1) {
      level += 1;
      resize();
    } else {
      staticMode = true;
    }
  }

  function tick(now) {
    raf = 0;
    if (destroyed || document.hidden || !res) return;
    const dt = last ? now - last : FRAME_MS;
    if (dt < FRAME_MS - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    last = now;
    const step = Math.min(dt, 100) / 1000;
    current += (target - current) * (1 - Math.exp(-step / 0.7));
    if (Math.abs(target - current) < 0.0005) current = target;
    let speed = -0.006; // a hó lassan süllyed
    if (now < diveUntil) {
      const p = 1 - (diveUntil - now) / diveLen;
      speed += 0.9 * Math.sin(Math.PI * p); // merüléskor a részecskék felfelé suhannak
    }
    shift = (shift - speed * step) % 1000;
    draw(now);
    adapt(dt);
    if (!staticMode) raf = requestAnimationFrame(tick);
  }

  function schedule() {
    if (!raf && !destroyed) raf = requestAnimationFrame(tick);
  }

  function renderStatic() {
    if (!res || destroyed) return;
    current = target;
    draw(performance.now());
  }

  function onVisibility() {
    if (document.hidden) return;
    last = 0;
    if (staticMode) renderStatic();
    else schedule();
  }

  let resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
      if (staticMode) renderStatic();
    });
  }

  function onLost(e) {
    e.preventDefault();
    res = null;
    cancelAnimationFrame(raf);
    raf = 0;
    root.classList.remove('gl'); // addig a CSS-háttér látszik
  }
  function onRestored() {
    try {
      init();
      if (staticMode) renderStatic();
      else schedule();
    } catch {
      /* marad a CSS-háttér */
    }
  }
  function onMotionPref() {
    staticMode = reduced.matches;
    if (staticMode) renderStatic();
    else schedule();
  }

  try {
    init();
  } catch (err) {
    console.warn('Az animált háttér nem indult el, marad az egyszerű háttér.', err);
    return null;
  }
  parent.prepend(canvas);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  reduced.addEventListener?.('change', onMotionPref);
  if (staticMode) requestAnimationFrame(renderStatic);
  else schedule();

  return {
    setDepth(r, instant = false) {
      target = Math.min(1, Math.max(0, r));
      if (instant) current = target;
      fieldDirty = true;
      if (staticMode) requestAnimationFrame(renderStatic);
    },
    dive(ms) {
      diveLen = Math.max(200, ms);
      diveUntil = performance.now() + diveLen;
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener?.('change', onMotionPref);
      canvas.remove();
      root.classList.remove('gl');
    },
  };
}
