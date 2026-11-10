import fs from 'node:fs'
import type { Db } from '../db'
import type { EventBus } from '../events'
import type { Library } from '../library'
import type { SettingsStore } from '../settings'
import type { FeatureSource, MatchCandidate, MusicalKey, ScanState, SourceTrack, TrackFeatures } from '../types'
import type { AudioDecoder } from '../download/ffmpeg'
import { readKeyBpm, writeKeyBpm } from '../download/tagger'
import { errorMessage, now } from '../util'
import { ANALYSIS_RATE } from './dsp'
import { keyTag, parseKey } from './key'
import { ApiKeyError, FeatureSources } from './lookup'
import { estimateKey } from './tonality'
import { estimateTempo } from './tempo'

/** The most of a file that is analyzed: plenty for any track, and bounded memory for hour-long sets. */
const MAX_SECONDS = 600
/** Tracks outside the library whose BPM and key are kept in memory. */
const CACHE_SIZE = 5000

export type IsrcFinder = (track: SourceTrack, minScore: number) => Promise<{ isrc: string; score: number } | null>

interface Job {
	state: ScanState
	abort: AbortController
}

/** A track being worked on: what identifies it elsewhere, and what's been found so far. */
interface Work {
	trackId: number
	track: SourceTrack
	isrc?: string
	deezerId?: string
	/** The downloaded file, if there's one on disk. */
	file?: string
	bpm?: { value: number; source: FeatureSource }
	key?: { value: MusicalKey; source: FeatureSource }
	error?: string
}

export interface FeatureRow {
	bpm: number | null
	bpm_source: FeatureSource | null
	key_tonic: number | null
	key_minor: number | null
	key_source: FeatureSource | null
	status: TrackFeatures['status']
	error: string | null
}

export function toTrackFeatures(r: FeatureRow): TrackFeatures {
	return {
		bpm: r.bpm,
		bpmSource: r.bpm_source,
		key: r.key_tonic === null ? null : { tonic: r.key_tonic, minor: !!r.key_minor },
		keySource: r.key_source,
		status: r.status,
		error: r.error
	}
}

const complete = (w: Work) => !!w.bpm && !!w.key

/**
 * BPM and key of library tracks. Each one is taken, field by field, from the first place that has it: the downloaded
 * file's tags, GetSongBPM (with the user's API key), Deezer (BPM); failing those, Kemix analyzes the audio, the
 * downloaded file or else Deezer's 30-second preview; and when there's no audio to analyze, AcousticBrainz.
 * AcousticBrainz comes last on purpose: on songs with well-known keys its keys were right less often (12 of 26) than
 * Kemix's own analysis of a mere preview (17 of 30). Results are stored per track and, when there's a file, written
 * into its tags.
 *
 * Playlists are looked up as background jobs reported as `features` events, the same way the quality scan is.
 */
export class FeatureAnalyzer {
	#jobs = new Map<number, Job>()
	/** Analyses run one at a time: they're CPU-bound and share the process with everything else. */
	#cpu: Promise<unknown> = Promise.resolve()
	/** Downloaded tracks waiting to be analyzed from their file. */
	#downloaded = new Set<number>()
	#draining = false
	#stopped = new AbortController()
	/** BPM and key of tracks outside the library, by ISRC (or service and id), most recent last. */
	#cache = new Map<string, TrackFeatures>()
	/** The running batch of lookups for tracks outside the library, per screen. */
	#groups = new Map<string, AbortController>()

	constructor(
		private db: Db,
		private library: Library,
		private settings: SettingsStore,
		private events: EventBus,
		private decoder: AudioDecoder,
		private findIsrc: IsrcFinder,
		private sources = new FeatureSources()
	) {}

	/** The playlist's running job, or the last one's result; null if none ran since the app started. */
	state(playlistId: number): ScanState | null {
		const s = this.#jobs.get(playlistId)?.state
		return s ? { ...s } : null
	}

	features(trackId: number): TrackFeatures | null {
		const r = this.db.prepare('SELECT * FROM track_features WHERE track_id = ?').get(trackId) as FeatureRow | undefined
		return r ? toTrackFeatures(r) : null
	}

	/**
	 * BPM and key of tracks outside the library (search results, review options), looked up like library tracks but
	 * kept in memory for this run instead of stored. Answers at once with what's already known (from earlier lookups,
	 * or a library track with the same ISRC) and null for the rest, which are looked up in the background, in order,
	 * each reported as a `track-features` event.
	 * A new batch for the same `group` (one per screen: the search page, a review item) stops what's left of the
	 * previous one, so a new search doesn't wait behind the old results.
	 */
	lookupTracks(items: { service: string; track: SourceTrack }[], group: string): (TrackFeatures | null)[] {
		this.#groups.get(group)?.abort()
		const abort = new AbortController()
		this.#groups.set(group, abort)
		const signal = AbortSignal.any([abort.signal, this.#stopped.signal])
		return items.map(({ service, track }) => {
			const known = this.#known(service, track)
			if (known) return known
			void this.#lookupOne(service, track, signal)
				.then((features) => {
					if (features.status !== 'error') this.#remember(this.#cacheKey(service, track), features)
					this.events.emit({ type: 'track-features', service, sourceId: track.sourceId, features })
				})
				.catch(() => {
					// Stopped by a newer batch: whoever asked has moved on.
				})
			return null
		})
	}

	#cacheKey(service: string, track: SourceTrack) {
		return track.isrc ? `isrc:${track.isrc.toUpperCase()}` : `${service}:${track.sourceId}`
	}

	/** What's already known about a track outside the library: looked up before, or a library track with its ISRC. */
	#known(service: string, track: SourceTrack): TrackFeatures | null {
		const cached = this.#cache.get(this.#cacheKey(service, track))
		if (cached) return cached
		if (!track.isrc) return null
		const r = this.db
			.prepare(
				`SELECT f.* FROM track_features f JOIN tracks t ON t.id = f.track_id
				 WHERE upper(t.isrc) = ? AND f.bpm IS NOT NULL AND f.key_tonic IS NOT NULL
				 ORDER BY f.key_source = 'preview', f.bpm_source = 'preview' LIMIT 1`
			)
			.get(track.isrc.toUpperCase()) as FeatureRow | undefined
		return r ? toTrackFeatures(r) : null
	}

	#remember(key: string, features: TrackFeatures) {
		this.#cache.delete(key)
		this.#cache.set(key, features)
		// Oldest first: a Map keeps insertion order.
		while (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!)
	}

	async #lookupOne(service: string, track: SourceTrack, signal: AbortSignal): Promise<TrackFeatures> {
		const w: Work = {
			trackId: -1,
			track,
			isrc: track.isrc?.toUpperCase(),
			deezerId: service === 'deezer' ? track.sourceId : undefined
		}
		await this.#lookup([w], signal)
		if (!complete(w)) await this.#analyze(w, signal)
		if (!complete(w)) await this.#acousticBrainz([w], signal)
		signal.throwIfAborted()
		return this.#result(w)
	}

	/**
	 * Look up a playlist's tracks: the given positions (again, from scratch), or every track still missing its BPM or
	 * key. Runs in the background; returns the job's state.
	 */
	async analyzePlaylist(playlistId: number, positions?: number[]): Promise<ScanState> {
		const running = this.#jobs.get(playlistId)
		if (running?.state.running) return { ...running.state }
		await this.library.syncPlaylistTracks(playlistId)
		const only = positions?.filter((p) => Number.isInteger(p))
		const rows = only
			? (this.db
					.prepare(
						`SELECT DISTINCT track_id FROM playlist_tracks
						 WHERE playlist_id = ? AND position IN (${only.join(',') || '-1'}) ORDER BY position`
					)
					.all(playlistId) as { track_id: number }[])
			: (this.db
					.prepare(
						`SELECT DISTINCT pt.track_id FROM playlist_tracks pt
						 LEFT JOIN track_features f ON f.track_id = pt.track_id
						 WHERE pt.playlist_id = ?
						   AND (f.track_id IS NULL OR f.status != 'done' OR f.bpm IS NULL OR f.key_tonic IS NULL)
						 ORDER BY pt.position`
					)
					.all(playlistId) as { track_id: number }[])
		return this.#start(
			playlistId,
			rows.map((r) => r.track_id),
			!!only
		)
	}

	/**
	 * Look up the playlist's tracks that were never looked up, if there are any and nothing is running for it. Called
	 * whenever a playlist is opened (its tracks already read), so it has to be cheap when there's nothing to do.
	 */
	autoPlaylist(playlistId: number) {
		if (this.#stopped.signal.aborted || this.#jobs.get(playlistId)?.state.running) return
		const rows = this.db
			.prepare(
				`SELECT DISTINCT pt.track_id FROM playlist_tracks pt
				 LEFT JOIN track_features f ON f.track_id = pt.track_id
				 WHERE pt.playlist_id = ? AND f.track_id IS NULL ORDER BY pt.position`
			)
			.all(playlistId) as { track_id: number }[]
		if (rows.length) this.#start(playlistId, rows.map((r) => r.track_id), false)
	}

	/**
	 * A track finished downloading: analyze it from the whole file if its BPM or key is missing or came from a preview,
	 * and write them into the file's tags.
	 */
	trackDownloaded(trackId: number) {
		if (this.#stopped.signal.aborted) return
		this.#downloaded.add(trackId)
		void this.#drain()
	}

	/** Stop everything (on shutdown). */
	stop() {
		this.#stopped.abort()
		for (const j of this.#jobs.values()) j.abort.abort()
	}

	/** Resolves once nothing is running (tests). */
	async idle() {
		for (;;) {
			const running = [...this.#jobs.values()].some((j) => j.state.running)
			if (!running && !this.#draining && !this.#downloaded.size) return
			await new Promise((r) => setTimeout(r, 10))
		}
	}

	#start(playlistId: number, trackIds: number[], force: boolean): ScanState {
		const job: Job = {
			state: { playlistId, running: true, done: 0, total: trackIds.length, failed: 0, error: null },
			abort: new AbortController()
		}
		this.#jobs.set(playlistId, job)
		this.#emitState(job)
		void this.#run(job, trackIds, force)
		return { ...job.state }
	}

	#emitState(job: Job) {
		this.events.emit({ type: 'features', scan: { ...job.state } })
	}

	async #run(job: Job, trackIds: number[], force: boolean) {
		const { state, abort } = job
		const signal = abort.signal
		const finish = (w: Work) => {
			this.#save(w)
			this.#writeTags(w)
			state.done++
			if (w.error && !w.bpm && !w.key) state.failed++
			this.#emitState(job)
			this.events.emit({ type: 'playlist', playlistId: state.playlistId })
		}
		try {
			const works: Work[] = []
			for (const id of trackIds) {
				try {
					works.push(this.#work(id, force))
				} catch {
					// Removed from the library meanwhile.
					state.total--
				}
			}
			await this.#lookup(
				works,
				signal,
				(w) => {
					if (complete(w)) finish(w)
					// Show what there is already; the rest comes after the analysis.
					else if (w.bpm || w.key) this.#save(w)
				},
				(err) => {
					state.error ??= errorMessage(err)
					this.#emitState(job)
				}
			)
			const unanalyzed: Work[] = []
			for (const w of works) {
				if (complete(w)) continue
				signal.throwIfAborted()
				await this.#analyze(w, signal)
				if (complete(w)) finish(w)
				else unanalyzed.push(w)
			}
			// No audio to analyze (or nothing came out of it): AcousticBrainz, all at once.
			await this.#acousticBrainz(unanalyzed, signal)
			for (const w of unanalyzed) finish(w)
		} catch (err) {
			if (signal.aborted) return
			state.error ??= errorMessage(err)
		}
		if (signal.aborted) return
		state.running = false
		this.#emitState(job)
		this.events.emit({ type: 'playlist', playlistId: state.playlistId })
	}

	async #drain() {
		if (this.#draining) return
		this.#draining = true
		const signal = this.#stopped.signal
		try {
			while (this.#downloaded.size && !signal.aborted) {
				const trackId = this.#downloaded.values().next().value!
				this.#downloaded.delete(trackId)
				try {
					await this.#afterDownload(trackId, signal)
				} catch (err) {
					if (!signal.aborted) console.warn(`[kemix] No se pudo analizar la clave y el BPM: ${errorMessage(err)}`)
				}
			}
		} finally {
			this.#draining = false
		}
	}

	async #afterDownload(trackId: number, signal: AbortSignal) {
		const known = this.features(trackId)
		// Values from a preview are dropped here, since there's the whole file now.
		const w = this.#work(trackId, false)
		if (!w.file) return
		if (!complete(w)) {
			if (!known) await this.#lookup([w], signal)
			if (!complete(w)) await this.#analyze(w, signal)
			if (!complete(w)) await this.#acousticBrainz([w], signal)
		}
		this.#save(w)
		this.#writeTags(w)
		const playlists = this.db
			.prepare('SELECT DISTINCT playlist_id FROM playlist_tracks WHERE track_id = ?')
			.all(trackId) as { playlist_id: number }[]
		for (const p of playlists) this.events.emit({ type: 'playlist', playlistId: p.playlist_id })
	}

	/** What's known about a track. Without `force`, the stored BPM and key are kept (those from a preview only while there's no file). */
	#work(trackId: number, force: boolean): Work {
		const track = this.library.getTrack(trackId)
		const m = this.db.prepare('SELECT target_meta FROM matches WHERE track_id = ?').get(trackId) as
			| { target_meta: string | null }
			| undefined
		const target = m?.target_meta ? (JSON.parse(m.target_meta) as MatchCandidate) : null
		const file = this.#files(trackId)[0]
		const w: Work = {
			trackId,
			track,
			isrc: (track.isrc ?? target?.isrc)?.toUpperCase(),
			deezerId: track.source === 'deezer' ? track.sourceId : target?.service === 'deezer' ? target.id : undefined,
			file
		}
		if (force) return w
		const f = this.features(trackId)
		const keep = (source: FeatureSource | null) => !!source && !(file && source === 'preview')
		if (f?.bpm != null && keep(f.bpmSource)) w.bpm = { value: f.bpm, source: f.bpmSource! }
		if (f?.key && keep(f.keySource)) w.key = { value: f.key, source: f.keySource! }
		return w
	}

	/** Downloaded files of a track that are still on disk. */
	#files(trackId: number): string[] {
		const rows = this.db
			.prepare(`SELECT DISTINCT path FROM downloads WHERE track_id = ? AND status = 'done' AND path IS NOT NULL`)
			.all(trackId) as { path: string }[]
		return rows.map((r) => r.path).filter((p) => fs.existsSync(p))
	}

	/**
	 * Fill in BPM and key from the file's tags, GetSongBPM and Deezer, in order of preference: each source only fills
	 * what's still missing. `onTrack` is called for each track once they're done with it.
	 */
	async #lookup(
		works: Work[],
		signal: AbortSignal,
		onTrack: (w: Work) => void = () => {},
		onError: (err: unknown) => void = () => {}
	) {
		const settings = this.settings.get()
		const threshold = settings.autoAcceptThreshold
		let apiKey = settings.getSongBpmKey
		const missing = (w: Work) => !complete(w)
		const fail = (w: Work, err: unknown) => {
			w.error ??= errorMessage(err)
		}

		for (const w of works) {
			signal.throwIfAborted()
			if (w.file && missing(w)) {
				const tags = readKeyBpm(w.file)
				if (!w.bpm && tags.bpm) w.bpm = { value: tags.bpm, source: 'tags' }
				const key = parseKey(tags.key)
				if (!w.key && key) w.key = { value: key, source: 'tags' }
			}
			if (missing(w) && apiKey) {
				try {
					const found = await this.sources.getSongBpm(apiKey, w.track, threshold)
					if (!w.bpm && found?.bpm) w.bpm = { value: found.bpm, source: 'getsongbpm' }
					if (!w.key && found?.key) w.key = { value: found.key, source: 'getsongbpm' }
				} catch (err) {
					if (err instanceof ApiKeyError) {
						apiKey = ''
						onError(err)
					} else fail(w, err)
				}
			}
			signal.throwIfAborted()
			if (missing(w) && !w.isrc && !w.deezerId) {
				try {
					w.isrc = (await this.sources.deezer.run(() => this.findIsrc(w.track, threshold)))?.isrc
				} catch (err) {
					fail(w, err)
				}
			}
			signal.throwIfAborted()
			// Deezer's BPM; and the ISRC (for AcousticBrainz, later) when only the Deezer id was known.
			if ((!w.bpm || (!w.key && !w.isrc)) && (w.isrc || w.deezerId)) {
				try {
					const dz = await this.sources.deezerTrack({ id: w.deezerId, isrc: w.isrc })
					if (dz) {
						w.deezerId ??= dz.id
						w.isrc ??= dz.isrc ?? undefined
						if (!w.bpm && dz.bpm) w.bpm = { value: dz.bpm, source: 'deezer' }
					}
				} catch (err) {
					fail(w, err)
				}
			}
			onTrack(w)
		}
	}

	/** BPM and key from AcousticBrainz, for the tracks still missing them that have an ISRC, in batches. */
	async #acousticBrainz(works: Work[], signal: AbortSignal) {
		const pending = works.filter((w) => !complete(w) && w.isrc)
		if (!pending.length) return
		try {
			const found = await this.sources.acousticBrainz(
				pending.map((w) => w.isrc!),
				signal
			)
			for (const w of pending) {
				const f = found.get(w.isrc!.toUpperCase())
				if (!w.bpm && f?.bpm) w.bpm = { value: f.bpm, source: 'acousticbrainz' }
				if (!w.key && f?.key) w.key = { value: f.key, source: 'acousticbrainz' }
			}
		} catch (err) {
			signal.throwIfAborted()
			for (const w of pending) w.error ??= errorMessage(err)
		}
	}

	/** Analyze the track's audio for whatever is still missing: its file, or else Deezer's preview. */
	async #analyze(w: Work, signal: AbortSignal) {
		await this.#exclusive(async () => {
			signal.throwIfAborted()
			let input: string | Buffer
			let source: FeatureSource
			try {
				if (w.file) {
					input = w.file
					source = 'analysis'
				} else {
					// The preview URL is signed for a short while: ask for it right before downloading it.
					const dz = await this.sources.deezerTrack({ id: w.deezerId, isrc: w.isrc })
					if (!dz?.previewUrl) return
					input = await this.sources.fetchPreview(dz.previewUrl, signal)
					source = 'preview'
				}
				const pcm = await this.decoder.decodePcm(input, { sampleRate: ANALYSIS_RATE, maxSeconds: MAX_SECONDS, signal })
				if (!w.bpm) {
					const t = await estimateTempo(pcm, ANALYSIS_RATE, signal)
					if (t) w.bpm = { value: t.bpm, source }
				}
				if (!w.key) {
					const k = await estimateKey(pcm, ANALYSIS_RATE, signal)
					if (k) w.key = { value: k.key, source }
				}
			} catch (err) {
				signal.throwIfAborted()
				w.error ??= errorMessage(err)
			}
		})
	}

	/** Runs `fn` after any analysis already running: one at a time. */
	#exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#cpu.then(() => fn())
		this.#cpu = run.catch(() => {})
		return run
	}

	/** What was found for a track, as stored and shown. */
	#result(w: Work): TrackFeatures {
		const found = !!w.bpm || !!w.key
		return {
			bpm: w.bpm?.value ?? null,
			bpmSource: w.bpm?.source ?? null,
			key: w.key?.value ?? null,
			keySource: w.key?.source ?? null,
			status: found ? 'done' : w.error ? 'error' : 'notfound',
			error: found ? null : (w.error ?? null)
		}
	}

	#save(w: Work) {
		const r = this.#result(w)
		this.db
			.prepare(
				`INSERT INTO track_features (track_id, bpm, bpm_source, key_tonic, key_minor, key_source, status, error, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(track_id) DO UPDATE SET bpm = excluded.bpm, bpm_source = excluded.bpm_source,
				   key_tonic = excluded.key_tonic, key_minor = excluded.key_minor, key_source = excluded.key_source,
				   status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`
			)
			.run(
				w.trackId,
				r.bpm,
				r.bpmSource,
				r.key?.tonic ?? null,
				r.key ? (r.key.minor ? 1 : 0) : null,
				r.keySource,
				r.status,
				r.error,
				now()
			)
	}

	/** Write BPM and key into the track's downloaded files, unless that's where they came from or the user turned it off. */
	#writeTags(w: Work) {
		if (!this.settings.get().writeKeyBpmTags) return
		const bpm = w.bpm && w.bpm.source !== 'tags' ? w.bpm.value : null
		const key = w.key && w.key.source !== 'tags' ? keyTag(w.key.value) : null
		if (!bpm && !key) return
		for (const file of this.#files(w.trackId)) {
			try {
				writeKeyBpm(file, { bpm, key })
			} catch (err) {
				console.warn(`[kemix] No se pudieron escribir la clave y el BPM en ${file}: ${errorMessage(err)}`)
			}
		}
	}
}
