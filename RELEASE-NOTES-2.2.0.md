# Flow 2.2.0

L'audio d'une réunion reste sur l'ordinateur qui l'a enregistrée. Seuls le
transcript et les notes suivent le compte.

C'est la suite directe de la 2.1.0, qui avait mesuré le problème sans le régler :
le projet Supabase refuse tout objet de plus de 50 Mio, donc l'audio d'une réunion
de plus de 27 minutes ne pouvait pas monter. Trois chemins étaient possibles :
payer une offre plus large, compresser en Opus, ou garder l'audio local. C'est le
troisième qui a été choisi.

## Ce que ça change pour vous

- **Une réunion enregistrée est écoutable et téléchargeable sur la machine qui
  l'a enregistrée**, quelle que soit sa durée. Plus aucun refus de taille, plus
  aucune attente d'envoi.
- **Ouverte sur un autre ordinateur, la même réunion montre son transcript et ses
  notes**, avec une ligne qui dit où est l'enregistrement. C'est la contrepartie
  de cette décision, et elle est écrite à l'écran plutôt que laissée à deviner.
- **L'audio des réunions faites avec une 2.0.x est rapatrié tout seul**, au
  premier démarrage : Flow le redescend du compte, vérifie sa taille, le met en
  place, et libère l'objet. Si le réseau manque, rien ne bouge et il réessaie au
  lancement suivant.
- **Réglages > Storage & Privacy dit ce que le dossier audio pèse.** Rien ne
  supprime ces fichiers tout seul, donc l'application doit dire ce qu'ils
  prennent : 115 Mo par heure d'enregistrement. Supprimer une réunion dans Notes
  supprime son audio avec elle.
- **Retirer un passage d'une réunion** réécrit maintenant le fichier sur place :
  trois requêtes réseau de moins, et le silence est écrit avant que le document
  l'annonce, comme avant.

## Ce qui a été supprimé

Le téléversement reprenable (protocole TUS écrit à la main, tranches de 6 Mo,
reprise après coupure, adresse persistée) est **supprimé, pas désactivé** : sa
raison d'être a disparu. Le seau audio du compte reste privé et son test
d'isolation reste en place, parce qu'un seau ouvert serait un trou même vide.

## Ce que ça coûte, dit plutôt que découvert

Une réunion enregistrée sur l'ordinateur A n'est pas écoutable sur l'ordinateur B.
Le dossier audio grandit et rien ne l'élague automatiquement. Ces deux points sont
la conséquence directe du choix, et ils sont visibles dans l'application.

---

1121 tests, quatre portes vertes (test, lint, typecheck, build). Le nouveau module
qui possède le dossier audio est couvert par 15 tests, dont les deux règles qui
comptent le plus : un téléchargement coupé n'est jamais mis en place, et un
fichier dont la ligne est illisible n'est jamais supprimé.
