// The ONLY module that imports lucida. Keep it that way so the library can be patched or swapped out.
import { Readable } from 'node:stream'
import Qobuz from 'lucida/streamers/qobuz/main.js'
import Deezer from 'lucida/streamers/deezer/main.js'
import type { Track as LucidaTrack, CoverArtwork } from 'lucida/types'
import type { TargetService, TargetTrack } from '../types'

export interface AudioStream {
	stream: Readable
	mimeType: string
	sizeBytes?: number
}

/** A service we can download audio from. */
export interface Downloader {
	readonly service: TargetService
	isrcLookup(isrc: string): Promise<TargetTrack | null>
	search(query: string, limit: number): Promise<TargetTrack[]>
	getTrack(url: string): Promise<{ meta: TargetTrack; open(): Promise<AudioStream> }>
	accountInfo(): Promise<{ premium?: boolean; country?: string }>
}

class LucidaDownloader implements Downloader {
	constructor(
		readonly service: TargetService,
		private streamer: Qobuz | Deezer
	) {}

	async isrcLookup(isrc: string): Promise<TargetTrack | null> {
		try {
			const track = await this.streamer.isrcLookup(isrc)
			// Qobuz's isrcLookup is "first search result for the ISRC" — make sure it really matches.
			if (track.isrc && track.isrc.toUpperCase() !== isrc.toUpperCase()) return null
			return toTarget(this.service, track)
		} catch {
			return null
		}
	}

	async search(query: string, limit: number): Promise<TargetTrack[]> {
		const res = await this.streamer.search(query, limit)
		return res.tracks.map((t) => toTarget(this.service, t))
	}

	async getTrack(url: string) {
		const res = await this.streamer.getByUrl(url)
		if (res.type !== 'track') throw new Error(`La URL no es un track: ${url}`)
		return {
			meta: toTarget(this.service, res.metadata),
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

export async function createQobuzDownloader(opts: { appId: string; appSecret: string; token: string }) {
	return new LucidaDownloader('qobuz', new Qobuz(opts))
}

export async function createDeezerDownloader(arl: string) {
	const deezer = new Deezer({ arl })
	// With an arl set, login() ignores the arguments and authenticates through the cookie.
	await deezer.login('', '')
	return new LucidaDownloader('deezer', deezer)
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
