---
name: nuevo-servicio
description: Lista de todo lo que hay que tocar al añadir un servicio de música nuevo a Kemix (de dónde importar playlists, desde dónde descargar, o ambos), en core, server, UI, desktop, tests y README. Úsala al conectar un servicio nuevo o al darle a uno existente una capacidad nueva (importar, buscar, descargar).
---

# Añadir un servicio a Kemix

Primero decide qué papel tiene el servicio, porque de eso dependen los tipos en `packages/core/src/types.ts`:

- **Fuente** (importar playlists, buscar, crear playlists): entra en `SourceService` / `SOURCE_SERVICES` e implementa
  `SourceConnector` (`packages/core/src/sources/types.ts`).
- **Descarga sin pérdida con cuenta**: entra en `TargetService` / `TARGET_SERVICES` e implementa `Downloader`
  (`packages/core/src/download/lucida-adapter.ts`).
- **Respaldo con pérdida, sin cuenta y solo a pedido** (como YouTube y SoundCloud): `LossyService` / `LOSSY_SERVICES`.
- **Solo cuenta para descargar** (como Soundeo): `AccountService` / `ACCOUNT_SERVICES` además de `TargetService`.

Toma como plantilla el servicio existente más parecido y recorre sus apariciones con grep (p. ej. `soundeo` para
"solo descarga con login por email", `soundcloud` para "fuente + respaldo con cookie", `deezer` para "fuente +
descarga"). Hay listas y `Record<…>` por servicio repartidas por el código: TypeScript avisa de las que son
`Record`, pero no de los `if`/`switch` ni de los arrays literales.

## Checklist

**core**
- [ ] `src/types.ts`: tipos y arrays de servicios, `DOWNLOAD_SERVICE_LABEL`, y `serviceQualityLevel` si el servicio no
      ofrece todas las calidades.
- [ ] `src/sources/<servicio>.ts`: el conector y/o el downloader. Mensajes de error para el usuario en español.
- [ ] `src/accounts.ts`: `connect<Servicio>(…)` (guarda la credencial cifrada con `this.secrets`), el `case` en
      `source()` y/o la rama en `#createDownloader()`, y lo que haga falta en `list()` / `refreshIdentities()`.
- [ ] `src/settings.ts`: si debe entrar en `servicePriority` por defecto o al conectarse.
- [ ] `src/download/queue.ts`: solo si el servicio entrega formatos propios (como el AIFF/WAV de Soundeo) o tiene
      vista previa propia.
- [ ] `src/db/index.ts`: si hace falta guardar algo nuevo, una migración **nueva** al final de la lista.
- [ ] Si usa una dependencia npm nueva: añádela a `packages/core/package.json` **y** a `apps/desktop/package.json`.

**server** (`packages/server/src/index.ts`)
- [ ] Rutas `POST /api/accounts/<servicio>` (y `GET` de estado si aplica). Tras conectar una fuente, sincroniza la
      biblioteca como hacen las demás.

**desktop** (`apps/desktop/src/main.ts`)
- [ ] Solo si se inicia sesión en una ventana del sitio real: una función `capture<Servicio>Session` con su propia
      `session.fromPartition`, pasada en `browserLogin` a `createServer`.

**ui**
- [ ] `src/lib/api.ts`: las llamadas nuevas.
- [ ] `src/lib/format.ts`: nombre, calidad por defecto y color del servicio, y las funciones "Mirrors …" que copian
      lógica de core (`isLossy`, `serviceLevel`) si cambiaste la de core.
- [ ] `src/lib/hooks.ts`: la lista de servicios de descarga disponibles.
- [ ] `src/pages/AccountsPage.tsx`: la tarjeta para conectar, con la guía de qué necesita el usuario.
- [ ] `SettingsPage.tsx`, `SearchPage.tsx`, `ReviewPage.tsx`, `PlaylistDetail.tsx`: revisa con grep cómo aparecen
      los servicios existentes.

**tests**
- [ ] `packages/core/test/<servicio>.test.ts` sin red: simula las respuestas HTTP con `vi.stubGlobal('fetch', …)`
      como en `soundeo.test.ts` o `soundcloud-api.test.ts`.
- [ ] `packages/ui/test/format.test.ts` si cambiaste `format.ts`.

**docs**
- [ ] `README.md`: fila en "Cómo conectar cada cuenta", su apartado en "Cómo funciona" y, si es una integración no
      oficial, una línea en "Limitaciones conocidas". Actualiza también la lista de servicios del primer párrafo.
- [ ] `COMPILAR.md` solo si cambia lo que Kemix se baja por su cuenta o el empaquetado.

Al terminar: `npm run typecheck` y `npm test`.
