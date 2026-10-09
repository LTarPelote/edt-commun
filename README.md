# EDT commun

Chacun ajoute son lien iCal EcoleDirecte, puis on choisit de qui on veut voir l'emploi du temps
(jour, semaine) et on compare les pauses midi.

## Lancer

    node server.js          # Node 18+, aucune dépendance
    # puis ouvrir http://localhost:3000

Les potes sur le même wifi : http://<ton-ip-locale>:3000

Variables : PORT (3000), DATA_FILE (data.json), ALLOWED_HOSTS (api.ecoledirecte.com).

## Sécurité
- Les liens iCal restent côté serveur (data.json), jamais renvoyés au navigateur.
- Seuls les liens https://api.ecoledirecte.com sont acceptés.
- Supprimer une entrée demande le jeton gardé dans le navigateur de la personne qui l'a ajoutée.
- Ne pas publier data.json (il contient les liens secrets).
