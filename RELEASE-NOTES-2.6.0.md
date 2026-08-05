# Flow 2.6.0

## Sur macOS, Flow se met à jour tout seul

C'était la demande : ne plus avoir à retélécharger et réinstaller à la main sur le
MacBook. C'est fait, et sans acheter de certificat.

**Ce que ce n'était pas.** L'obstacle avait l'air d'être la signature : Squirrel.Mac,
le mécanisme d'auto-update d'Electron sur Mac, exige une vraie signature Developer
ID. Mais le dialogue « l'application est endommagée » n'est pas piloté par la
qualité de la signature : il est piloté par l'attribut `com.apple.quarantine`, que
le **téléchargeur** pose (Safari, Chrome, Mail). Un fichier que Flow récupère
lui-même n'en porte pas. Flow fait donc l'échange lui-même.

**Comment.** Flow lit un petit document publié à côté du paquet, qui nomme la
version, l'archive, sa taille et son empreinte SHA-256. Il télécharge, vérifie
l'empreinte **avant** que le fichier prenne son nom, détend l'archive avec `ditto`
(l'outil d'Apple, le seul qui préserve les liens et les permissions d'une
application), inspecte ce qui en sort, puis échange l'application par un script qui
attend que Flow soit vraiment fermé. L'ancienne version est mise de côté jusqu'à ce
que la nouvelle soit en place : si quelque chose échoue, elle revient.

Comme sur Windows, l'installation attend un moment calme. Jamais pendant une dictée,
jamais pendant un enregistrement.

## Ce que macOS va vous redemander, et pourquoi

**L'autorisation Accessibilité, après chaque mise à jour.** macOS attache cette
permission à la signature exacte de l'application. Sans certificat, la signature est
recalculée à chaque version, donc le système voit une application différente.

Flow le **dit** maintenant, au lieu de vous laisser le découvrir. La carte de la page
d'accueil explique la cause et ouvre le bon panneau des Réglages Système d'un clic.

Cela répare aussi une panne qui n'avait aucun détecteur : sans cette autorisation,
Flow peut démarrer son écouteur de clavier **avec succès** et ne jamais recevoir une
seule touche. Le raccourci ne répond pas, et tous les voyants sont au vert. C'est
probablement ce qui s'était passé au premier lancement sur le Mac.

**Le trousseau, parfois.** Pour la même raison, macOS peut redemander l'accès à la
session enregistrée après une mise à jour. Si cela arrive, choisissez « Toujours
autoriser ». Flow n'efface jamais la session dans ce cas : elle peut redevenir
lisible au lancement suivant.

## Un message qui envoyait au mauvais endroit

Quand la session enregistrée ne pouvait pas être relue, Flow affichait exactement le
même message que pour quelqu'un qui ne s'est jamais connecté sur cette machine. Les
deux remèdes sont opposés : se connecter, contre autoriser Flow dans le trousseau.
Les deux cas se distinguent maintenant, dans le journal comme à l'écran.

## Sous le capot

La politique de mise à jour (la cadence, la fenêtre calme, l'ordre des vérifications)
est désormais séparée du mécanisme, ce qui a permis d'en ajouter un second sans
dupliquer le premier. Effet de bord qui compte plus que la refonte : la garantie
centrale du système, « une mise à jour ne s'installe jamais pendant une dictée »,
avait zéro test direct depuis la 1.0.0. Elle en a dix.

Le paquet macOS est publié sur le même tag que Windows, avec une attestation de
provenance GitHub, et il est inspecté avant publication : les deux moteurs présents
et exécutables, l'écouteur de clavier **dans le paquet** (la vérification précédente
regardait au mauvais endroit), les liens symboliques intacts, aucun binaire Windows.
