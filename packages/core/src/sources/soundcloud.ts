import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AudioStream, Downloader } from '../download/lucida-adapter'
import type { AudioQuality, SourceTrack, TargetTrack } from '../types'
import { cleanArtist, searchQueries } from '../match/score'
import { LOSSY_MIN_SCORE, searchService } from '../match/resolve'
import { toNetscapeCookies } from './cookies'
import { lastLine, type YtDlp } from './yt-dlp'

/** The best SoundCloud streams to everyone: AAC 160 kbps (older tracks only have MP3 128 or Opus 64). Lossy. */
export const SOUNDCLOUD_QUALITY: AudioQuality = { codec: 'aac', lossless: false, bitrateKbps: 160 }

/**
 * The best SoundCloud gives, never the 30 s previews of Go+ tracks (yt-dlp marks their format ids with "preview"):
 * first the original file the artist uploaded (`download`: WAV/FLAC/MP3…, only when they allow downloads), then by
 * yt-dlp's `quality` (Go+ AAC 256 > AAC 160 > the rest) and bitrate. yt-dlp's default order would rank Opus 64 over
 * MP3 128. Every stream is HLS that yt-dlp joins by itself (`m3u8_native`), so none needs ffmpeg.
 */
const FORMAT = 'download/bestaudio[format_id!*=preview]'
const FORMAT_SORT = 'quality,abr'

/** One line of `yt-dlp -j` for a SoundCloud track (only what Kemix reads). */
interface YtDlpTrack {
	id?: string | number
	title?: string
	uploader?: string
	artist?: string
	artists?: string[]
	album?: string
	duration?: number
	webpage_url?: string
	url?: string
	thumbnail?: string
	thumbnails?: { id?: string; url?: string; width?: number }[]
	formats?: YtDlpFormat[]
}

interface YtDlpFormat {
	format_id?: string
	ext?: string
	acodec?: string
	abr?: number
	quality?: number
}

const LOSSLESS_EXT: Record<string, AudioQuality['codec']> = { flac: 'flac', wav: 'wav', aiff: 'aiff', aif: 'aiff' }

/** What a format gives. The original upload's bitrate isn't known before downloading it. */
function formatQuality(f: YtDlpFormat): AudioQuality {
	const ext = f.ext?.toLowerCase() ?? ''
	const lossless = LOSSLESS_EXT[ext]
	if (lossless) return { codec: lossless, lossless: true }
	const codec: AudioQuality['codec'] =
		ext === 'mp3' || f.acodec === 'mp3' ? 'mp3'
		: ext === 'm4a' || f.acodec?.startsWith('mp4a') ? 'aac'
		: ext === 'opus' || f.acodec === 'opus' ? 'opus'
		: 'other'
	return { codec, lossless: false, bitrateKbps: f.abr ? Math.round(f.abr) : undefined }
}

/** The best format of a track, picked the way FORMAT and FORMAT_SORT do. Null: only previews. */
export function bestFormat(formats: YtDlpFormat[]): YtDlpFormat | null {
	const full = formats.filter((f) => !f.format_id?.includes('preview'))
	const original = full.find((f) => f.format_id === 'download')
	if (original) return original
	return full.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1) || (b.abr ?? 0) - (a.abr ?? 0))[0] ?? null
}


/**
 * yt-dlp's `-j` output (one JSON object per line) → tracks. Drops tracks that only have the 30 s preview and lines
 * that aren't tracks.
 */
export function parseSearchOutput(stdout: string): TargetTrack[] {
	const out: TargetTrack[] = []
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith('{')) continue
		let t: YtDlpTrack
		try {
			t = JSON.parse(line) as YtDlpTrack
		} catch {
			continue
		}
		const url = t.webpage_url ?? t.url
		if (!t.id || !t.title || !url) continue
		const best = t.formats?.length ? bestFormat(t.formats) : undefined
		if (best === null) continue
		const artists = t.artists?.length ? t.artists : t.artist ? [t.artist] : t.uploader ? [cleanArtist(t.uploader)] : []
		out.push({
			service: 'soundcloud',
			id: String(t.id),
			url,
			title: t.title,
			artists,
			album: t.album,
			durationMs: t.duration ? Math.round(t.duration * 1000) : undefined,
			coverUrl: coverOf(t),
			maxQuality: best ? formatQuality(best) : SOUNDCLOUD_QUALITY
		})
	}
	return out
}

/** The 500×500 artwork when there is one (SoundCloud's default is 100×100), else the biggest. */
function coverOf(t: YtDlpTrack): string | undefined {
	const thumbs = (t.thumbnails ?? []).filter((x) => x.url)
	const t500 = thumbs.find((x) => x.id === 't500x500')
	if (t500) return t500.url
	const sized = thumbs.filter((x) => x.width).sort((a, b) => b.width! - a.width!)
	return sized[0]?.url ?? t.thumbnail
}

/** yt-dlp's error, in words the user can act on. */
function describeError(stderr: string): string {
	const line = lastLine(stderr)
	if (/requested format is not available/i.test(line)) {
		return 'SoundCloud solo da un fragmento de 30 s de este tema (es de SoundCloud Go+). Elige otra versión.'
	}
	if (/geo|not available in your country/i.test(line)) return 'SoundCloud no deja escuchar este tema desde tu país.'
	return `yt-dlp falló con SoundCloud: ${line || 'sin detalle'}`
}

/**
 * The track itself, when it comes from a SoundCloud playlist or likes: no search needed, and no search can do better.
 */
export function sourceUpload(track: SourceTrack & { source?: string }): TargetTrack | null {
	if (track.source !== 'soundcloud' || !track.url || !/^https:\/\/(\w+\.)?soundcloud\.com\//i.test(track.url)) return null
	return {
		service: 'soundcloud',
		id: track.sourceId,
		url: track.url,
		title: track.title,
		artists: track.artists,
		album: track.album,
		durationMs: track.durationMs,
		coverUrl: track.coverUrl,
		maxQuality: SOUNDCLOUD_QUALITY
	}
}

/**
 * SoundCloud through yt-dlp. Search and downloads need no account; with one connected they go through it, which
 * unlocks the original files SoundCloud keeps for registered users and, with Go+, AAC 256 and whole Go+ tracks
 * (otherwise only a 30 s preview). Lossy except for lossless originals, so only used when the user asks for it,
 * like YouTube. Lots of remixes, DJ sets and independent artists that aren't on the lossless services.
 */
export class SoundCloud {
	constructor(
		private ytDlp: YtDlp,
		/** The connected account's `oauth_token`, if any. */
		private token: () => string | null = () => null
	) {}

	/** yt-dlp reads the session from an `oauth_token` cookie, and only from a file: a private one, removed after. */
	async #session(): Promise<{ args: string[]; cleanup: () => void }> {
		const token = this.token()
		if (!token) return { args: [], cleanup: () => {} }
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kemix-sc-'))
		const file = path.join(dir, 'cookies.txt')
		const expires = Date.now() / 1000 + 365 * 24 * 3600
		await fs.promises.writeFile(file, toNetscapeCookies(`oauth_token=${token}`, 'soundcloud.com', expires), { mode: 0o600 })
		return { args: ['--cookies', file], cleanup: () => fs.rm(dir, { recursive: true, force: true }, () => {}) }
	}

	async search(query: string, limit = 10): Promise<TargetTrack[]> {
		const bin = await this.ytDlp.bin()
		const session = await this.#session()
		// Full extraction (not --flat-playlist): it says which tracks are only a 30 s preview.
		// --ignore-errors: one track that can't be read (geo-blocked, removed) shouldn't hide the rest.
		const res = await this.ytDlp
			.output(bin, [
				...session.args,
				'-j',
				'--skip-download',
				'--ignore-errors',
				'--no-warnings',
				'--no-progress',
				`scsearch${Math.max(1, Math.min(limit, 20))}:${query}`
			])
			.finally(session.cleanup)
		const tracks = parseSearchOutput(res.stdout)
		if (!tracks.length && res.code !== 0) throw new Error(describeError(res.stderr))
		return tracks.slice(0, limit)
	}

	/** SoundCloud results for a track, best match first. */
	candidates(track: SourceTrack & { source?: string }, query?: string) {
		const queries = query?.trim() ? [query.trim()] : searchQueries(track)
		return searchService(track, this.downloader(), queries, LOSSY_MIN_SCORE)
	}

	async open(url: string): Promise<AudioStream> {
		const bin = await this.ytDlp.bin()
		const session = await this.#session()
		return this.ytDlp.stream(
			bin,
			[...session.args, '-f', FORMAT, '-S', FORMAT_SORT, '--no-playlist', '--no-progress', '--quiet', '-o', '-', url],
			{ describe: describeError, onExit: session.cleanup }
		)
	}

	downloader(): Downloader {
		return {
			service: 'soundcloud',
			isrcLookup: async () => null,
			search: (query, limit) => this.search(query, limit),
			exact: sourceUpload,
			accountInfo: async () => ({}),
			accountQuality: async () => SOUNDCLOUD_QUALITY,
			getTrack: async (url) => {
				if (!/(^|\.)soundcloud\.com$/i.test(new URL(url).hostname)) throw new Error(`URL de SoundCloud no válida: ${url}`)
				return {
					// Title and artists come from the library track (see the queue): SoundCloud's are uploader-made.
					meta: { service: 'soundcloud', id: url, url, title: url, artists: [], maxQuality: SOUNDCLOUD_QUALITY },
					open: () => this.open(url)
				}
			}
		}
	}
}
