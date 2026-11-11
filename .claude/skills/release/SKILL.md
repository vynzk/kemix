---
name: release
description: Publica una versión nueva de Kemix (sube la versión, commitea, crea el tag vX.Y.Z y lo sube para que GitHub Actions compile los ejecutables y cree el Release). Uso: /release 0.3.0 (o patch, minor, major).
disable-model-invocation: true
---

Publica la versión `$ARGUMENTS` de Kemix. Si `$ARGUMENTS` está vacío, pregunta qué versión (o patch/minor/major) antes de seguir.

1. Comprueba que estás en `main`, sin cambios pendientes (`git status`) y al día con `origin/main` (`git fetch` y
   compara). Si algo no cuadra, para y dilo.
2. Corre `npm run typecheck` y `npm test`. Si fallan, para y muestra los errores: no se publica con fallos.
3. Sube la versión solo en la app de escritorio (es la que da nombre a los ejecutables), actualizando también
   `package-lock.json`:

   ```
   npm version $ARGUMENTS -w @kemix/desktop --no-git-tag-version
   ```

   Lee la versión resultante de `apps/desktop/package.json` (la llamaremos X.Y.Z). Revisa con `git diff` que solo
   cambiaron `apps/desktop/package.json` y `package-lock.json`.
4. Commitea con el mensaje exacto `Versión X.Y.Z`.
5. Crea el tag `vX.Y.Z` (`git tag vX.Y.Z`).
6. Antes de subir, muestra el commit y el tag y pide confirmación: al subir el tag, el workflow
   `.github/workflows/ejecutables.yml` compila Windows y Linux y crea un Release público en GitHub.
7. Con el visto bueno: `git push origin main` y luego `git push origin vX.Y.Z`.
8. Termina con el enlace a la pestaña Actions del repo (https://github.com/vynzk/kemix/actions) para seguir la compilación;
   tarda unos 5 a 10 minutos y el Release aparece en https://github.com/vynzk/kemix/releases.
