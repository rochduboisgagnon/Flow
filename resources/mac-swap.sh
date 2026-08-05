#!/bin/sh
# ---------------------------------------------------------------------------
# 2026-08-04 : L'ECHANGE DU BUNDLE macOS. LE SEUL GESTE IRREVERSIBLE DE FLOW.
#
# Roch : « j'aimerais faire en sorte que l'app sur macOS se update sans devoir
# installer l'ancienne version ». Sur Windows, electron-updater echange
# l'installeur NSIS. Sur macOS, Squirrel.Mac exige une signature Developer ID que
# Roch a decide de ne pas acheter, donc l'echange se fait ici.
#
# ---------------------------------------------------------------------------
# POURQUOI UN SCRIPT DETACHE, ET PAS DU CODE DANS L'APPLICATION
# ---------------------------------------------------------------------------
#
# On ne peut pas remplacer sans risque un .app EN COURS D'EXECUTION depuis
# l'interieur. macOS autorise le unlink d'un fichier ouvert, donc un `rm -rf`
# « reussit » souvent et laisse le processus vivant sur des inodes delies ; la
# premiere lecture paresseuse d'un framework, d'une icone ou d'un binaire de
# moteur prend alors un ENOENT. Ca ressemble a un plantage aleatoire, et ca
# n'arrive qu'en production.
#
# Ce script est donc lance DETACHE (setsid par spawn detached), il attend que
# Flow soit vraiment mort, puis il echange.
#
# ET IL EST COPIE HORS DU BUNDLE avant d'etre lance (voir macZipChannel.ts).
# Deux raisons : `sh` lit son script de facon INCREMENTALE, donc un script qui
# vit dans le bundle qu'il est en train de supprimer peut se faire couper en deux
# au milieu ; et la copie recoit un chmod 0755 explicite, ce qui supprime la
# question de savoir si extraResources preserve le bit d'execution au lieu d'y
# repondre par esperance.
#
# Usage : mac-swap.sh <pid> <nouveauBundle> <bundleCible> <journal>
# ---------------------------------------------------------------------------

PID="$1"
NEW="$2"
TARGET="$3"
LOG="$4"

if [ -z "$PID" ] || [ -z "$NEW" ] || [ -z "$TARGET" ] || [ -z "$LOG" ]; then
  echo "mac-swap.sh: quatre arguments attendus" >&2
  exit 2
fi

# Journal SEPARE, et surtout PAS flow.log : celui-la passe par logQueue, et deux
# ecrivains sur un journal rotatif est exactement la facon dont un journal se
# corrompt. Ce fichier-ci est la premiere chose a lire quand une mise a jour ne
# s'est pas passee comme prevu.
exec >>"$LOG" 2>&1
echo "--- $(date -u +%Y-%m-%dT%H:%M:%SZ) echange demande : pid=$PID"
echo "    nouveau : $NEW"
echo "    cible   : $TARGET"

abort() {
  echo "ABANDON : $1"
  echo "    l'application installee n'a PAS ete touchee."
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Attendre que Flow soit mort. BORNE, et jamais tue.
# ---------------------------------------------------------------------------
# `kill -0` est le test honnete : il ne signale rien, il demande seulement si le
# processus existe encore.
#
# JAMAIS `kill -9`, et ce n'est pas de la delicatesse. Une application qui refuse
# de se fermer est une application au milieu de quelque chose, et le before-quit
# de Flow fait des sauvetages SYNCHRONES : longRec.rescueOnQuit(),
# importQueue.rescueOnQuit(), logQueue.flushSync(). La tuer est precisement la
# facon de perdre l'enregistrement d'une reunion - c'est-a-dire la seule donnee
# de ce produit qui ne peut pas etre refaite.
#
# La boucle est BORNEE : un `while true` ici laisserait un processus zombie qui
# tient un bundle en otage indefiniment.
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    abort "Flow tourne encore apres 24 secondes (pid $PID). Il est peut-etre en train de sauver un enregistrement."
  fi
  sleep 0.2
done
echo "    Flow s'est ferme apres $((i * 2)) dixiemes de seconde"

# ---------------------------------------------------------------------------
# 2. Re-verifier les deux chemins AVANT tout geste irreversible.
# ---------------------------------------------------------------------------
# La regle de la revue adverse de F8, appliquee a un bundle entier : l'ancien
# reste en place jusqu'a ce qu'un remplacant VERIFIE soit pret a prendre son nom.
[ -d "$NEW/Contents/MacOS" ] || abort "le nouveau bundle est incomplet : $NEW"
[ -d "$TARGET" ] || abort "l'application cible a disparu pendant l'attente : $TARGET"

# ---------------------------------------------------------------------------
# 3. Retirer la quarantaine, defensivement.
# ---------------------------------------------------------------------------
# com.apple.quarantine n'est pas pose par le noyau : il est pose par le
# TELECHARGEUR (Safari, Chrome, Mail). Un https.get de Node qui ecrit avec
# createWriteStream ne le pose pas, et les membres d'un zip n'en portent pas, donc
# le bundle detendu ne devrait en porter aucun. C'est ce mecanisme, et non la
# qualite de la signature, qui rend cette approche possible sans certificat : le
# dialogue « endommage » est pilote par le drapeau de quarantaine.
#
# Cette ligne est donc un no-op attendu. Elle reste parce qu'elle coute zero et
# supprime toute une classe de « la mise a jour a tourne et maintenant l'app dit
# qu'elle est endommagee ». Elle n'est JAMAIS une condition d'abandon : les octets
# ont deja ete verifies contre un SHA-256 publie, ce qui est un controle plus fort
# que le verdict que Gatekeeper rendrait sur une signature ad-hoc.
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. L'echange, avec retour arriere.
# ---------------------------------------------------------------------------
# Un `rm -rf "$TARGET" && mv "$NEW" "$TARGET"` naif ouvre une fenetre pendant
# laquelle AUCUNE application n'existe, et si le mv echoue (disque plein,
# permissions, volume different) Roch n'a plus de Flow du tout. Ici l'etape
# destructive n'arrive qu'APRES que le nouveau bundle a pris sa place.
OLD="$TARGET.old-$$"
mv "$TARGET" "$OLD" || abort "impossible de deplacer l'ancien bundle (permissions sur $(dirname "$TARGET") ?)"
if ! mv "$NEW" "$TARGET"; then
  mv "$OLD" "$TARGET" && echo "    ancien bundle remis en place"
  abort "impossible d'installer le nouveau bundle"
fi
rm -rf "$OLD"
echo "    echange fait"

# ---------------------------------------------------------------------------
# 5. Relancer.
# ---------------------------------------------------------------------------
# `open` et PAS `open -n` : -n forcerait une NOUVELLE instance, donc deux Flow.
# Et le verrou d'instance unique de l'application rend le pire cas benin - si
# l'ancien processus etait encore vivant, `open` ne fait que le mettre au premier
# plan au lieu de demarrer un second moteur.
#
# Relancer compte : Flow est un demon de raccourci, et une mise a jour qui laisse
# la machine sans push-to-talk jusqu'a la prochaine ouverture de session est un
# pire resultat qu'une fenetre qui reapparait.
open "$TARGET" || abort "le nouveau bundle est en place mais n'a pas voulu se lancer"

# ---------------------------------------------------------------------------
# 6. Le filet : verifier qu'il est VRAIMENT revenu.
# ---------------------------------------------------------------------------
# Le pire resultat possible de tout ce chemin est un echange reussi suivi d'un
# refus de lancement, et il ne doit pas etre silencieux : personne ne regarde un
# journal quand tout va bien, donc c'est ici que la ligne doit crier.
sleep 10
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  echo "    Flow tourne de nouveau. Mise a jour terminee."
  exit 0
fi
echo "!!! LE NOUVEAU FLOW N'A PAS DEMARRE. Le bundle est en place dans $TARGET."
echo "!!! Ouverture du Finder dessus pour qu'il soit lancable a la main."
open -R "$TARGET" || true
exit 1
