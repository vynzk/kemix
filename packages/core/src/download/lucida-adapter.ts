// The ONLY module that imports lucida. Keep it that way so the library can be patched or swapped out.
import { Readable } from 'node:stream'
import Qobuz from 'lucida/streamers/qobuz/main.js'
import Deezer from 'lucida/streamers/deezer/main.js'
import { parseTrack as parseQobuzTrack, type RawTrack as LucidaRawQobuzTrack } from 'lucida/streamers/qobuz/parse.js'
import type { Track as LucidaTrack, CoverArtwork } from 'lucida/types'
import type { AudioQuality, DownloadService, TargetService, TargetTrack } from '../types'
import { QobuzApi } from '../sources/qobuz'

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
	getTrack(url: string): Promise<{ meta: TargetTrack; open(): Promise<AudioStream> }>
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
			open: async (): Promise<AudioStream> => {
				const s = await res.getStream()
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
 * Qobuz: searches and metadata go straight to the API so we keep each track's maximum bit depth / sample rate
 * (lucida's parser drops them). Audio still comes from lucida, which always asks for the best format (id 27).
 */
class QobuzDownloader extends LucidaDownloader {
	#api: QobuzApi

	constructor(opts: { appId: string; appSecret: string; token: string }) {
		super('qobuz', new Qobuz(opts))
		this.#api = new QobuzApi({ appId: opts.appId, token: opts.token })
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
		const base = await super.getTrack(url)
		const id = url.match(/track\/(\d+)/)?.[1]
		if (!id) return base
		try {
			const raw = await this.#api.get<RawQobuzTrack>('track/get', { track_id: id })
			return { ...base, meta: { ...base.meta, maxQuality: qobuzQuality(raw) } }
		} catch {
			return base
		}
	}
}

/** Deezer formats (lucida's DeezerFormat enum). */
const DEEZER_FLAC = 9
const DEEZER_MP3_320 = 3

/** Deezer: the quality depends on the account (HiFi → FLAC 16/44.1, Premium → MP3 320, free → MP3 128). */
class DeezerDownloader extends LucidaDownloader {
	constructor(private deezer: Deezer) {
		super('deezer', deezer)
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
}

export async function createQobuzDownloader(opts: { appId: string; appSecret: string; token: string }) {
	return new QobuzDownloader(opts)
}

export async function createDeezerDownloader(arl: string) {
	const deezer = new Deezer({ arl })
	// With an arl set, login() ignores the arguments and authenticates through the cookie.
	await deezer.login('', '')
	return new DeezerDownloader(deezer)
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
