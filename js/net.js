'use strict';

/* =================================================================
   Tables entre amis en peer-to-peer (WebRTC via PeerJS)
   Le navigateur de l'hôte fait tourner la table (roulette, cartes,
   jetons de chacun) ; les invités s'y connectent directement et ne
   reçoivent que ce qu'ils ont le droit de voir. Le serveur public de
   PeerJS sert seulement à présenter les navigateurs l'un à l'autre ;
   ses relais TURN prennent le relais si une connexion directe échoue.
   ================================================================= */

const P2P = {
  LIB: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  SRI: 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR',
  PREFIX: 'zerodor-poker-', // identifiant historique, conservé pour rester compatible
  ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  loading: null,

  /** Charge la bibliothèque PeerJS à la demande (il faut une connexion Internet). */
  load() {
    if (window.Peer) return Promise.resolve(window.Peer);
    if (!this.loading) {
      this.loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = this.LIB;
        s.integrity = this.SRI;
        s.crossOrigin = 'anonymous';
        s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('Module peer-to-peer invalide.')));
        s.onerror = () => {
          this.loading = null;
          reject(new Error('Impossible de charger le module peer-to-peer : vérifiez votre connexion Internet.'));
        };
        document.head.append(s);
      });
    }
    return this.loading;
  },

  makeCode() {
    let c = '';
    for (let i = 0; i < 5; i++) c += this.ALPHABET[RNG.int(this.ALPHABET.length)];
    return c;
  },
  hostId(code) { return this.PREFIX + code; },
  normalize(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); },

  /** Lien d'invitation, seulement si le casino est publié à une adresse que l'ami peut ouvrir. */
  inviteLink(code) {
    const local = location.protocol === 'file:' || /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname);
    return local ? null : `${location.origin}${location.pathname}#table=${code}`;
  },

  friendly(e) {
    const T = {
      'browser-incompatible': 'Ce navigateur ne permet pas le jeu en peer-to-peer.',
      network: 'Connexion au service peer-to-peer impossible : vérifiez votre connexion Internet.',
      'server-error': 'Le service de mise en relation ne répond pas. Réessayez dans un instant.',
      'socket-error': 'Le service de mise en relation ne répond pas. Réessayez dans un instant.',
      'socket-closed': 'La connexion au service de mise en relation a été coupée.',
      'ssl-unavailable': 'Connexion sécurisée indisponible.',
    };
    return new Error(T[e && e.type] || (e && e.message) || 'Erreur peer-to-peer.');
  },

  /** Ouvre un « pair » ; avec un identifiant pour l'hôte, sans pour un invité. */
  async openPeer(id) {
    const Peer = await this.load();
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
      const timer = setTimeout(() => { done(); p.destroy(); reject(new Error('Le service de mise en relation ne répond pas. Vérifiez votre connexion Internet.')); }, 15000);
      const onOpen = () => { done(); resolve(p); };
      const onErr = (e) => { done(); p.destroy(); reject(e); };
      function done() { clearTimeout(timer); p.off('open', onOpen); p.off('error', onErr); }
      p.on('open', onOpen);
      p.on('error', onErr);
    });
  },

  /** L'hôte réserve un code de table libre. */
  async openHost() {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = this.makeCode();
      try {
        return { peer: await this.openPeer(this.hostId(code)), code };
      } catch (e) {
        if (e && e.type === 'unavailable-id') continue; // code déjà pris : on en tire un autre
        throw this.friendly(e);
      }
    }
    throw new Error('Impossible de réserver un code de table, réessayez.');
  },

  async openGuest() {
    try { return await this.openPeer(null); } catch (e) { throw this.friendly(e); }
  },

  /** Connexion directe d'un invité à la table de code `code`. */
  dial(peer, code) {
    return new Promise((resolve, reject) => {
      const conn = peer.connect(this.hostId(code), { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => { done(); conn.close(); reject(new Error('L’hôte ne répond pas. Vérifiez le code ou réessayez.')); }, 15000);
      const onErr = (e) => {
        if (e && e.type === 'peer-unavailable') { done(); reject(new Error(`Aucune table ouverte avec le code ${code}.`)); }
      };
      const onOpen = () => { done(); resolve(conn); };
      function done() { clearTimeout(timer); peer.off('error', onErr); conn.off('open', onOpen); }
      peer.on('error', onErr);
      conn.on('open', onOpen);
    });
  },
};

const Net = (() => {
  const GAMES = {};           // type → { prepareCreate, readCreate, startHost, startGuest }
  const GAME_LABEL = { roulette: 'Roulette', blackjack: 'Blackjack', poker: 'Poker' };
  const GONE_AFTER = 120000;  // un invité déconnecté plus de 2 min quitte la table

  const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
  const randomHex = (words = 4) => {
    const a = new Uint32Array(words);
    RNG.getRandomValues(a);
    return [...a].map((x) => x.toString(16).padStart(8, '0')).join('');
  };

  // Avertit avant de fermer la page pendant une partie entre amis.
  const warnUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
  const guardUnload = (on) => {
    if (on) window.addEventListener('beforeunload', warnUnload);
    else window.removeEventListener('beforeunload', warnUnload);
  };

  function register(type, api) { GAMES[type] = api; }

  // ---------------------------------------------------------------
  // Pseudo et dernier jeu choisi
  // ---------------------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } },
  };
  const savedName = () => store.get('zdo-name');

  // ---------------------------------------------------------------
  // Hôte : accueille les invités et relaie l'état de la table
  // ---------------------------------------------------------------
  /**
   * `game` décrit la table :
   *   type, info() → { detail, free, buyIn: { min, max, step, def }, bb? },
   *   join(id, name, stack) → '' ou message d'erreur,
   *   view(id) → ce que voit ce joueur,
   *   handle(id, msg) → réponse éventuelle (objet) à renvoyer,
   *   setConnected(id, ok), leave(id) → { stack } ou { error },
   *   canDrop(id) → peut-on retirer ce joueur maintenant,
   *   closeAll() → Map id → jetons rendus (annule le coup en cours).
   * `onHostView(v)` reçoit la vue de l'hôte à chaque changement.
   */
  function host(peer, code, hostName, game, onHostView) {
    const guests = new Map(); // jeton secret → { id, name, conn, lastSeen }
    const chat = [];
    let closed = false;
    const safeSend = (c, m) => { try { if (c && c.open) c.send(m); } catch (e) { /* connexion fermée */ } };
    const guestOf = (c) => { for (const g of guests.values()) if (g.conn === c) return g; return null; };
    const names = () => [hostName, ...[...guests.values()].map((g) => g.name)];
    const roomInfo = (isHost) => ({ code, game: game.type, isHost, chat: chat.slice(-40), invite: P2P.inviteLink(code) });
    const viewFor = (id, isHost) => { const v = game.view(id); v.room = roomInfo(isHost); return v; };

    function broadcast() {
      if (closed) return;
      onHostView(viewFor('host', true));
      for (const g of guests.values()) if (g.conn) safeSend(g.conn, { t: 'view', v: viewFor(g.id, false) });
    }
    function pushChat(name, text) {
      const t = cleanText(text, 200);
      if (!t) return;
      chat.push({ name, text: t });
      if (chat.length > 100) chat.shift();
      broadcast();
    }

    // Messages des invités : données non fiables, tout est vérifié ici.
    function handle(conn, msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      const g = guestOf(conn);
      if (msg.t === 'hello') {
        safeSend(conn, { t: 'info', game: game.type, host: hostName, ...game.info() });
        return;
      }
      if (msg.t === 'join') {
        if (g) return;
        const name = cleanText(msg.name, 16) || 'Invité';
        const b = game.info().buyIn;
        const stack = Math.floor(Number(msg.buyIn));
        if (!Number.isFinite(stack) || stack < b.min || stack > b.max) {
          safeSend(conn, { t: 'error', msg: `La cave doit être comprise entre ${money(b.min)} et ${money(b.max)}.` });
          return;
        }
        if (names().some((n) => n.toLowerCase() === name.toLowerCase())) {
          safeSend(conn, { t: 'error', msg: 'Ce pseudo est déjà pris à cette table.' });
          return;
        }
        const id = 'g' + randomHex(2);
        const err = game.join(id, name, stack);
        if (err) { safeSend(conn, { t: 'error', msg: err }); return; }
        const token = randomHex();
        guests.set(token, { id, name, conn, lastSeen: Date.now() });
        safeSend(conn, { t: 'joined', token });
        broadcast();
        return;
      }
      if (msg.t === 'resume') {
        const rg = guests.get(String(msg.token));
        if (!rg) { safeSend(conn, { t: 'gone' }); return; }
        rg.conn = conn;
        rg.lastSeen = Date.now();
        game.setConnected(rg.id, true);
        broadcast();
        return;
      }
      if (!g) return;
      g.lastSeen = Date.now();
      if (msg.t === 'chat') { pushChat(g.name, msg.text); return; }
      if (msg.t === 'leave') {
        const r = game.leave(g.id);
        if (r.error) { safeSend(conn, { t: 'left', error: r.error }); return; }
        for (const [tok, x] of guests) if (x === g) guests.delete(tok);
        safeSend(conn, { t: 'left', stack: r.stack });
        setTimeout(() => conn.close(), 600);
        broadcast();
        return;
      }
      const reply = game.handle(g.id, msg);
      if (reply) safeSend(conn, reply);
    }

    peer.on('connection', (conn) => {
      if (closed) { conn.close(); return; }
      conn.on('data', (msg) => { try { handle(conn, msg); } catch (e) { console.error(e); } });
      conn.on('close', () => {
        const g = guestOf(conn);
        if (g) { g.conn = null; g.lastSeen = Date.now(); game.setConnected(g.id, false); }
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
        if (!g.conn && now - g.lastSeen > GONE_AFTER && game.canDrop(g.id)) {
          guests.delete(tok);
          game.leave(g.id);
        }
      }
    }, 10000);

    guardUnload(true);
    return {
      code,
      broadcast,
      chat: (text) => pushChat(hostName, text),
      guestCount: () => guests.size,
      /** Ferme la table : chacun récupère ses jetons. Renvoie ceux de l'hôte. */
      close() {
        if (closed) return 0;
        const stacks = game.closeAll();
        closed = true;
        clearInterval(maint);
        for (const g of guests.values()) safeSend(g.conn, { t: 'closed', stack: stacks.get(g.id) || 0 });
        guests.clear();
        guardUnload(false);
        setTimeout(() => { try { peer.destroy(); } catch (e) { /* ignore */ } }, 1200);
        return stacks.get('host') || 0;
      },
    };
  }

  // ---------------------------------------------------------------
  // Invité : reçoit l'état de la table, envoie ses actions
  // ---------------------------------------------------------------
  /** h = { onView(v), onMessage(m), onEnd(stack, msg), onAbort() } */
  function guest(peer, conn, code, token, h) {
    let ended = false;
    let retries = 0;
    const waiters = {}; // type de réponse → résolveurs
    const s = { conn };

    const send = (m) => { try { if (s.conn && s.conn.open) { s.conn.send(m); return true; } } catch (e) { /* ignore */ } return false; };
    const request = (m, reply, ms = 5000) => new Promise((resolve, reject) => {
      const list = (waiters[reply] = waiters[reply] || []);
      const done = (msg) => { clearTimeout(timer); resolve(msg); };
      const drop = () => { const i = list.indexOf(done); if (i >= 0) list.splice(i, 1); };
      const timer = setTimeout(() => { drop(); reject(new Error('L’hôte ne répond pas.')); }, ms);
      list.push(done);
      if (!send(m)) { clearTimeout(timer); drop(); reject(new Error('Pas de connexion avec l’hôte.')); }
    });

    function onData(msg) {
      if (ended || !msg || typeof msg !== 'object') return;
      if (msg.t === 'view') {
        retries = 0;
        setConn(true);
        if (msg.v && typeof msg.v === 'object') h.onView(msg.v);
        return;
      }
      if (waiters[msg.t] && waiters[msg.t].length) { waiters[msg.t].shift()(msg); return; }
      if (msg.t === 'closed') { end(Number(msg.stack) || 0, 'L’hôte a fermé la table.'); return; }
      if (msg.t === 'gone') { end(0, 'Vous avez été retiré de la table après une longue déconnexion.'); return; }
      if (msg.t === 'error' || msg.t === 'err') { toast(cleanText(msg.msg, 200)); return; }
      if (h.onMessage) h.onMessage(msg);
    }
    function attach(c) {
      s.conn = c;
      c.on('data', onData);
      c.on('close', () => {
        if (ended || s.conn !== c) return;
        setConn(false, 'Connexion à l’hôte perdue… reconnexion en cours.');
        setTimeout(reconnect, 2000);
      });
      c.on('error', () => { /* géré par « close » */ });
    }
    async function reconnect() {
      if (ended) return;
      retries++;
      if (retries > 15) {
        setConn(false, 'Impossible de joindre l’hôte : la table semble fermée.', () => { teardown(); h.onAbort(); });
        return;
      }
      try {
        if (peer.disconnected && !peer.destroyed) peer.reconnect();
        const c = await P2P.dial(peer, code);
        if (ended) { c.close(); return; }
        attach(c);
        c.send({ t: 'resume', token });
      } catch (e) {
        setTimeout(reconnect, 3000);
      }
    }
    function teardown() {
      if (ended) return;
      ended = true;
      guardUnload(false);
      setConn(true);
      setTimeout(() => { try { peer.destroy(); } catch (e) { /* ignore */ } }, 300);
    }
    function end(stack, msg) {
      if (ended) return;
      teardown();
      h.onEnd(stack, msg);
    }

    peer.on('disconnected', () => {
      setTimeout(() => { if (!ended && peer.disconnected && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', () => { /* les erreurs utiles sont gérées par dial() */ });
    attach(conn);
    guardUnload(true);

    s.send = send;
    s.request = request;
    s.chat = (text) => send({ t: 'chat', text });
    /** Quitte la table : { stack } ou { error } si ce n'est pas possible maintenant. */
    s.leave = async () => {
      let r;
      try { r = await request({ t: 'leave' }, 'left', 4000); } catch (e) { r = { stack: 0 }; } // hôte injoignable
      if (r.error) return { error: cleanText(r.error, 200) };
      teardown();
      return { stack: Number(r.stack) || 0 };
    };
    return s;
  }

  // Bandeau de connexion (invités)
  function setConn(ok, msg, onBack) {
    const b = $('#netConn');
    b.hidden = ok;
    if (ok) return;
    b.innerHTML = esc(msg || 'Connexion perdue… reconnexion en cours.')
      + (onBack ? ' <button type="button" class="btn-ctl" id="netConnBack">Retour au hall</button>' : '');
    if (onBack) $('#netConnBack').onclick = () => { b.hidden = true; onBack(); };
  }

  // ---------------------------------------------------------------
  // Dialogue « Créer une table »
  // ---------------------------------------------------------------
  let createType = 'roulette';
  function selectGame(type) {
    if (!GAMES[type]) type = 'roulette';
    createType = type;
    for (const b of $$('#netCreateGame .seg-btn')) b.classList.toggle('on', b.dataset.v === type);
    for (const el of $$('#netCreateDlg [data-for]')) el.hidden = !el.dataset.for.split(' ').includes(type);
  }
  function showCave() {
    $('#netCreateCaveOut').textContent = money(Number($('#netCreateCave').value));
  }
  function openCreate() {
    if (!Wallet.active) return;
    $('#netCreateName').value = savedName();
    for (const g of Object.values(GAMES)) if (g.prepareCreate) g.prepareCreate();
    const r = $('#netCreateCave');
    r.min = '10';
    r.max = String(Math.max(10, Math.floor(Wallet.balance)));
    r.step = '1';
    r.value = r.max;
    showCave();
    selectGame(store.get('zdo-game') || 'roulette');
    $('#netCreateDlg').showModal();
  }
  $('#netCreateGame').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) selectGame(b.dataset.v);
  });
  $('#netCreateCave').addEventListener('input', showCave);
  $('#netCreateGo').addEventListener('click', async () => {
    const btn = $('#netCreateGo');
    const name = cleanText($('#netCreateName').value, 16);
    if (!name) { toast('Choisissez un pseudo.'); $('#netCreateName').focus(); return; }
    const g = GAMES[createType];
    const cfg = g.readCreate();
    if (!cfg) return;
    if (cfg.buyIn > Wallet.balance) { toast('Solde insuffisant.'); return; }
    btn.disabled = true;
    btn.textContent = 'Ouverture de la table…';
    try {
      const { peer, code } = await P2P.openHost();
      store.set('zdo-name', name);
      store.set('zdo-game', createType);
      Wallet.take(cfg.buyIn);
      $('#netCreateDlg').close();
      g.startHost(peer, code, { ...cfg, name });
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Créer la table';
    }
  });

  // ---------------------------------------------------------------
  // Dialogue « Rejoindre une table »
  // ---------------------------------------------------------------
  let joinSession = null; // connexion ouverte pendant le dialogue

  function joinStep(n) {
    $('#netJoinStep1').hidden = n !== 1;
    $('#netJoinStep2').hidden = n !== 2;
  }
  function dropJoinSession() {
    if (joinSession && !joinSession.kept) {
      try { joinSession.peer.destroy(); } catch (e) { /* ignore */ }
    }
    joinSession = null;
  }
  function openJoin(code) {
    if (!Wallet.active) return;
    dropJoinSession();
    $('#netJoinName').value = savedName();
    $('#netJoinCode').value = code ? P2P.normalize(code) : '';
    joinStep(1);
    $('#netJoinDlg').showModal();
    if (code && savedName()) $('#netJoinConnect').focus();
  }
  $('#netJoinDlg').addEventListener('close', dropJoinSession);
  $('#netJoinBack').addEventListener('click', () => { dropJoinSession(); joinStep(1); });

  $('#netJoinConnect').addEventListener('click', async () => {
    const btn = $('#netJoinConnect');
    const name = cleanText($('#netJoinName').value, 16);
    const code = P2P.normalize($('#netJoinCode').value);
    if (!name) { toast('Choisissez un pseudo.'); $('#netJoinName').focus(); return; }
    if (code.length < 4) { toast('Entrez le code de la table que votre ami vous a donné.'); $('#netJoinCode').focus(); return; }
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

  function showJoinBuyIn() {
    const s = joinSession;
    const v = Number($('#netJoinBuyIn').value);
    const bb = s && s.info && Number(s.info.bb);
    $('#netJoinBuyInOut').textContent = money(v) + (bb ? ` · ${Math.round(v / bb)} grosses blindes` : '');
  }
  $('#netJoinBuyIn').addEventListener('input', showJoinBuyIn);

  function onJoinData(session, msg) {
    if (joinSession !== session || !msg || typeof msg !== 'object') return;
    if (msg.t === 'info') {
      const type = GAMES[msg.game] ? msg.game : null;
      if (!type) { toast('Cette table utilise une version plus récente du casino : rechargez la page.'); return; }
      session.info = msg;
      const b = msg.buyIn || {};
      const min = Math.max(1, Number(b.min) || 10);
      const step = Math.max(1, Number(b.step) || 1);
      const max = Math.max(min, Math.min(Number(b.max) || 100000, Math.floor(Wallet.balance)));
      const r = $('#netJoinBuyIn');
      r.min = String(min);
      r.max = String(max);
      r.step = String(step);
      r.value = String(clamp(Number(b.def) || max, min, max));
      r.disabled = Wallet.balance < min;
      showJoinBuyIn();
      const free = Number(msg.free) || 0;
      $('#netJoinInfo').innerHTML = `<b>${GAME_LABEL[type]}</b> chez <b>${esc(cleanText(msg.host, 16))}</b>`
        + `${msg.detail ? ' · ' + esc(cleanText(msg.detail, 120)) : ''} · `
        + `${free > 0 ? `${free} place${free > 1 ? 's' : ''} libre${free > 1 ? 's' : ''}` : 'table complète'}`;
      $('#netJoinGo').disabled = Wallet.balance < min || free <= 0;
      if (Wallet.balance < min) toast(`Il faut au moins ${money(min)} pour cette table.`);
      joinStep(2);
    } else if (msg.t === 'error') {
      toast(cleanText(msg.msg, 200) || 'Impossible de rejoindre.');
      $('#netJoinGo').disabled = false;
    } else if (msg.t === 'joined') {
      const buyIn = session.pendingBuyIn;
      if (!Wallet.take(buyIn)) { session.conn.send({ t: 'leave' }); return; }
      session.kept = true;
      store.set('zdo-name', session.name);
      joinSession = null;
      $('#netJoinDlg').close();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      GAMES[session.info.game].startGuest(session.peer, session.conn, session.code, String(msg.token));
    }
  }

  $('#netJoinGo').addEventListener('click', () => {
    const s = joinSession;
    if (!s || !s.conn) { joinStep(1); return; }
    const buyIn = Number($('#netJoinBuyIn').value);
    if (buyIn > Wallet.balance) { toast('Solde insuffisant.'); return; }
    s.pendingBuyIn = buyIn;
    $('#netJoinGo').disabled = true;
    s.conn.send({ t: 'join', name: s.name, buyIn });
  });

  // ---------------------------------------------------------------
  // Panneau de la table : code, invitation, joueurs, chat
  // (un seul panneau, déplacé dans l'écran du jeu en cours)
  // ---------------------------------------------------------------
  let panelSession = null;
  let lastChatLen = -1;

  function mountPanel(slot, session) {
    const p = $('#netPanel');
    slot.prepend(p);
    p.hidden = false;
    panelSession = session;
    lastChatLen = -1;
    $('#netChatLog').innerHTML = '';
    $('#netPlayers').hidden = true;
    $('#netHostTools').hidden = true;
  }
  function hidePanel() {
    $('#netPanel').hidden = true;
    panelSession = null;
  }
  /** Met à jour le panneau ; `playersHtml` (facultatif) remplit la liste des joueurs. */
  function updatePanel(room, playersHtml) {
    if (!room) return;
    const code = P2P.normalize(room.code);
    $('#netRoomCode').textContent = code;
    $('#netGameLabel').textContent = GAME_LABEL[room.game] || 'Peer-to-peer';
    const link = typeof room.invite === 'string' && /^https?:\/\//.test(room.invite) ? room.invite : null;
    const inp = $('#netInvite');
    const val = link || code;
    if (inp.value !== val) inp.value = val;
    $('#netInviteHelp').textContent = link
      ? `Lien d’invitation (ou code ${code}) :`
      : 'Code à donner à vos amis (dans leur casino : Jouer entre amis → Rejoindre) :';
    $('#netHostTools').hidden = !(room.isHost && panelSession && panelSession.bot);
    const pl = $('#netPlayers');
    pl.hidden = playersHtml == null;
    if (playersHtml != null) pl.innerHTML = playersHtml;
    const chat = Array.isArray(room.chat) ? room.chat : [];
    if (chat.length !== lastChatLen) {
      lastChatLen = chat.length;
      const box = $('#netChatLog');
      box.innerHTML = chat.length
        ? chat.map((m) => `<div class="chat-line"><b>${esc(m.name)}</b> ${esc(m.text)}</div>`).join('')
        : '<div class="muted small">Pas encore de message.</div>';
      box.scrollTop = box.scrollHeight;
    }
  }
  $('#netCopy').addEventListener('click', async () => {
    const input = $('#netInvite');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (e) {
      input.select();
      document.execCommand('copy');
    }
    toast(/^https?:/.test(input.value) ? 'Lien copié : envoyez-le à vos amis.' : `Code ${input.value} copié : envoyez-le à vos amis.`, 'ok');
  });
  $('#netChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('#netChatInput');
    const text = inp.value.trim();
    if (!text || !panelSession || !panelSession.chat) return;
    panelSession.chat(text);
    inp.value = '';
  });
  $('#netBotAdd').addEventListener('click', () => panelSession && panelSession.bot && panelSession.bot('add'));
  $('#netBotRemove').addEventListener('click', () => panelSession && panelSession.bot && panelSession.bot('remove'));

  return { register, host, guest, openCreate, openJoin, mountPanel, hidePanel, updatePanel, cleanText, GAME_LABEL };
})();
