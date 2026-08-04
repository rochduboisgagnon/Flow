# Flow 2.1.0

Une réunion réelle d'une heure a été enregistrée avec la 2.0.3. C'est ce qui a produit cette
version : trois défauts qu'aucune des quatre portes ne pouvait voir, et une consolidation
d'interface demandée par-dessus.

## L'audio d'une longue réunion : ce qui se passait, et ce qui se passe maintenant

Une réunion de 55 minutes produit un fichier audio de 101 Mo. Le projet Supabase de Flow refuse
tout objet de plus de **50 Mio** (mesuré : 52 428 800 octets passent, 52 428 801 sont refusés).
Donc l'audio ne montait pas, et trois choses se comportaient mal en même temps.

- **Flow réessayait indéfiniment.** Un refus pour cause de taille ne guérit jamais en attendant ;
  il est maintenant traité comme définitif, au lieu d'une requête par minute pour toujours.
- **La page Notes offrait « Download audio (101 MB) »** pour un fichier qui n'était jamais arrivé.
  Elle distingue maintenant trois états : l'audio est dans votre compte, il est en train d'y
  monter, ou le compte l'a refusé. Le même bouton mort existait pour une réunion **normale**,
  pendant la minute où son audio monte.
- **Le retrait d'un passage échouait en entier** sur une de ces réunions. Il enlève maintenant le
  texte, et le document ne prétend plus avoir fait taire un audio absent.

**Aucun fichier n'a été supprimé, et aucun ne le sera** : le .wav refusé reste sur votre machine,
intact. La page Notes dit où il est et ouvre le dossier. Le transcript et les notes, eux, sont dans
votre compte comme d'habitude.

> Une réunion de plus de 27 minutes ne peut donc pas encore synchroniser son audio. C'est une
> limite du projet, pas un défaut de code, et le choix de la lever (offre payante, compression
> Opus, ou audio gardé localement) est documenté dans le TODO du projet.

## Le son de départ et d'arrêt est actif par défaut

On dicte dans une **autre** application, donc la pastille de Flow est hors du champ de vision. Le
son est la seule confirmation qui arrive quand on regarde ailleurs. Il est synthétisé sur votre
machine et se coupe en un clic dans Settings > General.

## Une interface plus courte, sans rien perdre

- **Les réglages passent de neuf onglets à quatre** : General, Engine, Storage & Privacy, Updates
  & About. Compte, dictée et audio sont dans General ; le modèle de notes est dans Engine, avec
  les autres modèles ; About a fusionné avec Updates. Aucun contrôle n'a disparu.
- **Home ne montre plus qu'une carte**, pleine largeur : la dictée. L'état du moteur est dans
  Settings > Engine, l'enregistrement en cours sur la page Record, la dernière capture dans Notes.
- **L'import vit dans Notes.** Le dépôt de fichiers, les deux options et la file d'attente y sont ;
  un import terminé apparaît dans la liste juste en dessous, tout seul.
- **La page Diagnostics est supprimée.** C'était un tableau de percentiles dans une application de
  dictée. Ses mesures restent dans `flow.log` et sur l'API locale ; le bouton « ouvrir le dossier
  de Flow » a rejoint Storage & Privacy.

## Correction

Le champ de mot de passe se vidait pendant environ une seconde après une connexion réussie, ce qui
avait l'air d'un échec juste avant d'entrer. L'écran passe maintenant directement à « Loading your
account... ».

---

1131 tests, quatre portes vertes (test, lint, typecheck, build).
