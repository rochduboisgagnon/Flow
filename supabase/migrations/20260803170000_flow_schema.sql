-- ---------------------------------------------------------------------------
-- A1 : le socle. Tout ce que Flow gardait sur le disque de l'utilisateur vit
-- ici, et la seule chose qui reste locale est l'application elle-meme.
--
-- CE FICHIER EST LA PREMIERE MIGRATION, ET L'ISOLATION Y EST ECRITE EN MEME
-- TEMPS QUE LES TABLES. C'est la seule discipline qui tient : une table creee
-- aujourd'hui et protegee la semaine prochaine est une table qui a passe une
-- semaine ouverte, et personne ne s'en apercoit parce que rien ne casse. Le
-- plan nomme d'ailleurs cette panne d'avance, dans les regressions a chercher :
-- « une machine qui voit les donnees d'un autre compte, faute de RLS sur une
-- table ajoutee plus tard ».
--
-- DEUX CHOSES QUE LE RLS NE FAIT PAS, et qu'il faut savoir en le lisant :
--
--  - `service_role` le CONTOURNE, par construction. C'est exactement pourquoi
--    la clef de service ne descend jamais dans l'application ni dans le depot,
--    et pourquoi elle n'existe que dans les Edge Functions (ou Supabase
--    l'injecte lui-meme sous SUPABASE_SERVICE_ROLE_KEY).
--  - La clef publiable qui part dans l'installeur n'est PAS un secret. Elle
--    dit « je suis l'application Flow », jamais « je suis Roch ». Ce qui
--    distingue un compte d'un autre est le jeton de session, et ce que ce
--    fichier ecrit est la seule chose qui transforme ce jeton en frontiere.
--
-- Le schema suit les magasins locaux tels qu'ils existent (settings.json,
-- dictionary.json, stats.json, history.json, recent.json, live-notes.json et
-- le dossier history/), pas une idee de ce qu'ils devraient etre. La refonte
-- deplace les donnees ; elle ne les redessine pas en passant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. REGLAGES
--
-- Une ligne par compte, et le contenu en jsonb plutot qu'en colonnes typees.
-- C'est un choix, pas une paresse : FlowSettings compte une trentaine de
-- champs qui bougent a chaque vague, et une colonne par reglage voudrait dire
-- une migration a chaque case a cocher ajoutee. Ce qui rend le jsonb sur ici,
-- c'est que l'application valide DEJA tout ce qu'elle lit (sanitizeSettings :
-- champ inconnu jete, mauvais type ramene au defaut). La base n'est pas le
-- dernier rempart contre un reglage malforme ; ce code l'est, et il existe.
-- ---------------------------------------------------------------------------
create table public.settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. DICTIONNAIRE
--
-- La table qui merite le plus d'egards du lot : c'est un vocabulaire tape a la
-- main, un terme a la fois, sur des mois. Rien ici ne doit pouvoir en perdre
-- une ligne en silence.
--
-- `aliases` est un vrai text[] et pas du jsonb : c'est une liste de chaines,
-- interrogeable, et le type le dit.
-- ---------------------------------------------------------------------------
create table public.dictionary (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  term       text        not null check (length(term) between 1 and 80),
  aliases    text[]      not null default '{}',
  kind       text        not null check (kind in ('vocabulary', 'replacement')),
  starred    boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Le meme terme deux fois dans le meme compte n'a pas de sens, et la casse ne
-- doit pas suffire a le contourner : « AGR » et « agr » sont le meme terme.
-- Cet index est PAR COMPTE - deux personnes ont evidemment le droit au meme mot.
create unique index dictionary_user_term_idx on public.dictionary (user_id, lower(term));

-- ---------------------------------------------------------------------------
-- 3. STATISTIQUES
--
-- Une ligne par jour et par compte, ce qui est exactement la granularite du
-- fichier local : il n'existe deliberement aucune forme au niveau de l'enonce,
-- et ce n'est pas ce schema qui va en inventer une.
--
-- `apps` n'existe QUE si l'attribution par application est activee. Le NULL
-- est donc porteur de sens - « on ne mesurait pas » - et se distingue d'un
-- objet vide, qui voudrait dire « on mesurait et il n'y avait rien ».
-- ---------------------------------------------------------------------------
create table public.stats_days (
  user_id    uuid   not null references auth.users (id) on delete cascade,
  day        date   not null,
  words      integer not null default 0 check (words >= 0),
  ms         bigint  not null default 0 check (ms >= 0),
  utterances integer not null default 0 check (utterances >= 0),
  apps       jsonb,
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- 4. DICTEES
--
-- L'historique des enonces inseres au curseur. `truncated` dit que le texte a
-- ete coupe a la limite, pour que la page puisse le DIRE au lieu de presenter
-- un fragment comme s'il etait le tout.
-- ---------------------------------------------------------------------------
create table public.dictations (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid        not null references auth.users (id) on delete cascade,
  said_at   timestamptz not null,
  text      text        not null,
  truncated boolean     not null default false
);

-- La page lit « les plus recentes d'abord », et la retention purge par la meme
-- colonne. Un seul index sert les deux.
create index dictations_user_recent_idx on public.dictations (user_id, said_at desc);

-- ---------------------------------------------------------------------------
-- 5. ENREGISTREMENTS
--
-- Une reunion : son document (resume plus transcript horodate) et, si
-- l'utilisateur l'a voulu, son audio. Le document est du texte et vit ICI ;
-- l'audio est un objet de Storage et seul son chemin vit ici. Un .wav d'une
-- heure pese 115 Mo, ce qui n'a rien a faire dans une ligne de table.
--
-- `audio_path` vide, et non NULL, veut dire « pas d'audio garde », qui est le
-- cas par defaut du produit.
-- ---------------------------------------------------------------------------
create table public.recordings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  title       text        not null default '',
  started_at  timestamptz not null,
  duration_ms bigint      not null default 0 check (duration_ms >= 0),
  doc         text        not null default '',
  audio_path  text        not null default '',
  audio_bytes bigint      not null default 0 check (audio_bytes >= 0),
  -- v6 c7 : vrai tant que la destination n'a pas ete choisie. L'equivalent du
  -- dossier staging/, qui existait parce qu'un enregistrement interrompu doit
  -- etre visible comme interrompu, jamais disparu.
  staged      boolean     not null default false,
  saved_at    timestamptz not null default now()
);

create index recordings_user_recent_idx on public.recordings (user_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 6. NOTES PRISES PENDANT UN ENREGISTREMENT
--
-- Table a part, et pas une colonne de `recordings`, pour une raison de
-- CHRONOLOGIE : ces notes s'ecrivent PENDANT la reunion, quand la ligne
-- d'enregistrement n'existe pas encore. Elles sont donc rattachees a l'instant
-- de depart que la page declare (`started_iso`), exactement comme le magasin
-- local, dont c'est aussi la garde : une note visant un enregistrement deja
-- classe est refusee plutot que d'atterrir sur le suivant.
--
-- C'est la seule partie d'une capture qu'on ne peut pas regenerer. Elle est
-- traitee en consequence.
-- ---------------------------------------------------------------------------
create table public.live_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  started_iso text        not null,
  at_ms       bigint      not null default 0 check (at_ms >= 0),
  text        text        not null,
  created_at  timestamptz not null default now()
);

create index live_notes_user_session_idx on public.live_notes (user_id, started_iso, at_ms);

-- ---------------------------------------------------------------------------
-- L'ISOLATION
--
-- `enable row level security` sans aucune politique = personne ne lit rien.
-- C'est le bon defaut et c'est celui qu'on installe d'abord, table par table ;
-- les politiques qui suivent ouvrent ensuite exactement une chose : ses
-- propres lignes.
--
-- `force row level security` en plus, parce que « enable » seul laisse passer
-- le PROPRIETAIRE de la table. Ici le proprietaire est `postgres`, personne ne
-- s'y connecte depuis l'application, et c'est precisement pour ca qu'il faut
-- le forcer : la garde ne doit pas dependre de qui se connecte demain.
-- ---------------------------------------------------------------------------
alter table public.settings    enable row level security;
alter table public.dictionary  enable row level security;
alter table public.stats_days  enable row level security;
alter table public.dictations  enable row level security;
alter table public.recordings  enable row level security;
alter table public.live_notes  enable row level security;

alter table public.settings    force row level security;
alter table public.dictionary  force row level security;
alter table public.stats_days  force row level security;
alter table public.dictations  force row level security;
alter table public.recordings  force row level security;
alter table public.live_notes  force row level security;

-- `anon` est le role d'une session SANS compte. Aucune de ces tables ne le
-- concerne : avant la connexion, il n'y a rien a lire et rien a ecrire. On le
-- dit au niveau des privileges plutot que de compter sur le RLS seul - deux
-- serrures differentes sur la meme porte, et la premiere se lit d'un coup
-- d'oeil dans un audit.
revoke all on public.settings, public.dictionary, public.stats_days,
              public.dictations, public.recordings, public.live_notes
  from anon;

grant select, insert, update, delete
  on public.settings, public.dictionary, public.stats_days,
     public.dictations, public.recordings, public.live_notes
  to authenticated;

-- Une politique par table et par verbe, toutes sur le meme predicat.
--
-- `using` decide ce qu'on VOIT (select, update, delete) ; `with check` decide
-- ce qu'on a le droit d'ECRIRE (insert, update). Les deux sont necessaires et
-- ne disent pas la meme chose : sans `with check`, un compte pourrait inserer
-- une ligne au nom d'un autre - il ne la reverrait jamais, mais elle serait
-- dans SES donnees a lui.
do $$
declare t text;
begin
  foreach t in array array['settings', 'dictionary', 'stats_days',
                           'dictations', 'recordings', 'live_notes']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
      t || '_select_own', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
      t || '_insert_own', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t || '_update_own', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)',
      t || '_delete_own', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- L'AUDIO
--
-- Un seau PRIVE. Le nom de l'objet commence par l'identifiant du compte, et
-- les politiques ci-dessous n'autorisent que ce prefixe : `<uid>/<recording>.wav`.
-- C'est la meme frontiere que pour les tables, appliquee au stockage, et elle
-- est indispensable - un seau public rendrait le RLS des tables decoratif,
-- puisque l'audio d'une reunion en dit autant que son transcript.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

create policy "recordings_read_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "recordings_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "recordings_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "recordings_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
