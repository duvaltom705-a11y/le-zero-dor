'use strict';

/* =================================================================
   Blackjack — sabot de 6 jeux, croupier IA « Victor »
   Le croupier applique les règles du casino (il reste sur tous les 17) :
   il ne choisit rien et ne triche pas. Son « intelligence » sert à
   conseiller le joueur : il calcule en direct, à partir des cartes
   encore inconnues, l'espérance de gain de chaque option.
   ================================================================= */
const Blackjack = (() => {
  const DECKS = 6;
  const MAX_HANDS = 4;
  const MAX_BET = 10000;
  const CHIP_VALUES = [1, 5, 10, 25, 100, 500, 1000];
  const ACT_FR = { hit: 'Tirer', stand: 'Rester', double: 'Doubler', split: 'Séparer', surrender: 'Abandonner' };
  const ACT_VERB = { hit: 'tirer', stand: 'rester', double: 'doubler', split: 'séparer', surrender: 'abandonner' };

  /** Valeur d'une carte : as = 1, figures = 10. */
  const v1 = (c) => { const r = c >> 2; return r === 12 ? 1 : r >= 8 ? 10 : r + 2; };
  /** Comptage Hi-Lo : 2–6 = +1, 7–9 = 0, 10/figures/as = −1. */
  const hiLo = (c) => { const v = v1(c); return v >= 2 && v <= 6 ? 1 : v === 10 || v === 1 ? -1 : 0; };

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
  const dealerHasBJ = () => S.dealer.length === 2 && handTotal(S.dealer).t === 21;
  const pct = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d).replace('.', ',')} %`;
  const say = (text) => { $('#bjSay').textContent = text; };
  const pick = (arr) => RNG.pick(arr);

  const LINES = {
    welcome: ['Bienvenue à ma table ! Posez votre mise quand vous voulez.', 'Bonsoir ! Installez-vous, les cartes sont prêtes.'],
    deal: ['Bonne chance !', 'C’est parti.', 'Cartes en jeu.'],
    playerBJ: ['Blackjack ! Félicitations.', 'Superbe, un blackjack d’entrée !'],
    bust: ['Aïe, vous dépassez 21.', 'Trop gourmand cette fois…', 'Ça dépasse, désolé.'],
    dealerBust: ['Je saute ! La main est pour vous.', 'Et je dépasse 21… à votre avantage.'],
    win: ['Bien joué !', 'La main est pour vous.', 'Joli coup.'],
    lose: ['La banque l’emporte cette fois.', 'Pas de chance sur celle-ci.'],
    push: ['Égalité, votre mise vous est rendue.'],
  };

  // ---------------------------------------------------------------
  // État
  // ---------------------------------------------------------------
  const S = {
    phase: 'closed', // betting | dealing | insurance | playing | dealer | closed
    busy: false,
    showingResult: false,
    shoe: [], pos: 0, cut: 0, shuffleDue: true,
    bet: 0, lastBet: 0, chip: 5,
    hands: [], active: 0,
    dealer: [], holeHidden: true,
    insurance: 0,
    running: 0, serial: 0,
    lastNet: null,
    stats: { rounds: 0, wins: 0, losses: 0, pushes: 0, bj: 0, net: 0 },
  };
  const seen = new Set();   // cartes déjà animées
  const flipped = new Set();

  // ---------------------------------------------------------------
  // Sabot
  // ---------------------------------------------------------------
  function newShoe() {
    const s = [];
    for (let d = 0; d < DECKS; d++) for (let c = 0; c < 52; c++) s.push(c);
    RNG.shuffle(s); // Fisher-Yates avec le générateur cryptographique
    S.shoe = s;
    S.pos = 0;
    S.cut = Math.round(s.length * RNG.range(0.72, 0.82)); // carte de coupe
    S.running = 0;
    S.shuffleDue = false;
  }
  function draw(faceUp = true) {
    if (S.pos >= S.shoe.length) newShoe(); // sécurité, n'arrive pas en pratique
    const c = S.shoe[S.pos++];
    if (S.pos >= S.cut) S.shuffleDue = true;
    if (faceUp) S.running += hiLo(c);
    return { c, id: ++S.serial };
  }
  /** Composition des cartes encore inconnues du joueur (sabot + carte cachée). */
  function unseen() {
    const comp = new Array(11).fill(0);
    for (let i = S.pos; i < S.shoe.length; i++) comp[v1(S.shoe[i])]++;
    if (S.holeHidden && S.dealer[1]) comp[v1(S.dealer[1].c)]++;
    return comp;
  }

  // ---------------------------------------------------------------
  // IA : probabilités du croupier et espérance de chaque option
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

  function legalActions(h) {
    if (!h || h.done) return {};
    const two = h.cards.length === 2;
    return {
      hit: !h.splitAces,
      stand: true,
      double: two && !h.splitAces && Wallet.balance >= h.bet,
      split: two && S.hands.length < MAX_HANDS && !h.splitAces
        && v1(h.cards[0].c) === v1(h.cards[1].c) && Wallet.balance >= h.bet,
      surrender: two && S.hands.length === 1 && !h.split,
    };
  }

  function adviceFor(h) {
    if (!h || h.done || !S.dealer[0]) return null;
    const L = legalActions(h);
    return playerEV(h.cards.map((x) => v1(x.c)), v1(S.dealer[0].c), unseen(), {
      canHit: L.hit, canDouble: L.double, canSplit: L.split, canSurrender: L.surrender,
    });
  }

  // ---------------------------------------------------------------
  // Déroulement d'une main
  // ---------------------------------------------------------------
  const cur = () => S.hands[S.active];
  const newHand = (bet) => ({ cards: [], bet, done: false, doubled: false, split: false, splitAces: false, surrendered: false, result: null, payout: 0 });

  function clearIfShowing() {
    if (!S.showingResult) return;
    S.showingResult = false;
    S.hands = [];
    S.dealer = [];
    S.insurance = 0;
  }

  async function deal() {
    if (S.phase !== 'betting' || S.busy) return;
    clearIfShowing();
    if (S.bet <= 0) { toast('Posez d’abord une mise.'); return; }
    S.busy = true;
    if (S.shuffleDue) {
      newShoe();
      say('Je mélange un nouveau sabot de 6 jeux…');
      render();
      Sound.flip();
      await sleep(1000);
    }
    S.phase = 'dealing';
    S.lastBet = S.bet;
    S.hands = [newHand(S.bet)];
    S.bet = 0;
    S.active = 0;
    S.dealer = [];
    S.holeHidden = true;
    S.insurance = 0;
    say(pick(LINES.deal));
    render();
    const steps = [() => S.hands[0].cards.push(draw()), () => S.dealer.push(draw()),
      () => S.hands[0].cards.push(draw()), () => S.dealer.push(draw(false))];
    for (const step of steps) {
      await sleep(330);
      step();
      Sound.card();
      render();
    }
    await sleep(350);

    const up = v1(S.dealer[0].c);
    if (up === 1 && Wallet.balance >= S.hands[0].bet / 2) {
      S.phase = 'insurance';
      S.busy = false;
      say(isBJ(S.hands[0])
        ? 'Blackjack ! Mais j’ai un as : voulez-vous l’égalité (assurance) ?'
        : 'J’ai un as. Souhaitez-vous prendre l’assurance ?');
      render();
      return;
    }
    await afterInsurance();
  }

  async function insurance(take) {
    if (S.phase !== 'insurance' || S.busy) return;
    S.busy = true;
    if (take) {
      const amt = S.hands[0].bet / 2;
      if (Wallet.take(amt)) { S.insurance = amt; Sound.chip(); }
    }
    await afterInsurance();
  }

  async function afterInsurance() {
    S.phase = 'dealing';
    const up = v1(S.dealer[0].c);
    if (up === 1 || up === 10) {
      say('Je vérifie ma carte cachée…');
      render();
      await sleep(900);
      if (dealerHasBJ()) {
        await revealHole();
        say(S.insurance ? 'Blackjack du croupier. Votre assurance paie 2 contre 1.' : 'Blackjack du croupier.');
        return settle();
      }
      say(S.insurance ? 'Pas de blackjack : l’assurance est perdue. À vous.' : 'Pas de blackjack. À vous de jouer.');
    }
    if (isBJ(S.hands[0])) {
      S.hands[0].done = true;
      await revealHole();
      return settle();
    }
    S.phase = 'playing';
    S.busy = false;
    if (up !== 1 && up !== 10) say('À vous de jouer.');
    render();
  }

  async function act(kind) {
    if (S.phase !== 'playing' || S.busy) return;
    const h = cur();
    const L = legalActions(h);
    if (!L[kind]) return;
    const adv = adviceFor(h);
    S.busy = true;
    commentChoice(kind, adv);

    if (kind === 'hit') {
      h.cards.push(draw());
      Sound.card();
      render();
      await sleep(380);
      const t = handTotal(h.cards).t;
      if (t > 21) { h.done = true; say(pick(LINES.bust)); await sleep(550); return next(); }
      if (t === 21) { h.done = true; await sleep(250); return next(); }
      S.busy = false;
      render();
      return;
    }
    if (kind === 'stand') { h.done = true; return next(); }
    if (kind === 'double') {
      Wallet.take(h.bet);
      h.bet *= 2;
      h.doubled = true;
      Sound.chip();
      h.cards.push(draw());
      Sound.card();
      render();
      await sleep(500);
      h.done = true;
      if (handTotal(h.cards).t > 21) { say(pick(LINES.bust)); await sleep(450); }
      return next();
    }
    if (kind === 'split') {
      Wallet.take(h.bet);
      const aces = v1(h.cards[0].c) === 1;
      const nh = newHand(h.bet);
      nh.cards.push(h.cards.pop());
      nh.split = true;
      nh.splitAces = aces;
      h.split = true;
      h.splitAces = aces;
      S.hands.splice(S.active + 1, 0, nh);
      Sound.chip();
      render();
      await sleep(350);
      h.cards.push(draw());
      Sound.card();
      render();
      await sleep(380);
      if (aces) {
        nh.cards.push(draw());
        Sound.card();
        render();
        await sleep(380);
        h.done = true;
        nh.done = true;
        say('As séparés : une seule carte par main.');
        return next();
      }
      if (handTotal(h.cards).t === 21) { h.done = true; return next(); }
      S.busy = false;
      render();
      return;
    }
    if (kind === 'surrender') {
      h.surrendered = true;
      h.done = true;
      say('Vous abandonnez : je vous rends la moitié de la mise.');
      return next();
    }
  }

  async function next() {
    const i = S.hands.findIndex((x) => !x.done);
    if (i === -1) return dealerTurn();
    S.active = i;
    const h = S.hands[i];
    if (h.cards.length === 1) {
      render();
      await sleep(300);
      h.cards.push(draw());
      Sound.card();
      render();
      await sleep(380);
      if (handTotal(h.cards).t === 21) { h.done = true; return next(); }
    }
    S.busy = false;
    render();
  }

  async function revealHole() {
    if (!S.holeHidden) return;
    S.holeHidden = false;
    S.running += hiLo(S.dealer[1].c);
    Sound.flip();
    render();
    await sleep(600);
  }

  async function dealerTurn() {
    S.phase = 'dealer';
    S.busy = true;
    render();
    await sleep(300);
    await revealHole();
    const live = S.hands.some((h) => !h.surrendered && handTotal(h.cards).t <= 21);
    if (live) {
      while (handTotal(S.dealer).t < 17) {
        await sleep(700);
        S.dealer.push(draw());
        Sound.card();
        render();
      }
    }
    await sleep(500);
    settle();
  }

  function settle() {
    const d = handTotal(S.dealer).t;
    const dBJ = dealerHasBJ();
    const dBust = d > 21;
    let ret = 0;
    let staked = 0;
    let anyBJ = false;
    for (const h of S.hands) {
      staked += h.bet;
      const t = handTotal(h.cards).t;
      if (h.surrendered) { h.result = 'surrender'; h.payout = h.bet / 2; }
      else if (t > 21) { h.result = 'bust'; h.payout = 0; }
      else if (isBJ(h)) {
        h.result = dBJ ? 'push' : 'blackjack';
        h.payout = dBJ ? h.bet : h.bet * 2.5; // le blackjack paie 3 contre 2
        if (!dBJ) anyBJ = true;
      }
      else if (dBJ) { h.result = 'lose'; h.payout = 0; }
      else if (dBust || t > d) { h.result = 'win'; h.payout = h.bet * 2; }
      else if (t === d) { h.result = 'push'; h.payout = h.bet; }
      else { h.result = 'lose'; h.payout = 0; }
      ret += h.payout;
      const st = S.stats;
      if (h.result === 'win' || h.result === 'blackjack') st.wins++;
      else if (h.result === 'push') st.pushes++;
      else st.losses++;
      if (h.result === 'blackjack') st.bj++;
    }
    if (S.insurance) {
      staked += S.insurance;
      if (dBJ) ret += S.insurance * 3; // l'assurance paie 2 contre 1
    }
    Wallet.give(ret);
    const net = Math.round((ret - staked) * 100) / 100;
    S.lastNet = net;
    S.stats.rounds++;
    S.stats.net += net;

    if (anyBJ) say(pick(LINES.playerBJ));
    else if (dBust && S.hands.some((h) => h.result === 'win')) say(pick(LINES.dealerBust));
    else if (dBJ && !S.insurance) say('Blackjack du croupier, la banque gagne.');
    else if (net > 0) say(pick(LINES.win));
    else if (net < 0 && !S.hands.every((h) => h.result === 'bust' || h.result === 'surrender')) say(pick(LINES.lose));
    else if (net === 0) say(pick(LINES.push));
    if (net > 0) Sound.win();
    if (S.shuffleDue) setTimeout(() => { if (S.showingResult) say('La carte de coupe est sortie : je mélangerai avant la prochaine donne.'); }, 1800);

    S.phase = 'betting';
    S.showingResult = true;
    S.busy = false;
    render();

    if (Wallet.balance < 1) {
      setTimeout(() => {
        if (S.phase !== 'betting' || Wallet.balance >= 1 || S.bet > 0) return;
        infoBox('Plus de jetons',
          '<p>Votre portefeuille est vide. Retournez au hall : vous pourrez le recharger à la caisse si vous souhaitez continuer.</p>',
          'Retour au hall').then(() => { if (S.phase === 'betting') leave(); });
      }, 1600);
    }
  }

  /** Le croupier commente un choix nettement moins bon que l'optimum. */
  function commentChoice(kind, adv) {
    if (!adv || adv.best === kind || adv.ev[kind] === undefined) return;
    const loss = adv.ev[adv.best] - adv.ev[kind];
    if (loss < 0.03) return;
    say(`Remarque : ${ACT_VERB[adv.best]} était meilleur ici (≈ ${pct(loss)} de la mise en moyenne).`);
  }

  // ---------------------------------------------------------------
  // Mises
  // ---------------------------------------------------------------
  function placeChip(v = S.chip) {
    if (S.phase !== 'betting' || S.busy) return;
    clearIfShowing();
    if (v > Wallet.balance) { toast('Solde insuffisant pour ce jeton.'); render(); return; }
    if (S.bet + v > MAX_BET) { toast(`Mise maximale : ${money(MAX_BET)}.`); return; }
    Wallet.take(v);
    S.bet += v;
    Sound.chip();
    render();
  }
  function clearBet() {
    if (S.phase !== 'betting' || S.busy) return;
    clearIfShowing();
    if (S.bet) Wallet.give(S.bet);
    S.bet = 0;
    render();
  }
  function rebet() {
    if (S.phase !== 'betting' || S.busy || !S.lastBet) return;
    clearIfShowing();
    const add = S.lastBet - S.bet;
    if (add <= 0) { render(); return; }
    if (add > Wallet.balance) { toast('Solde insuffisant pour remiser.'); render(); return; }
    Wallet.take(add);
    S.bet = S.lastBet;
    Sound.chip();
    render();
  }

  // ---------------------------------------------------------------
  // Affichage
  // ---------------------------------------------------------------
  function cardsHtml(list, hideHole) {
    return list.map((x, i) => {
      const hidden = hideHole && i === 1;
      const anim = !seen.has(x.id);
      let cls = '';
      if (!hidden && i === 1 && !flipped.has(x.id) && seen.has(x.id) && list === S.dealer) { cls = 'flip'; flipped.add(x.id); }
      seen.add(x.id);
      return Cards.html(hidden ? null : x.c, { anim, cls });
    }).join('');
  }

  function totalLabel(cards, final) {
    const t = handTotal(cards);
    if (t.soft && t.t < 21 && !final) return `${t.t - 10} / ${t.t}`;
    return String(t.t);
  }

  const RESULT_FR = {
    win: ['Gagné', 'pos'], blackjack: ['Blackjack !', 'pos'], push: ['Égalité', ''],
    lose: ['Perdu', 'neg'], bust: ['Dépassé', 'neg'], surrender: ['Abandon', 'neg'],
  };

  function render() {
    if (!$('#blackjack').classList.contains('active') && S.phase === 'closed') return;
    // En-tête
    const onTable = S.phase === 'betting' && !S.showingResult
      ? S.bet
      : S.hands.reduce((a, h) => a + h.bet, 0) + S.insurance + (S.showingResult ? S.bet : 0);
    $('#bjBalance').textContent = money(Wallet.balance);
    $('#bjBet').textContent = money(S.phase === 'betting' ? S.bet : onTable);
    const ln = $('#bjLast');
    ln.textContent = S.lastNet === null ? '—' : signed(S.lastNet);
    ln.className = S.lastNet === null ? '' : netClass(S.lastNet);

    // Croupier
    $('#bjDealerCards').innerHTML = cardsHtml(S.dealer, S.holeHidden);
    const dt = $('#bjDealerTotal');
    if (!S.dealer.length) dt.textContent = '';
    else if (S.holeHidden) dt.textContent = String(handTotal([S.dealer[0]]).t);
    else {
      const t = handTotal(S.dealer).t;
      dt.textContent = dealerHasBJ() ? 'Blackjack' : t > 21 ? `${t} · saute` : String(t);
    }
    dt.hidden = !S.dealer.length;

    // Sabot
    const left = S.shoe.length ? S.shoe.length - S.pos : DECKS * 52;
    const used = S.shoe.length ? S.pos / S.shoe.length : 0;
    $('#bjShoe').innerHTML = `<div class="shoe-box"><i style="height:${Math.round((1 - used) * 100)}%"></i></div>`
      + `<span>Sabot<br><b>${left}</b> cartes</span>`;

    // Mains du joueur
    $('#bjHands').innerHTML = S.hands.map((h, i) => {
      const active = S.phase === 'playing' && i === S.active;
      const res = h.result ? RESULT_FR[h.result] : null;
      const resHtml = res
        ? `<span class="bj-res ${res[1]}">${res[0]}${h.payout && h.result !== 'push' ? ' · ' + money(h.payout) : ''}</span>` : '';
      return `<div class="bj-hand${active ? ' active' : ''}${h.result ? ' done-' + h.result : ''}">
          <div class="bj-cards">${cardsHtml(h.cards, false)}</div>
          <div class="bj-hand-info">
            <span class="bj-total">${h.cards.length ? totalLabel(h.cards, h.done) : ''}</span>
            <span class="bj-hand-bet">${money(h.bet)}${h.doubled ? ' · doublée' : ''}</span>
            ${resHtml}
          </div>
        </div>`;
    }).join('');

    // Cercle de mise
    const spot = $('#bjSpot');
    const showSpot = S.phase === 'betting';
    spot.hidden = !showSpot;
    spot.innerHTML = S.bet > 0
      ? `<div class="chip-stack big ${chipClass(S.bet)}">${shortAmount(S.bet)}</div><span class="spot-label">${money(S.bet)}</span>`
      : '<span class="spot-label">Misez ici</span>';

    // Commandes
    const betting = S.phase === 'betting';
    $('#bjBetControls').hidden = !betting;
    $('#bjInsControls').hidden = S.phase !== 'insurance';
    $('#bjPlayControls').hidden = !(S.phase === 'playing' || S.phase === 'dealer' || S.phase === 'dealing');
    $('#bjDealBtn').disabled = S.busy || S.bet <= 0;
    $('#bjClearBtn').disabled = S.busy || S.bet <= 0;
    $('#bjRebetBtn').disabled = S.busy || !S.lastBet || S.bet >= S.lastBet || S.lastBet - S.bet > Wallet.balance;
    $('#bjRebetBtn').textContent = S.lastBet ? `Remiser ${money(S.lastBet)}` : 'Remiser';
    if (S.phase === 'insurance') $('#bjInsYes').textContent = `Assurance (${money(S.hands[0].bet / 2)})`;
    const L = S.phase === 'playing' && !S.busy ? legalActions(cur()) : {};
    for (const k of ['hit', 'stand', 'double', 'split', 'surrender']) $(`[data-bj="${k}"]`).disabled = !L[k];
    for (const b of $('#bjChips').children) {
      b.classList.toggle('selected', Number(b.dataset.value) === S.chip);
      b.classList.toggle('dim', Number(b.dataset.value) > Wallet.balance);
    }
    $('#bjLeaveBtn').disabled = !betting || S.busy;

    renderAdvice();
    renderCount();
    renderStats();
  }

  function renderAdvice() {
    const box = $('#bjAdvice');
    if (!$('#bjAdviceToggle').checked) {
      box.innerHTML = '<p class="muted small">Conseils masqués. Victor vous signalera quand même les erreurs coûteuses.</p>';
      return;
    }
    if (S.phase === 'insurance') {
      const comp = unseen();
      const tot = comp.reduce((a, b) => a + b, 0);
      const pTen = comp[10] / tot;
      const ev = 3 * pTen - 1;
      box.innerHTML = `<p>Probabilité que ma carte cachée vaille 10 : <b>${(pTen * 100).toFixed(1).replace('.', ',')} %</b>.</p>
        <p>L’assurance rapporte en moyenne <b class="${netClass(ev)}">${pct(ev)}</b> de son montant.</p>
        <p class="advice-best">${ev > 0 ? '✓ Prenez l’assurance : le sabot est riche en 10.' : '✗ Refusez l’assurance (elle n’est rentable que si plus d’1 carte sur 3 vaut 10).'}</p>`;
      return;
    }
    if (S.phase === 'playing' && !S.busy) {
      const adv = adviceFor(cur());
      if (!adv) { box.innerHTML = ''; return; }
      const rows = Object.entries(adv.ev).sort((a, b) => b[1] - a[1]);
      const bestKey = adv.best;
      const second = rows.find(([k]) => k !== bestKey);
      let why = `Je vous conseille de <b>${ACT_VERB[bestKey]}</b>`;
      const abs = (x) => `${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
      if (second) why += ` : vous ${adv.ev[bestKey] >= 0 ? 'gagnez' : 'perdez'} en moyenne ${abs(adv.ev[bestKey])} de la mise, contre ${abs(second[1])} ${second[1] >= 0 ? 'de gain' : 'de perte'} en choisissant de ${ACT_VERB[second[0]]}.`;
      box.innerHTML = `<div class="ev-list">${rows.map(([k, v]) => `
          <div class="ev-row${k === bestKey ? ' best' : ''}">
            <span>${k === bestKey ? '✓ ' : ''}${ACT_FR[k]}</span>
            <span class="ev-bar"><i style="width:${Math.round(((v + 1) / 3) * 100)}%"></i></span>
            <b class="${netClass(v)}">${pct(v)}</b>
          </div>`).join('')}</div>
        <p class="small">${why}</p>
        <p class="muted small">Risque que je saute avec mon ${handTotal([S.dealer[0]]).t === 11 ? 'as' : handTotal([S.dealer[0]]).t} : <b>${(adv.bust * 100).toFixed(0)} %</b>. Calcul exact à partir des ${unseen().reduce((a, b) => a + b, 0)} cartes encore inconnues.</p>`;
      return;
    }
    if (S.phase === 'betting') {
      box.innerHTML = '<p class="small">Posez votre mise puis distribuez. Pendant la main, j’affiche ici l’espérance de gain de chaque option, calculée en direct sur les cartes qui restent dans le sabot.</p>';
      return;
    }
    box.innerHTML = '<p class="muted small">…</p>';
  }

  function renderCount() {
    const box = $('#bjCount');
    if (!$('#bjCountToggle').checked) {
      box.innerHTML = '<p class="muted small">Activez pour voir le comptage Hi-Lo des cartes sorties.</p>';
      return;
    }
    const unknown = (S.shoe.length ? S.shoe.length - S.pos : DECKS * 52) + (S.holeHidden && S.dealer[1] ? 1 : 0);
    const decks = Math.max(0.25, unknown / 52);
    const tc = S.running / decks;
    const edge = -0.0045 + 0.005 * tc;
    box.innerHTML = `<div class="count-grid">
        <div><span>Compte courant</span><b>${S.running > 0 ? '+' : ''}${S.running}</b></div>
        <div><span>Compte réel</span><b>${tc > 0 ? '+' : ''}${tc.toFixed(1).replace('.', ',')}</b></div>
        <div><span>Jeux restants</span><b>${decks.toFixed(1).replace('.', ',')}</b></div>
        <div><span>Avantage estimé</span><b class="${netClass(edge)}">${pct(edge, 2)}</b></div>
      </div>
      <p class="muted small">${tc >= 2 ? 'Le sabot est favorable au joueur : c’est le moment où un compteur augmente sa mise.' : tc <= -1 ? 'Sabot défavorable : beaucoup de 10 et d’as sont déjà sortis.' : 'Sabot neutre.'}</p>`;
  }

  function renderStats() {
    const st = S.stats;
    $('#bjStats').innerHTML = `<div class="count-grid">
        <div><span>Mains</span><b>${st.rounds}</b></div>
        <div><span>Gagnées</span><b>${st.wins}</b></div>
        <div><span>Perdues</span><b>${st.losses}</b></div>
        <div><span>Égalités</span><b>${st.pushes}</b></div>
        <div><span>Blackjacks</span><b>${st.bj}</b></div>
        <div><span>Bilan</span><b class="${netClass(st.net)}">${signed(st.net)}</b></div>
      </div>`;
  }

  // Jetons (mêmes couleurs qu'à la roulette)
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
  function buildChips() {
    const box = $('#bjChips');
    box.innerHTML = CHIP_VALUES.map((v) => `<button type="button" class="chip c${v}" data-value="${v}" aria-label="Jeton de ${money(v)}"><span>${v >= 1000 ? v / 1000 + 'k' : v}</span></button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      S.chip = Number(b.dataset.value);
      placeChip(S.chip);
    });
  }

  // ---------------------------------------------------------------
  // Entrée / sortie
  // ---------------------------------------------------------------
  function enter() {
    S.phase = 'betting';
    S.busy = false;
    if (!S.shoe.length) newShoe();
    if (!S.stats.rounds) say(pick(LINES.welcome));
    showScreen('blackjack');
    render();
  }
  function leave() {
    if (S.phase !== 'betting' || S.busy) { toast('Terminez d’abord la main en cours.'); return; }
    if (S.bet) { Wallet.give(S.bet); S.bet = 0; }
    clearIfShowing();
    S.phase = 'closed';
    backToHall();
  }

  // ---------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------
  buildChips();
  $('#bjSpot').addEventListener('click', () => placeChip(S.chip));
  $('#bjSpot').addEventListener('contextmenu', (e) => { e.preventDefault(); clearBet(); });
  $('#bjDealBtn').addEventListener('click', deal);
  $('#bjClearBtn').addEventListener('click', clearBet);
  $('#bjRebetBtn').addEventListener('click', rebet);
  $('#bjInsYes').addEventListener('click', () => insurance(true));
  $('#bjInsNo').addEventListener('click', () => insurance(false));
  $('#bjPlayControls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bj]');
    if (b && !b.disabled) act(b.dataset.bj);
  });
  $('#bjLeaveBtn').addEventListener('click', leave);
  $('#bjRulesBtn').addEventListener('click', () => $('#bjRulesDlg').showModal());
  $('#bjAdviceToggle').addEventListener('change', render);
  $('#bjCountToggle').addEventListener('change', render);

  const KEYS = { t: 'hit', h: 'hit', r: 'stand', s: 'stand', d: 'double', p: 'split', a: 'surrender' };
  document.addEventListener('keydown', (e) => {
    if (!$('#blackjack').classList.contains('active') || document.querySelector('dialog[open]')) return;
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (S.phase === 'playing' && KEYS[k]) { e.preventDefault(); act(KEYS[k]); }
    else if (S.phase === 'betting' && (e.key === 'Enter' || e.code === 'Space')) { e.preventDefault(); if (!e.repeat) deal(); }
  });

  return { enter, leave, _test: { playerEV, dealerDist } };
})();
