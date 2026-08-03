-- ---------------------------------------------------------------------------
-- B3c : ce qu'il faut garder pour REPRENDRE un televersement d'audio.
--
-- Un .wav d'une heure pese 115 Mo, et le plan demande qu'une coupure reprenne
-- « sans reexpedier ce qui a atterri ». Le protocole TUS le permet : chaque
-- televersement a une URL unique, et un HEAD dessus dit ou en est le serveur.
--
-- LE PROBLEME QUE CES DEUX COLONNES RESOLVENT, ET LUI SEUL : cette URL encode
-- un identifiant OPAQUE (le serveur y met bucket/objet/version en base64url).
-- Elle ne se reconstruit pas a partir du chemin de l'objet. Donc si Flow se
-- ferme au milieu d'un televersement et ne l'a gardee nulle part, le lancement
-- suivant n'a aucun moyen de retrouver les 90 Mo deja arrives : il recommence a
-- zero. La garder est la difference entre « reprenable » et « reprenable tant
-- que l'application ne redemarre pas ».
--
-- POURQUOI DANS LA BASE ET PAS SUR LE DISQUE. Ce serait un sixieme magasin
-- local, dans une vague qui vient d'en retirer cinq. Et elle appartient a la
-- reunion, pas a la machine : c'est exactement ce qu'une colonne dit.
--
-- CE QU'ELLE N'EST PAS : un secret. L'URL ne donne acces a rien d'autre qu'a la
-- poursuite d'un televersement dont le contenu vient de cette machine, et le
-- RLS de storage.objects est reevalue a CHAQUE requete non-HEAD (verifie dans le
-- code du serveur Storage) - la connaitre ne permet donc pas d'ecrire chez
-- quelqu'un d'autre. Elle vit derriere les memes politiques que la ligne qui la
-- porte, comme tout le reste de cette table.
-- ---------------------------------------------------------------------------

alter table public.recordings
  add column audio_upload_url text not null default '',

  -- Ce que le SERVEUR annonce (en-tete `Upload-Expires` de l'extension TUS
  -- `expiration`), et non vingt-quatre heures comptees ici. La plateforme
  -- hebergee dit 24 h, mais la valeur est configurable par deploiement : une
  -- arithmetique locale se tromperait en silence, et se tromper veut dire
  -- envoyer 6 Mo sur une adresse morte.
  add column audio_upload_expires timestamptz;
