'use strict';

/* =================================================================
   Roulette européenne à un zéro, règles françaises
   (utilise RNG, Wallet, Sound et les utilitaires de casino.js)
   ================================================================= */
const Roulette = (() => {

// ---------------------------------------------------------------
// Constantes de la roulette
// ---------------------------------------------------------------
const TAU = Math.PI * 2;
// Ordre réel des 37 cases sur un cylindre européen, dans le sens horaire.
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const SEG = TAU / 37;
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const CHIP_VALUES = [1, 5, 10, 25, 100, 500, 1000];

const mod = (a, m) => ((a % m) + m) % m;
const colorOf = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");
const totalOf = (bets) => { let t = 0; for (const v of bets.values()) t += v; return t; };

/** Effectue `count` tirages 0–36 en lot (pour le test d’uniformité). */
function bulkDraws(count) {
  const counts = new Array(37).fill(0);
  const buf = new Uint32Array(16384); // 64 Ko : maximum autorisé par getRandomValues
  const limit = 0x100000000 - (0x100000000 % 37);
  let done = 0;
  while (done < count) {
    RNG.getRandomValues(buf);
    for (let i = 0; i < buf.length && done < count; i++) {
      if (buf[i] >= limit) continue;
      counts[buf[i] % 37]++;
      done++;
    }
  }
  return counts;
}

// Fonction gamma incomplète (Numerical Recipes) pour la p-valeur du χ².
function gammaLn(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function gammaQ(a, x) {
  if (x <= 0) return 1;
  const lnPre = -x + a * Math.log(x) - gammaLn(a);
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) {
      ap++; del *= x / ap; sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(lnPre);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(lnPre) * h;
}

// ---------------------------------------------------------------
// Cylindre : dessin et animation physique de la bille
// ---------------------------------------------------------------
const Wheel = (() => {
  const canvas = $('#wheel');
  const ctx = canvas.getContext('2d');
  const wrap = $('#wheelWrap');
  const TRACK = 0.855;  // rayon de la piste de lancement (fraction du rayon)
  const POCKET = 0.565; // rayon où la bille repose dans une case
  const IDLE = 0.2;     // vitesse de rotation au repos (rad/s)
  const now = () => performance.now() / 1000;

  let px = 0;
  let bowl = null, rotor = null, gloss = null;
  // Moteur du cylindre : vitesse qui décroît linéairement de om0 vers IDLE en Tw secondes.
  let motor = { t0: now(), w0: RNG.range(0, TAU), om0: IDLE, Tw: 0 };
  const ball = { visible: false, rel: 0, r: POCKET };
  let spin = null;

  function angleAt(t) {
    const dt = t - motor.t0;
    const extra = motor.om0 - IDLE;
    if (dt < motor.Tw) return motor.w0 + IDLE * dt + extra * (dt - (dt * dt) / (2 * motor.Tw));
    return motor.w0 + IDLE * dt + (extra * motor.Tw) / 2;
  }
  function speedAt(t) {
    const dt = t - motor.t0;
    return IDLE + (dt < motor.Tw ? (motor.om0 - IDLE) * (1 - dt / motor.Tw) : 0);
  }

  // ---------- Dessin (pré-rendu dans des canvas hors écran) ----------
  function makeCanvas(p) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = p;
    return cv;
  }
  function ring(g, c, ro, ri, fill) {
    g.beginPath();
    g.arc(c, c, ro, 0, TAU);
    g.arc(c, c, ri, 0, TAU, true);
    g.fillStyle = fill;
    g.fill();
  }

  function paintBowl(p) {
    const cv = makeCanvas(p), g = cv.getContext('2d');
    const c = p / 2, R = c * 0.985;
    // ombre portée + jante en bois
    g.save();
    g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = R * 0.05; g.shadowOffsetY = R * 0.015;
    g.beginPath(); g.arc(c, c, R * 0.995, 0, TAU); g.fillStyle = '#2a140a'; g.fill();
    g.restore();
    let gr = g.createRadialGradient(c, c, R * 0.89, c, c, R);
    gr.addColorStop(0, '#3b1f0f'); gr.addColorStop(0.35, '#83491f'); gr.addColorStop(0.7, '#5b2f14'); gr.addColorStop(1, '#2a140a');
    ring(g, c, R, R * 0.9, gr);
    g.beginPath(); g.arc(c, c, R * 0.9, 0, TAU);
    g.strokeStyle = '#d8b45a'; g.lineWidth = R * 0.012; g.stroke();
    // piste inclinée
    gr = g.createRadialGradient(c, c, R * 0.76, c, c, R * 0.9);
    gr.addColorStop(0, '#0c0c0c'); gr.addColorStop(0.55, '#262626'); gr.addColorStop(1, '#3e3e3e');
    ring(g, c, R * 0.895, R * 0.76, gr);
    g.beginPath(); g.arc(c, c, R * TRACK, 0, TAU);
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = R * 0.03; g.stroke();
    // losanges déflecteurs
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8 + TAU / 16;
      g.save();
      g.translate(c + Math.cos(a) * R * 0.8, c + Math.sin(a) * R * 0.8);
      g.rotate(a + (i % 2 ? 0 : Math.PI / 2));
      const L = R * 0.034, W = R * 0.014;
      g.beginPath(); g.moveTo(L, 0); g.lineTo(0, W); g.lineTo(-L, 0); g.lineTo(0, -W); g.closePath();
      const dg = g.createLinearGradient(-L, -W, L, W);
      dg.addColorStop(0, '#fff3c8'); dg.addColorStop(0.5, '#d8b45a'); dg.addColorStop(1, '#7c5c1c');
      g.fillStyle = dg; g.fill();
      g.restore();
    }
    return cv;
  }

  function paintRotor(p) {
    const cv = makeCanvas(p), g = cv.getContext('2d');
    const c = p / 2, R = c * 0.985;
    const R1 = R * 0.76, R2 = R * 0.63, R3 = R * 0.5;
    for (let i = 0; i < 37; i++) {
      const n = WHEEL_ORDER[i];
      const a = i * SEG - Math.PI / 2;
      const a0 = a - SEG / 2, a1 = a + SEG / 2;
      const col = n === 0 ? ['#0f8a4c', '#0a5c33'] : RED.has(n) ? ['#c3161d', '#80101a'] : ['#1b1b1b', '#0a0a0a'];
      g.beginPath(); g.arc(c, c, R1, a0, a1); g.arc(c, c, R2, a1, a0, true); g.closePath();
      g.fillStyle = col[0]; g.fill();
      g.beginPath(); g.arc(c, c, R2, a0, a1); g.arc(c, c, R3, a1, a0, true); g.closePath();
      g.fillStyle = col[1]; g.fill();
      // numéro
      g.save();
      g.translate(c + Math.cos(a) * R * 0.697, c + Math.sin(a) * R * 0.697);
      g.rotate(a + Math.PI / 2);
      g.fillStyle = '#fff';
      g.font = `700 ${R * 0.07}px Inter, "Helvetica Neue", Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(n), 0, 0);
      g.restore();
    }
    // profondeur des cases
    const pg = g.createRadialGradient(c, c, R3, c, c, R2);
    pg.addColorStop(0, 'rgba(0,0,0,.5)'); pg.addColorStop(1, 'rgba(0,0,0,0)');
    ring(g, c, R2, R3, pg);
    // séparateurs (frettes)
    g.strokeStyle = '#d8b45a'; g.lineWidth = R * 0.008; g.lineCap = 'round';
    for (let i = 0; i < 37; i++) {
      const a = i * SEG - Math.PI / 2 - SEG / 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * R3, c + Math.sin(a) * R3);
      g.lineTo(c + Math.cos(a) * R1, c + Math.sin(a) * R1);
      g.stroke();
    }
    [[R1, 0.016], [R2, 0.008], [R3, 0.012]].forEach(([r, w]) => {
      g.beginPath(); g.arc(c, c, r, 0, TAU); g.lineWidth = R * w; g.stroke();
    });
    // cône central en bois
    const cg = g.createRadialGradient(c - R * 0.12, c - R * 0.14, R * 0.02, c, c, R3);
    cg.addColorStop(0, '#b0703f'); cg.addColorStop(0.55, '#6d3b1b'); cg.addColorStop(1, '#3a1d0c');
    g.beginPath(); g.arc(c, c, R3 - R * 0.006, 0, TAU); g.fillStyle = cg; g.fill();
    g.strokeStyle = 'rgba(255,220,170,.06)'; g.lineWidth = R * 0.004;
    for (let i = 0; i < 36; i++) {
      const a = (i * TAU) / 36;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * R * 0.12, c + Math.sin(a) * R * 0.12);
      g.lineTo(c + Math.cos(a) * R * 0.48, c + Math.sin(a) * R * 0.48);
      g.stroke();
    }
    g.beginPath(); g.arc(c, c, R * 0.42, 0, TAU); g.strokeStyle = 'rgba(216,180,90,.55)'; g.lineWidth = R * 0.006; g.stroke();
    // tourelle dorée
    g.save();
    g.translate(c, c);
    for (let k = 0; k < 4; k++) {
      g.rotate(TAU / 4);
      const lg = g.createLinearGradient(0, -R * 0.02, 0, R * 0.02);
      lg.addColorStop(0, '#fff1c1'); lg.addColorStop(0.5, '#d8b45a'); lg.addColorStop(1, '#8a6a22');
      g.fillStyle = lg;
      g.fillRect(R * 0.05, -R * 0.016, R * 0.25, R * 0.032);
      g.beginPath(); g.arc(R * 0.31, 0, R * 0.032, 0, TAU); g.fill();
    }
    const bg = g.createRadialGradient(-R * 0.03, -R * 0.03, R * 0.01, 0, 0, R * 0.085);
    bg.addColorStop(0, '#fff6d6'); bg.addColorStop(0.5, '#d8b45a'); bg.addColorStop(1, '#7c5c1c');
    g.beginPath(); g.arc(0, 0, R * 0.085, 0, TAU); g.fillStyle = bg; g.fill();
    g.restore();
    return cv;
  }

  function paintGloss(p) {
    const cv = makeCanvas(p), g = cv.getContext('2d');
    const c = p / 2, R = c * 0.985;
    g.beginPath(); g.arc(c, c, R * 0.9, 0, TAU); g.clip();
    const gr = g.createLinearGradient(0, 0, p, p);
    gr.addColorStop(0, 'rgba(255,255,255,.10)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0)');
    gr.addColorStop(1, 'rgba(0,0,0,.2)');
    g.fillStyle = gr; g.fillRect(0, 0, p, p);
    return cv;
  }

  function resize() {
    const css = wrap.clientWidth;
    if (!css) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const p = Math.round(css * dpr);
    if (p === px) return;
    px = p;
    canvas.width = canvas.height = p;
    bowl = paintBowl(p); rotor = paintRotor(p); gloss = paintGloss(p);
  }
  new ResizeObserver(resize).observe(wrap);
  if (document.fonts && document.fonts.load) {
    document.fonts.load('700 20px Inter').then(() => { if (px) rotor = paintRotor(px); }, () => {});
  }

  // ---------- Trajectoire de la bille ----------
  // Phase A : la bille roule sur la piste en sens inverse du cylindre et ralentit.
  // Phase B : elle tombe, rebondit sur les frettes puis se cale dans la case tirée.
  function ballDuringSpin(t, dt, w) {
    const s = spin;
    if (dt < s.Ta) {
      const a = s.b0 - (s.wb0 * dt - ((s.wb0 - s.wb1) * dt * dt) / (2 * s.Ta));
      const k = Math.min(1, dt / 0.7);
      const r = s.r0 + (TRACK - s.r0) * (1 - (1 - k) * (1 - k));
      return { a, r };
    }
    const u = Math.min(1, (dt - s.Ta) / s.Tb);
    const u2 = u * u, u3 = u2 * u;
    // interpolation d'Hermite : vitesse de départ continue, vitesse relative nulle à l'arrivée
    let rel = s.phiA + (u3 - 2 * u2 + u) * s.m0 + (3 * u2 - 2 * u3) * s.dB;
    const decay = (1 - u) * (1 - u);
    rel += s.jA * Math.sin(Math.PI * s.jN * u) * decay; // rebonds latéraux
    const fall = 1 - Math.pow(1 - Math.min(1, u * 1.6), 2);
    let r = TRACK + (POCKET - TRACK) * fall + 0.06 * Math.abs(Math.sin(Math.PI * s.bN * u)) * decay;
    r = Math.min(r, TRACK);
    if (!s.dropped) { s.dropped = true; Sound.tick(0.7); }
    const idx = Math.floor(mod(rel + SEG / 2, TAU) / SEG);
    if (idx !== s.lastIdx) {
      if (s.lastIdx !== undefined && fall > 0.55) Sound.tick(0.06 + 0.4 * (1 - u));
      s.lastIdx = idx;
    }
    return { a: w + rel, r };
  }

  function drawBall(c, R, pos) {
    const x = c + Math.cos(pos.a - Math.PI / 2) * pos.r * R;
    const y = c + Math.sin(pos.a - Math.PI / 2) * pos.r * R;
    const br = R * 0.034;
    ctx.beginPath(); ctx.arc(x + br * 0.3, y + br * 0.4, br * 1.05, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
    const g = ctx.createRadialGradient(x - br * 0.35, y - br * 0.4, br * 0.1, x, y, br);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.55, '#ececec'); g.addColorStop(1, '#8f8f8f');
    ctx.beginPath(); ctx.arc(x, y, br, 0, TAU); ctx.fillStyle = g; ctx.fill();
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!px || canvas.offsetParent === null) return;
    const t = now();
    const c = px / 2, R = c * 0.985;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(bowl, 0, 0);
    const w = angleAt(t);
    ctx.save(); ctx.translate(c, c); ctx.rotate(w); ctx.drawImage(rotor, -c, -c); ctx.restore();

    let pos = null;
    if (spin) {
      const dt = t - spin.t0;
      if (dt >= spin.Ta + spin.Tb) {
        ball.rel = mod(spin.P, TAU);
        ball.r = POCKET;
        const done = spin.onDone;
        spin = null;
        if (done) setTimeout(done, 450);
      } else {
        pos = ballDuringSpin(t, dt, w);
      }
    }
    if (!pos && ball.visible) pos = { a: w + ball.rel, r: ball.r };
    if (pos) drawBall(c, R, pos);
    ctx.drawImage(gloss, 0, 0);
  }
  requestAnimationFrame(frame);

  /**
   * Lance le cylindre et la bille. Le numéro `result` est déjà tiré :
   * on choisit aléatoirement les paramètres physiques, puis on ajuste
   * la vitesse de lancer pour que la bille finisse exactement dans sa case.
   * `opt.Ta` / `opt.Tb` imposent les durées (identiques pour tous les joueurs d'une table).
   */
  function launch(result, opt = {}) {
    const t0 = now();
    const w0 = mod(angleAt(t0), TAU);
    const restingAngle = w0 + ball.rel;
    motor = { t0, w0, om0: RNG.range(2.2, 3.1), Tw: RNG.range(11, 14) };

    const r0 = ball.visible ? ball.r : TRACK;
    const b0 = ball.visible ? mod(restingAngle, TAU) : RNG.range(0, TAU);
    const Ta = opt.Ta || RNG.range(4.2, 5.4); // durée sur la piste
    const Tb = opt.Tb || RNG.range(2.1, 2.8); // durée de la chute et des rebonds
    const wb1 = RNG.range(2.4, 3.2);     // vitesse de la bille au moment de la chute
    const wb0Base = RNG.range(8.5, 10.5);
    const beta = RNG.range(0.4, 0.55);   // forme du freinage final

    const wTa = angleAt(t0 + Ta);
    const vRel = -(wb1 + speedAt(t0 + Ta));
    const dB = beta * vRel * Tb;
    const P = WHEEL_ORDER.indexOf(result) * SEG;
    const aBase = ((wb0Base + wb1) / 2) * Ta;
    // On a besoin de : b0 − A − w(Ta) + dB ≡ P (mod 2π)
    const delta = mod(b0 - wTa + dB - P - aBase, TAU);
    const A = aBase + delta;

    spin = {
      t0, b0, r0, Ta, Tb, wb1,
      wb0: (2 * A) / Ta - wb1,
      phiA: b0 - A - wTa,
      m0: vRel * Tb,
      dB, P,
      jA: RNG.range(0.12, 0.3) * (RNG.int(2) ? 1 : -1),
      jN: 2 + RNG.int(3),
      bN: 3 + RNG.int(3),
      onDone: opt.onDone || null,
    };
    ball.visible = true;
  }

  /** Pose directement la bille dans la case `result` (fin d'animation forcée). */
  function place(result) {
    spin = null;
    ball.visible = true;
    ball.r = POCKET;
    ball.rel = WHEEL_ORDER.indexOf(result) * SEG;
  }
  /** Termine l'animation en cours (onglet en arrière-plan, arrivée en cours de tour…). */
  function finish(result) {
    if (spin && spin.P === WHEEL_ORDER.indexOf(result) * SEG) {
      ball.rel = mod(spin.P, TAU);
      ball.r = POCKET;
      spin = null;
      return;
    }
    place(result);
  }
  const spinning = () => !!spin;

  function reset() {
    spin = null;
    ball.visible = false;
  }

  return { launch, place, finish, spinning, reset, resize };
})();

// ---------------------------------------------------------------
// Table : en solo (dans ce navigateur) ou entre amis (hôte / invité)
// Le moteur (roulette-core.js) fait tourner les tours tout seul.
// ---------------------------------------------------------------
const RC = RouletteCore;
let ctrl = null;      // { mode: 'solo' | 'host' | 'guest', send(m), leave() → Promise<{ stack } | { error }> }
let view = null;      // dernier état reçu
let soloTable = null; // la table solo garde son historique d'une visite à l'autre
let chip = 5;
let animSpin = -1;    // dernier tirage animé
let revealed = -1;    // dernier tirage annoncé
let shownNet = null;  // « Dernier coup » affiché
let deadlineAt = 0;
let ticker = 0;
let bustTimer = 0;
let bustShown = false;

const meOf = (v) => (v && v.you >= 0 ? v.players[v.you] : null);
const isNet = () => !!ctrl && ctrl.mode !== 'solo';

// ---------------------------------------------------------------
// Tapis de jeu
// ---------------------------------------------------------------
const board = $('#board');
const spots = new Map();
const numberCells = [];
const chipEls = new Map();   // mes jetons : clé → élément
const otherEls = new Map();  // jetons des autres joueurs : « clé|place » → élément

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function addSpot(node, numbers, label, opts = {}) {
  const key = opts.key || 'n:' + [...numbers].sort((a, b) => a - b).join('-');
  if (!RC.SPOTS.has(key)) console.warn('Mise inconnue du moteur :', key);
  spots.set(key, { key, numbers, label, even: !!opts.even, el: node });
  node.dataset.key = key;
}

function buildBoard() {
  const zero = el('div', 'cell num zero', '<span>0</span>');
  zero.style.gridColumn = '1';
  zero.style.gridRow = '1 / 4';
  board.append(zero);
  numberCells[0] = zero;
  addSpot(zero, [0], 'Plein 0');

  const area = el('div', 'numbers-area');
  area.style.gridColumn = '2 / 14';
  area.style.gridRow = '1 / 4';
  board.append(area);

  const numAt = (c, r) => 3 * c + 3 - r; // r = 0 en haut (3, 6, 9…)
  for (let c = 0; c < 12; c++) {
    for (let r = 0; r < 3; r++) {
      const n = numAt(c, r);
      const cell = el('div', `cell num ${colorOf(n)}`, `<span>${n}</span>`);
      cell.style.gridColumn = String(c + 1);
      cell.style.gridRow = String(r + 1);
      area.append(cell);
      numberCells[n] = cell;
      addSpot(cell, [n], `Plein ${n}`);
    }
  }

  // Zones à cheval des lignes et coins (positions en % de la grille des numéros)
  const CW = 100 / 12, CH = 100 / 3;
  const VW = CW * 0.34, VH = CH * 0.6, HW = CW * 0.6, HH = CH * 0.3;
  const hot = (cls, x, y, w, h, nums, label) => {
    const e = el('div', 'hot ' + cls);
    e.style.left = `${x - w / 2}%`;
    e.style.top = `${y - h / 2}%`;
    e.style.width = `${w}%`;
    e.style.height = `${h}%`;
    area.append(e);
    addSpot(e, nums, label);
  };
  for (let c = 0; c < 11; c++) for (let r = 0; r < 3; r++) {
    const n = numAt(c, r);
    hot('split', (c + 1) * CW, (r + 0.5) * CH, VW, VH, [n, n + 3], `Cheval ${n}/${n + 3}`);
  }
  for (let c = 0; c < 12; c++) for (let r = 0; r < 2; r++) {
    const n = numAt(c, r);
    hot('split', (c + 0.5) * CW, (r + 1) * CH, HW, HH, [n - 1, n], `Cheval ${n - 1}/${n}`);
  }
  for (let c = 0; c < 11; c++) for (let r = 0; r < 2; r++) {
    const n = numAt(c, r);
    const nums = [n - 1, n, n + 2, n + 3];
    hot('corner', (c + 1) * CW, (r + 1) * CH, VW, HH, nums, `Carré ${nums.join('/')}`);
  }
  for (let c = 0; c < 12; c++) {
    const nums = [3 * c + 1, 3 * c + 2, 3 * c + 3];
    hot('street', (c + 0.5) * CW, 100, HW, HH, nums, `Transversale ${nums.join('/')}`);
  }
  for (let c = 0; c < 11; c++) {
    const nums = [1, 2, 3, 4, 5, 6].map((k) => 3 * c + k);
    hot('corner', (c + 1) * CW, 100, VW, HH, nums, `Sixain ${nums[0]} à ${nums[5]}`);
  }
  for (let r = 0; r < 3; r++) {
    hot('split', 0, (r + 0.5) * CH, VW, VH, [0, 3 - r], `Cheval 0/${3 - r}`);
  }
  hot('corner', 0, CH, VW, HH, [0, 2, 3], 'Transversale 0/2/3');
  hot('corner', 0, 2 * CH, VW, HH, [0, 1, 2], 'Transversale 0/1/2');
  hot('corner', 0, 100, VW, HH, [0, 1, 2, 3], 'Carré 0/1/2/3');

  // Colonnes
  for (let r = 0; r < 3; r++) {
    const colNo = 3 - r;
    const nums = [];
    for (let n = colNo; n <= 36; n += 3) nums.push(n);
    const e = el('div', 'cell outside colbet', '2:1');
    e.style.gridColumn = '14';
    e.style.gridRow = String(r + 1);
    board.append(e);
    addSpot(e, nums, `Colonne ${colNo}`, { key: 'col' + colNo });
  }
  // Douzaines
  [['1 – 12', 'Premier 12'], ['13 – 24', 'Milieu 12'], ['25 – 36', 'Dernier 12']].forEach(([txt, sub], i) => {
    const e = el('div', 'cell outside', `${txt}<small>${sub}</small>`);
    e.style.gridColumn = `${2 + i * 4} / ${6 + i * 4}`;
    e.style.gridRow = '4';
    board.append(e);
    const nums = Array.from({ length: 12 }, (_, k) => 12 * i + k + 1);
    addSpot(e, nums, `Douzaine ${txt.replace(' – ', ' à ')}`, { key: 'dz' + (i + 1) });
  });
  // Chances simples
  const outs = [
    ['low', '1 – 18<small>Manque</small>', (n) => n <= 18, 'Manque (1 à 18)'],
    ['even', 'Pair', (n) => n % 2 === 0, 'Pair'],
    ['red', '<i class="diamond red"></i>', (n) => RED.has(n), 'Rouge'],
    ['black', '<i class="diamond black"></i>', (n) => !RED.has(n), 'Noir'],
    ['odd', 'Impair', (n) => n % 2 === 1, 'Impair'],
    ['high', '19 – 36<small>Passe</small>', (n) => n >= 19, 'Passe (19 à 36)'],
  ];
  outs.forEach(([key, html, test, label], i) => {
    const e = el('div', 'cell outside', html);
    e.style.gridColumn = `${2 + i * 2} / ${4 + i * 2}`;
    e.style.gridRow = '5';
    board.append(e);
    const nums = [];
    for (let n = 1; n <= 36; n++) if (test(n)) nums.push(n);
    addSpot(e, nums, label, { key, even: true });
  });
}

// ---------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------
const chipsEl = $('#chips');

function chipClass(amount) {
  let v = CHIP_VALUES[0];
  for (const c of CHIP_VALUES) if (amount >= c) v = c;
  return 'c' + v;
}
function shortAmount(a) {
  if (a >= 1000) {
    const k = a / 1000;
    return (Number.isInteger(k) ? String(k) : k.toFixed(1).replace('.', ',')) + 'k';
  }
  return Number.isInteger(a) ? String(a) : a.toFixed(1).replace('.', ',');
}
function defaultChip(amount) {
  let v = CHIP_VALUES[0];
  for (const c of CHIP_VALUES) if (c <= amount / 20) v = c;
  return v;
}

function buildChips() {
  chipsEl.innerHTML = '';
  for (const v of CHIP_VALUES) {
    const b = el('button', `chip c${v}`, `<span>${v >= 1000 ? v / 1000 + 'k' : v}</span>`);
    b.type = 'button';
    b.dataset.value = String(v);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Jeton de ${money(v)}`);
    chipsEl.append(b);
  }
  markChip();
}
function markChip() {
  for (const b of chipsEl.children) {
    const on = Number(b.dataset.value) === chip;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', String(on));
  }
}
chipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  chip = Number(b.dataset.value);
  markChip();
});

const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#9aa0a6');
const STATUS_CLS = { w: ' won', h: ' half', l: ' lost' };

function renderChips() {
  const v = view;
  const mine = new Map();
  const others = [];
  if (v && Array.isArray(v.bets)) {
    for (const b of v.bets) {
      const [k, a, seat, st] = b;
      if (!spots.has(k) || !(Number(a) > 0)) continue;
      if (seat === v.you) mine.set(k, [Number(a), st]);
      else others.push([k, Number(a), seat, st]);
    }
  }
  // Mes jetons
  for (const [key, node] of chipEls) {
    if (!mine.has(key)) { node.remove(); chipEls.delete(key); }
  }
  for (const [key, [amount, st]] of mine) {
    let node = chipEls.get(key);
    if (!node) {
      node = el('div');
      spots.get(key).el.append(node);
      chipEls.set(key, node);
    }
    node.className = 'chip-stack ' + chipClass(amount) + (STATUS_CLS[st] || '');
    node.textContent = shortAmount(amount);
  }
  // Jetons de couleur des autres joueurs
  const seenKeys = new Set();
  const perSpot = new Map();
  for (const [k, a, seat, st] of others) {
    const p = v.players[seat];
    if (!p) continue;
    const id = `${k}|${seat}`;
    seenKeys.add(id);
    const idx = perSpot.get(k) || 0;
    perSpot.set(k, idx + 1);
    let node = otherEls.get(id);
    if (!node) {
      node = el('div');
      spots.get(k).el.append(node);
      otherEls.set(id, node);
    }
    node.className = 'chip-other' + (STATUS_CLS[st] || '');
    node.style.setProperty('--pc', safeColor(p.color));
    node.style.setProperty('--k', String(Math.min(idx, 4)));
    node.title = `${p.name} : ${money(a)}`;
    node.textContent = shortAmount(a);
  }
  for (const [id, node] of otherEls) {
    if (!seenKeys.has(id)) { node.remove(); otherEls.delete(id); }
  }
}

// ---------------------------------------------------------------
// Actions du joueur (envoyées au moteur, ou à l'hôte)
// ---------------------------------------------------------------
function send(m) { if (ctrl) ctrl.send(m); }

function canBet() {
  const me = meOf(view);
  if (!me) return false;
  if (view.phase !== 'betting') { toast('Les jeux sont faits : attendez le prochain tour.'); return false; }
  return true;
}
function placeBet(key) {
  if (!canBet()) return;
  const me = meOf(view);
  if (chip > me.stack + 1e-9) {
    toast(me.stack >= 1 ? 'Solde insuffisant : choisissez un jeton plus petit.' : 'Solde insuffisant.');
    return;
  }
  Sound.chip();
  send({ t: 'bet', key, amount: chip });
}
function removeBet(key) {
  if (!canBet()) return;
  send({ t: 'unbet', key });
}

// ---------------------------------------------------------------
// Annonces, résultat et compte à rebours
// ---------------------------------------------------------------
function describe(n) {
  if (n === 0) return 'Zéro';
  return `${n} · ${RED.has(n) ? 'Rouge' : 'Noir'} · ${n % 2 ? 'Impair' : 'Pair'} · ${n <= 18 ? 'Manque' : 'Passe'}`;
}

let annKey = '';
function announce(main, sub, cls = '') {
  const k = main + '|' + sub + '|' + cls;
  if (k === annKey) return; // évite de répéter l'annonce aux lecteurs d'écran
  annKey = k;
  $('#announce').textContent = main;
  const s = $('#announceSub');
  s.textContent = sub;
  s.className = 'announce-sub' + (cls ? ' ' + cls : '');
}

function showBadge(n) {
  const b = $('#resultBadge');
  b.hidden = false;
  b.className = 'result-badge ' + colorOf(n);
  b.textContent = String(n);
  b.style.animation = 'none';
  void b.offsetWidth; // relance l'animation
  b.style.animation = '';
}

function clearWinner() {
  for (const c of numberCells) c.classList.remove('winner');
}

function reveal(v) {
  const n = v.result;
  Wheel.finish(n);
  showBadge(n);
  clearWinner();
  numberCells[n].classList.add('winner');
  const s = v.mine && v.mine.settle;
  if (s) {
    shownNet = s.net;
    if (s.net > 0) Sound.win();
  }
}

function resultLine(v) {
  const s = v.mine && v.mine.settle;
  if (!s) return [meOf(v) ? 'Vous n’aviez pas misé sur ce tour.' : '', ''];
  const { ret, net } = s;
  if (ret === 0) return [`Perdu ${signed(net)}`, 'neg'];
  if (net > 0) return [`Vous gagnez ${money(ret)} (${signed(net)})`, 'pos'];
  if (net < 0) return [`Vous récupérez ${money(ret)} (${signed(net)})`, 'neg'];
  return [`Mise récupérée (${signed(0)})`, ''];
}

/** Met à jour le compte à rebours et l'annonce du croupier (appelé plusieurs fois par seconde). */
function tick() {
  const v = view;
  if (!v || !ctrl) return;
  const bar = $('#rlTimer');
  if (v.phase === 'betting') {
    const left = Math.max(0, deadlineAt - performance.now());
    const sec = Math.ceil(left / 1000);
    bar.classList.remove('idle');
    bar.firstElementChild.style.width = `${clamp(left / (v.betTime || 1), 0, 1) * 100}%`;
    bar.classList.toggle('late', left <= v.lastCall);
    const mine = v.mine || {};
    let extra = '';
    if (isNet()) {
      const ps = v.players.filter((p) => p && p.connected);
      const ready = ps.filter((p) => p.ready).length;
      if (ps.length > 1) extra = ` · ${ready}/${ps.length} prêt${ready > 1 ? 's' : ''}`;
    }
    if (left <= 0) announce('Rien ne va plus', 'Les jeux sont faits');
    else if (left <= v.lastCall) announce('Derniers jeux', `Les jeux ferment dans ${sec} s${extra}`);
    else if (mine.ready) announce('Faites vos jeux', `Prêt · lancement dans ${sec} s${extra}`);
    else announce('Faites vos jeux', `Les jeux ferment dans ${sec} s${extra}`);
    return;
  }
  bar.classList.add('idle');
  bar.classList.remove('late');
  bar.firstElementChild.style.width = '0%';
  if (v.phase === 'spinning') {
    announce('Rien ne va plus', 'La bille est lancée…');
  } else if (v.phase === 'result' && Number.isInteger(v.result)) {
    const [sub, cls] = resultLine(v);
    announce(describe(v.result), sub, cls);
  }
}

// ---------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------
function onView(v) {
  view = v;
  if (v.phase === 'betting') deadlineAt = performance.now() + (Number(v.deadlineMs) || 0);
  // Nouveau tirage : la bille est lancée (même durée chez tous les joueurs)
  if (v.spin && v.spin.id !== animSpin) {
    animSpin = v.spin.id;
    clearWinner();
    $('#resultBadge').hidden = true;
    if (v.phase === 'spinning' && v.spin.elapsedMs < 1500) {
      Wheel.launch(v.spin.result, { Ta: Number(v.spin.Ta), Tb: Number(v.spin.Tb) });
    } else {
      Wheel.reset(); // arrivé en cours de tour : la bille apparaîtra avec le résultat
    }
  }
  if (v.phase === 'result' && Number.isInteger(v.result) && v.round !== revealed) {
    revealed = v.round;
    reveal(v);
  }
  render();
}

function render() {
  if (!view || !ctrl) return;
  const v = view;
  const me = meOf(v);
  const mine = v.mine || {};
  const betting = v.phase === 'betting' && !!me;
  const tb = me ? Number(me.bet) || 0 : 0;
  const stack = me ? Number(me.stack) || 0 : 0;

  $('#balanceLabel').textContent = isNet() ? 'Tapis' : 'Solde';
  $('#balance').textContent = me ? money(stack) : '—';
  $('#totalBet').textContent = money(tb);
  const ln = $('#lastNet');
  if (shownNet === null) { ln.textContent = '—'; ln.className = ''; }
  else { ln.textContent = signed(shownNet); ln.className = netClass(shownNet); }

  $('#undoBtn').disabled = !betting || !mine.undo;
  $('#clearBtn').disabled = !betting || tb === 0;
  $('#doubleBtn').disabled = !betting || tb === 0 || tb > stack;
  $('#rebetBtn').disabled = !betting || !mine.lastBets || mine.lastBets > stack;
  const sb = $('#spinBtn');
  if (isNet()) {
    sb.textContent = mine.ready ? 'Prêt ✓' : 'Je suis prêt';
    sb.title = mine.ready ? 'Cliquez pour annuler' : 'La bille part dès que tous les joueurs sont prêts';
    sb.disabled = !betting;
  } else {
    sb.textContent = mine.ready ? 'Lancement…' : 'Lancer la bille';
    sb.title = '';
    sb.disabled = !betting || tb === 0 || mine.ready;
  }
  sb.classList.toggle('on', !!mine.ready);
  $('#rlAuto').checked = !!mine.auto;
  $('#rlAuto').disabled = !me;
  // L'hôte peut fermer la table à tout moment (le tour en cours est alors annulé)
  $('#leaveBtn').disabled = v.phase === 'spinning' && tb > 0 && ctrl.mode !== 'host';
  for (const b of chipsEl.children) b.classList.toggle('dim', Number(b.dataset.value) > stack);

  renderChips();
  renderStats(Array.isArray(v.history) ? v.history.filter((n) => Number.isInteger(n) && n >= 0 && n <= 36) : []);
  if (isNet()) Net.updatePanel(v.room, playersHtml(v));
  tick();
  checkBust(v, me);
}

function playersHtml(v) {
  const rows = [];
  v.players.forEach((p, i) => {
    if (!p) return;
    let tag = '';
    if (!p.connected) tag = '<span class="np-tag off">déconnecté</span>';
    else if (v.phase === 'betting' && p.ready) tag = '<span class="np-tag ok">prêt</span>';
    else if (v.phase === 'result' && p.played && typeof p.lastNet === 'number') tag = `<span class="np-tag ${netClass(p.lastNet)}">${signed(p.lastNet)}</span>`;
    rows.push(`<div class="np-row${i === v.you ? ' you' : ''}">
        <i class="np-dot" style="background:${safeColor(p.color)}"></i>
        <span class="np-name">${esc(p.name)}${i === v.you ? ' <small>(vous)</small>' : ''}</span>${tag}
        <span class="np-bet">${Number(p.bet) ? money(Number(p.bet)) : ''}</span>
        <span class="np-stack">${money(Number(p.stack) || 0)}</span>
      </div>`);
  });
  return `<div class="np-head"><span>Joueurs</span><span>Mise · Tapis</span></div>${rows.join('')}`;
}

function checkBust(v, me) {
  const broke = me && me.stack < 1 && !(me.bet > 0) && v.phase !== 'spinning';
  if (!broke) {
    clearTimeout(bustTimer);
    bustTimer = 0;
    if (me && me.stack >= 1) bustShown = false;
    return;
  }
  if (bustTimer || bustShown) return;
  bustTimer = setTimeout(async () => {
    bustTimer = 0;
    const m = meOf(view);
    if (!ctrl || !m || m.stack >= 1 || m.bet > 0 || document.querySelector('dialog[open]')) return;
    bustShown = true;
    if (!isNet()) {
      if (await confirmBox('Plus de jetons', '<p>Vous n’avez plus de jetons. Ajoutez-en à la caisse pour continuer à jouer, ou retournez au hall.</p>', 'Ajouter des jetons', 'Retour au hall')) openCash();
      else leave(true);
    } else if (await confirmBox('Plus de jetons', '<p>Vous n’avez plus de jetons à cette table. Vous pouvez en ajouter sans quitter la partie.</p>', 'Ajouter des jetons', 'Plus tard')) {
      openCash();
    }
  }, 2200);
}

// Survol : surligne les numéros couverts et indique le paiement
let hoverKey = null;
const DEFAULT_INFO = 'Survolez le tapis pour voir chaque mise et ce qu\'elle paie.';
function setHover(key) {
  if (key === hoverKey) return;
  if (hoverKey) {
    for (const n of spots.get(hoverKey).numbers) numberCells[n].classList.remove('hl');
  }
  hoverKey = key;
  if (key) {
    for (const n of spots.get(key).numbers) numberCells[n].classList.add('hl');
    showSpotInfo(key);
  } else {
    $('#betInfo').textContent = DEFAULT_INFO;
  }
}
function showSpotInfo(key) {
  const s = spots.get(key);
  const k = s.numbers.length;
  let on = 0;
  if (view && Array.isArray(view.bets)) for (const b of view.bets) if (b[0] === key && b[2] === view.you) on += Number(b[1]) || 0;
  let html = `<b>${s.label}</b> · ${k} numéro${k > 1 ? 's' : ''} · <span class="pay">paie ${36 / k - 1} contre 1</span>`;
  if (s.even) html += ' · la partage sur le zéro';
  if (on) html += ` · misé : <b>${money(on)}</b>`;
  $('#betInfo').innerHTML = html;
}

board.addEventListener('click', (e) => {
  const t = e.target.closest('[data-key]');
  if (t) placeBet(t.dataset.key);
});
board.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('[data-key]');
  if (!t) return;
  e.preventDefault();
  removeBet(t.dataset.key);
});
board.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-key]');
  setHover(t ? t.dataset.key : null);
});
board.addEventListener('mouseleave', () => setHover(null));

// Historique et statistiques
function splitRow(parts, n) {
  const labels = parts
    .filter((p) => p[0])
    .map(([l, v]) => `<span>${l} <b>${Math.round((v / n) * 100)} %</b></span>`)
    .join('');
  const bars = parts.map(([, v, col]) => `<i style="width:${(v / n) * 100}%;background:${col}"></i>`).join('');
  return `<div class="split"><div class="split-labels">${labels}</div><div class="split-bar">${bars}</div></div>`;
}

function renderStats(h) {
  const n = h.length;
  $('#roundCount').textContent = `${n} tour${n > 1 ? 's' : ''}`;
  $('#historyList').innerHTML = n
    ? h.slice(0, 16).map((x, i) => `<span class="hnum ${colorOf(x)}${i === 0 ? ' latest' : ''}">${x}</span>`).join('')
    : '<span class="muted">Aucun tirage pour l\'instant</span>';

  const box = $('#statsBox');
  if (!n) { box.innerHTML = ''; return; }
  const c = { red: 0, black: 0, zero: 0, even: 0, odd: 0, low: 0, high: 0 };
  for (const x of h) {
    if (x === 0) { c.zero++; continue; }
    if (RED.has(x)) c.red++; else c.black++;
    if (x % 2) c.odd++; else c.even++;
    if (x <= 18) c.low++; else c.high++;
  }
  const Z = 'var(--zero)';
  let html = '';
  html += splitRow([['Rouge', c.red, 'var(--red)'], ['Zéro', c.zero, Z], ['Noir', c.black, '#050505']], n);
  html += splitRow([['Pair', c.even, '#c9b27a'], [null, c.zero, Z], ['Impair', c.odd, '#6f8f7c']], n);
  html += splitRow([['Manque', c.low, '#c9b27a'], [null, c.zero, Z], ['Passe', c.high, '#6f8f7c']], n);

  if (n >= 10) {
    const counts = new Array(37).fill(0);
    for (const x of h) counts[x]++;
    const all = [...counts.keys()];
    const hot = all.filter((i) => counts[i] > 0)
      .sort((a, b) => counts[b] - counts[a] || h.indexOf(a) - h.indexOf(b))
      .slice(0, 5);
    const gap = (i) => { const k = h.indexOf(i); return k === -1 ? n : k; };
    const cold = all.slice().sort((a, b) => gap(b) - gap(a)).slice(0, 5);
    const chipH = (i, title) => `<span class="hnum sm ${colorOf(i)}" title="${title}">${i}</span>`;
    html += `<div class="hotcold"><span>Chauds</span><div class="row">${hot.map((i) => chipH(i, `Sorti ${counts[i]} fois`)).join('')}</div>`;
    html += `<span>Absents</span><div class="row">${cold.map((i) => chipH(i, `Absent depuis ${gap(i)} tours`)).join('')}</div></div>`;
    html += '<p class="footnote">Chaque tirage est indépendant : un numéro « chaud » ou absent n\'a ni plus ni moins de chances de sortir.</p>';
  } else {
    html += '<p class="footnote">Numéros chauds et absents affichés après 10 tours.</p>';
  }
  box.innerHTML = html;
}

// ---------------------------------------------------------------
// Ouverture d'une table
// ---------------------------------------------------------------
function resetSession() {
  view = null;
  animSpin = -1;
  revealed = -1;
  shownNet = null;
  annKey = '';
  bustShown = false;
  clearTimeout(bustTimer);
  bustTimer = 0;
  clearWinner();
  $('#resultBadge').hidden = true;
  for (const n of chipEls.values()) n.remove();
  chipEls.clear();
  for (const n of otherEls.values()) n.remove();
  otherEls.clear();
}

function openTable(stack) {
  if (!chip || chip > stack) chip = defaultChip(stack);
  markChip();
  if (isNet()) Net.mountPanel($('#rlNetSlot'), ctrl);
  else Net.hidePanel();
  $('#betInfo').textContent = DEFAULT_INFO;
  showScreen('roulette');
  clearInterval(ticker);
  ticker = setInterval(tick, 200);
  render();
}

function closeSession() {
  ctrl = null;
  view = null;
  clearInterval(ticker);
  clearTimeout(bustTimer);
  Net.hidePanel();
}

/** Roulette en solo : le portefeuille entier est apporté à la table. */
function enter() {
  if (!soloTable) {
    soloTable = new RC.Table({
      betTime: 15000, resultTime: 4500, seats: 1,
      onUpdate: () => { if (ctrl && ctrl.mode === 'solo') onView(soloTable.view('me')); },
    });
  }
  const stack = Wallet.balance;
  Wallet.take(stack);
  ctrl = {
    mode: 'solo',
    send: (m) => { const e = soloTable.apply('me', m); if (e) toast(e); },
    addChips: async (v) => { const e = soloTable.addChips('me', v); return { ok: !e, msg: e }; },
    leave: async () => {
      const s = soloTable.removePlayer('me');
      if (s === null) return { error: 'Attendez la fin du tour : vos jetons sont en jeu.' };
      soloTable.stop();
      return { stack: s };
    },
  };
  resetSession();
  soloTable.addPlayer({ id: 'me', name: 'Vous', stack });
  soloTable.start();
  openTable(stack);
}

/** Table entre amis : ce navigateur fait tourner la roulette. */
function startHost(peer, code, cfg) {
  let room = null;
  const table = new RC.Table({
    betTime: cfg.betTime, resultTime: 5000, seats: 8,
    onUpdate: () => { if (room) room.broadcast(); },
  });
  const game = {
    type: 'roulette',
    info: () => {
      const n = table.players().length;
      return {
        detail: `${n} joueur${n > 1 ? 's' : ''} · ${Math.round(cfg.betTime / 1000)} s pour miser`,
        free: table.seats.filter((s) => !s).length,
        buyIn: { min: 10, max: 100000, step: 1 },
      };
    },
    join: (id, name, stack) => (table.addPlayer({ id, name, stack }) < 0 ? 'La table est complète (8 joueurs).' : ''),
    view: (id) => table.view(id),
    handle: (id, m) => {
      if (m.t === 'add') { const e = table.addChips(id, m.amount); return { t: 'added', ok: !e, msg: e }; }
      const e = table.apply(id, m);
      return e ? { t: 'err', msg: e } : null;
    },
    setConnected: (id, ok) => table.setConnected(id, ok),
    leave: (id) => {
      const s = table.removePlayer(id);
      return s === null ? { error: 'Attendez la fin du tour : vos jetons sont en jeu.' } : { stack: s };
    },
    canDrop: (id) => table.canLeave(id),
    closeAll: () => {
      table.cancel();
      const m = new Map();
      for (const p of table.players()) m.set(p.id, p.stack);
      return m;
    },
  };
  const c = { mode: 'host' };
  room = Net.host(peer, code, cfg.name, game, (v) => { if (ctrl === c) onView(v); });
  c.room = room;
  c.send = (m) => { const e = table.apply('host', m); if (e) toast(e); };
  c.addChips = async (v) => { const e = table.addChips('host', v); return { ok: !e, msg: e }; };
  c.chat = (t) => room.chat(t);
  c.leave = async () => ({ stack: room.close() });
  ctrl = c;
  resetSession();
  table.addPlayer({ id: 'host', name: cfg.name, stack: cfg.buyIn });
  table.start();
  openTable(cfg.buyIn);
}

/** Invité : la roulette tourne chez l'hôte, on affiche ce qu'il envoie. */
function startGuest(peer, conn, code, token) {
  const c = { mode: 'guest' };
  const g = Net.guest(peer, conn, code, token, {
    onView: (v) => { if (ctrl === c) onView(v); },
    onEnd: (stack, msg) => {
      if (ctrl !== c) return;
      closeSession();
      if (stack > 0) Wallet.give(stack);
      infoBox('Table fermée', `<p>${esc(msg)}</p><p>Vous récupérez <b>${money(stack)}</b>.</p>`, 'Retour au hall').then(backToHall);
    },
    onAbort: () => { if (ctrl === c) { closeSession(); backToHall(); } },
  });
  c.send = (m) => g.send(m);
  c.addChips = async (v) => {
    const r = await g.request({ t: 'add', amount: v }, 'added');
    return { ok: !!r.ok, msg: Net.cleanText(r.msg, 200) };
  };
  c.chat = (t) => g.chat(t);
  c.leave = () => g.leave();
  ctrl = c;
  resetSession();
  openTable(Wallet.balance);
}

async function leave(skipConfirm) {
  if (!ctrl) return;
  const v = view;
  const me = meOf(v);
  const c = ctrl;
  if (v && v.phase === 'spinning' && me && me.bet > 0 && c.mode !== 'host') { toast('Attendez la fin du tour : vos jetons sont en jeu.'); return; }
  if (c.mode !== 'solo' && !skipConfirm) {
    const total = me ? me.stack + me.bet : 0;
    let html = `<p>Vous repartez avec <b>${money(total)}</b>${me && me.bet ? ' (vos mises posées vous sont rendues)' : ''}.</p>`;
    if (c.mode === 'host') {
      html += c.room.guestCount() > 0
        ? '<p><b>Vous êtes l’hôte :</b> la table sera fermée, le tour en cours annulé et chaque joueur récupérera ses jetons.</p>'
        : '<p class="muted">La table sera fermée.</p>';
    }
    if (!(await confirmBox(c.mode === 'host' ? 'Fermer la table ?' : 'Quitter la table ?', html, 'Quitter la table', 'Rester'))) return;
    if (ctrl !== c) return;
  }
  const refund = me ? me.bet : 0;
  const r = await c.leave();
  if (r.error) { toast(r.error); return; }
  if (ctrl !== c) return;
  closeSession();
  if (r.stack > 0) Wallet.give(r.stack);
  if (c.mode !== 'solo') toast(`Vous repartez avec ${money(r.stack)}.`, 'ok');
  else if (refund > 0) toast(`Vos mises (${money(refund)}) vous ont été rendues.`, 'ok');
  backToHall();
}

// ---------------------------------------------------------------
// Boutons et dialogues
// ---------------------------------------------------------------
$('#undoBtn').addEventListener('click', () => send({ t: 'undo' }));
$('#clearBtn').addEventListener('click', () => send({ t: 'clear' }));
$('#doubleBtn').addEventListener('click', () => { Sound.chip(); send({ t: 'double' }); });
$('#rebetBtn').addEventListener('click', () => { Sound.chip(); send({ t: 'rebet' }); });
function toggleReady() {
  if (!view || view.phase !== 'betting' || !meOf(view)) return;
  const mine = view.mine || {};
  if (!isNet()) {
    if (!(meOf(view).bet > 0)) { toast('Posez au moins un jeton avant de lancer.'); return; }
    if (!mine.ready) send({ t: 'ready', v: true });
  } else {
    send({ t: 'ready', v: !mine.ready });
  }
}
$('#spinBtn').addEventListener('click', toggleReady);
$('#rlAuto').addEventListener('change', (e) => send({ t: 'auto', v: e.target.checked }));
$('#leaveBtn').addEventListener('click', () => leave(false));
$('#infoBtn').addEventListener('click', () => $('#infoDlg').showModal());

/** Caisse à la table : ajouter des jetons sans quitter la partie. */
function openCash() {
  if (!ctrl || !ctrl.addChips) return;
  TableCash.open({
    amounts: [20, 50, 100, 500], min: 1, max: 100000,
    add: (v) => (ctrl && ctrl.addChips ? ctrl.addChips(v) : Promise.resolve({ ok: false, msg: 'Vous n’êtes plus à la table.' })),
  });
}
$('#rlCashBtn').addEventListener('click', openCash);

// Test d'uniformité du générateur
$('#rngTestBtn').addEventListener('click', () => {
  const btn = $('#rngTestBtn');
  const out = $('#rngResult');
  btn.disabled = true;
  out.textContent = 'Tirage en cours…';
  setTimeout(() => {
    const N = 1000000;
    const t0 = performance.now();
    const counts = bulkDraws(N);
    const ms = performance.now() - t0;
    const E = N / 37;
    let chi = 0, min = Infinity, max = -Infinity, minN = 0, maxN = 0;
    counts.forEach((v, i) => {
      chi += ((v - E) ** 2) / E;
      if (v < min) { min = v; minN = i; }
      if (v > max) { max = v; maxN = i; }
    });
    const p = gammaQ(18, chi / 2); // 36 degrés de liberté
    const pct = (v) => `${v >= E ? '+' : '−'}${Math.abs(((v - E) / E) * 100).toFixed(2).replace('.', ',')} %`;
    const ok = p > 0.01;
    out.innerHTML =
      `${NUM.format(N)} tirages en ${Math.round(ms)} ms · attendu par case : ${NUM.format(Math.round(E))}.<br>`
      + `Le moins sorti : <b>${minN}</b> (${NUM.format(min)}, ${pct(min)}) · le plus sorti : <b>${maxN}</b> (${NUM.format(max)}, ${pct(max)}).<br>`
      + `χ² = ${chi.toFixed(1).replace('.', ',')} pour 36 degrés de liberté · p = ${p.toFixed(3).replace('.', ',')} → `
      + (ok
        ? '<span class="rng-ok">écarts compatibles avec un tirage parfaitement uniforme.</span>'
        : '<span class="rng-warn">écart rare (arrive environ 1 fois sur 100 avec un générateur parfait) — relancez le test.</span>');
    btn.disabled = false;
    btn.textContent = 'Relancer le test';
  }, 30);
});

// Raccourci clavier : Espace pour lancer / se déclarer prêt (uniquement sur l'écran de la roulette)
const onRoulette = () => $('#roulette').classList.contains('active') && !document.querySelector('dialog[open]');
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !onRoulette()) return;
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (!e.repeat) toggleReady();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && onRoulette()) e.preventDefault();
});

// Création d'une table entre amis (dialogue commun de net.js)
Net.register('roulette', {
  readCreate() {
    const buyIn = Number($('#netCreateCave').value);
    if (!(buyIn >= 10)) { toast('Il faut au moins 10 € pour ouvrir une table.'); return null; }
    return { buyIn, betTime: (Number(segValue('netCreateBetTime')) || 20) * 1000 };
  },
  startHost,
  startGuest,
});

// ---------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------
buildBoard();
buildChips();
renderStats([]);
$('#betInfo').textContent = DEFAULT_INFO;

return { enter, leave };
})();
