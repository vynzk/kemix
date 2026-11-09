import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Innertube, YTNodes } from 'youtubei.js'
import type { AudioStream, Downloader } from '../download/lucida-adapter'
import type { AudioQuality, SourceTrack, TargetTrack, YouTubePreview } from '../types'
import { cleanArtist, searchQueries } from '../match/score'
import { LOSSY_MIN_SCORE, searchService } from '../match/resolve'
import { errorMessage } from '../util'
import { toNetscapeCookies } from './cookies'
import { lastLine, sniffAudio, type YtDlp } from './yt-dlp'

/**
 * What YouTube typically serves for audio (AAC ~128 kbps or Opus ~130 kbps): always lossy. With the cookies of a
 * YouTube Music Premium account downloads get AAC 256 kbps instead; the real bitrate is read from the file.
 */
export const YOUTUBE_QUALITY: AudioQuality = { codec: 'aac', lossless: false, bitrateKbps: 128 }
/** What YouTube gives a YouTube Music Premium account (itag 141). */
export const YOUTUBE_PREMIUM_QUALITY: AudioQuality = { codec: 'aac', lossless: false, bitrateKbps: 256 }

/**
 * yt-dlp format selector: AAC 256 kbps (itag 141, only offered to YouTube Music Premium accounts), else the best m4a
 * (AAC: plays everywhere and takes tags, no ffmpeg needed since nothing is re-encoded), else whatever is best.
 */
const YT_DLP_FORMAT = '141/bestaudio[ext=m4a]/bestaudio'

/** A YouTube Music connection: its `Cookie` header and which signed-in Google account to act as (authuser). */
export interface YtMusicLogin {
	cookie: string
	accountIndex: number
}

export function youtubeUrl(videoId: string) {
	return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * The video a track imported from YouTube Music already is (its source ID): the exact recording, the same one the
 * player plays for it. Null for tracks from anywhere else.
 */
export function sourceVideo(track: SourceTrack & { source?: string }): TargetTrack | null {
	if (track.source !== 'ytmusic' || !/^[\w-]{11}$/.test(track.sourceId)) return null
	return {
		service: 'youtube',
		id: track.sourceId,
		url: youtubeUrl(track.sourceId),
		title: track.title,
		artists: track.artists,
		album: track.album,
		durationMs: track.durationMs,
		coverUrl: track.coverUrl,
		maxQuality: YOUTUBE_QUALITY
	}
}

function videoIdFromUrl(url: string): string {
	const u = new URL(url)
	const id = u.searchParams.get('v') ?? (u.hostname === 'youtu.be' ? u.pathname.slice(1) : null)
	if (!id || !/^[\w-]{11}$/.test(id)) throw new Error(`URL de YouTube no válida: ${url}`)
	return id
}

/**
 * Plain YouTube (not YouTube Music): searching and the iframe player need no account.
 * Downloads go through yt-dlp, which keeps up with YouTube's anti-download changes: the one set in Settings, else
 * Kemix's own copy (downloaded on first use), else one on the PATH. youtubei.js is a best-effort fallback (YouTube
 * blocks it for most licensed music).
 */
export class YouTube {
	#yt?: Promise<Innertube>
	#previews = new Map<string, YouTubePreview | null>()

	constructor(
		private ytDlp: YtDlp,
		/** The connected YouTube Music account (cookies and chosen account), if any: unlocks Premium audio (AAC 256). */
		private ytMusicAccount: () => YtMusicLogin | null = () => null,
		/** Whether that account has YouTube Music Premium (false without one). */
		private ytMusicPremium: () => Promise<boolean> = async () => false
	) {}

	#client() {
		this.#yt ??= Innertube.create({ retrieve_player: false, generate_session_locally: true }).catch((err) => {
			this.#yt = undefined
			throw err
		})
		return this.#yt
	}

	async search(query: string, limit = 10): Promise<TargetTrack[]> {
		const yt = await this.#client()
		const res = await yt.search(query, { type: 'video' })
		return res.results
			.filterType(YTNodes.Video)
			.slice(0, limit)
			.map((v) => {
				const thumbs = [...(v.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
				return {
					service: 'youtube' as const,
					id: v.video_id,
					url: youtubeUrl(v.video_id),
					title: v.title.toString(),
					artists: v.author?.name ? [cleanArtist(v.author.name)] : [],
					durationMs: v.duration?.seconds ? v.duration.seconds * 1000 : undefined,
					coverUrl: thumbs[0]?.url,
					maxQuality: YOUTUBE_QUALITY
				}
			})
	}

	/**
	 * YouTube results for a track, best match first: the given query, or broader searches until one convinces.
	 * A YouTube Music track's own video always comes first.
	 */
	candidates(track: SourceTrack & { source?: string }, query?: string) {
		const queries = query?.trim() ? [query.trim()] : searchQueries(track)
		return searchService(track, this.downloader(), queries, LOSSY_MIN_SCORE)
	}

	/** A video to listen to the track. Tracks imported from YouTube Music already are one. */
	preview(track: SourceTrack & { id: number; source: string }): Promise<YouTubePreview | null> {
		return this.#preview(`track:${track.id}`, track.source, track)
	}

	/** Same, for a track that isn't in the library (e.g. a search result) of the given service. */
	previewFor(service: string, track: SourceTrack): Promise<YouTubePreview | null> {
		return this.#preview(`${service}:${track.sourceId}`, service, track)
	}

	async #preview(key: string, source: string, track: SourceTrack): Promise<YouTubePreview | null> {
		if (this.#previews.has(key)) return this.#previews.get(key)!
		let preview: YouTubePreview | null
		if (source === 'ytmusic') {
			preview = { videoId: track.sourceId, title: track.title, channel: track.artists.join(', ') }
		} else {
			const best = (await this.candidates(track))[0]
			preview = best && best.score >= 0.4 ? { videoId: best.id, title: best.title, channel: best.artists[0] } : null
		}
		this.#previews.set(key, preview)
		return preview
	}

	async open(videoId: string): Promise<AudioStream> {
		let bin: string
		try {
			bin = await this.ytDlp.bin()
		} catch (err) {
			// A yt-dlp set in Settings that doesn't run is an error to fix, not something to work around.
			if (this.ytDlp.configured) throw err
			try {
				return await this.#openWithYoutubei(videoId)
			} catch (direct) {
				throw new Error(`YouTube bloqueó la descarga directa (${errorMessage(direct)}). ${errorMessage(err)}`)
			}
		}
		return this.#openWithYtDlp(bin, videoId)
	}

	async #openWithYtDlp(bin: string, videoId: string): Promise<AudioStream> {
		const login = this.ytMusicAccount()
		if (login) {
			try {
				return await this.#runYtDlp(bin, videoId, login)
			} catch {
				// Expired cookies or an account YouTube is wary of: downloading anonymously still works (at 128 kbps).
			}
		}
		return this.#runYtDlp(bin, videoId, null)
	}

	async #runYtDlp(bin: string, videoId: string, login: YtMusicLogin | null): Promise<AudioStream> {
		const cookie = login?.cookie
		// yt-dlp only takes cookies from a file. Keep it private and remove it once yt-dlp is done.
		let cookieDir: string | null = null
		const args: string[] = []
		if (cookie) {
			cookieDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kemix-yt-'))
			const cookieFile = path.join(cookieDir, 'cookies.txt')
			const expires = Date.now() / 1000 + 365 * 24 * 3600
			await fs.promises.writeFile(cookieFile, toNetscapeCookies(cookie, 'youtube.com', expires), { mode: 0o600 })
			args.push('--cookies', cookieFile)
			// The cookies may hold several Google accounts and yt-dlp has no option to pick one: it acts as the first
			// (authuser 0). Ask for the one chosen in Kemix the way Google's own pages do, with X-Goog-AuthUser.
			if (login.accountIndex > 0) args.push('--add-headers', `X-Goog-AuthUser:${login.accountIndex}`)
		}
		const removeCookies = () => cookieDir && fs.rm(cookieDir, { recursive: true, force: true }, () => {})
		// YouTube answers 403 unless yt-dlp can solve its JS challenges, which needs a JS runtime the user most likely
		// doesn't have. Lend it our own executable: Electron behaves as plain Node with ELECTRON_RUN_AS_NODE (and under
		// the standalone server execPath already is Node). Adds to Deno if installed, doesn't replace it.
		// With cookies, ask through music.youtube.com: that's where yt-dlp offers the Premium formats.
		return this.ytDlp.stream(
			bin,
			[
				...args,
				'--js-runtimes',
				`node:${process.execPath}`,
				'-f',
				YT_DLP_FORMAT,
				'--no-playlist',
				'--no-progress',
				'--quiet',
				'-o',
				'-',
				cookie ? `https://music.youtube.com/watch?v=${videoId}` : youtubeUrl(videoId)
			],
			{ onExit: removeCookies, describe: (stderr) => `yt-dlp falló: ${lastLine(stderr) || 'sin detalle'}` }
		)
	}

	async #openWithYoutubei(videoId: string): Promise<AudioStream> {
		const yt = await this.#client()
		let lastError: unknown
		for (const client of ['IOS', 'MWEB', 'YTMUSIC'] as const) {
			try {
				const web = await yt.download(videoId, { type: 'audio', quality: 'best', format: 'any', client })
				return await sniffAudio(Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]))
			} catch (err) {
				lastError = err
			}
		}
		throw lastError
	}

	downloader(): Downloader {
		return {
			service: 'youtube',
			isrcLookup: async () => null,
			search: (query, limit) => this.search(query, limit),
			exact: sourceVideo,
			accountInfo: async () => ({}),
			// Unknown Premium status counts as none: better to promise 128 and deliver 256 than the other way round.
			accountQuality: async () =>
				(await this.ytMusicPremium().catch(() => false)) ? YOUTUBE_PREMIUM_QUALITY : YOUTUBE_QUALITY,
			getTrack: async (url) => {
				const videoId = videoIdFromUrl(url)
				return {
					meta: { service: 'youtube', id: videoId, url, title: videoId, artists: [], maxQuality: YOUTUBE_QUALITY },
					open: () => this.open(videoId)
				}
			}
		}
	}
}
