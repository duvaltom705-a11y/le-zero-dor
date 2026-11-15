/* =================================================================
   Blackjack — moteur de la table (sans affichage)
   Sabot de 6 jeux, jusqu'à 5 joueurs face au croupier « Victor ».
   Le croupier applique les règles du casino (il reste sur tous les 17) :
   il ne choisit rien et ne triche pas.
   Utilisé en solo et par l'hôte d'une table entre amis ; fonctionne
   aussi sous Node pour les tests.
   ================================================================= */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./rng.js') : root.RNG);
  if (isNode) module.exports = api;
  else root.BlackjackCore = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  const DECKS = 6;
  const MAX_HANDS = 4;
  const CHIP_VALUES = [1, 5, 10, 25, 100, 500, 1000];
  // Cartes de chaque valeur dans un sabot complet (as = 1, 10 = dix et figures)
  const FULL = [0, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 4 * DECKS, 16 * DECKS];
  const ABORT = Symbol('abort');
  const round2 = (x) => Math.round(x * 100) / 100;

  /** Valeur d'une carte (0–51) : as = 1, figures = 10. */
  const v1 = (c) => { const r = c >> 2; return r === 12 ? 1 : r >= 8 ? 10 : r + 2; };
  /** Comptage Hi-Lo d'une valeur : 2–6 = +1, 7–9 = 0, 10 et as = −1. */
  const hiLoV = (v) => (v >= 2 && v <= 6 ? 1 : v === 10 || v === 1 ? -1 : 0);

  function handTotal(cards) {
    let hard = 0;
    let ace = false;
    for (const x of cards) {
      const v = v1(x.c);
      hard += v;
      if (v === 1) ace = true;
    }
    const soft = ace && hard + 10 <= 21;
    return { t: soft ? hard + 10 : hard, soft };
  }
  const isBJ = (h) => h.cards.length === 2 && !h.split && handTotal(h.cards).t === 21;

  // ---------------------------------------------------------------
  // Probabilités du croupier et espérance de chaque option
  // (sert au conseiller ; calcul exact sur les cartes inconnues)
  // ---------------------------------------------------------------
  /** Distribution finale du croupier [17, 18, 19, 20, 21, saute], sachant qu'il n'a pas blackjack. */
  function dealerDist(up, comp) {
    const tot = comp.reduce((a, b) => a + b, 0);
    const p = comp.map((x) => x / tot);
    const memo = new Map();
    function rec(hard, ace) {
      const t = ace && hard + 10 <= 21 ? hard + 10 : hard;
      if (t > 21) return [0, 0, 0, 0, 0, 1];
      if (t >= 17) { const r = [0, 0, 0, 0, 0, 0]; r[t - 17] = 1; return r; } // reste sur tous les 17
      const key = hard * 2 + (ace ? 1 : 0);
      if (memo.has(key)) return memo.get(key);
      const r = [0, 0, 0, 0, 0, 0];
      for (let v = 1; v <= 10; v++) {
        if (!p[v]) continue;
        const sub = rec(hard + v, ace || v === 1);
        for (let k = 0; k < 6; k++) r[k] += p[v] * sub[k];
      }
      memo.set(key, r);
      return r;
    }
    const out = [0, 0, 0, 0, 0, 0];
    let norm = 0;
    for (let v = 1; v <= 10; v++) {
      if (!p[v]) continue;
      if ((up === 1 && v === 10) || (up === 10 && v === 1)) continue; // le croupier a vérifié : pas de blackjack
      norm += p[v];
      const sub = rec(up + v, up === 1 || v === 1);
      for (let k = 0; k < 6; k++) out[k] += p[v] * sub[k];
    }
    return out.map((x) => x / norm);
  }

  /** Espérance (en fraction de la mise initiale) de chaque option pour une main. */
  function playerEV(vals, up, comp, opt) {
    const tot = comp.reduce((a, b) => a + b, 0);
    const p = comp.map((x) => x / tot);
    const D = dealerDist(up, comp);
    const totOf = (hard, ace) => (ace && hard + 10 <= 21 ? hard + 10 : hard);
    const standEV = (t) => {
      if (t > 21) return -1;
      let ev = D[5];
      for (let d = 17; d <= 21; d++) {
        if (t > d) ev += D[d - 17];
        else if (t < d) ev -= D[d - 17];
      }
      return ev;
    };
    const memo = new Map();
    function best(hard, ace) {
      const t = totOf(hard, ace);
      if (t > 21) return -1;
      if (t === 21) return standEV(21);
      return Math.max(standEV(t), hit(hard, ace));
    }
    function hit(hard, ace) {
      const key = hard * 2 + (ace ? 1 : 0);
      if (memo.has(key)) return memo.get(key);
      let ev = 0;
      for (let v = 1; v <= 10; v++) if (p[v]) ev += p[v] * best(hard + v, ace || v === 1);
      memo.set(key, ev);
      return ev;
    }
    function dbl(hard, ace) {
      let ev = 0;
      for (let v = 1; v <= 10; v++) if (p[v]) ev += p[v] * standEV(totOf(hard + v, ace || v === 1));
      return 2 * ev;
    }
    let hard = 0;
    let ace = false;
    for (const v of vals) { hard += v; if (v === 1) ace = true; }
    const res = { stand: standEV(totOf(hard, ace)) };
    if (opt.canHit !== false) res.hit = hit(hard, ace);
    if (opt.canDouble) res.double = dbl(hard, ace);
    if (opt.canSurrender) res.surrender = -0.5;
    if (opt.canSplit) {
      const c = vals[0];
      let one = 0;
      for (let v = 1; v <= 10; v++) {
        if (!p[v]) continue;
        const h2 = c + v;
        const a2 = c === 1 || v === 1;
        one += p[v] * (c === 1 ? standEV(totOf(h2, a2)) : Math.max(best(h2, a2), dbl(h2, a2)));
      }
      res.split = 2 * one;
    }
    let bestKey = 'stand';
    for (const k of Object.keys(res)) if (res[k] > res[bestKey] + 1e-9) bestKey = k;
    return { ev: res, best: bestKey, bust: D[5] };
  }

  const newHand = (bet) => ({ cards: [], bet, done: false, doubled: false, split: false, splitAces: false, surrendered: false, result: null, payout: 0 });

  // ---------------------------------------------------------------
  // La table
  // ---------------------------------------------------------------
  class Table {
    constructor(opt = {}) {
      this.o = Object.assign({
        seats: 5,
        betTime: null,    // délai pour miser une fois la première mise posée (null : on attend « Distribuer »)
        turnTime: null,   // délai pour jouer une main (null : illimité)
        insTime: null,    // délai pour l'assurance
        resultTime: 0,    // affichage des résultats avant les nouvelles mises
        maxBet: 10000,
        scale: 1,         // accélère les délais (tests)
      }, opt);
      this.onUpdate = opt.onUpdate || (() => {});
      this.seats = new Array(this.o.seats).fill(null);
      this.phase = 'betting'; // betting | dealing | insurance | playing | dealer | settle
      this.showing = false;   // cartes de la main précédente encore sur la table
      this.dealer = [];
      this.holeHidden = true;
      this.turn = null;       // { seat, hand } pendant le tour des joueurs
      this.awaiting = false;  // on attend la décision du joueur dont c'est le tour
      this.pending = null;    // action reçue pour le joueur dont c'est le tour
      this.deadline = 0;
      this.deadlineFor = null;
      this.betTimer = null;
      this.waiter = null;
      this.gen = 0;           // change à chaque annulation : interrompt la donne en cours
      this.sayId = 0;
      this.say = { k: 'welcome', i: RNG.int(2), id: 0 };
      this.serial = 0;
      this.newShoe();
    }

    emit() { try { this.onUpdate(); } catch (e) { console.error(e); } }
    talk(k, extra = {}) { this.say = { k, i: RNG.int(6), id: ++this.sayId, ...extra }; }
    players() { return this.seats.filter(Boolean); }
    get(id) { return this.seats.find((p) => p && p.id === id) || null; }
    ms(x) { return Math.max(0, Math.round(x * this.o.scale)); }

    async wait(x) {
      const g = this.gen;
      await new Promise((r) => setTimeout(r, this.ms(x)));
      if (g !== this.gen) throw ABORT;
    }
    /** Attend que `pred()` soit vrai (vérifié à chaque action), ou la fin du délai. Renvoie true si le délai a expiré. */
    waitFor(pred, x, kind) {
      const g = this.gen;
      return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (timedOut) => {
          clearTimeout(timer);
          this.waiter = null;
          this.deadline = 0;
          this.deadlineFor = null;
          if (g !== this.gen) reject(ABORT); else resolve(timedOut);
        };
        if (x) {
          this.deadline = Date.now() + this.ms(x);
          this.deadlineFor = kind;
          timer = setTimeout(() => finish(true), this.ms(x));
        }
        this.waiter = { check: () => { if (pred()) finish(false); }, abort: () => finish(true) };
        this.emit(); // envoie l'état avec le délai à respecter
        this.waiter.check();
      });
    }
    poke() { if (this.waiter) this.waiter.check(); }

    // ---------- Sabot ----------
    newShoe() {
      const s = [];
      for (let d = 0; d < DECKS; d++) for (let c = 0; c < 52; c++) s.push(c);
      RNG.shuffle(s); // Fisher-Yates avec le générateur cryptographique
      this.shoe = s;
      this.pos = 0;
      this.cut = Math.round(s.length * RNG.range(0.72, 0.82)); // carte de coupe
      this.seen = new Array(11).fill(0); // cartes déjà montrées, par valeur
      this.shuffleDue = false;
    }
    draw(faceUp = true) {
      if (this.pos >= this.shoe.length) this.newShoe(); // sécurité, n'arrive pas en pratique
      const c = this.shoe[this.pos++];
      if (this.pos >= this.cut) this.shuffleDue = true;
      if (faceUp) this.seen[v1(c)]++;
      return { c, id: ++this.serial };
    }
    dealerBJ() { return this.dealer.length === 2 && handTotal(this.dealer).t === 21; }

    // ---------- Joueurs ----------
    addPlayer({ id, name, stack }, seat) {
      if (this.get(id)) return -1;
      let s = Number.isInteger(seat) && seat >= 0 && seat < this.seats.length && !this.seats[seat] ? seat : -1;
      if (s < 0) s = this.seats.findIndex((x) => !x);
      if (s < 0) return -1;
      this.seats[s] = {
        id, name, seat: s, stack: round2(stack), bet: 0, lastBet: 0, ready: false, connected: true,
        hands: [], insurance: 0, insDecided: true, inRound: false, lastNet: null,
        stats: { rounds: 0, wins: 0, losses: 0, pushes: 0, bj: 0, net: 0 },
      };
      if (this.players().length > 1 || this.o.seats > 1) this.talk('join', { s });
      else this.talk('welcome');
      this.emit();
      return s;
    }
    canLeave(id) {
      const p = this.get(id);
      return !!p && !p.inRound;
    }
    /** Retire un joueur (hors d'une main en cours) ; sa mise posée lui est rendue. */
    removePlayer(id) {
      const p = this.get(id);
      if (!p || p.inRound) return null;
      p.stack = round2(p.stack + p.bet);
      p.bet = 0;
      this.seats[p.seat] = null;
      if (!this.players().length) this.clearTable();
      else if (this.phase === 'betting') this.talk('leave', { name: p.name });
      this.emit();
      this.checkStart();
      return p.stack;
    }
    setConnected(id, ok) {
      const p = this.get(id);
      if (!p) return;
      p.connected = !!ok;
      this.emit();
      this.checkStart();
      this.poke();
    }
    /** Fermeture de la table : la main en cours est annulée et toutes les mises sont rendues. */
    cancel() {
      this.gen++;
      clearTimeout(this.betTimer);
      this.betTimer = null;
      if (this.waiter) this.waiter.abort();
      for (const p of this.players()) {
        let back = p.bet;
        if (p.inRound) back += p.hands.reduce((a, h) => a + h.bet, 0) + p.insurance;
        p.stack = round2(p.stack + back);
        p.bet = 0;
        p.inRound = false;
        p.hands = [];
        p.insurance = 0;
      }
      this.phase = 'betting';
      this.turn = null;
      this.awaiting = false;
      this.dealer = [];
    }
    clearTable() {
      for (const p of this.players()) { p.hands = []; p.insurance = 0; }
      this.dealer = [];
      this.holeHidden = true;
      this.showing = false;
    }

    // ---------- Actions des joueurs ----------
    bet(id, amount) {
      const p = this.get(id);
      if (!p) return 'Vous n’êtes pas assis à cette table.';
      if (this.phase !== 'betting') return 'Attendez la fin de la main en cours.';
      amount = Number(amount);
      if (!CHIP_VALUES.includes(amount)) return 'Jeton invalide.';
      if (amount > p.stack + 1e-9) return 'Solde insuffisant pour ce jeton.';
      if (p.bet + amount > this.o.maxBet) return `Mise maximale : ${this.o.maxBet} €.`;
      if (this.showing) this.clearTable();
      p.stack = round2(p.stack - amount);
      p.bet += amount;
      this.emit();
      this.checkStart();
      return '';
    }
    clearBet(id) {
      const p = this.get(id);
      if (!p || this.phase !== 'betting') return '';
      if (this.showing) this.clearTable();
      p.stack = round2(p.stack + p.bet);
      p.bet = 0;
      p.ready = false;
      this.emit();
      this.checkStart();
      return '';
    }
    rebet(id) {
      const p = this.get(id);
      if (!p || this.phase !== 'betting' || !p.lastBet) return '';
      const add = p.lastBet - p.bet;
      if (add <= 0) return '';
      if (add > p.stack + 1e-9) return 'Solde insuffisant pour remiser.';
      if (this.showing) this.clearTable();
      p.stack = round2(p.stack - add);
      p.bet = p.lastBet;
      this.emit();
      this.checkStart();
      return '';
    }
    ready(id) {
      const p = this.get(id);
      if (!p || this.phase !== 'betting') return '';
      if (p.bet <= 0) return 'Posez d’abord une mise.';
      p.ready = true;
      this.emit();
      this.checkStart();
      return '';
    }
    insure(id, take) {
      const p = this.get(id);
      if (!p || this.phase !== 'insurance' || !p.inRound || p.insDecided) return '';
      if (take) {
        const amt = p.hands[0].bet / 2;
        if (amt > p.stack + 1e-9) return 'Solde insuffisant pour l’assurance.';
        p.stack = round2(p.stack - amt);
        p.insurance = amt;
      }
      p.insDecided = true;
      this.emit();
      this.poke();
      return '';
    }
    /** Le joueur achète des jetons en plus, sans quitter la table (pris dans son portefeuille). */
    addChips(id, amount) {
      const p = this.get(id);
      if (!p) return 'Vous n’êtes pas assis à cette table.';
      amount = Math.floor(Number(amount));
      if (!Number.isFinite(amount) || amount < 1 || amount > 100000) return 'Montant invalide (1 € à 100 000 €).';
      p.stack = round2(p.stack + amount);
      if (this.phase === 'betting' && this.o.seats > 1) this.talk('chips', { s: p.seat, a: amount });
      this.emit();
      return '';
    }
    legalFor(p, h) {
      if (!h || h.done) return {};
      const two = h.cards.length === 2;
      return {
        hit: !h.splitAces,
        stand: true,
        double: two && !h.splitAces && p.stack >= h.bet,
        split: two && p.hands.length < MAX_HANDS && !h.splitAces && v1(h.cards[0].c) === v1(h.cards[1].c) && p.stack >= h.bet,
        surrender: two && p.hands.length === 1 && !h.split,
      };
    }
    act(id, kind) {
      const p = this.get(id);
      if (!p || this.phase !== 'playing' || !this.awaiting || !this.turn || this.turn.seat !== p.seat || this.pending) return '';
      const L = this.legalFor(p, p.hands[this.turn.hand]);
      if (!L[kind]) return 'Action impossible.';
      this.pending = kind;
      this.poke();
      return '';
    }
    /** Action reçue d'un joueur (message `{ t: … }`). Renvoie un message d'erreur ou ''. */
    apply(id, m) {
      if (!m || typeof m !== 'object') return '';
      switch (m.t) {
        case 'bet': return this.bet(id, m.amount);
        case 'clear': return this.clearBet(id);
        case 'rebet': return this.rebet(id);
        case 'ready': return this.ready(id);
        case 'ins': return this.insure(id, !!m.take);
        case 'act': return this.act(id, String(m.kind));
        case 'add': return this.addChips(id, m.amount);
        default: return '';
      }
    }

    // ---------- Déroulement d'une main ----------
    /** Lance la donne quand tous les joueurs connectés sont prêts, ou à la fin du délai de mise. */
    checkStart() {
      if (this.phase !== 'betting') return;
      const bettors = this.players().filter((p) => p.bet > 0);
      if (!bettors.length) {
        if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; this.deadline = 0; this.deadlineFor = null; this.emit(); }
        return;
      }
      const ps = this.players().filter((p) => p.connected);
      if (ps.length && ps.every((p) => p.ready && p.bet > 0)) { this.startRound(); return; }
      if (this.o.betTime && !this.betTimer) {
        this.deadline = Date.now() + this.ms(this.o.betTime);
        this.deadlineFor = 'bet';
        this.betTimer = setTimeout(() => { this.betTimer = null; this.startRound(); }, this.ms(this.o.betTime));
        this.emit();
      }
    }
    startRound() {
      if (this.phase !== 'betting') return;
      clearTimeout(this.betTimer);
      this.betTimer = null;
      const parts = this.players().filter((p) => p.bet > 0);
      if (!parts.length) return;
      this.run(parts).catch((e) => { if (e !== ABORT) console.error(e); });
    }

    async run(parts) {
      this.phase = 'dealing';
      this.deadline = 0;
      this.deadlineFor = null;
      this.clearTable();
      if (this.shuffleDue) {
        this.newShoe();
        this.talk('shuffle');
        this.emit();
        await this.wait(1000);
      }
      for (const p of this.players()) { p.ready = false; p.insDecided = true; }
      for (const p of parts) {
        p.inRound = true;
        p.lastBet = p.bet;
        p.hands = [newHand(p.bet)];
        p.bet = 0;
      }
      this.holeHidden = true;
      this.talk('deal');
      this.emit();
      for (let k = 0; k < 2; k++) {
        for (const p of parts) {
          await this.wait(330);
          p.hands[0].cards.push(this.draw());
          this.emit();
        }
        await this.wait(330);
        this.dealer.push(this.draw(k === 0)); // la seconde carte du croupier reste cachée
        this.emit();
      }
      await this.wait(350);

      const up = v1(this.dealer[0].c);
      // Assurance quand le croupier montre un as
      if (up === 1) {
        let any = false;
        for (const p of parts) {
          p.insDecided = p.stack < p.hands[0].bet / 2;
          if (!p.insDecided) any = true;
        }
        if (any) {
          this.phase = 'insurance';
          this.talk('ins');
          await this.waitFor(() => parts.every((p) => p.insDecided), this.o.insTime, 'ins');
          for (const p of parts) p.insDecided = true;
          this.phase = 'dealing';
          this.emit();
        }
      }
      // Avec un as ou un 10 visible, le croupier vérifie sa carte cachée
      let peeked = false;
      if (up === 1 || up === 10) {
        peeked = true;
        this.talk('peek');
        this.emit();
        await this.wait(900);
        if (this.dealerBJ()) {
          await this.revealHole();
          return this.settle(parts);
        }
      }
      for (const p of parts) if (isBJ(p.hands[0])) p.hands[0].done = true;

      // Chaque joueur joue ses mains, dans l'ordre des places
      this.phase = 'playing';
      let first = true;
      for (const p of parts) {
        for (let i = 0; i < p.hands.length; i++) {
          const h = p.hands[i];
          if (h.done) continue;
          this.turn = { seat: p.seat, hand: i };
          if (h.cards.length === 1) { // main issue d'une séparation : deuxième carte
            this.emit();
            await this.wait(300);
            h.cards.push(this.draw());
            this.emit();
            await this.wait(380);
            if (handTotal(h.cards).t === 21) { h.done = true; continue; }
          }
          this.talk('turn', { s: p.seat, pre: first && peeked ? 'noBJ' : '' });
          first = false;
          while (!h.done) {
            this.pending = null;
            this.awaiting = true;
            // Joueur déconnecté : il « reste » après quelques secondes
            const limit = p.connected || !this.o.turnTime ? this.o.turnTime : 3000;
            await this.waitFor(() => !!this.pending, limit, 'turn');
            this.awaiting = false;
            const a = this.pending || 'stand'; // délai écoulé : le joueur reste
            this.pending = null;
            await this.applyAction(p, i, a);
          }
        }
      }
      this.turn = null;

      // Le croupier retourne sa carte et tire jusqu'à 17
      this.phase = 'dealer';
      this.talk('dealer');
      this.emit();
      await this.wait(300);
      await this.revealHole();
      const live = parts.some((p) => p.hands.some((h) => !h.surrendered && handTotal(h.cards).t <= 21 && !isBJ(h)));
      if (live) {
        while (handTotal(this.dealer).t < 17) {
          await this.wait(700);
          this.dealer.push(this.draw());
          this.emit();
        }
      }
      await this.wait(500);
      return this.settle(parts);
    }

    async applyAction(p, i, kind) {
      const h = p.hands[i];
      if (!this.legalFor(p, h)[kind]) kind = 'stand';
      if (kind === 'stand') { h.done = true; return; }
      if (kind === 'hit') {
        h.cards.push(this.draw());
        this.emit();
        await this.wait(380);
        const t = handTotal(h.cards).t;
        if (t > 21) {
          h.done = true;
          this.talk('bust', { s: p.seat });
          this.emit();
          await this.wait(550);
        } else if (t === 21) {
          h.done = true;
          await this.wait(250);
        }
        return;
      }
      if (kind === 'double') {
        p.stack = round2(p.stack - h.bet);
        h.bet *= 2;
        h.doubled = true;
        h.cards.push(this.draw());
        this.emit();
        await this.wait(500);
        h.done = true;
        if (handTotal(h.cards).t > 21) {
          this.talk('bust', { s: p.seat });
          this.emit();
          await this.wait(450);
        }
        return;
      }
      if (kind === 'split') {
        p.stack = round2(p.stack - h.bet);
        const aces = v1(h.cards[0].c) === 1;
        const nh = newHand(h.bet);
        nh.cards.push(h.cards.pop());
        nh.split = true;
        nh.splitAces = aces;
        h.split = true;
        h.splitAces = aces;
        p.hands.splice(i + 1, 0, nh);
        this.emit();
        await this.wait(350);
        h.cards.push(this.draw());
        this.emit();
        await this.wait(380);
        if (aces) {
          nh.cards.push(this.draw());
          this.emit();
          await this.wait(380);
          h.done = true;
          nh.done = true;
          this.talk('splitAces', { s: p.seat });
          this.emit();
          return;
        }
        if (handTotal(h.cards).t === 21) h.done = true;
        return;
      }
      if (kind === 'surrender') {
        h.surrendered = true;
        h.done = true;
        this.talk('surrender', { s: p.seat });
        this.emit();
      }
    }

    async revealHole() {
      if (!this.holeHidden) return;
      this.holeHidden = false;
      this.seen[v1(this.dealer[1].c)]++;
      this.emit();
      await this.wait(600);
    }

    async settle(parts) {
      const d = handTotal(this.dealer).t;
      const dBJ = this.dealerBJ();
      const dBust = d > 21;
      for (const p of parts) {
        let ret = 0;
        let staked = 0;
        const st = p.stats;
        for (const h of p.hands) {
          staked += h.bet;
          const t = handTotal(h.cards).t;
          if (h.surrendered) { h.result = 'surrender'; h.payout = h.bet / 2; }
          else if (t > 21) { h.result = 'bust'; h.payout = 0; }
          else if (isBJ(h)) {
            h.result = dBJ ? 'push' : 'blackjack';
            h.payout = dBJ ? h.bet : h.bet * 2.5; // le blackjack paie 3 contre 2
          }
          else if (dBJ) { h.result = 'lose'; h.payout = 0; }
          else if (dBust || t > d) { h.result = 'win'; h.payout = h.bet * 2; }
          else if (t === d) { h.result = 'push'; h.payout = h.bet; }
          else { h.result = 'lose'; h.payout = 0; }
          ret += h.payout;
          if (h.result === 'win' || h.result === 'blackjack') st.wins++;
          else if (h.result === 'push') st.pushes++;
          else st.losses++;
          if (h.result === 'blackjack') st.bj++;
        }
        if (p.insurance) {
          staked += p.insurance;
          if (dBJ) ret += p.insurance * 3; // l'assurance paie 2 contre 1
        }
        p.stack = round2(p.stack + ret);
        p.lastNet = round2(ret - staked);
        st.rounds++;
        st.net = round2(st.net + p.lastNet);
        p.inRound = false;
      }
      this.talk('settle', { dBJ, dBust, d });
      this.phase = 'settle';
      this.showing = true;
      this.turn = null;
      this.emit();
      if (this.o.resultTime) await this.wait(this.o.resultTime);
      this.phase = 'betting';
      for (const p of this.players()) p.ready = false;
      this.emit();
      if (this.shuffleDue) {
        const g = this.gen;
        setTimeout(() => {
          if (g === this.gen && this.phase === 'betting' && this.showing) { this.talk('cut'); this.emit(); }
        }, this.ms(1800));
      }
      this.checkStart();
    }

    /** Ce que voit le joueur `id` : la carte cachée du croupier et le sabot ne sont jamais envoyés. */
    view(id) {
      const me = this.get(id);
      const v = {
        type: 'blackjack',
        phase: this.phase,
        showing: this.showing,
        you: me ? me.seat : -1,
        seats: this.seats.map((p) => p && {
          name: p.name, stack: p.stack, bet: p.bet, ready: p.ready, connected: p.connected,
          lastNet: p.lastNet, insurance: p.insurance, insDecided: p.insDecided, inRound: p.inRound,
          hands: p.hands.map((h) => ({
            cards: h.cards.map((x) => ({ c: x.c, id: x.id })), bet: h.bet, done: h.done, doubled: h.doubled,
            split: h.split, splitAces: h.splitAces, surrendered: h.surrendered, result: h.result, payout: h.payout,
          })),
        }),
        dealer: this.dealer.map((x, i) => (i === 1 && this.holeHidden ? { c: null, id: x.id } : { c: x.c, id: x.id })),
        holeHidden: this.holeHidden,
        turn: this.turn && { seat: this.turn.seat, hand: this.turn.hand },
        awaiting: this.awaiting,
        seen: this.seen.slice(),
        shoeLeft: this.shoe.length - this.pos,
        shoeSize: this.shoe.length,
        say: this.say,
        deadlineMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : 0,
        deadlineFor: this.deadline ? this.deadlineFor : null,
        times: { bet: this.ms(this.o.betTime || 0), turn: this.ms(this.o.turnTime || 0), ins: this.ms(this.o.insTime || 0) },
        maxBet: this.o.maxBet,
        me: null,
      };
      if (me) {
        const mine = this.turn && this.turn.seat === me.seat && this.awaiting && !this.pending;
        v.me = {
          lastBet: me.lastBet,
          stats: me.stats,
          legal: mine && this.phase === 'playing' ? this.legalFor(me, me.hands[this.turn.hand]) : null,
          canInsure: this.phase === 'insurance' && me.inRound && !me.insDecided,
        };
      }
      return v;
    }
  }

  return { Table, dealerDist, playerEV, handTotal, isBJ, v1, hiLoV, FULL, DECKS, CHIP_VALUES };
});
