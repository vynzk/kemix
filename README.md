# Kemix

App de escritorio para traer tus playlists de **Spotify, YouTube Music, Qobuz y Deezer**, ordenarlas en carpetas y
descargarlas en FLAC desde **Qobuz** (o **Deezer** como respaldo) usando [`lucida`](https://www.npmjs.com/package/lucida).

## Uso

```bash
npm install
npm run dev        # app de escritorio (Electron + UI con recarga en caliente)
npm run dev:web    # lo mismo pero en el navegador: servidor en :47800, UI en http://localhost:5180
npm test           # tests (vitest)
npm run typecheck
npm run dist       # instalador de Windows en apps/desktop/release
```

Los datos (base de datos SQLite y credenciales cifradas con DPAPI) se guardan en `%APPDATA%\@kemix\desktop`.
Las descargas van a `~/Music/Kemix/<Playlist>/NN - Artista - Título.flac`, con un `.m3u8` por playlist.

## Cómo conectar cada cuenta

| Servicio | Qué necesitas |
|---|---|
| Qobuz | Botón "Iniciar sesión en Qobuz": abre play.qobuz.com en una ventana y Kemix captura la sesión al entrar (usa email y contraseña; el login con Google suele bloquearse en ventanas de apps). Alternativas en "Otros métodos": email/contraseña por API o pegar el header `x-user-auth-token`. |
| Deezer | La cookie `arl` de deezer.com (DevTools → Application → Cookies). Caduca cada pocos meses. |
| Spotify | Una app propia en developer.spotify.com con el Redirect URI `http://127.0.0.1:47800/api/auth/spotify/callback`; pega su Client ID. |
| YouTube Music | Las cookies de music.youtube.com (archivo de Get cookies.txt o el header `cookie`). Si hay varias cuentas de Google en la sesión, Kemix pregunta cuál usar. |

## Cómo funciona

```
packages/core     lógica: conectores, matcher, cola de descargas, SQLite (node:sqlite), sin Electron ni HTTP
packages/server   API REST + eventos SSE (Fastify) sobre core
packages/ui       React + Vite + Tailwind; solo habla HTTP con el server
apps/desktop      Electron: arranca el server en 127.0.0.1 con un token por sesión y muestra la UI
```

- **Matching**: si la playlist ya es de Qobuz/Deezer se descarga directo. Si no, se busca por ISRC y, si no hay,
  por texto (título + artista + duración). Lo que no supera el umbral (90% por defecto) va a **Revisión**.
- **Cola**: persistente (sigue después de cerrar la app), con 3 descargas simultáneas y 3 reintentos. Si un tema ya se
  bajó para otra playlist, se enlaza (hardlink) en lugar de volver a descargarlo.
- **Versión web**: `packages/server/src/standalone.ts` corre todo sin Electron. Variables: `KEMIX_DATA_DIR`,
  `KEMIX_SECRET` (clave de cifrado de credenciales), `KEMIX_TOKEN`, `KEMIX_UI_DIR`, `KEMIX_HOST`, `KEMIX_PORT`.
  Para hacerla multiusuario falta añadir login de usuarios y separar los datos por usuario.

## Limitaciones conocidas

- `lucida` 2.0.0-54 no se actualiza desde enero de 2025. Solo se importa en `packages/core/src/download/lucida-adapter.ts`,
  así que se puede parchear o reemplazar ahí.
- Qobuz siempre descarga la máxima calidad disponible (lucida no permite elegirla).
- Spotify (en modo desarrollo) no da acceso a playlists generadas por Spotify (Daily Mix, Discover Weekly…).
- La integración con YouTube Music no es oficial y puede romperse cuando YouTube cambie su web.
- Descargar desde estos servicios va contra sus términos de uso; es para uso personal.
