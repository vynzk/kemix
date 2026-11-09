import crypto from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron'
import { Kemix, type Cipher, type SpotifyWebSession } from '@kemix/core'
import { createServer } from '@kemix/server'

/** Dev: the Vite dev server (started by `npm run dev` at the repo root). Prod: the server serves the built UI. */
const DEV_UI_URL = 'http://localhost:5180'
const isDev = !app.isPackaged

/** Window/taskbar icon. Packaged Windows builds take it from the .exe; Linux and dev need it set explicitly. */
const windowIcon = isDev
	? path.join(app.getAppPath(), 'build', 'icon.png')
	: process.platform === 'linux'
		? path.join(process.resourcesPath, 'icon.png')
		: undefined

// Per-launch secret so only this window can talk to the local API, not other local programs or web pages.
const token = crypto.randomBytes(32).toString('hex')

/** Encrypt credentials with the OS keychain (DPAPI on Windows). */
const safeStorageCipher: Cipher = {
	encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
	decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64'))
}

let kemix: Kemix | undefined
let closeServer: (() => Promise<void>) | undefined

async function startBackend(): Promise<number> {
	kemix = new Kemix({ dataDir: app.getPath('userData'), cipher: safeStorageCipher })
	const port = kemix.settings.get().port
	const server = await createServer({
		kemix,
		token,
		uiDir: isDev ? undefined : path.join(process.resourcesPath, 'ui'),
		browserLogin: {
			qobuz: captureQobuzSession,
			spotify: {
				token: captureSpotifySession,
				logout: () => session.fromPartition(SPOTIFY_PARTITION).clearStorageData()
			}
		}
	})
	await server.listen({ host: '127.0.0.1', port })
	closeServer = () => server.close()
	kemix.start()
	return port
}

let qobuzLogin: { win: BrowserWindow; promise: Promise<string> } | undefined

/**
 * Open play.qobuz.com in a window so the user signs in on the real site (password, Google… whatever they use).
 * Once signed in, the web player calls Qobuz's API with `x-user-auth-token` / `x-app-id` headers: grab those,
 * close the window and hand them to the backend. Uses its own in-memory session, so nothing is shared with the
 * app window (and our local API token never reaches Qobuz).
 */
function captureQobuzSession(): Promise<string> {
	if (qobuzLogin && !qobuzLogin.win.isDestroyed()) {
		qobuzLogin.win.focus()
		return qobuzLogin.promise
	}
	const ses = session.fromPartition('kemix-qobuz-login')
	const win = new BrowserWindow({
		// play.qobuz.com refuses to run below 1024px of page width; size the page area (not the frame) above that.
		width: 1280,
		height: 860,
		minWidth: 1100,
		minHeight: 600,
		useContentSize: true,
		title: 'Inicia sesión en Qobuz',
		parent: BrowserWindow.getAllWindows()[0],
		autoHideMenuBar: true,
		webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
	})
	// Present as plain Chrome: some login providers refuse user agents that mention Electron.
	win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s(Electron|kemix|@kemix\/desktop)\/\S+/gi, ''))

	const promise = new Promise<string>((resolve, reject) => {
		let done = false
		ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.qobuz.com/api.json/*'] }, (details, cb) => {
			cb({ requestHeaders: details.requestHeaders })
			if (done) return
			const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]))
			const query = new URL(details.url).searchParams
			// Before sign-in the player already sends the header, empty or as "null"/"undefined": only accept a value
			// that looks like a real token, and keep waiting otherwise. Some calls carry it in the query instead.
			const isToken = (v: string | null | undefined): v is string => !!v && /^[\w.\-~+/=]{20,}$/.test(v.trim())
			const authToken = [headers['x-user-auth-token'], query.get('user_auth_token')].find(isToken)?.trim()
			if (!authToken) return
			done = true
			const appId = headers['x-app-id'] ?? query.get('app_id') ?? ''
			resolve(`x-app-id: ${appId}\nx-user-auth-token: ${authToken}`)
			setImmediate(() => !win.isDestroyed() && win.close())
		})
		win.on('closed', () => {
			ses.webRequest.onBeforeSendHeaders(null)
			qobuzLogin = undefined
			if (!done) reject(new Error('Se cerró la ventana de Qobuz antes de iniciar sesión'))
			// Forget the web session: the token now lives (encrypted) in Kemix.
			void ses.clearStorageData()
		})
	})
	void win.loadURL('https://play.qobuz.com/login')
	qobuzLogin = { win, promise }
	return promise
}

/** Kept on disk so the open.spotify.com sign-in survives restarts and the hourly token can be renewed silently. */
const SPOTIFY_PARTITION = 'persist:kemix-spotify'
/** Web player tokens last an hour; renew a bit before. */
const SPOTIFY_TOKEN_TTL = 50 * 60_000
/** Pages that make the player run each operation Kemix needs, in order: library + profile, liked songs, a playlist, search. */
const SPOTIFY_TOUR: [url: string, op: string][] = [
	['https://open.spotify.com/', 'libraryV3'],
	['https://open.spotify.com/collection/tracks', 'fetchLibraryTracks'],
	['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'fetchPlaylist'],
	['https://open.spotify.com/search/kemix/tracks', 'searchTracks']
]

let spotifyLogin: { win: BrowserWindow; promise: Promise<SpotifyWebSession> } | undefined

/**
 * Capture a signed-in open.spotify.com web player session: its access token and the GraphQL operations (persisted
 * query hash + variables) it sends to api-partner.spotify.com. Works for any account, Premium or not. Spotify changes
 * those hashes over time, so they're read from the real player instead of being hardcoded.
 * Interactive: show the window to sign in, then walk the player through the pages that run each operation.
 * Silent: renew the token with the saved session in a hidden window.
 */
function captureSpotifySession(interactive: boolean): Promise<SpotifyWebSession> {
	if (spotifyLogin && !spotifyLogin.win.isDestroyed()) {
		if (interactive) {
			spotifyLogin.win.show()
			spotifyLogin.win.focus()
		}
		return spotifyLogin.promise
	}
	const ses = session.fromPartition(SPOTIFY_PARTITION)
	const win = new BrowserWindow({
		show: interactive,
		width: 1100,
		height: 820,
		title: 'Inicia sesión en Spotify',
		parent: BrowserWindow.getAllWindows()[0],
		autoHideMenuBar: true,
		webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
	})
	win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s(Electron|kemix|@kemix\/desktop)\/\S+/gi, ''))

	const promise = new Promise<SpotifyWebSession>((resolve, reject) => {
		let done = false
		let token: string | undefined
		let clientToken: string | undefined
		const ops: SpotifyWebSession['ops'] = {}
		const signedIn = async () => (await ses.cookies.get({ name: 'sp_dc' })).length > 0
		// The player also sends an anonymous token before sign-in: remember those so they're never taken.
		const anonymous = new Set<string>()
		const finish = (result: SpotifyWebSession | Error) => {
			if (done) return
			done = true
			clearTimeout(timer)
			if (result instanceof Error) reject(result)
			else resolve(result)
			setImmediate(() => !win.isDestroyed() && win.close())
		}
		const timer = interactive
			? undefined
			: setTimeout(() => finish(new Error('el reproductor web no respondió con una sesión iniciada')), 45_000)
		const waitFor = async (ready: () => boolean, ms: number) => {
			for (const end = Date.now() + ms; !done && !ready() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 300))
			return ready()
		}
		const visit = (url: string) => win.loadURL(url).catch(() => {})

		ses.webRequest.onBeforeRequest({ urls: ['https://api-partner.spotify.com/pathfinder/*'] }, (details, cb) => {
			cb({})
			try {
				type Body = { operationName?: string; variables?: Record<string, unknown>; extensions?: { persistedQuery?: { sha256Hash?: string } } }
				let body: Body
				if (details.uploadData?.length) {
					body = JSON.parse(Buffer.concat(details.uploadData.map((u) => u.bytes ?? Buffer.alloc(0))).toString('utf8')) as Body
				} else {
					const q = new URL(details.url).searchParams
					body = {
						operationName: q.get('operationName') ?? undefined,
						variables: JSON.parse(q.get('variables') ?? '{}') as Record<string, unknown>,
						extensions: JSON.parse(q.get('extensions') ?? '{}') as Body['extensions']
					}
				}
				const hash = body.extensions?.persistedQuery?.sha256Hash
				if (body.operationName && hash) ops[body.operationName] = { hash, variables: body.variables ?? {} }
			} catch {
				// not a GraphQL call we understand
			}
		})
		ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.spotify.com/*'] }, (details, cb) => {
			cb({ requestHeaders: details.requestHeaders })
			if (done) return
			const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]))
			if (headers['client-token']) clientToken = headers['client-token']
			const bearer = headers.authorization?.match(/^Bearer\s+(\S{20,})$/i)?.[1]
			if (!bearer || bearer === token || anonymous.has(bearer)) return
			void signedIn().then((yes) => {
				if (yes) token = bearer
				else anonymous.add(bearer)
			})
		})
		win.on('closed', () => {
			ses.webRequest.onBeforeRequest(null)
			ses.webRequest.onBeforeSendHeaders(null)
			spotifyLogin = undefined
			finish(new Error(interactive ? 'Se cerró la ventana de Spotify antes de terminar' : 'no se pudo abrir el reproductor web'))
		})

		void (async () => {
			// With a saved session the player loads signed in; otherwise start at the login page, which returns to it.
			await visit(
				(await signedIn())
					? 'https://open.spotify.com/'
					: `https://accounts.spotify.com/login?continue=${encodeURIComponent('https://open.spotify.com/')}`
			)
			if (!(await waitFor(() => !!token, interactive ? Number.POSITIVE_INFINITY : 30_000))) return
			if (interactive) {
				// Signed in: read the rest without making the user watch the player navigate around. Don't hide() the
				// window: once a shown window is hidden the player stops loading its library (libraryV3 never arrives).
				// A transparent window that lets clicks through keeps rendering like a visible one.
				win.setOpacity(0)
				win.setIgnoreMouseEvents(true)
				win.setFocusable(false)
				win.getParentWindow()?.focus()
				for (const [url, op] of SPOTIFY_TOUR) {
					if (!ops[op]) await visit(url)
					await waitFor(() => !!ops[op], 15_000)
				}
			} else {
				await waitFor(() => !!ops.libraryV3, 8_000)
			}
			finish({ accessToken: token!, clientToken, expiresAt: Date.now() + SPOTIFY_TOKEN_TTL, ops: { ...ops } })
		})()
	})
	spotifyLogin = { win, promise }
	return promise
}

function createWindow(port: number) {
	const apiOrigin = `http://127.0.0.1:${port}`
	const uiUrl = isDev ? DEV_UI_URL : apiOrigin

	// Attach the token to every request the window makes to the UI/API origin (including SSE).
	session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${apiOrigin}/*`, `${DEV_UI_URL}/*`] }, (details, cb) => {
		details.requestHeaders['x-kemix-token'] = token
		cb({ requestHeaders: details.requestHeaders })
	})

	const win = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 960,
		minHeight: 600,
		backgroundColor: '#0d0e10',
		title: 'Kemix',
		icon: windowIcon,
		autoHideMenuBar: true,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
	})

	// Links (e.g. Spotify authorization) open in the user's real browser, never inside the app.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	win.webContents.on('will-navigate', (e, url) => {
		if (!url.startsWith(uiUrl)) {
			e.preventDefault()
			if (/^https?:\/\//.test(url)) void shell.openExternal(url)
		}
	})

	// In dev the Vite server may still be starting: retry until it answers.
	const load = () => win.loadURL(uiUrl).catch(() => setTimeout(load, 500))
	load()
}

// One instance only: a second one would fight over the port and the database.
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on('second-instance', () => {
		const win = BrowserWindow.getAllWindows()[0]
		if (win) {
			if (win.isMinimized()) win.restore()
			win.focus()
		}
	})
	app.whenReady().then(async () => {
		try {
			const port = await startBackend()
			createWindow(port)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			dialog.showErrorBox(
				'Kemix no pudo iniciar',
				/EADDRINUSE/.test(message) ? 'El puerto local ya está en uso. ¿Hay otra copia de Kemix abierta?' : message
			)
			app.quit()
		}
	})
}

app.on('window-all-closed', () => app.quit())

app.on('will-quit', (e) => {
	if (!kemix) return
	e.preventDefault()
	const k = kemix
	kemix = undefined
	void (closeServer?.() ?? Promise.resolve())
		.then(() => k.queue.flush())
		.finally(() => {
			k.close()
			app.quit()
		})
})
