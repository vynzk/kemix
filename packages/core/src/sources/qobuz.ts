import crypto from 'node:crypto'
import type { SourceConnector } from './types'
import type { AccountIdentity, SourcePlaylist, SourceTrack, StreamPreview } from '../types'
import { fetchJson, HttpError } from '../util'

const API = 'https://www.qobuz.com/api.json/0.2/'
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex')

export interface QobuzCredentials {
	appId: string
	appSecret: string
	token: string
	userId?: string
	userName?: string
	email?: string
}

/**
 * Qobuz does not publish an API for third parties, so (like streamrip/qobuz-dl) we read the web player's
 * app id and secrets from its JS bundle and keep the first secret that can sign a getFileUrl request.
 */
export async function scrapeQobuzAppCredentials(): Promise<{ appId: string; secrets: string[] }> {
	const loginPage = await (await fetch('https://play.qobuz.com/login')).text()
	const bundlePath = loginPage.match(/<script src="(\/resources\/\d+\.\d+\.\d+-[a-z]\d{3}\/bundle\.js)"/)?.[1]
	if (!bundlePath) throw new Error('No se encontró el bundle de play.qobuz.com (¿cambió el sitio?)')
	const bundle = await (await fetch(`https://play.qobuz.com${bundlePath}`)).text()

	const appId = bundle.match(/production:\{api:\{appId:"(\d{9})",appSecret:"(\w{32})"/)?.[1]
	if (!appId) throw new Error('No se encontró el app_id de Qobuz en el bundle')

	const seeds = [...bundle.matchAll(/[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)/g)].map((m) => ({
		seed: m[1]!,
		timezone: m[2]!
	}))
	const secrets: string[] = []
	for (const { seed, timezone } of seeds) {
		const tz = timezone.charAt(0).toUpperCase() + timezone.slice(1)
		const info = bundle.match(new RegExp(`name:"\\w+/${tz}",info:"([\\w=]+)",extras:"([\\w=]+)"`))
		if (!info) continue
		const encoded = (seed + info[1] + info[2]).slice(0, -44)
		const secret = Buffer.from(encoded, 'base64').toString('utf8')
		if (secret) secrets.push(secret)
	}
	if (!secrets.length) throw new Error('No se encontraron secrets de Qobuz en el bundle')
	return { appId, secrets }
}

export class QobuzApi {
	constructor(private creds: { appId: string; appSecret?: string; token?: string }) {}

	async get<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
		const url = new URL(endpoint, API)
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
		url.searchParams.set('app_id', this.creds.appId)
		const headers: Record<string, string> = { 'X-App-Id': this.creds.appId }
		if (this.creds.token) {
			// Header for most endpoints; some only look at the query parameter (lucida sends both too).
			headers['X-User-Auth-Token'] = this.creds.token
			if (!url.searchParams.has('user_auth_token')) url.searchParams.set('user_auth_token', this.creds.token)
		}
		return fetchJson<T>(url, { headers })
	}

	/** Write calls (create a playlist, add tracks) go as a form POST, like the web player sends them. */
	async post<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
		const url = new URL(endpoint, API)
		url.searchParams.set('app_id', this.creds.appId)
		const body = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))
		const headers: Record<string, string> = {
			'X-App-Id': this.creds.appId,
			'Content-Type': 'application/x-www-form-urlencoded'
		}
		if (this.creds.token) {
			headers['X-User-Auth-Token'] = this.creds.token
			body.set('user_auth_token', this.creds.token)
		}
		return fetchJson<T>(url, { method: 'POST', headers, body })
	}

	/**
	 * Log in with an existing session (token, plus user id when known) captured from play.qobuz.com.
	 * The login response already carries the user's name and email, so no extra user lookup is needed.
	 */
	async login(input: { userId?: string; token: string }): Promise<{ token: string; userId?: string; userName: string; email?: string }> {
		type LoginResponse = {
			user_auth_token: string
			user: { id: number; display_name?: string; login?: string; email?: string }
		}
		const fromLogin = (res: LoginResponse) => {
			this.creds.token = res.user_auth_token
			return {
				token: res.user_auth_token,
				userId: String(res.user.id),
				userName: res.user.display_name ?? res.user.login ?? res.user.email ?? String(res.user.id),
				email: res.user.email
			}
		}

		// Existing session. With the user id this is the documented token login; without it, try what Qobuz
		// accepts for a bare token, and as a last resort just check the token works for an authenticated call.
		const token = input.token
		if (input.userId) {
			return fromLogin(await this.get<LoginResponse>('user/login', { user_id: input.userId, user_auth_token: token }))
		}
		this.creds.token = token
		try {
			return fromLogin(await this.get<LoginResponse>('user/login', { user_auth_token: token }))
		} catch {
			// fall through
		}
		try {
			const me = await this.get<{ id: number; display_name?: string; login?: string; email?: string }>('user/get', {})
			return { token, userId: String(me.id), userName: me.display_name ?? me.login ?? String(me.id), email: me.email }
		} catch {
			// fall through
		}
		await this.get('playlist/getUserPlaylists', { limit: 1 })
		return { token, userName: 'Cuenta de Qobuz' }
	}

	/** Signed track/getFileUrl: a direct link to the audio file (it expires after a while). */
	async fileUrl(trackId: number | string, formatId: number, secret: string) {
		const ts = Math.floor(Date.now() / 1000)
		const sig = md5(`trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${ts}${secret}`)
		return this.get<{ url?: string; sample?: boolean; mime_type?: string }>('track/getFileUrl', {
			track_id: trackId,
			format_id: formatId,
			intent: 'stream',
			request_ts: ts,
			request_sig: sig
		})
	}

	/** True if `secret` can sign a track/getFileUrl request for this app id. */
	async testSecret(secret: string): Promise<boolean> {
		try {
			await this.fileUrl(5966783, 27, secret)
			return true
		} catch (err) {
			if (err instanceof HttpError && err.status === 400) return false
			if (err instanceof HttpError && err.status === 401) {
				throw new Error('Qobuz rechazó la sesión al pedir un archivo de prueba: ¿tu suscripción está activa?')
			}
			throw err
		}
	}
}

interface QobuzPlaylistRaw {
	id: number
	name: string
	tracks_count?: number
	updated_at?: number
	owner?: { name?: string }
	images300?: string[]
	image_rectangle?: string[]
}

interface QobuzTrackRaw {
	id: number
	title: string
	version?: string | null
	isrc?: string
	duration?: number
	performer?: { name: string }
	album?: { title?: string; artist?: { name: string }; image?: { large?: string } }
}

export class QobuzSource implements SourceConnector {
	readonly service = 'qobuz' as const
	#api: QobuzApi

	constructor(private creds: QobuzCredentials) {
		this.#api = new QobuzApi(creds)
	}

	async identity(): Promise<AccountIdentity> {
		// Captured from the login response when connecting; Qobuz has no simple "who am I" call for a bare token.
		return { name: this.creds.userName, email: this.creds.email }
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		const out: SourcePlaylist[] = []
		for (let offset = 0; ; offset += 500) {
			const res = await this.#api.get<{ playlists: { items: QobuzPlaylistRaw[]; total: number } }>(
				'playlist/getUserPlaylists',
				{ limit: 500, offset }
			)
			for (const p of res.playlists.items) {
				out.push({
					sourceId: String(p.id),
					name: p.name,
					owner: p.owner?.name,
					coverUrl: p.images300?.[0] ?? p.image_rectangle?.[0],
					trackCount: p.tracks_count,
					snapshot: `${p.updated_at ?? ''}:${p.tracks_count ?? ''}`
				})
			}
			if (offset + 500 >= res.playlists.total) break
		}
		return out
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		const out: SourceTrack[] = []
		for (let offset = 0; ; offset += 500) {
			const res = await this.#api.get<{ tracks: { items: QobuzTrackRaw[]; total: number } }>('playlist/get', {
				playlist_id: playlistId,
				extra: 'tracks',
				limit: 500,
				offset
			})
			for (const t of res.tracks.items) out.push(parseQobuzTrack(t))
			if (offset + 500 >= res.tracks.total) break
		}
		return out
	}

	async search(query: string, limit: number): Promise<SourceTrack[]> {
		const res = await this.#api.get<{ tracks?: { items: QobuzTrackRaw[] } }>('catalog/search', {
			query,
			type: 'tracks',
			limit
		})
		return (res.tracks?.items ?? []).map(parseQobuzTrack)
	}

	async stream(trackId: string): Promise<StreamPreview | null> {
		// 5 = MP3 320: starts fast and every subscription has it. Without an active subscription Qobuz sends a clip.
		const res = await this.#api.fileUrl(trackId, 5, this.creds.appSecret)
		return res.url ? { url: res.url, full: !res.sample } : null
	}

	async createPlaylist(name: string, trackIds: string[]): Promise<string> {
		const playlist = await this.#api.post<{ id: number }>('playlist/create', {
			name,
			description: 'Creada con Kemix',
			is_public: 0,
			is_collaborative: 0
		})
		for (let i = 0; i < trackIds.length; i += 50) {
			await this.#api.post('playlist/addTracks', {
				playlist_id: playlist.id,
				track_ids: trackIds.slice(i, i + 50).join(','),
				no_duplicate: 1
			})
		}
		return String(playlist.id)
	}
}

function parseQobuzTrack(t: QobuzTrackRaw): SourceTrack {
	const artist = t.performer?.name ?? t.album?.artist?.name
	return {
		sourceId: String(t.id),
		title: t.version ? `${t.title} (${t.version})` : t.title,
		artists: artist ? [artist] : [],
		album: t.album?.title,
		durationMs: t.duration ? t.duration * 1000 : undefined,
		isrc: t.isrc,
		coverUrl: t.album?.image?.large,
		url: `https://play.qobuz.com/track/${t.id}`
	}
}
