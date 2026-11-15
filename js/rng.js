/* =================================================================
   Hasard cryptographique partagé (navigateur et serveur Node)
   Toutes les cartes et tous les numéros du casino viennent d'ici.
   ================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RNG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Générateur cryptographique du système (alimenté par du bruit matériel).
  const C = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
    ? globalThis.crypto
    : require('crypto').webcrypto;

  const one = new Uint32Array(1);

  function u32() {
    C.getRandomValues(one);
    return one[0];
  }

  /** Entier uniforme dans [0, n[, sans biais de modulo (méthode du rejet). */
  function int(n) {
    const limit = 0x100000000 - (0x100000000 % n); // plus grand multiple de n ≤ 2³²
    let x;
    do { x = u32(); } while (x >= limit);
    return x % n;
  }

  /** Réel uniforme dans [0, 1[ sur 53 bits. */
  function float() {
    const a = new Uint32Array(2);
    C.getRandomValues(a);
    return (a[0] * 2097152 + (a[1] >>> 11)) / 9007199254740992;
  }

  function range(a, b) { return a + (b - a) * float(); }

  /** Mélange de Fisher-Yates : toutes les permutations sont équiprobables. */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function pick(arr) { return arr[int(arr.length)]; }

  return { u32, int, float, range, shuffle, pick, getRandomValues: (a) => C.getRandomValues(a) };
});
