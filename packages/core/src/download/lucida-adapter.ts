// The ONLY module that imports lucida. Keep it that way so the library can be patched or swapped out.
import { Readable } from 'node:stream'
import Qobuz from 'lucida/streamers/qobuz/main.js'
import Deezer from 'lucida/streamers/deezer/main.js'
import { parseTrack as parseQobuzTrack, type RawTrack as LucidaRawQobuzTrack } from 'lucida/streamers/qobuz/parse.js'
import type { Track as LucidaTrack, CoverArtwork, GetStreamResponse } from 'lucida/types'
import type { AudioQuality, DownloadService, QualityLevel, SourceTrack, TargetService, TargetTrack } from '../types'
import { QobuzApi } from '../sources/qobuz'
import { DeezerSource } from '../sources/deezer'

export interface AudioStream {
	stream: Readable
	mimeType: string
	sizeBytes?: number
}

/** A service we can download audio from. */
export interface Downloader {
	readonly service: DownloadService
	isrcLookup(isrc: string): Promise<TargetTrack | null>
	search(query: string, limit: number): Promise<TargetTrack[]>
	/**
	 * This very recording, when the track's source already points at it on this service (a YouTube Music track is a
	 * YouTube video): no search needed, and no search can do better.
	 */
	exact?(track: SourceTrack & { source?: string }): TargetTrack | null
	/** `open` gives the best audio the track has up to `level`. */
	getTrack(url: string): Promise<{ meta: TargetTrack; open(level: QualityLevel): Promise<AudioStream> }>
	accountInfo(): Promise<{ premium?: boolean; country?: string }>
	/** Best quality this account can download (the subscription's ceiling, not a specific track's). */
	accountQuality(): Promise<AudioQuality>
}

const HIRES_MAX: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 24, sampleRateHz: 192000 }
const CD_QUALITY: AudioQuality = { codec: 'flac', lossless: true, bitDepth: 16, sampleRateHz: 44100 }

abstract class LucidaDownloader implements Downloader {
	abstract accountQuality(): Promise<AudioQuality>

	constructor(
		readonly service: TargetService,
		protected streamer: Qobuz | Deezer
	) {}

	/** Best quality this service can deliver for a track; overridden per service. */
	protected quality(_track: TargetTrack): AudioQuality | undefined {
		return undefined
	}

	protected withQuality(t: TargetTrack): TargetTrack {
		return { ...t, maxQuality: t.maxQuality ?? this.quality(t) }
	}

	/** Start a track's audio at (up to) `level`; overridden by services that can choose. */
	protected openStream(getStream: () => Promise<GetStreamResponse>, _level: QualityLevel): Promise<GetStreamResponse> {
		return getStream()
	}

	async isrcLookup(isrc: string): Promise<TargetTrack | null> {
		try {
			const track = await this.streamer.isrcLookup(isrc)
			// Qobuz's isrcLookup is "first search result for the ISRC" — make sure it really matches.
			if (track.isrc && track.isrc.toUpperCase() !== isrc.toUpperCase()) return null
			return this.withQuality(toTarget(this.service, track))
		} catch {
			return null
		}
	}

	async search(query: string, limit: number): Promise<TargetTrack[]> {
		const res = await this.streamer.search(query, limit)
		return res.tracks.map((t) => this.withQuality(toTarget(this.service, t)))
	}

	async getTrack(url: string) {
		const res = await this.streamer.getByUrl(url)
		if (res.type !== 'track') throw new Error(`La URL no es un track: ${url}`)
		return {
			meta: this.withQuality(toTarget(this.service, res.metadata)),
			open: async (level: QualityLevel): Promise<AudioStream> => {
				const s = await this.openStream(() => res.getStream(), level)
				const stream = s.stream instanceof Readable ? s.stream : Readable.from(s.stream as AsyncIterable<Buffer>)
				return { stream, mimeType: s.mimeType, sizeBytes: Number.isFinite(s.sizeBytes) ? s.sizeBytes : undefined }
			}
		}
	}

	async accountInfo() {
		const info = await this.streamer.getAccountInfo()
		return { premium: info.premium, country: info.country }
	}
}

/** Raw Qobuz track fields lucida drops: the best format the track exists in. */
type RawQobuzTrack = LucidaRawQobuzTrack & {
	maximum_bit_depth?: number
	/** kHz, e.g. 44.1 or 96 */
	maximum_sampling_rate?: number
}

function qobuzQuality(raw: RawQobuzTrack): AudioQuality {
	return {
		codec: 'flac',
		lossless: true,
		bitDepth: raw.maximum_bit_depth || 16,
		sampleRateHz: raw.maximum_sampling_rate ? Math.round(raw.maximum_sampling_rate * 1000) : 44100
	}
}

/**
 * Qobuz format ids: 27 = FLAC up to 24-bit/192 kHz, 7 = FLAC up to 24-bit/96 kHz, 6 = FLAC 16-bit/44.1 kHz,
 * 5 = MP3 320 (the lowest it has). Qobuz sends the best format the track has up to the one asked for.
 */
const QOBUZ_FORMAT: Record<QualityLevel, number> = { max: 27, hires96: 7, cd: 6, mp3_320: 5, mp3_128: 5, mp3_compat: 5 }

/**
 * Qobuz: searches, metadata and audio go straight to the API, so we keep each track's maximum bit depth / sample
 * rate (lucida's parser drops them) and can pick the format (lucida always asks for id 27).
 */
class QobuzDownloader extends LucidaDownloader {
	#api: QobuzApi
	#appSecret: string

	constructor(opts: { appId: string; appSecret: string; token: string }) {
		super('qobuz', new Qobuz(opts))
		this.#api = new QobuzApi({ appId: opts.appId, token: opts.token })
		this.#appSecret = opts.appSecret
	}

	#toTarget(raw: RawQobuzTrack): TargetTrack {
		return { ...toTarget('qobuz', parseQobuzTrack(raw)), maxQuality: qobuzQuality(raw) }
	}

	async #rawSearch(query: string, limit: number): Promise<RawQobuzTrack[]> {
		const res = await this.#api.get<{ tracks?: { items: RawQobuzTrack[] } }>('catalog/search', { query, limit })
		return res.tracks?.items ?? []
	}

	override async search(query: string, limit: number): Promise<TargetTrack[]> {
		return (await this.#rawSearch(query, limit)).map((r) => this.#toTarget(r))
	}

	override async isrcLookup(isrc: string): Promise<TargetTrack | null> {
		try {
			const hit = (await this.#rawSearch(isrc, 5)).find((r) => r.isrc?.toUpperCase() === isrc.toUpperCase())
			return hit ? this.#toTarget(hit) : null
		} catch {
			return null
		}
	}

	#accountQuality?: Promise<AudioQuality>

	/**
	 * The subscription's streaming rights: hi-res plans go up to 24-bit/192 kHz, CD plans to 16-bit/44.1 kHz.
	 * If Qobuz doesn't say, assume hi-res: every current Qobuz plan (Studio, Sublime) includes it.
	 */
	accountQuality(): Promise<AudioQuality> {
		this.#accountQuality ??= this.#api
			.get<{ credential?: { parameters?: { hires_streaming?: boolean; lossless_streaming?: boolean } | null } }>('user/get', {})
			.then((u) => {
				const p = u.credential?.parameters
				if (!p || p.hires_streaming) return HIRES_MAX
				if (p.lossless_streaming) return CD_QUALITY
				return { codec: 'mp3', lossless: false, bitrateKbps: 320 } satisfies AudioQuality
			})
			.catch(() => HIRES_MAX)
		return this.#accountQuality
	}

	override async getTrack(url: string) {
		const id = url.match(/track\/(\d+)/)?.[1]
		if (!id) throw new Error(`La URL no es un track de Qobuz: ${url}`)
		const raw = await this.#api.get<RawQobuzTrack>('track/get', { track_id: id })
		return { meta: this.#toTarget(raw), open: (level: QualityLevel) => this.#open(id, level) }
	}

	async #open(trackId: string, level: QualityLevel): Promise<AudioStream> {
		const formatId = QOBUZ_FORMAT[level]
		const file = await this.#api.fileUrl(trackId, formatId, this.#appSecret)
		if (!file.url || file.sample) {
			throw new Error('Qobuz solo entrega un fragmento de este tema: puede ser solo de compra o la suscripción no está activa')
		}
		const res = await fetch(file.url)
		if (!res.ok || !res.body) throw new Error(`Qobuz no entregó el audio (HTTP ${res.status})`)
		const size = Number(res.headers.get('content-length'))
		return {
			stream: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
			mimeType: file.mime_type ?? (formatId === 5 ? 'audio/mpeg' : 'audio/flac'),
			sizeBytes: size > 0 ? size : undefined
		}
	}
}

/** Deezer formats (lucida's DeezerFormat enum). */
const DEEZER_FLAC = 9
const DEEZER_MP3_320 = 3
const DEEZER_MP3_128 = 1

/** Formats allowed at each level. Deezer's only lossless format is FLAC 16-bit/44.1 kHz. */
const DEEZER_FORMATS: Record<QualityLevel, number[]> = {
	max: [DEEZER_FLAC, DEEZER_MP3_320, DEEZER_MP3_128],
	hires96: [DEEZER_FLAC, DEEZER_MP3_320, DEEZER_MP3_128],
	cd: [DEEZER_FLAC, DEEZER_MP3_320, DEEZER_MP3_128],
	mp3_320: [DEEZER_MP3_320, DEEZER_MP3_128],
	mp3_128: [DEEZER_MP3_128],
	mp3_compat: [DEEZER_MP3_320, DEEZER_MP3_128]
}

/** Deezer: the quality depends on the account (HiFi → FLAC 16/44.1, Premium → MP3 320, free → MP3 128). */
class DeezerDownloader extends LucidaDownloader {
	constructor(
		private deezer: Deezer,
		private catalog: DeezerSource
	) {
		super('deezer', deezer)
	}

	/**
	 * Tracks only, through the same web API the rest of the app uses. lucida's search also looks up artists and
	 * albums on every call (three requests), and fails as a whole if any of them does.
	 */
	override async search(query: string, limit: number): Promise<TargetTrack[]> {
		const tracks = await this.catalog.search(query, limit)
		return tracks.map((t) =>
			this.withQuality({
				service: 'deezer',
				id: t.sourceId,
				url: t.url ?? `https://www.deezer.com/track/${t.sourceId}`,
				title: t.title,
				artists: t.artists,
				album: t.album,
				durationMs: t.durationMs,
				isrc: t.isrc,
				coverUrl: t.coverUrl
			})
		)
	}

	protected override quality(): AudioQuality {
		const formats = this.deezer.availableFormats as Set<number>
		if (formats.has(DEEZER_FLAC)) return CD_QUALITY
		if (formats.has(DEEZER_MP3_320)) return { codec: 'mp3', lossless: false, bitrateKbps: 320 }
		return { codec: 'mp3', lossless: false, bitrateKbps: 128 }
	}

	async accountQuality() {
		return this.quality()
	}

	/**
	 * lucida streams the best format in `availableFormats` (falling back to MP3 128) and reads the set synchronously,
	 * before its first await. Narrowing the set only around the call applies the level to this download alone, not
	 * to others running at the same time.
	 */
	protected override openStream(getStream: () => Promise<GetStreamResponse>, level: QualityLevel) {
		const formats = this.deezer.availableFormats
		const allowed = DEEZER_FORMATS[level]
		this.deezer.availableFormats = new Set([...formats].filter((f) => allowed.includes(f)))
		try {
			return getStream()
		} finally {
			this.deezer.availableFormats = formats
		}
	}
}

export async function createQobuzDownloader(opts: { appId: string; appSecret: string; token: string }) {
	return new QobuzDownloader(opts)
}

export async function createDeezerDownloader(arl: string) {
	const deezer = new Deezer({ arl })
	// With an arl set, login() ignores the arguments and authenticates through the cookie.
	await deezer.login('', '')
	return new DeezerDownloader(deezer, new DeezerSource(arl))
}

function bestCover(...lists: (CoverArtwork[] | undefined)[]): string | undefined {
	const all = lists.flatMap((l) => l ?? [])
	if (!all.length) return undefined
	return all.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!.url
}

function toTarget(service: TargetService, t: LucidaTrack): TargetTrack {
	const releaseDate = t.releaseDate ?? t.album?.releaseDate
	const year = releaseDate ? new Date(releaseDate).getFullYear() : undefined
	return {
		service,
		id: String(t.id),
		url: t.url,
		title: t.title,
		artists: t.artists?.map((a) => a.name) ?? [],
		album: t.album?.title,
		albumArtists: t.album?.artists?.map((a) => a.name),
		durationMs: t.durationMs,
		isrc: t.isrc,
		coverUrl: bestCover(t.coverArtwork, t.album?.coverArtwork),
		trackNumber: t.trackNumber,
		discNumber: t.discNumber,
		year: Number.isFinite(year) ? year : undefined,
		genres: t.genres ?? t.album?.genre,
		copyright: t.copyright ?? t.album?.copyright
	}
}
