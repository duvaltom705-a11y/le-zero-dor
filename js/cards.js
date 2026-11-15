'use strict';

/* =================================================================
   Cartes à jouer — rendu commun au blackjack et au poker
   Une carte est un entier 0–51 : rang = c >> 2 (0 = deux … 12 = as),
   couleur = c & 3 (0 ♠, 1 ♥, 2 ♦, 3 ♣).
   ================================================================= */
const Cards = (() => {
  const RANK_LABEL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];
  const SUIT_SYM = ['♠', '♥', '♦', '♣'];
  const isRed = (c) => (c & 3) === 1 || (c & 3) === 2;
  const label = (c) => RANK_LABEL[c >> 2] + SUIT_SYM[c & 3];

  /**
   * HTML d'une carte.
   * opts.back : face cachée · opts.cls : classes en plus · opts.anim : animation de distribution
   */
  function html(c, opts = {}) {
    const extra = (opts.cls ? ' ' + opts.cls : '') + (opts.anim ? ' deal' : '');
    if (c == null || c === 'hidden' || opts.back) return `<div class="card back${extra}"></div>`;
    const r = RANK_LABEL[c >> 2];
    const s = SUIT_SYM[c & 3];
    const face = (c >> 2) >= 9 && (c >> 2) <= 11;
    const pip = face ? `<span class="pip face">${r}<small>${s}</small></span>` : `<span class="pip">${s}</span>`;
    return `<div class="card ${isRed(c) ? 'red' : 'blk'}${extra}" data-c="${c}" aria-label="${label(c)}">`
      + `<span class="ci tl">${r}<i>${s}</i></span>${pip}<span class="ci br">${r}<i>${s}</i></span></div>`;
  }

  return { html, label, isRed, RANK_LABEL, SUIT_SYM };
})();
