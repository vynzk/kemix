# Kemix

App de escritorio para traer tus playlists de **Spotify, YouTube Music, Qobuz y Deezer**, ordenarlas en carpetas y
descargarlas en FLAC desde **Qobuz** (o **Deezer** como respaldo) usando [`lucida`](https://www.npmjs.com/package/lucida),
en WAV/AIFF desde **Soundeo** con una cuenta Premium, o desde la red **Soulseek** (archivos que comparten otros
usuarios).

Página del proyecto: **[vynzk.github.io/kemix](https://vynzk.github.io/kemix/)**

## Uso

```bash
npm install
npm run dev        # app de escritorio (Electron + UI con recarga en caliente)
npm run dev:web    # lo mismo pero en el navegador: servidor en :47800, UI en http://localhost:5180
npm test           # tests (vitest)
npm run typecheck
npm run dist       # ejecutable para el sistema actual en apps/desktop/release (dist:win / dist:linux)
```

Para crear los ejecutables de Windows y Linux (en tu PC o en GitHub Actions), ver [COMPILAR.md](COMPILAR.md).

La página de presentación está en `site/` (HTML, CSS y JS estáticos, sin build) y se publica en GitHub Pages con
[.github/workflows/pagina.yml](.github/workflows/pagina.yml).

Los datos (base de datos SQLite y credenciales cifradas con DPAPI) se guardan en `%APPDATA%\@kemix\desktop`.
Las descargas van a `~/Music/Kemix/<Playlist>/NN - Artista - Título.flac`, con un `.m3u8` por playlist.

## Cómo conectar cada cuenta

| Servicio | Qué necesitas |
|---|---|
| Qobuz | Botón "Iniciar sesión en Qobuz": abre play.qobuz.com en una ventana y Kemix captura la sesión al entrar (usa email y contraseña; el login con Google suele bloquearse en ventanas de apps). Solo disponible en la app de escritorio. |
| Deezer | Las cookies de deezer.com (recomendado: archivo de Get cookies.txt; Kemix toma la cookie `arl`) o solo el valor de `arl` (DevTools → Application → Cookies). Caduca cada pocos meses. |
| Spotify | **Cualquier cuenta (sin Premium)**, solo en la app de escritorio: "Iniciar sesión en Spotify" abre open.spotify.com en una ventana y Kemix usa la API interna del reproductor web (la Web API pública rechaza ese token con 429); la sesión se renueva sola cada hora en una ventana oculta. Carga playlists y Me gusta y permite buscar, pero no crear playlists ni leer ISRC (el matching va por título, artista y duración). **Premium (Client ID)**: una app propia en developer.spotify.com con el Redirect URI `http://127.0.0.1:47800/api/auth/spotify/callback`; pega su Client ID. Spotify solo abre su Web API a cuentas Premium: si la cuenta es gratis, Kemix avisa y propone el otro método. |
| Soundeo | El email y la contraseña de soundeo.com (en la app de escritorio y en la versión web). Se conecta cualquier cuenta, pero Soundeo solo deja descargar a las **Premium** (no vende temas sueltos): sin Premium solo sirve para buscar. Kemix guarda la contraseña cifrada para volver a iniciar sesión cuando Soundeo cierra la sesión. |
| Soulseek | Tu usuario y contraseña de Soulseek (los de Nicotine+ o SoulseekQt), o unos nuevos: si el usuario no existe, Soulseek lo crea al conectar. No uses el mismo usuario a la vez en otro programa (el servidor cierra una de las dos sesiones). Para llegar a más usuarios, abre o redirige en el router el puerto TCP de Ajustes → Puerto de Soulseek (2234 por defecto). |
| YouTube Music | Las cookies de music.youtube.com (archivo de Get cookies.txt o el header `cookie`). Si hay varias cuentas de Google en la sesión, Kemix pregunta cuál usar. Google renueva estas cookies mientras el sitio sigue abierto y la copia exportada deja de valer: expórtalas desde una ventana de incógnito y ciérrala justo después, sin cerrar sesión. |

**Cómo sacar cookies.txt:** instala la extensión [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY)
(Chrome/Edge/Firefox; la versión LOCALLY no envía las cookies a ningún servidor), inicia sesión en el sitio
(music.youtube.com o deezer.com), pulsa el icono de la extensión → **Export**, y en Kemix usa **Cargar archivo…** →
**Conectar**. El archivo da acceso a tu cuenta: bórralo después. La misma guía aparece en la pantalla Cuentas.

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
  bajó para otra playlist, se enlaza (hardlink) en lugar de volver a descargarlo. En cada playlist se pueden marcar
  temas sueltos y descargar solo esos. Cada descarga se puede eliminar, en "Descargas" o en la fila del tema dentro de
  la playlist (aparece al pasar el ratón): si está en curso se detiene, y si ya terminó se borra su archivo del disco
  (las copias en otras playlists se quedan). "Limpiar terminadas" solo las quita de la lista.
- **Calidad y formato**: un solo selector, en Ajustes (valor por defecto) y en cada playlist, junto a "Descargar
  desde". Agrupa:
  - *Sin convertir*: FLAC máxima disponible, hasta 24-bit/96 kHz o CD 16-bit/44.1 kHz.
  - *AIFF* y *WAV* (para DJ y producción), cada uno en máxima, hasta 24-bit/96 kHz o 16-bit/44.1 kHz (para equipos que
    no leen Hi-Res). Mantienen la frecuencia de lo que se baja y quedan en 24-bit solo si la fuente tiene más de 16.
  - *MP3*: 320 kbps, siempre un MP3 que suena en cualquier reproductor (Qobuz/Deezer entregan su MP3; lo demás se
    convierte a CBR 44.1 kHz, a 320 kbps si el original es sin pérdida y a 192 si ya tenía pérdida), o 128 kbps.

  Con un proveedor elegido solo aparecen las opciones que da con tu cuenta (Qobuz no baja de MP3 320, el único FLAC
  de Deezer es 16-bit/44.1 kHz, YouTube y SoundCloud tienen una sola calidad). Si un tema no llega a la calidad
  elegida, se baja en la mejor que tenga por debajo. Los tags y la carátula se escriben en el archivo final. Los temas
  ya descargados no cambian; un archivo solo se reutiliza para otra playlist si se hizo en la misma calidad y formato,
  y si un tema ya se bajó sin convertir, para AIFF/WAV se convierte ese archivo en lugar de volver a descargarlo.
  Después de bajar se muestra la calidad real, leída del archivo, y el proveedor del que vino. Para convertir se usa
  ffmpeg: Kemix baja su propia copia la primera vez (ver [COMPILAR.md](COMPILAR.md)) o usa la del sistema.
- **Escanear calidad**: en cada playlist, "Escanear calidad" busca los temas (todos o los marcados) en el proveedor
  elegido sin descargar nada, y muestra en la columna Calidad en qué calidad saldría cada uno con la opción elegida y
  tu cuenta (y la máxima del tema si es mayor), y el formato al que se convierte (p. ej. `FLAC 24-bit/96 kHz → AIFF`).
  Avisa de los temas cuya fuente queda por debajo de la conversión: "⚠ Fuente con pérdida" para AIFF/WAV, "⚠ Menos
  de 320 kbps" para MP3 320 (p. ej. YouTube o Deezer gratis). Encima de la tabla hay un resumen: con aviso, Hi-Res,
  CD, con pérdida, dudosos y no encontrados. Cada grupo se puede seleccionar para descargar solo esos, y "Seleccionar
  sin los con aviso" deja fuera los marcados. Al descargar después se usan esos resultados sin buscar de nuevo. Volver
  a escanear solo busca lo que quedó sin resolver; si un tema que esperaba en Revisión aparece, su descarga sigue sola.
- **Clave y BPM**: columnas BPM y Clave en cada playlist. La clave se muestra en Camelot con el color de su lugar en
  la rueda ("8A" y "Am" al lado), en notación musical o en Open Key, según Ajustes. Al abrir una playlist se buscan
  solos los temas que nunca se buscaron; el botón "Clave y BPM" reintenta los que no tienen datos o, con temas
  marcados, vuelve a buscar esos desde cero. Cada dato sale del primer lugar que lo tiene:
  1. los tags del archivo descargado, si ya venían;
  2. [GetSongBPM](https://getsongbpm.com/api), si pones su API key (gratis) en Ajustes;
  3. Deezer (su API pública, sin cuenta), solo el BPM;
  4. el análisis de Kemix: decodifica el audio con ffmpeg y estima el tempo (autocorrelación de los ataques) y la clave
     (cromagrama comparado con los perfiles de KeyFinder). Usa el archivo descargado o, si el tema no se bajó, la vista
     previa de 30 s de Deezer (se marca con "≈", es aproximado);
  5. AcousticBrainz, solo si no hubo audio que analizar: en una prueba con 30 temas de clave conocida acertó menos
     claves (12 de 26) que el análisis de Kemix con la vista previa (17 de 30).

  También aparecen en los resultados de **Buscar** y en **Revisión**, junto al tema original y a cada opción. El BPM de
  una opción sale en amarillo si no coincide con el del original (ni al doble ni a la mitad): puede ser otra versión.
  Esos temas no están en la biblioteca, así que se buscan igual pero sus datos se guardan en memoria hasta cerrar la
  app; una nueva búsqueda detiene lo que quedaba de la anterior.

  Al terminar cada descarga se analiza el archivo completo si algo venía de una vista previa, y la clave y el BPM se
  escriben en los tags (TKEY/TBPM o INITIALKEY/BPM, lo que leen rekordbox, Serato y Traktor); se puede desactivar en
  Ajustes. El BPM de Deezer y el del análisis a veces salen al doble o a la mitad del real.
- **Buscar y crear playlists**: en "Buscar" eliges un servicio conectado, buscas temas, los agregas a una playlist nueva
  (con orden) y se crea como privada en tu cuenta de ese servicio; luego aparece en la Biblioteca. Spotify pide permiso
  de escritura: las conexiones hechas antes de esta función deben desconectarse y volver a conectarse.
- **Escuchar**: el botón ▶ de cada tema busca el video en YouTube y lo reproduce con el reproductor de YouTube integrado.
- **YouTube como respaldo**: los temas que no están en Qobuz ni Deezer se pueden bajar desde YouTube, solo si lo pides
  (en la playlist o en Revisión) y con aviso de que no es calidad máxima (AAC ~128 kbps). Usa
  [yt-dlp](https://github.com/yt-dlp/yt-dlp): el de Ajustes si se indica una ruta; si no, una copia propia que Kemix
  baja del release oficial la primera vez (verificada con SHA-256, en `<datos>/bin`, y revisada una vez al día por si
  hay versión nueva); si eso falla, el del PATH. Como runtime de JavaScript para los desafíos de YouTube se le pasa el
  propio ejecutable de Kemix (Electron como Node), así que no hace falta instalar nada. Sin yt-dlp se intenta con
  youtubei.js, pero YouTube bloquea así la mayoría de la música con licencia.
- **SoundCloud como respaldo**: igual que YouTube (sin cuenta, solo si lo activas en Ajustes o lo eliges a mano), con
  el mismo yt-dlp. Baja la mejor calidad que tenga cada tema, tal cual llega, sin recodificar: el archivo original
  que subió el artista si permite descargarlo (puede ser WAV o FLAC), si no AAC 160 kbps, y en temas viejos MP3 128
  (nunca el Opus de 64 kbps, aunque yt-dlp lo prefiera por defecto). Sirve para remixes, sets y artistas
  independientes que no están en Qobuz ni Deezer. Sin cuenta, los temas de SoundCloud Go+ solo ofrecen 30 s y se
  descartan en la búsqueda. En Revisión, el ▶ de una opción de SoundCloud la reproduce con el reproductor de
  SoundCloud integrado.
- **Cuenta de SoundCloud (opcional)**: se conecta iniciando sesión en una ventana (app de escritorio) o con las
  cookies de soundcloud.com; Kemix guarda solo la cookie `oauth_token`, cifrada. Con ella importa tus playlists, las
  que te gustaron y tus Me gusta (vía `api-v2.soundcloud.com`, con el client id público del reproductor web, igual
  que yt-dlp), busca en SoundCloud, y yt-dlp descarga con tu sesión: originales reservados a usuarios
  registrados y, con Go+, AAC 256 y los temas Go+ completos. Los temas importados de SoundCloud se buscan primero en
  Qobuz y Deezer; si no están, su propia subida aparece como primera opción (en Revisión, o directo si SoundCloud
  está en la prioridad de servicios). SoundCloud no deja que otras apps creen playlists: en Buscar, los temas elegidos
  en SoundCloud se guardan en una playlist nueva de otro servicio conectado (Spotify, YouTube Music, Qobuz o Deezer).
  Kemix busca cada tema ahí y avisa cuáles no encontró.
- **Soundeo** (solo descarga, para DJ): habla con los mismos endpoints que su web (no tiene API pública). Busca solo
  entre los temas descargables (`/list/tracks?availableFilter=1`) y compara título, artistas y duración (Soundeo no
  muestra ISRC). Baja su WAV 16-bit/44.1 kHz; si eliges AIFF pide directamente el AIFF de Soundeo, y en WAV guarda su
  WAV, en ambos casos sin pasar por ffmpeg; para MP3 baja su MP3 320. Cada tema que baja gasta una de las descargas
  del día del plan (Premium 5 a 150; se renuevan a medianoche, hora de Europa central): la tarjeta de Cuentas muestra
  cuántas quedan, y si se acaban o la cuenta no tiene Premium la descarga falla con ese motivo. Al conectar por primera
  vez una cuenta Premium, Soundeo entra en la prioridad de servicios detrás de Qobuz y Deezer, así que solo se usa con
  lo que esos no tienen (se puede mover o quitar en Ajustes). En Revisión, el ▶ de una opción de Soundeo reproduce su
  propio clip de ese mismo mix.
- **Soulseek** (solo descarga, red P2P): Kemix habla el protocolo de Soulseek por su cuenta
  (`packages/core/src/sources/soulseek-*.ts`, sin programas aparte): inicia sesión en el servidor, escucha en el puerto
  de Ajustes para que otros usuarios le envíen resultados y archivos, y si no puede llegar a alguien directamente le
  pide al servidor que ese usuario se conecte con él. No comparte nada: anuncia 0 archivos y rechaza lo que le piden.
  - *En el matching*: al conectarlo por primera vez entra en la prioridad detrás de los servicios sin pérdida. Busca
    por texto (Soulseek no tiene ISRC), deduce artista, título y álbum de la ruta de cada archivo ("Artista - Álbum
    (2001) [FLAC]\01 - Título.flac") y lo compara como cualquier otro candidato; lo dudoso va a Revisión, donde también
    se puede buscar a mano en Soulseek. Entre archivos igual de parecidos elige primero por calidad (sin pérdida, salvo
    que la calidad de Ajustes sea MP3), luego quien puede enviarlo ya, con la cola más corta y más rápido. Los tags y
    el nombre del archivo salen del tema de la playlist, no de la ruta.
  - *Pantalla Soulseek* (aparece con la cuenta conectada): búsqueda libre, con los resultados llegando en vivo durante
    unos segundos, agrupados por usuario y carpeta, con formato, calidad, tamaño, duración y si el usuario puede
    enviarlo ya. "Descargar" agrega el archivo a la playlist local **Soulseek** de la Biblioteca y lo pone en la cola,
    con la calidad y el formato de Ajustes (AIFF, WAV y MP3 se convierten como siempre).
  - *Al descargar*: se pide el archivo y se espera en la cola de ese usuario hasta 3 minutos (o menos, si dice que hay
    más de 10 delante). Si lo rechaza, no responde o tarda demasiado, se prueba con otros usuarios que tengan el mismo
    archivo (mismo nombre y tamaño) o el mismo tema con la misma calidad y duración, hasta 3. Borrar la descarga corta
    la espera.
- **Versión web**: `packages/server/src/standalone.ts` corre todo sin Electron. Variables: `KEMIX_DATA_DIR`,
  `KEMIX_SECRET` (clave de cifrado de credenciales), `KEMIX_TOKEN`, `KEMIX_UI_DIR`, `KEMIX_HOST`, `KEMIX_PORT`.
  Para hacerla multiusuario falta añadir login de usuarios y separar los datos por usuario.

## Limitaciones conocidas

- `lucida` 2.0.0-54 no se actualiza desde enero de 2025. Solo se importa en `packages/core/src/download/lucida-adapter.ts`,
  así que se puede parchear o reemplazar ahí.
- Spotify (en modo desarrollo) no da acceso a playlists generadas por Spotify (Daily Mix, Discover Weekly…).
- La integración con YouTube Music no es oficial y puede romperse cuando YouTube cambie su web.
- La de Soundeo tampoco: lee su web (`packages/core/src/sources/soundeo.ts`) y puede romperse si la cambian. Si
  Soundeo empieza a pedir captcha al iniciar sesión, hay que entrar una vez en soundeo.com desde el navegador.
- Soulseek: sin el puerto abierto en el router solo se llega a los usuarios que sí lo tienen abierto (Kemix no usa
  UPnP). Una descarga que espera en la cola de otro usuario ocupa uno de los huecos de descargas simultáneas hasta que
  empieza o se agota la espera. El servidor filtra algunas búsquedas (artistas con reclamos de derechos), que no dan
  resultados. Como Kemix no comparte archivos, algunos usuarios rechazan sus descargas. La calidad elegida al descargar
  no cambia el archivo: se elige al buscar, según la calidad por defecto de Ajustes.
- Descargar desde estos servicios va contra sus términos de uso; es para uso personal.
