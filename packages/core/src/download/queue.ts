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
	AudioQuality,
	DownloadRow,
	DownloadService,
	DownloadStatus,
	MatchCandidate,
	SourceService,
	SourceTrack,
	StreamPreview,
	TargetTrack,
	TrackPreview,
	YouTubePreview
} from '../types'
import { resolveTrack, YOUTUBE_MIN_SCORE } from '../match/resolve'
import { scoreMatch, searchQuery } from '../match/score'
import { extensionFor, playlistDir, trackFileName } from './paths'
import { fetchCover, writeM3u, writeTags } from './tagger'
import { readFileQuality } from './quality'
import { errorMessage, now } from '../util'

const MAX_ATTEMPTS = 3
const ACTIVE: DownloadStatus[] = ['queued', 'matching', 'downloading']

interface Row {
	id: number
	playlist_id: number
	position: number
	track_id: number
	status: DownloadStatus
	attempts: number
	/** Service the user picked for this download; null = automatic (service priority). */
	provider: DownloadService | null
}

const PROVIDER_LABEL: Record<DownloadService, string> = { qobuz: 'Qobuz', deezer: 'Deezer', youtube: 'YouTube' }

export class DownloadQueue {
	#running = new Set<number>()
	#lastProgress = new Map<number, number>()
	/** Per-playlist chain of .m3u8 writes, so concurrent finishing downloads never write the file at the same time. */
	#m3uWrites = new Map<number, Promise<void>>()

	constructor(
		private db: Db,
		private accounts: Accounts,
		private library: Library,
		private settings: SettingsStore,
		private events: EventBus
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
	 */
	async enqueuePlaylist(playlistId: number, positions?: number[], provider?: DownloadService | null) {
		if (provider && provider !== 'youtube' && !this.accounts.isConnected(provider)) {
			throw new Error(`${PROVIDER_LABEL[provider]} no está conectado`)
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
					`INSERT INTO downloads (playlist_id, position, track_id, status, updated_at, provider)
					 SELECT playlist_id, position, track_id, 'queued', ?, ? FROM playlist_tracks WHERE playlist_id = ?${filter}
					 ON CONFLICT(playlist_id, position) DO UPDATE SET
					   status = CASE WHEN ${redo} THEN 'queued' ELSE downloads.status END,
					   attempts = CASE WHEN ${redo} THEN 0 ELSE downloads.attempts END,
					   error = CASE WHEN ${redo} THEN NULL ELSE downloads.error END,
					   provider = CASE WHEN ${redo} THEN excluded.provider ELSE downloads.provider END,
					   updated_at = excluded.updated_at`
				)
				.run(t, provider ?? null, playlistId)
			// Files deleted from disk since the last run get downloaded again.
			const done = this.db
				.prepare(`SELECT id, path FROM downloads WHERE playlist_id = ? AND status = 'done'${filter}`)
				.all(playlistId) as { id: number; path: string | null }[]
			const requeue = this.db.prepare(`UPDATE downloads SET status = 'queued', attempts = 0, provider = ? WHERE id = ?`)
			for (const d of done) if (!d.path || !fs.existsSync(d.path)) requeue.run(provider ?? null, d.id)
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

	// ---------- review ----------

	async searchCandidates(trackId: number, query?: string): Promise<MatchCandidate[]> {
		const track = this.library.getTrack(trackId)
		const q = query?.trim() || searchQuery(track)
		const out: MatchCandidate[] = []
		for (const d of await this.accounts.downloaders()) {
			try {
				for (const r of await d.search(q, 10)) out.push({ ...r, score: scoreMatch(track, r) })
			} catch {
				// ignore a failing service
			}
		}
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
				if (!best || best.score < YOUTUBE_MIN_SCORE) {
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
		return this.#listen(track.source, track, () => this.accounts.youtube.preview(track))
	}

	/** Same, for a track that isn't in the library, like a search result from `service`. */
	previewTrack(service: SourceService, track: SourceTrack): Promise<TrackPreview | null> {
		return this.#listen(service, track, () => this.accounts.youtube.previewFor(service, track))
	}

	async #listen(
		service: SourceService,
		track: SourceTrack,
		youtube: () => Promise<YouTubePreview | null>
	): Promise<TrackPreview | null> {
		let native: StreamPreview | null = null
		try {
			native = (await this.accounts.source(service).stream?.(track.sourceId)) ?? null
		} catch {
			// Not connected, or the service refused: YouTube is still there.
		}
		const fromService = (s: StreamPreview): TrackPreview => ({ kind: 'stream', service, title: track.title, ...s })
		if (native?.full) return fromService(native)
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
					`SELECT id, playlist_id, position, track_id, status, attempts, provider FROM downloads
					 WHERE status = 'queued' AND id NOT IN (${placeholders}) ORDER BY attempts, id LIMIT 1`
				)
				.get() as Row | undefined
			if (!row) return
			this.#running.add(row.id)
			this.#setStatus(row.id, 'matching')
			this.#process(row)
				.catch((err) => this.#fail(row, err))
				.finally(() => {
					this.#running.delete(row.id)
					this.#lastProgress.delete(row.id)
					this.#scheduleM3u(row.playlist_id)
					this.#pump()
				})
		}
	}

	async #process(row: Row) {
		const track = this.library.getTrack(row.track_id)
		let match = this.#match(row.track_id)
		// A provider was picked: look the track up there unless it's already matched to it.
		const rematch =
			row.provider &&
			(!match || !match.target || match.target.service !== row.provider || !['auto', 'accepted'].includes(match.status))

		if (!match || rematch) {
			const downloaders = row.provider ? [await this.accounts.downloader(row.provider)] : await this.accounts.downloaders()
			if (!downloaders.length) throw new Error('Conecta Qobuz o Deezer (o activa YouTube en Ajustes) para poder descargar')
			const res = await resolveTrack(track, downloaders, this.settings.get().autoAcceptThreshold)
			this.db
				.prepare(
					`INSERT INTO matches (track_id, status, target_service, target_id, target_url, target_meta, confidence, candidates, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(track_id) DO UPDATE SET status = excluded.status, target_service = excluded.target_service,
					   target_id = excluded.target_id, target_url = excluded.target_url, target_meta = excluded.target_meta,
					   confidence = excluded.confidence, candidates = excluded.candidates, updated_at = excluded.updated_at`
				)
				.run(
					row.track_id,
					res.status,
					res.target?.service ?? null,
					res.target?.id ?? null,
					res.target?.url ?? null,
					res.target ? JSON.stringify(res.target) : null,
					res.target?.score ?? null,
					JSON.stringify(res.candidates),
					now()
				)
			match = this.#match(row.track_id)!
		}

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
		// YouTube titles/channels are not real metadata: name and tag the file after the source track instead.
		const fromSource = (t: TargetTrack): TargetTrack =>
			target.service === 'youtube'
				? {
						...t,
						title: track.title,
						artists: track.artists,
						album: track.album,
						isrc: track.isrc,
						coverUrl: track.coverUrl ?? target.coverUrl
					}
				: t

		const existing = this.db
			.prepare('SELECT path, quality FROM files WHERE target_service = ? AND target_id = ?')
			.get(target.service, target.id) as { path: string; quality: string | null } | undefined
		if (existing && fs.existsSync(existing.path)) {
			const dest = nameFor(fromSource(target), path.extname(existing.path).slice(1))
			if (path.resolve(dest) !== path.resolve(existing.path)) {
				await fsp.rm(dest, { force: true })
				await fsp.link(existing.path, dest).catch(() => fsp.copyFile(existing.path, dest))
			}
			const quality = existing.quality ? (JSON.parse(existing.quality) as AudioQuality) : readFileQuality(dest)
			return this.#finish(row, dest, target.service, quality)
		}

		this.#setStatus(row.id, 'downloading')
		const downloader = await this.accounts.downloader(target.service)
		const got = await downloader.getTrack(target.url)
		const meta = fromSource(got.meta)
		const open = got.open
		const audio = await open()
		const dest = nameFor(meta, extensionFor(audio.mimeType))
		const part = `${dest}.part`
		let bytes = 0
		const counter = new Transform({
			transform: (chunk: Buffer, _enc, cb) => {
				bytes += chunk.length
				this.#progress(row.id, bytes, audio.sizeBytes ?? null)
				cb(null, chunk)
			}
		})
		try {
			await pipeline(audio.stream, counter, fs.createWriteStream(part))
			await fsp.rm(dest, { force: true })
			await fsp.rename(part, dest)
		} catch (err) {
			await fsp.rm(part, { force: true })
			throw err
		}

		try {
			const cover = await fetchCover(meta.coverUrl ?? target.coverUrl)
			writeTags(dest, { ...meta, coverUrl: meta.coverUrl ?? target.coverUrl }, cover)
		} catch (err) {
			// The audio is fine without tags; don't fail the download over it.
			console.warn(`[kemix] No se pudieron escribir tags en ${dest}: ${errorMessage(err)}`)
		}

		const quality = readFileQuality(dest)
		this.db
			.prepare(
				`INSERT INTO files (target_service, target_id, path, quality) VALUES (?, ?, ?, ?)
				 ON CONFLICT DO UPDATE SET path = excluded.path, quality = excluded.quality`
			)
			.run(target.service, target.id, dest, quality ? JSON.stringify(quality) : null)
		this.#finish(row, dest, target.service, quality)
	}

	#finish(row: Row, dest: string, service: DownloadService, quality: AudioQuality | null) {
		this.db
			.prepare(
				`UPDATE downloads SET status = 'done', path = ?, error = NULL, service = ?, quality = ?, updated_at = ? WHERE id = ?`
			)
			.run(dest, service, quality ? JSON.stringify(quality) : null, now(), row.id)
		this.#emitRow(row.id)
	}

	#fail(row: Row, err: unknown) {
		const attempts = row.attempts + 1
		const status: DownloadStatus = attempts < MAX_ATTEMPTS ? 'queued' : 'error'
		this.db
			.prepare('UPDATE downloads SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?')
			.run(status, attempts, errorMessage(err), now(), row.id)
		this.#emitRow(row.id)
	}

	#match(trackId: number) {
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
