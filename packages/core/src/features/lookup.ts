import type { MusicalKey, SourceTrack } from '../types'
import { queryParts, scoreMatch } from '../match/score'
import { fetchJson, HttpError, sleep } from '../util'
import { parseKey } from './key'

/** MusicBrainz asks every client to name itself (and how to reach whoever runs it). */
const USER_AGENT = 'Kemix/0.1.0 ( https://github.com/vynzk/kemix )'

/** BPM and/or key as a catalog has them. */
export interface CatalogFeatures {
	bpm?: number
	key?: MusicalKey
}

/** Runs calls one at a time, at least `intervalMs` apart: each service's request limit. */
export class Throttle {
	#queue: Promise<unknown> = Promise.resolve()
	#last = 0

	constructor(private intervalMs: number) {}

	run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(async () => {
			const wait = this.#last + this.intervalMs - Date.now()
			if (wait > 0) await sleep(wait)
			this.#last = Date.now()
			return fn()
		})
		// A failed call doesn't stop the ones queued after it.
		this.#queue = result.catch(() => {})
		return result
	}
}

/** GetSongBPM turned the API key down: no point asking again until the user fixes it. */
export class ApiKeyError extends Error {}

export interface DeezerTrackInfo {
	id: string
	isrc: string | null
	bpm: number | null
	/** 30-second MP3 clip. Signed and short-lived: ask again right before downloading it. */
	previewUrl: string | null
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Minimum time between requests to each service. Tests pass zeros. */
export interface SourceIntervals {
	/** api.deezer.com allows 50 requests per 5 s; an ISRC lookup can take three. */
	deezer: number
	/** musicbrainz.org: one request per second. */
	musicbrainz: number
	acousticbrainz: number
	/** getsongbpm.com: a few thousand requests per hour. */
	getsongbpm: number
}

const DEFAULT_INTERVALS: SourceIntervals = { deezer: 300, musicbrainz: 1100, acousticbrainz: 1000, getsongbpm: 1200 }

/** ISRCs per MusicBrainz search, and recording ids per AcousticBrainz request (its maximum). */
const MB_BATCH = 20
const AB_BATCH = 25

/** The catalogs Kemix reads BPM and key from, each behind its own request limit. */
export class FeatureSources {
	readonly deezer: Throttle
	readonly musicbrainz: Throttle
	readonly acousticbrainz: Throttle
	readonly getsongbpm: Throttle

	constructor(intervals: Partial<SourceIntervals> = {}) {
		const i = { ...DEFAULT_INTERVALS, ...intervals }
		this.deezer = new Throttle(i.deezer)
		this.musicbrainz = new Throttle(i.musicbrainz)
		this.acousticbrainz = new Throttle(i.acousticbrainz)
		this.getsongbpm = new Throttle(i.getsongbpm)
	}

	/**
	 * A track on Deezer's public API (no account): by its Deezer id or by ISRC. Gives the BPM (Deezer's own analysis;
	 * sometimes double or half the real one, and 0 when it has none) and the 30-second preview. Null if not there.
	 */
	async deezerTrack(ref: { id?: string; isrc?: string }): Promise<DeezerTrackInfo | null> {
		const path = ref.id && /^\d+$/.test(ref.id) ? ref.id : ref.isrc ? `isrc:${encodeURIComponent(ref.isrc)}` : null
		if (!path) return null
		const res = await this.deezer.run(() =>
			fetchJson<{ id?: number; isrc?: string; bpm?: number; preview?: string; error?: unknown }>(
				`https://api.deezer.com/track/${path}`
			)
		)
		if (!res?.id || res.error) return null
		return {
			id: String(res.id),
			isrc: res.isrc || null,
			bpm: typeof res.bpm === 'number' && res.bpm > 0 ? round1(res.bpm) : null,
			previewUrl: res.preview || null
		}
	}

	/**
	 * BPM and key from AcousticBrainz (Essentia's analysis of recordings people submitted until 2022), for many
	 * ISRCs at once: MusicBrainz maps each ISRC to its recordings, then AcousticBrainz is asked for those.
	 * Returns what it found, by upper-case ISRC.
	 */
	async acousticBrainz(isrcs: string[], signal?: AbortSignal): Promise<Map<string, CatalogFeatures>> {
		const wanted = [...new Set(isrcs.map((i) => i.toUpperCase()).filter((i) => /^[A-Z0-9]{12}$/.test(i)))]
		const recordings = new Map<string, string[]>()
		for (let i = 0; i < wanted.length; i += MB_BATCH) {
			signal?.throwIfAborted()
			const batch = wanted.slice(i, i + MB_BATCH)
			for (const [isrc, ids] of await this.#recordingsFor(batch)) recordings.set(isrc, ids)
		}

		const mbids = [...new Set([...recordings.values()].flat())]
		const data = new Map<string, CatalogFeatures>()
		for (let i = 0; i < mbids.length; i += AB_BATCH) {
			signal?.throwIfAborted()
			const batch = mbids.slice(i, i + AB_BATCH)
			const url = new URL('https://acousticbrainz.org/api/v1/low-level')
			url.search = new URLSearchParams({
				recording_ids: batch.join(';'),
				features: 'rhythm.bpm;tonal.key_key;tonal.key_scale'
			}).toString()
			type Doc = { rhythm?: { bpm?: number }; tonal?: { key_key?: string; key_scale?: string } }
			const res = await this.acousticbrainz.run(() =>
				fetchJson<Record<string, Record<string, Doc> | undefined>>(url, { headers: { 'User-Agent': USER_AGENT } })
			)
			for (const mbid of batch) {
				const doc = res?.[mbid]?.['0']
				if (!doc) continue
				const bpm = doc.rhythm?.bpm
				const key = doc.tonal?.key_key ? parseKey(`${doc.tonal.key_key} ${doc.tonal.key_scale ?? 'major'}`) : null
				data.set(mbid, { ...(bpm && bpm > 0 ? { bpm: round1(bpm) } : {}), ...(key ? { key } : {}) })
			}
		}

		const out = new Map<string, CatalogFeatures>()
		for (const [isrc, ids] of recordings) {
			// Any of the ISRC's recordings will do: they are the same audio.
			const found = ids.map((id) => data.get(id)).find((f) => f && (f.bpm || f.key))
			if (found) out.set(isrc, found)
		}
		return out
	}

	/** MusicBrainz recording ids for each ISRC of a batch (one search, paged). */
	async #recordingsFor(isrcs: string[]): Promise<Map<string, string[]>> {
		const out = new Map<string, string[]>()
		const wanted = new Set(isrcs)
		const limit = 100
		for (let offset = 0; offset < 300; offset += limit) {
			const url = new URL('https://musicbrainz.org/ws/2/recording')
			url.search = new URLSearchParams({
				query: isrcs.map((i) => `isrc:${i}`).join(' OR '),
				fmt: 'json',
				limit: String(limit),
				offset: String(offset)
			}).toString()
			const res = await this.musicbrainz.run(() =>
				fetchJson<{ count?: number; recordings?: { id: string; isrcs?: string[] }[] }>(url, {
					headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
				})
			)
			for (const r of res?.recordings ?? []) {
				for (const isrc of r.isrcs ?? []) {
					const key = isrc.toUpperCase()
					if (!wanted.has(key)) continue
					out.set(key, [...(out.get(key) ?? []), r.id])
				}
			}
			if (offset + limit >= (res?.count ?? 0)) break
		}
		return out
	}

	/**
	 * BPM and key from GetSongBPM (needs the user's free API key), searching by title and artist. Only answers when
	 * its song scores at least `minScore` against `track`. Throws on a rejected key, so the user hears about it.
	 */
	async getSongBpm(
		apiKey: string,
		track: Pick<SourceTrack, 'title' | 'artists'>,
		minScore: number
	): Promise<CatalogFeatures | null> {
		const { artist, title, core } = queryParts(track)
		const url = new URL('https://api.getsong.co/search/')
		url.search = new URLSearchParams({
			api_key: apiKey,
			type: 'both',
			lookup: `song:${core || title} artist:${artist}`
		}).toString()
		type Song = { id?: string; title?: string; tempo?: string | number; key_of?: string; artist?: { name?: string } }
		let res: { search?: Song[] | { error?: string } } | null
		try {
			res = await this.getsongbpm.run(() => fetchJson<{ search?: Song[] | { error?: string } }>(url))
		} catch (err) {
			if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
				throw new ApiKeyError('GetSongBPM rechazó la API key: revísala en Ajustes')
			}
			throw err
		}
		const songs = Array.isArray(res?.search) ? res.search : []
		let best: { song: Song; score: number } | null = null
		for (const song of songs) {
			if (!song.title) continue
			const score = scoreMatch(
				{ title: track.title, artists: track.artists },
				{
					service: 'deezer',
					id: song.id ?? '',
					url: '',
					title: song.title,
					artists: song.artist?.name ? [song.artist.name] : []
				}
			)
			if (!best || score > best.score) best = { song, score }
		}
		if (!best || best.score < minScore) return null
		const bpm = Number(best.song.tempo)
		const key = parseKey(best.song.key_of)
		if (!(bpm > 0) && !key) return null
		return { ...(bpm > 0 ? { bpm: round1(bpm) } : {}), ...(key ? { key } : {}) }
	}

	/** Download a Deezer preview (about 500 KB) to analyze it. */
	async fetchPreview(url: string, signal?: AbortSignal): Promise<Buffer> {
		const res = await fetch(url, { signal })
		if (!res.ok) throw new Error(`${res.status} ${res.statusText} al bajar la vista previa de Deezer`)
		return Buffer.from(await res.arrayBuffer())
	}
}
