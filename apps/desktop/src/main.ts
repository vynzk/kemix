import crypto from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron'
import { Kemix, type Cipher } from '@kemix/core'
import { createServer } from '@kemix/server'

/** Dev: the Vite dev server (started by `npm run dev` at the repo root). Prod: the server serves the built UI. */
const DEV_UI_URL = 'http://localhost:5180'
const isDev = !app.isPackaged

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
		browserLogin: { qobuz: captureQobuzSession }
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
