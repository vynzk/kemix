import fs from 'node:fs'
import { tx, type Db } from './db'
import type { EventBus } from './events'
import type { Accounts } from './accounts'
import type {
	DownloadStatus,
	Folder,
	MatchCandidate,
	MatchStatus,
	PlaylistDetail,
	PlaylistSummary,
	PlaylistTrackRow,
	ReviewItem,
	SourcePlaylist,
	SourceService,
	SourceTrack,
	AudioQuality,
	DownloadService
} from './types'
import { SOURCE_SERVICES } from './types'
import { sourceVideo } from './sources/youtube'
import { sourceUpload } from './sources/soundcloud'
import { findInCatalog } from './match/resolve'
import { toTrackFeatures, type FeatureRow } from './features/analyzer'
import { errorMessage, now, SessionExpiredError } from './util'

const SERVICE_NAMES: Record<SourceService, string> = {
	spotify: 'Spotify',
	ytmusic: 'YouTube Music',
	qobuz: 'Qobuz',
	deezer: 'Deezer',
	soundcloud: 'SoundCloud'
}

interface PlaylistRow {
	id: number
	source: SourceService
	source_id: string
	name: string
	owner: string | null
	cover_url: string | null
	track_count: number | null
	snapshot: string | null
	tracks_snapshot: string | null
	folder_id: number | null
	position: number
	synced_at: number | null
	removed: number
}

export class Library {
	#syncing = false
	#syncAgain = false

	constructor(
		private db: Db,
		private accounts: Accounts,
		private events: EventBus
	) {}

	// ---------- sync ----------

	get syncing() {
		return this.#syncing
	}

	/** Refresh the playlist list of every connected source. Track lists are fetched lazily per playlist. */
	async syncAll(): Promise<void> {
		// A sync requested while one is running (e.g. an account was just connected) runs again right after.
		if (this.#syncing) {
			this.#syncAgain = true
			return
		}
		this.#syncing = true
		this.events.emit({ type: 'sync', state: 'start' })
		const errors: string[] = []
		const summary: string[] = []
		try {
			this.events.emit({ type: 'sync', state: 'progress', message: 'Revisando archivos descargados…' })
			const gone = this.checkFiles()
			if (gone) summary.push(`${gone} ${gone === 1 ? 'archivo ya no está' : 'archivos ya no están'} en el computador`)
			for (const service of SOURCE_SERVICES) {
				if (!this.accounts.isConnected(service)) continue
				const name = SERVICE_NAMES[service]
				this.events.emit({ type: 'sync', state: 'progress', message: `Leyendo playlists de ${name}…` })
				try {
					const playlists = await this.accounts.source(service).listPlaylists()
					this.#upsertPlaylists(service, playlists)
					summary.push(
						playlists.length
							? `${name}: ${playlists.length} playlists`
							: `${name}: no se encontró ninguna playlist en tu biblioteca`
					)
				} catch (err) {
					errors.push(`${name}: ${errorMessage(err)}`)
					this.accounts.reportError(service, err)
				}
				this.events.emit({ type: 'library' })
			}
		} finally {
			this.#syncing = false
			this.events.emit(
				errors.length
					? { type: 'sync', state: 'error', message: [...summary, ...errors].join('\n') }
					: { type: 'sync', state: 'done', message: summary.join('\n') || 'No hay cuentas conectadas' }
			)
		}
		if (this.#syncAgain) {
			this.#syncAgain = false
			await this.syncAll()
		}
	}

	#connected(service: SourceService) {
		if (!this.accounts.isConnected(service)) throw new Error(`${SERVICE_NAMES[service]} no está conectado`)
		return this.accounts.source(service)
	}

	/** Search a service's catalog (it must be connected). */
	async search(service: SourceService, query: string): Promise<SourceTrack[]> {
		const source = this.#connected(service)
		const q = query.trim()
		if (!q) return []
		try {
			return await source.search(q, 30)
		} catch (err) {
			throw new Error(`No se pudo buscar en ${SERVICE_NAMES[service]}: ${errorMessage(err)}`)
		}
	}

	/**
	 * Create a playlist in the user's account on `service` and bring it into the library.
	 * Returns its local id, or null if the service doesn't list it yet (it shows up on the next sync).
	 */
	async createPlaylist(service: SourceService, name: string, trackIds: string[]): Promise<{ playlistId: number | null }> {
		const source = this.#connected(service)
		const title = name.trim()
		if (!title) throw new Error('Ponle un nombre a la playlist')
		if (!trackIds.length) throw new Error('Agrega al menos un tema')
		let sourceId: string
		try {
			sourceId = await source.createPlaylist(title, trackIds)
		} catch (err) {
			// Mark the account as broken so Cuentas asks to reconnect it, as a failed sync does.
			if (err instanceof SessionExpiredError) this.accounts.reportError(service, err)
			throw new Error(`No se pudo crear la playlist en ${SERVICE_NAMES[service]}: ${errorMessage(err)}`)
		}
		const created: SourcePlaylist = { sourceId, name: title, trackCount: trackIds.length }
		let listed: SourcePlaylist[] | null = null
		try {
			listed = await source.listPlaylists()
		} catch {
			// Created anyway; it's added below and the next sync refreshes the rest.
		}
		// Some services (YouTube Music) take a while to list a new playlist: add it ourselves meanwhile.
		if (!listed) this.#upsertPlaylists(service, [created], { partial: true })
		else this.#upsertPlaylists(service, listed.some((p) => p.sourceId === sourceId) ? listed : [...listed, created])
		this.events.emit({ type: 'library' })
		const row = this.db.prepare('SELECT id FROM playlists WHERE source = ? AND source_id = ?').get(service, sourceId) as
			| { id: number }
			| undefined
		return { playlistId: row?.id ?? null }
	}

	/**
	 * Create a playlist on `to` with tracks found on another service (SoundCloud doesn't let other apps create
	 * playlists): each track is looked up in `to`'s catalog, and the ones it doesn't have are left out and returned.
	 */
	async copyPlaylist(
		to: SourceService,
		name: string,
		tracks: SourceTrack[]
	): Promise<{ playlistId: number | null; added: number; missing: SourceTrack[] }> {
		const target = this.#connected(to)
		if (!name.trim()) throw new Error('Ponle un nombre a la playlist')
		if (!tracks.length) throw new Error('Agrega al menos un tema')
		const ids: string[] = []
		const missing: SourceTrack[] = []
		const failures: string[] = []
		for (const track of tracks) {
			try {
				const found = await findInCatalog(track, (q) => target.search(q, 10))
				if (found) ids.push(found.sourceId)
				else missing.push(track)
			} catch (err) {
				missing.push(track)
				failures.push(errorMessage(err))
			}
		}
		if (!ids.length) {
			if (failures.length) throw new Error(`No se pudo buscar en ${SERVICE_NAMES[to]}: ${failures[0]}`)
			throw new Error(`Ninguno de los temas está en ${SERVICE_NAMES[to]}`)
		}
		// The same song picked twice (two uploads of it) goes in once.
		const unique = [...new Set(ids)]
		const res = await this.createPlaylist(to, name, unique)
		return { ...res, added: unique.length, missing }
	}

	/**
	 * With `partial`, `playlists` isn't the whole list, so the ones missing from it aren't flagged as removed.
	 * A playlist listed without a size keeps the last one known (e.g. counted when its tracks were read).
	 */
	#upsertPlaylists(source: SourceService, playlists: SourcePlaylist[], opts: { partial?: boolean } = {}) {
		tx(this.db, () => {
			const upsert = this.db.prepare(
				`INSERT INTO playlists (source, source_id, name, owner, cover_url, track_count, snapshot, synced_at, removed)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
				 ON CONFLICT(source, source_id) DO UPDATE SET
				   name = excluded.name, owner = excluded.owner, cover_url = excluded.cover_url,
				   track_count = COALESCE(excluded.track_count, playlists.track_count), snapshot = excluded.snapshot,
				   synced_at = excluded.synced_at, removed = 0`
			)
			const t = now()
			for (const p of playlists) {
				upsert.run(source, p.sourceId, p.name, p.owner ?? null, p.coverUrl ?? null, p.trackCount ?? null, p.snapshot ?? null, t)
			}
			if (opts.partial) return
			// Playlists that disappeared from the service are flagged, not deleted: they may hold downloads/folders.
			const ids = new Set(playlists.map((p) => p.sourceId))
			const existing = this.db.prepare('SELECT id, source_id FROM playlists WHERE source = ?').all(source) as {
				id: number
				source_id: string
			}[]
			const flag = this.db.prepare('UPDATE playlists SET removed = 1 WHERE id = ?')
			for (const row of existing) if (!ids.has(row.source_id)) flag.run(row.id)
		})
	}

	/** Fetch a playlist's tracks if they changed since the last fetch (or always, with force). */
	async syncPlaylistTracks(playlistId: number, force = false): Promise<void> {
		const p = this.#playlist(playlistId)
		const hasTracks = !!this.db.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id = ? LIMIT 1').get(playlistId)
		if (!force && hasTracks && p.snapshot && p.snapshot === p.tracks_snapshot) return
		let tracks: SourceTrack[]
		try {
			tracks = await this.accounts.source(p.source).getPlaylistTracks(p.source_id)
		} catch (err) {
			throw new Error(`No se pudieron leer los temas de "${p.name}": ${errorMessage(err)}`)
		}
		tx(this.db, () => {
			const upsert = this.db.prepare(
				`INSERT INTO tracks (source, source_id, title, artists, album, duration_ms, isrc, cover_url, url)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(source, source_id) DO UPDATE SET
				   title = excluded.title, artists = excluded.artists, album = excluded.album,
				   duration_ms = excluded.duration_ms, isrc = COALESCE(excluded.isrc, tracks.isrc),
				   cover_url = excluded.cover_url, url = excluded.url
				 RETURNING id`
			)
			this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId)
			const link = this.db.prepare('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)')
			tracks.forEach((t, i) => {
				const { id } = upsert.get(
					p.source,
					t.sourceId,
					t.title,
					JSON.stringify(t.artists),
					t.album ?? null,
					t.durationMs ?? null,
					t.isrc ?? null,
					t.coverUrl ?? null,
					t.url ?? null
				) as { id: number }
				link.run(playlistId, i, id)
			})
			this.db
				.prepare('UPDATE playlists SET tracks_snapshot = snapshot, track_count = ? WHERE id = ?')
				.run(tracks.length, playlistId)
			// Download rows point at positions; drop the ones that no longer match the new order.
			// Finished files stay registered in `files`, so re-queuing them is just a local link/copy.
			this.db
				.prepare(
					`DELETE FROM downloads WHERE playlist_id = ? AND NOT EXISTS (
					   SELECT 1 FROM playlist_tracks pt
					   WHERE pt.playlist_id = downloads.playlist_id AND pt.position = downloads.position AND pt.track_id = downloads.track_id)`
				)
				.run(playlistId)
		})
		this.events.emit({ type: 'playlist', playlistId })
	}

	/**
	 * Forget finished downloads whose file was deleted or moved, so those tracks show as pending again.
	 * Returns how many downloads were affected.
	 */
	checkFiles(playlistId?: number): number {
		const done = this.db
			.prepare(
				`SELECT id, playlist_id, path FROM downloads WHERE status = 'done'${playlistId === undefined ? '' : ' AND playlist_id = ?'}`
			)
			.all(...(playlistId === undefined ? [] : [playlistId])) as { id: number; playlist_id: number; path: string | null }[]
		const gone = done.filter((d) => !d.path || !fs.existsSync(d.path))
		// The shared file registry is only swept on a full scan; the queue re-checks it before reusing a file anyway.
		const files =
			playlistId === undefined
				? (this.db.prepare('SELECT rowid AS id, path FROM files').all() as { id: number; path: string }[])
				: []
		const goneFiles = files.filter((f) => !fs.existsSync(f.path))
		if (!gone.length && !goneFiles.length) return 0
		tx(this.db, () => {
			const del = this.db.prepare('DELETE FROM downloads WHERE id = ?')
			for (const d of gone) del.run(d.id)
			const delFile = this.db.prepare('DELETE FROM files WHERE rowid = ?')
			for (const f of goneFiles) delFile.run(f.id)
		})
		for (const id of new Set(gone.map((d) => d.playlist_id))) this.events.emit({ type: 'playlist', playlistId: id })
		if (gone.length) this.events.emit({ type: 'library' })
		return gone.length
	}

	#playlist(id: number): PlaylistRow {
		const p = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as PlaylistRow | undefined
		if (!p) throw new Error('Playlist no encontrada')
		return p
	}

	// ---------- queries ----------

	listPlaylists(): PlaylistSummary[] {
		const rows = this.db.prepare('SELECT * FROM playlists ORDER BY position, name COLLATE NOCASE').all() as unknown as PlaylistRow[]
		const stats = this.db
			.prepare(
				`SELECT playlist_id,
				   SUM(status = 'done') AS done, COUNT(*) AS total, SUM(status = 'error') AS error,
				   SUM(status = 'needs_review') AS review,
				   SUM(status IN ('queued', 'matching', 'downloading')) AS active
				 FROM downloads GROUP BY playlist_id`
			)
			.all() as { playlist_id: number; done: number; total: number; error: number; review: number; active: number }[]
		const byId = new Map(stats.map((s) => [s.playlist_id, s]))
		return rows.map((r) => this.#summary(r, byId.get(r.id)))
	}

	#summary(
		r: PlaylistRow,
		s?: { done: number; total: number; error: number; review: number; active: number }
	): PlaylistSummary {
		return {
			id: r.id,
			source: r.source,
			sourceId: r.source_id,
			name: r.name,
			owner: r.owner,
			coverUrl: r.cover_url,
			trackCount: r.track_count,
			folderId: r.folder_id,
			position: r.position,
			syncedAt: r.synced_at,
			removed: !!r.removed,
			downloads: {
				done: s?.done ?? 0,
				total: s?.total ?? 0,
				error: s?.error ?? 0,
				review: s?.review ?? 0,
				active: s?.active ?? 0
			}
		}
	}

	async getPlaylist(id: number): Promise<PlaylistDetail> {
		await this.syncPlaylistTracks(id)
		this.checkFiles(id)
		const summary = this.listPlaylists().find((p) => p.id === id)!
		const rows = this.db
			.prepare(
				`SELECT pt.position, t.id AS track_id, t.title, t.artists, t.album, t.duration_ms, t.isrc,
				   m.status AS m_status, m.target_service, m.target_url, m.confidence, m.target_meta,
				   d.id AS d_id, d.status AS d_status, d.error AS d_error, d.path AS d_path, d.quality AS d_quality, d.service AS d_service,
				   f.status AS f_status, f.bpm, f.bpm_source, f.key_tonic, f.key_minor, f.key_source, f.error AS f_error
				 FROM playlist_tracks pt
				 JOIN tracks t ON t.id = pt.track_id
				 LEFT JOIN matches m ON m.track_id = t.id
				 LEFT JOIN downloads d ON d.playlist_id = pt.playlist_id AND d.position = pt.position
				 LEFT JOIN track_features f ON f.track_id = t.id
				 WHERE pt.playlist_id = ?
				 ORDER BY pt.position`
			)
			.all(id) as ({
			position: number
			track_id: number
			title: string
			artists: string
			album: string | null
			duration_ms: number | null
			isrc: string | null
			m_status: MatchStatus | null
			target_service: DownloadService | null
			target_url: string | null
			confidence: number | null
			target_meta: string | null
			d_id: number | null
			d_status: DownloadStatus | null
			d_error: string | null
			d_path: string | null
			d_quality: string | null
			d_service: DownloadService | null
			f_status: FeatureRow['status'] | null
			f_error: string | null
		} & Omit<FeatureRow, 'status' | 'error'>)[]
		const tracks: PlaylistTrackRow[] = rows.map((r) => ({
			position: r.position,
			trackId: r.track_id,
			title: r.title,
			artists: JSON.parse(r.artists),
			album: r.album,
			durationMs: r.duration_ms,
			isrc: r.isrc,
			match: r.m_status
				? {
						status: r.m_status,
						targetService: r.target_service,
						targetUrl: r.target_url,
						confidence: r.confidence,
						maxQuality: r.target_meta ? ((JSON.parse(r.target_meta) as MatchCandidate).maxQuality ?? null) : null
					}
				: null,
			download: r.d_status
				? {
						id: r.d_id!,
						status: r.d_status,
						error: r.d_error,
						path: r.d_path,
						quality: r.d_quality ? (JSON.parse(r.d_quality) as AudioQuality) : null,
						service: r.d_service
					}
				: null,
			features: r.f_status ? toTrackFeatures({ ...r, status: r.f_status, error: r.f_error }) : null
		}))
		return { ...summary, tracks }
	}

	// ---------- folders ----------

	listFolders(): Folder[] {
		return (
			this.db.prepare('SELECT id, name, parent_id, position FROM folders ORDER BY position, name COLLATE NOCASE').all() as {
				id: number
				name: string
				parent_id: number | null
				position: number
			}[]
		).map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, position: f.position }))
	}

	createFolder(name: string, parentId: number | null): Folder {
		const clean = name.trim() || 'Nueva carpeta'
		if (parentId !== null) this.#folder(parentId)
		const { pos } = this.db
			.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM folders WHERE parent_id IS ?')
			.get(parentId) as { pos: number }
		const { id } = this.db
			.prepare('INSERT INTO folders (name, parent_id, position) VALUES (?, ?, ?) RETURNING id')
			.get(clean, parentId, pos) as { id: number }
		this.events.emit({ type: 'library' })
		return { id, name: clean, parentId, position: pos }
	}

	updateFolder(id: number, patch: { name?: string; parentId?: number | null }) {
		this.#folder(id)
		if (patch.name !== undefined) {
			this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(patch.name.trim() || 'Sin nombre', id)
		}
		if (patch.parentId !== undefined) {
			if (patch.parentId !== null && this.#isDescendant(patch.parentId, id)) {
				throw new Error('No puedes mover una carpeta dentro de sí misma')
			}
			this.db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(patch.parentId, id)
		}
		this.events.emit({ type: 'library' })
	}

	/** Delete a folder; its playlists and subfolders move up to the parent instead of being lost. */
	deleteFolder(id: number) {
		const f = this.#folder(id)
		tx(this.db, () => {
			this.db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(f.parent_id, id)
			this.db.prepare('UPDATE playlists SET folder_id = ? WHERE folder_id = ?').run(f.parent_id, id)
			this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
		})
		this.events.emit({ type: 'library' })
	}

	movePlaylist(playlistId: number, folderId: number | null) {
		this.#playlist(playlistId)
		if (folderId !== null) this.#folder(folderId)
		this.db.prepare('UPDATE playlists SET folder_id = ? WHERE id = ?').run(folderId, playlistId)
		this.events.emit({ type: 'library' })
	}

	#folder(id: number) {
		const f = this.db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(id) as
			| { id: number; parent_id: number | null }
			| undefined
		if (!f) throw new Error('Carpeta no encontrada')
		return f
	}

	/** True if `candidate` is `ancestor` itself or lives somewhere below it. */
	#isDescendant(candidate: number, ancestor: number): boolean {
		for (let cur: number | null = candidate; cur !== null; ) {
			if (cur === ancestor) return true
			cur = (this.db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur) as { parent_id: number | null } | undefined)
				?.parent_id ?? null
		}
		return false
	}

	// ---------- review ----------

	listReview(): ReviewItem[] {
		const rows = this.db
			.prepare(
				`SELECT t.id, t.title, t.artists, t.album, t.duration_ms, t.source, t.source_id, t.cover_url, t.url, m.candidates, m.status,
				   (SELECT json_group_array(DISTINCT p.name) FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id
				    WHERE pt.track_id = t.id) AS playlists,
				   f.status AS f_status, f.bpm, f.bpm_source, f.key_tonic, f.key_minor, f.key_source, f.error AS f_error
				 FROM matches m JOIN tracks t ON t.id = m.track_id
				 LEFT JOIN track_features f ON f.track_id = t.id
				 WHERE m.status IN ('pending', 'notfound')
				   AND EXISTS (SELECT 1 FROM downloads d WHERE d.track_id = t.id AND d.status = 'needs_review')
				 ORDER BY t.id`
			)
			.all() as ({
			id: number
			title: string
			artists: string
			album: string | null
			duration_ms: number | null
			source: SourceService
			source_id: string
			cover_url: string | null
			url: string | null
			candidates: string | null
			status: MatchStatus
			playlists: string
			f_status: FeatureRow['status'] | null
			f_error: string | null
		} & Omit<FeatureRow, 'status' | 'error'>)[]
		return rows.map((r) => {
			const artists = JSON.parse(r.artists) as string[]
			let candidates = r.candidates ? (JSON.parse(r.candidates) as MatchCandidate[]) : []
			// A YouTube Music track is a video already, and a SoundCloud one an upload: always offer that exact one
			// (lossy), on top. Added here rather than when matching so it shows even when YouTube/SoundCloud aren't
			// among the download services.
			const track = {
				source: r.source,
				sourceId: r.source_id,
				title: r.title,
				artists,
				album: r.album ?? undefined,
				durationMs: r.duration_ms ?? undefined,
				coverUrl: r.cover_url ?? undefined,
				url: r.url ?? undefined
			}
			const own = sourceVideo(track) ?? sourceUpload(track)
			if (own) {
				candidates = [{ ...own, score: 1 }, ...candidates.filter((c) => !(c.service === own.service && c.id === own.id))]
			}
			return {
				trackId: r.id,
				title: r.title,
				artists,
				album: r.album,
				durationMs: r.duration_ms,
				source: r.source,
				playlists: JSON.parse(r.playlists),
				candidates,
				notFound: r.status === 'notfound',
				features: r.f_status ? toTrackFeatures({ ...r, status: r.f_status, error: r.f_error }) : null
			}
		})
	}

	getTrack(trackId: number) {
		const t = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId) as
			| {
					id: number
					source: SourceService
					source_id: string
					title: string
					artists: string
					album: string | null
					duration_ms: number | null
					isrc: string | null
					cover_url: string | null
					url: string | null
			  }
			| undefined
		if (!t) throw new Error('Tema no encontrado')
		return {
			id: t.id,
			source: t.source,
			sourceId: t.source_id,
			title: t.title,
			artists: JSON.parse(t.artists) as string[],
			album: t.album ?? undefined,
			durationMs: t.duration_ms ?? undefined,
			isrc: t.isrc ?? undefined,
			coverUrl: t.cover_url ?? undefined,
			url: t.url ?? undefined
		}
	}
}
