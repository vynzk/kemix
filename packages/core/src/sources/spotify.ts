import crypto from 'node:crypto'
import type { SourceConnector } from './types'
import type { AccountIdentity, SourcePlaylist, SourceTrack } from '../types'
import { fetchJson, HttpError, largest } from '../util'

const SCOPES = [
	'playlist-read-private',
	'playlist-read-collaborative',
	'user-library-read',
	'user-read-private',
	'user-read-email'
]
const API = 'https://api.spotify.com/v1'
/** Pseudo playlist id for the user's "Liked Songs", which the API exposes separately. */
export const SPOTIFY_LIKED_ID = '__liked__'

export interface SpotifyTokens {
	accessToken: string
	refreshToken: string
	expiresAt: number
	clientId: string
}

export function createSpotifyAuthRequest(clientId: string, redirectUri: string) {
	const verifier = crypto.randomBytes(48).toString('base64url')
	const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
	const state = crypto.randomBytes(16).toString('hex')
	const url = new URL('https://accounts.spotify.com/authorize')
	url.search = new URLSearchParams({
		client_id: clientId,
		response_type: 'code',
		redirect_uri: redirectUri,
		code_challenge_method: 'S256',
		code_challenge: challenge,
		scope: SCOPES.join(' '),
		state
	}).toString()
	return { url: url.toString(), verifier, state }
}

interface TokenResponse {
	access_token: string
	refresh_token?: string
	expires_in: number
}

export async function exchangeSpotifyCode(opts: {
	clientId: string
	code: string
	verifier: string
	redirectUri: string
}): Promise<SpotifyTokens> {
	const res = await tokenRequest({
		grant_type: 'authorization_code',
		code: opts.code,
		redirect_uri: opts.redirectUri,
		client_id: opts.clientId,
		code_verifier: opts.verifier
	})
	return {
		accessToken: res.access_token,
		refreshToken: res.refresh_token!,
		expiresAt: Date.now() + res.expires_in * 1000,
		clientId: opts.clientId
	}
}

function tokenRequest(body: Record<string, string>) {
	return fetchJson<TokenResponse>('https://accounts.spotify.com/api/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(body)
	})
}

interface SpotifyTrackRaw {
	id: string | null
	type?: string
	name: string
	is_local?: boolean
	duration_ms?: number
	external_ids?: { isrc?: string }
	artists?: { name: string }[]
	album?: { name?: string; images?: { url: string; width?: number | null }[] }
	external_urls?: { spotify?: string }
}

interface Paging<T> {
	items: T[]
	next: string | null
}

export class SpotifySource implements SourceConnector {
	readonly service = 'spotify' as const

	constructor(
		private tokens: SpotifyTokens,
		/** Called whenever tokens are refreshed so they can be persisted. */
		private onTokens: (t: SpotifyTokens) => void
	) {}

	async #token(): Promise<string> {
		if (Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken
		const res = await tokenRequest({
			grant_type: 'refresh_token',
			refresh_token: this.tokens.refreshToken,
			client_id: this.tokens.clientId
		})
		this.tokens = {
			...this.tokens,
			accessToken: res.access_token,
			refreshToken: res.refresh_token ?? this.tokens.refreshToken,
			expiresAt: Date.now() + res.expires_in * 1000
		}
		this.onTokens(this.tokens)
		return this.tokens.accessToken
	}

	async get<T>(urlOrPath: string): Promise<T> {
		const url = urlOrPath.startsWith('http') ? urlOrPath : `${API}${urlOrPath}`
		for (let attempt = 0; ; attempt++) {
			try {
				return await fetchJson<T>(url, { headers: { Authorization: `Bearer ${await this.#token()}` } })
			} catch (err) {
				// Rate limited: back off and retry a few times.
				if (err instanceof HttpError && err.status === 429 && attempt < 4) {
					await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
					continue
				}
				throw err
			}
		}
	}

	async #all<T>(first: string): Promise<T[]> {
		const out: T[] = []
		for (let next: string | null = first; next; ) {
			const page: Paging<T> = await this.get<Paging<T>>(next)
			out.push(...page.items)
			next = page.next
		}
		return out
	}

	async me(): Promise<{ id: string; displayName: string; email?: string }> {
		// `email` is only present when the token has the user-read-email scope (connections made before it was added lack it).
		const me = await this.get<{ id: string; display_name?: string; email?: string }>('/me')
		return { id: me.id, displayName: me.display_name ?? me.id, email: me.email }
	}

	async identity(): Promise<AccountIdentity> {
		const me = await this.me()
		return { name: me.displayName, email: me.email }
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		type Raw = {
			id: string
			name: string
			snapshot_id: string
			owner?: { display_name?: string }
			images?: { url: string; width?: number | null }[] | null
			// The playlist track count moved from `tracks` to `items` in newer API versions.
			tracks?: { total: number }
			items?: { total: number }
		}
		const raw = await this.#all<Raw | null>('/me/playlists?limit=50')
		const liked = await this.get<{ total: number }>('/me/tracks?limit=1')
		return [
			{ sourceId: SPOTIFY_LIKED_ID, name: 'Canciones que te gustan', trackCount: liked.total, snapshot: String(liked.total) },
			...raw
				.filter((p): p is Raw => !!p)
				.map((p) => ({
					sourceId: p.id,
					name: p.name,
					owner: p.owner?.display_name,
					coverUrl: largest(p.images ?? undefined),
					trackCount: p.items?.total ?? p.tracks?.total,
					snapshot: p.snapshot_id
				}))
		]
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		type Item = { track?: SpotifyTrackRaw | null; item?: SpotifyTrackRaw | null }
		let items: Item[]
		if (playlistId === SPOTIFY_LIKED_ID) {
			items = await this.#all<Item>('/me/tracks?limit=50')
		} else {
			try {
				items = await this.#all<Item>(`/playlists/${playlistId}/items?limit=100`)
			} catch (err) {
				if (!(err instanceof HttpError && err.status === 404)) throw err
				items = await this.#all<Item>(`/playlists/${playlistId}/tracks?limit=100`)
			}
		}
		const out: SourceTrack[] = []
		for (const it of items) {
			const t = it.item ?? it.track
			if (!t || !t.id || t.is_local || (t.type && t.type !== 'track')) continue
			out.push({
				sourceId: t.id,
				title: t.name,
				artists: t.artists?.map((a) => a.name) ?? [],
				album: t.album?.name,
				durationMs: t.duration_ms,
				isrc: t.external_ids?.isrc,
				coverUrl: largest(t.album?.images),
				url: t.external_urls?.spotify
			})
		}
		return out
	}
}
