/* =================================================================
   Poker Texas Hold'em No Limit — moteur partagé
   (solo, et table entre amis en peer-to-peer dans le navigateur de l’hôte)

   - évaluation des mains (7 cartes)
   - table : blindes, tours d'enchères, relances minimales, tapis,
     pots annexes, abattage
   - IA des adversaires (équité Monte-Carlo + profils de jeu)
   - Runner : enchaîne les mains et fait jouer les IA avec des délais
   ================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rng.js'));
  else root.PokerCore = factory(root.RNG);
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  // ---------------------------------------------------------------
  // Cartes : entier 0–51, rang = c >> 2 (0 = deux … 12 = as), couleur = c & 3
  // ---------------------------------------------------------------
  const RANK_LABEL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];
  const SUIT_SYM = ['♠', '♥', '♦', '♣'];
  const cardLabel = (c) => RANK_LABEL[c >> 2] + SUIT_SYM[c & 3];
  const fmt = (n) => Math.round(n).toLocaleString('fr-FR') + ' €';

  // ---------------------------------------------------------------
  // Évaluation des mains
  // Score = catégorie × 13⁵ + rangs départageants (plus grand = meilleur)
  // ---------------------------------------------------------------
  const P5 = 371293; // 13⁵
  const rc = new Int8Array(13);
  const sc = new Int8Array(4);
  const sm = new Int32Array(4);

  function straightTop(mask) {
    const m = (mask << 1) | ((mask >> 12) & 1); // l'as compte aussi comme 1
    for (let r = 12; r >= 3; r--) if (((m >> (r - 3)) & 31) === 31) return r;
    return -1;
  }
  function score(cat, ranks) {
    let s = cat;
    for (let i = 0; i < 5; i++) s = s * 13 + (ranks[i] > 0 ? ranks[i] : 0);
    return s;
  }

  /** Score de la meilleure main de 5 cartes parmi 5 à 7 cartes. */
  function evalScore(cards) {
    rc.fill(0); sc.fill(0); sm.fill(0);
    let rm = 0;
    for (let k = 0; k < cards.length; k++) {
      const c = cards[k];
      const r = c >> 2;
      const s = c & 3;
      rc[r]++; sc[s]++; sm[s] |= 1 << r; rm |= 1 << r;
    }
    let fs = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;
    if (fs >= 0) {
      const sf = straightTop(sm[fs]);
      if (sf >= 0) return score(8, [sf]);
    }
    let quad = -1;
    const trips = [];
    const pairs = [];
    for (let r = 12; r >= 0; r--) {
      if (rc[r] === 4) quad = r;
      else if (rc[r] === 3) trips.push(r);
      else if (rc[r] === 2) pairs.push(r);
    }
    if (quad >= 0) {
      let k = 0;
      for (let r = 12; r >= 0; r--) if (r !== quad && rc[r]) { k = r; break; }
      return score(7, [quad, k]);
    }
    if (trips.length && (trips.length > 1 || pairs.length)) {
      const p = trips.length > 1 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0];
      return score(6, [trips[0], p]);
    }
    if (fs >= 0) {
      const top = [];
      for (let r = 12; r >= 0 && top.length < 5; r--) if ((sm[fs] >> r) & 1) top.push(r);
      return score(5, top);
    }
    const st = straightTop(rm);
    if (st >= 0) return score(4, [st]);
    if (trips.length) {
      const k = [];
      for (let r = 12; r >= 0 && k.length < 2; r--) if (rc[r] && r !== trips[0]) k.push(r);
      return score(3, [trips[0], ...k]);
    }
    if (pairs.length >= 2) {
      let k = 0;
      for (let r = 12; r >= 0; r--) if (rc[r] && r !== pairs[0] && r !== pairs[1]) { k = r; break; }
      return score(2, [pairs[0], pairs[1], k]);
    }
    if (pairs.length === 1) {
      const k = [];
      for (let r = 12; r >= 0 && k.length < 3; r--) if (rc[r] && r !== pairs[0]) k.push(r);
      return score(1, [pairs[0], ...k]);
    }
    const k = [];
    for (let r = 12; r >= 0 && k.length < 5; r--) if (rc[r]) k.push(r);
    return score(0, k);
  }

  const category = (s) => Math.floor(s / P5);
  function decodeRanks(s) {
    const r = [];
    let x = s % P5;
    for (let i = 4; i >= 0; i--) { r[i] = x % 13; x = Math.floor(x / 13); }
    return r;
  }

  const NAME = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'valet', 'dame', 'roi', 'as'];
  const PL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'valets', 'dames', 'rois', 'as'];
  const de = (r) => (r === 12 ? 'd’' : 'de ') + PL[r];
  const CAT_NAME = ['Carte haute', 'Paire', 'Double paire', 'Brelan', 'Quinte', 'Couleur', 'Full', 'Carré', 'Quinte flush'];

  function handName(s) {
    const r = decodeRanks(s);
    switch (category(s)) {
      case 8: return r[0] === 12 ? 'Quinte flush royale' : `Quinte flush hauteur ${NAME[r[0]]}`;
      case 7: return `Carré ${de(r[0])}`;
      case 6: return `Full aux ${PL[r[0]]} par les ${PL[r[1]]}`;
      case 5: return `Couleur hauteur ${NAME[r[0]]}`;
      case 4: return `Quinte hauteur ${NAME[r[0]]}`;
      case 3: return `Brelan ${de(r[0])}`;
      case 2: return `Double paire, ${PL[r[0]]} et ${PL[r[1]]}`;
      case 1: return `Paire ${de(r[0])}`;
      default: return `Hauteur ${NAME[r[0]]}`;
    }
  }

  /** Meilleure combinaison de 5 cartes (pour l'affichage). */
  function bestFive(cards) {
    const n = cards.length;
    if (n <= 5) return { score: evalScore(cards), five: cards.slice() };
    let best = -1;
    let five = null;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
      for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        const h = [cards[a], cards[b], cards[c], cards[d], cards[e]];
        const s = evalScore(h);
        if (s > best) { best = s; five = h; }
      }
    return { score: best, five };
  }

  // ---------------------------------------------------------------
  // Force des mains de départ (formule de Chen → percentile)
  // ---------------------------------------------------------------
  function chen(c1, c2) {
    let r1 = c1 >> 2;
    let r2 = c2 >> 2;
    if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
    const val = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
    let s = val(r1);
    if (r1 === r2) return Math.max(5, s * 2);
    if ((c1 & 3) === (c2 & 3)) s += 2;
    const gap = r1 - r2 - 1;
    s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && r1 < 10) s += 1;
    return Math.ceil(s);
  }
  const PCT = new Float32Array(52 * 52);
  (function buildPct() {
    const combos = [];
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) combos.push([a, b, chen(a, b)]);
    combos.sort((x, y) => y[2] - x[2]);
    let i = 0;
    while (i < combos.length) {
      let j = i;
      while (j < combos.length && combos[j][2] === combos[i][2]) j++;
      const pct = (i + j) / 2 / combos.length;
      for (let k = i; k < j; k++) {
        const [a, b] = combos[k];
        PCT[a * 52 + b] = pct;
        PCT[b * 52 + a] = pct;
      }
      i = j;
    }
  })();
  /** 0 = meilleure main de départ, 1 = pire. */
  const handPct = (a, b) => PCT[a * 52 + b];

  // ---------------------------------------------------------------
  // Table de poker
  // ---------------------------------------------------------------
  class Table {
    constructor({ sb, bb, seats = 6 }) {
      this.sb = sb;
      this.bb = bb;
      this.n = seats;
      this.seats = new Array(seats).fill(null);
      this.button = -1;
      this.handNo = 0;
      this.phase = 'waiting'; // waiting | betting | streetEnd | handOver
      this.street = null;
      this.board = [];
      this.deck = [];
      this.currentBet = 0;
      this.minRaise = bb;
      this.toAct = -1;
      this.sbSeat = -1;
      this.bbSeat = -1;
      this.aggressor = -1;
      this.result = null;
      this.lines = [];
    }

    log(text, cls = '') {
      this.lines.push({ text, cls });
      if (this.lines.length > 120) this.lines.shift();
    }
    nextSeat(from, pred) {
      for (let k = 1; k <= this.n; k++) {
        const i = (((from + k) % this.n) + this.n) % this.n;
        const p = this.seats[i];
        if (p && pred(p, i)) return i;
      }
      return -1;
    }
    eligible(p) { return !!p && p.stack > 0 && !p.sittingOut && !p.leaving; }
    actable(p) { return !!p && p.inHand && !p.folded && !p.allIn; }
    live() { return this.seats.filter((p) => p && p.inHand && !p.folded); }
    potTotal() { let s = 0; for (const p of this.seats) if (p) s += p.total; return s; }
    distFromButton(p) { return (this.seats.indexOf(p) - this.button - 1 + this.n) % this.n; }

    put(p, amt) {
      const a = Math.max(0, Math.min(Math.floor(amt), p.stack));
      p.stack -= a;
      p.bet += a;
      p.total += a;
      if (p.stack === 0) p.allIn = true;
    }
    post(i, amt, small) {
      const p = this.seats[i];
      this.put(p, amt);
      p.lastAction = { type: 'blind', label: small ? 'PB' : 'GB', amount: p.bet };
      this.log(`${p.name} paie la ${small ? 'petite' : 'grosse'} blinde (${fmt(p.bet)})`, 'muted');
    }

    startHand() {
      const elig = this.seats.filter((p) => this.eligible(p));
      if (elig.length < 2) return false;
      this.handNo++;
      for (const p of this.seats) {
        if (!p) continue;
        Object.assign(p, {
          inHand: this.eligible(p), cards: [], folded: false, allIn: false, bet: 0, total: 0,
          acted: false, raiseOpen: true, lastAction: null, shown: false, handName: null, best: null,
          actions: [], won: 0,
        });
      }
      this.board = [];
      this.result = null;
      this.deck = RNG.shuffle(Array.from({ length: 52 }, (_, i) => i)); // mélange cryptographique
      this.button = this.nextSeat(this.button, (p) => p.inHand);
      const headsUp = elig.length === 2;
      this.sbSeat = headsUp ? this.button : this.nextSeat(this.button, (p) => p.inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, (p) => p.inHand);
      this.log(`Main n° ${this.handNo}`, 'sep');
      this.post(this.sbSeat, this.sb, true);
      this.post(this.bbSeat, this.bb, false);
      for (let r = 0; r < 2; r++) {
        let i = this.sbSeat;
        do {
          const p = this.seats[i];
          if (p && p.inHand) p.cards.push(this.deck.pop());
          i = (i + 1) % this.n;
        } while (i !== this.sbSeat);
      }
      this.street = 'preflop';
      this.currentBet = this.bb;
      this.minRaise = this.bb;
      this.aggressor = this.bbSeat;
      this.phase = 'betting';
      this.toAct = this.nextSeat(this.bbSeat, (p) => this.actable(p));
      this.settle();
      return true;
    }

    legal(i) {
      const p = this.seats[i];
      const toCall = Math.max(0, this.currentBet - p.bet);
      const others = this.live().filter((o) => o !== p && !o.allIn);
      let raise = null;
      if (p.stack > toCall && p.raiseOpen && others.length > 0) {
        const max = p.bet + p.stack;
        raise = { min: Math.min(this.currentBet + this.minRaise, max), max };
      }
      return { toCall, callAmount: Math.min(toCall, p.stack), canCheck: toCall === 0, raise };
    }

    act(i, a) {
      if (this.phase !== 'betting' || i !== this.toAct) return false;
      const p = this.seats[i];
      const L = this.legal(i);
      let type = a && a.type;
      if (type === 'call' && L.canCheck) type = 'check';
      if (type === 'check' && !L.canCheck) return false;
      if (type === 'raise' && !L.raise) type = L.canCheck ? 'check' : 'call';
      const name = p.name;
      if (type === 'fold') {
        p.folded = true;
        p.lastAction = { type: 'fold', label: 'Couché' };
        this.log(`${name} se couche`);
      } else if (type === 'check') {
        p.lastAction = { type: 'check', label: 'Parole' };
        this.log(`${name} fait parole`);
      } else if (type === 'call') {
        const amt = L.callAmount;
        this.put(p, amt);
        p.lastAction = { type: 'call', label: p.allIn ? 'Tapis' : 'Suit', amount: p.bet };
        this.log(p.allIn ? `${name} suit et fait tapis (${fmt(amt)})` : `${name} suit (${fmt(amt)})`);
      } else if (type === 'raise') {
        let to = Math.floor(Number(a.amount) || 0);
        to = Math.max(L.raise.min, Math.min(L.raise.max, to));
        const wasBet = this.currentBet === 0;
        const size = to - this.currentBet;
        this.put(p, to - p.bet);
        if (size >= this.minRaise) {
          // relance complète : tout le monde peut de nouveau relancer
          this.minRaise = size;
          for (const o of this.seats) if (o && o !== p && this.actable(o)) { o.acted = false; o.raiseOpen = true; }
        } else {
          // tapis inférieur à une relance minimale : il faut suivre, mais l'enchère n'est pas rouverte
          for (const o of this.seats) if (o && o !== p && this.actable(o)) o.acted = false;
        }
        this.currentBet = Math.max(this.currentBet, p.bet);
        this.aggressor = i;
        const label = p.allIn ? 'Tapis' : wasBet ? 'Mise' : 'Relance';
        p.lastAction = { type: 'raise', label, amount: p.bet };
        this.log(p.allIn ? `${name} fait tapis (${fmt(p.bet)})` : wasBet ? `${name} mise ${fmt(p.bet)}` : `${name} relance à ${fmt(p.bet)}`);
      } else {
        return false;
      }
      p.acted = true;
      p.raiseOpen = false;
      p.actions.push({ street: this.street, type });
      this.settle();
      return true;
    }

    /** Détermine la suite : main gagnée, fin du tour d'enchères ou prochain joueur. */
    settle() {
      const live = this.live();
      if (live.length <= 1) return this.winUncontested(live[0]);
      const actables = live.filter((p) => !p.allIn);
      const pending = actables.filter((p) => !(p.acted && p.bet === this.currentBet));
      if (pending.length === 0 || (actables.length === 1 && actables[0].bet >= this.currentBet)) return this.endStreet();
      const cur = this.seats[this.toAct];
      if (!(cur && pending.includes(cur))) this.toAct = this.nextSeat(this.toAct, (p) => pending.includes(p));
    }

    /** Rend la partie d'une mise que personne n'a suivie. */
    refundUncalled() {
      let top = null;
      let topV = -1;
      let second = 0;
      for (const p of this.seats) {
        if (!p || !p.inHand) continue;
        if (p.total > topV) { second = Math.max(second, topV); topV = p.total; top = p; }
        else second = Math.max(second, p.total);
      }
      if (top && topV > second) {
        const d = topV - second;
        top.stack += d;
        top.total -= d;
        top.bet = Math.max(0, top.bet - d);
        if (top.stack > 0) top.allIn = false;
        if (top.lastAction && top.lastAction.amount) top.lastAction.amount = Math.max(0, top.lastAction.amount - d);
        this.log(`${fmt(d)} non suivis rendus à ${top.name}`, 'muted');
      }
    }

    endStreet() {
      this.refundUncalled();
      for (const p of this.seats) if (p) p.bet = 0;
      this.toAct = -1;
      if (this.live().length <= 1) return this.winUncontested(this.live()[0]);
      this.phase = 'streetEnd';
    }

    nextStreet() {
      if (this.phase !== 'streetEnd') return;
      if (this.street === 'river') return this.showdown();
      this.street = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.street];
      this.deck.pop(); // carte brûlée
      const k = this.street === 'flop' ? 3 : 1;
      for (let j = 0; j < k; j++) this.board.push(this.deck.pop());
      const title = { flop: 'Flop', turn: 'Turn', river: 'River' }[this.street];
      this.log(`${title} : ${this.board.slice(-k).map(cardLabel).join(' ')}`, 'street');
      this.currentBet = 0;
      this.minRaise = this.bb;
      for (const p of this.seats) {
        if (p && p.inHand && !p.folded && !p.allIn) { p.acted = false; p.raiseOpen = true; p.lastAction = null; }
      }
      this.phase = 'betting';
      this.toAct = this.nextSeat(this.button, (p) => this.actable(p));
      this.settle();
    }

    /** Pots principal et annexes, d'après les contributions de chacun. */
    buildPots() {
      const contrib = this.seats.filter((p) => p && p.inHand && p.total > 0);
      const live = contrib.filter((p) => !p.folded);
      const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);
      const pots = [];
      let prev = 0;
      for (const lvl of levels) {
        let amount = 0;
        for (const p of contrib) amount += Math.max(0, Math.min(p.total, lvl) - prev);
        const eligible = live.filter((p) => p.total >= lvl);
        if (amount > 0) {
          const last = pots[pots.length - 1];
          if (last && last.eligible.length === eligible.length) last.amount += amount;
          else pots.push({ amount, eligible });
        }
        prev = lvl;
      }
      let extra = 0;
      for (const p of contrib) extra += Math.max(0, p.total - prev);
      if (extra && pots.length) pots[pots.length - 1].amount += extra;
      return pots;
    }

    showdown() {
      const live = this.live();
      const sc2 = new Map();
      for (const p of live) {
        const bf = bestFive([...p.cards, ...this.board]);
        sc2.set(p, bf.score);
        p.shown = true;
        p.handName = handName(bf.score);
        p.best = bf.five;
      }
      const pots = this.buildPots();
      const results = [];
      this.log('Abattage', 'street');
      pots.forEach((pot, idx) => {
        let best = -1;
        let winners = [];
        for (const p of pot.eligible) {
          const s = sc2.get(p);
          if (s > best) { best = s; winners = [p]; } else if (s === best) winners.push(p);
        }
        winners.sort((a, b) => this.distFromButton(a) - this.distFromButton(b));
        const share = Math.floor(pot.amount / winners.length);
        let rest = pot.amount - share * winners.length;
        for (const w of winners) {
          const g = share + (rest > 0 ? 1 : 0);
          if (rest > 0) rest--;
          w.stack += g;
          w.won += g;
        }
        const potName = pots.length > 1 ? (idx === 0 ? 'le pot principal' : `le pot annexe ${idx}`) : 'le pot';
        const names = winners.map((w) => w.name).join(' et ');
        this.log(winners.length > 1
          ? `${names} se partagent ${potName} (${fmt(pot.amount)}) avec ${handName(best)}`
          : `${names} remporte ${potName} (${fmt(pot.amount)}) avec ${handName(best)}`, 'win');
        results.push({ amount: pot.amount, winners: winners.map((w) => this.seats.indexOf(w)), handName: handName(best) });
      });
      this.result = { type: 'showdown', pots: results };
      for (const p of this.seats) if (p) { p.total = 0; p.bet = 0; }
      this.phase = 'handOver';
      this.toAct = -1;
    }

    winUncontested(p) {
      this.refundUncalled();
      const pot = this.potTotal();
      p.stack += pot;
      p.won = pot;
      for (const o of this.seats) if (o) { o.total = 0; o.bet = 0; }
      this.result = { type: 'fold', pots: [{ amount: pot, winners: [this.seats.indexOf(p)], handName: null }] };
      this.log(`${p.name} remporte ${fmt(pot)} (tous les autres se sont couchés)`, 'win');
      this.phase = 'handOver';
      this.toAct = -1;
    }

    /** Un joueur quitte la main hors de son tour (départ, déconnexion). */
    forceFold(i) {
      const p = this.seats[i];
      if (!p || !p.inHand || p.folded || this.phase === 'waiting' || this.phase === 'handOver') return;
      p.folded = true;
      p.lastAction = { type: 'fold', label: 'Couché' };
      this.log(`${p.name} se couche`);
      if (this.phase === 'betting') this.settle();
      else if (this.live().length <= 1) this.winUncontested(this.live()[0]);
    }

    /** Ce que voit le joueur assis en `me` (cartes des autres cachées). */
    view(me) {
      const seats = this.seats.map((p, i) => {
        if (!p) return null;
        let cards = null;
        if (p.inHand && p.cards.length) {
          if (i === me || p.shown) cards = p.cards.slice();
          else if (!p.folded) cards = ['hidden', 'hidden'];
        }
        return {
          seat: i, id: p.id, name: p.name, stack: p.stack, bet: p.bet,
          inHand: !!p.inHand, folded: !!p.folded, allIn: !!p.allIn,
          isBot: !!p.isBot, style: p.style || null, lastAction: p.lastAction,
          cards, handName: p.shown ? p.handName : null, best: p.shown ? p.best : null,
          won: p.won || 0, connected: p.connected !== false, leaving: !!p.leaving,
        };
      });
      let bets = 0;
      for (const p of this.seats) if (p) bets += p.bet;
      return {
        handNo: this.handNo, phase: this.phase, street: this.street, board: this.board.slice(),
        button: this.button, sbSeat: this.sbSeat, bbSeat: this.bbSeat, toAct: this.toAct,
        currentBet: this.currentBet, sb: this.sb, bb: this.bb, seats,
        pot: this.potTotal() - bets, you: me,
        legal: me === this.toAct && this.phase === 'betting' ? this.legal(me) : null,
        result: this.result, log: this.lines.slice(-60),
      };
    }
  }

  // ---------------------------------------------------------------
  // IA des adversaires
  // ---------------------------------------------------------------
  const STYLES = {
    roc: { label: 'Prudent', vpip: 0.17, pfr: 0.11, aggr: 0.35, bluff: 0.04, margin: 0.07 },
    requin: { label: 'Requin', vpip: 0.24, pfr: 0.19, aggr: 0.7, bluff: 0.12, margin: 0.02 },
    flambeur: { label: 'Flambeur', vpip: 0.42, pfr: 0.3, aggr: 0.85, bluff: 0.24, margin: -0.01 },
    touriste: { label: 'Touriste', vpip: 0.5, pfr: 0.08, aggr: 0.2, bluff: 0.05, margin: -0.05 },
  };
  const DIFF = {
    facile: { iters: 140, noise: 0.2, styles: ['touriste', 'touriste', 'flambeur', 'roc'] },
    normal: { iters: 380, noise: 0.08, styles: ['roc', 'requin', 'flambeur', 'touriste'] },
    difficile: { iters: 900, noise: 0.03, styles: ['requin', 'requin', 'flambeur', 'roc'] },
  };
  const BOT_NAMES = ['Marcel', 'Juliette', 'Hugo', 'Inès', 'Bernard', 'Chloé', 'Karim', 'Léa', 'Gaston', 'Yasmine',
    'Paul', 'Nadia', 'Louis', 'Camille', 'Mehdi', 'Zoé', 'Arthur', 'Sofia', 'Jules', 'Manon'];

  function makeBot(usedNames, difficulty, stack) {
    const free = BOT_NAMES.filter((n) => !usedNames.includes(n));
    const name = free.length ? RNG.pick(free) : 'Bot ' + (1 + RNG.int(99));
    const d = DIFF[difficulty] || DIFF.normal;
    return { name, isBot: true, style: RNG.pick(d.styles), stack };
  }

  /** Fourchette de mains de départ qu'un adversaire peut avoir, d'après ses actions publiques. */
  function rangeOf(o) {
    const pre = o.actions.filter((a) => a.street === 'preflop');
    const raises = pre.filter((a) => a.type === 'raise').length;
    const calls = pre.filter((a) => a.type === 'call').length;
    let r = raises >= 2 ? 0.07 : raises === 1 ? 0.2 : calls ? 0.5 : 0.85;
    const agg = o.actions.filter((a) => a.street !== 'preflop' && a.type === 'raise').length;
    return { range: r, agg };
  }

  /**
   * Équité Monte-Carlo : probabilité de gagner à l'abattage contre les adversaires,
   * en tirant leurs mains dans des fourchettes plausibles. N'utilise que les cartes
   * visibles par le joueur (ses deux cartes et le tableau) : l'IA ne triche pas.
   */
  function equity(hole, board, opps, iters) {
    const used = new Uint8Array(52);
    for (const c of hole) used[c] = 1;
    for (const c of board) used[c] = 1;
    const base = [];
    for (let c = 0; c < 52; c++) if (!used[c]) base.push(c);
    const n0 = base.length;
    const work = new Array(n0);
    const need = 5 - board.length;
    const boardCat = board.length >= 3 ? category(evalScore(board)) : -1;
    const my = hole.concat(board);
    let total = 0;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < n0; k++) work[k] = base[k];
      let n = n0;
      const opHands = [];
      for (const o of opps) {
        let a = 0;
        let b = 0;
        for (let tries = 0; ; tries++) {
          const j1 = Math.floor(Math.random() * n);
          let j2 = Math.floor(Math.random() * (n - 1));
          if (j2 >= j1) j2++;
          a = work[j1];
          b = work[j2];
          let ok = tries >= 30;
          if (!ok) {
            ok = handPct(a, b) <= o.range || Math.random() < 0.04;
            if (ok && o.agg > 0 && boardCat >= 0) {
              const made = category(evalScore([a, b, ...board])) > boardCat;
              if (!made && Math.random() > Math.pow(0.4, o.agg)) ok = false;
            }
          }
          if (ok) {
            const hi = Math.max(j1, j2);
            const lo = Math.min(j1, j2);
            work[hi] = work[--n];
            work[lo] = work[--n];
            break;
          }
        }
        opHands.push(a, b);
      }
      const full = board.slice();
      for (let k = 0; k < need; k++) {
        const j = Math.floor(Math.random() * n);
        full.push(work[j]);
        work[j] = work[--n];
      }
      const extra = full.slice(board.length);
      const mine = evalScore(my.concat(extra));
      let bestOpp = -1;
      let ties = 0;
      for (let k = 0; k < opHands.length; k += 2) {
        const s = evalScore([opHands[k], opHands[k + 1], ...full]);
        if (s > bestOpp) { bestOpp = s; ties = 1; } else if (s === bestOpp) ties++;
      }
      if (mine > bestOpp) total += 1;
      else if (mine === bestOpp) total += 1 / (ties + 1);
    }
    return total / iters;
  }

  function positionFactor(t, i) {
    const order = [];
    for (let k = 0; k < t.n; k++) {
      const idx = (t.sbSeat + k) % t.n;
      const p = t.seats[idx];
      if (p && p.inHand && !p.folded) order.push(idx);
    }
    const pos = order.indexOf(i);
    return order.length > 1 ? pos / (order.length - 1) : 1;
  }

  function decide(t, i, difficulty) {
    const a = decideRaw(t, i, difficulty);
    const L = t.legal(i);
    if (a.type === 'fold' && L.canCheck) return { type: 'check' };
    if (a.type === 'raise' && !L.raise) return { type: L.canCheck ? 'check' : 'call' };
    return a;
  }

  function decideRaw(t, i, difficulty) {
    const p = t.seats[i];
    const st = STYLES[p.style] || STYLES.requin;
    const D = DIFF[difficulty] || DIFF.normal;
    const L = t.legal(i);
    const rnd = Math.random;
    const bb = t.bb;
    const pot = t.potTotal();
    const toCall = L.callAmount;
    const opps = t.live().filter((o) => o !== p);
    const nOpp = opps.length;
    const stackBB = (p.stack + p.bet) / bb;
    const check = { type: 'check' };
    const fold = { type: 'fold' };
    const call = { type: 'call' };
    const raiseTo = (x) => {
      if (!L.raise) return toCall > 0 ? call : check;
      let to = Math.round(Math.max(L.raise.min, Math.min(L.raise.max, x)));
      if (to >= L.raise.max * 0.85) to = L.raise.max; // presque tapis : autant tout mettre
      return { type: 'raise', amount: to };
    };
    const betPot = (f) => raiseTo(t.currentBet + Math.max(bb, (pot + toCall) * f));
    const eqNow = () => {
      let e = equity(p.cards, t.board, opps.map(rangeOf), D.iters);
      e += (rnd() - 0.5) * D.noise;
      return Math.max(0, Math.min(1, e));
    };

    // ---------- Avant le flop ----------
    if (t.street === 'preflop') {
      const pct = handPct(p.cards[0], p.cards[1]) + (rnd() - 0.5) * D.noise * 0.5;
      const pos = positionFactor(t, i);
      let vpip = st.vpip * (0.75 + 0.55 * pos);
      let pfr = st.pfr * (0.75 + 0.55 * pos);
      if (nOpp <= 2) { vpip *= 1.5; pfr *= 1.5; }
      const raised = t.currentBet > bb;

      // Gros engagement (tapis adverse ou tapis court) : on compare l'équité aux cotes du pot.
      if (toCall >= p.stack * 0.35 || stackBB < 14) {
        if (!raised && pct <= Math.max(pfr * 1.6, 0.2) && L.raise && stackBB < 14) return raiseTo(L.raise.max);
        if (!raised && toCall <= bb) return pct <= vpip ? (L.canCheck ? check : call) : (L.canCheck ? check : fold);
        const e = eqNow();
        const odds = toCall / (pot + toCall);
        if (e > odds + st.margin + 0.04) return L.raise && e > 0.62 && stackBB < 25 ? raiseTo(L.raise.max) : call;
        return L.canCheck ? check : fold;
      }
      if (!raised) {
        if (pct <= pfr && L.raise) {
          let limpers = 0;
          for (const o of opps) if (o.bet === bb && t.seats.indexOf(o) !== t.bbSeat) limpers++;
          return raiseTo(bb * (2.4 + rnd() * 0.8) + limpers * bb);
        }
        if (pct <= vpip) {
          if (L.canCheck) return rnd() < st.aggr * 0.3 && L.raise ? raiseTo(bb * 3) : check;
          return call;
        }
        if (L.canCheck) return check;
        // vol de blindes depuis le bouton
        if (pos === 1 && nOpp <= 3 && rnd() < st.bluff * 1.5 && L.raise) return raiseTo(bb * 2.5);
        return fold;
      }
      const sizeBB = t.currentBet / bb;
      const tight = Math.min(1, 3.2 / sizeBB);
      const threeBet = pfr * 0.32 * tight;
      const callR = vpip * 0.62 * tight;
      if (pct <= threeBet && L.raise) return raiseTo(t.currentBet * (2.6 + rnd() * 0.6));
      if (pct <= callR) return call;
      if (L.raise && rnd() < st.bluff * 0.12) return raiseTo(t.currentBet * 3);
      return L.canCheck ? check : fold;
    }

    // ---------- Après le flop ----------
    const eq = eqNow();
    const fair = 1 / (nOpp + 1);
    const strong = eq > Math.max(0.66, fair * 1.9);
    const good = eq > Math.max(0.52, fair * 1.4);
    const river = t.street === 'river';
    const wasAggressor = t.aggressor === i;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

    if (toCall === 0) {
      if (strong) {
        if (!river && rnd() < 0.15 * (1 - st.aggr)) return check; // jeu lent
        if (p.stack <= pot * 0.6) return raiseTo(L.raise ? L.raise.max : 0);
        return betPot(0.55 + rnd() * 0.35);
      }
      if (good && rnd() < st.aggr) return betPot(0.4 + rnd() * 0.25);
      const bluffP = st.bluff * (nOpp === 1 ? 1.4 : 0.45) * (wasAggressor ? 1.4 : 1);
      if (rnd() < bluffP) return betPot(0.45 + rnd() * 0.3);
      return check;
    }
    if (strong && L.raise && rnd() < 0.3 + st.aggr * 0.5) {
      if (p.stack + p.bet <= (pot + toCall) * 1.2) return raiseTo(L.raise.max);
      return raiseTo(t.currentBet + (pot + toCall) * (0.7 + rnd() * 0.4));
    }
    if (strong || eq > potOdds + st.margin) return call;
    if (L.raise && nOpp === 1 && !river && toCall < pot * 0.6 && rnd() < st.bluff * 0.25) {
      return raiseTo(t.currentBet * 2.5 + pot * 0.2);
    }
    return fold;
  }

  // ---------------------------------------------------------------
  // Runner : fait vivre une table (mains successives, IA, délais)
  // ---------------------------------------------------------------
  class Runner {
    constructor(opts) {
      this.o = Object.assign({
        sb: 1, bb: 2, seats: 6, difficulty: 'normal',
        botThink: [900, 2000], streetDelay: 1100, showdownDelay: 5200, foldDelay: 2300, startDelay: 1300,
        humanTimeout: 0, requireHuman: true, replaceBots: true, botStack: null,
        onUpdate: () => {},
      }, opts);
      this.table = new Table({ sb: this.o.sb, bb: this.o.bb, seats: this.o.seats });
      this.timer = null;
      this.deadline = 0;
      this.stopped = false;
      this.nextId = 1;
    }

    emit() { try { this.o.onUpdate(); } catch (e) { console.error(e); } }
    seatOf(id) { return this.table.seats.findIndex((p) => p && p.id === id); }
    usedNames() { return this.table.seats.filter(Boolean).map((p) => p.name); }
    botStack() { return this.o.botStack ? this.o.botStack() : Math.round(this.o.bb * RNG.range(70, 150)); }

    addPlayer(info, pref = -1) {
      const t = this.table;
      const i = pref >= 0 && pref < t.n && !t.seats[pref] ? pref : t.seats.findIndex((s) => !s);
      if (i < 0) return -1;
      t.seats[i] = {
        id: info.id || 'p' + this.nextId++, name: info.name, stack: Math.floor(info.stack),
        isBot: !!info.isBot, style: info.style || null, connected: true, sittingOut: false, leaving: false,
        inHand: false, cards: [], folded: false, allIn: false, bet: 0, total: 0, acted: false, raiseOpen: true,
        lastAction: null, shown: false, handName: null, best: null, actions: [], won: 0,
      };
      t.log(`${info.name} s’assoit avec ${fmt(info.stack)}`, 'muted');
      this.schedule();
      this.emit();
      return i;
    }

    addBot(pref = -1) {
      const b = makeBot(this.usedNames(), this.o.difficulty, this.botStack());
      return this.addPlayer(b, pref);
    }

    /** Le joueur part avec son tapis (les jetons déjà misés dans la main restent au pot). */
    removePlayer(id) {
      const t = this.table;
      const i = this.seatOf(id);
      if (i < 0) return 0;
      const p = t.seats[i];
      const handActive = p.inHand && (t.phase === 'betting' || t.phase === 'streetEnd');
      if (handActive && !p.folded) t.forceFold(i);
      const stack = p.stack;
      p.stack = 0;
      t.log(`${p.name} quitte la table`, 'muted');
      if (handActive) p.leaving = true;
      else t.seats[i] = null;
      this.schedule();
      this.emit();
      return stack;
    }

    act(id, a) {
      const t = this.table;
      const i = this.seatOf(id);
      if (i < 0 || i !== t.toAct || t.phase !== 'betting') return false;
      const ok = t.act(i, a);
      if (ok) { this.schedule(); this.emit(); }
      return ok;
    }

    rebuy(id, amount) {
      const t = this.table;
      const i = this.seatOf(id);
      if (i < 0) return false;
      const p = t.seats[i];
      if (p.inHand && (t.phase === 'betting' || t.phase === 'streetEnd') && !p.folded) return false;
      p.stack += Math.floor(amount);
      t.log(`${p.name} se recave de ${fmt(amount)}`, 'muted');
      this.schedule();
      this.emit();
      return true;
    }

    setConnected(id, on) {
      const i = this.seatOf(id);
      if (i < 0) return;
      this.table.seats[i].connected = on;
      this.schedule();
      this.emit();
    }

    canStart() {
      const e = this.table.seats.filter((p) => this.table.eligible(p));
      if (e.length < 2) return false;
      if (this.o.requireHuman && !e.some((p) => !p.isBot && p.connected)) return false;
      return true;
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.timer);
    }

    /** Annule la main en cours (fermeture de la table) : chacun récupère ce qu'il a misé. */
    cancelHand() {
      const t = this.table;
      if (t.phase !== 'betting' && t.phase !== 'streetEnd') return;
      for (const p of t.seats) if (p) { p.stack += p.total; p.total = 0; p.bet = 0; }
      t.log('Main annulée : les mises sont rendues', 'muted');
      this.endHand();
    }

    schedule() {
      clearTimeout(this.timer);
      this.timer = null;
      this.deadline = 0;
      if (this.stopped) return;
      const t = this.table;
      const later = (ms, fn) => {
        this.timer = setTimeout(() => {
          this.timer = null;
          try { fn(); } catch (e) { console.error(e); }
          this.schedule();
          this.emit();
        }, ms);
      };
      if (t.phase === 'waiting') {
        if (this.canStart()) later(this.o.startDelay, () => t.startHand());
        return;
      }
      if (t.phase === 'betting') {
        const i = t.toAct;
        const p = t.seats[i];
        if (!p) return;
        if (p.leaving) { later(60, () => t.act(i, { type: 'fold' })); return; }
        if (p.isBot) {
          const [a, b] = this.o.botThink;
          later(a + Math.random() * (b - a), () => {
            if (t.toAct !== i) return;
            if (!t.act(i, decide(t, i, this.o.difficulty))) {
              const L = t.legal(i);
              t.act(i, { type: L.canCheck ? 'check' : 'fold' });
            }
          });
          return;
        }
        if (this.o.humanTimeout) {
          const ms = p.connected ? this.o.humanTimeout : Math.min(this.o.humanTimeout, 8000);
          later(ms, () => {
            if (t.toAct !== i) return;
            const L = t.legal(i);
            t.act(i, { type: L.canCheck ? 'check' : 'fold' });
          });
          this.deadline = Date.now() + ms;
        }
        return;
      }
      if (t.phase === 'streetEnd') { later(this.o.streetDelay, () => t.nextStreet()); return; }
      if (t.phase === 'handOver') {
        later(t.result && t.result.type === 'showdown' ? this.o.showdownDelay : this.o.foldDelay, () => this.endHand());
      }
    }

    endHand() {
      const t = this.table;
      for (let i = 0; i < t.n; i++) {
        const p = t.seats[i];
        if (!p) continue;
        if (p.leaving) { t.seats[i] = null; continue; }
        if (p.isBot && p.stack <= 0) {
          t.seats[i] = null;
          if (this.o.replaceBots) {
            const b = makeBot(this.usedNames().concat(p.name), this.o.difficulty, this.botStack());
            t.log(`${p.name} n’a plus de jetons ; ${b.name} prend sa place`, 'muted');
            t.seats[i] = null;
            this.addPlayer(b, i);
          } else {
            t.log(`${p.name} n’a plus de jetons et quitte la table`, 'muted');
          }
        }
      }
      for (const p of t.seats) {
        if (!p) continue;
        Object.assign(p, {
          inHand: false, cards: [], lastAction: null, shown: false, handName: null, best: null,
          won: 0, bet: 0, total: 0, folded: false, allIn: false, actions: [],
        });
      }
      t.phase = 'waiting';
      t.board = [];
      t.result = null;
      t.toAct = -1;
      t.street = null;
    }

    view(me) {
      const v = this.table.view(me);
      v.deadlineMs = this.deadline ? Math.max(0, this.deadline - Date.now()) : 0;
      v.waiting = this.table.phase === 'waiting' && !this.canStart();
      v.difficulty = this.o.difficulty;
      return v;
    }
  }

  return {
    RANK_LABEL, SUIT_SYM, cardLabel, fmt,
    evalScore, bestFive, handName, category, CAT_NAME, handPct,
    Table, Runner,
    AI: { decide, equity, makeBot, STYLES, DIFF, rangeOf },
  };
});
