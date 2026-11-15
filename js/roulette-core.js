/* =================================================================
   Roulette — moteur de la table (sans affichage)
   Utilisé en solo et par l'hôte d'une table entre amis.
   Le cycle tourne tout seul, comme au casino :
     « Faites vos jeux » (compte à rebours) → « Rien ne va plus »
     → tirage et lancer de la bille → paiement → nouveau tour.
   Fonctionne dans le navigateur et sous Node (tests).
   ================================================================= */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rng.js') : root.RNG);
  if (isNode) module.exports = api;
  else root.RouletteCore = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const CHIP_VALUES = [1, 5, 10, 25, 100, 500, 1000];
  // Couleur des jetons de chaque place (comme les « jetons de couleur » des vraies tables)
  const COLORS = ['#e0bf6a', '#4fc3f7', '#ff8a80', '#81e6a0', '#ce93d8', '#ffb74d', '#f48fb1', '#80deea'];
  const round2 = (x) => Math.round(x * 100) / 100;
  const totalOf = (bets) => { let t = 0; for (const v of bets.values()) t += v; return round2(t); };

  /**
   * Toutes les mises possibles du tapis : clé → { numbers, even }.
   * Les clés sont les mêmes que celles du tapis affiché (roulette.js).
   */
  function buildSpots() {
    const S = new Map();
    const add = (nums, key, even = false) => {
      const k = key || 'n:' + [...nums].sort((a, b) => a - b).join('-');
      S.set(k, { numbers: [...nums].sort((a, b) => a - b), even });
    };
    const numAt = (c, r) => 3 * c + 3 - r; // colonne c (0–11), rangée r (0 en haut)
    for (let n = 0; n <= 36; n++) add([n]);                                   // pleins
    for (let c = 0; c < 11; c++) for (let r = 0; r < 3; r++) { const n = numAt(c, r); add([n, n + 3]); }       // chevaux horizontaux
    for (let c = 0; c < 12; c++) for (let r = 0; r < 2; r++) { const n = numAt(c, r); add([n - 1, n]); }       // chevaux verticaux
    for (let c = 0; c < 11; c++) for (let r = 0; r < 2; r++) { const n = numAt(c, r); add([n - 1, n, n + 2, n + 3]); } // carrés
    for (let c = 0; c < 12; c++) add([3 * c + 1, 3 * c + 2, 3 * c + 3]);      // transversales
    for (let c = 0; c < 11; c++) add([1, 2, 3, 4, 5, 6].map((k) => 3 * c + k)); // sixains
    for (let r = 0; r < 3; r++) add([0, 3 - r]);                              // chevaux avec le zéro
    add([0, 2, 3]); add([0, 1, 2]); add([0, 1, 2, 3]);
    for (let col = 1; col <= 3; col++) {
      const nums = [];
      for (let n = col; n <= 36; n += 3) nums.push(n);
      add(nums, 'col' + col);
    }
    for (let d = 0; d < 3; d++) add(Array.from({ length: 12 }, (_, k) => 12 * d + k + 1), 'dz' + (d + 1));
    const range = (test) => { const a = []; for (let n = 1; n <= 36; n++) if (test(n)) a.push(n); return a; };
    add(range((n) => n <= 18), 'low', true);
    add(range((n) => n >= 19), 'high', true);
    add(range((n) => n % 2 === 0), 'even', true);
    add(range((n) => n % 2 === 1), 'odd', true);
    add(range((n) => RED.has(n)), 'red', true);
    add(range((n) => !RED.has(n)), 'black', true);
    return S;
  }
  const SPOTS = buildSpots();

  /** Montant rendu (mise comprise) par une mise de `amount` sur `key` si `n` sort. */
  function payout(key, amount, n) {
    const s = SPOTS.get(key);
    if (!s) return 0;
    if (s.numbers.includes(n)) return amount * 36 / s.numbers.length; // 35:1, 17:1, 11:1, 8:1, 5:1, 2:1, 1:1
    if (n === 0 && s.even) return amount / 2;                        // la partage
    return 0;
  }

  class Table {
    constructor(opt = {}) {
      this.o = Object.assign({
        betTime: 20000,   // durée de « Faites vos jeux »
        lastCall: 5000,   // « Derniers jeux » pendant les dernières secondes
        readyTime: 2500,  // délai restant quand tous les joueurs sont prêts
        resultTime: 5000, // affichage du résultat avant le tour suivant
        seats: 8,
        scale: 1,         // accélère les délais (tests)
      }, opt);
      this.onUpdate = opt.onUpdate || (() => {});
      this.seats = new Array(this.o.seats).fill(null);
      this.phase = 'idle'; // idle | betting | spinning | result | stopped
      this.round = 0;
      this.history = [];
      this.deadline = 0;
      this.spin = null;
      this.timer = null;
    }

    now() { return Date.now(); }
    ms(x) { return Math.max(0, Math.round(x * this.o.scale)); }
    emit() { try { this.onUpdate(); } catch (e) { console.error(e); } }
    later(ms, fn) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; fn(); }, ms);
    }
    players() { return this.seats.filter(Boolean); }
    get(id) { return this.seats.find((p) => p && p.id === id) || null; }

    start() { if (this.phase === 'idle' || this.phase === 'stopped') this.openBetting(); }
    stop() { clearTimeout(this.timer); this.timer = null; this.phase = 'stopped'; }

    addPlayer({ id, name, stack }) {
      if (this.get(id)) return -1;
      const seat = this.seats.findIndex((s) => !s);
      if (seat < 0) return -1;
      this.seats[seat] = {
        id, name, stack: round2(stack), seat, color: COLORS[seat % COLORS.length],
        bets: new Map(), undo: [], lastBets: null, ready: false, auto: false, connected: true,
        lastNet: null, settle: null, stats: { rounds: 0, staked: 0, net: 0, best: 0 },
      };
      this.emit();
      return seat;
    }

    /** Un joueur peut quitter la table, sauf pendant la course de la bille s'il a des jetons en jeu. */
    canLeave(id) {
      const p = this.get(id);
      return !!p && !(this.phase === 'spinning' && p.bets.size > 0);
    }
    /** Retire un joueur ; ses mises encore posées lui sont rendues. Renvoie ses jetons, ou null. */
    removePlayer(id) {
      const p = this.get(id);
      if (!p || !this.canLeave(id)) return null;
      p.stack = round2(p.stack + totalOf(p.bets));
      p.bets = new Map();
      this.seats[p.seat] = null;
      this.emit();
      this.checkReady();
      return p.stack;
    }
    /** Fermeture de la table : le tour est annulé et toutes les mises posées sont rendues. */
    cancel() {
      this.stop();
      for (const p of this.players()) {
        p.stack = round2(p.stack + totalOf(p.bets));
        p.bets = new Map();
      }
    }

    // ---------- Mises ----------
    check(id) {
      const p = this.get(id);
      if (!p) return [null, 'Vous n’êtes pas assis à cette table.'];
      if (this.phase !== 'betting') return [null, 'Les jeux sont faits : attendez le prochain tour.'];
      return [p, ''];
    }
    snap(p) {
      p.undo.push(new Map(p.bets));
      if (p.undo.length > 200) p.undo.shift();
    }
    bet(id, key, amount) {
      const [p, err] = this.check(id);
      if (!p) return err;
      if (!SPOTS.has(key)) return 'Mise invalide.';
      amount = Number(amount);
      if (!CHIP_VALUES.includes(amount)) return 'Jeton invalide.';
      if (amount > p.stack + 1e-9) return p.stack >= 1 ? 'Solde insuffisant : choisissez un jeton plus petit.' : 'Solde insuffisant.';
      this.snap(p);
      p.bets.set(key, (p.bets.get(key) || 0) + amount);
      p.stack = round2(p.stack - amount);
      this.emit();
      return '';
    }
    unbet(id, key) {
      const [p, err] = this.check(id);
      if (!p) return err;
      if (!p.bets.has(key)) return '';
      this.snap(p);
      p.stack = round2(p.stack + p.bets.get(key));
      p.bets.delete(key);
      this.emit();
      return '';
    }
    clear(id) {
      const [p, err] = this.check(id);
      if (!p) return err;
      const t = totalOf(p.bets);
      if (!t) return '';
      this.snap(p);
      p.stack = round2(p.stack + t);
      p.bets = new Map();
      this.emit();
      return '';
    }
    undo(id) {
      const [p, err] = this.check(id);
      if (!p) return err;
      if (!p.undo.length) return '';
      const prev = p.undo.pop();
      p.stack = round2(p.stack + totalOf(p.bets) - totalOf(prev));
      p.bets = prev;
      this.emit();
      return '';
    }
    double(id) {
      const [p, err] = this.check(id);
      if (!p) return err;
      const t = totalOf(p.bets);
      if (!t) return 'Aucune mise à doubler.';
      if (t > p.stack + 1e-9) return 'Solde insuffisant pour doubler.';
      this.snap(p);
      for (const [k, v] of p.bets) p.bets.set(k, v * 2);
      p.stack = round2(p.stack - t);
      this.emit();
      return '';
    }
    rebet(id) {
      const [p, err] = this.check(id);
      if (!p) return err;
      if (!p.lastBets) return 'Aucune mise précédente.';
      const t = totalOf(p.lastBets);
      if (t > p.stack + 1e-9) return 'Solde insuffisant pour remiser.';
      this.snap(p);
      for (const [k, v] of p.lastBets) p.bets.set(k, (p.bets.get(k) || 0) + v);
      p.stack = round2(p.stack - t);
      this.emit();
      return '';
    }
    setReady(id, v) {
      const [p, err] = this.check(id);
      if (!p) return err;
      p.ready = !!v;
      this.emit();
      this.checkReady();
      return '';
    }
    setAuto(id, v) {
      const p = this.get(id);
      if (!p) return '';
      p.auto = !!v;
      this.emit();
      return '';
    }
    setConnected(id, ok) {
      const p = this.get(id);
      if (!p) return;
      p.connected = !!ok;
      this.emit();
      this.checkReady();
    }
    /** Action reçue d'un joueur (message `{ t: … }`). Renvoie un message d'erreur ou ''. */
    apply(id, m) {
      if (!m || typeof m !== 'object') return '';
      switch (m.t) {
        case 'bet': return this.bet(id, String(m.key), m.amount);
        case 'unbet': return this.unbet(id, String(m.key));
        case 'clear': return this.clear(id);
        case 'undo': return this.undo(id);
        case 'double': return this.double(id);
        case 'rebet': return this.rebet(id);
        case 'ready': return this.setReady(id, m.v);
        case 'auto': return this.setAuto(id, m.v);
        default: return '';
      }
    }

    // ---------- Déroulement d'un tour ----------
    openBetting() {
      this.phase = 'betting';
      this.round++;
      this.spin = null;
      for (const p of this.players()) {
        p.ready = false;
        p.settle = null;
        p.undo = [];
        // Remise automatique : on rejoue les mêmes jetons si le solde le permet
        if (p.auto && p.lastBets && !p.bets.size) {
          const t = totalOf(p.lastBets);
          if (t <= p.stack + 1e-9) {
            p.bets = new Map(p.lastBets);
            p.stack = round2(p.stack - t);
          }
        }
      }
      this.deadline = this.now() + this.ms(this.o.betTime);
      this.later(this.deadline - this.now(), () => this.closeBets());
      this.emit();
    }

    /** Tous les joueurs connectés sont prêts : on raccourcit l'attente. */
    checkReady() {
      if (this.phase !== 'betting') return;
      const ps = this.players().filter((p) => p.connected);
      if (!ps.length || !ps.every((p) => p.ready)) return;
      const t = this.now() + this.ms(this.o.readyTime);
      if (t < this.deadline) {
        this.deadline = t;
        this.later(t - this.now(), () => this.closeBets());
        this.emit();
      }
    }

    closeBets() {
      if (this.phase !== 'betting') return;
      // Le numéro est tiré une fois les jeux faits, par le générateur cryptographique.
      const result = RNG.int(37);
      const Ta = RNG.range(4.2, 5.4); // durée de la bille sur la piste (s)
      const Tb = RNG.range(2.1, 2.8); // chute et rebonds (s)
      this.spin = { id: this.round, result, Ta, Tb, t0: this.now() };
      this.phase = 'spinning';
      for (const p of this.players()) { p.undo = []; p.ready = false; }
      this.later(this.ms((Ta + Tb) * 1000 + 900), () => this.settle());
      this.emit();
    }

    settle() {
      if (this.phase !== 'spinning') return;
      const n = this.spin.result;
      for (const p of this.players()) {
        const staked = totalOf(p.bets);
        if (!staked) { p.settle = null; continue; }
        let ret = 0;
        const win = [];
        const half = [];
        for (const [k, a] of p.bets) {
          const r = payout(k, a, n);
          ret += r;
          if (r > a) win.push(k);
          else if (r > 0) half.push(k);
        }
        ret = round2(ret);
        p.stack = round2(p.stack + ret);
        p.lastNet = round2(ret - staked);
        p.lastBets = p.bets;
        p.settle = { bets: [...p.bets], win, half, ret, staked, net: p.lastNet };
        p.bets = new Map();
        p.stats.rounds++;
        p.stats.staked = round2(p.stats.staked + staked);
        p.stats.net = round2(p.stats.net + p.lastNet);
        if (p.lastNet > p.stats.best) p.stats.best = p.lastNet;
      }
      this.history.unshift(n);
      if (this.history.length > 500) this.history.length = 500;
      this.phase = 'result';
      this.later(this.ms(this.o.resultTime), () => this.openBetting());
      this.emit();
    }

    /** Ce que voit le joueur `id` (ou un spectateur). */
    view(id) {
      const me = this.get(id);
      const now = this.now();
      const v = {
        type: 'roulette',
        phase: this.phase,
        round: this.round,
        deadlineMs: this.phase === 'betting' ? Math.max(0, this.deadline - now) : 0,
        betTime: this.ms(this.o.betTime),
        lastCall: this.ms(this.o.lastCall),
        spin: this.spin && (this.phase === 'spinning' || this.phase === 'result')
          ? { id: this.spin.id, result: this.spin.result, Ta: this.spin.Ta, Tb: this.spin.Tb, elapsedMs: now - this.spin.t0 }
          : null,
        result: this.phase === 'result' && this.spin ? this.spin.result : null,
        history: this.history.slice(0, 300),
        you: me ? me.seat : -1,
        players: this.seats.map((p) => p && {
          name: p.name, color: p.color, stack: p.stack, bet: totalOf(p.bets),
          ready: p.ready, connected: p.connected, lastNet: p.lastNet,
          played: !!p.settle,
        }),
        bets: [], // [clé, montant, place, état ('' | 'w' gagné | 'h' la partage | 'l' perdu)]
        mine: null,
      };
      for (const p of this.players()) {
        if (this.phase === 'result' && p.settle) {
          for (const [k, a] of p.settle.bets) {
            v.bets.push([k, a, p.seat, p.settle.win.includes(k) ? 'w' : p.settle.half.includes(k) ? 'h' : 'l']);
          }
        } else {
          for (const [k, a] of p.bets) v.bets.push([k, a, p.seat, '']);
        }
      }
      if (me) {
        v.mine = {
          undo: me.undo.length > 0,
          lastBets: me.lastBets ? totalOf(me.lastBets) : 0,
          auto: me.auto,
          ready: me.ready,
          settle: me.settle && { ret: me.settle.ret, staked: me.settle.staked, net: me.settle.net },
          stats: me.stats,
        };
      }
      return v;
    }
  }

  return { Table, SPOTS, payout, RED, CHIP_VALUES, COLORS };
});
