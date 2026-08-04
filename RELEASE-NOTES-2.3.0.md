# Flow 2.3.0

## Sortir du mode mains libres ne demande plus qu'une seule pression

Le double-tap qui **entre** dans le mode ne change pas : c'est un geste délibéré,
il garde un geste délibéré. Mais pour en **sortir**, une seule pression du
raccourci suffit maintenant, là où il fallait un second double-tap. Ce qui a été
dit est inséré, comme avant.

Deux détails qui comptent, et qui ne sont pas des détails :

- **La durée de l'appui ne décide plus de rien.** Une pression longue arrête et
  livre, exactement comme une pression brève. Jeter les mots de quelqu'un est le
  seul résultat qu'il ne peut pas défaire, et un doigt qui traîne n'est pas une
  raison de le faire.
- **`Ctrl+Win+flèche` change toujours de bureau sans terminer la dictée.** La
  moitié `Ctrl+Win` de ce raccourci Windows est le raccourci de Flow : vus du
  relâchement seul, les deux sont identiques. Flow retient donc qu'une touche
  étrangère a été pressée pendant l'appui et refuse de lire cet appui comme une
  fin de dictée. Sans ça, changer de bureau pendant une dictée mains libres
  l'aurait terminée et collé le texte dans la fenêtre d'arrivée.

## Deux rangées de moins dans Réglages > General

- **« Microphone readiness »** est retirée : elle ne réglait rien, et
  « nothing to configure » dans une page de réglages est une ligne qui occupe
  l'écran pour dire qu'elle n'a rien à offrir.

  Sa **phrase**, elle, a déménagé dans Storage & Privacy plutôt que de
  disparaître. Elle nommait le coût du préchauffage du micro : le témoin de
  microphone de Windows reste allumé quelques secondes après chaque dictée, et
  personne ne peut plus le refuser depuis que le sélecteur a été supprimé. Un
  compromis de vie privée que l'utilisateur ne peut pas lire est un compromis
  qu'il n'a pas accepté.

- **« System-audio capture »** est retirée aussi : elle annonçait une capacité de
  la machine sans rien régler. La case qui allume vraiment la capture du son du PC
  est sur la page Record, au moment où on démarre un enregistrement, et c'est le
  seul endroit où elle sert à quelque chose.

---

1123 tests, quatre portes vertes (test, lint, typecheck, build). Les trois tests
du nouveau geste ont été vérifiés en échec avant le correctif.
