# EDT commun

Chacun ajoute son lien iCal EcoleDirecte, puis on choisit de qui on veut voir l'emploi du temps
(jour, semaine). Le site s'installe aussi comme une appli sur le téléphone.

## Lancer en local

    node server.js          # Node 18+, aucune dépendance
    # puis ouvrir http://localhost:3000

En local, les emplois du temps sont gardés dans `data.json`.

## En ligne (Render) : garder les emplois du temps après un redémarrage

L'hébergement gratuit efface les fichiers à chaque redémarrage. Pour que rien ne se perde, le serveur
peut stocker les données dans une base gratuite **Upstash Redis**. Il suffit de définir deux variables
d'environnement sur Render :

| Variable                    | Valeur                                              |
|-----------------------------|-----------------------------------------------------|
| `UPSTASH_REDIS_REST_URL`    | l'URL « REST » de ta base (commence par https://)   |
| `UPSTASH_REDIS_REST_TOKEN`  | le jeton « REST » de ta base                        |

Sans ces deux variables, le serveur utilise le fichier `data.json`.
Au démarrage, si la base est injoignable, le serveur s'arrête au lieu de repartir « à vide »
(pour ne jamais écraser les vraies données) ; Render le relance tout seul.

## Autres variables
`PORT` (3000), `DATA_FILE` (data.json), `ALLOWED_HOSTS` (api.ecoledirecte.com), `REDIS_KEY` (edt-commun:people).

## Sécurité
- Les liens iCal restent côté serveur, jamais renvoyés au navigateur.
- Seuls les liens https://api.ecoledirecte.com sont acceptés.
- Supprimer une entrée demande le jeton gardé dans le navigateur de la personne qui l'a ajoutée.
- Ne jamais publier `data.json`, ni le jeton Upstash : ils donnent accès aux liens secrets.
