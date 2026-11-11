# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Idioma

- Todo en español: mensajes de commit, README/COMPILAR, textos de la UI (tuteo: "pulsa", "elige") y comentarios de
  código nuevos. Los identificadores (clases, funciones, variables) siguen en inglés como el resto del código.
- Los comentarios existentes están en inglés: no los traduzcas en masa, solo los que reescribas.

## Comandos

- Un solo test: `npx vitest run packages/core/test/queue.test.ts` (vitest corre desde la raíz; no hay script por paquete).
- Typecheck de un paquete: `npx tsc -p packages/core` (o `packages/server`, `packages/ui`, `apps/desktop`).
- `npm run lint` (Biome, solo lint; el formateo está desactivado). Un hook en `.claude/settings.json` pasa Biome y tsc
  tras cada edición y te devuelve los errores: corrígelos antes de seguir.
- Requiere Node 24+ (`node:sqlite`). Antes de `npm install`/`npm ci`, cierra Kemix y `npm run dev`: tienen cargado el
  módulo nativo `blowfish-cbc` y Windows da `EPERM` al reemplazarlo.

## Arquitectura y reglas

- `packages/core` no puede depender de Electron ni de HTTP. `packages/ui` solo habla HTTP con `packages/server` y de
  `@kemix/core` importa únicamente tipos (`import type`). Por eso `packages/ui/src/lib/format.ts` copia lógica de
  core (funciones con "Mirrors …" en el comentario): si cambias una de las dos, cambia también la otra.
- core y server no tienen build: exportan `src/index.ts` y electron-vite los empaqueta dentro de la app. Sus
  dependencias de runtime quedan externas, así que **toda dependencia nueva de core o server hay que añadirla también
  a `apps/desktop/package.json`**, o falta en el ejecutable.
- `electron` va con versión exacta (sin `^`) en `apps/desktop/package.json`: electron-builder lo exige.
- Migraciones de SQLite en `packages/core/src/db/index.ts`: la lista es solo de añadir. Nunca edites una que ya salió;
  agrega una nueva.
- `lucida` solo se importa en `packages/core/src/download/lucida-adapter.ts`; mantenlo así.
- Los tests no tocan la red ni ffmpeg: `Kemix` recibe fakes (`converter`, `decoder`, `featureSources`, `Downloader`).
  Sigue ese patrón en tests nuevos.

## Estilo

- Tabs, sin punto y coma, comillas simples, líneas de ~120 columnas. No hay formateador: imita el archivo.
- Hay dependencias "de más" en `useEffect` a propósito (p. ej. `streamUrl`/`videoId` en `Player.tsx`, para reiniciar
  al cambiar de tema); no las quites aunque parezcan innecesarias.

## Documentación y git

- Todo cambio visible para el usuario actualiza `README.md` (sección "Cómo funciona", tabla de cuentas o
  "Limitaciones conocidas") en el mismo commit. Si cambia el empaquetado o lo que se baja Kemix (yt-dlp, ffmpeg),
  también `COMPILAR.md`.
- Se commitea directo a `main`. Mensajes en español, en tercera persona y resumiendo lo que gana el usuario:
  "Añade clave y BPM de cada tema, en playlists, Buscar y Revisión". Subidas de versión: "Versión X.Y.Z" (ver `/release`).
- `site/` es la página de presentación (HTML/CSS/JS estáticos, sin build); se publica sola al hacer push a `main`.
