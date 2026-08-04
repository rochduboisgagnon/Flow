# Flow 2.4.0

Deux choses : le silence pendant une dictée, et les notes qui sortent dans la
langue du transcript.

## L'ordinateur se tait pendant que vous dictez

Tant que le raccourci est tenu (ou tant qu'une dictée mains libres tourne), Flow
coupe le son des **autres** applications, et le rétablit dès que la dictée se
termine. Trois choses ne sont pas coupées, et chacune pour une raison :

- **Flow lui-même**, donc son signal sonore de départ et d'arrêt continue de
  s'entendre. Il est reconnu par le chemin de son exécutable et non par son numéro
  de processus, parce que le son de Flow est joué par un processus séparé lancé du
  même fichier.
- **Ce qui était déjà muet.** Si vous avez coupé votre navigateur vous-même, le
  rétablissement ne le rallume pas : seules les applications que Flow a réellement
  coupées sont rétablies.
- **Ce qui ne joue rien.** Une application silencieuse n'est pas touchée.

**Votre volume général n'est jamais modifié**, et rien ne peut rester muet si Flow
plante : le morceau qui coupe le son vit dans son propre petit processus, et quand
Flow disparaît, ce processus rétablit tout avant de sortir. C'est une garantie plus
solide qu'un filet posé dans Flow, puisqu'un programme qui meurt n'exécute plus
rien.

Deux limites, dites plutôt que découvertes : une application qui **commence** à
jouer pendant la dictée n'est pas coupée, et un enregistrement **long** ne coupe
rien du tout (une réunion peut mélanger le son du PC avec votre micro, et le
couper détruirait exactement ce que vous avez demandé de capturer).

## Les notes sortent dans la langue du transcript, titres compris

Français en entrée, français en sortie. Anglais, anglais. Une autre langue, cette
langue-là.

**Ce qui était cassé n'était pas ce qui était annoncé.** Mesuré contre le vrai
modèle avant de réparer : la prose suivait déjà la langue du transcript. Ce qui ne
la suivait pas, ce sont les quatre titres de section, écrits en dur en français
dans les instructions du modèle. Une réunion en anglais produisait donc du texte
anglais sous « ## Points cles » et « ## Suivis ».

La langue est maintenant lue dans le transcript lui-même (pas dans votre réglage de
dictée, qui ne dit rien d'un fichier importé), nommée au modèle, et les titres la
suivent. Un transcript bilingue ou trop court ne tranche pas plutôt que de deviner.

Au passage, le titre « ## Summary » que le modèle ajoutait parfois au-dessus du
paragraphe d'ouverture disparaît : le document a déjà son titre.

---

1145 tests, quatre portes vertes (test, lint, typecheck, build). Le silence a été
vérifié contre du vrai son sur la machine de développement, et les notes contre le
vrai modèle, avant et après le correctif.
