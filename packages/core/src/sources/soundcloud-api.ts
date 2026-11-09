import type { AccountIdentity, SourcePlaylist, SourceTrack } from '../types'
import type { SourceConnector } from './types'
import { cleanArtist } from '../match/score'
import { getCookie, normalizeCookieInput } from './cookies'
import { SessionExpiredError } from '../util'

const API = 'https://api-v2.soundcloud.com/'
/** SoundCloud's API answers differently (or not at all) to clients that don't look like its own web player. */
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
/** The liked tracks, listed as one more playlist. */
export const SOUNDCLOUD_LIKES_ID = 'likes'
const SESSION_EXPIRED = 'La sesión de SoundCloud expiró o se cerró: vuelve a conectar la cuenta en Cuentas.'

/** Script URLs in soundcloud.com's page: the client id is in one of them (usually the last). */
export function scriptUrls(html: string): string[] {
	return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!)
}

export function findClientId(script: string): string | null {
	return /client_id\s*:\s*"([0-9a-zA-Z]{32})"/.exec(script)?.[1] ?? null
}

/**
 * The public client id of SoundCloud's web player, which every API call needs. Read from its scripts, the way yt-dlp
 * does: SoundCloud changes it every now and then.
 */
async function scrapeClientId(): Promise<string> {
	const page = await fetch('https://soundcloud.com/', { headers: { 'user-agent': USER_AGENT } })
	if (!page.ok) throw new Error(`soundcloud.com respondió ${page.status}`)
	for (const src of scriptUrls(await page.text()).reverse()) {
		const res = await fetch(src, { headers: { 'user-agent': USER_AGENT } }).catch(() => null)
		const id = res?.ok ? findClientId(await res.text()) : null
		if (id) return id
	}
	throw new Error('no se encontró el client id en soundcloud.com (cambió su web)')
}

let clientId: Promise<string> | undefined
function getClientId(refresh = false): Promise<string> {
	if (refresh || !clientId) {
		clientId = scrapeClientId().catch((err) => {
			clientId = undefined
			throw err
		})
	}
	return clientId
}

/**
 * Accept the bare `oauth_token` value or a cookie export of soundcloud.com (cookies.txt, header, JSON) and pull it out.
 */
export function extractSoundCloudToken(raw: string): string {
	const input = raw.replace(/^﻿/, '').trim()
	if (!input) throw new Error('Pega o carga las cookies de soundcloud.com')
	if (!/[=;\t\n[]/.test(input)) return input
	const token = getCookie(normalizeCookieInput(input, 'soundcloud.com'), 'oauth_token')
	if (!token) {
		throw new Error(
			'No encontré la cookie oauth_token de SoundCloud. Exporta las cookies con la sesión iniciada en soundcloud.com.'
		)
	}
	return decodeURIComponent(token.trim())
}

interface RawUser {
	id: number
	username?: string
	full_name?: string
	avatar_url?: string
	likes_count?: number
}

export interface RawTrack {
	id: number
	title?: string
	permalink_url?: string
	duration?: number
	/** The whole track; `duration` is only the 30 s preview for Go+ tracks when the account can't play them. */
	full_duration?: number
	artwork_url?: string | null
	user?: { username?: string; avatar_url?: string }
	publisher_metadata?: { artist?: string; album_title?: string; isrc?: string } | null
}

interface RawPlaylist {
	id: number
	title?: string
	track_count?: number
	artwork_url?: string | null
	last_modified?: string
	user?: { username?: string }
	tracks?: RawTrack[]
}

interface Page<T> {
	collection?: T[]
	next_href?: string | null
}

/** The 500×500 artwork (SoundCloud hands out the 100×100 one). */
function artwork(url: string | null | undefined): string | undefined {
	return url ? url.replace(/-large\.(jpg|png)(\?|$)/, '-t500x500.$1$2') : undefined
}

export function toSourceTrack(t: RawTrack): SourceTrack | null {
	if (!t.title || !t.permalink_url) return null
	// Labels fill in the real artist; otherwise the uploader is the best there is.
	const artist = t.publisher_metadata?.artist?.trim() || (t.user?.username ? cleanArtist(t.user.username) : '')
	const duration = t.full_duration || t.duration
	return {
		sourceId: String(t.id),
		title: t.title,
		artists: artist ? [artist] : [],
		album: t.publisher_metadata?.album_title || undefined,
		durationMs: duration || undefined,
		isrc: t.publisher_metadata?.isrc || undefined,
		coverUrl: artwork(t.artwork_url ?? t.user?.avatar_url),
		url: t.permalink_url
	}
}

/** A signed-in SoundCloud account: its playlists, the playlists it liked, its liked tracks, and search. */
export class SoundCloudSource implements SourceConnector {
	readonly service = 'soundcloud' as const
	#me?: Promise<RawUser>

	constructor(private token: string) {}

	async #request<T>(method: 'GET' | 'POST', pathOrUrl: string, query: Record<string, string | number> = {}, body?: unknown) {
		for (const retry of [false, true]) {
			const url = new URL(pathOrUrl, API)
			for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
			url.searchParams.set('client_id', await getClientId(retry))
			const res = await fetch(url, {
				method,
				headers: {
					authorization: `OAuth ${this.token}`,
					'user-agent': USER_AGENT,
					accept: 'application/json',
					...(body ? { 'content-type': 'application/json' } : {})
				},
				body: body ? JSON.stringify(body) : undefined
			})
			if (res.ok) return (await res.json()) as T
			// A stale client id gets 401/403 too: get a fresh one once before blaming the session.
			if ((res.status === 401 || res.status === 403) && !retry) continue
			if (res.status === 401) throw new SessionExpiredError(SESSION_EXPIRED)
			const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200)
			throw new Error(`SoundCloud respondió ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
		}
		throw new SessionExpiredError(SESSION_EXPIRED)
	}

	#get<T>(pathOrUrl: string, query: Record<string, string | number> = {}) {
		return this.#request<T>('GET', pathOrUrl, query)
	}

	/** Every item of a paginated list. */
	async #all<T>(path: string): Promise<T[]> {
		const out: T[] = []
		let page = await this.#get<Page<T>>(path, { limit: 200, linked_partitioning: 1 })
		for (;;) {
			out.push(...(page.collection ?? []))
			if (!page.next_href) return out
			page = await this.#get<Page<T>>(page.next_href)
		}
	}

	#user() {
		this.#me ??= this.#get<RawUser>('me').catch((err) => {
			this.#me = undefined
			throw err
		})
		return this.#me
	}

	async identity(): Promise<AccountIdentity> {
		const me = await this.#user()
		return { name: me.full_name?.trim() || me.username }
	}

	async #likes() {
		const me = await this.#user()
		return this.#all<{ track?: RawTrack; playlist?: RawPlaylist }>(`users/${me.id}/likes`)
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		const me = await this.#user()
		const toPlaylist = (p: RawPlaylist): SourcePlaylist => ({
			sourceId: String(p.id),
			name: p.title ?? 'Sin título',
			owner: p.user?.username,
			coverUrl: artwork(p.artwork_url),
			trackCount: p.track_count,
			snapshot: `${p.last_modified ?? ''}:${p.track_count ?? ''}`
		})
		const own = (await this.#all<RawPlaylist>(`users/${me.id}/playlists`)).map(toPlaylist)
		const likes = await this.#likes()
		const liked = likes.flatMap((l) => (l.playlist ? [toPlaylist(l.playlist)] : []))
		const tracks = likes.filter((l) => l.track)
		const seen = new Set(own.map((p) => p.sourceId))
		return [
			{
				sourceId: SOUNDCLOUD_LIKES_ID,
				name: 'Me gusta (SoundCloud)',
				owner: me.username,
				trackCount: tracks.length,
				snapshot: `${tracks.length}:${tracks[0]?.track?.id ?? ''}`
			},
			...own,
			...liked.filter((p) => !seen.has(p.sourceId))
		]
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		if (playlistId === SOUNDCLOUD_LIKES_ID) {
			return (await this.#likes()).flatMap((l) => {
				const t = l.track && toSourceTrack(l.track)
				return t ? [t] : []
			})
		}
		const playlist = await this.#get<RawPlaylist>(`playlists/${encodeURIComponent(playlistId)}`)
		const tracks = playlist.tracks ?? []
		// Only the first few tracks come complete; the rest are bare ids, fetched 50 at a time.
		const missing = tracks.filter((t) => !t.permalink_url).map((t) => t.id)
		const full = new Map<number, RawTrack>()
		for (let i = 0; i < missing.length; i += 50) {
			const ids = missing.slice(i, i + 50).join(',')
			for (const t of await this.#get<RawTrack[]>('tracks', { ids, playlistId })) full.set(t.id, t)
		}
		return tracks.flatMap((t) => {
			const s = toSourceTrack(full.get(t.id) ?? t)
			return s ? [s] : []
		})
	}

	async search(query: string, limit: number): Promise<SourceTrack[]> {
		const res = await this.#get<Page<RawTrack>>('search/tracks', { q: query, limit: Math.min(limit, 50) })
		return (res.collection ?? []).flatMap((t) => {
			const s = toSourceTrack(t)
			return s ? [s] : []
		})
	}

	/** SoundCloud refuses playlist writes from anything but its own site: Kemix creates them on another service instead. */
	async createPlaylist(): Promise<string> {
		throw new Error(
			'SoundCloud no permite crear playlists desde otras apps. Elige otro servicio conectado (Spotify, YouTube Music, ' +
				'Qobuz o Deezer) y Kemix busca ahí los temas.'
		)
	}
}
