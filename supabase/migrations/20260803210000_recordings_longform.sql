-- ---------------------------------------------------------------------------
-- B3 : ce que la table `recordings` ne savait pas encore dire.
--
-- La premiere migration a dessine la table pour un enregistrement FINI : un
-- titre, un instant de depart, un document, une duree. C'etait la bonne forme
-- quand le document arrivait d'un coup, a la fin, depuis un fichier deja
-- complet sur le disque.
--
-- B3 change la chronologie : la ligne existe des le debut de la reunion et le
-- document y monte par tranches pendant une heure. Une ligne peut donc etre
-- OUVERTE, et une ligne ouverte pose une question que le schema d'origine ne
-- pouvait pas trancher : est-ce que quelqu'un enregistre en ce moment, ou est-ce
-- qu'une session est morte en cours de route ?
--
-- Les quatre colonnes ci-dessous existent pour repondre a ca, et rien d'autre.
-- ---------------------------------------------------------------------------

alter table public.recordings
  -- NULL = la reunion n'est pas terminee. C'est le seul etat que la premiere
  -- migration ne pouvait pas representer, et c'est celui qui porte la promesse
  -- du §5.1.4 : un enregistrement interrompu doit etre visible COMME
  -- interrompu, jamais disparu. Une ligne sans `ended_at` que personne
  -- n'alimente plus est exactement ca.
  add column ended_at timestamptz,

  -- Bouge a chaque tranche televersee. C'est ce qui distingue « une session est
  -- morte » de « quelqu'un enregistre en ce moment sur l'autre ordinateur » -
  -- et sans cette distinction, le sauvetage au demarrage marquerait comme
  -- interrompue une reunion en cours ailleurs. Deux ordinateurs sur le meme
  -- compte est le but de toute la refonte ; le sauvetage ne peut pas etre ce
  -- qui le casse.
  add column heartbeat_at timestamptz not null default now(),

  -- La cle de jointure vers `live_notes`, et PAS un doublon de `started_at`.
  --
  -- `live_notes.started_iso` est la chaine que la page a declaree, telle
  -- quelle. `started_at` est un timestamptz : Postgres la normalise, et un
  -- aller-retour par timestamptz puis toISOString ne reproduit pas forcement la
  -- meme chaine octet pour octet. Joindre sur la valeur normalisee perdrait
  -- silencieusement les notes de quelqu'un - la seule partie d'une capture
  -- qu'on ne peut pas regenerer. La chaine exacte est donc gardee a part.
  add column notes_key text not null default '',

  -- B3c : les octets d'audio DEJA arrives dans Storage, contre `audio_bytes`
  -- qui dit ce que pese le fichier en entier. La difference est ce qui rend un
  -- televersement reprenable apres un redemarrage de l'application : sans une
  -- trace cote base, « reprendre » voudrait dire « tout renvoyer », et un .wav
  -- d'une heure pese 115 Mo.
  add column audio_uploaded bigint not null default 0 check (audio_uploaded >= 0);

-- La taille du document, calculee par la base plutot que transportee.
--
-- La page Notes l'affiche. La faire remonter voudrait dire descendre le
-- document ENTIER de chaque reunion pour en mesurer un seul nombre : une
-- centaine de kilooctets par ligne, pour afficher « 84 Ko ». Une colonne
-- generee la donne pour rien et ne peut pas se desynchroniser du document,
-- puisqu'elle EST le document mesure.
alter table public.recordings
  add column doc_bytes integer generated always as (octet_length(doc)) stored;

-- Le sauvetage au demarrage cherche « mes lignes ouvertes dont le pouls est
-- vieux ». Index PARTIEL : les lignes ouvertes sont une poignee a tout instant
-- (zero, la plupart du temps) alors que les lignes fermees s'accumulent sur des
-- annees. Indexer les seules lignes qui peuvent repondre coute la taille de la
-- reponse, pas celle de l'archive.
create index recordings_user_open_idx
  on public.recordings (user_id, heartbeat_at)
  where ended_at is null;

-- Rien a ajouter cote isolation : les politiques de la premiere migration
-- portent sur la LIGNE (`auth.uid() = user_id`), pas sur ses colonnes. Une
-- colonne ajoutee est couverte le jour ou elle apparait. C'est precisement la
-- raison pour laquelle le RLS a ete ecrit table par table et non colonne par
-- colonne, et ce commentaire est ici pour que personne ne « repare » plus tard
-- une absence qui est un choix.
