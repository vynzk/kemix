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
import type { DownloadRow, DownloadStatus, MatchCandidate, TargetTrack } from '../types'
import { resolveTrack } from '../match/resolve'
import { scoreMatch, searchQuery } from '../match/score'
import { extensionFor, playlistDir, trackFileName } from './paths'
import { fetchCover, writeM3u, writeTags } from './tagger'
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
}

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

	async enqueuePlaylist(playlistId: number) {
		await this.library.syncPlaylistTracks(playlistId)
		const t = now()
		tx(this.db, () => {
			this.db
				.prepare(
					`INSERT INTO downloads (playlist_id, position, track_id, status, updated_at)
					 SELECT playlist_id, position, track_id, 'queued', ? FROM playlist_tracks WHERE playlist_id = ?
					 ON CONFLICT(playlist_id, position) DO UPDATE SET
					   status = CASE WHEN downloads.status = 'error' THEN 'queued' ELSE downloads.status END,
					   attempts = CASE WHEN downloads.status = 'error' THEN 0 ELSE downloads.attempts END,
					   updated_at = excluded.updated_at`
				)
				.run(t, playlistId)
			// Files deleted from disk since the last run get downloaded again.
			const done = this.db
				.prepare(`SELECT id, path FROM downloads WHERE playlist_id = ? AND status = 'done'`)
				.all(playlistId) as { id: number; path: string | null }[]
			const requeue = this.db.prepare(`UPDATE downloads SET status = 'queued', attempts = 0 WHERE id = ?`)
			for (const d of done) if (!d.path || !fs.existsSync(d.path)) requeue.run(d.id)
		})
		this.events.emit({ type: 'playlist', playlistId })
		this.events.emit({ type: 'library' })
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

	acceptCandidate(trackId: number, candidate: MatchCandidate) {
		this.db
			.prepare(
				`UPDATE matches SET status = 'accepted', target_service = ?, target_id = ?, target_url = ?, target_meta = ?,
				   confidence = ?, updated_at = ? WHERE track_id = ?`
			)
			.run(candidate.service, candidate.id, candidate.url, JSON.stringify(candidate), candidate.score, now(), trackId)
		this.db
			.prepare(`UPDATE downloads SET status = 'queued', attempts = 0, error = NULL WHERE track_id = ? AND status = 'needs_review'`)
			.run(trackId)
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
					`SELECT id, playlist_id, position, track_id, status, attempts FROM downloads
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

		if (!match) {
			const downloaders = await this.accounts.downloaders()
			if (!downloaders.length) throw new Error('Conecta Qobuz o Deezer para poder descargar')
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
		const existing = this.db
			.prepare('SELECT path FROM files WHERE target_service = ? AND target_id = ?')
			.get(target.service, target.id) as { path: string } | undefined
		if (existing && fs.existsSync(existing.path)) {
			const dest = nameFor(target, path.extname(existing.path).slice(1))
			if (path.resolve(dest) !== path.resolve(existing.path)) {
				await fsp.rm(dest, { force: true })
				await fsp.link(existing.path, dest).catch(() => fsp.copyFile(existing.path, dest))
			}
			return this.#finish(row, dest)
		}

		this.#setStatus(row.id, 'downloading')
		const downloader = await this.accounts.downloader(target.service)
		const { meta, open } = await downloader.getTrack(target.url)
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

		this.db
			.prepare(
				'INSERT INTO files (target_service, target_id, path) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET path = excluded.path'
			)
			.run(target.service, target.id, dest)
		this.#finish(row, dest)
	}

	#finish(row: Row, dest: string) {
		this.db
			.prepare(`UPDATE downloads SET status = 'done', path = ?, error = NULL, updated_at = ? WHERE id = ?`)
			.run(dest, now(), row.id)
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
	d.bytes, d.total_bytes, d.updated_at
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
		updatedAt: r.updated_at
	}
}
