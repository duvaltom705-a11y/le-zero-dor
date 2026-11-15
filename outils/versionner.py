#!/usr/bin/env python3
"""Ajoute à chaque fichier CSS/JS appelé par index.html une empreinte de son contenu
(ex. js/net.js?v=1a2b3c4d). Après une mise en ligne, les navigateurs chargent ainsi
toujours les scripts qui correspondent à la page, au lieu d'anciennes copies en cache.

À lancer avant chaque publication :  python3 outils/versionner.py
"""
import hashlib
import pathlib
import re

RACINE = pathlib.Path(__file__).resolve().parent.parent
PAGE = RACINE / 'index.html'
LIEN = re.compile(r'(href|src)="((?:css|js)/[^"?]+)(?:\?v=[0-9a-f]*)?"')


def empreinte(chemin):
    return hashlib.sha1((RACINE / chemin).read_bytes()).hexdigest()[:8]


html = PAGE.read_text(encoding='utf-8')
nouveau = LIEN.sub(lambda m: f'{m.group(1)}="{m.group(2)}?v={empreinte(m.group(2))}"', html)
if nouveau != html:
    PAGE.write_text(nouveau, encoding='utf-8')
for attr, chemin in LIEN.findall(nouveau):
    print(f'{chemin}?v={empreinte(chemin)}')
