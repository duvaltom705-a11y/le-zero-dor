# Le Zéro d'Or

Un petit casino en ligne avec des **jetons virtuels** (aucun argent réel) : roulette européenne, blackjack et poker Texas Hold'em.

- **Roulette** : un zéro, règles françaises avec la partage. Les numéros sont tirés par le générateur cryptographique du navigateur (`crypto.getRandomValues`), sans biais de modulo.
- **Blackjack** : sabot de 6 jeux. Victor, le croupier IA, calcule en direct le gain moyen de chaque option à partir des cartes restantes.
- **Poker** : contre 1 à 5 adversaires IA, ou **entre amis en peer-to-peer** : une personne crée une table, les autres la rejoignent avec son code ou son lien d'invitation.

Le site est entièrement statique : il suffit d'ouvrir `index.html`. Le poker entre amis utilise WebRTC via [PeerJS](https://peerjs.com) ; le serveur public de PeerJS sert uniquement à mettre les navigateurs en relation.
