'use strict';

/* =================================================================
   Le Zéro d'Or — portefeuille, écrans, hall des jeux
   et utilitaires partagés par tous les jeux
   ================================================================= */

// ---------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const FMT0 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const FMT2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = new Intl.NumberFormat('fr-FR');
const money = (x) => (Number.isInteger(Math.round(x * 100) / 100) ? FMT0 : FMT2).format(x);
const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + money(Math.abs(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const netClass = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');

// ---------------------------------------------------------------
// Sons (Web Audio, purement décoratifs — n'influencent rien)
// ---------------------------------------------------------------
const Sound = {
  ctx: null,
  on: true,
  noiseBuf: null,
  load() {
    try { this.on = localStorage.getItem('zdo-sound') !== 'off'; } catch (e) { /* stockage indisponible */ }
  },
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem('zdo-sound', this.on ? 'on' : 'off'); } catch (e) { /* ignore */ }
    renderSoundButtons();
    return this.on;
  },
  ac() {
    if (!this.on) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  noise(ac) {
    if (!this.noiseBuf) {
      const len = Math.floor(ac.sampleRate * 0.06);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 5);
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  },
  click(freq, vol, when = 0, q = 3) {
    const ac = this.ac();
    if (!ac) return;
    const src = ac.createBufferSource();
    src.buffer = this.noise(ac);
    const f = ac.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(ac.destination);
    src.start(ac.currentTime + when);
  },
  tick(vol) { this.click(2600 + Math.random() * 1400, vol); },
  chip() { this.click(1500, 0.55); this.click(1950, 0.35, 0.045); },
  card() { this.click(4200, 0.35, 0, 0.8); },
  flip() { this.click(3200, 0.3, 0, 1.2); this.click(2400, 0.2, 0.05, 1.2); },
  win() {
    const ac = this.ac();
    if (!ac) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((fr, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const t = ac.currentTime + i * 0.09;
      o.type = 'sine'; o.frequency.value = fr;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + 0.55);
    });
  },
  turn() {
    const ac = this.ac();
    if (!ac) return;
    const o = ac.createOscillator();
    const g = ac.createGain();
    const t = ac.currentTime;
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + 0.3);
  },
};

const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
function renderSoundButtons() {
  for (const b of $$('.sound-btn')) {
    b.innerHTML = Sound.on ? ICON_ON : ICON_OFF;
    b.title = Sound.on ? 'Couper le son' : 'Activer le son';
    b.setAttribute('aria-label', b.title);
  }
}
document.addEventListener('click', (e) => { if (e.target.closest('.sound-btn')) Sound.toggle(); });

// ---------------------------------------------------------------
// Messages éphémères et dialogues génériques
// ---------------------------------------------------------------
let toastTimer = 0;
function toast(msg, kind = 'warn') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/** Fenêtre de confirmation. Renvoie une promesse <boolean>. */
function confirmBox(title, html, okLabel = 'Confirmer', cancelLabel = 'Annuler') {
  const dlg = $('#confirmDlg');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = html;
  $('#confirmOk').textContent = okLabel;
  $('#confirmCancel').textContent = cancelLabel;
  return new Promise((resolve) => {
    const done = (v) => {
      $('#confirmOk').onclick = null;
      $('#confirmCancel').onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    $('#confirmOk').onclick = () => done(true);
    $('#confirmCancel').onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
}

/** Fenêtre d'information simple (un seul bouton). */
function infoBox(title, html, okLabel = 'OK') {
  const dlg = $('#confirmDlg');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = html;
  $('#confirmOk').textContent = okLabel;
  $('#confirmCancel').hidden = true;
  return new Promise((resolve) => {
    const done = () => {
      $('#confirmOk').onclick = null;
      dlg.onclose = null;
      $('#confirmCancel').hidden = false;
      if (dlg.open) dlg.close();
      resolve(true);
    };
    $('#confirmOk').onclick = done;
    dlg.onclose = done;
    dlg.showModal();
  });
}

// ---------------------------------------------------------------
// Portefeuille du joueur (la cave choisie à l'entrée)
// ---------------------------------------------------------------
const Wallet = {
  buyIn: 0,
  balance: 0,
  active: false,
  take(x) {
    if (x > this.balance + 1e-9) return false;
    this.balance = Math.round((this.balance - x) * 100) / 100;
    Hall.render();
    return true;
  },
  give(x) {
    this.balance = Math.round((this.balance + x) * 100) / 100;
    Hall.render();
  },
};

function showScreen(id) {
  for (const s of $$('.screen')) s.classList.toggle('active', s.id === id);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------
// Peer-to-peer (WebRTC via PeerJS)
// Les navigateurs des joueurs se connectent directement entre eux.
// Le serveur public gratuit de PeerJS sert seulement à les présenter
// l'un à l'autre (échange d'adresses) ; les relais TURN de PeerJS
// prennent le relais quand une connexion directe est impossible.
// ---------------------------------------------------------------
const P2P = {
  LIB: 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  SRI: 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR',
  PREFIX: 'zerodor-poker-',
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
    return local ? null : `${location.origin}${location.pathname}#poker=${code}`;
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

// Lien d'invitation : …/#poker=ABCDE
const inviteMatch = location.hash.match(/poker=([A-Za-z0-9]{4,8})/);
const pendingInvite = inviteMatch ? inviteMatch[1].toUpperCase() : null;

// ---------------------------------------------------------------
// Entrée du casino : choix de la cave
// ---------------------------------------------------------------
const MIN_BUYIN = 10;
const MAX_BUYIN = 100000;
const Entrance = (() => {
  const amountsEl = $('#amounts');
  const customInput = $('#customAmount');
  const enterBtn = $('#enterBtn');
  let selected = null;

  function validate() {
    const v = selected;
    let err = '';
    let ok = false;
    if (v === null || Number.isNaN(v)) err = '';
    else if (!Number.isInteger(v)) err = 'Entrez un montant entier, sans centimes.';
    else if (v < MIN_BUYIN) err = `Le minimum pour entrer est de ${money(MIN_BUYIN)}.`;
    else if (v > MAX_BUYIN) err = `Le maximum pour entrer est de ${money(MAX_BUYIN)}.`;
    else ok = true;
    $('#lobbyError').textContent = err;
    enterBtn.disabled = !ok;
    enterBtn.textContent = ok ? `Entrer avec ${money(v)}` : 'Entrer au casino';
    return ok;
  }

  amountsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.amount');
    if (!b) return;
    selected = Number(b.dataset.amount);
    customInput.value = '';
    for (const x of amountsEl.children) {
      x.classList.toggle('selected', x === b);
      x.setAttribute('aria-checked', String(x === b));
    }
    validate();
  });
  customInput.addEventListener('input', () => {
    for (const x of amountsEl.children) { x.classList.remove('selected'); x.setAttribute('aria-checked', 'false'); }
    selected = customInput.value === '' ? null : Number(customInput.value);
    validate();
  });
  customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && validate()) enter(selected); });
  enterBtn.addEventListener('click', () => { if (validate()) enter(selected); });

  function enter(amount) {
    Wallet.buyIn = amount;
    Wallet.balance = amount;
    Wallet.active = true;
    Hall.open();
    if (pendingInvite && typeof PokerUI !== 'undefined') {
      setTimeout(() => PokerUI.openJoin(pendingInvite), 250);
    }
  }

  if (pendingInvite) {
    const b = $('#inviteBanner');
    b.hidden = false;
    b.innerHTML = `Vous êtes invité à une table de poker (salle <b>${esc(pendingInvite)}</b>). Choisissez votre cave pour entrer.`;
  }

  return { validate };
})();

// ---------------------------------------------------------------
// Hall des jeux
// ---------------------------------------------------------------
const Hall = {
  open() {
    showScreen('hall');
    this.render();
  },
  render() {
    const bal = Wallet.balance;
    const net = bal - Wallet.buyIn;
    $('#hallBalance').textContent = money(bal);
    $('#hallIn').textContent = money(Wallet.buyIn);
    const n = $('#hallNet');
    n.textContent = signed(net);
    n.className = netClass(net);
    const broke = bal < 1;
    for (const b of $$('.game-play')) b.disabled = broke;
    $('#hallBroke').hidden = !broke;
  },
};

$('#hallGames').addEventListener('click', (e) => {
  const b = e.target.closest('[data-game]');
  if (!b || b.disabled) return;
  const g = b.dataset.game;
  if (g === 'roulette') Roulette.enter();
  else if (g === 'blackjack') Blackjack.enter();
  else if (g === 'poker') PokerUI.openSolo();
  else if (g === 'p2p-create') PokerUI.openCreate();
  else if (g === 'p2p-join') PokerUI.openJoin();
});

// Caisse : recharger le portefeuille
$('#cashierBtn').addEventListener('click', () => {
  $('#cashierAmount').value = '';
  $('#cashierDlg').showModal();
});
$('#hallBrokeBtn').addEventListener('click', () => $('#cashierBtn').click());
$('#cashierAmounts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  addFunds(Number(b.dataset.add));
});
$('#cashierOk').addEventListener('click', () => {
  const v = Number($('#cashierAmount').value);
  if (!Number.isInteger(v) || v < MIN_BUYIN || v > MAX_BUYIN) {
    toast(`Montant entre ${money(MIN_BUYIN)} et ${money(MAX_BUYIN)}.`);
    return;
  }
  addFunds(v);
});
function addFunds(v) {
  Wallet.buyIn += v;
  Wallet.give(v);
  $('#cashierDlg').close();
  toast(`${money(v)} ajoutés à votre portefeuille.`, 'ok');
}

// Quitter le casino
$('#exitBtn').addEventListener('click', async () => {
  const net = Wallet.balance - Wallet.buyIn;
  const html = `<div class="summary">
      <div><span>Total déposé</span><span>${money(Wallet.buyIn)}</span></div>
      <div><span>Vous repartez avec</span><span>${money(Wallet.balance)}</span></div>
      <div><span>Résultat</span><span class="${netClass(net)}">${signed(net)}</span></div>
    </div>`;
  if (!(await confirmBox('Quitter le casino ?', html, 'Encaisser et partir', 'Rester'))) return;
  const last = $('#lastSession');
  last.hidden = false;
  last.innerHTML = `Dernière visite : déposé ${money(Wallet.buyIn)} → reparti avec ${money(Wallet.balance)} `
    + `<b class="${netClass(net)}">(${signed(net)})</b>`;
  Wallet.active = false;
  Wallet.balance = 0;
  Wallet.buyIn = 0;
  showScreen('lobby');
});

// Retour au hall depuis un jeu (boutons « Hall »)
function backToHall() {
  Hall.open();
}

// ---------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------
Sound.load();
renderSoundButtons();
