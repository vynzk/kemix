import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tx, type Db } from '../db'
import type { EventBus } from '../events'
import type { Accounts } from '../accounts'
import type { Library } from '../library'
import type { SettingsStore } from '../settings'
import type {
	AccountService,
	AudioQuality,
	DownloadRow,
	DownloadService,
	DownloadStatus,
	MatchCandidate,
	OutputFormat,
	QualityLevel,
	ScanState,
	SourceService,
	SourceTrack,
	StreamPreview,
	TargetTrack,
	TrackPreview,
	YouTubePreview
} from '../types'
import { DOWNLOAD_SERVICE_LABEL, isLossyService, serviceQualityLevel } from '../types'
import { isrcMatch, LOSSY_MIN_SCORE, resolveTrack, searchService } from '../match/resolve'
import { searchQueries } from '../match/score'
import { extensionFor, playlistDir, trackFileName } from './paths'
import { copyTags, fetchCover, writeM3u, writeTags } from './tagger'
import { codecFor, readFileQuality } from './quality'
import { sourceUpload } from '../sources/soundcloud'
import { pcmBitDepth, type AudioConverter, type PcmFormat } from './ffmpeg'
import { errorMessage, now } from '../util'

const MAX_ATTEMPTS = 3
const ACTIVE: DownloadStatus[] = ['queued', 'matching', 'downloading']

interface StoredMatch {
	status: string
	target: MatchCandidate | null
}

interface Row {
	id: number
	playlist_id: number
	position: number
	track_id: number
	status: DownloadStatus
	attempts: number
	/** Service the user picked for this download; null = automatic (service priority). */
	provider: DownloadService | null
	/** Quality the user picked for this download; null = the one in settings. */
	quality_level: QualityLevel | null
	/** File format the user picked for this download; null = the one in settings. */
	format: OutputFormat | null
}

/** A file already on disk (in the `files` index) for some track, level and format. */
interface KnownFile {
	path: string
	quality: AudioQuality | null
}

export class DownloadQueue {
	#running = new Set<number>()
	/** One per running download, to stop it when it's deleted. */
	#aborts = new Map<number, AbortController>()
	#lastProgress = new Map<number, number>()
	/** Per-playlist chain of .m3u8 writes, so concurrent finishing downloads never write the file at the same time. */
	#m3uWrites = new Map<number, Promise<void>>()
	/** Quality scans by playlist: the running one, or the last one's result. */
	#scans = new Map<number, { state: ScanState; abort: AbortController }>()

	constructor(
		private db: Db,
		private accounts: Accounts,
		private library: Library,
		private settings: SettingsStore,
		private events: EventBus,
		/** Converts downloads: to MP3 for the 'mp3_compat' quality, to AIFF/WAV for those formats. */
		private converter: AudioConverter,
		/** Called when a track's file is in place (downloaded, converted or reused), e.g. to analyze it. */
		private onDownloaded: (trackId: number) => void = () => {}
	) {}

	/** Resume work left over from a previous run (e.g. the app was closed mid-download). */
	start() {
		this.db
			.prepare(`UPDATE downloads SET status = 'queued', bytes = NULL WHERE status IN ('matching', 'downloading')`)
			.run()
		this.#pump()
	}

	/**
	 * Queue a playlist's tracks: all of them, or only the given positions.
	 * With a `provider`, the tracks are looked up only there, and tracks that didn't make it before (in review, failed
	 * or skipped) are tried again with it. Without one, the services are tried in priority order.
	 * `level` and `format` apply to every queued track that isn't downloaded yet; without them, the ones in settings
	 * are used.
	 */
	async enqueuePlaylist(
		playlistId: number,
		positions?: number[],
		provider?: DownloadService | null,
		level?: QualityLevel | null,
		format?: OutputFormat | null
	) {
		if (provider && !isLossyService(provider) && !this.accounts.isConnected(provider)) {
			throw new Error(`${DOWNLOAD_SERVICE_LABEL[provider]} no está conectado`)
		}
		await this.library.syncPlaylistTracks(playlistId)
		const only = positions?.filter((p) => Number.isInteger(p))
		if (only && !only.length) return
		// Positions are validated integers, so they can be inlined safely (and avoid SQLite's parameter limit).
		const filter = only ? ` AND position IN (${only.join(',')})` : ''
		// Which existing entries start over. SET expressions all see the old row, so the CASEs agree with each other.
		const redo = provider
			? `downloads.status IN ('queued', 'error', 'needs_review', 'skipped')`
			: `downloads.status = 'error'`
		const t = now()
		tx(this.db, () => {
			this.db
				.prepare(
					`INSERT INTO downloads (playlist_id, position, track_id, status, updated_at, provider, quality_level, format)
					 SELECT playlist_id, position, track_id, 'queued', ?, ?, ?, ? FROM playlist_tracks WHERE playlist_id = ?${filter}
					 ON CONFLICT(playlist_id, position) DO UPDATE SET
					   status = CASE WHEN ${redo} THEN 'queued' ELSE downloads.status END,
					   attempts = CASE WHEN ${redo} THEN 0 ELSE downloads.attempts END,
					   error = CASE WHEN ${redo} THEN NULL ELSE downloads.error END,
					   provider = CASE WHEN ${redo} THEN excluded.provider ELSE downloads.provider END,
					   quality_level = CASE WHEN downloads.status = 'done' THEN downloads.quality_level ELSE excluded.quality_level END,
					   format = CASE WHEN downloads.status = 'done' THEN downloads.format ELSE excluded.format END,
					   updated_at = excluded.updated_at`
				)
				.run(t, provider ?? null, level ?? null, format ?? null, playlistId)
			// Files deleted from disk since the last run get downloaded again.
			const done = this.db
				.prepare(`SELECT id, path FROM downloads WHERE playlist_id = ? AND status = 'done'${filter}`)
				.all(playlistId) as { id: number; path: string | null }[]
			const requeue = this.db.prepare(
				`UPDATE downloads SET status = 'queued', attempts = 0, provider = ?, quality_level = ?, format = ? WHERE id = ?`
			)
			for (const d of done) {
				if (!d.path || !fs.existsSync(d.path)) requeue.run(provider ?? null, level ?? null, format ?? null, d.id)
			}
		})
		this.events.emit({ type: 'playlist', playlistId })
		this.events.emit({ type: 'library' })
		this.events.emit({ type: 'review' })
		this.#pump()
	}

	retryFailed() {
		this.db.prepare(`UPDATE downloads SET status = 'queued', attempts = 0, error = NULL WHERE status = 'error'`).run()
		this.events.emit({ type: 'library' })
		this.#pump()
	}

	clearFinished() {
		// Only forgets the queue entries; files on disk and the `files` index are kept.
		this.db.prepare(`DELETE FROM downloads WHERE status IN ('done', 'skipped')`).run()
		this.events.emit({ type: 'library' })
	}

	/**
	 * Delete a download: stop it if it's running, delete its file from disk and forget the entry, so the track shows
	 * as not downloaded. Copies of the same track in other playlists are separate files and stay.
	 */
	async remove(id: number) {
		const row = this.db.prepare('SELECT playlist_id, status, path FROM downloads WHERE id = ?').get(id) as
			| { playlist_id: number; status: DownloadStatus; path: string | null }
			| undefined
		if (!row) return
		this.#aborts.get(id)?.abort()
		// Only a finished download owns its path; other states may keep a stale one from an earlier attempt.
		const file = row.status === 'done' ? row.path : null
		// Another entry pointing at the very same file (two playlists with the same name) keeps it.
		const shared =
			file &&
			this.db.prepare(`SELECT 1 FROM downloads WHERE path = ? AND status = 'done' AND id != ? LIMIT 1`).get(file, id)
		if (file && !shared) {
			// Before touching the database: if the file can't be deleted (e.g. open in a player), the entry stays.
			try {
				await fsp.rm(file, { force: true })
			} catch (err) {
				throw new Error(`No se pudo borrar el archivo: ${errorMessage(err)}`)
			}
		}
		// It may have been picked up again while the file was being deleted.
		this.#aborts.get(id)?.abort()
		tx(this.db, () => {
			this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
			if (file && !shared) this.db.prepare('DELETE FROM files WHERE path = ?').run(file)
		})
		if (file && !shared) {
			const anyLeft = this.db
				.prepare(`SELECT 1 FROM downloads WHERE playlist_id = ? AND status = 'done' LIMIT 1`)
				.get(row.playlist_id)
			// The playlist file is rewritten without it; with no track left, there's nothing to list.
			if (anyLeft) this.#scheduleM3u(row.playlist_id)
			else {
				const dir = path.dirname(file)
				await fsp.rm(path.join(dir, `${path.basename(dir)}.m3u8`), { force: true }).catch(() => {})
			}
		}
		this.events.emit({ type: 'download-removed', id, playlistId: row.playlist_id })
		this.events.emit({ type: 'playlist', playlistId: row.playlist_id })
		this.events.emit({ type: 'library' })
		if (row.status === 'needs_review') this.events.emit({ type: 'review' })
	}

	list(limit = 300): DownloadRow[] {
		const rows = this.db
			.prepare(
				`${ROW_SELECT}
				 ORDER BY CASE d.status WHEN 'downloading' THEN 0 WHEN 'matching' THEN 1 WHEN 'queued' THEN 2
				   WHEN 'error' THEN 3 WHEN 'needs_review' THEN 4 ELSE 5 END, d.updated_at DESC
				 LIMIT ?`
			)
			.all(limit) as unknown as RawDownloadRow[]
		return rows.map(toDownloadRow)
	}

	// ---------- quality scan ----------

	/** The playlist's running scan, or the last one's result; null if it was never scanned in this run. */
	scanState(playlistId: number): ScanState | null {
		return this.#scans.get(playlistId)?.state ?? null
	}

	/**
	 * Look a playlist's tracks up (all of them, or only the given positions) the way a download would, to learn the
	 * best quality each one has before downloading. Nothing is downloaded and nothing is queued: the matches are
	 * stored, so a later download uses them without searching again.
	 * With a `provider`, the tracks are looked up only there; without one, in priority order. Tracks already
	 * downloaded keep their file's quality and aren't looked up. Runs in the background; progress comes as `scan` events.
	 */
	async scanPlaylist(playlistId: number, positions?: number[], provider?: DownloadService | null): Promise<ScanState> {
		if (provider) await this.#downloaderFor(provider)
		const running = this.#scans.get(playlistId)
		if (running?.state.running) return running.state
		await this.library.syncPlaylistTracks(playlistId)
		const only = positions?.filter((p) => Number.isInteger(p))
		const filter = only ? ` AND pt.position IN (${only.join(',') || '-1'})` : ''
		const rows = this.db
			.prepare(
				`SELECT DISTINCT pt.track_id FROM playlist_tracks pt
				 LEFT JOIN downloads d ON d.playlist_id = pt.playlist_id AND d.position = pt.position
				 WHERE pt.playlist_id = ? AND (d.status IS NULL OR d.status != 'done')${filter}
				 ORDER BY pt.position`
			)
			.all(playlistId) as { track_id: number }[]
		const pick = provider ?? null
		const todo = rows
			.map((r) => r.track_id)
			.filter((id) => {
				const match = this.#match(id)
				return this.#needsLookup(match, pick) || !!(match?.target && !match.target.maxQuality)
			})

		const scan = {
			state: { playlistId, running: true, done: 0, total: todo.length, failed: 0, error: null } as ScanState,
			abort: new AbortController()
		}
		this.#scans.set(playlistId, scan)
		this.events.emit({ type: 'scan', scan: { ...scan.state } })
		void this.#runScan(scan, todo, pick)
		return { ...scan.state }
	}

	/** Stop every running scan (on shutdown). */
	stopScans() {
		for (const s of this.#scans.values()) s.abort.abort()
	}

	/**
	 * Whether a scan has to look the track up: never looked up, matched elsewhere than the provider picked, or left
	 * unresolved last time (it may be found now). A track the user skipped stays skipped unless a provider is picked.
	 */
	#needsLookup(match: StoredMatch | null, provider: DownloadService | null) {
		if (!match || this.#isOtherProvider(match, provider)) return true
		return !provider && (match.status === 'pending' || match.status === 'notfound')
	}

	async #runScan(scan: { state: ScanState; abort: AbortController }, trackIds: number[], provider: DownloadService | null) {
		const { state, abort } = scan
		const emit = () => this.events.emit({ type: 'scan', scan: { ...state } })
		let next = 0
		const worker = async () => {
			while (next < trackIds.length && !abort.signal.aborted) {
				const trackId = trackIds[next++]!
				try {
					await this.#scanTrack(trackId, provider)
				} catch (err) {
					if (abort.signal.aborted) return
					state.failed++
					state.error ??= errorMessage(err)
				}
				if (abort.signal.aborted) return
				state.done++
				emit()
				this.events.emit({ type: 'playlist', playlistId: state.playlistId })
			}
		}
		const workers = Math.max(1, Math.min(this.settings.get().concurrency, trackIds.length))
		await Promise.all(Array.from({ length: workers }, worker))
		if (abort.signal.aborted) return
		state.running = false
		emit()
		this.events.emit({ type: 'playlist', playlistId: state.playlistId })
		this.events.emit({ type: 'library' })
	}

	async #scanTrack(trackId: number, provider: DownloadService | null) {
		let match = this.#match(trackId)
		if (this.#needsLookup(match, provider)) {
			match = await this.#resolveAndStore(trackId, provider)
			// Downloads already asked for and waiting in review for this track can go ahead now that it was found.
			if (match.target && (match.status === 'auto' || match.status === 'accepted')) {
				const moved = this.db
					.prepare(
						`UPDATE downloads SET status = 'queued', attempts = 0, error = NULL, provider = ?
						 WHERE track_id = ? AND status = 'needs_review'`
					)
					.run(match.target.service, trackId)
				if (moved.changes) {
					this.events.emit({ type: 'review' })
					this.#pump()
				}
			}
		}
		const target = match?.target
		if (!target || target.maxQuality) return
		// Matched straight from the playlist's own service (a Qobuz or Deezer playlist): its quality comes with the track.
		const { meta } = await (await this.accounts.downloader(target.service)).getTrack(target.url)
		if (!meta.maxQuality) return
		this.db
			.prepare('UPDATE matches SET target_meta = ? WHERE track_id = ?')
			.run(JSON.stringify({ ...target, maxQuality: meta.maxQuality }), trackId)
	}

	// ---------- review ----------

	/**
	 * Manual search from the review page: the user's query, or the same searches automatic matching runs.
	 * With a `provider`, only there; otherwise on every connected service, in priority order.
	 */
	async searchCandidates(trackId: number, query?: string, provider?: DownloadService | null): Promise<MatchCandidate[]> {
		const track = this.library.getTrack(trackId)
		const queries = query?.trim() ? [query.trim()] : searchQueries(track)
		const threshold = this.settings.get().autoAcceptThreshold
		const downloaders = provider ? [await this.#downloaderFor(provider)] : await this.accounts.downloaders()
		if (!downloaders.length) throw new Error('Conecta Qobuz, Deezer o Soundeo, o busca en YouTube o SoundCloud')
		const out: MatchCandidate[] = []
		const failures: string[] = []
		for (const d of downloaders) {
			// YouTube/SoundCloud titles are noisier: a convincing upload there scores lower than a sure match elsewhere.
			const enough = isLossyService(d.service) ? Math.min(threshold, LOSSY_MIN_SCORE) : threshold
			try {
				out.push(...(await searchService(track, d, queries, enough)))
			} catch (err) {
				// Results from the other services are still worth showing.
				failures.push(`${DOWNLOAD_SERVICE_LABEL[d.service]}: ${errorMessage(err)}`)
			}
		}
		if (!out.length && failures.length) throw new Error(`No se pudo buscar (${failures.join(' · ')})`)
		return out.sort((a, b) => b.score - a.score)
	}

	/** YouTube videos for a track (lossy: only offered when the user asks for them). */
	async youtubeCandidates(trackId: number, query?: string): Promise<MatchCandidate[]> {
		return this.accounts.youtube.candidates(this.library.getTrack(trackId), query)
	}

	/**
	 * Fallback for tracks that aren't on Qobuz/Deezer: pick the best YouTube video for each and queue it.
	 * Tracks without a convincing video stay in review.
	 */
	async downloadFromYouTube(trackIds: number[]): Promise<{ queued: number; notFound: number }> {
		let queued = 0
		let notFound = 0
		for (const trackId of trackIds) {
			try {
				const best = (await this.youtubeCandidates(trackId))[0]
				if (!best || best.score < LOSSY_MIN_SCORE) {
					notFound++
					continue
				}
				this.acceptCandidate(trackId, best)
				queued++
			} catch {
				notFound++
			}
		}
		return { queued, notFound }
	}

	/** Something to listen to a library track: its own service's audio when it has the full song, else YouTube. */
	preview(trackId: number): Promise<TrackPreview | null> {
		const track = this.library.getTrack(trackId)
		// A SoundCloud track plays in SoundCloud's own player: it's that very upload.
		const upload = sourceUpload(track)
		if (upload) return Promise.resolve({ kind: 'soundcloud', url: upload.url, title: track.title })
		return this.#listen(track.source, track, () => this.accounts.youtube.preview(track))
	}

	/**
	 * Same, for a track that isn't in the library, like a search result from `service` (or a Soundeo candidate).
	 * `exact`: this very recording matters (checking a review candidate), so the service's own audio wins even when
	 * it's only a clip; a YouTube search could land on another version.
	 */
	previewTrack(service: AccountService, track: SourceTrack, exact = false): Promise<TrackPreview | null> {
		return this.#listen(service, track, () => this.accounts.youtube.previewFor(service, track), exact)
	}

	async #listen(
		service: AccountService,
		track: SourceTrack,
		youtube: () => Promise<YouTubePreview | null>,
		exact = false
	): Promise<TrackPreview | null> {
		let native: StreamPreview | null = null
		try {
			native =
				service === 'soundeo'
					? await this.accounts.soundeoPreview(track.sourceId)
					: ((await this.accounts.source(service).stream?.(track.sourceId)) ?? null)
		} catch {
			// Not connected, or the service refused: YouTube is still there.
		}
		const fromService = (s: StreamPreview): TrackPreview => ({ kind: 'stream', service, title: track.title, ...s })
		if (native?.full || (exact && native)) return fromService(native)
		let video: YouTubePreview | null = null
		try {
			video = await youtube()
		} catch (err) {
			if (!native) throw err
		}
		if (video) return { kind: 'youtube', ...video }
		return native && fromService(native)
	}

	acceptCandidate(trackId: number, candidate: MatchCandidate) {
		this.db
			.prepare(
				`UPDATE matches SET status = 'accepted', target_service = ?, target_id = ?, target_url = ?, target_meta = ?,
				   confidence = ?, updated_at = ? WHERE track_id = ?`
			)
			.run(candidate.service, candidate.id, candidate.url, JSON.stringify(candidate), candidate.score, now(), trackId)
		this.db
			.prepare(
				`UPDATE downloads SET status = 'queued', attempts = 0, error = NULL, provider = ?
				 WHERE track_id = ? AND status = 'needs_review'`
			)
			.run(candidate.service, trackId)
		this.events.emit({ type: 'review' })
		this.events.emit({ type: 'library' })
		this.#pump()
	}

	/**
	 * Accept `candidate` but download it from `provider`: that same recording is looked up there (by ISRC, else by
	 * a confident metadata match), so the user can pick a version on one service and get it from another.
	 */
	async acceptCandidateFrom(trackId: number, candidate: MatchCandidate, provider: DownloadService) {
		if (provider === candidate.service) return this.acceptCandidate(trackId, candidate)
		const label = DOWNLOAD_SERVICE_LABEL[provider]
		const d = await this.#downloaderFor(provider)
		const recording: SourceTrack = {
			sourceId: candidate.id,
			title: candidate.title,
			artists: candidate.artists,
			album: candidate.album,
			durationMs: candidate.durationMs,
			isrc: candidate.isrc
		}
		// Same ISRC: the same recording, so it's as right for the library track as the candidate picked.
		const byIsrc = candidate.isrc ? await isrcMatch(recording, candidate.isrc, [d]) : null
		if (byIsrc) return this.acceptCandidate(trackId, { ...byIsrc, score: candidate.score })
		const threshold = this.settings.get().autoAcceptThreshold
		const enough = isLossyService(provider) ? Math.min(threshold, LOSSY_MIN_SCORE) : threshold
		const best = (await searchService(recording, d, searchQueries(recording), enough))[0]
		if (!best || best.score < enough) {
			throw new Error(`No encontré ese mismo tema en ${label}. Busca directamente en ${label} y elige uno de sus resultados.`)
		}
		// No surer it's the library track than the candidate picked, nor than this lookup.
		this.acceptCandidate(trackId, { ...best, score: Math.min(candidate.score, best.score) })
	}

	/** A download service the user picked by hand: it has to be connected (YouTube and SoundCloud need no account). */
	async #downloaderFor(provider: DownloadService) {
		if (!isLossyService(provider) && !this.accounts.isConnected(provider)) {
			throw new Error(`${DOWNLOAD_SERVICE_LABEL[provider]} no está conectado`)
		}
		return this.accounts.downloader(provider)
	}

	skipTrack(trackId: number) {
		this.db.prepare(`UPDATE matches SET status = 'skipped', updated_at = ? WHERE track_id = ?`).run(now(), trackId)
		this.db.prepare(`UPDATE downloads SET status = 'skipped' WHERE track_id = ? AND status = 'needs_review'`).run(trackId)
		this.events.emit({ type: 'review' })
		this.events.emit({ type: 'library' })
	}

	// ---------- worker ----------

	#pump() {
		const limit = this.settings.get().concurrency
		while (this.#running.size < limit) {
			const placeholders = [...this.#running].join(',') || '0'
			const row = this.db
				.prepare(
					`SELECT id, playlist_id, position, track_id, status, attempts, provider, quality_level, format FROM downloads
					 WHERE status = 'queued' AND id NOT IN (${placeholders}) ORDER BY attempts, id LIMIT 1`
				)
				.get() as Row | undefined
			if (!row) return
			this.#running.add(row.id)
			const abort = new AbortController()
			this.#aborts.set(row.id, abort)
			this.#setStatus(row.id, 'matching')
			this.#process(row, abort.signal)
				// Deleted while running: the entry is gone, there's nothing to mark as failed.
				.catch((err) => {
					if (!abort.signal.aborted) this.#fail(row, err)
				})
				.finally(() => {
					this.#running.delete(row.id)
					this.#aborts.delete(row.id)
					this.#lastProgress.delete(row.id)
					this.#scheduleM3u(row.playlist_id)
					this.#pump()
				})
		}
	}

	/** A provider was picked: the track is looked up there unless it's already matched to it. */
	#isOtherProvider(match: StoredMatch | null, provider: DownloadService | null) {
		return (
			!!provider &&
			(!match || !match.target || match.target.service !== provider || !['auto', 'accepted'].includes(match.status))
		)
	}

	/** Look a track up on the download services (only on `provider`, if given) and store the result as its match. */
	async #resolveAndStore(trackId: number, provider: DownloadService | null) {
		const track = this.library.getTrack(trackId)
		const downloaders = provider ? [await this.accounts.downloader(provider)] : await this.accounts.downloaders()
		if (!downloaders.length) {
			throw new Error('Conecta Qobuz, Deezer o Soundeo (o activa YouTube o SoundCloud en Ajustes) para poder descargar')
		}
		const res = await resolveTrack(track, downloaders, this.settings.get().autoAcceptThreshold, {
			findIsrc: (t, minScore) => this.accounts.findIsrc(t, minScore)
		})
		this.db
			.prepare(
				`INSERT INTO matches (track_id, status, target_service, target_id, target_url, target_meta, confidence, candidates, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(track_id) DO UPDATE SET status = excluded.status, target_service = excluded.target_service,
				   target_id = excluded.target_id, target_url = excluded.target_url, target_meta = excluded.target_meta,
				   confidence = excluded.confidence, candidates = excluded.candidates, updated_at = excluded.updated_at`
			)
			.run(
				trackId,
				res.status,
				res.target?.service ?? null,
				res.target?.id ?? null,
				res.target?.url ?? null,
				res.target ? JSON.stringify(res.target) : null,
				res.target?.score ?? null,
				JSON.stringify(res.candidates),
				now()
			)
		return this.#match(trackId)!
	}

	async #process(row: Row, signal: AbortSignal) {
		const track = this.library.getTrack(row.track_id)
		let match = this.#match(row.track_id)
		if (!match || this.#isOtherProvider(match, row.provider)) match = await this.#resolveAndStore(row.track_id, row.provider)
		signal.throwIfAborted()

		if (match.status === 'skipped') return this.#setStatus(row.id, 'skipped')
		if (match.status === 'pending' || match.status === 'notfound' || !match.target) {
			this.#setStatus(row.id, 'needs_review')
			this.events.emit({ type: 'review' })
			return
		}

		const target = match.target
		const playlist = this.db.prepare('SELECT name, track_count FROM playlists WHERE id = ?').get(row.playlist_id) as {
			name: string
			track_count: number | null
		}
		const dir = playlistDir(this.settings.get().downloadDir, playlist.name)
		await fsp.mkdir(dir, { recursive: true })
		const nameFor = (meta: TargetTrack, ext: string) =>
			path.join(
				dir,
				trackFileName({ position: row.position, total: playlist.track_count ?? 0, artists: meta.artists, title: meta.title, ext })
			)

		// Already downloaded for another playlist (or a previous run): link or copy instead of downloading again.
		// YouTube/SoundCloud titles and uploaders are not real metadata: name and tag the file after the source track instead.
		const fromSource = (t: TargetTrack): TargetTrack =>
			isLossyService(target.service)
				? {
						...t,
						title: track.title,
						artists: track.artists,
						album: track.album,
						isrc: track.isrc,
						coverUrl: track.coverUrl ?? target.coverUrl
					}
				: t

		// Files are only reused at the quality and in the format they were made in (levels a service can't tell apart
		// count as one).
		const settings = this.settings.get()
		const level = row.quality_level ?? settings.downloadQuality
		const format = row.format ?? settings.outputFormat
		const pcm: PcmFormat | null = format === 'original' ? null : format
		const fileLevel = serviceQualityLevel(target.service, level)
		const existing = this.#knownFile(target, fileLevel, format)
		const existingExt = existing ? path.extname(existing.path).slice(1).toLowerCase() : ''
		// An MP3 was asked for: a file that came in another format (not converted back then) doesn't do.
		if (existing && (pcm || level !== 'mp3_compat' || existingExt === 'mp3')) {
			const dest = await this.#reuse(existing.path, nameFor(fromSource(target), existingExt), signal)
			return this.#finish(row, dest, target.service, existing.quality ?? readFileQuality(dest))
		}

		// AIFF/WAV of a track downloaded before as the service delivers it: convert that file instead of downloading.
		const original = pcm ? this.#knownFile(target, fileLevel, 'original') : null
		if (pcm && original) {
			this.#setStatus(row.id, 'downloading')
			const source = original.quality ?? readFileQuality(original.path)
			const dest = nameFor(fromSource(target), pcm)
			const part = `${dest}.part`
			try {
				await this.converter.toPcm(original.path, part, { format: pcm, bitDepth: pcmBitDepth(source), signal })
				await fsp.rm(dest, { force: true })
				await fsp.rename(part, dest)
			} catch (err) {
				await fsp.rm(part, { force: true })
				throw err
			}
			try {
				copyTags(original.path, dest)
			} catch (err) {
				console.warn(`[kemix] No se pudieron copiar los tags a ${dest}: ${errorMessage(err)}`)
			}
			return this.#saved(row, target, fileLevel, format, dest, source, signal)
		}

		this.#setStatus(row.id, 'downloading')
		const downloader = await this.accounts.downloader(target.service)
		const got = await downloader.getTrack(target.url)
		const meta = fromSource(got.meta)
		signal.throwIfAborted()
		const audio = await got.open(level, format)
		if (signal.aborted) {
			audio.stream.destroy()
			signal.throwIfAborted()
		}
		const ext = extensionFor(audio.mimeType)
		// AIFF/WAV was asked for; or an MP3 that plays anywhere and something else came (YouTube's AAC/Opus, a FLAC).
		const toMp3 = !pcm && level === 'mp3_compat' && ext !== 'mp3'
		const convert = !!pcm || toMp3
		const dest = nameFor(meta, pcm ?? (toMp3 ? 'mp3' : ext))
		const part = `${dest}.part`
		// When converting, the download goes to its own file (with its extension, so its quality can be read) and
		// ffmpeg writes the .part.
		const raw = convert ? `${dest}.download.${ext}` : part
		let bytes = 0
		const counter = new Transform({
			transform: (chunk: Buffer, _enc, cb) => {
				bytes += chunk.length
				this.#progress(row.id, bytes, audio.sizeBytes ?? null)
				cb(null, chunk)
			}
		})
		let source: AudioQuality | null = null
		try {
			await pipeline(audio.stream, counter, fs.createWriteStream(raw), { signal })
			if (convert) {
				source = readFileQuality(raw)
				const lossless = source?.lossless ?? ['flac', 'wav', 'aiff'].includes(codecFor(ext))
				if (pcm && ext === pcm && source?.lossless && (source.bitDepth === 16 || source.bitDepth === 24)) {
					// The service sent the very format asked for (Soundeo's AIFF or WAV): nothing to convert.
					await fsp.rename(raw, part)
					source = null
				} else if (pcm) await this.converter.toPcm(raw, part, { format: pcm, bitDepth: pcmBitDepth(source), signal })
				else await this.converter.toMp3(raw, part, { lossless, signal })
			}
			await fsp.rm(dest, { force: true })
			await fsp.rename(part, dest)
		} catch (err) {
			await fsp.rm(part, { force: true })
			throw err
		} finally {
			if (convert) await fsp.rm(raw, { force: true })
		}

		try {
			const cover = await fetchCover(meta.coverUrl ?? target.coverUrl)
			writeTags(dest, { ...meta, coverUrl: meta.coverUrl ?? target.coverUrl }, cover)
		} catch (err) {
			// The audio is fine without tags; don't fail the download over it.
			console.warn(`[kemix] No se pudieron escribir tags en ${dest}: ${errorMessage(err)}`)
		}
		return this.#saved(row, target, fileLevel, format, dest, source, signal)
	}

	/** A file already made for this track at this level and in this format, if it's still on disk. */
	#knownFile(target: TargetTrack, level: QualityLevel, format: OutputFormat): KnownFile | null {
		const f = this.db
			.prepare('SELECT path, quality FROM files WHERE target_service = ? AND target_id = ? AND quality_level = ? AND format = ?')
			.get(target.service, target.id, level, format) as { path: string; quality: string | null } | undefined
		if (!f || !fs.existsSync(f.path)) return null
		return { path: f.path, quality: f.quality ? (JSON.parse(f.quality) as AudioQuality) : null }
	}

	/** Put an existing file at `dest` (hardlink, else copy) instead of downloading it again. */
	async #reuse(file: string, dest: string, signal: AbortSignal): Promise<string> {
		if (path.resolve(dest) === path.resolve(file)) return dest
		await fsp.rm(dest, { force: true })
		await fsp.link(file, dest).catch(() => fsp.copyFile(file, dest))
		if (signal.aborted) {
			await fsp.rm(dest, { force: true })
			signal.throwIfAborted()
		}
		return dest
	}

	/** A new file is finished at `dest`: record it for reuse and mark the download done. `source`: what it was converted from. */
	async #saved(
		row: Row,
		target: TargetTrack,
		level: QualityLevel,
		format: OutputFormat,
		dest: string,
		source: AudioQuality | null,
		signal: AbortSignal
	) {
		// Deleted while the file was being finished: it's not wanted any more.
		if (signal.aborted) {
			await fsp.rm(dest, { force: true })
			signal.throwIfAborted()
		}
		const read = readFileQuality(dest)
		const quality = read && source ? { ...read, convertedFrom: source } : read
		tx(this.db, () => {
			// The file may have replaced another one on the same path: that entry no longer describes it.
			this.db.prepare('DELETE FROM files WHERE path = ?').run(dest)
			this.db
				.prepare(
					`INSERT INTO files (target_service, target_id, quality_level, format, path, quality) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT DO UPDATE SET path = excluded.path, quality = excluded.quality`
				)
				.run(target.service, target.id, level, format, dest, quality ? JSON.stringify(quality) : null)
		})
		this.#finish(row, dest, target.service, quality)
	}

	#finish(row: Row, dest: string, service: DownloadService, quality: AudioQuality | null) {
		this.db
			.prepare(
				`UPDATE downloads SET status = 'done', path = ?, error = NULL, service = ?, quality = ?, updated_at = ? WHERE id = ?`
			)
			.run(dest, service, quality ? JSON.stringify(quality) : null, now(), row.id)
		this.#emitRow(row.id)
		this.onDownloaded(row.track_id)
	}

	#fail(row: Row, err: unknown) {
		const attempts = row.attempts + 1
		const status: DownloadStatus = attempts < MAX_ATTEMPTS ? 'queued' : 'error'
		this.db
			.prepare('UPDATE downloads SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?')
			.run(status, attempts, errorMessage(err), now(), row.id)
		this.#emitRow(row.id)
	}

	#match(trackId: number): StoredMatch | null {
		const m = this.db.prepare('SELECT status, target_meta FROM matches WHERE track_id = ?').get(trackId) as
			| { status: string; target_meta: string | null }
			| undefined
		if (!m) return null
		return { status: m.status, target: m.target_meta ? (JSON.parse(m.target_meta) as MatchCandidate) : null }
	}

	#setStatus(id: number, status: DownloadStatus) {
		this.db.prepare('UPDATE downloads SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id)
		this.#emitRow(id)
	}

	#progress(id: number, bytes: number, total: number | null) {
		const t = Date.now()
		if (t - (this.#lastProgress.get(id) ?? 0) < 400) return
		this.#lastProgress.set(id, t)
		this.db.prepare('UPDATE downloads SET bytes = ?, total_bytes = ? WHERE id = ?').run(bytes, total, id)
		this.#emitRow(id)
	}

	#emitRow(id: number) {
		const raw = this.db.prepare(`${ROW_SELECT} WHERE d.id = ?`).get(id) as RawDownloadRow | undefined
		if (raw) this.events.emit({ type: 'download', row: toDownloadRow(raw) })
	}

	#scheduleM3u(playlistId: number) {
		const prev = this.#m3uWrites.get(playlistId) ?? Promise.resolve()
		const next = prev
			.then(() => this.#maybeWriteM3u(playlistId))
			.catch((err) => console.warn(`[kemix] No se pudo escribir el .m3u8: ${errorMessage(err)}`))
			.finally(() => {
				if (this.#m3uWrites.get(playlistId) === next) this.#m3uWrites.delete(playlistId)
			})
		this.#m3uWrites.set(playlistId, next)
	}

	/** Resolves once pending playlist-file writes are done (used on shutdown and in tests). */
	async flush() {
		while (this.#m3uWrites.size) await Promise.all(this.#m3uWrites.values())
	}

	async #maybeWriteM3u(playlistId: number) {
		const active = this.db
			.prepare(`SELECT 1 FROM downloads WHERE playlist_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) LIMIT 1`)
			.get(playlistId, ...ACTIVE)
		if (active) return
		const done = this.db
			.prepare(
				`SELECT d.path, t.title, t.artists, t.duration_ms FROM downloads d JOIN tracks t ON t.id = d.track_id
				 WHERE d.playlist_id = ? AND d.status = 'done' ORDER BY d.position`
			)
			.all(playlistId) as { path: string; title: string; artists: string; duration_ms: number | null }[]
		if (!done.length) return
		const { name } = this.db.prepare('SELECT name FROM playlists WHERE id = ?').get(playlistId) as { name: string }
		await writeM3u(
			path.dirname(done[0]!.path),
			name,
			done.map((d) => ({
				path: d.path,
				durationMs: d.duration_ms,
				label: `${(JSON.parse(d.artists) as string[]).join(', ')} - ${d.title}`
			}))
		)
	}
}

const ROW_SELECT = `SELECT d.id, d.playlist_id, p.name AS playlist_name, d.track_id, t.title, t.artists, d.status, d.error,
	d.bytes, d.total_bytes, d.updated_at, d.quality, d.service
	FROM downloads d JOIN playlists p ON p.id = d.playlist_id JOIN tracks t ON t.id = d.track_id`

interface RawDownloadRow {
	id: number
	playlist_id: number
	playlist_name: string
	track_id: number
	title: string
	artists: string
	status: DownloadStatus
	error: string | null
	bytes: number | null
	total_bytes: number | null
	updated_at: number
	quality: string | null
	service: DownloadService | null
}

function toDownloadRow(r: RawDownloadRow): DownloadRow {
	return {
		id: r.id,
		playlistId: r.playlist_id,
		playlistName: r.playlist_name,
		trackId: r.track_id,
		title: r.title,
		artists: JSON.parse(r.artists),
		status: r.status,
		error: r.error,
		bytes: r.bytes,
		totalBytes: r.total_bytes,
		updatedAt: r.updated_at,
		quality: r.quality ? (JSON.parse(r.quality) as AudioQuality) : null,
		service: r.service
	}
}
