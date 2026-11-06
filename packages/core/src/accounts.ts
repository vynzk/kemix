import type { Db } from './db'
import type { EventBus } from './events'
import type { SecretStore } from './secrets'
import type { SettingsStore } from './settings'
import type { AccountInfo, AccountStatus, SourceService, TargetService } from './types'
import { SOURCE_SERVICES } from './types'
import type { SourceConnector } from './sources/types'
import { QobuzApi, QobuzSource, scrapeQobuzAppCredentials, type QobuzCredentials } from './sources/qobuz'
import { parseQobuzSession } from './sources/qobuz-session'
import { DeezerGw, DeezerSource } from './sources/deezer'
import {
	SpotifySource,
	createSpotifyAuthRequest,
	exchangeSpotifyCode,
	type SpotifyTokens
} from './sources/spotify'
import { YtMusicSource, type YtMusicAccount } from './sources/ytmusic'
import { getCookie, normalizeCookieInput } from './sources/cookies'
import { createDeezerDownloader, createQobuzDownloader, type Downloader } from './download/lucida-adapter'
import { errorMessage, now } from './util'

interface DeezerSecret {
	arl: string
}
interface YtMusicSecret {
	cookie: string
	/** Which signed-in Google account in the cookies to use (authuser). Missing in older connections = 0. */
	accountIndex?: number
}

/** Run one step of a multi-step connection, prefixing any error with the step's name. */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn()
	} catch (err) {
		throw new Error(`${label}: ${errorMessage(err)}`)
	}
}

/** Normalize pasted cookies (header, cookies.txt or JSON) and make sure the session cookie youtubei.js needs is there. */
function prepareYtCookie(raw: string): string {
	let cookie = normalizeCookieInput(raw, 'music.youtube.com')
	if (!cookie) throw new Error('No se encontraron cookies de youtube.com en lo que pegaste')
	// youtubei.js signs requests with SAPISID; some exports only carry its __Secure-3PAPISID twin (same value).
	if (!getCookie(cookie, 'SAPISID')) {
		const secure = getCookie(cookie, '__Secure-3PAPISID')
		if (!secure) {
			throw new Error('Faltan las cookies de sesión (SAPISID). Exporta las cookies con la sesión iniciada en music.youtube.com.')
		}
		cookie += `; SAPISID=${secure}`
	}
	return cookie
}

export class Accounts {
	#sources = new Map<SourceService, SourceConnector>()
	#downloaders = new Map<TargetService, Promise<Downloader>>()
	#pendingSpotify = new Map<string, { verifier: string; clientId: string; redirectUri: string }>()

	constructor(
		private db: Db,
		private secrets: SecretStore,
		private settings: SettingsStore,
		private events: EventBus
	) {}

	list(): AccountInfo[] {
		const rows = this.db.prepare('SELECT service, display_name, email, status, error FROM accounts').all() as {
			service: SourceService
			display_name: string | null
			email: string | null
			status: AccountStatus
			error: string | null
		}[]
		const byService = new Map(rows.map((r) => [r.service, r]))
		return SOURCE_SERVICES.map((service) => {
			const r = byService.get(service)
			return {
				service,
				status: r?.status ?? 'disconnected',
				displayName: r?.display_name ?? null,
				email: r?.email ?? null,
				error: r?.error ?? null
			}
		})
	}

	isConnected(service: SourceService) {
		return this.list().find((a) => a.service === service)?.status === 'connected'
	}

	/**
	 * Record an account's state. A successful connection replaces name and email (it may be a different account);
	 * an error keeps the previous identity so the user still sees which account broke.
	 */
	#setStatus(
		service: SourceService,
		status: AccountStatus,
		info: { name?: string | null; email?: string | null; error?: string | null } = {}
	) {
		if (status === 'connected') this.#forgetPreviousAccount(service, info)
		this.db
			.prepare(
				`INSERT INTO accounts (service, display_name, email, status, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(service) DO UPDATE SET
				   display_name = CASE WHEN excluded.status = 'connected' THEN excluded.display_name ELSE accounts.display_name END,
				   email = CASE WHEN excluded.status = 'connected' THEN excluded.email ELSE accounts.email END,
				   status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`
			)
			.run(service, info.name ?? null, info.email ?? null, status, info.error ?? null, now())
		this.events.emit({ type: 'accounts' })
	}

	/**
	 * When a service is reconnected as a *different* account, drop the old account's playlists from the library
	 * (they'd otherwise linger as "removed"). Downloaded files stay on disk and in the files index, so they are
	 * reused if the same tracks are downloaded again.
	 */
	#forgetPreviousAccount(service: SourceService, next: { name?: string | null; email?: string | null }) {
		const prev = this.db.prepare('SELECT display_name, email FROM accounts WHERE service = ?').get(service) as
			| { display_name: string | null; email: string | null }
			| undefined
		if (!prev) return
		const changed =
			prev.email && next.email
				? prev.email.toLowerCase() !== next.email.toLowerCase()
				: !!prev.display_name && !!next.name && prev.display_name !== next.name && !prev.email && !next.email
		if (!changed) return
		this.db.prepare('DELETE FROM playlists WHERE source = ?').run(service)
		this.events.emit({ type: 'library' })
	}

	/**
	 * Fill in name/email for connected accounts that don't have an email yet (e.g. connected before emails were
	 * stored). Best-effort: failures are ignored here; real problems surface on the next sync.
	 */
	async refreshIdentities() {
		for (const a of this.list()) {
			if (a.status !== 'connected' || a.email) continue
			try {
				const id = await this.source(a.service).identity()
				if (!id.email && !id.name) continue
				this.db
					.prepare('UPDATE accounts SET display_name = COALESCE(?, display_name), email = ? WHERE service = ?')
					.run(id.name ?? null, id.email ?? null, a.service)
				this.events.emit({ type: 'accounts' })
			} catch {
				// ignore
			}
		}
	}

	/** Mark an account as broken (e.g. expired token) so the UI asks the user to reconnect. */
	reportError(service: SourceService, err: unknown) {
		this.#setStatus(service, 'error', { error: errorMessage(err) })
		this.#sources.delete(service)
		if (service === 'qobuz' || service === 'deezer') this.#downloaders.delete(service)
	}

	disconnect(service: SourceService) {
		this.secrets.delete(service)
		this.#sources.delete(service)
		if (service === 'qobuz' || service === 'deezer') this.#downloaders.delete(service)
		this.db.prepare('DELETE FROM accounts WHERE service = ?').run(service)
		this.events.emit({ type: 'accounts' })
	}

	// ---- Qobuz ----

	async connectQobuz(input: {
		email?: string
		password?: string
		/** Anything holding an existing session: cookies.txt, a request copied as cURL, the `localuser` JSON, a token. */
		session?: string
		appId?: string
		appSecret?: string
	}) {
		try {
			const session = input.session?.trim() ? parseQobuzSession(input.session) : null
			if (session && !session.tokens.length) {
				throw new Error(
					'No encontré un token de Qobuz en lo que pegaste. Si usaste cookies.txt, puede que Qobuz no guarde la sesión ' +
						'en cookies: copia una petición del reproductor como cURL (ver instrucciones).'
				)
			}
			if (!session && (!input.email?.trim() || !input.password)) throw new Error('Falta el email o la contraseña')

			// App id priority: typed by the user > taken from the pasted session (the one that issued the token) >
			// scraped from the web player bundle. A token is only valid with the app id that issued it.
			let appId = input.appId?.trim() || session?.appId
			let appIdSource = input.appId?.trim() ? 'escrito a mano' : session?.appId ? 'de la sesión pegada' : ''
			let secrets = input.appSecret?.trim() ? [input.appSecret.trim()] : []
			if (!appId || !secrets.length) {
				const scraped = await step('Obtener el app id de play.qobuz.com', scrapeQobuzAppCredentials)
				if (!appId) {
					appId = scraped.appId
					appIdSource = 'extraído de play.qobuz.com'
				}
				// The scraped secrets belong to the scraped app id; they're only worth trying for that same id.
				if (!secrets.length && scraped.appId === appId) secrets = scraped.secrets
			}
			const appIdNote = `app id ${appId}, ${appIdSource}`

			const api = new QobuzApi({ appId })
			const user = await step('Iniciar sesión en Qobuz', async () => {
				if (!session) return api.login({ email: input.email!.trim(), password: input.password! })
				// A cookie export can yield several candidates: keep the first token Qobuz accepts.
				let lastError: unknown
				for (const token of session.tokens) {
					try {
						return await api.login({ token, userId: session.userId })
					} catch (err) {
						lastError = err
					}
				}
				const tried = session.sources.join(', ')
				const onlyCookies = session.sources.every((src) => src.startsWith('cookie'))
				throw new Error(
					`Qobuz no aceptó ${session.tokens.length === 1 ? 'el token' : `ninguno de los ${session.tokens.length} tokens`} ` +
						`que encontré (${tried}; ${appIdNote}): ${errorMessage(lastError)}` +
						(onlyCookies
							? '\n\nEsas cookies no son la sesión del reproductor: Qobuz no la guarda en cookies. ' +
								'Copia el header x-user-auth-token de una petición (ver instrucciones).'
							: '')
				)
			}).catch((err) => {
				if (!session && err instanceof Error && /\b401\b/.test(err.message)) {
					throw new Error(
						`${err.message} (${appIdNote})

Revisa el email y la contraseña. Si creaste la cuenta de Qobuz con Google, Apple o ` +
							'Facebook no tienes contraseña de Qobuz: usa "Entrar con una sesión del navegador".'
					)
				}
				throw err
			})

			const appSecret = await step('Validar el app secret', async () => {
				for (const s of secrets) if (await api.testSecret(s)) return s
				throw new Error(
					secrets.length
						? `Ningún app secret de Qobuz es válido para el ${appIdNote}; pega uno a mano en Opciones avanzadas`
						: `El ${appIdNote} no coincide con el del reproductor web actual, así que no hay secret para él; pégalo en Opciones avanzadas`
				)
			})

			const creds: QobuzCredentials = {
				appId,
				appSecret,
				token: user.token,
				userId: user.userId,
				userName: user.userName,
				email: user.email ?? input.email?.trim()
			}
			this.secrets.set('qobuz', creds)
			this.#sources.delete('qobuz')
			this.#downloaders.delete('qobuz')
			this.#setStatus('qobuz', 'connected', { name: creds.userName, email: creds.email })
		} catch (err) {
			this.#setStatus('qobuz', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	// ---- Deezer ----

	async connectDeezer(input: { arl: string }) {
		try {
			const arl = input.arl.trim()
			const gw = new DeezerGw(arl)
			const data = await gw.init()
			this.secrets.set('deezer', { arl } satisfies DeezerSecret)
			this.#sources.delete('deezer')
			this.#downloaders.delete('deezer')
			// Without lossless the account still works, but downloads will be MP3: say so instead of failing.
			const name = gw.userName ?? gw.userId
			this.#setStatus('deezer', 'connected', {
				name: data.USER.OPTIONS?.web_lossless ? name : `${name} (sin FLAC)`,
				email: gw.email
			})
		} catch (err) {
			this.#setStatus('deezer', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	// ---- YouTube Music ----

	/**
	 * Connect YouTube Music. Cookies from a browser with several Google accounts signed in cover all of them, so:
	 * - without `accountIndex`, and if the cookies hold more than one account, return the list for the user to pick;
	 * - with `accountIndex`, connect as that account.
	 * Without `cookie`, the stored cookie is reused (to switch account without exporting cookies again).
	 */
	async connectYtMusic(input: {
		cookie?: string
		accountIndex?: number
	}): Promise<{ status: 'connected' } | { status: 'choose'; accounts: YtMusicAccount[] }> {
		const switching = !input.cookie?.trim()
		try {
			const cookie = switching ? this.#storedYtCookie() : prepareYtCookie(input.cookie!)
			let accountIndex = input.accountIndex
			if (accountIndex === undefined) {
				const accounts = await YtMusicSource.discoverAccounts(cookie)
				if (accounts.length > 1 || switching) return { status: 'choose', accounts }
				accountIndex = 0
			}
			const src = new YtMusicSource(cookie, accountIndex)
			const id = await src.verify()
			this.secrets.set('ytmusic', { cookie, accountIndex } satisfies YtMusicSecret)
			this.#sources.set('ytmusic', src)
			this.#setStatus('ytmusic', 'connected', { name: id.name, email: id.email })
			return { status: 'connected' }
		} catch (err) {
			// Switching accounts failed: the current connection is untouched, so don't flag it as broken.
			if (!switching) this.#setStatus('ytmusic', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	#storedYtCookie(): string {
		const stored = this.secrets.get<YtMusicSecret>('ytmusic')
		if (!stored) throw new Error('Pega o carga las cookies de YouTube Music')
		return stored.cookie
	}

	// ---- Spotify (OAuth PKCE) ----

	spotifyRedirectUri() {
		return `http://127.0.0.1:${this.settings.get().port}/api/auth/spotify/callback`
	}

	startSpotifyAuth(): string {
		const clientId = this.settings.get().spotifyClientId
		if (!clientId) throw new Error('Configura primero el Client ID de tu app de Spotify')
		const redirectUri = this.spotifyRedirectUri()
		const req = createSpotifyAuthRequest(clientId, redirectUri)
		this.#pendingSpotify.set(req.state, { verifier: req.verifier, clientId, redirectUri })
		return req.url
	}

	async finishSpotifyAuth(code: string, state: string) {
		const pending = this.#pendingSpotify.get(state)
		if (!pending) throw new Error('Estado OAuth desconocido o expirado; vuelve a intentarlo desde la app')
		this.#pendingSpotify.delete(state)
		try {
			const tokens = await exchangeSpotifyCode({ code, ...pending })
			this.secrets.set('spotify', tokens)
			const src = this.#spotify(tokens)
			const me = await src.me()
			this.#sources.set('spotify', src)
			this.#setStatus('spotify', 'connected', { name: me.displayName, email: me.email })
		} catch (err) {
			this.#setStatus('spotify', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	#spotify(tokens: SpotifyTokens) {
		return new SpotifySource(tokens, (t) => this.secrets.set('spotify', t))
	}

	// ---- accessors ----

	source(service: SourceService): SourceConnector {
		const cached = this.#sources.get(service)
		if (cached) return cached
		let src: SourceConnector | undefined
		switch (service) {
			case 'qobuz': {
				const c = this.secrets.get<QobuzCredentials>('qobuz')
				if (c) src = new QobuzSource(c)
				break
			}
			case 'deezer': {
				const c = this.secrets.get<DeezerSecret>('deezer')
				if (c) src = new DeezerSource(c.arl)
				break
			}
			case 'spotify': {
				const c = this.secrets.get<SpotifyTokens>('spotify')
				if (c) src = this.#spotify(c)
				break
			}
			case 'ytmusic': {
				const c = this.secrets.get<YtMusicSecret>('ytmusic')
				if (c) src = new YtMusicSource(c.cookie, c.accountIndex ?? 0)
				break
			}
		}
		if (!src) throw new Error(`La cuenta de ${service} no está conectada`)
		this.#sources.set(service, src)
		return src
	}

	downloader(service: TargetService): Promise<Downloader> {
		let d = this.#downloaders.get(service)
		if (!d) {
			d = this.#createDownloader(service)
			d.catch(() => this.#downloaders.delete(service))
			this.#downloaders.set(service, d)
		}
		return d
	}

	async #createDownloader(service: TargetService): Promise<Downloader> {
		if (service === 'qobuz') {
			const c = this.secrets.get<QobuzCredentials>('qobuz')
			if (!c) throw new Error('Qobuz no está conectado')
			return createQobuzDownloader(c)
		}
		const c = this.secrets.get<DeezerSecret>('deezer')
		if (!c) throw new Error('Deezer no está conectado')
		return createDeezerDownloader(c.arl)
	}

	/** Connected download services, in the user's priority order. */
	async downloaders(): Promise<Downloader[]> {
		const out: Downloader[] = []
		for (const service of this.settings.get().servicePriority) {
			if (!this.isConnected(service)) continue
			try {
				out.push(await this.downloader(service))
			} catch (err) {
				this.reportError(service, err)
			}
		}
		return out
	}
}
