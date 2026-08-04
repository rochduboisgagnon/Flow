# Flow 2.5.0

## Une fois connecté, vous restez connecté

C'était le défaut le plus visible du produit : à chaque lancement, sur Windows comme
sur macOS, Flow redemandait le mot de passe.

**La cause.** Le client de session interroge son stockage dès sa construction, avant
que l'application soit prête, et le trousseau du système se déclare indisponible
avant ce moment-là. La session enregistrée était donc invisible, et personne ne
redemandait ensuite. Flow reprend maintenant la session au premier instant où le
trousseau répond, renouvelle le jeton si l'heure de validité est passée, et le
réécrit. Un lancement du lendemain repart tout seul.

Si la reprise échoue (mot de passe changé, session révoquée, machine hors ligne),
l'écran de connexion revient : c'est la bonne réponse à « je n'arrive pas à vous
reconnaître ». Rien ne plante, et le journal ne recopie jamais le jeton.

## macOS : le X libère le Dock

Fermer la fenêtre fait disparaître l'icône du Dock et laisse Flow tourner en
arrière-plan : le raccourci, le moteur et l'enregistrement continuent. L'icône de la
barre de menus reste, et c'est elle qui ramène la fenêtre, avec son icône de Dock.

## macOS, en général

Flow s'installe et fonctionne sur un Mac Apple Silicon. La dictée, les moteurs
locaux, le compte, les notes et le dictionnaire y sont. Le raccourci par défaut est
**Fn + Shift**.

Deux choses n'existent pas encore sur Mac, et l'application le dit elle-même : la
capture du son de l'ordinateur pendant une réunion (en construction) et le silence
des autres applications pendant une dictée (macOS n'a pas de volume par
application).

## Le raccourci par défaut change

`Ctrl + Shift` sur Windows, `Fn + Shift` sur macOS. Un raccourci déjà enregistré
n'est **pas** réécrit : ce nouveau défaut ne concerne qu'un compte qui n'en a jamais
choisi.

Sur Windows, `Ctrl + Shift` est aussi le raccourci de Windows pour changer de
disposition de clavier quand plusieurs sont installées. Il se désactive dans
*Paramètres → Clavier avancé → Touches d'accès rapide de la langue d'entrée*.

---

1164 tests, quatre portes vertes.
