# Publier sur GitHub

Trois fichiers à mettre dans le repo `immolead-site`, sur une branche dédiée :

```
immo2-slides-10-11.html      à la racine
decors/                      7 images, 1080 x 1350
agents/                      6 photos détourées, fond transparent
```

## Depuis un clone local

```bash
cd <chemin-du-clone-immolead-site>
git checkout -b creatif-configurateur

# décompresser l'archive à la racine du repo
unzip -o ~/Downloads/immo2-slides-10-11.zip -d .

git add immo2-slides-10-11.html decors agents
git commit -m "Configurateur de créatif pour les slides 10 et 11 du support de call

7 décors et 6 agents détournés, voile beige réglable,
5 styles de titre, 9 couleurs d'accent, 6 couleurs d'écriture,
6 accroches de copywriting, formulaire vendeur interactif."
git push -u origin creatif-configurateur
```

Netlify crée un deploy preview sur la branche. Rien ne bouge sur immolead.net tant que la branche n'est pas fusionnée dans `main`.

## Sans clone, par l'interface web

1. github.com → repo `immolead-site`
2. Menu des branches → taper `creatif-configurateur` → « Create branch »
3. « Add file » → « Upload files » → glisser le contenu décompressé de l'archive
4. Commit sur la branche

## Intégration dans immo2.html

Le fichier `immo2-slides-10-11.html` est une démo autonome **et** le code à intégrer. Il contient trois blocs marqués :

- `[BLOC 1]` le CSS, à coller à la fin de la balise `<style>` existante
- `[BLOC 2]` les deux `<section class="slide">`, qui remplacent les slides 10 et 11
- `[BLOC 3]` le JS, à coller à la fin de la balise `<script>` existante

Aucune classe existante n'est redéfinie, tout est préfixé `.cfg` `.fbm` `.cr` `.lf`. Les variables de couleur du support sont réutilisées telles quelles.

Si les dossiers `decors` et `agents` ne sont pas à la racine, changer les constantes `DOSSIER` et `DOSSIER_AGENTS` en haut du `[BLOC 3]`.
