import type { Db } from './db'
import type { EventBus } from './events'
import type { SecretStore } from './secrets'
import type { SettingsStore } from './settings'
import type {
	AccountInfo,
	AccountService,
	AccountStatus,
	AudioQuality,
	DownloadService,
	SoulseekStatus,
	SoundeoStatus,
	SourceService,
	SourceTrack,
	StreamPreview,
	TargetService
} from './types'
import { ACCOUNT_SERVICES, DOWNLOAD_SERVICES, isLossyService, isSourceService, isTargetService } from './types'
import type { SourceConnector } from './sources/types'
import { QobuzApi, QobuzSource, scrapeQobuzAppCredentials, type QobuzCredentials } from './sources/qobuz'
import { parseQobuzSession } from './sources/qobuz-session'
import { DeezerGw, DeezerSource, findIsrcOnDeezer } from './sources/deezer'
import {
	SpotifySource,
	createSpotifyAuthRequest,
	exchangeSpotifyCode,
	type SpotifyTokens
} from './sources/spotify'
import { SpotifyWebSource, type SpotifyWebSession } from './sources/spotify-web'
import { YtMusicSource, type YtMusicAccount } from './sources/ytmusic'
import { getCookie, normalizeCookieInput } from './sources/cookies'
import { YouTube } from './sources/youtube'
import { SoundCloud } from './sources/soundcloud'
import { extractSoundCloudToken, SoundCloudSource } from './sources/soundcloud-api'
import { ManagedYtDlp, YtDlp } from './sources/yt-dlp'
import { SoundeoApi, SoundeoDownloader, type SoundeoAccountState } from './sources/soundeo'
import { SlskClient, type SlskClientOptions } from './sources/soulseek-client'
import { prefersLossless, SoulseekDownloader } from './sources/soulseek'
import { createDeezerDownloader, createQobuzDownloader, type Downloader } from './download/lucida-adapter'
import { errorMessage, now } from './util'

interface DeezerSecret {
	arl: string
}
/** OAuth tokens from the user's own app (Premium), or the web player session (any account). */
type SpotifySecret = (SpotifyTokens & { mode?: 'api' }) | ({ mode: 'web' } & Partial<SpotifyWebSession>)

/** Desktop only: sign in on open.spotify.com in a window and use the web player's token. */
export interface SpotifyWebLogin {
	/** interactive: show the window so the user can sign in; otherwise reuse the saved session in a hidden window. */
	token(interactive: boolean): Promise<SpotifyWebSession>
	/** Forget the saved open.spotify.com session. */
	logout(): Promise<void>
}

interface SoundCloudSecret {
	/** The `oauth_token` cookie of a signed-in soundcloud.com session. */
	token: string
}

/**
 * Soundeo has no tokens: the session is a set of cookies, and it ends now and then. The password is kept (encrypted,
 * like every secret) to sign in again without asking.
 */
interface SoundeoSecret {
	email: string
	password: string
	cookies: Record<string, string>
}

/** Soulseek inicia sesión con usuario y contraseña cada vez que se conecta al servidor. */
interface SoulseekSecret {
	username: string
	password: string
}

interface YtMusicSecret {
	cookie: string
	/** Which signed-in Google account in the cookies to use (authuser). Missing in older connections = 0. */
	accountIndex?: number
}

/** How a Soundeo account shows next to its email. */
const soundeoPlan = (premium: boolean) => (premium ? 'Premium' : 'sin Premium')

function toSoundeoStatus(s: SoundeoAccountState): SoundeoStatus {
	return { premium: s.premium, downloadsLeft: s.downloadsLeft, bonusLeft: s.bonusLeft, resetsIn: s.resetsIn }
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

/** Accept the bare `arl` value or a cookie export (cookies.txt, header, JSON) and pull `arl` out of it. */
export function extractDeezerArl(raw: string): string {
	const input = raw.replace(/^﻿/, '').trim()
	if (!/[=;\t\n[]/.test(input)) return input
	const arl = getCookie(normalizeCookieInput(input, 'www.deezer.com'), 'arl')
	if (!arl) {
		throw new Error(
			'No encontré la cookie arl de Deezer. Exporta las cookies con la sesión iniciada en deezer.com (p. ej. con Get cookies.txt).'
		)
	}
	return arl.trim()
}

export class Accounts {
	#sources = new Map<SourceService, SourceConnector>()
	#downloaders = new Map<TargetService, Promise<Downloader>>()
	#pendingSpotify = new Map<string, { verifier: string; clientId: string; redirectUri: string }>()
	/** Plain YouTube: preview player and lossy fallback downloads. Needs no account. */
	readonly youtube: YouTube
	/** SoundCloud downloads: work without an account, and go through it when one is connected. */
	readonly soundcloud: SoundCloud

	constructor(
		private db: Db,
		private secrets: SecretStore,
		private settings: SettingsStore,
		private events: EventBus,
		/** Where Kemix keeps the tools it downloads for itself (its own yt-dlp). */
		binDir: string,
		/** Cómo se conecta Soulseek: por defecto TCP y el servidor real; los tests pasan una red en memoria. */
		private soulseekOptions: Pick<SlskClientOptions, 'transport' | 'server' | 'timing'> = {}
	) {
		const ytDlp = new YtDlp(() => this.settings.get().ytDlpPath, new ManagedYtDlp(binDir))
		this.soundcloud = new SoundCloud(ytDlp, () =>
			this.isConnected('soundcloud') ? (this.secrets.get<SoundCloudSecret>('soundcloud')?.token ?? null) : null
		)
		this.youtube = new YouTube(
			ytDlp,
			() => {
				const c = this.secrets.get<YtMusicSecret>('ytmusic')
				return c ? { cookie: c.cookie, accountIndex: c.accountIndex ?? 0 } : null
			},
			async () => {
				if (!this.isConnected('ytmusic')) return false
				const src = this.source('ytmusic')
				return src instanceof YtMusicSource && src.hasPremium()
			}
		)
	}

	list(): AccountInfo[] {
		const rows = this.db.prepare('SELECT service, display_name, email, status, error FROM accounts').all() as {
			service: AccountService
			display_name: string | null
			email: string | null
			status: AccountStatus
			error: string | null
		}[]
		const byService = new Map(rows.map((r) => [r.service, r]))
		return ACCOUNT_SERVICES.map((service) => {
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

	isConnected(service: AccountService) {
		return this.list().find((a) => a.service === service)?.status === 'connected'
	}

	/**
	 * Record an account's state. A successful connection replaces name and email (it may be a different account);
	 * an error keeps the previous identity so the user still sees which account broke.
	 */
	#setStatus(
		service: AccountService,
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
	#forgetPreviousAccount(service: AccountService, next: { name?: string | null; email?: string | null }) {
		// Only sources have playlists of their own (Soulseek's local playlist doesn't belong to the account).
		if (!isSourceService(service)) return
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
			if (a.status !== 'connected' || a.email || !isSourceService(a.service)) continue
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
	reportError(service: AccountService, err: unknown) {
		this.#setStatus(service, 'error', { error: errorMessage(err) })
		this.#forgetClients(service)
	}

	disconnect(service: AccountService) {
		if (service === 'spotify' && this.secrets.get<SpotifySecret>('spotify')?.mode === 'web') {
			void this.#spotifyWeb?.logout().catch(() => {})
		}
		this.secrets.delete(service)
		this.#forgetClients(service)
		this.db.prepare('DELETE FROM accounts WHERE service = ?').run(service)
		this.events.emit({ type: 'accounts' })
	}

	/** Drop the cached clients of an account, so the next use starts from its stored credentials. */
	#forgetClients(service: AccountService) {
		if (isSourceService(service)) this.#sources.delete(service)
		if (isTargetService(service)) this.#downloaders.delete(service)
		if (service === 'soundeo') this.#soundeoApi = undefined
		if (service === 'soulseek') {
			this.#soulseekClient?.destroy()
			this.#soulseekClient = undefined
		}
	}

	/** Cierra las conexiones abiertas (al salir de la app). */
	close() {
		this.#soulseekClient?.destroy()
		this.#soulseekClient = undefined
	}

	// ---- Qobuz ----

	/** Connect with the session captured by the desktop app's play.qobuz.com login window. */
	async connectQobuz(capturedSession: string) {
		try {
			const session = parseQobuzSession(capturedSession)
			if (!session.tokens.length) {
				throw new Error('La ventana de Qobuz no entregó un token válido. Vuelve a intentarlo y espera a que cargue el reproductor.')
			}

			// A token is only valid with the app id that issued it: prefer the one seen in the window's traffic.
			const scraped = await step('Obtener el app id de play.qobuz.com', scrapeQobuzAppCredentials)
			const appId = session.appId ?? scraped.appId
			// The scraped secrets belong to the scraped app id; they're only worth trying for that same id.
			const secrets = scraped.appId === appId ? scraped.secrets : []

			const api = new QobuzApi({ appId })
			const user = await step('Iniciar sesión en Qobuz', async () => {
				let lastError: unknown
				for (const token of session.tokens) {
					try {
						return await api.login({ token, userId: session.userId })
					} catch (err) {
						lastError = err
					}
				}
				throw new Error(`Qobuz no aceptó la sesión (app id ${appId}): ${errorMessage(lastError)}`)
			})

			const appSecret = await step('Validar el app secret', async () => {
				for (const s of secrets) if (await api.testSecret(s)) return s
				throw new Error(
					`El app id ${appId} no coincide con el del reproductor web actual de Qobuz. Vuelve a intentarlo; si sigue fallando, Qobuz cambió su web.`
				)
			})

			const creds: QobuzCredentials = {
				appId,
				appSecret,
				token: user.token,
				userId: user.userId,
				userName: user.userName,
				email: user.email
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
			const arl = extractDeezerArl(input.arl)
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

	// ---- SoundCloud ----

	/**
	 * Connect with a soundcloud.com session: the `oauth_token` cookie, captured by the desktop app's login window or
	 * pulled out of a cookie export.
	 */
	async connectSoundCloud(input: { cookie: string }) {
		try {
			const token = extractSoundCloudToken(input.cookie)
			const src = new SoundCloudSource(token)
			const id = await step('Iniciar sesión en SoundCloud', () => src.identity())
			this.secrets.set('soundcloud', { token } satisfies SoundCloudSecret)
			this.#sources.set('soundcloud', src)
			this.#setStatus('soundcloud', 'connected', { name: id.name, email: id.email })
		} catch (err) {
			this.#setStatus('soundcloud', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	// ---- Soundeo ----

	#soundeoApi?: SoundeoApi

	/** The signed-in Soundeo client, from the stored session. It signs in again by itself when the session ends. */
	#soundeo(): SoundeoApi {
		if (this.#soundeoApi) return this.#soundeoApi
		const stored = this.secrets.get<SoundeoSecret>('soundeo')
		if (!stored) throw new Error('Soundeo no está conectado')
		const api: SoundeoApi = new SoundeoApi({
			cookies: stored.cookies,
			credentials: { email: stored.email, password: stored.password },
			onCookies: (cookies) => {
				// Only while it's still the connected account (it may have been reconnected or disconnected meanwhile).
				const current = this.secrets.get<SoundeoSecret>('soundeo')
				if (current && this.#soundeoApi === api) this.secrets.set('soundeo', { ...current, cookies } satisfies SoundeoSecret)
			},
			onSessionLost: (err) => {
				if (this.#soundeoApi === api) this.reportError('soundeo', err)
			}
		})
		this.#soundeoApi = api
		return api
	}

	/**
	 * Connect a Soundeo account with its email and password. Any account connects, but only Premium ones can download
	 * (Soundeo sells no single tracks). The first time a Premium account is connected, Soundeo joins the download
	 * priority after the other lossless services, so tracks they don't have come from it.
	 */
	async connectSoundeo(input: { email: string; password: string }): Promise<SoundeoStatus> {
		const wasConnected = this.isConnected('soundeo')
		try {
			const email = input.email.trim()
			if (!email || !input.password) throw new Error('Escribe el email y la contraseña de tu cuenta de Soundeo')
			const api = new SoundeoApi()
			const state = await step('Iniciar sesión en Soundeo', () => api.login(email, input.password))
			this.secrets.set('soundeo', { email, password: input.password, cookies: api.cookies() } satisfies SoundeoSecret)
			this.#forgetClients('soundeo')
			this.#setStatus('soundeo', 'connected', { name: soundeoPlan(state.premium), email })
			if (state.premium && !wasConnected) this.#addToPriority('soundeo')
			return toSoundeoStatus(state)
		} catch (err) {
			// Changing credentials failed: the current connection still works, so don't flag it as broken.
			if (!wasConnected) this.#setStatus('soundeo', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	/** Whether the Soundeo account has Premium now, and how many downloads it has left today. */
	async soundeoStatus(): Promise<SoundeoStatus> {
		if (!this.isConnected('soundeo')) throw new Error('Soundeo no está conectado')
		const state = await this.#soundeo().status()
		// Premium bought or expired since connecting: keep the account's label in step.
		const name = soundeoPlan(state.premium)
		const res = this.db
			.prepare('UPDATE accounts SET display_name = ? WHERE service = ? AND display_name IS NOT ?')
			.run(name, 'soundeo', name)
		if (res.changes) this.events.emit({ type: 'accounts' })
		return toSoundeoStatus(state)
	}

	/** Soundeo's clip of a track (needs no account). */
	async soundeoPreview(trackId: string): Promise<StreamPreview | null> {
		const api = this.isConnected('soundeo') ? this.#soundeo() : new SoundeoApi()
		const url = await api.preview(trackId)
		return url ? { url, full: false } : null
	}

	// ---- Soulseek ----

	#soulseekClient?: SlskClient

	#newSoulseekClient(username: string, password: string): SlskClient {
		const client: SlskClient = new SlskClient({
			...this.soulseekOptions,
			username,
			password,
			port: () => this.settings.get().soulseekPort,
			onSessionLost: (err) => {
				if (this.#soulseekClient === client) this.reportError('soulseek', err)
			}
		})
		return client
	}

	/** La sesión de Soulseek de la cuenta conectada. Inicia sesión al usarse por primera vez. */
	soulseek(): SlskClient {
		if (this.#soulseekClient) return this.#soulseekClient
		const stored = this.secrets.get<SoulseekSecret>('soulseek')
		if (!stored) throw new Error('Soulseek no está conectado')
		this.#soulseekClient = this.#newSoulseekClient(stored.username, stored.password)
		return this.#soulseekClient
	}

	/** El downloader de Soulseek: la pantalla de búsqueda le pasa lo que encuentra, para tener otras fuentes. */
	async soulseekDownloader(): Promise<SoulseekDownloader> {
		return (await this.downloader('soulseek')) as SoulseekDownloader
	}

	/**
	 * Conecta Soulseek con usuario y contraseña. Soulseek crea la cuenta la primera vez que alguien entra con un
	 * nombre libre, así que un usuario nuevo también sirve. La primera vez, Soulseek entra en la prioridad de descarga
	 * después de los servicios sin pérdida: se usa para lo que no esté en ellos.
	 */
	async connectSoulseek(input: { username: string; password: string }): Promise<SoulseekStatus> {
		const wasConnected = this.isConnected('soulseek')
		try {
			const username = input.username.trim()
			if (!username || !input.password) throw new Error('Escribe el usuario y la contraseña de Soulseek')
			const previous = this.#soulseekClient
			// Mientras se prueba la cuenta nueva, los avisos de la sesión anterior ya no cuentan.
			this.#soulseekClient = undefined
			const client = this.#newSoulseekClient(username, input.password)
			try {
				await step('Iniciar sesión en Soulseek', () => client.login())
			} catch (err) {
				client.destroy()
				this.#soulseekClient = previous
				throw err
			}
			previous?.destroy()
			this.#soulseekClient = client
			this.secrets.set('soulseek', { username, password: input.password } satisfies SoulseekSecret)
			this.#setStatus('soulseek', 'connected', { name: username })
			if (!wasConnected) this.#addToPriority('soulseek')
			return { ...client.status(), error: null }
		} catch (err) {
			// Cambiar de cuenta falló: la conexión actual sigue funcionando, no se marca como rota.
			if (!wasConnected) this.#setStatus('soulseek', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	/** Si la sesión de Soulseek está en línea, y si otros usuarios pueden conectarse directamente con Kemix. */
	async soulseekStatus(): Promise<SoulseekStatus> {
		if (!this.isConnected('soulseek')) throw new Error('Soulseek no está conectado')
		const client = this.soulseek()
		try {
			await client.login()
			return { ...client.status(), error: null }
		} catch (err) {
			return { ...client.status(), error: errorMessage(err) }
		}
	}

	/** Cambió el puerto de Soulseek en Ajustes: la sesión se vuelve a abrir, escuchando en el nuevo. */
	soulseekPortChanged() {
		this.#soulseekClient?.destroy()
		this.#soulseekClient = undefined
	}

	/** Put a download service in the priority list, before the lossy ones, unless it's already there. */
	#addToPriority(service: TargetService) {
		const priority = this.settings.get().servicePriority
		if (priority.includes(service)) return
		const at = priority.findIndex((s) => isLossyService(s))
		const next = [...priority]
		next.splice(at < 0 ? next.length : at, 0, service)
		this.settings.update({ servicePriority: next })
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
			const src = new SpotifySource(tokens, (t) => this.secrets.set('spotify', t))
			const me = await src.me()
			if (me.premium === false) {
				throw new Error(
					`La cuenta ${me.email ?? me.displayName} no es Premium y Spotify solo abre su Web API a cuentas Premium. ` +
						'Conecta con «Iniciar sesión en Spotify (sin Premium)»: carga tus playlists igual.'
				)
			}
			this.secrets.set('spotify', tokens)
			this.#sources.set('spotify', src)
			this.#setStatus('spotify', 'connected', { name: me.displayName, email: me.email })
		} catch (err) {
			this.#setStatus('spotify', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	#spotifyWeb?: SpotifyWebLogin

	setSpotifyWebLogin(login: SpotifyWebLogin) {
		this.#spotifyWeb = login
	}

	/** Connect any Spotify account (Premium or not) through the open.spotify.com web player session. */
	async connectSpotifyWeb() {
		const login = this.#spotifyWeb
		if (!login) throw new Error('Iniciar sesión en Spotify en una ventana solo está disponible en la app de escritorio')
		try {
			const session = await login.token(true)
			if (!session.ops.libraryV3) {
				throw new Error('No se pudo leer tu biblioteca desde el reproductor web de Spotify. Vuelve a intentarlo.')
			}
			const src = this.#spotifyWebSource(session)
			const me = await src.identity()
			this.secrets.set('spotify', { mode: 'web', ...session } satisfies SpotifySecret)
			this.#sources.set('spotify', src)
			this.#setStatus('spotify', 'connected', { name: `${me.name ?? 'Spotify'} (reproductor web)` })
		} catch (err) {
			this.#setStatus('spotify', 'error', { error: errorMessage(err) })
			throw err
		}
	}

	#spotifyWebSource(initial: SpotifyWebSession | undefined) {
		return new SpotifyWebSource(
			initial,
			async () => {
				if (!this.#spotifyWeb) throw new Error('La sesión de Spotify sin Premium solo se renueva desde la app de escritorio')
				try {
					return await this.#spotifyWeb.token(false)
				} catch (err) {
					throw new Error(`La sesión de Spotify expiró: vuelve a iniciar sesión en Cuentas (${errorMessage(err)})`)
				}
			},
			(s) => this.secrets.set('spotify', { mode: 'web', ...s } satisfies SpotifySecret)
		)
	}

	#spotify(secret: SpotifySecret): SourceConnector {
		if (secret.mode !== 'web') return new SpotifySource(secret, (t) => this.secrets.set('spotify', t))
		const { mode: _mode, ...session } = secret
		return this.#spotifyWebSource(session.accessToken ? (session as SpotifyWebSession) : undefined)
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
				const c = this.secrets.get<SpotifySecret>('spotify')
				if (c) src = this.#spotify(c)
				break
			}
			case 'ytmusic': {
				const c = this.secrets.get<YtMusicSecret>('ytmusic')
				if (c) src = new YtMusicSource(c.cookie, c.accountIndex ?? 0)
				break
			}
			case 'soundcloud': {
				const c = this.secrets.get<SoundCloudSecret>('soundcloud')
				if (c) src = new SoundCloudSource(c.token)
				break
			}
		}
		if (!src) throw new Error(`La cuenta de ${service} no está conectada`)
		this.#sources.set(service, src)
		return src
	}

	/**
	 * Best quality each download service gives with the connected account. Missing = not connected or the account
	 * couldn't be read. YouTube and SoundCloud need no account (they're the on-request lossy fallbacks).
	 */
	async downloadQualities(): Promise<Partial<Record<DownloadService, AudioQuality>>> {
		const out: Partial<Record<DownloadService, AudioQuality>> = {}
		await Promise.all(
			DOWNLOAD_SERVICES.map(async (service) => {
				if (!isLossyService(service) && !this.isConnected(service)) return
				try {
					out[service] = await (await this.downloader(service)).accountQuality()
				} catch {
					// shown as unknown
				}
			})
		)
		return out
	}

	/** A track's ISRC from Deezer's public catalog, for sources that don't give one. Needs no Deezer account. */
	findIsrc(track: SourceTrack, minScore: number) {
		return findIsrcOnDeezer(track, minScore)
	}

	downloader(service: DownloadService): Promise<Downloader> {
		if (service === 'youtube') return Promise.resolve(this.youtube.downloader())
		if (service === 'soundcloud') return Promise.resolve(this.soundcloud.downloader())
		let d = this.#downloaders.get(service)
		if (!d) {
			d = this.#createDownloader(service)
			d.catch(() => this.#downloaders.delete(service))
			this.#downloaders.set(service, d)
		}
		return d
	}

	async #createDownloader(service: TargetService): Promise<Downloader> {
		if (service === 'soundeo') return new SoundeoDownloader(this.#soundeo())
		if (service === 'soulseek') {
			return new SoulseekDownloader(
				() => this.soulseek(),
				() => prefersLossless(this.settings.get().downloadQuality)
			)
		}
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
			if (isLossyService(service)) {
				out.push(await this.downloader(service))
				continue
			}
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
