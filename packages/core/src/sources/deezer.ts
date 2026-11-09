import type { SourceConnector } from './types'
import type { AccountIdentity, SourcePlaylist, SourceTrack, StreamPreview } from '../types'
import { queryParts, scoreMatch } from '../match/score'
import { fetchJson } from '../util'

const GW_LIGHT = 'https://www.deezer.com/ajax/gw-light.php'
const HEADERS = {
	Accept: '*/*',
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'Content-Type': 'text/plain;charset=UTF-8',
	Origin: 'https://www.deezer.com',
	Referer: 'https://www.deezer.com/'
}

/** Minimal client for Deezer's private web API (gw-light), authenticated with the `arl` cookie. */
export class DeezerGw {
	#arl: string
	#sid?: string
	#apiToken = ''
	userId?: string
	userName?: string
	email?: string

	constructor(arl: string) {
		this.#arl = arl
	}

	async init() {
		const data = await this.call<{
			checkForm: string
			USER: { USER_ID: number | string; BLOG_NAME?: string; EMAIL?: string; OPTIONS?: { web_lossless?: boolean } }
		}>('deezer.getUserData', {}, false)
		if (!data.USER?.USER_ID || String(data.USER.USER_ID) === '0') throw new Error('ARL inválida o expirada')
		this.#apiToken = data.checkForm
		this.userId = String(data.USER.USER_ID)
		this.userName = data.USER.BLOG_NAME
		this.email = data.USER.EMAIL || undefined
		return data
	}

	async call<T>(method: string, body: object = {}, retry = true): Promise<T> {
		const url = `${GW_LIGHT}?${new URLSearchParams({
			method,
			input: '3',
			api_version: '1.0',
			api_token: method === 'deezer.getUserData' ? '' : this.#apiToken,
			cid: String(Math.floor(Math.random() * 1e9))
		})}`
		const cookie = `arl=${this.#arl}${this.#sid ? `; sid=${this.#sid}` : ''}`
		const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { ...HEADERS, Cookie: cookie } })
		const sid = res.headers.get('set-cookie')?.match(/sid=(fr[0-9a-f]+)/)?.[1]
		if (sid) this.#sid = sid
		const json = (await res.json()) as { results: T; error: Record<string, string> | unknown[] }
		if (json.error && !Array.isArray(json.error) && Object.keys(json.error).length) {
			const [type, msg] = Object.entries(json.error)[0]!
			if (retry && (type === 'VALID_TOKEN_REQUIRED' || type === 'NEED_USER_AUTH_REQUIRED')) {
				await this.init()
				return this.call(method, body, false)
			}
			throw new Error(`Deezer: ${type} ${msg}`)
		}
		return json.results
	}
}

interface DeezerPlaylistRaw {
	PLAYLIST_ID: string
	TITLE: string
	NB_SONG?: number | string
	PLAYLIST_PICTURE?: string
	PICTURE_TYPE?: string
	CHECKSUM?: string
	DATE_MOD?: string
	PARENT_USERNAME?: string
}

interface DeezerSongRaw {
	SNG_ID: string
	SNG_TITLE: string
	VERSION?: string
	ART_NAME: string
	ARTISTS?: { ART_NAME: string }[]
	ALB_TITLE?: string
	ALB_PICTURE?: string
	DURATION?: string | number
	ISRC?: string
}

const cover = (type: string, md5?: string) =>
	md5 ? `https://e-cdns-images.dzcdn.net/images/${type}/${md5}/500x500-000000-80-0-0.jpg` : undefined

export class DeezerSource implements SourceConnector {
	readonly service = 'deezer' as const
	#gw: DeezerGw
	#ready?: Promise<unknown>

	constructor(arl: string) {
		this.#gw = new DeezerGw(arl)
	}

	#init() {
		this.#ready ??= this.#gw.init().catch((err) => {
			this.#ready = undefined
			throw err
		})
		return this.#ready
	}

	async identity(): Promise<AccountIdentity> {
		await this.#init()
		return { name: this.#gw.userName ?? this.#gw.userId, email: this.#gw.email }
	}

	async listPlaylists(): Promise<SourcePlaylist[]> {
		await this.#init()
		const res = await this.#gw.call<{ TAB: { playlists: { data: DeezerPlaylistRaw[] } } }>('deezer.pageProfile', {
			USER_ID: this.#gw.userId,
			tab: 'playlists',
			nb: 10000
		})
		return res.TAB.playlists.data.map((p) => ({
			sourceId: p.PLAYLIST_ID,
			name: p.TITLE,
			owner: p.PARENT_USERNAME,
			coverUrl: cover(p.PICTURE_TYPE ?? 'playlist', p.PLAYLIST_PICTURE),
			trackCount: p.NB_SONG !== undefined ? Number(p.NB_SONG) : undefined,
			snapshot: p.CHECKSUM ?? p.DATE_MOD
		}))
	}

	async getPlaylistTracks(playlistId: string): Promise<SourceTrack[]> {
		await this.#init()
		const res = await this.#gw.call<{ data: DeezerSongRaw[] }>('playlist.getSongs', {
			// deemix sends PLAYLIST_ID, lucida sends playlist_id; the endpoint has accepted both.
			PLAYLIST_ID: playlistId,
			playlist_id: playlistId,
			nb: -1
		})
		return res.data.map(toTrack)
	}

	async search(query: string, limit: number): Promise<SourceTrack[]> {
		await this.#init()
		const res = await this.#gw.call<{ data?: DeezerSongRaw[] }>('search.music', {
			QUERY: query,
			FILTER: 'ALL',
			OUTPUT: 'TRACK',
			START: 0,
			NB: limit
		})
		return (res.data ?? []).map(toTrack)
	}

	/** Deezer's full streams are encrypted; its public API gives a 30-second clip. */
	async stream(trackId: string): Promise<StreamPreview | null> {
		if (!/^\d+$/.test(trackId)) return null
		const res = await fetchJson<{ preview?: string }>(`https://api.deezer.com/track/${trackId}`)
		return res?.preview ? { url: res.preview, full: false } : null
	}

	async createPlaylist(name: string, trackIds: string[]): Promise<string> {
		await this.#init()
		const id = await this.#gw.call<number | string>('playlist.create', {
			title: name,
			description: 'Creada con Kemix',
			// 0 = public, 1 = private
			status: 1,
			songs: trackIds.map((songId, i) => [songId, i])
		})
		return String(id)
	}
}

interface DeezerPublicTrack {
	id: number
	title: string
	isrc?: string
	duration?: number
	artist?: { name?: string }
	album?: { title?: string }
}

/**
 * The ISRC of a track, from Deezer's public catalog (no account needed). Lets tracks from sources without ISRCs
 * (Spotify's web player, YouTube Music) be matched by ISRC on services whose text search misses them.
 * Only answers when the catalog's track scores at least `minScore` against `track`.
 */
export async function findIsrcOnDeezer(
	track: Pick<SourceTrack, 'title' | 'artists' | 'durationMs'>,
	minScore: number
): Promise<{ isrc: string; score: number } | null> {
	const { artist, title, core } = queryParts(track)
	const queries = [...new Set([`${artist} ${title}`.trim(), `${artist} ${core}`.trim()])]
	let best: { track: DeezerPublicTrack; score: number } | null = null
	for (const q of queries) {
		const res = await fetchJson<{ data?: DeezerPublicTrack[] }>(
			`https://api.deezer.com/search/track?${new URLSearchParams({ q, limit: '10' })}`
		)
		for (const t of res?.data ?? []) {
			const score = scoreMatch(
				{ ...track, isrc: undefined },
				{
					service: 'deezer',
					id: String(t.id),
					url: `https://www.deezer.com/track/${t.id}`,
					title: t.title,
					artists: t.artist?.name ? [t.artist.name] : [],
					album: t.album?.title,
					durationMs: t.duration ? t.duration * 1000 : undefined
				}
			)
			if (!best || score > best.score) best = { track: t, score }
		}
		if (best && best.score >= minScore) break
	}
	if (!best || best.score < minScore) return null
	const isrc =
		best.track.isrc ?? (await fetchJson<{ isrc?: string }>(`https://api.deezer.com/track/${best.track.id}`))?.isrc
	return isrc ? { isrc, score: best.score } : null
}

function toTrack(t: DeezerSongRaw): SourceTrack {
	return {
		sourceId: t.SNG_ID,
		title: t.VERSION ? `${t.SNG_TITLE} ${t.VERSION}` : t.SNG_TITLE,
		artists: t.ARTISTS?.length ? t.ARTISTS.map((a) => a.ART_NAME) : [t.ART_NAME],
		album: t.ALB_TITLE,
		durationMs: t.DURATION ? Number(t.DURATION) * 1000 : undefined,
		isrc: t.ISRC,
		coverUrl: cover('cover', t.ALB_PICTURE),
		url: `https://www.deezer.com/track/${t.SNG_ID}`
	}
}
