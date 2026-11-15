# Le Zéro d'Or

Un petit casino en ligne avec des **jetons virtuels** (aucun argent réel) : roulette européenne, blackjack et poker Texas Hold'em.

- **Roulette** : un zéro, règles françaises avec la partage. Comme au casino, la bille est lancée automatiquement : « Faites vos jeux », « Derniers jeux », puis « Rien ne va plus ». Les numéros sont tirés par le générateur cryptographique du navigateur (`crypto.getRandomValues`), sans biais de modulo, une fois les jeux faits.
- **Blackjack** : sabot de 6 jeux. Victor, le croupier IA, calcule en direct le gain moyen de chaque option à partir des cartes restantes.
- **Poker** : contre 1 à 5 adversaires IA.
- **Entre amis, en peer-to-peer** : une personne crée une table de roulette (jusqu'à 8 joueurs, chacun avec ses jetons de couleur), de blackjack (jusqu'à 5 joueurs face à Victor) ou de poker ; les autres la rejoignent avec son lien d'invitation ou son code.

Le site est entièrement statique : il suffit d'ouvrir `index.html`. Le jeu entre amis utilise WebRTC via [PeerJS](https://peerjs.com) : le navigateur de celui qui crée la table fait tourner la partie, et le serveur public de PeerJS sert uniquement à mettre les navigateurs en relation.

Les moteurs de jeu (`js/*-core.js`) n'utilisent pas le navigateur et peuvent être testés avec Node.
