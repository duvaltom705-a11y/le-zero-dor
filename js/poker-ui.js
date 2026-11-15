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
  const GONE_AFTER = 120000;      // un invité déconnecté plus de 2 min quitte la table

  let ctrl = null;   // contrôleur actif (solo, hôte ou invité)
  let view = null;   // dernier état reçu
  let seenCards = new Set();
  let seenHand = -1;
  let decisionKey = '';
  let lastLogLen = 0;
  let deadlineAt = 0;
  let timerRaf = 0;

  const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
  const randomHex = (words = 4) => {
    const a = new Uint32Array(words);
    RNG.getRandomValues(a);
    return [...a].map((x) => x.toString(16).padStart(8, '0')).join('');
  };
  const isNet = () => ctrl && (ctrl.mode === 'host' || ctrl.mode === 'guest');

  // Avertit avant de fermer la page pendant une partie entre amis.
  const warnUnload = (e) => { e.preventDefault(); e.returnValue = ''; };

  // ---------------------------------------------------------------
  // Pseudo
  // ---------------------------------------------------------------
  function savedName() {
    try { return localStorage.getItem('zdo-name') || ''; } catch (e) { return ''; }
  }
  function saveName(n) {
    try { localStorage.setItem('zdo-name', n); } catch (e) { /* ignore */ }
  }

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
      set blinds(b) { blinds = b; markBlinds(); },
      get buyIn() { return Number(range.value); },
      valid() { return Wallet.balance >= blinds[1] * 10; },
    };
  }

  function segValue(id) {
    const on = $(`#${id} .seg-btn.on`);
    return on ? on.dataset.v : null;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.seg[data-simple] .seg-btn');
    if (!b) return;
    for (const x of b.parentElement.children) x.classList.toggle('on', x === b);
  });

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
    const [sb, bb] = soloStake.blinds;
    const buyIn = soloStake.buyIn;
    if (!Wallet.take(buyIn)) { toast('Solde insuffisant.'); return; }
    $('#pkSoloDlg').close();
    startSolo({ n, sb, bb, buyIn, difficulty });
  });

  function startSolo({ n, sb, bb, buyIn, difficulty }) {
    const runner = new PokerCore.Runner({
      sb, bb, difficulty,
      onUpdate: () => onView(runner.view(runner.seatOf('me'))),
    });
    ctrl = {
      mode: 'solo',
      act: (a) => runner.act('me', a),
      leave: async () => { const s = runner.removePlayer('me'); runner.stop(); return s; },
      rebuy: async (amt) => runner.rebuy('me', amt),
    };
    resetTableState();
    runner.addPlayer({ id: 'me', name: 'Vous', stack: buyIn }, 0);
    for (const s of LAYOUTS[n]) runner.addBot(s);
    openTable();
  }

  // ---------------------------------------------------------------
  // Peer-to-peer : créer une table (hôte)
  // ---------------------------------------------------------------
  const createStake = stakeControls('pkCreate');
  function openCreate() {
    createStake.reset();
    if (!createStake.valid()) { toast('Il faut au moins 20 € pour ouvrir une table.'); return; }
    $('#pkCreateName').value = savedName();
    $('#pkCreateDlg').showModal();
  }
  $('#pkCreateGo').addEventListener('click', async () => {
    const btn = $('#pkCreateGo');
    const name = cleanText($('#pkCreateName').value, 16);
    if (!name) { toast('Choisissez un pseudo.'); $('#pkCreateName').focus(); return; }
    if (!createStake.valid()) return;
    const [sb, bb] = createStake.blinds;
    const buyIn = createStake.buyIn;
    if (buyIn > Wallet.balance) { toast('Solde insuffisant.'); return; }
    const bots = Number(segValue('pkCreateBots') || 0);
    const difficulty = segValue('pkCreateDiff') || 'normal';
    btn.disabled = true;
    btn.textContent = 'Ouverture de la table…';
    try {
      const { peer, code } = await P2P.openHost();
      saveName(name);
      Wallet.take(buyIn);
      $('#pkCreateDlg').close();
      startHost(peer, code, { name, sb, bb, buyIn, bots, difficulty });
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Créer la table';
    }
  });

  function startHost(peer, code, cfg) {
    const guests = new Map(); // jeton secret → { id, name, conn, lastSeen }
    const chat = [];
    let closed = false;
    const safeSend = (c, m) => { try { if (c && c.open) c.send(m); } catch (e) { /* connexion fermée */ } };
    const guestOf = (c) => { for (const g of guests.values()) if (g.conn === c) return g; return null; };
    const freeSeats = () => runner.table.seats.filter((s) => !s).length;
    const roomInfo = (isHost) => ({ code, isHost, chat: chat.slice(-40), invite: P2P.inviteLink(code) });
    const viewOf = (id, isHost) => {
      const v = runner.view(runner.seatOf(id));
      v.room = roomInfo(isHost);
      return v;
    };
    function broadcast() {
      if (closed) return;
      onView(viewOf('host', true));
      for (const g of guests.values()) if (g.conn) safeSend(g.conn, { t: 'view', v: viewOf(g.id, false) });
    }

    const runner = new PokerCore.Runner({
      sb: cfg.sb, bb: cfg.bb, difficulty: cfg.difficulty, humanTimeout: TURN_TIMEOUT,
      onUpdate: broadcast,
    });

    // Messages des invités (données non fiables : tout est vérifié ici)
    function handle(conn, msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      const g = guestOf(conn);
      if (msg.t === 'hello') {
        safeSend(conn, { t: 'info', host: cfg.name, sb: cfg.sb, bb: cfg.bb, free: freeSeats() });
        return;
      }
      if (msg.t === 'join') {
        if (g) return;
        const name = cleanText(msg.name, 16) || 'Invité';
        const stack = Math.floor(Number(msg.buyIn));
        if (!Number.isFinite(stack) || stack < cfg.bb * 10 || stack > cfg.bb * 200) {
          safeSend(conn, { t: 'error', msg: `La cave doit être comprise entre ${money(cfg.bb * 10)} et ${money(cfg.bb * 200)}.` });
          return;
        }
        if (runner.table.seats.some((s) => s && s.name.toLowerCase() === name.toLowerCase())) {
          safeSend(conn, { t: 'error', msg: 'Ce pseudo est déjà pris à cette table.' });
          return;
        }
        const token = randomHex();
        const ng = { id: 'g' + randomHex(2), name, conn, lastSeen: Date.now() };
        guests.set(token, ng);
        if (runner.addPlayer({ id: ng.id, name, stack }) < 0) {
          guests.delete(token);
          safeSend(conn, { t: 'error', msg: 'La table est complète.' });
          return;
        }
        safeSend(conn, { t: 'joined', token });
        broadcast();
        return;
      }
      if (msg.t === 'resume') {
        const rg = guests.get(String(msg.token));
        if (!rg) { safeSend(conn, { t: 'gone' }); return; }
        rg.conn = conn;
        rg.lastSeen = Date.now();
        runner.setConnected(rg.id, true); // renvoie aussi l'état à jour
        return;
      }
      if (!g) return;
      if (msg.t === 'act') {
        const type = ['fold', 'check', 'call', 'raise'].includes(msg.type) ? msg.type : null;
        if (type) runner.act(g.id, { type, amount: Number(msg.amount) || 0 });
      } else if (msg.t === 'chat') {
        const text = cleanText(msg.text, 200);
        if (text) { chat.push({ name: g.name, text }); if (chat.length > 100) chat.shift(); broadcast(); }
      } else if (msg.t === 'rebuy') {
        const amt = Math.floor(Number(msg.amount));
        const ok = Number.isFinite(amt) && amt >= cfg.bb * 10 && amt <= cfg.bb * 200 && runner.rebuy(g.id, amt);
        safeSend(conn, { t: 'rebuy', ok: !!ok, msg: ok ? '' : 'Recave impossible pendant la main.' });
      } else if (msg.t === 'leave') {
        for (const [tok, x] of guests) if (x === g) guests.delete(tok);
        const stack = runner.removePlayer(g.id);
        safeSend(conn, { t: 'left', stack });
        setTimeout(() => conn.close(), 600);
      }
    }

    peer.on('connection', (conn) => {
      if (closed) { conn.close(); return; }
      conn.on('data', (msg) => { try { handle(conn, msg); } catch (e) { console.error(e); } });
      conn.on('close', () => {
        const g = guestOf(conn);
        if (g) { g.conn = null; g.lastSeen = Date.now(); runner.setConnected(g.id, false); }
      });
      conn.on('error', () => { /* géré par « close » */ });
    });
    // Perte du service de mise en relation : les connexions existantes continuent,
    // on se ré-enregistre pour que de nouveaux amis puissent rejoindre.
    peer.on('disconnected', () => {
      setTimeout(() => { if (!closed && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', (e) => { if (!closed && e && e.type !== 'peer-unavailable') console.warn('P2P', e.type, e); });

    const maint = setInterval(() => {
      const now = Date.now();
      for (const [tok, g] of guests) {
        if (!g.conn && now - g.lastSeen > GONE_AFTER) {
          guests.delete(tok);
          runner.removePlayer(g.id);
        }
      }
    }, 10000);

    ctrl = {
      mode: 'host',
      act: (a) => runner.act('host', a),
      rebuy: async (amt) => runner.rebuy('host', amt),
      chat: (text) => {
        const t = cleanText(text, 200);
        if (t) { chat.push({ name: cfg.name, text: t }); if (chat.length > 100) chat.shift(); broadcast(); }
      },
      bot: (op) => {
        const seats = runner.table.seats;
        if (op === 'add') {
          const free = BOT_SEATS.find((i) => !seats[i]);
          if (free === undefined) toast('Plus de place à la table.');
          else runner.addBot(free);
        } else {
          const bot = [...seats].reverse().find((s) => s && s.isBot && !s.leaving);
          if (bot) runner.removePlayer(bot.id); else toast('Aucune IA à retirer.');
        }
      },
      guestCount: () => [...guests.values()].length,
      leave: async () => {
        // Fermeture de la table : la main en cours est annulée (mises rendues),
        // puis chaque ami récupère son tapis.
        closed = true;
        clearInterval(maint);
        runner.stop();
        runner.cancelHand();
        for (const g of guests.values()) {
          const stack = runner.removePlayer(g.id);
          safeSend(g.conn, { t: 'closed', stack });
        }
        guests.clear();
        const stack = runner.removePlayer('host');
        runner.stop();
        setTimeout(() => peer.destroy(), 1200);
        return stack;
      },
    };
    resetTableState();
    window.addEventListener('beforeunload', warnUnload);
    runner.addPlayer({ id: 'host', name: cfg.name, stack: cfg.buyIn }, 0);
    for (let k = 0; k < cfg.bots; k++) runner.addBot(BOT_SEATS[k]);
    openTable();
  }

  // ---------------------------------------------------------------
  // Peer-to-peer : rejoindre une table (invité)
  // ---------------------------------------------------------------
  let joinSession = null; // connexion ouverte pendant le dialogue
  const joinStake = stakeControls('pkJoin', [1, 2]);

  function joinStep(n) {
    $('#pkJoinStep1').hidden = n !== 1;
    $('#pkJoinStep2').hidden = n !== 2;
  }
  function dropJoinSession() {
    if (joinSession && !joinSession.kept) {
      try { joinSession.peer.destroy(); } catch (e) { /* ignore */ }
    }
    joinSession = null;
  }

  function openJoin(code) {
    dropJoinSession();
    $('#pkJoinName').value = savedName();
    $('#pkJoinCode').value = code ? P2P.normalize(code) : '';
    joinStep(1);
    $('#pkJoinDlg').showModal();
    if (code && savedName()) $('#pkJoinConnect').focus();
  }
  $('#pkJoinDlg').addEventListener('close', dropJoinSession);
  $('#pkJoinBack').addEventListener('click', () => { dropJoinSession(); joinStep(1); });

  $('#pkJoinConnect').addEventListener('click', async () => {
    const btn = $('#pkJoinConnect');
    const name = cleanText($('#pkJoinName').value, 16);
    const code = P2P.normalize($('#pkJoinCode').value);
    if (!name) { toast('Choisissez un pseudo.'); $('#pkJoinName').focus(); return; }
    if (code.length < 4) { toast('Entrez le code de la table que votre ami vous a donné.'); $('#pkJoinCode').focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Connexion…';
    dropJoinSession();
    try {
      const peer = await P2P.openGuest();
      const session = { peer, conn: null, code, name, kept: false };
      joinSession = session;
      const conn = await P2P.dial(peer, code);
      if (joinSession !== session) { conn.close(); return; }
      session.conn = conn;
      conn.on('data', (msg) => onJoinData(session, msg));
      conn.on('close', () => {
        if (joinSession === session && !session.kept) { toast('Connexion à l’hôte perdue.'); dropJoinSession(); joinStep(1); }
      });
      conn.send({ t: 'hello' });
    } catch (e) {
      dropJoinSession();
      toast(e.message || 'Connexion impossible.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Se connecter';
    }
  });

  function onJoinData(session, msg) {
    if (joinSession !== session || !msg || typeof msg !== 'object') return;
    if (msg.t === 'info') {
      const sb = Number(msg.sb);
      const bb = Number(msg.bb);
      session.bb = bb;
      $('#pkJoinInfo').innerHTML = `Table de <b>${esc(cleanText(msg.host, 16))}</b> · blindes ${money(sb)} / ${money(bb)} · `
        + `${Number(msg.free) > 0 ? `${Number(msg.free)} place${msg.free > 1 ? 's' : ''} libre${msg.free > 1 ? 's' : ''}` : 'table complète'}`;
      joinStake.reset([sb, bb]);
      $('#pkJoinGo').disabled = !joinStake.valid() || !(Number(msg.free) > 0);
      if (!joinStake.valid()) toast(`Il faut au moins ${money(bb * 10)} pour cette table.`);
      joinStep(2);
    } else if (msg.t === 'error') {
      toast(cleanText(msg.msg, 200) || 'Impossible de rejoindre.');
      $('#pkJoinGo').disabled = false;
    } else if (msg.t === 'joined') {
      const buyIn = session.pendingBuyIn;
      if (!Wallet.take(buyIn)) { session.conn.send({ t: 'leave' }); return; }
      session.kept = true;
      saveName(session.name);
      joinSession = null;
      $('#pkJoinDlg').close();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      startGuest(session.peer, session.conn, session.code, String(msg.token));
    }
  }

  $('#pkJoinGo').addEventListener('click', () => {
    const s = joinSession;
    if (!s || !s.conn) { joinStep(1); return; }
    const buyIn = joinStake.buyIn;
    if (buyIn > Wallet.balance) { toast('Solde insuffisant.'); return; }
    s.pendingBuyIn = buyIn;
    $('#pkJoinGo').disabled = true;
    s.conn.send({ t: 'join', name: s.name, buyIn });
  });

  function startGuest(peer, conn, code, token) {
    let ended = false;
    let retries = 0;
    const waiters = {}; // type de réponse → résolveurs
    const g = { mode: 'guest', code, conn };

    const send = (m) => { try { if (g.conn && g.conn.open) { g.conn.send(m); return true; } } catch (e) { /* ignore */ } return false; };
    const request = (m, reply, ms = 5000) => new Promise((resolve, reject) => {
      (waiters[reply] = waiters[reply] || []).push(resolve);
      if (!send(m)) reject(new Error('Pas de connexion avec l’hôte.'));
      setTimeout(() => reject(new Error('L’hôte ne répond pas.')), ms);
    });

    function onData(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'view') {
        retries = 0;
        setConn(true);
        if (ctrl === g) onView(msg.v);
      } else if (waiters[msg.t] && waiters[msg.t].length) {
        waiters[msg.t].shift()(msg);
      } else if (msg.t === 'closed') {
        finish(Number(msg.stack) || 0, 'L’hôte a fermé la table.');
      } else if (msg.t === 'gone') {
        finish(0, 'Vous avez été retiré de la table après une longue déconnexion.');
      } else if (msg.t === 'error') {
        toast(cleanText(msg.msg, 200));
      }
    }
    function onClose() {
      if (ended || ctrl !== g) return;
      setConn(false, 'Connexion à l’hôte perdue… reconnexion en cours.');
      setTimeout(reconnect, 2000);
    }
    function attach(c) {
      g.conn = c;
      c.on('data', onData);
      c.on('close', onClose);
      c.on('error', () => { /* géré par « close » */ });
    }
    async function reconnect() {
      if (ended || ctrl !== g) return;
      retries++;
      if (retries > 15) {
        setConn(false, 'Impossible de joindre l’hôte : la table semble fermée.', true);
        return;
      }
      try {
        if (peer.disconnected && !peer.destroyed) peer.reconnect();
        const c = await P2P.dial(peer, code);
        attach(c);
        c.send({ t: 'resume', token });
      } catch (e) {
        setTimeout(reconnect, 3000);
      }
    }
    function finish(stack, msg) {
      if (ended) return;
      ended = true;
      if (ctrl === g) ctrl = null;
      window.removeEventListener('beforeunload', warnUnload);
      cancelAnimationFrame(timerRaf);
      setTimeout(() => { try { peer.destroy(); } catch (e) { /* ignore */ } }, 300);
      if (stack > 0) Wallet.give(stack);
      infoBox('Table fermée', `<p>${esc(msg)}</p><p>Vous récupérez <b>${money(stack)}</b>.</p>`, 'Retour au hall').then(backToHall);
    }

    g.act = (a) => send({ t: 'act', type: a.type, amount: a.amount });
    g.chat = (text) => send({ t: 'chat', text });
    g.rebuy = async (amount) => {
      const r = await request({ t: 'rebuy', amount }, 'rebuy');
      return !!r.ok;
    };
    g.leave = async () => {
      let stack = 0;
      try { stack = Number((await request({ t: 'leave' }, 'left', 4000)).stack) || 0; } catch (e) { /* hôte injoignable */ }
      ended = true;
      setTimeout(() => { try { peer.destroy(); } catch (e) { /* ignore */ } }, 300);
      return stack;
    };

    peer.on('disconnected', () => {
      setTimeout(() => { if (!ended && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', () => { /* les erreurs utiles sont gérées par dial() */ });
    attach(conn);
    ctrl = g;
    resetTableState();
    window.addEventListener('beforeunload', warnUnload);
    openTable();
  }

  function setConn(ok, msg, final) {
    const b = $('#pkConn');
    b.hidden = ok;
    if (ok) return;
    b.innerHTML = esc(msg || 'Connexion perdue… reconnexion en cours.')
      + (final ? ' <button type="button" class="btn-ctl" id="pkConnBack">Retour au hall</button>' : '');
    if (final) {
      $('#pkConnBack').onclick = () => {
        ctrl = null;
        window.removeEventListener('beforeunload', warnUnload);
        b.hidden = true;
        backToHall();
      };
    }
  }

  // ---------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------
  function resetTableState() {
    view = null;
    seenCards = new Set();
    seenHand = -1;
    decisionKey = '';
    lastLogLen = 0;
    lastChatLen = -1;
    $('#pkLog').innerHTML = '';
    $('#pkChatLog').innerHTML = '';
    setConn(true);
  }

  function openTable() {
    $('#pkNetPanel').hidden = !isNet();
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
    if (isNet()) renderNet(v);
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
        const bb = v.bb;
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
  // Panneau peer-to-peer : code, invitation, chat, IA
  // ---------------------------------------------------------------
  let lastChatLen = -1;
  function renderNet(v) {
    const r = v.room || {};
    const code = P2P.normalize(r.code);
    $('#pkRoomCode').textContent = code;
    const link = typeof r.invite === 'string' && /^https?:\/\//.test(r.invite) ? r.invite : null;
    const inp = $('#pkInvite');
    const val = link || code;
    if (inp.value !== val) inp.value = val;
    $('#pkInviteHelp').textContent = link
      ? `Lien d’invitation (ou code ${code}) :`
      : 'Code à donner à vos amis (dans leur casino : Poker entre amis → Rejoindre) :';
    $('#pkHostTools').hidden = !r.isHost;
    const chat = Array.isArray(r.chat) ? r.chat : [];
    if (chat.length !== lastChatLen) {
      lastChatLen = chat.length;
      const box = $('#pkChatLog');
      box.innerHTML = chat.length
        ? chat.map((m) => `<div class="chat-line"><b>${esc(m.name)}</b> ${esc(m.text)}</div>`).join('')
        : '<div class="muted small">Pas encore de message.</div>';
      box.scrollTop = box.scrollHeight;
    }
  }
  $('#pkCopy').addEventListener('click', async () => {
    const input = $('#pkInvite');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      input.select();
      document.execCommand('copy');
    }
    toast(/^https?:/.test(input.value) ? 'Lien copié : envoyez-le à vos amis.' : `Code ${input.value} copié : envoyez-le à vos amis.`, 'ok');
  });
  $('#pkChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#pkChatInput');
    const text = inp.value.trim();
    if (!text || !ctrl || !ctrl.chat) return;
    ctrl.chat(text);
    inp.value = '';
  });
  $('#pkBotAdd').addEventListener('click', () => ctrl && ctrl.bot && ctrl.bot('add'));
  $('#pkBotRemove').addEventListener('click', () => ctrl && ctrl.bot && ctrl.bot('remove'));

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
    ctrl = null;
    cancelAnimationFrame(timerRaf);
    window.removeEventListener('beforeunload', warnUnload);
    const stack = await c.leave();
    if (stack > 0) Wallet.give(stack);
    toast(`Vous repartez avec ${money(stack)}.`, 'ok');
    backToHall();
  }
  $('#pkLeaveBtn').addEventListener('click', () => leave(false));
  $('#pkRanksBtn').addEventListener('click', () => $('#pkRanksDlg').showModal());

  return { openSolo, openCreate, openJoin };
})();
