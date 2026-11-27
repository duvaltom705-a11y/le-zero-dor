'use strict';

/* =================================================================
   Blackjack — interface de la table
   - solo : le moteur (blackjack-core.js) tourne dans ce navigateur
   - entre amis : jusqu'à 5 joueurs face à Victor ; le navigateur de
     l'hôte fait tourner la table, les invités reçoivent ce qu'ils
     ont le droit de voir (jamais la carte cachée ni le sabot).
   Le conseiller IA calcule ici, à partir des cartes déjà montrées,
   l'espérance de gain exacte de chaque option.
   ================================================================= */
const Blackjack = (() => {
  const BC = BlackjackCore;
  const { v1, handTotal, isBJ, playerEV } = BC;
  const CHIP_VALUES = BC.CHIP_VALUES;
  const ACT_FR = { hit: 'Tirer', stand: 'Rester', double: 'Doubler', split: 'Séparer', surrender: 'Abandonner' };
  const ACT_VERB = { hit: 'tirer', stand: 'rester', double: 'doubler', split: 'séparer', surrender: 'abandonner' };
  const pct = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d).replace('.', ',')} %`;
  const pick = (arr, i) => arr[(Number(i) || 0) % arr.length];
  const isCard = (c) => Number.isInteger(c) && c >= 0 && c < 52;

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
  const RESULT_FR = {
    win: ['Gagné', 'pos'], blackjack: ['Blackjack !', 'pos'], push: ['Égalité', ''],
    lose: ['Perdu', 'neg'], bust: ['Dépassé', 'neg'], surrender: ['Abandon', 'neg'],
  };

  let ctrl = null;      // { mode: 'solo' | 'host' | 'guest', send(m), leave() → Promise<{ stack } | { error }> }
  let view = null;
  let soloTable = null; // la table solo garde son sabot et ses statistiques d'une visite à l'autre
  let chip = 5;
  let seenIds = new Set();
  let hiddenIds = new Set();
  let flipped = new Set();
  let localSay = null;  // remarque du croupier sur un choix, affichée jusqu'à sa prochaine phrase
  let lastText = '';
  let lastSayId = -1;
  let deadlineAt = 0;
  let ticker = 0;
  let bustTimer = 0;
  let bustShown = false;
  let prevBet = 0;
  let prevMyTurn = false;

  const meOf = (v) => (v && v.you >= 0 ? v.seats[v.you] : null);
  const isNet = () => !!ctrl && ctrl.mode !== 'solo';
  const send = (m) => { if (ctrl) ctrl.send(m); };

  // ---------------------------------------------------------------
  // Paroles du croupier (le moteur envoie un code, on rédige ici)
  // ---------------------------------------------------------------
  function sayText(v) {
    const s = v.say || {};
    const me = meOf(v);
    const other = Number.isInteger(s.s) && s.s !== v.you && v.seats[s.s] ? v.seats[s.s].name : null;
    switch (s.k) {
      case 'welcome': return pick(LINES.welcome, s.i);
      case 'join': return other ? `${other} s’installe à la table. Bienvenue !` : pick(LINES.welcome, s.i);
      case 'leave': return s.name ? `${Net.cleanText(s.name, 16)} quitte la table.` : '';
      case 'chips': return other ? `${other} achète ${money(Number(s.a) || 0)} de jetons.` : `Voici vos ${money(Number(s.a) || 0)} de jetons. Bonne chance !`;
      case 'shuffle': return 'Je mélange un nouveau sabot de 6 jeux…';
      case 'deal': return pick(LINES.deal, s.i);
      case 'ins':
        return me && me.inRound && me.hands[0] && isBJ(me.hands[0])
          ? 'Blackjack ! Mais j’ai un as : voulez-vous l’égalité (assurance) ?'
          : 'J’ai un as. Souhaitez-vous prendre l’assurance ?';
      case 'peek': return 'Je vérifie ma carte cachée…';
      case 'turn': {
        const pre = s.pre ? (me && me.insurance ? 'Pas de blackjack : l’assurance est perdue. ' : 'Pas de blackjack. ') : '';
        return pre + (other ? `À ${other} de jouer.` : 'À vous de jouer.');
      }
      case 'bust': return other ? `${other} dépasse 21.` : pick(LINES.bust, s.i);
      case 'surrender': return other ? `${other} abandonne : je lui rends la moitié de sa mise.` : 'Vous abandonnez : je vous rends la moitié de la mise.';
      case 'splitAces': return 'As séparés : une seule carte par main.';
      case 'dealer': return 'À moi.';
      case 'settle': return settleText(v, s);
      case 'cut': return 'La carte de coupe est sortie : je mélangerai avant la prochaine donne.';
      default: return '';
    }
  }
  function settleText(v, s) {
    const me = meOf(v);
    if (me && me.hands.length && me.hands[0].result) {
      const hs = me.hands;
      const net = me.lastNet;
      if (s.dBJ) {
        if (me.insurance) return 'Blackjack du croupier. Votre assurance paie 2 contre 1.';
        if (hs.some((h) => h.result === 'push')) return 'Deux blackjacks : égalité, votre mise vous est rendue.';
        return 'Blackjack du croupier, la banque gagne.';
      }
      if (hs.some((h) => h.result === 'blackjack')) return pick(LINES.playerBJ, s.i);
      if (s.dBust && hs.some((h) => h.result === 'win')) return pick(LINES.dealerBust, s.i);
      if (net > 0) return pick(LINES.win, s.i);
      if (net < 0 && !hs.every((h) => h.result === 'bust' || h.result === 'surrender')) return pick(LINES.lose, s.i);
      if (net === 0) return LINES.push[0];
      return '';
    }
    if (s.dBJ) return 'Blackjack du croupier.';
    return s.dBust ? `Je saute avec ${s.d} !` : `La banque fait ${s.d}.`;
  }

  // ---------------------------------------------------------------
  // Conseiller IA (calcul exact sur les cartes encore inconnues)
  // ---------------------------------------------------------------
  /** Cartes inconnues par valeur : sabot complet moins les cartes déjà montrées. */
  function unseen(v) {
    const comp = new Array(11).fill(0);
    for (let x = 1; x <= 10; x++) comp[x] = Math.max(0, BC.FULL[x] - (Number(v.seen[x]) || 0));
    return comp;
  }
  function activeHand(v) {
    const me = meOf(v);
    if (!me || !v.turn || v.turn.seat !== v.you) return null;
    return me.hands[v.turn.hand] || null;
  }
  function adviceFor(v) {
    const L = v.me && v.me.legal;
    const h = activeHand(v);
    if (!L || !h || !v.dealer[0] || !isCard(v.dealer[0].c)) return null;
    return playerEV(h.cards.map((x) => v1(x.c)), v1(v.dealer[0].c), unseen(v), {
      canHit: L.hit, canDouble: L.double, canSplit: L.split, canSurrender: L.surrender,
    });
  }
  /** Le croupier commente un choix nettement moins bon que l'optimum. */
  function commentChoice(kind, adv) {
    if (!adv || adv.best === kind || adv.ev[kind] === undefined) return;
    const loss = adv.ev[adv.best] - adv.ev[kind];
    if (loss < 0.03) return;
    localSay = { text: `Remarque : ${ACT_VERB[adv.best]} était meilleur ici (≈ ${pct(loss)} de la mise en moyenne).`, id: view.say ? view.say.id : -1 };
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------
  function placeChip(value) {
    const v = view;
    const me = meOf(v);
    if (!me) return;
    if (v.phase !== 'betting') { toast('Attendez la fin de la main en cours.'); return; }
    if (value > me.stack + 1e-9) { toast('Solde insuffisant pour ce jeton.'); return; }
    if (me.bet + value > v.maxBet) { toast(`Mise maximale : ${money(v.maxBet)}.`); return; }
    send({ t: 'bet', amount: value });
  }
  function act(kind) {
    const v = view;
    if (!v || !v.me || !v.me.legal || !v.me.legal[kind]) return;
    commentChoice(kind, adviceFor(v));
    v.me.legal = null; // évite les doubles clics en attendant la réponse
    send({ t: 'act', kind });
    render();
  }
  function ready() {
    const me = meOf(view);
    if (!me || view.phase !== 'betting') return;
    if (me.bet <= 0) { toast('Posez d’abord une mise.'); return; }
    if (!me.ready) send({ t: 'ready' });
  }

  // ---------------------------------------------------------------
  // Affichage
  // ---------------------------------------------------------------
  let newCards = 0;
  let flipNow = false;
  function cardsHtml(list) {
    return list.map((x) => {
      const id = Number(x.id);
      const known = isCard(x.c);
      const anim = !seenIds.has(id);
      if (anim) { seenIds.add(id); newCards++; }
      let cls = '';
      if (!known) hiddenIds.add(id);
      else if (hiddenIds.has(id) && !flipped.has(id)) { cls = 'flip'; flipped.add(id); flipNow = true; }
      return Cards.html(known ? x.c : null, { anim, cls });
    }).join('');
  }
  function totalLabel(cards, final) {
    const t = handTotal(cards);
    if (t.soft && t.t < 21 && !final) return `${t.t - 10} / ${t.t}`;
    return String(t.t);
  }
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
  const hueOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

  function onView(v) {
    view = v;
    deadlineAt = v.deadlineMs ? performance.now() + Number(v.deadlineMs) : 0;
    render();
  }

  function render() {
    if (!view || !ctrl) return;
    const v = view;
    const me = meOf(v);
    newCards = 0;
    flipNow = false;

    // En-tête
    const committed = me ? (v.phase === 'betting' ? me.bet : me.hands.reduce((a, h) => a + h.bet, 0) + me.insurance) : 0;
    $('#bjBalanceLabel').textContent = isNet() ? 'Tapis' : 'Solde';
    $('#bjBalance').textContent = me ? money(me.stack) : '—';
    $('#bjBet').textContent = money(committed);
    const ln = $('#bjLast');
    const last = me ? me.lastNet : null;
    ln.textContent = last === null || last === undefined ? '—' : signed(last);
    ln.className = last === null || last === undefined ? '' : netClass(last);

    // Croupier
    $('#bjDealerCards').innerHTML = cardsHtml(v.dealer);
    const dt = $('#bjDealerTotal');
    const dk = v.dealer.filter((x) => isCard(x.c));
    if (!v.dealer.length) dt.textContent = '';
    else if (v.holeHidden) dt.textContent = dk.length ? String(handTotal([dk[0]]).t) : '';
    else {
      const t = handTotal(dk).t;
      dt.textContent = dk.length === 2 && t === 21 ? 'Blackjack' : t > 21 ? `${t} · saute` : String(t);
    }
    dt.hidden = !v.dealer.length;

    // Sabot
    const left = Number(v.shoeLeft) || 0;
    const used = v.shoeSize ? 1 - left / v.shoeSize : 0;
    $('#bjShoe').innerHTML = `<div class="shoe-box"><i style="height:${Math.round((1 - used) * 100)}%"></i></div>`
      + `<span>Sabot<br><b>${left}</b> cartes</span>`;

    renderSeats(v);
    renderControls(v, me);
    renderSay(v, me);
    renderAdvice(v);
    renderCount(v);
    renderStats(v);
    if (isNet()) Net.updatePanel(v.room);
    tick();

    // Sons
    if (flipNow) Sound.flip();
    else if (newCards) Sound.card();
    if (me && me.bet > prevBet) Sound.chip();
    prevBet = me ? me.bet : 0;
    const myTurn = !!(v.me && v.me.legal);
    if (myTurn && !prevMyTurn && isNet()) Sound.turn();
    prevMyTurn = myTurn;
    checkBust(v, me);
  }

  function renderSeats(v) {
    const list = [];
    v.seats.forEach((p, i) => { if (p) list.push([p, i]); });
    const box = $('#bjSeats');
    box.className = `bj-seats n${Math.max(1, list.length)}${isNet() ? ' multi' : ''}`;
    box.innerHTML = list.map(([p, i]) => seatHtml(v, p, i)).join('');
  }

  function seatHtml(v, p, i) {
    const you = i === v.you;
    const turnSeat = v.phase === 'playing' && v.turn && v.turn.seat === i;
    const hands = p.hands.map((h, k) => {
      const active = turnSeat && v.turn.hand === k;
      const res = h.result ? RESULT_FR[h.result] : null;
      const resHtml = res
        ? `<span class="bj-res ${res[1]}">${res[0]}${h.payout && h.result !== 'push' ? ' · ' + money(Number(h.payout)) : ''}</span>` : '';
      return `<div class="bj-hand${active ? ' active' : ''}${h.result ? ' done-' + esc(h.result) : ''}">
          <div class="bj-cards">${cardsHtml(h.cards)}</div>
          <div class="bj-hand-info">
            <span class="bj-total">${h.cards.length ? totalLabel(h.cards, h.done) : ''}</span>
            <span class="bj-hand-bet">${money(Number(h.bet))}${h.doubled ? ' · doublée' : ''}</span>
            ${resHtml}
          </div>
        </div>`;
    }).join('');

    let spot = '';
    if (v.phase === 'betting' || p.bet > 0) {
      const inner = p.bet > 0
        ? `<div class="chip-stack big ${chipClass(p.bet)}">${shortAmount(p.bet)}</div><span class="spot-label">${money(p.bet)}</span>`
        : `<span class="spot-label">${you ? 'Misez ici' : ''}</span>`;
      spot = you && v.phase === 'betting'
        ? `<button type="button" class="bj-spot" data-spot aria-label="Cercle de mise">${inner}</button>`
        : `<div class="bj-spot other">${inner}</div>`;
    }

    let plate = '';
    if (isNet()) {
      let tag = '';
      if (!p.connected) tag = '<span class="np-tag off">déconnecté</span>';
      else if (v.phase === 'betting' && p.ready) tag = '<span class="np-tag ok">prêt</span>';
      else if (p.insurance > 0) tag = '<span class="np-tag">assuré</span>';
      else if (v.phase === 'insurance' && p.inRound && !p.insDecided) tag = '<span class="np-tag">réfléchit…</span>';
      else if (v.showing && p.hands.length && typeof p.lastNet === 'number') tag = `<span class="np-tag ${netClass(p.lastNet)}">${signed(p.lastNet)}</span>`;
      const name = String(p.name || '');
      plate = `<div class="bj-plate">
          <span class="pk-avatar" style="--hue:${hueOf(name)}">${esc(name.charAt(0).toUpperCase())}</span>
          <span class="bj-pid"><b>${esc(name)}${you ? ' <small>(vous)</small>' : ''}</b><span>${money(Number(p.stack) || 0)}</span></span>
          ${tag}
          ${turnSeat && v.awaiting && v.deadlineFor === 'turn' ? '<div class="bj-timer"><i></i></div>' : ''}
        </div>`;
    }
    return `<div class="bj-seat${you ? ' you' : ''}${turnSeat ? ' turn' : ''}${p.connected ? '' : ' offline'}">
        <div class="bj-hands">${hands}</div>${spot}${plate}
      </div>`;
  }

  function renderControls(v, me) {
    const betting = v.phase === 'betting' && !!me;
    const canIns = !!(v.me && v.me.canInsure);
    const inPlay = !!me && me.inRound && !canIns && ['dealing', 'insurance', 'playing', 'dealer'].includes(v.phase);
    $('#bjBetControls').hidden = !betting;
    $('#bjInsControls').hidden = !canIns;
    $('#bjPlayControls').hidden = !inPlay;

    let wait = '';
    if (!me) wait = 'Vous n’êtes pas assis à cette table.';
    else if (!betting && !canIns && !inPlay) {
      if (v.phase === 'settle') wait = 'Prochaine donne dans un instant…';
      else wait = 'Main en cours : vous jouerez à la prochaine donne.';
    }
    const w = $('#bjWait');
    w.textContent = wait;
    w.hidden = !wait;

    if (betting) {
      const deal = $('#bjDealBtn');
      deal.textContent = isNet() ? (me.ready ? 'Prêt ✓' : 'Je suis prêt') : 'Distribuer';
      deal.disabled = me.bet <= 0 || me.ready;
      $('#bjClearBtn').disabled = me.bet <= 0;
      const lb = v.me ? v.me.lastBet : 0;
      const rb = $('#bjRebetBtn');
      rb.disabled = !lb || me.bet >= lb || lb - me.bet > me.stack;
      rb.textContent = lb ? `Remiser ${money(lb)}` : 'Remiser';
      for (const b of $('#bjChips').children) {
        b.classList.toggle('selected', Number(b.dataset.value) === chip);
        b.classList.toggle('dim', Number(b.dataset.value) > me.stack);
      }
      $('#bjBetHint').innerHTML = isNet()
        ? '<span class="only-mouse">Cliquez sur un jeton ou sur votre cercle pour miser · Clic droit sur le cercle&nbsp;: effacer</span><span class="only-touch">Touchez un jeton ou votre cercle pour miser · Appui long sur le cercle&nbsp;: effacer</span> · La donne part quand tous les joueurs sont prêts'
        : '<span class="only-mouse">Cliquez sur un jeton ou sur le cercle pour miser · Clic droit sur le cercle&nbsp;: effacer · <kbd>Entrée</kbd>&nbsp;: distribuer</span><span class="only-touch">Touchez un jeton ou le cercle pour miser · Appui long sur le cercle&nbsp;: effacer</span>';
    }
    if (canIns) $('#bjInsYes').textContent = `Assurance (${money(me.hands[0].bet / 2)})`;
    const L = (v.me && v.me.legal) || {};
    for (const k of ['hit', 'stand', 'double', 'split', 'surrender']) $(`[data-bj="${k}"]`).disabled = !L[k];
    // L'hôte peut fermer la table à tout moment (la main en cours est alors annulée)
    $('#bjLeaveBtn').disabled = !!me && me.inRound && ctrl.mode !== 'host';
  }

  function renderSay(v, me) {
    if (v.say && v.say.id !== lastSayId) {
      lastSayId = v.say.id;
      if (v.say.k === 'settle' && me && me.hands.length && me.lastNet > 0) Sound.win();
    }
    let text = '';
    if (localSay && v.say && v.say.id === localSay.id) text = localSay.text;
    else { localSay = null; text = sayText(v); }
    if (text && text !== lastText) {
      lastText = text;
      $('#bjSay').textContent = text;
    }
  }

  function renderAdvice(v) {
    const box = $('#bjAdvice');
    if (!$('#bjAdviceToggle').checked) {
      box.innerHTML = '<p class="muted small">Conseils masqués. Victor vous signalera quand même les erreurs coûteuses.</p>';
      return;
    }
    if (v.me && v.me.canInsure) {
      const comp = unseen(v);
      const tot = comp.reduce((a, b) => a + b, 0);
      const pTen = comp[10] / tot;
      const ev = 3 * pTen - 1;
      box.innerHTML = `<p>Probabilité que ma carte cachée vaille 10 : <b>${(pTen * 100).toFixed(1).replace('.', ',')} %</b>.</p>
        <p>L’assurance rapporte en moyenne <b class="${netClass(ev)}">${pct(ev)}</b> de son montant.</p>
        <p class="advice-best">${ev > 0 ? '✓ Prenez l’assurance : le sabot est riche en 10.' : '✗ Refusez l’assurance (elle n’est rentable que si plus d’1 carte sur 3 vaut 10).'}</p>`;
      return;
    }
    const adv = adviceFor(v);
    if (adv) {
      const rows = Object.entries(adv.ev).sort((a, b) => b[1] - a[1]);
      const bestKey = adv.best;
      const second = rows.find(([k]) => k !== bestKey);
      const abs = (x) => `${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`;
      let why = `Je vous conseille de <b>${ACT_VERB[bestKey]}</b>`;
      if (second) why += ` : vous ${adv.ev[bestKey] >= 0 ? 'gagnez' : 'perdez'} en moyenne ${abs(adv.ev[bestKey])} de la mise, contre ${abs(second[1])} ${second[1] >= 0 ? 'de gain' : 'de perte'} en choisissant de ${ACT_VERB[second[0]]}.`;
      const up = handTotal([v.dealer[0]]).t;
      box.innerHTML = `<div class="ev-list">${rows.map(([k, x]) => `
          <div class="ev-row${k === bestKey ? ' best' : ''}">
            <span>${k === bestKey ? '✓ ' : ''}${ACT_FR[k]}</span>
            <span class="ev-bar"><i style="width:${Math.round(((x + 1) / 3) * 100)}%"></i></span>
            <b class="${netClass(x)}">${pct(x)}</b>
          </div>`).join('')}</div>
        <p class="small">${why}</p>
        <p class="muted small">Risque que je saute avec mon ${up === 11 ? 'as' : up} : <b>${(adv.bust * 100).toFixed(0)} %</b>. Calcul exact à partir des ${unseen(v).reduce((a, b) => a + b, 0)} cartes encore inconnues.</p>`;
      return;
    }
    if (v.phase === 'betting') {
      box.innerHTML = isNet()
        ? '<p class="small">Posez votre mise puis cliquez sur « Je suis prêt ». Pendant votre tour, j’affiche ici l’espérance de gain de chaque option, calculée en direct sur les cartes qui restent dans le sabot.</p>'
        : '<p class="small">Posez votre mise puis distribuez. Pendant la main, j’affiche ici l’espérance de gain de chaque option, calculée en direct sur les cartes qui restent dans le sabot.</p>';
      return;
    }
    box.innerHTML = '<p class="muted small">…</p>';
  }

  function renderCount(v) {
    const box = $('#bjCount');
    if (!$('#bjCountToggle').checked) {
      box.innerHTML = '<p class="muted small">Activez pour voir le comptage Hi-Lo des cartes sorties.</p>';
      return;
    }
    let running = 0;
    for (let x = 1; x <= 10; x++) running += (Number(v.seen[x]) || 0) * BC.hiLoV(x);
    const unknown = (Number(v.shoeLeft) || 0) + (v.holeHidden && v.dealer.length > 1 ? 1 : 0);
    const decks = Math.max(0.25, unknown / 52);
    const tc = running / decks;
    const edge = -0.0045 + 0.005 * tc;
    box.innerHTML = `<div class="count-grid">
        <div><span>Compte courant</span><b>${running > 0 ? '+' : ''}${running}</b></div>
        <div><span>Compte réel</span><b>${tc > 0 ? '+' : ''}${tc.toFixed(1).replace('.', ',')}</b></div>
        <div><span>Jeux restants</span><b>${decks.toFixed(1).replace('.', ',')}</b></div>
        <div><span>Avantage estimé</span><b class="${netClass(edge)}">${pct(edge, 2)}</b></div>
      </div>
      <p class="muted small">${tc >= 2 ? 'Le sabot est favorable au joueur : c’est le moment où un compteur augmente sa mise.' : tc <= -1 ? 'Sabot défavorable : beaucoup de 10 et d’as sont déjà sortis.' : 'Sabot neutre.'}</p>`;
  }

  function renderStats(v) {
    const st = (v.me && v.me.stats) || { rounds: 0, wins: 0, losses: 0, pushes: 0, bj: 0, net: 0 };
    $('#bjStats').innerHTML = `<div class="count-grid">
        <div><span>Mains</span><b>${Number(st.rounds) || 0}</b></div>
        <div><span>Gagnées</span><b>${Number(st.wins) || 0}</b></div>
        <div><span>Perdues</span><b>${Number(st.losses) || 0}</b></div>
        <div><span>Égalités</span><b>${Number(st.pushes) || 0}</b></div>
        <div><span>Blackjacks</span><b>${Number(st.bj) || 0}</b></div>
        <div><span>Bilan</span><b class="${netClass(st.net)}">${signed(Number(st.net) || 0)}</b></div>
      </div>`;
  }

  /** Compte à rebours (mise, assurance, tour de jeu) : mis à jour plusieurs fois par seconde. */
  function tick() {
    const v = view;
    if (!v) return;
    const total = (v.times && v.times[v.deadlineFor]) || 0;
    const left = deadlineAt ? Math.max(0, deadlineAt - performance.now()) : 0;
    const frac = total ? clamp(left / total, 0, 1) : 0;
    for (const bar of $$('#blackjack .bj-timer i')) {
      bar.style.width = `${frac * 100}%`;
      bar.classList.toggle('late', left < 8000);
    }
    const line = $('#bjTimerLine');
    let txt = '';
    if (deadlineAt && left > 0) {
      const s = Math.ceil(left / 1000);
      if (v.deadlineFor === 'bet') txt = `Distribution dans ${s} s`;
      else if (v.deadlineFor === 'ins') txt = `Décision d’assurance : ${s} s`;
      else if (v.deadlineFor === 'turn' && v.me && v.me.legal) txt = `À vous : ${s} s pour jouer, sinon vous restez`;
    }
    line.textContent = txt;
    line.hidden = !txt;
  }

  function checkBust(v, me) {
    const broke = me && me.stack < 1 && me.bet <= 0 && !me.inRound && v.phase === 'betting';
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
      if (!ctrl || !m || m.stack >= 1 || m.bet > 0 || m.inRound || document.querySelector('dialog[open]')) return;
      bustShown = true;
      if (!isNet()) {
        if (await confirmBox('Plus de jetons', '<p>Vous n’avez plus de jetons. Ajoutez-en à la caisse pour continuer à jouer, ou retournez au hall.</p>', 'Ajouter des jetons', 'Retour au hall')) openCash();
        else leave(true);
      } else if (await confirmBox('Plus de jetons', '<p>Vous n’avez plus de jetons à cette table. Vous pouvez en ajouter sans quitter la partie.</p>', 'Ajouter des jetons', 'Plus tard')) {
        openCash();
      }
    }, 1600);
  }

  // ---------------------------------------------------------------
  // Ouverture d'une table
  // ---------------------------------------------------------------
  function resetSession() {
    view = null;
    seenIds = new Set();
    hiddenIds = new Set();
    flipped = new Set();
    localSay = null;
    lastText = '';
    lastSayId = -1;
    prevBet = 0;
    prevMyTurn = false;
    bustShown = false;
    clearTimeout(bustTimer);
    bustTimer = 0;
  }
  function openTable(stack) {
    if (!chip || chip > stack) chip = Math.max(1, CHIP_VALUES.filter((c) => c <= stack / 20).pop() || 1);
    if (isNet()) Net.mountPanel($('#bjNetSlot'), ctrl);
    else Net.hidePanel();
    showScreen('blackjack');
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

  /** Blackjack en solo : le portefeuille entier est apporté à la table. */
  function enter() {
    if (!soloTable) {
      soloTable = new BC.Table({
        seats: 1,
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
        return s === null ? { error: 'Terminez d’abord la main en cours.' } : { stack: s };
      },
    };
    resetSession();
    soloTable.addPlayer({ id: 'me', name: 'Vous', stack });
    openTable(stack);
  }

  /** Table entre amis : ce navigateur fait tourner la table et distribue les cartes. */
  function startHost(peer, code, cfg) {
    let room = null;
    const table = new BC.Table({
      seats: 5, betTime: 20000, turnTime: 30000, insTime: 15000, resultTime: 3500,
      onUpdate: () => { if (room) room.broadcast(); },
    });
    const game = {
      type: 'blackjack',
      info: () => {
        const n = table.players().length;
        return {
          detail: `${n} joueur${n > 1 ? 's' : ''} · mise de 1 € à ${money(table.o.maxBet)}`,
          free: table.seats.filter((s) => !s).length,
          buyIn: { min: 10, max: 100000, step: 1 },
        };
      },
      join: (id, name, stack) => (table.addPlayer({ id, name, stack }) < 0 ? 'La table est complète (5 joueurs).' : ''),
      view: (id) => table.view(id),
      handle: (id, m) => {
        if (m.t === 'add') { const e = table.addChips(id, m.amount); return { t: 'added', ok: !e, msg: e }; }
        const e = table.apply(id, m);
        return e ? { t: 'err', msg: e } : null;
      },
      setConnected: (id, ok) => table.setConnected(id, ok),
      leave: (id) => {
        const s = table.removePlayer(id);
        return s === null ? { error: 'Terminez d’abord la main en cours.' } : { stack: s };
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
    table.addPlayer({ id: 'host', name: cfg.name, stack: cfg.buyIn }, 2);
    openTable(cfg.buyIn);
  }

  /** Invité : la table tourne chez l'hôte. */
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
    const me = meOf(view);
    const c = ctrl;
    if (me && me.inRound && c.mode !== 'host') { toast('Terminez d’abord la main en cours.'); return; }
    if (c.mode !== 'solo' && !skipConfirm) {
      const inHand = me && me.inRound ? me.hands.reduce((a, h) => a + h.bet, 0) + me.insurance : 0;
      const total = me ? me.stack + me.bet + inHand : 0;
      let html = `<p>Vous repartez avec <b>${money(total)}</b>${me && (me.bet || inHand) ? ' (vos mises vous sont rendues)' : ''}.</p>`;
      if (c.mode === 'host') {
        html += c.room.guestCount() > 0
          ? '<p><b>Vous êtes l’hôte :</b> la table sera fermée, la main en cours annulée et chaque joueur récupérera ses jetons.</p>'
          : '<p class="muted">La table sera fermée.</p>';
      }
      if (!(await confirmBox(c.mode === 'host' ? 'Fermer la table ?' : 'Quitter la table ?', html, 'Quitter la table', 'Rester'))) return;
      if (ctrl !== c) return;
    }
    const r = await c.leave();
    if (r.error) { toast(r.error); return; }
    if (ctrl !== c) return;
    closeSession();
    if (r.stack > 0) Wallet.give(r.stack);
    if (c.mode !== 'solo') toast(`Vous repartez avec ${money(r.stack)}.`, 'ok');
    backToHall();
  }

  // ---------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------
  function buildChips() {
    const box = $('#bjChips');
    box.innerHTML = CHIP_VALUES.map((v) => `<button type="button" class="chip c${v}" data-value="${v}" aria-label="Jeton de ${money(v)}"><span>${v >= 1000 ? v / 1000 + 'k' : v}</span></button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      chip = Number(b.dataset.value);
      placeChip(chip);
    });
  }
  buildChips();
  $('#bjSeats').addEventListener('click', (e) => { if (e.target.closest('[data-spot]')) placeChip(chip); });
  $('#bjSeats').addEventListener('contextmenu', (e) => {
    if (!e.target.closest('[data-spot]')) return;
    e.preventDefault();
    send({ t: 'clear' });
  });
  longPress($('#bjSeats'), '[data-spot]', () => send({ t: 'clear' })); // au doigt : appui long = effacer
  $('#bjDealBtn').addEventListener('click', ready);
  $('#bjClearBtn').addEventListener('click', () => send({ t: 'clear' }));
  $('#bjRebetBtn').addEventListener('click', () => send({ t: 'rebet' }));
  $('#bjInsYes').addEventListener('click', () => { Sound.chip(); send({ t: 'ins', take: true }); });
  $('#bjInsNo').addEventListener('click', () => send({ t: 'ins', take: false }));
  $('#bjPlayControls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bj]');
    if (b && !b.disabled) act(b.dataset.bj);
  });
  $('#bjLeaveBtn').addEventListener('click', () => leave(false));
  $('#bjRulesBtn').addEventListener('click', () => $('#bjRulesDlg').showModal());
  /** Caisse à la table : ajouter des jetons sans quitter la partie. */
  function openCash() {
    if (!ctrl || !ctrl.addChips) return;
    TableCash.open({
      amounts: [20, 50, 100, 500], min: 1, max: 100000,
      add: (v) => (ctrl && ctrl.addChips ? ctrl.addChips(v) : Promise.resolve({ ok: false, msg: 'Vous n’êtes plus à la table.' })),
    });
  }
  $('#bjCashBtn').addEventListener('click', openCash);
  $('#bjAdviceToggle').addEventListener('change', render);
  $('#bjCountToggle').addEventListener('change', render);

  const KEYS = { t: 'hit', h: 'hit', r: 'stand', s: 'stand', d: 'double', p: 'split', a: 'surrender' };
  document.addEventListener('keydown', (e) => {
    if (!$('#blackjack').classList.contains('active') || document.querySelector('dialog[open]') || !view) return;
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (view.me && view.me.legal && KEYS[k]) { e.preventDefault(); act(KEYS[k]); }
    else if (view.phase === 'betting' && (e.key === 'Enter' || e.code === 'Space')) { e.preventDefault(); if (!e.repeat) ready(); }
  });

  Net.register('blackjack', {
    readCreate() {
      const buyIn = Number($('#netCreateCave').value);
      if (!(buyIn >= 10)) { toast('Il faut au moins 10 € pour ouvrir une table.'); return null; }
      return { buyIn };
    },
    startHost,
    startGuest,
  });

  return { enter, leave, _test: { playerEV: BC.playerEV, dealerDist: BC.dealerDist } };
})();
