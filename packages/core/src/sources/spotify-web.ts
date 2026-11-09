import type { SourceConnector } from './types'
import type { AccountIdentity, SourcePlaylist, SourceTrack } from '../types'
import { HttpError, largest, sleep } from '../util'
import { SPOTIFY_LIKED_ID } from './spotify'

const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/v2/query'

/** A GraphQL operation the web player sent: its persisted-query hash and the variables it used (a template). */
export interface SpotifyWebOp {
	hash: string
	variables: Record<string, unknown>
}

/** What the desktop app captures from a signed-in open.spotify.com: the player's token and its operations. */
export interface SpotifyWebSession {
	accessToken: string
	clientToken?: string
	expiresAt: number
	ops: Record<string, SpotifyWebOp>
}

const STALE =
	'Spotify cambió su reproductor web y Kemix no reconoce la operación. Vuelve a iniciar sesión en Spotify desde Cuentas.'

interface RawTrack {
	__typename?: string
	uri?: string
	name?: string
	trackDuration?: { totalMilliseconds?: number }
	duration?: { totalMilliseconds?: number }
	artists?: { items?: { profile?: { name?: string } }[] }
	albumOfTrack?: { name?: string; coverArt?: { sources?: { url: string; width?: number | null }[] } }
}

interface RawLibraryItem {
	__typename?: string
	uri?: string
	name?: string
	count?: number
	ownerV2?: { data?: { name?: string } }
	images?: { items?: { sources?: { url: string; width?: number | null }[] }[] }
	/** Changes with every edit of the playlist. */
	revisionId?: string
}

/** Parallel requests when reading playlist sizes. */
const COUNT_CONCURRENCY = 4

const idFromUri = (uri: string | undefined, kind: string) => uri?.match(new RegExp(`^spotify:${kind}:([A-Za-z0-9]+)$`))?.[1]

function toTrack(t: RawTrack | undefined): SourceTrack[] {
	const id = idFromUri(t?.uri, 'track')
	if (!t || !id || !t.name || (t.__typename && t.__typename !== 'Track')) return []
	return [
		{
			sourceId: id,
			title: t.name,
			artists: (t.artists?.items ?? []).flatMap((a) => (a.profile?.name ? [a.profile.name] : [])),
			album: t.albumOfTrack?.name,
			durationMs: t.trackDuration?.totalMilliseconds ?? t.duration?.totalMilliseconds,
			coverUrl: largest(t.albumOfTrack?.coverArt?.sources),
			url: `https://open.spotify.com/track/${id}`
		}
	]
}

/**
 * Spotify for any account, Premium or not, through the web player's own GraphQL API (pathfinder). The public Web API
 * rate-limits web player tokens right away, and with a personal Client ID it only works for Premium accounts.
 * The token (about an hour) and the operations' hashes come from a signed-in open.spotify.com in the desktop app,
 * which `renew` asks for again in a hidden window. No ISRCs here: matching falls back to title/artist/duration.
 */
export class SpotifyWebSource implements SourceConnector {
	readonly service = 'spotify' as const
	#session?: SpotifyWebSession
	#pending?: Promise<SpotifyWebSession>
	/** Playlist sizes already read, with the revision they belong to. */
	#counts = new Map<string, { revision: string; count: number }>()

	constructor(
		initial: SpotifyWebSession | undefined,
		private renew: () => Promise<SpotifyWebSession>,
		private onSession: (s: SpotifyWebSession) => void
	) {
		this.#session = initial
	}

	async #current(): Promise<SpotifyWebSession> {
		const s = this.#session
		if (s && Date.now() < s.expiresAt - 60_000) return s
		this.#pending ??= this.renew().finally(() => (this.#pending = undefined))
		const fresh = await this.#pending
		// A silent renewal may only see some operations: keep the ones captured before.
		this.#session = { ...fresh, ops: { ...s?.ops, ...fresh.ops } }
		this.onSession(this.#session)
		return this.#session
	}

	has(op: string): boolean {
		return !!this.#session?.ops[op]
	}

	async query<T>(op: string, variables: Record<string, unknown>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const s = await this.#current()
			const known = s.ops[op]
			if (!known) throw new Error(STALE)
			const res = await fetch(PATHFINDER, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${s.accessToken}`,
					'Content-Type': 'application/json;charset=UTF-8',
					'app-platform': 'WebPlayer',
					...(s.clientToken ? { 'client-token': s.clientToken } : {})
				},
				body: JSON.stringify({
					operationName: op,
					variables: { ...known.variables, ...variables },
					extensions: { persistedQuery: { version: 1, sha256Hash: known.hash } }
				})
			})
			// Token expired early: renew once.
			if (res.status === 401 && attempt === 0) {
				this.#session = { ...s, expiresAt: 0 }
				continue
			}
			if (res.status === 429 && attempt < 4) {
				await sleep(2000 * (attempt + 1))
				continue
			}
			const text = await res.text()
			if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText} — ${text.slice(0, 300)}`)
			const json = JSON.parse(text) as { data?: T; errors?: { message?: string }[] }
			if (!json.data) {
				const message = json.errors?.map((e) => e.message).join('; ') ?? 'respuesta vacía'
				throw new Error(/PersistedQuery/i.test(message) ? STALE : `Spotify: ${message}`)
			}
			return json.data
		}
	}

	async identity(): Promise<AccountIdentity> {
		if (!this.has('profileAttributes')) return { name: 'Sesión iniciada' }
		const data = await this.query<{ me?: { profile?: { name?: string; username?: string } } }>('profileAttributes', {})
		return { name: data.me?.profile?.name ?? data.me?.profile?.username ?? 'Sesión iniciada' }
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		const out: SourcePlaylist[] = []
		let likedListed = false
		const limit = 50
		for (let offset = 0; offset < 10_000; offset += limit) {
			const data = await this.query<{
				me?: { libraryV3?: { totalCount?: number; items?: { item?: { data?: RawLibraryItem } }[] } }
			}>('libraryV3', { offset, limit, ...(this.#template('libraryV3', 'flatten') ? { flatten: true } : {}) })
			const lib = data.me?.libraryV3
			for (const { item } of lib?.items ?? []) {
				const p = item?.data
				if (p?.uri === 'spotify:collection:tracks') {
					likedListed = true
					out.push({ sourceId: SPOTIFY_LIKED_ID, name: 'Canciones que te gustan', trackCount: p.count })
					continue
				}
				const id = idFromUri(p?.uri, 'playlist')
				if (!p || !id || p.__typename !== 'Playlist') continue
				out.push({
					sourceId: id,
					name: p.name ?? id,
					owner: p.ownerV2?.data?.name,
					coverUrl: largest(p.images?.items?.[0]?.sources),
					snapshot: p.revisionId
				})
			}
			if (!lib?.items?.length || offset + limit >= (lib.totalCount ?? 0)) break
		}
		await this.#fillCounts(out)
		if (!likedListed && this.has('fetchLibraryTracks')) {
			out.unshift({ sourceId: SPOTIFY_LIKED_ID, name: 'Canciones que te gustan' })
		}
		return out
	}

	/**
	 * The library lists playlists without their size: read it from each one's first page (`limit: 1`). Sizes are kept
	 * per revision, so later syncs only ask for playlists that changed. Best-effort: on any failure it stops asking
	 * and those playlists keep the size the library last saw.
	 */
	async #fillCounts(playlists: SourcePlaylist[]) {
		if (!this.has('fetchPlaylist')) return
		const missing = playlists.filter((p) => {
			if (p.sourceId === SPOTIFY_LIKED_ID || p.trackCount !== undefined) return false
			const known = this.#counts.get(p.sourceId)
			if (known && p.snapshot && known.revision === p.snapshot) {
				p.trackCount = known.count
				return false
			}
			return true
		})
		let next = 0
		let failed = false
		const worker = async () => {
			while (!failed && next < missing.length) {
				const p = missing[next++]!
				try {
					const data = await this.query<{ playlistV2?: { content?: { totalCount?: number } } }>('fetchPlaylist', {
						uri: `spotify:playlist:${p.sourceId}`,
						offset: 0,
						limit: 1
					})
					const count = data.playlistV2?.content?.totalCount
					if (count === undefined) continue
					p.trackCount = count
					if (p.snapshot) this.#counts.set(p.sourceId, { revision: p.snapshot, count })
				} catch {
					// Most likely rate-limited: don't keep hammering Spotify for a cosmetic number.
					failed = true
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, missing.length) }, worker))
	}

	#template(op: string, key: string): boolean {
		return !!this.#session?.ops[op] && key in this.#session.ops[op]!.variables
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		const out: SourceTrack[] = []
		if (playlistId === SPOTIFY_LIKED_ID) {
			const limit = 50
			for (let offset = 0; ; offset += limit) {
				const data = await this.query<{
					me?: { library?: { tracks?: { totalCount?: number; items?: { track?: { data?: RawTrack; _uri?: string } }[] } } }
				}>('fetchLibraryTracks', { offset, limit })
				const page = data.me?.library?.tracks
				for (const it of page?.items ?? []) out.push(...toTrack({ uri: it.track?._uri, ...it.track?.data }))
				if (!page?.items?.length || offset + limit >= (page.totalCount ?? 0)) break
			}
			return out
		}
		const limit = 100
		for (let offset = 0; ; offset += limit) {
			const data = await this.query<{
				playlistV2?: { content?: { totalCount?: number; items?: { itemV2?: { data?: RawTrack } }[] } }
			}>('fetchPlaylist', { uri: `spotify:playlist:${playlistId}`, offset, limit })
			const content = data.playlistV2?.content
			for (const it of content?.items ?? []) out.push(...toTrack(it.itemV2?.data))
			if (!content?.items?.length || offset + limit >= (content.totalCount ?? 0)) break
		}
		return out
	}

	async search(query: string, limit: number): Promise<SourceTrack[]> {
		const data = await this.query<{ searchV2?: { tracksV2?: { items?: { item?: { data?: RawTrack } }[] } } }>(
			'searchTracks',
			{ searchTerm: query, offset: 0, limit }
		)
		return (data.searchV2?.tracksV2?.items ?? []).flatMap((it) => toTrack(it.item?.data))
	}

	async createPlaylist(): Promise<string> {
		throw new Error(
			'Con Spotify conectado sin Premium (sesión del reproductor web), Spotify no deja crear playlists desde Kemix. ' +
				'Créala en otro servicio, o conecta Spotify con Client ID si tienes Premium.'
		)
	}
}
