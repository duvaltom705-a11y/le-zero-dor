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
        setTimeout(done, 450);
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
   * on choisit aléatoirement tous les paramètres physiques, puis on ajuste
   * la vitesse de lancer pour que la bille finisse exactement dans sa case.
   */
  function launch(result, onDone) {
    const t0 = now();
    const w0 = mod(angleAt(t0), TAU);
    const restingAngle = w0 + ball.rel;
    motor = { t0, w0, om0: RNG.range(2.2, 3.1), Tw: RNG.range(11, 14) };

    const r0 = ball.visible ? ball.r : TRACK;
    const b0 = ball.visible ? mod(restingAngle, TAU) : RNG.range(0, TAU);
    const Ta = RNG.range(4.2, 5.4);      // durée sur la piste
    const Tb = RNG.range(2.1, 2.8);      // durée de la chute et des rebonds
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
      onDone,
    };
    ball.visible = true;
  }

  function reset() {
    spin = null;
    ball.visible = false;
  }

  return { launch, reset, resize };
})();

// ---------------------------------------------------------------
// État du jeu
// ---------------------------------------------------------------
// Le solde disponible est celui du portefeuille du casino (Wallet.balance).
const state = {
  phase: 'closed', // 'betting' | 'spinning' | 'closed' (hors de la roulette)
  bets: new Map(), // clé de mise → montant
  undo: [],
  lastBets: null,
  round: null,
  settle: null,    // affichage des mises gagnantes/perdantes après un tour
  chip: 5,
  history: [],
  lastNet: null,
};
let settleTimer = 0;
let bustTimer = 0;

// ---------------------------------------------------------------
// Tapis de jeu
// ---------------------------------------------------------------
const board = $('#board');
const spots = new Map();
const numberCells = [];
const chipEls = new Map();

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function addSpot(node, numbers, label, opts = {}) {
  const key = opts.key || 'n:' + [...numbers].sort((a, b) => a - b).join('-');
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
  const by = (a, b) => a - b;
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
  hot('corner', 0, CH, VW, HH, [0, 2, 3].sort(by), 'Transversale 0/2/3');
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
    const on = Number(b.dataset.value) === state.chip;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-checked', String(on));
  }
}
chipsEl.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.chip = Number(b.dataset.value);
  markChip();
});

function renderChips() {
  const src = state.settle ? state.settle.bets : state.bets;
  for (const [key, node] of chipEls) {
    if (!src.has(key)) { node.remove(); chipEls.delete(key); }
  }
  for (const [key, amount] of src) {
    let node = chipEls.get(key);
    if (!node) {
      node = el('div');
      spots.get(key).el.append(node);
      chipEls.set(key, node);
    }
    let cls = 'chip-stack ' + chipClass(amount);
    if (state.settle) cls += state.settle.win.has(key) ? ' won' : state.settle.half.has(key) ? ' half' : ' lost';
    node.className = cls;
    node.textContent = shortAmount(amount);
  }
}

// ---------------------------------------------------------------
// Mises
// ---------------------------------------------------------------
function snapshot() {
  state.undo.push(new Map(state.bets));
  if (state.undo.length > 200) state.undo.shift();
}

function placeBet(key) {
  if (state.phase !== 'betting') return;
  endSettle();
  const amt = state.chip;
  if (amt > Wallet.balance) {
    toast(Wallet.balance >= 1 ? 'Solde insuffisant : choisissez un jeton plus petit.' : 'Solde insuffisant.');
    return;
  }
  snapshot();
  state.bets.set(key, (state.bets.get(key) || 0) + amt);
  Wallet.take(amt);
  Sound.chip();
  update();
  showSpotInfo(key);
}

function removeBet(key) {
  if (state.phase !== 'betting') return;
  endSettle();
  if (!state.bets.has(key)) return;
  snapshot();
  Wallet.give(state.bets.get(key));
  state.bets.delete(key);
  update();
  showSpotInfo(key);
}

function undo() {
  if (state.phase !== 'betting' || !state.undo.length) return;
  endSettle();
  const prev = state.undo.pop();
  Wallet.give(totalOf(state.bets) - totalOf(prev));
  state.bets = prev;
  update();
}

function clearBets() {
  if (state.phase !== 'betting') return;
  endSettle();
  const t = totalOf(state.bets);
  if (!t) return;
  snapshot();
  Wallet.give(t);
  state.bets = new Map();
  update();
}

function doubleBets() {
  if (state.phase !== 'betting') return;
  endSettle();
  const t = totalOf(state.bets);
  if (!t) return;
  if (t > Wallet.balance) { toast('Solde insuffisant pour doubler.'); return; }
  snapshot();
  for (const [k, v] of state.bets) state.bets.set(k, v * 2);
  Wallet.take(t);
  Sound.chip();
  update();
}

function rebet() {
  if (state.phase !== 'betting') return;
  endSettle();
  if (!state.lastBets) { toast('Aucune mise précédente.'); return; }
  const t = totalOf(state.lastBets);
  if (t > Wallet.balance) { toast('Solde insuffisant pour remiser.'); return; }
  snapshot();
  for (const [k, v] of state.lastBets) state.bets.set(k, (state.bets.get(k) || 0) + v);
  Wallet.take(t);
  Sound.chip();
  update();
}

// ---------------------------------------------------------------
// Tour de roulette
// ---------------------------------------------------------------
function spin() {
  if (state.phase !== 'betting') return;
  endSettle();
  const total = totalOf(state.bets);
  if (total <= 0) { toast('Posez au moins un jeton avant de lancer.'); return; }

  state.phase = 'spinning';
  state.round = { bets: new Map(state.bets), total };
  state.undo = [];
  clearWinner();
  $('#resultBadge').hidden = true;
  announce('Rien ne va plus', 'Les jeux sont faits');
  update();

  // Le tirage : générateur cryptographique, une fois les mises closes.
  const result = RNG.int(37);
  Wheel.launch(result, () => resolveRound(result));
}

function describe(n) {
  if (n === 0) return 'Zéro';
  return `${n} · ${RED.has(n) ? 'Rouge' : 'Noir'} · ${n % 2 ? 'Impair' : 'Pair'} · ${n <= 18 ? 'Manque' : 'Passe'}`;
}

function resolveRound(result) {
  const { bets, total } = state.round;
  let ret = 0;
  const win = new Set();
  const half = new Set();
  for (const [key, amt] of bets) {
    const s = spots.get(key);
    if (s.numbers.includes(result)) {
      ret += (amt * 36) / s.numbers.length; // mise + gain (35:1, 17:1, 11:1, 8:1, 5:1, 2:1, 1:1)
      win.add(key);
    } else if (result === 0 && s.even) {
      ret += amt / 2; // la partage
      half.add(key);
    }
  }
  const net = ret - total;
  Wallet.give(ret);
  state.lastNet = net;
  state.lastBets = bets;
  state.bets = new Map();
  state.round = null;
  state.history.unshift(result);
  state.settle = { bets, win, half };
  state.phase = 'betting';

  showBadge(result);
  numberCells[result].classList.add('winner');

  let sub, cls = '';
  if (ret === 0) { sub = `Perdu ${signed(net)}`; cls = 'neg'; }
  else if (net > 0) { sub = `Vous gagnez ${money(ret)} (${signed(net)})`; cls = 'pos'; }
  else if (net < 0) { sub = `Vous récupérez ${money(ret)} (${signed(net)})`; cls = 'neg'; }
  else sub = `Mise récupérée (${signed(0)})`;
  announce(describe(result), sub, cls);
  if (net > 0) Sound.win();

  clearTimeout(settleTimer);
  settleTimer = setTimeout(endSettle, 4000);
  renderStats();
  update();

  if (Wallet.balance < 1) {
    clearTimeout(bustTimer);
    bustTimer = setTimeout(showBust, 2200);
  }
}

function endSettle() {
  if (!state.settle) return;
  clearTimeout(settleTimer);
  state.settle = null;
  renderChips();
  $('#announce').textContent = 'Faites vos jeux';
}

// ---------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------
function announce(main, sub, cls = '') {
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

function update() {
  const tb = totalOf(state.bets);
  const betting = state.phase === 'betting';
  $('#balance').textContent = money(Wallet.balance);
  $('#totalBet').textContent = money(tb);
  const ln = $('#lastNet');
  if (state.lastNet === null) { ln.textContent = '—'; ln.className = ''; }
  else { ln.textContent = signed(state.lastNet); ln.className = state.lastNet > 0 ? 'pos' : state.lastNet < 0 ? 'neg' : ''; }

  $('#undoBtn').disabled = !betting || state.undo.length === 0;
  $('#clearBtn').disabled = !betting || tb === 0;
  $('#doubleBtn').disabled = !betting || tb === 0 || tb > Wallet.balance;
  $('#rebetBtn').disabled = !betting || !state.lastBets || totalOf(state.lastBets) > Wallet.balance;
  $('#spinBtn').disabled = !betting || tb === 0;
  $('#leaveBtn').disabled = !betting;
  for (const b of chipsEl.children) b.classList.toggle('dim', Number(b.dataset.value) > Wallet.balance);
  renderChips();
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
  const on = state.bets.get(key);
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

// Historique et statistiques de la session
function splitRow(parts, n) {
  const labels = parts
    .filter((p) => p[0])
    .map(([l, v]) => `<span>${l} <b>${Math.round((v / n) * 100)} %</b></span>`)
    .join('');
  const bars = parts.map(([, v, col]) => `<i style="width:${(v / n) * 100}%;background:${col}"></i>`).join('');
  return `<div class="split"><div class="split-labels">${labels}</div><div class="split-bar">${bars}</div></div>`;
}

function renderStats() {
  const h = state.history;
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
    const chip = (i, title) => `<span class="hnum sm ${colorOf(i)}" title="${title}">${i}</span>`;
    html += `<div class="hotcold"><span>Chauds</span><div class="row">${hot.map((i) => chip(i, `Sorti ${counts[i]} fois`)).join('')}</div>`;
    html += `<span>Absents</span><div class="row">${cold.map((i) => chip(i, `Absent depuis ${gap(i)} tours`)).join('')}</div></div>`;
    html += '<p class="footnote">Chaque tirage est indépendant : un numéro « chaud » ou absent n\'a ni plus ni moins de chances de sortir.</p>';
  } else {
    html += '<p class="footnote">Numéros chauds et absents affichés après 10 tours.</p>';
  }
  box.innerHTML = html;
}


// ---------------------------------------------------------------
// Entrée et sortie de la roulette
// ---------------------------------------------------------------
function enter() {
  clearTimeout(bustTimer);
  state.phase = 'betting';
  state.bets = new Map();
  state.undo = [];
  state.settle = null;
  if (!state.chip || state.chip > Wallet.balance) state.chip = defaultChip(Wallet.balance);
  if (!state.history.length) {
    Wheel.reset();
    $('#resultBadge').hidden = true;
    announce('Faites vos jeux', `Vous disposez de ${money(Wallet.balance)} de jetons.`);
  }
  $('#betInfo').textContent = DEFAULT_INFO;
  markChip();
  renderStats();
  update();
  showScreen('roulette');
}

function leave() {
  if (state.phase === 'spinning') { toast('Attendez la fin du tour.'); return; }
  endSettle();
  const onTable = totalOf(state.bets);
  if (onTable) {
    Wallet.give(onTable);
    toast(`Vos mises (${money(onTable)}) vous ont été rendues.`, 'ok');
  }
  state.bets = new Map();
  state.undo = [];
  state.phase = 'closed';
  renderChips();
  backToHall();
}

function showBust() {
  if (state.phase !== 'betting' || Wallet.balance >= 1 || totalOf(state.bets) > 0) return;
  infoBox('Plus de jetons',
    '<p>Votre portefeuille est vide. Retournez au hall : vous pourrez le recharger à la caisse si vous souhaitez continuer.</p>',
    'Retour au hall').then(() => { if (state.phase === 'betting') leave(); });
}

// ---------------------------------------------------------------
// Boutons et dialogues
// ---------------------------------------------------------------
$('#undoBtn').addEventListener('click', undo);
$('#clearBtn').addEventListener('click', clearBets);
$('#doubleBtn').addEventListener('click', doubleBets);
$('#rebetBtn').addEventListener('click', rebet);
$('#spinBtn').addEventListener('click', spin);
$('#leaveBtn').addEventListener('click', leave);
$('#infoBtn').addEventListener('click', () => $('#infoDlg').showModal());

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

// Raccourci clavier : Espace pour lancer (uniquement sur l'écran de la roulette)
const onRoulette = () => $('#roulette').classList.contains('active') && !document.querySelector('dialog[open]');
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !onRoulette()) return;
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (!e.repeat) spin();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && onRoulette()) e.preventDefault();
});

// ---------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------
buildBoard();
buildChips();
renderStats();
$('#betInfo').textContent = DEFAULT_INFO;

return { enter, leave };
})();
