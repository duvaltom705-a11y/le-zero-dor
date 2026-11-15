'use strict';

/* =================================================================
   Poker — interface de la table
   - solo : contre des IA, tout tourne dans ce navigateur
   - peer-to-peer : le navigateur de l'hôte fait tourner la table et
     distribue les cartes ; les invités s'y connectent directement
     (WebRTC) et ne reçoivent que ce qu'ils ont le droit de voir.
   ================================================================= */
const PokerUI = (() => {
  const BLINDS = [[1, 2], [5, 10], [25, 50], [100, 200]];
  const LAYOUTS = { 1: [3], 2: [2, 4], 3: [2, 3, 4], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5] };
  const BOT_SEATS = [3, 1, 5, 2, 4];
  const TURN_TIMEOUT = 40000;     // délai pour jouer à une table entre amis

  let ctrl = null;   // contrôleur actif (solo, hôte ou invité)
  let view = null;   // dernier état reçu
  let seenCards = new Set();
  let seenHand = -1;
  let decisionKey = '';
  let lastLogLen = 0;
  let deadlineAt = 0;
  let timerRaf = 0;

  const isNet = () => ctrl && (ctrl.mode === 'host' || ctrl.mode === 'guest');

  // ---------------------------------------------------------------
  // Contrôles de cave (blindes + montant), partagés par les dialogues
  // ---------------------------------------------------------------
  function stakeControls(prefix, fixedBlinds) {
    const seg = $(`#${prefix}Blinds`);
    const range = $(`#${prefix}BuyIn`);
    const out = $(`#${prefix}BuyInOut`);
    let blinds = fixedBlinds || null;

    function renderBlinds() {
      if (!seg) return;
      seg.innerHTML = BLINDS.map(([sb, bb]) => {
        const ok = Wallet.balance >= bb * 10;
        return `<button type="button" class="seg-btn" data-sb="${sb}" data-bb="${bb}" ${ok ? '' : 'disabled'}>${money(sb)} / ${money(bb)}</button>`;
      }).join('');
      if (!blinds || Wallet.balance < blinds[1] * 10) {
        const fit = BLINDS.filter(([, bb]) => Wallet.balance >= bb * 20);
        blinds = fit.length ? fit[Math.min(fit.length - 1, Wallet.balance >= 2000 ? 1 : 0)] : BLINDS[0];
      }
      markBlinds();
    }
    function markBlinds() {
      if (seg) for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.bb) === blinds[1]);
      const bb = blinds[1];
      const min = bb * 10;
      const max = Math.max(min, Math.min(bb * 200, Math.floor(Wallet.balance)));
      range.min = String(min);
      range.max = String(max);
      range.step = String(bb);
      range.value = String(Math.max(min, Math.min(bb * 100, max)));
      range.disabled = Wallet.balance < min;
      showOut();
    }
    function showOut() {
      const v = Number(range.value);
      out.textContent = `${money(v)} · ${Math.round(v / blinds[1])} grosses blindes`;
    }
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b || b.disabled) return;
        blinds = [Number(b.dataset.sb), Number(b.dataset.bb)];
        markBlinds();
      });
    }
    range.addEventListener('input', showOut);
    return {
      reset(fixed) { if (fixed) blinds = fixed; renderBlinds(); if (!seg) markBlinds(); },
      get blinds() { return blinds; },
      get buyIn() { return Number(range.value); },
      valid() { return Wallet.balance >= blinds[1] * 10; },
    };
  }

  // ---------------------------------------------------------------
  // Mode solo
  // ---------------------------------------------------------------
  const soloStake = stakeControls('pkSolo');
  function openSolo() {
    soloStake.reset();
    if (!soloStake.valid()) { toast('Il faut au moins 20 € pour s’asseoir à une table de poker.'); return; }
    $('#pkSoloDlg').showModal();
  }
  $('#pkSoloGo').addEventListener('click', () => {
    if (!soloStake.valid()) return;
    const n = Number(segValue('pkSoloOpp') || 4);
    const difficulty = segValue('pkSoloDiff') || 'normal';
    const blindUp = (Number(segValue('pkSoloBlindUp')) || 0) * 60000;
    const [sb, bb] = soloStake.blinds;
    const buyIn = soloStake.buyIn;
    if (!Wallet.take(buyIn)) { toast('Solde insuffisant.'); return; }
    $('#pkSoloDlg').close();
    startSolo({ n, sb, bb, buyIn, difficulty, blindUp });
  });

  function startSolo({ n, sb, bb, buyIn, difficulty, blindUp }) {
    const runner = new PokerCore.Runner({
      sb, bb, difficulty, blindUp,
      onUpdate: () => onView(runner.view(runner.seatOf('me'))),
    });
    ctrl = {
      mode: 'solo',
      act: (a) => runner.act('me', a),
      leave: async () => { const s = runner.removePlayer('me'); runner.stop(); return { stack: s }; },
      rebuy: async (amt) => runner.rebuy('me', amt),
    };
    resetTableState();
    runner.addPlayer({ id: 'me', name: 'Vous', stack: buyIn }, 0);
    for (const s of LAYOUTS[n]) runner.addBot(s);
    openTable();
  }

  // ---------------------------------------------------------------
  // Table entre amis : hôte (le dialogue « Créer une table » est dans net.js)
  // ---------------------------------------------------------------
  const createStake = stakeControls('netCreate');

  function startHost(peer, code, cfg) {
    let room = null;
    const runner = new PokerCore.Runner({
      sb: cfg.sb, bb: cfg.bb, difficulty: cfg.difficulty, humanTimeout: TURN_TIMEOUT, blindUp: cfg.blindUp,
      onUpdate: () => { if (room) room.broadcast(); },
    });
    const game = {
      type: 'poker',
      info: () => ({
        detail: `blindes ${money(runner.table.sb)} / ${money(runner.table.bb)}`
          + (cfg.blindUp ? ` · elles montent toutes les ${Math.round(cfg.blindUp / 60000)} min` : ''),
        free: runner.table.seats.filter((s) => !s).length,
        bb: cfg.bb,
        buyIn: { min: cfg.bb * 10, max: cfg.bb * 200, step: cfg.bb, def: cfg.bb * 100 },
      }),
      join(id, name, stack) {
        if (runner.table.seats.some((s) => s && s.name.toLowerCase() === name.toLowerCase())) return 'Ce pseudo est déjà pris à cette table.';
        return runner.addPlayer({ id, name, stack }) < 0 ? 'La table est complète.' : '';
      },
      view: (id) => runner.view(runner.seatOf(id)),
      handle(id, msg) {
        if (msg.t === 'act') {
          const type = ['fold', 'check', 'call', 'raise'].includes(msg.type) ? msg.type : null;
          if (type) runner.act(id, { type, amount: Number(msg.amount) || 0 });
          return null;
        }
        if (msg.t === 'rebuy') {
          const amt = Math.floor(Number(msg.amount));
          const ok = Number.isFinite(amt) && amt >= cfg.bb * 10 && amt <= cfg.bb * 200 && runner.rebuy(id, amt);
          return { t: 'rebuy', ok: !!ok };
        }
        return null;
      },
      setConnected: (id, ok) => runner.setConnected(id, ok),
      leave: (id) => ({ stack: runner.removePlayer(id) }),
      canDrop: () => true,
      // Fermeture : la main en cours est annulée (mises rendues), puis chacun récupère son tapis.
      closeAll() {
        runner.stop();
        runner.cancelHand();
        const m = new Map();
        for (const s of [...runner.table.seats]) if (s && !s.isBot) m.set(s.id, runner.removePlayer(s.id));
        runner.stop();
        return m;
      },
    };
    const c = { mode: 'host' };
    room = Net.host(peer, code, cfg.name, game, (v) => { if (ctrl === c) onView(v); });
    c.room = room;
    c.act = (a) => runner.act('host', a);
    c.rebuy = async (amt) => runner.rebuy('host', amt);
    c.chat = (t) => room.chat(t);
    c.bot = (op) => {
      const seats = runner.table.seats;
      if (op === 'add') {
        const free = BOT_SEATS.find((i) => !seats[i]);
        if (free === undefined) toast('Plus de place à la table.');
        else runner.addBot(free);
      } else {
        const bot = [...seats].reverse().find((s) => s && s.isBot && !s.leaving);
        if (bot) runner.removePlayer(bot.id); else toast('Aucune IA à retirer.');
      }
    };
    c.guestCount = () => room.guestCount();
    c.leave = async () => ({ stack: room.close() });
    ctrl = c;
    resetTableState();
    runner.addPlayer({ id: 'host', name: cfg.name, stack: cfg.buyIn }, 0);
    for (let k = 0; k < cfg.bots; k++) runner.addBot(BOT_SEATS[k]);
    openTable();
  }

  // ---------------------------------------------------------------
  // Table entre amis : invité
  // ---------------------------------------------------------------
  function startGuest(peer, conn, code, token) {
    const c = { mode: 'guest' };
    const g = Net.guest(peer, conn, code, token, {
      onView: (v) => { if (ctrl === c) onView(v); },
      onEnd: (stack, msg) => {
        if (ctrl !== c) return;
        ctrl = null;
        cancelAnimationFrame(timerRaf);
        Net.hidePanel();
        if (stack > 0) Wallet.give(stack);
        infoBox('Table fermée', `<p>${esc(msg)}</p><p>Vous récupérez <b>${money(stack)}</b>.</p>`, 'Retour au hall').then(backToHall);
      },
      onAbort: () => {
        if (ctrl !== c) return;
        ctrl = null;
        cancelAnimationFrame(timerRaf);
        Net.hidePanel();
        backToHall();
      },
    });
    c.act = (a) => g.send({ t: 'act', type: a.type, amount: a.amount });
    c.chat = (t) => g.chat(t);
    c.rebuy = async (amount) => !!(await g.request({ t: 'rebuy', amount }, 'rebuy')).ok;
    c.leave = () => g.leave();
    ctrl = c;
    resetTableState();
    openTable();
  }

  Net.register('poker', {
    prepareCreate() { createStake.reset(); },
    readCreate() {
      if (!createStake.valid()) { toast('Il faut au moins 20 € pour ouvrir une table de poker.'); return null; }
      const [sb, bb] = createStake.blinds;
      return {
        sb, bb, buyIn: createStake.buyIn,
        bots: Number(segValue('netCreateBots') || 0),
        difficulty: segValue('netCreateDiff') || 'normal',
        blindUp: (Number(segValue('netCreateBlindUp')) || 0) * 60000,
      };
    },
    startHost,
    startGuest,
  });

  // ---------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------
  // Compte à rebours jusqu'au prochain niveau de blindes
  let blindLevel = -1;
  let blindAt = 0;
  function tickBlinds() {
    const el = $('#pkBlindsNext');
    const v = view;
    if (!v || !v.blindUp || typeof v.nextLevelMs !== 'number') { el.textContent = v && v.blindUp ? 'niveau maximum' : ''; el.className = 'kpi-sub'; return; }
    const next = `${money(v.nextSb)} / ${money(v.nextBb)}`;
    if (v.nextLevelMs === 0) { el.textContent = `↑ ${next} à la prochaine main`; el.className = 'kpi-sub soon'; return; }
    const left = v.clockRunning ? Math.max(0, blindAt - performance.now()) : v.nextLevelMs;
    const s = Math.ceil(left / 1000);
    const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.textContent = `↑ ${next} dans ${mmss}${v.clockRunning ? '' : ' (en pause)'}`;
    el.className = 'kpi-sub' + (left < 30000 ? ' soon' : '');
  }
  setInterval(() => { if (ctrl && view && $('#poker').classList.contains('active')) tickBlinds(); }, 500);

  function resetTableState() {
    blindLevel = -1;
    blindAt = 0;
    view = null;
    seenCards = new Set();
    seenHand = -1;
    decisionKey = '';
    lastLogLen = 0;
    $('#pkLog').innerHTML = '';
  }

  function openTable() {
    if (isNet()) Net.mountPanel($('#pkNetSlot'), ctrl);
    else Net.hidePanel();
    showScreen('poker');
    render();
  }

  function onView(v) {
    const wasMyTurn = view && view.legal;
    view = v;
    if (v.legal && !wasMyTurn) Sound.turn();
    if ($('#poker').classList.contains('active')) render();
  }

  const hueOf = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const POS_OF = (seat, you, n) => (you >= 0 ? (seat - you + n) % n : seat);
  const isCard = (c) => Number.isInteger(c) && c >= 0 && c < 52;

  function cardHtml(c, key, opts = {}) {
    const anim = !seenCards.has(key);
    seenCards.add(key);
    return Cards.html(isCard(c) ? c : null, { anim, cls: opts.cls || '' });
  }

  function render() {
    if (!view || !ctrl) return;
    const v = view;
    const n = v.seats.length;
    const me = v.you >= 0 ? v.seats[v.you] : null;
    if (v.handNo !== seenHand) { seenHand = v.handNo; seenCards = new Set(); }

    // En-tête
    $('#pkStack').textContent = me ? money(me.stack) : '—';
    $('#pkWallet').textContent = money(Wallet.balance);
    $('#pkBlindsKpi').textContent = `${money(v.sb)} / ${money(v.bb)}`;
    if (typeof v.level === 'number' && v.level > blindLevel && blindLevel >= 0) {
      toast(`Les blindes montent : ${money(v.sb)} / ${money(v.bb)}`, 'ok');
      Sound.turn();
    }
    blindLevel = typeof v.level === 'number' ? v.level : -1;
    blindAt = typeof v.nextLevelMs === 'number' ? performance.now() + v.nextLevelMs : 0;
    tickBlinds();
    $('#pkHandNo').textContent = v.handNo ? `n° ${v.handNo}` : '—';

    // Gagnants de la main (pour la mise en valeur)
    const winners = new Set();
    let mainBest = null;
    if (v.result) {
      for (const pot of v.result.pots) for (const w of pot.winners) winners.add(w);
      const w0 = v.result.pots[0] && v.result.pots[0].winners[0];
      if (w0 !== undefined && v.seats[w0] && v.seats[w0].best) mainBest = new Set(v.seats[w0].best);
    }

    // Sièges
    let html = '';
    for (let i = 0; i < n; i++) {
      const s = v.seats[i];
      const pos = POS_OF(i, v.you, n);
      if (!s) {
        if (isNet()) html += `<div class="pk-seat empty pos-${pos}"><div class="pk-plate"><span class="muted">Place libre</span></div></div>`;
        continue;
      }
      const turn = v.toAct === i && v.phase === 'betting';
      const cls = ['pk-seat', `pos-${pos}`];
      if (turn) cls.push('turn');
      if (s.folded) cls.push('folded');
      if (winners.has(i)) cls.push('winner');
      if (i === v.you) cls.push('you');
      if (!s.connected) cls.push('offline');
      if (!s.inHand && v.phase !== 'waiting') cls.push('out');
      let cards = '';
      if (Array.isArray(s.cards)) {
        cards = s.cards.slice(0, 2).map((c, k) => {
          let extra = '';
          if (Array.isArray(s.best) && isCard(c)) extra = s.best.includes(c) ? 'hl' : 'dim';
          return cardHtml(c, `${v.handNo}:${i}:${k}`, { cls: extra });
        }).join('');
      }
      let tag = '';
      if (s.handName) tag = `<div class="pk-tag hand">${esc(s.handName)}</div>`;
      else if (s.lastAction && s.lastAction.type !== 'blind') {
        const t = String(s.lastAction.type).replace(/[^a-z]/g, '');
        const amt = Number(s.lastAction.amount);
        tag = `<div class="pk-tag t-${t}">${esc(s.lastAction.label)}${amt && t !== 'fold' && t !== 'check' ? ' ' + money(amt) : ''}</div>`;
      } else if (!s.connected) tag = '<div class="pk-tag">Déconnecté</div>';
      else if (s.stack === 0 && !s.inHand) tag = '<div class="pk-tag">À sec</div>';
      const style = s.isBot && s.style && PokerCore.AI.STYLES[s.style] ? `<span class="pk-badge">IA · ${PokerCore.AI.STYLES[s.style].label}</span>` : '';
      const won = s.won ? `<div class="pk-won">+${money(Number(s.won))}</div>` : '';
      const name = String(s.name || '');
      html += `<div class="${cls.join(' ')}">
          <div class="pk-hole">${cards}</div>
          <div class="pk-plate">
            <div class="pk-avatar" style="--hue:${hueOf(name)}">${esc(name.charAt(0).toUpperCase())}</div>
            <div class="pk-id">
              <div class="pk-name">${esc(name)}${i === v.you && isNet() ? ' (vous)' : ''}</div>
              <div class="pk-stack">${s.allIn && s.inHand && !s.folded ? 'Tapis' : money(Number(s.stack))}</div>
            </div>
            ${turn ? '<div class="pk-timer"><i></i></div>' : ''}
          </div>
          ${style}${tag}${won}
        </div>`;
      if (s.bet > 0) html += `<div class="pk-bet pos-${pos}"><span class="chip-stack ${chipCls(s.bet)}"></span>${money(Number(s.bet))}</div>`;
      if (i === v.button && v.handNo) html += `<div class="pk-dealer pos-${pos}">D</div>`;
    }
    $('#pkSeats').innerHTML = html;

    // Tableau et pot
    const board = [];
    for (let k = 0; k < 5; k++) {
      const c = v.board[k];
      if (c === undefined) board.push('<div class="card slot"></div>');
      else board.push(cardHtml(c, `${v.handNo}:b${k}`, { cls: mainBest ? (mainBest.has(c) ? 'hl' : 'dim') : '' }));
    }
    $('#pkBoard').innerHTML = board.join('');
    const bets = v.seats.reduce((a, s) => a + (s ? Number(s.bet) || 0 : 0), 0);
    $('#pkPot').innerHTML = v.result
      ? `Pot : <b>${money(v.result.pots.reduce((a, p) => a + Number(p.amount), 0))}</b>`
      : v.pot + bets > 0 ? `Pot : <b>${money(v.pot + bets)}</b>` : '';
    $('#pkMsg').innerHTML = centerMessage(v);

    renderActions(v, me);
    renderLog(v);
    if (isNet()) Net.updatePanel(v.room);
    startTimer(v);
  }

  function chipCls(a) {
    const vals = [1, 5, 10, 25, 100, 500, 1000];
    let c = 1;
    for (const x of vals) if (a >= x) c = x;
    return 'c' + c;
  }

  function centerMessage(v) {
    if (v.result) {
      return v.result.pots.map((p, idx) => {
        const names = p.winners.map((w) => (v.seats[w] ? (w === v.you && ctrl.mode === 'solo' ? 'Vous' : esc(v.seats[w].name)) : '?'));
        const youWin = p.winners.includes(v.you);
        const verb = names.length > 1 ? 'se partagent' : (names[0] === 'Vous' ? 'remportez' : 'remporte');
        const potName = v.result.pots.length > 1 ? (idx === 0 ? ' le pot principal' : ' un pot annexe') : '';
        return `<div class="${youWin ? 'pos' : ''}">${names.join(' et ')} ${verb}${potName} ${money(Number(p.amount))}${p.handName ? ` avec <b>${esc(p.handName)}</b>` : ''}</div>`;
      }).join('');
    }
    if (v.phase === 'waiting') return v.waiting ? 'En attente d’autres joueurs…' : 'Nouvelle donne…';
    if (v.toAct >= 0 && v.seats[v.toAct]) {
      if (v.toAct === v.you) return '<b>À vous de jouer</b>';
      return `${esc(v.seats[v.toAct].name)} réfléchit…`;
    }
    return '';
  }

  function renderActions(v, me) {
    const L = v.legal;
    const mine = me && me.inHand && Array.isArray(me.cards) && isCard(me.cards[0])
      ? PokerCore.bestFive(me.cards.concat(v.board)) : null;
    $('#pkMyHand').innerHTML = mine && v.board.length ? `Votre main : <b>${esc(PokerCore.handName(mine.score))}</b>` : '';

    const btns = $('#pkActBtns');
    const wait = $('#pkWait');
    const rebuy = $('#pkRebuy');
    btns.hidden = !L;
    const busted = me && me.stack === 0 && !me.inHand;
    rebuy.hidden = !(busted && v.phase !== 'betting');
    wait.hidden = !!L || !rebuy.hidden;
    if (!L) {
      decisionKey = '';
      if (!me) wait.textContent = 'Vous n’êtes pas assis à cette table.';
      else if (me.folded) wait.textContent = 'Vous vous êtes couché. Prochaine main dans un instant.';
      else if (v.phase === 'betting' && v.seats[v.toAct]) wait.textContent = `En attente de ${v.seats[v.toAct].name}…`;
      else if (v.waiting) wait.textContent = isNet() ? 'En attente d’un autre joueur : donnez le code de la table à vos amis.' : 'En attente…';
      else wait.textContent = '';
      if (!rebuy.hidden) {
        const bb = v.baseBb || v.bb;
        const r = $('#pkRebuyAmt');
        r.min = String(bb * 10);
        r.max = String(Math.max(bb * 10, Math.min(bb * 200, Math.floor(Wallet.balance))));
        r.step = String(bb);
        if (!r.dataset.touched) r.value = String(Math.min(bb * 100, Number(r.max)));
        $('#pkRebuyOut').textContent = money(Number(r.value));
        $('#pkRebuyGo').disabled = Wallet.balance < bb * 10;
      }
      return;
    }
    $('[data-pk="call"]').innerHTML = L.canCheck
      ? 'Parole <kbd>C</kbd>'
      : `Suivre ${money(L.callAmount)}${L.callAmount >= me.stack ? ' (tapis)' : ''} <kbd>C</kbd>`;
    const raiseBox = $('#pkRaiseBox');
    raiseBox.hidden = !L.raise;
    if (L.raise) {
      const key = `${v.handNo}:${v.street}:${v.currentBet}`;
      const range = $('#pkRange');
      const num = $('#pkAmount');
      range.min = num.min = String(L.raise.min);
      range.max = num.max = String(L.raise.max);
      range.step = '1';
      if (key !== decisionKey) {
        decisionKey = key;
        range.value = num.value = String(L.raise.min);
      }
      updateRaiseLabel();
    }
  }

  function updateRaiseLabel() {
    if (!view || !view.legal || !view.legal.raise) return;
    const v = view;
    const amt = Number($('#pkAmount').value);
    const all = amt >= v.legal.raise.max;
    const verb = v.currentBet === 0 ? 'Miser' : 'Relancer à';
    $('[data-pk="raise"]').innerHTML = all ? `Tapis ${money(v.legal.raise.max)} <kbd>R</kbd>` : `${verb} ${money(amt)} <kbd>R</kbd>`;
  }
  function setAmount(x) {
    const L = view && view.legal;
    if (!L || !L.raise) return;
    const a = Math.round(clamp(x, L.raise.min, L.raise.max));
    $('#pkRange').value = String(a);
    $('#pkAmount').value = String(a);
    updateRaiseLabel();
  }
  $('#pkRange').addEventListener('input', () => setAmount(Number($('#pkRange').value)));
  $('#pkAmount').addEventListener('change', () => setAmount(Number($('#pkAmount').value)));
  $('#pkPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b || !view || !view.legal || !view.legal.raise) return;
    const v = view;
    const L = v.legal;
    const s = b.dataset.size;
    if (s === 'min') return setAmount(L.raise.min);
    if (s === 'all') return setAmount(L.raise.max);
    const bets = v.seats.reduce((a, x) => a + (x ? x.bet : 0), 0);
    const potAll = v.pot + bets + L.toCall;
    return setAmount(v.currentBet + potAll * Number(s));
  });

  function doAction(type) {
    if (!view || !view.legal || !ctrl) return;
    const L = view.legal;
    if (type === 'raise' && !L.raise) return;
    if (type === 'call' && L.canCheck) type = 'check';
    const a = { type };
    if (type === 'raise') a.amount = Number($('#pkAmount').value);
    view.legal = null; // évite les doubles clics
    ctrl.act(a);
    if (ctrl && ctrl.mode === 'guest') render();
  }
  $('#pkActBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pk]');
    if (b) doAction(b.dataset.pk);
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#poker').classList.contains('active') || document.querySelector('dialog[open]')) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') doAction('fold');
    else if (k === 'c') doAction('call');
    else if (k === 'r') doAction('raise');
  });

  function renderLog(v) {
    const box = $('#pkLog');
    const lines = Array.isArray(v.log) ? v.log : [];
    if (lines.length === lastLogLen && box.children.length) return;
    lastLogLen = lines.length;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = lines.map((l) => `<div class="log-line ${esc(l.cls || '')}">${esc(l.text)}</div>`).join('');
    if (atBottom || box.children.length < 30) box.scrollTop = box.scrollHeight;
  }

  // Minuteur du joueur dont c'est le tour (tables entre amis)
  function startTimer(v) {
    cancelAnimationFrame(timerRaf);
    if (!v.deadlineMs) { deadlineAt = 0; return; }
    deadlineAt = performance.now() + Number(v.deadlineMs);
    const tick = () => {
      const bar = $('.pk-seat.turn .pk-timer i');
      if (!bar) return;
      const left = Math.max(0, deadlineAt - performance.now());
      bar.style.width = `${(left / TURN_TIMEOUT) * 100}%`;
      bar.classList.toggle('late', left < 10000);
      if (left > 0) timerRaf = requestAnimationFrame(tick);
    };
    timerRaf = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------
  // Recave et départ
  // ---------------------------------------------------------------
  $('#pkRebuyAmt').addEventListener('input', (e) => {
    e.target.dataset.touched = '1';
    $('#pkRebuyOut').textContent = money(Number(e.target.value));
  });
  $('#pkRebuyGo').addEventListener('click', async () => {
    const amt = Number($('#pkRebuyAmt').value);
    if (!ctrl || !Wallet.take(amt)) { toast('Solde insuffisant.'); return; }
    try {
      const ok = await ctrl.rebuy(amt);
      if (ok === false) { Wallet.give(amt); toast('Recave impossible pendant la main.'); }
    } catch (e) { Wallet.give(amt); toast(e.message); }
  });
  $('#pkRebuyLeave').addEventListener('click', () => leave(true));

  async function leave(skipConfirm) {
    if (!ctrl) return;
    const me = view && view.you >= 0 ? view.seats[view.you] : null;
    if (!skipConfirm) {
      const inHand = me && me.inHand && !me.folded && view.phase !== 'waiting' && view.phase !== 'handOver';
      const isHost = ctrl.mode === 'host';
      let html = isHost
        ? `<p>Votre tapis (<b>${money(me ? me.stack : 0)}</b>) et vos mises de la main en cours retournent dans votre portefeuille.</p>`
        : `<p>Vous quittez la table avec <b>${money(me ? me.stack : 0)}</b>, qui retournent dans votre portefeuille.</p>`;
      if (inHand && !isHost) html += '<p class="muted">Votre main en cours sera couchée : les jetons déjà misés restent dans le pot.</p>';
      if (isHost) {
        html += ctrl.guestCount() > 0
          ? '<p><b>Vous êtes l’hôte :</b> la table sera fermée, la main en cours annulée et chacun récupérera ses jetons.</p>'
          : '<p class="muted">La table sera fermée et la main en cours annulée.</p>';
      }
      if (!(await confirmBox(ctrl.mode === 'host' ? 'Fermer la table ?' : 'Quitter la table ?', html, 'Quitter la table', 'Rester'))) return;
    }
    const c = ctrl;
    if (!c) return;
    const r = await c.leave();
    if (r.error) { toast(r.error); return; }
    if (ctrl !== c) return;
    ctrl = null;
    cancelAnimationFrame(timerRaf);
    Net.hidePanel();
    const stack = Number(r.stack) || 0;
    if (stack > 0) Wallet.give(stack);
    toast(`Vous repartez avec ${money(stack)}.`, 'ok');
    backToHall();
  }
  $('#pkLeaveBtn').addEventListener('click', () => leave(false));
  $('#pkRanksBtn').addEventListener('click', () => $('#pkRanksDlg').showModal());

  /** Caisse à la table : ajouter des jetons entre deux mains, sans quitter la table. */
  function openCash() {
    if (!ctrl || !ctrl.rebuy || !view) return;
    const bb = view.baseBb || view.bb;
    const me = view.you >= 0 ? view.seats[view.you] : null;
    const playing = me && me.inHand && !me.folded && (view.phase === 'betting' || view.phase === 'streetEnd');
    TableCash.open({
      amounts: [bb * 20, bb * 50, bb * 100, bb * 200], min: bb * 10, max: bb * 200,
      note: `Au poker : de ${money(bb * 10)} à ${money(bb * 200)} par ajout, entre deux mains (ou une fois couché)${playing ? '. Attendez la fin de cette main.' : '.'}`,
      add: async (v) => {
        if (!ctrl || !ctrl.rebuy) return { ok: false, msg: 'Vous n’êtes plus à la table.' };
        const ok = await ctrl.rebuy(v);
        return { ok: ok !== false, msg: 'Vous pourrez ajouter des jetons à la fin de la main.' };
      },
    });
  }
  $('#pkCashBtn').addEventListener('click', openCash);

  return { openSolo };
})();
