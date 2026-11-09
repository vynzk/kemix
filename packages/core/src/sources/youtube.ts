import { spawn } from 'node:child_process'
import { PassThrough, Readable } from 'node:stream'
import { Innertube, YTNodes } from 'youtubei.js'
import type { AudioStream, Downloader } from '../download/lucida-adapter'
import type { AudioQuality, SourceTrack, TargetTrack, YouTubePreview } from '../types'
import { cleanArtist, searchQueries } from '../match/score'
import { searchService, YOUTUBE_MIN_SCORE } from '../match/resolve'
import { errorMessage } from '../util'
import type { ManagedYtDlp } from './yt-dlp'

/** What YouTube typically serves for audio (AAC ~128 kbps or Opus ~130 kbps): always lossy. */
export const YOUTUBE_QUALITY: AudioQuality = { codec: 'aac', lossless: false, bitrateKbps: 128 }

const YT_DLP_HINT =
	'Kemix baja yt-dlp por su cuenta la primera vez que lo necesita (hace falta conexión a internet). ' +
	'Si no puede, instálalo aparte (https://github.com/yt-dlp/yt-dlp) e indica su ruta en Ajustes.'

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
	#ytDlp = new Map<string, Promise<boolean>>()

	constructor(
		private ytDlpPath: () => string,
		private managedYtDlp?: ManagedYtDlp
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
		return searchService(track, this.downloader(), queries, YOUTUBE_MIN_SCORE)
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

	#hasYtDlp(bin: string): Promise<boolean> {
		let p = this.#ytDlp.get(bin)
		if (!p) {
			p = new Promise<boolean>((resolve) => {
				const child = spawn(bin, ['--version'], { windowsHide: true })
				child.on('error', () => resolve(false))
				child.on('close', (code) => resolve(code === 0))
			})
			// A missing yt-dlp may get installed while the app runs: only cache successes.
			p.then((ok) => !ok && this.#ytDlp.delete(bin))
			this.#ytDlp.set(bin, p)
		}
		return p
	}

	async open(videoId: string): Promise<AudioStream> {
		const configured = this.ytDlpPath()
		if (configured) {
			if (await this.#hasYtDlp(configured)) return this.#openWithYtDlp(configured, videoId)
			throw new Error(`No se pudo ejecutar yt-dlp en "${configured}". ${YT_DLP_HINT}`)
		}
		let managedError = ''
		if (this.managedYtDlp) {
			try {
				const bin = await this.managedYtDlp.path()
				if (await this.#hasYtDlp(bin)) return this.#openWithYtDlp(bin, videoId)
				managedError = `No se pudo ejecutar ${bin}. `
			} catch (err) {
				managedError = `${errorMessage(err)}. `
			}
		}
		if (await this.#hasYtDlp('yt-dlp')) return this.#openWithYtDlp('yt-dlp', videoId)
		try {
			return await this.#openWithYoutubei(videoId)
		} catch (err) {
			throw new Error(`YouTube bloqueó la descarga directa (${errorMessage(err)}). ${managedError}${YT_DLP_HINT}`)
		}
	}

	async #openWithYtDlp(bin: string, videoId: string): Promise<AudioStream> {
		// Prefer m4a (AAC): plays everywhere and takes tags. No ffmpeg needed since nothing is re-encoded.
		// YouTube answers 403 unless yt-dlp can solve its JS challenges, which needs a JS runtime the user most likely
		// doesn't have. Lend it our own executable: Electron behaves as plain Node with ELECTRON_RUN_AS_NODE (and under
		// the standalone server execPath already is Node). Adds to Deno if installed, doesn't replace it.
		const child = spawn(
			bin,
			[
				'--js-runtimes',
				`node:${process.execPath}`,
				'-f',
				'bestaudio[ext=m4a]/bestaudio',
				'--no-playlist',
				'--no-progress',
				'--quiet',
				'-o',
				'-',
				youtubeUrl(videoId)
			],
			{ windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
		)
		let stderr = ''
		child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
		// Only end the stream once yt-dlp exits cleanly, so a failure halfway never looks like a complete file.
		const out = new PassThrough()
		child.stdout.pipe(out, { end: false })
		child.on('error', (err) => out.destroy(err))
		child.on('close', (code) => {
			if (code === 0) out.end()
			else out.destroy(new Error(`yt-dlp falló: ${stderr.trim().split('\n').pop() || `código ${code}`}`))
		})
		return sniff(out, () => child.kill())
	}

	async #openWithYoutubei(videoId: string): Promise<AudioStream> {
		const yt = await this.#client()
		let lastError: unknown
		for (const client of ['IOS', 'MWEB', 'YTMUSIC'] as const) {
			try {
				const web = await yt.download(videoId, { type: 'audio', quality: 'best', format: 'any', client })
				return await sniff(Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]))
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
			accountQuality: async () => YOUTUBE_QUALITY,
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

/** Wait for the first bytes (so failures surface before a file is created) and tell the container from them. */
async function sniff(stream: Readable, abort?: () => void): Promise<AudioStream> {
	// read() in paused mode, so nothing flows (and gets lost) before the caller attaches its pipeline.
	const first = await new Promise<Buffer>((resolve, reject) => {
		const cleanup = () => {
			stream.off('readable', onReadable)
			stream.off('error', onError)
			stream.off('end', onEnd)
		}
		const onReadable = () => {
			const chunk = stream.read() as Buffer | null
			if (!chunk) return
			cleanup()
			resolve(chunk)
		}
		const onError = (err: Error) => {
			cleanup()
			reject(err)
		}
		const onEnd = () => onError(new Error('YouTube no devolvió audio'))
		stream.on('readable', onReadable)
		stream.once('error', onError)
		stream.once('end', onEnd)
	}).catch((err) => {
		abort?.()
		throw err
	})
	stream.unshift(first)
	const mimeType =
		first.subarray(4, 8).toString('latin1') === 'ftyp'
			? 'audio/mp4'
			: first.readUInt32BE(0) === 0x1a45dfa3
				? 'audio/webm'
				: 'application/octet-stream'
	return { stream, mimeType }
}
