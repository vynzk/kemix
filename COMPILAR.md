# Cómo crear los ejecutables de Kemix

Kemix se empaqueta con [electron-builder](https://www.electron.build). Hay dos formas de generar los ejecutables:

- **A. En GitHub Actions (recomendado):** compila Windows y Linux en la nube con un clic.
- **B. En tu PC:** Windows se compila en Windows y Linux en Linux (o en WSL). No se puede compilar Linux desde
  Windows porque Kemix usa un módulo nativo (`blowfish-cbc`, que descifra las descargas de Deezer) que hay que
  compilar en el mismo sistema donde va a correr.

| Sistema | Archivo que se genera (en `apps/desktop/release/`) | Para qué |
|---|---|---|
| Windows | `Kemix Setup 0.1.0.exe` | Instalador. Deja Kemix en el menú Inicio y permite desinstalarlo. |
| Windows | `win-unpacked/Kemix.exe` | La app sin instalar, para probarla. |
| Linux | `Kemix-0.1.0-x86_64.AppImage` | Un solo archivo portable: se le da permiso de ejecución y se abre. Sirve en cualquier distro. |
| Linux | `Kemix-0.1.0-amd64.deb` | Paquete para Ubuntu, Debian y derivadas. `apt` instala también las librerías del sistema que falten. |

## Qué necesita el usuario final

Nada. El ejecutable ya trae todo lo que Kemix necesita para funcionar:

- Electron (con su propio Node 24), SQLite, la interfaz y el módulo nativo de Deezer van dentro del ejecutable.
  No hace falta instalar Node, Python ni Visual C++.
- **yt-dlp** (descargas desde YouTube y SoundCloud): Kemix baja su propia copia la primera vez que la necesita, desde los
  [releases oficiales](https://github.com/yt-dlp/yt-dlp/releases), y la verifica con el checksum SHA-256 publicado.
  Una vez al día revisa si salió una versión nueva, porque YouTube deja inservibles las versiones viejas cada pocas
  semanas. Se guarda en la carpeta `bin` dentro de los datos de Kemix. Si el usuario configura una ruta en Ajustes,
  se usa esa.
- **Runtime de JavaScript para yt-dlp** (YouTube lo exige para resolver sus desafíos): Kemix le presta su propio
  ejecutable, que funciona como Node con `ELECTRON_RUN_AS_NODE`. No hace falta Deno ni Node.
- **ffmpeg** (solo para convertir: a MP3 con «MP3 320 kbps», o a AIFF/WAV): Kemix baja su propia copia la primera vez
  que tiene que convertir: un build estático fijo de los
  [releases de ffmpeg-static](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) (~30 MB), verificado
  con el SHA-256 fijado en `packages/core/src/download/ffmpeg.ts`, y la guarda en la misma carpeta `bin`. No se
  actualiza sola: para cambiar de versión, actualiza ahí la URL y los checksums. Si no puede bajarlo, usa el `ffmpeg`
  del sistema si hay uno. Sin conversión no se usa: el audio se guarda tal cual llega.

Lo único que necesita es conexión a internet la primera vez que baja algo de YouTube o convierte un formato.

Los datos (base de datos, credenciales cifradas, yt-dlp y ffmpeg) se guardan en:

- Windows: `%APPDATA%\@kemix\desktop`
- Linux: `~/.config/@kemix/desktop`

---

## A. Compilar en GitHub Actions (Windows + Linux)

El workflow está en [.github/workflows/ejecutables.yml](.github/workflows/ejecutables.yml). Compila Windows en
`windows-latest` y Linux en `ubuntu-22.04`. Se usa 22.04 y no la última porque así el módulo nativo funciona
también en distros más viejas.

1. Sube los cambios a GitHub:

   ```bash
   git add -A
   git commit -m "Ejecutables de Windows y Linux"
   git push
   ```

2. En GitHub, abre el repo → pestaña **Actions** → **Ejecutables** → **Run workflow** (rama `main`) → **Run workflow**.
3. Espera a que terminen los dos trabajos (`win` y `linux`), unos 5 a 10 minutos.
4. Entra al run y, abajo en **Artifacts**, descarga `kemix-win` (el instalador `.exe`) y `kemix-linux` (el
   `.AppImage` y el `.deb`). Vienen comprimidos en `.zip`. GitHub los guarda 90 días.

### Publicar una versión (Release)

Si subes un tag que empiece con `v`, el workflow además crea un **Release** en GitHub con los archivos adjuntos:

1. Sube la versión en [apps/desktop/package.json](apps/desktop/package.json) (`"version": "0.2.0"`) y haz commit.
2. Crea el tag y súbelo:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. Cuando termine, la versión aparece en la página **Releases** del repo, con el instalador, el AppImage y el .deb.

---

## B. Compilar en tu PC

### Windows

**Requisitos (una sola vez):**

1. [Node.js](https://nodejs.org) 24 o superior, con npm.
2. [Git](https://git-scm.com).
3. Para compilar el módulo nativo durante `npm ci`:
   - [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/es/visual-cpp-build-tools/) con la carga de
     trabajo **"Desarrollo para el escritorio con C++"**.
   - [Python 3](https://www.python.org/downloads/).

   El archivo [.npmrc](.npmrc) del repo ya corrige el error `LNK1117` que da Node 24+ al compilar módulos nativos
   en Windows.

**Pasos:**

1. **Cierra Kemix** si está abierto (incluido `npm run dev`): tiene cargado el módulo nativo y Windows no deja
   reemplazarlo.
2. En una terminal, en la carpeta del repo:

   ```powershell
   npm ci
   npm run dist:win
   ```

3. El resultado queda en `apps/desktop/release/`: `Kemix Setup 0.1.0.exe` (instalador) y
   `win-unpacked/Kemix.exe` (para probar sin instalar).

### Linux

Sirve un PC con Linux, una máquina virtual o WSL en Windows. Los pasos son para Ubuntu/Debian.

**Si usas WSL (desde Windows):**

```powershell
wsl --install -d Ubuntu   # pide permisos de administrador y suele pedir reiniciar
```

Abre "Ubuntu" desde el menú Inicio y sigue los pasos de abajo dentro de esa terminal. **Clona el repo dentro de
Linux** (por ejemplo en `~/kemix`) y no lo uses desde `/mnt/c/...`: ahí estarían los `node_modules` compilados para
Windows, y además es mucho más lento.

**Requisitos (una sola vez):**

```bash
sudo apt update
sudo apt install -y build-essential python3 git curl
# Node.js 24 o superior (con nvm):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
```

**Pasos:**

```bash
git clone https://github.com/vynzk/kemix.git
cd kemix
npm ci
npm run dist:linux
```

El resultado queda en `apps/desktop/release/`: `Kemix-0.1.0-x86_64.AppImage` y `Kemix-0.1.0-amd64.deb`.

### Otros comandos

| Comando | Qué hace |
|---|---|
| `npm run dist` | Compila para el sistema donde estás. |
| `npm run dist:win` | Solo Windows. |
| `npm run dist:linux` | Solo Linux. |
| `npm run build` | Compila la UI y el proceso principal sin empaquetar (lo usan los de arriba). |

---

## Instalar y abrir Kemix

### Windows

1. Abre `Kemix Setup 0.1.0.exe`.
2. El instalador no está firmado, así que Windows muestra **"Windows protegió su PC"**: pulsa **Más información** →
   **Ejecutar de todas formas**. Para quitar el aviso hace falta un certificado de firma de código; ver
   [la guía de electron-builder](https://www.electron.build/code-signing).
3. Elige la carpeta y termina. Kemix queda en el menú Inicio.

### Linux: `.deb` (Ubuntu, Debian, Mint, Pop!_OS…)

```bash
sudo apt install ./Kemix-0.1.0-amd64.deb
```

Usa `apt` y no `dpkg -i`: apt instala también las librerías que falten (GTK, NSS, libsecret…). Kemix queda en el
menú de aplicaciones y en la terminal como `kemix`. En Ubuntu 24+ el paquete instala además el perfil de AppArmor
que necesita el sandbox de Chromium. Para desinstalarlo: `sudo apt remove kemix`.

### Linux: AppImage (cualquier distro)

```bash
chmod +x Kemix-0.1.0-x86_64.AppImage
./Kemix-0.1.0-x86_64.AppImage
```

Si el sistema no permite el sandbox de Chromium (Ubuntu 24+), el AppImage arranca solo con `--no-sandbox`.

---

## Cambiar la versión o el logo

- **Versión:** campo `"version"` de [apps/desktop/package.json](apps/desktop/package.json). Se usa en el nombre de
  los archivos y en el instalador.
- **Logo:** la fuente es [apps/desktop/build/icon.svg](apps/desktop/build/icon.svg). Si lo cambias, regenera:
  - `apps/desktop/build/icon.png`: PNG de 1024×1024 con fondo transparente (lo usa Linux y la ventana).
  - `apps/desktop/build/icon.ico`: el `.ico` de Windows, con los tamaños 16, 24, 32, 48, 64, 128 y 256. Por
    ejemplo, con ImageMagick: `magick icon.png -define icon:auto-resize=256,128,64,48,32,24,16 icon.ico`.
  - `packages/ui/public/favicon.svg`: una copia del SVG (icono de la pestaña en la versión web).

---

## Problemas comunes

| Error | Solución |
|---|---|
| `EPERM: operation not permitted ... blowfish-native.node` | Kemix (o `npm run dev`) está abierto y tiene el módulo cargado. Ciérralo y repite. |
| `Electron version "^45.2.1" is a range` | electron-builder necesita la versión exacta de Electron. Al actualizar Electron, escribe la versión sin `^` en [apps/desktop/package.json](apps/desktop/package.json) (`"electron": "45.2.1"`). |
| `LNK1117` al hacer `npm ci` en Windows | Falta el [.npmrc](.npmrc) del repo (`enable_thin_lto=false`). |
| `gyp ERR!` / `node-gyp` al hacer `npm ci` | Faltan las herramientas para compilar: Build Tools de Visual Studio + Python en Windows, `build-essential` + `python3` en Linux. |
| Kemix dice "El puerto local ya está en uso" | Hay otra copia de Kemix abierta (puede ser `npm run dev`). Ciérrala. |
| El AppImage no abre y menciona FUSE | `sudo apt install libfuse2` (en Ubuntu 24+: `libfuse2t64`), o ábrelo con `./Kemix-*.AppImage --appimage-extract-and-run`. |
| Una descarga en «MP3 320 kbps», AIFF o WAV dice "No se pudo descargar ffmpeg" | Kemix no llegó a GitHub para bajar ffmpeg. Reintenta con conexión, o instala ffmpeg en el sistema (que quede en el PATH). |
| La descarga desde YouTube dice "No se pudo descargar yt-dlp" | Kemix no llegó a GitHub para bajar yt-dlp (sin internet, proxy o firewall). Reintenta con conexión, o instala yt-dlp aparte y pon su ruta en Ajustes. |

Nota sobre Linux: las credenciales se cifran con el llavero del sistema (GNOME Keyring o KWallet). En un escritorio
sin llavero, Electron usa una clave fija, que es menos seguro.
